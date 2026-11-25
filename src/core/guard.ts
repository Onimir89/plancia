// Defence of Plancia's state folder against the agent: checks used by the mod's tool.call hook. Bash is not guarded.
import { dirsOf, type Dirs } from './types.js';
import { dirname, expandHome, normalize } from './util.js';

const WRITE_TOOLS: Record<string, string> = {
  Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path',
};
/** With the folders unknown: any home's. */
const DEFAULT_RE = /(^|\/)\.config\/plancia(\/|$)/;

const DENY_REASON = 'Plancia: its state, presets and protected items change only from the /plancia panel, not with tools.';

/** Names that mean another place in each process (working folder, root, open files): where they lead this session cannot be told. */
const MAGIC_RE = /^\/(proc|dev\/(fd|stdin|stdout|stderr))(\/|$)/;
const MAGIC_REASON = 'Plancia: /proc, /dev/fd and the standard streams can lead to its state: give the file by its own path.';
/** Linux's PATH_MAX: a longer one opens nothing, and would be too long an argument for the command that looks. */
const PATH_MAX = 4096;

/** This session's state folder and the default one, which a session with another XDG_CONFIG_HOME uses. */
const foldersOf = (d: Dirs) => [normalize(d.state), normalize(dirsOf(d.home, {}).state)];
const nfc = (p: string) => p.normalize('NFC');
const inside = (p: string, folders: string[]) => folders.map(nfc).some((f) => nfc(p) === f || nfc(p).startsWith(`${f}/`));
const withParents = (p: string): string[] => (p === '/' ? [] : [p, ...withParents(dirname(p))]);

/** The file a writing tool call names, as given and as Claude Code reads it (2.1.331: trimmed, NFC); none of another tool. */
function targets(tool: string, input: Record<string, unknown>): string[] {
  const field = WRITE_TOOLS[tool];
  const path = field ? input[field] : undefined;
  return typeof path === 'string' && path ? [...new Set([path, nfc(path.trim())])] : [];
}

/** Deny reason from the spelling alone, or null: `.`, `..` and `~` resolved, links not. `dirs` null = not known. */
export function guardSpelling(tool: string, input: Record<string, unknown>, cwd: string, dirs: Dirs | null): string | null {
  const paths = targets(tool, input).map((p) => expandHome(p, dirs?.home ?? '', cwd));
  if (paths.some((p) => (dirs ? inside(p, foldersOf(dirs)) : DEFAULT_RE.test(p)))) return DENY_REASON;
  return paths.some((p) => MAGIC_RE.test(p)) ? MAGIC_REASON : null;
}

/** What the file system says. */
export interface Look {
  /** Where the paths lead: links followed, missing parts kept. */
  real: (paths: string[]) => Promise<string[]>;
  /** What each path that is there is (device and inode), links followed. */
  ids: (paths: string[]) => Promise<string[]>;
}

/**
 * Deny reason for a tool call that would write Plancia's state, or null to let it through. The target counts as spelled
 * and as the kernel reads it (`link/..` is not `.`), where each leads, and every folder on the way by its inode: the state
 * folder has other names where a disk is mounted twice or ignores case.
 */
export async function guardToolCall(
  tool: string, input: Record<string, unknown>, cwd: string, dirs: Dirs | null, look: Look,
): Promise<string | null> {
  const denied = guardSpelling(tool, input, cwd, dirs);
  const given = targets(tool, input);
  if (denied || !given.length || !dirs) return denied;
  const asIs = (p: string) => (p.startsWith('/') ? p : p.startsWith('~/') ? `${dirs.home}${p.slice(1)}` : `${cwd}/${p}`);
  const spelled = given.map((p) => expandHome(p, dirs.home, cwd)).filter((p) => p.length < PATH_MAX);
  const [folders, paths] = await Promise.all([look.real(foldersOf(dirs)), look.real([...spelled, ...given.map(asIs).filter((p) => p.length < PATH_MAX)])]);
  if (paths.some((p) => inside(p, [...foldersOf(dirs), ...folders]))) return DENY_REASON;
  if (paths.some((p) => MAGIC_RE.test(p))) return MAGIC_REASON;
  const [state, way] = await Promise.all([look.ids(foldersOf(dirs)), look.ids([...new Set([...spelled, ...paths].flatMap(withParents))])]);
  return way.some((id) => state.includes(id)) ? DENY_REASON : null;
}
