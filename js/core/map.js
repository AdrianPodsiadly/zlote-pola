// Złote Pola — generator mapy: rzeka, droga asfaltowa, wieś, drogi polne, lasy, działki z klasami gleby
(function () {
  const C = G.CFG, T = G.T, W = C.W, H = C.H, N = W * H;
  const M = G.mapgen = {};

  G.idx = (x, y) => y * W + x;
  G.tx = i => i % W;
  G.ty = i => (i / W) | 0;
  G.inMap = (x, y) => x >= 0 && y >= 0 && x < W && y < H;
  G.N4 = function (i) {
    const x = i % W, r = [];
    if (x > 0) r.push(i - 1); if (x < W - 1) r.push(i + 1);
    if (i >= W) r.push(i - W); if (i < N - W) r.push(i + W);
    return r;
  };

  // płynny szum wartości (do klas gleby)
  function noise(r, scale) {
    const gw = Math.ceil(W / scale) + 2, gh = Math.ceil(H / scale) + 2, g = [];
    for (let i = 0; i < gw * gh; i++) g.push(r());
    const out = new Float32Array(N);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const fx = x / scale, fy = y / scale, x0 = Math.floor(fx), y0 = Math.floor(fy), ax = fx - x0, ay = fy - y0;
      const s = t => t * t * (3 - 2 * t), a = s(ax), b = s(ay);
      const v00 = g[y0 * gw + x0], v10 = g[y0 * gw + x0 + 1], v01 = g[(y0 + 1) * gw + x0], v11 = g[(y0 + 1) * gw + x0 + 1];
      out[y * W + x] = (v00 * (1 - a) + v10 * a) * (1 - b) + (v01 * (1 - a) + v11 * a) * b;
    }
    return out;
  }

  M.generate = function (S, seed) {
    const r = G.rng(seed);
    const t = new Uint8Array(N), soil = new Uint8Array(N), parcel = new Int16Array(N).fill(-1), v = new Uint8Array(N);
    for (let i = 0; i < N; i++) { t[i] = T.GRASS; v[i] = (r() * 256) | 0; }

    // klasy gleby I–VI (1 = najlepsza)
    const n1 = noise(r, 14), n2 = noise(r, 5);
    const roadY = 46 + ((r() * 4) | 0);

    // rzeka (z północy na południe), z łąkami wzdłuż
    let rx = 70 + ((r() * 6) | 0);
    const river = [];
    for (let y = 0; y < H; y++) {
      if (r() < 0.4) rx += r() < 0.5 ? -1 : 1;
      rx = Math.max(62, Math.min(84, rx));
      river.push(rx);
      for (let k = 0; k < 3; k++) t[y * W + rx + k] = T.WATER;
    }
    // gleba: lepsza w dolinie rzeki, gorsza (piaski) na zachodnim skraju i północy
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const dr = Math.abs(x - river[y]);
      let q = 0.55 * n1[i] + 0.25 * n2[i] + (dr < 12 ? 0.2 * (1 - dr / 12) : 0) - (x < 12 ? 0.15 : 0) - (y < 10 ? 0.1 : 0);
      soil[i] = Math.max(1, Math.min(6, 6 - Math.floor(q * 6.5)));
    }

    // droga asfaltowa wschód–zachód (most nad rzeką)
    for (let x = 0; x < W; x++) t[roadY * W + x] = T.ASPHALT;

    // drogi polne: siatka nieregularna
    const vx = [], hy = [];
    for (let x = 6 + ((r() * 4) | 0); x < W - 4; x += 11 + ((r() * 7) | 0)) vx.push(x);
    for (let y = 5 + ((r() * 4) | 0); y < H - 4; y += 10 + ((r() * 6) | 0)) if (Math.abs(y - roadY) > 4) hy.push(y);
    const isWater = i => t[i] === T.WATER;
    for (const x of vx) for (let y = 0; y < H; y++) { const i = y * W + x; if (!isWater(i) && t[i] !== T.ASPHALT) t[i] = T.ROAD; }
    for (const y of hy) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (isWater(i)) continue;
      // po drugiej stronie rzeki drogi kończą się na brzegu (bez mostów poza asfaltem)
      if (t[i] !== T.ASPHALT) t[i] = T.ROAD;
    }

    // wieś wzdłuż asfaltu
    const vx0 = 38 + ((r() * 6) | 0), vx1 = vx0 + 14;
    for (let x = vx0; x <= vx1; x++) for (const dy of [-2, -1, 1, 2]) {
      const i = (roadY + dy) * W + x;
      if (t[i] === T.GRASS && r() < 0.8) t[i] = T.VILLAGE;
    }

    // podwórze gracza: na południe od asfaltu, na zachód od wsi
    const yw = 8, yh = 7, yx = vx0 - yw - 3, yy = roadY + 1;
    for (let y = yy; y < yy + yh; y++) for (let x = yx; x < yx + yw; x++) t[y * W + x] = T.YARD;
    S.farm = { yard: { x: yx, y: yy, w: yw, h: yh }, name: 'Gospodarstwo po dziadku' };

    // lasy na skrajach
    const forests = 7 + ((r() * 4) | 0);
    for (let k = 0; k < forests; k++) {
      const edge = r();
      const cx = edge < 0.5 ? (r() < 0.5 ? (r() * 10) | 0 : W - 1 - ((r() * 8) | 0)) : (r() * W) | 0;
      const cy = edge >= 0.5 ? (r() < 0.5 ? (r() * 8) | 0 : H - 1 - ((r() * 8) | 0)) : (r() * H) | 0;
      const rad = 3 + r() * 5;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (t[i] !== T.GRASS) continue;
        if (Math.hypot(x - cx, (y - cy) * 1.2) < rad + (n2[i] - 0.5) * 3) t[i] = T.FOREST;
      }
    }

    // działki: bloki pomiędzy drogami, dzielone na 1–3 części
    const xs = [-1].concat(vx, [W]), ys = [-1].concat(hy.concat([roadY]).sort((a, b) => a - b), [H]);
    const parcels = [];
    for (let bi = 0; bi < xs.length - 1; bi++) for (let bj = 0; bj < ys.length - 1; bj++) {
      const x0 = xs[bi] + 1, x1 = xs[bi + 1] - 1, y0 = ys[bj] + 1, y1 = ys[bj + 1] - 1;
      if (x1 - x0 < 2 || y1 - y0 < 2) continue;
      // podział bloku
      const cuts = 2 + ((r() * 3) | 0); // 2–4 działki w bloku
      const vertical = (x1 - x0) > (y1 - y0);
      const len = vertical ? x1 - x0 + 1 : y1 - y0 + 1;
      const bounds = [0];
      for (let c = 1; c < cuts; c++) bounds.push(Math.round(len * c / cuts + (r() - 0.5) * len / (cuts * 2)));
      bounds.push(len);
      for (let c = 0; c < cuts; c++) {
        const a = bounds[c], b = bounds[c + 1] - 1;
        const px0 = vertical ? x0 + a : x0, px1 = vertical ? x0 + b : x1;
        const py0 = vertical ? y0 : y0 + a, py1 = vertical ? y1 : y0 + b;
        const tiles = [];
        for (let y = py0; y <= py1; y++) for (let x = px0; x <= px1; x++) {
          const i = y * W + x;
          if (t[i] === T.GRASS) tiles.push(i);
        }
        if (tiles.length < 8) continue;
        // łąka, jeśli blisko rzeki
        const midX = (px0 + px1) / 2, midY = Math.round((py0 + py1) / 2);
        const nearRiver = Math.abs(midX - river[midY]) < 7;
        const kind = nearRiver && r() < 0.75 ? 'meadow' : 'field';
        const id = parcels.length;
        let soilSum = 0;
        for (const i of tiles) { t[i] = kind === 'meadow' ? T.MEADOW : T.FIELD; parcel[i] = id; soilSum += soil[i]; }
        const area = tiles.length * C.TILE_HA;
        const soilAvg = soilSum / tiles.length;
        // cena ziemi: ok. 95 tys. zł/ha (kl. I) … 30 tys. zł/ha (kl. VI); łąki taniej
        const perHa = (95000 - (soilAvg - 1) * 13000) * (kind === 'meadow' ? 0.6 : 1);
        // wjazd: kafelek drogi przylegający do działki, najbliższy środka
        let entry = -1, best = 1e9;
        for (const i of tiles) for (const n of G.N4(i)) {
          if (t[n] === T.ROAD || t[n] === T.ASPHALT) {
            const d = Math.hypot(n % W - midX, ((n / W) | 0) - midY);
            if (d < best) { best = d; entry = n; }
          }
        }
        parcels.push({
          id, name: 'Działka ' + (id + 1), tiles, area, kind, soilAvg: Math.round(soilAvg * 10) / 10,
          owner: 'npc', price: Math.round(perHa * area / 1000) * 1000, rent: Math.round(area * (kind === 'meadow' ? 450 : 1100 - (soilAvg - 1) * 120)),
          cx: (px0 + px1 + 1) / 2, cy: (py0 + py1 + 1) / 2, box: { x0: px0, y0: py0, x1: px1, y1: py1 }, entry, leased: false
        });
      }
    }

    // własność: 3 najbliższe pola + 1 łąka gracza; część działek na sprzedaż / do dzierżawy
    const yc = { x: yx + yw / 2, y: yy + yh / 2 };
    const byDist = parcels.slice().sort((a, b) => Math.hypot(a.cx - yc.x, a.cy - yc.y) - Math.hypot(b.cx - yc.x, b.cy - yc.y));
    let ownedFields = 0, ownedArea = 0, ownedMeadow = 0;
    for (const p of byDist) {
      if (p.kind === 'field' && ownedFields < 3 && p.area <= 7 && ownedArea + p.area <= 15) { p.owner = 'player'; ownedFields++; ownedArea += p.area; }
    }
    const meadows = parcels.filter(p => p.kind === 'meadow' && p.area <= 8).sort((a, b) => Math.hypot(a.cx - yc.x, a.cy - yc.y) - Math.hypot(b.cx - yc.x, b.cy - yc.y));
    if (meadows[0]) { meadows[0].owner = 'player'; ownedMeadow = 1; }
    for (const p of parcels) if (p.owner === 'npc' && r() < 0.35) p.owner = 'market';

    S.map = { t, soil, parcel, v };
    S.parcels = parcels;
  };

  // pomocnicze
  G.parcelAt = i => { const p = G.S.map.parcel[i]; return p >= 0 ? G.S.parcels[p] : null; };
  G.playerParcels = () => G.S.parcels.filter(p => p.owner === 'player');
  G.isDrivable = i => { const tt = G.S.map.t[i]; return tt === T.ROAD || tt === T.ASPHALT || tt === T.YARD; };
})();
