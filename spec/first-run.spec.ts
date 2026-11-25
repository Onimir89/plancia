// A new user's machine on the real file system and the real coreutils, through the mod's adapter.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import {
  EMPTY_LOCAL, MINIMAL, SESSION_TTL_DAYS, applyChat, applyPatch, compile, dirsOf, itemKey, localSettingsPath, readInventory, readState, resetAll, resolvePreset, saveSession,
  statePath, writeProtected, type Ctx, type SessionState,
} from '../src/core/index.ts';
import { fsOf, touchLocal } from '../mod/adapter.ts';
import { real$ } from './realfs.ts';

const NOW = new Date(Date.UTC(2026, 10, 24));
/** A home with nothing in it, and projects to work on. */
async function home(t: TestContext) {
  const base = await mkdtemp(`${tmpdir()}/plancia-first-`);
  t.after(async () => { await chmodAll(base); await rm(base, { recursive: true }); });
  const dirs = dirsOf(`${base}/home`, {});
  const ctx = (root: string): Ctx => ({ ...dirs, root: `${base}/${root}`, fs: fsOf(real$, dirs.state) });
  for (const d of ['home', 'proj']) await mkdir(`${base}/${d}`);
  return { base, dirs, ctx };
}
async function chmodAll(dir: string): Promise<void> {
  await chmod(dir, 0o755).catch(() => undefined);
  for (const d of await readdir(dir, { withFileTypes: true })) if (d.isDirectory()) await chmodAll(`${dir}/${d.name}`);
}
const put = async (path: string, text: string) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, text); };
const tree = async (dir: string): Promise<string[]> => {
  const out = [];
  for (const d of (await readdir(dir, { recursive: true, withFileTypes: true }))) {
    const p = `${d.parentPath}/${d.name}`;
    out.push(d.isFile() ? `${p}: ${await readFile(p, 'utf8')}` : `${p}/`);
  }
  return out.sort();
};
const chat = (c: Ctx, at: Date): SessionState => ({ root: c.root, preset: 'X', desired: {}, hooksOff: [], updatedAt: at.toISOString() });
const applyTo = (c: Ctx, id: string, at = NOW) => applyChat(c, id, chat(c, at), at, (fs) => touchLocal(real$, fs, c.root, true));
const makeDefault = async (c: Ctx) => {
  const { items } = await readInventory(c);
  return applyPatch(c, compile(items, resolvePreset(MINIMAL, [], items)), { preset: MINIMAL, now: NOW });
};
const memoryKey = async (c: Ctx) => (await readInventory(c)).items.map(itemKey);

test('an empty home: only the auto memory, no warning, nothing written; the state folder comes with the first save, with the usual permissions', async (t) => {
  const { base, dirs, ctx } = await home(t);
  const inv = await readInventory(ctx('proj'));
  assert.deepEqual([inv.items.map((i) => i.name), inv.warnings, inv.protectedKeys], [['MEMORY.md (auto memory)'], [], undefined]);
  assert.deepEqual(await tree(base), [`${base}/home/`, `${base}/proj/`]);
  await writeProtected(ctx('proj').fs, dirs.state, []);
  assert.deepEqual(await readdir(dirs.state), ['protected.json']);
  const mode = async (p: string) => (await stat(p)).mode & 0o777;
  await mkdir(`${base}/usual`);
  await writeFile(`${base}/usual.json`, '');
  assert.deepEqual([await mode(dirs.state), await mode(`${dirs.state}/protected.json`)], [await mode(`${base}/usual`), await mode(`${base}/usual.json`)]);
});

test('every source missing a permission, a link to nowhere, a folder, empty, broken: what is good stays listed, the rest is skipped', async (t) => {
  for (const kind of ['denied', 'dangling', 'folder', 'empty', 'broken'] as const) {
    const { base, dirs, ctx } = await home(t);
    const c = ctx('proj');
    const file = async (p: string, text = 'x') => {
      await mkdir(dirname(p), { recursive: true });
      if (kind === 'dangling') await symlink(`${base}/nowhere`, p);
      else if (kind === 'folder') await mkdir(p);
      else await writeFile(p, kind === 'empty' ? '' : kind === 'broken' ? '---\n{ [: "\n' : text);
      if (kind === 'denied') await chmod(p, 0);
    };
    for (const f of ['settings.json', '.config.json', 'plugins/installed_plugins.json', 'CLAUDE.md', 'rules/a.md', 'skills/bad/SKILL.md', 'agents/bad.md', 'commands/bad.md'])
      await file(`${dirs.claude}/${f}`);
    for (const f of [dirs.claudeJson, `${c.root}/.mcp.json`, `${c.root}/.claude/settings.json`, localSettingsPath(c.root), `${c.root}/CLAUDE.md`]) await file(f);
    await put(`${dirs.claude}/skills/good/SKILL.md`, '---\nname: good\n---\n');
    if (kind === 'denied') {
      await mkdir(`${c.root}/.claude/skills`);
      await chmod(`${c.root}/.claude/skills`, 0);
    }
    const inv = await readInventory(c);
    const keys = inv.items.map(itemKey);
    assert.ok(keys.includes('skill:good') && keys.some((k) => k.endsWith('/memory/MEMORY.md')), kind);
    const extra = keys.filter((k) => k !== 'skill:good' && !k.endsWith('/memory/MEMORY.md')).map((k) => k.replace(base, '')).sort();
    // a text file that says nothing of itself is listed by its file name
    assert.deepEqual(extra, {
      denied: ['agent:bad', 'skill:bad'], dangling: ['agent:bad', 'skill:bad'], folder: ['agent:bad', 'skill:bad'],
      empty: ['agent:bad', 'rule:/home/.claude/CLAUDE.md', 'rule:/home/.claude/rules/a.md', 'rule:/proj/CLAUDE.md', 'skill:bad'],
      broken: ['agent:bad', 'rule:/home/.claude/CLAUDE.md', 'rule:/home/.claude/rules/a.md', 'rule:/proj/CLAUDE.md', 'skill:bad'],
    }[kind], kind);
    assert.equal(inv.warnings.length > 0, kind === 'denied' || kind === 'broken', `${kind}: ${inv.warnings}`);
  }
});

test('folders of rules linked in a loop: the reading ends', { timeout: 10_000 }, async (t) => {
  const { dirs, ctx } = await home(t);
  await put(`${dirs.claude}/rules/a.md`, '# A');
  for (const l of ['one', 'two', 'three']) await symlink('.', `${dirs.claude}/rules/${l}`);
  const keys = await memoryKey(ctx('proj'));
  assert.ok(keys.some((k) => k.endsWith('/.claude/rules/a.md')));
});

test('a folder where state.json belongs: the save fails and says so', async (t) => {
  const { dirs, ctx } = await home(t);
  await mkdir(statePath(dirs.state), { recursive: true });
  await assert.rejects(saveSession(ctx('proj').fs, dirs.state, 'a', chat(ctx('proj'), NOW), NOW), /state\.json/);
  assert.deepEqual([await readdir(dirs.state), await readdir(statePath(dirs.state))], [['state.json'], []]);
});

test('a project that cannot be written: Apply and Make default fail with the file and why, and leave nothing', async (t) => {
  const { dirs, ctx } = await home(t);
  const c = ctx('proj');
  await mkdir(`${c.root}/.claude`);
  await chmod(`${c.root}/.claude`, 0o555);
  const why = new RegExp(`cannot write ${localSettingsPath(c.root)}: .*EACCES`);
  await assert.rejects(applyTo(c, 'a'), why);
  await assert.rejects(makeDefault(c), why);
  assert.deepEqual(await readState(c.fs, dirs.state), { version: 1, projects: {}, sessions: {}, created: {} });
  assert.deepEqual(await readdir(`${c.root}/.claude`), []);
});

test('reset --all: every project exactly as it was, however Plancia came to write there', async (t) => {
  const { base, dirs, ctx } = await home(t);
  const old = new Date(NOW.getTime() - (SESSION_TTL_DAYS + 1) * 86_400_000);
  for (const d of ['both', 'default', 'old', 'emptied']) await put(`${base}/${d}/README.md`, '');
  await mkdir(`${base}/folder/.claude`, { recursive: true });                // the user's own empty folder
  await put(`${base}/mine/.claude/settings.local.json`, EMPTY_LOCAL);         // the user's own empty file
  await put(`${base}/team/.claude/settings.json`, '{}');                      // a .claude without a local file
  await put(`${base}/full/.claude/settings.local.json`, '{\n  "foo": 1\n}\n');
  const projects = async () => (await tree(base)).filter((p) => !p.startsWith(`${base}/home/`));
  const before = await projects();
  // a chat expired meanwhile: its record goes at the next write, what it made stays known
  for (const [n, d] of ['old', 'folder', 'mine'].entries()) await applyTo(ctx(d), `expired-${n}`, old);
  await applyTo(ctx('both'), 'a');
  await makeDefault(ctx('both'));
  await makeDefault(ctx('default'));
  await applyTo(ctx('team'), 'b');
  await makeDefault(ctx('full'));
  await applyTo(ctx('emptied'), 'c');
  await rm(localSettingsPath(`${base}/emptied`));                             // the user took the file, the folder stayed
  // a write killed half-way
  await put(`${base}/default/.claude/settings.local.json.1764000000000-abc.plancia-tmp`, '{');
  const state = await readState(ctx('proj').fs, dirs.state);
  assert.deepEqual(Object.keys(state.sessions).sort(), ['a', 'b', 'c']);
  assert.deepEqual(state.created, Object.fromEntries(
    [['both', 'dir'], ['default', 'dir'], ['emptied', 'dir'], ['folder', 'file'], ['old', 'dir'], ['team', 'file']].map(([d, k]) => [`${base}/${d}`, k])));
  const out = await resetAll(ctx('proj'), NOW);
  assert.deepEqual(out.filter((o) => o.error || o.result!.conflicts.length), []);
  assert.deepEqual(await projects(), before);
  assert.deepEqual(await readState(ctx('proj').fs, dirs.state), { version: 1, projects: {}, sessions: {}, created: {} });
});

test('reset --all keeps a file and a folder Plancia made once the user has put something there', async (t) => {
  const { base, ctx } = await home(t);
  await applyTo(ctx('proj'), 'a');
  await put(localSettingsPath(`${base}/proj`), '{"mine":1}');
  await put(`${base}/proj/.claude/notes.md`, 'mine');
  await resetAll(ctx('proj'), NOW);
  assert.deepEqual((await tree(`${base}/proj`)).map((p) => p.replace(base, '')), ['/proj/.claude/', '/proj/.claude/notes.md: mine', '/proj/.claude/settings.local.json: {"mine":1}']);
});

test('the only commands are those of coreutils', async () => {
  const mod = new URL('../mod/', import.meta.url);
  const source = (await Promise.all((await readdir(mod)).filter((f) => /\.tsx?$/.test(f)).map((f) => readFile(new URL(f, mod), 'utf8')))).join('\n');
  assert.deepEqual([...new Set([...source.matchAll(/\['([a-z]+)', '-/g)].map((m) => m[1]))].sort(), ['chmod', 'mv', 'readlink', 'realpath', 'rm', 'rmdir', 'stat', 'touch']);
  assert.equal([...source.matchAll(/process\.(?:run|spawn)\(/g)].length, 5);
  assert.equal([...source.matchAll(/process\.run\(argv|process\.run\(\['(?:touch|mv)'/g)].length, 5);
});
