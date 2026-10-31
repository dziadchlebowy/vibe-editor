/**
 * Dla wpisu trasy o numerze `entry`: suma długości wpisów przed wpisem (entry − 1) — od niej OMSI liczy pole route
 * przystanku w .ttp (route = baza + along); dla entry 0 baza wynosi 0.
 */
export function routeBases(segments: { length: number }[]): (entry: number) => number {
  const starts: number[] = [];
  segments.reduce((acc, g, k) => ((starts[k] = acc), acc + g.length), 0);
  return (entry) => starts[Math.max(entry - 1, 0)] ?? 0;
}
