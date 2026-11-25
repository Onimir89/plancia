// Plugins synced from claude.ai: on without any entry in enabledPlugins, switched by one that is false.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MINIMAL, applyPatch, appliedState, compile, itemKey, overlay, projectOnly, projectOnlyEntry, readInventory, readState, resetProject, resolvePreset, sessionFrom, type StateMap,
} from '../src/core/index.ts';
import { ctx, DIRS, EXPECTED_KEYS, LOCAL, makeTree, ROOT, SYNCED, userSettings } from './fixture.ts';

const NOW = new Date(Date.UTC(2026, 10, 25));
const read = (extra: Record<string, string> = {}) => readInventory(ctx(makeTree({ ...SYNCED, ...extra })));
const plugins = async (extra?: Record<string, string>) =>
  Object.fromEntries((await read(extra)).items.filter((i) => i.category === 'plugin').map((i) => [i.id, i.on]));
const BASE = { 'pa@m': true, 'pb@m': false };

test('the plugins of the manifest, in the folder of their generation, with their skills (full comparison)', async () => {
  const { items, warnings } = await read();
  assert.deepEqual(items.map(itemKey).sort(), [
    ...EXPECTED_KEYS, 'plugin:data@synced', 'plugin:notes@synced', 'plugin:must@synced', 'plugin:quiet@synced', 'skill:data:query', 'skill:data:chart',
  ].sort());
  assert.deepEqual(warnings, []);
  const of = (k: string) => items.find((i) => itemKey(i) === k)!;
  const { name, description, source, path, locked, mech } = of('plugin:notes@synced');
  assert.deepEqual({ name, description, source, path, locked, mech }, {
    name: 'notes', description: 'Notes', source: 'synced', locked: null, mech: { kind: 'plugin' },
    path: '/h/.claude/plugins/synced/O_A/58da2c13-5ed4-4485-9625-fb87b369e6b4~g3',
  });
  assert.deepEqual([of('skill:data:query').source, of('skill:data:query').mech], ['plugin:data@synced', { kind: 'denySkill' }]);
  // one the organization requires: Claude Code loads it whatever enabledPlugins says
  assert.deepEqual(items.filter((i) => i.category === 'plugin' && i.locked).map((i) => [i.id, i.locked]), [['must@synced', 'required']]);
});

test('on unless enabledPlugins says false, or its own manifest when that says nothing', async () => {
  assert.deepEqual(await plugins(), { ...BASE, 'data@synced': true, 'notes@synced': true, 'must@synced': true, 'quiet@synced': false });
  const enabledPlugins = { 'data@synced': false, 'must@synced': false, 'quiet@synced': true };
  const local = { [LOCAL]: JSON.stringify({ enabledPlugins }) };
  assert.deepEqual(await plugins(local), { ...BASE, 'data@synced': false, 'notes@synced': true, 'must@synced': true, 'quiet@synced': true });
  // the skills of one that is off are not listed, as for an installed plugin
  assert.equal((await read(local)).items.some((i) => i.source === 'plugin:data@synced'), false);
});

test('one that installed_plugins.json has too is listed once, as it says', async () => {
  const p = '/h/.claude/plugins/installed_plugins.json';
  const { items } = await read({ [p]: JSON.stringify({ plugins: { 'data@synced': [{ scope: 'user', installPath: '/h/elsewhere' }] } }) });
  assert.deepEqual(items.filter((i) => i.id === 'data@synced').map((i) => [i.path, i.source]), [['/h/elsewhere', 'user']]);
  assert.equal(items.some((i) => i.source === 'plugin:data@synced'), false);
});

test('no account: the only folder there is; a manifest that is missing or broken lists nothing, the broken one with a warning', async () => {
  const noAccount = { '/h/.claude/.config.json': '{}' };
  assert.deepEqual(await plugins(noAccount), BASE);
  const one = Object.fromEntries(Object.entries(SYNCED).filter(([p]) => p.includes('/O_A/')));
  const { items } = await readInventory(ctx(makeTree({ ...one, ...noAccount })));
  assert.ok(items.some((i) => i.id === 'data@synced'));
  const manifest = '/h/.claude/plugins/synced/O_A/manifest.json';
  assert.deepEqual(await plugins({ [manifest]: '' }), BASE);
  assert.deepEqual(await plugins({ [manifest]: '{"plugins":[null,{"name":7},{"name":{"toString":1}},{"name":"data","generation":{"toString":1}}]}' }), BASE);
  assert.deepEqual((await read({ [manifest]: '{' })).warnings, [`${manifest} is not valid JSON`]);
});

test('Minimal as the default switches them off, not the required one; reset takes everything back', async () => {
  const fs = makeTree(SYNCED);
  const { items } = await readInventory(ctx(fs));
  await applyPatch(ctx(fs), compile(items, resolvePreset(MINIMAL, [], items)), { preset: MINIMAL, now: NOW });
  assert.deepEqual(JSON.parse(fs.files.get(LOCAL)!).enabledPlugins, { 'pa@m': false, 'data@synced': false, 'notes@synced': false });
  // the entries are Plancia's own: the configuration without it has them on
  assert.deepEqual((await readInventory(ctx(fs))).items, items);
  await resetProject(ctx(fs), { now: NOW });
  assert.equal(fs.files.has(LOCAL), false);
});

test("a chat never switches one: the merge keeps the default's entry, or none", async () => {
  const fs = makeTree(SYNCED);
  const { items } = await readInventory(ctx(fs));
  const want = (on: boolean): StateMap => new Map([...items.map((i) => [itemKey(i), i.on] as const), ['plugin:data@synced', on], ['plugin:quiet@synced', on]]);
  const run = async (on: boolean) => {
    const ps = (await readState(fs, DIRS.state)).projects[ROOT];
    const user = userSettings();
    const local = JSON.parse(fs.files.get(LOCAL) ?? '{}');
    const layers = [{ source: 'user', settings: user }, { source: 'local', settings: local }];
    const merged = { ...user, enabledPlugins: { ...(user.enabledPlugins as object), ...local.enabledPlugins } };
    const ss = sessionFrom(items, want(on), ps, { root: ROOT, preset: 'X', now: NOW });
    assert.deepEqual(ss.desired, {});
    // a choice saved before counts no more
    assert.deepEqual(overlay(merged, items, ps, { ...ss, desired: { 'plugin:data@synced': on } }, layers), merged);
  };
  await run(false);
  await applyPatch(ctx(fs), compile(items, want(false)), { preset: 'X', now: NOW });
  assert.equal(appliedState(items, (await readState(fs, DIRS.state)).projects[ROOT]).get('plugin:data@synced'), false);
  await run(true);
});

test('a marketplace whose name only ends like theirs is no synced one', async () => {
  const data = (await read()).items.find((i) => i.id === 'data@synced')!;
  for (const [id, yes] of [['data@synced', true], ['data@mysynced', false]] as const) {
    assert.deepEqual([projectOnly({ ...data, id }), projectOnlyEntry({ path: ['enabledPlugins', id], item: `plugin:${id}` } as any)], [yes, yes]);
  }
});
