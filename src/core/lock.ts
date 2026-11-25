// One writer at a time on Plancia's files, across chats (processes): the folder <state>/lock, holding one empty file named
// after its owner, `<ms it was taken>-<random>`. Who wants it makes such a folder elsewhere, file and all, and renames it into
// place, which the file system does only over no folder or an empty one: the lock is held from its first instant, by one.
import type { Fs } from './types.js';

/** A writer waits at most pollMs × polls (the sleeps count in a hook's 10 s); a lock older than deadMs was left by a killed process. */
export const LOCK = { pollMs: 50, polls: 60, deadMs: 60_000 } as const;
export const lockPath = (state: string) => `${state}/lock`;

const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const isDead = (owner: string) => !(Math.abs(Date.now() - Number.parseInt(owner, 10)) < LOCK.deadMs);
/** The Fs handed to a body that runs in the lock: what it calls takes no second one. */
const locked = new WeakSet<Fs>();

/**
 * Runs `body` in the lock: every read whose result it writes back belongs inside, on the Fs it is given. The lock is let
 * go by removing its owner's file, by name: a dead owner's too, so no live one is ever taken away; and an owner that
 * lost it (suspended for over deadMs) commits nothing more: rename and remove check first.
 * Throws, having written nothing, when another chat holds the lock past the wait.
 */
export async function withLock<T>(fs: Fs, state: string, body: (fs: Fs) => Promise<T>): Promise<T> {
  if (locked.has(fs)) return body(fs);
  const lock = lockPath(state);
  let me = '';
  let busy = false; // someone was seen in it
  let failed: unknown; // the first failure of the folder itself
  const fails = (e: unknown) => { failed ??= e; };
  // A look that fails (the folder goes while it is read) sees no one: the rename tells.
  const owners = async () => {
    const held = (await fs.list(lock).catch(fails)) ?? [];
    busy ||= held.length > 0;
    return held;
  };
  const drop = async (dir: string) => {
    // Failing (the folder is another's by now, or rm cannot run) leaves at worst a lock that dies of age.
    await fs.remove(`${dir}/${me}`).catch(() => undefined);
    await fs.remove(dir).catch(() => undefined);
  };
  const take = async () => {
    if ((await owners()).length) return false;
    me = unique();
    const own = `${lock}.${me}`; // shortcut: left there by a process killed right now; sweep it if such folders ever pile up
    try {
      await fs.writeText(`${own}/${me}`, '');
    } catch (e) {
      await drop(own);
      throw e;
    }
    try {
      await fs.rename(own, lock);
      return true;
    } catch (e) {
      fails(e);
      await owners(); // to another, most likely: busy
      await drop(own);
      await fs.remove(`${lock}/${me}`).catch(() => undefined); // it may have been renamed all the same
      return false;
    }
  };
  const acquire = async () => {
    for (let n = 0; n < LOCK.polls; n++) {
      if (await take()) return true;
      await fs.sleep(LOCK.pollMs);
    }
    return false;
  };
  if (!(await acquire())) {
    if (!busy) throw failed;
    // Dead owners are removed after the whole wait: one that is only waking up has had the time to finish.
    const held = await owners();
    if (held.every(isDead)) for (const o of held) await fs.remove(`${lock}/${o}`).catch(() => undefined);
    if (!held.every(isDead) || !(await acquire())) {
      throw new Error(`another Plancia window is writing (${lock}): nothing was written, try again in a minute`);
    }
  }
  const ifMine = <A extends unknown[]>(f: (...a: A) => Promise<void>) => async (...a: A) => {
    if (!(await owners()).includes(me)) throw new Error(`the lock was lost (${lock}): try again`);
    await f(...a);
  };
  const mine: Fs = Object.assign(Object.create(fs), { rename: ifMine(fs.rename.bind(fs)), remove: ifMine(fs.remove.bind(fs)) });
  locked.add(mine);
  try {
    return await body(mine);
  } finally {
    await drop(lock);
  }
}

/** A temporary file of its own beside `file`. */
export const tmpFor = (file: string) => `${file}.${unique()}.plancia-tmp`;

/** Replaces the file whole, through a temporary file of its own beside it; of a link, the file it leads to. In the lock. */
export async function atomicWrite(fs: Fs, path: string, data: string): Promise<void> {
  const file = await fs.real(path);
  const tmp = tmpFor(file);
  try {
    await fs.writeText(tmp, data);
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.remove(tmp).catch(() => undefined);
    throw e;
  }
}
