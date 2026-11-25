import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readInventory, itemKey, resolvePreset, loadPresets, savePreset, deletePreset, listPresets,
  DEFAULT, MINIMAL, appliedState, isReserved, presetFrom, sessionState, diffKeys, type Preset, type Item,
} from '../src/core/index.ts';
import { hid, makeTree, ctx, DIRS, ROOT } from './fixture.ts';

const START = `hook:${hid('compressor-gate.cjs', 'SessionStart')}`;
const items = async () => (await readInventory(ctx(makeTree()))).items;

test('Minimal turns everything off but the locked SessionStart hooks, Default equals today', async () => {
  const it = await items();
  const base = resolvePreset(MINIMAL, [], it);
  assert.deepEqual([...base].filter(([, v]) => v).map(([k]) => k), [START]);
  assert.equal(base.size, it.length);
  const sys = resolvePreset(DEFAULT, [], it);
  for (const i of it) assert.equal(sys.get(itemKey(i)), i.on, itemKey(i));
});

test('child presets apply enable/disable over the parent', async () => {
  const it = await items();
  const presets: Preset[] = [
    { name: 'Lean', parent: MINIMAL, enable: ['skill:alpha', 'rule:/h/.claude/CLAUDE.md'], disable: [] },
    { name: 'Lean2', parent: 'Lean', enable: [], disable: ['skill:alpha'] },
  ];
  const lean = resolvePreset('Lean', presets, it);
  assert.deepEqual([...lean].filter(([, v]) => v).map(([k]) => k).sort(), [START, 'rule:/h/.claude/CLAUDE.md', 'skill:alpha']);
  const lean2 = resolvePreset('Lean2', presets, it);
  assert.deepEqual([...lean2].filter(([, v]) => v).map(([k]) => k), ['rule:/h/.claude/CLAUDE.md', START]);
});

test('items that appear later inherit from the parent', async () => {
  const it = await items();
  const presets: Preset[] = [
    { name: 'FromSys', parent: DEFAULT, enable: [], disable: ['skill:alpha'] },
    { name: 'FromBase', parent: MINIMAL, enable: ['skill:alpha'], disable: [] },
  ];
  const newcomer: Item = { ...it[0], id: 'brand-new', on: true };
  const more = [...it, newcomer];
  assert.equal(resolvePreset('FromSys', presets, more).get('skill:brand-new'), true);
  assert.equal(resolvePreset('FromBase', presets, more).get('skill:brand-new'), false);
});

test('unknown preset and parent cycles are errors', async () => {
  const it = await items();
  assert.throws(() => resolvePreset('Nope', [], it), /Nope/);
  const cyc: Preset[] = [
    { name: 'A', parent: 'B', enable: [], disable: [] },
    { name: 'B', parent: 'A', enable: [], disable: [] },
  ];
  assert.throws(() => resolvePreset('A', cyc, it), /cycle/i);
});

test('archive in ~/.config/plancia/presets.json: save, load, delete', async () => {
  const fs = makeTree();
  assert.deepEqual(await loadPresets(fs, DIRS.state), []);
  await savePreset(fs, DIRS.state, { name: 'Lean', parent: MINIMAL, enable: ['skill:alpha'], disable: [] });
  await savePreset(fs, DIRS.state, { name: 'Lean+', parent: 'Lean', enable: [], disable: [] });
  await savePreset(fs, DIRS.state, { name: 'Lean', parent: MINIMAL, enable: ['skill:alpha', 'agent:executor'], disable: [] });
  const raw = JSON.parse((await fs.readText('/h/.config/plancia/presets.json'))!);
  assert.equal(raw.version, 1);
  const loaded = await loadPresets(fs, DIRS.state);
  assert.deepEqual(loaded.map((p) => p.name), ['Lean', 'Lean+']);
  assert.deepEqual(loaded[0].enable, ['skill:alpha', 'agent:executor']);
  assert.deepEqual(listPresets(loaded).map((p) => p.name), [DEFAULT, MINIMAL, 'Lean', 'Lean+']);
  await assert.rejects(deletePreset(fs, DIRS.state, 'Lean'), /Lean\+/);
  await deletePreset(fs, DIRS.state, 'Lean+');
  assert.deepEqual((await loadPresets(fs, DIRS.state)).map((p) => p.name), ['Lean']);
});

test('built-in presets cannot be saved over or deleted; parents must exist', async () => {
  const fs = makeTree();
  await assert.rejects(savePreset(fs, DIRS.state, { name: MINIMAL, parent: null, enable: [], disable: [] }), /Minimal/);
  await assert.rejects(savePreset(fs, DIRS.state, { name: 'X', parent: null, enable: [], disable: [] }), /based on/);
  await assert.rejects(savePreset(fs, DIRS.state, { name: 'X', parent: 'Missing', enable: [], disable: [] }), /Missing/);
  await assert.rejects(deletePreset(fs, DIRS.state, DEFAULT), /Default/);
  assert.equal(await fs.readText('/h/.config/plancia/presets.json'), null);
});

test('the built-in names are reserved, however spelled', async () => {
  const fs = makeTree();
  for (const name of ['Default', 'Minimal', ' minimal ', 'DEFAULT']) {
    assert.equal(isReserved(name), true, name);
    await assert.rejects(savePreset(fs, DIRS.state, { name, parent: MINIMAL, enable: [], disable: [] }), name.trim() === name ? new RegExp(name) : /minimal/);
  }
  assert.equal(isReserved('Minimal 2'), false);
  assert.equal(await fs.readText('/h/.config/plancia/presets.json'), null);
});

test('locked items stay as they are under every preset, chat and old record: none shows as a change', async () => {
  const it = await items();
  const locked = it.filter((i) => i.locked);
  const today = locked.map((i) => [itemKey(i), i.on]);
  assert.deepEqual(today.map(([k]) => k).sort(), ['agent:blocked-agent', START, 'mcp:claude.ai Gmail', 'mcp:claude.ai Old']);
  const flipped = { enable: locked.filter((i) => !i.on).map(itemKey), disable: locked.filter((i) => i.on).map(itemKey) };
  const presets: Preset[] = [{ name: 'P', parent: DEFAULT, ...flipped }];
  const entries = locked.map((i) => ({ item: itemKey(i), on: !i.on, kind: 'add' as const, path: ['x'], value: i.id, prev: { present: false } }));
  const ps = { preset: 'P', appliedAt: 'x', entries, hooksOff: [], createdPaths: [] };
  const ss = { root: ROOT, preset: 'P', desired: Object.fromEntries(locked.map((i) => [itemKey(i), !i.on])), hooksOff: [], updatedAt: 'x' };
  for (const m of [resolvePreset(DEFAULT, [], it), resolvePreset(MINIMAL, [], it), resolvePreset('P', presets, it), appliedState(it, ps), sessionState(it, ps, ss)])
    assert.deepEqual(locked.map((i) => [itemKey(i), m.get(itemKey(i))]), today);
  // saved here, where they are locked, the preset keeps what it says of them
  assert.deepEqual(presetFrom('P', DEFAULT, resolvePreset('P', presets, it), presets, it), {
    name: 'P', parent: DEFAULT, enable: [...flipped.enable].sort(), disable: flipped.disable,
  });
});

test('presetFrom keeps what the preset says of items this project does not have', async () => {
  const it = await items();
  const presets: Preset[] = [
    { name: 'Lean', parent: MINIMAL, enable: ['skill:alpha', 'skill:elsewhere', 'rule:/h/two/CLAUDE.md'], disable: ['mcp:elsewhere', 'skill:projskill'] },
    { name: 'Other', parent: MINIMAL, enable: ['skill:not-mine'], disable: [] },
  ];
  const desired = resolvePreset('Lean', presets, it);
  desired.set('skill:alpha', false).set('skill:cmd1', true);
  const saved = presetFrom('Lean', MINIMAL, desired, presets, it);
  assert.deepEqual(saved, { name: 'Lean', parent: MINIMAL, enable: ['rule:/h/two/CLAUDE.md', 'skill:cmd1', 'skill:elsewhere'], disable: ['mcp:elsewhere'] });
  // in the project that has it, the item is still on
  const elsewhere: Item = { ...it[0]!, id: 'elsewhere' };
  assert.equal(resolvePreset('Lean', [saved], [...it, elsewhere]).get('skill:elsewhere'), true);
  // a new preset is born without them: they come from its parent
  assert.deepEqual(presetFrom('Child', 'Lean', resolvePreset('Lean', [saved], it), [saved], it), { name: 'Child', parent: 'Lean', enable: [], disable: [] });
});

test('presetFrom stores only the differences from the parent and resolves back to the state', async () => {
  const it = await items();
  const desired = resolvePreset(DEFAULT, [], it);
  desired.set('skill:alpha', !desired.get('skill:alpha'));
  desired.set('agent:executor', false);
  const p = presetFrom('Mine', DEFAULT, desired, [], it);
  assert.equal(p.parent, DEFAULT);
  assert.deepEqual([...p.enable, ...p.disable].sort(), [...diffKeys(desired, resolvePreset(DEFAULT, [], it))].sort());
  const back = resolvePreset('Mine', [p], it);
  for (const [k, v] of desired) assert.equal(back.get(k), v, k);
  const child = presetFrom('Child', 'Mine', back, [p], it);
  assert.deepEqual([child.enable, child.disable], [[], []]);
});

test('diffKeys lists the keys whose state differs', () => {
  const a = new Map([['x', true], ['y', false], ['z', true]]);
  const b = new Map([['x', true], ['y', true], ['w', false]]);
  assert.deepEqual([...diffKeys(a, b)].sort(), ['w', 'y', 'z']);
});
