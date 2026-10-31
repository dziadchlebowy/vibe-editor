import type {
  ConsoleLine,
  LineFile,
  InspectResult,
  MapCatalog,
  MapOverview,
  MapSplines,
  MapObjPaths,
  MapStops,
  OkResult,
  RunState,
  SaveRequest,
  Settings,
  TaskInput,
  TaskView,
  TimetableData,
  TripFile,
  RouteSegment,
  StationEdits,
  TripRoute,
} from './types.ts';

/** API wystawiane rendererowi przez preload jako window.ve. */
export interface VeApi {
  getSettings(): Promise<Settings>;
  pickFolder(title: string): Promise<string | null>;
  inspectWorkDir(dir: string): Promise<InspectResult>;
  saveSettings(req: SaveRequest): Promise<OkResult>;

  checkClaude(claudePath: string): Promise<OkResult & { version?: string }>;
  openClaudeLogin(claudePath: string): Promise<void>;

  listTasks(): Promise<TaskView[]>;
  addTask(input: TaskInput): Promise<OkResult>;
  updateTask(id: string, input: TaskInput): Promise<OkResult>;
  deleteTask(id: string): Promise<void>;
  /** „☑️ Rozwiązane”: odrzucone zadanie wraca do aktywnych. */
  resolveTask(id: string): Promise<void>;
  setTaskChecked(id: string, checked: boolean): Promise<void>;

  startRun(taskIds: string[]): Promise<OkResult>;
  stopRun(): Promise<void>;
  resumeRun(): Promise<OkResult>;
  getRunState(): Promise<RunState>;

  getMapOverview(): Promise<MapOverview | null>;
  reindexMap(): Promise<OkResult>;
  isMapIndexing(): Promise<boolean>;
  getCatalog(): Promise<MapCatalog>;
  getMapSplines(): Promise<MapSplines | null>;
  getMapStops(): Promise<MapStops | null>;
  getMapObjPaths(): Promise<MapObjPaths | null>;
  /** Zapisuje 7 linijek parametrów przystanku (obiekt o danym ID) w pliku kafla. */
  saveStop(tileFile: string, id: string, params: string[]): Promise<OkResult>;

  getConsoleHistory(): Promise<ConsoleLine[]>;

  /** Linie (.ttl) i kursy (.ttp) z folderu mapy. */
  loadTimetable(): Promise<TimetableData>;
  saveLine(line: LineFile): Promise<OkResult>;
  saveTrip(trip: TripFile): Promise<OkResult>;
  /** Trasa kursu z pliku .ttr leżącego obok .ttp (plik kursu względem folderu mapy). */
  getTripRoute(tripFile: string): Promise<TripRoute>;
  /**
   * Ścieżka ruchu (spline lub obiekt) pod punktem (jednostki kafli, maks. maxDistM metrów) oraz — gdy podano fromLine
   * (przebieg odcinka, od którego jedziemy) — najkrótszy łańcuch połączonych ścieżek od jego końca do tej ścieżki włącznie.
   */
  hoverTrack(x: number, y: number, maxDistM: number, fromLine: number[] | null): Promise<{ target: RouteSegment | null; chain: RouteSegment[] }>;
  /** Zapisuje trasę kursu do pliku .ttr (tworzy go, jeśli go nie ma; pierwszy zapis robi kopię .ttr.bak) i zmiany przystanków do .ttp (kopia .ttp.bak). */
  saveTripRoute(tripFile: string, segments: RouteSegment[], stations: StationEdits): Promise<OkResult>;

  /** Okno bez natywnej ramki (motyw XP): własne przyciski minimalizuj / maksymalizuj / zamknij. */
  windowControl(action: 'minimize' | 'maximize' | 'close'): Promise<void>;
  isWindowMaximized(): Promise<boolean>;
  onWindowState(cb: (maximized: boolean) => void): void;

  onConsoleLine(cb: (line: ConsoleLine) => void): void;
  onRunState(cb: (state: RunState) => void): void;
  onTasksChanged(cb: () => void): void;
  onMapChanged(cb: () => void): void;
  onOpenSettings(cb: () => void): void;
}
