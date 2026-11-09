// Złote Pola — dźwięk: syntezowane odgłosy maszyn, zwierząt, pogody i muzyka tła → G.sound (agent: dźwięk)
//
// Zero plików audio (CSP) — wszystko powstaje w Web Audio API: oscylatory, szum, filtry formantowe, obwiednie.
// Architektura:
//   źródła → (StereoPanner) → kanał (GainNode: master/music/machines/animals/ambient/ui) → master → kompresor → wyjście
// Każdy kanał ma głośność użytkownika (suwak) i mnożnik automatyczny (pauza, ukryta karta, ducking paneli).
// Dźwięki przestrzenne (maszyny, zwierzęta): głośność i panorama wg położenia kafla względem środka ekranu (G.cam).
// Czas: WYŁĄCZNIE zegar AudioContext / czas rzeczywisty — prędkość gry 3×/8× nie przyspiesza dźwięków;
// pora dnia / roku / pogoda decydują tylko o tym, CO gra, nie jak szybko.
//
// API (dla UI): G.sound.unlock(), toggle() → bool, on, setVol(ch, 0..1), vol, CHANNELS, play(name, opts?),
//               duck(bool), update(now, dtReal), names (lista nazw play), stats() (diagnostyka).
// Ustawienia w localStorage pod kluczem 'zlotepola_audio'.
(function () {
  const S = G.sound = {};
  const LS_KEY = 'zlotepola_audio';
  S.CHANNELS = [['master', 'Głośność ogólna'], ['music', 'Muzyka'], ['machines', 'Maszyny'], ['animals', 'Zwierzęta'], ['ambient', 'Otoczenie i pogoda'], ['ui', 'Interfejs']];
  const DEFAULT_VOL = { master: 0.8, music: 0.55, machines: 0.8, animals: 0.8, ambient: 0.7, ui: 0.8 };
  const MAX_VOICES = 24;        // jednoczesne głosy jednorazowe (efekty, zwierzęta, ptaki, UI)
  const MAX_MUSIC_VOICES = 14;  // osobny budżet muzyki
  const MAX_VEHICLES = 8;       // słyszalnych pojazdów naraz (najgłośniejsze)
  const SPATIAL_DT = 0.1;       // s — co ile aktualizować przestrzeń/parametry ciągłe

  // ---------- ustawienia ----------
  S.on = true;
  S.vol = Object.assign({}, DEFAULT_VOL);
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const o = JSON.parse(raw);
      if (o && typeof o === 'object') {
        if (typeof o.on === 'boolean') S.on = o.on;
        if (o.vol) for (const [k] of S.CHANNELS) if (typeof o.vol[k] === 'number' && isFinite(o.vol[k])) S.vol[k] = Math.max(0, Math.min(1, o.vol[k]));
      }
    }
  } catch (e) { /* brak localStorage */ }
  function saveSettings() { try { localStorage.setItem(LS_KEY, JSON.stringify({ on: S.on, vol: S.vol })); } catch (e) { /* brak */ } }

  // ---------- kontekst i mikser ----------
  let ctx = null, hasPan = false, noiseBuf = null;
  const ch = {};            // kanały: { gain: GainNode, auto: mnożnik automatyczny }
  let master = null, comp = null;
  const auto = { master: 1, music: 1, machines: 1, animals: 1, ambient: 1, ui: 1 };
  let ducked = false, hidden = !!document.hidden;
  let alive = 0, nodesAlive = 0, musicAlive = 0; // liczniki głosów / węzłów (diagnostyka i limity)
  const voices = new Set();

  function createContext(given) {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!given && !AC) return null;
    try { ctx = given || new AC({ latencyHint: 'interactive' }); } catch (e) { try { ctx = new AC(); } catch (e2) { return null; } }
    hasPan = typeof ctx.createStereoPanner === 'function';
    // bufor szumu białego (2 s) — wspólny dla wszystkich źródeł szumu
    const len = Math.floor(ctx.sampleRate * 2);
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    let seed = 1234567;
    for (let i = 0; i < len; i++) { seed = (seed * 1664525 + 1013904223) >>> 0; d[i] = seed / 2147483648 - 1; }
    // mikser
    comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 12; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.25;
    comp.connect(ctx.destination);
    master = ctx.createGain(); master.gain.value = 0; master.connect(comp);
    for (const [k] of S.CHANNELS) {
      if (k === 'master') { ch.master = { gain: master }; continue; }
      const g = ctx.createGain(); g.gain.value = 0; g.connect(master);
      ch[k] = { gain: g };
    }
    applyGains(true);
    initAmbient();
    initMusic();
    return ctx;
  }
  // mnożniki automatyczne → docelowe wartości węzłów (płynnie)
  function applyGains(immediate) {
    if (!ctx) return;
    const t = ctx.currentTime, tau = immediate ? 0.001 : 0.25;
    const sp = G.speed == null ? 1 : G.speed;
    const paused = sp === 0;
    auto.master = (S.on && !hidden) ? 1 : 0;
    auto.machines = paused ? 0 : 1;
    auto.animals = paused ? 0 : 1;
    auto.ambient = (paused ? 0.6 : 1) * (ducked ? 0.75 : 1);
    auto.music = (paused ? 0.55 : 1) * (ducked ? 0.35 : 1);
    auto.ui = 1;
    for (const [k] of S.CHANNELS) {
      const target = (k === 'master' ? 0.9 : 1) * S.vol[k] * auto[k];
      ch[k].gain.gain.cancelScheduledValues(t);
      ch[k].gain.gain.setTargetAtTime(target, t, tau);
    }
  }

  S.unlock = function (givenCtx) {
    if (!createContext(givenCtx)) return false;
    const offline = typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext;
    if (!offline && ctx.state === 'suspended' && ctx.resume) { try { const pr = ctx.resume(); if (pr && pr.catch) pr.catch(() => { /* bez gestu użytkownika */ }); } catch (e) { /* ok */ } }
    return true;
  };
  S.ready = function () { return !!ctx && ctx.state === 'running'; };
  S.toggle = function () { S.on = !S.on; saveSettings(); if (S.on) S.unlock(); applyGains(); return S.on; };
  S.setVol = function (k, v) {
    if (!(k in S.vol)) return;
    S.vol[k] = Math.max(0, Math.min(1, +v || 0));
    saveSettings(); applyGains();
  };
  S.duck = function (b) { ducked = !!b; applyGains(); };
  S.stats = function () { return { ctx: !!ctx, state: ctx && ctx.state, voices: alive, nodes: nodesAlive, music: musicAlive, vehicles: vehVoices.size, bees: beeVoices.size }; };

  // Odblokowanie gestem użytkownika (iOS/Chrome wymagają gestu). Nasłuch zostaje na stałe — iOS potrafi
  // zawiesić kontekst po telefonie/przełączeniu aplikacji, a kolejne dotknięcie go wznawia.
  function gestureUnlock() { if (!ctx || ctx.state !== 'running') S.unlock(); }
  document.addEventListener('pointerdown', gestureUnlock, true);
  document.addEventListener('keydown', gestureUnlock, true);
  document.addEventListener('touchend', gestureUnlock, true);
  document.addEventListener('visibilitychange', () => { hidden = document.hidden; applyGains(); });
  G.on('speed', () => applyGains());

  // ---------- narzędzia syntezy ----------
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const rnd = (a, b) => a + Math.random() * (b - a);
  const pick = arr => arr[Math.floor(Math.random() * arr.length)];
  const midi = n => 440 * Math.pow(2, (n - 69) / 12);

  // Głos: zbiór węzłów z jednym wyjściem (gain → panner → kanał); sprząta po sobie po zakończeniu
  class Voice {
    constructor(out, pan, music) {
      this.nodes = []; this.srcs = []; this.dead = false; this.music = !!music;
      this.g = ctx.createGain(); this.g.gain.value = 1; nodesAlive++;
      if (hasPan && pan != null) { this.p = ctx.createStereoPanner(); this.p.pan.value = clamp(pan, -1, 1); this.g.connect(this.p); this.p.connect(out); nodesAlive++; }
      else this.g.connect(out);
      alive++; if (this.music) musicAlive++; voices.add(this);
    }
    _add(n) { this.nodes.push(n); nodesAlive++; return n; }
    osc(type, f, t0, dest) { const o = this._add(ctx.createOscillator()); o.type = type; o.frequency.setValueAtTime(Math.max(0.01, f), t0 || 0); this.srcs.push(o); if (dest) o.connect(dest); return o; }
    noise(dest) { const s = this._add(ctx.createBufferSource()); s.buffer = noiseBuf; s.loop = true; s.loopStart = Math.random() * 1.5; s.playbackRate.value = 1; this.srcs.push(s); if (dest) s.connect(dest); return s; }
    // gain: dest pominięty → do wyjścia głosu; dest === null → bez połączenia (modulator LFO / węzeł pośredni)
    gain(v, dest) { const g = this._add(ctx.createGain()); g.gain.value = v == null ? 1 : v; if (dest !== null) g.connect(dest || this.g); return g; }
    mod(v) { return this.gain(v, null); }
    filter(type, f, q, dest) { const b = this._add(ctx.createBiquadFilter()); b.type = type; b.frequency.value = f; b.Q.value = q == null ? 1 : q; b.connect(dest || this.g); return b; }
    start(t0) { for (const s of this.srcs) { try { s.start(t0 || 0); } catch (e) { /* już wystartowany */ } } return this; }
    // zakończenie o czasie t1 — węzły znikają, gdy pierwsze źródło zgłosi 'ended'
    end(t1) {
      if (this.ending) return; this.ending = true;
      for (const s of this.srcs) { try { s.stop(t1 + 0.02); } catch (e) { /* ok */ } }
      if (this.srcs.length) this.srcs[0].onended = () => this.kill(); else this.kill();
      // zabezpieczenie: w kontekście offline / przy uśpieniu 'ended' może nie nadejść
      if (!(typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext)) this.timer = setTimeout(() => this.kill(), Math.max(50, (t1 - ctx.currentTime) * 1000 + 400));
    }
    fadeOut(tau) { const t = ctx.currentTime; this.g.gain.cancelScheduledValues(t); this.g.gain.setTargetAtTime(0, t, tau || 0.15); this.end(t + (tau || 0.15) * 5); }
    kill() {
      if (this.dead) return; this.dead = true;
      if (this.timer) clearTimeout(this.timer);
      for (const n of this.nodes) { try { n.disconnect(); } catch (e) { /* ok */ } }
      try { this.g.disconnect(); } catch (e) { /* ok */ }
      if (this.p) { try { this.p.disconnect(); } catch (e) { /* ok */ } }
      nodesAlive -= this.nodes.length + 1 + (this.p ? 1 : 0);
      alive--; if (this.music) musicAlive--; voices.delete(this);
    }
  }
  // obwiednia ADSR-podobna: attack a, decay do sus, release r od tRel
  function env(param, t0, peak, a, d, sus, tRel, r) {
    param.cancelScheduledValues(t0);
    param.setValueAtTime(0.0001, t0);
    param.linearRampToValueAtTime(peak, t0 + a);
    if (d > 0) param.exponentialRampToValueAtTime(Math.max(0.0001, sus == null ? peak : sus * peak), t0 + a + d);
    if (tRel != null) { param.setValueAtTime(Math.max(0.0001, sus == null ? peak : sus * peak), tRel); param.exponentialRampToValueAtTime(0.0001, tRel + r); }
  }
  function newVoice(channel, pan, limitOk) {
    if (!ctx || !S.on) return null;
    const isMusic = channel === 'music';
    if (isMusic ? musicAlive >= MAX_MUSIC_VOICES : alive - musicAlive >= MAX_VOICES + (limitOk ? 4 : 0)) return null;
    return new Voice(ch[channel].gain, pan, isMusic);
  }

  // ---------- przestrzeń: kafel → głośność i panorama względem ekranu ----------
  function spatial(x, y) {
    const c = G.cam, s = G.iso.tileToScreen(x, y);
    const hw = Math.max(1, c.vw / 2), hh = Math.max(1, c.vh / 2);
    const dx = (s.x - hw) / hw, dy = (s.y - hh) / hh;
    const d = Math.hypot(dx, dy * 1.15);
    let g = d <= 1 ? 1 - 0.4 * d * d : 0.6 * Math.max(0, 1 - (d - 1) / 1.1);
    g *= 0.55 + 0.45 * clamp(c.zoom, 0, 1);  // oddalona kamera → wszystko dalej
    return { g, pan: clamp(dx, -1, 1) * 0.75 };
  }

  // =====================================================================
  //  SILNIKI I NARZĘDZIA (głosy trwałe per pojazd, aktualizowane co 100 ms)
  // =====================================================================
  const vehVoices = new Map(); // klucz pojazdu → { v: Voice, eng, tools, last: {x,y,t}, seen, quiet, old }
  const ENGINES = {
    tractor_small: { cyl: 4, level: 0.42, lp: 520, bp: 1100, turbo: 0 },
    tractor_mid: { cyl: 4, level: 0.46, lp: 460, bp: 850, turbo: 0.01 },
    tractor_big: { cyl: 6, level: 0.52, lp: 400, bp: 650, turbo: 0.02 },
    combine: { cyl: 6, level: 0.6, lp: 380, bp: 560, turbo: 0.02 },
    forage_harvester: { cyl: 8, level: 0.6, lp: 400, bp: 600, turbo: 0.025 },
    telehandler: { cyl: 4, level: 0.4, lp: 540, bp: 950, turbo: 0.012 },
    pickup: { cyl: 4, level: 0.32, lp: 640, bp: 1400, turbo: 0 }
  };
  function makeEngine(voice, model, old) {
    const E = ENGINES[model] || ENGINES.tractor_mid, t = ctx.currentTime;
    const out = voice.gain(E.level * (old ? 1.1 : 1));
    const hp = voice.filter('highpass', 48, 0.7, out); // bez infradźwięków
    // korpus: piła (zapłony) + kwadrat na pół-rzędzie (nierówny „bum-bum”) → górnoprzepustowy ~120 Hz → dolnoprzepustowy.
    // Wysokość słychać z harmonicznych („missing fundamental”), a bas nie zalewa małych głośników telefonu.
    const lp = voice.filter('lowpass', E.lp, 1.1, hp);
    const bodyHp = voice.filter('highpass', 120, 0.6, lp);
    const body = voice.gain(0.5, bodyHp);
    const oA = voice.osc('sawtooth', 30, t, body);
    const gB = voice.gain(0.25, bodyHp); const oB = voice.osc('square', 15, t, gB);
    const gC = voice.gain(0.14, hp); const oC = voice.osc('sine', 30, t, gC); // sam bas (słuchawki)
    // wydech: szum pasmowy modulowany impulsami zapłonu (LFO kwadratowy o częstotliwości zapłonów)
    const exG = voice.gain(0.3, hp);
    const am = voice.gain(0.5, exG); am.gain.value = 0.5;
    const bp = voice.filter('bandpass', E.bp, 0.9, am);
    voice.noise(bp);
    const lfo = voice.osc('square', 30, t); const lfoG = voice.mod(0.5); lfoG.connect(am.gain); lfo.connect(lfoG);
    // klekot zaworów / stukanie starego silnika: szum wysokopasmowy w rytmie zapłonów
    const knG = voice.gain(old ? 0.4 : 0.09, hp);
    const knAm = voice.gain(0.5, knG); const knBp = voice.filter('bandpass', old ? 2300 : 3200, 6, knAm);
    voice.noise(knBp); const lfoG2 = voice.mod(0.5); lfoG2.connect(knAm.gain); lfo.connect(lfoG2);
    // chybotanie obrotów (stary: wyraźne, 3,3 Hz; nowy: ledwie)
    const wob = voice.osc('sine', old ? 3.3 : 0.6, t); const wobG = voice.mod(1); wob.connect(wobG);
    wobG.connect(oA.frequency); wobG.connect(oC.frequency); wobG.connect(lfo.frequency);
    // turbina (duże maszyny): cichy gwizd ~ 30. harmoniczna
    let turbo = null;
    if (E.turbo > 0) { const tg = voice.gain(0, hp); voice.osc('sine', 900, t, tg); turbo = { g: tg, o: voice.srcs[voice.srcs.length - 1] }; }
    const eng = {
      E, old, oA, oB, oC, lfo, lp, exG, wobG, turbo, body, rpm: 800,
      set(rpm, load, tau) {
        tau = tau || 0.3;
        const tt = ctx.currentTime, f = rpm / 60 * E.cyl / 2;
        eng.rpm = rpm;
        oA.frequency.setTargetAtTime(f, tt, tau); oB.frequency.setTargetAtTime(f / 2, tt, tau); oC.frequency.setTargetAtTime(f, tt, tau); lfo.frequency.setTargetAtTime(f, tt, tau);
        wobG.gain.setTargetAtTime(f * (old ? 0.07 : 0.012), tt, tau);
        lp.frequency.setTargetAtTime(E.lp * 0.7 + load * 600 + (rpm - 800) / 1200 * 350, tt, tau);
        exG.gain.setTargetAtTime(0.3 + 0.6 * load, tt, tau);
        body.gain.setTargetAtTime(0.45 + 0.35 * load, tt, tau);
        if (turbo) { turbo.o.frequency.setTargetAtTime(f * 30, tt, tau); turbo.g.gain.setTargetAtTime(E.turbo * (0.3 + load), tt, tau); }
      }
    };
    eng.set(800, 0, 0.01);
    return eng;
  }
  // narzędzia: ciągłe źródła z gainem „aktywności”
  function makeTool(voice, model) {
    const t = ctx.currentTime, out = voice.gain(0);
    let extra = null;
    switch (model) {
      case 'plow': { // szuranie skib: brązowy szum + grzechot
        const bp0 = voice.filter('bandpass', 380, 0.7, out); voice.noise(bp0);
        const g2 = voice.gain(0.4, out); const bp = voice.filter('bandpass', 1500, 1.5, g2); voice.noise(bp);
        break;
      }
      case 'cultivator': case 'rake': { const lp = voice.filter('lowpass', 700, 0.9, out); voice.noise(lp); const g2 = voice.gain(0.35, out); const bp = voice.filter('bandpass', 2200, 3, g2); voice.noise(bp); break; }
      case 'mower': { // wizg dysków + szum
        const g1 = voice.gain(0.35, out); const bp = voice.filter('bandpass', 1300, 4, g1); voice.osc('sawtooth', 170, t, bp);
        const g2 = voice.gain(0.5, out); const bp2 = voice.filter('bandpass', 900, 0.7, g2); voice.noise(bp2);
        break;
      }
      case 'seeder': case 'planter': { // grzechot redlic
        const am = voice.gain(0.5, out); const bp = voice.filter('bandpass', 2600, 2.5, am); voice.noise(bp);
        const l = voice.osc('square', 9, t); const lg = voice.mod(0.5); l.connect(lg); lg.connect(am.gain);
        const g2 = voice.gain(0.4, out); const lp = voice.filter('lowpass', 500, 0.8, g2); voice.noise(lp);
        break;
      }
      case 'sprayer': { const bp = voice.filter('bandpass', 4200, 0.6, out); voice.noise(bp); const g2 = voice.gain(0.3, out); const hp = voice.filter('highpass', 6000, 0.7, g2); voice.noise(hp); break; }
      case 'spreader': { // wirujące tarcze: szum z wolną modulacją
        const am = voice.gain(0.6, out); const bp = voice.filter('bandpass', 950, 1.2, am); voice.noise(bp);
        const l = voice.osc('sine', 6.5, t); const lg = voice.mod(0.35); l.connect(lg); lg.connect(am.gain);
        break;
      }
      case 'manure_spreader': { const lp = voice.filter('lowpass', 600, 0.9, out); voice.noise(lp); const am = voice.gain(0.5, out); const bp = voice.filter('bandpass', 1800, 2, am); voice.noise(bp); const l = voice.osc('square', 4, t); const lg = voice.mod(0.5); l.connect(lg); lg.connect(am.gain); break; }
      case 'tank': { const bp = voice.filter('bandpass', 700, 0.5, out); voice.noise(bp); break; }
      case 'baler': { extra = { thump: true, next: 0 }; const lp = voice.filter('lowpass', 500, 0.8, out); voice.noise(lp); break; }
      case 'header': case 'potato_harvester': case 'beet_harvester': { // młocarnia / przenośniki
        const lp = voice.filter('lowpass', 520, 0.9, out); voice.noise(lp);
        const am = voice.gain(0.5, out); const bp = voice.filter('bandpass', 1700, 2.5, am); voice.noise(bp);
        const l = voice.osc('sine', 11, t); const lg = voice.mod(0.5); l.connect(lg); lg.connect(am.gain);
        break;
      }
      default: return null; // przyczepa i inne: tylko silnik
    }
    return { out, model, extra, level: { plow: 0.5, cultivator: 0.4, rake: 0.3, mower: 0.45, seeder: 0.35, planter: 0.35, sprayer: 0.35, spreader: 0.3, manure_spreader: 0.4, tank: 0.25, baler: 0.3, header: 0.55, potato_harvester: 0.5, beet_harvester: 0.5 }[model] || 0.3 };
  }
  // przeładunek: sypiące się ziarno + ślimak
  function makeUnload(voice) {
    const t = ctx.currentTime, out = voice.gain(0);
    const bp = voice.filter('bandpass', 3000, 0.5, out); voice.noise(bp);
    const g2 = voice.gain(0.5, out); const am = voice.gain(0.5, g2); const lp = voice.filter('lowpass', 180, 1.5, am); voice.osc('sawtooth', 55, t, lp);
    const l = voice.osc('sine', 6, t); const lg = voice.mod(0.4); l.connect(lg); lg.connect(am.gain);
    return { out };
  }
  // jednorazowe uderzenie tłoka prasy przy pozycji pojazdu
  function balerThump(gain, pan) {
    const v = newVoice('machines', pan); if (!v) return;
    const t = ctx.currentTime;
    const lp = v.filter('lowpass', 160, 2); const o = v.osc('sine', 70, t, lp);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.18);
    const ng = v.gain(0.4); const bp = v.filter('bandpass', 900, 1.5, ng); v.noise(bp);
    env(v.g.gain, t, 0.9 * gain, 0.005, 0.22, 0.0001);
    v.start(t); v.end(t + 0.3);
  }
  // id maszyny napędowej pojazdu (do rozpoznania starego ciągnika)
  function powerId(v) {
    try {
      if (v.uid != null) { const m = G.S.machines.find(x => x.uid === v.uid); return m ? m.id : null; }
      if (v.jobUid != null && v.unit === 'main') {
        const j = G.S.jobs.list.find(x => x.uid === v.jobUid);
        if (j && j.contractor) return j.contractor.power || null;
        if (j && j.power != null) { const m = G.S.machines.find(x => x.uid === j.power); return m ? m.id : null; }
      }
    } catch (e) { /* ok */ }
    return null;
  }
  function vehKey(v) { return v.uid != null ? 'm' + v.uid : 'j' + v.jobUid + ':' + v.unit; }
  function driveState() {
    try { if (G.drive && typeof G.drive.active === 'function' && G.drive.active() && typeof G.drive.state === 'function') return G.drive.state() || null; } catch (e) { /* ok */ }
    return null;
  }
  function updateVehicles(dt) {
    const list = (G.jobs && G.jobs.vehicles) ? G.jobs.vehicles() : [];
    const drv = driveState();
    const now = ctx.currentTime, cand = [];
    // kandydaci: pojazdy z pracującym silnikiem na ekranie lub blisko niego
    const seenKeys = new Map();
    for (const v of list) {
      if (v.inGarage || v.broken) continue;
      const manual = !!v.manual || (drv && (drv.uid === v.uid || drv.vehicle === v.uid || drv.machine === v.uid));
      if (v.unit === 'parked' && !manual) continue;        // na postoju silnik zgaszony
      const sp = spatial(v.x, v.y);
      let key = vehKey(v);
      const n = seenKeys.get(key) || 0; seenKeys.set(key, n + 1);
      if (n) key += '#' + n; // kilka przyczep tego samego zlecenia
      cand.push({ v, key, g: sp.g, pan: sp.pan, manual });
    }
    cand.sort((a, b) => b.g - a.g);
    const keep = new Set();
    for (let i = 0; i < cand.length; i++) {
      const c = cand[i], audible = i < MAX_VEHICLES && c.g > 0.012;
      let rec = vehVoices.get(c.key);
      if (!rec) {
        if (!audible) continue;
        const vv = newVoice('machines', c.pan, true); if (!vv) continue;
        vv.g.gain.value = 0;
        const model = (c.v.parts && c.v.parts[0] && c.v.parts[0].model) || 'tractor_mid';
        const pid = powerId(c.v);
        const def = pid && G.MACHINES[pid];
        const old = pid === 'zagon_c60' || !!(def && def.year && def.year < 1995) || !!(def && def.usedOnly && model === 'tractor_small');
        rec = { v: vv, eng: makeEngine(vv, model, old), tools: [], unload: null, model, last: { x: c.v.x, y: c.v.y, t: now }, speed: 0, quietSince: 0 };
        for (let k = 1; k < (c.v.parts || []).length; k++) { const tl = makeTool(vv, c.v.parts[k].model); if (tl) rec.tools.push(tl); }
        if (model === 'combine' || model === 'forage_harvester' || model === 'potato_harvester' || model === 'beet_harvester') rec.unload = makeUnload(vv);
        vv.start(now);
        vehVoices.set(c.key, rec);
      }
      keep.add(c.key);
      // prędkość w kaflach / s czasu gry (niezależna od mnożnika prędkości)
      const mult = G.speed || 0;
      const dd = Math.hypot(c.v.x - rec.last.x, c.v.y - rec.last.y);
      const dtv = Math.max(1e-3, now - rec.last.t);
      const inst = mult > 0 ? dd / dtv / mult : 0;
      rec.speed += (Math.min(inst, 3) - rec.speed) * Math.min(1, dt * 6);
      rec.last = { x: c.v.x, y: c.v.y, t: now };
      // obroty i obciążenie
      let rpm = 850, load = 0.05;
      if (c.manual && drv) {
        const spd = Math.abs(+drv.speed || 0);
        rpm = 850 + clamp(spd / 25, 0, 1) * 1250 + (drv.lowered ? 250 : 0);
        load = clamp(spd / 30, 0, 1) * 0.6 + (drv.lowered ? 0.4 : 0);
      } else if (c.v.working) { rpm = 1850 + rec.speed * 80; load = 0.85; }
      else if (c.v.unloading) { rpm = 1500; load = 0.5; }
      else if (rec.speed > 0.03) { rpm = 1250 + clamp(rec.speed / 0.5, 0, 1) * 650; load = 0.35; }
      else if (c.v.waiting) { rpm = 820; load = 0; }
      rec.eng.set(rpm, load);
      const gVol = audible ? c.g * (c.v.waiting && !c.manual ? 0.6 : 1) : 0;
      rec.v.g.gain.setTargetAtTime(gVol, now, 0.2);
      if (rec.v.p) rec.v.p.pan.setTargetAtTime(c.pan, now, 0.2);
      // narzędzia: aktywne, gdy maszyna pracuje (lub opuszczone przy ręcznej jeździe)
      const toolOn = c.v.working || (c.manual && drv && drv.lowered);
      for (const tl of rec.tools) {
        tl.out.gain.setTargetAtTime(toolOn ? tl.level : 0, now, 0.25);
        if (tl.extra && tl.extra.thump && toolOn && audible) { // prasa: rytmiczne uderzenia tłoka
          if (now >= tl.extra.next) { balerThump(c.g * 0.8, c.pan); tl.extra.next = now + rnd(0.62, 0.72); }
        }
      }
      if (rec.unload) rec.unload.out.gain.setTargetAtTime(c.v.unloading ? 0.6 : 0, now, 0.3);
      if (!audible) { if (!rec.quietSince) rec.quietSince = now; } else rec.quietSince = 0;
    }
    // usuwanie głosów: pojazd zniknął albo długo niesłyszalny
    for (const [key, rec] of vehVoices) {
      if (!keep.has(key) || (rec.quietSince && now - rec.quietSince > 2.5)) { rec.v.fadeOut(0.2); vehVoices.delete(key); }
    }
  }

  // =====================================================================
  //  ZWIERZĘTA
  // =====================================================================
  const beeVoices = new Map();
  const CALL_RATE = { krowa: 0.012, opas: 0.01, kura: 0.045, brojler: 0.03, tucznik: 0.022, locha: 0.02, owca: 0.02, koza: 0.02, kon: 0.006 };
  let lastAnimalCall = 0, roosterNext = 0, roosterDay = -1;

  function cowMoo(ch_, gain, pan, opts) {
    const v = newVoice(ch_, pan); if (!v) return;
    const t = ctx.currentTime, dur = rnd(1.2, 1.9), f0 = rnd(85, 115), young = opts && opts.young;
    const base = young ? f0 * 1.9 : f0;
    const pre = v.gain(1); const f1 = v.filter('bandpass', young ? 700 : 450, 3, pre); const f2 = v.filter('bandpass', young ? 1500 : 1000, 4, pre);
    const mix = v.mod(1); mix.connect(f1); mix.connect(f2);
    const lp = v.filter('lowpass', 1800, 0.7, pre); const lpg = v.gain(0.4, lp); mix.connect(lpg);
    const o = v.osc('sawtooth', base, t, mix);
    o.frequency.linearRampToValueAtTime(base * 1.45, t + dur * 0.35);
    o.frequency.linearRampToValueAtTime(base * 1.15, t + dur * 0.8);
    o.frequency.linearRampToValueAtTime(base * 0.95, t + dur);
    const vib = v.osc('sine', 5.5, t); const vg = v.mod(base * 0.03); vib.connect(vg); vg.connect(o.frequency);
    f1.frequency.setValueAtTime(young ? 600 : 380, t); f1.frequency.linearRampToValueAtTime(young ? 900 : 750, t + dur * 0.4); f1.frequency.linearRampToValueAtTime(young ? 650 : 480, t + dur);
    f2.frequency.setValueAtTime(young ? 1300 : 900, t); f2.frequency.linearRampToValueAtTime(young ? 1900 : 1300, t + dur * 0.45);
    const ng = v.gain(0.08, mix); const nb = v.filter('bandpass', 1200, 1, ng); v.noise(nb);
    env(v.g.gain, t, gain * (young ? 0.5 : 0.75), 0.18, dur * 0.5, 0.75, t + dur * 0.8, dur * 0.25);
    v.start(t); v.end(t + dur + 0.1);
  }
  function henCluck(ch_, gain, pan) {
    const v = newVoice(ch_, pan); if (!v) return;
    const t = ctx.currentTime, n = 3 + Math.floor(Math.random() * 4);
    const f = v.filter('bandpass', 1500, 2.5); const o = v.osc('sawtooth', 500, t, f);
    const g = v.g.gain; g.setValueAtTime(0.0001, t);
    let tt = t;
    for (let i = 0; i < n; i++) {
      const last = i === n - 1 && Math.random() < 0.5, d = last ? 0.32 : rnd(0.07, 0.1);
      const fr = last ? 650 : rnd(420, 560);
      o.frequency.setValueAtTime(fr, tt); o.frequency.exponentialRampToValueAtTime(last ? 950 : fr * 0.8, tt + d * (last ? 0.4 : 1));
      if (last) o.frequency.exponentialRampToValueAtTime(520, tt + d);
      g.setValueAtTime(0.0001, tt); g.linearRampToValueAtTime(gain * (last ? 0.55 : 0.4), tt + 0.012); g.exponentialRampToValueAtTime(0.0001, tt + d);
      tt += d + rnd(0.05, 0.12);
    }
    v.start(t); v.end(tt + 0.05);
  }
  function rooster(ch_, gain, pan) {
    const v = newVoice(ch_, pan, true); if (!v) return;
    const t = ctx.currentTime;
    const f1 = v.filter('bandpass', 1600, 2); const f2 = v.filter('bandpass', 2800, 3); const mix = v.mod(1); mix.connect(f1); mix.connect(f2);
    const o = v.osc('sawtooth', 700, t, mix);
    const vib = v.osc('sine', 9, t); const vg = v.mod(18); vib.connect(vg); vg.connect(o.frequency);
    const g = v.g.gain;
    // ku - ku - ry - kuuu
    const seg = [[0, 0.16, 680, 740], [0.2, 0.16, 760, 820], [0.4, 0.28, 880, 1150], [0.72, 0.85, 1050, 720]];
    g.setValueAtTime(0.0001, t);
    for (const [st, d, fa, fb] of seg) {
      const ts = t + st;
      o.frequency.setValueAtTime(fa, ts); o.frequency.linearRampToValueAtTime(fb, ts + d);
      g.setValueAtTime(0.0001, ts); g.linearRampToValueAtTime(gain * 0.7, ts + 0.03); g.setValueAtTime(gain * 0.7, ts + d * 0.6); g.exponentialRampToValueAtTime(0.0001, ts + d);
    }
    v.start(t); v.end(t + 1.65);
  }
  function pigGrunt(ch_, gain, pan) {
    const v = newVoice(ch_, pan); if (!v) return;
    const t = ctx.currentTime;
    if (Math.random() < 0.18) { // kwik
      const f = v.filter('bandpass', 2200, 2); const o = v.osc('sawtooth', 900, t, f);
      o.frequency.linearRampToValueAtTime(1500, t + 0.25); o.frequency.linearRampToValueAtTime(1100, t + 0.5);
      const vib = v.osc('sine', 14, t); const vg = v.mod(60); vib.connect(vg); vg.connect(o.frequency);
      env(v.g.gain, t, gain * 0.35, 0.03, 0.4, 0.2);
      v.start(t); v.end(t + 0.55); return;
    }
    const n = 1 + Math.floor(Math.random() * 3), lp = v.filter('lowpass', 900, 1.2); const o = v.osc('sawtooth', 110, t, lp);
    const wob = v.osc('sawtooth', 27, t); const wg = v.mod(25); wob.connect(wg); wg.connect(o.frequency);
    const ng = v.gain(0.3, lp); const nb = v.filter('bandpass', 600, 1, ng); v.noise(nb);
    const g = v.g.gain; g.setValueAtTime(0.0001, t); let tt = t;
    for (let i = 0; i < n; i++) {
      const d = rnd(0.18, 0.3); o.frequency.setValueAtTime(rnd(95, 130), tt); o.frequency.linearRampToValueAtTime(80, tt + d);
      g.setValueAtTime(0.0001, tt); g.linearRampToValueAtTime(gain * 0.7, tt + 0.04); g.exponentialRampToValueAtTime(0.0001, tt + d);
      tt += d + rnd(0.1, 0.25);
    }
    v.start(t); v.end(tt + 0.05);
  }
  function sheepBleat(ch_, gain, pan, goat, young) {
    const v = newVoice(ch_, pan); if (!v) return;
    const t = ctx.currentTime, dur = goat ? rnd(0.5, 0.75) : rnd(0.7, 1.1);
    let base = goat ? rnd(280, 340) : rnd(190, 240); if (young) base *= 1.6;
    const f1 = v.filter('bandpass', goat ? 1000 : 800, 3); const f2 = v.filter('bandpass', goat ? 2300 : 1800, 4); const mix = v.mod(1); mix.connect(f1); mix.connect(f2);
    const lp = v.filter('lowpass', 2500, 0.7); const lpg = v.gain(0.35, lp); mix.connect(lpg);
    const o = v.osc('sawtooth', base, t, mix);
    o.frequency.linearRampToValueAtTime(base * 1.08, t + dur * 0.3); o.frequency.linearRampToValueAtTime(base * 0.92, t + dur);
    const vib = v.osc('sine', goat ? 11 : 8, t); const vg = v.mod(base * 0.06); vib.connect(vg); vg.connect(o.frequency);
    const trem = v.osc('sine', goat ? 11 : 8, t); const tg = v.mod(0.35); trem.connect(tg); tg.connect(mix.gain); mix.gain.value = 0.65;
    env(v.g.gain, t, gain * (young ? 0.4 : 0.6), 0.06, dur * 0.6, 0.7, t + dur * 0.75, dur * 0.25);
    v.start(t); v.end(t + dur + 0.05);
  }
  function horseCall(ch_, gain, pan) {
    const v = newVoice(ch_, pan); if (!v) return;
    const t = ctx.currentTime;
    if (Math.random() < 0.45) { // parsknięcie
      const lp = v.filter('lowpass', 700, 1); const am = v.gain(0.5, lp); v.noise(am);
      const l = v.osc('sine', 26, t); const lg = v.mod(0.5); l.connect(lg); lg.connect(am.gain);
      env(v.g.gain, t, gain * 0.55, 0.02, 0.4, 0.3, t + 0.35, 0.15);
      v.start(t); v.end(t + 0.55); return;
    }
    const dur = rnd(1.0, 1.4);
    const f1 = v.filter('bandpass', 1200, 2.5); const f2 = v.filter('bandpass', 2600, 3); const mix = v.mod(1); mix.connect(f1); mix.connect(f2);
    const o = v.osc('sawtooth', 500, t, mix);
    o.frequency.linearRampToValueAtTime(950, t + dur * 0.3); o.frequency.linearRampToValueAtTime(420, t + dur);
    const vib = v.osc('sine', 13, t); const vg = v.mod(70); vib.connect(vg); vg.connect(o.frequency);
    const trem = v.osc('sine', 13, t); const tg = v.mod(0.3); trem.connect(tg); tg.connect(mix.gain); mix.gain.value = 0.7;
    env(v.g.gain, t, gain * 0.55, 0.05, dur * 0.6, 0.6, t + dur * 0.7, dur * 0.3);
    v.start(t); v.end(t + dur + 0.05);
  }
  const ANIMAL_FN = {
    krowa: (c, g, p, o) => cowMoo(c, g, p, o), opas: (c, g, p) => cowMoo(c, g, p), kura: henCluck, brojler: henCluck,
    tucznik: pigGrunt, locha: pigGrunt, owca: (c, g, p, o) => sheepBleat(c, g, p, false, o && o.young), koza: (c, g, p, o) => sheepBleat(c, g, p, true, o && o.young), kon: horseCall
  };
  function buildingPos(uid) {
    const b = (G.S.buildings || []).find(x => x.uid === uid);
    if (!b) return null;
    const def = G.BUILDINGS && G.BUILDINGS[b.type], sz = def && def.size ? def.size : [1, 1];
    return { x: b.x + (b.rot ? sz[1] : sz[0]) / 2, y: b.y + (b.rot ? sz[0] : sz[1]) / 2 };
  }
  function updateAnimals(dt) {
    if (!G.animals || !G.S.animals) return;
    const now = ctx.currentTime, d = G.date(), hour = d.hour + (G.hourFrac || 0);
    const sprites = G.animals.sprites ? G.animals.sprites() : [];
    const byHerd = new Map();
    for (const s of sprites) { let a = byHerd.get(s.herd); if (!a) byHerd.set(s.herd, a = []); a.push(s); }
    const nightF = hour < 5 || hour >= 21 ? 0.12 : hour < 7 || hour >= 19 ? 0.5 : 1;
    const keepBees = new Set();
    for (const h of (G.S.animals.herds || [])) {
      if (!(h.count > 0)) continue;
      const sp = byHerd.get(h.uid) || [];
      if (h.species === 'pszczoly') { // brzęczenie pasieki — głos ciągły, gdy pszczoły latają
        if (!sp.length) continue;
        let cx = 0, cy = 0; for (const s of sp) { cx += s.x; cy += s.y; } cx /= sp.length; cy /= sp.length;
        const s = spatial(cx, cy);
        if (s.g < 0.02 && !beeVoices.has(h.uid)) continue;
        let rec = beeVoices.get(h.uid);
        if (!rec) {
          const v = newVoice('animals', s.pan, true); if (!v) continue;
          v.g.gain.value = 0;
          const bp = v.filter('bandpass', 420, 1.2); const mix = v.gain(0.35, bp);
          for (const f of [186, 192, 199]) v.osc('sawtooth', f, now, mix);
          const l1 = v.osc('sine', 0.7, now); const lg1 = v.mod(0.12); l1.connect(lg1); lg1.connect(mix.gain);
          const l2 = v.osc('sine', 2.3, now); const lg2 = v.mod(0.08); l2.connect(lg2); lg2.connect(mix.gain);
          v.start(now); rec = { v, quiet: 0 }; beeVoices.set(h.uid, rec);
        }
        rec.v.g.gain.setTargetAtTime(s.g * 0.5 * Math.min(1, sp.length / 3), now, 0.5);
        if (rec.v.p) rec.v.p.pan.setTargetAtTime(s.pan, now, 0.3);
        if (s.g < 0.02) { if (!rec.quiet) rec.quiet = now; } else rec.quiet = 0;
        if (!rec.quiet || now - rec.quiet < 2) keepBees.add(h.uid);
        continue;
      }
      const fn = ANIMAL_FN[h.species]; if (!fn) continue;
      // kogut: świt (ok. 5–7), kilka pian w rzeczywistych odstępach
      if (h.species === 'kura' && hour >= 4.8 && hour < 7.2) {
        if (roosterDay !== d.dayIndex) { roosterDay = d.dayIndex; roosterNext = now + rnd(0.5, 3); }
        if (now >= roosterNext) {
          const pos = buildingPos(h.buildingUid); const s = pos ? spatial(pos.x, pos.y) : { g: 0.4, pan: 0 };
          rooster('animals', Math.max(0.3, s.g) * 0.8, s.pan); roosterNext = now + rnd(18, 45);
        }
      }
      // losowe odezwanie: prawdopodobieństwo wg liczby sztuk, pory i widoczności
      if (now - lastAnimalCall < 0.35) continue;
      const rate = (CALL_RATE[h.species] || 0.01) * Math.min(h.count, 20) * nightF * dt;
      if (Math.random() >= rate) continue;
      let x, y, indoor = false;
      if (sp.length) { const s = pick(sp); x = s.x; y = s.y; } else { const pos = buildingPos(h.buildingUid); if (!pos) continue; x = pos.x; y = pos.y; indoor = true; }
      const s = spatial(x, y);
      let g = Math.max(s.g, 0.08) * (indoor ? 0.4 : 1); // daleko/wewnątrz: ledwie słychać, ale farma żyje
      if (g < 0.03) continue;
      lastAnimalCall = now;
      const young = (h.young || []).length > 0 && Math.random() < 0.3;
      fn('animals', g, s.pan, { young, indoor });
    }
    for (const [uid, rec] of beeVoices) if (!keepBees.has(uid)) { rec.v.fadeOut(0.5); beeVoices.delete(uid); }
  }

  // =====================================================================
  //  OTOCZENIE: wiatr, deszcz, grzmoty, ptaki, świerszcze, dzwony, psy
  // =====================================================================
  let amb = null; // { wind, rain, cricket }
  const birdNext = { sparrow: 0, lark: 0, owl: 0, crow: 0, cuckoo: 0, dog: 0, thunder: 0 };
  let bells = { day: -1, left: 0, next: 0 }, lastStorm = false, stormWarnDay = -1;

  function initAmbient() {
    const t = ctx.currentTime, out = ch.ambient.gain;
    // wiatr: szum → dolnoprzepustowy (porywy = LFO na częstotliwości) + mroźny gwizd zimą (rezonans)
    const wind = new Voice(out, null); wind.g.gain.value = 0;
    const wIn = wind.gain(1); const wlp = wind.filter('lowpass', 400, 0.9, wIn); wind.noise(wlp);
    const gust = wind.osc('sine', 0.11, t); const gg = wind.mod(150); gust.connect(gg); gg.connect(wlp.frequency);
    const gust2 = wind.osc('sine', 0.037, t); const gg2 = wind.mod(0.25); gust2.connect(gg2); gg2.connect(wIn.gain);
    const whistleG = wind.gain(0); const wb = wind.filter('bandpass', 1150, 14, whistleG); wind.noise(wb);
    const wv = wind.osc('sine', 0.23, t); const wvg = wind.mod(120); wv.connect(wvg); wvg.connect(wb.frequency);
    wind.start(t);
    // deszcz: szum pasmowy + drobne krople (wyższy szum, rzadsza modulacja)
    const rain = new Voice(out, null); rain.g.gain.value = 0;
    const rhp = rain.filter('highpass', 900, 0.7); const rlp = rain.filter('lowpass', 5500, 0.6, rhp); rain.noise(rlp);
    const dropsG = rain.gain(0.5); const dbp = rain.filter('bandpass', 7000, 1.5, dropsG); rain.noise(dbp);
    rain.start(t);
    // świerszcze: wysoki ton z szybkim cykaniem (AM 28 Hz) i wolniejszym rytmem (3 Hz)
    const cricket = new Voice(out, 0.3); cricket.g.gain.value = 0;
    const cm = cricket.gain(0.5); const cbp = cricket.filter('bandpass', 4300, 6, cm);
    cricket.osc('sine', 4300, t, cbp); cricket.osc('sine', 4290, t, cbp);
    const am1 = cricket.osc('square', 28, t); const ag1 = cricket.mod(0.5); am1.connect(ag1); ag1.connect(cm.gain);
    const cm2 = cricket.gain(0.5); cm.disconnect(); cm.connect(cm2); // drugi stopień AM: rytm 3 Hz
    const am2 = cricket.osc('sine', 3.1, t); const ag2 = cricket.mod(0.5); am2.connect(ag2); ag2.connect(cm2.gain);
    const cricket2 = new Voice(out, -0.5); cricket2.g.gain.value = 0;
    const c2m = cricket2.gain(0.5); const c2bp = cricket2.filter('bandpass', 3900, 6, c2m); cricket2.osc('sine', 3900, t, c2bp);
    const am3 = cricket2.osc('square', 22, t); const ag3 = cricket2.mod(0.5); am3.connect(ag3); ag3.connect(c2m.gain);
    cricket.start(t); cricket2.start(t);
    amb = { wind, wlp, whistleG, rain, rlp, dropsG, cricket, cricket2 };
  }
  function thunder(gain, far) {
    const v = newVoice('ambient', rnd(-0.6, 0.6)); if (!v) return;
    const t = ctx.currentTime, dur = rnd(2.5, 5.5);
    const inner = v.gain(1); const lp = v.filter('lowpass', far ? 70 : 110, 1.2, inner); v.noise(lp);
    lp.frequency.setValueAtTime(far ? 80 : 160, t); lp.frequency.exponentialRampToValueAtTime(45, t + dur);
    const rumble = v.osc('sine', 0.9, t); const rg = v.mod(0.4); rumble.connect(rg); rg.connect(inner.gain);
    if (!far && Math.random() < 0.7) { const cg = v.gain(0.35); const hp = v.filter('highpass', 1800, 0.7, cg); const nn = v.noise(hp); cg.gain.setValueAtTime(0.5, t); cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.12); nn.playbackRate.value = 1; }
    env(v.g.gain, t, gain * (far ? 0.5 : 1.3), far ? rnd(0.3, 0.8) : 0.03, dur * 0.7, 0.3, t + dur * 0.75, dur * 0.25);
    v.start(t); v.end(t + dur + 0.1);
  }
  // ptaki
  function sparrow(gain, pan) {
    const v = newVoice('ambient', pan); if (!v) return;
    const t = ctx.currentTime, n = 2 + Math.floor(Math.random() * 4);
    const o = v.osc('sine', 3500, t, v.g); const g = v.g.gain; g.setValueAtTime(0.0001, t); let tt = t;
    for (let i = 0; i < n; i++) {
      const f = rnd(3000, 4200), d = rnd(0.05, 0.09);
      o.frequency.setValueAtTime(f, tt); o.frequency.exponentialRampToValueAtTime(f * rnd(0.75, 1.3), tt + d);
      g.setValueAtTime(0.0001, tt); g.linearRampToValueAtTime(gain, tt + 0.01); g.exponentialRampToValueAtTime(0.0001, tt + d);
      tt += d + rnd(0.04, 0.12);
    }
    v.start(t); v.end(tt + 0.05);
  }
  function lark(gain, pan) { // skowronek: długi szczebiot wysoko
    const v = newVoice('ambient', pan); if (!v) return;
    const t = ctx.currentTime, n = 8 + Math.floor(Math.random() * 10);
    const o = v.osc('sine', 4000, t, v.g); const g = v.g.gain; g.setValueAtTime(0.0001, t); let tt = t;
    for (let i = 0; i < n; i++) {
      const f = rnd(3200, 5200), d = rnd(0.04, 0.08), up = Math.random() < 0.5;
      o.frequency.setValueAtTime(f, tt); o.frequency.exponentialRampToValueAtTime(f * (up ? 1.35 : 0.72), tt + d);
      g.setValueAtTime(0.0001, tt); g.linearRampToValueAtTime(gain * rnd(0.6, 1), tt + 0.008); g.exponentialRampToValueAtTime(0.0001, tt + d);
      tt += d + rnd(0.02, 0.06);
    }
    v.start(t); v.end(tt + 0.05);
  }
  function owl(gain, pan) {
    const v = newVoice('ambient', pan); if (!v) return;
    const t = ctx.currentTime, lp = v.filter('lowpass', 900, 0.8); const o = v.osc('sine', 390, t, lp);
    const g = v.g.gain; g.setValueAtTime(0.0001, t);
    const seg = [[0, 0.22], [0.42, 0.55]];
    for (const [st, d] of seg) { const ts = t + st; o.frequency.setValueAtTime(400, ts); o.frequency.linearRampToValueAtTime(360, ts + d); g.setValueAtTime(0.0001, ts); g.linearRampToValueAtTime(gain, ts + 0.06); g.setValueAtTime(gain, ts + d * 0.6); g.exponentialRampToValueAtTime(0.0001, ts + d); }
    v.start(t); v.end(t + 1.1);
  }
  function crow(gain, pan) { // gawron/wrona: chrapliwe „kra”
    const v = newVoice('ambient', pan); if (!v) return;
    const t = ctx.currentTime, n = 1 + Math.floor(Math.random() * 3);
    const f1 = v.filter('bandpass', 1100, 2); const lp = v.filter('lowpass', 1600, 0.8); const mix = v.mod(1); mix.connect(f1); mix.connect(lp);
    const o = v.osc('sawtooth', 420, t, mix); const ng = v.gain(0.5, mix); const nb = v.filter('bandpass', 1300, 1, ng); v.noise(nb);
    const g = v.g.gain; g.setValueAtTime(0.0001, t); let tt = t;
    for (let i = 0; i < n; i++) { const d = rnd(0.22, 0.3); o.frequency.setValueAtTime(460, tt); o.frequency.linearRampToValueAtTime(340, tt + d); g.setValueAtTime(0.0001, tt); g.linearRampToValueAtTime(gain, tt + 0.03); g.exponentialRampToValueAtTime(0.0001, tt + d); tt += d + rnd(0.2, 0.35); }
    v.start(t); v.end(tt + 0.05);
  }
  function cuckoo(gain, pan) {
    const v = newVoice('ambient', pan); if (!v) return;
    const t = ctx.currentTime, lp = v.filter('lowpass', 1400, 0.8); const o = v.osc('sine', 740, t, lp); const g = v.g.gain; g.setValueAtTime(0.0001, t);
    for (const [st, f] of [[0, 740], [0.3, 590]]) { const ts = t + st; o.frequency.setValueAtTime(f, ts); g.setValueAtTime(0.0001, ts); g.linearRampToValueAtTime(gain, ts + 0.03); g.setValueAtTime(gain, ts + 0.15); g.exponentialRampToValueAtTime(0.0001, ts + 0.26); }
    v.start(t); v.end(t + 0.65);
  }
  function dogBark(gain, pan) { // pies z daleka: stłumiony dolnoprzepustowym
    const v = newVoice('ambient', pan); if (!v) return;
    const t = ctx.currentTime, n = 2 + Math.floor(Math.random() * 3);
    const lp = v.filter('lowpass', 1100, 0.9); const f1 = v.filter('bandpass', 800, 2, lp); const o = v.osc('sawtooth', 340, t, f1); const ng = v.gain(0.3, f1); const nb = v.filter('bandpass', 900, 1, ng); v.noise(nb);
    const g = v.g.gain; g.setValueAtTime(0.0001, t); let tt = t;
    for (let i = 0; i < n; i++) { const d = rnd(0.1, 0.14); o.frequency.setValueAtTime(rnd(320, 380), tt); o.frequency.exponentialRampToValueAtTime(230, tt + d); g.setValueAtTime(0.0001, tt); g.linearRampToValueAtTime(gain, tt + 0.015); g.exponentialRampToValueAtTime(0.0001, tt + d); tt += d + rnd(0.12, 0.28); }
    v.start(t); v.end(tt + 0.05);
  }
  function bell(gain, f, pan) { // dzwon kościelny: częściowe nieharmoniczne (hum, prime, tierce, quint, nominal)
    const v = newVoice('ambient', pan); if (!v) return;
    const t = ctx.currentTime, dur = 4.5;
    for (const [r, a, dec] of [[0.5, 0.5, 4.5], [1, 0.6, 3.5], [1.2, 0.35, 2.8], [1.5, 0.2, 2.2], [2.0, 0.3, 1.6], [2.74, 0.12, 0.9]]) {
      const g = v.gain(0.0001); v.osc('sine', f * r, t, g);
      g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(a, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, t + dec);
    }
    const ng = v.gain(0.0001); const nb = v.filter('bandpass', f * 3, 2, ng); v.noise(nb); ng.gain.setValueAtTime(0.25, t); ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    v.g.gain.value = gain;
    v.start(t); v.end(t + dur);
  }
  function updateAmbient(dt) {
    if (!amb) return;
    const now = ctx.currentTime, W = G.weather || {}, d = G.date(), hour = d.hour + (G.hourFrac || 0), m = d.month;
    const wind = +W.wind || 2, type = W.type || 'clear', inten = +W.intensity || 0, temp = W.temp == null ? 10 : +W.temp;
    const winter = m === 11 || m <= 1, summer = m >= 5 && m <= 7;
    // wiatr
    const wg = clamp((wind - 1) / 11, 0, 1);
    amb.wind.g.gain.setTargetAtTime(0.05 + wg * 0.45 + (type === 'storm' ? 0.2 : 0), now, 1.5);
    amb.wlp.frequency.setTargetAtTime(220 + wg * 700, now, 1.5);
    amb.whistleG.gain.setTargetAtTime(temp < 1 && wind > 3.5 ? 0.08 + wg * 0.12 : 0, now, 2);
    // deszcz (śnieg pada bezgłośnie, tylko tłumi)
    const rainOn = (type === 'rain' || type === 'storm') ? inten : 0;
    amb.rain.g.gain.setTargetAtTime(rainOn * 0.55, now, 2);
    amb.rlp.frequency.setTargetAtTime(2500 + rainOn * 4000, now, 2);
    amb.dropsG.gain.setTargetAtTime(0.2 + rainOn * 0.5, now, 2);
    // świerszcze: ciepłe noce późnej wiosny i lata
    const night = hour >= 20.5 || hour < 4.5, dusk = (hour >= 19.5 && hour < 20.5) || (hour >= 4.5 && hour < 5.5);
    const cr = (m >= 4 && m <= 8 && temp > 11 && rainOn < 0.2) ? (night ? 1 : dusk ? 0.5 : 0) : 0;
    amb.cricket.g.gain.setTargetAtTime(cr * 0.11, now, 3);
    amb.cricket2.g.gain.setTargetAtTime(cr * 0.07, now, 3);
    // grzmoty
    if (type === 'storm') {
      if (!lastStorm) { birdNext.thunder = now + rnd(1, 4); if (stormWarnDay !== d.dayIndex) { stormWarnDay = d.dayIndex; S.play('weather_warn'); } }
      if (now >= birdNext.thunder) { thunder(0.8, Math.random() < 0.45); birdNext.thunder = now + rnd(7, 22); }
    }
    lastStorm = type === 'storm';
    // ptaki: w dzień, bez burzy i ulewy
    const calm = type !== 'storm' && rainOn < 0.35 && !hidden;
    const dayLen = winter ? [7, 16.5] : summer ? [4.5, 21] : [5.5, 19];
    const day = hour >= dayLen[0] && hour < dayLen[1];
    if (calm && day) {
      if (now >= birdNext.sparrow) { sparrow(winter ? 0.08 : 0.13, rnd(-0.8, 0.8)); birdNext.sparrow = now + (winter ? rnd(8, 20) : rnd(3.5, 11)); }
      if (m >= 3 && m <= 7 && hour >= 6 && hour < 18 && type !== 'rain' && now >= birdNext.lark) { lark(0.07, rnd(-0.9, 0.9)); birdNext.lark = now + rnd(6, 16); }
      if ((m >= 8 || m <= 1) && now >= birdNext.crow) { crow(0.12, rnd(-0.9, 0.9)); birdNext.crow = now + rnd(14, 40); }
      if ((m === 4 || m === 5) && now >= birdNext.cuckoo) { cuckoo(0.09, rnd(-0.9, 0.9)); birdNext.cuckoo = now + rnd(18, 50); }
    }
    if (calm && (hour >= 21 || hour < 4) && now >= birdNext.owl) { owl(0.14, rnd(-0.8, 0.8)); birdNext.owl = now + rnd(18, 55); }
    // psy wieczorem z daleka
    if (hour >= 18.5 && hour < 23.5 && type !== 'storm' && now >= birdNext.dog) { dogBark(0.07, rnd(-0.9, 0.9)); birdNext.dog = now + rnd(18, 60); }
    // dzwony z wioski: niedziela w południe
    if (d.dayIndex % 7 === 6 && hour >= 12 && hour < 13.5 && bells.day !== d.dayIndex) { bells.day = d.dayIndex; bells.left = 10; bells.next = now + 0.5; }
    if (bells.left > 0 && now >= bells.next) {
      bell(0.11, bells.left % 2 ? 392 : 329.6, 0.55); bells.left--; bells.next = now + rnd(1.3, 1.7);
    }
  }

  // =====================================================================
  //  MUZYKA — proceduralna, folkowo-pastoralna (3/4, kwinty, akordeonowy pad, dzwonki, drewienka)
  // =====================================================================
  const SCALES = { lydian: [0, 2, 4, 6, 7, 9, 11], major: [0, 2, 4, 5, 7, 9, 11], mixo: [0, 2, 4, 5, 7, 9, 10], dorian: [0, 2, 3, 5, 7, 9, 10], aeolian: [0, 2, 3, 5, 7, 8, 10] };
  const PROG = { 0: [0, 0, 3, 5, 4], 3: [0, 4, 0], 4: [0, 5, 0], 5: [3, 4, 3], 1: [4, 0] };
  const RHYTHMS = [[1, 1, 1], [1.5, 0.5, 1], [2, 1], [1, 2], [0.5, 0.5, 1, 1], [1, 0.5, 0.5, 1], [3]];
  let mus = null;
  function initMusic() {
    const out = ch.music.gain;
    // „przestrzeń”: krótkie echo ze sprzężeniem i tłumieniem — melodia i dzwonki wysyłają tam część sygnału
    const send = ctx.createGain(); send.gain.value = 1;
    const dl = ctx.createDelay(1.0); dl.delayTime.value = 0.31;
    const fb = ctx.createGain(); fb.gain.value = 0.32;
    const dlp = ctx.createBiquadFilter(); dlp.type = 'lowpass'; dlp.frequency.value = 1800;
    const wet = ctx.createGain(); wet.gain.value = 0.28;
    send.connect(dl); dl.connect(dlp); dlp.connect(fb); fb.connect(dl); dlp.connect(wet); wet.connect(out);
    nodesAlive += 5;
    mus = { send, root: 62, scale: 'major', chord: 0, bpm: 96, next: 0, beat: 0, bar: 0, phrase: 0, plan: null, pad: null, lastDeg: 7, restUntil: 0, silenceUntil: 0, startedAt: 0, timbre: 'flute' };
  }
  function degToMidi(deg) { const sc = SCALES[mus.scale]; const o = Math.floor(deg / 7), i = ((deg % 7) + 7) % 7; return mus.root + o * 12 + sc[i]; }
  function chordTones(chord) { return [chord, chord + 2, chord + 4].map(x => ((x % 7) + 7) % 7); }
  function mood() {
    const d = G.date(), hour = d.hour + (G.hourFrac || 0), season = d.season;
    const night = hour < 5 || hour >= 21, evening = hour >= 18.5 || hour < 7;
    const scale = season === 'wiosna' ? (night ? 'major' : 'lydian') : season === 'lato' ? (night ? 'mixo' : 'major') : season === 'jesień' ? 'dorian' : 'aeolian';
    return { night, evening, season, scale, bpm: night ? 78 : evening ? 86 : 96, melodyP: night ? 0.3 : evening ? 0.5 : 0.68, percP: night ? 0 : evening ? 0.25 : 0.55, bellP: night ? 0.45 : 0.3 };
  }
  // pad: otwarta kwinta (akordeon: dwie piły rozstrojone + dolnoprzepustowy, oddech miecha)
  function padNote(m, t0, dur, gain) {
    const v = newVoice('music', 0); if (!v) return null;
    const inner = v.gain(1); const lp = v.filter('lowpass', 850, 0.8, inner); const f = midi(m);
    for (const det of [-6, 6]) { const g = v.gain(0.5, lp); const o = v.osc('sawtooth', f, t0, g); o.detune.value = det; }
    const bre = v.osc('sine', 0.28, t0); const bg = v.mod(0.12); bre.connect(bg); bg.connect(inner.gain); // oddech miecha
    env(v.g.gain, t0, gain, 1.6, 0, null, t0 + dur - 1.2, 1.2);
    v.start(t0); v.end(t0 + dur + 0.2); return v;
  }
  function melodyNote(m, t0, dur, gain, timbre) {
    const v = newVoice('music', rnd(-0.25, 0.25)); if (!v) return;
    const f = midi(m);
    if (timbre === 'reed') { // akordeon / harmonia
      const lp = v.filter('lowpass', 2200, 0.7);
      for (const det of [-5, 5]) { const g = v.gain(0.35, lp); const o = v.osc('sawtooth', f, t0, g); o.detune.value = det; }
      const g2 = v.gain(0.25, lp); v.osc('square', f / 2, t0, g2);
    } else { // fujarka: sinus + trochę trójkąta, oddech
      const g1 = v.gain(0.75); v.osc('sine', f, t0, g1); const g2 = v.gain(0.22); v.osc('triangle', f, t0, g2);
      const ng = v.gain(0.015); const nb = v.filter('bandpass', f * 2, 3, ng); v.noise(nb);
      const vib = v.osc('sine', 5.2, t0); const vg = v.mod(0); vib.connect(vg); vg.connect(v.srcs[0].frequency); vg.gain.setValueAtTime(0, t0); vg.gain.linearRampToValueAtTime(f * 0.008, t0 + Math.min(0.5, dur * 0.6));
    }
    const sg = v.gain(0.9, mus.send); v.g.connect(sg); // wysyłka do echa (obok bezpośredniej drogi do kanału)
    env(v.g.gain, t0, gain, timbre === 'reed' ? 0.05 : 0.08, dur * 0.3, 0.85, t0 + dur - Math.min(0.25, dur * 0.3), Math.min(0.3, dur * 0.3) + 0.05);
    v.start(t0); v.end(t0 + dur + 0.4);
  }
  function chime(m, t0, gain) {
    const v = newVoice('music', rnd(-0.6, 0.6)); if (!v) return;
    const f = midi(m);
    const g1 = v.gain(0.6); v.osc('sine', f, t0, g1); const g2 = v.gain(0.18); v.osc('sine', f * 2.76, t0, g2); g2.gain.setValueAtTime(0.18, t0); g2.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.6);
    const sg = v.gain(1, mus.send); v.g.connect(sg);
    env(v.g.gain, t0, gain, 0.004, 2.4, 0.0001);
    v.start(t0); v.end(t0 + 2.6);
  }
  function wood(t0, low, gain) {
    const v = newVoice('music', low ? -0.3 : 0.35); if (!v) return;
    const bp = v.filter('bandpass', low ? 620 : 1900, low ? 5 : 7); v.noise(bp);
    const lp = v.filter('lowpass', low ? 900 : 3000, 1); const o = v.osc('sine', low ? 300 : 900, t0, lp); o.frequency.exponentialRampToValueAtTime(low ? 180 : 600, t0 + 0.04);
    env(v.g.gain, t0, gain, 0.002, low ? 0.09 : 0.05, 0.0001);
    v.start(t0); v.end(t0 + 0.15);
  }
  function bass(m, t0, gain) {
    const v = newVoice('music', 0); if (!v) return;
    const lp = v.filter('lowpass', 300, 0.8); const g1 = v.gain(0.8, lp); v.osc('sine', midi(m), t0, g1); const g2 = v.gain(0.3, lp); v.osc('triangle', midi(m), t0, g2);
    env(v.g.gain, t0, gain, 0.02, 1.1, 0.0001);
    v.start(t0); v.end(t0 + 1.3);
  }
  // plan frazy (4 takty 3/4): akord, melodia (lista nut: start w ćwierćnutach, długość, stopień), perkusja, dzwonki
  function planPhrase() {
    const md = mood();
    mus.scale = md.scale; mus.bpm = md.bpm;
    const prev = mus.chord;
    mus.chord = pick(PROG[prev] || [0]);
    if (mus.phrase % 4 === 3) mus.chord = Math.random() < 0.7 ? 0 : 4; // kadencja co 4 frazy
    const ct = chordTones(mus.chord);
    const notes = [];
    const withMelody = ctx.currentTime >= mus.restUntil && Math.random() < md.melodyP;
    if (withMelody) {
      let deg = mus.lastDeg; // 7 = toniczna oktawę nad padem
      if (!ct.includes(((deg % 7) + 7) % 7) || Math.random() < 0.4) { const opts = [7, 9, 11, 14].filter(x => ct.includes(x % 7)); deg = opts.length ? pick(opts) : 7; }
      let beat = 0;
      for (let bar = 0; bar < 4; bar++) {
        const rh = bar === 3 ? pick([[3], [2, 1], [1, 2]]) : pick(RHYTHMS);
        let pos = 0;
        for (let k = 0; k < rh.length; k++) {
          const strong = pos === 0, last = bar === 3 && k === rh.length - 1;
          if (k > 0 || bar > 0) {
            const r = Math.random();
            let step = r < 0.55 ? (Math.random() < 0.5 ? 1 : -1) : r < 0.8 ? (Math.random() < 0.5 ? 2 : -2) : r < 0.9 ? 0 : (Math.random() < 0.5 ? 4 : -3);
            if (deg + step > 13) step = -Math.abs(step); if (deg + step < 5) step = Math.abs(step);
            deg += step;
          }
          if ((strong && Math.random() < 0.7) || last) { // mocne części taktu: najbliższy dźwięk akordu
            let best = deg, bd = 99;
            for (let c = deg - 3; c <= deg + 3; c++) { const dd = Math.abs(c - deg); if (ct.includes(((c % 7) + 7) % 7) && dd < bd && (!last || c % 7 === ct[0] || c % 7 === ct[2])) { best = c; bd = dd; } }
            deg = best;
          }
          notes.push({ at: beat + pos, dur: rh[k] * (last ? 1.6 : 0.95), deg });
          pos += rh[k];
        }
        beat += 3;
      }
      mus.lastDeg = deg;
    }
    const timbre = md.night || md.season === 'zima' ? 'flute' : Math.random() < 0.4 ? 'reed' : 'flute';
    return { chord: mus.chord, notes, perc: Math.random() < md.percP, bells: Math.random() < md.bellP, timbre, bpm: md.bpm, night: md.night };
  }
  function scheduleBar(t0, bar) {
    const P = mus.plan, bd = 60 / P.bpm, root = degToMidi(P.chord) - 12;
    if (bar === 0) { // pad na całą frazę: kwinta (i oktawa cicho)
      const dur = bd * 12 + 1.0;
      padNote(root, t0, dur, P.night ? 0.05 : 0.06); padNote(root + 7, t0, dur, P.night ? 0.035 : 0.045);
      if (!P.night && Math.random() < 0.5) padNote(root + 12, t0 + 0.3, dur - 0.3, 0.02);
    }
    bass(root - 12, t0, bar === 0 ? 0.16 : 0.1);
    if (P.perc) { wood(t0, true, 0.1); wood(t0 + bd, false, 0.05); if (Math.random() < 0.6) wood(t0 + bd * 2, false, 0.045); if (Math.random() < 0.3) wood(t0 + bd * 1.5, false, 0.035); }
    if (P.bells && Math.random() < 0.5) { const ct = chordTones(P.chord); chime(degToMidi(pick(ct) + 14), t0 + (Math.random() < 0.5 ? 0 : bd * 2), 0.07); }
    for (const n of P.notes) if (n.at >= bar * 3 && n.at < bar * 3 + 3) melodyNote(degToMidi(n.deg), t0 + (n.at - bar * 3) * bd, n.dur * bd, P.timbre === 'reed' ? 0.09 : 0.14, P.timbre);
  }
  function updateMusic() {
    if (!mus || !S.on || hidden) return;
    const now = ctx.currentTime;
    if (!mus.startedAt) { mus.startedAt = now; mus.next = now + 0.8; mus.bar = 0; mus.plan = null; }
    // po powrocie z ukrycia / długiej przerwy nie nadrabiamy: zaczynamy od nowa za chwilę
    if (mus.next < now - 0.5) { mus.next = now + 0.3; mus.bar = 0; mus.plan = null; }
    // oddech: co ~5 min realnego czasu 40–60 s samego pada (bez melodii)
    if (now - mus.startedAt > 300 && now >= mus.restUntil && Math.random() < 0.003) { mus.restUntil = now + rnd(40, 60); mus.startedAt = now; }
    while (mus.next < now + 0.4) {
      if (mus.bar === 0) { mus.plan = planPhrase(); mus.phrase++; }
      scheduleBar(mus.next, mus.bar);
      mus.next += 60 / mus.plan.bpm * 3;
      mus.bar = (mus.bar + 1) % 4;
    }
  }

  // =====================================================================
  //  INTERFEJS (dźwięki jednorazowe)
  // =====================================================================
  function tone(v, type, f0, f1, t0, d, g, dest) { const o = v.osc(type, f0, t0, dest || v.g); if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t0 + d); return o; }
  function blip(notes, type, g, len, gap, dest) { // sekwencja nut [midi...] równo
    const v = newVoice('ui', 0, true); if (!v) return;
    const t = ctx.currentTime; let tt = t;
    const lp = v.filter('lowpass', 5000, 0.7); const sg = v.gain(1, lp);
    for (const n of notes) { const o = v.osc(type || 'triangle', midi(n), tt, sg); const gg = v.gain(0.0001, lp); o.disconnect(); o.connect(gg); env(gg.gain, tt, g, 0.008, len * 0.8, 0.0001); tt += gap; }
    v.start(t); v.end(tt + len + 0.1);
  }
  const UI = {
    click() { const v = newVoice('ui', 0, true); if (!v) return; const t = ctx.currentTime; const hp = v.filter('highpass', 1500, 0.8); v.noise(hp); tone(v, 'sine', 1900, 1200, t, 0.03, 0); env(v.g.gain, t, 0.25, 0.002, 0.04, 0.0001); v.start(t); v.end(t + 0.08); },
    open() { const v = newVoice('ui', 0, true); if (!v) return; const t = ctx.currentTime; const bp = v.filter('bandpass', 600, 1.5); v.noise(bp); bp.frequency.exponentialRampToValueAtTime(2600, t + 0.09); const g2 = v.gain(0.4); tone(v, 'sine', 520, 780, t, 0.08, 0, g2); env(v.g.gain, t, 0.22, 0.01, 0.1, 0.0001); v.start(t); v.end(t + 0.16); },
    close() { const v = newVoice('ui', 0, true); if (!v) return; const t = ctx.currentTime; const bp = v.filter('bandpass', 2400, 1.5); v.noise(bp); bp.frequency.exponentialRampToValueAtTime(500, t + 0.09); const g2 = v.gain(0.4); tone(v, 'sine', 700, 450, t, 0.08, 0, g2); env(v.g.gain, t, 0.18, 0.01, 0.1, 0.0001); v.start(t); v.end(t + 0.16); },
    confirm() { blip([76, 81], 'triangle', 0.3, 0.14, 0.09); },
    cash() { // „kasa”: trzy brzęki monet + szmer
      const v = newVoice('ui', 0, true); if (!v) return; const t = ctx.currentTime;
      for (let i = 0; i < 3; i++) { const ts = t + i * 0.07; const g = v.gain(0.0001); const f = [2500, 3100, 3700][i]; v.osc('sine', f, ts, g); v.osc('sine', f * 2.4, ts, g).detune.value = 10; g.gain.setValueAtTime(0.0001, ts); g.gain.linearRampToValueAtTime(0.22 - i * 0.03, ts + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, ts + 0.35); }
      v.start(t); v.end(t + 0.6);
    },
    buy() { const v = newVoice('ui', 0, true); if (!v) return; const t = ctx.currentTime; const lp = v.filter('lowpass', 400, 1); tone(v, 'sine', 160, 90, t, 0.1, 0, lp); const g2 = v.gain(0.0001); tone(v, 'triangle', midi(69), midi(76), t + 0.08, 0.1, 0, g2); env(g2.gain, t + 0.08, 0.25, 0.01, 0.16, 0.0001); env(v.g.gain, t, 0.5, 0.004, 0.3, 0.0001); v.start(t); v.end(t + 0.4); },
    error() { const v = newVoice('ui', 0, true); if (!v) return; const t = ctx.currentTime; const lp = v.filter('lowpass', 700, 1); const o = v.osc('square', 165, t, lp); o.frequency.setValueAtTime(140, t + 0.12); const g = v.g.gain; g.setValueAtTime(0.0001, t); g.linearRampToValueAtTime(0.16, t + 0.01); g.setValueAtTime(0.16, t + 0.09); g.linearRampToValueAtTime(0.0001, t + 0.11); g.setValueAtTime(0.0001, t + 0.13); g.linearRampToValueAtTime(0.16, t + 0.14); g.setValueAtTime(0.16, t + 0.24); g.linearRampToValueAtTime(0.0001, t + 0.28); v.start(t); v.end(t + 0.32); },
    notify_info() { blip([81], 'sine', 0.2, 0.18, 0.1); },
    notify_good() { blip([74, 78, 81], 'triangle', 0.22, 0.18, 0.08); },
    notify_bad() { blip([70, 65], 'triangle', 0.22, 0.22, 0.16); },
    notify_money() { UI.cash(); },
    notify_warn() { blip([71, 71], 'square', 0.1, 0.12, 0.17); },
    built() { // trzy uderzenia młotka + akord
      const v = newVoice('ui', 0, true); if (!v) return; const t = ctx.currentTime;
      for (let i = 0; i < 3; i++) { const ts = t + i * 0.16; const g = v.gain(0.0001); const bp = v.filter('bandpass', 1800, 4, g); v.noise(bp); const lp = v.filter('lowpass', 500, 1, g); const o = v.osc('sine', 220, ts, lp); o.frequency.exponentialRampToValueAtTime(90, ts + 0.06); g.gain.setValueAtTime(0.0001, ts); g.gain.linearRampToValueAtTime(0.35, ts + 0.003); g.gain.exponentialRampToValueAtTime(0.0001, ts + 0.12); }
      v.start(t); v.end(t + 0.6);
      setTimeout(() => blip([62, 66, 69, 74], 'triangle', 0.2, 0.5, 0.0), 480);
    },
    harvest() { blip([67, 71, 74, 79], 'triangle', 0.2, 0.3, 0.09); const v = newVoice('ui', 0.2, true); if (!v) return; const t = ctx.currentTime + 0.2; const bp = v.filter('bandpass', 3200, 0.6); v.noise(bp); env(v.g.gain, t, 0.08, 0.1, 0.5, 0.0001); v.start(t); v.end(t + 0.7); },
    job_done() { blip([79, 86], 'sine', 0.18, 0.16, 0.1); },
    achievement() { blip([67, 71, 74, 79, 83], 'triangle', 0.22, 0.4, 0.11); setTimeout(() => blip([86], 'sine', 0.16, 0.7, 0), 560); },
    weather_warn() { const v = newVoice('ui', 0, true); if (v) { const t = ctx.currentTime; const lp = v.filter('lowpass', 120, 1.5); v.noise(lp); env(v.g.gain, t, 0.5, 0.08, 0.9, 0.0001); v.start(t); v.end(t + 1.1); } blip([69, 65], 'square', 0.08, 0.25, 0.3); },
    land() { blip([62, 69, 74], 'triangle', 0.2, 0.35, 0.12); },
    birth() { blip([81, 85], 'sine', 0.14, 0.25, 0.14); },
    op_done() { blip([74], 'sine', 0.12, 0.14, 0); },
    hover() { const v = newVoice('ui', 0, true); if (!v) return; const t = ctx.currentTime; const hp = v.filter('highpass', 3000, 1); v.noise(hp); env(v.g.gain, t, 0.08, 0.002, 0.02, 0.0001); v.start(t); v.end(t + 0.05); },
    thunder() { thunder(0.8, false); },
    rooster() { rooster('animals', 0.6, 0); },
    cow() { cowMoo('animals', 0.6, 0); },
    hen() { henCluck('animals', 0.5, 0); },
    pig() { pigGrunt('animals', 0.6, 0); },
    sheep() { sheepBleat('animals', 0.6, 0, false); },
    goat() { sheepBleat('animals', 0.6, 0, true); },
    horse() { horseCall('animals', 0.6, 0); },
    bell() { bell(0.12, 392, 0.3); },
    dog() { dogBark(0.12, 0.3); },
    owl() { owl(0.2, 0); }
  };
  S.names = Object.keys(UI);
  const lastPlay = {};
  // play(name, opts?) — opts: { x, y } (dźwięk przestrzenny przy kaflu), { force } (pomija ograniczenie powtórzeń)
  S.play = function (name, opts) {
    if (!ctx || !S.on) return false;
    const fn = UI[name]; if (!fn) return false;
    const now = ctx.currentTime;
    if (!(opts && opts.force) && lastPlay[name] != null && now - lastPlay[name] < 0.12) return false; // antydublowanie
    lastPlay[name] = now;
    try { fn(opts || {}); } catch (e) { console.error('[sound] ' + name, e); return false; }
    return true;
  };

  // ---------- reakcje na zdarzenia gry ----------
  G.on('notify', n => { if (!n) return; const k = n.kind || 'info'; S.play('notify_' + (UI['notify_' + k] ? k : 'info')); });
  G.on('sold', () => S.play('cash'));
  G.on('bought', () => S.play('buy'));
  G.on('built', () => S.play('built'));
  G.on('harvest', () => { const now = ctx ? ctx.currentTime : 0; if (lastPlay.harvest == null || now - lastPlay.harvest > 2.5) S.play('harvest'); });
  G.on('jobDone', () => S.play('job_done'));
  G.on('landBought', () => S.play('land'));
  G.on('animalBorn', () => S.play('birth'));
  G.on('opDone', () => S.play('op_done'));

  // ---------- pętla ----------
  let lastNow = -1, accum = 0, prevOn = S.on;
  S.update = function (now, dtReal) {
    if (!ctx) return;
    if (now === lastNow) return; // UI i hook 'frame' mogą wołać w tej samej klatce
    lastNow = now;
    if (prevOn !== S.on) { prevOn = S.on; applyGains(); }
    if (!S.on || ctx.state !== 'running') {
      if (!S.on && vehVoices.size) { for (const [k, r] of vehVoices) { r.v.fadeOut(0.2); vehVoices.delete(k); } }
      return;
    }
    accum += dtReal || 0.016;
    if (accum >= SPATIAL_DT) {
      const dt = Math.min(accum, 0.5); accum = 0;
      try { if (!hidden && G.S) { updateVehicles(dt); updateAnimals(dt); updateAmbient(dt); } } catch (e) { console.error('[sound] update', e); }
    }
    try { updateMusic(); } catch (e) { console.error('[sound] music', e); }
  };
  G.on('frame', (dtH, now, dtReal) => S.update(now, dtReal));

  // diagnostyka / testy (OfflineAudioContext): zaplanowanie muzyki z wyprzedzeniem, ręczne odezwania
  S._dbg = {
    scheduleMusicUntil(t) { if (!mus) return; if (!mus.startedAt) { mus.startedAt = ctx.currentTime; mus.next = ctx.currentTime + 0.1; } while (mus.next < t) { if (mus.bar === 0) { mus.plan = planPhrase(); mus.phrase++; } scheduleBar(mus.next, mus.bar); mus.next += 60 / mus.plan.bpm * 3; mus.bar = (mus.bar + 1) % 4; } },
    forceSpatial() { if (!ctx) return; updateVehicles(0.1); updateAnimals(0.1); updateAmbient(0.1); },
    spatial, ctx: () => ctx, vehVoices, beeVoices
  };
})();
