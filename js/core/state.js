// Złote Pola — stan gry, zdarzenia, kalendarz, finanse i magazyn (wspólny rdzeń)
(function () {
  const C = G.CFG;

  // ---------- zdarzenia wewnętrzne ----------
  // Rdzeń: 'tick' (godzina), 'daily', 'monthly', 'yearly', 'frame'(dtH, now, dtReal), 'newGame', 'load', 'notify', 'money', 'inventory'
  G._hooks = {};
  G.on = function (name, fn) { (G._hooks[name] = G._hooks[name] || []).push(fn); };
  G.emit = function (name, a, b, c) {
    const list = G._hooks[name];
    if (!list) return;
    for (const fn of list) { try { fn(a, b, c); } catch (e) { console.error('[hook ' + name + ']', e); } }
  };

  // ---------- losowość z ziarnem (powtarzalna mapa) ----------
  G.rng = function (seed) {
    let a = seed | 0;
    return function () {
      a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  };

  // ---------- kalendarz ----------
  // tick → { hour, dayIndex (od startu), dom (1..DAYS_PER_MONTH), month (0..11), year, season, doy (dzień roku 0..71), frac (pora roku 0..1) }
  G.date = function (tick) {
    tick = tick == null ? G.S.tick : tick;
    const dayIndex = Math.floor(tick / C.TICKS_PER_DAY);
    const mAbs = C.START_MONTH + Math.floor(dayIndex / C.DAYS_PER_MONTH);
    const month = mAbs % 12;
    const dom = dayIndex % C.DAYS_PER_MONTH + 1;
    return {
      hour: tick % C.TICKS_PER_DAY, dayIndex, dom, month, year: C.START_YEAR + Math.floor(mAbs / 12),
      season: G.SEASON_OF[month], doy: month * C.DAYS_PER_MONTH + dom - 1,
      frac: (month * C.DAYS_PER_MONTH + dom - 1) / (12 * C.DAYS_PER_MONTH)
    };
  };
  G.dateText = function (tick) {
    const d = G.date(tick);
    return d.dom + ' ' + G.MONTHS_GEN[d.month] + ' ' + d.year;
  };
  G.DAYS_PER_YEAR = 12 * C.DAYS_PER_MONTH;

  // ---------- domyślny stan ----------
  // Każdy moduł trzyma swój stan w G.S.<klucz> zainicjowanym w hooku 'newGame' i sprawdzanym w 'load'.
  // Klucze modułów: fields, market, weather, animals, buildings, machines, workers, jobs, ui, progress
  G.defaultState = function (seed) {
    return {
      v: G.SAVE_VERSION, seed, tick: 0,
      money: C.START_MONEY,
      ledger: [],          // ostatnie operacje: { t: tick, amt, cat, note }
      daily: [],           // historia dzienna: { d, money, income, expense }
      today: { income: 0, expense: 0, byCat: {} },
      inv: {},             // magazyn: { produktId: ilość }
      map: null,           // { t: [], soil: [], parcel: [], v: [] } — tablice W*H
      parcels: [],         // działki
      farm: null,          // { yard: {x,y,w,h}, name }
      nextId: 1
    };
  };

  // ---------- finanse ----------
  // Wszystkie przepływy pieniędzy przechodzą tędy — dzięki temu księga i raporty się zgadzają.
  // Kategorie (używaj tych nazw): 'sprzedaż', 'dopłaty', 'usługi', 'zakup maszyn', 'serwis', 'paliwo', 'nasiona',
  // 'nawozy', 'środki ochrony', 'pasze', 'zwierzęta', 'budowa', 'płace', 'ziemia', 'dzierżawa', 'kredyt', 'odsetki', 'wynajem', 'inne'
  G.finance = {
    canAfford(amt) { return G.S.money >= amt; },
    spend(amt, cat, note, force) {
      amt = Math.round(amt * 100) / 100;
      if (amt <= 0) return true;
      if (!force && G.S.money < amt) { G.notify('💸 Brak środków: potrzeba ' + G.fmtMoney(amt), 'bad'); return false; }
      G.S.money -= amt;
      log(-amt, cat, note);
      return true;
    },
    earn(amt, cat, note) {
      amt = Math.round(amt * 100) / 100;
      if (amt <= 0) return;
      G.S.money += amt;
      log(amt, cat, note);
    }
  };
  function log(amt, cat, note) {
    const S = G.S;
    S.ledger.unshift({ t: S.tick, amt, cat: cat || 'inne', note: note || '' });
    if (S.ledger.length > 200) S.ledger.length = 200;
    if (amt > 0) S.today.income += amt; else S.today.expense -= amt;
    S.today.byCat[cat || 'inne'] = (S.today.byCat[cat || 'inne'] || 0) + amt;
    G.emit('money', amt, cat);
  }

  // ---------- magazyn ----------
  // Pojemność zapewnia moduł budynków: G.inv.capacityFn = (produktId) => maks. ilość (Infinity, jeśli brak limitu)
  G.inv = {
    capacityFn: null,
    get(id) { return G.S.inv[id] || 0; },
    capacity(id) { return G.inv.capacityFn ? G.inv.capacityFn(id) : Infinity; },
    free(id) { return Math.max(0, G.inv.capacity(id) - G.inv.get(id)); },
    // dodaje tyle, ile się zmieści; zwraca ilość faktycznie dodaną
    add(id, qty) {
      if (!(qty > 0)) return 0;
      const q = Math.min(qty, G.inv.free(id));
      G.S.inv[id] = Math.round((G.inv.get(id) + q) * 1000) / 1000;
      if (q < qty) G.notify('📦 Brak miejsca w magazynie: ' + ((G.PRODUCTS[id] && G.PRODUCTS[id].name) || id), 'bad', { key: 'full_' + id });
      G.emit('inventory', id, q);
      return q;
    },
    // zabiera, jeśli jest dość; zwraca true/false
    take(id, qty) {
      if (!(qty > 0)) return true;
      if (G.inv.get(id) + 1e-9 < qty) return false;
      G.S.inv[id] = Math.round((G.inv.get(id) - qty) * 1000) / 1000;
      if (G.S.inv[id] <= 0) delete G.S.inv[id];
      G.emit('inventory', id, -qty);
      return true;
    }
  };

  // ---------- powiadomienia ----------
  // kind: 'info' | 'good' | 'bad' | 'money' | 'warn'; opts: { key (bez duplikatów), tile, parcel, action }
  G.notify = function (text, kind, opts) { G.emit('notify', { text, kind: kind || 'info', opts: opts || {}, t: G.S ? G.S.tick : 0 }); };

  // ---------- formatowanie ----------
  G.fmtMoney = v => (Math.round(v)).toLocaleString('pl-PL') + ' zł';
  G.fmtNum = (v, d) => Number(v).toLocaleString('pl-PL', { maximumFractionDigits: d == null ? 1 : d });
  G.fmtQty = function (id, q) {
    const p = G.PRODUCTS[id];
    const u = p ? p.unit : '';
    return G.fmtNum(q, u === 'szt' || u === 'bela' ? 0 : 2) + ' ' + u;
  };
  G.uid = () => G.S.nextId++;

  // ---------- nowa gra ----------
  G.newGame = function (seed) {
    seed = seed || ((Math.random() * 1e9) | 0);
    G.S = G.defaultState(seed);
    G.mapgen.generate(G.S, seed);     // mapa, działki, podwórze gospodarstwa
    G.emit('newGame');                // moduły: start (budynki dziadka, stary ciągnik, kury, ozimina...)
    G.emit('load');                   // wspólna walidacja/odbudowa pamięci podręcznej
  };

  // ---------- pętla czasu ----------
  // Wołane przez loop.js: tick() co godzinę gry
  G.tick = function () {
    const S = G.S;
    S.tick++;
    G.emit('tick');
    if (S.tick % C.TICKS_PER_DAY === 0) {
      const d = G.date();
      G.emit('daily', d);
      S.daily.push({ d: d.dayIndex, money: Math.round(S.money), income: Math.round(S.today.income), expense: Math.round(S.today.expense) });
      if (S.daily.length > 400) S.daily.splice(0, S.daily.length - 400);
      S.today = { income: 0, expense: 0, byCat: {} };
      if (d.dom === 1) {
        G.emit('monthly', d);
        if (d.month === 0) G.emit('yearly', d);
      }
      if (G.storage) G.storage.save('auto');
    }
  };
})();
