// Złote Pola — teren izometryczny (agent: grafika) → G.terrain
//
// Teren rysowany jest w kawałkach CH×CH kafli na offscreen canvasach, osobno dla każdego poziomu zoomu (G.sprites.LEVELS).
// Każdy kawałek ma dwie warstwy: grunt (romby) i dekoracje (rośliny, drzewa, domy, miedze) — dzięki temu rośliny wystające
// ponad kafel nie są przycinane przez grunt sąsiedniego kawałka. Kawałek odświeża się tylko, gdy zmieni się skrót stanu jego kafli
// (uprawy, fazy, własność) albo globalny wygląd (miesiąc, śnieg). Zdarzenia: 'mapChanged'(idx), 'parcelChanged'(p|id), 'landBought', 'landSold'.
//
// API: G.terrain.draw(ctx, zoom) — rysuje widoczne kawałki; G.terrain.drawDynamic(ctx, now) — woda, kwiaty na wietrze;
//      G.terrain.lights(range) → [{x, y, r, c}] (okna we wsi, nocą); G.terrain.invalidateAll(); G.terrain.invalidateTile(i);
//      G.terrain.tileColor(i) → kolor do minimapy; G.terrain.look() → { month, snow (0..3), frozen, key }; G.terrain.stats().
(function () {
  const C = G.CFG, T = G.T, W = C.W, H = C.H, ISO = G.iso, SP = G.sprites;
  const TR = G.terrain = {};
  const CH = 8;                               // kafli na kawałek
  const PAD_TOP = 96;                         // px świata zapasu nad kawałkiem (drzewa, kukurydza, domy)
  const PAD_SIDE = 40;
  const CW = CH * ISO.TW, CHH = CH * ISO.TH;  // rozmiar rombu kawałka w px świata (zoom 1)
  const chunks = new Map();                   // klucz level:cx:cy → { g, d, scale, X0, Y0, hash, look, lights:[], last }
  let totalPx = 0;
  const MAX_PX = 44e6;
  let lookKey = '', lookInfo = null, waterTiles = null, fieldDir = null, hashAt = 0;
  const shade = SP.shade, mix = SP.mix;

  // ---------- losowość deterministyczna per kafel ----------
  function hsh(i, k) { let h = (i * 374761393 + k * 668265263) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }

  // ---------- wygląd zależny od pory roku ----------
  const GRASS_M = ['#8a9a76', '#8c9d74', '#84a35c', '#79b352', '#6fb14a', '#70ad48', '#7dab4b', '#90a950', '#8ea455', '#999a52', '#8f9062', '#88947a'];
  const SNOW = '#eef1f5';
  TR.look = function () {
    const d = G.date(), snowCm = (G.weather && G.weather.snow) || 0;
    const snow = snowCm <= 0.05 ? 0 : snowCm < 2 ? 1 : snowCm < 8 ? 2 : 3;
    const frozen = !!(G.weather && G.weather.frozen);
    const key = d.month + '|' + snow + '|' + (frozen ? 1 : 0);
    if (key !== lookKey) {
      lookKey = key;
      const sf = [0, 0.55, 0.85, 1][snow];
      lookInfo = {
        month: d.month, snow, frozen, key, sf,
        grass: mix(GRASS_M[d.month], SNOW, sf), grassDark: mix(shade(GRASS_M[d.month], 0.85), SNOW, sf * 0.9),
        meadow: mix(shade(GRASS_M[d.month], 1.06), SNOW, sf),
        autumn: d.month >= 8 && d.month <= 10, winterTrees: d.month === 11 || d.month <= 1 || (d.month === 2 && snow > 0),
        flowers: d.month >= 4 && d.month <= 6 && snow === 0
      };
    }
    return lookInfo;
  };

  // kierunek rzędów działki (wzdłuż dłuższego boku)
  function dirOf(pid) {
    if (!fieldDir) fieldDir = {};
    if (fieldDir[pid] == null) { const p = G.S.parcels[pid]; fieldDir[pid] = p && (p.box.y1 - p.box.y0) > (p.box.x1 - p.box.x0) ? 'y' : 'x'; }
    return fieldDir[pid];
  }
  // kolor gleby wg klasy bonitacyjnej
  function soilColor(i) { const s = G.S.map.soil[i]; return s <= 2 ? '#5b4532' : s <= 4 ? '#775839' : '#977a55'; }

  // ---------- geometria ----------
  // wierzchołki rombu kafla: góra (X, Y), prawo (X+32, Y+16), dół (X, Y+32), lewo (X−32, Y+16)
  function diamond(ctx, X, Y, inset) {
    inset = inset || 0;
    ctx.beginPath();
    ctx.moveTo(X, Y + inset); ctx.lineTo(X + 32 - inset * 2, Y + 16); ctx.lineTo(X, Y + 32 - inset); ctx.lineTo(X - 32 + inset * 2, Y + 16); ctx.closePath();
  }
  // punkt w kaflu: u wzdłuż +x (0..1), v wzdłuż +y (0..1) → px świata
  function pt(X, Y, u, v) { return [X + (u - v) * 32, Y + (u + v) * 16]; }

  // ---------- rysowanie gruntu kafla ----------
  function groundTile(ctx, i, X, Y, lk) {
    const S = G.S, tt = S.map.t[i], v = S.map.v[i], pid = S.map.parcel[i];
    let base;
    switch (tt) {
      case T.GRASS: base = shade(lk.grass, 0.96 + (v & 7) * 0.012); break;
      case T.MEADOW: base = shade(lk.meadow, 0.96 + (v & 7) * 0.012); break;
      case T.FOREST: base = mix(shade('#4a7a36', 0.9 + (v & 3) * 0.03), SNOW, lk.sf * 0.8); break;
      case T.WATER: base = lk.frozen ? '#c9d9e4' : '#3d7fbf'; break;
      case T.ROAD: base = mix(shade('#b39a6e', 0.95 + (v & 3) * 0.03), SNOW, lk.sf * 0.8); break;
      case T.ASPHALT: base = mix('#50545a', SNOW, lk.sf * 0.5); break;
      case T.YARD: base = mix(shade('#a09a8e', 0.96 + (v & 3) * 0.02), SNOW, lk.sf * 0.85); break;
      case T.VILLAGE: base = mix(shade('#8fae5e', 0.95 + (v & 3) * 0.03), SNOW, lk.sf); break;
      case T.FIELD: base = mix(soilColor(i), SNOW, lk.sf); break;
      default: base = '#f0f';
    }
    const ts = (tt === T.FIELD || tt === T.MEADOW) && pid >= 0 && G.fields && G.fields.tileState ? G.fields.tileState(i) : null;
    if (ts) base = fieldGround(ctx, i, X, Y, ts, lk, base);
    diamond(ctx, X, Y);
    ctx.fillStyle = base; ctx.fill();
    // tekstura
    switch (tt) {
      case T.GRASS: case T.VILLAGE: grassTexture(ctx, i, X, Y, lk, 5); break;
      case T.MEADOW: if (!ts) grassTexture(ctx, i, X, Y, lk, 7); break;
      case T.FIELD: break;
      case T.ROAD: road(ctx, i, X, Y, lk); break;
      case T.ASPHALT: asphalt(ctx, i, X, Y, lk); break;
      case T.WATER: water(ctx, i, X, Y, lk); break;
      case T.YARD: yard(ctx, i, X, Y, lk); break;
      case T.FOREST: if (lk.sf < 0.5) { ctx.fillStyle = 'rgba(30,50,20,0.18)'; for (let k = 0; k < 4; k++) { const p = pt(X, Y, hsh(i, k) * 0.8 + 0.1, hsh(i, k + 9) * 0.8 + 0.1); ctx.beginPath(); ctx.ellipse(p[0], p[1], 5, 2.5, 0, 0, 7); ctx.fill(); } } break;
    }
    if (ts) fieldTexture(ctx, i, X, Y, ts, lk, pid);
  }
  function grassTexture(ctx, i, X, Y, lk, n) {
    if (lk.sf > 0.6) return;
    ctx.strokeStyle = shade(lk.grassDark, 0.92); ctx.lineWidth = 1; ctx.beginPath();
    for (let k = 0; k < n; k++) { const p = pt(X, Y, 0.1 + hsh(i, k) * 0.8, 0.1 + hsh(i, k + 31) * 0.8); ctx.moveTo(p[0], p[1]); ctx.lineTo(p[0] + (hsh(i, k + 7) - 0.5) * 2, p[1] - 2 - hsh(i, k + 3) * 2); }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,220,0.25)'; ctx.beginPath();
    for (let k = 0; k < 3; k++) { const p = pt(X, Y, 0.1 + hsh(i, k + 50) * 0.8, 0.1 + hsh(i, k + 61) * 0.8); ctx.moveTo(p[0], p[1]); ctx.lineTo(p[0] + 0.5, p[1] - 2.5); }
    ctx.stroke();
  }
  const isRoad = i => { const t = G.S.map.t[i]; return t === T.ROAD || t === T.ASPHALT; };
  function roadDirs(i) {
    const x = i % W, y = (i / W) | 0;
    const hx = (x > 0 && isRoad(i - 1)) || (x < W - 1 && isRoad(i + 1));
    const hy = (y > 0 && isRoad(i - W)) || (y < H - 1 && isRoad(i + W));
    const yard = G.S.map.t[i] === T.YARD;
    return { hx: hx || (!hy && !yard), hy };
  }
  // linia wzdłuż kierunku: dir 'x' → od (0,f) do (1,f); 'y' → od (f,0) do (f,1)
  function along(ctx, X, Y, dir, f, t0, t1) {
    const a = dir === 'x' ? pt(X, Y, t0, f) : pt(X, Y, f, t0), b = dir === 'x' ? pt(X, Y, t1, f) : pt(X, Y, f, t1);
    ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
  }
  function road(ctx, i, X, Y, lk) {
    const d = roadDirs(i);
    ctx.save(); diamond(ctx, X, Y); ctx.clip();
    // pobocze trawiaste
    ctx.strokeStyle = mix('#7f9a4a', SNOW, lk.sf); ctx.lineWidth = 5; ctx.beginPath();
    if (d.hx && !d.hy) { along(ctx, X, Y, 'x', 0.02, -0.1, 1.1); along(ctx, X, Y, 'x', 0.98, -0.1, 1.1); }
    if (d.hy && !d.hx) { along(ctx, X, Y, 'y', 0.02, -0.1, 1.1); along(ctx, X, Y, 'y', 0.98, -0.1, 1.1); }
    ctx.stroke();
    // koleiny
    ctx.strokeStyle = mix('#8a7250', '#9aa0a8', lk.sf * 0.7); ctx.lineWidth = 3.2; ctx.lineCap = 'round'; ctx.beginPath();
    if (d.hx) { along(ctx, X, Y, 'x', 0.32, -0.1, 1.1); along(ctx, X, Y, 'x', 0.68, -0.1, 1.1); }
    if (d.hy) { along(ctx, X, Y, 'y', 0.32, -0.1, 1.1); along(ctx, X, Y, 'y', 0.68, -0.1, 1.1); }
    ctx.stroke();
    // pas trawy pośrodku
    if (lk.sf < 0.5) { ctx.strokeStyle = 'rgba(110,140,70,0.55)'; ctx.lineWidth = 2; ctx.beginPath(); if (d.hx && !d.hy) along(ctx, X, Y, 'x', 0.5, -0.1, 1.1); if (d.hy && !d.hx) along(ctx, X, Y, 'y', 0.5, -0.1, 1.1); ctx.stroke(); }
    ctx.restore();
  }
  function asphalt(ctx, i, X, Y, lk) {
    const d = roadDirs(i);
    ctx.save(); diamond(ctx, X, Y); ctx.clip();
    ctx.strokeStyle = mix('#8a8f96', SNOW, lk.sf * 0.6); ctx.lineWidth = 1.4; ctx.beginPath();
    if (d.hx && !d.hy) { along(ctx, X, Y, 'x', 0.06, -0.1, 1.1); along(ctx, X, Y, 'x', 0.94, -0.1, 1.1); }
    if (d.hy && !d.hx) { along(ctx, X, Y, 'y', 0.06, -0.1, 1.1); along(ctx, X, Y, 'y', 0.94, -0.1, 1.1); }
    ctx.stroke();
    if (lk.sf < 0.9 && !(d.hx && d.hy)) { ctx.strokeStyle = '#e8e6dc'; ctx.lineWidth = 1.5; ctx.setLineDash([9, 9]); ctx.beginPath(); along(ctx, X, Y, d.hy ? 'y' : 'x', 0.5, 0, 1); ctx.stroke(); ctx.setLineDash([]); }
    if (lk.sf > 0) { ctx.strokeStyle = 'rgba(70,74,80,0.5)'; ctx.lineWidth = 3; ctx.beginPath(); along(ctx, X, Y, d.hy ? 'y' : 'x', 0.3, -0.1, 1.1); along(ctx, X, Y, d.hy ? 'y' : 'x', 0.7, -0.1, 1.1); ctx.stroke(); }
    ctx.restore();
  }
  function water(ctx, i, X, Y, lk) {
    const S = G.S, x = i % W, y = (i / W) | 0;
    ctx.save(); diamond(ctx, X, Y); ctx.clip();
    if (!lk.frozen) {
      const g = ctx.createLinearGradient(X, Y, X, Y + 32); g.addColorStop(0, '#4a8cc8'); g.addColorStop(1, '#2f6ca8');
      ctx.fillStyle = g; ctx.fillRect(X - 32, Y, 64, 32);
    }
    // brzegi: tam, gdzie sąsiad to ląd — ciemniejsza woda przy brzegu i pasek piasku/mułu
    const land = n => G.inMap(n[0], n[1]) && S.map.t[n[1] * W + n[0]] !== T.WATER;
    const edges = [[[x, y - 1], 'y', 0], [[x + 1, y], 'x', 1], [[x, y + 1], 'y', 1], [[x - 1, y], 'x', 0]];
    for (const e of edges) {
      if (!land(e[0])) continue;
      ctx.strokeStyle = lk.frozen ? '#aebfcc' : 'rgba(20,50,90,0.35)'; ctx.lineWidth = 6; ctx.beginPath(); along(ctx, X, Y, e[1], e[2] === 0 ? 0.04 : 0.96, -0.1, 1.1); ctx.stroke();
      ctx.strokeStyle = mix('#c8b48a', SNOW, lk.sf); ctx.lineWidth = 2.6; ctx.beginPath(); along(ctx, X, Y, e[1], e[2] === 0 ? 0.0 : 1.0, -0.1, 1.1); ctx.stroke();
      if (lk.sf === 0) { ctx.strokeStyle = 'rgba(90,130,60,0.9)'; ctx.lineWidth = 1.5; ctx.beginPath(); for (let k = 0; k < 6; k++) { const t = 0.05 + k * 0.17, p = e[1] === 'x' ? pt(X, Y, t, e[2] === 0 ? 0.02 : 0.98) : pt(X, Y, e[2] === 0 ? 0.02 : 0.98, t); ctx.moveTo(p[0], p[1]); ctx.lineTo(p[0] + (hsh(i, k) - 0.5), p[1] - 3 - hsh(i, k + 3) * 2); } ctx.stroke(); }
    }
    if (lk.frozen) { ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 1; ctx.beginPath(); for (let k = 0; k < 3; k++) { const p = pt(X, Y, hsh(i, k) * 0.8 + 0.1, hsh(i, k + 5) * 0.8 + 0.1); ctx.moveTo(p[0] - 5, p[1] + 1); ctx.lineTo(p[0] + 6, p[1] - 2); } ctx.stroke(); }
    ctx.restore();
  }
  function yard(ctx, i, X, Y, lk) {
    // żwir / kostka: drobne kamyki + delikatne krawędzie płyt
    ctx.save(); diamond(ctx, X, Y); ctx.clip();
    if (lk.sf < 0.8) {
      for (let k = 0; k < 10; k++) { const p = pt(X, Y, 0.05 + hsh(i, k) * 0.9, 0.05 + hsh(i, k + 40) * 0.9); ctx.fillStyle = hsh(i, k + 80) < 0.5 ? 'rgba(60,55,50,0.25)' : 'rgba(255,255,255,0.22)'; ctx.fillRect(p[0], p[1], 1.6, 1); }
    }
    ctx.strokeStyle = 'rgba(70,65,60,0.22)'; ctx.lineWidth = 1; diamond(ctx, X, Y); ctx.stroke();
    ctx.restore();
  }

  // ---------- pola: grunt i rośliny ----------
  // kolor gruntu pola wg fazy
  function fieldGround(ctx, i, X, Y, ts, lk, base) {
    const soil = soilColor(i), ph = ts.phase, g = ts.growth || 0;
    let c;
    switch (ph) {
      case 'plowed': c = shade(soil, 0.72); break;
      case 'cultivated': c = shade(soil, 0.95); break;
      case 'sown': c = shade(soil, 1.02); break;
      case 'stubble': c = mix(soil, '#cdb574', 0.6); break;
      case 'harvested': c = mix(soil, '#c9b06a', 0.55); break;
      case 'fallow': c = mix(soil, lk.grass, 0.5); break;
      case 'grass': c = mix(shade(lk.meadow, 0.9), '#8db84f', Math.min(1, g) * 0.3); break;
      case 'mown': c = mix(lk.meadow, '#b9b45e', 0.35); break;
      case 'growing': case 'ripe': {
        const crop = G.CROPS[ts.crop], lookc = crop && crop.look;
        const green = lookc ? lookc.green : '#5f9a3a';
        const cover = ph === 'ripe' ? 1 : Math.min(1, g * 1.7);
        let gc = shade(green, 0.72);
        if (lookc && (ph === 'ripe' || g > 0.7)) gc = mix(gc, shade(lookc.ripe, 0.8), ph === 'ripe' ? 1 : (g - 0.7) / 0.3);
        c = mix(soil, gc, cover * 0.85);
        break;
      }
      default: c = base;
    }
    return mix(c, SNOW, lk.sf * (ph === 'plowed' ? 0.75 : 1));
  }
  // tekstura gruntu: bruzdy, rządki, ściernisko, pokos
  function fieldTexture(ctx, i, X, Y, ts, lk, pid) {
    const dir = dirOf(pid), ph = ts.phase;
    ctx.save(); diamond(ctx, X, Y); ctx.clip();
    ctx.lineCap = 'butt';
    if (ph === 'plowed') {
      const dark = mix(shade(soilColor(i), 0.5), SNOW, lk.sf * 0.4), light = mix(shade(soilColor(i), 1.05), SNOW, lk.sf);
      for (let k = 0; k < 7; k++) {
        const f = (k + 0.5) / 7;
        ctx.strokeStyle = dark; ctx.lineWidth = 2; ctx.beginPath(); along(ctx, X, Y, dir, f, -0.05, 1.05); ctx.stroke();
        ctx.strokeStyle = light; ctx.lineWidth = 1.2; ctx.beginPath(); along(ctx, X, Y, dir, f + 0.05, -0.05, 1.05); ctx.stroke();
      }
    } else if (ph === 'cultivated') {
      ctx.strokeStyle = 'rgba(0,0,0,0.12)'; ctx.lineWidth = 1; ctx.beginPath();
      for (let k = 0; k < 10; k++) along(ctx, X, Y, dir, (k + 0.5) / 10, -0.05, 1.05);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      for (let k = 0; k < 8; k++) { const p = pt(X, Y, hsh(i, k) * 0.9 + 0.05, hsh(i, k + 20) * 0.9 + 0.05); ctx.fillRect(p[0], p[1], 2, 1); }
    } else if (ph === 'sown') {
      ctx.strokeStyle = mix(shade(soilColor(i), 0.78), SNOW, lk.sf * 0.5); ctx.lineWidth = 1.3; ctx.beginPath();
      for (let k = 0; k < 8; k++) along(ctx, X, Y, dir, (k + 0.5) / 8, -0.05, 1.05);
      ctx.stroke();
    } else if (ph === 'stubble' || ph === 'harvested') {
      // ściernisko: krótkie jasne kreski w rzędach
      ctx.strokeStyle = mix('#e8d68a', SNOW, lk.sf); ctx.lineWidth = 1; ctx.beginPath();
      for (let k = 0; k < 6; k++) for (let j = 0; j < 7; j++) { const f = (k + 0.5) / 6, t = (j + 0.5) / 7 + (hsh(i, k * 7 + j) - 0.5) * 0.08, p = dir === 'x' ? pt(X, Y, t, f) : pt(X, Y, f, t); ctx.moveTo(p[0], p[1]); ctx.lineTo(p[0], p[1] - 2.2); }
      ctx.stroke();
      if (ts.straw && lk.sf < 0.6) { // pokosy słomy po kombajnie
        for (const f of [0.3, 0.72]) {
          ctx.strokeStyle = '#c9a44a'; ctx.lineWidth = 5; ctx.beginPath(); along(ctx, X, Y, dir, f, -0.05, 1.05); ctx.stroke();
          ctx.strokeStyle = '#e6c565'; ctx.lineWidth = 2; ctx.beginPath(); along(ctx, X, Y, dir, f - 0.02, -0.05, 1.05); ctx.stroke();
        }
      }
    } else if (ph === 'mown') {
      // skoszona łąka: pokosy (wały) zieleni schnącej
      for (const f of [0.25, 0.62]) {
        ctx.strokeStyle = mix('#9aa64a', SNOW, lk.sf); ctx.lineWidth = 5.5; ctx.beginPath(); along(ctx, X, Y, dir, f, -0.05, 1.05); ctx.stroke();
        ctx.strokeStyle = mix('#c2c866', SNOW, lk.sf); ctx.lineWidth = 2; ctx.beginPath(); along(ctx, X, Y, dir, f - 0.02, -0.05, 1.05); ctx.stroke();
      }
    } else if (ph === 'fallow') {
      grassTexture(ctx, i, X, Y, lk, 4);
      ctx.fillStyle = 'rgba(70,60,40,0.25)';
      for (let k = 0; k < 4; k++) { const p = pt(X, Y, hsh(i, k) * 0.8 + 0.1, hsh(i, k + 20) * 0.8 + 0.1); ctx.beginPath(); ctx.ellipse(p[0], p[1], 6, 3, 0, 0, 7); ctx.fill(); }
    } else if (ph === 'grass') {
      grassTexture(ctx, i, X, Y, lk, 8);
    }
    ctx.restore();
  }
  // rośliny w rzędach (warstwa dekoracji)
  function plants(ctx, i, X, Y, ts, lk, pid) {
    const ph = ts.phase;
    if (ph !== 'growing' && ph !== 'ripe' && ph !== 'grass') { weeds(ctx, i, X, Y, ts, lk); return; }
    const crop = G.CROPS[ts.crop], lookc = crop && crop.look;
    if (!lookc) return;
    const dir = dirOf(pid), g = ph === 'ripe' ? 1 : Math.min(1, ts.growth || 0);
    const style = lookc.style, ripe = ph === 'ripe' ? 1 : Math.max(0, (g - 0.68) / 0.32);
    let colr = mix(lookc.green, lookc.ripe, ripe);
    if (lk.sf > 0) colr = mix(colr, SNOW, lk.sf * 0.6);
    const hmax = (lookc.height || 1) * 13;                 // px wysokości przy pełnym wzroście
    if (style === 'grass') { meadowPlants(ctx, i, X, Y, ts, lk, lookc); return; }
    if (g < 0.04) return;
    const dark = shade(colr, 0.78), light = shade(colr, 1.15);
    let rows, per;
    switch (style) { case 'maize': rows = 4; per = 5; break; case 'rapeseed': rows = 4; per = 5; break; case 'root': rows = 4; per = 5; break; case 'beet': rows = 4; per = 5; break; case 'sunflower': rows = 4; per = 4; break; default: rows = 6; per = 8; }
    const h = Math.max(1.5, hmax * (style === 'grain' ? Math.min(1, g * 1.15) : g));
    for (let r = 0; r < rows; r++) {
      const f = (r + 0.5) / rows;
      ctx.beginPath();
      let flowers = null;
      for (let k = 0; k < per; k++) {
        const t = (k + 0.5) / per + (hsh(i, r * 13 + k) - 0.5) * 0.06, p = dir === 'x' ? pt(X, Y, t, f) : pt(X, Y, f, t);
        const jh = h * (0.85 + hsh(i, r * 7 + k + 100) * 0.3);
        switch (style) {
          case 'grain':
            ctx.moveTo(p[0], p[1]); ctx.lineTo(p[0] + (hsh(i, k + r) - 0.5) * 1.5, p[1] - jh);
            break;
          case 'maize':
            ctx.moveTo(p[0], p[1]); ctx.lineTo(p[0], p[1] - jh);
            if (g > 0.3) { ctx.moveTo(p[0], p[1] - jh * 0.45); ctx.lineTo(p[0] - 3.5, p[1] - jh * 0.6); ctx.moveTo(p[0], p[1] - jh * 0.65); ctx.lineTo(p[0] + 3.5, p[1] - jh * 0.82); }
            break;
          case 'rapeseed': case 'root': case 'beet': {
            const rr = Math.max(1.2, (style === 'beet' ? 3.6 : style === 'root' ? 3.2 : 2.8) * g);
            ctx.moveTo(p[0] + rr, p[1]); ctx.arc(p[0], p[1] - (style === 'rapeseed' ? jh * 0.5 : jh * 0.25), rr, 0, 7);
            if (style === 'rapeseed' && g > 0.1) { ctx.moveTo(p[0], p[1]); ctx.lineTo(p[0], p[1] - jh * 0.6); }
            if (lookc.flower && ((style === 'rapeseed' && g > 0.42 && g < 0.72) || (style === 'root' && g > 0.45 && g < 0.6))) (flowers = flowers || []).push([p[0], p[1] - (style === 'rapeseed' ? jh * 0.9 : jh * 0.5)]);
            break;
          }
          case 'sunflower':
            ctx.moveTo(p[0], p[1]); ctx.lineTo(p[0], p[1] - jh);
            if (g > 0.55) (flowers = flowers || []).push([p[0], p[1] - jh, ripe]);
            break;
        }
      }
      if (style === 'grain' || style === 'maize' || style === 'sunflower') { ctx.strokeStyle = r % 2 ? dark : colr; ctx.lineWidth = style === 'grain' ? 1.1 : 1.6; ctx.stroke(); }
      else { ctx.fillStyle = r % 2 ? dark : colr; ctx.fill(); if (style === 'rapeseed') { ctx.strokeStyle = dark; ctx.lineWidth = 0.8; ctx.stroke(); } }
      // kłosy / wiechy
      if (style === 'grain' && g > 0.6) {
        ctx.fillStyle = ripe > 0.3 ? mix(light, '#f0d070', 0.5) : light;
        for (let k = 0; k < per; k++) { const t = (k + 0.5) / per + (hsh(i, r * 13 + k) - 0.5) * 0.06, p = dir === 'x' ? pt(X, Y, t, f) : pt(X, Y, f, t); const jh = h * (0.85 + hsh(i, r * 7 + k + 100) * 0.3); ctx.fillRect(p[0] - 0.8 + (hsh(i, k + r) - 0.5) * 1.5, p[1] - jh - 1.5, 1.6, 2.5); }
      }
      if (style === 'maize' && g > 0.55) { ctx.fillStyle = mix('#d9c37a', light, 0.4); for (let k = 0; k < per; k++) { const t = (k + 0.5) / per + (hsh(i, r * 13 + k) - 0.5) * 0.06, p = dir === 'x' ? pt(X, Y, t, f) : pt(X, Y, f, t); const jh = h * (0.85 + hsh(i, r * 7 + k + 100) * 0.3); ctx.fillRect(p[0] - 1, p[1] - jh - 2, 2, 3); } }
      if (flowers) {
        if (style === 'sunflower') { for (const q of flowers) { ctx.fillStyle = q[2] > 0.5 ? '#8a6a2a' : '#f2c82a'; ctx.beginPath(); ctx.arc(q[0], q[1], 2.6, 0, 7); ctx.fill(); ctx.fillStyle = '#5a3a1a'; ctx.beginPath(); ctx.arc(q[0], q[1], 1.2, 0, 7); ctx.fill(); } }
        else { ctx.fillStyle = style === 'root' ? '#f4f0ff' : lookc.flower; for (const q of flowers) { ctx.beginPath(); ctx.arc(q[0], q[1], style === 'root' ? 1.1 : 2.2, 0, 7); ctx.fill(); } }
      }
    }
    weeds(ctx, i, X, Y, ts, lk);
  }
  function weeds(ctx, i, X, Y, ts, lk) {
    if (!(ts.weeds > 0.15) || lk.sf > 0.3) return;
    const n = Math.min(10, Math.round(ts.weeds * 12));
    ctx.fillStyle = 'rgba(80,140,50,0.8)';
    for (let k = 0; k < n; k++) { const p = pt(X, Y, 0.08 + hsh(i, k + 200) * 0.84, 0.08 + hsh(i, k + 300) * 0.84); ctx.beginPath(); ctx.ellipse(p[0], p[1] - 1, 2.2, 1.6, 0, 0, 7); ctx.fill(); }
  }
  function meadowPlants(ctx, i, X, Y, ts, lk, lookc) {
    if (lk.sf > 0.6) return;
    const g = Math.min(1.2, ts.growth || 0), h = 2 + 5 * Math.min(1, g);
    ctx.strokeStyle = shade(lookc.green, 0.8); ctx.lineWidth = 1; ctx.beginPath();
    for (let k = 0; k < 14; k++) { const p = pt(X, Y, 0.06 + hsh(i, k) * 0.88, 0.06 + hsh(i, k + 31) * 0.88); ctx.moveTo(p[0], p[1]); ctx.lineTo(p[0] + (hsh(i, k + 7) - 0.5) * 2, p[1] - h * (0.7 + hsh(i, k + 3) * 0.6)); }
    ctx.stroke();
    if (lk.flowers && g > 0.5 && lookc.flower) {
      const cols = [lookc.flower, '#ffffff', '#e9a0c0', '#f2d43a'];
      for (let k = 0; k < 6; k++) { if (hsh(i, k + 500) > 0.6) continue; const p = pt(X, Y, 0.1 + hsh(i, k + 400) * 0.8, 0.1 + hsh(i, k + 450) * 0.8); ctx.fillStyle = cols[(k + (i & 3)) % cols.length]; ctx.beginPath(); ctx.arc(p[0], p[1] - h * 0.8, 1.3, 0, 7); ctx.fill(); }
    }
  }
  // kwiaty i kępy na zwykłej trawie / łące bez działki
  function grassDeco(ctx, i, X, Y, lk) {
    if (lk.sf > 0.3) return;
    if (lk.flowers && hsh(i, 777) < 0.25) {
      const cols = ['#ffffff', '#f2d43a', '#e9a0c0'];
      for (let k = 0; k < 4; k++) { const p = pt(X, Y, 0.1 + hsh(i, k + 400) * 0.8, 0.1 + hsh(i, k + 450) * 0.8); ctx.fillStyle = cols[k % 3]; ctx.beginPath(); ctx.arc(p[0], p[1] - 1.5, 1.2, 0, 7); ctx.fill(); }
    }
    if (hsh(i, 778) < 0.08) bush(ctx, pt(X, Y, 0.3 + hsh(i, 779) * 0.4, 0.3 + hsh(i, 780) * 0.4), 5 + hsh(i, 781) * 3, lk);
  }
  function bush(ctx, p, r, lk) {
    ctx.fillStyle = 'rgba(0,0,0,0.18)'; ctx.beginPath(); ctx.ellipse(p[0] + 2, p[1] + 1, r, r * 0.45, 0, 0, 7); ctx.fill();
    const c = lk.winterTrees ? '#6a6a5a' : lk.autumn ? '#8a7a3a' : '#4f8a3a';
    ctx.fillStyle = mix(c, SNOW, lk.sf * 0.5); ctx.beginPath(); ctx.arc(p[0], p[1] - r * 0.5, r * 0.7, 0, 7); ctx.arc(p[0] - r * 0.5, p[1] - r * 0.3, r * 0.55, 0, 7); ctx.arc(p[0] + r * 0.5, p[1] - r * 0.3, r * 0.55, 0, 7); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.beginPath(); ctx.arc(p[0] - r * 0.3, p[1] - r * 0.8, r * 0.35, 0, 7); ctx.fill();
  }
  // drzewo 2D z objętością: cień, pień, korona warstwowa z jaśniejszą stroną od słońca (lewa-góra)
  function tree(ctx, p, size, conifer, seed, lk) {
    const x = p[0], y = p[1];
    ctx.fillStyle = 'rgba(0,0,0,0.22)'; ctx.beginPath(); ctx.ellipse(x + size * 0.45, y + 1, size * 0.75, size * 0.3, 0, 0, 7); ctx.fill();
    if (conifer) {
      ctx.fillStyle = '#5a3a22'; ctx.fillRect(x - 1.2, y - size * 0.3, 2.4, size * 0.32);
      const base = lk.sf > 0 ? '#2f5f3a' : '#2e6a3a', light = lk.sf > 0 ? '#3f7a4a' : '#3f8a48';
      for (let k = 0; k < 3; k++) {
        const w = size * (0.95 - k * 0.25), yb = y - size * 0.25 - k * size * 0.5, hh = size * 0.75;
        ctx.fillStyle = k % 2 ? light : base; ctx.beginPath(); ctx.moveTo(x, yb - hh); ctx.lineTo(x + w / 2, yb); ctx.lineTo(x - w / 2, yb); ctx.closePath(); ctx.fill();
        ctx.fillStyle = 'rgba(0,0,0,0.22)'; ctx.beginPath(); ctx.moveTo(x, yb - hh); ctx.lineTo(x + w / 2, yb); ctx.lineTo(x, yb); ctx.closePath(); ctx.fill();
        if (lk.sf > 0) { ctx.fillStyle = 'rgba(240,245,250,' + (0.5 * lk.sf + 0.3) + ')'; ctx.beginPath(); ctx.moveTo(x, yb - hh); ctx.lineTo(x + w * 0.22, yb - hh * 0.55); ctx.lineTo(x - w * 0.22, yb - hh * 0.55); ctx.closePath(); ctx.fill(); }
      }
    } else {
      const th = size * 0.5;
      ctx.fillStyle = '#5a3a22'; ctx.fillRect(x - 1.5, y - th, 3, th + 1);
      if (lk.winterTrees) {
        ctx.strokeStyle = '#5a4a3a'; ctx.lineWidth = 1.2; ctx.beginPath();
        for (let k = 0; k < 5; k++) { const a = -Math.PI / 2 + (k - 2) * 0.45 + (hsh(seed, k) - 0.5) * 0.3; ctx.moveTo(x, y - th); ctx.lineTo(x + Math.cos(a) * size * 0.8, y - th + Math.sin(a) * size * 0.8); }
        ctx.stroke();
        if (lk.sf > 0) { ctx.fillStyle = 'rgba(240,245,250,0.5)'; ctx.beginPath(); ctx.arc(x, y - th - size * 0.5, size * 0.4, 0, 7); ctx.fill(); }
        return;
      }
      const pal = lk.autumn ? [['#b8662a', '#d9a23a'], ['#c9803a', '#e8c04a'], ['#8a7a2a', '#c9b44a']][seed % 3] : [['#3f7a30', '#6fae45'], ['#4a8838', '#7fbb4f'], ['#386f2c', '#5f9f3e']][seed % 3];
      const r = size * 0.62, cy = y - th - r * 0.6;
      ctx.fillStyle = pal[0]; ctx.beginPath(); ctx.arc(x, cy, r, 0, 7); ctx.arc(x - r * 0.55, cy + r * 0.25, r * 0.7, 0, 7); ctx.arc(x + r * 0.55, cy + r * 0.3, r * 0.7, 0, 7); ctx.fill();
      ctx.fillStyle = pal[1]; ctx.beginPath(); ctx.arc(x - r * 0.3, cy - r * 0.3, r * 0.6, 0, 7); ctx.arc(x - r * 0.65, cy + r * 0.1, r * 0.4, 0, 7); ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,0.2)'; ctx.beginPath(); ctx.arc(x + r * 0.5, cy + r * 0.45, r * 0.5, 0, 7); ctx.fill();
      if (lk.sf > 0) { ctx.fillStyle = 'rgba(240,245,250,' + (0.45 * lk.sf) + ')'; ctx.beginPath(); ctx.arc(x - r * 0.2, cy - r * 0.4, r * 0.55, 0, 7); ctx.fill(); }
    }
  }

  // ---------- dekoracje kafla (warstwa 2) ----------
  function decoTile(ctx, i, X, Y, lk, chunk) {
    const S = G.S, tt = S.map.t[i], v = S.map.v[i], pid = S.map.parcel[i];
    switch (tt) {
      case T.FIELD: case T.MEADOW: {
        const ts = pid >= 0 && G.fields && G.fields.tileState ? G.fields.tileState(i) : null;
        if (ts) plants(ctx, i, X, Y, ts, lk, pid); else grassDeco(ctx, i, X, Y, lk);
        break;
      }
      case T.GRASS: grassDeco(ctx, i, X, Y, lk); if (hsh(i, 900) < 0.025) tree(ctx, pt(X, Y, 0.4 + hsh(i, 901) * 0.2, 0.4 + hsh(i, 902) * 0.2), 14 + hsh(i, 903) * 8, hsh(i, 904) < 0.3, i, lk); break;
      case T.FOREST: {
        const n = 2 + (v & 1);
        const ts = [];
        for (let k = 0; k < n; k++) ts.push({ u: 0.15 + hsh(i, k * 3) * 0.7, w: 0.15 + hsh(i, k * 3 + 1) * 0.7, s: 13 + hsh(i, k * 3 + 2) * 9, c: hsh(i, k * 3 + 7) < 0.45 });
        ts.sort((a, b) => (a.u + a.w) - (b.u + b.w));
        for (const t of ts) tree(ctx, pt(X, Y, t.u, t.w), t.s, t.c, i + t.s | 0, lk);
        break;
      }
      case T.VILLAGE: {
        const seed = v;
        if (hsh(i, 10) < 0.72) {
          // domek: sprite 3D rysowany w układzie świata; obrót ku drodze
          const x = i % W, y = (i / W) | 0;
          const roadS = y < H - 1 && S.map.t[i + W] === T.ASPHALT, roadN = y > 0 && S.map.t[i - W] === T.ASPHALT;
          const ang = roadS ? 0 : roadN ? Math.PI : (seed & 1 ? Math.PI / 2 : 0);
          const e = SP.get('cottage', ang, { seed, zoom: chunk.level, exactAngle: true });
          const cx = X, cy = Y + 16;
          const k = 1 / e.scale;
          ctx.drawImage(e.c, cx - e.ox * k, cy - e.oy * k, e.w * k, e.h * k);
          for (const l of e.lights) chunk.lights.push({ x: cx + l.x, y: cy + l.y, r: l.r, c: l.c });
          if (e.anchors.chimney) chunk.chimneys.push({ x: cx + e.anchors.chimney.sx, y: cy + e.anchors.chimney.sy });
        } else {
          // sad / ogród
          for (let k = 0; k < 3; k++) tree(ctx, pt(X, Y, 0.2 + k * 0.3, 0.3 + hsh(i, k + 5) * 0.4), 9 + hsh(i, k) * 4, false, i + k, lk);
        }
        break;
      }
    }
  }
  // miedze i granice własności (warstwa dekoracji — nad gruntem, pod obiektami)
  function borders(ctx, i, X, Y, lk) {
    const S = G.S, pid = S.map.parcel[i];
    if (pid < 0) return;
    const p = S.parcels[pid], x = i % W, y = (i / W) | 0;
    const nb = [[x, y - 1, [[X - 32, Y + 16], [X, Y]]], [x + 1, y, [[X, Y], [X + 32, Y + 16]]], [x, y + 1, [[X + 32, Y + 16], [X, Y + 32]]], [x - 1, y, [[X, Y + 32], [X - 32, Y + 16]]]];
    const own = p.owner === 'player', market = p.owner === 'market';
    for (const n of nb) {
      const inMap = G.inMap(n[0], n[1]);
      const np = inMap ? S.map.parcel[n[1] * W + n[0]] : -1;
      if (np === pid) continue;
      const a = n[2][0], b = n[2][1];
      // miedza — pas trawy
      ctx.strokeStyle = mix(lk.grassDark, SNOW, lk.sf); ctx.lineWidth = 2.6; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      if (own || market) {
        ctx.strokeStyle = own ? (p.leased ? '#e8c56a' : '#f3c53d') : 'rgba(255,250,235,0.9)'; ctx.lineWidth = own && !p.leased ? 2.2 : 1.8;
        if (market || p.leased) ctx.setLineDash([6, 5]);
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }

  // ---------- kawałki ----------
  function chunkKey(level, cx, cy) { return level + ':' + cx + ':' + cy; }
  function chunkHash(cx, cy) {
    // skrót stanu kafli (do wykrycia zmian): uprawy, fazy, własność
    const S = G.S; let h = 2166136261;
    const mixh = v => { h ^= v; h = Math.imul(h, 16777619); };
    const ts = G.fields && G.fields.tileState;
    for (let y = cy * CH; y < cy * CH + CH; y++) for (let x = cx * CH; x < cx * CH + CH; x++) {
      const i = y * W + x, pid = S.map.parcel[i];
      mixh(S.map.t[i]);
      if (pid < 0) continue;
      const p = S.parcels[pid];
      mixh(pid + 7); mixh(p.owner === 'player' ? 1 : p.owner === 'market' ? 2 : 3); mixh(p.leased ? 5 : 6);
      const s = ts ? ts(i) : null;
      if (!s) continue;
      mixh(cropCode(s.crop)); mixh(phaseCode(s.phase)); mixh(Math.round((s.growth || 0) * 12)); mixh(s.worked ? 11 : 13); mixh(Math.round((s.weeds || 0) * 5)); mixh(s.straw ? 17 : 19); mixh(s.swath ? 23 : 29);
    }
    return h >>> 0;
  }
  const CROPC = {}, PHC = { stubble: 1, plowed: 2, cultivated: 3, sown: 4, growing: 5, ripe: 6, harvested: 7, grass: 8, mown: 9, fallow: 10 };
  let cropN = 1;
  const cropCode = c => c ? (CROPC[c] || (CROPC[c] = ++cropN)) : 0;
  const phaseCode = p => PHC[p] || 0;

  function renderChunk(ch, cx, cy, level) {
    const lk = TR.look();
    const dpr = Math.min(2, window.devicePixelRatio || 1), s = level * dpr;
    const o = ISO.toWorld(cx * CH, cy * CH);         // górny wierzchołek rombu kawałka
    const X0 = o.x - CW / 2 - PAD_SIDE, Y0 = o.y - PAD_TOP;
    const w = Math.ceil((CW + PAD_SIDE * 2) * s), h = Math.ceil((CHH + PAD_TOP + 8) * s);
    if (!ch.g) { ch.g = document.createElement('canvas'); ch.d = document.createElement('canvas'); }
    if (ch.g.width !== w || ch.g.height !== h) { totalPx -= 2 * ch.g.width * ch.g.height; ch.g.width = ch.d.width = w; ch.g.height = ch.d.height = h; totalPx += 2 * w * h; }
    ch.scale = s; ch.X0 = X0; ch.Y0 = Y0; ch.level = level; ch.lights = []; ch.chimneys = [];
    const g = ch.g.getContext('2d'), d = ch.d.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, w, h); d.setTransform(1, 0, 0, 1, 0, 0); d.clearRect(0, 0, w, h);
    g.setTransform(s, 0, 0, s, -X0 * s, -Y0 * s); d.setTransform(s, 0, 0, s, -X0 * s, -Y0 * s);
    // grunt: lekkie rozszerzenie rombów, żeby nie prześwitywały szwy
    for (let y = cy * CH; y < cy * CH + CH; y++) for (let x = cx * CH; x < cx * CH + CH; x++) {
      if (x >= W || y >= H) continue;
      const i = y * W + x, p = ISO.toWorld(x, y);
      groundTile(g, i, p.x, p.y, lk);
    }
    // szwy: cienka linia tego samego koloru po przekątnych nie jest potrzebna — romby stykają się dokładnie (brak AA przy fill+stroke 0.5)
    g.lineWidth = 0.7;
    for (let y = cy * CH; y < cy * CH + CH; y++) for (let x = cx * CH; x < cx * CH + CH; x++) {
      if (x >= W || y >= H) continue;
      const i = y * W + x, p = ISO.toWorld(x, y);
      if (G.S.map.t[i] === T.WATER || G.S.map.t[i] === T.YARD) continue;
      g.strokeStyle = 'rgba(0,0,0,0.05)'; diamond(g, p.x, p.y); g.stroke();
    }
    // dekoracje w kolejności głębi (x + y rosnąco)
    for (let sidx = 0; sidx <= 2 * (CH - 1); sidx++) for (let x = Math.max(0, sidx - CH + 1); x <= Math.min(CH - 1, sidx); x++) {
      const y = sidx - x, tx = cx * CH + x, ty = cy * CH + y;
      if (tx >= W || ty >= H) continue;
      const i = ty * W + tx, p = ISO.toWorld(tx, ty);
      borders(d, i, p.x, p.y, lk);
      decoTile(d, i, p.x, p.y, lk, ch);
    }
    ch.look = lk.key;
    ch.hash = chunkHash(cx, cy);
    ch.dirty = false;
    while (totalPx > MAX_PX && chunks.size > 1) evictOne(ch);
  }
  function evictOne(keep) {
    let worst = null, wk = null;
    for (const [k, c] of chunks) { if (c === keep) continue; if (!worst || c.last < worst.last) { worst = c; wk = k; } }
    if (worst) { totalPx -= 2 * worst.g.width * worst.g.height; chunks.delete(wk); }
  }
  TR.invalidateAll = function () { for (const c of chunks.values()) c.dirty = true; fieldDir = null; };
  TR.invalidateTile = function (i) {
    if (i == null || i < 0) return;
    const cx = Math.floor((i % W) / CH), cy = Math.floor(((i / W) | 0) / CH);
    for (const [k, c] of chunks) { const parts = k.split(':'); if (+parts[1] === cx && +parts[2] === cy) c.dirty = true; }
  };
  function invalidateParcel(p) {
    if (typeof p === 'number') p = G.S.parcels[p];
    if (!p || !p.tiles) return;
    const seen = new Set();
    for (const i of p.tiles) { const k = Math.floor((i % W) / CH) + ':' + Math.floor(((i / W) | 0) / CH); if (seen.has(k)) continue; seen.add(k); TR.invalidateTile(i); }
  }
  G.on('mapChanged', i => TR.invalidateTile(i));
  G.on('parcelChanged', invalidateParcel);
  G.on('landBought', invalidateParcel);
  G.on('landSold', invalidateParcel);
  G.on('newGame', () => { chunks.clear(); totalPx = 0; fieldDir = null; waterTiles = null; });
  G.on('load', () => { TR.invalidateAll(); waterTiles = null; });

  // widoczne kawałki dla bieżącej kamery
  function visibleChunks(pad) {
    const vr = ISO.visibleRange(pad || 1);
    const out = [];
    const cx0 = Math.floor(vr.x0 / CH), cx1 = Math.floor(vr.x1 / CH), cy0 = Math.floor(vr.y0 / CH), cy1 = Math.floor(vr.y1 / CH);
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) out.push([cx, cy]);
    out.sort((a, b) => (a[0] + a[1]) - (b[0] + b[1]) || a[0] - b[0]);
    return out;
  }
  // czy romb kawałka przecina ekran
  function chunkOnScreen(cx, cy, cam) {
    const o = ISO.toWorld(cx * CH, cy * CH);
    const x0 = (o.x - CW / 2 - PAD_SIDE - cam.x) * cam.zoom, x1 = (o.x + CW / 2 + PAD_SIDE - cam.x) * cam.zoom;
    const y0 = (o.y - PAD_TOP - cam.y) * cam.zoom, y1 = (o.y + CHH + 8 - cam.y) * cam.zoom;
    return x1 >= 0 && x0 <= cam.vw && y1 >= 0 && y0 <= cam.vh;
  }

  // główne rysowanie: dwie warstwy
  TR.draw = function (ctx) {
    const cam = G.cam, level = SP.levelFor(cam.zoom), lk = TR.look();
    const now = performance.now();
    const list = visibleChunks(1).filter(c => chunkOnScreen(c[0], c[1], cam));
    // co ~0,5 s sprawdź skróty stanu widocznych kawałków
    const checkHash = now - hashAt > 500;
    if (checkHash) hashAt = now;
    let budget = 7, rendered = 0;                   // ms na renderowanie nowych kawałków w tej klatce
    const ready = [];
    for (const [cx, cy] of list) {
      const key = chunkKey(level, cx, cy);
      let ch = chunks.get(key);
      if (!ch) { ch = { g: null, d: null, dirty: true, last: now }; chunks.set(key, ch); }
      ch.last = now;
      if (!ch.dirty && ch.g) {
        if (ch.look !== lk.key) ch.dirty = true;
        else if (checkHash && (rendered < 3)) { const hsv = chunkHash(cx, cy); if (hsv !== ch.hash) ch.dirty = true; }
      }
      if (ch.dirty || !ch.g) {
        const t0 = performance.now();
        if (budget > 0 || !ch.g) { renderChunk(ch, cx, cy, level); rendered++; budget -= performance.now() - t0; }
      }
      ready.push(ch);
    }
    // grunt
    ctx.imageSmoothingEnabled = true;
    for (const ch of ready) {
      const k = cam.zoom / ch.scale;
      ctx.drawImage(ch.g, (ch.X0 - cam.x) * cam.zoom, (ch.Y0 - cam.y) * cam.zoom, ch.g.width * k, ch.g.height * k);
    }
    for (const ch of ready) {
      const k = cam.zoom / ch.scale;
      ctx.drawImage(ch.d, (ch.X0 - cam.x) * cam.zoom, (ch.Y0 - cam.y) * cam.zoom, ch.d.width * k, ch.d.height * k);
    }
    TR._ready = ready;
    return rendered;
  };
  // światła okien we wsi (z widocznych kawałków) → ekranowe pozycje liczy objects/render
  TR.lights = function () {
    const out = [];
    for (const ch of TR._ready || []) for (const l of ch.lights) out.push(l);
    return out;
  };
  TR.chimneys = function () {
    const out = [];
    for (const ch of TR._ready || []) for (const c of ch.chimneys) out.push(c);
    return out;
  };

  // ---------- elementy dynamiczne: woda ----------
  TR.drawDynamic = function (ctx, now) {
    const S = G.S, cam = G.cam, lk = TR.look();
    if (lk.frozen) return;
    if (!waterTiles) { waterTiles = []; for (let i = 0; i < W * H; i++) if (S.map.t[i] === T.WATER) waterTiles.push(i); }
    const vr = ISO.visibleRange(0), z = cam.zoom, t = now / 1000;
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = Math.max(0.8, 1.2 * z); ctx.lineCap = 'round';
    ctx.beginPath();
    for (const i of waterTiles) {
      const x = i % W, y = (i / W) | 0;
      if (x < vr.x0 || x > vr.x1 || y < vr.y0 || y > vr.y1) continue;
      for (let k = 0; k < 3; k++) {
        const ph = (t * 0.6 + hsh(i, k) * 3) % 1;
        const u = (hsh(i, k + 3) + ph * 0.25) % 1, v = hsh(i, k + 6);
        const p = ISO.toWorld(x + 0.1 + u * 0.8, y + 0.1 + v * 0.8);
        const sx = (p.x - cam.x) * z, sy = (p.y - cam.y) * z, len = (4 + 6 * Math.sin(ph * Math.PI)) * z;
        ctx.moveTo(sx - len / 2, sy); ctx.lineTo(sx + len / 2, sy);
      }
    }
    ctx.stroke();
  };

  // kolor do minimapy
  TR.tileColor = function (i) {
    const S = G.S, tt = S.map.t[i], lk = TR.look();
    const pid = S.map.parcel[i];
    if ((tt === T.FIELD || tt === T.MEADOW) && pid >= 0 && G.fields && G.fields.tileState) {
      const ts = G.fields.tileState(i);
      if (ts) return fieldGround(null, i, 0, 0, ts, lk, '#8a7a5a');
    }
    switch (tt) {
      case T.GRASS: return lk.grass; case T.MEADOW: return lk.meadow; case T.FOREST: return mix('#3b6b2f', SNOW, lk.sf * 0.6);
      case T.WATER: return lk.frozen ? '#c9d9e4' : '#3d7fbf'; case T.ROAD: return mix('#b39a6e', SNOW, lk.sf); case T.ASPHALT: return '#50545a';
      case T.YARD: return '#a09a8e'; case T.VILLAGE: return '#c96f4a'; case T.FIELD: return mix(soilColor(i), SNOW, lk.sf);
    }
    return '#000';
  };
  TR.stats = () => ({ chunks: chunks.size, px: totalPx });
  TR.CH = CH;
})();
