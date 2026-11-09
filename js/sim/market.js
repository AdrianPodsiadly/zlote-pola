// Złote Pola — ceny, skup, sklep, kontrakty, dopłaty, kredyty → G.market (agent: uprawy i rynek)
//
// CENY: cena(dzień) = base × trend grupy × trend produktu × sezonowość(miesiąc) × szok rocznika × (1 + szum dzienny)
//   - trend: proces powracający do średniej (log), zmienność z PRODUCTS[id].vol (pszenica ±15% w skali roku);
//   - sezonowość: zboża najtańsze w żniwa (VII–VIII, ok. −8%), najdroższe na przednówku (IV–V, +7%);
//     ziemniaki tanie jesienią, drogie wiosną (±30%); siano/słoma drogie zimą; nawozy drożeją przed sezonem (II–III);
//   - szok rocznika: co roku 1 sierpnia nowy „rocznik” (dobre/złe zbiory na świecie) ±(vol × 25%);
//   - sprzedaż dużych partii obniża lokalnie cenę (max −5%, odrabia się w kilka dni).
// SKLEP vs SKUP: środki produkcji (PRODUCTS.shop) kupujemy po cenie bieżącej, odsprzedaż = 60%;
//   płody rolne sprzedajemy do skupu po cenie bieżącej, a kupić (np. paszę) można za +15%.
// JAKOŚĆ PARTII: magazyn trzyma średnią ważoną jakości q (0..1) per produkt — G.S.market.quality[id] = { q, qty }.
//   Pola zgłaszają partię przy starcie zbioru (G.market.noteHarvest(id, qty, q)); każdy przyrost magazynu (hook
//   'inventory') bierze jakość z oczekującej partii, a zakupy ze sklepu mają jakość standardową (0,7).
//   Klasy (G.GRADES w data/crops.js): price(id) = cena referencyjna (klasa bazowa, factor 1), price(id, q | klasa) =
//   cena dla jakości; stockPrice(id) = cena za to, co leży w magazynie; sell() płaci wg stockPrice.
//   Umowy: dostawa partii gorszej niż klasa bazowa jest potrącana (× factor), lepsza nie podnosi ceny umownej.
// DOPŁATY (grudzień, stawki przybliżone 2025, warunki uproszczone): podstawowa 490 zł/ha, redystrybucyjna 175 zł/ha
//   (1–30 ha), młody rolnik 225 zł/ha (do 50 ha, pierwsze 5 lat), ekoschematy: zróżnicowana struktura upraw 180 zł/ha
//   (≥ 3 uprawy w czerwcu, główna ≤ 65%), wapnowanie (plan nawożenia z wapnowaniem) 150 zł/ha, obornik przyorany
//   w 12 h 200 zł/ha, wymieszanie słomy z glebą 100 zł/ha, uproszczone systemy uprawy 230 zł/ha, TUZ z obsadą zwierząt 330 zł/ha.
// PODATKI I SKŁADKI: podatek rolny raz w roku (marzec) = ha przeliczeniowe × 2,5 dt żyta × 65 zł/dt (tylko grunty własne);
//   KRUS 750 zł na kwartał (styczeń, kwiecień, lipiec, październik).
// KREDYTY: raty annuitetowe co miesiąc gry (kategorie 'kredyt' = kapitał, 'odsetki'); ujemne saldo = debet 1,2%/mies.
//   Start: „kredyt po dziadku” 25 000 zł, 4%, 48 rat (~565 zł/mies., ~6,8 tys. zł/rok).
(function () {
  const M = G.market = {};
  const C = G.CFG;
  const rnd = () => Math.random();
  function gauss() { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const HIST = 72;                // dni historii (1 rok gry)

  // ---------- sezonowość (mnożnik wg miesiąca 0..11) ----------
  const SEASON = {
    zboże:     [1.03, 1.04, 1.05, 1.06, 1.07, 1.03, 0.94, 0.92, 0.95, 0.98, 1.00, 1.02],
    kukurydza: [1.00, 1.02, 1.03, 1.04, 1.05, 1.06, 1.05, 1.03, 1.00, 0.92, 0.92, 0.97],
    rzepak:    [1.03, 1.04, 1.04, 1.05, 1.05, 1.00, 0.93, 0.94, 0.98, 1.00, 1.01, 1.02],
    ziemniaki: [1.10, 1.15, 1.20, 1.28, 1.32, 1.18, 0.95, 0.86, 0.80, 0.82, 0.90, 1.00],
    pasza:     [1.15, 1.20, 1.20, 1.14, 1.00, 0.85, 0.85, 0.90, 0.95, 1.00, 1.05, 1.10],
    kiszonka:  [1.10, 1.14, 1.15, 1.10, 1.05, 1.00, 0.95, 0.90, 0.85, 0.90, 1.00, 1.05],
    nawozy:    [1.03, 1.06, 1.06, 1.04, 1.00, 0.96, 0.95, 0.96, 0.98, 1.00, 1.00, 1.01],
    nasiona_j: [1.04, 1.06, 1.06, 1.04, 1.00, 1.00, 1.00, 1.00, 1.00, 1.00, 1.00, 1.02],
    nasiona_o: [1.00, 1.00, 1.00, 1.00, 1.00, 1.00, 1.02, 1.05, 1.06, 1.03, 1.00, 1.00]
  };
  function seasonKey(id) {
    const p = G.PRODUCTS[id];
    if (id === 'kukurydza') return 'kukurydza';
    if (id === 'rzepak') return 'rzepak';
    if (id === 'ziemniaki') return 'ziemniaki';
    if (id === 'kiszonka') return 'kiszonka';
    if (id === 'siano' || id === 'sianokiszonka' || id === 'sloma') return 'pasza';
    if (id === 'saletra' || id === 'npk') return 'nawozy';
    if (id === 'nasiona_pszenica' || id === 'nasiona_pszenzyto' || id === 'nasiona_zyto' || id === 'nasiona_rzepak') return 'nasiona_o';
    if (p && p.cat === 'nasiona') return 'nasiona_j';
    if (p && p.cat === 'zboże') return 'zboże';
    return null;
  }
  function groupOf(id) { const p = G.PRODUCTS[id]; return p ? (p.cat || 'inne') : 'inne'; }
  function isShop(id) { const p = G.PRODUCTS[id]; return !!(p && (p.shop || p.cat === 'nasiona' || p.cat === 'środki' || p.cat === 'paliwo')); }
  function priced(id) { const p = G.PRODUCTS[id]; return p && p.base > 0; }

  // ---------- inicjalizacja ----------
  function blankState() {
    return {
      g: {}, t: {}, shock: {}, shockT: {}, noise: {}, press: {}, cur: {}, hist: {}, histDay: -1,
      contracts: [], loans: [], nextId: 1, sub: { structure: null, year: 0, last: null }, youngUntil: C.START_YEAR + 5,
      stats: {}, lastTaxYear: 0,
      quality: {}, pending: {}
    };
  }
  function ensureProduct(S, id) {
    if (!priced(id)) return;
    const g = groupOf(id);
    if (S.g[g] == null) S.g[g] = 0;
    if (S.t[id] == null) S.t[id] = (rnd() - 0.5) * 0.06;
    if (S.shock[id] == null) S.shock[id] = 0;
    if (S.shockT[id] == null) S.shockT[id] = 0;
    if (S.noise[id] == null) S.noise[id] = 0;
    if (S.press[id] == null) S.press[id] = 0;
    if (!Array.isArray(S.hist[id])) S.hist[id] = [];
  }
  function init() {
    const S = G.S.market = blankState();
    for (const id in G.PRODUCTS) ensureProduct(S, id);
    // historia „wstecz” — symulujemy rok przed startem, żeby wykresy nie były puste
    const d0 = G.date().dayIndex;
    for (let k = -HIST; k < 0; k++) step(d0 + k, true);
    S.histDay = d0 - 1;
    computeAll(G.date().month);
    pushHist(d0);
    // kredyt po dziadku
    addLoan('dziadek', 25000, true);
    // pierwsze oferty umów
    genOffers(true);
  }
  function monthOfDay(di) { return ((C.START_MONTH + Math.floor(di / C.DAYS_PER_MONTH)) % 12 + 12) % 12; }

  // jeden dzień zmian cen; back = symulacja historii
  function step(di, back) {
    const S = G.S.market, m = monthOfDay(di), gs = {};
    for (const g in S.g) {
      // zmienność grupy wg średniej zmienności jej produktów
      let v = 0, n = 0; for (const id in G.PRODUCTS) if (groupOf(id) === g && priced(id)) { v += G.PRODUCTS[id].vol || 0.2; n++; }
      v = n ? v / n : 0.2;
      S.g[g] = S.g[g] * 0.97 + gauss() * v * 0.06;
      gs[g] = 1;
    }
    // nowy rocznik (1 sierpnia)
    if (m === 7 && ((di % C.DAYS_PER_MONTH) + C.DAYS_PER_MONTH) % C.DAYS_PER_MONTH === 0) {
      for (const id in S.shockT) S.shockT[id] = gauss() * (G.PRODUCTS[id] ? G.PRODUCTS[id].vol || 0.2 : 0.2) * 0.25;
    }
    for (const id in S.t) {
      const v = (G.PRODUCTS[id] && G.PRODUCTS[id].vol) || 0.2;
      S.t[id] = S.t[id] * 0.97 + gauss() * v * 0.035;
      S.shock[id] += (S.shockT[id] - S.shock[id]) * 0.12;
      S.noise[id] = gauss() * v * 0.012;
      S.press[id] *= 0.8;
    }
    computeAll(m);
    if (back) pushHist(di);
  }
  function computeAll(m) {
    const S = G.S.market;
    for (const id in S.t) {
      const p = G.PRODUCTS[id]; if (!priced(id)) continue;
      const sk = seasonKey(id), sea = sk ? SEASON[sk][m] : 1;
      const mult = clamp(Math.exp(S.g[groupOf(id)] + S.t[id] + S.shock[id]) * sea * (1 + S.noise[id]) * (1 - S.press[id]), 0.5, 1.9);
      const raw = p.base * mult;
      S.cur[id] = raw >= 100 ? Math.round(raw) : raw >= 10 ? Math.round(raw * 10) / 10 : Math.round(raw * 100) / 100;
    }
  }
  function pushHist(di) {
    const S = G.S.market;
    for (const id in S.cur) { const h = S.hist[id] || (S.hist[id] = []); h.push(S.cur[id]); if (h.length > HIST) h.splice(0, h.length - HIST); }
    S.histDay = di;
  }

  // ---------- jakość partii ----------
  const DEFAULT_Q = 0.7;   // jakość towaru kupionego w sklepie / nieznanego pochodzenia (klasa bazowa)
  function gradeFor(id, q) {
    if (G.fields && G.fields.gradeFor) return G.fields.gradeFor(id, q);
    return { grade: 'standard', label: 'standardowa', factor: 1 };
  }
  // zgłoszenie partii z pola (wołane przez sim/fields.js na starcie zbioru/prasowania): kolejne przyrosty magazynu
  // tego produktu dostaną tę jakość, dopóki partia się nie „wyczerpie” (lub zestarzeje — 12 dni)
  M.noteHarvest = function (id, qty, q, pid) {
    const S = G.S && G.S.market; if (!S || !(qty > 0)) return;
    if (!S.pending) S.pending = {};
    const P = S.pending[id] || (S.pending[id] = { qty: 0, qsum: 0, day: 0 });
    P.qty += qty; P.qsum += qty * clamp(q == null ? DEFAULT_Q : q, 0, 1); P.day = G.date().dayIndex;
    void pid;
  };
  function onInventory(id, dq) {
    const S = G.S && G.S.market; if (!S || !dq) return;
    if (!S.quality) S.quality = {};
    if (!S.pending) S.pending = {};
    const have = G.inv.get(id);
    if (dq < 0) {
      const Q = S.quality[id];
      if (Q) { Q.qty = Math.max(0, Math.round((Q.qty + dq) * 1000) / 1000); if (have <= 1e-9) delete S.quality[id]; }
      return;
    }
    if (!(G.PRODUCTS[id] && G.PRODUCTS[id].base > 0) || isShop(id)) return;   // środki produkcji bez klas
    let qi = DEFAULT_Q;
    const P = S.pending[id];
    if (P && P.qty > 1e-9) {
      qi = P.qsum / P.qty;
      const used = Math.min(dq, P.qty);
      P.qty -= used; P.qsum -= used * qi;
      if (P.qty <= 1e-6) delete S.pending[id];
    }
    const Q = S.quality[id] || (S.quality[id] = { q: qi, qty: 0 });
    const base = Math.min(Q.qty, Math.max(0, have - dq));   // stan sprzed przyrostu (zabezpieczenie po wczytaniu)
    Q.q = Math.round((Q.q * base + qi * dq) / (base + dq) * 1000) / 1000;
    Q.qty = Math.round((base + dq) * 1000) / 1000;
  }
  // jakość tego, co leży w magazynie → { q, grade, label, factor, qty, text }
  M.qualityOf = function (id) {
    const S = G.S && G.S.market, Q = S && S.quality && S.quality[id];
    const q = Q && G.inv.get(id) > 0 ? Q.q : DEFAULT_Q;
    const g = gradeFor(id, q), spec = G.GRADES && G.GRADES[id];
    return Object.assign({ q, qty: G.inv.get(id), graded: !!(spec && spec.grades), text: (spec && spec.grades ? 'klasa ' + g.label : 'jakość ' + Math.round(q * 100) + '%') }, g);
  };
  // lista klas dla produktu (UI) → [{ grade, label, factor, price }]
  M.grades = function (id) {
    const spec = G.GRADES && G.GRADES[id];
    if (!spec || !spec.grades) return [];
    return spec.grades.map(g => ({ grade: g.id, label: g.label, factor: g.factor, price: Math.round(M.price(id) * g.factor * 100) / 100 }));
  };
  // mnożnik ceny dla jakości: liczba 0..1 albo id klasy ('paszowa'), undefined → 1
  function qFactor(id, quality) {
    if (quality == null) return 1;
    if (typeof quality === 'string') { const spec = G.GRADES && G.GRADES[id], g = spec && spec.grades && spec.grades.find(x => x.id === quality); return g ? g.factor : 1; }
    if (typeof quality === 'object' && quality.factor != null) return quality.factor;
    return gradeFor(id, +quality).factor;
  }

  // ---------- ceny ----------
  // price(id, quality?) — cena skupu (za ile sprzedasz) dla klasy bazowej, albo dla podanej jakości (0..1 | id klasy);
  // buyPrice(id) — cena zakupu (sklep / od sąsiada); stockPrice(id) — cena za partię leżącą w magazynie
  M.price = function (id, quality) {
    const S = G.S && G.S.market, c = S && S.cur[id];
    const p = G.PRODUCTS[id];
    const f = qFactor(id, quality);
    if (c == null) return p ? Math.round(p.base * (isShop(id) ? 0.6 : f) * 100) / 100 : 0;
    const v = isShop(id) ? c * 0.6 : c * f;
    return v >= 100 ? Math.round(v) : Math.round(v * 100) / 100;
  };
  M.stockPrice = function (id) { return isShop(id) ? M.price(id) : M.price(id, M.qualityOf(id).q); };
  M.buyPrice = function (id) {
    const S = G.S && G.S.market, p = G.PRODUCTS[id];
    const c = (S && S.cur[id] != null) ? S.cur[id] : (p ? p.base : 0);
    return isShop(id) ? c : Math.round(c * 1.15 * 100) / 100;
  };
  // oczekiwana cena skupu w danym miesiącu (obecny trend × sezonowość) — do planowania upraw
  M.expectedPrice = function (id, month) {
    const sk = seasonKey(id), now = G.date().month, p = M.price(id);
    if (!sk || month == null) return p;
    return Math.round(p / SEASON[sk][now] * SEASON[sk][month] * 100) / 100;
  };
  M.canBuy = function (id) { const p = G.PRODUCTS[id]; return !!(p && priced(id) && p.buy !== false && p.cat !== 'zwierzęce'); };
  M.canSell = function (id) { const p = G.PRODUCTS[id]; return !!(p && priced(id) && p.sell !== false); };
  // historia cen skupu: [{ d (dzień gry), p }] — ostatni rok
  M.history = function (id) {
    const S = G.S.market, h = S.hist[id] || [], k0 = S.histDay - h.length + 1, shop = isShop(id);
    return h.map((v, k) => ({ d: k0 + k, p: shop ? v : v }));
  };
  // podsumowanie ceny dla UI: zmiana tygodniowa (6 dni) i względem bazowej
  M.info = function (id) {
    const S = G.S.market, h = S.hist[id] || [], p = G.PRODUCTS[id];
    const now = S.cur[id] != null ? S.cur[id] : (p ? p.base : 0), wk = h.length > 6 ? h[h.length - 7] : now;
    const sk = seasonKey(id), m = G.date().month;
    let hint = '';
    if (sk && SEASON[sk]) {
      const arr = SEASON[sk], best = arr.indexOf(Math.max.apply(null, arr)), worst = arr.indexOf(Math.min.apply(null, arr));
      hint = 'zwykle najdrożej: ' + G.MONTHS[best] + ', najtaniej: ' + G.MONTHS[worst];
      void m;
    }
    const q = isShop(id) ? null : M.qualityOf(id);
    return { id, name: p ? p.name : id, unit: p ? p.unit : '', icon: p ? p.icon : '', price: M.price(id), buy: M.buyPrice(id), base: p ? p.base : 0,
      change: wk ? Math.round((now / wk - 1) * 1000) / 10 : 0, vsBase: p && p.base ? Math.round((now / p.base - 1) * 1000) / 10 : 0, have: G.inv.get(id), hint,
      // jakość partii w magazynie i cena, jaką za nią dostaniesz (różni się od price, gdy klasa ≠ bazowa)
      quality: q, stockPrice: q ? M.stockPrice(id) : M.price(id), grades: M.grades(id) };
  };
  // lista produktów do ekranu rynku: [{...info, cat, canBuy, canSell}]
  M.list = function (filter) {
    const out = [];
    for (const id in G.PRODUCTS) {
      if (!priced(id)) continue;
      const p = G.PRODUCTS[id];
      if (filter && filter !== p.cat) continue;
      out.push(Object.assign(M.info(id), { cat: p.cat, canBuy: M.canBuy(id), canSell: M.canSell(id) }));
    }
    return out;
  };

  // ---------- sprzedaż i zakup ----------
  // sell(id, qty) → zł (0, jeśli nic nie sprzedano). Ilość ograniczona do stanu magazynu.
  M.sell = function (id, qty) {
    if (!M.canSell(id)) return 0;
    qty = Math.min(+qty || 0, G.inv.get(id));
    const p = G.PRODUCTS[id];
    if (p.unit === 'bela' || p.unit === 'szt') qty = Math.floor(qty + 1e-9);
    if (!(qty > 0)) return 0;
    const qi = M.qualityOf(id), price = M.stockPrice(id), total = Math.round(price * qty * 100) / 100;
    if (!G.inv.take(id, qty)) return 0;
    G.finance.earn(total, 'sprzedaż', 'Sprzedaż: ' + G.fmtQty(id, qty) + ' ' + p.name.toLowerCase() + (qi.graded ? ' (' + qi.label + ')' : '') + ' po ' + G.fmtNum(price, 2) + ' zł/' + p.unit);
    // presja podaży na lokalny skup (duże partie)
    const S = G.S.market, big = p.unit === 't' ? qty / 400 : qty / 4000;
    S.press[id] = clamp((S.press[id] || 0) + big * 0.05, 0, 0.05);
    computeAll(G.date().month);
    stat('sales', total);
    G.emit('sold', id, qty, total);
    return total;
  };
  function spendCat(id) {
    const p = G.PRODUCTS[id];
    if (!p) return 'inne';
    if (p.cat === 'nasiona') return 'nasiona';
    if (id === 'herbicyd' || id === 'fungicyd' || id === 'insektycyd') return 'środki ochrony';
    if (id === 'saletra' || id === 'npk' || id === 'wapno' || id === 'obornik' || id === 'gnojowica') return 'nawozy';
    if (p.cat === 'paliwo') return 'paliwo';
    if (p.cat === 'pasza' || p.feed || p.cat === 'zboże') return 'pasze';
    return 'inne';
  }
  // buy(id, qty) → true/false (brak środków / miejsca → false + komunikat)
  M.buy = function (id, qty) {
    if (!M.canBuy(id)) return false;
    qty = +qty || 0;
    const p = G.PRODUCTS[id];
    if (p.unit === 'bela' || p.unit === 'szt') qty = Math.ceil(qty - 1e-9);
    if (!(qty > 0)) return false;
    if (G.inv.free(id) + 1e-9 < qty) { G.notify('📦 Brak miejsca w magazynie na ' + p.name.toLowerCase(), 'bad', { key: 'nospace' }); return false; }
    const price = M.buyPrice(id), total = Math.round(price * qty * 100) / 100;
    if (!G.finance.spend(total, spendCat(id), 'Zakup: ' + G.fmtQty(id, qty) + ' ' + p.name.toLowerCase())) return false;
    G.inv.add(id, qty);
    stat('buys', total);
    G.emit('bought', 'product', { id, qty, total });
    return true;
  };
  function stat(k, v) {
    const S = G.S.market, y = G.date().year;
    const s = S.stats[y] || (S.stats[y] = { sales: 0, buys: 0, subsidies: 0, interest: 0, penalties: 0, contracts: 0 });
    s[k] = Math.round((s[k] || 0) + v);
  }
  M.yearStats = function (y) { return (G.S.market.stats || {})[y || G.date().year] || { sales: 0, buys: 0, subsidies: 0, interest: 0, penalties: 0, contracts: 0 }; };

  // ---------- kalendarz pomocniczo ----------
  function dayIndexOf(year, month, dom) { return ((year - C.START_YEAR) * 12 + month - C.START_MONTH) * C.DAYS_PER_MONTH + (dom - 1); }
  M.dayIndexOf = dayIndexOf;
  function dayText(di) { return G.dateText(di * C.TICKS_PER_DAY); }

  // ---------- KONTRAKTY ----------
  // Szablony ofert: w których miesiącach się pojawiają, termin dostawy (miesiąc), premia cenowa, wielkość partii
  const BUYERS = {
    pszenica: 'Skup zbóż „Złoty Kłos”', rzepak: 'Olejarnia „Mazowiecki Olej”', jeczmien: 'Słodownia „Jasny Słód”', kukurydza: 'Suszarnia „Kukurydza-Pol”',
    buraki: 'Cukrownia „Biały Kryształ”', ziemniaki: 'Przetwórnia „Chrupek” (frytki)', kiszonka: 'Biogazownia „Zielona Moc”',
    siano: 'Sąsiad hodowca — pan Zdzisław', sianokiszonka: 'Gospodarstwo mleczne Nowakowie', sloma: 'Pieczarkarnia „Grzybek”', pszenzyto: 'Wytwórnia pasz „Pasz-Mix”', zyto: 'Gorzelnia „Żytnia”', owies: 'Stadnina koni „Pod Lipami”'
  };
  const TPL = [
    { id: 'pszenica', months: [0, 1, 2, 3, 4, 9, 10, 11], dueM: 7, prem: [1.05, 1.12], t: 'crop' },
    { id: 'rzepak', months: [0, 1, 2, 3, 9, 10, 11], dueM: 6, prem: [1.04, 1.1], t: 'crop' },
    { id: 'jeczmien', months: [0, 1, 2, 3], dueM: 7, prem: [1.08, 1.15], t: 'crop', note: 'jęczmień browarny' },
    { id: 'pszenzyto', months: [1, 2, 3, 4, 5], dueM: 8, prem: [1.04, 1.1], t: 'crop' },
    { id: 'zyto', months: [2, 3, 4, 5], dueM: 8, prem: [1.05, 1.12], t: 'crop' },
    { id: 'kukurydza', months: [3, 4, 5, 6, 7, 8], dueM: 10, prem: [1.04, 1.1], t: 'crop' },
    { id: 'buraki', months: [0, 1, 2], dueM: 10, fixed: 190, t: 'crop', note: 'umowa kontraktacyjna z cukrownią' },
    { id: 'ziemniaki', months: [1, 2, 3], dueM: 9, prem: [0.95, 1.08], t: 'crop' },
    { id: 'kiszonka', months: [4, 5, 6, 7], dueM: 10, prem: [1.05, 1.15], t: 'crop' },
    { id: 'siano', months: [0, 1, 2, 3, 6, 7, 8, 9, 10, 11], dueIn: 2, prem: [1.08, 1.2], t: 'bale' },
    { id: 'sianokiszonka', months: [5, 6, 7, 8, 9, 10], dueIn: 2, prem: [1.05, 1.15], t: 'bale' },
    { id: 'sloma', months: [6, 7, 8, 9, 10, 11, 0], dueIn: 2, prem: [1.1, 1.25], t: 'bale' }
  ];
  function playerHa() { let a = 0, f = 0; for (const p of G.playerParcels()) { a += p.area; if (p.kind === 'field') f += p.area; } return { all: a, field: f }; }
  function genOffers(first) {
    const S = G.S.market, d = G.date();
    // usuń przeterminowane oferty
    S.contracts = S.contracts.filter(c => !(c.status === 'offer' && c.expires < d.dayIndex));
    const offers = S.contracts.filter(c => c.status === 'offer').length;
    const want = (first ? 3 : 1 + ((rnd() * 2) | 0)) - Math.max(0, offers - 2);
    const ha = playerHa();
    const pool = TPL.filter(t => t.months.indexOf(d.month) >= 0 && !S.contracts.some(c => c.product === t.id && (c.status === 'offer' || c.status === 'active')));
    for (let k = 0; k < want && pool.length; k++) {
      const t = pool.splice((rnd() * pool.length) | 0, 1)[0];
      const p = G.PRODUCTS[t.id];
      let due;
      if (t.dueIn) { const mm = d.month + t.dueIn; due = dayIndexOf(d.year + Math.floor(mm / 12), mm % 12, C.DAYS_PER_MONTH); }
      else due = dayIndexOf(d.year + (t.dueM < d.month ? 1 : 0), t.dueM, C.DAYS_PER_MONTH);
      // cena: oczekiwana cena w miesiącu dostawy × premia (albo stała, np. buraki)
      const dm = monthOfDay(due), sk = seasonKey(t.id);
      const exp = p.base * Math.exp(S.g[groupOf(t.id)] * 0.5 + S.t[t.id] * 0.5) * (sk ? SEASON[sk][dm] : 1);
      const price = t.fixed ? t.fixed : Math.round(exp * (t.prem[0] + rnd() * (t.prem[1] - t.prem[0])) * (p.unit === 't' ? 1 : 10)) / (p.unit === 't' ? 1 : 10);
      let qty;
      if (t.t === 'bale') qty = 10 * Math.max(2, Math.round((2 + rnd() * 6) * Math.max(1, ha.all / 15)));
      else {
        const c = G.CROPS[t.id];
        const raw = Math.max(5, ha.field * (c ? c.yieldBase : 5) * (0.12 + rnd() * 0.25));
        qty = raw > 40 ? Math.round(raw / 10) * 10 : Math.round(raw / 5) * 5;
      }
      S.contracts.push({
        id: S.nextId++, product: t.id, qty, price, due, buyer: BUYERS[t.id] || 'Skup', note: t.note || '',
        penaltyRate: 0.15, status: 'offer', delivered: 0, expires: d.dayIndex + C.DAYS_PER_MONTH * 1 + 2, created: d.dayIndex
      });
    }
  }
  function cview(c) {
    const p = G.PRODUCTS[c.product], d = G.date().dayIndex;
    return Object.assign({}, c, {
      productName: p ? p.name : c.product, unit: p ? p.unit : '', icon: p ? p.icon : '', value: Math.round(c.qty * c.price),
      remaining: Math.max(0, Math.round((c.qty - c.delivered) * 1000) / 1000), dueText: dayText(c.due), daysLeft: c.due - d,
      have: G.inv.get(c.product), penalty: Math.round((c.qty - c.delivered) * c.price * c.penaltyRate),
      marketPrice: M.price(c.product), text: (p ? p.name : c.product) + ': ' + G.fmtQty(c.product, c.qty) + ' po ' + G.fmtNum(c.price, 2) + ' zł/' + (p ? p.unit : '') + ' do ' + dayText(c.due)
    });
  }
  // lista umów: oferty, aktywne i ostatnie zakończone → [{ id, product, qty, price, due, dueText, daysLeft, status, delivered, remaining, have, penalty, buyer, text, ... }]
  M.contracts = function () {
    const S = G.S.market;
    return S.contracts.map(cview).sort((a, b) => ({ active: 0, offer: 1 }[a.status] ?? 2) - ({ active: 0, offer: 1 }[b.status] ?? 2) || a.due - b.due);
  };
  M.accept = function (cid) {
    const S = G.S.market, c = S.contracts.find(x => x.id === cid);
    if (!c || c.status !== 'offer') return { ok: false, reason: 'Oferta nieaktualna' };
    if (S.contracts.filter(x => x.status === 'active').length >= 5) return { ok: false, reason: 'Masz już 5 aktywnych umów' };
    c.status = 'active'; c.accepted = G.date().dayIndex;
    G.notify('✍️ Podpisano umowę: ' + cview(c).text, 'good');
    return { ok: true, contract: cview(c) };
  };
  M.decline = function (cid) {
    const S = G.S.market, k = S.contracts.findIndex(x => x.id === cid && x.status === 'offer');
    if (k < 0) return false;
    S.contracts.splice(k, 1); return true;
  };
  // dostawa w ramach umowy (z magazynu) → zł
  M.deliver = function (cid, qty) {
    const S = G.S.market, c = S.contracts.find(x => x.id === cid);
    if (!c || c.status !== 'active') return 0;
    const rem = c.qty - c.delivered;
    let q = Math.min(qty == null ? rem : +qty, rem, G.inv.get(c.product));
    const p = G.PRODUCTS[c.product];
    if (p.unit === 'bela' || p.unit === 'szt') q = Math.floor(q + 1e-9);
    const qi = M.qualityOf(c.product);
    if (!(q > 0) || !G.inv.take(c.product, q)) return 0;
    // partia gorsza niż klasa bazowa → potrącenie wg klasy (lepsza nie podnosi ceny umownej)
    const unit = Math.round(c.price * Math.min(1, qi.factor) * 100) / 100, total = Math.round(q * unit * 100) / 100;
    c.delivered = Math.round((c.delivered + q) * 1000) / 1000;
    G.finance.earn(total, 'sprzedaż', 'Umowa (' + c.buyer + '): ' + G.fmtQty(c.product, q) + ' po ' + G.fmtNum(unit, 2) + ' zł' + (qi.factor < 1 ? ' (potrącenie: ' + qi.label + ')' : ''));
    stat('sales', total); stat('contracts', total);
    G.emit('sold', c.product, q, total);
    if (c.delivered >= c.qty - 1e-6) { c.status = 'done'; c.closed = G.date().dayIndex; G.notify('✅ Umowa wykonana: ' + p.name + ' dla ' + c.buyer, 'money'); }
    return total;
  };
  function contractsDaily(d) {
    const S = G.S.market;
    for (const c of S.contracts) {
      if (c.status !== 'active') continue;
      const left = c.due - d.dayIndex, rem = c.qty - c.delivered;
      if (left === 3 && G.inv.get(c.product) < rem) G.notify('⏳ Za 3 dni termin umowy: brakuje ' + G.fmtQty(c.product, rem - G.inv.get(c.product)) + ' (' + G.PRODUCTS[c.product].name + ')', 'warn', { key: 'cdue' + c.id });
      if (left <= 0) {
        M.deliver(c.id);
        if (c.status === 'active') {
          const miss = c.qty - c.delivered, pen = Math.round(miss * c.price * c.penaltyRate);
          if (pen > 0) { G.finance.spend(pen, 'inne', 'Kara umowna: niedostarczone ' + G.fmtQty(c.product, miss) + ' (' + c.buyer + ')', true); stat('penalties', pen); }
          c.status = c.delivered > 0 ? 'partial' : 'failed'; c.closed = d.dayIndex;
          G.notify('⚠️ Umowa niewykonana w terminie — kara ' + G.fmtMoney(pen), 'bad');
        }
      }
    }
    // sprzątanie: zakończone starsze niż 2 miesiące
    S.contracts = S.contracts.filter(c => !(c.closed != null && d.dayIndex - c.closed > 12));
  }

  // ---------- KREDYTY ----------
  M.LOANS = {
    obrotowy: { name: 'Kredyt obrotowy', rate: 0.085, months: 12, desc: 'Na nawozy, nasiona i bieżące wydatki. Spłata w 12 ratach.' },
    inwestycyjny: { name: 'Kredyt inwestycyjny', rate: 0.07, months: 60, desc: 'Na maszyny i budynki. Spłata w 5 lat.' },
    ziemia: { name: 'Preferencyjny kredyt na zakup ziemi (ARiMR)', rate: 0.02, months: 180, landOnly: true, desc: 'Dopłata ARiMR do oprocentowania — tylko na zakup ziemi, do 85% ceny, 15 lat.' },
    dziadek: { name: 'Kredyt po dziadku (klęskowy)', rate: 0.04, months: 48, hidden: true, desc: 'Odziedziczony z gospodarstwem.' }
  };
  function annuity(P, rate, n) { const r = rate / 12; return r > 0 ? P * r / (1 - Math.pow(1 + r, -n)) : P / n; }
  function debt() { return G.S.market.loans.reduce((a, l) => a + l.left, 0); }
  M.debt = debt;
  function landValue() { return G.playerParcels().filter(p => !p.leased).reduce((a, p) => a + (p.price || 0), 0); }
  // zdolność kredytowa: 60% wartości własnej ziemi + 40 tys. + 2 tys. zł/ha uprawianych − obecne zadłużenie
  function capacity() { const ha = playerHa().all; return Math.max(0, Math.round((landValue() * 0.6 + 40000 + ha * 2000 - debt()) / 1000) * 1000); }
  M.loanOffers = function () {
    const cap = capacity(), ha = playerHa().all, out = [];
    for (const type in M.LOANS) {
      const L = M.LOANS[type]; if (L.hidden) continue;
      let max = type === 'obrotowy' ? Math.min(cap, 20000 + ha * 1500) : type === 'inwestycyjny' ? Math.min(cap, 50000 + ha * 4000) : null;
      if (max != null) max = Math.max(0, Math.round(max / 1000) * 1000);
      out.push({ type, name: L.name, rate: L.rate, months: L.months, max, desc: L.desc, landOnly: !!L.landOnly,
        example: max ? Math.round(annuity(Math.min(max, 10000), L.rate, L.months)) : null });
    }
    return out;
  };
  function addLoan(type, amount, silent, note) {
    const L = M.LOANS[type], S = G.S.market;
    const loan = { id: S.nextId++, type, name: L.name + (note ? ' — ' + note : ''), principal: amount, left: amount, rate: L.rate, months: L.months, monthsLeft: L.months,
      payment: Math.round(annuity(amount, L.rate, L.months) * 100) / 100, taken: G.date().dayIndex };
    S.loans.push(loan);
    if (!silent) G.finance.earn(amount, 'kredyt', 'Wypłata: ' + loan.name);
    return loan;
  }
  // takeLoan(type, amount, note?) → { ok, loan | reason }
  M.takeLoan = function (type, amount, note, opts) {
    const L = M.LOANS[type];
    amount = Math.round(+amount || 0);
    if (!L || L.hidden) return { ok: false, reason: 'Nieznany kredyt' };
    if (L.landOnly && !(opts && opts.land)) return { ok: false, reason: 'Ten kredyt jest tylko na zakup ziemi (kup działkę z opcją kredytu)' };
    if (amount < 1000) return { ok: false, reason: 'Minimalna kwota to 1 000 zł' };
    if (!L.landOnly) {
      const off = M.loanOffers().find(o => o.type === type);
      if (amount > off.max) return { ok: false, reason: 'Bank przyzna maksymalnie ' + G.fmtMoney(off.max) };
    }
    const loan = addLoan(type, amount, false, note);
    G.notify('🏦 ' + loan.name + ': ' + G.fmtMoney(amount) + ', rata ' + G.fmtMoney(loan.payment) + '/mies.', 'money');
    return { ok: true, loan };
  };
  M.loans = function () {
    return G.S.market.loans.map(l => Object.assign({}, l, { left: Math.round(l.left), nextInterest: Math.round(l.left * l.rate / 12 * 100) / 100 }));
  };
  // wcześniejsza spłata (bez prowizji) → { ok, paid | reason }
  M.repay = function (lid, amount) {
    const S = G.S.market, l = S.loans.find(x => x.id === lid);
    if (!l) return { ok: false, reason: 'Brak kredytu' };
    const amt = Math.round(Math.min(amount == null ? l.left : +amount, l.left) * 100) / 100;
    if (!(amt > 0)) return { ok: false, reason: 'Podaj kwotę' };
    if (!G.finance.spend(amt, 'kredyt', 'Wcześniejsza spłata: ' + l.name)) return { ok: false, reason: 'Brak środków' };
    l.left = Math.round((l.left - amt) * 100) / 100;
    if (l.left < 1) { S.loans = S.loans.filter(x => x !== l); G.notify('🎉 Spłacono kredyt: ' + l.name, 'good'); }
    else l.payment = Math.round(annuity(l.left, l.rate, Math.max(1, l.monthsLeft)) * 100) / 100;
    return { ok: true, paid: amt };
  };
  function loansMonthly() {
    const S = G.S.market;
    for (const l of S.loans.slice()) {
      const interest = Math.round(l.left * l.rate / 12 * 100) / 100;
      const principal = Math.round(Math.min(l.left, Math.max(0, l.payment - interest)) * 100) / 100;
      if (interest > 0) { G.finance.spend(interest, 'odsetki', 'Odsetki: ' + l.name, true); stat('interest', interest); }
      if (principal > 0) G.finance.spend(principal, 'kredyt', 'Rata kapitałowa: ' + l.name, true);
      l.left = Math.round((l.left - principal) * 100) / 100; l.monthsLeft--;
      if (l.left < 1 || l.monthsLeft <= 0) {
        if (l.left >= 1) G.finance.spend(l.left, 'kredyt', 'Ostatnia rata: ' + l.name, true);
        S.loans = S.loans.filter(x => x !== l);
        G.notify('🎉 Spłacono kredyt: ' + l.name, 'good');
      }
    }
    if (G.S.money < 0) {
      const i = Math.round(-G.S.money * 0.012);
      G.finance.spend(i, 'odsetki', 'Odsetki od debetu', true); stat('interest', i);
      G.notify('🔴 Debet na koncie (' + G.fmtMoney(G.S.money) + ') — bank nalicza odsetki. Sprzedaj zapasy albo weź kredyt obrotowy.', 'bad', { key: 'debet' });
    }
  }

  // ---------- DOPŁATY BEZPOŚREDNIE ----------
  M.SUBSIDY = { basic: 490, redis: 175, redisMaxHa: 30, young: 225, youngMaxHa: 50, eco: { struktura: 180, wapno: 150, obornik: 200, sloma: 100, uproszczona: 230, tuz: 330 } };
  // podgląd dopłat za bieżący rok → { year, items: [{ key, name, ha, rate, amount, ok, hint }], total, payText }
  M.subsidyPreview = function () {
    const S = G.S.market, R = M.SUBSIDY, y = G.date().year, ha = playerHa();
    const eco = G.fields && G.fields.ecoStats ? G.fields.ecoStats(y) : { arableHa: ha.field, meadowHa: ha.all - ha.field, limedHa: 0, manureHa: 0, strawHa: 0, noTillHa: 0 };
    const items = [];
    const add = (key, name, h, rate, ok, hint) => items.push({ key, name, ha: Math.round(h * 100) / 100, rate, amount: ok ? Math.round(h * rate) : 0, ok, hint: hint || '' });
    add('basic', 'Podstawowe wsparcie dochodów', ha.all, R.basic, ha.all >= 1, 'wszystkie użytki rolne (min. 1 ha)');
    add('redis', 'Płatność redystrybucyjna', Math.min(ha.all, R.redisMaxHa), R.redis, ha.all >= 1, 'do 30 ha');
    add('young', 'Płatność dla młodego rolnika', Math.min(ha.all, R.youngMaxHa), R.young, y < S.youngUntil, y < S.youngUntil ? 'do ' + S.youngUntil + ' r., do 50 ha' : 'wygasła');
    // struktura upraw (stan z czerwca)
    const st = S.sub.year === y && S.sub.structure ? S.sub.structure : (G.fields && G.fields.cropAreas ? G.fields.cropAreas() : {});
    const tot = Object.values(st).reduce((a, b) => a + b, 0), n = Object.keys(st).length, mx = tot ? Math.max.apply(null, Object.values(st)) / tot : 1;
    const okS = n >= 3 && mx <= 0.65;
    add('struktura', 'Ekoschemat: zróżnicowana struktura upraw', eco.arableHa, R.eco.struktura, okS, (S.sub.year === y ? 'stan z czerwca: ' : 'teraz: ') + n + ' upraw, główna ' + Math.round(mx * 100) + '% (wymagane ≥ 3 i ≤ 65%)');
    add('wapno', 'Ekoschemat: plan nawożenia z wapnowaniem', eco.limedHa, R.eco.wapno, eco.limedHa > 0, 'działki zwapnowane w tym roku (≥ 1 t/ha)');
    add('obornik', 'Ekoschemat: obornik przyorany w 12 h', eco.manureHa, R.eco.obornik, eco.manureHa > 0, 'obornik + orka w ciągu 1 dnia');
    add('sloma', 'Ekoschemat: wymieszanie słomy z glebą', eco.strawHa, R.eco.sloma, eco.strawHa > 0, 'słoma przyorana zamiast zebrana');
    add('uproszczona', 'Ekoschemat: uproszczone systemy uprawy', eco.noTillHa, R.eco.uproszczona, eco.noTillHa > 0, 'siew bez orki (agregat)');
    const grazers = G.animals && G.animals.herds ? G.animals.herds().filter(h => /krow|bydł|owc|koz|kon|cow|sheep|goat|horse|cattle/i.test(h.species)).reduce((a, h) => a + (h.count || 0), 0) : 0;
    const okT = eco.meadowHa > 0 && grazers >= eco.meadowHa * 0.3;
    add('tuz', 'Ekoschemat: łąki z obsadą zwierząt', eco.meadowHa, R.eco.tuz, okT, 'min. 0,3 sztuki dużej (krowy, owce, konie) na ha łąk' + (eco.meadowHa ? ' — masz ' + grazers : ''));
    const total = items.reduce((a, i) => a + i.amount, 0);
    return { year: y, items, total, payText: 'wypłata: 1 grudnia' };
  };
  function paySubsidies() {
    const S = G.S.market, pv = M.subsidyPreview();
    if (S.sub.last === pv.year) return;
    S.sub.last = pv.year;
    if (pv.total > 0) {
      G.finance.earn(pv.total, 'dopłaty', 'Dopłaty bezpośrednie ' + pv.year + ' (ARiMR)');
      stat('subsidies', pv.total);
      G.notify('🇪🇺 Dopłaty ARiMR za ' + pv.year + ': ' + G.fmtMoney(pv.total) + ' — ' + pv.items.filter(i => i.ok && i.amount).map(i => i.name.replace('Ekoschemat: ', '') + ' ' + G.fmtMoney(i.amount)).join(', '), 'money');
    }
  }

  // ---------- PODATEK ROLNY I KRUS ----------
  M.taxPreview = function () {
    let haP = 0;
    for (const p of G.playerParcels()) {
      if (p.leased) continue;
      const s = Math.max(1, Math.min(6, Math.round(p.soilAvg || 3)));
      haP += p.area * (p.kind === 'meadow' ? G.SOIL_TAX_MEADOW[s] : G.SOIL_TAX_FIELD[s]);
    }
    const perHa = 2.5 * 65;
    return { haPrzel: Math.round(haP * 100) / 100, perHa, tax: haP >= 1 ? Math.round(haP * perHa) : 0, krusQuarter: 750 };
  };
  function payTax(d) {
    const S = G.S.market;
    if (S.lastTaxYear === d.year) return;
    S.lastTaxYear = d.year;
    const t = M.taxPreview();
    if (t.tax > 0) { G.finance.spend(t.tax, 'inne', 'Podatek rolny ' + d.year + ' (' + G.fmtNum(t.haPrzel) + ' ha przel.)', true); G.notify('🧾 Podatek rolny: ' + G.fmtMoney(t.tax), 'money'); }
  }

  // ---------- doradca rynkowy ----------
  M.advice = function () {
    const out = [], S = G.S.market, d = G.date();
    for (const c of S.contracts) {
      if (c.status !== 'active') continue;
      const rem = c.qty - c.delivered, have = G.inv.get(c.product), left = c.due - d.dayIndex;
      if (have >= rem && left <= 12) out.push({ key: 'deliver' + c.id, icon: '🚚', title: 'Dostarcz towar z umowy', text: G.PRODUCTS[c.product].name + ': ' + G.fmtQty(c.product, rem) + ' dla ' + c.buyer + ' (termin ' + dayText(c.due) + ', ' + G.fmtNum(c.price, 2) + ' zł)', priority: 2, action: 'market', contract: c.id });
      else if (have < rem && left <= 6) out.push({ key: 'short' + c.id, icon: '⏳', title: 'Brakuje towaru do umowy', text: 'Brakuje ' + G.fmtQty(c.product, rem - have) + ' ' + G.PRODUCTS[c.product].name.toLowerCase() + ' — termin za ' + left + ' dni, kara ' + G.fmtMoney((rem - have) * c.price * c.penaltyRate), priority: 1, action: 'market', contract: c.id });
    }
    for (const id in G.S.inv) {
      const p = G.PRODUCTS[id];
      if (!p || isShop(id) || !M.canSell(id) || !(G.inv.get(id) > 0)) continue;
      const i = M.info(id);
      if (i.vsBase >= 8) out.push({ key: 'sellhigh_' + id, icon: '📈', title: 'Dobra cena: ' + p.name, text: G.fmtNum(i.stockPrice, 2) + ' zł/' + p.unit + (i.quality && i.quality.graded ? ' (' + i.quality.label + ')' : '') + ' (' + (i.vsBase > 0 ? '+' : '') + i.vsBase + '% wobec średniej). W magazynie ' + G.fmtQty(id, i.have) + '.', priority: 3, action: 'market', product: id });
    }
    const offers = S.contracts.filter(c => c.status === 'offer');
    if (offers.length) out.push({ key: 'offers', icon: '✍️', title: 'Nowe oferty umów (' + offers.length + ')', text: offers.slice(0, 2).map(c => cview(c).text).join('; '), priority: 3, action: 'market' });
    if (G.S.money < 0) out.push({ key: 'debet', icon: '🔴', title: 'Debet na koncie', text: 'Sprzedaj zapasy albo weź kredyt obrotowy — bank nalicza 1,2% miesięcznie.', priority: 1, action: 'loan' });
    if (d.month === 10) {
      const pv = M.subsidyPreview(), miss = pv.items.filter(i => !i.ok && i.key !== 'young');
      out.push({ key: 'subs', icon: '🇪🇺', title: 'Dopłaty w grudniu: ~' + G.fmtMoney(pv.total), text: miss.length ? 'Niespełnione: ' + miss.map(i => i.name.replace('Ekoschemat: ', '')).join(', ') : 'Spełniasz wszystkie warunki.', priority: 3, action: null });
    }
    return out;
  };

  // ---------- hooki ----------
  G.on('newGame', init);
  G.on('load', () => {
    let S = G.S.market;
    if (!S || !S.cur) { init(); return; }
    const b = blankState();
    for (const k in b) if (S[k] === undefined) S[k] = b[k];
    for (const id in G.PRODUCTS) ensureProduct(S, id);
    for (const id in S.quality) if (!(G.inv.get(id) > 0)) delete S.quality[id];
    computeAll(G.date().month);
  });
  G.on('inventory', (id, dq) => { try { onInventory(id, dq); } catch (e) { console.error('[market.quality]', e); } });
  G.on('daily', d => {
    const S = G.S.market; if (!S) return;
    for (const id in G.PRODUCTS) if (S.t[id] == null) ensureProduct(S, id);
    step(d.dayIndex, false);
    pushHist(d.dayIndex);
    contractsDaily(d);
    // niewykorzystane zgłoszenia partii (np. ziarno sprzedane prosto z przyczepy) wygasają po 12 dniach
    if (S.pending) for (const id in S.pending) if (d.dayIndex - S.pending[id].day > 12) delete S.pending[id];
  });
  G.on('monthly', d => {
    if (!G.S.market) return;
    loansMonthly();
    genOffers(false);
    if (d.month % 3 === 0) G.finance.spend(750, 'inne', 'Składka KRUS (kwartał)', true);
    if (d.month === 2) payTax(d);
    if (d.month === 5) { G.S.market.sub.structure = G.fields && G.fields.cropAreas ? G.fields.cropAreas() : {}; G.S.market.sub.year = d.year; }
    if (d.month === 11) paySubsidies();
  });
})();
