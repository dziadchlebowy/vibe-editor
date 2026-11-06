import type { SliProfile } from './sli.ts';
import type { EditSpline } from './splineEdit.ts';
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
  LinkEndRef,
  LinkNode,
  LinkPlan,
  NewSplineReq,
  RouteSegment,
  SplineIssue,
  SplinePoint,
  TextureImage,
  SplinePointRef,
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
  /** Węzeł ścieżki (koniec splinu z ścieżką pojazdów) najbliższy punktowi (jednostki kafli), maks. maxDistM metrów. */
  pickLinkNode(x: number, y: number, maxDistM: number): Promise<LinkNode | null>;
  /** Plan łączenia dwóch węzłów (bez zapisu). */
  planLink(a: LinkEndRef, b: LinkEndRef): Promise<LinkPlan>;
  /** Tworzy łączenie: dopisuje spliny z invis_street.sli do kafla i przyłącza je do wolnych końców (kopie .map.bak). */
  createLink(a: LinkEndRef, b: LinkEndRef, reverse: boolean): Promise<OkResult & { ids?: string[] }>;
  /** Profil .sli (tekstury i pasy przekroju) pliku z kopii zasobów mapy; null, gdy nie ma pliku. */
  getSliProfile(sli: string): Promise<SliProfile | null>;
  /** Tekstura z folderu OMSI wskazana w .sli (BMP, TGA, DDS, PNG, JPG), zmniejszona do ≤ 256 px; null, gdy nie znaleziono lub nie da się odczytać. */
  getSliTexture(sli: string, name: string): Promise<TextureImage | null>;
  /** Końce splinów (wraz z pokrywającymi się końcami innych splinów) najbliższe punktowi (jednostki kafli), maks. maxDistM metrów. */
  pickSplinePoints(x: number, y: number, maxDistM: number): Promise<SplinePoint[]>;
  /** Końce splinów w prostokącie (jednostki kafli) — zaznaczanie prostokątem. */
  pickSplinePointsInBox(x0: number, y0: number, x1: number, y1: number): Promise<SplinePoint[]>;
  /** Kontrola spójności splinów całej mapy: przerwy, załamki azymutu/nachylenia, skoki wysokości, niesymetryczne odnośniki. */
  checkSplines(): Promise<SplineIssue[]>;
  /** Wyrównuje połączenie (koniec splinu A → początek splinu B): wysokość, nachylenie i skew jako średnie. */
  alignSplines(a: SplinePointRef, b: SplinePointRef): Promise<OkResult>;
  /** Cofa / ponawia ostatnią zmianę kafli (spliny, łączenia); zwraca nazwę operacji. */
  undoMap(): Promise<OkResult & { label?: string }>;
  redoMap(): Promise<OkResult & { label?: string }>;
  /** Nazwy operacji, które można cofnąć / ponowić (null = brak). */
  undoState(): Promise<{ undo: string | null; redo: string | null }>;
  /** Spliny wskazanych końców w metrach świata — do podglądu przesunięć w interfejsie. */
  loadEditSplines(refs: SplinePointRef[]): Promise<EditSpline[]>;
  /** Przesuwa wskazane końce splinów (dx, dy w metrach, dz — wysokość) i zapisuje kafle (kopie .map.bak). */
  applySplineEdit(refs: SplinePointRef[], dx: number, dy: number, dz: number, arc: boolean): Promise<OkResult>;
  /** Usuwa spliny, do których należą wskazane końce (wraz z ich blokami [rule]) i czyści odnośniki prev/next innych splinów do nich (kopie .map.bak). */
  deleteSplines(refs: SplinePointRef[]): Promise<OkResult & { ids?: string[] }>;
  /** Tworzy nowy spline i zapisuje go do kafla (przyłącza do wolnego końca splinu źródłowego). */
  createSpline(req: NewSplineReq): Promise<OkResult & { id?: string }>;
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
