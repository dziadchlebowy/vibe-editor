import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ClaudeRunner } from '../src/main/core/claude.ts';
import {
  buildPasteScript,
  describeExit,
  encodePowerShell,
  EXIT_NO_FOCUS,
  EXIT_NO_WINDOW,
  parseChatUrl,
} from '../src/main/core/claudeFree.ts';

const ID = '0a1b2c3d-1234-4abc-8def-0123456789ab';
const LINK = `claude://claude.ai/chat/${ID}`;

test('parseChatUrl przyjmuje link https, claude:// i bez schematu', () => {
  assert.equal(parseChatUrl(`https://claude.ai/chat/${ID}`), LINK);
  assert.equal(parseChatUrl(`  https://claude.ai/chat/${ID.toUpperCase()}?x=1  `), LINK);
  assert.equal(parseChatUrl(LINK), LINK);
  assert.equal(parseChatUrl(`claude.ai/chat/${ID}`), LINK);
});

test('parseChatUrl odrzuca inne adresy', () => {
  assert.equal(parseChatUrl(''), null);
  assert.equal(parseChatUrl('https://claude.ai/new'), null);
  assert.equal(parseChatUrl(`https://example.com/chat/${ID}`), null);
  assert.equal(parseChatUrl(`https://claude.ai/chat/${ID}'; calc; '`), null);
  assert.equal(parseChatUrl('https://claude.ai/chat/nie-uuid'), null);
});

test('buildPasteScript: link, Ctrl+V i opcjonalny Enter', () => {
  const withEnter = buildPasteScript(LINK, { autoSend: true });
  assert.ok(withEnter.includes(`Start-Process '${LINK}'`));
  assert.ok(withEnter.includes("SendKeys('^v')"));
  assert.ok(withEnter.includes("SendKeys('{ENTER}')"));
  assert.ok(withEnter.indexOf('^v') < withEnter.indexOf('{ENTER}'));
  assert.ok(withEnter.includes(`exit ${EXIT_NO_WINDOW}`) && withEnter.includes(`exit ${EXIT_NO_FOCUS}`));

  const noEnter = buildPasteScript(LINK, { autoSend: false });
  assert.ok(noEnter.includes("SendKeys('^v')"));
  assert.ok(!noEnter.includes('{ENTER}'));
});

test('buildPasteScript odrzuca link spoza formatu czatu', () => {
  assert.throws(() => buildPasteScript("claude://claude.ai/chat/x'; calc; '", { autoSend: true }));
  assert.throws(() => buildPasteScript('https://claude.ai/chat/' + ID, { autoSend: true }));
});

test('encodePowerShell koduje UTF-16LE w Base64', () => {
  const b64 = encodePowerShell('Write-Output "zażółć"');
  assert.equal(Buffer.from(b64, 'base64').toString('utf16le'), 'Write-Output "zażółć"');
});

test('describeExit podpowiada ręczne wklejenie', () => {
  for (const code of [EXIT_NO_WINDOW, EXIT_NO_FOCUS, 1]) assert.ok(describeExit(code).includes('Ctrl+V'));
});

function makeRunner() {
  const done: string[][] = [];
  const lines: string[] = [];
  const runner = new ClaudeRunner({
    getCwd: () => '.',
    getClaudePath: () => '',
    emit: (_s, t) => lines.push(t),
    onSuccess: (ids) => done.push(ids),
  });
  return { runner, done, lines };
}

test('runExternal: sukces archiwizuje zadania i wraca do idle', async () => {
  const { runner, done } = makeRunner();
  const states: string[] = [];
  runner.on('state', (s) => states.push(s.status));
  await runner.runExternal(['a', 'b'], async () => {});
  assert.deepEqual(states, ['running', 'idle']);
  assert.deepEqual(done, [['a', 'b']]);
  assert.equal(runner.state.error, undefined);
});

test('runExternal: błąd trafia do state.error i nie archiwizuje', async () => {
  const { runner, done } = makeRunner();
  await runner.runExternal(['a'], async () => {
    throw new Error('boom');
  });
  assert.equal(runner.state.status, 'idle');
  assert.equal(runner.state.error, 'boom');
  assert.deepEqual(done, []);
});

test('runExternal: stop() przerywa akcję bez błędu i bez archiwizacji', async () => {
  const { runner, done } = makeRunner();
  const p = runner.runExternal(['a'], (signal) => new Promise<void>((_res, rej) => signal.addEventListener('abort', () => rej(new Error('Zatrzymano.')))));
  assert.equal(runner.state.status, 'running');
  runner.stop();
  await p;
  assert.equal(runner.state.status, 'idle');
  assert.equal(runner.state.error, undefined);
  assert.deepEqual(done, []);
});

test('runExternal: drugi start w trakcie pracy jest odrzucony', async () => {
  const { runner } = makeRunner();
  let release!: () => void;
  const first = runner.runExternal(['a'], () => new Promise<void>((r) => (release = r)));
  await assert.rejects(runner.runExternal(['b'], async () => {}), /w toku/);
  release();
  await first;
});
