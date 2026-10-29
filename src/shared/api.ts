import type {
  ConsoleLine,
  LineFile,
  InspectResult,
  MapCatalog,
  MapOverview,
  MapSplines,
  OkResult,
  RunState,
  SaveRequest,
  Settings,
  TaskInput,
  TaskView,
  TimetableData,
  TripFile,
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

  getConsoleHistory(): Promise<ConsoleLine[]>;

  /** Linie (.ttl) i kursy (.ttp) z folderu mapy. */
  loadTimetable(): Promise<TimetableData>;
  saveLine(line: LineFile): Promise<OkResult>;
  saveTrip(trip: TripFile): Promise<OkResult>;

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
