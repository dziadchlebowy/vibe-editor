export interface FieldDef {
  key: string;
  label: string;
  type: 'text' | 'textarea';
  required?: boolean;
  placeholder?: string;
}

export interface TaskTypeDef {
  kind: string;
  label: string;
  fields: FieldDef[];
  /** Treść zadania generowana algorytmicznie (nie przez AI) z danych formularza. */
  buildContent: (data: Record<string, string>) => string;
}

/**
 * Rejestr rodzajów zadań. Nowy rodzaj = nowy wpis tutaj:
 * formularz w UI i generowanie treści działają automatycznie.
 */
export const TASK_TYPES: TaskTypeDef[] = [
  {
    kind: 'text',
    label: 'Zwykły tekstowy',
    fields: [
      {
        key: 'text',
        label: 'Treść zadania',
        type: 'textarea',
        required: true,
        placeholder: 'Opisz, co Claude ma zrobić na mapie…',
      },
    ],
    buildContent: (data) => (data.text ?? '').trim(),
  },
];

export function getTaskType(kind: string): TaskTypeDef | undefined {
  return TASK_TYPES.find((t) => t.kind === kind);
}

/** Zwraca komunikat błędu albo null, gdy dane są poprawne. */
export function validateTaskInput(
  kind: string,
  title: string,
  data: Record<string, string>,
): string | null {
  const def = getTaskType(kind);
  if (!def) return `Nieznany rodzaj zadania: ${kind}`;
  if (!title.trim()) return 'Podaj tytuł zadania.';
  for (const f of def.fields) {
    if (f.required && !(data[f.key] ?? '').trim()) {
      return `Pole „${f.label}” jest wymagane.`;
    }
  }
  return null;
}

export function buildTaskContent(kind: string, data: Record<string, string>): string {
  const def = getTaskType(kind);
  return def ? def.buildContent(data) : '';
}
