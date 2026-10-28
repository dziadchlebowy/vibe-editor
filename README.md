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

## Zadania

- Zadanie = tytuł + treść + (w przyszłości) zakres kafli. Rodzaje zadań są polimorficzne — rejestr w `src/shared/taskTypes.ts`; treść jest generowana algorytmicznie z danych formularza (dla „zwykłego tekstowego” to po prostu wpisany tekst).
- „▶️ Uruchom” składa zaznaczone zadania w jeden plik (`_vibe/prompts/prompt-*.md`) i wysyła do Claude Code (`claude -p`, tryb `acceptEdits`).
- Po sukcesie zadania trafiają do **Archiwum**. „⏹️ Zatrzymaj” przerywa pracę.
- Po wyczerpaniu limitu przycisk zmienia się na „⏸️Wznów od HH:MM”; wznowienie kontynuuje tę samą sesję Claude.

## Do zrobienia

- Zakładka **Mapa** i zakres kafli (placeholdery są w UI i modelu).
- Kolejne rodzaje zadań.
