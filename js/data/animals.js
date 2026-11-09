// Złote Pola — gatunki i rasy zwierząt, pasze, produkty zwierzęce → G.ANIMALS, G.PRODUCTS (agent: hodowla i budynki)
//
// WAŻNE — skala czasu: wszystkie dawki, produkcja i przyrosty poniżej są REALNE na dobę rzeczywistą (kg/dzień/szt.).
// Rok gry ma 72 dni, więc symulacja mnoży je przez G.ANIMAL_DAY_SCALE = 365/72 ≈ 5,07 (jeden dzień gry ≈ 5 dni realnych).
// Dzięki temu roczne sumy (mleko ~8,9 tys. l od krowy, cykl tuczu ~110 dni ≈ 22 dni gry) i opłacalność są zbliżone do realnych
// i spójne z plonami (1 zbiór na rok gry). Praca (laborH) jest w godzinach na dzień GRY (bez skalowania) — dla modułu pracowników.
//
// Kształt (zgodny z DESIGN.md, rozszerzony):
//   G.ANIMALS[gatunek] = { name, plural, icon, model (klucz grafiki), building (typ budynku), price (zł/szt.),
//     feed: { produkt: kg/dzień/szt } (dawka wzorcowa — do opisu w UI),
//     ration: [{ key, name, kg (kg ekwiwalentu/dzień/szt.), w (waga w ocenie żywienia), opts: [{ id: produkt|'zboza'|'pastwisko', f (kg produktu na 1 kg ekwiwalentu), q (jakość 0..1) }] }],
//     water (l/dzień), products: { produkt: ilość/dzień/szt (średnio) }, growth?: { start, sell, gain (kg/dzień) }, sellAs?: produkt,
//     manure: { obornik (kg/dzień), gnojowica (l/dzień) }, bedding (kg słomy/dzień), laborH (h/dzień gry/szt. przy poziomie 1 budynku),
//     vetDay (zł/dzień/szt.: weterynarz, inseminacja, szczepienia), utilDay (zł/dzień/szt.: woda, prąd), mort (śmiertelność/dzień),
//     lu (DJP — duża jednostka przeliczeniowa, do obsady pastwiska), diseases: [...], breeds?: {...}, desc }
window.G = window.G || {};
(function () {
  G.ANIMAL_DAY_SCALE = 365 / 72;
  // masa beli (kg) — do przeliczania dawek; jeśli dane upraw podadzą G.PRODUCTS[id].kg, ma pierwszeństwo
  G.BALE_KG = { siano: 250, sianokiszonka: 600, sloma: 200 };
  // zboża paszowe (moduł upraw definiuje te produkty); karmimy najtańszym dostępnym
  G.FEED_GRAINS = ['pszenzyto', 'jeczmien', 'pszenica', 'kukurydza', 'owies', 'zyto'];

  // ---------- produkty zwierzęce i pasze ----------
  const P = {
    jaja:             { name: 'Jaja', unit: 'szt', icon: '🥚', cat: 'zwierzęce', base: 0.5, vol: 0.15, perishable: 14 },
    mleko:            { name: 'Mleko krowie', unit: 'l', icon: '🥛', cat: 'zwierzęce', base: 2.2, vol: 0.1, perishable: 2 },
    mleko_kozie:      { name: 'Mleko kozie', unit: 'l', icon: '🍼', cat: 'zwierzęce', base: 3.2, vol: 0.1, perishable: 2 },
    zywiec_wieprzowy: { name: 'Żywiec wieprzowy', unit: 'kg', icon: '🐖', cat: 'zwierzęce', base: 6.0, vol: 0.18 },
    zywiec_wolowy:    { name: 'Żywiec wołowy', unit: 'kg', icon: '🐂', cat: 'zwierzęce', base: 9.0, vol: 0.12 },
    zywiec_drobiowy:  { name: 'Żywiec drobiowy (brojler)', unit: 'kg', icon: '🐔', cat: 'zwierzęce', base: 4.8, vol: 0.15 },
    zywiec_jagniecy:  { name: 'Jagnięta i koźlęta (żywiec)', unit: 'kg', icon: '🐑', cat: 'zwierzęce', base: 14, vol: 0.12 },
    welna:            { name: 'Wełna owcza', unit: 'kg', icon: '🧶', cat: 'zwierzęce', base: 3, vol: 0.2 },
    miod:             { name: 'Miód', unit: 'kg', icon: '🍯', cat: 'zwierzęce', base: 24, vol: 0.1 },
    warzywa:          { name: 'Warzywa szklarniowe', unit: 'kg', icon: '🍅', cat: 'okopowe', base: 3.5, vol: 0.25, perishable: 6 },
    pasza_tresciwa:   { name: 'Pasza treściwa (mieszanka)', unit: 't', icon: '🌾', cat: 'pasza', base: 1750, vol: 0.08 }
  };
  // nawozy naturalne — jeśli moduł upraw już je zdefiniował, zachowaj jego wpis
  const P2 = {
    obornik:   { name: 'Obornik', unit: 't', icon: '💩', cat: 'nawozy', base: 60, vol: 0.05 },
    gnojowica: { name: 'Gnojowica', unit: 'm3', icon: '🛢️', cat: 'nawozy', base: 25, vol: 0.05 }
  };
  G.PRODUCTS = G.PRODUCTS || {};
  Object.assign(G.PRODUCTS, P);
  for (const id in P2) G.PRODUCTS[id] = Object.assign({}, P2[id], G.PRODUCTS[id] || {});

  // ---------- gatunki ----------
  const o = (id, f, q) => ({ id, f: f == null ? 1 : f, q: q == null ? 1 : q });

  G.ANIMALS = {
    kura: {
      name: 'Kura nioska', plural: 'kury nioski', icon: '🐔', model: 'hen', building: 'henhouse', price: 28,
      desc: 'Nioska 20-tygodniowa. Ok. 300 jaj rocznie, wydajność spada po 70. tygodniu życia.',
      feed: { pasza_tresciwa: 0.12 },
      ration: [{ key: 'pasza', name: 'mieszanka dla niosek', kg: 0.12, w: 1, opts: [o('pasza_tresciwa'), o('zboza', 1, 0.7)] }],
      water: 0.25, products: { jaja: 0.82 }, manure: { obornik: 0.15, gnojowica: 0 }, bedding: 0.01,
      laborH: 0.012, laborMin: 0.3, vetDay: 0.004, utilDay: 0.004, mort: 0.0002, lu: 0.004, cullValue: 7,
      diseases: [
        { id: 'kokcydioza', name: 'Kokcydioza', p: 0.012, frac: 0.3, prod: 0.8, mort: 0.003, days: 3, vet: 0.8 },
        { id: 'hpai', name: 'Ptasia grypa (HPAI) — likwidacja stada', p: 0.0003, cull: true, comp: 0.9 }
      ]
    },
    brojler: {
      name: 'Brojler', plural: 'brojlery', icon: '🐤', model: 'hen', building: 'henhouse', price: 2.6,
      desc: 'Kurczę jednodniowe. Tucz ok. 42 dni (≈ 8 dni gry) do 2,6 kg. Tylko pełna mieszanka daje dobre przyrosty.',
      feed: { pasza_tresciwa: 0.11 },
      ration: [{ key: 'pasza', name: 'mieszanka dla brojlerów', kg: 0.11, w: 1, opts: [o('pasza_tresciwa'), o('zboza', 1, 0.55)] }],
      water: 0.2, products: {}, growth: { start: 0.045, sell: 2.6, gain: 0.062, ref: 1.4, minMul: 0.2, maxMul: 1.8 }, sellAs: 'zywiec_drobiowy',
      manure: { obornik: 0.08, gnojowica: 0 }, bedding: 0.02,
      laborH: 0.002, laborMin: 0.3, vetDay: 0.01, utilDay: 0.01, mort: 0.0008, lu: 0.003,
      diseases: [{ id: 'kokcydioza', name: 'Kokcydioza', p: 0.015, frac: 0.3, prod: 0.8, mort: 0.004, days: 3, vet: 0.3 }]
    },
    krowa: {
      name: 'Krowa mleczna', plural: 'krowy mleczne', icon: '🐄', model: 'cow', building: 'cowshed', price: 9500,
      desc: 'Średnio ~24 l mleka dziennie w ciągu roku (szczyt laktacji ~32 l, 60 dni zasuszenia). Cielę co ok. 400 dni.',
      feed: { kiszonka: 30, sianokiszonka: 10, pasza_tresciwa: 7 },
      ration: [
        { key: 'obj', name: 'pasze objętościowe (kiszonka, sianokiszonka, siano, pastwisko)', kg: 42, w: 0.55,
          opts: [o('pastwisko'), o('kiszonka', 1, 1), o('sianokiszonka', 0.75, 1), o('siano', 0.4, 0.9)] },
        { key: 'tr', name: 'pasze treściwe', kg: 7, w: 0.45, opts: [o('pasza_tresciwa'), o('zboza', 1, 0.8)] }
      ],
      water: 90, products: { mleko: 24.5 }, manure: { obornik: 35, gnojowica: 55 }, bedding: 4, beddingFree: 1.5,
      laborH: 0.25, laborMin: 0.5, vetDay: 2.0, utilDay: 1.4, mort: 0.00008, lu: 1, cullKg: 620, cullMul: 0.75,
      repro: { interval: 400, calfSell: { m: 1200, f: 900 }, heiferDays: 730, heiferValue: 9000 },
      breeds: {
        hf: { name: 'Polska holsztyńsko-fryzyjska (HF)', prodMul: 1, priceMul: 1, calfMul: 1 },
        sim: { name: 'Simentaler (simental)', prodMul: 0.8, priceMul: 1.1, calfMul: 1.8 },
        pc: { name: 'Polska czerwona (rasa zachowawcza)', prodMul: 0.6, priceMul: 0.8, calfMul: 1.1, feedMul: 0.8 }
      },
      diseases: [
        { id: 'mastitis', name: 'Zapalenie wymienia (mastitis)', p: 0.02, frac: 0.1, prod: 0.85, mort: 0, days: 3, vet: 250 },
        { id: 'kulawizna', name: 'Kulawizna', p: 0.012, frac: 0.15, prod: 0.92, mort: 0, days: 4, vet: 150 },
        { id: 'ketoza', name: 'Ketoza poporodowa', p: 0.008, frac: 0.08, prod: 0.88, mort: 0.0005, days: 3, vet: 300, feedRisk: true }
      ]
    },
    opas: {
      name: 'Byczek opasowy', plural: 'opasy', icon: '🐂', model: 'cow', color: '#6b4a32', building: 'cowshed', price: 2800,
      desc: 'Byczek ~200 kg. Tucz do ~650 kg przy przyroście 1,2 kg/dzień (ok. 375 dni ≈ 74 dni gry).',
      feed: { kiszonka: 22, siano: 1, pasza_tresciwa: 2.2 },
      ration: [
        { key: 'obj', name: 'pasze objętościowe', kg: 24, w: 0.6, opts: [o('kiszonka'), o('sianokiszonka', 0.75), o('siano', 0.4, 0.85)] },
        { key: 'tr', name: 'pasze treściwe', kg: 2.2, w: 0.4, opts: [o('zboza'), o('pasza_tresciwa')] }
      ],
      water: 40, products: {}, growth: { start: 200, sell: 650, gain: 1.2, ref: 430, minMul: 0.55, maxMul: 1.4 }, sellAs: 'zywiec_wolowy',
      manure: { obornik: 25, gnojowica: 35 }, bedding: 3, beddingFree: 1,
      laborH: 0.05, laborMin: 0.3, vetDay: 0.4, utilDay: 0.3, mort: 0.00005, lu: 0.7,
      diseases: [{ id: 'brd', name: 'Choroba układu oddechowego', p: 0.012, frac: 0.2, prod: 0.8, mort: 0.001, days: 4, vet: 120 }]
    },
    tucznik: {
      name: 'Tucznik', plural: 'tuczniki', icon: '🐖', model: 'pig', building: 'pigsty', price: 320,
      desc: 'Warchlak 30 kg → tucznik 118 kg (ok. 105 dni ≈ 21 dni gry). Same zboża bez białka = słabe przyrosty.',
      feed: { zboza: 2.0, pasza_tresciwa: 0.55 },
      ration: [
        { key: 'zb', name: 'śruta zbożowa', kg: 2.0, w: 0.65, opts: [o('zboza'), o('pasza_tresciwa')] },
        { key: 'bi', name: 'koncentrat białkowy / mieszanka', kg: 0.55, w: 0.35, opts: [o('pasza_tresciwa')] }
      ],
      water: 7, products: {}, growth: { start: 30, sell: 118, gain: 0.88, ref: 75, minMul: 0.45, maxMul: 1.45 }, sellAs: 'zywiec_wieprzowy',
      manure: { obornik: 5, gnojowica: 5 }, bedding: 0.4, beddingFree: 0,
      laborH: 0.04, laborMin: 0.3, vetDay: 0.08, utilDay: 0.06, mort: 0.0001, lu: 0.14, pigletKgPrice: 11,
      diseases: [
        { id: 'biegunka', name: 'Biegunka / dyzenteria', p: 0.018, frac: 0.3, prod: 0.8, mort: 0.002, days: 3, vet: 15 },
        { id: 'asf', name: 'ASF (afrykański pomór świń) — likwidacja stada', p: 0.0004, cull: true, comp: 0.8 }
      ]
    },
    locha: {
      name: 'Locha', plural: 'lochy', icon: '🐷', model: 'pig', color: '#e8b7b0', building: 'pigsty', price: 1600,
      desc: 'Ok. 2,3 miotu rocznie, ~26 prosiąt odchowanych (podchowane do 25 kg trafiają do tuczu w tej chlewni albo na sprzedaż).',
      feed: { zboza: 3.2, pasza_tresciwa: 1.0 },
      ration: [
        { key: 'zb', name: 'śruta zbożowa', kg: 3.2, w: 0.6, opts: [o('zboza'), o('pasza_tresciwa')] },
        { key: 'bi', name: 'mieszanka dla loch i prosiąt', kg: 1.0, w: 0.4, opts: [o('pasza_tresciwa')] }
      ],
      water: 20, products: {}, manure: { obornik: 12, gnojowica: 14 }, bedding: 1, beddingFree: 0,
      laborH: 0.15, laborMin: 0.3, vetDay: 1.0, utilDay: 0.4, mort: 0.0001, lu: 0.4, cullKg: 230, cullMul: 0.8,
      repro: { perYear: 26, pigletW: 25 },
      diseases: [
        { id: 'biegunka', name: 'Biegunka prosiąt', p: 0.015, frac: 0.3, prod: 0.8, mort: 0.001, days: 3, vet: 40 },
        { id: 'asf', name: 'ASF (afrykański pomór świń) — likwidacja stada', p: 0.0004, cull: true, comp: 0.8 }
      ]
    },
    owca: {
      name: 'Owca (maciorka)', plural: 'owce', icon: '🐑', model: 'sheep', building: 'sheepfold', price: 900,
      desc: 'Polska owca nizinna. Jagnięta w marcu (~1,45/maciorkę), strzyża w maju (~4 kg wełny). Latem pastwisko.',
      feed: { siano: 1.5, sianokiszonka: 1.5, zboza: 0.25 },
      ration: [
        { key: 'obj', name: 'siano, sianokiszonka, pastwisko', kg: 2.2, w: 0.85, opts: [o('pastwisko'), o('siano'), o('sianokiszonka', 2.2), o('kiszonka', 2.6, 0.85)] },
        { key: 'tr', name: 'ziarno / mieszanka', kg: 0.25, w: 0.15, opts: [o('zboza'), o('pasza_tresciwa')] }
      ],
      water: 5, products: {}, wool: 4, manure: { obornik: 2.5, gnojowica: 0 }, bedding: 0.4,
      laborH: 0.03, laborMin: 0.3, vetDay: 0.15, utilDay: 0.05, mort: 0.0001, lu: 0.1, cullKg: 60, cullMul: 0.45,
      repro: { month: 2, perHead: 1.45, sellAge: 100, sellKg: 34 },
      diseases: [{ id: 'pasozyty', name: 'Pasożyty wewnętrzne', p: 0.018, frac: 0.4, prod: 0.85, mort: 0.001, days: 3, vet: 12 }]
    },
    koza: {
      name: 'Koza mleczna', plural: 'kozy', icon: '🐐', model: 'goat', building: 'sheepfold', price: 1100,
      desc: 'Biała uszlachetniona. Ok. 2,2 l mleka dziennie (średnio w roku), koźlęta w lutym.',
      feed: { siano: 2, zboza: 0.6 },
      ration: [
        { key: 'obj', name: 'siano, sianokiszonka, pastwisko', kg: 2.5, w: 0.7, opts: [o('pastwisko'), o('siano'), o('sianokiszonka', 2.2), o('kiszonka', 2.6, 0.85)] },
        { key: 'tr', name: 'ziarno / mieszanka', kg: 0.6, w: 0.3, opts: [o('pasza_tresciwa'), o('zboza', 1, 0.9)] }
      ],
      water: 8, products: { mleko_kozie: 2.2 }, manure: { obornik: 2.5, gnojowica: 0 }, bedding: 0.4,
      laborH: 0.06, laborMin: 0.3, vetDay: 0.2, utilDay: 0.1, mort: 0.0001, lu: 0.1, cullKg: 50, cullMul: 0.45,
      repro: { month: 1, perHead: 1.6, sellAge: 50, sellKg: 14 },
      diseases: [{ id: 'pasozyty', name: 'Pasożyty wewnętrzne', p: 0.018, frac: 0.4, prod: 0.85, mort: 0.001, days: 3, vet: 12 }]
    },
    kon: {
      name: 'Koń', plural: 'konie', icon: '🐎', model: 'horse', building: 'stable', price: 8000,
      desc: 'Koń rekreacyjny (małopolski). Jazdy dla gości od maja do września — więcej z agroturystyką.',
      feed: { siano: 8, owies: 3 },
      ration: [
        { key: 'obj', name: 'siano, pastwisko', kg: 8, w: 0.65, opts: [o('pastwisko'), o('siano'), o('sianokiszonka', 2, 0.85)] },
        { key: 'tr', name: 'owies', kg: 3, w: 0.35, opts: [o('owies'), o('jeczmien', 1, 0.9), o('pasza_tresciwa', 1, 0.9), o('pszenzyto', 1, 0.8)] }
      ],
      water: 35, products: {}, rides: 45, manure: { obornik: 22, gnojowica: 0 }, bedding: 5,
      laborH: 0.5, laborMin: 0.5, vetDay: 1.5, utilDay: 0.5, mort: 0.00003, lu: 1, cullValue: 5000,
      diseases: [{ id: 'kolka', name: 'Kolka', p: 0.008, frac: 0.3, prod: 0.5, mort: 0.002, days: 2, vet: 600 }]
    },
    pszczoly: {
      name: 'Rodzina pszczela (ul)', plural: 'ule', icon: '🐝', model: 'bee', building: 'apiary', price: 650,
      desc: 'Ok. 20 kg miodu z ula rocznie: rzepak (maj), akacja (czerwiec), lipa (lipiec). Zimą straty ~10% rodzin.',
      feed: {}, ration: [], water: 0, products: {}, honey: 20, manure: { obornik: 0, gnojowica: 0 }, bedding: 0,
      laborH: 0.03, laborMin: 0.2, vetDay: 0.15, utilDay: 0, mort: 0, lu: 0, cullValue: 350, sugarAutumn: 60,
      diseases: [{ id: 'warroza', name: 'Warroza', p: 0.02, frac: 0.5, prod: 0.75, mort: 0.01, days: 4, vet: 25, summer: true }]
    }
  };

  // kolejność żywienia przy niedoborze (najcenniejsze najpierw)
  G.ANIMAL_ORDER = ['krowa', 'locha', 'tucznik', 'opas', 'kon', 'koza', 'owca', 'kura', 'brojler', 'pszczoly'];
})();
