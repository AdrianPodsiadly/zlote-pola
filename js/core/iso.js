// Złote Pola — rzut izometryczny i kamera (wspólne dla grafiki i sterowania)
//
// Układ: kafelek (tx, ty) w świecie → romb o szerokości TW i wysokości TH.
// Środek kafelka (tx+0.5, ty+0.5). Teren jest płaski (bez wysokości) — dzięki temu wybór pola palcem jest dokładny.
// Współrzędne "świata" (px przy zoom = 1):  X = (tx - ty) * TW/2 + OX,  Y = (tx + ty) * TH/2
// Ekran (px CSS):  sx = (X - cam.x) * cam.zoom,  sy = (Y - cam.y) * cam.zoom
(function () {
  const C = G.CFG;
  const ISO = G.iso = { TW: 64, TH: 32 };
  ISO.OX = C.H * ISO.TW / 2; // przesunięcie, żeby X ≥ 0

  G.cam = { x: 0, y: 0, zoom: 1, minZoom: 0.35, maxZoom: 2.5, vw: 800, vh: 600 };

  // kafelek (może być ułamkowy) → świat
  ISO.toWorld = function (tx, ty) {
    return { x: (tx - ty) * ISO.TW / 2 + ISO.OX, y: (tx + ty) * ISO.TH / 2 };
  };
  // świat → kafelek (ułamkowy)
  ISO.toTileF = function (X, Y) {
    const a = (X - ISO.OX) / (ISO.TW / 2), b = Y / (ISO.TH / 2);
    return { tx: (a + b) / 2, ty: (b - a) / 2 };
  };
  ISO.worldToScreen = function (X, Y) { return { x: (X - G.cam.x) * G.cam.zoom, y: (Y - G.cam.y) * G.cam.zoom }; };
  ISO.screenToWorld = function (sx, sy) { return { x: sx / G.cam.zoom + G.cam.x, y: sy / G.cam.zoom + G.cam.y }; };
  ISO.tileToScreen = function (tx, ty) { const w = ISO.toWorld(tx, ty); return ISO.worldToScreen(w.x, w.y); };
  // ekran → kafelek (ułamkowy) i indeks (-1 poza mapą)
  ISO.screenToTileF = function (sx, sy) { const w = ISO.screenToWorld(sx, sy); return ISO.toTileF(w.x, w.y); };
  ISO.pick = function (sx, sy) {
    const f = ISO.screenToTileF(sx, sy), x = Math.floor(f.tx), y = Math.floor(f.ty);
    return (x >= 0 && y >= 0 && x < C.W && y < C.H) ? y * C.W + x : -1;
  };

  // kamera
  ISO.centerOn = function (tx, ty) {
    const w = ISO.toWorld(tx, ty);
    G.cam.x = w.x - G.cam.vw / 2 / G.cam.zoom;
    G.cam.y = w.y - G.cam.vh / 2 / G.cam.zoom;
    ISO.clamp();
  };
  ISO.zoomAt = function (factor, sx, sy) {
    const c = G.cam, before = ISO.screenToWorld(sx, sy);
    c.zoom = Math.max(c.minZoom, Math.min(c.maxZoom, c.zoom * factor));
    c.x = before.x - sx / c.zoom; c.y = before.y - sy / c.zoom;
    ISO.clamp();
  };
  ISO.pan = function (dxScreen, dyScreen) { G.cam.x -= dxScreen / G.cam.zoom; G.cam.y -= dyScreen / G.cam.zoom; ISO.clamp(); };
  ISO.clamp = function () {
    const c = G.cam, mw = (C.W + C.H) * ISO.TW / 2, mh = (C.W + C.H) * ISO.TH / 2, m = 200;
    c.x = Math.max(-m, Math.min(mw + m - c.vw / c.zoom, c.x));
    c.y = Math.max(-m, Math.min(mh + m - c.vh / c.zoom, c.y));
  };
  // widoczny zakres kafelków (do pomijania niewidocznych przy rysowaniu)
  ISO.visibleRange = function (pad) {
    pad = pad || 2;
    const c = G.cam, pts = [[0, 0], [c.vw, 0], [0, c.vh], [c.vw, c.vh]].map(p => ISO.screenToTileF(p[0], p[1]));
    const xs = pts.map(p => p.tx), ys = pts.map(p => p.ty);
    return {
      x0: Math.max(0, Math.floor(Math.min(...xs)) - pad), x1: Math.min(C.W - 1, Math.ceil(Math.max(...xs)) + pad),
      y0: Math.max(0, Math.floor(Math.min(...ys)) - pad), y1: Math.min(C.H - 1, Math.ceil(Math.max(...ys)) + pad)
    };
  };
})();
