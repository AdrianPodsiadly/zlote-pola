// Złote Pola — główny renderer (agent: grafika) → G.render
//
// Kolejność rysowania klatki:
//   1. tło poza mapą,  2. teren z kawałków (G.terrain: grunt + rośliny/drzewa/wieś) i animowana woda,
//   3. podświetlenia z UI na ziemi (najechany kafel, wybrana działka, highlight),  4. G.objects: pierścienie, cienie, bryły posortowane po głębi,
//   5. cząsteczki (G.fx),  6. cienie chmur, oświetlenie pory dnia i pogody (mnożenie), nocne światła (dodawanie),
//   7. opady, mgła, błyskawice,  8. znaczniki UI (ikonki, cele, etykiety) — zawsze jasne, nad nocą,  9. winieta.
//
// API: G.render.init(canvas), G.render.draw(now, dtReal), G.render.resize(), G.render.minimap(ctx, w, h),
//      G.render.minimapPick(mx, my, w, h) → {tx, ty} (do przesuwania kamery z minimapy), G.render.light() → {dark, tint, sun},
//      G.render.stats() → {ms, avg, max, chunks, sprites, fx}.
// UI ustawia G.view = { hover, selParcel, highlight:[idx], place:{type,x,y,rot,valid}|null, selBuilding, selVehicle (uid | [uid]) }.
(function () {
  const C = G.CFG, T = G.T, ISO = G.iso;
  const R = G.render = {};
  G.view = G.view || {};
  for (const [k, v] of Object.entries({ hover: -1, selParcel: -1, highlight: [], place: null, selBuilding: null, selVehicle: null })) if (!(k in G.view)) G.view[k] = v;
  let cv = null, ctx = null, dpr = 1, last = 0;
  const perf = { ms: 0, avg: 0, max: 0, n: 0 };
  let vignette = null, glowCache = {}, flash = 0, clouds = null;

  // ---------- inicjalizacja i rozmiar ----------
  R.init = function (canvas) {
    cv = canvas; ctx = cv.getContext('2d', { alpha: false });
    R.resize();
    window.addEventListener('resize', R.resize);
    window.addEventListener('orientationchange', () => setTimeout(R.resize, 120));
    if (window.ResizeObserver) new ResizeObserver(() => R.resize()).observe(cv);
  };
  R.resize = function () {
    if (!cv) return;
    const nd = Math.min(2, window.devicePixelRatio || 1);
    const r = cv.getBoundingClientRect();
    const w = Math.max(1, r.width), h = Math.max(1, r.height);
    const pw = Math.round(w * nd), ph = Math.round(h * nd);
    if (nd !== dpr && G.sprites) { G.sprites.clear(); if (G.terrain) G.terrain.invalidateAll(); }
    dpr = nd;
    if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; }
    G.cam.vw = w; G.cam.vh = h;
    vignette = null;
    if (ISO.clamp) ISO.clamp();
  };

  // ---------- światło dnia ----------
  // wschód/zachód zależne od miesiąca (lato ~4:30–20:30, zima ~7:30–15:40)
  R.light = function () {
    const d = G.date(), h = d.hour + (G.hourFrac || 0);
    const f = Math.cos(((d.month + (d.dom != null ? (d.dom - 1) / C.DAYS_PER_MONTH : 0.5)) - 5.7) / 12 * Math.PI * 2);
    const rise = 6 - 1.6 * f, set = 18 + 2.4 * f;
    const sm = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
    const day = sm(rise - 0.8, rise + 0.9, h) * (1 - sm(set - 0.9, set + 0.8, h));
    const dark = 1 - day;
    const tw = Math.max(Math.exp(-Math.pow(h - rise, 2) / 0.9), Math.exp(-Math.pow(h - set, 2) / 0.9));
    // kolor oświetlenia: dzień biały, zmierzch ciepły, noc chłodna granatowa
    let tint = [255, 255, 255];
    const night = [62, 78, 128];
    tint = tint.map((c, k) => c + (night[k] - c) * dark);
    const warm = [255, 168, 112];
    const wk = tw * 0.42 * (1 - dark * 0.6);
    tint = tint.map((c, k) => c + (warm[k] - c) * wk);
    // pogoda
    const wt = G.weather ? G.weather.type : 'clear', it = G.weather ? (G.weather.intensity || 0) : 0;
    const wtint = { clear: [255, 255, 255], cloudy: [222, 226, 234], rain: [186, 194, 210], storm: [150, 158, 178], snow: [226, 232, 244], fog: [232, 234, 238] }[wt] || [255, 255, 255];
    const wf = wt === 'clear' ? 0 : 0.6 + 0.4 * it;
    tint = tint.map((c, k) => c * (1 - wf + wf * wtint[k] / 255));
    const shadow = (wt === 'clear' ? 0.3 : wt === 'cloudy' || wt === 'fog' ? 0.12 : 0.08) * (1 - dark * 0.85);
    return { dark, tint, sun: day, twilight: tw, shadow, wt };
  };

  // ---------- podświetlenia na ziemi (w układzie świata) ----------
  function worldTransform() { const c = G.cam; ctx.setTransform(dpr * c.zoom, 0, 0, dpr * c.zoom, -c.x * c.zoom * dpr, -c.y * c.zoom * dpr); }
  function tilePath(x, y) {
    const p = ISO.toWorld(x, y);
    ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + 32, p.y + 16); ctx.lineTo(p.x, p.y + 32); ctx.lineTo(p.x - 32, p.y + 16); ctx.closePath();
  }
  // obrys działki: krawędzie kafli, które graniczą z inną działką (buforowane per działka)
  const edgeCache = new Map();
  function parcelEdges(pid) {
    const p = G.S.parcels[pid];
    if (!p) return null;
    const key = pid + ':' + p.tiles.length;
    let e = edgeCache.get(key);
    if (e) return e;
    const W = C.W, segs = [];
    for (const i of p.tiles) {
      const x = i % W, y = (i / W) | 0;
      const nb = [[x, y - 1, [x, y], [x + 1, y]], [x + 1, y, [x + 1, y], [x + 1, y + 1]], [x, y + 1, [x + 1, y + 1], [x, y + 1]], [x - 1, y, [x, y + 1], [x, y]]];
      for (const n of nb) {
        const ni = G.inMap(n[0], n[1]) ? n[1] * W + n[0] : -1;
        if (ni >= 0 && G.S.map.parcel[ni] === pid) continue;
        const a = ISO.toWorld(n[2][0], n[2][1]), b = ISO.toWorld(n[3][0], n[3][1]);
        segs.push([a.x, a.y, b.x, b.y]);
      }
    }
    e = { segs, tiles: p.tiles };
    if (edgeCache.size > 50) edgeCache.clear();
    edgeCache.set(key, e);
    return e;
  }
  function drawGroundUI(now) {
    const v = G.view, z = G.cam.zoom, t = now / 1000;
    worldTransform();
    // wybrana działka
    if (v.selParcel != null && v.selParcel >= 0) {
      const e = parcelEdges(v.selParcel);
      if (e) {
        ctx.beginPath(); for (const i of e.tiles) tilePath(i % C.W, (i / C.W) | 0);
        ctx.fillStyle = 'rgba(255,240,180,' + (0.13 + 0.05 * Math.sin(t * 3)) + ')'; ctx.fill();
        ctx.beginPath(); for (const s of e.segs) { ctx.moveTo(s[0], s[1]); ctx.lineTo(s[2], s[3]); }
        ctx.lineCap = 'round';
        ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 5 / Math.max(0.5, z); ctx.stroke();
        ctx.strokeStyle = '#ffe07a'; ctx.lineWidth = 2.6 / Math.max(0.5, z); ctx.stroke();
      }
    }
    // podświetlone kafle (np. zasięg, trasa)
    if (v.highlight && v.highlight.length) {
      ctx.beginPath(); for (const i of v.highlight) if (i >= 0) tilePath(i % C.W, (i / C.W) | 0);
      ctx.fillStyle = 'rgba(120,200,255,0.28)'; ctx.fill();
      ctx.strokeStyle = 'rgba(180,230,255,0.7)'; ctx.lineWidth = 1 / Math.max(0.5, z); ctx.stroke();
    }
    // najechany kafel
    if (v.hover != null && v.hover >= 0 && !v.place) {
      ctx.beginPath(); tilePath(v.hover % C.W, (v.hover / C.W) | 0);
      ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 1.6 / Math.max(0.5, z); ctx.stroke();
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ---------- cienie chmur ----------
  let cloudCanvas = null;
  function cloudSprite() {
    if (cloudCanvas) return cloudCanvas;
    const c = document.createElement('canvas'); c.width = 256; c.height = 128;
    const g = c.getContext('2d');
    for (let k = 0; k < 7; k++) {
      const x = 50 + Math.random() * 156, y = 40 + Math.random() * 48, r = 30 + Math.random() * 30;
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, 'rgba(0,0,0,0.5)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr; g.fillRect(0, 0, 256, 128);
    }
    cloudCanvas = c;
    return c;
  }
  function drawClouds(now, L) {
    const wt = L.wt;
    const n = wt === 'clear' ? 3 : wt === 'cloudy' ? 7 : wt === 'rain' || wt === 'storm' ? 6 : 0;
    if (!n || L.dark > 0.7) return;
    if (!clouds) { clouds = []; for (let k = 0; k < 10; k++) clouds.push({ x: Math.random(), y: Math.random(), s: 2.5 + Math.random() * 3 }); }
    const c = G.cam, z = c.zoom, sp = cloudSprite();
    const wind = G.weather ? (G.weather.wind || 2) : 2;
    const mw = (C.W + C.H) * 32, mh = (C.W + C.H) * 16;
    ctx.globalAlpha = (wt === 'clear' ? 0.22 : 0.3) * (1 - L.dark);
    for (let k = 0; k < n; k++) {
      const cl = clouds[k];
      const X = ((cl.x * mw + now / 1000 * wind * 6) % (mw + 1200)) - 600, Y = cl.y * mh;
      const sx = (X - c.x) * z, sy = (Y - c.y) * z, w = 256 * cl.s * z, h = 128 * cl.s * z;
      if (sx > c.vw || sy > c.vh || sx + w < 0 || sy + h < 0) continue;
      ctx.drawImage(sp, sx, sy, w, h);
    }
    ctx.globalAlpha = 1;
  }

  // ---------- poświata świateł ----------
  function glow(color) {
    if (glowCache[color]) return glowCache[color];
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d'), rgb = G.sprites.rgb(color);
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(' + rgb + ',1)'); gr.addColorStop(0.18, 'rgba(' + rgb + ',0.7)'); gr.addColorStop(0.5, 'rgba(' + rgb + ',0.18)'); gr.addColorStop(1, 'rgba(' + rgb + ',0)');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    glowCache[color] = c;
    return c;
  }
  function drawLights(L) {
    const k = Math.min(1, Math.max(0, (L.dark - 0.12) / 0.6));
    if (k <= 0) return;
    const z = G.cam.zoom;
    ctx.globalCompositeOperation = 'lighter';
    const list = [];
    if (G.objects) for (const l of G.objects.lights()) list.push(l);
    if (G.terrain && G.terrain.lights) {
      const c = G.cam;
      for (const l of G.terrain.lights()) list.push({ x: (l.x - c.x) * z, y: (l.y - c.y) * z, r: l.r, c: l.c });
    }
    for (const l of list) {
      if (l.beam) {
        const p = l.beam, g = ctx.createLinearGradient((p[0].x + p[3].x) / 2, (p[0].y + p[3].y) / 2, (p[1].x + p[2].x) / 2, (p[1].y + p[2].y) / 2);
        g.addColorStop(0, 'rgba(255,240,190,' + 0.42 * k + ')'); g.addColorStop(1, 'rgba(255,240,190,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(p[0].x, p[0].y); for (let i = 1; i < 4; i++) ctx.lineTo(p[i].x, p[i].y); ctx.closePath(); ctx.fill();
        continue;
      }
      if (l.x < -60 || l.y < -60 || l.x > G.cam.vw + 60 || l.y > G.cam.vh + 60) continue;
      const r = (l.r || 2) * 7 * Math.max(0.6, z);
      ctx.globalAlpha = 0.75 * k;
      ctx.drawImage(glow(l.c || '#ffd27a'), l.x - r, l.y - r, r * 2, r * 2);
      if (!l.ground) { ctx.globalAlpha = 0.9 * k; const r2 = Math.max(1.2, 1.3 * z); ctx.fillStyle = '#fff4cc'; ctx.fillRect(l.x - r2 / 2, l.y - r2 / 2, r2, r2); }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  // ---------- winieta ----------
  function drawVignette() {
    const c = G.cam;
    if (!vignette) {
      vignette = document.createElement('canvas');
      vignette.width = 256; vignette.height = 256;
      const g = vignette.getContext('2d');
      const gr = g.createRadialGradient(128, 128, 70, 128, 128, 182);
      gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(10,14,8,0.42)');
      g.fillStyle = gr; g.fillRect(0, 0, 256, 256);
    }
    ctx.drawImage(vignette, 0, 0, c.vw, c.vh);
  }

  // ---------- główne rysowanie ----------
  R.draw = function (now, dtReal) {
    if (!ctx || !G.S) return;
    const t0 = performance.now();
    if (now == null) now = t0;
    const dt = dtReal != null ? dtReal : Math.min(0.1, (now - last) / 1000 || 0);
    last = now;
    const c = G.cam;
    if (cv.width !== Math.round(c.vw * dpr) || cv.height !== Math.round(c.vh * dpr)) R.resize();
    const L = R.light();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    // 1. tło
    ctx.fillStyle = '#26361f'; ctx.fillRect(0, 0, c.vw, c.vh);
    // 2. teren
    if (G.terrain) { G.terrain.draw(ctx, c.zoom); G.terrain.drawDynamic(ctx, now); }
    // 3. podświetlenia UI na ziemi
    drawGroundUI(now);
    // 4. obiekty
    if (G.objects) {
      G.objects.update(now, dt);
      G.objects.drawGround(ctx, now, L.shadow);
      G.objects.draw(ctx, now);
    }
    // 5. cząsteczki
    if (G.fx) { G.fx.update(dt); G.fx.ambient(dt, L.dark > 0.5); G.fx.draw(ctx); }
    // 6. chmury, oświetlenie, nocne światła
    drawClouds(now, L);
    const tt = L.tint;
    if (tt[0] < 252 || tt[1] < 252 || tt[2] < 252) {
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillStyle = 'rgb(' + Math.round(tt[0]) + ',' + Math.round(tt[1]) + ',' + Math.round(tt[2]) + ')';
      ctx.fillRect(0, 0, c.vw, c.vh);
      ctx.globalCompositeOperation = 'source-over';
    }
    // poranna/wieczorna poświata (lekko złote powietrze)
    if (L.twilight > 0.15 && L.dark < 0.85) { ctx.globalCompositeOperation = 'soft-light'; ctx.fillStyle = 'rgba(255,170,90,' + (0.25 * L.twilight) + ')'; ctx.fillRect(0, 0, c.vw, c.vh); ctx.globalCompositeOperation = 'source-over'; }
    drawLights(L);
    // 7. opady, mgła, błyskawice
    if (G.fx) G.fx.precip(ctx, dt, L);
    if (L.wt === 'storm') {
      if (flash <= 0 && Math.random() < dt * 0.12) flash = 0.35;
      if (flash > 0) { ctx.fillStyle = 'rgba(235,240,255,' + Math.min(0.55, flash * (Math.random() < 0.5 ? 1.6 : 0.6)) + ')'; ctx.fillRect(0, 0, c.vw, c.vh); flash -= dt; }
    } else flash = 0;
    // 8. znaczniki UI
    if (G.objects) G.objects.drawMarkers(ctx, now);
    // 9. winieta
    drawVignette();
    const ms = performance.now() - t0;
    perf.ms = ms; perf.n++; perf.avg = perf.avg * 0.95 + ms * 0.05; perf.max = Math.max(perf.max * 0.995, ms);
  };
  R.stats = () => ({ ms: +perf.ms.toFixed(2), avg: +perf.avg.toFixed(2), max: +perf.max.toFixed(2), chunks: G.terrain ? G.terrain.stats() : null, sprites: G.sprites ? G.sprites.stats() : null, fx: G.fx ? G.fx.count() : 0, dpr });

  // ---------- minimapa ----------
  let mmCanvas = null, mmAt = 0;
  function minimapBase() {
    const now = performance.now();
    if (mmCanvas && now - mmAt < 2500) return mmCanvas;
    mmAt = now;
    if (!mmCanvas) { mmCanvas = document.createElement('canvas'); mmCanvas.width = C.W; mmCanvas.height = C.H; }
    const g = mmCanvas.getContext('2d'), img = g.createImageData(C.W, C.H), d = img.data, S = G.S;
    for (let i = 0; i < C.W * C.H; i++) {
      let col = G.terrain ? G.terrain.tileColor(i) : '#7a9a5a';
      const rgb = G.sprites.rgb(col);
      const pid = S.map.parcel[i];
      let k = 1;
      if (pid >= 0 && S.parcels[pid].owner === 'player') { rgb[0] = rgb[0] * 0.7 + 255 * 0.3; rgb[1] = rgb[1] * 0.7 + 215 * 0.3; rgb[2] = rgb[2] * 0.7; }
      if (S.map.t[i] === T.FOREST) k = 0.85;
      d[i * 4] = rgb[0] * k; d[i * 4 + 1] = rgb[1] * k; d[i * 4 + 2] = rgb[2] * k; d[i * 4 + 3] = 255;
    }
    if (G.buildings && S.buildings) for (const b of S.buildings) {
      const f = G.buildings.footprint(b);
      for (let y = f.y; y < f.y + f.h; y++) for (let x = f.x; x < f.x + f.w; x++) { const j = (y * C.W + x) * 4; d[j] = 180; d[j + 1] = 70; d[j + 2] = 50; }
    }
    g.putImageData(img, 0, 0);
    return mmCanvas;
  }
  function mmScale(w, h) {
    const mw = (C.W + C.H) * 32, mh = (C.W + C.H) * 16;
    const s = Math.min(w / mw, h / mh) * 0.98;
    return { s, ox: (w - mw * s) / 2 + C.H * 32 * s, oy: (h - mh * s) / 2 };
  }
  R.minimap = function (mctx, w, h) {
    if (!G.S || !mctx) return;
    const base = minimapBase(), m = mmScale(w, h), s = m.s;
    mctx.save();
    mctx.clearRect(0, 0, w, h);
    mctx.imageSmoothingEnabled = false;
    // kafel (tx, ty) → (ox + (tx − ty)·32s, oy + (tx + ty)·16s)
    mctx.transform(32 * s, 16 * s, -32 * s, 16 * s, m.ox, m.oy);
    mctx.drawImage(base, 0, 0);
    mctx.restore();
    const toMM = (tx, ty) => [m.ox + (tx - ty) * 32 * s, m.oy + (tx + ty) * 16 * s];
    // pojazdy
    if (G.jobs && G.jobs.vehicles) {
      let vs = [];
      try { vs = G.jobs.vehicles(); } catch (e) { /* brak */ }
      for (const v of vs) {
        if (!v || v.inGarage || v.x == null) continue;
        const p = toMM(v.x, v.y);
        mctx.fillStyle = v.kind === 'own' ? '#ffd65a' : v.kind === 'contractor' || v.kind === 'transport' ? '#6ad0ff' : '#f2efe6';
        mctx.beginPath(); mctx.arc(p[0], p[1], Math.max(1.5, w / 110), 0, 7); mctx.fill();
      }
    }
    // widok kamery
    const c = G.cam, pts = [[0, 0], [c.vw, 0], [c.vw, c.vh], [0, c.vh]].map(q => { const t = ISO.screenToTileF(q[0], q[1]); return toMM(t.tx, t.ty); });
    mctx.strokeStyle = 'rgba(255,255,255,0.95)'; mctx.lineWidth = 1.5;
    mctx.beginPath(); pts.forEach((p, i) => i ? mctx.lineTo(p[0], p[1]) : mctx.moveTo(p[0], p[1])); mctx.closePath(); mctx.stroke();
  };
  // punkt minimapy → kafel (ułamkowy); UI: G.iso.centerOn(r.tx, r.ty)
  R.minimapPick = function (mx, my, w, h) {
    const m = mmScale(w, h), a = (mx - m.ox) / (32 * m.s), b = (my - m.oy) / (16 * m.s);
    return { tx: Math.max(0, Math.min(C.W, (a + b) / 2)), ty: Math.max(0, Math.min(C.H, (b - a) / 2)) };
  };
  G.on('newGame', () => { edgeCache.clear(); mmAt = 0; });
  G.on('load', () => { edgeCache.clear(); mmAt = 0; });
  G.on('mapChanged', () => { edgeCache.clear(); mmAt = 0; });
})();
