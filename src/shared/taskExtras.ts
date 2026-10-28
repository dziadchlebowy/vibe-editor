import type { TaskAttachment, TaskPin, TileCoord, TileRange } from './types.ts';

const MAX_TILES = 5000;
const MAX_COORD = 1_000_000;

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && Math.abs(v) <= MAX_COORD;

/** Zakres kafli: unikatowe pary liczb całkowitych; pusty zakres = null. */
export function sanitizeTileRange(v: unknown): TileRange {
  if (!Array.isArray(v)) return null;
  const seen = new Set<string>();
  const out: TileCoord[] = [];
  for (const t of v) {
    const c = t as Partial<TileCoord> | null;
    if (!c || !isInt(c.x) || !isInt(c.y)) continue;
    const key = `${c.x},${c.y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ x: c.x, y: c.y });
    if (out.length >= MAX_TILES) break;
  }
  out.sort((a, b) => a.y - b.y || a.x - b.x);
  return out.length ? out : null;
}

export function sanitizePin(v: unknown): TaskPin | null {
  const p = v as Partial<TaskPin> | null;
  if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') return null;
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || Math.abs(p.x) > MAX_COORD || Math.abs(p.y) > MAX_COORD) return null;
  return { x: Math.round(p.x * 1000) / 1000, y: Math.round(p.y * 1000) / 1000 };
}

/** Ścieżka assetu: separator „/”, bez „..”, bez dysków i znaków sterujących. */
export function normalizePath(raw: string): string | null {
  const parts = raw
    .trim()
    .split(/[\\/]+/)
    .filter((p) => p !== '' && p !== '.');
  // eslint-disable-next-line no-control-regex
  if (parts.length === 0 || parts.includes('..') || /[:\x00-\x1f]/.test(raw)) return null;
  return parts.join('/');
}

export function sanitizeAttachment(v: unknown): TaskAttachment | null {
  const a = v as Partial<TaskAttachment> | null;
  if (!a || (a.kind !== 'road' && a.kind !== 'object') || typeof a.path !== 'string') return null;
  const path = normalizePath(a.path);
  if (!path) return null;
  const out: TaskAttachment = { kind: a.kind, path };
  if (typeof a.name === 'string' && a.name.trim()) out.name = a.name.trim().slice(0, 200);
  return out;
}

/** Pinezka → kafel i przesunięcie od jego środka (w jednostkach kafla). */
export function pinToTile(pin: TaskPin): { x: number; y: number; dx: number; dy: number } {
  const x = Math.round(pin.x);
  const y = Math.round(pin.y);
  return { x, y, dx: Math.round((pin.x - x) * 1000) / 1000, dy: Math.round((pin.y - y) * 1000) / 1000 };
}
