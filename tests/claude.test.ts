import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ClaudeRunner } from '../src/main/core/claude.ts';
import type { RunState } from '../src/shared/types.ts';

// Atrapa Claude Code: czyta stdin i drukuje zdarzenia stream-json.
const FAKE = `#!/usr/bin/env node
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const out = (o) => console.log(JSON.stringify(o));
  const resumed = process.argv.includes('--resume');
  out({ type: 'system', subtype: 'init', session_id: 'S1' });
  if (input.includes('HANG')) { setInterval(() => {}, 1000); return; }
  if (!resumed && input.includes('LIMIT')) {
    out({ type: 'result', is_error: true, result: 'Claude AI usage limit reached|1790000000', session_id: 'S1' });
    process.exit(1);
  }
  out({ type: 'assistant', message: { content: [{ type: 'text', text: resumed ? 'wznowione' : 'zrobione' }] } });
  out({ type: 'result', is_error: false, result: 'OK', session_id: 'S1' });
});
`;

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 've-claude-'));
  const bin = path.join(dir, 'fake-claude.js');
  fs.writeFileSync(bin, FAKE, { mode: 0o755 });
  const lines: string[] = [];
  const done: string[][] = [];
  const runner = new ClaudeRunner({
    getCwd: () => dir,
    getClaudePath: () => bin,
    emit: (_s, t) => lines.push(t),
    onSuccess: (ids) => done.push(ids),
  });
  const waitFor = (pred: (s: RunState) => boolean): Promise<RunState> =>
    new Promise((resolve) => {
      const on = (s: RunState): void => {
        if (pred(s)) {
          runner.off('state', on);
          resolve(s);
        }
      };
      runner.on('state', on);
    });
  return { runner, lines, done, waitFor };
}

test('sukces: stan wraca do idle, zadania trafiają do archiwizacji, output w konsoli', async () => {
  const { runner, lines, done, waitFor } = setup();
  const idle = waitFor((s) => s.status === 'idle');
  runner.start('zrób coś', ['t1', 't2']);
  assert.equal(runner.state.status, 'running');
  await idle;
  assert.deepEqual(done, [['t1', 't2']]);
  assert.ok(lines.includes('zrobione'));
  assert.ok(lines.some((l) => l.startsWith('✔')));
});

test('limit: pauza z godziną odnowienia, potem wznowienie przez --resume', async () => {
  const { runner, lines, done, waitFor } = setup();
  const paused = waitFor((s) => s.status === 'paused');
  runner.start('LIMIT', ['t1']);
  const p = await paused;
  assert.equal(p.resetAt, 1790000000 * 1000);
  assert.deepEqual(done, []);

  const idle = waitFor((s) => s.status === 'idle');
  runner.resume();
  await idle;
  assert.deepEqual(done, [['t1']]);
  assert.ok(lines.includes('wznowione'));
});

test('stop: przerywa działanie i nie archiwizuje zadań', async () => {
  const { runner, done, waitFor } = setup();
  runner.start('HANG', ['t1']);
  await new Promise((r) => setTimeout(r, 300));
  const idle = waitFor((s) => s.status === 'idle');
  runner.stop();
  await idle;
  assert.deepEqual(done, []);
});

test('brak polecenia claude: czytelny błąd i stan idle', async () => {
  const runner = new ClaudeRunner({
    getCwd: () => os.tmpdir(),
    getClaudePath: () => '/nie/ma/takiego/claude',
    emit: () => {},
    onSuccess: () => {},
  });
  const idle = new Promise<RunState>((resolve) => runner.on('state', (s: RunState) => s.status === 'idle' && resolve(s)));
  runner.start('x', ['t1']);
  const s = await idle;
  assert.match(s.error ?? '', /claude/);
});
