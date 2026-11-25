// A process killed between any two of its writes: what the next one finds can be applied again, and taken back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MINIMAL, MemFs, appliedState, applyChat, applyPatch, compile, itemKey, lockPath, projectOnly, readInventory, readState, readView, resetAll, resetProject, resolvePreset,
  type Fs, type Patch, type SessionState, type StateMap,
} from '../src/core/index.ts';
import { ctx, DIRS, hid, HOME, LOCAL, ROOT, makeTree } from './fixture.ts';

const NOW = new Date(Date.UTC(2026, 10, 24));
const OWN = JSON.stringify({ foo: 1, skillOverrides: { alpha: 'name-only' }, permissions: { deny: ['Agent(projagent)'] } }, null, 2) + '\n';

/** `fs`, where every write after the first `k` fails; `died()`: one did. */
function killedAfter(fs: MemFs, k: number) {
  let left = k;
  let dead = false;
  const gate = <A extends unknown[]>(f: (...a: A) => Promise<void>) => async (...a: A) => {
    if (left-- <= 0) {
      dead = true;
      throw new Error('killed');
    }
    await f(...a);
  };
  const out: Fs = Object.assign(Object.create(fs), { writeText: gate(fs.writeText.bind(fs)), rename: gate(fs.rename.bind(fs)), remove: gate(fs.remove.bind(fs)) });
  return { fs: out, died: () => dead };
}
/** A minute later: the lock a killed process left is dead. */
function later(fs: MemFs) {
  const out = new MemFs(Object.fromEntries([...fs.files].filter(([p]) => !p.startsWith(`${lockPath(DIRS.state)}/`))));
  for (const d of fs.dirs) out.dirs.add(d);
  return out;
}
const base = async (fs: MemFs) => (await readInventory(ctx(fs))).items.map((i) => [itemKey(i), i.on, i.locked]);
const shown = async (fs: MemFs) => {
  const { inv, ps } = await readView(ctx(fs), '');
  return new Map([...appliedState(inv.items, ps)].filter(([k]) => !k.startsWith('hook:')));
};
const named = async (fs: MemFs) => (({ preset = null, hooksOff = [] }) => ({ preset, hooksOff }))((await readState(fs, DIRS.state)).projects[ROOT] ?? {});
const outside = (fs: MemFs) => [...fs.files].filter(([p]) => !p.startsWith(`${DIRS.state}/`)).sort();
const patchOf = async (fs: MemFs, pick: (map: StateMap) => void = () => {}): Promise<Patch> => {
  const { items } = await readInventory(ctx(fs));
  const map = resolvePreset(MINIMAL, [], items);
  pick(map);
  return compile(items, map);
};
/** Minimal, but for some items of each kind. */
const other = (map: StateMap) => {
  for (const k of ['skill:alpha', 'skill:pa:s1', 'agent:executor', 'mcp:u1', `rule:${ROOT}/CLAUDE.md`, 'rule:/h/mem/MEMORY.md']) map.set(k, true);
  map.set('plugin:pa@m', true);
  map.set(`hook:${hid('compressor-gate.cjs', 'PostToolUse')}`, true);
};
const apply = (fs: Fs, patch: Patch, preset = 'P') => applyPatch({ ...ctx(new MemFs()), fs }, patch, { preset, now: NOW });

for (const [file, extra] of [['of the user', { [LOCAL]: OWN }], ['missing', {}]] as const) {
  const start = () => makeTree(extra);
  const minimal = async () => patchOf(start());
  const withDefault = async (patch: Patch, preset?: string) => {
    const fs = start();
    await apply(fs, patch, preset);
    return fs;
  };
  const steps: [string, () => Promise<MemFs>, (fs: Fs) => Promise<unknown>][] = [
    ['the first Make default', async () => start(), async (fs) => apply(fs, await minimal())],
    ['another default', async () => withDefault(await minimal()), async (fs) => apply(fs, await patchOf(start(), other), 'O')],
    ['the first default again', async () => withDefault(await patchOf(start(), other), 'O'), async (fs) => apply(fs, await minimal())],
    ['the reset', async () => withDefault(await minimal()), (fs) => resetProject({ ...ctx(new MemFs()), fs }, { now: NOW })],
  ];
  for (const [name, setup, step] of steps) {
    test(`local settings ${file}, ${name} killed after each write: nothing is taken for the user's, shown as it is, applied again, reset`, async () => {
      const pristine = await base(start());
      const done = await setup();
      const shownBefore = await shown(done);
      const namedBefore = await named(done);
      let halves = 0;
      await step(done);
      const shownAfter = await shown(done);
      const namedAfter = await named(done);
      let kills = 0;
      for (let k = 0; ; k++) {
        const fs = await setup();
        const killed = killedAfter(fs, k);
        await step(killed.fs).catch(() => undefined);
        if (!killed.died()) break;
        kills++;
        const left = later(fs);
        assert.deepEqual(await base(left), pristine, `after ${k} writes`);
        assert.deepEqual(await shown(left), left.files.get(LOCAL) === done.files.get(LOCAL) ? shownAfter : shownBefore, `after ${k} writes`);
        // the preset's name and the hooks only with the last write
        const half = (await readState(left, DIRS.state)).projects[ROOT]?.pending;
        if (half) halves++;
        if (half || left.files.get(LOCAL) !== done.files.get(LOCAL)) assert.deepEqual(await named(left), namedBefore, `after ${k} writes`);
        // the step again
        const again = later(left);
        assert.deepEqual((await step(again) as { conflicts: unknown[] }).conflicts, [], `after ${k} writes`);
        // a temporary file of the killed write stays till the reset
        assert.deepEqual([outside(again).filter(([p]) => !p.endsWith('.plancia-tmp')), (await readState(again, DIRS.state)).projects], [outside(done), (await readState(done, DIRS.state)).projects], `after ${k} writes`);
        // reset --all
        const out = await resetAll(ctx(left), NOW);
        assert.deepEqual(out.filter((o) => o.error || o.result!.conflicts.length), [], `after ${k} writes`);
        assert.deepEqual([outside(left), (await readState(left, DIRS.state)).projects], [outside(start()), {}], `after ${k} writes`);
        await resetAll(ctx(again), NOW);
        assert.deepEqual(outside(again), outside(start()), `after ${k} writes, done again`);
      }
      assert.ok(kills > 6 && halves > 1, `${kills} ${halves}`);
      assert.notDeepEqual(namedBefore, namedAfter);
    });
  }
}

test('what the user changes after a killed write is the user\'s: never written over, never taken back', async () => {
  for (let k = 0; ; k++) {
    const fs = makeTree({ [LOCAL]: OWN });
    const killed = killedAfter(fs, k);
    await apply(killed.fs, await patchOf(fs)).catch(() => undefined);
    if (!killed.died()) break;
    const left = later(fs);
    const mine = JSON.stringify({ ...JSON.parse(left.files.get(LOCAL)!), skillOverrides: { alpha: 'user-invocable-only' } }, null, 2) + '\n';
    left.files.set(LOCAL, mine);
    await resetAll(ctx(left), NOW);
    assert.deepEqual(JSON.parse(left.files.get(LOCAL)!).skillOverrides, { alpha: 'user-invocable-only' }, `after ${k} writes`);
  }
});

test('an Apply killed after each write: the folder goes back as it was', async () => {
  const chat: SessionState = { root: ROOT, preset: 'X', desired: { 'skill:alpha': false }, hooksOff: [], updatedAt: NOW.toISOString() };
  for (let k = 0; ; k++) {
    const fs = makeTree();
    const killed = killedAfter(fs, k);
    await applyChat({ ...ctx(fs), fs: killed.fs }, 'sid', chat, NOW, (locked) => locked.writeText(LOCAL, '{}\n')).catch(() => undefined);
    if (!killed.died()) break;
    const left = later(fs);
    await resetAll(ctx(left), NOW);
    assert.deepEqual(outside(left), outside(makeTree()), `after ${k} writes`);
  }
});
