import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
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
      return Array.isArray(parsed) ? parsed : [];
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
      tileRange: input.tileRange ?? null,
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
    t.tileRange = input.tileRange ?? null;
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

  /** Przenosi zadania do archiwum (po zakończonym sukcesem prompcie). */
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
}
