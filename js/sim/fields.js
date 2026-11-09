// Złote Pola — stan pól, wzrost, zabiegi, plon → G.fields (agent: uprawy i rynek)
//
// STAN: G.S.fields[pid] (tablica indeksowana id działki) — dla WSZYSTKICH działek, także cudzych (sąsiedzi uprawiają
// automatycznie, bez maszyn: „autopilot NPC” zmienia fazy i pokazuje postęp pracy pasami na mapie).
//
// MODEL WZROSTU (dziennie, z wczorajszej pogody G.S.weather.last):
//   rozwój: suma temperatur efektywnych (GDD) → growth = gdd / CROPS.gdd (0..1), potem faza 'ripe';
//   plon:   yieldBase × gleba × pH × NPK × płodozmian × termin siewu × przygotowanie roli × yp × (1 − straty po terminie) × pokrycie
//           yp (potencjał 0..1) maleje od: suszy (najmocniej w fazie 0,35–0,8), chwastów, chorób, szkodników, mrozu, gradu, zalania;
//   NPK:    pule dostępnych składników na polu (kg/ha: N, P2O5, K2O). Roślina pobiera need × Δgrowth; niedobór obniża plon:
//           fN = 0,35 + 0,65·rN^0,7 (bez nawożenia azotem pszenica daje ~60–70% plonu), fP/fK = 0,75 + 0,25·r^0,6.
//           Mineralizacja gleby: N 30–70 kg/ha/rok (lepsza gleba więcej), wietrzenie P ~15, K ~25 kg/ha/rok.
//           Azot w zimie się wymywa (mokra gleba) — nawożenie azotem przed siewem jesiennym marnuje część dawki.
//   pH:     spada naturalnie ~0,08/rok i od saletry; wapno 1 t/ha ≈ +0,15 pH, działa stopniowo (~2 miesiące gry).
//   chwasty: rosną logistycznie, gdy ciepło (r ≈ 0,15/dzień), po zwarciu łanu wolniej; herbicyd −90% i 8 dni ochrony;
//            orka zeruje zachwaszczenie, uprawa bezorkowa zostawia ~20%.
//   choroby: rosną przy wilgoci i 8–26 °C; zboże po zbożu / zbyt krótka przerwa → +40–50%; fungicyd −80% i 10 dni ochrony.
//   szkodniki: w ciepłe dni w fazie 0,15–0,75 (rzepak, ziemniaki najbardziej); insektycyd −85%, 8 dni ochrony.
// ZABIEGI: G.fields.OPS; prace wołają canDo → workTile (dla każdego obrobionego kafla 0,25 ha) → complete.
//   workTile zużywa środki z magazynu proporcjonalnie (dawka/ha × 0,25).
//   ZBIÓR ('harvest'): workTile NIE dodaje plonu do magazynu — zwraca { out: { produkt: t } }; ziarno/bulwy/zielonkę
//   odwożą przyczepy (moduł prac dodaje do G.inv po rozładunku).
//   PRASOWANIE ('bale'): bele trafiają od razu do magazynu (G.inv.add), chyba że params.noStore = true.
//   OPS[op].storesOutput mówi, czy zabieg sam dodaje produkt do magazynu.
(function () {
  const F = G.fields = {};
  const C = G.CFG, TILE_HA = C.TILE_HA;
  const RD = 365 / 72;           // dni kalendarzowe na dzień gry
  let pos = null;                // Int16Array: pozycja kafla na liście parcel.tiles
  const rnd = () => Math.random();
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const r2 = v => Math.round(v * 100) / 100;

  F.PHASE_NAMES = {
    stubble: 'ściernisko', plowed: 'zaorane', cultivated: 'uprawione — gotowe do siewu', sown: 'zasiane — kiełkuje',
    growing: 'rośnie', ripe: 'dojrzałe — do zbioru', harvested: 'po zbiorze', grass: 'łąka — trawa rośnie',
    mown: 'skoszone — pokos schnie', fallow: 'ugór'
  };
  const AFTER = { plow: 'plowed', cultivate: 'cultivated', sow: 'sown', harvest: 'harvested', mow: 'mown' };
  // N z mineralizacji gleby (kg/ha/rok) wg klasy
  const MIN_N = [0, 60, 52, 44, 38, 30, 24];
  // „równowagowa” zasobność P2O5 i K2O (kg/ha dostępne) wg klasy — zapasy glebowe uzupełniają pulę ku tej wartości
  // (ok. 1,2% niedoboru dziennie ≈ 60% w rok gry); nawozy ponad tę wartość powoli się uwsteczniają (0,4%/dzień)
  const REF_P = [0, 75, 70, 60, 50, 40, 30], REF_K = [0, 110, 100, 90, 75, 60, 45];
  // sąsiedzi gospodarują „przeciętnie” (kalibracja: ich plony ≈ średnie GUS)
  const NPC_MGMT = 0.95;
  const DD_YEAR = 384;           // roczna suma (t−5 °C) w dniach gry — do rozkładu mineralizacji

  // ---------------------------------------------------------------------------------------------------------------
  // ZABIEGI
  //   implement – kategoria narzędzia (G.MACHINES[].cat); implementFor(params, field) – konkretna dla uprawy/produktu
  //   needsInput(params, field) → { id, rate (jedn./ha) } | null; phases – fazy, w których zabieg jest dozwolony
  //   kind: 'field' (tylko grunty orne) | 'meadow' (tylko łąki) | 'any'; products – lista wariantów (UI)
  // ---------------------------------------------------------------------------------------------------------------
  F.OPS = {
    plow: { name: 'Orka', icon: '🚜', implement: 'plow', kind: 'field', phases: ['stubble', 'harvested', 'fallow', 'cultivated'],
      desc: 'Odwraca glebę: niszczy chwasty i resztki z chorobami, przyoruje obornik i słomę.' },
    cultivate: { name: 'Uprawa przedsiewna', icon: '〰️', implement: 'cultivator', kind: 'field', phases: ['stubble', 'harvested', 'plowed', 'fallow'],
      desc: 'Agregat/brona: wyrównuje rolę przed siewem. Bez orki = uprawa uproszczona (taniej, ekoschemat, ale więcej chwastów i chorób).' },
    lime: { name: 'Wapnowanie', icon: '⚪', implement: 'spreader', kind: 'any',
      phases: ['stubble', 'harvested', 'plowed', 'cultivated', 'fallow', 'grass', 'mown'],
      needsInput: p => ({ id: 'wapno', rate: +p.rate || G.RATES.wapno.def }), rate: 'wapno',
      desc: 'Odkwasza glebę (1 t/ha ≈ +0,15 pH, działa przez ~2 miesiące). Najlepiej po zbiorze, przed orką.' },
    fertilize: { name: 'Nawożenie', icon: '🧂', implement: 'spreader', kind: 'any',
      products: ['saletra', 'npk', 'obornik', 'gnojowica'],
      implementFor: p => (p && (p.product === 'obornik' || p.product === 'gnojowica')) ? 'manure_spreader' : 'spreader',
      phases: ['stubble', 'harvested', 'plowed', 'cultivated', 'sown', 'growing', 'grass', 'mown', 'fallow'],
      needsInput: p => { const id = (p && p.product) || 'saletra'; return { id, rate: +p.rate || (G.RATES[id] ? G.RATES[id].def : 0.25) }; },
      desc: 'Saletra — azot pogłównie (wiosną na oziminy, przed siewem jarych). NPK — fosfor i potas przed siewem. Obornik — przed orką.' },
    sow: { name: 'Siew', icon: '🌱', implement: 'seeder', kind: 'field', phases: ['plowed', 'cultivated'],
      implementFor: p => (p && p.crop === 'ziemniaki') ? 'planter' : 'seeder',
      needsInput: p => { const c = G.CROPS[p && p.crop]; return c ? { id: c.seed, rate: c.seedRate } : null; },
      desc: 'Siew lub sadzenie wybranej uprawy. Najlepiej na uprawioną rolę (po orce i bronie).' },
    spray: { name: 'Oprysk', icon: '💧', implement: 'sprayer', kind: 'field', phases: ['sown', 'growing'],
      products: ['herbicyd', 'fungicyd', 'insektycyd'],
      needsInput: p => { const id = (p && p.product) || 'herbicyd'; return { id, rate: +p.rate || G.RATES[id].def }; },
      desc: 'Herbicyd — chwasty, fungicyd — choroby grzybowe, insektycyd — szkodniki. Nie w deszcz i nie przy wietrze > 5 m/s.' },
    harvest: { name: 'Zbiór', icon: '🌾', implement: 'combine', kind: 'field', phases: ['ripe'], storesOutput: false,
      implementFor: (p, f) => { const c = f && f.crop; return c === 'ziemniaki' ? 'potato_harvester' : c === 'buraki' ? 'beet_harvester' : c === 'kiszonka' ? 'forage_harvester' : 'combine'; },
      desc: 'Zbiór plonu do magazynu. Po terminie plon się osypuje/porasta (~3% dziennie).' },
    bale: { name: 'Prasowanie', icon: '🟨', implement: 'baler', kind: 'any', phases: ['harvested', 'mown'], storesOutput: true,
      products: ['siano', 'sianokiszonka'],
      desc: 'Słoma po zbożach lub siano/sianokiszonka z łąki w bele.' },
    mow: { name: 'Koszenie', icon: '✂️', implement: 'mower', kind: 'meadow', phases: ['grass'],
      desc: 'Koszenie łąki. Najlepiej, gdy trawa jest w pełni wzrostu (100%), przy kilku dniach bez deszczu.' },
    rake: { name: 'Zgrabianie', icon: '🧹', implement: 'rake', kind: 'meadow', phases: ['mown'],
      desc: 'Przetrząsanie i zgrabianie pokosu — szybsze schnięcie, +5% bel.' }
  };
  F.implementFor = function (pid, op, params) {
    const o = F.OPS[op]; if (!o) return null;
    return o.implementFor ? o.implementFor(params || {}, F.get(pid)) : o.implement;
  };

  // ---------------------------------------------------------------------------------------------------------------
  // POMOCNICZE
  // ---------------------------------------------------------------------------------------------------------------
  F.get = pid => (G.S.fields && G.S.fields[pid]) || null;
  const parcel = pid => G.S.parcels[pid];
  const day = () => G.date().dayIndex;
  const isPlayer = p => p && p.owner === 'player';
  function soilClass(p) { return clamp(Math.round(p.soilAvg || 3), 1, 6); }
  F.soilFactor = function (cropId, soil) {
    const c = G.CROPS[cropId], s = clamp(Math.round(soil), 1, 6), base = G.SOIL_FACTOR[s];
    return base >= 1 ? 1 + (base - 1) * Math.min(1, c.soilSens) : Math.max(0.2, 1 - (1 - base) * c.soilSens);
  };
  F.phFactor = function (cropId, ph) {
    const c = G.CROPS[cropId], d = c.phOpt - ph;
    if (d <= 0.2) return d < -0.8 ? 1 - (-d - 0.8) * 0.08 : 1;
    return Math.max(0.45, 1 - 0.22 * c.phSens * (d - 0.2));
  };
  function cropYearFor(cropId, d) { const c = G.CROPS[cropId]; return d.year + (c.winter && d.month >= 6 ? 1 : 0); }

  // ocena płodozmianu dla uprawy na polu → { f (mnożnik), bad (bool), text }
  F.rotation = function (f, cropId) {
    const c = G.CROPS[cropId];
    if (!c || c.meadow) return { f: 1, bad: false, text: '' };
    const hist = f.history || [], prev = hist[0] ? hist[0].crop : f.last;
    let k = 1, bad = false; const notes = [];
    if (prev && c.rotation.bad.indexOf(prev) >= 0) { k *= 0.85; bad = true; notes.push('zły przedplon (' + G.CROPS[prev].short + ')'); }
    else if (prev && c.rotation.good.indexOf(prev) >= 0) { k *= 1.06; notes.push('dobry przedplon (' + G.CROPS[prev].short + ')'); }
    if (c.breakYears > 0) {
      const y = G.date().year, same = hist.slice(0, c.breakYears).some(h => h.crop === cropId || (G.CROPS[h.crop] && G.CROPS[h.crop].group === c.group && c.group !== 'zboże' && c.group !== 'kukurydza'));
      if (same) { k *= 0.72; bad = true; notes.push('za krótka przerwa (min. ' + c.breakYears + ' lata) — choroby i szkodniki glebowe'); }
      void y;
    }
    if (c.group === 'zboże' && cropId !== 'owies') {
      let n = 0; for (const h of hist.slice(0, 3)) { if (G.CROPS[h.crop] && G.CROPS[h.crop].group === 'zboże') n++; else break; }
      if (n >= 2) { k *= 0.93; bad = true; notes.push(n + '. rok zbóż z rzędu — choroby podsuszkowe'); }
    }
    return { f: k, bad, text: notes.join(', ') || (prev ? 'przedplon ' + G.CROPS[prev].short + ' — neutralny' : 'brak danych o przedplonie') };
  };
  // termin siewu → mnożnik (0 = niedozwolony)
  F.sowTiming = function (cropId, month) {
    const c = G.CROPS[cropId]; if (!c) return 0;
    if (c.sowMonths.indexOf(month) >= 0) return 1;
    const last = c.sowMonths[c.sowMonths.length - 1], first = c.sowMonths[0];
    if (month === (last + 1) % 12) return 0.85;   // spóźniony siew
    if (month === (first + 11) % 12 && !c.winter) return 0.88; // za wczesny (ryzyko przymrozku / zimnej gleby)
    return 0;
  };
  function monthsText(arr) { return arr.map(m => G.MONTHS[m]).join(', '); }

  // ---------------------------------------------------------------------------------------------------------------
  // INICJALIZACJA STANU
  // ---------------------------------------------------------------------------------------------------------------
  function blank(p) {
    const s = soilClass(p);
    const phBase = s <= 2 ? 6.4 : s <= 4 ? 5.9 : 5.3;
    return {
      pid: p.id, crop: null, last: null, phase: p.kind === 'meadow' ? 'grass' : 'stubble', growth: 0, gdd: 0, plantedAt: -1, cropYear: 0,
      soil: s, n: 20 + rnd() * 20, p: REF_P[s] * (0.8 + rnd() * 0.5), k: REF_K[s] * (0.8 + rnd() * 0.5), ph: r2(phBase + (rnd() - 0.5) * 0.8), phPend: 0,
      weeds: 0.1, pests: 0, disease: 0, moisture: 0.8, up: { n: 0, p: 0, k: 0 }, yp: 1, rotF: 1, rotBad: false, sowF: 1, bedF: 1,
      cover: 1, luck: 1, lateLoss: 0, ripeDays: 0, quality: 1, prot: {}, history: [], yieldEst: 0, straw: 0, swath: 0, dry: 0,
      cuts: 0, raked: false, tilled: null, hDays: 0, manureDay: -99, flags: {}, work: null, npc: null
    };
  }
  // ustawia uprawę „w toku” z przeszłym terminem siewu (start gry, autopilot)
  function establish(f, cropId, sowDay, opts) {
    const c = G.CROPS[cropId];
    opts = opts || {};
    f.crop = cropId; f.phase = 'sown'; f.plantedAt = sowDay; f.cover = 1; f.yp = 1; f.loss = {}; f.vern = false; f.lateLoss = 0; f.ripeDays = 0; f.quality = 1;
    f.up = { n: 0, p: 0, k: 0 }; f.prot = {}; f.disease = 0; f.pests = 0; f.luck = 0.95 + rnd() * 0.1;
    const rot = F.rotation(f, cropId); f.rotF = rot.f; f.rotBad = rot.bad; f.sowF = 1; f.bedF = 1;
    const d = G.date(Math.max(0, sowDay) * C.TICKS_PER_DAY);
    f.cropYear = opts.cropYear || cropYearFor(cropId, d);
    const now = G.S ? Math.floor(G.S.tick / C.TICKS_PER_DAY) : 0;
    f.gdd = sowDay < now ? G.weather.expectedGdd(c.tbase, sowDay, now - sowDay) : 0;
    if (c.winter) f.gdd = Math.min(f.gdd, c.gdd * (c.autumnMax || 0.25));
    f.growth = Math.min(1, f.gdd / c.gdd);
    if (f.growth > 0.04) f.phase = 'growing';
    // pobranie składników „do tej pory” — jakby uprawa była prowadzona poprawnie
    for (const key of ['n', 'p', 'k']) f.up[key] = c[key + 'Need'] * f.growth;
  }
  function initAll() {
    const S = G.S;
    S.fields = [];
    for (const p of S.parcels) S.fields[p.id] = blank(p);
    const d0 = 0;
    // sąsiedzi: losowy stan pól na 1 marca
    for (const p of S.parcels) {
      const f = S.fields[p.id];
      if (p.kind === 'meadow') { f.crop = 'trawa'; f.phase = 'grass'; f.growth = 0; f.gdd = 0; continue; }
      if (isPlayer(p)) continue;
      const s = f.soil, r = rnd();
      f.history = [{ crop: s >= 5 ? 'zyto' : (rnd() < 0.5 ? 'pszenica' : 'jeczmien'), year: 2025, yield: 0, area: p.area }];
      if (r < 0.48) {
        const w = s >= 5 ? (rnd() < 0.6 ? 'zyto' : 'pszenzyto') : s >= 4 ? (rnd() < 0.6 ? 'pszenzyto' : 'pszenica') : (rnd() < 0.3 ? 'rzepak' : 'pszenica');
        if (w === 'rzepak') f.history[0].crop = 'pszenica';
        establish(f, w, w === 'rzepak' ? d0 - 38 : d0 - 26 - ((rnd() * 4) | 0), { cropYear: 2026 });
        f.weeds = 0.05; f.n = 40; f.yp = NPC_MGMT;
      } else if (r < 0.82) {
        f.phase = 'plowed'; f.weeds = 0.05; f.tilled = 'plow';
      } else { f.phase = 'stubble'; f.weeds = 0.2; f.last = f.history[0].crop; }
      f.npc = { task: null, plan: null };
    }
    // gracz: pola dziadka
    const mine = G.playerParcels().filter(p => p.kind === 'field').sort((a, b) => b.area - a.area);
    mine.forEach((p, k) => {
      const f = S.fields[p.id];
      f.ph = r2(5.7 + rnd() * 0.5); f.n = 30; f.p = REF_P[f.soil] + rnd() * 15; f.k = REF_K[f.soil] + rnd() * 20;
      if (k === 0) {
        f.history = [{ crop: 'rzepak', year: 2025, yield: 3.2, area: p.area }, { crop: 'pszenica', year: 2024, yield: 6.1, area: p.area }];
        establish(f, 'pszenica', -27, { cropYear: 2026 });
        f.weeds = 0.16; f.disease = 0.04; f.n = 25; f.tilled = 'plow';
      } else if (k === 1) {
        f.history = [{ crop: 'kukurydza', year: 2025, yield: 7.6, area: p.area }, { crop: 'pszenica', year: 2024, yield: 5.9, area: p.area }];
        f.phase = 'stubble'; f.last = 'kukurydza'; f.weeds = 0.18;
      } else {
        f.history = [{ crop: 'jeczmien', year: 2025, yield: 4.8, area: p.area }, { crop: 'ziemniaki', year: 2024, yield: 27, area: p.area }];
        f.phase = 'plowed'; f.last = 'jeczmien'; f.weeds = 0.04; f.tilled = 'plow';
      }
      f.npc = null;
    });
    for (const p of G.playerParcels().filter(p => p.kind === 'meadow')) {
      const f = S.fields[p.id]; f.ph = r2(5.6 + rnd() * 0.4); f.n = 25; f.npc = null;
    }
    for (const p of S.parcels) if (!isPlayer(p) && !S.fields[p.id].npc) S.fields[p.id].npc = { task: null, plan: null };
    for (const p of S.parcels) S.fields[p.id].yieldEst = estimate(S.fields[p.id], p);
    // magazyn startowy: trochę nawozu i nasion na wiosnę
    G.inv.add('saletra', 1.5);
    G.inv.add('npk', 1.0);
    G.inv.add('nasiona_jeczmien', 600);
    G.inv.add('herbicyd', 10);
    G.inv.add('siano', 20);
    G.inv.add('sloma', 20);
  }
  function buildPos() {
    pos = new Int16Array(C.W * C.H).fill(-1);
    for (const p of G.S.parcels) p.tiles.forEach((i, k) => { pos[i] = k; });
  }
  function validate() {
    const S = G.S;
    if (!Array.isArray(S.fields)) {
      const old = S.fields || {}; S.fields = [];
      for (const k in old) S.fields[+k] = old[k];
    }
    for (const p of S.parcels) {
      let f = S.fields[p.id];
      if (!f) { f = S.fields[p.id] = blank(p); if (p.kind === 'meadow') f.crop = 'trawa'; }
      const b = blank(p);
      for (const k in b) if (f[k] === undefined) f[k] = b[k];
      if (!f.up) f.up = { n: 0, p: 0, k: 0 };
      if (f.work && (!f.work.done || f.work.done.length !== p.tiles.length)) f.work = null;
      if (f.work && !(f.work.done instanceof Uint8Array)) f.work.done = Uint8Array.from(f.work.done);
      if (!isPlayer(p) && !f.npc) f.npc = { task: null, plan: null };
      if (isPlayer(p)) f.npc = null;
      if (f.crop && !G.CROPS[f.crop]) { f.crop = null; f.phase = p.kind === 'meadow' ? 'grass' : 'stubble'; }
    }
    buildPos();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // PLON — ocena bieżąca (t/ha; łąka: bele/ha z najbliższego pokosu)
  // ---------------------------------------------------------------------------------------------------------------
  function nutRatio(f, c, key) {
    const need = c[key + 'Need']; if (!need) return 1;
    const g = Math.min(1, f.growth), minLeft = key === 'n' ? MIN_N[f.soil] * 0.45 * (1 - g) : 0;
    return clamp((f.up[key] + Math.min(Math.max(0, f[key]) + minLeft, need * (1 - g))) / need, 0, 1);
  }
  function nutFactor(f, c) {
    if (f.npc) return 1;
    const rN = nutRatio(f, c, 'n'), rP = nutRatio(f, c, 'p'), rK = nutRatio(f, c, 'k');
    return (0.35 + 0.65 * Math.pow(rN, 0.7)) * (0.75 + 0.25 * Math.pow(rP, 0.6)) * (0.75 + 0.25 * Math.pow(rK, 0.6));
  }
  function estimate(f, p) {
    const c = G.CROPS[f.crop];
    if (!c) return 0;
    if (c.meadow) {
      if (f.phase === 'mown') return f.swath / p.area;
      const cb = c.cutBales[Math.min(f.cuts, c.cutBales.length - 1)];
      return cb * Math.min(1.25, f.growth) * F.soilFactor('trawa', f.soil) * F.phFactor('trawa', f.ph) * nutFactor(f, c) * f.yp;
    }
    if (f.phase !== 'sown' && f.phase !== 'growing' && f.phase !== 'ripe') return 0;
    const ph = f.npc ? Math.max(f.ph, c.phOpt - 0.4) : f.ph;   // sąsiedzi wapnują „po cichu”
    return c.yieldBase * F.soilFactor(f.crop, f.soil) * F.phFactor(f.crop, ph) * nutFactor(f, c) * f.rotF * f.sowF * f.bedF *
      f.yp * (1 - f.lateLoss) * f.cover * f.luck;
  }
  F.estimate = pid => { const f = F.get(pid); return f ? estimate(f, parcel(pid)) : 0; };

  // ---------------------------------------------------------------------------------------------------------------
  // SYMULACJA DZIENNA
  // ---------------------------------------------------------------------------------------------------------------
  function dayUpdate(f, p, wx, d) {
    const c = G.CROPS[f.crop], player = isPlayer(p);
    const tmean = wx.tmean, moist = clamp(wx.moisture - (f.soil - 3) * 0.06, 0.02, 1);
    f.moisture = r2(moist);
    // --- gleba: pH, mineralizacja, wymywanie ---
    if (f.phPend > 0.001) { const dp = Math.min(f.phPend, Math.max(0.02, f.phPend * 0.12)); f.ph += dp; f.phPend -= dp; }
    f.ph = clamp(f.ph - 0.08 / 72, 4.0, 8.0);
    if (tmean > 5) f.n += MIN_N[f.soil] * (tmean - 5) / DD_YEAR;
    const rp = REF_P[f.soil], rk = REF_K[f.soil];
    f.p += (rp - f.p) * (f.p < rp ? 0.012 : 0.004);
    f.k += (rk - f.k) * (f.k < rk ? 0.012 : 0.004);
    if (wx.rainFell > wx.et + 2 && wx.moisture > 0.82) f.n -= f.n * 0.03;
    f.n = clamp(f.n, 0, 400); f.p = clamp(f.p, 0, 600); f.k = clamp(f.k, 0, 800);
    // --- fazy bez uprawy ---
    if (f.phase === 'harvested') {
      f.hDays++;
      if (f.straw > 0 && f.hDays > 10) {    // słoma niezebrana → rozdrobniona i przyorana w przyszłości (K i próchnica)
        f.k += f.straw / p.area * 4; f.n += f.straw / p.area * 0.5; f.straw = 0; f.flags.strawInc = d.year;
        if (player) G.notify('🟨 ' + p.name + ': niezebrana słoma została rozdrobniona na polu (+potas, ekoschemat „wymieszanie słomy”)', 'info', { parcel: p.id });
      }
      if (f.straw <= 0 && f.hDays > 3) f.phase = 'stubble';
    }
    if ((f.phase === 'stubble' || f.phase === 'plowed' || f.phase === 'cultivated' || f.phase === 'fallow' || f.phase === 'harvested') && tmean > 6)
      f.weeds = clamp(f.weeds + 0.012 * (f.phase === 'plowed' ? 0.4 : 1), 0, 0.6);
    if (!c) return;

    // --- łąka ---
    if (c.meadow) { meadowDay(f, p, c, wx, d, moist, player); return; }
    if (f.phase !== 'sown' && f.phase !== 'growing' && f.phase !== 'ripe') return;

    // --- mróz, grad ---
    frostHail(f, p, c, wx, d, player);

    if (f.phase === 'ripe') {
      f.ripeDays++;
      if (f.ripeDays > c.window) f.lateLoss = clamp(f.lateLoss + 0.03 + (wx.rainFell > 5 ? 0.02 : 0), 0, 0.97);
      if (wx.rainFell > 3 && c.group === 'zboże') f.quality = clamp(f.quality - 0.02, 0.5, 1);
      if ((c.group === 'okopowe' || c.group === 'kukurydza') && wx.tmin < -4) f.lateLoss = clamp(f.lateLoss + 0.06, 0, 0.97);
      if (player && f.ripeDays === c.window - 1) G.notify('⏰ ' + p.name + ': kończy się okno zbioru — ' + c.short + ' zacznie się osypywać', 'warn', { parcel: p.id, key: 'win' + p.id });
      if (player && f.lateLoss > 0.9 && !f.lostWarn) { f.lostWarn = 1; G.notify('💀 ' + p.name + ': plon prawie całkowicie stracony (zbiór zbyt późno)', 'bad', { parcel: p.id }); }
      return;
    }
    // --- rozwój ---
    let dg = Math.max(0, tmean - c.tbase) * RD;
    if (f.phase === 'sown' && moist < 0.2) dg *= 0.3;            // susza wstrzymuje kiełkowanie
    const g0 = f.growth;
    f.gdd += dg;
    // oziminy: przed jaryzacją (VIII–II) rozwój zatrzymuje się na fazie krzewienia/rozety — wczesny siew nie przyspiesza żniw
    if (c.winter && d.month >= 2 && d.month <= 6) f.vern = true;            // wiosna = po jaryzacji
    if (c.winter && !f.vern) f.gdd = Math.min(f.gdd, c.gdd * (c.autumnMax || 0.25));
    f.growth = Math.min(1, f.gdd / c.gdd);
    const dG = Math.max(0, f.growth - g0);
    if (f.phase === 'sown' && f.growth > 0.04) f.phase = 'growing';

    if (player) {
      // pobieranie składników
      for (const key of ['n', 'p', 'k']) {
        const dem = c[key + 'Need'] * dG, take = Math.min(Math.max(0, f[key]), dem);
        f.up[key] += take; f[key] -= take;
      }
      // susza / zalanie
      const stress = moist < 0.38 ? clamp((0.38 - moist) / 0.3, 0, 1) : 0;
      const crit = f.growth > 0.35 && f.growth < 0.8 ? 1.6 : 0.6;
      if (stress > 0) lose(f, 'susza', Math.min(0.03, 0.6 * stress * crit * dG * c.droughtSens));
      if (moist > 0.97 && wx.rainFell > 10) lose(f, 'zalanie', 0.01);
      // chwasty
      const warm = tmean > 6 ? 1 : 0;
      if (!(f.prot.herbicyd > d.dayIndex)) f.weeds = clamp(f.weeds + warm * (0.15 * f.weeds * (1 - f.weeds) * (1 - f.growth * 0.75) + 0.002), 0, 0.95);
      if (f.growth < 0.85) lose(f, 'chwasty', 0.5 * f.weeds * c.weedSens * dG);
      // choroby
      const fav = tmean > 8 && tmean < 26 && (moist > 0.55 || wx.rainFell > 3);
      if (!(f.prot.fungicyd > d.dayIndex) && c.diseaseSens > 0) {
        const young = Math.min(1, 0.3 + f.growth / 0.25);          // młode rośliny chorują mniej
        if (fav) f.disease = clamp(f.disease + (0.16 * f.disease * (1 - f.disease) + 0.006) * young * c.diseaseSens * (f.rotBad ? 1.45 : 1) * (f.tilled === 'min' ? 1.15 : 1), 0, 0.95);
        else f.disease = clamp(f.disease * 0.97, 0, 1);
      }
      lose(f, 'choroby', 0.55 * f.disease * dG);
      // szkodniki
      if (!(f.prot.insektycyd > d.dayIndex) && c.pestSens > 0) {
        if (tmean > 10 && f.growth > 0.12 && f.growth < 0.8) f.pests = clamp(f.pests + (0.14 * f.pests * (1 - f.pests) + 0.005) * c.pestSens, 0, 0.95);
        else f.pests = clamp(f.pests * 0.95, 0, 1);
      }
      lose(f, 'szkodniki', 0.45 * f.pests * dG);
    } else {
      // sąsiedzi prowadzą pola „poprawnie”: lekki obraz chwastów, bez strat
      f.weeds = 0.05 + 0.1 * f.growth; f.disease = 0.05; f.pests = 0.03;
      const stress = moist < 0.38 ? clamp((0.38 - moist) / 0.3, 0, 1) : 0;
      if (stress > 0) lose(f, 'susza', 0.06 * stress * dG * c.droughtSens);
    }
    // dojrzałość
    if (f.growth >= 1) {
      f.phase = 'ripe'; f.ripeDays = 0;
      if (player) G.notify('🌾 ' + p.name + ': ' + c.short + ' dojrzał' + (c.short.endsWith('a') ? 'a' : c.short.endsWith('i') ? 'y' : 'o') + ' — czas na zbiór (okno ~' + c.window + ' dni)', 'good', { parcel: p.id, key: 'ripe' + p.id });
    }
  }

  function frostHail(f, p, c, wx, d, player) {
    const snowProt = wx.snow > 5 ? 10 : wx.snow > 1 ? 5 : 0;
    const harden = f.sowF < 1 ? 3 : 0;          // późny siew = słabsze zahartowanie
    if (c.winter) {
      const thr = c.frostKill + harden - snowProt;   // śnieg chroni oziminy przed wymarzaniem
      if (wx.tmin < thr && f.phase !== 'ripe') {
        const dmg = Math.min(0.5, 0.04 * (thr - wx.tmin));
        lose(f, 'mróz', dmg);
        if (player) G.notify('🥶 ' + p.name + ': ' + c.short + ' przemarza (' + G.fmtNum(wx.tmin) + ' °C bez okrywy śnieżnej) — straty ~' + Math.round(dmg * 100) + '%', 'bad', { parcel: p.id, key: 'frost' + p.id });
      }
    } else if (!c.winter && f.growth > 0.02 && f.growth < 0.35 && wx.tmin < c.frostKill) {
      const dmg = Math.min(0.4, 0.06 * (c.frostKill - wx.tmin));
      lose(f, 'mróz', dmg);
      if (player) G.notify('🥶 ' + p.name + ': przymrozek uszkodził wschody (' + c.short + ', −' + Math.round(dmg * 100) + '%)', 'bad', { parcel: p.id, key: 'frost' + p.id });
    }
    // jesienny mróz kończy wegetację upraw jarych: dojrzałe w ≥ 75% → wymuszone dojrzewanie (plon niższy),
    // mniej → rośliny giną (zostaje resztka plonu)
    if (!c.winter && f.phase !== 'ripe' && f.growth > 0.35 && wx.tmin < -3 && d.month >= 8) {
      const g = f.growth;
      lose(f, 'mróz', g >= 0.75 ? (1 - g) * 1.6 : 0.6 + (0.75 - g));
      f.growth = 1; f.gdd = c.gdd; f.phase = 'ripe'; f.ripeDays = 0;
      if (player) G.notify('🥶 ' + p.name + ': mróz zakończył wegetację (' + c.short + ' dojrzał' + (g >= 0.75 ? 'a przedwcześnie' : 'a tylko w ' + Math.round(g * 100) + '%') + ') — zbieraj', 'bad', { parcel: p.id });
    }
    if (wx.hail && f.growth > 0.3) {
      const h = wx.hail, dist = Math.hypot(p.cx - h.x, p.cy - h.y);
      if (dist < h.r) {
        const dmg = h.sev * (f.growth > 0.6 ? 1 : 0.5) * (1 - dist / h.r * 0.5);
        lose(f, 'grad', dmg);
        if (player) G.notify('🧊 Grad nad polem ' + p.name + ' — zniszczone ~' + Math.round(dmg * 100) + '% plonu', 'bad', { parcel: p.id });
      }
    }
  }

  function meadowDay(f, p, c, wx, d, moist, player) {
    if (d.month === 2 && d.dom === 1) { f.cuts = 0; f.gdd = Math.min(f.gdd, 30); f.growth = Math.min(f.growth, 0.08); }
    if (f.phase === 'grass') {
      const water = moist < 0.35 ? clamp(moist / 0.35, 0.25, 1) : 1;
      const need = f.cuts === 0 ? c.gddFirst : c.gdd;
      const dg = Math.max(0, wx.tmean - c.tbase) * RD * water;
      const g0 = f.growth;
      f.gdd += dg;
      f.growth = Math.min(1.4, f.gdd / need);
      const dG = Math.max(0, Math.min(1, f.growth) - Math.min(1, g0));
      if (player) for (const key of ['n', 'p', 'k']) { const dem = c[key + 'Need'] * dG, take = Math.min(Math.max(0, f[key]), dem); f.up[key] += take; f[key] -= take; }
      if (moist < 0.3) lose(f, 'susza', 0.02 * c.droughtSens);
      if (f.growth > 1.15) f.quality = clamp(f.quality - 0.03, 0.55, 1);   // przerośnięta trawa drewnieje
      if (d.month >= 10 || d.month <= 1) { f.growth = Math.min(f.growth, Math.max(0.15, f.growth - 0.15)); f.gdd = f.growth * need; }
      if (player && g0 < 1 && f.growth >= 1 && d.month >= 4 && d.month <= 8) G.notify('🌿 ' + p.name + ': trawa gotowa do koszenia (' + (f.cuts + 1) + '. pokos)', 'good', { parcel: p.id, key: 'mow' + p.id });
    } else if (f.phase === 'mown') {
      const t = wx.type, rain = wx.rainFell;
      if (rain > 1) { f.dry = clamp(f.dry - 0.25, 0, 1); f.swath *= 0.93; f.quality = clamp(f.quality - 0.08, 0.4, 1); }
      else f.dry = clamp(f.dry + (t === 'clear' ? 0.45 : t === 'fog' ? 0.12 : 0.25) * (f.raked ? 1.3 : 1) * (wx.tmean > 15 ? 1.15 : 0.8), 0, 1);
      f.hDays++;
      if (f.hDays > 8) {
        if (player) G.notify('🍂 ' + p.name + ': pokos zgnił na łące (nie zebrany w porę)', 'bad', { parcel: p.id });
        regrow(f);
      }
    }
  }
  // obniżenie potencjału plonu z zapisem przyczyny (do podsumowania strat w UI)
  function lose(f, cause, x) {
    if (!(x > 0)) return;
    x = Math.min(0.9, x);
    f.yp *= 1 - x;
    const L = f.loss || (f.loss = {});
    L[cause] = (L[cause] || 0) - Math.log(1 - x);
  }
  function regrow(f) { f.phase = 'grass'; f.growth = 0; f.gdd = 0; f.up = { n: 0, p: 0, k: 0 }; f.yp = 1; f.loss = {}; f.swath = 0; f.dry = 0; f.raked = false; f.quality = 1; f.cuts++; f.hDays = 0; }

  // ---------------------------------------------------------------------------------------------------------------
  // AUTOPILOT SĄSIADÓW (bez maszyn — postęp pracy rysowany pasami przez tileState)
  // ---------------------------------------------------------------------------------------------------------------
  function npcPick(f, p, m) {
    const s = f.soil, prev = (f.history[0] && f.history[0].crop) || f.last;
    const opts = s >= 5 ? ['zyto', 'zyto', 'pszenzyto', 'owies', 'ziemniaki'] : s >= 4 ? ['pszenzyto', 'pszenica', 'jeczmien', 'owies', 'kukurydza', 'ziemniaki', 'zyto']
      : ['pszenica', 'pszenica', 'rzepak', 'jeczmien', 'jeczmien_ozimy', 'kukurydza', 'buraki', 'kiszonka', 'pszenzyto'];
    // preferuj uprawy, które da się jeszcze posiać w tym/najbliższym terminie i które mają dobry przedplon
    let best = null, bs = -1;
    for (const id of opts) {
      const c = G.CROPS[id];
      let sc = rnd() + (c.rotation.good.indexOf(prev) >= 0 ? 0.6 : 0) - (c.rotation.bad.indexOf(prev) >= 0 ? 0.8 : 0);
      if (c.winter && (m > c.sowMonths[c.sowMonths.length - 1] && m < 11)) sc -= 2;   // po terminie siewu oziminy → jara
      if (sc > bs) { bs = sc; best = id; }
    }
    return best;
  }
  function npcDaily(f, p, d) {
    const n = f.npc; if (!n || n.task) return;
    const m = d.month, wet = G.S.weather && G.S.weather.today && G.S.weather.today.rain > 6;
    const task = (op, extra) => { n.task = Object.assign({ op, start: G.S.tick + 6 + ((rnd() * 3) | 0), dur: 5 + Math.min(10, p.area * 0.8) }, extra || {}); };
    if (wet || (G.S.weather && G.S.weather.frozen)) return;
    switch (f.phase) {
      case 'ripe': if (rnd() < 0.55) task('harvest'); break;
      case 'harvested': if (f.straw > 0 && rnd() < 0.35) task('bale'); break;
      case 'stubble': case 'fallow': {
        if (!n.plan) n.plan = npcPick(f, p, m);
        const c = G.CROPS[n.plan];
        const plowNow = c.winter ? (c.sowMonths.indexOf(m) >= 0 || m === (c.sowMonths[0] + 11) % 12) : (m >= 8 && m <= 10) || m === 2;
        if (plowNow && rnd() < 0.4) task('plow');
        break;
      }
      case 'plowed': case 'cultivated': {
        if (!n.plan) n.plan = npcPick(f, p, m);
        const c = G.CROPS[n.plan];
        if (c.sowMonths.indexOf(m) >= 0 && rnd() < 0.45) task('sow', { crop: n.plan });
        else if (c.winter && m > c.sowMonths[c.sowMonths.length - 1] && m < 11) n.plan = null;
        break;
      }
      case 'grass': if (f.growth >= 1 && m >= 4 && m <= 8 && rnd() < 0.5) task('mow'); break;
      case 'mown': if ((f.dry >= 0.6 || f.hDays >= 3) && rnd() < 0.6) task('bale'); break;
    }
  }
  function npcFinish(f, p, t) {
    const c = G.CROPS[f.crop];
    switch (t.op) {
      case 'plow': f.phase = 'plowed'; f.weeds = 0.03; f.tilled = 'plow'; f.straw = 0; break;
      case 'sow': f.n = 60; establish(f, t.crop, day(), {}); f.gdd = 0; f.growth = 0; f.phase = 'sown'; f.weeds = 0.04; f.npc.plan = null; f.yp = NPC_MGMT; break;
      case 'harvest':
        if (c) { f.history.unshift({ crop: f.crop, year: G.date().year, yield: r2(estimate(f, p)), area: p.area }); f.history.length = Math.min(6, f.history.length); }
        f.last = f.crop; f.straw = c && c.byproduct ? c.byproduct.perT * estimate(f, p) * p.area : 0; f.crop = null; f.phase = 'harvested'; f.hDays = 0; f.growth = 0; f.gdd = 0;
        break;
      case 'bale':
        if (p.kind === 'meadow') regrow(f); else { f.straw = 0; f.phase = 'stubble'; }
        break;
      case 'mow': f.phase = 'mown'; f.dry = 0; f.hDays = 0; f.swath = 10 * p.area; break;
    }
    f.npc.task = null;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // ZABIEGI GRACZA: walidacja, praca per kafel, zakończenie
  // ---------------------------------------------------------------------------------------------------------------
  function inputFor(f, op, params) {
    const o = F.OPS[op];
    if (!o || !o.needsInput) return null;
    return o.needsInput(params || {}, f);
  }
  F.inputFor = function (pid, op, params) {
    const f = F.get(pid), p = parcel(pid);
    const inp = f && inputFor(f, op, params || {});
    if (!inp || !inp.id) return null;
    const total = inp.rate * p.area;
    return { id: inp.id, rate: inp.rate, perTile: inp.rate * TILE_HA, total: r2(total * 1000) / 1000, have: G.inv.get(inp.id),
      cost: Math.round(total * (G.market && G.market.buyPrice ? G.market.buyPrice(inp.id) : (G.PRODUCTS[inp.id] ? G.PRODUCTS[inp.id].base : 0))) };
  };
  function missingText(id) {
    const pr = G.PRODUCTS[id];
    if (!pr) return 'brak: ' + id;
    if (pr.cat === 'nasiona') return 'brak nasion';
    if (id === 'herbicyd' || id === 'fungicyd' || id === 'insektycyd') return 'brak środka ochrony (' + pr.name + ')';
    if (id === 'wapno') return 'brak wapna';
    return 'brak nawozu (' + pr.name + ')';
  }

  function check(f, p, op, params, opts) {
    opts = opts || {};
    const o = F.OPS[op];
    if (!o) return { ok: false, reason: 'Nieznany zabieg' };
    if (!f || !p) return { ok: false, reason: 'Brak działki' };
    if (!isPlayer(p) && !opts.any) return { ok: false, reason: 'To nie Twoja działka' };
    if (o.kind === 'field' && p.kind === 'meadow') return { ok: false, reason: 'Na łące nie wykonuje się tego zabiegu' };
    if (o.kind === 'meadow' && p.kind !== 'meadow') return { ok: false, reason: 'Ten zabieg jest dla łąk' };
    const cont = f.work && f.work.op === op && f.work.key === keyOf(op, params);
    if (o.phases.indexOf(f.phase) < 0 && !cont) {
      const why = {
        plow: f.phase === 'plowed' ? 'Pole jest już zaorane' : (f.crop ? 'Na polu rośnie ' + G.CROPS[f.crop].short + ' — najpierw zbiór' : 'Teraz nie można orać'),
        cultivate: f.crop ? 'Na polu rośnie uprawa' : 'Pole jest już uprawione',
        sow: f.crop ? 'Pole jest już obsiane' : 'Najpierw zaoraj lub uprawiaj pole (orka / agregat)',
        harvest: f.crop ? ('Uprawa jeszcze nie dojrzała: ' + G.CROPS[f.crop].short + ' (' + Math.round(f.growth * 100) + '%)') : 'Nie ma czego zbierać',
        spray: 'Oprysk tylko na rosnącą uprawę',
        bale: 'Nie ma słomy ani pokosu do prasowania',
        mow: f.phase === 'mown' ? 'Łąka już skoszona — zbierz pokos' : 'Teraz nie można kosić',
        rake: 'Najpierw skoś łąkę',
        lime: 'Nie wapnuj rosnącej uprawy — zrób to po zbiorze, przed orką',
        fertilize: 'Teraz nie można nawozić'
      };
      return { ok: false, reason: why[op] || ('Zabieg niedostępny w fazie: ' + F.PHASE_NAMES[f.phase]) };
    }
    const d = G.date();
    let warn = null;
    params = params || {};
    if (op === 'sow') {
      const c = G.CROPS[params.crop];
      if (!c || c.meadow) return { ok: false, reason: 'Wybierz uprawę do siewu' };
      const t = F.sowTiming(params.crop, d.month);
      if (!t) return { ok: false, reason: 'Termin siewu: ' + monthsText(c.sowMonths) + ' (teraz ' + G.MONTHS[d.month] + ')' };
      if (t < 1) warn = 'Termin nieoptymalny — plon ok. ' + Math.round((1 - t) * 100) + '% niższy';
      if (params.crop === 'ziemniaki' && f.tilled !== 'plow') return { ok: false, reason: 'Ziemniaki wymagają orki przed sadzeniem' };
      const rot = F.rotation(f, params.crop);
      if (rot.bad) warn = (warn ? warn + '; ' : '') + 'Płodozmian: ' + rot.text;
    }
    if (op === 'fertilize') {
      const id = params.product || 'saletra';
      if (F.OPS.fertilize.products.indexOf(id) < 0) return { ok: false, reason: 'Nieznany nawóz' };
      if (d.month === 11 || d.month <= 1) return { ok: false, reason: 'Program azotanowy: zakaz nawożenia od 1 grudnia do końca lutego' };
      if ((id === 'obornik' || id === 'gnojowica') && (f.phase === 'sown' || f.phase === 'growing')) return { ok: false, reason: 'Nawozy naturalne stosuj przed orką/siewem (nie na rosnącą uprawę)' };
      if (id === 'saletra' && f.crop && G.CROPS[f.crop] && f.growth > 0.75) warn = 'Za późno — azot już prawie nie zwiększy plonu';
      if (id === 'saletra' && !f.crop && d.month >= 8) warn = 'Azot jesienią na puste pole w dużej części wypłucze się przez zimę';
    }
    if (op === 'spray') {
      const id = params.product || 'herbicyd';
      if (F.OPS.spray.products.indexOf(id) < 0) return { ok: false, reason: 'Nieznany środek' };
      if (id === 'herbicyd' && f.growth > 0.6) warn = 'Uprawa za duża — herbicyd słabo działa';
    }
    if (op === 'bale') {
      if (f.phase === 'harvested' && !(f.straw > 0.5)) return { ok: false, reason: 'Po tej uprawie nie ma słomy do zbioru' };
      if (f.phase === 'mown' && params.product === 'siano' && f.dry < 1) return { ok: false, reason: 'Siano jeszcze nie wyschło (' + Math.round(f.dry * 100) + '%) — poczekaj albo zrób sianokiszonkę' };
    }
    if (op === 'mow' && f.growth < 0.4) return { ok: false, reason: 'Trawa za niska (' + Math.round(f.growth * 100) + '%)' };
    if (op === 'harvest' && f.crop && G.CROPS[f.crop]) {
      const pr = G.CROPS[f.crop].product, est = estimate(f, p) * p.area;
      if (G.inv.free(pr) < est) warn = 'W magazynie zmieści się tylko ' + G.fmtQty(pr, G.inv.free(pr)) + ' z ~' + G.fmtQty(pr, est) + ' — resztę trzeba sprzedać z przyczepy';
    }
    // środki z magazynu
    const inp = inputFor(f, op, params);
    let need = null;
    if (inp && inp.id) {
      const done = cont ? f.work.count : 0;
      const qty = inp.rate * TILE_HA * (p.tiles.length - done);
      const have = G.inv.get(inp.id);
      need = { id: inp.id, qty: Math.round(qty * 1000) / 1000, have, rate: inp.rate };
      if (!opts.skipInv) {
        if (have + 1e-9 < inp.rate * TILE_HA) return { ok: false, reason: missingText(inp.id) + ' — potrzeba ' + G.fmtQty(inp.id, qty), need };
        if (have + 1e-9 < qty) warn = (warn ? warn + '; ' : '') + 'Środków starczy na ' + Math.floor(have / (inp.rate * TILE_HA) * TILE_HA * 100) / 100 + ' z ' + G.fmtNum(p.area) + ' ha';
      }
    }
    const r = { ok: true };
    if (warn) r.warn = warn;
    if (need) r.need = need;
    return r;
  }
  F.canDo = function (pid, op, params) {
    const f = F.get(pid), p = parcel(pid);
    return check(f, p, op, params || {});
  };
  function keyOf(op, params) { params = params || {}; return op + ':' + (params.product || params.crop || ''); }

  function startWork(f, p, op, params) {
    if (f.work) finalize(f, p, f.work);
    const w = { op, key: keyOf(op, params), params: JSON.parse(JSON.stringify(params || {})), done: new Uint8Array(p.tiles.length), count: 0, used: 0, input: null, out: {}, acc: 0, t0: G.S.tick };
    const inp = inputFor(f, op, params);
    if (inp) w.input = inp.id;
    if (op === 'harvest') { w.yph = estimate(f, p); w.product = G.CROPS[f.crop].product; w.crop = f.crop; }
    if (op === 'bale') {
      if (p.kind === 'meadow') {
        w.product = params.product || (f.dry >= 1 ? 'siano' : 'sianokiszonka');
        w.yph = f.swath / p.area * (f.raked ? 1.05 : 1) * (w.product === 'sianokiszonka' ? 1.0 : 1);
      } else { w.product = 'sloma'; w.yph = f.straw / p.area; }
    }
    f.work = w;
    return w;
  }

  F.workTile = function (pid, i, op, params) {
    params = params || {};
    const f = F.get(pid), p = parcel(pid);
    if (!f || !p) return { error: 'brak działki' };
    if (!pos) buildPos();
    if (G.S.map.parcel[i] !== pid) return { error: 'kafel poza działką' };
    if (!f.work || f.work.op !== op || f.work.key !== keyOf(op, params)) {
      const c = check(f, p, op, params, { skipInv: true });
      if (!c.ok) return { error: c.reason };
      startWork(f, p, op, params);
    }
    const w = f.work, k = pos[i];
    if (w.done[k]) return { out: {}, already: true, done: w.count, total: p.tiles.length };
    // wyjście (zbiór / prasowanie) — najpierw sprawdzamy miejsce w magazynie
    let out = null, acc = w.acc;
    const store = op !== 'harvest' && !params.noStore;     // zbiór → plon odwozi moduł prac
    if (w.product) {
      const q = w.yph * TILE_HA;
      const unit = G.PRODUCTS[w.product] ? G.PRODUCTS[w.product].unit : 't';
      let give;
      if (unit === 'bela' || unit === 'szt') { acc += q; give = Math.floor(acc + 1e-6); acc -= give; }   // całe bele, reszta przechodzi dalej
      else give = Math.round(q * 1000) / 1000;
      if (give > 0 && store && G.inv.free(w.product) + 1e-9 < give) return { error: 'brak miejsca w magazynie' };
      out = {}; out[w.product] = give;
    }
    // środki z magazynu
    const inp = inputFor(f, op, params);
    if (inp && inp.id) {
      const need = inp.rate * TILE_HA;
      if (!G.inv.take(inp.id, need)) return { error: missingText(inp.id) };
      w.used += need;
    }
    w.acc = acc;
    if (out) {
      for (const id in out) {
        if (out[id] > 0 && store) G.inv.add(id, out[id]);
        w.out[id] = (w.out[id] || 0) + out[id];
      }
    }
    w.done[k] = 1; w.count++;
    return { out: out || {}, done: w.count, total: p.tiles.length };
  };

  // zakończenie zabiegu: dokańcza pozostałe kafle (chyba że params.partial) i zmienia fazę
  F.complete = function (pid, op, params) {
    params = params || {};
    const f = F.get(pid), p = parcel(pid);
    if (!f || !p) return { ok: false, reason: 'Brak działki' };
    if (!pos) buildPos();
    if (!f.work || f.work.op !== op || f.work.key !== keyOf(op, params)) {
      const c = check(f, p, op, params, { skipInv: true });
      if (!c.ok) return { ok: false, reason: c.reason };
      startWork(f, p, op, params);
    }
    const w = f.work;
    let err = null;
    const rest = {};                       // plon z kafli dokończonych tutaj (przy zbiorze moduł prac musi go jeszcze odwieźć)
    if (!params.partial) {
      for (const i of p.tiles) {
        if (w.done[pos[i]]) continue;
        const r = F.workTile(pid, i, op, params);
        if (r.error) { err = r.error; break; }
        for (const id in r.out) rest[id] = Math.round(((rest[id] || 0) + r.out[id]) * 1000) / 1000;
      }
    }
    const res = finalize(f, p, w);
    f.work = null;
    f.yieldEst = r2(estimate(f, p));
    G.emit('opDone', pid, op);
    return Object.assign({ ok: true, coverage: r2(w.count / p.tiles.length), out: w.out, outRest: rest }, err ? { error: err } : {}, res || {});
  };

  function finalize(f, p, w) {
    const cov = w.count / p.tiles.length, d = G.date(), player = isPlayer(p), params = w.params || {};
    const rateHa = w.used / p.area;
    if (w.count === 0) return null;
    switch (w.op) {
      case 'plow':
        if (cov >= 0.5) {
          if (f.straw > 0) { f.k += f.straw / p.area * 4; f.straw = 0; f.flags.strawInc = d.year; }
          if (d.dayIndex - f.manureDay <= 1) f.flags.ecoManure = d.year;
          f.phase = 'plowed'; f.tilled = 'plow'; f.crop = null; f.growth = 0;
        }
        f.weeds = f.weeds * (1 - 0.92 * cov) + 0.02;
        break;
      case 'cultivate':
        if (cov >= 0.5) {
          if (f.straw > 0) { f.k += f.straw / p.area * 4; f.straw = 0; f.flags.strawInc = d.year; }
          if (f.phase !== 'plowed') f.tilled = 'min';
          f.phase = 'cultivated';
        }
        f.weeds = f.weeds * (1 - 0.5 * cov);
        break;
      case 'lime':
        f.phPend += rateHa * 0.15;
        if (rateHa >= 1) f.flags.limed = d.year;
        if (player) G.notify('⚪ ' + p.name + ': wapno rozsiane (' + G.fmtNum(rateHa) + ' t/ha) — pH wzrośnie o ~' + G.fmtNum(rateHa * 0.15, 2) + ' w ciągu 2 miesięcy', 'info', { parcel: p.id });
        break;
      case 'fertilize': {
        const id = w.input, nut = G.NUTRIENTS[id] || { n: 0, p: 0, k: 0 };
        f.n += rateHa * nut.n; f.p += rateHa * nut.p; f.k += rateHa * nut.k;
        if (id === 'saletra') f.ph -= rateHa * 340 * 0.0006;
        if (id === 'obornik' || id === 'gnojowica') { f.manureDay = d.dayIndex; if (f.phase === 'plowed' || f.phase === 'cultivated') f.flags.ecoManure = d.year; }
        if (p.kind === 'meadow' && id === 'saletra') f.yp = Math.min(1, f.yp + 0.02);
        break;
      }
      case 'sow': {
        const cid = params.crop, c = G.CROPS[cid];
        if (cov >= 0.3 && c) {
          const tilled = f.tilled, bed = f.phase === 'plowed' ? 0.95 : tilled === 'min' ? 0.97 : 1;
          const rot = F.rotation(f, cid);
          f.crop = cid; f.phase = 'sown'; f.growth = 0; f.gdd = 0; f.plantedAt = d.dayIndex; f.cropYear = cropYearFor(cid, d);
          f.up = { n: 0, p: 0, k: 0 }; f.yp = 1; f.loss = {}; f.lateLoss = 0; f.ripeDays = 0; f.quality = 1; f.prot = {}; f.lostWarn = 0; f.vern = false;
          f.rotF = rot.f; f.rotBad = rot.bad; f.sowF = F.sowTiming(cid, d.month) || 0.8; f.bedF = bed; f.cover = cov; f.luck = 0.95 + rnd() * 0.1;
          f.disease = rot.bad ? 0.03 : 0.01; f.pests = 0.01;
          f.weeds = tilled === 'min' ? Math.max(0.15, f.weeds) : Math.max(0.03, f.weeds * 0.5);
          if (tilled === 'min') f.flags.noTill = d.year;
          f.harvestedQty = 0;
          if (player) G.notify('🌱 ' + p.name + ': zasiano ' + c.short + ' (' + G.fmtNum(p.area * cov) + ' ha)' + (rot.bad ? ' — uwaga: ' + rot.text : ''), rot.bad ? 'warn' : 'good', { parcel: p.id });
        }
        break;
      }
      case 'spray': {
        const id = w.input;
        if (id === 'herbicyd') { f.weeds *= 1 - 0.9 * cov * (f.growth > 0.6 ? 0.5 : 1); if (cov > 0.5) f.prot.herbicyd = d.dayIndex + 8; }
        if (id === 'fungicyd') { f.disease *= 1 - 0.8 * cov; if (cov > 0.5) f.prot.fungicyd = d.dayIndex + 10; }
        if (id === 'insektycyd') { f.pests *= 1 - 0.85 * cov; if (cov > 0.5) f.prot.insektycyd = d.dayIndex + 8; }
        break;
      }
      case 'harvest': {
        const c = G.CROPS[w.crop], q = w.out[w.product] || 0;
        const yHa = q / Math.max(0.01, p.area * cov);
        if (cov >= 0.97 || f.cover * (1 - cov) < 0.05) {
          f.history.unshift({ crop: w.crop, year: d.year, yield: r2(yHa * (cov >= 0.97 ? 1 : 1)), area: p.area, qty: r2((f.harvestedQty || 0) + q), quality: r2(f.quality) });
          if (f.history.length > 8) f.history.length = 8;
          // słoma: 0,8–1,0 t na tonę ziarna → perT bel (250 kg) na tonę zebranego ziarna
          f.straw = c.byproduct ? Math.round(c.byproduct.perT * ((f.harvestedQty || 0) + q)) : 0;
          f.last = w.crop; f.crop = null; f.phase = 'harvested'; f.hDays = 0; f.growth = 0; f.gdd = 0; f.yp = 1; f.loss = {}; f.cover = 1; f.lateLoss = 0;
          f.weeds = Math.min(f.weeds, 0.3); f.disease = 0; f.pests = 0; f.up = { n: 0, p: 0, k: 0 }; f.prot = {}; f.harvestedQty = 0;
          if (w.crop === 'rzepak') f.n += 25;   // resztki rzepaku zostawiają azot
        } else {
          f.cover *= (1 - cov); f.harvestedQty = (f.harvestedQty || 0) + q;
        }
        G.emit('harvest', p.id, w.product, q);
        if (player) G.notify('🌾 ' + p.name + ': zebrano ' + G.fmtQty(w.product, q) + ' (' + G.fmtNum(yHa, 1) + ' t/ha)', 'good', { parcel: p.id });
        return { yieldHa: r2(yHa), qty: r2(q) };
      }
      case 'bale': {
        const q = w.out[w.product] || 0;
        if (p.kind === 'meadow') {
          f.swath *= (1 - cov);
          if (f.swath < 0.5 || cov >= 0.97) regrow(f);
        } else {
          f.straw *= (1 - cov);
          if (f.straw < 0.5 || cov >= 0.97) { f.straw = 0; f.phase = 'stubble'; }
        }
        G.emit('harvest', p.id, w.product, q);
        if (player) G.notify('🟨 ' + p.name + ': ' + G.fmtQty(w.product, q) + ' — ' + G.PRODUCTS[w.product].name.toLowerCase(), 'good', { parcel: p.id });
        return { qty: q };
      }
      case 'mow': {
        if (cov >= 0.5) {
          const c = G.CROPS.trawa;
          f.swath = Math.round(estimate(f, p) * p.area * cov * (f.quality < 0.8 ? 0.95 : 1) * 10) / 10;
          f.phase = 'mown'; f.dry = 0; f.hDays = 0; f.raked = false;
          void c;
        }
        break;
      }
      case 'rake': f.dry = clamp(f.dry + 0.25 * cov, 0, 1); f.raked = true; break;
    }
    return null;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // GRAFIKA: stan kafla (szybkie — wołane dla każdego widocznego kafla przy rysowaniu)
  // Zwraca { crop, phase, growth, worked, weeds, op } lub null (kafel poza działką).
  //  - Dla kafli obrobionych w bieżącym zabiegu `phase` jest już fazą PO zabiegu (np. 'plowed' w trakcie orki,
  //    'harvested' w trakcie zbioru, 'sown' + nowa uprawa w trakcie siewu), a worked = true.
  //  - Na ściernisku/po zbiorze `crop` = poprzednia uprawa (np. ściernisko kukurydziane wygląda inaczej), growth = 0.
  //  - straw: true, gdy na polu leży słoma (po zbiorze); swath: true dla pokosu na łące.
  // ---------------------------------------------------------------------------------------------------------------
  F.tileState = function (i) {
    const S = G.S, pid = S.map.parcel[i];
    if (pid < 0) return null;
    const f = S.fields && S.fields[pid];
    if (!f) return null;
    if (!pos) buildPos();
    let phase = f.phase, crop = f.crop, growth = f.growth > 1 ? 1 : f.growth, worked = false, op = null;
    const w = f.work;
    if (w) {
      op = w.op;
      if (w.done[pos[i]]) {
        worked = true;
        const a = AFTER[op];
        if (a) phase = a;
        if (op === 'sow') { crop = w.params.crop; growth = 0; }
        else if (op === 'harvest') { growth = 0; }
        else if (op === 'bale') { phase = f.phase === 'mown' ? 'grass' : 'stubble'; growth = 0; }
      }
    } else if (f.npc && f.npc.task) {
      const t = f.npc.task, prog = (S.tick + (G.hourFrac || 0) - t.start) / t.dur;
      if (prog > 0) {
        op = t.op;
        if (pos[i] < prog * f.npcLen) {
          worked = true;
          const a = AFTER[t.op];
          if (a) phase = a;
          if (t.op === 'sow') { crop = t.crop; growth = 0; }
          else if (t.op === 'harvest') growth = 0;
          else if (t.op === 'bale') { phase = f.phase === 'mown' ? 'grass' : 'stubble'; growth = 0; }
        }
      }
    }
    if (!crop && (phase === 'stubble' || phase === 'harvested')) crop = f.last;
    return { crop, phase, growth, worked, weeds: f.weeds, op, straw: phase === 'harvested' && f.straw > 0, swath: phase === 'mown' };
  };

  // ---------------------------------------------------------------------------------------------------------------
  // UI: opis działki, zalecenia, planer upraw
  // ---------------------------------------------------------------------------------------------------------------
  function stageText(f, c, d) {
    if (!c) return '';
    const g = f.growth;
    if (f.phase === 'ripe') return 'dojrzałość pełna';
    if (f.phase === 'sown') return 'kiełkowanie';
    if (c.winter && !c.meadow && (d.month >= 11 || d.month <= 1) && g < 0.4) return 'spoczynek zimowy';
    const T = {
      grain: [[0.08, 'wschody'], [0.3, 'krzewienie'], [0.5, 'strzelanie w źdźbło'], [0.65, 'kłoszenie i kwitnienie'], [0.9, 'nalewanie ziarna'], [1.01, 'dojrzewanie']],
      rapeseed: [[0.3, 'rozeta'], [0.45, 'pąkowanie'], [0.6, 'kwitnienie'], [0.85, 'tworzenie łuszczyn'], [1.01, 'dojrzewanie']],
      maize: [[0.1, 'wschody'], [0.45, 'faza liści'], [0.6, 'wiechowanie'], [0.85, 'nalewanie ziarna'], [1.01, 'dojrzewanie']],
      root: [[0.1, 'wschody'], [0.35, 'rozwój naci'], [0.5, 'kwitnienie, zawiązywanie bulw'], [0.85, 'przyrost bulw'], [1.01, 'zasychanie naci']],
      beet: [[0.1, 'wschody'], [0.3, 'rozwój liści'], [0.5, 'zakrywanie międzyrzędzi'], [0.8, 'przyrost korzeni'], [1.01, 'gromadzenie cukru']],
      grass: [[0.5, 'odrost'], [0.9, 'pełnia wzrostu'], [1.15, 'gotowa do koszenia'], [9, 'przerośnięta']]
    }[c.look.style] || [];
    for (const [t, n] of T) if (g < t) return n;
    return '';
  }
  function level(v) { return v < 0.12 ? 'brak' : v < 0.3 ? 'niskie' : v < 0.55 ? 'średnie' : 'wysokie'; }

  // zalecane zabiegi na działce: [{ op, params, label, why, priority (1 pilne … 3 do rozważenia), ok, reason }]
  function recommend(f, p) {
    const d = G.date(), m = d.month, out = [], c = G.CROPS[f.crop];
    const add = (op, params, label, why, priority) => {
      const r = check(f, p, op, params);
      out.push({ op, params, label, why, priority, ok: r.ok, reason: r.reason || r.warn || '' });
    };
    if (f.work) add(f.work.op, f.work.params, 'Dokończ: ' + F.OPS[f.work.op].name.toLowerCase(), 'Zabieg przerwany na ' + Math.round(f.work.count / p.tiles.length * 100) + '% pola', 1);
    const noFert = m === 11 || m <= 1;
    if (p.kind === 'meadow') {
      if (f.phase === 'grass') {
        if (f.growth >= 0.95 && m >= 4 && m <= 9) add('mow', {}, 'Skoś łąkę', 'Trawa w pełni wzrostu (' + Math.round(f.growth * 100) + '%)' + (f.growth > 1.15 ? ' — już przerośnięta, traci wartość' : '') + '. Sprawdź prognozę: potrzebne 2–3 dni bez deszczu na siano.', 1);
        if (!noFert && f.n < 40 && f.growth < 0.6 && m >= 2 && m <= 7) add('fertilize', { product: 'saletra', rate: 0.25 }, 'Nawieź łąkę saletrą', 'Mało azotu (' + Math.round(f.n) + ' kg/ha) — trawa odrośnie słabiej. ~0,25 t/ha po każdym pokosie.', 2);
        if (f.ph < 5.4 && f.phPend < 0.1) add('lime', { rate: 2 }, 'Zwapnuj łąkę', 'pH ' + G.fmtNum(f.ph, 1) + ' — trawy plonują gorzej, rośnie mech.', 3);
      } else if (f.phase === 'mown') {
        if (f.dry >= 1) add('bale', { product: 'siano' }, 'Zbierz siano (prasa)', 'Pokos suchy — siano gotowe. Deszcz obniży jakość.', 1);
        else {
          if (!f.raked) add('rake', {}, 'Przetrząśnij/zgrab pokos', 'Przyspieszy schnięcie (sucho: ' + Math.round(f.dry * 100) + '%).', 2);
          add('bale', { product: 'sianokiszonka' }, 'Zrób sianokiszonkę', 'Podsuszony pokos (' + Math.round(f.dry * 100) + '%) można od razu zebrać w owijane bele — nie czekasz na pogodę.', f.dry >= 0.3 ? 2 : 3);
        }
      }
      return out;
    }
    switch (f.phase) {
      case 'harvested':
        if (f.straw > 0) add('bale', {}, 'Zbierz słomę w bele', '~' + Math.round(f.straw) + ' bel (≈' + G.fmtMoney(f.straw * (G.market ? G.market.price('sloma') : 55)) + '). Albo zostaw — po 10 dniach zostanie rozdrobniona (potas, ekoschemat).', 2);
        // dalej jak ściernisko
      // falls through
      case 'stubble': case 'fallow': {
        if (f.ph < 6.0 && f.phPend < 0.1) add('lime', { rate: f.ph < 5.3 ? 4 : 3 }, 'Zwapnuj pole', 'pH ' + G.fmtNum(f.ph, 1) + ' — kwaśna gleba obniża plony (jęczmień, buraki, rzepak najbardziej). Ekoschemat ~150 zł/ha.', f.ph < 5.5 ? 1 : 2);
        if (G.inv.get('obornik') >= 25 * TILE_HA && !noFert) add('fertilize', { product: 'obornik', rate: 25 }, 'Rozrzuć obornik przed orką', 'Obornik dostarcza P i K oraz próchnicy; przyoranie w 1 dzień = ekoschemat ~200 zł/ha.', 2);
        const sug = F.suggestCrops(p.id).filter(s => s.soonDays <= 8);
        const next = sug[0];
        const prio = next ? (next.soonDays <= 2 ? 1 : 2) : 3;
        add('plow', {}, 'Zaoraj pole', next ? 'Przed siewem: ' + next.name + ' (' + next.when + '). Orka niszczy chwasty (' + Math.round(f.weeds * 100) + '%) i resztki z chorobami.' : 'Orka jesienna (zimowa) przygotuje pole pod uprawy jare.', prio);
        if (next && next.soonDays <= 2) add('cultivate', {}, 'Uprawa bezorkowa (agregat)', 'Taniej i szybciej niż orka; ekoschemat „uproszczona uprawa” ~230 zł/ha, ale więcej chwastów i chorób.', 3);
        break;
      }
      case 'plowed': case 'cultivated': {
        const sug = F.suggestCrops(p.id);
        const now = sug.filter(s => s.okNow);
        if (f.phase === 'plowed') add('cultivate', {}, 'Uprawa przedsiewna', 'Wyrównanie roli przed siewem: +5% plonu względem siewu w surową orkę.', now.length ? 2 : 3);
        if (f.p < 60 || f.k < 80) add('fertilize', { product: 'npk', rate: 0.3 }, 'Nawóz NPK przed siewem', 'Mało fosforu/potasu (P ' + Math.round(f.p) + ', K ' + Math.round(f.k) + ' kg/ha) — wymieszaj z glebą przed siewem.', 2);
        if (f.ph < 5.8 && f.phPend < 0.1) add('lime', { rate: 3 }, 'Zwapnuj pole', 'pH ' + G.fmtNum(f.ph, 1) + ' — przed siewem warto odkwasić.', 2);
        for (const s of now.slice(0, 3)) add('sow', { crop: s.crop }, 'Siej: ' + s.name, 'Prognoza ' + G.fmtNum(s.yieldHa, 1) + ' t/ha, nadwyżka ~' + G.fmtMoney(s.marginHa) + '/ha. ' + s.notes, s === now[0] ? 1 : 2);
        if (!now.length && sug[0]) out.push({ op: null, params: null, label: 'Czekaj na termin siewu', why: 'Najbliższy: ' + sug[0].name + ' — ' + sug[0].when, priority: 3, ok: false, reason: '' });
        break;
      }
      case 'sown': case 'growing': {
        const day0 = d.dayIndex;
        if (f.weeds > 0.22 && f.growth < 0.65 && !(f.prot.herbicyd > day0)) add('spray', { product: 'herbicyd' }, 'Oprysk na chwasty', 'Zachwaszczenie ' + Math.round(f.weeds * 100) + '% — każdy dzień zwłoki obniża plon.', f.weeds > 0.4 ? 1 : 2);
        if (f.disease > 0.2 && !(f.prot.fungicyd > day0)) add('spray', { product: 'fungicyd' }, 'Oprysk fungicydem', 'Choroby grzybowe ' + Math.round(f.disease * 100) + '% (wilgotno).', f.disease > 0.35 ? 1 : 2);
        if (f.pests > 0.2 && !(f.prot.insektycyd > day0)) add('spray', { product: 'insektycyd' }, 'Oprysk na szkodniki', 'Szkodniki ' + Math.round(f.pests * 100) + '% ' + (f.crop === 'rzepak' ? '(słodyszek, chowacze)' : f.crop === 'ziemniaki' ? '(stonka)' : ''), f.pests > 0.35 ? 1 : 2);
        const autumnCereal = c && c.winter && c.group === 'zboże' && m >= 8 && m <= 10;   // jesienią zboża ozime nie potrzebują azotu
        if (c && !noFert && !autumnCereal && f.growth < 0.7) {
          // liczymy tylko to, co roślina jeszcze może pobrać (wcześniejszego niedoboru nie da się nadrobić)
          const future = c.nNeed * (1 - f.growth), avail = Math.max(0, f.n) + MIN_N[f.soil] * 0.45 * (1 - f.growth);
          const deficit = future - avail;
          if (deficit > Math.max(15, future * 0.12)) {
            const rate = clamp(Math.round(deficit / 340 / 0.05) * 0.05, 0.1, 0.35);
            const springWinter = c.winter && m >= 2 && m <= 4;
            add('fertilize', { product: 'saletra', rate }, 'Nawóz azotowy (saletra ' + G.fmtNum(rate, 2) + ' t/ha)', 'Brakuje ~' + Math.round(deficit) + ' kg N/ha — prognoza plonu wzrośnie. ' + (springWinter ? 'Wiosenny start wegetacji oziminy — najlepszy moment.' : ''), (springWinter || f.growth > 0.15) ? 1 : 2);
          }
        }
        break;
      }
      case 'ripe': {
        const fc = G.weather.forecast || [];
        const rainSoon = fc.slice(1, 3).some(x => x.rain > 3);
        add('harvest', {}, 'Zbiór: ' + (c ? c.short : ''), 'Dojrzałe od ' + f.ripeDays + ' dni (okno ' + (c ? c.window : '?') + ' dni). ' + (rainSoon ? 'Prognoza deszczu — zbieraj teraz!' : '') + (f.lateLoss > 0 ? ' Straty już ' + Math.round(f.lateLoss * 100) + '%.' : ''), 1);
        break;
      }
    }
    out.sort((a, b) => a.priority - b.priority);
    return out;
  }

  // planer: uprawy, które można siać na działce — prognoza plonu i opłacalność (przy pełnym nawożeniu)
  // → [{ crop, name, yieldHa, priceT, revenueHa, costHa, marginHa, okNow, soonDays, when, notes, rotation }]
  F.suggestCrops = function (pid) {
    const f = F.get(pid), p = parcel(pid);
    if (!f || !p || p.kind === 'meadow') return [];
    const d = G.date(), list = [];
    const price = (id, m) => (G.market && G.market.expectedPrice) ? G.market.expectedPrice(id, m) : G.PRODUCTS[id].base;
    const bprice = id => (G.market && G.market.buyPrice) ? G.market.buyPrice(id) : G.PRODUCTS[id].base;
    for (const id of G.CROP_LIST_FIELD) {
      const c = G.CROPS[id];
      // dni do najbliższego terminu siewu
      let soon = 99;
      for (let k = 0; k < 12; k++) { if (F.sowTiming(id, (d.month + k) % 12) >= 1) { soon = k === 0 ? 0 : k * C.DAYS_PER_MONTH - (d.dom - 1); break; } }
      const okNow = F.sowTiming(id, d.month) > 0;
      const rot = F.rotation(f, id);
      // prognoza przy pełnym nawożeniu i ochronie, z typowymi stratami (~12%) i dodatkowym ryzykiem przy złym płodozmianie
      const y = c.yieldBase * F.soilFactor(id, f.soil) * F.phFactor(id, f.ph + f.phPend) * rot.f * 0.88 * (rot.bad ? 0.92 : 1);
      let cost = c.seedRate * bprice(c.seed);
      for (const k in c.inputsHa) cost += c.inputsHa[k] * bprice(k);
      // cena oczekiwana w miesiącu zbioru (sezonowość), słoma liczona w 40% (koszt prasowania)
      const hm = c.harvestMonths[Math.min(1, c.harvestMonths.length - 1)];
      const strawV = c.byproduct ? c.byproduct.perT * y * price(c.byproduct.id, hm) * 0.4 : 0;
      const rev = y * price(c.product, hm) + strawV;
      const notes = [];
      if (rot.text) notes.push(rot.text);
      if (c.soilPref.indexOf(f.soil) < 0) notes.push('gleba kl. ' + G.SOIL_NAMES[f.soil] + ' nie jest dla niej najlepsza');
      if (F.phFactor(id, f.ph) < 0.95) notes.push('za kwaśno (pH ' + G.fmtNum(f.ph, 1) + ', optimum ' + c.phOpt + ')');
      if (id === 'buraki') notes.push('najlepiej z umową z cukrownią');
      if (id === 'ziemniaki') notes.push('potrzebna sadzarka i kopaczka lub usługa');
      if (id === 'kiszonka') notes.push('pasza dla bydła — sprzedaż lokalna taniej');
      list.push({ crop: id, name: c.name, yieldHa: r2(y), priceT: Math.round(price(c.product, hm)), revenueHa: Math.round(rev), costHa: Math.round(cost), marginHa: Math.round(rev - cost),
        okNow, soonDays: soon, when: soon === 0 ? 'teraz' : (okNow ? 'teraz (późno)' : 'za ~' + soon + ' dni (' + monthsText(c.sowMonths) + ')'), notes: notes.join('; '), rotation: r2(rot.f) });
    }
    list.sort((a, b) => (b.okNow - a.okNow) || (a.soonDays > 12) - (b.soonDays > 12) || b.marginHa - a.marginHa);
    return list;
  };

  // opis działki dla UI
  F.summary = function (pid) {
    const f = F.get(pid), p = parcel(pid);
    if (!f || !p) return null;
    const d = G.date(), c = G.CROPS[f.crop];
    const est = estimate(f, p);
    const s = {
      pid, name: p.name, area: p.area, kind: p.kind, owner: p.owner, leased: !!p.leased, soil: f.soil, soilName: G.SOIL_NAMES[f.soil],
      crop: f.crop, cropName: c ? c.name : null, prevCrop: f.last, prevCropName: f.last && G.CROPS[f.last] ? G.CROPS[f.last].name : null,
      phase: f.phase, phaseName: F.PHASE_NAMES[f.phase], stage: stageText(f, c, d), growth: r2(Math.min(1, f.growth)), growthPct: Math.round(Math.min(1, f.growth) * 100),
      product: c ? c.product : null, productName: c ? G.PRODUCTS[c.product].name : null, unit: c ? G.PRODUCTS[c.product].unit : null,
      yieldEst: r2(est), yieldTotal: r2(est * p.area), valueEst: c ? Math.round(est * p.area * (G.market ? G.market.price(c.product) : G.PRODUCTS[c.product].base)) : 0,
      yieldBase: c ? c.yieldBase : null, daysToHarvest: null, ripeDays: f.phase === 'ripe' ? f.ripeDays : null, window: c ? c.window : null,
      n: Math.round(f.n), p: Math.round(f.p), k: Math.round(f.k), ph: r2(f.ph), phPending: r2(f.phPend), phOpt: c ? c.phOpt : 6.5,
      nNeed: c ? c.nNeed : 0, pNeed: c ? c.pNeed : 0, kNeed: c ? c.kNeed : 0,
      nRatio: c ? r2(nutRatio(f, c, 'n')) : null, pRatio: c ? r2(nutRatio(f, c, 'p')) : null, kRatio: c ? r2(nutRatio(f, c, 'k')) : null,
      weeds: r2(f.weeds), disease: r2(f.disease), pests: r2(f.pests), weedsText: level(f.weeds), diseaseText: level(f.disease), pestsText: level(f.pests),
      moisture: f.moisture, quality: r2(f.quality), straw: Math.round(f.straw || 0), swath: Math.round(f.swath || 0), dry: r2(f.dry || 0), cuts: f.cuts,
      protection: Object.keys(f.prot || {}).filter(k => f.prot[k] > d.dayIndex).map(k => ({ product: k, days: f.prot[k] - d.dayIndex })),
      work: f.work ? { op: f.work.op, name: F.OPS[f.work.op].name, done: f.work.count, total: p.tiles.length, pct: Math.round(f.work.count / p.tiles.length * 100) } : null,
      npcTask: f.npc && f.npc.task ? F.OPS[f.npc.task.op].name : null,
      history: (f.history || []).slice(0, 5).map(h => ({ crop: h.crop, cropName: G.CROPS[h.crop] ? G.CROPS[h.crop].name : h.crop, year: h.year, yield: h.yield })),
      factors: [], warnings: [], next: [],
      // straty potencjału plonu wg przyczyny: [{ cause, pct }] (np. susza 12%, chwasty 5%)
      losses: Object.keys(f.loss || {}).map(k => ({ cause: k, pct: Math.round((1 - Math.exp(-f.loss[k])) * 100) })).filter(x => x.pct > 0).sort((a, b) => b.pct - a.pct)
    };
    if (c && !c.meadow && (f.phase === 'sown' || f.phase === 'growing')) s.daysToHarvest = G.weather.daysToGdd(c.tbase, d.dayIndex, c.gdd - f.gdd, 200);
    if (c && c.meadow && f.phase === 'grass') s.daysToHarvest = G.weather.daysToGdd(c.tbase, d.dayIndex, Math.max(0, (f.cuts === 0 ? c.gddFirst : c.gdd) - f.gdd), 100);
    if (c && (f.phase === 'sown' || f.phase === 'growing' || f.phase === 'ripe' || c.meadow)) {
      const fac = (name, v, text) => s.factors.push({ name, value: r2(v), text });
      fac('Gleba kl. ' + G.SOIL_NAMES[f.soil], F.soilFactor(f.crop, f.soil), c.soilPref.indexOf(f.soil) >= 0 ? 'odpowiednia' : 'nie najlepsza dla tej uprawy');
      fac('pH ' + G.fmtNum(f.ph, 1), F.phFactor(f.crop, f.ph), 'optimum ' + c.phOpt);
      fac('Nawożenie NPK', nutFactor(f, c), 'N ' + Math.round(nutRatio(f, c, 'n') * 100) + '%, P ' + Math.round(nutRatio(f, c, 'p') * 100) + '%, K ' + Math.round(nutRatio(f, c, 'k') * 100) + '% potrzeb');
      if (!c.meadow) {
        fac('Płodozmian', f.rotF, F.rotation(f, f.crop).text);
        if (f.sowF < 1) fac('Termin siewu', f.sowF, 'siew poza optymalnym terminem');
        if (f.bedF < 1) fac('Przygotowanie roli', f.bedF, f.tilled === 'min' ? 'uprawa uproszczona' : 'siew w surową orkę');
        if (f.cover < 0.99) fac('Obsiana część pola', f.cover, Math.round(f.cover * 100) + '%');
      }
      fac('Stresy (susza, chwasty, choroby…)', f.yp, f.yp > 0.97 ? 'niewielkie' : s.losses.map(x => x.cause + ' ' + x.pct + '%').join(', '));
      if (f.lateLoss > 0) fac('Opóźniony zbiór', 1 - f.lateLoss, 'osypywanie/porastanie');
    }
    const W = s.warnings;
    if (f.ph < 5.5) W.push('Gleba kwaśna (pH ' + G.fmtNum(f.ph, 1) + ') — wapnowanie');
    if (c && !c.meadow && s.nRatio != null && s.nRatio < 0.7 && f.growth < 0.7) W.push('Niedobór azotu — plon niższy o ~' + Math.round((1 - (0.35 + 0.65 * Math.pow(s.nRatio, 0.7))) * 100) + '%');
    if (f.p < 40) W.push('Niska zasobność w fosfor'); if (f.k < 60) W.push('Niska zasobność w potas');
    if (f.weeds > 0.35 && c && !c.meadow) W.push('Silne zachwaszczenie');
    if (f.disease > 0.3) W.push('Choroby grzybowe'); if (f.pests > 0.3) W.push('Szkodniki');
    if (f.moisture < 0.3) W.push('Susza glebowa'); if (f.rotBad && c) W.push('Zły płodozmian');
    if (f.phase === 'ripe' && c && f.ripeDays >= c.window - 1) W.push('Koniec okna zbioru — straty rosną');
    if (f.phase === 'mown' && f.hDays >= 5) W.push('Pokos leży za długo — zbierz, zanim zgnije');
    if (isPlayer(p)) s.next = recommend(f, p);
    return s;
  };
  // krótki przegląd pól gracza (lista w UI)
  F.overview = function () {
    return G.playerParcels().map(p => {
      const f = F.get(p.id), c = G.CROPS[f.crop];
      return { pid: p.id, name: p.name, area: p.area, kind: p.kind, crop: f.crop, cropName: c ? c.name : null, phase: f.phase, phaseName: F.PHASE_NAMES[f.phase],
        growth: r2(Math.min(1, f.growth)), yieldEst: r2(estimate(f, p)), work: f.work ? f.work.op : null };
    });
  };

  // globalne zalecenia „co teraz robić” → [{ key, pid, op, params, icon, title, text, priority (1..3), action: 'job'|'market'|'loan'|'land'|null }]
  F.advice = function () {
    const out = [], d = G.date();
    for (const p of G.playerParcels()) {
      const f = F.get(p.id);
      const rec = recommend(f, p);
      for (const r of rec.slice(0, 2)) {
        if (!r.op) continue;
        out.push({ key: p.id + ':' + r.op + ':' + ((r.params && (r.params.product || r.params.crop)) || ''), pid: p.id, op: r.op, params: r.params,
          icon: F.OPS[r.op].icon, title: p.name + ': ' + r.label, text: r.why + (r.ok ? '' : ' (' + r.reason + ')'), priority: r.priority, action: 'job', ok: r.ok });
      }
    }
    // pogoda
    const fc = G.weather.forecast || [];
    const ripe = G.playerParcels().filter(p => F.get(p.id).phase === 'ripe');
    if (ripe.length && fc[1] && fc[1].rain > 3) out.push({ key: 'rain_harvest', pid: null, op: null, icon: '🌧️', title: 'Jutro deszcz — kończ zbiory', text: 'Dojrzałe pola: ' + ripe.map(p => p.name).join(', ') + '. Po deszczu kombajn stoi, a ziarno traci jakość.', priority: 1, action: null });
    // braki środków na zalecane zabiegi
    const need = {};
    for (const a of out) if (a.op && a.pid != null) {
      const inp = F.inputFor(a.pid, a.op, a.params);
      if (inp && inp.have < inp.total) need[inp.id] = (need[inp.id] || 0) + inp.total - inp.have;
    }
    for (const id in need) {
      const pr = G.PRODUCTS[id];
      out.push({ key: 'buy_' + id, pid: null, op: null, icon: pr.icon, title: 'Kup: ' + pr.name, text: 'Do zaplanowanych zabiegów brakuje ' + G.fmtQty(id, need[id]) + (G.market ? ' (~' + G.fmtMoney(need[id] * G.market.buyPrice(id)) + ')' : ''), priority: 2, action: 'market', product: id, qty: Math.ceil(need[id] * 10) / 10 });
    }
    if (G.market && G.market.advice) for (const a of G.market.advice()) out.push(a);
    if (G.land && G.land.advice) for (const a of G.land.advice()) out.push(a);
    void d;
    out.sort((a, b) => a.priority - b.priority);
    return out;
  };

  // statystyki dla dopłat (ekoschematy) — ha spełniające warunki w danym roku
  F.ecoStats = function (year) {
    const r = { arableHa: 0, meadowHa: 0, limedHa: 0, manureHa: 0, strawHa: 0, noTillHa: 0 };
    for (const p of G.playerParcels()) {
      const f = F.get(p.id); if (!f) continue;
      if (p.kind === 'meadow') r.meadowHa += p.area; else r.arableHa += p.area;
      if (f.flags.limed === year) r.limedHa += p.area;
      if (f.flags.ecoManure === year && p.kind !== 'meadow') r.manureHa += p.area;
      if (f.flags.strawInc === year && p.kind !== 'meadow') r.strawHa += p.area;
      if (f.flags.noTill === year && p.kind !== 'meadow') r.noTillHa += p.area;
    }
    return r;
  };
  // struktura upraw gracza teraz: { cropId: ha }
  F.cropAreas = function () {
    const r = {};
    for (const p of G.playerParcels()) {
      if (p.kind === 'meadow') continue;
      const f = F.get(p.id), c = f.crop || (f.phase === 'harvested' || f.phase === 'stubble' ? f.last : null);
      if (c) r[c] = (r[c] || 0) + p.area;
    }
    return r;
  };

  // ---------------------------------------------------------------------------------------------------------------
  // HOOKI
  // ---------------------------------------------------------------------------------------------------------------
  G.on('newGame', () => { buildPos(); initAll(); });
  G.on('load', () => {
    if (!G.S.fields) initAll();
    validate();
    for (const p of G.S.parcels) G.S.fields[p.id].npcLen = p.tiles.length;
  });
  G.on('daily', d => {
    const S = G.S, wx = S.weather && S.weather.last;
    if (!S.fields || !wx) return;
    for (const p of S.parcels) {
      const f = S.fields[p.id];
      if (!f) continue;
      dayUpdate(f, p, wx, d);
      if (f.npc) npcDaily(f, p, d);
      f.yieldEst = r2(estimate(f, p));
    }
  });
  G.on('tick', () => {
    const S = G.S; if (!S.fields) return;
    for (const p of S.parcels) {
      const f = S.fields[p.id];
      if (f && f.npc && f.npc.task && S.tick >= f.npc.task.start + f.npc.task.dur) npcFinish(f, p, f.npc.task);
    }
  });
  // zmiana właściciela (moduł ziemi): przejęcie pola od sąsiada lub oddanie
  G.on('landBought', p => {
    const f = p && F.get(p.id); if (!f) return;
    if (f.npc && f.npc.task) f.npc.task = null;
    f.npc = null;
    // sąsiad prowadził pole „idealnie” — przy przejęciu przeliczamy pobranie składników do tej pory
    const c = G.CROPS[f.crop];
    if (c) for (const key of ['n', 'p', 'k']) f.up[key] = Math.max(f.up[key], c[key + 'Need'] * Math.min(1, f.growth));
  });
  G.on('landSold', p => { const f = p && F.get(p.id); if (f) { f.npc = { task: null, plan: null }; f.work = null; } });
})();
