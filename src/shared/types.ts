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
