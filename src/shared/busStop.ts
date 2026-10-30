/**
 * Parametry przystanku z wpisu [object] w .map (7 linijek po liczniku). Kolejność wg opisu użytkownika:
 * nazwa, maks. pasażerów, min. pasażerów, wyjście pasażerów (ilu maks. wysiada), długość dokowania (m),
 * strefa wyjścia/wejścia (0 prawa, 1 lewa, 2 obie), podnazwa (opcjonalna). Pusta linijka = brak wartości.
 */
export const STOP_PARAM_COUNT = 7;

export interface StopParams {
  name: string;
  maxPassengers: string;
  minPassengers: string;
  exitPassengers: string;
  dockLength: string;
  zone: string;
  subName: string;
}

export const ZONES = [
  { value: '0', label: '0 — prawa strona' },
  { value: '1', label: '1 — lewa strona' },
  { value: '2', label: '2 — obie strony (głównie pociągi)' },
];

export function toParams(p: string[]): StopParams {
  const g = (i: number): string => (p[i] ?? '').trim();
  return { name: g(0), maxPassengers: g(1), minPassengers: g(2), exitPassengers: g(3), dockLength: g(4), zone: g(5), subName: g(6) };
}

export const fromParams = (s: StopParams): string[] => [
  s.name,
  s.maxPassengers,
  s.minPassengers,
  s.exitPassengers,
  s.dockLength,
  s.zone,
  s.subName,
];

/** Błąd walidacji po polsku albo null. Pola liczbowe mogą być puste (opcjonalne). */
export function validateParams(s: StopParams): string | null {
  if (!s.name.trim()) return 'Podaj nazwę przystanku.';
  if (/[\r\n]/.test(fromParams(s).join(''))) return 'Wartości nie mogą zawierać znaków nowej linii.';
  const int = (v: string): boolean => v === '' || /^\d+$/.test(v);
  if (!int(s.maxPassengers) || !int(s.minPassengers) || !int(s.exitPassengers)) return 'Liczby pasażerów muszą być nieujemnymi liczbami całkowitymi.';
  if (s.maxPassengers !== '' && s.minPassengers !== '' && Number(s.minPassengers) > Number(s.maxPassengers)) return 'Minimum pasażerów nie może być większe niż maksimum.';
  if (s.dockLength !== '' && !/^\d+([.,]\d+)?$/.test(s.dockLength)) return 'Długość dokowania to liczba metrów.';
  if (s.zone !== '' && !['0', '1', '2'].includes(s.zone)) return 'Strefa wyjścia/wejścia: 0, 1 lub 2.';
  return null;
}

/** Czy nazwa ma polskie znaki (zalecane ich unikanie). */
export const hasPolishChars = (s: string): boolean => /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/.test(s);

export const stripPolish = (s: string): string =>
  s.replace(/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/g, (c) => ({ ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z', Ą: 'A', Ć: 'C', Ę: 'E', Ł: 'L', Ń: 'N', Ó: 'O', Ś: 'S', Ź: 'Z', Ż: 'Z' })[c] ?? c);
