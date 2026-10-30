import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { MapCatalog, MapOverview, MapTileView, ObjectView, RoadView } from '../../shared/types.ts';
import type { Emit } from './emit.ts';
import { decodeCfg, splitLines } from './globalCfg.ts';
import {
  buildSplinesData,
  extentFromAssets,
  pathsFromAssets,
  parseTileSplines,
  splinesPath,
  type TileSplines,
} from './mapSplines.ts';

export interface TileRef {
  x: number;
  y: number;
  /** Plik .map względem folderu mapy. */
  file: string;
}

export interface IndexedTile extends TileRef {
  exists: boolean;
  /** Indeksy w MapIndex.assets. */
  assets: number[];
}

/** Informacje o obiekcie wyczytane z jego pliku .sco. */
export interface ObjectEntry {
  /** Indeks w MapIndex.assets. */
  a: number;
  /** Nazwa wyświetlana ([friendlyname] albo nazwa pliku). */
  n: string;
  /** Drzewo „folderów” ([groups]) od korzenia. */
  g: string[];
  /** Czy udało się odczytać plik .sco. */
  k: boolean;
}

export interface MapIndex {
  version: 2;
  indexedAt: number;
  mapFolder: string;
  tiles: IndexedTile[];
  /** Unikatowe ścieżki assetów (względem folderu OMSI, separator „/”). */
  assets: string[];
  /** Rodzaje assetów (równolegle do assets): bit 1 = spline (jezdnia), bit 2 = obiekt. */
  assetKinds: number[];
  /** Assety, których nie ma w folderze OMSI. */
  missingAssets: string[];
  /** Dane obiektów (.sco): nazwa i grupy. */
  objects: ObjectEntry[];
}

export type AssetKind = 'spline' | 'object';
export const KIND_BIT: Record<AssetKind, number> = { spline: 1, object: 2 };

export const INDEX_FILE = 'map-index.json';

/**
 * Znaczniki, pod którymi (dwie linijki niżej) stoi ścieżka assetu — porównywane małymi literami.
 * Jezdnie to splajny; obiekty to [object] oraz obiekty doczepione do splajnów/obiektów.
 */
const MARKER_KIND: Record<string, AssetKind> = {
  '[spline]': 'spline',
  '[spline_h]': 'spline',
  '[object]': 'object',
  '[splineattachement]': 'object',
  '[attachobj]': 'object',
};
const PATH_OFFSET = 2;

// --- ścieżki ----------------------------------------------------------------

/** Normalizuje ścieżkę z pliku OMSI do postaci „a/b/c.ext”; null dla pustych i niebezpiecznych. */
export function normalizeAssetPath(raw: string): string | null {
  const parts = raw
    .trim()
    .split(/[\\/]+/)
    .filter((p) => p !== '' && p !== '.');
  if (parts.length === 0) return null;
  if (parts.some((p) => p === '..') || raw.includes(':') || raw.includes('\0')) return null;
  return parts.join('/');
}

/** Łączy ścieżkę względną z katalogiem bazowym; null, gdy wychodzi poza katalog. */
export function safeJoin(base: string, rel: string): string | null {
  const root = path.resolve(base);
  const full = path.resolve(root, rel);
  return full === root || full.startsWith(root + path.sep) ? full : null;
}

const cp1250 = new TextDecoder('windows-1250');

/** Plik czytany jako latin1 (bajt = znak) → właściwy tekst w Windows-1250. */
function fromLatin1(s: string): string {
  // eslint-disable-next-line no-control-regex
  return /^[\x00-\x7f]*$/.test(s) ? s : cp1250.decode(Buffer.from(s, 'latin1'));
}

// --- global.cfg: lista kafli ------------------------------------------------

/** Czyta wszystkie znaczniki [map]: współrzędne x, y i nazwa pliku .map. */
export function parseTiles(cfgText: string): TileRef[] {
  const lines = cfgText.split(/\r\n|\n|\r/);
  const tiles = new Map<string, TileRef>();
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().toLowerCase() !== '[map]') continue;
    const params: string[] = [];
    for (let j = i + 1; j < lines.length && params.length < 8; j++) {
      const t = lines[j].trim();
      if (t.startsWith('[')) break;
      if (t) params.push(t);
    }
    // Kolejność linii we wpisie bywa różnie opisywana, więc: dwie pierwsze liczby całkowite to x, y,
    // a nazwa pliku .map może stać w dowolnym miejscu wpisu.
    const ints = params.filter((p) => /^-?\d+$/.test(p)).map(Number);
    const file = params.find((p) => /\.map$/i.test(p));
    if (ints.length < 2 || !file) continue;
    const [x, y] = ints;
    const key = `${x},${y}`;
    if (!tiles.has(key)) tiles.set(key, { x, y, file: file.replace(/\\/g, '/') });
  }
  return [...tiles.values()];
}

// --- plik .map: ścieżki assetów --------------------------------------------

export interface TileAsset {
  path: string;
  kind: AssetKind;
}

/**
 * Skanuje plik .map strumieniowo (kafle bywają duże). Znaczniki mogą stać w dowolnym miejscu pliku;
 * pod [spline], [spline_h], [object], [splineAttachement], [attachObj] czytamy ścieżkę dwie linijki niżej.
 * Zwraca unikatowe pary (ścieżka, rodzaj).
 */
export async function scanTile(file: string): Promise<TileAsset[]> {
  const found = new Map<string, TileAsset>(); // klucz: rodzaj + ścieżka małymi literami
  let pending = 0;
  let pendingKind: AssetKind = 'spline';
  const feed = (line: string, latin1: boolean): void => {
    const t = line.trim();
    if (t.startsWith('[')) {
      const kind = MARKER_KIND[t.toLowerCase()];
      pending = kind ? PATH_OFFSET : 0;
      if (kind) pendingKind = kind;
      return;
    }
    if (pending > 0 && --pending === 0 && t) {
      const norm = normalizeAssetPath(latin1 ? fromLatin1(t) : t);
      const key = `${pendingKind}:${norm?.toLowerCase()}`;
      if (norm && !found.has(key)) found.set(key, { path: norm, kind: pendingKind });
    }
  };

  const bom = await readBom(file);
  if (bom === 'utf-16be') {
    // rzadkie: zamiana bajtów wymaga całego pliku
    const text = decodeCfg(await fs.promises.readFile(file)).text;
    for (const line of splitLines(text)) feed(line, false);
    return [...found.values()];
  }

  // UTF-16 LE / UTF-8 z BOM: dekodowanie strumieniowe; reszta: bajt = znak, potem Windows-1250
  const encoding = bom === 'utf-16le' ? 'utf16le' : bom === 'utf-8' ? 'utf8' : 'latin1';
  const stream = fs.createReadStream(file, { encoding });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) feed(line, encoding === 'latin1');
  } finally {
    rl.close();
    stream.destroy();
  }
  return [...found.values()];
}

/** Unikatowe ścieżki assetów z kafla (bez rozróżniania rodzaju, wielkość liter bez znaczenia). */
export async function scanTileAssets(file: string): Promise<string[]> {
  const seen = new Map<string, string>();
  for (const a of await scanTile(file)) if (!seen.has(a.path.toLowerCase())) seen.set(a.path.toLowerCase(), a.path);
  return [...seen.values()];
}

// --- plik .sco: drzewo grup -------------------------------------------------

export interface ScoInfo {
  /** Foldery od korzenia, np. ["Aachen", "Gruen"]. */
  groups: string[];
  /** [friendlyname] — pusty, gdy go nie ma. */
  name: string;
}

/**
 * Czyta z pliku obiektu (.sco) znaczniki [groups] i [friendlyname] (w dowolnym miejscu pliku).
 * Pod [groups]: liczba folderów, a niżej ich nazwy. Pod [friendlyname]: nazwa obiektu.
 */
export function parseSco(text: string): ScoInfo {
  const lines = splitLines(text);
  let groups: string[] = [];
  let hasGroups = false;
  let name = '';
  for (let i = 0; i < lines.length; i++) {
    const marker = lines[i].trim().toLowerCase();
    if (marker === '[groups]' && !hasGroups) {
      hasGroups = true;
      const n = Number.parseInt(lines[i + 1] ?? '', 10);
      if (Number.isFinite(n) && n > 0) {
        groups = lines
          .slice(i + 2, i + 2 + n)
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('['));
      }
    } else if (marker === '[friendlyname]' && !name) {
      const next = (lines[i + 1] ?? '').trim();
      if (!next.startsWith('[')) name = next;
    }
  }
  return { groups, name };
}

/** Rozpoznaje BOM na początku pliku (czyta tylko 3 bajty). */
async function readBom(file: string): Promise<'utf-16le' | 'utf-16be' | 'utf-8' | null> {
  const fh = await fs.promises.open(file, 'r');
  try {
    const b = Buffer.alloc(3);
    const { bytesRead } = await fh.read(b, 0, 3, 0);
    if (bytesRead >= 2 && b[0] === 0xff && b[1] === 0xfe) return 'utf-16le';
    if (bytesRead >= 2 && b[0] === 0xfe && b[1] === 0xff) return 'utf-16be';
    if (bytesRead >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return 'utf-8';
    return null;
  } finally {
    await fh.close();
  }
}

// --- indeksowanie i kopiowanie ---------------------------------------------

export interface BuildOptions {
  workDir: string;
  mapFolder: string;
  omsiDir: string;
  emit: Emit;
}

export const assetsDir = (workDir: string): string => path.join(workDir, '_vibe', 'assets');
export const indexPath = (workDir: string): string => path.join(workDir, '_vibe', INDEX_FILE);

async function mapLimit<T>(items: T[], limit: number, fn: (item: T, i: number) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

async function sameFile(src: string, dst: string): Promise<boolean> {
  try {
    const [a, b] = await Promise.all([fs.promises.stat(src), fs.promises.stat(dst)]);
    return a.size === b.size;
  } catch {
    return false;
  }
}

/**
 * Czyta listę kafli z global.cfg, skanuje każdy kafel, zbiera „rejestr” unikatowych assetów
 * i kopiuje te pliki z folderu OMSI do <folder roboczy>/_vibe/assets/ (z zachowaniem ścieżek).
 * Zawartości skopiowanych plików nie czyta.
 */
export async function buildMapIndex(o: BuildOptions): Promise<MapIndex> {
  const mapDir = path.join(o.workDir, o.mapFolder);
  const cfgName = fs.readdirSync(mapDir).find((f) => f.toLowerCase() === 'global.cfg');
  if (!cfgName) throw new Error('Brak pliku global.cfg w folderze mapy.');
  const refs = parseTiles(decodeCfg(fs.readFileSync(path.join(mapDir, cfgName))).text);
  o.emit('app', `Znaleziono kafli: ${refs.length}. Wczytuję pliki .map…`);

  const registry = new Map<string, number>(); // klucz małymi literami → indeks
  const assets: string[] = [];
  const kinds: number[] = [];
  const tiles: IndexedTile[] = refs.map((r) => ({ ...r, exists: false, assets: [] }));

  const tileSplines: TileSplines[] = [];
  let done = 0;
  await mapLimit(tiles, 4, async (tile) => {
    const full = safeJoin(mapDir, tile.file);
    if (full && fs.existsSync(full)) {
      tile.exists = true;
      try {
        const found = await scanTile(full);
        const ids = new Set<number>();
        for (const { path: p, kind } of found) {
          const key = p.toLowerCase();
          let idx = registry.get(key);
          if (idx === undefined) {
            idx = assets.push(p) - 1;
            kinds.push(0);
            registry.set(key, idx);
          }
          kinds[idx] |= KIND_BIT[kind];
          ids.add(idx);
        }
        tile.assets = [...ids];
        tileSplines.push({ x: tile.x, y: tile.y, splines: parseTileSplines(decodeCfg(await fs.promises.readFile(full)).text) });
      } catch (e) {
        o.emit('app', `Nie udało się wczytać ${tile.file}: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      o.emit('app', `Brak pliku kafla ${tile.file} (${tile.x}, ${tile.y}).`);
    }
    if (++done % 25 === 0 || done === tiles.length) o.emit('app', `Wczytano kafli: ${done}/${tiles.length}`);
  });

  // stała kolejność, niezależna od współbieżności
  const order = assets.map((_, i) => i).sort((a, b) => assets[a].localeCompare(assets[b]));
  const remap = new Map(order.map((oldIdx, newIdx) => [oldIdx, newIdx]));
  const sortedAssets = order.map((i) => assets[i]);
  const sortedKinds = order.map((i) => kinds[i]);
  for (const t of tiles) t.assets = t.assets.map((i) => remap.get(i)!).sort((a, b) => a - b);
  tiles.sort((a, b) => a.y - b.y || a.x - b.x);

  o.emit('app', `Unikatowych assetów na mapie: ${sortedAssets.length}. Kopiuję z folderu OMSI…`);
  const dstRoot = assetsDir(o.workDir);
  fs.mkdirSync(dstRoot, { recursive: true });
  const missing: string[] = [];
  let copied = 0;
  let unchanged = 0;
  await mapLimit(sortedAssets, 8, async (rel) => {
    const src = safeJoin(o.omsiDir, rel);
    const dst = safeJoin(dstRoot, rel);
    if (!src || !dst || !fs.existsSync(src) || !fs.statSync(src).isFile()) {
      missing.push(rel);
      return;
    }
    if (await sameFile(src, dst)) {
      unchanged++;
      return;
    }
    await fs.promises.mkdir(path.dirname(dst), { recursive: true });
    await fs.promises.copyFile(src, dst);
    copied++;
  });
  missing.sort((a, b) => a.localeCompare(b));
  o.emit(
    'app',
    `Assety: skopiowano ${copied}, bez zmian ${unchanged}, brak w folderze OMSI ${missing.length}.`,
  );
  if (missing.length) {
    o.emit('app', `Brakujące (pierwsze 10): ${missing.slice(0, 10).join(', ')}`);
  }

  // Drzewo obiektów: czytamy skopiowane pliki obiektów (.sco) — [groups] i [friendlyname]
  const missingSet = new Set(missing.map((m) => m.toLowerCase()));
  const objects: ObjectEntry[] = [];
  const objectIdx = sortedAssets.map((_, i) => i).filter((i) => sortedKinds[i] & KIND_BIT.object);
  await mapLimit(objectIdx, 8, async (i) => {
    const rel = sortedAssets[i];
    const base = rel.split('/').pop()!.replace(/\.[^.]*$/, '');
    const dst = safeJoin(dstRoot, rel);
    if (!dst || missingSet.has(rel.toLowerCase())) {
      objects.push({ a: i, n: base, g: [], k: false });
      return;
    }
    try {
      const info = parseSco(decodeCfg(await fs.promises.readFile(dst)).text);
      objects.push({ a: i, n: info.name || base, g: info.groups, k: true });
    } catch {
      objects.push({ a: i, n: base, g: [], k: false });
    }
  });
  objects.sort((x, y) => x.a - y.a);
  o.emit('app', `Obiektów (.sco) wczytanych do drzewa: ${objects.filter((x) => x.k).length}/${objects.length}.`);

  tileSplines.sort((a, b) => a.y - b.y || a.x - b.x);
  const splineData = buildSplinesData(tileSplines, extentFromAssets(dstRoot), pathsFromAssets(dstRoot));
  fs.writeFileSync(splinesPath(o.workDir), JSON.stringify(splineData), 'utf-8');
  o.emit('app', `Splinów do narysowania na mapie: ${splineData.tiles.reduce((n, t) => n + t.s.length, 0)}.`);

  const index: MapIndex = {
    version: 2,
    indexedAt: Date.now(),
    mapFolder: o.mapFolder,
    tiles,
    assets: sortedAssets,
    assetKinds: sortedKinds,
    missingAssets: missing,
    objects,
  };
  fs.writeFileSync(indexPath(o.workDir), JSON.stringify(index), 'utf-8');
  return index;
}

export function loadMapIndex(workDir: string): MapIndex | null {
  try {
    const idx = JSON.parse(fs.readFileSync(indexPath(workDir), 'utf-8')) as MapIndex;
    return idx.version === 2 && Array.isArray(idx.tiles) ? idx : null;
  } catch {
    return null;
  }
}

/** Lekki widok dla interfejsu (bez list ścieżek). */
export function toOverview(index: MapIndex): MapOverview {
  const missing = new Set(index.missingAssets.map((m) => m.toLowerCase()));
  const isMissing = index.assets.map((a) => missing.has(a.toLowerCase()));
  const tiles: MapTileView[] = index.tiles.map((t) => ({
    x: t.x,
    y: t.y,
    file: t.file,
    exists: t.exists,
    assetCount: t.assets.length,
    missingCount: t.assets.filter((i) => isMissing[i]).length,
  }));
  return {
    mapFolder: index.mapFolder,
    tiles,
    assetCount: index.assets.length,
    missingCount: index.missingAssets.length,
    indexedAt: index.indexedAt,
  };
}

/** Katalog jezdni i obiektów dla zakładek Jezdnie i Obiekty. */
export function toCatalog(index: MapIndex): MapCatalog {
  const missing = new Set(index.missingAssets.map((m) => m.toLowerCase()));
  const tileCount = new Array<number>(index.assets.length).fill(0);
  for (const t of index.tiles) for (const i of t.assets) tileCount[i]++;

  const roads: RoadView[] = [];
  index.assets.forEach((p, i) => {
    if (index.assetKinds[i] & KIND_BIT.spline) {
      roads.push({ path: p, tileCount: tileCount[i], missing: missing.has(p.toLowerCase()) });
    }
  });
  const objects: ObjectView[] = index.objects.map((e) => ({
    path: index.assets[e.a],
    name: e.n,
    groups: e.g,
    tileCount: tileCount[e.a],
    missing: missing.has(index.assets[e.a].toLowerCase()),
    known: e.k,
  }));
  return { roads, objects };
}
