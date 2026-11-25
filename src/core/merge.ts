// Applies and retracts a Patch on <root>/.claude/settings.local.json, one entry at a time.
// Tracking lives only in <state>/state.json, never in the settings file.
import type { Ctx, Fs, Item, Patch, PatchOp, StateMap } from './types.js';
import { itemKey, localSettingsPath } from './types.js';
import { BadFile, asObj, basename, dirname, getPath, hash, isObj, parseJson, readOwn, same, slug, stable } from './util.js';
import { readInventory } from './inventory.js';
import { atomicWrite, withLock } from './lock.js';

const BACKUPS_KEPT = 5;

export interface Entry extends PatchOp {
  /** Value before plancia wrote it: for set, whether the key existed and its value; for add, whether the value was already in the list. */
  prev: { present: boolean; value?: unknown };
}

export interface ProjectState {
  preset: string | null;
  appliedAt: string;
  entries: Entry[];
  hooksOff: string[];
  /** Containers (objects/lists) plancia created in the local file: removed again when left empty. */
  createdPaths: string[][];
  /** Recorded before the local file is written, and gone after: a process killed in between left the entries of before and of after it (settled). */
  pending?: true;
}

/** What Plancia made in a project: the local settings file, or its .claude folder too. */
export type Created = 'file' | 'dir';

/** The choice of one chat (Apply): what it runs instead of the project default, as long as it is on `root`. */
export interface SessionState {
  root: string;
  preset: string | null;
  /** Item key → on, only where it differs from the user's own configuration (`Item.on`); never project-only items. */
  desired: Record<string, boolean>;
  /** Hook ids off in this chat. */
  hooksOff: string[];
  updatedAt: string;
}

export interface StateFile {
  version: 1;
  /** Key = absolute project root. Also the registry of touched projects. */
  projects: Record<string, ProjectState>;
  /** Key = session id ($.session.id()). Missing in older files: read as {}. */
  sessions: Record<string, SessionState>;
  /** Key = absolute project root. Outlives the chats, so that a reset takes back what an expired one made. Missing in older files. */
  created: Record<string, Created>;
}

export const SESSION_TTL_DAYS = 30;

/** The chats touched in the last 30 days; a copy. */
export function pruneSessions(sessions: Record<string, SessionState>, now: Date): Record<string, SessionState> {
  const cutoff = now.getTime() - SESSION_TTL_DAYS * 86_400_000;
  return Object.fromEntries(Object.entries(sessions).filter(([, s]) => Date.parse(s?.updatedAt) >= cutoff));
}

export interface Conflict {
  item: string;
  path: string[];
  expected: unknown;
  found: unknown;
}

export interface ApplyResult {
  wrote: boolean;
  backup: string | null;
  conflicts: Conflict[];
  localPath: string;
}

export const statePath = (dir: string) => `${dir}/state.json`;
/** Named after the project, as much as a name holds; the hash tells /a/b from /a-b. */
const backupDir = (dir: string, root: string) => `${dir}/backups/${slug(root).slice(-80)}-${hash(root)}`;

/** The local settings a chat's Apply writes when there is none (an empty file is no JSON). */
export const EMPTY_LOCAL = '{}\n';

const isName = (v: unknown) => v === null || typeof v === 'string';
const isProject = (p: unknown) => isObj(p) && isName(p.preset) && [p.entries, p.hooksOff, p.createdPaths].every(Array.isArray)
  && p.entries.every((e: unknown) => isObj(e) && typeof e.item === 'string' && Array.isArray(e.path) && isObj(e.prev));
const isSession = (s: unknown) => isObj(s) && typeof s.root === 'string' && isName(s.preset) && isObj(s.desired) && Array.isArray(s.hooksOff);

/** Throws a BadFile on a file that is there and cannot be used whole: a part of it is never guessed. */
export async function readState(fs: Fs, dir: string): Promise<StateFile> {
  const file = await readOwn(fs, statePath(dir));
  if (file === undefined) return { version: 1, projects: {}, sessions: {}, created: {} };
  const { version, projects, sessions = {}, created } = isObj(file) ? file : {};
  const ok = version === 1 && isObj(projects) && Object.values(projects).every(isProject) && isObj(sessions) && Object.values(sessions).every(isSession)
    && (created === undefined || isObj(created));
  if (!ok) throw new BadFile(statePath(dir));
  // An older file says it in each project
  return { version, projects, sessions, created: created ?? Object.fromEntries(Object.entries(projects).filter(([, p]) => p.createdFile).map(([r]) => [r, 'file' as const])) };
}

/** The choice of the chat `sid`, when it is on this root (a resumed chat keeps its id on another folder). */
export const chatOf = (state: StateFile, sid: string, root: string) => (state.sessions[sid]?.root === root ? state.sessions[sid] : undefined);

/** In the lock, like every write of what was read before. */
export const writeState = (fs: Fs, dir: string, s: StateFile) => atomicWrite(fs, statePath(dir), `${JSON.stringify(s, null, 2)}\n`);

/** Every folder plancia wrote into: with a default, with a chat's choice, or with a file it made. */
export const listTouchedProjects = (s: StateFile) =>
  [...new Set([...Object.keys(s.projects), ...Object.values(s.sessions).map((x) => x.root), ...Object.keys(s.created)])].sort();

/** State each item has with what plancia applied: baseline `on`, overridden by the tracked entries and hooksOff. */
export function appliedState(items: Item[], ps: ProjectState | null | undefined): StateMap {
  const m: StateMap = new Map(items.map((i) => [itemKey(i), i.on]));
  for (const e of ps?.entries ?? []) m.set(e.item, e.on);
  for (const h of ps?.hooksOff ?? []) m.set(`hook:${h}`, false);
  for (const i of items) if (i.locked) m.set(itemKey(i), i.on);
  return m;
}

const opKey = (o: PatchOp) => `${o.kind}|${stable(o.path)}|${o.kind === 'add' ? stable(o.value) : ''}`;
const pathKey = (p: string[]) => stable(p);
const isEmpty = (v: unknown) => (Array.isArray(v) ? v.length === 0 : isObj(v) && Object.keys(v).length === 0);

function parentOf(o: any, path: string[]): any {
  return path.length === 1 ? o : getPath(o, path.slice(0, -1));
}

/** Creates missing containers along `path`; the last one is a list when `lastIsList`. */
function ensure(o: any, path: string[], lastIsList: boolean, created: Set<string>): any {
  let cur = o;
  path.forEach((k, i) => {
    const last = i === path.length - 1;
    if (cur[k] === undefined) {
      cur[k] = last && lastIsList ? [] : {};
      created.add(pathKey(path.slice(0, i + 1)));
    } else if (last && lastIsList ? !Array.isArray(cur[k]) : !isObj(cur[k])) {
      throw new Error(`settings.local.json: ${path.slice(0, i + 1).join('.')} has an unexpected type`);
    }
    cur = cur[k];
  });
  return cur;
}

export function write(o: any, op: PatchOp, created: Set<string>): Entry {
  if (op.kind === 'set') {
    const parent = ensure(o, op.path.slice(0, -1), false, created);
    const k = op.path.at(-1)!;
    const prev = k in parent ? { present: true, value: parent[k] } : { present: false };
    parent[k] = structuredClone(op.value);
    return { ...op, prev };
  }
  const list: unknown[] = ensure(o, op.path, true, created);
  const present = list.some((v) => same(v, op.value));
  if (!present) list.push(structuredClone(op.value));
  return { ...op, prev: { present } };
}

function inPlace(o: any, e: Entry): boolean {
  if (e.kind === 'set') return same(getPath(o, e.path), e.value);
  const list = getPath(o, e.path);
  return e.prev.present || (Array.isArray(list) && list.some((v) => same(v, e.value)));
}

export function retract(o: any, e: Entry): Conflict | null {
  if (e.kind === 'set') {
    const found = getPath(o, e.path);
    if (!same(found, e.value)) return { item: e.item, path: e.path, expected: e.value, found };
    const parent = parentOf(o, e.path);
    if (e.prev.present) parent[e.path.at(-1)!] = structuredClone(e.prev.value);
    else delete parent[e.path.at(-1)!];
    return null;
  }
  if (e.prev.present) return null; // plancia never added it
  const list = getPath(o, e.path);
  const i = Array.isArray(list) ? list.findIndex((v) => same(v, e.value)) : -1;
  if (i < 0) return { item: e.item, path: e.path, expected: e.value, found: undefined };
  (list as unknown[]).splice(i, 1);
  return null;
}

/** Removes the containers plancia created that are now empty, deepest first. */
function prune(o: any, created: Set<string>): void {
  const paths = [...created].map((k) => JSON.parse(k) as string[]).sort((a, b) => b.length - a.length);
  for (const p of paths) {
    const v = getPath(o, p);
    if (v === undefined) created.delete(pathKey(p));
    else if (isEmpty(v)) {
      delete parentOf(o, p)[p.at(-1)!];
      created.delete(pathKey(p));
    }
  }
}

/**
 * After a write killed halfway, what it did do: the entries the local file holds. One of them the user writes by hand
 * before the next write, with the very value, cannot be told from Plancia's own: a reset takes it back.
 */
export const settled = (ps: ProjectState, local: Record<string, unknown>): ProjectState =>
  (ps.pending ? { ...ps, entries: ps.entries.filter((e) => inPlace(local, e)) } : ps);

/** The project's record, settled: the local file is read only for a pending one. */
export async function settledProject(ctx: Pick<Ctx, 'fs' | 'root'>, state: StateFile): Promise<ProjectState | undefined> {
  const ps = state.projects[ctx.root];
  if (!ps?.pending) return ps;
  const local = parseJson(await ctx.fs.readText(localSettingsPath(ctx.root)));
  return settled(ps, local.ok ? asObj(local.value) : {});
}

/** Pure: the local file as it would be without plancia's entries (used for the baseline). */
export function retractAll(local: Record<string, unknown>, ps: ProjectState | null | undefined) {
  const o = structuredClone(local);
  const conflicts: Conflict[] = [];
  for (const e of [...(ps?.entries ?? [])].reverse()) {
    const c = retract(o, e);
    if (c) conflicts.push(c);
  }
  prune(o, new Set((ps?.createdPaths ?? []).map(pathKey)));
  return { local: o, conflicts };
}

async function writeBackup(ctx: Ctx, raw: string, now: Date): Promise<string> {
  const dir = backupDir(ctx.state, ctx.root);
  const existing = (await ctx.fs.list(dir)) ?? [];
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  let name = `${stamp}.json`;
  for (let n = 1; existing.includes(name); n++) name = `${stamp}-${n}.json`;
  await ctx.fs.writeText(`${dir}/${name}`, raw);
  const all = [...existing, name].sort();
  for (const old of all.slice(0, Math.max(0, all.length - BACKUPS_KEPT))) await ctx.fs.remove(`${dir}/${old}`);
  return `${dir}/${name}`;
}

/** `known` (StateFile.created) with what writing the local file now would make. */
export async function createdBy(fs: Fs, root: string, known: Created | undefined): Promise<Created | undefined> {
  if ((await fs.readText(localSettingsPath(root))) !== null) return known;
  return known === 'dir' || (await fs.list(`${root}/.claude`)) === null ? 'dir' : 'file';
}

/** Takes out of the project what is left beside the local file: temporaries of a killed write, then the folder plancia made, if empty. */
async function sweep(fs: Fs, root: string, made: Created | undefined): Promise<void> {
  const dir = `${root}/.claude`;
  const local = localSettingsPath(root);
  const file = await fs.real(local).catch(() => local);
  for (const f of (await fs.list(dirname(file))) ?? []) {
    if (f.startsWith(`${basename(file)}.`) && /^\.[\w-]+\.plancia-tmp$/.test(f.slice(basename(file).length))) await fs.remove(`${dirname(file)}/${f}`);
  }
  if (made === 'dir' && (await fs.list(dir))?.length === 0) await fs.remove(dir);
}

/**
 * Makes the project's local settings match `patch`: retracts tracked entries no longer wanted (only if
 * unchanged since plancia wrote them, else reported as conflicts), writes the new ones, records them in
 * state.json: one transaction, in the lock; when something fails after the local file is written, that file goes back as it was.
 * The new entries are recorded (`pending`) before the file holds them: those of a process killed halfway are never taken for the user's.
 * Backup of the previous file first; the file is re-read right before the rename (Claude Code and the user's editor take no lock).
 * `preset: null` with an empty patch = reset (the project leaves the registry).
 */
export function applyPatch(ctx: Ctx, patch: Patch, opts: { preset: string | null; now: Date }): Promise<ApplyResult> {
  return withLock(ctx.fs, ctx.state, (fs) => applyLocked({ ...ctx, fs }, patch, opts));
}

async function applyLocked(ctx: Ctx, patch: Patch, opts: { preset: string | null; now: Date }): Promise<ApplyResult> {
  const { fs, root } = ctx;
  const localPath = localSettingsPath(root);
  const raw0 = await fs.readText(localPath);
  const parsed = parseJson(raw0);
  if (!parsed.ok || (raw0 !== null && !isObj(parsed.value))) throw new Error(`${localPath} is not valid: left as it is`);
  const before: Record<string, unknown> = raw0 === null ? {} : parsed.value;

  const state = await readState(fs, ctx.state);
  const recorded = await fs.readText(statePath(ctx.state));
  const ps = state.projects[root] && settled(state.projects[root], before);
  const reset = opts.preset === null && patch.ops.length === 0 && patch.hooksOff.length === 0;
  const wanted = new Map(patch.ops.map((o) => [opKey(o), o]));
  const created = new Set((ps?.createdPaths ?? []).map(pathKey));
  const o: any = structuredClone(before);
  const conflicts: Conflict[] = [];
  const kept = new Map<string, Entry>();
  const handEdited = new Set<string>(); // ops whose entry the user changed after plancia wrote it: that value stays

  for (const e of [...(ps?.entries ?? [])].reverse()) {
    const w = wanted.get(opKey(e));
    if (w && same(w.value, e.value) && inPlace(o, e)) {
      kept.set(opKey(e), { ...e, item: w.item, on: w.on });
      continue;
    }
    const c = retract(o, e);
    if (c) {
      conflicts.push(c);
      handEdited.add(opKey(e));
    }
  }
  prune(o, created);
  const entries = patch.ops.filter((op) => !handEdited.has(opKey(op))).map((op) => kept.get(opKey(op)) ?? write(o, op, created));

  let backup: string | null = null;
  const known = state.created[root];
  // A reset also takes back the empty file a chat made (its very bytes: else it is the user's by now)
  const wrote = !same(o, before) || (reset && !!known && raw0 === EMPTY_LOCAL);
  const after = isEmpty(o) && known ? null : `${JSON.stringify(o, null, 2)}\n`;
  const made = wrote ? await createdBy(fs, root, known) : known;
  const put = (text: string | null) => (text === null ? fs.remove(localPath) : atomicWrite(fs, localPath, text));
  if (wrote && raw0 !== null) backup = await writeBackup(ctx, raw0, opts.now);
  const gone = reset || (wrote && after === null);

  // The chats stay, but those untouched for 30 days; a reset takes the project's chats too.
  const sessions = Object.fromEntries(Object.entries(pruneSessions(state.sessions, opts.now)).filter(([, s]) => !reset || s.root !== root));
  const next: StateFile = { version: 1, projects: { ...state.projects }, sessions, created: { ...state.created } };
  if (gone) delete next.created[root];
  else if (made) next.created[root] = made;
  if (reset) delete next.projects[root];
  else {
    next.projects[root] = {
      preset: opts.preset,
      appliedAt: opts.now.toISOString(),
      entries,
      hooksOff: [...patch.hooksOff],
      createdPaths: [...created].map((k) => JSON.parse(k)),
    };
  }
  const sameState = ps && next.projects[root] && same({ ...ps, appliedAt: 0 }, { ...next.projects[root], appliedAt: 0 });
  // What is known while the local file is written: the entries of before and of after it; the preset and the hooks off,
  // which need no file, are those of before till the last write
  const halfway = (): StateFile => {
    const seed = ps ?? (next.projects[root] && { ...next.projects[root], preset: null, hooksOff: [] });
    const both = new Map([...(ps?.entries ?? []), ...entries].map((e) => [`${opKey(e)}|${stable(e.value)}`, e]));
    const paths = new Set([...(ps?.createdPaths ?? []).map(pathKey), ...created]);
    return {
      ...next, created: { ...state.created, ...(made ? { [root]: made } : {}) },
      projects: seed ? { ...next.projects, [root]: { ...seed, entries: [...both.values()], createdPaths: [...paths].map((k) => JSON.parse(k)), pending: true } } : next.projects,
    };
  };
  let begun = false;
  const protectedBack = reset ? false : await protectedBackOn(ctx, ps, next.projects[root]!, sessions);
  const sessionsChanged = protectedBack || Object.keys(sessions).length !== Object.keys(state.sessions).length;
  try {
    if (wrote) {
      await writeState(fs, ctx.state, halfway());
      if ((await fs.readText(localPath)) !== raw0) throw new Error(`${localPath} changed during apply: nothing written, retry`);
      begun = true;
      await put(after);
    }
    if (gone) await sweep(fs, root, made);
    if ((!sameState && (ps || next.projects[root])) || sessionsChanged || !same(state.created, next.created)) await writeState(fs, ctx.state, next);
  } catch (e) {
    const undo = async () => {
      if (begun) {
        const now = await fs.readText(localPath);
        if (now !== after && now !== raw0) throw new Error('changed meanwhile');
        if (now !== raw0) await put(raw0);
        if (raw0 === null) await sweep(fs, root, made);
      }
      // Failing, the record stays `pending`, which says the same
      const file = statePath(ctx.state);
      if (wrote) await (recorded === null ? fs.remove(await fs.real(file)) : atomicWrite(fs, file, recorded)).catch(() => undefined);
    };
    await undo().catch(() => { throw new Error(`${(e as Error).message}; ${localPath} stays changed${backup ? `, it was as in ${backup}` : ''}`); });
    throw e;
  }
  // Hooks live in state.json only; the local file rewritten as it is makes every open chat of the folder merge again
  // (Claude Code does when a settings file changes), so a protected hook back on reaches them now. Never over a hand edit made meanwhile.
  const hooksChanged = !same([...(ps?.hooksOff ?? [])].sort(), [...(next.projects[root]?.hooksOff ?? [])].sort());
  if (!wrote && raw0 !== null && (hooksChanged || protectedBack) && (await fs.readText(localPath)) === raw0) await atomicWrite(fs, localPath, raw0);
  return { wrote, backup, conflicts, localPath };
}

const offKeys = (ps: ProjectState | undefined) =>
  new Set([...(ps?.entries ?? []).filter((e) => !e.on).map((e) => e.item), ...(ps?.hooksOff ?? []).map((h) => `hook:${h}`)]);

/**
 * A protected item the default switches back on goes back on in every chat of the folder (in place, in `sessions`):
 * a chat's Apply carries the protected items the default already had off without an extra confirmation of its own, and
 * must not keep them off once the default no longer does. True when a chat changed.
 */
async function protectedBackOn(ctx: Ctx, was: ProjectState | undefined, now: ProjectState, sessions: Record<string, SessionState>): Promise<boolean> {
  const off = offKeys(now);
  const back = [...offKeys(was)].filter((k) => !off.has(k));
  const chats = Object.values(sessions).filter((s) => s.root === ctx.root && back.some((k) => s.desired[k] === false));
  if (!chats.length) return false;
  // An unreadable inventory must not stop state.json: what it does not list counts as protected.
  const free = await readInventory(ctx).then((inv) => new Set(inv.items.filter((i) => !i.protected).map(itemKey)), () => null);
  let changed = false;
  for (const s of chats) {
    for (const k of back) {
      if (free?.has(k) || s.desired[k] !== false) continue;
      delete s.desired[k];
      if (k.startsWith('hook:')) s.hooksOff = s.hooksOff.filter((h) => h !== k.slice(5));
      changed = true;
    }
  }
  return changed;
}

/** Retracts everything plancia wrote for the project and drops it from the registry. */
export function resetProject(ctx: Ctx, opts: { now: Date }): Promise<ApplyResult> {
  return applyPatch(ctx, { ops: [], hooksOff: [] }, { preset: null, now: opts.now });
}

export interface ResetOutcome {
  root: string;
  result?: ApplyResult;
  /** Why the project was not reset; its record stays in state.json. */
  error?: string;
}

/** Resets every project plancia wrote into, in the lock throughout; one that is gone or unreadable never stops the others. */
export function resetAll(ctx: Ctx, now: Date): Promise<ResetOutcome[]> {
  return withLock(ctx.fs, ctx.state, async (fs) => {
    const out: ResetOutcome[] = [];
    for (const root of listTouchedProjects(await readState(fs, ctx.state))) {
      try {
        if ((await fs.list(root)) === null) throw new Error('folder not found');
        out.push({ root, result: await resetProject({ ...ctx, fs, root }, { now }) });
      } catch (e) {
        out.push({ root, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return out;
  });
}
