// Hook ids and the settings.read filter: one id per user hook entry, the same in the inventory and in the mod.
import type { SettingsLayer } from './session.js';
import { asList, asObj, basename, hash, isObj } from './util.js';

const WORD = /("[^"]*"|'[^']*'|\S)+/g;
const SCRIPT_RE = /\.(sh|bash|cjs|mjs|js|ts|py)$/;

/** The command as words, quotes taken off; with `args` no shell reads it. */
function words({ command, args }: Record<string, unknown>): string[] {
  if (typeof command !== 'string') return [];
  if (Array.isArray(args)) return [command, ...args.map(String)];
  return (command.match(WORD) ?? []).map((w) => w.replace(/["']/g, ''));
}

// An assignment or a URL query may carry a secret: never a name.
const named = (w: string) => !basename(w).includes('=');

/** Path of the script or program a hook entry runs, or '' for a command line or a hook that runs none. */
export function hookScript(hook: Record<string, unknown>): string {
  const all = words(hook);
  return all.find((w) => SCRIPT_RE.test(w) && named(w)) ?? (all.length === 1 && named(all[0]!) ? all[0]! : '');
}

/** The command line as a reader sees it, '' for a hook that runs none. */
export const hookLine = (hook: Record<string, unknown>): string => words(hook).join(' ');

/** The name shown: the script file, else the whole command line, else the type. */
export const hookLabel = (hook: Record<string, unknown>): string => basename(hookScript(hook)) || hookLine(hook) || String(hook.type ?? 'hook');

/** What the hook runs, whole: two spellings are one only where the shell surely reads them the same, else two hooks. */
function runs({ command, args, prompt, url, server, tool, input }: Record<string, unknown>): string {
  if (typeof command !== 'string') return JSON.stringify([prompt, url, server, tool, input]);
  if (Array.isArray(args)) return JSON.stringify([command, args]);
  if (/['\\]/.test(command)) return command.trim();
  return command.trim().replace(/\$\{(HOME|CLAUDE_PROJECT_DIR)\}(?!\w)/g, '$$$1').replace(WORD, (w) => w.replace(/^"([\w@%+:,./-]+)"$/, '$1'));
}

/** Same id in the inventory and the mod. It is kept in Plancia's files: a name and a hash, as a command may carry a secret. */
export function hookId(event: string, hook: Record<string, unknown>): string {
  const all = words(hook);
  const name = basename(hookScript(hook)) || (all.length ? basename(all.find((w) => !w.includes('=')) ?? '') || 'hook' : String(hook.type ?? 'hook'));
  return `${name}#${hash(runs(hook))}:${event}`;
}

/** Events whose hooks run before settings.read can act: locked, never switched off. */
export const LOCKED_EVENTS: readonly string[] = ['SessionStart'];

/**
 * The `hooks` setting without the entries switched off for the project. Never touches SessionStart, nor an entry
 * another layer (project, plugin, managed...) holds too: the panel lists only the user's. Never mutates the input (frozen in a settings.read hook); returns the input itself when nothing is removed.
 */
export function withoutHooks(hooks: unknown, off: readonly string[], layers: readonly SettingsLayer[] = []): unknown {
  if (!isObj(hooks) || off.length === 0) return hooks;
  const offSet = new Set(off);
  const others = layers.filter((l) => l.source !== 'user').map((l) => asObj(l.settings.hooks));
  const elsewhere = (event: string, matcher: unknown, id: string) => others.some((o) => asList(o[event]).map(asObj).some((g) =>
    (g.matcher ?? '') === (matcher ?? '') && asList(g.hooks).map(asObj).some((h) => hookId(event, h) === id)));
  const isOff = (event: string, matcher: unknown, id: string) => offSet.has(id) && !elsewhere(event, matcher, id);
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (LOCKED_EVENTS.includes(event) || !Array.isArray(groups)) {
      out[event] = groups;
      continue;
    }
    const kept: unknown[] = [];
    for (const g of groups) {
      if (!isObj(g) || !Array.isArray(g.hooks)) {
        kept.push(g);
        continue;
      }
      const hs = g.hooks.filter((h: unknown) => !(isObj(h) && isOff(event, g.matcher, hookId(event, h))));
      if (hs.length === g.hooks.length) kept.push(g);
      else {
        changed = true;
        if (hs.length) kept.push({ ...g, hooks: hs });
      }
    }
    if (kept.length) out[event] = kept;
    else changed = true;
  }
  return changed ? out : hooks;
}
