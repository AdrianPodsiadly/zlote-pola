// Złote Pola — katalog budynków gospodarczych → G.BUILDINGS (agent: hodowla i budynki)
//
// Kształt (zgodny z DESIGN.md):
//   G.BUILDINGS[type] = { name, size:[w,h] (kafle, przy rot 0), price (zł, poziom 1), buildDays (dni gry), model (klucz grafiki),
//                         color, capacity: { pula|produkt: ilość }, houses: { gatunek: sztuk }, upkeep (zł/dzień gry), levels:[...], desc,
//                         max? (limit sztuk), req? ([typy] — wystarczy jeden ukończony), cat ('mieszkalny'|'magazyn'|'inwentarski'|'techniczny'|'produkcja') }
//   levels[i] = { level, name, price (koszt budowy poziomu 1 / koszt rozbudowy do tego poziomu), buildDays, capacity, houses, upkeep,
//                 slots? (miejsca na maszyny), milkMul?, laborMul?, manure? ('obornik'|'gnojowica'), repairDiscount?, fuelDiscount?, kW?, desc }
//   Pola na górnym poziomie obiektu = wartości poziomu 1 (dla prostych odczytów); bieżący poziom: G.buildings.def(b).
//
// Pojemności są ABSOLUTNE dla danego poziomu (nie sumują się z poprzednimi poziomami tego samego budynku).
// Klucze pul magazynowych (G.BUILDING_POOLS): 'zboże' (t), 'bele' (siano + słoma, bel), 'sianokiszonka' (bel), 'kiszonka' (t),
// 'ziemniaki' (t), 'buraki' (t), 'nawozy' (t), 'środki ochrony' (l), 'nasiona' (t), 'obornik' (t), 'gnojowica' (m3), 'mleko' (l),
// 'mleko_kozie' (l), 'jaja' (szt), 'ON' (l), 'produkty' (wełna + miód, kg), 'warzywa' (kg).
//
// Czas: rok gry = 72 dni, więc czasy budowy to ok. 1/5 czasu rzeczywistego (obora ~6 mies. → 30 dni gry).
// Ceny: realia polskie 2026 (netto, z robocizną), utrzymanie ≈ 1,5% wartości rocznie (podatek, ubezpieczenie, drobne naprawy) / 72 dni.
window.G = window.G || {};
(function () {
  const YEAR = 72;
  const up = (cum, rate) => Math.max(5, Math.round(cum * (rate || 0.015) / YEAR));

  // Pule magazynowe: jednostka, nazwa, pojemność bazowa bez budynku (pod plandeką / pryzma / kopiec), straty dzienne nadwyżki ponad pojemność krytą
  G.BUILDING_POOLS = {
    'zboże':          { name: 'Ziarno i pasze treściwe', unit: 't',    base: 20,  loss: 0.004, rainLoss: 0.012, baseNote: 'pod plandeką na podwórzu' },
    'bele':           { name: 'Siano i słoma',           unit: 'bela', base: 40,  loss: 0.003, rainLoss: 0.01,  baseNote: 'sterta pod gołym niebem' },
    'sianokiszonka':  { name: 'Sianokiszonka (owijane)', unit: 'bela', base: 400, loss: 0.0005 },
    'kiszonka':       { name: 'Kiszonka',                unit: 't',    base: 150, loss: 0.0025, baseNote: 'pryzma na ziemi pod folią' },
    'ziemniaki':      { name: 'Ziemniaki',               unit: 't',    base: 40,  loss: 0.003, baseNote: 'kopiec polowy' },
    'buraki':         { name: 'Buraki',                  unit: 't',    base: 500, loss: 0.002, baseNote: 'pryzma przy drodze' },
    'nawozy':         { name: 'Nawozy',                  unit: 't',    base: 10 },
    'środki ochrony': { name: 'Środki ochrony roślin',   unit: 'l',    base: 60 },
    'nasiona':        { name: 'Nasiona i sadzeniaki',    unit: 't',    base: 3 },
    'obornik':        { name: 'Obornik',                 unit: 't',    base: 40,  baseNote: 'pryzma polowa (max kilka tygodni)' },
    'gnojowica':      { name: 'Gnojowica',               unit: 'm3',   base: 30,  baseNote: 'kanały pod rusztami' },
    'mleko':          { name: 'Mleko krowie (schładzalnik)', unit: 'l', base: 0 },
    'mleko_kozie':    { name: 'Mleko kozie',             unit: 'l',    base: 0 },
    'jaja':           { name: 'Jaja',                    unit: 'szt',  base: 300 },
    'ON':             { name: 'Olej napędowy',           unit: 'l',    base: 600, baseNote: 'mały zbiornik w garażu' },
    'produkty':       { name: 'Wełna i miód',            unit: 'kg',   base: 300 },
    'warzywa':        { name: 'Warzywa',                 unit: 'kg',   base: 500 }
  };

  function B(o) {
    // uzupełnij poziomy: skumulowany koszt → utrzymanie, wartości domyślne
    let cum = 0;
    o.levels.forEach((L, i) => {
      L.level = i + 1;
      cum += L.price;
      L.cumPrice = cum;
      L.capacity = L.capacity || {};
      L.houses = L.houses || {};
      if (L.upkeep == null) L.upkeep = up(cum, o.upkeepRate);
    });
    const L1 = o.levels[0];
    o.price = L1.price; o.buildDays = L1.buildDays; o.capacity = L1.capacity; o.houses = L1.houses; o.upkeep = L1.upkeep;
    if (L1.slots) o.slots = L1.slots;
    delete o.upkeepRate;
    return o;
  }

  G.BUILDINGS = {
    house: B({
      name: 'Dom mieszkalny', cat: 'mieszkalny', size: [2, 2], model: 'house', color: '#d8c7a3', max: 1,
      desc: 'Serce gospodarstwa. Remont obniża koszty, a pokoje gościnne dają dochód z agroturystyki latem.',
      levels: [
        { name: 'Dom po dziadku', price: 450000, buildDays: 36, upkeep: 90, capacity: { 'jaja': 200, 'produkty': 100, 'warzywa': 200 },
          desc: 'Stary dom z piwnicą. Ogrzewanie piecem, wysokie rachunki.' },
        { name: 'Dom po termomodernizacji', price: 160000, buildDays: 10, upkeep: 60, capacity: { 'jaja': 400, 'produkty': 300, 'warzywa': 600 },
          desc: 'Ocieplenie, pompa ciepła, fotowoltaika — niższe koszty utrzymania.' },
        { name: 'Dom z agroturystyką', price: 280000, buildDays: 14, upkeep: 110, capacity: { 'jaja': 600, 'produkty': 500, 'warzywa': 1000 },
          agro: true, desc: 'Pokoje gościnne. Dochód od maja do września (więcej przy stajni i pasiece), ok. 3 h pracy dziennie w sezonie.' }
      ]
    }),

    barn: B({
      name: 'Stodoła', cat: 'magazyn', size: [3, 2], model: 'barn', color: '#8b5a2b',
      desc: 'Bele siana i słomy, trochę ziarna luzem, mały magazyn nasion, nawozów i środków ochrony roślin.',
      levels: [
        { name: 'Stara stodoła drewniana', price: 140000, buildDays: 14,
          capacity: { 'bele': 150, 'zboże': 30, 'nasiona': 5, 'nawozy': 15, 'środki ochrony': 150, 'ziemniaki': 20 },
          desc: 'Klepisko i sąsieki. Ziarno luzem do 30 t.' },
        { name: 'Stodoła murowana', price: 190000, buildDays: 12,
          capacity: { 'bele': 320, 'zboże': 60, 'nasiona': 10, 'nawozy': 30, 'środki ochrony': 300, 'ziemniaki': 40 },
          desc: 'Betonowa posadzka, wydzielony magazyn ś.o.r.' },
        { name: 'Hala magazynowa stalowa', price: 420000, buildDays: 16,
          capacity: { 'bele': 700, 'zboże': 150, 'nasiona': 20, 'nawozy': 60, 'środki ochrony': 500, 'ziemniaki': 80 },
          desc: 'Duża hala — bele, ziarno w boksach, nawozy w big-bagach.' }
      ]
    }),

    garage: B({
      name: 'Garaż / wiata na maszyny', cat: 'techniczny', size: [2, 1], model: 'garage', color: '#7a7f87',
      desc: 'Maszyny pod dachem zużywają się wolniej. Liczba miejsc = ile maszyn zmieści się pod dachem.',
      levels: [
        { name: 'Stary garaż', price: 55000, buildDays: 6, slots: 2, capacity: {}, desc: '2 miejsca na maszyny.' },
        { name: 'Wiata na maszyny', price: 80000, buildDays: 6, slots: 4, capacity: { 'ON': 300 }, desc: '4 miejsca na maszyny.' },
        { name: 'Hala garażowa', price: 240000, buildDays: 12, slots: 8, capacity: { 'ON': 600 }, desc: '8 miejsc, brama segmentowa, ogrzewanie.' }
      ]
    }),

    henhouse: B({
      name: 'Kurnik', cat: 'inwentarski', size: [1, 1], model: 'henhouse', color: '#c8a165',
      desc: 'Kury nioski (jaja) i brojlery. Od kurnika ściółkowego — oświetlenie, nioska nie spada zimą.',
      levels: [
        { name: 'Mały kurnik', price: 18000, buildDays: 3, houses: { kura: 30, brojler: 60 }, capacity: { 'jaja': 600 }, laborMul: 1, light: false,
          desc: 'Kilkadziesiąt kur na wybiegu — jaja z wolnego wybiegu.' },
        { name: 'Kurnik ściółkowy', price: 95000, buildDays: 8, houses: { kura: 400, brojler: 1000 }, capacity: { 'jaja': 6000 }, laborMul: 0.5, light: true,
          desc: 'Do 400 niosek, poidła smoczkowe, oświetlenie.' },
        { name: 'Ferma drobiu', price: 650000, buildDays: 18, houses: { kura: 3000, brojler: 8000 }, capacity: { 'jaja': 40000 }, laborMul: 0.15, light: true,
          desc: 'Automatyczne karmienie i zbiór jaj, wentylacja.' }
      ]
    }),

    cowshed: B({
      name: 'Obora', cat: 'inwentarski', size: [3, 2], model: 'cowshed', color: '#b9a58a',
      desc: 'Krowy mleczne i opasy. Schładzalnik mleka — mleczarnia odbiera mleko co 2 dni.',
      levels: [
        { name: 'Obora uwięziowa', price: 480000, buildDays: 30, houses: { krowa: 20, opas: 30 }, capacity: { 'mleko': 6000 },
          milkMul: 0.92, laborMul: 1, manure: 'obornik',
          desc: 'Stanowiska na uwięzi, dojarka przewodowa, obornik na ściółce. Dużo pracy przy doju.' },
        { name: 'Obora wolnostanowiskowa z halą udojową', price: 1350000, buildDays: 28, houses: { krowa: 60, opas: 80 }, capacity: { 'mleko': 18000 },
          milkMul: 1.0, laborMul: 0.5, manure: 'gnojowica',
          desc: 'Legowiska, ruszty, hala udojowa „rybia ość”. Gnojowica — przyda się zbiornik.' },
        { name: 'Obora z robotami udojowymi', price: 1900000, buildDays: 24, houses: { krowa: 120, opas: 150 }, capacity: { 'mleko': 36000 },
          milkMul: 1.08, laborMul: 0.25, manure: 'gnojowica',
          desc: 'Dwa roboty udojowe, krowy doją się same 3× dziennie — wyższa wydajność, mało pracy.' }
      ]
    }),

    pigsty: B({
      name: 'Chlewnia', cat: 'inwentarski', size: [2, 2], model: 'pigsty', color: '#d7b9a0',
      desc: 'Tuczniki (cykl ok. 110 dni ≈ 22 dni gry) i lochy (prosięta). Uwaga na ASF!',
      levels: [
        { name: 'Chlewnia tradycyjna', price: 190000, buildDays: 18, houses: { tucznik: 60, locha: 10 }, growMul: 0.95, laborMul: 1, manure: 'obornik',
          desc: 'Kojce na ściółce, karmienie ręczne.' },
        { name: 'Tuczarnia rusztowa', price: 720000, buildDays: 22, houses: { tucznik: 350, locha: 40 }, capacity: { 'gnojowica': 300 },
          growMul: 1.0, laborMul: 0.35, manure: 'gnojowica', desc: 'Ruszty, paszociąg, automaty paszowe.' },
        { name: 'Tuczarnia przemysłowa', price: 1700000, buildDays: 28, houses: { tucznik: 1200, locha: 120 }, capacity: { 'gnojowica': 1000 },
          growMul: 1.05, laborMul: 0.15, manure: 'gnojowica', desc: 'Karmienie na mokro, sterowana wentylacja, bioasekuracja.' }
      ]
    }),

    sheepfold: B({
      name: 'Owczarnia', cat: 'inwentarski', size: [2, 1], model: 'sheepfold', color: '#a68a64',
      desc: 'Owce (jagnięta, wełna) i kozy (mleko). Latem wypas na łące.',
      levels: [
        { name: 'Owczarnia', price: 130000, buildDays: 10, houses: { owca: 60, koza: 40 }, capacity: { 'mleko_kozie': 800, 'produkty': 200 }, laborMul: 1, manure: 'obornik',
          desc: 'Prosty budynek na głębokiej ściółce.' },
        { name: 'Owczarnia z dojarnią', price: 160000, buildDays: 10, houses: { owca: 150, koza: 100 }, capacity: { 'mleko_kozie': 2500, 'produkty': 400 }, laborMul: 0.6, manure: 'obornik',
          desc: 'Dojarnia dla kóz, paśniki, korytarz paszowy.' },
        { name: 'Owczarnia nowoczesna', price: 320000, buildDays: 14, houses: { owca: 400, koza: 250 }, capacity: { 'mleko_kozie': 6000, 'produkty': 800 }, laborMul: 0.35, manure: 'obornik',
          desc: 'Duże stado, wóz paszowy, karuzela udojowa dla kóz.' }
      ]
    }),

    silo: B({
      name: 'Silos zbożowy', cat: 'magazyn', size: [1, 1], model: 'silo', color: '#c0c4c8',
      desc: 'Ziarno bez strat. Można postawić kilka silosów.',
      levels: [
        { name: 'Silos 100 t', price: 85000, buildDays: 4, capacity: { 'zboże': 100 }, desc: 'Silos lejowy z przenośnikiem.' },
        { name: 'Silos 250 t', price: 95000, buildDays: 4, capacity: { 'zboże': 250 }, desc: 'Większy silos płaskodenny.' },
        { name: 'Silos 500 t z suszarnią', price: 210000, buildDays: 6, capacity: { 'zboże': 500 }, dryer: true, desc: 'Suszarnia i czyszczalnia ziarna.' }
      ]
    }),

    granary: B({
      name: 'Magazyn płaski / spichlerz', cat: 'magazyn', size: [3, 2], model: 'granary', color: '#9aa0a6',
      desc: 'Duży magazyn ziarna, nawozów, nasion i ziemniaków (przechowalnia).',
      levels: [
        { name: 'Magazyn płaski 400 t', price: 520000, buildDays: 16, capacity: { 'zboże': 400, 'nasiona': 30, 'nawozy': 60, 'ziemniaki': 150, 'środki ochrony': 200 },
          desc: 'Hala z betonową posadzką i ścianami oporowymi.' },
        { name: 'Magazyn płaski 800 t', price: 380000, buildDays: 12, capacity: { 'zboże': 800, 'nasiona': 60, 'nawozy': 120, 'ziemniaki': 300, 'środki ochrony': 300 },
          desc: 'Dobudowana nawa.' },
        { name: 'Magazyn 1500 t z wentylacją', price: 600000, buildDays: 14, capacity: { 'zboże': 1500, 'nasiona': 100, 'nawozy': 200, 'ziemniaki': 600, 'środki ochrony': 500 },
          desc: 'Aktywna wentylacja podłogowa, przechowalnia ziemniaków.' }
      ]
    }),

    hayshed: B({
      name: 'Wiata na siano', cat: 'magazyn', size: [2, 1], model: 'hayshed', color: '#a0703c',
      desc: 'Bele siana i słomy pod dachem — bez strat od deszczu.',
      levels: [
        { name: 'Wiata na siano', price: 75000, buildDays: 5, capacity: { 'bele': 250 }, desc: 'Konstrukcja stalowa, dach z blachy.' },
        { name: 'Duża wiata', price: 70000, buildDays: 5, capacity: { 'bele': 550 }, desc: 'Przedłużona wiata.' }
      ]
    }),

    silage_clamp: B({
      name: 'Silos przejazdowy (kiszonka)', cat: 'magazyn', size: [2, 1], model: 'silage_clamp', color: '#8d9096',
      desc: 'Betonowe ściany i płyta — kiszonka bez strat i bez odcieków.',
      levels: [
        { name: 'Silos przejazdowy 450 t', price: 150000, buildDays: 6, capacity: { 'kiszonka': 450 }, desc: 'Jedna komora.' },
        { name: 'Silos przejazdowy 1000 t', price: 130000, buildDays: 6, capacity: { 'kiszonka': 1000 }, desc: 'Dwie komory.' },
        { name: 'Silos przejazdowy 1800 t', price: 170000, buildDays: 6, capacity: { 'kiszonka': 1800 }, desc: 'Trzy komory.' }
      ]
    }),

    manure_pad: B({
      name: 'Płyta obornikowa i zbiornik na gnojowicę', cat: 'techniczny', size: [2, 1], model: 'manure_pad', color: '#6b5a45',
      desc: 'Wymagana przy hodowli (azotanowa). Obornik i gnojowica to darmowy nawóz na pola.',
      levels: [
        { name: 'Płyta obornikowa', price: 90000, buildDays: 5, capacity: { 'obornik': 300 }, desc: 'Płyta z murkami i zbiornikiem na odcieki.' },
        { name: 'Płyta + zbiornik gnojowicy 800 m³', price: 150000, buildDays: 6, capacity: { 'obornik': 300, 'gnojowica': 800 }, desc: 'Zbiornik betonowy.' },
        { name: 'Płyta + zbiornik 2000 m³', price: 190000, buildDays: 6, capacity: { 'obornik': 500, 'gnojowica': 2000 }, desc: 'Drugi, przykryty zbiornik.' }
      ]
    }),

    workshop: B({
      name: 'Warsztat', cat: 'techniczny', size: [1, 1], model: 'workshop', color: '#8a8f7a',
      desc: 'Własne naprawy i przeglądy — taniej i szybciej.',
      levels: [
        { name: 'Warsztat', price: 65000, buildDays: 5, slots: 1, repairDiscount: 0.25, desc: 'Narzędzia, spawarka. Naprawy −25%.' },
        { name: 'Warsztat z kanałem', price: 85000, buildDays: 5, slots: 1, repairDiscount: 0.4, desc: 'Kanał, podnośnik, diagnostyka. Naprawy −40%.' }
      ]
    }),

    fuel_station: B({
      name: 'Stacja paliw (zbiornik ON)', cat: 'techniczny', size: [1, 1], model: 'fuel_station', color: '#c94a3a',
      desc: 'Hurtowy zakup oleju napędowego — taniej za litr.',
      levels: [
        { name: 'Zbiornik ON 5000 l', price: 32000, buildDays: 2, capacity: { 'ON': 5000 }, fuelDiscount: 0.07, desc: 'Dwupłaszczowy zbiornik z dystrybutorem. Paliwo −7%.' },
        { name: 'Zbiornik ON 10 000 l', price: 28000, buildDays: 2, capacity: { 'ON': 10000 }, fuelDiscount: 0.09, desc: 'Większy zbiornik — dostawy cysterną. Paliwo −9%.' }
      ]
    }),

    greenhouse: B({
      name: 'Tunel foliowy / szklarnia', cat: 'produkcja', size: [2, 1], model: 'greenhouse', color: '#cfe8e6',
      desc: 'Warzywa (pomidory, ogórki) — odbiór przez hurtownię co 2 dni. Wymaga pracy.',
      levels: [
        { name: 'Tunel foliowy 300 m²', price: 45000, buildDays: 3, yieldYear: 3600, seasonal: true, labor: 1.5, monthCost: 1200,
          desc: 'Sezon kwiecień–październik, ok. 3,6 t warzyw rocznie.' },
        { name: 'Szklarnia ogrzewana 1000 m²', price: 420000, buildDays: 14, yieldYear: 32000, seasonal: false, labor: 5, monthCost: 4500, heatCost: 9000,
          desc: 'Uprawa całoroczna, ogrzewanie zimą (tańsze z ciepłem z biogazowni).' }
      ]
    }),

    apiary: B({
      name: 'Pasieka', cat: 'inwentarski', size: [1, 1], model: 'apiary', color: '#e3b341',
      desc: 'Ule z rodzinami pszczelimi — miód zbierany w maju, czerwcu i lipcu.',
      levels: [
        { name: 'Pasieka 10 uli', price: 9000, buildDays: 1, houses: { pszczoly: 10 }, capacity: { 'produkty': 400 }, desc: 'Stojaki, podkarmiaczki, skrzynka narzędzi.' },
        { name: 'Pasieka 30 uli z pracownią', price: 22000, buildDays: 2, houses: { pszczoly: 30 }, capacity: { 'produkty': 1000 }, desc: 'Pracownia i wirówka.' },
        { name: 'Pasieka 80 uli z miodownią', price: 65000, buildDays: 4, houses: { pszczoly: 80 }, capacity: { 'produkty': 2500 }, desc: 'Miodownia zgodna z wymogami sanepidu.' }
      ]
    }),

    stable: B({
      name: 'Stajnia', cat: 'inwentarski', size: [2, 1], model: 'stable', color: '#9c6b3f',
      desc: 'Konie — jazdy konne dla gości od maja do września (lepiej z agroturystyką).',
      levels: [
        { name: 'Stajnia 6 boksów', price: 180000, buildDays: 12, houses: { kon: 6 }, desc: 'Boksy, siodlarnia, padok.' },
        { name: 'Stajnia 14 boksów z ujeżdżalnią', price: 240000, buildDays: 12, houses: { kon: 14 }, desc: 'Kryta ujeżdżalnia.' }
      ]
    }),

    biogas: B({
      name: 'Biogazownia', cat: 'produkcja', size: [3, 3], model: 'biogas', color: '#5f7d5a', req: ['cowshed', 'pigsty'],
      upkeepRate: 0.04,
      desc: 'Prąd z gnojowicy, obornika i kiszonki. Poferment wraca jako gnojowica. Wymaga obory lub chlewni.',
      levels: [
        { name: 'Mikrobiogazownia 50 kW', price: 2400000, buildDays: 45, kW: 50, capacity: { 'gnojowica': 400 },
          desc: 'Ok. 400 MWh prądu rocznie. Potrzeba ok. 60 m³ gnojowicy lub 10 t kiszonki na dzień gry.' },
        { name: 'Biogazownia 150 kW', price: 3800000, buildDays: 40, kW: 150, capacity: { 'gnojowica': 1200 },
          desc: 'Ok. 1200 MWh rocznie — wymaga dużo substratu (kiszonka z kilkudziesięciu ha).' }
      ]
    })
  };

  // Typy budynków stawiane na starcie gry (gospodarstwo po dziadku) — pozycje względem podwórza 8×7
  G.BUILDINGS_START = [
    { type: 'house', dx: 0, dy: 0, rot: 0, level: 1 },
    { type: 'garage', dx: 5, dy: 0, rot: 0, level: 1 },
    { type: 'barn', dx: 4, dy: 4, rot: 0, level: 1 },
    { type: 'henhouse', dx: 0, dy: 5, rot: 0, level: 1 }
  ];
})();
