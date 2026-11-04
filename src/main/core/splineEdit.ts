import fs from 'node:fs';
import path from 'node:path';
import type { NewSplineReq, SplineIssue, SplinePoint, SplinePointRef } from '../../shared/types.ts';
import { alignJoin, moveSplines, newSpline, newSplineStartAt, splineEndPose, splineEndZ, type EditSpline, type PointSel } from '../../shared/splineEdit.ts';
import { angDiff } from '../../shared/arcs.ts';
import { decodeCfg, splitLines } from './globalCfg.ts';
import { writeTiles } from './undo.ts';
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

function saveTiles(cache: Map<number, TileEdit>, label: string): void {
  writeTiles(cache, label);
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
    if (wasH && idx.length > 15) {
      // nachylenie na początku i końcu, różnica wysokości, skew na początku i końcu
      [n.pitch0, n.pitch1, n.dz, n.skew0, n.skew1].forEach((v, k) => {
        if (Math.abs(Number(lines[idx[11 + k]].trim().replace(',', '.')) - v) > 1e-9) lines[idx[11 + k]] = fmt(v);
      });
    }
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
    fmt(n.pitch0),
    fmt(n.pitch1),
    fmt(n.dz),
    fmt(n.skew0),
    fmt(n.skew1),
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
  // kafle, w których po zmianie nie zostały żadne spliny (np. po usunięciu), znikają z indeksu zamiast zostać nieaktualne
  const coords = new Set(tiles.flatMap((t, i) => (wanted.has(i) ? [`${t.x},${t.y}`] : [])));
  data.tiles = data.tiles.filter((t) => !coords.has(`${t.x},${t.y}`));
  for (const ft of fresh.tiles) data.tiles.push({ x: ft.x, y: ft.y, s: ft.s.map((t) => [mapRoad[t[0]], ...t.slice(1)]) });
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
  saveTiles(cache, 'Przesunięcie punktów splinów');
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
  saveTiles(cache, 'Nowy spline');
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
  saveTiles(cache, 'Usunięcie splinów');
  return { ok: true, ids: [...ids], tiles: [...cache.keys()] };
}

/** Końce splinów (jednostki kafli) leżące w prostokącie (x0, y0)–(x1, y1) — zaznaczanie prostokątem. */
export function pickSplinePointsInBox(mapDir: string, x0: number, y0: number, x1: number, y1: number): SplinePoint[] {
  const tiles = readTiles(mapDir);
  if (!tiles) return [];
  const [minX, maxX, minY, maxY] = [Math.min(x0, x1), Math.max(x0, x1), Math.min(y0, y1), Math.max(y0, y1)];
  const out: SplinePoint[] = [];
  tiles.forEach((t, ti) => {
    // spline może wystawać poza kafel, w którym jest zapisany — bierzemy kafle przylegające do prostokąta
    if (t.x < Math.round(minX) - 1 || t.x > Math.round(maxX) + 1 || t.y < Math.round(minY) - 1 || t.y > Math.round(maxY) + 1) return;
    for (const sp of cachedTile(path.join(mapDir, t.file))?.splines ?? []) {
      const e = toEditSpline(sp, t, ti);
      for (const end of ['start', 'end'] as const) {
        const p = pointOf(e, end);
        if (p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY && out.length < 3000) out.push(p);
      }
    }
  });
  return out;
}

/** Progi kontroli: odchylenie ≥ próg = problem. */
const CHECK = { gap: 0.02, heading: 0.1, height: 0.002, pitch: 0.05, skew: 0.05 };

/**
 * Kontrola spójności splinów całej mapy: dla każdego odnośnika next porównuje koniec splinu A z początkiem B
 * (przerwa, azymut, wysokość, nachylenie, skew) oraz symetrię odnośników prev/next i istnienie splinu docelowego.
 */
export function checkSplines(mapDir: string): SplineIssue[] {
  const tiles = readTiles(mapDir);
  if (!tiles) return [];
  const all: EditSpline[] = [];
  tiles.forEach((t, ti) => {
    for (const sp of cachedTile(path.join(mapDir, t.file))?.splines ?? []) all.push(toEditSpline(sp, t, ti));
  });
  const byId = new Map<string, EditSpline>();
  for (const s of all) if (!byId.has(s.id)) byId.set(s.id, s);
  const issues: SplineIssue[] = [];
  const seen = new Set<string>();
  const ref = (s: EditSpline, end: 'start' | 'end'): SplinePointRef => ({ splineId: s.id, end, tile: s.tile });
  const push = (i: Omit<SplineIssue, 'fixable'> & { fixable?: boolean }): void => {
    const key = `${i.kind}:${i.a.splineId}:${i.b?.splineId ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    issues.push({ fixable: false, ...i });
  };
  for (const a of all) {
    if (a.next !== '0') {
      const b = byId.get(a.next);
      const ea = splineEndPose(a, 'end');
      if (!b) {
        push({ kind: 'missing', severity: 100, a: ref(a, 'end'), b: null, x: ea.x / 300, y: ea.y / 300, text: `Spline ${a.id}: koniec wskazuje spline ${a.next}, którego nie ma na mapie.` });
        continue;
      }
      const sb = splineEndPose(b, 'start');
      const gap = Math.hypot(ea.x - sb.x, ea.y - sb.y);
      const base = { a: ref(a, 'end'), b: ref(b, 'start'), x: ea.x / 300, y: ea.y / 300 };
      if (b.prev !== a.id) push({ ...base, kind: 'link', severity: 50, text: `Spline ${a.id} → ${b.id}: odnośniki niesymetryczne (początek ${b.id} wskazuje ${b.prev === '0' ? 'brak' : b.prev}).` });
      const hd = angDiff(ea.heading, sb.heading);
      const dz = Math.abs(splineEndZ(a, 'end') - splineEndZ(b, 'start'));
      const dp = Math.abs(a.pitch1 - b.pitch0);
      const dk = Math.abs(a.skew1 - b.skew0);
      if (gap >= CHECK.gap) push({ ...base, kind: 'gap', severity: gap / CHECK.gap, text: `Spline ${a.id} → ${b.id}: przerwa ${gap.toFixed(3)} m między końcem a początkiem.` });
      if (hd >= CHECK.heading) push({ ...base, kind: 'heading', severity: hd / CHECK.heading, text: `Spline ${a.id} → ${b.id}: załamek azymutu ${hd.toFixed(2)}°.` });
      if (dz >= CHECK.height) push({ ...base, kind: 'height', severity: dz / CHECK.height, fixable: true, text: `Spline ${a.id} → ${b.id}: skok wysokości ${dz.toFixed(3)} m.` });
      if (dp >= CHECK.pitch) push({ ...base, kind: 'pitch', severity: dp / CHECK.pitch, fixable: true, text: `Spline ${a.id} → ${b.id}: załamek nachylenia ${dp.toFixed(2)}° (${a.pitch1.toFixed(2)}° → ${b.pitch0.toFixed(2)}°).` });
      if (dk >= CHECK.skew) push({ ...base, kind: 'skew', severity: dk / CHECK.skew, fixable: true, text: `Spline ${a.id} → ${b.id}: różnica skew ${dk.toFixed(2)}.` });
    }
    if (a.prev !== '0' && !byId.has(a.prev)) {
      const sa = splineEndPose(a, 'start');
      push({ kind: 'missing', severity: 100, a: ref(a, 'start'), b: null, x: sa.x / 300, y: sa.y / 300, text: `Spline ${a.id}: początek wskazuje spline ${a.prev}, którego nie ma na mapie.` });
    }
  }
  return issues.sort((p, q) => q.severity - p.severity).slice(0, 300);
}

/** Wyrównuje połączenie koniec splinu A → początek splinu B (patrz alignJoin) i zapisuje kafle. */
export function alignSplines(mapDir: string, a: SplinePointRef, b: SplinePointRef): { ok: boolean; error?: string; tiles?: number[] } {
  const tiles = readTiles(mapDir);
  if (!tiles) return { ok: false, error: 'Brak pliku global.cfg w folderze mapy.' };
  const [sa, sb] = [loadEditSplines(mapDir, [a])[0], loadEditSplines(mapDir, [b])[0]];
  if (!sa || !sb) return { ok: false, error: 'Nie znaleziono splinów połączenia.' };
  const r = alignJoin(sa, sb);
  const cache = new Map<number, TileEdit>();
  for (const n of [r.a, r.b]) {
    const [ox, oy] = origin(tiles[n.tile]);
    const e = openTile(mapDir, tiles, n.tile, cache);
    if (!e) return { ok: false, error: 'Nie ma pliku kafla splinu.' };
    const err = rewriteSplineRecord(e.lines, n, n.x - ox, n.y - oy);
    if (err) return { ok: false, error: err };
  }
  saveTiles(cache, 'Wyrównanie połączenia splinów');
  return { ok: true, tiles: [...cache.keys()] };
}
