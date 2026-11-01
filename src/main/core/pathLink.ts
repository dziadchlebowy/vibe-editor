import fs from 'node:fs';
import path from 'node:path';
import type { LinkNode, LinkNodeRef, LinkPlan } from '../../shared/types.ts';
import { decodeCfg, encodeCfg, splitLines } from './globalCfg.ts';
import { assetsDir, safeJoin, type TileRef } from './mapIndex.ts';
import type { RawSpline } from './mapSplines.ts';
import { arcPoints, cachedAsset, cachedTile, pathBlocks, readTiles } from './tripRoute.ts';

/** Spline łączący: „invis_street.sli” leży w OMSI luzem w Splines (kopia w _vibe/assets/Splines), ma jedną ścieżkę dla pojazdów. */
export const LINK_SLI = 'Splines/invis_street.sli';
const LINK_SLI_IN_MAP = 'Splines\\invis_street.sli';

const rad = (d: number): number => (d * Math.PI) / 180;
const deg = (r: number): number => (r * 180) / Math.PI;
type V = [number, number];
const unit = (h: number): V => [Math.sin(rad(h)), Math.cos(rad(h))];
const dot = (a: V, b: V): number => a[0] * b[0] + a[1] * b[1];
const cross = (a: V, b: V): number => a[0] * b[1] - a[1] * b[0];
const hdgOf = (v: V): number => deg(Math.atan2(v[0], v[1]));
const angDiff = (a: number, b: number): number => Math.abs(((((a - b) % 360) + 540) % 360) - 180);

// --- geometria łuków (azymut w ° od północy rośnie zgodnie z ruchem wskazówek zegara; promień > 0 = skręt w prawo) ----------

export interface Pose {
  x: number;
  y: number;
  heading: number;
}
export interface PlannedArc extends Pose {
  length: number;
  /** 0 = prosta. */
  radius: number;
}

/** Pozycja i azymut na końcu łuku (punkt osi). */
export function arcEnd(a: PlannedArc): Pose {
  const k = a.radius !== 0 ? 1 / a.radius : 0;
  const phi0 = rad(a.heading);
  const phi = phi0 + k * a.length;
  const mx = k === 0 ? Math.sin(phi0) * a.length : (Math.cos(phi0) - Math.cos(phi)) / k;
  const my = k === 0 ? Math.cos(phi0) * a.length : (Math.sin(phi) - Math.sin(phi0)) / k;
  return { x: a.x + mx, y: a.y + my, heading: a.heading + deg(k * a.length) };
}

/** Łuk z punktu p o stycznej t (wektor jednostkowy) do punktu q; null, gdy q leży za plecami albo łuk byłby prawie pełnym okręgiem. */
function arcFrom(p: V, t: V, q: V): { length: number; radius: number; endHeading: number } | null {
  const u: V = [q[0] - p[0], q[1] - p[1]];
  const c = Math.hypot(u[0], u[1]);
  if (c < 1e-6) return null;
  const sinT = cross(t, u) / c;
  const cosT = dot(t, u) / c;
  const theta = Math.atan2(sinT, cosT); // kąt między styczną a cięciwą (CCW +)
  if (Math.abs(theta) > Math.PI * 0.49 && cosT < 0) return null;
  if (Math.abs(Math.sin(theta)) < 1e-9) return cosT > 0 ? { length: c, radius: 0, endHeading: hdgOf(t) } : null;
  const length = (c * Math.abs(theta)) / Math.abs(Math.sin(theta));
  const radius = -length / (2 * theta);
  return { length, radius: Math.abs(radius) > 1e6 ? 0 : radius, endHeading: hdgOf(t) - deg(2 * theta) };
}

/**
 * Łączenie dwóch pozycji z ciągłością stycznej: jedna prosta/łuk, gdy wystarcza, w przeciwnym razie biarc
 * (dwa łuki o równych odcinkach stycznych — Bolton/Meek–Walton). Zwraca łuki w kolejności jazdy albo komunikat błędu.
 */
export function biarc(p1: Pose, p2: Pose): PlannedArc[] | string {
  const t1 = unit(p1.heading);
  const t2 = unit(p2.heading);
  const v: V = [p2.x - p1.x, p2.y - p1.y];
  const dist = Math.hypot(v[0], v[1]);
  if (dist < 0.05) return 'Węzły leżą w tym samym miejscu.';
  const check = (arcs: PlannedArc[]): PlannedArc[] | string => {
    const total = arcs.reduce((n, a) => n + a.length, 0);
    if (total > 6 * dist + 50) return 'Łączenie wymagałoby bardzo długiego łuku — kąty węzłów do siebie nie pasują.';
    const e = arcEnd(arcs[arcs.length - 1]);
    if (Math.hypot(e.x - p2.x, e.y - p2.y) > 0.05 || angDiff(e.heading, p2.heading) > 0.3) return 'Nie da się połączyć tych węzłów łagodnym łukiem (kąty węzłów).';
    return arcs;
  };
  const single = arcFrom([p1.x, p1.y], t1, [p2.x, p2.y]);
  if (single && angDiff(single.endHeading, p2.heading) < 0.25) return check([{ ...p1, length: single.length, radius: single.radius }]);

  const tt: V = [t1[0] + t2[0], t1[1] + t2[1]];
  const a = 2 * (1 - dot(t1, t2));
  const b = 2 * dot(v, tt);
  const c = -dot(v, v);
  let d: number;
  if (a < 1e-9) {
    if (b <= 1e-9) return 'Nie da się połączyć węzłów — kierunki są przeciwne.';
    d = -c / b;
  } else {
    d = (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
  }
  if (!(d > 0) || !Number.isFinite(d)) return 'Nie da się połączyć tych węzłów (kierunki do siebie nie pasują).';
  const q1: V = [p1.x + d * t1[0], p1.y + d * t1[1]];
  const q2: V = [p2.x - d * t2[0], p2.y - d * t2[1]];
  const j: V = [(q1[0] + q2[0]) / 2, (q1[1] + q2[1]) / 2];
  const dq = Math.hypot(q2[0] - q1[0], q2[1] - q1[1]);
  const tj: V = dq < 1e-9 ? t1 : [(q2[0] - q1[0]) / dq, (q2[1] - q1[1]) / dq];
  const a1 = arcFrom([p1.x, p1.y], t1, j);
  const a2 = arcFrom(j, tj, [p2.x, p2.y]);
  if (!a1 || !a2) return 'Nie da się połączyć tych węzłów (kąty węzłów).';
  const arcs: PlannedArc[] = [
    { ...p1, length: a1.length, radius: a1.radius },
    { x: j[0], y: j[1], heading: hdgOf(tj), length: a2.length, radius: a2.radius },
  ];
  return check(arcs);
}

/** Wysokość i nachylenie (tangens) sześciennej krzywej Hermite’a: h(0) = 0, h′(0) = tan p0, h(L) = dz, h′(L) = tan p1. */
export function hermite(L: number, p0: number, p1: number, dz: number): (s: number) => { h: number; slope: number } {
  const a1 = Math.tan(rad(p0));
  const D = dz - a1 * L;
  const E = Math.tan(rad(p1)) - a1;
  const a2 = (3 * D - E * L) / (L * L);
  const a3 = (E * L - 2 * D) / (L * L * L);
  return (s) => ({ h: a1 * s + a2 * s * s + a3 * s * s * s, slope: a1 + 2 * a2 * s + 3 * a3 * s * s });
}

export interface NodePose extends Pose {
  /** Wysokość punktu ścieżki (m). */
  z: number;
  pitch: number;
  skew: number;
}
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
 * Łączenie od `from` (koniec splinu, azymut = kierunek splinu) do `to` (początek splinu): łuki w poziomie, a wysokość
 * zmienia się płynnie jedną krzywą Hermite’a na całej długości (nachylenia na końcach = nachylenia przyłączanych splinów,
 * na styku łuków — ciągłe), skew rośnie liniowo od wartości `from` do wartości `to`. `pathHeight` = wysokość ścieżki
 * łączącego splinu nad jego nawierzchnią (z invis_street.sli).
 */
export function planConnector(from: NodePose, to: NodePose, pathHeight: number): PlannedSpline[] | string {
  const arcs = biarc(from, to);
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

const toPose = (n: LinkNode): NodePose => ({ x: n.x * 300, y: n.y * 300, heading: n.heading, z: n.height, pitch: n.pitch, skew: n.skew });

function linkSliPathHeight(workDir: string): number | string {
  const text = cachedAsset(safeJoin(assetsDir(workDir), LINK_SLI));
  if (text === null) return 'Brak pliku invis_street.sli w _vibe/assets/Splines (skopiuj go tam luzem — jest zawsze w Splines w OMSI).';
  const p = pathBlocks(text).find(isVehiclePath);
  return p ? p[2] : 'Plik invis_street.sli nie ma ścieżki dla pojazdów.';
}

/** Plan łączenia dwóch węzłów: jeden musi leżeć na końcu splinu, drugi na początku (kolejność wskazania jest dowolna). */
export function planLink(workDir: string, mapDir: string, a: LinkNodeRef, b: LinkNodeRef): LinkPlan {
  const plan: LinkPlan = { from: null, to: null, preview: [], length: 0, dz: 0, splines: [], suggestReverse: false, warnings: [] };
  const na = getLinkNode(workDir, mapDir, a);
  const nb = getLinkNode(workDir, mapDir, b);
  if (!na || !nb) return { ...plan, error: 'Nie znaleziono wskazanego węzła (spline mógł zostać zmieniony).' };
  if (na.end === nb.end) return { ...plan, error: `Oba węzły leżą na ${na.end === 'end' ? 'końcach' : 'początkach'} splinów — wskaż jeden na końcu splinu, a drugi na początku (spliny łączą się zgodnie z kierunkiem).` };
  const from = na.end === 'end' ? na : nb;
  const to = na.end === 'end' ? nb : na;
  Object.assign(plan, { from, to });
  const ph = linkSliPathHeight(workDir);
  if (typeof ph === 'string') return { ...plan, error: ph };
  const spl = planConnector(toPose(from), toPose(to), ph);
  if (typeof spl === 'string') return { ...plan, error: spl };
  plan.splines = spl.map((s) => ({ length: s.length, radius: s.radius, pitch0: s.pitch0, pitch1: s.pitch1, dz: s.dz, skew0: s.skew0, skew1: s.skew1 }));
  plan.length = spl.reduce((n, s) => n + s.length, 0);
  plan.dz = to.height - from.height;
  plan.preview = spl.map((s) => arcPoints(s.x, s.y, s.heading, s.radius, s.length, 0).flatMap((p) => [p[0] / 300, p[1] / 300]));
  plan.suggestReverse = !from.exits;
  if (from.exits === to.exits) plan.warnings.push('Kierunki ruchu na przyłączanych ścieżkach są sprzeczne (obie wyjeżdżają z splinu albo obie w niego wjeżdżają).');
  if (from.linked !== '0') plan.warnings.push(`Koniec splinu ${from.splineId} jest już przyłączony do ${from.linked} — nowy spline nie zostanie z nim powiązany.`);
  if (to.linked !== '0') plan.warnings.push(`Początek splinu ${to.splineId} jest już przyłączony do ${to.linked} — nowy spline nie zostanie z nim powiązany.`);
  if (Math.abs(to.height - from.height) > 0.005 && spl.length > 0 && plan.length / Math.abs(to.height - from.height) < 8) plan.warnings.push('Spadek/wzniesienie jest bardzo strome na tak krótkim odcinku.');
  return plan;
}

const fmt = (n: number): string => (Math.abs(n) < 1e-9 ? '0' : String(Number(n.toPrecision(7))).toUpperCase());

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
function maxId(mapDir: string, tiles: TileRef[]): number {
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
function setSplineLink(lines: string[], id: string, field: 'prev' | 'next', value: string): boolean {
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
function splineInsertAt(lines: string[]): number {
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
export function createLink(workDir: string, mapDir: string, a: LinkNodeRef, b: LinkNodeRef, reverse: boolean): { ok: boolean; error?: string; ids?: string[] } {
  const plan = planLink(workDir, mapDir, a, b);
  if (plan.error || !plan.from || !plan.to) return { ok: false, error: plan.error ?? 'Nie udało się zaplanować łączenia.' };
  const tiles = readTiles(mapDir);
  if (!tiles) return { ok: false, error: 'Brak pliku global.cfg w folderze mapy.' };
  const ph = linkSliPathHeight(workDir);
  if (typeof ph === 'string') return { ok: false, error: ph };
  const spl = planConnector(toPose({ ...plan.from }), toPose({ ...plan.to }), ph);
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

  // przyłączenia do istniejących splinów (przed dopisaniem, żeby indeksy linii się nie przesunęły)
  const fromEdit = open(plan.from.tile);
  const toEdit = open(plan.to.tile);
  if (!fromEdit || !toEdit) return { ok: false, error: 'Nie ma pliku kafla przyłączanego splinu.' };
  const linkFrom = plan.from.linked === '0' && setSplineLink(fromEdit.lines, plan.from.splineId, 'next', ids[0]);
  const linkTo = plan.to.linked === '0' && setSplineLink(toEdit.lines, plan.to.splineId, 'prev', ids[ids.length - 1]);

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
      prev: i === 0 ? (linkFrom ? plan.from.splineId : '0') : ids[i - 1],
      next: i === spl.length - 1 ? (linkTo ? plan.to.splineId : '0') : ids[i + 1],
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
  return { ok: true, ids };
}
