// The choice of one chat in state.json and the pure overlay on the merged settings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readInventory, resolvePreset, compile, applyPatch, resetProject, readState, appliedState, itemKey,
  overlay, sessionFrom, sessionState, saveSession, copySession, projectOnly, SESSION_TTL_DAYS, DEFAULT,
  type Preset, type SessionState, type StateMap, type Item,
} from '../src/core/index.ts';
import { MemFs } from '../src/core/memfs.ts';
import { hid, makeTree, ctx, DIRS, userSettings, ROOT, LOCAL } from './fixture.ts';

const STATE = '/h/.config/plancia/state.json';
const NOW = new Date(Date.UTC(2026, 10, 22, 10, 0, 0));
const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const days = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const chat = (over: Partial<SessionState> = {}): SessionState => ({ root: ROOT, preset: 'X', desired: { 'skill:alpha': false }, hooksOff: [], updatedAt: NOW.toISOString(), ...over });
const json = (fs: MemFs, p: string) => JSON.parse(fs.files.get(p)!);

// The project default of these tests: one item of every mechanism switched off, the agent too.
const DEFAULT_OFF = [
  'skill:alpha', 'plugin:pa@m', 'mcp:u1', 'mcp:pm1', `rule:${ROOT}/.claude/rules/r1.md`, 'agent:executor', 'skill:pa:s1',
  `hook:${hid('sync-guard.sh', 'PostToolUse')}`,
];
const D: Preset = { name: 'D', parent: DEFAULT, enable: [], disable: DEFAULT_OFF };

/** A project with the default D applied, its inventory and the layers Claude Code would merge (user, project, local). */
async function project() {
  const fs = makeTree();
  const inv0 = await readInventory(ctx(fs));
  await applyPatch(ctx(fs), compile(inv0.items, resolvePreset('D', [D], inv0.items)), { preset: 'D', now: NOW });
  const inv = await readInventory(ctx(fs));
  const ps = (await readState(fs, DIRS.state)).projects[ROOT];
  const layers = [
    { source: 'user', settings: userSettings() },
    { source: 'project', settings: json(fs, `${ROOT}/.claude/settings.json`) },
    { source: 'local', settings: json(fs, LOCAL) },
  ];
  return { fs, items: inv.items, ps, layers, merged: fold(layers.map((l) => l.settings)) };
}

// The engine's merge as its types describe it: a scalar from the last source, lists joined, objects merged.
function fold(all: Record<string, unknown>[]): Record<string, unknown> {
  const two = (a: any, b: any): any => {
    if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
    if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
      const out = { ...a };
      for (const k of Object.keys(b)) out[k] = k in a ? two(a[k], b[k]) : b[k];
      return out;
    }
    return b;
  };
  return all.reduce((acc, s) => two(acc, s), {});
}
const deepFreeze = <T>(o: T): T => {
  if (o && typeof o === 'object') {
    Object.values(o).forEach(deepFreeze);
    Object.freeze(o);
  }
  return o;
};
const baseline = (items: Item[]): StateMap => new Map(items.map((i) => [itemKey(i), i.on]));

test('readState reads an older state.json (no sessions) and refuses sessions that are not an object', async () => {
  const fs = makeTree({ [STATE]: JSON.stringify({ version: 1, projects: {} }) });
  assert.deepEqual(await readState(fs, DIRS.state), { version: 1, projects: {}, sessions: {}, created: {} });
  assert.deepEqual(await readState(makeTree(), DIRS.state), { version: 1, projects: {}, sessions: {}, created: {} });
  await assert.rejects(readState(makeTree({ [STATE]: JSON.stringify({ version: 1, projects: {}, sessions: [] }) }), DIRS.state), /state\.json/);
});

test('saveSession writes the chat, keeps the projects, drops chats untouched for 30 days; null removes the chat', async () => {
  const { fs, ps } = await project();
  const old = chat({ updatedAt: days(SESSION_TTL_DAYS + 1) });
  const recent = chat({ updatedAt: days(SESSION_TTL_DAYS - 1) });
  const raw = json(fs, STATE);
  fs.files.set(STATE, JSON.stringify({ ...raw, sessions: { old, recent } }));
  await saveSession(fs, DIRS.state, A, chat(), NOW);
  const st = json(fs, STATE);
  assert.deepEqual(st, { ...raw, sessions: { recent, [A]: chat() } });
  await saveSession(fs, DIRS.state, A, null, NOW);
  assert.deepEqual(json(fs, STATE).sessions, { recent });
});

test('copySession gives the choice to the new id (/clear, /branch) and keeps the old one; no choice → nothing written', async () => {
  const fs = makeTree();
  await saveSession(fs, DIRS.state, A, chat({ updatedAt: days(3) }), NOW);
  const later = new Date(NOW.getTime() + 1000);
  assert.equal(await copySession(fs, DIRS.state, A, B, later), true);
  assert.deepEqual(json(fs, STATE).sessions, { [A]: chat({ updatedAt: days(3) }), [B]: chat({ updatedAt: later.toISOString() }) });
  const before = fs.files.get(STATE);
  assert.equal(await copySession(fs, DIRS.state, 'nobody', B, later), false);
  assert.equal(await copySession(fs, DIRS.state, A, A, later), false);
  assert.equal(fs.files.get(STATE), before);
});

test('applyPatch (Make default) keeps the chats; reset drops the chats of that project only', async () => {
  const fs = makeTree();
  const other = chat({ root: '/h/other' });
  await saveSession(fs, DIRS.state, A, chat(), NOW);
  await saveSession(fs, DIRS.state, B, other, NOW);
  const inv = await readInventory(ctx(fs));
  await applyPatch(ctx(fs), compile(inv.items, resolvePreset('D', [D], inv.items)), { preset: 'D', now: NOW });
  assert.deepEqual(json(fs, STATE).sessions, { [A]: chat(), [B]: other });
  // a chat untouched for 31 days goes at the next write of state.json, whoever writes it
  const st = json(fs, STATE);
  fs.files.set(STATE, JSON.stringify({ ...st, sessions: { ...st.sessions, old: chat({ updatedAt: days(31) }) } }));
  await resetProject(ctx(fs), { now: NOW });
  assert.deepEqual(json(fs, STATE), { version: 1, projects: {}, sessions: { [B]: other }, created: {} });
});

test('projectOnly: agents and plugin skills (permissions are read from the files)', async () => {
  const { items } = await project();
  assert.deepEqual(items.filter(projectOnly).map(itemKey).sort(), [
    'agent:blocked-agent', 'agent:executor', 'agent:projagent', 'skill:pa:c1', 'skill:pa:s1',
  ]);
});

test('sessionFrom keeps only what differs from the configuration without Plancia, never agents, plugin skills or locked SessionStart hooks', async () => {
  const { items, ps } = await project();
  const desired = baseline(items);
  for (const k of ['skill:cmd1', 'agent:projagent', 'skill:pa:c1', `hook:${hid('resource-guard.cjs', 'PreToolUse')}`, `hook:${hid('compressor-gate.cjs', 'PostToolUse')}`, `hook:${hid('compressor-gate.cjs', 'SessionStart')}`]) desired.set(k, false);
  desired.set('plugin:pb@m', true);
  desired.set('agent:blocked-agent', true); // locked by the user's own list
  const ss = sessionFrom(items, desired, ps, { root: ROOT, preset: 'Mine', now: NOW });
  assert.deepEqual(ss, {
    root: ROOT, preset: 'Mine', updatedAt: NOW.toISOString(),
    desired: { 'skill:cmd1': false, 'plugin:pb@m': true, [`hook:${hid('resource-guard.cjs', 'PreToolUse')}`]: false, [`hook:${hid('compressor-gate.cjs', 'PostToolUse')}`]: false },
    hooksOff: [hid('compressor-gate.cjs', 'PostToolUse'), hid('resource-guard.cjs', 'PreToolUse')],
  });
  // what the chat runs: its own choice, the default for the project-only items
  const s = sessionState(items, ps, ss);
  const expected = baseline(items);
  for (const [k, on] of Object.entries(ss.desired)) expected.set(k, on);
  for (const k of ['agent:executor', 'skill:pa:s1']) expected.set(k, false);
  assert.deepEqual([...s].sort(), [...expected].sort());
});

test('overlay without a choice for the chat: the merged settings as they are, the same object', async () => {
  const { items, ps, layers, merged } = await project();
  assert.equal(overlay(merged, items, ps, undefined, layers), merged);
});

test('overlay: the chat turns back on skill, plugin, MCP (both lists) and rule the default switches off; agents stay the default', async () => {
  const { items, ps, layers, merged } = await project();
  const all = baseline(items); // the user's own configuration, agent executor and plugin skill included
  const ss = sessionFrom(items, all, ps, { root: ROOT, preset: 'Default', now: NOW });
  assert.deepEqual(ss.desired, {});
  const out = overlay(deepFreeze(merged), items, ps, ss, deepFreeze(layers));
  const u = userSettings();
  assert.deepEqual(out, {
    // alpha back to the user's own value, not a plain "on"
    skillOverrides: { 'userskill-off': 'off', 'anthropic-skills:docx': 'off', alpha: 'name-only' },
    enabledPlugins: { 'pa@m': true, 'pb@m': false, 'plancia@local': true },
    deniedMcpServers: [{ serverName: 'claude.ai Gmail' }, { serverName: 'claude.ai Old' }],
    enabledMcpjsonServers: ['pm1', 'pm2'],
    disabledMcpjsonServers: [],
    claudeMdExcludes: [],
    // permissions come from the files anyway: the default's denies stay
    permissions: { deny: ['Agent(blocked-agent)', 'Read(//h/.ssh/**)', 'Skill(pa:s1)', 'Agent(executor)'] },
    autoMemoryDirectory: '~/mem',
    hooks: u.hooks,
  });
});

test('overlay after a default killed half way: what the local file does not hold yet is not taken for off', async () => {
  const { items, ps, layers, merged } = await project();
  const ss = sessionFrom(items, new Map([...baseline(items), ['skill:cmd1', false]]), ps, { root: ROOT, preset: 'Mine', now: NOW });
  const entry = { item: 'skill:cmd1', on: false, kind: 'set' as const, path: ['skillOverrides', 'cmd1'], value: 'off', prev: { present: false } };
  const half = { ...ps!, entries: [...ps!.entries, entry], pending: true as const };
  assert.deepEqual(overlay(merged, items, half, ss, layers), overlay(merged, items, ps, ss, layers));
  assert.equal((overlay(merged, items, half, ss, layers) as any).skillOverrides.cmd1, 'off');
});

test('overlay: the chat switches off what the default leaves on and keeps what it agrees on', async () => {
  const { items, ps, layers, merged } = await project();
  const desired = appliedState(items, ps); // starts from the default, as a new chat does
  for (const k of ['skill:cmd1', 'mcp:loc1', 'mcp:pm2', `rule:${ROOT}/CLAUDE.md`, 'agent:projagent', 'skill:pa:c1']) desired.set(k, false);
  desired.set('plugin:pb@m', true);
  const ss = sessionFrom(items, desired, ps, { root: ROOT, preset: 'D (modified)', now: NOW });
  const out = overlay(merged, items, ps, ss, layers);
  assert.deepEqual(out, {
    skillOverrides: { 'userskill-off': 'off', 'anthropic-skills:docx': 'off', alpha: 'off', cmd1: 'off' },
    enabledPlugins: { 'pa@m': false, 'pb@m': true, 'plancia@local': true },
    deniedMcpServers: [{ serverName: 'claude.ai Gmail' }, { serverName: 'claude.ai Old' }, { serverName: 'u1' }, { serverName: 'loc1' }],
    enabledMcpjsonServers: ['pm1', 'pm2'],
    disabledMcpjsonServers: ['pm1', 'pm2'],
    claudeMdExcludes: [`${ROOT}/.claude/rules/r1.md`, `${ROOT}/CLAUDE.md`],
    permissions: { deny: ['Agent(blocked-agent)', 'Read(//h/.ssh/**)', 'Skill(pa:s1)', 'Agent(executor)'] },
    autoMemoryDirectory: '~/mem',
    hooks: userSettings().hooks,
  });
});

test('overlay leaves alone an item a higher layer (--settings, policy) or a hand edit of the local holds', async () => {
  const { items, ps, layers, merged } = await project();
  const ss = sessionFrom(items, baseline(items), ps, { root: ROOT, preset: 'Default', now: NOW });
  // a flag layer keeps alpha off; the user flipped pa@m by hand in the local after Plancia wrote it
  const flag = { source: 'flag', settings: { skillOverrides: { alpha: 'off' } } };
  const m = structuredClone(merged) as any;
  m.enabledPlugins['pa@m'] = 'hand';
  const out = overlay(m, items, ps, ss, [...layers, flag]) as any;
  assert.equal(out.skillOverrides.alpha, 'off');
  assert.equal(out.enabledPlugins['pa@m'], 'hand');
  // the others still follow the chat
  assert.deepEqual(out.deniedMcpServers, [{ serverName: 'claude.ai Gmail' }, { serverName: 'claude.ai Old' }]);
});

test('overlay: a list value a layer other than the local holds stays, though the default wrote it too', async () => {
  const { items, ps, layers, merged } = await project();
  const ss = sessionFrom(items, baseline(items), ps, { root: ROOT, preset: 'Default', now: NOW });
  // a --settings layer denies u1 as well; the engine's merge holds the value once
  const flag = { source: 'flag', settings: { deniedMcpServers: [{ serverName: 'u1' }] } };
  const out = overlay(merged, items, ps, ss, [...layers, flag]) as any;
  assert.deepEqual(out.deniedMcpServers, [{ serverName: 'claude.ai Gmail' }, { serverName: 'claude.ai Old' }, { serverName: 'u1' }]);
  // a plugin layer the same, on another list
  const plugin = { source: 'plugin', settings: { claudeMdExcludes: [`${ROOT}/.claude/rules/r1.md`] } };
  assert.deepEqual((overlay(merged, items, ps, ss, [plugin, ...layers]) as any).claudeMdExcludes, [`${ROOT}/.claude/rules/r1.md`]);
});

test('a protected item the default switches back on goes back on in every chat of the folder, in the same write', async () => {
  const fs = makeTree();
  const HOOK = hid('resource-guard.cjs', 'PreToolUse');
  const RED = [`hook:${HOOK}`, 'rule:/h/team/rules.md'];
  const R: Preset = { name: 'R', parent: DEFAULT, enable: [], disable: [...DEFAULT_OFF, ...RED, 'skill:cmd1'] };
  const inv0 = await readInventory(ctx(fs));
  assert.deepEqual(RED.map((k) => inv0.items.find((i) => itemKey(i) === k)?.protected), [true, true]);
  await applyPatch(ctx(fs), compile(inv0.items, resolvePreset('R', [R], inv0.items)), { preset: 'R', now: NOW });
  const inv = await readInventory(ctx(fs));
  const psR = (await readState(fs, DIRS.state)).projects[ROOT];
  // Apply in a chat that starts from the default: the protected items the default has off come along, with no extra confirmation
  const a = sessionFrom(inv.items, appliedState(inv.items, psR), psR, { root: ROOT, preset: 'R', now: NOW });
  assert.deepEqual(RED.map((k) => a.desired[k]), [false, false]);
  assert.ok(a.hooksOff.includes(HOOK));
  const elsewhere = { ...a, root: '/h/other' };
  await saveSession(fs, DIRS.state, A, a, NOW);
  await saveSession(fs, DIRS.state, B, elsewhere, NOW);
  // Make default with D: the protected items are on again, cmd1 (not protected) stays the chat's
  await applyPatch(ctx(fs), compile(inv.items, resolvePreset('D', [D], inv.items)), { preset: 'D', now: NOW });
  const s1 = json(fs, STATE).sessions;
  const desired = Object.fromEntries(Object.entries(a.desired).filter(([k]) => !RED.includes(k)));
  assert.equal(desired['skill:cmd1'], false);
  assert.deepEqual(s1, { [A]: { ...a, desired, hooksOff: a.hooksOff.filter((h) => h !== HOOK) }, [B]: elsewhere });
  // a protected item a chat switched off itself, while the default leaves it on, stays off when the default changes otherwise
  const c = { ...chat({ desired: { [RED[0]]: false }, hooksOff: [HOOK] }) };
  await saveSession(fs, DIRS.state, A, c, NOW);
  const Second: Preset = { ...D, name: 'Second', disable: [...DEFAULT_OFF, 'skill:cmd1'] };
  await applyPatch(ctx(fs), compile(inv.items, resolvePreset('Second', [Second], inv.items)), { preset: 'Second', now: NOW });
  const st = json(fs, STATE);
  assert.equal(st.projects[ROOT].preset, 'Second');
  assert.deepEqual(st.sessions[A], c);
});

test('a hooks-only change of the default rewrites the local file unchanged, so every open chat merges again', async () => {
  const fs = makeTree();
  const inv = await readInventory(ctx(fs));
  await applyPatch(ctx(fs), compile(inv.items, resolvePreset('D', [D], inv.items)), { preset: 'D', now: NOW });
  const before = fs.files.get(LOCAL);
  assert.ok(before);
  const renames: string[] = [];
  const rename = fs.rename.bind(fs);
  fs.rename = async (from, to) => { renames.push(to); return rename(from, to); };
  const Third: Preset = { ...D, name: 'Third', disable: DEFAULT_OFF.filter((k) => k !== `hook:${hid('sync-guard.sh', 'PostToolUse')}`) };
  const res = await applyPatch(ctx(fs), compile(inv.items, resolvePreset('Third', [Third], inv.items)), { preset: 'Third', now: NOW });
  assert.equal(res.wrote, false);
  assert.deepEqual(renames.filter((p) => p === LOCAL), [LOCAL]);
  assert.equal(fs.files.get(LOCAL), before);
  // nothing changes at all: no rewrite
  renames.length = 0;
  await applyPatch(ctx(fs), compile(inv.items, resolvePreset('Third', [Third], inv.items)), { preset: 'Third', now: NOW });
  assert.deepEqual(renames.filter((p) => p === LOCAL), []);
});

test('the inventory unreadable while a protected item goes back on: the chats get back every item turned on that it does not list, state still written', async () => {
  const fs = makeTree();
  const HOOK = hid('resource-guard.cjs', 'PreToolUse');
  const R: Preset = { name: 'R', parent: DEFAULT, enable: [], disable: [...DEFAULT_OFF, `hook:${HOOK}`, 'skill:cmd1'] };
  const inv = await readInventory(ctx(fs));
  await applyPatch(ctx(fs), compile(inv.items, resolvePreset('R', [R], inv.items)), { preset: 'R', now: NOW });
  const psR = (await readState(fs, DIRS.state)).projects[ROOT];
  const a = sessionFrom(inv.items, appliedState(inv.items, psR), psR, { root: ROOT, preset: 'R', now: NOW });
  await saveSession(fs, DIRS.state, A, a, NOW);
  const list = fs.list.bind(fs);
  fs.list = async (dir) => { if (/\/(backups|lock)/.test(dir)) return list(dir); throw new Error('EIO'); };
  await applyPatch(ctx(fs), compile(inv.items, resolvePreset('D', [D], inv.items)), { preset: 'D', now: NOW });
  fs.list = list;
  const st = json(fs, STATE);
  assert.equal(st.projects[ROOT].preset, 'D');
  assert.equal(st.sessions[A].desired[`hook:${HOOK}`], undefined);
  assert.equal(st.sessions[A].desired['skill:cmd1'], undefined);
  assert.ok(!st.sessions[A].hooksOff.includes(HOOK));
});
