// Fake home/project tree for the core tests. Built here, read by the modules under test.
import { MemFs } from '../src/core/memfs.ts';
import { dirsOf, hookId, protectedPath } from '../src/core/index.ts';

export const HOME = '/h';
export const DIRS = dirsOf(HOME, {});
export const ROOT = '/h/p/proj';
export const LOCAL = `${ROOT}/.claude/settings.local.json`;

const fm = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;

export function userSettings(): Record<string, unknown> {
  return {
    skillOverrides: { 'userskill-off': 'off', 'anthropic-skills:docx': 'off', alpha: 'name-only' },
    enabledPlugins: { 'pa@m': true, 'pb@m': false, 'plancia@local': true },
    deniedMcpServers: [{ serverName: 'claude.ai Gmail' }, { serverName: 'claude.ai Old' }],
    permissions: { deny: ['Agent(blocked-agent)', 'Read(//h/.ssh/**)'] },
    autoMemoryDirectory: '~/mem',
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [
          { type: 'command', command: 'node /h/shared/hooks/resource-guard.cjs' },
          { type: 'command', command: 'bash /h/shared/hooks/delete-guard.sh pre-bash' },
        ] },
      ],
      SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'node /h/shared/hooks/compressor-gate.cjs' }] }],
      PostToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'bash /h/shared/hooks/sync-guard.sh' }] },
        { matcher: 'Edit', hooks: [{ type: 'command', command: 'node /h/shared/hooks/compressor-gate.cjs' }] },
      ],
    },
  };
}

/** Id of the fixture's hook that runs `script` on `event`. */
export const hid = (script: string, event: string): string =>
  hookId(event, (userSettings().hooks as Record<string, any[]>)[event]!.flatMap((g) => g.hooks).find((h) => h.command.includes(`/${script}`)));

/** What the user of the fixture protects (protected.json). */
export const PROTECTED = [`hook:${hid('delete-guard.sh', 'PreToolUse')}`, `hook:${hid('resource-guard.cjs', 'PreToolUse')}`, 'rule:/h/team/rules.md'];

export function makeTree(extra: Record<string, string> = {}): MemFs {
  const files: Record<string, string> = {
    '/h/.claude/settings.json': JSON.stringify(userSettings()),
    '/h/.claude/.config.json': JSON.stringify({
      oauthAccount: { accountUuid: 'A', organizationUuid: 'O', emailAddress: 'x@y' },
      mcpServers: { u1: { type: 'stdio', command: 'u1-bin', env: { TOKEN: 'SECRET-VALUE' } } },
      claudeAiMcpEverConnected: ['claude.ai Drive', 'claude.ai Gmail'],
      projects: { [ROOT]: { mcpServers: { loc1: { command: 'loc1-bin' } } }, '/h/other': { mcpServers: { nope: {} } } },
    }),
    [protectedPath(DIRS.state)]: JSON.stringify({ version: 1, protected: PROTECTED }),
    // user skills
    '/h/.claude/skills/alpha/SKILL.md': fm('alpha', 'Alpha skill'),
    '/h/.claude/skills/userskill-off/SKILL.md': fm('userskill-off', '"Quoted: description"'),
    '/h/.claude/skills/empty-dir/README.md': 'no skill here',
    // user slash commands are listed as skills too
    '/h/.claude/commands/cmd1.md': 'Save something: $ARGUMENTS\n',
    '/h/.claude/commands/old.md.disabled': 'ignored',
    // synced skills: active bucket is <organizationUuid>_<accountUuid> (verified on the real ~/.claude)
    '/h/.claude/skills/synced/O_A/manifest.json': '{}',
    '/h/.claude/skills/synced/O_A/docx/SKILL.md': '---\nname: docx\ndescription: >\n  Word documents\n  and templates\n---\n',
    '/h/.claude/skills/synced/A_0/pptx/SKILL.md': fm('pptx', 'inactive bucket'),
    // plugins
    '/h/.claude/plugins/installed_plugins.json': JSON.stringify({
      version: 2,
      plugins: {
        'pa@m': [{ scope: 'user', installPath: '/h/.claude/plugins/cache/m/pa/1.0' }],
        'pb@m': [{ scope: 'user', installPath: '/h/.claude/plugins/cache/m/pb/1.0' }],
        'plancia@local': [{ scope: 'user', installPath: '/h/.claude/plugins/cache/local/plancia/0.1' }],
        'pc@m': [{ scope: 'project', projectPath: '/h/elsewhere', installPath: '/h/.claude/plugins/cache/m/pc/1.0' }],
      },
    }),
    '/h/.claude/plugins/cache/m/pa/1.0/.claude-plugin/plugin.json': JSON.stringify({ name: 'pa', description: 'Plugin A' }),
    '/h/.claude/plugins/cache/m/pa/1.0/skills/s1/SKILL.md': fm('s1', 'Skill one of pa'),
    '/h/.claude/plugins/cache/m/pa/1.0/commands/c1.md': '---\ndescription: Command one\n---\nbody',
    '/h/.claude/plugins/cache/m/pb/1.0/skills/s2/SKILL.md': fm('s2', 'disabled plugin skill'),
    '/h/.claude/plugins/cache/local/plancia/0.1/skills/ps/SKILL.md': fm('ps', 'plancia own'),
    // agents
    '/h/.claude/agents/executor.md': fm('executor', 'Executor'),
    '/h/.claude/agents/blocked-agent.md': fm('blocked-agent', 'Denied by user'),
    // rules
    '/h/.claude/CLAUDE.md': '# User rules\n\n@~/team/rules.md\n@~/team/other.md\n\n```\n@~/fake-in-fence.md\n```\nInline `@~/fake-inline.md` ignored.\n',
    '/h/team/rules.md': '# Team rules\n',
    '/h/team/other.md': '# Other\nsee @./nested.md\n',
    '/h/team/nested.md': '# Nested\n@../team/other.md\n',
    '/h/CLAUDE.md': '# Workspace\n',
    '/h/mem/MEMORY.md': '# Memory Index\n',
    // project
    [`${ROOT}/CLAUDE.md`]: '# Project rules\n',
    [`${ROOT}/.claude/rules/r1.md`]: '# R1\n',
    [`${ROOT}/.claude/skills/projskill/SKILL.md`]: fm('projskill', 'Project skill'),
    [`${ROOT}/.claude/agents/projagent.md`]: fm('projagent', 'Project agent'),
    [`${ROOT}/.mcp.json`]: JSON.stringify({ mcpServers: { pm1: { command: 'a' }, pm2: { command: 'b' } } }),
    [`${ROOT}/.claude/settings.json`]: JSON.stringify({ enabledMcpjsonServers: ['pm1', 'pm2'] }),
    ...extra,
  };
  return new MemFs(files);
}

const SYNCED_DIR = '/h/.claude/plugins/synced/O_A';
const UUID = '58da2c13-5ed4-4485-9625-fb87b369e6b4';
/** Plugins synced from claude.ai, laid out as Claude Code 2.1.332 does: manifest.json says which folders count. For makeTree. */
export const SYNCED: Record<string, string> = {
  [`${SYNCED_DIR}/manifest.json`]: JSON.stringify({ lastUpdated: 1, plugins: [
    { pluginId: 'p1', name: 'data', installationPreference: 'available' },
    { pluginId: 'p2', name: UUID, generation: 3 },
    { pluginId: 'p3', name: 'must', installationPreference: 'required' },
    { pluginId: 'p4', name: 'quiet' }, { pluginId: 'p5', name: 'not-landed' }, { pluginId: 'p6', name: 'plancia' },
  ] }),
  [`${SYNCED_DIR}/.marketplaces.json`]: '{}',
  [`${SYNCED_DIR}/data.meta.json`]: '{}',
  [`${SYNCED_DIR}/data/.claude-plugin/plugin.json`]: JSON.stringify({ name: 'data', description: 'Data plugin' }),
  [`${SYNCED_DIR}/data/skills/query/SKILL.md`]: fm('query', 'Query skill'),
  [`${SYNCED_DIR}/data/commands/chart.md`]: '---\ndescription: Chart\n---\nbody',
  // an older generation, and a folder the manifest does not name
  [`${SYNCED_DIR}/${UUID}/plugin.json`]: JSON.stringify({ name: 'notes', description: 'Old notes' }),
  [`${SYNCED_DIR}/${UUID}~g3/plugin.json`]: JSON.stringify({ name: 'notes', description: 'Notes' }),
  [`${SYNCED_DIR}/stale~g2/plugin.json`]: JSON.stringify({ name: 'stale' }),
  [`${SYNCED_DIR}/must/.claude-plugin/plugin.json`]: JSON.stringify({ name: 'must' }),
  [`${SYNCED_DIR}/quiet/.claude-plugin/plugin.json`]: JSON.stringify({ name: 'quiet', defaultEnabled: false }),
  [`${SYNCED_DIR}/plancia/.claude-plugin/plugin.json`]: JSON.stringify({ name: 'plancia' }),
  '/h/.claude/plugins/synced/A_0/manifest.json': JSON.stringify({ plugins: [{ pluginId: 'z', name: 'other' }] }),
  '/h/.claude/plugins/synced/A_0/other/plugin.json': JSON.stringify({ name: 'other', description: 'another account' }),
};

export const ctx = (fs: MemFs, root = ROOT) => ({ fs, root, ...DIRS });

// Every key the fixture inventory must contain, listed by hand from the tree above.
export const EXPECTED_KEYS = [
  'skill:alpha', 'skill:userskill-off', 'skill:cmd1', 'skill:anthropic-skills:docx', 'skill:pa:s1', 'skill:pa:c1', 'skill:projskill',
  'plugin:pa@m', 'plugin:pb@m',
  'mcp:u1', 'mcp:loc1', 'mcp:pm1', 'mcp:pm2', 'mcp:claude.ai Drive', 'mcp:claude.ai Gmail', 'mcp:claude.ai Old',
  'agent:executor', 'agent:blocked-agent', 'agent:projagent',
  'rule:/h/.claude/CLAUDE.md', 'rule:/h/team/rules.md', 'rule:/h/team/other.md', 'rule:/h/team/nested.md',
  'rule:/h/CLAUDE.md', `rule:${ROOT}/CLAUDE.md`, `rule:${ROOT}/.claude/rules/r1.md`, 'rule:/h/mem/MEMORY.md',
  `hook:${hid('resource-guard.cjs', 'PreToolUse')}`, `hook:${hid('delete-guard.sh', 'PreToolUse')}`, `hook:${hid('compressor-gate.cjs', 'SessionStart')}`,
  `hook:${hid('sync-guard.sh', 'PostToolUse')}`, `hook:${hid('compressor-gate.cjs', 'PostToolUse')}`,
].sort();
