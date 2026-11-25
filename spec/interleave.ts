// Two chats writing at once: the actors' Fs calls run one at a time, in an order drawn from a seed.
import { MemFs } from '../src/core/memfs.ts';
import { dirname } from '../src/core/util.ts';

/**
 * Runs the actors on one MemFs; a sleeping actor goes on only when no other one can (a poll is far longer than a call).
 * A write is two steps, as on a disk: the missing folder is made, then the file, and by then the folder may be gone.
 */
export async function interleave(fs: MemFs, seed: number, ...actors: ((fs: MemFs) => Promise<unknown>)[]): Promise<PromiseSettledResult<unknown>[]> {
  const waiting = new Map<number, { go: () => void; sleeps: boolean }>();
  let live = actors.length;
  let wake = () => {};
  const turn = (id: number, sleeps: boolean) => new Promise<void>((go) => { waiting.set(id, { go, sleeps }); wake(); });
  const seen = (id: number) => new Proxy(fs, {
    get(target, name) {
      const f = Reflect.get(target, name);
      if (typeof f !== 'function') return f;
      return async (...args: unknown[]) => {
        await turn(id, name === 'sleep');
        if (name === 'sleep') return undefined;
        if (name === 'writeText') {
          const dir = dirname(args[0] as string);
          if (!(await target.list(dir))) target.dirs.add(dir);
          await turn(id, false);
          if (!(await target.list(dir))) throw new Error(`ENOENT: no such file or directory, open '${args[0]}'`);
        }
        return f.apply(target, args);
      };
    },
  });
  const runs = Promise.allSettled(actors.map((a, id) => a(seen(id)).finally(() => { live--; wake(); })));
  let rnd = Math.imul(seed + 1, 0x9e3779b1) >>> 0;
  while (live) {
    while (live && waiting.size < live) await new Promise<void>((r) => { wake = r; });
    const all = [...waiting];
    const ready = all.filter(([, w]) => !w.sleeps);
    const pool = ready.length ? ready : all;
    if (!pool.length) break;
    rnd = (Math.imul(rnd, 1664525) + 1013904223) >>> 0;
    const [id, w] = pool[Math.floor((rnd / 2 ** 32) * pool.length)]!;
    waiting.delete(id);
    w.go();
  }
  return runs;
}

/** What failed, as text: [] when every actor succeeded. */
export const failures = (runs: PromiseSettledResult<unknown>[]) => runs.flatMap((r) => (r.status === 'rejected' ? [String(r.reason)] : []));
