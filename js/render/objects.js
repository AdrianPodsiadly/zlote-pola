// Złote Pola — budynki, pojazdy, zwierzęta — sortowanie głębi, cienie, światła (agent: grafika) → G.objects
//
// Co klatkę objects.js zbiera z symulacji wszystko, co stoi na mapie (G.S.buildings, G.jobs.vehicles(), G.animals.sprites(),
// podgląd stawiania z G.view.place), składa zestawy pojazdów („pociągi”: ciągnik + narzędzie / 1–2 przyczepy) i sortuje
// wszystko malarsko po głębokości (x + y środka). Rysowanie sprite'ów: G.sprites (buforowane bryły 3D).
//
// Zestawy: narzędzia zawieszane (pług, siewnik, opryskiwacz…) wiszą sztywno na zaczepie ciągnika; przyczepy i maszyny
// ciągane (z kotwicą 'pivot') jadą po śladzie poprzednika — kinematyka dyszla (punkt zaczepu ciągnie oś przyczepy),
// a przyczepa dwuosiowa ma dodatkowo przednią oś skrętną na obrotnicy (dwa ogniwa: dyszel → obrotnica → oś tylna).
// Stan zestawów trzymamy per pojazd (uid albo zlecenie + jednostka), więc przyczepy płynnie „zawijają” za ciągnikiem.
//
// API (dla render.js):
//   G.objects.update(now, dt)      — zbiera obiekty, liczy zestawy, emituje efekty (kurz, spaliny, ziarno, dym z kominów)
//   G.objects.drawGround(ctx)      — pod obiektami: pierścienie zaznaczenia, obrys budynku, cienie
//   G.objects.draw(ctx)            — bryły posortowane po głębi + strumień ziarna
//   G.objects.drawMarkers(ctx, now) — nad wszystkim (po nocnym przyciemnieniu): ikonki, cele, etykiety
//   G.objects.lights(dark)         — [{ x, y (ekran), r, c, beam? }] światła okien i reflektorów do nocnej poświaty
//   G.objects.list()               — ostatnio zebrane obiekty (diagnostyka); G.objects.trainOf(uid) — pozycje części zestawu
(function () {
  const ISO = G.iso, SP = G.sprites, ZS = SP.ZS;
  const OB = G.objects = {};
  let items = [];            // obiekty do rysowania w tej klatce
  let vehs = [];             // pojazdy (do znaczników)
  let streams = [];          // strumienie ziarna z rur wyładowczych
  let shadowAlpha = 0.3;
  const trains = new Map();  // klucz pojazdu → { parts: [stan części], x, y, seen, moving, emitT }

  const hsh = (a, b) => { let h = (a * 374761393 + b * 668265263) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
  const wrap = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
  function scr(x, y, z) {
    const c = G.cam, w = ISO.toWorld(x, y);
    return { x: (w.x - c.x) * c.zoom, y: (w.y - (z || 0) * ZS - c.y) * c.zoom };
  }
  // obrót wektora modelu (kafle) o kąt a
  const rotv = (x, y, a) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
  function onScreen(x, y, m) {
    const p = scr(x, y), c = G.cam, mm = (m || 140) * c.zoom;
    return p.x > -mm && p.x < c.vw + mm && p.y > -mm && p.y < c.vh + mm * 1.6;
  }

  // ---------- pora dnia ----------
  function hourNow() { const d = G.date(); return d.hour + (G.hourFrac || 0); }

  // ===================== BUDYNKI =====================
  function collectBuildings(now) {
    const S = G.S, L = S.buildings || [];
    const h = hourNow(), day = G.date().dayIndex;
    const snowy = !!(G.weather && G.weather.snow >= 1);
    for (const b of L) {
      const T = G.BUILDINGS[b.type];
      if (!T) continue;
      const f = G.buildings && G.buildings.footprint ? G.buildings.footprint(b) : { x: b.x, y: b.y, w: T.size[0], h: T.size[1] };
      const cx = f.x + f.w / 2, cy = f.y + f.h / 2;
      if (!onScreen(cx, cy, 120 + 40 * Math.max(f.w, f.h))) continue;
      const opts = { size: T.size, level: b.level || 1, color: T.color, variant: T.variant, exactAngle: true, snow: snowy };
      if (b.progress != null && b.progress < 1) opts.progress = b.progress;
      if (b.upg != null) opts.upg = b.upg;
      const ang = b.rot ? Math.PI / 2 : 0;
      items.push({ t: 'b', key: T.model || 'unknown', ang, opts, x: cx, y: cy, depth: cx + cy, b, f,
        lit: buildingLit(T.model, b.uid, h, day) });
    }
  }
  // czy okna budynku świecą o tej godzinie
  function buildingLit(model, uid, h, day) {
    switch (model) {
      case 'house': return (h >= 16.5 && h < 23.2 && hsh(uid, day) < 0.9) || (h >= 5 && h < 7.2);
      case 'cowshed': case 'pigsty': case 'sheepfold': case 'stable': return (h >= 4.5 && h < 7.5) || (h >= 16.5 && h < 20.5);
      case 'henhouse': return h >= 5 && h < 8;
      case 'garage': case 'fuel_station': case 'workshop': case 'greenhouse': return true;
      case 'biogas': return true;
      default: return h >= 17 && h < 21 && hsh(uid, day + 7) < 0.5;
    }
  }

  // ===================== ZWIERZĘTA =====================
  function collectAnimals(now) {
    if (!(G.animals && G.animals.sprites)) return;
    let list;
    try { list = G.animals.sprites() || []; } catch (e) { return; }
    for (let k = 0; k < list.length; k++) {
      const a = list[k];
      if (!onScreen(a.x, a.y, 40)) continue;
      const walk = a.anim === 'walk';
      const frame = walk ? Math.floor(now / 140 + k * 1.7) % 4 : (a.anim === 'eat' ? Math.floor(now / 900 + k) % 2 : 0);
      const opts = { anim: walk ? 'walk' : a.anim === 'eat' ? (frame ? 'eat' : 'idle') : 'idle', frame: walk ? frame : 0, color: a.color, scale: (a.scale || 1) * (a.model === 'hen' ? 1.35 : 1), young: !!a.young };
      if (a.model === 'bee') {
        items.push({ t: 'bee', x: a.x, y: a.y, depth: a.x + a.y + 0.5, ph: k });
        continue;
      }
      items.push({ t: 'a', key: a.model || 'unknown', ang: a.angle != null ? a.angle : (a.dir || 0) * Math.PI / 4, opts, x: a.x, y: a.y, depth: a.x + a.y, small: true });
    }
  }

  // ===================== POJAZDY I ZESTAWY =====================
  const isTrailerLike = (key, opts) => !!SP.anchors(key, opts).pivot;
  function partOpts(p, v, idx) {
    const o = { color: p.color };
    if (p.model === 'trailer') { o.cap = p.cap || 6; o.axle = p.axle || null; o.fill = p.fill || 0; }
    if (p.fill != null && p.model !== 'trailer') o.fill = p.fill;
    if (idx === 0) {
      if (p.model === 'combine' || p.model === 'forage_harvester' || p.model === 'potato_harvester' || p.model === 'beet_harvester') { o.fill = v.fill || 0; o.auger = v.auger || 'in'; }
    } else if (p.model !== 'trailer') {
      o.lowered = p.lowered != null ? !!(p.lowered || (v.working && p.model === 'header')) : p.model === 'header' ? !!(v.working || v.lowered) : !!(v.lowered || v.working);
    }
    return o;
  }
  // klucz zestawu (własne maszyny po uid, obce po zleceniu i kolejności)
  function vehKey(v, n) { return v.uid != null ? 'm' + v.uid : 'j' + v.jobUid + ':' + v.unit + ':' + n; }

  function collectVehicles(now, dt) {
    if (!(G.jobs && G.jobs.vehicles)) return;
    let list;
    try { list = G.jobs.vehicles() || []; } catch (e) { console.error('[objects] vehicles', e); return; }
    const perJob = {};
    const sel = G.view && G.view.selVehicle, selSet = new Set(Array.isArray(sel) ? sel : sel != null ? [sel] : []);
    const fx = G.fx;
    for (const v of list) {
      if (!v || v.inGarage || !v.parts || !v.parts.length || v.x == null) continue;
      const jk = v.jobUid + ':' + v.unit; perJob[jk] = (perJob[jk] || 0) + 1;
      const key = vehKey(v, perJob[jk]);
      let tr = trains.get(key);
      if (!tr) { tr = { parts: [], x: v.x, y: v.y, a: v.angle || 0, seen: now, moving: false, emitT: Math.random(), speed: 0 }; trains.set(key, tr); }
      const jump = Math.hypot(v.x - tr.x, v.y - tr.y);
      const spd = dt > 0 ? jump / dt : 0;
      tr.speed = tr.speed * 0.85 + spd * 0.15;
      tr.moving = tr.speed > 0.02;
      if (jump > 2) tr.parts = [];                       // teleport (parkowanie, wczytanie) — ustaw zestaw w linii
      tr.x = v.x; tr.y = v.y; tr.a = v.angle || 0; tr.seen = now;
      const selected = (v.uid != null && selSet.has(v.uid));
      const vis = onScreen(v.x, v.y, 220);
      // części
      const poses = [];
      let prev = null;
      for (let k = 0; k < v.parts.length; k++) {
        const p = v.parts[k], opts = partOpts(p, v, k), key2 = p.model || 'unknown';
        let pose;
        if (k === 0) pose = { x: v.x, y: v.y, a: v.angle || 0 };
        else {
          const pa = SP.anchors(prev.key, prev.opts), ma = SP.anchors(key2, opts);
          // punkt zaczepu poprzednika (tylny zaczep / przedni dla hedera)
          let hp;
          if (key2 === 'header' && pa.headerMount) hp = pa.headerMount;
          else hp = pa.rearHitch || pa.hitch || pa.rear || [-0.3, 0, 0.1];
          const hv = rotv(hp[0], hp[1], prev.a), Hx = prev.x + hv[0], Hy = prev.y + hv[1];
          const mount = ma.mount || [0.2, 0, 0.1];
          if (ma.pivot && p.angle != null) {
            // ręczna jazda: kąt części podaje symulacja (przeguby G.machines.parts) — zaczep zostaje na kotwicach modelu, bez szczelin
            const a = p.angle, mv = rotv(mount[0], mount[1], a);
            pose = { x: Hx - mv[0], y: Hy - mv[1], a };
            if (ma.turntable) {
              const tv = rotv(ma.turntable[0], 0, a), da = Math.atan2(Hy - (pose.y + tv[1]), Hx - (pose.x + tv[0]));
              opts.steer = Math.round(Math.max(-0.9, Math.min(0.9, wrap(da - a))) * 20) / 20;
            }
            tr.parts[k] = null;
          } else if (ma.pivot) pose = follow(tr, k, Hx, Hy, prev.a, mount, ma, opts);
          else { const mv = rotv(mount[0], mount[1], prev.a); pose = { x: Hx - mv[0], y: Hy - mv[1], a: prev.a }; }
        }
        poses.push(pose);
        const it = { t: 'v', key: key2, ang: pose.a, opts, x: pose.x, y: pose.y, depth: pose.x + pose.y, v, k, selected, exact: false };
        if (k > 0 && key2 === 'header') it.depth += 0.15;
        prev = { key: key2, opts, x: pose.x, y: pose.y, a: pose.a };
        if (vis) items.push(it);
      }
      tr.poses = poses;
      if (vis) vehs.push({ v, tr, key, selected, poses, items: items.slice(items.length - v.parts.length) });
      if (vis && fx && dt > 0) vehicleFx(v, tr, poses, dt, now);
    }
    // strumienie ziarna: od króćca rury do środka najbliższej przyczepy (łuk rzutu) + cząsteczki
    for (const st of streams) {
      let best = null, bd = 1.8;
      for (const vh of vehs) for (let k = 1; k < vh.v.parts.length; k++) {
        if (vh.v.parts[k].model !== 'trailer') continue;
        const P = vh.poses[k], d = Math.hypot(P.x - st.x, P.y - st.y);
        if (d < bd && (vh.v.receiving || d < 0.7)) { bd = d; best = { P, cap: vh.v.parts[k].cap || 6, fill: vh.v.parts[k].fill || 0 }; }
      }
      if (best) { st.tx = best.P.x; st.ty = best.P.y; const t = (Math.min(30, Math.max(3, best.cap)) - 3) / 27; st.z1 = 0.2 + 0.04 * t + 0.02 + (0.16 + 0.2 * t) * Math.min(1, best.fill) + 0.02; }
      if (G.fx && Math.random() < st.dt * 30) { const u = Math.random(); const q = arcPt(st, u); G.fx.emit('grain', q[0], q[1], q[2], { vx: (st.tx - st.x) * 1.2, vy: (st.ty - st.y) * 1.2, vz: -0.4, floor: st.z1, color: st.color }); }
      if (G.fx && Math.random() < st.dt * 6) G.fx.emit('grainDust', st.tx, st.ty, st.z1 + 0.05, { vz: 0.05 });
    }
    // sprzątanie starych zestawów
    if (Math.random() < 0.02) for (const [k, t] of trains) if (now - t.seen > 5000) trains.delete(k);
  }
  // kinematyka części ciągniętej: zaczep poprzednika (Hx, Hy) ciągnie oś (pivot) — przyczepa „zawija” po śladzie
  function follow(tr, k, Hx, Hy, prevA, mount, ma, opts) {
    let st = tr.parts[k];
    const mx = mount[0], px = ma.pivot[0];
    if (ma.turntable) {
      // przyczepa dwuosiowa: dyszel → obrotnica (F), nadwozie → oś tylna (P)
      const fx = ma.turntable[0], lb = mx - fx, lp = fx - px;
      if (!st || Math.abs(Math.hypot(Hx - st.fx, Hy - st.fy) - lb) > 0.5) {
        const dx = Math.cos(prevA), dy = Math.sin(prevA);
        st = tr.parts[k] = { fx: Hx - dx * lb, fy: Hy - dy * lb, px: Hx - dx * (lb + lp), py: Hy - dy * (lb + lp) };
      }
      let dx = Hx - st.fx, dy = Hy - st.fy, d = Math.hypot(dx, dy) || 1;
      st.fx = Hx - dx / d * lb; st.fy = Hy - dy / d * lb;
      const da = Math.atan2(dy, dx);
      dx = st.fx - st.px; dy = st.fy - st.py; d = Math.hypot(dx, dy) || 1;
      st.px = st.fx - dx / d * lp; st.py = st.fy - dy / d * lp;
      const a = Math.atan2(dy, dx);
      let steer = wrap(da - a);
      steer = Math.max(-0.9, Math.min(0.9, steer));
      opts.steer = Math.round(steer * 20) / 20;
      return { x: st.fx - Math.cos(a) * fx, y: st.fy - Math.sin(a) * fx, a };
    }
    const L = mx - px;
    if (!st || Math.abs(Math.hypot(Hx - st.px, Hy - st.py) - L) > 0.5) {
      st = tr.parts[k] = { px: Hx - Math.cos(prevA) * L, py: Hy - Math.sin(prevA) * L };
    }
    const dx = Hx - st.px, dy = Hy - st.py, d = Math.hypot(dx, dy) || 1;
    st.px = Hx - dx / d * L; st.py = Hy - dy / d * L;
    const a = Math.atan2(dy, dx);
    return { x: Hx - Math.cos(a) * mx, y: Hy - Math.sin(a) * mx, a };
  }
  // efekty pojazdu: spaliny, kurz za narzędziem, oprysk, słoma, rozładunek
  function vehicleFx(v, tr, poses, dt, now) {
    const FX = G.fx, p0 = v.parts[0], a0 = SP.anchors(p0.model, { color: p0.color });
    const P = poses[0];
    const busy = tr.moving || v.working;
    // spaliny
    if (a0.exhaust && busy && Math.random() < dt * (v.working ? 9 : 5)) {
      const e = rotv(a0.exhaust[0], a0.exhaust[1], P.a);
      FX.emit('exhaust', P.x + e[0], P.y + e[1], a0.exhaust[2], { vx: (Math.random() - 0.5) * 0.04, vy: (Math.random() - 0.5) * 0.04, vz: 0.25 });
    }
    const last = poses[poses.length - 1], lastPart = v.parts[v.parts.length - 1];
    // kurz za narzędziem (sucho, praca) albo za kołami na drodze polnej latem
    if (v.dust && Math.random() < dt * 14) {
      const r = rotv(-0.25, (Math.random() - 0.5) * 0.6, last.a);
      FX.burst(last.x + r[0], last.y + r[1], 'dust', { n: 1 });
    } else if (tr.moving && !v.working && Math.random() < dt * 3) {
      const i = G.idx(Math.floor(P.x), Math.floor(P.y)), wt = G.weather && G.weather.type;
      if (G.S.map.t[i] === G.T.ROAD && wt !== 'rain' && wt !== 'storm' && !(G.weather && G.weather.snow > 1)) {
        const r = rotv(-0.3, 0, P.a); FX.burst(P.x + r[0], P.y + r[1], 'dust', { n: 1 });
      }
    }
    if (v.working) {
      const m = lastPart.model;
      if (m === 'sprayer' && Math.random() < dt * 30) { const r = rotv(-0.18, (Math.random() - 0.5) * 1.6, last.a); FX.burst(last.x + r[0], last.y + r[1], 'spray', { n: 1, z: 0.18 }); }
      if ((m === 'spreader') && Math.random() < dt * 25) { const r = rotv(-0.15, 0, last.a), s = rotv(-0.3, (Math.random() - 0.5) * 2, last.a); FX.emit('grain', last.x + r[0], last.y + r[1], 0.1, { vx: s[0], vy: s[1], vz: 0.4, color: '#eef0f2', size: 1.2 }); }
      if ((m === 'manure_spreader' || m === 'tank') && Math.random() < dt * 20) { const r = rotv(-0.42, (Math.random() - 0.5) * 0.4, last.a), s = rotv(-0.6, (Math.random() - 0.5) * 0.8, last.a); FX.emit('grain', last.x + r[0], last.y + r[1], 0.25, { vx: s[0], vy: s[1], vz: 0.3, color: m === 'tank' ? '#6a5a30' : '#4a3620', size: 2 }); }
      if ((m === 'mower' || m === 'rake') && Math.random() < dt * 10) { const r = rotv(-0.1, 0.35, last.a); FX.burst(last.x + r[0], last.y + r[1], 'hay', { n: 1, z: 0.08 }); }
      if (p0.model === 'combine' && Math.random() < dt * 16) { const r = rotv(-0.48, (Math.random() - 0.5) * 0.3, P.a); FX.burst(P.x + r[0], P.y + r[1], 'straw', { n: 1, z: 0.25 }); if (Math.random() < 0.3) FX.emit('grainDust', P.x + r[0], P.y + r[1], 0.3, { vz: 0.1 }); }
      if (p0.model === 'combine' && Math.random() < dt * 6) { const r = rotv(0.7, (Math.random() - 0.5) * 1, P.a); FX.emit('grainDust', P.x + r[0], P.y + r[1], 0.1, { vz: 0.08 }); }
      if (m === 'baler' && Math.random() < dt * 6) { const r = rotv(-0.2, 0, last.a); FX.burst(last.x + r[0], last.y + r[1], 'straw', { n: 1, z: 0.15 }); }
    }
    // strumień ziarna z rury wyładowczej
    if (v.auger === 'out' && v.unloading) {
      const it = { key: p0.model, opts: partOpts(p0, v, 0) };
      const an = SP.anchors(it.key, it.opts).auger;
      if (an) {
        const r = rotv(an[0], an[1], P.a), sx = P.x + r[0], sy = P.y + r[1];
        // cel strumienia ustalany po zebraniu wszystkich pojazdów (najbliższa przyczepa odbierająca)
        streams.push({ x: sx, y: sy, z0: an[2], tx: sx, ty: sy, z1: 0.32, color: grainColor(v), dt });
      }
    }
    // przyczepa rozładowywana na podwórzu (wywrot do tyłu)
    if (v.unloading && v.unit === 'shuttle' && v.parts.length > 1) {
      for (let k = 1; k < poses.length; k++) {
        if (v.parts[k].model !== 'trailer' || Math.random() > dt * 24) continue;
        const Pk = poses[k], r = rotv(-0.4 - 0.25 * ((v.parts[k].cap || 6) / 30), (Math.random() - 0.5) * 0.2, Pk.a);
        G.fx.emit('grain', Pk.x + r[0], Pk.y + r[1], 0.28, { vz: -0.2, color: grainColor(v) });
        if (Math.random() < 0.15) G.fx.emit('grainDust', Pk.x + r[0], Pk.y + r[1], 0.1, { vz: 0.06 });
      }
    }
  }
  // punkt na łuku strumienia (u 0..1): poziomo liniowo, w pionie parabola z lekkim wyrzutem
  function arcPt(st, u) { return [st.x + (st.tx - st.x) * u, st.y + (st.ty - st.y) * u, st.z0 + (st.z1 - st.z0) * u * u + 0.06 * u * (1 - u)]; }
  function grainColor(v) {
    const j = v.jobUid && G.jobs && G.jobs.get ? G.jobs.get(v.jobUid) : null;
    const crop = j && j.pid != null && G.S.fields && G.S.fields[j.pid] ? (G.S.fields[j.pid].crop || G.S.fields[j.pid].last) : null;
    if (crop === 'rzepak') return '#3a2a22';
    if (crop === 'kukurydza') return '#e8b53a';
    if (crop === 'kiszonka') return '#8aa040';
    return '#e2bf55';
  }

  // ===================== PODGLĄD STAWIANIA =====================
  function collectPlace() {
    const pl = G.view && G.view.place;
    if (!pl || !pl.type || !G.BUILDINGS[pl.type]) return;
    const T = G.BUILDINGS[pl.type];
    const w = pl.rot ? T.size[1] : T.size[0], h = pl.rot ? T.size[0] : T.size[1];
    const cx = pl.x + w / 2, cy = pl.y + h / 2;
    items.push({ t: 'ghost', key: T.model || 'unknown', ang: pl.rot ? Math.PI / 2 : 0, opts: { size: T.size, level: 1, color: T.color, variant: T.variant, exactAngle: true }, x: cx, y: cy, depth: cx + cy, valid: pl.valid !== false, f: { x: pl.x, y: pl.y, w, h } });
  }

  // ===================== ZBIERANIE =====================
  OB.update = function (now, dt) {
    items = []; vehs = []; streams = [];
    if (!G.S) return;
    try { collectBuildings(now); } catch (e) { console.error('[objects] budynki', e); }
    try { collectVehicles(now, dt); } catch (e) { console.error('[objects] pojazdy', e); }
    try { collectAnimals(now); } catch (e) { console.error('[objects] zwierzęta', e); }
    try { collectPlace(); } catch (e) { console.error('[objects] podgląd', e); }
    items.sort((a, b) => a.depth - b.depth);
    chimneys(now, dt);
  };
  // dym z kominów (domy na podwórzu i we wsi) — chłodne miesiące albo rano/wieczorem
  let chimT = 0;
  function chimneys(now, dt) {
    chimT += dt;
    if (chimT < 0.35 || !G.fx) return;
    chimT = 0;
    const d = G.date(), h = hourNow(), cold = G.cm(d) >= 9 || G.cm(d) <= 3;
    if (!(cold || h < 8 || h > 18)) return;
    for (const it of items) {
      if (it.t !== 'b' || it.opts.progress != null) continue;
      if (it.key !== 'house' && it.key !== 'workshop' && it.key !== 'biogas') continue;
      const e = SP.get(it.key, it.ang, it.opts);
      const c = e.anchors.chimney;
      if (c && Math.random() < (cold ? 0.9 : 0.4)) G.fx.burst(it.x + c.x, it.y + c.y, 'smoke', { n: 1, z: c.z });
    }
    if (G.terrain && G.terrain.chimneys && cold) {
      const cs = G.terrain.chimneys();
      for (let k = 0; k < cs.length; k++) {
        if (Math.random() > 0.25) continue;
        const t = ISO.toTileF(cs[k].x, cs[k].y + 0.4 * ZS);
        G.fx.burst(t.tx - 0.2, t.ty - 0.2, 'smoke', { n: 1, z: 0.4 });
      }
    }
  }

  // ===================== RYSOWANIE =====================
  function footprintPath(ctx, f, inset) {
    inset = inset || 0;
    const a = scr(f.x + inset, f.y + inset), b = scr(f.x + f.w - inset, f.y + inset), c = scr(f.x + f.w - inset, f.y + f.h - inset), d = scr(f.x + inset, f.y + f.h - inset);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.lineTo(d.x, d.y); ctx.closePath();
  }
  function ellipseAt(ctx, x, y, rx, ry) {
    // elipsa „leżąca” na ziemi: promienie w kaflach → romb izometryczny zaokrąglony
    const p = scr(x, y), z = G.cam.zoom;
    ctx.beginPath(); ctx.ellipse(p.x, p.y, rx * 32 * z * 1.42, ry * 16 * z * 1.42, 0, 0, Math.PI * 2);
  }
  OB.drawGround = function (ctx, now, shAlpha) {
    shadowAlpha = shAlpha == null ? 0.3 : shAlpha;
    const z = G.cam.zoom, t = now / 1000;
    const view = G.view || {};
    // obrys wybranego budynku
    if (view.selBuilding != null) {
      const it = items.find(i => i.t === 'b' && i.b.uid === view.selBuilding);
      if (it) {
        footprintPath(ctx, it.f, -0.06);
        ctx.fillStyle = 'rgba(255,214,90,0.18)'; ctx.fill();
        ctx.setLineDash([8 * z, 5 * z]); ctx.lineDashOffset = -t * 20 * z;
        ctx.strokeStyle = '#ffd65a'; ctx.lineWidth = Math.max(1.5, 2.2 * z); ctx.stroke(); ctx.setLineDash([]);
      }
    }
    // podgląd stawiania: zielony/czerwony obrys kafli
    for (const it of items) {
      if (it.t !== 'ghost') continue;
      const col = it.valid ? [90, 220, 120] : [235, 80, 70];
      for (let y = it.f.y; y < it.f.y + it.f.h; y++) for (let x = it.f.x; x < it.f.x + it.f.w; x++) {
        footprintPath(ctx, { x, y, w: 1, h: 1 }, 0.04);
        ctx.fillStyle = 'rgba(' + col + ',0.28)'; ctx.fill();
        ctx.strokeStyle = 'rgba(' + col + ',0.9)'; ctx.lineWidth = Math.max(1, 1.4 * z); ctx.stroke();
      }
    }
    // pierścienie zaznaczonych pojazdów
    for (const vh of vehs) {
      if (!vh.selected) continue;
      const pulse = 1 + 0.06 * Math.sin(t * 5);
      for (let k = 0; k < vh.poses.length; k++) {
        const P = vh.poses[k], r = (k === 0 ? 0.42 : 0.36) * pulse;
        ellipseAt(ctx, P.x, P.y, r, r);
        ctx.fillStyle = 'rgba(255,214,90,0.16)'; ctx.fill();
        ctx.strokeStyle = k === 0 ? '#ffd65a' : 'rgba(255,214,90,0.7)'; ctx.lineWidth = Math.max(1.5, 2.4 * z); ctx.stroke();
      }
    }
    // cienie (jedno źródło światła)
    if (shadowAlpha > 0.01) for (const it of items) {
      if (it.t === 'bee') continue;
      const p = scr(it.x, it.y);
      if (it.t === 'ghost') { SP.drawShadow(ctx, it.key, it.ang, it.opts, p.x, p.y, z, shadowAlpha * 0.5); continue; }
      if (it.small && z < 0.6) { ctx.fillStyle = 'rgba(0,0,0,' + shadowAlpha * 0.8 + ')'; ctx.beginPath(); ctx.ellipse(p.x + 2 * z, p.y, 5 * z, 2.2 * z, 0, 0, 7); ctx.fill(); continue; }
      SP.drawShadow(ctx, it.key, it.ang, it.opts, p.x, p.y, z, shadowAlpha);
    }
  };
  OB.draw = function (ctx, now) {
    const z = G.cam.zoom;
    for (const it of items) {
      const p = scr(it.x, it.y);
      if (it.t === 'bee') {
        const bz = 0.25 + 0.06 * Math.sin(now / 120 + it.ph * 3);
        const q = scr(it.x, it.y, bz);
        ctx.fillStyle = '#2a2420'; ctx.fillRect(q.x - 1.2 * z, q.y - 0.8 * z, 2.4 * z, 1.6 * z);
        ctx.fillStyle = '#f0c040'; ctx.fillRect(q.x - 0.5 * z, q.y - 0.8 * z, 1 * z, 1.6 * z);
        ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.fillRect(q.x - 1 * z, q.y - 1.8 * z, 2 * z, 0.9 * z);
        continue;
      }
      if (it.t === 'ghost') {
        ctx.globalAlpha = 0.62;
        SP.draw(ctx, it.key, it.ang, it.opts, p.x, p.y, z);
        ctx.globalAlpha = 1;
        continue;
      }
      it.e = SP.draw(ctx, it.key, it.ang, it.opts, p.x, p.y, z);
      it.sx = p.x; it.sy = p.y;
    }
    // strumienie ziarna (rura → przyczepa)
    for (const s of streams) {
      const pts = []; for (let k = 0; k <= 10; k++) { const q = arcPt(s, k / 10); pts.push(scr(q[0], q[1], q[2])); }
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      const path = () => { ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); };
      path(); ctx.strokeStyle = SP.shade(s.color, 0.8); ctx.lineWidth = Math.max(2, 4.2 * z); ctx.stroke();
      path(); ctx.strokeStyle = s.color; ctx.lineWidth = Math.max(1.4, 3 * z); ctx.stroke();
      ctx.setLineDash([2 * z, 5 * z]); ctx.lineDashOffset = -(now / 25) * z;
      path(); ctx.strokeStyle = 'rgba(255,248,210,0.85)'; ctx.lineWidth = Math.max(0.6, 1 * z); ctx.stroke(); ctx.setLineDash([]);
      const b = pts[pts.length - 1];
      ctx.fillStyle = SP.shade(s.color, 1.06); ctx.beginPath(); ctx.ellipse(b.x, b.y, 5 * z, 2.2 * z, 0, 0, 7); ctx.fill();
    }
  };

  // ===================== ŚWIATŁA NOCNE =====================
  OB.lights = function () {
    const out = [], z = G.cam.zoom;
    for (const it of items) {
      if (!it.e || !it.e.lights || !it.e.lights.length) continue;
      if (it.t === 'b') {
        if (!it.lit || it.opts.progress != null) continue;
        for (let k = 0; k < it.e.lights.length; k++) {
          const l = it.e.lights[k];
          if (it.key === 'house' && hsh(it.b.uid * 31 + k, G.date().dayIndex) < 0.3) continue;
          out.push({ x: it.sx + l.x * z, y: it.sy + l.y * z, r: l.r, c: l.c });
        }
      } else if (it.t === 'v' && it.v.lights) {
        for (const l of it.e.lights) out.push({ x: it.sx + l.x * z, y: it.sy + l.y * z, r: l.r * 0.8, c: l.c });
      }
    }
    // stożki reflektorów na ziemi
    for (const vh of vehs) {
      if (!vh.v.lights) continue;
      const P = vh.poses[0], a = P.a;
      const pts = [[0.3, -0.12], [1.5, -0.55], [1.5, 0.55], [0.3, 0.12]].map(q => { const r = rotv(q[0], q[1], a); return scr(P.x + r[0], P.y + r[1]); });
      out.push({ beam: pts });
      // światła robocze z tyłu (przy pracy)
      if (vh.v.working) { const r = rotv(-0.9, 0, a); const q = scr(P.x + r[0], P.y + r[1]); out.push({ x: q.x, y: q.y, r: 3.2, c: '#fff1c0', ground: true }); }
    }
    return out;
  };

  // ===================== ZNACZNIKI (nad wszystkim) =====================
  function bubble(ctx, x, y, z, bg, draw) {
    const r = 9 * Math.max(0.8, Math.min(1.3, z));
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = 4; ctx.shadowOffsetY = 1;
    ctx.fillStyle = bg; ctx.beginPath(); ctx.arc(x, y - r, r, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.moveTo(x - r * 0.4, y - r * 0.2); ctx.lineTo(x, y + r * 0.35); ctx.lineTo(x + r * 0.4, y - r * 0.2); ctx.fill();
    ctx.restore();
    draw(x, y - r, r);
  }
  function wheelIcon(ctx, x, y, r) {
    ctx.strokeStyle = '#fff'; ctx.lineWidth = r * 0.18;
    ctx.beginPath(); ctx.arc(x, y, r * 0.55, 0, 7); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x - r * 0.55, y); ctx.lineTo(x + r * 0.55, y); ctx.moveTo(x, y); ctx.lineTo(x, y + r * 0.55); ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x, y, r * 0.16, 0, 7); ctx.fill();
  }
  function wrenchIcon(ctx, x, y, r) {
    ctx.strokeStyle = '#fff'; ctx.lineWidth = r * 0.22; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x - r * 0.4, y + r * 0.4); ctx.lineTo(x + r * 0.2, y - r * 0.2); ctx.stroke();
    ctx.beginPath(); ctx.arc(x + r * 0.3, y - r * 0.3, r * 0.25, Math.PI * 0.9, Math.PI * 2.6); ctx.stroke();
  }
  function waitIcon(ctx, x, y, r, now) {
    ctx.fillStyle = '#fff';
    for (let k = 0; k < 3; k++) { const a = 0.45 + 0.55 * Math.max(0, Math.sin(now / 250 - k * 0.8)); ctx.globalAlpha = a; ctx.beginPath(); ctx.arc(x + (k - 1) * r * 0.42, y, r * 0.14, 0, 7); ctx.fill(); }
    ctx.globalAlpha = 1;
  }
  function flag(ctx, x, y, z, now, col) {
    const s = Math.max(0.8, Math.min(1.4, z));
    ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.beginPath(); ctx.ellipse(x, y, 6 * s, 3 * s, 0, 0, 7); ctx.fill();
    ctx.strokeStyle = col; ctx.lineWidth = 1.5 * s; ctx.beginPath(); ctx.ellipse(x, y, 6 * s * (1 + 0.15 * Math.sin(now / 200)), 3 * s * (1 + 0.15 * Math.sin(now / 200)), 0, 0, 7); ctx.stroke();
    ctx.strokeStyle = '#3a3a3a'; ctx.lineWidth = 1.4 * s; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y - 22 * s); ctx.stroke();
    const wv = Math.sin(now / 180) * 2 * s;
    ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(x, y - 22 * s); ctx.quadraticCurveTo(x + 7 * s, y - 22 * s + wv, x + 13 * s, y - 18 * s); ctx.quadraticCurveTo(x + 7 * s, y - 15 * s - wv, x, y - 14 * s); ctx.closePath(); ctx.fill();
  }
  OB.drawMarkers = function (ctx, now) {
    const z = G.cam.zoom;
    for (const vh of vehs) {
      const v = vh.v, P = vh.poses[0];
      const top = scr(P.x, P.y, 0.72);
      // cel rozkazu / odwozu
      if (v.target && (vh.selected || v.manual || v.unit === 'order')) {
        const q = scr(v.target.x, v.target.y);
        if (vh.selected) {
          const a = scr(P.x, P.y);
          ctx.strokeStyle = 'rgba(255,214,90,0.8)'; ctx.lineWidth = Math.max(1, 1.6 * z); ctx.setLineDash([6 * z, 6 * z]); ctx.lineDashOffset = -now / 40;
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(q.x, q.y); ctx.stroke(); ctx.setLineDash([]);
        }
        flag(ctx, q.x, q.y, z, now, '#ffd65a');
      }
      if (v.manual) bubble(ctx, top.x, top.y, z, '#2f7de1', (x, y, r) => wheelIcon(ctx, x, y, r));
      else if (v.broken) bubble(ctx, top.x, top.y, z, '#d64541', (x, y, r) => wrenchIcon(ctx, x, y, r));
      else if (v.waiting && (v.kind === 'own' || vh.selected)) bubble(ctx, top.x, top.y, z, 'rgba(60,70,80,0.85)', (x, y, r) => waitIcon(ctx, x, y, r, now));
      // etykieta zaznaczonego
      if (vh.selected && v.label) {
        const txt = v.label + (v.driver ? ' · ' + v.driver : '');
        ctx.font = '600 ' + Math.round(11 * Math.max(0.9, Math.min(1.2, z))) + 'px Inter, system-ui, sans-serif';
        const w = ctx.measureText(txt).width + 14, y = top.y - (v.manual || v.broken || v.waiting ? 28 : 6);
        ctx.fillStyle = 'rgba(20,24,18,0.82)';
        const x0 = top.x - w / 2, h = 20;
        ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x0, y - h, w, h, 10); else ctx.rect(x0, y - h, w, h); ctx.fill();
        ctx.fillStyle = '#fff6d8'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(txt, top.x, y - h / 2 + 0.5);
        ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
      }
    }
  };

  OB.list = () => items;
  OB.vehicles = () => vehs;
  OB.trainOf = function (uid) { const t = trains.get('m' + uid); return t ? t.poses : null; };
  G.on('newGame', () => trains.clear());
  G.on('load', () => trains.clear());
})();
