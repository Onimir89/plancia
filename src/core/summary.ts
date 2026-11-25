// What changes between the applied state and the new one, for the confirmation dialog.
import type { Category, Item, StateMap } from './types.js';
import { CATEGORIES, itemKey } from './types.js';

export type Timing = 'now' | 'next-session';

export interface Change {
  key: string;
  category: Category;
  id: string;
  name: string;
  on: boolean;
  /** MCP, rules, auto-memory and hooks only take effect from the next session. */
  timing: Timing;
  /** Switched off with a deny rule: blocked, but still listed to the model (plugin skills, agents). */
  blockedButVisible: boolean;
  protected: boolean;
}

export interface Summary {
  changes: Change[];
  byCategory: Record<Category, { on: string[]; off: string[] }>;
  /** Protected items being switched off: need a click and an extra confirmation. */
  protected: Change[];
  needsConfirmation: boolean;
}

function timing(i: Item): Timing {
  if (i.category === 'mcp' || i.category === 'rule') return 'next-session';
  // Hooks: a running session kept firing them after a hooks-only apply (seen live); presumably
  // because state.json is no settings file, so nothing makes Claude Code re-read the settings.
  if (i.category === 'hook') return 'next-session';
  return 'now';
}

export function summarize(items: Item[], from: StateMap, to: StateMap): Summary {
  const changes: Change[] = [];
  for (const i of items) {
    const k = itemKey(i);
    const a = from.get(k) ?? i.on;
    const b = to.get(k) ?? i.on;
    if (a === b || i.locked) continue;
    changes.push({
      key: k, category: i.category, id: i.id, name: i.name, on: b, timing: timing(i),
      blockedButVisible: !b && (i.mech.kind === 'denySkill' || i.mech.kind === 'denyAgent'),
      protected: i.protected,
    });
  }
  changes.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c, { on: [] as string[], off: [] as string[] }])) as Summary['byCategory'];
  for (const c of changes) byCategory[c.category][c.on ? 'on' : 'off'].push(c.key);
  const off = changes.filter((c) => c.protected && !c.on);
  return { changes, byCategory, protected: off, needsConfirmation: off.length > 0 };
}
