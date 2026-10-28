import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sanitizeAttachment, sanitizePin, sanitizeTileRange } from '../../shared/taskExtras.ts';
import { buildTaskContent, validateTaskInput } from '../../shared/taskTypes.ts';
import type { Task, TaskInput, TaskView } from '../../shared/types.ts';

/** Zadania zapisywane w <folder roboczy>/_vibe/tasks.json. */
export class TaskStore {
  private file: string;

  constructor(file: string) {
    this.file = file;
  }

  private read(): Task[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as Task[];
      if (!Array.isArray(parsed)) return [];
      // zadania zapisane starszą wersją nie mają pól rozszerzeń
      return parsed.map((t) => ({
        ...t,
        tileRange: sanitizeTileRange(t.tileRange),
        pin: sanitizePin(t.pin),
        attachment: sanitizeAttachment(t.attachment),
      }));
    } catch {
      return [];
    }
  }

  private write(tasks: Task[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(tasks, null, 2), 'utf-8');
  }

  list(): TaskView[] {
    return this.read().map((t) => ({ ...t, content: buildTaskContent(t.kind, t.data) }));
  }

  add(input: TaskInput): Task {
    const err = validateTaskInput(input.kind, input.title, input.data);
    if (err) throw new Error(err);
    const task: Task = {
      id: crypto.randomUUID(),
      title: input.title.trim(),
      kind: input.kind,
      data: input.data,
      tileRange: sanitizeTileRange(input.tileRange),
      pin: sanitizePin(input.pin),
      attachment: sanitizeAttachment(input.attachment),
      checked: false,
      status: 'active',
      createdAt: Date.now(),
    };
    this.write([...this.read(), task]);
    return task;
  }

  update(id: string, input: TaskInput): void {
    const err = validateTaskInput(input.kind, input.title, input.data);
    if (err) throw new Error(err);
    const tasks = this.read();
    const t = tasks.find((x) => x.id === id);
    if (!t) throw new Error('Nie znaleziono zadania.');
    t.title = input.title.trim();
    t.data = input.data;
    t.tileRange = sanitizeTileRange(input.tileRange);
    t.pin = sanitizePin(input.pin);
    t.attachment = sanitizeAttachment(input.attachment);
    this.write(tasks);
  }

  remove(id: string): void {
    this.write(this.read().filter((t) => t.id !== id));
  }

  setChecked(id: string, checked: boolean): void {
    const tasks = this.read();
    const t = tasks.find((x) => x.id === id);
    if (!t) return;
    t.checked = checked;
    this.write(tasks);
  }

  /** Przenosi zadania do archiwum (po zakończonym sukcesem prompcie). Odrzucone i tak zostają odrzucone. */
  archive(ids: string[]): void {
    const set = new Set(ids);
    const now = Date.now();
    const tasks = this.read();
    for (const t of tasks) {
      if (set.has(t.id) && t.status === 'active') {
        t.status = 'archived';
        t.checked = false;
        t.archivedAt = now;
      }
    }
    this.write(tasks);
  }

  /** Oznacza zadania jako odrzucone przez Claude (id → komentarz). Zwraca liczbę zmienionych. */
  reject(comments: Map<string, string>): number {
    const now = Date.now();
    const tasks = this.read();
    let n = 0;
    for (const t of tasks) {
      const comment = comments.get(t.id);
      if (comment === undefined) continue;
      t.status = 'rejected';
      t.rejectedComment = comment;
      t.rejectedAt = now;
      t.checked = false;
      delete t.archivedAt;
      n++;
    }
    if (n) this.write(tasks);
    return n;
  }

  /** „☑️ Rozwiązane”: odrzucone zadanie wraca do puli aktywnych. */
  resolve(id: string): void {
    const tasks = this.read();
    const t = tasks.find((x) => x.id === id);
    if (!t || t.status !== 'rejected') return;
    t.status = 'active';
    t.checked = false;
    delete t.rejectedComment;
    delete t.rejectedAt;
    this.write(tasks);
  }
}
