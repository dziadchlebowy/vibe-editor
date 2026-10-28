import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { MapOverview, MapTileView } from '../../shared/types.ts';
import type { Emit } from './emit.ts';
import { decodeCfg } from './globalCfg.ts';

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

export interface MapIndex {
  version: 1;
  indexedAt: number;
  mapFolder: string;
  tiles: IndexedTile[];
  /** Unikatowe ścieżki assetów (względem folderu OMSI, separator „/”). */
  assets: string[];
  /** Assety, których nie ma w folderze OMSI. */
  missingAssets: string[];
}

export const INDEX_FILE = 'map-index.json';

/** Znaczniki, pod którymi (dwie linijki niżej) stoi ścieżka assetu — porównywane małymi literami. */
const ASSET_MARKERS = new Set(['[spline]', '[spline_h]', '[object]', '[splineattachement]', '[attachobj]']);
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

/**
 * Skanuje plik .map strumieniowo (kafle bywają duże) i zwraca unikatowe ścieżki spod znaczników
 * [spline], [spline_h], [object], [splineAttachement], [attachObj] — dwie linijki pod znacznikiem.
 */
export async function scanTileAssets(file: string): Promise<string[]> {
  const found = new Map<string, string>(); // klucz małymi literami → pierwsza pisownia
  const add = (raw: string, latin1: boolean): void => {
    const t = raw.trim();
    const norm = t ? normalizeAssetPath(latin1 ? fromLatin1(t) : t) : null;
    if (norm && !found.has(norm.toLowerCase())) found.set(norm.toLowerCase(), norm);
  };
  let pending = 0;
  const feed = (line: string, latin1: boolean): void => {
    const t = line.trim();
    if (t.startsWith('[')) {
      pending = ASSET_MARKERS.has(t.toLowerCase()) ? PATH_OFFSET : 0;
      return;
    }
    if (pending > 0 && --pending === 0) add(t, latin1);
  };

  const bom = await readBom(file);
  if (bom === 'utf-16be') {
    // rzadkie: zamiana bajtów wymaga całego pliku
    const text = decodeCfg(await fs.promises.readFile(file)).text;
    for (const line of text.split(/\r\n|\n|\r/)) feed(line, false);
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
  const tiles: IndexedTile[] = refs.map((r) => ({ ...r, exists: false, assets: [] }));

  let done = 0;
  await mapLimit(tiles, 4, async (tile) => {
    const full = safeJoin(mapDir, tile.file);
    if (full && fs.existsSync(full)) {
      tile.exists = true;
      try {
        const paths = await scanTileAssets(full);
        tile.assets = paths.map((p) => {
          const key = p.toLowerCase();
          let idx = registry.get(key);
          if (idx === undefined) {
            idx = assets.push(p) - 1;
            registry.set(key, idx);
          }
          return idx;
        });
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

  const index: MapIndex = {
    version: 1,
    indexedAt: Date.now(),
    mapFolder: o.mapFolder,
    tiles,
    assets: sortedAssets,
    missingAssets: missing,
  };
  fs.writeFileSync(indexPath(o.workDir), JSON.stringify(index), 'utf-8');
  return index;
}

export function loadMapIndex(workDir: string): MapIndex | null {
  try {
    const idx = JSON.parse(fs.readFileSync(indexPath(workDir), 'utf-8')) as MapIndex;
    return idx.version === 1 && Array.isArray(idx.tiles) ? idx : null;
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
