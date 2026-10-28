/**
 * Claude dostaje prawo edycji TYLKO folderu mapy i _vibe/inspirations. Poza instrukcją w prompcie
 * (promptBuilder) w trybie Claude Code blokujemy też edycję ścieżek, które aplikacja trzyma
 * w folderze roboczym obok mapy — to dodatkowe zabezpieczenie, nie zamiennik zasad z promptu.
 */
export const DENIED_EDIT_PATHS = [
  '_vibe/assets/**',
  '_vibe/prompts/**',
  '_vibe/tasks.json',
  '_vibe/map-index.json',
  '_vibe/last-run.json',
  '.git/**',
];

/** Wartość dla `claude --disallowedTools` (reguły Edit obejmują wszystkie narzędzia edytujące pliki). */
export function disallowedToolsArg(): string {
  return DENIED_EDIT_PATHS.map((p) => `Edit(${p})`).join(',');
}
