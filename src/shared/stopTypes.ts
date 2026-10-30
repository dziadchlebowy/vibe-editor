/**
 * Wartość [profile_otherstopping] przy przystanku w pliku .ttp.
 * Nie znalazłem dokumentacji tego pola. Wiadomo tyle: wg opisu zmiany w projekcie OmsiModsBR (launcher) wartość 2
 * oznacza przejazd przez przystanek bez zatrzymania. Pozostałe opisy to WNIOSKI z Twojego pliku (3 przy pierwszym
 * przystanku, 4 przy dwóch ostatnich, 1 przy większości pośrednich) — do potwierdzenia w grze.
 */
export interface StopType {
  code: number;
  label: string;
  verified: boolean;
}

export const STOP_TYPES: StopType[] = [
  { code: 1, label: 'Stały (pośredni)', verified: false },
  { code: 2, label: 'Bez zatrzymania (przejazd)', verified: false },
  { code: 3, label: 'Początkowy', verified: false },
  { code: 4, label: 'Końcowy', verified: false },
];

export const stopTypeLabel = (code: number): string => {
  const t = STOP_TYPES.find((s) => s.code === code);
  return t ? `${code} — ${t.label}?` : `${code} — nieznany`;
};
