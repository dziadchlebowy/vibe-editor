import fs from 'node:fs';
import path from 'node:path';
import type { MapStops, TripFile, TripRoute } from '../../shared/types.ts';
import { decodeCfg, splitLines } from './globalCfg.ts';
import { assetsDir, parseTiles, safeJoin, type TileRef } from './mapIndex.ts';
import { loadMapStops, parseTileObjects, type RawObject } from './mapStops.ts';
import { parseTileSplines, type RawSpline } from './mapSplines.ts';
import { parseTrip } from './timetable.ts';

/**
 * Wpis [track_entry] z pliku .ttr (kolejne linijki po znaczniku):
 * ID splinu albo obiektu · numer ścieżki ruchu w jego pliku (.sli / .sco) · indeks kafla ([map] w global.cfg) ·
 * numer elementu na kaflu · długość (m) · flaga (w próbce zawsze 0).
 */
export interface TrackEntry {
  id: string;
  /** Numer ścieżki ([path]) w pliku .sli albo .sco, od 0. */
  pathIndex: number;
  /** Indeks kafla w kolejności [map] z global.cfg. */
  tile: number;
  length: number;
}

export function parseTtr(text: string): TrackEntry[] {
  const lines = splitLines(text);
  const out: TrackEntry[] = [];
  const n = (s: string | undefined): number => Number((s ?? '').trim().replace(',', '.'));
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().toLowerCase() !== '[track_entry]') continue;
    const id = (lines[i + 1] ?? '').trim();
    const pathIndex = n(lines[i + 2]);
    const tile = n(lines[i + 3]);
    const length = n(lines[i + 5]);
    if (!id || !Number.isInteger(pathIndex) || !Number.isInteger(tile)) continue;
    out.push({ id, pathIndex, tile, length: Number.isFinite(length) ? length : 0 });
  }
  return out;
}

// --- ścieżki ruchu z .sli / .sco (n-ta ścieżka w pliku, licząc wszystkie znaczniki [path]) -------------

function nthPathValues(text: string, n: number, count: number): number[] | null {
  const lines = splitLines(text);
  let seen = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().toLowerCase() !== '[path]') continue;
    if (++seen !== n) continue;
    const v: number[] = [];
    for (let j = i + 1; j < lines.length && v.length < count; j++) {
      const t = lines[j].trim();
      if (t.startsWith('[')) break;
      if (t) v.push(Number(t.replace(',', '.')));
    }
    return v.length === count && v.every(Number.isFinite) ? v : null;
  }
  return null;
}

/** Przesunięcie boczne (m) n-tej ścieżki z .sli (X środka ścieżki); null, gdy nie da się odczytać. */
export const sliPathOffset = (text: string, n: number): number | null => nthPathValues(text, n, 5)?.[1] ?? null;

/** n-ta ścieżka z .sco: x, y, azymut °, promień m (0 = prosta), długość m — w układzie obiektu. */
export function scoPathAt(text: string, n: number): { x: number; y: number; hdg: number; radius: number; len: number } | null {
  const v = nthPathValues(text, n, 6);
  return v && v[5] > 0 ? { x: v[0], y: v[1], hdg: v[3], radius: v[4], len: v[5] } : null;
}

// --- geometria (te same wzory co rysowanie splinów i ścieżek obiektów na mapie) -----------------------

type Pt = [number, number]; // metry lokalne kafla, Y na północ

/** Punkty łuku/prostej: start (x, y), azymut °, promień (0 = prosta), długość, boczne przesunięcie c. */
export function arcPoints(x: number, y: number, hdg: number, radius: number, len: number, c: number): Pt[] {
  const k = radius !== 0 ? 1 / radius : 0;
  const phi0 = (hdg * Math.PI) / 180;
  const steps = k === 0 ? 1 : Math.max(1, Math.ceil(Math.abs(len * k) / (Math.PI / 36)));
  const pts: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const s = (len * i) / steps;
    const phi = phi0 + k * s;
    const mx = k === 0 ? Math.sin(phi0) * s : (Math.cos(phi0) - Math.cos(phi)) / k;
    const my = k === 0 ? Math.cos(phi0) * s : (Math.sin(phi) - Math.sin(phi0)) / k;
    pts.push([x + mx + Math.cos(phi) * c, y + my - Math.sin(phi) * c]);
  }
  return pts;
}

/** Ścieżka obiektu: punkty w układzie obiektu obrócone o `rot` ° i przesunięte do pozycji (ox, oy). */
export function objectPathPoints(p: { x: number; y: number; hdg: number; radius: number; len: number }, ox: number, oy: number, rot: number): Pt[] {
  const r = (rot * Math.PI) / 180;
  const cr = Math.cos(r);
  const sr = Math.sin(r);
  return arcPoints(p.x, p.y, p.hdg, p.radius, p.len, 0).map(([lx, ly]) => [ox + lx * cr + ly * sr, oy - lx * sr + ly * cr]);
}

// --- składanie trasy --------------------------------------------------------------------------------

interface TileData {
  ref: TileRef;
  splines: Map<string, RawSpline>;
  objects: Map<string, RawObject>;
}

export interface RouteSources {
  tiles: TileRef[];
  /** Tekst pliku kafla (.map) albo null. */
  readTile(rel: string): string | null;
  /** Tekst pliku .sli / .sco (kopia z _vibe/assets) albo null. */
  readAsset(rel: string): string | null;
  stops: MapStops | null;
}

const toWorld = (t: TileRef, p: Pt): [number, number] => [t.x - 0.5 + p[0] / 300, t.y - 0.5 + p[1] / 300];

export function buildTripRoute(trip: TripFile, entries: TrackEntry[], src: RouteSources): TripRoute {
  const cache = new Map<number, TileData | null>();
  const load = (idx: number): TileData | null => {
    if (cache.has(idx)) return cache.get(idx) ?? null;
    const ref = src.tiles[idx];
    let data: TileData | null = null;
    const text = ref ? src.readTile(ref.file) : null;
    if (ref && text !== null) {
      data = {
        ref,
        splines: new Map(parseTileSplines(text).map((s) => [s.id, s])),
        objects: new Map(parseTileObjects(text).map((o) => [o.id, o])),
      };
    }
    cache.set(idx, data);
    return data;
  };

  const lines: number[][] = [];
  let unresolved = 0;
  for (const e of entries) {
    // najpierw kafel wskazany w .ttr; gdyby ID tam nie było, szukamy go w pozostałych kaflach
    let hit = load(e.tile);
    if (!hit || (!hit.splines.has(e.id) && !hit.objects.has(e.id))) {
      hit = null;
      for (let i = 0; i < src.tiles.length && !hit; i++) {
        const d = load(i);
        if (d && (d.splines.has(e.id) || d.objects.has(e.id))) hit = d;
      }
    }
    if (!hit) {
      unresolved++;
      continue;
    }
    let pts: Pt[] | null = null;
    const sp = hit.splines.get(e.id);
    const ob = hit.objects.get(e.id);
    if (sp) {
      const sli = src.readAsset(sp.path);
      const off = (sli !== null ? sliPathOffset(sli, e.pathIndex) : null) ?? 0;
      pts = arcPoints(sp.x, sp.y, sp.heading, sp.radius, sp.length, off * (sp.mirror ? -1 : 1));
    } else if (ob) {
      const sco = src.readAsset(ob.path);
      const p = sco !== null ? scoPathAt(sco, e.pathIndex) : null;
      pts = p ? objectPathPoints(p, ob.x, ob.y, ob.rot) : null;
    }
    if (!pts) {
      unresolved++;
      continue;
    }
    lines.push(pts.flatMap((p) => toWorld(hit!.ref, p)));
  }

  // przystanki kursu: po ID obiektu ([station] w .ttp), awaryjnie po nazwie i najbliżej trasy
  const stops: TripRoute['stops'] = [];
  const missingStops: string[] = [];
  const byId = new Map<string, { x: number; y: number }>();
  const byName = new Map<string, { x: number; y: number }[]>();
  for (const t of src.stops?.tiles ?? []) {
    for (const s of t.s) {
      const w = toWorld(t, [s.x, s.y]);
      byId.set(s.id, { x: w[0], y: w[1] });
      const k = (s.p[0] ?? '').trim().toLowerCase();
      if (k) byName.set(k, [...(byName.get(k) ?? []), { x: w[0], y: w[1] }]);
    }
  }
  trip.stations.forEach((st, i) => {
    let pos = byId.get(st.id);
    if (!pos) {
      const c = byName.get(st.name.trim().toLowerCase()) ?? [];
      pos = c.sort((a, b) => distToRoute(a, lines) - distToRoute(b, lines))[0];
    }
    if (pos) stops.push({ n: i + 1, name: st.name, x: pos.x, y: pos.y });
    else missingStops.push(st.name);
  });

  return { trip: trip.name, lines, stops, entries: entries.length, unresolved, missingStops };
}

/** Odległość punktu (jednostki kafli) od najbliższego wierzchołka trasy — wystarcza do wyboru spośród kilku przystanków o tej samej nazwie. */
function distToRoute(p: { x: number; y: number }, lines: number[][]): number {
  let best = Infinity;
  for (const l of lines) {
    for (let i = 0; i < l.length; i += 2) best = Math.min(best, (l[i] - p.x) ** 2 + (l[i + 1] - p.y) ** 2);
  }
  return best;
}

// --- dysk -------------------------------------------------------------------------------------------

/** Wczytuje trasę kursu (.ttr obok pliku .ttp) i składa ją z kafli mapy. */
export function loadTripRoute(workDir: string, mapDir: string, tripFileRel: string): TripRoute {
  const empty = (error: string): TripRoute => ({ trip: path.basename(tripFileRel).replace(/\.ttp$/i, ''), lines: [], stops: [], entries: 0, unresolved: 0, missingStops: [], error });
  const ttpFull = /\.ttp$/i.test(tripFileRel) ? safeJoin(mapDir, tripFileRel) : null;
  if (!ttpFull || !fs.existsSync(ttpFull)) return empty('Nie ma takiego kursu w folderze mapy.');
  const ttrFull = ttpFull.replace(/\.ttp$/i, '.ttr');
  if (!fs.existsSync(ttrFull)) return empty('Obok kursu nie ma pliku .ttr z trasą.');
  const cfgName = fs.readdirSync(mapDir).find((f) => f.toLowerCase() === 'global.cfg');
  if (!cfgName) return empty('Brak pliku global.cfg w folderze mapy.');

  const trip = parseTrip(decodeCfg(fs.readFileSync(ttpFull)).text, tripFileRel);
  const entries = parseTtr(decodeCfg(fs.readFileSync(ttrFull)).text);
  if (entries.length === 0) return empty('Plik .ttr nie zawiera wpisów [track_entry].');

  const readText = (full: string | null): string | null => {
    try {
      return full && fs.existsSync(full) ? decodeCfg(fs.readFileSync(full)).text : null;
    } catch {
      return null;
    }
  };
  const route = buildTripRoute(trip, entries, {
    tiles: parseTiles(decodeCfg(fs.readFileSync(path.join(mapDir, cfgName))).text),
    readTile: (rel) => readText(safeJoin(mapDir, rel)),
    readAsset: (rel) => readText(safeJoin(assetsDir(workDir), rel)),
    stops: loadMapStops(workDir),
  });
  if (route.lines.length === 0) route.error = 'Nie udało się ułożyć trasy: wpisów z .ttr nie znaleziono na kaflach mapy.';
  return route;
}
