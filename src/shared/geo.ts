/** Rzut punktu na łamaną (jednostki kafli): s = odległość wzdłuż łamanej od początku (m), d = odległość od niej (m). */
export function projectOnLine(line: number[], x: number, y: number): { s: number; d: number } {
  let acc = 0;
  let best = { s: 0, d: Infinity };
  for (let i = 0; i + 3 < line.length; i += 2) {
    const [ax, ay, bx, by] = [line[i] * 300, line[i + 1] * 300, line[i + 2] * 300, line[i + 3] * 300];
    const dx = bx - ax;
    const dy = by - ay;
    const l = Math.hypot(dx, dy);
    const t = l === 0 ? 0 : Math.max(0, Math.min(1, ((x * 300 - ax) * dx + (y * 300 - ay) * dy) / (l * l)));
    const d = Math.hypot(x * 300 - (ax + t * dx), y * 300 - (ay + t * dy));
    if (d < best.d) best = { s: acc + t * l, d };
    acc += l;
  }
  return best;
}
