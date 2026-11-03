/**
 * Geometria łuków splinów OMSI (czyste funkcje, wspólne dla procesu głównego i interfejsu).
 * Azymut w ° od północy rośnie zgodnie z ruchem wskazówek zegara; promień > 0 = skręt w prawo, 0 = prosta; Y rośnie na północ.
 */

type Pt = [number, number];

export const rad = (d: number): number => (d * Math.PI) / 180;
export const deg = (r: number): number => (r * 180) / Math.PI;
type V = [number, number];
const unit = (h: number): V => [Math.sin(rad(h)), Math.cos(rad(h))];
const dot = (a: V, b: V): number => a[0] * b[0] + a[1] * b[1];
const cross = (a: V, b: V): number => a[0] * b[1] - a[1] * b[0];
const hdgOf = (v: V): number => deg(Math.atan2(v[0], v[1]));
export const angDiff = (a: number, b: number): number => Math.abs(((((a - b) % 360) + 540) % 360) - 180);

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

/** Koniec łączenia w metrach świata; bez azymutu (`heading` brak) = dowolny punkt, którego styczna wynika z łuku. */
export interface NodePose {
  x: number;
  y: number;
  heading?: number;
  /** Wysokość punktu ścieżki (m). */
  z: number;
  pitch: number;
  skew: number;
}
/**
 * Łuki łączące dwa końce: dwa węzły (z azymutem) — jedna prosta/łuk albo biarc; węzeł i dowolny punkt — jeden łuk styczny
 * do węzła i przechodzący przez punkt (azymut w punkcie wynika z łuku); dwa dowolne punkty nie mają stycznej, więc to błąd.
 */
export function connectArcs(p1: NodePose, p2: NodePose): PlannedArc[] | string {
  const h1 = typeof p1.heading === 'number';
  const h2 = typeof p2.heading === 'number';
  if (h1 && h2) return biarc(p1 as Pose, p2 as Pose);
  if (!h1 && !h2) return 'Co najmniej jeden z końców musi być węzłem — Ctrl+klik przyciąga do węzła.';
  const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  if (dist < 0.05) return 'Końce leżą w tym samym miejscu.';
  let arcs: PlannedArc[];
  if (h1) {
    const a = arcFrom([p1.x, p1.y], unit(p1.heading!), [p2.x, p2.y]);
    if (!a) return 'Punkt leży za węzłem — nie da się go połączyć łagodnym łukiem.';
    arcs = [{ x: p1.x, y: p1.y, heading: p1.heading!, length: a.length, radius: a.radius }];
  } else {
    // koniec w węźle: liczymy łuk od węzła „do tyłu” i odwracamy go (zmienia się strona skrętu)
    const back = arcFrom([p2.x, p2.y], unit(p2.heading! + 180), [p1.x, p1.y]);
    if (!back) return 'Punkt leży za węzłem — nie da się go połączyć łagodnym łukiem.';
    arcs = [{ x: p1.x, y: p1.y, heading: back.endHeading + 180, length: back.length, radius: back.radius === 0 ? 0 : -back.radius }];
  }
  if (arcs[0].length > 6 * dist + 50) return 'Łączenie wymagałoby bardzo długiego łuku.';
  const e = arcEnd(arcs[0]);
  if (Math.hypot(e.x - p2.x, e.y - p2.y) > 0.05 || (h2 && angDiff(e.heading, p2.heading!) > 0.3)) return 'Nie da się połączyć tych końców łagodnym łukiem.';
  return arcs;
}

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

