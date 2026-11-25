// Presets: a parent + differences. Default and Minimal are built in, never stored, never deleted.
import type { Fs, Item, Preset, StateMap } from './types.js';
import { itemKey } from './types.js';
import { BadFile, isObj, readOwn } from './util.js';
import { atomicWrite, withLock } from './lock.js';

/** Everything as it is without Plancia. */
export const DEFAULT = 'Default';
/** Everything off, but Plancia itself (never listed) and the locked items. */
export const MINIMAL = 'Minimal';
const BUILT_IN: readonly Preset[] = [DEFAULT, MINIMAL].map((name) => ({ name, parent: null, enable: [], disable: [] }));
const isBuiltIn = (name: string) => BUILT_IN.some((p) => p.name === name);
/** No preset of the user may take a built-in name, however spelled. */
export const isReserved = (name: string): boolean => BUILT_IN.some((p) => p.name.toLowerCase() === name.trim().toLowerCase());

export const presetsPath = (state: string) => `${state}/presets.json`;

/** Built-in presets first, then the user's. */
export const listPresets = (user: Preset[]): Preset[] => [...BUILT_IN, ...user.filter((p) => !isBuiltIn(p.name))];

function chain(name: string, user: Preset[]): Preset[] {
  const all = new Map(listPresets(user).map((p) => [p.name, p]));
  const out: Preset[] = [];
  const seen = new Set<string>();
  for (let cur: string | null = name; cur !== null; ) {
    const p = all.get(cur);
    if (!p) throw new Error(`unknown preset: ${cur}`);
    if (seen.has(cur)) throw new Error(`preset cycle: ${[...seen, cur].join(' → ')}`);
    seen.add(cur);
    out.unshift(p);
    cur = p.parent;
  }
  return out;
}

/**
 * State of every item under a preset. Root: Minimal = all off, Default = today's baseline (`item.on`).
 * Each level applies disable then enable; items never mentioned inherit from the parent. Locked items stay as they are.
 */
export function resolvePreset(name: string, user: Preset[], items: Item[]): StateMap {
  const levels = chain(name, user);
  const m: StateMap = new Map(items.map((i) => [itemKey(i), levels[0]!.name === DEFAULT ? i.on : false]));
  for (const p of levels) {
    for (const k of p.disable) if (m.has(k)) m.set(k, false);
    for (const k of p.enable) if (m.has(k)) m.set(k, true);
  }
  for (const i of items) if (i.locked) m.set(itemKey(i), i.on);
  return m;
}

const isKeys = (v: unknown) => Array.isArray(v) && v.every((k) => typeof k === 'string');
const isPreset = (v: unknown): v is Preset => isObj(v) && typeof v.name === 'string' && typeof v.parent === 'string' && isKeys(v.enable) && isKeys(v.disable);

export async function loadPresets(fs: Fs, state: string): Promise<Preset[]> {
  const path = presetsPath(state);
  const file = await readOwn(fs, path);
  if (file === undefined) return [];
  if (!isObj(file) || file.version !== 1 || !Array.isArray(file.presets) || !file.presets.every(isPreset)) throw new BadFile(path);
  const user = file.presets.filter((x) => !isBuiltIn(x.name));
  try {
    for (const p of user) chain(p.name, user);
  } catch (e) {
    throw new BadFile(path, `is not valid: ${(e as Error).message}`);
  }
  return user;
}

/** The user's presets through `change`, in the lock; null = leave them. */
const update = (fs: Fs, state: string, change: (user: Preset[]) => Preset[] | null): Promise<void> =>
  withLock(fs, state, async (locked) => {
    const presets = change(await loadPresets(locked, state));
    if (presets) await atomicWrite(locked, presetsPath(state), `${JSON.stringify({ version: 1, presets }, null, 2)}\n`);
  });

/** Adds or replaces a user preset. Rejects reserved names, a missing parent, cycles. */
export async function savePreset(fs: Fs, state: string, preset: Preset): Promise<void> {
  const name = preset.name.trim();
  if (!name) throw new Error('the preset name is empty');
  if (isReserved(name)) throw new Error(`${name} is a built-in preset: it cannot be replaced`);
  if (preset.parent === null) throw new Error('a preset is based on Default, Minimal or another preset');
  const clean: Preset = { name, parent: preset.parent, enable: [...new Set(preset.enable)], disable: [...new Set(preset.disable)] };
  await update(fs, state, (user) => {
    const next = user.some((p) => p.name === name) ? user.map((p) => (p.name === name ? clean : p)) : [...user, clean];
    chain(name, next); // throws on missing parent or cycle
    return next;
  });
}

export async function deletePreset(fs: Fs, state: string, name: string): Promise<void> {
  if (isBuiltIn(name)) throw new Error(`${name} is a built-in preset: it cannot be deleted`);
  await update(fs, state, (user) => {
    const children = user.filter((p) => p.parent === name).map((p) => p.name);
    if (children.length) throw new Error(`other presets are based on ${name}: ${children.join(', ')}`);
    return user.some((p) => p.name === name) ? user.filter((p) => p.name !== name) : null;
  });
}

/** Keys whose state differs between two maps (a key missing on one side counts as different). */
export function diffKeys(a: StateMap, b: StateMap): Set<string> {
  const out = new Set<string>();
  for (const [k, v] of a) if (b.get(k) !== v) out.add(k);
  for (const k of b.keys()) if (!a.has(k)) out.add(k);
  return out;
}

/**
 * A preset that resolves to `desired`: `parent` plus the differences from it. What the preset of that name already
 * says of items that cannot be set here (locked, or not in this project) stays.
 */
export function presetFrom(name: string, parent: string, desired: StateMap, user: Preset[], items: Item[]): Preset {
  const base = resolvePreset(parent, user, items);
  const settable = new Set(items.filter((i) => !i.locked).map(itemKey));
  const old = user.find((p) => p.name === name);
  const enable = (old?.enable ?? []).filter((k) => !settable.has(k));
  const disable = (old?.disable ?? []).filter((k) => !settable.has(k));
  for (const [k, v] of desired) if (settable.has(k) && base.get(k) !== v) (v ? enable : disable).push(k);
  return { name, parent, enable: enable.sort(), disable: disable.sort() };
}
