/**
 * Dni obowiązywania brygady: trzecia linijka pod [newtour] (np. 287) to maska bitowa.
 * Rozkodowanie wg forum OMSI (wątek „Wie funktioniert die .ttl Datei?”): liczba zapisana binarnie
 * na 10 pozycjach, każda to checkbox z edytora. 287 = 0100011111 = „bez ferii” + pon–pt.
 * Nazwy bitów 7–9 pochodzą z tego wątku („Holiday”, „No Hols”, „Hols”); ich dokładne znaczenie w grze
 * (święto państwowe / ferie szkolne) nie jest tam opisane — opisy w UI są więc ostrożne.
 */
export interface DayBit {
  bit: number;
  label: string;
  title: string;
}

export const DAY_BITS: DayBit[] = [
  { bit: 0, label: 'Pn', title: 'Poniedziałek' },
  { bit: 1, label: 'Wt', title: 'Wtorek' },
  { bit: 2, label: 'Śr', title: 'Środa' },
  { bit: 3, label: 'Cz', title: 'Czwartek' },
  { bit: 4, label: 'Pt', title: 'Piątek' },
  { bit: 5, label: 'So', title: 'Sobota' },
  { bit: 6, label: 'Nd', title: 'Niedziela' },
  { bit: 7, label: 'Święto', title: 'Dzień świąteczny (w forum: „Holiday”)' },
  { bit: 8, label: 'Poza feriami', title: 'Poza feriami (w forum: „No Hols”)' },
  { bit: 9, label: 'Ferie', title: 'W czasie ferii (w forum: „Hols”)' },
];

export const DAY_MASK_MAX = (1 << DAY_BITS.length) - 1;

/** Maska z linijki nagłówka brygady; null, gdy to nie jest liczba całkowita z zakresu. */
export function parseDayMask(text: string | undefined): number | null {
  if (text === undefined || !/^\d+$/.test(text.trim())) return null;
  const v = Number(text.trim());
  return v <= DAY_MASK_MAX ? v : null;
}

export const hasDay = (mask: number, bit: number): boolean => (mask & (1 << bit)) !== 0;
export const setDay = (mask: number, bit: number, on: boolean): number => (on ? mask | (1 << bit) : mask & ~(1 << bit));
