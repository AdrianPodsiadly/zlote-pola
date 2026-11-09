# Złote Pola — projekt i kontrakt modułów

Strategiczna gra ekonomiczna o prowadzeniu gospodarstwa rolnego w Polsce. Widok **izometryczny 2.5D**, **polski realizm**
(uprawy, rasy, gleby klasy I–VI, płodozmian, nawożenie NPK, wapnowanie, dopłaty, skup, giełda), **ciągły czas z pauzą**,
start: **mała farma po dziadku** (dom, stodoła, kurnik, garaż, stary ciągnik, kilka kur, 2 pola z oziminą/ścierniskiem, łąka, mały kredyt).
Gra ma wciągać na godziny: planowanie sezonu, inwestycje, rozbudowa, zakup ziemi, ludzie, maszyny, hodowla.
Teksty i komentarze **po polsku**. Grane głównie na **telefonie** (iPhone, podgląd w aplikacji) i Chromebooku.

## Zasady techniczne
- Czysty HTML/CSS/JS, bez bundlera i bibliotek, skrypty klasyczne, wspólna przestrzeń nazw `window.G`. Kolejność ładowania: `index.html`.
- **Brak zewnętrznych obrazków** (CSP pozwala tylko na data:/blob:) — cała grafika rysowana proceduralnie na canvasie (z buforowaniem sprite'ów).
- Każdy moduł **trzyma swój stan w `G.S.<klucz>`**, inicjalizuje go w hooku `'newGame'`, a w `'load'` waliduje/uzupełnia (stary zapis może nie mieć klucza). Stan musi być czystym JSON (dozwolone tablice typowane — zapis je obsługuje).
- Pieniądze: **tylko** przez `G.finance.spend(kwota, kategoria, opis)` / `G.finance.earn(...)`. Magazyn: **tylko** przez `G.inv.add/take/get`.
- Komunikaty: `G.notify(tekst, 'info'|'good'|'bad'|'money'|'warn', { key, tile, parcel })`.
- Nie zmieniaj plików innego modułu; potrzebujesz czegoś — użyj API/hooków. Brakujący moduł nie może wywracać gry (sprawdzaj `G.x && G.x.fn`).

## Czas
- Tick = 1 godzina gry (`G.CFG.TICK_MS`, doba domyślnie 150 s przy 1×; prędkości `G.CFG.SPEEDS` = [0, 1, 3, 8], ustawiane `G.setSpeed(mnożnik)`, odczyt `G.speed`).
- Kalendarz skrócony: miesiąc = 6 dni, rok = 72 dni gry. Start 1 marca 2026. `G.date(tick?)` → `{hour, dayIndex, dom, month (0–11), year, season ('zima'|'wiosna'|'lato'|'jesień'), doy (0..71), frac}`; `G.dateText()`.
- Hooki: `'tick'` (co godzinę), `'daily'(d)`, `'monthly'(d)`, `'yearly'(d)`, `'frame'(dtH, now, dtReal)` — dtH = ułamek godzin gry, które upłynęły w klatce (do płynnego ruchu maszyn i postępu prac), `'newGame'`, `'load'`, `'boot'(loaded)` (raz po starcie strony — UI/grafika się inicjują), `'notify'(n)`, `'money'(amt, cat)`, `'inventory'(id, qty)`, `'speed'(s)`.
- Zdarzenia domenowe (emitują moduły): `'opDone'(pid, op)`, `'harvest'(pid, product, qty)`, `'sold'(product, qty, zł)`, `'jobDone'(job)`, `'built'(building)`, `'bought'(kind, item)`, `'animalBorn'`, `'landBought'(parcel)`.

## Mapa (rdzeń: `js/core/map.js`)
- 96 × 96 kafelków, kafelek = 0,25 ha. `G.S.map = { t: Uint8Array (typ terenu G.T), soil: Uint8Array (klasa 1..6), parcel: Int16Array (-1 lub id działki), v: Uint8Array (wariant losowy) }`.
- `G.T`: GRASS, FIELD, FOREST, WATER, ROAD (polna), YARD (podwórze), MEADOW (łąka/pastwisko), VILLAGE (zabudowa wsi), ASPHALT.
- `G.S.parcels[id] = { id, name, tiles:[idx], area (ha), kind: 'field'|'meadow', soilAvg, owner: 'player'|'market'|'npc', leased (bool), price (zł), rent (zł/rok), cx, cy, box:{x0,y0,x1,y1}, entry (idx drogi przy wjeździe) }`.
- `G.S.farm = { yard: {x,y,w,h}, name }` — podwórze gracza (kafelki YARD).
- Pomocnicze: `G.idx(x,y)`, `G.tx(i)`, `G.ty(i)`, `G.N4(i)`, `G.parcelAt(i)`, `G.playerParcels()`, `G.isDrivable(i)`.

## Rzut izometryczny (rdzeń: `js/core/iso.js`)
- Romb TW=64 × TH=32 px przy zoom 1. `G.cam = {x, y, zoom, vw, vh}`. `G.iso.toWorld(tx,ty)`, `toTileF(X,Y)`, `tileToScreen(tx,ty)`, `screenToTileF(sx,sy)`, `pick(sx,sy)` → indeks kafelka, `centerOn`, `zoomAt`, `pan`, `visibleRange(pad)`.
- Teren płaski (wybór palcem dokładny). Obiekty (budynki, maszyny) mogą wystawać w górę ponad swój kafelek.

## Rdzeń: finanse, magazyn (`js/core/state.js`)
- `G.S.money`, `G.S.ledger` (ostatnie 200 operacji), `G.S.daily` (historia dzienna), `G.S.today`.
- `G.finance.spend(amt, cat, note, force?) → bool`, `G.finance.earn(amt, cat, note)`, `G.finance.canAfford(amt)`.
  Kategorie: 'sprzedaż', 'dopłaty', 'usługi', 'zakup maszyn', 'serwis', 'paliwo', 'nasiona', 'nawozy', 'środki ochrony', 'pasze', 'zwierzęta', 'budowa', 'płace', 'ziemia', 'dzierżawa', 'kredyt', 'odsetki', 'wynajem', 'inne'.
- `G.inv.get(id)`, `add(id, qty) → dodano`, `take(id, qty) → bool`, `capacity(id)`, `free(id)`; `G.inv.capacityFn` ustawia moduł budynków.
- `G.PRODUCTS[id] = { name, unit: 't'|'l'|'szt'|'kg'|'bela'|'m3', icon (emoji), cat, base (zł/jedn.), vol (0..1), perishable? (dni) }` — dane dopisują moduły.

## Identyfikatory produktów (wspólne!)
- Plony: `pszenica`, `pszenzyto`, `zyto`, `jeczmien`, `owies`, `rzepak`, `kukurydza`, `kiszonka` (kukurydza na kiszonkę, t), `ziemniaki`, `buraki` (cukrowe), `slonecznik`?, `soja`?; uboczne: `sloma` (bela), `siano` (bela), `sianokiszonka` (bela).
- Nasiona: `nasiona_<uprawa>` (kg lub t — zdefiniuj w danych), sadzeniaki: `nasiona_ziemniaki` (t).
- Nawozy i środki: `saletra` (t), `npk` (t), `wapno` (t), `obornik` (t), `gnojowica` (m3), `herbicyd` (l), `fungicyd` (l), `insektycyd` (l).
- Zwierzęce: `jaja` (szt), `mleko` (l), `zywiec_wieprzowy` (kg), `zywiec_wolowy` (kg), `welna` (kg), `miod` (kg).
- Pasze: `pasza_tresciwa` (t, mieszanka), poza tym zwierzęta jedzą zboża, kiszonkę, siano.
- Paliwo: `ON` (l, olej napędowy).

## Moduły i ich API (właściciele)

### Uprawy i rynek — `data/crops.js`, `sim/weather.js`, `sim/fields.js`, `sim/market.js`, `sim/land.js`
- `G.CROPS[id] = { name, winter (ozima?), sowMonths:[...], harvestMonths:[...], growDays, seedRate (jedn./ha), seed: productId, yieldBase t/ha, product, byproduct: {id, perHa}, nNeed, pNeed, kNeed (kg/ha), phOpt, soilPref [klasy], rotation: { bad:[poprzedniki], good:[...] }, look: { style: 'grain'|'rapeseed'|'maize'|'root'|'beet'|'grass', green, ripe, height } }`.
- Stan: `G.S.fields[pid] = { crop|null, phase, growth 0..1, plantedAt, n, p, k, ph, weeds, pests, disease, moisture, history:[...], yieldEst, quality, work: { op, done: Uint8Array|[] per kafel } ... }`.
  `phase`: 'stubble' (ściernisko) | 'plowed' | 'cultivated' | 'sown' | 'growing' | 'ripe' | 'harvested' | 'grass' (łąka) | 'mown' (skoszona łąka) | 'fallow'.
- Zabiegi `G.fields.OPS[op] = { name, icon, implement: kategoria narzędzia, needsInput?: produkt|fn, phases: [dozwolone fazy] }` dla: `plow` (orka), `cultivate` (uprawa/brona), `lime` (wapnowanie), `fertilize` (nawożenie: saletra/npk/obornik), `sow` (siew/sadzenie), `spray` (oprysk: herbicyd/fungicyd/insektycyd), `harvest` (zbiór), `bale` (prasowanie słomy/siana), `mow` (koszenie łąki), `rake` (zgrabianie).
- `G.fields.get(pid)`, `G.fields.canDo(pid, op, params) → {ok, reason}`, `G.fields.workTile(pid, i, op, params) → { out?: {produktId: ilość} }` (wołane przez prace, gdy maszyna obrobi kafel; zużywa nasiona/nawozy z magazynu proporcjonalnie), `G.fields.complete(pid, op, params)` (gdy całość gotowa), `G.fields.tileState(i) → { crop, phase, growth, worked (bool — kafel obrobiony w bieżącym zabiegu), weeds }` (dla grafiki), `G.fields.summary(pid)` (dla UI: opisy, prognoza plonu, zalecenia), `G.fields.advice()` → lista zaleceń na teraz (dla doradcy).
- `G.weather = { type: 'clear'|'cloudy'|'rain'|'storm'|'snow'|'fog', intensity, temp, wind, rainToday (mm), soilMoisture, forecast:[{day,type,tmin,tmax,rain}] }` — prace polowe nie idą w deszczu/na zmarzniętej ziemi (`G.weather.canWork() → {ok, reason}`).
- Rynek: `G.market.price(id)` (skup), `G.market.buyPrice(id)` (sklep), `sell(id, qty) → zł`, `buy(id, qty) → bool`, `history(id)`, kontrakty (`contracts()`, `accept(cid)`), dopłaty bezpośrednie (raz w roku, wg ha), kredyty (`loans()`, `takeLoan`, `repay`). Ceny sezonowe + losowe.
- Ziemia: `G.land.buy(pid)`, `G.land.lease(pid)`, `G.land.endLease(pid)`, `G.land.sell(pid)`, oferty zmieniają się co miesiąc (owner 'market').

### Hodowla i budynki — `data/animals.js`, `data/buildings.js`, `sim/animals.js`, `sim/buildings.js`
- `G.BUILDINGS[type] = { name, size:[w,h] (kafle), price, buildDays, model (klucz grafiki), color, capacity: { produktId|kategoria: ilość }, houses: { gatunek: sztuk }, upkeep (zł/dzień), levels?: [...], desc }`.
- Stan: `G.S.buildings = [{ uid, type, x, y, rot (0|1), level, progress 0..1 (budowa) }]`. Budynki stoją na kafelkach YARD (podwórze można powiększać przez zakup kafelków trawy przy podwórzu).
- API: `G.buildings.canPlace(type, x, y, rot) → {ok, reason}`, `place(type, x, y, rot) → building|null`, `upgrade(uid)`, `demolish(uid)`, `list()`, `at(i)` (budynek na kafelku); ustawia `G.inv.capacityFn`.
- `G.ANIMALS[gatunek] = { name, icon, model (klucz grafiki), building (typ), price, feed: { produkt: kg/dzień/szt }, water, products: { produkt: ilość/dzień/szt }, growth?, sellAs?, breeds? }`.
- Stan: `G.S.animals = { herds: [{ uid, species, count, buildingUid, health, fed, ... }] }`. API: `G.animals.buy(species, n, buildingUid)`, `sell(uid, n)`, `herds()`, `needs()`, `G.animals.sprites() → [{ x, y (kafel, ułamkowy), species, model, dir, anim }]` (dla grafiki: zwierzęta chodzą po wybiegu/pastwisku).

### Maszyny, ludzie, prace — `data/machines.js`, `sim/machines.js`, `sim/workers.js`, `sim/jobs.js`
- `G.MACHINES[id] = { name, brand (FIKCYJNA marka, np. „Ursak”, „Zetorix”, „Pronar”—NIE używaj prawdziwych marek ani logo), cat, ops:[zabiegi], hp (ciągniki/kombajny), reqHp (narzędzia), width (m), speed (km/h roboczo), cap (t/l), price, rentPerDay, fuelLph, model (klucz grafiki), color, year?, desc }`.
  `cat`: 'tractor' | 'combine' | 'plow' | 'cultivator' | 'seeder' | 'planter' | 'sprayer' | 'spreader' | 'manure_spreader' | 'mower' | 'rake' | 'baler' | 'trailer' | 'header' | 'potato_harvester' | 'beet_harvester' | 'loader' | 'forage_harvester'.
- Stan: `G.S.machines = [{ uid, id, rented (bool), until (tick), wear 0..1, hours, busy: jobUid|null, x?, y? }]`; `G.S.workers = [{ uid, name, age, skills: {field, mech, animals} (1..5), wage (zł/dzień), energy, busy, contract }]` — gracz („Ty”) jest pracownikiem bez pensji.
- API maszyn: `G.machines.list()`, `catalog()`, `buy(id)`, `sell(uid)`, `rent(id, days)`, `repair(uid)`, `compatible(op) → [{tractor, implement}]`.
- API ludzi: `G.workers.list()`, `candidates()`, `hire(cid)`, `fire(uid)`.
- API prac: `G.jobs.create({ op, pid, params, machines: [uid...], worker: uid }) → { ok, job | reason }`, `estimate(spec) → { hours, fuel, cost }`, `cancel(uid)`, `list()`, `contractorQuote(pid, op, params) → { price, days }`, `hireContractor(pid, op, params)` (usługa — na początku gra bez maszyn), `G.jobs.vehicles() → [{ x, y (kafel ułamkowy), angle (rad w układzie kafli), parts: [{ model, color }] (ciągnik + narzędzie/przyczepa), working (bool), dust (bool), lights (bool) }]`.
  Maszyna wyjeżdża z podwórza, jedzie drogami do wjazdu działki, obrabia pole pasami (serpentyna) — każdy obrobiony kafel → `G.fields.workTile`, na koniec `G.fields.complete`, wraca na podwórze. Postęp oparty na wydajności (ha/h = szerokość × prędkość / 10 × 0,8), czas gry z hooka `'frame'` (dtH).

### Grafika — `render/*.js`
- Rysuje WYŁĄCZNIE na podstawie stanu: mapa, działki (miedze, granice, własność), `G.fields.tileState(i)`, `G.S.buildings` + `G.BUILDINGS[type].model`, `G.jobs.vehicles()`, `G.animals.sprites()`, `G.weather`, `G.date()`, `G.hourFrac`, `G.view` (podświetlenia z UI).
- Klucze modeli (sprite'y proceduralne; nieznany klucz → ogólna bryła w kolorze `color`):
  - pojazdy: `tractor_small`, `tractor_mid`, `tractor_big`, `combine`, `telehandler`, `pickup`, `forage_harvester`;
  - narzędzia/przyczepy: `plow`, `cultivator`, `seeder`, `planter`, `sprayer`, `spreader`, `manure_spreader`, `mower`, `rake`, `baler`, `trailer`, `tank`, `header`, `potato_harvester`, `beet_harvester`;
  - budynki: `house`, `barn`, `garage`, `henhouse`, `cowshed`, `pigsty`, `sheepfold`, `silo`, `granary`, `potato_store`, `hayshed`, `manure_pad`, `workshop`, `fuel_station`, `greenhouse`, `biogas`, `apiary`, `stable`;
  - zwierzęta: `hen`, `cow`, `calf`, `pig`, `sheep`, `goat`, `horse`, `bee`;
  - uprawy (`look.style`): `grain`, `rapeseed`, `maize`, `root`, `beet`, `grass`, `sunflower`.
- `G.view = { hover, selParcel, highlight:[idx], place:{type,x,y,rot,valid}|null, selBuilding, selVehicle }` — ustawia UI.
- API: `G.render.init(canvas)`, `draw(now, dtReal)`, `resize()`, `minimap(ctx, w, h)`, `G.fx.burst(x, y, kind)`.

### Interfejs — `ui/*.js`, `css/style.css`, `index.html`
- Mobile-first, UX najwyższej jakości: HUD (data, pora dnia, pogoda, pieniądze, prędkość), dolny pasek głównych sekcji, panel działki po dotknięciu (stan pola, zalecenia, przyciski zabiegów), kreator zlecenia (zabieg → maszyny → pracownik → szacunek kosztu/czasu), rynek (wykresy cen), finanse (księga, wykresy), maszyny (sklep/wynajem/serwis), ludzie, zwierzęta, budynki (tryb stawiania z podglądem), ziemia (oferty), doradca („co teraz robić”), samouczek, ekran tytułowy, zapis/eksport, ustawienia (długość doby `G.setDayLength`, dźwięk).
- Sterowanie: przesuwanie jednym palcem, zoom dwoma, dotknięcie = wybór (`G.iso.pick`), mysz + kółko, klawiatura.

## Uzupełnienia kontraktu (po pierwszej rundzie — obowiązujące)
### Zbiór i transport (zrealizowane w sim/jobs.js)
- Kombajn napełnia zbiornik (`tankL`/`cap` t) i rozładowuje WYŁĄCZNIE rurą (ślimakiem, lewa strona) na przyczepę ciągniętą przez ciągnik. Nigdy nie zjeżdża z pola z ziarnem. Zlecenie zbioru wymaga ≥1 zestawu ciągnik+przyczepa+kierowca (`helpers`, `sets`), albo `transport: n` (wynajęty) albo kontraktora.
- `vehicles()` zwraca dla kombajnu: `unloading`, `auger: 'in'|'out'`, `fill`; dla przyczepy: `fill`, `receiving`, `kind: 'own'|'contractor'|'transport'|'parked'`; `inGarage: true` → nie rysować; `broken`, `waiting`, `label`.
### Przyczepy (DO ZROBIENIA — agent maszyn)
- Pole `axle`: `'dwuosiowa'` (przednia oś skrętna na obrotnicy, 4–18 t) | `'jednoosiowa'` (3–8 t) | `'tandem'` (8–20 t) | `'tridem'` (20–30 t). Ładowność w tonach (`cap`), opcjonalnie m³ (zboże 0,76 t/m³). Ciągnik może ciągnąć 2 przyczepy (druga za pierwszą; `parts: [ciągnik, p1, p2]`, każda z `axle`, `cap`, `fill`).
- Kombajny: `tankL` (4 400 / 8 000–9 000 / 11 000–12 500 / 14 500 l), `unloadLps` (75 / 105 / 125).
- Rozładunek przyczepy: `G.buildings.unloadPoint(productId)` → `{x, y, buildingUid, free}` (istnieje).
### Bezpośrednia kontrola pojazdów i ręczna jazda (DO ZROBIENIA — agent maszyn + UI + grafika)
- Trwałe pozycje maszyn w `G.S.machines[*]`: `x, y, angle, attachedTo, hitch[], lowered, driver, order, parked`. Narzędzia odczepione stoją tam, gdzie je zostawiono (`vehicles()` → `kind: 'implement'`).
- `G.machines.at(x, y, r)`, `G.machines.actions(uid, target) → [{id, label, icon, enabled, reason}]` (goto, work, hitch, unhitch, lower, raise, follow_combine, unload, refuel, garage, assign_driver, stop, drive), `G.machines.command(uid, actionId, target, params) → {ok, reason}`.
- `G.drive`: `take(uid)`, `release()`, `active()`, `input({throttle, steer, brake})` co klatkę (czas rzeczywisty, niezależny od prędkości gry), `toggleImplement()`, `hitchNearest()`, `unhitch()`, `unloadAuger()`, `needParams()/setParams(p)`, `state() → {speed, gear, fuel, implement, lowered, fill, tile, parcelId, canHitch, hints}`. Opuszczone narzędzie obrabia kafle (`G.fields.workTile`) pod szerokością roboczą.
- UI: tap = wybór pojazdu (`G.view.selVehicle`), prawy klik / długie przytrzymanie = menu akcji, przycisk „Prowadź” → HUD jazdy (joystick / WASD). Grafika: pierścień zaznaczenia, odczepione narzędzia, `lowered`, `manual`.
### Silosy (zrealizowane): `silo_hopper` (variant 'hopper'), `silo_flat` ('flat'), `feed_bin` ('feed'), `granary`, `barn` — pojemności w t; `potato_store` — przechowalnia ziemniaków (pula 'ziemniaki', do której należą też sadzeniaki `nasiona_ziemniaki`); grafika rozróżnia po `G.BUILDINGS[type].variant`.
### Balans upraw (DO ZROBIENIA — agent upraw): dobra agrotechnika ma wygrywać z zaniedbaniem w ≥85% symulacji po 2 latach; klasy jakości ziarna (konsumpcyjna/paszowa, `G.market.price(id, quality?)`).
### Dźwięk (DO ZROBIENIA — agent dźwięku): `js/ui/sound.js` → `G.sound` (unlock, toggle, setVol, CHANNELS, play, duck, update); UI dodaje przycisk i suwaki.
