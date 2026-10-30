import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SETTINGS, needsRepoSetup } from '../src/main/core/settings.ts';

const base = { configured: true, workDir: 'C:/w', remoteUrl: 'https://github.com/u/r.git', workOnMain: false };

test('domyślny limit szerokości splinów to 30 m', () => {
  assert.equal(DEFAULT_SETTINGS.splineMaxWidth, 30);
});

test('needsRepoSetup: bez zmian w repo nie podpinamy go ponownie', () => {
  assert.equal(needsRepoSetup(base, { workDir: 'C:/w', remoteUrl: base.remoteUrl, workOnMain: false }, true), false);
});

test('needsRepoSetup: zmiana linku, gałęzi lub folderu, pierwsza konfiguracja i brak .git wymuszają podpięcie', () => {
  const same = { workDir: 'C:/w', remoteUrl: base.remoteUrl, workOnMain: false };
  assert.equal(needsRepoSetup(base, { ...same, remoteUrl: 'https://github.com/u/inne.git' }, true), true);
  assert.equal(needsRepoSetup(base, { ...same, workOnMain: true }, true), true);
  assert.equal(needsRepoSetup(base, { ...same, workDir: 'C:/inny' }, true), true);
  assert.equal(needsRepoSetup({ ...base, configured: false }, same, true), true);
  assert.equal(needsRepoSetup(base, same, false), true);
});
