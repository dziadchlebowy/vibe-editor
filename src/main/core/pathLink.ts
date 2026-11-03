import fs from 'node:fs';
import path from 'node:path';
import { angDiff, arcEnd, arcPoints, biarc, connectArcs, deg, hermite, rad, type NodePose, type PlannedArc, type Pose } from '../../shared/arcs.ts';
import type { LinkEnd, LinkEndRef, LinkNode, LinkNodeRef, LinkPlan } from '../../shared/types.ts';
import { decodeCfg, encodeCfg, splitLines } from './globalCfg.ts';
import { assetsDir, safeJoin, type TileRef } from './mapIndex.ts';
import type { RawSpline } from './mapSplines.ts';
import { cachedAsset, cachedTile, pathBlocks, readTiles } from './tripRoute.ts';

/** Spline łączący: „invis_street.sli” leży w OMSI luzem w Splines (kopia w _vibe/assets/Splines), ma jedną ścieżkę dla pojazdów. */
export const LINK_SLI = 'Splines/invis_street.sli';
const LINK_SLI_IN_MAP = 'Splines\\invis_street.sli';

export interface PlannedSpline extends PlannedArc {
  /** Wysokość osi splinu na początku, nachylenia i skew na końcach, różnica wysokości. */
  z: number;
  pitch0: number;
  pitch1: number;
  dz: number;
  skew0: number;
  skew1: number;
}

/**
 * Łączenie od `from` do `to` (kierunek splinów): łuki w poziomie, a wysokość zmienia się płynnie jedną krzywą Hermite’a
 * na całej długości (nachylenia na końcach = nachylenia końców, na styku łuków — ciągłe), skew rośnie liniowo od wartości
 * `from` do wartości `to`. `pathHeight` = wysokość ścieżki łączącego splinu nad jego nawierzchnią (z invis_street.sli).
 */
export function planConnector(from: NodePose, to: NodePose, pathHeight: number): PlannedSpline[] | string {
  const arcs = connectArcs(from, to);
  if (typeof arcs === 'string') return arcs;
  const total = arcs.reduce((n, a) => n + a.length, 0);
  const z0 = from.z - pathHeight;
  const dz = to.z - from.z;
  const f = hermite(total, from.pitch, to.pitch, dz);
  let s = 0;
  return arcs.map((a, i) => {
    const s0 = s;
    const s1 = s + a.length;
    s = s1;
    const first = i === 0;
    const last = i === arcs.length - 1;
    const lerp = (u: number): number => from.skew + ((to.skew - from.skew) * u) / total;
    return {
      ...a,
      z: z0 + f(s0).h,
      pitch0: first ? from.pitch : deg(Math.atan(f(s0).slope)),
      pitch1: last ? to.pitch : deg(Math.atan(f(s1).slope)),
      dz: f(s1).h - f(s0).h,
      skew0: first ? from.skew : lerp(s0),
      skew1: last ? to.skew : lerp(s1),
    };
  });
}

export { arcEnd, biarc, connectArcs, hermite };
export type { Pose };

// --- węzły ścieżek ----------------------------------------------------------------------------------

const isVehiclePath = (v: number[]): boolean => v.length >= 5 && (v[0] === 0 || v[0] === 2);

/** Węzeł (koniec splinu × ścieżka ruchu) w jednostkach kafli. v = liczby [path] z .sli: typ, x, wysokość, szerokość, kierunek. */
export function buildNode(sp: RawSpline, t: TileRef, tileIdx: number, sli: string, pathIndex: number, v: number[], end: 'start' | 'end'): LinkNode {
  const axis = end === 'start' ? { x: sp.x, y: sp.y, heading: sp.heading } : arcEnd({ x: sp.x, y: sp.y, heading: sp.heading, length: sp.length, radius: sp.radius });
  const lateral = v[1] * (sp.mirror ? -1 : 1);
  const phi = rad(axis.heading);
  const [ox, oy] = [(t.x - 0.5) * 300, (t.y - 0.5) * 300];
  const px = axis.x + Math.cos(phi) * lateral;
  const py = axis.y - Math.sin(phi) * lateral;
  const axisHeight = sp.z + (end === 'end' ? sp.dz : 0);
  // ruch odwrócony względem kierunku splinu: kierunek ścieżki w .sli (1) albo odbicie splinu (mirror), ale nie oba naraz
  const travelReversed = v[4] === 1 !== sp.mirror;
  return {
    splineId: sp.id,
    pathIndex,
    end,
    tile: tileIdx,
    x: (ox + px) / 300,
    y: (oy + py) / 300,
    ax: (ox + axis.x) / 300,
    ay: (oy + axis.y) / 300,
    heading: axis.heading,
    height: axisHeight + v[2],
    axisHeight,
    pathHeight: v[2],
    pitch: end === 'start' ? sp.pitch0 : sp.pitch1,
    skew: end === 'start' ? sp.skew0 : sp.skew1,
    lateral,
    exits: end === 'end' ? !travelReversed : travelReversed,
    linked: end === 'start' ? sp.prev : sp.next,
    kind: sp.kind,
    sli,
    tileFile: t.file,
  };
}

function nodesOf(workDir: string, sp: RawSpline, t: TileRef, tileIdx: number): LinkNode[] {
  const sli = cachedAsset(safeJoin(assetsDir(workDir), sp.path));
  if (sli === null) return [];
  const out: LinkNode[] = [];
  pathBlocks(sli).forEach((v, pathIndex) => {
    if (!isVehiclePath(v)) return;
    for (const end of ['start', 'end'] as const) out.push(buildNode(sp, t, tileIdx, sp.path, pathIndex, v, end));
  });
  return out;
}

/** Węzeł ścieżki najbliższy punktowi (x, y) w jednostkach kafli, nie dalej niż maxDistM metrów (kafel pod punktem i 8 sąsiednich). */
export function pickLinkNode(workDir: string, mapDir: string, x: number, y: number, maxDistM: number): LinkNode | null {
  const tiles = readTiles(mapDir);
  if (!tiles) return null;
  const [tx, ty] = [Math.round(x), Math.round(y)];
  let best: { d: number; n: LinkNode } | null = null;
  tiles.forEach((t, ti) => {
    if (Math.abs(t.x - tx) > 1 || Math.abs(t.y - ty) > 1) return;
    const data = cachedTile(path.join(mapDir, t.file));
    if (!data) return;
    const [ox, oy] = [(t.x - 0.5) * 300, (t.y - 0.5) * 300];
    for (const sp of data.splines) {
      if (Math.hypot(ox + sp.x - x * 300, oy + sp.y - y * 300) > sp.length + maxDistM + 25) continue;
      for (const n of nodesOf(workDir, sp, t, ti)) {
        const d = Math.hypot(n.x * 300 - x * 300, n.y * 300 - y * 300);
        if (d <= maxDistM && (!best || d < best.d)) best = { d, n };
      }
    }
  });
  return (best as { n: LinkNode } | null)?.n ?? null;
}

/** Węzeł o podanym wskazaniu albo null, gdy spline lub ścieżka już nie istnieje. */
export function getLinkNode(workDir: string, mapDir: string, ref: LinkNodeRef): LinkNode | null {
  const tiles = readTiles(mapDir);
  const t = tiles?.[ref.tile];
  if (!t) return null;
  const sp = cachedTile(path.join(mapDir, t.file))?.splines.find((s) => s.id === ref.splineId);
  if (!sp) return null;
  return nodesOf(workDir, sp, t, ref.tile).find((n) => n.pathIndex === ref.pathIndex && n.end === ref.end) ?? null;
}

// --- plan i zapis -----------------------------------------------------------------------------------

function linkSliPathHeight(workDir: string): number | string {
  const text = cachedAsset(safeJoin(assetsDir(workDir), LINK_SLI));
  if (text === null) return 'Brak pliku invis_street.sli w _vibe/assets/Splines (skopiuj go tam luzem — jest zawsze w Splines w OMSI).';
  const p = pathBlocks(text).find(isVehiclePath);
  return p ? p[2] : 'Plik invis_street.sli nie ma ścieżki dla pojazdów.';
}

/**
 * Pozycja końca łączenia. Łączenie to spline biegnący od `from` do `to`: wychodzi z węzła na końcu splinu zgodnie z jego
 * kierunkiem, a z węzła na początku splinu — „do tyłu” (azymut + 180°, nachylenie i skew z przeciwnym znakiem);
 * dochodzi do węzła na początku splinu zgodnie z jego kierunkiem, a do węzła na końcu — „od tyłu”.
 */
export function endPose(e: LinkEnd, role: 'from' | 'to'): NodePose {
  if ('free' in e) return { x: e.x * 300, y: e.y * 300, z: e.height, pitch: e.pitch, skew: e.skew };
  const forward = role === 'from' ? e.end === 'end' : e.end === 'start';
  const sign = forward ? 1 : -1;
  return { x: e.x * 300, y: e.y * 300, heading: e.heading + (forward ? 0 : 180), z: e.height, pitch: sign * e.pitch, skew: sign * e.skew };
}

function resolveEnd(workDir: string, mapDir: string, ref: LinkEndRef): LinkEnd | null {
  if ('free' in ref) return [ref.x, ref.y, ref.height, ref.pitch, ref.skew].every(Number.isFinite) ? { ...ref, free: true } : null;
  return getLinkNode(workDir, mapDir, ref);
}

/** Kolejność końców: dwa węzły „początek, koniec” zamieniamy tak, by spline szedł od końca do początku (powstaje przyłączenie); poza tym jak wskazano. */
function orient(a: LinkEnd, b: LinkEnd): { from: LinkEnd; to: LinkEnd } {
  const swap = !('free' in a) && !('free' in b) && a.end === 'start' && b.end === 'end';
  return swap ? { from: b, to: a } : { from: a, to: b };
}

/** Plan łączenia dwóch końców (węzły ścieżek albo dowolne punkty — co najmniej jeden musi być węzłem); bez zapisu. */
export function planLink(workDir: string, mapDir: string, a: LinkEndRef, b: LinkEndRef): LinkPlan {
  const plan: LinkPlan = { from: null, to: null, preview: [], length: 0, dz: 0, splines: [], suggestReverse: false, warnings: [] };
  const ea = resolveEnd(workDir, mapDir, a);
  const eb = resolveEnd(workDir, mapDir, b);
  if (!ea || !eb) return { ...plan, error: 'Nie znaleziono wskazanego węzła (spline mógł zostać zmieniony).' };
  const { from, to } = orient(ea, eb);
  Object.assign(plan, { from, to });
  const ph = linkSliPathHeight(workDir);
  if (typeof ph === 'string') return { ...plan, error: ph };
  const spl = planConnector(endPose(from, 'from'), endPose(to, 'to'), ph);
  if (typeof spl === 'string') return { ...plan, error: spl };
  plan.splines = spl.map((s) => ({ length: s.length, radius: s.radius, pitch0: s.pitch0, pitch1: s.pitch1, dz: s.dz, skew0: s.skew0, skew1: s.skew1 }));
  plan.length = spl.reduce((n, s) => n + s.length, 0);
  plan.dz = ('free' in to ? to.height : to.height) - ('free' in from ? from.height : from.height);
  plan.preview = spl.map((s) => arcPoints(s.x, s.y, s.heading, s.radius, s.length, 0).flatMap((p) => [p[0] / 300, p[1] / 300]));
  // kierunek ruchu zgodny z kierunkiem splinu łączącego: na `from` pojazdy opuszczają przyłączony spline, na `to` w niego wjeżdżają
  const fromNode = 'free' in from ? null : from;
  const toNode = 'free' in to ? null : to;
  plan.suggestReverse = fromNode ? !fromNode.exits : toNode ? toNode.exits : false;
  if (fromNode && toNode && fromNode.exits === toNode.exits) plan.warnings.push('Kierunki ruchu na przyłączanych ścieżkach są sprzeczne (obie wyjeżdżają z splinu albo obie w niego wjeżdżają).');
  const note = (n: LinkNode | null, compatible: boolean): void => {
    if (!n) return;
    if (!compatible) plan.warnings.push(`Spline ${n.splineId}: koniec skierowany przeciwnie do łączenia — geometria pasuje, ale przyłączenie (prev/next) zostanie pominięte.`);
    else if (n.linked !== '0') plan.warnings.push(`${n.end === 'end' ? 'Koniec' : 'Początek'} splinu ${n.splineId} jest już przyłączony do ${n.linked} — nowy spline nie zostanie z nim powiązany.`);
  };
  note(fromNode, fromNode?.end === 'end');
  note(toNode, toNode?.end === 'start');
  if (Math.abs(plan.dz) > 0.005 && plan.length / Math.abs(plan.dz) < 8) plan.warnings.push('Spadek/wzniesienie jest bardzo strome na tak krótkim odcinku.');
  return plan;
}

export const fmt = (n: number): string => (Math.abs(n) < 1e-9 ? '0' : String(Number(n.toPrecision(7))).toUpperCase());

/** Linijki wpisu [spline_h] (bez znaczników [rule]); układ pól jak w pliku .map, patrz RawSpline. */
export function splineRecord(s: PlannedSpline & { id: string; prev: string; next: string; xLocal: number; yLocal: number; mirror: boolean }): string[] {
  return [
    '[spline_h]',
    '0',
    LINK_SLI_IN_MAP,
    s.id,
    s.prev,
    s.next,
    fmt(s.xLocal),
    fmt(s.z),
    fmt(s.yLocal),
    fmt(s.heading),
    fmt(s.length),
    fmt(s.radius),
    fmt(s.pitch0),
    fmt(s.pitch1),
    fmt(s.dz),
    fmt(s.skew0),
    fmt(s.skew1),
    '0',
    '0',
    '0',
    ...(s.mirror ? ['mirror'] : []),
    '',
  ];
}

/** Największe ID spline’a lub obiektu we wszystkich kaflach mapy. */
export function maxId(mapDir: string, tiles: TileRef[]): number {
  let max = 0;
  for (const t of tiles) {
    const full = path.join(mapDir, t.file);
    if (!fs.existsSync(full)) continue;
    const lines = splitLines(decodeCfg(fs.readFileSync(full)).text);
    lines.forEach((l, i) => {
      const m = l.trim().toLowerCase();
      if (m === '[spline]' || m === '[spline_h]' || m === '[object]') {
        const id = Number((lines[i + 3] ?? '').trim());
        if (Number.isInteger(id) && id > max) max = id;
      }
    });
  }
  return max;
}

/** Ustawia przyłączenie (prev/next) splinu o danym ID z '0' na `value`; false, gdy spline nie istnieje albo koniec jest zajęty. */
export function setSplineLink(lines: string[], id: string, field: 'prev' | 'next', value: string): boolean {
  const at = lines.findIndex((l, i) => {
    const m = l.trim().toLowerCase();
    return (m === '[spline]' || m === '[spline_h]') && (lines[i + 3] ?? '').trim() === id;
  });
  if (at < 0) return false;
  const idx = at + (field === 'prev' ? 4 : 5);
  if ((lines[idx] ?? '').trim() !== '0') return false;
  lines[idx] = value;
  return true;
}

/** Indeks linii, przed którą dopisujemy nowe spliny: za ostatnim splinem wraz z jego blokami [rule]. */
export function splineInsertAt(lines: string[]): number {
  let last = -1;
  lines.forEach((l, i) => {
    const m = l.trim().toLowerCase();
    if (m === '[spline]' || m === '[spline_h]') last = i;
  });
  if (last < 0) {
    const o = lines.findIndex((l) => l.trim().toLowerCase() === '[object]');
    return o >= 0 ? o : lines.length;
  }
  let i = last + 1;
  for (; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith('[') && t.toLowerCase() !== '[rule]') break;
  }
  return i;
}

/**
 * Tworzy łączenie: dopisuje 1–2 spliny (invis_street.sli, [spline_h]) do kafla(ów) za ostatnim splinem — dzięki temu
 * numery elementów na kaflu istniejących wpisów .ttr się nie zmieniają — i przyłącza je do wolnych końców splinów
 * (prev/next). `reverse` odbija nowe spliny (mirror), co odwraca kierunek ruchu na ich ścieżce.
 */
export function createLink(workDir: string, mapDir: string, a: LinkEndRef, b: LinkEndRef, reverse: boolean): { ok: boolean; error?: string; ids?: string[]; tiles?: number[] } {
  const plan = planLink(workDir, mapDir, a, b);
  if (plan.error || !plan.from || !plan.to) return { ok: false, error: plan.error ?? 'Nie udało się zaplanować łączenia.' };
  const tiles = readTiles(mapDir);
  if (!tiles) return { ok: false, error: 'Brak pliku global.cfg w folderze mapy.' };
  const ph = linkSliPathHeight(workDir);
  if (typeof ph === 'string') return { ok: false, error: ph };
  const spl = planConnector(endPose(plan.from, 'from'), endPose(plan.to, 'to'), ph);
  if (typeof spl === 'string') return { ok: false, error: spl };

  const byXY = new Map(tiles.map((t, i) => [`${t.x},${t.y}`, i]));
  let next = maxId(mapDir, tiles) + 1;
  const ids = spl.map(() => String(next++));
  const edits = new Map<number, { lines: string[]; dec: ReturnType<typeof decodeCfg>; full: string }>();
  const open = (ti: number): { lines: string[]; dec: ReturnType<typeof decodeCfg>; full: string } | null => {
    const hit = edits.get(ti);
    if (hit) return hit;
    const full = path.join(mapDir, tiles[ti].file);
    if (!fs.existsSync(full)) return null;
    const dec = decodeCfg(fs.readFileSync(full));
    const e = { lines: splitLines(dec.text), dec, full };
    edits.set(ti, e);
    return e;
  };

  // przyłączenia do istniejących splinów (przed dopisaniem, żeby indeksy linii się nie przesunęły); tylko gdy koniec splinu
  // jest zgodny z kierunkiem łączenia (koniec → początek) i wolny
  const fromNode = 'free' in plan.from ? null : plan.from;
  const toNode = 'free' in plan.to ? null : plan.to;
  const fromEdit = fromNode ? open(fromNode.tile) : null;
  const toEdit = toNode ? open(toNode.tile) : null;
  if ((fromNode && !fromEdit) || (toNode && !toEdit)) return { ok: false, error: 'Nie ma pliku kafla przyłączanego splinu.' };
  const linkFrom = !!fromNode && !!fromEdit && fromNode.end === 'end' && fromNode.linked === '0' && setSplineLink(fromEdit.lines, fromNode.splineId, 'next', ids[0]);
  const linkTo = !!toNode && !!toEdit && toNode.end === 'start' && toNode.linked === '0' && setSplineLink(toEdit.lines, toNode.splineId, 'prev', ids[ids.length - 1]);

  const records = new Map<number, string[]>();
  for (let i = 0; i < spl.length; i++) {
    const tx = Math.floor(spl[i].x / 300 + 0.5);
    const ty = Math.floor(spl[i].y / 300 + 0.5);
    const ti = byXY.get(`${tx},${ty}`);
    if (ti === undefined) return { ok: false, error: `Nowy spline leży poza kaflami mapy (kafel ${tx}, ${ty}).` };
    if (!open(ti)) return { ok: false, error: 'Nie ma pliku kafla dla nowego splinu.' };
    const rec = splineRecord({
      ...spl[i],
      id: ids[i],
      prev: i === 0 ? (linkFrom && fromNode ? fromNode.splineId : '0') : ids[i - 1],
      next: i === spl.length - 1 ? (linkTo && toNode ? toNode.splineId : '0') : ids[i + 1],
      xLocal: spl[i].x - (tx - 0.5) * 300,
      yLocal: spl[i].y - (ty - 0.5) * 300,
      mirror: reverse,
    });
    records.set(ti, [...(records.get(ti) ?? []), ...rec]);
  }
  for (const [ti, rec] of records) {
    const e = edits.get(ti)!;
    e.lines.splice(splineInsertAt(e.lines), 0, ...rec);
  }
  for (const e of edits.values()) {
    if (!fs.existsSync(`${e.full}.bak`)) fs.copyFileSync(e.full, `${e.full}.bak`);
    const eol = e.dec.text.includes('\r\n') ? '\r\n' : '\n';
    fs.writeFileSync(e.full, encodeCfg(e.lines.join(eol), e.dec.encoding, e.dec.bom));
  }
  return { ok: true, ids, tiles: [...edits.keys()] };
}
