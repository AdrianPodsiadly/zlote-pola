// Złote Pola — zlecenia prac polowych i transportu, pojazdy na mapie, usługi kontraktorów → G.jobs (agent: maszyny, ludzie, prace)
//
// Stan: G.S.jobs = { list: [zlecenia aktywne i w kolejce], history: [zakończone, max 40] }
// Zlecenie: { uid, op, pid, params, machines:[uid], worker, helper, night, status: 'queued'|'active'|'done'|'cancelled',
//             stage: 'out'|'work'|'unload'|'home', reason (dlaczego czeka), order:[kafle w kolejności serpentyny], pos, done, total,
//             bin (t w zbiorniku), binCap, binProd, fuel (l), fuelCost (zł), hours (h pracy), outTotal {produkt: ilość},
//             contractor: null | { name, color, price, startTick, power, impl }, units: { main, shuttle } }
// Jednostka (pojazd): { x, y (kafel, ułamkowy; środek kafla = +0.5), angle (rad, 0 = +x kafli), path:[idx], pi, mode, w (segment pracy) }
//
// Przebieg: wyjazd z podwórza (G.S.farm.yard) → jazda po drogach (BFS po ROAD/ASPHALT/YARD; przez własne pole wolno) → obróbka
// pasami w serpentynie wzdłuż dłuższego boku działki (czas kafla = 0,25 ha / wydajność) → G.fields.workTile(pid, i, op, params)
// dla każdego kafla → G.fields.complete → 'opDone' → powrót → 'jobDone'.
// ZBIÓR: kombajn zbiera do zbiornika (cap). Pełny zbiornik:
//   • jest przyczepa (drugi ciągnik + przyczepa + pomocnik w zleceniu) → przyczepa podjeżdża do kombajnu, przeładunek w polu,
//     odwozi plon na podwórze i wraca (kombajn pracuje dalej; czeka tylko, gdy przyczepa nie zdąży),
//   • brak przyczepy → kombajn zbożowy sam jedzie rozładować się na podwórze i wraca w to samo miejsce;
//     kombajn ziemniaczany/buraczany wysypuje na pryzmę przy wjeździe na pole (plon trafia do magazynu),
//   • sieczkarnia (bez zbiornika) bez przyczepy pracuje o 40 % wolniej, zielonka trafia od razu do magazynu.
//   Plon trafia do G.inv dopiero po rozładunku (chyba że G.fields.workTile zwróci { stored: true } — wtedy sam go zapisał).
(function () {
  const C = G.CFG, T = G.T, W = C.W, H = C.H, N = W * H, TPD = C.TICKS_PER_DAY, HA = C.TILE_HA;
  const J = G.jobs = {};
  const M = () => G.machines;
  const def = x => G.machines.def(x);

  // prędkości przejazdu w kaflach/h (skala dojazdów skompresowana dla czytelności; 1 kafel = 50 m)
  const SPD = { [T.ASPHALT]: 80, [T.ROAD]: 55, [T.YARD]: 25 };
  const SPD_OFF = 30;
  const UNLOAD_H = 0.25, TRANSFER_H = 0.1;
  const DUSTY = { plow: 1, cultivate: 1, harvest: 1, sow: 1, bale: 1, rake: 1, mow: 0, spray: 0, fertilize: 1, lime: 1 };
  const OP_NAMES = { plow: 'Orka', cultivate: 'Uprawa', lime: 'Wapnowanie', fertilize: 'Nawożenie', sow: 'Siew', spray: 'Oprysk', harvest: 'Zbiór', bale: 'Prasowanie', mow: 'Koszenie', rake: 'Zgrabianie' };
  J.opName = op => (G.fields && G.fields.OPS && G.fields.OPS[op] && G.fields.OPS[op].name) || OP_NAMES[op] || op;

  const CONTRACTORS = [
    { name: 'Usługi Rolnicze Kowalczyk', color: '#e07b00' },
    { name: 'Agro-Serwis Mazur', color: '#4a6fa5' },
    { name: 'ZUR Nowak i Synowie', color: '#8a4fb0' }
  ];

  // ===================== ŚCIEŻKI =====================
  const prev = new Int32Array(N), queue = new Int32Array(N);
  function bfs(start, isGoal, pass) {
    prev.fill(-2);
    let h = 0, t = 0;
    queue[t++] = start; prev[start] = -1;
    while (h < t) {
      const i = queue[h++];
      if (isGoal(i)) {
        const path = [];
        for (let k = i; k !== start && k >= 0; k = prev[k]) path.push(k);
        return path.reverse();
      }
      const x = i % W;
      const nb = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i >= W ? i - W : -1, i < N - W ? i + W : -1];
      for (const n of nb) if (n >= 0 && prev[n] === -2 && pass(n)) { prev[n] = i; queue[t++] = n; }
    }
    return null;
  }
  const passFor = (pid, extra) => i => G.isDrivable(i) || (pid != null && G.S.map.parcel[i] === pid) || i === extra;
  // trasa z kafla from do kafla to (wolno jechać po drogach, podwórzu i działce pid)
  function route(from, to, pid) {
    if (from === to) return [];
    let p = bfs(from, i => i === to, passFor(pid, to));
    if (!p) p = bfs(from, i => i === to, i => G.S.map.t[i] !== T.WATER);   // awaryjnie na przełaj
    return p || [to];
  }
  // trasa do dowolnego sąsiada kafla target (dojazd na pole od strony drogi)
  function routeNear(from, target, pid) {
    const nbs = new Set(G.N4(target));
    const pass = passFor(pid, -1);
    let p = bfs(from, i => nbs.has(i) && i !== target, i => pass(i) && i !== target);
    if (!p) p = route(from, target, pid);
    return p;
  }
  J.route = route;
  function pathLen(from, path) { let L = 0, px = G.tx(from), py = G.ty(from); for (const i of path) { L += Math.hypot(G.tx(i) - px, G.ty(i) - py) / speedAt(i); px = G.tx(i); py = G.ty(i); } return L; }
  const speedAt = i => SPD[G.S.map.t[i]] || SPD_OFF;

  // wyjazd z podwórza: kafel YARD sąsiadujący z drogą (najbliżej środka)
  function yardExit() {
    const y = G.S.farm.yard, cx = y.x + y.w / 2, cy = y.y + y.h / 2;
    let best = G.idx(Math.floor(cx), Math.floor(cy)), bd = 1e9;
    for (let ty = y.y; ty < y.y + y.h; ty++) for (let tx = y.x; tx < y.x + y.w; tx++) {
      const i = G.idx(tx, ty);
      if (G.S.map.t[i] !== T.YARD) continue;
      if (!G.N4(i).some(n => G.S.map.t[n] === T.ROAD || G.S.map.t[n] === T.ASPHALT)) continue;
      const d = Math.hypot(tx + 0.5 - cx, ty + 0.5 - cy);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }
  J.yardExit = yardExit;
  // kontraktor przyjeżdża z zachodniego skraju mapy asfaltem
  function edgeStart() {
    for (let y = 0; y < H; y++) if (G.S.map.t[G.idx(0, y)] === T.ASPHALT) return G.idx(0, y);
    return yardExit();
  }

  // kolejność kafli: pasy wzdłuż dłuższego boku, serpentyna, start od strony wjazdu
  function serpentine(job) {
    const p = G.S.parcels[job.pid], b = { x0: W, y0: H, x1: -1, y1: -1 };
    for (const i of p.tiles) { const x = G.tx(i), y = G.ty(i); if (x < b.x0) b.x0 = x; if (x > b.x1) b.x1 = x; if (y < b.y0) b.y0 = y; if (y > b.y1) b.y1 = y; }
    const horiz = (b.x1 - b.x0) >= (b.y1 - b.y0);
    const tiles = new Set(p.tiles);
    const e = p.entry >= 0 ? p.entry : p.tiles[0], ex = G.tx(e), ey = G.ty(e);
    const fs = G.fields, fState = fs && fs.get ? fs.get(job.pid) : null;
    const skipWorked = !!(fs && fs.tileState && fState && fState.work && fState.work.op === job.op);
    const order = [];
    const [a0, a1, s0, s1] = horiz ? [b.x0, b.x1, b.y0, b.y1] : [b.y0, b.y1, b.x0, b.x1];
    const eA = horiz ? ex : ey, eS = horiz ? ey : ex;
    const strips = [];
    for (let s = s0; s <= s1; s++) strips.push(s);
    if (Math.abs(eS - s1) < Math.abs(eS - s0)) strips.reverse();
    let fwd = Math.abs(eA - a0) <= Math.abs(eA - a1);
    for (const s of strips) {
      const row = [];
      for (let a = a0; a <= a1; a++) { const i = horiz ? G.idx(a, s) : G.idx(s, a); if (tiles.has(i)) row.push(i); }
      if (!fwd) row.reverse();
      for (const i of row) {
        if (skipWorked) { try { const ts = fs.tileState(i); if (ts && ts.worked) continue; } catch (err) { /* brak */ } }
        order.push(i);
      }
      if (row.length) fwd = !fwd;
    }
    return order;
  }

  // ===================== DOBÓR ZESTAWU =====================
  function cropOf(op, params, pid) { return M().cropFor(op, params, pid); }
  // z listy uid wybiera: maszynę napędową, narzędzie, zestaw transportowy (ciągnik + przyczepa)
  function resolve(op, params, pid, uids) {
    const crop = cropOf(op, params, pid), input = M().inputFor(op, params);
    const ms = (uids || []).map(u => M().get(u)).filter(Boolean);
    if (ms.length !== (uids || []).length) return { ok: false, reason: 'Wybrana maszyna nie istnieje' };
    const fits = d => M().fits(d, op, crop, input);
    let power = null, impl = null;
    const self = ms.find(m => def(m).self && def(m).ops.includes(op));
    if (self) {
      power = self;
      const pd = def(self);
      if (pd.crops && crop && !pd.crops.includes(crop)) return { ok: false, reason: pd.name + ' nie zbiera tej uprawy' };
      if (pd.needs === 'header') {
        impl = ms.find(m => def(m).cat === 'header' && fits(def(m)));
        if (!impl) return { ok: false, reason: ms.some(m => def(m).cat === 'header') ? 'Heder nie pasuje do tej uprawy' : 'Kombajn potrzebuje hedera' };
        if (def(impl).reqHp > pd.hp) return { ok: false, reason: 'Heder za ciężki dla kombajnu' };
      }
    } else {
      impl = ms.find(m => !M().isPower(def(m)) && def(m).cat !== 'trailer' && def(m).cat !== 'header' && fits(def(m)));
      if (!impl) {
        const near = ms.find(m => !M().isPower(def(m)) && def(m).ops.includes(op));
        return { ok: false, reason: near ? def(near).name + ' nie nadaje się do tej uprawy/środka' : 'Brak narzędzia do zabiegu: ' + J.opName(op) };
      }
      const req = def(impl).reqHp || 0;
      const trs = ms.filter(m => def(m).cat === 'tractor');
      if (!trs.length) return { ok: false, reason: 'Brak ciągnika' };
      power = trs.find(m => def(m).hp >= req);
      if (!power) return { ok: false, reason: 'Za mała moc: ' + Math.max(...trs.map(m => def(m).hp)) + ' KM, ' + def(impl).name + ' wymaga ' + req + ' KM' };
    }
    let shT = null, shTr = null;
    if (op === 'harvest') {
      shTr = ms.find(m => def(m).cat === 'trailer');
      if (shTr) shT = ms.find(m => m !== power && def(m).cat === 'tractor' && def(m).hp >= (def(shTr).reqHp || 0));
      if (!shT) shTr = null;
    }
    return { ok: true, power, impl, shT, shTr, crop };
  }

  function haHFor(job, day) {
    const c = job.contractor;
    const pd = c ? G.MACHINES[c.power] : def(job.power), id = c ? (c.impl ? G.MACHINES[c.impl] : null) : (job.impl ? def(job.impl) : null);
    if (!pd) return 0.1;
    const skill = c ? 1.12 : (G.workers ? G.workers.speedFactor(job.worker) : 1);
    let r = G.machines.rate(pd.id, id && id.id, skill);
    if (!day && isNight()) r *= 0.8;
    const wd = id || pd;
    if (wd.cat === 'forage_harvester' && !job.units.shuttle && !job.contractor) r *= 0.6;
    if (wd.cat === 'manure_spreader' && wd.model === 'manure_spreader' && hasIdleLoader()) r *= 1.3;
    return Math.max(0.02, r);
  }
  function hasIdleLoader() { return G.machines.list().some(m => def(m).cat === 'loader' && !m.busy && G.machines.ready(m.uid).ok); }
  function isNight(h) { h = h == null ? G.date().hour : h; return h >= 21 || h < 5; }

  // ===================== WALIDACJA I TWORZENIE =====================
  function parcelOk(pid) {
    const p = G.S.parcels[pid];
    if (!p) return { ok: false, reason: 'Nie ma takiej działki' };
    if (p.owner !== 'player' && !p.leased) return { ok: false, reason: 'To nie jest Twoja działka' };
    return { ok: true, p };
  }
  function opKnown(op) { return (G.fields && G.fields.OPS) ? !!G.fields.OPS[op] : !!OP_NAMES[op]; }
  function canDo(pid, op, params) {
    if (G.fields && G.fields.canDo) { try { const r = G.fields.canDo(pid, op, params); if (r && !r.ok) return r; } catch (e) { console.error(e); } }
    return { ok: true };
  }
  function weatherOk() {
    if (!(G.weather && G.weather.canWork)) return { ok: true };
    if (wc.tick !== G.S.tick) { wc.tick = G.S.tick; try { wc.r = G.weather.canWork() || { ok: true }; } catch (e) { wc.r = { ok: true }; } }
    return wc.r;
  }
  const wc = { tick: -1, r: { ok: true } };

  J.validate = function (spec) {
    spec = spec || {};
    const { op, pid } = spec;
    if (!opKnown(op)) return { ok: false, reason: 'Nieznany zabieg' };
    const po = parcelOk(pid); if (!po.ok) return po;
    if (J.list().some(j => j.pid === pid && j.op === op)) return { ok: false, reason: 'To zlecenie już jest w kolejce' };
    const cd = canDo(pid, op, spec.params); if (!cd.ok) return { ok: false, reason: cd.reason || 'Zabieg teraz niemożliwy' };
    const rs = resolve(op, spec.params, pid, spec.machines); if (!rs.ok) return rs;
    const w = G.workers && G.workers.get(spec.worker);
    if (!w) return { ok: false, reason: 'Wybierz pracownika' };
    if (rs.shT && (!spec.helper || spec.helper === spec.worker || !G.workers.get(spec.helper))) { rs.shT = null; rs.shTr = null; rs.warn = 'Przyczepa pominięta — potrzebny drugi pracownik'; }
    for (const m of [rs.power, rs.impl, rs.shT, rs.shTr]) if (m) { const r = G.machines.ready(m.uid); if (!r.ok) return { ok: false, reason: def(m).name + ': ' + r.reason }; }
    const waits = [];
    for (const m of [rs.power, rs.impl, rs.shT, rs.shTr]) if (m && m.busy) waits.push(def(m).name);
    if (w.busy) waits.push(w.name);
    const wo = weatherOk();
    if (!wo.ok) waits.push('pogoda: ' + (wo.reason || 'nie da się pracować'));
    rs.warn = [rs.warn, waits.length ? 'Zlecenie poczeka na: ' + waits.join(', ') : ''].filter(Boolean).join('. ');
    return rs;
  };

  J.create = function (spec) {
    const v = J.validate(spec);
    if (!v.ok) return { ok: false, reason: v.reason };
    const p = G.S.parcels[spec.pid];
    const job = baseJob(spec.op, spec.pid, spec.params);
    Object.assign(job, {
      machines: [v.power, v.impl, v.shT, v.shTr].filter(Boolean).map(m => m.uid),
      power: v.power.uid, impl: v.impl ? v.impl.uid : null, shTractor: v.shT ? v.shT.uid : null, shTrailer: v.shTr ? v.shTr.uid : null,
      worker: spec.worker, helper: v.shT ? spec.helper : null, night: spec.night !== false
    });
    G.S.jobs.list.push(job);
    G.notify('📋 Zlecenie: ' + J.opName(job.op) + ' — ' + p.name + (v.warn ? ' (' + v.warn + ')' : ''), 'info');
    return { ok: true, job, warn: v.warn || '' };
  };
  function baseJob(op, pid, params) {
    return {
      uid: G.uid(), op, pid, params: params ? JSON.parse(JSON.stringify(params)) : {}, machines: [], worker: null, helper: null, night: true,
      status: 'queued', stage: null, reason: '', created: G.S.tick, started: 0, finished: 0, power: null, impl: null, shTractor: null, shTrailer: null,
      contractor: null, order: [], pos: 0, done: 0, total: 0, bin: 0, binCap: 0, binProd: {}, binStored: false, fuel: 0, fuelPending: 0, fuelCost: 0,
      hours: 0, outTotal: {}, units: { main: null, shuttle: null }, err: null, errTick: -1, fuelTick: -1, cancelled: false, userPaused: false, mode: null
    };
  }

  // podpowiedź zestawu: najlepszy dostępny zestaw + najlepszy wolny pracownik (+ przyczepa przy zbiorze)
  J.suggest = function (op, pid, params) {
    const combos = G.machines.compatible(op, params, pid).filter(c => c.available);
    if (!combos.length) return null;
    const c = combos[0];
    const free = G.workers.list().filter(w => !w.busy && w.role !== 'barn').sort((a, b) => b.skills.field - a.skills.field || b.energy - a.energy);
    if (!free.length) return null;
    const spec = { op, pid, params, machines: [c.tractor, c.implement].filter(Boolean), worker: free[0].uid };
    if (op === 'harvest' && free[1]) {
      const tr = G.machines.list().filter(m => def(m).cat === 'trailer' && !m.busy && G.machines.ready(m.uid).ok).sort((a, b) => def(b).cap - def(a).cap)[0];
      const t2 = tr && G.machines.list().find(m => m.uid !== c.tractor && def(m).cat === 'tractor' && !m.busy && G.machines.ready(m.uid).ok && def(m).hp >= (def(tr).reqHp || 0));
      if (tr && t2) { spec.machines.push(t2.uid, tr.uid); spec.helper = free[1].uid; }
    }
    spec.label = c.label;
    return spec;
  };

  // ===================== SZACUNEK =====================
  J.estimate = function (spec) {
    if (spec && spec.contractor) { const q = J.contractorQuote(spec.pid, spec.op, spec.params); return Object.assign({ hours: q.hoursEst || 0, fuel: 0, cost: q.price }, q); }
    const v = J.validate(Object.assign({}, spec, { _est: true }));
    const po = parcelOk(spec && spec.pid);
    if (!po.ok) return { ok: false, reason: po.reason, hours: 0, fuel: 0, cost: 0 };
    const rs = v.ok ? v : resolve(spec.op, spec.params, spec.pid, spec.machines);
    if (!rs.ok) return { ok: false, reason: rs.reason, hours: 0, fuel: 0, cost: 0 };
    const fake = { power: rs.power.uid, impl: rs.impl && rs.impl.uid, worker: spec.worker, units: { shuttle: rs.shT && spec.helper ? {} : null }, contractor: null };
    const haH = haHFor(fake, true);
    const tiles = serpentine({ pid: spec.pid, op: spec.op }).length;
    const workH = tiles * HA / haH;
    const p = po.p, ex = yardExit();
    const travelH = 2 * pathLen(ex, route(ex, p.entry >= 0 ? p.entry : p.tiles[0], null)) / (def(rs.power).self ? 0.75 : 1);
    const pd = def(rs.power), id = rs.impl ? def(rs.impl) : null;
    const load = id && id.load != null ? id.load : 1;
    let fuel = pd.fuelLph * (workH * load + travelH * 0.45);
    if (rs.shT) fuel += def(rs.shT).fuelLph * 0.45 * workH * 0.6;
    const fuelCost = fuel * G.machines.fuelPrice();
    const wf = G.workers ? G.workers.wearFactor(spec.worker) : 1;
    const wearCost = [rs.power, rs.impl].filter(Boolean).reduce((a, m) => a + (m.rented ? 0 : def(m).price * (workH / G.machines.life(def(m))) * 0.6 * wf), 0);
    const w = G.workers.get(spec.worker), wageCost = w ? w.wage * (workH + travelH) / 10 : 0;
    const r1 = x => Math.round(x * 10) / 10;
    return {
      ok: v.ok, reason: v.ok ? (v.warn || '') : v.reason, hours: r1(workH + travelH), workH: r1(workH), travelH: r1(travelH), haH: Math.round(haH * 100) / 100,
      area: tiles * HA, tiles, fuel: Math.round(fuel), fuelCost: Math.round(fuelCost), wearCost: Math.round(wearCost), wageCost: Math.round(wageCost),
      cost: Math.round(fuelCost + wearCost + wageCost)
    };
  };

  // ===================== KONTRAKTOR (USŁUGI) =====================
  function fleetFor(op, crop, input, params) {
    const F = (power, impl) => ({ power, impl });
    switch (op) {
      case 'plow': return F('nordwal_220', 'plug_5');
      case 'cultivate': return F('nordwal_220', 'talerzowa_6');
      case 'lime': return F('bruzda_110', 'rozsiewacz_25');
      case 'fertilize':
        if (input === 'obornik') return F('nordwal_150', 'rozrzutnik_12');
        if (input === 'gnojowica') return F('nordwal_220', 'beczka_18');
        return F('bruzda_110', 'rozsiewacz_25');
      case 'sow':
        if (crop === 'ziemniaki') return F('nordwal_150', 'sadzarka_4');
        if (crop === 'kukurydza' || crop === 'slonecznik') return F('nordwal_150', 'punktowy_6');
        if (crop === 'buraki') return F('nordwal_150', 'punktowy_12');
        return F('nordwal_220', 'siewnik_6');
      case 'spray': return F('bruzda_110', 'oprysk_24');
      case 'harvest':
        if (crop === 'ziemniaki') return F('nordwal_150', 'ziemniak_2');
        if (crop === 'buraki') return F('burak_6', null);
        if ((params && params.mode === 'silage') || crop === 'kiszonka') return F('sieczkarnia_s', null);
        if (crop === 'kukurydza' || crop === 'slonecznik') return F('klosownik_k62', 'heder_kukurydza');
        return F('klosownik_k62', 'heder_62');
      case 'mow': return F('nordwal_150', 'kosiarka_9');
      case 'rake': return F('bruzda_110', 'zgrabiarka_8');
      case 'bale': return F('bruzda_110', 'prasa_ow');
    }
    return F('bruzda_110', null);
  }
  function balesPerHa(pid, params) {
    const crop = (params && params.crop) || (G.fields && G.fields.get && (G.fields.get(pid) || {}).crop);
    const cd = crop && G.CROPS && G.CROPS[crop];
    if (cd && cd.byproduct && cd.byproduct.perHa) {
      const u = G.PRODUCTS[cd.byproduct.id] && G.PRODUCTS[cd.byproduct.id].unit;
      return u === 'bela' ? cd.byproduct.perHa : cd.byproduct.perHa / 0.25;   // t → bele ≈ 250 kg
    }
    return G.S.parcels[pid] && G.S.parcels[pid].kind === 'meadow' ? 12 : 10;
  }
  J.contractorQuote = function (pid, op, params) {
    const po = parcelOk(pid);
    if (!po.ok) return { ok: false, reason: po.reason, price: 0, days: 0 };
    if (!opKnown(op)) return { ok: false, reason: 'Nieznany zabieg', price: 0, days: 0 };
    const R = G.CONTRACTOR_RATES, p = po.p, crop = cropOf(op, params, pid), input = M().inputFor(op, params);
    let rate = R[op] || 150, unit = 'ha', qty = p.area;
    if (op === 'fertilize' && input === 'obornik') rate = R.fertilize_obornik;
    if (op === 'fertilize' && input === 'gnojowica') rate = R.fertilize_gnojowica;
    if (op === 'sow' && crop === 'ziemniaki') rate = R.sow_ziemniaki;
    if (op === 'sow' && ['kukurydza', 'buraki', 'slonecznik'].includes(crop)) rate = R.sow_precision;
    if (op === 'harvest') {
      if (crop === 'ziemniaki') rate = R.harvest_ziemniaki;
      else if (crop === 'buraki') rate = R.harvest_buraki;
      else if ((params && params.mode === 'silage') || crop === 'kiszonka') rate = R.harvest_silage;
      else if (crop === 'kukurydza') rate = R.harvest_kukurydza;
    }
    if (op === 'bale') { rate = R.bale_per_bale; unit = 'bela'; qty = Math.round(p.area * balesPerHa(pid, params)); }
    const d = G.date(), m = d.month;
    const peak = (op === 'harvest' && (m === 6 || m === 7 || m === 8 || m === 9)) || ((op === 'sow' || op === 'plow' || op === 'cultivate') && (m === 3 || m === 8 || m === 9)) || (op === 'mow' && (m === 4 || m === 5));
    const mult = peak ? 1.1 : 1;
    const price = Math.max(350, Math.round(rate * qty * mult / 10) * 10);
    const r = G.rng((pid + 1) * 7919 + op.length * 104729 + d.dayIndex * 31 + (G.S.seed | 0));
    const days = peak ? 2 + ((r() * 4) | 0) : 1 + ((r() * 2) | 0);
    const c = CONTRACTORS[(pid + op.length) % CONTRACTORS.length];
    const fl = fleetFor(op, crop, input, params);
    const hoursEst = Math.round(p.area / G.machines.rate(fl.power, fl.impl, 1.12) * 10) / 10;
    return { ok: true, price, days, rate, unit, qty, peak, name: c.name, color: c.color, area: p.area, hoursEst, startText: G.dateText(startTickFor(days)) };
  };
  function startTickFor(days) { const d = G.date(); return (d.dayIndex + days) * TPD + 7; }
  J.hireContractor = function (pid, op, params) {
    const q = J.contractorQuote(pid, op, params);
    if (!q.ok) return { ok: false, reason: q.reason };
    if (J.list().some(j => j.pid === pid && j.op === op)) return { ok: false, reason: 'To zlecenie już jest w kolejce' };
    const cd = canDo(pid, op, params); if (!cd.ok) return { ok: false, reason: cd.reason || 'Zabieg teraz niemożliwy' };
    if (!G.finance.spend(q.price, 'usługi', 'Usługa: ' + J.opName(op) + ' — ' + G.S.parcels[pid].name + ' (' + q.name + ')')) return { ok: false, reason: 'Brak środków' };
    const job = baseJob(op, pid, params);
    const crop = cropOf(op, params, pid), fl = fleetFor(op, crop, M().inputFor(op, params), params);
    job.contractor = { name: q.name, color: q.color, price: q.price, startTick: startTickFor(q.days), power: fl.power, impl: fl.impl };
    job.reason = 'Usługa zaplanowana na ' + G.dateText(job.contractor.startTick);
    G.S.jobs.list.push(job);
    G.notify('📞 ' + q.name + ': ' + J.opName(op) + ' na ' + G.S.parcels[pid].name + ' — przyjadą ' + G.dateText(job.contractor.startTick) + ' (' + G.fmtMoney(q.price) + ')', 'info');
    return { ok: true, job, price: q.price, days: q.days };
  };

  // ===================== CYKL ŻYCIA ZLECENIA =====================
  J.list = () => (G.S.jobs ? G.S.jobs.list : []).filter(j => j.status === 'queued' || j.status === 'active');
  J.history = () => (G.S.jobs ? G.S.jobs.history : []);
  J.get = uid => (G.S.jobs.list.find(j => j.uid === uid) || G.S.jobs.history.find(j => j.uid === uid) || null);
  J.forParcel = pid => J.list().filter(j => j.pid === pid);
  J.progress = uid => { const j = J.get(uid); return j ? (j.total ? j.done / j.total : (j.status === 'done' ? 1 : 0)) : 0; };
  J.eta = function (uid) {
    const j = J.get(uid);
    if (!j || j.status !== 'active') return null;
    const left = Math.max(0, j.order.length - j.pos);
    return Math.round(left * HA / haHFor(j) * 10) / 10;
  };
  J.pause = function (uid) { const j = J.get(uid); if (!j || j.status === 'done') return false; j.userPaused = true; return true; };
  J.resume = function (uid) { const j = J.get(uid); if (!j) return false; j.userPaused = false; j.err = null; j.errTick = -1; j.fuelTick = -1; return true; };
  J.cancel = function (uid) {
    const j = J.get(uid);
    if (!j || (j.status !== 'queued' && j.status !== 'active')) return { ok: false, reason: 'Zlecenie nieaktywne' };
    if (j.contractor) {
      const frac = j.total ? 1 - j.done / j.total : 1;
      const refund = Math.round(j.contractor.price * frac * (j.status === 'queued' ? 0.9 : 0.7));
      if (refund > 0) G.finance.earn(refund, 'usługi', 'Zwrot za odwołaną usługę');
    }
    if (j.status === 'queued') { finish(j, 'cancelled'); return { ok: true }; }
    j.cancelled = true; j.userPaused = false;
    goHome(j);
    const s = j.units.shuttle;
    if (s && s.phase !== 'park') { s.phase = s.load > 0 ? 'toYard' : 'home'; s.path = route(tileOf(s), yardExit(), j.pid); s.pi = 0; }
    G.notify('↩️ Odwołano: ' + J.opName(j.op) + ' — ' + G.S.parcels[j.pid].name, 'info');
    return { ok: true };
  };

  const tileOf = u => G.idx(Math.max(0, Math.min(W - 1, Math.floor(u.x))), Math.max(0, Math.min(H - 1, Math.floor(u.y))));
  const home = j => j.contractor ? edgeStart() : yardExit();
  function newUnit(at) { return { x: G.tx(at) + 0.5, y: G.ty(at) + 0.5, angle: 0, path: [], pi: 0, mode: 'drive', w: null }; }

  function tryStart(j) {
    if (j.userPaused) { j.reason = 'Wstrzymane'; return; }
    if (j.contractor) {
      if (G.S.tick < j.contractor.startTick) return;
    } else {
      for (const uid of j.machines) {
        const m = G.machines.get(uid);
        if (!m) { G.notify('❌ Zlecenie anulowane — maszyna niedostępna', 'bad'); finish(j, 'cancelled'); return; }
        const r = G.machines.ready(uid);
        if (!r.ok) { j.reason = def(m).name + ': ' + r.reason; return; }
        if (m.busy && m.busy !== j.uid) { j.reason = 'Czeka na: ' + def(m).name; return; }
      }
      for (const wu of [j.worker, j.helper].filter(Boolean)) {
        if (!G.workers.get(wu)) { G.notify('❌ Zlecenie anulowane — brak pracownika', 'bad'); finish(j, 'cancelled'); return; }
        const a = G.workers.available(wu, j.uid, true);
        if (!a.ok) { j.reason = a.reason; return; }
      }
    }
    const cd = canDo(j.pid, j.op, j.params);
    if (!cd.ok) { G.notify('❌ ' + J.opName(j.op) + ' — ' + G.S.parcels[j.pid].name + ': ' + (cd.reason || 'zabieg niemożliwy'), 'bad'); if (j.contractor) G.finance.earn(Math.round(j.contractor.price * 0.9), 'usługi', 'Zwrot: usługa niewykonana'); finish(j, 'cancelled'); return; }
    const wo = weatherOk();
    if (!wo.ok) { j.reason = 'Pogoda: ' + (wo.reason || 'nie da się pracować'); return; }
    // start
    for (const uid of j.machines) G.machines.get(uid).busy = j.uid;
    for (const wu of [j.worker, j.helper].filter(Boolean)) G.workers.get(wu).busy = j.uid;
    j.status = 'active'; j.started = G.S.tick; j.reason = '';
    j.order = serpentine(j); j.pos = 0; j.done = 0; j.total = j.order.length;
    const pd = j.contractor ? G.MACHINES[j.contractor.power] : def(j.power), id = j.contractor ? G.MACHINES[j.contractor.impl] : (j.impl && def(j.impl));
    j.mode = (id && id.mode) || pd.mode || null;
    j.binCap = (!j.contractor && j.op === 'harvest') ? ((id && id.cap) || (pd.self && pd.cap) || 0) : 0;
    const start = home(j);
    const u = j.units.main = newUnit(start);
    u.spd = pd.self ? 0.75 : 1;
    if (j.order.length) { u.path = routeNear(start, j.order[0], j.pid); u.angle = initAngle(start, u.path); }
    j.stage = 'out';
    if (j.shTractor) {
      const s = j.units.shuttle = newUnit(start);
      s.phase = 'out'; s.load = 0; s.prod = {}; s.cap = def(j.shTrailer).cap;
      const p = G.S.parcels[j.pid];
      s.path = route(start, p.entry >= 0 ? p.entry : j.order[0], j.pid); s.angle = initAngle(start, s.path);
    }
    G.notify('🚜 Start: ' + J.opName(j.op) + ' — ' + G.S.parcels[j.pid].name + (j.contractor ? ' (' + j.contractor.name + ')' : ''), 'info', { parcel: j.pid, key: 'start_' + j.uid });
  }
  function initAngle(from, path) { if (!path.length) return 0; return Math.atan2(G.ty(path[0]) - G.ty(from), G.tx(path[0]) - G.tx(from)); }

  // ruch po ścieżce; zwraca niewykorzystany czas
  function turn(u, target, moved) {
    let d = target - u.angle;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    const max = moved * 2.4 + 1e-4;
    u.angle += Math.abs(d) <= max ? d : Math.sign(d) * max;
    if (u.angle > Math.PI) u.angle -= 2 * Math.PI; else if (u.angle < -Math.PI) u.angle += 2 * Math.PI;
  }
  function drive(j, u, dt, who) {
    let used = 0;
    u.mode = 'drive';
    while (u.pi < u.path.length && dt - used > 1e-9) {
      const i = u.path[u.pi], tx = G.tx(i) + 0.5, ty = G.ty(i) + 0.5;
      const dx = tx - u.x, dy = ty - u.y, dist = Math.hypot(dx, dy);
      const sp = speedAt(i) * (u.spd || 1) * (isNight() ? 0.85 : 1);
      const can = sp * (dt - used);
      if (dist > 1e-6) turn(u, Math.atan2(dy, dx), Math.min(can, dist));
      if (can >= dist) { u.x = tx; u.y = ty; used += dist / sp; u.pi++; }
      else { u.x += dx / dist * can; u.y += dy / dist * can; used = dt; }
    }
    if (used > 0) account(j, who, used, 'road');
    return dt - used;
  }
  const pathDone = u => u.pi >= u.path.length;

  // przyczyna postoju (null = można pracować)
  function blocked(j) {
    if (j.userPaused) return 'Wstrzymane przez gracza';
    const wo = weatherOk();
    if (!wo.ok) return 'Pogoda: ' + (wo.reason || 'przerwa');
    const h = G.date().hour;
    if (j.contractor) { if (h >= 22 || h < 6) return 'Kontraktor wznowi pracę o 6:00'; }
    else {
      if (!j.night && (h >= 22 || h < 6)) return 'Przerwa nocna';
      for (const uid of [j.power, j.impl]) if (uid) { const r = G.machines.ready(uid); if (!r.ok) return def(uid).name + ': ' + r.reason; }
      const a = G.workers.available(j.worker, j.uid, false);
      if (!a.ok) return a.reason;
      if (j.fuelTick === G.S.tick) return 'Brak paliwa i pieniędzy na tankowanie';
    }
    if (j.err && j.errTick === G.S.tick) return j.err;
    return null;
  }

  // koszty pracy: paliwo, motogodziny, zużycie, zmęczenie
  function account(j, who, dtH, kind) {
    if (dtH <= 0) return;
    if (who === 'main') j.hours = Math.round((j.hours + dtH) * 1000) / 1000;
    if (j.contractor) return;
    const night = isNight();
    let fuel = 0;
    if (who === 'main') {
      const pd = def(j.power), id = j.impl ? def(j.impl) : null;
      const load = kind === 'road' ? 0.45 : (id && id.load != null ? id.load : 1);
      fuel = pd.fuelLph * load * dtH;
      const wf = G.workers.wearFactor(j.worker);
      G.machines.use(j.power, dtH, wf * (kind === 'road' ? 0.6 : 1));
      if (j.impl && kind === 'work') G.machines.use(j.impl, dtH, wf);
      G.workers.exert(j.worker, dtH, night, 'field');
    } else {
      fuel = def(j.shTractor).fuelLph * 0.45 * dtH;
      const wf = G.workers.wearFactor(j.helper);
      G.machines.use(j.shTractor, dtH, wf * 0.6);
      G.machines.use(j.shTrailer, dtH, 0.5);
      G.workers.exert(j.helper, dtH, night, 'field');
    }
    j.fuel += fuel; j.fuelPending += fuel;
    if (j.fuelPending >= 20) flushFuel(j);
  }
  function flushFuel(j) {
    if (j.contractor || j.fuelPending <= 0.01) return;
    const l = Math.round(j.fuelPending * 100) / 100;
    const r = G.machines.refuel(l, J.opName(j.op));
    j.fuelCost += r.cost + r.fromStock * G.machines.fuelPrice();
    if (!r.ok) { j.fuelPending = r.missing; j.fuelTick = G.S.tick; G.notify('⛽ Brak paliwa i pieniędzy — ' + J.opName(j.op) + ' stoi', 'bad', { key: 'nofuel_' + j.uid }); }
    else j.fuelPending = 0;
  }

  function callWorkTile(j, i) {
    if (!(G.fields && G.fields.workTile)) return {};
    const q = j.contractor ? 0.92 : Math.max(0.3, G.workers.qualityOf(j.worker) - (isNight() ? 0.05 : 0) - Math.max(0, (G.machines.get(j.impl || j.power) || { wear: 0 }).wear - 0.6) * 0.3);
    const params = Object.assign({}, j.params, {
      quality: Math.round(q * 100) / 100, mode: j.mode, machine: j.contractor ? (j.contractor.impl || j.contractor.power) : def(j.impl || j.power).id,
      worker: j.worker, contractor: !!j.contractor, jobUid: j.uid
    });
    let r;
    try { r = G.fields.workTile(j.pid, i, j.op, params) || {}; } catch (e) { console.error('[workTile]', e); r = {}; }
    if (r.error) {
      if (j.err !== r.error) G.notify('⏸️ ' + J.opName(j.op) + ' — ' + G.S.parcels[j.pid].name + ': ' + r.error, 'bad', { key: 'joberr_' + j.uid, parcel: j.pid });
      j.err = r.error; j.errTick = G.S.tick;
      return r;
    }
    j.err = null;
    if (r.out) handleOut(j, r.out, !!r.stored);
    return r;
  }
  function handleOut(j, out, stored) {
    for (const id in out) {
      const q = +out[id];
      if (!(q > 0)) continue;
      j.outTotal[id] = Math.round(((j.outTotal[id] || 0) + q) * 1000) / 1000;
      const unit = G.PRODUCTS[id] && G.PRODUCTS[id].unit;
      if (j.binCap > 0 && (unit === 't' || !unit)) {
        j.bin += q;
        if (!stored) j.binProd[id] = (j.binProd[id] || 0) + q;
      } else if (!stored) G.inv.add(id, q);
    }
  }
  function deliver(prod) { for (const id in prod) if (prod[id] > 0) G.inv.add(id, Math.round(prod[id] * 1000) / 1000); }
  function deliverBin(j) { deliver(j.binProd); j.binProd = {}; j.bin = 0; }

  // ---------- jednostka główna ----------
  function stepMain(j, dt) {
    const u = j.units.main;
    for (let guard = 0; guard < 400 && dt > 1e-9; guard++) {
      const sig = j.stage + u.mode + j.pos + (u.unl ? u.unl.phase : '');
      const before = dt;
      if (j.stage === 'out') { dt = drive(j, u, dt, 'main'); if (pathDone(u)) { j.stage = 'work'; u.mode = 'work'; } }
      else if (j.stage === 'work') dt = work(j, u, dt);
      else if (j.stage === 'unload') dt = unload(j, u, dt);
      else if (j.stage === 'home') { dt = drive(j, u, dt, 'main'); if (pathDone(u)) { u.mode = 'park'; j.stage = 'parked'; checkFinish(j); return; } }
      else return;
      if (dt === before && sig === j.stage + u.mode + j.pos + (u.unl ? u.unl.phase : '')) break;
    }
  }
  function work(j, u, dt) {
    if (j.pos >= j.order.length) {
      // koniec pola: z przyczepą — przeładunek resztek, potem zjazd
      if (j.bin > 0 && j.units.shuttle && j.units.shuttle.phase !== 'park') { u.mode = 'wait'; j.reason = 'Przeładunek na przyczepę'; return dt; }
      completeWork(j); return dt;
    }
    const b = blocked(j);
    if (b) { u.mode = 'wait'; j.reason = b; return dt; }
    if (j.binCap > 0 && j.bin >= j.binCap - 1e-6) {
      if (j.units.shuttle) { u.mode = 'wait'; j.reason = 'Pełny zbiornik — czeka na przyczepę'; return dt; }
      startUnload(j, u); return dt;
    }
    j.reason = '';
    if (!u.w) {
      const to = j.order[j.pos], dist = Math.hypot(G.tx(to) + 0.5 - u.x, G.ty(to) + 0.5 - u.y);
      const tileH = HA / haHFor(j);
      u.w = { to, fx: u.x, fy: u.y, t: 0, total: tileH + Math.max(0, dist - 1.2) / SPD_OFF };
    }
    u.mode = 'work';
    const w = u.w, tx = G.tx(w.to) + 0.5, ty = G.ty(w.to) + 0.5;
    const step = Math.min(dt, w.total - w.t);
    w.t += step;
    const k = w.total > 0 ? w.t / w.total : 1, nx = w.fx + (tx - w.fx) * k, ny = w.fy + (ty - w.fy) * k;
    const moved = Math.hypot(nx - u.x, ny - u.y);
    if (Math.hypot(tx - w.fx, ty - w.fy) > 1e-6) turn(u, Math.atan2(ty - w.fy, tx - w.fx), Math.max(moved, step * 0.5));
    u.x = nx; u.y = ny;
    account(j, 'main', step, 'work');
    if (w.t >= w.total - 1e-9) {
      const r = callWorkTile(j, w.to);
      if (r.error) { u.mode = 'wait'; j.reason = r.error; return dt - step; }
      u.w = null; j.pos++; j.done++;
    }
    return dt - step;
  }
  function unloadTarget(j) {
    const id = j.impl ? def(j.impl) : def(j.power);
    if (j.mode === 'root' || id.cat === 'potato_harvester' || id.cat === 'beet_harvester') {
      const p = G.S.parcels[j.pid];
      return { idx: p.entry >= 0 ? p.entry : j.order[0], pile: true };
    }
    return { idx: yardExit(), pile: false };
  }
  function startUnload(j, u) {
    const t = unloadTarget(j);
    u.unl = { phase: 'go', target: t.idx, pile: t.pile, resume: j.pos > 0 ? j.order[j.pos - 1] : tileOf(u), timer: 0 };
    u.path = route(tileOf(u), t.idx, j.pid); u.pi = 0;
    j.stage = 'unload';
    j.reason = t.pile ? 'Wysypuje bunkier na pryzmę' : 'Jedzie rozładować zbiornik';
  }
  function unload(j, u, dt) {
    const L = u.unl;
    if (L.phase === 'go') { dt = drive(j, u, dt, 'main'); if (pathDone(u)) { L.phase = 'dump'; L.timer = UNLOAD_H; } return dt; }
    if (L.phase === 'dump') {
      u.mode = 'unload';
      const s = Math.min(dt, L.timer); L.timer -= s;
      if (L.timer <= 1e-9) {
        deliverBin(j);
        L.phase = 'back'; u.path = route(L.target, L.resume, j.pid); u.pi = 0;
      }
      return dt - s;
    }
    dt = drive(j, u, dt, 'main');
    if (pathDone(u)) { j.stage = 'work'; u.unl = null; u.mode = 'work'; j.reason = ''; }
    return dt;
  }
  function completeWork(j) {
    if (j.bin > 0 && (!j.units.shuttle || j.units.shuttle.phase === 'park')) {
      const t = unloadTarget(j);
      if (t.pile) deliverBin(j);   // ziemniaki/buraki na pryzmę; ziarno — rozładunek po powrocie na podwórze
    }
    if (G.fields && G.fields.complete) { try { G.fields.complete(j.pid, j.op, j.params); } catch (e) { console.error('[complete]', e); } }
    G.emit('opDone', j.pid, j.op);
    const out = Object.keys(j.outTotal).map(id => (G.fmtQty(id, j.outTotal[id]).trim() + ' ' + ((G.PRODUCTS[id] && G.PRODUCTS[id].name) || id))).join(', ');
    G.notify('✅ Zakończono: ' + J.opName(j.op) + ' — ' + G.S.parcels[j.pid].name + ' (' + G.fmtNum(j.total * HA, 2) + ' ha, ' + G.fmtNum(j.hours, 1) + ' h' + (j.contractor ? '' : ', ' + Math.round(j.fuel) + ' l ON') + ')' + (out ? ' — ' + out : ''), 'good', { parcel: j.pid });
    goHome(j);
  }
  function goHome(j) {
    const u = j.units.main;
    j.stage = 'home'; j.reason = j.cancelled ? 'Odwołane — wraca' : 'Wraca na podwórze';
    if (!u) return;
    u.w = null; u.unl = null;
    u.path = route(tileOf(u), home(j), j.pid); u.pi = 0;
  }

  // ---------- przyczepa (odwóz plonu) ----------
  function stepShuttle(j, dt) {
    const s = j.units.shuttle, m = j.units.main;
    if (!s || s.phase === 'park') return;
    const yard = yardExit(), p = G.S.parcels[j.pid], standby = p.entry >= 0 ? p.entry : j.order[0];
    const mainDone = j.stage === 'home' || j.stage === 'parked' || j.cancelled;
    for (let guard = 0; guard < 200 && dt > 1e-9; guard++) {
      const sig = s.phase + s.pi, before = dt;
      switch (s.phase) {
        case 'out': case 'back':
          dt = drive(j, s, dt, 'shuttle'); if (pathDone(s)) s.phase = 'standby'; break;
        case 'standby':
          s.mode = 'wait';
          if (s.load >= s.cap * 0.8 || (mainDone && s.load > 0)) { s.phase = 'toYard'; s.path = route(tileOf(s), yard, j.pid); s.pi = 0; }
          else if (mainDone) { s.phase = 'home'; s.path = route(tileOf(s), yard, j.pid); s.pi = 0; }
          else if (j.bin > 0 && (j.bin >= j.binCap * 0.7 || j.pos >= j.order.length)) { s.phase = 'fetch'; s.path = routeNear(tileOf(s), tileOf(m), j.pid); s.pi = 0; }
          else return;
          break;
        case 'fetch':
          dt = drive(j, s, dt, 'shuttle');
          if (pathDone(s)) {
            if (Math.hypot(s.x - m.x, s.y - m.y) <= 1.8 || j.stage !== 'work') {
              const q = Math.min(j.bin, s.cap - s.load);
              if (q > 0) {
                const f = q / j.bin;
                for (const id in j.binProd) { const x = j.binProd[id] * f; s.prod[id] = (s.prod[id] || 0) + x; j.binProd[id] -= x; }
                s.load += q; j.bin -= q;
                if (j.bin < 1e-6) { j.bin = 0; j.binProd = {}; }
              }
              s.phase = 'transfer'; s.timer = TRANSFER_H;
            } else { s.path = routeNear(tileOf(s), tileOf(m), j.pid); s.pi = 0; if (!s.path.length) s.phase = 'standby'; }
          }
          break;
        case 'transfer': {
          s.mode = 'unload';
          const st = Math.min(dt, s.timer); s.timer -= st; dt -= st;
          if (s.timer <= 1e-9) s.phase = 'standby';
          break;
        }
        case 'toYard':
          dt = drive(j, s, dt, 'shuttle'); if (pathDone(s)) { s.phase = 'dump'; s.timer = UNLOAD_H; } break;
        case 'dump': {
          s.mode = 'unload';
          const st = Math.min(dt, s.timer); s.timer -= st; dt -= st;
          if (s.timer <= 1e-9) {
            deliver(s.prod); s.prod = {}; s.load = 0;
            if (j.stage === 'home' || j.stage === 'parked' || j.cancelled) { s.phase = 'park'; s.mode = 'park'; checkFinish(j); return; }
            s.phase = 'back'; s.path = route(yard, standby, j.pid); s.pi = 0;
          }
          break;
        }
        case 'home':
          dt = drive(j, s, dt, 'shuttle'); if (pathDone(s)) { s.phase = 'park'; s.mode = 'park'; checkFinish(j); return; } break;
        default: return;
      }
      if (dt === before && sig === s.phase + s.pi) break;
    }
  }

  function checkFinish(j) {
    if (j.stage !== 'parked') return;
    if (j.units.shuttle && j.units.shuttle.phase !== 'park') return;
    finish(j, j.cancelled ? 'cancelled' : 'done');
  }
  function finish(j, status) {
    if (j.bin > 0) deliverBin(j);
    const s = j.units.shuttle;
    if (s && s.load > 0) { deliver(s.prod); s.prod = {}; s.load = 0; }
    flushFuel(j);
    for (const uid of j.machines) { const m = G.machines.get(uid); if (m && m.busy === j.uid) m.busy = null; }
    for (const wu of [j.worker, j.helper]) { const w = wu && G.workers.get(wu); if (w && w.busy === j.uid) w.busy = null; }
    j.status = status; j.finished = G.S.tick; j.reason = '';
    G.S.jobs.list = G.S.jobs.list.filter(x => x !== j);
    const h = Object.assign({}, j); delete h.order; delete h.units;
    G.S.jobs.history.unshift(h);
    if (G.S.jobs.history.length > 40) G.S.jobs.history.length = 40;
    if (status === 'done') G.emit('jobDone', h);
  }

  // ===================== PĘTLA =====================
  G.on('frame', dtH => {
    if (!G.S || !G.S.jobs || !(dtH > 0)) return;
    for (const j of G.S.jobs.list.slice()) {
      try {
        if (j.status === 'queued') tryStart(j);
        if (j.status === 'active') { stepMain(j, dtH); if (j.status === 'active') stepShuttle(j, dtH); }
      } catch (e) { console.error('[jobs]', e); }
    }
  });
  G.on('tick', () => {
    // ponowna próba po błędzie (np. brak nasion) / braku paliwa — co godzinę gry
    for (const j of G.S.jobs.list) if (j.fuelPending > 0 && j.fuelTick >= 0 && j.fuelTick < G.S.tick) flushFuel(j);
  });

  // ===================== DLA GRAFIKI =====================
  // [{ x, y, angle, parts:[{model, color}], working, dust, lights, kind: 'own'|'contractor'|'parked', unit, jobUid, uid?, label, waiting, fill?, inGarage? }]
  J.vehicles = function () {
    const out = [];
    if (!G.S || !G.S.jobs) return out;
    const h = G.date().hour + (G.hourFrac || 0);
    const wt = G.weather && G.weather.type;
    const dark = h >= 19.5 || h < 5.5 || wt === 'fog' || wt === 'storm';
    const wet = wt === 'rain' || wt === 'storm' || wt === 'snow';
    const busySet = new Set();
    for (const j of G.S.jobs.list) {
      if (j.status !== 'active') continue;
      const ctr = j.contractor;
      const pd = ctr ? G.MACHINES[ctr.power] : def(j.power), id = ctr ? (ctr.impl && G.MACHINES[ctr.impl]) : (j.impl && def(j.impl));
      const u = j.units.main;
      if (u && u.mode !== 'park') {
        const parts = [{ model: pd.model, color: ctr ? ctr.color : pd.color }];
        if (id) parts.push({ model: id.model, color: ctr ? shade(ctr.color) : id.color });
        const working = j.stage === 'work' && u.mode === 'work';
        out.push({
          x: u.x, y: u.y, angle: u.angle, parts, working, dust: working && !!DUSTY[j.op] && !wet, lights: dark && u.mode !== 'wait',
          kind: ctr ? 'contractor' : 'own', unit: 'main', jobUid: j.uid, label: (ctr ? ctr.name + ': ' : '') + J.opName(j.op),
          waiting: u.mode === 'wait', reason: j.reason, fill: j.binCap ? Math.min(1, j.bin / j.binCap) : 0
        });
      }
      const s = j.units.shuttle;
      if (s && s.phase !== 'park') {
        const td = def(j.shTractor), rd = def(j.shTrailer);
        out.push({
          x: s.x, y: s.y, angle: s.angle, parts: [{ model: td.model, color: td.color }, { model: rd.model, color: rd.color }],
          working: false, dust: false, lights: dark && s.mode !== 'wait', kind: 'own', unit: 'shuttle', jobUid: j.uid,
          label: 'Odwóz plonu', waiting: s.mode === 'wait', fill: s.cap ? Math.min(1, s.load / s.cap) : 0
        });
      }
      for (const uid of j.machines) busySet.add(uid);
    }
    // maszyny na podwórzu (postój) — inGarage: true = stoją w garażu (grafika może je pominąć)
    const yd = G.S.farm.yard, spots = [];
    for (let ty = yd.y + yd.h - 1; ty >= yd.y; ty--) for (let tx = yd.x + yd.w - 1; tx >= yd.x; tx--) {
      const i = G.idx(tx, ty);
      if (G.S.map.t[i] !== T.YARD) continue;
      if (G.buildings && G.buildings.at && G.buildings.at(i)) continue;
      spots.push(i);
    }
    let k = 0;
    for (const m of G.machines.list()) {
      if (busySet.has(m.uid) || m.busy) continue;
      const d = def(m), i = spots.length ? spots[k % spots.length] : yardExit(), lap = spots.length ? Math.floor(k / spots.length) : k;
      k++;
      out.push({
        x: G.tx(i) + 0.5 + lap * 0.25, y: G.ty(i) + 0.5, angle: Math.PI / 2, parts: [{ model: d.model, color: d.color }], working: false, dust: false, lights: false,
        kind: 'parked', unit: 'parked', uid: m.uid, jobUid: null, label: d.name, waiting: false, inGarage: !!m.stored, broken: !!m.broken
      });
    }
    return out;
  };
  function shade(hex) {
    const n = parseInt(hex.slice(1), 16), f = 0.75;
    const r = Math.round((n >> 16 & 255) * f), g = Math.round((n >> 8 & 255) * f), b = Math.round((n & 255) * f);
    return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
  }

  // ===================== START I WALIDACJA STANU =====================
  G.on('newGame', () => { G.S.jobs = { list: [], history: [] }; });
  G.on('load', () => {
    const S = G.S;
    if (!S.jobs || !Array.isArray(S.jobs.list)) S.jobs = { list: [], history: [] };
    if (!Array.isArray(S.jobs.history)) S.jobs.history = [];
    S.jobs.list = S.jobs.list.filter(j => j && S.parcels[j.pid] && (j.status === 'queued' || j.status === 'active'));
    // spójność zajętości maszyn i ludzi
    const act = new Map();
    for (const j of S.jobs.list) if (j.status === 'active') {
      if (!j.units) j.units = { main: null, shuttle: null };
      if (!j.units.main) { j.stage = 'home'; j.units.main = newUnit(home(j)); }
      if (!Array.isArray(j.order)) j.order = [];
      for (const uid of j.machines || []) act.set('m' + uid, j.uid);
      for (const wu of [j.worker, j.helper]) if (wu) act.set('w' + wu, j.uid);
    }
    for (const m of S.machines || []) m.busy = act.get('m' + m.uid) || null;
    for (const w of S.workers || []) w.busy = act.get('w' + w.uid) || null;
    wc.tick = -1;
  });
})();
