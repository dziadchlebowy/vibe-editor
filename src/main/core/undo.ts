import fs from 'node:fs';
import { encodeCfg, type decodeCfg } from './globalCfg.ts';

/** Zmieniony kafel do zapisu: ścieżka pliku, linie po edycji i dane o kodowaniu z odczytu. */
export interface TileWrite {
  full: string;
  lines: string[];
  dec: ReturnType<typeof decodeCfg>;
}

interface Snap {
  full: string;
  before: Buffer;
  after: Buffer;
}
interface Entry {
  label: string;
  files: Snap[];
  tiles: number[];
}

const MAX_ENTRIES = 25;
const undoStack: Entry[] = [];
let redoStack: Entry[] = [];

/**
 * Zapisuje zmienione kafle (z kodowaniem i zakończeniami linii z odczytu; pierwszy zapis robi kopię .bak) i dopisuje
 * operację do dziennika, żeby dało się ją cofnąć (Ctrl+Z) i ponowić (Ctrl+Y). Dziennik jest w pamięci i ma ograniczoną długość.
 */
export function writeTiles(writes: Map<number, TileWrite>, label: string): void {
  const files: Snap[] = [];
  for (const w of writes.values()) {
    if (!fs.existsSync(`${w.full}.bak`)) fs.copyFileSync(w.full, `${w.full}.bak`);
    const before = fs.readFileSync(w.full);
    const eol = w.dec.text.includes('\r\n') ? '\r\n' : '\n';
    const after = encodeCfg(w.lines.join(eol), w.dec.encoding, w.dec.bom);
    fs.writeFileSync(w.full, after);
    files.push({ full: w.full, before, after });
  }
  undoStack.push({ label, files, tiles: [...writes.keys()] });
  if (undoStack.length > MAX_ENTRIES) undoStack.shift();
  redoStack = [];
}

export function undoState(): { undo: string | null; redo: string | null } {
  return { undo: undoStack[undoStack.length - 1]?.label ?? null, redo: redoStack[redoStack.length - 1]?.label ?? null };
}

function apply(entry: Entry, from: 'after' | 'before'): string | null {
  const to = from === 'after' ? 'before' : 'after';
  for (const f of entry.files) {
    if (!fs.existsSync(f.full) || !fs.readFileSync(f.full).equals(f[from])) return `Plik ${f.full} został zmieniony poza tą operacją — nie można jej cofnąć ani ponowić.`;
  }
  for (const f of entry.files) fs.writeFileSync(f.full, f[to]);
  return null;
}

/** Cofa ostatnią operację zapisu kafli; zwraca jej nazwę i indeksy kafli do odświeżenia indeksu. */
export function undoLast(): { ok: boolean; error?: string; label?: string; tiles?: number[] } {
  const e = undoStack[undoStack.length - 1];
  if (!e) return { ok: false, error: 'Nie ma nic do cofnięcia.' };
  const err = apply(e, 'after');
  if (err) return { ok: false, error: err };
  undoStack.pop();
  redoStack.push(e);
  return { ok: true, label: e.label, tiles: e.tiles };
}

export function redoLast(): { ok: boolean; error?: string; label?: string; tiles?: number[] } {
  const e = redoStack[redoStack.length - 1];
  if (!e) return { ok: false, error: 'Nie ma nic do ponowienia.' };
  const err = apply(e, 'before');
  if (err) return { ok: false, error: err };
  redoStack.pop();
  undoStack.push(e);
  return { ok: true, label: e.label, tiles: e.tiles };
}

/** Czyści dziennik (np. po zmianie mapy lub ponownym skanowaniu). */
export function clearUndo(): void {
  undoStack.length = 0;
  redoStack = [];
}
