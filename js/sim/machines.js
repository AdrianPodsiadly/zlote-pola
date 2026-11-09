// Złote Pola — park maszynowy: zakup, wynajem, zużycie, serwis → G.machines (agent: maszyny, ludzie, prace)
//
// Stan: G.S.machines = [{ uid, id, rented, until (tick końca wynajmu), wear 0..1, hours (motogodziny), busy: jobUid|null,
//                         year (rocznik), broken (awaria), repairUntil (tick końca naprawy | 0), stored (pod dachem),
//                         fill: { produkt: t } (ładunek przyczepy — pełna przyczepa na podwórzu to magazyn tymczasowy),
//                         FLOTA (trwałe pozycje): x, y (kafel ułamkowy), angle (rad, 0 = +x), attachedTo (uid ciągnika/kombajnu | null),
//                         hitch: [uid...] (ciągnik: narzędzie ALBO do 2 przyczep; kombajn: heder), lowered (narzędzie opuszczone),
//                         driver (uid pracownika | null), order (bieżący rozkaz | null), parked: 'garage'|'yard'|'field',
//                         fuel (l w zbiorniku) }]
// Odczepione narzędzia i przyczepy STOJĄ tam, gdzie je zostawiono (vehicles() zwraca je jako kind: 'implement').
//       G.S.machineMarket = { offers: [{ oid, id, year, wear, hours, price }], next: tick odświeżenia }
// Paliwo: produkt 'ON' (G.PRODUCTS — data/machines.js). Maszyny tankują z magazynu (G.inv.take('ON')),
//         a gdy brak — tankują na stacji drożej (G.finance.spend(..., 'paliwo')).
(function () {
  const C = G.CFG;
  const M = G.machines = {};
  const TPD = C.TICKS_PER_DAY;

  const LIFE_DEF = { tractor: 12000, combine: 6000, trailer: 6000, loader: 10000 };
  const FLOOR = { tractor: 0.3, combine: 0.2, loader: 0.25 };   // minimalna wartość rezydualna (ułamek ceny nowej)
  const STATION_MARKUP = 1.25;                                     // stacja paliw vs. dostawa hurtowa do gospodarstwa

  const def = M.def = function (x) {
    if (x == null) return null;
    if (typeof x === 'string') return G.MACHINES[x] || null;
    const m = typeof x === 'number' ? M.get(x) : x;
    return m ? G.MACHINES[m.id] || null : null;
  };
  M.get = uid => (G.S.machines || []).find(m => m.uid === uid) || null;
  M.list = () => G.S.machines || [];
  M.owned = () => M.list().filter(m => !m.rented);
  // katalog salonu (bez pozycji tylko z rynku wtórnego)
  M.catalog = function (cat) {
    return Object.values(G.MACHINES).filter(d => !d.usedOnly && (!cat || d.cat === cat));
  };
  M.isPower = d => !!d && (d.cat === 'tractor' || !!d.self);
  M.label = function (uid) {
    const m = M.get(uid), d = def(m);
    return d ? d.name + (m.rented ? ' (wynajem)' : '') : '?';
  };
  function year() { return G.date().year; }
  function ageYears(m) { return Math.max(0, year() + G.date().doy / G.DAYS_PER_YEAR - (m.year || year())); }
  M.life = d => d.life || LIFE_DEF[d.cat] || 3000;

  // ---------- wartość i sprzedaż ----------
  M.value = function (uidOrM) {
    const m = typeof uidOrM === 'object' ? uidOrM : M.get(uidOrM), d = def(m);
    if (!m || !d) return 0;
    const a = ageYears(m);
    let dep = a < 1 ? 1 - 0.18 * a : 0.82 * Math.pow(0.93, a - 1);
    dep = Math.max(FLOOR[d.cat] || 0.12, dep);
    return Math.round(d.price * dep * (1 - 0.45 * m.wear) / 100) * 100;
  };
  M.sellQuote = function (uid) {
    const m = M.get(uid);
    if (!m || m.rented) return 0;
    return Math.round(M.value(m) * 0.9 / 100) * 100;
  };
  M.sell = function (uid) {
    const m = M.get(uid), d = def(m);
    if (!m) return { ok: false, reason: 'Nie ma takiej maszyny' };
    if (m.rented) return { ok: false, reason: 'Maszyna jest wynajęta — można ją tylko oddać' };
    if (m.busy) return { ok: false, reason: 'Maszyna pracuje w zleceniu' };
    if (M.fillOf(m) > 1e-6) return { ok: false, reason: 'Na przyczepie leży plon (magazyn tymczasowy) — najpierw sprzedaj albo zmagazynuj' };
    const price = M.sellQuote(uid);
    M.dropAll(m);
    G.S.machines = G.S.machines.filter(x => x !== m);
    G.finance.earn(price, 'sprzedaż', 'Sprzedaż: ' + d.name);
    G.notify('💰 Sprzedano ' + d.name + ' za ' + G.fmtMoney(price), 'money');
    return { ok: true, price };
  };

  // ---------- zakup ----------
  function add(id, o) {
    const d = G.MACHINES[id];
    const m = Object.assign({ uid: G.uid(), id, rented: false, until: 0, wear: 0, hours: 0, busy: null, year: year(), broken: false, repairUntil: 0, stored: true,
      fill: null, x: null, y: null, angle: Math.PI / 2, attachedTo: null, hitch: [], lowered: false, driver: null, order: null, parked: 'yard', fuel: 0 }, o || {});
    delete m.noHeader;
    G.S.machines.push(m);
    m.fuel = M.tankOf(d);
    M.park(m.uid);
    if (d.header && !o?.noHeader) {
      // kombajn z hederem w zestawie (ta sama forma: zakup/wynajem/używany) — heder od razu podpięty
      const h = add(d.header, { rented: m.rented, until: m.until, wear: m.wear * 0.8, hours: Math.round(m.hours * 0.8), year: m.year, bundled: m.uid, noHeader: true });
      M.attach(m.uid, h.uid, { force: true });
    }
    return m;
  }
  M.add = add;
  M.buy = function (id) {
    const d = G.MACHINES[id];
    if (!d) return { ok: false, reason: 'Nieznana maszyna' };
    if (d.usedOnly) return { ok: false, reason: 'Dostępna tylko na rynku wtórnym' };
    if (!G.finance.spend(d.price, 'zakup maszyn', 'Zakup: ' + d.name)) return { ok: false, reason: 'Brak środków' };
    const m = add(id);
    G.notify('🚜 Kupiono: ' + d.name + (d.header ? ' (z hederem)' : ''), 'good');
    G.emit('bought', 'machine', m);
    restow();
    return { ok: true, machine: m };
  };

  // ---------- rynek wtórny ----------
  M.usedOffers = () => (G.S.machineMarket && G.S.machineMarket.offers) || [];
  function refreshUsed() {
    const r = G.rng((G.S.seed | 0) * 7 + G.S.tick);
    const ids = Object.keys(G.MACHINES).filter(id => G.MACHINES[id].cat !== 'header');
    const offers = [];
    const n = 6 + ((r() * 4) | 0);
    for (let k = 0; k < n; k++) {
      const id = ids[(r() * ids.length) | 0], d = G.MACHINES[id];
      const age = d.usedOnly ? 25 + ((r() * 15) | 0) : 2 + ((r() * 14) | 0);
      const wear = Math.min(0.8, 0.12 + r() * 0.35 + age * 0.015);
      const m = { id, year: year() - age, wear: Math.round(wear * 100) / 100, hours: Math.round(wear * M.life(d) * (0.7 + r() * 0.3)) };
      let price = M.value(m) * (1.02 + r() * 0.12);
      if (d.header) price += G.MACHINES[d.header].price * 0.35;
      offers.push(Object.assign(m, { oid: G.uid(), price: Math.round(price / 500) * 500 }));
    }
    G.S.machineMarket = { offers, next: G.S.tick + 3 * TPD };
  }
  M.buyUsed = function (oid) {
    const mk = G.S.machineMarket, o = mk && mk.offers.find(x => x.oid === oid);
    if (!o) return { ok: false, reason: 'Oferta nieaktualna' };
    const d = G.MACHINES[o.id];
    if (!G.finance.spend(o.price, 'zakup maszyn', 'Zakup używanej: ' + d.name + ' (' + o.year + ')')) return { ok: false, reason: 'Brak środków' };
    mk.offers = mk.offers.filter(x => x !== o);
    const m = add(o.id, { wear: o.wear, hours: o.hours, year: o.year });
    G.notify('🚜 Kupiono używaną: ' + d.name + ' (rocznik ' + o.year + ')', 'good');
    G.emit('bought', 'machine', m);
    restow();
    return { ok: true, machine: m };
  };

  // ---------- wynajem ----------
  M.rentQuote = function (id, days) {
    const d = G.MACHINES[id];
    if (!d || !d.rentPerDay) return null;
    days = Math.max(1, Math.round(days || 1));
    const disc = days >= 18 ? 0.7 : days >= 6 ? 0.85 : 1;
    return { perDay: Math.round(d.rentPerDay * disc), total: Math.round(d.rentPerDay * disc * days), days, discount: 1 - disc };
  };
  M.rent = function (id, days) {
    const d = G.MACHINES[id], q = M.rentQuote(id, days);
    if (!d || !q) return { ok: false, reason: 'Tej maszyny nie da się wynająć' };
    if (!G.finance.spend(q.total, 'wynajem', 'Wynajem: ' + d.name + ' na ' + q.days + ' dn.')) return { ok: false, reason: 'Brak środków' };
    const m = add(id, { rented: true, until: G.S.tick + q.days * TPD, wear: 0.2, hours: 1500, year: year() - 3 });
    G.notify('🔑 Wynajęto ' + d.name + ' do ' + G.dateText(m.until), 'good');
    return { ok: true, machine: m, price: q.total };
  };
  // przedłużenie wynajmu o dni
  M.extendRent = function (uid, days) {
    const m = M.get(uid), d = def(m);
    if (!m || !m.rented) return { ok: false, reason: 'To nie jest maszyna wynajęta' };
    const q = M.rentQuote(m.id, days);
    if (!q) return { ok: false, reason: 'Brak oferty' };
    if (!G.finance.spend(q.total, 'wynajem', 'Przedłużenie wynajmu: ' + d.name)) return { ok: false, reason: 'Brak środków' };
    m.until += q.days * TPD;
    for (const x of G.S.machines) if (x.bundled === m.uid) x.until = m.until;
    return { ok: true, price: q.total };
  };
  // zwrot przed terminem (bez zwrotu pieniędzy)
  M.returnRented = function (uid) {
    const m = M.get(uid);
    if (!m || !m.rented) return { ok: false, reason: 'To nie jest maszyna wynajęta' };
    if (m.busy || G.S.machines.some(x => x.bundled === m.uid && x.busy)) return { ok: false, reason: 'Maszyna pracuje w zleceniu' };
    M.dropAll(m);
    G.S.machines = G.S.machines.filter(x => x !== m && x.bundled !== m.uid);
    G.notify('🔑 Zwrócono ' + def(m).name, 'info');
    return { ok: true };
  };

  // ---------- serwis i naprawy ----------
  M.repairQuote = function (uid) {
    const m = M.get(uid), d = def(m);
    if (!m || !d) return null;
    const floor = Math.min(0.4, ageYears(m) * 0.012);
    const wearAfter = Math.max(floor, Math.min(m.wear, Math.max(0.05, m.wear - 0.3)));
    const dw = Math.max(0, m.wear - wearAfter);
    const ws = !!(G.buildings && G.buildings.has && G.buildings.has('workshop'));
    let cost = d.price * (0.004 + 0.06 * dw) + (m.broken ? d.price * 0.01 + 500 : 0);
    if (m.rented) cost = m.broken ? 0 : 0;                    // naprawy wynajętych pokrywa wypożyczalnia
    if (ws) cost *= 0.65;
    const mech = G.workers && G.workers.bestSkill ? G.workers.bestSkill('mech') : 2;
    if (ws && mech >= 3) cost *= 1 - 0.05 * (mech - 2);       // własny mechanik w warsztacie
    const hours = m.rented ? 6 : ws ? 4 : 24;
    return { cost: Math.round(cost / 10) * 10, wearAfter: Math.round(wearAfter * 100) / 100, hours, workshop: ws, needed: m.broken || m.wear > 0.35 };
  };
  M.repair = function (uid) {
    const m = M.get(uid), d = def(m), q = M.repairQuote(uid);
    if (!m || !q) return { ok: false, reason: 'Nie ma takiej maszyny' };
    if (m.repairUntil > G.S.tick) return { ok: false, reason: 'Już w naprawie' };
    if (m.busy && !m.broken) return { ok: false, reason: 'Maszyna pracuje w zleceniu' };
    if (!m.broken && m.wear - q.wearAfter < 0.01) return { ok: false, reason: 'Maszyna jest w dobrym stanie' };
    if (!G.finance.spend(q.cost, 'serwis', (m.broken ? 'Naprawa: ' : 'Przegląd: ') + d.name)) return { ok: false, reason: 'Brak środków' };
    m.repairUntil = G.S.tick + q.hours;
    m._wearAfter = q.wearAfter;
    G.notify('🔧 ' + d.name + ' w ' + (q.workshop ? 'warsztacie' : 'serwisie') + ' — gotowa za ' + q.hours + ' h', 'info');
    return { ok: true, cost: q.cost, hours: q.hours };
  };
  // gotowość maszyny do pracy
  M.ready = function (uid) {
    const m = M.get(uid);
    if (!m) return { ok: false, reason: 'Brak maszyny' };
    if (m.repairUntil > G.S.tick) return { ok: false, reason: 'W naprawie do ' + String(G.date(m.repairUntil).hour).padStart(2, '0') + ':00' };
    if (m.broken) return { ok: false, reason: 'Awaria — wymaga naprawy' };
    return { ok: true };
  };
  M.status = function (uid) {
    const m = M.get(uid);
    if (!m) return '';
    if (m.repairUntil > G.S.tick) return 'w naprawie';
    if (m.broken) return 'awaria';
    if (m.busy) return 'w pracy';
    if (m.order) return 'wykonuje rozkaz';
    if (G.drive && G.drive.active && G.drive.active() === uid) return 'prowadzisz';
    if (m.attachedTo) { const t = M.get(m.attachedTo); return 'doczepiona do: ' + (t ? def(t).name : '?'); }
    return m.parked === 'garage' ? 'w garażu' : m.parked === 'field' ? 'stoi na polu' : 'na podwórzu';
  };

  // ---------- eksploatacja (wołane przez prace) ----------
  // dtH godzin pracy; factor — mnożnik zużycia (umiejętność mechaniczna, obciążenie). Zwraca true przy awarii.
  M.use = function (uid, dtH, factor) {
    const m = M.get(uid), d = def(m);
    if (!m || !d || dtH <= 0) return false;
    m.hours = Math.round((m.hours + dtH) * 1000) / 1000;
    const f = (factor || 1) * (m.stored ? 1 : 1.25);
    m.wear = Math.min(1, m.wear + dtH / M.life(d) * f);
    // awarie losowe przy dużym zużyciu
    const p = (0.0004 + Math.pow(Math.max(0, m.wear - 0.45), 2) * 0.06) * (factor || 1) * dtH;
    if (!m.rented && Math.random() < p) {
      m.broken = true;
      G.notify('🛠️ Awaria: ' + d.name + ' (zużycie ' + Math.round(m.wear * 100) + '%) — zleć naprawę', 'bad', { key: 'broken_' + m.uid });
      return true;
    }
    return false;
  };

  // ---------- paliwo ----------
  M.fuelPrice = function () {
    const p = G.market && G.market.buyPrice ? G.market.buyPrice('ON') : null;
    return p > 0 ? p : G.PRODUCTS.ON.base;
  };
  M.stationPrice = () => Math.round(M.fuelPrice() * STATION_MARKUP * 100) / 100;
  // zakup ON do magazynu (dostawa hurtowa)
  M.buyFuel = function (liters) {
    liters = Math.min(liters, G.inv.free('ON'));
    if (!(liters > 0)) return { ok: false, reason: 'Brak miejsca na paliwo' };
    if (G.market && G.market.buy) { const ok = G.market.buy('ON', liters); return { ok: !!ok, liters: ok ? liters : 0 }; }
    const cost = liters * M.fuelPrice();
    if (!G.finance.spend(cost, 'paliwo', 'Dostawa ON ' + Math.round(liters) + ' l')) return { ok: false, reason: 'Brak środków' };
    G.inv.add('ON', liters);
    return { ok: true, liters, cost };
  };
  // tankowanie: najpierw z magazynu, reszta na stacji. Zwraca { ok, fromStock, bought, cost }
  M.refuel = function (liters, note) {
    if (!(liters > 0)) return { ok: true, fromStock: 0, bought: 0, cost: 0 };
    const have = G.inv.get('ON');
    const fromStock = Math.min(have, liters);
    if (fromStock > 0) G.inv.take('ON', fromStock);
    const rest = Math.round((liters - fromStock) * 100) / 100;
    let cost = 0;
    if (rest > 0) {
      cost = rest * M.stationPrice();
      if (!G.finance.spend(cost, 'paliwo', 'Stacja paliw ' + Math.round(rest) + ' l' + (note ? ' — ' + note : ''))) {
        return { ok: false, fromStock, bought: 0, cost: 0, missing: rest };
      }
      G.notify('⛽ Brak ON w magazynie — tankowanie na stacji (' + G.fmtNum(M.stationPrice(), 2) + ' zł/l)', 'warn', { key: 'fuel_station' });
    }
    return { ok: true, fromStock, bought: rest, cost };
  };

  // ---------- magazyn tymczasowy: pełne przyczepy na podwórzu ----------
  // Przyczepa, która wróciła z pola, a w magazynie nie było miejsca, zostaje pełna na podwórzu. Plon JEST w G.inv (można go sprzedać),
  // a przyczepa dokłada pojemność puli — moduł budynków pyta G.machines.yardStorage(pula) → tony. Co godzinę ładunek przyczep jest
  // „przelewany” do budynków, jeśli zwolniło się tam miejsce (sprzedaż, nowy silos) — przyczepa opróżnia się sama i wraca do floty.
  M.fillOf = function (m) { let t = 0; if (m && m.fill) for (const k in m.fill) t += +m.fill[k] || 0; return t; };
  const poolOf = id => (G.buildings && G.buildings.poolOf) ? G.buildings.poolOf(id) : (G.PRODUCTS[id] && G.PRODUCTS[id].cat === 'zboże' ? 'zboże' : null);
  M.yardStorage = function (pool) {
    let t = 0;
    for (const m of M.list()) if (m.fill) for (const id in m.fill) if (m.fill[id] > 0 && poolOf(id) === pool) t += m.fill[id];
    return Math.round(t * 1000) / 1000;
  };
  // przyczepy z ładunkiem (dla UI): [{ uid, name, fill: {id: t}, tons }]
  M.yardTrailers = () => M.list().filter(m => M.fillOf(m) > 1e-6).map(m => ({ uid: m.uid, name: def(m).name, fill: Object.assign({}, m.fill), tons: Math.round(M.fillOf(m) * 1000) / 1000 }));
  function syncYardStorage() {
    if (!(G.buildings && G.buildings.storage)) return;
    const loaded = M.list().filter(m => M.fillOf(m) > 1e-6 && !m.busy);
    if (!loaded.length) return;
    let pools;
    try { pools = G.buildings.storage(); } catch (e) { return; }
    for (const P of pools) {
      const trs = loaded.filter(m => m.fill && Object.keys(m.fill).some(id => m.fill[id] > 0 && poolOf(id) === P.key));
      if (!trs.length) continue;
      // ile MUSI zostać na przyczepach: zapas ponad pojemność budynków (cap bez części tymczasowej)
      const buildingsCap = Math.max(0, P.cap - (P.temp || 0));
      let mustKeep = Math.max(0, P.used - buildingsCap);
      let have = 0; for (const m of trs) for (const id in m.fill) if (poolOf(id) === P.key) have += m.fill[id];
      let drop = have - mustKeep;
      if (drop <= 1e-6) continue;
      // opróżniamy od najmniej załadowanej
      trs.sort((a, b) => M.fillOf(a) - M.fillOf(b));
      for (const m of trs) {
        for (const id of Object.keys(m.fill)) {
          if (drop <= 1e-6) break;
          if (poolOf(id) !== P.key) continue;
          const q = Math.min(m.fill[id], drop);
          m.fill[id] = Math.round((m.fill[id] - q) * 1000) / 1000; drop -= q;
          if (m.fill[id] <= 1e-6) delete m.fill[id];
        }
        if (M.fillOf(m) <= 1e-6) { m.fill = null; G.notify('🚜 ' + def(m).name + ' rozładowana — plon trafił do magazynu, przyczepa wolna', 'good', { key: 'yardfree_' + m.uid }); }
      }
    }
  }
  M.syncYardStorage = syncYardStorage;

  // ===================== FLOTA: pozycje, zaczepy, parkowanie =====================
  const HITCH_RANGE = 1.7;        // z jakiej odległości (kafle) da się podczepić narzędzie
  M.HITCH_RANGE = HITCH_RANGE;
  M.HITCH_H = 0.08;               // postój na podczepienie (h gry)
  M.tankOf = d => d && d.fuelLph ? (d.tank || Math.round(((d.hp || 80) * (d.self ? 2.6 : 2.2)) / 10) * 10) : 0;
  M.isImplement = d => !!d && !M.isPower(d);
  const posOf = m => ({ x: m.x, y: m.y, angle: m.angle });
  M.pos = uid => { const m = M.get(uid); return m ? posOf(m) : null; };
  M.tileOf = m => G.idx(Math.max(0, Math.min(C.W - 1, Math.floor(m.x))), Math.max(0, Math.min(C.H - 1, Math.floor(m.y))));
  // kolejność zaczepu: [narzędzie] albo [przyczepa1, przyczepa2]
  M.hitched = uid => { const m = M.get(uid); return m && Array.isArray(m.hitch) ? m.hitch.map(u => M.get(u)).filter(Boolean) : []; };
  M.chain = uid => { const m = M.get(uid); return m ? [m].concat(M.hitched(uid)) : []; };
  M.rootOf = m => (m && m.attachedTo && M.get(m.attachedTo)) || m;
  M.isManual = uid => !!(G.drive && G.drive.active && G.drive.active() === uid);

  // czy ciągnik t może podczepić maszynę i (bez sprawdzania odległości); force — wołane przez prace (pomija zajętość)
  M.canAttach = function (tUid, iUid, opts) {
    opts = opts || {};
    const t = M.get(tUid), i = M.get(iUid), td = def(t), id = def(i);
    if (!t || !i || !td || !id) return { ok: false, reason: 'Brak maszyny' };
    if (!M.isPower(td)) return { ok: false, reason: td.name + ' nie ma zaczepu' };
    if (M.isPower(id)) return { ok: false, reason: id.name + ' jeździ sama' };
    if (i.attachedTo === t.uid) return { ok: false, reason: 'Już doczepiona' };
    if (i.attachedTo) { const o = M.get(i.attachedTo); if (o && (o.busy || M.isManual(o.uid)) && !opts.force) return { ok: false, reason: id.name + ' jest doczepiona do pracującego ciągnika' }; }
    if (!opts.force && (i.busy || t.busy)) return { ok: false, reason: 'Maszyna pracuje w zleceniu' };
    if (id.cat === 'header') {
      if (td.cat !== 'combine' || td.needs !== 'header') return { ok: false, reason: 'Heder pasuje tylko do kombajnu' };
      if (t.hitch.length) return { ok: false, reason: 'Kombajn ma już heder' };
      if ((id.reqHp || 0) > td.hp) return { ok: false, reason: 'Heder za ciężki dla tego kombajnu' };
      return { ok: true };
    }
    if (td.cat !== 'tractor') return { ok: false, reason: td.name + ' nie ciągnie narzędzi' };
    const cur = M.hitched(t.uid);
    if (id.cat === 'trailer') {
      if (cur.some(m => def(m).cat !== 'trailer')) return { ok: false, reason: 'Najpierw odczep narzędzie' };
      if (cur.length >= 2) return { ok: false, reason: 'Ciągnik może ciągnąć najwyżej 2 przyczepy' };
      if (cur.length === 1) {
        const po = G.trailerPairOk(def(cur[0]), id);
        if (!po.ok) return po;
        if (po.reqHp > td.hp) return { ok: false, reason: 'Za mała moc do dwóch przyczep: ' + td.hp + ' KM, potrzeba ' + po.reqHp + ' KM' };
        return { ok: true };
      }
      if ((id.reqHp || 0) > td.hp) return { ok: false, reason: 'Za mała moc: ' + td.hp + ' KM, ' + id.name + ' wymaga ' + id.reqHp + ' KM' };
      return { ok: true };
    }
    if (cur.length) return { ok: false, reason: 'Ciągnik ma już coś na zaczepie — najpierw odczep' };
    if ((id.reqHp || 0) > td.hp) return { ok: false, reason: 'Za mała moc: ' + td.hp + ' KM, ' + id.name + ' wymaga ' + id.reqHp + ' KM' };
    return { ok: true };
  };
  M.inHitchRange = (t, i) => Math.hypot(t.x - i.x, t.y - i.y) <= HITCH_RANGE;
  // podczepienie (pozycja narzędzia = pozycja ciągnika; grafika rozkłada parts wzdłuż osi)
  M.attach = function (tUid, iUid, opts) {
    const c = M.canAttach(tUid, iUid, opts);
    if (!c.ok) return c;
    const t = M.get(tUid), i = M.get(iUid);
    if (!(opts && opts.force) && !M.inHitchRange(t, i)) return { ok: false, reason: 'Za daleko — podjedź do ' + def(i).name };
    if (i.attachedTo) M.detach(i.attachedTo, i.uid, { force: true, silent: true });
    i.attachedTo = t.uid; t.hitch.push(i.uid);
    i.x = t.x; i.y = t.y; i.angle = t.angle; i.parked = t.parked; i.lowered = false; i.order = null;
    return { ok: true };
  };
  // odczepienie ostatniej (albo wskazanej, jeśli jest ostatnia) maszyny z zaczepu — zostaje za ciągnikiem
  M.detach = function (tUid, iUid, opts) {
    opts = opts || {};
    const t = M.get(tUid);
    if (!t || !t.hitch.length) return { ok: false, reason: 'Nic nie jest doczepione' };
    const last = t.hitch[t.hitch.length - 1];
    if (iUid != null && iUid !== last) return { ok: false, reason: 'Najpierw odczep ostatnią przyczepę' };
    const i = M.get(last);
    if (!opts.force && (t.busy || (i && i.busy))) return { ok: false, reason: 'Maszyna pracuje w zleceniu' };
    if (i && def(i).cat === 'header' && !opts.force) return { ok: false, reason: 'Heder zostaje na kombajnie' };
    t.hitch.pop();
    if (!i) return { ok: true };
    const k = t.hitch.length;   // ile zostaje przed odczepianą
    const back = 0.55 + 0.6 * k;
    i.attachedTo = null;
    i.x = t.x - Math.cos(t.angle) * back; i.y = t.y - Math.sin(t.angle) * back; i.angle = t.angle;
    i.x = Math.max(0.5, Math.min(C.W - 0.5, i.x)); i.y = Math.max(0.5, Math.min(C.H - 0.5, i.y));
    i.lowered = false; i.parked = M.placeOf(i);
    return { ok: true, uid: i.uid };
  };
  // odczep wszystko w miejscu (sprzedaż/zwrot ciągnika; zmiana zestawu przed pracą)
  M.dropAll = function (m) {
    if (!m) return;
    if (m.attachedTo) { const t = M.get(m.attachedTo); if (t) t.hitch = t.hitch.filter(u => u !== m.uid); m.attachedTo = null; }
    while (m.hitch && m.hitch.length) M.detach(m.uid, null, { force: true, silent: true });
  };
  // gdzie stoi maszyna
  M.placeOf = function (m) {
    if (m.x == null) return 'yard';
    const i = M.tileOf(m);
    if (G.S.map.t[i] !== G.T.YARD) return 'field';
    for (const sp of spots()) if (Math.hypot(sp.x - m.x, sp.y - m.y) < 0.6) return 'garage';
    return 'yard';
  };
  function spots() {
    if (G.buildings && G.buildings.machineSpots) { try { return G.buildings.machineSpots() || []; } catch (e) { /* brak */ } }
    return [];
  }
  const slotSize = d => d.cat === 'combine' || d.cat === 'forage_harvester' || d.cat === 'beet_harvester' ? 2 : M.isPower(d) || d.cat === 'trailer' ? 1 : 0.5;
  // kto zajmuje miejsce (maszyny stojące, nieprzyczepione, w promieniu 0,6 kafla)
  function occupantsAt(x, y, exceptUid) {
    return M.list().filter(m => m.uid !== exceptUid && !m.attachedTo && m.x != null && !m.busy && !m.order && Math.hypot(m.x - x, m.y - y) < 0.6);
  }
  // wolne miejsce postojowe: garaż (jeśli maszyna ma być pod dachem i jest miejsce), potem wolny kafel podwórza, na końcu środek podwórza
  M.spotFor = function (m) {
    const d = def(m), size = slotSize(d);
    const ex = G.jobs && G.jobs.yardExit ? G.jobs.yardExit() : -1;
    if (m.stored !== false) {
      for (const sp of spots()) {
        const occ = occupantsAt(sp.x, sp.y, m.uid);
        const used = occ.reduce((a, o) => a + slotSize(def(o)), 0);
        if (used + size <= 1.0001) return { x: sp.x + (occ.length ? 0.3 : 0), y: sp.y, angle: Math.PI / 2, covered: true, buildingUid: sp.buildingUid };
      }
    }
    const Y = G.S.farm.yard, cand = [];
    for (let ty = Y.y + Y.h - 1; ty >= Y.y; ty--) for (let tx = Y.x + Y.w - 1; tx >= Y.x; tx--) {
      const i = G.idx(tx, ty);
      if (G.S.map.t[i] !== G.T.YARD || i === ex) continue;
      if (G.buildings && G.buildings.at && G.buildings.at(i)) continue;
      if (spots().some(sp => Math.floor(sp.x) === tx && Math.floor(sp.y) === ty)) continue;
      const occ = occupantsAt(tx + 0.5, ty + 0.5, m.uid);
      const used = occ.reduce((a, o) => a + slotSize(def(o)), 0);
      if (used + size <= 1.0001) cand.push({ x: tx + 0.5 + (occ.length ? 0.3 : 0), y: ty + 0.5, angle: Math.PI / 2, covered: false, buildingUid: null, used });
    }
    if (cand.length) { cand.sort((a, b) => a.used - b.used); return cand[0]; }
    return { x: Y.x + Y.w / 2, y: Y.y + Y.h / 2, angle: Math.PI / 2, covered: false, buildingUid: null };
  };
  // ustawia maszynę (teleport) na wolnym miejscu postojowym — nowy zakup, migracja zapisu, odstawienie po pracy
  M.park = function (uid) {
    const m = M.get(uid);
    if (!m || m.attachedTo) return false;
    const sp = M.spotFor(m);
    m.x = sp.x; m.y = sp.y; m.angle = sp.angle; m.parked = sp.covered ? 'garage' : 'yard'; m.lowered = false;
    for (const h of M.hitched(uid)) { h.x = m.x; h.y = m.y; h.angle = m.angle; h.parked = m.parked; }
    return true;
  };
  // pozycja całego zestawu (ciągnik + zaczep) — wołane przez prace/rozkazy/jazdę co klatkę
  M.setPos = function (uid, x, y, angle, moving) {
    const m = M.get(uid);
    if (!m) return;
    m.x = x; m.y = y; if (angle != null) m.angle = angle;
    if (moving) m.parked = null; else m.parked = M.placeOf(m);
    for (const h of M.hitched(uid)) { h.x = m.x; h.y = m.y; h.angle = m.angle; h.parked = m.parked; }
  };
  // maszyna najbliżej punktu (kafel ułamkowy) w promieniu r; doczepione wskazują na ciągnik (opts.any — dokładnie trafiona)
  M.at = function (x, y, r, opts) {
    r = r == null ? 0.8 : r;
    let best = null, bd = 1e9;
    for (const m of M.list()) {
      if (m.x == null) continue;
      const d = Math.hypot(m.x - x, m.y - y);
      if (d <= r && d < bd) { bd = d; best = m; }
    }
    if (!best) return null;
    return (opts && opts.any) ? best : M.rootOf(best);
  };
  // wyposażenie zestawu: { power, implement (narzędzie robocze | heder), trailers: [m], op (zabieg narzędzia | null) }
  M.rig = function (uid) {
    const m = M.get(uid), root = M.rootOf(m);
    if (!root) return null;
    const rd = def(root), hs = M.hitched(root.uid);
    const trailers = hs.filter(h => def(h).cat === 'trailer');
    let impl = hs.find(h => def(h).cat !== 'trailer') || null;
    const wd = impl ? def(impl) : null;
    let ops = [];
    if (rd.self && rd.ops && rd.ops.length) ops = rd.ops.slice();
    else if (wd) ops = (wd.ops || []).filter(o => o !== 'transport');
    if (rd.self && rd.needs === 'header' && !impl) ops = [];
    return { power: root, implement: impl, trailers, ops, cap: trailers.reduce((a, t) => a + (def(t).cap || 0), 0), width: (wd && wd.width) || rd.width || 0 };
  };

  // ---------- garaż ----------
  M.slots = function () {
    if (G.buildings && G.buildings.machineSlots) { const s = +G.buildings.machineSlots(); if (s >= 0) return s; }
    return 3;  // garaż po dziadku
  };
  M.slotsUsed = () => M.list().filter(m => !m.rented).reduce((a, m) => a + slotSize(def(m)), 0);
  // rozmieszczenie: najcenniejsze pod dachem
  function restow() {
    let free = M.slots();
    const own = M.list().filter(m => !m.rented && def(m)).sort((a, b) => M.value(b) / slotSize(def(b)) - M.value(a) / slotSize(def(a)));
    for (const m of own) { const s = slotSize(def(m)); m.stored = free >= s; if (m.stored) free -= s; }
    for (const m of M.list()) if (m.rented) m.stored = true;
  }
  M.restow = restow;

  // ---------- zgodność: zestawy {tractor, implement} do zabiegu ----------
  // params.crop (siew/zbiór), params.product (nawożenie). pid — działka (zbiór: uprawa z G.fields).
  M.cropFor = function (op, params, pid) {
    if (params && params.crop) return params.crop;
    if (op === 'harvest' && pid != null && G.fields && G.fields.get) { const f = G.fields.get(pid); return f && f.crop; }
    return null;
  };
  M.inputFor = function (op, params) {
    if (!params) return op === 'lime' ? 'wapno' : null;
    return params.product || params.input || (op === 'lime' ? 'wapno' : null);
  };
  // czy definicja narzędzia/maszyny pasuje do zabiegu
  M.fits = function (d, op, crop, input) {
    if (!d || !d.ops.includes(op)) return false;
    if (d.crops && crop && !d.crops.includes(crop)) return false;
    if (d.inputs && input && !d.inputs.includes(input)) return false;
    if (d.inputs && !input && op === 'fertilize' && d.cat !== 'spreader') return false;
    return true;
  };
  // wydajność ha/h zestawu (bez pracownika); skill: mnożnik pracownika
  M.rate = function (powerId, implId, skill) {
    const p = G.MACHINES[powerId], i = implId ? G.MACHINES[implId] : null;
    const w = (i && i.width) || (p && p.width) || 0, v = (p && p.self && p.speed) || (i && i.speed) || (p && p.speed) || 0;
    return w * v / 10 * 0.8 * (skill || 1);
  };
  M.compatible = function (op, params, pid) {
    const crop = M.cropFor(op, params, pid), input = M.inputFor(op, params);
    const all = M.list(), out = [];
    const powers = all.filter(m => M.isPower(def(m)));
    for (const p of powers) {
      const pd = def(p);
      if (pd.self && pd.ops.includes(op)) {
        if (pd.needs === 'header') {
          for (const h of all) {
            const hd = def(h);
            if (hd.cat !== 'header' || !M.fits(hd, op, crop, input) || (pd.crops && crop && !pd.crops.includes(crop))) continue;
            if (hd.reqHp > pd.hp) continue;
            out.push(combo(p, h));
          }
        } else if (M.fits(pd, op, crop, input)) out.push(combo(p, null));
      }
      if (pd.cat === 'tractor') {
        for (const im of all) {
          const id = def(im);
          if (M.isPower(id) || id.cat === 'header' || !M.fits(id, op, crop, input)) continue;
          if ((id.reqHp || 0) > pd.hp) continue;
          out.push(combo(p, im));
        }
      }
    }
    function combo(p, im) {
      const r1 = M.ready(p.uid), r2 = im ? M.ready(im.uid) : { ok: true };
      const busy = (p.busy || (im && im.busy)) || null;
      return {
        tractor: p.uid, implement: im ? im.uid : null, haH: Math.round(M.rate(p.id, im && im.id) * 100) / 100,
        available: r1.ok && r2.ok && !busy, busy, reason: !r1.ok ? r1.reason : !r2.ok ? r2.reason : busy ? 'Zajęta (zlecenie #' + busy + ')' : '',
        label: def(p).name + (im ? ' + ' + def(im).name : '')
      };
    }
    out.sort((a, b) => (b.available - a.available) || (b.haH - a.haH));
    return out;
  };
  // co z katalogu nadaje się do zabiegu (do podpowiedzi w sklepie)
  M.catalogFor = function (op, params) {
    const crop = params && params.crop, input = M.inputFor(op, params);
    return Object.values(G.MACHINES).filter(d => M.fits(d, op, crop, input) && d.cat !== 'header');
  };
  // ciągniki z mocą wystarczającą do narzędzia
  M.tractorsFor = function (implUid) {
    const d = def(implUid);
    return M.list().filter(m => def(m).cat === 'tractor' && def(m).hp >= ((d && d.reqHp) || 0));
  };

  // ---------- cykl ----------
  G.on('tick', () => {
    const S = G.S;
    if (!S.machines) return;
    for (const m of S.machines) {
      if (m.repairUntil && m.repairUntil <= S.tick) {
        m.repairUntil = 0; m.broken = false;
        if (m._wearAfter != null) { m.wear = Math.min(m.wear, m._wearAfter); delete m._wearAfter; }
        G.notify('✅ ' + def(m).name + ' po naprawie — gotowa do pracy', 'good', { key: 'rep_' + m.uid });
      }
    }
    // koniec wynajmu — automatyczny zwrot (jeśli pracuje: przedłużenie o dobę z opłatą)
    for (const m of S.machines.slice()) {
      if (!m.rented || m.bundled || m.until > S.tick) continue;
      const d = def(m);
      const busy = m.busy || S.machines.some(x => x.bundled === m.uid && x.busy);
      if (busy) {
        const q = M.rentQuote(m.id, 1);
        G.finance.spend(q.total, 'wynajem', 'Przedłużenie wynajmu (praca w toku): ' + d.name, true);
        m.until += TPD;
        for (const x of S.machines) if (x.bundled === m.uid) x.until = m.until;
        G.notify('🔑 ' + d.name + ' pracuje — wynajem przedłużony o dobę', 'warn', { key: 'rentx_' + m.uid });
      } else {
        M.dropAll(m);
        S.machines = S.machines.filter(x => x !== m && x.bundled !== m.uid);
        G.notify('🔑 Koniec wynajmu — ' + d.name + ' wraca do wypożyczalni', 'info');
      }
    }
    if (S.machineMarket && S.tick >= S.machineMarket.next) refreshUsed();
    syncYardStorage();
  });
  G.on('daily', () => {
    restow();
    // starzenie postojowe: pod chmurką rdza i uszczelki
    for (const m of G.S.machines) if (!m.rented) m.wear = Math.min(1, m.wear + (m.stored ? 0.0001 : 0.0006));
  });

  // ---------- start i walidacja ----------
  G.on('newGame', () => {
    G.S.machines = [];
    add('zagon_c60', { wear: 0.62, hours: 9800, year: 1986 });
    add('plug_2', { wear: 0.55, hours: 2100, year: 1979 });
    add('przyczepa_4', { wear: 0.5, hours: 3100, year: 1982 });
    G.inv.add('ON', 150);   // beczka ropy po dziadku
    refreshUsed();
    restow();
  });
  G.on('load', () => {
    const S = G.S;
    if (!Array.isArray(S.machines)) S.machines = [];
    S.machines = S.machines.filter(m => m && G.MACHINES[m.id]);
    for (const m of S.machines) {
      m.wear = Math.max(0, Math.min(1, +m.wear || 0));
      m.hours = +m.hours || 0;
      if (m.busy === undefined) m.busy = null;
      if (!m.year) m.year = G.date().year;
      m.broken = !!m.broken; m.repairUntil = +m.repairUntil || 0; m.rented = !!m.rented; m.until = +m.until || 0;
      if (m.fill && typeof m.fill === 'object') { for (const k in m.fill) if (!(m.fill[k] > 0)) delete m.fill[k]; if (!Object.keys(m.fill).length) m.fill = null; } else m.fill = null;
      // flota — stare zapisy nie mają pozycji ani zaczepów
      if (!Array.isArray(m.hitch)) m.hitch = [];
      if (m.attachedTo === undefined) m.attachedTo = null;
      m.lowered = !!m.lowered;
      if (m.driver === undefined) m.driver = null;
      if (m.order === undefined || (m.order && typeof m.order !== 'object')) m.order = null;
      if (m.angle == null || !isFinite(m.angle)) m.angle = Math.PI / 2;
      if (!(m.fuel >= 0)) m.fuel = M.tankOf(def(m));
    }
    const uids = new Set(S.machines.map(m => m.uid));
    for (const m of S.machines) {
      m.hitch = m.hitch.filter(u => uids.has(u) && u !== m.uid);
      if (m.attachedTo != null && (!uids.has(m.attachedTo) || !M.get(m.attachedTo).hitch.includes(m.uid))) m.attachedTo = null;
      if (m.driver != null && !(G.S.workers || []).some(w => w.uid === m.driver)) m.driver = null;
    }
    // heder zawsze na swoim kombajnie
    for (const m of S.machines) if (m.bundled && uids.has(m.bundled) && !m.attachedTo) { const c = M.get(m.bundled); if (c && !c.hitch.length) M.attach(c.uid, m.uid, { force: true }); }
    if (!S.machineMarket || !Array.isArray(S.machineMarket.offers)) refreshUsed();
    restow();
    // pozycje: brak → ustaw w garażu / na podwórzu (najpierw maszyny napędowe, potem luzem stojące narzędzia)
    for (const m of S.machines) if (!m.attachedTo && (m.x == null || m.y == null || !isFinite(m.x) || !isFinite(m.y) || !G.inMap(Math.floor(m.x), Math.floor(m.y)))) M.park(m.uid);
    for (const m of S.machines) { if (m.attachedTo) { const t = M.get(m.attachedTo); m.x = t.x; m.y = t.y; m.angle = t.angle; } if (!m.parked || m.parked === null) m.parked = M.placeOf(m); }
  });
})();
