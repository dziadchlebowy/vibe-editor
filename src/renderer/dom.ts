type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === 'class') {
      el.className = String(v);
    } else if (k in el) {
      (el as unknown as Record<string, unknown>)[k] = v;
    } else {
      el.setAttribute(k, String(v));
    }
  }
  for (const c of children) {
    if (c !== null && c !== undefined && c !== false) el.append(c);
  }
  return el;
}

export const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

export function clear(el: HTMLElement): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}
