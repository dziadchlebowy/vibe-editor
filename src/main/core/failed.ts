import fs from 'node:fs';
import path from 'node:path';
import type { Emit } from './emit.ts';
import type { TaskStore } from './tasks.ts';

/** Plik, w którym Claude zgłasza zadania, których nie dał rady wykonać. */
export const FAILED_FILE = 'failed.ve';
/** Pamiętamy, które zadania (w jakiej kolejności = jakie numery) poszły w ostatnim prompcie. */
export const LAST_RUN_FILE = 'last-run.json';

export const failedPath = (vibeDir: string): string => path.join(vibeDir, FAILED_FILE);
export const lastRunPath = (vibeDir: string): string => path.join(vibeDir, LAST_RUN_FILE);

/**
 * Format: jedna pozycja na zadanie, „<numer>: <krótki powód>” (separator: dwukropek, kropka, nawias lub myślnik).
 * Linie bez numeru na początku traktujemy jako ciąg dalszy powodu poprzedniej pozycji. Puste linie i
 * komentarze (#) są pomijane. Numery spoza 1…max są ignorowane.
 */
export function parseFailed(text: string, max = Infinity): Map<number, string> {
  const out = new Map<number, string>();
  let last: number | null = null;
  for (const raw of text.replace(/^﻿/, '').split(/\r\n|\n|\r/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:zadanie\s*)?#?(\d+)\s*(?:[:.)\-–—]\s*|\s+)(.*)$/i.exec(line) ?? /^(?:zadanie\s*)?#?(\d+)$/i.exec(line);
    if (m) {
      const n = Number(m[1]);
      if (n >= 1 && n <= max) {
        out.set(n, ((m[2] as string | undefined) ?? '').trim());
        last = n;
      } else {
        last = null;
      }
    } else if (last !== null) {
      out.set(last, `${out.get(last)} ${line}`.trim());
    }
  }
  for (const [n, c] of out) if (!c) out.set(n, 'Brak opisu powodu.');
  return out;
}

export function writeLastRun(vibeDir: string, taskIds: string[]): void {
  fs.mkdirSync(vibeDir, { recursive: true });
  fs.writeFileSync(lastRunPath(vibeDir), JSON.stringify({ at: Date.now(), taskIds }), 'utf-8');
}

export function readLastRun(vibeDir: string): string[] | null {
  try {
    const v = JSON.parse(fs.readFileSync(lastRunPath(vibeDir), 'utf-8')) as { taskIds?: unknown };
    return Array.isArray(v.taskIds) && v.taskIds.every((x) => typeof x === 'string') ? (v.taskIds as string[]) : null;
  } catch {
    return null;
  }
}

/** Usuwa pozostałość po poprzednim przebiegu, żeby stary plik nie został wzięty za nowy. */
export function clearFailed(vibeDir: string): void {
  fs.rmSync(failedPath(vibeDir), { force: true });
}

export interface ApplyOptions {
  /** Plik świeższy niż tyle ms jest pomijany (Claude może jeszcze pisać). 0 = nie czekaj. */
  stableMs?: number;
  now?: number;
}

/**
 * Wczytuje _vibe/failed.ve i przenosi wskazane zadania (po numerach z ostatniego promptu) do „Odrzuconych”
 * z komentarzem. Plik jest „zużywany” (usuwany), żeby ten sam wpis nie zadziałał dwa razy.
 * Zwraca liczbę odrzuconych zadań albo null, gdy nic nie było do zrobienia.
 */
export function applyFailed(vibeDir: string, store: TaskStore, emit: Emit, o: ApplyOptions = {}): number | null {
  const file = failedPath(vibeDir);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  if ((o.stableMs ?? 0) > 0 && (o.now ?? Date.now()) - stat.mtimeMs < (o.stableMs ?? 0)) return null;

  const ids = readLastRun(vibeDir);
  if (!ids) {
    emit('app', `Znaleziono ${FAILED_FILE}, ale nie wiadomo, którego promptu dotyczy — pomijam.`);
    fs.renameSync(file, `${file}.unmatched`);
    return null;
  }
  const entries = parseFailed(fs.readFileSync(file, 'utf-8'), ids.length);
  const comments = new Map<string, string>();
  for (const [n, comment] of entries) comments.set(ids[n - 1], comment);
  const changed = store.reject(comments);
  fs.rmSync(file, { force: true });
  if (entries.size > 0) {
    emit('app', `Claude odrzucił zadania (numery: ${[...entries.keys()].join(', ')}) — przeniesiono do „Odrzuconych”.`);
  }
  return changed;
}
