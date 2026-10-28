import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { GitRunner, setupRepo } from '../src/main/core/git.ts';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 've-git-'));
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();

function makeWorkDir(): string {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'Warszawa'));
  fs.writeFileSync(path.join(dir, 'Warszawa', 'global.cfg'), '[name]\nA\n\n[friendlyname]\nB\n\n[description]\nC\n[end]\n');
  fs.writeFileSync(path.join(dir, 'Warszawa', 'tile_0_0.map'), 'x');
  return dir;
}

test('setupRepo: init, gałąź VibeEditor, commit i push do pustego remote; drugi raz jest idempotentny', async () => {
  const remote = tmp();
  git(remote, 'init', '--bare', '-b', 'main');
  const work = makeWorkDir();
  const lines: string[] = [];
  const runner = new GitRunner(work, (_s, t) => lines.push(t));

  await setupRepo(runner, { workDir: work, remoteUrl: remote, branch: 'VibeEditor' });

  assert.ok(fs.existsSync(path.join(work, '_vibe')));
  assert.equal(git(remote, 'branch', '--list', 'VibeEditor').replace('*', '').trim(), 'VibeEditor');
  assert.equal(git(work, 'rev-parse', '--abbrev-ref', 'HEAD'), 'VibeEditor');
  assert.ok(git(remote, 'ls-tree', '-r', '--name-only', 'VibeEditor').includes('Warszawa/global.cfg'));
  assert.ok(lines.some((l) => l.startsWith('$ git push')));

  fs.writeFileSync(path.join(work, 'Warszawa', 'tile_0_1.map'), 'y');
  await setupRepo(runner, { workDir: work, remoteUrl: remote, branch: 'VibeEditor' });
  assert.ok(git(remote, 'ls-tree', '-r', '--name-only', 'VibeEditor').includes('Warszawa/tile_0_1.map'));
  assert.equal(git(work, 'rev-list', '--count', 'HEAD'), '2');
});

test('setupRepo: nowa gałąź opiera się na istniejącym main ze zdalnego repo', async () => {
  const remote = tmp();
  git(remote, 'init', '--bare', '-b', 'main');
  const seed = tmp();
  git(seed, 'init', '-b', 'main');
  fs.writeFileSync(path.join(seed, 'README.md'), 'start');
  git(seed, 'add', '-A');
  git(seed, '-c', 'user.email=a@b.c', '-c', 'user.name=T', 'commit', '-m', 'init');
  git(seed, 'push', remote, 'main');

  const work = makeWorkDir();
  const runner = new GitRunner(work, () => {});
  await setupRepo(runner, { workDir: work, remoteUrl: remote, branch: 'VibeEditor' });

  // historia opiera się na main (commit bazowy + synchronizacja)...
  assert.equal(git(remote, 'rev-list', '--count', 'VibeEditor'), '2');
  assert.ok(git(remote, 'ls-tree', '-r', '--name-only', 'main').includes('README.md'));
  // ...a zawartość gałęzi odpowiada folderowi roboczemu (źródło prawdy)
  const files = git(remote, 'ls-tree', '-r', '--name-only', 'VibeEditor');
  assert.ok(files.includes('Warszawa/tile_0_0.map'));
  assert.ok(!files.includes('README.md'));
});

test('setupRepo: praca na main pushuje na main', async () => {
  const remote = tmp();
  git(remote, 'init', '--bare', '-b', 'main');
  const work = makeWorkDir();
  await setupRepo(new GitRunner(work, () => {}), { workDir: work, remoteUrl: remote, branch: 'main' });
  assert.ok(git(remote, 'ls-tree', '-r', '--name-only', 'main').includes('Warszawa/global.cfg'));
});

test('GitRunner zgłasza błąd przy nieprawidłowym remote', async () => {
  const work = makeWorkDir();
  const runner = new GitRunner(work, () => {});
  await assert.rejects(
    setupRepo(runner, { workDir: work, remoteUrl: path.join(tmp(), 'nie-istnieje'), branch: 'VibeEditor' }),
    /fetch/,
  );
});
