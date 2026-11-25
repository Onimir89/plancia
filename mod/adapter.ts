// The $ adapter of the mod: Claude Code's environment, files and settings merge as the core sees them.
import type { EngineInterface, Origin } from 'claude-code'
import { EMPTY_LOCAL, dirsOf, localSettingsPath, tmpFor, type Ctx, type Dirs, type Fs } from '../src/core/index.js'

/** What a press may sleep in all, the wait for the lock included: the engine gives it 10 s, and counts its sleeps but no other `$` call. */
const PRESS_SLEEP_MS = 8500

/** A press of the pane that writes: this project's local file, how long it has slept, the merges counted right before that file last changed. */
export type Press = { local: string; file?: string; slept: number; before?: number }

async function sleep($: EngineInterface, ms: number, press?: Press): Promise<void> {
  await $.clock.sleep(ms)
  if (press) press.slept += ms
}

export const UNSUPPORTED = 'Plancia needs Linux or WSL'
/** macOS or native Windows; a Claude Code that does not say counts as supported. */
export async function isUnsupported($: EngineInterface): Promise<boolean> {
  return $.session.info().then((i) => i.platform === 'macos' || i.platform === 'windows', () => false)
}

export async function dirsFor($: EngineInterface): Promise<Dirs> {
  return dirsOf((await $.env.get('HOME')) || '', {
    CLAUDE_CONFIG_DIR: await $.env.get('CLAUDE_CONFIG_DIR'),
    XDG_CONFIG_HOME: await $.env.get('XDG_CONFIG_HOME'),
  })
}

/** What Plancia may remove outside its state: the local settings file it created and its own temporary files; a project's folder only with rmdir. */
const LOCAL_FILE = /\/\.claude\/settings\.local\.json$/
const TMP_FILE = /\.[\w-]+\.plancia-tmp$/
const CLAUDE_DIR = /\/\.claude$/

/** The core's Fs over $.fs; rename and remove through coreutils, remove only on files plancia owns. */
export function fsOf($: EngineInterface, state: string, press?: Press): Fs {
  // LC_ALL: what fails is said in English
  const run = async (argv: string[], fine?: RegExp) => {
    const r = await $.process.run(argv, { env: { LC_ALL: 'C' } })
    if (r.exitCode !== 0 && !fine?.test(r.stderr)) throw new Error(`${argv[0]} ${argv.at(-1)}: ${r.stderr.trim()}`)
    return r
  }
  const real = async (path: string) => {
    if ((await run(['readlink', '--', path], /^$/)).exitCode !== 0) return path
    return (await run(['realpath', '--', path])).stdout.replace(/\n$/, '')
  }
  /** What `read` gives, or null where there is no such `kind`. Other chats make and remove files meanwhile: what is there after a failure is read again. */
  const ifThere = async <T>(path: string, kind: 'file' | 'dir', read: () => Promise<T>): Promise<T | null> => {
    try {
      return await read()
    } catch {
      return (await $.fs.stat(path).catch(() => null))?.kind === kind ? read() : null
    }
  }
  return {
    async real(path) {
      const file = await real(path)
      if (path === press?.local) press.file = file
      return file
    },
    readText: (path) => ifThere(path, 'file', () => $.fs.read(path)),
    list: (dir) => ifThere(dir, 'dir', async () => (await $.fs.list(dir)).map((d) => d.name)),
    async writeText(path, data) {
      await $.fs.write(path, data).catch((err: Error) => {
        throw new Error(`cannot write ${path.replace(TMP_FILE, '')}: ${err.message}`)
      })
    },
    async rename(from, to) {
      // The local file keeps its permissions: a new file has Claude Code's own. Missing, there are none to keep.
      if (TMP_FILE.test(from) && !from.startsWith(`${state}/`)) await run(['chmod', '--reference', to, '--', from]).catch(() => undefined)
      if (press && to === press.file) press.before = merges
      // -T: a folder in the place of `to` is not where to put it: of a file an error, of a folder the one to replace, if empty
      await run(['mv', '-fT', '--', from, to])
    },
    async remove(path) {
      if (!path.startsWith(`${state}/`) && !LOCAL_FILE.test(path) && !TMP_FILE.test(path) && !CLAUDE_DIR.test(path)) throw new Error(`Plancia does not delete ${path}`)
      const file = LOCAL_FILE.test(path) ? await real(path) : path
      if (path === press?.local) press.before = merges
      await run(CLAUDE_DIR.test(path) ? ['rmdir', '--', path] : ['rm', '-df', '--', file])
    },
    sleep: (ms) => sleep($, ms, press),
  }
}

/** The lines a command that only looks prints, run in `cwd` (where /proc/self/cwd leads), else in /; [] when it cannot tell. */
async function lines($: EngineInterface, argv: string[], cwd: string): Promise<string[]> {
  const at = (dir: string) => $.process.run(argv, { cwd: dir }).then((r) => r.stdout.split('\n').filter(Boolean), () => [])
  const found = await at(cwd)
  return found.length ? found : at('/')
}

/**
 * Where the paths lead, links followed and missing parts kept. Absolute paths that lead elsewhere from another folder go
 * through a link to /proc/self/cwd, and the engine's own folder cannot be told: said to lead there, which the guard refuses.
 * shortcut: a link there with enough `..` after it leads to / from both folders, and is let through; upgrade when the engine tells its folder.
 */
export async function realPaths($: EngineInterface, paths: string[], cwd: string): Promise<string[]> {
  const [here, there] = await Promise.all([cwd, '/proc/self/task'].map((dir) => lines($, ['realpath', '-m', '--', ...paths], dir)))
  return here!.join('\n') === there!.join('\n') ? here! : [...here!, ...there!, '/proc/self/cwd']
}

/** Device and inode of each path that is there, links followed. */
export function fileIds($: EngineInterface, paths: string[], cwd: string): Promise<string[]> {
  return lines($, ['stat', '-Lc', '%d:%i', '--', ...paths], cwd)
}

/** The core's Ctx of this session. */
export async function sessionCtx($: EngineInterface): Promise<Ctx> {
  const dirs = await dirsFor($)
  const root = await $.session.root()
  return { ...dirs, root, fs: fsOf($, dirs.state) }
}

/**
 * Claude Code merges the settings again (and asks this chat's mod) only when a settings file changes: touch the
 * folder's local file, content unchanged. Missing: written as {} when `create` (an empty file is no JSON), else left.
 */
export async function touchLocal($: EngineInterface, fs: Fs, root: string, create: boolean, press?: Press): Promise<void> {
  if (press) press.before = merges
  const path = localSettingsPath(root)
  if ((await fs.readText(path)) === null) {
    if (!create) return
    const file = await fs.real(path)
    const tmp = tmpFor(file)
    await fs.writeText(tmp, EMPTY_LOCAL)
    // -n: a file made meanwhile stays, and its making is the change
    try {
      const r = await $.process.run(['mv', '-nT', '--', tmp, file], { env: { LC_ALL: 'C' } })
      if ((await fs.readText(path)) === null) throw new Error(`cannot write ${path}: ${r.stderr.trim()}`)
    } finally {
      await fs.remove(tmp)
    }
    return
  }
  const r = await $.process.run(['touch', '-c', '--', path])
  if (r.exitCode !== 0) throw new Error(`touch ${path}: ${r.stderr.trim()}`)
}

// Merges the settings.read hook has answered in this module: a write waits for the one it starts.
let merges = 0
export const mergeCount = () => merges
export const countMerge = () => {
  merges++
}
// Only the engine's own merge (a plugin's read, at any render, is no merge); never a read of one source.
export const mergeOfEngine = (e: { source?: string }, origin: Origin): boolean => !e.source && origin.plugin === 'engine'
/**
 * Whether a merge came since the press wrote, waited for as long as the press may still sleep. A .claude removed and made again during the session is watched no more
 * (seen live, 2.1.332), the user's own folder always: half-way its settings file is touched, content unchanged.
 */
export async function mergeAfter($: EngineInterface, press: Press, claude: string): Promise<boolean> {
  const came = async (until: number) => {
    while (press.slept < until && merges === press.before) await sleep($, 100, press)
    return merges !== press.before
  }
  if (await came((press.slept + PRESS_SLEEP_MS) / 2)) return true
  await $.process.run(['touch', '-c', '--', `${claude}/settings.json`]).catch(() => undefined)
  return came(PRESS_SLEEP_MS)
}
