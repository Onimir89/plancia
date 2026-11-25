// Shared types of the plancia core. Pure TypeScript: no imports from 'claude-code', no node: modules.

/** Filesystem seen by the core. The mod implements it with `$.fs` (+ `$.process.run(['mv',…])` for rename), tests with MemFs. */
export interface Fs {
  /** File content, or null if missing / not a file. */
  readText(path: string): Promise<string | null>;
  /** Entry names of a directory (files and subdirectories), or null if missing / not a directory. */
  list(dir: string): Promise<string[] | null>;
  /** Writes the file, creating parent directories. */
  writeText(path: string, data: string): Promise<void>;
  /** The file `path` leads to: itself when it is no symbolic link. Throws on links in a cycle or into a missing folder. */
  real(path: string): Promise<string>;
  /** Atomic replace of `to` with `from`, a file; or a folder, where `to` is missing or an empty folder: else it throws. */
  rename(from: string, to: string): Promise<void>;
  /** Removes a file or an empty directory; nothing to do when missing. */
  remove(path: string): Promise<void>;
  sleep(ms: number): Promise<void>;
}

/** The folders outside the project, from dirsOf. */
export interface Dirs {
  home: string;
  /** Claude Code's configuration folder. */
  claude: string;
  /** Claude Code's global config file. */
  claudeJson: string;
  /** Plancia's own folder: state, presets, protected items, backups. */
  state: string;
}

/**
 * The one place that decides where Claude Code and Plancia keep their files; the caller reads the environment.
 * CLAUDE_CONFIG_DIR takes .claude.json along (https://code.claude.com/docs/en/claude-directory.md; the CLI 2.1.331:
 * join(CLAUDE_CONFIG_DIR || homedir, ".claude.json")). A relative XDG_CONFIG_HOME is ignored, as its specification says.
 */
export function dirsOf(home: string, env: { CLAUDE_CONFIG_DIR?: string | undefined; XDG_CONFIG_HOME?: string | undefined }): Dirs {
  const claude = env.CLAUDE_CONFIG_DIR?.replace(/\/+$/, '');
  const xdg = env.XDG_CONFIG_HOME?.startsWith('/') ? env.XDG_CONFIG_HOME.replace(/\/+$/, '') : `${home}/.config`;
  return { home, claude: claude || `${home}/.claude`, claudeJson: `${claude || home}/.claude.json`, state: `${xdg}/plancia` };
}

/** Where the core works: the folders and the project root (= `$.session.root`, launch folder). */
export interface Ctx extends Dirs {
  fs: Fs;
  root: string;
}

export type Category = 'skill' | 'plugin' | 'mcp' | 'agent' | 'rule' | 'hook';
export const CATEGORIES: readonly Category[] = ['skill', 'plugin', 'mcp', 'agent', 'rule', 'hook'];

/** How an item is switched in settings.local.json. */
export type Mechanism =
  | { kind: 'skillOverride' }   // skillOverrides[id] = "on" | "off"
  | { kind: 'denySkill' }       // permissions.deny += Skill(id)   (plugin skills)
  | { kind: 'plugin' }          // enabledPlugins[id] = bool
  | { kind: 'mcpjson' }         // disabledMcpjsonServers / enabledMcpjsonServers (.mcp.json of the project)
  | { kind: 'mcpDeny' }         // deniedMcpServers += {serverName}  (user, local, connectors)
  | { kind: 'denyAgent' }       // permissions.deny += Agent(id)
  | { kind: 'claudeMdExclude' } // claudeMdExcludes += absolute path
  | { kind: 'autoMemory' }      // autoMemoryEnabled = bool
  | { kind: 'hook'; event: string }; // not in settings: state.json hooksOff (settings.read)

export interface Item {
  category: Category;
  id: string;
  name: string;
  description: string;
  /** user | synced (skills and plugins from claude.ai) | plugin:<id> | project | local | connector | import | ancestor | memory | settings */
  source: string;
  path: string;
  /** Switched off only with an extra confirmation: in the user's protected.json, or it would take such an item along. */
  protected: boolean;
  /**
   * No switch. user: off by a list in a layer plancia does not manage (lists merge: local cannot turn it on);
   * session-start: a hook that runs before settings.read can act, always on;
   * required: a synced plugin the organization requires, on whatever enabledPlugins says.
   */
  locked: 'user' | 'session-start' | 'required' | null;
  /** State today without plancia: user + project settings + the user's own local entries. */
  on: boolean;
  mech: Mechanism;
  /** Rules loaded only through @imports: keys of the rules that import them (an excluded importer drops them). */
  importedBy?: string[];
}

export const itemKey = (i: Pick<Item, 'category' | 'id'>): string => `${i.category}:${i.id}`;

/** Desired or resolved state: item key → on. */
export type StateMap = Map<string, boolean>;

export interface Preset {
  name: string;
  parent: string | null;
  enable: string[];
  disable: string[];
}

export interface PatchOp {
  item: string;
  on: boolean;
  /** set = object key at path; add = membership of value in the list at path */
  kind: 'set' | 'add';
  path: string[];
  value: unknown;
}

export interface Patch {
  ops: PatchOp[];
  /** Hook ids (script file name + "#" + hash of the command + ":" + event) switched off for the project. */
  hooksOff: string[];
}

export const localSettingsPath = (root: string) => `${root}/.claude/settings.local.json`;
