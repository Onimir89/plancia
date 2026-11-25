// The lock with real processes, the real file system and the real coreutils (mv, rm, realpath), through the mod's adapter.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { LOCK, dirsOf, guardToolCall, lockPath, readState, withLock } from '../src/core/index.ts';
import { fileIds, fsOf, realPaths } from '../mod/adapter.ts';
import { real$ } from './realfs.ts';

const WRITER = fileURLToPath(new URL('writer.ts', import.meta.url));
async function folder(t: TestContext) {
  const dir = await mkdtemp(`${tmpdir()}/plancia-lock-`);
  t.after(() => rm(dir, { recursive: true }));
  return `${dir}/state`;
}
const writers = async (state: string, names: string[], count: number): Promise<{ saved: string[]; failed: string[] }[]> =>
  Promise.all(names.map(async (n) => JSON.parse((await promisify(execFile)(process.execPath, [...process.execArgv, WRITER, state, n, String(count)])).stdout)));
const sessions = async (state: string) => Object.keys((await readState(fsOf(real$, state), state)).sessions).sort();

test('three processes saving choices at once: all of them are there, nothing left behind', async (t) => {
  const state = await folder(t);
  const out = await writers(state, ['a', 'b', 'c'], 8);
  assert.deepEqual(out.map((o) => [o.saved.length, o.failed]), [[8, []], [8, []], [8, []]]);
  assert.deepEqual(await sessions(state), out.flatMap((o) => o.saved).sort());
  assert.deepEqual(await readdir(state), ['state.json']);
});

test('the lock of a killed process is recovered by one of several writers, and the others wait for it', async (t) => {
  const state = await folder(t);
  await mkdir(lockPath(state), { recursive: true });
  await writeFile(`${lockPath(state)}/${Date.now() - LOCK.deadMs - 1000}-killed`, '');
  const out = await writers(state, ['a', 'b', 'c'], 2);
  const saved = out.flatMap((o) => o.saved).sort();
  assert.ok(saved.length >= 2 && out.flatMap((o) => o.failed).every((f) => f.includes('another Plancia window is writing')), JSON.stringify(out));
  assert.deepEqual([await sessions(state), await readdir(state)], [saved, ['state.json']]);
});

test('the adapter: a folder is renamed over a missing or an empty one, by one of many, never over a full one or a file', async (t) => {
  const state = await folder(t);
  const fs = fsOf(real$, state);
  const all = (to: string) => Promise.allSettled(Array.from({ length: 8 }, async (_, n) => {
    await fs.writeText(`${state}/${to}.${n}/${n}`, '');
    await fs.rename(`${state}/${to}.${n}`, `${state}/${to}`);
    return String(n);
  }));
  await mkdir(`${state}/empty`, { recursive: true });
  await writeFile(`${state}/file`, 'mine');
  for (const [to, winners] of [['missing', 1], ['empty', 1], ['missing', 0], ['file', 0]] as const) {
    const before = await readdir(`${state}/${to}`).catch(() => []);
    const won = (await all(to)).flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    assert.deepEqual([won.length, await readdir(`${state}/${to}`).catch(() => [])], [winners, winners ? won : before], to);
  }
  assert.equal(await readFile(`${state}/file`, 'utf8'), 'mine');
});

test('the adapter: remove takes a file or an empty folder, never a full one', async (t) => {
  const state = await folder(t);
  const fs = fsOf(real$, state);
  await fs.writeText(`${state}/d/f`, '');
  await assert.rejects(fs.remove(`${state}/d`), /rm .*not empty/);
  for (const p of ['d/f', 'd', 'd', 'never']) await fs.remove(`${state}/${p}`);
  assert.deepEqual(await readdir(state), []);
  assert.equal(await withLock(fs, state, async () => (await readdir(state)).join()), 'lock');
  assert.deepEqual(await readdir(state), []);
});

test('the adapter: what another makes while it is read is read, what another removes is missing', async (t) => {
  const state = await folder(t);
  await mkdir(state);
  // right after the first call that fails, `change` happens
  const fsWith = (change: () => Promise<unknown>) => {
    const then = (call: (p: string) => Promise<unknown>) => (p: string) => call(p).catch(async (e) => { await change(); change = async () => {}; throw e; });
    return fsOf({ ...real$, fs: { ...real$.fs, read: then(real$.fs.read), list: then(real$.fs.list) } }, state);
  };
  assert.deepEqual(await fsWith(() => mkdir(`${state}/d`)).list(`${state}/d`), []);
  assert.equal(await fsWith(() => writeFile(`${state}/f`, 'x')).readText(`${state}/f`), 'x');
  assert.deepEqual([await fsWith(async () => {}).list(`${state}/f`), await fsWith(async () => {}).readText(`${state}/d`)], [null, null]);
  // there at the first look, gone at the next
  const gone = fsOf({ ...real$, fs: { ...real$.fs, exists: async () => true } }, state);
  assert.deepEqual([await gone.list(`${state}/never`), await gone.readText(`${state}/never`)], [null, null]);
});

test('the guard on real links: dangling, to a folder above, through `..`, and the state folder behind one', async (t) => {
  const base = (await folder(t)).replace(/\/state$/, '');
  for (const d of ['real/plancia', 'home', 'proj/sub']) await mkdir(`${base}/${d}`, { recursive: true });
  await symlink(`${base}/real`, `${base}/home/.config`);
  await symlink(`${base}/real`, `${base}/proj/up`);
  await symlink(`${base}/home/.config/plancia/new.json`, `${base}/proj/dangling`);
  await symlink(`${base}/real/plancia`, `${base}/proj/sub/in`);
  await symlink('loop', `${base}/proj/loop`);
  await symlink('/proc/self/cwd', `${base}/proj/here`);
  await symlink('/proc/self', `${base}/proj/self`);
  await symlink('/proc/self/cwd/../plancia', `${base}/proj/above`);
  await symlink('/proc/self/cwd/../../../plancia', `${base}/proj/far`);
  const at = (cwd: string, file_path: string) =>
    guardToolCall('Write', { file_path }, cwd, dirsOf(`${base}/home`, {}), { real: (p) => realPaths(real$, p, cwd), ids: (p) => fileIds(real$, p, cwd) });
  const guard = (file_path: string) => at(`${base}/proj`, file_path);
  for (const p of ['home/.config/plancia/state.json', 'real/plancia/state.json', 'proj/up/plancia/a/b', 'proj/dangling', 'proj/sub/in', 'proj/sub/in/x',
    'proj/sub/in/../plancia/x', 'proj/loop/../sub/in/x', 'proj/up/../sub/in/x'])
    assert.match((await guard(`${base}/${p}`)) ?? 'allowed', /Plancia/, p);
  // relative to the process that asks: the one that looks stands in the session's folder
  assert.match((await at(`${base}/real`, `${base}/proj/here/plancia/x`)) ?? 'allowed', /Plancia/);
  // the engine's own folder may be another (a `cd` in the session), or the session's gone: refused wherever it leads from there
  for (const [cwd, p] of [['proj', 'here/x'], ['proj/sub', 'here'], ['proj', 'above/x'], ['proj/sub', 'far/x'], ['never', 'here/x'], ['never', 'above']])
    assert.match((await at(`${base}/${cwd}`, `${base}/proj/${p}`)) ?? 'allowed', /\/proc/, `${cwd} ${p}`);
  for (const cwd of ['/', '/proc', '/dev']) assert.match((await at(cwd, `${base}/proj/above`)) ?? 'allowed', /Plancia/, cwd);
  // longer than an argument, or a path, can be: what cannot be opened hides nothing beside it
  assert.match((await guard(`up/${'a/../'.repeat(50_000)}plancia/state.json`)) ?? 'allowed', /Plancia/);
  for (const p of ['proj/dangling', 'proj/sub/in/x']) assert.match((await guard(`${' '.repeat(200_000)}${base}/${p}`)) ?? 'allowed', /Plancia/, p);
  // another process's open files, behind a link
  assert.match((await guard('self/fd/99/x')) ?? 'allowed', /\/proc/);
  // one folder, any name: what stat says of it
  assert.deepEqual(await fileIds(real$, [`${base}/home/.config/plancia`, `${base}/never`], '/'), await fileIds(real$, [`${base}/proj/sub/in`], '/never'));
  assert.equal((await fileIds(real$, [base], '/')).length, 1);
  for (const p of ['up/plancia/x', '~/.config/plancia/x', '../real/plancia/x']) assert.match((await guard(p)) ?? 'allowed', /Plancia/, p);
  for (const p of ['proj/x', 'proj/up/other', 'proj/loop/x', 'real/plancia-notes', 'home/new/file']) assert.equal(await guard(`${base}/${p}`), null, p);
});
