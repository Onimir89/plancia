// A chat as a process of its own (lock-real.spec.ts): saves `count` choices, prints the ids it saved and what failed.
import { saveSession } from '../src/core/index.ts';
import { fsOf } from '../mod/adapter.ts';
import { real$ } from './realfs.ts';

const [state, name, count] = process.argv.slice(2) as [string, string, string];
const fs = fsOf(real$, state);
const out: { saved: string[]; failed: string[] } = { saved: [], failed: [] };
for (let n = 0; n < Number(count); n++) {
  const id = `${name}-${n}`;
  try {
    await saveSession(fs, state, id, { root: '/r', preset: null, desired: {}, hooksOff: [], updatedAt: new Date().toISOString() }, new Date());
    out.saved.push(id);
  } catch (e) {
    out.failed.push((e as Error).message);
  }
}
console.log(JSON.stringify(out));
