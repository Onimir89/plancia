/**
 * plancia core — public API used by the mod. Pure TypeScript, no 'claude-code' imports:
 * every file access goes through the injected `Fs` (the mod wraps `$.fs`, tests use `MemFs`).
 *
 *   dirsOf(home, { CLAUDE_CONFIG_DIR, XDG_CONFIG_HOME }): Dirs     // the only place that decides the folders; Ctx = Dirs + fs + root
 *   readProtected(fs, state): Promise<string[] | null | undefined> // <state>/protected.json; null = not valid, undefined = missing
 *   writeProtected(fs, state, keys); setupChoices(items, current): Map<key, ticked>   // setup guide
 *   readInventory(ctx: Ctx): Promise<Inventory>                    // items of the 6 categories + baseline `on`
 *   withImports(items, desired: StateMap): StateMap                // desired + rules reached only through rules switched off = off
 *   resolvePreset(name: string, user: Preset[], items: Item[]): StateMap
 *   listPresets(user: Preset[]): Preset[]                          // Default, Minimal, then user presets
 *   loadPresets(fs: Fs, state: string): Promise<Preset[]>           // <state>/presets.json
 *   savePreset(fs: Fs, state: string, p: Preset): Promise<void>     // rejects reserved names (isReserved), missing parent, cycles
 *   deletePreset(fs: Fs, state: string, name: string): Promise<void>
 *   compile(items: Item[], desired: StateMap): Patch               // ops on settings.local.json + hooksOff
 *   applyPatch(ctx: Ctx, patch: Patch, o: { preset: string | null; now: Date }): Promise<ApplyResult>   // a protected item it switches back on goes back on in the folder's chats too
 *   resetProject(ctx: Ctx, o: { now: Date }): Promise<ApplyResult>
 *   resetAll(ctx: Ctx, now: Date): Promise<ResetOutcome[]>         // every touched project
 *   readState(fs: Fs, state: string): Promise<StateFile>            // <state>/state.json; `sessions` read as {} when missing; a BadFile when it cannot be used, as loadPresets
 *   setAside(ctx, now): Promise<string[]>                          // renames the state and the presets that cannot be used
 *   listTouchedProjects(s: StateFile): string[]
 *   appliedState(items: Item[], ps: ProjectState | undefined): StateMap
 *   summarize(items: Item[], from: StateMap, to: StateMap): Summary
 *   presetFrom(name, parent, desired: StateMap, user: Preset[], items: Item[]): Preset   // parent + differences; keeps what it says of items not settable here
 *   diffKeys(a: StateMap, b: StateMap): Set<string>                // unsaved changes, ◆ markers
 *   setCategory(items, desired: StateMap, category, ids: Iterable<string>, on: boolean): StateMap   // All on / All off on the shown ids, protected included, locked and offByImport skipped
 *   offByImport(item, shownOn: StateMap): boolean                  // rule loaded only through rules switched off: no switch
 *   fingerprint({ inv, ps, user, ss? }): string                    // what must be unchanged on disk before a write: project state, inventory, presets, chat
 *   readView(ctx, sid): Promise<{ state, inv, user, ps, ss }>; ifUnchanged(ctx, sid, seen, write): Promise<T | null>   // write in the lock, null when the disk changed since `seen`
 *   withLock(fs, state, (fs) => Promise<T>): Promise<T>; atomicWrite(fs, path, data)   // every read-modify-write of Plancia's files, see lock.ts
 *   readPanelRows(fs: Fs, state: string): Promise<number>; stepPanelRows(fs, state, delta): Promise<number>   // <state>/panel.json, clamped to PANEL_ROWS
 *   hookId(event, hookEntry): string; withoutHooks(hooks, off): hooks   // settings.read filter, never SessionStart
 *   guardToolCall(tool, input, cwd, dirs, look): Promise<string | null>; guardSpelling(tool, input, cwd, dirs | null): string | null   // tool.call defence of the state folder
 *
 * Per chat: state.json `sessions[<session id>]` = SessionState.
 *   projectOnly(item): boolean                                     // agents, plugin skills, synced plugins: always the default's
 *   sessionFrom(items, desired, ps, { root, preset, now }): SessionState   // only what differs from `Item.on`
 *   sessionState(items, ps, ss): StateMap                          // what the chat runs
 *   applyChat(ctx, id, ss, now, touch)                             // Apply: the choice and what the touch makes; a failing touch leaves nothing recorded
 *   saveSession(fs, state, id, ss | null, now); copySession(fs, state, from, to, now): Promise<boolean>   // a choice untouched for 30 days goes
 *   withoutServers(tools, ss | undefined, items): tools            // tool.list: without those of the chat's switched-off servers
 *   overlay(merged, items, ps, ss | undefined, layers): settings   // settings.read of the chat: default's entries out, chat's ops in
 *
 * Typical flow (mod): inv = readInventory(ctx); st = readState(fs, state); from = appliedState(inv.items, st.projects[root]);
 * to = resolvePreset(chosen, await loadPresets(fs, state), inv.items) (+ UI toggles); s = summarize(inv.items, from, to);
 * if s.needsConfirmation → extra confirmation by the user's click only; then applyPatch(ctx, compile(inv.items, to), { preset, now })
 * in ifUnchanged. The functions that write take the lock themselves, or run in their caller's.
 * Fs contract: readText/list return null when missing; writeText creates parent dirs; rename is atomic (mv), a folder's never over a full one.
 */
export * from './types.js';
export { protectedPath, readProtected, setupChoices, writeProtected } from './protected.js';
export { readInventory, withImports, type Inventory } from './inventory.js';
export {
  DEFAULT, MINIMAL, presetsPath, isReserved, listPresets, resolvePreset, loadPresets, savePreset, deletePreset, presetFrom, diffKeys,
} from './presets.js';
export { compile } from './compile.js';
export {
  applyPatch, resetProject, resetAll, readState, listTouchedProjects, appliedState, chatOf, settledProject, statePath, EMPTY_LOCAL, SESSION_TTL_DAYS,
  type Created, type Entry, type ProjectState, type SessionState, type StateFile, type Conflict, type ApplyResult, type ResetOutcome,
} from './merge.js';
export { projectOnly, projectOnlyEntry, sessionFrom, sessionState, saveSession, copySession, applyChat, overlay, withoutServers, type SettingsLayer } from './session.js';
export { summarize, type Summary, type Change, type Timing } from './summary.js';
export { hookId, withoutHooks } from './hooks.js';
export { guardSpelling, guardToolCall } from './guard.js';
export { LOCK, atomicWrite, lockPath, tmpFor, withLock } from './lock.js';
export {
  setCategory, offByImport, fingerprint, ifUnchanged, setAside, localStamp, readView, readPanelRows, stepPanelRows, panelPath, PANEL_ROWS, type Seen,
} from './ui.js';
export { BadFile } from './util.js';
export { MemFs } from './memfs.js';
