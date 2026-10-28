import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Emit } from './emit.ts';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  /** Nie rzucaj wyjątku przy niezerowym kodzie wyjścia. */
  allowFail?: boolean;
}

/**
 * Uruchamia git w ukrytym oknie (windowsHide). Aplikacja jest pakowana z manifestem
 * requireAdministrator, więc proces git dziedziczy uprawnienia admina, a okna
 * (np. Git Credential Manager przy pushu) pojawiają się same.
 * Cały output trafia do konsoli aplikacji (źródło „git”).
 */
export class GitRunner {
  private cwd: string;
  private emit: Emit;
  private gitPath: string;

  constructor(cwd: string, emit: Emit, gitPath = 'git') {
    this.cwd = cwd;
    this.emit = emit;
    this.gitPath = gitPath;
  }

  run(args: string[], opts: RunOptions = {}): Promise<GitResult> {
    this.emit('git', `$ git ${args.join(' ')}`);
    return new Promise((resolve, reject) => {
      const child = spawn(this.gitPath, args, {
        cwd: this.cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf-8');
      child.stderr.setEncoding('utf-8');
      child.stdout.on('data', (d: string) => {
        stdout += d;
        this.emit('git', d);
      });
      child.stderr.on('data', (d: string) => {
        stderr += d;
        this.emit('git', d);
      });
      child.on('error', (err: NodeJS.ErrnoException) => {
        reject(
          err.code === 'ENOENT'
            ? new Error('Nie znaleziono polecenia git. Zainstaluj Git for Windows i dodaj go do PATH.')
            : err,
        );
      });
      child.on('close', (code) => {
        const result = { code: code ?? -1, stdout, stderr };
        if (result.code !== 0 && !opts.allowFail) {
          const detail = (stderr || stdout).trim().split(/\r?\n/).slice(-3).join(' ');
          reject(new Error(`git ${args[0]} zakończył się błędem (${result.code}): ${detail}`));
        } else {
          resolve(result);
        }
      });
    });
  }
}

export interface SetupOptions {
  workDir: string;
  remoteUrl: string;
  branch: string;
}

/**
 * Podpina folder roboczy pod repo, przełącza na właściwą gałąź i pushuje całość.
 * Procedura jest idempotentna — można ją uruchamiać ponownie po zmianie ustawień.
 */
export async function setupRepo(git: GitRunner, o: SetupOptions): Promise<void> {
  fs.mkdirSync(path.join(o.workDir, '_vibe'), { recursive: true });

  if (!fs.existsSync(path.join(o.workDir, '.git'))) {
    await git.run(['init']);
  }
  await git.run(['config', 'core.autocrlf', 'false']);
  await git.run(['config', 'core.longpaths', 'true']);

  const hasCommits = (await git.run(['rev-parse', '--verify', 'HEAD'], { allowFail: true })).code === 0;
  const hasOrigin = (await git.run(['remote', 'get-url', 'origin'], { allowFail: true })).code === 0;
  await git.run(hasOrigin ? ['remote', 'set-url', 'origin', o.remoteUrl] : ['remote', 'add', 'origin', o.remoteUrl]);

  await git.run(['fetch', 'origin']);
  const refs = (
    await git.run(['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin'])
  ).stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const remote = new Set(refs);

  if (!hasCommits) {
    // Świeże repo lokalne: wskaż gałąź i (jeśli istnieje) oprzyj historię na zdalnej, nie ruszając plików.
    await git.run(['symbolic-ref', 'HEAD', `refs/heads/${o.branch}`]);
    const base = remote.has(`origin/${o.branch}`)
      ? `origin/${o.branch}`
      : remote.has('origin/main')
        ? 'origin/main'
        : remote.has('origin/master')
          ? 'origin/master'
          : null;
    if (base) await git.run(['reset', '--mixed', base]);
  } else {
    await git.run(['checkout', '-B', o.branch]);
  }

  const hasEmail = (await git.run(['config', 'user.email'], { allowFail: true })).stdout.trim();
  if (!hasEmail) {
    await git.run(['config', 'user.email', 'vibeeditor@localhost']);
    await git.run(['config', 'user.name', 'VibeEditor']);
  }

  await git.run(['add', '-A']);
  const status = (await git.run(['status', '--porcelain'])).stdout.trim();
  if (status) {
    await git.run(['commit', '-m', 'VibeEditor: synchronizacja folderu roboczego']);
  }
  await git.run(['push', '-u', 'origin', o.branch]);
}
