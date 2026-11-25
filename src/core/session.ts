// The choice of one chat in state.json `sessions`, and the pure overlay that
// the mod's settings.read hook applies to the merged settings of that chat only.
import type { Ctx, Fs, Item, StateMap } from './types.js';
import { itemKey } from './types.js';
import { compile, opFor } from './compile.js';
import { appliedState, createdBy, pruneSessions, readState, retract, settled, write, writeState, type Entry, type ProjectState, type SessionState } from './merge.js';
import { getPath, same } from './util.js';
import { withLock } from './lock.js';

const isSynced = (key: string) => key.startsWith('plugin:') && key.endsWith('@synced');
/**
 * Items every chat takes from the project default: permission rules (agents, plugin skills) are read from the files, not
 * from the merge, and plugins synced from claude.ai stay loaded whatever the chat's merge says (seen live, 2.1.332).
 */
export const projectOnly = (i: Item): boolean => i.mech.kind === 'denyAgent' || i.mech.kind === 'denySkill' || isSynced(itemKey(i));
/** The same of an entry of the default, where there is no inventory. */
export const projectOnlyEntry = (e: Entry): boolean => e.path[0] === 'permissions' || isSynced(e.item);

/** What the tools of an MCP server are called by: `mcp__<server as the engine spells it>__`. */
function mcpPrefix(server: string): string {
  const name = server.replace(/[^\w-]/g, '_');
  // claude.ai connectors alone lose repeated and outer underscores
  return `mcp__${server.startsWith('claude.ai ') ? name.replace(/_+/g, '_').replace(/^_|_$/g, '') : name}__`;
}

/** The tools without those of the servers switched off for the chat: a tool is of the server with the longest name its own begins with. */
export async function withoutServers<T extends { name: string }>(tools: readonly T[], ss: SessionState | undefined, items: () => Promise<Item[]>): Promise<readonly T[]> {
  const off = Object.entries(ss?.desired ?? {}).filter(([k, on]) => !on && k.startsWith('mcp:')).map(([k]) => mcpPrefix(k.slice(4)));
  if (!off.length) return tools;
  const unclear = tools.some((t) => off.some((p) => t.name.startsWith(p) && t.name.slice(p.length).includes('__')));
  const all = [...off, ...(unclear ? (await items()).filter((i) => i.category === 'mcp').map((i) => mcpPrefix(i.id)) : [])].sort((a, b) => b.length - a.length);
  return tools.filter((t) => !off.includes(all.find((p) => t.name.startsWith(p)) ?? ''));
}

/** What the chat runs: its own choice, the project default for the project-only items. */
export function sessionState(items: Item[], ps: ProjectState | null | undefined, ss: SessionState): StateMap {
  const m = appliedState(items, ps);
  for (const i of items) {
    const v = ss.desired[itemKey(i)];
    if (!projectOnly(i) && !i.locked) m.set(itemKey(i), typeof v === 'boolean' ? v : i.on);
  }
  return m;
}

/** The chat's choice from the pane's desired state: only what differs from the user's own configuration. */
export function sessionFrom(
  items: Item[], desired: StateMap, ps: ProjectState | null | undefined, o: { root: string; preset: string | null; now: Date },
): SessionState {
  const d: Record<string, boolean> = {};
  for (const i of items) {
    const want = desired.get(itemKey(i)) ?? i.on;
    if (!projectOnly(i) && !i.locked && want !== i.on) d[itemKey(i)] = want;
  }
  const ss: SessionState = { root: o.root, preset: o.preset, desired: d, hooksOff: [], updatedAt: o.now.toISOString() };
  ss.hooksOff = compile(items, sessionState(items, ps, ss)).hooksOff.sort();
  return ss;
}

/** Writes (or with null removes) the chat's choice; the projects stay, chats untouched for 30 days go. */
export function saveSession(fs: Fs, state: string, id: string, ss: SessionState | null, now: Date): Promise<void> {
  return withLock(fs, state, async (locked) => {
    const st = await readState(locked, state);
    const sessions = pruneSessions(st.sessions, now);
    if (ss) sessions[id] = ss;
    else delete sessions[id];
    await writeState(locked, state, { ...st, sessions });
  });
}

/** Apply: the chat's choice and what its `touch` of the local file makes, then the touch; when that fails, nothing is recorded. */
export function applyChat(ctx: Ctx, id: string, ss: SessionState, now: Date, touch: (fs: Fs) => Promise<void>): Promise<void> {
  return withLock(ctx.fs, ctx.state, async (fs) => {
    const before = await readState(fs, ctx.state);
    const made = await createdBy(fs, ctx.root, before.created[ctx.root]);
    await writeState(fs, ctx.state, {
      ...before, sessions: { ...pruneSessions(before.sessions, now), [id]: ss }, created: { ...before.created, ...(made ? { [ctx.root]: made } : {}) },
    });
    try {
      await touch(fs);
    } catch (e) {
      await writeState(fs, ctx.state, before);
      throw e;
    }
  });
}

/** /clear and /branch give the chat a new id: the choice goes with it. The old id keeps it for /resume. */
export async function copySession(fs: Fs, state: string, from: string, to: string, now: Date): Promise<boolean> {
  if (from === to || !(await readState(fs, state)).sessions[from]) return false; // no choice: nothing written, no lock either
  return withLock(fs, state, async (locked) => {
    const ss = (await readState(locked, state)).sessions[from];
    if (!ss) return false;
    await saveSession(locked, state, to, { ...ss, updatedAt: now.toISOString() }, now);
    return true;
  });
}

/** One layer of a settings read, as the settings.read event carries it (lowest precedence first). */
export interface SettingsLayer {
  readonly source: string;
  readonly settings: Readonly<Record<string, unknown>>;
}
const BELOW_LOCAL = ['plugin', 'user', 'project'];
const listHas = (list: unknown, v: unknown) => Array.isArray(list) && list.some((x) => same(x, v));
const ABOVE_LOCAL = ['flag', 'policy'];

/**
 * The merged settings as this chat must read them: for each item the chat wants other than the default, the
 * default's entries leave the merge (back to the local's own value, else the lower layers' one) and the chat's op
 * goes in. Items the chat agrees on, project-only items, hooks (the mod filters them) and locked items stay as merged;
 * so does an item a higher layer (--settings, policy) or a hand edit of the local holds. Never mutates the input;
 * without a choice for the chat, returns `merged` itself.
 */
export function overlay(
  merged: Readonly<Record<string, unknown>>, items: Item[], ps: ProjectState | null | undefined, ss: SessionState | undefined,
  layers: readonly SettingsLayer[],
): Readonly<Record<string, unknown>> {
  if (!ss) return merged;
  if (ps) ps = settled(ps, (layers.find((l) => l.source === 'local')?.settings ?? {}) as Record<string, unknown>);
  const chat = sessionState(items, ps, ss);
  const applied = appliedState(items, ps);
  const held = (path: string[]) => layers.some((l) => ABOVE_LOCAL.includes(l.source) && getPath(l.settings, path) !== undefined);
  const below = (path: string[]) => {
    let found: { value: unknown } | null = null;
    for (const l of layers) {
      const v = BELOW_LOCAL.includes(l.source) ? getPath(l.settings, path) : undefined;
      if (v !== undefined) found = { value: v };
    }
    return found;
  };
  const o: any = structuredClone(merged);
  for (const i of items) {
    const k = itemKey(i);
    const want = chat.get(k)!;
    if (projectOnly(i) || i.mech.kind === 'hook' || i.locked || want === applied.get(k)) continue;
    const mine = (ps?.entries ?? []).filter((e) => e.item === k);
    const op = opFor(i, want);
    const sets = [...mine, ...(op ? [op] : [])].filter((x) => x.kind === 'set');
    if (sets.some((x) => held(x.path)) || mine.some((e) => e.kind === 'set' && !same(getPath(o, e.path), e.value))) continue;
    for (const e of [...mine].reverse()) {
      if (e.kind === 'add') {
        // A value another layer holds too (the engine joins lists) stays in the merge
        if (!layers.some((l) => l.source !== 'local' && listHas(getPath(l.settings, e.path), e.value))) retract(o, e);
        continue;
      }
      const parent = getPath(o, e.path.slice(0, -1)) as Record<string, unknown>;
      const low = e.prev.present ? { value: e.prev.value } : below(e.path);
      if (low) parent[e.path.at(-1)!] = structuredClone(low.value);
      else delete parent[e.path.at(-1)!];
    }
    if (op && want !== i.on) write(o, { item: k, on: want, ...op }, new Set());
  }
  return o;
}
