// protected.json. SessionStart hooks are locked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appliedState, compile, fingerprint, hookId, itemKey, protectedPath, readInventory, readProtected, resolvePreset, setCategory, setupChoices, summarize, withLock, withoutHooks,
  writeProtected, DEFAULT, MINIMAL,
} from '../src/core/index.ts';
import { hid, makeTree, ctx, DIRS, EXPECTED_KEYS, LOCAL, PROTECTED, ROOT, userSettings } from './fixture.ts';

const PATH = protectedPath(DIRS.state);
const tree = (data: unknown) => makeTree({ [PATH]: typeof data === 'string' ? data : JSON.stringify(data) });
const protectedKeys = async (fs: ReturnType<typeof makeTree>) => {
  const inv = await readInventory(ctx(fs));
  return { keys: inv.items.filter((i) => i.protected).map(itemKey).sort(), warnings: inv.warnings };
};

test('protected.json missing or with an empty list: nothing protected, no warning', async () => {
  const missing = makeTree();
  missing.files.delete(PATH);
  for (const fs of [missing, tree({ version: 1, protected: [] })]) assert.deepEqual(await protectedKeys(fs), { keys: [], warnings: [] });
  assert.equal((await readInventory(ctx(missing))).protectedKeys, undefined);
});

test('protected.json not valid: every hook and rule protected, and the pane warns', async () => {
  const expected = EXPECTED_KEYS.filter((k) => /^(hook|rule):/.test(k));
  assert.ok(expected.length > PROTECTED.length);
  for (const bad of ['{ nope', '', '[]', 'null', {}, { version: 2, protected: PROTECTED }, { version: 1, protected: 'x' }, { version: 1, protected: [1] }]) {
    const { keys, warnings } = await protectedKeys(tree(bad));
    assert.deepEqual(keys, expected, JSON.stringify(bad));
    assert.equal(warnings.length, 1, JSON.stringify(bad));
    assert.match(warnings[0]!, /protected\.json/);
    assert.match(warnings[0]!, /\/plancia setup/);
    assert.equal(await readProtected(tree(bad), DIRS.state), null);
  }
});

test('protected.json full: the listed items of any category, unknown keys ignored, and what would switch them off with it', async () => {
  const list = ['skill:alpha', 'mcp:u1', 'agent:executor', `hook:${hid('compressor-gate.cjs', 'PostToolUse')}`, 'rule:/h/CLAUDE.md', 'skill:pa:s1', 'skill:gone'];
  // the plugin carries its protected skill
  const expected = [...list.filter((k) => k !== 'skill:gone'), 'plugin:pa@m'].sort();
  assert.deepEqual(await protectedKeys(tree({ version: 1, protected: list })), { keys: expected, warnings: [] });
});

test('switching protected items off needs the extra confirmation, everything else does not', async () => {
  const { items } = await readInventory(ctx(tree({ version: 1, protected: ['skill:alpha'] })));
  const today = resolvePreset(DEFAULT, [], items);
  const s = summarize(items, today, resolvePreset(MINIMAL, [], items));
  assert.deepEqual([s.protected.map((c) => c.key), s.needsConfirmation], [['skill:alpha'], true]);
  assert.equal(summarize(items, today, new Map(today).set('skill:cmd1', false)).needsConfirmation, false);
});

test('SessionStart hooks are listed on and locked: no preset, bulk switch, patch or old state switches them off', async () => {
  const { items } = await readInventory(ctx(makeTree()));
  const START = `hook:${hid('compressor-gate.cjs', 'SessionStart')}`;
  assert.deepEqual(items.filter((i) => i.locked === 'session-start').map((i) => [itemKey(i), i.on]), [[START, true]]);
  const base = resolvePreset(MINIMAL, [], items);
  assert.equal(base.get(START), true);
  assert.equal(setCategory(items, resolvePreset(DEFAULT, [], items), 'hook', items.map((i) => i.id), false).get(START), true);
  const off = new Map(base).set(START, false);
  assert.equal(compile(items, off).hooksOff.includes(hid('compressor-gate.cjs', 'SessionStart')), false);
  assert.equal(summarize(items, base, off).changes.some((c) => c.key === START), false);
  const ps = { preset: 'X', appliedAt: 'x', entries: [], hooksOff: [hid('compressor-gate.cjs', 'SessionStart')], createdPaths: [] };
  assert.equal(appliedState(items, ps).get(START), true);
  const hooks = userSettings().hooks;
  assert.equal(withoutHooks(hooks, [hid('compressor-gate.cjs', 'SessionStart')]), hooks);
});

// ---- protected items that are gone
/** The fixture where resource-guard.cjs has other arguments, and another hook of that script runs on another event. */
const changedHook = () => {
  const settings = userSettings() as any;
  settings.hooks.PreToolUse[0].hooks[0].command += ' --strict';
  settings.hooks.Stop = [{ hooks: [{ type: 'command', command: 'node /h/shared/hooks/resource-guard.cjs' }] }];
  return { '/h/.claude/settings.json': JSON.stringify(settings) };
};
const RESOURCE = `hook:${hid('resource-guard.cjs', 'PreToolUse')}`;
const NEW_RESOURCE = `hook:${hookId('PreToolUse', { type: 'command', command: 'node /h/shared/hooks/resource-guard.cjs --strict' })}`;

test('a protected hook whose command changed: the new one counts as protected, is proposed ticked in its place, and a warning says it', async () => {
  const fs = makeTree(changedHook());
  const { items, protectedKeys: list } = await readInventory(ctx(fs));
  const { keys, warnings } = await protectedKeys(fs);
  assert.deepEqual(warnings, ['The protected hook resource-guard.cjs (PreToolUse) changed: as it is now it counts as protected until you confirm it in /plancia setup']);
  assert.deepEqual(keys.filter((k) => k.startsWith('hook:')), [PROTECTED[0], NEW_RESOURCE].sort());
  const guide = setupChoices(items, list);
  assert.deepEqual([guide.get(NEW_RESOURCE), guide.has(RESOURCE), guide.get(PROTECTED[0]!)], [true, false, true]);
  // confirmed: no warning any more
  await writeProtected(fs, DIRS.state, [...guide].filter(([, on]) => on).map(([k]) => k));
  assert.deepEqual((await protectedKeys(fs)).warnings, []);
  // left out: it is not protected, with no more to say
  await writeProtected(fs, DIRS.state, PROTECTED.filter((k) => k !== RESOURCE));
  const out = await protectedKeys(fs);
  assert.deepEqual([out.warnings, out.keys.includes(NEW_RESOURCE)], [[], false]);
});

test('a protected hook of another event, one whose id is of an older form, and a key that only looks alike', async () => {
  const stop = `hook:${hid('sync-guard.sh', 'PostToolUse')}`.replace('PostToolUse', 'PreToolUse');
  const old = await protectedKeys(tree({ version: 1, protected: ['hook:sync-guard.sh:PostToolUse', stop] }));
  assert.deepEqual(old.keys, [`hook:${hid('sync-guard.sh', 'PostToolUse')}`]);
  assert.deepEqual(old.warnings, [
    'The protected hook sync-guard.sh (PostToolUse) changed: as it is now it counts as protected until you confirm it in /plancia setup',
    'The protected hook sync-guard.sh (PreToolUse) is no longer in your settings: in another form (script, event) it is not protected, see /plancia setup',
  ]);
});

test('a protected hook beside one of the same script and event: the other, still there, is not its new form', async () => {
  const there = `hook:${hid('sync-guard.sh', 'PostToolUse')}`;
  const { items, warnings, protectedKeys: list } = await readInventory(ctx(tree({ version: 1, protected: [there, 'hook:sync-guard.sh#0123456789abcdef:PostToolUse'] })));
  assert.deepEqual(warnings, ['The protected hook sync-guard.sh (PostToolUse) is no longer in your settings: in another form (script, event) it is not protected, see /plancia setup']);
  assert.equal(setupChoices(items, list).get('hook:sync-guard.sh#0123456789abcdef:PostToolUse'), true);
});

test('a protected hook or rule file that is gone: a warning, first in the line; kept in the guide, ticked', async () => {
  const gone = ['hook:gone.sh#0123456789abcdef:PreToolUse', 'rule:/h/gone/RULES.md'];
  const fs = makeTree({ '/h/.mcp.json': '', [`/h/elsewhere/CLAUDE.md`]: '# of another project', [`${ROOT}/.mcp.json`]: '{ nope', [PATH]: JSON.stringify({ version: 1, protected: [...PROTECTED, ...gone, 'rule:/h/elsewhere/CLAUDE.md', 'rule:/h/.claude/projects/-h-other/memory/MEMORY.md', 'skill:of-another-project'] }) });
  const { items, warnings, protectedKeys: list } = await readInventory(ctx(fs));
  assert.deepEqual(warnings, [
    'The protected rule file ~/gone/RULES.md is gone: under another name it is not protected, see /plancia setup',
    'The protected hook gone.sh (PreToolUse) is no longer in your settings: in another form (script, event) it is not protected, see /plancia setup',
    `${ROOT}/.mcp.json is not valid JSON`,
  ]);
  assert.deepEqual(gone.map((k) => setupChoices(items, list).get(k)), [true, true]);
});

test('settings that cannot be read are said once: their hooks are not gone', async () => {
  const { warnings } = await protectedKeys(makeTree({ '/h/.claude/settings.json': '{ nope' }));
  assert.deepEqual(warnings, ['/h/.claude/settings.json is not valid JSON']);
});

// ---- setup guide
const MEMORY = 'rule:/h/mem/MEMORY.md';
const PROPOSED = EXPECTED_KEYS.filter((k) => (/^hook:.*:PreToolUse$/.test(k) || k.startsWith('rule:')) && k !== MEMORY);
const choices = async (current: string[] | null | undefined, extra: Record<string, string> = {}) =>
  [...setupChoices((await readInventory(ctx(makeTree(extra)))).items, current)].sort(([a], [b]) => (a < b ? -1 : 1));

test('setup proposes the PreToolUse hooks and the rule files, all ticked, when there is no valid list', async () => {
  assert.ok(PROPOSED.length > PROTECTED.length);
  for (const none of [undefined, null]) assert.deepEqual(await choices(none), PROPOSED.map((k) => [k, true]));
  assert.deepEqual([...setupChoices([], undefined)], []);
});

test('setup does not propose a rule the user already excluded', async () => {
  const left = PROPOSED.filter((k) => !k.startsWith('rule:/h/team/') && k !== 'rule:/h/.claude/CLAUDE.md');
  assert.deepEqual(await choices(undefined, { [LOCAL]: JSON.stringify({ claudeMdExcludes: ['/h/.claude/CLAUDE.md'] }) }), left.map((k) => [k, true]));
});

test('setup on a valid list: its values, and every listed item of other kinds or gone, ticked', async () => {
  const current = [PROTECTED[0]!, 'skill:alpha', MEMORY, 'rule:/gone/CLAUDE.md'];
  assert.deepEqual(await choices(current), [...new Set([...PROPOSED, ...current])].sort().map((k) => [k, current.includes(k)]));
  assert.deepEqual(await choices([]), PROPOSED.map((k) => [k, false]));
});

test('writeProtected writes the list whole, under the lock', async () => {
  const fs = makeTree();
  fs.files.delete(PATH);
  await writeProtected(fs, DIRS.state, ['skill:alpha']);
  assert.equal(fs.files.get(PATH), JSON.stringify({ version: 1, protected: ['skill:alpha'] }, null, 2) + '\n');
  assert.deepEqual([await readProtected(fs, DIRS.state), [...fs.dirs]], [['skill:alpha'], []]);
  // the holder of the lock lets no one else write
  await withLock(fs, DIRS.state, async () => assert.rejects(writeProtected(fs, DIRS.state, []), /nothing was written/));
  assert.deepEqual(await readProtected(fs, DIRS.state), ['skill:alpha']);
});

test('the fingerprint tells a missing, an empty, an invalid and another list apart', async () => {
  const missing = makeTree();
  missing.files.delete(PATH);
  // a key of another project changes no item of this one
  const trees = [missing, tree('{ nope'), tree({ version: 1, protected: [] }), tree({ version: 1, protected: ['rule:/elsewhere/CLAUDE.md'] })];
  const prints = await Promise.all(trees.map(async (fs) => {
    const { items, protectedKeys } = await readInventory(ctx(fs));
    return fingerprint({ inv: { root: '', localPath: '', warnings: [], items: items.map((i) => ({ ...i, protected: false })), protectedKeys }, ps: undefined, user: [] });
  }));
  assert.equal(new Set(prints).size, trees.length);
});
