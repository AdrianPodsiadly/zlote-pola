// Złote Pola — interfejs: rdzeń (agent: UI/UX)
// Układ DOM, sterowanie kamerą (palec/mysz/klawiatura), wybór na mapie, router paneli (bottom sheet / panel boczny),
// okna modalne, pomocnicze funkcje budowania DOM. Pozostałe pliki ui/*.js rejestrują panele przez G.ui.panel(name, def).
(function () {
  const U = G.ui = {};
  const ISO = G.iso;

  // ---------- pomocnicze: DOM ----------
  // h('div.card.sel#id', {onclick, title, html}, ...children)
  U.h = function (tag, ...rest) {
    const parts = tag.split(/(?=[.#])/);
    const el = document.createElement(parts[0] || 'div');
    // klasy mogą zawierać spacje (np. 'span.num bad') — dzielimy je, zamiast wywracać cały ekran
    for (const p of parts.slice(1)) { if (p[0] === '.') { for (const c of p.slice(1).split(/\s+/)) if (c) el.classList.add(c); } else if (p[0] === '#') el.id = p.slice(1).trim(); }
    let attrs = rest[0], i = 1;
    // pierwszy argument to atrybuty tylko wtedy, gdy jest zwykłym obiektem (nie węzłem, tablicą ani tekstem)
    if (attrs == null || typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs)) { i = attrs == null ? 1 : 0; attrs = null; }
    if (attrs) for (const k in attrs) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'html') el.innerHTML = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'cls') el.className += ' ' + v;
      else if (k in el && k !== 'list' && k !== 'type') { try { el[k] = v; } catch (e) { el.setAttribute(k, v); } }
      else el.setAttribute(k, v);
    }
    for (; i < rest.length; i++) append(el, rest[i]);
    return el;
  };
  function append(el, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) { for (const x of c) append(el, x); return; }
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  const h = U.h;
  U.clear = el => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
  U.esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  U.fmt = {
    money: v => G.fmtMoney(v || 0),
    signed: v => (v > 0 ? '+' : v < 0 ? '−' : '') + G.fmtMoney(Math.abs(v || 0)),
    num: (v, d) => G.fmtNum(v || 0, d),
    qty: (id, q) => G.fmtQty(id, q || 0),
    pct: v => Math.round((v || 0) * 100) + '%',
    ha: v => G.fmtNum(v || 0, 2) + ' ha',
    hours: hh => { if (hh == null) return '—'; if (hh < 1) return Math.round(hh * 60) + ' min'; if (hh < 24) return G.fmtNum(hh, 1) + ' h'; return G.fmtNum(hh / 24, 1) + ' dni'; },
    time: t => String(t).padStart(2, '0') + ':00',
    stars: n => { let s = ''; for (let i = 1; i <= 5; i++) s += i <= n ? '★' : '<span class="off">★</span>'; return '<span class="stars">' + s + '</span>'; }
  };
  U.isMobile = () => window.innerWidth < 860;
  U.haptic = function (ms) { try { if (navigator.vibrate) navigator.vibrate(ms || 12); } catch (e) { /* brak */ } };
  U.sfx = function (name) { try { if (G.sound && G.sound.play) G.sound.play(name); } catch (e) { /* brak */ } };
  // bezpieczne wywołanie API modułu (brak modułu → null)
  U.call = function (path, args, fallback) {
    try {
      const parts = path.split('.'); let o = G;
      for (let i = 0; i < parts.length - 1; i++) { o = o && o[parts[i]]; if (!o) return fallback; }
      const fn = o[parts[parts.length - 1]];
      return typeof fn === 'function' ? fn.apply(o, args || []) : fallback;
    } catch (e) { console.error('[ui] ' + path, e); return fallback; }
  };
  U.has = path => { const parts = path.split('.'); let o = G; for (const p of parts) { o = o && o[p]; if (o == null) return false; } return true; };

  // ---------- stan UI (w zapisie: G.S.ui) ----------
  U.state = () => { if (G.S && !G.S.ui) G.S.ui = {}; return G.S ? G.S.ui : {}; };
  U.pref = {
    get(k, d) { try { const v = localStorage.getItem(G.CFG.SAVE_PREFIX + 'ui_' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(G.CFG.SAVE_PREFIX + 'ui_' + k, JSON.stringify(v)); } catch (e) { /* brak */ } }
  };

  // ---------- układ ----------
  let cv, app, sheet, sheetBody, sheetTitle, sheetSub, sheetFoot, btnBack, modal, lpRing, tapMarker;
  function buildLayout() {
    app = document.getElementById('app');
    cv = document.getElementById('cv');
    app.appendChild(h('div#hud'));
    app.appendChild(h('div#toasts'));
    app.appendChild(h('div#tap-marker'));
    app.appendChild(h('div#lp-ring'));
    const mm = h('div#minimap', { title: 'Minimapa — dotknij, aby przenieść kamerę' }, h('canvas'));
    app.appendChild(mm);
    app.appendChild(h('button#fab-advisor', { title: 'Doradca: co teraz?', onclick: () => U.open('advisor') }, '💡', h('span.badge.hidden')));
    app.appendChild(h('button#fab-jobs.glass', { onclick: () => U.open('jobs') }, h('span.ico', '📋'), h('span.lbl', 'Prace'), h('div.bar.thin.gold', h('i'))));
    app.appendChild(h('div#placebar.glass'));
    sheet = h('aside#sheet',
      h('div.sheet-handle'),
      h('div.sheet-head',
        btnBack = h('button.btn.icon.ghost', { onclick: () => U.back(), title: 'Wstecz' }, '‹'),
        h('h2', sheetTitle = h('span.ttl'), sheetSub = h('span.sub')),
        h('button.btn.icon.ghost', { onclick: () => U.close(), title: 'Zamknij' }, '✕')),
      sheetBody = h('div.sheet-body'),
      sheetFoot = h('div.sheet-foot'));
    app.appendChild(sheet);
    app.appendChild(h('div#ctxmenu.glass.hidden'));
    app.appendChild(h('div#drive'));
    app.appendChild(h('nav#nav'));
    modal = h('div#modal'); app.appendChild(modal);
    app.appendChild(h('div#tut'));
    app.appendChild(h('div#title'));
    lpRing = document.getElementById('lp-ring'); tapMarker = document.getElementById('tap-marker');
    // blokady: menu kontekstowe, zaznaczanie, gesty przeglądarki (zoom strony)
    document.addEventListener('contextmenu', e => { e.preventDefault(); });
    document.addEventListener('selectstart', e => { const t = e.target; if (!(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA'))) e.preventDefault(); });
    document.addEventListener('gesturestart', e => e.preventDefault());
    document.addEventListener('dblclick', e => { if (e.target === cv) e.preventDefault(); });
    document.addEventListener('touchmove', e => { if (e.touches.length > 1 && e.target === cv) e.preventDefault(); }, { passive: false });
    buildNav();
    sheetGestures();
  }

  // ---------- dolna nawigacja ----------
  const NAV = [
    { id: 'fields', icon: '🌾', label: 'Pola' }, { id: 'machines', icon: '🚜', label: 'Maszyny' },
    { id: 'animals', icon: '🐄', label: 'Hodowla' }, { id: 'build', icon: '🏗️', label: 'Budowa' }, { id: 'market', icon: '💰', label: 'Rynek' },
    { id: 'finance', icon: '📊', label: 'Finanse' }, { id: 'more', icon: '⋯', label: 'Więcej' }
  ];
  U.MORE = [
    { id: 'people', icon: '👷', label: 'Ludzie', desc: 'pracownicy, kandydaci, role' }, { id: 'land', icon: '🏞️', label: 'Ziemia', desc: 'oferty kupna i dzierżawy' },
    { id: 'storage', icon: '📦', label: 'Magazyn', desc: 'zapasy i pojemność' }, { id: 'jobs', icon: '📋', label: 'Prace', desc: 'aktywne zlecenia i historia' },
    { id: 'notifications', icon: '🔔', label: 'Powiadomienia', desc: 'historia komunikatów' }, { id: 'advisor', icon: '💡', label: 'Doradca', desc: 'co teraz robić?' },
    { id: 'settings', icon: '⚙️', label: 'Ustawienia', desc: 'tempo, dźwięk, zapis' }, { id: 'help', icon: '❓', label: 'Jak grać', desc: 'samouczek i poradnik' }
  ];
  function buildNav() {
    const nav = document.getElementById('nav');
    for (const n of NAV) nav.appendChild(h('button', { 'data-nav': n.id, onclick: () => { U.sfx('ui_tap'); const cur = stack.length ? stack[0].name : null; if (n.id === 'map' || (cur === n.id && stack.length === 1 && sheet.classList.contains('open'))) U.close(); else U.open(n.id); } }, h('span.ico', n.icon), h('span', n.label), h('span.badge.hidden')));
    updateNav();
  }
  function updateNav() {
    // podświetlona sekcja = dno stosu (np. Pola → działka → kreator nadal pod „Pola”)
    const base = stack.length ? stack[0].name : 'map';
    const top = NAV.some(n => n.id === base) ? base : U.MORE.some(m => m.id === base) ? 'more' : 'map';
    document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('on', b.dataset.nav === top));
  }
  U.navBadge = function (id, n) { const b = document.querySelector('#nav button[data-nav="' + id + '"] .badge'); if (!b) return; b.textContent = n; b.classList.toggle('hidden', !(n > 0)); };

  // ---------- router paneli ----------
  // U.panel(name, { title(arg), sub(arg), render(body, arg, ctx), foot(arg, ctx)?, live (odświeżanie co ~1 s), full (pełna wysokość), onClose? })
  const PANELS = {};
  const stack = [];
  U.panel = (name, def) => { PANELS[name] = def; };
  U.current = () => stack.length ? stack[stack.length - 1] : null;
  U.isOpen = name => stack.some(s => s.name === name);
  U.open = function (name, arg, opts) {
    const def = PANELS[name];
    if (!def) { U.toast('Ten ekran jest jeszcze w budowie', 'info'); return; }
    opts = opts || {};
    if (opts.replace && stack.length) stack.pop();
    const top = stack[stack.length - 1];
    if (top && top.name === name && !opts.push) { top.arg = arg; }   // ten sam panel: odśwież z nowym argumentem
    else {
      if (!opts.push && NAV.some(n => n.id === name)) stack.length = 0;  // główne sekcje zerują stos
      stack.push({ name, arg, def, state: {} });
    }
    render();
    sheet.classList.add('open');
    sheet.classList.toggle('full', !!def.full || !!opts.full);
    app.classList.remove('sheet-hidden');
    duck(true);
    updateNav();
    G.emit('uiOpen', name);
  };
  U.back = function () { if (stack.length > 1) { stack.pop(); render(); updateNav(); G.emit('uiOpen', U.current().name); } else U.close(); };
  U.close = function () {
    const top = stack[stack.length - 1];
    if (top && top.def.onClose) { try { top.def.onClose(top); } catch (e) { console.error(e); } }
    stack.length = 0;
    sheet.classList.remove('open');
    duck(false);
    updateNav();
    G.emit('uiOpen', 'map');
  };
  U.setFoot = function (children) { U.clear(sheetFoot); append(sheetFoot, children); };
  U.scrollTop = () => { sheetBody.scrollTop = 0; };
  let lastLive = 0;
  function render(keepScroll) {
    const top = stack[stack.length - 1];
    if (!top) return;
    const st = keepScroll ? sheetBody.scrollTop : 0;
    btnBack.style.display = stack.length > 1 ? '' : 'none';
    const t = typeof top.def.title === 'function' ? top.def.title(top.arg, top) : top.def.title;
    const s = typeof top.def.sub === 'function' ? top.def.sub(top.arg, top) : top.def.sub;
    sheetTitle.textContent = t || '';
    sheetSub.textContent = s || ''; sheetSub.classList.toggle('hidden', !s);
    U.clear(sheetBody); U.clear(sheetFoot);
    sheetBody.classList.toggle('nofx', !!keepScroll);
    try { top.def.render(sheetBody, top.arg, top); } catch (e) { console.error('[panel ' + top.name + ']', e); sheetBody.appendChild(h('div.hint.bad', 'Błąd ekranu: ' + e.message)); }
    if (top.def.foot) { try { append(sheetFoot, top.def.foot(top.arg, top)); } catch (e) { console.error(e); } }
    if (keepScroll) sheetBody.scrollTop = st;
    lastLive = performance.now();
  }
  U.rerender = () => render(true);
  U.refresh = U.rerender;
  // odświeżanie „na żywo” — tylko gdy nikt nie dotyka pól formularza
  let inputBusy = 0;
  document.addEventListener('pointerdown', e => { if (e.target.closest && e.target.closest('input,textarea,select,.nolive')) inputBusy = performance.now() + 1500; }, true);
  document.addEventListener('focusin', () => { inputBusy = performance.now() + 2500; });
  function liveTick(now) {
    const top = stack[stack.length - 1];
    if (!top || !top.def.live || !sheet.classList.contains('open')) return;
    if (now < inputBusy || (document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName))) return;
    const period = typeof top.def.live === 'number' ? top.def.live : 1000;
    if (now - lastLive > period) render(true);
  }
  // wyciszenie dźwięku przy otwartym panelu
  function duck(on) { try { if (G.sound && G.sound.duck) G.sound.duck(on); } catch (e) { /* brak */ } }

  // gest przeciągania arkusza (telefon): uchwyt lub nagłówek
  function sheetGestures() {
    const handle = sheet.querySelector('.sheet-handle'), head = sheet.querySelector('.sheet-head');
    let y0 = 0, h0 = 0, drag = false, moved = false;
    const down = e => { if (!U.isMobile()) return; drag = true; moved = false; y0 = e.clientY; h0 = sheet.getBoundingClientRect().height; sheet.classList.add('nosnap'); e.currentTarget.setPointerCapture(e.pointerId); };
    const move = e => {
      if (!drag) return;
      const dy = e.clientY - y0; if (Math.abs(dy) > 6) moved = true;
      const nh = Math.max(120, Math.min(window.innerHeight - 52, h0 - dy));
      sheet.style.height = nh + 'px';
    };
    const up = e => {
      if (!drag) return; drag = false; sheet.classList.remove('nosnap');
      const hh = sheet.getBoundingClientRect().height, H = window.innerHeight;
      sheet.style.height = '';
      if (!moved) { if (e.currentTarget === handle) sheet.classList.toggle('full'); return; }
      if (hh < H * 0.3) U.close();
      else sheet.classList.toggle('full', hh > H * 0.75);
    };
    for (const el of [handle, head]) { el.addEventListener('pointerdown', down); el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up); }
  }
  // chowanie arkusza na chwilę (np. wybór kafla na mapie)
  U.peek = function (on) { app.classList.toggle('sheet-hidden', !!on); };

  // ---------- okna modalne ----------
  // U.modal({ title, body (Node|string), actions: [{label, cls, onclick → false = nie zamykaj}], dismiss: true })
  U.modal = function (o) {
    U.clear(modal);
    const box = h('div.box.glass');
    if (o.title) box.appendChild(h('h3', o.title));
    const body = h('div.mbody'); if (typeof o.body === 'string') body.innerHTML = o.body; else append(body, o.body); box.appendChild(body);
    const acts = h('div.macts');
    for (const a of (o.actions || [{ label: 'OK', cls: 'primary' }])) acts.appendChild(h('button.btn' + (a.cls ? '.' + a.cls.split(' ').join('.') : ''), { onclick: () => { let r = true; if (a.onclick) r = a.onclick(); if (r !== false) U.closeModal(); } }, a.label));
    box.appendChild(acts);
    modal.appendChild(box);
    modal.classList.add('show');
    modal.onclick = e => { if (e.target === modal && o.dismiss !== false) U.closeModal(); };
    return { body, box };
  };
  U.closeModal = () => { modal.classList.remove('show'); U.clear(modal); };
  U.confirm = (title, text, okLabel, onOk, cls) => U.modal({ title, body: text, actions: [{ label: 'Anuluj', cls: 'ghost' }, { label: okLabel || 'Tak', cls: cls || 'primary', onclick: onOk }] });
  U.alert = (title, text) => U.modal({ title, body: text });
  // wynik akcji modułu → komunikat
  U.result = function (r, okText) {
    if (r && r.ok === false) { U.toast('🚫 ' + (r.reason || 'Nie udało się'), 'bad'); return false; }
    if (r === false || r === 0 || r == null) { if (okText !== null) U.toast('🚫 Nie udało się', 'bad'); return false; }
    if (okText) U.toast(okText, 'good');
    return true;
  };
  // tymczasowy toast lokalny (gdy nie ma potrzeby zapisywać do historii)
  U.toast = (text, kind) => G.notify(text, kind || 'info', { local: true });

  // ---------- kamera i wybór ----------
  const cam = { vx: 0, vy: 0, follow: null };
  U.cam = cam;
  U.centerOn = function (tx, ty, smooth) { cam.vx = cam.vy = 0; if (smooth) { cam.target = { tx, ty }; } else ISO.centerOn(tx, ty); };
  U.centerParcel = function (pid) { const p = G.S.parcels[pid]; if (p) U.centerOn(p.cx, p.cy, true); };
  U.centerTile = function (i) { U.centerOn(G.tx(i) + 0.5, G.ty(i) + 0.5, true); };
  U.flashTile = function (i) { const p = ISO.tileToScreen(G.tx(i) + 0.5, G.ty(i) + 0.5); const r = cv.getBoundingClientRect(); showTap(p.x + r.left, p.y + r.top); };
  function showTap(x, y) { tapMarker.style.left = x + 'px'; tapMarker.style.top = y + 'px'; tapMarker.classList.remove('show'); void tapMarker.offsetWidth; tapMarker.classList.add('show'); }

  // tryb interakcji: 'normal' | 'place' (stawianie budynku) | 'expand' (powiększanie podwórza) | 'drive'
  U.mode = 'normal';
  U.place = null; // { type, x, y, rot }
  U.sel = { vehicle: null };

  function canvasPt(e) { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  // najbliższy pojazd w promieniu r kafli (z G.machines.at, jeśli jest; inaczej z G.jobs.vehicles())
  U.vehicleAt = function (tx, ty, r) {
    r = r || 0.8;
    let best = null, bd = r;
    if (G.machines && G.machines.at) { try { const m = G.machines.at(tx, ty, r); if (m) return { uid: m.uid, machine: m, x: m.x, y: m.y, kind: 'parked', label: G.machines.label(m.uid) }; } catch (e) { /* brak */ } }
    for (const v of (U.call('jobs.vehicles', [], []) || [])) {
      if (v.inGarage) continue;
      const d = Math.hypot(v.x - tx, v.y - ty);
      if (d < bd) { bd = d; best = v; }
    }
    return best;
  };
  // ponowne odnalezienie zaznaczonego pojazdu (pozycje się zmieniają)
  U.findVehicle = function (sel) {
    if (!sel) return null;
    const vs = U.call('jobs.vehicles', [], []) || [];
    if (sel.uid != null) { const v = vs.find(x => x.uid === sel.uid); if (v) return v; const m = G.machines && G.machines.get && G.machines.get(sel.uid); if (m && m.x != null) return { uid: sel.uid, x: m.x, y: m.y, label: G.machines.label(sel.uid), kind: 'parked' }; return null; }
    if (sel.jobUid != null) return vs.find(x => x.jobUid === sel.jobUid && x.unit === sel.unit && (sel.k == null || x.k === sel.k)) || null;
    return null;
  };
  U.sameVehicle = (a, b) => !!a && !!b && (a.uid != null ? a.uid === b.uid : (a.jobUid === b.jobUid && a.unit === b.unit && (a.k == null || a.k === b.k)));
  // tryb wskazywania celu dla zaznaczonego pojazdu (przycisk „📍 Wskaż cel”)
  U.setTargetMode = function (on) {
    const bar = document.getElementById('placebar');
    if (on) {
      U.mode = 'target'; cv.classList.add('placing');
      U.clear(bar);
      bar.appendChild(h('div.row.between', h('div', h('b', '📍 Wskaż cel'), h('div.small.muted', 'Dotknij pola, budynku albo maszyny — pokażę dostępne polecenia')), h('button.btn.icon.ghost', { onclick: () => U.setTargetMode(false) }, '✕')));
      bar.classList.add('show');
      if (U.isMobile()) { const keep = U.sel.vehicle, gv = G.view.selVehicle; U.close(); U.sel.vehicle = keep; G.view.selVehicle = gv; G.view.selVehicleUid = keep ? keep.uid : null; }
    } else if (U.mode === 'target') { U.mode = 'normal'; cv.classList.remove('placing'); bar.classList.remove('show'); }
  };
  U.selectVehicle = function (v, open) {
    U.sel.vehicle = v ? { uid: v.uid, jobUid: v.jobUid, unit: v.unit, k: v.k, label: v.label } : null;
    G.view.selVehicle = U.sel.vehicle ? Object.assign({}, U.sel.vehicle, { x: v.x, y: v.y }) : null;
    G.view.selVehicleUid = v && v.uid != null ? v.uid : null;
    if (v && open !== false) U.open('vehicle', U.sel.vehicle, { push: true });
  };
  U.selectParcel = function (pid, open) {
    G.view.selParcel = pid;
    G.view.selBuilding = null;
    U.sel.vehicle = null; G.view.selVehicle = null; G.view.selVehicleUid = null;
    if (open !== false) U.open('parcel', pid, { push: true });
  };
  U.selectBuilding = function (b, open) {
    G.view.selBuilding = b ? b.uid : null;
    G.view.selParcel = -1;
    U.sel.vehicle = null; G.view.selVehicle = null;
    if (b && open !== false) U.open('building', b.uid, { push: true });
  };
  U.clearSelection = function () { G.view.selParcel = -1; G.view.selBuilding = null; U.sel.vehicle = null; G.view.selVehicle = null; G.view.selVehicleUid = null; G.view.highlight = []; };

  // dotknięcie mapy (sx, sy — piksele płótna)
  function tapAt(sx, sy, button) {
    const i = ISO.pick(sx, sy);
    const f = ISO.screenToTileF(sx, sy);
    const r = cv.getBoundingClientRect(); showTap(sx + r.left, sy + r.top);
    if (U.mode === 'place' && U.place) { if (i >= 0) { U.place.x = G.tx(i); U.place.y = G.ty(i); U.updatePlace(); } return; }
    if (U.mode === 'expand') { if (i >= 0) U.emitExpand(i); return; }
    if (U.mode === 'drive') return;
    if (G.tutorial && G.tutorial.onTap) { try { G.tutorial.onTap(i); } catch (e) { /* brak */ } }
    // zaznaczony pojazd + dotknięcie celu → domyślna akcja (gdy moduł sterowania istnieje)
    const selV = U.sel.vehicle && U.findVehicle(U.sel.vehicle);
    const vNear = U.vehicleAt(f.tx, f.ty, 0.8);
    // tryb „wskaż cel” (z karty pojazdu) albo prawy klik → menu poleceń dla zaznaczonego pojazdu
    if (selV && selV.uid != null && i >= 0 && (U.mode === 'target' || (button === 2 && !(vNear && vNear.uid !== selV.uid)))) {
      U.setTargetMode(false);
      U.vehicleMenu(selV, i, sx, sy); return;
    }
    if (U.mode === 'target') U.setTargetMode(false);
    if (vNear && !(selV && U.sameVehicle(vNear, selV))) { U.sfx('ui_select'); U.selectVehicle(vNear); return; }
    if (vNear && selV) { U.open('vehicle', U.sel.vehicle, { push: true }); return; }
    if (i < 0) { U.clearSelection(); if (U.isMobile()) U.close(); return; }
    const b = G.buildings && G.buildings.at ? G.buildings.at(i) : null;
    if (b) { U.sfx('ui_select'); U.selectBuilding(b); return; }
    const pid = G.S.map.parcel[i];
    if (pid >= 0) { U.sfx('ui_select'); U.selectParcel(pid); return; }
    U.clearSelection();
    if (U.isMobile() && stack.length && stack[stack.length - 1].def.mapClose !== false) U.close();
  }

  // ---------- wejście: palce / mysz ----------
  const ptrs = new Map();
  let gesture = null;   // { mode:'pan'|'pinch', x, y, t, moved, vx, vy, lastT, startX, startY, lpTimer, pid }
  let pinch0 = null;
  function startLongPress(e, sx, sy) {
    cancelLongPress();
    if (e.pointerType === 'mouse' || U.mode === 'place' || U.mode === 'expand') return;
    const selV = U.sel.vehicle && U.findVehicle(U.sel.vehicle);
    const f0 = ISO.screenToTileF(sx, sy);
    const under = U.vehicleAt(f0.tx, f0.ty, 0.8);
    // bez zaznaczonego pojazdu długie przytrzymanie na pojeździe = wybór; z zaznaczonym = menu poleceń
    if (!selV && !under) return;
    const g = gesture;
    g.lpTimer = setTimeout(() => {
      if (gesture !== g || g.moved) return;
      const i = ISO.pick(sx, sy);
      g.consumed = true;
      U.haptic(20);
      lpRing.classList.remove('show');
      if (!selV || (under && under.uid !== selV.uid && !(G.machines && G.machines.actions))) { if (under) { U.sfx('ui_select'); U.selectVehicle(under); } return; }
      if (i < 0) return;
      U.vehicleMenu(selV, i, sx, sy);
    }, 450);
    lpRing.style.left = e.clientX + 'px'; lpRing.style.top = e.clientY + 'px';
    lpRing.classList.remove('show'); void lpRing.offsetWidth; lpRing.classList.add('show');
  }
  function cancelLongPress() { if (gesture && gesture.lpTimer) { clearTimeout(gesture.lpTimer); gesture.lpTimer = null; } lpRing.classList.remove('show'); }

  function onDown(e) {
    if (U.mode === 'drive') return;
    cv.setPointerCapture(e.pointerId);
    const p = canvasPt(e);
    ptrs.set(e.pointerId, p);
    U.hideCtx();
    if (ptrs.size === 1) {
      gesture = { mode: 'pan', x: p.x, y: p.y, startX: p.x, startY: p.y, t: performance.now(), lastT: performance.now(), moved: false, vx: 0, vy: 0, button: e.button, pid: e.pointerId, consumed: false };
      cam.vx = cam.vy = 0; cam.target = null; cam.follow = null;
      // przeciąganie „ducha” budynku
      if (U.mode === 'place' && U.place) {
        const i = ISO.pick(p.x, p.y);
        if (i >= 0 && inPlace(i)) gesture.dragPlace = { dx: G.tx(i) - U.place.x, dy: G.ty(i) - U.place.y };
      }
      startLongPress(e, p.x, p.y);
    } else if (ptrs.size === 2) {
      cancelLongPress();
      const [a, b] = [...ptrs.values()];
      pinch0 = { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
      gesture = { mode: 'pinch', moved: true, consumed: true };
    }
    cv.classList.add('dragging');
  }
  function onMove(e) {
    const p = canvasPt(e);
    if (U.mode !== 'drive' && e.pointerType === 'mouse' && !ptrs.size) {
      G.view.hover = ISO.pick(p.x, p.y);
      if (U.mode === 'place' && U.place && !gesture) { const i = G.view.hover; if (i >= 0) { U.place.x = G.tx(i); U.place.y = G.ty(i); U.updatePlace(); } }
    }
    if (!ptrs.has(e.pointerId)) return;
    ptrs.set(e.pointerId, p);
    if (!gesture) return;
    if (gesture.mode === 'pan') {
      const dx = p.x - gesture.x, dy = p.y - gesture.y;
      if (!gesture.moved && Math.hypot(p.x - gesture.startX, p.y - gesture.startY) > 8) { gesture.moved = true; cancelLongPress(); }
      if (!gesture.moved) return;
      if (gesture.dragPlace) {
        const i = ISO.pick(p.x, p.y);
        if (i >= 0) { U.place.x = G.tx(i) - gesture.dragPlace.dx; U.place.y = G.ty(i) - gesture.dragPlace.dy; U.updatePlace(); }
      } else {
        ISO.pan(dx, dy);
        const now = performance.now(), dt = Math.max(1, now - gesture.lastT);
        gesture.vx = 0.7 * gesture.vx + 0.3 * (dx / dt * 16); gesture.vy = 0.7 * gesture.vy + 0.3 * (dy / dt * 16);
        gesture.lastT = now;
      }
      gesture.x = p.x; gesture.y = p.y;
    } else if (gesture.mode === 'pinch' && ptrs.size >= 2) {
      const [a, b] = [...ptrs.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y), cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      if (pinch0 && pinch0.d > 0) { ISO.zoomAt(d / pinch0.d, cx, cy); ISO.pan(cx - pinch0.cx, cy - pinch0.cy); }
      pinch0 = { d, cx, cy };
    }
  }
  function onUp(e) {
    const had = ptrs.has(e.pointerId);
    ptrs.delete(e.pointerId);
    if (!had) return;
    try { cv.releasePointerCapture(e.pointerId); } catch (err) { /* brak */ }
    if (gesture && gesture.mode === 'pan' && gesture.pid === e.pointerId) {
      cancelLongPress();
      const p = canvasPt(e);
      if (!gesture.moved && !gesture.consumed && e.type !== 'pointercancel') {
        if (performance.now() - gesture.t < 600) tapAt(p.x, p.y, gesture.button);
      } else if (gesture.moved && !gesture.dragPlace && performance.now() - gesture.lastT < 80) { cam.vx = gesture.vx; cam.vy = gesture.vy; }
      gesture = null;
    } else if (gesture && gesture.mode === 'pinch') {
      if (ptrs.size < 2) { gesture = null; pinch0 = null; if (ptrs.size === 1) { const [q] = [...ptrs.values()]; gesture = { mode: 'pan', x: q.x, y: q.y, startX: q.x, startY: q.y, t: 0, lastT: performance.now(), moved: true, vx: 0, vy: 0, consumed: true, pid: [...ptrs.keys()][0] }; } }
    }
    if (!ptrs.size) cv.classList.remove('dragging');
  }
  function onWheel(e) {
    e.preventDefault();
    if (U.mode === 'drive') return;
    const p = canvasPt(e);
    ISO.zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, p.x, p.y);
  }
  function inPlace(i) {
    if (!U.place) return false;
    const T = G.BUILDINGS[U.place.type], w = U.place.rot ? T.size[1] : T.size[0], hh = U.place.rot ? T.size[0] : T.size[1];
    const x = G.tx(i), y = G.ty(i);
    return x >= U.place.x && x < U.place.x + w && y >= U.place.y && y < U.place.y + hh;
  }

  // ---------- klawiatura ----------
  const keys = new Set();
  function onKey(e, down) {
    const t = e.target;
    if (t && /INPUT|TEXTAREA|SELECT/.test(t.tagName)) return;
    const k = e.key.toLowerCase();
    if (down) {
      if (k === 'escape') { if (modal.classList.contains('show')) U.closeModal(); else if (U.mode === 'place' || U.mode === 'expand') U.cancelPlace(); else if (U.mode === 'target') U.setTargetMode(false); else if (U.mode === 'drive') { if (G.ui.driveExit) G.ui.driveExit(); } else U.hideCtx() || U.close(); return; }
      if (U.mode === 'drive') { keys.add(k); e.preventDefault(); return; }
      if (k === ' ') { e.preventDefault(); U.togglePause(); return; }
      if (k === '+' || k === '=') { ISO.zoomAt(1.2, G.cam.vw / 2, G.cam.vh / 2); return; }
      if (k === '-' || k === '_') { ISO.zoomAt(1 / 1.2, G.cam.vw / 2, G.cam.vh / 2); return; }
      if (k === 'r' && U.mode === 'place' && U.place) { U.place.rot = U.place.rot ? 0 : 1; U.updatePlace(); return; }
      if (k === 'enter' && U.mode === 'place') { U.confirmPlace(); return; }
      if (/^[1-4]$/.test(k)) { const s = G.CFG.SPEEDS[+k - 1]; if (s != null) G.setSpeed(s); return; }
      if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) { keys.add(k); e.preventDefault(); }
    } else keys.delete(k);
  }
  let lastSpeed = 1;
  U.togglePause = function () { if (G.speed === 0) G.setSpeed(lastSpeed || 1); else { lastSpeed = G.speed; G.setSpeed(0); } };
  G.on('speed', s => { if (s > 0) lastSpeed = s; });

  // ---------- menu akcji pojazdu (G.machines.actions — atrapa, jeśli brak) ----------
  const ctx = () => document.getElementById('ctxmenu');
  U.hideCtx = function () { const c = ctx(); const was = !c.classList.contains('hidden'); c.classList.add('hidden'); U.clear(c); G.view.highlight = []; return was; };
  U.vehicleMenu = function (v, tileIdx, sx, sy) {
    if (!(G.machines && G.machines.actions) || v.uid == null) { U.toast('Sterowanie pojazdami — wkrótce', 'info'); return; }
    let acts = [];
    try { acts = G.machines.actions(v.uid, tileIdx) || []; } catch (e) { console.error(e); }
    if (!acts.length) { U.toast('Brak akcji dla tego celu', 'info'); return; }
    G.view.highlight = [tileIdx];
    const c = ctx(); U.clear(c);
    const pc = G.parcelAt(tileIdx), b = G.buildings && G.buildings.at && G.buildings.at(tileIdx);
    c.appendChild(h('div.hd', (v.label || 'Pojazd') + ' → ' + (b ? G.BUILDINGS[b.type].name : pc ? pc.name : 'kafel ' + G.tx(tileIdx) + ',' + G.ty(tileIdx))));
    for (const a of acts) c.appendChild(h('button', { disabled: a.enabled === false, onclick: () => { U.hideCtx(); U.runAction(v, a.id, tileIdx); } }, h('span.ico', a.icon || '▶️'), h('span', a.label, a.enabled === false && a.reason ? h('span.why', a.reason) : null)));
    c.classList.remove('hidden');
    const r = cv.getBoundingClientRect(), W = window.innerWidth, H = window.innerHeight, cw = Math.min(300, W - 20);
    let x = sx + r.left + 8, y = sy + r.top + 8;
    const chh = c.getBoundingClientRect().height || 200;
    if (x + cw > W - 8) x = Math.max(8, sx + r.left - cw - 8);
    if (y + chh > H - 8) y = Math.max(8, H - chh - 8);
    c.style.left = x + 'px'; c.style.top = y + 'px';
  };
  U.runAction = function (v, id, tileIdx, params) {
    try {
      // akcje z wyborem (kierowca, uprawa do siewu, nawóz) — najpierw zapytaj gracza
      if (params == null && G.ui.askParams) {
        let a = null;
        try { a = (G.machines.actions(v.uid, tileIdx) || []).find(x => x.id === id); } catch (e) { a = null; }
        if (a && id === 'assign_driver' && a.choices && a.choices.length) {
          G.ui.askParams({ key: 'worker', title: '👤 Kierowca', label: 'Kto ma prowadzić?', choices: a.choices }, p => U.runAction(v, id, tileIdx, p));
          return;
        }
        if (a && a.needParams) { G.ui.askParams(a.needParams, p => U.runAction(v, id, tileIdx, p)); return; }
      }
      const r = G.machines.command(v.uid, id, tileIdx, params || {});
      if (r && r.needParams && G.ui.askParams) { G.ui.askParams(r.needParams, p => U.runAction(v, id, tileIdx, p)); return; }
      if (U.result(r, null)) { G.view.highlight = tileIdx != null ? [tileIdx] : []; U.sfx('ui_confirm'); if (id === 'drive' && G.ui.driveStart) G.ui.driveStart(v.uid); }
    } catch (e) { console.error(e); U.toast('🚫 Błąd polecenia', 'bad'); }
  };
  U.defaultAction = function (v, tileIdx) {
    try {
      const acts = (G.machines.actions(v.uid, tileIdx) || []).filter(a => a.enabled !== false);
      const a = acts.find(x => x.default) || acts[0];
      if (!a) return false;
      U.runAction(v, a.id, tileIdx);
      return true;
    } catch (e) { return false; }
  };

  // ---------- tryb stawiania budynku ----------
  U.startPlace = function (type) {
    const T = G.BUILDINGS[type]; if (!T) return;
    const y = G.S.farm.yard;
    U.mode = 'place'; cv.classList.add('placing');
    U.place = { type, x: y.x + Math.floor((y.w - T.size[0]) / 2), y: y.y + Math.floor((y.h - T.size[1]) / 2), rot: 0 };
    // znajdź wolne miejsce na podwórzu
    outer: for (let yy = y.y; yy < y.y + y.h; yy++) for (let xx = y.x; xx < y.x + y.w; xx++) { if (G.buildings.canPlace(type, xx, yy, 0, true).ok) { U.place.x = xx; U.place.y = yy; break outer; } }
    U.close(); U.centerOn(y.x + y.w / 2, y.y + y.h / 2, true);
    U.updatePlace();
  };
  U.updatePlace = function () {
    const bar = document.getElementById('placebar');
    if (U.mode === 'place' && U.place) {
      const p = U.place, c = G.buildings.canPlace(p.type, p.x, p.y, p.rot);
      G.view.place = { type: p.type, x: p.x, y: p.y, rot: p.rot, valid: c.ok };
      const T = G.BUILDINGS[p.type];
      U.clear(bar);
      bar.appendChild(h('div.row.between', h('div', h('b', T.name), h('div.small.muted', T.size[0] + '×' + T.size[1] + ' kafli · ' + G.fmtMoney(T.price) + ' · ' + T.buildDays + ' dni budowy')), h('button.btn.icon.ghost', { onclick: U.cancelPlace, title: 'Anuluj' }, '✕')));
      bar.appendChild(h('div.status' + (c.ok ? '.ok' : '.no'), c.ok ? '✅ Można budować tutaj — przeciągnij, aby przesunąć' : '⛔ ' + c.reason));
      bar.appendChild(h('div.row', h('button.btn', { onclick: () => { p.rot = p.rot ? 0 : 1; U.updatePlace(); } }, '↻ Obróć'), h('button.btn.primary' + (c.ok ? '' : '.disabled'), { disabled: !c.ok, onclick: U.confirmPlace }, '🏗️ Buduj za ' + G.fmtMoney(T.price))));
      bar.classList.add('show');
    } else if (U.mode === 'expand') {
      U.clear(bar);
      bar.appendChild(h('div.row.between', h('div', h('b', 'Powiększanie podwórza'), h('div.small.muted', 'Dotknij kafel trawy/pola przylegający do podwórza')), h('button.btn.icon.ghost', { onclick: U.cancelPlace }, '✕')));
      bar.classList.add('show');
    } else { bar.classList.remove('show'); G.view.place = null; }
  };
  U.confirmPlace = function () {
    if (!U.place) return;
    const p = U.place, c = G.buildings.canPlace(p.type, p.x, p.y, p.rot);
    if (!c.ok) { U.toast('🚫 ' + c.reason, 'bad'); return; }
    const b = G.buildings.place(p.type, p.x, p.y, p.rot);
    if (b) { U.sfx('build'); U.haptic(15); U.cancelPlace(); if (G.tutorial && G.tutorial.event) G.tutorial.event('built'); }
  };
  U.cancelPlace = function () { U.mode = 'normal'; U.place = null; cv.classList.remove('placing'); G.view.place = null; U.updatePlace(); };
  U.startExpand = function () { U.mode = 'expand'; cv.classList.add('placing'); U.close(); const y = G.S.farm.yard; U.centerOn(y.x + y.w / 2, y.y + y.h / 2, true); U.updatePlace(); };
  U.emitExpand = function (i) {
    const x = G.tx(i), y = G.ty(i), c = G.buildings.canExpand(x, y);
    if (!c.ok) { U.toast('🚫 ' + c.reason, 'bad'); return; }
    U.confirm('Powiększyć podwórze?', c.note + '. Koszt: ' + G.fmtMoney(c.cost) + '.', 'Utwardź za ' + G.fmtMoney(c.cost), () => { const r = G.buildings.expandYard(x, y); if (U.result(r, '🧱 Podwórze powiększone')) U.haptic(); });
  };

  // ---------- pętla ----------
  let hudTimer = 0;
  U.update = function (now, dt) {
    // bezwładność
    if (!ptrs.size && (Math.abs(cam.vx) > 0.1 || Math.abs(cam.vy) > 0.1)) {
      ISO.pan(cam.vx, cam.vy);
      const f = Math.pow(0.9, dt * 60); cam.vx *= f; cam.vy *= f;
    }
    // płynne dośrodkowanie
    if (cam.target) {
      const w = ISO.toWorld(cam.target.tx, cam.target.ty), c = G.cam;
      const gx = w.x - c.vw / 2 / c.zoom, gy = w.y - c.vh / 2 / c.zoom;
      const k = Math.min(1, dt * 7);
      c.x += (gx - c.x) * k; c.y += (gy - c.y) * k; ISO.clamp();
      if (Math.hypot(gx - c.x, gy - c.y) < 0.5) cam.target = null;
    }
    // klawiatura
    if (keys.size && U.mode !== 'drive') {
      const s = 600 * dt;
      let dx = 0, dy = 0;
      if (keys.has('w') || keys.has('arrowup')) dy += s; if (keys.has('s') || keys.has('arrowdown')) dy -= s;
      if (keys.has('a') || keys.has('arrowleft')) dx += s; if (keys.has('d') || keys.has('arrowright')) dx -= s;
      if (dx || dy) ISO.pan(dx, dy);
    }
    // śledzenie pojazdu
    if (cam.follow) { const v = U.findVehicle(cam.follow); if (v) { const w = ISO.toWorld(v.x, v.y), c = G.cam; const gx = w.x - c.vw / 2 / c.zoom, gy = w.y - c.vh / 2 / c.zoom; const k = Math.min(1, dt * 5); c.x += (gx - c.x) * k; c.y += (gy - c.y) * k; ISO.clamp(); } }
    // zaznaczony pojazd → aktualna pozycja dla grafiki
    if (U.sel.vehicle) { const v = U.findVehicle(U.sel.vehicle); if (v) { G.view.selVehicle = Object.assign({}, U.sel.vehicle, { x: v.x, y: v.y }); } }
    if (now - hudTimer > 200) { hudTimer = now; if (G.ui.hudTick) G.ui.hudTick(now); }
    liveTick(now);
    if (G.ui.driveTick && U.mode === 'drive') G.ui.driveTick(now, dt, keys);
    if (G.ui.toastTick) G.ui.toastTick(now);
  };
  U.keys = keys;

  // ---------- start ----------
  G.on('boot', () => {
    buildLayout();
    G.render.init(cv);
    G.view = Object.assign({ hover: -1, selParcel: -1, highlight: [], place: null, selBuilding: null, selVehicle: null }, G.view || {});
    const y = G.S.farm.yard; ISO.centerOn(y.x + y.w / 2, y.y + y.h / 2);
    cv.addEventListener('pointerdown', onDown);
    cv.addEventListener('pointermove', onMove);
    cv.addEventListener('pointerup', onUp);
    cv.addEventListener('pointercancel', onUp);
    cv.addEventListener('pointerleave', () => { G.view.hover = -1; });
    cv.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', e => onKey(e, true));
    window.addEventListener('keyup', e => onKey(e, false));
    window.addEventListener('blur', () => keys.clear());
    // pierwsze dotknięcie odblokowuje dźwięk
    const unlock = () => { try { if (G.sound && G.sound.unlock) G.sound.unlock(); } catch (e) { /* brak */ } };
    window.addEventListener('pointerdown', unlock, { once: true });
    // po wczytaniu gry wybór znika
    G.on('load', () => { U.clearSelection(); U.cancelPlace(); if (sheet.classList.contains('open')) U.close(); });
    // panel „Więcej”
    U.panel('more', {
      title: 'Więcej', render(body) {
        const grid = h('div.grid2');
        for (const m of U.MORE) grid.appendChild(h('button.card.clickable', { onclick: () => U.open(m.id, null, { replace: true }), style: { textAlign: 'left', color: 'inherit', minHeight: '76px' } }, h('div.row', h('span.ico-big', m.icon), h('div', h('div.b', m.label), h('div.small.muted', m.desc)))));
        body.appendChild(grid);
        body.appendChild(h('div.hint', 'Wskazówka: na mapie dotknij pola, budynku albo pojazdu, żeby zobaczyć szczegóły. Dwa palce — zoom.'));
      }
    });
  });
})();
