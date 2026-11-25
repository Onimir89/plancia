import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readInventory, resolvePreset, summarize, MINIMAL, DEFAULT, type Preset } from '../src/core/index.ts';
import { hid, makeTree, ctx } from './fixture.ts';

const setup = async () => (await readInventory(ctx(makeTree()))).items;

test('Default → Minimal: per category, timing, blocked-but-visible, protected list (full)', async () => {
  const it = await setup();
  const s = summarize(it, resolvePreset(DEFAULT, [], it), resolvePreset(MINIMAL, [], it));
  assert.deepEqual(s.byCategory.skill, { on: [], off: ['skill:alpha', 'skill:cmd1', 'skill:pa:c1', 'skill:pa:s1', 'skill:projskill'] });
  assert.deepEqual(s.byCategory.plugin, { on: [], off: ['plugin:pa@m'] });
  assert.deepEqual(s.byCategory.mcp.off, ['mcp:claude.ai Drive', 'mcp:loc1', 'mcp:pm1', 'mcp:pm2', 'mcp:u1']);
  assert.deepEqual(s.byCategory.agent.off, ['agent:executor', 'agent:projagent']);
  assert.equal(s.byCategory.rule.off.length, 8);
  assert.equal(s.byCategory.hook.off.length, 4);
  assert.deepEqual(s.protected.map((c) => c.key), [
    `hook:${hid('delete-guard.sh', 'PreToolUse')}`, `hook:${hid('resource-guard.cjs', 'PreToolUse')}`, 'rule:/h/.claude/CLAUDE.md', 'rule:/h/team/rules.md', // CLAUDE.md imports rules.md
  ]);
  assert.equal(s.needsConfirmation, true);
  const c = new Map(s.changes.map((x) => [x.key, x]));
  assert.equal(c.get('mcp:u1')!.timing, 'next-session');
  assert.equal(c.get('skill:alpha')!.timing, 'now');
  assert.equal(c.get('plugin:pa@m')!.timing, 'now');
  assert.equal(c.get(`hook:${hid('resource-guard.cjs', 'PreToolUse')}`)!.timing, 'next-session'); // live trial 2026-11-20: a hooks-only apply reaches no running session
  assert.equal(c.get('rule:/h/CLAUDE.md')!.timing, 'next-session');
  assert.deepEqual(s.changes.filter((x) => x.blockedButVisible).map((x) => x.key).sort(),
    ['agent:executor', 'agent:projagent', 'skill:pa:c1', 'skill:pa:s1']);
  assert.equal(c.get('skill:alpha')!.blockedButVisible, false);
  // locked items cannot change and never show up as changes
  assert.equal(c.has('agent:blocked-agent'), false);
  assert.equal(c.has(`hook:${hid('compressor-gate.cjs', 'SessionStart')}`), false);
});

test('no difference → empty summary, no confirmation', async () => {
  const it = await setup();
  const sys = resolvePreset(DEFAULT, [], it);
  const s = summarize(it, sys, sys);
  assert.deepEqual(s.changes, []);
  assert.equal(s.needsConfirmation, false);
});

test('turning a protected item back on is not a protected change', async () => {
  const it = await setup();
  const presets: Preset[] = [{ name: 'NoRules', parent: DEFAULT, enable: [], disable: ['rule:/h/team/rules.md'] }];
  const s = summarize(it, resolvePreset('NoRules', presets, it), resolvePreset(DEFAULT, [], it));
  assert.deepEqual(s.byCategory.rule.on, ['rule:/h/team/rules.md']);
  assert.deepEqual(s.protected, []);
  assert.equal(s.needsConfirmation, false);
});
