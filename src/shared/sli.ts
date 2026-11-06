/** Pas profilu splinu: odcinek przekroju między dwoma punktami profilu, z teksturą i mapowaniem współrzędnych tekstury. */
export interface SliBand {
  /** Boczne położenia krawędzi pasa (m od osi, w prawo +) — bez uwzględnienia odbicia splinu. */
  x0: number;
  x1: number;
  /** Współrzędne tekstury (U) na krawędziach pasa. */
  u0: number;
  u1: number;
  /** Indeks tekstury na liście `textures`. */
  tex: number;
  /** Współrzędna V tekstury na metr długości splinu (znak = kierunek); odwrotność długości powtórzenia tekstury. */
  vs: number;
}

export interface SliProfile {
  textures: string[];
  bands: SliBand[];
}

/** Domyślne powtórzenie tekstury, gdy .sli nie podaje skali V: co 10 m. */
export const DEFAULT_VS = 0.1;

/**
 * Parsuje profil .sli: lista tekstur ([texture] i nazwa pliku w następnej linijce), profile ([profile] z indeksem tekstury)
 * i ich punkty ([profilepnt]: x, wysokość, U, opcjonalnie skala V). Pas powstaje między kolejnymi punktami profilu;
 * skala V profilu to czwarta liczba jego pierwszego punktu (w próbkach 0,167 = powtórzenie co 6 m, 0,1 = co 10 m).
 */
export function parseSliProfile(text: string): SliProfile {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const textures: string[] = [];
  const profiles: { tex: number; pts: { x: number; u: number; v: number | null }[] }[] = [];
  let cur: (typeof profiles)[number] | null = null;
  const num = (s: string): number => Number(s.replace(',', '.'));
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].toLowerCase();
    if (!m.startsWith('[')) continue;
    if (m === '[texture]') {
      let j = i + 1;
      while (j < lines.length && lines[j] === '') j++;
      if (j < lines.length && !lines[j].startsWith('[')) textures.push(lines[j]);
      cur = null;
    } else if (m === '[profile]') {
      let j = i + 1;
      while (j < lines.length && lines[j] === '') j++;
      const idx = Number.isInteger(num(lines[j] ?? '')) ? num(lines[j]) : 0;
      cur = { tex: idx, pts: [] };
      profiles.push(cur);
    } else if (m === '[profilepnt]') {
      const v: number[] = [];
      for (let j = i + 1; j < lines.length && v.length < 4; j++) {
        if (lines[j].startsWith('[')) break;
        if (lines[j] !== '') v.push(num(lines[j]));
      }
      if (cur && v.length >= 3 && v.slice(0, 3).every(Number.isFinite)) cur.pts.push({ x: v[0], u: v[2], v: v.length > 3 && Number.isFinite(v[3]) ? v[3] : null });
    } else if (m === '[path]') {
      cur = null;
    }
  }
  const bands: SliBand[] = [];
  for (const p of profiles) {
    const vs = p.pts[0]?.v ?? DEFAULT_VS;
    for (let i = 0; i + 1 < p.pts.length; i++) {
      const [a, b] = [p.pts[i], p.pts[i + 1]];
      if (Math.abs(b.x - a.x) < 1e-6 || p.tex < 0 || p.tex >= textures.length) continue;
      bands.push({ x0: a.x, x1: b.x, u0: a.u, u1: b.u, tex: p.tex, vs: Math.abs(vs) < 1e-9 ? DEFAULT_VS : vs });
    }
  }
  return { textures, bands };
}

/**
 * Macierz afiniczna (a, b, c, d, e, f) wzoru canvas: piksel tekstury (X, Y) o rozmiarze W × H → punkt na ekranie, tak że
 * współrzędna U tekstury biegnie w poprzek pasa (U = u0 przy bocznym położeniu x0, kU metrów na jednostkę U), a V = vs · (przesunięcie
 * tekstury + odległość wzdłuż splinu). Środek kawałka splinu jest na ekranie w (px, py), a jego azymut wynosi `phi` (rad, od północy
 * zgodnie z ruchem wskazówek zegara) w odległości sMid od początku; mPx = piksele na metr. Oś Y ekranu rośnie w dół.
 */
export function texturePatternMatrix(o: { px: number; py: number; phi: number; mPx: number; u0: number; x0: number; kU: number; vs: number; texOff: number; sMid: number; W: number; H: number }): { a: number; b: number; c: number; d: number; e: number; f: number } {
  const [dX, dY] = [Math.sin(o.phi), -Math.cos(o.phi)]; // kierunek splinu na ekranie
  const [rX, rY] = [Math.cos(o.phi), Math.sin(o.phi)]; // w prawo od kierunku jazdy
  const off = o.x0 - o.u0 * o.kU; // boczne położenie U = 0
  const along = -(o.texOff + o.sMid); // położenie V = 0 względem środka kawałka
  return {
    a: (rX * o.kU * o.mPx) / o.W,
    b: (rY * o.kU * o.mPx) / o.W,
    c: (dX * o.mPx) / (o.H * o.vs),
    d: (dY * o.mPx) / (o.H * o.vs),
    e: o.px + (rX * off + dX * along) * o.mPx,
    f: o.py + (rY * off + dY * along) * o.mPx,
  };
}
