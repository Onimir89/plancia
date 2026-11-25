// The setup guide, and what it protects.
import { describe, expect } from 'claude-code/testing'
import { hid, DIRS, HOME, LOCAL, PROTECTED, ROOT, STATE, band, ctx, machine, pane, test, type Machine, type Options } from './harness.ts'
import { PROTECTED as LISTED, userSettings } from '../../spec/fixture.ts'
import { CHANGED, TAB_LABEL } from '../pane.tsx'
import { hookId, itemKey, lockPath, readInventory, setupChoices, writeProtected } from '../../src/core/index.ts'

const open = async ($: any, args = '') => {
  await $.command.run({ command: 'plancia', args })
}
const texts = async (ui: any, re: RegExp) => ui.find({ type: 'Text', text: re })
/** A machine where Plancia was never set up. */
const fresh = (on: any, o: Options = {}): Machine => {
  const m = machine(on, o)
  m.files.delete(PROTECTED)
  return m
}
/** Every box of the guide, key → ticked, as drawn. */
const boxes = async (ui: any, keys: Iterable<string>) => {
  const out = []
  for (const k of keys) {
    const label = String((await ui.find({ key: `setup:${k}` }))?.props.label)
    out.push([k, label.startsWith('☑ ') ? true : label.startsWith('☐ ') ? false : label])
  }
  return out
}
const proposed = async (m: Machine) => setupChoices((await readInventory(ctx(m.fs))).items, undefined)
const isGuide = async (ui: any) => !!(await ui.find({ key: 'setup-confirm' })) && !(await ui.find({ key: 'apply' }))
const isList = async (ui: any) => !(await ui.find({ key: 'setup-confirm' })) && !!(await ui.find({ key: 'apply' }))
const list = (keys: string[]) => ({ version: 1, protected: keys })

describe('first opening', () => {
  for (const how of ['/plancia', 'the band']) {
    test(`by ${how}: the guide, everything proposed ticked, and no file written by opening, unticking or closing`, async ($, on) => {
      const m = fresh(on)
      const before = [...m.files]
      let ui = await $.ui.mount(band('terminal'))
      if (how === '/plancia') await open($)
      else await ui.press({ key: 'band-open' })
      await ui.unmount()
      ui = await $.ui.mount(pane('terminal') as any)
      expect(await isGuide(ui)).toBe(true)
      const all = await proposed(m)
      expect(all.size).toBeGreaterThan(LISTED.length)
      expect(await boxes(ui, all.keys())).toEqual([...all])
      expect(await texts(ui, /Nothing is written until you press Confirm or Skip/)).toBeDefined()
      await ui.press({ key: `setup:${LISTED[0]}` })
      expect(await boxes(ui, [LISTED[0]!])).toEqual([[LISTED[0], false]])
      await ui.unmount()
      // opened again: not done yet, and ticked anew
      await open($)
      ui = await $.ui.mount(pane('terminal') as any)
      expect(await boxes(ui, [LISTED[0]!])).toEqual([[LISTED[0], true]])
      expect([...m.files]).toEqual(before)
      expect([...m.fs.dirs]).toEqual([])
    })
  }

  test('drawn again after the module was reloaded: still the guide', async ($, on) => {
    fresh(on)
    const ui = await $.ui.mount(pane('terminal'))
    expect(await isGuide(ui)).toBe(true)
  })

  test('each row says what and where it is', async ($, on) => {
    fresh(on)
    await open($)
    const ui = await $.ui.mount(pane('vscode'))
    expect((await ui.find({ key: `setup:hook:${hid('resource-guard.cjs', 'PreToolUse')}` }))?.props.label).toBe('☑ resource-guard')
    expect(await texts(ui, new RegExp(`^${TAB_LABEL.hook} · PreToolUse \\(Bash\\)$`))).toBeDefined()
    expect((await ui.find({ key: 'setup:rule:/h/team/rules.md' }))?.props.label).toBe('☑ rules.md')
    expect(await texts(ui, new RegExp(`^${TAB_LABEL.rule} · /h/team/rules\\.md$`))).toBeDefined()
    expect(await texts(ui, /not found here/)).toBeUndefined()
  })

  test('Confirm writes exactly the ticked ones, shows them protected, and the guide is done', async ($, on) => {
    const m = fresh(on)
    const before = new Set(m.files.keys())
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    const keys = [...(await proposed(m)).keys()]
    const off = `hook:${hid('delete-guard.sh', 'PreToolUse')}`
    await ui.press({ key: `setup:${off}` })
    await ui.press({ key: 'setup-confirm' })
    expect(m.json(PROTECTED)).toEqual(list(keys.filter((k) => k !== off)))
    expect([...m.files.keys()].filter((p) => !before.has(p))).toEqual([PROTECTED])
    expect([...m.fs.dirs]).toEqual([])
    expect(m.touched).toEqual([])
    expect(await isList(ui)).toBe(true)
    expect((await texts(ui, new RegExp(`^${keys.length - 1} protected items`)))?.props.color).toBe('success')
    await ui.press({ key: 'tab:hook' })
    await ui.press({ key: `name:${off}` })
    expect(await texts(ui, /^Protected: /)).toBeUndefined()
    await ui.press({ key: 'detail-close' })
    await ui.press({ key: `name:hook:${hid('resource-guard.cjs', 'PreToolUse')}` })
    expect(await texts(ui, /^Protected: /)).toBeDefined()
    await open($)
    expect(await isList(ui)).toBe(true)
  })

  test('Skip protects nothing, and is remembered', async ($, on) => {
    const m = fresh(on)
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    await ui.press({ key: 'setup-skip' })
    expect(m.json(PROTECTED)).toEqual(list([]))
    expect(await texts(ui, /\/plancia setup/)).toBeDefined()
    expect(await isList(ui)).toBe(true)
    await open($)
    expect(await isList(ui)).toBe(true)
  })

  test('no configuration at all: an empty guide, no error; Confirm works', async ($, on) => {
    const m = fresh(on)
    m.files.clear()
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    expect(await isGuide(ui)).toBe(true)
    expect(await texts(ui, /No PreToolUse hook and no rule file found/)).toBeDefined()
    expect([...m.files]).toEqual([])
    await ui.press({ key: 'setup-confirm' })
    expect([...m.files.keys()]).toEqual([PROTECTED])
    expect(m.json(PROTECTED)).toEqual(list([]))
    expect(await isList(ui)).toBe(true)
  })

  test('reset and reset --all are what they say, not the guide, before and after the click', async ($, on) => {
    fresh(on)
    await open($, 'reset')
    const ui = await $.ui.mount(pane('terminal'))
    await ui.press({ key: 'reset-confirm' })
    expect(await isList(ui)).toBe(true)
    await open($, 'reset --all')
    expect(await ui.find({ key: 'reset-cancel' })).toBeDefined()
    expect(await ui.find({ key: 'setup-confirm' })).toBeUndefined()
  })

  test('a broken state.json is said first; once readable, the guide', async ($, on) => {
    const m = fresh(on, { files: { [STATE]: '{ nope' } })
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    expect(await ui.find({ key: 'setup-confirm' })).toBeUndefined()
    m.files.delete(STATE)
    await ui.press({ key: 'retry' })
    expect(await isGuide(ui)).toBe(true)
  })
})

describe('/plancia setup', () => {
  const GONE = 'rule:/h/gone/CLAUDE.md'

  test('the current values; an item that is gone shows, stays if left ticked, goes if unticked', async ($, on) => {
    const m = machine(on, { files: { [PROTECTED]: JSON.stringify(list([...LISTED, GONE, 'skill:alpha'])) } })
    const ui = await $.ui.mount(pane('terminal'))
    await open($, 'setup')
    expect(await isGuide(ui)).toBe(true)
    const all = setupChoices((await readInventory(ctx(m.fs))).items, [...LISTED, GONE, 'skill:alpha'])
    expect([...all.values()]).toContain(false)
    expect(await boxes(ui, all.keys())).toEqual([...all])
    expect((await ui.find({ key: `setup:${GONE}` }))?.props.label).toBe(`☑ ${GONE}`)
    expect(await texts(ui, /^not found here/)).toBeDefined()
    expect((await ui.find({ key: 'setup:skill:alpha' }))?.props.label).toBe('☑ alpha')
    await ui.press({ key: 'setup-confirm' })
    expect([...m.json(PROTECTED).protected].sort()).toEqual([...LISTED, GONE, 'skill:alpha'].sort())
    await open($, 'setup')
    await ui.press({ key: `setup:${GONE}` })
    await ui.press({ key: 'setup:rule:/h/CLAUDE.md' })
    await ui.press({ key: 'setup-confirm' })
    expect([...m.json(PROTECTED).protected].sort()).toEqual([...LISTED, 'skill:alpha', 'rule:/h/CLAUDE.md'].sort())
  })

  test('a protected hook whose command changed, one that is gone: said in the pane and in the guide, where Confirm settles it', async ($, on) => {
    const settings = userSettings() as any
    settings.hooks.PreToolUse[0].hooks[0].command += ' --strict'
    const now = `hook:${hookId('PreToolUse', settings.hooks.PreToolUse[0].hooks[0])}`
    const was = `hook:${hid('resource-guard.cjs', 'PreToolUse')}`
    const lost = 'hook:gone.sh#0123456789abcdef:Stop'
    const m = machine(on, { files: { [`${HOME}/.claude/settings.json`]: JSON.stringify(settings), [PROTECTED]: JSON.stringify(list([...LISTED, lost])) } })
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    expect((await texts(ui, /^Warning: The protected hook .*resource-guard\.cjs \(PreToolUse\) changed.*\/plancia setup/))?.props.color).toBe('warning')
    expect(await texts(ui, /gone\.sh \(Stop\) is no longer in your settings/)).toBeDefined()
    // switching the new one off asks the extra confirmation
    await ui.press({ key: 'tab:hook' })
    await ui.press({ key: `toggle:${now}` })
    await ui.press({ key: 'make-default' })
    expect(await ui.find({ key: 'protected-ok' })).toBeDefined()
    await ui.press({ key: 'cancel' })
    await open($, 'setup')
    expect((await texts(ui, /^The protected hook resource-guard\.cjs \(PreToolUse\) changed/))?.props.color).toBe('warning')
    expect(await boxes(ui, [now, lost])).toEqual([[now, true], [lost, true]])
    expect(await ui.find({ key: `setup:${was}` })).toBeUndefined()
    expect(await texts(ui, /^no longer in your settings$/)).toBeDefined()
    await ui.press({ key: `setup:${lost}` })
    await ui.press({ key: 'setup-confirm' })
    expect([...m.json(PROTECTED).protected].sort()).toEqual([...LISTED.filter((k) => k !== was), now].sort())
    expect(await isList(ui)).toBe(true)
    expect(await texts(ui, /^Warning: /)).toBeUndefined()
  })

  test('Cancel writes nothing', async ($, on) => {
    const m = machine(on)
    const before = [...m.files]
    await open($, 'setup')
    const ui = await $.ui.mount(pane('terminal'))
    expect(await ui.find({ key: 'setup-skip' })).toBeUndefined()
    await ui.press({ key: `setup:${LISTED[0]}` })
    await ui.press({ key: 'setup-cancel' })
    expect(await isList(ui)).toBe(true)
    expect([...m.files]).toEqual(before)
  })

  test('a protected.json that is not valid: the guide says so and offers to make it again; Cancel leaves it as it is', async ($, on) => {
    const m = machine(on, { files: { [PROTECTED]: '{ nope' } })
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    expect(await isList(ui)).toBe(true)
    expect((await texts(ui, /\/plancia setup/))?.props.color).toBe('warning')
    await open($, 'setup')
    expect((await texts(ui, /protected\.json is not valid/))?.props.color).toBe('warning')
    expect(await ui.find({ key: 'setup-skip' })).toBeUndefined()
    await ui.press({ key: 'setup-cancel' })
    expect(m.files.get(PROTECTED)).toBe('{ nope')
    await open($, 'setup')
    const all = await proposed(m)
    expect(await boxes(ui, all.keys())).toEqual([...all])
    await ui.press({ key: 'setup-confirm' })
    expect(m.json(PROTECTED)).toEqual(list([...all.keys()]))
    expect(await texts(ui, /not valid/)).toBeUndefined()
  })

  test('another window set it up meanwhile: nothing written, the guide shows what it chose and says so', async ($, on) => {
    const m = fresh(on)
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    // a key of another project: no item here changes with it
    await writeProtected(m.fs, DIRS.state, [GONE])
    for (const button of ['setup-skip', 'setup-confirm']) {
      if (button === 'setup-confirm') m.files.set(PROTECTED, JSON.stringify(list([GONE, LISTED[0]!])))
      const before = [...m.files]
      await ui.press({ key: button })
      expect([...m.files]).toEqual(before)
      expect((await texts(ui, new RegExp(CHANGED)))?.props.color).toBe('warning')
      expect(await isGuide(ui)).toBe(true)
      expect(await boxes(ui, [GONE, LISTED[1]!])).toEqual([[GONE, true], [LISTED[1], false]])
    }
  })

  test('the write fails: Confirm stays on the guide with the ticks, Skip lets through; both say so', async ($, on) => {
    const m = fresh(on)
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    m.files.set(`${lockPath(DIRS.state)}/${Date.now()}-other`, '')
    const before = [...m.files]
    await ui.press({ key: `setup:${LISTED[0]}` })
    await ui.press({ key: 'setup-confirm' })
    expect((await texts(ui, /nothing was written/))?.props.color).toBe('warning')
    expect(await isGuide(ui)).toBe(true)
    expect(await boxes(ui, [LISTED[0]!])).toEqual([[LISTED[0], false]])
    await ui.press({ key: 'setup-skip' })
    expect((await texts(ui, /nothing was written/))?.props.color).toBe('warning')
    expect(await isList(ui)).toBe(true)
    expect([...m.files]).toEqual(before)
  })

  test('a /clear leaves the guide open and undone', async ($, on) => {
    const m = fresh(on)
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    await $.command.run({ command: 'clear', args: '' } as any)
    expect(await isGuide(ui)).toBe(true)
    expect(m.files.has(PROTECTED)).toBe(false)
  })
})

describe('an agent', () => {
  test('cannot complete the guide: no argument writes, no tool does it, the file is behind the guard', async ($, on) => {
    const m = fresh(on)
    const before = [...m.files]
    for (const args of ['', 'setup', 'setup confirm', 'setup --yes', 'setup skip', 'confirm', 'skip']) await open($, args)
    for (const tool of ['Write', 'Edit'])
      expect(JSON.stringify(await $.tool.call({ tool, file_path: `${HOME}/.config/plancia/protected.json`, content: '{}', old_string: 'a', new_string: 'b' } as any))).toMatch(/Plancia/)
    expect(m.toolCalls).toEqual([])
    expect([...m.files]).toEqual(before)
    expect(m.registeredTools).toEqual([])
  })

  for (const target of ['apply', 'make-default']) {
    test(`cannot switch protected items off by ${target} of Minimal: the click asks one more, with how many and which`, async ($, on) => {
      const m = machine(on)
      const before = [...m.files]
      for (const args of ['Minimal', 'apply Minimal', 'default Minimal']) await open($, args)
      await open($)
      const ui = await $.ui.mount(pane('terminal'))
      await ui.press({ key: 'preset:Minimal' })
      await ui.press({ key: target })
      expect(await ui.find({ key: 'confirm' })).toBeUndefined()
      // every protected item, the importer of a protected rule included
      const { items } = await readInventory(ctx(m.fs))
      const names = items.filter((i) => i.protected && i.on).map((i) => ({ k: itemKey(i), n: i.name })).sort((a, b) => (a.k < b.k ? -1 : 1))
      expect(names.length).toBe(LISTED.length + 1)
      const red = await texts(ui, /^Protected items being switched off/)
      expect(red?.props.color).toBe('error')
      const said = String(JSON.stringify(red))
      expect(said).toContain(`(${names.length}): `)
      for (const { n } of names) expect(said).toContain(n)
      expect((await ui.find({ key: 'protected-ok' }))?.props.label).toBe(`☐ I confirm: switch off ${names.length} protected items`)
      expect([...m.files]).toEqual(before)
      await ui.press({ key: 'protected-ok' })
      expect((await ui.find({ key: 'protected-ok' }))?.props.label).toBe(`☑ I confirm: switch off ${names.length} protected items`)
      await ui.press({ key: 'confirm' })
      expect(m.files.has(STATE)).toBe(true)
    })
  }

  test('the extra confirmation never outlives what it was given for: a /resume meanwhile unticks it', async ($, on) => {
    const other = 'bbbbbbbb-0000-4000-8000-000000000002'
    const ss = { root: ROOT, preset: 'X', desired: { [`hook:${hid('delete-guard.sh', 'PreToolUse')}`]: false }, hooksOff: [hid('delete-guard.sh', 'PreToolUse')], updatedAt: new Date().toISOString() }
    machine(on, { files: { [STATE]: JSON.stringify({ version: 1, projects: {}, sessions: { [other]: ss } }) } })
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    await ui.press({ key: 'tab:hook' })
    await ui.press({ key: `toggle:hook:${hid('resource-guard.cjs', 'PreToolUse')}` })
    await ui.press({ key: 'make-default' })
    await ui.press({ key: 'protected-ok' })
    expect(await ui.find({ key: 'confirm' })).toBeDefined()
    await $.command.run({ command: 'resume', args: other } as any)
    expect(await texts(ui, /^Protected items being switched off.*delete-guard/)).toBeDefined()
    expect(await ui.find({ key: 'confirm' })).toBeUndefined()
  })
})

describe('Minimal', () => {
  test('locked items stay as they are and no message makes it an error; made default, Plancia stays on', async ($, on) => {
    const m = machine(on)
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    await ui.press({ key: 'preset:Minimal' })
    expect((await ui.find({ key: 'preset:Minimal' }))?.props.variant).toBe('primary')
    expect(await texts(ui, /^No unsaved changes$/)).toBeDefined()
    expect(await ui.find({ key: 'notice' })).toBeUndefined()
    const { items } = await readInventory(ctx(m.fs))
    for (const c of ['agent', 'mcp', 'hook'] as const) {
      await ui.press({ key: `tab:${c}` })
      for (const i of items.filter((x) => x.category === c && x.locked)) expect(await ui.find({ key: `toggle:${itemKey(i)}` })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: /◆/ })).toBeUndefined()
    }
    await ui.press({ key: 'make-default' })
    for (const i of items.filter((x) => x.locked)) expect(await texts(ui, new RegExp(`(Switching on|Switching off).*${i.name === 'compressor-gate' ? 'SessionStart' : i.name}`))).toBeUndefined()
    await ui.press({ key: 'protected-ok' })
    await ui.press({ key: 'confirm' })
    expect(m.files.get(LOCAL)).not.toMatch(/plancia|disableAllHooks|Gmail|blocked-agent/)
    expect(m.json(LOCAL).enabledPlugins).toEqual({ 'pa@m': false })
    expect(m.json(STATE).projects[ROOT].hooksOff.filter((h: string) => h.endsWith(':SessionStart'))).toEqual([])
    expect(await texts(ui, /^No unsaved changes$/)).toBeDefined()
  })
})
