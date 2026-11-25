// Files that are symbolic links: Plancia writes the file the link leads to and the link stays. Real file system and coreutils.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  DEFAULT, EMPTY_LOCAL, applyChat, applyPatch, dirsOf, localSettingsPath, panelPath, presetsPath, protectedPath, readState, resetProject, savePreset, saveSession,
  statePath, stepPanelRows, writeProtected, type Ctx, type Fs, type Patch, type SessionState,
} from '../src/core/index.ts';
import { fsOf, touchLocal } from '../mod/adapter.ts';
import { real$ } from './realfs.ts';

const NOW = new Date(Date.UTC(2026, 10, 24, 10));
const OWN = { model: 'mine' };
const PATCH: Patch = { ops: [{ item: 'skill:a', on: false, kind: 'set', path: ['skillOverrides', 'a'], value: 'off' }], hooksOff: [] };
const OFF = { skillOverrides: { a: 'off' } };

/** A project with its .claude folder, a folder elsewhere for what the links lead to, and Plancia's state. */
async function place(t: TestContext) {
  const base = await mkdtemp(`${tmpdir()}/plancia-links-`);
  t.after(() => rm(base, { recursive: true }));
  const dirs = dirsOf(base, {});
  for (const d of [`${base}/proj/.claude`, `${base}/else`, dirs.state]) await mkdir(d, { recursive: true });
  const ctx: Ctx = { ...dirs, root: `${base}/proj`, fs: fsOf(real$, dirs.state) };
  const chat: SessionState = { root: ctx.root, preset: 'X', desired: {}, hooksOff: [], updatedAt: NOW.toISOString() };
  return {
    base, ctx, chat, local: localSettingsPath(ctx.root), target: `${base}/else/real.json`,
    apply: () => applyPatch(ctx, PATCH, { preset: 'X', now: NOW }),
    applyChat: () => applyChat(ctx, 'chat', chat, NOW, (fs) => touchLocal(real$, fs, ctx.root, true)),
    reset: () => resetProject(ctx, { now: NOW }),
  };
}
/** Every file and link under the folder, a link with where it leads; a folder only when empty. */
async function tree(dir: string): Promise<string[]> {
  const out = await Promise.all((await readdir(dir, { withFileTypes: true })).map(async (d) => {
    const path = `${dir}/${d.name}`;
    if (d.isSymbolicLink()) return [`${d.name} -> ${await readlink(path)}`];
    if (!d.isDirectory()) return [d.name];
    const inside = await tree(path);
    return inside.length ? inside.map((p) => `${d.name}/${p}`) : [`${d.name}/`];
  }));
  return out.flat().sort();
}
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));

test('a linked settings.local.json: default and reset write the real file, through a chain of relative links', async (t) => {
  const { base, local, target, apply, reset } = await place(t);
  await writeFile(target, JSON.stringify(OWN));
  await symlink('real.json', `${base}/else/hop.json`);
  await symlink('../../else/hop.json', local);
  const proj = ['.claude/settings.local.json -> ../../else/hop.json'];
  await apply();
  assert.deepEqual([await json(target), await tree(`${base}/proj`), await tree(`${base}/else`)], [{ ...OWN, ...OFF }, proj, ['hop.json -> real.json', 'real.json']]);
  // a write that was killed left its temporary file beside the real one: the reset takes that and nothing else
  const others = ['other.json.1-a.plancia-tmp', 'real.json.bak', 'real.json.x.y.plancia-tmp'];
  for (const f of ['real.json.1-a.plancia-tmp', ...others]) await writeFile(`${base}/else/${f}`, '');
  await reset();
  assert.deepEqual([await json(target), await tree(`${base}/proj`), await tree(`${base}/else`)], [OWN, proj, ['hop.json -> real.json', 'real.json', ...others].sort()]);
});

test('a link to a file that is not there: default and Apply make that file, reset removes it, the link stays', async (t) => {
  const { base, local, target, apply, applyChat, reset } = await place(t);
  await symlink(target, local);
  const proj = ['.claude/settings.local.json -> ' + target];
  for (const [write, made] of [[apply, OFF], [applyChat, JSON.parse(EMPTY_LOCAL)]] as const) {
    await write();
    assert.deepEqual([await json(target), await tree(`${base}/proj`), await tree(`${base}/else`)], [made, proj, ['real.json']]);
    await reset();
    assert.deepEqual([await tree(`${base}/proj`), await tree(`${base}/else`)], [proj, []]);
  }
});

test('a link in a cycle, or into a folder that is not there: an error, nothing written, the link stays', async (t) => {
  for (const [to, why] of [['settings.local.json', /Too many levels/], ['../gone/x.json', /No such file/]] as const) {
    const { base, ctx, local, apply, applyChat } = await place(t);
    await symlink(to, local);
    const before = await tree(base);
    await assert.rejects(apply, why);
    assert.deepEqual(await tree(base), before);
    await assert.rejects(applyChat, why);
    assert.deepEqual([await tree(`${base}/proj`), (await readState(ctx.fs, ctx.state)).sessions], [['.claude/settings.local.json -> ' + to], {}]);
  }
});

test('a local file another makes while Apply makes its own is never written over', async (t) => {
  const { base, ctx, local } = await place(t);
  // just before the first write, the user's editor
  const fs: Fs = Object.assign(Object.create(ctx.fs), {
    writeText: async (p: string, data: string) => {
      await writeFile(local, JSON.stringify(OWN));
      await ctx.fs.writeText(p, data);
    },
  });
  await touchLocal(real$, fs, ctx.root, true);
  assert.deepEqual([await json(local), await tree(`${base}/proj`)], [OWN, ['.claude/settings.local.json']]);
});

test('a local file Apply cannot make: an error that says which and why, nothing left', async (t) => {
  const { base, ctx, local } = await place(t);
  const run = async (argv: string[], init: object) => (argv[0] === 'mv' ? { exitCode: 1, stdout: '', stderr: 'mv: no space left\n' } : real$.process.run(argv, init));
  await assert.rejects(touchLocal({ ...real$, process: { run } }, ctx.fs, ctx.root, true), { message: `cannot write ${local}: mv: no space left` });
  assert.deepEqual(await tree(`${base}/proj`), ['.claude/']);
});

test('the local file keeps its permissions', async (t) => {
  for (const mode of [0o600, 0o640, 0o664]) {
    const { local, target, apply, reset } = await place(t);
    await writeFile(target, JSON.stringify(OWN));
    await chmod(target, mode);
    await symlink(target, local);
    for (const step of [apply, reset]) {
      await step();
      assert.equal(((await stat(target)).mode & 0o777).toString(8), mode.toString(8));
    }
  }
});

test("Plancia's own files as links: each write lands in the real file, the links stay", async (t) => {
  const { base, ctx, chat } = await place(t);
  const writes: [string, () => Promise<unknown>][] = [
    [statePath(ctx.state), () => saveSession(ctx.fs, ctx.state, 'chat', chat, NOW)],
    [presetsPath(ctx.state), () => savePreset(ctx.fs, ctx.state, { name: 'P', parent: DEFAULT, enable: [], disable: [] })],
    [protectedPath(ctx.state), () => writeProtected(ctx.fs, ctx.state, ['skill:a'])],
    [panelPath(ctx.state), () => stepPanelRows(ctx.fs, ctx.state, 5)],
  ];
  const names = writes.map(([path]) => path.slice(ctx.state.length + 1));
  for (const [n, [path, write]] of writes.entries()) {
    await symlink(`${base}/else/${names[n]}`, path);
    for (let twice = 0; twice < 2; twice++) await write(); // the file missing, then there
    assert.equal((await json(`${base}/else/${names[n]}`)).version, 1, path);
  }
  assert.deepEqual([await tree(`${base}/else`), await tree(ctx.state)], [[...names].sort(), names.map((f) => `${f} -> ${base}/else/${f}`).sort()]);
});

test('a state.json that cannot be written: the linked settings go back, through the link', async (t) => {
  const { base, ctx, local, target, apply } = await place(t);
  await writeFile(target, JSON.stringify(OWN));
  await symlink(target, local);
  await symlink('state.json', statePath(ctx.state));
  await assert.rejects(apply, /state\.json/);
  assert.deepEqual([await json(target), await tree(`${base}/proj`), await tree(`${base}/else`)], [OWN, ['.claude/settings.local.json -> ' + target], ['real.json']]);
});
