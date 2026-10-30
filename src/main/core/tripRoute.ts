import fs from 'node:fs';
import path from 'node:path';
import type { MapStops, RouteSegment, TripFile, TripRoute } from '../../shared/types.ts';
import { decodeCfg, encodeCfg, splitLines } from './globalCfg.ts';
import { assetsDir, parseTiles, safeJoin, type TileRef } from './mapIndex.ts';
import { loadMapStops, parseTileObjects, type RawObject } from './mapStops.ts';
import { parseTileSplines, type RawSpline } from './mapSplines.ts';
import { findTrackFile, listTrackFiles, parseTrip } from './timetable.ts';

/**
 * Wpis [track_entry] z pliku .ttr (kolejne linijki po znaczniku):
 * ID splinu albo obiektu · numer ścieżki ruchu w jego pliku (.sli / .sco) · indeks kafla ([map] w global.cfg) ·
 * numer elementu na kaflu · długość (m) · flaga (w próbce zawsze 0).
 */
export type TrackEntry = Omit<RouteSegment, 'line'>;

export function parseTtr(text: string): TrackEntry[] {
  const lines = splitLines(text);
  const out: TrackEntry[] = [];
  const n = (s: string | undefined): number => Number((s ?? '').trim().replace(',', '.'));
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().toLowerCase() !== '[track_entry]') continue;
    const id = (lines[i + 1] ?? '').trim();
    const pathIndex = n(lines[i + 2]);
    const tile = n(lines[i + 3]);
    const index = n(lines[i + 4]);
    const length = n(lines[i + 5]);
    const flag = n(lines[i + 6]);
    if (!id || !Number.isInteger(pathIndex) || !Number.isInteger(tile)) continue;
    out.push({
      id,
      pathIndex,
      tile,
      index: Number.isInteger(index) ? index : 0,
      length: Number.isFinite(length) ? length : 0,
      flag: Number.isInteger(flag) ? flag : 0,
    });
  }
  return out;
}

const TTR_HEADER = (date: string): string[] => [
  '-----------------------',
  'Time Table Track File',
  '-----------------------',
  '',
  'Created with Omsi Version 2.3.004',
  `Date: ${date}`,
  '',
];

/** Składa tekst pliku .ttr: nagłówek z oryginału (albo domyślny) i wpisy z numeracją `   N:` jak w plikach OMSI. */
export function serializeTtr(orig: string | null, segs: TrackEntry[], eol: string, date: string): string {
  let header = TTR_HEADER(date);
  if (orig !== null) {
    const lines = splitLines(orig);
    const first = lines.findIndex((l) => l.trim().toLowerCase() === '[track_entry]');
    if (first >= 0) header = lines.slice(0, first > 0 && /^\s*\d+:\s*$/.test(lines[first - 1]) ? first - 1 : first);
  }
  const out = [...header];
  segs.forEach((e, k) => out.push(`   ${k}:`, '[track_entry]', e.id, String(e.pathIndex), String(e.tile), String(e.index), e.length.toFixed(10), String(e.flag), ''));
  return out.join(eol);
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

/** Wartości liczbowe każdego [path] w pliku (w kolejności znaczników); pusta tablica, gdy ścieżka nie ma liczb. */
export function pathBlocks(text: string): number[][] {
  const lines = splitLines(text);
  const out: number[][] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().toLowerCase() !== '[path]') continue;
    const v: number[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j].trim();
      if (t.startsWith('[')) break;
      if (t) v.push(Number(t.replace(',', '.')));
    }
    out.push(v);
  }
  return out;
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

// --- ścieżki splinów i obiektów (wspólne dla składania trasy i wybierania ścieżki myszą) ------------------

/** Ścieżka splinu: punkty (m lokalne kafla) i długość ścieżki; boczne przesunięcie z .sli (0, gdy brak .sli). */
export function splinePath(sp: RawSpline, sliText: string | null, pathIndex: number): { pts: Pt[]; length: number } {
  const off = (sliText !== null ? sliPathOffset(sliText, pathIndex) : null) ?? 0;
  const c = off * (sp.mirror ? -1 : 1);
  const k = sp.radius !== 0 ? 1 / sp.radius : 0;
  return { pts: arcPoints(sp.x, sp.y, sp.heading, sp.radius, sp.length, c), length: Math.max(0, sp.length * (1 - c * k)) };
}

// --- składanie trasy --------------------------------------------------------------------------------

interface TileData {
  ref: TileRef;
  splines: Map<string, { v: RawSpline; i: number }>;
  objects: Map<string, { v: RawObject; i: number }>;
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
        splines: new Map(parseTileSplines(text).map((v, i) => [v.id, { v, i }])),
        objects: new Map(parseTileObjects(text).map((v, i) => [v.id, { v, i }])),
      };
    }
    cache.set(idx, data);
    return data;
  };

  const segments: RouteSegment[] = [];
  let unresolved = 0;
  let indexMismatch = 0;
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
    let pts: Pt[] | null = null;
    if (hit) {
      const sp = hit.splines.get(e.id);
      const ob = hit.objects.get(e.id);
      if (sp) {
        pts = splinePath(sp.v, src.readAsset(sp.v.path), e.pathIndex).pts;
        if (hit.ref === src.tiles[e.tile] && sp.i !== e.index) indexMismatch++;
      } else if (ob) {
        const sco = src.readAsset(ob.v.path);
        const p = sco !== null ? scoPathAt(sco, e.pathIndex) : null;
        pts = p ? objectPathPoints(p, ob.v.x, ob.v.y, ob.v.rot) : null;
        if (hit.ref === src.tiles[e.tile] && ob.i !== e.index) indexMismatch++;
      }
    }
    if (!hit || !pts) unresolved++;
    segments.push({ ...e, line: hit && pts ? pts.flatMap((p) => toWorld(hit!.ref, p)) : [] });
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
  const lines = segments.map((g) => g.line);
  trip.stations.forEach((st, i) => {
    let pos = byId.get(st.id);
    if (!pos) {
      const c = byName.get(st.name.trim().toLowerCase()) ?? [];
      pos = c.sort((a, b) => distToRoute(a, lines) - distToRoute(b, lines))[0];
    }
    if (pos) stops.push({ n: i + 1, name: st.name, x: pos.x, y: pos.y });
    else missingStops.push(st.name);
  });

  return { trip: trip.name, tripFile: trip.file, segments, stops, unresolved, indexMismatch, missingStops };
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

const readText = (full: string | null): string | null => {
  try {
    return full && fs.existsSync(full) ? decodeCfg(fs.readFileSync(full)).text : null;
  } catch {
    return null;
  }
};

function readTiles(mapDir: string): TileRef[] | null {
  const cfgName = fs.readdirSync(mapDir).find((f) => f.toLowerCase() === 'global.cfg');
  return cfgName ? parseTiles(decodeCfg(fs.readFileSync(path.join(mapDir, cfgName))).text) : null;
}

/** Wczytuje trasę kursu (plik .ttr o nazwie kursu) i składa ją z kafli mapy. Brak .ttr to pusta trasa (noFile). */
export function loadTripRoute(workDir: string, mapDir: string, tripFileRel: string): TripRoute {
  const fail = (error: string): TripRoute => ({
    trip: path.basename(tripFileRel).replace(/\.ttp$/i, ''),
    tripFile: tripFileRel,
    segments: [],
    stops: [],
    unresolved: 0,
    indexMismatch: 0,
    missingStops: [],
    error,
  });
  const ttpFull = /\.ttp$/i.test(tripFileRel) ? safeJoin(mapDir, tripFileRel) : null;
  if (!ttpFull || !fs.existsSync(ttpFull)) return fail('Nie ma takiego kursu w folderze mapy.');
  const tiles = readTiles(mapDir);
  if (!tiles) return fail('Brak pliku global.cfg w folderze mapy.');

  const trip = parseTrip(decodeCfg(fs.readFileSync(ttpFull)).text, tripFileRel);
  const ttrRel = findTrackFile(listTrackFiles(mapDir), tripFileRel, trip.internalName);
  const ttrFull = ttrRel ? safeJoin(mapDir, ttrRel) : null;
  const entries = ttrFull && fs.existsSync(ttrFull) ? parseTtr(decodeCfg(fs.readFileSync(ttrFull)).text) : [];
  const route = buildTripRoute(trip, entries, {
    tiles,
    readTile: (rel) => readText(safeJoin(mapDir, rel)),
    readAsset: (rel) => readText(safeJoin(assetsDir(workDir), rel)),
    stops: loadMapStops(workDir),
  });
  if (!ttrFull || !fs.existsSync(ttrFull)) route.noFile = true;
  return route;
}

/** Zapisuje trasę do .ttr kursu (tworzy plik obok .ttp, jeśli go nie ma). Pierwszy zapis robi kopię .ttr.bak. */
export function saveTripRoute(mapDir: string, tripFileRel: string, segments: RouteSegment[]): { ok: boolean; error?: string } {
  const ttpFull = /\.ttp$/i.test(tripFileRel) ? safeJoin(mapDir, tripFileRel) : null;
  if (!ttpFull || !fs.existsSync(ttpFull)) return { ok: false, error: 'Nie ma takiego kursu w folderze mapy.' };
  const bad = segments.find(
    (g) => !/^\d+$/.test(g.id) || ![g.pathIndex, g.tile, g.index].every((v) => Number.isInteger(v) && v >= 0) || !Number.isFinite(g.length) || g.length < 0 || !Number.isInteger(g.flag),
  );
  if (bad) return { ok: false, error: `Nieprawidłowy wpis trasy (ID ${bad.id}).` };

  const ttpDec = decodeCfg(fs.readFileSync(ttpFull));
  const trip = parseTrip(ttpDec.text, tripFileRel);
  const ttrRel = findTrackFile(listTrackFiles(mapDir), tripFileRel, trip.internalName);
  const full = (ttrRel ? safeJoin(mapDir, ttrRel) : null) ?? ttpFull.replace(/\.ttp$/i, '.ttr');
  const exists = fs.existsSync(full);
  const dec = exists ? decodeCfg(fs.readFileSync(full)) : null;
  if (exists && !fs.existsSync(`${full}.bak`)) fs.copyFileSync(full, `${full}.bak`);
  const eol = (dec?.text ?? ttpDec.text).includes('\r\n') ? '\r\n' : '\n';
  const d = new Date();
  const date = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
  const text = serializeTtr(dec?.text ?? null, segments, eol, date);
  fs.writeFileSync(full, encodeCfg(text, dec?.encoding ?? ttpDec.encoding, dec?.bom ?? ttpDec.bom));
  return { ok: true };
}

// --- wybieranie ścieżki myszą (edytor tras) -----------------------------------------------------------

interface TileCache {
  mtime: number;
  splines: RawSpline[];
  objects: RawObject[];
}
const tileCache = new Map<string, TileCache>();
const assetCache = new Map<string, { mtime: number; text: string | null }>();

function cachedTile(full: string): TileCache | null {
  try {
    const mtime = fs.statSync(full).mtimeMs;
    const hit = tileCache.get(full);
    if (hit && hit.mtime === mtime) return hit;
    const text = decodeCfg(fs.readFileSync(full)).text;
    const fresh = { mtime, splines: parseTileSplines(text), objects: parseTileObjects(text) };
    tileCache.set(full, fresh);
    return fresh;
  } catch {
    return null;
  }
}

function cachedAsset(full: string | null): string | null {
  if (!full) return null;
  try {
    const mtime = fs.statSync(full).mtimeMs;
    const hit = assetCache.get(full);
    if (hit && hit.mtime === mtime) return hit.text;
    const text = readText(full);
    assetCache.set(full, { mtime, text });
    return text;
  } catch {
    return null;
  }
}

/** Odległość punktu od łamanej (m). */
function distToPolyline(px: number, py: number, pts: Pt[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[i + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
    best = Math.min(best, Math.hypot(px - (ax + t * dx), py - (ay + t * dy)));
  }
  return best;
}

/**
 * Najbliższa ścieżka ruchu (pojazdy drogowe i szynowe ze splinów, wszystkie ścieżki obiektów) wokół punktu
 * (x, y) w jednostkach kafli, nie dalej niż maxDistM metrów. Przeszukuje kafel pod punktem i 8 sąsiednich.
 */
export function pickTrackPath(workDir: string, mapDir: string, x: number, y: number, maxDistM: number): RouteSegment | null {
  const tiles = readTiles(mapDir);
  if (!tiles) return null;
  const cx = x * 300;
  const cy = y * 300;
  const tx = Math.round(x);
  const ty = Math.round(y);
  const assets = assetsDir(workDir);
  let best: { d: number; seg: RouteSegment } | null = null;
  const consider = (d: number, seg: RouteSegment): void => {
    if (d <= maxDistM && (!best || d < best.d)) best = { d, seg };
  };
  tiles.forEach((t, tileIdx) => {
    if (Math.abs(t.x - tx) > 1 || Math.abs(t.y - ty) > 1) return;
    const data = cachedTile(path.join(mapDir, t.file));
    if (!data) return;
    const ox = (t.x - 0.5) * 300;
    const oy = (t.y - 0.5) * 300;
    const toLine = (pts: Pt[]): number[] => pts.flatMap((p) => toWorld(t, p));
    const world = (pts: Pt[]): Pt[] => pts.map((p) => [ox + p[0], oy + p[1]]);
    data.splines.forEach((sp, i) => {
      if (Math.hypot(ox + sp.x - cx, oy + sp.y - cy) > sp.length + maxDistM + 25) return;
      const sli = cachedAsset(safeJoin(assets, sp.path));
      const paths = sli !== null ? pathBlocks(sli) : [[0, 0, 0, 0, 0]];
      paths.forEach((v, pathIndex) => {
        if (v.length < 5 || (v[0] !== 0 && v[0] !== 2)) return; // tylko pojazdy drogowe i szynowe
        const g = splinePath(sp, sli, pathIndex);
        const d = distToPolyline(cx, cy, world(g.pts));
        if (d <= maxDistM) consider(d, { id: sp.id, pathIndex, tile: tileIdx, index: i, length: g.length, flag: 0, line: toLine(g.pts) });
      });
    });
    data.objects.forEach((ob, i) => {
      if (Math.hypot(ox + ob.x - cx, oy + ob.y - cy) > 150 + maxDistM) return;
      const sco = cachedAsset(safeJoin(assets, ob.path));
      if (sco === null) return;
      pathBlocks(sco).forEach((v, pathIndex) => {
        const p = scoPathAt(sco, pathIndex);
        if (!p) return;
        const pts = objectPathPoints(p, ob.x, ob.y, ob.rot);
        const d = distToPolyline(cx, cy, world(pts));
        if (d <= maxDistM) consider(d, { id: ob.id, pathIndex, tile: tileIdx, index: i, length: p.len, flag: 0, line: toLine(pts) });
      });
    });
  });
  return (best as { seg: RouteSegment } | null)?.seg ?? null;
}
