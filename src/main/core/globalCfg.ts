import fs from 'node:fs';
import path from 'node:path';

export type CfgEncoding = 'utf-8' | 'windows-1250' | 'utf-16le' | 'utf-16be';

export interface GlobalInfo {
  name: string;
  friendlyname: string;
  description: string;
}

export interface MapFolder extends GlobalInfo {
  /** Nazwa podfolderu (względem folderu roboczego). */
  folder: string;
  cfgPath: string;
}

export interface DecodedCfg {
  text: string;
  encoding: CfgEncoding;
  bom: boolean;
}

const MARKER = /^\s*\[([^\]\r\n]+)\]\s*$/;

// --- kodowanie -------------------------------------------------------------

let cp1250Reverse: Map<string, number> | null = null;

function getCp1250Reverse(): Map<string, number> {
  if (cp1250Reverse) return cp1250Reverse;
  const dec = new TextDecoder('windows-1250');
  const map = new Map<string, number>();
  for (let b = 0; b < 256; b++) {
    const ch = dec.decode(Uint8Array.of(b));
    if (ch !== '�' && !map.has(ch)) map.set(ch, b);
  }
  cp1250Reverse = map;
  return map;
}

export function decodeCfg(buf: Buffer): DecodedCfg {
  // UTF-16 (OMSI zapisuje tak część plików) rozpoznajemy po BOM
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: buf.subarray(2).toString('utf16le'), encoding: 'utf-16le', bom: true };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2)).swap16();
    return { text: swapped.toString('utf16le'), encoding: 'utf-16be', bom: true };
  }
  let body = buf;
  let bom = false;
  if (body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) {
    body = body.subarray(3);
    bom = true;
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    return { text, encoding: 'utf-8', bom };
  } catch {
    return { text: new TextDecoder('windows-1250').decode(body), encoding: 'windows-1250', bom: false };
  }
}

export function encodeCfg(text: string, encoding: CfgEncoding, bom: boolean): Buffer {
  if (encoding === 'utf-16le') {
    return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  }
  if (encoding === 'utf-16be') {
    return Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()]);
  }
  if (encoding === 'utf-8') {
    const body = Buffer.from(text, 'utf-8');
    return bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
  }
  const rev = getCp1250Reverse();
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) out.push(cp);
    else out.push(rev.get(ch) ?? 0x3f); // '?'
  }
  return Buffer.from(out);
}

// --- parsowanie ------------------------------------------------------------

export interface Section {
  marker: string;
  /** Indeks linii ze znacznikiem. */
  start: number;
  /** Indeks pierwszej linii następnego znacznika (lub długość tablicy). */
  end: number;
}

function detectEol(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

export function splitLines(text: string): string[] {
  return text.split(/\r\n|\n|\r/);
}

export function findSections(lines: string[]): Section[] {
  const starts: { marker: string; start: number }[] = [];
  lines.forEach((line, i) => {
    const m = MARKER.exec(line);
    if (m) starts.push({ marker: m[1].trim().toLowerCase(), start: i });
  });
  return starts.map((s, idx) => ({
    marker: s.marker,
    start: s.start,
    end: idx + 1 < starts.length ? starts[idx + 1].start : lines.length,
  }));
}

interface MapSections {
  name: Section;
  friendly: Section;
  desc: Section;
}

/** Znajduje (pierwsze wystąpienia) znaczników [name], [friendlyname], [description] — w dowolnym miejscu pliku. */
function locateMapSections(sections: Section[]): MapSections | null {
  const name = sections.find((s) => s.marker === 'name');
  const friendly = sections.find((s) => s.marker === 'friendlyname');
  const desc = sections.find((s) => s.marker === 'description');
  return name && friendly && desc ? { name, friendly, desc } : null;
}

function sectionBody(lines: string[], s: Section): string[] {
  const body = lines.slice(s.start + 1, s.end);
  while (body.length && body[body.length - 1].trim() === '') body.pop();
  while (body.length && body[0].trim() === '') body.shift();
  return body;
}

/** Zwraca dane mapy albo null, jeśli w tekście brakuje któregoś ze znaczników. */
export function parseGlobalCfg(text: string): GlobalInfo | null {
  const lines = splitLines(text);
  const found = locateMapSections(findSections(lines));
  if (!found) return null;
  return {
    name: (sectionBody(lines, found.name)[0] ?? '').trim(),
    friendlyname: (sectionBody(lines, found.friendly)[0] ?? '').trim(),
    description: sectionBody(lines, found.desc).join('\n'),
  };
}

const oneLine = (s: string): string => s.replace(/\s*[\r\n]+\s*/g, ' ').trim();

/**
 * Podmienia treść sekcji [name], [friendlyname], [description] (gdziekolwiek stoją w pliku).
 * Sekcje, których wartość się nie zmieniła, i cała reszta pliku zostają bez zmian.
 */
export function applyGlobalInfo(text: string, info: GlobalInfo): string {
  const eol = detectEol(text);
  const lines = splitLines(text);
  const found = locateMapSections(findSections(lines));
  if (!found) return text;
  const current = parseGlobalCfg(text)!;

  const descLines = info.description.split(/\r\n|\n|\r/);
  while (descLines.length && descLines[descLines.length - 1].trim() === '') descLines.pop();

  const jobs: { section: Section; content: string[]; changed: boolean }[] = [
    { section: found.name, content: [oneLine(info.name)], changed: oneLine(info.name) !== current.name },
    {
      section: found.friendly,
      content: [oneLine(info.friendlyname)],
      changed: oneLine(info.friendlyname) !== current.friendlyname,
    },
    {
      section: found.desc,
      content: descLines,
      changed: descLines.join('\n') !== current.description,
    },
  ];

  // od końca pliku, żeby wcześniejsze indeksy się nie przesuwały
  jobs.sort((x, y) => y.section.start - x.section.start);
  for (const { section, content, changed } of jobs) {
    if (!changed) continue;
    const body = lines.slice(section.start + 1, section.end);
    let lead = 0;
    while (lead < body.length && body[lead].trim() === '') lead++;
    let trail = 0;
    while (lead < body.length && trail < body.length - lead && body[body.length - 1 - trail].trim() === '') trail++;
    const blank = (n: number): string[] => Array<string>(n).fill('');
    lines.splice(section.start + 1, body.length, ...blank(lead), ...content, ...blank(trail));
  }
  return lines.join(eol);
}

// --- system plików ---------------------------------------------------------

export function findCfgFile(dir: string): string | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const hit = entries.find((f) => f.toLowerCase() === 'global.cfg');
  if (!hit) return null;
  const full = path.join(dir, hit);
  try {
    return fs.statSync(full).isFile() ? full : null;
  } catch {
    return null;
  }
}

export function readMapCfg(cfgPath: string): GlobalInfo | null {
  try {
    return parseGlobalCfg(decodeCfg(fs.readFileSync(cfgPath)).text);
  } catch {
    return null;
  }
}

/** Szuka w folderze roboczym podfolderów będących mapami OMSI (global.cfg z właściwymi znacznikami). */
export function findMapFolders(workDir: string): MapFolder[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(workDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const maps: MapFolder[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('_') || e.name.startsWith('.')) continue;
    const cfgPath = findCfgFile(path.join(workDir, e.name));
    if (!cfgPath) continue;
    const info = readMapCfg(cfgPath);
    if (info) maps.push({ folder: e.name, cfgPath, ...info });
  }
  maps.sort((a, b) => a.folder.localeCompare(b.folder));
  return maps;
}

/** Zapisuje zmienione dane do global.cfg. Zwraca true, jeśli plik faktycznie zmieniono. */
export function writeMapInfo(cfgPath: string, info: GlobalInfo): boolean {
  const decoded = decodeCfg(fs.readFileSync(cfgPath));
  const updated = applyGlobalInfo(decoded.text, info);
  if (updated === decoded.text) return false;
  fs.writeFileSync(cfgPath, encodeCfg(updated, decoded.encoding, decoded.bom));
  return true;
}
