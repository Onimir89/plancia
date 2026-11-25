// What ties Plancia to no one machine: the folders from the environment, protected.json, the lock of SessionStart, /plancia reset --all.
import { describe, expect } from 'claude-code/testing'
import { hid, DIRS, HOME, LOCAL, PROTECTED, ROOT, SID, STATE, band, ctx, machine, pane, test } from './harness.ts'
import { TAB_LABEL } from '../pane.tsx'
import { hookId, MemFs, EMPTY_LOCAL, applyPatch, compile, readInventory, resolvePreset, MINIMAL } from '../../src/core/index.ts'

const open = async ($: any, args = '') => {
  await $.command.run({ command: 'plancia', args })
}
const texts = async (ui: any, re: RegExp) => ui.find({ type: 'Text', text: re })
const reader = {
  name: 'reader',
  register(on: any) {
    on('command.run', { command: 'read-settings' }, async ($: any) => ({ text: JSON.stringify(await $.settings.read()) }))
  },
}

describe('CLAUDE_CONFIG_DIR and XDG_CONFIG_HOME', () => {
  const env = { CLAUDE_CONFIG_DIR: '/cfg', XDG_CONFIG_HOME: '/xdg' }
  const files = { '/cfg/settings.json': '{}', '/cfg/skills/moved/SKILL.md': '---\nname: moved\ndescription: Moved\n---\n' }
  const XSTATE = '/xdg/plancia/state.json'
  const state = { version: 1, sessions: {}, projects: { [ROOT]: { preset: 'Xdg', appliedAt: 'x', entries: [], hooksOff: [hookId('Stop', { type: 'command', command: 'bash /h/stop.sh' })], createdPaths: [] } } }

  test('the pane lists that folder and writes the state there, never touching ~/.claude or ~/.config', async ($, on) => {
    const m = machine(on, { env, files })
    const before = new Set(m.files.keys())
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    await ui.press({ key: 'setup-skip' })
    expect(await ui.find({ key: 'name:skill:moved' })).toBeDefined()
    expect(await ui.find({ key: 'name:skill:alpha' })).toBeUndefined()
    await ui.press({ key: 'toggle:skill:moved' })
    await ui.press({ key: 'save-as' })
    await ui.input({ key: 'save-name', text: 'Lean' })
    await ui.press({ key: 'rows-up' })
    await ui.press({ key: 'apply' })
    expect(await texts(ui, /\/xdg\/plancia\/state\.json/)).toBeDefined()
    await ui.press({ key: 'confirm' })
    await ui.press({ key: 'make-default' })
    expect(await texts(ui, /\/xdg\/plancia\/backups\//)).toBeDefined()
    await ui.press({ key: 'cancel' })
    expect([...m.files.keys()].filter((p) => !before.has(p)).sort()).toEqual([LOCAL, '/xdg/plancia/panel.json', '/xdg/plancia/presets.json', '/xdg/plancia/protected.json', XSTATE].sort())
    expect(m.reads.filter((p) => p.startsWith(`${HOME}/.claude`) || p.startsWith(`${HOME}/.config/`))).toEqual([])
  })

  test('the band and the settings.read hook read the state there', { plugins: [reader] }, async ($, on) => {
    const m = machine(on, { env, files: { ...files, [XSTATE]: JSON.stringify(state) } })
    on('settings.read', () => ({ value: { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'bash /h/stop.sh' }] }] } } }))
    const ui = await $.ui.mount(band('terminal'))
    expect(await texts(ui, /^Plancia · Xdg · 1 off$/)).toBeDefined()
    expect(m.reads).toEqual([XSTATE])
    const r = await $.command.run({ command: 'read-settings', args: '' } as any)
    expect(JSON.parse(String(r.text))).toEqual({ hooks: {} })
  })

  test('/clear carries the choice in that state', async ($, on) => {
    const sessions = { [SID]: { root: ROOT, preset: 'X', desired: {}, hooksOff: [], updatedAt: new Date().toISOString() } }
    const m = machine(on, { env, files: { ...files, [XSTATE]: JSON.stringify({ version: 1, projects: {}, sessions }) } })
    await $.command.run({ command: 'clear', args: '' } as any)
    expect(Object.keys(m.json(XSTATE).sessions).sort()).toEqual([SID, m.sid].sort())
    expect(m.files.has(STATE)).toBe(false)
  })
})

describe('protected items', () => {
  test('with an empty list nothing is marked and nothing asks the extra confirmation', async ($, on) => {
    machine(on, { files: { [PROTECTED]: JSON.stringify({ version: 1, protected: [] }) } })
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    await ui.press({ key: 'tab:hook' })
    expect(await texts(ui, /^protected$/)).toBeUndefined()
    await ui.press({ key: 'all-off' })
    await ui.press({ key: 'make-default' })
    expect(await ui.find({ key: 'protected-ok' })).toBeUndefined()
    expect(await ui.find({ key: 'confirm' })).toBeDefined()
  })

  test('a broken protected.json warns in the pane, and any hook asks the extra confirmation', async ($, on) => {
    machine(on, { files: { [PROTECTED]: '{ nope' } })
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    expect((await texts(ui, /protected\.json/))?.props.color).toBe('warning')
    await ui.press({ key: 'tab:hook' })
    await ui.press({ key: `toggle:hook:${hid('sync-guard.sh', 'PostToolUse')}` })
    await ui.press({ key: 'make-default' })
    expect(await ui.find({ key: 'confirm' })).toBeUndefined()
    await ui.press({ key: 'protected-ok' })
    expect(await ui.find({ key: 'confirm' })).toBeDefined()
  })

  test('protected.json changed while the summary is open: reloads, writes nothing', async ($, on) => {
    const m = machine(on, { files: { [PROTECTED]: JSON.stringify({ version: 1, protected: [] }) } })
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    await ui.press({ key: 'toggle:skill:alpha' })
    await ui.press({ key: 'make-default' })
    m.files.set(PROTECTED, JSON.stringify({ version: 1, protected: ['skill:alpha'] }))
    const written = new Map(m.files)
    await ui.press({ key: 'confirm' })
    expect([...m.files]).toEqual([...written])
  })

  test('no argument of /plancia writes anything: only clicks in the pane do', async ($, on) => {
    const m = machine(on, { files: { [STATE]: JSON.stringify({ version: 1, projects: { [ROOT]: { preset: 'X', appliedAt: 'x', entries: [], hooksOff: ['a.sh:Stop'], createdPaths: [] } }, sessions: {} }) } })
    const before = [...m.files]
    for (const args of ['', 'Minimal', 'apply Minimal', 'reset', 'reset --all', 'reset --all --yes', 'confirm']) await open($, args)
    expect([...m.files]).toEqual(before)
    expect(m.touched).toEqual([])
    expect(m.registeredTools).toEqual([])
  })
})

describe('SessionStart hooks', () => {
  test('listed with a lock and the reason, no switch; the detail says it too', async ($, on) => {
    machine(on)
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    await ui.press({ key: 'tab:hook' })
    const k = `hook:${hid('compressor-gate.cjs', 'SessionStart')}`
    expect(await ui.find({ key: `name:${k}` })).toBeDefined()
    expect(await ui.find({ key: `toggle:${k}` })).toBeUndefined()
    expect(await texts(ui, /SessionStart hooks run before Plancia can act/)).toBeDefined()
    await ui.press({ key: `name:${k}` })
    expect(await texts(ui, /SessionStart hooks run before Plancia can act/)).toBeDefined()
    // an ordinary hook's detail does not
    await ui.press({ key: 'detail-close' })
    await ui.press({ key: `name:hook:${hid('compressor-gate.cjs', 'PostToolUse')}` })
    expect(await texts(ui, /SessionStart hooks run/)).toBeUndefined()
  })

  test('everything off counts the locked hook as on', async ($, on) => {
    machine(on)
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    await ui.press({ key: 'preset:Minimal' })
    expect((await ui.find({ key: 'tab:hook' }))?.props.label).toContain(`${TAB_LABEL.hook} 1/5`)
  })
})

describe('/plancia reset --all', () => {
  const applied = async (files: Map<string, string>, root: string) => {
    const fs = new MemFs()
    fs.files = files
    const c = ctx(fs, root)
    const { items } = await readInventory(c)
    await applyPatch(c, compile(items, resolvePreset(MINIMAL, [], items)), { preset: MINIMAL, now: new Date() })
  }

  test('lists the projects, asks, then resets each one and says what it did', async ($, on) => {
    const m = machine(on, { files: { '/h/two/README.md': '', '/h/chat/README.md': '', '/h/gone/README.md': '' } })
    const clean = new Map(m.files)
    for (const root of [ROOT, '/h/two', '/h/gone']) await applied(m.files, root)
    const st = m.json(STATE)
    const sessions = { other: { root: '/h/chat', preset: 'X', desired: {}, hooksOff: [], updatedAt: new Date().toISOString() } }
    m.files.set(STATE, JSON.stringify({ ...st, sessions, created: { ...st.created, '/h/chat': 'dir' } }))
    m.files.set('/h/chat/.claude/settings.local.json', EMPTY_LOCAL)
    for (const p of [...m.files.keys(), ...clean.keys()]) if (p.startsWith('/h/gone/')) { m.files.delete(p); clean.delete(p) }
    await open($, 'reset --all')
    const ui = await $.ui.mount(pane('terminal'))
    expect(await texts(ui, /\/h\/chat.*\/h\/gone.*\/h\/p\/proj.*\/h\/two/)).toBeDefined()
    expect(await ui.find({ key: 'reset-confirm' })).toBeUndefined()
    const asked = new Map(m.files)
    await ui.press({ key: 'reset-cancel' })
    expect([...m.files]).toEqual([...asked])
    await open($, ' reset   --all ')
    await ui.press({ key: 'reset-all-confirm' })
    const outside = (files: Map<string, string>) => [...files].filter(([p]) => !p.startsWith(`${DIRS.state}/`)).sort()
    expect(outside(m.files)).toEqual(outside(clean))
    expect(Object.keys(m.json(STATE).projects)).toEqual(['/h/gone'])
    expect(m.json(STATE).sessions).toEqual({})
    // a count for those that went well, whole lines for the others
    expect(await texts(ui, new RegExp(`^Plancia: 3 of 4 projects reset\\. Backups: ${DIRS.state}/backups$`))).toBeDefined()
    expect(await texts(ui, /: restored /)).toBeUndefined()
    expect(await texts(ui, /^\/h\/gone: not reset, /)).toBeDefined()
    expect(m.commands).toEqual(['reload-plugins'])
  })

  test('nothing to reset: says so, without a confirm button', async ($, on) => {
    machine(on)
    await open($, 'reset --all')
    const ui = await $.ui.mount(pane('terminal'))
    expect(await texts(ui, /^Plancia has written to no project\.$/)).toBeDefined()
    expect(await ui.find({ key: 'reset-all-confirm' })).toBeUndefined()
  })

  test('/plancia reset resets this project only', async ($, on) => {
    const m = machine(on, { files: { '/h/two/README.md': '' } })
    for (const root of [ROOT, '/h/two']) await applied(m.files, root)
    await open($, 'reset')
    const ui = await $.ui.mount(pane('terminal'))
    await ui.press({ key: 'reset-confirm' })
    expect(Object.keys(m.json(STATE).projects)).toEqual(['/h/two'])
  })
})
