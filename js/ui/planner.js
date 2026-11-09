// Złote Pola — kreator zlecenia (zabieg → parametry → wykonawca → podsumowanie) i lista prac (agent: UI/UX)
// Korzysta z: G.fields (OPS, canDo, summary, suggestCrops, inputFor), G.jobs (suggest, estimate, create, contractorQuote,
// hireContractor, transportQuote, pairSets, list, history, vehicles, eta), G.machines (compatible, catalogFor, rent, rentQuote),
// G.workers (list, candidates), G.market (buy, buyPrice).
(function () {
  const U = G.ui, h = U.h, F = U.fmt;
  const money = v => G.fmtMoney(v);
  const P = id => G.PRODUCTS[id] || { name: id, unit: '', icon: '📦' };
  const OPS = () => (G.fields && G.fields.OPS) || {};
  const opName = op => U.call('jobs.opName', [op], (OPS()[op] || {}).name || op);
  const def = m => (G.machines && G.machines.def ? G.machines.def(m) : null);

  // ---------- parametry zabiegu ----------
  // które zabiegi mają krok „parametry”
  function needsParams(op, pid) {
    if (op === 'sow' || op === 'fertilize' || op === 'spray' || op === 'lime') return true;
    if (op === 'bale') { const f = G.fields.get(pid); return !!(f && f.phase === 'mown'); }
    return false;
  }
  function defaultParams(op, pid, given) {
    const p = Object.assign({}, given || {});
    const R = G.RATES || {};
    if (op === 'sow' && !p.crop) { const sg = (U.call('fields.suggestCrops', [pid], []) || []).find(s => s.okNow); if (sg) p.crop = sg.crop; }
    if (op === 'fertilize') { if (!p.product) p.product = 'saletra'; if (!p.rate) p.rate = (R[p.product] || {}).def || 0.25; }
    if (op === 'spray') { if (!p.product) p.product = 'herbicyd'; if (!p.rate) p.rate = (R[p.product] || {}).def || 1; }
    if (op === 'lime') { if (!p.rate) p.rate = (R.wapno || {}).def || 3; }
    if (op === 'bale') { const f = G.fields.get(pid); if (f && f.phase === 'mown' && !p.product) p.product = (f.dry || 0) >= 1 ? 'siano' : 'sianokiszonka'; }
    return p;
  }
  function paramsText(op, params) {
    params = params || {};
    if (op === 'sow' && params.crop && G.CROPS[params.crop]) return G.CROPS[params.crop].name;
    if ((op === 'fertilize' || op === 'spray') && params.product) return P(params.product).name + (params.rate ? ', ' + G.fmtNum(params.rate, 2) + ' ' + P(params.product).unit + '/ha' : '');
    if (op === 'lime') return 'wapno ' + G.fmtNum(params.rate || 3, 1) + ' t/ha';
    if (op === 'bale' && params.product) return P(params.product).name;
    return '';
  }
  // ilość do dokupienia (zaokrąglona do sensownej jednostki)
  function roundBuy(id, q) {
    const u = P(id).unit;
    if (u === 'szt' || u === 'bela' || u === 'kg' || u === 'l') return Math.ceil(q - 1e-9);
    return Math.ceil(q * 10 - 1e-9) / 10;
  }
  // karta środka produkcji: ile trzeba, ile jest, przycisk dokupienia
  function inputCard(pid, op, params) {
    const inp = U.call('fields.inputFor', [pid, op, params], null);
    if (!inp) return null;
    const short = Math.max(0, inp.total - inp.have);
    const c = h('div.card' + (short > 1e-6 ? '.warn' : '.good'));
    c.appendChild(h('div.row.between', h('div.row', h('span.ico-big', P(inp.id).icon || '📦'), h('div', h('div.b', P(inp.id).name), h('div.small.muted', 'dawka ' + G.fmtNum(inp.rate, 2) + ' ' + P(inp.id).unit + '/ha · potrzeba ' + G.fmtQty(inp.id, inp.total)))),
      h('div.right', h('div.b.num' + (short > 1e-6 ? '.bad' : '.good'), 'masz ' + G.fmtQty(inp.id, inp.have)), h('div.tiny.muted', '≈ ' + money(inp.cost)))));
    if (short > 1e-6) {
      const q = roundBuy(inp.id, short), price = U.call('market.buyPrice', [inp.id], P(inp.id).base || 0);
      const free = G.inv.free(inp.id);
      const canBuy = G.market && G.market.canBuy ? G.market.canBuy(inp.id) : !!G.market;
      c.appendChild(h('div.small.warn', { style: { marginTop: '6px' } }, '⚠️ Brakuje ' + G.fmtQty(inp.id, short) + (isFinite(free) && free < q ? ' — w magazynie zmieści się tylko ' + G.fmtQty(inp.id, free) : '')));
      if (canBuy) c.appendChild(h('button.btn.sm.primary.block', { style: { marginTop: '8px' }, onclick: () => {
        if (G.market.buy(inp.id, q)) { U.sfx('coin'); U.haptic(); U.toast('🛒 Kupiono ' + G.fmtQty(inp.id, q) + ' — ' + P(inp.id).name.toLowerCase(), 'good'); U.rerender(); }
      } }, '🛒 Dokup ' + G.fmtQty(inp.id, q) + ' za ' + money(q * price)));
    }
    return c;
  }

  // ---------- zestaw własny ----------
  function freeWorkers() { return (U.call('workers.list', [], []) || []).filter(w => w.role !== 'barn'); }
  function buildOwn(st) {
    const o = { combos: [], combo: null, workers: [], sets: [], spec: null, est: null, sug: null };
    if (!G.machines || !G.jobs) return o;
    o.sug = U.call('jobs.suggest', [st.op, st.pid, st.params], null);
    o.combos = U.call('machines.compatible', [st.op, st.params, st.pid], []) || [];
    const key = c => c.tractor + ':' + c.implement;
    if (st.combo == null || !o.combos.some(c => key(c) === st.combo)) {
      const best = o.combos.find(c => c.available) || o.combos[0];
      st.combo = best ? key(best) : null;
    }
    o.combo = o.combos.find(c => key(c) === st.combo) || null;
    o.workers = freeWorkers().slice().sort((a, b) => (a.busy ? 1 : 0) - (b.busy ? 1 : 0) || b.skills.field - a.skills.field);
    if (st.worker == null || !o.workers.some(w => w.uid === st.worker)) {
      const sw = o.sug && o.sug.ok ? o.sug.worker : (o.sug && o.sug.partial ? o.sug.partial.worker : null);
      st.worker = sw != null ? sw : (o.workers[0] ? o.workers[0].uid : null);
    }
    if (!o.combo) return o;
    const machines = [o.combo.tractor, o.combo.implement].filter(u => u != null);
    const spec = { op: st.op, pid: st.pid, params: st.params, machines: machines.slice(), worker: st.worker, helpers: [] };
    if (st.op === 'harvest') {
      // zestawy odbioru: wolne puste przyczepy, wolne ciągniki (poza maszyną główną), wolni kierowcy (poza operatorem)
      const all = G.machines.list();
      const freeOk = m => !m.busy && G.machines.ready(m.uid).ok && !machines.includes(m.uid);
      const trailerFill = m => (G.jobs.trailerFill ? G.jobs.trailerFill(m) : 0);
      const trailers = all.filter(m => def(m).cat === 'trailer' && freeOk(m) && trailerFill(m) <= 1e-6).map(m => m.uid);
      const tractors = all.filter(m => def(m).cat === 'tractor' && freeOk(m)).map(m => m.uid);
      const drivers = o.workers.filter(w => !w.busy && w.uid !== st.worker).map(w => w.uid);
      const pr = G.jobs.pairSets ? G.jobs.pairSets(trailers, tractors, drivers, null) : { sets: [] };
      o.sets = pr.sets.slice(0, 3);
      o.setsWhy = !trailers.length ? 'brak wolnej pustej przyczepy' : !tractors.length ? 'brak drugiego wolnego ciągnika' : !drivers.length ? 'brak wolnego kierowcy' : pr.why || '';
      if (!st.setsOff) st.setsOff = [];
      const on = o.sets.filter((s, k) => !st.setsOff.includes(k));
      if (st.hired == null) st.hired = on.length ? 0 : 1;
      const maxHired = Math.max(0, 3 - on.length);
      if (st.hired > maxHired) st.hired = maxHired;
      for (const s of on) { spec.machines.push(s.tractor, s.trailer); if (s.trailer2) spec.machines.push(s.trailer2); spec.helpers.push(s.helper); }
      spec.transport = st.hired;
      o.setsOn = on.length;
    }
    o.spec = spec;
    o.est = U.call('jobs.estimate', [spec], null);
    return o;
  }

  // ---------- kreator ----------
  const STEP_NAMES = { op: 'Zabieg', params: 'Parametry', exec: 'Wykonawca', summary: 'Podsumowanie' };
  function stepsFor(st) { return ['op'].concat(st.op && needsParams(st.op, st.pid) ? ['params'] : [], ['exec', 'summary']); }
  function go(st, name) { st.step = name; U.rerender(); U.scrollTop(); U.sfx('ui_tap'); }
  function next(st) { const s = stepsFor(st), k = s.indexOf(st.step); if (k < s.length - 1) go(st, s[k + 1]); }
  function prev(st) { const s = stepsFor(st), k = s.indexOf(st.step); if (k > 0) go(st, s[k - 1]); else U.back(); }

  U.panel('planner', {
    full: true,
    title: arg => { const p = G.S.parcels[arg && arg.pid]; return 'Zlecenie' + (p ? ' — ' + p.name : ''); },
    sub: (arg, ctx) => { const st = ctx && ctx.state; if (!st || !st.step) return ''; const s = stepsFor(st); return 'Krok ' + (s.indexOf(st.step) + 1) + ' z ' + s.length + ' · ' + STEP_NAMES[st.step]; },
    render(body, arg, ctx) {
      const st = ctx.state;
      if (!st.inited) {
        st.inited = true; st.pid = arg.pid;
        st.op = arg.op || null;
        st.params = st.op ? defaultParams(st.op, st.pid, arg.params) : {};
        st.exec = arg.contractor ? 'contractor' : null;
        st.step = st.op ? (needsParams(st.op, st.pid) && !(arg.fromRec && arg.params && Object.keys(arg.params).length && st.op !== 'sow') ? 'params' : 'exec') : 'op';
        if (arg.fromRec && st.op === 'sow' && arg.params && arg.params.crop) st.step = 'params';
      }
      const p = G.S.parcels[st.pid];
      if (!p) { body.appendChild(h('div.empty', 'Brak działki')); return; }
      // pasek kroków
      const steps = stepsFor(st), cur = steps.indexOf(st.step);
      body.appendChild(h('div.steps-bar', steps.map((s, k) => h('i' + (k <= cur ? '.on' : '')))));
      if (st.step === 'op') renderOp(body, st, p);
      else if (st.step === 'params') renderParams(body, st, p);
      else if (st.step === 'exec') renderExec(body, st, p);
      else renderSummary(body, st, p);
      // stopka
      const back = h('button.btn.ghost', { onclick: () => prev(st) }, cur > 0 ? '‹ Wstecz' : 'Anuluj');
      let fwd = null;
      if (st.step === 'params') { const cd = G.fields.canDo(st.pid, st.op, st.params); const okish = cd.ok || cd.need; fwd = h('button.btn.primary' + (okish ? '' : '.disabled'), { disabled: !okish, onclick: () => next(st) }, 'Dalej ›'); }
      else if (st.step === 'exec') fwd = h('button.btn.primary' + (st.exec ? '' : '.disabled'), { disabled: !st.exec, onclick: () => next(st) }, 'Dalej ›');
      else if (st.step === 'summary') fwd = summaryButton(st);
      U.setFoot([back, fwd]);
    }
  });

  // krok 1: wybór zabiegu
  function renderOp(body, st, p) {
    const s = G.fields.summary(st.pid);
    body.appendChild(h('div.small.muted', { style: { marginBottom: '8px' } }, (s.cropName ? s.cropName + ' — ' : '') + s.phaseName + ' · ' + F.ha(p.area)));
    const recOps = new Set((s.next || []).filter(r => r.op).map(r => r.op));
    const grid = h('div.ops');
    const ops = Object.keys(OPS()).filter(op => { const o = OPS()[op]; return o.kind === 'any' || (o.kind === 'meadow') === (p.kind === 'meadow'); });
    // najpierw dostępne
    const rows = ops.map(op => { const prm = defaultParams(op, st.pid, (s.next.find(r => r.op === op) || {}).params); const cd = G.fields.canDo(st.pid, op, prm); return { op, prm, cd, okish: cd.ok || !!cd.need }; });
    rows.sort((a, b) => (b.okish - a.okish) || (recOps.has(b.op) - recOps.has(a.op)));
    for (const r of rows) {
      const o = OPS()[r.op];
      const busy = (U.call('jobs.forParcel', [st.pid], []) || []).some(j => j.op === r.op);
      grid.appendChild(h('button.op' + (r.okish && !busy ? '' : '.off') + (recOps.has(r.op) && r.okish ? '.rec' : ''), {
        onclick: () => {
          if (busy) { U.toast('To zlecenie już jest w kolejce', 'info'); return; }
          if (!r.okish) { U.toast('⛔ ' + (r.cd.reason || 'Zabieg teraz niemożliwy'), 'bad'); return; }
          st.op = r.op; st.params = r.prm; st.combo = null; st.worker = null; st.hired = null; st.setsOff = null; st.exec = null;
          go(st, needsParams(r.op, st.pid) ? 'params' : 'exec');
        }
      }, h('span.ico', o.icon), h('span.n', o.name), h('span.r', busy ? '🚜 już zlecone' : r.cd.ok ? (r.cd.warn ? '⚠️ ' + r.cd.warn : 'można teraz') : r.cd.need ? '⚠️ ' + r.cd.reason : r.cd.reason)));
    }
    body.appendChild(grid);
    if (!rows.some(r => r.okish)) body.appendChild(h('div.hint', 'Na tym polu nie ma teraz nic do zrobienia. Wróć, gdy zmieni się faza uprawy.'));
  }

  // krok 2: parametry
  function renderParams(body, st, p) {
    const op = st.op, o = OPS()[op], R = G.RATES || {};
    body.appendChild(h('div.row', { style: { marginBottom: '6px' } }, h('span.ico-big', o.icon), h('div', h('div.b', o.name), h('div.small.muted', o.desc || ''))));
    const cd0 = G.fields.canDo(st.pid, op, st.params);
    if (!cd0.ok && !cd0.need) body.appendChild(h('div.hint.bad', '⛔ ' + cd0.reason));
    if (op === 'sow') {
      body.appendChild(h('div.section', 'Uprawa'));
      const sug = U.call('fields.suggestCrops', [st.pid], []) || [];
      const f = G.fields.get(st.pid);
      if (f && f.last && G.CROPS[f.last]) body.appendChild(h('div.small.muted', { style: { marginBottom: '6px' } }, 'Przedplon: ' + G.CROPS[f.last].name));
      for (const sg of sug) {
        const sel = st.params.crop === sg.crop;
        body.appendChild(h('div.card.clickable' + (sel ? '.sel' : '') + (sg.okNow ? '' : '.dimmed'), { style: sg.okNow ? null : { opacity: 0.55 }, onclick: () => { st.params = defaultParams('sow', st.pid, { crop: sg.crop }); st.combo = null; U.rerender(); } },
          h('div.row.between', h('div.row', h('span.ico-big', U.cropIcon(sg.crop)), h('div', h('div.b', sg.name + (sel ? ' ✓' : '')), h('div.small' + (sg.okNow ? '.good' : '.muted'), '🗓️ siew: ' + sg.when))),
            h('div.right', h('div.b.num' + (sg.marginHa > 0 ? '.good' : '.bad'), F.signed(sg.marginHa) + '/ha'), h('div.tiny.muted.num', G.fmtNum(sg.yieldHa, 1) + ' t/ha · ' + sg.priceT + ' zł/t'))),
          sg.notes ? h('div.small.muted', { style: { marginTop: '4px' } }, (sg.rotation < 1 ? '🔄 ' : sg.rotation > 1 ? '✅ ' : '') + sg.notes) : null));
      }
    }
    if (op === 'fertilize' || op === 'spray') {
      const prods = o.products || [];
      body.appendChild(h('div.section', op === 'spray' ? 'Środek' : 'Nawóz'));
      const DESC = { saletra: 'azot pogłówny', npk: 'fosfor i potas przed siewem', obornik: 'przed orką, P+K+próchnica', gnojowica: 'przed siewem', herbicyd: 'chwasty', fungicyd: 'choroby grzybowe', insektycyd: 'szkodniki' };
      const chips = h('div.ops');
      for (const id of prods) {
        const cd = G.fields.canDo(st.pid, op, { product: id, rate: (R[id] || {}).def });
        const blocked = !cd.ok && !cd.need;
        chips.appendChild(h('button.op' + (st.params.product === id ? '.sel' : '') + (blocked ? '.off' : ''), { onclick: () => { if (blocked) { U.toast('⛔ ' + cd.reason, 'bad'); return; } st.params = { product: id, rate: (R[id] || {}).def }; st.combo = null; U.rerender(); } },
          h('span.ico', P(id).icon || '🧪'), h('span.n', P(id).name), h('span.r', blocked ? cd.reason : DESC[id] + ' · masz ' + G.fmtQty(id, G.inv.get(id)))));
      }
      body.appendChild(chips);
    }
    if (op === 'bale') {
      body.appendChild(h('div.section', 'Produkt'));
      const f = G.fields.get(st.pid);
      body.appendChild(h('div.chips', ['siano', 'sianokiszonka'].map(id => h('button.chip' + (st.params.product === id ? '.on' : ''), { onclick: () => { st.params = { product: id }; U.rerender(); } }, P(id).icon + ' ' + P(id).name))));
      body.appendChild(h('div.hint', 'Pokos wysuszony w ' + Math.round(((f && f.dry) || 0) * 100) + '%. Siano wymaga pełnego wyschnięcia, sianokiszonkę można prasować wcześniej (owijana folią).'));
    }
    // dawka
    const rid = op === 'lime' ? 'wapno' : st.params.product;
    if ((op === 'lime' || op === 'fertilize' || op === 'spray') && R[rid]) {
      const r = R[rid];
      body.appendChild(h('div.section', 'Dawka'));
      const step = U.stepper(st.params.rate || r.def, r.min, r.max, r.step, v => { st.params.rate = v; clearTimeout(st.rt); st.rt = setTimeout(() => U.rerender(), 350); });
      body.appendChild(h('div.card', h('div.row.between', h('div', h('div.b', G.fmtNum(st.params.rate || r.def, 2) + ' ' + P(rid).unit + '/ha'), h('div.small.muted', 'zalecana ' + G.fmtNum(r.def, 2) + ' · zakres ' + G.fmtNum(r.min, 2) + '–' + G.fmtNum(r.max, 2))), step.el)));
    }
    // środki
    const ic = inputCard(st.pid, op, st.params);
    if (ic) { body.appendChild(h('div.section', 'Środki z magazynu')); body.appendChild(ic); }
    if (cd0.warn) body.appendChild(h('div.hint.warn', '⚠️ ' + cd0.warn));
  }

  // krok 3: wykonawca — porównanie własnych maszyn i usługi
  function renderExec(body, st, p) {
    const own = buildOwn(st);
    const q = U.call('jobs.contractorQuote', [st.pid, st.op, st.params], null) || { ok: false };
    const est = own.est;
    const ownOk = !!(est && est.ok !== false && own.spec);
    const ownBlocked = !own.combo;
    // auto-wybór
    if (!st.exec) st.exec = ownOk ? 'own' : 'contractor';
    // porównanie
    body.appendChild(h('div.section', 'Kto wykona?'));
    const cmp = h('div.grid2');
    const ownCost = est && est.cost != null ? est.cost : null, ctrCost = q.ok ? q.price : null;
    const ownH = est && est.hours ? est.hours : null, ctrH = q.ok ? (q.days * 24 + (q.hoursEst || 0)) : null;
    const cheaper = ownCost != null && ctrCost != null ? (ownCost <= ctrCost ? 'own' : 'contractor') : null;
    const faster = ownH != null && ctrH != null && ownOk ? (ownH <= ctrH ? 'own' : 'contractor') : null;
    cmp.appendChild(h('button.card.clickable.choice' + (st.exec === 'own' ? '.sel' : '') + (ownBlocked ? '.off' : ''), { style: { textAlign: 'left', color: 'inherit' }, onclick: () => { st.exec = 'own'; U.rerender(); } },
      h('div.row.between', h('span.ico-big', '🚜'), h('div.col', { style: { gap: '3px', alignItems: 'flex-end' } }, cheaper === 'own' ? h('span.tag.green', 'taniej') : null, faster === 'own' ? h('span.tag.blue', 'szybciej') : null)),
      h('div.b', { style: { marginTop: '6px' } }, 'Własne maszyny'),
      ownBlocked ? h('div.small.bad', 'brak sprzętu') : h('div.small.muted', ownOk ? 'start od razu' : (est && est.reason) || 'niekompletny zestaw'),
      ownCost != null && !ownBlocked ? h('div.b.num.gold', { style: { fontSize: '18px', marginTop: '4px' } }, '≈ ' + money(ownCost)) : null,
      ownH != null && !ownBlocked ? h('div.tiny.muted', '⏱ ~' + F.hours(ownH) + ' pracy') : null));
    cmp.appendChild(h('button.card.clickable.choice' + (st.exec === 'contractor' ? '.sel' : '') + (q.ok ? '' : '.off'), { style: { textAlign: 'left', color: 'inherit' }, onclick: () => { if (!q.ok) { U.toast('⛔ ' + (q.reason || 'Usługa niedostępna'), 'bad'); return; } st.exec = 'contractor'; U.rerender(); } },
      h('div.row.between', h('span.ico-big', '📞'), h('div.col', { style: { gap: '3px', alignItems: 'flex-end' } }, cheaper === 'contractor' ? h('span.tag.green', 'taniej') : null, faster === 'contractor' ? h('span.tag.blue', 'szybciej') : null)),
      h('div.b', { style: { marginTop: '6px' } }, 'Usługa'),
      h('div.small.muted', q.ok ? q.name : q.reason || 'niedostępna'),
      q.ok ? h('div.b.num.gold', { style: { fontSize: '18px', marginTop: '4px' } }, money(q.price)) : null,
      q.ok ? h('div.tiny.muted', '🗓️ przyjadą ' + q.startText) : null));
    body.appendChild(cmp);

    if (st.exec === 'contractor') { renderContractor(body, st, q); return; }
    renderOwn(body, st, own, p);
  }
  function renderContractor(body, st, q) {
    if (!q.ok) { body.appendChild(h('div.hint.bad', '⛔ ' + (q.reason || 'Usługa niedostępna'))); return; }
    const c = h('div.card');
    c.appendChild(h('div.row', h('span.ico-big', '🏢'), h('div.grow', h('div.b', q.name), h('div.small.muted', 'Firma usługowa z własnym sprzętem i operatorem' + (q.trailers ? ' + ' + q.trailers + ' zestawy do odbioru plonu' : '')))));
    const kv = h('div.kv', { style: { marginTop: '8px' } });
    kv.appendChild(h('span.k', 'Stawka')); kv.appendChild(h('span.v', G.fmtNum(q.rate, 0) + ' zł/' + q.unit + (q.peak ? ' (+10% szczyt sezonu)' : '')));
    kv.appendChild(h('span.k', 'Zakres')); kv.appendChild(h('span.v', q.unit === 'bela' ? q.qty + ' bel' : F.ha(q.area)));
    kv.appendChild(h('span.k', 'Termin')); kv.appendChild(h('span.v', q.startText + ' (za ' + q.days + ' ' + (q.days === 1 ? 'dzień' : 'dni') + ')'));
    kv.appendChild(h('span.k', 'Czas pracy')); kv.appendChild(h('span.v', '~' + F.hours(q.hoursEst)));
    kv.appendChild(h('span.k', 'Cena')); kv.appendChild(h('span.v.gold', money(q.price)));
    c.appendChild(kv);
    body.appendChild(c);
    body.appendChild(h('div.hint', 'Płacisz z góry. Nasiona, nawozy i środki ochrony firma bierze z Twojego magazynu' + (st.op === 'harvest' ? '; plon zwiezie na podwórze.' : '.') + (q.peak ? ' W szczycie sezonu usługodawcy mają kolejki.' : '')));
    if (!G.finance.canAfford(q.price)) body.appendChild(h('div.hint.bad', '💸 Brakuje pieniędzy — sprzedaj zapasy albo weź kredyt obrotowy.'));
  }
  function renderOwn(body, st, own, p) {
    const sug = own.sug || {};
    // brak maszyn → wynajem / salon
    if (!own.combo) {
      body.appendChild(h('div.hint.warn', '🚜 ' + (sug.reason || 'Nie masz maszyn do tego zabiegu.')));
      const rent = (sug.rent && sug.rent.length ? sug.rent : (U.call('machines.catalogFor', [st.op, Object.assign({}, st.params)], []) || []).filter(d => d.rentPerDay > 0).map(d => ({ id: d.id, name: d.name, perDay: d.rentPerDay }))).slice(0, 5);
      if (rent.length) {
        body.appendChild(h('div.section', 'Wynajmij na kilka dni'));
        if (st.rentDays == null) st.rentDays = 2;
        const days = U.stepper(st.rentDays, 1, 30, 1, v => { st.rentDays = v; U.rerender(); });
        body.appendChild(h('div.row.between', { style: { marginBottom: '6px' } }, h('span.small.muted', 'Liczba dni'), days.el));
        for (const r of rent) {
          const rq = G.machines.rentQuote(r.id, st.rentDays) || { total: r.perDay * st.rentDays };
          const d = G.MACHINES[r.id] || {};
          body.appendChild(h('div.card', h('div.row.between', h('div', h('div.b', r.name), h('div.small.muted', (d.reqHp ? 'wymaga ' + d.reqHp + ' KM · ' : d.hp ? d.hp + ' KM · ' : '') + money(r.perDay) + '/dzień')),
            h('button.btn.sm.primary', { onclick: () => { if (U.result(G.machines.rent(r.id, st.rentDays), null)) { U.sfx('coin'); st.combo = null; U.rerender(); } } }, '🔑 ' + money(rq.total)))));
        }
      }
      body.appendChild(h('button.btn.block', { style: { marginTop: '8px' }, onclick: () => U.open('machines', { op: st.op, params: st.params }, { push: true }) }, '🛒 Kup maszynę do zabiegu'));
      return;
    }
    // zestaw główny
    body.appendChild(h('div.section', 'Zestaw'));
    for (const c of own.combos.slice(0, 6)) {
      const k = c.tractor + ':' + c.implement, sel = st.combo === k;
      body.appendChild(h('div.card.clickable' + (sel ? '.sel' : ''), { style: c.available ? null : { opacity: 0.6 }, onclick: () => { st.combo = k; st.setsOff = []; st.hired = null; U.rerender(); } },
        h('div.row.between', h('div.row', h('span.ico-big', '🚜'), h('div', h('div.b', c.label + (sel ? ' ✓' : '')), h('div.small' + (c.available ? '.muted' : '.warn'), c.available ? G.fmtNum(c.haH, 2) + ' ha/h' : '⏳ ' + c.reason))))));
    }
    // operator
    body.appendChild(h('div.section', 'Operator'));
    const wc = h('div.chips');
    for (const w of own.workers) wc.appendChild(h('button.chip' + (st.worker === w.uid ? '.on' : ''), { onclick: () => { st.worker = w.uid; st.setsOff = []; U.rerender(); } }, (w.isPlayer ? '👨‍🌾 ' : '👷 ') + w.name.split(' ')[0] + (w.busy ? ' ⏳' : ''), h('span.stars', '★' + w.skills.field)));
    body.appendChild(wc);
    if (!own.workers.length) body.appendChild(h('div.hint.warn', 'Brak pracowników do pracy w polu. ', h('button.btn.xs', { onclick: () => U.open('people', null, { push: true }) }, '🤝 Zatrudnij')));
    // odbiór ziarna (zbiór)
    if (st.op === 'harvest') renderHaul(body, st, own, p);
    // szacunek
    const e = own.est;
    if (e) {
      body.appendChild(h('div.section', 'Szacunek'));
      if (e.ok === false) body.appendChild(h('div.hint.bad', '⛔ ' + e.reason));
      else {
        body.appendChild(h('div.grid3', h('div.stat', h('div.l', 'Czas'), h('div.v', F.hours(e.hours))), h('div.stat', h('div.l', 'Paliwo'), h('div.v', G.fmtNum(e.fuel, 0) + ' l')), h('div.stat', h('div.l', 'Koszt'), h('div.v.gold', money(e.cost)))));
        const kv = h('div.kv', { style: { marginTop: '8px' } });
        const add = (k, v) => { if (v) { kv.appendChild(h('span.k', k)); kv.appendChild(h('span.v', money(v))); } };
        add('⛽ Paliwo', e.fuelCost); add('🔧 Zużycie maszyn', e.wearCost); add('👷 Płace', e.wageCost); add('🚚 Transport', e.transportCost);
        if (kv.children.length) body.appendChild(h('div.card', kv, h('div.tiny.muted', { style: { marginTop: '6px' } }, 'Wydajność ' + G.fmtNum(e.haH, 2) + ' ha/h · praca ' + F.hours(e.workH) + ' + dojazdy ' + F.hours(e.travelH))));
        if (e.reason) body.appendChild(h('div.hint.warn', '⏳ ' + e.reason));
      }
    }
  }
  function renderHaul(body, st, own, p) {
    body.appendChild(h('div.section', 'Odbiór ziarna', h('span.tag.gold', (own.setsOn || 0) + (st.hired || 0) + ' / 3 zest.')));
    body.appendChild(h('div.small.muted', { style: { marginBottom: '6px' } }, 'Kombajn rozładowuje zbiornik tylko na przyczepę jadącą obok. Każdy zestaw to ciągnik + przyczepa + kierowca. Więcej zestawów = kombajn nie czeka.'));
    own.sets.forEach((s, k) => {
      const off = st.setsOff.includes(k);
      const tm = G.machines.get(s.tractor), rm = G.machines.get(s.trailer), r2 = s.trailer2 ? G.machines.get(s.trailer2) : null, w = G.workers.get(s.helper);
      const cap = (def(rm) || {}).cap + (r2 ? (def(r2) || {}).cap : 0);
      body.appendChild(h('div.card.clickable' + (off ? '' : '.sel'), { onclick: () => { if (off) st.setsOff = st.setsOff.filter(x => x !== k); else st.setsOff.push(k); U.rerender(); } },
        h('div.row.between', h('div.row', h('span.ico-big', '🚜'), h('div', h('div.b', 'Zestaw ' + (k + 1) + ': ' + (def(tm) || {}).name), h('div.small.muted', '🛒 ' + (def(rm) || {}).name + (r2 ? ' + ' + def(r2).name : '') + ' · ' + G.fmtNum(cap, 0) + ' t · 👷 ' + (w ? w.name : '—')))), h('span.tag' + (off ? '' : '.green'), off ? 'pominięty' : 'jedzie'))));
    });
    if (!own.sets.length) body.appendChild(h('div.hint.warn', '🚜 Brak własnego zestawu: ' + (own.setsWhy || 'brak przyczepy, ciągnika lub kierowcy') + '.'));
    // wynajęty transport
    const maxH = Math.max(0, 3 - (own.setsOn || 0));
    const tq = U.call('jobs.transportQuote', [st.pid, Math.max(1, st.hired || 1), own.spec], null);
    const c = h('div.card' + (st.hired > 0 ? '.sel' : ''));
    const stp = U.stepper(st.hired || 0, 0, maxH, 1, v => { st.hired = v; clearTimeout(st.ht); st.ht = setTimeout(() => U.rerender(), 250); });
    c.appendChild(h('div.row.between', h('div.row', h('span.ico-big', '🚚'), h('div', h('div.b', 'Wynajęty transport'), h('div.small.muted', (tq ? tq.name + ' · ' : '') + 'ciągnik + przyczepa 14 t + kierowca'))), stp.el));
    if (tq && st.hired > 0) c.appendChild(h('div.small.muted', { style: { marginTop: '6px' } }, st.hired + ' × ~' + tq.hours + ' h × ' + money(tq.perHour) + ' = ', h('b.gold', money(Math.round(tq.price / Math.max(1, tq.sets) * st.hired / 10) * 10))));
    body.appendChild(c);
    if ((own.setsOn || 0) + (st.hired || 0) < 1) body.appendChild(h('div.hint.bad', '⛔ Potrzebny co najmniej 1 zestaw do odbioru ziarna — dodaj wynajęty transport.'));
    else if ((own.setsOn || 0) + (st.hired || 0) === 1 && p.area > 4) body.appendChild(h('div.hint', '💡 Przy ' + F.ha(p.area) + ' drugi zestaw skróci przestoje kombajnu.'));
  }

  // krok 4: podsumowanie
  function renderSummary(body, st, p) {
    const o = OPS()[st.op];
    const s = G.fields.summary(st.pid);
    body.appendChild(h('div.card', h('div.row', h('span.ico-big', o.icon), h('div.grow', h('div.b', { style: { fontSize: '17px' } }, o.name + (paramsText(st.op, st.params) ? ': ' + paramsText(st.op, st.params) : '')), h('div.small.muted', p.name + ' · ' + F.ha(p.area) + ' · ' + (s.cropName || s.phaseName))))));
    const kv = h('div.kv');
    const row = (k, v, cls) => { kv.appendChild(h('span.k', k)); kv.appendChild(h('span.v' + (cls || ''), v)); };
    let cost = 0;
    if (st.exec === 'contractor') {
      const q = G.jobs.contractorQuote(st.pid, st.op, st.params);
      row('Wykonawca', '📞 ' + q.name); row('Termin', q.startText); row('Czas pracy', '~' + F.hours(q.hoursEst)); cost = q.price;
    } else {
      const own = buildOwn(st);
      const e = own.est || {};
      row('Wykonawca', '🚜 własne maszyny');
      if (own.combo) row('Zestaw', own.combo.label);
      const w = G.workers.get(st.worker); if (w) row('Operator', w.name);
      if (st.op === 'harvest') { row('Zestawy odbioru', (own.setsOn || 0) + ' własne' + (st.hired ? ' + ' + st.hired + ' wynajęte' : '')); }
      row('Czas', '~' + F.hours(e.hours)); row('Paliwo', G.fmtNum(e.fuel || 0, 0) + ' l');
      cost = e.cost || 0;
      if (e.ok === false) body.appendChild(h('div.hint.bad', '⛔ ' + e.reason));
      else if (e.reason) body.appendChild(h('div.hint.warn', '⏳ ' + e.reason));
    }
    const inp = U.call('fields.inputFor', [st.pid, st.op, st.params], null);
    if (inp) row('Środki', G.fmtQty(inp.id, inp.total) + ' ' + P(inp.id).name.toLowerCase() + ' (≈ ' + money(inp.cost) + ' z magazynu)', inp.have + 1e-6 < inp.total ? '.bad' : '');
    if (st.op === 'harvest' && s.product) row('Prognoza plonu', G.fmtQty(s.product, s.yieldTotal) + (s.grade ? ' · ' + s.grade.label : '') + ' ≈ ' + money(s.valueEst), '.good');
    row('Koszt zlecenia', money(cost), '.gold');
    body.appendChild(h('div.card', kv));
    const ic = inp && inp.have + 1e-6 < inp.total ? inputCard(st.pid, st.op, st.params) : null;
    if (ic) body.appendChild(ic);
    const cd = G.fields.canDo(st.pid, st.op, st.params);
    if (cd.warn) body.appendChild(h('div.hint.warn', '⚠️ ' + cd.warn));
    const W = G.weather && G.weather.canWork ? G.weather.canWork() : { ok: true };
    if (!W.ok) body.appendChild(h('div.hint', '🌧️ ' + W.reason + ' — maszyny ruszą, gdy pogoda pozwoli.'));
    if (st.exec === 'own' && st.op !== 'harvest') body.appendChild(h('div.small.muted', { style: { marginTop: '8px' } }, 'Maszyna wyjedzie z podwórza, dojedzie drogą do pola i obrobi je pasami. Postęp zobaczysz na mapie i w zakładce Prace.'));
  }
  function summaryButton(st) {
    let label = '✅ Zleć', cost = 0;
    if (st.exec === 'contractor') { const q = U.call('jobs.contractorQuote', [st.pid, st.op, st.params], {}); cost = q.price || 0; label = '📞 Zamów usługę za ' + money(cost); }
    else { const e = (buildOwn(st).est) || {}; cost = e.cost || 0; label = '✅ Zleć (≈ ' + money(cost) + ')'; }
    return h('button.btn.primary.big', { onclick: () => submit(st) }, label);
  }
  function submit(st) {
    let r;
    if (st.exec === 'contractor') r = U.call('jobs.hireContractor', [st.pid, st.op, st.params], { ok: false, reason: 'Moduł prac niedostępny' });
    else { const own = buildOwn(st); if (!own.spec) r = { ok: false, need: 'machine', reason: 'Brak maszyny do zabiegu' }; else r = U.call('jobs.create', [own.spec], { ok: false, reason: 'Moduł prac niedostępny' }); }
    if (!r || r.ok === false) {
      U.toast('🚫 ' + ((r && r.reason) || 'Nie udało się zlecić'), 'bad'); U.haptic(30);
      if (r && r.need) { st.needFlash = r.need; go(st, 'exec'); }
      return;
    }
    U.sfx('ui_confirm'); U.haptic(18);
    U.toast((st.exec === 'contractor' ? '📞 Usługa zamówiona' : '🚜 Zlecenie przyjęte') + ': ' + opName(st.op), 'good');
    if (G.tutorial && G.tutorial.event) G.tutorial.event('jobCreated', { contractor: st.exec === 'contractor' });
    if (G.speed === 0 && !(G.tutorial && G.tutorial.active && G.tutorial.active())) U.toast('⏸ Gra jest wstrzymana — włącz tempo 1×, żeby ruszyć z pracą', 'info');
    U.back();
  }
  U.openPlanner = (pid, op, params) => U.open('planner', { pid, op, params }, { push: true });

  // =====================================================================================================
  // LISTA PRAC
  // =====================================================================================================
  const UNIT_STATE = v => v.unloading ? '🌾 rozładunek' : v.receiving ? '⬅️ odbiera ziarno' : v.working ? '⚙️ pracuje' : v.waiting ? '⏸ ' + (v.reason || 'czeka') : v.kind === 'parked' ? '🅿️ postój' : '🛣️ w drodze';
  U.panel('jobs', {
    title: 'Prace', live: 1000,
    sub: () => { const n = (U.call('jobs.list', [], []) || []).length; return n ? n + ' ' + (n === 1 ? 'aktywne zlecenie' : 'aktywne zlecenia') : 'brak aktywnych zleceń'; },
    render(body, arg, ctx) {
      const st = ctx.state; if (!st.tab) st.tab = 'active';
      body.appendChild(U.tabs([{ id: 'active', label: '⚙️ Aktywne' }, { id: 'hist', label: '📜 Historia' }], st.tab, id => { st.tab = id; U.rerender(); }));
      if (!G.jobs) { body.appendChild(h('div.empty', 'Moduł prac niedostępny')); return; }
      if (st.tab === 'hist') { renderHistory(body); return; }
      const jobs = G.jobs.list();
      if (!jobs.length) {
        body.appendChild(h('div.empty', h('span.ico', '📋'), 'Żadne maszyny teraz nie pracują.', h('div.small', { style: { marginTop: '6px' } }, 'Dotknij pola na mapie i wybierz zalecany zabieg.')));
        const adv = (U.call('fields.advice', [], []) || []).filter(a => a.op && a.pid != null).slice(0, 3);
        if (adv.length) { body.appendChild(h('div.section', 'Do zrobienia')); for (const a of adv) body.appendChild(adviceRow(a)); }
        return;
      }
      const vs = U.call('jobs.vehicles', [], []) || [];
      for (const j of jobs) {
        const card = U.jobCard(j, false);
        const units = vs.filter(v => v.jobUid === j.uid && !v.inGarage);
        if (units.length) {
          const box = h('div', { style: { marginTop: '8px', borderTop: '1px solid var(--line-2)', paddingTop: '6px' } });
          for (const v of units) {
            box.appendChild(h('div.veh-fill.clickable', { style: { padding: '5px 0', cursor: 'pointer' }, onclick: () => { U.centerOn(v.x, v.y, true); U.cam.follow = { uid: v.uid, jobUid: v.jobUid, unit: v.unit, k: v.k }; U.selectVehicle(v, false); if (U.isMobile()) U.close(); } },
              h('span', { style: { minWidth: '22px' } }, v.unit === 'shuttle' ? '🛒' : '🚜'),
              h('div.grow', h('div.small.b.ellipsis', v.label || 'Pojazd'), h('div.tiny' + (v.waiting ? '.warn' : '.muted'), UNIT_STATE(v))),
              v.fill != null && (v.unit === 'shuttle' || j.kind) ? h('div.bar.thin' + (v.unit === 'shuttle' ? '.blue' : '.gold'), { style: { width: '64px', flex: '0 0 64px' } }, h('i', { style: { width: Math.round((v.fill || 0) * 100) + '%' } })) : null,
              v.fill != null && (v.unit === 'shuttle' || j.kind) ? h('span.tiny.num', { style: { minWidth: '32px', textAlign: 'right' } }, Math.round((v.fill || 0) * 100) + '%') : null,
              h('span.gold', '›')));
          }
          card.insertBefore(box, card.lastChild);
        }
        body.appendChild(card);
      }
      body.appendChild(h('div.hint', 'Dotknij pojazdu, żeby kamera za nim podążała. Prace stoją w deszczu i gdy brakuje paliwa lub środków.'));
    }
  });
  function renderHistory(body) {
    const hist = (U.call('jobs.history', [], []) || []).slice().reverse().slice(0, 40);
    if (!hist.length) { body.appendChild(h('div.empty', h('span.ico', '📜'), 'Historia jest pusta.')); return; }
    const list = h('div.list');
    for (const j of hist) {
      const p = G.S.parcels[j.pid], d = G.date(j.finished || j.created);
      const out = Object.keys(j.outTotal || {}).filter(k => j.outTotal[k] > 0).map(k => G.fmtQty(k, j.outTotal[k]) + ' ' + P(k).name.toLowerCase()).join(', ');
      list.appendChild(h('div.item', h('span.ico', (OPS()[j.op] || {}).icon || '📋'),
        h('div.grow', h('div.b', opName(j.op) + (p ? ' — ' + p.name : '')), h('div.tiny.muted', d.dom + ' ' + G.MONTHS_GEN[d.month] + ' · ' + (j.contractor ? j.contractor.name : 'własne maszyny') + (out ? ' · ' + out : ''))),
        h('span.tag' + (j.status === 'done' ? '.green' : '.red'), j.status === 'done' ? 'gotowe' : j.status === 'cancelled' ? 'odwołane' : j.status)));
    }
    body.appendChild(list);
  }

  // =====================================================================================================
  // DORADCA
  // =====================================================================================================
  function ownAdvice() {
    const out = [], S = G.S, d = G.date();
    const jobs = U.call('jobs.list', [], []) || [];
    const ms = U.call('machines.list', [], []) || [];
    const broken = ms.filter(m => m.broken);
    if (broken.length) out.push({ key: 'broken', icon: '🔧', title: 'Awaria maszyny', text: broken.map(m => def(m).name).join(', ') + ' — napraw w zakładce Maszyny.', priority: 1, action: 'machines' });
    if (G.inv && G.inv.get('ON') < 60 && ms.some(m => (def(m) || {}).fuelLph)) out.push({ key: 'fuel', icon: '⛽', title: 'Mało paliwa', text: 'W zbiorniku ' + Math.round(G.inv.get('ON')) + ' l ON. Na stacji zapłacisz 25% więcej.', priority: 2, action: 'fuel' });
    const pools = U.call('buildings.storage', [], null);
    if (pools) for (const pl of pools) if (pl.cap > 0 && pl.used / pl.cap > 0.9) out.push({ key: 'full_' + pl.name, icon: '📦', title: 'Magazyn prawie pełny: ' + pl.name, text: G.fmtNum(pl.used, 0) + ' / ' + G.fmtNum(pl.cap, 0) + ' ' + pl.unit + '. Sprzedaj część albo zbuduj większy.', priority: 2, action: 'market' });
    const an = U.call('animals.needs', [], null);
    if (an && an.deficits && an.deficits.length) out.push({ key: 'feed', icon: '🐄', title: 'Brakuje paszy', text: an.deficits.map(x => x.name).join(', ') + ' — zwierzęta tracą zdrowie i produkcję.', priority: 1, action: 'animals' });
    if (!jobs.length && G.speed > 0 && (d.month >= 2 && d.month <= 9)) {
      const urgent = (U.call('fields.advice', [], []) || []).filter(a => a.op && a.priority === 1);
      if (urgent.length) out.push({ key: 'idle', icon: '😴', title: 'Maszyny stoją', text: 'Masz pilne zabiegi, a nic nie pracuje. Zleć je własnymi maszynami albo usługą.', priority: 2, action: null });
    }
    if (d.month === 11 || d.month <= 1) out.push({ key: 'winter', icon: '❄️', title: 'Zima — czas planowania', text: 'Przejrzyj maszyny (serwis), kup nasiona i nawozy na wiosnę, rozważ zakup ziemi i budowę.', priority: 3, action: null });
    if (S.money > 150000 && !(U.call('market.loans', [], []) || []).length) out.push({ key: 'invest', icon: '📈', title: 'Wolna gotówka', text: 'Masz ' + money(S.money) + '. Inwestuj: ziemia, maszyny albo nowy budynek inwentarski.', priority: 3, action: 'land' });
    return out;
  }
  function allAdvice() {
    const a = (U.call('fields.advice', [], []) || []).concat(ownAdvice());
    const seen = new Set();
    return a.filter(x => { const k = x.key || x.title; if (seen.has(k)) return false; seen.add(k); return true; }).sort((x, y) => x.priority - y.priority);
  }
  let advCache = { t: 0, n: 0 };
  U.adviceCount = function () {
    const now = performance.now();
    if (now - advCache.t > 2000) { advCache.t = now; try { const jobs = U.call('jobs.list', [], []) || []; advCache.n = allAdvice().filter(a => a.priority === 1 && !(a.op && jobs.some(j => j.pid === a.pid && j.op === a.op))).length; } catch (e) { advCache.n = 0; } }
    return advCache.n;
  };
  function runAdvice(a) {
    U.sfx('ui_tap');
    if (a.op && a.pid != null) { U.centerParcel(a.pid); G.view.selParcel = a.pid; U.open('planner', { pid: a.pid, op: a.op, params: a.params, fromRec: true }, { push: true }); return; }
    if (a.action === 'market') { if (a.product && /^buy_/.test(a.key || '')) U.open('market', { tab: 'shop', product: a.product }, { push: true }); else if (a.contract) U.open('market', { tab: 'contracts' }, { push: true }); else U.open('market', a.product ? { product: a.product } : null, { push: true }); return; }
    if (a.action === 'loan') { U.open('finance', null, { push: true }); return; }
    if (a.action === 'land') { U.open('land', null, { push: true }); return; }
    if (a.action === 'machines') { U.open('machines', null, { push: true }); return; }
    if (a.action === 'fuel') { U.open('machines', { tab: 'fuel' }, { push: true }); return; }
    if (a.action === 'animals') { U.open('animals', null, { push: true }); return; }
    if (a.pid != null) { U.centerParcel(a.pid); U.selectParcel(a.pid); }
  }
  function adviceRow(a) {
    const jobs = U.call('jobs.list', [], []) || [];
    const queued = a.op && jobs.some(j => j.pid === a.pid && j.op === a.op);
    const actionable = !queued && (a.op || a.action || a.pid != null);
    return h('button.rec-btn' + (a.priority === 1 && !queued ? '.p1' : '') + (queued ? '.off' : ''), { onclick: () => { if (queued) { U.open('jobs', null, { push: true }); return; } if (actionable) runAdvice(a); } },
      h('span.ico', a.icon || '💡'), h('div.grow', h('div.t', a.title), h('div.w', queued ? '🚜 już zlecone — w toku' : a.text)), actionable || queued ? h('span.arrow', '›') : null);
  }
  U.panel('advisor', {
    title: 'Co teraz?', live: 3000,
    sub: () => { const d = G.date(); return 'Doradca · ' + G.MONTHS[d.month] + ', ' + d.season; },
    render(body) {
      const list = allAdvice();
      const groups = [[1, '⚡ Pilne'], [2, '📌 Warto zrobić'], [3, '💭 Do rozważenia']];
      if (!list.length) { body.appendChild(h('div.empty', h('span.ico', '🌤️'), 'Wszystko pod kontrolą! Przyspiesz czas albo zaplanuj inwestycje.')); return; }
      for (const [pr, name] of groups) {
        const items = list.filter(a => a.priority === pr);
        if (!items.length) continue;
        body.appendChild(h('div.section', name + ' (' + items.length + ')'));
        const col = h('div.col');
        for (const a of items.slice(0, 8)) col.appendChild(adviceRow(a));
        body.appendChild(col);
      }
      body.appendChild(h('div.hint', '💡 Doradca patrzy na pola, pogodę, magazyn, umowy i finanse. Zielone ramki w kreatorze zleceń to zabiegi zalecane.'));
    }
  });
})();
