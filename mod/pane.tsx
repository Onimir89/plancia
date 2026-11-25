// The /plancia pane: its state, its actions and its tree. The hooks that open and draw it are in register.tsx.
import type { EngineInterface, RenderInput } from 'claude-code'
import {
  BadFile, CATEGORIES, DEFAULT, PANEL_ROWS, appliedState, applyChat, applyPatch, compile, deletePreset, diffKeys, dirsOf, fingerprint, ifUnchanged, isReserved, itemKey, listPresets,
  listTouchedProjects, loadPresets, localSettingsPath, localStamp, offByImport, presetFrom, projectOnly, protectedPath, readPanelRows, readView, resetAll, resetProject,
  resolvePreset, saveSession, savePreset, sessionFrom, sessionState, setAside, setCategory, setupChoices, statePath, stepPanelRows, summarize, withImports, writeProtected,
  type Category, type Ctx, type Dirs, type Inventory, type Item, type Preset, type ResetOutcome, type Seen, type SessionState, type StateFile, type StateMap,
} from '../src/core/index.js'
import { fsOf, mergeAfter, sessionCtx, touchLocal, type Press } from './adapter.js'

export const PANE = 'plancia'
// The name links of the pane: answered by onLinkPress, never opened. The VS Code webview has no tooltip but a
// link's title, which is its href (2.1.330): the description rides in the path, so hovering the name reads it.
const DETAIL_URL = 'https://plancia/'
const HREF_MAX = 2048
const hrefPart = (t: string) => encodeURI(t).replace(/[*_~()'!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
const tipHref = (description: string) => {
  let t = description.replace(/\s+/g, ' ').trim() || '(no description)'
  let tail = ''
  while ((DETAIL_URL + hrefPart(t + tail)).length > HREF_MAX) [t, tail] = [t.slice(0, Math.floor(t.length * 0.9)).trimEnd(), '…']
  return DETAIL_URL + hrefPart(t + tail)
}
const mdEscape = (t: string) => t.replace(/[\\`*_[\]<>]/g, (c) => `\\${c}`)
/** Saved in state.json after the preset's name: the choice also has unsaved changes. */
export const MODIFIED = ' (modified)'
export const TAB_LABEL: Record<Category, string> = { skill: 'Skills', plugin: 'Plugins', mcp: 'MCP', agent: 'Agents', rule: 'Rules', hook: 'Hooks' }
/** Why an item has no switch. */
const LOCK: Record<NonNullable<Item['locked']>, { tag: string; row: string; detail: string }> = {
  user: { tag: '[locked]', row: 'switched off in your settings, outside Plancia', detail: 'Switched off in your settings, outside Plancia: it cannot be switched on here.' },
  'session-start': {
    tag: '[locked]',
    row: 'SessionStart hooks run before Plancia can act',
    detail: 'SessionStart hooks run before Plancia can act: they cannot be switched off here.',
  },
  required: { tag: '[locked]', row: 'your organization requires it', detail: 'Your organization requires this plugin: it cannot be switched off here.' },
}
const ONE_LINE = 140
const ROWS_STEP = 5
/** When a choice for this chat takes effect in the running chat (seen live). */
export const WHEN_CHAT: Record<Category, string> = {
  skill: 'Now', mcp: 'From your next message', hook: 'Now', agent: 'Now', plugin: 'After the plugins reload', rule: 'From the next conversation (/clear)',
}
/** Shown after a write refused because the disk changed. */
export const CHANGED = 'The state changed on disk since you opened the panel: reloaded, nothing written. Make your choices again.'

/** Shown after a write Claude Code did not read. */
export const NOT_READ = 'Claude Code has not read its settings again: the change takes effect when it does, at the latest when you restart this session (claude --continue).'

type Mode = 'list' | 'setup' | 'summary' | 'saveAs' | 'delete' | 'reset' | 'resetAll'
/** What the summary's Confirm writes: this chat's choice (Apply) or the project default (Make default). */
type Target = 'chat' | 'project'
type Notice = { text: string; tone?: 'warning' | 'success' }

type View = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string
  /** The error is a file of Plancia's own: Start over sets it aside. */
  badFile: boolean
  dirs: Dirs
  root: string
  inv: Inventory | null
  state: StateFile | null
  user: Preset[]
  /** $.session.id() when the pane loaded, and this chat's own choice (only on this root). */
  sid: string
  ss: SessionState | undefined
  /** What this chat runs: its own choice, else the project default. */
  applied: StateMap
  /** What the project default gives (Make default starts from it). */
  projectApplied: StateMap
  selected: string
  desired: StateMap
  tab: Category
  query: Record<Category, string>
  page: number
  /** List height chosen with Taller / Shorter (panel.json). */
  rows: number
  detail: string | null
  mode: Mode
  target: Target
  protectedOk: boolean
  /** The boxes of the setup guide: item key → ticked. */
  ticks: Map<string, boolean>
  notice: Notice | null
}

const noQuery = (): Record<Category, string> => ({ skill: '', plugin: '', mcp: '', agent: '', rule: '', hook: '' })
// Module state: lost on reload, rebuilt from disk by load().
const v: View = {
  status: 'idle', error: '', badFile: false, dirs: dirsOf('', {}), root: '', inv: null, state: null, user: [], sid: '', ss: undefined, applied: new Map(),
  projectApplied: new Map(), selected: DEFAULT, desired: new Map(), tab: 'skill', query: noQuery(), page: 0, rows: PANEL_ROWS.default, detail: null,
  mode: 'list', target: 'chat', protectedOk: false, ticks: new Map(), notice: null,
}

const oneLine = (s: string) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > ONE_LINE ? `${t.slice(0, ONE_LINE - 1)}…` : t
}
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))
const items = (): Item[] => v.inv?.items ?? []
const itemsByKey = () => new Map(items().map((i) => [itemKey(i), i]))
const resolved = (name: string) => resolvePreset(name, v.user, items())
const userPreset = (name: string) => v.user.find((p) => p.name === name)
/** ◆ marks differences from the selected preset's parent; for the built-in ones, from the preset itself. */
const reference = () => resolved(userPreset(v.selected)?.parent ?? v.selected)
const unsaved = () => diffKeys(v.desired, resolved(v.selected)).size
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
const matches = (i: Item, q: string) => {
  const s = q.trim().toLowerCase()
  return !s || `${i.name} ${i.id} ${i.description}`.toLowerCase().includes(s)
}
const newPress = (): Press => ({ local: localSettingsPath(v.root), slept: 0 })
function ctxOf($: EngineInterface, press?: Press): Ctx {
  return { ...v.dirs, root: v.root, fs: fsOf($, v.dirs.state, press) }
}

/** Reads inventory, presets and state; the pane starts from what is applied to the project, `opening` from the setup guide if never done. */
async function load($: EngineInterface, opening = false): Promise<void> {
  v.status = 'loading'
  $.ui.invalidate('ui.render')
  try {
    const ctx = await sessionCtx($)
    const { fs, root, ...dirs } = ctx
    Object.assign(v, { dirs, root })
    const sid = await $.session.id().catch(() => '')
    const { state, inv, user, ps, ss } = await readView(ctx, sid)
    const rows = await readPanelRows(fs, dirs.state)
    const projectApplied = appliedState(inv.items, ps)
    const applied = ss ? sessionState(inv.items, ps, ss) : projectApplied
    const name = (ss ? ss.preset : ps?.preset)?.replace(MODIFIED, '')
    Object.assign(v, { status: 'ready', error: '', inv, state, user, sid, ss, applied, projectApplied, rows, protectedOk: false })
    v.selected = name && listPresets(user).some((p) => p.name === name) ? name : DEFAULT
    v.desired = ss || ps ? new Map(applied) : resolved(v.selected)
    v.ticks = setupChoices(inv.items, inv.protectedKeys)
    if (opening && v.mode === 'list' && inv.protectedKeys === undefined) v.mode = 'setup'
  } catch (err) {
    v.status = 'error'
    v.error = errText(err)
    v.badFile = err instanceof BadFile
  }
  $.ui.invalidate('ui.render')
}

/** The way out of a state.json or presets.json that cannot be used. */
async function startOver($: EngineInterface): Promise<void> {
  try {
    const kept = await setAside(ctxOf($), new Date())
    await load($, true)
    show($, { notice: kept.length ? { text: `Started over. The old file is kept as ${kept.join(', ')}.`, tone: 'success' } : null })
  } catch (err) {
    show($, { error: errText(err) })
  }
}

/** After another command may have changed what the pane shows. */
export async function reloadPane($: EngineInterface): Promise<void> {
  if (v.status === 'ready') await load($)
}

const seen = (): Seen => ({ inv: v.inv!, ps: v.state?.projects[v.root], user: v.user, ss: v.ss })

/** Another window (or a hand edit) has written since load(): reloads from disk and says that nothing was written. */
async function changedOnDisk($: EngineInterface): Promise<void> {
  if (v.mode !== 'setup') v.mode = 'list'
  await load($)
  show($, {
    notice: { text: CHANGED, tone: 'warning' },
  })
}

/**
 * Every write of a draft: in the lock, and only if the disk is as load() read it (an old draft never undoes what another
 * window wrote, e.g. a protected hook switched on again). Null, and nothing written, when it is not.
 */
async function writeDraft<T>($: EngineInterface, write: (ctx: Ctx) => Promise<T>, press?: Press): Promise<T | null> {
  const done = await ifUnchanged(ctxOf($, press), v.sid, seen(), write)
  if (done === null) await changedOnDisk($)
  return done
}

function show($: EngineInterface, patch: Partial<View>): void {
  Object.assign(v, patch)
  $.ui.invalidate('ui.render')
}

function selectPreset($: EngineInterface, name: string): void {
  show($, { selected: name, desired: resolved(name), page: 0, detail: null, mode: 'list', notice: null })
}

async function reloadUserPresets($: EngineInterface): Promise<void> {
  v.user = await loadPresets(ctxOf($).fs, v.dirs.state)
}

async function save($: EngineInterface): Promise<void> {
  const p = userPreset(v.selected)
  if (!p || p.parent === null) {
    show($, { notice: { text: `"${v.selected}" is a built-in preset and cannot be changed: use "Save as…".`, tone: 'warning' } })
    return
  }
  const preset = presetFrom(p.name, p.parent, v.desired, v.user, items())
  try {
    if ((await writeDraft($, (ctx) => savePreset(ctx.fs, ctx.state, preset))) === null) return
    await reloadUserPresets($)
    show($, { notice: { text: `Preset "${p.name}" saved.`, tone: 'success' } })
  } catch (err) {
    show($, { notice: { text: `Save failed: ${errText(err)}`, tone: 'warning' } })
  }
}

async function nameIt($: EngineInterface): Promise<void> {
  show($, { mode: 'saveAs', notice: null })
  // Seen live: the terminal leaves the focus on nothing (the test bench does not raise ui.focus).
  await $.ui.focus({ requestId: PANE, key: 'save-name' }).catch(() => undefined)
}

async function saveAs($: EngineInterface, raw: string): Promise<void> {
  const name = raw.trim()
  const refuse = !name
    ? 'Write a name.'
    : isReserved(name)
      ? `"${name}" is a built-in preset: choose another name.`
      : name.includes(MODIFIED.trim()) || userPreset(name)
        ? `"${name}" already exists or is not a valid name: choose another one, or select that preset and use "Save".`
        : null
  if (refuse) {
    show($, { notice: { text: refuse, tone: 'warning' } })
    return
  }
  const preset = presetFrom(name, v.selected, v.desired, v.user, items())
  try {
    if ((await writeDraft($, (ctx) => savePreset(ctx.fs, ctx.state, preset))) === null) return
    await reloadUserPresets($)
    show($, { selected: name, mode: 'list', notice: { text: `Preset "${name}" saved, based on "${userPreset(name)?.parent}".`, tone: 'success' } })
  } catch (err) {
    show($, { notice: { text: `Save failed: ${errText(err)}`, tone: 'warning' } })
  }
}

async function removePreset($: EngineInterface): Promise<void> {
  const name = v.selected
  try {
    if ((await writeDraft($, (ctx) => deletePreset(ctx.fs, ctx.state, name))) === null) return
    const parent = userPreset(name)?.parent ?? DEFAULT
    await reloadUserPresets($)
    const next = listPresets(v.user).some((p) => p.name === parent) ? parent : DEFAULT
    show($, { selected: next, desired: resolved(next), mode: 'list', notice: { text: `Preset "${name}" deleted.`, tone: 'success' } })
  } catch (err) {
    show($, { mode: 'list', notice: { text: `Delete failed: ${errText(err)}`, tone: 'warning' } })
  }
}

async function setRows($: EngineInterface, delta: number): Promise<void> {
  try {
    show($, { rows: await stepPanelRows(ctxOf($).fs, v.dirs.state, delta), page: 0 })
  } catch (err) {
    show($, { notice: { text: `Height not saved: ${errText(err)}`, tone: 'warning' } })
  }
}

/** The setup guide's answer, only from its buttons: the ticked items, or none with Skip. */
async function saveSetup($: EngineInterface, keys: string[], onError: Mode): Promise<void> {
  try {
    if (!(await writeDraft($, (ctx) => writeProtected(ctx.fs, ctx.state, keys).then(() => true)))) return
    v.mode = 'list'
    await load($)
    show($, { notice: { text: `${plural(keys.length, 'protected item', 'protected items')}: /plancia setup changes them.`, tone: 'success' } })
  } catch (err) {
    show($, { mode: onError, notice: { text: `Protected items not saved: ${errText(err)}`, tone: 'warning' } })
  }
}

const MODE_OF: Record<string, Mode> = { '': 'list', setup: 'setup', reset: 'reset', 'reset --all': 'resetAll' }
/** /plancia and the band's Open: the pane, focused, re-read from disk. */
export async function openPane($: EngineInterface, args: string): Promise<void> {
  const arg = args.trim().replace(/\s+/g, ' ')
  const mode = Object.hasOwn(MODE_OF, arg) ? MODE_OF[arg] : undefined
  v.mode = mode ?? 'list'
  v.notice = mode ? null : { text: `Unknown argument "${arg}": use /plancia, /plancia setup, /plancia reset or /plancia reset --all.`, tone: 'warning' }
  v.detail = null
  paneUp = (await $.ui.open({ id: PANE, title: 'Plancia', focus: true, closeOnEscape: true })).isPlaced !== false
  $.ui.invalidate('ui.render')
  await load($, true)
}

/**
 * Whether the pane is up, kept by this module: the chat of VS Code still lists a closed pane in $.ui.panes() and may
 * not redraw the band at once (seen live, 2026-11-22), so Open/Close reads this when pressed, not when drawn.
 */
let paneUp = false
export const isPaneUp = () => paneUp
/** The pane was closed, by whoever. */
export function paneClosed($: EngineInterface): void {
  paneUp = false
  $.ui.invalidate('ui.render')
}

export async function togglePane($: EngineInterface): Promise<void> {
  if (!paneUp) return openPane($, '')
  paneUp = false
  await $.ui.close({ id: PANE })
  $.ui.invalidate('ui.render')
}

/**
 * After a write: re-read from disk, then reload plugins; when the press changed the local file (which starts a merge), once a
 * merge since then has been answered (the plugins load from the merge before), or said that none was. Reload only in the terminal:
 * the chat of VS Code takes /reload-plugins from the user alone (2.1.332), so there the notice asks for it when a plugin of
 * this chat changed; `claude -p` has no surface.
 */
async function afterWrite($: EngineInterface, toast: string, notice: Notice, reload: boolean, press: Press): Promise<void> {
  await $.ui.toast(toast)
  $.ui.invalidate('tool.list')
  v.mode = 'list'
  const was = v.applied
  await load($)
  const surfaces = reload ? await $.session.surfaces() : []
  const runs = surfaces.includes('terminal')
  const ask = !runs && surfaces.length > 0 && summarize(items(), was, v.applied).changes.some((c) => c.category === 'plugin')
  const text = ask ? `${notice.text}\nType /reload-plugins in the chat: the plugins change only then.` : notice.text
  show($, { notice: { ...notice, text } })
  // A wait that cannot be made tells nothing.
  if (press.before !== undefined && !(await mergeAfter($, press, v.dirs.claude).catch(() => true))) {
    await $.ui.toast(`Plancia: ${NOT_READ}`)
    show($, { notice: { text: `${text}\n${NOT_READ}`, tone: 'warning' } })
  }
  // Last: it can reload this module too.
  if (runs) await $.command.run({ command: 'reload-plugins' }).catch(() => undefined)
}

/** What Apply would give this chat: the pane's choice, agents and the other project-only items as the default has them. */
const chatTarget = () => sessionState(items(), v.state?.projects[v.root], sessionFrom(items(), v.desired, v.state?.projects[v.root], { root: v.root, preset: null, now: new Date() }))

async function startSummary($: EngineInterface, target: Target): Promise<void> {
  try {
    // Only a look: no lock, writeDraft checks again
    if (fingerprint(await readView(ctxOf($), v.sid)) !== fingerprint(seen())) await changedOnDisk($)
    else show($, { mode: 'summary', target, protectedOk: false, notice: null })
  } catch (err) {
    show($, { notice: { text: `Cannot read the state again, nothing changed: ${errText(err)}`, tone: 'warning' } })
  }
}

/** Apply, only from the Confirm button: this chat's choice in state.json, a touch, plugins reloaded if they change. */
async function confirmChat($: EngineInterface): Promise<void> {
  const preset = unsaved() ? `${v.selected}${MODIFIED}` : v.selected
  const now = new Date()
  const ps = v.state?.projects[v.root]
  try {
    if (!v.sid) throw new Error('Claude Code gives no id for this chat')
    const ss = sessionFrom(items(), v.desired, ps, { root: v.root, preset, now })
    const plugins = summarize(items(), v.applied, sessionState(items(), ps, ss)).changes.some((c) => c.category === 'plugin')
    const press = newPress()
    if (!(await writeDraft($, (ctx) => applyChat(ctx, v.sid, ss, now, (fs) => touchLocal($, fs, v.root, true, press)).then(() => true), press))) return
    const text = `Plancia: applied "${preset}" to this chat`
    await afterWrite($, text, { text: `${text}.`, tone: 'success' }, plugins, press)
  } catch (err) {
    show($, { mode: 'list', protectedOk: false, notice: { text: `Apply failed: ${errText(err)}`, tone: 'warning' } })
  }
}

/** Make default, only from the Confirm button (a click): no tool, command or event applies a preset. */
async function confirmApply($: EngineInterface): Promise<void> {
  const preset = unsaved() ? `${v.selected}${MODIFIED}` : v.selected
  try {
    const now = new Date()
    const press = newPress()
    const res = await writeDraft($, async (ctx) => {
      const applied = await applyPatch(ctx, compile(items(), v.desired), { preset, now })
      // This chat now runs the default: its own choice goes (a merge drops the overlay; with no file written, a touch).
      if (v.ss) {
        await saveSession(ctx.fs, ctx.state, v.sid, null, now)
        if (!applied.wrote) await touchLocal($, ctx.fs, v.root, false, press)
      }
      return applied
    }, press)
    if (!res) return
    const parts = [`Plancia: "${preset}" is the project default`]
    if (res.wrote) parts.push(`wrote ${res.localPath}`)
    if (res.backup) parts.push(`backup in ${res.backup}`)
    const conflicts = res.conflicts.length
      ? ` ${plural(res.conflicts.length, 'item', 'items')} changed by hand since, left as found (${res.conflicts.map((c) => c.item).join(', ')}).`
      : ''
    await afterWrite($, parts.join(' · '), { text: `${parts.join(' · ')}.${conflicts}`, tone: conflicts ? 'warning' : 'success' }, true, press)
  } catch (err) {
    show($, { mode: 'list', protectedOk: false, notice: { text: `Make default failed: ${errText(err)}`, tone: 'warning' } })
  }
}

async function confirmReset($: EngineInterface): Promise<void> {
  try {
    const press = newPress()
    const ctx = ctxOf($, press)
    const res = await resetProject(ctx, { now: new Date() })
    if (v.ss && !res.wrote) await touchLocal($, ctx.fs, v.root, false, press)
    const conflicts = res.conflicts.length ? ` Left as changed by hand: ${res.conflicts.map((c) => c.item).join(', ')}.` : ''
    await afterWrite($, `Plancia: ${v.root} reset`, { text: `Everything Plancia wrote for ${v.root} is undone.${conflicts}`, tone: conflicts ? 'warning' : 'success' }, true, press)
  } catch (err) {
    show($, { mode: 'list', notice: { text: `Reset failed: ${errText(err)}`, tone: 'warning' } })
  }
}

/** '' when the project went back whole. */
const problemLine = (o: ResetOutcome): string =>
  !o.result ? `${o.root}: not reset, ${o.error}`
    : o.result.conflicts.length ? `${o.root}: left as changed by hand: ${o.result.conflicts.map((c) => c.item).join(', ')}` : ''

async function confirmResetAll($: EngineInterface): Promise<void> {
  try {
    const press = newPress()
    const ctx = ctxOf($, press)
    const out = await resetAll(ctx, new Date())
    if (v.ss && press.before === undefined) await touchLocal($, ctx.fs, v.root, false, press)
    const done = out.filter((o) => o.result).length
    const text = `Plancia: ${done} of ${plural(out.length, 'project', 'projects')} reset`
    const problems = out.map(problemLine).filter(Boolean)
    const backups = out.some((o) => o.result?.backup) ? ` Backups: ${v.dirs.state}/backups` : ''
    await afterWrite($, text, { text: [`${text}.${backups}`, ...problems].join('\n'), tone: problems.length ? 'warning' : 'success' }, true, press)
  } catch (err) {
    show($, { mode: 'list', notice: { text: `Reset failed: ${errText(err)}`, tone: 'warning' } })
  }
}

export function paneTree($: EngineInterface, e: RenderInput<'Pane'>) {
  if (v.status === 'idle') void load($, true)
  const { Box, Text, Button, Input, Select, Markdown } = $.ui.resolve(e)
  const ps = v.state?.projects[v.root]
  const header = (
    <Box key="head" flexDirection="column">
      <Text weight="semibold" wrap="truncate-end">
        Plancia · {v.root || '…'}
      </Text>
      {v.status === 'ready' && (
        <Box key="chat" flexDirection="row" gap={1}>
          {e.surface === 'terminal' && <Box flexShrink={0}><Text dimColor>Tab moves, Enter presses, arrows scroll</Text></Box>}
          <Text dimColor wrap="truncate-end">
            {`This chat: ${v.ss ? `"${v.ss.preset ?? 'no preset'}", applied ${localStamp(v.ss.updatedAt)}` : 'same as the project default'} · id ${v.sid.slice(0, 8) || '?'}`}
          </Text>
        </Box>
      )}
      {v.status === 'ready' && (
        <Text dimColor wrap="truncate-end">
          {ps ? `Project default: "${ps.preset ?? 'no preset'}", applied ${localStamp(ps.appliedAt)}` : 'Project default: none, your own configuration is in use.'}
        </Text>
      )}
    </Box>
  )
  const noticeLines = v.notice?.text.split('\n') ?? []
  const notice = v.notice && (
    <Box key="notice" flexDirection="column">
      {noticeLines.map((line) => (
        <Text key={line} color={v.notice?.tone} wrap="wrap">
          {line}
        </Text>
      ))}
    </Box>
  )

  if (v.status !== 'ready' || !v.inv) {
    return (
      <Box flexDirection="column">
        {header}
        {v.status === 'error' ? (
          <Box flexDirection="column">
            <Text color="warning" wrap="wrap">
              Cannot read the configuration: {v.error}
            </Text>
            {v.badFile && (
              <Text dimColor wrap="wrap">
                Until then Plancia ignores its saved choices. Start over renames the file and goes on without it; what it switched off in the settings.local.json of your projects stays there.
              </Text>
            )}
            <Box flexDirection="row" gap={1}>
              <Button key="retry" label="Retry" onPress={() => load($, true)} />
              {v.badFile && <Button key="start-over" label="Start over (the file is kept)" onPress={() => startOver($)} />}
            </Box>
          </Box>
        ) : (
          <Text dimColor>Reading the configuration…</Text>
        )}
      </Box>
    )
  }

  const also = `If Claude Code does not read its settings again, touches ${v.dirs.claude}/settings.json too (content unchanged).`
  const byKey = itemsByKey()
  const nameOf = (k: string) => byKey.get(k)?.name ?? k

  if (v.mode === 'setup') {
    const first = v.inv.protectedKeys === undefined
    const ticked = [...v.ticks].filter(([, on]) => on).map(([k]) => k)
    return (
      <Box flexDirection="column">
        {header}
        <Text weight="semibold">Setup: protected items</Text>
        <Text wrap="wrap">
          Switching a protected item off asks you for one more confirmation. Proposed: the PreToolUse hooks, which can stop an action before it happens, and the rule files. Untick what needs no protection.
        </Text>
        {v.inv.warnings.map((w) => <Text key={`warning:${w}`} color="warning" wrap="wrap">{w}</Text>)}
        <Text dimColor wrap="wrap">
          {`Nothing is written until you press ${first ? 'Confirm or Skip' : 'Confirm'}. The list is kept in ${protectedPath(v.dirs.state)}${v.inv.protectedKeys === null ? ': Confirm replaces the file that is there' : ''}.`}
        </Text>
        {notice}
        <Box flexDirection="row" gap={1}>
          <Button key="setup-confirm" label={`Confirm (${plural(ticked.length, 'protected item', 'protected items')})`} variant="primary" onPress={() => saveSetup($, ticked, 'setup')} />
          {first ? (
            <Button key="setup-skip" label="Skip (protect nothing)" onPress={() => saveSetup($, [], 'list')} />
          ) : (
            <Button key="setup-cancel" label="Cancel" onPress={() => show($, { mode: 'list', notice: null })} />
          )}
        </Box>
        {v.ticks.size === 0 && <Text dimColor>No PreToolUse hook and no rule file found.</Text>}
        {[...v.ticks].map(([k, on]) => {
          const i = byKey.get(k)
          return (
            <Box key={`setuprow:${k}`} flexDirection="row" flexWrap="nowrap" gap={1}>
              <Button key={`setup:${k}`} plain label={`${on ? '☑' : '☐'} ${i?.name ?? k}`} onPress={() => show($, { ticks: new Map(v.ticks).set(k, !on) })} />
              <Text dimColor wrap="truncate-end">{i ? `${TAB_LABEL[i.category]} · ${i.category === 'rule' ? i.path : i.description}` : k.startsWith('hook:') ? 'no longer in your settings' : 'not found here: another project may have it'}</Text>
            </Box>
          )
        })}
      </Box>
    )
  }

  if (v.mode === 'reset') {
    const touched = v.state ? listTouchedProjects(v.state) : []
    return (
      <Box flexDirection="column">
        {header}
        <Box flexDirection="row" gap={1}>
          <Button key="reset-confirm" label="Reset this project" onPress={() => confirmReset($)} />
          <Button key="reset-cancel" label="Cancel" onPress={() => show($, { mode: 'list', notice: null })} />
        </Box>
        <Text wrap="wrap">
          Undoes everything Plancia wrote for this project ({ps ? `${plural(ps.entries.length, 'item', 'items')} in settings.local.json, ${plural(ps.hooksOff.length, 'hook', 'hooks')} off` : 'nothing to undo in its settings'}), and the choices of the chats in this folder: the items go back as they were without Plancia. What was changed by hand since stays.
        </Text>
        <Text dimColor wrap="wrap">
          Projects Plancia has written to: {touched.length ? touched.join(', ') : 'none'}
        </Text>
        <Text dimColor wrap="wrap">{also}</Text>
        {notice}
      </Box>
    )
  }

  if (v.mode === 'resetAll') {
    const roots = v.state ? listTouchedProjects(v.state) : []
    return (
      <Box flexDirection="column">
        {header}
        <Box flexDirection="row" gap={1}>
          {roots.length > 0 && <Button key="reset-all-confirm" label="Reset all projects" onPress={() => confirmResetAll($)} />}
          <Button key="reset-cancel" label="Cancel" onPress={() => show($, { mode: 'list', notice: null })} />
        </Box>
        {roots.length === 0 ? (
          <Text>Plancia has written to no project.</Text>
        ) : (
          <Box flexDirection="column">
            <Text wrap="wrap">
              Undoes everything Plancia wrote in every project it knows, and the choices of their chats: the items go back as they were without Plancia. What was changed by hand since stays. A project that is gone or unreadable is reported and skipped.
            </Text>
            <Text wrap="wrap">{`Projects (${roots.length}): ${roots.join(', ')}`}</Text>
            <Text dimColor wrap="wrap">{also}</Text>
            <Text dimColor wrap="wrap">{`Presets, protected items and backups stay in ${v.dirs.state}: delete that folder by hand if you no longer want them. Run this before disabling or uninstalling Plancia: that alone leaves the items switched off.`}</Text>
          </Box>
        )}
        {notice}
      </Box>
    )
  }

  if (v.mode === 'summary') {
    const chat = v.target === 'chat'
    const s = chat ? summarize(items(), v.applied, chatTarget()) : summarize(items(), v.projectApplied, v.desired)
    const names = (keys: string[]) => keys.map(nameOf).join(', ')
    const local = localSettingsPath(v.root)
    // Apply leaves out agents and plugin skills: said apart, never written for the chat.
    const kept = chat ? summarize(items(), v.applied, v.desired).changes.filter((c) => projectOnly(byKey.get(c.key)!)).map((c) => c.key) : []
    const whenChat = [...new Set(s.changes.map((c) => WHEN_CHAT[c.category]))].map((label) => ({
      label, keys: s.changes.filter((c) => WHEN_CHAT[c.category] === label).map((c) => c.key),
    }))
    const now = s.changes.filter((c) => c.timing === 'now').map((c) => c.key)
    const later = s.changes.filter((c) => c.timing === 'next-session').map((c) => c.key)
    const blocked = s.changes.filter((c) => c.blockedButVisible).map((c) => c.key)
    const onKeys = s.changes.filter((c) => c.on).map((c) => c.key)
    const offKeys = s.changes.filter((c) => !c.on && !c.protected).map((c) => c.key)
    const canConfirm = s.changes.length > 0 && (!s.needsConfirmation || v.protectedOk)
    return (
      <Box flexDirection="column">
        {header}
        <Text weight="semibold">{chat ? `Summary: apply "${v.selected}" to this chat` : `Summary: make "${v.selected}" the project default`}</Text>
        {s.protected.length > 0 && (
          <Box flexDirection="column">
            <Text color="error" wrap="wrap">
              {`Protected items being switched off (${s.protected.length}): ${s.protected.map((c) => `${c.name} (${TAB_LABEL[c.category]})`).join(', ')}`}
            </Text>
            <Button key="protected-ok" label={`${v.protectedOk ? '☑' : '☐'} I confirm: switch off ${plural(s.protected.length, 'protected item', 'protected items')}`} onPress={() => show($, { protectedOk: !v.protectedOk })} />
          </Box>
        )}
        <Box flexDirection="row" gap={1}>
          {canConfirm && <Button key="confirm" label="Confirm" variant="primary" onPress={() => (chat ? confirmChat($) : confirmApply($))} />}
          <Button key="cancel" label="Cancel" onPress={() => show($, { mode: 'list', protectedOk: false })} />
        </Box>
        {s.changes.length === 0 && <Text>No difference from what is already applied.</Text>}
        {onKeys.length > 0 && <Text wrap="wrap">Switching on ({onKeys.length}): {names(onKeys)}</Text>}
        {offKeys.length > 0 && <Text wrap="wrap">Switching off ({offKeys.length}): {names(offKeys)}</Text>}
        {chat && whenChat.map((w) => <Text key={`when:${w.label}`} dimColor wrap="wrap">{`${w.label}: ${names(w.keys)}`}</Text>)}
        {chat && kept.length > 0 && (
          <Text dimColor wrap="wrap">{`Stay as in the project default (agents, plugin skills and plugins synced from claude.ai change with Make default): ${names(kept)}`}</Text>
        )}
        {!chat && now.length > 0 && <Text dimColor wrap="wrap">Now: {names(now)}</Text>}
        {!chat && later.length > 0 && <Text dimColor wrap="wrap">From the next session (MCP, rules, hooks): {names(later)}</Text>}
        {!chat && blocked.length > 0 && <Text dimColor wrap="wrap">Blocked, but the model still sees them listed: {names(blocked)}</Text>}
        {!chat && v.root === v.dirs.home && (
          <Text color="warning" wrap="wrap">
            Session in ~: the choices go to ~/.claude/settings.local.json and hold for every session opened in your home folder.
          </Text>
        )}
        <Text dimColor wrap="wrap">
          {chat
            ? `Only for this chat: writes its choice to ${statePath(v.dirs.state)}, then touches ${local} (content unchanged; created as {} if missing) so that Claude Code reads the settings again. ${also}`
            : `Becomes the project default, for new chats and this one. Writes ${local} (backup first, in ${v.dirs.state}/backups/) and the state in ${statePath(v.dirs.state)}. ${also}`}
        </Text>
        {notice}
      </Box>
    )
  }

  // ---- list mode
  const all = listPresets(v.user)
  const presetRow = (
    <Box key="presets" flexDirection="row" gap={1} flexWrap="wrap">
      <Text>Preset:</Text>
      {all.length > 5 ? (
        <Select key="preset-select" options={all.map((p) => ({ value: p.name, label: p.name }))} value={v.selected} onSelect={(name) => selectPreset($, name)} />
      ) : (
        all.map((p) => (
          <Button
            key={`preset:${p.name}`}
            label={p.name === v.selected ? `● ${p.name}` : p.name}
            {...(p.name === v.selected ? { variant: 'primary' as const } : {})}
            onPress={() => selectPreset($, p.name)}
          />
        ))
      )}
      {userPreset(v.selected) && v.mode !== 'delete' && (
        <Button key="preset-delete" label="Delete" plain dimColor onPress={() => show($, { mode: 'delete', notice: null })} />
      )}
    </Box>
  )
  const shownOn = withImports(items(), v.desired)
  const tabRow = (
    <Box key="tabs" flexDirection="row" columnGap={2} flexWrap="wrap">
      {CATEGORIES.map((c, n) => {
        const inCat = items().filter((i) => i.category === c)
        const onCount = inCat.filter((i) => shownOn.get(itemKey(i))).length
        return (
          <Button
            key={`tab:${c}`}
            plain
            hotkey={String(n + 1)}
            dimColor={c !== v.tab}
            label={`${c === v.tab ? '▸ ' : ''}${TAB_LABEL[c]} ${onCount}/${inCat.length}`}
            onPress={() => show($, { tab: c, page: 0, detail: null })}
          />
        )
      })}
    </Box>
  )
  const search = (
    <Input
      key={`search:${v.tab}`}
      label="Search"
      placeholder="name or description"
      value={v.query[v.tab]}
      onInput={(q) => show($, { query: { ...v.query, [v.tab]: q }, page: 0 })}
      onSubmit={(q) => show($, { query: { ...v.query, [v.tab]: q }, page: 0 })}
    />
  )

  const marks = diffKeys(v.desired, reference())
  const shown = items().filter((i) => i.category === v.tab && matches(i, v.query[v.tab]))
  // The footer stays in view: the list gets the rows the pane has left (a pane scrolls as a whole).
  const bodyRows = e.props.scroll?.bodyRows ?? 20
  // The items of this tab that Apply leaves alone
  const wholeProject = v.tab === 'agent' ? 'Agents' : v.tab === 'plugin' && items().some((i) => i.category === 'plugin' && projectOnly(i)) ? 'Plugins synced from claude.ai' : ''
  const fixed = 11 + (wholeProject ? 1 : 0) + (v.notice ? 1 + noticeLines.length : 0) + (v.inv.warnings.length ? 1 : 0) + (e.surface === 'terminal' ? 0 : 2)
  // The user's height, as far as the pane leaves room for it.
  // The terminal's pane has bodyRows rows; a graphical surface (VS Code) grows the pane, so there the chosen rows hold.
  const pageSize = e.surface === 'terminal' ? Math.max(PANEL_ROWS.min, Math.min(v.rows, bodyRows - fixed)) : v.rows
  const pages = Math.max(1, Math.ceil(shown.length / pageSize))
  const page = Math.min(v.page, pages - 1)
  const rows = shown.slice(page * pageSize, (page + 1) * pageSize)
  const detail = v.detail ? byKey.get(v.detail) : undefined

  const list = detail ? (
    <Box key="detail" flexDirection="column" borderStyle="round" paddingX={1}>
      <Text weight="semibold">
        {detail.name} · {TAB_LABEL[detail.category]}
      </Text>
      <Text wrap="wrap">{detail.description || '(no description)'}</Text>
      <Text dimColor wrap="wrap">Source: {detail.source}</Text>
      <Text dimColor wrap="wrap">Path: {detail.path || '—'}</Text>
      <Text dimColor wrap="wrap">Id: {detail.id}</Text>
      {detail.locked && <Text dimColor>{LOCK[detail.locked].detail}</Text>}
      {detail.protected && <Text color="error">Protected: switching it off asks for an extra confirmation.</Text>}
      <Button key="detail-close" label="Close" onPress={() => show($, { detail: null })} />
    </Box>
  ) : rows.length === 0 ? (
    <Text key="empty" dimColor>
      {v.query[v.tab].trim() ? `No item matches "${v.query[v.tab].trim()}".` : 'No items in this category.'}
    </Text>
  ) : (
    <Box key="list" flexDirection="column">
      {rows.map((i) => {
        const k = itemKey(i)
        const on = v.desired.get(k) ?? i.on
        // A rule loaded only through imports goes with the rules that import it
        const offByImports = offByImport(i, shownOn)
        return (
          <Box key={`row:${k}`} flexDirection="row" flexWrap="nowrap" gap={1}>
            {offByImports ? (
              <Text dimColor>[off]</Text>
            ) : i.locked ? (
              <Text dimColor>{LOCK[i.locked].tag}</Text>
            ) : (
              <Button key={`toggle:${k}`} label={on ? 'on' : 'off'} onPress={() => show($, { desired: new Map(v.desired).set(k, !on) })} />
            )}
            {e.surface === 'terminal' ? (
              <Button key={`name:${k}`} plain label={i.name} onPress={() => show($, { detail: k })} />
            ) : (
              // A graphical surface draws every Button as a native one: the name, a link, stays apart from the switch.
              // There the Markdown is width:100%: in its own unshrinking Box it is as wide as the name.
              <Box key={`namebox:${k}`} flexShrink={0}>
                <Markdown key={`name:${k}`} text={`[${mdEscape(i.name)}](${tipHref(i.description)})`} onLinkPress={() => show($, { detail: k })} />
              </Box>
            )}
            {marks.has(k) && <Text>◆</Text>}
            {i.protected && <Text color="error">protected</Text>}
            <Text dimColor wrap="truncate-end">
              {offByImports ? 'imported only by rules that are off · ' : i.locked ? `${LOCK[i.locked].row} · ` : ''}
              {oneLine(i.description)}
            </Text>
          </Box>
        )
      })}
    </Box>
  )
  const pager = pages > 1 && !detail && (
    <Box key="pager" flexDirection="row" gap={1}>
      {page > 0 && <Button key="page-prev" label="◀" plain onPress={() => show($, { page: page - 1 })} />}
      <Text dimColor>
        page {page + 1}/{pages} · {plural(shown.length, 'item', 'items')}
      </Text>
      {page < pages - 1 && <Button key="page-next" label="▶" plain onPress={() => show($, { page: page + 1 })} />}
    </Box>
  )

  const bulk = (
    <Box key="bulk" flexDirection="row" gap={2} flexWrap="wrap">
      {shown.length > 0 && !detail && (
        <Box flexDirection="row" gap={2}>
          <Button key="all-on" plain hotkey="n" label="All on" onPress={() => show($, { desired: setCategory(items(), v.desired, v.tab, shown.map((i) => i.id), true) })} />
          <Button key="all-off" plain hotkey="f" label="All off" onPress={() => show($, { desired: setCategory(items(), v.desired, v.tab, shown.map((i) => i.id), false) })} />
        </Box>
      )}
      <Text dimColor>List: {v.rows} rows</Text>
      <Button key="rows-up" plain hotkey="t" label="Taller" onPress={() => setRows($, ROWS_STEP)} />
      <Button key="rows-down" plain hotkey="s" label="Shorter" onPress={() => setRows($, -ROWS_STEP)} />
    </Box>
  )
  const s = summarize(items(), v.applied, v.desired)
  const onKeys = s.changes.filter((c) => c.on).map((c) => nameOf(c.key))
  const offKeys = s.changes.filter((c) => !c.on).map((c) => nameOf(c.key))
  const changeParts = [
    onKeys.length ? `switching on ${onKeys.length} (${onKeys.join(', ')})` : '',
    offKeys.length ? `switching off ${offKeys.length} (${offKeys.join(', ')})` : '',
    s.protected.length ? `${s.protected.length} protected: needs the extra confirmation` : '',
  ].filter(Boolean)
  const changes = (
    <Text key="changes" color={s.protected.length ? 'error' : undefined} dimColor={!changeParts.length} wrap="truncate-end">
      {changeParts.length ? `Changes: ${changeParts.join(' · ')}` : 'Changes: none from what is applied.'}
    </Text>
  )

  const n = unsaved()
  const footer =
    v.mode === 'saveAs' ? (
      <Box key="foot" flexDirection="row" gap={1}>
        <Input key="save-name" label={`Name of the new preset (based on "${v.selected}")`} placeholder="e.g. Light" value="" submitLabel="Save" onSubmit={(name) => saveAs($, name)} />
        <Button key="save-cancel" label="Cancel" onPress={() => show($, { mode: 'list', notice: null })} />
      </Box>
    ) : v.mode === 'delete' ? (
      <Box key="foot" flexDirection="row" gap={1}>
        <Text>Delete the preset "{v.selected}"?</Text>
        <Button key="delete-confirm" label="Delete" onPress={() => removePreset($)} />
        <Button key="delete-cancel" label="Cancel" onPress={() => show($, { mode: 'list' })} />
      </Box>
    ) : (
      <Box key="foot" flexDirection="row" gap={1} flexWrap="wrap">
        <Text color={n ? 'warning' : undefined}>{n ? plural(n, 'unsaved change', 'unsaved changes') : 'No unsaved changes'}</Text>
        <Button key="apply" label="Apply" variant="primary" onPress={() => startSummary($, 'chat')} />
        <Button key="make-default" label="Make default" onPress={() => startSummary($, 'project')} />
        <Button key="save" label="Save" onPress={() => save($)} />
        <Button key="save-as" label="Save as…" onPress={() => nameIt($)} />
        <Button key="undo" label="↺ Discard changes" onPress={() => show($, { desired: resolved(v.selected), notice: null })} />
      </Box>
    )

  return (
    <Box flexDirection="column">
      {header}
      {presetRow}
      {tabRow}
      {search}
      {v.inv.warnings.length > 0 && (
        <Text color="warning" wrap="truncate-end">
          Warning: {v.inv.warnings.join('; ')}
        </Text>
      )}
      {bulk}
      {wholeProject && (
        <Text key="project-note" dimColor wrap="wrap">
          {`${wholeProject} are set for the whole project: change them with Make default.`}
        </Text>
      )}
      {list}
      {pager}
      {changes}
      {notice}
      {footer}
    </Box>
  )
}
