import { formatClock, parseClock } from '../shared/clock.ts';
import { DAY_BITS, hasDay, parseDayMask, setDay } from '../shared/dayTypes.ts';
import { STOP_TYPES, stopTypeLabel } from '../shared/stopTypes.ts';
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
  /** Pokazuje trasę kursu (plik .ttp względem folderu mapy) na mapie. */
  showRoute(tripFile: string): void;
}

/** Zakładka „Linie”: edycja linii (.ttl: brygady i godziny odjazdów) oraz kursów (.ttp: czasy przejazdu). */
export class TimetableView {
  private data: TimetableData = { lines: [], trips: [] };
  private sel: Sel = null;
  private line: LineFile | null = null;
  private trip: TripFile | null = null;
  private profileIdx = 0;
  private lineMode: 'list' | 'chart' = 'list';
  private pxPerMin = 1.4;
  private shiftOnly = '';
  private selTrip: { tour: number; trip: number } | null = null;
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
    const ai = h('input', { type: 'checkbox', checked: !line.userAllowed });
    ai.addEventListener('change', () => {
      line.userAllowed = !ai.checked;
      this.markDirty();
    });
    const modeBtn = (mode: 'list' | 'chart', label: string): HTMLElement =>
      h('button', { class: `chip${this.lineMode === mode ? ' active' : ''}`, onClick: () => { this.lineMode = mode; this.renderMain(); } }, label);
    this.main.append(
      h(
        'div',
        { class: 'toolbar' },
        h('label', { class: 'tt-check', title: 'Linia bez znacznika [userallowed] w pliku — prowadzą ją tylko boty. (Znaczenie znacznika wywnioskowane z nazwy; brak opisu w dokumentacji.)' }, ai, 'Tylko dla AI'),
        h('div', { class: 'spacer' }),
        modeBtn('list', '☰ Lista'),
        modeBtn('chart', '▤ Wykres'),
      ),
    );
    if (this.lineMode === 'chart') {
      this.main.append(this.chart(line));
      return;
    }
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
    // przesuwanie tylko kursów wybranego profilu (np. 144-TP-FSO); domyślnie wszystkie
    const names = [...new Set(tour.trips.map((t) => t.trip))];
    const only = h(
      'select',
      { class: 'tt-only', title: 'Które kursy przesunąć' },
      h('option', { value: '' }, 'wszystkie kursy'),
      ...names.map((n) => h('option', { value: n, selected: n === this.shiftOnly }, n)),
    );
    only.addEventListener('change', () => {
      this.shiftOnly = only.value;
    });
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
        only,
        shift,
        act('Przesuń o min', 'Przesuwa wskazane kursy brygady o podaną liczbę minut (ujemna wartość cofa)', () => {
          const d = numOr(shift.value, 0);
          const picked = tour.trips.filter((t) => !only.value || t.trip === only.value);
          if (picked.some((t) => t.start + d < 0 || t.start + d >= 1440)) return;
          for (const t of picked) t.start += d;
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
      this.dayRow(tour),
      h('div', { class: 'tt-rows' }, ...rows),
      act('+ Dodaj kurs', 'Dodaje kurs po ostatnim', () => {
        const last = tour.trips[tour.trips.length - 1];
        tour.trips.push({ trip: last?.trip ?? '', flag: last?.flag ?? '0', start: last ? last.start + 40 : 360, extra: [] });
        this.markDirty();
        this.renderMain();
      }),
    );
  }

  /** Checkboxy dni obowiązywania brygady (maska z trzeciej linijki nagłówka). */
  private dayRow(tour: LineTour): HTMLElement {
    const mask = parseDayMask(tour.header[1]);
    if (mask === null) return h('div', { class: 'tt-hint' }, `Dni kursowania: nie rozpoznano wartości „${tour.header[1] ?? ''}”.`);
    const row = h('div', { class: 'tt-days' }, h('span', {}, 'Dni:'));
    for (const d of DAY_BITS) {
      const cb = h('input', { type: 'checkbox', checked: hasDay(mask, d.bit) });
      cb.addEventListener('change', () => {
        tour.header[1] = String(setDay(parseDayMask(tour.header[1]) ?? 0, d.bit, cb.checked));
        this.markDirty();
      });
      row.append(h('label', { class: 'tt-check', title: d.title }, cb, d.label));
    }
    return row;
  }

  private tripMinutes(tr: { trip: string; flag: string }): number {
    const t = this.data.trips.find((x) => x.name === tr.trip);
    const p = t?.profiles[Number(tr.flag)] ?? t?.profiles[0];
    return p && p.total > 0 ? p.total : 30;
  }

  /** Wykres brygad na osi czasu: przeciągaj bloki kursów, dwuklik na pustym torze dodaje kurs. */
  private chart(line: LineFile): HTMLElement {
    const ppm = this.pxPerMin;
    const wrap = h('div', { class: 'tt-chart' });
    const zoom = (f: number): void => {
      this.pxPerMin = Math.max(0.4, Math.min(6, this.pxPerMin * f));
      this.renderMain();
    };
    const info = h('div', { class: 'tt-hint' });
    const sel = h('div', { class: 'toolbar' });
    const renderSel = (): void => {
      clear(sel);
      const tr = this.selTrip ? line.tours[this.selTrip.tour]?.trips[this.selTrip.trip] : undefined;
      if (!this.selTrip || !tr) {
        info.textContent = 'Przeciągnij blok, by zmienić godzinę (Shift = co 5 min). Dwuklik na pustym torze dodaje kurs. Czerwony blok = kursy brygady zachodzą na siebie.';
        return;
      }
      info.textContent = '';
      const { tour, trip } = this.selTrip;
      const clock = h('input', { type: 'text', class: 'tt-time', value: formatClock(tr.start) });
      clock.addEventListener('change', () => {
        const v = parseClock(clock.value);
        if (v === null) return clock.classList.add('bad');
        tr.start = v;
        this.markDirty();
        this.renderMain();
      });
      const name = h('input', { type: 'text', class: 'tt-trip', value: tr.trip });
      name.setAttribute('list', 'tt-trips');
      name.addEventListener('change', () => {
        tr.trip = name.value.trim();
        this.markDirty();
        this.renderMain();
      });
      sel.append(
        h('strong', {}, `Brygada ${line.tours[tour].number}:`),
        clock,
        name,
        h('button', { class: 'btn', onClick: () => { line.tours[tour].trips.splice(trip + 1, 0, { ...clone(tr), start: tr.start + 40 }); this.markDirty(); this.renderMain(); } }, '⧉ Duplikuj'),
        h('button', { class: 'btn', onClick: () => { line.tours[tour].trips.splice(trip, 1); this.selTrip = null; this.markDirty(); this.renderMain(); } }, '✕ Usuń'),
      );
    };

    const bar = h(
      'div',
      { class: 'toolbar' },
      h('button', { class: 'btn', onClick: () => zoom(1 / 1.3) }, '−'),
      h('button', { class: 'btn', onClick: () => zoom(1.3) }, '+'),
      h('span', { class: 'status' }, `skala: ${(60 * ppm).toFixed(0)} px/h`),
    );
    const scroll = h('div', { class: 'tt-scroll' });
    const width = 1440 * ppm;
    const ruler = h('div', { class: 'tt-ruler' });
    ruler.style.width = `${width}px`;
    for (let hr = 0; hr < 24; hr++) {
      const tick = h('span', { class: 'tt-tick' }, `${hr}:00`);
      tick.style.left = `${hr * 60 * ppm}px`;
      ruler.append(tick);
    }
    scroll.append(ruler);

    line.tours.forEach((tour, ti) => {
      const track = h('div', { class: 'tt-track' });
      track.style.width = `${width}px`;
      track.addEventListener('dblclick', (e) => {
        if (e.target !== track) return;
        const last = tour.trips[tour.trips.length - 1];
        const x = e.clientX - track.getBoundingClientRect().left;
        tour.trips.push({ trip: last?.trip ?? '', flag: last?.flag ?? '0', start: Math.max(0, Math.round(x / ppm)), extra: [] });
        this.selTrip = { tour: ti, trip: tour.trips.length - 1 };
        this.markDirty();
        this.renderMain();
      });
      const sorted = tour.trips.map((t, i) => ({ t, i })).sort((a, b) => a.t.start - b.t.start);
      sorted.forEach(({ t: tr, i }, k) => {
        const dur = this.tripMinutes(tr);
        const next = sorted[k + 1]?.t;
        const clash = !!next && tr.start + dur > next.start + 1e-6;
        const known = this.data.trips.find((x) => x.name === tr.trip);
        const block = h(
          'div',
          { class: `tt-block${clash ? ' clash' : ''}${this.selTrip?.tour === ti && this.selTrip.trip === i ? ' sel' : ''}${known ? '' : ' unknown'}`, title: `${tr.trip}\n${formatClock(tr.start)} → ${formatClock(tr.start + dur)}` },
          h('span', {}, formatClock(tr.start)),
          h('em', {}, known?.title ?? tr.trip),
        );
        block.style.left = `${tr.start * ppm}px`;
        block.style.width = `${Math.max(14, dur * ppm)}px`;
        block.addEventListener('pointerdown', (e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          block.setPointerCapture(e.pointerId);
          const x0 = e.clientX;
          const start0 = tr.start;
          let moved = false;
          const move = (ev: PointerEvent): void => {
            const step = ev.shiftKey ? 5 : 1;
            const v = Math.max(0, Math.min(1439, Math.round((start0 + (ev.clientX - x0) / ppm) / step) * step));
            if (v === tr.start) return;
            moved = true;
            tr.start = v;
            block.style.left = `${v * ppm}px`;
            block.firstElementChild!.textContent = formatClock(v);
            info.textContent = `${tr.trip}: ${formatClock(v)}`;
          };
          const up = (): void => {
            block.removeEventListener('pointermove', move);
            block.removeEventListener('pointerup', up);
            block.removeEventListener('pointercancel', up);
            this.selTrip = { tour: ti, trip: i };
            if (moved) this.markDirty();
            this.renderMain();
          };
          block.addEventListener('pointermove', move);
          block.addEventListener('pointerup', up);
          block.addEventListener('pointercancel', up);
        });
        track.append(block);
      });
      scroll.append(h('div', { class: 'tt-lane' }, h('div', { class: 'tt-lane-label' }, `Brygada ${tour.number}`), track));
    });
    renderSel();
    wrap.append(bar, info, sel, scroll);
    // domyślnie pokaż początek kursowania, a nie północ
    const first = Math.min(...line.tours.flatMap((t) => t.trips.map((x) => x.start)));
    if (Number.isFinite(first)) requestAnimationFrame(() => (scroll.scrollLeft = Math.max(0, first - 30) * ppm));
    return wrap;
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
        { class: 'toolbar' },
        trip.trackFile
          ? h('button', { class: 'btn', title: 'Przełącz na mapę i narysuj trasę z pliku .ttr wraz z przystankami', onClick: () => this.api.showRoute(trip.file) }, '🗺️ Pokaż trasę na mapie')
          : h('span', { class: 'status' }, 'Nie znaleziono pliku .ttr o nazwie tego kursu — trasy nie da się pokazać.'),
      ),
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
      h('div', { class: 'tt-hint' }, 'Czasy w minutach od startu kursu. Puste pole usuwa wpis z pliku. Typy przystanków oznaczone „?” to domysły z Twojego pliku (nie znalazłem dokumentacji).'),
    );
    const head = h(
      'div',
      { class: 'tt-trow tt-thead' },
      h('span', {}, 'Nr'),
      h('span', {}, 'Przystanek'),
      h('span', {}, 'Przyjazd'),
      h('span', {}, 'Odjazd'),
      h('span', { title: '[profile_otherstopping] — opisy typów są wnioskami, do potwierdzenia w grze' }, 'Typ przystanku'),
    );
    const table = h('div', { class: 'tt-table' }, head);
    const stopSelect = (rec: Record<number, number>, i: number): HTMLElement => {
      const codes = [...new Set([...STOP_TYPES.map((t) => t.code), ...(rec[i] !== undefined ? [rec[i]] : [])])].sort((a, b) => a - b);
      const sel = h(
        'select',
        { class: 'tt-stop' },
        h('option', { value: '' }, '— (brak wpisu)'),
        ...codes.map((c) => h('option', { value: String(c), selected: rec[i] === c }, stopTypeLabel(c))),
      );
      sel.addEventListener('change', () => {
        if (sel.value === '') delete rec[i];
        else rec[i] = Number(sel.value);
        this.markDirty();
      });
      return sel;
    };
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
        h('div', { class: 'tt-trow' }, h('span', {}, String(i + 1)), h('span', { class: 'tt-st' }, st.name), cell(prof.arr, false), cell(prof.dep, false), stopSelect(prof.stop, i)),
      );
    });
    body.append(table);
    this.main.append(body);
  }
}
