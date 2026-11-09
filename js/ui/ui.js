// Złote Pola — interfejs (agent: UI/UX). Wersja startowa: tylko przesuwanie/zoom i wybór pola do testów rdzenia.
(function () {
  const U = G.ui = {};
  G.on('boot', () => {
    const cv = document.getElementById('cv');
    G.render.init(cv);
    const y = G.S.farm.yard; G.iso.centerOn(y.x + y.w / 2, y.y + y.h / 2);
    let drag = null;
    cv.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY }; cv.setPointerCapture(e.pointerId); });
    cv.addEventListener('pointermove', e => {
      const r = cv.getBoundingClientRect();
      G.view.hover = G.iso.pick(e.clientX - r.left, e.clientY - r.top);
      if (drag) { G.iso.pan(e.clientX - drag.x, e.clientY - drag.y); drag = { x: e.clientX, y: e.clientY }; }
    });
    cv.addEventListener('pointerup', () => { drag = null; });
    cv.addEventListener('wheel', e => { e.preventDefault(); const r = cv.getBoundingClientRect(); G.iso.zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left, e.clientY - r.top); }, { passive: false });
  });
  U.update = function () {};
})();
