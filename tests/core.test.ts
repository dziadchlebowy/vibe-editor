import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildPrompt, writePromptFile } from '../src/main/core/promptBuilder.ts';
import { detectRateLimit } from '../src/main/core/rateLimit.ts';
import { TaskStore } from '../src/main/core/tasks.ts';
import { formatEvent } from '../src/main/core/claude.ts';
import { TASK_TYPES, validateTaskInput } from '../src/shared/taskTypes.ts';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 've-core-'));

test('walidacja zadania: tytuł i wymagane pola', () => {
  assert.equal(TASK_TYPES[0].kind, 'text');
  assert.ok(validateTaskInput('text', '', { text: 'x' }));
  assert.ok(validateTaskInput('text', 'T', { text: '  ' }));
  assert.ok(validateTaskInput('nieznany', 'T', {}));
  assert.equal(validateTaskInput('text', 'T', { text: 'x' }), null);
});

test('TaskStore: dodawanie, treść z algorytmu, zaznaczanie, archiwizacja, usuwanie', () => {
  const store = new TaskStore(path.join(tmp(), '_vibe', 'tasks.json'));
  const a = store.add({ title: ' Dodaj drzewa ', kind: 'text', data: { text: '  Posadź lipy przy trasie.  ' } });
  const b = store.add({ title: 'Druga', kind: 'text', data: { text: 'x' } });

  let list = store.list();
  assert.equal(list.length, 2);
  assert.equal(list[0].title, 'Dodaj drzewa');
  assert.equal(list[0].content, 'Posadź lipy przy trasie.');
  assert.equal(list[0].tileRange, null);
  assert.equal(list[0].status, 'active');

  store.setChecked(a.id, true);
  assert.equal(store.list()[0].checked, true);

  store.archive([a.id]);
  list = store.list();
  assert.equal(list[0].status, 'archived');
  assert.equal(list[0].checked, false);
  assert.ok(list[0].archivedAt);
  assert.equal(list[1].status, 'active');

  store.update(b.id, { title: 'Druga v2', kind: 'text', data: { text: 'y' } });
  assert.equal(store.list()[1].content, 'y');
  assert.throws(() => store.add({ title: '', kind: 'text', data: { text: 'x' } }));

  store.remove(b.id);
  assert.equal(store.list().length, 1);
});

test('buildPrompt składa tytuły, treści i zapisuje plik w _vibe/prompts', () => {
  const store = new TaskStore(path.join(tmp(), 'tasks.json'));
  store.add({ title: 'Jedno', kind: 'text', data: { text: 'Treść jeden' } });
  store.add({ title: 'Dwa', kind: 'text', data: { text: 'Treść dwa' } });
  const text = buildPrompt(store.list(), { mapName: 'Warszawa 2008 [A5]', mapFolder: 'Warszawa', repoUrl: 'https://github.com/u/r.git', branch: 'VibeEditor' });
  assert.ok(text.includes('## Zadanie 1: Jedno'));
  assert.ok(text.includes('Treść dwa'));
  assert.ok(text.includes('Warszawa 2008 [A5]'));

  const vibe = path.join(tmp(), '_vibe');
  const file = writePromptFile(vibe, text, new Date(2026, 9, 28, 1, 2, 3));
  assert.equal(path.basename(file), 'prompt-20261028-010203.md');
  assert.equal(fs.readFileSync(file, 'utf-8'), text);
});

test('detectRateLimit: epoch, godzina zegarowa i brak limitu', () => {
  const epoch = detectRateLimit('Claude AI usage limit reached|1790000000');
  assert.equal(epoch.limited, true);
  assert.equal(epoch.resetAt?.getTime(), 1790000000 * 1000);

  const now = new Date(2026, 9, 28, 10, 0, 0);
  const pm = detectRateLimit("You've hit your limit · resets 3pm", now);
  assert.equal(pm.limited, true);
  assert.equal(pm.resetAt?.getHours(), 15);
  assert.equal(pm.resetAt?.getDate(), 28);

  const next = detectRateLimit('Usage limit reached. Your limit will reset at 9:30 AM', now);
  assert.equal(next.resetAt?.getHours(), 9);
  assert.equal(next.resetAt?.getMinutes(), 30);
  assert.equal(next.resetAt?.getDate(), 29);

  const noTime = detectRateLimit('rate limit exceeded');
  assert.equal(noTime.limited, true);
  assert.equal(noTime.resetAt, undefined);

  assert.equal(detectRateLimit('Wszystko poszło dobrze').limited, false);
});

test('formatEvent formatuje tekst, narzędzia i wynik', () => {
  assert.equal(formatEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'Cześć' }] } }), 'Cześć');
  assert.equal(
    formatEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { a: 1 } }] } }),
    '▸ Edit {"a":1}',
  );
  assert.equal(formatEvent({ type: 'result', is_error: false, result: 'Gotowe' }), '✔ Gotowe');
  assert.equal(formatEvent({ type: 'result', is_error: true, result: 'Źle' }), '✖ Źle');
  assert.equal(formatEvent({ type: 'user' }), null);
});
