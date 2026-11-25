// Test harness: a fake machine under the mod's $ (files, processes, session, ui), built on the core's fixture tree.
import { mock, test as kitTest, type TestBody, type TestOptions } from 'claude-code/testing'
import type { On } from 'claude-code'
import { ctx, hid, makeTree, DIRS, HOME, ROOT, LOCAL } from '../../spec/fixture.ts'
import { protectedPath, statePath, type MemFs } from '../../src/core/index.ts'

export { ctx, hid, DIRS, HOME, ROOT, LOCAL }
export const STATE = statePath(DIRS.state)
export const PROTECTED = protectedPath(DIRS.state)
export const PRESETS = `${DIRS.state}/presets.json`
export const PANEL = `${DIRS.state}/panel.json`

/** The kit's test, without its 5 s: on a busy machine a good test takes longer, so the limit is only for one that hangs. */
export const test = (name: string, ...rest: [TestBody] | [TestOptions, TestBody]) =>
  kitTest(name, { timeoutMs: 60_000, ...(rest.length === 2 ? rest[0] : {}) }, rest.at(-1) as TestBody)

/** Session id of the fake session until a /clear or /branch; then NEXT_SID. */
export const SID = 'aaaaaaaa-0000-4000-8000-000000000001'
export const NEXT_SID = 'cccccccc-0000-4000-8000-000000000003'

export type Machine = {
  files: Map<string, string>
  /** Current $.session.id(): /clear and /branch move it to NEXT_SID, /resume <id> to <id>. */
  sid: string
  /** Every command the mod ran. */
  runs: string[][]
  /** Files the mod touched (mtime only). */
  touched: string[]
  toasts: string[]
  opened: Array<Record<string, unknown>>
  /** Ids of the panes the mod closed. */
  closed: string[]
  commands: string[]
  toolCalls: string[]
  registeredTools: string[]
  registeredCommands: string[]
  /** Every path the mod read, in order. */
  reads: string[]
  json: (path: string) => any
  /** The same files as another window's core sees them, the lock included. */
  fs: MemFs
  /** Runs before each write of the mod, with its path. */
  beforeWrite: (path: string) => Promise<void>
  /** Runs at each sleep of the mod, with its length. */
  beforeSleep: (ms: number) => Promise<void>
}

export type Options = {
  files?: Record<string, string>
  root?: string
  surfaces?: Array<'terminal' | 'vscode' | 'desktop'>
  isPlaced?: boolean
  /** The chat of VS Code as seen live (2026-11-22): a closed pane stays in $.ui.panes(). */
  stalePanes?: boolean
  /** $.session.cwd() fails. */
  noCwd?: boolean
  /** $.env.get() fails. */
  noEnv?: boolean
  /** $.clock.sleep() fails. */
  noSleep?: boolean
  /** $.session.info().platform, 'linux' if left out; null: $.session.info() fails; 'broken': it answers nothing, and who reads it throws. */
  platform?: 'macos' | 'windows' | 'wsl' | 'linux' | 'unknown' | 'broken' | null
  /** Paths that are there but cannot be read: no permission (a file, a folder), a link that leads nowhere, a folder where a file belongs. */
  odd?: Record<string, 'denied' | 'denied-dir' | 'dangling' | 'dir'>
  /** Symbolic links: path → where it leads. */
  links?: Record<string, string>
  /** What `stat -c %d:%i` says: path → the folder it is, by any name. */
  ids?: Record<string, string>
}

/** The band above the prompt as Claude Code passes it to a ui.render hook. */
export const band = (surface: 'terminal' | 'vscode', hasSurvey = false) => ({
  plugin: 'plancia',
  component: 'AbovePrompt' as const,
  surface,
  props: { hasSurvey, isCollapsed: false, isWorking: false, maxRows: 12, bodyColumns: 100, scroll: { offset: 0, bodyRows: 12 }, view: {} },
})

/** The pane as Claude Code passes it to a ui.render hook. */
export const pane = (surface: 'terminal' | 'desktop' | 'vscode', bodyRows = 40) => ({
  plugin: 'plancia',
  component: 'Pane' as const,
  requestId: 'plancia',
  surface,
  viewport: { columns: 160, rows: 50 },
  props: {
    title: 'Plancia',
    isFocused: true,
    bodyColumns: 150,
    placement: 'inline' as const,
    scroll: { offset: 0, bodyRows },
    view: {},
  },
})

const dirOf = (files: Map<string, string>, dir: string) => {
  const prefix = dir.endsWith('/') ? dir : `${dir}/`
  const names = new Map<string, 'file' | 'dir'>()
  for (const p of files.keys()) {
    if (!p.startsWith(prefix)) continue
    const rest = p.slice(prefix.length)
    const name = rest.split('/')[0] ?? ''
    names.set(name, rest.includes('/') ? 'dir' : 'file')
  }
  return names
}

/** Registers every stub the mod needs; call before the test's first call on $. */
export function machine(on: On, o: Options & { env?: Record<string, string> } = {}): Machine {
  const tree = makeTree(o.files ?? {})
  const files = tree.files
  const m: Machine = {
    files, sid: SID, runs: [], touched: [], toasts: [], opened: [], closed: [], commands: [], toolCalls: [], registeredTools: [], registeredCommands: [], reads: [],
    json: (p) => JSON.parse(files.get(p) ?? 'null'), fs: tree, beforeWrite: async () => {}, beforeSleep: async () => {},
  }
  const root = o.root ?? ROOT
  if (o.noEnv) on('env.get', () => ({ deny: 'no env' }))
  else mock.env(on, { HOME, ...(o.env ?? {}) })
  // no real time: a sleep ends at once, after what the test does in it
  on('clock.sleep', async ($, e) => {
    await m.beforeSleep(e.ms)
    return o.noSleep ? { deny: 'no sleep' } : { value: undefined }
  })
  on('session.info', () => (o.platform === null ? { deny: 'no info' } : o.platform === 'broken' ? { value: null as any } : { value: { transcriptPath: '', platform: o.platform ?? 'linux' } }))
  on('session.root', () => ({ value: root }))
  on('session.cwd', () => (o.noCwd ? { deny: 'no cwd' } : { value: root }))
  // an empty sid stands for a Claude Code that gives no id
  on('session.id', () => (m.sid ? { value: m.sid } : { deny: 'no session id' }))
  on('session.surfaces', () => ({ value: o.surfaces ?? ['terminal'] }))
  on('session.start', () => ({ cwd: root }))
  on('command.register', ($, e) => {
    m.registeredCommands.push(e.name)
    return { value: { command: e.name } }
  })
  on('tool.register', ($, e) => {
    m.registeredTools.push(e.name)
    return { value: { tool: e.name } }
  })
  const panes = new Map<string, string>()
  on('ui.open', ($, e) => {
    m.opened.push(e as Record<string, unknown>)
    if (o.isPlaced !== false) panes.set(e.id, e.title ?? '')
    return { value: o.isPlaced === false ? { isPlaced: false, reason: 'narrow' } : { isPlaced: true } }
  })
  on('ui.close', ($, e) => {
    m.closed.push(e.id)
    if (!o.stalePanes) panes.delete(e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: [...panes].map(([id, title]) => ({ id, title, isShown: true, isFocused: false, isPlaced: true })) }))
  on('ui.toast', ($, e) => {
    m.toasts.push(String((e as { text?: string }).text))
    return { value: undefined }
  })
  on('command.run', ($, e) => {
    m.commands.push(e.command)
    if (e.command === 'clear' || e.command === 'branch') m.sid = NEXT_SID
    if (e.command === 'resume' && e.args) m.sid = e.args
    return {}
  })
  on('tool.call', ($, e) => {
    m.toolCalls.push(e.tool)
    return { result: 'ok' }
  })
  on('fs.read', ($, e) => {
    m.reads.push(e.path)
    const bad = o.odd?.[e.path]
    if (bad) return { deny: `${bad.startsWith('denied') ? 'EACCES' : bad === 'dir' ? 'EISDIR' : 'ENOENT'}: ${e.path}` }
    const v = files.get(e.path)
    return v === undefined ? { deny: `ENOENT: ${e.path}` } : { value: v }
  })
  on('fs.exists', ($, e) => ({ value: !!o.odd?.[e.path] || files.has(e.path) || tree.dirs.has(e.path) || dirOf(files, e.path).size > 0 }))
  on('fs.stat', ($, e) => {
    const bad = o.odd?.[e.path]
    if (bad) return { value: { kind: bad === 'denied' ? 'file' : bad === 'dangling' ? 'other' : 'dir', size: 0, mtimeMs: 0, isLink: bad === 'dangling' } }
    if (files.has(e.path)) return { value: { kind: 'file', size: files.get(e.path)!.length, mtimeMs: 0, isLink: false } }
    if (dirOf(files, e.path).size > 0) return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } }
    return { deny: `ENOENT: ${e.path}` }
  })
  on('fs.list', ($, e) => {
    if (o.odd?.[e.path]?.startsWith('denied')) return { deny: `EACCES: ${e.path}` }
    const names = dirOf(files, e.path)
    if (names.size === 0 && !tree.dirs.has(e.path)) return { deny: `ENOENT: ${e.path}` }
    return { value: [...names].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.write', async ($, e) => {
    await m.beforeWrite(e.path)
    files.set(e.path, String(e.text))
    return { value: undefined }
  })
  on('process.run', async ($, e) => {
    const argv = e.argv as string[]
    m.runs.push(argv)
    const answer = (exitCode: number, stdout = '', stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })
    const last = argv.at(-1)!
    if (argv[0] === 'readlink') return answer(o.links?.[last] ? 0 : 1)
    if (argv[0] === 'realpath') {
      const real = (p: string) => Object.entries(o.links ?? {}).reduce((q, [from, to]) => (q === from || q.startsWith(`${from}/`) ? to + q.slice(from.length) : q), p)
      return answer(0, argv.slice(argv.indexOf('--') + 1).map((p) => `${real(p)}\n`).join(''))
    }
    if (argv[0] === 'stat') return answer(0, argv.slice(argv.indexOf('--') + 1).flatMap((p) => (o.ids?.[p] ? [`${o.ids[p]}\n`] : [])).join(''))
    if (argv[0] === 'chmod') return answer(0)
    if (argv[0] === 'mv') {
      if (argv[1] === '-nT' && files.has(last)) return answer(1)
      return tree.rename(argv.at(-2)!, last).then(() => answer(0), (err) => answer(1, '', String(err)))
    }
    if (argv[0] === 'touch') {
      m.touched.push(last)
      return answer(0)
    }
    if (argv[0] === 'rm' || argv[0] === 'rmdir') {
      return tree.remove(last).then(() => answer(0), (err) => answer(1, '', String(err)))
    }
    return answer(127, '', `not stubbed: ${argv.join(' ')}`)
  })
  return m
}
