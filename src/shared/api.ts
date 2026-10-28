import type {
  ConsoleLine,
  InspectResult,
  MapOverview,
  OkResult,
  RunState,
  SaveRequest,
  Settings,
  TaskInput,
  TaskView,
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
  setTaskChecked(id: string, checked: boolean): Promise<void>;

  startRun(taskIds: string[]): Promise<OkResult>;
  stopRun(): Promise<void>;
  resumeRun(): Promise<OkResult>;
  getRunState(): Promise<RunState>;

  getMapOverview(): Promise<MapOverview | null>;
  reindexMap(): Promise<OkResult>;
  isMapIndexing(): Promise<boolean>;

  getConsoleHistory(): Promise<ConsoleLine[]>;

  onConsoleLine(cb: (line: ConsoleLine) => void): void;
  onRunState(cb: (state: RunState) => void): void;
  onTasksChanged(cb: () => void): void;
  onMapChanged(cb: () => void): void;
  onOpenSettings(cb: () => void): void;
}
