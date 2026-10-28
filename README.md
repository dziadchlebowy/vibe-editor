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

Folder bez takiego `global.cfg` nie może zostać wybrany jako roboczy.

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

## Zakładka Mapa

Przesuwalna i zoomowalna siatka kafli (przeciąganie, kółko myszy względem kursora), start wycentrowany na środku mapy. Klik w kafel pokazuje w prawym górnym rogu: koordynaty, plik `.map`, czy plik istnieje, liczbę unikatowych assetów i ile z nich brakuje w OMSI.

## Zadania

- Zadanie = tytuł + treść + (w przyszłości) zakres kafli. Rodzaje zadań są polimorficzne — rejestr w `src/shared/taskTypes.ts`; treść jest generowana algorytmicznie z danych formularza (dla „zwykłego tekstowego” to po prostu wpisany tekst).
- „▶️ Uruchom” składa zaznaczone zadania w jeden plik (`_vibe/prompts/prompt-*.md`) i wysyła do Claude Code (`claude -p`, tryb `acceptEdits`).
- Po sukcesie zadania trafiają do **Archiwum**. „⏹️ Zatrzymaj” przerywa pracę.
- Po wyczerpaniu limitu przycisk zmienia się na „⏸️Wznów od HH:MM”; wznowienie kontynuuje tę samą sesję Claude.

## Do zrobienia

- Zakres kafli w zadaniach (placeholder jest w UI i modelu; siatka mapy już istnieje).
- Kolejne rodzaje zadań.
