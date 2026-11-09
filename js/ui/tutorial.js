// Złote Pola — ekran tytułowy, samouczek krok po kroku i poradnik „Jak grać” (agent: UI/UX)
// API: G.tutorial = { showTitle(), hideTitle(), start(force), stop(done), active(), event(name, data), onTap(i) }
(function () {
  const U = G.ui, h = U.h;
  const T = G.tutorial = {};
  let loadedAtBoot = null;

  // =====================================================================================================
  // EKRAN TYTUŁOWY
  // =====================================================================================================
  let titleSpeed = 1;
  function buildTitle() {
    const el = document.getElementById('title');
    U.clear(el);
    el.appendChild(h('div.sun'));
    el.appendChild(h('div.haze'));
    el.appendChild(h('div.birds', '〰 ︶ 〰'));
    // łan zboża: źdźbła o losowej wysokości i fazie kołysania (tylko transform → płynnie na telefonie)
    const wheat = h('div.wheat');
    el.appendChild(h('div.field'));
    const n = Math.min(90, Math.round(window.innerWidth / 6));
    for (let k = 0; k < n; k++) {
      const x = (k / n) * 104 - 2 + (Math.sin(k * 12.9898) * 0.5 + 0.5) * 1.5;
      const hh = 34 + ((Math.sin(k * 78.233) * 0.5 + 0.5) * 46);
      wheat.appendChild(h('i.stalk', { style: { left: x + '%', height: hh + '%', animationDelay: (-(k * 0.37) % 3.2).toFixed(2) + 's', animationDuration: (2.6 + (k % 5) * 0.25) + 's', opacity: (0.75 + (k % 3) * 0.12).toFixed(2) } }));
    }
    el.appendChild(wheat);
    const meta = G.storage && G.storage.meta ? G.storage.meta('auto') : null;
    const hasSave = !!(meta && !meta.broken);
    const menu = h('div.menu');
    if (hasSave) menu.appendChild(h('button.btn.primary.big', { onclick: () => { U.sfx('ui_confirm'); T.hideTitle(); } }, '▶️ Kontynuuj', h('span.sub', meta.date + ' · ' + G.fmtMoney(meta.money))));
    menu.appendChild(h('button.btn.big' + (hasSave ? '' : '.primary'), { onclick: () => newGame(hasSave) }, '🌱 Nowa gra', h('span.sub', 'gospodarstwo po dziadku')));
    menu.appendChild(h('button.btn.big', { onclick: () => { T.hideTitle(); U.open('help'); } }, '❓ Jak grać'));
    el.appendChild(h('div.content',
      h('div.logo', h('span.ico', '🌾'), h('h1', 'Złote Pola'), h('p', 'Gospodarstwo, które sam zbudujesz')),
      menu));
    el.appendChild(h('div.ver', 'v' + G.VERSION));
  }
  function newGame(confirmIt) {
    const go = () => {
      G.newGame(); try { G.storage.save('auto'); } catch (e) { /* brak */ }
      const y = G.S.farm.yard; U.centerOn(y.x + y.w / 2, y.y + y.h / 2);
      T.hideTitle(true);
      U.toast('🌅 Witaj w gospodarstwie po dziadku!', 'good');
      setTimeout(() => T.start(true), 500);
    };
    if (confirmIt) U.confirm('Zacząć od nowa?', 'Autozapis obecnej gry zostanie nadpisany. Jeśli chcesz ją zachować, zapisz ją najpierw w slocie (Ustawienia → Zapis gry).', 'Nowa gra', go, 'danger');
    else go();
  }
  T.showTitle = function () {
    buildTitle();
    if (G.speed > 0) titleSpeed = G.speed;
    G.setSpeed(0);
    document.getElementById('title').classList.add('show');
    T.stop(false, true);
  };
  T.hideTitle = function (keepPaused) {
    const el = document.getElementById('title');
    if (!el.classList.contains('show')) return;
    el.classList.add('out');
    setTimeout(() => { el.classList.remove('show', 'out'); U.clear(el); }, 420);
    if (!keepPaused) G.setSpeed(titleSpeed || 1);
    try { if (G.sound && G.sound.unlock) G.sound.unlock(); } catch (e) { /* brak */ }
  };
  T.titleVisible = () => document.getElementById('title').classList.contains('show');

  // =====================================================================================================
  // SAMOUCZEK
  // =====================================================================================================
  const q = s => document.querySelector(s);
  function firstField() {
    const ps = G.playerParcels().filter(p => p.kind === 'field');
    let best = null, bs = -1;
    for (const p of ps) { const s = G.fields.summary(p.id); const sc = (s.next || []).filter(r => r.op).length * 2 + (s.next.some(r => r.op && r.ok) ? 3 : 0); if (sc > bs) { bs = sc; best = p; } }
    return best || G.playerParcels()[0] || null;
  }
  const STEPS = [
    { icon: '🌾', title: 'Witaj w Złotych Polach!', text: 'Dziadek zostawił Ci małe gospodarstwo: dom, stodołę, garaż ze starym ciągnikiem, kilka kur i dwa pola. Twoim zadaniem jest zrobić z niego dochodową farmę.', clear: false },
    { icon: '⏱️', title: 'Czas i pieniądze', target: () => q('#hud'), text: 'U góry widzisz datę, pogodę i stan konta. Tempo gry: ⏸ pauza, 1×, 3×, 8×. Teraz gra stoi — spokojnie czytaj.' },
    { icon: '👆', title: 'Dotknij swojego pola', text: 'Twoje pole jest podświetlone. Dotknij go, żeby zobaczyć stan uprawy i zalecenia.', wait: 'open:parcel', clear: true,
      enter() { U.close(); const p = firstField(); if (p) { U.centerParcel(p.id); G.view.highlight = p.tiles.slice(); } },
      leave() { G.view.highlight = []; } },
    { icon: '📋', title: 'Zalecenia', target: () => q('#sheet .rec-btn:not(.off)') || q('#sheet .sheet-body'), text: 'Panel pola: uprawa, gleba, prognoza plonu i jakości. Złote przyciski to zalecane zabiegi — dotknij jednego, żeby go zlecić.', wait: 'open:planner', top: true },
    { icon: '📞', title: 'Zleć zabieg', target: () => q('#sheet'), text: 'Ustaw parametry i wybierz wykonawcę — na start najprościej usługa z własnym sprzętem. Na końcu dotknij „Zleć”.', wait: 'jobCreated', top: true, small: true },
    { icon: '▶️', title: 'Puść czas', target: () => q('#speed'), text: 'Włącz tempo 1× albo 3× — maszyny wyjadą na pole. Postęp prac zobaczysz w przycisku 📋 Prace nad nawigacją.', wait: 'speed' },
    { icon: '💰', title: 'Sprzedawaj plony', target: () => q('#nav [data-nav="market"]'), text: 'Po żniwach sprzedasz zboże w Rynku. Ceny zmieniają się codziennie, a klasa jakości ziarna (konsumpcyjne / paszowe) wpływa na cenę. Możesz też podpisać umowy kontraktacji.' },
    { icon: '🏗️', title: 'Rozbudowuj', target: () => q('#nav [data-nav="build"]'), text: 'W Budowie postawisz magazyny, silosy, oborę czy chlewnię. Wybierz budynek, przeciągnij podgląd po podwórzu i dotknij „Buduj”.' },
    { icon: '💡', title: 'Doradca', target: () => q('#fab-advisor'), text: 'Nie wiesz, co teraz? Doradca podpowie pilne zabiegi, braki w magazynie, dobre ceny i terminy. Powodzenia, gospodarzu!', last: true }
  ];
  let idx = -1, timer = 0, spot = null, bubble = null;
  T.active = () => idx >= 0;
  T.start = function (force) {
    const st = U.pref.get('tut', {});
    if (st.done && !force) return;
    idx = -1; U.pref.set('tut', { done: false });
    const el = document.getElementById('tut');
    U.clear(el);
    spot = h('div.spot'); bubble = h('div.bubble.glass');
    el.appendChild(spot); el.appendChild(bubble);
    el.classList.add('show');
    G.setSpeed(0);
    clearInterval(timer); timer = setInterval(place, 250);
    goto(0);
  };
  T.stop = function (done, silent) {
    if (idx < 0 && !done) return;
    const s = STEPS[idx]; if (s && s.leave) { try { s.leave(); } catch (e) { /* brak */ } }
    idx = -1; clearInterval(timer);
    const el = document.getElementById('tut'); el.classList.remove('show'); U.clear(el);
    if (done !== false) U.pref.set('tut', { done: true });
    if (!silent && done) U.toast('🎓 Samouczek zakończony. Poradnik znajdziesz w Więcej → Jak grać.', 'good');
  };
  function goto(k) {
    const old = STEPS[idx]; if (old && old.leave) { try { old.leave(); } catch (e) { /* brak */ } }
    if (k >= STEPS.length) { T.stop(true); return; }
    idx = k;
    const s = STEPS[k];
    if (s.enter) { try { s.enter(); } catch (e) { console.error(e); } }
    U.clear(bubble);
    bubble.appendChild(h('div.steps', 'Samouczek · ' + (k + 1) + ' / ' + STEPS.length));
    bubble.appendChild(h('h3', h('span', s.icon), s.title));
    bubble.appendChild(h('p', s.text));
    const row = h('div.row');
    row.appendChild(h('button.btn.sm.ghost', { onclick: () => T.stop(true, true) }, 'Pomiń samouczek'));
    if (s.wait) row.appendChild(h('button.btn.sm', { onclick: () => goto(idx + 1) }, 'Pomiń krok ›'));
    else row.appendChild(h('button.btn.sm.primary', { onclick: () => { U.sfx('ui_tap'); goto(idx + 1); } }, s.last ? '🎉 Zaczynam!' : 'Dalej ›'));
    bubble.appendChild(row);
    if (s.wait) bubble.appendChild(h('div.tiny.gold.pulse', { style: { marginTop: '8px', fontWeight: 700 } }, '👆 Zrób to, aby przejść dalej'));
    bubble.style.animation = 'none'; void bubble.offsetWidth; bubble.style.animation = '';
    place();
  }
  // pozycjonowanie podświetlenia i dymka
  function place() {
    if (idx < 0 || !spot) return;
    const s = STEPS[idx], W = window.innerWidth, H = window.innerHeight;
    if (T.titleVisible()) { spot.style.opacity = 0; bubble.style.visibility = 'hidden'; return; }
    bubble.style.visibility = '';
    const el = s.target ? s.target() : null;
    const r = el && el.getBoundingClientRect();
    const valid = r && r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < H;
    spot.classList.toggle('none', !valid && !s.clear);
    spot.classList.toggle('clear', !!s.clear);
    spot.style.opacity = 1;
    if (valid) {
      const pad = 6;
      Object.assign(spot.style, { left: (r.left - pad) + 'px', top: (r.top - pad) + 'px', width: (r.width + pad * 2) + 'px', height: (r.height + pad * 2) + 'px' });
    } else Object.assign(spot.style, { left: W / 2 + 'px', top: H / 2 + 'px', width: '0px', height: '0px' });
    // dymek: nad lub pod celem; panel otwarty → u góry ekranu
    const bh = bubble.getBoundingClientRect().height || 160;
    const navH = (q('#nav') && q('#nav').getBoundingClientRect().height) || 60;
    let top;
    if (s.top || (valid && (r.top + r.height / 2) > H * 0.5)) top = valid && !s.top ? Math.max(8, r.top - bh - 14) : Math.max(8, (q('#hud') ? q('#hud').getBoundingClientRect().bottom : 60) + 8);
    else if (valid) top = Math.min(H - bh - navH - 12, r.bottom + 14);
    else top = s.clear ? (q('#hud') ? q('#hud').getBoundingClientRect().bottom + 8 : 100) : Math.max(8, H * 0.5 - bh / 2);
    if (s.small && valid && r.top < H * 0.5) top = Math.max(8, r.top - bh - 10);
    // panel zajmuje dół ekranu — dymek nad panelem
    const sh = q('#sheet.open'); if (sh && s.top && U.isMobile()) { const sr = sh.getBoundingClientRect(); top = Math.max(8, Math.min(top, sr.top - bh - 10)); }
    bubble.style.top = Math.round(top) + 'px';
  }
  T.event = function (name, data) {
    if (idx < 0) return;
    const s = STEPS[idx];
    if (s && s.wait === name) { U.haptic(10); setTimeout(() => goto(idx + 1), name.startsWith('open:') ? 450 : 200); }
    void data;
  };
  T.onTap = function () { /* dotknięcie mapy — kroki czekają na otwarcie panelu */ };
  G.on('uiOpen', name => T.event('open:' + name));
  G.on('speed', s => { if (s > 0) T.event('speed'); });
  window.addEventListener('resize', () => place());

  // =====================================================================================================
  // POMOC — JAK GRAĆ
  // =====================================================================================================
  const GUIDE = [
    ['🖐️', 'Sterowanie', ['Jeden palec — przesuwanie mapy, dwa palce — przybliżenie. Na komputerze: przeciąganie myszą, kółko, WASD/strzałki, + i −.', 'Dotknij pola, budynku lub pojazdu, żeby zobaczyć szczegóły. Długie przytrzymanie (prawy klik) przy zaznaczonym pojeździe otwiera menu poleceń.', 'Spacja — pauza, klawisze 1–4 — tempo gry.']],
    ['🌱', 'Sezon w polu', ['Wiosną: saletra na oziminy, uprawa i siew jarych (jęczmień, owies, kukurydza, buraki, ziemniaki).', 'Latem: ochrona (herbicyd, fungicyd, insektycyd), sianokosy, potem żniwa.', 'Jesienią: orka, wapnowanie, siew ozimin i rzepaku. Zimą zakaz nawożenia — czas na zakupy i serwis.', 'Płodozmian ma znaczenie: zboże po zbożu plonuje gorzej, rzepak i strączkowe to dobre przedplony.']],
    ['📋', 'Zlecanie prac', ['W panelu pola dotknij zalecanego zabiegu albo „Wszystkie”. Kreator przeprowadzi Cię przez parametry, wybór wykonawcy i koszt.', 'Usługa (firma) jest droższa, ale nie wymaga maszyn ani ludzi. Własne maszyny — taniej, ale potrzebujesz ciągnika, narzędzia, paliwa i operatora.', 'Prace stoją w deszczu, przy zmarzniętej ziemi i bez paliwa.']],
    ['🌾', 'Żniwa i transport', ['Kombajn rozładowuje zbiornik tylko na przyczepę jadącą obok — do zbioru potrzebujesz zestawu: ciągnik + przyczepa + kierowca.', 'Brakuje sprzętu? Wynajmij transport w kreatorze (1–3 zestawy) albo zamów usługę.', 'Zwracaj uwagę na pojemność magazynu i silosów.']],
    ['💰', 'Pieniądze', ['Sprzedawaj, gdy cena jest wyższa od średniej — wykres pokazuje ostatnie dni. Jakość ziarna zmienia cenę.', 'Umowy kontraktacji dają pewną cenę, ale za niedostarczenie jest kara.', 'Dopłaty bezpośrednie i ekoschematy wypłacane są 1 grudnia. Kredyty — w zakładce Rynek → Kredyty.']],
    ['🚜', 'Maszyny i jazda', ['Maszyny kupisz nowe lub używane, możesz też wynająć na kilka dni.', 'Zaznacz pojazd i dotknij „🕹️ Prowadź”, żeby jechać samodzielnie: joystick (lewy kciuk) lub WASD, Q — narzędzie, E — podczep, F — rozładunek.']],
    ['🐄', 'Hodowla i budowa', ['Zwierzęta potrzebują budynku, paszy i obsługi. Kury na start dają jaja codziennie.', 'Budynki stawiasz na podwórzu; podwórze możesz powiększać.']]
  ];
  U.panel('help', {
    title: 'Jak grać', sub: 'poradnik gospodarza',
    render(body) {
      body.appendChild(h('div.row', h('button.btn.primary.grow', { onclick: () => { U.close(); T.start(true); } }, '🎓 Uruchom samouczek'), h('button.btn.grow', { onclick: () => { U.close(); T.showTitle(); } }, '🏠 Ekran tytułowy')));
      for (const [ico, name, items] of GUIDE) {
        body.appendChild(h('div.section', ico + ' ' + name));
        body.appendChild(h('div.card', items.map(t => h('div.small', { style: { padding: '4px 0', lineHeight: '1.45' } }, '• ' + t))));
      }
    }
  });

  // =====================================================================================================
  // START
  // =====================================================================================================
  G.on('boot', loaded => {
    loadedAtBoot = loaded;
    // testy automatyczne pomijają ekran tytułowy (chyba że adres ma #title)
    const auto = navigator.webdriver && !/title/.test(location.hash);
    if (!auto) T.showTitle();
    else if (/tutorial/.test(location.hash)) setTimeout(() => T.start(true), 300);
    void loadedAtBoot;
  });
})();
