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

Wymagania na maszynie: **Git** w `PATH` oraz **Claude Code** (`claude`) zalogowany do konta (przycisk „Zaloguj w Claude…” w ustawieniach otwiera terminal, w którym wpisujesz `/login`).

### Uprawnienia administratora

Instalator budowany przez `npm run dist` ma w manifeście `requireAdministrator`, więc cała aplikacja (a z nią procesy `git` i `claude`) działa jako admin, a okna typu Git Credential Manager przy pushu pojawiają się same. Polecenia Gita idą w **ukrytym oknie** (`windowsHide`), a ich output trafia do zakładki „Konsola”. W trybie `npm start` elewacja zależy od tego, czy terminal jest uruchomiony jako administrator.

## Folder roboczy

```
<folder roboczy>/
  <folder mapy>/      ← rozpoznawany po global.cfg (pierwsze znaczniki: [name], [friendlyname], [description])
  _vibe/              ← tworzony przez VibeEditor: zadania (tasks.json), prompty (prompts/), assety
```

Folder bez takiego `global.cfg` nie może zostać wybrany jako roboczy. Znaczniki `[name]`, `[friendlyname]`, `[description]` mogą stać w dowolnym miejscu pliku i w dowolnej kolejności — liczy się to, co jest pod nimi. Tak samo w plikach `.map` i `.sco`: czytamy to, co leży pod znacznikami, bez względu na to, czym plik się zaczyna.

## Konfiguracja (pierwsze uruchomienie i Ustawienia)

Po zatwierdzeniu VibeEditor: zapisuje zmiany `name`/`friendlyname`/`description` do `global.cfg` (z zachowaniem kodowania, np. Windows-1250), podpina folder pod repo (`git init`, `origin`), tworzy gałąź `VibeEditor` (albo używa `main`, gdy zaznaczono „Pracuj na main”), commituje całość i pushuje.

Folder roboczy jest **źródłem prawdy**: jeśli zdalna gałąź zawiera pliki, których nie ma lokalnie, nowy commit je usunie (historia zostaje).

## Indeks mapy i assety

Za każdym razem, gdy podłączany jest nowy folder roboczy (zmiana folderu, mapy lub folderu OMSI) — oraz przyciskiem „Przeskanuj mapę ponownie” w zakładce Mapa:

1. z `global.cfg` czytana jest lista kafli (znaczniki `[map]`: koordynaty x, y + plik `.map`),
2. każdy plik `.map` jest skanowany strumieniowo; ze znaczników `[spline]`, `[spline_h]`, `[object]`, `[splineAttachement]`, `[attachObj]` zbierana jest ścieżka stojąca **dwie linijki niżej** (unikatowe, osobno dla kafla i dla całej mapy),
3. wszystkie pliki z tego rejestru są kopiowane z folderu OMSI do `_vibe/assets/` z zachowaniem ścieżek (`<OMSI>/Splines/x.sli` → `_vibe/assets/Splines/x.sli`); same pliki nie są czytane,
4. wynik zapisywany jest w `_vibe/map-index.json` (kafle, ich assety, lista brakujących w OMSI).

`_vibe/assets/` jest wyłączone z repo lokalnie (`.git/info/exclude`) — to kopie plików gry (rozmiar, cudze prawa); `map-index.json` do repo trafia.

Do promptu dla Claude dopisywana jest krótka notka, że dokładne dane o splinach i obiektach są w `_vibe/assets/` (Claude szuka w nich Globem/Grepem zamiast dostawać je w prompcie).

## Zakładki

- **Zadania** — lista zadań (Aktywne / Odrzucone / Archiwum), „+ Dodaj”, „▶️ Uruchom”, „⏹️ Zatrzymaj”.
- **Mapa** — przesuwalna i zoomowalna siatka kafli, start wycentrowany na środku mapy. Klik w kafel pokazuje w prawym górnym rogu koordynaty, plik `.map`, liczbę assetów i brakujące w OMSI. „📍 Dodaj pinezkę”: w tym trybie klik w punkt mapy otwiera nowe zadanie z tą pinezką; pinezki zadań (aktywnych i odrzuconych) są rysowane na mapie, klik w pinezkę pokazuje tytuł zadania.
- **Jezdnie** — lista wszystkich wczytanych splinów (`[spline]`, `[spline_h]`) po ścieżce, z filtrem. Dwuklik tworzy nowe zadanie z podpiętą jezdnią.
- **Obiekty** — drzewo obiektów z plików `.sco`: `[groups]` (liczba, a pod nią nazwy „folderów” od korzenia) i `[friendlyname]` (np. `📂 Aachen › 📂 Gruen › 🏠 Busch`). Dwuklik tworzy nowe zadanie z podpiętym obiektem.
- **Konsola** — output Gita i Claude (filtr: wszystko / tylko Git / tylko Claude).

## Zadania

- Zadanie = tytuł + treść (z rodzaju zadania; rejestr w `src/shared/taskTypes.ts`) + opcjonalnie: **zakres kafli** („Dobierz kafle…” otwiera mapkę do zaznaczania kafli), **pinezka** („Wskaż na mapie…”) oraz **załącznik** — jezdnia albo obiekt wybrany z listy tego, co jest na mapie (nieistniejących assetów nie da się podpiąć).
- **Przed każdym „Uruchom”** aplikacja upewnia się, że folder roboczy jest w aktualnej wersji wypchnięty do repo: commit zmian (jeśli są), push na gałąź z ustawień i sprawdzenie, że zdalna gałąź wskazuje ten sam commit. Przy rozjechaniu historii zgłasza błąd (nic nie nadpisuje).
- „▶️ Uruchom” składa zaznaczone zadania w jeden prompt (`_vibe/prompts/prompt-*.md`). Prompt zawiera: link do repo i gałąź, na którą Claude ma zpushować zmiany, **ponumerowane zadania** (z kafelkami, pinezką i załącznikiem), zasady edycji oraz protokół niewykonalnych zadań.
- **Zasady edycji dla Claude:** wolno mu zmieniać TYLKO folder mapy, `_vibe/inspirations/` (zwięzłe notatki) i `_vibe/failed.ve`. Zakaz ruszania `_vibe/assets/` i zmyślania nieistniejących assetów. W trybie Claude Code dodatkowo przekazywane są reguły `--disallowedTools` blokujące edycję plików aplikacji (`_vibe/assets`, `_vibe/prompts`, `tasks.json`, `map-index.json`, `.git`).
- **Niewykonalne zadania:** Claude wpisuje w `_vibe/failed.ve` linijki `<numer>: <krótki powód>`. Aplikacja wczytuje ten plik (po zakończeniu pracy Claude Code, a w trybie Free okresowo) i przenosi wskazane zadania do kategorii **Odrzucone** z komentarzem. „☑️ Rozwiązane” zwraca zadanie do Aktywnych.
- Po sukcesie pozostałe zadania trafiają do **Archiwum**. „⏹️ Zatrzymaj” przerywa pracę (także w trakcie synchronizacji z repo).
- Po wyczerpaniu limitu (Claude Code) przycisk zmienia się na „⏸️Wznów od HH:MM”; wznowienie kontynuuje tę samą sesję Claude.

## Claude Code vs Claude Free (Ustawienia)

- **Claude Code** — aplikacja uruchamia `claude -p` w folderze roboczym (tryb `acceptEdits`), pokazuje output w konsoli, wykrywa limit i wznawia sesję.
- **Claude Free** — pole na link czatu (`https://claude.ai/chat/ID`). Po „Uruchom” prompt trafia do schowka, aplikacja odpala `claude://claude.ai/chat/ID` (PowerShell `Start-Process`), po ok. 1,5 s wciska Ctrl+V, a Ty zatwierdzasz Enterem — albo robi to sama, gdy zaznaczysz „Po wklejeniu sam naciśnij Enter”. Tylko Windows. Aplikacja nie widzi, kiedy Claude skończy, więc zadania trafiają do Archiwum od razu po wklejeniu.

Pinezka jest zapisana w jednostkach kafli (środek kafla (x, y) to dokładnie (x, y), oś Y rośnie na północ); w prompcie przeliczana jest na przesunięcie od środka kafla w metrach przy założeniu kafla 300×300 m.

## Do zrobienia

- Kolejne rodzaje zadań.
