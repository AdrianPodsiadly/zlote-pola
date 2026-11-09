// Złote Pola — pętla gry (ładowana jako ostatnia)
(function () {
  const C = G.CFG;
  let last = performance.now(), acc = 0, errAt = 0;
  G.speed = 1; // indeks w C.SPEEDS albo wartość ustawiana przez UI: G.setSpeed(n)
  G.setSpeed = function (s) { G.speed = s; G.emit('speed', s); };

  function report(where, e) {
    console.error('[Złote Pola] błąd: ' + where, e);
    const now = performance.now();
    if (now - errAt > 30000) { errAt = now; G.notify('⚠️ Błąd (' + where + ') — gra działa dalej, zapis jest bezpieczny', 'warn'); }
  }

  function frame(now) {
    const dtReal = Math.min(0.25, (now - last) / 1000);
    last = now;
    const mult = G.speed;
    // czas gry w godzinach, który upłynął w tej klatce
    const dtH = dtReal * mult * 1000 / C.TICK_MS;
    if (G.S) {
      try {
        acc += dtReal * 1000 * mult;
        let n = 0;
        while (acc >= C.TICK_MS && n < 24) { G.tick(); acc -= C.TICK_MS; n++; }
        if (n >= 24) acc = 0;
        G.hourFrac = acc / C.TICK_MS; // ułamek bieżącej godziny (płynne światło dnia)
      } catch (e) { acc = 0; report('symulacja', e); }
      G.emit('frame', dtH, now, dtReal);
      try { if (G.render && G.render.draw) G.render.draw(now, dtReal); } catch (e) { report('grafika', e); }
      try { if (G.ui && G.ui.update) G.ui.update(now, dtReal); } catch (e) { report('interfejs', e); }
    }
    requestAnimationFrame(frame);
  }

  window.addEventListener('load', () => {
    let loaded = null;
    try { loaded = G.storage.loadStartup(); } catch (e) { console.error(e); }
    if (!loaded) G.newGame();
    G.emit('boot', loaded);           // UI i grafika inicjują się tutaj (ekran tytułowy itd.)
    requestAnimationFrame(frame);
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden && G.S) G.storage.save('auto'); });
  window.addEventListener('pagehide', () => { if (G.S) G.storage.save('auto'); });
})();
