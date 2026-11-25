// Every file of the repository that is text of ours (the lock file aside), as paths from its root.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export const ROOT = new URL('..', import.meta.url);
const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' });
export const tracked = out.split('\0').filter((f) => f && !/^package-lock\.json$|\.png$/.test(f));
export const textOf = (file: string) => readFileSync(new URL(file, ROOT), 'utf8');
