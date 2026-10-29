import { formatClock, parseClock } from '../shared/clock.ts';
import type { LineFile, LineTour, TimetableData, TripFile } from '../shared/types.ts';
import { clear, h } from './dom.ts';

type Sel = { kind: 'line' | 'trip'; file: string } | null;

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const numOr = (s: string, fallback: number): number => {
  const v = Number(s.trim().replace(',', '.'));
  return Number.isFinite(v) ? v : fallback;
};

interface TimetableApi {
  load(): Promise<TimetableData>;
  saveLine(l: LineFile): Promise<{ ok: boolean; error?: string }>;
  saveTrip(t: TripFile): Promise<{ ok: boolean; error?: string }>;
}

/** Zakładka „Linie”: edycja linii (.ttl: brygady i godziny odjazdów) oraz kursów (.ttp: czasy przejazdu). */
export class TimetableView {
  private data: TimetableData = { lines: [], trips: [] };
  private sel: Sel = null;
  private line: LineFile | null = null;
  private trip: TripFile | null = null;
  private profileIdx = 0;
  private dirty = false;
  private side = h('div', { class: 'tt-side' });
  private main = h('div', { class: 'tt-main' });
  private filter = h('input', { type: 'text', placeholder: 'Szukaj linii i kursów…' });
  private status = h('span', { class: 'status' });
  private tripNames = h('datalist', { id: 'tt-trips' });

  private api: TimetableApi;

  constructor(root: HTMLElement, api: TimetableApi) {
    this.api = api;
    clear(root);
    this.filter.addEventListener('input', () => this.renderSide());
    root.append(
      h('div', { class: 'tt-layout' }, h('div', { class: 'tt-left' }, this.filter, this.side), this.main),
      this.tripNames,
    );
    this.renderMain();
  }

  async reload(): Promise<void> {
    this.data = await this.api.load();
    this.tripNames.replaceChildren(...this.data.trips.map((t) => h('option', { value: t.name })));
    // odśwież kopię roboczą, jeśli nic nie zmieniono
    if (!this.dirty && this.sel) this.select(this.sel, true);
    else if (this.sel && !this.find(this.sel)) this.sel = null;
    this.renderSide();
    this.renderMain();
  }

  private find(s: NonNullable<Sel>): LineFile | TripFile | undefined {
    return (s.kind === 'line' ? this.data.lines : this.data.trips).find((x) => x.file === s.file);
  }

  private select(s: NonNullable<Sel>, force = false): void {
    if (!force && this.dirty && !window.confirm('Masz niezapisane zmiany. Odrzucić je?')) return;
    const item = this.find(s);
    if (!item) return;
    this.sel = s;
    this.dirty = false;
    this.status.textContent = '';
    this.line = s.kind === 'line' ? clone(item as LineFile) : null;
    this.trip = s.kind === 'trip' ? clone(item as TripFile) : null;
    if (!force) this.profileIdx = 0;
    this.renderSide();
    this.renderMain();
  }

  private markDirty(): void {
    this.dirty = true;
    this.status.textContent = 'Niezapisane zmiany';
    this.status.className = 'status warn';
  }

  // --- lista ---------------------------------------------------------------

  private renderSide(): void {
    clear(this.side);
    const q = this.filter.value.trim().toLowerCase();
    const ok = (n: string): boolean => !q || n.toLowerCase().includes(q);
    const group = (title: string, items: { kind: 'line' | 'trip'; file: string; name: string; info: string }[]): void => {
      this.side.append(h('div', { class: 'tt-group' }, `${title} (${items.length})`));
      for (const it of items) {
        const active = this.sel?.kind === it.kind && this.sel.file === it.file;
        this.side.append(
          h(
            'button',
            { class: `tt-item${active ? ' active' : ''}`, title: it.file, onClick: () => this.select({ kind: it.kind, file: it.file }) },
            h('span', { class: 'tt-name' }, it.name),
            h('span', { class: 'tt-info' }, it.info),
          ),
        );
      }
    };
    group(
      'Linie (.ttl)',
      this.data.lines
        .filter((l) => ok(l.name))
        .map((l) => ({ kind: 'line' as const, file: l.file, name: l.name, info: `${l.tours.length} bryg. · ${l.tours.reduce((n, t) => n + t.trips.length, 0)} kursów` })),
    );
    group(
      'Kursy (.ttp)',
      this.data.trips
        .filter((t) => ok(t.name) || ok(t.title))
        .map((t) => ({ kind: 'trip' as const, file: t.file, name: t.name, info: `${t.title} · ${t.stations.length} przyst.` })),
    );
  }

  // --- edytor ----------------------------------------------------------------

  private renderMain(): void {
    clear(this.main);
    if (this.data.lines.length === 0 && this.data.trips.length === 0) {
      this.main.append(h('div', { class: 'empty' }, 'Nie znaleziono plików linii (.ttl) ani kursów (.ttp) w folderze mapy.'));
      return;
    }
    if (this.line) this.renderLine(this.line);
    else if (this.trip) this.renderTrip(this.trip);
    else this.main.append(h('div', { class: 'empty' }, 'Wybierz linię lub kurs z listy po lewej.'));
  }

  private saveBar(title: string, onSave: () => Promise<{ ok: boolean; error?: string }>): HTMLElement {
    const save = h('button', { class: 'btn primary', onClick: () => void doSave() }, '💾 Zapisz');
    const undo = h(
      'button',
      { class: 'btn', onClick: () => this.sel && this.select(this.sel, true) },
      '↩ Cofnij zmiany',
    );
    const doSave = async (): Promise<void> => {
      const r = await onSave();
      if (r.ok) {
        this.dirty = false;
        this.status.textContent = 'Zapisano';
        this.status.className = 'status ok';
        await this.reload();
        this.status.textContent = 'Zapisano';
        this.status.className = 'status ok';
      } else {
        this.status.textContent = r.error ?? 'Nie udało się zapisać.';
        this.status.className = 'status bad';
      }
    };
    return h('div', { class: 'toolbar' }, h('strong', {}, title), h('div', { class: 'spacer' }), this.status, undo, save);
  }

  private renderLine(line: LineFile): void {
    this.main.append(this.saveBar(`Linia ${line.name}`, () => this.api.saveLine(line)));
    const body = h('div', { class: 'tt-body' });
    line.tours.forEach((tour, ti) => body.append(this.tourCard(line, tour, ti)));
    body.append(
      h(
        'button',
        {
          class: 'btn',
          onClick: () => {
            const last = line.tours[line.tours.length - 1];
            const next = String(Math.max(0, ...line.tours.map((t) => Number(t.number) || 0)) + 1);
            line.tours.push({ number: next, header: last ? [...last.header] : ['', ''], trips: [] });
            this.markDirty();
            this.renderMain();
          },
        },
        '+ Dodaj brygadę',
      ),
    );
    this.main.append(body);
  }

  private tourCard(line: LineFile, tour: LineTour, ti: number): HTMLElement {
    const num = h('input', { type: 'text', class: 'tt-short', value: tour.number, title: 'Numer brygady' });
    num.addEventListener('change', () => {
      tour.number = num.value.trim();
      this.markDirty();
    });
    const veh = h('input', { type: 'text', class: 'tt-veh', value: tour.header[0] ?? '', title: 'Typ pojazdu' });
    veh.addEventListener('change', () => {
      tour.header[0] = veh.value.trim();
      this.markDirty();
    });
    const shift = h('input', { type: 'text', class: 'tt-short', value: '5', title: 'Przesunięcie w minutach' });
    const act = (label: string, title: string, fn: () => void): HTMLElement =>
      h('button', { class: 'btn', title, onClick: fn }, label);

    const rows = tour.trips.map((tr, i) => {
      const clock = h('input', { type: 'text', class: 'tt-time', value: formatClock(tr.start) });
      clock.addEventListener('change', () => {
        const v = parseClock(clock.value);
        if (v === null) {
          clock.classList.add('bad');
          return;
        }
        clock.classList.remove('bad');
        tr.start = v;
        this.markDirty();
      });
      const name = h('input', { type: 'text', class: 'tt-trip', value: tr.trip });
      name.setAttribute('list', 'tt-trips'); // `list` jest właściwością tylko do odczytu
      const dest = h('span', { class: 'tt-dest' }, this.data.trips.find((t) => t.name === tr.trip)?.title ?? '');
      name.addEventListener('change', () => {
        tr.trip = name.value.trim();
        dest.textContent = this.data.trips.find((t) => t.name === tr.trip)?.title ?? '';
        this.markDirty();
      });
      return h(
        'div',
        { class: 'tt-row' },
        clock,
        name,
        dest,
        act('⧉', 'Duplikuj kurs', () => {
          tour.trips.splice(i + 1, 0, { ...clone(tr), start: tr.start + 40 });
          this.markDirty();
          this.renderMain();
        }),
        act('✕', 'Usuń kurs', () => {
          tour.trips.splice(i, 1);
          this.markDirty();
          this.renderMain();
        }),
      );
    });

    return h(
      'div',
      { class: 'tt-card' },
      h(
        'div',
        { class: 'tt-card-head' },
        h('span', {}, 'Brygada'),
        num,
        veh,
        h('span', { class: 'tt-count' }, `${tour.trips.length} kursów`),
        h('div', { class: 'spacer' }),
        act('Sortuj wg godziny', 'Sortuje kursy brygady rosnąco', () => {
          tour.trips.sort((a, b) => a.start - b.start);
          this.markDirty();
          this.renderMain();
        }),
        shift,
        act('Przesuń o min', 'Przesuwa wszystkie kursy brygady (wartość ujemna cofa)', () => {
          const d = numOr(shift.value, 0);
          if (tour.trips.some((t) => t.start + d < 0)) return;
          for (const t of tour.trips) t.start += d;
          this.markDirty();
          this.renderMain();
        }),
        act('Usuń brygadę', 'Usuwa brygadę razem z kursami', () => {
          if (!window.confirm(`Usunąć brygadę ${tour.number} (${tour.trips.length} kursów)?`)) return;
          line.tours.splice(ti, 1);
          this.markDirty();
          this.renderMain();
        }),
      ),
      h('div', { class: 'tt-rows' }, ...rows),
      act('+ Dodaj kurs', 'Dodaje kurs po ostatnim', () => {
        const last = tour.trips[tour.trips.length - 1];
        tour.trips.push({ trip: last?.trip ?? '', flag: last?.flag ?? '0', start: last ? last.start + 40 : 360, extra: [] });
        this.markDirty();
        this.renderMain();
      }),
    );
  }

  private renderTrip(trip: TripFile): void {
    this.main.append(this.saveBar(`Kurs ${trip.name}`, () => this.api.saveTrip(trip)));
    const field = (label: string, value: string, set: (v: string) => void, readonly = false): HTMLElement => {
      const input = h('input', { type: 'text', value, readOnly: readonly });
      input.addEventListener('change', () => {
        set(input.value.trim());
        this.markDirty();
      });
      return h('label', { class: 'tt-field' }, h('span', {}, label), input);
    };
    const body = h(
      'div',
      { class: 'tt-body' },
      h(
        'div',
        { class: 'tt-fields' },
        field('Nazwa wewnętrzna', trip.internalName, () => undefined, true),
        field('Tytuł (cel)', trip.title, (v) => (trip.title = v)),
        field('Numer linii', trip.line, (v) => (trip.line = v)),
      ),
    );
    const prof = trip.profiles[this.profileIdx];
    if (!prof) {
      body.append(h('div', { class: 'empty' }, 'Ten kurs nie ma profili czasowych.'));
      this.main.append(body);
      return;
    }
    const pick = h('select', {}, ...trip.profiles.map((p, i) => h('option', { value: String(i), selected: i === this.profileIdx }, p.name)));
    pick.addEventListener('change', () => {
      this.profileIdx = Number(pick.value);
      this.renderMain();
    });
    const total = h('input', { type: 'text', class: 'tt-short', value: String(prof.total) });
    total.addEventListener('change', () => {
      prof.total = numOr(total.value, prof.total);
      this.markDirty();
    });
    body.append(
      h('div', { class: 'toolbar' }, h('span', {}, 'Profil:'), pick, h('span', {}, 'czas przejazdu (min):'), total),
      h('div', { class: 'tt-hint' }, 'Czasy w minutach od startu kursu. Puste pole usuwa wpis z pliku.'),
    );
    const head = h(
      'div',
      { class: 'tt-trow tt-thead' },
      h('span', {}, 'Nr'),
      h('span', {}, 'Przystanek'),
      h('span', {}, 'Przyjazd'),
      h('span', {}, 'Odjazd'),
      h('span', { title: '[profile_otherstopping] — liczba całkowita' }, 'Inne (kod)'),
    );
    const table = h('div', { class: 'tt-table' }, head);
    trip.stations.forEach((st, i) => {
      const cell = (rec: Record<number, number>, integer: boolean): HTMLElement => {
        const input = h('input', { type: 'text', class: 'tt-num', value: rec[i] === undefined ? '' : String(rec[i]) });
        input.addEventListener('change', () => {
          const t = input.value.trim();
          if (t === '') delete rec[i];
          else {
            const v = numOr(t, NaN);
            if (!Number.isFinite(v) || v < 0) {
              input.classList.add('bad');
              return;
            }
            rec[i] = integer ? Math.round(v) : v;
          }
          input.classList.remove('bad');
          this.markDirty();
        });
        return input;
      };
      table.append(
        h('div', { class: 'tt-trow' }, h('span', {}, String(i + 1)), h('span', { class: 'tt-st' }, st.name), cell(prof.arr, false), cell(prof.dep, false), cell(prof.stop, true)),
      );
    });
    body.append(table);
    this.main.append(body);
  }
}
