// Another window writes while this pane does, between its check of the disk and its write.
import { describe, expect } from 'claude-code/testing'
import { hid, DIRS, LOCAL, PANEL, PRESETS, ROOT, SID, STATE, ctx, machine, pane, test, type Machine } from './harness.ts'
import { applyPatch, compile, deletePreset, itemKey, lockPath, readInventory, savePreset, DEFAULT, LOCK } from '../../src/core/index.ts'

const HOOK = hid('resource-guard.cjs', 'PreToolUse')
const OFF = JSON.stringify({ version: 1, sessions: {}, projects: { [ROOT]: { preset: 'X', appliedAt: 'x', entries: [], hooksOff: [HOOK], createdPaths: [] } } })
const open = async ($: any) => {
  await $.command.run({ command: 'plancia', args: '' })
  return $.ui.mount(pane('terminal'))
}
/** `write` at the pane's first write, its lock apart; told to try again, the other window does, once the pane is done. Its outcome. */
function meanwhile(m: Machine, write: () => Promise<unknown>) {
  let first: Promise<string> | undefined
  m.beforeWrite = async (path) => {
    if (path.startsWith(lockPath(DIRS.state))) return
    first ??= write().then(() => 'written', (e) => String(e))
    await first
  }
  return async () => {
    const said = await first
    if (said !== 'written') await write()
    return said
  }
}
const everythingOn = (m: Machine) => async () => {
  const c = ctx(m.fs)
  const { items } = await readInventory(c)
  await applyPatch(c, compile(items, new Map(items.map((i) => [itemKey(i), i.on]))), { preset: DEFAULT, now: new Date() })
}
const BUSY = /another Plancia window is writing.*nothing was written/

describe('two windows at once', () => {
  for (const target of ['apply', 'make-default']) {
    test(`${target}: the protected hook the other window switches back on is not lost`, async ($, on) => {
      const m = machine(on, { files: { [STATE]: OFF } })
      const ui = await open($)
      await ui.press({ key: 'toggle:skill:alpha' })
      await ui.press({ key: target })
      const other = meanwhile(m, everythingOn(m))
      await ui.press({ key: 'confirm' })
      const said = await other()
      const st = m.json(STATE)
      expect(st.projects[ROOT].hooksOff).toEqual([])
      expect(Object.values<any>(st.sessions).flatMap((s) => [...s.hooksOff, ...Object.keys(s.desired)])).toEqual(target === 'apply' ? ['skill:alpha'] : [])
      // the other window was told to try again, and what it did then holds for the chat that had carried the hook off
      expect(said).toMatch(BUSY)
      expect([...m.files.keys()].filter((p) => p.startsWith(DIRS.state) && /lock|tmp/.test(p))).toEqual([])
      expect([...m.fs.dirs]).toEqual([])
    })
  }

  test('save as, with a preset deleted by the other window: both hold', async ($, on) => {
    const m = machine(on)
    await savePreset(m.fs, DIRS.state, { name: 'Old', parent: DEFAULT, enable: [], disable: [] })
    const ui = await open($)
    await ui.press({ key: 'toggle:skill:alpha' })
    await ui.press({ key: 'save-as' })
    const other = meanwhile(m, () => deletePreset(m.fs, DIRS.state, 'Old'))
    await ui.input({ key: 'save-name', text: 'New' })
    const said = await other()
    expect(m.json(PRESETS).presets.map((p: any) => p.name)).toEqual(['New'])
    expect(said).toMatch(BUSY)
  })

  const confirmed = (target: string) => async (ui: any) => {
    await ui.press({ key: 'toggle:skill:alpha' })
    await ui.press({ key: target })
    await ui.press({ key: 'confirm' })
  }
  const command = (args: string, key: string) => async (ui: any, $: any) => {
    await $.command.run({ command: 'plancia', args })
    await ui.press({ key })
  }
  const WRITES: Record<string, ((ui: any, $: any) => Promise<unknown>) | null> = {
    'rows-up': (ui) => ui.press({ key: 'rows-up' }),
    apply: confirmed('apply'),
    'make-default': confirmed('make-default'),
    'save-as': async (ui) => {
      await ui.press({ key: 'toggle:skill:alpha' })
      await ui.press({ key: 'save-as' })
      await ui.input({ key: 'save-name', text: 'New' })
    },
    save: async (ui) => {
      await ui.press({ key: 'preset:P' })
      await ui.press({ key: 'toggle:skill:alpha' })
      await ui.press({ key: 'save' })
    },
    'preset-delete': async (ui) => {
      await ui.press({ key: 'preset:P' })
      await ui.press({ key: 'preset-delete' })
      await ui.press({ key: 'delete-confirm' })
    },
    reset: command('reset', 'reset-confirm'),
    'reset --all': command('reset --all', 'reset-all-confirm'),
    setup: command('setup', 'setup-confirm'),
    '/clear': null, // says nothing
  }
  const CHAT = { root: ROOT, preset: 'X', desired: { 'skill:alpha': false }, hooksOff: [], updatedAt: new Date().toISOString() }
  for (const [name, write] of Object.entries(WRITES)) {
    test(`the other window holds the lock: ${name} waits, then ${write ? 'says so and ' : ''}writes nothing; the lock stays its own`, async ($, on) => {
      const state = { ...JSON.parse(OFF), sessions: write ? {} : { [SID]: CHAT } }
      const m = machine(on, { files: { [PRESETS]: JSON.stringify({ version: 1, presets: [{ name: 'P', parent: DEFAULT, enable: [], disable: [] }] }), [STATE]: JSON.stringify(state) } })
      const ui = await open($)
      m.files.set(`${lockPath(DIRS.state)}/${Date.now()}-other`, '')
      const before = [...m.files]
      let waits = 0
      m.beforeSleep = async () => { waits++ }
      if (write) await write(ui, $)
      else await $.command.run({ command: 'clear', args: '' } as any)
      expect(waits).toBe(LOCK.polls)
      if (write) expect(await ui.find({ type: 'Text', text: BUSY })).toBeDefined()
      expect([...m.files]).toEqual(before)
    })
  }

  test('a /clear without a choice of the chat makes nothing, not even the state folder', async ($, on) => {
    const m = machine(on)
    const before = [...m.files]
    const writes: string[] = []
    m.beforeWrite = async (p) => { writes.push(p) }
    await $.command.run({ command: 'clear', args: '' } as any)
    expect(writes).toEqual([])
    expect([...m.files]).toEqual(before)
  })
})
