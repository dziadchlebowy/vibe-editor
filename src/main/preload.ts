import { contextBridge, ipcRenderer } from 'electron';
import type { VeApi } from '../shared/api.ts';
import type { ConsoleLine, RunState } from '../shared/types.ts';

const api: VeApi = {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  pickFolder: (title) => ipcRenderer.invoke('dialog:pickFolder', title),
  inspectWorkDir: (dir) => ipcRenderer.invoke('work:inspect', dir),
  saveSettings: (req) => ipcRenderer.invoke('settings:save', req),

  checkClaude: (p) => ipcRenderer.invoke('claude:check', p),
  openClaudeLogin: (p) => ipcRenderer.invoke('claude:openLogin', p),

  listTasks: () => ipcRenderer.invoke('tasks:list'),
  addTask: (input) => ipcRenderer.invoke('tasks:add', input),
  updateTask: (id, input) => ipcRenderer.invoke('tasks:update', id, input),
  deleteTask: (id) => ipcRenderer.invoke('tasks:delete', id),
  setTaskChecked: (id, checked) => ipcRenderer.invoke('tasks:setChecked', id, checked),

  startRun: (ids) => ipcRenderer.invoke('run:start', ids),
  stopRun: () => ipcRenderer.invoke('run:stop'),
  resumeRun: () => ipcRenderer.invoke('run:resume'),
  getRunState: () => ipcRenderer.invoke('run:state'),

  getConsoleHistory: () => ipcRenderer.invoke('console:history'),

  onConsoleLine: (cb) => {
    ipcRenderer.on('console:line', (_e, line: ConsoleLine) => cb(line));
  },
  onRunState: (cb) => {
    ipcRenderer.on('run:state', (_e, state: RunState) => cb(state));
  },
  onTasksChanged: (cb) => {
    ipcRenderer.on('tasks:changed', () => cb());
  },
  onOpenSettings: (cb) => {
    ipcRenderer.on('ui:openSettings', () => cb());
  },
};

contextBridge.exposeInMainWorld('ve', api);
