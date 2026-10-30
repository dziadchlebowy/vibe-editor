import fs from 'node:fs';
import path from 'node:path';
import type { Settings } from '../../shared/types.ts';

export const DEFAULT_SETTINGS: Settings = {
  omsiDir: '',
  workDir: '',
  mapFolder: '',
  remoteUrl: '',
  workOnMain: false,
  claudeMode: 'code',
  claudePath: '',
  claudeChatUrl: '',
  claudeAutoSend: true,
  splineMaxWidth: 0,
  configured: false,
};

export function loadSettings(file: string): Settings {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<Settings>;
    return { ...DEFAULT_SETTINGS, ...raw };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(file: string, settings: Settings): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2), 'utf-8');
}

export const BRANCH_NAME = 'VibeEditor';

export function targetBranch(s: Pick<Settings, 'workOnMain'>): string {
  return s.workOnMain ? 'main' : BRANCH_NAME;
}

export function vibeDir(workDir: string): string {
  return path.join(workDir, '_vibe');
}
