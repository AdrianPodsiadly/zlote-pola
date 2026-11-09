// Złote Pola — zapis gry: sloty, kopia zapasowa, migracje, eksport/import (telefon ↔ komputer)
//
// ZASADY: cały G.S jest zapisywany jako JSON (tablice typowane są zamieniane automatycznie).
// Moduły trzymają stan w G.S.<klucz> i SAME go walidują w hooku 'load' (stary zapis może nie mieć ich klucza).
// Zmiana struktury rdzenia → G.SAVE_VERSION + 1 i funkcja w MIGRATIONS.
(function () {
  const C = G.CFG, P = C.SAVE_PREFIX;
  const ST = G.storage = { lastError: null };
  const TA = { Uint8Array, Int16Array, Int32Array, Float32Array, Uint16Array };

  const ls = {
    get(k) { try { return localStorage.getItem(P + k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(P + k, v); return true; } catch (e) { ST.lastError = e; return false; } },
    del(k) { try { localStorage.removeItem(P + k); } catch (e) { /* brak */ } }
  };
  ST.available = (function () { try { localStorage.setItem(P + 't', '1'); localStorage.removeItem(P + 't'); return true; } catch (e) { return false; } })();

  ST.toJSON = function (S) {
    return JSON.stringify(S, (k, val) => {
      for (const n in TA) if (val instanceof TA[n]) return { __ta: n, d: Array.from(val) };
      return val;
    });
  };
  ST.fromJSON = function (s) {
    return JSON.parse(s, (k, val) => (val && val.__ta && TA[val.__ta]) ? TA[val.__ta].from(val.d) : val);
  };

  const MIGRATIONS = {
    // przykład: 1: d => { ...; d.v = 2; return d; }
  };
  ST.migrate = function (d) {
    let v = d.v | 0;
    if (v < 1) throw new Error('Nieznany format zapisu');
    while (v < G.SAVE_VERSION) {
      if (!MIGRATIONS[v]) throw new Error('Brak migracji z wersji ' + v);
      d = MIGRATIONS[v](d); v = d.v;
    }
    return d;
  };

  ST.restore = function (d) {
    d = ST.migrate(d);
    const n = C.W * C.H;
    if (!d.map || !d.map.t || d.map.t.length !== n) throw new Error('Uszkodzona mapa');
    const S = Object.assign(G.defaultState(d.seed || 1), d);
    G.S = S;
    G.emit('load');
    return S;
  };

  ST.SLOTS = ['auto', 'slot1', 'slot2', 'slot3'];
  ST.slotName = k => k === 'auto' ? 'Autozapis' : 'Slot ' + k.slice(4);

  ST.save = function (slot) {
    slot = slot || 'auto';
    try {
      const S = G.S;
      S.savedAt = Date.now(); S.game = G.VERSION;
      const json = ST.toJSON(S);
      if (slot === 'auto') { const prev = ls.get('auto'); if (prev) ls.set('auto_prev', prev); }
      return ls.set(slot, json);
    } catch (e) { ST.lastError = e; console.error(e); return false; }
  };
  ST.loadSlot = function (slot) {
    const s = ls.get(slot);
    if (!s) return false;
    try { ST.restore(ST.fromJSON(s)); return true; }
    catch (e) { console.error('Nie wczytano', slot, e); ST.lastError = e; ls.set('broken_' + Date.now(), s); return false; }
  };
  ST.meta = function (slot) {
    const s = ls.get(slot);
    if (!s) return null;
    try {
      const d = JSON.parse(s);
      return { date: G.dateText ? G.dateText(d.tick || 0) : '', money: d.money, savedAt: d.savedAt, game: d.game, ha: (d.parcels || []).filter(p => p.owner === 'player').reduce((a, p) => a + p.area, 0) };
    } catch (e) { return { broken: true }; }
  };
  ST.del = slot => ls.del(slot);
  ST.hasSave = () => !!ls.get('auto');
  ST.loadStartup = function () {
    if (ST.loadSlot('auto')) return 'auto';
    if (ST.loadSlot('auto_prev')) return 'auto_prev';
    return null;
  };

  // ---------- eksport / import ----------
  function b64(bytes) { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); }
  function unb64(s) { const b = atob(s), o = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) o[i] = b.charCodeAt(i); return o; }
  async function pipe(bytes, stream) { return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer()); }

  ST.exportCode = async function () {
    const bytes = new TextEncoder().encode(ST.toJSON(G.S));
    if (typeof CompressionStream !== 'undefined') {
      try { return 'ZP1Z:' + b64(await pipe(bytes, new CompressionStream('gzip'))); } catch (e) { /* bez kompresji */ }
    }
    return 'ZP1J:' + b64(bytes);
  };
  ST.importCode = async function (code) {
    code = String(code || '').trim().replace(/\s+/g, '');
    let json;
    if (code.startsWith('ZP1Z:')) json = new TextDecoder().decode(await pipe(unb64(code.slice(5)), new DecompressionStream('gzip')));
    else if (code.startsWith('ZP1J:')) json = new TextDecoder().decode(unb64(code.slice(5)));
    else if (code.startsWith('{')) json = code;
    else throw new Error('To nie jest kod zapisu Złotych Pól');
    const prev = ST.toJSON(G.S);
    try { ST.restore(ST.fromJSON(json)); } catch (e) { ST.restore(ST.fromJSON(prev)); throw e; }
    ST.save('auto');
  };
  ST.downloadFile = async function () {
    const code = await ST.exportCode();
    try {
      const url = URL.createObjectURL(new Blob([code], { type: 'text/plain' }));
      const a = document.createElement('a');
      a.href = url; a.download = 'zlote-pola-' + G.date().year + '-' + (G.date().month + 1) + '.zp';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      return true;
    } catch (e) { return false; }
  };
})();
