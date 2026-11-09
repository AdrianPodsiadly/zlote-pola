// Złote Pola — katalog maszyn i narzędzi, paliwo → G.MACHINES, G.PRODUCTS (agent: maszyny, ludzie, prace)
//
// WSZYSTKIE MARKI SĄ FIKCYJNE (nie używamy prawdziwych marek, modeli ani logo):
//   Zagon (stare ciągniki), Bruzda (ciągniki średnie), Nordwal (duże ciągniki), Kłosownik i Żniwiarz (kombajny),
//   Skibowiec (pługi), Redlica (agregaty, siewniki), Rosiak (opryskiwacze), Posyp (rozsiewacze), Rozrzut (rozrzutniki, beczki),
//   Pokos (kosiarki, zgrabiarki), Belarz (prasy), Wiślak (przyczepy), Dźwigar (ładowarki), Bulwa (ziemniaki), Korzeń (buraki), Kiszon (sieczkarnie).
//
// Pola wpisu (kontrakt DESIGN.md + rozszerzenia):
//   name, brand, cat, ops:[zabiegi], hp (moc własna: ciągniki i maszyny samojezdne), reqHp (wymagana moc ciągnika — narzędzia),
//   width (m, szerokość robocza), speed (km/h roboczo), cap (t lub m³ — zbiornik/skrzynia), price (zł, nowa), rentPerDay (zł/dzień gry, 0 = brak wynajmu),
//   fuelLph (l/h przy pełnym obciążeniu — tylko maszyny z silnikiem), model (klucz grafiki), color, year? (rocznik dla „usedOnly”), desc
//   self: true — maszyna samojezdna (kombajn, sieczkarnia, kombajn buraczany, ładowarka)
//   needs: 'header' — kombajn wymaga hedera; header: id hedera dołączanego przy zakupie/wynajmie
//   crops: [uprawy] — ograniczenie do upraw (siew, zbiór); inputs: [produkty] — co rozsiewa (nawożenie/wapnowanie)
//   mode: 'grain'|'silage'|'root' — rodzaj zbioru (przekazywany do G.fields.workTile w params.mode)
//   load: 0..1 — obciążenie silnika ciągnika przez narzędzie (spalanie = fuelLph ciągnika × load)
//   life: motogodziny do pełnego zużycia (wear 1.0); usedOnly: tylko z rynku wtórnego (nie ma w salonie)
//   PRZYCZEPY: axle: 'jednoosiowa' (3–8 t, bez tylnego zaczepu) | 'dwuosiowa' (przednia oś skrętna na obrotnicy, 4–18 t, tylny zaczep)
//              | 'tandem' (8–20 t, tylny zaczep) | 'tridem' (20–30 t, tylko jako jedyna/ostatnia); cap ZAWSZE w tonach, m3 — objętość
//              skrzyni (zboże 0,76 t/m³); rearHitch: czy można doczepić za nią drugą przyczepę (PL: zespół maks. 3 pojazdy, 22 m);
//              reqHp rośnie z ładownością (6 t → 60, 10 t → 80, 14 t → 110, 20 t → 150, 30 t → 220 KM); hitchLen — długość (kafle) do rysowania.
//   KOMBAJNY: tankL — zbiornik ziarna (l), cap — to samo w tonach przy 0,76 t/m³, unloadLps — wydajność rury wyładowczej (l/s):
//             stary ~4 400 l / 75 l/s, średni 8 000–9 000 l / 105, duży 11 000–12 500 l / 125, największy 14 500 l / 140.
//
// Wydajność w grze: ha/h = width × speed / 10 × 0,8 × współczynnik pracownika (0,88…1,2), nocą × 0,8.
// Ceny: realia rynku PL 2025/26 (netto ≈ brutto dla rolnika ryczałtowca), wynajem — orientacyjne stawki wypożyczalni/sąsiedzkie bez operatora.
//
// BALANS (zł/ha, uprawa zbóż; paliwo ON ≈ 6 zł/l):
//   Usługi (kontraktor):  orka 400, uprawa 180, siew 220, oprysk 90 (×2), nawóz 70 (×2), zbiór 520, prasowanie ≈ 10 bel × 13 = 130
//                          → ≈ 1 770 zł/ha/rok (10 ha ≈ 17,7 tys., 50 ha ≈ 88 tys. zł).
//   Wynajem: ciągnik 110 KM + pług 4-skibowy = 1 200 zł/dzień, ≈ 10 ha/dzień → ≈ 110 zł/ha + paliwo ≈ 115 zł/ha + praca własna (vs 400 usługa).
//            kombajn KS-6 (6,2 m) 6 000 zł/dzień, ≈ 30 ha/dzień → ≈ 200 zł/ha + paliwo 90 zł/ha (vs 520 usługa) — opłaca się od ≈ 15 ha.
//   Własne: zestaw 110 KM + pług + agregat + siewnik + opryskiwacz + rozsiewacz (nowe ≈ 560 tys., używane ≈ 300 tys.)
//            amortyzacja ≈ 8–10 %/rok + serwis ≈ 2 % → ≈ 35–60 tys. zł/rok + paliwo ≈ 60 l/ha → zwrot od ≈ 40–60 ha (bez kombajnu),
//            własny kombajn (używany ≈ 400–600 tys.) opłaca się dopiero od ≈ 120–150 ha zbóż.
(function () {
  Object.assign(G.PRODUCTS, {
    ON: { name: 'Olej napędowy', unit: 'l', icon: '⛽', cat: 'paliwo', base: 6.0, vol: 0.12 }
  });

  const GRAIN = ['pszenica', 'pszenzyto', 'zyto', 'jeczmien', 'owies', 'rzepak', 'soja'];

  // kolory marek
  const COL = {
    zagon: '#b5402f', bruzda: '#3f7d3a', nordwal: '#2f5f9e', klos: '#d1a62a', zniw: '#c9c43a',
    skib: '#8f2a22', redl: '#2c6f8a', rosiak: '#d9822b', posyp: '#5d8f2e', rozrz: '#7a5a3a',
    pokos: '#c23b6a', belarz: '#5b4a9b', wislak: '#a33a3a', dzwigar: '#e0b020', bulwa: '#6b8e23', korzen: '#8a3fa0', kiszon: '#2e8b6e'
  };

  G.MACHINES = {
    // ===================== CIĄGNIKI =====================
    zagon_c60: {
      name: 'Zagon C-60 „Dziadek”', brand: 'Zagon', cat: 'tractor', ops: [], hp: 60, price: 45000, rentPerDay: 0, fuelLph: 9,
      model: 'tractor_small', color: COL.zagon, year: 1986, usedOnly: true, life: 12000,
      desc: 'Stary, czerwony, kopci i stuka — ale odpala. Ciągnik po dziadku: wystarczy do pługa 2-skibowego i małej przyczepy.'
    },
    bruzda_80: {
      name: 'Bruzda 80 Rolnik', brand: 'Bruzda', cat: 'tractor', ops: [], hp: 80, price: 215000, rentPerDay: 650, fuelLph: 12,
      model: 'tractor_small', color: COL.bruzda, life: 12000,
      desc: 'Prosty, mechaniczny ciągnik dla małego gospodarstwa. Pług 3-skibowy, siewnik 3 m, opryskiwacz zawieszany.'
    },
    bruzda_110: {
      name: 'Bruzda 110 Gospodarz', brand: 'Bruzda', cat: 'tractor', ops: [], hp: 110, price: 335000, rentPerDay: 900, fuelLph: 17,
      model: 'tractor_mid', color: COL.bruzda, life: 12000,
      desc: 'Uniwersalny koń roboczy: pług 4-skibowy, agregat 4 m, przyczepa tandem. Najczęstszy wybór w średnim gospodarstwie.'
    },
    nordwal_150: {
      name: 'Nordwal T150 Pole', brand: 'Nordwal', cat: 'tractor', ops: [], hp: 150, price: 560000, rentPerDay: 1200, fuelLph: 23,
      model: 'tractor_mid', color: COL.nordwal, life: 13000,
      desc: 'Mocny ciągnik z wygodną kabiną i przekładnią powershift. Pług 5-skibowy, siewnik pneumatyczny, beczka 10 m³.'
    },
    nordwal_220: {
      name: 'Nordwal T220 Potęga', brand: 'Nordwal', cat: 'tractor', ops: [], hp: 220, price: 890000, rentPerDay: 1700, fuelLph: 33,
      model: 'tractor_big', color: COL.nordwal, life: 14000,
      desc: 'Duży ciągnik do wielkoobszarowych prac: brona talerzowa 6 m, siew 6 m, beczka 18 m³. Spala sporo, ale robi hektary.'
    },

    // ===================== KOMBAJNY ZBOŻOWE (samojezdne, wymagają hedera) =====================
    klosownik_k45: {
      name: 'Kłosownik K-45', brand: 'Kłosownik', cat: 'combine', ops: ['harvest'], self: true, hp: 180, speed: 5, tankL: 4400, cap: 3.3, unloadLps: 75,
      needs: 'header', header: 'heder_45', crops: GRAIN.concat(['kukurydza', 'slonecznik']), mode: 'grain',
      price: 690000, rentPerDay: 4000, fuelLph: 28, model: 'combine', color: COL.klos, life: 6000,
      desc: 'Mały, starszej konstrukcji kombajn dla gospodarstw do ~80 ha. Zbiornik 4 400 l (≈ 3,3 t), rura 75 l/s. W zestawie heder zbożowy 4,5 m.'
    },
    klosownik_k62: {
      name: 'Kłosownik K-62 Plus', brand: 'Kłosownik', cat: 'combine', ops: ['harvest'], self: true, hp: 290, speed: 5.5, tankL: 8500, cap: 6.5, unloadLps: 105,
      needs: 'header', header: 'heder_62', crops: GRAIN.concat(['kukurydza', 'slonecznik']), mode: 'grain',
      price: 1250000, rentPerDay: 6000, fuelLph: 40, model: 'combine', color: COL.klos, life: 6500,
      desc: 'Średni kombajn z wytrząsaczami, zbiornik 8 500 l (≈ 6,5 t), rura 105 l/s. W zestawie heder 6,2 m.'
    },
    zniwiarz_x9: {
      name: 'Żniwiarz X9 Rotor', brand: 'Żniwiarz', cat: 'combine', ops: ['harvest'], self: true, hp: 420, speed: 6, tankL: 12000, cap: 9.1, unloadLps: 125,
      needs: 'header', header: 'heder_9', crops: GRAIN.concat(['kukurydza', 'slonecznik']), mode: 'grain',
      price: 2200000, rentPerDay: 9000, fuelLph: 55, model: 'combine', color: COL.zniw, life: 7000,
      desc: 'Rotorowy olbrzym dla dużych areałów. Zbiornik 12 000 l (≈ 9,1 t), rura 125 l/s, heder 9 m w zestawie.'
    },
    zniwiarz_x12: {
      name: 'Żniwiarz X12 Hybryda', brand: 'Żniwiarz', cat: 'combine', ops: ['harvest'], self: true, hp: 520, speed: 6.5, tankL: 14500, cap: 11, unloadLps: 140,
      needs: 'header', header: 'heder_12', crops: GRAIN.concat(['kukurydza', 'slonecznik']), mode: 'grain',
      price: 2950000, rentPerDay: 12000, fuelLph: 68, model: 'combine', color: COL.zniw, life: 7500,
      desc: 'Największy kombajn w katalogu: zbiornik 14 500 l (≈ 11 t), rura 140 l/s, heder taśmowy 12 m. Dla gospodarstw powyżej 400 ha albo usługodawców.'
    },
    // hedery (zespoły żniwne)
    heder_45: {
      name: 'Heder zbożowy 4,5 m', brand: 'Kłosownik', cat: 'header', ops: ['harvest'], reqHp: 150, width: 4.5, crops: GRAIN,
      price: 85000, rentPerDay: 0, model: 'header', color: COL.klos, life: 5000, desc: 'Zespół żniwny do zbóż, rzepaku i soi.'
    },
    heder_62: {
      name: 'Heder zbożowy 6,2 m', brand: 'Kłosownik', cat: 'header', ops: ['harvest'], reqHp: 240, width: 6.2, crops: GRAIN,
      price: 125000, rentPerDay: 0, model: 'header', color: COL.klos, life: 5000, desc: 'Zespół żniwny 6,2 m z nagarniaczem.'
    },
    heder_9: {
      name: 'Heder taśmowy 9 m', brand: 'Żniwiarz', cat: 'header', ops: ['harvest'], reqHp: 380, width: 9, crops: GRAIN,
      price: 195000, rentPerDay: 0, model: 'header', color: COL.zniw, life: 5000, desc: 'Szeroki heder taśmowy — równy pokos przy dużej prędkości.'
    },
    heder_12: {
      name: 'Heder taśmowy 12 m', brand: 'Żniwiarz', cat: 'header', ops: ['harvest'], reqHp: 460, width: 12, crops: GRAIN,
      price: 260000, rentPerDay: 0, model: 'header', color: COL.zniw, life: 5000, desc: 'Heder taśmowy 12 m z własnym wózkiem transportowym.'
    },
    heder_kukurydza: {
      name: 'Przystawka do kukurydzy 6-rz.', brand: 'Kłosownik', cat: 'header', ops: ['harvest'], reqHp: 170, width: 4.5,
      crops: ['kukurydza', 'slonecznik'], price: 165000, rentPerDay: 700, model: 'header', color: COL.klos, life: 5000,
      desc: 'Zrywacz kolb 6-rzędowy (75 cm) z rozdrabniaczem łodyg — zbiór kukurydzy na ziarno.'
    },

    // ===================== PŁUGI =====================
    plug_2: {
      name: 'Skibowiec P-2', brand: 'Skibowiec', cat: 'plow', ops: ['plow'], reqHp: 45, width: 0.7, speed: 7, load: 1.0,
      price: 7000, rentPerDay: 120, model: 'plow', color: COL.skib, life: 3000, year: 1979,
      desc: 'Pług 2-skibowy zawieszany (2 × 35 cm). Wolno, ale do starego ciągnika w sam raz.'
    },
    plug_3: {
      name: 'Skibowiec P-3', brand: 'Skibowiec', cat: 'plow', ops: ['plow'], reqHp: 70, width: 1.05, speed: 7, load: 1.0,
      price: 16000, rentPerDay: 180, model: 'plow', color: COL.skib, life: 3000, desc: 'Pług 3-skibowy zagonowy.'
    },
    plug_4: {
      name: 'Skibowiec Obrót 4', brand: 'Skibowiec', cat: 'plow', ops: ['plow'], reqHp: 100, width: 1.6, speed: 7, load: 1.0,
      price: 48000, rentPerDay: 300, model: 'plow', color: COL.skib, life: 3500, desc: 'Pług obracalny 4-skibowy (4 × 40 cm), zabezpieczenie resorowe.'
    },
    plug_5: {
      name: 'Skibowiec Obrót 5 Vario', brand: 'Skibowiec', cat: 'plow', ops: ['plow'], reqHp: 140, width: 2.2, speed: 7.5, load: 1.0,
      price: 78000, rentPerDay: 420, model: 'plow', color: COL.skib, life: 3500, desc: 'Pług obracalny 5-skibowy ze zmienną szerokością skiby.'
    },

    // ===================== UPRAWA (agregaty, brony) =====================
    brona_45: {
      name: 'Redlica Brona zębata 4,5 m', brand: 'Redlica', cat: 'cultivator', ops: ['cultivate'], reqHp: 45, width: 4.5, speed: 8, load: 0.6,
      price: 8000, rentPerDay: 90, model: 'cultivator', color: COL.redl, life: 3000, desc: 'Prosta brona zębata — wyrównanie i spulchnienie po orce.'
    },
    agregat_27: {
      name: 'Redlica Agregat 2,7 m', brand: 'Redlica', cat: 'cultivator', ops: ['cultivate'], reqHp: 70, width: 2.7, speed: 10, load: 0.85,
      price: 22000, rentPerDay: 160, model: 'cultivator', color: COL.redl, life: 3000, desc: 'Agregat uprawowy: zęby sprężynowe, wał strunowy.'
    },
    agregat_4: {
      name: 'Redlica Agregat 4 m Hydro', brand: 'Redlica', cat: 'cultivator', ops: ['cultivate'], reqHp: 110, width: 4, speed: 12, load: 0.85,
      price: 58000, rentPerDay: 260, model: 'cultivator', color: COL.redl, life: 3000, desc: 'Agregat składany hydraulicznie, wał rurowy + crosskill.'
    },
    talerzowa_6: {
      name: 'Redlica Brona talerzowa 6 m', brand: 'Redlica', cat: 'cultivator', ops: ['cultivate'], reqHp: 190, width: 6, speed: 13, load: 0.9,
      price: 145000, rentPerDay: 550, model: 'cultivator', color: COL.redl, life: 3500, desc: 'Ciężka brona talerzowa — podorywka i uprawa przedsiewna w jednym.'
    },

    // ===================== SIEWNIKI, SADZARKI =====================
    siewnik_25: {
      name: 'Redlica S-25', brand: 'Redlica', cat: 'seeder', ops: ['sow'], reqHp: 55, width: 2.5, speed: 9, cap: 0.4, load: 0.55, crops: GRAIN,
      price: 26000, rentPerDay: 180, model: 'seeder', color: COL.redl, life: 3000, desc: 'Mechaniczny siewnik zbożowy 2,5 m, skrzynia 400 kg.'
    },
    siewnik_3: {
      name: 'Redlica S-30 Talerz', brand: 'Redlica', cat: 'seeder', ops: ['sow'], reqHp: 75, width: 3, speed: 10, cap: 0.6, load: 0.6, crops: GRAIN,
      price: 42000, rentPerDay: 230, model: 'seeder', color: COL.redl, life: 3000, desc: 'Siewnik mechaniczny 3 m z redlicami talerzowymi.'
    },
    siewnik_4p: {
      name: 'Redlica Pneumo 4', brand: 'Redlica', cat: 'seeder', ops: ['sow'], reqHp: 120, width: 4, speed: 12, cap: 2, load: 0.75, crops: GRAIN,
      price: 165000, rentPerDay: 480, model: 'seeder', color: COL.redl, life: 3500, desc: 'Agregat uprawowo-siewny pneumatyczny 4 m, zbiornik 2 t.'
    },
    siewnik_6: {
      name: 'Redlica Pneumo 6 Combi', brand: 'Redlica', cat: 'seeder', ops: ['sow'], reqHp: 200, width: 6, speed: 13, cap: 4, load: 0.8, crops: GRAIN,
      price: 320000, rentPerDay: 800, model: 'seeder', color: COL.redl, life: 3500, desc: 'Ciągany siewnik 6 m z broną talerzową — siew w jednym przejeździe.'
    },
    punktowy_6: {
      name: 'Redlica Precyzja 6-rz.', brand: 'Redlica', cat: 'planter', ops: ['sow'], reqHp: 90, width: 4.5, speed: 8, cap: 0.3, load: 0.55,
      crops: ['kukurydza', 'buraki', 'slonecznik', 'soja'], price: 120000, rentPerDay: 450, model: 'planter', color: COL.redl, life: 3000,
      desc: 'Siewnik punktowy 6-rzędowy (75 cm) do kukurydzy i słonecznika; z wymianą tarcz — buraki.'
    },
    punktowy_12: {
      name: 'Redlica Precyzja 12-rz.', brand: 'Redlica', cat: 'planter', ops: ['sow'], reqHp: 150, width: 5.4, speed: 8, cap: 0.5, load: 0.6,
      crops: ['kukurydza', 'buraki', 'slonecznik', 'soja'], price: 235000, rentPerDay: 700, model: 'planter', color: COL.redl, life: 3500,
      desc: 'Siewnik punktowy 12-rzędowy (45 cm) do buraków cukrowych.'
    },
    sadzarka_2: {
      name: 'Bulwa Sadzarka 2-rz.', brand: 'Bulwa', cat: 'planter', ops: ['sow'], reqHp: 60, width: 1.5, speed: 5, cap: 1.2, load: 0.6,
      crops: ['ziemniaki'], price: 26000, rentPerDay: 220, model: 'planter', color: COL.bulwa, life: 3000, desc: 'Sadzarka czerpakowa 2-rzędowa, kosz 1,2 t.'
    },
    sadzarka_4: {
      name: 'Bulwa Sadzarka 4-rz. Taśma', brand: 'Bulwa', cat: 'planter', ops: ['sow'], reqHp: 100, width: 3, speed: 6, cap: 3, load: 0.65,
      crops: ['ziemniaki'], price: 98000, rentPerDay: 500, model: 'planter', color: COL.bulwa, life: 3500, desc: 'Sadzarka taśmowa 4-rzędowa z obsypnikami, kosz 3 t.'
    },

    // ===================== OCHRONA, NAWOŻENIE =====================
    oprysk_12: {
      name: 'Rosiak Z-600 (12 m)', brand: 'Rosiak', cat: 'sprayer', ops: ['spray'], reqHp: 50, width: 12, speed: 7, cap: 0.6, load: 0.4,
      price: 12000, rentPerDay: 120, model: 'sprayer', color: COL.rosiak, life: 3000, desc: 'Opryskiwacz zawieszany 600 l, belka 12 m składana ręcznie.'
    },
    oprysk_18: {
      name: 'Rosiak Z-1000 Hydro (18 m)', brand: 'Rosiak', cat: 'sprayer', ops: ['spray'], reqHp: 75, width: 18, speed: 8, cap: 1, load: 0.45,
      price: 38000, rentPerDay: 220, model: 'sprayer', color: COL.rosiak, life: 3000, desc: 'Opryskiwacz zawieszany 1000 l, belka 18 m hydrauliczna.'
    },
    oprysk_24: {
      name: 'Rosiak P-3000 (24 m)', brand: 'Rosiak', cat: 'sprayer', ops: ['spray'], reqHp: 110, width: 24, speed: 10, cap: 3, load: 0.5,
      price: 125000, rentPerDay: 380, model: 'sprayer', color: COL.rosiak, life: 3500, desc: 'Opryskiwacz przyczepiany 3000 l, belka 24 m, sekcje GPS.'
    },
    rozsiewacz_1: {
      name: 'Posyp R-1000', brand: 'Posyp', cat: 'spreader', ops: ['fertilize', 'lime'], reqHp: 50, width: 15, speed: 10, cap: 1, load: 0.35,
      inputs: ['saletra', 'npk', 'wapno'], price: 9500, rentPerDay: 100, model: 'spreader', color: COL.posyp, life: 3000,
      desc: 'Rozsiewacz dwutarczowy 1000 kg (12–18 m). Nawozy granulowane i wapno granulowane.'
    },
    rozsiewacz_25: {
      name: 'Posyp R-2500 Waga', brand: 'Posyp', cat: 'spreader', ops: ['fertilize', 'lime'], reqHp: 90, width: 24, speed: 12, cap: 2.5, load: 0.4,
      inputs: ['saletra', 'npk', 'wapno'], price: 34000, rentPerDay: 200, model: 'spreader', color: COL.posyp, life: 3500,
      desc: 'Rozsiewacz z wagą i sterowaniem dawką, 2500 kg, 24 m.'
    },
    rozrzutnik_6: {
      name: 'Rozrzut N-6', brand: 'Rozrzut', cat: 'manure_spreader', ops: ['fertilize'], reqHp: 70, width: 6, speed: 3, cap: 6, load: 0.5,
      inputs: ['obornik'], price: 38000, rentPerDay: 250, model: 'manure_spreader', color: COL.rozrz, life: 3000,
      desc: 'Rozrzutnik obornika 6 t, adapter 2 bębny pionowe. Prędkość uwzględnia załadunek i dojazdy.'
    },
    rozrzutnik_12: {
      name: 'Rozrzut N-12 Tandem', brand: 'Rozrzut', cat: 'manure_spreader', ops: ['fertilize'], reqHp: 130, width: 8, speed: 3.5, cap: 12, load: 0.55,
      inputs: ['obornik'], price: 98000, rentPerDay: 380, model: 'manure_spreader', color: COL.rozrz, life: 3500,
      desc: 'Rozrzutnik tandem 12 t z adapterem talerzowym.'
    },
    beczka_10: {
      name: 'Rozrzut Beczka 10 m³', brand: 'Rozrzut', cat: 'manure_spreader', ops: ['fertilize'], reqHp: 110, width: 9, speed: 4, cap: 10, load: 0.55,
      inputs: ['gnojowica'], price: 78000, rentPerDay: 350, model: 'tank', color: COL.rozrz, life: 3500,
      desc: 'Wóz asenizacyjny 10 m³ z rozlewaczem płytowym.'
    },
    beczka_18: {
      name: 'Rozrzut Beczka 18 m³ Węże', brand: 'Rozrzut', cat: 'manure_spreader', ops: ['fertilize'], reqHp: 180, width: 15, speed: 5, cap: 18, load: 0.6,
      inputs: ['gnojowica'], price: 265000, rentPerDay: 700, model: 'tank', color: COL.rozrz, life: 4000,
      desc: 'Wóz asenizacyjny 18 m³ z aplikatorem węży wleczonych 15 m (zgodny z wymogami).'
    },

    // ===================== ŁĄKI: KOSZENIE, ZGRABIANIE, PRASOWANIE =====================
    kosiarka_165: {
      name: 'Pokos Rotacja 1,65', brand: 'Pokos', cat: 'mower', ops: ['mow'], reqHp: 40, width: 1.65, speed: 10, load: 0.55,
      price: 9000, rentPerDay: 100, model: 'mower', color: COL.pokos, life: 2500, desc: 'Kosiarka rotacyjna bębnowa 1,65 m — klasyka małych łąk.'
    },
    kosiarka_32: {
      name: 'Pokos Dysk 3,2', brand: 'Pokos', cat: 'mower', ops: ['mow'], reqHp: 75, width: 3.2, speed: 12, load: 0.6,
      price: 46000, rentPerDay: 220, model: 'mower', color: COL.pokos, life: 3000, desc: 'Kosiarka dyskowa 3,2 m ze spulchniaczem.'
    },
    kosiarka_9: {
      name: 'Pokos Motyl 9', brand: 'Pokos', cat: 'mower', ops: ['mow'], reqHp: 180, width: 9, speed: 14, load: 0.7,
      price: 265000, rentPerDay: 750, model: 'mower', color: COL.pokos, life: 3500, desc: 'Zestaw kosiarek czołowa + 2 boczne („motyl”) 9 m.'
    },
    zgrabiarka_4: {
      name: 'Pokos Karuzela 4,2', brand: 'Pokos', cat: 'rake', ops: ['rake'], reqHp: 30, width: 4.2, speed: 10, load: 0.35,
      price: 14000, rentPerDay: 120, model: 'rake', color: COL.pokos, life: 3000, desc: 'Zgrabiarka karuzelowa jednowirnikowa.'
    },
    zgrabiarka_8: {
      name: 'Pokos Duo 7,5', brand: 'Pokos', cat: 'rake', ops: ['rake'], reqHp: 65, width: 7.5, speed: 12, load: 0.4,
      price: 72000, rentPerDay: 250, model: 'rake', color: COL.pokos, life: 3000, desc: 'Zgrabiarka dwukaruzelowa z pokosem środkowym.'
    },
    prasa_zw: {
      name: 'Belarz Z-120 (bele okrągłe)', brand: 'Belarz', cat: 'baler', ops: ['bale'], reqHp: 70, width: 6, speed: 8, load: 0.7,
      price: 98000, rentPerDay: 400, model: 'baler', color: COL.belarz, life: 3000,
      desc: 'Prasa zwijająca stałokomorowa, bele Ø 1,2 m (słoma ≈ 250 kg, siano ≈ 300 kg). Szerokość = obsługiwany pas pokosów.'
    },
    prasa_ow: {
      name: 'Belarz ZO-125 z owijarką', brand: 'Belarz', cat: 'baler', ops: ['bale'], reqHp: 100, width: 7, speed: 9, load: 0.75,
      price: 265000, rentPerDay: 750, model: 'baler', color: COL.belarz, life: 3500,
      desc: 'Prasa zwijająca zmiennokomorowa ze zintegrowaną owijarką — sianokiszonka w jednym przejeździe.'
    },

    // ===================== TRANSPORT =====================
    // (axle, cap w tonach, m3, rearHitch, reqHp wg ładowności — patrz nagłówek; ceny nowych PL 2025/26: 8 t ≈ 67 tys., 10 t ≈ 86 tys.,
    //  14 t ≈ 108 tys., skorupowa 18 t / przeładowcze 24–30 t ≈ 200–275 tys.; używane taniej — rynek wtórny)
    przyczepa_4: {
      name: 'Wiślak D-4 (stara)', brand: 'Wiślak', cat: 'trailer', ops: ['transport'], axle: 'jednoosiowa', cap: 4, m3: 5.3, rearHitch: false, reqHp: 40, load: 0.4, hitchLen: 0.55,
      price: 14000, rentPerDay: 0, model: 'trailer', color: COL.wislak, life: 6000, year: 1982, usedOnly: true,
      desc: 'Jednoosiowa wywrotka 4 t po dziadku. Burty łatane, ale wozi. Bez tylnego zaczepu.'
    },
    przyczepa_6: {
      name: 'Wiślak W-6', brand: 'Wiślak', cat: 'trailer', ops: ['transport'], axle: 'jednoosiowa', cap: 6, m3: 7.9, rearHitch: false, reqHp: 60, load: 0.4, hitchLen: 0.6,
      price: 46000, rentPerDay: 100, model: 'trailer', color: COL.wislak, life: 6000, desc: 'Przyczepa jednoosiowa 6 t, wywrot na 3 strony. Zwrotna, ale bez tylnego zaczepu.'
    },
    przyczepa_6d: {
      name: 'Wiślak D-6 Obrotnica (stara)', brand: 'Wiślak', cat: 'trailer', ops: ['transport'], axle: 'dwuosiowa', cap: 6, m3: 7.9, rearHitch: true, reqHp: 60, load: 0.4, hitchLen: 0.75,
      price: 24000, rentPerDay: 0, model: 'trailer', color: COL.wislak, life: 6000, year: 1988, usedOnly: true,
      desc: 'Dwuosiowa 6 t z przednią osią skrętną na obrotnicy — klasyka PGR-u. Ma tylny zaczep: można za nią doczepić drugą.'
    },
    przyczepa_8d: {
      name: 'Wiślak D-8 Obrotnica', brand: 'Wiślak', cat: 'trailer', ops: ['transport'], axle: 'dwuosiowa', cap: 8, m3: 10.5, rearHitch: true, reqHp: 70, load: 0.42, hitchLen: 0.8,
      price: 67000, rentPerDay: 130, model: 'trailer', color: COL.wislak, life: 6000, desc: 'Dwuosiowa 8 t, obrotnica, nadstawki do zboża, tylny zaczep.'
    },
    przyczepa_10: {
      name: 'Wiślak T-10 Tandem', brand: 'Wiślak', cat: 'trailer', ops: ['transport'], axle: 'tandem', cap: 10, m3: 13.2, rearHitch: true, reqHp: 80, load: 0.45, hitchLen: 0.8,
      price: 86000, rentPerDay: 160, model: 'trailer', color: COL.wislak, life: 6000, desc: 'Przyczepa tandem 10 t z nadstawkami do zboża i tylnym zaczepem.'
    },
    przyczepa_12d: {
      name: 'Wiślak D-12 Obrotnica', brand: 'Wiślak', cat: 'trailer', ops: ['transport'], axle: 'dwuosiowa', cap: 12, m3: 15.8, rearHitch: true, reqHp: 95, load: 0.47, hitchLen: 0.9,
      price: 98000, rentPerDay: 190, model: 'trailer', color: COL.wislak, life: 6500, desc: 'Dwuosiowa 12 t na obrotnicy — stabilna w zestawie z drugą przyczepą.'
    },
    przyczepa_14: {
      name: 'Wiślak T-14 Objętość', brand: 'Wiślak', cat: 'trailer', ops: ['transport'], axle: 'tandem', cap: 14, m3: 18.4, rearHitch: true, reqHp: 110, load: 0.5, hitchLen: 0.9,
      price: 108000, rentPerDay: 230, model: 'trailer', color: COL.wislak, life: 6500, desc: 'Przyczepa tandem 14 t, burty 1,6 m — na żniwa i kiszonkę. Tylny zaczep.'
    },
    przyczepa_18: {
      name: 'Wiślak S-18 Skorupa', brand: 'Wiślak', cat: 'trailer', ops: ['transport'], axle: 'tandem', cap: 18, m3: 23.7, rearHitch: true, reqHp: 135, load: 0.55, hitchLen: 1.0,
      price: 215000, rentPerDay: 350, model: 'trailer', color: COL.wislak, life: 7000, desc: 'Skorupowa 18 t, zawieszenie resorowe, hydrauliczny tylny zaczep.'
    },
    przeladowcza_24: {
      name: 'Wiślak P-24 Przeładowcza', brand: 'Wiślak', cat: 'trailer', ops: ['transport'], axle: 'tridem', cap: 24, m3: 31.6, rearHitch: false, reqHp: 178, load: 0.6, hitchLen: 1.1,
      price: 240000, rentPerDay: 450, model: 'trailer', color: COL.wislak, life: 7000, desc: 'Wóz przeładowczy tridem 24 t ze ślimakiem — jeździ tylko jako jedyna przyczepa.'
    },
    przeladowcza_30: {
      name: 'Wiślak P-30 Przeładowcza', brand: 'Wiślak', cat: 'trailer', ops: ['transport'], axle: 'tridem', cap: 30, m3: 39.5, rearHitch: false, reqHp: 220, load: 0.62, hitchLen: 1.2,
      price: 275000, rentPerDay: 520, model: 'trailer', color: COL.wislak, life: 7000, desc: 'Wóz przeładowczy tridem 30 t — dla największych kombajnów. Tylko za ciągnikiem ≥ 220 KM.'
    },
    ladowarka: {
      name: 'Dźwigar T-735', brand: 'Dźwigar', cat: 'loader', ops: ['load'], self: true, hp: 120, cap: 3.5,
      price: 420000, rentPerDay: 800, fuelLph: 10, model: 'telehandler', color: COL.dzwigar, life: 10000,
      desc: 'Ładowarka teleskopowa 3,5 t / 7 m. Na podwórzu przyspiesza załadunek obornika (+30 % wydajności rozrzutnika).'
    },

    // ===================== KOMBAJNY SPECJALNE =====================
    ziemniak_1: {
      name: 'Bulwa Z-1 Bunkier', brand: 'Bulwa', cat: 'potato_harvester', ops: ['harvest'], reqHp: 75, width: 0.75, speed: 4, cap: 4, load: 0.8,
      crops: ['ziemniaki'], mode: 'root', price: 195000, rentPerDay: 700, model: 'potato_harvester', color: COL.bulwa, life: 3000,
      desc: 'Kombajn ziemniaczany 1-rzędowy z bunkrem 4 t. Pełny bunkier przeładowuje na przyczepę jadącą obok.'
    },
    ziemniak_2: {
      name: 'Bulwa Z-2 Duo', brand: 'Bulwa', cat: 'potato_harvester', ops: ['harvest'], reqHp: 120, width: 1.5, speed: 5, cap: 7, load: 0.85,
      crops: ['ziemniaki'], mode: 'root', price: 520000, rentPerDay: 1300, model: 'potato_harvester', color: COL.bulwa, life: 3500,
      desc: 'Kombajn 2-rzędowy z bunkrem 7 t i stołem przebierczym.'
    },
    burak_2: {
      name: 'Korzeń B-2 Ciągany', brand: 'Korzeń', cat: 'beet_harvester', ops: ['harvest'], reqHp: 100, width: 0.9, speed: 5, cap: 5, load: 0.8,
      crops: ['buraki'], mode: 'root', price: 290000, rentPerDay: 1000, model: 'beet_harvester', color: COL.korzen, life: 3000,
      desc: 'Ciągany kombajn buraczany 2-rzędowy z ogławiaczem, bunkier 5 t.'
    },
    burak_6: {
      name: 'Korzeń B-6 Samojezdny', brand: 'Korzeń', cat: 'beet_harvester', ops: ['harvest'], self: true, hp: 480, width: 2.7, speed: 6, cap: 20,
      crops: ['buraki'], mode: 'root', price: 1650000, rentPerDay: 6500, fuelLph: 50, model: 'beet_harvester', color: COL.korzen, life: 6000,
      desc: 'Samojezdny 6-rzędowy kombajn buraczany, bunkier 20 t — zwykle z usług.'
    },
    sieczkarnia_p: {
      name: 'Kiszon S-2 Ciągana', brand: 'Kiszon', cat: 'forage_harvester', ops: ['harvest'], reqHp: 120, width: 1.5, speed: 5, cap: 0, load: 0.95,
      crops: ['kukurydza', 'kiszonka'], mode: 'silage', price: 125000, rentPerDay: 550, model: 'forage_harvester', color: COL.kiszon, life: 3000,
      desc: 'Sieczkarnia ciągana 2-rzędowa na kiszonkę z kukurydzy. Bez zbiornika — pracuje tylko z przyczepą jadącą równolegle.'
    },
    sieczkarnia_s: {
      name: 'Kiszon SX-8 Samojezdna', brand: 'Kiszon', cat: 'forage_harvester', ops: ['harvest'], self: true, hp: 600, width: 6, speed: 7, cap: 0,
      crops: ['kukurydza', 'kiszonka'], mode: 'silage', price: 2400000, rentPerDay: 8000, fuelLph: 70, model: 'forage_harvester', color: COL.kiszon, life: 6000,
      desc: 'Samojezdna sieczkarnia z przystawką 8-rzędową — król kiszonek, dostępny głównie w usługach.'
    }
  };
  for (const id in G.MACHINES) G.MACHINES[id].id = id;

  // Gęstość zboża (t/m³) — przeliczenia zbiornika kombajnu i skrzyni przyczepy
  G.GRAIN_T_PER_M3 = 0.76;
  // Wymagana moc ciągnika dla przyczepy o ładowności cap (t): 6 → 60, 10 → 80, 14 → 110, 20 → 150, 30 → 220 KM (interpolacja)
  G.trailerReqHp = function (cap) {
    const pts = [[3, 40], [6, 60], [10, 80], [14, 110], [20, 150], [30, 220]];
    if (cap <= pts[0][0]) return pts[0][1];
    for (let k = 1; k < pts.length; k++) if (cap <= pts[k][0]) { const [a, b] = pts[k - 1], [c, d] = pts[k]; return Math.round(b + (d - b) * (cap - a) / (c - a)); }
    return pts[pts.length - 1][1];
  };
  // Zestaw 2 przyczep: suma ładowności, reqHp ≈ (reqHp1 + reqHp2) × 0,8; pierwsza musi mieć tylny zaczep, tridem tylko jako ostatnia/jedyna
  G.trailerPairOk = function (d1, d2) {
    if (!d1 || !d2 || d1.cat !== 'trailer' || d2.cat !== 'trailer') return { ok: false, reason: 'To nie są przyczepy' };
    if (!d1.rearHitch) return { ok: false, reason: d1.name + ' nie ma tylnego zaczepu' };
    if (d1.axle === 'tridem') return { ok: false, reason: 'Przyczepa tridem może być tylko ostatnia' };
    return { ok: true, cap: d1.cap + d2.cap, reqHp: Math.round(((d1.reqHp || 0) + (d2.reqHp || 0)) * 0.8) };
  };
  // Wydajność rury wyładowczej w t/h GRY: realnie unloadLps × 2,74 t/h (105 l/s ≈ 290 t/h, zbiornik 8,5 t w ~2 min); dla czytelności
  // w grze skala ×0,21 → 75 l/s ≈ 43 t/h, 105 ≈ 60 t/h, 125 ≈ 71 t/h, 140 ≈ 80 t/h (widać stojący kombajn i rurę; dzień zmienia się o 2–4 %).
  G.augerTph = function (d) { const lps = (d && d.unloadLps) || 105; return Math.round(lps * G.GRAIN_T_PER_M3 * 3.6 * 0.21 * 10) / 10; };

  // Nazwy kategorii (dla UI)
  G.MACHINE_CATS = {
    tractor: 'Ciągniki', combine: 'Kombajny zbożowe', header: 'Hedery', plow: 'Pługi', cultivator: 'Agregaty i brony',
    seeder: 'Siewniki zbożowe', planter: 'Sadzarki i siewniki punktowe', sprayer: 'Opryskiwacze', spreader: 'Rozsiewacze nawozów',
    manure_spreader: 'Rozrzutniki i beczki', mower: 'Kosiarki', rake: 'Zgrabiarki', baler: 'Prasy', trailer: 'Przyczepy',
    loader: 'Ładowarki', potato_harvester: 'Kombajny ziemniaczane', beet_harvester: 'Kombajny buraczane', forage_harvester: 'Sieczkarnie'
  };

  // Stawki usług rolniczych (kontraktor), zł/ha — realia PL; prasowanie zł/belę
  G.CONTRACTOR_RATES = {
    plow: 400, cultivate: 180, lime: 90, fertilize: 70, fertilize_obornik: 160, fertilize_gnojowica: 140,
    sow: 220, sow_ziemniaki: 480, sow_precision: 260, spray: 90,
    harvest: 520, harvest_kukurydza: 620, harvest_ziemniaki: 1300, harvest_buraki: 950, harvest_silage: 650,
    mow: 150, rake: 90, bale_per_bale: 13
  };
})();
