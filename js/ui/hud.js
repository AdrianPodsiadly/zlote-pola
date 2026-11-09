// Złote Pola — HUD: czas, pogoda, pieniądze, prędkość, powiadomienia, minimapa, pasek prac, tryb jazdy (agent: UI/UX)
(function () {
  const U = G.ui, h = U.h, ISO = G.iso;
  let elDate, elTime, elDayIco, elWeather, elMoney, elMoneyV, elDelta, elSpeed, elBell, elBellBadge, elSound, mmCanvas, mmCtx, pausedBanner;
  let shownMoney = null, moneyFlashT = 0;

  function dayIcon(hour) { return hour < 5 || hour >= 22 ? '🌙' : hour < 8 ? '🌅' : hour < 18 ? '☀️' : '🌇'; }
  function dayName(hour) { return hour < 5 || hour >= 22 ? 'noc' : hour < 8 ? 'świt' : hour < 12 ? 'rano' : hour < 18 ? 'dzień' : 'wieczór'; }

  function build() {
    const hud = document.getElementById('hud');
    const row1 = h('div'), row2 = h('div');
    row1.appendChild(h('button#hud-date.pill', { onclick: () => U.open('calendar') }, elDayIco = h('span.ico', '☀️'), h('span', elDate = h('span.d'), ' ', elTime = h('span.t.num'))));
    row1.appendChild(elWeather = h('button#hud-weather.pill', { onclick: () => U.open('weather') }, h('span.ico', '☁️'), h('span.num', '—')));
    row1.appendChild(h('div.spacer'));
    row1.appendChild(elMoney = h('button#hud-money.pill.num', { onclick: () => U.open('finance') }, elMoneyV = h('span', '0 zł'), elDelta = h('span.delta', '')));
    elSpeed = h('div#speed.seg');
    const names = { 0: '⏸', 1: '1×', 3: '3×', 8: '8×' };
    for (const s of G.CFG.SPEEDS) elSpeed.appendChild(h('button', { 'data-s': s, title: s === 0 ? 'Pauza (spacja)' : 'Tempo ' + s + '×', onclick: () => { U.sfx('ui_tap'); G.setSpeed(s); } }, names[s] || s + '×'));
    row2.appendChild(elSpeed);
    row2.appendChild(h('div.spacer'));
    row2.appendChild(elBell = h('button.ibtn', { title: 'Powiadomienia', onclick: () => U.open('notifications') }, '🔔', elBellBadge = h('span.badge.hidden')));
    row2.appendChild(elSound = h('button.ibtn', { title: 'Dźwięk', onclick: toggleSound }, '🔊'));
    row2.appendChild(h('button.ibtn', { title: 'Menu', onclick: () => U.open('more') }, '☰'));
    hud.appendChild(row1); hud.appendChild(row2);
    pausedBanner = h('div#paused-banner.hidden', '⏸ PAUZA');
    document.getElementById('app').appendChild(pausedBanner);
    mmCanvas = document.querySelector('#minimap canvas'); mmCtx = mmCanvas.getContext('2d');
    document.getElementById('minimap').addEventListener('pointerdown', e => {
      const r = mmCanvas.getBoundingClientRect();
      const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
      if (G.render && G.render.minimap) { if (G.render.minimapToTile) { const t = G.render.minimapToTile(fx, fy, r.width, r.height); if (t) { U.centerOn(t.x, t.y, true); return; } } }
      U.centerOn(fx * G.CFG.W, fy * G.CFG.H, true);
    });
    updateSpeed(G.speed);
    updateSound();
  }

  function updateSpeed(s) {
    if (!elSpeed) return;
    elSpeed.querySelectorAll('button').forEach(b => b.classList.toggle('on', +b.dataset.s === s));
    pausedBanner.classList.toggle('hidden', s !== 0 || U.mode === 'drive');
  }
  G.on('speed', updateSpeed);

  function toggleSound() {
    if (!(G.sound && G.sound.toggle)) { U.toast('Dźwięk pojawi się wkrótce', 'info'); return; }
    try { if (G.sound.unlock) G.sound.unlock(); G.sound.toggle(); } catch (e) { /* brak */ }
    updateSound();
  }
  function updateSound() {
    if (!elSound) return;
    const has = !!(G.sound && G.sound.toggle);
    const on = has ? (typeof G.sound.on === 'function' ? G.sound.on() : !!G.sound.on) : false;
    elSound.textContent = has && on ? '🔊' : '🔇';
    elSound.classList.toggle('off', !has || !on);
  }
  U.updateSound = updateSound;

  // co ~200 ms
  U.hudTick = function (now) {
    if (!G.S || !elDate) return;
    const d = G.date();
    elDate.textContent = d.dom + ' ' + G.MONTHS_GEN[d.month] + ' ' + d.year;
    const mins = Math.floor((G.hourFrac || 0) * 60);
    elTime.textContent = String(d.hour).padStart(2, '0') + ':' + String(mins - mins % 10).padStart(2, '0');
    elDayIco.textContent = dayIcon(d.hour);
    const W = G.weather;
    if (W) {
      elWeather.children[0].textContent = (W.TYPE_ICONS && W.TYPE_ICONS[W.type]) || '☁️';
      elWeather.children[1].textContent = Math.round(W.temp) + '°';
    }
    // pieniądze z animacją
    const m = G.S.money;
    if (shownMoney == null) shownMoney = m;
    if (Math.abs(shownMoney - m) > 0.5) { shownMoney += (m - shownMoney) * 0.35; if (Math.abs(shownMoney - m) < 1) shownMoney = m; } else shownMoney = m;
    elMoneyV.textContent = G.fmtMoney(shownMoney);
    const bal = (G.S.today.income || 0) - (G.S.today.expense || 0);
    elDelta.textContent = (bal >= 0 ? '+' : '−') + G.fmtNum(Math.abs(bal), 0);
    elDelta.title = 'Bilans dnia';
    elMoney.classList.toggle('down', m < 0);
    elMoney.classList.toggle('up', m >= 0 && bal > 0);
    if (now - moneyFlashT < 500) elMoney.classList.add('flash'); else elMoney.classList.remove('flash');
    // dzwonek
    const unread = history.filter(n => !n.read).length;
    elBellBadge.textContent = unread > 99 ? '99+' : unread; elBellBadge.classList.toggle('hidden', !unread);
    // doradca
    const adv = U.adviceCount ? U.adviceCount() : 0;
    const fb = document.querySelector('#fab-advisor .badge'); if (fb) { fb.textContent = adv; fb.classList.toggle('hidden', !adv); }
    // pasek prac
    const jobs = U.call('jobs.list', [], []) || [];
    const fj = document.getElementById('fab-jobs');
    if (fj) {
      fj.classList.toggle('show', jobs.length > 0 && !U.isOpen('jobs'));
      if (jobs.length) { const act = jobs.filter(j => j.status === 'active'); const pr = act.length ? act.reduce((a, j) => a + (j.total ? j.done / j.total : 0), 0) / act.length : 0; fj.querySelector('.lbl').textContent = jobs.length + ' ' + (jobs.length === 1 ? 'praca' : jobs.length < 5 ? 'prace' : 'prac'); fj.querySelector('.bar i').style.width = Math.round(pr * 100) + '%'; }
    }
    drawMinimap();
  };
  G.on('money', () => { moneyFlashT = performance.now(); });

  // ---------- minimapa ----------
  const TCOL = { 0: '#6f9e4a', 1: '#9b7b4f', 2: '#2f5d2a', 3: '#3d7fbf', 4: '#b49a6c', 5: '#9a958a', 6: '#8fc062', 7: '#c96f4a', 8: '#55595f' };
  let mmBase = null, mmBaseAt = 0;
  function drawMinimap() {
    if (!mmCanvas || !G.S || !G.S.map) return;
    const r = mmCanvas.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(r.width * dpr), hh = Math.round(r.height * dpr);
    if (!w || !hh) return;
    if (mmCanvas.width !== w || mmCanvas.height !== hh) { mmCanvas.width = w; mmCanvas.height = hh; mmBase = null; }
    if (G.render && G.render.minimap) {
      mmCtx.setTransform(1, 0, 0, 1, 0, 0);
      try { G.render.minimap(mmCtx, w, hh); } catch (e) { /* brak */ }
      return;
    }
    // własna minimapa (rzut z góry) — gdy grafika jej nie dostarcza
    const now = performance.now();
    if (!mmBase || now - mmBaseAt > 2000) {
      mmBase = document.createElement('canvas'); mmBase.width = w; mmBase.height = hh;
      const c = mmBase.getContext('2d'), M = G.S.map, W = G.CFG.W, H = G.CFG.H, sx = w / W, sy = hh / H;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x, pid = M.parcel[i];
        c.fillStyle = TCOL[M.t[i]] || '#f0f';
        if (pid >= 0 && G.S.parcels[pid].owner === 'player') c.fillStyle = '#e9b949';
        else if (pid >= 0 && G.S.parcels[pid].owner === 'market') c.fillStyle = M.t[i] === 6 ? '#a9d08a' : '#c9a86e';
        c.fillRect(x * sx, y * sy, sx + 0.5, sy + 0.5);
      }
      for (const b of (G.S.buildings || [])) { c.fillStyle = '#f4efe2'; c.fillRect(b.x * sx, b.y * sy, Math.max(1.5, 2 * sx), Math.max(1.5, 2 * sy)); }
      mmBaseAt = now;
    }
    mmCtx.setTransform(1, 0, 0, 1, 0, 0);
    mmCtx.drawImage(mmBase, 0, 0);
    // pojazdy
    const sx = w / G.CFG.W, sy = hh / G.CFG.H;
    for (const v of (U.call('jobs.vehicles', [], []) || [])) { if (v.inGarage || v.kind === 'parked') continue; mmCtx.fillStyle = '#fff'; mmCtx.beginPath(); mmCtx.arc(v.x * sx, v.y * sy, 1.6 * dpr, 0, 7); mmCtx.fill(); }
    // prostokąt kamery (przybliżony: narożniki ekranu → kafle)
    const pts = [[0, 0], [G.cam.vw, 0], [G.cam.vw, G.cam.vh], [0, G.cam.vh]].map(p => ISO.screenToTileF(p[0], p[1]));
    mmCtx.strokeStyle = 'rgba(255,255,255,0.85)'; mmCtx.lineWidth = 1.2 * dpr; mmCtx.beginPath();
    pts.forEach((p, k) => { const X = Math.max(0, Math.min(w, p.tx * sx)), Y = Math.max(0, Math.min(hh, p.ty * sy)); if (k) mmCtx.lineTo(X, Y); else mmCtx.moveTo(X, Y); });
    mmCtx.closePath(); mmCtx.stroke();
  }

  // ---------- powiadomienia ----------
  const history = U.notifications = [];
  const toasts = [];
  let toastSeq = 0;
  G.on('notify', n => {
    if (!document.getElementById('toasts')) return;
    const key = n.opts && n.opts.key;
    if (!n.opts || !n.opts.local) {
      if (key) { const same = history.find(x => x.key === key && !x.read); if (same) { same.text = n.text; same.t = n.t; same.when = Date.now(); same.count = (same.count || 1) + 1; } else history.unshift({ text: n.text, kind: n.kind, key, t: n.t, when: Date.now(), read: false, opts: n.opts }); }
      else history.unshift({ text: n.text, kind: n.kind, t: n.t, when: Date.now(), read: false, opts: n.opts });
      if (history.length > 120) history.length = 120;
    }
    showToast(n, key);
    if (n.kind === 'bad') U.haptic(25);
    U.sfx(n.kind === 'bad' ? 'notify_bad' : n.kind === 'money' ? 'coin' : 'notify');
  });
  function showToast(n, key) {
    const box = document.getElementById('toasts');
    if (key) { const t = toasts.find(x => x.key === key); if (t) { t.el.querySelector('.txt').textContent = n.text; t.until = performance.now() + 4500; return; } }
    const el = h('div.toast.' + (n.kind || 'info'), h('span.dot'), h('span.txt.grow', n.text), h('span.x', '✕'));
    const t = { el, key, until: performance.now() + (n.kind === 'bad' ? 6500 : 4500), id: ++toastSeq };
    el.addEventListener('click', () => { if (n.opts && n.opts.parcel != null) { U.centerParcel(n.opts.parcel); U.selectParcel(n.opts.parcel); } else if (n.opts && n.opts.tile != null) U.centerTile(n.opts.tile); removeToast(t); });
    toasts.push(t); box.appendChild(el);
    while (toasts.length > 2) removeToast(toasts[0], true);
  }
  function removeToast(t, now) {
    const k = toasts.indexOf(t); if (k >= 0) toasts.splice(k, 1);
    if (now) { t.el.remove(); return; }
    t.el.classList.add('out'); setTimeout(() => t.el.remove(), 320);
  }
  U.toastTick = function (now) { for (const t of toasts.slice()) if (now > t.until) removeToast(t); };
  U.markRead = () => { for (const n of history) n.read = true; };

  U.panel('notifications', {
    title: 'Powiadomienia', live: 2000,
    render(body) {
      U.markRead();
      if (!history.length) { body.appendChild(h('div.empty', h('span.ico', '🔔'), 'Na razie cisza. Tu zobaczysz historię komunikatów z gospodarstwa.')); return; }
      const list = h('div.list');
      for (const n of history) {
        const d = G.date(n.t);
        list.appendChild(h('div.item.clickable', { onclick: () => { if (n.opts && n.opts.parcel != null) { U.centerParcel(n.opts.parcel); U.selectParcel(n.opts.parcel); } else if (n.opts && n.opts.tile != null) { U.centerTile(n.opts.tile); if (U.isMobile()) U.close(); } } },
          h('span.ico', { style: { fontSize: '14px' } }, { good: '🟢', bad: '🔴', warn: '🟠', money: '🟡', info: '🔵' }[n.kind] || '🔵'),
          h('div.grow', h('div', n.text), h('div.tiny.muted', d.dom + ' ' + G.MONTHS_GEN[d.month] + ', ' + U.fmt.time(d.hour) + (n.count > 1 ? ' · ×' + n.count : '')))));
      }
      body.appendChild(list);
      body.appendChild(h('button.btn.block.ghost', { onclick: () => { history.length = 0; U.rerender(); } }, 'Wyczyść historię'));
    }
  });

  // ---------- pogoda i kalendarz ----------
  U.panel('weather', {
    title: 'Pogoda', sub: () => G.weather && G.weather.describe ? G.weather.describe() : '',
    render(body) {
      const W = G.weather; if (!W) { body.appendChild(h('div.empty', 'Brak danych pogodowych')); return; }
      body.appendChild(h('div.grid3',
        h('div.stat', h('div.l', 'Temperatura'), h('div.v', Math.round(W.temp) + ' °C')),
        h('div.stat', h('div.l', 'Wiatr'), h('div.v', G.fmtNum(W.wind, 0) + ' m/s')),
        h('div.stat', h('div.l', 'Wilgotność gleby'), h('div.v', Math.round(W.soilMoisture * 100) + '%'))));
      const cw = W.canWork ? W.canWork() : { ok: true };
      body.appendChild(h('div.hint' + (cw.ok ? '.good' : '.warn'), cw.ok ? '✅ Można pracować w polu.' : '⏸ ' + cw.reason));
      if (W.snow > 0) body.appendChild(h('div.hint', '❄️ Pokrywa śnieżna: ' + Math.round(W.snow) + ' cm' + (W.frozen ? ', grunt zamarznięty' : '')));
      if (W.drought > 0.3) body.appendChild(h('div.hint.warn', '🌵 Susza: ' + Math.round(W.drought * 100) + '% — rośliny tracą potencjał plonu'));
      body.appendChild(h('div.section', 'Prognoza'));
      for (const f of (W.forecast || [])) body.appendChild(h('div.card', h('div.row.between', h('div.row', h('span.ico-big', f.icon || ''), h('div', h('div.b', f.label), h('div.small.muted', f.text + (f.storm ? ' ⛈️ możliwa burza' : '')))), h('div.right', h('div.b.num', Math.round(f.tmin) + '° / ' + Math.round(f.tmax) + '°'), h('div.small.muted.num', '🌧 ' + f.prob + '%' + (f.rain ? ' · ' + G.fmtNum(f.rain, 0) + ' mm' : ''))))));
      body.appendChild(h('div.hint', 'Prace polowe stoją w deszczu, przy zmarzniętej ziemi i gdy łan jest mokry. Oprysk: wiatr do 5 m/s, poniżej 27 °C.'));
    }
  });
  U.panel('calendar', {
    title: () => G.dateText(), sub: () => { const d = G.date(); return d.season + ' · ' + dayName(d.hour) + ', ' + U.fmt.time(d.hour) + ' · ' + G.CFG.DAY_LENGTHS[G.CFG.DAY_SEC] + ' na dobę'; },
    render(body) {
      const d = G.date();
      body.appendChild(h('div.grid3',
        h('div.stat', h('div.l', 'Dzień roku'), h('div.v', (d.doy + 1) + ' / ' + G.DAYS_PER_YEAR)),
        h('div.stat', h('div.l', 'Miesiąc'), h('div.v', (d.dom) + ' / ' + G.CFG.DAYS_PER_MONTH)),
        h('div.stat', h('div.l', 'Tempo'), h('div.v', G.speed ? G.speed + '×' : 'pauza'))));
      body.appendChild(h('div.section', 'Kalendarz rolnika'));
      const CAL = [
        [2, '🌱 Wiosenny start: saletra na oziminy, siew jarych (jęczmień, owies, pszenica jara), wapnowanie.'],
        [3, '🌱 Siew kukurydzy i buraków, sadzenie ziemniaków. Herbicydy na oziminy.'],
        [4, '💧 Fungicydy i insektycydy (rzepak: słodyszek). Pierwszy pokos łąk pod koniec maja.'],
        [5, '✂️ Sianokosy. Oprysk przeciw stonce. Struktura upraw do dopłat liczy się w czerwcu.'],
        [6, '🌾 Żniwa: rzepak, jęczmień ozimy, potem pszenica i pszenżyto. Prasowanie słomy.'],
        [7, '🌾 Koniec żniw, orka/uprawa pożniwna, wapnowanie, siew rzepaku pod koniec sierpnia.'],
        [8, '🌱 Siew ozimin (żyto, pszenżyto, jęczmień ozimy, pszenica). Zbiór kukurydzy na kiszonkę, ziemniaków.'],
        [9, '🌽 Zbiór kukurydzy na ziarno, buraków. Orka zimowa. Koniec okresu nawożenia 30 XI.'],
        [10, '🍂 Ostatnie zbiory buraków. Przeglądy maszyn, planowanie sezonu.'],
        [11, '❄️ Zima: serwis, sprzedaż zapasów po dobrych cenach, wypłata dopłat 1 XII.'],
        [0, '❄️ Zima: zakaz nawożenia do końca lutego. Dobry czas na zakupy maszyn.'],
        [1, '❄️ Przygotowanie: zakup nasion i nawozów. Podatek rolny w marcu.']
      ];
      for (const [m, t] of CAL) body.appendChild(h('div.card' + (m === d.month ? '.sel' : ''), h('div.b', G.MONTHS[m][0].toUpperCase() + G.MONTHS[m].slice(1)), h('div.small', t)));
    }
  });

  // ---------- tryb jazdy (G.drive — atrapa, jeśli brak) ----------
  let drv = null; // { uid, joy: {dx, dy, active, id}, el }
  function driveBuild() {
    const d = document.getElementById('drive'); U.clear(d);
    const dash = h('div.dash.glass', h('div', h('div.v.num#drv-speed', '0'), h('div.l', 'km/h')), h('div', h('div.v#drv-gear', 'N'), h('div.l', 'bieg')), h('div', h('div.v.num#drv-fuel', '—'), h('div.l', 'paliwo')), h('div', h('div.v.num#drv-fill', '—'), h('div.l', 'ładunek')));
    d.appendChild(dash);
    d.appendChild(h('button.btn.exit.glass', { onclick: U.driveExit }, '🚪 Wysiądź'));
    const joy = h('div#joy', h('div.knob'));
    d.appendChild(joy);
    const acts = h('div.acts');
    acts.appendChild(h('button.btn#drv-impl', { onclick: () => U.call('drive.toggleImplement') }, '⬇️', h('span.lbl', 'narzędzie')));
    acts.appendChild(h('button.btn#drv-hitch', { onclick: () => { const s = driveState(); if (s && s.implement && !s.canHitch) U.call('drive.unhitch'); else U.call('drive.hitchNearest'); } }, '🔗', h('span.lbl', 'podczep')));
    acts.appendChild(h('button.btn#drv-unload', { onclick: () => U.call('drive.unloadAuger') }, '🌾', h('span.lbl', 'rozładuj')));
    acts.appendChild(h('button.btn#drv-brake', { onpointerdown: () => { drv.brake = true; }, onpointerup: () => { drv.brake = false; }, onpointercancel: () => { drv.brake = false; }, onpointerleave: () => { drv.brake = false; } }, '🛑', h('span.lbl', 'hamulec')));
    d.appendChild(acts);
    d.appendChild(h('div.hints#drv-hints'));
    const knob = joy.querySelector('.knob');
    const R = 55;
    const setKnob = (dx, dy) => { knob.style.transform = 'translate(' + dx + 'px,' + dy + 'px)'; };
    joy.addEventListener('pointerdown', e => { joy.setPointerCapture(e.pointerId); drv.joy = { id: e.pointerId, dx: 0, dy: 0 }; move(e); });
    const move = e => { if (!drv.joy || drv.joy.id !== e.pointerId) return; const r = joy.getBoundingClientRect(); let dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2); const L = Math.hypot(dx, dy); if (L > R) { dx *= R / L; dy *= R / L; } drv.joy.dx = dx / R; drv.joy.dy = dy / R; setKnob(dx, dy); };
    joy.addEventListener('pointermove', move);
    const end = e => { if (drv.joy && drv.joy.id === e.pointerId) { drv.joy = null; setKnob(0, 0); } };
    joy.addEventListener('pointerup', end); joy.addEventListener('pointercancel', end);
  }
  function driveState() { try { return G.drive && G.drive.state ? G.drive.state() : null; } catch (e) { return null; } }
  U.driveStart = function (uid) {
    if (!(G.drive && G.drive.take)) { U.toast('🕹️ Ręczna jazda pojawi się wkrótce', 'info'); return false; }
    let r = null;
    try { r = G.drive.take(uid); } catch (e) { console.error(e); }
    if (r && r.ok === false) { U.toast('🚫 ' + (r.reason || 'Nie można prowadzić'), 'bad'); return false; }
    drv = { uid, joy: null, brake: false, lastHints: '' };
    driveBuild();
    U.close(); U.hideCtx();
    U.mode = 'drive';
    document.getElementById('drive').classList.add('show');
    document.getElementById('nav').classList.add('hidden'); document.getElementById('hud').classList.add('hidden');
    document.getElementById('fab-advisor').classList.add('hidden'); document.getElementById('minimap').classList.add('hidden');
    U.cam.follow = { uid };
    pausedBanner.classList.add('hidden');
    U.sfx('engine_start');
    return true;
  };
  U.driveExit = function () {
    try { if (G.drive && G.drive.release) G.drive.release(); } catch (e) { /* brak */ }
    drv = null; U.mode = 'normal'; U.cam.follow = null;
    document.getElementById('drive').classList.remove('show');
    document.getElementById('nav').classList.remove('hidden'); document.getElementById('hud').classList.remove('hidden');
    document.getElementById('fab-advisor').classList.remove('hidden'); document.getElementById('minimap').classList.remove('hidden');
    updateSpeed(G.speed);
  };
  U.driveTick = function (now, dt, keys) {
    if (!drv || !(G.drive && G.drive.input)) return;
    let throttle = 0, steer = 0, brake = drv.brake ? 1 : 0;
    if (drv.joy) { throttle = -drv.joy.dy; steer = drv.joy.dx; }
    if (keys.has('w') || keys.has('arrowup')) throttle = 1; if (keys.has('s') || keys.has('arrowdown')) throttle = -1;
    if (keys.has('a') || keys.has('arrowleft')) steer = -1; if (keys.has('d') || keys.has('arrowright')) steer = 1;
    if (keys.has(' ')) brake = 1;
    if (keys.has('q') && !drv.qHeld) { drv.qHeld = true; U.call('drive.toggleImplement'); } if (!keys.has('q')) drv.qHeld = false;
    if (keys.has('e') && !drv.eHeld) { drv.eHeld = true; const s = driveState(); if (s && s.implement && !s.canHitch) U.call('drive.unhitch'); else U.call('drive.hitchNearest'); } if (!keys.has('e')) drv.eHeld = false;
    if (keys.has('f') && !drv.fHeld) { drv.fHeld = true; U.call('drive.unloadAuger'); } if (!keys.has('f')) drv.fHeld = false;
    try { G.drive.input({ throttle, steer, brake }); } catch (e) { /* brak */ }
    const s = driveState();
    if (!s) return;
    const q = id => document.getElementById(id);
    if (q('drv-speed')) q('drv-speed').textContent = Math.round(Math.abs(s.speed || 0));
    if (q('drv-gear')) q('drv-gear').textContent = s.gear || (s.speed < -0.1 ? 'R' : s.speed > 0.1 ? 'D' : 'N');
    if (q('drv-fuel')) q('drv-fuel').textContent = s.fuel != null ? Math.round(s.fuel) + (s.fuelCap ? '/' + Math.round(s.fuelCap) : '') + ' l' : '—';
    if (q('drv-fill')) q('drv-fill').textContent = s.fill != null ? Math.round(s.fill * 100) + '%' : '—';
    const impl = q('drv-impl'); if (impl) { impl.classList.toggle('on', !!s.lowered); impl.disabled = !s.implement; impl.firstChild.textContent = s.lowered ? '⬆️' : '⬇️'; impl.querySelector('.lbl').textContent = s.implement ? (s.lowered ? 'podnieś' : 'opuść') : 'brak narz.'; }
    const hb = q('drv-hitch'); if (hb) { const can = !!s.canHitch, has = !!s.implement; hb.disabled = !can && !has; hb.querySelector('.lbl').textContent = can ? 'podczep' : has ? 'odczep' : 'podczep'; hb.classList.toggle('on', can); }
    const ub = q('drv-unload'); if (ub) ub.disabled = !(s.fill > 0);
    const hs = (s.hints || []).join('|');
    if (hs !== drv.lastHints) { drv.lastHints = hs; const hh = q('drv-hints'); U.clear(hh); for (const t of (s.hints || []).slice(0, 3)) hh.appendChild(h('div', t)); }
    if (G.drive.needParams) { let np = null; try { np = G.drive.needParams(); } catch (e) { /* brak */ } if (np && !drv.asking) { drv.asking = true; U.askParams(np, p => { drv.asking = false; try { G.drive.setParams(p); } catch (e) { /* brak */ } }, () => { drv.asking = false; }); } }
  };
  // okienko parametrów (np. uprawa do siewu / nawóz) — spec: { title, fields: [{ key, label, type: 'select'|'number', options: [{value,label}], min, max, step, value }] }
  U.askParams = function (spec, onOk, onCancel) {
    const vals = {}, body = h('div');
    for (const f of (spec.fields || [])) {
      vals[f.key] = f.value != null ? f.value : (f.options && f.options[0] ? f.options[0].value : (f.min || 0));
      if (f.type === 'select' || f.options) {
        const chips = h('div.chips');
        for (const o of f.options) chips.appendChild(h('button.chip' + (o.value === vals[f.key] ? '.on' : ''), { onclick: e => { vals[f.key] = o.value; chips.querySelectorAll('.chip').forEach(c => c.classList.remove('on')); e.currentTarget.classList.add('on'); } }, o.label));
        body.appendChild(h('div.field', h('label', f.label), chips));
      } else {
        const inp = h('input.input', { type: 'number', min: f.min, max: f.max, step: f.step || 1, value: vals[f.key], oninput: e => { vals[f.key] = +e.target.value; } });
        body.appendChild(h('div.field', h('label', f.label), inp));
      }
    }
    U.modal({ title: spec.title || 'Parametry', body, actions: [{ label: 'Anuluj', cls: 'ghost', onclick: () => { if (onCancel) onCancel(); } }, { label: 'OK', cls: 'primary', onclick: () => onOk(vals) }], dismiss: false });
  };

  G.on('boot', build);
})();
