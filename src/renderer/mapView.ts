import type { MapOverview, MapTileView } from '../shared/types.ts';
import { clear, h } from './dom.ts';

/**
 * Siatka kafli: kafel (x, y) to kwadrat o boku 1 wycentrowany w punkcie (x, y);
 * oś Y rośnie w górę ekranu (północ u góry), jak na mapie OMSI.
 */

const MIN_SCALE = 3;
const MAX_SCALE = 400;
const DRAG_THRESHOLD = 4;

interface Actions {
  rescan: () => void;
}

let actions: Actions;
let canvas: HTMLCanvasElement;
let ctx: CanvasRenderingContext2D;
let infoBox: HTMLElement;
let summary: HTMLElement;
let emptyMsg: HTMLElement;
let rescanBtn: HTMLButtonElement;

let data: MapOverview | null = null;
let busy = false;
let selected: MapTileView | null = null;
let signature = '';
let needFit = false;

// widok: środek ekranu w jednostkach kafli + skala w pikselach na kafel
let cx = 0;
let cy = 0;
let scale = 40;

export function mountMap(root: HTMLElement, a: Actions): void {
  actions = a;
  clear(root);

  rescanBtn = h('button', { class: 'btn', onClick: () => actions.rescan() }, 'Przeskanuj mapę ponownie');
  summary = h('span', { class: 'status' });
  const fitBtn = h('button', { class: 'btn', onClick: () => fitToMap() }, 'Wycentruj');
  canvas = h('canvas', { class: 'map-canvas' });
  infoBox = h('div', { class: 'map-info' });
  infoBox.hidden = true;
  emptyMsg = h('div', { class: 'map-empty' });
  const hint = h('div', { class: 'map-hint' }, 'Przeciągnij — przesuwanie · kółko — zoom · klik — informacje o kaflu');

  root.append(
    h('div', { class: 'toolbar' }, fitBtn, rescanBtn, h('div', { class: 'spacer' }), summary),
    h('div', { class: 'map-wrap' }, canvas, infoBox, emptyMsg, hint),
  );
  ctx = canvas.getContext('2d')!;

  new ResizeObserver(() => draw()).observe(canvas);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('pointerdown', onPointerDown);
  render();
}

/** Nowe dane z indeksu (null = mapa jeszcze nie zindeksowana). */
export function setMapData(overview: MapOverview | null): void {
  data = overview;
  const sig = overview ? overview.tiles.map((t) => `${t.x},${t.y}`).join(';') : '';
  if (sig !== signature) {
    signature = sig;
    needFit = true;
  }
  if (selected) {
    selected = overview?.tiles.find((t) => t.x === selected!.x && t.y === selected!.y) ?? null;
  }
  render();
}

export function setMapBusy(value: boolean): void {
  busy = value;
  render();
}

/** Wywoływane po przełączeniu na zakładkę (wcześniej canvas ma rozmiar 0). */
export function showMap(): void {
  draw();
}

// --- logika widoku ---------------------------------------------------------

function fitToMap(): void {
  const w = canvas.clientWidth;
  const hgt = canvas.clientHeight;
  if (!data || data.tiles.length === 0 || w === 0 || hgt === 0) return;
  const xs = data.tiles.map((t) => t.x);
  const ys = data.tiles.map((t) => t.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  // środek mapy (nie punkt 0, 0)
  cx = (minX + maxX) / 2;
  cy = (minY + maxY) / 2;
  const fit = Math.min(w / (maxX - minX + 3), hgt / (maxY - minY + 3));
  scale = Math.max(MIN_SCALE, Math.min(120, fit));
  needFit = false;
  draw();
}

const toScreenX = (x: number, w: number): number => w / 2 + (x - 0.5 - cx) * scale;
const toScreenY = (y: number, hgt: number): number => hgt / 2 - (y + 0.5 - cy) * scale;

function tileAt(px: number, py: number): MapTileView | null {
  if (!data) return null;
  const wx = cx + (px - canvas.clientWidth / 2) / scale;
  const wy = cy - (py - canvas.clientHeight / 2) / scale;
  const tx = Math.round(wx);
  const ty = Math.round(wy);
  return data.tiles.find((t) => t.x === tx && t.y === ty) ?? null;
}

function onWheel(e: WheelEvent): void {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  const px = e.clientX - r.left;
  const py = e.clientY - r.top;
  const w = canvas.clientWidth;
  const hgt = canvas.clientHeight;
  const wx = cx + (px - w / 2) / scale;
  const wy = cy - (py - hgt / 2) / scale;
  scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale * Math.exp(-e.deltaY * 0.0015)));
  cx = wx - (px - w / 2) / scale;
  cy = wy + (py - hgt / 2) / scale;
  draw();
}

function onPointerDown(e: PointerEvent): void {
  if (e.button !== 0) return;
  const startX = e.clientX;
  const startY = e.clientY;
  let lastX = startX;
  let lastY = startY;
  let moved = false;
  canvas.setPointerCapture(e.pointerId);

  const move = (ev: PointerEvent): void => {
    if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD) return;
    moved = true;
    cx -= (ev.clientX - lastX) / scale;
    cy += (ev.clientY - lastY) / scale;
    lastX = ev.clientX;
    lastY = ev.clientY;
    canvas.classList.add('dragging');
    draw();
  };
  const up = (ev: PointerEvent): void => {
    canvas.removeEventListener('pointermove', move);
    canvas.removeEventListener('pointerup', up);
    canvas.removeEventListener('pointercancel', up);
    canvas.classList.remove('dragging');
    if (!moved && ev.type === 'pointerup') {
      const r = canvas.getBoundingClientRect();
      selected = tileAt(ev.clientX - r.left, ev.clientY - r.top);
      render();
    }
  };
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
}

// --- rysowanie i panele ----------------------------------------------------

function render(): void {
  if (!canvas) return;
  rescanBtn.disabled = busy;
  summary.textContent = busy
    ? 'Indeksowanie mapy i kopiowanie assetów…'
    : data
      ? `Kafli: ${data.tiles.length} · assetów: ${data.assetCount}` +
        (data.missingCount ? ` (brak w OMSI: ${data.missingCount})` : '')
      : '';

  const noTiles = !data || data.tiles.length === 0;
  emptyMsg.hidden = !noTiles;
  emptyMsg.textContent = busy
    ? 'Trwa wczytywanie kafli…'
    : 'Brak danych mapy. Skonfiguruj folder roboczy w Ustawieniach albo przeskanuj mapę.';

  renderInfo();
  draw();
}

function renderInfo(): void {
  clear(infoBox);
  infoBox.hidden = !selected;
  if (!selected) return;
  const t = selected;
  const row = (k: string, v: string, cls = ''): HTMLElement =>
    h('div', { class: 'map-info-row' }, h('span', { class: 'k' }, k), h('span', { class: `v ${cls}` }, v));
  infoBox.append(
    h('div', { class: 'map-info-title' }, `Kafel (${t.x}, ${t.y})`),
    row('Koordynaty', `x = ${t.x}, y = ${t.y}`),
    row('Plik .map', t.file.split('/').pop() ?? t.file),
    row('Ścieżka', t.file),
    row('Plik na dysku', t.exists ? 'jest' : 'BRAK', t.exists ? '' : 'bad'),
    row('Unikatowe assety', String(t.assetCount)),
    row('Brakujące w OMSI', String(t.missingCount), t.missingCount ? 'bad' : ''),
  );
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function draw(): void {
  if (!ctx) return;
  const w = canvas.clientWidth;
  const hgt = canvas.clientHeight;
  if (w === 0 || hgt === 0) return;
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hgt * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(hgt * dpr);
  }
  if (needFit) {
    fitToMap();
    return; // fitToMap wywoła draw()
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0f1115';
  ctx.fillRect(0, 0, w, hgt);
  if (!data) return;

  const fill = cssVar('--panel-2') || '#262a33';
  const line = '#4a5160';
  const accent = cssVar('--accent') || '#5b8def';
  const danger = cssVar('--danger') || '#e5646b';
  const text = cssVar('--muted') || '#8b93a1';

  ctx.lineWidth = 1;
  ctx.font = `${Math.max(10, Math.min(15, scale / 5))}px "Segoe UI", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (const t of data.tiles) {
    const left = toScreenX(t.x, w);
    const top = toScreenY(t.y, hgt);
    if (left + scale < 0 || top + scale < 0 || left > w || top > hgt) continue;
    ctx.fillStyle = t.exists ? fill : '#3a2226';
    ctx.fillRect(left, top, scale, scale);
    ctx.strokeStyle = t.exists ? line : danger;
    ctx.strokeRect(Math.round(left) + 0.5, Math.round(top) + 0.5, Math.round(scale) - 1, Math.round(scale) - 1);
    if (scale >= 52) {
      ctx.fillStyle = text;
      ctx.fillText(`${t.x}, ${t.y}`, left + scale / 2, top + scale / 2);
    }
  }

  if (selected) {
    const left = toScreenX(selected.x, w);
    const top = toScreenY(selected.y, hgt);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 3;
    ctx.strokeRect(left + 1.5, top + 1.5, scale - 3, scale - 3);
  }
}
