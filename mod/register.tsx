// Plancia mod, the only hooks module (hooks/plancia.json): the /plancia command, the pane and the band, the settings.read
// overlay of this chat and filter for switched-off hooks, and the tool.call guard of the state folder.
// All preset logic lives in src/core, the pane in pane.tsx, the $ adapter in adapter.ts.
import type { Register } from 'claude-code'
import { chatOf, copySession, guardSpelling, guardToolCall, loadPresets, overlay, projectOnlyEntry, readInventory, readState, settledProject, withoutHooks, withoutServers, type Dirs, type Item } from '../src/core/index.js'
import { UNSUPPORTED, countMerge, dirsFor, fileIds, isUnsupported, mergeOfEngine, realPaths, sessionCtx, touchLocal } from './adapter.js'
import { PANE, isPaneUp, openPane, paneClosed, paneTree, reloadPane, togglePane } from './pane.js'

export const register: Register = (on) => {
  // Light: one read of state.json and presets.json. No surface (claude -p) → no pane, no toast.
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: 'plancia', description: 'Plancia: choose skills, plugins, MCP servers, agents, rules and hooks, per chat or project', argumentHint: '[setup | reset [--all]]' })
    } catch {
      // already registered by an earlier load of this module
    }
    if ((await $.session.surfaces()).length > 0 && !(await isUnsupported($))) {
      const { fs, state } = await sessionCtx($)
      const bad = await Promise.all([readState(fs, state), loadPresets(fs, state)]).then(() => null, (err: Error) => err.message)
      if (bad) await $.ui.toast(`Plancia: ${bad}. Ignored: open /plancia to start over`)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'plancia' }, async ($, e) => {
    if (await isUnsupported($)) return { text: UNSUPPORTED }
    if ((await $.session.surfaces()).length === 0) return { text: 'Plancia opens in an interactive session: run claude, then /plancia' }
    await openPane($, e.args ?? '')
    return {}
  })

  // /clear and /branch start a new id, the choice goes with it before the next merge; /resume to another
  // session needs a merge for that session's choice. Any failure leaves the command as it went.
  on('command.run', { command: ['clear', 'branch', 'resume'] }, async ($, e, next) => {
    if (await isUnsupported($)) return next(e)
    const before = await $.session.id().catch(() => '')
    const r = await next(e)
    try {
      const after = await $.session.id()
      if (before && after && after !== before) {
        const { fs, root, state } = await sessionCtx($)
        if (e.command === 'resume') {
          const { sessions } = await readState(fs, state)
          if (sessions[before] || sessions[after]) await touchLocal($, fs, root, false)
        } else await copySession(fs, state, before, after, new Date())
        $.ui.invalidate('tool.list')
        await reloadPane($)
        $.ui.invalidate('ui.render')
      }
    } catch {
      // the choice stays on the old id: this chat runs the default from the next merge
    }
    return r
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    return paneTree($, e)
  })

  // One row above the prompt. One read of state.json (after a killed default, of the local file too), never a write; any failure leaves the band to the others.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    // Other mods' rows go below ours; next(e) rejects only when nothing answers beneath (the test bench).
    const below = await next(e).catch(() => undefined)
    const unsupported = await isUnsupported($)
    const { fs, root, ...dirs } = await sessionCtx($)
    const state = unsupported ? null : await readState(fs, dirs.state).catch(() => null)
    const ps = state ? await settledProject({ fs, root }, state) : undefined
    const ss = state && chatOf(state, await $.session.id().catch(() => ''), root)
    // Switched off by Plancia against the user's own configuration: no inventory here, so what was already off is not counted.
    // A chat's own choice: its own offs, plus the default's project-only entries.
    const choice = ss ?? ps
    const off = ss
      ? new Set([
          ...Object.entries(ss.desired).filter(([, isOn]) => !isOn).map(([k]) => k),
          ...(ps?.entries ?? []).filter((x) => !x.on && projectOnlyEntry(x)).map((x) => x.item),
        ])
      : new Set([...(ps?.entries ?? []).filter((x) => !x.on).map((x) => x.item), ...(ps?.hooksOff ?? []).map((h) => `hook:${h}`)])
    const isOpen = isPaneUp() && (await $.ui.panes()).some((p) => p.id === PANE)
    const label = unsupported
      ? UNSUPPORTED
      : !state
        ? 'Plancia · saved choices ignored, state.json cannot be used'
        : choice ? `Plancia · ${choice.preset ?? 'no preset'}${ss ? ' (this chat)' : ''} · ${off.size} off` : 'Plancia · no preset'
    const { Box, Text, Button } = $.ui.resolve(e)
    // bodyColumns counts terminal cells; a graphical surface draws Buttons wider than their cells.
    const width = e.surface === 'terminal' ? e.props.bodyColumns : undefined
    const mine = (
      <Box key="band" flexDirection="row" alignItems="center" gap={2} width={width}>
        <Text wrap="truncate-end">{label}</Text>
        {!unsupported && <Button key="band-open" plain label={isOpen ? 'Close' : 'Open'} onPress={() => togglePane($)} />}
      </Box>
    )
    return below ? <Box flexDirection="column">{mine}{below}</Box> : mine
  }).catch(($, e, next) => next(e))

  // The band's Open/Close follows the pane, however it closed.
  on('ui.close', async ($, e, next) => {
    const r = await next(e)
    if (e.id === PANE) paneClosed($)
    return r
  })

  // The merge this chat reads carries its own choice instead of the project default's entries. Hooks
  // switched off for this chat (else for the project) leave the effective settings; SessionStart ones never
  // do. Any failure leaves the settings as they are (fail-open toward the user's own configuration).
  let itemsMemo: { key: string; items: Item[] } | null = null
  on('settings.read', async ($, e, next) => {
    try {
      const read = await next(e)
      if (e.source || !('value' in read) || !read.value || (await isUnsupported($))) return read
      const ctx = await sessionCtx($)
      const { root } = ctx
      const state = await readState(ctx.fs, ctx.state)
      const ps = state.projects[root]
      // Without the chat id, the project default (its hooksOff included)
      const ss = chatOf(state, await $.session.id().catch(() => ''), root)
      let value = read.value
      if (ss) {
        // shortcut: the inventory is re-read only when the merge or the project's entries change (a plugin's read
        // may come at every render); a skill file added meanwhile counts from the next merge.
        const key = JSON.stringify([root, ps ?? null, read.value])
        if (itemsMemo?.key !== key) itemsMemo = { key, items: (await readInventory(ctx)).items }
        value = overlay(read.value, itemsMemo.items, ps, ss, e.layers) as typeof read.value
      }
      // In the home folder the project's settings file is the user's own.
      const layers = `${root}/.claude` === ctx.claude ? (e.layers ?? []).filter((l) => l.source !== 'project') : e.layers
      const hooks = withoutHooks(value.hooks, (ss ?? ps)?.hooksOff ?? [], layers)
      if (value === read.value && hooks === read.value.hooks) return read
      return { value: (hooks === value.hooks ? value : { ...value, hooks }) as typeof read.value }
    } finally {
      if (mergeOfEngine(e, next.origin)) countMerge()
    }
  }).catch(($, e, next) => next(e))

  // A server already connected stays connected whatever the settings become (seen live, 2.1.331): its tools leave the
  // chat's list instead. Any failure leaves the list as it is.
  on('tool.list', async ($, e, next) => {
    const listed = await next(e)
    if (listed.value === undefined || (await isUnsupported($))) return listed
    const ctx = await sessionCtx($)
    const ss = chatOf(await readState(ctx.fs, ctx.state), await $.session.id().catch(() => ''), ctx.root)
    const left = await withoutServers(listed.value, ss, async () => (await readInventory(ctx)).items)
    return left === listed.value ? listed : { value: [...left] }
  }).catch(($, e, next) => next(e))

  // The agent never writes plancia's state; the pane writes through $.fs, which no tool.call sees.
  // MultiEdit as a regexp: the tool types of 2.1.331 no longer name it, older versions have it.
  let known: Dirs | null = null
  on('tool.call', { tool: ['Write', 'Edit', /^MultiEdit$/, 'NotebookEdit'] }, async ($, e, next) => {
    if (await isUnsupported($)) return next(e)
    known = await dirsFor($).catch(() => known)
    const cwd = await $.session.cwd().catch(() => $.session.root()).catch(() => '/')
    const reason = await guardToolCall(e.tool, e as unknown as Record<string, unknown>, cwd, known, { real: (paths) => realPaths($, paths, cwd), ids: (paths) => fileIds($, paths, cwd) })
    return reason ? { deny: reason } : next(e)
  }).catch(($, e, next) => {
    if (next.called) return next(e)
    // The guard failed before deciding: the spelling alone, on the folders last known.
    const reason = guardSpelling(e.tool, e as unknown as Record<string, unknown>, '/', known)
    return reason ? { deny: reason } : next(e)
  })
}
