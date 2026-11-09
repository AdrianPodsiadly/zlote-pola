// Złote Pola — budowa i rozbudowa budynków, pojemność magazynów → G.buildings (agent: hodowla i budynki)
//
// Stan:  G.S.buildings = [{ uid, type, x, y, rot (0|1), level, progress 0..1 (budowa), upg? 0..1 (trwająca rozbudowa do level+1) }]
//        G.S.bmeta = { opts: { biogasSilage }, losses: { pula: ilość w tym roku }, lastLossNote: { pula: dzień } , stats: {...} }
// Położenie: (x, y) = lewy górny kafel (najmniejsze x i y); zajęte kafle x..x+w-1, y..y+h-1, gdzie [w,h] = size (rot 1 zamienia w↔h).
// Budynek w budowie (progress < 1) nie działa (brak pojemności, miejsc dla zwierząt). W czasie rozbudowy działa na starym poziomie.
// Zdarzenia: 'built'(b) po ukończeniu budowy lub rozbudowy, 'buildStart'(b), 'demolished'(b), 'yardExpanded'(i),
//            'parcelChanged'(parcel) (kafel pola stał się podwórzem), 'mapChanged'(i) (dla grafiki — zmiana typu kafla).
(function () {
  const C = G.CFG;
  const BL = G.buildings = {};
  const POOLS = () => G.BUILDING_POOLS;
  let rev = 1;            // wersja układu budynków (zmiana → przelicz pamięci podręczne)
  let occ = null, occRev = 0, capCache = null, capRev = 0, penCache = {}, penRev = 0, defCache = {};

  const S = () => G.S;
  const list = () => (G.S && G.S.buildings) || [];
  const done = b => b.progress >= 1;
  function bump() { rev++; }
  BL.version = () => rev;

  // ---------- definicje ----------
  // pełna definicja bieżącego (lub podanego) poziomu: pola typu + pola poziomu
  BL.spec = function (type, level) {
    const T = G.BUILDINGS[type];
    if (!T) return null;
    level = Math.max(1, Math.min(T.levels.length, level || 1));
    const k = type + ':' + level;
    if (!defCache[k]) {
      const d = Object.assign({}, T, T.levels[level - 1]);
      d.type = type; d.maxLevel = T.levels.length; delete d.levels;
      defCache[k] = d;
    }
    return defCache[k];
  };
  BL.def = b => BL.spec(b.type, b.level);

  BL.footprint = function (b) {
    const T = G.BUILDINGS[b.type], w = T ? T.size[0] : 1, h = T ? T.size[1] : 1;
    return b.rot ? { x: b.x, y: b.y, w: h, h: w } : { x: b.x, y: b.y, w, h };
  };
  BL.tiles = function (b) {
    const f = BL.footprint(b), r = [];
    for (let y = f.y; y < f.y + f.h; y++) for (let x = f.x; x < f.x + f.w; x++) r.push(G.idx(x, y));
    return r;
  };

  function occupancy() {
    if (occ && occRev === rev) return occ;
    occ = new Map();
    for (const b of list()) for (const i of BL.tiles(b)) occ.set(i, b);
    occRev = rev;
    return occ;
  }
  BL.at = i => occupancy().get(i) || null;
  BL.isFree = i => G.S.map.t[i] === G.T.YARD && !occupancy().has(i);
  BL.list = () => list();
  BL.get = uid => list().find(b => b.uid === uid) || null;
  BL.count = (type, onlyDone) => list().filter(b => b.type === type && (!onlyDone || done(b))).length;
  BL.has = (type, minLevel) => list().some(b => b.type === type && done(b) && b.level >= (minLevel || 1));
  BL.completed = () => list().filter(done);

  // ---------- stawianie ----------
  BL.canPlace = function (type, x, y, rot, ignoreMoney) {
    const T = G.BUILDINGS[type];
    if (!T) return { ok: false, reason: 'Nieznany budynek' };
    if (!G.S || !G.S.map) return { ok: false, reason: 'Brak mapy' };
    const f = BL.footprint({ type, x, y, rot: rot ? 1 : 0 });
    for (let yy = f.y; yy < f.y + f.h; yy++) for (let xx = f.x; xx < f.x + f.w; xx++) {
      if (!G.inMap(xx, yy)) return { ok: false, reason: 'Poza mapą' };
      const i = G.idx(xx, yy);
      if (G.S.map.t[i] !== G.T.YARD) return { ok: false, reason: 'Budynki stawiamy tylko na podwórzu (powiększ podwórze)' };
      if (occupancy().has(i)) return { ok: false, reason: 'Miejsce zajęte przez: ' + G.BUILDINGS[occupancy().get(i).type].name };
    }
    if (T.max && BL.count(type) >= T.max) return { ok: false, reason: 'Można mieć tylko ' + T.max + ' taki budynek' };
    if (T.req && !T.req.some(r => BL.has(r))) return { ok: false, reason: 'Wymaga: ' + T.req.map(r => G.BUILDINGS[r].name).join(' lub ') };
    if (!ignoreMoney && !G.finance.canAfford(T.price)) return { ok: false, reason: 'Za mało pieniędzy (' + G.fmtMoney(T.price) + ')' };
    return { ok: true, price: T.price, days: T.buildDays };
  };

  function insert(type, x, y, rot, level, progress) {
    const b = { uid: G.uid(), type, x, y, rot: rot ? 1 : 0, level: level || 1, progress: progress == null ? 0 : progress };
    G.S.buildings.push(b);
    bump();
    return b;
  }

  BL.place = function (type, x, y, rot) {
    const c = BL.canPlace(type, x, y, rot);
    if (!c.ok) { G.notify('🚫 ' + c.reason, 'bad', { key: 'place' }); return null; }
    const T = G.BUILDINGS[type];
    if (!G.finance.spend(T.price, 'budowa', 'Budowa: ' + T.levels[0].name)) return null;
    const b = insert(type, x, y, rot, 1, 0);
    G.notify('🏗️ Rozpoczęto budowę: ' + T.levels[0].name + ' (' + T.buildDays + ' dni)', 'info', { tile: G.idx(x, y) });
    G.emit('buildStart', b);
    return b;
  };

  BL.canUpgrade = function (uid) {
    const b = BL.get(uid);
    if (!b) return { ok: false, reason: 'Brak budynku' };
    const T = G.BUILDINGS[b.type];
    if (!done(b)) return { ok: false, reason: 'Budowa jeszcze trwa' };
    if (b.upg != null) return { ok: false, reason: 'Rozbudowa już trwa' };
    if (b.level >= T.levels.length) return { ok: false, reason: 'Najwyższy poziom' };
    const L = T.levels[b.level];
    if (!G.finance.canAfford(L.price)) return { ok: false, reason: 'Za mało pieniędzy (' + G.fmtMoney(L.price) + ')', price: L.price, days: L.buildDays, next: L };
    return { ok: true, price: L.price, days: L.buildDays, next: L };
  };
  BL.upgrade = function (uid) {
    const c = BL.canUpgrade(uid);
    if (!c.ok) { G.notify('🚫 ' + c.reason, 'bad', { key: 'upg' }); return c; }
    const b = BL.get(uid);
    if (!G.finance.spend(c.price, 'budowa', 'Rozbudowa: ' + c.next.name)) return { ok: false, reason: 'Brak środków' };
    b.upg = 0;
    G.notify('🏗️ Rozbudowa: ' + c.next.name + ' (' + c.days + ' dni)', 'info', { tile: G.idx(b.x, b.y) });
    G.emit('buildStart', b);
    return { ok: true };
  };

  BL.canDemolish = function (uid) {
    const b = BL.get(uid);
    if (!b) return { ok: false, reason: 'Brak budynku' };
    if (b.type === 'house') return { ok: false, reason: 'Domu nie można wyburzyć' };
    const herds = (G.S.animals && G.S.animals.herds || []).filter(h => h.buildingUid === uid && h.count > 0);
    if (herds.length) return { ok: false, reason: 'W budynku są zwierzęta — najpierw je sprzedaj' };
    const d = BL.def(b);
    if (!done(b)) return { ok: true, cost: 0, refund: Math.round(G.BUILDINGS[b.type].price * 0.5 * (1 - b.progress)) };
    return { ok: true, cost: Math.round(d.cumPrice * 0.03), refund: 0 };
  };
  BL.demolish = function (uid) {
    const c = BL.canDemolish(uid);
    if (!c.ok) { G.notify('🚫 ' + c.reason, 'bad', { key: 'demol' }); return c; }
    const b = BL.get(uid);
    if (c.cost > 0 && !G.finance.spend(c.cost, 'budowa', 'Rozbiórka: ' + G.BUILDINGS[b.type].name)) return { ok: false, reason: 'Brak środków' };
    if (c.refund > 0) G.finance.earn(c.refund, 'budowa', 'Przerwana budowa — zwrot materiałów');
    G.S.buildings.splice(G.S.buildings.indexOf(b), 1);
    bump();
    G.notify('🧱 Wyburzono: ' + G.BUILDINGS[b.type].name, 'info');
    G.emit('demolished', b);
    return { ok: true };
  };

  // ---------- powiększanie podwórza ----------
  BL.canExpand = function (x, y) {
    if (!G.inMap(x, y)) return { ok: false, reason: 'Poza mapą' };
    const i = G.idx(x, y), t = G.S.map.t[i], T = G.T;
    if (t === T.YARD) return { ok: false, reason: 'To już podwórze' };
    if (t !== T.GRASS && t !== T.FIELD && t !== T.MEADOW) return { ok: false, reason: 'Tu nie można utwardzić placu' };
    if (!G.N4(i).some(n => G.S.map.t[n] === T.YARD)) return { ok: false, reason: 'Kafel musi przylegać do podwórza' };
    const pid = G.S.map.parcel[i];
    if (pid >= 0) {
      const p = G.S.parcels[pid];
      if (!p || p.owner !== 'player') return { ok: false, reason: 'To cudza działka' };
      if (p.leased) return { ok: false, reason: 'Działka jest dzierżawiona — nie można jej zabudować' };
      if (p.tiles.length <= 4) return { ok: false, reason: 'Działka byłaby za mała' };
      return { ok: true, cost: 6000, parcel: p, note: 'Utwardzenie kafla z własnej działki (działka zmniejszy się o 0,25 ha)' };
    }
    return { ok: true, cost: 14000, note: 'Zakup 0,25 ha gruntu siedliskowego i utwardzenie' };
  };
  BL.expandYard = function (x, y) {
    const c = BL.canExpand(x, y);
    if (!c.ok) { G.notify('🚫 ' + c.reason, 'bad', { key: 'expand' }); return c; }
    if (!G.finance.spend(c.cost, 'budowa', 'Powiększenie podwórza')) return { ok: false, reason: 'Brak środków' };
    const i = G.idx(x, y), M = G.S.map;
    if (c.parcel) {
      const p = c.parcel;
      p.tiles = p.tiles.filter(k => k !== i);
      p.area = Math.round(p.tiles.length * C.TILE_HA * 100) / 100;
      let sx = 0, sy = 0, ss = 0;
      for (const k of p.tiles) { sx += G.tx(k) + 0.5; sy += G.ty(k) + 0.5; ss += M.soil[k]; }
      p.cx = sx / p.tiles.length; p.cy = sy / p.tiles.length; p.soilAvg = Math.round(ss / p.tiles.length * 10) / 10;
      M.parcel[i] = -1;
    }
    M.t[i] = G.T.YARD;
    const Y = G.S.farm.yard, x0 = Math.min(Y.x, x), y0 = Math.min(Y.y, y), x1 = Math.max(Y.x + Y.w - 1, x), y1 = Math.max(Y.y + Y.h - 1, y);
    G.S.farm.yard = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
    bump();
    if (c.parcel) G.emit('parcelChanged', c.parcel);
    G.emit('mapChanged', i);
    G.emit('yardExpanded', i);
    return { ok: true, cost: c.cost };
  };

  // ---------- pojemność magazynów ----------
  const poolMemo = {};
  function poolOf(id) {
    if (id in poolMemo) return poolMemo[id];
    const p = G.PRODUCTS[id] || {}, cat = p.cat;
    let k = null;
    if (id === 'pasza_tresciwa' || cat === 'zboże' || cat === 'oleiste' || cat === 'strączkowe' ||
        ['pszenica', 'pszenzyto', 'zyto', 'jeczmien', 'owies', 'rzepak', 'kukurydza', 'slonecznik', 'soja', 'groch', 'bobik', 'gryka'].includes(id)) k = 'zboże';
    else if (id === 'siano' || id === 'sloma') k = 'bele';
    else if (id === 'sianokiszonka') k = 'sianokiszonka';
    else if (id === 'kiszonka') k = 'kiszonka';
    else if (id === 'ziemniaki') k = 'ziemniaki';
    else if (id === 'buraki') k = 'buraki';
    else if (id.indexOf('nasiona_') === 0 || cat === 'nasiona') k = 'nasiona';
    else if (['obornik', 'gnojowica', 'mleko', 'mleko_kozie', 'jaja', 'ON', 'warzywa'].includes(id)) k = id;
    else if (id === 'welna' || id === 'miod') k = 'produkty';
    else if (['saletra', 'npk', 'wapno', 'mocznik', 'polifoska', 'siarczan'].includes(id) || cat === 'nawozy') k = 'nawozy';
    else if (['herbicyd', 'fungicyd', 'insektycyd'].includes(id) || cat === 'środki ochrony') k = 'środki ochrony';
    if (G.PRODUCTS[id] || k) poolMemo[id] = k;   // nie zapamiętuj, póki produkt nieznany (dane mogą dojść później)
    return k;
  }
  BL.poolOf = poolOf;
  // przelicznik jednostki produktu na jednostkę puli
  function unitF(id, key) {
    const pu = POOLS()[key].unit, u = (G.PRODUCTS[id] || {}).unit || pu;
    if (u === pu) return 1;
    if (pu === 't') return (u === 'kg' || u === 'l') ? 0.001 : 1;
    if (pu === 'l' || pu === 'kg') return u === 't' ? 1000 : (u === 'm3' ? 1000 : 1);
    if (pu === 'm3') return (u === 'l' || u === 'kg') ? 0.001 : 1;
    return 1;
  }
  function caps() {
    if (capCache && capRev === rev) return capCache;
    const P = POOLS(), c = {};
    for (const k in P) c[k] = { cap: P[k].base, covered: 0 };
    for (const b of list()) {
      if (!done(b)) continue;
      const cap = BL.def(b).capacity || {};
      for (const k in cap) if (c[k]) { c[k].cap += cap[k]; c[k].covered += cap[k]; }
    }
    capCache = c; capRev = rev;
    return c;
  }
  // tymczasowe miejsce (np. przyczepy z ziarnem zostawione na podwórzu) — dostarcza moduł maszyn: G.machines.yardStorage(pula) → ilość
  function extra(key) {
    if (!(G.machines && typeof G.machines.yardStorage === 'function')) return 0;
    try { const v = +G.machines.yardStorage(key); return v > 0 ? v : 0; } catch (e) { return 0; }
  }
  const capOf = key => caps()[key].cap + extra(key);
  const coveredOf = key => caps()[key].covered + extra(key);
  // ilość produktu j liczona w puli key (pasza treściwa w pierwszej kolejności trafia do zbiorników paszowych)
  function inPool(j, key) {
    const q = G.S.inv[j] || 0;
    if (j !== 'pasza_tresciwa') return poolOf(j) === key ? q : 0;
    const bins = caps().pasza.cap;
    if (key === 'pasza') return Math.min(q, bins);
    if (key === 'zboże') return Math.max(0, q - bins);
    return 0;
  }
  function poolUsed(key, exceptId) {
    let u = 0;
    for (const j in G.S.inv) if (j !== exceptId) { const q = inPool(j, key); if (q > 0) u += q * unitF(j, key); }
    return u;
  }
  G.inv.capacityFn = function (id) {
    if (!G.S || !G.S.buildings) return Infinity;
    if (id === 'pasza_tresciwa') return caps().pasza.cap + Math.max(0, capOf('zboże') - poolUsed('zboże', id));
    const key = poolOf(id);
    if (!key) return Infinity;
    return Math.max(0, capOf(key) - poolUsed(key, id)) / unitF(id, key);
  };
  // dla UI: stan wszystkich pul magazynowych
  BL.storage = function () {
    const P = POOLS(), c = caps(), out = [];
    for (const k in P) {
      const items = [];
      for (const j in G.S.inv) { const q = inPool(j, k); if (q > 0) items.push({ id: j, qty: Math.round(q * 1000) / 1000 }); }
      out.push({ key: k, name: P[k].name, unit: P[k].unit, used: Math.round(poolUsed(k) * 100) / 100, cap: capOf(k), covered: coveredOf(k), temp: extra(k),
        base: P[k].base, baseNote: P[k].baseNote || '', items });
    }
    return out;
  };

  // ---------- usługi dla innych modułów ----------
  BL.machineSlots = function () {
    let n = 0;
    for (const b of list()) if (done(b)) n += BL.def(b).slots || 0;
    return n;
  };
  // miejsca postojowe maszyn (środki kafli garaży/warsztatu) — dla prac i grafiki: [{ x, y, buildingUid, covered: true }]
  BL.machineSpots = function () {
    const r = [];
    for (const b of list()) {
      if (!done(b)) continue;
      const n = BL.def(b).slots || 0;
      if (!n) continue;
      const f = BL.footprint(b);
      for (let k = 0; k < n; k++) {
        const u = (k + 0.5) / n;
        r.push(f.w >= f.h ? { x: f.x + u * f.w, y: f.y + f.h * 0.5, buildingUid: b.uid, covered: true } : { x: f.x + f.w * 0.5, y: f.y + u * f.h, buildingUid: b.uid, covered: true });
      }
    }
    return r;
  };
  BL.repairDiscount = function () {
    let d = 0;
    for (const b of list()) if (done(b) && b.type === 'workshop') d = Math.max(d, BL.def(b).repairDiscount || 0);
    return d;
  };
  BL.fuelDiscount = function () {
    let d = 0;
    for (const b of list()) if (done(b) && b.type === 'fuel_station') d = Math.max(d, BL.def(b).fuelDiscount || 0);
    return d;
  };
  // kafle wybiegu wokół budynku (podwórze, wolne) — do rysowania zwierząt
  BL.penTiles = function (uid) {
    if (penRev !== rev) { penCache = {}; penRev = rev; }
    if (penCache[uid]) return penCache[uid];
    const b = BL.get(uid);
    if (!b) return [];
    const f = BL.footprint(b), r = [];
    for (let y = f.y - 1; y <= f.y + f.h; y++) for (let x = f.x - 1; x <= f.x + f.w; x++) {
      if (x >= f.x && x < f.x + f.w && y >= f.y && y < f.y + f.h) continue;
      if (!G.inMap(x, y)) continue;
      const i = G.idx(x, y);
      if (BL.isFree(i)) r.push({ x, y });
    }
    // brak miejsca wokół — krawędź budynku od frontu
    if (!r.length) for (let x = f.x; x < f.x + f.w; x++) r.push({ x, y: f.y + f.h - 0.6, edge: true });
    penCache[uid] = r;
    return r;
  };

  // godziny pracy dziennie przy budynkach produkcyjnych (szklarnia, agroturystyka) — wliczane w G.animals.laborHours()
  BL.laborHours = function () {
    const m = G.date().month;
    let h = 0;
    for (const b of list()) {
      if (!done(b)) continue;
      const d = BL.def(b);
      if (b.type === 'greenhouse' && (!d.seasonal || (m >= 3 && m <= 9))) h += d.labor || 0;
      if (d.agro && m >= 4 && m <= 8) h += 3;
      if (b.type === 'biogas') h += 1;
    }
    return h;
  };

  // ---------- punkt rozładunku (dla modułu prac) ----------
  // unloadPoint(productId, from?: {x,y}) → { x, y (środek kafla podwórza przy budynku), buildingUid, free (ile jeszcze się zmieści) }
  // Najbliższy ukończony budynek z wolnym miejscem na produkt; pasza treściwa najpierw do zbiorników paszowych.
  // Gdy żaden budynek nie ma miejsca, a pojemność bazowa (pod plandeką / pryzma) tak — punkt na środku podwórza, buildingUid: null.
  // null = brak miejsca w ogóle (trzeba sprzedać prosto z pola albo zostawić ziarno na przyczepie).
  BL.unloadPoint = function (id, from) {
    if (!G.S || !G.S.farm) return null;
    const free = G.inv.free(id);
    if (!(free > 0)) return null;
    const key = poolOf(id), Y = G.S.farm.yard;
    from = from || { x: Y.x + Y.w / 2, y: Y.y + Y.h / 2 };
    const keys = id === 'pasza_tresciwa' ? ['pasza', 'zboże'] : (key ? [key] : []);
    for (const k of keys) {
      let best = null, bd = 1e9;
      for (const b of list()) {
        if (!done(b)) continue;
        const cap = (BL.def(b).capacity || {})[k];
        if (!(cap > 0)) continue;
        if (k === 'pasza' && !(caps().pasza.cap - poolUsed('pasza') > 0.01)) continue;
        // stodoła/dom/obora tylko awaryjnie — ziarno najpierw do silosów i magazynu płaskiego
        const pen = (b.type === 'barn' || b.type === 'house' || b.type === 'garage') ? 40 : 0;
        const f = BL.footprint(b), cx = f.x + f.w / 2, cy = f.y + f.h / 2, dd = Math.hypot(cx - from.x, cy - from.y) + pen;
        if (dd < bd) { bd = dd; best = b; }
      }
      if (best) {
        // wolny kafel podwórza przy budynku (do podjazdu); jeśli brak — krawędź budynku
        const f = BL.footprint(best);
        let pt = null, pd = 1e9;
        for (const t of BL.penTiles(best.uid)) {
          if (t.edge) continue;
          const dd = Math.hypot(t.x + 0.5 - from.x, t.y + 0.5 - from.y);
          if (dd < pd) { pd = dd; pt = { x: t.x + 0.5, y: t.y + 0.5 }; }
        }
        if (!pt) pt = { x: f.x + f.w / 2, y: f.y + f.h };
        return { x: pt.x, y: pt.y, buildingUid: best.uid, free };
      }
    }
    if (!key && id !== 'pasza_tresciwa') return { x: Y.x + Y.w / 2, y: Y.y + Y.h / 2, buildingUid: null, free };
    // tylko pojemność bazowa: wolny kafel podwórza najbliżej środka
    let pt = { x: Y.x + Y.w / 2, y: Y.y + Y.h / 2 }, pd = 1e9;
    for (let y = Y.y; y < Y.y + Y.h; y++) for (let x = Y.x; x < Y.x + Y.w; x++) {
      if (!G.inMap(x, y) || !BL.isFree(G.idx(x, y))) continue;
      const dd = Math.hypot(x + 0.5 - (Y.x + Y.w / 2), y + 0.5 - (Y.y + Y.h / 2));
      if (dd < pd) { pd = dd; pt = { x: x + 0.5, y: y + 0.5 }; }
    }
    return { x: pt.x, y: pt.y, buildingUid: null, free, open: true };
  };

  // ---------- informacje dla UI ----------
  BL.info = function (uid) {
    const b = BL.get(uid);
    if (!b) return null;
    const T = G.BUILDINGS[b.type], d = BL.def(b), next = T.levels[b.level] || null;
    const herds = (G.S.animals && G.S.animals.herds || []).filter(h => h.buildingUid === uid);
    const fx = [];
    if (d.slots) fx.push(d.slots + ' miejsc na maszyny');
    for (const k in d.capacity) fx.push((POOLS()[k] ? POOLS()[k].name : k) + ': ' + G.fmtNum(d.capacity[k], 0) + ' ' + (POOLS()[k] ? POOLS()[k].unit : ''));
    for (const s in d.houses) fx.push((G.ANIMALS[s] ? G.ANIMALS[s].plural : s) + ': do ' + d.houses[s] + ' szt.');
    if (d.repairDiscount) fx.push('naprawy −' + Math.round(d.repairDiscount * 100) + '%');
    if (d.fuelDiscount) fx.push('paliwo −' + Math.round(d.fuelDiscount * 100) + '%');
    if (d.kW) fx.push(d.kW + ' kW mocy elektrycznej');
    if (d.yieldYear) fx.push('ok. ' + G.fmtNum(d.yieldYear / 1000, 1) + ' t warzyw/rok');
    return {
      uid, type: b.type, variant: T.variant || null, name: T.name, levelName: d.name, level: b.level, maxLevel: T.levels.length, desc: d.desc || T.desc,
      building: !done(b), progress: b.progress, upgrading: b.upg != null, upgProgress: b.upg || 0,
      daysLeft: !done(b) ? Math.ceil((1 - b.progress) * T.buildDays) : (b.upg != null ? Math.ceil((1 - b.upg) * next.buildDays) : 0),
      upkeep: d.upkeep, capacity: d.capacity, houses: d.houses, effects: fx,
      next: next ? { name: next.name, price: next.price, days: next.buildDays, desc: next.desc } : null,
      herds: herds.map(h => ({ uid: h.uid, species: h.species, count: h.count })),
      footprint: BL.footprint(b), canUpgrade: BL.canUpgrade(uid), canDemolish: BL.canDemolish(uid)
    };
  };
  BL.catalog = function () {
    return Object.keys(G.BUILDINGS).map(type => {
      const T = G.BUILDINGS[type];
      let reason = '';
      if (T.max && BL.count(type) >= T.max) reason = 'Już masz';
      else if (T.req && !T.req.some(r => BL.has(r))) reason = 'Wymaga: ' + T.req.map(r => G.BUILDINGS[r].name).join(' lub ');
      else if (!G.finance.canAfford(T.price)) reason = 'Za mało pieniędzy';
      return { type, variant: T.variant || null, name: T.name, cat: T.cat, price: T.price, buildDays: T.buildDays, size: T.size, model: T.model, color: T.color, desc: T.desc,
        upkeep: T.upkeep, owned: BL.count(type), available: !reason, reason,
        levels: T.levels.map(L => ({ name: L.name, price: L.price, total: L.cumPrice, days: L.buildDays, capacity: L.capacity, houses: L.houses, slots: L.slots || 0, desc: L.desc })) };
    });
  };
  BL.opts = () => G.S.bmeta.opts;
  BL.setOpt = (k, v) => { G.S.bmeta.opts[k] = v; };

  // ---------- czas ----------
  G.on('tick', function () {
    for (const b of list()) {
      const T = G.BUILDINGS[b.type];
      if (!T) continue;
      if (b.progress < 1) {
        b.progress = Math.min(1, b.progress + 1 / (T.buildDays * C.TICKS_PER_DAY));
        if (b.progress >= 1 - 1e-6) {
          b.progress = 1; bump();
          G.notify('✅ Ukończono budowę: ' + T.levels[0].name, 'good', { tile: G.idx(b.x, b.y) });
          G.emit('built', b);
        }
      } else if (b.upg != null) {
        const L = T.levels[b.level];
        if (!L) { delete b.upg; continue; }
        b.upg = Math.min(1, b.upg + 1 / (L.buildDays * C.TICKS_PER_DAY));
        if (b.upg >= 1 - 1e-6) {
          delete b.upg; b.level++; bump();
          G.notify('✅ Ukończono rozbudowę: ' + L.name, 'good', { tile: G.idx(b.x, b.y) });
          G.emit('built', b);
        }
      }
    }
  });

  function sellOut(id, qty, note) {
    // sprzedaż przez rynek, jeśli jest; w przeciwnym razie po cenie bazowej
    if (G.animals && G.animals.sellProduct) return G.animals.sellProduct(id, qty, note);
    const zl = qty * ((G.PRODUCTS[id] || {}).base || 0);
    G.finance.earn(zl, 'sprzedaż', note);
    return zl;
  }
  const careF = () => (G.S.animals && G.S.animals.labor && G.S.animals.labor.factor != null) ? G.S.animals.labor.factor : 1;

  G.on('daily', function (d) {
    const S = G.S, m = d.month;
    // straty ziarna/bel/kiszonki przechowywanych bez dachu
    const P = POOLS(), c = caps(), rain = G.weather && (G.weather.type === 'rain' || G.weather.type === 'storm');
    for (const k in P) {
      const pl = P[k];
      if (!pl.loss) continue;
      const used = poolUsed(k), excess = used - coveredOf(k);
      if (excess <= 0.001) continue;
      const lost = excess * (pl.loss + (rain ? (pl.rainLoss || 0) : 0));
      if (lost <= 0) continue;
      for (const j in S.inv) {
        const q = inPool(j, k);
        if (!(q > 0)) continue;
        const f = unitF(j, k), share = q * f / used;
        G.inv.take(j, Math.min(S.inv[j], Math.round(lost * share / f * 1000) / 1000));
      }
      S.bmeta.losses[k] = (S.bmeta.losses[k] || 0) + lost;
      const last = S.bmeta.lastLossNote[k] || -99;
      if (d.dayIndex - last >= 6 && lost > (pl.unit === 'bela' ? 0.5 : 0.05)) {
        S.bmeta.lastLossNote[k] = d.dayIndex;
        G.notify('⚠️ ' + pl.name + ': ' + G.fmtNum(excess, 1) + ' ' + pl.unit + ' leży bez dachu (' + (pl.baseNote || 'na zewnątrz') + ') — straty ' +
          G.fmtNum(lost, 2) + ' ' + pl.unit + '/dzień. Postaw magazyn.', 'warn', { key: 'loss_' + k });
      }
    }

    let vegKg = 0, agro = 0, gas = 0;
    const hasHorses = (S.animals && S.animals.herds || []).some(h => h.species === 'kon' && h.count > 0);
    const hasBees = (S.animals && S.animals.herds || []).some(h => h.species === 'pszczoly' && h.count > 0);
    for (const b of list()) {
      if (!done(b)) continue;
      const def = BL.def(b);
      // szklarnia / tunel
      if (b.type === 'greenhouse') {
        const season = !def.seasonal || (m >= 3 && m <= 9);
        if (season) {
          const days = def.seasonal ? 42 : 72;
          const sMul = def.seasonal ? (m === 3 || m === 9 ? 0.6 : (m >= 5 && m <= 7 ? 1.25 : 1)) : (m <= 1 || m >= 10 ? 0.7 : 1.1);
          vegKg += def.yieldYear / days * sMul * (0.5 + 0.5 * careF());
        }
      }
      // agroturystyka
      if (def.agro) {
        const base = (m >= 5 && m <= 7) ? 1600 : (m === 4 || m === 8 ? 600 : 0);
        agro += base * (hasHorses ? 1.25 : 1) * (hasBees ? 1.05 : 1) * (0.6 + 0.4 * careF());
      }
      // biogazownia
      if (b.type === 'biogas') {
        const target = def.kW * 8000 / 2 / 72;   // m³ biogazu na dzień gry (≈ 2 kWh el./m³, 8000 h/rok)
        let need = target, digest = 0;
        const feedS = (id, perUnit, digestK) => {
          if (need <= 0) return;
          const have = G.inv.get(id);
          if (have <= 0) return;
          const q = Math.min(have, need / perUnit);
          if (q <= 0 || !G.inv.take(id, Math.round(q * 1000) / 1000)) return;
          need -= q * perUnit; digest += q * digestK;
        };
        feedS('gnojowica', 20, 0.85);
        feedS('obornik', 55, 0.8);
        if (S.bmeta.opts.biogasSilage) feedS('kiszonka', 200, 0.8);
        const prod = target - need;
        gas += prod;
        if (digest > 0) G.inv.add('gnojowica', Math.round(digest * 100) / 100);
        b.out = Math.round(prod / target * 100) / 100; // obciążenie 0..1 (dla UI)
        if (b.out < 0.3) G.notify('⚡ Biogazownia pracuje na ' + Math.round(b.out * 100) + '% mocy — brak substratu (gnojowica, obornik, kiszonka)', 'warn', { key: 'biogas_low' });
      }
    }
    if (vegKg > 0) {
      const added = G.inv.add('warzywa', Math.round(vegKg));
      S.bmeta.stats.veg = (S.bmeta.stats.veg || 0) + added;
    }
    if (d.dayIndex % 2 === 0 && G.inv.get('warzywa') > 0) {
      const q = G.inv.get('warzywa');
      sellOut('warzywa', q, 'Warzywa ze szklarni — odbiór hurtowni');
    }
    if (agro > 0) G.finance.earn(Math.round(agro), 'usługi', 'Agroturystyka — goście');
    if (gas > 0) {
      const kwh = gas * 2;
      G.finance.earn(Math.round(kwh * 0.7), 'sprzedaż', 'Energia z biogazowni: ' + G.fmtNum(kwh / 1000, 1) + ' MWh');
      S.bmeta.stats.mwh = (S.bmeta.stats.mwh || 0) + kwh / 1000;
    }
  });

  G.on('monthly', function (d) {
    // utrzymanie za miesiąc (6 dni gry) — jedna pozycja w księdze
    let up = 0, gh = 0;
    const heatFromBiogas = BL.has('biogas');
    for (const b of list()) {
      if (!done(b)) continue;
      const def = BL.def(b);
      up += def.upkeep * C.DAYS_PER_MONTH;
      if (b.type === 'greenhouse') {
        const m = d.month;
        if (!def.seasonal || (m >= 3 && m <= 9)) gh += def.monthCost || 0;
        if (def.heatCost && (m <= 2 || m >= 10)) gh += def.heatCost * (heatFromBiogas ? 0.3 : 1);
      }
    }
    if (up > 0) G.finance.spend(up, 'inne', 'Utrzymanie budynków (podatek, ubezpieczenie, naprawy)', true);
    if (gh > 0) G.finance.spend(gh, 'inne', 'Szklarnia: rozsada, nawozy, ogrzewanie', true);
  });
  G.on('yearly', function () { G.S.bmeta.lastYear = { losses: G.S.bmeta.losses, stats: G.S.bmeta.stats }; G.S.bmeta.losses = {}; G.S.bmeta.stats = {}; });

  // ---------- nowa gra / wczytanie ----------
  function freshMeta() { return { opts: { biogasSilage: true }, losses: {}, lastLossNote: {}, stats: {} }; }

  G.on('newGame', function () {
    G.S.buildings = [];
    G.S.bmeta = freshMeta();
    bump();
    const Y = G.S.farm && G.S.farm.yard;
    if (!Y) return;
    for (const s of G.BUILDINGS_START) {
      let x = Y.x + s.dx, y = Y.y + s.dy;
      if (!BL.canPlace(s.type, x, y, s.rot, true).ok) {
        // awaryjnie: pierwsze wolne miejsce na podwórzu
        let found = false;
        for (let yy = Y.y; yy < Y.y + Y.h && !found; yy++) for (let xx = Y.x; xx < Y.x + Y.w && !found; xx++) {
          if (BL.canPlace(s.type, xx, yy, s.rot, true).ok) { x = xx; y = yy; found = true; }
        }
        if (!found) continue;
      }
      insert(s.type, x, y, s.rot, s.level, 1);
    }
  });

  G.on('load', function () {
    const S = G.S;
    if (!Array.isArray(S.buildings)) S.buildings = [];
    // zapis z wersji z jednym typem 'silo' (100/250/500 t) → silos lejowy 108/194/312 t
    for (const b of S.buildings) if (b && b.type === 'silo') { b.type = 'silo_hopper'; b.level = [3, 4, 5][Math.max(0, Math.min(2, (b.level | 0) - 1))]; delete b.upg; }
    S.buildings = S.buildings.filter(b => b && G.BUILDINGS[b.type]);
    for (const b of S.buildings) {
      const T = G.BUILDINGS[b.type];
      b.rot = b.rot ? 1 : 0;
      b.level = Math.max(1, Math.min(T.levels.length, b.level | 0 || 1));
      b.progress = Math.max(0, Math.min(1, +b.progress || 0));
      if (b.upg != null && (b.level >= T.levels.length || !(b.upg >= 0))) delete b.upg;
      if (!b.uid) b.uid = G.uid();
    }
    if (!S.bmeta || typeof S.bmeta !== 'object') S.bmeta = freshMeta();
    const f = freshMeta();
    for (const k in f) if (!S.bmeta[k] || typeof S.bmeta[k] !== 'object') S.bmeta[k] = f[k];
    for (const k in f.opts) if (S.bmeta.opts[k] == null) S.bmeta.opts[k] = f.opts[k];
    for (const k in poolMemo) delete poolMemo[k];
    bump();
  });
})();
