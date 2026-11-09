// Złote Pola — rynek ziemi: zakup i dzierżawa działek → G.land (agent: uprawy i rynek)
//
// CENY (z generatora mapy, parcel.price / parcel.rent): grunty orne ~95 tys. zł/ha (kl. I) … ~30 tys. zł/ha (kl. VI),
// łąki 60% tego; czynsz dzierżawny ~1100 zł/ha/rok (kl. I) … ~500 zł/ha (kl. VI), łąki ~450 zł/ha.
// (średnia cena gruntów ornych w PL 2025 ~70 tys. zł/ha, czynsz ~1000 zł/ha — GUS/KOWR).
// Ceny ziemi rosną co rok o 3–6%, czynsze o 2–4%.
// ZAKUP: cena oferty + ~2% (notariusz, opłaty sądowe; PCC zwolnione przy powiększaniu gospodarstwa).
//   Opcjonalnie preferencyjny kredyt ARiMR (2%, 15 lat) na max 85% ceny: G.land.buy(pid, { credit: true | kwota }).
// DZIERŻAWA: umowa na 3–10 lat, czynsz płatny w 12 ratach (co miesiąc gry, kategoria 'dzierżawa'); po wygaśnięciu
//   automatyczne przedłużenie po aktualnym czynszu. Wypowiedzenie przed terminem = odszkodowanie 25% rocznego czynszu.
// SPRZEDAŻ własnej ziemi: 95% wartości (szybka sprzedaż) − 1% kosztów.
// OFERTY: co miesiąc część ofert wygasa (działkę kupił ktoś inny), pojawiają się nowe (owner 'npc' ↔ 'market');
//   ~12% ofert to okazje (pilna sprzedaż ze spadku: −22% ceny / −20% czynszu).
(function () {
  const L = G.land = {};
  const C = G.CFG;
  const rnd = () => Math.random();
  const NOTARY = 0.02;

  function yardCenter() { const y = G.S.farm && G.S.farm.yard; return y ? { x: y.x + y.w / 2, y: y.y + y.h / 2 } : { x: C.W / 2, y: C.H / 2 }; }
  function dist(p) { const c = yardCenter(); return Math.hypot(p.cx - c.x, p.cy - c.y); }
  function makeOffer(p, kind, deal) {
    const d = G.date();
    const o = { pid: p.id, kind, deal: !!deal, until: d.dayIndex + C.DAYS_PER_MONTH * (2 + ((rnd() * 3) | 0)) + ((rnd() * 4) | 0),
      years: 3 + ((rnd() * 8) | 0) };
    o.price = Math.round(p.price * (deal ? 0.78 : 0.95 + rnd() * 0.13) / 1000) * 1000;
    o.rent = Math.round(p.rent * (deal ? 0.8 : 0.92 + rnd() * 0.16) / 10) * 10;
    return o;
  }
  function init() {
    const S = G.S.land = { offers: [], leases: {}, index: 1 };
    // generator mapy wystawia ~35% działek — zostawiamy kilka ofert (w tym 2–3 blisko gospodarstwa), resztę wracamy sąsiadom
    const mk = G.S.parcels.filter(p => p.owner === 'market').sort((a, b) => dist(a) - dist(b));
    const keep = new Set();
    mk.slice(0, 3).forEach(p => keep.add(p.id));
    const rest = mk.slice(3);
    for (let k = 0; k < 5 && rest.length; k++) keep.add(rest.splice((rnd() * rest.length) | 0, 1)[0].id);
    for (const p of mk) {
      if (!keep.has(p.id)) { p.owner = 'npc'; continue; }
      S.offers.push(makeOffer(p, rnd() < 0.5 ? 'sale' : 'lease', false));
    }
    // przynajmniej jedna dzierżawa blisko gospodarstwa (realna ścieżka rozwoju na start)
    const near = S.offers.filter(o => mk.slice(0, 3).some(p => p.id === o.pid));
    if (near.length && !near.some(o => o.kind === 'lease')) near[near.length > 1 ? 1 : 0].kind = 'lease';
  }
  const offerOf = pid => G.S.land.offers.find(o => o.pid === pid);
  function crop(p) {
    const f = G.fields && G.fields.get(p.id);
    if (!f) return '';
    const c = f.crop && G.CROPS[f.crop];
    return c ? c.name + (f.phase === 'ripe' ? ' (dojrzałe)' : ' (' + Math.round(Math.min(1, f.growth) * 100) + '%)') : (G.fields.PHASE_NAMES[f.phase] || '');
  }
  // oferty → [{ pid, name, area, landKind ('field'|'meadow'), soil, soilName, kind ('sale'|'lease'), price, pricePerHa, fee, total,
  //            rent, rentPerHa, years, until, daysLeft, deal, dist (kafle od podwórza), state (co rośnie) }]
  L.offers = function () {
    const d = G.date().dayIndex;
    return G.S.land.offers.map(o => {
      const p = G.S.parcels[o.pid];
      return { pid: o.pid, name: p.name, area: p.area, landKind: p.kind, soil: p.soilAvg, soilName: G.SOIL_NAMES[Math.max(1, Math.min(6, Math.round(p.soilAvg)))],
        kind: o.kind, price: o.price, pricePerHa: Math.round(o.price / p.area), fee: Math.round(o.price * NOTARY), total: Math.round(o.price * (1 + NOTARY)),
        rent: o.rent, rentPerHa: Math.round(o.rent / p.area), years: o.years, until: o.until, daysLeft: o.until - d, deal: o.deal,
        dist: Math.round(dist(p)), state: crop(p) };
    }).sort((a, b) => b.deal - a.deal || a.dist - b.dist);
  };
  // dzierżawy gracza → [{ pid, name, area, rent, until (rok), since }]
  L.leases = function () {
    const S = G.S.land;
    return Object.keys(S.leases).map(k => { const l = S.leases[k], p = G.S.parcels[+k]; return { pid: +k, name: p.name, area: p.area, rent: l.rent, monthly: Math.round(l.rent / 12), until: l.until, since: l.since }; });
  };
  L.value = function () { return G.playerParcels().filter(p => !p.leased).reduce((a, p) => a + p.price, 0); };
  L.area = function () { let own = 0, lease = 0; for (const p of G.playerParcels()) { if (p.leased) lease += p.area; else own += p.area; } return { own, lease, total: own + lease }; };

  // zakup: buy(pid, { credit: true | kwota }) → { ok, reason?, cost, loan? }
  L.buy = function (pid, opts) {
    opts = opts || {};
    const S = G.S.land, p = G.S.parcels[pid];
    if (!p) return { ok: false, reason: 'Brak działki' };
    let o = offerOf(pid), price;
    if (p.owner === 'player' && p.leased) price = Math.round(p.price / 1000) * 1000;          // wykup dzierżawionej (prawo pierwokupu)
    else if (o && o.kind === 'sale' && p.owner === 'market') price = o.price;
    else return { ok: false, reason: 'Ta działka nie jest na sprzedaż' };
    const fee = Math.round(price * NOTARY), total = price + fee;
    let loanAmt = 0;
    if (opts.credit) loanAmt = Math.min(Math.round(price * 0.85), opts.credit === true ? Math.round(price * 0.85) : Math.round(+opts.credit));
    if (!G.finance.canAfford(total - loanAmt)) return { ok: false, reason: 'Brak środków: potrzeba ' + G.fmtMoney(total - loanAmt) + (loanAmt ? ' (wkład własny + opłaty)' : '') };
    let loan = null;
    if (loanAmt > 0) {
      if (!G.market || !G.market.takeLoan) return { ok: false, reason: 'Kredyt niedostępny' };
      const r = G.market.takeLoan('ziemia', loanAmt, p.name, { land: true });
      if (!r.ok) return { ok: false, reason: r.reason };
      loan = r.loan;
    }
    if (!G.finance.spend(total, 'ziemia', 'Zakup: ' + p.name + ' (' + G.fmtNum(p.area) + ' ha) + notariusz')) return { ok: false, reason: 'Brak środków' };
    const wasLeased = p.leased;
    p.owner = 'player'; p.leased = false;
    delete S.leases[pid];
    S.offers = S.offers.filter(x => x.pid !== pid);
    G.notify('🏡 Kupiono ' + p.name + ' — ' + G.fmtNum(p.area) + ' ha za ' + G.fmtMoney(price), 'good', { parcel: pid });
    if (!wasLeased) G.emit('landBought', p);
    G.emit('bought', 'land', p);
    return { ok: true, cost: total, loan };
  };
  // dzierżawa: lease(pid) → { ok, reason? }
  L.lease = function (pid) {
    const S = G.S.land, p = G.S.parcels[pid], o = offerOf(pid);
    if (!p || !o || o.kind !== 'lease' || p.owner !== 'market') return { ok: false, reason: 'Ta działka nie jest do dzierżawy' };
    const first = Math.round(o.rent / 12);
    if (!G.finance.spend(first, 'dzierżawa', 'Dzierżawa: ' + p.name + ' — 1. rata')) return { ok: false, reason: 'Brak środków na pierwszą ratę (' + G.fmtMoney(first) + ')' };
    p.owner = 'player'; p.leased = true;
    S.leases[pid] = { rent: o.rent, until: G.date().year + o.years, since: G.date().year };
    S.offers = S.offers.filter(x => x.pid !== pid);
    G.notify('📝 Dzierżawa: ' + p.name + ' (' + G.fmtNum(p.area) + ' ha) na ' + o.years + ' lat, ' + G.fmtMoney(o.rent) + '/rok', 'good', { parcel: pid });
    G.emit('landBought', p);
    return { ok: true };
  };
  // rozwiązanie dzierżawy → { ok, reason?, penalty }
  L.endLease = function (pid) {
    const S = G.S.land, p = G.S.parcels[pid], l = S.leases[pid];
    if (!p || !p.leased || p.owner !== 'player' || !l) return { ok: false, reason: 'To nie jest Twoja dzierżawa' };
    const early = G.date().year < l.until, pen = early ? Math.round(l.rent * 0.25) : 0;
    if (pen) G.finance.spend(pen, 'dzierżawa', 'Odszkodowanie za wcześniejsze rozwiązanie dzierżawy: ' + p.name, true);
    p.owner = 'npc'; p.leased = false;
    delete S.leases[pid];
    G.notify('📄 Rozwiązano dzierżawę: ' + p.name + (pen ? ' (odszkodowanie ' + G.fmtMoney(pen) + ')' : ''), 'info', { parcel: pid });
    G.emit('landSold', p);
    return { ok: true, penalty: pen };
  };
  // sprzedaż własnej działki → { ok, reason?, amount }
  L.sell = function (pid) {
    const p = G.S.parcels[pid];
    if (!p || p.owner !== 'player' || p.leased) return { ok: false, reason: 'Możesz sprzedać tylko własną (nie dzierżawioną) działkę' };
    if (G.playerParcels().length <= 1) return { ok: false, reason: 'To Twoja ostatnia działka' };
    const amount = Math.round(p.price * 0.95 * 0.99);
    p.owner = 'npc'; p.leased = false;
    G.finance.earn(amount, 'ziemia', 'Sprzedaż: ' + p.name + ' (' + G.fmtNum(p.area) + ' ha)');
    G.notify('💰 Sprzedano ' + p.name + ' za ' + G.fmtMoney(amount), 'money', { parcel: pid });
    G.emit('landSold', p);
    return { ok: true, amount };
  };
  L.sellQuote = function (pid) { const p = G.S.parcels[pid]; return p ? Math.round(p.price * 0.95 * 0.99) : 0; };

  function monthly(d) {
    const S = G.S.land;
    // raty dzierżawy
    for (const k in S.leases) {
      const l = S.leases[k], p = G.S.parcels[+k];
      if (!p || p.owner !== 'player') { delete S.leases[k]; continue; }
      G.finance.spend(Math.round(l.rent / 12), 'dzierżawa', 'Dzierżawa: ' + p.name, true);
      if (d.month === 0 && d.year >= l.until) {
        l.rent = Math.round(p.rent / 10) * 10; l.until = d.year + 3 + ((rnd() * 4) | 0);
        G.notify('📝 Przedłużono dzierżawę ' + p.name + ' do ' + l.until + ' r., czynsz ' + G.fmtMoney(l.rent) + '/rok', 'info', { parcel: p.id });
      }
    }
    // wygasające oferty → działkę kupił/wydzierżawił ktoś inny
    S.offers = S.offers.filter(o => {
      if (o.until > d.dayIndex) return true;
      const p = G.S.parcels[o.pid]; if (p && p.owner === 'market') p.owner = 'npc';
      return false;
    });
    // nowe oferty (utrzymujemy 5–9 ofert)
    const npc = G.S.parcels.filter(p => p.owner === 'npc');
    let add = Math.max(0, 6 - S.offers.length) + (rnd() < 0.6 ? 1 : 0);
    while (add-- > 0 && npc.length) {
      const p = npc.splice((rnd() * npc.length) | 0, 1)[0];
      const deal = rnd() < 0.12;
      p.owner = 'market';
      const o = makeOffer(p, rnd() < 0.5 ? 'sale' : 'lease', deal);
      S.offers.push(o);
      if (deal) G.notify('🔥 Okazja na rynku ziemi: ' + p.name + ' (' + G.fmtNum(p.area) + ' ha) — ' + (o.kind === 'sale' ? 'sprzedaż ' + G.fmtMoney(o.price) : 'dzierżawa ' + G.fmtMoney(o.rent) + '/rok'), 'info', { parcel: p.id, key: 'deal' + p.id });
    }
  }
  function yearly() {
    const S = G.S.land, g = 1.03 + rnd() * 0.03, gr = 1.02 + rnd() * 0.02;
    S.index = Math.round(S.index * g * 1000) / 1000;
    for (const p of G.S.parcels) { p.price = Math.round(p.price * g / 100) * 100; p.rent = Math.round(p.rent * gr); }
  }
  L.advice = function () {
    const out = [];
    for (const o of L.offers()) {
      if (o.deal) out.push({ key: 'landdeal' + o.pid, pid: o.pid, icon: '🔥', title: 'Okazja: ' + o.name + ' (' + G.fmtNum(o.area) + ' ha, kl. ' + o.soilName + ')',
        text: o.kind === 'sale' ? 'Sprzedaż za ' + G.fmtMoney(o.price) + ' (' + G.fmtMoney(o.pricePerHa) + '/ha) — taniej niż rynek. Kredyt ARiMR 2% na 85% ceny.' : 'Dzierżawa ' + G.fmtMoney(o.rentPerHa) + '/ha/rok na ' + o.years + ' lat.',
        priority: 2, action: 'land' });
    }
    return out;
  };

  G.on('newGame', init);
  G.on('load', () => {
    const S = G.S.land;
    if (!S || !Array.isArray(S.offers)) { init(); return; }
    if (!S.leases) S.leases = {};
    if (!S.index) S.index = 1;
    // spójność: oferta tylko dla działek 'market'
    S.offers = S.offers.filter(o => G.S.parcels[o.pid] && G.S.parcels[o.pid].owner === 'market');
    for (const p of G.S.parcels) if (p.owner === 'market' && !offerOf(p.id)) S.offers.push(makeOffer(p, 'sale', false));
    for (const p of G.S.parcels) if (p.owner === 'player' && p.leased && !S.leases[p.id]) S.leases[p.id] = { rent: p.rent, until: G.date().year + 3, since: G.date().year };
  });
  G.on('monthly', monthly);
  G.on('yearly', yearly);
})();
