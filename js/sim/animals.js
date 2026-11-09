// Złote Pola — hodowla: stada, żywienie, zdrowie, produkcja → G.animals (agent: hodowla i budynki)
//
// Stan: G.S.animals = {
//   herds: [{ uid, species, breed?, buildingUid, count, health 0..1, fed 0..1, care 0..1, age (dni gry — kury), cohorts?: [{ n, w (kg), age }] (tucz),
//             young: [{ n, age, f (samica), raise }] (cielęta, jagnięta, koźlęta), sick: null|{ id, name, days, prod, mort, frac, treated },
//             acc: { birth, dead }, prod: { produkt: ilość w ostatnim dniu }, ate: { produkt: ilość }, comps: [{ key, name, frac }], bedding 0..1 }],
//   opts: { autoBuy, feedGrains, autoSell, autoSellEggs, raiseHeifers, grazing, autoVet },
//   labor: { need, got, factor }, pendingCost, pendingIncome, stats: { prod, income, costs, born, died }, lastYear, startPending }
//
// Skala: dane w G.ANIMALS są na dobę rzeczywistą; 1 dzień gry = G.ANIMAL_DAY_SCALE (≈5,07) dób (rok gry 72 dni = 365 dób).
// Żywienie raz dziennie (hook 'daily') z magazynu G.inv: składniki dawki po kolei wg preferencji; zboża — najpierw najtańsze.
// Mleko odbiera mleczarnia co 2 dni, jaja — co 3 dni (opcja), warzywa — moduł budynków. Sprzedaż przez G.market.sell (jeśli jest).
(function () {
  const C = G.CFG;
  const A = G.animals = {};
  const SC = () => G.ANIMAL_DAY_SCALE || 365 / 72;
  A.SCALE = SC;

  const DEFAULT_OPTS = { autoBuy: true,  feedGrains: true, autoSell: true, autoSellEggs: true, raiseHeifers: false, grazing: true, autoVet: true };
  const st = () => G.S.animals;
  const herdsArr = () => (G.S && G.S.animals && G.S.animals.herds) || [];
  const bget = uid => (G.buildings && G.buildings.get) ? G.buildings.get(uid) : ((G.S.buildings || []).find(b => b.uid === uid) || null);
  const bdef = b => (G.buildings && G.buildings.def) ? G.buildings.def(b) : Object.assign({}, G.BUILDINGS[b.type], G.BUILDINGS[b.type].levels[(b.level || 1) - 1]);
  const bdone = b => b && b.progress >= 1;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const r3 = v => Math.round(v * 1000) / 1000;

  // ---------- ceny ----------
  function price(id) {
    let p = null;
    try { if (G.market && G.market.price) p = G.market.price(id); } catch (e) { p = null; }
    if (!(p > 0)) p = (G.PRODUCTS[id] && G.PRODUCTS[id].base) || 0;
    return p;
  }
  function buyPrice(id) {
    let p = null;
    try { if (G.market && G.market.buyPrice) p = G.market.buyPrice(id); } catch (e) { p = null; }
    if (!(p > 0)) p = ((G.PRODUCTS[id] && G.PRODUCTS[id].base) || 0) * 1.05;
    return p;
  }
  // kg w jednej jednostce produktu
  function kgPer(id) {
    const p = G.PRODUCTS[id] || {};
    if (p.kg > 0) return p.kg;
    switch (p.unit) {
      case 't': return 1000;
      case 'm3': return 1000;
      case 'bela': return G.BALE_KG[id] || 300;
      default: return 1;
    }
  }

  // sprzedaż produktu: przez rynek, jeśli istnieje; inaczej po cenie (skup) z G.finance.earn → zwraca zł
  A.sellProduct = function (id, qty, note) {
    qty = r3(qty);
    if (!(qty > 0)) return 0;
    let zl = 0;
    // towar musi być w magazynie (żywiec trafia tam na chwilę — pula bez limitu)
    if (G.inv.get(id) < qty) G.inv.add(id, qty - G.inv.get(id));
    qty = Math.min(qty, G.inv.get(id));
    if (!(qty > 0)) return 0;
    if (G.market && G.market.sell) {
      const before = G.inv.get(id), money0 = G.S.money;
      let res = 0;
      try { res = G.market.sell(id, qty); } catch (e) { res = 0; }
      if (G.inv.get(id) < before - 1e-6 || G.S.money > money0 + 1e-6) {   // rynek przyjął towar
        zl = (typeof res === 'number' && res > 0) ? res : Math.max(0, G.S.money - money0);
        if (st()) st().stats.income += zl;
        return zl;
      }
    }
    G.inv.take(id, qty);
    zl = Math.round(qty * price(id) * 100) / 100;
    G.finance.earn(zl, 'sprzedaż', note || ('Sprzedaż: ' + ((G.PRODUCTS[id] || {}).name || id)));
    G.emit('sold', id, qty, zl);
    if (st()) st().stats.income += zl;
    return zl;
  };
  // sprzedaż żywca prosto z budynku (bez magazynu)
  function sellLive(id, kg, note) {
    kg = Math.round(kg * 10) / 10;
    if (!(kg > 0)) return 0;
    return A.sellProduct(id, kg, note);
  }

  // ---------- miejsca w budynkach ----------
  function spaceWeight(h) {
    let w = h.count;
    if (h.species === 'krowa') for (const y of h.young || []) if (y.raise) w += y.n * 0.5;
    return w;
  }
  A.space = function (buildingUid) {
    const b = bget(buildingUid);
    if (!b) return null;
    const d = bdef(b), houses = d.houses || {};
    let occ = 0;
    for (const h of herdsArr()) if (h.buildingUid === buildingUid && houses[h.species]) occ += spaceWeight(h) / houses[h.species];
    const free = {};
    for (const s in houses) free[s] = bdone(b) ? Math.max(0, Math.floor((1 - occ) * houses[s] + 1e-6)) : 0;
    return { building: b, done: bdone(b), occ: Math.round(occ * 1000) / 1000, houses, free };
  };
  function buildingsFor(species) {
    const sp = G.ANIMALS[species];
    return (G.S.buildings || []).filter(b => b.type === sp.building);
  }

  // ---------- stada ----------
  function newHerd(species, buildingUid, breed) {
    const h = { uid: G.uid(), species, buildingUid, count: 0, health: 1, fed: 1, care: 1, age: 0, young: [], sick: null,
      acc: { birth: 0, dead: 0 }, prod: {}, ate: {}, comps: [], bedding: 1 };
    if (breed) h.breed = breed;
    if (G.ANIMALS[species].growth) h.cohorts = [];
    st().herds.push(h);
    return h;
  }
  function findHerd(species, buildingUid, breed) {
    return herdsArr().find(h => h.species === species && h.buildingUid === buildingUid && (h.breed || null) === (breed || null)) || null;
  }
  function recount(h) { if (h.cohorts) h.count = h.cohorts.reduce((a, c) => a + c.n, 0); }
  function removeHerdIfEmpty(h) {
    recount(h);
    if (h.count <= 0 && !(h.young && h.young.some(y => y.n > 0))) {
      const i = st().herds.indexOf(h);
      if (i >= 0) st().herds.splice(i, 1);
    }
  }
  function headsEq(h) {
    const sp = G.ANIMALS[h.species];
    if (h.cohorts && sp.growth) {
      const g = sp.growth;
      return h.cohorts.reduce((a, c) => a + c.n * clamp(c.w / g.ref, g.minMul, g.maxMul), 0);
    }
    let n = h.count;
    if (h.species === 'krowa') {
      for (const y of h.young || []) n += y.n * (y.raise ? 0.4 : 0.08);
      const br = sp.breeds && sp.breeds[h.breed || 'hf'];
      if (br && br.feedMul) n *= br.feedMul;
    }
    return n;
  }
  function herdValue(h) {
    const sp = G.ANIMALS[h.species];
    if (h.cohorts && sp.sellAs) return h.cohorts.reduce((a, c) => a + c.n * c.w * price(sp.sellAs), 0);
    const br = sp.breeds && sp.breeds[h.breed || Object.keys(sp.breeds)[0]];
    return h.count * sp.price * (br ? br.priceMul : 1);
  }

  A.herds = () => herdsArr();
  A.herd = uid => herdsArr().find(h => h.uid === uid) || null;

  A.buy = function (species, n, buildingUid, breed) {
    const sp = G.ANIMALS[species];
    n = Math.floor(n);
    if (!sp) return { ok: false, reason: 'Nieznany gatunek' };
    if (!(n >= 1)) return { ok: false, reason: 'Podaj liczbę sztuk' };
    if (sp.breeds) { if (!breed || !sp.breeds[breed]) breed = Object.keys(sp.breeds)[0]; } else breed = null;
    if (buildingUid == null) {
      let best = null, bestFree = 0;
      for (const b of buildingsFor(species)) {
        const s = A.space(b.uid);
        if (s && s.free[species] > bestFree) { best = b; bestFree = s.free[species]; }
      }
      if (!best) return { ok: false, reason: 'Brak miejsca — potrzebny budynek: ' + G.BUILDINGS[sp.building].name };
      buildingUid = best.uid;
    }
    const b = bget(buildingUid);
    if (!b || b.type !== sp.building) return { ok: false, reason: 'Ten gatunek wymaga budynku: ' + G.BUILDINGS[sp.building].name };
    if (!bdone(b)) return { ok: false, reason: 'Budynek jest jeszcze w budowie' };
    const s = A.space(buildingUid);
    if (!(s.houses[species] > 0)) return { ok: false, reason: 'Ten budynek nie mieści zwierząt tego gatunku' };
    if (s.free[species] < n) return { ok: false, reason: 'Wolnych miejsc: ' + s.free[species] + ' (rozbuduj budynek)' };
    const br = breed ? sp.breeds[breed] : null;
    const cost = Math.round(sp.price * (br ? br.priceMul : 1) * n);
    if (!G.finance.spend(cost, 'zwierzęta', 'Zakup: ' + n + ' × ' + sp.name + (br ? ' (' + br.name + ')' : ''))) return { ok: false, reason: 'Brak środków' };
    let h = findHerd(species, buildingUid, breed) || newHerd(species, buildingUid, breed);
    if (h.cohorts) {
      h.cohorts.push({ n, w: sp.growth.start, age: 0 });
      recount(h);
    } else {
      h.age = h.count > 0 ? (h.age * h.count) / (h.count + n) : 0;
      h.count += n;
    }
    // nowe zwierzęta są zdrowe — zdrowie stada uśredniane
    h.health = (h.health * Math.max(0, h.count - n) + n) / h.count;
    G.notify('🛒 Kupiono: ' + n + ' × ' + sp.name, 'good', { key: 'buy_' + species });
    G.emit('bought', 'animal', h);
    return { ok: true, herd: h, cost };
  };

  // sprzedaż n sztuk dorosłych ze stada (tucz: najcięższe najpierw) → { ok, zl }
  A.sell = function (uid, n) {
    const h = A.herd(uid);
    if (!h) return { ok: false, reason: 'Brak stada' };
    const sp = G.ANIMALS[h.species];
    n = Math.min(Math.floor(n), h.count);
    if (!(n >= 1)) return { ok: false, reason: 'Brak zwierząt do sprzedaży' };
    let zl = 0;
    if (h.cohorts && sp.sellAs) {
      h.cohorts.sort((a, b) => b.w - a.w);
      let left = n, kg = 0;
      for (const c of h.cohorts) {
        if (!left) break;
        const k = Math.min(left, c.n);
        // lekkie sztuki — potrącenie za niedowagę
        const pen = c.w < sp.growth.sell * 0.8 ? 0.85 : 1;
        kg += k * c.w * pen; c.n -= k; left -= k;
      }
      h.cohorts = h.cohorts.filter(c => c.n > 0);
      zl = sellLive(sp.sellAs, kg, 'Sprzedaż: ' + n + ' × ' + sp.name);
    } else if (sp.cullKg) {
      const id = h.species === 'locha' ? 'zywiec_wieprzowy' : (h.species === 'krowa' ? 'zywiec_wolowy' : 'zywiec_jagniecy');
      // zwierzęta wybrakowane: niższa cena za kg
      const kg = n * sp.cullKg * sp.cullMul;
      h.count -= n;
      zl = sellLive(id, kg, 'Sprzedaż (brakowanie): ' + n + ' × ' + sp.name);
    } else {
      zl = Math.round(n * (sp.cullValue || 0) * (0.5 + 0.5 * h.health));
      h.count -= n;
      G.finance.earn(zl, 'sprzedaż', 'Sprzedaż: ' + n + ' × ' + sp.name);
      st().stats.income += zl;
    }
    removeHerdIfEmpty(h);
    G.notify('💰 Sprzedano ' + n + ' × ' + sp.name + ' za ' + G.fmtMoney(zl), 'money', { key: 'sell_' + uid });
    return { ok: true, zl };
  };

  // ---------- pastwisko ----------
  let pastCache = { day: -1 };
  function meadowParcels() {
    return (G.S.parcels || []).filter(p => p.owner === 'player' && p.kind === 'meadow' && p.tiles && p.tiles.length);
  }
  function pastureSeason(month) { return (month >= 4 && month <= 8) ? 1 : ((month === 3 || month === 9) ? 0.5 : 0); }
  function pastureFrac(month) {
    if (!st().opts.grazing) return 0;
    const sea = pastureSeason(month);
    if (!sea) return 0;
    const ha = meadowParcels().reduce((a, p) => a + p.area, 0);
    let lu = 0;
    for (const h of herdsArr()) {
      const sp = G.ANIMALS[h.species];
      if (sp.ration.some(c => c.opts.some(o => o.id === 'pastwisko'))) lu += h.count * sp.lu;
    }
    if (!(lu > 0) || !(ha > 0)) return 0;
    return Math.min(0.85, ha * 2.5 / lu) * sea;
  }
  A.pasture = function () {
    const m = G.cm(), ha = meadowParcels().reduce((a, p) => a + p.area, 0);
    return { ha, frac: pastureFrac(m), season: pastureSeason(m) > 0, grazing: st().opts.grazing };
  };

  // ---------- żywienie ----------
  let grainCache = { t: -1, list: [] };
  function grainsSorted() {
    if (grainCache.t === G.S.tick) return grainCache.list;
    grainCache = { t: G.S.tick, list: G.FEED_GRAINS.slice().sort((a, b) => price(a) - price(b)) };
    return grainCache.list;
  }
  function expandOpts(opts) {
    const r = [];
    for (const o of opts) {
      if (o.id === 'zboza') { if (st().opts.feedGrains) for (const g of grainsSorted()) r.push({ id: g, f: o.f, q: o.q, grain: true }); }
      else r.push(o);
    }
    return r;
  }
  // inv: { get(id), take(id, q) } — prawdziwy magazyn albo wirtualny (symulacja na sucho)
  function feedHerd(h, inv, pf) {
    const sp = G.ANIMALS[h.species], n = SC();
    const res = { fed: 1, comps: [], ate: {}, wantPasza: 0 };
    if (!sp.ration.length || h.count <= 0) return res;
    const heads = headsEq(h);
    let wsum = 0, score = 0;
    for (const comp of sp.ration) {
      const need = comp.kg * heads * n;
      let left = need, sat = 0, low = 0;
      const hasPast = comp.opts.some(o => o.id === 'pastwisko');
      if (hasPast && pf > 0) { const cov = need * pf; left -= cov; sat += cov; }
      let paszaF = null;
      for (const o of expandOpts(comp.opts)) {
        if (o.id === 'pastwisko') continue;
        if (o.id === 'pasza_tresciwa' && o.q >= 1) paszaF = o.f;
        if (left <= 1e-9) break;
        const unit = kgPer(o.id), have = inv.get(o.id);
        if (!(have > 0)) continue;
        const eqHave = have * unit / o.f;
        const use = Math.min(left, eqHave);
        let q = use * o.f / unit;
        q = Math.min(have, Math.ceil(q * 1000) / 1000);
        if (!(q > 0) || !inv.take(o.id, q)) continue;
        res.ate[o.id] = (res.ate[o.id] || 0) + q;
        left -= use; sat += use * o.q;
        if (o.q < 1) low += use;
      }
      left = Math.max(0, left);
      const frac = need > 0 ? sat / need : 1;
      if (paszaF != null) res.wantPasza += (left + low) * paszaF / 1000; // t paszy treściwej, która poprawiłaby dawkę
      res.comps.push({ key: comp.key, name: comp.name, need, short: left, frac: Math.round(frac * 100) / 100 });
      wsum += comp.w; score += comp.w * clamp(frac, 0, 1);
    }
    res.fed = wsum > 0 ? score / wsum : 1;
    return res;
  }
  function virtualInv() {
    const V = {};
    return {
      get: id => (id in V ? V[id] : G.inv.get(id)),
      take(id, q) { const v = (id in V ? V[id] : G.inv.get(id)); if (v + 1e-9 < q) return false; V[id] = v - q; return true; }
    };
  }
  const realInv = { get: id => G.inv.get(id), take: (id, q) => G.inv.take(id, q) };
  const ordered = () => herdsArr().slice().sort((a, b) => G.ANIMAL_ORDER.indexOf(a.species) - G.ANIMAL_ORDER.indexOf(b.species));

  function dryRun() {
    const inv = virtualInv(), pf = pastureFrac(G.cm()), out = { herds: [], ate: {}, wantPasza: 0, pf };
    for (const h of ordered()) {
      const r = feedHerd(h, inv, pf);
      out.herds.push({ h, r });
      for (const id in r.ate) out.ate[id] = (out.ate[id] || 0) + r.ate[id];
      out.wantPasza += r.wantPasza;
    }
    return out;
  }

  // zapotrzebowanie na dzień gry vs zapas — dla UI
  A.needs = function () {
    const n = SC(), full = {}, comps = [];
    // pełne zapotrzebowanie wg pierwszej (preferowanej) paszy każdego składnika
    const pf = pastureFrac(G.cm());
    for (const h of ordered()) {
      const sp = G.ANIMALS[h.species], heads = headsEq(h);
      for (const comp of sp.ration) {
        const o = expandOpts(comp.opts).find(x => x.id !== 'pastwisko');
        if (!o) continue;
        const hasPast = comp.opts.some(x => x.id === 'pastwisko');
        const eq = comp.kg * heads * n * (hasPast ? 1 - pf : 1);
        full[o.id] = (full[o.id] || 0) + eq * o.f / kgPer(o.id);
      }
    }
    const dr = dryRun();
    const ids = new Set(Object.keys(full).concat(Object.keys(dr.ate)));
    const items = [];
    let cost = 0;
    for (const id of ids) {
      const perDay = dr.ate[id] || 0, stock = G.inv.get(id);
      cost += perDay * price(id);
      items.push({ id, name: (G.PRODUCTS[id] || {}).name || id, unit: (G.PRODUCTS[id] || {}).unit || '', icon: (G.PRODUCTS[id] || {}).icon || '',
        perDay: r3(perDay), ideal: r3(full[id] || 0), stock: r3(stock), days: perDay > 0 ? Math.floor(stock / perDay) : null });
    }
    for (const x of dr.herds) for (const c of x.r.comps) if (c.frac < 0.98) comps.push({ herd: x.h.uid, species: x.h.species, comp: c.key, name: c.name, frac: c.frac });
    // ściółka
    let straw = 0;
    for (const h of herdsArr()) straw += beddingKg(h) / kgPer('sloma');
    items.push({ id: 'sloma', name: ((G.PRODUCTS.sloma || {}).name || 'Słoma') + ' (ściółka)', unit: 'bela', icon: (G.PRODUCTS.sloma || {}).icon || '',
      perDay: r3(straw), ideal: r3(straw), stock: r3(G.inv.get('sloma')), days: straw > 0 ? Math.floor(G.inv.get('sloma') / straw) : null, bedding: true });
    return { items: items.sort((a, b) => b.perDay - a.perDay), deficits: comps, costPerDay: Math.round(cost), pasture: pf, ok: comps.length === 0, wantPasza: r3(dr.wantPasza) };
  };

  function autoBuy() {
    const S = st();
    if (!S.opts.autoBuy || !herdsArr().length) return;
    const dr = dryRun();
    if (dr.wantPasza < 0.005) return;
    let q = Math.ceil(dr.wantPasza * 3 * 10) / 10;        // zapas na ~3 dni gry
    q = Math.min(q, Math.floor(G.inv.free('pasza_tresciwa') * 10) / 10);
    if (!(q > 0)) { G.notify('📦 Brak miejsca na paszę treściwą — postaw silos lub magazyn', 'warn', { key: 'autobuy_full' }); return; }
    let ok = false;
    if (G.market && G.market.buy) { try { ok = G.market.buy('pasza_tresciwa', q); } catch (e) { ok = false; } }
    if (!ok && !(G.market && G.market.buy)) {
      const cost = Math.round(q * buyPrice('pasza_tresciwa'));
      if (G.finance.spend(cost, 'pasze', 'Pasza treściwa (automatycznie): ' + G.fmtNum(q, 1) + ' t')) { G.inv.add('pasza_tresciwa', q); ok = true; }
    }
    if (ok) G.notify('🌾 Dokupiono paszę treściwą: ' + G.fmtNum(q, 1) + ' t', 'money', { key: 'autobuy' });
  }

  function beddingKg(h) {
    const sp = G.ANIMALS[h.species], b = bget(h.buildingUid);
    if (!sp.bedding || !b) return 0;
    const d = bdef(b);
    const per = d.manure === 'gnojowica' && sp.beddingFree != null ? sp.beddingFree : sp.bedding;
    return per * headsEq(h) * SC();
  }

  // ---------- praca ----------
  A.laborHours = function () {
    let h = 0;
    for (const x of herdsArr()) {
      if (x.count <= 0) continue;
      const sp = G.ANIMALS[x.species], b = bget(x.buildingUid), mul = b ? (bdef(b).laborMul || 1) : 1;
      let need = sp.laborH * headsEq(x) * mul;
      if (x.species === 'pszczoly') need *= (G.cm() >= 3 && G.cm() <= 8) ? 1.6 : 0.3;
      h += Math.max(sp.laborMin || 0, need);
    }
    if (G.buildings && G.buildings.laborHours) h += G.buildings.laborHours();
    return Math.round(h * 10) / 10;
  };
  A.laborBreakdown = function () {
    const r = [];
    for (const x of herdsArr()) {
      const sp = G.ANIMALS[x.species], b = bget(x.buildingUid), mul = b ? (bdef(b).laborMul || 1) : 1;
      r.push({ herd: x.uid, species: x.species, name: sp.plural, hours: Math.round(Math.max(sp.laborMin || 0, sp.laborH * headsEq(x) * mul) * 10) / 10 });
    }
    if (G.buildings && G.buildings.laborHours) r.push({ name: 'szklarnia / agroturystyka / biogazownia', hours: G.buildings.laborHours() });
    return r;
  };
  function updateLabor() {
    const need = A.laborHours();
    let got;
    if (G.workers && typeof G.workers.animalHours === 'function') {
      try { got = +G.workers.animalHours(need); } catch (e) { got = NaN; }
    }
    if (!(got >= 0)) got = Math.min(need, 8);   // bez modułu pracowników: gospodarz z rodziną ~8 h dziennie
    const factor = need > 0 ? clamp(got / need, 0, 1) : 1;
    st().labor = { need, got: Math.round(got * 10) / 10, factor: Math.round(factor * 100) / 100 };
    if (factor < 0.8) G.notify('👷 Za mało rąk do obsługi zwierząt: ' + G.fmtNum(got, 1) + ' z ' + G.fmtNum(need, 1) + ' h/dzień — spada wydajność. Zatrudnij pracownika.', 'warn', { key: 'labor_low' });
    return factor;
  }

  // ---------- dzienna symulacja stada ----------
  function layRate(h) {
    const wk = 20 + h.age * SC() / 7;
    if (wk < 22) return 0.5;
    if (wk < 28) return 0.5 + (wk - 22) / 6 * 0.42;
    if (wk < 50) return 0.92;
    if (wk < 72) return 0.92 - (wk - 50) / 22 * 0.17;
    return Math.max(0.4, 0.75 - (wk - 72) * 0.01);
  }
  A.henWeeks = h => Math.round(20 + h.age * SC() / 7);

  function removeHeads(h, k) {
    if (k <= 0) return 0;
    if (h.cohorts) {
      let left = k;
      h.cohorts.sort((a, b) => b.n - a.n);
      for (const c of h.cohorts) { const x = Math.min(left, c.n); c.n -= x; left -= x; if (!left) break; }
      h.cohorts = h.cohorts.filter(c => c.n > 0);
      recount(h);
      return k - left;
    }
    const x = Math.min(k, h.count);
    h.count -= x;
    return x;
  }

  function startDisease(h, dis) {
    const S = st(), sp = G.ANIMALS[h.species];
    if (dis.cull) {
      const val = herdValue(h), comp = Math.round(val * (dis.comp || 0));
      G.notify('☣️ ' + dis.name + ' w stadzie: ' + sp.plural + ' (' + h.count + ' szt.). Odszkodowanie: ' + G.fmtMoney(comp), 'bad', { key: 'cull_' + h.uid });
      if (comp > 0) G.finance.earn(comp, 'inne', 'Odszkodowanie za likwidację stada (' + dis.name.split(' — ')[0] + ')');
      S.stats.died += h.count;
      h.count = 0; if (h.cohorts) h.cohorts = []; h.young = [];
      removeHerdIfEmpty(h);
      return;
    }
    const sick = Math.max(1, Math.ceil(h.count * dis.frac));
    const cost = Math.round(dis.vet * sick);
    let treated = false;
    if (S.opts.autoVet && cost > 0) treated = G.finance.spend(cost, 'zwierzęta', 'Weterynarz: ' + dis.name + ' (' + sp.plural + ')');
    h.sick = { id: dis.id, name: dis.name, days: treated ? dis.days : dis.days * 4, prod: dis.prod, mort: (dis.mort || 0) * (treated ? 1 : 2.5), frac: dis.frac, treated };
    G.notify('🩺 ' + dis.name + ' — ' + sp.plural + (treated ? ': weterynarz leczy (' + G.fmtMoney(cost) + ')' : ': BEZ LECZENIA — straty większe'), treated ? 'warn' : 'bad', { key: 'sick_' + h.uid });
  }
  A.treat = function (uid) {
    const h = A.herd(uid);
    if (!h || !h.sick || h.sick.treated) return { ok: false, reason: 'Nie trzeba leczyć' };
    const sp = G.ANIMALS[h.species], dis = sp.diseases.find(x => x.id === h.sick.id);
    const cost = Math.round((dis ? dis.vet : 100) * Math.max(1, Math.ceil(h.count * h.sick.frac)));
    if (!G.finance.spend(cost, 'zwierzęta', 'Weterynarz: ' + h.sick.name)) return { ok: false, reason: 'Brak środków' };
    h.sick.treated = true; h.sick.days = Math.min(h.sick.days, dis ? dis.days : 3); h.sick.mort /= 2.5;
    return { ok: true, cost };
  };

  function addOut(id, q, h) {
    if (!(q > 0)) return 0;
    const added = G.inv.add(id, Math.round(q * 1000) / 1000);
    h.prod[id] = (h.prod[id] || 0) + added;
    st().stats.prod[id] = (st().stats.prod[id] || 0) + added;
    return added;
  }

  function dailyHerd(h, fr, d, care) {
    const S = st(), sp = G.ANIMALS[h.species], n = SC(), b = bget(h.buildingUid), def = b ? bdef(b) : {};
    h.prod = {}; h.ate = fr.ate; h.comps = fr.comps.map(c => ({ key: c.key, name: c.name, frac: c.frac }));
    h.fed = Math.round(fr.fed * 100) / 100; h.care = care;
    if (h.count <= 0 && !(h.young && h.young.length)) return;

    // ściółka
    const bk = beddingKg(h);
    let bedOk = 1;
    if (bk > 0) {
      const need = bk / kgPer('sloma'), have = G.inv.get('sloma'), q = Math.min(need, have);
      if (q > 0) G.inv.take('sloma', Math.floor(q * 1000) / 1000);
      bedOk = need > 0 ? q / need : 1;
    }
    h.bedding = Math.round(bedOk * 100) / 100;
    const sp2 = A.space(h.buildingUid), crowd = sp2 && sp2.occ > 1.001;

    // zdrowie
    let target = (0.35 + 0.65 * fr.fed) * (0.8 + 0.2 * care) * (h.sick ? 0.9 : 1) * (0.93 + 0.07 * bedOk) * (crowd ? 0.9 : 1) * (b && bdone(b) ? 1 : 0.6);
    if (h.species === 'pszczoly') target = h.sick ? 0.8 : 1;
    h.health = clamp(h.health + (clamp(target, 0.05, 1) - h.health) * 0.2, 0, 1);

    // choroby
    if (h.sick) {
      if (--h.sick.days <= 0) { h.sick = null; }
    } else {
      for (const dis of sp.diseases || []) {
        if (dis.summer && !(G.cm(d) >= 4 && G.cm(d) <= 8)) continue;
        let p = dis.p * (1.6 - h.health) * (care < 0.7 ? 1.5 : 1) * (crowd ? 2 : 1) * (dis.feedRisk && fr.fed < 0.8 ? 2 : 1) * (1 + Math.log10(Math.max(1, h.count)) / 3);
        if (Math.random() < p) { startDisease(h, dis); break; }
      }
      if (h.count <= 0 && !(h.young && h.young.length)) return;
    }

    // śmiertelność
    let rate = (sp.mort || 0) * n + (h.sick ? h.sick.mort * h.sick.frac * n : 0) + (h.health < 0.4 ? (0.4 - h.health) * 0.02 * n : 0);
    h.acc.dead += h.count * rate;
    const deaths = Math.floor(h.acc.dead);
    if (deaths > 0) {
      h.acc.dead -= deaths;
      const k = removeHeads(h, deaths);
      S.stats.died += k;
      const big = ['krowa', 'opas', 'locha', 'kon'].includes(h.species);
      if (k > 0 && (big || k >= Math.max(2, h.count * 0.03))) G.notify('💀 Padło: ' + k + ' × ' + sp.name + (h.health < 0.5 ? ' (złe żywienie/obsługa!)' : ''), 'bad', { key: 'dead_' + h.uid });
    }

    // mnożnik produkcji
    const pm = clamp(fr.fed, 0, 1) * (0.4 + 0.6 * h.health) * (0.55 + 0.45 * care) * (h.sick ? h.sick.prod : 1);
    h.pm = Math.round(pm * 100) / 100;
    const br = sp.breeds ? sp.breeds[h.breed || Object.keys(sp.breeds)[0]] : null;

    switch (h.species) {
      case 'krowa': {
        const milk = sp.products.mleko * (br ? br.prodMul : 1) * h.count * n * pm * (def.milkMul || 1);
        const want = Math.round(milk), added = addOut('mleko', want, h);
        if (added < want - 1) G.notify('🥛 Schładzalnik pełny — wylano ' + G.fmtNum(want - added, 0) + ' l mleka. Rozbuduj oborę.', 'bad', { key: 'milk_full' });
        // rozród: cielę co ~400 dni
        h.acc.birth += h.count * n / sp.repro.interval * (0.5 + 0.5 * pm);
        while (h.acc.birth >= 1) {
          h.acc.birth -= 1;
          const f = Math.random() < 0.5;
          let raise = false;
          if (f && S.opts.raiseHeifers) { const s = A.space(h.buildingUid); raise = s && s.free.krowa >= 1; }
          h.young.push({ n: 1, age: 0, f, raise });
          S.stats.born++;
          G.emit('animalBorn', 'krowa', 1, h);
        }
        let calfZl = 0, calves = 0;
        for (const y of h.young) {
          y.age++;
          if (!y.raise && y.age >= 3) {
            calfZl += y.n * sp.repro.calfSell[y.f ? 'f' : 'm'] * (br ? br.calfMul : 1) * (0.6 + 0.4 * h.health); calves += y.n; y.n = 0;
          } else if (y.raise && y.age >= sp.repro.heiferDays / n) {
            const s = A.space(h.buildingUid);
            if (s && s.occ + 0.5 * y.n / s.houses.krowa <= 1.0001) { h.count += y.n; G.notify('🐄 Jałówka weszła do stada krów (wycielenie)', 'good', { key: 'heifer' }); }
            else { calfZl += y.n * sp.repro.heiferValue; }
            y.n = 0;
          }
        }
        h.young = h.young.filter(y => y.n > 0);
        if (calfZl > 0) { G.finance.earn(Math.round(calfZl), 'sprzedaż', 'Sprzedaż cieląt: ' + calves + ' szt.'); S.stats.income += calfZl; }
        break;
      }
      case 'kura': {
        h.age++;
        const light = def.light ? 1 : ((G.cm(d) <= 1 || G.cm(d) >= 10) ? 0.75 : 1);
        addOut('jaja', Math.round(sp.products.jaja * layRate(h) * light * h.count * n * pm), h);
        if (A.henWeeks(h) > 80 && !h.oldWarned) { h.oldWarned = true; G.notify('🐔 Kury mają już ' + A.henWeeks(h) + ' tygodni — nioska spada. Sprzedaj stare i kup młode nioski.', 'info', { key: 'oldhens' }); }
        break;
      }
      case 'koza': {
        const lact = (G.cm(d) === 11 || G.cm(d) === 0) ? 0.2 : (G.cm(d) >= 2 && G.cm(d) <= 6 ? 1.15 : 0.9);
        addOut('mleko_kozie', Math.round(sp.products.mleko_kozie * h.count * n * pm * lact), h);
        break;
      }
      case 'pszczoly': {
        if (d.dom === C.DAYS_PER_MONTH && d.month >= 4 && d.month <= 6) {
          const share = [0.35, 0.35, 0.3][G.cm(d) - 4];
          const kg = addOut('miod', Math.round(sp.honey * share * h.count * pm), h);
          if (kg > 0) G.notify('🍯 Miodobranie: ' + G.fmtNum(kg, 0) + ' kg miodu', 'good', { key: 'honey' });
        }
        break;
      }
    }
    if (h.species === 'owca' && d.month === 4 && d.dom === 1) {
      const kg = addOut('welna', Math.round(sp.wool * h.count * (0.7 + 0.3 * pm)), h);
      if (kg > 0) G.notify('🧶 Strzyża owiec: ' + G.fmtNum(kg, 0) + ' kg wełny', 'good', { key: 'wool' });
    }
    // jagnięta / koźlęta
    if (sp.repro && sp.repro.month != null) {
      if (d.month === sp.repro.month && d.dom === 1 && h.count > 0) {
        const k = Math.round(h.count * sp.repro.perHead * (0.5 + 0.5 * pm));
        if (k > 0) { h.young.push({ n: k, age: 0 }); S.stats.born += k; G.emit('animalBorn', h.species, k, h); G.notify('🐑 Urodziło się ' + k + ' młodych (' + sp.plural + ')', 'good', { key: 'lambs_' + h.uid }); }
      }
      let sold = 0;
      for (const y of h.young) { y.age++; if (y.age >= sp.repro.sellAge / n) { sold += y.n; y.n = 0; } }
      h.young = h.young.filter(y => y.n > 0);
      if (sold > 0) sellLive('zywiec_jagniecy', sold * sp.repro.sellKg * (0.7 + 0.3 * h.health), 'Sprzedaż młodych: ' + sold + ' szt. (' + sp.plural + ')');
    }
    // lochy → prosięta do tuczu w tej samej chlewni lub na sprzedaż (warchlaki)
    if (h.species === 'locha') {
      h.acc.birth += h.count * sp.repro.perYear / 365 * n * pm;
      const k = Math.floor(h.acc.birth);
      if (k > 0) {
        h.acc.birth -= k;
        S.stats.born += k;
        G.emit('animalBorn', 'locha', k, h);
        const s = A.space(h.buildingUid), free = s ? (s.free.tucznik || 0) : 0, keep = Math.min(k, free);
        if (keep > 0) {
          const t = findHerd('tucznik', h.buildingUid, null) || newHerd('tucznik', h.buildingUid, null);
          // prosięta z ostatnich ~6 dni gry tworzą jedną partię (wspólna sprzedaż)
          const last = t.cohorts.find(c => c.batch && c.age < C.DAYS_PER_MONTH);
          if (last) { last.w = (last.w * last.n + sp.repro.pigletW * keep) / (last.n + keep); last.n += keep; }
          else t.cohorts.push({ n: keep, w: sp.repro.pigletW, age: 0, batch: true });
          recount(t);
        }
        if (k > keep) {
          const zl = Math.round((k - keep) * sp.repro.pigletW * G.ANIMALS.tucznik.pigletKgPrice);
          G.finance.earn(zl, 'sprzedaż', 'Sprzedaż warchlaków: ' + (k - keep) + ' szt.');
          S.stats.income += zl;
        }
      }
    }
    // tucz
    if (h.cohorts && sp.growth) {
      const g = sp.growth;
      for (const c of h.cohorts) { c.w = Math.round((c.w + g.gain * n * pm * (def.growMul || 1)) * 100) / 100; c.age++; }
      if (S.opts.autoSell) {
        const ready = h.cohorts.filter(c => c.w >= g.sell);
        if (ready.length) {
          let kg = 0, cnt = 0;
          for (const c of ready) { kg += c.n * c.w; cnt += c.n; c.n = 0; }
          h.cohorts = h.cohorts.filter(c => c.n > 0);
          recount(h);
          const zl = sellLive(sp.sellAs, kg, 'Sprzedaż: ' + cnt + ' × ' + sp.name + ' (' + G.fmtNum(kg / cnt, 0) + ' kg/szt.)');
          G.notify('💰 Sprzedano ' + cnt + ' × ' + sp.name + ' — ' + G.fmtMoney(zl), 'money', { key: 'fat_' + h.uid });
        }
      }
    }
    // konie — jazdy dla gości (rozliczenie miesięczne)
    if (h.species === 'kon' && G.cm(d) >= 4 && G.cm(d) <= 8) {
      const agro = G.buildings && G.buildings.list && G.buildings.list().some(x => x.type === 'house' && x.progress >= 1 && bdef(x).agro);
      S.pendingIncome += sp.rides * h.count * n * pm * (agro ? 1.6 : 1);
    }
    // pszczoły: dokarmianie jesienią, straty zimowe, rójka
    if (h.species === 'pszczoly') {
      if (d.month === 8 && d.dom === 1) S.pendingFeed += sp.sugarAutumn * h.count;
      if (d.month === 1 && d.dom === 1) { const k = Math.round(h.count * (0.1 + (1 - h.health) * 0.2)); if (k > 0) { removeHeads(h, k); G.notify('🐝 Zimowe straty: ' + k + ' rodzin pszczelich', 'info', { key: 'bees_winter' }); } }
      if (d.month === 4 && d.dom === 3) { const s = A.space(h.buildingUid), k = Math.min(s ? s.free.pszczoly : 0, Math.round(h.count * 0.1)); if (k > 0) { h.count += k; G.notify('🐝 Rójka — przybyło ' + k + ' rodzin', 'good', { key: 'bees_swarm' }); } }
    }

    // obornik / gnojowica
    const sys = def.manure || 'obornik', mk = (sp.manure && sp.manure[sys]) || 0;
    if (mk > 0) {
      const heads = headsEq(h), id = sys, q = mk * heads * n / 1000;
      const added = addOut(id, q, h);
      if (added < q - 0.01) G.notify('💩 Brak miejsca na ' + (id === 'obornik' ? 'obornik' : 'gnojowicę') + ' — wywieź na pole lub postaw płytę/zbiornik (kary z ustawy azotanowej!)', 'warn', { key: 'manure_full_' + id });
    }
    // koszty bieżące (weterynarz, inseminacja, woda, prąd) — rozliczane co miesiąc
    S.pendingCost += ((sp.vetDay || 0) + (sp.utilDay || 0) + (sp.water || 0) * 0.004) * headsEq(h) * n;
  }

  // ---------- pętla dzienna ----------
  G.on('daily', function (d) {
    const S = st();
    if (!S) return;
    const care = updateLabor();
    autoBuy();
    const pf = pastureFrac(G.cm(d));
    S.lastPasture = Math.round(pf * 100) / 100;
    let hungry = [];
    for (const h of ordered()) {
      const fr = feedHerd(h, realInv, pf);
      if (fr.fed < 0.75 && h.count > 0) hungry.push(G.ANIMALS[h.species].plural + ' ' + Math.round(fr.fed * 100) + '%');
      dailyHerd(h, fr, d, care);
    }
    for (const h of herdsArr().slice()) removeHerdIfEmpty(h);
    if (hungry.length && d.dayIndex - (S.lastHungry == null ? -99 : S.lastHungry) >= 3) {
      S.lastHungry = d.dayIndex;
      G.notify('🍽️ Słabe żywienie: ' + hungry.join(', ') + ' — brak lub zła pasza, spada produkcja i zdrowie.' + (S.opts.autoBuy ? '' : ' Możesz włączyć auto-zakup paszy treściwej.'), 'bad', { key: 'hungry' });
    }

    // odbiór mleka co 2 dni, jaj co 3 dni
    if (d.dayIndex % 2 === 0) {
      for (const id of ['mleko', 'mleko_kozie']) {
        const q = G.inv.get(id);
        if (q >= 1) A.sellProduct(id, Math.floor(q), id === 'mleko' ? 'Mleczarnia — odbiór ' + G.fmtNum(Math.floor(q), 0) + ' l mleka' : 'Mleko kozie — odbiór serowarni');
      }
    }
    if (S.opts.autoSellEggs && d.dayIndex % 3 === 0) {
      const q = Math.floor(G.inv.get('jaja'));
      if (q >= 10) A.sellProduct('jaja', q, 'Jaja — odbiór ' + q + ' szt.');
    }
    // mleko w magazynie po 2 dniach się psuje (bez odbioru) — zostaw najwyżej 2 dni produkcji
  });

  G.on('monthly', function () {
    const S = st();
    if (!S) return;
    if (S.pendingCost > 1) { G.finance.spend(Math.round(S.pendingCost), 'zwierzęta', 'Koszty bieżące hodowli: weterynarz, inseminacja, woda, prąd', true); S.stats.costs += S.pendingCost; }
    if (S.pendingFeed > 1) { G.finance.spend(Math.round(S.pendingFeed), 'pasze', 'Cukier i preparaty dla pszczół', true); S.stats.costs += S.pendingFeed; }
    if (S.pendingIncome > 1) { G.finance.earn(Math.round(S.pendingIncome), 'usługi', 'Jazdy konne dla gości'); S.stats.income += S.pendingIncome; }
    S.pendingCost = 0; S.pendingFeed = 0; S.pendingIncome = 0;
  });
  G.on('yearly', function () {
    const S = st();
    S.lastYear = S.stats;
    S.stats = freshStats();
  });

  // ---------- podsumowanie dla UI ----------
  A.summary = function () {
    const S = st(), out = [], totals = { prodDay: {}, valueDay: 0, feedCostDay: 0, heads: {}, count: 0 };
    for (const h of herdsArr()) {
      const sp = G.ANIMALS[h.species], b = bget(h.buildingUid);
      let val = 0, fc = 0;
      for (const id in h.prod) { val += h.prod[id] * price(id); totals.prodDay[id] = (totals.prodDay[id] || 0) + h.prod[id]; }
      for (const id in h.ate) fc += h.ate[id] * price(id);
      const warn = [];
      if (h.fed < 0.85) warn.push('Niedobór paszy (' + Math.round(h.fed * 100) + '%)');
      if (h.health < 0.6) warn.push('Słabe zdrowie');
      if (h.sick) warn.push(h.sick.name + (h.sick.treated ? ' (leczenie)' : ' — nieleczone!'));
      if (h.care < 0.8) warn.push('Za mało obsługi');
      if (h.bedding < 0.8) warn.push('Brak słomy na ściółkę');
      let avgW = null, ready = 0, daysToSell = null;
      if (h.cohorts && sp.growth && h.count) {
        avgW = h.cohorts.reduce((a, c) => a + c.n * c.w, 0) / h.count;
        ready = h.cohorts.filter(c => c.w >= sp.growth.sell).reduce((a, c) => a + c.n, 0);
        const maxW = Math.max(...h.cohorts.map(c => c.w));
        daysToSell = Math.max(0, Math.ceil((sp.growth.sell - maxW) / (sp.growth.gain * SC() * Math.max(0.2, h.pm || 1))));
      }
      const young = (h.young || []).reduce((a, y) => a + y.n, 0);
      const br = sp.breeds ? sp.breeds[h.breed || Object.keys(sp.breeds)[0]] : null;
      out.push({
        uid: h.uid, species: h.species, name: sp.name, plural: sp.plural, icon: sp.icon, model: sp.model, breed: h.breed || null, breedName: br ? br.name : null,
        buildingUid: h.buildingUid, buildingName: b ? bdef(b).name : '— brak budynku —', count: h.count, young,
        heifers: (h.young || []).filter(y => y.raise).reduce((a, y) => a + y.n, 0),
        health: Math.round(h.health * 100) / 100, fed: h.fed, care: h.care, bedding: h.bedding, sick: h.sick, comps: h.comps,
        productivity: h.pm == null ? null : h.pm, henWeeks: h.species === 'kura' ? A.henWeeks(h) : null,
        avgWeight: avgW == null ? null : Math.round(avgW), sellWeight: sp.growth ? sp.growth.sell : null, ready, daysToSell,
        cohorts: h.cohorts ? h.cohorts.map(c => ({ n: c.n, w: Math.round(c.w), age: c.age })) : null,
        prodDay: h.prod, ateDay: h.ate, valueDay: Math.round(val), feedCostDay: Math.round(fc), value: Math.round(herdValue(h)), warnings: warn,
        status: warn.length ? warn[0] : 'W porządku'
      });
      totals.valueDay += val; totals.feedCostDay += fc; totals.heads[h.species] = (totals.heads[h.species] || 0) + h.count; totals.count += h.count;
    }
    totals.valueDay = Math.round(totals.valueDay); totals.feedCostDay = Math.round(totals.feedCostDay);
    return { herds: out, totals, labor: S.labor, opts: S.opts, stats: S.stats, lastYear: S.lastYear || null, pasture: A.pasture(), scale: SC() };
  };
  A.catalog = function () {
    return Object.keys(G.ANIMALS).map(s => {
      const sp = G.ANIMALS[s];
      const places = buildingsFor(s).map(b => { const x = A.space(b.uid); return { buildingUid: b.uid, name: bdef(b).name, done: bdone(b), free: x ? (x.free[s] || 0) : 0 }; });
      return { species: s, name: sp.name, plural: sp.plural, icon: sp.icon, model: sp.model, price: sp.price, building: sp.building,
        buildingName: G.BUILDINGS[sp.building] ? G.BUILDINGS[sp.building].name : sp.building, desc: sp.desc, feed: sp.feed,
        breeds: sp.breeds ? Object.keys(sp.breeds).map(k => ({ id: k, name: sp.breeds[k].name, price: Math.round(sp.price * sp.breeds[k].priceMul) })) : null,
        places, free: places.reduce((a, p) => a + p.free, 0) };
    });
  };
  A.opts = () => st().opts;
  A.setOpt = function (k, v) { if (k in DEFAULT_OPTS) st().opts[k] = !!v; };

  // ---------- sprite'y dla grafiki ----------
  function hsh(a, b, c) {
    let x = Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263) + Math.imul(c | 0, 1274126177) | 0;
    x = Math.imul(x ^ (x >>> 13), 1274126177);
    x ^= x >>> 16;
    return (x >>> 0) / 4294967296;
  }
  function pastureTiles() {
    const day = G.S.tick / C.TICKS_PER_DAY | 0;
    if (pastCache.day === day) return pastCache.tiles;
    const Y = G.S.farm && G.S.farm.yard, cx = Y ? Y.x + Y.w / 2 : 0, cy = Y ? Y.y + Y.h / 2 : 0;
    const ps = meadowParcels().sort((a, b) => Math.hypot(a.cx - cx, a.cy - cy) - Math.hypot(b.cx - cx, b.cy - cy));
    let tiles = [];
    if (ps[0]) {
      const t = ps[0].tiles, step = Math.max(1, Math.floor(t.length / 40));
      for (let k = 0; k < t.length; k += step) tiles.push({ x: G.tx(t[k]), y: G.ty(t[k]) });
    }
    pastCache = { day, tiles };
    return tiles;
  }
  function target(area, seed, seg) {
    const t = area[Math.floor(hsh(seed, seg, 1) * area.length) % area.length];
    return { x: t.x + 0.2 + 0.6 * hsh(seed, seg, 2), y: t.y + 0.2 + 0.6 * hsh(seed, seg, 3) };
  }
  function walker(out, area, seed, t, base) {
    if (!area.length) return;
    const P = 2.2 + hsh(seed, 0, 9) * 1.6, ph = hsh(seed, 0, 8) * P, tt = (t + ph) / P, seg = Math.floor(tt), u = tt - seg;
    const A0 = target(area, seed, seg - 1), B0 = target(area, seed, seg), dx = B0.x - A0.x, dy = B0.y - A0.y;
    const ang = Math.atan2(dy, dx), wf = 0.3;
    let x = B0.x, y = B0.y, anim;
    if (u < wf) { const s = u / wf, e = s * s * (3 - 2 * s); x = A0.x + dx * e; y = A0.y + dy * e; anim = 'walk'; }
    else anim = hsh(seed, seg, 7) < 0.55 ? 'eat' : 'idle';
    out.push(Object.assign({ x, y, angle: ang, dir: ((Math.round(ang / (Math.PI / 4)) % 8) + 8) % 8, anim }, base));
  }
  // → [{ x, y (kafel, ułamkowy), species, model, dir (0..7: oktant kąta w układzie kafli, 0 = +x), angle (rad), anim ('walk'|'eat'|'idle'|'fly'), color?, scale?, herd }]
  A.sprites = function () {
    if (!G.S || !G.S.animals) return [];
    const out = [], hf = G.hourFrac || 0, t = G.S.tick + hf, d = G.date(), hour = d.hour + hf, m = G.cm(d);
    const day = hour >= 6 && hour < 20, warm = m >= 3 && m <= 9, winter = m === 11 || m <= 1;
    const graze = st().opts.grazing && pastureSeason(m) > 0;
    const past = graze ? pastureTiles() : [];
    for (const h of herdsArr()) {
      const sp = G.ANIMALS[h.species], b = bget(h.buildingUid);
      if (!b || !bdone(b) || h.count <= 0 && !(h.young || []).length) continue;
      const pen = G.buildings && G.buildings.penTiles ? G.buildings.penTiles(b.uid) : [{ x: b.x, y: b.y }];
      const lvl = b.level || 1;
      let n = 0, area = pen, model = sp.model;
      switch (h.species) {
        case 'kura': if (day && hour >= 7 && hour < 19 && (warm || (hour >= 10 && hour < 15))) n = Math.min(h.count, lvl >= 3 ? 6 : 9); break;
        case 'krowa':
          if (day) { if (graze && past.length && hour >= 7 && hour < 19) { area = past; n = Math.min(h.count, 12); } else n = Math.min(h.count, winter ? 3 : 8); }
          break;
        case 'opas': if (day && warm) n = Math.min(h.count, 5); break;
        case 'tucznik': case 'locha': if (day && warm && lvl === 1) n = Math.min(h.count, 3); break;
        case 'owca': case 'koza':
          if (day && m >= 2 && m <= 10) { if (graze && past.length) area = past; n = Math.min(h.count, h.species === 'owca' ? 12 : 8); }
          break;
        case 'kon': if (day) { if (graze && past.length && hour >= 8 && hour < 18) area = past; n = Math.min(h.count, 6); } break;
        case 'pszczoly':
          if (day && warm && hour >= 8 && hour < 19) {
            const f = G.buildings && G.buildings.footprint ? G.buildings.footprint(b) : { x: b.x, y: b.y, w: 1, h: 1 };
            const k = Math.min(4, Math.ceil(h.count / 10));
            for (let i = 0; i < k; i++) {
              const a = t * (2.5 + i) + i * 1.7, r = 0.6 + 0.4 * Math.sin(t * 1.3 + i);
              out.push({ x: f.x + f.w / 2 + Math.cos(a) * r, y: f.y + f.h / 2 + Math.sin(a) * r, angle: a + Math.PI / 2, dir: 0, anim: 'fly', species: 'pszczoly', model: 'bee', herd: h.uid });
            }
          }
          continue;
      }
      if (!model) continue;
      const base = { species: h.species, model, herd: h.uid };
      if (sp.color) base.color = sp.color;
      for (let k = 0; k < n; k++) walker(out, area, h.uid * 131 + k * 17, t, base);
      // młode: cielęta przy oborze, jagnięta/koźlęta przy matkach
      const young = (h.young || []).reduce((a, y) => a + y.n, 0);
      if (young > 0 && day && (warm || h.species === 'krowa')) {
        const yn = Math.min(young, h.species === 'krowa' ? 3 : 5);
        const yb = h.species === 'krowa' ? { species: 'krowa', model: 'calf', herd: h.uid, young: true } : { species: h.species, model, scale: 0.6, herd: h.uid, young: true };
        for (let k = 0; k < yn; k++) walker(out, h.species === 'krowa' ? pen : area, h.uid * 977 + k * 31, t, yb);
      }
    }
    return out;
  };

  // ---------- nowa gra / wczytanie ----------
  function freshStats() { return { prod: {}, income: 0, costs: 0, born: 0, died: 0 }; }
  function fresh() {
    return { herds: [], opts: Object.assign({}, DEFAULT_OPTS), labor: { need: 0, got: 0, factor: 1 }, pendingCost: 0, pendingIncome: 0, pendingFeed: 0,
      stats: freshStats(), lastYear: null, startPending: false };
  }
  G.on('newGame', function () {
    G.S.animals = fresh();
    G.S.animals.startPending = true;            // kury dziadka — gdy moduł budynków postawi kurnik (hook 'load')
    G.inv.add('pasza_tresciwa', 1);             // worki mieszanki dla kur na start (+ domyślnie auto-zakup paszy)
    G.inv.add('sloma', 3);                      // trochę słomy na ściółkę w kurniku
  });
  G.on('load', function () {
    const S = G.S;
    if (!S.animals || typeof S.animals !== 'object') S.animals = fresh();
    const a = S.animals, f = fresh();
    for (const k in f) if (a[k] == null) a[k] = f[k];
    a.opts = Object.assign({}, DEFAULT_OPTS, a.opts || {});
    if (!Array.isArray(a.herds)) a.herds = [];
    a.herds = a.herds.filter(h => h && G.ANIMALS[h.species]);
    for (const h of a.herds) {
      const sp = G.ANIMALS[h.species];
      if (!h.uid) h.uid = G.uid();
      h.health = clamp(+h.health || 0, 0, 1); if (h.health === 0 && h.count > 0) h.health = 0.5;
      h.fed = h.fed == null ? 1 : +h.fed; h.care = h.care == null ? 1 : +h.care;
      h.age = +h.age || 0; h.young = Array.isArray(h.young) ? h.young : [];
      h.acc = h.acc || { birth: 0, dead: 0 }; h.prod = h.prod || {}; h.ate = h.ate || {}; h.comps = h.comps || []; if (h.bedding == null) h.bedding = 1;
      if (sp.growth) { h.cohorts = Array.isArray(h.cohorts) ? h.cohorts.filter(c => c && c.n > 0) : []; recount(h); } else h.count = Math.max(0, h.count | 0);
    }
    for (const k of ['stats']) { a[k] = Object.assign(freshStats(), a[k] || {}); a[k].prod = a[k].prod || {}; }
    if (a.startPending) {
      a.startPending = false;
      const hh = (S.buildings || []).find(b => b.type === 'henhouse' && b.progress >= 1);
      if (hh && !a.herds.some(h => h.species === 'kura')) {
        const h = newHerd('kura', hh.uid, null);
        h.count = 12; h.age = Math.round(20 * 7 / SC());   // ok. 40-tygodniowe nioski dziadka
      }
    }
    pastCache = { day: -1 };
  });
})();
