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

## Zakładka „Mapa i trasy” — tryby

Pasek u góry przełącza trzy tryby, każdy z własnym paskiem narzędzi (warstwy, „Wycentruj” i „Przeskanuj mapę” są wspólne). Zaznaczanie kafli i panel ze szczegółami kafla działają tylko w trybie „Przegląd”. Na warstwie „Ścieżki” (od ok. 220 px na kafel) są **strzałki kierunku ruchu**: kierunek 1 w `.sli` oraz odbicie splinu (`mirror`) odwracają kierunek, oba naraz się znoszą; trasy kursów i podgląd łączenia też mają strzałki:

- **🗺️ Przegląd** — warstwy, edycja parametrów przystanków (klik w przystanek), pinezki do zadań.
- **🚌 Trasy kursów** — trasa z `.ttr` z przystankami, edycja trasy i przystanków (opis niżej).
- **🔗 Łączenia ścieżek** — tworzenie łączeń między węzłami ścieżek (opis niżej).
- **✏️ Edycja splinów** — zaznaczanie początków i końców splinów, przesuwanie, wysokość, nowe spliny (opis niżej).

## Łączenia ścieżek

Węzeł to koniec splinu z ścieżką dla pojazdów (typ 0 lub 2 w `.sli`). Najechanie kursorem podświetla węzeł, klik wybiera koniec A, drugi klik koniec B; panel po prawej pokazuje o każdym: ID splinu, koniec/początek, numer ścieżki, **wysokość** (oś + wysokość ścieżki), nachylenie od podłoża, skew, azymut, przesunięcie od osi, kierunek ruchu i przyłączenie. Można łączyć **dowolne końce** (koniec z początkiem, koniec z końcem, początek z początkiem): łączenie wychodzi z końca splinu naprzód, a z początku „do tyłu” (azymut + 180°, nachylenie i skew z odwróconym znakiem), a prev/next ustawiane jest tylko wtedy, gdy koniec splinu jest zgodny z kierunkiem łączenia (koniec → początek) i wolny. Pole **„Łącz tylko węzły”** (domyślnie włączone) można wyłączyć: wtedy klik wskazuje **dowolny punkt mapy** (wysokość ścieżki, nachylenie i skew punktu wpisuje się w panelu; domyślnie z węzła po drugiej stronie), a klawisz **Ctrl** przy kliknięciu nadal przyciąga do najbliższego węzła. Łączenie z dowolnym punktem to jeden łuk styczny do węzła (co najmniej jeden koniec musi być węzłem). Podgląd (przerywana linia) i „✔ Utwórz łączenie” używają `invis_street.sli` — musi leżeć luzem w `_vibe/assets/Splines` (w OMSI jest zawsze luzem w `Splines`).

Geometria: gdy jeden łuk nie wystarcza, powstają dwa spliny (biarc: dwa łuki styczne do siebie i do obu spliny źródłowych). Wysokość zmienia się płynnie jedną sześcienną krzywą Hermite’a na całej długości (nachylenia na końcach = nachylenia przyłączanych splinów, na styku łuków ciągłe), skew rośnie liniowo od wartości węzła A do węzła B. Wpisy to `[spline_h]` dopisywane do kafla za ostatnim splinem (numery elementów na kaflu istniejących wpisów `.ttr` się nie zmieniają), a wolne końce przyłączanych splinów dostają `prev`/`next` nowych (kopia `.map.bak`). „Odwróć kierunek ścieżki” odbija nowe spliny (`mirror`), co odwraca kierunek ruchu; domyślnie ustawia się je według kierunku ruchu na przyłączonych ścieżkach.

Parametry pionowe `[spline_h]` (linijki 11–18 wpisu) ustalone z kafla Warszawa 2008: nachylenie na początku (°), nachylenie na końcu (°), różnica wysokości (m), skew na początku i na końcu, dwa parametry profilu bocznego i przesunięcie tekstury; zwykły `[spline]` jest płaski. Kierunek ruchu na ścieżce: kierunek 1 w `.sli` oraz odbicie splinu (`mirror`) odwracają go, a oba naraz się znoszą.

## Skew, tekstury i zbliżenie mapy

- **Skew** to ostatnie pola wpisu splinu (w `[spline_h]` pola 5 i 6 ogona, w `[spline]` pola 4 i 5) i wynosi `tan(Δ/2)`, gdzie Δ to zmiana azymutu na styku sąsiednich splinów: skew końca A = −tan(Δ/2), skew początku B = +tan(Δ/2) (ustalone na kaflu Warszawa 2008, także dla splinów odbitych; bez sąsiada = 0). Wyznacza ścięcie końca: punkt krawędzi w bocznej odległości `u` od osi (w prawo +) leży o `skew·u` dalej wzdłuż osi, na obu końcach do przodu — sąsiednie spliny zbiegające się pod kątem łączą się „na ukos” (miter), bez szczelin i nakładek. Mapa rysuje spliny jako wypełnione pasy z takimi ściętymi końcami (nowe pola w indeksie splinów wymagają jednorazowego „Przeskanuj mapę ponownie”; po edycjach indeks odświeża się sam).
- Po **przesunięciu lub obrocie** splinu (G, także przy wyłączonym łuku), po **wyrównaniu** i po **usunięciu** skew splinu i jego poprzednika/następnika ustawia się sam z nowego załamka azymutu (po usunięciu sąsiadowi wraca 0). Łączenia (invis_street) dopasowują skew do przyłączanych splinów (skew końca A = −skew początku B), a między własnymi łukami mają 0. „Wyrównaj” w kontroli spójności ustawia skew z geometrii, a kontrola zgłasza skew niezgodny z załamkiem azymutu.
- **Tekstury splinów** (warstwa „Tekstury”): z pliku `.sli` (kopia w `_vibe/assets`) czytane są `[texture]` (nazwa pliku), profile `[profile]` z indeksem tekstury i punkty `[profilepnt]` (x, wysokość, U, opcjonalnie skala V). Pas powstaje między kolejnymi punktami profilu; U biegnie w poprzek pasa, a V wzdłuż splinu z przesunięciem tekstury z wpisu (ciągłe między sąsiednimi splinami); skala V to czwarta liczba pierwszego punktu profilu (np. 0,167 = powtórzenie co 6 m, brak = 0,1). Pliki tekstur są szukane w folderze OMSI: podfolder `texture` obok `.sli`, folder `.sli`, `Texture`, `Maps/<mapa>/Texture` (wielkość liter bez znaczenia, a gdy nie ma pliku o danym rozszerzeniu — także `.dds`, `.tga`, `.bmp`, `.png`, `.jpg`); obsługiwane formaty: BMP, TGA, DDS (DXT1/3/5 i nieskompresowane), PNG, JPG. Obrazy są zmniejszane do ≤ 256 px, a rysowanie jest stopniowane: od ok. 1,5 px/m spliny dostają kolor średni tekstury najszerszego pasa, od ok. 3 px/m — prawdziwy wzór (dopasowany do kolejnych kawałków łuku, z mipmapami; limit 4000 kawałków na klatkę, resztę widać w kolorze średnim). Założenia nieweryfikowane w grze: znaczenie indeksu po `[profile]` (indeks tekstury) i czwartej liczby punktu (skala V).
- **Zbliżenie** mapy sięga 160 px na metr (wcześniej 20); spliny poza ekranem są pomijane.

## Edycja splinów

Na mapie widać uchwyty początków (niebieskie) i końców (pomarańczowe) splinów. **Klik** zaznacza koniec splinu razem z końcami innych splinów leżącymi w tym samym miejscu (węzeł), **Shift+klik** dodaje lub odznacza; zaznaczonych może być wiele. Klawisze (kursor musi być nad mapą), Blender-owo:

- **G** — przesuwanie zaznaczonych końców myszą; klik / Enter zatwierdza, Esc lub prawy przycisk anuluje. Gdy zaznaczone są oba końce splinu, spline przesuwa się sztywno; gdy jeden, drugi koniec zostaje (pozycja i azymut), a spline staje się łukiem przez nowy punkt (zmienia się azymut, długość i promień po przesuwanym końcu). Początek splinu nie może wyjść poza kafel, w którym jest zapisany.
- **Z** — przesunięcie wysokości: ruch myszą w górę/dół (Shift — dokładniej, Ctrl — szybciej) albo wpisanie liczby (cyfry, `-`, `.`, Backspace); Enter lub klik zatwierdza. Zmiana jednego końca zmienia `z` i różnicę wysokości (drugi koniec zostaje na swojej wysokości); zwykły `[spline]` staje się wtedy `[spline_h]` (zachowując parametry profilu i przesunięcie tekstury).
- **B** — zaznaczanie prostokątem: dwa kliknięcia w przeciwległe rogi (Shift — dodaj do zaznaczenia); zaznaczane są wszystkie początki i końce splinów w prostokącie.
- **X / Y podczas G** — blokada osi (tylko X albo tylko Y; ponowne naciśnięcie odblokowuje); **Ctrl podczas G** — przyciąganie pierwszego zaznaczonego punktu do najbliższego końca innego splinu (czerwony okrąg pokazuje cel).
- **Ctrl+Z / Ctrl+Y** (także Ctrl+Shift+Z) — cofa i ponawia ostatnią zmianę kafli: przesunięcia, wysokości, nowe spliny, usunięcia, wyrównania i łączenia ścieżek (przyciski ↶/↷ w panelach pokazują nazwę operacji). Dziennik jest w pamięci (ostatnie 25 operacji), przywraca kafle bajt w bajt i odmawia, jeśli plik zmieniono poza aplikacją. Zmiany parametrów przystanków i tras kursów nie są w nim ujęte.
- **Delete** — usuwa spliny, do których należą zaznaczone punkty (cały węzeł = wszystkie spliny przy nim), razem z ich blokami `[rule]`, po potwierdzeniu. Odnośniki `prev`/`next` innych splinów do usuniętych (także w sąsiednich kaflach) są zerowane. Uwaga: numery elementów na kaflu późniejszych splinów z pojazdami się przesuwają, więc wpisy `.ttr` tras, które po nich następują, trzeba sprawdzić.
- **Alt** — przełącza **łuk / prostą**. Przy włączonym łuku (domyślnie) przesuwany koniec zagina spline (G) albo nowy spline jest łukiem stycznym do początku (N); przy prostej spline pozostaje prostą i **obraca się** wokół nieruszonego końca (zmienia się też długość). Stan widać w panelu (przycisk „Łuk (Alt)” / „Prosta (Alt)”).
- **N** — nowy spline: od zaznaczonego końca (naprzód od końca splinu, a od początku „do tyłu”; łuk styczny, stałe nachylenie, przyłączenie prev/next tylko od wolnego końca) albo, gdy nic nie zaznaczono, od miejsca kursora (prosta, wysokość z pola „Z początku”); drugi punkt wskazuje się myszą i zatwierdza klikiem. Plik `.sli` nowego splinu wybiera się z listy rozwijanej w panelu (pliki znane z mapy plus `invis_street.sli`); po zaznaczeniu punktu lista sama ustawia się na plik jego splinu. Po utworzeniu zaznaczany jest jego koniec, więc można od razu ciągnąć dalej klawiszem N.

**Kontrola spójności** (przycisk „🔍 Sprawdź mapę” w panelu): dla każdego połączenia koniec → początek porównuje przerwę (≥ 2 cm), załamek azymutu (≥ 0,1°), skok wysokości (≥ 2 mm), załamek nachylenia i różnicę skew (≥ 0,05) oraz symetrię odnośników prev/next i istnienie splinu docelowego; lista jest posortowana od najpoważniejszych. „Idź” przechodzi do miejsca połączenia i zaznacza węzeł, „Wyrównaj” (dla wysokości, nachylenia i skew) ustawia styk jako średnie z obu stron — drugie końce splinów zostają na swoich wysokościach, a płaski `[spline]` w razie potrzeby staje się `[spline_h]`. Przerw i załamków azymutu nie naprawia się automatycznie (G przesuwa końce).

Panel pokazuje dla zaznaczonych splinów wysokość początkową i końcową (Z), różnicę, długość, promień i azymut, a na mapie przy końcach splinów są etykiety Z (z podglądem na żywo podczas G i Z). Zapisy trafiają do kafli (kopie `.map.bak`), a indeks splinów odświeża się od razu, bez przeskanowania mapy.

## Trasa kursu (.ttr)

Plik `.ttr` to lista wpisów `[track_entry]`: ID splinu lub obiektu · numer ścieżki ruchu w jego `.sli`/`.sco` · indeks kafla (kolejność `[map]` w `global.cfg`) · numer elementu na kaflu · długość · flaga. VibeEditor czyta potrzebne kafle `.map` na żądanie (bez ponownego skanowania mapy), znajduje spline/obiekt po ID, liczy przebieg wskazanej ścieżki (z kopii `.sli`/`.sco` w `_vibe/assets`) i rysuje go na mapie. Przystanki kursu bierze z `[station]` w `.ttp` (ID obiektu przystanku), a gdy go nie ma w `map-stops.json` — dopasowuje po nazwie. 4. linijka wpisu to pozycja splinu wśród splinów kafla mających ścieżkę dla pojazdów (typ 0 lub 2 w `.sli`; potwierdzone na kaflu Warszawa 2008; dla obiektów to analogiczne założenie, a pasek informacji zlicza rozbieżności osobno dla splinów i obiektów). Założenia nie potwierdzone w grze:, 6. to flaga (zawsze 0 w próbce), oraz to, że rysowany jest cały odcinek ścieżki, a nie tylko `długość` z `.ttr`.

## Zakładki (w kolejności)

- **Zadania** — lista zadań (Aktywne / Odrzucone / Archiwum), „+ Dodaj”, „▶️ Uruchom”, „⏹️ Zatrzymaj”.
- **Mapa i trasy** — przesuwalna i zoomowalna siatka kafli, start wycentrowany na środku mapy. Klik w kafel pokazuje w prawym górnym rogu koordynaty, plik `.map`, liczbę assetów i brakujące w OMSI. „📍 Dodaj pinezkę”: w tym trybie klik w punkt mapy otwiera nowe zadanie z tą pinezką; pinezki zadań (aktywnych i odrzuconych) są rysowane na mapie, klik w pinezkę pokazuje tytuł zadania.
  Przybliżenie do ok. 20 px na metr. Pasek „Trasa kursu” rysuje trasę z pliku `.ttr` o tej samej nazwie co `.ttp` (szukany najpierw w tym samym folderze, potem w całym folderze mapy; wielkość liter i `-`/`_` nie mają znaczenia) wraz z przystankami kursu; to samo robi przycisk „🗺️ Pokaż trasę na mapie” w zakładce Rozkłady (przy kursie z plikiem `.ttr`).
  **Edycja trasy:** wybierz kurs w pasku „Trasa kursu” i kliknij „✏️ Edytuj trasę” (kurs bez `.ttr` też — plik powstanie przy zapisie). Klik w ścieżkę ruchu (jezdnię albo ścieżkę obiektu, np. skrzyżowania) dodaje ją jako odcinek po zaznaczonym (albo na końcu); klik w odcinek trasy zaznacza go; panel po prawej ma listę odcinków z ▲/▼ (kolejność), 🗑️ (usuń), ↶/↷ (cofnij/ponów) i „💾 Zapisz .ttr”. Skróty: Delete, Ctrl+Z, Ctrl+Y, Ctrl+S, Esc. Pierwszy zapis robi kopię `.ttr.bak`.
  **Podświetlanie:** po włączeniu edycji warstwy Spliny, Ścieżki i Przystanki włączają się same. Kursor nad ścieżką ruchu podświetla ją na fioletowo; gdy ścieżka jest połączona (początek w ≤ 2,5 m od końca poprzedniej, kierunek ±50°) z zaznaczonym odcinkiem (albo z ostatnim, gdy nic nie zaznaczono), podświetla cały najkrótszy łańcuch ścieżek między nimi włącznie, a klik dodaje je wszystkie po kolei. Ścieżki splinów z kierunkiem 1 w `.sli` są liczone od końca splinu do początku.
  **Przystanki:** druga lista w panelu („Przystanki”) pokazuje przystanki kursu z przypisanymi odcinkami; „➕ Dodaj przystanek” + klik przystanku na mapie przypisuje go do zaznaczonego odcinka (a bez zaznaczenia — do najbliższego) i przy zapisie dopisuje blok `[station]` do `.ttp` (kopia `.ttp.bak`, numery przystanków w profilach przesuwane). Pola `[station]` (ustalone na kursie 211-TP-DWI): ID obiektu · numer wpisu `.ttr` · nazwa · indeks kafla · boczne przesunięcie od toru (m, przypuszczalnie w prawo +) · `route` · `along` · ostatnia liczba (postój/typ — nieustalone, nowy przystanek kopiuje wartość poprzedniego). Zależność potwierdzona na danych: `route − along` = suma długości wpisów trasy przed wpisem (entry − 1). Edytor sprawdza ją na wczytanym kursie (pasek informacji i dół listy: „zgodne N/N”, plus osobno odległość wzdłuż i przesunięcie boczne z geometrii) i wyłącza dodawanie przystanków, gdy się nie potwierdza. Plik `.ttr` kursu jest wskazywany nazwą z pierwszej linijki po `[trip]` w `.ttp` (nazwy plików `.ttp` i `.ttr` mogą się różnić). Zmiana kolejności lub usunięcie odcinków przepisuje wpis i sumy istniejących przystanków; usunięcie odcinka z przystankiem jest blokowane przy zapisie. Nowy wpis dostaje: ID splinu/obiektu, numer klikniętej ścieżki, indeks kafla, pozycję elementu w pliku kafla (to ostatnie to przypuszczenie — pasek informacji ostrzega, gdy w istniejących wpisach się nie zgadza), długość ścieżki i flagę 0.
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

## Ikona

Ikona programu (`assets/icon.png`, `assets/icon.ico`) to ta sama grafika co w pasku tytułu: zielony zaokrąglony kwadrat z białą ramką i literą V. Jest ikoną okna, instalatora i pliku wykonywalnego, a pasek tytułu pokazuje ten sam plik.
