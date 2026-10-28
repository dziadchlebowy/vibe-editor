import { pinToTile } from '../shared/taskExtras.ts';
import { TASK_TYPES, getTaskType } from '../shared/taskTypes.ts';
import type {
  ConsoleLine,
  MapCatalog,
  MapInfo,
  MapOverview,
  RunState,
  Settings,
  TaskAttachment,
  TaskInput,
  TaskPin,
  TaskView,
  TileCoord,
} from '../shared/types.ts';

import { ObjectsView, RoadsView } from './assetViews.ts';
import { $, clear, h } from './dom.ts';
import { MapGrid, type GridPin } from './mapView.ts';

const ve = window.ve;

// --- pomocnicze DOM --------------------------------------------------------

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
}

function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString('pl-PL', { dateStyle: 'short', timeStyle: 'short' });
}

/** Otwiera modal; zwraca funkcję zamykającą. */
function openModal(content: HTMLElement, closable: boolean, wide = false): () => void {
  const backdrop = h('div', { class: 'backdrop' }, h('div', { class: `modal${wide ? ' wide' : ''}` }, content));
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

type TabId = 'tasks' | 'map' | 'roads' | 'objects' | 'console';
type TaskTab = 'active' | 'rejected' | 'archived';
type ConsoleFilter = 'all' | 'git' | 'claude';

let activeTab: TabId = 'tasks';
let taskTab: TaskTab = 'active';
let tasks: TaskView[] = [];
let run: RunState = { status: 'idle', taskIds: [] };
let consoleFilter: ConsoleFilter = 'all';
let consoleLines: ConsoleLine[] = [];
let settingsOpen = false;

let overview: MapOverview | null = null;
let catalog: MapCatalog = { roads: [], objects: [] };
let mapBusy = false;
let pinMode = false;

let mapGrid: MapGrid;
let roadsView: RoadsView;
let objectsView: ObjectsView;
let mapSummary: HTMLElement;
let pinBtn: HTMLButtonElement;
let rescanBtn: HTMLButtonElement;

// --- zakładki --------------------------------------------------------------

const TABS: { id: TabId; label: string }[] = [
  { id: 'tasks', label: 'Zadania' },
  { id: 'map', label: 'Mapa' },
  { id: 'roads', label: 'Jezdnie' },
  { id: 'objects', label: 'Obiekty' },
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
            if (t.id === 'map') mapGrid?.show();
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

  const count = (s: TaskTab): number => tasks.filter((t) => t.status === s).length;
  const chip = (id: TaskTab, label: string): HTMLElement =>
    h(
      'button',
      {
        class: `chip${taskTab === id ? ' active' : ''}${id === 'rejected' && count('rejected') > 0 ? ' alert' : ''}`,
        onClick: () => {
          taskTab = id;
          renderTasks();
        },
      },
      `${label} (${count(id)})`,
    );
  view.append(h('div', { class: 'subtabs' }, chip('active', 'Aktywne'), chip('rejected', 'Odrzucone'), chip('archived', 'Archiwum')));

  const list = h('div', { class: 'task-list' });
  const shown = tasks
    .filter((t) => t.status === taskTab)
    .sort((a, b) =>
      taskTab === 'archived'
        ? (b.archivedAt ?? 0) - (a.archivedAt ?? 0)
        : taskTab === 'rejected'
          ? (b.rejectedAt ?? 0) - (a.rejectedAt ?? 0)
          : a.createdAt - b.createdAt,
    );

  if (shown.length === 0) {
    const msg: Record<TaskTab, string> = {
      active: 'Brak zadań. Dodaj pierwsze przyciskiem „+ Dodaj”.',
      rejected: 'Brak odrzuconych zadań.',
      archived: 'Archiwum jest puste.',
    };
    list.append(h('div', { class: 'empty' }, msg[taskTab]));
  }
  for (const t of shown) list.append(renderTask(t));
  view.append(list);
}

function describeAttachment(a: TaskAttachment): string {
  return a.kind === 'road' ? `🛣️ ${a.path}` : `🏠 ${a.name ?? a.path}`;
}

function renderTask(t: TaskView): HTMLElement {
  const isActive = t.status === 'active';
  const isRejected = t.status === 'rejected';
  const locked = run.status !== 'idle' && run.taskIds.includes(t.id);
  const pinTile = t.pin ? pinToTile(t.pin) : null;
  return h(
    'div',
    { class: `task${t.checked ? ' checked' : ''}${isRejected ? ' rejected' : ''}` },
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
      isRejected
        ? h(
            'div',
            { class: 'task-reject' },
            h('strong', {}, 'Odrzucone przez Claude: '),
            t.rejectedComment ?? '',
            t.rejectedAt ? h('span', { class: 'ts' }, ` (${formatDateTime(t.rejectedAt)})`) : null,
          )
        : null,
      h(
        'div',
        { class: 'task-meta' },
        h('span', { class: 'badge' }, getTaskType(t.kind)?.label ?? t.kind),
        t.tileRange
          ? h('span', { class: 'badge', title: t.tileRange.map((c) => `(${c.x}, ${c.y})`).join(' ') }, `Kafle: ${t.tileRange.length}`)
          : null,
        pinTile ? h('span', { class: 'badge', title: 'Pinezka na mapie' }, `📍 kafel (${pinTile.x}, ${pinTile.y})`) : null,
        t.attachment ? h('span', { class: 'badge', title: t.attachment.path }, describeAttachment(t.attachment)) : null,
        t.archivedAt && t.status === 'archived' ? h('span', { class: 'badge' }, `Zakończone ${formatDateTime(t.archivedAt)}`) : null,
      ),
    ),
    isRejected
      ? h(
          'div',
          { class: 'task-actions' },
          h(
            'button',
            {
              class: 'btn small',
              title: 'Rozwiązane — wróć do aktywnych',
              onClick: async () => {
                await ve.resolveTask(t.id);
                await refreshTasks();
              },
            },
            '☑️ Rozwiązane',
          ),
        )
      : isActive
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

interface TaskPreset {
  pin?: TaskPin | null;
  attachment?: TaskAttachment | null;
}

function summarizeTiles(tiles: TileCoord[]): string {
  if (tiles.length === 0) return 'Brak — zadanie dotyczy całej mapy';
  const head = tiles.slice(0, 6).map((c) => `(${c.x}, ${c.y})`).join(' ');
  return `${tiles.length} kafli: ${head}${tiles.length > 6 ? ' …' : ''}`;
}

function openTaskDialog(kind: string, existing?: TaskView, preset: TaskPreset = {}): void {
  const def = getTaskType(kind);
  if (!def) return;

  let tileRange: TileCoord[] = existing?.tileRange ? [...existing.tileRange] : [];
  let pin: TaskPin | null = existing?.pin ?? preset.pin ?? null;
  const att = existing?.attachment ?? preset.attachment ?? null;

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

  // zakres kafli
  const tileText = h('span', { class: 'status' });
  const refreshTiles = (): void => {
    tileText.textContent = summarizeTiles(tileRange);
  };
  refreshTiles();
  const tileField = h(
    'div',
    { class: 'field' },
    h('label', {}, 'Zakres kafli (opcjonalnie)'),
    h(
      'div',
      { class: 'row center' },
      h(
        'button',
        {
          class: 'btn',
          onClick: () =>
            openMapPicker({
              title: 'Zakres kafli — zaznacz kafle i zatwierdź',
              mode: 'select',
              tiles: tileRange,
              onDone: (r) => {
                tileRange = r.tiles ?? [];
                refreshTiles();
              },
            }),
        },
        'Dobierz kafle…',
      ),
      h(
        'button',
        {
          class: 'btn',
          onClick: () => {
            tileRange = [];
            refreshTiles();
          },
        },
        'Wyczyść',
      ),
      tileText,
    ),
  );

  // pinezka
  const pinText = h('span', { class: 'status' });
  const refreshPin = (): void => {
    if (!pin) {
      pinText.textContent = 'Brak';
      return;
    }
    const p = pinToTile(pin);
    pinText.textContent = `📍 kafel (${p.x}, ${p.y}), pozycja ${pin.x.toFixed(2)}, ${pin.y.toFixed(2)}`;
  };
  refreshPin();
  const pinField = h(
    'div',
    { class: 'field' },
    h('label', {}, 'Pinezka (opcjonalnie)'),
    h(
      'div',
      { class: 'row center' },
      h(
        'button',
        {
          class: 'btn',
          onClick: () =>
            openMapPicker({
              title: 'Pinezka — kliknij punkt na mapie i zatwierdź',
              mode: 'pin',
              pin,
              onDone: (r) => {
                pin = r.pin ?? pin;
                refreshPin();
              },
            }),
        },
        'Wskaż na mapie…',
      ),
      h(
        'button',
        {
          class: 'btn',
          onClick: () => {
            pin = null;
            refreshPin();
          },
        },
        'Usuń',
      ),
      pinText,
    ),
  );

  // załącznik: jezdnia albo obiekt z katalogu mapy
  const kindSelect = h(
    'select',
    {},
    h('option', { value: '' }, 'Brak'),
    h('option', { value: 'road' }, 'Jezdnia'),
    h('option', { value: 'object' }, 'Obiekt'),
  );
  kindSelect.value = att?.kind ?? '';
  const attInput = h('input', {
    type: 'text',
    value: att ? (att.kind === 'object' && att.name ? att.name : att.path) : '',
    placeholder: 'Wybierz z listy…',
  });
  const dataList = h('datalist', { id: `att-list-${Date.now()}` });
  attInput.setAttribute('list', dataList.id);
  const fillList = (): void => {
    clear(dataList);
    const items =
      kindSelect.value === 'road'
        ? catalog.roads.map((r) => h('option', { value: r.path }))
        : kindSelect.value === 'object'
          ? catalog.objects.map((o) => h('option', { value: o.name, label: o.path }))
          : [];
    for (const o of items) dataList.append(o);
    attInput.disabled = kindSelect.value === '';
    if (kindSelect.value === '') attInput.value = '';
  };
  kindSelect.addEventListener('change', () => {
    attInput.value = '';
    fillList();
  });
  fillList();
  const attField = h(
    'div',
    { class: 'field' },
    h('label', {}, 'Załączona jezdnia lub obiekt (opcjonalnie)'),
    h('div', { class: 'row' }, kindSelect, attInput, dataList),
  );

  /** Zamienia wpis z pola na załącznik z katalogu (nie pozwalamy wymyślać nieistniejących assetów). */
  const resolveAttachment = (): { ok: true; value: TaskAttachment | null } | { ok: false; error: string } => {
    const k = kindSelect.value;
    const v = attInput.value.trim();
    if (!k) return { ok: true, value: null };
    if (!v) return { ok: false, error: 'Wybierz jezdnię/obiekt z listy albo ustaw „Brak”.' };
    const q = v.toLowerCase();
    if (k === 'road') {
      const r = catalog.roads.find((x) => x.path.toLowerCase() === q.replace(/\\/g, '/'));
      return r ? { ok: true, value: { kind: 'road', path: r.path } } : { ok: false, error: 'Taka jezdnia nie występuje na mapie — wybierz ją z listy.' };
    }
    const matches = catalog.objects.filter((x) => x.name.toLowerCase() === q || x.path.toLowerCase() === q.replace(/\\/g, '/'));
    if (matches.length === 0) return { ok: false, error: 'Taki obiekt nie występuje na mapie — wybierz go z listy.' };
    const o = matches.find((m) => m.path.toLowerCase() === q.replace(/\\/g, '/')) ?? matches[0];
    return { ok: true, value: { kind: 'object', path: o.path, name: o.name } };
  };

  const error = h('div', { class: 'error' });
  const body = h(
    'div',
    { class: 'dialog' },
    h('h2', {}, `${existing ? 'Edytuj zadanie' : 'Nowe zadanie'} — ${def.label}`),
    h('div', { class: 'field' }, h('label', {}, 'Tytuł'), titleInput),
    ...fieldEls,
    tileField,
    pinField,
    attField,
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
          const a = resolveAttachment();
          if (!a.ok) {
            error.textContent = a.error;
            return;
          }
          const data: Record<string, string> = {};
          for (const [key, el] of inputs) data[key] = el.value;
          const input: TaskInput = {
            title: titleInput.value,
            kind,
            data,
            tileRange: tileRange.length ? tileRange : null,
            pin,
            attachment: a.value,
          };
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
  const pins: GridPin[] = tasks
    .filter((t) => t.pin && t.status !== 'archived')
    .map((t) => ({ id: t.id, title: t.title, x: t.pin!.x, y: t.pin!.y }));
  mapGrid?.setPins(pins);
}

// --- zakładka Mapa ---------------------------------------------------------

interface PickerOptions {
  title: string;
  mode: 'select' | 'pin';
  tiles?: TileCoord[];
  pin?: TaskPin | null;
  onDone: (r: { tiles?: TileCoord[]; pin?: TaskPin | null }) => void;
}

/** Okienko z mapką (taką samą jak w zakładce Mapa) czekającą na zaznaczenie kafli albo punktu. */
function openMapPicker(o: PickerOptions): void {
  if (!overview || overview.tiles.length === 0) {
    alert('Brak danych mapy. Poczekaj na zakończenie indeksowania albo przeskanuj mapę w zakładce Mapa.');
    return;
  }
  const counter = h('span', { class: 'status' });
  const grid = new MapGrid({
    mode: o.mode,
    onSelectionChange: (t) => {
      counter.textContent = `Zaznaczono kafli: ${t.length}`;
    },
    onPinPlaced: (p) => {
      counter.textContent = `Pinezka: ${p.x.toFixed(2)}, ${p.y.toFixed(2)}`;
    },
  });
  grid.setData(overview);
  if (o.mode === 'select') {
    grid.setSelection(o.tiles ?? []);
    counter.textContent = `Zaznaczono kafli: ${(o.tiles ?? []).length}`;
  } else if (o.pin) {
    grid.setPending(o.pin);
    counter.textContent = `Pinezka: ${o.pin.x.toFixed(2)}, ${o.pin.y.toFixed(2)}`;
  }
  const body = h(
    'div',
    { class: 'dialog' },
    h('h2', {}, o.title),
    o.mode === 'select'
      ? h(
          'div',
          { class: 'toolbar' },
          h('button', { class: 'btn', onClick: () => grid.selectAll(true) }, 'Zaznacz wszystkie'),
          h('button', { class: 'btn', onClick: () => grid.selectAll(false) }, 'Wyczyść'),
          h('div', { class: 'spacer' }),
          counter,
        )
      : h('div', { class: 'toolbar' }, h('div', { class: 'spacer' }), counter),
    h('div', { class: 'picker-grid' }, grid.el),
  );
  const close = openModal(body, false, true);
  body.append(
    h(
      'div',
      { class: 'modal-actions' },
      h('button', { class: 'btn', onClick: close }, 'Anuluj'),
      h(
        'button',
        {
          class: 'btn primary',
          onClick: () => {
            if (o.mode === 'pin' && !grid.getPending()) {
              counter.textContent = 'Najpierw kliknij punkt na mapie.';
              return;
            }
            o.onDone(o.mode === 'select' ? { tiles: grid.getSelection() } : { pin: grid.getPending() });
            close();
          },
        },
        'Zatwierdź',
      ),
    ),
  );
  grid.show();
}

function updateMapToolbar(): void {
  pinBtn.classList.toggle('active', pinMode);
  rescanBtn.disabled = mapBusy;
  mapSummary.textContent = mapBusy
    ? 'Indeksowanie mapy i kopiowanie assetów…'
    : overview
      ? `Kafli: ${overview.tiles.length} · assetów: ${overview.assetCount}` +
        (overview.missingCount ? ` (brak w OMSI: ${overview.missingCount})` : '')
      : '';
}

function setPinMode(on: boolean): void {
  pinMode = on;
  mapGrid.setMode(on ? 'pin' : 'info');
  if (!on) mapGrid.setPending(null);
  updateMapToolbar();
}

function mountMapTab(): void {
  const root = $('view-map');
  clear(root);
  mapGrid = new MapGrid({
    mode: 'info',
    onPinPlaced: (p) => {
      // punkt wskazany: wracamy do zwykłego trybu i otwieramy nowe zadanie z tą pinezką
      setPinMode(false);
      openTaskDialog(TASK_TYPES[0].kind, undefined, { pin: p });
    },
  });
  pinBtn = h(
    'button',
    { class: 'btn', title: 'Kliknij punkt na mapie, aby dodać zadanie z pinezką', onClick: () => setPinMode(!pinMode) },
    '📍 Dodaj pinezkę',
  );
  rescanBtn = h(
    'button',
    {
      class: 'btn',
      onClick: async () => {
        const res = await ve.reindexMap();
        if (!res.ok) alert(res.error ?? 'Nie udało się przeskanować mapy.');
      },
    },
    'Przeskanuj mapę ponownie',
  );
  mapSummary = h('span', { class: 'status' });
  root.append(
    h(
      'div',
      { class: 'toolbar' },
      h('button', { class: 'btn', onClick: () => mapGrid.fit() }, 'Wycentruj'),
      pinBtn,
      rescanBtn,
      h('div', { class: 'spacer' }),
      mapSummary,
    ),
    mapGrid.el,
  );
  updateMapToolbar();
}

async function refreshMap(): Promise<void> {
  mapBusy = await ve.isMapIndexing();
  overview = await ve.getMapOverview();
  catalog = await ve.getCatalog();
  mapGrid.setBusy(mapBusy);
  mapGrid.setData(overview);
  roadsView.setCatalog(catalog);
  objectsView.setCatalog(catalog);
  updateMapToolbar();
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
  const modeCode = h('input', { type: 'radio', name: 'claude-mode', value: 'code', checked: cur.claudeMode !== 'free' });
  const modeFree = h('input', { type: 'radio', name: 'claude-mode', value: 'free', checked: cur.claudeMode === 'free' });
  const chatInput = h('input', {
    type: 'text',
    value: cur.claudeChatUrl,
    placeholder: 'https://claude.ai/chat/ID-CZATU',
  });
  const autoSendCheck = h('input', { type: 'checkbox', checked: cur.claudeAutoSend });
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

  const codePanel = h(
    'div',
    { class: 'mode-panel' },
    h('label', { class: 'field-label' }, 'Claude Code — ścieżka (opcjonalnie)'),
    claudeInput,
    claudeBtns,
    claudeStatus,
    h(
      'div',
      { class: 'hint' },
      'Aplikacja uruchamia Claude Code w folderze roboczym. Zaloguj się raz przyciskiem powyżej (polecenie /login).',
    ),
  );
  const freePanel = h(
    'div',
    { class: 'mode-panel' },
    h('label', { class: 'field-label' }, 'Link do czatu Claude'),
    chatInput,
    h('label', { class: 'check' }, autoSendCheck, 'Wyślij automatycznie (Enter po wklejeniu)'),
    h(
      'div',
      { class: 'hint' },
      '„Uruchom” kopiuje prompt do schowka, otwiera ten czat w aplikacji Claude (claude://) i wkleja prompt. ' +
        'Wymaga zainstalowanej aplikacji Claude (Windows). Zadania trafiają do archiwum po wklejeniu promptu.',
    ),
  );
  const syncMode = (): void => {
    codePanel.hidden = !modeCode.checked;
    freePanel.hidden = !modeFree.checked;
  };
  modeCode.addEventListener('change', syncMode);
  modeFree.addEventListener('change', syncMode);
  syncMode();

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
      h('label', {}, 'Claude'),
      h('label', { class: 'check' }, modeCode, 'Claude Code'),
      h('label', { class: 'check' }, modeFree, 'Claude Free'),
    ),
    codePanel,
    freePanel,
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
      claudeMode: modeFree.checked ? 'free' : 'code',
      claudePath: claudeInput.value,
      claudeChatUrl: chatInput.value,
      claudeAutoSend: autoSendCheck.checked,
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
  mountMapTab();
  const assetActions = {
    createTask: (a: TaskAttachment) => openTaskDialog(TASK_TYPES[0].kind, undefined, { attachment: a }),
  };
  roadsView = new RoadsView($('view-roads'), assetActions);
  objectsView = new ObjectsView($('view-objects'), assetActions);
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
  ve.onMapChanged(() => void refreshMap());

  consoleLines = await ve.getConsoleHistory();
  fillConsole();
  run = await ve.getRunState();
  await refreshTasks();
  await refreshMap();

  const settings = await ve.getSettings();
  if (!settings.configured) await openSettings(true);
}

void init();
