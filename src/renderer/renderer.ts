import { TASK_TYPES, getTaskType } from '../shared/taskTypes.ts';
import type {
  ConsoleLine,
  MapInfo,
  RunState,
  Settings,
  TaskInput,
  TaskView,
} from '../shared/types.ts';

const ve = window.ve;

// --- pomocnicze DOM --------------------------------------------------------

type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === 'class') {
      el.className = String(v);
    } else if (k in el) {
      (el as unknown as Record<string, unknown>)[k] = v;
    } else {
      el.setAttribute(k, String(v));
    }
  }
  for (const c of children) {
    if (c !== null && c !== undefined && c !== false) el.append(c);
  }
  return el;
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function clear(el: HTMLElement): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
}

function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString('pl-PL', { dateStyle: 'short', timeStyle: 'short' });
}

/** Otwiera modal; zwraca funkcję zamykającą. */
function openModal(content: HTMLElement, closable: boolean): () => void {
  const backdrop = h('div', { class: 'backdrop' }, h('div', { class: 'modal' }, content));
  const close = (): void => backdrop.remove();
  if (closable) {
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) close();
    });
  }
  $('modal-root').append(backdrop);
  return close;
}

// --- stan ------------------------------------------------------------------

type TabId = 'tasks' | 'map' | 'console';
type ConsoleFilter = 'all' | 'git' | 'claude';

let activeTab: TabId = 'tasks';
let taskTab: 'active' | 'archived' = 'active';
let tasks: TaskView[] = [];
let run: RunState = { status: 'idle', taskIds: [] };
let consoleFilter: ConsoleFilter = 'all';
let consoleLines: ConsoleLine[] = [];
let settingsOpen = false;

// --- zakładki --------------------------------------------------------------

const TABS: { id: TabId; label: string }[] = [
  { id: 'tasks', label: 'Zadania' },
  { id: 'map', label: 'Mapa' },
  { id: 'console', label: 'Konsola' },
];

function renderTabs(): void {
  const nav = $('tabs');
  clear(nav);
  for (const t of TABS) {
    nav.append(
      h(
        'button',
        {
          class: `tab${t.id === activeTab ? ' active' : ''}`,
          onClick: () => {
            activeTab = t.id;
            renderTabs();
            if (t.id === 'console') scrollConsoleToEnd();
          },
        },
        t.label,
      ),
    );
  }
  for (const t of TABS) $(`view-${t.id}`).classList.toggle('active', t.id === activeTab);
}

// --- zakładka Zadania ------------------------------------------------------

function runButtonLabel(): string {
  if (run.status === 'running') return 'W toku...';
  if (run.status === 'paused') return `⏸️Wznów od ${formatTime(run.resetAt ?? Date.now())}`;
  return '▶️ Uruchom';
}

function renderTasks(): void {
  const view = $('view-tasks');
  clear(view);

  const menu = h('div', { class: 'menu' });
  menu.hidden = true;
  for (const type of TASK_TYPES) {
    menu.append(
      h(
        'button',
        {
          onClick: () => {
            menu.hidden = true;
            openTaskDialog(type.kind);
          },
        },
        type.label,
      ),
    );
  }
  const addBtn = h(
    'button',
    {
      class: 'btn',
      onClick: (e: Event) => {
        e.stopPropagation();
        menu.hidden = !menu.hidden;
      },
    },
    '+ Dodaj',
  );

  const checkedIds = tasks.filter((t) => t.status === 'active' && t.checked).map((t) => t.id);
  const runBtn = h(
    'button',
    {
      class: 'btn primary',
      disabled: run.status === 'running' || (run.status === 'idle' && checkedIds.length === 0),
      onClick: async () => {
        const res = run.status === 'paused' ? await ve.resumeRun() : await ve.startRun(checkedIds);
        if (!res.ok) alert(res.error ?? 'Nie udało się uruchomić.');
      },
    },
    runButtonLabel(),
  );
  const stopBtn = h(
    'button',
    { class: 'btn', disabled: run.status === 'idle', onClick: () => void ve.stopRun() },
    '⏹️ Zatrzymaj',
  );

  view.append(
    h(
      'div',
      { class: 'toolbar' },
      h('div', { class: 'menu-wrap' }, addBtn, menu),
      runBtn,
      stopBtn,
      h('div', { class: 'spacer' }),
      run.error ? h('span', { class: 'error' }, run.error) : null,
    ),
  );

  const activeCount = tasks.filter((t) => t.status === 'active').length;
  const archivedCount = tasks.length - activeCount;
  view.append(
    h(
      'div',
      { class: 'subtabs' },
      h(
        'button',
        {
          class: `chip${taskTab === 'active' ? ' active' : ''}`,
          onClick: () => {
            taskTab = 'active';
            renderTasks();
          },
        },
        `Aktywne (${activeCount})`,
      ),
      h(
        'button',
        {
          class: `chip${taskTab === 'archived' ? ' active' : ''}`,
          onClick: () => {
            taskTab = 'archived';
            renderTasks();
          },
        },
        `Archiwum (${archivedCount})`,
      ),
    ),
  );

  const list = h('div', { class: 'task-list' });
  const shown = tasks
    .filter((t) => t.status === taskTab)
    .sort((a, b) => (taskTab === 'archived' ? (b.archivedAt ?? 0) - (a.archivedAt ?? 0) : a.createdAt - b.createdAt));

  if (shown.length === 0) {
    list.append(
      h(
        'div',
        { class: 'empty' },
        taskTab === 'active' ? 'Brak zadań. Dodaj pierwsze przyciskiem „+ Dodaj”.' : 'Archiwum jest puste.',
      ),
    );
  }
  for (const t of shown) list.append(renderTask(t));
  view.append(list);
}

function renderTask(t: TaskView): HTMLElement {
  const isActive = t.status === 'active';
  const locked = run.status !== 'idle' && run.taskIds.includes(t.id);
  return h(
    'div',
    { class: `task${t.checked ? ' checked' : ''}` },
    isActive
      ? h('input', {
          type: 'checkbox',
          checked: t.checked,
          disabled: run.status !== 'idle',
          onChange: async (e: Event) => {
            await ve.setTaskChecked(t.id, (e.target as HTMLInputElement).checked);
            await refreshTasks();
          },
        })
      : null,
    h(
      'div',
      { class: 'task-main' },
      h('div', { class: 'task-title' }, t.title),
      h('div', { class: 'task-content' }, t.content),
      h(
        'div',
        { class: 'task-meta' },
        h('span', { class: 'badge' }, getTaskType(t.kind)?.label ?? t.kind),
        h('span', { class: 'badge', title: 'Zakres kafli zostanie dodany razem z zakładką Mapa' }, 'Zakres kafli: wkrótce'),
        t.archivedAt ? h('span', { class: 'badge' }, `Zakończone ${formatDateTime(t.archivedAt)}`) : null,
      ),
    ),
    isActive
      ? h(
          'div',
          { class: 'task-actions' },
          h('button', { class: 'btn small', title: 'Edytuj', disabled: locked, onClick: () => openTaskDialog(t.kind, t) }, '✎'),
          h(
            'button',
            {
              class: 'btn small',
              title: 'Usuń',
              disabled: locked,
              onClick: async () => {
                if (!confirm(`Usunąć zadanie „${t.title}”?`)) return;
                await ve.deleteTask(t.id);
                await refreshTasks();
              },
            },
            '🗑',
          ),
        )
      : null,
  );
}

function openTaskDialog(kind: string, existing?: TaskView): void {
  const def = getTaskType(kind);
  if (!def) return;

  const titleInput = h('input', { type: 'text', value: existing?.title ?? '', placeholder: 'Krótki tytuł zadania' });
  const inputs = new Map<string, HTMLInputElement | HTMLTextAreaElement>();
  const fieldEls: HTMLElement[] = [];
  for (const f of def.fields) {
    const value = existing?.data[f.key] ?? '';
    const el =
      f.type === 'textarea'
        ? h('textarea', { value, placeholder: f.placeholder ?? '' })
        : h('input', { type: 'text', value, placeholder: f.placeholder ?? '' });
    inputs.set(f.key, el);
    fieldEls.push(h('div', { class: 'field' }, h('label', {}, f.label), el));
  }
  const tileInput = h('input', { type: 'text', value: '', placeholder: 'Zakres kafli — wkrótce', disabled: true });
  const error = h('div', { class: 'error' });

  const body = h(
    'div',
    { class: 'dialog' },
    h('h2', {}, `${existing ? 'Edytuj zadanie' : 'Nowe zadanie'} — ${def.label}`),
    h('div', { class: 'field' }, h('label', {}, 'Tytuł'), titleInput),
    ...fieldEls,
    h('div', { class: 'field' }, h('label', {}, 'Zakres kafli (opcjonalnie)'), tileInput),
    error,
  );
  const actions = h('div', { class: 'modal-actions' });
  body.append(actions);
  const close = openModal(body, true);

  actions.append(
    h('button', { class: 'btn', onClick: close }, 'Anuluj'),
    h(
      'button',
      {
        class: 'btn primary',
        onClick: async () => {
          const data: Record<string, string> = {};
          for (const [key, el] of inputs) data[key] = el.value;
          const input: TaskInput = { title: titleInput.value, kind, data, tileRange: null };
          const res = existing ? await ve.updateTask(existing.id, input) : await ve.addTask(input);
          if (!res.ok) {
            error.textContent = res.error ?? 'Nie udało się zapisać zadania.';
            return;
          }
          close();
          await refreshTasks();
        },
      },
      'Zapisz',
    ),
  );
  titleInput.focus();
}

async function refreshTasks(): Promise<void> {
  tasks = await ve.listTasks();
  renderTasks();
}

// --- zakładka Mapa ---------------------------------------------------------

function renderMap(): void {
  const view = $('view-map');
  clear(view);
  view.append(h('div', { class: 'placeholder' }, 'Widok mapy zostanie dodany później.'));
}

// --- zakładka Konsola ------------------------------------------------------

function matchesFilter(l: ConsoleLine): boolean {
  return consoleFilter === 'all' || l.source === consoleFilter;
}

function consoleLineEl(l: ConsoleLine): HTMLElement {
  const ts = new Date(l.ts).toLocaleTimeString('pl-PL');
  return h(
    'div',
    { class: 'console-line' },
    h('span', { class: 'ts' }, `${ts} `),
    h('span', { class: `src-${l.source}` }, `[${l.source}] `),
    l.text,
  );
}

function renderConsole(): void {
  const view = $('view-console');
  clear(view);
  const select = h(
    'select',
    {
      onChange: (e: Event) => {
        consoleFilter = (e.target as HTMLSelectElement).value as ConsoleFilter;
        fillConsole();
      },
    },
    h('option', { value: 'all' }, '[Wszystko]'),
    h('option', { value: 'git' }, '[Tylko Git]'),
    h('option', { value: 'claude' }, '[Tylko Claude]'),
  );
  select.value = consoleFilter;
  select.style.width = 'auto';
  view.append(h('div', { class: 'toolbar' }, select), h('pre', { class: 'console-out', id: 'console-out' }));
  fillConsole();
}

function fillConsole(): void {
  const out = document.getElementById('console-out');
  if (!out) return;
  clear(out);
  for (const l of consoleLines) if (matchesFilter(l)) out.append(consoleLineEl(l));
  out.scrollTop = out.scrollHeight;
}

function appendConsole(l: ConsoleLine): void {
  consoleLines.push(l);
  if (consoleLines.length > 5000) consoleLines.shift();
  const out = document.getElementById('console-out');
  if (!out || !matchesFilter(l)) return;
  const atEnd = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
  out.append(consoleLineEl(l));
  while (out.childElementCount > 5000) out.firstElementChild?.remove();
  if (atEnd) out.scrollTop = out.scrollHeight;
}

function scrollConsoleToEnd(): void {
  const out = document.getElementById('console-out');
  if (out) out.scrollTop = out.scrollHeight;
}

// --- okno konfiguracyjne ---------------------------------------------------

async function openSettings(forced: boolean): Promise<void> {
  if (settingsOpen) return;
  settingsOpen = true;
  const cur: Settings = await ve.getSettings();

  let omsiDir = cur.omsiDir;
  let workDir = cur.workDir;
  let maps: MapInfo[] = [];

  const omsiInput = h('input', { type: 'text', readOnly: true, value: omsiDir, placeholder: 'Folder z grą OMSI' });
  const workInput = h('input', { type: 'text', readOnly: true, value: workDir, placeholder: 'Folder roboczy' });
  const workError = h('div', { class: 'error' });
  const mapSelect = h('select', {});
  const mapField = h('div', { class: 'field' }, h('label', {}, 'Mapa w folderze roboczym'), mapSelect);
  mapField.hidden = true;
  const nameInput = h('input', { type: 'text', value: '' });
  const friendlyInput = h('input', { type: 'text', value: '' });
  const descInput = h('textarea', { value: '' });
  descInput.rows = 6;
  const remoteInput = h('input', {
    type: 'text',
    value: cur.remoteUrl,
    placeholder: 'https://github.com/użytkownik/repozytorium.git',
  });
  const mainCheck = h('input', { type: 'checkbox', checked: cur.workOnMain });
  const claudeInput = h('input', { type: 'text', value: cur.claudePath, placeholder: 'claude (z PATH)' });
  const claudeStatus = h('div', { class: 'status' });
  const error = h('div', { class: 'error' });

  const fillMapFields = (): void => {
    const m = maps.find((x) => x.folder === mapSelect.value);
    nameInput.value = m?.name ?? '';
    friendlyInput.value = m?.friendlyname ?? '';
    descInput.value = m?.description ?? '';
  };
  mapSelect.addEventListener('change', fillMapFields);

  const applyMaps = (found: MapInfo[], preferred: string): void => {
    maps = found;
    clear(mapSelect);
    for (const m of maps) mapSelect.append(h('option', { value: m.folder }, m.folder));
    mapSelect.value = maps.some((m) => m.folder === preferred) ? preferred : (maps[0]?.folder ?? '');
    mapField.hidden = maps.length <= 1;
    fillMapFields();
  };

  const loadWorkDir = async (dir: string, preferred: string): Promise<boolean> => {
    const res = await ve.inspectWorkDir(dir);
    if (!res.ok) {
      workError.textContent = res.error ?? 'Nie można użyć tego folderu.';
      return false;
    }
    workError.textContent = '';
    workDir = dir;
    workInput.value = dir;
    applyMaps(res.maps, preferred);
    return true;
  };

  if (cur.workDir) await loadWorkDir(cur.workDir, cur.mapFolder);

  const claudeBtns = h(
    'div',
    { class: 'row' },
    h(
      'button',
      {
        class: 'btn',
        onClick: async () => {
          claudeStatus.className = 'status';
          claudeStatus.textContent = 'Sprawdzanie…';
          const r = await ve.checkClaude(claudeInput.value);
          claudeStatus.className = `status${r.ok ? ' ok' : ''}`;
          claudeStatus.textContent = r.ok ? `Claude Code znaleziony: ${r.version ?? ''}` : (r.error ?? 'Błąd.');
        },
      },
      'Sprawdź Claude',
    ),
    h('button', { class: 'btn', onClick: () => void ve.openClaudeLogin(claudeInput.value) }, 'Zaloguj w Claude…'),
  );

  const okBtn = h('button', { class: 'btn primary' }, 'Zatwierdź');
  const cancelBtn = h('button', { class: 'btn' }, 'Anuluj');

  const body = h(
    'div',
    { class: 'dialog' },
    h('h2', {}, forced ? 'Konfiguracja VibeEditor' : 'Ustawienia'),
    h(
      'div',
      { class: 'field' },
      h('label', {}, 'Folder z grą OMSI (na potrzeby assetów)'),
      h(
        'div',
        { class: 'row' },
        omsiInput,
        h(
          'button',
          {
            class: 'btn',
            onClick: async () => {
              const p = await ve.pickFolder('Wskaż folder z grą OMSI');
              if (p) {
                omsiDir = p;
                omsiInput.value = p;
              }
            },
          },
          'Przeglądaj',
        ),
      ),
    ),
    h(
      'div',
      { class: 'field' },
      h('label', {}, 'Folder roboczy (zawiera folder mapy)'),
      h(
        'div',
        { class: 'row' },
        workInput,
        h(
          'button',
          {
            class: 'btn',
            onClick: async () => {
              const p = await ve.pickFolder('Wskaż folder roboczy');
              if (p) await loadWorkDir(p, mapSelect.value);
            },
          },
          'Przeglądaj',
        ),
      ),
      workError,
    ),
    h('hr', { class: 'sep' }),
    mapField,
    h('div', { class: 'field' }, h('label', {}, 'Nazwa (global.cfg → [name])'), nameInput),
    h('div', { class: 'field' }, h('label', {}, 'Friendlyname (global.cfg → [friendlyname])'), friendlyInput),
    h('div', { class: 'field' }, h('label', {}, 'Opis (global.cfg → [description])'), descInput),
    h('hr', { class: 'sep' }),
    h('div', { class: 'field' }, h('label', {}, 'Link do repozytorium na GitHubie'), remoteInput),
    h('label', { class: 'check' }, mainCheck, 'Pracuj na main (zamiast gałęzi „VibeEditor”)'),
    h('hr', { class: 'sep' }),
    h(
      'div',
      { class: 'field' },
      h('label', {}, 'Claude Code — ścieżka (opcjonalnie)'),
      claudeInput,
      claudeBtns,
      claudeStatus,
      h(
        'div',
        { class: 'hint' },
        'Aplikacja uruchamia Claude Code w folderze roboczym. Zaloguj się raz przyciskiem powyżej (polecenie /login).',
      ),
    ),
    error,
  );
  const actions = h('div', { class: 'modal-actions' }, ...(forced ? [] : [cancelBtn]), okBtn);
  body.append(actions);

  const close = openModal(body, !forced);
  const finish = (): void => {
    settingsOpen = false;
    close();
  };
  cancelBtn.addEventListener('click', finish);

  okBtn.addEventListener('click', async () => {
    error.textContent = '';
    if (!workDir) {
      error.textContent = 'Wskaż folder roboczy zawierający folder mapy.';
      return;
    }
    okBtn.disabled = true;
    cancelBtn.disabled = true;
    okBtn.textContent = 'Łączenie z repozytorium…';
    const res = await ve.saveSettings({
      omsiDir,
      workDir,
      mapFolder: mapSelect.value,
      name: nameInput.value,
      friendlyname: friendlyInput.value,
      description: descInput.value,
      remoteUrl: remoteInput.value,
      workOnMain: mainCheck.checked,
      claudePath: claudeInput.value,
    });
    okBtn.disabled = false;
    cancelBtn.disabled = false;
    okBtn.textContent = 'Zatwierdź';
    if (!res.ok) {
      error.textContent = res.error ?? 'Nie udało się zapisać ustawień.';
      return;
    }
    finish();
    await refreshTasks();
  });
}

// --- start -----------------------------------------------------------------

async function init(): Promise<void> {
  renderTabs();
  renderMap();
  renderConsole();

  document.addEventListener('click', () => {
    document.querySelectorAll<HTMLElement>('.menu').forEach((m) => (m.hidden = true));
  });
  $('settings-btn').addEventListener('click', () => void openSettings(false));

  ve.onConsoleLine(appendConsole);
  ve.onRunState((s) => {
    run = s;
    renderTasks();
  });
  ve.onTasksChanged(() => void refreshTasks());
  ve.onOpenSettings(() => void openSettings(false));

  consoleLines = await ve.getConsoleHistory();
  fillConsole();
  run = await ve.getRunState();
  await refreshTasks();

  const settings = await ve.getSettings();
  if (!settings.configured) await openSettings(true);
}

void init();
