import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readInventory, setCategory, readPanelRows, stepPanelRows, panelPath, PANEL_ROWS, itemKey, localStamp, fingerprint, applyPatch, readState,
  loadPresets, savePreset, deletePreset, type StateMap,
} from '../src/core/index.ts';
import { MemFs } from '../src/core/memfs.ts';
import { hid, makeTree, ctx, DIRS, EXPECTED_KEYS, ROOT, LOCAL } from './fixture.ts';

const sorted = (m: StateMap) => [...m].sort(([a], [b]) => (a < b ? -1 : 1));
const PANEL = '/h/.config/plancia/panel.json';
const PRESETS = '/h/.config/plancia/presets.json';

test('setCategory switches only the listed ids of the category, skipping locked ones', async () => {
  const inv = await readInventory(ctx(makeTree()));
  const base = () => new Map(inv.items.map((i) => [itemKey(i), i.on])) as StateMap;
  const from = base();
  // mcp:claude.ai Gmail is locked (denied in user settings); 'alpha' is a skill id, not an mcp: ignored.
  const off = setCategory(inv.items, from, 'mcp', ['u1', 'pm1', 'claude.ai Gmail', 'alpha', 'missing'], false);
  assert.deepEqual(sorted(off), sorted(base().set('mcp:u1', false).set('mcp:pm1', false)));
  assert.deepEqual([...off.keys()].sort(), EXPECTED_KEYS);
  assert.notEqual(off, from);
  assert.deepEqual(sorted(from), sorted(base()), 'input untouched');

  const on = setCategory(inv.items, off, 'mcp', ['u1', 'pm1', 'claude.ai Gmail'], true);
  assert.deepEqual(sorted(on), sorted(base().set('mcp:u1', true).set('mcp:pm1', true)));
});

test('setCategory includes protected items (the extra confirmation is summarize’s job)', async () => {
  const inv = await readInventory(ctx(makeTree()));
  const prot = inv.items.filter((i) => i.protected && !i.locked && i.category === 'hook');
  assert.ok(prot.length > 0, 'fixture has protected hooks');
  const from: StateMap = new Map(inv.items.map((i) => [itemKey(i), i.on]));
  const out = setCategory(inv.items, from, 'hook', prot.map((i) => i.id), false);
  const expected = new Map(from);
  for (const i of prot) expected.set(itemKey(i), false);
  assert.deepEqual(sorted(out), sorted(expected));
});

test('setCategory skips the rules loaded only through rules switched off, as a click on them is refused', async () => {
  const inv = await readInventory(ctx(makeTree()));
  const from: StateMap = new Map(inv.items.map((i) => [itemKey(i), i.on]));
  from.set('rule:/h/.claude/CLAUDE.md', false); // rules.md is imported only by it: shown off, no switch
  const out = setCategory(inv.items, from, 'rule', ['/h/team/rules.md', '/h/CLAUDE.md'], false);
  assert.deepEqual(sorted(out), sorted(new Map(from).set('rule:/h/CLAUDE.md', false)));
  assert.equal(out.get('rule:/h/team/rules.md'), true, 'left as it was');
  // switching on: a rule whose importers stay off stays as it was too
  const blocked = new Map(from).set('rule:/h/team/rules.md', false);
  const on = setCategory(inv.items, blocked, 'rule', ['/h/team/rules.md', '/h/CLAUDE.md'], true);
  assert.deepEqual(sorted(on), sorted(new Map(blocked).set('rule:/h/CLAUDE.md', true)));
});

test('All off then All on on the rules switches every rule on again, imported ones included', async () => {
  const inv = await readInventory(ctx(makeTree()));
  const from: StateMap = new Map(inv.items.map((i) => [itemKey(i), i.on]));
  const ids = inv.items.filter((i) => i.category === 'rule').map((i) => i.id);
  const RULES = [
    '/h/.claude/CLAUDE.md', '/h/team/rules.md', '/h/team/other.md', '/h/team/nested.md',
    '/h/CLAUDE.md', `${ROOT}/CLAUDE.md`, `${ROOT}/.claude/rules/r1.md`, '/h/mem/MEMORY.md',
  ];
  assert.deepEqual([...ids].sort(), [...RULES].sort());
  const off = setCategory(inv.items, from, 'rule', ids, false);
  const allOff = new Map(from);
  for (const r of RULES) allOff.set(`rule:${r}`, false);
  assert.deepEqual(sorted(off), sorted(allOff));
  const on = setCategory(inv.items, off, 'rule', ids, true);
  const allOn = new Map(from);
  for (const r of RULES) allOn.set(`rule:${r}`, true);
  assert.deepEqual(sorted(on), sorted(allOn));
});

test('fingerprint changes with the project state, the inventory and the presets, not with another project', async () => {
  const fs = makeTree({ [PRESETS]: JSON.stringify({ version: 1, presets: [{ name: 'P', parent: 'Default', enable: [], disable: [] }] }) });
  const read = async () => ({
    inv: await readInventory(ctx(fs)), ps: (await readState(fs, DIRS.state)).projects[ROOT], user: await loadPresets(fs, DIRS.state),
  });
  const d0 = await read();
  assert.equal(fingerprint(await read()), fingerprint(d0), 'same disk, same fingerprint');
  await applyPatch(ctx(fs, '/elsewhere'), { ops: [], hooksOff: ['a.sh:Stop'] }, { preset: 'X', now: new Date(0) });
  assert.equal(fingerprint(await read()), fingerprint(d0), 'another project');
  const prints = [fingerprint(d0)];
  // the project's state: a protected hook switched off by the other writer
  await applyPatch(ctx(fs), { ops: [], hooksOff: [hid('resource-guard.cjs', 'PreToolUse')] }, { preset: 'Default (modified)', now: new Date(0) });
  prints.push(fingerprint(await read()));
  // the inventory: a hand edit of the local settings
  fs.files.set(LOCAL, JSON.stringify({ ...JSON.parse(fs.files.get(LOCAL) ?? '{}'), skillOverrides: { alpha: 'off' } }));
  prints.push(fingerprint(await read()));
  // the presets: one deleted, then one saved
  await deletePreset(fs, DIRS.state, 'P');
  prints.push(fingerprint(await read()));
  await savePreset(fs, DIRS.state, { name: 'Q', parent: 'Default', enable: [], disable: ['skill:alpha'] });
  prints.push(fingerprint(await read()));
  assert.equal(new Set(prints).size, prints.length, 'each change gives a new fingerprint');
});

test('panel rows: default when missing or invalid, clamp, atomic write in its own file', async () => {
  const fs = new MemFs();
  assert.equal(panelPath(DIRS.state), PANEL);
  assert.equal(await readPanelRows(fs, DIRS.state), PANEL_ROWS.default);
  for (const bad of ['not json', '[]', 'null', '{"rows":"7"}', '{"rows":7.5}', '{}'])
    assert.equal(await readPanelRows(new MemFs({ [PANEL]: bad }), DIRS.state), PANEL_ROWS.default, bad);
  assert.equal(await readPanelRows(new MemFs({ [PANEL]: '{"rows":1}' }), DIRS.state), PANEL_ROWS.min);
  assert.equal(await readPanelRows(new MemFs({ [PANEL]: '{"rows":999}' }), DIRS.state), PANEL_ROWS.max);

  assert.equal(await stepPanelRows(fs, DIRS.state, 4), PANEL_ROWS.default + 4);
  assert.equal(await readPanelRows(fs, DIRS.state), PANEL_ROWS.default + 4);
  assert.equal(await stepPanelRows(fs, DIRS.state, 999), PANEL_ROWS.max);
  assert.equal(await stepPanelRows(fs, DIRS.state, -999), PANEL_ROWS.min);
  assert.equal(await stepPanelRows(fs, DIRS.state, 5), 8);
  assert.equal(await readPanelRows(fs, DIRS.state), 8);
  assert.deepEqual([...fs.files.keys()], [PANEL], 'tmp renamed away, nothing else written');
  assert.deepEqual(JSON.parse(fs.files.get(PANEL)!), { version: 1, rows: 8 });
});

test('localStamp: local time, whatever the zone of the machine; what is no date stays as it is', () => {
  const zone = process.env.TZ;
  try {
    for (const [tz, stamp] of [['UTC', '2026-11-19 08:38'], ['Pacific/Auckland', '2026-11-19 21:38'], ['America/New_York', '2026-11-19 03:38']] as const) {
      process.env.TZ = tz;
      assert.equal(localStamp('2026-11-19T08:38:25.392Z'), stamp);
    }
  } finally {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }
  assert.equal(localStamp('x'), 'x');
});
