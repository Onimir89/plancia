// The configuration of one chat, on the fake machine of harness.ts.
import { describe, expect } from 'claude-code/testing'
import { ctx, hid, DIRS, HOME, LOCAL, NEXT_SID, ROOT, SID, STATE, band, machine, pane, test, type Machine } from './harness.ts'
import { applyPatch, atomicWrite, compile, hookId, itemKey, lockPath, readInventory } from '../../src/core/index.ts'
import { countMerge, fsOf, mergeAfter, mergeCount, mergeOfEngine, touchLocal } from '../adapter.ts'
import { CHANGED, MODIFIED, NOT_READ, WHEN_CHAT } from '../pane.tsx'

const open = async ($: any, args = '') => {
  await $.command.run({ command: 'plancia', args })
}
const texts = async (ui: any, re: RegExp) => ui.find({ type: 'Text', text: re })
const USER_SETTINGS = `${HOME}/.claude/settings.json`
const OTHER_SID = 'bbbbbbbb-0000-4000-8000-000000000002'
const AT = '2026-11-22T09:00:00.000Z'
const chat = (over: Record<string, unknown> = {}) => ({ root: ROOT, preset: 'Mine', desired: { 'skill:alpha': false }, hooksOff: [], updatedAt: new Date().toISOString(), ...over })
const stateOf = (projects: Record<string, unknown>, sessions: Record<string, unknown>) => JSON.stringify({ version: 1, projects, sessions })
const project = (over: Record<string, unknown> = {}) => ({ preset: 'D', appliedAt: AT, entries: [], hooksOff: [], createdPaths: [], ...over })
// A plugin that reads the merged settings, as another mod may at every render: no merge of the engine's.
const bandReader = {
  name: 'band-reader',
  register(on: any) {
    on('command.run', { command: 'merge-now' }, async ($: any) => {
      await $.settings.read().catch(() => undefined)
      return {}
    })
  },
}
const toolReader = {
  name: 'tool-reader',
  register(on: any) {
    on('command.run', { command: 'tools-now' }, async ($: any) => ({ text: (await $.tool.list()).map((t: any) => t.name).join(' ') }))
  },
}
const applyForChat = async (ui: any) => {
  await ui.press({ key: 'apply' })
  await ui.press({ key: 'confirm' })
}

describe('Apply, for this chat', () => {
  test('writes only the choice of this chat, creates the missing local as {}, no reload without plugins', async ($, on) => {
    const m = machine(on)
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    await ui.press({ key: 'toggle:skill:alpha' })
    await ui.press({ key: 'tab:mcp' })
    await ui.press({ key: 'toggle:mcp:u1' })
    await ui.press({ key: 'apply' })
    expect(await texts(ui, /to this chat/)).toBeDefined()
    // when each change takes effect in a running chat
    expect(await texts(ui, new RegExp(`^${WHEN_CHAT.skill}: alpha$`))).toBeDefined()
    expect(await texts(ui, new RegExp(`^${WHEN_CHAT.mcp}: u1$`))).toBeDefined()
    expect(await texts(ui, /then touches .*settings\.local\.json \(content unchanged; created as \{\} if missing\)/)).toBeDefined()
    expect(m.files.has(STATE)).toBe(false)
    await ui.press({ key: 'confirm' })
    const st = m.json(STATE)
    expect(st.projects).toEqual({})
    expect(Object.keys(st.sessions)).toEqual([SID])
    const ss = st.sessions[SID]
    expect({ ...ss, updatedAt: typeof ss.updatedAt }).toEqual({
      root: ROOT, preset: `Default${MODIFIED}`, desired: { 'skill:alpha': false, 'mcp:u1': false }, hooksOff: [], updatedAt: 'string',
    })
    expect(m.files.get(LOCAL)).toBe('{}\n')
    expect(m.commands).toEqual([])
    expect(m.toolCalls).toEqual([])
    expect(m.toasts.join(' ')).toMatch(/applied "Default \(modified\)" to this chat/)
    // the header says it, with the short id
    expect(await texts(ui, /^This chat: "Default \(modified\)", applied .* · id aaaaaaaa$/)).toBeDefined()
    expect(await texts(ui, /^Project default: none, your own configuration is in use\.$/)).toBeDefined()
  })

  // Seen live on 2.1.331: a connected server stays connected when the chat's settings deny it, so its tools leave the list here.
  test("the tools of the servers switched off for this chat leave the chat's tool list", { plugins: [toolReader] }, async ($, on) => {
    const names = ['Bash', 'mcp__u1__ping', 'mcp__u1x__ping', 'mcp__loc1__ping', 'mcp__claude_ai_Gmail_x__send', 'mcp__u1']
    on('tool.list', () => ({ value: names.map((name) => ({ name, description: '', mcp: name !== 'Bash' })) }))
    const desired = { 'mcp:u1': false, 'mcp:loc1': true, 'mcp:claude.ai Gmail (x)': false, 'skill:alpha': false }
    const m = machine(on, { files: { [STATE]: stateOf({}, { [SID]: chat({ desired }) }) } })
    const listed = async () => (await $.command.run({ command: 'tools-now', args: '' } as any) as any).text.split(' ')
    expect(await listed()).toEqual(['Bash', 'mcp__u1x__ping', 'mcp__loc1__ping', 'mcp__u1'])
    // another chat, then a state that cannot be used: the list as it is
    m.sid = OTHER_SID
    expect(await listed()).toEqual(names)
    m.sid = SID
    m.files.set(STATE, '{broken')
    expect(await listed()).toEqual(names)
  })

  test('a server whose name begins with the name of one switched off keeps its tools', { plugins: [toolReader] }, async ($, on) => {
    const names = ['Bash', 'mcp__u1__ping', 'mcp__u1__two__ping', 'mcp__u1__more__ping', 'mcp__u1__more__deep__ping', 'mcp__u1__more_x__ping']
    on('tool.list', () => ({ value: names.map((name) => ({ name, description: '', mcp: true })) }))
    const files = { [`${ROOT}/.mcp.json`]: JSON.stringify({ mcpServers: { u1__more: { command: 'a' }, 'u1__more__deep': { command: 'b' } } }) }
    const listed = async () => (await $.command.run({ command: 'tools-now', args: '' } as any) as any).text.split(' ')
    const m = machine(on, { files: { ...files, [STATE]: stateOf({}, { [SID]: chat({ desired: { 'mcp:u1': false } }) }) } })
    expect(await listed()).toEqual(['Bash', 'mcp__u1__more__ping', 'mcp__u1__more__deep__ping'])
    m.files.set(STATE, stateOf({}, { [SID]: chat({ desired: { 'mcp:u1__more': false } }) }))
    expect(await listed()).toEqual(['Bash', 'mcp__u1__ping', 'mcp__u1__two__ping', 'mcp__u1__more__deep__ping', 'mcp__u1__more_x__ping'])
    m.files.set(STATE, stateOf({}, { [SID]: chat({ desired: { 'mcp:u1': false, 'mcp:u1__more__deep': false } }) }))
    expect(await listed()).toEqual(['Bash', 'mcp__u1__more__ping'])
    // the servers cannot be told: what the name says
    m.files.set(`${ROOT}/.mcp.json`, '{ nope')
    expect(await listed()).toEqual(['Bash'])
  })

  test('the summary says what was seen live: MCP from the next message; its buttons come before the long lists', async ($, on) => {
    machine(on)
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    await ui.press({ key: 'tab:mcp' })
    await ui.press({ key: 'toggle:mcp:u1' })
    await ui.press({ key: 'apply' })
    expect(await texts(ui, /^From your next message: u1$/)).toBeDefined()
    expect(await texts(ui, /^Now: /)).toBeUndefined()
    const drawn = JSON.stringify(await $.ui.render(pane('terminal') as any))
    expect(drawn.indexOf('"confirm"')).toBeGreaterThan(0)
    expect(drawn.indexOf('"confirm"')).toBeLessThan(drawn.indexOf('Switching off'))
  })

  test('the tool list is asked again after Apply and after /resume', async ($, on) => {
    const asked: string[] = []
    on('ui.invalidate', ($, e, next) => {
      asked.push(e.event)
      return next(e)
    })
    const m = machine(on)
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    await ui.press({ key: 'tab:mcp' })
    await ui.press({ key: 'toggle:mcp:u1' })
    await ui.press({ key: 'apply' })
    expect(asked.includes('tool.list')).toBe(false)
    await ui.press({ key: 'confirm' })
    expect(asked.filter((x) => x === 'tool.list')).toEqual(['tool.list'])
    await $.command.run({ command: 'resume', args: OTHER_SID } as any)
    expect(m.sid).toBe(OTHER_SID)
    expect(asked.filter((x) => x === 'tool.list')).toEqual(['tool.list', 'tool.list'])
  })

  test('an existing local is only touched, its content unchanged; with no merge after it, the settings of the user too', async ($, on) => {
    const m = machine(on, { files: { [LOCAL]: '{"foo":1}' } })
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    const own = m.files.get(USER_SETTINGS)
    await ui.press({ key: 'toggle:skill:alpha' })
    await applyForChat(ui)
    expect(m.touched).toEqual([LOCAL, USER_SETTINGS])
    expect([m.files.get(LOCAL), m.files.get(USER_SETTINGS)]).toEqual(['{"foo":1}', own])
  })

  const pluginOff = async (ui: any) => {
    await ui.press({ key: 'tab:plugin' })
    await ui.press({ key: 'toggle:plugin:pa@m' })
    await ui.press({ key: 'apply' })
  }

  /** How long the mod has slept since with no command run yet; `at` runs in each sleep, with the time so far. */
  const wait = (m: Machine, at: (ms: number) => Promise<void> = async () => {}) => {
    let slept = 0
    m.beforeSleep = async (ms) => {
      if (!m.commands.length) slept += ms
      await at(slept)
    }
    return () => slept
  }

  // The bench cannot raise the engine's own merge (its $ has no settings noun, no plugin may be named engine):
  // which reads count is tested on mergeOfEngine, the wiring by the plugin's read that must not count.
  test("only the engine's own merge counts, never a plugin's read nor a read of one source", () => {
    expect(mergeOfEngine({ layers: [] } as any, { plugin: 'engine', tier: 'core' })).toBe(true)
    expect(mergeOfEngine({ layers: [] } as any, { plugin: 'other', tier: 'user' })).toBe(false)
    expect(mergeOfEngine({ source: 'local', layers: [] } as any, { plugin: 'engine', tier: 'core' })).toBe(false)
  })

  test("a plugin's read of the settings during the wait is no merge: the reload waits, at most 8.5 s", { plugins: [bandReader] }, async ($, on) => {
    const m = machine(on)
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    await pluginOff(ui)
    expect(await texts(ui, new RegExp(`^${WHEN_CHAT.plugin}: pa$`))).toBeDefined()
    const waited = wait(m, async (ms) => {
      // as another mod's band, at every render
      if (ms === 300) await $.command.run({ command: 'merge-now', args: '' } as any)
    })
    await ui.press({ key: 'confirm' })
    expect([waited(), m.commands]).toEqual([8500, ['reload-plugins']])
    expect(m.json(STATE).sessions[SID].desired).toEqual({ 'plugin:pa@m': false })
  })

  // Seen live (2.1.332): the engine does not watch a .claude removed and made again during the session.
  // [it comes, after, waited, the user's file touched after, slept before in the lock]; a touch that fails ends no wait
  for (const [came, at, ms, touched, lock] of [[true, 1200, 1200, 0, 0], [true, 5000, 5000, 4300, 0], [false, 0, 8500, 4300, 0], [false, 0, 6000, 3000, 2500]] as const) {
    test(`the merge after a write, ${came ? `come after ${at} ms` : 'never come'}, ${lock} ms gone in the lock: ${touched ? "half-way the user's settings file is touched" : 'nothing else touched'}`, async () => {
      let slept = 0
      const runs: unknown[] = []
      const $ = {
        clock: { sleep: async (n: number) => { if ((slept += n) === at) countMerge() } },
        process: { run: async (argv: string[]) => { runs.push([slept, ...argv]); throw new Error('no touch') } },
      }
      const press = { local: LOCAL, slept: lock, before: mergeCount() }
      expect([await mergeAfter($ as any, press as any, `${HOME}/.claude`), slept]).toEqual([came, ms])
      expect(runs).toEqual(touched ? [[touched, 'touch', '-c', '--', USER_SETTINGS]] : [])
    })
  }

  // One before it (another settings file, the wait for the lock) is not the write's own; one that comes while it is made is.
  for (const link of [false, true]) {
    test(`the merge to wait for is counted from right before this project's local file changes${link ? ', a link' : ''}`, async () => {
      const changes = ['mv', 'rm', 'touch']
      const file = link ? '/h/elsewhere.json' : LOCAL
      const $: any = {
        process: {
          run: async (argv: string[]) => {
            if (changes.includes(argv[0]!)) countMerge()
            return { exitCode: argv[0] === 'readlink' && !(link && argv.at(-1) === LOCAL) ? 1 : 0, stdout: `${file}\n`, stderr: '' }
          },
        },
        fs: { read: async () => '{}', write: async () => undefined },
      }
      const count = async (write: (fs: ReturnType<typeof fsOf>, press: any) => Promise<unknown>) => {
        const press: any = { local: LOCAL, slept: 0 }
        const fs = (fsOf as any)($, DIRS.state, press)
        countMerge()
        const at = mergeCount()
        await write(fs, press)
        return press.before === undefined ? null : press.before - at
      }
      expect(await count((fs) => atomicWrite(fs, LOCAL, '{}'))).toBe(0)
      expect(await count((fs) => fs.remove(LOCAL))).toBe(0)
      expect(await count((fs, press) => (touchLocal as any)($, fs, ROOT, true, press))).toBe(0)
      // what another project's file, the state or the folder's own temporaries change is no write of this one
      expect(await count((fs) => atomicWrite(fs, STATE, '{}'))).toBe(null)
      expect(await count((fs) => atomicWrite(fs, '/h/elsewhere/.claude/settings.local.json', '{}'))).toBe(null)
      expect(await count((fs) => fs.remove('/h/elsewhere/.claude/settings.local.json'))).toBe(null)
      expect(await count((fs) => fs.remove(`${LOCAL}.a-1.plancia-tmp`))).toBe(null)
    })
  }

  const notRead = async (ui: any, m: Machine) => [!!(await texts(ui, new RegExp(`^${NOT_READ.replace(/[.()]/g, '\\$&')}`))), m.toasts.some((t) => t.includes(NOT_READ))]

  test('without a merge the reload still comes, after 8.5 s; the pane and a toast say so', async ($, on) => {
    const m = machine(on)
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    await pluginOff(ui)
    const waited = wait(m)
    await ui.press({ key: 'confirm' })
    expect([waited(), m.commands]).toEqual([8500, ['reload-plugins']])
    expect(await texts(ui, /applied .* to this chat\.$/)).toBeDefined()
    expect(await notRead(ui, m)).toEqual([true, true])
  })

  // Seen live (2.1.332): the reload of a reset came before the merge, and loaded the plugins of the choice just undone.
  for (const how of ['reset', 'reset --all', 'default'] as const) {
    for (const what of ['a choice of the chat', 'a choice of the chat, no local file', 'the default only'] as const) {
      test(`${how}, ${what}: the reload waits for the merge too`, async ($, on) => {
        const files = { ...(what === 'a choice of the chat' ? { [LOCAL]: '{}\n' } : {}), [STATE]: stateOf({}, { [SID]: chat({ desired: { 'plugin:pa@m': false } }) }) }
        const m = machine(on, what === 'the default only' ? {} : { files })
        if (what === 'the default only') {
          const { items } = await readInventory(ctx(m.fs))
          const desired = new Map([...items.map((i) => [itemKey(i), i.on] as const), ['plugin:pa@m', false]])
          await applyPatch(ctx(m.fs), compile(items, desired), { preset: 'D', now: new Date() })
        }
        await open($, how === 'default' ? '' : how)
        const ui = await $.ui.mount(pane('terminal'))
        if (how === 'default') {
          await ui.press({ key: 'toggle:skill:alpha' })
          await ui.press({ key: 'make-default' })
        }
        const waited = wait(m)
        await ui.press({ key: how === 'default' ? 'confirm' : how === 'reset' ? 'reset-confirm' : 'reset-all-confirm' })
        expect([waited(), m.commands]).toEqual([8500, ['reload-plugins']])
        expect(await notRead(ui, m)).toEqual([true, true])
      })
    }
  }

  // The engine gives a press 10 s, its sleeps included: past them nothing more of it runs.
  for (const [how, key] of [['', 'confirm'], ['reset', 'reset-confirm'], ['reset --all', 'reset-all-confirm']] as const) {
    test(`${how || 'Apply'}, another window holding the lock for 2.5 s and no merge: still said and reloaded within 8.5 s`, async ($, on) => {
      const m = machine(on, how ? { files: { [LOCAL]: '{}\n', [STATE]: stateOf({}, { [SID]: chat({ desired: { 'plugin:pa@m': false } }) }) } } : {})
      await open($, how)
      const ui = await $.ui.mount(pane('terminal'))
      if (!how) await pluginOff(ui)
      const other = `${lockPath(DIRS.state)}/${Date.now()}-other`
      m.files.set(other, '')
      const waited = wait(m, async (ms) => { if (ms === 2500) m.files.delete(other) })
      await ui.press({ key })
      expect([waited(), m.commands]).toEqual([8500, ['reload-plugins']])
      expect(await notRead(ui, m)).toEqual([true, true])
    })
  }

  test('a wait that cannot be made: the reload comes at once, nothing said of what is not known', async ($, on) => {
    const m = machine(on, { noSleep: true })
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    await pluginOff(ui)
    await ui.press({ key: 'confirm' })
    expect([m.commands, m.touched]).toEqual([['reload-plugins'], []])
    expect(await notRead(ui, m)).toEqual([false, false])
  })

  test("CLAUDE_CONFIG_DIR: the settings file touched is the one there", async ($, on) => {
    const m = machine(on, { env: { CLAUDE_CONFIG_DIR: '/cfg' } })
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    await ui.press({ key: 'toggle:skill:projskill' })
    await applyForChat(ui)
    expect(m.touched).toEqual(['/cfg/settings.json'])
  })

  test('no surface any more: no reload run, none asked for', async ($, on) => {
    const surfaces: 'terminal'[] = ['terminal']
    const m = machine(on, { surfaces })
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    await pluginOff(ui)
    surfaces.length = 0
    await ui.press({ key: 'confirm' })
    expect(await texts(ui, /applied .* to this chat\./)).toBeDefined()
    expect([m.commands, !!(await texts(ui, /Type \/reload-plugins/))]).toEqual([[], false])
  })

  test("every screen that writes says that the user's settings file may be touched", async ($, on) => {
    machine(on, { files: { [STATE]: stateOf({ [ROOT]: project() }, {}) } })
    const also = `If Claude Code does not read its settings again, touches ${USER_SETTINGS} too (content unchanged).`
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    await ui.press({ key: 'toggle:skill:alpha' })
    for (const [key, says] of [
      ['apply', `Only for this chat: writes its choice to ${STATE}, then touches ${LOCAL} (content unchanged; created as {} if missing) so that Claude Code reads the settings again. ${also}`],
      ['make-default', `Becomes the project default, for new chats and this one. Writes ${LOCAL} (backup first, in ${DIRS.state}/backups/) and the state in ${STATE}. ${also}`],
    ] as const) {
      await ui.press({ key })
      expect(await ui.find({ type: 'Text', text: says })).toBeDefined()
      await ui.press({ key: 'cancel' })
    }
    for (const how of ['reset', 'reset --all']) {
      await open($, how)
      expect(await ui.find({ type: 'Text', text: also })).toBeDefined()
    }
  })

  for (const [how, key] of [['reset', 'reset-confirm'], ['reset --all', 'reset-all-confirm']] as const) {
    test(`${how} with nothing to undo here expects no merge: no wait, nothing said`, async ($, on) => {
      const m = machine(on, { files: { [STATE]: stateOf({}, {}) } })
      const elsewhere = { ...ctx(m.fs), root: '/h/elsewhere' }
      m.files.set('/h/elsewhere/README.md', '')
      const { items } = await readInventory(elsewhere)
      await applyPatch(elsewhere, compile(items, new Map([...items.map((i) => [itemKey(i), i.on] as const), ['plugin:pa@m', false]])), { preset: 'D', now: new Date() })
      await open($, how)
      const ui = await $.ui.mount(pane('terminal'))
      const waited = wait(m)
      await ui.press({ key })
      expect([waited(), m.commands, m.touched]).toEqual([0, ['reload-plugins'], []])
      expect(await notRead(ui, m)).toEqual([false, false])
    })
  }

  test('rules: from the next conversation', async ($, on) => {
    machine(on)
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    await ui.press({ key: 'tab:rule' })
    await ui.press({ key: 'toggle:rule:/h/p/proj/.claude/rules/r1.md' })
    await ui.press({ key: 'apply' })
    expect(await texts(ui, /^From the next conversation \(\/clear\): r1\.md$/)).toBeDefined()
  })

  test('agents stay the default: the tab says so, the chat summary lists them apart and the choice leaves them out', async ($, on) => {
    const m = machine(on)
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    await ui.press({ key: 'tab:agent' })
    expect(await texts(ui, /^Agents are set for the whole project: change them with Make default\.$/)).toBeDefined()
    await ui.press({ key: 'toggle:agent:executor' })
    await ui.press({ key: 'tab:skill' })
    await ui.press({ key: 'toggle:skill:alpha' })
    await ui.press({ key: 'apply' })
    expect(await texts(ui, /^Switching off \(1\): alpha$/)).toBeDefined()
    expect(await texts(ui, /^Stay as in the project default .*: executor$/)).toBeDefined()
    await ui.press({ key: 'confirm' })
    expect(m.json(STATE).sessions[SID].desired).toEqual({ 'skill:alpha': false })
  })

  test('protected items need the extra confirmation for a chat too', async ($, on) => {
    const m = machine(on)
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    await ui.press({ key: 'tab:hook' })
    await ui.press({ key: `toggle:hook:${hid('resource-guard.cjs', 'PreToolUse')}` })
    await ui.press({ key: 'apply' })
    expect(await ui.find({ key: 'confirm' })).toBeUndefined()
    await ui.press({ key: 'protected-ok' })
    await ui.press({ key: 'confirm' })
    expect(m.json(STATE).sessions[SID].hooksOff).toEqual([hid('resource-guard.cjs', 'PreToolUse')])
  })

  test('the pane opens on the choice of this chat, not on the default', async ($, on) => {
    machine(on, { files: { [STATE]: stateOf({ [ROOT]: project() }, { [SID]: chat({ preset: 'Mine' }) }) } })
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    expect((await ui.find({ key: 'toggle:skill:alpha' }))?.props.label).toBe('off')
    expect(await texts(ui, /^This chat: "Mine", applied /)).toBeDefined()
    expect(await texts(ui, /^Project default: "D", applied /)).toBeDefined()
  })

  test("a choice of another chat, or of this chat on another folder, is not this chat's", async ($, on) => {
    machine(on, { files: { [STATE]: stateOf({}, { [OTHER_SID]: chat(), [SID]: chat({ root: '/h/elsewhere' }) }) } })
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    expect((await ui.find({ key: 'toggle:skill:alpha' }))?.props.label).toBe('on')
    expect(await texts(ui, /^This chat: same as the project default · id aaaaaaaa$/)).toBeDefined()
  })

  test('changed on disk: this chat\'s choice written meanwhile (another pane of the chat) → reloads, warns, writes nothing', async ($, on) => {
    const m = machine(on)
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    await ui.press({ key: 'toggle:skill:cmd1' })
    m.files.set(STATE, stateOf({}, { [SID]: chat() }))
    const written = new Map(m.files)
    await ui.press({ key: 'apply' })
    expect([...m.files]).toEqual([...written])
    expect((await texts(ui, new RegExp(CHANGED)))?.props.color).toBe('warning')
    expect(await ui.find({ key: 'confirm' })).toBeUndefined()
  })
})

describe('Make default', () => {
  test("writes the project default and drops this chat's own choice, other chats stay", async ($, on) => {
    const other = chat({ preset: 'Other' })
    const m = machine(on, { files: { [STATE]: stateOf({}, { [SID]: chat(), [OTHER_SID]: other }) } })
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    await ui.press({ key: 'make-default' })
    expect(await texts(ui, /^Summary: make "Default" the project default$/)).toBeDefined()
    await ui.press({ key: 'confirm' })
    const st = m.json(STATE)
    expect(st.sessions).toEqual({ [OTHER_SID]: other })
    expect(st.projects[ROOT].preset).toBe(`Default${MODIFIED}`)
    expect(m.json(LOCAL).skillOverrides).toEqual({ alpha: 'off' })
    expect(await texts(ui, /^This chat: same as the project default/)).toBeDefined()
  })
})

describe('Make default, protected items', () => {
  test('a protected hook the default switches back on goes back on in the other chats of the folder', async ($, on) => {
    const hook = hid('resource-guard.cjs', 'PreToolUse')
    // a chat whose Apply carried the protected hook the default had off, and one on another folder
    const other = chat({ desired: { 'skill:alpha': false, [`hook:${hook}`]: false }, hooksOff: [hook] })
    const elsewhere = chat({ root: '/h/elsewhere', desired: { [`hook:${hook}`]: false }, hooksOff: [hook] })
    const m = machine(on, { files: { [STATE]: stateOf({ [ROOT]: project({ hooksOff: [hook] }) }, { [OTHER_SID]: other, ccc: elsewhere }) } })
    await open($)
    const ui = await $.ui.mount(pane('terminal'))
    await ui.press({ key: 'tab:hook' })
    await ui.press({ key: `toggle:hook:${hook}` })
    await ui.press({ key: 'make-default' })
    await ui.press({ key: 'confirm' })
    const st = m.json(STATE)
    expect(st.projects[ROOT].hooksOff).toEqual([])
    expect(st.sessions).toEqual({ [OTHER_SID]: { ...other, desired: { 'skill:alpha': false }, hooksOff: [] }, ccc: elsewhere })
  })
})

describe('/clear, /branch, /resume', () => {
  test('/clear and /branch give the choice to the new id; the old one keeps it', async ($, on) => {
    const m = machine(on, { files: { [STATE]: stateOf({}, { [SID]: chat() }) } })
    await $.command.run({ command: 'clear', args: '' } as any)
    expect(m.sid).toBe(NEXT_SID)
    const s = m.json(STATE).sessions
    expect(Object.keys(s).sort()).toEqual([SID, NEXT_SID])
    expect({ ...s[NEXT_SID], updatedAt: 0 }).toEqual({ ...chat(), updatedAt: 0 })
    expect(m.touched).toEqual([])
  })

  test('/branch the same way', async ($, on) => {
    const m = machine(on, { files: { [STATE]: stateOf({}, { [SID]: chat() }) } })
    await $.command.run({ command: 'branch', args: '' } as any)
    expect(Object.keys(m.json(STATE).sessions).sort()).toEqual([SID, NEXT_SID])
  })

  test('/clear of a chat without a choice writes nothing', async ($, on) => {
    const m = machine(on)
    await $.command.run({ command: 'clear', args: '' } as any)
    expect(m.files.has(STATE)).toBe(false)
  })

  test('/resume to another session touches the local, so its choice takes effect', async ($, on) => {
    const m = machine(on, { files: { [LOCAL]: '{}', [STATE]: stateOf({}, { [OTHER_SID]: chat() }) } })
    await $.command.run({ command: 'resume', args: OTHER_SID } as any)
    expect(m.touched).toEqual([LOCAL])
    expect(m.files.get(LOCAL)).toBe('{}')
  })
})

// A second mod that reads the merged settings, as Claude Code does, so the read passes through plancia's hook.
const reader = {
  name: 'reader',
  register(on: any) {
    on('command.run', { command: 'read-settings' }, async ($: any) => ({ text: JSON.stringify(await $.settings.read()) }))
  },
}
const read = async ($: any) => JSON.parse(String((await $.command.run({ command: 'read-settings', args: '' } as any)).text))
const HOOKS = {
  PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node /h/shared/hooks/resource-guard.cjs' }] }],
  Stop: [{ hooks: [{ type: 'command', command: 'bash /h/shared/hooks/stop-check.sh' }] }],
}
const defaultAlphaOff = project({
  hooksOff: [hid('resource-guard.cjs', 'PreToolUse')],
  entries: [{ item: 'skill:alpha', on: false, kind: 'set', path: ['skillOverrides', 'alpha'], value: 'off', prev: { present: false } }],
})

describe('settings.read for this chat', () => {
  test("the chat's choice replaces the default's in the merge, hooks follow the chat", { plugins: [reader] }, async ($, on) => {
    const ss = chat({ desired: { 'skill:cmd1': false }, hooksOff: [hookId('Stop', HOOKS.Stop[0]!.hooks[0]!)] })
    machine(on, { files: { [STATE]: stateOf({ [ROOT]: defaultAlphaOff }, { [SID]: ss }) } })
    on('settings.read', () => ({ value: { model: 'x', skillOverrides: { alpha: 'off' }, hooks: HOOKS } }))
    expect(await read($)).toEqual({ model: 'x', skillOverrides: { cmd1: 'off' }, hooks: { PreToolUse: HOOKS.PreToolUse } })
  })

  test('without a choice for the chat: the project default', { plugins: [reader] }, async ($, on) => {
    machine(on, { files: { [STATE]: stateOf({ [ROOT]: defaultAlphaOff }, { [OTHER_SID]: chat({ desired: { 'skill:cmd1': false } }) }) } })
    on('settings.read', () => ({ value: { skillOverrides: { alpha: 'off' }, hooks: HOOKS } }))
    expect(await read($)).toEqual({ skillOverrides: { alpha: 'off' }, hooks: { Stop: HOOKS.Stop } })
  })

  test('without the chat id the project default still filters the hooks', { plugins: [reader] }, async ($, on) => {
    const m = machine(on, { files: { [STATE]: stateOf({ [ROOT]: project({ hooksOff: [hookId('Stop', HOOKS.Stop[0]!.hooks[0]!)] }) }, {}) } })
    m.sid = ''
    on('settings.read', () => ({ value: { hooks: HOOKS } }))
    expect(await read($)).toEqual({ hooks: { PreToolUse: HOOKS.PreToolUse } })
  })
})

describe('band', () => {
  test('with a choice of its own the band says so and counts what the chat switches off', async ($, on) => {
    const ss = chat({ preset: 'Mine', desired: { 'skill:alpha': false, 'skill:cmd1': false, 'plugin:pb@m': true, 'hook:x.sh:Stop': false } })
    const ps = project({
      hooksOff: ['y.sh:Stop'],
      entries: [
        { item: 'agent:executor', on: false, kind: 'add', path: ['permissions', 'deny'], value: 'Agent(executor)', prev: { present: false } },
        { item: 'skill:projskill', on: false, kind: 'set', path: ['skillOverrides', 'projskill'], value: 'off', prev: { present: false } },
        { item: 'plugin:data@synced', on: false, kind: 'set', path: ['enabledPlugins', 'data@synced'], value: false, prev: { present: false } },
      ],
    })
    const m = machine(on, { files: { [STATE]: stateOf({ [ROOT]: ps }, { [SID]: ss }) } })
    m.reads.length = 0
    const ui = await $.ui.mount(band('terminal'))
    // alpha, cmd1, x.sh:Stop from the chat; executor and the synced plugin from the default
    expect(await texts(ui, /^Plancia · Mine \(this chat\) · 5 off$/)).toBeDefined()
    expect(m.reads).toEqual([STATE])
  })
})

describe('guard', () => {
  test('an agent cannot write the chat choices either: state.json is behind the tool.call guard', async ($, on) => {
    const m = machine(on)
    const w = await $.tool.call({ tool: 'Write', file_path: `${HOME}/.config/plancia/state.json`, content: '{"sessions":{}}' } as any)
    expect(JSON.stringify(w)).toMatch(/Plancia/)
    expect(m.toolCalls).toEqual([])
  })
})
