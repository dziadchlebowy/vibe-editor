import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron';
import { exec, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type {
  ConsoleLine,
  InspectResult,
  OkResult,
  RunState,
  SaveRequest,
  Settings,
  TaskInput,
} from '../shared/types.ts';
import { ClaudeRunner } from './core/claude.ts';
import type { Emit } from './core/emit.ts';
import { findMapFolders, writeMapInfo } from './core/globalCfg.ts';
import { GitRunner, setupRepo } from './core/git.ts';
import { assetsDir, buildMapIndex, loadMapIndex, toOverview } from './core/mapIndex.ts';
import { buildPrompt, writePromptFile } from './core/promptBuilder.ts';
import { loadSettings, saveSettings, targetBranch, vibeDir } from './core/settings.ts';
import { TaskStore } from './core/tasks.ts';

const MAX_CONSOLE_LINES = 5000;

let win: BrowserWindow | null = null;
let settings: Settings;
let runner: ClaudeRunner;
let saving = false;
let indexing = false;

const consoleBuffer: ConsoleLine[] = [];

const emit: Emit = (source, text) => {
  for (const raw of text.split(/\r?\n|\r/)) {
    if (!raw.trim()) continue;
    const line: ConsoleLine = { ts: Date.now(), source, text: raw };
    consoleBuffer.push(line);
    if (consoleBuffer.length > MAX_CONSOLE_LINES) consoleBuffer.shift();
    win?.webContents.send('console:line', line);
  }
};

const settingsFile = (): string => path.join(app.getPath('userData'), 'settings.json');
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const fail = (error: string): OkResult => ({ ok: false, error });

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function taskStore(): TaskStore | null {
  return settings.workDir ? new TaskStore(path.join(vibeDir(settings.workDir), 'tasks.json')) : null;
}

function currentMap() {
  return findMapFolders(settings.workDir).find((m) => m.folder === settings.mapFolder);
}

// --- indeks mapy -------------------------------------------------------------

/** Wczytuje kafle mapy, zbiera ścieżki assetów i kopiuje je z OMSI do _vibe/assets. */
async function runIndex(): Promise<OkResult> {
  if (indexing) return fail('Indeksowanie mapy już trwa.');
  if (!settings.configured || !settings.workDir || !settings.mapFolder) {
    return fail('Najpierw skonfiguruj folder roboczy.');
  }
  indexing = true;
  win?.webContents.send('map:changed');
  try {
    await buildMapIndex({
      workDir: settings.workDir,
      mapFolder: settings.mapFolder,
      omsiDir: settings.omsiDir,
      emit,
    });
    return { ok: true };
  } catch (e) {
    emit('app', `Błąd indeksowania mapy: ${errMsg(e)}`);
    return fail(errMsg(e));
  } finally {
    indexing = false;
    win?.webContents.send('map:changed');
  }
}

// --- konfiguracja ----------------------------------------------------------

function inspectWorkDir(dir: string): InspectResult {
  if (!isDir(dir)) return { ok: false, error: 'Wybrany folder nie istnieje.', maps: [] };
  const maps = findMapFolders(dir);
  if (maps.length === 0) {
    return {
      ok: false,
      error:
        'W tym folderze nie znaleziono folderu mapy OMSI (brak podfolderu z plikiem global.cfg zaczynającym się od znaczników [name], [friendlyname], [description]).',
      maps: [],
    };
  }
  return {
    ok: true,
    maps: maps.map(({ folder, name, friendlyname, description }) => ({ folder, name, friendlyname, description })),
  };
}

async function saveAll(req: SaveRequest): Promise<OkResult> {
  if (saving) return fail('Trwa zapisywanie ustawień.');
  if (runner.state.status !== 'idle') return fail('Nie można zmieniać ustawień, gdy Claude pracuje. Zatrzymaj prompt.');

  const remoteUrl = req.remoteUrl.trim();
  if (!isDir(req.omsiDir)) return fail('Wskaż istniejący folder z grą OMSI.');
  if (!isDir(req.workDir)) return fail('Wskaż istniejący folder roboczy.');
  const maps = findMapFolders(req.workDir);
  const map = maps.find((m) => m.folder === req.mapFolder) ?? (maps.length === 1 ? maps[0] : undefined);
  if (!map) return fail('W folderze roboczym nie ma wybranej mapy (global.cfg).');
  if (!req.name.trim() || !req.friendlyname.trim()) return fail('Pola „nazwa” i „friendlyname” nie mogą być puste.');
  if (!/^(https?:\/\/|git@|ssh:\/\/)/i.test(remoteUrl)) {
    return fail('Podaj link do repozytorium na GitHubie (np. https://github.com/użytkownik/repo.git).');
  }

  saving = true;
  try {
    if (!['omsi.exe'].some((f) => fs.existsSync(path.join(req.omsiDir, f)))) {
      emit('app', 'Uwaga: w folderze OMSI nie znaleziono Omsi.exe — upewnij się, że to właściwy folder.');
    }
    const changed = writeMapInfo(map.cfgPath, {
      name: req.name,
      friendlyname: req.friendlyname,
      description: req.description,
    });
    if (changed) emit('app', `Zaktualizowano ${path.join(map.folder, 'global.cfg')}.`);

    emit('app', 'Podpinanie folderu roboczego pod repozytorium…');
    await setupRepo(new GitRunner(req.workDir, emit), {
      workDir: req.workDir,
      remoteUrl,
      branch: targetBranch(req),
    });

    const prev = settings;
    const attachedNew =
      prev.workDir !== req.workDir ||
      prev.mapFolder !== map.folder ||
      prev.omsiDir !== req.omsiDir ||
      !loadMapIndex(req.workDir);

    settings = {
      omsiDir: req.omsiDir,
      workDir: req.workDir,
      mapFolder: map.folder,
      remoteUrl,
      workOnMain: req.workOnMain,
      claudePath: req.claudePath.trim(),
      configured: true,
    };
    saveSettings(settingsFile(), settings);
    emit('app', 'Konfiguracja zapisana, zmiany wypchnięte do repozytorium.');
    win?.webContents.send('tasks:changed');
    if (attachedNew) void runIndex();
    return { ok: true };
  } catch (e) {
    emit('app', `Błąd konfiguracji: ${errMsg(e)}`);
    return fail(errMsg(e));
  } finally {
    saving = false;
  }
}

// --- Claude ----------------------------------------------------------------

function claudeCommand(claudePath: string): string {
  return claudePath.trim() || 'claude';
}

function checkClaude(claudePath: string): Promise<OkResult & { version?: string }> {
  return new Promise((resolve) => {
    exec(`"${claudeCommand(claudePath)}" --version`, { windowsHide: true, timeout: 15000 }, (error, stdout) => {
      if (error) {
        resolve({ ok: false, error: 'Nie znaleziono Claude Code (polecenie „claude”). Zainstaluj go lub podaj ścieżkę.' });
      } else {
        resolve({ ok: true, version: stdout.trim() });
      }
    });
  });
}

function openClaudeLogin(claudePath: string): void {
  const cmd = claudeCommand(claudePath);
  if (process.platform === 'win32') {
    // Widoczne okno terminala: tam użytkownik loguje się komendą /login.
    spawn('cmd.exe', ['/c', 'start', '"VibeEditor"', 'cmd', '/k', `"${cmd}"`], {
      windowsVerbatimArguments: true,
      detached: true,
      stdio: 'ignore',
    }).unref();
    emit('app', 'Otwarto terminal Claude. Jeśli nie jesteś zalogowany, wpisz w nim /login.');
  } else {
    emit('app', `Zaloguj się w terminalu poleceniem: ${cmd} (a w nim /login).`);
  }
}

// --- okno i IPC ------------------------------------------------------------

function createWindow(): void {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 820,
    minHeight: 560,
    backgroundColor: '#16181d',
    title: 'VibeEditor',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  void win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('closed', () => {
    win = null;
  });
}

function registerIpc(): void {
  ipcMain.handle('settings:get', () => settings);
  ipcMain.handle('dialog:pickFolder', async (_e, title: string) => {
    const opts = { title, properties: ['openDirectory' as const] };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('work:inspect', (_e, dir: string) => inspectWorkDir(dir));
  ipcMain.handle('settings:save', (_e, req: SaveRequest) => saveAll(req));

  ipcMain.handle('claude:check', (_e, p: string) => checkClaude(p));
  ipcMain.handle('claude:openLogin', (_e, p: string) => openClaudeLogin(p));

  ipcMain.handle('tasks:list', () => taskStore()?.list() ?? []);
  ipcMain.handle('tasks:add', (_e, input: TaskInput): OkResult => {
    const s = taskStore();
    if (!s) return fail('Najpierw skonfiguruj folder roboczy.');
    try {
      s.add(input);
      return { ok: true };
    } catch (e) {
      return fail(errMsg(e));
    }
  });
  ipcMain.handle('tasks:update', (_e, id: string, input: TaskInput): OkResult => {
    try {
      taskStore()?.update(id, input);
      return { ok: true };
    } catch (e) {
      return fail(errMsg(e));
    }
  });
  ipcMain.handle('tasks:delete', (_e, id: string) => taskStore()?.remove(id));
  ipcMain.handle('tasks:setChecked', (_e, id: string, checked: boolean) => taskStore()?.setChecked(id, checked));

  ipcMain.handle('run:start', (_e, ids: string[]): OkResult => {
    const store = taskStore();
    if (!store) return fail('Najpierw skonfiguruj folder roboczy.');
    if (indexing) return fail('Trwa indeksowanie mapy i kopiowanie assetów — poczekaj na zakończenie.');
    const tasks = store.list().filter((t) => t.status === 'active' && ids.includes(t.id));
    if (tasks.length === 0) return fail('Zaznacz co najmniej jedno zadanie.');
    try {
      const map = currentMap();
      const text = buildPrompt(tasks, {
        mapName: map?.name ?? settings.mapFolder,
        mapFolder: settings.mapFolder,
        hasAssets: fs.existsSync(assetsDir(settings.workDir)),
      });
      const file = writePromptFile(vibeDir(settings.workDir), text);
      emit('app', `Zapisano prompt: ${file}`);
      runner.start(text, tasks.map((t) => t.id));
      return { ok: true };
    } catch (e) {
      return fail(errMsg(e));
    }
  });
  ipcMain.handle('run:stop', () => runner.stop());
  ipcMain.handle('run:resume', (): OkResult => {
    try {
      runner.resume();
      return { ok: true };
    } catch (e) {
      return fail(errMsg(e));
    }
  });
  ipcMain.handle('run:state', () => runner.state);

  ipcMain.handle('map:overview', () => {
    const idx = settings.workDir ? loadMapIndex(settings.workDir) : null;
    return idx && idx.mapFolder === settings.mapFolder ? toOverview(idx) : null;
  });
  ipcMain.handle('map:reindex', () => runIndex());
  ipcMain.handle('map:indexing', () => indexing);

  ipcMain.handle('console:history', () => consoleBuffer);
}

function buildMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Plik',
        submenu: [
          { label: 'Ustawienia…', accelerator: 'CmdOrCtrl+,', click: () => win?.webContents.send('ui:openSettings') },
          { type: 'separator' },
          { role: 'quit', label: 'Zakończ' },
        ],
      },
      { label: 'Widok', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }] },
    ]),
  );
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  void app.whenReady().then(() => {
    settings = loadSettings(settingsFile());
    runner = new ClaudeRunner({
      getCwd: () => settings.workDir,
      getClaudePath: () => settings.claudePath,
      emit,
      onSuccess: (ids) => {
        taskStore()?.archive(ids);
        win?.webContents.send('tasks:changed');
      },
    });
    runner.on('state', (s: RunState) => win?.webContents.send('run:state', s));

    registerIpc();
    buildMenu();
    createWindow();
    emit('app', 'VibeEditor uruchomiony.');
  });

  app.on('window-all-closed', () => {
    runner?.stop();
    app.quit();
  });
}
