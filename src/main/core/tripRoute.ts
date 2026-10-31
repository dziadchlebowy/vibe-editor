import fs from 'node:fs';
import path from 'node:path';
import type { MapStops, RouteSegment, RouteStation, StationEdits, TripFile, TripRoute } from '../../shared/types.ts';
import { decodeCfg, encodeCfg, splitLines } from './globalCfg.ts';
import { assetsDir, parseTiles, safeJoin, type TileRef } from './mapIndex.ts';
import { loadMapStops, parseTileObjects, type RawObject } from './mapStops.ts';
import { parseTileSplines, type RawSpline } from './mapSplines.ts';
import { projectOnLine } from '../../shared/geo.ts';
import { routeBases } from '../../shared/routeBases.ts';
import { editStations, findTrackFile, listTrackFiles, parseTrip, type NewStationFields } from './timetable.ts';

/**
 * Wpis [track_entry] z pliku .ttr (kolejne linijki po znaczniku):
 * ID splinu albo obiektu · numer ścieżki ruchu w jego pliku (.sli / .sco) · indeks kafla ([map] w global.cfg) ·
 * numer elementu na kaflu · długość (m) · flaga (w próbce zawsze 0).
 */
export type TrackEntry = Omit<RouteSegment, 'line'>;

export { projectOnLine };

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

/** Przesunięcie boczne (m) i kierunek (1 = jazda od końca splinu do początku) n-tej ścieżki z .sli. */
export function sliPathInfo(text: string, n: number): { off: number; reversed: boolean } | null {
  const v = nthPathValues(text, n, 5);
  return v ? { off: v[1], reversed: v[4] === 1 } : null;
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
  const info = sliText !== null ? sliPathInfo(sliText, pathIndex) : null;
  const c = (info?.off ?? 0) * (sp.mirror ? -1 : 1);
  const k = sp.radius !== 0 ? 1 / sp.radius : 0;
  const pts = arcPoints(sp.x, sp.y, sp.heading, sp.radius, sp.length, c);
  // ścieżka z kierunkiem 1 biegnie od końca splinu do początku — przebieg w kolejności jazdy
  return { pts: info?.reversed ? pts.reverse() : pts, length: Math.max(0, sp.length * (1 - c * k)) };
}

/** Czy plik .sli ma choć jedną ścieżkę dla pojazdów (typ 0 drogowe albo 2 szynowe). Brak pliku = nie. */
export const sliHasVehiclePath = (text: string | null): boolean => text !== null && pathBlocks(text).some((v) => v.length >= 5 && (v[0] === 0 || v[0] === 2));

/**
 * „Numer elementu na kaflu” z .ttr (potwierdzony na kaflu z mapy Warszawa 2008): dla splinu to jego pozycja wśród
 * splinów kafla (w kolejności pliku, [spline] i [spline_h] razem) mających ścieżkę dla pojazdów; spliny bez takich
 * ścieżek (chodniki, krawężniki, linie) się nie liczą. Zwraca dla każdego splinu ten numer albo −1, gdy nie ma ścieżek pojazdów.
 */
export function splineTrackIndexes(splines: RawSpline[], readAsset: (rel: string) => string | null): number[] {
  const memo = new Map<string, boolean>();
  let next = 0;
  return splines.map((sp) => {
    let has = memo.get(sp.path);
    if (has === undefined) memo.set(sp.path, (has = sliHasVehiclePath(readAsset(sp.path))));
    return has ? next++ : -1;
  });
}

/** To samo dla obiektów (założenie wg analogii do splinów, niepotwierdzone): pozycja wśród obiektów mających ścieżki w .sco. */
export function objectTrackIndexes(objects: RawObject[], readAsset: (rel: string) => string | null): number[] {
  const memo = new Map<string, boolean>();
  let next = 0;
  return objects.map((ob) => {
    let has = memo.get(ob.path);
    if (has === undefined) {
      const t = readAsset(ob.path);
      memo.set(ob.path, (has = t !== null && pathBlocks(t).some((_, i) => scoPathAt(t, i) !== null)));
    }
    return has ? next++ : -1;
  });
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
      const sps = parseTileSplines(text);
      const obs = parseTileObjects(text);
      const si = splineTrackIndexes(sps, src.readAsset);
      const oi = objectTrackIndexes(obs, src.readAsset);
      data = {
        ref,
        splines: new Map(sps.map((v, k) => [v.id, { v, i: si[k] }])),
        objects: new Map(obs.map((v, k) => [v.id, { v, i: oi[k] }])),
      };
    }
    cache.set(idx, data);
    return data;
  };

  const segments: RouteSegment[] = [];
  let unresolved = 0;
  let indexMismatch = 0;
  const indexCheck = { splines: { total: 0, bad: 0 }, objects: { total: 0, bad: 0 } };
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
        if (hit.ref === src.tiles[e.tile]) {
          indexCheck.splines.total++;
          if (sp.i !== e.index) (indexMismatch++, indexCheck.splines.bad++);
        }
      } else if (ob) {
        const sco = src.readAsset(ob.v.path);
        const p = sco !== null ? scoPathAt(sco, e.pathIndex) : null;
        pts = p ? objectPathPoints(p, ob.v.x, ob.v.y, ob.v.rot) : null;
        if (hit.ref === src.tiles[e.tile]) {
          indexCheck.objects.total++;
          if (ob.i !== e.index) (indexMismatch++, indexCheck.objects.bad++);
        }
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
  const base = routeBases(segments);
  const stations: RouteStation[] = [];
  const check = { total: 0, ok: 0, posOk: 0, latOk: 0 };
  trip.stations.forEach((st, i) => {
    let pos = byId.get(st.id);
    if (!pos) {
      const c = byName.get(st.name.trim().toLowerCase()) ?? [];
      pos = c.sort((a, b) => distToRoute(a, lines) - distToRoute(b, lines))[0];
    }
    if (pos) stops.push({ n: i + 1, name: st.name, x: pos.x, y: pos.y });
    else missingStops.push(st.name);
    const seg = segments[st.entry];
    // route − along = suma długości wpisów przed wpisem (entry − 1); tolerancja na zaokrąglenia długości w .ttr rośnie z numerem wpisu
    const ok = !!seg && Math.abs(st.route - st.along - base(st.entry)) <= 1 + 0.005 * st.entry;
    const proj = pos && seg && seg.line.length >= 4 ? projectOnLine(seg.line, pos.x, pos.y) : null;
    const posOk = proj ? Math.abs(proj.s - st.along) <= 3 : null;
    const latOk = proj ? Math.abs(proj.side - st.lateral) <= 1.5 : null;
    check.total++;
    if (ok) check.ok++;
    if (posOk) check.posOk++;
    if (latOk) check.latOk++;
    stations.push({ n: i + 1, id: st.id, name: st.name, entry: st.entry, lateral: st.lateral, route: st.route, along: st.along, ok, posOk, latOk, x: pos?.x, y: pos?.y });
  });

  return { trip: trip.name, tripFile: trip.file, segments, stops, stations, stationCheck: check, unresolved, indexMismatch, indexCheck, missingStops };
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
    stations: [],
    stationCheck: { total: 0, ok: 0, posOk: 0, latOk: 0 },
    unresolved: 0,
    indexMismatch: 0,
    indexCheck: { splines: { total: 0, bad: 0 }, objects: { total: 0, bad: 0 } },
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

/** Zapisuje trasę do .ttr kursu (tworzy plik obok .ttp, jeśli go nie ma) i zmiany przystanków do .ttp. Pierwszy zapis robi kopie .bak. */
export function saveTripRoute(mapDir: string, tripFileRel: string, segments: RouteSegment[], stations: StationEdits = { remap: [], add: [] }): { ok: boolean; error?: string } {
  const ttpFull = /\.ttp$/i.test(tripFileRel) ? safeJoin(mapDir, tripFileRel) : null;
  if (!ttpFull || !fs.existsSync(ttpFull)) return { ok: false, error: 'Nie ma takiego kursu w folderze mapy.' };
  const bad = segments.find(
    (g) => !/^\d+$/.test(g.id) || ![g.pathIndex, g.tile, g.index].every((v) => Number.isInteger(v) && v >= 0) || !Number.isFinite(g.length) || g.length < 0 || !Number.isInteger(g.flag),
  );
  if (bad) return { ok: false, error: `Nieprawidłowy wpis trasy (ID ${bad.id}).` };
  const badStation = [...stations.remap.map((r) => r.entry), ...stations.add.map((a) => a.entry)].find((e) => !Number.isInteger(e) || e < 0 || e >= segments.length);
  if (badStation !== undefined) return { ok: false, error: `Przystanek przypisany do nieistniejącego odcinka (${badStation}).` };

  const ttpDec = decodeCfg(fs.readFileSync(ttpFull));
  const trip = parseTrip(ttpDec.text, tripFileRel);

  // przygotuj zmiany .ttp przed zapisem czegokolwiek, żeby błąd nie zostawił połowicznego stanu
  let newTtp: string | null = null;
  if (stations.remap.length > 0 || stations.add.length > 0) {
    const tiles = readTiles(mapDir) ?? [];
    const norm = (f: string): string => f.replace(/\\/g, '/').toLowerCase();
    const base = routeBases(segments);
    const remap = new Map(stations.remap.map((r) => [r.index, { entry: r.entry, route: base(r.entry) + (trip.stations[r.index]?.along ?? 0) }]));
    const adds: NewStationFields[] = [];
    for (const a of stations.add) {
      const tile = tiles.findIndex((t) => norm(t.file) === norm(a.tileFile));
      if (tile < 0) return { ok: false, error: `Nie znaleziono kafla przystanku „${a.name}” w global.cfg.` };
      const prev = [...trip.stations].reverse().find((st) => st.entry <= a.entry);
      adds.push({ id: a.stopId, entry: a.entry, name: a.name, tile, lateral: a.lateral, route: base(a.entry) + a.along, along: a.along, wait: prev?.wait ?? 3 });
    }
    newTtp = editStations(ttpDec.text, remap, adds).join(ttpDec.text.includes('\r\n') ? '\r\n' : '\n');
  }

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

  if (newTtp !== null) {
    if (!fs.existsSync(`${ttpFull}.bak`)) fs.copyFileSync(ttpFull, `${ttpFull}.bak`);
    fs.writeFileSync(ttpFull, encodeCfg(newTtp, ttpDec.encoding, ttpDec.bom));
  }
  return { ok: true };
}

// --- wybieranie ścieżek myszą i łańcuchy połączonych ścieżek (edytor tras) ---------------------------------

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

/** Ścieżka ruchu w metrach świata ((kafel − 0,5) · 300 + lokalne), w kolejności jazdy. */
interface PathRec {
  id: string;
  pathIndex: number;
  tile: number;
  index: number;
  length: number;
  pts: Pt[];
}
interface TilePaths {
  mtime: number;
  recs: PathRec[];
  /** Początki ścieżek w komórkach 4 × 4 m — do szukania następników. */
  starts: Map<string, PathRec[]>;
}
const CELL = 4;
const cellKey = (x: number, y: number): string => `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
const pathCache = new Map<string, TilePaths>();

/** Wszystkie ścieżki ruchu kafla: pojazdy drogowe i szynowe ze splinów oraz wszystkie ścieżki obiektów. */
function tilePaths(workDir: string, mapDir: string, t: TileRef, tileIdx: number): TilePaths | null {
  const full = path.join(mapDir, t.file);
  const data = cachedTile(full);
  if (!data) return null;
  const key = `${full}|${tileIdx}`;
  const hit = pathCache.get(key);
  if (hit && hit.mtime === tileCache.get(full)?.mtime) return hit;
  const assets = assetsDir(workDir);
  const ox = (t.x - 0.5) * 300;
  const oy = (t.y - 0.5) * 300;
  const world = (pts: Pt[]): Pt[] => pts.map((p) => [ox + p[0], oy + p[1]]);
  const recs: PathRec[] = [];
  const readAsset = (rel: string): string | null => cachedAsset(safeJoin(assets, rel));
  const spIdx = splineTrackIndexes(data.splines, readAsset);
  const obIdx = objectTrackIndexes(data.objects, readAsset);
  data.splines.forEach((sp, k) => {
    const index = spIdx[k];
    const sli = cachedAsset(safeJoin(assets, sp.path));
    const blocks = sli !== null ? pathBlocks(sli) : [[0, 0, 0, 0, 0]];
    blocks.forEach((v, pathIndex) => {
      if (v.length < 5 || (v[0] !== 0 && v[0] !== 2)) return; // tylko pojazdy drogowe i szynowe
      const g = splinePath(sp, sli, pathIndex);
      recs.push({ id: sp.id, pathIndex, tile: tileIdx, index, length: g.length, pts: world(g.pts) });
    });
  });
  data.objects.forEach((ob, k) => {
    const index = obIdx[k];
    const sco = cachedAsset(safeJoin(assets, ob.path));
    if (sco === null) return;
    pathBlocks(sco).forEach((_, pathIndex) => {
      const p = scoPathAt(sco, pathIndex);
      if (p) recs.push({ id: ob.id, pathIndex, tile: tileIdx, index, length: p.len, pts: world(objectPathPoints(p, ob.x, ob.y, ob.rot)) });
    });
  });
  const starts = new Map<string, PathRec[]>();
  for (const r of recs) {
    const k = cellKey(r.pts[0][0], r.pts[0][1]);
    starts.set(k, [...(starts.get(k) ?? []), r]);
  }
  const fresh = { mtime: data.mtime, recs, starts };
  pathCache.set(key, fresh);
  return fresh;
}

const toSegment = (r: PathRec): RouteSegment => ({
  id: r.id,
  pathIndex: r.pathIndex,
  tile: r.tile,
  index: r.index,
  length: r.length,
  flag: 0,
  line: r.pts.flatMap((p) => [p[0] / 300, p[1] / 300]),
});

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

/** Kafle (indeksy w global.cfg) w sąsiedztwie 3 × 3 punktu w metrach świata. */
function tilesAround(tiles: TileRef[], byXY: Map<string, number>, px: number, py: number): number[] {
  const tx = Math.floor(px / 300 + 0.5);
  const ty = Math.floor(py / 300 + 0.5);
  void tiles;
  const out: number[] = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const i = byXY.get(`${tx + dx},${ty + dy}`);
      if (i !== undefined) out.push(i);
    }
  }
  return out;
}

const heading = (a: Pt, b: Pt): number => Math.atan2(b[0] - a[0], b[1] - a[1]);
const angleDiff = (a: number, b: number): number => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
const startHeading = (r: PathRec): number => heading(r.pts[0], r.pts[Math.min(1, r.pts.length - 1)]);
const endHeading = (r: { pts: Pt[] }): number => heading(r.pts[Math.max(0, r.pts.length - 2)], r.pts[r.pts.length - 1]);

/**
 * Ścieżka ruchu (pojazdy drogowe i szynowe ze splinów, ścieżki obiektów) najbliższa punktu (x, y) w jednostkach kafli,
 * nie dalej niż maxDistM metrów; przeszukuje kafel pod punktem i 8 sąsiednich.
 */
export function pickTrackPath(workDir: string, mapDir: string, x: number, y: number, maxDistM: number): RouteSegment | null {
  return toSegmentOrNull(nearestPath(workDir, mapDir, readTiles(mapDir), x, y, maxDistM));
}

const toSegmentOrNull = (r: PathRec | null): RouteSegment | null => (r ? toSegment(r) : null);

function nearestPath(workDir: string, mapDir: string, tiles: TileRef[] | null, x: number, y: number, maxDistM: number): PathRec | null {
  if (!tiles) return null;
  const byXY = new Map(tiles.map((t, i) => [`${t.x},${t.y}`, i]));
  const cx = x * 300;
  const cy = y * 300;
  let best: { d: number; r: PathRec } | null = null;
  for (const ti of tilesAround(tiles, byXY, cx, cy)) {
    for (const r of tilePaths(workDir, mapDir, tiles[ti], ti)?.recs ?? []) {
      if (Math.hypot(r.pts[0][0] - cx, r.pts[0][1] - cy) > r.length + maxDistM + 2) continue;
      const d = distToPolyline(cx, cy, r.pts);
      if (d <= maxDistM && (!best || d < best.d)) best = { d, r };
    }
  }
  return (best as { r: PathRec } | null)?.r ?? null;
}

/**
 * Hover w edytorze: ścieżka pod kursorem (target) oraz — jeśli podano przebieg odcinka wyjściowego (fromLine) — najkrótszy
 * łańcuch połączonych ścieżek od jego końca do target włącznie (puste, gdy target nie jest połączony ze ścieżką wyjściową).
 * Ścieżki łączą się, gdy początek następnej leży w ≤ 2,5 m od końca poprzedniej, a kierunki różnią się o ≤ 50°.
 */
export function hoverTrack(workDir: string, mapDir: string, x: number, y: number, maxDistM: number, fromLine: number[] | null): { target: RouteSegment | null; chain: RouteSegment[] } {
  const tiles = readTiles(mapDir);
  const target = nearestPath(workDir, mapDir, tiles, x, y, maxDistM);
  if (!target || !tiles || !fromLine || fromLine.length < 4) return { target: toSegmentOrNull(target), chain: [] };
  const byXY = new Map(tiles.map((t, i) => [`${t.x},${t.y}`, i]));
  const rk = (r: PathRec): string => `${r.id}:${r.pathIndex}`;
  const successors = (end: Pt, hdg: number): PathRec[] => {
    const out: PathRec[] = [];
    for (const ti of tilesAround(tiles, byXY, end[0], end[1])) {
      const cells = tilePaths(workDir, mapDir, tiles[ti], ti)?.starts;
      if (!cells) continue;
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          for (const r of cells.get(`${Math.floor(end[0] / CELL) + ox},${Math.floor(end[1] / CELL) + oy}`) ?? []) {
            if (Math.hypot(r.pts[0][0] - end[0], r.pts[0][1] - end[1]) <= 2.5 && angleDiff(startHeading(r), hdg) <= (50 * Math.PI) / 180) out.push(r);
          }
        }
      }
    }
    return out;
  };
  const fromPts: Pt[] = [];
  for (let i = 0; i + 1 < fromLine.length; i += 2) fromPts.push([fromLine[i] * 300, fromLine[i + 1] * 300]);
  const goal = rk(target);
  const dist = new Map<string, number>();
  const prev = new Map<string, PathRec | null>();
  const recOf = new Map<string, PathRec>();
  const open: string[] = [];
  const relax = (r: PathRec, d: number, from: PathRec | null): void => {
    const k = rk(r);
    if (d < (dist.get(k) ?? Infinity)) {
      dist.set(k, d);
      prev.set(k, from);
      recOf.set(k, r);
      if (!open.includes(k)) open.push(k);
    }
  };
  for (const r of successors(fromPts[fromPts.length - 1], endHeading({ pts: fromPts }))) relax(r, r.length, null);
  const done = new Set<string>();
  const maxM = 3000;
  while (open.length > 0 && done.size < 1500) {
    open.sort((a, b) => (dist.get(a) ?? 0) - (dist.get(b) ?? 0));
    const k = open.shift()!;
    if (done.has(k)) continue;
    done.add(k);
    const r = recOf.get(k)!;
    if (k === goal) {
      const chain: PathRec[] = [];
      for (let c: PathRec | null | undefined = r; c; c = prev.get(rk(c))) chain.unshift(c);
      return { target: toSegment(target), chain: chain.map(toSegment) };
    }
    const d = dist.get(k) ?? 0;
    if (d > maxM) continue;
    for (const n of successors(r.pts[r.pts.length - 1], endHeading(r))) relax(n, d + n.length, r);
  }
  return { target: toSegment(target), chain: [] };
}
