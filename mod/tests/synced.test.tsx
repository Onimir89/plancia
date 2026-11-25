// Plugins synced from claude.ai in the pane.
import { describe, expect } from 'claude-code/testing'
import { LOCAL, ROOT, SID, STATE, band, machine, pane, test } from './harness.ts'
import { SYNCED } from '../../spec/fixture.ts'

const start = async ($: any, on: any) => {
  const m = machine(on, { files: SYNCED })
  await $.command.run({ command: 'plancia', args: '' })
  const ui = await $.ui.mount(pane('terminal'))
  await ui.press({ key: 'tab:plugin' })
  return { m, ui }
}

describe('plugins synced from claude.ai', () => {
  test('listed and counted; the one the organization requires is on, without a switch, and says why', async ($, on) => {
    const { ui } = await start($, on)
    expect((await ui.find({ key: 'tab:plugin' }))?.props.label).toContain('4/6')
    expect((await ui.find({ key: 'toggle:plugin:data@synced' }))?.props.label).toBe('on')
    expect(await ui.find({ key: 'toggle:plugin:must@synced' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /your organization requires it/ })).toBeDefined()
  })

  // Seen live (2.1.332, real login): they stay loaded whatever the chat's merge says, and go with an entry in the file.
  test('Apply never switches them, the summary and the tab say so; the choice and the band count the others only', async ($, on) => {
    const { m, ui } = await start($, on)
    expect(await ui.find({ type: 'Text', text: /^Plugins synced from claude\.ai are set for the whole project: change them with Make default\.$/ })).toBeDefined()
    await ui.press({ key: 'toggle:plugin:data@synced' })
    await ui.press({ key: 'apply' })
    expect(await ui.find({ type: 'Text', text: /^Stay as in the project default \(agents, .*plugins synced from claude\.ai change with Make default\): data$/ })).toBeDefined()
    expect(await ui.find({ key: 'confirm' })).toBeUndefined()
    await ui.press({ key: 'cancel' })
    await ui.press({ key: 'preset:Minimal' })
    await ui.press({ key: 'apply' })
    await ui.press({ key: 'protected-ok' })
    await ui.press({ key: 'confirm' })
    const { desired } = m.json(STATE).sessions[SID]
    expect(Object.keys(desired).filter((k) => k.startsWith('plugin:'))).toEqual(['plugin:pa@m'])
    expect((await ui.find({ key: 'toggle:plugin:data@synced' }))?.props.label).toBe('on')
    const row = await $.ui.mount(band('terminal'))
    expect(await row.find({ type: 'Text', text: new RegExp(` · ${Object.keys(desired).length} off$`) })).toBeDefined()
  })

  test('no synced plugin, no note', async ($, on) => {
    machine(on)
    await $.command.run({ command: 'plancia', args: '' } as any)
    const ui = await $.ui.mount(pane('terminal'))
    await ui.press({ key: 'tab:plugin' })
    expect(await ui.find({ type: 'Text', text: /are set for the whole project/ })).toBeUndefined()
  })

  test('Make default writes the entry, shows it off; reset takes it back', async ($, on) => {
    const { m, ui } = await start($, on)
    await ui.press({ key: 'toggle:plugin:data@synced' })
    await ui.press({ key: 'make-default' })
    await ui.press({ key: 'confirm' })
    expect(m.json(LOCAL)).toEqual({ enabledPlugins: { 'data@synced': false } })
    expect((await ui.find({ key: 'toggle:plugin:data@synced' }))?.props.label).toBe('off')
    expect(m.commands).toEqual(['reload-plugins'])
    await $.command.run({ command: 'plancia', args: 'reset' } as any)
    await ui.press({ key: 'reset-confirm' })
    expect(m.files.has(LOCAL)).toBe(false)
    expect(m.json(STATE).projects[ROOT]).toBeUndefined()
  })
})
