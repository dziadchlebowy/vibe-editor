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
 * Kopie assetów z OMSI (_vibe/assets) są lokalnym cache'em dla Claude — nie wchodzą do repo
 * (rozmiar, cudze prawa autorskie). Wyłączenie jest lokalne (.git/info/exclude), nie pushowane.
 */
function excludeAssets(workDir: string): void {
  const file = path.join(workDir, '.git', 'info', 'exclude');
  const rule = '_vibe/assets/';
  let current = '';
  try {
    current = fs.readFileSync(file, 'utf-8');
  } catch {
    /* brak pliku */
  }
  if (current.split(/\r?\n/).includes(rule)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, current + (current && !current.endsWith('\n') ? '\n' : '') + rule + '\n');
}

/**
 * Podpina folder roboczy pod repo, przełącza na właściwą gałąź i pushuje całość.
 * Procedura jest idempotentna — można ją uruchamiać ponownie po zmianie ustawień.
 */
export async function setupRepo(git: GitRunner, o: SetupOptions): Promise<void> {
  fs.mkdirSync(path.join(o.workDir, '_vibe', 'inspirations'), { recursive: true });

  if (!fs.existsSync(path.join(o.workDir, '.git'))) {
    await git.run(['init']);
  }
  excludeAssets(o.workDir);
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

export interface SyncOptions {
  branch: string;
  remoteUrl?: string;
  message?: string;
}

/**
 * Upewnia się, że folder roboczy jest w aktualnej wersji wypchnięty do repo: commit zmian (jeśli są),
 * push na gałąź z ustawień i weryfikacja, że zdalna gałąź wskazuje dokładnie na lokalny HEAD.
 * Nie nadpisuje historii — przy rozjechaniu się gałęzi zgłasza błąd.
 */
export async function syncToRemote(git: GitRunner, o: SyncOptions): Promise<{ commit: string; committed: boolean }> {
  if (o.remoteUrl) await git.run(['remote', 'set-url', 'origin', o.remoteUrl], { allowFail: true });

  const current = (await git.run(['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true })).stdout.trim();
  const hasCommits = (await git.run(['rev-parse', '--verify', 'HEAD'], { allowFail: true })).code === 0;
  if (!hasCommits || current !== o.branch) {
    await git.run(hasCommits ? ['checkout', '-B', o.branch] : ['symbolic-ref', 'HEAD', `refs/heads/${o.branch}`]);
  }

  await git.run(['add', '-A']);
  const dirty = (await git.run(['status', '--porcelain'])).stdout.trim() !== '';
  if (dirty) {
    const hasEmail = (await git.run(['config', 'user.email'], { allowFail: true })).stdout.trim();
    if (!hasEmail) {
      await git.run(['config', 'user.email', 'vibeeditor@localhost']);
      await git.run(['config', 'user.name', 'VibeEditor']);
    }
    await git.run(['commit', '-m', o.message ?? 'VibeEditor: synchronizacja przed uruchomieniem zadań']);
  }

  await git.run(['push', '-u', 'origin', o.branch]);

  const local = (await git.run(['rev-parse', 'HEAD'])).stdout.trim();
  const remoteLine = (await git.run(['ls-remote', 'origin', `refs/heads/${o.branch}`])).stdout.trim();
  const remote = remoteLine.split(/\s+/)[0] ?? '';
  if (remote !== local) {
    throw new Error(
      `Zdalna gałąź „${o.branch}” nie wskazuje na lokalną wersję folderu roboczego ` +
        `(lokalnie ${local.slice(0, 7)}, w repo ${remote ? remote.slice(0, 7) : 'brak'}).`,
    );
  }
  return { commit: local, committed: dirty };
}
