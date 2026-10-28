import { spawn } from 'node:child_process';
import type { Emit } from './emit.ts';

const CHAT_LINK = /claude\.ai\/chat\/([A-Za-z0-9-]{8,64})/i;
const BARE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Czas na otwarcie/zogniskowanie okna czatu, zanim naciśniemy Ctrl+V. */
export const PASTE_DELAY_MS = 1500;
/** Przerwa między wklejeniem a automatycznym Enterem (długi prompt musi się wstawić). */
export const ENTER_DELAY_MS = 1000;

/**
 * Z linku czatu (https://claude.ai/chat/ID, claude://claude.ai/chat/ID albo samego ID)
 * robi adres protokołu aplikacji: claude://claude.ai/chat/ID. Null, gdy nie rozpoznano.
 * ID jest ściśle walidowane, bo trafia do skryptu PowerShell.
 */
export function parseChatLink(input: string): string | null {
  const t = input.trim();
  const m = CHAT_LINK.exec(t);
  if (m) return `claude://claude.ai/chat/${m[1]}`;
  return BARE_ID.test(t) ? `claude://claude.ai/chat/${t}` : null;
}

/** Skrypt PowerShell: odpal czat w aplikacji Claude, poczekaj, wklej (Ctrl+V), opcjonalnie Enter. */
export function buildPasteScript(url: string, o: { autoEnter: boolean; delayMs?: number }): string {
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    `Start-Process '${url}'`,
    `Start-Sleep -Milliseconds ${o.delayMs ?? PASTE_DELAY_MS}`,
    'Add-Type -AssemblyName System.Windows.Forms',
    "[System.Windows.Forms.SendKeys]::SendWait('^v')",
  ];
  if (o.autoEnter) {
    lines.push(`Start-Sleep -Milliseconds ${ENTER_DELAY_MS}`, "[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')");
  }
  return lines.join('\n');
}

/** Argumenty powershell.exe: skrypt jako -EncodedCommand (UTF-16LE base64), więc bez problemów z cudzysłowami. */
export function powershellArgs(script: string): string[] {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-WindowStyle',
    'Hidden',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ];
}

export type ScriptRunner = (script: string, signal: AbortSignal) => Promise<void>;

/** Uruchamia skrypt w ukrytym PowerShellu; sygnał przerywa cały proces. */
export const runPowerShell: ScriptRunner = (script, signal) =>
  new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', powershellArgs(script), {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (d: string) => (stderr += d));
    const onAbort = (): void => {
      if (child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', reject);
    child.on('close', (code) => {
      signal.removeEventListener('abort', onAbort);
      if (code === 0) resolve();
      else reject(new Error(`PowerShell zakończył się błędem (${code}): ${stderr.trim().split(/\r?\n/).slice(-2).join(' ')}`));
    });
  });

export interface FreeSendOptions {
  url: string;
  autoEnter: boolean;
  emit: Emit;
  signal: AbortSignal;
  run?: ScriptRunner;
  platform?: string;
  delayMs?: number;
}

/**
 * Tryb „Claude Free”: zakłada, że prompt jest już w schowku. Odpala czat w aplikacji Claude,
 * po chwili wciska Ctrl+V (i opcjonalnie Enter).
 */
export async function sendToClaudeFree(o: FreeSendOptions): Promise<void> {
  if ((o.platform ?? process.platform) !== 'win32') {
    throw new Error('Tryb Claude Free działa tylko w Windows (wymaga aplikacji Claude i PowerShell).');
  }
  o.emit('claude', `Otwieram czat: ${o.url}`);
  const script = buildPasteScript(o.url, { autoEnter: o.autoEnter, delayMs: o.delayMs });
  await (o.run ?? runPowerShell)(script, o.signal);
  o.emit('claude', o.autoEnter ? 'Prompt wklejony i zatwierdzony (Enter).' : 'Prompt wklejony — zatwierdź go Enterem w oknie Claude.');
}
