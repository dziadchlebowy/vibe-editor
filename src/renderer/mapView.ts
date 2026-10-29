import type { MapOverview, MapSplines, MapTileView, TaskPin, TileCoord } from '../shared/types.ts';
import { clear, h } from './dom.ts';

/**
 * Siatka kafli (canvas): kafel (x, y) to kwadrat o boku 1 wycentrowany w punkcie (x, y);
 * oś Y rośnie w górę ekranu (północ u góry), jak na mapie OMSI. Jedna klasa obsługuje zakładkę Mapa
 * oraz okienka wyboru kafli / punktu pinezki.
 */

const MIN_SCALE = 3;
const MAX_SCALE = 400;
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
    this.el = h('div', { class: 'map-wrap' }, this.canvas, this.infoBox, this.emptyMsg, this.hint);
    this.ctx = this.canvas.getContext('2d')!;

    new ResizeObserver(() => this.draw()).observe(this.canvas);
    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
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
    this.canvas.style.cursor = this.opts.mode === 'info' ? '' : this.opts.mode === 'pin' ? 'crosshair' : 'pointer';
    this.hint.textContent =
      this.opts.mode === 'select'
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
    for (const t of data.tiles) {
      const left = this.sx(t.x - 0.5, w);
      const top = this.sy(t.y + 0.5, hh);
      if (left + scale < 0 || top + scale < 0 || left > w || top > hh) continue;
      for (const [ri, lx, ly, hdg, len, radius, mirror] of t.s) {
        const road = data.roads[ri];
        if (!road) continue;
        // środek przekroju względem osi splinu (po odbiciu zmienia stronę)
        const c = ((road.a + road.b) / 2) * (mirror ? -1 : 1);
        const k = radius !== 0 ? 1 / radius : 0; // dodatni promień = skręt w prawo (zgodnie z azymutem)
        const phi0 = (hdg * Math.PI) / 180;
        const steps = k === 0 ? 1 : Math.max(1, Math.ceil(Math.abs(len * k) / (Math.PI / 36)));
        ctx.beginPath();
        for (let i = 0; i <= steps; i++) {
          const sLen = (len * i) / steps;
          const phi = phi0 + k * sLen;
          const mx = k === 0 ? Math.sin(phi0) * sLen : (Math.cos(phi0) - Math.cos(phi)) / k;
          const my = k === 0 ? Math.cos(phi0) * sLen : (Math.sin(phi) - Math.sin(phi0)) / k;
          const ex = lx + mx + Math.cos(phi) * c;
          const ey = ly + my - Math.sin(phi) * c;
          const px = left + ex * mPx;
          const py = top + (300 - ey) * mPx;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.strokeStyle = this.roadColors[ri] ?? '#444';
        ctx.lineWidth = Math.max(1, (road.b - road.a) * mPx);
        ctx.stroke();
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
