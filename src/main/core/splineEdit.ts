import fs from 'node:fs';
import path from 'node:path';
import type { NewSplineReq, SplinePoint, SplinePointRef } from '../../shared/types.ts';
import { moveSplines, newSpline, newSplineStartAt, splineEndPose, splineEndZ, type EditSpline, type PointSel } from '../../shared/splineEdit.ts';
import { decodeCfg, encodeCfg, splitLines } from './globalCfg.ts';
import { assetsDir, type TileRef } from './mapIndex.ts';
import { buildSplinesData, extentFromAssets, loadMapSplines, pathsFromAssets, splinesPath, type RawSpline } from './mapSplines.ts';
import { fmt, maxId, setSplineLink, splineInsertAt } from './pathLink.ts';
import { cachedTile, readTiles } from './tripRoute.ts';

const origin = (t: TileRef): [number, number] => [(t.x - 0.5) * 300, (t.y - 0.5) * 300];

/** Spline z kafla jako EditSpline (metry świata). */
export function toEditSpline(sp: RawSpline, t: TileRef, tileIdx: number): EditSpline {
  const [ox, oy] = origin(t);
  return {
    id: sp.id,
    tile: tileIdx,
    kind: sp.kind,
    path: sp.path,
    mirror: sp.mirror,
    x: ox + sp.x,
    y: oy + sp.y,
    heading: sp.heading,
    length: sp.length,
    radius: sp.radius,
    z: sp.z,
    dz: sp.dz,
    pitch0: sp.pitch0,
    pitch1: sp.pitch1,
    skew0: sp.skew0,
    skew1: sp.skew1,
    prev: sp.prev,
    next: sp.next,
  };
}

function pointOf(s: EditSpline, end: 'start' | 'end'): SplinePoint {
  const p = splineEndPose(s, end);
  return {
    splineId: s.id,
    end,
    tile: s.tile,
    x: p.x / 300,
    y: p.y / 300,
    z: splineEndZ(s, end),
    heading: p.heading,
    pitch: end === 'start' ? s.pitch0 : s.pitch1,
    linked: end === 'start' ? s.prev : s.next,
    path: s.path,
  };
}

/** Spliny z kafli: kafel pod punktem (jednostki kafli) i 8 sąsiednich. */
function splinesAround(mapDir: string, x: number, y: number): EditSpline[] {
  const tiles = readTiles(mapDir);
  if (!tiles) return [];
  const [tx, ty] = [Math.round(x), Math.round(y)];
  const out: EditSpline[] = [];
  tiles.forEach((t, ti) => {
    if (Math.abs(t.x - tx) > 1 || Math.abs(t.y - ty) > 1) return;
    for (const sp of cachedTile(path.join(mapDir, t.file))?.splines ?? []) out.push(toEditSpline(sp, t, ti));
  });
  return out;
}

/**
 * Najbliższy koniec splinu wokół punktu (x, y) w jednostkach kafli, nie dalej niż maxDistM metrów, razem ze wszystkimi
 * końcami leżącymi w tym samym miejscu (≤ 0,3 m) — węzeł złożony z kilku splinów zaznacza się naraz.
 */
export function pickSplinePoints(mapDir: string, x: number, y: number, maxDistM: number): SplinePoint[] {
  const all = splinesAround(mapDir, x, y).flatMap((s) => (['start', 'end'] as const).map((end) => pointOf(s, end)));
  let best: SplinePoint | null = null;
  let bd = Infinity;
  for (const p of all) {
    const d = Math.hypot((p.x - x) * 300, (p.y - y) * 300);
    if (d <= maxDistM && d < bd) (bd = d, (best = p));
  }
  if (!best) return [];
  const b: SplinePoint = best;
  return all.filter((p) => Math.hypot((p.x - b.x) * 300, (p.y - b.y) * 300) <= 0.3);
}

/** Spliny wskazanych końców (bez powtórzeń) w metrach świata. */
export function loadEditSplines(mapDir: string, refs: SplinePointRef[]): EditSpline[] {
  const tiles = readTiles(mapDir);
  if (!tiles) return [];
  const seen = new Set<string>();
  const out: EditSpline[] = [];
  for (const r of refs) {
    const key = `${r.tile}:${r.splineId}`;
    const t = tiles[r.tile];
    if (!t || seen.has(key)) continue;
    seen.add(key);
    const sp = cachedTile(path.join(mapDir, t.file))?.splines.find((s) => s.id === r.splineId);
    if (sp) out.push(toEditSpline(sp, t, r.tile));
  }
  return out;
}

// --- zapis rekordów ---------------------------------------------------------------------------------

interface TileEdit {
  lines: string[];
  dec: ReturnType<typeof decodeCfg>;
  full: string;
}

function openTile(mapDir: string, tiles: TileRef[], ti: number, cache: Map<number, TileEdit>): TileEdit | null {
  const hit = cache.get(ti);
  if (hit) return hit;
  const full = path.join(mapDir, tiles[ti].file);
  if (!fs.existsSync(full)) return null;
  const dec = decodeCfg(fs.readFileSync(full));
  const e = { lines: splitLines(dec.text), dec, full };
  cache.set(ti, e);
  return e;
}

function saveTiles(cache: Map<number, TileEdit>): void {
  for (const e of cache.values()) {
    if (!fs.existsSync(`${e.full}.bak`)) fs.copyFileSync(e.full, `${e.full}.bak`);
    const eol = e.dec.text.includes('\r\n') ? '\r\n' : '\n';
    fs.writeFileSync(e.full, encodeCfg(e.lines.join(eol), e.dec.encoding, e.dec.bom));
  }
}

/** Nadpisuje w pliku kafla pola splinu (położenie, azymut, długość, promień, wysokość, dz); zwykły [spline] z dz ≠ 0 staje się [spline_h]. */
export function rewriteSplineRecord(lines: string[], n: EditSpline, xLocal: number, yLocal: number): string | null {
  const m = lines.findIndex((l, i) => {
    const t = l.trim().toLowerCase();
    return (t === '[spline]' || t === '[spline_h]') && (lines[i + 3] ?? '').trim() === n.id;
  });
  if (m < 0) return `Nie znaleziono splinu ${n.id} w pliku kafla.`;
  const idx: number[] = [];
  for (let j = m + 1; j < lines.length; j++) {
    const t = lines[j].trim();
    if (t.startsWith('[')) break;
    if (t) idx.push(j);
  }
  if (idx.length < 17) return `Spline ${n.id} ma nieoczekiwany układ pól.`;
  const wasH = lines[m].trim().toLowerCase() === '[spline_h]';
  const head = [fmt(xLocal), fmt(n.z), fmt(yLocal), fmt(n.heading), fmt(n.length), fmt(n.radius)];
  if (wasH || n.kind === 'spline') {
    head.forEach((v, k) => {
      if (Math.abs(Number(lines[idx[5 + k]].trim().replace(',', '.')) - Number(v)) > 1e-9) lines[idx[5 + k]] = v;
    });
    if (wasH && idx.length > 13 && Math.abs(Number(lines[idx[13]].trim().replace(',', '.')) - n.dz) > 1e-9) lines[idx[13]] = fmt(n.dz);
    return null;
  }
  // zwykły [spline] → [spline_h]: tail (7 liczb: cztery zera, dwa parametry profilu, przesunięcie tekstury) → 8 liczb z dz
  const tail = idx.slice(11).map((i) => lines[i].trim());
  const nums = tail.filter((t) => t.toLowerCase() !== 'mirror');
  if (nums.length !== 7 || nums.slice(0, 4).some((v) => Math.abs(Number(v.replace(',', '.'))) > 1e-9)) return `Spline ${n.id} ma nieoczekiwane parametry — nie da się zmienić jego wysokości po jednym końcu.`;
  const rec = [
    '[spline_h]',
    ...idx.slice(0, 5).map((i) => lines[i].trim()),
    ...head,
    '0',
    '0',
    fmt(n.dz),
    '0',
    '0',
    nums[4],
    nums[5],
    nums[6],
    ...(tail.some((t) => t.toLowerCase() === 'mirror') ? ['mirror'] : []),
  ];
  lines.splice(m, idx[idx.length - 1] - m + 1, ...rec);
  return null;
}

/** Odświeża indeks splinów (map-splines.json) dla podanych kafli po zapisie — zmiany widać od razu, bez przeskanowania mapy. */
export function refreshSplinesIndex(workDir: string, mapDir: string, tileIdxs: number[]): void {
  const data = loadMapSplines(workDir);
  const tiles = readTiles(mapDir);
  if (!data || !tiles) return;
  const assets = assetsDir(workDir);
  const wanted = new Set(tileIdxs);
  const fresh = buildSplinesData(
    tiles.flatMap((t, i) => (wanted.has(i) ? [{ x: t.x, y: t.y, splines: cachedTile(path.join(mapDir, t.file))?.splines ?? [] }] : [])),
    extentFromAssets(assets),
    pathsFromAssets(assets),
  );
  // numery dróg z fresh odnoszą się do jego własnej listy — przenosimy je na listę dróg indeksu (dopisując brakujące)
  const roadIdx = new Map(data.roads.map((r, i) => [r.p.toLowerCase(), i]));
  const mapRoad = fresh.roads.map((r) => {
    const k = r.p.toLowerCase();
    let i = roadIdx.get(k);
    if (i === undefined) {
      i = data.roads.push(r) - 1;
      roadIdx.set(k, i);
    }
    return i;
  });
  for (const ft of fresh.tiles) {
    const s = ft.s.map((t) => [mapRoad[t[0]], ...t.slice(1)]);
    const at = data.tiles.findIndex((t) => t.x === ft.x && t.y === ft.y);
    if (at >= 0) data.tiles[at] = { x: ft.x, y: ft.y, s };
    else data.tiles.push({ x: ft.x, y: ft.y, s });
  }
  fs.writeFileSync(splinesPath(workDir), JSON.stringify(data));
}

/** Przesuwa zaznaczone końce splinów (patrz moveSplines) i zapisuje kafle; zwraca indeksy zmienionych kafli. */
export function applySplineEdit(mapDir: string, refs: SplinePointRef[], dx: number, dy: number, dz: number, arc = true): { ok: boolean; error?: string; tiles?: number[] } {
  const tiles = readTiles(mapDir);
  if (!tiles) return { ok: false, error: 'Brak pliku global.cfg w folderze mapy.' };
  if (![dx, dy, dz].every(Number.isFinite)) return { ok: false, error: 'Nieprawidłowe przesunięcie.' };
  const sel: PointSel[] = refs.map((r) => ({ splineId: r.splineId, end: r.end }));
  const res = moveSplines(loadEditSplines(mapDir, refs), sel, dx, dy, dz, arc);
  if (res.error) return { ok: false, error: res.error };
  if (res.splines.length === 0) return { ok: false, error: 'Nie znaleziono zaznaczonych splinów.' };
  const cache = new Map<number, TileEdit>();
  for (const n of res.splines) {
    const [ox, oy] = origin(tiles[n.tile]);
    const [xl, yl] = [n.x - ox, n.y - oy];
    // spline jest zapisany w kaflu, w którym leży jego początek — przeniesienie do sąsiedniego kafla nie jest obsługiwane
    if (xl < 0 || xl >= 300 || yl < 0 || yl >= 300) return { ok: false, error: `Początek splinu ${n.id} wyszedłby poza kafel, w którym jest zapisany — przesuń o mniej.` };
    const e = openTile(mapDir, tiles, n.tile, cache);
    if (!e) return { ok: false, error: 'Nie ma pliku kafla splinu.' };
    const err = rewriteSplineRecord(e.lines, n, xl, yl);
    if (err) return { ok: false, error: err };
  }
  saveTiles(cache);
  return { ok: true, tiles: [...cache.keys()] };
}

/** Tworzy nowy spline ([spline_h]) od końca istniejącego splinu albo od dowolnego punktu do punktu końcowego. */
export function createSpline(mapDir: string, req: NewSplineReq): { ok: boolean; error?: string; id?: string; tiles?: number[] } {
  const tiles = readTiles(mapDir);
  if (!tiles) return { ok: false, error: 'Brak pliku global.cfg w folderze mapy.' };
  if (![req.startX, req.startY, req.startZ, req.endX, req.endY].every(Number.isFinite)) return { ok: false, error: 'Nieprawidłowe współrzędne.' };
  const sli = req.sli.trim().replace(/\//g, '\\');
  if (!/\.sli$/i.test(sli)) return { ok: false, error: 'Podaj ścieżkę do pliku .sli (np. Splines\\invis_street.sli).' };

  let source: EditSpline | null = null;
  let start = { x: req.startX * 300, y: req.startY * 300, z: req.startZ } as ReturnType<typeof newSplineStartAt>;
  if (req.from) {
    source = loadEditSplines(mapDir, [req.from])[0] ?? null;
    if (!source) return { ok: false, error: 'Nie znaleziono splinu, od którego zaczyna się nowy.' };
    start = newSplineStartAt(source, req.from.end);
  }
  const g = newSpline(start, req.endX * 300, req.endY * 300, req.arc !== false);
  if (typeof g === 'string') return { ok: false, error: g };

  const tx = Math.floor(g.x / 300 + 0.5);
  const ty = Math.floor(g.y / 300 + 0.5);
  const ti = tiles.findIndex((t) => t.x === tx && t.y === ty);
  if (ti < 0) return { ok: false, error: `Początek nowego splinu leży poza kaflami mapy (kafel ${tx}, ${ty}).` };
  const cache = new Map<number, TileEdit>();
  const home = openTile(mapDir, tiles, ti, cache);
  if (!home) return { ok: false, error: 'Nie ma pliku kafla dla nowego splinu.' };
  const id = String(maxId(mapDir, tiles) + 1);
  // przyłączenie tylko, gdy nowy spline wychodzi z wolnego KOŃCA splinu źródłowego (zgodnie z jego kierunkiem)
  let prev = '0';
  if (source && req.from?.end === 'end' && source.next === '0') {
    const se = openTile(mapDir, tiles, source.tile, cache);
    if (se && setSplineLink(se.lines, source.id, 'next', id)) prev = source.id;
  }
  const [ox, oy] = origin(tiles[ti]);
  const rec = [
    '[spline_h]',
    '0',
    sli,
    id,
    prev,
    '0',
    fmt(g.x - ox),
    fmt(g.z),
    fmt(g.y - oy),
    fmt(g.heading),
    fmt(g.length),
    fmt(g.radius),
    fmt(g.pitch0),
    fmt(g.pitch1),
    fmt(g.dz),
    '0',
    '0',
    '0',
    '0',
    '0',
    '',
  ];
  home.lines.splice(splineInsertAt(home.lines), 0, ...rec);
  saveTiles(cache);
  return { ok: true, id, tiles: [...cache.keys()] };
}

/** Zakres linii rekordu splinu w pliku kafla: od znacznika do pierwszego znacznika innego niż [rule] (bloki [rule] należą do splinu). */
function recordRange(lines: string[], id: string): [number, number] | null {
  const m = lines.findIndex((l, i) => {
    const t = l.trim().toLowerCase();
    return (t === '[spline]' || t === '[spline_h]') && (lines[i + 3] ?? '').trim() === id;
  });
  if (m < 0) return null;
  let e = m + 1;
  for (; e < lines.length; e++) {
    const t = lines[e].trim();
    if (t.startsWith('[') && t.toLowerCase() !== '[rule]') break;
  }
  return [m, e];
}

/**
 * Usuwa spliny, do których należą wskazane końce (razem z ich blokami [rule]), i zeruje odnośniki prev/next innych
 * splinów (w każdym kaflu mapy) wskazujące na usunięte. Usunięcie przesuwa numery elementów na kaflu późniejszych
 * splinów z pojazdami — wpisy .ttr tras, które po nich następują, trzeba potem sprawdzić.
 */
export function deleteSplines(mapDir: string, refs: SplinePointRef[]): { ok: boolean; error?: string; ids?: string[]; tiles?: number[] } {
  const tiles = readTiles(mapDir);
  if (!tiles) return { ok: false, error: 'Brak pliku global.cfg w folderze mapy.' };
  const targets = [...new Map(refs.map((r) => [`${r.tile}:${r.splineId}`, r])).values()];
  if (targets.length === 0) return { ok: false, error: 'Nie wskazano splinów do usunięcia.' };
  const ids = new Set(targets.map((r) => r.splineId));
  const cache = new Map<number, TileEdit>();
  for (const r of targets) {
    if (!tiles[r.tile]) return { ok: false, error: 'Nieprawidłowy kafel splinu.' };
    const e = openTile(mapDir, tiles, r.tile, cache);
    const range = e ? recordRange(e.lines, r.splineId) : null;
    if (!e || !range) return { ok: false, error: `Nie znaleziono splinu ${r.splineId} w pliku kafla.` };
    e.lines.splice(range[0], range[1] - range[0]);
  }
  // odnośniki innych splinów do usuniętych: w całej mapie (spline może łączyć się przez granicę kafla)
  tiles.forEach((t, ti) => {
    const e = cache.get(ti) ?? (fs.existsSync(path.join(mapDir, t.file)) ? null : undefined);
    if (e === undefined) return;
    const edit = e ?? openTile(mapDir, tiles, ti, new Map());
    if (!edit) return;
    let changed = false;
    edit.lines.forEach((l, i) => {
      const m = l.trim().toLowerCase();
      if (m !== '[spline]' && m !== '[spline_h]') return;
      for (const off of [4, 5]) {
        if (ids.has((edit.lines[i + off] ?? '').trim())) {
          edit.lines[i + off] = '0';
          changed = true;
        }
      }
    });
    if (changed) cache.set(ti, edit);
  });
  saveTiles(cache);
  return { ok: true, ids: [...ids], tiles: [...cache.keys()] };
}
