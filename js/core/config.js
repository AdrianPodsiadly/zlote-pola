// Złote Pola — konfiguracja rdzenia (wspólna dla wszystkich modułów)
window.G = window.G || {};
(function () {
  G.VERSION = '0.1.1';
  G.SAVE_VERSION = 1;

  // Typy terenu (NIE zmieniaj numerów — są w zapisach; nowe dopisuj na końcu)
  G.T = { GRASS: 0, FIELD: 1, FOREST: 2, WATER: 3, ROAD: 4, YARD: 5, MEADOW: 6, VILLAGE: 7, ASPHALT: 8 };

  G.CFG = {
    W: 96, H: 96,              // mapa w kafelkach
    TILE_HA: 0.25,             // 1 kafelek = 50 × 50 m = 0,25 ha
    TICKS_PER_DAY: 24,         // tick = 1 godzina gry
    DAYS_PER_MONTH: 6,         // skrócony kalendarz: rok ≈ 72 dni gry
    START_MONTH: 2,            // 0 = styczeń; start 1 marca
    START_YEAR: 2026,
    DAY_LENGTHS: { 90: '1,5 min', 150: '2,5 min', 300: '5 min' },
    DAY_SEC: 150,              // domyślna długość doby przy 1× (s)
    SPEEDS: [0, 1, 3, 8],      // pauza, 1×, 3×, 8×
    START_MONEY: 60000,
    SAVE_PREFIX: 'zlotepola_'
  };
  G.CFG.TICK_MS = G.CFG.DAY_SEC * 1000 / G.CFG.TICKS_PER_DAY;

  G.setDayLength = function (sec) {
    if (!G.CFG.DAY_LENGTHS[sec]) return;
    G.CFG.DAY_SEC = sec;
    G.CFG.TICK_MS = sec * 1000 / G.CFG.TICKS_PER_DAY;
    try { localStorage.setItem(G.CFG.SAVE_PREFIX + 'daylen', String(sec)); } catch (e) { /* brak */ }
  };
  try { const v = +localStorage.getItem(G.CFG.SAVE_PREFIX + 'daylen'); if (G.CFG.DAY_LENGTHS[v]) G.setDayLength(v); } catch (e) { /* brak */ }

  G.MONTHS = ['styczeń', 'luty', 'marzec', 'kwiecień', 'maj', 'czerwiec', 'lipiec', 'sierpień', 'wrzesień', 'październik', 'listopad', 'grudzień'];
  G.MONTHS_GEN = ['stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca', 'lipca', 'sierpnia', 'września', 'października', 'listopada', 'grudnia'];
  G.SEASON_OF = ['zima', 'zima', 'wiosna', 'wiosna', 'wiosna', 'lato', 'lato', 'lato', 'jesień', 'jesień', 'jesień', 'zima'];

  // Rejestr produktów — moduły DOPISUJĄ swoje pozycje: Object.assign(G.PRODUCTS, {...})
  // { id: { name, unit: 't'|'l'|'szt'|'kg'|'bela'|'m3', icon, cat: 'zboże'|'okopowe'|'oleiste'|'pasza'|'zwierzęce'|'środki'|'paliwo'|'nasiona', base: cena bazowa zł/jedn., vol: zmienność 0..1, perishable?: dni }
  G.PRODUCTS = {};
})();
