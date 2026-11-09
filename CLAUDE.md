# Złote Pola — zasady pracy

Najpierw przeczytaj **DESIGN.md** — tam jest kontrakt między modułami (API, klucze stanu, identyfikatory produktów i modeli grafiki).

- Autor: Adrian (Polak). Gra mobile-first, polski interfejs i komentarze w kodzie.
- Autor oczekuje **pełnych plików** przy pokazywaniu kodu, nie fragmentów.
- Czysty HTML/CSS/JS bez bundlera; brak zewnętrznych obrazków (grafika proceduralna).
- Zapis: każdy moduł waliduje swój stan w hooku `'load'`; zmiana rdzenia zapisu → `G.SAVE_VERSION` + migracja w `js/core/storage.js`. Nowe numery w `G.T` tylko na końcu.
- Wydanie: podbij `G.VERSION` i `?v=` przy wszystkich plikach w `index.html`, dopisz `CHANGELOG.md`.
- Test dymny: `python3 tools/smoke_test.py` (Playwright + /usr/bin/google-chrome).
- Nie używaj prawdziwych marek maszyn ani ich logo (fikcyjne nazwy).
