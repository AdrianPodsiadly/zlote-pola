// Złote Pola — zlecenia prac polowych i transportu, pojazdy na mapie, usługi kontraktorów → G.jobs (agent: maszyny, ludzie, prace)
//
// Stan: G.S.jobs = { list: [zlecenia aktywne i w kolejce], history: [zakończone, max 40] }
// Zlecenie: { uid, op, pid, params, machines:[uid], worker, helpers:[uid], night, status: 'queued'|'active'|'done'|'cancelled',
//             stage: 'out'|'work'|'home'|'parked', reason (dlaczego czeka), order:[kafle w kolejności serpentyny], pos, done, total,
//             kind: null|'bunker'|'continuous' (zbiór), bin (t w zbiorniku), binCap, binProd, lastOut, fuel (l), fuelCost (zł), hours,
//             outTotal {produkt: ilość}, sets: [{ tractor, trailer, trailer2 (druga przyczepa|null), helper (uid|null), tid, rid, rid2 (id katalogu), hired, retired }],
//             transport: null | { sets, price } (wynajęty transport), contractor: null | { name, color, price, startTick, power, impl },
//             units: { main, shuttles: [] } }
// Jednostka (pojazd): { x, y (kafel, ułamkowy; środek kafla = +0.5), angle (rad, 0 = +x kafli), path:[idx], pi, mode, w (segment pracy) }
//
// Przebieg (FLOTA z trwałymi pozycjami — G.S.machines[*].x/y/hitch): ciągnik rusza z miejsca, gdzie stoi; jeśli narzędzie nie jest
// doczepione — jedzie po nie (stage 'fetch'), podczepia (postój M.HITCH_H), potem jedzie po drogach (BFS po ROAD/ASPHALT/YARD; przez własne
// pole wolno) → obróbka pasami w serpentynie wzdłuż dłuższego boku działki (czas kafla = 0,25 ha / wydajność) → G.fields.workTile(pid, i, op, params)
// dla każdego kafla → G.fields.complete → 'opDone' → powrót na własne miejsce postojowe → odczepienie narzędzia (chyba że spec.keepHitched)
// → 'jobDone'. Zestawy transportowe tak samo zbierają swoje przyczepy (phase 'pick'). Pozycje maszyn są co klatkę zapisywane do G.S.machines.
//
// ZBIÓR (logistyka wg autora gry):
//   • Zbiór ZAWSZE wymaga co najmniej jednego zestawu transportowego: ciągnik + przyczepa + kierowca (helpers) — albo wynajętego
//     transportu (spec.transport = liczba zestawów, usługa z kierowcą). Kontraktor przyjeżdża z kombajnem i własnymi zestawami.
//   • Kombajn zbożowy / ziemniaczany / buraczany ('bunker'): napełnia zbiornik (tankL / cap t) w czasie pracy. Od 70 % zbiornika woła przyczepę;
//     przyczepa podjeżdża i staje z LEWEJ strony kombajnu, kombajn staje, rozkłada rurę (auger 'out') i przeładowuje ślimakiem
//     (G.augerTph(kombajn) t/h gry — zależy od unloadLps). Pełna przyczepa (≥ 85 %) jedzie drogami pod silos/magazyn
//     (G.buildings.unloadPoint(produkt)), wysypuje i wraca na wjazd pola. Gdy NIGDZIE nie ma miejsca — przyczepa zostaje pełna
//     na podwórzu jako magazyn tymczasowy (G.S.machines[*].fill, G.machines.yardStorage), zestaw odpada ze zlecenia.
//   • Ciągnik może ciągnąć 2 przyczepy (pierwsza z tylnym zaczepem, tridem tylko ostatnia): ładowność się sumuje, jazda wolniejsza.
//   • Pełny zbiornik i brak przyczepy przy kombajnie → kombajn STOI („Czeka na przyczepę — zbiornik pełny”).
//   • Kombajn nie kończy pracy, nie wraca i nie wyjeżdża na drogę z ziarnem w zbiorniku — po ostatnim kaflu (albo po odwołaniu)
//     czeka na opróżnienie, dopiero potem complete i powrót. Na drodze zbiornik jest zawsze pusty, rura złożona.
//   • Sieczkarnia ('continuous'): bez zbiornika — pracuje tylko z przyczepą jadącą równolegle (lewa strona), zielonka leci na bieżąco.
//   Plon trafia do G.inv dopiero po wysypaniu przyczepy na podwórzu (chyba że G.fields.workTile zwróci { stored: true }).
(function () {
  const C = G.CFG, T = G.T, W = C.W, H = C.H, N = W * H, TPD = C.TICKS_PER_DAY, HA = C.TILE_HA;
  const J = G.jobs = {};
  const M = () => G.machines;
  const def = x => G.machines.def(x);

  // prędkości przejazdu w kaflach/h (skala dojazdów skompresowana dla czytelności; 1 kafel = 50 m)
  const SPD = { [T.ASPHALT]: 80, [T.ROAD]: 55, [T.YARD]: 25 };
  const SPD_OFF = 30;
  const UNLOAD_H = 0.25;        // wysyp przyczepy na podwórzu
  // Przeładunek ślimakiem: wydajność z G.augerTph(definicja kombajnu) — domyślnie 60 t/h gry (patrz data/machines.js).
  const AUGER_TPH = 60;
  const augerOf = j => j.augerTph > 0 ? j.augerTph : AUGER_TPH;
  const DOUBLE_SPD = 0.85;      // zestaw z 2 przyczepami jedzie wolniej
  const CALL_AT = 0.7, TRAILER_FULL = 0.85, FOLLOW_SPD = 30, SIDE = 0.95;
  const TRANSPORT_PER_H = 160;  // usługa transportu: ciągnik + przyczepa + kierowca, zł/h
  const DUSTY = { plow: 1, cultivate: 1, harvest: 1, sow: 1, bale: 1, rake: 1, mow: 0, spray: 0, fertilize: 1, lime: 1 };
  const OP_NAMES = { plow: 'Orka', cultivate: 'Uprawa', lime: 'Wapnowanie', fertilize: 'Nawożenie', sow: 'Siew', spray: 'Oprysk', harvest: 'Zbiór', bale: 'Prasowanie', mow: 'Koszenie', rake: 'Zgrabianie' };
  J.opName = op => (G.fields && G.fields.OPS && G.fields.OPS[op] && G.fields.OPS[op].name) || OP_NAMES[op] || op;
  J.AUGER_TPH = AUGER_TPH;
  const trailerFill = m => { let t = 0; if (m && m.fill) for (const k in m.fill) t += +m.fill[k] || 0; return t; };
  J.trailerFill = trailerFill;

  const CONTRACTORS = [
    { name: 'Usługi Rolnicze Kowalczyk', color: '#e07b00' },
    { name: 'Agro-Serwis Mazur', color: '#4a6fa5' },
    { name: 'ZUR Nowak i Synowie', color: '#8a4fb0' }
  ];
  const TRANSPORT_FIRM = { name: 'Transport Rolny Wójcik', color: '#6b6f73' };
  const HIRED_SET = { tid: 'nordwal_150', rid: 'przyczepa_14' };

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
  // po własnych działkach (pola i łąki gracza) wolno jechać na przełaj
  const ownLand = i => { const pid = G.S.map.parcel[i]; if (pid < 0) return false; const p = G.S.parcels[pid]; return !!p && (p.owner === 'player' || p.leased); };
  const passFor = (pid, extra, own) => i => G.isDrivable(i) || (pid != null && G.S.map.parcel[i] === pid) || i === extra || (own && ownLand(i));
  // trasa z kafla from do kafla to (wolno jechać po drogach, podwórzu i działce pid; own: także po wszystkich działkach gracza)
  function route(from, to, pid, own) {
    if (from === to) return [];
    let p = bfs(from, i => i === to, passFor(pid, to, own));
    if (!p) p = bfs(from, i => i === to, i => G.S.map.t[i] !== T.WATER);   // awaryjnie na przełaj
    return p || [to];
  }
  // trasa do dowolnego sąsiada kafla target (dojazd na pole od strony drogi)
  function routeNear(from, target, pid, own) {
    const nbs = new Set(G.N4(target));
    const pass = passFor(pid, -1, own);
    let p = bfs(from, i => nbs.has(i) && i !== target, i => pass(i) && i !== target);
    if (!p) p = route(from, target, pid, own);
    return p;
  }
  J.route = route;
  J.routeNear = routeNear;
  J.ownLand = ownLand;
  // czy po kaflu można jechać rozkazem/ręcznie (drogi, podwórze, własne działki); niedostępne: woda, las, zabudowa wsi, budynki
  J.passable = i => G.isDrivable(i) || ownLand(i);
  const speedAt = i => SPD[G.S.map.t[i]] || SPD_OFF;
  function pathLen(from, path) { let L = 0, px = G.tx(from), py = G.ty(from); for (const i of path) { L += Math.hypot(G.tx(i) - px, G.ty(i) - py) / speedAt(i); px = G.tx(i); py = G.ty(i); } return L; }

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

  // kolejność kafli: pasy wzdłuż dłuższego boku (wg faktycznych kafli działki), serpentyna, start od strony wjazdu
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
  const helpersOf = spec => {
    const arr = Array.isArray(spec.helpers) ? spec.helpers.slice() : [];
    if (spec.helper != null && !arr.includes(spec.helper)) arr.push(spec.helper);
    return arr.filter((u, k) => u != null && u !== spec.worker && arr.indexOf(u) === k);
  };
  // z listy uid wybiera: maszynę napędową, narzędzie, zestawy transportowe (ciągnik + przyczepa + kierowca)
  function resolve(op, params, pid, uids, helpers, hiredN, pairs) {
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
      const trs = ms.filter(m => def(m).cat === 'tractor').sort((a, b) => def(a).hp - def(b).hp);
      if (!trs.length) return { ok: false, reason: 'Brak ciągnika' };
      power = trs.find(m => def(m).hp >= req);
      if (!power) return { ok: false, reason: 'Za mała moc: ' + Math.max(...trs.map(m => def(m).hp)) + ' KM, ' + def(impl).name + ' wymaga ' + req + ' KM' };
    }
    // zestawy transportowe (tylko przy zbiorze)
    const sets = [];
    if (op === 'harvest') {
      const full = ms.find(m => def(m).cat === 'trailer' && trailerFill(m) > 1e-6);
      if (full) return { ok: false, reason: def(full).name + ' stoi pełna na podwórzu (magazyn tymczasowy) — najpierw sprzedaj albo zmagazynuj plon' };
      const trailers = ms.filter(m => def(m).cat === 'trailer');
      const tractors = ms.filter(m => m !== power && def(m).cat === 'tractor');
      const r = pairSets(trailers, tractors, helpers || [], pairs);
      sets.push(...r.sets);
      for (let k = 0; k < (hiredN | 0); k++) sets.push({ tractor: null, trailer: null, trailer2: null, helper: null, tid: HIRED_SET.tid, rid: HIRED_SET.rid, rid2: null, hired: true });
      if (!sets.length) {
        const why = !trailers.length ? 'brak przyczepy' : !tractors.length ? 'brak drugiego ciągnika do przyczepy' : !(helpers || []).length ? 'brak kierowcy przyczepy' : (r.why || 'ciągnik za słaby do przyczepy');
        return { ok: false, need: 'transport', reason: 'Zbiór wymaga zestawu ciągnik + przyczepa + kierowca (' + why + '). Wynajmij przyczepę/ciągnik, zatrudnij kierowcę albo zamów transport.' };
      }
    }
    return { ok: true, power, impl, sets, crop };
  }
  // Dobór zestawów: każdy kierowca dostaje ciągnik i największą przyczepę, jaką ten ciągnik uciągnie; pozostałe przyczepy
  // dopinane jako druga (trailer2) do zestawu, którego pierwsza przyczepa ma tylny zaczep, a ciągnik ma dość mocy
  // (reqHp pary = (reqHp1 + reqHp2) × 0,8). pairs: [[uid1, uid2], ...] — pary wymuszone przez gracza/UI.
  function pairSets(trailers, tractors, helpers, pairs) {
    trailers = trailers.slice().sort((a, b) => def(b).cap - def(a).cap);
    tractors = tractors.slice().sort((a, b) => def(a).hp - def(b).hp);
    const hs = helpers.slice(), sets = [], used = new Set();
    let why = '';
    // pary wymuszone
    for (const pr of pairs || []) {
      const a = trailers.find(m => m.uid === pr[0]), b = trailers.find(m => m.uid === pr[1]);
      if (!a || !b || used.has(a.uid) || used.has(b.uid)) continue;
      const po = G.trailerPairOk(def(a), def(b));
      if (!po.ok) { why = po.reason; continue; }
      const k = tractors.findIndex(t => def(t).hp >= po.reqHp);
      if (k < 0 || !hs.length) { why = k < 0 ? 'ciągnik za słaby do pary przyczep (' + po.reqHp + ' KM)' : 'brak kierowcy'; continue; }
      const t = tractors.splice(k, 1)[0];
      used.add(a.uid); used.add(b.uid);
      sets.push({ tractor: t.uid, trailer: a.uid, trailer2: b.uid, helper: hs.shift(), tid: t.id, rid: a.id, rid2: b.id, hired: false });
    }
    // pojedyncze
    for (const tr of trailers) {
      if (used.has(tr.uid)) continue;
      const k = tractors.findIndex(t => def(t).hp >= (def(tr).reqHp || 0));
      if (k < 0) { why = 'ciągnik za słaby do przyczepy ' + def(tr).name + ' (' + def(tr).reqHp + ' KM)'; continue; }
      if (!hs.length) break;
      const t = tractors.splice(k, 1)[0];
      used.add(tr.uid);
      sets.push({ tractor: t.uid, trailer: tr.uid, trailer2: null, helper: hs.shift(), tid: t.id, rid: tr.id, rid2: null, hired: false });
    }
    // reszta przyczep → jako druga w zestawie (najpierw do ciągników z największym zapasem mocy)
    for (const tr of trailers) {
      if (used.has(tr.uid)) continue;
      let best = null, bestSpare = -1;
      for (const st of sets) {
        if (st.trailer2) continue;
        const po = G.trailerPairOk(G.MACHINES[st.rid], def(tr));
        if (!po.ok) continue;
        const spare = G.MACHINES[st.tid].hp - po.reqHp;
        if (spare >= 0 && spare > bestSpare) { best = st; bestSpare = spare; }
      }
      if (!best) continue;
      best.trailer2 = tr.uid; best.rid2 = tr.id; used.add(tr.uid);
    }
    return { sets, why };
  }
  J.pairSets = (trailerUids, tractorUids, helpers, pairs) => pairSets(trailerUids.map(u => M().get(u)).filter(Boolean), tractorUids.map(u => M().get(u)).filter(Boolean), helpers || [], pairs);
  const setCap = st => (G.MACHINES[st.rid] ? G.MACHINES[st.rid].cap : 0) + (st.rid2 && G.MACHINES[st.rid2] ? G.MACHINES[st.rid2].cap : 0);
  const setTrailers = st => [st.trailer, st.trailer2].filter(Boolean);

  function harvestKind(pd, id) {
    const wd = id && id.cat !== 'header' ? id : pd;
    if (wd.cat === 'forage_harvester') return 'continuous';
    return 'bunker';
  }
  function haHFor(job, day) {
    const c = job.contractor;
    const pd = c ? G.MACHINES[c.power] : def(job.power), id = c ? (c.impl ? G.MACHINES[c.impl] : null) : (job.impl ? def(job.impl) : null);
    if (!pd) return 0.1;
    const skill = c ? 1.12 : (G.workers ? G.workers.speedFactor(job.worker) : 1);
    let r = G.machines.rate(pd.id, id && id.id, skill);
    if (!day && isNight()) r *= 0.8;
    const wd = id || pd;
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
  const wc = { tick: -1, r: { ok: true } };
  function weatherOk() {
    if (!(G.weather && G.weather.canWork)) return { ok: true };
    if (wc.tick !== G.S.tick) { wc.tick = G.S.tick; try { wc.r = G.weather.canWork() || { ok: true }; } catch (e) { wc.r = { ok: true }; } }
    return wc.r;
  }

  J.validate = function (spec) {
    spec = spec || {};
    const { op, pid } = spec;
    if (!opKnown(op)) return { ok: false, reason: 'Nieznany zabieg' };
    const po = parcelOk(pid); if (!po.ok) return po;
    if (J.list().some(j => j.pid === pid && j.op === op)) return { ok: false, reason: 'To zlecenie już jest w kolejce' };
    const cd = canDo(pid, op, spec.params); if (!cd.ok) return { ok: false, reason: cd.reason || 'Zabieg teraz niemożliwy' };
    const w = G.workers && G.workers.get(spec.worker);
    if (!w) return { ok: false, reason: 'Wybierz pracownika' };
    const hs = helpersOf(spec);
    for (const h of hs) if (!G.workers.get(h)) return { ok: false, reason: 'Nieznany kierowca przyczepy' };
    const rs = resolve(op, spec.params, pid, spec.machines, hs, op === 'harvest' ? spec.transport : 0, spec.pairs);
    if (!rs.ok) return rs;
    const own = rs.sets.filter(s => !s.hired);
    const ownMachines = [rs.power, rs.impl].concat(own.map(s => M().get(s.tractor)), own.flatMap(s => setTrailers(s).map(u => M().get(u))));
    for (const m of ownMachines) if (m) {
      const r = G.machines.ready(m.uid); if (!r.ok) return { ok: false, reason: def(m).name + ': ' + r.reason };
    }
    const waits = [];
    for (const m of ownMachines) if (m && m.busy) waits.push(def(m).name);
    for (const u of [spec.worker].concat(own.map(s => s.helper))) { const x = G.workers.get(u); if (x && x.busy) waits.push(x.name); }
    const wo = weatherOk();
    if (!wo.ok) waits.push('pogoda: ' + (wo.reason || 'nie da się pracować'));
    const unusedH = hs.length - own.length;
    rs.warn = [unusedH > 0 && op === 'harvest' ? 'Nie wszyscy kierowcy mają zestaw' : '', waits.length ? 'Zlecenie poczeka na: ' + waits.join(', ') : ''].filter(Boolean).join('. ');
    return rs;
  };

  J.create = function (spec) {
    const v = J.validate(spec);
    if (!v.ok) return { ok: false, reason: v.reason, need: v.need };
    const p = G.S.parcels[spec.pid];
    const job = baseJob(spec.op, spec.pid, spec.params);
    const own = v.sets.filter(s => !s.hired);
    Object.assign(job, {
      machines: [v.power, v.impl].filter(Boolean).map(m => m.uid).concat(own.map(s => s.tractor), own.flatMap(s => setTrailers(s))),
      power: v.power.uid, impl: v.impl ? v.impl.uid : null, sets: v.sets.map(s => Object.assign({}, s)),
      worker: spec.worker, helpers: own.map(s => s.helper), night: spec.night !== false, keepHitched: !!spec.keepHitched
    });
    const hiredN = v.sets.length - own.length;
    if (hiredN > 0) {
      const q = J.transportQuote(spec.pid, hiredN, spec);
      if (!G.finance.spend(q.price, 'usługi', 'Transport do zbioru: ' + hiredN + ' zest. (' + TRANSPORT_FIRM.name + ')')) return { ok: false, reason: 'Brak środków na transport' };
      job.transport = { sets: hiredN, price: q.price, name: TRANSPORT_FIRM.name, color: TRANSPORT_FIRM.color };
    }
    G.S.jobs.list.push(job);
    const nTr = v.sets.reduce((a, s) => a + 1 + (s.trailer2 ? 1 : 0), 0);
    G.notify('📋 Zlecenie: ' + J.opName(job.op) + ' — ' + p.name + (v.sets.length ? ' (' + v.sets.length + ' zest., ' + nTr + ' przyczep' + (nTr === 1 ? 'a' : nTr < 5 ? 'y' : '') + ')' : '') + (v.warn ? ' — ' + v.warn : ''), 'info');
    return { ok: true, job, warn: v.warn || '' };
  };
  function baseJob(op, pid, params) {
    return {
      uid: G.uid(), op, pid, params: params ? JSON.parse(JSON.stringify(params)) : {}, machines: [], worker: null, helpers: [], night: true,
      status: 'queued', stage: null, reason: '', created: G.S.tick, started: 0, finished: 0, power: null, impl: null, sets: [],
      contractor: null, transport: null, order: [], pos: 0, done: 0, total: 0, kind: null, bin: 0, binCap: 0, binProd: {}, lastOut: 0, augerTph: 0,
      fuel: 0, fuelPending: 0, fuelCost: 0, hours: 0, outTotal: {}, units: { main: null, shuttles: [] }, err: null, errTick: -1, fuelTick: -1,
      cancelled: false, userPaused: false, mode: null, want: false, keepHitched: false, homeTile: -1
    };
  }

  // usługa transportu do zbioru (ciągnik 150 KM + przyczepa 14 t + kierowca), płatna z góry wg szacowanych godzin
  J.transportQuote = function (pid, n, spec) {
    const p = G.S.parcels[pid];
    n = Math.max(1, n | 0);
    let workH = p ? p.area / 2.5 : 4;
    if (spec && spec.machines && spec.machines.length) {
      const pw = spec.machines.map(u => M().get(u)).find(m => m && M().isPower(def(m)) && (def(m).self || def(m).cat === 'tractor'));
      const im = spec.machines.map(u => M().get(u)).find(m => m && !M().isPower(def(m)) && def(m).cat !== 'trailer');
      if (pw) workH = p.area / Math.max(0.2, G.machines.rate(pw.id, im && im.id, 1));
    }
    const hours = Math.max(4, Math.ceil(workH * 1.15 + 1));
    return { ok: !!p, sets: n, hours, perHour: TRANSPORT_PER_H, price: Math.round(hours * TRANSPORT_PER_H * n / 10) * 10, name: TRANSPORT_FIRM.name };
  };

  // podpowiedź zestawu: { ok:true, op, pid, params, machines, worker, helpers, label }
  //   albo { ok:false, need: 'machine'|'worker'|'transport', reason, rent:[{id, name, perDay}], hire:[cid], transport: quote, contractor: quote }
  J.suggest = function (op, pid, params) {
    const fail = (need, reason, extra) => Object.assign({ ok: false, need, reason, rent: [], hire: [], contractor: J.contractorQuote(pid, op, params) }, extra || {});
    const combos = G.machines.compatible(op, params, pid).filter(c => c.available);
    if (!combos.length) {
      const rent = G.machines.catalogFor(op, Object.assign({ crop: cropOf(op, params, pid) }, params)).filter(d => d.rentPerDay > 0).map(d => ({ id: d.id, name: d.name, perDay: d.rentPerDay }));
      return fail('machine', 'Brak wolnej maszyny do zabiegu: ' + J.opName(op), { rent });
    }
    const free = G.workers.list().filter(w => !w.busy && w.role !== 'barn').sort((a, b) => b.skills.field - a.skills.field || b.energy - a.energy);
    if (!free.length) return fail('worker', 'Brak wolnego pracownika', { hire: G.workers.candidates().map(c => c.cid) });
    const c = combos[0];
    const spec = { ok: true, op, pid, params, machines: [c.tractor, c.implement].filter(Boolean), worker: free[0].uid, helpers: [], label: c.label };
    if (op === 'harvest') {
      const freeOk = m => !m.busy && G.machines.ready(m.uid).ok && !spec.machines.includes(m.uid);
      const trailers = G.machines.list().filter(m => def(m).cat === 'trailer' && freeOk(m) && trailerFill(m) <= 1e-6).sort((a, b) => def(b).cap - def(a).cap);
      const tractors = G.machines.list().filter(m => def(m).cat === 'tractor' && freeOk(m)).sort((a, b) => def(a).hp - def(b).hp);
      const drivers = free.slice(1);
      const pr = pairSets(trailers, tractors, drivers.slice(0, 2).map(w => w.uid), null);
      for (const st of pr.sets) {
        spec.machines.push(st.tractor, ...setTrailers(st));
        spec.helpers.push(st.helper);
      }
      if (!spec.helpers.length) {
        const rent = [];
        if (!trailers.length) rent.push(...G.machines.catalog('trailer').filter(d => d.rentPerDay > 0).map(d => ({ id: d.id, name: d.name, perDay: d.rentPerDay })));
        if (!tractors.length) rent.push(...G.machines.catalog('tractor').filter(d => d.rentPerDay > 0).map(d => ({ id: d.id, name: d.name, perDay: d.rentPerDay })));
        return fail('transport', 'Zbiór wymaga zestawu ciągnik + przyczepa + kierowca' + (!trailers.length ? ' — brak przyczepy' : !tractors.length ? ' — brak drugiego ciągnika' : ' — brak kierowcy'),
          { rent, hire: drivers.length ? [] : G.workers.candidates().map(x => x.cid), transport: J.transportQuote(pid, 1, spec), partial: spec });
      }
      spec.label += ' + ' + spec.helpers.length + ' × przyczepa';
    }
    return spec;
  };

  // ===================== SZACUNEK =====================
  J.estimate = function (spec) {
    if (spec && spec.contractor) { const q = J.contractorQuote(spec.pid, spec.op, spec.params); return Object.assign({ hours: q.hoursEst || 0, fuel: 0 }, q, { cost: q.price }); }
    const po = parcelOk(spec && spec.pid);
    if (!po.ok) return { ok: false, reason: po.reason, hours: 0, fuel: 0, cost: 0 };
    const v = J.validate(spec);
    const rs = v.ok ? v : resolve(spec.op, spec.params, spec.pid, spec.machines, helpersOf(spec), spec.transport);
    if (!rs.ok) return { ok: false, reason: rs.reason, need: rs.need, hours: 0, fuel: 0, cost: 0 };
    const fake = { power: rs.power.uid, impl: rs.impl && rs.impl.uid, worker: spec.worker, contractor: null };
    const haH = haHFor(fake, true);
    const tiles = serpentine({ pid: spec.pid, op: spec.op }).length;
    let workH = tiles * HA / haH;
    const p = po.p, ex = yardExit();
    const travelH = 2 * pathLen(ex, route(ex, p.entry >= 0 ? p.entry : p.tiles[0], null)) / (def(rs.power).self ? 0.75 : 1);
    const pd = def(rs.power), id = rs.impl ? def(rs.impl) : null;
    if (spec.op === 'harvest' && harvestKind(pd, id) === 'bunker') {
      // postoje na przeładunek
      const yieldT = (G.CROPS && G.CROPS[rs.crop] && G.CROPS[rs.crop].yieldBase) || 7;
      workH += tiles * HA * yieldT / G.augerTph(pd);
    }
    const load = id && id.load != null ? id.load : 1;
    let fuel = pd.fuelLph * (workH * load + travelH * 0.45);
    for (const s of rs.sets) if (!s.hired) fuel += G.MACHINES[s.tid].fuelLph * 0.45 * (workH * 0.6 + travelH);
    const fuelCost = fuel * G.machines.fuelPrice();
    const wf = G.workers ? G.workers.wearFactor(spec.worker) : 1;
    const wearCost = [rs.power, rs.impl].filter(Boolean).reduce((a, m) => a + (m.rented ? 0 : def(m).price * (workH / G.machines.life(def(m))) * 0.6 * wf), 0);
    const trailersN = rs.sets.reduce((a, s) => a + 1 + (s.trailer2 ? 1 : 0), 0);
    let wageCost = 0;
    for (const u of [spec.worker].concat(rs.sets.filter(s => !s.hired).map(s => s.helper))) { const w = G.workers.get(u); if (w) wageCost += w.wage * (workH + travelH) / 10; }
    const transportCost = rs.sets.some(s => s.hired) ? J.transportQuote(spec.pid, rs.sets.filter(s => s.hired).length, spec).price : 0;
    const r1 = x => Math.round(x * 10) / 10;
    return {
      ok: v.ok, reason: v.ok ? (v.warn || '') : v.reason, need: v.need, hours: r1(workH + travelH), workH: r1(workH), travelH: r1(travelH), haH: Math.round(haH * 100) / 100,
      area: tiles * HA, tiles, sets: rs.sets.length, trailers: trailersN, fuel: Math.round(fuel), fuelCost: Math.round(fuelCost), wearCost: Math.round(wearCost), wageCost: Math.round(wageCost),
      transportCost, cost: Math.round(fuelCost + wearCost + wageCost + transportCost)
    };
  };

  // ===================== KONTRAKTOR (USŁUGI) =====================
  function fleetFor(op, crop, input, params) {
    const F = (power, impl, sets) => ({ power, impl, sets: sets || 0 });
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
        if (crop === 'ziemniaki') return F('nordwal_150', 'ziemniak_2', 2);
        if (crop === 'buraki') return F('burak_6', null, 2);
        if ((params && params.mode === 'silage') || crop === 'kiszonka') return F('sieczkarnia_s', null, 3);
        if (crop === 'kukurydza' || crop === 'slonecznik') return F('klosownik_k62', 'heder_kukurydza', 2);
        return F('klosownik_k62', 'heder_62', 2);
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
    return { ok: true, price, days, rate, unit, qty, peak, name: c.name, color: c.color, area: p.area, hoursEst, trailers: fl.sets, startText: G.dateText(startTickFor(days)) };
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
    for (let k = 0; k < fl.sets; k++) job.sets.push({ tractor: null, trailer: null, trailer2: null, helper: null, tid: HIRED_SET.tid, rid: HIRED_SET.rid, rid2: null, hired: true });
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
  // odwołanie: kombajn z ziarnem najpierw opróżnia zbiornik na przyczepę, dopiero potem wraca
  J.cancel = function (uid) {
    const j = J.get(uid);
    if (!j || (j.status !== 'queued' && j.status !== 'active')) return { ok: false, reason: 'Zlecenie nieaktywne' };
    if (j.cancelled) return { ok: false, reason: 'Już odwołane' };
    const frac = j.total ? 1 - j.done / j.total : 1;
    if (j.contractor) {
      const refund = Math.round(j.contractor.price * frac * (j.status === 'queued' ? 0.9 : 0.7));
      if (refund > 0) G.finance.earn(refund, 'usługi', 'Zwrot za odwołaną usługę');
    }
    if (j.transport) {
      const refund = Math.round(j.transport.price * frac * (j.status === 'queued' ? 0.9 : 0.5));
      if (refund > 0) G.finance.earn(refund, 'usługi', 'Zwrot za niewykorzystany transport');
    }
    if (j.status === 'queued') { finish(j, 'cancelled'); return { ok: true }; }
    j.cancelled = true; j.userPaused = false;
    if (j.kind === 'bunker' && j.bin > 1e-6 && !shuttles(j).some(x => x.phase !== 'park')) {
      // nie ma już żadnej przyczepy — ziarno ze zbiornika sprzedane prosto z pola (jedyne wyjście, kombajn nie zjedzie z ziarnem)
      for (const id in j.binProd) { const q = j.binProd[id]; if (q > 1e-6 && G.market && G.market.price) { const zl = Math.round(q * G.market.price(id) * 0.85); G.finance.earn(zl, 'sprzedaż', 'Sprzedaż z pola: ' + ((G.PRODUCTS[id] && G.PRODUCTS[id].name) || id)); G.emit('sold', id, q, zl); } }
      j.bin = 0; j.binProd = {};
    }
    if (j.stage === 'out' || j.stage === 'fetch') goHome(j);
    else if (j.stage === 'work' && !(j.kind === 'bunker' && j.bin > 1e-6)) goHome(j);
    else if (j.stage === 'work') j.reason = 'Odwołane — opróżnia zbiornik przed zjazdem';
    G.notify('↩️ Odwołano: ' + J.opName(j.op) + ' — ' + G.S.parcels[j.pid].name + (j.bin > 1e-6 ? ' (najpierw przeładunek ziarna)' : ''), 'info');
    return { ok: true };
  };

  const tileOf = u => G.idx(Math.max(0, Math.min(W - 1, Math.floor(u.x))), Math.max(0, Math.min(H - 1, Math.floor(u.y))));
  const home = j => j.contractor ? edgeStart() : spotTile(j.power);
  const setHome = (j, s) => (j.contractor || s.hired) ? edgeStart() : spotTile(s.tractor);
  // kafel miejsca postojowego maszyny (własna flota)
  function spotTile(uid) { const m = G.machines.get(uid); if (!m) return yardExit(); const sp = G.machines.spotFor(m); return G.idx(Math.floor(sp.x), Math.floor(sp.y)); }
  function newUnit(at) { return { x: G.tx(at) + 0.5, y: G.ty(at) + 0.5, angle: 0, path: [], pi: 0, mode: 'drive', w: null }; }
  const standbyOf = j => { const p = G.S.parcels[j.pid]; return p.entry >= 0 ? p.entry : j.order[0]; };

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
      for (const wu of [j.worker].concat(j.helpers)) {
        if (!G.workers.get(wu)) { G.notify('❌ Zlecenie anulowane — brak pracownika', 'bad'); finish(j, 'cancelled'); return; }
        const a = G.workers.available(wu, j.uid, true);
        if (!a.ok) { j.reason = a.reason; return; }
      }
    }
    const cd = canDo(j.pid, j.op, j.params);
    if (!cd.ok) {
      G.notify('❌ ' + J.opName(j.op) + ' — ' + G.S.parcels[j.pid].name + ': ' + (cd.reason || 'zabieg niemożliwy'), 'bad');
      if (j.contractor) G.finance.earn(Math.round(j.contractor.price * 0.9), 'usługi', 'Zwrot: usługa niewykonana');
      if (j.transport) G.finance.earn(Math.round(j.transport.price * 0.9), 'usługi', 'Zwrot: transport niewykorzystany');
      finish(j, 'cancelled'); return;
    }
    const wo = weatherOk();
    if (!wo.ok) { j.reason = 'Pogoda: ' + (wo.reason || 'nie da się pracować'); return; }
    if (!j.contractor) {
      // tankowanie przed wyjazdem (ciągnik/kombajn i ciągniki zestawów) — z magazynu ON albo ze stacji
      const fr = fillTanks(j);
      if (!fr.ok) { j.reason = fr.reason; j.fuelTick = G.S.tick; return; }
    }
    // start
    for (const uid of j.machines) G.machines.get(uid).busy = j.uid;
    if (!j.contractor) for (const wu of [j.worker].concat(j.helpers)) { const w = G.workers.get(wu); if (w) w.busy = j.uid; }
    j.status = 'active'; j.started = G.S.tick; j.reason = '';
    j.order = serpentine(j); j.pos = 0; j.done = 0; j.total = j.order.length;
    const pd = j.contractor ? G.MACHINES[j.contractor.power] : def(j.power), id = j.contractor ? G.MACHINES[j.contractor.impl] : (j.impl && def(j.impl));
    j.mode = (id && id.mode) || pd.mode || null;
    if (j.op === 'harvest') {
      j.kind = harvestKind(pd, id);
      j.binCap = j.kind === 'bunker' ? binCapOf(pd, id) : 0;
      j.augerTph = G.augerTph(pd.cat === 'combine' ? pd : null);
    }
    let u;
    if (j.contractor) {
      const start = home(j);
      u = j.units.main = newUnit(start);
      u.spd = pd.self ? 0.75 : 1;
      if (j.order.length) { u.path = routeNear(start, j.order[0], j.pid); u.angle = initAngle(start, u.path); }
      j.stage = 'out';
    } else {
      // flota: ciągnik rusza stamtąd, gdzie stoi; narzędzie trzeba ewentualnie przywieźć
      const pm = G.machines.get(j.power), im = j.impl ? G.machines.get(j.impl) : null;
      u = j.units.main = unitAt(pm);
      u.spd = pd.self ? 0.75 : 1;
      pm.driver = j.worker;
      // zbędne rzeczy na zaczepie zostają w miejscu
      for (const h of G.machines.hitched(pm.uid).slice().reverse()) if (!im || h.uid !== im.uid) G.machines.detach(pm.uid, h.uid, { force: true });
      if (im && im.attachedTo !== pm.uid) {
        if (im.attachedTo) G.machines.detach(im.attachedTo, im.uid, { force: true });
        if (G.machines.inHitchRange(pm, im)) { G.machines.attach(pm.uid, im.uid, { force: true }); }
        else { j.stage = 'fetch'; u.pick = im.uid; u.path = routeNear(tileOf(u), G.machines.tileOf(im), null, true); u.pi = 0; j.reason = 'Jedzie po: ' + def(im).name; }
      }
      if (j.stage !== 'fetch') { j.stage = 'out'; if (j.order.length) { u.path = routeNear(tileOf(u), j.order[0], j.pid, true); u.pi = 0; } }
    }
    j.units.shuttles = j.sets.map((st, k) => {
      let s;
      if (st.hired || j.contractor) {
        const from = setHome(j, st); s = newUnit(from);
        s.path = route(from, standbyOf(j), j.pid); s.angle = initAngle(from, s.path); s.phase = 'out';
      } else {
        const tm = G.machines.get(st.tractor);
        s = unitAt(tm); tm.driver = st.helper;
        const want = setTrailers(st), cur = tm.hitch.slice();
        let same = cur.length <= want.length && cur.every((u2, q) => u2 === want[q]);
        if (!same) for (const h of G.machines.hitched(tm.uid).slice().reverse()) G.machines.detach(tm.uid, h.uid, { force: true });
        s.pick = want.filter(u2 => !tm.hitch.includes(u2));
        for (const u2 of s.pick.slice()) { const tr = G.machines.get(u2); if (tr && tr.attachedTo && tr.attachedTo !== tm.uid) G.machines.detach(tr.attachedTo, tr.uid, { force: true }); }
        // przyczepa w zasięgu — od razu na zaczep
        while (s.pick.length) { const tr = G.machines.get(s.pick[0]); if (tr && G.machines.inHitchRange(tm, tr) && G.machines.attach(tm.uid, tr.uid, { force: true }).ok) s.pick.shift(); else break; }
        if (s.pick.length) { s.phase = 'pick'; s.path = routeNear(tileOf(s), G.machines.tileOf(G.machines.get(s.pick[0])), null, true); s.pi = 0; }
        else { s.phase = 'out'; s.path = route(tileOf(s), standbyOf(j), j.pid, true); s.pi = 0; }
      }
      s.k = k; s.load = 0; s.prod = {}; s.cap = setCap(st); s.spd = st.trailer2 ? DOUBLE_SPD : 1;
      return s;
    });
    syncFleet(j);
    G.notify('🚜 Start: ' + J.opName(j.op) + ' — ' + G.S.parcels[j.pid].name + (j.contractor ? ' (' + j.contractor.name + ')' : ''), 'info', { parcel: j.pid, key: 'start_' + j.uid });
  }
  // pojemność zbiornika (t): heder nie ma zbiornika → kombajn (tankL × 0,76 lub cap), narzędzie z bunkrem (kombajn ziemniaczany) → jego cap
  function binCapOf(pd, id) {
    const wd = id && id.cat !== 'header' && id.cap > 0 ? id : pd;
    if (wd.cap > 0) return wd.cap;
    if (wd.tankL > 0) return Math.round(wd.tankL * G.GRAIN_T_PER_M3) / 1000;
    return 5;
  }
  // jednostka w miejscu, gdzie stoi maszyna
  function unitAt(m) { const u = newUnit(G.machines.tileOf(m)); u.x = m.x; u.y = m.y; u.angle = m.angle; return u; }
  // tankowanie zestawu przed pracą (zbiornik ciągnika/kombajnu i ciągników przyczep). Zwraca { ok, reason }
  function fillTanks(j) {
    const ms = [j.power].concat(j.sets.filter(s => !s.hired).map(s => s.tractor)).map(u => G.machines.get(u)).filter(Boolean);
    for (const m of ms) {
      const tank = G.machines.tankOf(def(m));
      if (!tank) continue;
      const need = Math.round((tank - (m.fuel || 0)) * 10) / 10;
      if (need < tank * 0.25) continue;                   // tankujemy, gdy brakuje ≥ 1/4 zbiornika
      const r = G.machines.refuel(need, def(m).name);
      if (!r.ok) { m.fuel = (m.fuel || 0) + r.fromStock; return { ok: false, reason: 'Brak paliwa i pieniędzy na tankowanie: ' + def(m).name }; }
      m.fuel = tank;
      j.fuelCost += r.cost + r.fromStock * G.machines.fuelPrice();
    }
    return { ok: true };
  }
  // zapis pozycji jednostek do floty (G.S.machines) — co klatkę
  function syncFleet(j) {
    if (j.contractor) return;
    const u = j.units.main, pm = G.machines.get(j.power);
    if (u && pm && pm.busy === j.uid) G.machines.setPos(pm.uid, u.x, u.y, u.angle, u.mode !== 'park');
    for (const s of shuttles(j)) {
      const st = j.sets[s.k];
      if (!st || st.hired || st.retired) continue;
      const tm = G.machines.get(st.tractor);
      if (tm && tm.busy === j.uid) G.machines.setPos(tm.uid, s.x, s.y, s.angle, s.phase !== 'park');
    }
  }
  // dojechał na miejsce postojowe: stanąć równo, odczepić i odstawić narzędzia/przyczepy (chyba że zlecenie z keepHitched)
  function parkRig(j, tractorUid, u) {
    const tm = G.machines.get(tractorUid);
    if (!tm) return;
    const sp = G.machines.spotFor(tm);
    u.x = sp.x; u.y = sp.y; u.angle = sp.angle;
    G.machines.setPos(tm.uid, sp.x, sp.y, sp.angle, false);
    tm.driver = null;
    if (j.keepHitched) return;
    for (const h of G.machines.hitched(tm.uid).slice().reverse()) {
      if (def(h).cat === 'header') continue;
      G.machines.detach(tm.uid, h.uid, { force: true });
      // pełna przyczepa (magazyn tymczasowy) zostaje na podwórzu, reszta na swoje miejsca
      if (!(def(h).cat === 'trailer' && trailerFill(h) > 1e-6)) G.machines.park(h.uid);
    }
  }
  function initAngle(from, path) { if (!path.length) return 0; return Math.atan2(G.ty(path[0]) - G.ty(from), G.tx(path[0]) - G.tx(from)); }

  // ---------- ruch ----------
  function turn(u, target, moved) {
    let d = target - u.angle;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    const max = moved * 2.4 + 1e-4;
    u.angle += Math.abs(d) <= max ? d : Math.sign(d) * max;
    if (u.angle > Math.PI) u.angle -= 2 * Math.PI; else if (u.angle < -Math.PI) u.angle += 2 * Math.PI;
  }
  // ruch jednostki { x, y, angle, path, pi, spd } po ścieżce przez dt godzin gry; zwraca zużyty czas (czysta funkcja — także dla rozkazów)
  function moveAlong(u, dt) {
    let used = 0;
    const night = isNight();
    while (u.pi < u.path.length && dt - used > 1e-9) {
      const i = u.path[u.pi], tx = G.tx(i) + 0.5, ty = G.ty(i) + 0.5;
      const dx = tx - u.x, dy = ty - u.y, dist = Math.hypot(dx, dy);
      const sp = speedAt(i) * (u.spd || 1) * (night ? 0.85 : 1);
      const can = sp * (dt - used);
      if (dist > 1e-6) turn(u, Math.atan2(dy, dx), Math.min(can, dist));
      if (can >= dist) { u.x = tx; u.y = ty; used += dist / sp; u.pi++; }
      else { u.x += dx / dist * can; u.y += dy / dist * can; used = dt; }
    }
    return used;
  }
  J.moveAlong = moveAlong;
  J.turn = turn;
  J.tileOf = u => tileOf(u);
  // jazda po ścieżce; zwraca niewykorzystany czas
  function drive(j, u, dt, who) {
    u.mode = 'drive';
    const used = moveAlong(u, dt);
    if (used > 0) account(j, who, used, 'road');
    return dt - used;
  }
  const pathDone = u => u.pi >= u.path.length;
  // punkt przy lewym boku pojazdu (rura wyładowcza kombajnu / wysyp sieczkarni). Układ kafli: y w dół → lewa = (sin a, −cos a)
  const sidePoint = u => ({ x: u.x + Math.sin(u.angle) * SIDE, y: u.y - Math.cos(u.angle) * SIDE });

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

  // koszty pracy: paliwo, motogodziny, zużycie, zmęczenie. who: 'main' | indeks zestawu (liczba)
  function account(j, who, dtH, kind) {
    if (dtH <= 0) return;
    if (who === 'main') j.hours = Math.round((j.hours + dtH) * 1000) / 1000;
    if (j.contractor) return;
    const night = isNight();
    let fuel = 0;
    if (who === 'main') {
      const pd = def(j.power), id = j.impl ? def(j.impl) : null;
      const load = kind === 'road' ? 0.45 : kind === 'auger' ? 0.3 : (id && id.load != null ? id.load : 1);
      fuel = pd.fuelLph * load * dtH;
      const wf = G.workers.wearFactor(j.worker);
      G.machines.use(j.power, dtH, wf * (kind === 'work' ? 1 : 0.6));
      if (j.impl && kind === 'work') G.machines.use(j.impl, dtH, wf);
      G.workers.exert(j.worker, dtH, night, 'field');
    } else {
      const st = j.sets[who];
      if (!st || st.hired) return;
      fuel = def(st.tractor).fuelLph * 0.45 * dtH;
      const wf = G.workers.wearFactor(st.helper);
      G.machines.use(st.tractor, dtH, wf * 0.6);
      for (const u of setTrailers(st)) G.machines.use(u, dtH, 0.5);
      G.workers.exert(st.helper, dtH, night, 'field');
    }
    // najpierw ze zbiornika maszyny (zatankowanego przed wyjazdem), reszta „z kanistra” — dokupowana w trakcie
    const tm = G.machines.get(who === 'main' ? j.power : j.sets[who].tractor);
    let fromTank = 0;
    if (tm && tm.fuel > 0) { fromTank = Math.min(fuel, tm.fuel); tm.fuel = Math.round((tm.fuel - fromTank) * 1000) / 1000; }
    j.fuel += fuel; j.fuelPending += fuel - fromTank;
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
  // plon: masowy (t) → zbiornik kombajnu albo przyczepa przy sieczkarni; reszta (np. bele) od razu do magazynu
  function handleOut(j, out, stored) {
    let tons = 0;
    const rcv = j.kind === 'continuous' ? receiver(j) : null;
    for (const id in out) {
      const q = +out[id];
      if (!(q > 0)) continue;
      j.outTotal[id] = Math.round(((j.outTotal[id] || 0) + q) * 1000) / 1000;
      const unit = G.PRODUCTS[id] && G.PRODUCTS[id].unit;
      const bulk = j.op === 'harvest' && (unit === 't' || !unit);
      if (bulk && j.kind === 'bunker') { j.bin += q; tons += q; if (!stored) j.binProd[id] = (j.binProd[id] || 0) + q; }
      else if (bulk && j.kind === 'continuous' && rcv) { rcv.load += q; tons += q; if (!stored) rcv.prod[id] = (rcv.prod[id] || 0) + q; }
      else if (!stored) G.inv.add(id, q);
    }
    if (tons > 0) j.lastOut = tons;
    if (rcv && rcv.load + j.lastOut > rcv.cap + 1e-6) release(j, rcv);
  }
  function deliver(prod) { for (const id in prod) if (prod[id] > 0) G.inv.add(id, Math.round(prod[id] * 1000) / 1000); }

  // ---------- przyczepy: kto przy kombajnie ----------
  const shuttles = j => (j.units && j.units.shuttles) || [];
  const receiver = j => shuttles(j).find(s => s.phase === 'follow') || null;
  const aligned = (s, u) => { const p = sidePoint(u); return s.phase === 'follow' && Math.hypot(s.x - p.x, s.y - p.y) < 0.2; };
  function release(j, s) {
    const atEnd = j.pos >= j.order.length || j.cancelled;
    if (s.load >= s.cap * TRAILER_FULL || (atEnd && (j.bin <= 1e-6 || j.kind === 'continuous') && s.load > 0)) goUnload(j, s);
    else s.phase = 'standby';
    s.receiving = false;
  }
  // dominujący produkt na przyczepie
  function mainProd(s) { let best = null, bq = 0; for (const id in s.prod) if (s.prod[id] > bq) { bq = s.prod[id]; best = id; } return best; }
  // dokąd jechać z plonem: kafel podwórza pod silosem/magazynem (G.buildings.unloadPoint) albo — gdy nigdzie nie ma miejsca — wjazd na podwórze
  function unloadTile(s) {
    const prod = mainProd(s);
    let pt = null;
    if (prod && G.buildings && G.buildings.unloadPoint) { try { pt = G.buildings.unloadPoint(prod, { x: s.x, y: s.y }); } catch (e) { pt = null; } }
    if (pt && G.inMap(Math.floor(pt.x), Math.floor(pt.y))) return { tile: G.idx(Math.floor(pt.x), Math.floor(pt.y)), store: true, building: pt.buildingUid };
    return { tile: yardExit(), store: false, building: null };
  }
  function goUnload(j, s) {
    const u = unloadTile(s);
    s.phase = 'toYard'; s.target = u.tile; s.canStore = u.store; s.path = route(tileOf(s), u.tile, j.pid); s.pi = 0;
  }
  // wysyp przyczepy: do magazynu; co się nie zmieści — zostaje na przyczepie (własnej) jako magazyn tymczasowy na podwórzu
  // (zestaw odpada ze zlecenia), a z wynajętej jest sprzedawane prosto z przyczepy. Zwraca true, gdy zestaw został wycofany.
  function dumpTrailer(j, s) {
    const st = j.sets[s.k];
    let rest = {}, anyRest = false;
    for (const id in s.prod) {
      const q = Math.round(s.prod[id] * 1000) / 1000;
      if (!(q > 0)) continue;
      const added = G.inv.add(id, q);
      if (q - added > 1e-6) { rest[id] = q - added; anyRest = true; }
    }
    s.prod = {}; s.load = 0;
    if (!anyRest) return false;
    const pname = id => (G.PRODUCTS[id] && G.PRODUCTS[id].name) || id;
    if (st.hired || j.contractor) {
      // wynajęty transport nie zostaje na podwórzu — plon sprzedany prosto z przyczepy (niższa cena)
      for (const id in rest) {
        const q = rest[id];
        let zl = 0;
        if (G.market && G.market.price) { zl = Math.round(q * G.market.price(id) * 0.9); G.finance.earn(zl, 'sprzedaż', 'Sprzedaż z przyczepy: ' + pname(id)); }
        G.emit('sold', id, q, zl);
        G.notify('📦 Brak miejsca w magazynie — ' + G.fmtQty(id, q) + ' ' + pname(id) + ' sprzedano prosto z przyczepy' + (zl ? ' za ' + G.fmtMoney(zl) : ''), 'warn', { key: 'sellfromtrailer_' + j.uid });
      }
      return false;
    }
    // własny zestaw: plon zostaje na przyczepach (magazyn tymczasowy), pojemność liczy G.machines.yardStorage
    const trailers = setTrailers(st).map(u => G.machines.get(u)).filter(Boolean);
    for (const id in rest) {
      let q = rest[id];
      for (const m of trailers) {
        const cap = def(m).cap || 0, have = trailerFill(m), room = Math.max(0, cap - have);
        const put = Math.min(q, room);
        if (put <= 1e-9) continue;
        m.fill = m.fill || {}; m.fill[id] = Math.round(((m.fill[id] || 0) + put) * 1000) / 1000;
        q -= put;
      }
      const stored = rest[id] - q;
      if (stored > 1e-6) {
        const ok = G.inv.add(id, stored);
        if (ok < stored - 1e-6) console.warn('[jobs] magazyn tymczasowy nie zwiększył pojemności', id, stored, ok);
      }
      G.notify('🚜 Brak miejsca w magazynie — ' + G.fmtQty(id, stored) + ' ' + pname(id) + ' zostaje na przyczepie na podwórzu. Sprzedaj plon albo postaw silos, żeby zwolnić przyczepę', 'warn', { key: 'yardstore_' + id });
    }
    // zestaw wycofany: przyczepy zostają pełne na podwórzu (odczepione), ciągnik wraca na swoje miejsce
    st.retired = true;
    const tm = G.machines.get(st.tractor);
    if (tm) { G.machines.setPos(tm.uid, s.x, s.y, s.angle, false); for (const h of G.machines.hitched(tm.uid).slice().reverse()) G.machines.detach(tm.uid, h.uid, { force: true }); tm.driver = null; }
    for (const u of [st.tractor].concat(setTrailers(st))) {
      const m = G.machines.get(u);
      if (m && m.busy === j.uid) m.busy = null;
      j.machines = j.machines.filter(x => x !== u);
    }
    if (tm) G.machines.park(tm.uid);
    if (st.helper) { const w = G.workers.get(st.helper); if (w && w.busy === j.uid) w.busy = null; }
    s.phase = 'park'; s.mode = 'park';
    if (!shuttles(j).some(x => x.phase !== 'park') && j.stage === 'work') G.notify('⏳ ' + J.opName(j.op) + ' — ' + G.S.parcels[j.pid].name + ': wszystkie przyczepy stoją pełne — kombajn czeka. Sprzedaj plon, postaw silos albo odwołaj zlecenie', 'bad', { key: 'nosets_' + j.uid, parcel: j.pid });
    return true;
  }

  // ---------- jednostka główna ----------
  function stepMain(j, dt) {
    const u = j.units.main;
    for (let guard = 0; guard < 400 && dt > 1e-9; guard++) {
      const sig = j.stage + u.mode + j.pos + j.bin.toFixed(4) + (u.timer || 0);
      const before = dt;
      if (j.stage === 'fetch') {
        // po narzędzie: dojazd, postój na podczepienie, wyjazd na pole
        if (u.mode === 'hitch') {
          const t = Math.min(dt, u.timer); u.timer -= t; dt -= t;
          if (u.timer <= 1e-9) {
            const r = G.machines.attach(j.power, u.pick, { force: true });
            if (!r.ok) { G.notify('❌ Nie da się podczepić: ' + r.reason, 'bad'); j.cancelled = true; }
            u.pick = null; j.stage = 'out'; j.reason = '';
            if (j.cancelled) goHome(j); else { u.path = routeNear(tileOf(u), j.order[0], j.pid, true); u.pi = 0; }
          }
        } else {
          dt = drive(j, u, dt, 'main');
          if (pathDone(u)) {
            const im = G.machines.get(u.pick);
            if (!im) { j.cancelled = true; goHome(j); }
            else if (!G.machines.inHitchRange(u, im) && Math.hypot(u.x - im.x, u.y - im.y) > 2.5) { u.path = routeNear(tileOf(u), G.machines.tileOf(im), null, true); u.pi = 0; if (!u.path.length) { u.mode = 'hitch'; u.timer = G.machines.HITCH_H; } }
            else { u.mode = 'hitch'; u.timer = G.machines.HITCH_H; turn(u, Math.atan2(im.y - u.y, im.x - u.x), 9); j.reason = 'Podczepia: ' + def(im).name; }
          }
        }
      }
      else if (j.stage === 'out') { dt = drive(j, u, dt, 'main'); if (pathDone(u)) { j.stage = 'work'; u.mode = 'work'; if (j.cancelled) goHome(j); } }
      else if (j.stage === 'work') dt = work(j, u, dt);
      else if (j.stage === 'home') { dt = drive(j, u, dt, 'main'); if (pathDone(u)) { u.mode = 'park'; j.stage = 'parked'; if (!j.contractor) parkRig(j, j.power, u); checkFinish(j); return; } }
      else return;
      if (dt === before && sig === j.stage + u.mode + j.pos + j.bin.toFixed(4)) break;
    }
  }
  function waitFor(j, u, reason, notifyKey) {
    u.mode = 'wait'; j.reason = reason;
    if (notifyKey && j._nk !== notifyKey + j.pos) { j._nk = notifyKey + j.pos; G.notify('⏳ ' + J.opName(j.op) + ' — ' + G.S.parcels[j.pid].name + ': ' + reason, 'warn', { key: notifyKey + '_' + j.uid, parcel: j.pid }); }
  }
  function work(j, u, dt) {
    const atEnd = j.pos >= j.order.length || j.cancelled;
    const rcv = j.kind ? receiver(j) : null;
    // --- przeładunek ślimakiem (kombajn stoi, rura rozłożona) ---
    if (j.kind === 'bunker' && j.bin > 1e-6 && rcv && aligned(rcv, u) && !j.userPaused) {
      u.mode = 'unload'; j.reason = 'Przeładunek na przyczepę';
      rcv.receiving = true;
      const free = Math.max(0, rcv.cap - rcv.load);
      const tph = augerOf(j);
      const step = Math.min(dt, j.bin / tph, free / tph);
      const q = step * tph, f = j.bin > 0 ? Math.min(1, q / j.bin) : 0;
      for (const id in j.binProd) { const x = j.binProd[id] * f; rcv.prod[id] = (rcv.prod[id] || 0) + x; j.binProd[id] -= x; }
      rcv.load += q; j.bin -= q;
      account(j, 'main', step, 'auger');
      if (j.bin <= 1e-6 || rcv.load >= rcv.cap - 1e-6) {
        if (j.bin <= 1e-6) { j.bin = 0; j.binProd = {}; }
        release(j, rcv);
      }
      return dt - step;
    }
    if (atEnd) {
      // kombajn nie zjeżdża z pola z ziarnem w zbiorniku
      if (j.kind === 'bunker' && j.bin > 1e-6) { j.want = true; waitFor(j, u, 'Czeka na przyczepę — opróżnienie zbiornika przed zjazdem', 'drain'); return dt; }
      if (j.cancelled) goHome(j); else completeWork(j);
      return dt;
    }
    const b = blocked(j);
    if (b) { waitFor(j, u, b); return dt; }
    if (j.kind === 'bunker') {
      const full = j.bin + j.lastOut > j.binCap + 1e-6;
      if (j.bin >= j.binCap * CALL_AT || full) j.want = true;
      if (full) { waitFor(j, u, 'Czeka na przyczepę — zbiornik pełny', 'binfull'); return dt; }
    } else if (j.kind === 'continuous') {
      if (!rcv || !aligned(rcv, u)) { j.want = true; waitFor(j, u, rcv ? 'Przyczepa podjeżdża do sieczkarni' : 'Czeka na przyczepę — sieczkarnia ładuje na bieżąco', rcv ? null : 'binfull'); return dt; }
      rcv.receiving = true;
    }
    j.reason = '';
    if (!u.w) {
      const to = j.order[j.pos], dist = Math.hypot(G.tx(to) + 0.5 - u.x, G.ty(to) + 0.5 - u.y);
      u.w = { to, fx: u.x, fy: u.y, t: 0, total: HA / haHFor(j) + Math.max(0, dist - 1.2) / SPD_OFF };
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
      if (r.error) { waitFor(j, u, r.error); return dt - step; }
      u.w = null; j.pos++; j.done++;
    }
    return dt - step;
  }
  function completeWork(j) {
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
    u.w = null;
    j.homeTile = home(j);
    u.path = route(tileOf(u), j.homeTile, j.pid, !j.contractor); u.pi = 0;
  }

  // ---------- przyczepy (odwóz plonu) ----------
  function dispatch(j) {
    const m = j.units.main;
    if (!m || !j.want || j.stage !== 'work') return;
    if (shuttles(j).some(s => s.phase === 'fetch' || s.phase === 'follow')) return;
    const ready = shuttles(j).filter(s => s.phase === 'standby' && s.cap - s.load > Math.max(0.5, s.cap * 0.15) && helperOk(j, s))
      .sort((a, b) => (b.cap - b.load) - (a.cap - a.load) || Math.hypot(a.x - m.x, a.y - m.y) - Math.hypot(b.x - m.x, b.y - m.y));
    const s = ready[0];
    if (!s) return;
    s.phase = 'fetch'; s.path = routeNear(tileOf(s), tileOf(m), j.pid); s.pi = 0;
  }
  function helperOk(j, s) {
    const st = j.sets[s.k];
    if (!st || st.hired || j.contractor) return true;
    return G.workers.available(st.helper, j.uid, false).ok;
  }
  function stepShuttles(j, dt) {
    dispatch(j);
    j.want = false;
    for (const s of shuttles(j)) stepShuttle(j, s, dt);
  }
  function stepShuttle(j, s, dt) {
    if (s.phase === 'park') return;
    const m = j.units.main, st = j.sets[s.k];
    const mainGone = j.stage === 'home' || j.stage === 'parked';
    for (let guard = 0; guard < 200 && dt > 1e-9; guard++) {
      const sig = s.phase + s.pi + s.x.toFixed(3) + s.y.toFixed(3) + (s.timer || 0), before = dt;
      switch (s.phase) {
        case 'pick': {
          // po przyczepę: dojazd, postój na podczepienie, kolejna albo wyjazd na pole
          if (s.mode === 'hitch') {
            const t = Math.min(dt, s.timer); s.timer -= t; dt -= t;
            if (s.timer <= 1e-9) {
              const tr = G.machines.get(s.pick[0]);
              if (tr) G.machines.attach(st.tractor, tr.uid, { force: true });
              s.pick.shift();
              if (s.pick.length) { s.path = routeNear(tileOf(s), G.machines.tileOf(G.machines.get(s.pick[0])), null, true); s.pi = 0; s.mode = 'drive'; }
              else { s.phase = mainGone ? 'home' : 'out'; s.path = route(tileOf(s), mainGone ? setHome(j, st) : standbyOf(j), j.pid, true); s.pi = 0; }
            }
            break;
          }
          dt = drive(j, s, dt, s.k);
          if (pathDone(s)) {
            const tr = G.machines.get(s.pick[0]);
            if (!tr) { s.pick.shift(); if (!s.pick.length) { s.phase = 'out'; s.path = route(tileOf(s), standbyOf(j), j.pid, true); s.pi = 0; } break; }
            s.mode = 'hitch'; s.timer = G.machines.HITCH_H; turn(s, Math.atan2(tr.y - s.y, tr.x - s.x), 9);
          }
          break;
        }
        case 'out': case 'back':
          dt = drive(j, s, dt, s.k); if (pathDone(s)) s.phase = 'standby'; break;
        case 'standby':
          s.mode = 'wait'; s.receiving = false;
          if (s.load >= s.cap * TRAILER_FULL || (mainGone && s.load > 0)) goUnload(j, s);
          else if (mainGone) { s.phase = 'home'; s.path = route(tileOf(s), setHome(j, st), j.pid, !st.hired); s.pi = 0; }
          else return;
          break;
        case 'fetch':
          if (mainGone) { s.phase = 'standby'; break; }
          dt = drive(j, s, dt, s.k);
          if (Math.hypot(s.x - m.x, s.y - m.y) <= 2.2) { s.phase = 'follow'; s.path = []; s.pi = 0; }
          else if (pathDone(s)) { s.path = routeNear(tileOf(s), tileOf(m), j.pid); s.pi = 0; if (!s.path.length) s.phase = 'follow'; }
          break;
        case 'follow': {
          if (mainGone) { s.phase = 'standby'; s.receiving = false; break; }
          // jedzie równolegle po lewej stronie kombajnu/sieczkarni
          const p = sidePoint(m), dx = p.x - s.x, dy = p.y - s.y, dist = Math.hypot(dx, dy);
          const can = FOLLOW_SPD * dt;
          if (dist > 0.05) turn(s, Math.atan2(dy, dx), Math.min(can, dist) * (dist > 0.4 ? 1 : 0.3));
          if (dist <= 0.4) turn(s, m.angle, Math.max(0.05, Math.min(can, dist) + dt * 2));
          if (can >= dist) { s.x = p.x; s.y = p.y; } else { s.x += dx / dist * can; s.y += dy / dist * can; }
          s.mode = dist < 0.2 ? 'follow' : 'drive';
          if (dist > 0.02) account(j, s.k, Math.min(dt, dist / FOLLOW_SPD), 'road');
          return;   // czas zużyty — trzyma się kombajnu do zwolnienia
        }
        case 'toYard':
          dt = drive(j, s, dt, s.k); if (pathDone(s)) { s.phase = 'dump'; s.timer = UNLOAD_H; } break;
        case 'dump': {
          s.mode = 'unload';
          const t = Math.min(dt, s.timer); s.timer -= t; dt -= t;
          if (s.timer <= 1e-9) {
            if (dumpTrailer(j, s)) { checkFinish(j); return; }
            if (j.stage === 'home' || j.stage === 'parked') { s.phase = 'home'; s.path = route(tileOf(s), setHome(j, st), j.pid, !st.hired); s.pi = 0; }
            else { s.phase = 'back'; s.path = route(tileOf(s), standbyOf(j), j.pid, !st.hired); s.pi = 0; }
          }
          break;
        }
        case 'home':
          dt = drive(j, s, dt, s.k); if (pathDone(s)) { s.phase = 'park'; s.mode = 'park'; if (!st.hired && !j.contractor) parkRig(j, st.tractor, s); checkFinish(j); return; } break;
        default: return;
      }
      if (dt === before && sig === s.phase + s.pi + s.x.toFixed(3) + s.y.toFixed(3)) break;
    }
  }

  function checkFinish(j) {
    if (j.stage !== 'parked') return;
    if (shuttles(j).some(s => s.phase !== 'park')) return;
    finish(j, j.cancelled ? 'cancelled' : 'done');
  }
  function finish(j, status) {
    if (j.bin > 1e-6) {   // nie powinno się zdarzyć (kombajn czeka na przyczepę); zabezpieczenie przed utratą danych
      console.warn('[jobs] zbiornik niepusty przy zakończeniu', j.uid, j.bin);
      deliver(j.binProd); j.bin = 0; j.binProd = {};
    }
    for (const s of shuttles(j)) if (s.load > 0) { deliver(s.prod); s.prod = {}; s.load = 0; }
    flushFuel(j);
    for (const uid of j.machines) { const m = G.machines.get(uid); if (m && m.busy === j.uid) { m.busy = null; if (m.driver != null && [j.worker].concat(j.helpers || []).includes(m.driver)) m.driver = null; if (m.parked === null) m.parked = G.machines.placeOf(m); } }
    for (const wu of [j.worker].concat(j.helpers || [])) { const w = wu && G.workers.get(wu); if (w && w.busy === j.uid) w.busy = null; }
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
        if (j.status === 'active') { stepMain(j, dtH); if (j.status === 'active') { stepShuttles(j, dtH); if (j.status === 'active') syncFleet(j); } }
      } catch (e) { console.error('[jobs]', e); }
    }
  });
  G.on('tick', () => {
    // ponowna próba tankowania po braku paliwa — co godzinę gry
    for (const j of G.S.jobs.list) if (j.fuelPending > 0 && j.fuelTick >= 0 && j.fuelTick < G.S.tick) flushFuel(j);
  });

  // ===================== DLA GRAFIKI =====================
  // [{ x, y, angle, parts:[{model, color, axle?, cap?, fill?, hitchLen?}], working, dust, lights,
  //    kind: 'own'|'contractor'|'transport'|'parked'|'implement', unit: 'main'|'shuttle'|'parked'|'order'|'manual'|'implement',
  //    uid (własne), jobUid, label, waiting, reason, fill (0..1), unloading?, auger?: 'in'|'out', receiving?, inGarage?, broken?,
  //    driver (imię kierowcy | null), manual (prowadzi gracz), lowered (narzędzie opuszczone), target {x,y} (cel rozkazu/odwozu) }]
  // Źródłem pozycji WŁASNYCH maszyn jest G.S.machines (flota); zlecenia dokładają flagi (praca, rura, ładunek). Kontraktorzy i wynajęty
  // transport nie należą do floty — rysowani z jednostek zlecenia.
  J.vehicles = function () {
    const out = [];
    if (!G.S || !G.S.jobs || !G.S.machines) return out;
    const h = G.date().hour + (G.hourFrac || 0);
    const wt = G.weather && G.weather.type;
    const dark = h >= 19.5 || h < 5.5 || wt === 'fog' || wt === 'storm';
    const wet = wt === 'rain' || wt === 'storm' || wt === 'snow';
    const manualUid = G.drive && G.drive.active ? G.drive.active() : null;
    // --- obce pojazdy (kontraktor, wynajęty transport) ---
    for (const j of G.S.jobs.list) {
      if (j.status !== 'active') continue;
      const ctr = j.contractor;
      if (ctr) {
        const pd = G.MACHINES[ctr.power], id = ctr.impl && G.MACHINES[ctr.impl];
        const u = j.units.main;
        if (u && u.mode !== 'park') {
          const parts = [{ model: pd.model, color: ctr.color }];
          if (id) parts.push({ model: id.model, color: shade(ctr.color) });
          out.push(Object.assign(mainFlags(j, u, pd), { x: u.x, y: u.y, angle: u.angle, parts, kind: 'contractor', unit: 'main', uid: null, jobUid: j.uid, label: ctr.name + ': ' + J.opName(j.op), lights: dark && u.mode !== 'wait', dust: false, driver: null, manual: false, lowered: false, target: null }));
          out[out.length - 1].dust = out[out.length - 1].working && !!DUSTY[j.op] && !wet;
        }
      }
      for (const s of shuttles(j)) {
        const st = j.sets[s.k];
        if (s.phase === 'park' || !(st.hired || ctr)) continue;
        const col = ctr ? ctr.color : TRANSPORT_FIRM.color;
        const td = G.MACHINES[st.tid];
        const parts = [{ model: td.model, color: col }];
        let left = s.load;
        for (const rid of [st.rid, st.rid2]) { const rd = rid && G.MACHINES[rid]; if (!rd) continue; const q = Math.min(left, rd.cap || 0); left -= q; parts.push(trailerPart(rd, shade(col), rd.cap ? q / rd.cap : 0)); }
        out.push(Object.assign(shuttleFlags(j, s), { x: s.x, y: s.y, angle: s.angle, parts, kind: ctr ? 'contractor' : 'transport', unit: 'shuttle', uid: null, jobUid: j.uid,
          label: ctr ? ctr.name + ': odwóz plonu' : TRANSPORT_FIRM.name + ': odwóz plonu', lights: dark && s.mode !== 'wait', dust: false, driver: null, manual: false, lowered: false }));
      }
    }
    // --- własna flota ---
    const ML = G.machines.list();
    for (const m of ML) {
      const d = def(m);
      if (!d || m.x == null) continue;
      if (m.attachedTo) continue;                     // rysowane jako część zestawu
      const drv = m.driver != null && G.workers ? G.workers.get(m.driver) : null;
      const base = { x: m.x, y: m.y, angle: m.angle, uid: m.uid, jobUid: m.busy || null, driver: drv ? drv.name : null, manual: manualUid === m.uid, lowered: !!m.lowered,
        broken: !!m.broken, inGarage: m.parked === 'garage' && !m.busy && !m.order && manualUid !== m.uid, target: null, working: false, dust: false, waiting: false, reason: '', fill: 0 };
      if (!G.machines.isPower(d)) {
        // luźno stojące narzędzie / przyczepa
        const fillT = d.cat === 'trailer' && d.cap ? Math.min(1, trailerFill(m) / d.cap) : 0;
        const part = d.cat === 'trailer' ? trailerPart(d, d.color, fillT) : { model: d.model, color: d.color };
        out.push(Object.assign(base, { parts: [part], kind: 'implement', unit: 'implement', label: d.name + (fillT > 0 ? ' — pełna (magazyn tymczasowy)' : ''), fill: fillT, lights: false, inGarage: base.inGarage && fillT <= 0 }));
        continue;
      }
      // zestaw: maszyna napędowa + zaczep
      const parts = [{ model: d.model, color: d.color }];
      const hs = G.machines.hitched(m.uid);
      let v = Object.assign(base, { parts, kind: 'parked', unit: 'parked', label: d.name, lights: false });
      if (d.cat === 'combine' || d.cat === 'potato_harvester' || d.cat === 'beet_harvester' || d.cat === 'forage_harvester') { v.auger = 'in'; v.unloading = false; }
      const j = m.busy ? J.get(m.busy) : null;
      let s = null, isMain = false;
      if (j && j.status === 'active') {
        isMain = j.power === m.uid;
        if (!isMain) s = shuttles(j).find(x => j.sets[x.k] && j.sets[x.k].tractor === m.uid) || null;
      }
      // ładunek przyczep w zestawie: ze zlecenia (shuttle) albo z własnego fill
      let left = s ? s.load : -1;
      for (const hm of hs) {
        const hd = def(hm);
        if (hd.cat === 'trailer') {
          let f = 0;
          if (left >= 0) { const q = Math.min(left, hd.cap || 0); left -= q; f = hd.cap ? q / hd.cap : 0; }
          else f = hd.cap ? Math.min(1, trailerFill(hm) / hd.cap) : 0;
          parts.push(trailerPart(hd, hd.color, f));
        } else parts.push({ model: hd.model, color: hd.color });
      }
      if (j && isMain) {
        const u = j.units.main;
        Object.assign(v, mainFlags(j, u, d), { kind: 'own', unit: 'main', label: J.opName(j.op) + (j.stage === 'fetch' ? ' — po narzędzie' : ''), lights: dark && u.mode !== 'wait' });
        v.dust = v.working && !!DUSTY[j.op] && !wet;
        if (u.path && u.pi < u.path.length && (j.stage === 'out' || j.stage === 'home' || j.stage === 'fetch')) { const t = u.path[u.path.length - 1]; v.target = { x: G.tx(t) + 0.5, y: G.ty(t) + 0.5 }; }
      } else if (j && s) {
        Object.assign(v, shuttleFlags(j, s), { kind: 'own', unit: 'shuttle', label: s.phase === 'pick' ? 'Odwóz plonu — po przyczepę' : 'Odwóz plonu', lights: dark && s.mode !== 'wait' });
      } else if (m.order) {
        const o = m.order;
        Object.assign(v, { kind: 'own', unit: 'order', label: o.label || 'Rozkaz', waiting: !!o.wait, reason: o.reason || '', lights: dark, working: !!o.working, dust: !!o.working && !wet });
        if (o.target != null) v.target = { x: G.tx(o.target) + 0.5, y: G.ty(o.target) + 0.5 };
        if (hs.length && hs.every(x => def(x).cat === 'trailer')) v.fill = fillRatio(hs);
      } else if (manualUid === m.uid) {
        const st = G.drive.state();
        Object.assign(v, { kind: 'own', unit: 'manual', label: 'Prowadzisz: ' + d.name, lights: dark, working: !!(st && st.working), dust: !!(st && st.working) && !wet, fill: st ? st.fill || 0 : 0 });
        if (st && st.auger) v.auger = st.auger;
        if (st && st.unloading) v.unloading = true;
      } else {
        if (hs.length && hs.every(x => def(x).cat === 'trailer')) v.fill = fillRatio(hs);
        if (m.parked === 'field') v.label += ' — stoi na polu';
      }
      if (d.cat === 'combine' && !v.fill && m.fill) v.fill = Math.min(1, trailerFill(m) / (d.cap || 1));
      out.push(v);
    }
    return out;
  };
  const fillRatio = hs => { let c = 0, q = 0; for (const h of hs) { c += def(h).cap || 0; q += trailerFill(h); } return c ? Math.min(1, q / c) : 0; };
  const trailerPart = (rd, color, fill) => ({ model: rd.model, color, axle: rd.axle || null, cap: rd.cap || 0, fill: Math.max(0, Math.min(1, fill || 0)), hitchLen: rd.hitchLen || 0.7 });
  function mainFlags(j, u, pd) {
    const working = j.stage === 'work' && u.mode === 'work';
    const v = { working, waiting: u.mode === 'wait', reason: j.reason, fill: j.binCap ? Math.min(1, j.bin / j.binCap) : 0 };
    if (j.kind) {
      const rcv = receiver(j);
      v.unloading = j.kind === 'bunker' ? u.mode === 'unload' : !!(working && rcv && rcv.receiving);
      v.auger = j.stage === 'work' && (v.unloading || (j.kind === 'continuous' && rcv && aligned(rcv, u))) ? 'out' : 'in';
    }
    return v;
  }
  function shuttleFlags(j, s) {
    const u = j.units.main;
    return {
      working: false, waiting: s.mode === 'wait', reason: s.phase === 'standby' ? 'Czeka na wezwanie' : '', fill: s.cap ? Math.min(1, s.load / s.cap) : 0,
      receiving: s.phase === 'follow' && !!s.receiving && !!u && aligned(s, u), unloading: s.phase === 'dump',
      target: (s.phase === 'toYard' && s.target != null) ? { x: G.tx(s.target) + 0.5, y: G.ty(s.target) + 0.5 } : null
    };
  }
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
    const act = new Map();
    for (const j of S.jobs.list) {
      // migracja z wersji z jedną przyczepą (shTractor/shTrailer/helper, units.shuttle)
      if (!Array.isArray(j.sets)) {
        j.sets = [];
        if (j.shTractor && j.shTrailer) j.sets.push({ tractor: j.shTractor, trailer: j.shTrailer, helper: j.helper, tid: (M().get(j.shTractor) || {}).id || 'zagon_c60', rid: (M().get(j.shTrailer) || {}).id || 'przyczepa_4', hired: false });
      }
      if (!Array.isArray(j.helpers)) j.helpers = j.helper ? [j.helper] : [];
      if (!j.units) j.units = { main: null, shuttles: [] };
      if (!Array.isArray(j.units.shuttles)) { j.units.shuttles = j.units.shuttle ? [Object.assign(j.units.shuttle, { k: 0 })] : []; delete j.units.shuttle; }
      for (const st of j.sets) { if (st.trailer2 === undefined) st.trailer2 = null; if (st.rid2 === undefined) st.rid2 = null; }
      for (const s of j.units.shuttles) { if (s.phase === 'transfer' || s.phase === 'fetch') s.phase = 'standby'; if (!s.prod) s.prod = {}; if (s.cap == null && j.sets[s.k]) s.cap = setCap(j.sets[s.k]); }
      if (!(j.augerTph > 0)) { const pd0 = j.contractor ? G.MACHINES[j.contractor.power] : def(j.power); j.augerTph = G.augerTph(pd0 && pd0.cat === 'combine' ? pd0 : null); }
      if (j.lastOut == null) j.lastOut = 0;
      if (j.status === 'active') {
        if (j.op === 'harvest' && !j.kind) j.kind = 'bunker';
        if (j.stage === 'unload') { j.stage = 'work'; if (j.units.main) { j.units.main.unl = null; j.units.main.mode = 'work'; } }
        if (!j.units.main) { j.stage = 'home'; j.units.main = newUnit(home(j)); }
        if (!Array.isArray(j.order)) j.order = [];
        for (const uid of j.machines || []) act.set('m' + uid, j.uid);
        for (const wu of [j.worker].concat(j.helpers)) if (wu) act.set('w' + wu, j.uid);
      }
    }
    for (const m of S.machines || []) m.busy = act.get('m' + m.uid) || null;
    for (const w of S.workers || []) w.busy = act.get('w' + w.uid) || null;
    // flota: narzędzia aktywnych zleceń muszą wisieć na swoich ciągnikach (stare zapisy nie znają zaczepów)
    for (const j of S.jobs.list) {
      if (j.status !== 'active' || j.contractor) continue;
      const pm = G.machines.get(j.power), im = j.impl && G.machines.get(j.impl), u = j.units.main;
      if (pm && u) {
        if (j.stage === 'fetch' && (!u.pick || !G.machines.get(u.pick))) { j.stage = 'out'; u.mode = 'drive'; u.path = routeNear(tileOf(u), j.order[0] != null ? j.order[0] : tileOf(u), j.pid, true); u.pi = 0; }
        if (im && j.stage !== 'fetch' && im.attachedTo !== pm.uid) { for (const hh of G.machines.hitched(pm.uid).slice().reverse()) G.machines.detach(pm.uid, hh.uid, { force: true }); G.machines.attach(pm.uid, im.uid, { force: true }); }
        if (pm.driver == null) pm.driver = j.worker;
        if (!j.keepHitched) j.keepHitched = false;
        if (j.homeTile == null) j.homeTile = -1;
      }
      for (const s of j.units.shuttles) {
        const st = j.sets[s.k];
        if (!st || st.hired || st.retired) continue;
        const tm = G.machines.get(st.tractor);
        if (!tm) continue;
        if (s.phase === 'pick' && !(Array.isArray(s.pick) && s.pick.length)) { s.phase = 'out'; s.mode = 'drive'; s.path = route(tileOf(s), standbyOf(j), j.pid, true); s.pi = 0; }
        if (s.phase !== 'pick') for (const u2 of setTrailers(st)) { const tr = G.machines.get(u2); if (tr && tr.attachedTo !== tm.uid) G.machines.attach(tm.uid, tr.uid, { force: true }); }
        if (tm.driver == null) tm.driver = st.helper;
      }
      syncFleet(j);
    }
    wc.tick = -1;
  });
})();
