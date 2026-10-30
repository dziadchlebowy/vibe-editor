import fs from 'node:fs';
import path from 'node:path';
import type { LineFile, LineTour, LineTrip, TimetableData, TripFile, TripProfile } from '../../shared/types.ts';
import { decodeCfg, encodeCfg, splitLines } from './globalCfg.ts';
import { formatDep, parseClock } from '../../shared/clock.ts';
import { safeJoin } from './mapIndex.ts';

const SEP = '------------------------------------';
const MAX_DEPTH = 4;

const num = (s: string | undefined): number => {
  const v = Number((s ?? '').trim().replace(',', '.'));
  return Number.isFinite(v) ? v : 0;
};
const f3 = (n: number): string => n.toFixed(3);

export { formatDep, parseClock };

function detectEol(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

// --- .ttl: linia -------------------------------------------------------------

/**
 * Układ pliku: nagłówek (do pierwszego [newtour]), potem brygady:
 * [newtour] / numer / typ pojazdu / … / pusta / ---- / pusta / kursy:
 * „  Dep.: h:m:s” (komentarz wyliczany z czasu), [addtrip] / nazwa kursu / 0 / czas startu w minutach / pusta.
 */
export function parseLine(text: string): { preamble: string[]; tours: LineTour[]; tail: string[]; userAllowed: boolean } {
  const lines = splitLines(text);
  let i = lines.findIndex((l) => l.trim().toLowerCase() === '[newtour]');
  if (i < 0) return { preamble: lines, tours: [], tail: [], userAllowed: hasUserAllowed(lines) };
  const preamble = lines.slice(0, i);
  const tours: LineTour[] = [];
  let tail: string[] = [];
  while (i < lines.length) {
    const t = lines[i].trim().toLowerCase();
    if (t === '[newtour]') {
      const number = (lines[i + 1] ?? '').trim();
      i += 2;
      const header: string[] = [];
      while (i < lines.length && !lines[i].trim().startsWith('---') && !lines[i].trim().startsWith('[')) {
        if (lines[i].trim()) header.push(lines[i].trim());
        i++;
      }
      tours.push({ number, header, trips: [] });
    } else if (t === '[addtrip]' && tours.length > 0) {
      const trip: LineTrip = {
        trip: (lines[i + 1] ?? '').trim(),
        flag: (lines[i + 2] ?? '0').trim(),
        start: num(lines[i + 3]),
        extra: [],
      };
      i += 4;
      while (i < lines.length && lines[i].trim() && !/^(\[|-{3}|dep\.:)/i.test(lines[i].trim())) trip.extra.push(lines[i++].trim());
      tours[tours.length - 1].trips.push(trip);
    } else if (t.startsWith('---') || t === '' || t.startsWith('dep.:')) {
      i++;
    } else {
      // nieznany znacznik: zachowaj resztę pliku bez zmian
      tail = lines.slice(i);
      break;
    }
  }
  // plik kończący się znakiem nowej linii: split daje na końcu pusty element — zachowujemy go
  if (tail.length === 0 && lines[lines.length - 1] === '') tail = [''];
  return { preamble, tours, tail, userAllowed: hasUserAllowed(preamble) };
}

export const hasUserAllowed = (lines: string[]): boolean => lines.some((l) => l.trim().toLowerCase() === '[userallowed]');

/** Dodaje albo usuwa znacznik [userallowed] (wraz z jedną pustą linijką pod nim); bez zmian, gdy już jest jak trzeba. */
export function withUserAllowed(preamble: string[], on: boolean): string[] {
  const i = preamble.findIndex((l) => l.trim().toLowerCase() === '[userallowed]');
  if (on === (i >= 0)) return preamble;
  const out = [...preamble];
  if (!on) {
    out.splice(i, out[i + 1]?.trim() === '' ? 2 : 1);
    return out;
  }
  const at = out.findIndex((l) => l.trim().toLowerCase() === '[priority]');
  out.splice(at >= 0 ? at : out.length, 0, '[userallowed]', '');
  return out;
}

export function serializeLine(
  src: { preamble: string[]; tail: string[] },
  tours: LineTour[],
  userAllowed?: boolean,
): string[] {
  const out = userAllowed === undefined ? [...src.preamble] : withUserAllowed(src.preamble, userAllowed);
  tours.forEach((tour, k) => {
    if (k > 0) out.push(SEP, '');
    out.push('[newtour]', tour.number, ...tour.header, '', SEP, '');
    for (const tr of tour.trips) {
      out.push(`  Dep.: ${formatDep(tr.start)}`, '[addtrip]', tr.trip, tr.flag, f3(tr.start), ...tr.extra, '');
    }
  });
  out.push(...src.tail);
  return out;
}

// --- .ttp: kurs --------------------------------------------------------------

interface TripScan {
  trip: TripFile;
  /** Numery linii (0-based) z wartościami profilu: [profil][rodzaj][przystanek] → numer linii. */
  at: { arr: Map<number, number>; dep: Map<number, number>; stop: Map<number, number>; end: number }[];
  tripLine: number;
}

function scanTrip(text: string, file: string): { lines: string[]; scan: TripScan } {
  const lines = splitLines(text);
  const stations: TripFile['stations'] = [];
  const profiles: TripProfile[] = [];
  const at: TripScan['at'] = [];
  let internalName = '';
  let title = '';
  let line = '';
  let tripLine = -1;
  let cur = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim().toLowerCase();
    if (t === '[trip]' && tripLine < 0) {
      tripLine = i;
      internalName = (lines[i + 1] ?? '').trim();
      title = (lines[i + 2] ?? '').trim();
      line = (lines[i + 3] ?? '').trim();
    } else if (t === '[station]') {
      stations.push({ id: (lines[i + 1] ?? '').trim(), index: stations.length, name: (lines[i + 3] ?? '').trim(), tile: Math.round(num(lines[i + 4] ?? '-1')) });
    } else if (t === '[profile]') {
      profiles.push({ name: (lines[i + 1] ?? '').trim(), total: num(lines[i + 2]), arr: {}, dep: {}, stop: {} });
      at.push({ arr: new Map(), dep: new Map(), stop: new Map(), end: lines.length });
      if (cur >= 0) at[cur].end = i;
      cur = profiles.length - 1;
    } else if (cur >= 0 && (t === '[profile_man_arr_time]' || t === '[profile_man_dep_time]' || t === '[profile_otherstopping]')) {
      const idx = Math.round(num(lines[i + 1]));
      const kind = t === '[profile_man_arr_time]' ? 'arr' : t === '[profile_man_dep_time]' ? 'dep' : 'stop';
      profiles[cur][kind][idx] = num(lines[i + 2]);
      at[cur][kind].set(idx, i + 2);
    }
  }
  const name = path.basename(file).replace(/\.ttp$/i, '');
  return { lines, scan: { trip: { file, name, internalName, title, line, stations, profiles }, at, tripLine } };
}

export function parseTrip(text: string, file: string): TripFile {
  return scanTrip(text, file).scan.trip;
}

/** Nanosi zmiany z modelu na tekst pliku .ttp w miejscu (reszta pliku zostaje bez zmian). */
export function applyTrip(text: string, edited: TripFile): string[] {
  const { lines: raw, scan } = scanTrip(text, edited.file);
  const lines: (string | null)[] = raw;
  if (scan.tripLine >= 0) {
    lines[scan.tripLine + 2] = edited.title;
    lines[scan.tripLine + 3] = edited.line;
  }
  const inserts: { at: number; lines: string[] }[] = [];
  edited.profiles.forEach((p, pi) => {
    const pos = scan.at[pi];
    if (!pos) return;
    const add: string[] = [];
    const kinds = [
      ['arr', '[profile_man_arr_time]', f3],
      ['dep', '[profile_man_dep_time]', f3],
      ['stop', '[profile_otherstopping]', (n: number) => String(Math.round(n))],
    ] as const;
    for (const [kind] of kinds) {
      for (const [idx, ln] of pos[kind]) {
        if (p[kind][idx] === undefined) lines.splice(ln - 2, 3, null, null, null);
      }
    }
    const idxs = new Set<number>([...Object.keys(p.arr), ...Object.keys(p.dep), ...Object.keys(p.stop)].map(Number));
    for (const idx of [...idxs].sort((a, b) => a - b)) {
      for (const [kind, tag, fmt] of kinds) {
        const v = p[kind][idx];
        const ln = pos[kind].get(idx);
        if (v === undefined || !Number.isFinite(v)) continue;
        if (ln !== undefined) lines[ln] = fmt(v);
        else add.push(tag, String(idx), fmt(v));
      }
    }
    if (add.length) inserts.push({ at: pos.end, lines: add });
    // nazwa i czas całkowity profilu: dwie linijki po [profile] — znajdź n-ty znacznik
    let seen = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]?.trim().toLowerCase() === '[profile]' && ++seen === pi) {
        lines[i + 1] = p.name;
        lines[i + 2] = f3(p.total);
        break;
      }
    }
  });
  // wstawki od końca, żeby numery linii się nie przesuwały; przed końcowymi pustymi liniami profilu
  for (const ins of inserts.sort((a, b) => b.at - a.at)) {
    let at = ins.at;
    while (at > 0 && (lines[at - 1] ?? '').trim() === '') at--;
    lines.splice(at, 0, ...ins.lines);
  }
  return lines.filter((l): l is string => l !== null);
}

// --- dysk ------------------------------------------------------------------

function walk(dir: string, rel: string, depth: number, out: string[]): void {
  if (depth > MAX_DEPTH) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walk(path.join(dir, e.name), r, depth + 1, out);
    else if (/\.(ttl|ttp)$/i.test(e.name)) out.push(r);
  }
}

/** Wczytuje wszystkie linie (.ttl) i kursy (.ttp) z folderu mapy. */
export function loadTimetable(mapDir: string): TimetableData {
  const files: string[] = [];
  walk(mapDir, '', 0, files);
  files.sort((a, b) => a.localeCompare(b, 'pl'));
  const data: TimetableData = { lines: [], trips: [] };
  for (const rel of files) {
    const full = safeJoin(mapDir, rel);
    if (!full) continue;
    try {
      const text = decodeCfg(fs.readFileSync(full)).text;
      if (/\.ttl$/i.test(rel)) {
        const parsed = parseLine(text);
        data.lines.push({ file: rel, name: path.basename(rel).replace(/\.ttl$/i, ''), userAllowed: parsed.userAllowed, tours: parsed.tours });
      } else {
        const trip = parseTrip(text, rel);
        trip.hasTrack = fs.existsSync(full.replace(/\.ttp$/i, '.ttr'));
        data.trips.push(trip);
      }
    } catch {
      /* nieczytelny plik pomijamy */
    }
  }
  return data;
}

function rewrite(full: string, make: (text: string) => string[]): void {
  const buf = fs.readFileSync(full);
  const d = decodeCfg(buf);
  const lines = make(d.text);
  fs.writeFileSync(full, encodeCfg(lines.join(detectEol(d.text)), d.encoding, d.bom));
}

function validateName(s: string): boolean {
  return !/[\r\n]/.test(s);
}

export function saveLine(mapDir: string, line: LineFile): { ok: boolean; error?: string } {
  const full = /\.ttl$/i.test(line.file) ? safeJoin(mapDir, line.file) : null;
  if (!full || !fs.existsSync(full)) return { ok: false, error: 'Nie ma takiego pliku linii w folderze mapy.' };
  for (const t of line.tours) {
    for (const v of [t.number, ...t.header, ...t.trips.flatMap((x) => [x.trip, x.flag, ...x.extra])]) {
      if (!validateName(v)) return { ok: false, error: 'Wartości nie mogą zawierać znaków nowej linii.' };
    }
    for (const x of t.trips) {
      if (!x.trip.trim()) return { ok: false, error: `Brygada ${t.number}: kurs bez nazwy.` };
      if (!Number.isFinite(x.start) || x.start < 0) return { ok: false, error: `Brygada ${t.number}: nieprawidłowa godzina.` };
    }
  }
  rewrite(full, (text) => {
    const src = parseLine(text);
    return serializeLine(src, line.tours, line.userAllowed);
  });
  return { ok: true };
}

export function saveTrip(mapDir: string, trip: TripFile): { ok: boolean; error?: string } {
  const full = /\.ttp$/i.test(trip.file) ? safeJoin(mapDir, trip.file) : null;
  if (!full || !fs.existsSync(full)) return { ok: false, error: 'Nie ma takiego pliku kursu w folderze mapy.' };
  if (![trip.title, trip.line, ...trip.profiles.map((p) => p.name)].every(validateName)) {
    return { ok: false, error: 'Wartości nie mogą zawierać znaków nowej linii.' };
  }
  rewrite(full, (text) => applyTrip(text, trip));
  return { ok: true };
}
