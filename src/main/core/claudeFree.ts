import { spawn } from 'node:child_process';
import type { Emit } from './emit.ts';

/** Czas (ms) na załadowanie czatu w aplikacji Claude po pojawieniu się jej okna, zanim wkleimy prompt. */
export const CHAT_LOAD_DELAY_MS = 3000;
/** Ile sekund czekamy, aż pojawi się okno aplikacji Claude po uruchomieniu linku. */
export const WINDOW_WAIT_SECONDS = 25;

const CHAT_LINK =
  /^(?:(?:https?|claude):\/\/)?(?:www\.)?claude\.ai\/chat\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#].*)?$/i;

/**
 * Z linku do czatu (https://claude.ai/chat/ID albo claude://claude.ai/chat/ID) robi link
 * otwierający czat w aplikacji desktopowej: claude://claude.ai/chat/ID. Null, gdy to nie link czatu.
 */
export function parseChatUrl(input: string): string | null {
  const m = CHAT_LINK.exec(input.trim());
  return m ? `claude://claude.ai/chat/${m[1].toLowerCase()}` : null;
}

export interface PasteScriptOptions {
  /** Czy po wklejeniu nacisnąć Enter (wysłać wiadomość). */
  autoSend: boolean;
  loadDelayMs?: number;
  waitSeconds?: number;
}

/** Kody wyjścia skryptu — mapowane na komunikaty w {@link describeExit}. */
export const EXIT_NO_WINDOW = 2;
export const EXIT_NO_FOCUS = 3;

/**
 * Skrypt PowerShella: otwiera czat linkiem claude://, czeka na okno aplikacji, przełącza na nie
 * i wkleja ze schowka (Ctrl+V), opcjonalnie wysyłając Enterem. Prompt musi już leżeć w schowku.
 * Link jest weryfikowany przez {@link parseChatUrl}, więc bezpiecznie wchodzi w apostrofy.
 */
export function buildPasteScript(deepLink: string, opts: PasteScriptOptions): string {
  if (!/^claude:\/\/claude\.ai\/chat\/[0-9a-f-]{36}$/.test(deepLink)) throw new Error('Niepoprawny link czatu.');
  const delay = opts.loadDelayMs ?? CHAT_LOAD_DELAY_MS;
  const wait = opts.waitSeconds ?? WINDOW_WAIT_SECONDS;
  return [
    "$ErrorActionPreference = 'Stop'",
    `Start-Process '${deepLink}'`,
    `$deadline = (Get-Date).AddSeconds(${wait})`,
    '$proc = $null',
    'while ((Get-Date) -lt $deadline) {',
    "  $proc = Get-Process -Name 'claude' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1",
    '  if ($proc) { break }',
    '  Start-Sleep -Milliseconds 500',
    '}',
    `if (-not $proc) { Write-Output 'Nie znaleziono okna aplikacji Claude.'; exit ${EXIT_NO_WINDOW} }`,
    `Start-Sleep -Milliseconds ${delay}`,
    '$ws = New-Object -ComObject WScript.Shell',
    'if (-not $ws.AppActivate($proc.Id)) {',
    '  Start-Sleep -Milliseconds 800',
    `  if (-not $ws.AppActivate($proc.Id)) { Write-Output 'Nie udało się przełączyć na okno Claude.'; exit ${EXIT_NO_FOCUS} }`,
    '}',
    'Start-Sleep -Milliseconds 600',
    "$ws.SendKeys('^v')",
    ...(opts.autoSend ? ['Start-Sleep -Milliseconds 800', "$ws.SendKeys('{ENTER}')"] : []),
    "Write-Output 'Prompt wklejony do czatu.'",
  ].join('\r\n');
}

/** PowerShell -EncodedCommand przyjmuje Base64 z UTF-16LE — nie trzeba nic cytować. */
export function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

export function describeExit(code: number): string {
  if (code === EXIT_NO_WINDOW) {
    return 'Nie znaleziono okna aplikacji Claude (czy aplikacja jest zainstalowana i obsługuje linki claude://?). Prompt jest w schowku — wklej go ręcznie (Ctrl+V).';
  }
  if (code === EXIT_NO_FOCUS) {
    return 'Nie udało się przełączyć na okno Claude. Prompt jest w schowku — wklej go ręcznie (Ctrl+V).';
  }
  return `Skrypt PowerShella zakończył się błędem (kod ${code}). Prompt jest w schowku — wklej go ręcznie (Ctrl+V).`;
}

export interface SendOptions {
  /** Link czatu z ustawień (https://claude.ai/chat/ID lub claude://…). */
  chatUrl: string;
  prompt: string;
  autoSend: boolean;
  /** Zapis do schowka (Electron: clipboard.writeText) — wstrzykiwany, żeby rdzeń nie zależał od Electrona. */
  writeClipboard: (text: string) => void;
  /** Otwarcie linku poza Windows (Electron: shell.openExternal). */
  openLink: (url: string) => Promise<void>;
  emit: Emit;
  signal?: AbortSignal;
}

/** Kopiuje prompt do schowka, otwiera czat w aplikacji Claude i (na Windows) wkleja prompt. */
export async function sendPromptToClaudeApp(o: SendOptions): Promise<void> {
  const link = parseChatUrl(o.chatUrl);
  if (!link) throw new Error('Niepoprawny link czatu. Oczekiwany format: https://claude.ai/chat/<ID czatu>.');

  o.writeClipboard(o.prompt);
  o.emit('claude', `Prompt skopiowany do schowka (${o.prompt.length} znaków).`);
  o.emit('claude', `Otwieram czat: ${link}`);

  if (process.platform !== 'win32') {
    await o.openLink(link);
    o.emit('claude', 'Automatyczne wklejanie działa tylko na Windows — wklej prompt ręcznie (Ctrl+V).');
    return;
  }

  const script = buildPasteScript(link, { autoSend: o.autoSend });
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShell(script)],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal: o.signal },
    );
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (d: string) => o.emit('claude', d));
    child.stderr.on('data', (d: string) => o.emit('claude', d));
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.name === 'AbortError') reject(new Error('Zatrzymano.'));
      else reject(new Error(err.code === 'ENOENT' ? 'Nie znaleziono powershell.exe.' : err.message));
    });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(describeExit(code ?? -1)));
    });
  });
}
