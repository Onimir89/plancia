// /plancia reset --all, on every project of state.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyChat, applyPatch, compile, listTouchedProjects, readInventory, readState, resetAll, resetProject, resolvePreset, statePath,
  MINIMAL, EMPTY_LOCAL, type SessionState,
} from '../src/core/index.ts';
import { makeTree, ctx, DIRS, ROOT, LOCAL } from './fixture.ts';

const NOW = new Date(Date.UTC(2026, 10, 24));
const local = (root: string) => `${root}/.claude/settings.local.json`;
const chat = (root: string): SessionState => ({ root, preset: 'X', desired: {}, hooksOff: [], updatedAt: NOW.toISOString() });
/** A chat's Apply: the empty local file, where there is none. */
const chatIn = (fs: ReturnType<typeof makeTree>, root: string) =>
  applyChat(ctx(fs, root), 'sid', chat(root), NOW, async () => { if (!fs.files.has(local(root))) fs.files.set(local(root), EMPTY_LOCAL); });
const OWN = JSON.stringify({ foo: 1 }, null, 2) + '\n';

/** Plancia applied to ROOT (file created), /h/own (the user's own file) and the other roots asked for. */
async function applied(...more: string[]) {
  const fs = makeTree({ '/h/own/README.md': '', [local('/h/own')]: OWN });
  for (const r of more) fs.files.set(`${r}/README.md`, '');
  const before = new Map(fs.files);
  for (const root of [ROOT, '/h/own', ...more]) {
    const c = ctx(fs, root);
    const { items } = await readInventory(c);
    await applyPatch(c, compile(items, resolvePreset(MINIMAL, [], items)), { preset: MINIMAL, now: NOW });
  }
  return { fs, before };
}
const run = (fs: ReturnType<typeof makeTree>) => resetAll(ctx(fs), NOW);
/** Everything outside Plancia's own folder. */
const projects = (files: Map<string, string>) => [...files].filter(([p]) => !p.startsWith(`${DIRS.state}/`)).sort();

test('every known project goes back as it was, chat-only folders too, and the report says what was done', async () => {
  const { fs, before } = await applied();
  // a chat's Apply in a folder with no default: Plancia created the empty local file
  fs.files.set('/h/chat/README.md', '');
  before.set('/h/chat/README.md', '');
  await chatIn(fs, '/h/chat');
  assert.deepEqual(listTouchedProjects(await readState(fs, DIRS.state)), ['/h/chat', '/h/own', ROOT]);
  const out = await run(fs);
  assert.deepEqual(projects(fs.files), projects(before));
  assert.deepEqual(await readState(fs, DIRS.state), { version: 1, projects: {}, sessions: {}, created: {} });
  assert.deepEqual(out.map((o) => [o.root, o.error, o.result?.wrote, o.result?.localPath, o.result?.conflicts]), [
    ['/h/chat', undefined, true, local('/h/chat'), []],
    ['/h/own', undefined, true, local('/h/own'), []],
    [ROOT, undefined, true, LOCAL, []],
  ]);
  // second run: nothing left
  assert.deepEqual(await run(fs), []);
});

test('gone and unreadable projects are reported, keep their record and do not stop the others', async () => {
  const { fs } = await applied('/h/broken', '/h/gone', '/h/zz');
  for (const p of [...fs.files.keys()]) if (p.startsWith('/h/gone/')) fs.files.delete(p);
  fs.files.set(local('/h/broken'), '{ nope');
  const list = fs.list.bind(fs);
  fs.list = async (dir) => { if (dir === '/h/own') throw new Error('EACCES'); return list(dir); };
  const out = await run(fs);
  assert.deepEqual(out.map((o) => [o.root, !!o.result]), [['/h/broken', false], ['/h/gone', false], ['/h/own', false], [ROOT, true], ['/h/zz', true]]);
  assert.match(out[0]!.error!, /settings\.local\.json/);
  assert.match(out[1]!.error!, /not found/);
  assert.match(out[2]!.error!, /EACCES/);
  assert.equal(fs.files.get(local('/h/broken')), '{ nope');
  assert.deepEqual(Object.keys((await readState(fs, DIRS.state)).projects).sort(), ['/h/broken', '/h/gone', '/h/own']);
});

test('what the user changed by hand stays, and is reported as a conflict', async () => {
  const { fs } = await applied();
  const l = JSON.parse(fs.files.get(local('/h/own'))!);
  l.skillOverrides.alpha = 'on';
  fs.files.set(local('/h/own'), JSON.stringify(l));
  const out = await run(fs);
  assert.deepEqual(out.find((o) => o.root === '/h/own')!.result!.conflicts.map((c) => c.item), ['skill:alpha']);
  assert.deepEqual(JSON.parse(fs.files.get(local('/h/own'))!), { foo: 1, skillOverrides: { alpha: 'on' } });
});

test('an empty local file is removed only where a chat had Plancia write it', async () => {
  const fs = makeTree({ [LOCAL]: EMPTY_LOCAL });
  await resetProject(ctx(fs), { now: NOW });
  assert.equal(fs.files.get(LOCAL), EMPTY_LOCAL);
  // the user's own, the very bytes Plancia writes, with a chat that only touched it
  await chatIn(fs, ROOT);
  await resetProject(ctx(fs), { now: NOW });
  assert.equal(fs.files.get(LOCAL), EMPTY_LOCAL);
  // Plancia's, then changed by the user
  fs.files.delete(LOCAL);
  await chatIn(fs, ROOT);
  fs.files.set(LOCAL, '{}');
  await resetProject(ctx(fs), { now: NOW });
  assert.equal(fs.files.get(LOCAL), '{}');
  fs.files.delete(LOCAL);
  // chat's Apply first, then Make default over the empty file: the file is Plancia's all the same
  await chatIn(fs, ROOT);
  const { items } = await readInventory(ctx(fs));
  await applyPatch(ctx(fs), compile(items, resolvePreset(MINIMAL, [], items)), { preset: MINIMAL, now: NOW });
  await resetProject(ctx(fs), { now: NOW });
  assert.equal(fs.files.has(LOCAL), false);
  assert.ok(fs.files.has(statePath(DIRS.state)));
});

test('a reset that fails after the local file is taken back puts it as it was', async () => {
  const { fs } = await applied();
  const before = projects(fs.files);
  const state = fs.files.get(statePath(DIRS.state));
  const list = fs.list.bind(fs);
  fs.list = async (dir) => { if (dir === `${ROOT}/.claude`) throw new Error('EACCES'); return list(dir); };
  await assert.rejects(resetProject(ctx(fs), { now: NOW }), /EACCES/);
  assert.deepEqual(projects(fs.files), before);
  assert.equal(fs.files.get(statePath(DIRS.state)), state);
});
