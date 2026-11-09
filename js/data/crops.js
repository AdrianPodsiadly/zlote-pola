// Złote Pola — uprawy, nasiona, środki do produkcji roślinnej → G.CROPS, G.PRODUCTS (agent: uprawy i rynek)
//
// SKALA CZASU: rok gry = 72 dni (miesiąc = 6 dni), więc 1 dzień gry ≈ 5,07 dnia kalendarzowego.
// Rozwój roślin liczymy sumą temperatur efektywnych (GDD, °C·doba, liczone dla PRAWDZIWYCH dni):
//   dzienny przyrost = max(0, t_średnia − tbase) × 5,07, roślina dojrzewa po osiągnięciu `gdd`.
// Dzięki temu terminy dojrzewania wychodzą jak w Polsce (pszenica ~20 lipca, rzepak ~10 lipca, kukurydza na ziarno
// ~październik), a ciepły/zimny rok przyspiesza/opóźnia żniwa.
//
// PLONY — KALIBRACJA DO ŚREDNICH GUS: yieldBase (t/ha) = POTENCJAŁ na glebie kl. III przy pełnym NPK, pH optymalnym,
// bez stresów ≈ średnia GUS × 1,15–1,3 (dobrane symulacją tak, by średnie plony sąsiadów-NPC na ich glebach ≈ GUS). Typowe stresy (susza, chwasty, choroby) zabierają 5–15%, więc:
//   przeciętna agrotechnika, gleba III–IV  → ≈ średnia GUS (sąsiedzi-NPC mają stały współczynnik 0,85);
//   gleba I–II + pełne nawożenie + ochrona → +25–40% względem GUS;   gleba V–VI → −30–45% (żyto/owies mniej).
// Średnie GUS: pszenica ozima 5,3–5,6; jara 3,9; jęczmień ozimy 4,6; jary 3,8; żyto 3,1–3,4; pszenżyto ozime 4,45;
//   owies 3,0; kukurydza ziarno 7,3; kiszonka 45–50 (zielonka); rzepak 3,0–3,2; ziemniaki 28–30; buraki 60–65;
//   łąka 2–3 pokosy, 6–8 t s.m./ha/rok.
// SŁOMA: 0,8–1,0 t słomy na 1 t ziarna; bela okrągła ~250 kg → byproduct.perT = bel na tonę ziarna (pszenica 3,6).
//   byproduct.perHa = orientacyjnie przy przeciętnym plonie (dla UI/kalkulacji; faktycznie liczone z perT × plon).
// GĘSTOŚĆ (PRODUCTS[id].density, t/m³ — dla zbiorników kombajnów i przyczep): pszenica 0,77, jęczmień 0,65, owies 0,5…
// Rzeczywisty plon = yieldBase × gleba × pH × NPK × płodozmian × termin siewu × stresy (susza, chwasty, choroby,
// szkodniki, mróz, grad) × straty przy opóźnionym zbiorze — patrz sim/fields.js.
//
// BALANS „DOBRA AGROTECHNIKA vs ZANIEDBANIE” (G.AGRO, dostrojone symulacją 3-letnią, ≥ 10 ziaren pogody; patrz
// /tmp/zp_crops/year_sim.py): przy samym siewie i zbiorze pszenica traci ok. 35–45% z braku azotu (krzywa z nasyceniem:
// fN = nFloor + (1 − nFloor)·rN^nExp, rN = pobrany N / potrzeba; bez nawożenia rN ≈ 0,3–0,45 z mineralizacji),
// P/K ograniczają dopiero przy wyczerpanej zasobności (fP = pkFloor + (1 − pkFloor)·r^pkExp; zapasy glebowe odbudowują się
// tylko ~40%/rok, więc w 2.–3. roku bez NPK pojawia się niedobór), chwasty bez herbicydu −25–30%, choroby bez fungicydu
// w mokry rok −15–30%, szkodniki w rzepaku bez insektycydu −10–25%. Wapno działa przez pH (optimum per uprawa, ~2 mies.).
// Wynik docelowy: dobry wariant ma więcej pieniędzy w ≥ 85% symulacji po 2 latach i średnio ≥ +30% po 3 latach;
// leniwy nie bankrutuje w 1. roku, ale w 3. roku ma wyraźne kłopoty.
//
// CENY (base) — orientacyjnie rynek PL 2025/26 (skup netto przy gospodarstwie / cena w sklepie rolniczym):
//   pszenica konsumpcyjna ~850 zł/t, rzepak ~1950 zł/t, kukurydza sucha ~750 zł/t, saletra amonowa ~1500 zł/t,
//   Polifoska 6-20-30 ~2200 zł/t, wapno węglanowe ~280 zł/t (z dowozem), nasiona kwalifikowane pszenicy ~2,6 zł/kg.
(function () {
  // ---------------------------------------------------------------------------------------------------------------
  // UPRAWY
  // pola wg DESIGN.md + rozszerzenia:
  //   gdd, tbase       – suma temperatur do dojrzałości i temperatura bazowa
  //   soilSens         – wrażliwość na słabą glebę (pszenica/buraki wysoka, żyto niska)
  //   phSens           – wrażliwość na zakwaszenie (jęczmień, buraki – wysoka; żyto, ziemniaki – niska)
  //   droughtSens      – wrażliwość na suszę; weedSens/diseaseSens/pestSens – podatność na agrofagi
  //   window           – okno zbioru w dniach gry po dojrzeniu (potem straty: osypywanie, porastanie, gnicie)
  //   breakYears       – minimalna przerwa w uprawie na tym samym polu (lata)
  //   frostKill        – temperatura (°C), poniżej której ozimina bez okrywy śnieżnej wymarza
//   autumnMax        – oziminy: maks. ułamek rozwoju przed jaryzacją (VIII–II), domyślnie 0,25
  //   group            – grupa płodozmianowa: 'zboże' | 'oleiste' | 'okopowe' | 'kukurydza' | 'trawa'
  //   inputsHa         – typowe zużycie środków na ha (do kalkulacji opłacalności w planerze)
  //   look             – dla grafiki: style, green (kolor łanu w wzroście), ripe (dojrzały), height (m), flower?
  // Miesiące: 0 = styczeń … 11 = grudzień.
  // ---------------------------------------------------------------------------------------------------------------
  G.CROPS = {
    pszenica: {
      name: 'Pszenica ozima', short: 'pszenica', winter: true, group: 'zboże',
      sowMonths: [8, 9], harvestMonths: [6, 7], growDays: 58, gdd: 2200, tbase: 0,
      seedRate: 200, seed: 'nasiona_pszenica', yieldBase: 7.2, product: 'pszenica', byproduct: { id: 'sloma', perT: 3.6, perHa: 19 },
      nNeed: 170, pNeed: 60, kNeed: 90, phOpt: 6.5, phSens: 1.0, soilPref: [1, 2, 3], soilSens: 1.15, droughtSens: 1.0,
      weedSens: 1.0, diseaseSens: 1.1, pestSens: 0.5, window: 5, breakYears: 0, frostKill: -20,
      rotation: { bad: ['pszenica', 'pszenica_jara', 'pszenzyto', 'jeczmien', 'jeczmien_ozimy', 'zyto'], good: ['rzepak', 'ziemniaki', 'buraki', 'owies'] },
      inputsHa: { saletra: 0.45, npk: 0.3, herbicyd: 2, fungicyd: 1.2, insektycyd: 0.2 },
      look: { style: 'grain', green: '#5f9a3a', ripe: '#d9b44a', height: 0.9 },
      desc: 'Najważniejsze zboże w Polsce. Wymaga dobrej gleby (kl. I–IIIb), pH 6–7 i solidnego nawożenia azotem. Najlepiej po rzepaku lub okopowych.'
    },
    pszenzyto: {
      name: 'Pszenżyto ozime', short: 'pszenżyto', winter: true, group: 'zboże',
      sowMonths: [8, 9], harvestMonths: [6, 7], growDays: 57, gdd: 2150, tbase: 0,
      seedRate: 180, seed: 'nasiona_pszenzyto', yieldBase: 6.0, product: 'pszenzyto', byproduct: { id: 'sloma', perT: 4.0, perHa: 18 },
      nNeed: 140, pNeed: 55, kNeed: 90, phOpt: 6.0, phSens: 0.8, soilPref: [2, 3, 4, 5], soilSens: 0.85, droughtSens: 0.85,
      weedSens: 0.85, diseaseSens: 0.8, pestSens: 0.4, window: 5, breakYears: 0, frostKill: -18,
      rotation: { bad: ['pszenzyto', 'pszenica', 'zyto'], good: ['rzepak', 'ziemniaki', 'kukurydza', 'kiszonka', 'owies'] },
      inputsHa: { saletra: 0.35, npk: 0.25, herbicyd: 2, fungicyd: 0.8 },
      look: { style: 'grain', green: '#5a9440', ripe: '#cfa848', height: 1.1 },
      desc: 'Zboże paszowe na gorsze gleby (kl. IIIb–V). Mniej wymagające niż pszenica, dobre do żywienia świń i bydła.'
    },
    zyto: {
      name: 'Żyto ozime', short: 'żyto', winter: true, group: 'zboże',
      sowMonths: [8, 9], harvestMonths: [6, 7], growDays: 54, gdd: 2000, tbase: 0,
      seedRate: 160, seed: 'nasiona_zyto', yieldBase: 4.4, product: 'zyto', byproduct: { id: 'sloma', perT: 4.4, perHa: 15 },
      nNeed: 110, pNeed: 50, kNeed: 90, phOpt: 5.5, phSens: 0.5, soilPref: [4, 5, 6], soilSens: 0.55, droughtSens: 0.6,
      weedSens: 0.6, diseaseSens: 0.6, pestSens: 0.3, window: 5, breakYears: 0, frostKill: -25, autumnMax: 0.28,
      rotation: { bad: ['zyto', 'pszenzyto'], good: ['ziemniaki', 'owies', 'rzepak'] },
      inputsHa: { saletra: 0.25, npk: 0.2, herbicyd: 1.5, fungicyd: 0.5 },
      look: { style: 'grain', green: '#6a9a4a', ripe: '#c8a650', height: 1.4 },
      desc: 'Zboże słabych, piaszczystych gleb (kl. IV–VI). Mrozoodporne i odporne na suszę, mało nawozów, niższa cena.'
    },
    jeczmien: {
      name: 'Jęczmień jary', short: 'jęczmień', winter: false, group: 'zboże',
      sowMonths: [2, 3], harvestMonths: [6, 7], growDays: 40, gdd: 1550, tbase: 0,
      seedRate: 180, seed: 'nasiona_jeczmien', yieldBase: 4.4, product: 'jeczmien', byproduct: { id: 'sloma', perT: 3.2, perHa: 12 },
      nNeed: 110, pNeed: 50, kNeed: 80, phOpt: 6.5, phSens: 1.4, soilPref: [1, 2, 3, 4], soilSens: 1.0, droughtSens: 1.1,
      weedSens: 1.0, diseaseSens: 0.9, pestSens: 0.4, window: 5, breakYears: 0, frostKill: -10,
      rotation: { bad: ['jeczmien', 'jeczmien_ozimy', 'pszenica', 'pszenzyto'], good: ['ziemniaki', 'buraki', 'kukurydza', 'rzepak'] },
      inputsHa: { saletra: 0.3, npk: 0.25, herbicyd: 1.5, fungicyd: 0.8 },
      look: { style: 'grain', green: '#6aa547', ripe: '#e0c46a', height: 0.75 },
      desc: 'Szybkie zboże jare (siew marzec–kwiecień). Bardzo wrażliwe na kwaśną glebę — przed siewem sprawdź pH.'
    },
    jeczmien_ozimy: {
      name: 'Jęczmień ozimy', short: 'jęczmień ozimy', winter: true, group: 'zboże',
      sowMonths: [8], harvestMonths: [5, 6], growDays: 52, gdd: 1950, tbase: 0,
      seedRate: 160, seed: 'nasiona_jeczmien', yieldBase: 5.75, product: 'jeczmien', byproduct: { id: 'sloma', perT: 3.4, perHa: 14 },
      nNeed: 140, pNeed: 55, kNeed: 90, phOpt: 6.5, phSens: 1.3, soilPref: [1, 2, 3, 4], soilSens: 1.0, droughtSens: 0.9,
      weedSens: 0.9, diseaseSens: 1.0, pestSens: 0.4, window: 5, breakYears: 0, frostKill: -14,
      rotation: { bad: ['jeczmien', 'jeczmien_ozimy', 'pszenica', 'pszenzyto'], good: ['rzepak', 'ziemniaki', 'kukurydza', 'kiszonka', 'owies'] },
      inputsHa: { saletra: 0.4, npk: 0.25, herbicyd: 2, fungicyd: 1 },
      look: { style: 'grain', green: '#62a043', ripe: '#dcc068', height: 0.85 },
      desc: 'Najwcześniej zbierane zboże (koniec czerwca/lipiec) — zwalnia pole pod rzepak. Mniej mrozoodporny niż pszenica.'
    },
    pszenica_jara: {
      name: 'Pszenica jara', short: 'pszenica jara', winter: false, group: 'zboże',
      sowMonths: [2, 3], harvestMonths: [7], growDays: 44, gdd: 1700, tbase: 0,
      seedRate: 220, seed: 'nasiona_pszenica', yieldBase: 4.9, product: 'pszenica', byproduct: { id: 'sloma', perT: 3.4, perHa: 13 },
      nNeed: 130, pNeed: 50, kNeed: 80, phOpt: 6.5, phSens: 1.0, soilPref: [1, 2, 3], soilSens: 1.1, droughtSens: 1.1,
      weedSens: 1.0, diseaseSens: 0.9, pestSens: 0.4, window: 5, breakYears: 0, frostKill: -8,
      rotation: { bad: ['pszenica', 'pszenica_jara', 'pszenzyto', 'jeczmien', 'zyto'], good: ['rzepak', 'ziemniaki', 'buraki', 'kukurydza', 'owies'] },
      inputsHa: { saletra: 0.35, npk: 0.25, herbicyd: 1.5, fungicyd: 1 },
      look: { style: 'grain', green: '#66a23f', ripe: '#ddb950', height: 0.8 },
      desc: 'Gdy nie zdążysz z siewem oziminy — siew w marcu/kwietniu. Plon niższy niż ozimej, ale dobra cena.'
    },
    owies: {
      name: 'Owies', short: 'owies', winter: false, group: 'zboże',
      sowMonths: [2, 3], harvestMonths: [6, 7], growDays: 42, gdd: 1650, tbase: 0,
      seedRate: 180, seed: 'nasiona_owies', yieldBase: 3.75, product: 'owies', byproduct: { id: 'sloma', perT: 4.0, perHa: 12 },
      nNeed: 100, pNeed: 50, kNeed: 90, phOpt: 5.8, phSens: 0.6, soilPref: [3, 4, 5], soilSens: 0.65, droughtSens: 1.2,
      weedSens: 0.7, diseaseSens: 0.6, pestSens: 0.3, window: 5, breakYears: 3, frostKill: -8,
      rotation: { bad: ['owies'], good: ['ziemniaki', 'kukurydza', 'kiszonka', 'buraki'] },
      inputsHa: { saletra: 0.25, npk: 0.2, herbicyd: 1.5 },
      look: { style: 'grain', green: '#74a85a', ripe: '#d6c27c', height: 1.0 },
      desc: 'Roślina „fitosanitarna” — przerywa choroby zbóż, dobry przedplon pod pszenicę. Lubi wilgoć, znosi słabsze gleby.'
    },
    rzepak: {
      name: 'Rzepak ozimy', short: 'rzepak', winter: true, group: 'oleiste',
      sowMonths: [7], harvestMonths: [6], growDays: 64, gdd: 2500, tbase: 0,
      seedRate: 3, seed: 'nasiona_rzepak', yieldBase: 3.5, product: 'rzepak', byproduct: null,
      nNeed: 200, pNeed: 80, kNeed: 150, phOpt: 6.5, phSens: 1.1, soilPref: [1, 2, 3], soilSens: 1.2, droughtSens: 0.9,
      weedSens: 0.8, diseaseSens: 1.0, pestSens: 1.4, window: 4, breakYears: 3, frostKill: -15, autumnMax: 0.38,
      rotation: { bad: ['rzepak', 'buraki'], good: ['jeczmien', 'jeczmien_ozimy', 'pszenica', 'pszenzyto', 'owies', 'zyto'] },
      inputsHa: { saletra: 0.6, npk: 0.4, herbicyd: 2, fungicyd: 1.5, insektycyd: 0.6 },
      look: { style: 'rapeseed', green: '#3f8a3a', ripe: '#8a7a3a', height: 1.5, flower: '#f2d43a' },
      desc: 'Najbardziej dochodowa roślina towarowa na dobrych glebach. Siew w sierpniu, zbiór w lipcu. Uprawiaj co 4 lata — inaczej kiła i szkodniki.'
    },
    kukurydza: {
      name: 'Kukurydza na ziarno', short: 'kukurydza', winter: false, group: 'kukurydza',
      sowMonths: [3, 4], harvestMonths: [8, 9, 10], growDays: 44, gdd: 1500, tbase: 6,
      seedRate: 25, seed: 'nasiona_kukurydza', yieldBase: 8.4, product: 'kukurydza', byproduct: null,
      nNeed: 180, pNeed: 80, kNeed: 160, phOpt: 6.3, phSens: 0.9, soilPref: [1, 2, 3, 4], soilSens: 1.0, droughtSens: 1.1,
      weedSens: 1.4, diseaseSens: 0.5, pestSens: 0.8, window: 12, breakYears: 0, frostKill: -2,
      rotation: { bad: [], good: ['pszenica', 'pszenzyto', 'jeczmien', 'owies', 'zyto'] },
      inputsHa: { saletra: 0.4, npk: 0.35, herbicyd: 2.5, insektycyd: 0.3 },
      look: { style: 'maize', green: '#3e8a2e', ripe: '#b59a52', height: 2.6 },
      desc: 'Siew w drugiej połowie kwietnia (gleba ≥ 8–10 °C). Bardzo wrażliwa na zachwaszczenie w młodości. Znosi uprawę po sobie.'
    },
    kiszonka: {
      name: 'Kukurydza na kiszonkę', short: 'kukurydza (kiszonka)', winter: false, group: 'kukurydza',
      sowMonths: [3, 4], harvestMonths: [7, 8], growDays: 40, gdd: 1350, tbase: 6,
      seedRate: 25, seed: 'nasiona_kukurydza', yieldBase: 51, product: 'kiszonka', byproduct: null,
      nNeed: 190, pNeed: 80, kNeed: 180, phOpt: 6.3, phSens: 0.9, soilPref: [1, 2, 3, 4], soilSens: 0.85, droughtSens: 1.1,
      weedSens: 1.4, diseaseSens: 0.4, pestSens: 0.7, window: 4, breakYears: 0, frostKill: -2,
      rotation: { bad: [], good: ['pszenica', 'pszenzyto', 'jeczmien', 'owies', 'zyto'] },
      inputsHa: { saletra: 0.4, npk: 0.4, herbicyd: 2.5 },
      look: { style: 'maize', green: '#3e8a2e', ripe: '#7f9a3e', height: 2.7 },
      desc: 'Cała roślina zbierana sieczkarnią w fazie woskowej (wrzesień) — podstawowa pasza dla bydła. Plon w zielonej masie ~45–50 t/ha.'
    },
    ziemniaki: {
      name: 'Ziemniaki', short: 'ziemniaki', winter: false, group: 'okopowe',
      sowMonths: [3, 4], harvestMonths: [7, 8, 9], growDays: 40, gdd: 1450, tbase: 5,
      seedRate: 2.5, seed: 'nasiona_ziemniaki', yieldBase: 41, product: 'ziemniaki', byproduct: null,
      nNeed: 150, pNeed: 70, kNeed: 220, phOpt: 5.8, phSens: 0.5, soilPref: [2, 3, 4, 5], soilSens: 0.85, droughtSens: 1.25,
      weedSens: 0.9, diseaseSens: 1.6, pestSens: 1.4, window: 12, breakYears: 2, frostKill: -2,
      rotation: { bad: ['ziemniaki'], good: ['pszenica', 'pszenzyto', 'zyto', 'owies', 'jeczmien'] },
      inputsHa: { saletra: 0.35, npk: 0.6, herbicyd: 1.5, fungicyd: 4, insektycyd: 0.6 },
      look: { style: 'root', green: '#4f8f3c', ripe: '#8a8a4a', height: 0.6 },
      desc: 'Duży przychód z ha, ale drogie sadzeniaki, zaraza (kilka oprysków fungicydem) i stonka. Wymaga sadzarki i kopaczki — albo usługi.'
    },
    buraki: {
      name: 'Buraki cukrowe', short: 'buraki', winter: false, group: 'okopowe',
      sowMonths: [2, 3], harvestMonths: [8, 9, 10], growDays: 52, gdd: 2200, tbase: 3,
      seedRate: 3, seed: 'nasiona_buraki', yieldBase: 72, product: 'buraki', byproduct: null,
      nNeed: 150, pNeed: 80, kNeed: 220, phOpt: 7.0, phSens: 1.1, soilPref: [1, 2, 3], soilSens: 1.2, droughtSens: 1.0,
      weedSens: 1.5, diseaseSens: 1.0, pestSens: 0.7, window: 18, breakYears: 3, frostKill: -6,
      rotation: { bad: ['buraki', 'rzepak'], good: ['pszenica', 'jeczmien', 'pszenzyto'] },
      inputsHa: { saletra: 0.35, npk: 0.6, herbicyd: 4, fungicyd: 1.5 },
      look: { style: 'beet', green: '#3f8f45', ripe: '#5f8a45', height: 0.45 },
      desc: 'Uprawa kontraktowana przez cukrownię — najlepsza cena tylko w ramach umowy. Wymaga gleby I–III, pH ~7 i dużo herbicydów.'
    },
    trawa: {
      name: 'Łąka (trawy)', short: 'łąka', winter: true, perennial: true, meadow: true, group: 'trawa',
      sowMonths: [3, 4, 7], harvestMonths: [4, 5, 6, 7, 8], growDays: 14, gdd: 450, gddFirst: 400, tbase: 5,
      seedRate: 30, seed: 'nasiona_trawa', yieldBase: 7, product: 'siano', byproduct: null,
      // bele z ha na pokos — potencjał (1. pokos najobfitszy); bela siana ~250 kg (~0,21 t s.m.), sianokiszonki ~650 kg zielonki
      // (~250 kg s.m.); 3 pokosy × ~10 bel ≈ 6–7 t s.m./ha/rok przy typowych stratach
      cutBales: [14, 11, 9, 6],
      nNeed: 60, pNeed: 25, kNeed: 70, phOpt: 6.0, phSens: 0.6, soilPref: [2, 3, 4, 5], soilSens: 0.7, droughtSens: 1.2,
      weedSens: 0, diseaseSens: 0, pestSens: 0, window: 6, breakYears: 0, frostKill: -40,
      rotation: { bad: [], good: [] },
      inputsHa: { saletra: 0.4, npk: 0.15 },
      look: { style: 'grass', green: '#6fb04a', ripe: '#9fb85a', height: 0.5, flower: '#e8e070' },
      desc: 'Trwały użytek zielony: 2–4 pokosy w roku (maj, lipiec, sierpień, wrzesień). Siano lub sianokiszonka dla bydła, owiec i koni.'
    }
  };

  // ---------------------------------------------------------------------------------------------------------------
  // WSPÓŁCZYNNIKI REAKCJI PLONU (używa sim/fields.js) — jedno miejsce do strojenia balansu.
  //   nFloor/nExp     – krzywa reakcji na azot: fN = nFloor + (1 − nFloor)·rN^nExp (rN 0..1, nasycenie przy rN = 1);
  //                     rN = 0,4 → 0,64; rN = 0,2 → 0,46; rN = 0 → 0,28 (pszenica bez azotu: −35–45% w typowym roku)
  //   pkFloor/pkExp   – to samo dla fosforu i potasu (osobno): przy wyczerpanej glebie (r = 0,3) ≈ 0,86
  //   pkRecharge      – dzienny ułamek niedoboru P/K uzupełniany z zapasów glebowych (0,007 ≈ 40% w rok gry)
  //   pkLock          – uwstecznianie nadmiaru P/K ponad zasobność równowagową (ułamek/dzień)
  //   weedLoss        – strata potencjału dziennie = weedLoss × zachwaszczenie × weedSens × Δwzrost (do 85% wzrostu);
  //                     bez herbicydu zachwaszczenie dochodzi do 0,6–0,7 → łącznie −25–30%
  //   diseaseLoss     – j.w. dla chorób (mokry rok bez fungicydu: nasilenie 0,5–0,7 → −15–30%)
  //   pestLoss        – j.w. dla szkodników (rzepak pestSens 1,4 bez insektycydu → −10–25%)
  //   floodLoss       – dzienna strata przy zalaniu (gleba > 97% wody i opad > 12 mm)
  //   limePh          – przyrost pH z 1 t/ha wapna węglanowego (rozłożony na ~2 miesiące gry)
  //   phDrop          – naturalny spadek pH rocznie; saletra zakwasza dodatkowo (0,0006 pH na kg N)
  // ---------------------------------------------------------------------------------------------------------------
  G.AGRO = {
    nFloor: 0.28, nExp: 0.85, pkFloor: 0.75, pkExp: 0.7, pkRecharge: 0.007, pkLock: 0.004,
    weedLoss: 0.85, diseaseLoss: 0.8, pestLoss: 0.7, floodLoss: 0.006, limePh: 0.15, phDrop: 0.08
  };

  // ---------------------------------------------------------------------------------------------------------------
  // KLASY JAKOŚCI PARTII (używa sim/fields.js przy zbiorze i sim/market.js przy wycenie).
  // Jakość partii q (0..1) liczona przy zbiorze: kondycja (deszcz na dojrzałe ziarno, przerośnięta trawa) × składniki
  // zależne od uprawy (G.GRADES[produkt].kind):
  //   'protein' – pszenica: białko zależy od zaopatrzenia w azot (rN) i odmiany (yieldBase × 0 — tu: stała odmiana),
  //               klasa konsumpcyjna wymaga rN ≥ ~0,75 i zdrowego, suchego ziarna; inaczej paszowa (−13%)
  //   'malting' – jęczmień browarny: zdrowe, dorodne ziarno (rN ≥ 0,55) ale BEZ nadmiaru azotu (resztka N w glebie
  //               > 50 kg/ha przy zbiorze = za dużo białka) → premia +12%; inaczej paszowy (cena bazowa)
  //   'oil'     – rzepak: zanieczyszczenia (chwasty, szkodniki, choroby) i wilgotność (deszcz) → potrącenie −10%
  //   'tuber'   – ziemniaki: jadalne (zdrowe, bez stonki/zarazy, zaopatrzone w potas) vs przemysłowe (−30%)
  //   'feed'    – pozostałe (żyto, pszenżyto, owies, kukurydza, siano, słoma…): jedna klasa, drobne potrącenie za
  //               złą kondycję (factor od 0,85/0,93 do 1,0)
  // grades: od najlepszej; `min` = próg q; `factor` = mnożnik ceny bazowej produktu (base = klasa z factor 1).
  // ---------------------------------------------------------------------------------------------------------------
  G.GRADES = {
    pszenica:  { kind: 'protein', grades: [{ id: 'konsumpcyjna', label: 'konsumpcyjna', min: 0.62, factor: 1.0 }, { id: 'paszowa', label: 'paszowa', min: 0, factor: 0.87 }] },
    jeczmien:  { kind: 'malting', grades: [{ id: 'browarny', label: 'browarny', min: 0.62, factor: 1.12 }, { id: 'paszowy', label: 'paszowy', min: 0, factor: 1.0 }] },
    rzepak:    { kind: 'oil', grades: [{ id: 'standard', label: 'czysty, suchy', min: 0.6, factor: 1.0 }, { id: 'obnizony', label: 'zanieczyszczony / wilgotny', min: 0, factor: 0.9 }] },
    ziemniaki: { kind: 'tuber', grades: [{ id: 'jadalne', label: 'jadalne', min: 0.6, factor: 1.0 }, { id: 'przemyslowe', label: 'przemysłowe', min: 0, factor: 0.7 }] },
    siano:         { kind: 'feed', minFactor: 0.85 },
    sianokiszonka: { kind: 'feed', minFactor: 0.9 },
    sloma:         { kind: 'feed', minFactor: 0.9 }
  };
  G.GRADE_DEFAULT = { kind: 'feed', minFactor: 0.93 };   // dla produktów bez wpisu (żyto, pszenżyto, owies, kukurydza…)

  // grupy i pomocnicze listy
  G.CROP_LIST_FIELD = Object.keys(G.CROPS).filter(id => !G.CROPS[id].meadow);
  // klasy gleby: nazwa i mnożnik plonu dla soilSens = 1 (kl. III = 1,00)
  G.SOIL_NAMES = ['', 'I', 'II', 'IIIa/IIIb', 'IVa/IVb', 'V', 'VI'];
  G.SOIL_FACTOR = [1, 1.22, 1.14, 1.0, 0.86, 0.68, 0.55];
  // przeliczniki ha fizycznych na przeliczeniowe (podatek rolny, okręg II): grunty orne / użytki zielone
  G.SOIL_TAX_FIELD = [0, 1.80, 1.65, 1.35, 0.80, 0.20, 0.05];
  G.SOIL_TAX_MEADOW = [0, 1.60, 1.35, 1.00, 0.35, 0.10, 0.05];

  // ---------------------------------------------------------------------------------------------------------------
  // PRODUKTY (ids wg DESIGN.md). Jednostki: plony w t, słoma/siano w belach (bela okrągła ~250 kg), nasiona w kg
  // (sadzeniaki w t), nawozy w t, środki ochrony w l.
  // buy: false → nie do kupienia w sklepie (tylko sprzedaż). shop: true → środek produkcji (cena sklepowa = indeks,
  // odsprzedaż 60%).
  // ---------------------------------------------------------------------------------------------------------------
  Object.assign(G.PRODUCTS, {
    // plony
    pszenica:  { name: 'Pszenica', unit: 't', icon: '🌾', cat: 'zboże', base: 850, vol: 0.35, density: 0.77, feed: true },
    pszenzyto: { name: 'Pszenżyto', unit: 't', icon: '🌾', cat: 'zboże', base: 720, vol: 0.35, density: 0.7, feed: true },
    zyto:      { name: 'Żyto', unit: 't', icon: '🌾', cat: 'zboże', base: 650, vol: 0.35, density: 0.72, feed: true },
    jeczmien:  { name: 'Jęczmień', unit: 't', icon: '🌾', cat: 'zboże', base: 780, vol: 0.35, density: 0.65, feed: true },
    owies:     { name: 'Owies', unit: 't', icon: '🌾', cat: 'zboże', base: 650, vol: 0.35, density: 0.5, feed: true },
    rzepak:    { name: 'Rzepak', unit: 't', icon: '🌼', cat: 'oleiste', base: 1950, vol: 0.4, density: 0.66 },
    kukurydza: { name: 'Kukurydza (ziarno)', unit: 't', icon: '🌽', cat: 'zboże', base: 750, vol: 0.4, density: 0.72, feed: true },
    kiszonka:  { name: 'Kiszonka z kukurydzy', unit: 't', icon: '🟩', cat: 'pasza', base: 180, vol: 0.25, density: 0.3, feed: true },
    ziemniaki: { name: 'Ziemniaki', unit: 't', icon: '🥔', cat: 'okopowe', base: 600, vol: 0.6, density: 0.67 },
    buraki:    { name: 'Buraki cukrowe', unit: 't', icon: '🟣', cat: 'okopowe', base: 150, vol: 0.15, density: 0.62 },
    // uboczne / pasze objętościowe
    sloma:         { name: 'Słoma (bele)', unit: 'bela', icon: '🟨', cat: 'pasza', base: 55, vol: 0.4, feed: true },
    siano:         { name: 'Siano (bele)', unit: 'bela', icon: '🟫', cat: 'pasza', base: 120, vol: 0.4, feed: true },
    sianokiszonka: { name: 'Sianokiszonka (bele)', unit: 'bela', icon: '⚪', cat: 'pasza', base: 150, vol: 0.35, feed: true },
    // nasiona i sadzeniaki (materiał kwalifikowany)
    nasiona_pszenica:  { name: 'Nasiona pszenicy', unit: 'kg', icon: '🌱', cat: 'nasiona', base: 2.6, vol: 0.15, shop: true },
    nasiona_pszenzyto: { name: 'Nasiona pszenżyta', unit: 'kg', icon: '🌱', cat: 'nasiona', base: 2.3, vol: 0.15, shop: true },
    nasiona_zyto:      { name: 'Nasiona żyta', unit: 'kg', icon: '🌱', cat: 'nasiona', base: 2.4, vol: 0.15, shop: true },
    nasiona_jeczmien:  { name: 'Nasiona jęczmienia', unit: 'kg', icon: '🌱', cat: 'nasiona', base: 2.4, vol: 0.15, shop: true },
    nasiona_owies:     { name: 'Nasiona owsa', unit: 'kg', icon: '🌱', cat: 'nasiona', base: 2.2, vol: 0.15, shop: true },
    nasiona_rzepak:    { name: 'Nasiona rzepaku (mieszańcowe)', unit: 'kg', icon: '🌱', cat: 'nasiona', base: 150, vol: 0.1, shop: true },
    nasiona_kukurydza: { name: 'Nasiona kukurydzy', unit: 'kg', icon: '🌱', cat: 'nasiona', base: 50, vol: 0.1, shop: true },
    nasiona_ziemniaki: { name: 'Sadzeniaki', unit: 't', icon: '🥔', cat: 'nasiona', base: 1800, vol: 0.3, shop: true },
    nasiona_buraki:    { name: 'Nasiona buraka (otoczkowane)', unit: 'kg', icon: '🌱', cat: 'nasiona', base: 400, vol: 0.1, shop: true },
    nasiona_trawa:     { name: 'Mieszanka traw', unit: 'kg', icon: '🌱', cat: 'nasiona', base: 25, vol: 0.1, shop: true },
    // nawozy i środki ochrony roślin
    saletra:    { name: 'Saletra amonowa 34% N', unit: 't', icon: '🧂', cat: 'środki', base: 1500, vol: 0.3, shop: true, nut: { n: 340, p: 0, k: 0 } },
    npk:        { name: 'NPK 6-20-30 (Polifoska)', unit: 't', icon: '🧪', cat: 'środki', base: 2200, vol: 0.25, shop: true, nut: { n: 60, p: 200, k: 300 } },
    wapno:      { name: 'Wapno nawozowe (węglanowe)', unit: 't', icon: '⚪', cat: 'środki', base: 280, vol: 0.1, shop: true },
    herbicyd:   { name: 'Herbicyd (na chwasty)', unit: 'l', icon: '🧴', cat: 'środki', base: 90, vol: 0.1, shop: true },
    fungicyd:   { name: 'Fungicyd (na choroby)', unit: 'l', icon: '🧴', cat: 'środki', base: 160, vol: 0.1, shop: true },
    insektycyd: { name: 'Insektycyd (na szkodniki)', unit: 'l', icon: '🧴', cat: 'środki', base: 120, vol: 0.1, shop: true }
  });
  // Nawozy naturalne opisuje agent hodowli — tu tylko awaryjnie (gdy jego dane się nie wczytały lub są później).
  // Zawartość składników „dostępnych w 1. roku” (kg/t lub kg/m3): obornik ~ N 1,5, P 3, K 6; gnojowica ~ N 2,5, P 1, K 3.
  if (!G.PRODUCTS.obornik) G.PRODUCTS.obornik = { name: 'Obornik', unit: 't', icon: '💩', cat: 'środki', base: 60, vol: 0.2, shop: true };
  if (!G.PRODUCTS.gnojowica) G.PRODUCTS.gnojowica = { name: 'Gnojowica', unit: 'm3', icon: '🛢️', cat: 'środki', base: 25, vol: 0.2, shop: true };
  G.NUTRIENTS = {
    saletra: { n: 340, p: 0, k: 0 }, npk: { n: 60, p: 200, k: 300 },
    obornik: { n: 1.6, p: 3, k: 6, om: 1 }, gnojowica: { n: 2.5, p: 1, k: 3, om: 0.3 }
  };

  // Domyślne dawki na ha (t, m3 lub l) i ich zakres — używane przez zabiegi i planer
  G.RATES = {
    saletra: { def: 0.25, min: 0.1, max: 0.5, step: 0.05 },
    npk: { def: 0.3, min: 0.1, max: 0.6, step: 0.05 },
    obornik: { def: 25, min: 10, max: 40, step: 5 },
    gnojowica: { def: 25, min: 10, max: 40, step: 5 },
    wapno: { def: 3, min: 1, max: 5, step: 0.5 },
    herbicyd: { def: 2, min: 1, max: 4, step: 0.5 },
    fungicyd: { def: 1, min: 0.5, max: 2, step: 0.25 },
    insektycyd: { def: 0.3, min: 0.1, max: 1, step: 0.1 }
  };
})();
