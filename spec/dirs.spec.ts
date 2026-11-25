// Where Claude Code and Plancia keep their files, from the caller's environment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirsOf, readInventory, itemKey, applyPatch, compile, resolvePreset, MINIMAL } from '../src/core/index.ts';
import { hash } from '../src/core/util.ts';
import { makeTree, ctx, EXPECTED_KEYS, DIRS, HOME, ROOT } from './fixture.ts';

test('dirsOf: defaults, also for empty variables and a relative XDG_CONFIG_HOME', () => {
  const defaults = { home: HOME, claude: `${HOME}/.claude`, claudeJson: `${HOME}/.claude.json`, state: `${HOME}/.config/plancia` };
  assert.deepEqual(dirsOf(HOME, {}), defaults);
  assert.deepEqual(dirsOf(HOME, { CLAUDE_CONFIG_DIR: '', XDG_CONFIG_HOME: '' }), defaults);
  assert.deepEqual(dirsOf(HOME, { XDG_CONFIG_HOME: 'conf' }), defaults);
});

test('dirsOf: CLAUDE_CONFIG_DIR moves .claude.json too, XDG_CONFIG_HOME only the state; trailing slashes dropped', () => {
  assert.deepEqual(dirsOf(HOME, { CLAUDE_CONFIG_DIR: '/cfg/', XDG_CONFIG_HOME: '/xdg//' }), {
    home: HOME, claude: '/cfg', claudeJson: '/cfg/.claude.json', state: '/xdg/plancia',
  });
});

test('the inventory follows CLAUDE_CONFIG_DIR and never reads ~/.claude', async () => {
  const moved = makeTree();
  for (const [p, data] of [...moved.files]) {
    if (!p.startsWith(`${DIRS.claude}/`)) continue;
    moved.files.delete(p);
    moved.files.set(p.replace(DIRS.claude, '/cfg'), data);
  }
  moved.files.set('/cfg/.claude.json', JSON.stringify({ mcpServers: { u2: { command: 'z' } } }));
  const reads: string[] = [];
  const readText = moved.readText.bind(moved);
  moved.readText = async (p) => { reads.push(p); return readText(p); };
  const inv = await readInventory({ ...ctx(moved), ...dirsOf(HOME, { CLAUDE_CONFIG_DIR: '/cfg' }) });
  // the plugins' files stay where installed_plugins.json says, so pa's skills go with the folder moved away
  const expected = EXPECTED_KEYS.filter((k) => !k.startsWith('skill:pa:')).map((k) => k.replace(DIRS.claude, '/cfg'));
  assert.deepEqual(inv.items.map(itemKey).sort(), [...expected, 'mcp:u2'].sort());
  const ofPlugins = (p: string) => p.startsWith(`${DIRS.claude}/plugins/cache/`);
  assert.deepEqual(reads.filter((p) => (p.startsWith(`${DIRS.claude}/`) || p === DIRS.claudeJson) && !ofPlugins(p)), []);
});

test('a session in the home with CLAUDE_CONFIG_DIR elsewhere: ~/.claude is the project layer', async () => {
  const fs = makeTree({ '/cfg/settings.json': '{}' });
  const inv = await readInventory({ ...ctx(fs, HOME), ...dirsOf(HOME, { CLAUDE_CONFIG_DIR: '/cfg' }) });
  assert.equal(inv.items.find((i) => i.id === 'alpha')?.source, 'project');
});

test('state and backups go to XDG_CONFIG_HOME', async () => {
  const fs = makeTree({ [`${ROOT}/.claude/settings.local.json`]: '{"foo":1}' });
  const before = new Set(fs.files.keys());
  const c = { ...ctx(fs), ...dirsOf(HOME, { XDG_CONFIG_HOME: '/xdg' }) };
  const { items } = await readInventory(c);
  await applyPatch(c, compile(items, resolvePreset(MINIMAL, [], items)), { preset: MINIMAL, now: new Date(0) });
  assert.deepEqual([...fs.files.keys()].filter((p) => !before.has(p)).sort(), [
    `/xdg/plancia/backups/-h-p-proj-${hash(ROOT)}/1970-01-01T00-00-00-000Z.json`, '/xdg/plancia/state.json',
  ]);
});
