// Złote Pola — główny renderer (agent: grafika). Wersja startowa: prosty podgląd mapy do testów rdzenia.
// API dla innych: G.render.init(canvas), G.render.draw(now, dt), G.render.resize(), G.render.minimap(ctx, w, h)
// Interfejs ustawia, co podświetlić: G.view = { hover: idx|-1, selParcel: id|-1, highlight: [idx...], place: {type, x, y, rot, valid}|null }
(function () {
  const C = G.CFG, T = G.T, ISO = G.iso;
  const R = G.render = {};
  G.view = { hover: -1, selParcel: -1, highlight: [], place: null };
  let cv, ctx, dpr = 1;
  const COL = { [T.GRASS]: '#7dae55', [T.FIELD]: '#9b7b4f', [T.FOREST]: '#2f5d2a', [T.WATER]: '#3d7fbf', [T.ROAD]: '#b49a6c', [T.YARD]: '#9a958a', [T.MEADOW]: '#8fc062', [T.VILLAGE]: '#c96f4a', [T.ASPHALT]: '#55595f' };
  R.init = function (canvas) {
    cv = canvas; ctx = cv.getContext('2d');
    R.resize();
    window.addEventListener('resize', R.resize);
    if (window.ResizeObserver) new ResizeObserver(R.resize).observe(cv);
  };
  R.resize = function () {
    if (!cv) return;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    const r = cv.getBoundingClientRect();
    cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
    G.cam.vw = r.width; G.cam.vh = r.height;
  };
  R.draw = function () {
    if (!ctx) return;
    const S = G.S, z = G.cam.zoom, hw = ISO.TW / 2 * z, hh = ISO.TH / 2 * z;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#20301c'; ctx.fillRect(0, 0, G.cam.vw, G.cam.vh);
    const vr = ISO.visibleRange(2);
    for (let y = vr.y0; y <= vr.y1; y++) for (let x = vr.x0; x <= vr.x1; x++) {
      const i = y * C.W + x, p = ISO.tileToScreen(x, y);
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + hw, p.y + hh); ctx.lineTo(p.x, p.y + 2 * hh); ctx.lineTo(p.x - hw, p.y + hh); ctx.closePath();
      const pc = S.map.parcel[i];
      ctx.fillStyle = COL[S.map.t[i]] || '#f0f';
      ctx.fill();
      if (pc >= 0 && S.parcels[pc].owner === 'player') { ctx.fillStyle = 'rgba(255,215,0,0.18)'; ctx.fill(); }
      if (i === G.view.hover || (pc >= 0 && pc === G.view.selParcel)) { ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.fill(); }
    }
  };
})();
