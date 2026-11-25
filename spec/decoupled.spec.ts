// Nothing of the author's machine in any file: only his name, in the files that name the author.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { textOf, tracked } from './tracked.ts';

const FORBIDDEN = [
  /shared\/rules/g, /ponytail/g, /Fabio/g, /PLANCIA_HOME/g,
  // machine paths, e-mail addresses, private hosts
  /\/mnt\//g, /\/home\/\w+/g, /\/Users\/\w+/g, /\b[A-Z]:\\/g, /[\w.+-]+@[\w-]+\.[a-z]{2,}\b/gi,
  /\b(?:10|127|192\.168|172\.(?:1[6-9]|2\d|3[01]))(?:\.\d{1,3}){2,3}\b/g, /\b[\w-]+\.(?:local|lan|internal)\b(?!\.(?:json|md)\b)/g,
];

test('no machine path, e-mail address, private host or tool of the author in any file; his name only where exactly listed', () => {
  assert.deepEqual(['README.md', 'CHANGELOG.md', '.github/workflows/ci.yml', 'mod/register.tsx', 'src/core/index.ts', 'hooks/plancia.json'].filter((f) => !tracked.includes(f)), []);
  const hits = tracked.filter((f) => f !== 'spec/decoupled.spec.ts').flatMap((f) => FORBIDDEN.flatMap((p) => [...textOf(f).matchAll(p)].map((m) => `${f}: ${m[0]}`)));
  assert.deepEqual(hits.sort(), ['.claude-plugin/marketplace.json: Fabio', '.claude-plugin/plugin.json: Fabio', 'LICENSE: Fabio']);
});
