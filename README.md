# VibeEditor

Asystent edytowania map do **OMSI**. Aplikacja desktopowa (Windows) spinająca folder roboczy mapy z Gitem/GitHubem i Claude Code: zbierasz zadania, a Claude wykonuje je na plikach mapy.

## Stos

Electron + TypeScript (bez frameworka UI). Logika rdzenia (`src/main/core`) nie zależy od Electrona i ma testy.

## Uruchomienie

```
npm install
npm start          # build + uruchomienie
npm test           # testy rdzenia (node:test, wymaga Node 22.6+)
npm run typecheck
npm run dist       # instalator Windows (NSIS)
```

Wymagania na maszynie: **Git** w `PATH` oraz — zależnie od trybu Claude w ustawieniach — **Claude Code** (`claude`) zalogowany do konta (przycisk „Zaloguj w Claude…” otwiera terminal, w którym wpisujesz `/login`) albo zainstalowana **aplikacja Claude** (Claude Free, patrz niżej).

### Uprawnienia administratora

Instalator budowany przez `npm run dist` ma w manifeście `requireAdministrator`, więc cała aplikacja (a z nią procesy `git` i `claude`) działa jako admin, a okna typu Git Credential Manager przy pushu pojawiają się same. Polecenia Gita idą w **ukrytym oknie** (`windowsHide`), a ich output trafia do zakładki „Konsola”. W trybie `npm start` elewacja zależy od tego, czy terminal jest uruchomiony jako administrator.

## Folder roboczy

```
<folder roboczy>/
  <folder mapy>/      ← rozpoznawany po global.cfg zawierającym znaczniki [name], [friendlyname], [description]
  _vibe/              ← tworzony przez VibeEditor: zadania (tasks.json), prompty (prompts/), assety
```

Folder bez takiego `global.cfg` nie może zostać wybrany jako roboczy. Znaczniki `[name]`, `[friendlyname]`, `[description]` mogą stać w dowolnym miejscu pliku i w dowolnej kolejności — liczy się to, co jest pod nimi. Tak samo w plikach `.map` i `.sco`: czytamy to, co leży pod znacznikami, bez względu na to, czym plik się zaczyna.

## Konfiguracja (pierwsze uruchomienie i Ustawienia)

Po zatwierdzeniu VibeEditor: zapisuje zmiany `name`/`friendlyname`/`description` do `global.cfg` (z zachowaniem kodowania, np. Windows-1250), podpina folder pod repo (`git init`, `origin`), tworzy gałąź `VibeEditor` (albo używa `main`, gdy zaznaczono „Pracuj na main”), commituje całość i pushuje.

Folder roboczy jest **źródłem prawdy**: jeśli zdalna gałąź zawiera pliki, których nie ma lokalnie, nowy commit je usunie (historia zostaje).

## Indeks mapy i assety

Za każdym razem, gdy podłączany jest nowy folder roboczy (zmiana folderu, mapy lub folderu OMSI) — oraz przyciskiem „Przeskanuj mapę ponownie” w zakładce Mapa i trasy:

1. z `global.cfg` czytana jest lista kafli (znaczniki `[map]`: koordynaty x, y + plik `.map`),
2. każdy plik `.map` jest skanowany strumieniowo; ze znaczników `[spline]`, `[spline_h]`, `[object]`, `[splineAttachement]`, `[attachObj]` zbierana jest ścieżka stojąca **dwie linijki niżej** (unikatowe, osobno dla kafla i dla całej mapy),
3. wszystkie pliki z tego rejestru są kopiowane z folderu OMSI do `_vibe/assets/` z zachowaniem ścieżek (`<OMSI>/Splines/x.sli` → `_vibe/assets/Splines/x.sli`); same pliki nie są czytane,
4. wynik zapisywany jest w `_vibe/map-index.json` (kafle, ich assety, lista brakujących w OMSI).

`_vibe/assets/` jest wyłączone z repo lokalnie (`.git/info/exclude`) — to kopie plików gry (rozmiar, cudze prawa); `map-index.json` do repo trafia.

Do promptu dla Claude dopisywana jest krótka notka, że dokładne dane o splinach i obiektach są w `_vibe/assets/` (Claude szuka w nich Globem/Grepem zamiast dostawać je w prompcie).

## Trasa kursu (.ttr)

Plik `.ttr` to lista wpisów `[track_entry]`: ID splinu lub obiektu · numer ścieżki ruchu w jego `.sli`/`.sco` · indeks kafla (kolejność `[map]` w `global.cfg`) · numer elementu na kaflu · długość · flaga. VibeEditor czyta potrzebne kafle `.map` na żądanie (bez ponownego skanowania mapy), znajduje spline/obiekt po ID, liczy przebieg wskazanej ścieżki (z kopii `.sli`/`.sco` w `_vibe/assets`) i rysuje go na mapie. Przystanki kursu bierze z `[station]` w `.ttp` (ID obiektu przystanku), a gdy go nie ma w `map-stops.json` — dopasowuje po nazwie. 4. linijka wpisu to pozycja splinu wśród splinów kafla mających ścieżkę dla pojazdów (typ 0 lub 2 w `.sli`; potwierdzone na kaflu Warszawa 2008; dla obiektów to analogiczne założenie, a pasek informacji zlicza rozbieżności osobno dla splinów i obiektów). Założenia nie potwierdzone w grze:, 6. to flaga (zawsze 0 w próbce), oraz to, że rysowany jest cały odcinek ścieżki, a nie tylko `długość` z `.ttr`.

## Zakładki (w kolejności)

- **Zadania** — lista zadań (Aktywne / Odrzucone / Archiwum), „+ Dodaj”, „▶️ Uruchom”, „⏹️ Zatrzymaj”.
- **Mapa i trasy** — przesuwalna i zoomowalna siatka kafli, start wycentrowany na środku mapy. Klik w kafel pokazuje w prawym górnym rogu koordynaty, plik `.map`, liczbę assetów i brakujące w OMSI. „📍 Dodaj pinezkę”: w tym trybie klik w punkt mapy otwiera nowe zadanie z tą pinezką; pinezki zadań (aktywnych i odrzuconych) są rysowane na mapie, klik w pinezkę pokazuje tytuł zadania.
  Przybliżenie do ok. 20 px na metr. Pasek „Trasa kursu” rysuje trasę z pliku `.ttr` o tej samej nazwie co `.ttp` (szukany najpierw w tym samym folderze, potem w całym folderze mapy; wielkość liter i `-`/`_` nie mają znaczenia) wraz z przystankami kursu; to samo robi przycisk „🗺️ Pokaż trasę na mapie” w zakładce Rozkłady (przy kursie z plikiem `.ttr`).
  **Edycja trasy:** wybierz kurs w pasku „Trasa kursu” i kliknij „✏️ Edytuj trasę” (kurs bez `.ttr` też — plik powstanie przy zapisie). Klik w ścieżkę ruchu (jezdnię albo ścieżkę obiektu, np. skrzyżowania) dodaje ją jako odcinek po zaznaczonym (albo na końcu); klik w odcinek trasy zaznacza go; panel po prawej ma listę odcinków z ▲/▼ (kolejność), 🗑️ (usuń), ↶/↷ (cofnij/ponów) i „💾 Zapisz .ttr”. Skróty: Delete, Ctrl+Z, Ctrl+Y, Ctrl+S, Esc. Pierwszy zapis robi kopię `.ttr.bak`.
  **Podświetlanie:** po włączeniu edycji warstwy Spliny, Ścieżki i Przystanki włączają się same. Kursor nad ścieżką ruchu podświetla ją na fioletowo; gdy ścieżka jest połączona (początek w ≤ 2,5 m od końca poprzedniej, kierunek ±50°) z zaznaczonym odcinkiem (albo z ostatnim, gdy nic nie zaznaczono), podświetla cały najkrótszy łańcuch ścieżek między nimi włącznie, a klik dodaje je wszystkie po kolei. Ścieżki splinów z kierunkiem 1 w `.sli` są liczone od końca splinu do początku.
  **Przystanki:** druga lista w panelu („Przystanki”) pokazuje przystanki kursu z przypisanymi odcinkami; „➕ Dodaj przystanek” + klik przystanku na mapie przypisuje go do zaznaczonego odcinka (a bez zaznaczenia — do najbliższego) i przy zapisie dopisuje blok `[station]` do `.ttp` (kopia `.ttp.bak`, numery przystanków w profilach przesuwane). Pola `[station]`: ID obiektu · numer wpisu `.ttr` · nazwa · indeks kafla · położenie na ścieżce wpisu (m) · suma długości wpisów do końca tego wpisu · długość wpisu · ostatnia liczba. To hipoteza; edytor sprawdza ją na wczytanym kursie (pasek informacji i dół listy: „zgodne N/N”) i wyłącza dodawanie przystanków, gdy się nie potwierdza. Zmiana kolejności lub usunięcie odcinków przepisuje wpis i sumy istniejących przystanków; usunięcie odcinka z przystankiem jest blokowane przy zapisie. Nowy wpis dostaje: ID splinu/obiektu, numer klikniętej ścieżki, indeks kafla, pozycję elementu w pliku kafla (to ostatnie to przypuszczenie — pasek informacji ostrzega, gdy w istniejących wpisach się nie zgadza), długość ścieżki i flagę 0.
- **Rozkłady** — linie (`.ttl`) i kursy (`.ttp`) z folderu mapy: lista po lewej (zachowuje przewinięcie po kliknięciu pozycji), edytor po prawej.
- **Jezdnie** — lista wszystkich wczytanych splinów (`[spline]`, `[spline_h]`) po ścieżce, z filtrem. Dwuklik tworzy nowe zadanie z podpiętą jezdnią.
- **Obiekty** — drzewo obiektów z plików `.sco`: `[groups]` (liczba, a pod nią nazwy „folderów” od korzenia) i `[friendlyname]` (np. `📂 Aachen › 📂 Gruen › 🏠 Busch`). Dwuklik tworzy nowe zadanie z podpiętym obiektem.
- **Konsola** — output Gita i Claude (filtr: wszystko / tylko Git / tylko Claude).

## Tryb Claude (Ustawienia)

Dwa radio buttony:

- **Claude Code** — jak dotąd: VibeEditor uruchamia `claude -p` w folderze roboczym (opcjonalna ścieżka do `claude`, przyciski „Sprawdź Claude” i „Zaloguj w Claude…”).
- **Claude Free** — pole na link czatu (`https://claude.ai/chat/ID`). Po „Uruchom” prompt trafia do schowka, aplikacja otwiera ten czat w aplikacji Claude (`claude://claude.ai/chat/ID`), czeka na okno i wkleja prompt (Ctrl+V); Ty zatwierdzasz Enterem — albo robi to sama, gdy zaznaczysz „Wyślij automatycznie (Enter po wklejeniu)”. Automatyczne wklejanie działa tylko w Windows. Aplikacja nie widzi, kiedy Claude skończy, więc zadania trafiają do Archiwum od razu po wklejeniu.

Pinezka jest zapisana w jednostkach kafli (środek kafla (x, y) to dokładnie (x, y), oś Y rośnie na północ); w prompcie przeliczana jest na przesunięcie od środka kafla w metrach przy założeniu kafla 300×300 m.

## Do zrobienia

- Kolejne rodzaje zadań.

## Wygląd

Interfejs stylizowany na Windows XP (motyw Luna): własny pasek tytułu z przyciskami okna (okno bez natywnej ramki), pasek menu, karty jak w oknie właściwości, okna dialogowe z niebieskim paskiem i pasek stanu. Kolory i czcionki są zmiennymi CSS na początku `src/renderer/styles.css`.
