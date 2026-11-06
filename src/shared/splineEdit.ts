import { angDelta, arcEnd, connectArcs, deg, rad } from './arcs.ts';

const bearing = (dx: number, dy: number): number => deg(Math.atan2(dx, dy));

/** Spline do edycji w metrach świata (położenie = początek kafla + współrzędne lokalne); `tile` = indeks kafla, w którym jest zapisany. */
export interface EditSpline {
  id: string;
  tile: number;
  kind: 'spline' | 'spline_h';
  path: string;
  mirror: boolean;
  x: number;
  y: number;
  heading: number;
  length: number;
  radius: number;
  /** Wysokość osi na początku; koniec ma z + dz (zwykły [spline] jest płaski: dz = 0). */
  z: number;
  dz: number;
  pitch0: number;
  pitch1: number;
  skew0: number;
  skew1: number;
  prev: string;
  next: string;
}

export interface PointSel {
  splineId: string;
  end: 'start' | 'end';
}

/** Pozycja i azymut osi splinu na jego końcu (początku albo końcu). */
export function splineEndPose(s: EditSpline, end: 'start' | 'end'): { x: number; y: number; heading: number } {
  return end === 'start' ? { x: s.x, y: s.y, heading: s.heading } : arcEnd({ x: s.x, y: s.y, heading: s.heading, length: s.length, radius: s.radius });
}

/** Wysokość osi splinu na końcu. */
export const splineEndZ = (s: EditSpline, end: 'start' | 'end'): number => (end === 'start' ? s.z : s.z + s.dz);

const EPS = 1e-9;

/** skew na styku przy zmianie azymutu o Δ: tan(Δ/2) (z ograniczeniem, żeby przy zawracaniu nie rosło w nieskończoność). */
export const jointSkew = (deltaDeg: number): number => (Math.abs(deltaDeg) < 1e-7 ? 0 : Math.tan(rad(Math.max(-175, Math.min(175, deltaDeg))) / 2));

/**
 * Wyrównuje połączenie koniec A → początek B: wysokość styku i nachylenie stają się średnimi z obu stron (drugie końce splinów
 * zostają na swoich wysokościach), a skew wynika z załamka azymutu na styku (A.skew końca = −tan(Δ/2), B.skew początku = +tan(Δ/2)).
 * Zwykły [spline] staje się [spline_h], gdy musi przechować wysokość lub nachylenie.
 */
export function alignJoin(a: EditSpline, b: EditSpline): { a: EditSpline; b: EditSpline } {
  const zJoin = (a.z + a.dz + b.z) / 2;
  const pitch = (a.pitch1 + b.pitch0) / 2;
  const skew = jointSkew(angDelta(splineEndPose(a, 'end').heading, b.heading));
  const na: EditSpline = { ...a, dz: zJoin - a.z, pitch1: pitch, skew1: -skew };
  const nb: EditSpline = { ...b, dz: b.z + b.dz - zJoin, z: zJoin, pitch0: pitch, skew0: skew };
  for (const n of [na, nb]) {
    if (n.kind === 'spline' && (Math.abs(n.dz) > EPS || Math.abs(n.pitch0) > EPS || Math.abs(n.pitch1) > EPS)) n.kind = 'spline_h';
  }
  return { a: na, b: nb };
}

/**
 * Po zmianie położenia lub azymutu splinów (przesunięcie, obrót) ustawia skew na ich stykach z poprzednikiem i następnikiem
 * (obu stronom styku) według załamka azymutu; styk liczy się tylko, gdy odnośniki prev/next są wzajemne. Zwraca zmienione
 * spliny razem z sąsiadami, którym zmieniono skew.
 */
export function fixJointSkews(changed: EditSpline[], neighbor: (id: string) => EditSpline | undefined): EditSpline[] {
  const out = new Map<string, EditSpline>(changed.map((s) => [s.id, { ...s }]));
  const touched = new Set<string>(changed.map((s) => s.id));
  const get = (id: string): EditSpline | undefined => {
    const hit = out.get(id);
    if (hit) return hit;
    const n = neighbor(id);
    if (!n) return undefined;
    const c = { ...n };
    out.set(id, c);
    return c;
  };
  for (const s0 of changed) {
    const s = out.get(s0.id)!;
    const nx = s.next !== '0' ? get(s.next) : undefined;
    if (nx && nx.prev === s.id) {
      const k = jointSkew(angDelta(splineEndPose(s, 'end').heading, nx.heading));
      s.skew1 = -k;
      nx.skew0 = k;
      touched.add(nx.id);
    }
    const pv = s.prev !== '0' ? get(s.prev) : undefined;
    if (pv && pv.next === s.id) {
      const k = jointSkew(angDelta(splineEndPose(pv, 'end').heading, s.heading));
      pv.skew1 = -k;
      s.skew0 = k;
      touched.add(pv.id);
    }
  }
  return [...out.values()].filter((x) => touched.has(x.id));
}

/**
 * Przesuwa zaznaczone końce splinów o (dx, dy) metrów w poziomie i dz metrów w pionie.
 * - Oba końce splinu zaznaczone: spline przesuwa się sztywno.
 * - Jeden koniec: drugi koniec zostaje (pozycja i azymut), a spline staje się łukiem przez nowy punkt — zmienia się azymut,
 *   długość i promień po przesuwanym końcu.
 * - Wysokość: jeden koniec zmienia z i dz (drugi koniec zostaje na swojej wysokości); zwykły [spline] zamienia się wtedy w [spline_h].
 * - Łuk wyłączony (`arc` = false): spline pozostaje prostą — obraca się wokół nieruszonego końca i zmienia długość, zamiast się zaginać.
 * Zwraca tylko zmienione spliny (te, których koniec jest zaznaczony) albo błąd.
 */
export function moveSplines(splines: EditSpline[], sel: PointSel[], dx: number, dy: number, dz: number, arc = true): { splines: EditSpline[]; error?: string } {
  const has = (id: string, end: 'start' | 'end'): boolean => sel.some((p) => p.splineId === id && p.end === end);
  const out: EditSpline[] = [];
  for (const s of splines) {
    const ms = has(s.id, 'start');
    const me = has(s.id, 'end');
    if (!ms && !me) continue;
    let n: EditSpline = { ...s };
    if (ms && me) {
      n.x += dx;
      n.y += dy;
    } else if (Math.abs(dx) > EPS || Math.abs(dy) > EPS) {
      const e = splineEndPose(s, 'end');
      if (!arc) {
        // prosta między nieruszonym końcem a nowym punktem: spline obraca się wokół nieruszonego końca
        const [ax, ay, bx, by] = ms ? [s.x + dx, s.y + dy, e.x, e.y] : [s.x, s.y, e.x + dx, e.y + dy];
        const len = Math.hypot(bx - ax, by - ay);
        if (len < 0.05) return { splines: [], error: `Spline ${s.id}: końce leżałyby w tym samym miejscu.` };
        n = { ...n, x: ax, y: ay, heading: bearing(bx - ax, by - ay), length: len, radius: 0 };
      } else {
        const flat = { z: 0, pitch: 0, skew: 0 };
        const arcs = ms
          ? connectArcs({ x: s.x + dx, y: s.y + dy, ...flat }, { x: e.x, y: e.y, heading: e.heading, ...flat })
          : connectArcs({ x: s.x, y: s.y, heading: s.heading, ...flat }, { x: e.x + dx, y: e.y + dy, ...flat });
        if (typeof arcs === 'string') return { splines: [], error: `Spline ${s.id}: ${arcs}` };
        n = { ...n, x: arcs[0].x, y: arcs[0].y, heading: arcs[0].heading, length: arcs[0].length, radius: arcs[0].radius };
      }
    }
    if (Math.abs(dz) > EPS) {
      if (ms && me) n.z += dz;
      else if (ms) {
        n.z += dz;
        n.dz -= dz;
        n.kind = 'spline_h';
      } else {
        n.dz += dz;
        n.kind = 'spline_h';
      }
    }
    out.push(n);
  }
  return { splines: out };
}

/** Początek nowego splinu: istniejący koniec splinu (z azymutem i nachyleniem) albo dowolny punkt (bez azymutu). */
export interface NewSplineStart {
  x: number;
  y: number;
  z: number;
  /** Azymut kierunku nowego splinu i nachylenie w tym kierunku; brak = dowolny punkt. */
  heading?: number;
  pitch?: number;
}

/** Początek nowego splinu wychodzącego z końca splinu: z końca — naprzód, z początku — „do tyłu” (azymut + 180°, nachylenie z przeciwnym znakiem). */
export function newSplineStartAt(s: EditSpline, end: 'start' | 'end'): NewSplineStart {
  const p = splineEndPose(s, end);
  const pitch = end === 'end' ? s.pitch1 : -s.pitch0;
  return { x: p.x, y: p.y, z: splineEndZ(s, end), heading: end === 'end' ? p.heading : p.heading + 180, pitch };
}

export interface NewSplineGeom {
  x: number;
  y: number;
  heading: number;
  length: number;
  radius: number;
  z: number;
  dz: number;
  pitch0: number;
  pitch1: number;
}

/**
 * Nowy spline od `start` do punktu (ex, ey): z azymutem początku — jeden łuk styczny do niego (nachylenie stałe, jak na
 * początku), bez azymutu albo przy wyłączonym łuku (`arc` = false) — prosta. Wysokość osi na początku = start.z.
 */
export function newSpline(start: NewSplineStart, ex: number, ey: number, arc = true): NewSplineGeom | string {
  const dist = Math.hypot(ex - start.x, ey - start.y);
  if (dist < 0.05) return 'Punkt końcowy leży w miejscu początku.';
  let g: { heading: number; length: number; radius: number };
  if (arc && typeof start.heading === 'number') {
    const arcs = connectArcs({ x: start.x, y: start.y, heading: start.heading, z: 0, pitch: 0, skew: 0 }, { x: ex, y: ey, z: 0, pitch: 0, skew: 0 });
    if (typeof arcs === 'string') return arcs;
    g = { heading: arcs[0].heading, length: arcs[0].length, radius: arcs[0].radius };
  } else {
    g = { heading: bearing(ex - start.x, ey - start.y), length: dist, radius: 0 };
  }
  const pitch = start.pitch ?? 0;
  return { x: start.x, y: start.y, ...g, z: start.z, dz: g.length * Math.tan(rad(pitch)), pitch0: pitch, pitch1: pitch };
}
