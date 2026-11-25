// Two chats (processes) writing Plancia's files at once. No write is ever lost.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyPatch, atomicWrite, compile, copySession, deletePreset, ifUnchanged, itemKey, loadPresets, lockPath, readInventory, readPanelRows, readState, readView,
  resetAll, resetProject, resolvePreset, savePreset, saveSession, sessionFrom, sessionState, statePath, stepPanelRows, withLock,
  MINIMAL, LOCK, DEFAULT, type SessionState,
} from '../src/core/index.ts';
import { MemFs } from '../src/core/memfs.ts';
import { dirname } from '../src/core/util.ts';
import { hid, makeTree, ctx, DIRS, ROOT } from './fixture.ts';
import { failures, interleave } from './interleave.ts';

const SEEDS = Array.from({ length: 150 }, (_, n) => n);
const NOW = new Date(Date.UTC(2026, 10, 24, 10));
const chat = (over: Partial<SessionState> = {}): SessionState => ({ root: ROOT, preset: 'X', desired: {}, hooksOff: [], updatedAt: NOW.toISOString(), ...over });
const preset = (name: string) => ({ name, parent: DEFAULT, enable: [], disable: ['skill:alpha'] });
const patchOf = async (fs: ReturnType<typeof makeTree>, root: string) => {
  const { items } = await readInventory(ctx(fs, root));
  return compile(items, resolvePreset(MINIMAL, [], items));
};
/** Nothing of a write left behind: no temporary file, no lock. */
const leftovers = async (fs: MemFs) => [...fs.files.keys(), ...fs.dirs].filter((p) => p.includes('plancia-tmp') || p.startsWith(lockPath(DIRS.state)));

test('two chats saving their choice at once: both are there', async () => {
  for (const seed of SEEDS) {
    const fs = makeTree();
    const runs = await interleave(fs, seed, ...['a', 'b'].map((id) => (f: typeof fs) => saveSession(f, DIRS.state, id, chat(), NOW)));
    assert.deepEqual([failures(runs), Object.keys((await readState(fs, DIRS.state)).sessions).sort(), await leftovers(fs)], [[], ['a', 'b'], []], `seed ${seed}`);
  }
});

test("a chat's choice, a /clear, another project's default and a reset at once: each one's work stays", async () => {
  for (const seed of SEEDS) {
    const fs = makeTree();
    await applyPatch(ctx(fs, '/h/old'), { ops: [], hooksOff: ['x.sh:Stop'] }, { preset: 'X', now: NOW });
    await saveSession(fs, DIRS.state, 'from', chat(), NOW);
    const patch = await patchOf(fs, '/h/two');
    const runs = await interleave(fs, seed,
      (f) => saveSession(f, DIRS.state, 'a', chat(), NOW),
      (f) => copySession(f, DIRS.state, 'from', 'to', NOW),
      (f) => applyPatch(ctx(f, '/h/two'), patch, { preset: MINIMAL, now: NOW }),
      (f) => resetProject(ctx(f, '/h/old'), { now: NOW }));
    const st = await readState(fs, DIRS.state);
    assert.deepEqual([failures(runs), Object.keys(st.sessions).sort(), Object.keys(st.projects), await leftovers(fs)],
      [[], ['a', 'from', 'to'], ['/h/two'], []], `seed ${seed}`);
  }
});

test('two windows on the presets at once: saved and deleted ones are all right', async () => {
  for (const seed of SEEDS) {
    const fs = makeTree();
    await savePreset(fs, DIRS.state, preset('Old'));
    const runs = await interleave(fs, seed,
      (f) => savePreset(f, DIRS.state, preset('P')), (f) => savePreset(f, DIRS.state, preset('Q')), (f) => deletePreset(f, DIRS.state, 'Old'));
    assert.deepEqual([failures(runs), (await loadPresets(fs, DIRS.state)).map((p) => p.name).sort(), await leftovers(fs)], [[], ['P', 'Q'], []], `seed ${seed}`);
  }
});

test('the same project made default by two windows at once: the local file is exactly what state.json records', async () => {
  for (const seed of SEEDS) {
    const fs = makeTree();
    const full = await patchOf(fs, ROOT);
    const runs = await interleave(fs, seed,
      (f) => applyPatch(ctx(f), full, { preset: MINIMAL, now: NOW }),
      (f) => applyPatch(ctx(f), { ops: full.ops.slice(0, 2), hooksOff: [] }, { preset: 'Two', now: NOW }));
    assert.deepEqual([failures(runs), await leftovers(fs)], [[], []], `seed ${seed}`);
    // resetting takes out all of it: nothing was written that is not recorded
    await resetProject(ctx(fs), { now: NOW });
    assert.equal([...fs.files.keys()].includes(`${ROOT}/.claude/settings.local.json`), false, `seed ${seed}`);
  }
});

test('a protected item back on as the default, while another chat makes its choice for another folder, is back on everywhere', async () => {
  const HOOK = hid('resource-guard.cjs', 'PreToolUse');
  for (const seed of SEEDS) {
    const fs = makeTree();
    await applyPatch(ctx(fs), { ops: [], hooksOff: [HOOK] }, { preset: 'X', now: NOW });
    await saveSession(fs, DIRS.state, 'b', chat({ desired: { [itemKey({ category: 'hook', id: HOOK })]: false }, hooksOff: [HOOK] }), NOW);
    const runs = await interleave(fs, seed,
      (f) => applyPatch(ctx(f), { ops: [], hooksOff: [] }, { preset: DEFAULT, now: NOW }),
      (f) => saveSession(f, DIRS.state, 'c', chat({ root: '/h/two' }), NOW),
      (f) => copySession(f, DIRS.state, 'b', 'b2', NOW));
    const st = await readState(fs, DIRS.state);
    assert.deepEqual([failures(runs), st.projects[ROOT]!.hooksOff, Object.entries(st.sessions).map(([id, s]) => [id, s.desired, s.hooksOff]).sort()],
      [[], [], [['b', {}, []], ['b2', {}, []], ['c', {}, []]]], `seed ${seed}`);
  }
});

test('a draft is written only on the disk it was made on: whoever switches a protected item back on, no draft switches it off again', async () => {
  const HOOK = hid('resource-guard.cjs', 'PreToolUse');
  let refused = 0;
  for (const seed of SEEDS) {
    const fs = makeTree();
    await applyPatch(ctx(fs), { ops: [], hooksOff: [HOOK] }, { preset: 'X', now: NOW });
    const seen = await readView(ctx(fs), 'b');
    // what Apply gives the chat: one skill more, the hook as the default has it
    const desired = new Map(sessionState(seen.inv.items, seen.ps, chat({ hooksOff: [HOOK], desired: { [`hook:${HOOK}`]: false, 'skill:alpha': false } })));
    const ss = sessionFrom(seen.inv.items, desired, seen.ps, { root: ROOT, preset: 'X', now: NOW });
    assert.deepEqual(ss.hooksOff, [HOOK]);
    const runs = await interleave(fs, seed,
      (f) => ifUnchanged(ctx(f), 'b', seen, (c) => saveSession(c.fs, c.state, 'b', ss, NOW).then(() => true)),
      (f) => ifUnchanged(ctx(f), 'd', seen, (c) => applyPatch(c, { ops: [], hooksOff: [] }, { preset: DEFAULT, now: NOW })),
      (f) => saveSession(f, DIRS.state, 'c', chat({ root: '/h/two' }), NOW));
    const st = await readState(fs, DIRS.state);
    refused += runs.filter((r) => r.status === 'fulfilled' && r.value === null).length;
    assert.deepEqual([failures(runs), st.projects[ROOT]!.hooksOff, Object.values(st.sessions).flatMap((s) => s.hooksOff), await leftovers(fs)], [[], [], [], []], `seed ${seed}`);
  }
  assert.ok(refused > 0 && refused < SEEDS.length, `both orders seen: ${refused}`);
});

test('two windows on the height at once: the steps add up', async () => {
  for (const seed of SEEDS) {
    const fs = makeTree();
    await interleave(fs, seed, (f) => stepPanelRows(f, DIRS.state, 5), (f) => stepPanelRows(f, DIRS.state, 5));
    assert.equal(await readPanelRows(fs, DIRS.state), 20, `seed ${seed}`);
  }
});

// ---- the lock itself
const LOCKDIR = lockPath(DIRS.state);
const owner = (ageMs: number) => `${LOCKDIR}/${Date.now() - ageMs}-other`;
/** Every sleep of the writer, counted. */
function sleeps(fs: MemFs) {
  const slept: number[] = [];
  fs.sleep = async (ms?: number) => { slept.push(ms!); };
  return slept;
}

test('a live lock is respected: the wait has its limit, the message is clear, nothing is written, the lock stays', async () => {
  for (const ageMs of [0, LOCK.deadMs - 10_000]) {
    const held = owner(ageMs);
    const fs = makeTree({ [held]: '' });
    fs.dirs.add(LOCKDIR);
    const before = [...fs.files];
    const slept = sleeps(fs);
    for (const write of [
      () => saveSession(fs, DIRS.state, 'a', chat(), NOW), () => applyPatch(ctx(fs), { ops: [], hooksOff: ['x'] }, { preset: 'X', now: NOW }),
      () => savePreset(fs, DIRS.state, preset('P')), () => deletePreset(fs, DIRS.state, 'P'), () => stepPanelRows(fs, DIRS.state, 1),
      () => resetProject(ctx(fs), { now: NOW }), () => resetAll(ctx(fs), NOW),
    ]) {
      slept.length = 0;
      await assert.rejects(write, /another Plancia window is writing \(\/h\/\.config\/plancia\/lock\): nothing was written, try again/);
      assert.deepEqual([slept.length, slept.reduce((a, b) => a + b) <= 3000], [LOCK.polls, true]);
    }
    assert.deepEqual([...fs.files], before);
  }
});

test('a live lock released during the wait is waited for', async () => {
  const held = owner(0);
  const fs = makeTree({ [held]: '' });
  let polls = 0;
  fs.sleep = async () => { if (++polls === 3) { fs.files.delete(held); } };
  await saveSession(fs, DIRS.state, 'a', chat(), NOW);
  assert.deepEqual([polls, Object.keys((await readState(fs, DIRS.state)).sessions), await leftovers(fs)], [3, ['a'], []]);
});

test('a dead lock is recovered after the wait: its owner killed while it held it, or the clock set back; an empty one at once', async () => {
  for (const held of [[owner(LOCK.deadMs + 1000)], [owner(LOCK.deadMs + 1000), owner(LOCK.deadMs + 2000)], [], [owner(-LOCK.deadMs - 5000)], [`${LOCKDIR}/junk`]]) {
    const fs = makeTree(Object.fromEntries(held.map((p) => [p, ''])));
    fs.dirs.add(LOCKDIR);
    const slept = sleeps(fs);
    await saveSession(fs, DIRS.state, 'a', chat(), NOW);
    assert.deepEqual([Object.keys((await readState(fs, DIRS.state)).sessions), slept.length, await leftovers(fs)], [['a'], held.length && LOCK.polls, []], String(held));
  }
});

test('several writers recovering the same dead lock: never two at once, whoever says it saved did', async () => {
  let both = 0;
  for (const seed of [...SEEDS, ...SEEDS.map((n) => n + 1000)]) {
    const fs = makeTree(seed % 2 ? { [owner(LOCK.deadMs + 1000)]: '' } : {});
    fs.dirs.add(LOCKDIR);
    let inside = 0;
    // a sleep takes no turn: the three reach the end of the wait together
    const runs = await interleave(fs, seed, ...['a', 'b', 'c'].map((id) => (f: MemFs) => withLock(Object.assign(Object.create(f), { sleep: async () => {} }), DIRS.state, async (l) => {
      assert.equal(++inside, 1);
      await saveSession(l, DIRS.state, id, chat(), NOW);
      inside--;
    })));
    const saved = ['a', 'b', 'c'].filter((_, n) => runs[n]!.status === 'fulfilled');
    if (saved.length === 3) both++;
    assert.ok(failures(runs).every((f) => f.includes('another Plancia window is writing')), failures(runs).join());
    assert.deepEqual([Object.keys((await readState(fs, DIRS.state)).sessions).sort(), await leftovers(fs)], [saved, []], `seed ${seed}`);
  }
  assert.ok(both > 0);
});

test('a lock that goes to another right before it is had is waited for: never held twice, no error if the other leaves it', async () => {
  for (const stays of [true, false]) {
    const fs = makeTree();
    const other = owner(0);
    const rename = fs.rename.bind(fs);
    fs.rename = async (from, to) => {
      fs.rename = rename;
      fs.files.set(other, '');
      await rename(from, to);
    };
    let polls = 0;
    fs.sleep = async () => { if (++polls === 3 && !stays) fs.files.delete(other); };
    const save = saveSession(fs, DIRS.state, 'a', chat(), NOW);
    if (stays) await assert.rejects(save, /another Plancia window/);
    else await save;
    assert.deepEqual([polls, fs.files.has(statePath(DIRS.state)), await leftovers(fs)], stays ? [LOCK.polls, false, [other]] : [3, true, []]);
  }
});

test('a lock lost to others at every try, each gone by the next: the message is the same, in two waits at most', async () => {
  const fs = makeTree();
  const other = owner(0);
  const rename = fs.rename.bind(fs);
  fs.rename = async (from, to) => { fs.files.set(other, ''); await rename(from, to); };
  let polls = 0;
  fs.sleep = async () => { polls++; fs.files.delete(other); };
  await assert.rejects(saveSession(fs, DIRS.state, 'a', chat(), NOW), /another Plancia window/);
  assert.deepEqual([polls, fs.files.has(statePath(DIRS.state)), await leftovers(fs)], [LOCK.polls * 2, false, []]);
});

test('a lock that cannot be had for a real reason: that reason is the message, within the wait, and nothing is left', async () => {
  const cases: [string, (fs: MemFs) => void, RegExp, number][] = [
    ['no file can be written', (fs) => { fs.writeText = async (p) => { fs.dirs.add(dirname(p)); throw new Error('read-only'); }; }, /read-only/, 0],
    ['a file in its place', (fs) => { fs.files.set(LOCKDIR, 'mine'); }, /rename: .*lock/, LOCK.polls],
    ['no rename works', (fs) => { fs.rename = async () => { throw new Error('mv: not found'); }; }, /mv: not found/, LOCK.polls],
    ['the folder cannot be read', (fs) => { fs.files.set(owner(0), ''); fs.list = async () => { throw new Error('EACCES'); }; }, /EACCES/, LOCK.polls],
  ];
  for (const [name, breakIt, message, waited] of cases) {
    const fs = makeTree();
    breakIt(fs);
    const before = [...fs.files];
    const slept = sleeps(fs);
    await assert.rejects(savePreset(fs, DIRS.state, preset('P')), message, name);
    assert.deepEqual([slept.length, [...fs.files], [...fs.dirs]], [waited, before, []], name);
  }
});

test('a rename that fails after it was made leaves no lock', async () => {
  const fs = makeTree();
  const rename = fs.rename.bind(fs);
  fs.rename = async (from, to) => {
    fs.rename = rename;
    await rename(from, to);
    throw new Error('interrupted');
  };
  const slept = sleeps(fs);
  await saveSession(fs, DIRS.state, 'a', chat(), NOW);
  assert.deepEqual([slept.length, await leftovers(fs)], [1, []]);
});

test('an error inside releases the lock and leaves no temporary file', async () => {
  const fs = makeTree();
  await assert.rejects(withLock(fs, DIRS.state, async () => { throw new Error('boom'); }), /boom/);
  assert.deepEqual(await leftovers(fs), []);
  const rename = fs.rename;
  fs.rename = async (from, to) => { if (to !== LOCKDIR) throw new Error('disk full'); await rename.call(fs, from, to); };
  const before = [...fs.files];
  for (const write of [() => saveSession(fs, DIRS.state, 'a', chat(), NOW), () => savePreset(fs, DIRS.state, preset('P')), () => stepPanelRows(fs, DIRS.state, 1),
    async () => applyPatch(ctx(fs), await patchOf(fs, ROOT), { preset: MINIMAL, now: NOW })])
    await assert.rejects(write, /disk full/);
  assert.deepEqual([[...fs.files], await leftovers(fs)], [before, []]);
  fs.rename = rename;
  await savePreset(fs, DIRS.state, preset('P'));
  assert.deepEqual(await leftovers(fs), []);
});

test('an owner that lost the lock while it was suspended commits nothing more, and does not touch the new owner', async () => {
  const fs = makeTree();
  const newOwner = owner(0);
  await assert.rejects(withLock(fs, DIRS.state, async (l) => {
    for (const p of [...fs.files.keys()]) if (p.startsWith(LOCKDIR)) fs.files.delete(p);
    fs.files.set(newOwner, '');
    await assert.rejects(l.remove(`${ROOT}/CLAUDE.md`), /lock was lost/);
    await atomicWrite(l, statePath(DIRS.state), 'x');
  }), /lock was lost/);
  assert.deepEqual([fs.files.has(statePath(DIRS.state)), fs.files.has(newOwner), fs.files.has(`${ROOT}/CLAUDE.md`)], [false, true, true]);
});

test('each write has a temporary file of its own', async () => {
  const fs = makeTree();
  const tmp = new Set<string>();
  const rename = fs.rename.bind(fs);
  fs.rename = async (from, to) => { if (to !== LOCKDIR) tmp.add(from); return rename(from, to); };
  for (let n = 0; n < 3; n++) await saveSession(fs, DIRS.state, 'a', chat(), NOW);
  assert.equal(tmp.size, 3);
});
