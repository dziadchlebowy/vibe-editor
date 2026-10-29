/** Minuty od północy → „h:m:s” jak w komentarzach „Dep.:” plików .ttl (bez zer wiodących). */
export function formatDep(minutes: number): string {
  const total = Math.round(minutes * 60);
  return `${Math.floor(total / 3600)}:${Math.floor((total % 3600) / 60)}:${total % 60}`;
}

/** „6:06” albo „6:06:30” → minuty od północy; null dla nieprawidłowego wpisu. */
export function parseClock(text: string): number | null {
  const m = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/.exec(text.trim());
  if (!m) return null;
  const mins = Number(m[2]);
  const secs = Number(m[3] ?? 0);
  if (mins > 59 || secs > 59) return null;
  return Number(m[1]) * 60 + mins + secs / 60;
}

/** Minuty od północy → „6:06” (z sekundami tylko, gdy są niezerowe). */
export function formatClock(minutes: number): string {
  const total = Math.round(minutes * 60);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, '0')}${s ? `:${String(s).padStart(2, '0')}` : ''}`;
}
