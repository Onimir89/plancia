// Small helpers: paths, frontmatter, JSON paths, globs, Plancia's own files.
import type { Fs } from './types.js';

export const dirname = (p: string) => (p.lastIndexOf('/') <= 0 ? '/' : p.slice(0, p.lastIndexOf('/')));
export const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1);
export const stripExt = (n: string) => (n.lastIndexOf('.') > 0 ? n.slice(0, n.lastIndexOf('.')) : n);

/** Resolves `.` and `..` in an absolute path. */
export function normalize(p: string): string {
  const out: string[] = [];
  for (const s of p.split('/')) {
    if (!s || s === '.') continue;
    if (s === '..') out.pop();
    else out.push(s);
  }
  return `/${out.join('/')}`;
}

export function expandHome(p: string, home: string, base: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return normalize(`${home}/${p.slice(2)}`);
  if (p.startsWith('/')) return normalize(p);
  return normalize(`${base}/${p}`);
}

/** Slug used for per-project folders (same shape as ~/.claude/projects). */
export const slug = (root: string) => root.replace(/[^A-Za-z0-9]/g, '-');

/** FNV-1a, 64 bits, in hexadecimal. */
export function hash(text: string): string {
  let h = 0xcbf29ce484222325n;
  for (const c of text) h = BigInt.asUintN(64, (h ^ BigInt(c.codePointAt(0)!)) * 0x100000001b3n);
  return h.toString(16).padStart(16, '0');
}

function unquote(v: string): string {
  if (v.length >= 2 && v[0] === '"' && v.at(-1) === '"') return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  if (v.length >= 2 && v[0] === "'" && v.at(-1) === "'") return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

/** Top-level scalar keys of a YAML frontmatter (plain, quoted, `>` and `|` block scalars). */
export function parseFrontmatter(text: string): Record<string, string> {
  const t = text.replace(/\r\n/g, '\n');
  if (!t.startsWith('---\n')) return {};
  const end = t.indexOf('\n---', 3);
  if (end < 0) return {};
  const lines = t.slice(4, end + 1).split('\n');
  const out: Record<string, string> = {};
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]!);
    if (!m) continue;
    const key = m[1]!;
    const v = m[2]!.trim();
    if (/^[>|][+-]?$/.test(v)) {
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]!) || lines[i + 1]!.trim() === '')) block.push(lines[++i]!.trim());
      out[key] = v[0] === '>' ? block.filter(Boolean).join(' ') : block.join('\n').trim();
    } else out[key] = unquote(v);
  }
  return out;
}

/** First non-empty line, without heading marks. */
export const firstLine = (text: string) =>
  (text.replace(/\r\n/g, '\n').split('\n').find((l) => l.trim() && l.trim() !== '---') ?? '').replace(/^#+\s*/, '').trim();

export function parseJson(text: string | null): { ok: true; value: any } | { ok: false } {
  if (text === null) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** One of Plancia's own files that cannot be used: ignored, never written over, set aside only by the user's click (setAside). */
export class BadFile extends Error {
  path: string;
  constructor(path: string, why = 'is not valid, or comes from another version of Plancia') {
    super(`${path} ${why}`);
    this.path = path;
  }
}

/** What one of Plancia's own files holds; undefined when missing. */
export async function readOwn(fs: Fs, path: string): Promise<any> {
  const raw = await fs.readText(path).catch((e: Error) => { throw new BadFile(path, `cannot be read: ${e.message}`); });
  const p = parseJson(raw);
  if (!p.ok) throw new BadFile(path);
  return p.value;
}

export const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const asObj = (v: unknown): Record<string, any> => (isObj(v) ? v : {});
export const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export function getPath(o: any, path: string[]): unknown {
  let cur = o;
  for (const k of path) {
    if (!isObj(cur) || !(k in cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

/** Stable JSON for equality (object keys sorted). */
export function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'undefined';
}
export const same = (a: unknown, b: unknown) => stable(a) === stable(b);

/** Glob on absolute paths as used by claudeMdExcludes: `**` any depth, `*` one segment, `?` one char, `\\x` a literal x. */
export function globMatch(glob: string, path: string): boolean {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '\\' && i + 1 < glob.length) re += glob[++i]!.replace(/[.*?+^${}()|[\]\\]/g, '\\$&');
    else if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i++;
      if (glob[i + 1] === '/') i++;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`).test(path);
}
