import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readInventory, itemKey, withImports, type Item } from '../src/core/index.ts';
import { hid, makeTree, ctx, EXPECTED_KEYS, HOME, PROTECTED, ROOT, LOCAL } from './fixture.ts';

const byKey = async (fs = makeTree()) => {
  const inv = await readInventory(ctx(fs));
  return { inv, m: new Map(inv.items.map((i) => [itemKey(i), i])) };
};

test('inventory lists exactly the expected items (full comparison)', async () => {
  const { inv } = await byKey();
  assert.deepEqual(inv.items.map(itemKey).sort(), EXPECTED_KEYS);
  assert.deepEqual(inv.warnings, []);
});

test('items carry the required fields', async () => {
  const { m } = await byKey();
  const s = m.get('skill:alpha')!;
  assert.equal(s.name, 'alpha');
  assert.equal(s.description, 'Alpha skill');
  assert.equal(s.source, 'user');
  assert.equal(s.path, '/h/.claude/skills/alpha/SKILL.md');
  assert.equal(m.get('skill:userskill-off')!.description, 'Quoted: description');
  assert.equal(m.get('skill:anthropic-skills:docx')!.description, 'Word documents and templates');
  assert.equal(m.get('skill:anthropic-skills:docx')!.source, 'synced');
  assert.equal(m.get('skill:pa:c1')!.description, 'Command one');
  assert.equal(m.get('skill:pa:s1')!.source, 'plugin:pa@m');
  assert.equal(m.get('plugin:pa@m')!.description, 'Plugin A');
  assert.equal(m.get('skill:projskill')!.source, 'project');
  assert.equal(m.get('skill:cmd1')!.source, 'user-command');
  assert.equal(m.get('skill:cmd1')!.description, 'Save something: $ARGUMENTS');
  assert.equal(m.get(`rule:${ROOT}/.claude/rules/r1.md`)!.source, 'project');
  assert.equal(m.get('rule:/h/CLAUDE.md')!.source, 'ancestor');
  assert.equal(m.get('rule:/h/team/rules.md')!.source, 'import');
  assert.equal(m.get('rule:/h/mem/MEMORY.md')!.source, 'memory');
  assert.equal(m.get('mcp:loc1')!.source, 'local');
  assert.equal(m.get('mcp:pm1')!.source, 'project');
  assert.equal(m.get('mcp:claude.ai Drive')!.source, 'connector');
  const h = m.get(`hook:${hid('delete-guard.sh', 'PreToolUse')}`)!;
  assert.equal(h.path, '/h/shared/hooks/delete-guard.sh');
  assert.equal(h.name, 'delete-guard');
});

test('baseline state today (on) and locks', async () => {
  const { inv, m } = await byKey();
  const off = inv.items.filter((i) => !i.on).map(itemKey).sort();
  assert.deepEqual(off, [
    'agent:blocked-agent', 'mcp:claude.ai Gmail', 'mcp:claude.ai Old', 'plugin:pb@m',
    'skill:anthropic-skills:docx', 'skill:userskill-off',
  ]);
  const locked = inv.items.filter((i) => i.locked).map(itemKey).sort();
  assert.deepEqual(locked, ['agent:blocked-agent', `hook:${hid('compressor-gate.cjs', 'SessionStart')}`, 'mcp:claude.ai Gmail', 'mcp:claude.ai Old']);
  // skillOverrides off at user level is an object key: it can be overridden, so not locked
  assert.equal(m.get('skill:userskill-off')!.locked, null);
});

test('protected items are the ones of protected.json, and the rules that import them', async () => {
  const { inv } = await byKey();
  // CLAUDE.md imports rules.md
  assert.deepEqual(inv.items.filter((i) => i.protected).map(itemKey).sort(), [...PROTECTED, 'rule:/h/.claude/CLAUDE.md'].sort());
});

test('plancia itself never appears', async () => {
  const { inv } = await byKey();
  assert.equal(inv.items.some((i) => /plancia/.test(i.id) || /plancia/.test(i.source)), false);
});

test('no secrets from MCP env leak into items', async () => {
  const { inv } = await byKey();
  assert.equal(JSON.stringify(inv).includes('SECRET-VALUE'), false);
  assert.equal(JSON.stringify(inv).includes('x@y'), false);
});

test('reads ~/.claude.json too, and a hand-written local counts in the baseline', async () => {
  const fs = makeTree({
    '/h/.claude.json': JSON.stringify({ mcpServers: { u2: { command: 'z' } } }),
    [LOCAL]: JSON.stringify({ skillOverrides: { alpha: 'off' } }),
  });
  const { m } = await byKey(fs);
  assert.equal(m.get('mcp:u2')!.source, 'user');
  assert.equal(m.get('skill:alpha')!.on, false);
});

test('broken JSON gives a warning, not a crash', async () => {
  const fs = makeTree({ [`${ROOT}/.mcp.json`]: '{ broken' });
  const inv = await readInventory(ctx(fs));
  assert.equal(inv.items.some((i) => i.id === 'pm1'), false);
  assert.equal(inv.warnings.length, 1);
  assert.match(inv.warnings[0], /\.mcp\.json/);
});

test('session in home: no project layer, local is ~/.claude/settings.local.json', async () => {
  const fs = makeTree();
  const inv = await readInventory(ctx(fs, HOME));
  assert.equal(inv.localPath, '/h/.claude/settings.local.json');
  const keys = inv.items.map(itemKey);
  assert.ok(keys.includes('rule:/h/CLAUDE.md'));
  assert.equal(inv.items.find((i) => i.id === '/h/CLAUDE.md')!.source, 'project');
  assert.equal(keys.includes('skill:projskill'), false);
});

test('a rule that imports a protected rule, even indirectly, is protected: excluding it drops its imports too', async () => {
  const fs = makeTree({
    [`${ROOT}/CLAUDE.md`]: '# Project rules\n@./docs/sub.md\n',
    [`${ROOT}/docs/sub.md`]: '# Sub\n@~/team/rules.md\n',
  });
  const inv = await readInventory(ctx(fs));
  assert.deepEqual(inv.items.filter((i) => i.category === 'rule' && i.protected).map(itemKey).sort(), [
    'rule:/h/.claude/CLAUDE.md', `rule:${ROOT}/CLAUDE.md`, `rule:${ROOT}/docs/sub.md`, 'rule:/h/team/rules.md',
  ].sort());
});

test('withImports: a rule reached only through rules switched off is off, cycles included', async () => {
  const inv = await readInventory(ctx(makeTree()));
  const desired = new Map(inv.items.map((i) => [itemKey(i), i.on] as [string, boolean]));
  assert.deepEqual(withImports(inv.items, desired), desired);
  desired.set('rule:/h/.claude/CLAUDE.md', false);
  const eff = withImports(inv.items, desired);
  const off = inv.items.filter((i) => i.category === 'rule' && !eff.get(itemKey(i))).map(itemKey).sort();
  // other.md and nested.md import each other: the cycle does not keep them on
  assert.deepEqual(off, ['rule:/h/.claude/CLAUDE.md', 'rule:/h/team/nested.md', 'rule:/h/team/other.md', 'rule:/h/team/rules.md']);
  assert.equal(desired.get('rule:/h/team/rules.md'), true); // the desired map is left as it is
});

test('a rule imported by one the user excluded and by one that is on: on, with what it imports, whichever comes first', async () => {
  for (const first of ['a', 'z']) {
    const fs = makeTree({
      [`/h/.claude/rules/${first}.md`]: '# Excluded\n@~/team/shared.md\n',
      '/h/.claude/rules/m.md': '# On\n@~/team/shared.md\n',
      '/h/team/shared.md': '# Shared\n@./deep.md\n',
      '/h/team/deep.md': '# Deep\n@./shared.md\n',
      [LOCAL]: JSON.stringify({ claudeMdExcludes: [`/h/.claude/rules/${first}.md`] }),
    });
    const rule = (id: string, items: Item[]) => items.filter((i) => i.id === id).map((i) => [i.on, i.locked, i.importedBy]);
    const { items } = await readInventory(ctx(fs));
    assert.deepEqual(rule(`/h/.claude/rules/${first}.md`, items), [[false, 'user', undefined]]);
    assert.deepEqual(rule('/h/team/shared.md', items), [[true, null, [`rule:/h/.claude/rules/${first}.md`, 'rule:/h/.claude/rules/m.md', 'rule:/h/team/deep.md'].sort()]]);
    assert.deepEqual(rule('/h/team/deep.md', items), [[true, null, ['rule:/h/team/shared.md']]]);
  }
});

test('a rule loaded directly and also imported stays on when its importer is off', async () => {
  const fs = makeTree({ '/h/.claude/rules/rules-link.md': '# Link\n@~/team/other.md\n' });
  const inv = await readInventory(ctx(fs));
  const desired = new Map(inv.items.map((i) => [itemKey(i), i.on] as [string, boolean]));
  desired.set('rule:/h/.claude/CLAUDE.md', false);
  const eff = withImports(inv.items, desired);
  assert.equal(eff.get('rule:/h/team/other.md'), true);  // still imported by rules-link.md
  assert.equal(eff.get('rule:/h/team/rules.md'), false);
});
