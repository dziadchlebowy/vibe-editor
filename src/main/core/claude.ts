import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { RunState } from '../../shared/types.ts';
import type { Emit } from './emit.ts';
import { FALLBACK_RESET_MS, detectRateLimit } from './rateLimit.ts';

export interface RunnerOptions {
  getCwd: () => string;
  getClaudePath: () => string;
  emit: Emit;
  /** Wywoływane po poprawnie zakończonym prompcie — tu zadania trafiają do archiwum. */
  onSuccess: (taskIds: string[]) => void;
}

const RESUME_PROMPT = 'Kontynuuj pracę nad zadaniami z poprzedniego promptu od miejsca, w którym przerwano.';

const truncate = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s);

type Json = Record<string, unknown>;

/** Zamienia jedno zdarzenie stream-json z Claude Code na zwykły tekst do konsoli (albo null). */
export function formatEvent(obj: Json): string | null {
  switch (obj.type) {
    case 'system':
      return obj.subtype === 'init' ? `Sesja Claude: ${String(obj.session_id ?? '?')}` : null;
    case 'assistant': {
      const message = obj.message as { content?: Json[] } | undefined;
      const lines: string[] = [];
      for (const c of message?.content ?? []) {
        if (c.type === 'text' && typeof c.text === 'string') lines.push(c.text);
        else if (c.type === 'tool_use') {
          lines.push(`▸ ${String(c.name)} ${truncate(JSON.stringify(c.input ?? {}), 200)}`);
        }
      }
      return lines.length ? lines.join('\n') : null;
    }
    case 'result':
      return `${obj.is_error ? '✖' : '✔'} ${String(obj.result ?? '')}`.trimEnd();
    default:
      return null;
  }
}

export class ClaudeRunner extends EventEmitter {
  state: RunState = { status: 'idle', taskIds: [] };

  private opts: RunnerOptions;
  private child: ChildProcess | null = null;
  private sessionId: string | null = null;
  private promptText = '';
  private stopping = false;

  private resultText = '';
  private resultIsError = false;
  private stderrText = '';
  private eventResetAt: Date | null = null;

  constructor(opts: RunnerOptions) {
    super();
    this.opts = opts;
  }

  start(promptText: string, taskIds: string[]): void {
    if (this.state.status !== 'idle') throw new Error('Prompt jest już w toku.');
    this.promptText = promptText;
    this.sessionId = null;
    this.setState({ status: 'running', taskIds });
    this.launch(promptText, null);
  }

  resume(): void {
    if (this.state.status !== 'paused') throw new Error('Nie ma czego wznawiać.');
    const ids = this.state.taskIds;
    this.setState({ status: 'running', taskIds: ids });
    if (this.sessionId) this.launch(RESUME_PROMPT, this.sessionId);
    else this.launch(this.promptText, null);
  }

  stop(): void {
    if (this.state.status === 'idle') return;
    if (!this.child) {
      // pauza (limit) — nic nie działa, po prostu rezygnujemy
      this.setState({ status: 'idle', taskIds: [] });
      this.opts.emit('claude', 'Zatrzymano.');
      return;
    }
    this.stopping = true;
    const pid = this.child.pid;
    if (process.platform === 'win32' && pid) {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    } else {
      this.child.kill('SIGTERM');
    }
  }

  private setState(s: RunState): void {
    this.state = s;
    this.emit('state', s);
  }

  private launch(input: string, resumeId: string | null): void {
    this.resultText = '';
    this.resultIsError = false;
    this.stderrText = '';
    this.eventResetAt = null;
    this.stopping = false;

    const claude = this.opts.getClaudePath().trim() || 'claude';
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits'];
    if (resumeId) args.push('--resume', resumeId);

    this.opts.emit('claude', `$ claude ${args.join(' ')}`);

    const common = { cwd: this.opts.getCwd(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'] };
    // Na Windows claude to zwykle claude.cmd (npm) — potrzebna powłoka. Argumenty są stałe, więc bezpiecznie.
    const child =
      process.platform === 'win32'
        ? spawn(`"${claude}" ${args.join(' ')}`, { ...common, shell: true })
        : spawn(claude, args, common);
    this.child = child;

    let finished = false;
    let buffer = '';

    child.stdin.on('error', () => {});
    child.stdin.write(input);
    child.stdin.end();

    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (d: string) => {
      buffer += d;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        this.handleLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    });

    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (d: string) => {
      this.stderrText = (this.stderrText + d).slice(-20000);
      this.opts.emit('claude', d);
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (finished) return;
      finished = true;
      this.child = null;
      const msg =
        err.code === 'ENOENT'
          ? 'Nie znaleziono polecenia claude. Zainstaluj Claude Code lub podaj ścieżkę w ustawieniach.'
          : err.message;
      this.opts.emit('claude', msg);
      this.setState({ status: 'idle', taskIds: [], error: msg });
    });

    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      if (buffer.trim()) this.handleLine(buffer);
      this.child = null;
      this.finish(code ?? -1);
    });
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let obj: Json;
    try {
      obj = JSON.parse(line) as Json;
    } catch {
      this.opts.emit('claude', line);
      return;
    }
    if (typeof obj.session_id === 'string') this.sessionId = obj.session_id;
    if (obj.type === 'result') {
      this.resultText = String(obj.result ?? '');
      this.resultIsError = obj.is_error === true;
    }
    if (obj.type === 'rate_limit_event') {
      const info = obj.rate_limit_info as { resetsAt?: number } | undefined;
      if (typeof info?.resetsAt === 'number') {
        this.eventResetAt = new Date(info.resetsAt < 1e12 ? info.resetsAt * 1000 : info.resetsAt);
      }
    }
    const text = formatEvent(obj);
    if (text) this.opts.emit('claude', text);
  }

  private finish(code: number): void {
    const ids = this.state.taskIds;

    if (this.stopping) {
      this.stopping = false;
      this.opts.emit('claude', 'Zatrzymano.');
      this.setState({ status: 'idle', taskIds: [] });
      return;
    }

    if (code !== 0 || this.resultIsError) {
      const info = detectRateLimit(`${this.resultText}\n${this.stderrText}`);
      if (info.limited || this.eventResetAt) {
        const resetAt = info.resetAt ?? this.eventResetAt ?? new Date(Date.now() + FALLBACK_RESET_MS);
        this.opts.emit('claude', `Limit Claude wyczerpany — odnowienie ok. ${resetAt.toLocaleString('pl-PL')}.`);
        this.setState({ status: 'paused', taskIds: ids, resetAt: resetAt.getTime() });
        return;
      }
      const msg = `Claude zakończył pracę błędem (kod ${code}).`;
      this.opts.emit('claude', msg);
      this.setState({ status: 'idle', taskIds: [], error: msg });
      return;
    }

    this.opts.onSuccess(ids);
    this.setState({ status: 'idle', taskIds: [] });
  }
}
