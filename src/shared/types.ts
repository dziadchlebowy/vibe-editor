export type ConsoleSource = 'git' | 'claude' | 'app';

export interface ConsoleLine {
  ts: number;
  source: ConsoleSource;
  text: string;
}

export interface Settings {
  omsiDir: string;
  workDir: string;
  /** Nazwa podfolderu mapy wewnątrz folderu roboczego. */
  mapFolder: string;
  remoteUrl: string;
  workOnMain: boolean;
  /** Opcjonalna ścieżka do claude(.exe); puste = z PATH. */
  claudePath: string;
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
  claudePath: string;
}

export interface OkResult {
  ok: boolean;
  error?: string;
}

/** Zakres kafli — placeholder, zostanie zaimplementowany razem z zakładką Mapa. */
export type TileRange = null;

export interface Task {
  id: string;
  title: string;
  /** Rodzaj zadania (klucz z rejestru TASK_TYPES). */
  kind: string;
  /** Dane specyficzne dla rodzaju; z nich algorytm generuje treść. */
  data: Record<string, string>;
  tileRange: TileRange;
  checked: boolean;
  status: 'active' | 'archived';
  createdAt: number;
  archivedAt?: number;
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
