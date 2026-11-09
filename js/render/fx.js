// Złote Pola — efekty cząsteczkowe (agent: grafika) → G.fx
//
// Cząsteczki żyją w układzie świata (kafle, z w górę) i są rzutowane jak obiekty, dzięki czemu kurz za pługiem,
// dym z komina czy strumień ziarna „trzymają się” mapy przy przesuwaniu kamery. Opady (deszcz, śnieg) są w układzie ekranu.
//
// API:
//   G.fx.burst(x, y, kind, opts)      — seria cząsteczek w kaflu (x, y); kind: 'dust'|'smoke'|'exhaust'|'grain'|'leaf'|'bird'|'insect'|'spray'|'spark'|'splash'|'steam'
//   G.fx.emit(kind, x, y, z, opts)    — jedna cząsteczka; opts: { vx, vy, vz, color, size, life, target:{x,y,z} }
//   G.fx.update(dt), G.fx.draw(ctx)   — woła render.js;  G.fx.ambient(dt) — ptaki, owady, liście zależnie od pory roku
//   G.fx.precip(ctx, dt)              — deszcz / śnieg / mgła na ekranie;  G.fx.count()
(function () {
  const FX = G.fx = {};
  const ISO = G.iso;
  const MAX = 900;
  let P = [];            // cząsteczki świata
  let drops = [];        // opady (ekran)
  let fog = null;
  const rnd = (a, b) => a + Math.random() * (b - a);

  const KIND = {
    dust: { life: [1.0, 1.8], size: [3, 6], grow: 4, color: 'rgba(170,140,100,0.55)', rise: 0.02, drag: 0.9, alpha: 0.55 },
    smoke: { life: [2.5, 4], size: [3, 5], grow: 3.5, color: 'rgba(120,120,130,0.4)', rise: 0.06, drag: 0.98, alpha: 0.4 },
    exhaust: { life: [0.6, 1.1], size: [1.5, 2.5], grow: 3, color: 'rgba(60,60,65,0.5)', rise: 0.08, drag: 0.95, alpha: 0.5 },
    steam: { life: [1, 1.6], size: [2, 3], grow: 3, color: 'rgba(230,230,235,0.5)', rise: 0.07, drag: 0.96, alpha: 0.5 },
    grain: { life: [0.5, 0.7], size: [1.2, 1.8], grow: 0, color: '#e2bf55', gravity: 2.4, drag: 1, alpha: 1 },
    grainDust: { life: [0.8, 1.4], size: [2, 4], grow: 3, color: 'rgba(220,200,140,0.45)', rise: 0.03, drag: 0.92, alpha: 0.45 },
    spray: { life: [0.6, 1.0], size: [2, 3], grow: 3, color: 'rgba(235,240,245,0.5)', rise: -0.02, drag: 0.9, alpha: 0.5 },
    leaf: { life: [3, 5], size: [1.6, 2.4], grow: 0, color: '#d08a3a', gravity: 0.12, drag: 0.995, alpha: 1, sway: 1 },
    bird: { life: [9, 14], size: [2.2, 3], grow: 0, color: '#2a2a2e', gravity: 0, drag: 1, alpha: 1, bird: 1 },
    insect: { life: [2, 4], size: [0.9, 1.3], grow: 0, color: 'rgba(255,250,200,0.9)', gravity: 0, drag: 1, alpha: 1, jitter: 1 },
    spark: { life: [0.3, 0.6], size: [1, 1.5], grow: 0, color: '#ffd060', gravity: 1.5, drag: 0.98, alpha: 1 },
    splash: { life: [0.3, 0.5], size: [1, 2], grow: 2, color: 'rgba(200,220,255,0.6)', gravity: 1.2, drag: 1, alpha: 0.6 },
    straw: { life: [0.8, 1.4], size: [1.2, 2], grow: 0, color: '#d9b85a', gravity: 1.2, drag: 0.97, alpha: 1 },
    hay: { life: [0.8, 1.4], size: [1.2, 2], grow: 0, color: '#9bb04a', gravity: 1.2, drag: 0.97, alpha: 1 }
  };
  function wind() { const w = G.weather ? (G.weather.wind || 2) : 2; return w * 0.012; } // kafle/s, wiatr wieje w +x (na ekran: w prawo-dół)

  FX.emit = function (kind, x, y, z, o) {
    if (P.length >= MAX) P.shift();
    const k = KIND[kind] || KIND.dust; o = o || {};
    P.push({
      k, kind, x, y, z: z || 0, vx: o.vx || 0, vy: o.vy || 0, vz: o.vz || 0, t: 0, life: o.life || rnd(k.life[0], k.life[1]),
      size: o.size || rnd(k.size[0], k.size[1]), color: o.color || k.color, ph: Math.random() * 6.28, target: o.target || null, floor: o.floor != null ? o.floor : 0
    });
  };
  // seria: kurz po kołach, dym, ptaki itp.
  FX.burst = function (x, y, kind, opts) {
    opts = opts || {};
    const n = opts.n || (kind === 'dust' ? 6 : kind === 'bird' ? 5 : 4), w = wind();
    for (let i = 0; i < n; i++) {
      switch (kind) {
        case 'dust': FX.emit('dust', x + rnd(-0.08, 0.08), y + rnd(-0.08, 0.08), 0.02, { vx: rnd(-0.05, 0.05) + w, vy: rnd(-0.05, 0.05), vz: rnd(0.05, 0.15) }); break;
        case 'smoke': FX.emit('smoke', x, y, opts.z || 0.6, { vx: w + rnd(-0.01, 0.01), vy: rnd(-0.01, 0.01), vz: rnd(0.1, 0.16) }); break;
        case 'exhaust': FX.emit('exhaust', x, y, opts.z || 0.5, { vx: w * 0.5 + rnd(-0.02, 0.02), vy: rnd(-0.02, 0.02), vz: rnd(0.15, 0.3), color: opts.color }); break;
        case 'bird': FX.emit('bird', x + i * 0.12 + rnd(-0.05, 0.05), y + (i % 2) * 0.1 + rnd(-0.05, 0.05), 1.6 + rnd(-0.1, 0.1), { vx: opts.vx != null ? opts.vx : 0.9, vy: opts.vy != null ? opts.vy : -0.6 }); break;
        case 'leaf': FX.emit('leaf', x + rnd(-0.3, 0.3), y + rnd(-0.3, 0.3), rnd(0.5, 0.9), { vx: w * 2 + rnd(-0.05, 0.05), vy: rnd(-0.05, 0.05), color: ['#d08a3a', '#c9b44a', '#b55a2a'][i % 3] }); break;
        case 'insect': FX.emit('insect', x + rnd(-0.3, 0.3), y + rnd(-0.3, 0.3), rnd(0.05, 0.25), { vx: rnd(-0.05, 0.05), vy: rnd(-0.05, 0.05) }); break;
        case 'spray': FX.emit('spray', x + rnd(-0.1, 0.1), y + rnd(-0.1, 0.1), opts.z || 0.15, { vx: w + rnd(-0.03, 0.03), vy: rnd(-0.03, 0.03), vz: rnd(-0.05, 0.02) }); break;
        case 'grain': FX.emit('grain', x, y, opts.z || 0.6, { vx: (opts.vx || 0) + rnd(-0.03, 0.03), vy: (opts.vy || 0) + rnd(-0.03, 0.03), vz: rnd(-0.05, 0.05), floor: opts.floor }); break;
        case 'spark': FX.emit('spark', x, y, opts.z || 0.2, { vx: rnd(-0.15, 0.15), vy: rnd(-0.15, 0.15), vz: rnd(0.2, 0.5) }); break;
        case 'splash': FX.emit('splash', x + rnd(-0.1, 0.1), y + rnd(-0.1, 0.1), 0.02, { vz: rnd(0.1, 0.25) }); break;
        case 'straw': case 'hay': FX.emit(kind, x + rnd(-0.1, 0.1), y + rnd(-0.1, 0.1), opts.z || 0.2, { vx: rnd(-0.1, 0.1) + w, vy: rnd(-0.1, 0.1), vz: rnd(0.1, 0.3) }); break;
        case 'steam': FX.emit('steam', x, y, opts.z || 0.3, { vx: w, vz: rnd(0.08, 0.15) }); break;
        default: FX.emit(kind, x, y, opts.z || 0, opts);
      }
    }
  };
  FX.count = () => P.length;
  FX.clear = function () { P = []; drops = []; };

  FX.update = function (dt) {
    if (dt <= 0) return;
    const keep = [];
    for (const p of P) {
      p.t += dt;
      if (p.t >= p.life) continue;
      const k = p.k;
      if (k.gravity) p.vz -= k.gravity * dt;
      if (k.rise) p.vz += k.rise * dt;
      if (k.drag !== 1) { const d = Math.pow(k.drag, dt * 60); p.vx *= d; p.vy *= d; p.vz *= d; }
      if (k.sway) { p.vx += Math.sin(p.t * 3 + p.ph) * 0.1 * dt; p.vy += Math.cos(p.t * 2.3 + p.ph) * 0.1 * dt; }
      if (k.jitter) { p.vx += rnd(-0.6, 0.6) * dt; p.vy += rnd(-0.6, 0.6) * dt; p.vz += (0.15 - p.z) * dt + rnd(-0.3, 0.3) * dt; }
      if (k.bird) { p.vz += Math.sin(p.t * 1.7 + p.ph) * 0.05 * dt; }
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      if (p.z < p.floor && (k.gravity || p.kind === 'leaf')) { if (p.kind === 'grain' || p.kind === 'leaf' || p.kind === 'straw' || p.kind === 'hay') { p.z = p.floor; p.vx = p.vy = p.vz = 0; if (p.kind === 'leaf') p.life = Math.min(p.life, p.t + 1.2); else continue; } else continue; }
      keep.push(p);
    }
    P = keep;
  };

  FX.draw = function (ctx) {
    const cam = G.cam, z = cam.zoom;
    const vr = ISO.visibleRange(2);
    for (const p of P) {
      if (p.x < vr.x0 - 1 || p.x > vr.x1 + 2 || p.y < vr.y0 - 1 || p.y > vr.y1 + 2) continue;
      const w = ISO.toWorld(p.x, p.y);
      const sx = (w.x - cam.x) * z, sy = (w.y - p.z * G.sprites.ZS - cam.y) * z;
      const k = p.k, u = p.t / p.life;
      const size = (p.size + k.grow * u) * z;
      if (k.bird) {
        // ptak: „V” machające skrzydłami
        const fl = Math.sin(p.t * 9 + p.ph) * 0.5;
        ctx.strokeStyle = p.color; ctx.lineWidth = Math.max(0.8, 1.1 * z); ctx.beginPath();
        ctx.moveTo(sx - size, sy - fl * size); ctx.lineTo(sx, sy + size * 0.3); ctx.lineTo(sx + size, sy - fl * size); ctx.stroke();
        continue;
      }
      let alpha = k.alpha;
      if (k.grow) alpha *= u < 0.15 ? u / 0.15 : (1 - u);
      else if (u > 0.75) alpha *= (1 - u) / 0.25;
      ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
      ctx.fillStyle = p.color;
      ctx.beginPath();
      if (p.kind === 'leaf') { ctx.save(); ctx.translate(sx, sy); ctx.rotate(p.t * 2 + p.ph); ctx.ellipse(0, 0, size, size * 0.5, 0, 0, 7); ctx.restore(); }
      else if (p.kind === 'grain' || p.kind === 'straw' || p.kind === 'hay' || p.kind === 'spark') ctx.rect(sx - size / 2, sy - size / 2, size, size);
      else ctx.arc(sx, sy, size, 0, 7);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  };

  // ---------- efekty tła zależne od pory roku ----------
  let ambT = 0;
  FX.ambient = function (dt, dark) {
    ambT += dt;
    if (ambT < 0.25) return;
    ambT = 0;
    if (!G.S) return;
    const d = G.date(), m = G.cm(d), vr = ISO.visibleRange(0), S = G.S, T = G.T;
    const wt = G.weather && G.weather.type;
    const area = (vr.x1 - vr.x0 + 1) * (vr.y1 - vr.y0 + 1);
    if (area <= 0) return;
    const pick = () => { const x = vr.x0 + Math.random() * (vr.x1 - vr.x0 + 1), y = vr.y0 + Math.random() * (vr.y1 - vr.y0 + 1); return { x, y, i: G.idx(Math.min(G.CFG.W - 1, x | 0), Math.min(G.CFG.H - 1, y | 0)) }; };
    // ptaki: stado co jakiś czas (nie w nocy, nie w ulewie)
    if (!dark && wt !== 'storm' && wt !== 'snow' && Math.random() < 0.05 * Math.min(1, area / 400)) { const p = pick(); FX.burst(p.x, p.y + 3, 'bird', { n: 3 + (Math.random() * 4 | 0), vx: 0.7 + Math.random() * 0.4, vy: -0.7 }); }
    // owady latem nad łąkami/trawą
    if (!dark && m >= 4 && m <= 8 && wt !== 'rain' && wt !== 'storm') for (let k = 0; k < 3; k++) { const p = pick(); const t = S.map.t[p.i]; if (t === T.MEADOW || t === T.GRASS) FX.burst(p.x, p.y, 'insect', { n: 1 }); }
    // liście jesienią przy lasach
    if (m >= 8 && m <= 10) for (let k = 0; k < 4; k++) { const p = pick(); if (S.map.t[p.i] === T.FOREST || S.map.t[p.i] === T.VILLAGE) FX.burst(p.x, p.y, 'leaf', { n: 1 }); }
  };

  // ---------- opady na ekranie ----------
  FX.precip = function (ctx, dt, light) {
    const w = G.weather, cam = G.cam;
    const type = w ? w.type : 'clear', inten = w ? (w.intensity || 0) : 0, wind = w ? (w.wind || 2) : 2;
    const vw = cam.vw, vh = cam.vh;
    const want = type === 'rain' ? Math.round(60 + 200 * inten) : type === 'storm' ? Math.round(200 + 220 * inten) : type === 'snow' ? Math.round(80 + 160 * inten) : 0;
    const isSnow = type === 'snow';
    while (drops.length < want) drops.push({ x: Math.random() * (vw + 100) - 50, y: Math.random() * vh, s: 0.6 + Math.random() * 0.8, ph: Math.random() * 7 });
    if (drops.length > want) drops.length = Math.max(want, Math.round(drops.length * 0.9));
    if (drops.length) {
      const speed = isSnow ? 60 : 900 + 300 * inten, dx = isSnow ? wind * 8 : wind * 25;
      ctx.save();
      ctx.strokeStyle = 'rgba(200,220,245,' + (0.25 + 0.3 * inten) + ')'; ctx.lineWidth = 1.1; ctx.lineCap = 'round';
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.beginPath();
      for (const d of drops) {
        const sp = speed * d.s;
        d.y += sp * dt; d.x += dx * d.s * dt + (isSnow ? Math.sin(d.y * 0.02 + d.ph) * 20 * dt : 0);
        if (d.y > vh + 10) { d.y = -10 - Math.random() * 40; d.x = Math.random() * (vw + 100) - 50; }
        if (d.x > vw + 50) d.x -= vw + 100;
        if (isSnow) { ctx.moveTo(d.x + 1.5 * d.s, d.y); ctx.arc(d.x, d.y, 1.1 + d.s * 0.9, 0, 7); }
        else { const len = 7 + 9 * d.s * (0.6 + inten); ctx.moveTo(d.x, d.y); ctx.lineTo(d.x - dx * len / speed * 2, d.y - len); }
      }
      if (isSnow) ctx.fill(); else ctx.stroke();
      ctx.restore();
    }
    // mgła: miękkie smugi
    if (type === 'fog') {
      fog = fog || { t: 0 };
      fog.t += dt;
      ctx.save();
      ctx.fillStyle = 'rgba(225,230,236,' + (0.28 + 0.2 * inten) + ')'; ctx.fillRect(0, 0, vw, vh);
      ctx.globalAlpha = 0.22;
      for (let k = 0; k < 4; k++) {
        const y = ((k * 0.27 + fog.t * 0.01 * (k + 1)) % 1) * vh, x = ((fog.t * (8 + k * 3)) % (vw + 400)) - 200;
        const g = ctx.createRadialGradient(x, y, 0, x, y, vw * 0.5);
        g.addColorStop(0, 'rgba(240,243,247,0.9)'); g.addColorStop(1, 'rgba(240,243,247,0)');
        ctx.fillStyle = g; ctx.fillRect(0, 0, vw, vh);
      }
      ctx.restore();
    }
  };
})();
