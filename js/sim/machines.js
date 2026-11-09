// Złote Pola — park maszynowy: zakup, wynajem, zużycie, serwis → G.machines (agent: maszyny, ludzie, prace)
//
// Stan: G.S.machines = [{ uid, id, rented, until (tick końca wynajmu), wear 0..1, hours (motogodziny), busy: jobUid|null,
//                         year (rocznik), broken (awaria), repairUntil (tick końca naprawy | 0), stored (pod dachem),
//                         fill: { produkt: t } (ładunek przyczepy — pełna przyczepa na podwórzu to magazyn tymczasowy),
//                         FLOTA (trwałe pozycje): x, y (kafel ułamkowy), angle (rad, 0 = +x), attachedTo (uid ciągnika/kombajnu | null),
//                         hitch: [uid...] (ciągnik: narzędzie ALBO do 2 przyczep; kombajn: heder), lowered (narzędzie opuszczone),
//                         driver (uid pracownika | null), order (bieżący rozkaz | null), parked: 'garage'|'yard'|'field',
//                         fuel (l w zbiorniku), cargo: { produkt: t } (ładunek W DRODZE — zbiornik kombajnu / przyczepa z pola; jeszcze NIE w G.inv),
//                         autoDriver (kierowca dobrany automatycznie do rozkazu — wysiada po wykonaniu) }]
//       G.S.drive = { uid (pojazd prowadzony przez gracza | null), params: { op?, crop?, product?, rate? } (parametry ręcznej pracy) }
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
    if (M.cargoOf(m) > 1e-6) return { ok: false, reason: 'Maszyna ma ładunek (plon z pola) — najpierw rozładuj' };
    if (M.isManual(uid) || m.order) return { ok: false, reason: 'Maszyna jest w użyciu (rozkaz / jazda)' };
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
      fill: null, cargo: null, x: null, y: null, angle: Math.PI / 2, attachedTo: null, hitch: [], lowered: false, driver: null, autoDriver: false, order: null, parked: 'yard', fuel: 0 }, o || {});
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
    if (M.isManual(uid) || m.order) return { ok: false, reason: 'Maszyna jest w użyciu (rozkaz / jazda)' };
    if (M.cargoOf(m) > 1e-6) return { ok: false, reason: 'Maszyna ma ładunek (plon z pola) — najpierw rozładuj' };
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
  // ładunek w drodze (zbiornik kombajnu, przyczepa z pola) — jeszcze nie w magazynie
  M.cargoOf = function (m) { let t = 0; if (m && m.cargo) for (const k in m.cargo) t += +m.cargo[k] || 0; return t; };
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
  // czy maszyna (albo zestaw, do którego jest doczepiona) wykonuje rozkaz lub jest prowadzona ręcznie → tekst powodu | null
  M.engaged = function (uid) {
    const m = M.get(uid); if (!m) return null;
    const r = M.rootOf(m);
    if (M.isManual(r.uid)) return 'Prowadzisz: ' + def(r).name;
    if (r.order) return def(r).name + ' wykonuje rozkaz';
    return null;
  };

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
      const eng = M.engaged(p.uid) || (im ? M.engaged(im.uid) : null);
      return {
        tractor: p.uid, implement: im ? im.uid : null, haH: Math.round(M.rate(p.id, im && im.id) * 100) / 100,
        available: r1.ok && r2.ok && !busy && !eng, busy, reason: !r1.ok ? r1.reason : !r2.ok ? r2.reason : busy ? 'Zajęta (zlecenie #' + busy + ')' : eng || '',
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
      if (m.cargo && typeof m.cargo === 'object') { for (const k in m.cargo) if (!(m.cargo[k] > 0)) delete m.cargo[k]; if (!Object.keys(m.cargo).length) m.cargo = null; } else m.cargo = null;
      m.autoDriver = !!m.autoDriver;
      if (m.order && !(m.order.type && Array.isArray(m.order.path))) m.order = null;
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

// =====================================================================================================================
// ROZKAZY (G.machines.at / actions / command) I RĘCZNA JAZDA (G.drive)
// =====================================================================================================================
// Rozkaz (G.S.machines[*].order — tylko maszyna napędowa): { type: 'goto'|'hitch'|'garage'|'unload'|'refuel'|'follow'|'auger', label,
//   target (kafel celu | null), path: [kafle], pi, phase, timer, pick (uid narzędzia), combine (uid kombajnu), wait, reason, working }
// Rozkaz wykonuje kierowca (wolny pracownik albo „Ty”): m.driver = uid pracownika, worker.drives = uid maszyny. Kierowca dobrany
// automatycznie (m.autoDriver) wysiada po wykonaniu rozkazu; przydzielony akcją „Kierowca” zostaje w kabinie.
// Ruch rozkazów w czasie GRY (hook 'frame' dtH): Dijkstra po drogach (asfalt < polna < podwórze/pole), na przełaj tylko po działkach
// gracza; woda, las, wieś i budynki (poza garażami/wiatami) — nieprzejezdne.
// Ręczna jazda (G.drive) — w czasie RZECZYWISTYM (dtReal), niezależnie od prędkości gry: model rowerowy, przyczepy po śladzie z przegubem,
// kolizje, opuszczone narzędzie obrabia kafle pod szerokością roboczą (G.fields.workTile), kombajn zbiera do zbiornika (m.cargo).
(function () {
  const C = G.CFG, T = G.T, W = C.W, H = C.H, N = W * H, HA = C.TILE_HA;
  const M = G.machines, def = M.def;
  const WK = () => G.workers;
  const r3 = x => Math.round(x * 1000) / 1000;
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const toward = (v, t, s) => v < t ? Math.min(t, v + s) : Math.max(t, v - s);
  const wrapA = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
  const tileAt = (x, y) => G.inMap(Math.floor(x), Math.floor(y)) ? G.idx(Math.floor(x), Math.floor(y)) : -1;
  const pname = id => (G.PRODUCTS[id] && G.PRODUCTS[id].name) || id;
  const opName = op => (G.jobs && G.jobs.opName) ? G.jobs.opName(op) : op;
  const isNight = () => { const h = G.date().hour; return h >= 22 || h < 6; };
  const SIDE = 0.95;                // rura wyładowcza: punkt odbioru z lewej strony kombajnu (kafle od osi)
  const UNLOAD_H = 0.25;            // wysyp przyczepy pod silosem (h gry)
  const FOLLOW_SPD = 30;            // kafle/h gry — przyczepa jadąca przy kombajnie
  const FIELD_FUEL_FEE = 150;       // dowóz paliwa w pole (zł)
  const KMH = 180 / 7;              // km/h → kafle/s ręcznej jazdy: v / KMH (skala ×7 — jazda ma być przyjemna, nie realna)
  const AUGER_REAL = 50;            // ręczny przeładunek: t/s = augerTph / 50 (60 t/h → 1,2 t/s; zbiornik 6,5 t w ~5 s)
  const HEAD = 0.35;                // od środka ciągnika do zaczepu (kafle)

  // stan ręcznej jazdy (runtime; trwałe są tylko G.S.drive.uid i params)
  const DRV = { uid: null, v: 0, wheel: 0, inp: { throttle: 0, steer: 0, brake: false }, inAge: 9, trail: [], hints: [], working: false, workT: 0,
    unloading: null, lastOut: 0.3, chk: { key: '', t: 0, r: null }, blocked: '', worked: 0, vmax: 0 };

  // ===================== GEOMETRIA ZESTAWU =====================
  const partLen = d => d.cat === 'trailer' ? (d.hitchLen || 0.7) : 0.45;
  const bodyParts = uid => M.hitched(uid).filter(h => def(h).cat !== 'header');
  function axisParts(r) {
    const out = [];
    let px = r.x - Math.cos(r.angle) * HEAD, py = r.y - Math.sin(r.angle) * HEAD;
    for (const h of bodyParts(r.uid)) {
      const L = partLen(def(h));
      const cx = px - Math.cos(r.angle) * L, cy = py - Math.sin(r.angle) * L;
      out.push({ uid: h.uid, x: cx, y: cy, angle: r.angle });
      px = cx - Math.cos(r.angle) * L * 0.6; py = cy - Math.sin(r.angle) * L * 0.6;
    }
    return out;
  }
  // pozycje części zestawu (bez hedera): [{ uid, x, y, angle }] — przy ręcznej jeździe z przegubów, inaczej wzdłuż osi ciągnika
  M.parts = function (rootUid) {
    const r = M.get(rootUid);
    if (!r || r.x == null) return [];
    const hs = bodyParts(rootUid);
    if (DRV.uid === rootUid && DRV.trail.length === hs.length) return hs.map((h, k) => ({ uid: h.uid, x: DRV.trail[k].x, y: DRV.trail[k].y, angle: DRV.trail[k].angle }));
    return axisParts(r);
  };
  const sidePoint = m => ({ x: m.x + Math.sin(m.angle) * SIDE, y: m.y - Math.cos(m.angle) * SIDE });
  M.sidePoint = uid => { const m = M.get(uid); return m && m.x != null ? sidePoint(m) : null; };

  // ===================== ZBIORNIKI I ŁADUNEK =====================
  // kto ma zbiornik plonu w zestawie: kombajn samojezdny (nie sieczkarnia) albo ciągnięty kombajn z bunkrem
  M.tankHolder = function (rootUid) {
    const r = M.get(rootUid); if (!r) return null;
    const d = def(r);
    if (d.self && d.ops && d.ops.includes('harvest')) return d.cat === 'forage_harvester' ? null : r;
    return M.hitched(rootUid).find(h => { const hd = def(h); return hd.ops.includes('harvest') && hd.cat !== 'header' && hd.cap > 0; }) || null;
  };
  M.tankCap = function (m) { const d = def(m); if (!d) return 0; if (d.cap > 0) return d.cap; if (d.tankL > 0) return Math.round(d.tankL * G.GRAIN_T_PER_M3) / 1000; return 0; };
  const trailersOf = rootUid => M.hitched(rootUid).filter(h => def(h).cat === 'trailer');
  M.trailerRoom = m => Math.max(0, (def(m).cap || 0) - M.fillOf(m) - M.cargoOf(m));
  const rigRoom = rootUid => trailersOf(rootUid).reduce((a, t) => a + M.trailerRoom(t), 0);
  const rigCargo = rootUid => trailersOf(rootUid).reduce((a, t) => a + M.cargoOf(t), 0);
  M.rigCargo = rigCargo;
  // dokłada ładunek do przyczep zestawu (po kolei); zwraca ile weszło
  function loadRig(rootUid, prod) {
    let put = 0;
    for (const id in prod) {
      let q = prod[id];
      for (const t of trailersOf(rootUid)) {
        const x = Math.min(q, M.trailerRoom(t));
        if (x <= 1e-9) continue;
        t.cargo = t.cargo || {}; t.cargo[id] = r3((t.cargo[id] || 0) + x); q -= x; put += x;
      }
    }
    return put;
  }
  // przeładunek ślimakiem z holder.cargo na przyczepy zestawu rcvRoot (maks. q t) → ile przeładowano
  function transfer(holder, rcvRoot, q) {
    const tot = M.cargoOf(holder);
    if (tot <= 1e-9) return 0;
    q = Math.min(q, tot, rigRoom(rcvRoot));
    if (q <= 1e-9) return 0;
    const f = q / tot, prod = {};
    for (const id in holder.cargo) { const x = holder.cargo[id] * f; prod[id] = x; holder.cargo[id] = r3(holder.cargo[id] - x); if (holder.cargo[id] <= 1e-6) delete holder.cargo[id]; }
    if (!Object.keys(holder.cargo).length) holder.cargo = null;
    loadRig(rcvRoot, prod);
    return q;
  }
  // zestaw z przyczepą stojący pod rurą kombajnu c (lewa strona) → uid ciągnika | null
  function rigUnderAuger(c) {
    const p = sidePoint(c);
    let best = null, bd = 0.8;
    for (const r of M.list()) {
      if (r.attachedTo || r.uid === c.uid || r.x == null || r.busy || !trailersOf(r.uid).length) continue;
      for (const pt of M.parts(r.uid)) {
        if (def(M.get(pt.uid)).cat !== 'trailer') continue;
        const dd = Math.hypot(pt.x - p.x, pt.y - p.y);
        if (dd < bd) { bd = dd; best = r.uid; }
      }
    }
    return best;
  }
  M.rigUnderAuger = uid => { const c = M.get(uid); return c ? rigUnderAuger(c) : null; };
  // kombajn (z własnym zbiornikiem), pod którego rurą stoi przyczepa zestawu rootUid
  function combineOver(rootUid) {
    const pts = M.parts(rootUid).filter(pt => def(M.get(pt.uid)).cat === 'trailer');
    let best = null, bd = 0.8;
    for (const c of M.list()) {
      if (c.attachedTo || c.uid === rootUid || c.x == null || !M.tankHolder(c.uid)) continue;
      const p = sidePoint(c);
      for (const pt of pts) { const dd = Math.hypot(pt.x - p.x, pt.y - p.y); if (dd < bd) { bd = dd; best = c; } }
    }
    return best;
  }
  const mainProd = cargo => { let b = null, q = 0; for (const id in cargo || {}) if (cargo[id] > q) { q = cargo[id]; b = id; } return b; };
  function rigMainProd(rootUid) { const sum = {}; for (const t of trailersOf(rootUid)) for (const id in t.cargo || {}) sum[id] = (sum[id] || 0) + t.cargo[id]; return mainProd(sum); }
  // punkt rozładunku dla ładunku zestawu → { tile, x, y, store }
  function unloadSpot(m) {
    const prod = rigMainProd(m.uid);
    let pt = null;
    if (prod && G.buildings && G.buildings.unloadPoint) { try { pt = G.buildings.unloadPoint(prod, { x: m.x, y: m.y }); } catch (e) { pt = null; } }
    if (pt && G.inMap(Math.floor(pt.x), Math.floor(pt.y))) return { tile: G.idx(Math.floor(pt.x), Math.floor(pt.y)), x: pt.x, y: pt.y, store: true };
    const ex = G.jobs && G.jobs.yardExit ? G.jobs.yardExit() : M.tileOf(m);
    return { tile: ex, x: G.tx(ex) + 0.5, y: G.ty(ex) + 0.5, store: false };
  }
  // wysyp przyczep zestawu do magazynu; co się nie zmieści — zostaje na przyczepie jako magazyn tymczasowy (fill)
  function dumpRig(m) {
    let tot = 0, kept = 0;
    const got = {};
    for (const t of trailersOf(m.uid)) {
      if (!t.cargo) continue;
      for (const id of Object.keys(t.cargo)) {
        const q = r3(t.cargo[id]);
        if (!(q > 0)) continue;
        const added = G.inv.add(id, q);
        const rest = r3(q - added);
        if (rest > 1e-6) {
          t.fill = t.fill || {}; t.fill[id] = r3((t.fill[id] || 0) + rest);
          G.inv.add(id, rest); kept += rest;
        }
        tot += q; got[id] = (got[id] || 0) + q;
      }
      t.cargo = null;
    }
    if (tot > 0) {
      const txt = Object.keys(got).map(id => G.fmtQty(id, got[id]).trim() + ' ' + pname(id)).join(', ');
      G.notify('📦 Rozładowano ' + txt + (kept > 1e-6 ? ' — ' + G.fmtNum(kept, 1) + ' t zostaje na przyczepie (brak miejsca w magazynie)' : ''), kept > 1e-6 ? 'warn' : 'good', { key: 'dump_' + m.uid });
    }
    return tot;
  }
  M.dumpRig = uid => { const m = M.get(uid); return m ? dumpRig(m) : 0; };

  // ===================== KIEROWCY =====================
  function driverFree(w, m) {
    if (!w || w.busy) return false;
    if (w.drives != null && w.drives !== m.uid) { const o = M.get(w.drives); if (o && (o.order || M.isManual(o.uid))) return false; }
    if (WK().inBarn && WK().inBarn(w.uid)) return false;
    return true;
  }
  M.freeDrivers = function (uid) { const m = M.get(uid); if (!m || !WK()) return []; return WK().list().filter(w => driverFree(w, m)); };
  function pickDriver(m, want) {
    if (!WK()) return null;
    if (want != null) { const w = WK().get(want); return driverFree(w, m) ? w : null; }
    if (m.driver != null) { const w = WK().get(m.driver); if (driverFree(w, m)) return w; }
    const fr = M.freeDrivers(m.uid).filter(w => w.energy > 0.15);
    return fr.filter(w => !w.isPlayer).sort((a, b) => b.skills.field - a.skills.field)[0] || fr.find(w => w.isPlayer) || null;
  }
  // dlaczego nie ma kierowcy (zmęczenie / wszyscy zajęci)
  function noDriverReason(m) {
    const tired = M.freeDrivers(m.uid).filter(w => !(w.energy > 0.15));
    if (tired.length) return tired.map(w => w.name).join(', ') + ' — odpoczywa (zmęczenie). Poczekaj albo zatrudnij pracownika';
    return 'Brak wolnego kierowcy — zatrudnij pracownika albo prowadź sam';
  }
  M.noDriverReason = uid => { const m = M.get(uid); return m ? noDriverReason(m) : ''; };
  // kierowca wsiada (poprzedni wysiada); auto — wysiądzie po rozkazie
  M.seat = function (m, w, auto) {
    if (typeof m !== 'object') m = M.get(m);
    if (!m || !w) return;
    if (m.driver != null && m.driver !== w.uid) M.unseat(m);
    if (w.drives != null && w.drives !== m.uid) { const o = M.get(w.drives); if (o && o.driver === w.uid) { o.driver = null; o.autoDriver = false; } }
    m.driver = w.uid; w.drives = m.uid; m.autoDriver = !!auto;
  };
  M.unseat = function (m) {
    if (typeof m !== 'object') m = M.get(m);
    if (!m) return;
    const w = m.driver != null && WK() ? WK().get(m.driver) : null;
    if (w && w.drives === m.uid) w.drives = null;
    m.driver = null; m.autoDriver = false;
  };

  // ===================== TRASY ROZKAZÓW (Dijkstra) =====================
  const COST = { [T.ASPHALT]: 0.7, [T.ROAD]: 1, [T.YARD]: 1.6 };
  const OFF_COST = 1.9;
  const dist = new Float32Array(N), prv = new Int32Array(N), hI = new Int32Array(N * 4 + 8), hD = new Float32Array(N * 4 + 8);
  function blockedBuilding(i) {
    if (!(G.buildings && G.buildings.at)) return false;
    const b = G.buildings.at(i);
    if (!b) return false;
    const bd = G.buildings.def ? G.buildings.def(b) : null;
    return !(bd && bd.slots > 0);        // garaż / wiata / magazyn z miejscami postojowymi — wolno wjechać
  }
  M.blockedBuilding = blockedBuilding;
  const ownLand = i => (G.jobs && G.jobs.ownLand) ? G.jobs.ownLand(i) : false;
  M.orderPassable = i => (G.isDrivable(i) || ownLand(i)) && !blockedBuilding(i);
  function findPath(from, isGoal, pass) {
    dist.fill(Infinity); prv.fill(-1);
    let n = 0;
    const push = (i, d) => { let k = n++; while (k > 0) { const p = (k - 1) >> 1; if (hD[p] <= d) break; hI[k] = hI[p]; hD[k] = hD[p]; k = p; } hI[k] = i; hD[k] = d; };
    const pop = () => {
      const top = hI[0]; n--;
      if (n > 0) {
        const li = hI[n], ld = hD[n]; let k = 0;
        for (;;) { let c = 2 * k + 1; if (c >= n) break; if (c + 1 < n && hD[c + 1] < hD[c]) c++; if (hD[c] >= ld) break; hI[k] = hI[c]; hD[k] = hD[c]; k = c; }
        hI[k] = li; hD[k] = ld;
      }
      return top;
    };
    dist[from] = 0; push(from, 0);
    while (n > 0) {
      const d0 = hD[0], i = pop();
      if (d0 > dist[i]) continue;
      if (isGoal(i)) { const path = []; for (let k = i; k !== from && k >= 0; k = prv[k]) path.push(k); return path.reverse(); }
      const x = i % W;
      const nb = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i >= W ? i - W : -1, i < N - W ? i + W : -1];
      for (const j of nb) {
        if (j < 0 || !pass(j)) continue;
        const nd = d0 + (COST[G.S.map.t[j]] || OFF_COST);
        if (nd < dist[j] && n < hI.length) { dist[j] = nd; prv[j] = i; push(j, nd); }
      }
    }
    return null;
  }
  // cel → { tile, goals?: Set, label } | { error }
  function resolveTarget(m, target) {
    if (!target) return { error: 'Wskaż cel na mapie' };
    if (target.machineUid != null) {
      const o = M.get(target.machineUid);
      if (!o || o.x == null) return { error: 'Nie ma takiej maszyny' };
      const r = M.rootOf(o), i = M.tileOf(r);
      return { tile: i, goals: new Set([i].concat(G.N4(i))), label: 'Jedzie do: ' + def(r).name };
    }
    if (target.buildingUid != null) {
      const b = G.buildings && G.buildings.get ? G.buildings.get(target.buildingUid) : null;
      if (!b) return { error: 'Nie ma takiego budynku' };
      const f = G.buildings.footprint(b), goals = new Set();
      for (let y = f.y - 1; y <= f.y + f.h; y++) for (let x = f.x - 1; x <= f.x + f.w; x++) {
        if (!G.inMap(x, y)) continue;
        const i = G.idx(x, y);
        if ((x < f.x || x >= f.x + f.w || y < f.y || y >= f.y + f.h) && M.orderPassable(i)) goals.add(i);
      }
      if (!goals.size) return { error: 'Brak podjazdu do budynku' };
      const nm = (G.BUILDINGS[b.type] && G.BUILDINGS[b.type].name) || 'budynek';
      return { tile: G.idx(f.x + (f.w >> 1), f.y + (f.h >> 1)), goals, label: 'Jedzie pod: ' + nm };
    }
    if (target.parcelId != null) {
      const p = G.S.parcels[target.parcelId];
      if (!p) return { error: 'Nie ma takiej działki' };
      if (p.owner === 'player' || p.leased) {
        const e = p.entry >= 0 ? p.entry : p.tiles[0];
        let best = p.tiles[0], bd = 1e9;
        for (const i of p.tiles) { const dd = Math.hypot(G.tx(i) - G.tx(e), G.ty(i) - G.ty(e)); if (dd < bd) { bd = dd; best = i; } }
        return { tile: best, label: 'Na pole: ' + p.name };
      }
      if (p.entry >= 0) return { tile: p.entry, label: 'Pod działkę: ' + p.name };
      return { error: 'Cudza działka — nie ma wjazdu' };
    }
    let i = -1;
    if (typeof target.tile === 'number') i = target.tile;
    else if (target.tile && target.tile.x != null) i = tileAt(target.tile.x, target.tile.y);
    else if (target.x != null) i = tileAt(target.x, target.y);
    if (!(i >= 0 && i < N)) return { error: 'Poza mapą' };
    if (blockedBuilding(i)) { const b = G.buildings.at(i); return resolveTarget(m, { buildingUid: b.uid }); }
    if (!M.orderPassable(i)) {
      const t = G.S.map.t[i];
      return { error: t === T.WATER ? 'Tam jest woda' : t === T.FOREST ? 'Las — tam nie wjedziesz' : t === T.VILLAGE ? 'Zabudowa wsi — tam nie wjedziesz'
        : G.S.map.parcel[i] >= 0 ? 'Cudza działka — nie wjeżdżaj w cudze uprawy' : 'Tam nie dojedziesz (drogi i Twoje działki)' };
    }
    return { tile: i, label: 'Jedzie na miejsce' };
  }
  M.resolveTarget = (uid, target) => resolveTarget(M.get(uid), target);
  // trasa do celu → [kafle] | null
  function pathFor(m, rt) {
    const from = M.tileOf(m);
    if (rt.goals) {
      if (rt.goals.has(from)) return [];
      return findPath(from, i => rt.goals.has(i), i => M.orderPassable(i));
    }
    if (from === rt.tile) return [];
    return findPath(from, i => i === rt.tile, i => i === rt.tile || M.orderPassable(i));
  }
  M.routeTo = function (uid, target) { const m = M.get(uid); if (!m) return null; const rt = resolveTarget(m, target); return rt.error ? null : pathFor(m, rt); };

  // ===================== WYKONANIE ROZKAZÓW =====================
  function newOrder(type, label, path, extra) {
    return Object.assign({ type, label, target: path && path.length ? path[path.length - 1] : null, path: path || [], pi: 0, phase: 'drive', timer: 0,
      pick: null, combine: null, wait: false, reason: '', working: false }, extra || {});
  }
  function startOrder(m, o, w) {
    if (m.order) endOrder(m, true);
    const auto = !(m.driver === w.uid && !m.autoDriver);
    M.seat(m, w, auto);
    m.order = o; m.parked = null;
    if (o.type !== 'follow' && o.type !== 'auger') { m.lowered = false; for (const h of M.hitched(m.uid)) h.lowered = false; }   // do transportu podniesione
    return { ok: true, type: o.type, label: o.label, driver: w.name, target: o.target, steps: o.path.length };
  }
  function endOrder(m, silent, msg, kind) {
    m.order = null;
    if (m.autoDriver) M.unseat(m);
    m.parked = M.placeOf(m);
    for (const h of M.hitched(m.uid)) h.parked = m.parked;
    if (!silent && msg) G.notify(msg, kind || 'info', { key: 'order_' + m.uid });
  }
  M.stopOrder = uid => { const m = M.get(uid); if (m && m.order) endOrder(m, true); };
  const spdOf = m => (def(m).self ? 0.75 : 1) * (trailersOf(m.uid).length > 1 ? 0.85 : 1);
  // koszty jazdy/pracy: paliwo ze zbiornika, motogodziny, zużycie, zmęczenie kierowcy
  function burn(m, h, load, wearF) {
    if (!(h > 0)) return;
    const d = def(m);
    if (d.fuelLph) m.fuel = Math.max(0, r3((m.fuel || 0) - d.fuelLph * load * h));
    const wf = WK() && m.driver != null ? WK().wearFactor(m.driver) : 1;
    M.use(m.uid, h, wf * wearF);
    for (const hh of M.hitched(m.uid)) if (def(hh).cat !== 'header') M.use(hh.uid, h, 0.5);
    if (WK() && m.driver != null) WK().exert(m.driver, h, isNight(), 'field');
  }
  function driveOrder(m, o, dt) {
    const u = { x: m.x, y: m.y, angle: m.angle, path: o.path, pi: o.pi, spd: spdOf(m) };
    const used = G.jobs.moveAlong(u, dt);
    o.pi = u.pi;
    M.setPos(m.uid, u.x, u.y, u.angle, true);
    burn(m, used, 0.45, 0.6);
    return dt - used;
  }
  const inYard = m => G.S.map.t[M.tileOf(m)] === T.YARD;
  function doRefuel(m, field) {
    const d = def(m), tank = M.tankOf(d);
    if (!tank) return { ok: false, reason: d.name + ' nie ma zbiornika paliwa' };
    const need = r3(tank - (m.fuel || 0));
    if (need < 0.5) return { ok: false, reason: 'Zbiornik pełny' };
    if (field && !G.finance.spend(FIELD_FUEL_FEE, 'paliwo', 'Dowóz paliwa w pole: ' + d.name)) return { ok: false, reason: 'Brak środków na dowóz paliwa' };
    const r = M.refuel(need, d.name);
    if (!r.ok) { m.fuel = r3((m.fuel || 0) + r.fromStock); return { ok: false, reason: 'Brak paliwa w magazynie i pieniędzy na stację' }; }
    m.fuel = tank;
    G.notify('⛽ Zatankowano ' + d.name + ': ' + Math.round(need) + ' l' + (field ? ' (dowóz w pole)' : ''), 'info', { key: 'refuel_' + m.uid });
    return { ok: true, liters: need };
  }
  // garaż: postawić na miejscu postojowym, odczepić i odstawić narzędzia/puste przyczepy
  function parkHome(m) {
    const off = [];
    for (const h of M.hitched(m.uid).slice().reverse()) {
      if (def(h).cat === 'header') continue;
      M.detach(m.uid, h.uid, { force: true });
      off.push(h);
    }
    M.park(m.uid);                         // najpierw maszyna napędowa (miejsce pod dachem), potem narzędzia
    for (const h of off) if (!(def(h).cat === 'trailer' && (M.fillOf(h) > 1e-6 || M.cargoOf(h) > 1e-6))) M.park(h.uid);
  }
  function stepOrder(m, o, dtH, dtReal) {
    const d = def(m);
    let dt = dtH;
    if (o.type === 'follow' && o.combine != null && M.isManual(o.combine)) dt = Math.max(dt, dtReal * 1000 / C.TICK_MS);
    if (!(dt > 0)) return;
    const rdy = M.ready(m.uid);
    if (!rdy.ok) { o.wait = true; o.reason = rdy.reason; return; }
    const w = m.driver != null && WK() ? WK().get(m.driver) : null;
    if (!w) { endOrder(m, false, '✋ ' + d.name + ': brak kierowcy — rozkaz przerwany', 'warn'); return; }
    if (w.busy) { endOrder(m, true); return; }
    if (M.tankOf(d) && !(m.fuel > 0.05)) {
      const r = M.refuel(M.tankOf(d) - (m.fuel || 0), d.name + ' (dowóz)');
      if (!r.ok) { m.fuel = r3((m.fuel || 0) + r.fromStock); o.wait = true; o.reason = 'Brak paliwa i pieniędzy na tankowanie'; return; }
      m.fuel = M.tankOf(d);
      G.notify('⛽ ' + d.name + ' — zatankowano w trasie', 'info', { key: 'ofuel_' + m.uid });
    }
    o.wait = false; o.reason = ''; o.working = false;
    const arrived = () => o.pi >= o.path.length;
    switch (o.type) {
      case 'goto':
        driveOrder(m, o, dt);
        if (arrived()) endOrder(m, false, '📍 ' + d.name + ' — na miejscu');
        break;
      case 'hitch': {
        const i = M.get(o.pick);
        if (!i || (i.attachedTo && i.attachedTo !== m.uid)) { endOrder(m, false, '❌ ' + d.name + ': nie ma już czego podczepić', 'warn'); break; }
        if (o.phase === 'drive') {
          driveOrder(m, o, dt);
          if (arrived()) {
            const dd = Math.hypot(i.x - m.x, i.y - m.y);
            if (dd > 2.5 && (o.retry | 0) < 3) { o.retry = (o.retry | 0) + 1; o.path = pathFor(m, resolveTarget(m, { machineUid: i.uid })) || []; o.pi = 0; o.target = o.path.length ? o.path[o.path.length - 1] : null; }
            else { o.phase = 'hitch'; o.timer = M.HITCH_H; o.reason = 'Podczepia: ' + def(i).name; }
          }
        } else {
          o.timer -= dt;
          if (o.timer <= 0) {
            const r = M.attach(m.uid, i.uid, { force: true });
            endOrder(m, false, r.ok ? '🔗 ' + d.name + ' — podczepiono: ' + def(i).name : '❌ Nie da się podczepić: ' + r.reason, r.ok ? 'info' : 'warn');
          }
        }
        break;
      }
      case 'garage':
        driveOrder(m, o, dt);
        if (arrived()) { parkHome(m); endOrder(m, false, '🏠 ' + d.name + ' odstawiona' + (m.parked === 'garage' ? ' do garażu' : ' na podwórze')); }
        break;
      case 'refuel':
        driveOrder(m, o, dt);
        if (arrived()) { const r = doRefuel(m, false); endOrder(m, !r.ok ? false : true, r.ok ? '' : '⛽ ' + d.name + ': ' + r.reason, 'warn'); }
        break;
      case 'unload':
        if (o.phase === 'drive') { driveOrder(m, o, dt); if (arrived()) { o.phase = 'dump'; o.timer = UNLOAD_H; o.reason = 'Wysyp ładunku'; } }
        else { o.working = true; o.timer -= dt; if (o.timer <= 0) { dumpRig(m); endOrder(m, true); } }
        break;
      case 'auger': {
        const holder = M.tankHolder(m.uid), rcv = rigUnderAuger(m);
        if (!holder || M.cargoOf(holder) <= 1e-6) { endOrder(m, false, '🌾 ' + d.name + ' — zbiornik opróżniony'); break; }
        if (!rcv) { endOrder(m, false, '❌ ' + d.name + ': przyczepa odjechała spod rury', 'warn'); break; }
        o.working = true; o.reason = 'Przeładunek na przyczepę';
        const q = transfer(holder, rcv, G.augerTph(d.cat === 'combine' ? d : null) * dt);
        burn(m, dt, 0.3, 0.3);
        if (q <= 1e-9 && rigRoom(rcv) < 0.05) endOrder(m, false, '🌾 Przyczepa pełna — przeładunek przerwany', 'warn');
        break;
      }
      case 'follow': stepFollow(m, o, dt); break;
      default: endOrder(m, true);
    }
  }
  // przyczepa przy kombajnie: dojazd, jazda równoległa z lewej (pod rurą), odbiór ziarna
  function stepFollow(m, o, dt) {
    const c = M.get(o.combine), d = def(m);
    if (!c || c.x == null) { endOrder(m, false, '❌ ' + d.name + ': kombajn zniknął', 'warn'); return; }
    if (c.busy && G.jobs && G.jobs.addSet) {
      const w = m.driver;
      m.order = null;   // kierowca przechodzi do zlecenia jako kierowca przyczepy
      const r = G.jobs.addSet(c.busy, m.uid, w);
      if (r.ok) { G.notify('🚜 ' + d.name + ' dołącza do zbioru jako przyczepa', 'info', { key: 'join_' + m.uid }); return; }
      endOrder(m, false, '❌ ' + d.name + ': ' + r.reason, 'warn'); return;
    }
    if (rigRoom(m.uid) < 0.05) { endOrder(m, false, '🚜 ' + d.name + ' — przyczepa pełna, wydaj rozkaz „Rozładuj”', 'warn'); return; }
    const hs = bodyParts(m.uid), off = HEAD + (hs.length ? partLen(def(hs[0])) : 0.7);
    const sp = sidePoint(c), P = { x: sp.x + Math.cos(c.angle) * off, y: sp.y + Math.sin(c.angle) * off };
    const dx = P.x - m.x, dy = P.y - m.y, dd = Math.hypot(dx, dy);
    if (o.phase === 'drive') {
      if (dd < 2.5) { o.phase = 'follow'; o.path = []; o.pi = 0; }
      else {
        if (o.pi >= o.path.length) { o.path = pathFor(m, resolveTarget(m, { machineUid: c.uid })) || []; o.pi = 0; o.target = o.path.length ? o.path[o.path.length - 1] : null; if (!o.path.length) o.phase = 'follow'; }
        driveOrder(m, o, dt);
        return;
      }
    }
    if (dd > 4) { o.phase = 'drive'; o.path = []; o.pi = 0; return; }
    const can = FOLLOW_SPD * dt;
    let nx = m.x, ny = m.y, ang = m.angle;
    if (dd > 0.05) { ang = wrapA(ang + clamp(wrapA(Math.atan2(dy, dx) - ang), -can * 2.4, can * 2.4) * (dd > 0.4 ? 1 : 0.3)); }
    if (dd <= 0.4) ang = wrapA(ang + clamp(wrapA(c.angle - ang), -Math.max(0.05, can * 2.4 + dt * 2), Math.max(0.05, can * 2.4 + dt * 2)));
    if (can >= dd) { nx = P.x; ny = P.y; } else { nx += dx / dd * can; ny += dy / dd * can; }
    M.setPos(m.uid, nx, ny, ang, true);
    if (dd > 0.02) burn(m, Math.min(dt, dd / FOLLOW_SPD), 0.45, 0.6);
    o.reason = dd < 0.3 ? 'Jedzie pod rurą kombajnu' : 'Podjeżdża do kombajnu';
    // ziarno z kombajnu stojącego/na rozkazie (ręcznie prowadzony — przeładunek włącza gracz: G.drive.unloadAuger)
    const holder = M.tankHolder(c.uid);
    if (holder && !M.isManual(c.uid) && M.cargoOf(holder) > 1e-6 && rigUnderAuger(c) === m.uid) {
      const q = transfer(holder, m.uid, G.augerTph(def(c).cat === 'combine' ? def(c) : null) * dt);
      if (q > 0) { o.working = true; o.reason = 'Odbiera ziarno'; }
    }
  }
  function stepOrders(dtH, dtReal) {
    for (const m of M.list()) {
      if (!m.order) continue;
      if (m.attachedTo || m.busy || M.isManual(m.uid)) { m.order = null; continue; }
      try { stepOrder(m, m.order, dtH, dtReal); } catch (e) { console.error('[rozkaz]', e); endOrder(m, true); }
    }
  }

  // ===================== AKCJE =====================
  const A = (id, icon, label, enabled, reason, extra) => Object.assign({ id, icon, label, enabled: !!enabled, reason: enabled ? '' : (reason || '') }, extra || {});
  M.ACTIONS = ['drive', 'goto', 'work', 'hitch', 'unhitch', 'lower', 'raise', 'follow_combine', 'unload', 'refuel', 'garage', 'assign_driver', 'stop'];
  // narzędzie, które się opuszcza: robocze na zaczepie, heder kombajnu, albo sama maszyna samojezdna bez hedera
  function lowerTarget(m) {
    const rig = M.rig(m.uid);
    if (!rig || !rig.ops.length) return null;
    return rig.implement || (def(m).self ? m : null);
  }
  M.lowerTarget = uid => { const m = M.get(uid); return m ? lowerTarget(M.rootOf(m)) : null; };
  function hitchCands(m) {
    const out = [];
    const ps = M.parts(m.uid), last = ps[ps.length - 1];
    const rear = last ? { x: last.x - Math.cos(last.angle) * 0.45, y: last.y - Math.sin(last.angle) * 0.45 } : null;
    for (const o of M.list()) {
      if (o.uid === m.uid || o.attachedTo || o.x == null || M.isPower(def(o))) continue;
      let dd = Math.hypot(o.x - m.x, o.y - m.y);
      if (rear) dd = Math.min(dd, Math.hypot(o.x - rear.x, o.y - rear.y));
      if (dd > M.HITCH_RANGE) continue;
      if (!M.canAttach(m.uid, o.uid).ok) continue;
      out.push({ uid: o.uid, dd });
    }
    return out.sort((a, b) => a.dd - b.dd).map(x => x.uid);
  }
  const targetParcel = t => { if (!t) return null; if (t.parcelId != null) return t.parcelId; let i = -1; if (typeof t.tile === 'number') i = t.tile; else if (t.x != null) i = tileAt(t.x, t.y); return i >= 0 && G.S.map.parcel[i] >= 0 ? G.S.map.parcel[i] : null; };
  function chooseOp(rig, pid, params) {
    const ops = rig.ops.filter(o => !G.fields || !G.fields.OPS || G.fields.OPS[o]);
    if (params && params.op && ops.includes(params.op)) return params.op;
    if (pid != null && G.fields && G.fields.canDo) { for (const o of ops) { try { if (G.fields.canDo(pid, o, Object.assign({}, DRV.params || {}, params || {})).ok) return o; } catch (e) { /* dalej */ } } }
    return ops[0] || null;
  }
  // wybór parametrów zabiegu: { op, key: 'crop'|'product', label, choices: [{id, label, icon}] } | null (nie trzeba)
  function paramsChoice(op, rig, given) {
    given = given || {};
    if (!op || !G.fields || !G.fields.OPS) return null;
    const wd = rig.implement && def(rig.implement).cat !== 'header' ? def(rig.implement) : def(rig.power);
    const mo = G.date().month;
    if (op === 'sow') {
      const crops = Object.keys(G.CROPS || {}).filter(c => !G.CROPS[c].meadow && M.fits(wd, 'sow', c, null) && (!G.fields.sowTiming || G.fields.sowTiming(c, mo) > 0)
        && (!G.fields.implementFor || !wd.cat || G.fields.implementFor(null, 'sow', { crop: c }) === wd.cat));
      if (given.crop && crops.includes(given.crop)) return null;
      return { op, key: 'crop', label: 'Co siejesz?', choices: crops.map(c => ({ id: c, label: G.CROPS[c].name, icon: '🌱' })) };
    }
    if (op === 'fertilize' || op === 'spray') {
      const all = (G.fields.OPS[op].products || []).filter(p => M.fits(wd, op, null, p) && (op !== 'fertilize' || !G.fields.OPS.fertilize.implementFor || G.fields.OPS.fertilize.implementFor({ product: p }) === wd.cat));
      if (given.product && all.includes(given.product)) return null;
      if (all.length <= 1) return null;
      return { op, key: 'product', label: op === 'spray' ? 'Jaki środek?' : 'Jaki nawóz?', choices: all.map(p => ({ id: p, label: pname(p), icon: (G.PRODUCTS[p] && G.PRODUCTS[p].icon) || '•' })) };
    }
    return null;
  }
  M.paramsChoice = (uid, op, given) => { const m = M.get(uid); if (!m) return null; const rig = M.rig(m.uid); return paramsChoice(op || chooseOp(rig, null, given), rig, given); };
  // parametry zabiegu: kontynuacja przerwanej pracy na działce bierze jej parametry
  function paramsFor(op, rig, pid, given) {
    const f = pid != null && G.fields && G.fields.get ? G.fields.get(pid) : null;
    if (f && f.work && f.work.op === op && !(given && (given.crop || given.product))) {
      const p = Object.assign({}, f.work.params || {});
      for (const k of ['quality', 'machine', 'worker', 'contractor', 'jobUid', 'manual']) delete p[k];
      return p;
    }
    const out = {};
    for (const k of ['crop', 'product', 'rate', 'mode']) if (given && given[k] != null) out[k] = given[k];
    if ((op === 'fertilize' || op === 'spray') && !out.product) {
      const ch = paramsChoice(op, rig, out);
      if (!ch) {
        const wd = rig.implement ? def(rig.implement) : def(rig.power);
        const all = (G.fields.OPS[op].products || []).filter(p => M.fits(wd, op, null, p));
        if (all.length === 1) out.product = all[0];
      }
    }
    return out;
  }
  // zlecenie dla zestawu: { ok, spec } | { ok:false, reason, needParams }
  function workSpec(m, pid, params) {
    params = params || {};
    const rig = M.rig(m.uid);
    if (!rig.ops.length) return { ok: false, reason: def(m).self && def(m).needs === 'header' ? 'Kombajn bez hedera' : 'Brak narzędzia roboczego — podczep pług, siewnik…' };
    const op = chooseOp(rig, pid, params);
    const np = paramsChoice(op, rig, Object.assign({}, DRV.params, params));
    const prm = paramsFor(op, rig, pid, Object.assign({}, op === 'sow' || op === 'fertilize' || op === 'spray' ? DRV.params : {}, params));
    if (np && !(np.key === 'crop' ? prm.crop : prm.product)) return { ok: false, op, reason: np.label + ' — wybierz parametry', needParams: np };
    const drv = M.isManual(m.uid) ? WK().player() : pickDriver(m, params.worker);
    if (!drv) return { ok: false, op, reason: noDriverReason(m) };
    const spec = { op, pid, params: prm, machines: [rig.power.uid].concat(rig.implement ? [rig.implement.uid] : []), worker: drv.uid, keepHitched: true };
    if (op === 'harvest') {
      // transport: wolne przyczepy, ciągniki i kierowcy (bez ładunku, bez rozkazów)
      const ok = x => !x.busy && !x.order && !M.engaged(x.uid) && M.ready(x.uid).ok && !spec.machines.includes(x.uid) && M.fillOf(x) <= 1e-6 && M.cargoOf(x) <= 1e-6;
      const trs = M.list().filter(x => def(x).cat === 'trailer' && ok(x)).map(x => x.uid);
      const tcs = M.list().filter(x => def(x).cat === 'tractor' && ok(x)).map(x => x.uid);
      const hs = M.freeDrivers(m.uid).filter(w => w.uid !== drv.uid && !w.drives).map(w => w.uid);
      const pr = G.jobs.pairSets(trs, tcs, hs, params.pairs || null);
      for (const st of pr.sets) { spec.machines.push(st.tractor, st.trailer); if (st.trailer2) spec.machines.push(st.trailer2); (spec.helpers = spec.helpers || []).push(st.helper); }
      if (params.transport) spec.transport = params.transport | 0;
    }
    return { ok: true, op, spec };
  }

  // cel może przyjść jako sam indeks kafla (tak podaje interfejs) albo obiekt { tile | parcelId | machineUid | buildingUid }
  const normTarget = t => (typeof t === 'number' ? (t >= 0 ? { tile: t } : null) : t || null);
  M.actions = function (uid, target) {
    target = normTarget(target);
    let m = M.get(uid);
    if (!m) return [];
    target = target || null;
    if (m.attachedTo) m = M.rootOf(m);
    const d = def(m);
    if (!M.isPower(d)) {
      if (target && target.machineUid != null) { const t = M.get(target.machineUid); if (t) { const tr = M.rootOf(t); if (M.isPower(def(tr))) return M.actions(tr.uid, { machineUid: m.uid }).filter(a => a.id === 'hitch'); } }
      return [A('hitch', '🔗', 'Podczep do ciągnika', false, d.name + ' nie jeździ sama — wybierz ciągnik, a potem to narzędzie')];
    }
    const manual = M.isManual(m.uid), rdy = M.ready(m.uid);
    const busyR = m.busy ? 'Pracuje w zleceniu — najpierw je wstrzymaj lub odwołaj' : '';
    const moveR = busyR || (!rdy.ok ? rdy.reason : '');
    const drv = manual ? WK().player() : pickDriver(m, null);
    const drvR = drv ? '' : noDriverReason(m);
    const rig = M.rig(m.uid), hs = M.hitched(m.uid), trs = rig.trailers, holder = M.tankHolder(m.uid);
    const out = [];
    // prowadź / wysiądź
    if (manual) out.push(A('drive', '🚪', 'Wysiądź', true));
    else {
      const pl = WK() && WK().player();
      let r = '';
      if (m.repairUntil > G.S.tick) r = rdy.reason;
      else if (!pl) r = 'Brak gracza';
      else if (pl.busy && pl.busy !== m.busy) r = 'Jesteś zajęty w zleceniu';
      out.push(A('drive', '🎮', 'Prowadź', !r, r));
    }
    // jedź
    {
      let r = moveR || drvR, lbl = 'Jedź tutaj';
      if (!r) {
        if (!target) r = 'Wskaż cel na mapie';
        else { const rt = resolveTarget(m, target); if (rt.error) r = rt.error; else if (!pathFor(m, rt)) r = 'Nie da się tam dojechać'; else lbl = rt.label.replace('Jedzie', 'Jedź'); }
      }
      out.push(A('goto', '📍', lbl, !r, r));
    }
    // obrób działkę (zlecenie)
    {
      const pid = targetParcel(target);
      let r = moveR, lbl = 'Obrób działkę', np = null;
      if (!rig.ops.length) r = r || (d.self && d.needs === 'header' ? 'Kombajn bez hedera' : 'Brak narzędzia roboczego');
      else if (pid == null) r = r || 'Wskaż działkę';
      else {
        const p = G.S.parcels[pid], op = chooseOp(rig, pid, null);
        lbl = opName(op) + ': ' + p.name;
        if (p.owner !== 'player' && !p.leased) r = r || 'To nie jest Twoja działka';
        if (!r) {
          const ws = workSpec(m, pid, {});
          if (!ws.ok && ws.needParams) np = ws.needParams;
          else if (!ws.ok) r = ws.reason;
          else { const v = G.jobs.validate(ws.spec); if (!v.ok) r = v.reason; }
        }
      }
      out.push(A('work', '🚜', lbl, !r, r, np ? { needParams: np } : null));
    }
    // podczep
    {
      let r = busyR, lbl = 'Podczep', hu = null;
      if (target && target.machineUid != null && M.rootOf(M.get(target.machineUid) || m) !== m) {
        const i = M.get(target.machineUid);
        if (!i) r = r || 'Brak maszyny';
        else {
          lbl = 'Podczep: ' + def(i).name;
          const c = M.canAttach(m.uid, i.uid);
          if (!c.ok) r = r || c.reason;
          else if (!hitchCands(m).includes(i.uid)) { r = r || moveR || drvR; if (!r && !pathFor(m, resolveTarget(m, { machineUid: i.uid }))) r = 'Nie da się tam dojechać'; }
          hu = i.uid;
        }
      } else {
        const near = hitchCands(m);
        if (near.length) { hu = near[0]; lbl = 'Podczep: ' + def(M.get(hu)).name; } else r = r || 'Wskaż narzędzie lub przyczepę (albo podjedź bliżej)';
      }
      out.push(A('hitch', '🔗', lbl, !r, r, hu != null ? { machineUid: hu } : null));
    }
    // odczep
    {
      const last = hs[hs.length - 1];
      let r = busyR;
      if (!last) r = r || 'Nic nie jest doczepione';
      else if (def(last).cat === 'header') r = r || 'Heder zostaje na kombajnie';
      out.push(A('unhitch', '⛓️', last ? 'Odczep: ' + def(last).name : 'Odczep', !r, r));
    }
    // opuść / podnieś
    {
      const li = lowerTarget(m);
      const r0 = busyR || (!li ? 'Brak narzędzia roboczego' : '');
      out.push(A('lower', '⬇️', 'Opuść narzędzie', !r0 && !li.lowered, r0 || 'Już opuszczone'));
      out.push(A('raise', '⬆️', 'Podnieś narzędzie', !r0 && !!li.lowered, r0 || 'Już podniesione'));
    }
    // odbieraj od kombajnu
    {
      let r = moveR || drvR, lbl = 'Odbieraj od kombajnu';
      if (!trs.length) r = r || 'Potrzebna przyczepa na zaczepie';
      else if (trs.some(t => M.fillOf(t) > 1e-6)) r = r || 'Przyczepa pełna (magazyn tymczasowy) — najpierw opróżnij';
      else if (rigRoom(m.uid) < 0.05) r = r || 'Przyczepa pełna — rozładuj';
      else if (!(target && target.machineUid != null)) r = r || 'Wskaż kombajn';
      else {
        const c = M.rootOf(M.get(target.machineUid) || m);
        if (!c || c === m) r = r || 'Wskaż kombajn';
        else {
          lbl = 'Odbieraj od: ' + def(c).name;
          const job = c.busy && G.jobs ? G.jobs.get(c.busy) : null;
          if (job) { if (!(job.status === 'active' && job.op === 'harvest' && job.power === c.uid)) r = r || 'Kombajn nie zbiera teraz w zleceniu'; }
          else if (!M.tankHolder(c.uid)) r = r || (def(c).cat === 'forage_harvester' ? 'Sieczkarnia — przyczepy przydziel w zleceniu zbioru' : 'To nie jest kombajn ze zbiornikiem');
        }
      }
      out.push(A('follow_combine', '🌾', lbl, !r, r));
    }
    // rozładuj
    {
      if (holder && !trs.length) {
        const cg = M.cargoOf(holder);
        let r = busyR || (!(cg > 1e-6) ? 'Zbiornik pusty' : '');
        if (!r && !rigUnderAuger(m)) r = 'Podstaw przyczepę z LEWEJ strony kombajnu (pod rurę)';
        out.push(A('unload', '🌾', 'Przeładuj na przyczepę (' + G.fmtNum(cg, 1) + ' t)', !r, r));
      } else {
        const cg = rigCargo(m.uid);
        let r = moveR;
        if (!trs.length) r = r || 'Nic do rozładunku';
        else if (!(cg > 1e-6)) r = r || 'Przyczepy puste';
        else if (!manual) r = r || drvR;
        out.push(A('unload', '📦', 'Rozładuj pod silosem' + (cg > 1e-6 ? ' (' + G.fmtNum(cg, 1) + ' t)' : ''), !r, r));
      }
    }
    // tankuj
    {
      const tank = M.tankOf(d), need = Math.round(tank - (m.fuel || 0));
      let r = '';
      if (!tank) r = 'Bez silnika';
      else if (need < 1) r = 'Zbiornik pełny';
      else if (m.busy) r = busyR;
      else if (!manual && !inYard(m)) r = rdy.ok ? drvR : '';
      out.push(A('refuel', '⛽', 'Tankuj' + (need >= 1 ? ' (' + need + ' l' + (manual && !inYard(m) ? ', dowóz ' + FIELD_FUEL_FEE + ' zł' : '') + ')' : ''), !r, r));
    }
    // do garażu
    {
      let r = moveR || drvR;
      if (!r && m.parked === 'garage' && !m.order) r = 'Już w garażu';
      out.push(A('garage', '🏠', 'Odstaw do garażu', !r, r));
    }
    // kierowca
    {
      const cur = m.driver != null && WK() ? WK().get(m.driver) : null;
      const ch = M.freeDrivers(m.uid).map(w => ({ id: w.uid, label: w.name + (w.isPlayer ? '' : ' (polowe ' + w.skills.field + ')'), current: m.driver === w.uid }));
      let r = busyR || (manual ? 'Prowadzisz sam' : m.order ? 'Wykonuje rozkaz — najpierw Stop' : '');
      if (!r && !ch.length && !cur) r = 'Brak wolnych pracowników';
      out.push(A('assign_driver', '👤', cur ? 'Kierowca: ' + cur.name : 'Przydziel kierowcę', !r, r, { choices: ch.concat(cur ? [{ id: null, label: 'Bez kierowcy (wysiada)' }] : []) }));
    }
    // stop
    {
      const can = !!(m.order || m.busy || manual);
      out.push(A('stop', '✋', manual ? 'Stop (wysiądź)' : m.busy ? 'Wstrzymaj zlecenie' : 'Stop', can, 'Stoi'));
    }
    return out;
  };

  M.command = function (uid, actionId, target, params) {
    target = normTarget(target);
    params = params || {};
    let m = M.get(uid);
    if (!m) return { ok: false, reason: 'Brak maszyny' };
    if (m.attachedTo) m = M.rootOf(m);
    const d = def(m);
    if (!M.isPower(d)) {
      if (actionId === 'hitch' && target && target.machineUid != null) { const t = M.get(target.machineUid); if (t && M.isPower(def(M.rootOf(t)))) return M.command(M.rootOf(t).uid, 'hitch', { machineUid: m.uid }, params); }
      return { ok: false, reason: d.name + ' nie jeździ sama — wybierz ciągnik' };
    }
    const manual = M.isManual(m.uid), rdy = M.ready(m.uid);
    const busyR = m.busy ? 'Pracuje w zleceniu — najpierw je wstrzymaj lub odwołaj' : '';
    const moveR = busyR || (!rdy.ok ? rdy.reason : '');
    // kierowca do rozkazu: gracz, jeśli właśnie prowadzi (wysiada z trybu ręcznego i jedzie dalej jako „rozkaz”), inaczej wolny pracownik
    const driver = () => { if (manual) { const pl = WK().player(); G.drive.release(); return pl; } return pickDriver(m, params.worker); };
    const fail = reason => ({ ok: false, reason });
    switch (actionId) {
      case 'drive': return manual ? G.drive.release() : G.drive.take(m.uid);
      case 'stop':
        if (manual) return G.drive.release();
        if (m.order) { endOrder(m, true); return { ok: true }; }
        if (m.busy && G.jobs) { G.jobs.pause(m.busy); return { ok: true, paused: m.busy }; }
        return fail('Maszyna stoi');
      case 'goto': {
        if (moveR) return fail(moveR);
        const rt = resolveTarget(m, target); if (rt.error) return fail(rt.error);
        const path = pathFor(m, rt); if (!path) return fail('Nie da się tam dojechać');
        const w = driver(); if (!w) return fail(noDriverReason(m));
        return startOrder(m, newOrder('goto', rt.label, path), w);
      }
      case 'hitch': {
        if (busyR) return fail(busyR);
        let iu = target && target.machineUid != null ? target.machineUid : hitchCands(m)[0];
        const i = iu != null ? M.get(iu) : null;
        if (!i) return fail('Wskaż narzędzie lub przyczepę');
        const c = M.canAttach(m.uid, i.uid); if (!c.ok) return c;
        if (hitchCands(m).includes(i.uid)) {
          if (manual) return G.drive.hitchNearest(i.uid);
          const r = M.attach(m.uid, i.uid, { force: true });
          if (r.ok) M.setPos(m.uid, m.x, m.y, m.angle, false);
          return r;
        }
        if (moveR) return fail(moveR);
        const path = pathFor(m, resolveTarget(m, { machineUid: i.uid })); if (!path) return fail('Nie da się dojechać do: ' + def(i).name);
        const w = driver(); if (!w) return fail(noDriverReason(m));
        return startOrder(m, newOrder('hitch', 'Po: ' + def(i).name, path, { pick: i.uid }), w);
      }
      case 'unhitch': {
        if (busyR) return fail(busyR);
        if (manual) return G.drive.unhitch();
        const r = M.detach(m.uid, null);
        if (r.ok) { const i = M.get(r.uid); if (i) i.parked = M.placeOf(i); }
        return r;
      }
      case 'lower': case 'raise': {
        if (busyR) return fail(busyR);
        const li = lowerTarget(m); if (!li) return fail('Brak narzędzia roboczego');
        li.lowered = actionId === 'lower';
        return { ok: true, lowered: li.lowered };
      }
      case 'work': {
        if (moveR) return fail(moveR);
        const pid = targetParcel(target); if (pid == null) return fail('Wskaż działkę');
        const ws = workSpec(m, pid, params);
        if (!ws.ok) return { ok: false, reason: ws.reason, needParams: ws.needParams || null };
        if (manual) G.drive.release();
        if (m.order) endOrder(m, true);
        const r = G.jobs.create(ws.spec);
        return r.ok ? { ok: true, job: r.job, warn: r.warn } : { ok: false, reason: r.reason, need: r.need };
      }
      case 'follow_combine': {
        if (moveR) return fail(moveR);
        const trs = trailersOf(m.uid);
        if (!trs.length) return fail('Potrzebna przyczepa na zaczepie');
        if (trs.some(t => M.fillOf(t) > 1e-6)) return fail('Przyczepa pełna (magazyn tymczasowy) — najpierw opróżnij');
        const c0 = target && target.machineUid != null ? M.get(target.machineUid) : null;
        const c = c0 ? M.rootOf(c0) : null;
        if (!c || c === m) return fail('Wskaż kombajn');
        if (c.busy) {
          const job = G.jobs.get(c.busy);
          if (!job || job.status !== 'active' || job.op !== 'harvest' || job.power !== c.uid) return fail('Kombajn nie zbiera teraz w zleceniu');
          const w = driver(); if (!w) return fail(noDriverReason(m));
          if (m.order) endOrder(m, true);
          const r = G.jobs.addSet(job.uid, m.uid, w.uid);
          if (r.ok) G.notify('🚜 ' + d.name + ' dołącza do zbioru jako przyczepa (' + w.name + ')', 'info');
          return r;
        }
        if (!M.tankHolder(c.uid)) return fail('To nie jest kombajn ze zbiornikiem');
        const w = driver(); if (!w) return fail(noDriverReason(m));
        const path = pathFor(m, resolveTarget(m, { machineUid: c.uid })) || [];
        return startOrder(m, newOrder('follow', 'Odbiór od: ' + def(c).name, path, { combine: c.uid }), w);
      }
      case 'unload': {
        if (busyR) return fail(busyR);
        const holder = M.tankHolder(m.uid), trs = trailersOf(m.uid);
        if (holder && !trs.length) {
          if (!(M.cargoOf(holder) > 1e-6)) return fail('Zbiornik pusty');
          if (manual) return G.drive.unloadAuger();
          if (!rigUnderAuger(m)) return fail('Podstaw przyczepę z LEWEJ strony kombajnu (pod rurę)');
          const w = driver(); if (!w) return fail(noDriverReason(m));
          return startOrder(m, newOrder('auger', 'Przeładunek na przyczepę', []), w);
        }
        if (!trs.length || !(rigCargo(m.uid) > 1e-6)) return fail('Nic do rozładunku');
        if (moveR) return fail(moveR);
        const sp = unloadSpot(m);
        if (Math.hypot(sp.x - m.x, sp.y - m.y) < 1.6 || (manual && !sp.store && inYard(m))) { const t = dumpRig(m); return { ok: true, tons: t }; }
        const path = pathFor(m, { tile: sp.tile }) || pathFor(m, { tile: sp.tile, goals: new Set([sp.tile].concat(G.N4(sp.tile))) });
        if (!path) return fail('Nie da się dojechać do punktu rozładunku');
        const w = driver(); if (!w) return fail(noDriverReason(m));
        return startOrder(m, newOrder('unload', sp.store ? 'Do rozładunku pod silos' : 'Na podwórze (brak miejsca w magazynie)', path), w);
      }
      case 'refuel': {
        if (busyR) return fail(busyR);
        if (manual || inYard(m)) return doRefuel(m, !inYard(m));
        if (!(m.fuel > 0.5) || params.delivery) return doRefuel(m, true);
        const ex = G.jobs.yardExit();
        const path = pathFor(m, { tile: ex }); if (!path) return doRefuel(m, true);
        const w = driver(); if (!w) return fail(noDriverReason(m));
        return startOrder(m, newOrder('refuel', 'Do tankowania', path), w);
      }
      case 'garage': {
        if (moveR) return fail(moveR);
        const sp = M.spotFor(m), st = tileAt(sp.x, sp.y);
        const w = driver(); if (!w) return fail(noDriverReason(m));
        const path = pathFor(m, { tile: st, goals: new Set([st].concat(G.N4(st))) });
        if (!path) return fail('Nie da się dojechać na podwórze');
        return startOrder(m, newOrder('garage', 'Do garażu', path), w);
      }
      case 'assign_driver': {
        if (busyR) return fail(busyR);
        if (manual) return fail('Prowadzisz sam — najpierw wysiądź');
        if (m.order) return fail('Wykonuje rozkaz — najpierw Stop');
        if (params.worker == null) { M.unseat(m); return { ok: true, driver: null }; }
        const w = WK().get(params.worker);
        if (!driverFree(w, m)) return fail(w ? w.name + ' jest zajęty' : 'Brak pracownika');
        M.seat(m, w, false);
        return { ok: true, driver: w.name };
      }
    }
    return fail('Nieznana akcja');
  };

  // ===================== RĘCZNA JAZDA =====================
  const D = G.drive = {};
  const hint = t => { if (t && !DRV.hints.includes(t)) DRV.hints.push(t); };
  function axisTrail(m) { DRV.trail = []; return axisParts(m).map(p => ({ x: p.x, y: p.y, angle: p.angle })); }
  function updateTrail(m) {
    const hs = bodyParts(m.uid);
    if (DRV.trail.length !== hs.length) DRV.trail = axisTrail(m);
    // skok pozycji (wczytanie, przestawienie) — przeguby od nowa wzdłuż osi
    if (DRV.trail.length && Math.hypot(DRV.trail[0].x - m.x, DRV.trail[0].y - m.y) > HEAD + partLen(def(hs[0])) * 2.5) DRV.trail = axisTrail(m);
    let px = m.x - Math.cos(m.angle) * HEAD, py = m.y - Math.sin(m.angle) * HEAD;
    for (let k = 0; k < hs.length; k++) {
      const L = partLen(def(hs[k])), t = DRV.trail[k];
      const dx = px - t.x, dy = py - t.y;
      if (Math.hypot(dx, dy) > 1e-6) t.angle = Math.atan2(dy, dx);
      t.x = px - Math.cos(t.angle) * L; t.y = py - Math.sin(t.angle) * L;
      px = t.x - Math.cos(t.angle) * L * 0.6; py = t.y - Math.sin(t.angle) * L * 0.6;
    }
  }
  // prędkość maksymalna (km/h) zależnie od podłoża i pracy
  function vmax(m, i, working) {
    const d = def(m), t = i >= 0 ? G.S.map.t[i] : -1;
    let v = d.self ? 25 : (d.hp || 60) < 70 ? 30 : 40;
    if (t === T.ROAD) v = Math.min(v, 30);
    else if (t === T.YARD) v = Math.min(v, 15);
    else if (t !== T.ASPHALT) v = Math.min(v, 18);
    if (working) {
      const li = lowerTarget(m), wd = li && li !== m ? def(li) : d;
      v = Math.min(v, Math.max(5, ((wd.speed || d.speed || 7) * 1.3)));
    }
    const trs = trailersOf(m.uid);
    if (trs.length) { const cap = trs.reduce((a, x) => a + (def(x).cap || 0), 0), ld = trs.reduce((a, x) => a + M.fillOf(x) + M.cargoOf(x), 0); v *= 1 - 0.25 * (cap ? Math.min(1, ld / cap) : 0); }
    return v;
  }
  function obstacleTile(i, cur) {
    if (i < 0) return 'Koniec mapy';
    const t = G.S.map.t[i];
    if (t === T.WATER) return 'Woda';
    if (t === T.FOREST) return 'Las';
    if (t === T.VILLAGE) return 'Zabudowa wsi';
    if (i !== cur && blockedBuilding(i)) { const b = G.buildings.at(i), bc = cur >= 0 ? G.buildings.at(cur) : null; if (!bc || bc.uid !== b.uid) return 'Budynek'; }
    return null;
  }
  function obstacle(m, nx, ny, dir) {
    const cur = M.tileOf(m);
    const fx = nx + Math.cos(m.angle) * 0.4 * dir, fy = ny + Math.sin(m.angle) * 0.4 * dir;
    const ob = obstacleTile(tileAt(fx, fy), cur) || obstacleTile(tileAt(nx, ny), cur);
    if (ob) return ob;
    const ox = m.x + Math.cos(m.angle) * 0.4 * dir, oy = m.y + Math.sin(m.angle) * 0.4 * dir;
    for (const o of M.list()) {
      if (o.x == null || o.attachedTo || o.uid === m.uid) continue;
      if (o.parked === 'garage' && !o.order && !o.busy && def(o).cat === 'header') continue;
      const pts = [{ x: o.x, y: o.y }].concat(M.isPower(def(o)) ? M.parts(o.uid) : []);
      for (const p of pts) {
        const dn = Math.hypot(fx - p.x, fy - p.y);
        if (dn < 0.5 && dn < Math.hypot(ox - p.x, oy - p.y) - 1e-4) return def(o).name;
      }
    }
    return null;
  }
  function foreign(i) { const pid = i >= 0 ? G.S.map.parcel[i] : -1; if (pid < 0) return false; const p = G.S.parcels[pid]; return !!p && p.owner !== 'player' && !p.leased; }
  // kafle pod szerokością roboczą (szerokość w kaflach = width / 4 m, 1…3 kafle — skala gry)
  function swathTiles(m, li) {
    const d = def(m);
    let cx, cy, a = m.angle, len = 0;
    if (li === m || (d.self && li)) { cx = m.x + Math.cos(a) * 0.5; cy = m.y + Math.sin(a) * 0.5; }
    else { const ps = M.parts(m.uid), p = ps.find(x => x.uid === li.uid) || ps[0]; if (!p) return []; cx = p.x; cy = p.y; a = p.angle; len = partLen(def(li)); }
    const wm = (li && def(li).width) || d.width || 3, sw = clamp(wm / 4, 1, 3), n = Math.max(1, Math.round(sw));
    const out = [];
    // narzędzie ciągnięte pracuje na całej długości: od zaczepu do swojego środka (uwrocia przy lesie/wodzie da się dorobić)
    for (const f of len > 0 ? [0, len] : [0]) {
      const bx = cx + Math.cos(a) * f, by = cy + Math.sin(a) * f;
      for (let k = 0; k < n; k++) {
        const o = (k - (n - 1) / 2) * (sw / n);
        const i = tileAt(bx + Math.sin(a) * o, by - Math.cos(a) * o);
        if (i >= 0 && !out.includes(i)) out.push(i);
      }
    }
    return out;
  }
  function curOp(m) { const rig = M.rig(m.uid); return rig && rig.ops.length ? chooseOp(rig, null, DRV.params) : null; }
  // sprawdzenie zabiegu na działce (co ~0,7 s realnie)
  function checkWork(pid, op, params) {
    const key = pid + '|' + op + '|' + (params.crop || '') + (params.product || '');
    const now = performance.now();
    if (DRV.chk.key === key && now - DRV.chk.t < 700) return DRV.chk.r;
    let r = { ok: true };
    try {
      const f = G.fields.get(pid);
      const cont = f && f.work && f.work.op === op;
      if (!cont) r = G.fields.canDo(pid, op, params) || { ok: true };
      if (r.ok && G.weather && G.weather.canWork) r = G.weather.canWork(op) || { ok: true };
    } catch (e) { r = { ok: true }; }
    DRV.chk = { key, t: now, r };
    return r;
  }
  function workTiles(m) {
    const li = lowerTarget(m);
    DRV.working = false;
    if (!li) return;
    if (!li.lowered) {
      const i0 = M.tileOf(m), pid = G.S.map.parcel[i0];
      if (pid >= 0 && !foreign(i0)) hint('⬇️ Opuść narzędzie, żeby pracować');
      return;
    }
    if (!(G.fields && G.fields.workTile)) return;
    const rig = M.rig(m.uid), op = chooseOp(rig, null, DRV.params), d = def(m);
    if (!op) return;
    const pl = WK() && WK().player();
    const wd = li === m ? d : def(li);
    for (const i of swathTiles(m, li)) {
      const pid = G.S.map.parcel[i];
      if (pid < 0) continue;
      if (foreign(i)) { hint('⚠️ Cudza działka — nie niszcz cudzych upraw!'); continue; }
      const p = G.S.parcels[pid];
      const np = paramsChoice(op, rig, DRV.params);
      const params = paramsFor(op, rig, pid, DRV.params);
      if (np && !(np.key === 'crop' ? params.crop : params.product)) { hint('❓ ' + np.label + ' — wybierz parametry pracy'); continue; }
      const crop = op === 'harvest' ? (G.fields.get(pid) || {}).crop : params.crop;
      if (!M.fits(wd, op, crop, params.product || (op === 'lime' ? 'wapno' : null))) { hint('⛔ ' + wd.name + ' nie nadaje się do: ' + opName(op).toLowerCase() + (crop && G.CROPS[crop] ? ' (' + G.CROPS[crop].name + ')' : '')); continue; }
      const ck = checkWork(pid, op, params);
      if (!ck.ok) { hint('⛔ ' + (ck.reason || 'Zabieg teraz niemożliwy')); continue; }
      const ts = G.fields.tileState(i), f = G.fields.get(pid);
      if (ts && ts.worked && f && f.work && f.work.op === op) continue;
      // zbiornik / przyczepa sieczkarni
      let holder = null, rcv = null;
      if (op === 'harvest') {
        holder = M.tankHolder(m.uid);
        if (!holder) {
          rcv = rigUnderAuger(m);
          if (!rcv) { hint('🌽 Sieczkarnia sypie na bieżąco — podstaw przyczepę z lewej strony'); continue; }
          if (rigRoom(rcv) < DRV.lastOut) { hint('🚜 Przyczepa przy sieczkarni pełna'); continue; }
        } else if (M.tankCap(holder) - M.cargoOf(holder) < Math.min(DRV.lastOut, M.tankCap(holder) * 0.5)) { hint('🌾 Zbiornik pełny — podstaw przyczepę z lewej i przeładuj'); continue; }
      }
      // paliwo za kafel = spalanie × czas pracy na kafel (jak w zleceniach)
      const rate = M.rate(M.rootOf(m).id, li !== m ? li.id : null, pl ? WK().speedFactor(pl.uid) : 1);
      const hT = HA / Math.max(0.02, rate), load = (li !== m && wd.load != null) ? wd.load : 1;
      const need = (d.fuelLph || 0) * load * hT;
      if (d.fuelLph && (m.fuel || 0) < need) { hint('⛽ Za mało paliwa na dalszą pracę — zatankuj'); continue; }
      const q = pl ? Math.max(0.3, WK().qualityOf(pl.uid) - Math.max(0, li.wear - 0.6) * 0.3) : 0.8;
      let r;
      try { r = G.fields.workTile(pid, i, op, Object.assign({}, params, { quality: Math.round(q * 100) / 100, mode: wd.mode || d.mode || null, machine: wd.id, worker: pl ? pl.uid : null, contractor: false, manual: true })) || {}; }
      catch (e) { console.error('[jazda workTile]', e); r = { error: 'błąd zabiegu' }; }
      if (r.error) { hint('⛔ ' + r.error); DRV.chk.t = 0; continue; }
      if (r.already) continue;
      DRV.working = true; DRV.workT = 0.6; DRV.worked++;
      if (r.out && op === 'harvest') {
        let tons = 0; const bulk = {};
        for (const id in r.out) { const qq = +r.out[id]; if (!(qq > 0)) continue; const u = G.PRODUCTS[id] && G.PRODUCTS[id].unit; if (u === 't' || !u) { bulk[id] = qq; tons += qq; } else G.inv.add(id, qq); }
        if (holder) { holder.cargo = holder.cargo || {}; for (const id in bulk) holder.cargo[id] = r3((holder.cargo[id] || 0) + bulk[id]); }
        else if (rcv) loadRig(rcv, bulk);
        if (tons > 0) DRV.lastOut = tons;
      }
      burn(m, hT, load, 1);
      if (li !== m) M.use(li.uid, hT, WK() && pl ? WK().wearFactor(pl.uid) : 1);
      // całe pole obrobione → zakończenie zabiegu
      const f2 = G.fields.get(pid);
      if (f2 && f2.work && f2.work.op === op && f2.work.count >= p.tiles.length) {
        let res = null;
        try { res = G.fields.complete(pid, op, params); } catch (e) { console.error('[jazda complete]', e); }
        if (res && res.outRest && op === 'harvest') { const h2 = holder; if (h2) { h2.cargo = h2.cargo || {}; for (const id in res.outRest) if (res.outRest[id] > 0) h2.cargo[id] = r3((h2.cargo[id] || 0) + res.outRest[id]); } }
        G.notify('✅ Zakończono (ręcznie): ' + opName(op) + ' — ' + p.name, 'good', { parcel: pid, key: 'mdone_' + pid + op });
        DRV.chk.t = 0;
      }
    }
  }
  function stepAuger(m, dt) {
    const u = DRV.unloading;
    if (!u) return;
    const from = M.get(u.from);
    let ok = !!from && M.cargoOf(from) > 1e-6, to = u.to;
    if (ok) {
      if (u.mode === 'out') ok = rigUnderAuger(m) === to;
      else { const c = combineOver(m.uid); ok = !!c && c.uid === u.combine; to = m.uid; }
    }
    if (!ok) { DRV.unloading = null; hint(from && M.cargoOf(from) > 1e-6 ? '🌾 Przyczepa wyjechała spod rury — przeładunek przerwany' : '🌾 Zbiornik opróżniony'); return; }
    const cd = def(u.mode === 'out' ? m : M.get(u.combine));
    const q = transfer(from, to, G.augerTph(cd && cd.cat === 'combine' ? cd : null) / AUGER_REAL * dt);
    if (q <= 1e-9) { DRV.unloading = null; hint('🚜 Przyczepa pełna'); }
  }
  function stepDrive(dtReal) {
    if (DRV.uid == null) return;
    const m = M.get(DRV.uid);
    if (!m || m.attachedTo || m.x == null) { D.release(); return; }
    const dt = Math.min(0.1, dtReal || 0);
    if (!(dt > 0)) return;
    const d = def(m);
    DRV.hints = [];
    DRV.inAge += dt;
    const inp = DRV.inAge > 0.5 ? { throttle: 0, steer: 0, brake: false } : DRV.inp;
    let thr = clamp(+inp.throttle || 0, -1, 1);
    const st = clamp(+inp.steer || 0, -1, 1);
    const rdy = M.ready(m.uid);
    if (!rdy.ok) { thr = 0; hint('🛠️ ' + rdy.reason); }
    if (M.tankOf(d) && !(m.fuel > 0.01)) { thr = 0; hint('⛽ Brak paliwa — zatankuj (dowóz w pole ' + FIELD_FUEL_FEE + ' zł)'); }
    const i0 = M.tileOf(m), li = lowerTarget(m);
    const working = !!(li && li.lowered && G.S.map.parcel[i0] >= 0 && !foreign(i0));
    const vm = DRV.vmax = vmax(m, i0, working);
    const acc = d.self ? 8 : 6 + Math.min(10, (d.hp || 60) / 25);
    let v = DRV.v;
    const tgt = thr >= 0 ? thr * vm : thr * 8;
    if (inp.brake) v = toward(v, 0, 40 * dt);
    else if (v * tgt < 0) v = toward(v, 0, 30 * dt);
    else if (Math.abs(tgt) > Math.abs(v)) v = toward(v, tgt, acc * dt);
    else v = toward(v, tgt, (Math.abs(thr) < 0.05 ? 10 : 18) * dt);
    if (Math.abs(v) > vm && v > 0) v = toward(v, vm, 25 * dt);
    const lim = 0.62 * (1 - 0.5 * Math.min(1, Math.abs(v) / 40));
    DRV.wheel = toward(DRV.wheel, st * lim, 2.2 * dt);
    const L = d.self ? 0.55 : 0.42, vt = v / KMH;
    const ang = wrapA(m.angle + vt / L * Math.tan(DRV.wheel) * dt);
    const nx = m.x + Math.cos(ang) * vt * dt, ny = m.y + Math.sin(ang) * vt * dt;
    DRV.blocked = '';
    if (Math.abs(vt) > 1e-5) {
      const ob = obstacle(m, nx, ny, vt >= 0 ? 1 : -1);
      if (ob) { v = 0; DRV.blocked = ob; hint('⛔ Przeszkoda: ' + ob); }
      else {
        M.setPos(m.uid, nx, ny, ang, true);
        const dist = Math.abs(vt * dt);
        // jazda: paliwo i motogodziny wg drogi (jak w zleceniach: ~55 kafli/h)
        burn(m, dist / 55, 0.45, 0.6);
      }
    }
    DRV.v = v;
    updateTrail(m);
    if (v > 0.5) workTiles(m); else { DRV.workT -= dt; if (DRV.workT <= 0) DRV.working = false; }
    stepAuger(m, dt);
    // podpowiedzi
    const i1 = M.tileOf(m);
    if (foreign(i1)) hint('⚠️ Cudza działka — nie niszcz cudzych upraw!');
    const hc = hitchCands(m);
    if (hc.length && Math.abs(v) < 3) hint('🔗 Można podczepić: ' + def(M.get(hc[0])).name);
    const holder = M.tankHolder(m.uid);
    if (holder && M.cargoOf(holder) > 1e-6 && !DRV.unloading && rigUnderAuger(m)) hint('🌾 Przyczepa pod rurą — przeładuj');
    if (rigCargo(m.uid) > 1e-6) { const sp = unloadSpot(m); if (Math.hypot(sp.x - m.x, sp.y - m.y) < 1.6) hint('📦 Jesteś przy punkcie rozładunku — rozładuj'); }
    if (trailersOf(m.uid).length && !DRV.unloading) { const c = combineOver(m.uid); if (c && !c.busy && M.cargoOf(M.tankHolder(c.uid)) > 1e-6) hint('🌾 Jesteś pod rurą kombajnu — odbierz ziarno'); }
    if (m.busy) hint('⏸️ Zlecenie wstrzymane, dopóki prowadzisz');
  }

  D.active = () => DRV.uid;
  D.take = function (uid) {
    let m = M.get(uid);
    if (!m) return { ok: false, reason: 'Brak maszyny' };
    m = M.rootOf(m);
    const d = def(m);
    if (!M.isPower(d)) return { ok: false, reason: d.name + ' nie ma silnika — wybierz ciągnik' };
    if (m.repairUntil > G.S.tick) return { ok: false, reason: M.ready(m.uid).reason };
    const pl = WK() && WK().player();
    if (!pl) return { ok: false, reason: 'Brak gracza' };
    if (pl.busy && pl.busy !== m.busy) return { ok: false, reason: 'Jesteś zajęty w zleceniu — najpierw je wstrzymaj' };
    if (DRV.uid != null && DRV.uid !== m.uid) D.release();
    if (DRV.uid === m.uid) return { ok: true };
    if (m.order) endOrder(m, true);
    M.seat(m, pl, false);
    DRV.uid = m.uid; DRV.v = 0; DRV.wheel = 0; DRV.inAge = 9; DRV.unloading = null; DRV.hints = []; DRV.working = false;
    DRV.trail = axisTrail(m);
    m.parked = null;
    G.S.drive.uid = m.uid;
    if (m.busy) G.notify('🎮 Prowadzisz ' + d.name + ' — zlecenie wstrzymane, dopóki nie wysiądziesz', 'info', { key: 'drive_job' });
    return { ok: true };
  };
  D.release = function () {
    const uid = DRV.uid;
    if (uid == null) return { ok: false, reason: 'Nikogo nie prowadzisz' };
    const m = M.get(uid);
    // przyczepy zostają tam, gdzie były: pozycja zestawu wg osi ciągnika (konwencja floty)
    DRV.uid = null; DRV.v = 0; DRV.unloading = null; DRV.working = false; DRV.trail = []; DRV.hints = [];
    if (G.S.drive) G.S.drive.uid = null;
    if (m) {
      M.unseat(m);
      if (m.busy && G.jobs) { const j = G.jobs.get(m.busy); if (j) { const st = (j.sets || []).find(s => s.tractor === m.uid); m.driver = j.power === m.uid ? j.worker : st ? st.helper : null; } }
      M.setPos(m.uid, m.x, m.y, m.angle, false);
    }
    return { ok: true };
  };
  D.input = function (o) {
    o = o || {};
    DRV.inp = { throttle: clamp(+o.throttle || 0, -1, 1), steer: clamp(+o.steer || 0, -1, 1), brake: !!o.brake };
    DRV.inAge = 0;
  };
  D.toggleImplement = function () {
    const m = M.get(DRV.uid);
    if (!m) return { ok: false, reason: 'Nikogo nie prowadzisz' };
    const li = lowerTarget(m);
    if (!li) return { ok: false, reason: 'Brak narzędzia roboczego' };
    li.lowered = !li.lowered;
    DRV.chk.t = 0;
    return { ok: true, lowered: li.lowered };
  };
  D.hitchNearest = function (which) {
    const m = M.get(DRV.uid);
    if (!m) return { ok: false, reason: 'Nikogo nie prowadzisz' };
    if (Math.abs(DRV.v) > 3) return { ok: false, reason: 'Zatrzymaj się, żeby podczepić' };
    const c = hitchCands(m);
    const iu = which != null ? (c.includes(which) ? which : null) : c[0];
    if (iu == null) return { ok: false, reason: 'Nic w zasięgu zaczepu — podjedź tyłem bliżej' };
    const i = M.get(iu), old = { x: i.x, y: i.y, angle: i.angle };
    const was = bodyParts(m.uid).length;
    const r = M.attach(m.uid, i.uid, { force: true });
    if (!r.ok) return r;
    if (def(i).cat !== 'header' && DRV.trail.length === was) DRV.trail.push(old);
    updateTrail(m);
    return { ok: true, uid: i.uid, name: def(i).name };
  };
  D.unhitch = function () {
    const m = M.get(DRV.uid);
    if (!m) return { ok: false, reason: 'Nikogo nie prowadzisz' };
    const hs = M.hitched(m.uid), last = hs[hs.length - 1];
    if (!last) return { ok: false, reason: 'Nic nie jest doczepione' };
    const ps = M.parts(m.uid), pos = ps.find(p => p.uid === last.uid);
    const r = M.detach(m.uid, last.uid);
    if (!r.ok) return r;
    if (pos) { last.x = clamp(pos.x, 0.5, W - 0.5); last.y = clamp(pos.y, 0.5, H - 0.5); last.angle = pos.angle; }
    last.parked = M.placeOf(last);
    if (DRV.trail.length > bodyParts(m.uid).length) DRV.trail.pop();
    return { ok: true, uid: last.uid };
  };
  D.unloadAuger = function () {
    const m = M.get(DRV.uid);
    if (!m) return { ok: false, reason: 'Nikogo nie prowadzisz' };
    if (DRV.unloading) { DRV.unloading = null; return { ok: true, active: false }; }
    const holder = M.tankHolder(m.uid);
    if (holder) {
      if (M.cargoOf(holder) <= 1e-6) return { ok: false, reason: 'Zbiornik pusty' };
      const rcv = rigUnderAuger(m);
      if (!rcv) return { ok: false, reason: 'Podstaw przyczepę z LEWEJ strony kombajnu (pod rurę)' };
      if (rigRoom(rcv) < 0.05) return { ok: false, reason: 'Przyczepa pełna' };
      DRV.unloading = { from: holder.uid, to: rcv, mode: 'out' };
      return { ok: true, active: true, to: rcv };
    }
    if (trailersOf(m.uid).length) {
      const c = combineOver(m.uid);
      if (!c) return { ok: false, reason: 'Podjedź przyczepą pod rurę kombajnu (jego lewa strona)' };
      if (c.busy) return { ok: false, reason: 'Kombajn pracuje w zleceniu — użyj rozkazu „Odbieraj od kombajnu”' };
      const h = M.tankHolder(c.uid);
      if (M.cargoOf(h) <= 1e-6) return { ok: false, reason: 'Zbiornik kombajnu pusty' };
      if (rigRoom(m.uid) < 0.05) return { ok: false, reason: 'Przyczepa pełna' };
      DRV.unloading = { from: h.uid, to: m.uid, combine: c.uid, mode: 'in' };
      return { ok: true, active: true, from: c.uid };
    }
    return { ok: false, reason: 'Ten pojazd nie ma rury wyładowczej ani przyczepy' };
  };
  D.needParams = function () {
    const m = M.get(DRV.uid);
    if (!m) return null;
    const rig = M.rig(m.uid), op = curOp(m);
    return op ? paramsChoice(op, rig, DRV.params) : null;
  };
  D.setParams = function (p) {
    p = p || {};
    for (const k of ['op', 'crop', 'product', 'rate']) { if (p[k] === null) delete DRV.params[k]; else if (p[k] != null) DRV.params[k] = p[k]; }
    if (G.S.drive) G.S.drive.params = Object.assign({}, DRV.params);
    DRV.chk.t = 0;
    return { ok: true, params: Object.assign({}, DRV.params) };
  };
  D.params = () => Object.assign({}, DRV.params);
  D.state = function () {
    const m = M.get(DRV.uid);
    if (!m) return null;
    const d = def(m), li = lowerTarget(m), holder = M.tankHolder(m.uid), trs = trailersOf(m.uid);
    let fill = 0;
    if (holder) fill = M.tankCap(holder) ? Math.min(1, M.cargoOf(holder) / M.tankCap(holder)) : 0;
    else if (trs.length) { const cap = trs.reduce((a, t) => a + (def(t).cap || 0), 0); fill = cap ? Math.min(1, trs.reduce((a, t) => a + M.fillOf(t) + M.cargoOf(t), 0) / cap) : 0; }
    const i = M.tileOf(m), pid = G.S.map.parcel[i], op = curOp(m);
    const v = DRV.v;
    return {
      uid: m.uid, name: d.name, speed: Math.round(Math.abs(v)), speedRaw: v, maxSpeed: Math.round(DRV.vmax || 0), gear: v > 0.3 ? 'D' : v < -0.3 ? 'R' : (DRV.inp.throttle < -0.05 ? 'R' : DRV.inp.throttle > 0.05 ? 'D' : 'N'),
      fuel: Math.round((m.fuel || 0) * 10) / 10, fuelMax: M.tankOf(d), implement: li && li !== m ? def(li).name : li ? d.name : null, lowered: !!(li && li.lowered),
      fill: Math.round(fill * 1000) / 1000, tons: holder ? r3(M.cargoOf(holder)) : r3(rigCargo(m.uid)), tile: i, parcelId: pid >= 0 ? pid : null, foreign: foreign(i),
      canHitch: hitchCands(m), hints: DRV.hints.slice(), working: !!DRV.working, op, opName: op ? opName(op) : null, params: Object.assign({}, DRV.params),
      auger: holder ? (DRV.unloading && DRV.unloading.mode === 'out' ? 'out' : 'in') : null, unloading: !!DRV.unloading, receiving: !!(DRV.unloading && DRV.unloading.mode === 'in'),
      blocked: DRV.blocked || null, jobPaused: m.busy || null, trail: DRV.trail.map(t => ({ x: t.x, y: t.y, angle: t.angle }))
    };
  };

  // ===================== PĘTLA I ZAPIS =====================
  G.on('frame', (dtH, now, dtReal) => {
    if (!G.S || !G.S.machines) return;
    try { stepOrders(dtH > 0 ? dtH : 0, dtReal > 0 ? dtReal : 0); } catch (e) { console.error('[rozkazy]', e); }
    try { stepDrive(dtReal > 0 ? dtReal : 0); } catch (e) { console.error('[jazda]', e); }
  });
  G.on('newGame', () => {
    G.S.drive = { uid: null, params: {} };
    DRV.uid = null; DRV.params = {}; DRV.trail = []; DRV.v = 0; DRV.unloading = null;
  });
  G.on('load', () => {
    const S = G.S;
    if (!S.drive || typeof S.drive !== 'object') S.drive = { uid: null, params: {} };
    if (!S.drive.params || typeof S.drive.params !== 'object') S.drive.params = {};
    DRV.params = Object.assign({}, S.drive.params);
    DRV.uid = null; DRV.v = 0; DRV.wheel = 0; DRV.trail = []; DRV.unloading = null; DRV.hints = [];
    const m = S.drive.uid != null ? M.get(S.drive.uid) : null;
    const pl = (S.workers || []).find(w => w.isPlayer);
    if (m && !m.attachedTo && M.isPower(def(m)) && pl && m.x != null) {
      m.order = null; m.driver = pl.uid; m.autoDriver = false; pl.drives = m.uid;
      DRV.uid = m.uid; DRV.trail = axisTrail(m); m.parked = null;
    } else S.drive.uid = null;
    // rozkazy: kierowca musi istnieć
    for (const x of S.machines) if (x.order && (x.driver == null || !(S.workers || []).some(w => w.uid === x.driver))) { x.order = null; x.autoDriver = false; }
  });
  DRV.params = {};
})();
