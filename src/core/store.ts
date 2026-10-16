// Tiny JSON-file collections. One file per collection under $SAW_HOME, 0600, written atomically.
// Enough for one wallet; swap the backend here if this ever serves many users.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { home } from "./config.js";

export class Collection<T extends { id: string }> {
  constructor(private readonly name: string) {}
  private get file() {
    return join(home(), `${this.name}.json`);
  }
  all(): T[] {
    if (!existsSync(this.file)) return [];
    try {
      return JSON.parse(readFileSync(this.file, "utf8")) as T[];
    } catch {
      return [];
    }
  }
  get(id: string): T | undefined {
    return this.all().find((r) => r.id === id);
  }
  put(row: T): T {
    const list = this.all().filter((r) => r.id !== row.id);
    list.push(row);
    this.write(list);
    return row;
  }
  update(id: string, patch: Partial<T>): T {
    const row = this.get(id);
    if (!row) throw new Error(`${this.name}: no row ${id}`);
    return this.put({ ...row, ...patch });
  }
  remove(id: string): void {
    this.write(this.all().filter((r) => r.id !== id));
  }
  write(list: T[]): void {
    mkdirSync(home(), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(list, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

/** Single JSON document (policy, local session). */
export class Doc<T> {
  constructor(private readonly name: string, private readonly init: () => T) {}
  private get file() {
    return join(home(), `${this.name}.json`);
  }
  exists(): boolean {
    return existsSync(this.file);
  }
  read(): T {
    if (!existsSync(this.file)) return this.init();
    try {
      return { ...this.init(), ...(JSON.parse(readFileSync(this.file, "utf8")) as T) };
    } catch {
      return this.init();
    }
  }
  write(v: T): T {
    mkdirSync(home(), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(v, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
    return v;
  }
  clear(): void {
    if (existsSync(this.file)) writeFileSync(this.file, JSON.stringify(this.init(), null, 2), { mode: 0o600 });
  }
}
