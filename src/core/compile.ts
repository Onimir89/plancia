// Desired state → patch of settings.local.json + hooks to switch off. Never emits disableAllHooks.
import type { Item, Patch, PatchOp, StateMap } from './types.js';
import { itemKey } from './types.js';

// A path as a glob that matches only itself: a file named "~/**/rules.md" must not exclude every rules.md.
const literalGlob = (path: string) => path.replace(/[\\*?[\]{}()!]/g, '\\$&');

export function opFor(i: Item, on: boolean): Omit<PatchOp, 'item' | 'on'> | null {
  switch (i.mech.kind) {
    case 'skillOverride': return { kind: 'set', path: ['skillOverrides', i.id], value: on ? 'on' : 'off' };
    case 'plugin': return { kind: 'set', path: ['enabledPlugins', i.id], value: on };
    case 'autoMemory': return { kind: 'set', path: ['autoMemoryEnabled'], value: on };
    case 'mcpjson': return { kind: 'add', path: [on ? 'enabledMcpjsonServers' : 'disabledMcpjsonServers'], value: i.id };
    case 'denySkill': return on ? null : { kind: 'add', path: ['permissions', 'deny'], value: `Skill(${i.id})` };
    case 'denyAgent': return on ? null : { kind: 'add', path: ['permissions', 'deny'], value: `Agent(${i.id})` };
    case 'mcpDeny': return on ? null : { kind: 'add', path: ['deniedMcpServers'], value: { serverName: i.id } };
    case 'claudeMdExclude': return on ? null : { kind: 'add', path: ['claudeMdExcludes'], value: literalGlob(i.path) };
    case 'hook': return null;
  }
}

/** Only items whose desired state differs from today's baseline produce an op; locked items never do. */
export function compile(items: Item[], desired: StateMap): Patch {
  const ops: PatchOp[] = [];
  const hooksOff: string[] = [];
  for (const i of items) {
    const want = desired.get(itemKey(i)) ?? i.on;
    if (want === i.on || i.locked) continue;
    if (i.mech.kind === 'hook') {
      hooksOff.push(i.id);
      continue;
    }
    const op = opFor(i, want);
    if (op) ops.push({ item: itemKey(i), on: want, ...op });
  }
  return { ops, hooksOff };
}
