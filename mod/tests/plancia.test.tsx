// Flows of the Plancia pane and its guards, on the fake machine of harness.ts (fixture tree of the core tests).
import { describe, expect } from 'claude-code/testing'
import { hid, DIRS, HOME, LOCAL, PANEL, PRESETS, ROOT, SID, STATE, band, ctx, machine, pane, test, type Machine } from './harness.ts'
import { fsOf } from '../adapter.ts'
import { CHANGED, MODIFIED, TAB_LABEL } from '../pane.tsx'
import { register } from '../register.tsx'
import { hookId, MemFs, applyPatch, compile, deletePreset, itemKey, localStamp, readInventory, savePreset, type StateMap } from '../../src/core/index.ts'

const open = async ($: any, args = '') => {
  await $.command.run({ command: 'plancia', args })
}
const texts = async (ui: any, re: RegExp) => ui.find({ type: 'Text', text: re })

describe('pane', () => {
  test('/plancia opens the pane with presets, tabs with counters and the skill list', async ($, on) => {
    const m = machine(on)
    await open($)
    expect(m.opened.map((o) => o.id)).toEqual(['plancia'])
    const ui = await $.ui.mount(pane('terminal'))
    expect(await ui.find({ key: 'preset:Minimal' })).toBeDefined()
    expect(await ui.find({ key: 'preset:Default' })).toBeDefined()
    // 7 skills in the fixture, 5 on today (userskill-off and anthropic-skills:docx are off)
    expect((await ui.find({ key: 'tab:skill' }))?.props.label).toContain(`${TAB_LABEL.skill} 5/7`)
    expect((await ui.find({ key: 'tab:hook' }))?.props.label).toMatch(new RegExp(`${TAB_LABEL.hook} \\d+/\\d+`))
    expect(await ui.find({ key: 'name:skill:alpha' })).toBeDefined()
    expect(await texts(ui, /Alpha skill/)).toBeDefined()
    expect(await texts(ui, /No unsaved changes/)).toBeDefined()
    expect(await texts(ui, new RegExp(ROOT))).toBeDefined()
  })

  test('the plugin-qualified name is not an alias: it goes past Plancia', async ($, on) => {
    const m = machine(on)
    await ($ as any).command.run({ command: 'plancia:plancia', args: '' })
    expect(m.opened).toEqual([])
    expect(m.commands).toEqual(['plancia:plancia'])
  })

  test('the header shows when the preset was applied, in local time', async ($, on) => {
    const at = '2026-11-19T08:38:25.392Z'
    const state = { version: 1, projects: { [ROOT]: { preset: 'Default', appliedAt: at, entries: [], hooksOff: [], createdPaths: [] } } }
    machine(on, { files: { [STATE]: JSON.stringify(state) } })
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    expect(await texts(ui, new RegExp(`^Project default: "Default", applied ${localStamp(at)}$`))).toBeDefined()
  })

  test('switching tab shows that category', async ($, on) => {
    machine(on)
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    expect(await ui.find({ key: `name:hook:${hid('resource-guard.cjs', 'PreToolUse')}` })).toBeUndefined()
    await ui.press({ key: 'tab:hook' })
    expect(await ui.find({ key: `name:hook:${hid('resource-guard.cjs', 'PreToolUse')}` })).toBeDefined()
    expect(await ui.find({ key: 'name:skill:alpha' })).toBeUndefined()
    // protected items carry the error color, ordinary ones do not
    expect((await texts(ui, /^protected$/))?.props.color).toBe('error')
  })

  test('search filters the tab, and an empty result says so', async ($, on) => {
    machine(on)
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    await ui.input({ key: 'search:skill', text: 'alp', kind: 'change' })
    expect(await ui.find({ key: 'name:skill:alpha' })).toBeDefined()
    expect(await ui.find({ key: 'name:skill:cmd1' })).toBeUndefined()
    await ui.input({ key: 'search:skill', text: 'zzz-nothing' })
    expect(await texts(ui, /No item matches "zzz-nothing"/)).toBeDefined()
    // the query is per tab
    await ui.press({ key: 'tab:agent' })
    expect(await ui.find({ key: 'name:agent:executor' })).toBeDefined()
  })

  test('a toggle marks the item ◆, counts one unsaved change, and ↺ undoes it', async ($, on) => {
    machine(on)
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    expect((await ui.find({ key: 'toggle:skill:alpha' }))?.props.label).toBe('on')
    await ui.press({ key: 'toggle:skill:alpha' })
    expect((await ui.find({ key: 'toggle:skill:alpha' }))?.props.label).toBe('off')
    expect(await texts(ui, /^1 unsaved change$/)).toBeDefined()
    expect(await texts(ui, /◆/)).toBeDefined()
    await ui.press({ key: 'undo' })
    expect((await ui.find({ key: 'toggle:skill:alpha' }))?.props.label).toBe('on')
    expect(await texts(ui, /No unsaved changes/)).toBeDefined()
  })

  test('items blocked at user level have no switch', async ($, on) => {
    machine(on)
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    await ui.press({ key: 'tab:agent' })
    expect(await ui.find({ key: 'name:agent:blocked-agent' })).toBeDefined()
    expect(await ui.find({ key: 'toggle:agent:blocked-agent' })).toBeUndefined()
    expect(await texts(ui, /switched off in your settings/)).toBeDefined()
  })

  test('off the terminal the name is an underlined link, not a button, and opens the detail', async ($, on) => {
    machine(on)
    await open($)
    const ui = await $.ui.mount(pane('vscode'))
    const name = await ui.find({ key: 'name:skill:alpha' })
    expect(name?.type).toBe('Markdown')
    expect(name?.props.text).toBe('[alpha](https://plancia/Alpha%20skill)')
    await ui.press({ key: 'name:skill:alpha', link: { href: 'https://plancia/Alpha skill' } })
    expect(await texts(ui, /Source: user/)).toBeDefined()
  })

  test('VS Code: switch, name and description stay on one line (the webview wraps a row by default, seen live)', async ($, on) => {
    machine(on)
    await open($)
    const ui = await $.ui.mount(pane('vscode'))
    expect((await ui.find({ key: 'row:skill:alpha' }))?.props.flexWrap).toBe('nowrap')
    // the Markdown is width:100% in the webview: its own Box keeps it to the name
    expect((await ui.find({ key: 'namebox:skill:alpha' }))?.props.flexShrink).toBe(0)
  })

  test('VS Code: the tooltip of the name (the webview shows the href) reads the whole description', async ($, on) => {
    const desc = `Use *this* skill_for (testing) [x] — naïve or not, 100% ~ok! ${'word '.repeat(400)}end`
    machine(on, { files: { '/h/.claude/skills/zeta/SKILL.md': `---\nname: zeta\ndescription: ${desc}\n---\n` } })
    await open($)
    const ui = await $.ui.mount(pane('vscode', 40))
    const text = String((await ui.find({ key: 'name:skill:zeta' }))?.props.text ?? '')
    const href = text.match(/^\[zeta\]\((.*)\)$/)?.[1] ?? ''
    expect(href.length).toBeLessThanOrEqual(2048)
    expect(/[\s*_~()[\]<>]/.test(href)).toBe(false)
    expect(decodeURI(href).startsWith('https://plancia/Use *this* skill_for (testing) [x] — naïve or not, 100% ~ok! word')).toBe(true)
    expect(decodeURI(href).endsWith('…')).toBe(true)
  })

  test('the name opens the detail with source and path', async ($, on) => {
    machine(on)
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    await ui.press({ key: 'name:skill:alpha' })
    expect(await texts(ui, /\/h\/\.claude\/skills\/alpha\/SKILL\.md/)).toBeDefined()
    expect(await texts(ui, /Source: user/)).toBeDefined()
    await ui.press({ key: 'detail-close' })
    expect(await texts(ui, /Source:/)).toBeUndefined()
  })

  test('over 5 presets the row becomes a Select', async ($, on) => {
    const presets = ['A', 'B', 'C', 'D'].map((name) => ({ name, parent: 'Minimal', enable: [], disable: [] }))
    machine(on, { files: { [PRESETS]: JSON.stringify({ version: 1, presets }) } })
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    expect(await ui.find({ key: 'preset:Minimal' })).toBeUndefined()
    expect(await ui.find({ key: 'preset-select' })).toBeDefined()
    await ui.select({ key: 'preset-select', value: 'B' })
    // B = Minimal: every skill off
    expect((await ui.find({ key: 'tab:skill' }))?.props.label).toContain(`${TAB_LABEL.skill} 0/7`)
  })

  test('VS Code: descriptions are Text beside the name link, not inside it', async ($, on) => {
    machine(on)
    await open($)
    const ui = await $.ui.mount(pane('vscode', 12))
    const name = await ui.find({ key: 'name:skill:alpha' })
    expect(name?.props.text).toMatch(/^\[alpha\]/)
    expect(await texts(ui, /Alpha skill/)).toBeDefined()
    expect(await ui.find({ key: 'apply' })).toBeDefined()
  })

  test('VS Code: the list shows the rows the user chose, whatever bodyRows says (the pane grows there, seen live: 2 per page)', async ($, on) => {
    machine(on)
    await open($)
    const ui = await $.ui.mount(pane('vscode', 12))
    // 7 skills, 10 rows chosen: all in view, one page
    // the pane's order: user skills, then the project's, then the plugins'
    const all = ['alpha', 'userskill-off', 'cmd1', 'anthropic-skills:docx', 'projskill', 'pa:s1', 'pa:c1']
    const missing = []
    for (const k of all) if (!(await ui.find({ key: `name:skill:${k}` }))) missing.push(k)
    expect(missing).toEqual([])
    expect(await ui.find({ key: 'page-next' })).toBeUndefined()
    // Shorter: 5 rows, so 5 skills and a second page
    await ui.press({ key: 'rows-down' })
    const seen = []
    for (const k of all) if (await ui.find({ key: `name:skill:${k}` })) seen.push(k)
    expect([seen, !!(await ui.find({ key: 'page-next' }))]).toEqual([all.slice(0, 5), true])
  })

  test('an unreadable state file shows the error state, with retry', async ($, on) => {
    const m = machine(on, { files: { [STATE]: '{broken' } })
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    expect((await texts(ui, /state\.json is not valid/))?.props.color).toBe('warning')
    expect(await ui.find({ key: 'apply' })).toBeUndefined()
    m.files.set(STATE, JSON.stringify({ version: 1, projects: {} }))
    await ui.press({ key: 'retry' })
    expect(await ui.find({ key: 'apply' })).toBeDefined()
  })
})

describe('presets', () => {
  test('Save as… stores parent + differences, Save updates it', async ($, on) => {
    const m = machine(on)
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    await ui.press({ key: 'toggle:skill:alpha' })
    await ui.press({ key: 'save-as' })
    await ui.input({ key: 'save-name', text: 'Lean' })
    expect(m.json(PRESETS).presets).toEqual([{ name: 'Lean', parent: 'Default', enable: [], disable: ['skill:alpha'] }])
    expect(await ui.find({ key: 'preset:Lean' })).toBeDefined()
    expect(await texts(ui, /No unsaved changes/)).toBeDefined()
    await ui.press({ key: 'toggle:skill:cmd1' })
    await ui.press({ key: 'save' })
    expect(m.json(PRESETS).presets).toEqual([{ name: 'Lean', parent: 'Default', enable: [], disable: ['skill:alpha', 'skill:cmd1'] }])
  })

  test('Save as… refuses a built-in name or an existing one; Save on Default saves nothing', async ($, on) => {
    const m = machine(on)
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    await ui.press({ key: 'toggle:skill:alpha' })
    await ui.press({ key: 'save' })
    expect(m.files.has(PRESETS)).toBe(false)
    expect(await texts(ui, /Save as/)).toBeDefined()
    await ui.press({ key: 'save-as' })
    for (const text of ['Minimal', 'Default', ' default']) {
      await ui.input({ key: 'save-name', text })
      expect(m.files.has(PRESETS)).toBe(false)
      expect((await texts(ui, /built-in preset: choose another name/))?.props.color).toBe('warning')
    }
  })

  test('Save keeps what the preset says of items this project does not have', async ($, on) => {
    const lean = { name: 'Lean', parent: 'Minimal', enable: ['skill:alpha', 'skill:elsewhere'], disable: ['mcp:elsewhere'] }
    const m = machine(on, { files: { [PRESETS]: JSON.stringify({ version: 1, presets: [lean] }) } })
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    await ui.press({ key: 'preset:Lean' })
    await ui.press({ key: 'toggle:skill:alpha' })
    await ui.press({ key: 'toggle:skill:cmd1' })
    await ui.press({ key: 'save' })
    expect(m.json(PRESETS).presets).toEqual([{ ...lean, enable: ['skill:cmd1', 'skill:elsewhere'] }])
    expect(await texts(ui, /No unsaved changes/)).toBeDefined()
  })

  test('a user preset = base + differences, a new item as the base has it, ↺ back to the preset, deleted → its base', async ($, on) => {
    const presets = [{ name: 'Lean', parent: 'Minimal', enable: ['skill:alpha'], disable: [] }, { name: 'Full', parent: 'Default', enable: [], disable: ['skill:alpha'] }]
    const m = machine(on, { files: { [PRESETS]: JSON.stringify({ version: 1, presets }) } })
    m.files.set('/h/.claude/skills/newcomer/SKILL.md', '---\nname: newcomer\ndescription: New\n---\n')
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    const state = async () => [(await ui.find({ key: 'toggle:skill:alpha' }))?.props.label, (await ui.find({ key: 'toggle:skill:newcomer' }))?.props.label]
    await ui.press({ key: 'preset:Full' })
    expect(await state()).toEqual(['off', 'on'])
    await ui.press({ key: 'preset:Lean' })
    expect(await state()).toEqual(['on', 'off'])
    await ui.press({ key: 'toggle:skill:alpha' })
    await ui.press({ key: 'toggle:skill:newcomer' })
    expect(await texts(ui, /^2 unsaved changes$/)).toBeDefined()
    await ui.press({ key: 'undo' })
    expect(await state()).toEqual(['on', 'off'])
    expect(m.json(PRESETS).presets).toEqual(presets)
    await ui.press({ key: 'preset-delete' })
    await ui.press({ key: 'delete-confirm' })
    expect(m.json(PRESETS).presets).toEqual([presets[1]])
    expect((await ui.find({ key: 'preset:Minimal' }))?.props.variant).toBe('primary')
    expect(await state()).toEqual(['off', 'off'])
  })

  test('a user preset can be deleted after a confirmation; Minimal and Default cannot', async ($, on) => {
    const presets = [{ name: 'Lean', parent: 'Minimal', enable: [], disable: [] }]
    const m = machine(on, { files: { [PRESETS]: JSON.stringify({ version: 1, presets }) } })
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    expect(await ui.find({ key: 'preset-delete' })).toBeUndefined()
    await ui.press({ key: 'preset:Lean' })
    await ui.press({ key: 'preset-delete' })
    expect(m.json(PRESETS).presets).toHaveLength(1)
    await ui.press({ key: 'delete-confirm' })
    expect(m.json(PRESETS).presets).toEqual([])
    expect(await ui.find({ key: 'preset:Lean' })).toBeUndefined()
  })
})

describe('apply', () => {
  test('Make default shows the summary first, then writes the local settings and the state, and reloads', async ($, on) => {
    const m = machine(on)
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    await ui.press({ key: 'toggle:skill:alpha' })
    await ui.press({ key: 'tab:mcp' })
    await ui.press({ key: 'toggle:mcp:u1' })
    await ui.press({ key: 'make-default' })
    expect(m.files.has(LOCAL)).toBe(false)
    expect(await texts(ui, /Switching off/)).toBeDefined()
    expect(await texts(ui, /alpha/)).toBeDefined()
    expect(await texts(ui, /From the next session/)).toBeDefined()
    expect(await texts(ui, new RegExp(LOCAL))).toBeDefined()
    await ui.press({ key: 'confirm' })
    const local = m.json(LOCAL)
    expect(local.skillOverrides).toEqual({ alpha: 'off' })
    expect(local.deniedMcpServers).toEqual([{ serverName: 'u1' }])
    expect(m.json(STATE).projects[ROOT].entries).toHaveLength(2)
    expect(m.commands).toEqual(['reload-plugins'])
    // the pane writes through $.fs: no tool call, so its own guard never sees it
    expect(m.toolCalls).toEqual([])
    expect(m.toasts.join(' ')).toMatch(/is the project default/)
  })

  test('protected items need the explicit extra confirmation before Confirm exists', async ($, on) => {
    const m = machine(on)
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    await ui.press({ key: 'tab:hook' })
    await ui.press({ key: `toggle:hook:${hid('resource-guard.cjs', 'PreToolUse')}` })
    await ui.press({ key: 'make-default' })
    expect(await ui.find({ key: 'confirm' })).toBeUndefined()
    expect((await texts(ui, /resource-guard/))?.props.color).toBe('error')
    await ui.press({ key: 'protected-ok' })
    await ui.press({ key: 'confirm' })
    expect(m.json(STATE).projects[ROOT].hooksOff).toEqual([hid('resource-guard.cjs', 'PreToolUse')])
  })

  // The pane switched resource-guard off, then another window switched it on again: an Apply of the pane
  // made on what it read before must never switch the guard off again without the extra tick.
  const guardOffByPane = async (ui: any) => {
    await ui.press({ key: 'tab:hook' })
    await ui.press({ key: `toggle:hook:${hid('resource-guard.cjs', 'PreToolUse')}` })
    await ui.press({ key: 'make-default' })
    await ui.press({ key: 'protected-ok' })
    await ui.press({ key: 'confirm' })
    await ui.press({ key: 'tab:skill' })
  }
  const otherWindowWrites = async (m: { files: Map<string, string> }) => {
    const fs = new MemFs()
    fs.files = m.files
    const c = ctx(fs)
    const inv = await readInventory(c)
    const always: StateMap = new Map(inv.items.map((i) => [itemKey(i), i.on]))
    await applyPatch(c, compile(inv.items, always), { preset: 'Default', now: new Date() })
  }

  test('Make default re-reads the disk before the summary: changed since loading → reloads, warns, writes nothing', async ($, on) => {
    const m = machine(on)
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    await guardOffByPane(ui)
    expect(m.json(STATE).projects[ROOT].hooksOff).toEqual([hid('resource-guard.cjs', 'PreToolUse')])
    await otherWindowWrites(m)
    expect(m.json(STATE).projects[ROOT].hooksOff).toEqual([])
    const written = new Map(m.files)
    await ui.press({ key: 'toggle:skill:alpha' })
    await ui.press({ key: 'make-default' })
    expect(await ui.find({ key: 'confirm' })).toBeUndefined()
    expect((await texts(ui, new RegExp(CHANGED)))?.props.color).toBe('warning')
    expect([...m.files]).toEqual([...written])
    // reloaded: the guard shows on, as the other window left it; a new Apply goes through without touching it
    await ui.press({ key: 'tab:hook' })
    expect((await ui.find({ key: `toggle:hook:${hid('resource-guard.cjs', 'PreToolUse')}` }))?.props.label).toBe('on')
    await ui.press({ key: 'tab:skill' })
    await ui.press({ key: 'toggle:skill:alpha' })
    await ui.press({ key: 'make-default' })
    await ui.press({ key: 'confirm' })
    expect(m.json(STATE).projects[ROOT].hooksOff).toEqual([])
    expect(m.json(LOCAL).skillOverrides).toEqual({ alpha: 'off' })
  })

  test('Confirm re-reads the disk: changed while the summary was open → reloads, warns, writes nothing', async ($, on) => {
    const m = machine(on)
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    await guardOffByPane(ui)
    await ui.press({ key: 'toggle:skill:alpha' })
    await ui.press({ key: 'make-default' })
    expect(await ui.find({ key: 'confirm' })).toBeDefined()
    await otherWindowWrites(m)
    const written = new Map(m.files)
    await ui.press({ key: 'confirm' })
    expect([...m.files]).toEqual([...written])
    expect(m.json(STATE).projects[ROOT].hooksOff).toEqual([])
    expect((await texts(ui, new RegExp(CHANGED)))?.props.color).toBe('warning')
    expect(await ui.find({ key: 'confirm' })).toBeUndefined()
  })

  // Without the settled record in what the pane has seen, every write would be refused as changed on disk.
  test('after a default killed between the registry and the local file, the pane still writes', async ($, on) => {
    const half = {
      preset: 'X', appliedAt: '2026-11-01T00:00:00.000Z', hooksOff: [], createdPaths: [], pending: true,
      entries: [{ item: 'skill:cmd1', on: false, kind: 'set', path: ['skillOverrides', 'cmd1'], value: 'off', prev: { present: false } }],
    }
    const m = machine(on, { files: { [STATE]: JSON.stringify({ version: 1, projects: { [ROOT]: half }, sessions: {}, created: {} }) } })
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    expect((await ui.find({ key: 'toggle:skill:cmd1' }))?.props.label).toBe('on')
    await ui.press({ key: 'toggle:skill:alpha' })
    await ui.press({ key: 'make-default' })
    expect(await texts(ui, new RegExp(CHANGED))).toBeUndefined()
    await ui.press({ key: 'confirm' })
    expect(m.json(LOCAL).skillOverrides).toEqual({ alpha: 'off' })
    expect(m.json(STATE).projects[ROOT].pending).toBeUndefined()
  })

  test('Save after another window deleted the preset does not bring it back', async ($, on) => {
    const m = machine(on)
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    await ui.press({ key: 'toggle:skill:alpha' })
    await ui.press({ key: 'save-as' })
    await ui.input({ key: 'save-name', text: 'Lean' })
    const fs = new MemFs()
    fs.files = m.files
    await deletePreset(fs, DIRS.state, 'Lean')
    await ui.press({ key: 'toggle:skill:cmd1' })
    await ui.press({ key: 'save' })
    expect(m.json(PRESETS).presets).toEqual([])
    expect((await texts(ui, new RegExp(CHANGED)))?.props.color).toBe('warning')
    expect(await ui.find({ key: 'preset:Lean' })).toBeUndefined()
  })

  test('Save as… after another window saved a preset writes nothing: reloads and warns', async ($, on) => {
    const m = machine(on)
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    await ui.press({ key: 'toggle:skill:alpha' })
    const fs = new MemFs()
    fs.files = m.files
    const other = { name: 'FromTab', parent: 'Default', enable: [], disable: [] }
    await savePreset(fs, DIRS.state, other)
    const written = new Map(m.files)
    await ui.press({ key: 'save-as' })
    await ui.input({ key: 'save-name', text: 'Lean' })
    expect([...m.files]).toEqual([...written])
    expect(m.json(PRESETS).presets).toEqual([other])
    expect((await texts(ui, new RegExp(CHANGED)))?.props.color).toBe('warning')
  })

  test('Delete after another window changed the preset deletes nothing: reloads and warns', async ($, on) => {
    const presets = [{ name: 'Lean', parent: 'Minimal', enable: [], disable: [] }]
    const m = machine(on, { files: { [PRESETS]: JSON.stringify({ version: 1, presets }) } })
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    await ui.press({ key: 'preset:Lean' })
    await ui.press({ key: 'preset-delete' })
    const fs = new MemFs()
    fs.files = m.files
    const changed = { name: 'Lean', parent: 'Minimal', enable: ['skill:alpha'], disable: [] }
    await savePreset(fs, DIRS.state, changed)
    const written = new Map(m.files)
    await ui.press({ key: 'delete-confirm' })
    expect([...m.files]).toEqual([...written])
    expect(m.json(PRESETS).presets).toEqual([changed])
    expect((await texts(ui, new RegExp(CHANGED)))?.props.color).toBe('warning')
  })

  test('Cancel in the summary writes nothing', async ($, on) => {
    const m = machine(on)
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    await ui.press({ key: 'toggle:skill:alpha' })
    await ui.press({ key: 'make-default' })
    await ui.press({ key: 'cancel' })
    expect(m.files.has(LOCAL)).toBe(false)
    expect(m.files.has(STATE)).toBe(false)
    expect(await texts(ui, /^1 unsaved change$/)).toBeDefined()
  })

  test('a session in ~ says that the local file is ~/.claude/settings.local.json', async ($, on) => {
    machine(on, { root: HOME })
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    await ui.press({ key: 'toggle:skill:alpha' })
    await ui.press({ key: 'make-default' })
    expect(await texts(ui, /Session in ~/)).toBeDefined()
    expect(await texts(ui, /\/h\/\.claude\/settings\.local\.json/)).toBeDefined()
  })

  test('/plancia reset retracts what plancia wrote, after a click', async ($, on) => {
    const m = machine(on)
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    await ui.press({ key: 'toggle:skill:alpha' })
    await ui.press({ key: 'make-default' })
    await ui.press({ key: 'confirm' })
    expect(m.files.has(LOCAL)).toBe(true)
    await ui.unmount()
    await open($, 'reset')
    const ui2 = await $.ui.mount(pane('terminal'))
    expect(m.files.has(LOCAL)).toBe(true)
    await ui2.press({ key: 'reset-confirm' })
    expect(m.files.has(LOCAL)).toBe(false)
    expect(m.json(STATE).projects[ROOT]).toBeUndefined()
  })

  // Seen live (2.1.332): in the chat of VS Code the engine takes /reload-plugins only from the user.
  for (const [tab, key, asked] of [['plugin', 'plugin:pa@m', true], ['skill', 'skill:alpha', false]] as const) {
    test(`VS Code: ${asked ? 'a plugin changed, the notice asks for /reload-plugins after the outcome' : 'no plugin changed, nothing asked'}; never run by Plancia`, async ($, on) => {
      const m = machine(on, { surfaces: ['vscode'] })
      await open($)
      const ui = await $.ui.mount(pane('vscode'))
      const said = async (outcome: RegExp) => {
        expect(await texts(ui, outcome)).toBeDefined()
        expect(!!(await texts(ui, /Type \/reload-plugins/))).toBe(asked)
        expect(m.commands).toEqual([])
      }
      const change = async (how: string) => {
        await ui.press({ key: `tab:${tab}` })
        await ui.press({ key: `toggle:${key}` })
        await ui.press({ key: how })
        await ui.press({ key: 'confirm' })
      }
      await change('apply')
      await said(/applied .* to this chat\.$/)
      await open($, 'reset')
      await ui.press({ key: 'reset-confirm' })
      await said(/^Everything Plancia wrote for .* is undone\.$/)
      await change('make-default')
      await said(/is the project default/)
      await open($, 'reset --all')
      await ui.press({ key: 'reset-all-confirm' })
      await said(/1 of 1 project reset\./)
    })
  }

  test('no tool is registered: an agent has no way to apply a preset', async ($, on) => {
    const m = machine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: ROOT } as any)
    await open($)
    expect(m.registeredTools).toEqual([])
  })
})

describe('keys', () => {
  test('the terminal, where a mouse may not work, says the keys; the chat of VS Code does not', async ($, on) => {
    machine(on)
    await open($)
    const hint = { type: 'Text', text: /^Tab moves, Enter presses, arrows scroll$/ } as const
    expect(await (await $.ui.mount(pane('terminal'))).find(hint)).toBeDefined()
    expect(await (await $.ui.mount(pane('vscode'))).find(hint)).toBeUndefined()
  })
})

describe('session.start', () => {
  test('registers the command and never opens the pane by itself', async ($, on) => {
    const m = machine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: ROOT } as any)
    expect(m.registeredCommands).toEqual(['plancia'])
    expect(m.opened).toEqual([])
    expect(m.toasts).toEqual([])
  })

  test('an unreadable state.json gets a toast that names /plancia, only with a surface (not in claude -p)', async ($, on) => {
    const m = machine(on, { files: { [STATE]: '{broken' } })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: ROOT } as any)
    expect(m.toasts.join(' ')).toMatch(/\/plancia/)
    expect(m.opened).toEqual([])
  })

  test('/plancia without a surface (claude -p) says where to run it', async ($, on) => {
    const m = machine(on, { surfaces: [] })
    const r = await $.command.run({ command: 'plancia', args: '' } as any)
    expect(r).toEqual({ text: 'Plancia opens in an interactive session: run claude, then /plancia' })
    expect(m.opened).toEqual([])
  })

  test('does nothing without a surface (claude -p)', async ($, on) => {
    const m = machine(on, { surfaces: [], files: { [STATE]: '{broken' } })
    await $.session.start({ surface: 'terminal', isInteractive: false, cwd: ROOT } as any)
    expect(m.opened).toEqual([])
    expect(m.toasts).toEqual([])
  })
})

describe('guards', () => {
  test('tool.call denies the file-writing tools on ~/.config/plancia, lets the rest through', async ($, on) => {
    const m = machine(on)
    const w = await $.tool.call({ tool: 'Write', file_path: `${HOME}/.config/plancia/state.json`, content: '{}' } as any)
    expect(JSON.stringify(w)).toMatch(/Plancia/)
    const me = await $.tool.call({ tool: 'MultiEdit', file_path: `${HOME}/.config/plancia/state.json`, edits: [] } as any)
    expect(JSON.stringify(me)).toMatch(/Plancia/)
    const e = await $.tool.call({ tool: 'Edit', file_path: `${HOME}/.config/plancia/presets.json`, old_string: 'a', new_string: 'b' } as any)
    expect(JSON.stringify(e)).toMatch(/Plancia/)
    expect(m.toolCalls).toEqual([])
    const ok = await $.tool.call({ tool: 'Write', file_path: `${ROOT}/notes.md`, content: 'x' } as any)
    expect(ok).toEqual({ result: 'ok' })
    expect(m.toolCalls).toEqual(['Write'])
  })

  test('Bash is not guarded', async ($, on) => {
    const m = machine(on)
    expect(await $.tool.call({ tool: 'Bash', command: 'echo {} > ~/.config/plancia/state.json' } as any)).toEqual({ result: 'ok' })
    expect(m.toolCalls).toEqual(['Bash'])
  })

  const write = async ($: any, file_path: string) => JSON.stringify(await $.tool.call({ tool: 'Write', file_path, content: '{}' } as any))
  const DENIED = /Plancia/

  test('the state folder is the one of XDG_CONFIG_HOME, and the default one too', async ($, on) => {
    const m = machine(on, { env: { XDG_CONFIG_HOME: '/xdg' } })
    for (const path of ['/xdg/plancia/state.json', '/xdg/plancia', `${STATE}`, '/xdg/other/../plancia/x/y', '../../../xdg/plancia/protected.json'])
      expect(await write($, path)).toMatch(DENIED)
    expect(m.toolCalls).toEqual([])
    const fine = ['/xdg/planciax/state.json', '/other/.config/plancia/state.json', 'xdg/plancia/state.json']
    for (const path of fine) expect(await write($, path)).not.toMatch(DENIED)
    expect(m.toolCalls).toEqual(fine.map(() => 'Write'))
  })

  test('links: a path that leads to the state folder, and the state folder behind a link, by both names', async ($, on) => {
    const m = machine(on, { links: { [`${ROOT}/link`]: DIRS.state, [`${HOME}/.config`]: '/dotfiles' } })
    for (const path of ['link/state.json', `${ROOT}/link/new.json`, `${HOME}/.config/plancia/state.json`, '/dotfiles/plancia/state.json'])
      expect(await write($, path)).toMatch(DENIED)
    expect(m.toolCalls).toEqual([])
    expect(await write($, '/dotfiles/plancia-notes.md')).not.toMatch(DENIED)
  })

  test('NotebookEdit is guarded as well', async ($, on) => {
    const m = machine(on)
    expect(JSON.stringify(await $.tool.call({ tool: 'NotebookEdit', notebook_path: `${DIRS.state}/x.ipynb`, new_source: '' } as any))).toMatch(DENIED)
    expect(await $.tool.call({ tool: 'NotebookEdit', notebook_path: `${ROOT}/x.ipynb`, new_source: '' } as any)).toEqual({ result: 'ok' })
    expect(m.toolCalls).toEqual(['NotebookEdit'])
  })

  // As Claude Code reads a path (2.1.331): String.trim, `~`, `.` and `..` folded, NFC. XDG_CONFIG_HOME holds an accented letter as one character.
  const XDG = '/xdg/caf\u00e9'
  const SPACES = { space: ' ', tab: '\t', 'line feed': '\n', 'carriage return': '\r', 'vertical tab': '\v', 'form feed': '\f', NBSP: '\u00a0', BOM: '\ufeff', 'em space': '\u2003', 'ideographic space': '\u3000', 'line separator': '\u2028' }
  const FORMS: Record<string, string> = {
    ...Object.fromEntries(Object.entries(SPACES).flatMap(([name, s]) => [
      [`${name} before`, `${s}${XDG}/plancia/state.json`], [`${name} before ..`, `${s}../../..${XDG}/plancia/state.json`],
      [`${name} before ~`, `${s}~/.config/plancia/state.json`], [`${name} after the folder`, `${XDG}/plancia${s}`],
    ])),
    'e and combining accent': '/xdg/cafe\u0301/plancia/state.json',
    'double and dotted slashes': `/${XDG}//./plancia/.//state.json`,
    'a path too long for an argument': `${XDG}/${'a/../'.repeat(50_000)}plancia/state.json`,
    'proc cwd': '/proc/self/cwd/plancia/state.json',
    'proc thread cwd': '/proc/thread-self/cwd/plancia/state.json',
    'proc of another process': '/proc/4242/cwd/plancia/state.json',
    'proc task': '/proc/self/task/1/cwd/plancia/state.json',
    'proc root': `/proc/self/root${XDG}/plancia/state.json`,
    'proc fd': '/proc/self/fd/7/state.json',
    'proc by ..': '../../../proc/self/cwd/plancia/state.json',
    'proc by /dev': ' /dev/..//proc/./self/cwd/plancia/state.json',
    'dev fd': '/dev/fd/7/state.json',
    'dev stdin': '/dev/stdin',
    'dev stdout': '/dev/stdout/state.json',
    'dev stderr': '/dev/stderr',
    'a link into proc': 'proclink/plancia/state.json',
    'another mount of the folder': '/bind/plancia/state.json',
    'another mount of the folder, a new subfolder': '/bind/plancia/new/x.json',
  }
  for (const [name, path] of Object.entries(FORMS)) {
    test(`denied by any spelling: ${name}`, async ($, on) => {
      const m = machine(on, { env: { XDG_CONFIG_HOME: XDG }, links: { [`${ROOT}/proclink`]: '/proc/4242/cwd' }, ids: { [`${XDG}/plancia`]: '1:2', '/bind/plancia': '1:2', '/bind': '1:1' } })
      expect(await write($, path)).toMatch(DENIED)
      expect(m.toolCalls).toEqual([])
    })
  }

  test('denied in a folder whose name is in combining characters', async ($, on) => {
    machine(on, { env: { XDG_CONFIG_HOME: '/xdg/cafe\u0301' } })
    expect(await write($, `${XDG}/plancia/state.json`)).toMatch(DENIED)
  })

  test('what only looks like those spellings goes through', async ($, on) => {
    const m = machine(on, { env: { XDG_CONFIG_HOME: XDG }, ids: { [`${XDG}/plancia`]: '1:2', [XDG]: '1:1', '/': '1:0' } })
    const fine = [`\u200b${XDG}/plancia/state.json`, `${XDG}/plancia\u200b/state.json`, `${XDG}/ plancia/state.json`, `file://${XDG}/plancia/state.json`, `${XDG}/Plancia/state.json`,
      `\u0001${XDG}/plancia/state.json`, `${XDG}/notes.md`, ' notes.md', 'caf\u00e9.md', 'proc/self/cwd/plancia/x', '/procs/x', '/h/proc/self/x', '/dev/null', '/dev/fdx', '/dev/shm/x', '/dev/stdinx', `/tmp/${'a/'.repeat(1500)}x`]
    for (const path of fine) expect([path, await write($, path)]).toEqual([path, JSON.stringify({ result: 'ok' })])
    expect(m.toolCalls).toEqual(fine.map(() => 'Write'))
  })

  test('when the guard itself fails it still denies the state, and only the state', async ($, on) => {
    const m = machine(on, { noCwd: true })
    for (const path of ['~/.config/plancia/state.json', `${HOME}/.config/plancia/state.json`, '../../.config/plancia/state.json'])
      expect(await write($, path)).toMatch(DENIED)
    expect(m.toolCalls).toEqual([])
    expect(await write($, '/h/p/plancia/notes.md')).toEqual(JSON.stringify({ result: 'ok' }))
    expect(m.toolCalls).toEqual(['Write'])
  })

  test('when the guard throws before deciding: the spelling, on the folders last known, else on any home', async ($, on) => {
    const o: Parameters<typeof machine>[1] = { env: { XDG_CONFIG_HOME: '/xdg' }, platform: 'broken' }
    const m = machine(on, o)
    expect(await write($, '/any/.config/plancia/state.json')).toMatch(DENIED)
    expect(await write($, '/proc/self/cwd/plancia/state.json')).toMatch(DENIED)
    expect(await write($, '/xdg/plancia/state.json')).not.toMatch(DENIED)
    o!.platform = 'linux'
    expect(await write($, `${ROOT}/notes.md`)).not.toMatch(DENIED)
    o!.platform = 'broken'
    expect(await write($, '/xdg/plancia/state.json')).toMatch(DENIED)
    expect(await write($, `${ROOT}/notes.md`)).not.toMatch(DENIED)
    expect(m.toolCalls).toEqual(['Write', 'Write', 'Write'])
  })

  test('without the environment any home counts', async ($, on) => {
    const m = machine(on, { noEnv: true })
    for (const path of ['~/.config/plancia/state.json', '/any/.config/plancia/state.json']) expect(await write($, path)).toMatch(DENIED)
    expect(m.toolCalls).toEqual([])
    expect(await write($, '/h/p/plancia/notes.md')).toEqual(JSON.stringify({ result: 'ok' }))
  })
})

const HOOKS = {
  PreToolUse: [{ matcher: 'Bash', hooks: [
    { type: 'command', command: 'node /h/shared/hooks/resource-guard.cjs' },
    { type: 'command', command: 'bash /h/shared/hooks/delete-guard.sh pre-bash' },
  ] }],
  SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'node /h/shared/hooks/compressor-gate.cjs' }] }],
  Stop: [{ hooks: [{ type: 'command', command: 'bash /h/shared/hooks/stop-check.sh' }] }],
}
const stateWith = (hooksOff: string[]) =>
  JSON.stringify({ version: 1, projects: { [ROOT]: { preset: 'X', appliedAt: 'x', entries: [], hooksOff, createdPaths: [] } } })

// A second mod that reads the merged settings, as Claude Code does, so the read passes through plancia's hook.
const reader = {
  name: 'reader',
  register(on: any) {
    on('command.run', { command: 'read-settings' }, async ($: any) => ({ text: JSON.stringify(await $.settings.read()) }))
  },
}

describe('settings.read', () => {
  test('removes the hooks switched off for the project, keeps the others and SessionStart', { plugins: [reader] }, async ($, on) => {
    machine(on, { files: { [STATE]: stateWith([hid('resource-guard.cjs', 'PreToolUse'), hookId('Stop', HOOKS.Stop[0]!.hooks[0]!), hid('compressor-gate.cjs', 'SessionStart')]) } })
    on('settings.read', () => ({ value: { model: 'x', hooks: HOOKS } }))
    const r = await $.command.run({ command: 'read-settings', args: '' } as any)
    const s = JSON.parse(String(r.text))
    expect(s.model).toBe('x')
    expect(s.hooks).toEqual({
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'bash /h/shared/hooks/delete-guard.sh pre-bash' }] }],
      SessionStart: HOOKS.SessionStart,
    })
    expect('disableAllHooks' in s).toBe(false)
  })

  test('leaves the settings alone for a project with nothing switched off, or a broken state', { plugins: [reader] }, async ($, on) => {
    const m = machine(on)
    on('settings.read', () => ({ value: { hooks: HOOKS } }))
    const r1 = JSON.parse(String((await $.command.run({ command: 'read-settings', args: '' } as any)).text))
    expect(r1.hooks).toEqual(HOOKS)
    m.files.set(STATE, '{broken')
    const r2 = JSON.parse(String((await $.command.run({ command: 'read-settings', args: '' } as any)).text))
    expect(r2.hooks).toEqual(HOOKS)
  })
})

// The hook itself, for what the bench does not raise: the layers of a read, a read of one source, a failure.
const hookOf = (event: string) => {
  let hook: any
  let caught: any
  register(((name: string, ...rest: any[]) => {
    if (name === event) hook = rest.at(-1)
    return { catch: (f: any) => { if (name === event) caught = f } }
  }) as any, {} as any)
  return { hook, caught }
}
// Its $: the bench's own has no session.info.
const $of = (m: Machine, root = ROOT, info: unknown = { platform: 'linux' }): any => {
  const orThrow = <T,>(v: T | null | undefined): T => {
    if (v === null || v === undefined) throw new Error('ENOENT')
    return v
  }
  return {
    session: { info: async () => info, root: async () => root, id: async () => m.sid },
    env: { get: async (k: string) => (k === 'HOME' ? HOME : undefined) },
    fs: {
      read: async (p: string) => orThrow(await m.fs.readText(p)),
      list: async (p: string) => orThrow(await m.fs.list(p)).map((name) => ({ name })),
      stat: async () => orThrow(null),
    },
  }
}
const readWith = async ($: any, hook: any, value: unknown, e: Record<string, unknown> = {}) => {
  const read = { value }
  const next: any = async () => read
  next.origin = { plugin: 'other', tier: 'user' }
  const r = await hook($, { layers: [], ...e }, next)
  return r === read ? 'as it was' : r.value
}

describe('settings.read, the hook', () => {
  const stop = hookId('Stop', HOOKS.Stop[0]!.hooks[0]!)
  const project = { source: 'project', settings: { hooks: { Stop: HOOKS.Stop } } }
  const left = { PreToolUse: HOOKS.PreToolUse, SessionStart: HOOKS.SessionStart }

  test('a read of one source is answered as loaded', async (_, on) => {
    const $ = $of(machine(on, { files: { [STATE]: stateWith([stop]) } }))
    const { hook } = hookOf('settings.read')
    expect(await readWith($, hook, { hooks: HOOKS })).toEqual({ hooks: left })
    expect(await readWith($, hook, { hooks: HOOKS }, { source: 'user' })).toBe('as it was')
  })

  test("a hook the project has too stays; in the home folder that file is the user's own", async (_, on) => {
    const $ = $of(machine(on, { files: { [STATE]: stateWith([stop]) } }))
    expect(await readWith($, hookOf('settings.read').hook, { hooks: HOOKS }, { layers: [project] })).toBe('as it was')
  })

  test("in the home folder the project's file is the user's own: its hooks go", async (_, on) => {
    const $ = $of(machine(on, { files: { [STATE]: stateWith([stop]).replace(ROOT, HOME) } }), HOME)
    expect(await readWith($, hookOf('settings.read').hook, { hooks: HOOKS }, { layers: [project] })).toEqual({ hooks: left })
    expect(await readWith($, hookOf('settings.read').hook, { hooks: HOOKS }, { layers: [{ ...project, source: 'plugin' }] })).toBe('as it was')
  })

  test("the chat's choice follows what the settings and the project's default have become", async (_, on) => {
    const chat = { root: ROOT, preset: 'X', desired: { 'skill:alpha': false, 'skill:later': false }, hooksOff: [], updatedAt: new Date().toISOString() }
    const state = (entries: unknown[]) => JSON.stringify({ version: 1, projects: { [ROOT]: { preset: 'X', appliedAt: 'x', entries, hooksOff: [], createdPaths: [] } }, sessions: { [SID]: chat } })
    const alphaOff = { item: 'skill:alpha', on: false, kind: 'set', path: ['skillOverrides', 'alpha'], value: 'off', prev: { present: false } }
    const m = machine(on, { files: { [STATE]: state([]) } })
    const $ = $of(m)
    const { hook } = hookOf('settings.read')
    expect(await readWith($, hook, {})).toEqual({ skillOverrides: { alpha: 'off' } })
    // another item, in another merge
    m.files.set(`${HOME}/.claude/skills/later/SKILL.md`, '---\nname: later\ndescription: x\n---\n')
    expect(await readWith($, hook, {})).toEqual({ skillOverrides: { alpha: 'off' } })
    expect(await readWith($, hook, { model: 'x' })).toEqual({ model: 'x', skillOverrides: { alpha: 'off', later: 'off' } })
    // the same merge, the default has the item off by now
    m.files.delete(`${HOME}/.claude/skills/later/SKILL.md`)
    m.files.set(STATE, state([alphaOff]))
    m.files.set(LOCAL, JSON.stringify({ skillOverrides: { alpha: 'off' } }))
    expect(await readWith($, hook, { model: 'x' })).toEqual({ model: 'x' })
  })

  test('whatever fails leaves the settings as they are', async (_, on) => {
    const $ = $of(machine(on, { files: { [STATE]: stateWith([stop]) } }), ROOT, null)
    const { hook, caught } = hookOf('settings.read')
    await expect(readWith($, hook, { hooks: HOOKS })).rejects.toThrow()
    expect(await readWith($, caught, { hooks: HOOKS })).toBe('as it was')
  })
})

describe('rules imported through other rules', () => {
  test('a rule imported only by a rule switched off shows off, without a switch of its own', async ($, on) => {
    machine(on)
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    await ui.press({ key: 'tab:rule' })
    expect(await ui.find({ key: 'toggle:rule:/h/team/rules.md' })).toBeDefined()
    await ui.press({ key: 'toggle:rule:/h/.claude/CLAUDE.md' })
    expect(await ui.find({ key: 'toggle:rule:/h/team/rules.md' })).toBeUndefined()
    expect(await texts(ui, /imported only by rules that are off/)).toBeDefined()
    // the importer is protected too: it pulls in the protected rules
    expect((await ui.find({ key: 'toggle:rule:/h/.claude/CLAUDE.md' }))?.props.label).toBe('off')
  })

  test('a rule imported by a file the user excluded shows off', async ($, on) => {
    machine(on, { files: { [LOCAL]: JSON.stringify({ claudeMdExcludes: ['/h/.claude/CLAUDE.md'] }) } })
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    await ui.press({ key: 'tab:rule' })
    expect(await ui.find({ key: 'toggle:rule:/h/team/rules.md' })).toBeUndefined()
    expect(await texts(ui, /imported only by rules that are off/)).toBeDefined()
  })
})

describe('Fs over $.fs', () => {
  test('remove refuses every path outside ~/.config/plancia and the project local settings', async ($, on) => {
    const m = machine(on, { files: { '/h/other.txt': 'x' } })
    const fs = fsOf($ as any, DIRS.state)
    await expect(fs.remove('/h/other.txt')).rejects.toThrow(/does not delete/)
    expect(m.files.has('/h/other.txt')).toBe(true)
    await expect(fs.remove(`${HOME}/.config/plancia-evil/x`)).rejects.toThrow(/does not delete/)
    for (const p of ['.claude/settings.json', '.claude/settings.local.json.bak', 'x.settings.local.json', '.claude/settings.local.json.1-a.plancia-tmp/x'])
      await expect(fs.remove(`${ROOT}/${p}`)).rejects.toThrow(/does not delete/)
    // the allowed paths go through rm: covered by the apply and backup flows above
  })
})

describe('bulk switches and list height', () => {
  test('All on / All off act on the found items of the tab only', async ($, on) => {
    machine(on)
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    await ui.input({ key: 'search:skill', text: 'alp' })
    await ui.press({ key: 'all-off' })
    expect((await ui.find({ key: 'toggle:skill:alpha' }))?.props.label).toBe('off')
    await ui.input({ key: 'search:skill', text: '' })
    expect((await ui.find({ key: 'toggle:skill:cmd1' }))?.props.label).toBe('on')
    expect((await ui.find({ key: 'tab:skill' }))?.props.label).toContain(`${TAB_LABEL.skill} 4/7`)
    await ui.press({ key: 'all-on' })
    expect((await ui.find({ key: 'tab:skill' }))?.props.label).toContain(`${TAB_LABEL.skill} 7/7`)
    // other tabs untouched
    expect((await ui.find({ key: 'tab:agent' }))?.props.label).not.toContain(`${TAB_LABEL.agent} 0/`)
  })

  test('All off on the hooks takes the protected ones too, and Apply still asks the extra confirmation', async ($, on) => {
    const m = machine(on)
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    await ui.press({ key: 'tab:hook' })
    await ui.press({ key: 'all-off' })
    expect((await ui.find({ key: `toggle:hook:${hid('resource-guard.cjs', 'PreToolUse')}` }))?.props.label).toBe('off')
    await ui.press({ key: 'make-default' })
    expect(await ui.find({ key: 'confirm' })).toBeUndefined()
    await ui.press({ key: 'protected-ok' })
    await ui.press({ key: 'confirm' })
    expect(m.json(STATE).projects[ROOT].hooksOff).toContain(hid('resource-guard.cjs', 'PreToolUse'))
  })

  test('the changes line is always in view in the list', async ($, on) => {
    machine(on)
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    expect(await texts(ui, /^Changes: none from what is applied\.$/)).toBeDefined()
    await ui.press({ key: 'toggle:skill:alpha' })
    expect(await texts(ui, /^Changes: switching off 1 \(alpha\)$/)).toBeDefined()
    await ui.press({ key: 'tab:hook' })
    await ui.press({ key: `toggle:hook:${hid('resource-guard.cjs', 'PreToolUse')}` })
    expect((await texts(ui, /^Changes: .*1 protected/))?.props.color).toBe('error')
  })

  test('hotkeys: digits on the tabs, letters on the bulk and height buttons', async ($, on) => {
    machine(on)
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    const keys = ['tab:skill', 'tab:plugin', 'tab:mcp', 'tab:agent', 'tab:rule', 'tab:hook', 'all-on', 'all-off', 'rows-up', 'rows-down']
    const hotkeys = await Promise.all(keys.map(async (k) => (await ui.find({ key: k }))?.props.hotkey))
    expect(hotkeys).toEqual(['1', '2', '3', '4', '5', '6', 'n', 'f', 't', 's'])
  })

  test('Taller / Shorter set the list height, saved in panel.json and read back at opening', async ($, on) => {
    const m = machine(on, { files: { [PANEL]: JSON.stringify({ version: 1, rows: 3 }) } })
    await open($)
    let ui = await $.ui.mount(pane('terminal'))
    expect(await texts(ui, /page 1\/3 · 7 items/)).toBeDefined()
    await ui.press({ key: 'rows-up' })
    expect(m.json(PANEL).rows).toBe(8)
    expect(await ui.find({ key: 'page-next' })).toBeUndefined()
    await ui.unmount()
    await open($)
    ui = await $.ui.mount(pane('terminal'))
    expect(await ui.find({ key: 'page-next' })).toBeUndefined()
    await ui.press({ key: 'rows-down' })
    await ui.press({ key: 'rows-down' })
    expect(m.json(PANEL).rows).toBe(3)
    expect(await texts(ui, /page 1\/3/)).toBeDefined()
  })

  test('two quick presses on Taller add up, one after the other (seen live: the second mv found no temp file)', async ($, on) => {
    const m = machine(on, { files: { [PANEL]: JSON.stringify({ version: 1, rows: 3 }) } })
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    await Promise.all([ui.press({ key: 'rows-up' }), ui.press({ key: 'rows-up' })])
    expect(m.json(PANEL).rows).toBe(13)
    expect(await texts(ui, /Height not saved/)).toBeUndefined()
    expect(await texts(ui, /List: 13 rows/)).toBeDefined()
  })
})

describe('band above the prompt', () => {
  const state = {
    version: 1,
    projects: {
      [ROOT]: {
        preset: `Lean${MODIFIED}`, appliedAt: 'x', createdPaths: [], hooksOff: ['a.sh:Stop'],
        entries: [
          { item: 'skill:alpha', on: false, kind: 'set', path: ['skillOverrides', 'alpha'], value: 'off', prev: { present: false } },
          { item: 'mcp:u1', on: false, kind: 'add', path: ['deniedMcpServers'], value: { serverName: 'u1' }, prev: { present: false } },
          { item: 'mcp:u1', on: false, kind: 'set', path: ['x'], value: 1, prev: { present: false } },
          { item: 'skill:docx', on: true, kind: 'set', path: ['skillOverrides', 'docx'], value: 'on', prev: { present: false } },
        ],
      },
    },
  }

  test('says preset and switched-off count on terminal and vscode, from one read of state.json, writing nothing', async ($, on) => {
    const m = machine(on, { files: { [STATE]: JSON.stringify(state) } })
    const before = new Map(m.files)
    for (const [surface, width] of [['terminal', 100], ['vscode', undefined]] as const) {
      m.reads.length = 0
      const ui = await $.ui.mount(band(surface))
      expect(await texts(ui, /^Plancia · Lean \(modified\) · 3 off$/)).toBeDefined()
      expect((await ui.find({ key: 'band-open' }))?.props.label).toBe('Open')
      expect((await ui.find({ key: 'band' }))?.props.width).toBe(width)
      expect(m.reads).toEqual([STATE])
      await ui.unmount()
    }
    expect([...m.files]).toEqual([...before])
  })

  test('after a default killed half way it counts what the local settings file holds', async ($, on) => {
    const entry = (id: string) => ({ item: `skill:${id}`, on: false, kind: 'set', path: ['skillOverrides', id], value: 'off', prev: { present: false } })
    const half = { preset: 'Lean', appliedAt: '2026-11-01T00:00:00.000Z', entries: [entry('a'), entry('b')], hooksOff: [], createdPaths: [], pending: true }
    machine(on, { files: { [STATE]: JSON.stringify({ version: 1, projects: { [ROOT]: half } }), [LOCAL]: JSON.stringify({ skillOverrides: { a: 'off' } }) } })
    const ui = await $.ui.mount(band('terminal'))
    expect(await texts(ui, /^Plancia · Lean · 1 off$/)).toBeDefined()
  })

  test('without a preset for the project it says so, with no count', async ($, on) => {
    machine(on)
    const ui = await $.ui.mount(band('terminal'))
    expect(await texts(ui, /^Plancia · no preset$/)).toBeDefined()
  })

  test('Open opens the /plancia pane with the focus', async ($, on) => {
    const m = machine(on)
    const ui = await $.ui.mount(band('vscode'))
    await ui.press({ key: 'band-open' })
    expect(m.opened.map((o) => [o.id, o.focus])).toEqual([['plancia', true]])
  })

  test('one band, never remounted: Open, Close, Open again opens the pane a second time', async ($, on) => {
    const m = machine(on)
    const ui = await $.ui.mount(band('vscode'))
    await ui.press({ key: 'band-open' })
    await ui.press({ key: 'band-open' })
    expect(m.closed).toEqual(['plancia'])
    expect((await ui.find({ key: 'band-open' }))?.props.label).toBe('Open')
    await ui.press({ key: 'band-open' })
    expect(m.opened.map((o) => o.id)).toEqual(['plancia', 'plancia'])
    expect((await ui.find({ key: 'band-open' }))?.props.label).toBe('Close')
  })

  test('a closed pane still listed by $.ui.panes() (seen in VS Code): Close turns back to Open and Open opens again', async ($, on) => {
    const m = machine(on, { stalePanes: true })
    const ui = await $.ui.mount(band('vscode'))
    await ui.press({ key: 'band-open' })
    await ui.press({ key: 'band-open' })
    expect((await ui.find({ key: 'band-open' }))?.props.label).toBe('Open')
    await ui.press({ key: 'band-open' })
    expect(m.opened.map((o) => o.id)).toEqual(['plancia', 'plancia'])
  })

  test('with the pane open the band says Close and closes it; then Open again', async ($, on) => {
    const m = machine(on)
    let ui = await $.ui.mount(band('vscode'))
    await ui.press({ key: 'band-open' })
    await ui.unmount()
    ui = await $.ui.mount(band('vscode'))
    expect((await ui.find({ key: 'band-open' }))?.props.label).toBe('Close')
    await ui.press({ key: 'band-open' })
    expect(m.closed).toEqual(['plancia'])
    await ui.unmount()
    ui = await $.ui.mount(band('vscode'))
    expect((await ui.find({ key: 'band-open' }))?.props.label).toBe('Open')
  })

  test('yields to a survey: with a valid state the band is there, under a survey it is not', async ($, on) => {
    machine(on)
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>prompt only</Text>
    })
    let ui = await $.ui.mount(band('terminal'))
    expect(await ui.find({ key: 'band-open' })).toBeDefined()
    await ui.unmount()
    ui = await $.ui.mount(band('terminal', true))
    expect(await ui.find({ key: 'band-open' })).toBeUndefined()
    expect(await texts(ui, /prompt only/)).toBeDefined()
  })

  test('on a broken state.json it says so, above the others', async ($, on) => {
    machine(on, { files: { [STATE]: '{broken' } })
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>prompt only</Text>
    })
    const ui = await $.ui.mount(band('terminal'))
    expect(await texts(ui, /prompt only/)).toBeDefined()
    expect(await texts(ui, /^Plancia · saved choices ignored/)).toBeDefined()
    expect((await ui.find({ key: 'band-open' }))?.props.label).toBe('Open')
  })

  test("another mod's row stays, below Plancia's", async ($, on) => {
    machine(on)
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>other row</Text>
    })
    const ui = await $.ui.mount(band('terminal'))
    expect(await texts(ui, /other row/)).toBeDefined()
    // The bench draws each plugin's part apart: the order Plancia owns is inside its part, its band
    // first and then what next(e) returned (the rows below, an `engine` reference here).
    const part = ((await ui.drawn()) as any).children.find((c: any) => c.part?.plugin === 'plancia')
    expect(part.children.map((c: any) => c.props?.key ?? c.type)).toEqual(['band', 'engine'])
  })
})
