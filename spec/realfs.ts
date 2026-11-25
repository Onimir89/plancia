// The mod's adapter on the real file system and the real coreutils: what $ answers, from Node.
import { execFile } from 'node:child_process';
import { access, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export const real$: any = {
  fs: {
    read: (p: string) => readFile(p, 'utf8'),
    exists: (p: string) => access(p).then(() => true, () => false),
    stat: async (p: string) => { const s = await stat(p); return { kind: s.isFile() ? 'file' : s.isDirectory() ? 'dir' : 'other' }; },
    list: async (p: string) => (await readdir(p)).map((name) => ({ name })),
    write: async (p: string, text: string) => { await mkdir(dirname(p), { recursive: true }); await writeFile(p, text); },
  },
  process: {
    run: ([cmd, ...args]: string[], init: { cwd?: string; env?: Record<string, string> } = {}) => new Promise((done) => {
      execFile(cmd!, args, { cwd: init.cwd, env: { ...process.env, ...init.env } }, (err, stdout, stderr) =>
        done({ exitCode: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr }));
    }),
  },
  clock: { sleep: (ms: number) => sleep(ms) },
};
