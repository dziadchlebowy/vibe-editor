export type ConsoleSource = 'git' | 'claude' | 'app';

export interface ConsoleLine {
  ts: number;
  source: ConsoleSource;
  text: string;
}

/** Sposób wykonywania promptu: Claude Code (proces `claude`) albo Claude Free (czat w aplikacji Claude). */
export type ClaudeMode = 'code' | 'free';

export interface Settings {
  omsiDir: string;
  workDir: string;
  /** Nazwa podfolderu mapy wewnątrz folderu roboczego. */
  mapFolder: string;
  remoteUrl: string;
  workOnMain: boolean;
  /** „code” = Claude Code (CLI), „free” = czat w aplikacji Claude (schowek + Ctrl+V). */
  claudeMode: ClaudeMode;
  /** Opcjonalna ścieżka do claude(.exe); puste = z PATH. */
  claudePath: string;
  /** Claude Free: link do czatu (https://claude.ai/chat/ID), do którego trafia prompt. */
  claudeChatUrl: string;
  /** Claude Free: czy po wklejeniu prompta automatycznie go wysłać (Enter). */
  claudeAutoSend: boolean;
  /** Mapa: nie rysuj splinów szerszych niż tyle metrów (0 = bez limitu). */
  splineMaxWidth: number;
  configured: boolean;
}


export interface MapInfo {
  folder: string;
  name: string;
  friendlyname: string;
  description: string;
}

export interface InspectResult {
  ok: boolean;
  error?: string;
  maps: MapInfo[];
}

export interface SaveRequest {
  omsiDir: string;
  workDir: string;
  mapFolder: string;
  name: string;
  friendlyname: string;
  description: string;
  remoteUrl: string;
  workOnMain: boolean;
  claudeMode: ClaudeMode;
  claudePath: string;
  claudeChatUrl: string;
  claudeAutoSend: boolean;
  splineMaxWidth: number;
}

export interface OkResult {
  ok: boolean;
  error?: string;
}

export interface TileCoord {
  x: number;
  y: number;
}

/** Zakres kafli zadania: konkretnie zaznaczone kafle (null = nie ograniczono). */
export type TileRange = TileCoord[] | null;

/** Pinezka zadania: punkt na mapie we współrzędnych kafli (środek kafla (x, y) to dokładnie (x, y); y rośnie na północ). */
export interface TaskPin {
  x: number;
  y: number;
}

/** Jezdnia (spline) albo obiekt załączony do zadania. */
export interface TaskAttachment {
  kind: 'road' | 'object';
  /** Ścieżka assetu względem folderu OMSI, separator „/”. */
  path: string;
  /** Nazwa wyświetlana (np. [friendlyname] obiektu). */
  name?: string;
}

export interface Task {
  id: string;
  title: string;
  /** Rodzaj zadania (klucz z rejestru TASK_TYPES). */
  kind: string;
  /** Dane specyficzne dla rodzaju; z nich algorytm generuje treść. */
  data: Record<string, string>;
  tileRange: TileRange;
  pin: TaskPin | null;
  attachment: TaskAttachment | null;
  checked: boolean;
  /** active = do zrobienia, archived = wykonane, rejected = Claude nie dał rady (komentarz w rejectedComment). */
  status: 'active' | 'archived' | 'rejected';
  createdAt: number;
  archivedAt?: number;
  /** Krótkie uzasadnienie od Claude (z _vibe/failed.ve) — tylko dla status === 'rejected'. */
  rejectedComment?: string;
  rejectedAt?: number;
}

/** Zadanie razem z treścią wygenerowaną algorytmicznie z danych. */
export interface TaskView extends Task {
  content: string;
}

export interface TaskInput {
  title: string;
  kind: string;
  data: Record<string, string>;
  tileRange?: TileRange;
  pin?: TaskPin | null;
  attachment?: TaskAttachment | null;
}

export interface RunState {
  status: 'idle' | 'running' | 'paused';
  /** Kiedy odnowi się limit (ms epoch) — tylko dla status === 'paused'. */
  resetAt?: number;
  error?: string;
  taskIds: string[];
}

export interface MapTileView {
  x: number;
  y: number;
  /** Plik .map kafla, względem folderu mapy. */
  file: string;
  exists: boolean;
  /** Liczba unikatowych ścieżek assetów użytych na kaflu. */
  assetCount: number;
  /** Ile z nich nie istnieje w folderze OMSI. */
  missingCount: number;
}

export interface MapOverview {
  mapFolder: string;
  tiles: MapTileView[];
  /** Liczba unikatowych assetów na całej mapie. */
  assetCount: number;
  missingCount: number;
  indexedAt: number;
}

/** Przystanki (obiekty .sco ze znacznikiem [busstop]) z kafli, do pokazania na mapie. */
export interface MapStops {
  version: 1;
  tiles: {
    x: number;
    y: number;
    /** Plik .map kafla względem folderu mapy. */
    file: string;
    s: { id: string; x: number; y: number; rot: number; /** 7 linijek parametrów (patrz shared/busStop.ts) */ p: string[] }[];
  }[];
}

/** Ścieżki ruchu z obiektów (.sco): definicje wspólne dla obiektów tego samego pliku + ich rozmieszczenie na kaflach. */
export interface MapObjPaths {
  version: 1;
  /** t: krotki [x, y, azymut °, promień m, długość m] w układzie obiektu. */
  defs: { p: string; t: number[][] }[];
  /** o: krotki [indeks definicji, x, y, obrót °] — pozycja obiektu na kaflu (m od rogu kafla). */
  tiles: { x: number; y: number; o: number[][] }[];
}

/** Jezdnia = spline użyty na mapie. */
export interface RoadView {
  path: string;
  /** Na ilu kaflach występuje. */
  tileCount: number;
  /** Brak pliku w folderze OMSI. */
  missing: boolean;
}

/** Obiekt użyty na mapie, z drzewem „folderów” z jego pliku .sco ([groups]). */
export interface ObjectView {
  path: string;
  /** [friendlyname] albo nazwa pliku. */
  name: string;
  groups: string[];
  tileCount: number;
  missing: boolean;
  /** Czy plik .sco udało się odczytać (inaczej obiekt leży w korzeniu drzewa). */
  known: boolean;
}

export interface MapCatalog {
  roads: RoadView[];
  objects: ObjectView[];
}

/**
 * Spliny z kafli do narysowania na mapie. Każdy spline to krotka
 * [indeks drogi, x lokalny (m), y lokalny (m), azymut (° od północy), długość (m), promień (m, 0 = prosta), odbicie 0/1, wysokość początku (m)].
 * Spliny z wyższą wysokością są rysowane później (na wierzchu).
 */
export interface MapSplines {
  version: 1;
  /** Drogi: ścieżka .sli i zakres X przekroju (min, max) w metrach. */
  roads: { p: string; a: number; b: number; /** ścieżki ruchu: [x, typ, kierunek] */ t?: number[][] }[];
  tiles: { x: number; y: number; s: number[][] }[];
}

// --- linie i rozkłady (TTData: .ttl linie, .ttp kursy) ----------------------------

/** Kurs dodany do brygady linii ([addtrip]); czas startu w minutach od północy. */
export interface LineTrip {
  /** Nazwa pliku kursu (.ttp) bez rozszerzenia. */
  trip: string;
  /** Druga linijka wpisu (w próbkach zawsze 0) — zachowywana bez zmian. */
  flag: string;
  start: number;
  /** Dodatkowe linijki wpisu, zachowywane bez zmian. */
  extra: string[];
}

/** Brygada ([newtour]). */
export interface LineTour {
  number: string;
  /** Linijki nagłówka po numerze: pierwsza to typ pojazdu (np. „PKS 12m”), reszta zachowywana. */
  header: string[];
  trips: LineTrip[];
}

export interface LineFile {
  /** Ścieżka względem folderu mapy, separator „/”. */
  file: string;
  /** Nazwa bez rozszerzenia. */
  name: string;
  /**
   * Czy linię może prowadzić gracz: w pliku to znacznik [userallowed] (u Ciebie obecny, bez wartości).
   * „Tylko dla AI” = brak tego znacznika. To wniosek z nazwy znacznika — nie znalazłem jego opisu.
   */
  userAllowed: boolean;
  tours: LineTour[];
}

export interface TripStation {
  id: string;
  index: number;
  name: string;
  /** Indeks kafla ([map] w global.cfg) z obiektem przystanku — 4. linijka po [station]; -1, gdy nieznany. */
  tile: number;
  /**
   * Numer wpisu [track_entry] z pliku .ttr, do którego przystanek jest przypisany (2. linijka po [station]).
   * Hipoteza (sprawdzana na danych — patrz TripRoute.stationCheck): pos = położenie przystanku na ścieżce tego wpisu (m),
   * cum = suma długości wpisów trasy do końca tego wpisu włącznie, len = długość tego wpisu, wait = ostatnia linijka.
   */
  entry: number;
  pos: number;
  cum: number;
  len: number;
  wait: number;
}

/** Profil czasowy kursu; czasy w minutach od startu kursu, klucz = numer przystanku (od 0). */
export interface TripProfile {
  name: string;
  total: number;
  arr: Record<number, number>;
  dep: Record<number, number>;
  /** [profile_otherstopping]: liczba całkowita (np. 1, 3, 4). */
  stop: Record<number, number>;
}

export interface TripFile {
  file: string;
  name: string;
  /** [trip]: nazwa wewnętrzna, tytuł (cel), numer linii. */
  internalName: string;
  title: string;
  line: string;
  stations: TripStation[];
  profiles: TripProfile[];
  /** Plik .ttr z trasą kursu (względem folderu mapy), jeśli go znaleziono; tylko do odczytu, nie jest zapisywany. */
  trackFile?: string;
}

export interface TimetableData {
  lines: LineFile[];
  trips: TripFile[];
}

/** Jeden wpis [track_entry] z pliku .ttr wraz z przebiegiem do narysowania. */
export interface RouteSegment {
  /** ID splinu albo obiektu. */
  id: string;
  /** Numer ścieżki ruchu ([path]) w pliku .sli albo .sco, od 0. */
  pathIndex: number;
  /** Indeks kafla w kolejności [map] z global.cfg. */
  tile: number;
  /** Numer elementu na kaflu (4. linijka wpisu). */
  index: number;
  /** Długość ścieżki w metrach. */
  length: number;
  /** Ostatnia linijka wpisu (w próbce zawsze 0). */
  flag: number;
  /** Przebieg: płaska tablica [x0, y0, x1, y1, …] w jednostkach kafli; pusta, gdy nie udało się go ułożyć. */
  line: number[];
}

export interface RouteStation {
  /** Numer przystanku w kursie od 1 i jego ID (obiekt przystanku). */
  n: number;
  id: string;
  name: string;
  /** Numer wpisu trasy, do którego przystanek jest przypisany (od 0), i położenie na jego ścieżce (m). */
  entry: number;
  pos: number;
  cum: number;
  len: number;
  /** cum i len z pliku zgadzają się z długościami odcinków trasy. */
  ok: boolean;
  /** Położenie obiektu przystanku na ścieżce odcinka zgadza się z pos (tolerancja 3 m); null, gdy przystanku nie ma na mapie. */
  posOk: boolean | null;
  x?: number;
  y?: number;
}

/** Zmiany przystanków kursu zapisywane razem z trasą (do .ttp). */
export interface StationEdits {
  /** Istniejące przystanki (numer w kursie od 0) z nowym numerem wpisu trasy — długości liczy zapis z odcinków. */
  remap: { index: number; entry: number }[];
  /** Nowe przystanki: obiekt przystanku (ID + plik kafla), numer wpisu trasy i położenie na jego ścieżce (m). */
  add: { stopId: string; tileFile: string; name: string; entry: number; pos: number }[];
}

/**
 * Trasa kursu z pliku .ttr, gotowa do narysowania. Współrzędne w jednostkach kafli
 * (środek kafla (x, y) to dokładnie (x, y), oś Y rośnie na północ) — jak pinezki.
 */
export interface TripRoute {
  trip: string;
  /** Plik kursu (.ttp) względem folderu mapy. */
  tripFile: string;
  /** Odcinki w kolejności jazdy — po jednym na wpis [track_entry]. */
  segments: RouteSegment[];
  /** Przystanki kursu znalezione na mapie; n = numer przystanku w kursie (od 1). */
  stops: { n: number; name: string; x: number; y: number; /** dodany w edytorze, jeszcze niezapisany */ pending?: boolean }[];
  /** Wszystkie przystanki kursu z .ttp (także te, których nie ma na mapie) wraz z przypisaniem do odcinków. */
  stations: RouteStation[];
  /** Sprawdzian hipotezy o znaczeniu pól [station]: ile przystanków ma spójne przypisanie do odcinków (cum/len) i położenie (pos). */
  stationCheck: { total: number; ok: number; posOk: number };
  /** Wpisy, których nie udało się ułożyć na mapie (zostają w pliku). */
  unresolved: number;
  /** Wpisy, w których „numer elementu na kaflu” różni się od pozycji elementu w pliku kafla. */
  indexMismatch: number;
  /** Przystanki kursu, których nie znaleziono na mapie. */
  missingStops: string[];
  /** Kurs nie ma jeszcze pliku .ttr (zostanie utworzony przy zapisie). */
  noFile?: boolean;
  error?: string;
}
