import fs from 'node:fs';
import path from 'node:path';
import type { MapStops } from '../../shared/types.ts';
import { STOP_PARAM_COUNT } from '../../shared/busStop.ts';
import { decodeCfg, encodeCfg, splitLines } from './globalCfg.ts';
import { normalizeAssetPath, safeJoin } from './mapIndex.ts';

export const STOPS_FILE = 'map-stops.json';
export const stopsPath = (workDir: string): string => path.join(workDir, '_vibe', STOPS_FILE);

/** Obiekt z kafla: [object] / 0 / ścieżka / ID / x / y / wysokość / obrót / 0 / 0 / liczba linijek parametrów / parametry… */
export interface RawObject {
  path: string;
  id: string;
  x: number;
  y: number;
  rot: number;
  params: string[];
}

const OBJECT_COUNT_AT = 10; // przesunięcie linijki z liczbą parametrów względem znacznika

export function parseTileObjects(text: string): RawObject[] {
  const lines = splitLines(text);
  const out: RawObject[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().toLowerCase() !== '[object]') continue;
    const p = normalizeAssetPath(lines[i + 2] ?? '');
    const [x, y, rot] = [4, 5, 7].map((o) => Number((lines[i + o] ?? '').trim().replace(',', '.')));
    const count = Number((lines[i + OBJECT_COUNT_AT] ?? '').trim());
    if (!p || ![x, y, rot].every(Number.isFinite)) continue;
    const params = Number.isInteger(count) && count > 0 ? lines.slice(i + OBJECT_COUNT_AT + 1, i + OBJECT_COUNT_AT + 1 + count).map((l) => l.trim()) : [];
    out.push({ path: p, id: (lines[i + 3] ?? '').trim(), x, y, rot, params });
  }
  return out;
}

/** Plik .sco opisuje przystanek, gdy zawiera znacznik [busstop]. */
export const isBusStopSco = (text: string): boolean => /^\s*\[busstop\]\s*$/im.test(text);

export function busStopChecker(assetsRoot: string): (rel: string) => boolean {
  const cache = new Map<string, boolean>();
  return (rel) => {
    const key = rel.toLowerCase();
    let v = cache.get(key);
    if (v === undefined) {
      const f = safeJoin(assetsRoot, rel);
      try {
        v = f ? isBusStopSco(decodeCfg(fs.readFileSync(f)).text) : false;
      } catch {
        v = false;
      }
      cache.set(key, v);
    }
    return v;
  };
}

export interface TileObjects {
  x: number;
  y: number;
  file: string;
  objects: RawObject[];
}

export function buildStopsData(tiles: TileObjects[], isStop: (rel: string) => boolean): MapStops {
  const r2 = (n: number): number => Math.round(n * 100) / 100;
  const out: MapStops = { version: 1, tiles: [] };
  for (const t of tiles) {
    const s = t.objects.filter((o) => isStop(o.path)).map((o) => ({ id: o.id, x: r2(o.x), y: r2(o.y), rot: r2(o.rot), p: o.params.slice(0, STOP_PARAM_COUNT) }));
    if (s.length) out.tiles.push({ x: t.x, y: t.y, file: t.file, s });
  }
  return out;
}

export function loadMapStops(workDir: string): MapStops | null {
  try {
    const d = JSON.parse(fs.readFileSync(stopsPath(workDir), 'utf-8')) as MapStops;
    return d.version === 1 && Array.isArray(d.tiles) ? d : null;
  } catch {
    return null;
  }
}

/**
 * Zapisuje parametry przystanku (obiekt o danym ID) w pliku kafla; reszta pliku i kodowanie zostają.
 * Licznik parametrów jest ustawiany na 7, a ich linijki zastępowane nowymi.
 */
export function saveStopParams(mapDir: string, tileFile: string, id: string, params: string[]): { ok: boolean; error?: string } {
  if (params.length !== STOP_PARAM_COUNT || params.some((p) => /[\r\n]/.test(p))) return { ok: false, error: 'Nieprawidłowe parametry przystanku.' };
  const full = /\.map$/i.test(tileFile) ? safeJoin(mapDir, tileFile) : null;
  if (!full || !fs.existsSync(full)) return { ok: false, error: 'Nie ma takiego pliku kafla w folderze mapy.' };
  const d = decodeCfg(fs.readFileSync(full));
  const lines = splitLines(d.text);
  const at = lines.findIndex((l, i) => l.trim().toLowerCase() === '[object]' && (lines[i + 3] ?? '').trim() === id);
  if (at < 0) return { ok: false, error: `W pliku kafla nie ma obiektu o ID ${id}.` };
  const count = Number((lines[at + OBJECT_COUNT_AT] ?? '').trim());
  if (!Number.isInteger(count) || count < 0) return { ok: false, error: 'Nierozpoznany układ wpisu obiektu.' };
  lines.splice(at + OBJECT_COUNT_AT, 1 + count, String(STOP_PARAM_COUNT), ...params);
  const eol = d.text.includes('\r\n') ? '\r\n' : '\n';
  fs.writeFileSync(full, encodeCfg(lines.join(eol), d.encoding, d.bom));
  return { ok: true };
}

/** Odświeża wpis przystanku w map-stops.json po zapisie (bez ponownego skanowania mapy). */
export function updateStopsCache(workDir: string, tileFile: string, id: string, params: string[]): void {
  const data = loadMapStops(workDir);
  if (!data) return;
  const stop = data.tiles.find((t) => t.file === tileFile)?.s.find((s) => s.id === id);
  if (!stop) return;
  stop.p = params;
  fs.writeFileSync(stopsPath(workDir), JSON.stringify(data), 'utf-8');
}
