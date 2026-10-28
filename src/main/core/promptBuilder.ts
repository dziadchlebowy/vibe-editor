import fs from 'node:fs';
import path from 'node:path';
import type { TaskView } from '../../shared/types.ts';

export interface PromptContext {
  mapName: string;
  mapFolder: string;
}

/** Składa jeden plik tekstowy z zaznaczonych zadań (tytuł, treść, zakres kafli). */
export function buildPrompt(tasks: TaskView[], ctx: PromptContext): string {
  const parts: string[] = [
    `# VibeEditor — zadania dla mapy OMSI „${ctx.mapName}”`,
    '',
    `Folder mapy: ${ctx.mapFolder}`,
    '',
    'Wykonaj poniższe zadania, edytując pliki mapy w bieżącym katalogu roboczym.',
    'Folder `_vibe` zawiera pliki pomocnicze edytora — nie modyfikuj go, chyba że zadanie tego wymaga.',
    '',
  ];
  tasks.forEach((t, i) => {
    parts.push(`## Zadanie ${i + 1}: ${t.title}`, '');
    if (t.tileRange) parts.push(`Zakres kafli: ${JSON.stringify(t.tileRange)}`, '');
    parts.push(t.content, '');
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
