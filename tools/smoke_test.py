# Złote Pola — test dymny: wczytanie, symulacja dni, zapis/odczyt, błędy konsoli.
# Użycie: python3 tools/smoke_test.py [dni]
import asyncio, json, os, sys
from playwright.async_api import async_playwright
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
DAYS = int(sys.argv[1]) if len(sys.argv) > 1 else 10
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        pg = await b.new_page(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
        errs = []
        pg.on('pageerror', lambda e: errs.append('PAGEERR ' + str(e)))
        pg.on('console', lambda m: errs.append('console: ' + m.text) if m.type == 'error' and 'ERR_TUNNEL' not in m.text and 'fonts.g' not in m.text else None)
        await pg.goto('file://' + ROOT + '/index.html')
        await pg.wait_for_timeout(1200)
        r = await pg.evaluate('''(days) => {
          G.newGame(12345); G.setSpeed(0);
          const t0 = performance.now();
          for (let d = 0; d < days; d++) for (let h = 0; h < 24; h++) { G.tick(); for (let f = 0; f < 4; f++) G.emit('frame', 0.25, performance.now(), 0.016); }
          const simMs = Math.round(performance.now() - t0);
          G.storage.save('auto'); const ok = G.storage.loadSlot('auto');
          return { date: G.dateText(), money: Math.round(G.S.money), inv: G.S.inv, simMs, saveLoad: ok,
                   modules: ['fields','market','land','weather','animals','buildings','machines','workers','jobs','render','ui','fx','sprites'].filter(k => G[k]) };
        }''', DAYS)
        print(json.dumps(r, ensure_ascii=False))
        await pg.screenshot(path='/tmp/zp_smoke.png')
        print('ERRORS:', errs[:15])
        await b.close()
asyncio.run(main())
