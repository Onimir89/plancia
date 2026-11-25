// In-memory Fs for tests and previews.
import type { Fs } from './types.js';

export class MemFs implements Fs {
  files: Map<string, string>;
  /** Directories that stay when empty; the others exist as long as they hold a file. */
  dirs = new Set<string>();
  constructor(files: Record<string, string> = {}) {
    this.files = new Map(Object.entries(files));
  }
  async readText(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }
  async list(dir: string): Promise<string[] | null> {
    return this.names(dir);
  }
  private names(dir: string): string[] | null {
    const prefix = dir.endsWith('/') ? dir : `${dir}/`;
    const names = new Set<string>();
    for (const p of [...this.files.keys(), ...this.dirs]) if (p.startsWith(prefix)) names.add(p.slice(prefix.length).split('/')[0]!);
    return names.size || this.dirs.has(dir) ? [...names].sort() : null;
  }
  async writeText(path: string, data: string): Promise<void> {
    this.files.set(path, data);
  }
  async real(path: string): Promise<string> {
    return path;
  }
  async rename(from: string, to: string): Promise<void> {
    const d = this.files.get(from);
    if (d !== undefined) {
      this.files.set(to, d);
      this.files.delete(from);
      return;
    }
    if (!this.names(from)) throw new Error(`rename: missing ${from}`);
    if (this.files.has(to) || this.names(to)?.length) throw new Error(`rename: ${to} is not an empty folder`);
    for (const [p, data] of [...this.files]) {
      if (!p.startsWith(`${from}/`)) continue;
      this.files.set(to + p.slice(from.length), data);
      this.files.delete(p);
    }
    this.dirs.delete(from);
    this.dirs.add(to);
  }
  async remove(path: string): Promise<void> {
    if (!this.files.delete(path) && this.names(path)?.length) throw new Error(`remove: ${path} is not empty`);
    this.dirs.delete(path);
  }
  async sleep(): Promise<void> {}
}
