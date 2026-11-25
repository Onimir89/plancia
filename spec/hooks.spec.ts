import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hookId, withoutHooks, readInventory, itemKey } from '../src/core/index.ts';
import { hid, makeTree, ctx, userSettings } from './fixture.ts';

const deepFreeze = <T>(o: T): T => {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
};

const cmd = (command: string, args?: string[]) => ({ type: 'command', command, ...(args && { args }) });

const hookItems = async (hooks: unknown) =>
  (await readInventory(ctx(makeTree({ '/h/.claude/settings.json': JSON.stringify({ hooks }) })))).items.filter((i) => i.category === 'hook');

test('hookId: a readable name, a hash of the command, the event', () => {
  const named = (h: Record<string, unknown>, name: string) => assert.match(hookId('Stop', h), new RegExp(`^${name}#[0-9a-f]{16}:Stop$`), JSON.stringify(h));
  named(cmd('node /h/shared/hooks/resource-guard.cjs'), 'resource-guard\\.cjs');
  named(cmd('"/h/My Tools/hooks/guard.sh" pre'), 'guard\\.sh');
  named(cmd('python3 "$HOME/hooks/b.py"'), 'b\\.py');
  named(cmd('node', ['/h/My Tools/c.mjs', '--x']), 'c\\.mjs');
  named(cmd('bash -c "cd /h && ./d.sh"'), 'd\\.sh');
  named(cmd('/opt/bin/guard'), 'guard');
  named({ type: 'prompt', prompt: 'check' }, 'prompt');
  // a secret is never part of it
  named(cmd('T=s3cret /usr/bin/curl -H "Authorization: s3cret" https://x.example?t=s3cret.js'), 'curl');
  named(cmd('TOKEN=s3cret.py'), 'hook');
});

test('hookId: different commands are different hooks', () => {
  const hooks = [
    cmd('/h/a/guard.sh'), cmd('/h/b/guard.sh'), cmd('~/a/guard.sh'), cmd('$HOME/a/guard.sh'), cmd('"$HOME/a/guard.sh"'), cmd('$CLAUDE_PROJECT_DIR/a/guard.sh'),
    cmd('/h/a/guard.sh pre'), cmd('/h/a/guard.sh post'), cmd('bash /h/a/guard.sh'), cmd('/h/a/guard.sh', []), cmd('/h/a/guard.sh', ['pre']), cmd('/h/a/guard.sh', ['pre', 'x']), cmd('/h/a/guard.sh', ['pre x']),
    cmd('jq .Aa'), cmd('jq .BB'), cmd('jq ".a b"'), cmd('jq .a b'), cmd("echo 'x \"a\" y'"), cmd("echo 'x a y'"), cmd('echo "a\\" "b" c"'), cmd('echo "a\\" b c"'), cmd("echo '${HOME}'"), cmd("echo '$HOME'"),
    cmd('"A=1" x'), cmd('A=1 x'), cmd('a\nb'), cmd('a b'), cmd('${HOME}x'), cmd('$HOMEx'),
    { type: 'prompt', prompt: 'p' }, { type: 'prompt', prompt: 'q' }, { type: 'http', url: 'p' }, { type: 'mcp_tool', server: 's', tool: 't' }, { type: 'mcp_tool', server: 's', tool: 'u' },
  ];
  const ids = hooks.map((h) => hookId('Stop', h));
  assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), []);
  assert.notEqual(hookId('Stop', hooks[0]!), hookId('PreToolUse', hooks[0]!));
});

test('hookId: the spellings that are surely the same command', () => {
  for (const [a, b] of [
    ['/h/a/guard.sh', ' "/h/a/guard.sh" '], ['bash "/h/a/guard.sh" "pre"', 'bash /h/a/guard.sh pre'],
    ['${HOME}/a/guard.sh', '$HOME/a/guard.sh'], ['"${CLAUDE_PROJECT_DIR}"/g.sh', '"$CLAUDE_PROJECT_DIR"/g.sh'],
  ]) assert.equal(hookId('Stop', cmd(a!)), hookId('Stop', cmd(b!)), a);
});

test('a quoted path with spaces and an inline command are listed by what they run', async () => {
  const hooks = { Stop: [{ hooks: [cmd("'/h/My Tools/hooks/guard.sh' x"), cmd('echo 3.5 done'), cmd(`echo ${'y'.repeat(90)}`), { type: 'prompt', prompt: 'p' }] }] };
  assert.deepEqual((await hookItems(hooks)).map((i) => [i.name, i.path]), [
    ['guard', '/h/My Tools/hooks/guard.sh'], ['echo 3.5 done', ''], [`echo ${'y'.repeat(54)}…`, ''], ['prompt', ''],
  ]);
});

test('hooks with the same name are told apart in the list: a number, and the command after the event', async () => {
  const hooks = {
    PreToolUse: [{ matcher: 'Bash', hooks: [cmd('~/a/guard.sh'), cmd('/h/b/guard.py x')] }, { matcher: 'Edit', hooks: [cmd('~/a/guard.sh')] }],
    Stop: [{ hooks: [cmd('node', ['/h/b/guard.js', 'y']), cmd('~/a/other.sh')] }],
  };
  assert.deepEqual((await hookItems(hooks)).map((i) => [i.name, i.description, i.path]), [
    ['guard (1)', 'PreToolUse (Bash), Edit · ~/a/guard.sh', '/h/a/guard.sh'],
    ['guard (2)', 'PreToolUse (Bash) · ~/b/guard.py x', '/h/b/guard.py'],
    ['guard (3)', 'Stop · node ~/b/guard.js y', '/h/b/guard.js'],
    ['other', 'Stop', '/h/a/other.sh'],
  ]);
});

test('withoutHooks takes out the chosen hook only: not its namesake, nor the same command in a layer the user does not own', () => {
  const [a, b] = [cmd('/h/a/guard.sh'), cmd('/h/b/guard.sh')];
  const project = { PreToolUse: [{ matcher: 'Edit', hooks: [a] }], Stop: [{ hooks: [a] }] };
  const hooks = deepFreeze({ PreToolUse: [{ matcher: 'Bash', hooks: [a, b] }, ...project.PreToolUse], Stop: project.Stop });
  const layers = [{ source: 'user', settings: { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [a, b] }] } } }, { source: 'project', settings: { hooks: project } }];
  const off = [hookId('PreToolUse', a), hookId('Stop', a)];
  assert.deepEqual(withoutHooks(hooks, off, layers), { PreToolUse: [{ matcher: 'Bash', hooks: [b] }, ...project.PreToolUse], Stop: project.Stop });
  // without the layers, by the id alone
  assert.deepEqual(withoutHooks(hooks, off), { PreToolUse: [{ matcher: 'Bash', hooks: [b] }] });
});

test('the inventory uses the same hook ids', async () => {
  const items = (await readInventory(ctx(makeTree()))).items.filter((i) => i.category === 'hook');
  const ids = new Set<string>();
  for (const [event, groups] of Object.entries(userSettings().hooks as Record<string, any[]>))
    for (const g of groups) for (const h of g.hooks) ids.add(hookId(event, h));
  assert.deepEqual(items.map((i) => i.id).sort(), [...ids].sort());
  assert.ok(items.every((i) => itemKey(i) === `hook:${i.id}`));
});

test('withoutHooks drops the switched-off entries and keeps everything else', () => {
  const hooks = deepFreeze(structuredClone(userSettings().hooks)) as Record<string, any[]>;
  const out = withoutHooks(hooks, [hid('resource-guard.cjs', 'PreToolUse'), hid('sync-guard.sh', 'PostToolUse')]) as Record<string, any[]>;
  assert.deepEqual(out, {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'bash /h/shared/hooks/delete-guard.sh pre-bash' }] }],
    SessionStart: hooks.SessionStart,
    PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'node /h/shared/hooks/compressor-gate.cjs' }] }],
  });
});

test('withoutHooks removes empty groups and events, never SessionStart', () => {
  const hooks = deepFreeze(structuredClone(userSettings().hooks)) as Record<string, any[]>;
  const out = withoutHooks(hooks, [
    hid('resource-guard.cjs', 'PreToolUse'), hid('delete-guard.sh', 'PreToolUse'), hid('compressor-gate.cjs', 'SessionStart'),
  ]) as Record<string, any[]>;
  assert.equal('PreToolUse' in out, false);
  assert.deepEqual(out.SessionStart, hooks.SessionStart);
  assert.deepEqual(out.PostToolUse, hooks.PostToolUse);
});

test('withoutHooks returns the input itself when nothing matches, and tolerates junk', () => {
  const hooks = deepFreeze(structuredClone(userSettings().hooks));
  assert.equal(withoutHooks(hooks, []), hooks);
  assert.equal(withoutHooks(hooks, ['nope.sh:Stop']), hooks);
  assert.equal(withoutHooks(undefined, ['x:Stop']), undefined);
  const junk = deepFreeze({ Stop: 'not a list', PreToolUse: [null, { hooks: 'x' }] });
  assert.equal(withoutHooks(junk, ['x:Stop']), junk);
});
