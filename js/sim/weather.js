// Złote Pola — pogoda i klimat → G.weather (agent: uprawy i rynek)
//
// MODEL: każdy dzień gry ≈ 5 dni kalendarzowych, więc wartości dzienne opisują „typową pogodę tego okresu”:
//  - temperatura: klimat średni dla Polski centralnej (min/max wg miesiąca, płynnie interpolowane) + anomalia AR(1)
//    (fale zimna/upału trwają kilka dni), dobowy przebieg sinusoidalny (minimum ~4:00, maksimum ~15:00);
//  - opady: prawdopodobieństwo dnia z opadem wg miesiąca × „wilgotność roku” (losowana co rok: 0,65 = rok suchy,
//    1,3 = mokry), suma mm za okres; opad pada w bloku kilku godzin (wtedy type = 'rain'|'storm'|'snow');
//  - burze (V–VIII) i grad (ok. 15–20% burz, lokalnie — fields.js nakłada szkody na działki w promieniu);
//  - bilans wodny gleby: woda (mm, pojemność 160 mm) += opad + roztopy − ewapotranspiracja (ET0 wg miesiąca);
//    soilMoisture = woda / 160. Lato zwykle wysusza glebę (lipiec: opad ~80 mm, ET ~115 mm);
//  - śnieg (cm) przy opadzie i t < ~0,5 °C; topnieje przy dodatniej temperaturze; zamarzanie gruntu.
//  - prognoza: 3 kolejne dni wygenerowane z wyprzedzeniem (prognoza się sprawdza, ale podajemy % szansy opadu).
//
// Stan: G.S.weather. Publiczne pola (dla grafiki/UI) kopiowane co godzinę do G.weather:
//   type, intensity (0..1), temp (°C), wind (m/s), rainToday (mm), soilMoisture (0..1), snow (cm), frozen (bool),
//   dryHours (h od ostatniego deszczu), forecast: [{ day, label, type, tmin, tmax, rain, prob, storm }] (dziś + 3 dni),
//   drought (0..1 — nasilenie suszy), today: dzień bieżący, last: dzień zakończony wczoraj.
(function () {
  const W = G.weather = {
    type: 'clear', intensity: 0, temp: 5, wind: 2, rainToday: 0, soilMoisture: 0.8, snow: 0, frozen: false,
    dryHours: 24, forecast: [], drought: 0, today: null, last: null
  };
  const REAL_DAYS = 365 / 72;     // dni kalendarzowe na dzień gry
  W.REAL_DAYS = REAL_DAYS;
  W.CAP = 160;                    // pojemność wodna gleby (mm wody użytecznej)

  // klimat (Polska centralna, średnie wieloletnie): tmin, tmax (°C), opad miesięczny (mm), szansa dnia z opadem, ET0 (mm/mies.)
  const CL = W.CLIMATE = {
    tmin: [-4, -3.5, -0.5, 3.5, 8, 11.5, 13.5, 13, 9, 4.5, 1, -2.5],
    tmax: [1, 2.5, 7, 14, 19.5, 22.5, 24.5, 24, 19, 13, 6.5, 2],
    precip: [35, 30, 35, 35, 55, 65, 80, 65, 50, 40, 40, 40],
    pRain: [0.45, 0.4, 0.4, 0.38, 0.42, 0.45, 0.45, 0.4, 0.38, 0.4, 0.48, 0.48],
    et0: [5, 10, 25, 55, 90, 110, 115, 95, 55, 25, 10, 5],
    wind: [4.5, 4.5, 4.5, 4, 3.5, 3, 3, 3, 3.5, 4, 4.5, 4.5]
  };
  W.TYPE_NAMES = { clear: 'słonecznie', cloudy: 'pochmurno', rain: 'deszcz', storm: 'burza', snow: 'śnieg', fog: 'mgła' };
  W.TYPE_ICONS = { clear: '☀️', cloudy: '☁️', rain: '🌧️', storm: '⛈️', snow: '🌨️', fog: '🌫️' };

  const rnd = () => Math.random();
  function gauss() { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

  // klimat dla dnia roku z interpolacją między środkami miesięcy (doy 0..71)
  function clim(arr, dayIndex) {
    const C = G.CFG, mf = (C.START_MONTH * C.DAYS_PER_MONTH + dayIndex + 0.5) / C.DAYS_PER_MONTH - 0.5; // miesiąc ułamkowy
    const m0 = Math.floor(mf), a = mf - m0;
    return arr[((m0 % 12) + 12) % 12] * (1 - a) + arr[(((m0 + 1) % 12) + 12) % 12] * a;
  }
  W.clim = clim;
  function monthOf(dayIndex) { return (G.CFG.START_MONTH + Math.floor(dayIndex / G.CFG.DAYS_PER_MONTH)) % 12; }

  // ---------- generator dnia ----------
  function genDay(d, prev) {
    const S = G.S.weather, m = monthOf(d);
    S.anom = S.anom * 0.68 + gauss() * (m >= 10 || m <= 2 ? 2.6 : 1.9);
    let tmin = clim(CL.tmin, d) + S.anom + gauss() * 0.8;
    let tmax = clim(CL.tmax, d) + S.anom + gauss() * 1.0;
    let p = clim(CL.pRain, d) * S.yearWet * (prev && prev.rain > 0 ? 1.25 : 0.9);
    // susza ma tendencję do utrwalania się latem (wyż blokujący)
    if (m >= 4 && m <= 7 && S.water < 50) p *= 0.85;
    const wet = rnd() < Math.min(0.85, p);
    let rain = 0, type = 'clear', storm = false, hail = null;
    if (wet) {
      const mean = clim(CL.precip, d) / (G.CFG.DAYS_PER_MONTH * clim(CL.pRain, d));
      rain = Math.max(0.5, mean * (-Math.log(1 - rnd() * 0.97)) * (0.8 + 0.4 * S.yearWet));
      rain = Math.round(rain * 10) / 10;
      tmax -= 1.5 + rnd() * 2; tmin += 1;
      type = 'rain';
      if (m >= 4 && m <= 7 && tmax > 22 && rnd() < 0.35) {
        storm = true; type = 'storm'; rain = Math.round((rain + 5 + rnd() * 15) * 10) / 10;
        if (rnd() < 0.18) hail = { x: (rnd() * G.CFG.W) | 0, y: (rnd() * G.CFG.H) | 0, r: 6 + rnd() * 14, sev: 0.1 + rnd() * 0.3 };
      }
      if ((tmin + tmax) / 2 < 0.8) type = 'snow';
    } else {
      // pogoda bez opadu: słońce, chmury albo mgła (jesień)
      const r = rnd();
      type = r < 0.55 ? 'clear' : 'cloudy';
      if ((m >= 9 && m <= 11 || m <= 1) && rnd() < 0.25) type = 'fog';
      if (type === 'clear') { tmax += 1; tmin -= 1.2; }
    }
    if (tmax < tmin + 1.5) tmax = tmin + 1.5;
    const wind = Math.max(0.5, clim(CL.wind, d) + gauss() * 1.6 + (storm ? 8 : 0) + (type === 'rain' ? 1.5 : 0));
    // godziny opadu
    let rs = -1, re = -1;
    if (rain > 0) {
      const dur = storm ? 1 + ((rnd() * 3) | 0) : 2 + ((rnd() * Math.min(14, 2 + rain / 2)) | 0);
      rs = storm ? 13 + ((rnd() * 6) | 0) : (rnd() * (24 - dur)) | 0;
      re = Math.min(24, rs + dur);
    }
    return {
      day: d, month: m, type, tmin: Math.round(tmin * 10) / 10, tmax: Math.round(tmax * 10) / 10, rain, storm, hail,
      wind: Math.round(wind * 10) / 10, rs, re,
      prob: rain > 0 ? Math.min(95, Math.round(55 + rain * 2 + rnd() * 15)) : Math.round(5 + rnd() * 25)
    };
  }

  // ---------- inicjalizacja ----------
  function init() {
    const d0 = G.date().dayIndex;
    G.S.weather = {
      anom: 0, yearWet: 1, water: W.CAP * 0.82, snow: 0, frozen: false, dryH: 24, rainToday: 0,
      today: null, fc: [], last: null, et: 0, drought: 0, year: G.date().year,
      cur: { type: 'clear', intensity: 0, temp: 4, wind: 3 }
    };
    rollYear();
    const S = G.S.weather;
    S.today = genDay(d0, null);
    for (let k = 1; k <= 3; k++) S.fc.push(genDay(d0 + k, k === 1 ? S.today : S.fc[k - 2]));
    hourly();
  }
  function rollYear() {
    const S = G.S.weather;
    // 20% lat suchych, 20% mokrych
    const r = rnd();
    S.yearWet = r < 0.2 ? 0.62 + rnd() * 0.15 : r > 0.8 ? 1.15 + rnd() * 0.2 : 0.88 + rnd() * 0.22;
  }

  // ---------- przebieg godzinowy ----------
  function hourly() {
    const S = G.S.weather, t = S.today, h = G.S.tick % 24;
    const mean = (t.tmin + t.tmax) / 2, amp = (t.tmax - t.tmin) / 2;
    const temp = mean + amp * Math.cos((h - 15) / 24 * 2 * Math.PI);
    let type = t.type, intensity = 0;
    if (t.rain > 0) {
      if (h >= t.rs && h < t.re) {
        const perH = t.rain / Math.max(1, t.re - t.rs);
        intensity = Math.min(1, 0.2 + perH / 4);
        type = t.storm ? 'storm' : (temp < 0.8 ? 'snow' : 'rain');
        S.rainToday += perH;
        if (type === 'snow') S.snow += perH * 1.0; // 1 mm ≈ 1 cm śniegu
        S.dryH = 0;
      } else {
        type = 'cloudy';
        S.dryH += S.snow > 0 ? 0.3 : 1;
      }
    } else {
      if (t.type === 'fog' && (h < 6 || h > 10)) type = 'cloudy';
      S.dryH += temp > 15 ? 1.5 : temp < 3 ? 0.7 : 1;
    }
    // topnienie śniegu
    if (S.snow > 0 && temp > 0.5) { const melt = Math.min(S.snow, (temp - 0.5) * 0.25); S.snow -= melt; S.water += melt; }
    if (S.snow < 0.05) S.snow = 0;
    S.cur = { type, intensity: Math.round(intensity * 100) / 100, temp: Math.round(temp * 10) / 10, wind: t.wind };
    sync();
  }

  // ---------- koniec doby: bilans wodny, zamarzanie, nowa prognoza ----------
  function daily() {
    const S = G.S.weather, t = S.today;
    const tmean = (t.tmin + t.tmax) / 2;
    // ewapotranspiracja okresu (mm) — maleje, gdy gleba przesycha
    const climMean = (clim(CL.tmin, t.day) + clim(CL.tmax, t.day)) / 2;
    const hot = 1 + Math.max(-0.4, Math.min(0.5, (tmean - climMean) * 0.05));      // upał zwiększa parowanie
    const etPot = clim(CL.et0, t.day) / G.CFG.DAYS_PER_MONTH * hot * (t.type === 'clear' ? 1.15 : t.rain > 0 ? 0.75 : 0.95);
    // parowanie rzeczywiste: pełne przy ≥ 50% wody, niżej rośliny zamykają aparaty szparkowe (jak FAO-56, p = 0,5)
    const et = etPot * Math.max(0.12, Math.min(1, S.water / W.CAP / 0.5));
    const rainLiquid = tmean < 0.8 ? 0 : t.rain;
    S.water = Math.max(4, Math.min(W.CAP, S.water + rainLiquid - et));
    // zamarzanie gruntu
    if (t.tmax < 0 || tmean < -2.5) S.frozen = true;
    else if (tmean > 1 || t.tmax > 4) S.frozen = false;
    S.et = et;
    // susza: 0 przy wilgotności ≥ 45%, 1 przy ≤ 12%
    S.drought = Math.max(0, Math.min(1, (0.45 - S.water / W.CAP) / 0.33));
    S.last = Object.assign({}, t, { rainFell: Math.round(S.rainToday * 10) / 10, et: Math.round(et * 10) / 10, tmean, snow: S.snow, moisture: S.water / W.CAP, drought: S.drought });
    // komunikaty
    if (t.storm) G.notify(t.hail ? '⛈️ Burza z gradem przeszła nad okolicą!' : '⛈️ Przeszła burza — ' + Math.round(t.rain) + ' mm deszczu', t.hail ? 'bad' : 'warn', { key: 'storm' });
    // nowy dzień
    const d = G.date().dayIndex;
    if (G.date().year !== S.year) { S.year = G.date().year; rollYear(); }
    S.today = S.fc.shift() || genDay(d, t);
    if (S.today.day !== d) S.today = genDay(d, t);
    while (S.fc.length < 3) S.fc.push(genDay(d + 1 + S.fc.length, S.fc.length ? S.fc[S.fc.length - 1] : S.today));
    S.rainToday = 0;
    // ostrzeżenia z prognozy
    const nx = S.fc[0];
    if (nx && nx.tmin < -1 && nx.month >= 3 && nx.month <= 4) G.notify('🥶 Prognoza: przymrozek jutro (' + G.fmtNum(nx.tmin) + ' °C) — zagrożone wschody kukurydzy i ziemniaków', 'warn', { key: 'frostfc' });
    if (S.drought > 0.6) G.notify('🌵 Susza — gleba przesuszona (' + Math.round(S.water / W.CAP * 100) + '% wody). Plony spadają.', 'warn', { key: 'drought' });
  }

  function sync() {
    const S = G.S.weather;
    if (!S || !S.today) return;
    W.type = S.cur.type; W.intensity = S.cur.intensity; W.temp = S.cur.temp; W.wind = S.cur.wind;
    W.rainToday = Math.round(S.rainToday * 10) / 10; W.soilMoisture = Math.round(S.water / W.CAP * 1000) / 1000;
    W.snow = Math.round(S.snow * 10) / 10; W.frozen = S.frozen; W.dryHours = Math.round(S.dryH);
    W.drought = S.drought || 0; W.today = S.today; W.last = S.last;
    const labels = ['Dziś', 'Jutro', 'Pojutrze', 'Za 3 dni'];
    W.forecast = [S.today].concat(S.fc).map((f, k) => ({
      day: f.day, label: labels[k], type: f.type, tmin: f.tmin, tmax: f.tmax, rain: f.rain, prob: f.prob, storm: f.storm,
      icon: W.TYPE_ICONS[f.type], text: W.TYPE_NAMES[f.type]
    }));
  }

  // ---------- czy można pracować w polu ----------
  // op (opcjonalnie): 'plow'|'cultivate'|'sow'|'harvest'|'spray'|'fertilize'|'lime'|'mow'|'rake'|'bale'
  // → { ok: bool, reason?: tekst, waitH?: szacowane godziny oczekiwania }
  const SOIL_OPS = { plow: 1, cultivate: 1, sow: 1 };
  W.canWork = function (op) {
    const S = G.S && G.S.weather;
    if (!S || !S.cur) return { ok: true };
    const c = S.cur;
    if (c.type === 'storm') return { ok: false, reason: 'Burza — zjedź z pola', waitH: 2 };
    if (c.type === 'rain' && c.intensity > 0.15) return { ok: false, reason: 'Pada deszcz — prace polowe wstrzymane', waitH: Math.max(1, S.today.re - G.S.tick % 24) };
    if (c.type === 'snow' && c.intensity > 0.1) return { ok: false, reason: 'Pada śnieg', waitH: 3 };
    if (S.snow > 3 && op !== 'fertilize' && op !== 'lime') return { ok: false, reason: 'Pole pod śniegiem (' + Math.round(S.snow) + ' cm)' };
    if (S.frozen && (SOIL_OPS[op] || op === 'harvest' || op == null)) return { ok: false, reason: 'Zmarznięta ziemia — nie da się uprawiać ani siać' };
    if (op === 'spray') {
      if (c.wind > 5) return { ok: false, reason: 'Za silny wiatr na oprysk (' + G.fmtNum(c.wind) + ' m/s, maks. 5)', waitH: 3 };
      if (c.temp > 27) return { ok: false, reason: 'Za gorąco na oprysk (> 27 °C) — poczekaj do wieczora', waitH: 4 };
      if (S.dryH < 1) return { ok: false, reason: 'Mokre rośliny — oprysk spłynie', waitH: 1 };
    }
    let need = 0;
    if (op === 'harvest') need = 6;             // kombajn: łan i ziarno muszą obeschnąć
    else if (op === 'bale') need = 8;           // prasa: słoma/siano suche
    else if (op === 'mow') need = 2;
    else if (SOIL_OPS[op] || op == null) need = 3;
    else if (op === 'fertilize' || op === 'lime' || op === 'rake') need = 2;
    if (S.dryH < need) {
      const msg = op === 'harvest' ? 'Kombajn czeka, aż łan obeschnie po deszczu' : op === 'bale' ? 'Za mokro na prasowanie' : 'Za mokro — koła grzęzną';
      return { ok: false, reason: msg + ' (jeszcze ~' + Math.ceil(need - S.dryH) + ' h)', waitH: Math.ceil(need - S.dryH) };
    }
    if (SOIL_OPS[op] && S.water / W.CAP > 0.96 && S.dryH < 12) return { ok: false, reason: 'Gleba podmokła — poczekaj, aż obeschnie', waitH: 12 - S.dryH };
    return { ok: true };
  };

  // oczekiwana suma GDD (°C·doba) od dnia d przez n dni wg klimatu (dla prognoz terminu zbioru)
  W.expectedGdd = function (tbase, fromDay, nDays) {
    let s = 0;
    for (let k = 0; k < nDays; k++) {
      const d = fromDay + k, tm = (clim(CL.tmin, d) + clim(CL.tmax, d)) / 2;
      s += Math.max(0, tm - tbase + (tm < tbase + 3 ? 0.8 : 0)) * REAL_DAYS;
    }
    return s;
  };
  W.daysToGdd = function (tbase, fromDay, gddLeft, maxDays) {
    let s = 0, k = 0;
    maxDays = maxDays || 120;
    while (s < gddLeft && k < maxDays) { const d = fromDay + k, tm = (clim(CL.tmin, d) + clim(CL.tmax, d)) / 2; s += Math.max(0, tm - tbase) * REAL_DAYS; k++; }
    return k;
  };
  W.describe = function () {
    return (W.TYPE_ICONS[W.type] || '') + ' ' + (W.TYPE_NAMES[W.type] || W.type) + ', ' + G.fmtNum(W.temp) + ' °C';
  };

  // ---------- hooki ----------
  G.on('newGame', init);
  G.on('load', () => {
    const S = G.S.weather;
    if (!S || !S.today || !Array.isArray(S.fc)) { init(); return; }
    if (S.water == null) S.water = W.CAP * 0.7;
    if (S.anom == null) S.anom = 0;
    if (!S.yearWet) S.yearWet = 1;
    if (!S.cur) S.cur = { type: 'clear', intensity: 0, temp: 5, wind: 3 };
    if (S.snow == null) S.snow = 0;
    if (S.dryH == null) S.dryH = 24;
    sync();
  });
  G.on('tick', () => { if (G.S.weather && G.S.tick % 24 !== 0) hourly(); });
  G.on('daily', () => { if (!G.S.weather) init(); daily(); hourly(); });
})();
