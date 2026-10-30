import fs from 'node:fs';
import path from 'node:path';
import type { MapSplines } from '../../shared/types.ts';
import { decodeCfg, splitLines } from './globalCfg.ts';
import { normalizeAssetPath, safeJoin } from './mapIndex.ts';

export const SPLINES_FILE = 'map-splines.json';
export const splinesPath = (workDir: string): string => path.join(workDir, '_vibe', SPLINES_FILE);

/** Domyślny zakres przekroju (m), gdy nie da się odczytać .sli. */
export const DEFAULT_EXTENT: [number, number] = [-3, 3];

/** Jeden spline z kafla; pozycja lokalna w metrach (0..300, początek w rogu kafla), azymut w stopniach od północy. */
export interface RawSpline {
  path: string;
  x: number;
  y: number;
  heading: number;
  /** Wysokość początku splinu (m n.p.m. wg mapy) — im wyżej, tym spline jest na mapie bardziej na wierzchu. */
  z: number;
  length: number;
  /** Promień łuku (m); 0 = prosta. */
  radius: number;
  mirror: boolean;
}

/**
 * Układ wpisu [spline] / [spline_h] w .map (linijki po znaczniku):
 * 0 zawsze 0 · 1 ścieżka .sli · 2-4 ID własne / poprzedni / następny · 5 x · 6 wysokość · 7 y ·
 * 8 azymut (° od północy, zgodnie z ruchem wskazówek zegara) · 9 długość · 10 promień (0 = prosta) ·
 * dalej parametry pionowe itp.; na końcu bywa słowo „mirror” (profil odbity).
 */
export function parseTileSplines(text: string): RawSpline[] {
  const out: RawSpline[] = [];
  let rec: string[] | null = null;
  const flush = (): void => {
    if (!rec || rec.length < 11) return;
    const p = normalizeAssetPath(rec[1]);
    const [x, y, heading, length, radius] = [5, 7, 8, 9, 10].map((i) => Number(rec![i].replace(',', '.')));
    const z = Number(rec![6].replace(',', '.'));
    if (!p || ![x, y, heading, length, radius].every(Number.isFinite) || length <= 0) return;
    out.push({ path: p, x, y, z: Number.isFinite(z) ? z : 0, heading, length, radius, mirror: rec.slice(11).some((l) => l.toLowerCase() === 'mirror') });
  };
  for (const line of splitLines(text)) {
    const t = line.trim();
    if (t.startsWith('[')) {
      flush();
      const m = t.toLowerCase();
      rec = m === '[spline]' || m === '[spline_h]' ? [] : null;
    } else if (rec && t) {
      rec.push(t);
    }
  }
  flush();
  return out;
}

/**
 * Ścieżki ruchu z pliku .sli ([path]: typ, X środka, wysokość, szerokość, kierunek) jako krotki
 * [x, typ, kierunek]; typ: 0 pojazdy drogowe, 1 piesi, 2 szynowe, 3 powietrzne.
 */
export function sliPaths(text: string): number[][] {
  const lines = splitLines(text);
  const out: number[][] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().toLowerCase() !== '[path]') continue;
    const v: number[] = [];
    for (let j = i + 1; j < lines.length && v.length < 5; j++) {
      const t = lines[j].trim();
      if (t.startsWith('[')) break;
      if (t) v.push(Number(t.replace(',', '.')));
    }
    if (v.length >= 5 && v.every(Number.isFinite)) out.push([Math.round(v[1] * 1000) / 1000, v[0], v[4]]);
  }
  return out;
}

/** Zakres X (min, max) wszystkich punktów [profilepnt] w pliku .sli; null, gdy brak punktów. */
export function sliExtent(text: string): [number, number] | null {
  const lines = splitLines(text);
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().toLowerCase() !== '[profilepnt]') continue;
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j].trim();
      if (t.startsWith('[')) break;
      if (!t) continue;
      const v = Number(t.replace(',', '.'));
      if (Number.isFinite(v)) {
        min = Math.min(min, v);
        max = Math.max(max, v);
      }
      break;
    }
  }
  return min <= max ? [min, max] : null;
}

export interface TileSplines {
  x: number;
  y: number;
  splines: RawSpline[];
}

/** Składa zwarty plik: lista dróg z zakresem przekroju + spliny kafli jako krotki liczb. */
export function buildSplinesData(
  tiles: TileSplines[],
  extentOf: (rel: string) => [number, number] | null,
  pathsOf: (rel: string) => number[][] = () => [],
): MapSplines {
  const idx = new Map<string, number>();
  const roads: MapSplines['roads'] = [];
  const outTiles: MapSplines['tiles'] = [];
  const r3 = (n: number): number => Math.round(n * 1000) / 1000;
  for (const t of tiles) {
    if (t.splines.length === 0) continue;
    const s: number[][] = [];
    for (const sp of t.splines) {
      const key = sp.path.toLowerCase();
      let i = idx.get(key);
      if (i === undefined) {
        const e = extentOf(sp.path) ?? DEFAULT_EXTENT;
        const t = pathsOf(sp.path);
        i = roads.push({ p: sp.path, a: r3(e[0]), b: r3(e[1]), ...(t.length ? { t } : {}) }) - 1;
        idx.set(key, i);
      }
      s.push([i, r3(sp.x), r3(sp.y), r3(sp.heading), r3(sp.length), r3(sp.radius), sp.mirror ? 1 : 0, r3(sp.z)]);
    }
    outTiles.push({ x: t.x, y: t.y, s });
  }
  return { version: 1, roads, tiles: outTiles };
}

/** Czyta zakresy przekroju z kopii plików .sli w _vibe/assets. */
export function extentFromAssets(assetsRoot: string): (rel: string) => [number, number] | null {
  return (rel) => {
    const f = safeJoin(assetsRoot, rel);
    if (!f) return null;
    try {
      return sliExtent(decodeCfg(fs.readFileSync(f)).text);
    } catch {
      return null;
    }
  };
}

/** Czyta ścieżki ruchu z kopii plików .sli w _vibe/assets. */
export function pathsFromAssets(assetsRoot: string): (rel: string) => number[][] {
  return (rel) => {
    const f = safeJoin(assetsRoot, rel);
    if (!f) return [];
    try {
      return sliPaths(decodeCfg(fs.readFileSync(f)).text);
    } catch {
      return [];
    }
  };
}

export function loadMapSplines(workDir: string): MapSplines | null {
  try {
    const d = JSON.parse(fs.readFileSync(splinesPath(workDir), 'utf-8')) as MapSplines;
    return d.version === 1 && Array.isArray(d.tiles) ? d : null;
  } catch {
    return null;
  }
}
