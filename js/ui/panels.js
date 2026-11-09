// Złote Pola — panele: działka, pola, magazyn, rynek, finanse, maszyny, ludzie, zwierzęta, budowa, ziemia, ustawienia, pojazd (agent: UI/UX)
(function () {
  const U = G.ui, h = U.h, F = U.fmt;
  const P = id => G.PRODUCTS[id] || { name: id, unit: '', icon: '📦' };
  const pname = id => P(id).name;
  const picon = id => P(id).icon || '📦';
  const money = v => G.fmtMoney(v);

  // ---------- wykresy (SVG, bez bibliotek) ----------
  function sparkline(vals, opts) {
    opts = opts || {};
    const w = 200, hh = opts.h || 44, pad = 3;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 ' + w + ' ' + hh); svg.setAttribute('preserveAspectRatio', 'none'); svg.classList.add(opts.cls || 'spark');
    if (!vals || vals.length < 2) return svg;
    const mn = Math.min(...vals), mx = Math.max(...vals), rng = mx - mn || 1;
    const pts = vals.map((v, i) => [pad + i / (vals.length - 1) * (w - 2 * pad), hh - pad - (v - mn) / rng * (hh - 2 * pad)]);
    const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    const up = vals[vals.length - 1] >= vals[0];
    const col = opts.color || (up ? '#7fd47f' : '#ff6f6f');
    const area = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    area.setAttribute('d', d + ' L' + pts[pts.length - 1][0].toFixed(1) + ' ' + hh + ' L' + pts[0][0].toFixed(1) + ' ' + hh + ' Z'); area.setAttribute('fill', col); area.setAttribute('opacity', '0.15');
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    line.setAttribute('d', d); line.setAttribute('fill', 'none'); line.setAttribute('stroke', col); line.setAttribute('stroke-width', '2'); line.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.appendChild(area); svg.appendChild(line);
    return svg;
  }
  // wykres słupkowo-liniowy: series [{ vals, color, type:'bar'|'line' }], labels
  function chart(series, opts) {
    opts = opts || {};
    const w = 320, hh = opts.h || 140, pl = 40, pb = 18, pt = 8;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 ' + w + ' ' + hh); svg.classList.add('chart');
    const all = series.flatMap(s => s.vals).filter(v => isFinite(v));
    if (!all.length) return svg;
    let mn = Math.min(0, ...all), mx = Math.max(...all); if (mx === mn) mx = mn + 1;
    const n = Math.max(...series.map(s => s.vals.length));
    const X = i => pl + (i + 0.5) / n * (w - pl - 4), Y = v => pt + (1 - (v - mn) / (mx - mn)) * (hh - pt - pb);
    const ns = 'http://www.w3.org/2000/svg';
    for (let k = 0; k <= 3; k++) {
      const v = mn + (mx - mn) * k / 3, y = Y(v);
      const l = document.createElementNS(ns, 'line'); l.setAttribute('x1', pl); l.setAttribute('x2', w - 4); l.setAttribute('y1', y); l.setAttribute('y2', y); l.setAttribute('stroke', 'rgba(255,255,255,0.1)'); svg.appendChild(l);
      const t = document.createElementNS(ns, 'text'); t.setAttribute('x', pl - 4); t.setAttribute('y', y + 3); t.setAttribute('text-anchor', 'end'); t.setAttribute('fill', '#867f6c'); t.setAttribute('font-size', '9'); t.textContent = fmtShort(v); svg.appendChild(t);
    }
    if (mn < 0) { const l = document.createElementNS(ns, 'line'); l.setAttribute('x1', pl); l.setAttribute('x2', w - 4); l.setAttribute('y1', Y(0)); l.setAttribute('y2', Y(0)); l.setAttribute('stroke', 'rgba(255,255,255,0.3)'); svg.appendChild(l); }
    const bw = Math.max(1.5, (w - pl - 4) / n * 0.35);
    series.forEach((s, si) => {
      if (s.type === 'bar') {
        const bars = series.filter(x => x.type === 'bar'), bi = bars.indexOf(s), off = (bi - (bars.length - 1) / 2) * bw;
        s.vals.forEach((v, i) => { const r = document.createElementNS(ns, 'rect'); const y0 = Y(Math.max(0, v)), y1 = Y(Math.min(0, v)); r.setAttribute('x', X(i) - bw / 2 + off); r.setAttribute('y', y0); r.setAttribute('width', bw); r.setAttribute('height', Math.max(0.5, y1 - y0)); r.setAttribute('fill', s.color); r.setAttribute('rx', '1'); svg.appendChild(r); });
      } else {
        const d = s.vals.map((v, i) => (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1)).join(' ');
        const p = document.createElementNS(ns, 'path'); p.setAttribute('d', d); p.setAttribute('fill', 'none'); p.setAttribute('stroke', s.color); p.setAttribute('stroke-width', '2'); svg.appendChild(p);
      }
      void si;
    });
    if (opts.labels) opts.labels.forEach((lb, i) => { if (!lb) return; const t = document.createElementNS(ns, 'text'); t.setAttribute('x', X(i)); t.setAttribute('y', hh - 4); t.setAttribute('text-anchor', 'middle'); t.setAttribute('fill', '#867f6c'); t.setAttribute('font-size', '9'); t.textContent = lb; svg.appendChild(t); });
    return svg;
  }
  function fmtShort(v) { const a = Math.abs(v); if (a >= 1e6) return (v / 1e6).toFixed(1) + 'M'; if (a >= 1e3) return Math.round(v / 1e3) + 'k'; return Math.round(v); }
  U.sparkline = sparkline; U.chart = chart;

  // suwak ilości z przyciskami szybkimi: onChange(q)
  function qtySlider(max, step, init, unit, onChange, quick) {
    let q = init != null ? init : max;
    const inp = h('input', { type: 'range', min: 0, max, step, value: q });
    const lbl = h('span.b.num');
    const upd = () => { lbl.textContent = G.fmtNum(q, step < 1 ? 2 : 0) + ' ' + unit; onChange(q); };
    inp.addEventListener('input', () => { q = +inp.value; upd(); });
    const wrap = h('div.nolive', h('div.row.between', h('span.small.muted', 'Ilość'), lbl), inp);
    if (quick !== false) wrap.appendChild(h('div.chips', [0.25, 0.5, 1].map(f => h('button.chip.sm', { onclick: () => { q = Math.round(max * f / step) * step; inp.value = q; upd(); } }, f === 1 ? 'wszystko' : Math.round(f * 100) + '%'))));
    upd();
    return { el: wrap, get: () => q, set: v => { q = v; inp.value = v; upd(); } };
  }
  U.qtySlider = qtySlider;
  function stepper(val, min, max, step, onChange) {
    let v = val;
    const lab = h('span.val.num', String(v));
    const set = nv => { v = Math.max(min, Math.min(max, nv)); lab.textContent = G.fmtNum(v, step < 1 ? 2 : 0); onChange(v); };
    return { el: h('div.stepper.nolive', h('button', { onclick: () => set(+(v - step).toFixed(3)) }, '−'), lab, h('button', { onclick: () => set(+(v + step).toFixed(3)) }, '+')), get: () => v, set };
  }
  U.stepper = stepper;
  function toggle(label, desc, on, onChange) {
    const el = h('div.toggle' + (on ? '.on' : ''), { onclick: () => { el.classList.toggle('on'); onChange(el.classList.contains('on')); } }, h('div', h('div.b', label), desc ? h('div.small.muted', desc) : null), h('div.sw'));
    return el;
  }
  U.toggle = toggle;
  function tabs(items, cur, onSel) { const t = h('div.tabs'); for (const it of items) t.appendChild(h('button.chip' + (it.id === cur ? '.on' : ''), { onclick: () => onSel(it.id) }, it.label)); return t; }
  U.tabs = tabs;
  function ownerTag(p) { return p.owner === 'player' ? h('span.tag.gold', p.leased ? 'dzierżawa' : 'własna') : p.owner === 'market' ? h('span.tag.green', 'na sprzedaż') : h('span.tag', 'sąsiad'); }
  function meter(label, v, max, txt, cls) { const b = h('div.bar.thin' + (cls ? '.' + cls : ''), h('i', { style: { width: Math.round(Math.max(0, Math.min(1, v / max)) * 100) + '%' } })); return h('div.meter', h('span.muted', label), b, h('span.v', txt)); }
  function cropIcon(crop) { const c = G.CROPS[crop]; if (!c) return '🌱'; const s = c.look && c.look.style; return { grain: '🌾', rapeseed: '🌼', maize: '🌽', root: '🥔', beet: '🟣', grass: '🌿', sunflower: '🌻' }[s] || '🌱'; }
  U.cropIcon = cropIcon;

  // =====================================================================================================
  // DZIAŁKA
  // =====================================================================================================
  U.panel('parcel', {
    live: 1500,
    title: pid => (G.S.parcels[pid] || {}).name || 'Działka',
    sub: pid => { const p = G.S.parcels[pid]; if (!p) return ''; const s = G.fields.summary(pid); return F.ha(p.area) + ' · ' + (p.kind === 'meadow' ? 'łąka' : 'grunt orny') + ' · gleba kl. ' + (s ? s.soilName : G.SOIL_NAMES[Math.round(p.soilAvg)]); },
    render(body, pid) {
      const p = G.S.parcels[pid]; if (!p) { body.appendChild(h('div.empty', 'Brak działki')); return; }
      const s = G.fields.summary(pid);
      const mine = p.owner === 'player';
      // własność / oferta
      const head = h('div.row.between', h('div.row.wrap', ownerTag(p), h('span.tag', 'kl. ' + s.soilName), p.entry >= 0 ? null : h('span.tag.red', 'brak wjazdu')), h('button.btn.sm.ghost', { onclick: () => { U.centerParcel(pid); if (U.isMobile()) U.peek(true); setTimeout(() => U.peek(false), 1400); } }, '🎯 Pokaż'));
      body.appendChild(head);
      if (!mine) { renderOffer(body, p); }
      // stan uprawy
      const c = G.CROPS[s.crop];
      const card = h('div.card');
      if (c) {
        card.appendChild(h('div.row', h('span.ico-big', cropIcon(s.crop)), h('div.grow', h('div.b', s.cropName), h('div.small.muted', s.phaseName + (s.stage ? ' — ' + s.stage : ''))), s.daysToHarvest != null ? h('div.right', h('div.b.num', s.phase === 'ripe' ? 'dojrzałe' : '~' + s.daysToHarvest + ' dni'), h('div.tiny.muted', s.phase === 'ripe' ? 'okno ' + (s.window - (s.ripeDays || 0)) + ' dni' : 'do zbioru')) : null));
        card.appendChild(h('div.bar', { style: { marginTop: '8px' } }, h('i', { style: { width: s.growthPct + '%' } })));
        card.appendChild(h('div.row.between.small.muted', { style: { marginTop: '4px' } }, h('span', 'wzrost ' + s.growthPct + '%'), s.product ? h('span.num', 'prognoza ' + G.fmtNum(s.yieldEst, 1) + ' ' + s.unit + '/ha · ' + G.fmtQty(s.product, s.yieldTotal) + ' ≈ ' + money(s.valueEst)) : null));
      } else {
        card.appendChild(h('div.row', h('span.ico-big', s.kind === 'meadow' ? '🌿' : '🟫'), h('div.grow', h('div.b', s.phaseName[0].toUpperCase() + s.phaseName.slice(1)), h('div.small.muted', s.prevCropName ? 'przedplon: ' + s.prevCropName : 'brak danych o przedplonie'))));
        if (s.straw > 0) card.appendChild(h('div.small.muted', '🟨 Słoma na polu: ~' + s.straw + ' bel'));
        if (s.swath > 0) card.appendChild(h('div.small.muted', '🌿 Pokos: ~' + s.swath + ' bel, wysuszenie ' + Math.round(s.dry * 100) + '%'));
      }
      if (s.work) card.appendChild(h('div.hint', '🚜 Trwa: ' + s.work.name + ' — ' + s.work.pct + '% (' + s.work.done + '/' + s.work.total + ' kafli)'));
      if (s.npcTask) card.appendChild(h('div.small.muted', 'Sąsiad: ' + s.npcTask));
      body.appendChild(card);
      // ostrzeżenia
      if (s.warnings.length) body.appendChild(h('div.hint.warn', s.warnings.map(w => '⚠️ ' + w).join(' · ')));
      if (s.losses.length) body.appendChild(h('div.small.muted', 'Straty potencjału: ' + s.losses.map(l => l.cause + ' ' + l.pct + '%').join(', ')));
      // zalecane zabiegi
      if (mine) {
        body.appendChild(h('div.section', 'Zalecane zabiegi', h('button.btn.xs.ghost', { onclick: () => U.open('planner', { pid }, { push: true }) }, 'Wszystkie ›')));
        const jobs = U.call('jobs.forParcel', [pid], []) || [];
        for (const j of jobs) body.appendChild(jobCard(j, true));
        if (!s.next.length && !jobs.length) body.appendChild(h('div.hint', c ? 'Uprawa rośnie — na razie nic nie trzeba robić. Zaglądaj tu po deszczu i w cieplejsze dni (chwasty, choroby).' : 'Brak zaleceń na teraz.'));
        for (const r of s.next.slice(0, 4)) {
          const op = r.op && G.fields.OPS[r.op];
          const btn = h('button.rec-btn' + (r.priority === 1 ? '.p1' : '') + (!r.op ? '.off' : ''), { disabled: !r.op, onclick: () => { if (!r.op) return; U.sfx('ui_tap'); U.open('planner', { pid, op: r.op, params: r.params, fromRec: true }, { push: true }); } },
            h('span.ico', op ? op.icon : '⏳'), h('div.grow', h('div.t', r.label), h('div.w', r.why + (r.ok ? '' : r.reason ? ' · ' : '')), !r.ok && r.reason ? h('div.w.warn', r.reason) : null), r.op ? h('span.arrow', '›') : null);
          body.appendChild(btn);
        }
        if (c && G.market && G.market.price && s.phase !== 'ripe') body.appendChild(h('div.small.muted', { style: { marginTop: '6px' } }, 'Cena skupu ' + pname(s.product).toLowerCase() + ': ' + G.fmtNum(G.market.price(s.product), 0) + ' zł/' + s.unit));
      }
      // gleba
      body.appendChild(h('div.section', 'Gleba i agrofagi'));
      const soil = h('div.card');
      soil.appendChild(meter('Azot N', s.n, Math.max(120, s.nNeed || 120), s.n + ' kg/ha' + (s.nRatio != null ? ' (' + Math.round(s.nRatio * 100) + '%)' : ''), s.nRatio != null && s.nRatio < 0.7 ? 'red' : 'green'));
      soil.appendChild(meter('Fosfor P', s.p, 120, s.p + ' kg/ha', s.p < 40 ? 'red' : 'green'));
      soil.appendChild(meter('Potas K', s.k, 160, s.k + ' kg/ha', s.k < 60 ? 'red' : 'green'));
      soil.appendChild(meter('pH', s.ph - 4, 4, G.fmtNum(s.ph, 1) + (s.phPending ? ' ↗' : '') + ' (opt. ' + s.phOpt + ')', s.ph < 5.5 ? 'red' : s.ph < 6 ? 'gold' : 'green'));
      soil.appendChild(meter('Wilgotność', s.moisture, 1, Math.round(s.moisture * 100) + '%', s.moisture < 0.3 ? 'red' : 'blue'));
      soil.appendChild(meter('Chwasty', s.weeds, 1, s.weedsText, s.weeds > 0.35 ? 'red' : 'gold'));
      soil.appendChild(meter('Choroby', s.disease, 1, s.diseaseText, s.disease > 0.3 ? 'red' : 'gold'));
      soil.appendChild(meter('Szkodniki', s.pests, 1, s.pestsText, s.pests > 0.3 ? 'red' : 'gold'));
      if (s.protection.length) soil.appendChild(h('div.small.muted', { style: { marginTop: '6px' } }, '🛡️ Ochrona: ' + s.protection.map(x => pname(x.product).split(' ')[0] + ' jeszcze ' + x.days + ' dni').join(', ')));
      body.appendChild(soil);
      if (s.factors.length) {
        body.appendChild(h('div.section', 'Czynniki plonu'));
        const fc = h('div.card');
        for (const f of s.factors) fc.appendChild(h('div.row.between.small', h('span', f.name, h('span.muted', ' — ' + f.text)), h('span.b.num' + (f.value < 0.9 ? '.bad' : f.value > 1.02 ? '.good' : ''), '×' + G.fmtNum(f.value, 2))));
        body.appendChild(fc);
      }
      if (s.history.length) {
        body.appendChild(h('div.section', 'Historia pola'));
        const hc = h('div.card');
        for (const x of s.history) hc.appendChild(h('div.row.between.small', h('span', cropIcon(x.crop) + ' ' + x.cropName), h('span.muted.num', x.year + (x.yield ? ' · ' + G.fmtNum(x.yield, 1) + ' t/ha' : ''))));
        body.appendChild(hc);
      }
      // planer upraw
      if (mine && p.kind !== 'meadow' && !c) {
        body.appendChild(h('div.section', 'Planer upraw'));
        const sug = G.fields.suggestCrops(pid);
        for (const sg of sug.slice(0, 5)) body.appendChild(h('div.card.clickable', { onclick: () => U.open('planner', { pid, op: 'sow', params: { crop: sg.crop } }, { push: true }) },
          h('div.row.between', h('div.row', h('span.ico-big', cropIcon(sg.crop)), h('div', h('div.b', sg.name), h('div.small.muted', 'siew: ' + sg.when))), h('div.right', h('div.b.num' + (sg.marginHa > 0 ? '.good' : '.bad'), F.signed(sg.marginHa) + '/ha'), h('div.tiny.muted.num', G.fmtNum(sg.yieldHa, 1) + ' t/ha · ' + sg.priceT + ' zł/t'))),
          sg.notes ? h('div.small.muted', { style: { marginTop: '4px' } }, sg.notes) : null));
      }
      // ziemia: sprzedaż / dzierżawa
      if (mine && G.land) {
        body.appendChild(h('div.section', 'Ziemia'));
        const row = h('div.row.wrap');
        if (p.leased) {
          row.appendChild(h('button.btn.sm', { onclick: () => U.confirm('Wykupić działkę?', 'Masz prawo pierwokupu. Cena ok. ' + money(p.price) + ' + opłaty notarialne.', 'Kup', () => U.result(G.land.buy(pid), null) && U.rerender()) }, '🏡 Wykup za ' + money(p.price)));
          row.appendChild(h('button.btn.sm.danger', { onclick: () => U.confirm('Rozwiązać dzierżawę?', 'Przy wcześniejszym rozwiązaniu zapłacisz odszkodowanie (25% rocznego czynszu).', 'Rozwiąż', () => { U.result(G.land.endLease(pid), null); U.back(); }) }, 'Zakończ dzierżawę'));
        } else row.appendChild(h('button.btn.sm.danger', { onclick: () => U.confirm('Sprzedać ' + p.name + '?', 'Otrzymasz ' + money(G.land.sellQuote(pid)) + ' (po kosztach). Tej decyzji nie da się cofnąć.', 'Sprzedaj', () => { U.result(G.land.sell(pid), null); U.back(); }) }, '💸 Sprzedaj za ' + money(G.land.sellQuote(pid))));
        body.appendChild(row);
      }
    }
  });
  function renderOffer(body, p) {
    const offers = U.call('land.offers', [], []) || [];
    const o = offers.find(x => x.pid === p.id);
    if (!o) { body.appendChild(h('div.hint', p.owner === 'npc' ? 'Działka sąsiada — nie jest teraz na sprzedaż. Oferty zmieniają się co miesiąc.' : 'Brak oferty.')); return; }
    body.appendChild(landOfferCard(o, true));
  }
  function landOfferCard(o, inParcel) {
    const c = h('div.card' + (o.deal ? '.good' : ''));
    c.appendChild(h('div.row.between', h('div', h('div.b', (o.kind === 'sale' ? '🏷️ Na sprzedaż' : '📝 Do dzierżawy') + (o.deal ? ' · okazja!' : '')), h('div.small.muted', F.ha(o.area) + ' · kl. ' + o.soilName + ' · ' + (o.landKind === 'meadow' ? 'łąka' : 'pole') + ' · ' + o.dist + ' kafli od podwórza' + (o.state ? ' · ' + o.state : ''))), h('div.right', h('div.b.num', o.kind === 'sale' ? money(o.price) : money(o.rent) + '/rok'), h('div.tiny.muted.num', o.kind === 'sale' ? money(o.pricePerHa) + '/ha + ' + money(o.fee) + ' notariusz' : money(o.rentPerHa) + '/ha · ' + o.years + ' lat'))));
    const row = h('div.row', { style: { marginTop: '8px' } });
    if (!inParcel) row.appendChild(h('button.btn.sm.ghost', { onclick: () => { U.centerParcel(o.pid); U.selectParcel(o.pid); } }, '🎯'));
    if (o.kind === 'sale') {
      row.appendChild(h('button.btn.sm.primary.grow', { onclick: () => U.confirm('Kupić ' + o.name + '?', 'Cena ' + money(o.price) + ' + notariusz ' + money(o.fee) + ' = ' + money(o.total) + '.', 'Kup za gotówkę', () => U.result(G.land.buy(o.pid), null) && U.rerender()) }, '🏡 Kup za ' + money(o.total)));
      row.appendChild(h('button.btn.sm.grow', { onclick: () => U.confirm('Kredyt ARiMR 2%', 'Bank sfinansuje 85% ceny (' + money(Math.round(o.price * 0.85)) + ') na 15 lat. Wkład własny i opłaty: ' + money(o.total - Math.round(o.price * 0.85)) + '.', 'Kup na kredyt', () => U.result(G.land.buy(o.pid, { credit: true }), null) && U.rerender()) }, '🏦 Na kredyt'));
    } else row.appendChild(h('button.btn.sm.primary.grow', { onclick: () => U.confirm('Wydzierżawić ' + o.name + '?', 'Czynsz ' + money(o.rent) + '/rok (' + money(Math.round(o.rent / 12)) + ' miesięcznie), umowa na ' + o.years + ' lat.', 'Dzierżaw', () => U.result(G.land.lease(o.pid), null) && U.rerender()) }, '📝 Dzierżaw'));
    c.appendChild(row);
    if (o.daysLeft != null && o.daysLeft < 10) c.appendChild(h('div.tiny.warn', { style: { marginTop: '4px' } }, 'Oferta wygasa za ' + o.daysLeft + ' dni'));
    return c;
  }
  U.landOfferCard = landOfferCard;

  // karta zlecenia (lista prac / panel działki)
  function jobCard(j, compact) {
    const name = U.call('jobs.opName', [j.op], j.op), p = G.S.parcels[j.pid];
    const prog = j.total ? j.done / j.total : 0;
    const stage = j.status === 'queued' ? (j.contractor ? '📞 Usługa: ' + j.contractor.name : '⏳ W kolejce') : { out: '🚜 Dojazd na pole', work: '⚙️ Praca w polu', home: '🏠 Powrót', parked: '🅿️ Postój' }[j.stage] || 'Aktywne';
    const c = h('div.card' + (j.err ? '.warn' : ''));
    c.appendChild(h('div.row.between', h('div.row', h('span.ico-big', (G.fields.OPS[j.op] || {}).icon || '📋'), h('div', h('div.b', name + (p ? ' — ' + p.name : '')), h('div.small.muted', stage + (j.userPaused ? ' · wstrzymane' : '')))), h('div.b.num', Math.round(prog * 100) + '%')));
    c.appendChild(h('div.bar' + (j.userPaused ? '.gold' : ''), { style: { marginTop: '6px' } }, h('i', { style: { width: Math.round(prog * 100) + '%' } })));
    if (j.reason && j.status === 'active') c.appendChild(h('div.small.warn', { style: { marginTop: '4px' } }, '⏸ ' + j.reason));
    if (j.err) c.appendChild(h('div.small.bad', '⚠️ ' + j.err));
    if (j.kind === 'bunker' && j.binCap) c.appendChild(h('div.veh-fill', h('span', '🌾 Zbiornik'), h('div.bar.thin.gold', h('i', { style: { width: Math.round(j.bin / j.binCap * 100) + '%' } })), h('span.num', G.fmtNum(j.bin, 1) + '/' + G.fmtNum(j.binCap, 1) + ' t')));
    if (j.sets && j.sets.length) {
      const sh = (j.units && j.units.shuttles) || [];
      j.sets.forEach((s, k) => { const u = sh.find(x => x.k === k); const fill = u && u.cap ? Math.min(1, u.load / u.cap) : 0; c.appendChild(h('div.veh-fill', h('span', '🚜 Przyczepa ' + (k + 1) + (s.hired ? ' (wynajęta)' : '')), h('div.bar.thin.blue', h('i', { style: { width: Math.round(fill * 100) + '%' } })), h('span.num.small.muted', u ? ({ standby: 'czeka', follow: 'przy kombajnie', toYard: 'odwozi', unload: 'wysyp', back: 'wraca', park: 'postój' }[u.phase] || u.phase || '') : 'w kolejce'))); });
    }
    if (!compact) {
      const eta = U.call('jobs.eta', [j.uid], null);
      c.appendChild(h('div.row.between.small.muted', { style: { marginTop: '4px' } }, h('span', j.contractor ? 'Usługa: ' + money(j.contractor.price) : 'Paliwo: ' + Math.round(j.fuel || 0) + ' l' + (j.fuelCost ? ' (' + money(j.fuelCost) + ')' : '')), eta != null ? h('span', 'jeszcze ~' + F.hours(eta)) : null));
    }
    const row = h('div.row', { style: { marginTop: '8px' } });
    if (j.status === 'active' && !j.cancelled) row.appendChild(h('button.btn.sm', { onclick: () => { if (j.userPaused) G.jobs.resume(j.uid); else G.jobs.pause(j.uid); U.rerender(); } }, j.userPaused ? '▶️ Wznów' : '⏸ Wstrzymaj'));
    if (j.err) row.appendChild(h('button.btn.sm.good', { onclick: () => { G.jobs.resume(j.uid); U.rerender(); } }, '🔄 Ponów'));
    if (!j.cancelled) row.appendChild(h('button.btn.sm.danger', { onclick: () => U.confirm('Odwołać zlecenie?', j.contractor ? 'Zwrot części opłaty za usługę.' : 'Maszyny wrócą na podwórze.', 'Odwołaj', () => { U.result(G.jobs.cancel(j.uid), null); U.rerender(); }) }, '✕ Odwołaj'));
    row.appendChild(h('button.btn.sm.ghost', { style: { marginLeft: 'auto' }, onclick: () => { const vs = (U.call('jobs.vehicles', [], []) || []).filter(v => v.jobUid === j.uid); if (vs.length) { U.cam.follow = { jobUid: j.uid, unit: 'main' }; U.centerOn(vs[0].x, vs[0].y, true); if (U.isMobile()) U.close(); } else { U.centerParcel(j.pid); } } }, '🎯 Pokaż'));
    c.appendChild(row);
    return c;
  }
  U.jobCard = jobCard;

  // =====================================================================================================
  // POLA (lista)
  // =====================================================================================================
  U.panel('fields', {
    title: 'Pola', live: 2000,
    sub: () => { const a = U.call('land.area', [], null); return a ? F.ha(a.total) + ' użytków' + (a.lease ? ' (dzierżawa ' + F.ha(a.lease) + ')' : '') : ''; },
    render(body) {
      const ov = G.fields.overview();
      if (!ov.length) { body.appendChild(h('div.empty', h('span.ico', '🌾'), 'Nie masz jeszcze żadnej ziemi.')); return; }
      const adv = G.fields.advice().filter(a => a.op && a.priority === 1);
      if (adv.length) body.appendChild(h('div.hint.warn', '⚡ Pilne: ' + adv.slice(0, 2).map(a => a.title).join('; ') + (adv.length > 2 ? ' i ' + (adv.length - 2) + ' więcej' : '')));
      const list = h('div.list');
      for (const o of ov) {
        const s = G.fields.summary(o.pid), p = G.S.parcels[o.pid];
        const jobs = U.call('jobs.forParcel', [o.pid], []) || [];
        const urgent = s.next.find(n => n.priority === 1 && n.op);
        list.appendChild(h('div.item.clickable', { onclick: () => { U.centerParcel(o.pid); U.selectParcel(o.pid); } },
          h('span.ico', o.crop ? cropIcon(o.crop) : o.kind === 'meadow' ? '🌿' : '🟫'),
          h('div.grow', h('div.row', h('span.b', o.name), p.leased ? h('span.tag', 'dz.') : null, jobs.length ? h('span.tag.blue', '🚜 ' + U.call('jobs.opName', [jobs[0].op], '')) : urgent ? h('span.tag.amber', urgent.label) : null),
            h('div.small.muted', F.ha(o.area) + ' · ' + (o.cropName || o.phaseName) + (o.crop ? ' ' + Math.round(o.growth * 100) + '%' : '')),
            o.crop ? h('div.bar.thin', { style: { marginTop: '4px' } }, h('i', { style: { width: Math.round(o.growth * 100) + '%' } })) : null),
          h('div.right', o.yieldEst ? h('div.b.num', G.fmtNum(o.yieldEst, 1) + ' t/ha') : null, h('div.tiny.muted', 'kl. ' + s.soilName))));
      }
      body.appendChild(list);
      body.appendChild(h('button.btn.block', { style: { marginTop: '10px' }, onclick: () => U.open('land') }, '🏞️ Kup lub dzierżaw ziemię'));
    }
  });

  // =====================================================================================================
  // MAGAZYN
  // =====================================================================================================
  U.panel('storage', {
    title: 'Magazyn', live: 2000,
    render(body) {
      const pools = U.call('buildings.storage', [], null);
      const inv = G.S.inv;
      const ids = Object.keys(inv).filter(k => inv[k] > 0);
      if (!ids.length && !pools) { body.appendChild(h('div.empty', h('span.ico', '📦'), 'Magazyn jest pusty.')); return; }
      if (pools) {
        for (const pl of pools) {
          if (!pl.items.length && !pl.cap) continue;
          const c = h('div.card');
          c.appendChild(h('div.row.between', h('div.b', pl.name), h('div.small.num.muted', G.fmtNum(pl.used, 0) + ' / ' + G.fmtNum(pl.cap, 0) + ' ' + pl.unit)));
          c.appendChild(h('div.bar.thin' + (pl.used / (pl.cap || 1) > 0.9 ? '.red' : ''), { style: { margin: '6px 0' } }, h('i', { style: { width: Math.round(Math.min(1, pl.used / (pl.cap || 1)) * 100) + '%' } })));
          if (pl.covered < pl.used) c.appendChild(h('div.tiny.warn', 'Pod dachem mieści się ' + G.fmtNum(pl.covered, 0) + ' ' + pl.unit + ' — reszta ' + (pl.baseNote || 'na zewnątrz') + ' (straty)'));
          for (const it of pl.items) c.appendChild(invRow(it.id, it.qty));
          if (!pl.items.length) c.appendChild(h('div.small.dim', 'pusto'));
          body.appendChild(c);
        }
      } else { const c = h('div.card'); for (const id of ids) c.appendChild(invRow(id, inv[id])); body.appendChild(c); }
      body.appendChild(h('div.row', { style: { marginTop: '10px' } }, h('button.btn.grow', { onclick: () => U.open('market') }, '💰 Sprzedaj / kup'), h('button.btn.grow', { onclick: () => U.open('build') }, '🏗️ Więcej miejsca')));
    }
  });
  function invRow(id, qty) {
    const pr = P(id), price = G.market && G.market.canSell && G.market.canSell(id) ? G.market.price(id) : null;
    return h('div.row.between.small', { style: { padding: '4px 0' } }, h('span', picon(id) + ' ' + pr.name), h('span.num', h('b', G.fmtQty(id, qty)), price ? h('span.muted', ' ≈ ' + money(qty * price)) : null));
  }

  // =====================================================================================================
  // RYNEK
  // =====================================================================================================
  const MCATS = [{ id: 'sell', label: '🌾 Skup' }, { id: 'shop', label: '🛒 Sklep' }, { id: 'contracts', label: '✍️ Umowy' }, { id: 'loans', label: '🏦 Kredyty' }, { id: 'subs', label: '🇪🇺 Dopłaty' }];
  U.panel('market', {
    title: 'Rynek', live: 3000,
    sub: () => { const d = G.date(); return G.MONTHS[d.month] + ' · ceny zmieniają się codziennie'; },
    render(body, arg, ctx) {
      const st = ctx.state; if (!st.tab) st.tab = (arg && arg.tab) || 'sell'; if (arg && arg.product && !st.consumed) { st.tab = 'sell'; st.sel = arg.product; st.consumed = true; }
      body.appendChild(tabs(MCATS, st.tab, id => { st.tab = id; st.sel = null; U.rerender(); U.scrollTop(); }));
      if (!G.market) { body.appendChild(h('div.empty', 'Rynek niedostępny')); return; }
      if (st.tab === 'sell') renderSell(body, st);
      else if (st.tab === 'shop') renderShop(body, st);
      else if (st.tab === 'contracts') renderContracts(body, st);
      else if (st.tab === 'loans') renderLoans(body, st);
      else renderSubs(body, st);
    }
  });
  function priceRow(i, onClick, sel) {
    const hist = G.market.history(i.id).map(x => x.p).slice(-30);
    return h('div.card.clickable' + (sel ? '.sel' : ''), { onclick: onClick },
      h('div.row', h('span.ico-big', i.icon), h('div.grow', h('div.b', i.name), h('div.small.muted', i.have > 0 ? 'masz ' + G.fmtQty(i.id, i.have) : i.hint || '')),
        h('div', { style: { width: '72px' } }, sparkline(hist, { h: 34 })),
        h('div.right', { style: { minWidth: '84px' } }, h('div.b.num', G.fmtNum(i.price, i.price < 20 ? 2 : 0) + ' zł'), h('div.tiny.num' + (i.change > 0 ? '.good' : i.change < 0 ? '.bad' : '.muted'), (i.change > 0 ? '▲ +' : i.change < 0 ? '▼ ' : '') + i.change + '% / 6 dni'))));
  }
  function renderSell(body, st) {
    const all = G.market.list().filter(i => i.canSell && !(P(i.id).shop));
    const have = all.filter(i => i.have > 0), rest = all.filter(i => !(i.have > 0));
    if (st.sel) {
      const i = all.find(x => x.id === st.sel) || G.market.info(st.sel);
      body.appendChild(h('button.btn.sm.ghost', { onclick: () => { st.sel = null; U.rerender(); } }, '‹ Wszystkie produkty'));
      body.appendChild(h('div.card', h('div.row', h('span.ico-big', i.icon), h('div.grow', h('div.b', i.name), h('div.small.muted', i.hint || '')), h('div.right', h('div.b.num', G.fmtNum(i.price, i.price < 20 ? 2 : 0) + ' zł/' + i.unit), h('div.tiny.muted', 'średnia ' + G.fmtNum(i.base, i.base < 20 ? 2 : 0) + ' zł · ' + (i.vsBase > 0 ? '+' : '') + i.vsBase + '%'))),
        h('div', { style: { marginTop: '8px' } }, chart([{ vals: G.market.history(i.id).map(x => x.p), color: '#e9b949' }], { h: 120 })), h('div.tiny.muted.center', 'cena skupu — ostatnie ' + G.market.history(i.id).length + ' dni')));
      if (i.have > 0) {
        const pr = P(i.id), step = pr.unit === 'szt' || pr.unit === 'bela' ? 1 : i.have > 20 ? 0.5 : 0.1;
        let q = i.have; const tot = h('div.b.num.gold', { style: { fontSize: '20px' } });
        const sl = qtySlider(i.have, step, i.have, pr.unit, v => { q = v; tot.textContent = money(v * i.price); });
        body.appendChild(h('div.card', sl.el, h('div.row.between', { style: { marginTop: '8px' } }, h('span.muted', 'Otrzymasz'), tot), h('button.btn.primary.block.big', { style: { marginTop: '8px' }, onclick: () => { const zl = G.market.sell(i.id, sl.get()); if (zl > 0) { U.sfx('coin'); U.haptic(); U.toast('💰 Sprzedano za ' + money(zl), 'money'); if (G.tutorial && G.tutorial.event) G.tutorial.event('sold'); U.rerender(); } } }, '💰 Sprzedaj')));
        const act = G.market.contracts().filter(c => c.status === 'active' && c.product === i.id);
        for (const c of act) body.appendChild(h('div.hint.good', '✍️ Umowa z ' + c.buyer + ': ' + G.fmtQty(c.product, c.remaining) + ' po ' + G.fmtNum(c.price, 0) + ' zł — dostarcz w zakładce Umowy.'));
      } else body.appendChild(h('div.hint', 'Nie masz tego produktu w magazynie.'));
      return;
    }
    if (have.length) { body.appendChild(h('div.section', 'W magazynie')); for (const i of have) body.appendChild(priceRow(i, () => { st.sel = i.id; U.rerender(); U.scrollTop(); })); }
    else body.appendChild(h('div.hint', 'Magazyn pusty — po żniwach tu sprzedasz plony. Poniżej aktualne ceny skupu.'));
    body.appendChild(h('div.section', 'Notowania skupu'));
    for (const i of rest) body.appendChild(priceRow(i, () => { st.sel = i.id; U.rerender(); U.scrollTop(); }));
  }
  function renderShop(body, st) {
    const cats = [{ id: 'nasiona', label: '🌱 Nasiona' }, { id: 'środki', label: '🧪 Nawozy i ŚOR' }, { id: 'pasza', label: '🌾 Pasze' }, { id: 'paliwo', label: '⛽ Paliwo' }];
    if (!st.scat) st.scat = 'nasiona';
    body.appendChild(tabs(cats, st.scat, id => { st.scat = id; st.sel = null; U.rerender(); }));
    const items = G.market.list().filter(i => i.canBuy && (P(i.id).cat === st.scat || (st.scat === 'pasza' && (P(i.id).feed || P(i.id).cat === 'zboże') && !P(i.id).shop)));
    for (const i of items) {
      const sel = st.sel === i.id;
      const c = h('div.card' + (sel ? '.sel' : ''));
      c.appendChild(h('div.row.clickable', { onclick: () => { st.sel = sel ? null : i.id; U.rerender(); } }, h('span.ico-big', i.icon), h('div.grow', h('div.b', i.name), h('div.small.muted', (i.have > 0 ? 'masz ' + G.fmtQty(i.id, i.have) + ' · ' : '') + 'miejsce: ' + (isFinite(G.inv.free(i.id)) ? G.fmtQty(i.id, G.inv.free(i.id)) : '∞'))), h('div.right', h('div.b.num', G.fmtNum(i.buy, i.buy < 20 ? 2 : 0) + ' zł/' + i.unit), h('div.tiny.muted.num' + (i.change > 0 ? ' bad' : i.change < 0 ? ' good' : ''), (i.change > 0 ? '▲ +' : i.change < 0 ? '▼ ' : '') + i.change + '%'))));
      if (sel) {
        const pr = P(i.id), free = G.inv.free(i.id), mx = Math.max(1, Math.min(isFinite(free) ? free : 1e6, Math.floor(Math.max(0, G.S.money) / i.buy) || 0));
        const step = pr.unit === 'kg' ? 50 : pr.unit === 'l' ? (i.buy > 20 ? 5 : 100) : pr.unit === 'szt' || pr.unit === 'bela' ? 1 : mx > 20 ? 1 : 0.1;
        const init = Math.min(mx, pr.unit === 'kg' ? 500 : pr.unit === 'l' ? (i.buy > 20 ? 10 : 500) : mx > 20 ? 10 : 1);
        const tot = h('div.b.num', { style: { fontSize: '18px' } });
        const sl = qtySlider(Math.max(step, Math.floor(mx / step) * step), step, Math.floor(init / step) * step || step, pr.unit, v => { tot.textContent = money(v * i.buy); }, false);
        c.appendChild(h('div', { style: { marginTop: '8px' } }, sl.el, h('div.row.between', h('span.muted', 'Do zapłaty'), tot), h('button.btn.primary.block', { style: { marginTop: '8px' }, onclick: () => { if (G.market.buy(i.id, sl.get())) { U.sfx('coin'); U.toast('🛒 Kupiono ' + G.fmtQty(i.id, sl.get()) + ' ' + i.name.toLowerCase(), 'good'); U.rerender(); } } }, '🛒 Kup')));
      }
      body.appendChild(c);
    }
    if (st.scat === 'paliwo' && G.machines && G.machines.fuelPrice) body.appendChild(h('div.hint', 'Dostawa hurtowa do zbiornika: ' + G.fmtNum(G.machines.fuelPrice(), 2) + ' zł/l. Gdy zbiornik pusty, maszyny tankują na stacji po ' + G.fmtNum(G.machines.stationPrice(), 2) + ' zł/l.'));
    if (!items.length) body.appendChild(h('div.empty', 'Brak produktów w tej kategorii'));
  }
  function renderContracts(body) {
    const cs = G.market.contracts();
    const act = cs.filter(c => c.status === 'active'), off = cs.filter(c => c.status === 'offer'), old = cs.filter(c => c.status !== 'active' && c.status !== 'offer');
    if (!cs.length) body.appendChild(h('div.empty', h('span.ico', '✍️'), 'Brak umów. Oferty kontraktacji pojawiają się co miesiąc.'));
    if (act.length) body.appendChild(h('div.section', 'Aktywne umowy'));
    for (const c of act) {
      const card = h('div.card' + (c.daysLeft < 6 && c.have < c.remaining ? '.warn' : ''));
      card.appendChild(h('div.row.between', h('div', h('div.b', c.icon + ' ' + c.productName + ' — ' + c.buyer), h('div.small.muted', G.fmtQty(c.product, c.qty) + ' po ' + G.fmtNum(c.price, 0) + ' zł/' + c.unit + ' · termin ' + c.dueText + ' (' + c.daysLeft + ' dni)')), h('div.right', h('div.b.num', money(c.value)), h('div.tiny.muted', 'skup teraz ' + G.fmtNum(c.marketPrice, 0) + ' zł'))));
      card.appendChild(h('div.bar.thin.green', { style: { margin: '6px 0' } }, h('i', { style: { width: Math.round(c.delivered / c.qty * 100) + '%' } })));
      card.appendChild(h('div.row.between.small', h('span.muted', 'dostarczono ' + G.fmtQty(c.product, c.delivered) + ' · w magazynie ' + G.fmtQty(c.product, c.have)), h('span.muted', 'kara ' + money(c.penalty))));
      if (c.have > 0 && c.remaining > 0) card.appendChild(h('button.btn.primary.block', { style: { marginTop: '8px' }, onclick: () => { const zl = G.market.deliver(c.id); if (zl > 0) { U.sfx('coin'); U.toast('🚚 Dostarczono za ' + money(zl), 'money'); U.rerender(); } } }, '🚚 Dostarcz ' + G.fmtQty(c.product, Math.min(c.have, c.remaining))));
      body.appendChild(card);
    }
    if (off.length) body.appendChild(h('div.section', 'Oferty'));
    for (const c of off) {
      const better = c.price > c.marketPrice;
      body.appendChild(h('div.card', h('div.row.between', h('div', h('div.b', c.icon + ' ' + c.productName + ' — ' + c.buyer), h('div.small.muted', c.text + (c.note ? ' · ' + c.note : ''))), h('div.right', h('div.b.num' + (better ? '.good' : ''), G.fmtNum(c.price, 0) + ' zł/' + c.unit), h('div.tiny.muted', 'skup ' + G.fmtNum(c.marketPrice, 0) + ' zł'))),
        h('div.small.muted', { style: { marginTop: '4px' } }, 'Wartość ' + money(c.value) + ' · kara za niedostarczenie ' + money(c.penalty) + ' · oferta ważna ' + c.expires + ' dni'),
        h('div.row', { style: { marginTop: '8px' } }, h('button.btn.sm.ghost', { onclick: () => { G.market.decline(c.id); U.rerender(); } }, 'Odrzuć'), h('button.btn.sm.primary.grow', { onclick: () => { if (U.result(G.market.accept(c.id), null)) U.rerender(); } }, '✍️ Podpisz'))));
    }
    if (old.length) { body.appendChild(h('div.section', 'Zakończone')); for (const c of old.slice(0, 6)) body.appendChild(h('div.small.muted', { style: { padding: '4px 0' } }, (c.status === 'done' ? '✅ ' : '❌ ') + c.text + ' — ' + c.status)); }
  }
  function renderLoans(body, st) {
    const loans = G.market.loans(), offers = G.market.loanOffers();
    if (loans.length) body.appendChild(h('div.section', 'Twoje kredyty'));
    for (const l of loans) {
      const c = h('div.card');
      c.appendChild(h('div.row.between', h('div', h('div.b', '🏦 ' + l.name), h('div.small.muted', 'oprocentowanie ' + Math.round(l.rate * 1000) / 10 + '% · ' + l.monthsLeft + ' rat po ' + money(l.payment))), h('div.right', h('div.b.num', money(l.left)), h('div.tiny.muted', 'z ' + money(l.principal)))));
      c.appendChild(h('div.bar.thin.gold', { style: { margin: '6px 0' } }, h('i', { style: { width: Math.round((1 - l.left / l.principal) * 100) + '%' } })));
      const amt = stepper(Math.min(l.left, Math.max(1000, Math.round(l.left / 4 / 1000) * 1000)), 1000, Math.ceil(l.left), 1000, () => {});
      c.appendChild(h('div.row', { style: { marginTop: '6px' } }, amt.el, h('button.btn.sm.grow', { onclick: () => { if (U.result(G.market.repay(l.id, Math.min(amt.get(), l.left)), '✅ Spłacono część kredytu')) U.rerender(); } }, 'Nadpłać'), h('button.btn.sm.ghost', { onclick: () => U.confirm('Spłacić cały kredyt?', 'Kwota: ' + money(l.left) + '.', 'Spłać', () => { U.result(G.market.repay(l.id), null); U.rerender(); }) }, 'Całość')));
      body.appendChild(c);
    }
    if (G.market.debt) body.appendChild(h('div.row.between.small.muted', { style: { padding: '4px 2px' } }, h('span', 'Łączne zadłużenie'), h('span.b.num', money(G.market.debt()))));
    body.appendChild(h('div.section', 'Oferta banku'));
    for (const o of offers) {
      if (o.landOnly) { body.appendChild(h('div.card', h('div.b', '🏡 ' + o.name), h('div.small.muted', o.desc + ' Dostępny przy zakupie działki (zakładka Ziemia).'))); continue; }
      const c = h('div.card');
      c.appendChild(h('div.b', '🏦 ' + o.name));
      c.appendChild(h('div.small.muted', o.desc + ' Oprocentowanie ' + Math.round(o.rate * 1000) / 10 + '%, ' + o.months + ' rat. Zdolność: do ' + money(o.max) + '.'));
      if (o.max >= 1000) {
        const init = Math.min(o.max, 20000); let amt = init;
        const rata = h('span.b.num');
        const upd = v => { amt = v; const r = o.rate / 12, n = o.months; rata.textContent = money(r ? v * r / (1 - Math.pow(1 + r, -n)) : v / n) + '/mies.'; };
        const inp = h('input', { type: 'range', min: 1000, max: o.max, step: 1000, value: init, oninput: e => upd(+e.target.value) });
        const lbl = h('div.row.between', h('span.b.num#loan-amt-' + o.type), rata);
        inp.addEventListener('input', () => { lbl.firstChild.textContent = money(amt); });
        c.appendChild(h('div.nolive', { style: { marginTop: '6px' } }, lbl, inp));
        upd(init); lbl.firstChild.textContent = money(init);
        c.appendChild(h('button.btn.primary.block', { onclick: () => U.confirm('Wziąć ' + o.name.toLowerCase() + '?', 'Kwota ' + money(amt) + ', rata ' + rata.textContent + ' przez ' + o.months + ' miesięcy.', 'Biorę', () => { U.result(G.market.takeLoan(o.type, amt), null); U.rerender(); }) }, '🏦 Weź kredyt'));
      } else c.appendChild(h('div.hint.warn', 'Bank nie udzieli teraz kredytu — za duże zadłużenie.'));
      body.appendChild(c);
    }
    void st;
  }
  function renderSubs(body) {
    const pv = G.market.subsidyPreview(), tx = G.market.taxPreview ? G.market.taxPreview() : null;
    body.appendChild(h('div.grid2', h('div.stat', h('div.l', 'Dopłaty ' + pv.year), h('div.v.good', money(pv.total))), h('div.stat', h('div.l', 'Wypłata'), h('div.v', '1 grudnia'))));
    for (const it of pv.items) body.appendChild(h('div.card' + (it.ok ? '' : ''), h('div.row.between', h('div', h('div.b', (it.ok ? '✅ ' : '⬜ ') + it.name), h('div.small.muted', it.hint)), h('div.right', h('div.b.num' + (it.ok ? '.good' : '.muted'), money(it.amount)), h('div.tiny.muted.num', G.fmtNum(it.ha, 2) + ' ha × ' + it.rate + ' zł')))));
    if (tx) body.appendChild(h('div.hint', '🧾 Podatek rolny: ' + money(tx.tax) + '/rok (' + G.fmtNum(tx.haPrzel, 2) + ' ha przeliczeniowych, płatny w marcu) · KRUS ' + money(tx.krusQuarter) + '/kwartał.'));
  }

  // =====================================================================================================
  // FINANSE
  // =====================================================================================================
  const CAT_ICON = { 'sprzedaż': '💰', 'dopłaty': '🇪🇺', 'usługi': '📞', 'zakup maszyn': '🚜', 'serwis': '🔧', 'paliwo': '⛽', 'nasiona': '🌱', 'nawozy': '🧂', 'środki ochrony': '🧴', 'pasze': '🌾', 'zwierzęta': '🐄', 'budowa': '🏗️', 'płace': '👷', 'ziemia': '🏞️', 'dzierżawa': '📝', 'kredyt': '🏦', 'odsetki': '📉', 'wynajem': '🔑', 'inne': '📎' };
  U.panel('finance', {
    title: 'Finanse', live: 3000,
    sub: () => 'saldo ' + money(G.S.money),
    render(body, arg, ctx) {
      const st = ctx.state; if (!st.tab) st.tab = 'overview';
      body.appendChild(tabs([{ id: 'overview', label: '📊 Przegląd' }, { id: 'ledger', label: '📒 Księga' }, { id: 'loans', label: '🏦 Kredyty' }], st.tab, id => { st.tab = id; U.rerender(); }));
      if (st.tab === 'loans') { renderLoans(body, st); return; }
      if (st.tab === 'ledger') { renderLedger(body, st); return; }
      const S = G.S, t = S.today, bal = t.income - t.expense;
      body.appendChild(h('div.grid3', h('div.stat', h('div.l', 'Saldo'), h('div.v' + (S.money < 0 ? '.bad' : ''), money(S.money))), h('div.stat', h('div.l', 'Dziś +'), h('div.v.good', money(t.income))), h('div.stat', h('div.l', 'Dziś −'), h('div.v.bad', money(t.expense)))));
      const daily = S.daily.slice(-36);
      if (daily.length > 1) {
        body.appendChild(h('div.section', 'Saldo — ostatnie ' + daily.length + ' dni'));
        body.appendChild(h('div.card', chart([{ vals: daily.map(d => d.money), color: '#e9b949' }], { h: 120, labels: daily.map((d, i) => i % 6 === 0 ? G.MONTHS[G.date(d.d * 24).month].slice(0, 3) : '') })));
        body.appendChild(h('div.section', 'Przychody i wydatki dzienne'));
        body.appendChild(h('div.card', chart([{ vals: daily.map(d => d.income), color: '#7fd47f', type: 'bar' }, { vals: daily.map(d => -d.expense), color: '#ff6f6f', type: 'bar' }], { h: 110 }), h('div.legend', h('span', h('i', { style: { background: '#7fd47f' } }), 'przychody'), h('span', h('i', { style: { background: '#ff6f6f' } }), 'wydatki'))));
      } else body.appendChild(h('div.hint', 'Wykresy pojawią się po pierwszych dniach gry.'));
      // kategorie z księgi (ostatnie 30 dni)
      const since = S.tick - 30 * 24, cats = {};
      for (const l of S.ledger) if (l.t >= since) cats[l.cat] = (cats[l.cat] || 0) + l.amt;
      const keys = Object.keys(cats).sort((a, b) => Math.abs(cats[b]) - Math.abs(cats[a]));
      if (keys.length) {
        body.appendChild(h('div.section', 'Kategorie — 30 dni'));
        const mx = Math.max(...keys.map(k => Math.abs(cats[k])));
        const c = h('div.card');
        for (const k of keys) c.appendChild(h('div.meter', h('span', (CAT_ICON[k] || '📎') + ' ' + k), h('div.bar.thin' + (cats[k] >= 0 ? '.green' : '.red'), h('i', { style: { width: Math.round(Math.abs(cats[k]) / mx * 100) + '%' } })), h('span.v' + (cats[k] >= 0 ? '.good' : '.bad'), F.signed(cats[k]))));
        body.appendChild(c);
      }
      // stałe koszty
      body.appendChild(h('div.section', 'Zobowiązania miesięczne'));
      const kv = h('div.kv');
      const wages = U.call('workers.monthlyCost', [], 0) || 0; if (wages) { kv.appendChild(h('span.k', '👷 Płace')); kv.appendChild(h('span.v.bad', money(wages))); }
      const loans = U.call('market.loans', [], []) || []; const rat = loans.reduce((a, l) => a + l.payment, 0); if (rat) { kv.appendChild(h('span.k', '🏦 Raty kredytów')); kv.appendChild(h('span.v.bad', money(rat))); }
      const leases = U.call('land.leases', [], []) || []; const lz = leases.reduce((a, l) => a + l.monthly, 0); if (lz) { kv.appendChild(h('span.k', '📝 Dzierżawy')); kv.appendChild(h('span.v.bad', money(lz))); }
      const up = (U.call('buildings.list', [], []) || []).reduce((a, b) => a + ((G.buildings.def(b) || {}).upkeep || 0), 0) * G.CFG.DAYS_PER_MONTH; if (up) { kv.appendChild(h('span.k', '🏠 Utrzymanie budynków')); kv.appendChild(h('span.v.bad', money(up))); }
      const an = U.call('animals.needs', [], null); if (an && an.costPerDay) { kv.appendChild(h('span.k', '🐄 Pasze (zakup)')); kv.appendChild(h('span.v.bad', money(an.costPerDay * G.CFG.DAYS_PER_MONTH))); }
      body.appendChild(h('div.card', kv.children.length ? kv : h('div.small.muted', 'brak stałych zobowiązań')));
      const ys = U.call('market.yearStats', [], null);
      if (ys) body.appendChild(h('div.card', h('div.b', 'Rok ' + G.date().year), h('div.kv', h('span.k', 'Sprzedaż'), h('span.v.good', money(ys.sales)), h('span.k', 'Zakupy środków'), h('span.v.bad', money(ys.buys)), h('span.k', 'Dopłaty'), h('span.v.good', money(ys.subsidies)), h('span.k', 'Odsetki'), h('span.v.bad', money(ys.interest)))));
    }
  });
  function renderLedger(body, st) {
    const cats = ['wszystko'].concat(Object.keys(CAT_ICON).filter(k => G.S.ledger.some(l => l.cat === k)));
    if (!st.cat) st.cat = 'wszystko';
    body.appendChild(tabs(cats.map(c => ({ id: c, label: c === 'wszystko' ? 'Wszystko' : (CAT_ICON[c] || '') + ' ' + c })), st.cat, id => { st.cat = id; U.rerender(); }));
    const rows = G.S.ledger.filter(l => st.cat === 'wszystko' || l.cat === st.cat);
    if (!rows.length) { body.appendChild(h('div.empty', 'Brak operacji')); return; }
    const list = h('div.list');
    let lastDay = -1;
    for (const l of rows.slice(0, 80)) {
      const d = G.date(l.t);
      if (d.dayIndex !== lastDay) { lastDay = d.dayIndex; list.appendChild(h('div.tiny.dim.b', { style: { padding: '8px 4px 2px', textTransform: 'uppercase' } }, d.dom + ' ' + G.MONTHS_GEN[d.month] + ' ' + d.year)); }
      list.appendChild(h('div.item', h('span.ico', CAT_ICON[l.cat] || '📎'), h('div.grow', h('div.small', l.note || l.cat), h('div.tiny.muted', l.cat + ' · ' + F.time(d.hour))), h('div.b.num' + (l.amt >= 0 ? '.good' : '.bad'), F.signed(l.amt))));
    }
    body.appendChild(list);
  }

  // =====================================================================================================
  // MASZYNY
  // =====================================================================================================
  U.panel('machines', {
    title: 'Maszyny', live: 3000,
    sub: () => { const M = G.machines; if (!M) return ''; return M.owned().length + ' własnych · garaż ' + G.fmtNum(M.slotsUsed(), 1) + '/' + M.slots() + ' miejsc · ON ' + G.fmtNum(G.inv.get('ON'), 0) + ' l'; },
    render(body, arg, ctx) {
      const st = ctx.state; if (!st.tab) st.tab = (arg && arg.tab) || 'own';
      if (arg && arg.op && !st.consumed) { st.tab = 'shop'; st.forOp = arg.op; st.forParams = arg.params; st.consumed = true; }
      body.appendChild(tabs([{ id: 'own', label: '🚜 Park' }, { id: 'shop', label: '🛒 Salon' }, { id: 'used', label: '♻️ Używane' }, { id: 'rent', label: '🔑 Wynajem' }, { id: 'fuel', label: '⛽ Paliwo' }], st.tab, id => { st.tab = id; st.sel = null; U.rerender(); U.scrollTop(); }));
      if (!G.machines) { body.appendChild(h('div.empty', 'Moduł maszyn niedostępny')); return; }
      if (st.tab === 'own') renderOwn(body, st);
      else if (st.tab === 'shop') renderShopM(body, st, false);
      else if (st.tab === 'used') renderUsed(body, st);
      else if (st.tab === 'rent') renderShopM(body, st, true);
      else renderFuel(body, st);
    }
  });
  const catIcon = c => ({ tractor: '🚜', combine: '🌾', header: '🔪', plow: '⛏️', cultivator: '〰️', seeder: '🌱', planter: '🥔', sprayer: '💧', spreader: '🧂', manure_spreader: '💩', mower: '✂️', rake: '🧹', baler: '🟨', trailer: '🛒', loader: '🏗️', potato_harvester: '🥔', beet_harvester: '🟣', forage_harvester: '🌽' }[c] || '⚙️');
  function machineCard(m, st) {
    const d = G.machines.def(m), status = G.machines.status(m.uid), ready = G.machines.ready(m.uid);
    const sel = st.sel === m.uid;
    const c = h('div.card' + (sel ? '.sel' : '') + (m.broken ? '.bad' : ''));
    c.appendChild(h('div.row.clickable', { onclick: () => { st.sel = sel ? null : m.uid; U.rerender(); } },
      h('span.ico-big', catIcon(d.cat)), h('div.grow', h('div.b', d.name + (m.rented ? ' 🔑' : '')), h('div.small.muted', (G.MACHINE_CATS[d.cat] || d.cat) + (d.hp ? ' · ' + d.hp + ' KM' : d.reqHp ? ' · wymaga ' + d.reqHp + ' KM' : '') + (d.width ? ' · ' + d.width + ' m' : '') + (d.cap ? ' · ' + d.cap + (d.cat === 'trailer' || d.cat === 'combine' ? ' t' : '') : ''))),
      h('div.right', h('span.tag' + (m.broken ? '.red' : m.busy ? '.blue' : m.repairUntil > G.S.tick ? '.amber' : ''), status), h('div.tiny.muted.num', { style: { marginTop: '4px' } }, 'zużycie ' + Math.round(m.wear * 100) + '%'))));
    c.appendChild(h('div.bar.thin' + (m.wear > 0.6 ? '.red' : m.wear > 0.35 ? '.gold' : '.green'), { style: { marginTop: '6px' } }, h('i', { style: { width: Math.round(m.wear * 100) + '%' } })));
    if (sel) {
      const box = h('div', { style: { marginTop: '8px' } });
      box.appendChild(h('div.small.muted', d.desc || ''));
      const kv = h('div.kv', { style: { marginTop: '6px' } });
      kv.appendChild(h('span.k', 'Rocznik')); kv.appendChild(h('span.v', m.year || '—'));
      kv.appendChild(h('span.k', 'Motogodziny')); kv.appendChild(h('span.v', G.fmtNum(m.hours, 0) + ' / ' + G.fmtNum(G.machines.life(d), 0)));
      if (d.fuelLph) { kv.appendChild(h('span.k', 'Spalanie')); kv.appendChild(h('span.v', d.fuelLph + ' l/h')); }
      kv.appendChild(h('span.k', 'Wartość')); kv.appendChild(h('span.v', money(G.machines.value(m))));
      if (m.rented) { kv.appendChild(h('span.k', 'Wynajem do')); kv.appendChild(h('span.v', G.dateText(m.until))); }
      kv.appendChild(h('span.k', 'Postój')); kv.appendChild(h('span.v', m.stored ? 'w garażu' : 'pod chmurką (szybsze zużycie)'));
      box.appendChild(kv);
      if (!ready.ok) box.appendChild(h('div.hint.warn', ready.reason));
      const row = h('div.row.wrap', { style: { marginTop: '8px' } });
      const q = G.machines.repairQuote(m.uid);
      if (q && (q.needed || m.wear > 0.15) && !(m.repairUntil > G.S.tick)) row.appendChild(h('button.btn.sm' + (q.needed ? '.good' : ''), { onclick: () => { if (U.result(G.machines.repair(m.uid), null)) U.rerender(); } }, '🔧 ' + (m.broken ? 'Napraw' : 'Przegląd') + ' ' + money(q.cost), h('span.sub', '→ ' + Math.round(q.wearAfter * 100) + '% · ' + q.hours + ' h')));
      if (m.rented) {
        row.appendChild(h('button.btn.sm', { onclick: () => { const qq = G.machines.rentQuote(m.id, 3); U.confirm('Przedłużyć wynajem o 3 dni?', 'Koszt ' + money(qq.total) + '.', 'Przedłuż', () => { U.result(G.machines.extendRent(m.uid, 3), null); U.rerender(); }); } }, '🔑 Przedłuż +3 dni'));
        row.appendChild(h('button.btn.sm.danger', { onclick: () => { U.result(G.machines.returnRented(m.uid), null); U.rerender(); } }, 'Zwróć'));
      } else row.appendChild(h('button.btn.sm.danger', { onclick: () => U.confirm('Sprzedać ' + d.name + '?', 'Otrzymasz ' + money(G.machines.sellQuote(m.uid)) + '.', 'Sprzedaj', () => { U.result(G.machines.sell(m.uid), null); U.rerender(); }) }, '💸 Sprzedaj ' + money(G.machines.sellQuote(m.uid))));
      row.appendChild(h('button.btn.sm.ghost', { onclick: () => { const v = (U.call('jobs.vehicles', [], []) || []).find(x => x.uid === m.uid) || (U.call('jobs.vehicles', [], []) || []).find(x => x.jobUid === m.busy); if (v) { U.centerOn(v.x, v.y, true); U.selectVehicle(v, false); if (U.isMobile()) U.close(); } else U.toast('Maszyna stoi w garażu', 'info'); } }, '🎯 Pokaż'));
      box.appendChild(row);
      c.appendChild(box);
    }
    return c;
  }
  function renderOwn(body, st) {
    const list = G.machines.list();
    if (!list.length) { body.appendChild(h('div.empty', h('span.ico', '🚜'), 'Nie masz maszyn. Zajrzyj do salonu albo wynajmij — na start zabiegi zleca się też usługodawcom.')); return; }
    const broken = list.filter(m => m.broken); if (broken.length) body.appendChild(h('div.hint.bad', '⚠️ Awaria: ' + broken.map(m => G.machines.def(m).name).join(', ') + ' — napraw, żeby wrócić do pracy.'));
    const slots = G.machines.slots(), used = G.machines.slotsUsed(); if (used > slots) body.appendChild(h('div.hint.warn', 'Brak miejsca w garażu (' + G.fmtNum(used, 1) + '/' + slots + ') — maszyny pod chmurką zużywają się szybciej. Rozbuduj garaż.'));
    const groups = {};
    for (const m of list) { const d = G.machines.def(m); (groups[d.cat] = groups[d.cat] || []).push(m); }
    for (const cat of Object.keys(G.MACHINE_CATS)) { if (!groups[cat]) continue; body.appendChild(h('div.section', G.MACHINE_CATS[cat])); for (const m of groups[cat]) body.appendChild(machineCard(m, st)); }
  }
  function shopCard(d, st, rent) {
    const sel = st.sel === d.id;
    const c = h('div.card' + (sel ? '.sel' : ''));
    const afford = G.finance.canAfford(d.price);
    c.appendChild(h('div.row.clickable', { onclick: () => { st.sel = sel ? null : d.id; U.rerender(); } },
      h('span.ico-big', catIcon(d.cat)), h('div.grow', h('div.b', d.name), h('div.small.muted', d.brand + (d.hp ? ' · ' + d.hp + ' KM' : d.reqHp ? ' · od ' + d.reqHp + ' KM' : '') + (d.width ? ' · ' + d.width + ' m' : '') + (d.cap ? ' · ' + d.cap + (d.cat === 'trailer' ? ' t' : d.cat === 'combine' ? ' t zb.' : '') : '') + (d.axle ? ' · ' + d.axle : ''))),
      h('div.right', h('div.b.num' + (rent ? '' : afford ? '' : '.bad'), rent ? money(d.rentPerDay) + '/dzień' : money(d.price)), d.rentPerDay && !rent ? h('div.tiny.muted', 'wynajem ' + money(d.rentPerDay) + '/d') : null)));
    if (sel) {
      const box = h('div', { style: { marginTop: '8px' } });
      box.appendChild(h('div.small.muted', d.desc || ''));
      const kv = h('div.kv', { style: { marginTop: '6px' } });
      if (d.ops && d.ops.length) { kv.appendChild(h('span.k', 'Zabiegi')); kv.appendChild(h('span.v', d.ops.map(o => U.call('jobs.opName', [o], o)).join(', '))); }
      if (d.crops) { kv.appendChild(h('span.k', 'Uprawy')); kv.appendChild(h('span.v', d.crops.map(x => G.CROPS[x] ? G.CROPS[x].short : x).join(', '))); }
      if (d.speed) { kv.appendChild(h('span.k', 'Wydajność')); kv.appendChild(h('span.v', G.fmtNum((d.width || 0) * d.speed / 10 * 0.8, 2) + ' ha/h')); }
      if (d.fuelLph) { kv.appendChild(h('span.k', 'Spalanie')); kv.appendChild(h('span.v', d.fuelLph + ' l/h')); }
      if (d.header) { kv.appendChild(h('span.k', 'W zestawie')); kv.appendChild(h('span.v', G.MACHINES[d.header].name)); }
      box.appendChild(kv);
      if (d.reqHp) { const trs = G.machines.list().filter(m => G.machines.def(m).cat === 'tractor' && G.machines.def(m).hp >= d.reqHp); box.appendChild(h('div.hint' + (trs.length ? '.good' : '.warn'), trs.length ? '✅ Pasuje do: ' + trs.map(m => G.machines.def(m).name).join(', ') : '⚠️ Żaden Twój ciągnik nie ma ' + d.reqHp + ' KM')); }
      const row = h('div.row.wrap', { style: { marginTop: '8px' } });
      if (rent) {
        const days = stepper(st.rentDays || 3, 1, 30, 1, v => { st.rentDays = v; const q = G.machines.rentQuote(d.id, v); btn.textContent = '🔑 Wynajmij za ' + money(q.total); });
        const btn = h('button.btn.sm.primary.grow', { onclick: () => { if (U.result(G.machines.rent(d.id, days.get()), null)) { U.sfx('coin'); U.rerender(); } } }, '🔑 Wynajmij za ' + money(G.machines.rentQuote(d.id, days.get()).total));
        row.appendChild(h('span.small.muted', 'dni:')); row.appendChild(days.el); row.appendChild(btn);
        const q = G.machines.rentQuote(d.id, days.get()); if (q.discount) box.appendChild(h('div.tiny.good', 'Rabat ' + Math.round(q.discount * 100) + '% za dłuższy wynajem'));
      } else {
        row.appendChild(h('button.btn.sm.primary.grow' + (afford ? '' : '.disabled'), { disabled: !afford, onclick: () => U.confirm('Kupić ' + d.name + '?', 'Cena ' + money(d.price) + '.', 'Kup', () => { if (U.result(G.machines.buy(d.id), null)) { U.sfx('coin'); U.haptic(); U.rerender(); } }) }, '🛒 Kup za ' + money(d.price)));
        if (!afford) row.appendChild(h('button.btn.sm', { onclick: () => U.open('finance', { tab: 'loans' }) }, '🏦 Kredyt'));
      }
      box.appendChild(row);
      c.appendChild(box);
    }
    return c;
  }
  function renderShopM(body, st, rent) {
    const catList = [{ id: 'all', label: 'Wszystko' }].concat(Object.keys(G.MACHINE_CATS).map(c => ({ id: c, label: catIcon(c) + ' ' + G.MACHINE_CATS[c] })));
    if (!st.cat) st.cat = 'all';
    if (st.forOp) {
      const fit = G.machines.catalogFor(st.forOp, st.forParams || {});
      body.appendChild(h('div.hint', 'Maszyny do zabiegu: ' + U.call('jobs.opName', [st.forOp], st.forOp) + ' ', h('button.btn.xs.ghost', { onclick: () => { st.forOp = null; U.rerender(); } }, '✕ pokaż wszystkie')));
      for (const d of fit.filter(d => rent ? d.rentPerDay > 0 : !d.usedOnly)) body.appendChild(shopCard(d, st, rent));
      return;
    }
    body.appendChild(tabs(catList, st.cat, id => { st.cat = id; st.sel = null; U.rerender(); }));
    let items = Object.values(G.MACHINES).filter(d => (st.cat === 'all' || d.cat === st.cat) && (rent ? d.rentPerDay > 0 : !d.usedOnly) && d.cat !== 'header');
    items.sort((a, b) => a.cat.localeCompare(b.cat) || a.price - b.price);
    if (rent) body.appendChild(h('div.hint', 'Wynajem bez operatora: rabat 15% od 6 dni, 30% od 18 dni. Naprawy pokrywa wypożyczalnia.'));
    let lastCat = null;
    for (const d of items) { if (st.cat === 'all' && d.cat !== lastCat) { lastCat = d.cat; body.appendChild(h('div.section', G.MACHINE_CATS[d.cat])); } body.appendChild(shopCard(d, st, rent)); }
    if (!items.length) body.appendChild(h('div.empty', 'Brak maszyn w tej kategorii'));
  }
  function renderUsed(body, st) {
    const offers = G.machines.usedOffers();
    body.appendChild(h('div.hint', 'Ogłoszenia zmieniają się co 3 dni. Używane maszyny są tańsze, ale bardziej zużyte — sprawdź przebieg.'));
    if (!offers.length) { body.appendChild(h('div.empty', 'Brak ogłoszeń')); return; }
    for (const o of offers) {
      const d = G.MACHINES[o.id], sel = st.sel === o.oid;
      const c = h('div.card' + (sel ? '.sel' : ''));
      c.appendChild(h('div.row.clickable', { onclick: () => { st.sel = sel ? null : o.oid; U.rerender(); } }, h('span.ico-big', catIcon(d.cat)), h('div.grow', h('div.b', d.name), h('div.small.muted', 'rocznik ' + o.year + ' · ' + G.fmtNum(o.hours, 0) + ' mth · zużycie ' + Math.round(o.wear * 100) + '%')), h('div.right', h('div.b.num', money(o.price)), h('div.tiny.muted', 'nowa ' + money(d.price)))));
      c.appendChild(h('div.bar.thin' + (o.wear > 0.5 ? '.red' : '.gold'), { style: { marginTop: '6px' } }, h('i', { style: { width: Math.round(o.wear * 100) + '%' } })));
      if (sel) c.appendChild(h('div', { style: { marginTop: '8px' } }, h('div.small.muted', d.desc || ''), h('button.btn.sm.primary.block', { style: { marginTop: '8px' }, disabled: !G.finance.canAfford(o.price), onclick: () => { if (U.result(G.machines.buyUsed(o.oid), null)) { U.sfx('coin'); U.rerender(); } } }, '🛒 Kup za ' + money(o.price))));
      body.appendChild(c);
    }
  }
  function renderFuel(body) {
    const have = G.inv.get('ON'), free = G.inv.free('ON'), cap = G.inv.capacity('ON'), price = G.machines.fuelPrice();
    body.appendChild(h('div.grid3', h('div.stat', h('div.l', 'W zbiorniku'), h('div.v', G.fmtNum(have, 0) + ' l')), h('div.stat', h('div.l', 'Pojemność'), h('div.v', isFinite(cap) ? G.fmtNum(cap, 0) + ' l' : '∞')), h('div.stat', h('div.l', 'Cena hurt'), h('div.v', G.fmtNum(price, 2) + ' zł'))));
    body.appendChild(h('div.bar', { style: { margin: '10px 0' } }, h('i', { style: { width: (isFinite(cap) && cap ? Math.round(have / cap * 100) : 0) + '%' } })));
    if (free > 0) {
      let q = Math.min(free, 500); const tot = h('span.b.num');
      const sl = qtySlider(Math.floor(free), 10, Math.floor(q / 10) * 10 || 10, 'l', v => { q = v; tot.textContent = money(v * price); });
      body.appendChild(h('div.card', sl.el, h('div.row.between', h('span.muted', 'Do zapłaty'), tot), h('button.btn.primary.block', { style: { marginTop: '8px' }, onclick: () => { if (U.result(G.machines.buyFuel(sl.get()), '⛽ Dostarczono paliwo')) U.rerender(); } }, '⛽ Zamów dostawę')));
    } else body.appendChild(h('div.hint.warn', 'Zbiornik pełny. Większy zbiornik: stacja paliw w zakładce Budowa.'));
    body.appendChild(h('div.hint', 'Gdy zabraknie ON w zbiorniku, maszyny tankują na stacji po ' + G.fmtNum(G.machines.stationPrice(), 2) + ' zł/l (+25%).'));
  }

  // =====================================================================================================
  // LUDZIE
  // =====================================================================================================
  U.panel('people', {
    title: 'Ludzie', live: 3000,
    sub: () => { const W = G.workers; return W ? W.list().length + ' osób · płace ' + money(W.monthlyCost()) + '/mies.' : ''; },
    render(body, arg, ctx) {
      const st = ctx.state; if (!st.tab) st.tab = 'team';
      body.appendChild(tabs([{ id: 'team', label: '👷 Zespół' }, { id: 'hire', label: '🤝 Kandydaci' }], st.tab, id => { st.tab = id; U.rerender(); }));
      if (!G.workers) { body.appendChild(h('div.empty', 'Moduł pracowników niedostępny')); return; }
      if (st.tab === 'hire') {
        const cands = G.workers.candidates();
        body.appendChild(h('div.hint', 'Nowi kandydaci co 2 dni. Sezonowi są drożsi za dzień, ale bez zobowiązań. Umiejętności: 🌾 polowe (tempo i jakość), 🔧 mechaniczne (mniejsze zużycie), 🐄 hodowlane.'));
        if (!cands.length) body.appendChild(h('div.empty', 'Brak kandydatów — zajrzyj za kilka dni'));
        for (const c of cands) body.appendChild(h('div.card', h('div.row.between', h('div', h('div.b', c.name + ', ' + c.age + ' l.'), h('div.small.muted', c.trait)), h('div.right', h('div.b.num', money(c.wage) + '/dzień'), h('div.tiny.muted', c.contract === 'sezon' ? 'sezonowo, ' + c.days + ' dni' : 'etat · ' + money(c.monthly) + '/mies.'))),
          h('div.row.small', { style: { marginTop: '6px', gap: '14px' } }, h('span', { html: '🌾 ' + F.stars(c.skills.field) }), h('span', { html: '🔧 ' + F.stars(c.skills.mech) }), h('span', { html: '🐄 ' + F.stars(c.skills.animals) })),
          h('button.btn.sm.primary.block', { style: { marginTop: '8px' }, onclick: () => { if (U.result(G.workers.hire(c.cid), null)) { U.haptic(); U.rerender(); } } }, '🤝 Zatrudnij')));
        return;
      }
      const ws = G.workers.list();
      const br = G.workers.barnReport ? G.workers.barnReport() : null;
      if (br && br.need > 0) body.appendChild(h('div.hint' + (br.ratio < 0.8 ? '.warn' : ''), '🐄 Obrządek: potrzeba ' + G.fmtNum(br.need, 1) + ' h/dzień, obsadzone ' + Math.round(br.ratio * 100) + '%.'));
      for (const w of ws) {
        const c = h('div.card');
        c.appendChild(h('div.row.between', h('div', h('div.b', (w.isPlayer ? '👨‍🌾 ' : '👷 ') + w.name + (w.isPlayer ? ' (gospodarz)' : '')), h('div.small.muted', w.age + ' l. · ' + (w.isPlayer ? 'bez pensji' : money(w.wage) + '/dzień · ' + (w.contract === 'sezon' ? 'do ' + G.dateText(w.until) : 'etat')) + (w.trait ? ' · ' + w.trait : ''))), h('span.tag' + (w.busy ? '.blue' : ''), w.busy ? 'w pracy' : G.workers.inBarn && G.workers.inBarn(w.uid) ? 'obrządek' : 'wolny')));
        c.appendChild(h('div.row.small', { style: { marginTop: '6px', gap: '14px' } }, h('span', { html: '🌾 ' + F.stars(w.skills.field) }), h('span', { html: '🔧 ' + F.stars(w.skills.mech) }), h('span', { html: '🐄 ' + F.stars(w.skills.animals) })));
        c.appendChild(meter('Energia', w.energy, 1, Math.round(w.energy * 100) + '%', w.energy < 0.3 ? 'red' : 'green'));
        const seg = h('div.seg', { style: { marginTop: '6px' } });
        for (const [r, l] of [['any', 'Wszystko'], ['field', 'Pole'], ['barn', 'Obora']]) seg.appendChild(h('button' + (w.role === r ? '.on' : ''), { onclick: () => { G.workers.setRole(w.uid, r); U.rerender(); } }, l));
        const row = h('div.row.between', { style: { marginTop: '6px' } }, seg);
        if (!w.isPlayer) row.appendChild(h('button.btn.sm.danger', { onclick: () => U.confirm('Zwolnić ' + w.name + '?', 'Rozliczysz zaległe wynagrodzenie.', 'Zwolnij', () => { U.result(G.workers.fire(w.uid), null); U.rerender(); }) }, 'Zwolnij'));
        c.appendChild(row);
        body.appendChild(c);
      }
      body.appendChild(h('button.btn.block', { style: { marginTop: '8px' }, onclick: () => { st.tab = 'hire'; U.rerender(); } }, '🤝 Zatrudnij kogoś'));
    }
  });

  // =====================================================================================================
  // ZWIERZĘTA
  // =====================================================================================================
  U.panel('animals', {
    title: 'Zwierzęta', live: 3000,
    sub: () => { const s = U.call('animals.summary', [], null); return s ? s.totals.count + ' szt. · produkcja ' + money(s.totals.valueDay) + '/dzień · pasze ' + money(s.totals.feedCostDay) + '/dzień' : ''; },
    render(body, arg, ctx) {
      const st = ctx.state; if (!st.tab) st.tab = 'herds';
      body.appendChild(tabs([{ id: 'herds', label: '🐄 Stada' }, { id: 'feed', label: '🌾 Pasze' }, { id: 'buy', label: '🛒 Kup' }, { id: 'opts', label: '⚙️ Opcje' }], st.tab, id => { st.tab = id; U.rerender(); }));
      if (!G.animals) { body.appendChild(h('div.empty', 'Moduł hodowli niedostępny')); return; }
      const s = G.animals.summary();
      if (st.tab === 'herds') {
        if (!s.herds.length) body.appendChild(h('div.empty', h('span.ico', '🐄'), 'Nie masz zwierząt. Kup pierwsze w zakładce „Kup” — potrzebny jest odpowiedni budynek.'));
        for (const hd of s.herds) {
          const c = h('div.card' + (hd.warnings.length ? '.warn' : ''));
          c.appendChild(h('div.row.between', h('div.row', h('span.ico-big', hd.icon), h('div', h('div.b', hd.count + ' × ' + hd.plural + (hd.breedName ? ' (' + hd.breedName + ')' : '')), h('div.small.muted', hd.buildingName + (hd.young ? ' · młode: ' + hd.young : '')))), h('div.right', h('div.b.num.good', '+' + money(hd.valueDay) + '/d'), h('div.tiny.muted', 'pasza ' + money(hd.feedCostDay) + '/d'))));
          c.appendChild(meter('Zdrowie', hd.health, 1, Math.round(hd.health * 100) + '%', hd.health < 0.6 ? 'red' : 'green'));
          c.appendChild(meter('Żywienie', hd.fed, 1, Math.round(hd.fed * 100) + '%', hd.fed < 0.85 ? 'red' : 'green'));
          c.appendChild(meter('Obsługa', hd.care, 1, Math.round(hd.care * 100) + '%', hd.care < 0.8 ? 'red' : 'blue'));
          if (hd.avgWeight != null) c.appendChild(meter('Waga', hd.avgWeight, hd.sellWeight, hd.avgWeight + ' / ' + hd.sellWeight + ' kg', 'gold'));
          if (hd.henWeeks) c.appendChild(h('div.small.muted', 'Wiek niosek: ' + hd.henWeeks + ' tyg.' + (hd.henWeeks > 70 ? ' — nieśność spada, warto wymienić' : '')));
          const prod = Object.keys(hd.prodDay || {}).filter(k => hd.prodDay[k] > 0); if (prod.length) c.appendChild(h('div.small.muted', 'Produkcja: ' + prod.map(k => G.fmtQty(k, hd.prodDay[k]) + ' ' + pname(k).toLowerCase()).join(', ') + '/dzień'));
          if (hd.ready) c.appendChild(h('div.hint.good', '✅ Gotowe do sprzedaży: ' + hd.ready + ' szt.' + (hd.daysToSell ? '' : '')));
          else if (hd.daysToSell != null) c.appendChild(h('div.small.muted', 'Do wagi sprzedaży ~' + hd.daysToSell + ' dni'));
          for (const w of hd.warnings) c.appendChild(h('div.small.warn', '⚠️ ' + w));
          const row = h('div.row.wrap', { style: { marginTop: '8px' } });
          if (hd.sick && !hd.sick.treated) row.appendChild(h('button.btn.sm.good', { onclick: () => { if (U.result(G.animals.treat(hd.uid), '🩺 Weterynarz wezwany')) U.rerender(); } }, '🩺 Lecz'));
          const n = stepper(Math.min(hd.count, hd.ready || 1), 1, hd.count, 1, () => {});
          row.appendChild(n.el);
          row.appendChild(h('button.btn.sm.grow', { onclick: () => U.confirm('Sprzedać ' + n.get() + ' szt.?', 'Sprzedaż do skupu po cenie rynkowej.', 'Sprzedaj', () => { const r = G.animals.sell(hd.uid, n.get()); if (U.result(r, null)) { U.sfx('coin'); U.toast('💰 Sprzedano za ' + money(r.zl || 0), 'money'); U.rerender(); } }) }, '💸 Sprzedaj'));
          c.appendChild(row);
          body.appendChild(c);
        }
        if (s.pasture && s.pasture.ha) body.appendChild(h('div.hint', '🌿 Pastwisko: ' + F.ha(s.pasture.ha) + (s.pasture.season ? ' — wypas pokrywa ' + Math.round(s.pasture.frac * 100) + '% paszy objętościowej' : ' — poza sezonem')));
      } else if (st.tab === 'feed') {
        const nd = G.animals.needs();
        if (!nd.items.length || !s.herds.length) body.appendChild(h('div.empty', 'Brak zwierząt — brak zapotrzebowania na pasze.'));
        else {
          body.appendChild(h('div.hint' + (nd.ok ? '.good' : '.warn'), nd.ok ? '✅ Dawki pokarmowe pokryte. Koszt zakupów ' + money(nd.costPerDay) + '/dzień.' : '⚠️ Niedobory: ' + nd.deficits.map(d => d.name + ' ' + Math.round(d.frac * 100) + '%').join(', ')));
          for (const it of nd.items) {
            if (!(it.perDay > 0)) continue;
            const days = it.days;
            body.appendChild(h('div.card' + (days != null && days < 3 ? '.warn' : ''), h('div.row.between', h('div', h('div.b', it.icon + ' ' + it.name), h('div.small.muted', 'zużycie ' + G.fmtQty(it.id, it.perDay) + '/dzień')), h('div.right', h('div.b.num', 'zapas ' + G.fmtQty(it.id, it.stock)), h('div.tiny' + (days != null && days < 3 ? '.bad' : '.muted'), days == null ? '' : 'starczy na ' + days + ' dni'))),
              h('div.bar.thin' + (days != null && days < 3 ? '.red' : '.green'), { style: { marginTop: '6px' } }, h('i', { style: { width: Math.round(Math.min(1, (days == null ? 1 : days / 12)) * 100) + '%' } })),
              G.market && G.market.canBuy(it.id) ? h('button.btn.sm.block', { style: { marginTop: '6px' }, onclick: () => U.open('market', { tab: 'shop', product: it.id }, { push: true }) }, '🛒 Dokup') : null));
          }
        }
      } else if (st.tab === 'buy') {
        for (const sp of G.animals.catalog()) {
          const c = h('div.card' + (sp.free ? '' : ''));
          c.appendChild(h('div.row.between', h('div.row', h('span.ico-big', sp.icon), h('div', h('div.b', sp.name), h('div.small.muted', sp.desc))), h('div.right', h('div.b.num', money(sp.price) + '/szt.'), h('div.tiny' + (sp.free ? '.good' : '.muted'), sp.free ? 'wolne miejsca: ' + sp.free : 'brak miejsc'))));
          if (!sp.free) c.appendChild(h('div.row.between.small', { style: { marginTop: '6px' } }, h('span.muted', 'Potrzebny budynek: ' + sp.buildingName), h('button.btn.xs', { onclick: () => U.open('build', { type: sp.building }) }, '🏗️ Zbuduj')));
          else {
            const n = stepper(Math.min(sp.free, sp.price < 100 ? 10 : 1), 1, sp.free, 1, v => { btn.textContent = '🛒 Kup ' + v + ' za ' + money(v * (brd ? brd.price : sp.price)); });
            let brd = sp.breeds ? sp.breeds[0] : null;
            const btn = h('button.btn.sm.primary.grow', { onclick: () => { if (U.result(G.animals.buy(sp.species, n.get(), null, brd ? brd.id : null), null)) { U.sfx('coin'); U.haptic(); U.rerender(); } } }, '🛒 Kup ' + n.get() + ' za ' + money(n.get() * (brd ? brd.price : sp.price)));
            if (sp.breeds) { const chips = h('div.chips', { style: { marginTop: '6px' } }); for (const b of sp.breeds) chips.appendChild(h('button.chip.sm' + (b === brd ? '.on' : ''), { onclick: e => { brd = b; chips.querySelectorAll('.chip').forEach(x => x.classList.remove('on')); e.currentTarget.classList.add('on'); btn.textContent = '🛒 Kup ' + n.get() + ' za ' + money(n.get() * b.price); } }, b.name + ' · ' + money(b.price))); c.appendChild(chips); }
            c.appendChild(h('div.row', { style: { marginTop: '8px' } }, n.el, btn));
          }
          body.appendChild(c);
        }
      } else {
        const o = G.animals.opts();
        const OPT = [['autoBuy', 'Auto-zakup paszy treściwej', 'gdy brakuje — dokupuje zapas na 3 dni'], ['feedGrains', 'Skarmiaj własne zboże', 'zamiast paszy kupnej (gorsze przyrosty)'], ['autoSell', 'Auto-sprzedaż produktów', 'mleko, żywiec po osiągnięciu wagi'], ['autoSellEggs', 'Auto-sprzedaż jaj', 'codziennie do skupu'], ['raiseHeifers', 'Odchów jałówek', 'cielęta zostają w stadzie (gdy jest miejsce)'], ['grazing', 'Wypas na łące', 'od wiosny do jesieni, oszczędza pasze'], ['autoVet', 'Automatyczny weterynarz', 'leczy choroby od razu (płatne)']];
        const c = h('div.card');
        for (const [k, l, d] of OPT) c.appendChild(toggle(l, d, !!o[k], v => { G.animals.setOpt(k, v); }));
        body.appendChild(c);
      }
    }
  });

  // =====================================================================================================
  // BUDOWA I BUDYNKI
  // =====================================================================================================
  const BCATS = [{ id: 'all', label: 'Wszystko' }, { id: 'magazyn', label: '📦 Magazyny' }, { id: 'inwentarski', label: '🐄 Inwentarskie' }, { id: 'techniczny', label: '🔧 Techniczne' }, { id: 'produkcja', label: '🏭 Produkcja' }, { id: 'mieszkalny', label: '🏠 Dom' }];
  const bIcon = m => ({ house: '🏠', barn: '🏚️', garage: '🏗️', henhouse: '🐔', cowshed: '🐄', pigsty: '🐖', sheepfold: '🐑', silo: '🛢️', granary: '🏬', potato_store: '🥔', hayshed: '🌾', silage_clamp: '🟩', manure_pad: '💩', workshop: '🔧', fuel_station: '⛽', greenhouse: '🥬', apiary: '🐝', stable: '🐴', biogas: '⚡' }[m] || '🏗️');
  U.panel('build', {
    title: 'Budowa', live: 4000,
    sub: () => { const bl = U.call('buildings.list', [], []) || []; const b = bl.filter(x => x.progress < 1).length; return bl.length + ' budynków' + (b ? ' · ' + b + ' w budowie' : ''); },
    render(body, arg, ctx) {
      const st = ctx.state; if (!st.tab) st.tab = 'new'; if (!st.cat) st.cat = 'all';
      if (arg && arg.type && !st.consumed) { st.consumed = true; st.sel = arg.type; const T = G.BUILDINGS[arg.type]; if (T) st.cat = T.cat; }
      body.appendChild(tabs([{ id: 'new', label: '🏗️ Nowy budynek' }, { id: 'own', label: '🏠 Moje budynki' }], st.tab, id => { st.tab = id; U.rerender(); }));
      if (!G.buildings) { body.appendChild(h('div.empty', 'Moduł budynków niedostępny')); return; }
      if (st.tab === 'own') {
        for (const b of G.buildings.list()) {
          const i = G.buildings.info(b.uid);
          body.appendChild(h('div.card.clickable', { onclick: () => U.open('building', b.uid, { push: true }) }, h('div.row.between', h('div.row', h('span.ico-big', bIcon(G.BUILDINGS[b.type].model)), h('div', h('div.b', i.levelName), h('div.small.muted', i.name + ' · poz. ' + i.level + '/' + i.maxLevel + (i.building ? ' · budowa ' + Math.round(i.progress * 100) + '%' : i.upgrading ? ' · rozbudowa ' + Math.round(i.upgProgress * 100) + '%' : '')))), h('span.muted', '›')), (i.building || i.upgrading) ? h('div.bar.thin.gold', { style: { marginTop: '6px' } }, h('i', { style: { width: Math.round((i.building ? i.progress : i.upgProgress) * 100) + '%' } })) : null));
        }
        body.appendChild(h('div.section', 'Podwórze'));
        body.appendChild(h('div.card', h('div.small.muted', 'Budynki stawia się tylko na utwardzonym podwórzu. Dokupuj kafle przylegające do placu (14 000 zł za 0,25 ha gruntu, 6 000 zł za kafel własnej działki).'), h('button.btn.block', { style: { marginTop: '8px' }, onclick: U.startExpand }, '🧱 Powiększ podwórze')));
        return;
      }
      body.appendChild(tabs(BCATS, st.cat, id => { st.cat = id; st.sel = null; U.rerender(); }));
      const cat = G.buildings.catalog().filter(b => st.cat === 'all' || b.cat === st.cat);
      for (const b of cat) {
        const sel = st.sel === b.type;
        const c = h('div.card' + (sel ? '.sel' : ''));
        c.appendChild(h('div.row.clickable', { onclick: () => { st.sel = sel ? null : b.type; U.rerender(); } }, h('span.ico-big', bIcon(b.model)), h('div.grow', h('div.b', b.name), h('div.small.muted', b.size[0] + '×' + b.size[1] + ' · ' + b.buildDays + ' dni' + (b.owned ? ' · masz ' + b.owned : ''))), h('div.right', h('div.b.num' + (b.available ? '' : '.muted'), money(b.price)), !b.available ? h('div.tiny.bad', b.reason) : h('div.tiny.muted', 'utrzymanie ' + money(b.upkeep) + '/d'))));
        if (sel) {
          c.appendChild(h('div.small.muted', { style: { marginTop: '8px' } }, b.desc));
          const L = b.levels[0], fx = [];
          if (L.slots) fx.push(L.slots + ' miejsc na maszyny');
          for (const k in L.capacity) fx.push((G.BUILDING_POOLS[k] ? G.BUILDING_POOLS[k].name : k) + ' ' + G.fmtNum(L.capacity[k], 0) + ' ' + (G.BUILDING_POOLS[k] ? G.BUILDING_POOLS[k].unit : ''));
          for (const sp in L.houses) fx.push((G.ANIMALS[sp] ? G.ANIMALS[sp].plural : sp) + ': do ' + L.houses[sp]);
          if (fx.length) c.appendChild(h('div.chips', { style: { marginTop: '6px' } }, fx.map(t => h('span.chip.sm', t))));
          if (b.levels.length > 1) c.appendChild(h('div.tiny.muted', { style: { marginTop: '6px' } }, 'Rozbudowa: ' + b.levels.slice(1).map(l => l.name + ' (' + money(l.price) + ')').join(' → ')));
          c.appendChild(h('button.btn.primary.block' + (b.available ? '' : '.disabled'), { style: { marginTop: '8px' }, disabled: !b.available, onclick: () => { U.sfx('ui_confirm'); U.startPlace(b.type); } }, '📐 Wybierz miejsce'));
        }
        body.appendChild(c);
      }
    }
  });
  U.panel('building', {
    live: 2000,
    title: uid => { const i = U.call('buildings.info', [uid], null); return i ? i.levelName : 'Budynek'; },
    sub: uid => { const i = U.call('buildings.info', [uid], null); return i ? i.name + ' · poziom ' + i.level + '/' + i.maxLevel + ' · utrzymanie ' + money(i.upkeep) + '/dzień' : ''; },
    render(body, uid) {
      const i = G.buildings.info(uid); if (!i) { body.appendChild(h('div.empty', 'Budynek nie istnieje')); return; }
      const T = G.BUILDINGS[i.type];
      body.appendChild(h('div.row.between', h('span.ico-big', bIcon(T.model)), h('button.btn.sm.ghost', { onclick: () => { U.centerOn(i.footprint.x + i.footprint.w / 2, i.footprint.y + i.footprint.h / 2, true); if (U.isMobile()) { U.peek(true); setTimeout(() => U.peek(false), 1400); } } }, '🎯 Pokaż')));
      body.appendChild(h('div.small.muted', i.desc));
      if (i.building) body.appendChild(h('div.card.warn', h('div.b', '🏗️ W budowie — ' + Math.round(i.progress * 100) + '%'), h('div.bar.gold', { style: { margin: '6px 0' } }, h('i', { style: { width: Math.round(i.progress * 100) + '%' } })), h('div.small.muted', 'jeszcze ~' + i.daysLeft + ' dni')));
      if (i.upgrading) body.appendChild(h('div.card.warn', h('div.b', '🏗️ Rozbudowa — ' + Math.round(i.upgProgress * 100) + '%'), h('div.bar.gold', { style: { margin: '6px 0' } }, h('i', { style: { width: Math.round(i.upgProgress * 100) + '%' } })), h('div.small.muted', 'jeszcze ~' + i.daysLeft + ' dni')));
      if (i.effects.length) body.appendChild(h('div.chips', { style: { marginTop: '8px' } }, i.effects.map(t => h('span.chip.sm', t))));
      if (i.herds.length) { body.appendChild(h('div.section', 'Zwierzęta')); for (const hd of i.herds) body.appendChild(h('div.row.between.small', h('span', (G.ANIMALS[hd.species] || {}).icon + ' ' + hd.count + ' × ' + (G.ANIMALS[hd.species] || {}).plural), h('button.btn.xs', { onclick: () => U.open('animals') }, 'Zarządzaj'))); }
      if (i.next) {
        body.appendChild(h('div.section', 'Rozbudowa'));
        const cu = i.canUpgrade;
        body.appendChild(h('div.card', h('div.b', '⬆️ ' + i.next.name), h('div.small.muted', i.next.desc || ''), h('div.row.between.small', { style: { marginTop: '6px' } }, h('span.muted', i.next.days + ' dni budowy'), h('span.b.num', money(i.next.price))), !cu.ok ? h('div.tiny.bad', cu.reason) : null, h('button.btn.primary.block' + (cu.ok ? '' : '.disabled'), { style: { marginTop: '8px' }, disabled: !cu.ok, onclick: () => U.confirm('Rozbudować?', i.next.name + ' za ' + money(i.next.price) + ', ' + i.next.days + ' dni.', 'Rozbuduj', () => { if (U.result(G.buildings.upgrade(uid), null)) { U.sfx('build'); U.rerender(); } }) }, '⬆️ Rozbuduj za ' + money(i.next.price))));
      }
      const cd = i.canDemolish;
      body.appendChild(h('div.section', 'Inne'));
      body.appendChild(h('div.row', h('button.btn.sm.danger' + (cd.ok ? '' : '.disabled'), { disabled: !cd.ok, title: cd.reason || '', onclick: () => U.confirm('Wyburzyć ' + i.levelName + '?', cd.refund ? 'Zwrot materiałów: ' + money(cd.refund) + '.' : 'Koszt rozbiórki: ' + money(cd.cost) + '. Tej decyzji nie da się cofnąć.', 'Wyburz', () => { if (U.result(G.buildings.demolish(uid), null)) U.back(); }, 'danger') }, '🧱 Wyburz' + (cd.cost ? ' (' + money(cd.cost) + ')' : '')), !cd.ok ? h('span.small.muted', cd.reason) : null));
    }
  });

  // =====================================================================================================
  // ZIEMIA
  // =====================================================================================================
  U.panel('land', {
    title: 'Ziemia', live: 4000,
    sub: () => { const a = U.call('land.area', [], null); return a ? 'własna ' + F.ha(a.own) + ' · dzierżawa ' + F.ha(a.lease) + ' · wartość ' + money(U.call('land.value', [], 0)) : ''; },
    render(body, arg, ctx) {
      const st = ctx.state; if (!st.tab) st.tab = 'offers';
      body.appendChild(tabs([{ id: 'offers', label: '🏷️ Oferty' }, { id: 'mine', label: '🏞️ Moje grunty' }], st.tab, id => { st.tab = id; U.rerender(); }));
      if (!G.land) { body.appendChild(h('div.empty', 'Moduł ziemi niedostępny')); return; }
      if (st.tab === 'mine') {
        for (const p of G.playerParcels()) body.appendChild(h('div.card.clickable', { onclick: () => { U.centerParcel(p.id); U.selectParcel(p.id); } }, h('div.row.between', h('div', h('div.b', p.name), h('div.small.muted', F.ha(p.area) + ' · kl. ' + G.SOIL_NAMES[Math.round(p.soilAvg)] + ' · ' + (p.kind === 'meadow' ? 'łąka' : 'pole'))), h('div.right', ownerTag(p), h('div.tiny.muted.num', p.leased ? money(p.rent) + '/rok' : 'wartość ' + money(p.price))))));
        const ls = G.land.leases(); if (ls.length) body.appendChild(h('div.hint', 'Dzierżawy: ' + ls.map(l => l.name + ' do ' + l.until + ' r.').join(', ') + '. Czynsz płatny co miesiąc.'));
        return;
      }
      const offers = G.land.offers();
      body.appendChild(h('div.hint', 'Oferty zmieniają się co miesiąc. Przy zakupie dolicz 2% opłat notarialnych. Kredyt ARiMR 2% finansuje do 85% ceny. Dotknij 🎯, aby zobaczyć działkę na mapie.'));
      if (!offers.length) body.appendChild(h('div.empty', h('span.ico', '🏞️'), 'Brak ofert — wróć za kilka dni.'));
      const sales = offers.filter(o => o.kind === 'sale'), leases = offers.filter(o => o.kind === 'lease');
      if (sales.length) { body.appendChild(h('div.section', 'Na sprzedaż (' + sales.length + ')')); for (const o of sales) body.appendChild(landOfferCard(o)); }
      if (leases.length) { body.appendChild(h('div.section', 'Do dzierżawy (' + leases.length + ')')); for (const o of leases) body.appendChild(landOfferCard(o)); }
    },
    onClose() { G.view.highlight = []; }
  });

  // =====================================================================================================
  // POJAZD
  // =====================================================================================================
  U.panel('vehicle', {
    live: 800,
    title: sel => { const v = U.findVehicle(sel); return (v && v.label) || sel.label || 'Pojazd'; },
    sub: sel => { const v = U.findVehicle(sel); if (!v) return ''; return v.kind === 'contractor' ? 'usługa' : v.kind === 'transport' ? 'wynajęty transport' : v.unit === 'shuttle' ? 'zestaw transportowy' : v.kind === 'parked' ? 'na podwórzu' : 'Twoja maszyna'; },
    render(body, sel) {
      const v = U.findVehicle(sel);
      if (!v) { body.appendChild(h('div.empty', h('span.ico', '🚜'), 'Pojazd zjechał z mapy.')); return; }
      const j = v.jobUid != null ? U.call('jobs.get', [v.jobUid], null) : null;
      const m = v.uid != null && G.machines && G.machines.get ? G.machines.get(v.uid) : (j && j.power && v.unit === 'main' && G.machines ? G.machines.get(j.power) : null);
      const d = m ? G.machines.def(m) : null;
      const parts = (v.parts || []).map(p => p.model);
      body.appendChild(h('div.card', h('div.row', h('span.ico-big', parts[0] && parts[0].startsWith('tractor') ? '🚜' : parts[0] === 'combine' ? '🌾' : '🚜'), h('div.grow', h('div.b', v.label || (d && d.name) || 'Pojazd'), h('div.small.muted', v.working ? '⚙️ pracuje' : v.waiting ? '⏸ czeka' + (v.reason ? ': ' + v.reason : '') : v.kind === 'parked' ? (m && m.broken ? '⚠️ awaria' : 'postój') : '🛣️ jedzie')), v.unloading ? h('span.tag.gold', 'rozładunek') : v.receiving ? h('span.tag.blue', 'odbiera ziarno') : null),
        v.fill != null && (j && j.kind || v.unit === 'shuttle') ? h('div.veh-fill', { style: { marginTop: '8px' } }, h('span', v.unit === 'shuttle' ? '🛒 Ładunek' : '🌾 Zbiornik'), h('div.bar.gold', h('i', { style: { width: Math.round(v.fill * 100) + '%' } })), h('span.num', Math.round(v.fill * 100) + '%')) : null));
      const kv = h('div.kv');
      const driver = j ? (v.unit === 'main' ? G.workers.get(j.worker) : (() => { const st = j.sets && j.sets[v.k || 0]; return st && st.helper ? G.workers.get(st.helper) : null; })()) : (m && m.driver ? G.workers.get(m.driver) : null);
      kv.appendChild(h('span.k', 'Kierowca')); kv.appendChild(h('span.v', driver ? driver.name : v.kind === 'contractor' || v.kind === 'transport' ? 'operator firmy' : '—'));
      if (m) {
        kv.appendChild(h('span.k', 'Stan techniczny')); kv.appendChild(h('span.v' + (m.wear > 0.6 ? '.bad' : ''), (100 - Math.round(m.wear * 100)) + '%'));
        if (d && d.fuelLph) { kv.appendChild(h('span.k', 'Spalanie')); kv.appendChild(h('span.v', d.fuelLph + ' l/h')); }
        if (m.fuel != null) { kv.appendChild(h('span.k', 'Paliwo')); kv.appendChild(h('span.v', Math.round(m.fuel) + ' l')); }
        kv.appendChild(h('span.k', 'Motogodziny')); kv.appendChild(h('span.v', G.fmtNum(m.hours, 0)));
      }
      if (j) { kv.appendChild(h('span.k', 'Zużyte paliwo')); kv.appendChild(h('span.v', Math.round(j.fuel || 0) + ' l')); }
      body.appendChild(h('div.card', kv));
      // doczepione narzędzia
      const tools = (v.parts || []).slice(1);
      const hitch = m && Array.isArray(m.hitch) ? m.hitch : null;
      if (tools.length || (hitch && hitch.length)) {
        body.appendChild(h('div.section', 'Doczepione'));
        const c = h('div.card');
        if (hitch && hitch.length) for (const hu of hitch) { const hm = G.machines.get(hu), hd = hm && G.machines.def(hm); c.appendChild(h('div.row.between', h('span', '🔗 ' + (hd ? hd.name : 'narzędzie')), h('div.row', G.machines.command ? h('button.btn.xs', { onclick: () => U.runAction({ uid: m.uid }, m.lowered ? 'raise' : 'lower') }, m.lowered ? '⬆️ Podnieś' : '⬇️ Opuść') : null, G.machines.command ? h('button.btn.xs', { onclick: () => U.runAction({ uid: m.uid }, 'unhitch') }, 'Odczep') : null))); }
        else for (const t of tools) c.appendChild(h('div.row.between', h('span', '🔗 ' + t), j ? h('span.tag.blue', 'w zleceniu') : null));
        body.appendChild(c);
      }
      if (j) { body.appendChild(h('div.section', 'Zlecenie')); body.appendChild(jobCard(j, false)); }
      // akcje
      body.appendChild(h('div.section', 'Akcje'));
      const row = h('div.row.wrap');
      row.appendChild(h('button.btn.sm', { onclick: () => { U.cam.follow = { uid: v.uid, jobUid: v.jobUid, unit: v.unit, k: v.k }; U.centerOn(v.x, v.y, true); if (U.isMobile()) U.close(); } }, '🎯 Śledź'));
      const canDrive = !!(G.drive && G.drive.take) && v.uid != null && v.kind !== 'contractor' && v.kind !== 'transport';
      row.appendChild(h('button.btn.sm.primary' + (canDrive ? '' : '.disabled'), { disabled: !canDrive, title: canDrive ? '' : 'wkrótce', onclick: () => U.driveStart(v.uid) }, '🕹️ Prowadź', !canDrive ? h('span.sub', 'wkrótce') : null));
      if (G.machines && G.machines.actions && v.uid != null) {
        row.appendChild(h('button.btn.sm', { onclick: () => U.setTargetMode(true) }, '📍 Wskaż cel'));
        const acts = (() => { try { return G.machines.actions(v.uid, null) || []; } catch (e) { return []; } })().filter(a => ['assign_driver', 'garage', 'stop', 'refuel', 'unhitch', 'raise', 'lower'].includes(a.id));
        for (const a of acts) row.appendChild(h('button.btn.sm' + (a.enabled === false ? '.disabled' : ''), { disabled: a.enabled === false, title: a.reason || '', onclick: () => U.runAction(v, a.id, null) }, (a.icon || '') + ' ' + a.label));
      }
      if (m && !j) row.appendChild(h('button.btn.sm.ghost', { onclick: () => { U.open('machines', { tab: 'own' }); } }, '🔧 Serwis'));
      body.appendChild(row);
      if (!(G.machines && G.machines.actions)) body.appendChild(h('div.hint', 'Bezpośrednie sterowanie pojazdami (jedź tam, podczep, rozładuj) pojawi się wkrótce. Na razie maszyny pracują w zleceniach z panelu działki.'));
    },
    onClose() { U.sel.vehicle = null; G.view.selVehicle = null; G.view.selVehicleUid = null; }
  });

  // =====================================================================================================
  // USTAWIENIA
  // =====================================================================================================
  U.panel('settings', {
    title: 'Ustawienia', sub: () => 'Złote Pola v' + G.VERSION,
    render(body, arg, ctx) {
      body.appendChild(h('div.section', 'Tempo gry'));
      const seg = h('div.seg', { style: { display: 'flex' } });
      for (const sec in G.CFG.DAY_LENGTHS) seg.appendChild(h('button' + (+sec === G.CFG.DAY_SEC ? '.on' : ''), { style: { flex: 1 }, onclick: () => { G.setDayLength(+sec); U.rerender(); } }, G.CFG.DAY_LENGTHS[sec]));
      body.appendChild(h('div.card', h('div.small.muted', 'Długość doby w grze przy tempie 1×. Krótsza doba = szybsza gra.'), seg));
      body.appendChild(h('div.section', 'Rozgrywka'));
      const rc = h('div.card');
      rc.appendChild(toggle('Pory roku', G.opt('seasons') ? 'zima, wiosna, lato, jesień — terminy siewu i zbioru' : 'wyłączone: zawsze sezon wegetacyjny, siew w dowolnym momencie', G.opt('seasons') !== false, () => { G.setOpt('seasons', G.opt('seasons') === false); G.notify(G.opt('seasons') ? '🍂 Pory roku włączone' : '☀️ Pory roku wyłączone — zawsze sezon wegetacyjny', 'info'); U.rerender(); }));
      rc.appendChild(toggle('Realistyczna pogoda w pracach', G.opt('realWeather') ? 'deszcz, mróz, mokra gleba i wiatr wstrzymują prace' : 'pracujesz w każdą pogodę — tylko zbiór i prasowanie nie w deszczu', !!G.opt('realWeather'), () => { G.setOpt('realWeather', !G.opt('realWeather')); U.rerender(); }));
      body.appendChild(rc);
      body.appendChild(h('div.section', 'Dźwięk'));
      const sc = h('div.card');
      if (G.sound && G.sound.CHANNELS) {
        const on = typeof G.sound.on === 'function' ? G.sound.on() : !!G.sound.on;
        sc.appendChild(toggle('Dźwięk włączony', 'muzyka, maszyny, zwierzęta, pogoda', on, () => { try { G.sound.unlock && G.sound.unlock(); G.sound.toggle(); } catch (e) { /* brak */ } U.updateSound(); }));
        const chans = Array.isArray(G.sound.CHANNELS) ? G.sound.CHANNELS : Object.keys(G.sound.CHANNELS);
        for (const ch of chans) {
          const NAMES = { master: 'Głośność główna', music: 'Muzyka', sfx: 'Efekty', ambient: 'Otoczenie', machines: 'Maszyny', animals: 'Zwierzęta', ui: 'Interfejs', weather: 'Pogoda' };
          const id = Array.isArray(ch) ? ch[0] : typeof ch === 'string' ? ch : ch.id;
          const label = Array.isArray(ch) ? ch[1] : typeof ch === 'string' ? (NAMES[ch] || ch) : (ch.label || ch.name || ch.id);
          let vol = 0.8;
          try { const V = G.sound.vol; vol = typeof V === 'function' ? V(id) : (V && typeof V[id] === 'number' ? V[id] : 0.8); } catch (e) { /* brak */ }
          const pct = h('span.small.muted.num', Math.round(vol * 100) + '%');
          sc.appendChild(h('div.field.nolive', h('div.row.between', h('label', (id === 'master' ? '🔊 ' : '') + label), pct), h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: vol, oninput: e => { pct.textContent = Math.round(+e.target.value * 100) + '%'; try { G.sound.setVol(id, +e.target.value); } catch (err) { /* brak */ } } })));
        }
      } else sc.appendChild(h('div.small.muted', '🔇 Moduł dźwięku pojawi się wkrótce.'));
      body.appendChild(sc);
      body.appendChild(h('div.section', 'Zapis gry'));
      const sv = h('div.card');
      for (const slot of G.storage.SLOTS) {
        const meta = G.storage.meta(slot);
        sv.appendChild(h('div.row.between', { style: { padding: '6px 0', borderBottom: '1px solid var(--line-2)' } }, h('div', h('div.b', G.storage.slotName(slot)), h('div.small.muted', meta ? (meta.broken ? 'uszkodzony' : meta.date + ' · ' + money(meta.money) + ' · ' + G.fmtNum(meta.ha, 1) + ' ha') : 'pusty')),
          h('div.row', slot !== 'auto' ? h('button.btn.xs.primary', { onclick: () => { if (G.storage.save(slot)) U.toast('💾 Zapisano w ' + G.storage.slotName(slot), 'good'); else U.toast('🚫 Nie udało się zapisać', 'bad'); U.rerender(); } }, 'Zapisz') : null,
            meta && !meta.broken ? h('button.btn.xs', { onclick: () => U.confirm('Wczytać ' + G.storage.slotName(slot) + '?', 'Bieżący postęp (od ostatniego autozapisu) przepadnie.', 'Wczytaj', () => { if (G.storage.loadSlot(slot)) { U.toast('📂 Wczytano', 'good'); U.close(); } else U.toast('🚫 Zapis uszkodzony', 'bad'); }) }, 'Wczytaj') : null,
            meta && slot !== 'auto' ? h('button.btn.xs.ghost', { onclick: () => { G.storage.del(slot); U.rerender(); } }, '🗑') : null)));
      }
      sv.appendChild(h('div.small.muted', { style: { marginTop: '6px' } }, 'Autozapis co dzień gry i przy wyjściu.' + (G.storage.available ? '' : ' ⚠️ Pamięć przeglądarki niedostępna — użyj eksportu!')));
      body.appendChild(sv);
      body.appendChild(h('div.section', 'Przenieś grę (telefon ↔ komputer)'));
      const ta = h('textarea.input', { placeholder: 'Wklej tu kod zapisu (ZP1Z:…)', spellcheck: false });
      body.appendChild(h('div.card', h('div.row', h('button.btn.sm.grow', { onclick: async () => { const code = await G.storage.exportCode(); ta.value = code; try { await navigator.clipboard.writeText(code); U.toast('📋 Kod skopiowany do schowka', 'good'); } catch (e) { U.toast('Kod w polu poniżej — skopiuj ręcznie', 'info'); } } }, '📤 Eksportuj kod'), h('button.btn.sm.grow', { onclick: async () => { if (await G.storage.downloadFile()) U.toast('💾 Plik pobrany', 'good'); else U.toast('🚫 Przeglądarka zablokowała pobieranie', 'bad'); } }, '💾 Pobierz plik')),
        ta,
        h('div.row', h('button.btn.sm.grow', { onclick: async () => { try { await G.storage.importCode(ta.value); U.toast('📂 Wczytano grę z kodu', 'good'); U.close(); } catch (e) { U.toast('🚫 ' + e.message, 'bad'); } } }, '📥 Wczytaj z kodu'), h('label.btn.sm.grow', '📁 Wczytaj plik', h('input', { type: 'file', accept: '.zp,.txt,.json', style: { display: 'none' }, onchange: async e => { const f = e.target.files[0]; if (!f) return; try { await G.storage.importCode(await f.text()); U.toast('📂 Wczytano grę z pliku', 'good'); U.close(); } catch (err) { U.toast('🚫 ' + err.message, 'bad'); } } })))));
      body.appendChild(h('div.section', 'Inne'));
      body.appendChild(h('div.card', h('div.row.wrap', h('button.btn.sm', { onclick: () => { if (G.tutorial && G.tutorial.start) { U.close(); G.tutorial.start(true); } } }, '🎓 Samouczek od nowa'), h('button.btn.sm', { onclick: () => { U.close(); if (G.tutorial && G.tutorial.showTitle) G.tutorial.showTitle(); } }, '🏠 Ekran tytułowy'), h('button.btn.sm.danger', { onclick: () => U.confirm('Nowa gra?', 'Obecna gra zostanie nadpisana w autozapisie (zapisz ją wcześniej w slocie).', 'Zacznij od nowa', () => { G.newGame(); G.storage.save('auto'); U.close(); const y = G.S.farm.yard; U.centerOn(y.x + y.w / 2, y.y + y.h / 2); U.toast('🌅 Nowa gra — witaj w gospodarstwie po dziadku!', 'good'); if (G.tutorial && G.tutorial.start) setTimeout(() => G.tutorial.start(true), 600); }, 'danger') }, '🌱 Nowa gra'))));
      body.appendChild(h('div.tiny.dim.center', { style: { marginTop: '14px' } }, 'Złote Pola · gra o gospodarstwie · wszystkie marki fikcyjne'));
      void ctx;
    }
  });
})();
