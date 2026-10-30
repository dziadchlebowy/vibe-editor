import fs from 'node:fs';
import path from 'node:path';
import type { MapObjPaths } from '../../shared/types.ts';
import { decodeCfg, splitLines } from './globalCfg.ts';
import { safeJoin } from './mapIndex.ts';
import type { TileObjects } from './mapStops.ts';

export const OBJPATHS_FILE = 'map-objpaths.json';
export const objPathsFile = (workDir: string): string => path.join(workDir, '_vibe', OBJPATHS_FILE);

/**
 * Ścieżki ruchu z pliku obiektu (.sco): znacznik [path], pod nim linijki:
 * x, y, wysokość, azymut (° od północy, zgodnie z zegarem), promień łuku (0 = prosta; ujemny = w lewo), długość…
 * (dalej m.in. szerokość 2.5 i flagi). Zwraca krotki [x, y, azymut, promień, długość] w układzie obiektu.
 */
export function scoPaths(text: string): number[][] {
  const lines = splitLines(text);
  const out: number[][] = [];
  const r = (n: number): number => Math.round(n * 1000) / 1000;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().toLowerCase() !== '[path]') continue;
    const v: number[] = [];
    for (let j = i + 1; j < lines.length && v.length < 6; j++) {
      const t = lines[j].trim();
      if (t.startsWith('[')) break;
      if (t) v.push(Number(t.replace(',', '.')));
    }
    if (v.length === 6 && v.every(Number.isFinite) && v[5] > 0) out.push([r(v[0]), r(v[1]), r(v[3]), r(v[4]), r(v[5])]);
  }
  return out;
}

export function scoPathsFromAssets(assetsRoot: string): (rel: string) => number[][] {
  const cache = new Map<string, number[][]>();
  return (rel) => {
    const key = rel.toLowerCase();
    let v = cache.get(key);
    if (!v) {
      const f = safeJoin(assetsRoot, rel);
      try {
        v = f ? scoPaths(decodeCfg(fs.readFileSync(f)).text) : [];
      } catch {
        v = [];
      }
      cache.set(key, v);
    }
    return v;
  };
}

/** Obiekty z kafli, których pliki .sco mają ścieżki: definicje (wspólne) + rozmieszczenie na kaflach. */
export function buildObjPathsData(tiles: TileObjects[], pathsOf: (rel: string) => number[][]): MapObjPaths {
  const defIdx = new Map<string, number>();
  const defs: MapObjPaths['defs'] = [];
  const out: MapObjPaths['tiles'] = [];
  const r2 = (n: number): number => Math.round(n * 100) / 100;
  for (const t of tiles) {
    const o: number[][] = [];
    for (const obj of t.objects) {
      const key = obj.path.toLowerCase();
      let i = defIdx.get(key);
      if (i === undefined) {
        const p = pathsOf(obj.path);
        i = p.length ? defs.push({ p: obj.path, t: p }) - 1 : -1;
        defIdx.set(key, i);
      }
      if (i >= 0) o.push([i, r2(obj.x), r2(obj.y), r2(obj.rot)]);
    }
    if (o.length) out.push({ x: t.x, y: t.y, o });
  }
  return { version: 1, defs, tiles: out };
}

export function loadObjPaths(workDir: string): MapObjPaths | null {
  try {
    const d = JSON.parse(fs.readFileSync(objPathsFile(workDir), 'utf-8')) as MapObjPaths;
    return d.version === 1 && Array.isArray(d.tiles) ? d : null;
  } catch {
    return null;
  }
}
