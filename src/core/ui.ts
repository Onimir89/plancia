// UI helpers of the pane: bulk toggle per category and the remembered pane height.
import type { Category, Ctx, Fs, Item, Preset, StateMap } from './types.js';
import { itemKey } from './types.js';
import { BadFile, isObj, parseJson } from './util.js';
import { readInventory, withImports, type Inventory } from './inventory.js';
import { atomicWrite, withLock } from './lock.js';
import { chatOf, readState, settledProject, type ProjectState, type SessionState } from './merge.js';
import { loadPresets } from './presets.js';

/** A rule loaded only through rules switched off (`shownOn` = withImports(items, desired)): it goes with them, no switch of its own. */
export const offByImport = (i: Item, shownOn: StateMap): boolean =>
  !!i.importedBy && !shownOn.get(itemKey(i)) && i.importedBy.every((p) => !shownOn.get(p));

/**
 * Switches on or off the items of `category` whose id is in `ids` (the ones the search shows), protected ones included:
 * the extra confirmation comes later from summarize().needsConfirmation. Skipped, as a click on them is refused:
 * locked items and rules loaded only through rules switched off.
 */
export function setCategory(items: Item[], desired: StateMap, category: Category, ids: Iterable<string>, on: boolean): StateMap {
  const wanted = new Set(ids);
  const next: StateMap = new Map(desired);
  // Up to a fixed point on the resulting state: switching an importer on frees the rules it imports;
  // a rule whose importers stay off is never set. At most one pass per import level.
  for (let changed = true; changed; ) {
    changed = false;
    const shownOn = withImports(items, next);
    for (const i of items) {
      if (i.category !== category || !wanted.has(i.id) || i.locked || offByImport(i, shownOn)) continue;
      if (next.get(itemKey(i)) !== on) {
        next.set(itemKey(i), on);
        changed = true;
      }
    }
  }
  return next;
}

/**
 * What a writer (this pane, another window's) must find unchanged on disk before it writes, as it read it: the
 * project's entry in state.json, the inventory (hand edits of settings.local.json included), the protected list and the user presets.
 */
export const fingerprint = (d: Seen): string => JSON.stringify([d.ps ?? null, d.inv.items, d.inv.protectedKeys ?? String(d.inv.protectedKeys), d.user, d.ss ?? null]);
export interface Seen { inv: Inventory; ps: ProjectState | undefined; user: Preset[]; ss?: SessionState | undefined }

/** What the pane of the chat `sid` shows, as the disk has it now. */
export async function readView(ctx: Ctx, sid: string) {
  const state = await readState(ctx.fs, ctx.state);
  const inv = await readInventory(ctx);
  const ps = await settledProject(ctx, state);
  if (ps) state.projects[ctx.root] = ps;
  return { state, inv, user: await loadPresets(ctx.fs, ctx.state), ps, ss: chatOf(state, sid, ctx.root) };
}

/** `write`, if the disk is still as the pane saw it; else null. One transaction: no one writes between the check and the write. */
export function ifUnchanged<T>(ctx: Ctx, sid: string, seen: Seen, write: (ctx: Ctx) => Promise<T>): Promise<T | null> {
  return withLock(ctx.fs, ctx.state, async (fs) => {
    const locked = { ...ctx, fs };
    return fingerprint(await readView(locked, sid)) === fingerprint(seen) ? write(locked) : null;
  });
}

/** Renames the state and the presets that cannot be used, so that Plancia starts over: the new paths, in the same folder. */
export function setAside(ctx: Ctx, now: Date): Promise<string[]> {
  return withLock(ctx.fs, ctx.state, async (fs) => {
    const kept: string[] = [];
    for (const read of [readState, loadPresets]) {
      try {
        await read(fs, ctx.state);
      } catch (e) {
        if (!(e instanceof BadFile)) throw e;
        const to = `${e.path}.${now.toISOString().replace(/[:.]/g, '-')}.old`;
        await fs.rename(e.path, to);
        kept.push(to);
      }
    }
    return kept;
  });
}

/** ISO instant → "YYYY-MM-DD HH:MM" in the machine's local time (state.json keeps UTC). */
export function localStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export const PANEL_ROWS = { min: 3, max: 40, default: 10 } as const;
/** Own file, not state.json: state.json is rewritten as { version, projects, sessions } and would drop extra fields. */
export const panelPath = (state: string) => `${state}/panel.json`;

const clampRows = (n: number) => Math.min(PANEL_ROWS.max, Math.max(PANEL_ROWS.min, Math.round(n)));

/** Rows per list in the text pane; the default when the file is missing, not valid or cannot be read. */
export async function readPanelRows(fs: Fs, state: string): Promise<number> {
  const p = parseJson(await fs.readText(panelPath(state)).catch(() => null));
  const rows = p.ok && isObj(p.value) ? p.value.rows : undefined;
  return Number.isInteger(rows) ? clampRows(rows) : PANEL_ROWS.default;
}

/** Moves the saved rows by `delta`, clamped, and returns the value stored. */
export function stepPanelRows(fs: Fs, state: string, delta: number): Promise<number> {
  return withLock(fs, state, async (locked) => {
    const rows = clampRows((await readPanelRows(locked, state)) + delta);
    await atomicWrite(locked, panelPath(state), `${JSON.stringify({ version: 1, rows }, null, 2)}\n`);
    return rows;
  });
}
