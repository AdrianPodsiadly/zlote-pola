# Złote Pola — historia zmian

## 0.1.4

- Naprawiony „Błąd ekranu” w Rynku → Sklep (nazwy klas CSS ze spacją wywracały cały ekran). Przegląd wszystkich paneli i zakładek — bez błędów.

## 0.1.3
- Naprawione rozkazy z menu pojazdu („Jedź tutaj”, „Obrób działkę”): interfejs podawał cel jako numer kafla, a symulacja oczekiwała obiektu — każdy cel wychodził „Poza mapą”.

## 0.1.2
- Naprawione **przydzielanie kierowcy**: menu pytało o nic i od razu wysadzało kierowcę. Teraz pojawia się wybór (Ty / pracownicy), a w karcie pojazdu jest przycisk „Przydziel kierowcę”.
- Okienka wyboru z symulacji (uprawa do siewu, nawóz przy rozkazie „Obrób”) wyświetlają się poprawnie.

## 0.1.1
- **Ustawienia → Rozgrywka:** przełącznik **Pory roku** (wyłączone = zawsze sezon wegetacyjny: klimat i wygląd czerwca, siew dowolnej uprawy w każdej chwili, bez zimy) i **Realistyczna pogoda w pracach**.
- Domyślnie prace polowe idą w każdą pogodę — **tylko zbiór i prasowanie nie w deszczu** (i chwilę po nim, aż łan/słoma obeschnie).
- Kury nie głodują na starcie: więcej paszy w magazynie i domyślnie włączony auto-zakup paszy treściwej.

## 0.1.0 — pierwsza grywalna wersja
- Mapa izometryczna 96×96 (ok. 2300 ha): rzeka, wieś, asfalt, drogi polne, lasy, 150+ działek z klasami gleby I–VI.
- Start: gospodarstwo po dziadku — dom, stodoła, kurnik z 12 kurami, garaż, stary ciągnik 60 KM, pług, przyczepa, 3 pola i łąka, 60 000 zł i kredyt.
- Uprawy: 12 polskich upraw, fazy wzrostu, NPK, pH, chwasty, choroby, płodozmian, klasy jakości ziarna, plony skalibrowane do średnich GUS.
- Pogoda z prognozą, okna prac polowych; rynek z sezonowymi cenami, kontrakty, dopłaty, podatek, kredyty; zakup i dzierżawa ziemi.
- Hodowla: kury, krowy, opasy, tuczniki, owce, kozy, konie, pszczoły; żywienie, zdrowie, rozród, produkcja.
- Budynki: 18+ typów z poziomami (obora do robotów udojowych), silosy lejowe/płaskodenne/paszowe, magazyny, rozbudowa podwórza.
- Maszyny: ciągniki 60–220 KM, kombajny ze zbiornikami 4 400–14 500 l, przyczepy jedno-/dwuosiowe/tandem/tridem 4–30 t, zestawy z 2 przyczepami, wynajem, używane, serwis, paliwo.
- Zlecenia: maszyny same dojeżdżają drogami i obrabiają pole pasami; zbiór z przeładunkiem rurą na przyczepy (kombajn nie zjeżdża z ziarnem); usługi kontraktorów i wynajęty transport.
- Rozkazy jak w grach RTS (wybór pojazdu, menu akcji, podczep/odczep) i ręczna jazda (joystick / WASD), z obróbką pola opuszczonym narzędziem.
- Interfejs mobile-first: ekran tytułowy, samouczek, doradca „Co teraz?”, panel działki z zaleceniami, kreator zleceń, rynek, finanse, magazyn, ludzie, zwierzęta, budowa, ziemia, zapis/eksport.
- Grafika proceduralna: budynki i maszyny 3D, uprawy w każdej fazie, pory roku, dzień i noc, pogoda, cienie.
- Dźwięk syntezowany: silniki, zwierzęta, otoczenie, pogoda, muzyka proceduralna, mikser.
