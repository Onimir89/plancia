import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirsOf, guardSpelling, guardToolCall, type Dirs } from '../src/core/index.ts';
import { HOME, ROOT } from './fixture.ts';

const XDG = dirsOf(HOME, { XDG_CONFIG_HOME: '/xdg' });
const denied = (file_path: string, dirs: Dirs | null = dirsOf(HOME, {}), cwd = ROOT) => guardSpelling('Write', { file_path }, cwd, dirs) !== null;
const links = (map: Record<string, string>) => async (paths: string[]) => paths.map((p) => Object.entries(map).reduce((q, [from, to]) => q.replace(from, to), p));

test('the state folder by any spelling: absolute, relative, ~, .. and the bare folder', () => {
  for (const p of ['/h/.config/plancia/state.json', '~/.config/plancia/presets.json', '/h/.config/plancia', '/h/.config/plancia/',
    '/h/.config/../.config/plancia/backups/x.json', '../../.config/plancia/state.json', '/h//.config/./plancia/x'])
    assert.equal(denied(p), true, p);
  assert.equal(denied('plancia/state.json', undefined, '/h/.config'), true);
  for (const p of ['/h/.config/planciax/y', '/h/p/proj/plancia/state.json', '/h/p/proj/.config/plancia-notes.md', '/other/home/.config/plancia/state.json',
    '/h/.config', 'README.md', ''])
    assert.equal(denied(p), false, p);
});

test('XDG_CONFIG_HOME: its folder, and the default one; folders not known: any home', () => {
  for (const p of ['/xdg/plancia/state.json', '/h/.config/plancia/state.json']) assert.equal(denied(p, XDG), true, p);
  for (const p of ['/xdg/state.json', '/xdg/plancia2/x', '/h/p/xdg/plancia/x']) assert.equal(denied(p, XDG), false, p);
  assert.equal(denied('/a/plancia/x', dirsOf(HOME, { XDG_CONFIG_HOME: '/a/b/..' })), true, 'not normalized');
  for (const p of ['~/.config/plancia/x', '/any/.config/plancia/x']) assert.equal(denied(p, null), true, p);
  for (const p of ['/xdg/plancia/x', '/any/.config/planciax']) assert.equal(denied(p, null), false, p);
});

test('guardToolCall: every file-writing tool, in English, the rest through', async () => {
  const guard = (tool: string, input: Record<string, unknown>) => guardToolCall(tool, input, ROOT, dirsOf(HOME, {}), { real: async (p) => p, ids: async () => [] });
  const state = '/h/.config/plancia/state.json';
  for (const [tool, input] of [['Write', { file_path: state }], ['Edit', { file_path: '~/.config/plancia/presets.json' }],
    ['MultiEdit', { file_path: state, edits: [] }], ['NotebookEdit', { notebook_path: '/h/.config/plancia/x.ipynb' }]] as const)
    assert.equal(await guard(tool, input), 'Plancia: its state, presets and protected items change only from the /plancia panel, not with tools.', tool);
  for (const [tool, input] of [['Write', { file_path: '/h/p/proj/notes.md' }], ['Read', { file_path: state }], ['Write', {}], ['Write', { file_path: 3 }],
    ['Bash', { command: `echo {} > ${state}` }], ['toString', { file_path: state }]] as const)
    assert.equal(await guard(tool, input), null, tool);
});

test('as Claude Code reads it: outer white space off, NFC; /proc, /dev/fd and the standard streams always, with a reason of their own', () => {
  for (const p of [' /h/.config/plancia/x', '\u00a0../../.config/plancia/x', '/h/.config/plancia/x\ufeff', '\t~/.config/plancia']) assert.equal(denied(p), true, JSON.stringify(p));
  assert.equal(denied('/h/caf\u00e9/plancia/x'.normalize('NFD'), dirsOf(HOME, { XDG_CONFIG_HOME: '/h/caf\u00e9'.normalize('NFC') })), true);
  assert.equal(denied('/h/caf\u00e9/plancia/x'.normalize('NFC'), dirsOf(HOME, { XDG_CONFIG_HOME: '/h/caf\u00e9'.normalize('NFD') })), true);
  for (const dirs of [dirsOf(HOME, {}), null]) {
    for (const p of ['/proc/self/cwd/x', '/proc', '/dev/fd/3/x', '/dev/stdin', '/dev/stdout', '/dev/stderr', ' /dev/../proc/1/root/x'])
      assert.match(guardSpelling('Edit', { file_path: p }, ROOT, dirs) ?? '', /^Plancia: .*\/proc.*own path/, p);
    for (const p of ['/dev/null', '/procs', '/dev/fds/x', 'proc/x', '\u200b/h/.config/plancia/x', 'file:///h/.config/plancia/x'].slice(0, dirs ? 6 : 4)) assert.equal(denied(p, dirs), false, p);
  }
});

test('guardToolCall: the folder by its inode, whatever the path says', async () => {
  const ids = async (paths: string[]) => paths.flatMap((p) => ({ '/h/.config/plancia': ['1:2'], '/bind/plancia': ['1:2'], '/bind': ['1:1'] })[p] ?? []);
  const guard = (file_path: string) => guardToolCall('Write', { file_path }, ROOT, dirsOf(HOME, {}), { real: async (p) => p, ids });
  for (const p of ['/bind/plancia/state.json', '/bind/plancia', '/bind/x/../plancia/new/y']) assert.notEqual(await guard(p), null, p);
  for (const p of ['/bind/other', '/bind', '/h/.config/x', 'x']) assert.equal(await guard(p), null, p);
  // as Claude Code reads it, and through a link to a file not there yet
  assert.notEqual(await guard(' /bind/plancia/x'), null);
  const linked = (paths: string[]) => paths.map((p) => (p === `${ROOT}/link` ? '/bind/plancia/new' : p));
  assert.notEqual(await guardToolCall('Write', { file_path: 'link' }, ROOT, dirsOf(HOME, {}), { real: async (p) => linked(p), ids }), null);
  // where links cannot be read, what stat says of the path as spelled
  assert.notEqual(await guardToolCall('Write', { file_path: '/bind/plancia/x' }, ROOT, dirsOf(HOME, {}), { real: async () => [], ids }), null);
  // the default folder counts in a session with one of its own
  assert.notEqual(await guardToolCall('Write', { file_path: '/bind/plancia/x' }, ROOT, XDG, { real: async (p) => p, ids }), null);
  // the disk's own spelling of a folder that is not there yet
  const nfd = '/real/caf\u00e9/plancia'.normalize('NFD');
  const disk = async (paths: string[]) => paths.map((p) => (p.startsWith('/h/.config/plancia') ? nfd : p === `${ROOT}/link` ? `${nfd}/x` : p));
  assert.notEqual(await guardToolCall('Write', { file_path: 'link' }, ROOT, dirsOf(HOME, {}), { real: disk, ids: async () => [] }), null);
});

test('guardToolCall: links, on the target as spelled and as the kernel reads it, and on the state folder', async () => {
  const guard = (file_path: string, real: (p: string[]) => Promise<string[]>, dirs: Dirs | null = dirsOf(HOME, {})) => guardToolCall('Write', { file_path }, ROOT, dirs, { real, ids: async () => [] });
  assert.notEqual(await guard('link/x', links({ [`${ROOT}/link`]: '/h/.config/plancia' })), null);
  // ROOT/link/../x: spelled it is ROOT/x; the kernel follows the link first
  assert.notEqual(await guard('link/../plancia/x', links({ [`${ROOT}/link/..`]: '/h/.config' })), null);
  assert.notEqual(await guard('~/../h/.config/plancia/x', async () => []), null);
  assert.notEqual(await guard('/dot/plancia/x', links({ '/h/.config': '/dot' })), null);
  assert.equal(await guard('/dot/plancia/x', async (p) => p), null);
  // a link as Claude Code spells it, in composed characters
  assert.notEqual(await guard('caf\u00e9/x'.normalize('NFD'), links({ [`${ROOT}/caf\u00e9`.normalize('NFC')]: '/h/.config/plancia' })), null);
  // where the state folder leads cannot be told: its own name still counts
  assert.notEqual(await guard('link/x', async (p) => (p.some((q) => q.startsWith(ROOT)) ? links({ [`${ROOT}/link`]: '/h/.config/plancia' })(p) : [])), null);
  // the links cannot be read: the spelling alone
  assert.equal(await guard('link/x', async () => []), null);
  assert.equal(await guard('link/x', async () => { throw new Error('never asked without the folders'); }, null), null);
});
