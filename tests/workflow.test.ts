import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ClaudeRunner } from '../src/main/core/claude.ts';
import { applyFailed, clearFailed, failedPath, parseFailed, writeLastRun } from '../src/main/core/failed.ts';
import { GitRunner, setupRepo, syncToRemote } from '../src/main/core/git.ts';
import { buildPrompt } from '../src/main/core/promptBuilder.ts';
import { TaskStore } from '../src/main/core/tasks.ts';
import type { RunState, TaskView } from '../src/shared/types.ts';

const tmp = (p: string): string => fs.mkdtempSync(path.join(os.tmpdir(), p));
const git = (cwd: string, ...a: string[]): string => execFileSync('git', a, { cwd, encoding: 'utf-8' }).trim();

function store(): { store: TaskStore; vibe: string; ids: string[] } {
  const vibe = path.join(tmp('ve-wf-'), '_vibe');
  const s = new TaskStore(path.join(vibe, 'tasks.json'));
  const ids = ['A', 'B', 'C'].map((t) => s.add({ title: `Zadanie ${t}`, kind: 'text', data: { text: `treść ${t}` } }).id);
  return { store: s, vibe, ids };
}

test('parseFailed: numery, różne separatory, ciągi dalsze, śmieci i numery spoza zakresu', () => {
  const m = parseFailed(
    ['# komentarz', '2: brak splinu x.sli', 'Zadanie 3 - nie da się', '   i to z powodu Y', '7: poza zakresem', '1)  krótko', '4'].join('\r\n'),
    4,
  );
  assert.deepEqual([...m.entries()], [
    [2, 'brak splinu x.sli'],
    [3, 'nie da się i to z powodu Y'],
    [1, 'krótko'],
    [4, 'Brak opisu powodu.'],
  ]);
  assert.equal(parseFailed('').size, 0);
});

test('TaskStore: odrzucenie z komentarzem i „Rozwiązane” wraca do aktywnych', () => {
  const { store: s, ids } = store();
  s.archive(ids);
  assert.equal(s.reject(new Map([[ids[1], 'brak assetu']])), 1);
  let list = s.list();
  assert.equal(list[1].status, 'rejected');
  assert.equal(list[1].rejectedComment, 'brak assetu');
  assert.equal(list[1].archivedAt, undefined);
  assert.equal(list[0].status, 'archived');

  s.resolve(ids[1]);
  list = s.list();
  assert.equal(list[1].status, 'active');
  assert.equal(list[1].rejectedComment, undefined);
  s.resolve(ids[0]); // archiwalne nie jest odrzucone — bez zmian
  assert.equal(s.list()[0].status, 'archived');

  // archive() nie nadpisuje odrzuconych
  s.reject(new Map([[ids[2], 'x']]));
  s.archive([ids[2]]);
  assert.equal(s.list()[2].status, 'rejected');
});

test('applyFailed: numery z ostatniego promptu → odrzucone z komentarzem, plik zużyty', () => {
  const { store: s, vibe, ids } = store();
  writeLastRun(vibe, [ids[2], ids[0]]); // numer 1 = ids[2], numer 2 = ids[0]
  fs.writeFileSync(failedPath(vibe), '2: nie mam splinu\n9: poza\n');
  const log: string[] = [];
  s.archive([ids[0], ids[2]]);
  assert.equal(applyFailed(vibe, s, (_s, t) => log.push(t)), 1);
  const list = s.list();
  assert.equal(list[0].status, 'rejected');
  assert.equal(list[0].rejectedComment, 'nie mam splinu');
  assert.equal(list[2].status, 'archived');
  assert.ok(!fs.existsSync(failedPath(vibe)));
  assert.ok(log.some((l) => l.includes('2')));
  assert.equal(applyFailed(vibe, s, () => {}), null, 'drugi raz nic do roboty');
});

test('applyFailed: świeży plik jest pomijany (Claude jeszcze pisze); brak last-run → .unmatched', () => {
  const { store: s, vibe, ids } = store();
  writeLastRun(vibe, ids);
  fs.writeFileSync(failedPath(vibe), '1: x\n');
  assert.equal(applyFailed(vibe, s, () => {}, { stableMs: 60_000 }), null);
  assert.ok(fs.existsSync(failedPath(vibe)));
  assert.equal(applyFailed(vibe, s, () => {}, { stableMs: 60_000, now: Date.now() + 120_000 }), 1);

  const other = path.join(tmp('ve-wf2-'), '_vibe');
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(failedPath(other), '1: x\n');
  assert.equal(applyFailed(other, new TaskStore(path.join(other, 'tasks.json')), () => {}), null);
  assert.ok(fs.existsSync(failedPath(other) + '.unmatched'));
  clearFailed(other);
});

test('buildPrompt: repo i branch, numeracja, protokół failed.ve, zasady edycji, dodatki zadania', () => {
  const task = (over: Partial<TaskView>): TaskView => ({
    id: 'i', title: 'T', kind: 'text', data: {}, tileRange: null, pin: null, attachment: null,
    checked: true, status: 'active', createdAt: 0, content: 'treść', ...over,
  });
  const text = buildPrompt(
    [
      task({ title: 'Pierwsze', content: 'zrób A' }),
      task({
        title: 'Drugie',
        content: 'zrób B',
        tileRange: [{ x: 1, y: 2 }, { x: 3, y: -4 }],
        pin: { x: 1.5, y: -2 },
        attachment: { kind: 'road', path: 'Splines/Road/a.sli' },
      }),
    ],
    { mapName: 'Warszawa', mapFolder: 'Warszawa', repoUrl: 'https://github.com/u/r.git', branch: 'VibeEditor', hasAssets: true },
  );
  assert.ok(text.includes('https://github.com/u/r.git'));
  assert.ok(/zpushuj zmiany do tego repozytorium na branchu `VibeEditor`/.test(text));
  assert.ok(text.includes('git push origin VibeEditor'));
  assert.ok(text.includes('### Zadanie 1: Pierwsze'));
  assert.ok(text.includes('### Zadanie 2: Drugie'));
  assert.ok(text.includes('`_vibe/failed.ve`') && text.includes('<numer>: <krótki powód>'));
  assert.ok(text.includes('TYLKO I WYŁĄCZNIE') && text.includes('`Warszawa/`') && text.includes('`_vibe/inspirations/`'));
  assert.ok(text.includes('NIE ruszaj folderu `_vibe/assets/`') && text.includes('NIE zmyślaj nieistniejących assetów'));
  assert.ok(text.includes('Zakres kafli (x, y): (1, 2), (3, -4)'));
  assert.ok(text.includes('Pinezka: kafel (2, -2), przesunięcie od środka kafla ≈ (-150 m, 0 m)'));
  assert.ok(text.includes('Załączona jezdnia (spline): `Splines/Road/a.sli` (dane: `_vibe/assets/Splines/Road/a.sli`)'));
});

test('syncToRemote: commit + push + weryfikacja; bez zmian nie robi commita; rozjazd zgłasza błąd', async () => {
  const remote = tmp('ve-sync-r-');
  git(remote, 'init', '--bare', '-b', 'main');
  const work = tmp('ve-sync-w-');
  fs.mkdirSync(path.join(work, 'Mapa'));
  fs.writeFileSync(path.join(work, 'Mapa', 'global.cfg'), '[name]\nA\n[friendlyname]\nB\n[description]\nC\n');
  const g = new GitRunner(work, () => {});
  await setupRepo(g, { workDir: work, remoteUrl: remote, branch: 'VibeEditor' });
  assert.ok(fs.existsSync(path.join(work, '_vibe', 'inspirations')));

  // brudny folder → commit i push
  fs.writeFileSync(path.join(work, 'Mapa', 'tile.map'), 'x');
  const r1 = await syncToRemote(g, { branch: 'VibeEditor' });
  assert.equal(r1.committed, true);
  assert.equal(git(remote, 'rev-parse', 'VibeEditor'), git(work, 'rev-parse', 'HEAD'));
  assert.ok(git(remote, 'ls-tree', '-r', '--name-only', 'VibeEditor').includes('Mapa/tile.map'));

  // czysty folder → bez commita, nadal zgodne
  const before = git(work, 'rev-parse', 'HEAD');
  const r2 = await syncToRemote(g, { branch: 'VibeEditor' });
  assert.equal(r2.committed, false);
  assert.equal(git(work, 'rev-parse', 'HEAD'), before);

  // ktoś wypchnął na tę gałąź commit, którego nie mamy → push odrzucony, błąd zamiast nadpisania
  const other = tmp('ve-sync-o-');
  git(other, 'clone', '-q', remote, '.');
  git(other, 'checkout', '-q', 'VibeEditor');
  fs.writeFileSync(path.join(other, 'obcy.txt'), 'z');
  git(other, 'add', '-A');
  git(other, '-c', 'user.email=a@b.c', '-c', 'user.name=T', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'obcy');
  git(other, 'push', '-q', 'origin', 'VibeEditor');
  fs.writeFileSync(path.join(work, 'Mapa', 'nowy.map'), 'n');
  await assert.rejects(syncToRemote(g, { branch: 'VibeEditor' }), /push/);
  assert.ok(!git(remote, 'ls-tree', '-r', '--name-only', 'VibeEditor').includes('nowy.map'));
});

test('ClaudeRunner.start z prepare: przygotowanie przed procesem; błąd przygotowania nie uruchamia Claude', async () => {
  const dir = tmp('ve-prep-');
  const bin = path.join(dir, 'fake.js');
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node\nprocess.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'result',is_error:false,result:'OK',session_id:'S'}));});\n`,
    { mode: 0o755 },
  );
  const order: string[] = [];
  const mk = (): ClaudeRunner =>
    new ClaudeRunner({
      getCwd: () => dir,
      getClaudePath: () => bin,
      emit: (_s, t) => order.push('emit:' + t),
      onSuccess: () => order.push('success'),
    });
  const idle = (r: ClaudeRunner): Promise<RunState> =>
    new Promise((res) => r.on('state', (s: RunState) => s.status === 'idle' && res(s)));

  const r1 = mk();
  const done1 = idle(r1);
  r1.start('p', ['t'], async () => {
    order.push('prepare');
    await new Promise((r) => setTimeout(r, 50));
    order.push('prepared');
  });
  assert.equal(r1.state.status, 'running');
  await done1;
  assert.deepEqual(order.filter((o) => !o.startsWith('emit:$')), ['prepare', 'prepared', 'emit:OK'.replace('emit:OK', 'emit:✔ OK'), 'success']);

  const r2 = mk();
  const done2 = idle(r2);
  const calls = order.length;
  r2.start('p', ['t'], async () => {
    throw new Error('push odrzucony');
  });
  const s2 = await done2;
  assert.match(s2.error ?? '', /push odrzucony/);
  assert.ok(!order.slice(calls).some((o) => o.startsWith('emit:$')), 'Claude nie został uruchomiony');
  assert.ok(!order.slice(calls).includes('success'));

  // stop w trakcie przygotowania
  const r3 = mk();
  const done3 = idle(r3);
  r3.start('p', ['t'], () => new Promise((r) => setTimeout(r, 200)));
  r3.stop();
  await done3;
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!order.slice(calls).includes('success'));
});

test('instrukcja .sli: plik zapisywany w _vibe, prompt zawsze o niej wspomina, poprawna pisownia [heightprofile]', async () => {
  const { ensureSliGuide, SLI_GUIDE, SLI_GUIDE_REL } = await import('../src/main/core/sliGuide.ts');
  const { buildPrompt } = await import('../src/main/core/promptBuilder.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 've-sli-'));
  const file = ensureSliGuide(dir);
  assert.equal(file, path.join(dir, '_vibe', 'jak_czytac_sli.txt'));
  assert.equal(fs.readFileSync(file, 'utf-8'), SLI_GUIDE);
  assert.ok(SLI_GUIDE.includes('[heightprofile]') && SLI_GUIDE.includes('[profilepnt]') && SLI_GUIDE.includes('[path]'));
  for (const hasAssets of [true, false]) {
    const text = buildPrompt([], { mapName: 'M', mapFolder: 'M', repoUrl: 'u', branch: 'b', hasAssets });
    assert.ok(text.includes(SLI_GUIDE_REL));
  }
});
