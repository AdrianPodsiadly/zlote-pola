// Złote Pola — sprite'y proceduralne (agent: grafika) → G.sprites
//
// Wszystko rysowane jest z małych brył 3D (pudełka, graniastosłupy, walce) rzutowanych izometrycznie, cieniowanych
// jednym źródłem światła (słońce z lewej-góry), sortowanych malarsko i buforowanych na offscreen canvasach.
//
// Układ modelu (jednostki = kafle): x = „przód” pojazdu (0 = +x kafli), y w dół mapy (lewa strona pojazdu = −y, jak w jobs.js),
// z w górę. Rzut przy zoom 1:  X = (x − y)·32,  Y = (x + y)·16 − z·ZS.
//
// API:
//   G.sprites.get(key, angle, opts) → { c (canvas), ox, oy (punkt (0,0,0) modelu w px canvasa), scale (px canvasa na px świata), lights:[{x,y,r}], anchors:{} }
//     key — klucz modelu (DESIGN.md), angle — kąt w radianach (kwantowany do NDIR kierunków), opts — { color, cap, axle, fill, auger,
//     lowered, level, size:[w,h], variant, progress, anim, frame, scale, young, zoom }.
//   G.sprites.draw(ctx, key, angle, opts, sx, sy, zoom) — rysuje sprite z punktem (0,0,0) w (sx, sy) ekranu.
//   G.sprites.model(key, opts) → Model (do własnego rysowania); G.sprites.Model — klasa budowania brył; G.sprites.renderModel(ctx, model, angle, scale, ox, oy).
//   G.sprites.levelFor(zoom) — poziom jakości bufora dla zoomu; G.sprites.clear() — czyści pamięć podręczną.
(function () {
  const SP = G.sprites = {};
  const ZS = 34;                       // px na jednostkę wysokości przy zoom 1
  const NDIR = 24;                     // liczba kierunków buforowanych dla pojazdów/zwierząt
  const LEVELS = [0.35, 0.5, 0.7, 1, 1.4, 2, 2.5];
  // światło: słońce z lewej-góry-przodu (w układzie kafli), kamera patrzy z (+x,+y,+z)
  const L = norm3(-0.35, 0.55, 0.78);
  const V = norm3(1, 1, 0.94);
  const AMB = 0.52, DIF = 0.58;

  function norm3(x, y, z) { const l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l]; }
  SP.ZS = ZS; SP.NDIR = NDIR; SP.LEVELS = LEVELS;
  SP.levelFor = function (zoom) { for (const l of LEVELS) if (l >= zoom - 1e-6) return l; return LEVELS[LEVELS.length - 1]; };

  // ---------- kolory ----------
  function hex2rgb(h) {
    if (typeof h !== 'string') return [200, 60, 200];
    if (h[0] === '#') {
      if (h.length === 4) return [parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16), parseInt(h[3] + h[3], 16)];
      const n = parseInt(h.slice(1, 7), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255];
    }
    const m = h.match(/rgba?\(([^)]+)\)/); if (m) { const p = m[1].split(',').map(Number); return [p[0], p[1], p[2]]; }
    return [200, 60, 200];
  }
  const rgb2hex = c => '#' + ((1 << 24) | (clamp255(c[0]) << 16) | (clamp255(c[1]) << 8) | clamp255(c[2])).toString(16).slice(1);
  const clamp255 = v => Math.max(0, Math.min(255, Math.round(v)));
  // rozjaśnienie/przyciemnienie: f > 1 jaśniej, < 1 ciemniej
  SP.shade = function (h, f) { const c = hex2rgb(h); return rgb2hex([c[0] * f, c[1] * f, c[2] * f]); };
  SP.mix = function (a, b, t) { const x = hex2rgb(a), y = hex2rgb(b); return rgb2hex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]); };
  SP.rgb = hex2rgb;
  const shade = SP.shade, mix = SP.mix;
  // cieniowanie ściany wg normalnej (w układzie świata po obrocie)
  function lit(color, n) {
    const d = Math.max(0, n[0] * L[0] + n[1] * L[1] + n[2] * L[2]);
    const f = AMB + DIF * d;
    const c = hex2rgb(color);
    // lekkie ocieplenie oświetlonych i ochłodzenie zacienionych ścian — spójna paleta
    return rgb2hex([c[0] * f + (d - 0.4) * 10, c[1] * f + (d - 0.4) * 4, c[2] * f - (d - 0.4) * 8]);
  }

  // ---------- Model: zbiór ścian 3D ----------
  function Model() { this.faces = []; this.lights = []; this.anchors = {}; this.flat = []; }
  SP.Model = Model;
  // ściana: pts [[x,y,z],...], color, opts { noShade, alpha, line (tylko obrys), lw, emissive, bias (korekta głębi) }
  Model.prototype.face = function (pts, color, opts) { this.faces.push({ p: pts, c: color, o: opts || null }); return this; };
  // światło (okno/reflektor) w punkcie modelu — rysowane nocą przez objects.js
  Model.prototype.light = function (x, y, z, r, color) { this.lights.push({ p: [x, y, z], r: r || 2, c: color || '#ffd27a' }); return this; };
  Model.prototype.anchor = function (name, x, y, z) { this.anchors[name] = [x, y, z]; return this; };
  // pudełko: środek podstawy (cx, cy), dół cz, wymiary sx, sy, sz
  Model.prototype.box = function (cx, cy, cz, sx, sy, sz, color, opts) {
    return this.prism('z', [[cx - sx / 2, cy - sy / 2], [cx + sx / 2, cy - sy / 2], [cx + sx / 2, cy + sy / 2], [cx - sx / 2, cy + sy / 2]], cz, cz + sz, color, opts);
  };
  // graniastosłup: wielokąt poly2d wyciągnięty wzdłuż osi axis od a0 do a1.
  //  axis 'z': poly w (x, y);  axis 'x': poly w (y, z);  axis 'y': poly w (x, z)
  Model.prototype.prism = function (axis, poly, a0, a1, color, opts) {
    const to3 = (p, a) => axis === 'z' ? [p[0], p[1], a] : axis === 'x' ? [a, p[0], p[1]] : [p[0], a, p[1]];
    const n = poly.length, A = poly.map(p => to3(p, a0)), B = poly.map(p => to3(p, a1));
    const o = opts || {};
    // środek bryły (do ustalenia zwrotu normalnych)
    let cx = 0, cy = 0, cz = 0;
    for (const p of A.concat(B)) { cx += p[0]; cy += p[1]; cz += p[2]; }
    const ctr = [cx / (2 * n), cy / (2 * n), cz / (2 * n)];
    if (!o.noCaps) { this.faces.push({ p: A, c: o.capColor || color, o: opts, ctr }); this.faces.push({ p: B, c: o.capColor2 || o.capColor || color, o: opts, ctr }); }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      this.faces.push({ p: [A[i], A[j], B[j], B[i]], c: o.sideColors ? o.sideColors[i % o.sideColors.length] : color, o: opts, ctr });
    }
    return this;
  };
  // walec wzdłuż osi: środek (cx, cy, cz) przekroju, promień r, długość od a0 do a1 (względem osi), segs
  Model.prototype.cyl = function (axis, cx, cy, cz, r, a0, a1, color, segs, opts) {
    segs = segs || 12;
    const poly = [];
    const u = axis === 'z' ? cx : axis === 'x' ? cy : cx, v = axis === 'z' ? cy : cz;
    for (let i = 0; i < segs; i++) { const a = i / segs * Math.PI * 2 + (opts && opts.phase || 0); poly.push([u + Math.cos(a) * r, v + Math.sin(a) * r]); }
    return this.prism(axis, poly, a0, a1, color, opts);
  };
  // koło (oś y = lewo-prawo): środek (cx, cy), promień r, szerokość w, kolor opony; felga jaśniejsza
  Model.prototype.wheel = function (cx, cy, cz, r, w, color, rim) {
    this.cyl('y', cx, cy, cz, r, cy - w / 2, cy + w / 2, color || '#2a2a2c', 14, { capColor: rim || '#8f8f93', phase: 0.2 });
    // piasta
    this.cyl('y', cx, cy, cz, r * 0.33, cy - w / 2 - 0.004, cy + w / 2 + 0.004, shade(rim || '#8f8f93', 0.8), 8);
    return this;
  };
  // dach dwuspadowy wzdłuż osi x (kalenica wzdłuż x): środek (cx, cy), dół okapu z0, szerokość sy, długość sx, wysokość h, nawis ov
  Model.prototype.gable = function (cx, cy, z0, sx, sy, h, color, ov, opts) {
    ov = ov || 0.08;
    const poly = [[cy - sy / 2 - ov, z0 - ov * 0.5], [cy, z0 + h], [cy + sy / 2 + ov, z0 - ov * 0.5], [cy + sy / 2 + ov, z0 - ov * 0.5 - 0.03], [cy, z0 + h - 0.03], [cy - sy / 2 - ov, z0 - ov * 0.5 - 0.03]];
    return this.prism('x', poly, cx - sx / 2 - ov, cx + sx / 2 + ov, color, Object.assign({ capColor: shade(color, 0.72) }, opts || {}));
  };
  // płaski rysunek 2D po rzutowaniu (np. tekst, ikony) — fn(ctx, proj) wołane po ścianach
  Model.prototype.after = function (fn) { this.flat.push(fn); return this; };

  // ---------- rzut i rysowanie ----------
  function rot(p, ca, sa) { return [p[0] * ca - p[1] * sa, p[0] * sa + p[1] * ca, p[2]]; }
  function proj(p) { return [(p[0] - p[1]) * 32, (p[0] + p[1]) * 16 - p[2] * ZS]; }
  function normal(P) {
    // Newell
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < P.length; i++) {
      const a = P[i], b = P[(i + 1) % P.length];
      nx += (a[1] - b[1]) * (a[2] + b[2]); ny += (a[2] - b[2]) * (a[0] + b[0]); nz += (a[0] - b[0]) * (a[1] + b[1]);
    }
    return norm3(nx, ny, nz);
  }
  // przygotowanie ścian: obrót, odrzucenie tylnych, sortowanie głębi
  function prepare(model, angle) {
    const ca = Math.cos(angle), sa = Math.sin(angle), out = [];
    for (const f of model.faces) {
      const P = f.p.map(p => rot(p, ca, sa));
      let n = normal(P);
      let cx = 0, cy = 0, cz = 0;
      for (const p of P) { cx += p[0]; cy += p[1]; cz += p[2]; }
      cx /= P.length; cy /= P.length; cz /= P.length;
      if (f.ctr) {
        const c = rot(f.ctr, ca, sa);
        if (n[0] * (cx - c[0]) + n[1] * (cy - c[1]) + n[2] * (cz - c[2]) < 0) n = [-n[0], -n[1], -n[2]];
      } else if (f.o && f.o.twoSided) {
        if (n[0] * V[0] + n[1] * V[1] + n[2] * V[2] < 0) n = [-n[0], -n[1], -n[2]];
      }
      const vis = n[0] * V[0] + n[1] * V[1] + n[2] * V[2];
      if (vis <= 0.001 && !(f.o && f.o.twoSided)) continue;
      const depth = cx + cy + cz * 0.94 + (f.o && f.o.bias || 0);
      out.push({ P, n, depth, f, cx, cy, cz });
    }
    out.sort((a, b) => a.depth - b.depth);
    return { faces: out, ca, sa };
  }
  // rysuje model w ctx; scale = px na px świata (zoom); (ox, oy) = ekranowa pozycja punktu (0,0,0)
  SP.renderModel = function (ctx, model, angle, scale, ox, oy) {
    const pr = prepare(model, angle);
    ctx.save();
    ctx.translate(ox, oy); ctx.scale(scale, scale);
    ctx.lineJoin = 'round';
    for (const F of pr.faces) {
      const o = F.f.o;
      const col = o && o.noShade ? F.f.c : lit(F.f.c, F.n);
      ctx.beginPath();
      for (let i = 0; i < F.P.length; i++) { const q = proj(F.P[i]); if (i) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]); }
      ctx.closePath();
      if (o && o.alpha != null) ctx.globalAlpha = o.alpha;
      if (o && o.line) { ctx.strokeStyle = col; ctx.lineWidth = o.lw || 1; ctx.stroke(); }
      else { ctx.fillStyle = col; ctx.fill(); ctx.strokeStyle = col; ctx.lineWidth = 0.6; ctx.stroke(); }
      if (o && o.alpha != null) ctx.globalAlpha = 1;
    }
    for (const fn of model.flat) fn(ctx, p => proj(rot(p, pr.ca, pr.sa)));
    ctx.restore();
  };
  // granice rzutu modelu (px świata)
  function bounds(model, angle) {
    const ca = Math.cos(angle), sa = Math.sin(angle);
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const f of model.faces) for (const p of f.p) {
      const q = proj(rot(p, ca, sa));
      if (q[0] < x0) x0 = q[0]; if (q[0] > x1) x1 = q[0]; if (q[1] < y0) y0 = q[1]; if (q[1] > y1) y1 = q[1];
    }
    if (x0 > x1) { x0 = -4; x1 = 4; y0 = -4; y1 = 4; }
    return { x0, y0, x1, y1 };
  }

  // ---------- pamięć podręczna ----------
  const cache = new Map();
  let cachePx = 0;
  const MAX_PX = 24e6;
  SP.clear = function () { cache.clear(); cachePx = 0; };
  SP.stats = () => ({ sprites: cache.size, px: cachePx });
  function evict() {
    // usuń najstarsze (Map zachowuje kolejność wstawiania)
    for (const [k, e] of cache) { cache.delete(k); cachePx -= e.c.width * e.c.height; if (cachePx < MAX_PX * 0.7) break; }
  }
  const q = (v, n) => Math.round((v || 0) * n) / n;
  function optKey(key, o) {
    if (!o) return '';
    let s = (o.color || '') + '|' + (o.cap || '') + '|' + (o.axle || '') + '|' + q(o.fill, 4) + '|' + (o.auger || '') + '|' + (o.lowered ? 1 : 0) + '|' + (o.level || 1) + '|' +
      (o.size ? o.size.join('x') : '') + '|' + (o.variant || '') + '|' + (o.progress != null && o.progress < 1 ? q(o.progress, 8) : 1) + '|' + (o.anim || '') + '|' + (o.frame || 0) + '|' +
      (o.scale || 1) + '|' + (o.young ? 1 : 0) + '|' + (o.rot || 0) + '|' + (o.seed || 0) + '|' + (o.season || '') + '|' + (o.open ? 1 : 0);
    return s;
  }
  // angle → indeks kierunku; budynki mają stałe kąty (0 / π/2)
  SP.dirIndex = a => ((Math.round(a / (Math.PI * 2) * NDIR) % NDIR) + NDIR) % NDIR;
  SP.dirAngle = d => d * Math.PI * 2 / NDIR;

  // główna funkcja: sprite dla klucza modelu pod danym kątem
  SP.get = function (key, angle, opts) {
    opts = opts || {};
    const zoom = opts.zoom || (G.cam ? G.cam.zoom : 1);
    const level = SP.levelFor(zoom);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const scale = level * dpr;
    let a;
    if (opts.exactAngle) a = angle || 0; else { const d = SP.dirIndex(angle || 0); a = SP.dirAngle(d); }
    const ck = key + '#' + a.toFixed(3) + '#' + scale.toFixed(2) + '#' + optKey(key, opts);
    let e = cache.get(ck);
    if (e) return e;
    const model = SP.model(key, opts);
    const b = bounds(model, a);
    const pad = 3;
    const w = Math.ceil((b.x1 - b.x0) * scale) + pad * 2, h = Math.ceil((b.y1 - b.y0) * scale) + pad * 2;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.min(4096, w)); c.height = Math.max(1, Math.min(4096, h));
    const ctx = c.getContext('2d');
    const ox = -b.x0 * scale + pad, oy = -b.y0 * scale + pad;
    SP.renderModel(ctx, model, a, scale, ox, oy);
    const ca = Math.cos(a), sa = Math.sin(a);
    const lights = model.lights.map(l => { const p = proj(rot(l.p, ca, sa)); return { x: p[0], y: p[1], r: l.r, c: l.c }; });
    const anchors = {};
    for (const k in model.anchors) { const p = rot(model.anchors[k], ca, sa); anchors[k] = { x: p[0], y: p[1], z: p[2], sx: proj(p)[0], sy: proj(p)[1] }; }
    e = { c, ox, oy, scale, lights, anchors, w: c.width, h: c.height, key };
    cache.set(ck, e); cachePx += c.width * c.height;
    if (cachePx > MAX_PX) evict();
    return e;
  };
  // rysuje sprite: (sx, sy) ekranowa pozycja punktu (0,0,0); zoom bieżący
  SP.draw = function (ctx, key, angle, opts, sx, sy, zoom) {
    const e = SP.get(key, angle, Object.assign({ zoom }, opts || {}));
    const k = zoom / e.scale;
    ctx.drawImage(e.c, sx - e.ox * k, sy - e.oy * k, e.w * k, e.h * k);
    return e;
  };

  // ---------- definicje modeli ----------
  const DEF = SP.DEF = {};
  SP.model = function (key, opts) {
    opts = opts || {};
    const m = new Model();
    const fn = DEF[key] || DEF.unknown;
    try { fn(m, opts); } catch (e) { console.error('[sprites] model ' + key, e); DEF.unknown(m, opts); }
    return m;
  };
  SP.has = key => !!DEF[key];

  const GLASS = '#9ec4d8', GLASS_N = '#6d8ea3', DARK = '#2b2d30', STEEL = '#b8bcc2', RUBBER = '#26282b', RIM = '#9c9ea2', WOOD = '#8b6a3e';
  const col = (o, d) => (o && o.color) || d;

  // --- pomocnicze elementy pojazdów ---
  // kabina ze szkleniem: środek (cx, cy), dół cz, wymiary, kolor słupków
  function cab(m, cx, cy, cz, sx, sy, sz, color, glass) {
    glass = glass || GLASS;
    m.box(cx, cy, cz, sx, sy, sz * 0.18, shade(color, 0.9));                 // podłoga kabiny
    const z0 = cz + sz * 0.18, z1 = cz + sz * 0.92;
    // szyby (lekko mniejsze niż dach), słupki narożne
    m.box(cx, cy, z0, sx * 0.9, sy * 0.92, z1 - z0, glass);
    const pw = 0.012;
    for (const dx of [-1, 1]) for (const dy of [-1, 1]) m.box(cx + dx * (sx / 2 - pw), cy + dy * (sy / 2 - pw), z0, pw * 2, pw * 2, z1 - z0, shade(color, 0.6));
    m.box(cx, cy, z1, sx * 1.04, sy * 1.06, sz * 0.08, shade(color, 0.85));  // dach
    // światła robocze na dachu (przód)
    m.light(cx + sx / 2, cy - sy * 0.3, z1 + sz * 0.08, 1.6, '#fff1c0');
    m.light(cx + sx / 2, cy + sy * 0.3, z1 + sz * 0.08, 1.6, '#fff1c0');
  }
  function exhaust(m, x, y, z0, h, r) { m.cyl('z', x, y, z0, r || 0.012, z0, z0 + h, '#3a3a3c', 6); m.anchor('exhaust', x, y, z0 + h); }
  // zaczep tylny (TUZ)
  function hitch(m, x, y, z) { m.box(x, y, z, 0.05, 0.08, 0.03, '#3c3c40'); m.anchor('hitch', x, y, z); }

  // ===================== CIĄGNIKI =====================
  // Stary ciągnik w stylu klasycznych polskich maszyn (lata 80.): wąska maska, odkryta rama, duże tylne koła, mała kabina
  DEF.tractor_small = function (m, o) {
    const c = col(o, '#b5402f');
    const Lb = 0.56, Wb = 0.26;
    // koła: tylne duże, przednie małe
    m.wheel(-0.14, -0.14, 0.15, 0.15, 0.07, RUBBER, '#c9452f');
    m.wheel(-0.14, 0.14, 0.15, 0.15, 0.07, RUBBER, '#c9452f');
    m.wheel(0.2, -0.11, 0.085, 0.085, 0.045, RUBBER, RIM);
    m.wheel(0.2, 0.11, 0.085, 0.085, 0.045, RUBBER, RIM);
    // rama i maska
    m.box(0.02, 0, 0.1, Lb * 0.55, 0.1, 0.08, '#3a3a3c');                     // podłużnica
    m.box(0.13, 0, 0.14, 0.3, 0.17, 0.17, c);                                 // maska
    m.box(0.285, 0, 0.14, 0.02, 0.19, 0.2, shade(c, 0.8));                     // grill
    m.box(0.27, 0, 0.3, 0.02, 0.15, 0.03, '#eaeaea');                          // reflektory (pas)
    m.light(0.29, -0.06, 0.25, 1.4); m.light(0.29, 0.06, 0.25, 1.4);
    // błotniki tylne
    m.box(-0.14, -0.145, 0.3, 0.2, 0.08, 0.035, shade(c, 0.9));
    m.box(-0.14, 0.145, 0.3, 0.2, 0.08, 0.035, shade(c, 0.9));
    // kabina (prosta, klasyczna) z lekko pochylonym przodem
    m.box(-0.1, 0, 0.26, 0.26, 0.24, 0.03, shade(c, 0.7));
    m.prism('z', [[-0.22, -0.11], [0.0, -0.11], [0.0, 0.11], [-0.22, 0.11]], 0.29, 0.5, GLASS);
    for (const dx of [-0.22, -0.01]) for (const dy of [-0.11, 0.11]) m.box(dx, dy, 0.29, 0.02, 0.02, 0.21, '#d8d8d8');
    m.box(-0.11, 0, 0.5, 0.26, 0.27, 0.025, '#e8e4dc');                        // biały dach
    m.light(0.0, 0, 0.52, 1.4, '#fff1c0');
    // kierowca (sylwetka)
    m.box(-0.13, 0, 0.3, 0.07, 0.08, 0.11, '#3f5a8a'); m.cyl('z', -0.13, 0, 0.41, 0.03, 0.41, 0.47, '#e2b58d', 7);
    exhaust(m, 0.12, -0.06, 0.31, 0.22, 0.012);
    hitch(m, -0.3, 0, 0.1);
    m.anchor('front', 0.3, 0, 0.15); m.anchor('rear', -0.3, 0, 0.15);
  };
  function tractorModern(m, o, size) {
    const c = col(o, '#3f7d3a');
    const s = size;                                  // 1 = średni, 1.25 = duży
    const Rr = 0.17 * s, Rf = 0.11 * s, W = 0.3 * s;
    m.wheel(-0.17 * s, -W / 2, Rr, Rr, 0.09 * s, RUBBER, RIM);
    m.wheel(-0.17 * s, W / 2, Rr, Rr, 0.09 * s, RUBBER, RIM);
    m.wheel(0.22 * s, -W / 2 + 0.02, Rf, Rf, 0.07 * s, RUBBER, RIM);
    m.wheel(0.22 * s, W / 2 - 0.02, Rf, Rf, 0.07 * s, RUBBER, RIM);
    // maska opadająca ku przodowi
    m.prism('y', [[0.02 * s, 0.12 * s], [0.36 * s, 0.14 * s], [0.36 * s, 0.3 * s], [0.02 * s, 0.36 * s]], -0.11 * s, 0.11 * s, c);
    m.box(0.36 * s, 0, 0.12 * s, 0.02, 0.2 * s, 0.17 * s, '#2a2c2f');       // grill
    m.light(0.37 * s, -0.07 * s, 0.26 * s, 1.5); m.light(0.37 * s, 0.07 * s, 0.26 * s, 1.5);
    // błotniki
    m.box(-0.17 * s, -W / 2, Rr * 2 + 0.01, 0.26 * s, 0.1 * s, 0.03, shade(c, 0.85));
    m.box(-0.17 * s, W / 2, Rr * 2 + 0.01, 0.26 * s, 0.1 * s, 0.03, shade(c, 0.85));
    // kabina
    cab(m, -0.1 * s, 0, 0.2 * s, 0.3 * s, 0.3 * s, 0.34 * s, c);
    exhaust(m, 0.06 * s, -0.12 * s, 0.36 * s, 0.26 * s, 0.014);
    hitch(m, -0.36 * s, 0, 0.12 * s);
    // obciążnik przedni
    m.box(0.4 * s, 0, 0.1 * s, 0.06 * s, 0.14 * s, 0.1 * s, '#4a4c50');
    m.anchor('front', 0.42 * s, 0, 0.16 * s); m.anchor('rear', -0.36 * s, 0, 0.15 * s);
  }
  DEF.tractor_mid = (m, o) => tractorModern(m, o, 1);
  DEF.tractor_big = (m, o) => tractorModern(m, o, 1.28);

  // ===================== KOMBAJN =====================
  // zbiornik ziarna na górze (fill), rura wyładowcza po LEWEJ (−y), auger 'in' (wzdłuż) / 'out' (w bok)
  DEF.combine = function (m, o) {
    const c = col(o, '#d1a62a'), fill = Math.max(0, Math.min(1, o.fill || 0)), out = o.auger === 'out';
    // koła: przednie napędowe duże, tylne skrętne małe
    m.wheel(0.16, -0.2, 0.2, 0.2, 0.11, RUBBER, RIM); m.wheel(0.16, 0.2, 0.2, 0.2, 0.11, RUBBER, RIM);
    m.wheel(-0.28, -0.15, 0.11, 0.11, 0.07, RUBBER, RIM); m.wheel(-0.28, 0.15, 0.11, 0.11, 0.07, RUBBER, RIM);
    // kadłub
    m.box(-0.08, 0, 0.16, 0.7, 0.4, 0.3, c);
    m.box(-0.33, 0, 0.2, 0.2, 0.38, 0.24, shade(c, 0.9));                        // tył (sieczkarnia słomy)
    m.box(-0.44, 0, 0.22, 0.04, 0.3, 0.1, '#3a3a3c');
    // zbiornik ziarna (otwarty, z nadstawkami) — widoczne ziarno
    m.box(-0.1, 0, 0.46, 0.34, 0.36, 0.1, shade(c, 0.95));
    m.box(-0.1, 0, 0.56, 0.34, 0.36, 0.015, '#8a6a2a', { noCaps: false });
    m.prism('z', [[-0.26, -0.17], [0.06, -0.17], [0.06, 0.17], [-0.26, 0.17]], 0.56, 0.6, '#4a4a4e', { line: true, lw: 0.8 });
    if (fill > 0.02) {
      const h = 0.57 + 0.09 * fill;
      m.box(-0.1, 0, 0.56, 0.3, 0.32, h - 0.56, '#e2bf55');
      if (fill > 0.3) m.prism('x', [[-0.14, h], [0, h + 0.05 * fill], [0.14, h]], -0.22, 0.02, '#eccb63');
    }
    // kabina z przodu (szeroka szyba)
    cab(m, 0.2, 0, 0.36, 0.22, 0.3, 0.3, c);
    // silnik z tyłu na górze + rura wydechowa
    m.box(-0.33, 0, 0.44, 0.18, 0.3, 0.12, shade(c, 0.85));
    exhaust(m, -0.36, -0.1, 0.56, 0.16, 0.014);
    // rura wyładowcza
    const ar = 0.028;
    if (out) {
      m.cyl('y', -0.04, 0, 0.62, ar, -0.95, -0.12, STEEL, 8);
      m.cyl('y', -0.04, -0.95, 0.55, ar * 1.2, -0.99, -0.9, shade(STEEL, 0.8), 8);  // wylot
      m.anchor('auger', -0.04, -0.97, 0.55);
    } else {
      m.cyl('x', 0, -0.2, 0.62, ar, -0.42, 0.26, STEEL, 8);
      m.anchor('auger', 0.26, -0.2, 0.62);
    }
    // podajnik pochyły (do hedera)
    m.prism('y', [[0.3, 0.2], [0.5, 0.1], [0.5, 0.22], [0.3, 0.34]], -0.12, 0.12, shade(c, 0.8));
    m.anchor('front', 0.5, 0, 0.14); m.anchor('rear', -0.46, 0, 0.2);
    m.anchor('headerMount', 0.5, 0, 0.1);
  };
  // heder zbożowy (szeroki, z nagarniaczem); rysowany jako osobna część przed kombajnem
  DEF.header = function (m, o) {
    const c = col(o, '#d1a62a'), W = 1.15, lowered = o.lowered !== false;
    const z = lowered ? 0.03 : 0.12;
    m.prism('y', [[-0.1, z], [0.12, z], [0.12, z + 0.1], [-0.1, z + 0.22]], -W / 2, W / 2, c, { capColor: shade(c, 0.85) });
    // listwa tnąca, palce
    m.box(0.12, 0, z, 0.02, W, 0.02, '#8a8a8e');
    // nagarniacz (bęben z listwami)
    for (let i = 0; i < 5; i++) { const a = i / 5 * Math.PI * 2; m.box(0.08 + Math.cos(a) * 0.09, 0, z + 0.2 + Math.sin(a) * 0.09, 0.012, W - 0.06, 0.012, '#d9d9dc'); }
    m.cyl('y', 0.08, 0, z + 0.2, 0.02, -W / 2 + 0.03, W / 2 - 0.03, '#6a6a6e', 6);
    for (const s of [-1, 1]) m.prism('y', [[0.08 - 0.1, z + 0.2 - 0.1], [0.08 + 0.1, z + 0.2 - 0.1], [0.08 + 0.1, z + 0.2 + 0.1], [0.08 - 0.1, z + 0.2 + 0.1]], s * (W / 2 - 0.03) - 0.004, s * (W / 2 - 0.03) + 0.004, '#8a8a8e', { line: true, lw: 0.8 });
    // rozdzielacze boczne
    for (const s of [-1, 1]) m.prism('z', [[0.12, s * W / 2 - 0.015], [0.3, s * W / 2 - 0.005], [0.12, s * W / 2 + 0.015]], z, z + 0.04, shade(c, 0.9));
    m.anchor('mount', -0.1, 0, 0.1);
  };

  // ===================== INNE POJAZDY =====================
  DEF.telehandler = function (m, o) {
    const c = col(o, '#e0b020');
    for (const x of [-0.18, 0.18]) for (const y of [-0.16, 0.16]) m.wheel(x, y, 0.13, 0.13, 0.08, RUBBER, RIM);
    m.box(0, 0, 0.14, 0.56, 0.34, 0.14, c);
    cab(m, -0.02, -0.12, 0.28, 0.22, 0.14, 0.26, c);
    m.box(-0.16, 0.08, 0.28, 0.2, 0.14, 0.12, shade(c, 0.85)); // silnik
    // wysięgnik teleskopowy lekko uniesiony
    m.prism('y', [[-0.26, 0.3], [0.3, 0.46], [0.3, 0.52], [-0.26, 0.4]], 0.02, 0.12, shade(c, 0.95));
    // widły/łyżka
    m.box(0.4, 0, 0.1, 0.1, 0.34, 0.14, '#5a5c60');
    m.anchor('front', 0.45, 0, 0.1); m.anchor('rear', -0.28, 0, 0.12);
  };
  DEF.pickup = function (m, o) {
    const c = col(o, '#2f5f9e');
    for (const x of [-0.17, 0.17]) for (const y of [-0.13, 0.13]) m.wheel(x, y, 0.08, 0.08, 0.05, RUBBER, RIM);
    m.box(0, 0, 0.1, 0.56, 0.28, 0.1, c);
    m.prism('y', [[0.08, 0.2], [0.28, 0.2], [0.28, 0.26], [0.08, 0.26]], -0.14, 0.14, c);             // maska
    cab(m, -0.02, 0, 0.2, 0.2, 0.28, 0.2, c);
    m.box(-0.19, 0, 0.2, 0.18, 0.28, 0.1, shade(c, 0.9), { noCaps: true });                            // skrzynia
    m.light(0.29, -0.09, 0.17, 1.3); m.light(0.29, 0.09, 0.17, 1.3);
    m.anchor('front', 0.29, 0, 0.1); m.anchor('rear', -0.29, 0, 0.1);
  };
  DEF.forage_harvester = function (m, o) {
    const c = col(o, '#2e8b6e');
    m.wheel(0.14, -0.2, 0.18, 0.18, 0.1, RUBBER, RIM); m.wheel(0.14, 0.2, 0.18, 0.18, 0.1, RUBBER, RIM);
    m.wheel(-0.26, -0.15, 0.11, 0.11, 0.07, RUBBER, RIM); m.wheel(-0.26, 0.15, 0.11, 0.11, 0.07, RUBBER, RIM);
    m.box(-0.08, 0, 0.16, 0.66, 0.4, 0.34, c);
    cab(m, 0.18, 0, 0.42, 0.22, 0.3, 0.28, c);
    m.box(-0.3, 0, 0.5, 0.2, 0.3, 0.1, shade(c, 0.85));
    exhaust(m, -0.34, -0.1, 0.6, 0.14, 0.014);
    // przystawka do kukurydzy (bębnowa)
    const z = o.lowered === false ? 0.14 : 0.03;
    m.prism('y', [[0.34, z], [0.56, z], [0.56, z + 0.1], [0.34, z + 0.22]], -0.5, 0.5, shade(c, 0.9));
    for (let i = -2; i <= 2; i++) m.cyl('z', 0.5, i * 0.2, z + 0.1, 0.06, z + 0.1, z + 0.13, '#3a3a3c', 8);
    // rura wyrzutowa w lewo (−y), do góry i w bok
    const outp = o.auger === 'out' || o.auger == null;
    m.cyl('z', -0.12, -0.08, 0.5, 0.03, 0.5, 0.9, STEEL, 8);
    if (outp) { m.cyl('y', -0.12, 0, 0.9, 0.03, -0.75, -0.08, STEEL, 8); m.anchor('auger', -0.12, -0.75, 0.85); }
    else { m.cyl('x', 0, -0.08, 0.9, 0.03, -0.4, -0.12, STEEL, 8); m.anchor('auger', 0.2, -0.08, 0.9); }
    m.anchor('front', 0.56, 0, 0.1); m.anchor('rear', -0.42, 0, 0.2);
  };

  // ===================== NARZĘDZIA (zawieszane na TUZ) =====================
  // wspólna rama narzędzia zawieszanego z trójkątem zaczepu; lowered → z = 0, podniesione z = 0.1
  function frame3pt(m, len, w, color, z) {
    m.box(0, 0, z + 0.08, len, 0.04, 0.03, '#4a4c50');                       // belka główna
    m.box(len / 2 - 0.02, 0, z + 0.05, 0.03, 0.14, 0.1, shade(color, 0.8));   // wieża zaczepu
  }
  DEF.plow = function (m, o) {
    const c = col(o, '#8f2a22'), z = o.lowered ? 0 : 0.1, n = 3;
    const len = 0.46;
    // rama ukośna pługa zagonowego
    m.prism('z', [[0.22, -0.03], [-0.24, 0.16], [-0.24, 0.2], [0.22, 0.01]], z + 0.14, z + 0.17, '#4a4c50');
    m.box(0.2, 0, z + 0.06, 0.03, 0.16, 0.12, shade(c, 0.8));
    for (let i = 0; i < n; i++) {
      const x = 0.1 - i * 0.16, y = 0.02 + i * 0.07;
      m.box(x, y, z + 0.03, 0.02, 0.02, 0.13, '#4a4c50');                     // słupica
      // odkładnica (zakrzywiona blacha) + lemiesz
      m.prism('x', [[y - 0.02, z], [y + 0.09, z + 0.02], [y + 0.07, z + 0.09], [y - 0.01, z + 0.07]], x - 0.05, x + 0.03, c, { capColor: shade(c, 0.9) });
      m.box(x - 0.01, y + 0.02, z, 0.08, 0.09, 0.012, STEEL);
    }
    // koło podporowe
    m.wheel(-0.22, -0.1, z + 0.06, 0.06, 0.03, RUBBER, RIM);
    m.anchor('mount', 0.22, 0, z + 0.1);
    void len;
  };
  DEF.cultivator = function (m, o) {
    const c = col(o, '#2c6f8a'), z = o.lowered ? 0 : 0.1, W = 0.7;
    frame3pt(m, 0.3, W, c, z);
    m.box(0.05, 0, z + 0.12, 0.03, W, 0.03, c); m.box(-0.1, 0, z + 0.12, 0.03, W, 0.03, c);
    for (let i = 0; i < 7; i++) { const y = -W / 2 + 0.05 + i * (W - 0.1) / 6; m.box(0.05 - (i % 2) * 0.15, y, z + 0.01, 0.015, 0.015, 0.12, '#4a4c50'); m.box(0.05 - (i % 2) * 0.15, y, z, 0.05, 0.03, 0.012, STEEL); }
    // wał strunowy z tyłu
    m.cyl('y', -0.24, 0, z + 0.06, 0.055, -W / 2, W / 2, '#6a6c70', 10, { phase: 0.3 });
    m.anchor('mount', 0.15, 0, z + 0.1);
  };
  DEF.seeder = function (m, o) {
    const c = col(o, '#2c6f8a'), z = o.lowered ? 0 : 0.1, W = 0.74;
    frame3pt(m, 0.2, W, c, z);
    // skrzynia nasienna (trapez)
    m.prism('y', [[-0.08, z + 0.14], [0.1, z + 0.14], [0.12, z + 0.36], [-0.1, z + 0.36]], -W / 2 + 0.02, W / 2 - 0.02, c, { capColor: shade(c, 0.85) });
    m.box(0.01, 0, z + 0.36, 0.24, W - 0.02, 0.015, shade(c, 0.7));
    // redlice i rury
    for (let i = 0; i < 10; i++) { const y = -W / 2 + 0.05 + i * (W - 0.1) / 9; m.box(-0.14, y, z, 0.03, 0.012, 0.14, '#4a4c50'); }
    m.box(-0.2, 0, z + 0.02, 0.02, W - 0.04, 0.02, '#4a4c50');                 // znacznik/zagarniacz
    m.wheel(0.02, -W / 2 - 0.02, z + 0.06, 0.06, 0.03, RUBBER, RIM); m.wheel(0.02, W / 2 + 0.02, z + 0.06, 0.06, 0.03, RUBBER, RIM);
    m.anchor('mount', 0.1, 0, z + 0.1);
  };
  DEF.planter = function (m, o) {
    const c = col(o, '#2c6f8a'), z = o.lowered ? 0 : 0.1, W = 0.8, n = 6;
    m.box(0.02, 0, z + 0.14, 0.04, W, 0.05, c);
    frame3pt(m, 0.2, W, c, z);
    for (let i = 0; i < n; i++) {
      const y = -W / 2 + 0.07 + i * (W - 0.14) / (n - 1);
      m.box(-0.06, y, z + 0.1, 0.1, 0.07, 0.14, shade(c, 1.1));                // sekcja z zasobnikiem
      m.wheel(-0.1, y, z + 0.04, 0.04, 0.02, RUBBER, RIM);
      m.box(0.0, y, z, 0.02, 0.01, 0.1, '#4a4c50');
    }
    m.anchor('mount', 0.1, 0, z + 0.1);
  };
  DEF.sprayer = function (m, o) {
    const c = col(o, '#d9822b'), z = o.lowered ? 0 : 0.1, W = o.lowered ? 1.7 : 0.5;
    frame3pt(m, 0.24, 0.4, c, z);
    // zbiornik (poziomy walec) i belka
    m.cyl('x', 0, 0, z + 0.26, 0.14, -0.14, 0.12, c, 12);
    m.box(-0.18, 0, z + 0.24, 0.02, W, 0.03, '#4a4c50');
    if (o.lowered) for (let i = 0; i < 13; i++) m.box(-0.18, -W / 2 + 0.04 + i * (W - 0.08) / 12, z + 0.22, 0.012, 0.012, 0.025, STEEL);
    else { m.box(-0.14, -0.22, z + 0.26, 0.02, 0.03, 0.5, '#4a4c50'); m.box(-0.14, 0.22, z + 0.26, 0.02, 0.03, 0.5, '#4a4c50'); } // belka złożona pionowo
    m.anchor('mount', 0.12, 0, z + 0.1);
    m.anchor('spray', -0.18, 0, z + 0.2);
  };
  DEF.spreader = function (m, o) {
    const c = col(o, '#5d8f2e'), z = o.lowered ? 0 : 0.1;
    frame3pt(m, 0.2, 0.3, c, z);
    // lej (odwrócony ostrosłup ścięty)
    m.prism('z', [[-0.12, -0.16], [0.12, -0.16], [0.12, 0.16], [-0.12, 0.16]], z + 0.3, z + 0.34, c);
    m.face([[-0.12, -0.16, z + 0.3], [0.12, -0.16, z + 0.3], [0.03, -0.04, z + 0.12], [-0.03, -0.04, z + 0.12]], c);
    m.face([[0.12, -0.16, z + 0.3], [0.12, 0.16, z + 0.3], [0.03, 0.04, z + 0.12], [0.03, -0.04, z + 0.12]], c);
    m.face([[0.12, 0.16, z + 0.3], [-0.12, 0.16, z + 0.3], [-0.03, 0.04, z + 0.12], [0.03, 0.04, z + 0.12]], c);
    m.face([[-0.12, 0.16, z + 0.3], [-0.12, -0.16, z + 0.3], [-0.03, -0.04, z + 0.12], [-0.03, 0.04, z + 0.12]], c);
    m.cyl('z', 0, -0.05, z + 0.06, 0.05, z + 0.06, z + 0.075, STEEL, 10); m.cyl('z', 0, 0.05, z + 0.06, 0.05, z + 0.06, z + 0.075, STEEL, 10); // tarcze
    m.anchor('mount', 0.1, 0, z + 0.1);
  };
  DEF.mower = function (m, o) {
    const c = col(o, '#c23b6a'), z = o.lowered ? 0 : 0.1;
    frame3pt(m, 0.16, 0.3, c, z);
    // belka dyskowa wysunięta w prawo (+y) z osłoną
    const y0 = 0.1, W = 0.6;
    m.box(-0.06, y0 + W / 2, z + 0.02, 0.26, W, 0.03, '#4a4c50');
    m.prism('x', [[y0, z + 0.05], [y0 + W, z + 0.05], [y0 + W, z + 0.14], [y0 + 0.02, z + 0.18]], -0.16, 0.04, c);
    for (let i = 0; i < 5; i++) m.cyl('z', -0.06, y0 + 0.07 + i * (W - 0.14) / 4, z + 0.005, 0.05, z + 0.005, z + 0.02, STEEL, 8);
    m.anchor('mount', 0.08, 0, z + 0.1);
  };
  DEF.rake = function (m, o) {
    const c = col(o, '#c23b6a'), z = o.lowered ? 0 : 0.1;
    frame3pt(m, 0.2, 0.3, c, z);
    m.box(-0.1, 0, z + 0.16, 0.3, 0.04, 0.03, '#4a4c50');
    m.cyl('z', -0.2, 0, z + 0.15, 0.05, z + 0.15, z + 0.24, c, 8);
    for (let i = 0; i < 10; i++) { const a = i / 10 * Math.PI * 2; m.box(-0.2 + Math.cos(a) * 0.17, Math.sin(a) * 0.17, z + 0.03, 0.012, 0.012, 0.14, '#4a4c50'); m.box(-0.2 + Math.cos(a) * 0.1, Math.sin(a) * 0.1, z + 0.16, 0.16, 0.012, 0.012, c); }
    m.wheel(-0.2, -0.1, z + 0.04, 0.04, 0.025, RUBBER, RIM); m.wheel(-0.2, 0.1, z + 0.04, 0.04, 0.025, RUBBER, RIM);
    m.anchor('mount', 0.1, 0, z + 0.1);
  };

  // ===================== MASZYNY CIĄGNIONE (dyszel) =====================
  function drawbar(m, x0, x1, z) { m.box((x0 + x1) / 2, 0, z, Math.abs(x1 - x0), 0.03, 0.025, '#4a4c50'); m.anchor('mount', Math.max(x0, x1), 0, z); }
  DEF.baler = function (m, o) {
    const c = col(o, '#5b4a9b');
    m.wheel(-0.1, -0.22, 0.1, 0.1, 0.06, RUBBER, RIM); m.wheel(-0.1, 0.22, 0.1, 0.1, 0.06, RUBBER, RIM);
    // komora zwijania (walec poziomy) + podbieracz
    m.cyl('x', 0, 0, 0.3, 0.22, -0.26, 0.1, c, 14);
    m.box(-0.1, 0, 0.08, 0.36, 0.36, 0.08, shade(c, 0.9));
    m.cyl('y', 0.18, 0, 0.07, 0.06, -0.24, 0.24, '#4a4c50', 10);
    for (let i = 0; i < 6; i++) m.box(0.18, -0.2 + i * 0.08, 0.02, 0.012, 0.012, 0.09, '#d9c47a');
    drawbar(m, 0.2, 0.46, 0.08);
  };
  DEF.manure_spreader = function (m, o) {
    const c = col(o, '#7a5a3a'), fill = o.fill == null ? 0.6 : o.fill;
    m.wheel(-0.12, -0.2, 0.11, 0.11, 0.07, RUBBER, RIM); m.wheel(-0.12, 0.2, 0.11, 0.11, 0.07, RUBBER, RIM);
    m.prism('x', [[-0.16, 0.14], [0.16, 0.14], [0.19, 0.4], [-0.19, 0.4]], -0.34, 0.26, c, { noCaps: true });
    m.face([[0.26, -0.16, 0.14], [0.26, 0.16, 0.14], [0.26, 0.19, 0.4], [0.26, -0.19, 0.4]], c);
    if (fill > 0.05) m.box(-0.04, 0, 0.14, 0.58, 0.3, 0.1 + 0.16 * fill, '#4a3a25');
    // adaptery pionowe z tyłu
    m.cyl('z', -0.38, -0.08, 0.12, 0.04, 0.12, 0.46, '#4a4c50', 8); m.cyl('z', -0.38, 0.08, 0.12, 0.04, 0.12, 0.46, '#4a4c50', 8);
    m.box(0.0, 0, 0.1, 0.6, 0.08, 0.04, '#4a4c50');
    drawbar(m, 0.26, 0.5, 0.08);
  };
  DEF.tank = function (m, o) {
    const c = col(o, '#7a5a3a');
    m.wheel(-0.08, -0.22, 0.12, 0.12, 0.08, RUBBER, RIM); m.wheel(-0.08, 0.22, 0.12, 0.12, 0.08, RUBBER, RIM);
    m.cyl('x', 0, 0, 0.32, 0.2, -0.36, 0.3, mix(c, '#6a7f3a', 0.5), 14);
    m.box(0, 0, 0.1, 0.6, 0.1, 0.05, '#4a4c50');
    m.box(-0.4, 0, 0.1, 0.04, 0.5, 0.03, '#4a4c50');          // aplikator
    drawbar(m, 0.3, 0.52, 0.08);
  };
  DEF.potato_harvester = function (m, o) {
    const c = col(o, '#6b8e23');
    m.wheel(-0.14, -0.24, 0.12, 0.12, 0.07, RUBBER, RIM); m.wheel(-0.14, 0.24, 0.12, 0.12, 0.07, RUBBER, RIM);
    m.box(-0.1, 0, 0.14, 0.6, 0.44, 0.22, c);
    m.box(-0.14, 0, 0.36, 0.44, 0.4, 0.14, shade(c, 0.9), { noCaps: true });     // zbiornik
    if ((o.fill || 0) > 0.05) m.box(-0.14, 0, 0.36, 0.4, 0.36, 0.06 + 0.08 * o.fill, '#c9a86a');
    // lemiesz wybierający i przenośnik
    m.prism('y', [[0.2, 0.02], [0.34, 0.02], [0.34, 0.08], [0.2, 0.26]], -0.18, 0.18, '#4a4c50');
    m.box(-0.2, 0.3, 0.3, 0.2, 0.1, 0.06, '#4a4c50');                              // stanowiska
    drawbar(m, 0.3, 0.54, 0.08);
  };
  DEF.beet_harvester = function (m, o) {
    const c = col(o, '#8a3fa0');
    m.wheel(0.1, -0.24, 0.17, 0.17, 0.1, RUBBER, RIM); m.wheel(0.1, 0.24, 0.17, 0.17, 0.1, RUBBER, RIM);
    m.wheel(-0.3, -0.2, 0.13, 0.13, 0.08, RUBBER, RIM); m.wheel(-0.3, 0.2, 0.13, 0.13, 0.08, RUBBER, RIM);
    m.box(-0.1, 0, 0.16, 0.8, 0.48, 0.28, c);
    m.box(-0.14, 0, 0.44, 0.6, 0.46, 0.2, shade(c, 0.9), { noCaps: true });
    if ((o.fill || 0) > 0.05) m.box(-0.14, 0, 0.44, 0.56, 0.42, 0.06 + 0.12 * o.fill, '#c9b27a');
    cab(m, 0.3, 0.08, 0.3, 0.2, 0.26, 0.26, c);
    // ogławiacz i wyorywacze
    m.prism('y', [[0.42, 0.02], [0.56, 0.02], [0.56, 0.1], [0.42, 0.2]], -0.3, 0.3, '#4a4c50');
    for (let i = 0; i < 6; i++) m.box(0.5, -0.25 + i * 0.1, 0, 0.04, 0.02, 0.06, STEEL);
    m.anchor('front', 0.56, 0, 0.1); m.anchor('rear', -0.5, 0, 0.2);
  };

  // ===================== PRZYCZEPY =====================
  // axle: 'dwuosiowa' (przednia oś skrętna na obrotnicy z dyszlem) | 'jednoosiowa' | 'tandem' | 'tridem'; cap 3..30 t; fill 0..1
  DEF.trailer = function (m, o) {
    const c = col(o, '#a33a3a'), cap = Math.max(3, Math.min(30, o.cap || 6)), fill = Math.max(0, Math.min(1, o.fill || 0));
    let axle = o.axle;
    if (!axle) axle = cap <= 8 ? 'jednoosiowa' : cap <= 20 ? 'tandem' : 'tridem';
    const t = (cap - 3) / 27;                               // 0..1 wielkość
    const Lb = 0.5 + 0.5 * t, Wb = 0.32 + 0.14 * t, Hb = 0.16 + 0.2 * t, z0 = 0.2 + 0.04 * t, R = 0.09 + 0.05 * t;
    const grain = o.product || '#d9b44a';
    // podwozie
    m.box(0, 0, z0 - 0.05, Lb * 0.9, 0.1, 0.05, '#4a4c50');
    // koła
    const wy = Wb / 2 - 0.02;
    if (axle === 'jednoosiowa') { m.wheel(-0.05, -wy, R, R, 0.07, RUBBER, RIM); m.wheel(-0.05, wy, R, R, 0.07, RUBBER, RIM); }
    else if (axle === 'tandem') for (const x of [-0.02, -0.02 - R * 2.1]) { m.wheel(x + 0.1, -wy, R, R, 0.07, RUBBER, RIM); m.wheel(x + 0.1, wy, R, R, 0.07, RUBBER, RIM); }
    else if (axle === 'tridem') for (const x of [0.12, 0.12 - R * 2.1, 0.12 - R * 4.2]) { m.wheel(x, -wy, R, R, 0.07, RUBBER, RIM); m.wheel(x, wy, R, R, 0.07, RUBBER, RIM); }
    else { // dwuosiowa: tylna sztywna, przednia na obrotnicy
      const st = o.steer || 0;                              // skręt przedniej osi (rad) — rysowany osobno przez objects (opcjonalnie)
      m.wheel(-Lb * 0.34, -wy, R, R, 0.07, RUBBER, RIM); m.wheel(-Lb * 0.34, wy, R, R, 0.07, RUBBER, RIM);
      const fx = Lb * 0.34, ca = Math.cos(st), sa = Math.sin(st);
      m.wheel(fx + sa * wy, -wy * ca, R, R, 0.07, RUBBER, RIM); m.wheel(fx - sa * wy, wy * ca, R, R, 0.07, RUBBER, RIM);
      m.cyl('z', fx, 0, z0 - 0.08, 0.05, z0 - 0.08, z0 - 0.04, '#5a5c60', 8); // obrotnica
    }
    // skrzynia z burtami (żebrowane): dno + 4 burty, wnętrze ciemniejsze
    const inner = shade(c, 0.55);
    m.box(0, 0, z0, Lb, Wb, 0.02, inner);
    const bt = 0.02;
    m.box(0, -Wb / 2 + bt / 2, z0, Lb, bt, Hb, c); m.box(0, Wb / 2 - bt / 2, z0, Lb, bt, Hb, c);
    m.box(Lb / 2 - bt / 2, 0, z0, bt, Wb, Hb, c); m.box(-Lb / 2 + bt / 2, 0, z0, bt, Wb, Hb, shade(c, 0.95));
    // przetłoczenia burt (jaśniejsze listwy)
    const nr = Math.max(2, Math.round(Lb / 0.16));
    for (let i = 0; i < nr; i++) { const x = -Lb / 2 + (i + 0.5) * Lb / nr; m.box(x, -Wb / 2 - 0.004, z0 + 0.02, 0.012, 0.01, Hb - 0.04, shade(c, 1.15)); m.box(x, Wb / 2 + 0.004, z0 + 0.02, 0.012, 0.01, Hb - 0.04, shade(c, 1.15)); }
    // ładunek: kopczyk w kolorze plonu
    if (fill > 0.03) {
      const top = z0 + 0.02 + (Hb - 0.03) * Math.min(1, fill);
      m.box(0, 0, z0 + 0.02, Lb - bt * 2, Wb - bt * 2, top - z0 - 0.02, grain);
      if (fill > 0.45) m.prism('x', [[-Wb / 2 + bt, top], [0, top + 0.07 * (fill - 0.4)], [Wb / 2 - bt, top]], -Lb / 2 + bt + 0.04, Lb / 2 - bt - 0.04, shade(grain, 1.08));
    }
    // dyszel
    const hx = Lb / 2 + 0.16;
    m.box(Lb / 2 + 0.08, 0, z0 - 0.06, 0.16, 0.03, 0.025, '#4a4c50');
    m.anchor('mount', hx, 0, z0 - 0.06); m.anchor('rearHitch', -Lb / 2 - 0.03, 0, z0 - 0.06);
    m.anchor('rear', -Lb / 2, 0, z0);
    m.box(-Lb / 2, -Wb / 2 + 0.03, z0 - 0.02, 0.02, 0.03, 0.02, '#e03030'); m.box(-Lb / 2, Wb / 2 - 0.03, z0 - 0.02, 0.02, 0.03, 0.02, '#e03030');
    m.light(-Lb / 2 - 0.01, -Wb / 2 + 0.03, z0, 1, '#ff5040'); m.light(-Lb / 2 - 0.01, Wb / 2 - 0.03, z0, 1, '#ff5040');
  };

  // ===================== BUDYNKI =====================
  // Budynki budowane w układzie: x ∈ [−w/2, w/2], y ∈ [−h/2, h/2] (kafle), z w górę; rot=1 → objects rysuje pod kątem π/2.
  const BRICK = '#c7a98a', PLASTER = '#e7dcc6', ROOF_RED = '#a8442f', ROOF_GREY = '#6e7378', ROOF_TIN = '#8a9299', CONCRETE = '#b9b6ae', TIMBER = '#7a5a36';
  function dims(o, dw, dh) { const s = o.size || [dw, dh]; return { w: s[0], h: s[1] }; }
  function lvl(o) { return Math.max(1, o.level || 1); }
  // rząd okien na ścianie x+ (front) lub y+
  function windows(m, side, pos, z, n, wW, wH, span, color) {
    // side 'x+': ściana przy x = pos, okna rozłożone wzdłuż y na długości span; 'y+': przy y = pos, rozłożone wzdłuż x; 'x-' / 'y-' analogicznie
    for (let i = 0; i < n; i++) {
      const t = -span / 2 + (i + 0.5) * span / n;
      let pts;
      if (side === 'x+') pts = [[pos + 0.004, t - wW / 2, z], [pos + 0.004, t + wW / 2, z], [pos + 0.004, t + wW / 2, z + wH], [pos + 0.004, t - wW / 2, z + wH]];
      else if (side === 'x-') pts = [[pos - 0.004, t - wW / 2, z], [pos - 0.004, t + wW / 2, z], [pos - 0.004, t + wW / 2, z + wH], [pos - 0.004, t - wW / 2, z + wH]];
      else if (side === 'y+') pts = [[t - wW / 2, pos + 0.004, z], [t + wW / 2, pos + 0.004, z], [t + wW / 2, pos + 0.004, z + wH], [t - wW / 2, pos + 0.004, z + wH]];
      else pts = [[t - wW / 2, pos - 0.004, z], [t + wW / 2, pos - 0.004, z], [t + wW / 2, pos - 0.004, z + wH], [t - wW / 2, pos - 0.004, z + wH]];
      m.face(pts, color || GLASS_N, { twoSided: true, bias: 0.01 });
      const c = pts.reduce((a, p) => [a[0] + p[0] / 4, a[1] + p[1] / 4, a[2] + p[2] / 4], [0, 0, 0]);
      m.light(c[0], c[1], c[2], 2.2, '#ffd27a');
    }
  }
  function door(m, side, pos, t, z, w, h, color) {
    let pts;
    if (side === 'x+') pts = [[pos + 0.005, t - w / 2, z], [pos + 0.005, t + w / 2, z], [pos + 0.005, t + w / 2, z + h], [pos + 0.005, t - w / 2, z + h]];
    else pts = [[t - w / 2, pos + 0.005, z], [t + w / 2, pos + 0.005, z], [t + w / 2, pos + 0.005, z + h], [t - w / 2, pos + 0.005, z + h]];
    m.face(pts, color || TIMBER, { twoSided: true, bias: 0.01 });
  }
  // rusztowanie / budowa: fundament, słupy, deski — progress 0..1 pokazuje rosnące ściany
  function construction(m, w, h, fullH, progress, color) {
    m.box(0, 0, 0, w, h, 0.04, CONCRETE);
    const zh = Math.max(0.05, fullH * progress);
    m.box(0, 0, 0.04, w * 0.96, h * 0.96, zh, mix(color, '#b9b6ae', 0.5), { alpha: 0.9 });
    const posts = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
    for (const p of posts) m.box(p[0] * 1.08, p[1] * 1.08, 0, 0.03, 0.03, fullH + 0.15, '#c9a35a');
    for (let k = 1; k <= 3; k++) {
      const z = (fullH + 0.1) * k / 3;
      m.box(0, -h / 2 * 1.08, z, w * 1.08, 0.015, 0.015, '#c9a35a'); m.box(0, h / 2 * 1.08, z, w * 1.08, 0.015, 0.015, '#c9a35a');
      m.box(-w / 2 * 1.08, 0, z, 0.015, h * 1.08, 0.015, '#c9a35a'); m.box(w / 2 * 1.08, 0, z, 0.015, h * 1.08, 0.015, '#c9a35a');
    }
    // sterta materiału obok
    m.box(w / 2 * 0.6, h / 2 * 0.9 + 0.02, 0, 0.2, 0.12, 0.08, '#b55a3a');
    // dźwig / żuraw mały gdy duży budynek
    if (w * h >= 4) { m.box(-w / 2 + 0.2, h / 2 - 0.1, 0, 0.1, 0.1, 0.1, '#e0b020'); m.cyl('z', -w / 2 + 0.2, h / 2 - 0.1, 0.1, 0.02, 0.1, fullH + 0.6, '#e0b020', 6); m.box(-w / 2 + 0.2 + 0.3, h / 2 - 0.1, fullH + 0.55, 0.7, 0.03, 0.03, '#e0b020'); }
  }
  function withConstruction(fn) {
    return function (m, o) {
      if (o.progress != null && o.progress < 1) {
        const d = dims(o, 1, 1);
        construction(m, d.w * 0.9, d.h * 0.9, 0.6, o.progress, o.color || '#c7a98a');
        return;
      }
      fn(m, o);
    };
  }
  DEF.house = withConstruction(function (m, o) {
    const d = dims(o, 2, 2), L = lvl(o), wall = col(o, PLASTER);
    const w = d.w * 0.74, h = d.h * 0.62, H = 0.5 + 0.1 * (L - 1);
    m.box(0, 0, 0, w + 0.06, h + 0.06, 0.05, CONCRETE);                          // podmurówka
    m.box(0, 0, 0.05, w, h, H, wall);
    m.gable(0, 0, H + 0.05, w, h, 0.38 + 0.05 * (L - 1), ROOF_RED, 0.08);
    // komin
    m.box(-w * 0.2, h * 0.1, H + 0.05 + 0.2, 0.08, 0.08, 0.35, '#8a5a40');
    m.anchor('chimney', -w * 0.2, h * 0.1, H + 0.6);
    windows(m, 'x+', w / 2, 0.22, 2, 0.14, 0.18, h * 0.8); windows(m, 'y+', h / 2, 0.22, L >= 2 ? 3 : 2, 0.14, 0.18, w * 0.8);
    door(m, 'y+', h / 2, w * 0.3, 0.05, 0.14, 0.3, TIMBER);
    if (L >= 2) { // ganek
      m.box(w * 0.3, h / 2 + 0.12, 0.05, 0.3, 0.24, 0.02, CONCRETE);
      m.gable(w * 0.3, h / 2 + 0.1, 0.4, 0.3, 0.24, 0.1, ROOF_RED, 0.03);
      for (const y of [-0.1, 0.1]) m.cyl('z', w * 0.3 + y, h / 2 + 0.2, 0.07, 0.015, 0.07, 0.4, '#e8e4dc', 6);
    }
    if (L >= 3) { m.box(-w * 0.35, -h * 0.5 - 0.2, 0, 0.5, 0.36, 0.02, '#7f9a4f'); for (let i = 0; i < 3; i++) m.cyl('z', -w * 0.35 - 0.15 + i * 0.15, -h * 0.5 - 0.2, 0.02, 0.06, 0.1, 0.22, '#4f8a3a', 7); } // ogród
    // płot od frontu
    for (let i = 0; i <= 6; i++) m.box(-w / 2 + i * w / 6, h / 2 + 0.3, 0, 0.02, 0.02, 0.1, '#d8d0c0');
    m.box(0, h / 2 + 0.3, 0.06, w, 0.01, 0.015, '#d8d0c0');
  });
  DEF.barn = withConstruction(function (m, o) {
    const d = dims(o, 3, 2), L = lvl(o), wall = col(o, '#8b5a2b');
    const w = d.w * 0.84, h = d.h * 0.72, H = 0.55 + 0.1 * (L - 1);
    m.box(0, 0, 0, w + 0.04, h + 0.04, 0.04, CONCRETE);
    m.box(0, 0, 0.04, w, h, H, wall);
    // deskowanie: pionowe jaśniejsze listwy
    for (let i = 0; i < 12; i++) m.box(-w / 2 + (i + 0.5) * w / 12, h / 2 + 0.003, 0.04, 0.012, 0.004, H, shade(wall, 1.15));
    for (let i = 0; i < 7; i++) m.box(w / 2 + 0.003, -h / 2 + (i + 0.5) * h / 7, 0.04, 0.004, 0.012, H, shade(wall, 1.15));
    m.gable(0, 0, H + 0.04, w, h, 0.45, L >= 2 ? ROOF_TIN : ROOF_GREY, 0.1);
    // duże wrota przesuwne (front x+)
    door(m, 'x+', w / 2, 0, 0.04, h * 0.42, H * 0.8, shade(wall, 0.6));
    m.box(w / 2 + 0.01, 0, 0.04 + H * 0.8, 0.02, h * 0.5, 0.03, '#4a4c50');
    door(m, 'y+', h / 2, -w * 0.3, 0.04, 0.3, H * 0.6, shade(wall, 0.65));
    windows(m, 'y+', h / 2, H * 0.55, 2, 0.12, 0.1, w * 0.5);
    if (L >= 3) { m.box(-w / 2 - 0.3, 0, 0, 0.5, h * 0.8, 0.04, CONCRETE); m.box(-w / 2 - 0.3, 0, 0.04, 0.46, h * 0.76, 0.3, shade(wall, 0.9)); m.prism('x', [[-h * 0.4, 0.34], [-h * 0.4 - 0.05, 0.34], [0, 0.5], [h * 0.4 + 0.05, 0.34], [h * 0.4, 0.34]], -w / 2 - 0.56, -w / 2 - 0.04, ROOF_TIN); }
    m.anchor('door', w / 2 + 0.1, 0, 0);
  });
  DEF.garage = withConstruction(function (m, o) {
    const d = dims(o, 2, 1), L = lvl(o), wall = col(o, '#7a7f87');
    const w = d.w * 0.86, h = d.h * 0.8, H = 0.36 + 0.06 * (L - 1);
    m.box(0, 0, 0, w, h, 0.03, CONCRETE);
    // wiata: otwarty front (x+), tył i boki z blachy; słupy
    m.box(-0.0, -h / 2 + 0.02, 0.03, w, 0.04, H, wall); m.box(0, h / 2 - 0.02, 0.03, w, 0.04, H, wall);
    m.box(-w / 2 + 0.02, 0, 0.03, 0.04, h, H, wall);
    for (let i = 0; i <= 3; i++) m.box(w / 2 - 0.02, -h / 2 + i * h / 3, 0.03, 0.04, 0.04, H, '#4a4c50');
    if (L >= 2) { m.box(w / 2 - 0.02, 0, 0.03 + H * 0.65, 0.04, h, H * 0.35, wall); }   // brama częściowo
    // dach pulpitowy (jednospadowy) z blachy falistej
    m.prism('y', [[-w / 2 - 0.06, H + 0.03], [w / 2 + 0.06, H + 0.03 + 0.12], [w / 2 + 0.06, H + 0.06 + 0.12], [-w / 2 - 0.06, H + 0.06]], -h / 2 - 0.06, h / 2 + 0.06, ROOF_TIN);
    for (let i = 0; i < 8; i++) m.box(-w / 2 + (i + 0.5) * w / 8, 0, H + 0.085 + 0.06 * (i + 0.5) / 8 * 2, 0.01, h + 0.1, 0.004, shade(ROOF_TIN, 1.12));
    // wnętrze ciemne
    m.box(-0.05, 0, 0.03, w - 0.14, h - 0.1, 0.004, '#4f5156');
    m.light(w / 2 - 0.04, 0, H + 0.02, 2.2, '#ffe8b0');
    if (L >= 3) m.box(0, -h / 2 - 0.2, 0, w * 0.8, 0.3, 0.03, CONCRETE);
  });
  DEF.henhouse = withConstruction(function (m, o) {
    const L = lvl(o), wall = col(o, '#c8a165');
    const w = 0.5 + 0.08 * (L - 1), h = 0.42 + 0.06 * (L - 1), H = 0.26 + 0.03 * L;
    // na nóżkach
    for (const p of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) m.box(p[0] * (w / 2 - 0.04), p[1] * (h / 2 - 0.04), 0, 0.03, 0.03, 0.08, TIMBER);
    m.box(0, 0, 0.08, w, h, H, wall);
    for (let i = 0; i < 6; i++) m.box(-w / 2 + (i + 0.5) * w / 6, h / 2 + 0.003, 0.08, 0.01, 0.004, H, shade(wall, 1.12));
    m.gable(0, 0, 0.08 + H, w, h, 0.2, ROOF_RED, 0.06);
    // otwór i rampa
    door(m, 'y+', h / 2, w * 0.15, 0.1, 0.1, 0.12, '#3a2a18');
    m.prism('x', [[h / 2, 0.1], [h / 2 + 0.22, 0], [h / 2 + 0.22, 0.012], [h / 2, 0.112]], w * 0.15 - 0.05, w * 0.15 + 0.05, TIMBER);
    windows(m, 'x+', w / 2, 0.16, 1, 0.1, 0.1, h * 0.5);
    // wybieg: siatka na słupkach
    const fw = 0.9, fh = 0.9;
    for (let i = 0; i <= 4; i++) { m.box(-fw / 2 + i * fw / 4, fh / 2, 0, 0.015, 0.015, 0.16, '#8a8a8e'); m.box(-fw / 2 + i * fw / 4, -fh / 2, 0, 0.015, 0.015, 0.16, '#8a8a8e'); }
    m.box(0, fh / 2, 0.14, fw, 0.004, 0.01, '#9a9a9e'); m.box(0, -fh / 2, 0.14, fw, 0.004, 0.01, '#9a9a9e');
    m.box(fw / 2, 0, 0.14, 0.004, fh, 0.01, '#9a9a9e'); m.box(-fw / 2, 0, 0.14, 0.004, fh, 0.01, '#9a9a9e');
  });
  // długi budynek inwentarski z wentylacją kalenicową i dużymi wrotami
  function livestock(m, o, dw, dh, wallDef, roof, opts) {
    const d = dims(o, dw, dh), L = lvl(o), wall = col(o, wallDef);
    const w = d.w * 0.86, h = d.h * 0.78, H = 0.42 + 0.06 * (L - 1);
    m.box(0, 0, 0, w + 0.04, h + 0.04, 0.04, CONCRETE);
    m.box(0, 0, 0.04, w, h, H, wall);
    m.box(0, 0, 0.04, w + 0.01, h + 0.01, 0.12, shade(wall, 0.75));         // cokół
    m.gable(0, 0, H + 0.04, w, h, 0.3, roof, 0.1);
    // wywietrznik kalenicowy
    m.box(0, 0, H + 0.04 + 0.3, w * 0.6, 0.08, 0.06, shade(roof, 0.8));
    if (opts && opts.silo) { m.cyl('z', -w / 2 - 0.12, -h / 2 + 0.1, 0.2, 0.08, 0.2, 0.75, '#d4d8db', 10); m.prism('z', [[-w / 2 - 0.2, -h / 2 + 0.02], [-w / 2 - 0.04, -h / 2 + 0.02], [-w / 2 - 0.04, -h / 2 + 0.18], [-w / 2 - 0.2, -h / 2 + 0.18]], 0.75, 0.88, '#c4c8cc'); for (const p of [[-0.19, 0.03], [-0.05, 0.03], [-0.19, 0.17], [-0.05, 0.17]]) m.cyl('z', -w / 2 + p[0], -h / 2 + p[1], 0, 0.01, 0, 0.2, '#8a8a8e', 5); }
    windows(m, 'y+', h / 2, 0.2, Math.max(2, Math.round(w * 2)), 0.1, 0.09, w * 0.85, '#dfe9ee');
    windows(m, 'x+', w / 2, 0.2, Math.max(1, Math.round(h * 1.5)), 0.1, 0.09, h * 0.7, '#dfe9ee');
    door(m, 'x+', w / 2, 0, 0.04, Math.min(0.35, h * 0.4), H * 0.75, shade(wall, 0.55));
    if (opts && opts.fence) { // ogrodzenie wybiegu
      const fw = w + 0.5, fh = h + 0.6;
      for (let i = 0; i <= 6; i++) for (const s of [-1, 1]) m.box(-fw / 2 + i * fw / 6, s * fh / 2, 0, 0.02, 0.02, 0.12, TIMBER);
      for (const s of [-1, 1]) { m.box(0, s * fh / 2, 0.06, fw, 0.012, 0.012, TIMBER); m.box(0, s * fh / 2, 0.1, fw, 0.012, 0.012, TIMBER); }
    }
    m.anchor('door', w / 2 + 0.1, 0, 0);
  }
  DEF.cowshed = withConstruction((m, o) => livestock(m, o, 3, 2, '#b9a58a', ROOF_TIN, { silo: true, fence: true }));
  DEF.pigsty = withConstruction((m, o) => livestock(m, o, 2, 2, '#d7b9a0', ROOF_GREY, { silo: true }));
  DEF.sheepfold = withConstruction((m, o) => livestock(m, o, 2, 1, '#a68a64', ROOF_RED, { fence: true }));
  DEF.stable = withConstruction(function (m, o) {
    livestock(m, o, 2, 1, '#9c6b3f', ROOF_RED, { fence: true });
    // boksy z półdrzwiami
    const d = dims(o, 2, 1), w = d.w * 0.86, h = d.h * 0.78;
    for (let i = 0; i < 3; i++) door(m, 'y+', h / 2, -w / 2 + (i + 0.5) * w / 3, 0.04, 0.16, 0.2, '#5a3a20');
  });
  // silosy: 'hopper' — smukły lejowy na nogach z blachy falistej, stożkowy dach, drabinka; 'flat' — szeroki niski na fundamencie; 'feed' — mały paszowy
  DEF.silo = withConstruction(function (m, o) {
    const v = o.variant || 'hopper', L = lvl(o), c = col(o, '#c9cdd1');
    if (v === 'flat') {
      const d = dims(o, 2, 2), r = Math.min(d.w, d.h) * 0.42, H = 0.7 + 0.15 * (L - 1);
      m.cyl('z', 0, 0, 0, r + 0.08, 0, 0.06, CONCRETE, 20);
      m.cyl('z', 0, 0, 0.06, r, 0.06, 0.06 + H, c, 20);
      for (let k = 1; k < 4; k++) m.cyl('z', 0, 0, 0.06 + H * k / 4, r + 0.004, 0.06 + H * k / 4, 0.06 + H * k / 4 + 0.012, shade(c, 0.8), 20);  // pierścienie
      // stożkowy dach niski
      const top = 0.06 + H;
      for (let i = 0; i < 20; i++) { const a0 = i / 20 * Math.PI * 2, a1 = (i + 1) / 20 * Math.PI * 2; m.face([[Math.cos(a0) * (r + 0.02), Math.sin(a0) * (r + 0.02), top], [Math.cos(a1) * (r + 0.02), Math.sin(a1) * (r + 0.02), top], [0, 0, top + r * 0.45]], shade(c, 1.02)); }
      m.cyl('z', 0, 0, top + r * 0.45, 0.04, top + r * 0.45, top + r * 0.45 + 0.08, '#8a8a8e', 8);
      // drabinka i podnośnik kubełkowy
      m.box(r + 0.02, 0, 0.06, 0.02, 0.06, H, '#6a6c70');
      m.box(r + 0.25, 0.15, 0, 0.1, 0.1, top + r * 0.5 + 0.1, '#9aa0a6');
      m.box(r + 0.12, 0.08, top + r * 0.45, 0.26, 0.03, 0.03, '#8a8a8e');
      if (L >= 2) { m.box(0.3, -r - 0.3, 0, 0.5, 0.3, 0.3, '#9aa0a6'); }  // wentylator/suszarnia
      m.anchor('top', 0, 0, top + r * 0.45);
    } else if (v === 'feed') {
      const r = 0.14 + 0.02 * (L - 1), H = 0.42 + 0.06 * (L - 1), z0 = 0.3;
      for (let i = 0; i < 4; i++) { const a = i / 4 * Math.PI * 2 + Math.PI / 4; m.cyl('z', Math.cos(a) * r * 0.85, Math.sin(a) * r * 0.85, 0, 0.01, 0, z0 + 0.1, '#8a8a8e', 5); }
      for (let i = 0; i < 12; i++) { const a0 = i / 12 * Math.PI * 2, a1 = (i + 1) / 12 * Math.PI * 2; m.face([[Math.cos(a0) * r, Math.sin(a0) * r, z0], [Math.cos(a1) * r, Math.sin(a1) * r, z0], [Math.cos(a1) * 0.03, Math.sin(a1) * 0.03, 0.08], [Math.cos(a0) * 0.03, Math.sin(a0) * 0.03, 0.08]], shade(c, 0.95)); }
      m.cyl('z', 0, 0, z0, r, z0, z0 + H, c, 12);
      for (let i = 0; i < 12; i++) { const a0 = i / 12 * Math.PI * 2, a1 = (i + 1) / 12 * Math.PI * 2; m.face([[Math.cos(a0) * (r + 0.01), Math.sin(a0) * (r + 0.01), z0 + H], [Math.cos(a1) * (r + 0.01), Math.sin(a1) * (r + 0.01), z0 + H], [0, 0, z0 + H + r * 0.8]], shade(c, 1.03)); }
      m.box(r + 0.03, 0, z0 + H * 0.3, 0.01, 0.04, H * 0.7, '#8a8a8e');
      m.cyl('x', 0, 0, 0.06, 0.02, 0, 0.3, STEEL, 6);  // rura podajnika
      m.anchor('top', 0, 0, z0 + H + r * 0.8);
    } else { // hopper
      const n = Math.min(1, (L - 1) / 4), r = 0.24 + 0.08 * n, H = 0.9 + 0.5 * n, z0 = 0.34;
      m.box(0, 0, 0, r * 2.2, r * 2.2, 0.03, CONCRETE);
      // nogi
      for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2 + 0.3; m.cyl('z', Math.cos(a) * r * 0.9, Math.sin(a) * r * 0.9, 0.03, 0.014, 0.03, z0 + 0.12, '#7a7c80', 5); }
      // lej
      for (let i = 0; i < 16; i++) { const a0 = i / 16 * Math.PI * 2, a1 = (i + 1) / 16 * Math.PI * 2; m.face([[Math.cos(a0) * r, Math.sin(a0) * r, z0], [Math.cos(a1) * r, Math.sin(a1) * r, z0], [Math.cos(a1) * 0.05, Math.sin(a1) * 0.05, 0.1], [Math.cos(a0) * 0.05, Math.sin(a0) * 0.05, 0.1]], shade(c, 0.92)); }
      // płaszcz z blachy falistej: pierścienie
      m.cyl('z', 0, 0, z0, r, z0, z0 + H, c, 16);
      const rings = 4 + Math.round(n * 3);
      for (let k = 1; k < rings; k++) m.cyl('z', 0, 0, z0 + H * k / rings, r + 0.005, z0 + H * k / rings, z0 + H * k / rings + 0.012, shade(c, 0.78), 16);
      // pionowe usztywnienia
      for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2; m.box(Math.cos(a) * (r + 0.006), Math.sin(a) * (r + 0.006), z0, 0.012, 0.012, H, shade(c, 0.85)); }
      // stożkowy dach
      const top = z0 + H;
      for (let i = 0; i < 16; i++) { const a0 = i / 16 * Math.PI * 2, a1 = (i + 1) / 16 * Math.PI * 2; m.face([[Math.cos(a0) * (r + 0.03), Math.sin(a0) * (r + 0.03), top], [Math.cos(a1) * (r + 0.03), Math.sin(a1) * (r + 0.03), top], [0, 0, top + r * 0.75]], shade(c, 1.04)); }
      m.cyl('z', 0, 0, top + r * 0.75, 0.035, top + r * 0.75, top + r * 0.75 + 0.07, '#8a8a8e', 8);
      // drabinka z koszem i rura załadowcza
      m.box(r + 0.025, 0, z0 - 0.2, 0.012, 0.05, H + 0.3, '#6a6c70');
      for (let k = 0; k < 8; k++) m.box(r + 0.025, 0, z0 - 0.15 + k * (H + 0.2) / 8, 0.02, 0.05, 0.006, '#8a8a8e');
      m.cyl('z', -r - 0.06, -0.1, 0, 0.025, 0, top + r * 0.7, STEEL, 6);
      m.anchor('top', 0, 0, top + r * 0.75);
      m.anchor('fill', r + 0.12, 0, 0);
    }
  });
  DEF.granary = withConstruction(function (m, o) {
    const d = dims(o, 3, 2), L = lvl(o), wall = col(o, '#9aa0a6');
    const w = d.w * 0.88, h = d.h * 0.8, H = 0.5 + 0.08 * (L - 1);
    m.box(0, 0, 0, w + 0.04, h + 0.04, 0.05, CONCRETE);
    m.box(0, 0, 0.05, w, h, H, wall);
    for (let i = 0; i < 14; i++) m.box(-w / 2 + (i + 0.5) * w / 14, h / 2 + 0.003, 0.05, 0.004, 0.004, H, shade(wall, 1.1));
    m.gable(0, 0, H + 0.05, w, h, 0.28, ROOF_TIN, 0.1);
    door(m, 'x+', w / 2, 0, 0.05, h * 0.4, H * 0.85, '#5a6066');
    door(m, 'y+', h / 2, -w * 0.25, 0.05, 0.5, H * 0.85, '#5a6066');
    windows(m, 'y+', h / 2, H * 0.6, 3, 0.1, 0.08, w * 0.5, '#dfe9ee');
    if (L >= 2) { m.cyl('z', -w / 2 - 0.18, h / 2 - 0.2, 0, 0.1, 0, H + 0.6, '#c9cdd1', 12); m.box(-w / 2 - 0.18, h / 2 - 0.2, H + 0.6, 0.2, 0.2, 0.08, '#8a8a8e'); }
    m.anchor('door', w / 2 + 0.1, 0, 0);
  });
  DEF.hayshed = withConstruction(function (m, o) {
    const d = dims(o, 2, 1), L = lvl(o), c = col(o, '#a0703c');
    const w = d.w * 0.86, h = d.h * 0.84, H = 0.5 + 0.06 * (L - 1);
    m.box(0, 0, 0, w, h, 0.03, CONCRETE);
    for (let i = 0; i <= 3; i++) for (const s of [-1, 1]) m.box(-w / 2 + 0.03 + i * (w - 0.06) / 3, s * (h / 2 - 0.03), 0.03, 0.04, 0.04, H, '#6a6c70');
    // bele w środku (okrągłe)
    const nb = Math.min(6, 2 + L * 2);
    for (let i = 0; i < nb; i++) { const x = -w / 2 + 0.16 + (i % 3) * 0.26, y = (i < 3 ? -0.12 : 0.12); m.cyl('y', x, y, 0.15, 0.12, y - 0.1, y + 0.1, '#d9b85a', 10); }
    if (L >= 2) for (let i = 0; i < 3; i++) m.cyl('y', -w / 2 + 0.29 + i * 0.26, 0, 0.39, 0.12, -0.1, 0.1, '#d9b85a', 10);
    m.gable(0, 0, H + 0.03, w, h, 0.22, ROOF_TIN, 0.1);
  });
  DEF.silage_clamp = withConstruction(function (m, o) {
    const d = dims(o, 2, 1), fill = o.fill == null ? 0.8 : o.fill;
    const w = d.w * 0.9, h = d.h * 0.86;
    m.box(0, 0, 0, w, h, 0.03, CONCRETE);
    // ściany boczne (żelbetowe, lekko pochylone) — otwarte od x+
    for (const s of [-1, 1]) m.prism('x', [[s * (h / 2 - 0.05), 0.03], [s * h / 2, 0.03], [s * h / 2, 0.28], [s * (h / 2 - 0.03), 0.28]], -w / 2, w / 2, shade(CONCRETE, 0.9));
    m.box(-w / 2 + 0.03, 0, 0.03, 0.06, h, 0.28, shade(CONCRETE, 0.9));
    if (fill > 0.05) {
      // pryzma pod czarną folią, z przodu pochyła; opony na folii
      const len = w * 0.9 * fill, top = 0.26;
      m.prism('x', [[-h / 2 + 0.05, 0.03], [h / 2 - 0.05, 0.03], [h / 2 - 0.08, top], [-h / 2 + 0.08, top]], -w / 2 + 0.06, -w / 2 + 0.06 + len - 0.25, '#2a2c30');
      m.prism('y', [[-w / 2 + 0.06 + len - 0.25, 0.03], [-w / 2 + 0.06 + len, 0.03], [-w / 2 + 0.06 + len - 0.25, top]], -h / 2 + 0.06, h / 2 - 0.06, '#2a2c30');
      for (let i = 0; i < 10; i++) { const x = -w / 2 + 0.12 + (i % 5) * (len - 0.4) / 4, y = -h / 2 + 0.14 + Math.floor(i / 5) * (h - 0.3); m.cyl('z', x, y, top, 0.045, top, top + 0.015, '#111214', 8); }
      // odkryta ściana kiszonki od frontu (zielonkawo-brązowa)
      m.face([[-w / 2 + 0.06 + len, -h / 2 + 0.06, 0.03], [-w / 2 + 0.06 + len, h / 2 - 0.06, 0.03], [-w / 2 + 0.06 + len - 0.25, h / 2 - 0.08, top], [-w / 2 + 0.06 + len - 0.25, -h / 2 + 0.08, top]], '#7a7a3a', { bias: 0.02, twoSided: true });
    }
  });
  DEF.manure_pad = withConstruction(function (m, o) {
    const d = dims(o, 2, 1), fill = o.fill == null ? 0.6 : o.fill;
    const w = d.w * 0.9, h = d.h * 0.86;
    m.box(0, 0, 0, w, h, 0.04, CONCRETE);
    // płyta z murkiem z trzech stron + pryzma obornika
    for (const s of [-1, 1]) m.box(-0.2, s * (h / 2 - 0.02), 0.04, w * 0.55, 0.04, 0.12, shade(CONCRETE, 0.9));
    m.box(-w / 2 + 0.02, 0, 0.04, 0.04, h, 0.12, shade(CONCRETE, 0.9));
    if (fill > 0.05) { const L = w * 0.5 * fill; m.prism('y', [[-w / 2 + 0.06, 0.04], [-w / 2 + 0.06 + L, 0.04], [-w / 2 + 0.06 + L * 0.6, 0.04 + 0.16 * fill + 0.04], [-w / 2 + 0.06 + 0.02, 0.04 + 0.1]], -h / 2 + 0.08, h / 2 - 0.08, '#4a3620'); }
    // zbiornik na gnojowicę (okrągły, betonowy)
    const r = Math.min(0.2, h * 0.26);
    m.cyl('z', w / 2 - r - 0.04, 0, 0.04, r, 0.04, 0.3, '#8d8d8a', 14);
    m.cyl('z', w / 2 - r - 0.04, 0, 0.3, r - 0.02, 0.3, 0.31, '#3a2e22', 14);
  });
  DEF.workshop = withConstruction(function (m, o) {
    const L = lvl(o), wall = col(o, '#8a8f7a');
    const w = 0.74, h = 0.7, H = 0.38 + 0.05 * (L - 1);
    m.box(0, 0, 0, w + 0.04, h + 0.04, 0.03, CONCRETE);
    m.box(0, 0, 0.03, w, h, H, wall);
    // dach dwuspadowy niski z blachy, komin warsztatu
    m.gable(0, 0, H + 0.03, w, h, 0.18, ROOF_GREY, 0.06);
    m.cyl('z', -0.2, -0.15, H + 0.1, 0.025, H + 0.1, H + 0.42, '#5a5c60', 6);
    m.anchor('chimney', -0.2, -0.15, H + 0.42);
    door(m, 'x+', w / 2, 0.05, 0.03, 0.3, H * 0.85, '#4a5a6a');
    windows(m, 'y+', h / 2, H * 0.45, 2, 0.12, 0.12, w * 0.7);
    // beczki i kompresor przed warsztatem
    m.cyl('z', w / 2 + 0.12, -0.2, 0, 0.04, 0, 0.1, '#2f5f9e', 8); m.cyl('z', w / 2 + 0.2, -0.24, 0, 0.04, 0, 0.1, '#c94a3a', 8);
    if (L >= 2) m.box(-w / 2 - 0.1, 0.2, 0, 0.14, 0.2, 0.2, '#6a6c70');
  });
  DEF.fuel_station = withConstruction(function (m, o) {
    const L = lvl(o), c = col(o, '#c94a3a');
    // zbiornik ON na podporach (poziomy walec) + dystrybutor + daszek
    const len = 0.5 + 0.1 * (L - 1), r = 0.14 + 0.02 * (L - 1);
    m.box(0, 0, 0, 0.8, 0.6, 0.03, CONCRETE);
    for (const x of [-len / 2 + 0.08, len / 2 - 0.08]) m.box(x, -0.08, 0.03, 0.06, 0.26, 0.1, '#6a6c70');
    m.cyl('x', 0, -0.08, 0.13 + r, r, -len / 2, len / 2, '#3f8f3f', 14);
    m.box(0, -0.08, 0.13 + 2 * r, 0.1, 0.1, 0.05, '#2a2c2f');
    // dystrybutor
    m.box(0.1, 0.2, 0.03, 0.08, 0.06, 0.22, c);
    m.box(0.1, 0.2, 0.17, 0.085, 0.065, 0.04, '#eaeaea');
    // daszek na słupkach
    for (const p of [[-0.3, 0.1], [0.3, 0.1], [-0.3, 0.3], [0.3, 0.3]]) m.cyl('z', p[0], p[1], 0.03, 0.012, 0.03, 0.45, '#8a8a8e', 5);
    m.box(0, 0.2, 0.45, 0.7, 0.3, 0.03, shade(c, 0.9));
    m.light(0, 0.2, 0.44, 2.4, '#fff4d0');
  });
  DEF.greenhouse = withConstruction(function (m, o) {
    const d = dims(o, 2, 1), L = lvl(o);
    const w = d.w * 0.9, h = d.h * 0.8, H = 0.22;
    m.box(0, 0, 0, w, h, 0.02, CONCRETE);
    // tunel foliowy: półkolisty przekrój wzdłuż x, półprzezroczysta folia
    const poly = []; const segs = 10;
    for (let i = 0; i <= segs; i++) { const a = Math.PI * i / segs; poly.push([Math.cos(a) * h / 2, 0.02 + Math.sin(a) * (H + h * 0.2)]); }
    m.box(0, 0, 0.02, w - 0.05, h - 0.05, 0.06, '#5f8a3a');  // zieleń w środku
    for (let i = 0; i < 3; i++) m.box(-w / 2 + 0.1 + i * 0.3, 0, 0.08, 0.2, h * 0.7, 0.06, L >= 2 ? '#c94a3a' : '#6aa040');
    m.prism('x', poly, -w / 2, w / 2, '#d7eef0', { alpha: 0.62, capColor: '#e8f4f6' });
    for (let i = 0; i <= 6; i++) { const x = -w / 2 + i * w / 6; m.prism('x', poly.map(p => [p[0] * 1.01, p[1] * 1.01]), x - 0.006, x + 0.006, '#8a9aa0', { noCaps: true }); }
    m.light(0, 0, H, 2, '#ffe0f0');
  });
  DEF.biogas = withConstruction(function (m, o) {
    const d = dims(o, 3, 3), L = lvl(o), c = col(o, '#5f7d5a');
    const w = d.w * 0.9, h = d.h * 0.9;
    m.box(0, 0, 0, w, h, 0.04, CONCRETE);
    // dwa fermentory z kopułami membranowymi
    for (const p of [[-0.6, -0.5], [0.4, -0.5]]) {
      m.cyl('z', p[0], p[1], 0.04, 0.5, 0.04, 0.5, c, 18);
      for (let i = 0; i < 18; i++) { const a0 = i / 18 * Math.PI * 2, a1 = (i + 1) / 18 * Math.PI * 2; m.face([[p[0] + Math.cos(a0) * 0.5, p[1] + Math.sin(a0) * 0.5, 0.5], [p[0] + Math.cos(a1) * 0.5, p[1] + Math.sin(a1) * 0.5, 0.5], [p[0] + Math.cos(a1) * 0.3, p[1] + Math.sin(a1) * 0.3, 0.78], [p[0] + Math.cos(a0) * 0.3, p[1] + Math.sin(a0) * 0.3, 0.78]], '#dfe3e6'); }
      m.cyl('z', p[0], p[1], 0.78, 0.3, 0.78, 0.84, '#e8ebee', 18);
    }
    // kontener agregatu + komin + zbiornik
    m.box(0.2, 0.7, 0.04, 0.8, 0.4, 0.3, '#8a9299'); m.cyl('z', 0.5, 0.7, 0.34, 0.03, 0.34, 0.9, '#5a5c60', 6);
    m.anchor('chimney', 0.5, 0.7, 0.9);
    m.box(-0.8, 0.7, 0.04, 0.5, 0.4, 0.25, '#4f5a60');
    windows(m, 'y+', 0.9, 0.12, 2, 0.1, 0.1, 0.6);
    if (L >= 2) m.cyl('z', 1.0, 0.1, 0.04, 0.22, 0.04, 0.4, '#8d8d8a', 14);
  });
  DEF.apiary = withConstruction(function (m, o) {
    const L = lvl(o), n = Math.min(8, 2 + L * 2);
    m.box(0, 0, 0, 0.9, 0.9, 0.01, '#7f9a4f');
    const cols = ['#e3b341', '#4a8ad0', '#d05a4a', '#6aa84f', '#e9e4d8'];
    for (let i = 0; i < n; i++) {
      const x = -0.3 + (i % 4) * 0.2, y = -0.2 + Math.floor(i / 4) * 0.4, c = cols[i % cols.length];
      m.box(x, y, 0, 0.1, 0.1, 0.03, TIMBER);
      m.box(x, y, 0.03, 0.12, 0.12, 0.14, c);
      m.box(x, y, 0.17, 0.14, 0.14, 0.03, '#8a8a8e');
    }
    // drzewo owocowe obok
    m.cyl('z', 0.38, -0.36, 0, 0.02, 0, 0.2, TIMBER, 6);
    m.cyl('z', 0.38, -0.36, 0.2, 0.12, 0.2, 0.36, '#4f8a3a', 10);
  });

  // ===================== ZWIERZĘTA =====================
  // anim: 'walk' | 'eat' | 'idle' | 'fly'; frame 0..3; young → mniejsze; color → kolor sierści
  function legs(m, bx, by, bz, lx, ly, r, len, color, frame, walk) {
    const sw = walk ? Math.sin(frame / 4 * Math.PI * 2) * len * 0.35 : 0;
    const pts = [[lx, -ly, sw], [lx, ly, -sw], [-lx, -ly, -sw], [-lx, ly, sw]];
    for (const p of pts) m.box(bx + p[0] + p[2] * 0.5, by + p[1], 0, r, r, bz + 0.005, color);
  }
  function quadruped(m, o, spec) {
    const s = (o.scale || 1) * (o.young ? 0.62 : 1), c = col(o, spec.color);
    const L = spec.len * s, W = spec.w * s, Hl = spec.legH * s, Hb = spec.bodyH * s;
    const eat = o.anim === 'eat', walk = o.anim === 'walk', fr = o.frame || 0;
    legs(m, 0, 0, Hl, L * 0.32, W * 0.32, 0.028 * s, Hl, shade(c, 0.85), fr, walk);
    // tułów (ośmiokątny przekrój)
    const poly = []; for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2; poly.push([Math.cos(a) * W / 2, Hl + Hb / 2 + Math.sin(a) * Hb / 2]); }
    m.prism('x', poly, -L / 2, L / 2, c);
    if (spec.spots) for (let i = 0; i < 3; i++) m.box(-L * 0.3 + i * L * 0.3, (i % 2 ? 1 : -1) * (W / 2 - 0.004), Hl + Hb * 0.3 + (i % 2) * Hb * 0.2, L * 0.16, 0.012, Hb * 0.35, spec.spots);
    // szyja + głowa
    const hz = eat ? Hl * 0.25 : Hl + Hb * 0.75, hx = L / 2 + spec.headLen * s * 0.6;
    m.prism('x', [[-W * 0.28, Hl + Hb * 0.45], [W * 0.28, Hl + Hb * 0.45], [W * 0.25, eat ? hz + 0.02 : Hl + Hb * 1.05], [-W * 0.25, eat ? hz + 0.02 : Hl + Hb * 1.05]], L / 2 - 0.02, L / 2 + spec.headLen * s * 0.3, c);
    m.box(hx, 0, hz, spec.headLen * s * 0.7, W * 0.5, spec.headH * s, spec.headColor || c);
    if (spec.horns) { m.box(hx - 0.02, -W * 0.3, hz + spec.headH * s, 0.012, 0.012, 0.03 * s, '#e8dcc0'); m.box(hx - 0.02, W * 0.3, hz + spec.headH * s, 0.012, 0.012, 0.03 * s, '#e8dcc0'); }
    if (spec.ears) { m.box(hx - 0.02, -W * 0.36, hz + spec.headH * s * 0.6, 0.01, 0.03 * s, 0.01, shade(c, 0.9)); m.box(hx - 0.02, W * 0.36, hz + spec.headH * s * 0.6, 0.01, 0.03 * s, 0.01, shade(c, 0.9)); }
    if (spec.udder && !o.young) m.box(-L * 0.25, 0, Hl - 0.02 * s, L * 0.2, W * 0.5, 0.03 * s, '#e8b7b0');
    // ogon
    m.box(-L / 2 - 0.005, 0, Hl + Hb * 0.5, 0.01, 0.012, Hb * 0.5, shade(c, 0.9));
    if (spec.mane) m.box(L * 0.2, 0, Hl + Hb, L * 0.5, 0.012, 0.04 * s, spec.mane);
  }
  DEF.cow = (m, o) => quadruped(m, o, { len: 0.3, w: 0.13, legH: 0.1, bodyH: 0.13, headLen: 0.1, headH: 0.06, color: '#f1ece2', spots: o.color ? null : '#2b2520', horns: true, ears: true, udder: true });
  DEF.calf = (m, o) => quadruped(m, Object.assign({}, o, { young: true }), { len: 0.3, w: 0.13, legH: 0.1, bodyH: 0.13, headLen: 0.1, headH: 0.06, color: '#d9c7a8', spots: '#f1ece2', ears: true });
  DEF.pig = (m, o) => quadruped(m, o, { len: 0.2, w: 0.1, legH: 0.045, bodyH: 0.1, headLen: 0.07, headH: 0.05, color: '#f0b8aa', ears: true });
  DEF.sheep = (m, o) => quadruped(m, o, { len: 0.17, w: 0.1, legH: 0.05, bodyH: 0.1, headLen: 0.06, headH: 0.04, color: '#efe9db', headColor: '#2a2622' });
  DEF.goat = (m, o) => quadruped(m, o, { len: 0.17, w: 0.08, legH: 0.07, bodyH: 0.08, headLen: 0.07, headH: 0.04, color: '#d9d2c4', horns: true });
  DEF.horse = (m, o) => quadruped(m, o, { len: 0.32, w: 0.12, legH: 0.14, bodyH: 0.13, headLen: 0.12, headH: 0.06, color: '#6b4426', mane: '#2a1a10', ears: true });
  DEF.hen = function (m, o) {
    const s = (o.scale || 1) * (o.young ? 0.6 : 1), c = col(o, '#d9b27a');
    const eat = o.anim === 'eat', fr = o.frame || 0, walk = o.anim === 'walk';
    const lz = 0.035 * s;
    for (const y of [-0.012, 0.012]) m.box((walk ? Math.sin(fr * 1.6 + (y > 0 ? 3 : 0)) * 0.01 : 0), y * s, 0, 0.006, 0.006, lz, '#e0a040');
    const poly = []; for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2; poly.push([Math.cos(a) * 0.04 * s, lz + 0.035 * s + Math.sin(a) * 0.03 * s]); }
    m.prism('x', poly, -0.04 * s, 0.03 * s, c);
    m.box(0.045 * s, 0, eat ? lz + 0.01 * s : lz + 0.07 * s, 0.03 * s, 0.025 * s, 0.025 * s, shade(c, 1.05));  // głowa
    m.box(0.06 * s, 0, eat ? lz + 0.015 * s : lz + 0.075 * s, 0.015 * s, 0.008 * s, 0.008 * s, '#e0a040');     // dziób
    m.box(0.045 * s, 0, eat ? lz + 0.035 * s : lz + 0.095 * s, 0.02 * s, 0.006 * s, 0.012 * s, '#d8302a');      // grzebień
    m.prism('y', [[-0.04 * s, lz + 0.045 * s], [-0.07 * s, lz + 0.09 * s], [-0.05 * s, lz + 0.09 * s]], -0.004, 0.004, shade(c, 0.6)); // ogon
  };
  DEF.bee = function (m) {
    m.box(0, 0, 0.3, 0.02, 0.012, 0.012, '#e3b341');
    m.box(0, 0, 0.312, 0.02, 0.03, 0.002, '#ffffff', { alpha: 0.7 });
  };

  // ===================== DOMKI WE WSI, DRZEWA (dla terenu) =====================
  DEF.cottage = function (m, o) {
    const seed = o.seed || 0, kinds = ['#e7dcc6', '#d9c9a5', '#c7a98a', '#e3e0d6', '#cfd6cf'], roofs = [ROOF_RED, ROOF_GREY, '#7a4a32', '#5c6670'];
    const wall = kinds[seed % kinds.length], roof = roofs[(seed >> 2) % roofs.length];
    const w = 0.52 + (seed % 3) * 0.06, h = 0.4 + ((seed >> 1) % 3) * 0.05, H = 0.3 + ((seed >> 3) % 2) * 0.08;
    m.box(0, 0, 0, w + 0.04, h + 0.04, 0.03, CONCRETE);
    m.box(0, 0, 0.03, w, h, H, wall);
    m.gable(0, 0, H + 0.03, w, h, 0.26, roof, 0.06);
    m.box(-w * 0.25, 0, H + 0.2, 0.06, 0.06, 0.2, '#8a5a40');
    m.anchor('chimney', -w * 0.25, 0, H + 0.4);
    windows(m, 'x+', w / 2, 0.12, 1, 0.1, 0.12, h * 0.6); windows(m, 'y+', h / 2, 0.12, 2, 0.1, 0.12, w * 0.7);
    door(m, 'y+', h / 2, w * 0.3, 0.03, 0.1, 0.2, TIMBER);
    if (seed & 1) { // szopa obok
      m.box(w / 2 + 0.16, -h * 0.2, 0, 0.2, 0.2, 0.16, shade(TIMBER, 1.1));
      m.prism('y', [[w / 2 + 0.04, 0.16], [w / 2 + 0.28, 0.16], [w / 2 + 0.28, 0.19], [w / 2 + 0.04, 0.24]], -h * 0.2 - 0.12, -h * 0.2 + 0.12, ROOF_GREY);
    }
    // płotek
    for (let i = 0; i <= 5; i++) m.box(-w / 2 + i * w / 5, h / 2 + 0.22, 0, 0.015, 0.015, 0.08, '#d8d0c0');
    m.box(0, h / 2 + 0.22, 0.05, w, 0.008, 0.012, '#d8d0c0');
  };
  DEF.chapel = function (m) {
    m.box(0, 0, 0, 0.3, 0.3, 0.03, CONCRETE); m.box(0, 0, 0.03, 0.2, 0.2, 0.3, '#f0ece2');
    m.gable(0, 0, 0.33, 0.2, 0.2, 0.14, ROOF_GREY, 0.03); m.box(0, 0, 0.47, 0.012, 0.012, 0.1, '#5a5c60'); m.box(0, 0, 0.53, 0.012, 0.05, 0.012, '#5a5c60');
  };

  // nieznany klucz → estetyczna bryła w kolorze
  DEF.unknown = function (m, o) {
    const c = col(o, '#9a8fb0'), d = dims(o, 1, 1);
    const w = d.w * 0.7, h = d.h * 0.7;
    m.box(0, 0, 0, w, h, 0.35, c);
    m.gable(0, 0, 0.35, w, h, 0.2, shade(c, 0.75), 0.05);
  };
})();
