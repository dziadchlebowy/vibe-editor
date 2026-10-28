import type { ConsoleSource } from '../../shared/types.ts';

/** Funkcja wysyłająca tekst do konsoli aplikacji. */
export type Emit = (source: ConsoleSource, text: string) => void;
