import { SLI_GUIDE_REL } from './sliGuide.ts';
import fs from 'node:fs';
import path from 'node:path';
import { pinToTile } from '../../shared/taskExtras.ts';
import type { TaskView } from '../../shared/types.ts';

export interface PromptContext {
  mapName: string;
  mapFolder: string;
  /** Link do repozytorium (z ustawień). */
  repoUrl: string;
  /** Gałąź, na którą Claude ma wypchnąć zmiany (z ustawień). */
  branch: string;
  /** Czy istnieje _vibe/assets (kopie assetów użytych na mapie). */
  hasAssets?: boolean;
}

/** Rozmiar kafla OMSI w metrach (pinezka jest zapisana w jednostkach kafli). */
export const TILE_SIZE_M = 300;

/** Krótka notka: gdzie szukać dokładnych danych o splinach i obiektach (bez wklejania ich do promptu). */
export const ASSETS_NOTE =
  'Dokładne dane o splinach (.sli) i obiektach (.sco) użytych na mapie leżą w `_vibe/assets/` ' +
  '(ścieżki jak w folderze OMSI, np. `_vibe/assets/Splines/...`). Szukaj konkretnych plików przez Glob/Grep ' +
  'i czytaj tylko te, których potrzebujesz. Lista kafli i użytych assetów: `_vibe/map-index.json` ' +
  '(duży plik — przeszukuj Grepem, nie czytaj całego).';

/** Wzmianka o instrukcji czytania .sli — dodawana do każdego promptu. */
export const SLI_NOTE =
  `Jak czytać pliki splinów (.sli): zajrzyj do \`${SLI_GUIDE_REL}\` (krótka instrukcja formatu, tylko do odczytu).`;

/** Jedyne miejsca, które wolno edytować — pierwsza pozycja zależy od mapy. */
export function allowedEditPaths(mapFolder: string): string[] {
  return [`${mapFolder}/`, '_vibe/inspirations/', '_vibe/failed.ve'];
}

export function rulesSection(mapFolder: string): string[] {
  return [
    '## Zasady edycji',
    '',
    'Wolno Ci edytować (tworzyć, zmieniać, usuwać) TYLKO I WYŁĄCZNIE:',
    `- pliki w folderze mapy: \`${mapFolder}/\`,`,
    '- folder `_vibe/inspirations/` — tam zwięźle zapisuj swoje przemyślenia i notatki (krótkie pliki .md),',
    '- plik `_vibe/failed.ve` — wyłącznie według zasad z sekcji „Zadania, których nie da się wykonać”.',
    '',
    'Zakazy:',
    '- NIE ruszaj folderu `_vibe/assets/` ani pliku `_vibe/jak_czytac_sli.txt` (to tylko do odczytu),',
    '- NIE zmyślaj nieistniejących assetów: używaj tylko takich splinów i obiektów, których pliki istnieją ' +
      'w `_vibe/assets/` albo są już użyte na mapie; nie wymyślaj ścieżek ani nazw plików,',
    '- NIE edytuj niczego innego (m.in. reszty `_vibe/`, plików poza folderem mapy). ' +
      'Jeśli zadanie wymagałoby takiej zmiany, potraktuj je jako niewykonalne.',
    '',
  ];
}

export function repoSection(repoUrl: string, branch: string): string[] {
  return [
    '## Repozytorium',
    '',
    `Pracujemy na repozytorium: ${repoUrl}`,
    `Po wykonaniu zadań zpushuj zmiany do tego repozytorium na branchu \`${branch}\` ` +
      `(\`git add -A\`, \`git commit\`, \`git push origin ${branch}\`). Nie zmieniaj brancha ani nie pushuj na inne.`,
    '',
  ];
}

export function failureSection(): string[] {
  return [
    '## Zadania, których nie da się wykonać',
    '',
    'Zadania są ponumerowane (Zadanie 1, Zadanie 2, …). Jeśli któregoś z nich nie dasz rady zrealizować, ' +
      'wpisz jego numer w pliku `_vibe/failed.ve` i krótko opisz, dlaczego się nie udało. ' +
      'Format: jedna linijka na zadanie, `<numer>: <krótki powód>`, np.:',
    '',
    '```',
    '2: brak splinu Splines/Road/x.sli w _vibe/assets',
    '5: zadanie wymaga edycji poza folderem mapy',
    '```',
    '',
    'Wykonaj pozostałe zadania normalnie. Jeśli wszystko się udało, nie tworź tego pliku.',
    '',
  ];
}

function describeExtras(t: TaskView): string[] {
  const out: string[] = [];
  if (t.tileRange && t.tileRange.length > 0) {
    const shown = t.tileRange.slice(0, 200).map((c) => `(${c.x}, ${c.y})`);
    const more = t.tileRange.length > shown.length ? ` … (łącznie ${t.tileRange.length})` : '';
    out.push(`Zakres kafli (x, y): ${shown.join(', ')}${more}`);
  }
  if (t.pin) {
    const p = pinToTile(t.pin);
    out.push(
      `Pinezka: kafel (${p.x}, ${p.y}), przesunięcie od środka kafla ≈ ` +
        `(${Math.round(p.dx * TILE_SIZE_M)} m, ${Math.round(p.dy * TILE_SIZE_M)} m); oś Y rośnie na północ, kafel ma ${TILE_SIZE_M}×${TILE_SIZE_M} m.`,
    );
  }
  if (t.attachment) {
    const label = t.attachment.kind === 'road' ? 'jezdnia (spline)' : 'obiekt';
    const name = t.attachment.name ? ` „${t.attachment.name}”` : '';
    out.push(`Załączona ${label}${name}: \`${t.attachment.path}\` (dane: \`_vibe/assets/${t.attachment.path}\`)`);
  }
  return out;
}

/** Składa jeden plik tekstowy z zaznaczonych zadań: kontekst repo, zasady, ponumerowane zadania. */
export function buildPrompt(tasks: TaskView[], ctx: PromptContext): string {
  const parts: string[] = [
    `# VibeEditor — zadania dla mapy OMSI „${ctx.mapName}”`,
    '',
    `Folder mapy: ${ctx.mapFolder}`,
    '',
    'Wykonaj poniższe zadania, edytując pliki mapy w bieżącym katalogu roboczym.',
    ...(ctx.hasAssets ? [ASSETS_NOTE] : []),
    SLI_NOTE,
    '',
    ...repoSection(ctx.repoUrl, ctx.branch),
    ...rulesSection(ctx.mapFolder),
    ...failureSection(),
    `## Zadania (${tasks.length})`,
    '',
  ];
  tasks.forEach((t, i) => {
    parts.push(`### Zadanie ${i + 1}: ${t.title}`, '');
    for (const line of describeExtras(t)) parts.push(line);
    if (t.content) parts.push('', t.content);
    parts.push('');
  });
  return parts.join('\n').trimEnd() + '\n';
}

const pad = (n: number): string => String(n).padStart(2, '0');

export function timestamp(d = new Date()): string {
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

/** Zapisuje prompt do <vibe>/prompts/prompt-<czas>.md i zwraca ścieżkę. */
export function writePromptFile(vibeDir: string, text: string, now = new Date()): string {
  const dir = path.join(vibeDir, 'prompts');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `prompt-${timestamp(now)}.md`);
  fs.writeFileSync(file, text, 'utf-8');
  return file;
}
