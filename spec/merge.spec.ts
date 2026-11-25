import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readInventory, resolvePreset, compile, applyPatch, resetProject, readState, appliedState, itemKey,
  MINIMAL, DEFAULT, type Preset, type Patch,
} from '../src/core/index.ts';
import { MemFs } from '../src/core/memfs.ts';
import { hash } from '../src/core/util.ts';
import { hid, makeTree, ctx, DIRS, ROOT, LOCAL } from './fixture.ts';

const STATE = '/h/.config/plancia/state.json';
const BACKUPS = `/h/.config/plancia/backups/-h-p-proj-${hash(ROOT)}`;
let tick = 0;
const now = () => new Date(Date.UTC(2026, 10, 19, 10, 0, tick++));

async function patchFor(fs: MemFs, preset: string, presets: Preset[] = []): Promise<Patch> {
  const inv = await readInventory(ctx(fs));
  return compile(inv.items, resolvePreset(preset, presets, inv.items));
}
const local = async (fs: MemFs) => {
  const t = await fs.readText(LOCAL);
  return t === null ? null : JSON.parse(t);
};

test('Default on a project without local writes nothing but records the preset', async () => {
  const fs = makeTree();
  const r = await applyPatch(ctx(fs), await patchFor(fs, DEFAULT), { preset: DEFAULT, now: now() });
  assert.equal(r.wrote, false);
  assert.equal(await fs.readText(LOCAL), null);
  const st = await readState(fs, DIRS.state);
  assert.equal(st.projects[ROOT].preset, DEFAULT);
  assert.deepEqual(st.projects[ROOT].entries, []);
});

test('Minimal applied: local gets the patch, state tracks every entry, no backup when there was no file', async () => {
  const fs = makeTree();
  const p = await patchFor(fs, MINIMAL);
  const r = await applyPatch(ctx(fs), p, { preset: MINIMAL, now: now() });
  assert.equal(r.wrote, true);
  assert.equal(r.backup, null);
  const l = await local(fs);
  assert.equal(l.skillOverrides.alpha, 'off');
  assert.equal(l.autoMemoryEnabled, false);
  assert.ok(l.permissions.deny.includes('Agent(executor)'));
  assert.equal('disableAllHooks' in l, false);
  const st = await readState(fs, DIRS.state);
  assert.equal(st.projects[ROOT].entries.length, p.ops.length);
  assert.deepEqual(st.projects[ROOT].hooksOff, p.hooksOff);
  assert.deepEqual(Object.keys(st.projects), [ROOT]);
});

test('apply is idempotent: same patch twice and recompile after apply give the same file', async () => {
  const fs = makeTree({ [LOCAL]: JSON.stringify({ permissions: { allow: ['Bash(ls)'] } }) });
  const p1 = await patchFor(fs, MINIMAL);
  await applyPatch(ctx(fs), p1, { preset: MINIMAL, now: now() });
  const after1 = await fs.readText(LOCAL);
  const state1 = await fs.readText(STATE);
  const nBackups = (await fs.list(BACKUPS))!.length;
  const p2 = await patchFor(fs, MINIMAL); // inventory subtracts what plancia wrote
  assert.deepEqual(p2, p1);
  const r2 = await applyPatch(ctx(fs), p2, { preset: MINIMAL, now: now() });
  assert.equal(r2.wrote, false);
  assert.equal(await fs.readText(LOCAL), after1);
  assert.deepEqual(JSON.parse((await fs.readText(STATE))!).projects[ROOT].entries, JSON.parse(state1!).projects[ROOT].entries);
  assert.equal((await fs.list(BACKUPS))!.length, nBackups);
});

test('reset restores the local file exactly, including an empty object it had', async () => {
  const original = { permissions: { allow: ['Bash(ls)'], deny: ['Read(x)'] }, skillOverrides: {}, foo: 1, enabledPlugins: { 'pa@m': true } };
  const fs = makeTree({ [LOCAL]: JSON.stringify(original) });
  await applyPatch(ctx(fs), await patchFor(fs, MINIMAL), { preset: MINIMAL, now: now() });
  assert.notDeepEqual(await local(fs), original);
  const r = await resetProject(ctx(fs), { now: now() });
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(await local(fs), original);
  assert.deepEqual((await readState(fs, DIRS.state)).projects, {});
});

test('reset removes the local file plancia created', async () => {
  const fs = makeTree();
  await applyPatch(ctx(fs), await patchFor(fs, MINIMAL), { preset: MINIMAL, now: now() });
  assert.notEqual(await fs.readText(LOCAL), null);
  await resetProject(ctx(fs), { now: now() });
  assert.equal(await fs.readText(LOCAL), null);
});

test('retract never undoes an entry the user changed after apply', async () => {
  const fs = makeTree();
  await applyPatch(ctx(fs), await patchFor(fs, MINIMAL), { preset: MINIMAL, now: now() });
  const l = await local(fs);
  l.skillOverrides.alpha = 'on';                                   // the user flips it back by hand
  l.permissions.deny = l.permissions.deny.filter((d: string) => d !== 'Agent(executor)'); // and drops one deny
  l.permissions.deny.push('Bash(rm:*)');                            // and adds his own
  await fs.writeText(LOCAL, JSON.stringify(l));
  const r = await resetProject(ctx(fs), { now: now() });
  assert.deepEqual(r.conflicts.map((c) => c.item).sort(), ['agent:executor', 'skill:alpha']);
  const after = await local(fs);
  assert.deepEqual(after, { skillOverrides: { alpha: 'on' }, permissions: { deny: ['Bash(rm:*)'] } });
});

test('switching preset retracts entries no longer wanted and keeps the rest', async () => {
  const fs = makeTree();
  const presets: Preset[] = [
    { name: 'NoAlpha', parent: DEFAULT, enable: [], disable: ['skill:alpha', 'agent:executor'] },
    { name: 'NoAgent', parent: DEFAULT, enable: [], disable: ['agent:executor', `hook:${hid('sync-guard.sh', 'PostToolUse')}`] },
  ];
  await applyPatch(ctx(fs), await patchFor(fs, 'NoAlpha', presets), { preset: 'NoAlpha', now: now() });
  await applyPatch(ctx(fs), await patchFor(fs, 'NoAgent', presets), { preset: 'NoAgent', now: now() });
  assert.deepEqual(await local(fs), { permissions: { deny: ['Agent(executor)'] } });
  const st = (await readState(fs, DIRS.state)).projects[ROOT];
  assert.equal(st.preset, 'NoAgent');
  assert.deepEqual(st.hooksOff, [hid('sync-guard.sh', 'PostToolUse')]);
  const inv = await readInventory(ctx(fs));
  const applied = appliedState(inv.items, st);
  assert.equal(applied.get('agent:executor'), false);
  assert.equal(applied.get('skill:alpha'), true);
  assert.equal(applied.get(`hook:${hid('sync-guard.sh', 'PostToolUse')}`), false);
  assert.equal(inv.items.find((i) => itemKey(i) === 'agent:executor')!.on, true); // baseline ignores plancia
});

test('backups: one per write in ~/.config/plancia/backups/<project>/, only the last 5 kept', async () => {
  const fs = makeTree({ [LOCAL]: JSON.stringify({ foo: 0 }) });
  const names = ['skill:alpha', 'skill:projskill', 'agent:executor', 'agent:projagent', 'plugin:pa@m', 'mcp:u1', 'mcp:loc1'];
  for (const n of names) {
    const presets: Preset[] = [{ name: 'P', parent: DEFAULT, enable: [], disable: [n] }];
    await applyPatch(ctx(fs), await patchFor(fs, 'P', presets), { preset: 'P', now: now() });
  }
  const list = (await fs.list(BACKUPS))!.sort();
  assert.equal(list.length, 5);
  const newest = JSON.parse((await fs.readText(`${BACKUPS}/${list[4]}`))!);
  assert.deepEqual(newest, { foo: 0, deniedMcpServers: [{ serverName: 'u1' }] });
});

test('backups: each project has its own folder, whatever its path', async () => {
  const roots = ['/h/a/b', '/h/a-b', '/h/a_b', `/h/${'long/'.repeat(80)}a`, `/h/${'long/'.repeat(80)}b`];
  const fs = makeTree(Object.fromEntries(roots.map((r) => [`${r}/.claude/settings.local.json`, '{"foo":0}'])));
  const folders = [];
  for (const root of roots) {
    const r = await applyPatch(ctx(fs, root), { ops: [{ item: 'skill:alpha', on: false, kind: 'set', path: ['skillOverrides', 'alpha'], value: 'off' }], hooksOff: [] }, { preset: 'P', now: now() });
    folders.push(r.backup!.split('/').at(-2)!);
  }
  assert.equal(new Set(folders).size, roots.length);
  assert.match(folders[0]!, /^-h-a-b-[0-9a-f]{16}$/);
  assert.ok(folders.every((f) => f.length < 255));
});

test('a local changed between read and write aborts the apply', async () => {
  const fs = makeTree({ [LOCAL]: '{"foo":1}' });
  const p = await patchFor(fs, MINIMAL);
  let reads = 0;
  const racy = Object.create(fs) as MemFs;
  racy.readText = async (path: string) => {
    if (path === LOCAL && ++reads === 1) {
      const t = await fs.readText(path);
      await fs.writeText(LOCAL, '{"foo":2}');
      return t;
    }
    return fs.readText(path);
  };
  await assert.rejects(applyPatch(ctx(racy), p, { preset: MINIMAL, now: now() }), /changed/);
  assert.equal(await fs.readText(LOCAL), '{"foo":2}');
  assert.equal(await fs.readText(`${DIRS.state}/state.json`), null); // nor is anything recorded
});

test('a broken local is never overwritten', async () => {
  const fs = makeTree({ [LOCAL]: '{ nope' });
  await assert.rejects(applyPatch(ctx(fs), { ops: [{ item: 'skill:alpha', on: false, kind: 'set', path: ['skillOverrides', 'alpha'], value: 'off' }], hooksOff: [] }, { preset: 'X', now: now() }), /settings\.local\.json/);
  assert.equal(await fs.readText(LOCAL), '{ nope');
});

test('reset of an untouched project does nothing', async () => {
  const fs = makeTree();
  const r = await resetProject(ctx(fs), { now: now() });
  assert.equal(r.wrote, false);
  assert.equal(await fs.readText(STATE), null);
});

test('an entry the user changed by hand is neither tracked nor written back', async () => {
  const fs = makeTree();
  const p = await patchFor(fs, MINIMAL);
  await applyPatch(ctx(fs), p, { preset: MINIMAL, now: now() });
  const l = await local(fs);
  l.skillOverrides.alpha = 'on';                                   // the user flips it back by hand
  await fs.writeText(LOCAL, JSON.stringify(l));
  // the same patch again (Apply pressed twice): the hand edit stays and leaves plancia's tracking
  const r = await applyPatch(ctx(fs), p, { preset: MINIMAL, now: now() });
  assert.deepEqual(r.conflicts.map((c) => c.item), ['skill:alpha']);
  assert.equal((await local(fs)).skillOverrides.alpha, 'on');
  const st = await readState(fs, DIRS.state);
  assert.equal(st.projects[ROOT].entries.some((e) => e.item === 'skill:alpha'), false);
  // the pane reopens on what is applied: the next apply leaves it alone and reports nothing
  const inv = await readInventory(ctx(fs));
  const r2 = await applyPatch(ctx(fs), compile(inv.items, appliedState(inv.items, st.projects[ROOT])), { preset: MINIMAL, now: now() });
  assert.deepEqual(r2.conflicts, []);
  assert.equal((await local(fs)).skillOverrides.alpha, 'on');
});

test('an added list value the user removed by hand is not added back', async () => {
  const fs = makeTree();
  const p = await patchFor(fs, MINIMAL);
  await applyPatch(ctx(fs), p, { preset: MINIMAL, now: now() });
  const l = await local(fs);
  l.permissions.deny = l.permissions.deny.filter((d: string) => d !== 'Agent(executor)');
  await fs.writeText(LOCAL, JSON.stringify(l));
  const r = await applyPatch(ctx(fs), p, { preset: MINIMAL, now: now() });
  assert.deepEqual(r.conflicts.map((c) => c.item), ['agent:executor']);
  assert.equal((await local(fs)).permissions.deny.includes('Agent(executor)'), false);
});

test('a list value the user already had is never removed by plancia', async () => {
  const fs = makeTree({ [LOCAL]: JSON.stringify({ permissions: { deny: ['Bash(x)'] } }) });
  const patch: Patch = { ops: [{ item: 'x', on: false, kind: 'add', path: ['permissions', 'deny'], value: 'Bash(x)' }], hooksOff: [] };
  await applyPatch(ctx(fs), patch, { preset: 'X', now: now() });
  assert.deepEqual((await readState(fs, DIRS.state)).projects[ROOT].entries[0]!.prev, { present: true });
  await resetProject(ctx(fs), { now: now() });
  assert.deepEqual(await local(fs), { permissions: { deny: ['Bash(x)'] } });
});
