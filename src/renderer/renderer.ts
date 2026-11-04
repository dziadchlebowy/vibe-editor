import { arcEnd, arcPoints } from '../shared/arcs.ts';
import { projectOnLine } from '../shared/geo.ts';
import { moveSplines, newSpline, newSplineStartAt, splineEndPose, splineEndZ, type EditSpline, type NewSplineGeom, type NewSplineStart } from '../shared/splineEdit.ts';
import { routeBases } from '../shared/routeBases.ts';
import { pinToTile } from '../shared/taskExtras.ts';
import { TASK_TYPES, getTaskType } from '../shared/taskTypes.ts';
import type {
  ConsoleLine,
  LinkEnd,
  LinkEndRef,
  LinkFreePoint,
  LinkNode,
  LinkPlan,
  MapCatalog,
  MapInfo,
  MapOverview,
  MapSplines,
  RouteSegment,
  RunState,
  SplineIssue,
  SplinePoint,
  SplinePointRef,
  Settings,
  TaskAttachment,
  TaskInput,
  TaskPin,
  TaskView,
  TileCoord,
  TripRoute,
} from '../shared/types.ts';

import { ObjectsView, RoadsView } from './assetViews.ts';
import { $, clear, h } from './dom.ts';
import { MapGrid, type GridPin, type GridStop, type SplinePointer } from './mapView.ts';
import { ZONES, fromParams, hasPolishChars, toParams, validateParams, type StopParams } from '../shared/busStop.ts';
import { TimetableView } from './timetableView.ts';

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
  const title = content.querySelector('h2');
  if (title && closable) {
    const x = h('button', { class: 'wbtn wclose dlg-x', title: 'Zamknij', 'aria-label': 'Zamknij' });
    x.addEventListener('click', close);
    title.append(x);
  }
  $('modal-root').append(backdrop);
  return close;
}

/** Pasek stanu (motyw XP): stan przetwarzania, liczba zadań i kafli. */
function updateStatusBar(): void {
  const text = $('status-text');
  const busy = run.status === 'running';
  text.classList.toggle('busy', busy);
  text.textContent = busy ? 'Claude pracuje nad zadaniami…' : run.status === 'idle' ? 'Gotowe' : `Stan: ${run.status}`;
  const active = tasks.filter((t) => t.status === 'active').length;
  const rejected = tasks.filter((t) => t.status === 'rejected').length;
  $('status-tasks').textContent = `Zadania: ${active}${rejected ? ` (odrzucone: ${rejected})` : ''}`;
  $('status-map').textContent = overview ? `Kafle: ${overview.tiles.length}${mapBusy ? ' – indeksowanie…' : ''}` : '';
}

// --- stan ------------------------------------------------------------------

type TabId = 'tasks' | 'map' | 'roads' | 'objects' | 'lines' | 'console';
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
let splinesData: MapSplines | null = null;
let roadsView: RoadsView;
let timetableView: TimetableView;
let objectsView: ObjectsView;
let mapSummary: HTMLElement;
let pinBtn: HTMLButtonElement;
let rescanBtn: HTMLButtonElement;
let routeSelect: HTMLSelectElement;
let routeInfo: HTMLElement;

// --- zakładki --------------------------------------------------------------

const TABS: { id: TabId; label: string }[] = [
  { id: 'tasks', label: 'Zadania' },
  { id: 'map', label: 'Mapa i trasy' },
  { id: 'lines', label: 'Rozkłady' },
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
            if (t.id === 'map') {
              mapGrid?.show();
              void fillRouteSelect();
            }
            if (t.id === 'lines') void timetableView?.reload();
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
  updateStatusBar();
}

// --- zakładka Mapa i trasy ---------------------------------------------------------

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
  grid.setSplines(splinesData);
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

const mapLayers = { paths: false, stops: false, splines: true };
const layerCbs: Partial<Record<keyof typeof mapLayers, HTMLInputElement>> = {};

async function applyMapSettings(): Promise<void> {
  const s = await ve.getSettings();
  mapGrid?.setSplineMaxWidth(s.splineMaxWidth);
}

function layerBox(label: string, title: string, key: keyof typeof mapLayers): HTMLElement {
  const cb = h('input', { type: 'checkbox', checked: mapLayers[key] });
  cb.title = title;
  layerCbs[key] = cb;
  cb.addEventListener('change', () => {
    mapLayers[key] = cb.checked;
    mapGrid.setLayers(mapLayers);
  });
  return h('label', { class: 'tt-check', title }, cb, label);
}

/** Okno edycji parametrów przystanku (zapis do pliku kafla .map). */
function openStopDialog(stop: GridStop): void {
  const p = toParams(stop.p);
  const err = h('div', { class: 'error' });
  const mk = (key: keyof StopParams, label: string, hint?: string): HTMLElement[] => {
    const input = h('input', { type: 'text', value: p[key] });
    input.addEventListener('input', () => {
      p[key] = input.value;
      if (key === 'name') warn.textContent = hasPolishChars(p.name) ? 'Nazwa zawiera polskie znaki — zalecane ich unikanie.' : '';
    });
    return hint ? [h('label', {}, label), input, h('div', { class: 'hint' }, hint)] : [h('label', {}, label), input];
  };
  const warn = h('div', { class: 'hint' });
  const zone = h('select', {}, h('option', { value: '' }, '(puste)'), ...ZONES.map((z) => h('option', { value: z.value, selected: z.value === p.zone }, z.label)));
  zone.addEventListener('change', () => (p.zone = zone.value));
  const close = openModal(
    h(
      'div',
      { class: 'dialog' },
      h('h2', {}, `Przystanek ${stop.id}`),
      h(
        'div',
        { class: 'stop-grid' },
        ...mk('name', 'Nazwa'),
        warn,
        ...mk('maxPassengers', 'Maks. pasażerów', 'Maksymalna liczba pasażerów na przystanku.'),
        ...mk('minPassengers', 'Min. pasażerów', 'Minimalna liczba pasażerów na przystanku.'),
        ...mk('exitPassengers', 'Wyjście pasażerów', 'Ilu maksymalnie pasażerów może wysiąść (nie dotyczy końcowych).'),
        ...mk('dockLength', 'Długość dokowania (m)', 'Długość przystanku / platformy w metrach.'),
        h('label', {}, 'Strefa wyjścia/wejścia'),
        zone,
        ...mk('subName', 'Podnazwa (opcjonalnie)', 'Druga nazwa przystanku, np. słupek.'),
      ),
      err,
      h(
        'div',
        { class: 'modal-actions' },
        h('button', { class: 'btn', onClick: () => close() }, 'Anuluj'),
        h(
          'button',
          {
            class: 'btn primary',
            onClick: async () => {
              p.name = p.name.trim();
              const bad = validateParams(p);
              if (bad) {
                err.textContent = bad;
                return;
              }
              const r = await ve.saveStop(stop.tileFile, stop.id, fromParams(p));
              if (!r.ok) {
                err.textContent = r.error ?? 'Nie udało się zapisać.';
                return;
              }
              close();
              mapGrid.setStops(await ve.getMapStops());
            },
          },
          'Zapisz',
        ),
      ),
    ),
    true,
  );
  warn.textContent = hasPolishChars(p.name) ? 'Nazwa zawiera polskie znaki — zalecane ich unikanie.' : '';
}

// --- trasy kursów: podgląd i edycja ---------------------------------------

/** Przystanek dodany w edytorze, jeszcze niezapisany do .ttp. */
interface PendingStop {
  stopId: string;
  tileFile: string;
  name: string;
  x: number;
  y: number;
  seg: RouteSegment;
  /** Odległość wzdłuż ścieżki odcinka (m) i boczne przesunięcie od niej (m, w prawo +). */
  along: number;
  lateral: number;
}
/** Wiersz drugiej listy: przystanek kursu (z .ttp) albo dodany w edytorze. */
interface StationRow {
  n: number;
  name: string;
  seg: RouteSegment | null;
  along: number;
  pending: PendingStop | null;
  x?: number;
  y?: number;
}

let routeBase: TripRoute | null = null; // wczytana trasa: przystanki i metadane (odcinki trzyma routeSegs)
let routeSegs: RouteSegment[] = []; // robocza lista odcinków (kolejność jazdy)
let stationSegs: (RouteSegment | null)[] = []; // odcinek przypisany do istniejącego przystanku (po numerze w kursie)
let pendingStops: PendingStop[] = [];
let routeSel: number | null = null;
let routeDirty = false;
let routeEditing = false;
let routeTab: 'segments' | 'stops' = 'segments';
let pickingStop = false;
let routeUndo: RouteSegment[][] = [];
let routeRedo: RouteSegment[][] = [];
let routePanel: HTMLElement;
let editBtn: HTMLButtonElement;

/** Lista kursów do wyboru trasy; kursy bez pliku .ttr też, bo trasę można dla nich utworzyć. Zachowuje wybór. */
async function fillRouteSelect(): Promise<void> {
  if (!routeSelect) return;
  const keep = routeSelect.value;
  const trips = (await ve.loadTimetable()).trips;
  routeSelect.replaceChildren(
    h('option', { value: '' }, trips.length ? '— bez trasy —' : '— brak kursów (.ttp) w folderze mapy —'),
    ...trips.map((t) => h('option', { value: t.file }, `${t.title ? `${t.name} → ${t.title}` : t.name}${t.trackFile ? '' : ' — brak .ttr'}`)),
  );
  if (trips.some((t) => t.file === keep)) routeSelect.value = keep;
}

const routeMeters = (): number => routeSegs.reduce((n, g) => n + g.length, 0);

/** Zapis przystanków do .ttp jest dozwolony, gdy przypisanie istniejących przystanków do odcinków potwierdza się na danych. */
function stationsWritable(): boolean {
  const c = routeBase?.stationCheck;
  return !!c && c.ok === c.total;
}

function routeSummary(): string {
  const r = routeBase;
  if (!r) return '';
  const parts = [`Trasa ${r.trip}: odcinków ${routeSegs.length}`, `${Math.round(routeMeters())} m`, `przystanków na mapie ${r.stops.length}`];
  if (r.noFile) parts.push('brak pliku .ttr (powstanie przy zapisie)');
  const bad = routeSegs.filter((g) => g.line.length === 0).length;
  if (bad) parts.push(`nieznalezionych odcinków: ${bad} (przeskanuj mapę lub sprawdź .ttr)`);
  const ic = r.indexCheck;
  if (ic.splines.bad || ic.objects.bad) parts.push(`⚠ numer elementu na kaflu niezgodny: spliny ${ic.splines.bad}/${ic.splines.total}, obiekty ${ic.objects.bad}/${ic.objects.total}`);
  if (r.missingStops.length) parts.push(`brak przystanków: ${r.missingStops.join(', ')}`);
  const c = r.stationCheck;
  if (c.total > 0) parts.push(c.ok === c.total ? `przypisanie przystanków do odcinków zgodne (${c.ok}/${c.total}, wzdłuż ${c.posOk}, bokiem ${c.latOk})` : `⚠ przypisanie przystanków zgodne tylko w ${c.ok}/${c.total}`);
  if (routeDirty) parts.push('NIEZAPISANE ZMIANY');
  return parts.join(' · ');
}

/** Wiersze drugiej listy: przystanki kursu w kolejności pliku z wstawionymi nowymi według (odcinek, położenie). */
function stationRows(): StationRow[] {
  const r = routeBase;
  if (!r) return [];
  const segIdx = (g: RouteSegment | null, fallback: number): number => {
    const i = g ? routeSegs.indexOf(g) : -1;
    return i >= 0 ? i : fallback;
  };
  type Keyed = StationRow & { key: readonly [number, number] };
  const rows: Keyed[] = r.stations.map((st, i) => ({ n: 0, name: st.name, seg: stationSegs[i] ?? null, along: st.along, pending: null, x: st.x, y: st.y, key: [segIdx(stationSegs[i] ?? null, st.entry), st.along] as const }));
  for (const p of [...pendingStops].sort((x, y) => routeSegs.indexOf(x.seg) - routeSegs.indexOf(y.seg) || x.along - y.along)) {
    const key = [routeSegs.indexOf(p.seg), p.along] as const;
    let at = 0;
    rows.forEach((row, i) => {
      if (row.key[0] < key[0] || (row.key[0] === key[0] && row.key[1] <= key[1])) at = i + 1;
    });
    rows.splice(at, 0, { n: 0, name: p.name, seg: p.seg, along: p.along, pending: p, x: p.x, y: p.y, key });
  }
  rows.forEach((row, i) => (row.n = i + 1));
  return rows;
}

/** Przerysowuje trasę na mapie, panel edycji i pasek informacji z bieżącego stanu roboczego. */
function applyRoute(): void {
  const rows = stationRows();
  const markers = rows.flatMap((row) => (row.x !== undefined && row.y !== undefined ? [{ n: row.n, name: row.name, x: row.x, y: row.y, pending: !!row.pending }] : []));
  mapGrid.setRoute(routeBase ? { ...routeBase, segments: routeSegs, stops: markers } : null);
  mapGrid.setRouteSelected(routeSel);
  routeInfo.textContent = routeSummary();
  routeInfo.className = routeDirty ? 'status warn' : 'status';
  editBtn.disabled = !routeBase;
  renderRoutePanel(rows);
}

function routeChange(next: RouteSegment[], sel: number | null): void {
  routeUndo.push(routeSegs);
  routeRedo = [];
  routeSegs = next;
  routeSel = sel;
  routeDirty = true;
  mapGrid.setRouteHover([]);
  applyRoute();
}

function routeUndoRedo(from: RouteSegment[][], to: RouteSegment[][]): void {
  const prev = from.pop();
  if (!prev) return;
  to.push(routeSegs);
  routeSegs = prev;
  routeSel = routeSel !== null && routeSel < routeSegs.length ? routeSel : null;
  routeDirty = true;
  applyRoute();
}

function selectRouteSeg(i: number | null, focus = true): void {
  routeSel = i;
  applyRoute();
  if (focus && i !== null) mapGrid.focusSegment(i);
}

/** Wstawia odcinki po zaznaczonym (albo na końcu) i zaznacza ostatni z nich. */
function routeInsertMany(segs: RouteSegment[]): void {
  const pos = routeSel === null ? routeSegs.length : routeSel + 1;
  routeChange([...routeSegs.slice(0, pos), ...segs, ...routeSegs.slice(pos)], pos + segs.length - 1);
}

function routeDelete(): void {
  if (routeSel === null) return;
  const i = routeSel;
  routeChange(routeSegs.filter((_, k) => k !== i), routeSegs.length - 1 === 0 ? null : Math.min(i, routeSegs.length - 2));
}

function routeMove(d: -1 | 1): void {
  if (routeSel === null) return;
  const j = routeSel + d;
  if (j < 0 || j >= routeSegs.length) return;
  const next = [...routeSegs];
  [next[routeSel], next[j]] = [next[j], next[routeSel]];
  routeChange(next, j);
}

async function routeSave(): Promise<void> {
  if (!routeBase) return;
  const r = routeBase;
  const base = routeBases(routeSegs);
  const orphan = r.stations.filter((_, i) => stationSegs[i] && !routeSegs.includes(stationSegs[i]!)).map((st) => st.name);
  const orphanNew = pendingStops.filter((p) => !routeSegs.includes(p.seg)).map((p) => p.name);
  if (orphan.length || orphanNew.length) {
    alert(`Przystanki przypisane do usuniętych odcinków: ${[...orphan, ...orphanNew].join(', ')}.\nCofnij usunięcie odcinka (Ctrl+Z) albo usuń nowy przystanek z listy.`);
    return;
  }
  const remap = stationsWritable()
    ? r.stations.flatMap((st, i) => {
        const seg = stationSegs[i];
        const entry = seg ? routeSegs.indexOf(seg) : -1;
        const changed = entry >= 0 && (entry !== st.entry || Math.abs(base(entry) + st.along - st.route) > 0.001);
        return changed ? [{ index: i, entry }] : [];
      })
    : [];
  const add = pendingStops.map((p) => ({ stopId: p.stopId, tileFile: p.tileFile, name: p.name, entry: routeSegs.indexOf(p.seg), along: p.along, lateral: p.lateral }));
  const res = await ve.saveTripRoute(r.tripFile, routeSegs, { remap, add });
  if (!res.ok) {
    alert(res.error ?? 'Nie udało się zapisać trasy.');
    return;
  }
  const keepSel = routeSel;
  const keepTab = routeTab;
  await showTripRoute(r.tripFile, false, true);
  routeTab = keepTab;
  routeSel = keepSel !== null && keepSel < routeSegs.length ? keepSel : null;
  applyRoute();
  void fillRouteSelect();
  void timetableView?.reload();
}

/** Odcinek, od którego jedziemy: zaznaczony, a gdy nic nie zaznaczono — ostatni odcinek trasy. */
function fromLine(): number[] | null {
  const g = routeSel !== null ? routeSegs[routeSel] : routeSegs[routeSegs.length - 1];
  return g && g.line.length >= 4 ? g.line : null;
}

// podświetlanie ścieżek pod kursorem: zapytania do procesu głównego jedno po drugim, liczy się tylko ostatnie położenie
let hoverBusy = false;
let hoverLatest: { x: number; y: number; maxDistM: number; overSegment: boolean } | null | undefined;
function onRouteMapHover(c: { x: number; y: number; maxDistM: number; overSegment: boolean } | null): void {
  hoverLatest = c;
  if (!hoverBusy) void runHover();
}
async function runHover(): Promise<void> {
  hoverBusy = true;
  try {
    while (hoverLatest !== undefined) {
      const c = hoverLatest;
      hoverLatest = undefined;
      if (!c || c.overSegment || pickingStop || !routeEditing) {
        mapGrid.setRouteHover([]);
        continue;
      }
      const r = await ve.hoverTrack(c.x, c.y, c.maxDistM, fromLine());
      mapGrid.setRouteHover(r.chain.length > 0 ? r.chain : r.target ? [r.target] : []);
    }
  } finally {
    hoverBusy = false;
  }
}

/** Dodaje przystanek (obiekt z mapy) do kursu, przypisany do zaznaczonego odcinka trasy albo do najbliższego. */
function addPendingStop(stop: GridStop): void {
  const say = (t: string): void => {
    routeInfo.textContent = t;
    routeInfo.className = 'status warn';
  };
  if (!stationsWritable()) return say('Zapis przystanków wyłączony: przypisanie istniejących przystanków do odcinków nie zgadza się z danymi.');
  const name = toParams(stop.p).name || stop.p[0] || '';
  if (!name || stop.wx === undefined || stop.wy === undefined) return say('Ten przystanek nie ma nazwy — nadaj ją najpierw w jego parametrach.');
  if (routeBase?.stations.some((st) => st.id === stop.id) || pendingStops.some((p) => p.stopId === stop.id)) return say(`Przystanek „${name}” jest już w kursie.`);
  let seg: RouteSegment | undefined = routeSel !== null ? routeSegs[routeSel] : undefined;
  if (!seg) {
    let best = Infinity;
    for (const g of routeSegs) {
      const d = g.line.length >= 4 ? projectOnLine(g.line, stop.wx, stop.wy).d : Infinity;
      if (d < best) (best = d, (seg = g));
    }
  }
  if (!seg || seg.line.length < 4) return say('Najpierw dodaj do trasy odcinek, przy którym stoi przystanek (albo zaznacz go na liście).');
  const pr = projectOnLine(seg.line, stop.wx, stop.wy);
  pendingStops = [...pendingStops, { stopId: stop.id, tileFile: stop.tileFile, name, x: stop.wx, y: stop.wy, seg, along: Math.min(pr.s, seg.length), lateral: pr.side }];
  routeDirty = true;
  pickingStop = false;
  routeTab = 'stops';
  routeSel = routeSegs.indexOf(seg);
  applyRoute();
}

/** Klik w trybie edycji: przystanek (w trybie dodawania), istniejący odcinek zaznacza, puste miejsce dodaje ścieżkę (albo cały łańcuch). */
async function onRouteMapClick(c: { segment: number | null; stop: GridStop | null; x: number; y: number; maxDistM: number }): Promise<void> {
  if (pickingStop) {
    if (c.stop) addPendingStop(c.stop);
    else {
      routeInfo.textContent = 'Kliknij przystanek (kółko przystanku) na mapie — warstwa „Przystanki” jest włączona.';
      routeInfo.className = 'status warn';
    }
    return;
  }
  if (c.segment !== null) {
    selectRouteSeg(c.segment, false);
    return;
  }
  const r = await ve.hoverTrack(c.x, c.y, c.maxDistM, fromLine());
  const segs = r.chain.length > 0 ? r.chain : r.target ? [r.target] : [];
  if (segs.length === 0) {
    routeInfo.textContent = 'W tym miejscu nie ma ścieżki ruchu — przybliż mapę i kliknij bliżej drogi.';
    routeInfo.className = 'status warn';
    return;
  }
  const same = routeSegs.findIndex((g) => g.id === segs[0].id && g.pathIndex === segs[0].pathIndex);
  if (segs.length === 1 && same >= 0) selectRouteSeg(same, false);
  else routeInsertMany(segs.filter((g) => !routeSegs.some((e) => e.id === g.id && e.pathIndex === g.pathIndex)));
}

function routeButton(label: string, title: string, fn: () => void, disabled = false, cls = 'btn'): HTMLElement {
  const b = h('button', { class: cls, title, onClick: fn }, label);
  b.disabled = disabled;
  return b;
}

function renderRoutePanel(rows: StationRow[] = stationRows()): void {
  if (!routePanel) return;
  const scroll = routePanel.querySelector('.rt-list')?.scrollTop ?? 0;
  clear(routePanel);
  routePanel.hidden = !routeEditing || !routeBase;
  if (routePanel.hidden || !routeBase) return;
  const n = routeSegs.length;
  const segNo = (g: RouteSegment | null): string => {
    const i = g ? routeSegs.indexOf(g) : -1;
    return i >= 0 ? `odc. ${i + 1}` : '⚠ odcinek usunięty';
  };
  const list = h('div', { class: 'rt-list' });
  if (routeTab === 'segments') {
    routeSegs.forEach((g, k) => {
      list.append(
        h(
          'button',
          { class: `rt-row${k === routeSel ? ' active' : ''}${g.line.length === 0 ? ' bad' : ''}`, title: g.line.length === 0 ? 'Nie znaleziono na mapie' : `kafel ${g.tile}, element ${g.index}`, onClick: () => selectRouteSeg(k) },
          h('span', { class: 'rt-n' }, `${k + 1}.`),
          h('span', { class: 'rt-id' }, `${g.line.length === 0 ? '⚠ ' : ''}${g.id}`),
          h('span', { class: 'rt-meta' }, `ścieżka ${g.pathIndex} · ${g.length.toFixed(1)} m`),
        ),
      );
    });
    if (n === 0) list.append(h('div', { class: 'empty' }, 'Trasa jest pusta. Kliknij na mapie ścieżkę ruchu (jezdnię), aby dodać pierwszy odcinek.'));
  } else {
    rows.forEach((row) => {
      const seg = row.seg ? routeSegs.indexOf(row.seg) : -1;
      const del = row.pending
        ? h('span', {
            class: 'rt-del',
            title: 'Usuń ten nowy przystanek',
            onClick: (e: Event) => {
              e.stopPropagation();
              pendingStops = pendingStops.filter((p) => p !== row.pending);
              routeDirty = routeDirty || pendingStops.length > 0;
              applyRoute();
            },
          }, '🗑️')
        : h('span');
      list.append(
        h(
          'button',
          { class: `rt-row${seg >= 0 && seg === routeSel ? ' active' : ''}${row.pending ? ' new' : ''}${seg < 0 ? ' bad' : ''}`, title: row.pending ? 'Nowy przystanek — zapisze się do .ttp' : 'Przystanek kursu (.ttp)', onClick: () => seg >= 0 && selectRouteSeg(seg) },
          h('span', { class: 'rt-n' }, `${row.n}.`),
          h('span', { class: 'rt-id' }, `${row.pending ? '➕ ' : ''}${row.name}`),
          h('span', { class: 'rt-meta' }, `${segNo(row.seg)} · ${row.along.toFixed(1)} m`),
          del,
        ),
      );
    });
    if (rows.length === 0) list.append(h('div', { class: 'empty' }, 'Kurs nie ma jeszcze przystanków.'));
  }
  const tabBtn = (t: 'segments' | 'stops', label: string): HTMLElement =>
    h('button', { class: `btn${routeTab === t ? ' active' : ''}`, onClick: () => ((routeTab = t), (pickingStop = false), mapGrid.setRouteHover([]), applyRoute()) }, label);
  const sc = routeBase.stationCheck;
  routePanel.append(
    h('div', { class: 'rt-title' }, `✏️ Edycja trasy: ${routeBase.trip}`),
    h('div', { class: 'rt-buttons' }, tabBtn('segments', `Odcinki (${n})`), tabBtn('stops', `Przystanki (${rows.length})`)),
    routeTab === 'segments'
      ? h(
          'div',
          { class: 'rt-buttons' },
          routeButton('↶', 'Cofnij (Ctrl+Z)', () => routeUndoRedo(routeUndo, routeRedo), routeUndo.length === 0),
          routeButton('↷', 'Ponów (Ctrl+Y)', () => routeUndoRedo(routeRedo, routeUndo), routeRedo.length === 0),
          routeButton('▲', 'Przesuń zaznaczony odcinek wcześniej', () => routeMove(-1), routeSel === null || routeSel === 0),
          routeButton('▼', 'Przesuń zaznaczony odcinek później', () => routeMove(1), routeSel === null || routeSel >= n - 1),
          routeButton('🗑️', 'Usuń zaznaczony odcinek (Delete)', routeDelete, routeSel === null),
        )
      : h(
          'div',
          { class: 'rt-buttons' },
          routeButton(pickingStop ? '✖ Anuluj dodawanie' : '➕ Dodaj przystanek', 'Kliknij przystanek na mapie: zostanie przypisany do zaznaczonego odcinka trasy (a gdy nic nie zaznaczono — do najbliższego)', () => ((pickingStop = !pickingStop), mapGrid.setRouteHover([]), applyRoute()), !stationsWritable() && !pickingStop),
        ),
    list,
    h(
      'div',
      { class: 'rt-foot' },
      routeTab === 'segments'
        ? `${n} odc. · ${Math.round(routeMeters())} m`
        : pickingStop
          ? 'Kliknij przystanek na mapie (przypisze się do zaznaczonego odcinka lub najbliższego).'
          : sc.total === 0
            ? 'Brak przystanków do porównania — położenie nowych przystanków jest niezweryfikowane.'
            : sc.ok === sc.total
              ? `Przypisanie zgodne z .ttp (${sc.ok}/${sc.total}); odległość wzdłuż ścieżki zgodna w ${sc.posOk}/${sc.total}, boczne przesunięcie w ${sc.latOk}/${sc.total}.`
              : `⚠ Przypisanie zgodne tylko w ${sc.ok}/${sc.total} — dodawanie przystanków wyłączone.`,
    ),
    h(
      'div',
      { class: 'rt-buttons' },
      routeButton('💾 Zapisz', 'Zapisz trasę do .ttr (kopia .ttr.bak) i nowe przystanki do .ttp (kopia .ttp.bak); Ctrl+S', () => void routeSave(), !routeDirty, 'btn primary'),
      routeButton('Zakończ edycję', 'Wyłącz tryb edycji (niezapisane zmiany zostają do zapisu)', () => setRouteEditing(false)),
    ),
  );
  const keep = routePanel.querySelector('.rt-list');
  if (keep) keep.scrollTop = scroll;
  routePanel.querySelector('.rt-row.active')?.scrollIntoView({ block: 'nearest' });
}

/** Włącza wskazane warstwy mapy (i ich pola wyboru), żeby było co klikać w trybach edycji. */
function enableLayers(keys: readonly (keyof typeof mapLayers)[]): void {
  for (const k of keys) {
    mapLayers[k] = true;
    const cb = layerCbs[k];
    if (cb) cb.checked = true;
  }
  mapGrid.setLayers(mapLayers);
}

function setRouteEditing(on: boolean): void {
  routeEditing = on && !!routeBase;
  editBtn.textContent = routeEditing ? '✏️ Edycja trasy: włączona' : '✏️ Edytuj trasę';
  editBtn.classList.toggle('active', routeEditing);
  if (routeEditing) enableLayers(['splines', 'paths', 'stops']);
  else {
    pickingStop = false;
    routeSel = null;
    mapGrid.setRouteHover([]);
  }
  mapGrid.setRouteEditing(routeEditing);
  applyRoute();
}

/** Pokazuje na mapie trasę kursu (plik kursu względem folderu mapy); pusty ciąg ją ukrywa. */
async function showTripRoute(tripFile: string, fit = true, force = false): Promise<void> {
  if (!force && routeDirty && routeBase?.tripFile !== tripFile && !window.confirm('Masz niezapisane zmiany trasy. Odrzucić je?')) {
    routeSelect.value = routeBase?.tripFile ?? '';
    return;
  }
  routeDirty = false;
  routeUndo = [];
  routeRedo = [];
  routeSel = null;
  pendingStops = [];
  pickingStop = false;
  if (!tripFile) {
    routeBase = null;
    routeSegs = [];
    stationSegs = [];
    routeInfo.textContent = '';
    setRouteEditing(false);
    return;
  }
  routeInfo.textContent = 'Wczytuję trasę…';
  const route = await ve.getTripRoute(tripFile);
  if (route.error) {
    routeBase = null;
    routeSegs = [];
    stationSegs = [];
    setRouteEditing(false);
    routeInfo.textContent = route.error;
    return;
  }
  routeBase = route;
  routeSegs = route.segments;
  stationSegs = route.stations.map((st) => route.segments[st.entry] ?? null);
  applyRoute();
  if (fit) requestAnimationFrame(() => mapGrid.fitRoute());
}

/** Z zakładki Rozkłady: przełącza na mapę i pokazuje trasę kursu. */
async function openTripRouteOnMap(tripFile: string): Promise<void> {
  activeTab = 'map';
  renderTabs();
  mapGrid.show();
  setMapMode('routes');
  await fillRouteSelect();
  routeSelect.value = tripFile;
  await showTripRoute(tripFile);
}

// --- tryby zakładki „Mapa i trasy” ------------------------------------------------

type MapMode = 'view' | 'routes' | 'links' | 'splines';
let mapMode: MapMode = 'view';
let modeButtons: Record<MapMode, HTMLButtonElement>;
let modeBars: Record<MapMode, HTMLElement>;

const MODE_INFO: Record<MapMode, { label: string; title: string }> = {
  view: { label: '🗺️ Przegląd', title: 'Przeglądanie mapy: warstwy, edycja parametrów przystanków, pinezki do zadań' },
  routes: { label: '🚌 Trasy kursów', title: 'Trasa kursu z pliku .ttr z przystankami; edycja trasy i przypisywanie przystanków do odcinków' },
  links: { label: '🔗 Łączenia ścieżek', title: 'Tworzenie łączeń (spline invis_street) między węzłami ścieżek ruchu' },
  splines: { label: '✏️ Edycja splinów', title: 'Zaznaczanie początków i końców splinów: G przesuwa, Z zmienia wysokość, N tworzy nowy spline' },
};

/** Przełącza tryb zakładki: każdy tryb ma własny pasek narzędzi, a poprzedni sprząta po sobie. */
function setMapMode(m: MapMode): void {
  if (m === mapMode) return;
  if (mapMode === 'routes') {
    setRouteEditing(false);
    mapGrid.setRoute(null);
  }
  if (mapMode === 'links') resetLink(true);
  if (mapMode === 'splines') resetSpl(true);
  if (mapMode === 'view') setPinMode(false);
  mapMode = m;
  for (const k of Object.keys(MODE_INFO) as MapMode[]) {
    modeButtons[k].classList.toggle('active', k === m);
    modeBars[k].hidden = k !== m;
  }
  // zaznaczanie kafli i ich szczegóły tylko w trybie „Przegląd”
  mapGrid.setTileSelection(m === 'view');
  if (m === 'routes') applyRoute();
  if (m === 'links') {
    enableLayers(['splines', 'paths']);
    mapGrid.setLinkMode(true);
    renderLinkPanel();
  }
  if (m === 'links' || m === 'splines') void refreshUndoState();
  if (m === 'splines') {
    enableLayers(['splines']);
    mapGrid.setSplineMode(true);
    paintSpl();
  }
}

// --- łączenia ścieżek ----------------------------------------------------------------

let linkA: LinkEnd | null = null;
let linkB: LinkEnd | null = null;
let linkPlan: LinkPlan | null = null;
let linkHover: LinkNode | null = null;
let linkReverse = false;
let linkReverseTouched = false;
let linkOnlyNodes = true;
let linkMsg = '';
let linkBusy = false;
let linkPanel: HTMLElement;
/** Dowolne punkty, których wysokość/nachylenie/skew użytkownik już zmienił ręcznie (nie nadpisujemy ich z węzła). */
const freeTouched = new WeakSet<LinkEnd>();

const isFree = (e: LinkEnd): e is LinkFreePoint => 'free' in e;
const endRef = (e: LinkEnd): LinkEndRef => (isFree(e) ? e : { splineId: e.splineId, pathIndex: e.pathIndex, end: e.end, tile: e.tile });
const sameEnd = (a: LinkEnd, b: LinkEnd): boolean => (isFree(a) || isFree(b) ? a === b : a.splineId === b.splineId && a.pathIndex === b.pathIndex && a.end === b.end);
const endLabel = (e: LinkEnd | null): string => (!e ? '?' : isFree(e) ? 'punkt' : `${e.splineId}`);

function paintLink(): void {
  mapGrid.setLinkOverlay({ a: linkA, b: linkB, hover: linkHover, preview: linkPlan && !linkPlan.error ? linkPlan.preview : [], reverse: linkReverse });
  renderLinkPanel();
}

/** Czyści wybór końców; `leave` = wychodzimy z trybu (wyłącz też obsługę kliknięć mapy). */
function resetLinkKeepMsg(): void {
  linkA = linkB = linkPlan = linkHover = null;
  linkReverse = linkReverseTouched = false;
}

function resetLink(leave = false): void {
  linkA = linkB = linkPlan = linkHover = null;
  linkReverse = linkReverseTouched = false;
  linkMsg = '';
  if (leave) {
    mapGrid.setLinkMode(false);
    if (linkPanel) linkPanel.hidden = true;
  } else {
    paintLink();
  }
}

/** Przelicza plan łączenia po zmianie końców; dla niewprowadzonych ręcznie punktów bierze wysokość i skew z węzła po drugiej stronie. */
async function replanLink(): Promise<void> {
  if (linkA && linkB) {
    for (const [e, other] of [[linkA, linkB], [linkB, linkA]] as const) {
      if (isFree(e) && !isFree(other) && !freeTouched.has(e)) {
        e.height = other.height;
        e.skew = other.skew;
      }
    }
    linkPlan = await ve.planLink(endRef(linkA), endRef(linkB));
    if (!linkReverseTouched) linkReverse = linkPlan.suggestReverse;
  } else {
    linkPlan = null;
  }
  paintLink();
}

async function onLinkMapClick(c: { x: number; y: number; maxDistM: number; ctrl: boolean }): Promise<void> {
  if (linkBusy) return;
  linkMsg = '';
  // węzły: zawsze, gdy włączone „Łącz tylko węzły”; w trybie dowolnych punktów tylko z Ctrl (przyciąganie do węzła)
  let end: LinkEnd | null = null;
  if (linkOnlyNodes || c.ctrl) end = await ve.pickLinkNode(c.x, c.y, c.maxDistM);
  if (!end && linkOnlyNodes) {
    linkMsg = 'W tym miejscu nie ma końca ścieżki ruchu — przybliż mapę i kliknij bliżej końca splinu albo wyłącz „Łącz tylko węzły”.';
    paintLink();
    return;
  }
  if (!end) {
    const other = linkA && !linkB ? linkA : null;
    end = { free: true, x: Math.round(c.x * 1e5) / 1e5, y: Math.round(c.y * 1e5) / 1e5, height: other ? other.height : 0, pitch: 0, skew: other ? other.skew : 0 };
  }
  if (!linkA || linkB) {
    linkA = end;
    linkB = null;
    linkPlan = null;
    paintLink();
  } else if (sameEnd(end, linkA)) {
    return;
  } else {
    linkB = end;
    await replanLink();
  }
}

let linkHoverBusy = false;
let linkHoverLatest: { x: number; y: number; maxDistM: number; ctrl: boolean } | null | undefined;
function onLinkMapHover(c: { x: number; y: number; maxDistM: number; ctrl: boolean } | null): void {
  linkHoverLatest = c;
  if (!linkHoverBusy) void runLinkHover();
}
async function runLinkHover(): Promise<void> {
  linkHoverBusy = true;
  try {
    while (linkHoverLatest !== undefined) {
      const c = linkHoverLatest;
      linkHoverLatest = undefined;
      const n = c && mapMode === 'links' && (linkOnlyNodes || c.ctrl) ? await ve.pickLinkNode(c.x, c.y, c.maxDistM) : null;
      if ((n === null) !== (linkHover === null) || (n && linkHover && !sameEnd(n, linkHover))) {
        linkHover = n;
        mapGrid.setLinkOverlay({ a: linkA, b: linkB, hover: linkHover, preview: linkPlan && !linkPlan.error ? linkPlan.preview : [], reverse: linkReverse });
      }
    }
  } finally {
    linkHoverBusy = false;
  }
}

async function createLinkNow(): Promise<void> {
  if (!linkA || !linkB || !linkPlan || linkPlan.error) return;
  linkBusy = true;
  const res = await ve.createLink(endRef(linkA), endRef(linkB), linkReverse);
  linkBusy = false;
  if (!res.ok) {
    linkMsg = res.error ?? 'Nie udało się utworzyć łączenia.';
    paintLink();
    return;
  }
  const ids = res.ids ?? [];
  resetLink();
  void refreshUndoState();
  linkMsg = `Utworzono ${ids.length === 1 ? 'spline' : 'spliny'} ${ids.join(', ')}. Przeskanuj mapę, aby pojawiły się w warstwie Spliny (węzły są już dostępne do kolejnych łączeń).`;
  paintLink();
}

function endBlock(label: string, e: LinkEnd | null): HTMLElement {
  if (!e) return h('div', { class: 'lk-node empty' }, `${label}: kliknij ${linkOnlyNodes ? 'węzeł' : 'punkt albo Ctrl+klik węzeł'} na mapie`);
  const row = (k: string, v: string): HTMLElement => h('div', {}, h('span', { class: 'lk-k' }, `${k}: `), v);
  if (isFree(e)) {
    const num = (k: string, unit: string, get: () => number, set: (v: number) => void): HTMLElement => {
      const inp = h('input', { type: 'number', step: '0.1', class: 'lk-num' }) as HTMLInputElement;
      inp.value = String(Math.round(get() * 1000) / 1000);
      inp.addEventListener('change', () => {
        const v = Number(inp.value);
        if (!Number.isFinite(v)) return;
        set(v);
        freeTouched.add(e);
        void replanLink();
      });
      return h('label', { class: 'lk-field' }, h('span', { class: 'lk-k' }, `${k}: `), inp, ` ${unit}`);
    };
    return h(
      'div',
      { class: 'lk-node' },
      h('b', {}, `${label} · dowolny punkt`),
      row('Położenie (jedn. kafli)', `${e.x.toFixed(4)}, ${e.y.toFixed(4)}`),
      num('Wysokość ścieżki', 'm', () => e.height, (v) => (e.height = v)),
      num('Nachylenie od podłoża', '°', () => e.pitch, (v) => (e.pitch = v)),
      num('Skew', '', () => e.skew, (v) => (e.skew = v)),
      row('Azymut', 'wynika z łuku (styczna do węzła po drugiej stronie)'),
    );
  }
  return h(
    'div',
    { class: 'lk-node' },
    h('b', {}, `${label} · spline ${e.splineId}`),
    row('Koniec splinu', `${e.end === 'start' ? 'początek' : 'koniec'} · ścieżka #${e.pathIndex}`),
    row('Wysokość', `${e.height.toFixed(3)} m (oś ${e.axisHeight.toFixed(3)} + ścieżka ${e.pathHeight.toFixed(3)})`),
    row('Nachylenie od podłoża', `${e.pitch.toFixed(3)}°`),
    row('Skew', `${e.skew.toFixed(3)}`),
    row('Azymut splinu', `${e.heading.toFixed(2)}°`),
    row('Przesunięcie od osi', `${e.lateral.toFixed(2)} m`),
    row('Ruch', e.exits ? 'pojazdy opuszczają spline w tym końcu' : 'pojazdy wjeżdżają w spline w tym końcu'),
    row('Przyłączenie', e.linked === '0' ? 'wolny koniec' : `połączony ze splinem ${e.linked}`),
    row('Spline', `${e.kind === 'spline_h' ? '[spline_h] z wysokością' : '[spline] płaski'}, ${e.tileFile}`),
  );
}

function renderLinkPanel(): void {
  if (!linkPanel) return;
  const keep = linkPanel.querySelector('.lk-body')?.scrollTop ?? 0;
  clear(linkPanel);
  linkPanel.hidden = mapMode !== 'links';
  if (linkPanel.hidden) return;
  const p = linkPlan;
  const body = h('div', { class: 'lk-body' }, endBlock('Koniec A', linkA), endBlock('Koniec B', linkB));
  if (p?.error) body.append(h('div', { class: 'lk-err' }, `⚠ ${p.error}`));
  else if (p && p.from && p.to) {
    const fmt = (n: number): string => n.toFixed(2);
    body.append(
      h(
        'div',
        { class: 'lk-node plan' },
        h('b', {}, `Łączenie ${endLabel(p.from)} → ${endLabel(p.to)}`),
        h('div', {}, `Długość ${fmt(p.length)} m · różnica wysokości ${p.dz >= 0 ? '+' : ''}${p.dz.toFixed(3)} m · ${p.splines.length === 1 ? '1 spline' : `${p.splines.length} spliny (dwa łuki)`}`),
        ...p.splines.map((s, i) => h('div', { class: 'lk-meta' }, `${i + 1}. ${fmt(s.length)} m, ${s.radius === 0 ? 'prosta' : `R ${fmt(s.radius)} m`}, nachylenie ${s.pitch0.toFixed(2)}° → ${s.pitch1.toFixed(2)}°, Δh ${s.dz.toFixed(3)} m, skew ${s.skew0.toFixed(2)} → ${s.skew1.toFixed(2)}`)),
        ...p.warnings.map((w) => h('div', { class: 'lk-warn' }, `⚠ ${w}`)),
      ),
    );
  }
  if (linkMsg) body.append(h('div', { class: /^(Utworzono|Cofnięto|Ponowiono)/.test(linkMsg) ? 'lk-ok' : 'lk-err' }, linkMsg));
  const rev = h('input', { type: 'checkbox' }) as HTMLInputElement;
  rev.checked = linkReverse;
  rev.addEventListener('change', () => {
    linkReverse = rev.checked;
    linkReverseTouched = true;
    paintLink();
  });
  const only = h('input', { type: 'checkbox' }) as HTMLInputElement;
  only.checked = linkOnlyNodes;
  only.addEventListener('change', () => {
    linkOnlyNodes = only.checked;
    linkHover = null;
    paintLink();
  });
  const ready = !!p && !p.error && !!p.from && !linkBusy;
  linkPanel.append(
    h('div', { class: 'rt-title' }, '🔗 Łączenie ścieżek'),
    undoRow(),
    h('div', { class: 'rt-foot' }, 'Kliknij pierwszy, potem drugi koniec łączenia. Co najmniej jeden musi być węzłem (końcem ścieżki); łączenie powstaje ze splinu invis_street.sli, dopasowane do końców (wysokość, nachylenie od podłoża, skew, azymut).'),
    h('label', { class: 'lk-check', title: 'Gdy wyłączone, można wskazać dowolny punkt mapy; klawisz Ctrl przy kliknięciu przyciąga do najbliższego węzła' }, only, ' Łącz tylko węzły'),
    body,
    h(
      'label',
      { class: 'lk-check', title: 'Odbija nowe spliny (mirror), co odwraca kierunek ruchu na ich ścieżce' },
      rev,
      ' Odwróć kierunek ścieżki',
      p && !p.error && p.suggestReverse !== linkReverse ? h('span', { class: 'lk-warn' }, p.suggestReverse ? ' (przyłączone ścieżki sugerują odwrócenie)' : ' (przyłączone ścieżki sugerują zostawienie)') : h('span'),
    ),
    h(
      'div',
      { class: 'rt-buttons' },
      routeButton('✔ Utwórz łączenie', 'Dopisz spliny łączące do kafla (kopia .map.bak) i przyłącz je do wolnych końców', () => void createLinkNow(), !ready, 'btn primary'),
      routeButton('Wyczyść wybór', 'Zacznij od nowa', () => resetLink()),
      linkMsg.startsWith('Utworzono') ? routeButton('Przeskanuj mapę', 'Odśwież warstwę splinów', () => rescanBtn.click()) : h('span'),
    ),
  );
  const nb = linkPanel.querySelector('.lk-body');
  if (nb) nb.scrollTop = keep;
}

// --- edycja splinów -------------------------------------------------------------------

type SplOp =
  | { kind: 'grab'; x0: number; y0: number; dx: number; dy: number; axis: 'x' | 'y' | null; snap: { x: number; y: number } | null; ref0: { x: number; y: number } }
  | { kind: 'box'; ax: number | null; ay: number | null; bx: number; by: number }
  | { kind: 'z'; py0: number; dz: number; typed: string }
  | { kind: 'new'; from: SplinePoint | null; sx: number; sy: number; ex: number; ey: number };

let splSel: SplinePoint[] = [];
let splData: EditSpline[] = [];
let splOp: SplOp | null = null;
let splMouse = { x: 0, y: 0, py: 0, known: false };
let splHover: SplinePoint | null = null;
let splMsg = '';
let splSli = 'Splines/invis_street.sli';
/** Łuk włączony (domyślnie): przesuwany koniec zagina spline; wyłączony: spline pozostaje prostą i obraca się (przełącznik: Alt). */
let splArc = true;
const normSli = (p: string): string => p.replace(/\\/g, '/');
let splStartZ = 0;
let splPanel: HTMLElement;
let splIssues: SplineIssue[] | null = null;
let splUndo: { undo: string | null; redo: string | null } = { undo: null, redo: null };

const splRef = (p: SplinePointRef): SplinePointRef => ({ splineId: p.splineId, end: p.end, tile: p.tile });
const splKey = (p: SplinePointRef): string => `${p.tile}:${p.splineId}:${p.end}`;
const splDz = (): number => {
  const o = splOp;
  if (!o || o.kind !== 'z') return 0;
  if (o.typed) {
    const v = Number(o.typed.replace(',', '.'));
    return Number.isFinite(v) ? v : 0;
  }
  return o.dz;
};
const lineOf = (s: { x: number; y: number; heading: number; radius: number; length: number }): number[] =>
  arcPoints(s.x, s.y, s.heading, s.radius, s.length, 0).flatMap((q) => [q[0] / 300, q[1] / 300]);

/** Spliny zaznaczonych końców po zastosowaniu bieżącej operacji (podgląd); błąd, gdy przesunięcie jest niemożliwe. */
function splPreview(): { splines: EditSpline[]; error?: string } {
  const sel = splSel.map(splRef);
  if (splOp?.kind === 'grab') return moveSplines(splData, sel, splOp.dx * 300, splOp.dy * 300, 0, splArc);
  if (splOp?.kind === 'z') return moveSplines(splData, sel, 0, 0, splDz());
  return { splines: [] };
}

function splPointFrom(splines: EditSpline[], p: SplinePoint): SplinePoint {
  const s = splines.find((x) => x.id === p.splineId);
  if (!s) return p;
  const pose = splineEndPose(s, p.end);
  return { ...p, x: pose.x / 300, y: pose.y / 300, z: splineEndZ(s, p.end), heading: pose.heading, pitch: p.end === 'start' ? s.pitch0 : s.pitch1, linked: p.end === 'start' ? s.prev : s.next };
}

function splNewStart(op: Extract<SplOp, { kind: 'new' }>): NewSplineStart {
  const s = op.from ? splData.find((x) => x.id === op.from!.splineId) : undefined;
  return s && op.from ? newSplineStartAt(s, op.from.end) : { x: op.sx * 300, y: op.sy * 300, z: splStartZ };
}

function paintSpl(): void {
  const pv = splOp && (splOp.kind === 'grab' || splOp.kind === 'z') ? splPreview() : null;
  const changed = pv && !pv.error ? pv.splines : [];
  const state = splData.map((s) => changed.find((c) => c.id === s.id) ?? s);
  const selected = splSel.map((p) => {
    const s = state.find((x) => x.id === p.splineId);
    const pose = s ? splineEndPose(s, p.end) : null;
    return pose ? { x: pose.x / 300, y: pose.y / 300 } : { x: p.x, y: p.y };
  });
  const preview = changed.map(lineOf);
  const labels = new Map<string, { x: number; y: number; zs: string[]; bold: boolean }>();
  const addLabel = (x: number, y: number, z: number, bold: boolean): void => {
    const key = `${Math.round(x * 100)},${Math.round(y * 100)}`;
    const e = labels.get(key) ?? { x: x / 300, y: y / 300, zs: [], bold: false };
    const t = z.toFixed(3);
    if (!e.zs.includes(t)) e.zs.push(t);
    e.bold = e.bold || bold;
    labels.set(key, e);
  };
  for (const s of state) {
    for (const end of ['start', 'end'] as const) {
      const pose = splineEndPose(s, end);
      addLabel(pose.x, pose.y, splineEndZ(s, end), splSel.some((p) => p.splineId === s.id && p.end === end));
    }
  }
  let planned: NewSplineGeom | string | null = null;
  if (splOp?.kind === 'new') {
    planned = newSpline(splNewStart(splOp), splOp.ex * 300, splOp.ey * 300, splArc);
    if (typeof planned !== 'string') {
      preview.push(lineOf(planned));
      addLabel(planned.x, planned.y, planned.z, true);
      const e = arcEnd({ x: planned.x, y: planned.y, heading: planned.heading, length: planned.length, radius: planned.radius });
      addLabel(e.x, e.y, planned.z + planned.dz, true);
    }
  }
  mapGrid.setSplineOverlay({
    selected,
    box: splOp?.kind === 'box' && splOp.ax !== null && splOp.ay !== null ? { x0: splOp.ax, y0: splOp.ay, x1: splOp.bx, y1: splOp.by } : null,
    snap: splOp?.kind === 'grab' ? splOp.snap : null,
    hover: splHover && !splOp ? { x: splHover.x, y: splHover.y } : null,
    preview,
    labels: [...labels.values()].map((l) => ({ x: l.x, y: l.y, text: `Z ${l.zs.join(' / ')}`, bold: l.bold })),
  });
  renderSplPanel(state, pv?.error, planned);
}

function resetSpl(leave = false): void {
  splSel = [];
  splData = [];
  splOp = null;
  splHover = null;
  splMsg = '';
  if (leave) {
    mapGrid.setSplineMode(false);
    if (splPanel) splPanel.hidden = true;
  } else {
    paintSpl();
  }
}

function splBegin(kind: 'grab' | 'z' | 'new' | 'box'): void {
  if (splOp) return;
  splMsg = '';
  if (!splMouse.known) {
    splMsg = 'Najpierw najedź kursorem na mapę, potem naciśnij klawisz.';
    return paintSpl();
  }
  if (kind === 'box') {
    splOp = { kind: 'box', ax: null, ay: null, bx: splMouse.x, by: splMouse.y };
    return paintSpl();
  }
  if (kind === 'new') {
    if (splSel.length > 1) {
      splMsg = 'Nowy spline: zaznacz jeden koniec splinu albo żaden (wtedy zaczyna się w miejscu kursora).';
      return paintSpl();
    }
    splOp = { kind: 'new', from: splSel[0] ?? null, sx: splMouse.x, sy: splMouse.y, ex: splMouse.x, ey: splMouse.y };
  } else {
    if (splSel.length === 0) {
      splMsg = 'Najpierw zaznacz końce splinów: klik, Shift — dodaj lub odznacz.';
      return paintSpl();
    }
    splOp = kind === 'grab' ? { kind: 'grab', x0: splMouse.x, y0: splMouse.y, dx: 0, dy: 0, axis: null, snap: null, ref0: { x: splSel[0].x, y: splSel[0].y } } : { kind: 'z', py0: splMouse.py, dz: 0, typed: '' };
  }
  paintSpl();
}

function splCancel(): void {
  splOp = null;
  splMsg = '';
  paintSpl();
}

async function splConfirm(): Promise<void> {
  const op = splOp;
  if (!op || op.kind === 'box') return;
  const refs = splSel.map(splRef);
  let res: { ok: boolean; error?: string; id?: string; tiles?: number[] };
  if (op.kind === 'new') {
    res = await ve.createSpline({ from: op.from ? splRef(op.from) : null, startX: op.sx, startY: op.sy, startZ: splStartZ, endX: op.ex, endY: op.ey, sli: splSli, arc: splArc });
  } else {
    const pv = splPreview();
    if (pv.error) {
      splMsg = pv.error;
      return paintSpl();
    }
    res = op.kind === 'grab' ? await ve.applySplineEdit(refs, op.dx * 300, op.dy * 300, 0, splArc) : await ve.applySplineEdit(refs, 0, 0, splDz(), true);
  }
  splOp = null;
  if (!res.ok) {
    splMsg = res.error ?? 'Nie udało się zapisać zmiany.';
    return paintSpl();
  }
  if (op.kind === 'new' && res.id) {
    // po utworzeniu zaznaczamy koniec nowego splinu — można od razu ciągnąć dalej (N)
    const tile = res.tiles?.[0] ?? 0;
    const created = await ve.loadEditSplines([{ splineId: res.id, end: 'end', tile }]);
    splData = created;
    splSel = created.length ? [splPointFrom(created, { splineId: res.id, end: 'end', tile, x: 0, y: 0, z: 0, heading: 0, pitch: 0, linked: '0', path: splSli })] : [];
    splMsg = `Utworzono spline ${res.id}.`;
    if (created[0]) splSli = normSli(created[0].path);
  } else {
    splData = await ve.loadEditSplines(refs);
    splSel = splSel.map((p) => splPointFrom(splData, p));
    splMsg = op.kind === 'grab' ? 'Przesunięto zaznaczone końce splinów.' : 'Zmieniono wysokość zaznaczonych końców.';
  }
  void refreshUndoState();
  paintSpl();
}

async function onSplClick(c: SplinePointer): Promise<void> {
  if (splOp?.kind === 'box') {
    const op = splOp;
    if (op.ax === null || op.ay === null) {
      op.ax = c.x;
      op.ay = c.y;
      op.bx = c.x;
      op.by = c.y;
      return paintSpl();
    }
    const pts = await ve.pickSplinePointsInBox(op.ax, op.ay, c.x, c.y);
    splOp = null;
    const fresh = pts.filter((p) => !splSel.some((q) => splKey(q) === splKey(p)));
    splSel = c.shift ? [...splSel, ...fresh] : pts;
    splData = splSel.length > 0 ? await ve.loadEditSplines(splSel.map(splRef)) : [];
    splMsg = pts.length === 0 ? 'W prostokącie nie ma końców splinów.' : '';
    if (splSel.length > 0) splSli = normSli(splSel[0].path);
    return paintSpl();
  }
  if (splOp) {
    void splConfirm();
    return;
  }
  const pts = await ve.pickSplinePoints(c.x, c.y, c.maxDistM);
  splMsg = '';
  if (pts.length === 0) {
    if (!c.shift) splSel = [];
  } else if (c.shift) {
    const all = pts.every((p) => splSel.some((q) => splKey(q) === splKey(p)));
    splSel = all ? splSel.filter((q) => !pts.some((p) => splKey(p) === splKey(q))) : [...splSel, ...pts.filter((p) => !splSel.some((q) => splKey(q) === splKey(p)))];
  } else {
    splSel = pts;
  }
  splData = splSel.length > 0 ? await ve.loadEditSplines(splSel.map(splRef)) : [];
  if (splSel.length > 0) splSli = normSli(splSel[0].path); // lista rozwijana pokazuje plik .sli zaznaczonego splinu
  paintSpl();
}

let splHoverBusy = false;
let splHoverLatest: SplinePointer | null | undefined;
function onSplMove(c: SplinePointer | null): void {
  if (!c) {
    splHoverLatest = null;
    if (!splHoverBusy) void runSplHover();
    return;
  }
  splMouse = { x: c.x, y: c.y, py: c.py, known: true };
  const op = splOp;
  if (op) {
    if (op.kind === 'grab') {
      let dx = c.x - op.x0;
      let dy = c.y - op.y0;
      op.snap = null;
      if (c.ctrl) {
        // przyciąganie pierwszego zaznaczonego punktu do najbliższego końca innego splinu
        const n = mapGrid.endpointNear(op.ref0.x + dx, op.ref0.y + dy, c.maxDistM * 1.5, splSel.map((p) => ({ x: p.x, y: p.y })));
        if (n) {
          dx = n.x - op.ref0.x;
          dy = n.y - op.ref0.y;
          op.snap = n;
        }
      }
      if (op.axis === 'x') (dy = 0, (op.snap = null));
      else if (op.axis === 'y') (dx = 0, (op.snap = null));
      op.dx = dx;
      op.dy = dy;
    } else if (op.kind === 'box') {
      op.bx = c.x;
      op.by = c.y;
    } else if (op.kind === 'z') {
      if (!op.typed) op.dz = -(c.py - op.py0) * 0.01 * (c.shift ? 0.1 : c.ctrl ? 10 : 1);
    } else {
      op.ex = c.x;
      op.ey = c.y;
    }
    paintSpl();
    return;
  }
  splHoverLatest = c;
  if (!splHoverBusy) void runSplHover();
}
async function runSplHover(): Promise<void> {
  splHoverBusy = true;
  try {
    while (splHoverLatest !== undefined) {
      const c = splHoverLatest;
      splHoverLatest = undefined;
      const p = c && mapMode === 'splines' && !splOp ? (await ve.pickSplinePoints(c.x, c.y, c.maxDistM))[0] ?? null : null;
      if ((p === null) !== (splHover === null) || (p && splHover && splKey(p) !== splKey(splHover))) {
        splHover = p;
        if (!splOp) paintSpl();
      }
    }
  } finally {
    splHoverBusy = false;
  }
}

/** Odświeża nazwy operacji do cofnięcia i ponowienia (przyciski w panelach). */
async function refreshUndoState(): Promise<void> {
  splUndo = await ve.undoState();
  if (mapMode === 'splines') paintSpl();
  else if (mapMode === 'links') renderLinkPanel();
}

/** Cofa albo ponawia ostatnią zmianę kafli; po niej zaznaczenia i operacje są czyszczone (mogły dotyczyć zmienionych splinów). */
async function mapUndo(redo: boolean): Promise<void> {
  if (splOp) splOp = null;
  const r = redo ? await ve.redoMap() : await ve.undoMap();
  splSel = [];
  splData = [];
  splHover = null;
  splIssues = null;
  const msg = r.ok ? `${redo ? 'Ponowiono' : 'Cofnięto'}: ${r.label ?? ''}.` : (r.error ?? 'Nie udało się.');
  splMsg = msg;
  linkMsg = msg;
  if (mapMode === 'links') resetLinkKeepMsg();
  splUndo = await ve.undoState();
  if (mapMode === 'splines') paintSpl();
  else if (mapMode === 'links') paintLink();
}

function undoRow(): HTMLElement {
  return h(
    'div',
    { class: 'rt-buttons' },
    routeButton('↶ Cofnij', splUndo.undo ? `Cofnij: ${splUndo.undo} (Ctrl+Z)` : 'Nie ma nic do cofnięcia', () => void mapUndo(false), !splUndo.undo),
    routeButton('↷ Ponów', splUndo.redo ? `Ponów: ${splUndo.redo} (Ctrl+Y)` : 'Nie ma nic do ponowienia', () => void mapUndo(true), !splUndo.redo),
    h('span', { class: 'lk-meta' }, splUndo.undo ? `Ostatnio: ${splUndo.undo}` : ''),
  );
}

async function splCheck(): Promise<void> {
  splMsg = 'Sprawdzam spójność splinów…';
  paintSpl();
  splIssues = await ve.checkSplines();
  splMsg = '';
  paintSpl();
}

/** Przechodzi do miejsca połączenia z listy kontroli i zaznacza węzeł. */
async function splGoto(it: SplineIssue): Promise<void> {
  mapGrid.centerOn(it.x, it.y, 1500);
  const pts = await ve.pickSplinePoints(it.x, it.y, 1);
  splSel = pts;
  splData = pts.length > 0 ? await ve.loadEditSplines(pts.map(splRef)) : [];
  splMsg = '';
  if (pts.length > 0) splSli = normSli(pts[0].path);
  paintSpl();
}

async function splAlign(it: SplineIssue): Promise<void> {
  if (!it.b) return;
  const r = await ve.alignSplines(it.a, it.b);
  if (!r.ok) {
    splMsg = r.error ?? 'Nie udało się wyrównać.';
    return paintSpl();
  }
  splIssues = await ve.checkSplines();
  splData = splSel.length > 0 ? await ve.loadEditSplines(splSel.map(splRef)) : [];
  splSel = splSel.map((p) => splPointFrom(splData, p));
  splMsg = 'Zmieniono — wyrównano połączenie (wysokość, nachylenie, skew).';
  await refreshUndoState();
}

/** Usuwa spliny zaznaczonych końców (z ich blokami [rule]) po potwierdzeniu; odnośniki innych splinów do nich są zerowane. */
async function splDelete(): Promise<void> {
  if (splSel.length === 0) {
    splMsg = 'Najpierw zaznacz punkt (koniec splinu), który chcesz usunąć.';
    return paintSpl();
  }
  const ids = [...new Set(splSel.map((p) => p.splineId))];
  const ok = window.confirm(
    `Usunąć ${ids.length === 1 ? 'spline' : `${ids.length} spliny`} ${ids.join(', ')} przypięte do zaznaczonych punktów?\n\nKafel zostanie zapisany z kopią .map.bak. Uwaga: numery elementów na kaflu późniejszych splinów się przesuną, więc wpisy .ttr tras, które z nich korzystają, trzeba potem sprawdzić (pasek informacji w trybie „Trasy kursów” pokaże niezgodności).`,
  );
  if (!ok) return;
  const res = await ve.deleteSplines(splSel.map(splRef));
  if (!res.ok) {
    splMsg = res.error ?? 'Nie udało się usunąć splinów.';
    return paintSpl();
  }
  splSel = [];
  splData = [];
  splHover = null;
  splMsg = `Usunięto ${ids.length === 1 ? 'spline' : 'spliny'} ${ids.join(', ')}.`;
  void refreshUndoState();
  paintSpl();
}

/** Klawisze trybu: G przesuń, Z wysokość, N nowy spline, Enter zatwierdź, Esc anuluj / wyczyść zaznaczenie; w Z cyfry wpisują wartość. */
function onSplKey(e: KeyboardEvent): boolean {
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && !e.altKey && (k === 'z' || k === 'y')) {
    void mapUndo(k === 'y' || e.shiftKey);
    return true;
  }
  if (splOp?.kind === 'grab' && (k === 'x' || k === 'y') && !e.ctrlKey && !e.metaKey && !e.altKey) {
    splOp.axis = splOp.axis === k ? null : (k as 'x' | 'y');
    onSplMove({ x: splMouse.x, y: splMouse.y, px: 0, py: splMouse.py, maxDistM: 0, shift: false, ctrl: false });
    return true;
  }
  if (e.key === 'Alt') {
    if (!e.repeat) {
      splArc = !splArc;
      paintSpl();
    }
    return true;
  }
  if (e.key === 'Delete' && !splOp) {
    void splDelete();
    return true;
  }
  if (splOp?.kind === 'z' && !e.ctrlKey && !e.metaKey && !e.altKey && (/^[0-9.,-]$/.test(e.key) || e.key === 'Backspace')) {
    splOp.typed = e.key === 'Backspace' ? splOp.typed.slice(0, -1) : splOp.typed + e.key;
    paintSpl();
    return true;
  }
  if (k === 'escape') {
    if (splOp) splCancel();
    else {
      splSel = [];
      splData = [];
      splMsg = '';
      paintSpl();
    }
    return true;
  }
  if (k === 'enter' && splOp) {
    void splConfirm();
    return true;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  if (k === 'g') splBegin('grab');
  else if (k === 'z') splBegin('z');
  else if (k === 'n') splBegin('new');
  else if (k === 'b') splBegin('box');
  else return false;
  return true;
}

function renderSplPanel(state: EditSpline[], error: string | undefined, planned: NewSplineGeom | string | null): void {
  if (!splPanel) return;
  const keep = splPanel.querySelector('.lk-body')?.scrollTop ?? 0;
  clear(splPanel);
  splPanel.hidden = mapMode !== 'splines';
  if (splPanel.hidden) return;
  const body = h('div', { class: 'lk-body' });
  const key = (k: string, d: string): HTMLElement => h('div', { class: 'lk-meta' }, h('b', {}, k), ` — ${d}`);
  body.append(
    h(
      'div',
      { class: 'lk-node' },
      key('Klik', 'zaznacz koniec splinu (razem z pokrywającymi się końcami innych splinów); Shift — dodaj lub odznacz'),
      key('B', 'zaznacz prostokątem (dwa kliknięcia w rogi; Shift — dodaj do zaznaczenia)'),
      key('G', 'przesuń zaznaczone końce myszą (X / Y — blokada osi, Ctrl — przyciąganie do końców splinów)'),
      key('Delete', 'usuń zaznaczone punkty wraz z podpiętymi splinami (z potwierdzeniem)'),
      key('Alt', `przełącz łuk / prostą (teraz: ${splArc ? 'łuk — przesuwany koniec zagina spline' : 'prosta — spline się obraca'})`),
      key('Z', 'zmień wysokość: ruch myszą w górę/dół (Shift dokładniej, Ctrl szybciej) albo wpisz liczbę'),
      key('N', 'nowy spline: od zaznaczonego końca (albo od kursora), potem wskaż punkt końcowy'),
      key('Klik / Enter · Esc / prawy przycisk', 'zatwierdź · anuluj'),
      key('Ctrl+Z · Ctrl+Y', 'cofnij · ponów ostatnią zmianę na mapie (spliny i łączenia)'),
    ),
  );
  if (splOp) {
    const op = splOp;
    const txt =
      op.kind === 'box'
        ? op.ax === null
          ? 'Zaznaczanie prostokątem: kliknij pierwszy róg'
          : 'Zaznaczanie prostokątem: kliknij drugi róg (Shift — dodaj do zaznaczenia)'
        : op.kind === 'grab'
        ? `Przesuwanie: Δx ${(op.dx * 300).toFixed(2)} m, Δy ${(op.dy * 300).toFixed(2)} m · oś: ${op.axis ? `tylko ${op.axis.toUpperCase()}` : 'dowolna'}${op.snap ? ' · przyciągnięto do końca splinu' : ''}`
        : op.kind === 'z'
          ? `Wysokość: Δz ${splDz() >= 0 ? '+' : ''}${splDz().toFixed(3)} m${op.typed ? ` (wpisano „${op.typed}”)` : ''}`
          : typeof planned === 'string'
            ? `Nowy spline: ${planned}`
            : planned
              ? `Nowy spline ${op.from ? `od splinu ${op.from.splineId}` : 'od dowolnego punktu'}: ${planned.length.toFixed(2)} m, ${planned.radius === 0 ? 'prosta' : `R ${planned.radius.toFixed(2)} m`}, Z ${planned.z.toFixed(3)} → ${(planned.z + planned.dz).toFixed(3)}`
              : 'Nowy spline: wskaż punkt końcowy';
    body.append(
      h(
        'div',
        { class: 'lk-node plan' },
        h('b', {}, txt),
        h('div', { class: 'lk-meta' }, op.kind === 'grab' ? 'X / Y — blokada osi · Ctrl — przyciąganie do końców splinów · klik / Enter — zatwierdź · Esc — anuluj' : 'klik / Enter — zatwierdź · Esc / prawy przycisk — anuluj'),
      ),
    );
  }
  if (error) body.append(h('div', { class: 'lk-err' }, `⚠ ${error}`));
  if (splSel.length === 0) body.append(h('div', { class: 'lk-node empty' }, 'Nic nie zaznaczono — kliknij początek (niebieski) lub koniec (pomarańczowy) splinu.'));
  else {
    const rows = state.map((s) => {
      const selS = splSel.some((p) => p.splineId === s.id && p.end === 'start');
      const selE = splSel.some((p) => p.splineId === s.id && p.end === 'end');
      return h(
        'div',
        { class: 'lk-node' },
        h('b', {}, `Spline ${s.id} · ${s.kind === 'spline_h' ? '[spline_h]' : '[spline]'}`),
        h('div', {}, h('span', { class: 'lk-k' }, `${selS ? '●' : '○'} Z początkowe: `), `${s.z.toFixed(3)} m`),
        h('div', {}, h('span', { class: 'lk-k' }, `${selE ? '●' : '○'} Z końcowe: `), `${(s.z + s.dz).toFixed(3)} m`),
        h('div', { class: 'lk-meta' }, `Δz ${s.dz >= 0 ? '+' : ''}${s.dz.toFixed(3)} m · długość ${s.length.toFixed(2)} m · ${s.radius === 0 ? 'prosta' : `R ${s.radius.toFixed(2)} m`} · azymut ${s.heading.toFixed(2)}°`),
      );
    });
    body.append(h('div', { class: 'lk-meta' }, `Zaznaczone końce: ${splSel.length}, spliny: ${state.length} (● zaznaczony koniec)`), ...rows);
  }
  if (splMsg) body.append(h('div', { class: /^(Utworzono|Przesunięto|Zmieniono|Usunięto|Cofnięto|Ponowiono)/.test(splMsg) ? 'lk-ok' : 'lk-err' }, splMsg));
  const sli = h('select', { class: 'lk-text', title: 'Plik .sli nowego splinu; przy zaznaczeniu punktu ustawia się na plik jego splinu' }) as HTMLSelectElement;
  const known = new Map<string, string>();
  for (const p of ['Splines/invis_street.sli', ...(splinesData?.roads ?? []).map((r) => r.p), splSli]) known.set(normSli(p).toLowerCase(), normSli(p));
  for (const p of [...known.values()].sort((x, y) => x.localeCompare(y, 'pl'))) {
    const o = h('option', { value: p, title: p }, p.replace(/^Splines\//i, '')) as HTMLOptionElement;
    o.selected = p.toLowerCase() === normSli(splSli).toLowerCase();
    sli.append(o);
  }
  sli.addEventListener('change', () => {
    splSli = sli.value;
  });
  const z = h('input', { type: 'number', step: '0.1', class: 'lk-num', title: 'Wysokość osi początku nowego splinu, gdy zaczyna się w dowolnym punkcie' }) as HTMLInputElement;
  z.value = String(splStartZ);
  z.addEventListener('change', () => {
    const v = Number(z.value);
    if (Number.isFinite(v)) splStartZ = v;
  });
  z.disabled = splSel.length === 1;
  const active = !!splOp;
  const issuesBox = h('div', { class: 'lk-node' }, h('b', {}, 'Kontrola spójności splinów'));
  issuesBox.append(
    h(
      'div',
      { class: 'rt-buttons' },
      routeButton('🔍 Sprawdź mapę', 'Znajdź przerwy, załamki azymutu i nachylenia, skoki wysokości i niesymetryczne odnośniki w całej mapie', () => void splCheck()),
    ),
  );
  if (splIssues) {
    issuesBox.append(h('div', { class: 'lk-meta' }, splIssues.length === 0 ? 'Brak problemów — połączenia splinów są spójne.' : `Znaleziono ${splIssues.length}${splIssues.length >= 300 ? '+' : ''} problemów (najpoważniejsze na górze):`));
    for (const it of splIssues.slice(0, 80)) {
      issuesBox.append(
        h(
          'div',
          { class: 'lk-issue' },
          h('span', { class: 'lk-meta' }, it.text),
          h('span', { class: 'rt-buttons' }, routeButton('Idź', 'Przejdź do miejsca połączenia i zaznacz węzeł', () => void splGoto(it)), it.fixable ? routeButton('Wyrównaj', 'Ustaw wysokość, nachylenie i skew styku jako średnie z obu stron', () => void splAlign(it)) : h('span')),
        ),
      );
    }
  }
  body.append(issuesBox);
  splPanel.append(
    h('div', { class: 'rt-title' }, '✏️ Edycja splinów'),
    undoRow(),
    body,
    h('label', { class: 'lk-field' }, h('span', { class: 'lk-k' }, 'Spline (.sli): '), sli),
    h('label', { class: 'lk-field' }, h('span', { class: 'lk-k' }, 'Z początku (bez zaznaczonego końca): '), z, ' m'),
    h(
      'div',
      { class: 'rt-buttons' },
      routeButton('G Przesuń', 'Przesuń zaznaczone końce myszą (G)', () => splBegin('grab'), active),
      routeButton('Z Wysokość', 'Zmień wysokość zaznaczonych końców (Z)', () => splBegin('z'), active),
      routeButton('N Nowy spline', 'Utwórz spline od zaznaczonego końca albo od kursora (N)', () => splBegin('new'), active),
      routeButton('Wyczyść', 'Odznacz wszystko (Esc)', () => ((splSel = []), (splData = []), (splMsg = ''), paintSpl()), active),
      routeButton('Del Usuń', 'Usuń zaznaczone punkty wraz z podpiętymi splinami (Delete)', () => void splDelete(), active || splSel.length === 0),
      routeButton(splArc ? '⌒ Łuk (Alt)' : '— Prosta (Alt)', 'Przełącz łuk / prostą: przy prostej przesuwany koniec obraca spline zamiast go zaginać (Alt)', () => ((splArc = !splArc), paintSpl())),
    ),
  );
  const nb = splPanel.querySelector('.lk-body');
  if (nb) nb.scrollTop = keep;
}

function mountMapTab(): void {
  const root = $('view-map');
  clear(root);
  mapGrid = new MapGrid({
    mode: 'info',
    onStopClick: (s) => {
      if (mapMode === 'view') openStopDialog(s);
    },
    onRouteClick: (c) => void onRouteMapClick(c),
    onRouteHover: (c) => onRouteMapHover(c),
    onLinkClick: (c) => void onLinkMapClick(c),
    onLinkHover: (c) => onLinkMapHover(c),
    onSplineClick: (c) => void onSplClick(c),
    onSplineMove: (c) => onSplMove(c),
    onSplineCancel: () => splCancel(),
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
  routeSelect = h('select', { title: 'Pokaż na mapie trasę kursu (plik .ttr obok kursu) wraz z przystankami' });
  routeSelect.addEventListener('change', () => void showTripRoute(routeSelect.value));
  routeInfo = h('span', { class: 'status' });
  editBtn = h('button', { class: 'btn', title: 'Włącz edycję trasy wybranego kursu: klikaj ścieżki ruchu na mapie, aby je dodawać', onClick: () => setRouteEditing(!routeEditing) }, '✏️ Edytuj trasę');
  editBtn.disabled = true;
  routePanel = h('div', { class: 'rt-panel' });
  routePanel.hidden = true;
  linkPanel = h('div', { class: 'rt-panel lk-panel' });
  linkPanel.hidden = true;
  splPanel = h('div', { class: 'rt-panel lk-panel' });
  splPanel.hidden = true;
  mapGrid.el.append(routePanel, linkPanel, splPanel);
  document.addEventListener('keydown', (e) => {
    if (activeTab !== 'map') return;
    const t = e.target as HTMLElement;
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(t.tagName)) return;
    if (mapMode === 'splines') {
      if (onSplKey(e)) e.preventDefault();
      return;
    }
    if (mapMode === 'links' && (e.ctrlKey || e.metaKey) && ['z', 'y'].includes(e.key.toLowerCase())) {
      void mapUndo(e.key.toLowerCase() === 'y' || e.shiftKey);
      e.preventDefault();
      return;
    }
    if (!routeEditing || mapMode !== 'routes') return;
    if (e.key === 'Delete') routeDelete();
    else if (e.ctrlKey && e.key.toLowerCase() === 'z') routeUndoRedo(routeUndo, routeRedo);
    else if (e.ctrlKey && e.key.toLowerCase() === 'y') routeUndoRedo(routeRedo, routeUndo);
    else if (e.ctrlKey && e.key.toLowerCase() === 's' && routeDirty) void routeSave();
    else if (e.key === 'Escape') setRouteEditing(false);
    else return;
    e.preventDefault();
  });
  document.addEventListener('keyup', (e) => {
    // sam Alt nie powinien aktywować menu systemowego w trybie edycji splinów
    if (e.key === 'Alt' && activeTab === 'map' && mapMode === 'splines') e.preventDefault();
  });
  void fillRouteSelect();

  mapMode = 'view';
  modeButtons = {} as Record<MapMode, HTMLButtonElement>;
  modeBars = {} as Record<MapMode, HTMLElement>;
  for (const k of Object.keys(MODE_INFO) as MapMode[]) {
    modeButtons[k] = h('button', { class: `btn${k === mapMode ? ' active' : ''}`, title: MODE_INFO[k].title, onClick: () => setMapMode(k) }, MODE_INFO[k].label);
  }
  modeBars.view = h('div', { class: 'toolbar mode-bar' }, pinBtn, h('span', { class: 'status' }, 'Kliknij przystanek na mapie, aby edytować jego parametry.'));
  modeBars.routes = h('div', { class: 'route-bar mode-bar' }, h('div', { class: 'toolbar' }, h('span', {}, 'Trasa kursu:'), routeSelect, editBtn), routeInfo);
  modeBars.links = h('div', { class: 'toolbar mode-bar' }, h('span', { class: 'status' }, 'Kliknij węzły (końce ścieżek) do połączenia — szczegóły w panelu po prawej.'));
  modeBars.splines = h('div', { class: 'toolbar mode-bar' }, h('span', { class: 'status' }, 'Zaznacz końce splinów: G — przesuń, Z — wysokość, N — nowy spline.'));
  modeBars.routes.hidden = true;
  modeBars.links.hidden = true;
  modeBars.splines.hidden = true;
  root.append(
    h('div', { class: 'toolbar mode-switch' }, modeButtons.view, modeButtons.routes, modeButtons.links, modeButtons.splines),
    modeBars.view,
    modeBars.routes,
    modeBars.links,
    modeBars.splines,
    h(
      'div',
      { class: 'toolbar' },
      h('button', { class: 'btn', onClick: () => mapGrid.fit() }, 'Wycentruj'),
      rescanBtn,
      layerBox('Spliny', 'Rysuj spliny (jezdnie)', 'splines'),
      layerBox('Ścieżki', 'Ścieżki ruchu ze splinów (po przeskanowaniu mapy)', 'paths'),
      layerBox('Przystanki', 'Przystanki (obiekty z [busstop]); najedź, by zobaczyć nazwę, kliknij, by edytować', 'stops'),
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
  updateStatusBar();
  mapGrid.setBusy(mapBusy);
  mapGrid.setData(overview);
  splinesData = await ve.getMapSplines();
  mapGrid.setSplines(splinesData);
  mapGrid.setStops(await ve.getMapStops());
  mapGrid.setObjPaths(await ve.getMapObjPaths());
  await applyMapSettings();
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
  /** Wartości z global.cfg wczytane do pól — punkt odniesienia do wykrywania zmian. */
  let mapBaseline = { name: '', friendlyname: '', description: '' };
  let updateDirty = (): void => {};

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
  const splineWidthInput = h('input', { type: 'text', value: cur.splineMaxWidth > 0 ? String(cur.splineMaxWidth) : '', placeholder: 'bez limitu' });
  const parseSplineWidth = (): number => Number(splineWidthInput.value.trim().replace(',', '.')) || 0;
  const autoSendCheck = h('input', { type: 'checkbox', checked: cur.claudeAutoSend });
  const error = h('div', { class: 'error' });

  const fillMapFields = (): void => {
    const m = maps.find((x) => x.folder === mapSelect.value);
    nameInput.value = m?.name ?? '';
    friendlyInput.value = m?.friendlyname ?? '';
    descInput.value = m?.description ?? '';
    mapBaseline = { name: nameInput.value, friendlyname: friendlyInput.value, description: descInput.value };
    updateDirty();
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

  // Ustawienia podzielone na karty; karta ze zmianami ma kropkę, a przy zatwierdzaniu
  // główny proces łączy się z repo tylko wtedy, gdy zmieniło się coś, czego to dotyczy.
  type SettingsTab = 'general' | 'repo' | 'display' | 'claude';
  const sections: { id: SettingsTab; label: string; changed: () => boolean }[] = [
    {
      id: 'general',
      label: 'Foldery i mapa',
      changed: () =>
        omsiDir !== cur.omsiDir ||
        workDir !== cur.workDir ||
        mapSelect.value !== cur.mapFolder ||
        nameInput.value !== mapBaseline.name ||
        friendlyInput.value !== mapBaseline.friendlyname ||
        descInput.value !== mapBaseline.description,
    },
    {
      id: 'repo',
      label: 'Repozytorium',
      changed: () => remoteInput.value.trim() !== cur.remoteUrl || mainCheck.checked !== cur.workOnMain,
    },
    { id: 'display', label: 'Wyświetlanie', changed: () => parseSplineWidth() !== cur.splineMaxWidth },
    {
      id: 'claude',
      label: 'Claude',
      changed: () =>
        (modeFree.checked ? 'free' : 'code') !== (cur.claudeMode === 'free' ? 'free' : 'code') ||
        claudeInput.value.trim() !== cur.claudePath ||
        chatInput.value.trim() !== cur.claudeChatUrl ||
        autoSendCheck.checked !== cur.claudeAutoSend,
    },
  ];

  const folderRow = (title: string, input: HTMLInputElement, pick: () => Promise<void>, extra?: HTMLElement): HTMLElement =>
    h(
      'div',
      { class: 'field' },
      h('label', {}, title),
      h('div', { class: 'row' }, input, h('button', { class: 'btn', onClick: () => void pick() }, 'Przeglądaj')),
      extra,
    );

  const panels: Record<SettingsTab, HTMLElement> = {
    general: h(
      'div',
      { class: 'dlg-panel' },
      folderRow('Folder z grą OMSI (na potrzeby assetów)', omsiInput, async () => {
        const p = await ve.pickFolder('Wskaż folder z grą OMSI');
        if (p) {
          omsiDir = p;
          omsiInput.value = p;
          updateDirty();
        }
      }),
      folderRow(
        'Folder roboczy (zawiera folder mapy)',
        workInput,
        async () => {
          const p = await ve.pickFolder('Wskaż folder roboczy');
          if (p) {
            await loadWorkDir(p, mapSelect.value);
            updateDirty();
          }
        },
        workError,
      ),
      h('hr', { class: 'sep' }),
      mapField,
      h('div', { class: 'field' }, h('label', {}, 'Nazwa (global.cfg → [name])'), nameInput),
      h('div', { class: 'field' }, h('label', {}, 'Friendlyname (global.cfg → [friendlyname])'), friendlyInput),
      h('div', { class: 'field' }, h('label', {}, 'Opis (global.cfg → [description])'), descInput),
    ),
    repo: h(
      'div',
      { class: 'dlg-panel' },
      h('div', { class: 'field' }, h('label', {}, 'Link do repozytorium na GitHubie'), remoteInput),
      h('label', { class: 'check' }, mainCheck, 'Pracuj na main (zamiast gałęzi „VibeEditor”)'),
      h(
        'div',
        { class: 'hint' },
        'Link, gałąź i folder roboczy są jedynymi ustawieniami, które ponownie podpinają folder pod repozytorium. ' +
          'Zmiana samego global.cfg kończy się commitem i pushem, a pozostałe karty w ogóle nie dotykają Gita.',
      ),
    ),
    display: h(
      'div',
      { class: 'dlg-panel' },
      h(
        'div',
        { class: 'field' },
        h('label', {}, 'Mapa: wyświetlaj spliny nie szersze niż (m)'),
        splineWidthInput,
        h('div', { class: 'hint' }, 'Szersze spliny (np. podłoże, tereny) nie będą rysowane na mapie. Puste lub 0 = bez limitu.'),
      ),
    ),
    claude: h(
      'div',
      { class: 'dlg-panel' },
      h(
        'div',
        { class: 'field' },
        h('label', {}, 'Claude'),
        h('label', { class: 'check' }, modeCode, 'Claude Code'),
        h('label', { class: 'check' }, modeFree, 'Claude Free'),
      ),
      codePanel,
      freePanel,
    ),
  };

  const tabButtons = new Map<SettingsTab, HTMLButtonElement>();
  const dirtyNote = h('div', { class: 'hint dlg-dirty' });
  const tabsBar = h('div', { class: 'dlg-tabs' });
  const showSettingsTab = (id: SettingsTab): void => {
    for (const sec of sections) {
      panels[sec.id].hidden = sec.id !== id;
      tabButtons.get(sec.id)?.classList.toggle('active', sec.id === id);
    }
  };
  for (const sec of sections) {
    const btn = h('button', { class: 'tab', type: 'button', onClick: () => showSettingsTab(sec.id) }, sec.label);
    tabButtons.set(sec.id, btn);
    tabsBar.append(btn);
  }
  updateDirty = (): void => {
    const names: string[] = [];
    for (const sec of sections) {
      const on = sec.changed();
      tabButtons.get(sec.id)?.classList.toggle('changed', on);
      if (on) names.push(sec.label);
    }
    dirtyNote.textContent = names.length ? `Zmienione: ${names.join(', ')}` : 'Brak zmian.';
  };

  const body = h(
    'div',
    { class: 'dialog' },
    h('h2', {}, forced ? 'Konfiguracja VibeEditor' : 'Ustawienia'),
    tabsBar,
    h('div', { class: 'dlg-panels' }, panels.general, panels.repo, panels.display, panels.claude),
    dirtyNote,
    error,
  );
  body.addEventListener('input', updateDirty);
  body.addEventListener('change', updateDirty);
  showSettingsTab('general');
  updateDirty();
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
      splineMaxWidth: parseSplineWidth(),
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
    await applyMapSettings();
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
  timetableView = new TimetableView($('view-lines'), {
    load: () => ve.loadTimetable(),
    saveLine: (l) => ve.saveLine(l),
    saveTrip: (t) => ve.saveTrip(t),
    showRoute: (file) => void openTripRouteOnMap(file),
  });
  renderConsole();

  document.addEventListener('click', () => {
    document.querySelectorAll<HTMLElement>('.menu').forEach((m) => (m.hidden = true));
  });
  $('settings-btn').addEventListener('click', () => void openSettings(false));

  ve.onConsoleLine(appendConsole);
  ve.onRunState((s) => {
    run = s;
    renderTasks();
    updateStatusBar();
  });
  const maxBtn = $('win-max');
  $('win-min').addEventListener('click', () => void ve.windowControl('minimize'));
  maxBtn.addEventListener('click', () => void ve.windowControl('maximize'));
  $('win-close').addEventListener('click', () => void ve.windowControl('close'));
  $('win-max').parentElement?.parentElement?.addEventListener('dblclick', (e) => {
    if (!(e.target as HTMLElement).closest('.wbtn')) void ve.windowControl('maximize');
  });
  const setMax = (m: boolean): void => {
    maxBtn.classList.toggle('restored', m);
    maxBtn.title = m ? 'Przywróć' : 'Maksymalizuj';
  };
  ve.onWindowState(setMax);
  setMax(await ve.isWindowMaximized());
  ve.onTasksChanged(() => void refreshTasks());
  ve.onOpenSettings(() => void openSettings(false));
  ve.onMapChanged(() => void refreshMap());

  consoleLines = await ve.getConsoleHistory();
  fillConsole();
  run = await ve.getRunState();
  await refreshTasks();
  await refreshMap();
  updateStatusBar();

  const settings = await ve.getSettings();
  if (!settings.configured) await openSettings(true);
}

void init();
