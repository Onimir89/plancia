// The user's protected items: <state>/protected.json = { version: 1, protected: [itemKey, …] }, written by the setup guide.
import type { Fs, Item } from './types.js';
import { itemKey } from './types.js';
import { isObj, parseJson } from './util.js';
import { atomicWrite, withLock } from './lock.js';

export const protectedPath = (state: string) => `${state}/protected.json`;

/** The protected item keys: undefined when the file is missing (setup not done), null when it is there but cannot be read or is not valid (the pane warns, and every hook and rule counts as protected). */
export async function readProtected(fs: Fs, state: string): Promise<string[] | null | undefined> {
  const p = parseJson(await fs.readText(protectedPath(state)).catch(() => ''));
  if (!p.ok) return null;
  if (p.value === undefined) return undefined;
  const list = isObj(p.value) && p.value.version === 1 ? p.value.protected : null;
  return Array.isArray(list) && list.every((k) => typeof k === 'string') ? list : null;
}

export const writeProtected = (fs: Fs, state: string, keys: string[]): Promise<void> =>
  withLock(fs, state, (locked) => atomicWrite(locked, protectedPath(state), `${JSON.stringify({ version: 1, protected: keys }, null, 2)}\n`));

/** The key of a hook: script, hash of the whole command (none in older files), event. */
const HOOK_KEY = /^hook:(.*?)(?:#[0-9a-f]{16})?:([^:]+)$/;
/** A hook's script and event, whatever the rest of its command: 'guard.sh (PreToolUse)'. */
export const hookName = (key: string): string => key.replace(HOOK_KEY, '$1 ($2)');

/** The protected hooks no longer in the settings → those there of the same script and event, not protected themselves: the command changed. */
export function lostHooks(items: Item[], current: string[] | null | undefined): Map<string, string[]> {
  const hooks = items.filter((i) => i.category === 'hook').map(itemKey);
  const lost = (current ?? []).filter((k) => HOOK_KEY.test(k) && !hooks.includes(k));
  return new Map(lost.map((k) => [k, hooks.filter((h) => !current!.includes(h) && hookName(h) === hookName(k))]));
}

/**
 * What the setup guide lists, key → ticked: the PreToolUse hooks and the rule files in use, then whatever else `current`
 * (readProtected) holds, of other kinds or not found here; of a hook whose command changed, the new one. No valid list yet: all ticked.
 */
export function setupChoices(items: Item[], current: string[] | null | undefined): Map<string, boolean> {
  const proposed = items.filter((i) => !i.locked && (i.mech.kind === 'claudeMdExclude' || (i.mech.kind === 'hook' && i.mech.event === 'PreToolUse')));
  const lost = lostHooks(items, current);
  const changed = [...lost.values()].flat();
  const kept = (current ?? []).filter((k) => !lost.get(k)?.length);
  return new Map([...proposed.map(itemKey), ...kept, ...changed].map((k) => [k, current ? kept.includes(k) || changed.includes(k) : true]));
}
