// Złote Pola — pracownicy: rekrutacja, umiejętności, płace, zmęczenie → G.workers (agent: maszyny, ludzie, prace)
//
// Stan: G.S.workers = [{ uid, name, age, gender ('m'|'k'), skills: {field, mech, animals} (1..5), xp: {field, mech, animals} (godziny),
//                        wage (zł/dzień gry — koszt pracodawcy), monthly (zł brutto/mies.), energy 0..1, busy: jobUid|null,
//                        contract: 'owner'|'etat'|'sezon', until (tick końca umowy sezonowej), hiredAt, paidUntil (tick),
//                        role: 'any'|'field'|'barn', barnH (godziny obory dziś), hours (przepracowane), isPlayer,
//                        drives: uid maszyny, w której siedzi (rozkaz / przydział / ręczna jazda gracza) | null }]
//       G.S.workerPool = { cands: [kandydaci], next: tick odświeżenia, barn: { need, covered } }
//
// Płace: etat 4500–7000 zł brutto/mies. + ~20 % ZUS pracodawcy; miesiąc gry = 6 dni → stawka dzienna = brutto × 1,2 / 6
//        (ok. 900–1400 zł/dzień gry; rocznie 65–100 tys. zł — jak w realu). Etat płatny 1. dnia miesiąca gry (za przepracowane dni).
//        Sezonowy (umowa zlecenie, 3–12 dni): stawka dzienna o ~35 % wyższa, płatny codziennie, umowa kończy się sama.
// Zmęczenie: praca zużywa ~7,5 % energii/h (nocą ×1,5) → ok. 13 h pracy; odpoczynek +10 %/h w dzień, +15 %/h w nocy.
// Umiejętności: polowe → prędkość (0,88…1,2) i jakość zabiegu; mechaniczne → mniejsze zużycie maszyn i rzadsze awarie;
//               hodowlane → szybsza obsługa zwierząt. Doświadczenie: 1 punkt umiejętności co ≈ 120 h × obecny poziom.
(function () {
  const C = G.CFG, TPD = C.TICKS_PER_DAY;
  const W = G.workers = {};
  const DRAIN = 0.075, REST_DAY = 0.10, REST_NIGHT = 0.15;
  const MIN_START = 0.35, MIN_WORK = 0.04, RESUME = 0.6;

  const NAMES_M = ['Jan', 'Piotr', 'Krzysztof', 'Andrzej', 'Tomasz', 'Paweł', 'Marcin', 'Michał', 'Grzegorz', 'Józef', 'Marek', 'Stanisław', 'Kazimierz', 'Mateusz', 'Kacper', 'Jakub', 'Wojciech', 'Zbigniew', 'Ryszard', 'Bartosz', 'Dawid', 'Szymon', 'Tadeusz', 'Henryk', 'Łukasz', 'Adam', 'Sebastian', 'Mirosław'];
  const NAMES_K = ['Anna', 'Maria', 'Katarzyna', 'Małgorzata', 'Agnieszka', 'Barbara', 'Ewa', 'Krystyna', 'Magdalena', 'Joanna', 'Zofia', 'Halina', 'Teresa', 'Monika', 'Natalia', 'Aleksandra', 'Karolina', 'Danuta', 'Beata', 'Julia'];
  // nazwiska: [forma męska, forma żeńska]
  const SURN = [['Nowak', 'Nowak'], ['Kowalski', 'Kowalska'], ['Wiśniewski', 'Wiśniewska'], ['Wójcik', 'Wójcik'], ['Kowalczyk', 'Kowalczyk'], ['Kamiński', 'Kamińska'],
    ['Lewandowski', 'Lewandowska'], ['Zieliński', 'Zielińska'], ['Szymański', 'Szymańska'], ['Woźniak', 'Woźniak'], ['Dąbrowski', 'Dąbrowska'], ['Kozłowski', 'Kozłowska'],
    ['Jankowski', 'Jankowska'], ['Mazur', 'Mazur'], ['Kwiatkowski', 'Kwiatkowska'], ['Krawczyk', 'Krawczyk'], ['Piotrowski', 'Piotrowska'], ['Grabowski', 'Grabowska'],
    ['Pawłowski', 'Pawłowska'], ['Michalski', 'Michalska'], ['Król', 'Król'], ['Wieczorek', 'Wieczorek'], ['Jabłoński', 'Jabłońska'], ['Wróbel', 'Wróbel'],
    ['Nowicki', 'Nowicka'], ['Majewski', 'Majewska'], ['Olszewski', 'Olszewska'], ['Stępień', 'Stępień'], ['Jaworski', 'Jaworska'], ['Malinowski', 'Malinowska'],
    ['Sikora', 'Sikora'], ['Baran', 'Baran'], ['Duda', 'Duda'], ['Szewczyk', 'Szewczyk'], ['Tomaszewski', 'Tomaszewska'], ['Pietrzak', 'Pietrzak'], ['Marciniak', 'Marciniak'],
    ['Wróblewski', 'Wróblewska'], ['Zalewski', 'Zalewska'], ['Jasiński', 'Jasińska'], ['Zawadzki', 'Zawadzka'], ['Sadowski', 'Sadowska'], ['Bąk', 'Bąk'], ['Chmielewski', 'Chmielewska']];
  const TRAITS = ['punktualny', 'małomówny', 'zna każdą miedzę', 'po technikum rolniczym', 'robił w spółdzielni', 'wrócił z Niemiec', 'lubi stare ciągniki',
    'ma prawo jazdy kat. T i C', 'z sąsiedniej wsi', 'student rolnictwa', 'zadbany i dokładny', 'szybki, ale bywa niedokładny', 'świetnie zna się na krowach'];

  W.list = () => G.S.workers || [];
  W.get = uid => W.list().find(w => w.uid === uid) || null;
  W.player = () => W.list().find(w => w.isPlayer) || null;
  W.candidates = () => (G.S.workerPool && G.S.workerPool.cands) || [];

  // ---------- wpływ umiejętności ----------
  W.speedFactor = function (uid) { const w = W.get(uid); return w ? 0.8 + 0.08 * w.skills.field : 1; };
  W.qualityOf = function (uid) { const w = W.get(uid); return w ? Math.min(1, 0.55 + 0.09 * w.skills.field) : 0.8; };
  W.wearFactor = function (uid) { const w = W.get(uid); return w ? 1.25 - 0.1 * w.skills.mech : 1; };
  W.bestSkill = function (k) { return W.list().reduce((a, w) => Math.max(a, w.skills[k] || 0), 0); };

  // czy pracownik może teraz pracować w polu (dla zlecenia jobUid)
  W.available = function (uid, jobUid, starting) {
    const w = W.get(uid);
    if (!w) return { ok: false, reason: 'Brak pracownika' };
    if (w.busy && w.busy !== jobUid) return { ok: false, reason: w.name + ' — zajęty (zlecenie #' + w.busy + ')' };
    // siedzi w maszynie, która wykonuje rozkaz albo jest prowadzona ręcznie (a ta maszyna nie należy do zlecenia)
    const dm = drivesActive(w);
    if (dm) {
      const j = jobUid != null && G.jobs && G.jobs.get ? G.jobs.get(jobUid) : null;
      if (!(j && (j.machines || []).includes(dm.uid) && !G.machines.isManual(dm.uid))) return { ok: false, reason: w.name + ' — ' + (G.machines.isManual(dm.uid) ? 'prowadzi ' : 'jedzie: ') + G.machines.label(dm.uid) };
    }
    if (inBarn(w)) return { ok: false, reason: w.name + ' — obrządek w oborze' };
    if (w.energy < (starting ? MIN_START : MIN_WORK) || (w._resting && w.energy < RESUME)) return { ok: false, reason: w.name + ' — odpoczywa (zmęczenie)' };
    return { ok: true };
  };
  // maszyna, w której pracownik siedzi i która jest w ruchu (rozkaz / ręczna jazda) | null
  function drivesActive(w) {
    if (w.drives == null || !G.machines) return null;
    const m = G.machines.get(w.drives);
    if (!m || m.driver !== w.uid) return null;
    return (m.order || (G.machines.isManual && G.machines.isManual(m.uid))) ? m : null;
  }
  // wolny do nowej pracy (zlecenie / rozkaz): nie w zleceniu, nie prowadzi, nie w oborze
  W.isFree = function (uid) { const w = W.get(uid); return !!w && !w.busy && !drivesActive(w) && !inBarn(w); };
  W.drivesActive = uid => { const w = W.get(uid); return w ? drivesActive(w) : null; };
  function inBarn(w) {
    if (!w.barnH) return false;
    const h = G.date().hour + (G.hourFrac || 0), half = w.barnH / 2;
    return (h >= 5 && h < 5 + half) || (h >= 16 && h < 16 + half);
  }
  W.inBarn = uid => { const w = W.get(uid); return !!w && inBarn(w); };

  // wysiłek (wołane przez prace w każdej klatce, gdy pracownik jedzie/pracuje)
  W.exert = function (uid, dtH, night, skill) {
    const w = W.get(uid);
    if (!w || dtH <= 0) return;
    w.energy = Math.max(0, w.energy - DRAIN * dtH * (night ? 1.5 : 1));
    if (w.energy < MIN_WORK) w._resting = true;
    w._worked = 2;
    w.hours = Math.round((w.hours + dtH) * 100) / 100;
    gainXp(w, skill || 'field', dtH);
    if (skill === 'field') gainXp(w, 'mech', dtH * 0.25);
  };
  function gainXp(w, k, h) {
    w.xp[k] = (w.xp[k] || 0) + h;
    const need = 120 * w.skills[k];
    if (w.skills[k] < 5 && w.xp[k] >= need) {
      w.xp[k] -= need; w.skills[k]++;
      const lbl = { field: 'polowe', mech: 'mechaniczne', animals: 'hodowlane' }[k];
      G.notify('⭐ ' + w.name + ' — umiejętności ' + lbl + ' rosną do ' + w.skills[k], 'good');
      if (!w.isPlayer && w.contract === 'etat') { w.monthly = Math.min(7500, w.monthly + 150); w.wage = dayWage(w.monthly); }
    }
  }

  // ---------- rekrutacja ----------
  const dayWage = monthly => Math.round(monthly * 1.2 / C.DAYS_PER_MONTH);
  function makeCand(r) {
    const k = r() < 0.18, first = k ? NAMES_K[(r() * NAMES_K.length) | 0] : NAMES_M[(r() * NAMES_M.length) | 0];
    const sur = SURN[(r() * SURN.length) | 0][k ? 1 : 0];
    const age = 19 + ((r() * 45) | 0);
    const exp = Math.min(1, (age - 18) / 30);
    const sk = () => Math.max(1, Math.min(5, Math.round(1 + r() * 2.2 + exp * 1.6 - 0.3)));
    const skills = { field: sk(), mech: sk(), animals: sk() };
    const sum = skills.field + skills.mech + skills.animals;
    const sezon = r() < 0.4;
    let monthly = Math.round((4500 + (sum - 3) / 12 * 2500 + (r() - 0.5) * 400) / 50) * 50;
    monthly = Math.max(4500, Math.min(7000, monthly));
    const c = {
      cid: G.uid(), name: first + ' ' + sur, gender: k ? 'k' : 'm', age, skills, contract: sezon ? 'sezon' : 'etat',
      monthly, trait: TRAITS[(r() * TRAITS.length) | 0]
    };
    if (sezon) { c.days = 3 + ((r() * 10) | 0); c.wage = Math.round(dayWage(monthly) * 1.35); }
    else c.wage = dayWage(monthly);
    return c;
  }
  function refresh() {
    const r = G.rng((G.S.seed | 0) * 13 + G.S.tick + 1);
    const n = 4 + ((r() * 3) | 0), cands = [];
    for (let k = 0; k < n; k++) cands.push(makeCand(r));
    G.S.workerPool.cands = cands;
    G.S.workerPool.next = G.S.tick + 2 * TPD;   // „tydzień” w skróconym kalendarzu ≈ 1,4 dnia gry → odświeżanie co 2 dni
  }
  W.refreshCandidates = refresh;

  W.hire = function (cid) {
    const P = G.S.workerPool, c = P.cands.find(x => x.cid === cid);
    if (!c) return { ok: false, reason: 'Kandydat już nieaktualny' };
    P.cands = P.cands.filter(x => x !== c);
    const w = {
      uid: G.uid(), name: c.name, age: c.age, gender: c.gender, skills: Object.assign({}, c.skills), xp: { field: 0, mech: 0, animals: 0 },
      wage: c.wage, monthly: c.monthly, energy: 1, busy: null, contract: c.contract, until: c.contract === 'sezon' ? G.S.tick + c.days * TPD : 0,
      hiredAt: G.S.tick, paidUntil: G.S.tick, role: 'any', barnH: 0, hours: 0, isPlayer: false, trait: c.trait
    };
    G.S.workers.push(w);
    G.notify('🤝 Zatrudniono: ' + w.name + (w.contract === 'sezon' ? ' (sezonowo do ' + G.dateText(w.until) + ')' : ' (etat)') + ' — ' + G.fmtMoney(w.wage) + '/dzień', 'good');
    return { ok: true, worker: w };
  };
  // rozliczenie do teraz
  function settle(w, note) {
    const days = Math.max(0, (G.S.tick - w.paidUntil) / TPD);
    const amt = Math.round(days * w.wage);
    if (amt > 0) G.finance.spend(amt, 'płace', note || ('Wypłata: ' + w.name), true);
    w.paidUntil = G.S.tick;
    return amt;
  }
  W.fire = function (uid) {
    const w = W.get(uid);
    if (!w) return { ok: false, reason: 'Brak pracownika' };
    if (w.isPlayer) return { ok: false, reason: 'Gospodarza nie da się zwolnić 🙂' };
    if (w.busy) return { ok: false, reason: 'Pracuje w zleceniu — najpierw je zakończ lub anuluj' };
    if (drivesActive(w)) return { ok: false, reason: 'Prowadzi maszynę (rozkaz) — najpierw daj Stop' };
    if (w.drives != null && G.machines && G.machines.unseat) { const m = G.machines.get(w.drives); if (m && m.driver === w.uid) G.machines.unseat(m); }
    const amt = settle(w, 'Rozliczenie końcowe: ' + w.name);
    G.S.workers = G.S.workers.filter(x => x !== w);
    G.notify('👋 ' + w.name + ' odchodzi (rozliczenie ' + G.fmtMoney(amt) + ')', 'info');
    return { ok: true, paid: amt };
  };
  W.setRole = function (uid, role) {
    const w = W.get(uid);
    if (!w || !['any', 'field', 'barn'].includes(role)) return false;
    w.role = role; assignBarn();
    return true;
  };
  W.monthlyCost = () => Math.round(W.list().reduce((a, w) => a + (w.wage || 0), 0) * C.DAYS_PER_MONTH);

  // ---------- obsługa zwierząt ----------
  // potrzeba godzin/dzień z G.animals.laborHours(); najpierw „oborowi” (rola barn), potem pozostali (najpierw Ty), maks. 10 h/os.
  function assignBarn() {
    const need = G.animals && G.animals.laborHours ? Math.max(0, +G.animals.laborHours() || 0) : 0;
    let left = need;
    const ws = W.list();
    for (const w of ws) w.barnH = 0;
    const order = ws.filter(w => w.role === 'barn').concat(ws.filter(w => w.role === 'any' && w.isPlayer), ws.filter(w => w.role === 'any' && !w.isPlayer));
    for (const w of order) {
      if (left <= 0) break;
      const eff = 0.8 + 0.08 * w.skills.animals;   // h potrzeby obsłużone na 1 h pracy
      const h = Math.min(10, left / eff);
      w.barnH = Math.round(h * 10) / 10;
      left -= h * eff;
    }
    G.S.workerPool.barn = { need: Math.round(need * 10) / 10, covered: Math.round((need - Math.max(0, left)) * 10) / 10 };
  }
  W.assignBarn = assignBarn;
  // { need, covered, ratio } — moduł hodowli może obniżyć dobrostan, gdy ratio < 1
  W.barnReport = function () { const b = G.S.workerPool.barn || { need: 0, covered: 0 }; return Object.assign({ ratio: b.need > 0 ? Math.min(1, b.covered / b.need) : 1 }, b); };
  W.animalCare = () => W.barnReport().ratio;

  // ---------- cykl ----------
  G.on('frame', dtH => {
    if (!G.S || !G.S.workers || dtH <= 0) return;
    const hr = G.date().hour, night = hr >= 22 || hr < 6;
    for (const w of G.S.workers) {
      if (w._worked > 0) { w._worked--; continue; }
      if (inBarn(w)) { w.energy = Math.max(0, w.energy - DRAIN * 0.8 * dtH); gainXp(w, 'animals', dtH); continue; }
      w.energy = Math.min(1, w.energy + (night ? REST_NIGHT : REST_DAY) * dtH);
      if (w._resting && w.energy >= RESUME) w._resting = false;
    }
  });
  G.on('daily', () => {
    const S = G.S;
    for (const w of S.workers.slice()) {
      if (w.contract === 'sezon') {
        settle(w, 'Dniówka: ' + w.name);
        if (w.until && S.tick >= w.until) {
          if (w.busy) { w.until += TPD; G.notify('📝 ' + w.name + ' kończy zlecenie — umowa przedłużona o dzień', 'info', { key: 'ext_' + w.uid }); }
          else { S.workers = S.workers.filter(x => x !== w); G.notify('👋 Koniec umowy sezonowej: ' + w.name, 'info'); }
        }
      }
    }
    assignBarn();
    if (S.tick >= S.workerPool.next) refresh();
  });
  G.on('monthly', () => {
    let sum = 0;
    for (const w of G.S.workers) if (w.contract === 'etat') sum += settle(w, 'Pensja: ' + w.name);
    if (sum > 0) G.notify('💸 Wypłaty pensji: ' + G.fmtMoney(sum), 'money');
  });

  G.on('newGame', () => {
    G.S.workers = [{
      uid: G.uid(), name: 'Ty', age: 32, gender: 'm', skills: { field: 3, mech: 2, animals: 2 }, xp: { field: 0, mech: 0, animals: 0 },
      wage: 0, monthly: 0, energy: 1, busy: null, contract: 'owner', until: 0, hiredAt: 0, paidUntil: 0, role: 'any', barnH: 0, hours: 0, isPlayer: true,
      trait: 'gospodarz — przejąłeś ziemię po dziadku'
    }];
    G.S.workerPool = { cands: [], next: 0, barn: { need: 0, covered: 0 } };
    refresh();
  });
  G.on('load', () => {
    const S = G.S;
    if (!Array.isArray(S.workers)) S.workers = [];
    if (!S.workers.some(w => w.isPlayer)) {
      S.workers.unshift({ uid: G.uid(), name: 'Ty', age: 32, gender: 'm', skills: { field: 3, mech: 2, animals: 2 }, xp: { field: 0, mech: 0, animals: 0 },
        wage: 0, monthly: 0, energy: 1, busy: null, contract: 'owner', until: 0, hiredAt: 0, paidUntil: 0, role: 'any', barnH: 0, hours: 0, isPlayer: true });
    }
    for (const w of S.workers) {
      w.skills = Object.assign({ field: 1, mech: 1, animals: 1 }, w.skills);
      w.xp = Object.assign({ field: 0, mech: 0, animals: 0 }, w.xp);
      w.energy = w.energy == null ? 1 : Math.max(0, Math.min(1, +w.energy));
      if (w.busy === undefined) w.busy = null;
      if (w.paidUntil == null) w.paidUntil = S.tick;
      if (!w.role) w.role = 'any';
      w._worked = 0;
      // siedzi w maszynie tylko, jeśli maszyna to potwierdza
      if (w.drives != null) { const m = (S.machines || []).find(x => x.uid === w.drives); if (!m || m.driver !== w.uid) w.drives = null; }
      if (w.drives === undefined) w.drives = null;
    }
    if (!S.workerPool || !Array.isArray(S.workerPool.cands)) { S.workerPool = { cands: [], next: 0, barn: { need: 0, covered: 0 } }; refresh(); }
    if (!S.workerPool.barn) S.workerPool.barn = { need: 0, covered: 0 };
  });
})();
