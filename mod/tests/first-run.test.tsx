// The first run on any machine: nothing written before a click, no configuration at all, broken files, a project without .claude,
// saved files of another version, writes that fail half-way, systems that are not supported.
import { describe, expect } from 'claude-code/testing'
import { hid, HOME, LOCAL, PANEL, PRESETS, PROTECTED, ROOT, SID, STATE, band, machine, pane, test, type Machine, type Options } from './harness.ts'
import { hookId, CATEGORIES, PANEL_ROWS, dirsOf, presetsPath, protectedPath, statePath } from '../../src/core/index.ts'
import { UNSUPPORTED } from '../adapter.ts'
import { TAB_LABEL } from '../pane.tsx'

const open = async ($: any, args = '') => $.command.run({ command: 'plancia', args })
const texts = async (ui: any, re: RegExp) => ui.find({ type: 'Text', text: re })
const reader = {
  name: 'reader',
  register(on: any) {
    on('command.run', { command: 'read-settings' }, async ($: any) => ({ text: JSON.stringify(await $.settings.read()) }))
  },
}
const write = async ($: any, path: string) => JSON.stringify(await $.tool.call({ tool: 'Write', file_path: path, content: 'x' } as any))
const start = ($: any) => $.session.start({ surface: 'terminal', isInteractive: true, cwd: ROOT } as any)

const ENVS: Record<string, string>[] = [{}, { CLAUDE_CONFIG_DIR: '/cfg' }, { XDG_CONFIG_HOME: '/xdg' }, { CLAUDE_CONFIG_DIR: '/cfg', XDG_CONFIG_HOME: '/xdg' }]
/** Every new user: which folders, and Claude Code's configuration missing or a bare settings.json. */
const USERS = ENVS.flatMap((env) => [null, '{}\n'].map((settings) => ({
  env, settings, dirs: dirsOf(HOME, env), title: `${Object.keys(env).join(' and ') || 'default folders'}, ${settings === null ? 'no configuration at all' : 'settings.json {}'}`,
})))
type User = (typeof USERS)[number]
/** That user's machine, where nothing of Plancia is, in a project with no .claude folder. */
const fresh = (on: any, u: Pick<User, 'env' | 'settings' | 'dirs'> = USERS[0]!, o: Options = {}): Machine => {
  const m = machine(on, { ...o, env: u.env })
  m.files.clear()
  if (u.settings !== null) m.files.set(`${u.dirs.claude}/settings.json`, u.settings)
  m.files.set(`${ROOT}/README.md`, '')
  for (const [p, text] of Object.entries(o.files ?? {})) m.files.set(p, text)
  return m
}
const snapshot = (m: Machine) => [[...m.files].sort(), [...m.fs.dirs], m.touched]
const notice = async (ui: any, re: RegExp) => (await texts(ui, re))?.props.color

describe('a first session with nothing pressed', () => {
  for (const u of USERS) {
    test(`writes nothing and runs no command: ${u.title}`, { plugins: [reader] }, async ($, on) => {
      const m = fresh(on, u, { files: { [LOCAL]: '{"foo":1}' } })
      on('settings.read', () => ({ value: { model: 'x' } }))
      const before = JSON.stringify(snapshot(m))
      await start($)
      const row = await $.ui.mount(band('terminal'))
      expect(await texts(row, /^Plancia · no preset$/)).toBeDefined()
      expect((await row.find({ key: 'band-open' }))?.props.label).toBe('Open')
      expect(String((await $.command.run({ command: 'read-settings', args: '' } as any)).text)).toBe('{"model":"x"}')
      for (const [command, args] of [['clear', ''], ['branch', ''], ['resume', 'dddddddd-0000-4000-8000-000000000004']])
        await $.command.run({ command, args } as any)
      await open($)
      const ui = await $.ui.mount(pane('terminal'))
      expect(await ui.find({ key: 'setup-confirm' })).toBeDefined()
      await $.command.run({ command: 'clear', args: '' } as any)
      expect(JSON.stringify(snapshot(m))).toBe(before)
      expect([m.runs, m.toasts]).toEqual([[], []])
    })
  }
})

describe('from the guide to reset --all', () => {
  for (const u of USERS) {
    test(`every step works, and the user's settings.json never changes: ${u.title}`, async ($, on) => {
      const m = fresh(on, u)
      const before = [...m.files].sort()
      const state = statePath(u.dirs.state)
      // the guard is there before the folder is
      expect(await write($, state)).toMatch(/Plancia: its state/)
      await open($)
      const ui = await $.ui.mount(pane('terminal'))
      expect(await texts(ui, /No PreToolUse hook and no rule file found/)).toBeDefined()
      await ui.press({ key: 'setup-skip' })
      expect([...m.files.keys()].filter((p) => !before.some(([b]) => b === p))).toEqual([protectedPath(u.dirs.state)])
      for (const c of CATEGORIES) {
        await ui.press({ key: `tab:${c}` })
        // the auto memory is there without any file
        expect((await ui.find({ key: `tab:${c}` }))?.props.label).toBe(`▸ ${TAB_LABEL[c]} ${c === 'rule' ? '1/1' : '0/0'}`)
        expect(!!(await texts(ui, /^No items in this category\.$/))).toBe(c !== 'rule')
      }
      await ui.press({ key: 'tab:rule' })
      await ui.press({ key: `toggle:rule:${u.dirs.claude}/projects/${ROOT.replaceAll('/', '-')}/memory/MEMORY.md` })
      await ui.press({ key: 'save-as' })
      await ui.input({ key: 'save-name', text: 'Lean' })
      await ui.press({ key: 'apply' })
      await ui.press({ key: 'confirm' })
      expect([m.files.get(LOCAL), m.json(state).sessions[SID].preset]).toEqual(['{}\n', 'Lean'])
      await ui.press({ key: 'make-default' })
      await ui.press({ key: 'confirm' })
      expect([m.json(LOCAL), m.json(state).projects[ROOT].preset]).toEqual([{ autoMemoryEnabled: false }, 'Lean'])
      await open($, 'reset')
      await ui.press({ key: 'reset-confirm' })
      expect(m.files.has(LOCAL)).toBe(false)
      await ui.press({ key: 'tab:rule' })
      await ui.press({ key: `toggle:rule:${u.dirs.claude}/projects/${ROOT.replaceAll('/', '-')}/memory/MEMORY.md` })
      await ui.press({ key: 'apply' })
      await ui.press({ key: 'confirm' })
      expect(m.files.get(LOCAL)).toBe('{}\n')
      await open($, 'reset --all')
      expect(await texts(ui, /backups stay in/)).toBeDefined()
      await ui.press({ key: 'reset-all-confirm' })
      // what is left: the files that were there, and Plancia's own folder
      expect([...m.files].filter(([p]) => !p.startsWith(`${u.dirs.state}/`)).sort()).toEqual(before)
      expect([...m.files.keys()].filter((p) => p.startsWith(`${u.dirs.state}/`) && !p.includes('/backups/')).sort())
        .toEqual([presetsPath(u.dirs.state), protectedPath(u.dirs.state), state].sort())
      expect(m.json(state)).toEqual({ version: 1, projects: {}, sessions: {}, created: {} })
    })
  }
})

describe('configuration that cannot be read', () => {
  const c = `${HOME}/.claude`
  const files = [`${c}/settings.json`, `${HOME}/.claude.json`, `${c}/.config.json`, `${c}/plugins/installed_plugins.json`, `${c}/CLAUDE.md`, `${ROOT}/.mcp.json`, `${ROOT}/.claude/settings.json`, `${ROOT}/CLAUDE.md`, LOCAL, PANEL]
  const folders = [`${c}/skills`, `${c}/commands`, `${c}/agents`, `${c}/rules`, `${ROOT}/.claude/skills`, `${ROOT}/.claude/rules`]
  const all = (kind: 'denied' | 'dangling' | 'dir') =>
    Object.fromEntries([...files.map((p) => [p, kind]), ...folders.map((p) => [p, kind === 'denied' ? 'denied-dir' : 'dangling'])])
  for (const kind of ['denied', 'dangling', 'dir'] as const) {
    test(`every file ${kind}: skipped, the pane works${kind === 'denied' ? ' and says so' : ''}`, async ($, on) => {
      const odd = all(kind)
      const m = fresh(on, USERS[0], { odd, files: { [PROTECTED]: JSON.stringify({ version: 1, protected: [] }) } })
      m.files.set('/h/.claude/skills/x/SKILL.md', '---\nname: x\n---\n')
      await open($)
      const ui = await $.ui.mount(pane('terminal'))
      expect(await ui.find({ key: 'apply' })).toBeDefined()
      const warned = String((await texts(ui, /^Warning: /))?.children ?? '')
      for (const p of files.slice(0, 8)) expect([p, warned.includes(`${p} cannot be read`)]).toEqual([p, kind === 'denied'])
    })
  }

  test('a protected list that cannot be read protects every hook and rule', async ($, on) => {
    machine(on, { odd: { [PROTECTED]: 'denied' } })
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    await ui.press({ key: 'tab:hook' })
    await ui.press({ key: `toggle:hook:${hid('sync-guard.sh', 'PostToolUse')}` })
    await ui.press({ key: 'make-default' })
    expect(await ui.find({ key: 'protected-ok' })).toBeDefined()
  })

  test('empty files and files with a byte order mark are no broken JSON', async ($, on) => {
    fresh(on, USERS[0], { files: {
      [PROTECTED]: JSON.stringify({ version: 1, protected: [] }), [`${c}/settings.json`]: '', [`${HOME}/.claude.json`]: ' \n',
      [`${ROOT}/.mcp.json`]: '﻿' + JSON.stringify({ mcpServers: { marked: { command: 'x' } } }),
    } })
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    expect(await texts(ui, /^Warning: /)).toBeUndefined()
    await ui.press({ key: 'tab:mcp' })
    expect(await ui.find({ key: 'name:mcp:marked' })).toBeDefined()
  })
})

describe('a project folder that cannot be written', () => {
  const refuse = (m: Machine, re: RegExp) => {
    m.beforeWrite = async (p) => { if (re.test(p)) throw new Error('EACCES: permission denied') }
  }
  const ready = async ($: any, m: Machine) => {
    m.files.set(PROTECTED, JSON.stringify({ version: 1, protected: [] }))
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    await ui.press({ key: 'tab:rule' })
    await ui.press({ key: 'toggle:rule:/h/.claude/projects/-h-p-proj/memory/MEMORY.md' })
    return ui
  }
  const REFUSED = `cannot write ${LOCAL}: `
  const said = async (ui: any, what: string) => String((await texts(ui, new RegExp(`^${what} failed: `)))?.children ?? '')

  test('Apply says so, and no choice of the chat is left behind', async ($, on) => {
    const m = fresh(on)
    const ui = await ready($, m)
    refuse(m, /\/\.claude\//)
    await ui.press({ key: 'apply' })
    await ui.press({ key: 'confirm' })
    expect(await said(ui, 'Apply')).toContain(REFUSED)
    expect(m.json(STATE)).toEqual({ version: 1, projects: {}, sessions: {}, created: {} })
    expect(m.files.has(LOCAL)).toBe(false)
  })

  test('Make default says so, and records nothing', async ($, on) => {
    const m = fresh(on)
    const ui = await ready($, m)
    refuse(m, /\/\.claude\//)
    await ui.press({ key: 'make-default' })
    await ui.press({ key: 'confirm' })
    expect(await said(ui, 'Make default')).toContain(REFUSED)
    expect([m.files.has(LOCAL), m.files.has(STATE)]).toEqual([false, false])
  })

  for (const own of [null, '{"foo":1}']) {
    test(`the state cannot be saved: Make default leaves the project as it was (${own ?? 'no local file'}), and works once it can`, async ($, on) => {
      const m = fresh(on, USERS[0], own ? { files: { [LOCAL]: own } } : {})
      const ui = await ready($, m)
      refuse(m, /\/state\.json/)
      await ui.press({ key: 'make-default' })
      await ui.press({ key: 'confirm' })
      expect(await said(ui, 'Make default')).toContain(`cannot write ${STATE}: `)
      expect([m.files.get(LOCAL) ?? null, m.files.has(STATE)]).toEqual([own, false])
      refuse(m, /^never$/)
      await ui.press({ key: 'make-default' })
      await ui.press({ key: 'confirm' })
      expect([m.json(LOCAL).autoMemoryEnabled, m.json(STATE).projects[ROOT].entries.length]).toEqual([false, 1])
      const made = m.files.get(LOCAL)
      // a reset that cannot be recorded is not done either
      refuse(m, /\/state\.json/)
      await open($, 'reset')
      await ui.press({ key: 'reset-confirm' })
      expect(await said(ui, 'Reset')).toContain(`cannot write ${STATE}: `)
      expect(m.files.get(LOCAL)).toBe(made)
      refuse(m, /^never$/)
      await open($, 'reset')
      await ui.press({ key: 'reset-confirm' })
      // a warning only for the merge, which the bench never raises: no conflict
      expect(await notice(ui, /^Everything Plancia wrote for .* is undone\.$/)).toBe('warning')
      expect(own ? m.json(LOCAL) : m.files.has(LOCAL)).toEqual(own ? JSON.parse(own) : false)
    })
  }

  test('the state cannot be saved: Apply touches nothing', async ($, on) => {
    const m = fresh(on)
    const ui = await ready($, m)
    refuse(m, /\/state\.json/)
    await ui.press({ key: 'apply' })
    await ui.press({ key: 'confirm' })
    expect(await said(ui, 'Apply')).toContain(`cannot write ${STATE}: `)
    expect([m.files.has(LOCAL), m.files.has(STATE), m.touched]).toEqual([false, false, []])
  })
})

describe('saved files of another version, broken or empty', () => {
  const project = { preset: 'X', appliedAt: 'x', entries: [], hooksOff: [], createdPaths: [] }
  const v1 = (over: Record<string, unknown>) => JSON.stringify({ version: 1, projects: {}, sessions: {}, ...over })
  const STATES: Record<string, string> = {
    empty: '', broken: '{ nope', 'a list': '[]', 'a later version': v1({ version: 2 }), 'no version': JSON.stringify({ projects: {} }),
    'projects of another form': v1({ projects: { [ROOT]: { off: ['skill:a'] } } }), 'entries of another form': v1({ projects: { [ROOT]: { ...project, entries: ['skill:a'] } } }),
    'chats of another form': v1({ sessions: { [SID]: { root: ROOT, choice: 1 } } }), 'created of another form': v1({ created: [] }),
  }
  const PRESETS_BAD: Record<string, string> = {
    empty: '', broken: '{ nope', 'a later version': JSON.stringify({ version: 2, presets: [] }), 'presets of another form': JSON.stringify({ version: 1, presets: ['Lean'] }),
    'a base that is gone': JSON.stringify({ version: 1, presets: [{ name: 'Lean', parent: 'System', enable: [], disable: [] }] }),
    'a loop': JSON.stringify({ version: 1, presets: [{ name: 'A', parent: 'B', enable: [], disable: [] }, { name: 'B', parent: 'A', enable: [], disable: [] }] }),
  }
  for (const [what, text] of Object.entries(STATES)) {
    test(`state.json: ${what}: ignored, the row says so, one click starts over and keeps the file`, { plugins: [reader] }, async ($, on) => {
      const m = machine(on, { files: { [STATE]: text } })
      on('settings.read', () => ({ value: { model: 'x' } }))
      await start($)
      expect(m.toasts.join()).toContain(`${STATE} is not valid`)
      const row = await $.ui.mount(band('terminal'))
      expect(await texts(row, /^Plancia · saved choices ignored, state\.json cannot be used$/)).toBeDefined()
      expect(String((await $.command.run({ command: 'read-settings', args: '' } as any)).text)).toBe('{"model":"x"}')
      await row.press({ key: 'band-open' })
      const ui = await $.ui.mount(pane('terminal'))
      expect((await texts(ui, /state\.json is not valid/))?.props.color).toBe('warning')
      expect(m.files.get(STATE)).toBe(text)
      const names = new Set(m.files.keys())
      await ui.press({ key: 'start-over' })
      const kept = [...m.files.keys()].filter((p) => !names.has(p))
      expect(kept).toHaveLength(1)
      expect(kept[0]).toMatch(/\/\.config\/plancia\/state\.json\.[\w-]+\.old$/)
      expect([m.files.get(kept[0]!), m.files.has(STATE)]).toEqual([text, false])
      expect(await texts(ui, /kept as .*state\.json\.[\w-]+\.old/)).toBeDefined()
      await ui.press({ key: 'toggle:skill:alpha' })
      await ui.press({ key: 'apply' })
      await ui.press({ key: 'confirm' })
      expect(m.json(STATE).sessions[SID].desired).toEqual({ 'skill:alpha': false })
      expect(m.files.get(kept[0]!)).toBe(text)
    })
  }
  for (const [what, text] of Object.entries(PRESETS_BAD)) {
    test(`presets.json: ${what}: said at start, one click starts over and keeps the file`, async ($, on) => {
      const m = machine(on, { files: { [PRESETS]: text } })
      await start($)
      expect(m.toasts.join()).toContain(`${PRESETS} is not valid`)
      await open($)
      const ui = await $.ui.mount(pane('terminal'))
      expect((await texts(ui, /presets\.json is not valid/))?.props.color).toBe('warning')
      await ui.press({ key: 'start-over' })
      expect([...m.files].filter(([p]) => p.startsWith(`${PRESETS}.`)).map(([, t]) => t)).toEqual([text])
      expect(m.files.has(PRESETS)).toBe(false)
      expect(await ui.find({ key: 'apply' })).toBeDefined()
    })
  }

  test('both at once: one click', async ($, on) => {
    const m = machine(on, { files: { [STATE]: '', [PRESETS]: '' } })
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    await ui.press({ key: 'start-over' })
    expect([m.files.has(STATE), m.files.has(PRESETS), !!(await ui.find({ key: 'apply' }))]).toEqual([false, false, true])
  })

  test('mended by another window meanwhile: nothing is set aside', async ($, on) => {
    const m = machine(on, { files: { [STATE]: '' } })
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    m.files.set(STATE, v1({ projects: { [ROOT]: project } }))
    const names = [...m.files.keys()]
    await ui.press({ key: 'start-over' })
    expect([...m.files.keys()]).toEqual(names)
    expect(await texts(ui, /^Project default: "X"/)).toBeDefined()
  })

  test('a file that only cannot be read now: ignored too, never set aside by itself', async ($, on) => {
    const m = machine(on, { odd: { [STATE]: 'denied' } })
    const row = await $.ui.mount(band('terminal'))
    expect(await texts(row, /^Plancia · saved choices ignored/)).toBeDefined()
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    expect((await texts(ui, /state\.json is not valid|EACCES/))?.props.color).toBe('warning')
    expect([m.runs, m.touched]).toEqual([[], []])
  })

  for (const text of ['', '{ nope', '[]', '{"version":9}', '{"version":1,"rows":"many"}']) {
    test(`panel.json ${text || 'empty'}: the usual height`, async ($, on) => {
      machine(on, { files: { [PANEL]: text } })
      await open($)
      const ui = await $.ui.mount(pane('terminal'))
      expect(await texts(ui, new RegExp(`^List: ${PANEL_ROWS.default} rows$`))).toBeDefined()
    })
  }

  test('a valid state from before the list of what Plancia created: kept', async ($, on) => {
    machine(on, { files: { [STATE]: JSON.stringify({ version: 1, projects: { [ROOT]: { ...project, createdFile: true } } }) } })
    const row = await $.ui.mount(band('terminal'))
    expect(await texts(row, /^Plancia · X · 0 off$/)).toBeDefined()
  })
})

describe('systems', () => {
  const state = JSON.stringify({ version: 1, projects: { [ROOT]: { preset: 'X', appliedAt: 'x', entries: [], hooksOff: [hookId('Stop', { type: 'command', command: 'bash /h/stop.sh' })], createdPaths: [] } }, sessions: {} })
  const hooks = { Stop: [{ hooks: [{ type: 'command', command: 'bash /h/stop.sh' }] }] }
  for (const platform of ['macos', 'windows'] as const) {
    test(`${platform}: one row says it, no pane, no error, nothing read, written or run`, { plugins: [reader] }, async ($, on) => {
      const m = machine(on, { platform, files: { [STATE]: state } })
      on('settings.read', () => ({ value: { hooks } }))
      const before = JSON.stringify(snapshot(m))
      await start($)
      for (const surface of ['terminal', 'vscode'] as const) {
        const row = await $.ui.mount(band(surface))
        expect(await texts(row, new RegExp(`^${UNSUPPORTED}$`))).toBeDefined()
        expect(await row.find({ key: 'band-open' })).toBeUndefined()
        await row.unmount()
      }
      expect((await open($)).text).toBe(UNSUPPORTED)
      expect(JSON.parse(String((await $.command.run({ command: 'read-settings', args: '' } as any)).text))).toEqual({ hooks })
      for (const [command, args] of [['clear', ''], ['branch', ''], ['resume', SID]]) await $.command.run({ command, args } as any)
      expect(await write($, `${HOME}/notes.md`)).toBe(JSON.stringify({ result: 'ok' }))
      expect(JSON.stringify(snapshot(m))).toBe(before)
      expect([m.opened, m.toasts, m.reads, m.runs]).toEqual([[], [], [], []])
    })
  }
  for (const platform of ['linux', 'wsl', 'unknown', null] as const) {
    test(`${platform ?? 'a Claude Code that does not say'}: Plancia works`, async ($, on) => {
      const m = machine(on, { platform, files: { [STATE]: state } })
      const row = await $.ui.mount(band('terminal'))
      expect(await texts(row, /^Plancia · X · 1 off$/)).toBeDefined()
      await row.press({ key: 'band-open' })
      expect(m.opened).toHaveLength(1)
    })
  }
})
