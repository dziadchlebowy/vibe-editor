import type { MapCatalog, ObjectView, RoadView, TaskAttachment } from '../shared/types.ts';
import { clear, h } from './dom.ts';

const MAX_LIST_ROWS = 3000;

export interface AssetViewActions {
  /** Dwuklik na jezdnię/obiekt: nowe zadanie z od razu podpiętym załącznikiem. */
  createTask: (a: TaskAttachment) => void;
}

// --- węzły drzewa obiektów --------------------------------------------------

export interface TreeNode {
  name: string;
  folders: Map<string, TreeNode>;
  objects: ObjectView[];
  /** Liczba obiektów w całej gałęzi. */
  total: number;
}

const newNode = (name: string): TreeNode => ({ name, folders: new Map(), objects: [], total: 0 });

/** Buduje drzewo „folderów” z ścieżek grup ([groups]); obiekty bez grup leżą w korzeniu. */
export function buildObjectTree(objects: ObjectView[]): TreeNode {
  const root = newNode('');
  for (const o of objects) {
    let node = root;
    node.total++;
    for (const g of o.groups) {
      let child = node.folders.get(g.toLowerCase());
      if (!child) {
        child = newNode(g);
        node.folders.set(g.toLowerCase(), child);
      }
      node = child;
      node.total++;
    }
    node.objects.push(o);
  }
  return root;
}

const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name, 'pl');

function matches(text: string, q: string): boolean {
  return text.toLowerCase().includes(q);
}

// --- Jezdnie -----------------------------------------------------------------

export class RoadsView {
  private roads: RoadView[] = [];
  private list = h('div', { class: 'asset-list' });
  private count = h('span', { class: 'status' });
  private search = h('input', { type: 'text', placeholder: 'Szukaj jezdni po ścieżce…' });
  private actions: AssetViewActions;

  constructor(root: HTMLElement, actions: AssetViewActions) {
    this.actions = actions;
    clear(root);
    this.search.addEventListener('input', () => this.render());
    root.append(h('div', { class: 'toolbar' }, this.search, h('div', { class: 'spacer' }), this.count), this.list);
    this.render();
  }

  setCatalog(c: MapCatalog): void {
    this.roads = [...c.roads].sort((a, b) => a.path.localeCompare(b.path, 'pl'));
    this.render();
  }

  private render(): void {
    const q = this.search.value.trim().toLowerCase();
    const all = q ? this.roads.filter((r) => matches(r.path, q)) : this.roads;
    const shown = all.slice(0, MAX_LIST_ROWS);
    clear(this.list);
    if (this.roads.length === 0) {
      this.list.append(h('div', { class: 'empty' }, 'Brak wczytanych jezdni. Przeskanuj mapę w zakładce Mapa i trasy.'));
    } else if (all.length === 0) {
      this.list.append(h('div', { class: 'empty' }, 'Brak wyników.'));
    }
    for (const r of shown) {
      this.list.append(
        h(
          'div',
          {
            class: `asset-row${r.missing ? ' missing' : ''}`,
            title: 'Dwuklik — nowe zadanie z tą jezdnią',
            onDblclick: () => this.actions.createTask({ kind: 'road', path: r.path }),
            onClick: (e: Event) => {
              this.list.querySelector('.asset-row.sel')?.classList.remove('sel');
              (e.currentTarget as HTMLElement).classList.add('sel');
            },
          },
          h('span', { class: 'asset-path' }, `🛣️ ${r.path}`),
          r.missing ? h('span', { class: 'badge bad', title: 'Brak pliku w folderze OMSI' }, 'brak w OMSI') : null,
          h('span', { class: 'badge', title: 'Liczba kafli, na których występuje' }, `kafli: ${r.tileCount}`),
        ),
      );
    }
    this.count.textContent =
      this.roads.length === 0
        ? ''
        : `Jezdni: ${all.length}${q ? ` z ${this.roads.length}` : ''}` +
          (all.length > shown.length ? ` (pokazano ${shown.length} — zawęź filtr)` : '');
  }
}

// --- Obiekty (drzewo) ------------------------------------------------------------

export class ObjectsView {
  private objects: ObjectView[] = [];
  private tree = h('div', { class: 'asset-tree' });
  private count = h('span', { class: 'status' });
  private search = h('input', { type: 'text', placeholder: 'Szukaj obiektu po nazwie lub ścieżce…' });
  private actions: AssetViewActions;

  constructor(root: HTMLElement, actions: AssetViewActions) {
    this.actions = actions;
    clear(root);
    this.search.addEventListener('input', () => this.render());
    root.append(h('div', { class: 'toolbar' }, this.search, h('div', { class: 'spacer' }), this.count), this.tree);
    this.render();
  }

  setCatalog(c: MapCatalog): void {
    this.objects = c.objects;
    this.render();
  }

  private render(): void {
    const q = this.search.value.trim().toLowerCase();
    const list = q ? this.objects.filter((o) => matches(o.name, q) || matches(o.path, q)) : this.objects;
    clear(this.tree);
    if (this.objects.length === 0) {
      this.tree.append(h('div', { class: 'empty' }, 'Brak wczytanych obiektów. Przeskanuj mapę w zakładce Mapa i trasy.'));
    } else if (list.length === 0) {
      this.tree.append(h('div', { class: 'empty' }, 'Brak wyników.'));
    }
    const root = buildObjectTree(list);
    this.renderChildren(root, this.tree, q !== '' && list.length <= 800);
    this.count.textContent = this.objects.length === 0 ? '' : `Obiektów: ${list.length}${q ? ` z ${this.objects.length}` : ''}`;
  }

  /** Foldery renderują zawartość dopiero po rozwinięciu (drzewa bywają ogromne). */
  private renderChildren(node: TreeNode, into: HTMLElement, expand: boolean): void {
    for (const folder of [...node.folders.values()].sort(byName)) {
      const body = h('div', { class: 'tree-children' });
      let filled = false;
      const fill = (): void => {
        if (filled) return;
        filled = true;
        this.renderChildren(folder, body, expand);
      };
      const details = h(
        'details',
        { class: 'tree-folder' },
        h('summary', {}, `📂 ${folder.name} `, h('span', { class: 'badge' }, String(folder.total))),
        body,
      );
      details.addEventListener('toggle', () => details.open && fill());
      if (expand) {
        details.open = true;
        fill();
      }
      into.append(details);
    }
    for (const o of [...node.objects].sort(byName)) {
      into.append(
        h(
          'div',
          {
            class: `asset-row obj${o.missing ? ' missing' : ''}`,
            title: `${o.path}\nDwuklik — nowe zadanie z tym obiektem`,
            onDblclick: () => this.actions.createTask({ kind: 'object', path: o.path, name: o.name }),
            onClick: (e: Event) => {
              this.tree.querySelector('.asset-row.sel')?.classList.remove('sel');
              (e.currentTarget as HTMLElement).classList.add('sel');
            },
          },
          h('span', { class: 'asset-path' }, `🏠 ${o.name}`, h('span', { class: 'asset-sub' }, ` ${o.path}`)),
          o.missing ? h('span', { class: 'badge bad', title: 'Brak pliku w folderze OMSI' }, 'brak w OMSI') : null,
          !o.known && !o.missing ? h('span', { class: 'badge', title: 'Nie udało się odczytać pliku .sco' }, 'bez grup') : null,
          h('span', { class: 'badge', title: 'Liczba kafli, na których występuje' }, `kafli: ${o.tileCount}`),
        ),
      );
    }
  }
}
