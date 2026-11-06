import { toParams } from '../shared/busStop.ts';
import { texturePatternMatrix, type SliProfile } from '../shared/sli.ts';
import type { MapObjPaths, MapOverview, MapSplines, MapStops, MapTileView, RouteSegment, TaskPin, TextureImage, TileCoord, TripRoute } from '../shared/types.ts';
import { clear, h } from './dom.ts';

/**
 * Siatka kafli (canvas): kafel (x, y) to kwadrat o boku 1 wycentrowany w punkcie (x, y);
 * oś Y rośnie w górę ekranu (północ u góry), jak na mapie OMSI. Jedna klasa obsługuje zakładkę Mapa
 * oraz okienka wyboru kafli / punktu pinezki.
 */

/** Tekstura splinu: bitmapy kolejnych poziomów pomniejszenia (mipmapy) i wzory canvas do ich rysowania, kolor średni. */
interface TexEntry {
  w: number;
  h: number;
  avg: [number, number, number];
  mips: (ImageBitmap | null)[];
  pats: (CanvasPattern | null)[];
}
/** Tekstury ładujemy od tego zbliżenia (px na kafel, ok. 1,5 px/m); wzór rysujemy od drugiego progu (ok. 3 px/m). */
const TEX_LOAD_SCALE = 450;
const TEX_DRAW_SCALE = 900;
const TEX_BUDGET = 4000; // maks. liczba kawałków pasów teksturowanych w jednej klatce

const MIN_SCALE = 3;
const MAX_SCALE = 48000; // px na kafel (300 m): 48000 → 160 px na metr
const DRAG_THRESHOLD = 4;
const PIN_HIT_RADIUS = 11;

/** info: klik pokazuje informacje · select: klik zaznacza/odznacza kafel · pin: klik ustawia punkt. */
export type GridMode = 'info' | 'select' | 'pin';

export interface GridPin {
  id: string;
  title: string;
  x: number;
  y: number;
}

export interface GridOptions {
  mode: GridMode;
  onSelectionChange?: (tiles: TileCoord[]) => void;
  /** Wywoływane po ustawieniu punktu w trybie pin. */
  onPinPlaced?: (pin: TaskPin) => void;
  /** Klik w przystanek (gdy warstwa „Przystanki” jest włączona): edycja jego parametrów. */
  onStopClick?: (stop: GridStop) => void;
  /**
   * Klik w trybie edycji trasy: segment = indeks klikniętego odcinka trasy (null, gdy kliknięto puste miejsce),
   * x/y = punkt w jednostkach kafli, maxDistM = promień „trafienia” w metrach przy bieżącym zbliżeniu.
   */
  onRouteClick?: (c: { segment: number | null; stop: GridStop | null; x: number; y: number; maxDistM: number }) => void;
  /** Ruch kursora w trybie edycji trasy (null = kursor opuścił mapę); overSegment = kursor nad odcinkiem trasy. */
  onRouteHover?: (c: { x: number; y: number; maxDistM: number; overSegment: boolean } | null) => void;
  /** Klik i ruch kursora w trybie łączeń ścieżek (maxDistM = promień „trafienia” w węzeł w metrach). */
  /** Wczytanie profilu .sli i tekstury z folderu OMSI (tekstury splinów); null = brak. */
  loadSliProfile?: (sli: string) => Promise<SliProfile | null>;
  loadTexture?: (sli: string, name: string) => Promise<TextureImage | null>;
  onLinkClick?: (c: { x: number; y: number; maxDistM: number; ctrl: boolean }) => void;
  onLinkHover?: (c: { x: number; y: number; maxDistM: number; ctrl: boolean } | null) => void;
  /** Edycja splinów: klik (px/py = pozycja na ekranie, x/y w jednostkach kafli), ruch kursora i anulowanie prawym przyciskiem. */
  onSplineClick?: (c: SplinePointer) => void;
  onSplineMove?: (c: SplinePointer | null) => void;
  onSplineCancel?: () => void;
}

export interface SplinePointer {
  x: number;
  y: number;
  px: number;
  py: number;
  maxDistM: number;
  shift: boolean;
  ctrl: boolean;
}

/** Nakładka trybu edycji splinów: zaznaczone końce, koniec pod kursorem, podgląd zmian i etykiety wysokości. */
export interface SplineOverlay {
  selected: { x: number; y: number }[];
  hover: { x: number; y: number } | null;
  preview: number[][];
  labels: { x: number; y: number; text: string; bold?: boolean }[];
  /** Prostokąt zaznaczania (jednostki kafli) i punkt przyciągania podczas przesuwania. */
  box?: { x0: number; y0: number; x1: number; y1: number } | null;
  snap?: { x: number; y: number } | null;
}

/** Nakładka trybu łączeń: wybrane węzły, węzeł pod kursorem i podgląd nowych splinów. */
export interface LinkOverlay {
  a: { x: number; y: number } | null;
  b: { x: number; y: number } | null;
  hover: { x: number; y: number } | null;
  preview: number[][];
  /** Nowe spliny będą odbite (mirror): strzałki podglądu wskazują wtedy od końca do początku. */
  reverse?: boolean;
}

export interface GridStop {
  tileFile: string;
  id: string;
  p: string[];
  /** Pozycja obiektu przystanku w jednostkach kafli. */
  wx?: number;
  wy?: number;
}

const key = (x: number, y: number): string => `${x},${y}`;

export class MapGrid {
  readonly el: HTMLElement;

  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private infoBox: HTMLElement;
  private emptyMsg: HTMLElement;
  private hint: HTMLElement;
  private opts: GridOptions;

  private data: MapOverview | null = null;
  private pins: GridPin[] = [];
  private splines: MapSplines | null = null;
  private roadColors: string[] = [];
  private layers = { paths: false, stops: false, splines: true, textures: true };
  private profiles = new Map<string, SliProfile | null | 'loading'>();
  private texImgs = new Map<string, TexEntry | null | 'loading'>();
  private redrawPending = false;
  private texBudget = 0;
  private maxWidth = 0;
  private objPaths: MapObjPaths | null = null;
  private stops: MapStops | null = null;
  private route: TripRoute | null = null;
  private routeEditing = false;
  private routeSelected: number | null = null;
  private routeHover: RouteSegment[] = [];
  private linkMode = false;
  private link: LinkOverlay = { a: null, b: null, hover: null, preview: [] };
  private ctrl = false;
  private shift = false;
  private splineMode = false;
  private splineOv: SplineOverlay = { selected: [], hover: null, preview: [], labels: [] };
  private tileSelect = true;
  private tip: HTMLElement;
  private selectedTile: MapTileView | null = null;
  private selectedPin: GridPin | null = null;
  private chosen = new Map<string, TileCoord>();
  private pending: TaskPin | null = null;
  private signature = '';
  private needFit = false;
  private busy = false;

  // środek ekranu w jednostkach kafli + skala (piksele na kafel)
  private cx = 0;
  private cy = 0;
  private scale = 40;

  constructor(opts: GridOptions) {
    this.opts = opts;
    this.canvas = h('canvas', { class: 'map-canvas' });
    this.infoBox = h('div', { class: 'map-info' });
    this.infoBox.hidden = true;
    this.emptyMsg = h('div', { class: 'map-empty' });
    this.hint = h('div', { class: 'map-hint' });
    this.tip = h('div', { class: 'map-tip' });
    this.tip.hidden = true;
    this.el = h('div', { class: 'map-wrap' }, this.canvas, this.infoBox, this.emptyMsg, this.hint, this.tip);
    this.ctx = this.canvas.getContext('2d')!;

    new ResizeObserver(() => this.draw()).observe(this.canvas);
    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.canvas.addEventListener('pointermove', (e) => this.onHover(e));
    this.canvas.addEventListener('pointerleave', () => {
      this.tip.hidden = true;
      if (this.routeEditing) this.opts.onRouteHover?.(null);
      if (this.linkMode) this.opts.onLinkHover?.(null);
      if (this.splineMode) this.opts.onSplineMove?.(null);
    });
    this.canvas.addEventListener('contextmenu', (e) => {
      if (!this.splineMode) return;
      e.preventDefault();
      this.opts.onSplineCancel?.();
    });
    this.refresh();
  }

  // --- API ------------------------------------------------------------------

  setData(overview: MapOverview | null): void {
    this.data = overview;
    const sig = overview ? overview.tiles.map((t) => key(t.x, t.y)).join(';') : '';
    if (sig !== this.signature) {
      this.signature = sig;
      this.needFit = true;
    }
    if (this.selectedTile) {
      const t = this.selectedTile;
      this.selectedTile = overview?.tiles.find((c) => c.x === t.x && c.y === t.y) ?? null;
    }
    this.refresh();
  }

  private scheduleDraw(): void {
    if (this.redrawPending) return;
    this.redrawPending = true;
    requestAnimationFrame(() => {
      this.redrawPending = false;
      this.draw();
    });
  }

  /** Profil .sli drogi; pierwsze wywołanie zleca wczytanie (do tego czasu null) i po nim przerysowuje mapę. */
  private profileFor(sli: string): SliProfile | null {
    const hit = this.profiles.get(sli);
    if (hit === 'loading') return null;
    if (hit !== undefined) return hit;
    if (!this.opts.loadSliProfile) return null;
    this.profiles.set(sli, 'loading');
    this.opts
      .loadSliProfile(sli)
      .then((p) => this.profiles.set(sli, p))
      .catch(() => this.profiles.set(sli, null))
      .finally(() => this.scheduleDraw());
    return null;
  }

  /** Tekstura wskazana w .sli (mipmapy tworzone po wczytaniu); null, dopóki się nie wczyta albo gdy jej nie ma. */
  private textureFor(sli: string, name: string): TexEntry | null {
    const key = `${sli.toLowerCase()}|${name.toLowerCase()}`;
    const hit = this.texImgs.get(key);
    if (hit === 'loading') return null;
    if (hit !== undefined) return hit;
    if (!this.opts.loadTexture) return null;
    this.texImgs.set(key, 'loading');
    this.opts
      .loadTexture(sli, name)
      .then(async (img) => {
        if (!img) {
          this.texImgs.set(key, null);
          return;
        }
        const data = new ImageData(new Uint8ClampedArray(img.data), img.w, img.h);
        const entry: TexEntry = { w: img.w, h: img.h, avg: img.avg, mips: [await createImageBitmap(data)], pats: [] };
        this.texImgs.set(key, entry);
        // dalsze poziomy pomniejszenia: wybierane przy rysowaniu, gdy tekstura jest gęstsza niż ekran
        for (let l = 1; l <= 4 && img.w >> l >= 1 && img.h >> l >= 1; l++) {
          void createImageBitmap(data, { resizeWidth: Math.max(1, img.w >> l), resizeHeight: Math.max(1, img.h >> l), resizeQuality: 'high' }).then((b) => {
            entry.mips[l] = b;
          });
        }
      })
      .catch(() => this.texImgs.set(key, null))
      .finally(() => this.scheduleDraw());
    return null;
  }

  /** Kolor wypełnienia drogi: średni kolor tekstury najszerszego pasa profilu (gdy znany), inaczej kolor z szerokości przekroju. */
  private flatColor(roadIdx: number, sli: string, texturesOn: boolean): string {
    if (texturesOn) {
      const prof = this.profileFor(sli);
      if (prof && prof.bands.length > 0) {
        let widest = prof.bands[0];
        for (const b of prof.bands) if (Math.abs(b.x1 - b.x0) > Math.abs(widest.x1 - widest.x0)) widest = b;
        const e = this.textureFor(sli, prof.textures[widest.tex]);
        if (e) return `rgb(${e.avg[0]} ${e.avg[1]} ${e.avg[2]})`;
      }
    }
    return this.roadColors[roadIdx] ?? '#444';
  }

  /** Spliny z kafli: rysowane na kaflach według pozycji, długości, łuku i szerokości przekroju. */
  setSplines(data: MapSplines | null): void {
    this.splines = data;
    // delikatne różnicowanie kolorów: im szerszy przekrój, tym jaśniejszy i cieplejszy odcień
    this.roadColors = (data?.roads ?? []).map((r) => {
      const t = Math.max(0, Math.min(1, (r.b - r.a - 2) / 20));
      return `hsl(${Math.round(215 - t * 170)} 30% ${Math.round(26 + t * 24)}%)`;
    });
    this.draw();
  }

  /** Warstwy dodatkowe: ścieżki ruchu ze splinów (rysowane na wierzchu splinów). */
  setLayers(l: { paths: boolean; stops: boolean; splines: boolean; textures?: boolean }): void {
    this.layers = { textures: true, ...l };
    this.tip.hidden = true;
    this.draw();
  }

  /** Próg szerokości splinów (m): szersze nie są rysowane; 0 = bez limitu. */
  setSplineMaxWidth(m: number): void {
    this.maxWidth = m > 0 ? m : 0;
    this.draw();
  }

  /** Ścieżki ruchu z obiektów (.sco) rozmieszczonych na kaflach. */
  setObjPaths(data: MapObjPaths | null): void {
    this.objPaths = data;
    this.draw();
  }

  setStops(data: MapStops | null): void {
    this.stops = data;
    this.draw();
  }

  /** Trasa kursu (z .ttr) z jego przystankami; null ją ukrywa. */
  setRoute(route: TripRoute | null): void {
    this.route = route;
    this.draw();
  }

  /** Przybliża widok tak, by cała trasa kursu była widoczna. */
  fitRoute(): void {
    const w = this.canvas.clientWidth;
    const hh = this.canvas.clientHeight;
    const r = this.route;
    if (!r || w === 0 || hh === 0) return;
    const xs: number[] = [];
    const ys: number[] = [];
    for (const g of r.segments) for (let i = 0; i < g.line.length; i += 2) (xs.push(g.line[i]), ys.push(g.line[i + 1]));
    for (const s of r.stops) (xs.push(s.x), ys.push(s.y));
    if (xs.length === 0) return;
    const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    this.cx = (minX + maxX) / 2;
    this.cy = (minY + maxY) / 2;
    const fit = Math.min(w / Math.max(maxX - minX, 0.02), hh / Math.max(maxY - minY, 0.02)) * 0.85;
    this.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, fit));
    this.needFit = false;
    this.draw();
  }

  /** Tryb edycji trasy: klik w odcinek trasy lub w puste miejsce idzie do onRouteClick zamiast zwykłych informacji o kaflu. */
  setRouteEditing(on: boolean): void {
    this.routeEditing = on;
    if (!on) this.routeSelected = null;
    this.refresh();
  }

  /** Wyłączone zaznaczanie kafli: klik nie zaznacza kafla ani pinezki, a panel szczegółów kafla jest ukryty (poza trybem „Przegląd”). */
  setTileSelection(on: boolean): void {
    this.tileSelect = on;
    if (!on) {
      this.selectedTile = null;
      this.selectedPin = null;
    }
    this.refresh();
  }

  /** Tryb edycji splinów: klik, ruch kursora i prawy przycisk idą do onSpline*; rysowane są uchwyty początków i końców splinów. */
  setSplineMode(on: boolean): void {
    this.splineMode = on;
    if (!on) this.splineOv = { selected: [], hover: null, preview: [], labels: [] };
    this.refresh();
  }

  /** Najbliższy początek/koniec splinu z indeksu (jednostki kafli) w promieniu maxDistM metrów od (x, y), poza punktami z `exclude`. */
  endpointNear(x: number, y: number, maxDistM: number, exclude: { x: number; y: number }[]): { x: number; y: number } | null {
    let best: { x: number; y: number } | null = null;
    let bd = maxDistM;
    for (const t of this.splines?.tiles ?? []) {
      if (Math.abs(t.x - Math.round(x)) > 1 || Math.abs(t.y - Math.round(y)) > 1) continue;
      for (const s of t.s) {
        const [, lx, ly, hdg, len, radius] = s;
        const k = radius !== 0 ? 1 / radius : 0;
        const phi0 = (hdg * Math.PI) / 180;
        const phi = phi0 + k * len;
        const mx = k === 0 ? Math.sin(phi0) * len : (Math.cos(phi0) - Math.cos(phi)) / k;
        const my = k === 0 ? Math.cos(phi0) * len : (Math.sin(phi) - Math.sin(phi0)) / k;
        for (const [ex, ey] of [[lx, ly], [lx + mx, ly + my]] as const) {
          const p = { x: t.x - 0.5 + ex / 300, y: t.y - 0.5 + ey / 300 };
          if (exclude.some((q) => Math.hypot((q.x - p.x) * 300, (q.y - p.y) * 300) < 0.3)) continue;
          const d = Math.hypot((p.x - x) * 300, (p.y - y) * 300);
          if (d < bd) (bd = d, (best = p));
        }
      }
    }
    return best;
  }

  setSplineOverlay(o: SplineOverlay): void {
    this.splineOv = o;
    this.draw();
  }

  /** Tryb łączeń ścieżek: klik i ruch kursora idą do onLinkClick / onLinkHover. */
  setLinkMode(on: boolean): void {
    this.linkMode = on;
    if (!on) this.link = { a: null, b: null, hover: null, preview: [] };
    this.refresh();
  }

  setLinkOverlay(o: LinkOverlay): void {
    this.link = o;
    this.draw();
  }

  /** Ścieżki podświetlone pod kursorem (jedna albo cały łańcuch od zaznaczonego odcinka); pusta tablica gasi podświetlenie. */
  setRouteHover(segs: RouteSegment[]): void {
    this.routeHover = segs;
    this.draw();
  }

  /** Zaznaczony odcinek trasy (indeks w route.segments) — rysowany wyróżnionym kolorem z oznaczonym początkiem i końcem. */
  setRouteSelected(i: number | null): void {
    this.routeSelected = i;
    this.draw();
  }

  /** Przesuwa widok tak, by zaznaczony odcinek był w kadrze (bez zmiany zbliżenia, jeśli już jest widoczny). */
  focusSegment(i: number): void {
    const g = this.route?.segments[i];
    if (!g || g.line.length < 2) return;
    const mid = Math.floor(g.line.length / 4) * 2;
    const w = this.canvas.clientWidth;
    const hh = this.canvas.clientHeight;
    const px = this.sx(g.line[mid], w);
    const py = this.sy(g.line[mid + 1], hh);
    if (px > 40 && py > 40 && px < w - 340 && py < hh - 40) return;
    this.cx = g.line[mid];
    this.cy = g.line[mid + 1];
    this.draw();
  }

  /** Indeks odcinka trasy najbliżej punktu ekranu (maks. 8 px) albo null. */
  private segmentAt(px: number, py: number): number | null {
    const w = this.canvas.clientWidth;
    const hh = this.canvas.clientHeight;
    let best: number | null = null;
    let bestD = 8;
    this.route?.segments.forEach((g, k) => {
      const l = g.line;
      for (let i = 0; i + 3 < l.length; i += 2) {
        const ax = this.sx(l[i], w);
        const ay = this.sy(l[i + 1], hh);
        const dx = this.sx(l[i + 2], w) - ax;
        const dy = this.sy(l[i + 3], hh) - ay;
        const l2 = dx * dx + dy * dy;
        const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
        const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
        if (d < bestD) (bestD = d, (best = k));
      }
    });
    return best;
  }

  /** Przystanek pod kursorem (promień 9 px); tylko przy włączonej warstwie. */
  private stopAt(px: number, py: number): { stop: GridStop; name: string; sub: string } | null {
    if (!this.layers.stops || !this.stops) return null;
    const w = this.canvas.clientWidth;
    const hh = this.canvas.clientHeight;
    const mPx = this.scale / 300;
    let best: { d: number; stop: GridStop; name: string; sub: string } | null = null;
    for (const t of this.stops.tiles) {
      const left = this.sx(t.x - 0.5, w);
      const top = this.sy(t.y + 0.5, hh);
      if (left + this.scale < -10 || top + this.scale < -10 || left > w + 10 || top > hh + 10) continue;
      for (const s of t.s) {
        const d = Math.hypot(px - (left + s.x * mPx), py - (top + (300 - s.y) * mPx));
        if (d <= 9 && (!best || d < best.d)) {
          const p = toParams(s.p);
          best = { d, stop: { tileFile: t.file, id: s.id, p: s.p, wx: t.x - 0.5 + s.x / 300, wy: t.y - 0.5 + s.y / 300 }, name: p.name || '(bez nazwy)', sub: p.subName };
        }
      }
    }
    return best;
  }

  private onHover(e: PointerEvent): void {
    if (this.splineMode) {
      if (e.buttons !== 0) return;
      const r = this.canvas.getBoundingClientRect();
      this.opts.onSplineMove?.(this.splinePointer(e.clientX - r.left, e.clientY - r.top, e.shiftKey, e.ctrlKey));
      return;
    }
    if (this.linkMode) {
      if (e.buttons !== 0) return;
      const r = this.canvas.getBoundingClientRect();
      const w = this.worldAt(e.clientX - r.left, e.clientY - r.top);
      this.opts.onLinkHover?.({ x: w.x, y: w.y, maxDistM: (12 * 300) / this.scale, ctrl: e.ctrlKey });
      return;
    }
    if (this.routeEditing) {
      if (e.buttons !== 0) return;
      const r = this.canvas.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      const w = this.worldAt(px, py);
      this.opts.onRouteHover?.({ x: w.x, y: w.y, maxDistM: (10 * 300) / this.scale, overSegment: this.segmentAt(px, py) !== null });
      return;
    }
    if (e.buttons !== 0 || !this.layers.stops) {
      if (!this.layers.stops) this.tip.hidden = true;
      return;
    }
    const r = this.canvas.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    const hit = this.stopAt(px, py);
    this.tip.hidden = !hit;
    this.canvas.style.cursor = hit ? 'pointer' : '';
    if (!hit) return;
    this.tip.textContent = hit.sub ? `${hit.name} (${hit.sub})` : hit.name;
    this.tip.style.left = `${Math.min(px + 14, r.width - 160)}px`;
    this.tip.style.top = `${Math.max(4, py - 30)}px`;
  }

  /**
   * Ścieżki ruchu z obiektów (.sco), np. skrzyżowań: łuk od punktu (x, y) obiektu, azymut ° od północy zgodnie z zegarem,
   * promień ujemny = w lewo. Cały obiekt obracany o jego obrót (założenie: ten sam układ azymutu co w splinach).
   */
  private drawObjPaths(w: number, hh: number): void {
    const data = this.objPaths;
    if (!this.layers.paths || !data) return;
    const ctx = this.ctx;
    const mPx = this.scale / 300;
    for (const pass of [0, 1]) {
      ctx.strokeStyle = pass === 0 ? '#ffffff' : '#ff1fd0';
      ctx.lineWidth = pass === 0 ? 3.4 : 1.6;
      ctx.lineCap = 'butt';
      for (const t of data.tiles) {
        const left = this.sx(t.x - 0.5, w);
        const top = this.sy(t.y + 0.5, hh);
        if (left + this.scale < -50 || top + this.scale < -50 || left > w + 50 || top > hh + 50) continue;
        for (const [di, ox, oy, rot] of t.o) {
          const def = data.defs[di];
          if (!def) continue;
          const r = (rot * Math.PI) / 180;
          const cr = Math.cos(r);
          const sr = Math.sin(r);
          for (const [x, y, hdg, radius, len] of def.t) {
            const k = radius !== 0 ? 1 / radius : 0;
            const phi0 = (hdg * Math.PI) / 180;
            const steps = k === 0 ? 1 : Math.max(1, Math.ceil(Math.abs(len * k) / (Math.PI / 24)));
            ctx.beginPath();
            for (let i = 0; i <= steps; i++) {
              const sLen = (len * i) / steps;
              const phi = phi0 + k * sLen;
              const lx = x + (k === 0 ? Math.sin(phi0) * sLen : (Math.cos(phi0) - Math.cos(phi)) / k);
              const ly = y + (k === 0 ? Math.cos(phi0) * sLen : (Math.sin(phi) - Math.sin(phi0)) / k);
              // obrót zgodny z ruchem wskazówek zegara o `rot`, potem przesunięcie do pozycji obiektu
              const wx = ox + lx * cr + ly * sr;
              const wy = oy - lx * sr + ly * cr;
              const px = left + wx * mPx;
              const py = top + (300 - wy) * mPx;
              if (i === 0) ctx.moveTo(px, py);
              else ctx.lineTo(px, py);
            }
            ctx.stroke();
          }
        }
      }
    }
    // strzałki kierunku (ścieżki obiektów biegną od początku do końca) pośrodku każdej ścieżki
    if (this.scale >= 220) {
      for (const t of data.tiles) {
        const left = this.sx(t.x - 0.5, w);
        const top = this.sy(t.y + 0.5, hh);
        if (left + this.scale < -50 || top + this.scale < -50 || left > w + 50 || top > hh + 50) continue;
        for (const [di, ox, oy, rot] of t.o) {
          const def = data.defs[di];
          if (!def) continue;
          const r = (rot * Math.PI) / 180;
          for (const [x, y, hdg, radius, len] of def.t) {
            if (len * mPx < 24) continue;
            const k = radius !== 0 ? 1 / radius : 0;
            const phi0 = (hdg * Math.PI) / 180;
            const sLen = len / 2;
            const phi = phi0 + k * sLen;
            const lx = x + (k === 0 ? Math.sin(phi0) * sLen : (Math.cos(phi0) - Math.cos(phi)) / k);
            const ly = y + (k === 0 ? Math.cos(phi0) * sLen : (Math.sin(phi) - Math.sin(phi0)) / k);
            const wx = ox + lx * Math.cos(r) + ly * Math.sin(r);
            const wy = oy - lx * Math.sin(r) + ly * Math.cos(r);
            this.arrow(left + wx * mPx, top + (300 - wy) * mPx, this.screenAngle(phi + r), 6, '#6a005a');
          }
        }
      }
    }
  }

  /** Edycja splinów: uchwyty początków (niebieskie) i końców (pomarańczowe) widocznych splinów, zaznaczenie, podgląd i etykiety Z. */
  private drawSplineEdit(w: number, hh: number): void {
    if (!this.splineMode) return;
    const ctx = this.ctx;
    const data = this.splines;
    if (data && this.scale >= 120) {
      const mPx = this.scale / 300;
      for (const t of data.tiles) {
        const left = this.sx(t.x - 0.5, w);
        const top = this.sy(t.y + 0.5, hh);
        if (left + this.scale < -20 || top + this.scale < -20 || left > w + 20 || top > hh + 20) continue;
        for (const s of t.s) {
          const [, lx, ly, hdg, len, radius] = s;
          const k = radius !== 0 ? 1 / radius : 0;
          const phi0 = (hdg * Math.PI) / 180;
          const phi = phi0 + k * len;
          const mx = k === 0 ? Math.sin(phi0) * len : (Math.cos(phi0) - Math.cos(phi)) / k;
          const my = k === 0 ? Math.cos(phi0) * len : (Math.sin(phi) - Math.sin(phi0)) / k;
          for (const [px, py, col] of [
            [left + lx * mPx, top + (300 - ly) * mPx, '#1d5fd0'],
            [left + (lx + mx) * mPx, top + (300 - (ly + my)) * mPx, '#d9731a'],
          ] as const) {
            ctx.beginPath();
            ctx.arc(px, py, 3.5, 0, Math.PI * 2);
            ctx.fillStyle = col;
            ctx.fill();
            ctx.lineWidth = 1;
            ctx.strokeStyle = '#ffffff';
            ctx.stroke();
          }
        }
      }
    }
    const o = this.splineOv;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const pass of [0, 1]) {
      ctx.strokeStyle = pass === 0 ? '#ffffff' : '#a21cd0';
      ctx.lineWidth = pass === 0 ? 7 : 3.5;
      ctx.setLineDash(pass === 0 ? [] : [9, 5]);
      for (const l of o.preview) {
        ctx.beginPath();
        for (let i = 0; i < l.length; i += 2) {
          const px = this.sx(l[i], w);
          const py = this.sy(l[i + 1], hh);
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);
    if (o.box) {
      const [bx0, by0, bx1, by1] = [this.sx(o.box.x0, w), this.sy(o.box.y0, hh), this.sx(o.box.x1, w), this.sy(o.box.y1, hh)];
      ctx.fillStyle = 'rgba(0, 120, 215, 0.12)';
      ctx.fillRect(Math.min(bx0, bx1), Math.min(by0, by1), Math.abs(bx1 - bx0), Math.abs(by1 - by0));
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#0a5fb0';
      ctx.strokeRect(Math.min(bx0, bx1), Math.min(by0, by1), Math.abs(bx1 - bx0), Math.abs(by1 - by0));
      ctx.setLineDash([]);
    }
    if (o.snap) {
      ctx.beginPath();
      ctx.arc(this.sx(o.snap.x, w), this.sy(o.snap.y, hh), 11, 0, Math.PI * 2);
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#d6291f';
      ctx.stroke();
    }
    if (o.hover) {
      ctx.beginPath();
      ctx.arc(this.sx(o.hover.x, w), this.sy(o.hover.y, hh), 9, 0, Math.PI * 2);
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#a21cd0';
      ctx.stroke();
    }
    for (const p of o.selected) {
      const x = this.sx(p.x, w);
      const y = this.sy(p.y, hh);
      ctx.beginPath();
      ctx.arc(x, y, 8, 0, Math.PI * 2);
      ctx.fillStyle = '#ffd400';
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = '#1b1b1b';
      ctx.stroke();
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    for (const l of o.labels) {
      const x = this.sx(l.x, w) + 11;
      const y = this.sy(l.y, hh) - 9;
      ctx.font = `${l.bold ? 'bold ' : ''}12px Tahoma, sans-serif`;
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#ffffff';
      ctx.strokeText(l.text, x, y);
      ctx.fillStyle = l.bold ? '#7a0066' : '#1b1b1b';
      ctx.fillText(l.text, x, y);
    }
  }

  /** Strzałka kierunku: trójkąt o czubku w (x, y) obróconym o `ang` (rad., 0 = w prawo ekranu); biały kontur dla czytelności. */
  private arrow(x: number, y: number, ang: number, size: number, fill: string): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang);
    ctx.beginPath();
    ctx.moveTo(size, 0);
    ctx.lineTo(-size * 0.7, -size * 0.65);
    ctx.lineTo(-size * 0.35, 0);
    ctx.lineTo(-size * 0.7, size * 0.65);
    ctx.closePath();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.restore();
  }

  /** Kąt na ekranie dla azymutu `phi` (rad., od północy zgodnie z zegarem). */
  private screenAngle(phi: number): number {
    return Math.atan2(-Math.cos(phi), Math.sin(phi));
  }

  /** Tryb łączeń: podgląd nowych splinów (przerywana linia), węzły A/B i węzeł pod kursorem. */
  private drawLink(w: number, hh: number): void {
    const o = this.link;
    const ctx = this.ctx;
    if (o.preview.length > 0) {
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const pass of [0, 1]) {
        ctx.strokeStyle = pass === 0 ? '#ffffff' : '#008fb3';
        ctx.lineWidth = pass === 0 ? 8 : 4.5;
        ctx.setLineDash(pass === 0 ? [] : [10, 6]);
        for (const l of o.preview) {
          ctx.beginPath();
          for (let i = 0; i < l.length; i += 2) {
            const px = this.sx(l[i], w);
            const py = this.sy(l[i + 1], hh);
            if (i === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          }
          ctx.stroke();
        }
      }
      ctx.setLineDash([]);
      // strzałki kierunku ruchu na podglądzie (od początku do końca splinu, a przy odbiciu — odwrotnie)
      for (const l of o.preview) {
        if (l.length < 4) continue;
        const m = Math.floor(l.length / 4) * 2 - 2;
        const ax = this.sx(l[Math.max(0, m)], w);
        const ay = this.sy(l[Math.max(0, m) + 1], hh);
        const bx = this.sx(l[Math.max(0, m) + 2], w);
        const by = this.sy(l[Math.max(0, m) + 3], hh);
        this.arrow((ax + bx) / 2, (ay + by) / 2, Math.atan2(by - ay, bx - ax) + (o.reverse ? Math.PI : 0), 7, '#008fb3');
      }
    }
    const dot = (n: { x: number; y: number }, fill: string, label: string, ring = false): void => {
      const x = this.sx(n.x, w);
      const y = this.sy(n.y, hh);
      ctx.beginPath();
      ctx.arc(x, y, ring ? 11 : 9, 0, Math.PI * 2);
      if (!ring) {
        ctx.fillStyle = fill;
        ctx.fill();
      }
      ctx.lineWidth = 3;
      ctx.strokeStyle = ring ? fill : '#ffffff';
      ctx.stroke();
      if (label) {
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 11px Tahoma, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, x, y + 0.5);
      }
    };
    if (o.hover) dot(o.hover, '#a21cd0', '', true);
    if (o.a) dot(o.a, '#2b9a3a', 'A');
    if (o.b) dot(o.b, '#d6291f', 'B');
  }

  /** Trasa kursu: biały kontur + jaskrawa linia (zaznaczony odcinek na niebiesko); przystanki jako numerowane kółka z nazwą przy większym zbliżeniu. */
  private drawRoute(w: number, hh: number): void {
    const r = this.route;
    if (!r) return;
    const ctx = this.ctx;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const trace = (l: number[]): void => {
      ctx.beginPath();
      for (let i = 0; i < l.length; i += 2) {
        const px = this.sx(l[i], w);
        const py = this.sy(l[i + 1], hh);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    };
    for (const pass of [0, 1]) {
      r.segments.forEach((g, k) => {
        const sel = k === this.routeSelected;
        ctx.strokeStyle = pass === 0 ? '#ffffff' : sel ? '#0b5cff' : '#e8590c';
        ctx.lineWidth = pass === 0 ? (sel ? 9 : 6) : sel ? 5.5 : 3.4;
        trace(g.line);
      });
    }
    if (this.routeHover.length > 0) {
      for (const pass of [0, 1]) {
        ctx.strokeStyle = pass === 0 ? '#ffffff' : '#a21cd0';
        ctx.lineWidth = pass === 0 ? 8 : 4.5;
        for (const g of this.routeHover) trace(g.line);
      }
    }
    {
      // strzałki kierunku jazdy w środku każdego odcinka (zawsze); w edycji dodatkowo początek i koniec zaznaczonego odcinka
      r.segments.forEach((g, k) => {
        const l = g.line;
        if (l.length < 4) return;
        const m = Math.floor(l.length / 4) * 2 - 2;
        const ax = this.sx(l[Math.max(0, m)], w);
        const ay = this.sy(l[Math.max(0, m) + 1], hh);
        const bx = this.sx(l[Math.max(0, m) + 2], w);
        const by = this.sy(l[Math.max(0, m) + 3], hh);
        const ang = Math.atan2(by - ay, bx - ax);
        const mx = (ax + bx) / 2;
        const my = (ay + by) / 2;
        ctx.save();
        ctx.translate(mx, my);
        ctx.rotate(ang);
        ctx.beginPath();
        ctx.moveTo(6, 0);
        ctx.lineTo(-5, -5);
        ctx.lineTo(-5, 5);
        ctx.closePath();
        ctx.fillStyle = k === this.routeSelected ? '#ffffff' : '#1b1b1b';
        ctx.fill();
        ctx.restore();
      });
      const sg = this.routeSelected !== null ? r.segments[this.routeSelected] : null;
      if (sg && sg.line.length >= 2) {
        const dot = (i: number, color: string): void => {
          ctx.beginPath();
          ctx.arc(this.sx(sg.line[i], w), this.sy(sg.line[i + 1], hh), 6, 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.fill();
          ctx.lineWidth = 2;
          ctx.strokeStyle = '#ffffff';
          ctx.stroke();
        };
        dot(0, '#2b9a3a');
        dot(sg.line.length - 2, '#d6291f');
      }
    }
    const rad = 9;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const s of r.stops) {
      const x = this.sx(s.x, w);
      const y = this.sy(s.y, hh);
      if (x < -20 || y < -20 || x > w + 20 || y > hh + 20) continue;
      ctx.beginPath();
      ctx.arc(x, y, rad, 0, Math.PI * 2);
      ctx.fillStyle = s.pending ? '#7bd88f' : '#ffd400';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#1b1b1b';
      ctx.stroke();
      ctx.fillStyle = '#1b1b1b';
      ctx.font = 'bold 10px Tahoma, sans-serif';
      ctx.fillText(String(s.n), x, y + 0.5);
      if (this.scale >= 600) {
        ctx.font = 'bold 12px Tahoma, sans-serif';
        ctx.textAlign = 'left';
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#ffffff';
        ctx.strokeText(s.name, x + rad + 4, y);
        ctx.fillText(s.name, x + rad + 4, y);
        ctx.textAlign = 'center';
      }
    }
  }

  private drawStops(w: number, hh: number): void {
    if (!this.layers.stops || !this.stops) return;
    const ctx = this.ctx;
    const mPx = this.scale / 300;
    const rad = Math.max(4, Math.min(8, this.scale / 18));
    for (const t of this.stops.tiles) {
      const left = this.sx(t.x - 0.5, w);
      const top = this.sy(t.y + 0.5, hh);
      if (left + this.scale < 0 || top + this.scale < 0 || left > w || top > hh) continue;
      for (const s of t.s) {
        const x = left + s.x * mPx;
        const y = top + (300 - s.y) * mPx;
        ctx.beginPath();
        ctx.arc(x, y, rad, 0, Math.PI * 2);
        ctx.fillStyle = '#ffd400';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#1b1b1b';
        ctx.stroke();
        ctx.fillStyle = '#1b1b1b';
        ctx.font = `bold ${Math.round(rad * 1.2)}px Tahoma, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('P', x, y + 0.5);
      }
    }
  }

  setBusy(value: boolean): void {
    this.busy = value;
    this.refresh();
  }

  setPins(pins: GridPin[]): void {
    this.pins = pins;
    if (this.selectedPin) {
      const id = this.selectedPin.id;
      this.selectedPin = pins.find((p) => p.id === id) ?? null;
    }
    this.refresh();
  }

  setMode(mode: GridMode): void {
    this.opts.mode = mode;
    this.refresh();
  }

  setSelection(tiles: TileCoord[]): void {
    this.chosen = new Map(tiles.map((t) => [key(t.x, t.y), { x: t.x, y: t.y }]));
    this.draw();
  }

  getSelection(): TileCoord[] {
    return [...this.chosen.values()].sort((a, b) => a.y - b.y || a.x - b.x);
  }

  /** Zaznacza wszystkie istniejące kafle (albo czyści zaznaczenie). */
  selectAll(on: boolean): void {
    this.chosen.clear();
    if (on) for (const t of this.data?.tiles ?? []) this.chosen.set(key(t.x, t.y), { x: t.x, y: t.y });
    this.opts.onSelectionChange?.(this.getSelection());
    this.draw();
  }

  setPending(p: TaskPin | null): void {
    this.pending = p;
    if (p && this.canvas.clientWidth > 0) this.centerOn(p.x, p.y);
    this.draw();
  }

  getPending(): TaskPin | null {
    return this.pending;
  }

  /** Dopasowuje widok do całej mapy i centruje go na jej środku (nie na punkcie 0, 0). */
  fit(): void {
    const w = this.canvas.clientWidth;
    const hh = this.canvas.clientHeight;
    if (!this.data || this.data.tiles.length === 0 || w === 0 || hh === 0) return;
    const xs = this.data.tiles.map((t) => t.x);
    const ys = this.data.tiles.map((t) => t.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    this.cx = (minX + maxX) / 2;
    this.cy = (minY + maxY) / 2;
    const fit = Math.min(w / (maxX - minX + 3), hh / (maxY - minY + 3));
    this.scale = Math.max(MIN_SCALE, Math.min(120, fit));
    this.needFit = false;
    this.draw();
  }

  /** Po pokazaniu zakładki/okna (wcześniej canvas może mieć rozmiar 0). */
  show(): void {
    this.draw();
  }

  // --- widok ----------------------------------------------------------------

  /** Przesuwa widok na punkt (jednostki kafli) i w razie potrzeby przybliża do co najmniej `minScale` px na kafel. */
  centerOn(x: number, y: number, minScale = 0): void {
    this.cx = x;
    this.cy = y;
    if (this.scale < minScale) this.scale = Math.min(MAX_SCALE, minScale);
    this.needFit = false;
    this.draw();
  }

  private sx(wx: number, w: number): number {
    return w / 2 + (wx - this.cx) * this.scale;
  }
  private sy(wy: number, hh: number): number {
    return hh / 2 - (wy - this.cy) * this.scale;
  }

  private worldAt(px: number, py: number): { x: number; y: number } {
    return {
      x: this.cx + (px - this.canvas.clientWidth / 2) / this.scale,
      y: this.cy - (py - this.canvas.clientHeight / 2) / this.scale,
    };
  }

  private tileAt(px: number, py: number): MapTileView | null {
    if (!this.data) return null;
    const w = this.worldAt(px, py);
    const tx = Math.round(w.x);
    const ty = Math.round(w.y);
    return this.data.tiles.find((t) => t.x === tx && t.y === ty) ?? null;
  }

  private pinAt(px: number, py: number): GridPin | null {
    const w = this.canvas.clientWidth;
    const hh = this.canvas.clientHeight;
    for (let i = this.pins.length - 1; i >= 0; i--) {
      const p = this.pins[i];
      const dx = px - this.sx(p.x, w);
      const dy = py - (this.sy(p.y, hh) - 12); // główka pinezki jest nad czubkiem
      if (Math.hypot(dx, dy) <= PIN_HIT_RADIUS) return p;
    }
    return null;
  }

  // --- zdarzenia --------------------------------------------------------------

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const r = this.canvas.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    const before = this.worldAt(px, py);
    this.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, this.scale * Math.exp(-e.deltaY * 0.0015)));
    this.cx = before.x - (px - this.canvas.clientWidth / 2) / this.scale;
    this.cy = before.y + (py - this.canvas.clientHeight / 2) / this.scale;
    this.draw();
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    const startX = e.clientX;
    const startY = e.clientY;
    let lastX = startX;
    let lastY = startY;
    let moved = false;
    const c = this.canvas;
    c.setPointerCapture(e.pointerId);

    const move = (ev: PointerEvent): void => {
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD) return;
      moved = true;
      this.cx -= (ev.clientX - lastX) / this.scale;
      this.cy += (ev.clientY - lastY) / this.scale;
      lastX = ev.clientX;
      lastY = ev.clientY;
      c.classList.add('dragging');
      this.draw();
    };
    const up = (ev: PointerEvent): void => {
      c.removeEventListener('pointermove', move);
      c.removeEventListener('pointerup', up);
      c.removeEventListener('pointercancel', up);
      c.classList.remove('dragging');
      if (!moved && ev.type === 'pointerup') {
        const r = c.getBoundingClientRect();
        this.ctrl = ev.ctrlKey;
        this.shift = ev.shiftKey;
        this.click(ev.clientX - r.left, ev.clientY - r.top);
      }
    };
    c.addEventListener('pointermove', move);
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
  }

  private splinePointer(px: number, py: number, shift: boolean, ctrl: boolean): SplinePointer {
    const w = this.worldAt(px, py);
    return { x: w.x, y: w.y, px, py, maxDistM: (12 * 300) / this.scale, shift, ctrl };
  }

  private click(px: number, py: number): void {
    if (this.splineMode) {
      this.opts.onSplineClick?.(this.splinePointer(px, py, this.shift, this.ctrl));
      return;
    }
    if (this.linkMode) {
      const w = this.worldAt(px, py);
      this.opts.onLinkClick?.({ x: w.x, y: w.y, maxDistM: (12 * 300) / this.scale, ctrl: this.ctrl });
      return;
    }
    if (this.routeEditing) {
      const w = this.worldAt(px, py);
      this.opts.onRouteClick?.({ segment: this.segmentAt(px, py), stop: this.stopAt(px, py)?.stop ?? null, x: w.x, y: w.y, maxDistM: (10 * 300) / this.scale });
      return;
    }
    const mode = this.opts.mode;
    if (mode === 'select') {
      const t = this.tileAt(px, py);
      if (!t) return;
      const k = key(t.x, t.y);
      if (this.chosen.has(k)) this.chosen.delete(k);
      else this.chosen.set(k, { x: t.x, y: t.y });
      this.opts.onSelectionChange?.(this.getSelection());
      this.draw();
    } else if (mode === 'pin') {
      if (!this.tileAt(px, py)) return; // punkt musi leżeć na kaflu mapy
      const w = this.worldAt(px, py);
      this.pending = { x: Math.round(w.x * 1000) / 1000, y: Math.round(w.y * 1000) / 1000 };
      this.opts.onPinPlaced?.(this.pending);
      this.draw();
    } else {
      const stop = this.stopAt(px, py);
      if (stop) {
        this.opts.onStopClick?.(stop.stop);
        return;
      }
      if (!this.tileSelect) return;
      const pin = this.pinAt(px, py);
      this.selectedPin = pin;
      this.selectedTile = pin ? null : this.tileAt(px, py);
      this.renderInfo();
      this.draw();
    }
  }

  // --- rysowanie i panele ------------------------------------------------------

  private refresh(): void {
    const noTiles = !this.data || this.data.tiles.length === 0;
    this.emptyMsg.hidden = !noTiles;
    this.emptyMsg.textContent = this.busy
      ? 'Trwa wczytywanie kafli…'
      : 'Brak danych mapy. Skonfiguruj folder roboczy w Ustawieniach albo przeskanuj mapę.';
    this.canvas.style.cursor = this.routeEditing || this.linkMode || this.splineMode || this.opts.mode === 'pin' ? 'crosshair' : this.opts.mode === 'info' ? '' : 'pointer';
    this.hint.textContent = this.splineMode
      ? 'Edycja splinów: klik — zaznacz koniec splinu (Shift — dodaj/odznacz) · G — przesuń · Z — wysokość · N — nowy spline · klik — zatwierdź · Esc / prawy przycisk — anuluj'
      : this.linkMode
      ? 'Łączenia: klik — wybierz pierwszy, potem drugi koniec (węzeł albo dowolny punkt; Ctrl — przyciągaj do węzła) · przeciągnij — przesuwanie · kółko — zoom'
      : this.routeEditing
      ? 'Edycja trasy: klik w ścieżkę ruchu — dodaj odcinek po zaznaczonym · klik w odcinek trasy — zaznacz · Delete — usuń · przeciągnij — przesuwanie · kółko — zoom'
      : this.opts.mode === 'select'
        ? 'Klik — zaznacz/odznacz kafel · przeciągnij — przesuwanie · kółko — zoom'
        : this.opts.mode === 'pin'
          ? 'Kliknij punkt na mapie, aby ustawić pinezkę · przeciągnij — przesuwanie · kółko — zoom'
          : this.tileSelect
            ? 'Przeciągnij — przesuwanie · kółko — zoom · klik — informacje o kaflu lub pinezce'
            : 'Przeciągnij — przesuwanie · kółko — zoom';
    this.renderInfo();
    this.draw();
  }

  private renderInfo(): void {
    clear(this.infoBox);
    const show = this.opts.mode === 'info' && this.tileSelect && (this.selectedTile || this.selectedPin);
    this.infoBox.hidden = !show;
    if (!show) return;
    const row = (k: string, v: string, cls = ''): HTMLElement =>
      h('div', { class: 'map-info-row' }, h('span', { class: 'k' }, k), h('span', { class: `v ${cls}` }, v));
    if (this.selectedPin) {
      const p = this.selectedPin;
      this.infoBox.append(
        h('div', { class: 'map-info-title' }, `📍 ${p.title}`),
        row('Pozycja', `x = ${p.x.toFixed(2)}, y = ${p.y.toFixed(2)}`),
        row('Kafel', `(${Math.round(p.x)}, ${Math.round(p.y)})`),
      );
      return;
    }
    const t = this.selectedTile!;
    this.infoBox.append(
      h('div', { class: 'map-info-title' }, `Kafel (${t.x}, ${t.y})`),
      row('Koordynaty', `x = ${t.x}, y = ${t.y}`),
      row('Plik .map', t.file.split('/').pop() ?? t.file),
      row('Ścieżka', t.file),
      row('Plik na dysku', t.exists ? 'jest' : 'BRAK', t.exists ? '' : 'bad'),
      row('Unikatowe assety', String(t.assetCount)),
      row('Brakujące w OMSI', String(t.missingCount), t.missingCount ? 'bad' : ''),
    );
  }

  private css(name: string, fallback: string): string {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  }

  private pinShape(x: number, y: number, fill: string, stroke: string): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.bezierCurveTo(x - 11, y - 12, x - 9, y - 26, x, y - 26);
    ctx.bezierCurveTo(x + 9, y - 26, x + 11, y - 12, x, y);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = stroke;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y - 17, 3.2, 0, Math.PI * 2);
    ctx.fillStyle = stroke;
    ctx.fill();
  }

  /** Rysuje spliny widocznych kafli jako pasy o szerokości przekroju (w skali mapy; min. 1 px). */
  /**
   * Ścieżka (bez rysowania) pasa splinu między bocznymi odległościami uA i uB od osi, w zakresie t0–t1 długości; końce są
   * ścięte według skew: punkt krawędzi leżący w bocznej odległości u od osi jest przesunięty o skew·u wzdłuż osi
   * (skew0 na początku, skew1 na końcu), dzięki czemu sąsiednie spliny zbiegające się pod kątem łączą się „na ukos”.
   */
  private strip(left: number, top: number, s: number[], uA: number, uB: number, mPx: number, t0 = 0, t1 = 1): void {
    const ctx = this.ctx;
    const [, lx, ly, hdg, len, radius] = s;
    const sk0 = s[8] ?? 0;
    const sk1 = s[9] ?? 0;
    const k = radius !== 0 ? 1 / radius : 0;
    const phi0 = (hdg * Math.PI) / 180;
    const edge = (u: number, forward: boolean, first: boolean): void => {
      const from = sk0 * u;
      const to = len + sk1 * u;
      const a = from + (to - from) * t0;
      const b = from + (to - from) * t1;
      const steps = k === 0 ? 1 : Math.max(1, Math.ceil(Math.abs((b - a) * k) / (Math.PI / 36)));
      for (let i = 0; i <= steps; i++) {
        const sLen = a + ((b - a) * (forward ? i : steps - i)) / steps;
        const phi = phi0 + k * sLen;
        const mx = k === 0 ? Math.sin(phi0) * sLen : (Math.cos(phi0) - Math.cos(phi)) / k;
        const my = k === 0 ? Math.cos(phi0) * sLen : (Math.sin(phi) - Math.sin(phi0)) / k;
        const px = left + (lx + mx + Math.cos(phi) * u) * mPx;
        const py = top + (300 - (ly + my - Math.sin(phi) * u)) * mPx;
        if (first && i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
    };
    ctx.beginPath();
    edge(uA, true, true);
    edge(uB, false, false);
    ctx.closePath();
  }

  /**
   * Nakłada tekstury na pasy profilu .sli: każdy pas to odcinek przekroju z teksturą, współrzędną U na jego krawędziach i skalą V
   * na metr długości; wzór jest dopasowany do kolejnych kawałków łuku (≤ 15°), tak by tekstura podążała za splinem.
   * Współrzędna V liczy się od początku splinu z przesunięciem tekstury (ostatnia liczba wpisu) — ciągła między sąsiednimi splinami.
   */
  private texturedBands(left: number, top: number, s: number[], sli: string, mPx: number): void {
    const prof = this.profileFor(sli);
    if (!prof) return;
    const ctx = this.ctx;
    const [, lx, ly, hdg, len, radius] = s;
    const mirror = !!s[6];
    const texOff = s[10] ?? 0;
    const k = radius !== 0 ? 1 / radius : 0;
    const phi0 = (hdg * Math.PI) / 180;
    const chunks = k === 0 ? 1 : Math.max(1, Math.ceil(Math.abs(len * k) / (Math.PI / 12)));
    for (const band of prof.bands) {
      const entry = this.textureFor(sli, prof.textures[band.tex]);
      const du = band.u1 - band.u0;
      if (!entry || Math.abs(du) < 1e-9) continue;
      const x0 = mirror ? -band.x0 : band.x0;
      const x1 = mirror ? -band.x1 : band.x1;
      const kU = (x1 - x0) / du; // metry na jednostkę U
      // poziom pomniejszenia: teksele na metr tekstury kontra piksele na metr ekranu
      const texelsPerM = Math.max(entry.w / Math.max(Math.abs(kU), 1e-6), entry.h * Math.abs(band.vs));
      let lvl = Math.max(0, Math.min(entry.mips.length - 1, Math.floor(Math.log2(Math.max(1, texelsPerM / mPx)))));
      while (lvl > 0 && !entry.mips[lvl]) lvl--;
      const bmp = entry.mips[lvl];
      if (!bmp) continue;
      const pat = (entry.pats[lvl] ??= ctx.createPattern(bmp, 'repeat'));
      if (!pat) continue;
      const W = bmp.width;
      const H = bmp.height;
      for (let c = 0; c < chunks; c++) {
        if (this.texBudget-- <= 0) return;
        const t0 = c / chunks;
        const t1 = (c + 1) / chunks;
        const sMid = (len * (t0 + t1)) / 2;
        const phi = phi0 + k * sMid;
        const mx = k === 0 ? Math.sin(phi0) * sMid : (Math.cos(phi0) - Math.cos(phi)) / k;
        const my = k === 0 ? Math.cos(phi0) * sMid : (Math.sin(phi) - Math.sin(phi0)) / k;
        const px = left + (lx + mx) * mPx;
        const py = top + (300 - (ly + my)) * mPx;
        pat.setTransform(texturePatternMatrix({ px, py, phi, mPx, u0: band.u0, x0, kU, vs: band.vs, texOff, sMid, W, H }));
        this.strip(left, top, s, x0, x1, mPx, t0, t1);
        ctx.fillStyle = pat;
        ctx.fill();
      }
    }
  }

  private drawSplines(w: number, hh: number): void {
    const data = this.splines;
    if (!data) return;
    const ctx = this.ctx;
    const scale = this.scale;
    const mPx = scale / 300; // pikseli na metr
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'round';
    // widoczne spliny ze wszystkich kafli, rosnąco wg wysokości: wyższe rysujemy później, czyli na wierzchu
    const visible: { left: number; top: number; s: number[] }[] = [];
    for (const t of data.tiles) {
      const left = this.sx(t.x - 0.5, w);
      const top = this.sy(t.y + 0.5, hh);
      if (left + scale < 0 || top + scale < 0 || left > w || top > hh) continue;
      for (const s of t.s) visible.push({ left, top, s });
    }
    visible.sort((p, q) => (p.s[7] ?? 0) - (q.s[7] ?? 0));
    const trace = (left: number, top: number, s: number[], c: number): void => {
      const [, lx, ly, hdg, len, radius] = s;
      const k = radius !== 0 ? 1 / radius : 0; // dodatni promień = skręt w prawo (zgodnie z azymutem)
      const phi0 = (hdg * Math.PI) / 180;
      const steps = k === 0 ? 1 : Math.max(1, Math.ceil(Math.abs(len * k) / (Math.PI / 36)));
      ctx.beginPath();
      for (let i = 0; i <= steps; i++) {
        const sLen = (len * i) / steps;
        const phi = phi0 + k * sLen;
        const mx = k === 0 ? Math.sin(phi0) * sLen : (Math.cos(phi0) - Math.cos(phi)) / k;
        const my = k === 0 ? Math.cos(phi0) * sLen : (Math.sin(phi) - Math.sin(phi0)) / k;
        const px = left + (lx + mx + Math.cos(phi) * c) * mPx;
        const py = top + (300 - (ly + my - Math.sin(phi) * c)) * mPx;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
    };
    const texturesOn = this.layers.textures && scale >= TEX_LOAD_SCALE;
    this.texBudget = scale >= TEX_DRAW_SCALE ? TEX_BUDGET : 0;
    for (const { left, top, s } of this.layers.splines ? visible : []) {
      const road = data.roads[s[0]];
      if (!road) continue;
      if (this.maxWidth > 0 && road.b - road.a > this.maxWidth) continue;
      // poza ekranem (przy dużym zbliżeniu większość splinów kafla): pomijamy
      const rr = (s[4] + (road.b - road.a) + 2) * mPx;
      const x0 = left + s[1] * mPx;
      const y0 = top + (300 - s[2]) * mPx;
      if (x0 + rr < 0 || x0 - rr > w || y0 + rr < 0 || y0 - rr > hh) continue;
      // krawędzie przekroju względem osi splinu (po odbiciu strony się zamieniają)
      const [uA, uB] = s[6] ? [-road.b, -road.a] : [road.a, road.b];
      this.strip(left, top, s, uA, uB, mPx);
      const color = this.flatColor(s[0], road.p, texturesOn);
      ctx.fillStyle = color;
      ctx.fill();
      // cienki kontur tym samym kolorem domyka szczeliny między sąsiednimi pasami (antyaliasing)
      ctx.lineWidth = 0.7;
      ctx.strokeStyle = color;
      ctx.stroke();
      if (this.texBudget > 0 && texturesOn) this.texturedBands(left, top, s, road.p, mPx);
      if ((road.b - road.a) * mPx < 1) {
        // bardzo wąskie pasy (linie) przy małym zbliżeniu: minimalna widoczna szerokość 1 px
        trace(left, top, s, ((road.a + road.b) / 2) * (s[6] ? -1 : 1));
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
    if (this.layers.paths) {
      // ścieżki ruchu nad wszystkimi splinami: jasny kontur + jaskrawa linia
      for (const pass of [0, 1]) {
        ctx.strokeStyle = pass === 0 ? '#ffffff' : '#ff1fd0';
        ctx.lineWidth = pass === 0 ? 3.4 : 1.6;
        for (const { left, top, s } of visible) {
          for (const [x] of data.roads[s[0]]?.t ?? []) {
            trace(left, top, s, x * (s[6] ? -1 : 1));
            ctx.stroke();
          }
        }
      }
      // strzałki kierunku ruchu: kierunek 1 w .sli albo odbicie splinu odwracają go, oba naraz się znoszą
      if (this.scale >= 220) {
        for (const { left, top, s } of visible) {
          const [, lx, ly, hdg, len, radius] = s;
          const lenPx = len * mPx;
          if (lenPx < 28) continue;
          const k = radius !== 0 ? 1 / radius : 0;
          const phi0 = (hdg * Math.PI) / 180;
          const n = Math.max(1, Math.min(8, Math.floor(lenPx / 120)));
          for (const [x, , dir] of data.roads[s[0]]?.t ?? []) {
            const c = x * (s[6] ? -1 : 1);
            const reversed = (dir === 1) !== (s[6] === 1);
            for (let j = 0; j < n; j++) {
              const sLen = (len * (j + 0.5)) / n;
              const phi = phi0 + k * sLen;
              const mx = k === 0 ? Math.sin(phi0) * sLen : (Math.cos(phi0) - Math.cos(phi)) / k;
              const my = k === 0 ? Math.cos(phi0) * sLen : (Math.sin(phi) - Math.sin(phi0)) / k;
              const px = left + (lx + mx + Math.cos(phi) * c) * mPx;
              const py = top + (300 - (ly + my - Math.sin(phi) * c)) * mPx;
              this.arrow(px, py, this.screenAngle(phi) + (reversed ? Math.PI : 0), 6, '#6a005a');
            }
          }
        }
      }
    }
  }

  private draw(): void {
    const ctx = this.ctx;
    const c = this.canvas;
    const w = c.clientWidth;
    const hh = c.clientHeight;
    if (w === 0 || hh === 0) return;
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(hh * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(hh * dpr);
    }
    if (this.needFit) {
      this.fit(); // wywoła draw()
      return;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = this.css('--map-bg', '#5d7fcb');
    ctx.fillRect(0, 0, w, hh);
    if (!this.data) return;

    const fill = this.css('--map-tile', '#f4f2e6');
    const missingFill = this.css('--map-missing', '#ffd9d6');
    const line = this.css('--map-line', '#8a8672');
    const accent = this.css('--accent', '#316ac5');
    const danger = this.css('--danger', '#c4161c');
    const muted = this.css('--map-text', '#4b4a42');
    const scale = this.scale;

    ctx.lineWidth = 1;
    ctx.font = `${Math.max(10, Math.min(15, scale / 5))}px Tahoma, "Segoe UI", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (const t of this.data.tiles) {
      const left = this.sx(t.x - 0.5, w);
      const top = this.sy(t.y + 0.5, hh);
      if (left + scale < 0 || top + scale < 0 || left > w || top > hh) continue;
      const isChosen = this.chosen.has(key(t.x, t.y));
      ctx.fillStyle = t.exists ? fill : missingFill;
      ctx.fillRect(left, top, scale, scale);
      if (isChosen) {
        ctx.fillStyle = accent + '59';
        ctx.fillRect(left, top, scale, scale);
      }
      ctx.strokeStyle = isChosen ? accent : t.exists ? line : danger;
      ctx.strokeRect(Math.round(left) + 0.5, Math.round(top) + 0.5, Math.round(scale) - 1, Math.round(scale) - 1);
      if (scale >= 52) {
        ctx.fillStyle = isChosen ? '#0a246a' : muted;
        ctx.fillText(`${t.x}, ${t.y}`, left + scale / 2, top + scale / 2);
      }
    }

    this.drawSplines(w, hh);
    this.drawObjPaths(w, hh);
    this.drawStops(w, hh);
    this.drawRoute(w, hh);
    this.drawLink(w, hh);
    this.drawSplineEdit(w, hh);

    if (this.selectedTile && this.opts.mode === 'info' && this.tileSelect) {
      const left = this.sx(this.selectedTile.x - 0.5, w);
      const top = this.sy(this.selectedTile.y + 0.5, hh);
      ctx.strokeStyle = accent;
      ctx.lineWidth = 3;
      ctx.strokeRect(left + 1.5, top + 1.5, scale - 3, scale - 3);
    }

    for (const p of this.pins) {
      const isSel = this.selectedPin?.id === p.id;
      this.pinShape(this.sx(p.x, w), this.sy(p.y, hh), isSel ? '#ffd166' : '#f2a33a', '#3b2a05');
    }
    if (this.pending) {
      this.pinShape(this.sx(this.pending.x, w), this.sy(this.pending.y, hh), '#4cb782', '#0d2a1c');
    }
  }
}
