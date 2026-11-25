import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readInventory, resolvePreset, compile, itemKey, MINIMAL, DEFAULT, type Preset, type Item } from '../src/core/index.ts';
import { globMatch } from '../src/core/util.ts';
import { hid, makeTree, ctx, ROOT } from './fixture.ts';

const setup = async () => (await readInventory(ctx(makeTree()))).items;
const show = (p: ReturnType<typeof compile>) =>
  p.ops.map((o) => `${o.kind} ${o.path.join('.')} ${JSON.stringify(o.value)}`).sort();

test('Default on a project without local gives an empty patch', async () => {
  const it = await setup();
  const p = compile(it, resolvePreset(DEFAULT, [], it));
  assert.deepEqual(p, { ops: [], hooksOff: [] });
});

test('Minimal compiles to exactly these settings (full list)', async () => {
  const it = await setup();
  const p = compile(it, resolvePreset(MINIMAL, [], it));
  assert.deepEqual(show(p), [
    'add claudeMdExcludes "/h/.claude/CLAUDE.md"',
    'add claudeMdExcludes "/h/CLAUDE.md"',
    `add claudeMdExcludes "${ROOT}/.claude/rules/r1.md"`,
    `add claudeMdExcludes "${ROOT}/CLAUDE.md"`,
    'add claudeMdExcludes "/h/team/nested.md"',
    'add claudeMdExcludes "/h/team/other.md"',
    'add claudeMdExcludes "/h/team/rules.md"',
    'add deniedMcpServers {"serverName":"claude.ai Drive"}',
    'add deniedMcpServers {"serverName":"loc1"}',
    'add deniedMcpServers {"serverName":"u1"}',
    'add disabledMcpjsonServers "pm1"',
    'add disabledMcpjsonServers "pm2"',
    'add permissions.deny "Agent(executor)"',
    'add permissions.deny "Agent(projagent)"',
    'add permissions.deny "Skill(pa:c1)"',
    'add permissions.deny "Skill(pa:s1)"',
    'set autoMemoryEnabled false',
    'set enabledPlugins.pa@m false',
    'set skillOverrides.alpha "off"',
    'set skillOverrides.cmd1 "off"',
    'set skillOverrides.projskill "off"',
  ].sort());
  assert.deepEqual([...p.hooksOff].sort(), [
    hid('compressor-gate.cjs', 'PostToolUse'), // the SessionStart one is locked
    hid('delete-guard.sh', 'PreToolUse'), hid('resource-guard.cjs', 'PreToolUse'), hid('sync-guard.sh', 'PostToolUse'),
  ]);
  assert.equal(JSON.stringify(p).includes('disableAllHooks'), false);
});

test('turning on what is off today; locked items are never touched', async () => {
  const it = await setup();
  const presets: Preset[] = [{
    name: 'More', parent: DEFAULT,
    enable: ['skill:userskill-off', 'skill:anthropic-skills:docx', 'plugin:pb@m', 'agent:blocked-agent', 'mcp:claude.ai Gmail'],
    disable: [],
  }];
  const p = compile(it, resolvePreset('More', presets, it));
  assert.deepEqual(show(p), [
    'set enabledPlugins.pb@m true',
    'set skillOverrides.anthropic-skills:docx "on"',
    'set skillOverrides.userskill-off "on"',
  ]);
});

test('project .mcp.json server not approved today is turned on with enabledMcpjsonServers', async () => {
  const fs = makeTree({ [`${ROOT}/.claude/settings.json`]: '{}' });
  const it = (await readInventory(ctx(fs))).items;
  assert.equal(it.find((i) => i.id === 'pm1')!.on, false);
  const presets: Preset[] = [{ name: 'M', parent: DEFAULT, enable: ['mcp:pm1'], disable: [] }];
  assert.deepEqual(show(compile(it, resolvePreset('M', presets, it))), ['add enabledMcpjsonServers "pm1"']);
});

test('each op names the item and the desired state', async () => {
  const it = await setup();
  const p = compile(it, resolvePreset(MINIMAL, [], it));
  const op = p.ops.find((o) => o.item === 'skill:alpha')!;
  assert.deepEqual(op, { item: 'skill:alpha', on: false, kind: 'set', path: ['skillOverrides', 'alpha'], value: 'off' });
});

test('locked by a list in another layer: no op even where the mechanism could write one', async () => {
  const fs = makeTree({
    [`${ROOT}/.claude/settings.json`]: JSON.stringify({ enabledMcpjsonServers: ['pm1', 'pm2'], disabledMcpjsonServers: ['pm2'], permissions: { deny: ['Skill(alpha)'] } }),
  });
  const it = (await readInventory(ctx(fs))).items;
  const locked = it.filter((i) => i.locked).map((i) => i.id).sort();
  assert.deepEqual(locked, ['blocked-agent', hid('compressor-gate.cjs', 'SessionStart'), 'claude.ai Gmail', 'claude.ai Old', 'alpha', 'pm2'].sort());
  const presets: Preset[] = [{ name: 'All', parent: DEFAULT, enable: ['skill:alpha', 'mcp:pm2'], disable: [] }];
  assert.deepEqual(compile(it, resolvePreset('All', presets, it)), { ops: [], hooksOff: [] });
});

test('claudeMdExcludes values are literal paths: glob characters escaped (a file named ~/**/rules.md)', () => {
  const rule = (path: string): Item => ({
    category: 'rule', id: path, name: 'x', description: '', source: 'user', path, protected: false, locked: null, on: true,
    mech: { kind: 'claudeMdExclude' },
  });
  const odd = rule('/h/**/rules.md');
  const weird = rule('/h/a?[b]{c}(d)!.md');
  const p = compile([odd, weird], new Map([[itemKey(odd), false], [itemKey(weird), false]]));
  const [v1, v2] = p.ops.map((o) => o.value as string);
  assert.equal(v1, '/h/\\*\\*/rules.md');
  assert.equal(v2, '/h/a\\?\\[b\\]\\{c\\}\\(d\\)\\!.md');
  assert.equal(globMatch(v1!, '/h/**/rules.md'), true);
  assert.equal(globMatch(v1!, '/h/team/rules.md'), false);
  assert.equal(globMatch(v2!, '/h/a?[b]{c}(d)!.md'), true);
  assert.equal(globMatch(v2!, '/h/ax[b]{c}(d)!.md'), false);
});
