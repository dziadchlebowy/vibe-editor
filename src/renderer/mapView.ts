import { toParams } from '../shared/busStop.ts';
import type { MapObjPaths, MapOverview, MapSplines, MapStops, MapTileView, RouteSegment, TaskPin, TileCoord, TripRoute } from '../shared/types.ts';
import { clear, h } from './dom.ts';

/**
 * Siatka kafli (canvas): kafel (x, y) to kwadrat o boku 1 wycentrowany w punkcie (x, y);
 * oś Y rośnie w górę ekranu (północ u góry), jak na mapie OMSI. Jedna klasa obsługuje zakładkę Mapa
 * oraz okienka wyboru kafli / punktu pinezki.
 */

const MIN_SCALE = 3;
const MAX_SCALE = 6000; // px na kafel (300 m): 6000 → 20 px na metr
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
  private layers = { paths: false, stops: false, splines: true };
  private maxWidth = 0;
  private objPaths: MapObjPaths | null = null;
  private stops: MapStops | null = null;
  private route: TripRoute | null = null;
  private routeEditing = false;
  private routeSelected: number | null = null;
  private routeHover: RouteSegment[] = [];
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
  setLayers(l: { paths: boolean; stops: boolean; splines: boolean }): void {
    this.layers = { ...l };
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
    if (this.routeEditing) {
      // strzałki kierunku jazdy w środku każdego odcinka; początek i koniec zaznaczonego odcinka
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

  private centerOn(x: number, y: number): void {
    this.cx = x;
    this.cy = y;
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
        this.click(ev.clientX - r.left, ev.clientY - r.top);
      }
    };
    c.addEventListener('pointermove', move);
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
  }

  private click(px: number, py: number): void {
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
    this.canvas.style.cursor = this.routeEditing || this.opts.mode === 'pin' ? 'crosshair' : this.opts.mode === 'info' ? '' : 'pointer';
    this.hint.textContent = this.routeEditing
      ? 'Edycja trasy: klik w ścieżkę ruchu — dodaj odcinek po zaznaczonym · klik w odcinek trasy — zaznacz · Delete — usuń · przeciągnij — przesuwanie · kółko — zoom'
      : this.opts.mode === 'select'
        ? 'Klik — zaznacz/odznacz kafel · przeciągnij — przesuwanie · kółko — zoom'
        : this.opts.mode === 'pin'
          ? 'Kliknij punkt na mapie, aby ustawić pinezkę · przeciągnij — przesuwanie · kółko — zoom'
          : 'Przeciągnij — przesuwanie · kółko — zoom · klik — informacje o kaflu lub pinezce';
    this.renderInfo();
    this.draw();
  }

  private renderInfo(): void {
    clear(this.infoBox);
    const show = this.opts.mode === 'info' && (this.selectedTile || this.selectedPin);
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
    for (const { left, top, s } of this.layers.splines ? visible : []) {
      const road = data.roads[s[0]];
      if (!road) continue;
      if (this.maxWidth > 0 && road.b - road.a > this.maxWidth) continue;
      // środek przekroju względem osi splinu (po odbiciu zmienia stronę)
      trace(left, top, s, ((road.a + road.b) / 2) * (s[6] ? -1 : 1));
      ctx.strokeStyle = this.roadColors[s[0]] ?? '#444';
      ctx.lineWidth = Math.max(1, (road.b - road.a) * mPx);
      ctx.stroke();
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

    if (this.selectedTile && this.opts.mode === 'info') {
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
