// Reads every source and lists the items of the 6 categories with today's baseline state.
// Read-only: uses only Fs.readText and Fs.list.
import type { Category, Ctx, Item, Mechanism, StateMap } from './types.js';
import { itemKey, localSettingsPath } from './types.js';
import { readState, retractAll } from './merge.js';
import { hookId, hookLabel, hookLine, hookScript, LOCKED_EVENTS } from './hooks.js';
import { hookName, lostHooks, protectedPath, readProtected } from './protected.js';
import {
  asList, asObj, basename, dirname, expandHome, firstLine, globMatch, isObj, parseFrontmatter, parseJson, slug, stripExt,
} from './util.js';

/** Plancia never lists itself. */
const SELF_PLUGIN = 'plancia';

export interface Inventory {
  root: string;
  localPath: string;
  items: Item[];
  /** Sources that exist but could not be read or parsed: skipped. */
  warnings: string[];
  /** The protected list as it is on disk (readProtected). */
  protectedKeys: string[] | null | undefined;
}

const IMPORT_DEPTH = 5;
// shortcut: rules nested deeper are not listed, and a folder linked to its parent lists its files that many times; follow links by their target if it matters.
const RULES_DEPTH = 5;

/** `@path` imports of a CLAUDE.md, outside code fences and inline code. */
function parseImports(text: string): string[] {
  const body = text.replace(/\r\n/g, '\n').replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  const out: string[] = [];
  for (const m of body.matchAll(/(?:^|\s)@([^\s`]+)/g)) {
    const p = m[1]!.replace(/[),.;:]+$/, '');
    if (/^(~\/|\/|\.\.?\/)/.test(p) || p.includes('/') || p.endsWith('.md')) out.push(p);
  }
  return out;
}

export async function readInventory(ctx: Ctx): Promise<Inventory> {
  const { home, claude, root } = ctx;
  // Claude Code's own folder is the user layer, not a project's one too
  const isHome = `${root}/.claude` === claude;
  const warnings: string[] = [];
  const skip = (path: string) => (e: Error) => {
    warnings.push(`${path} cannot be read, skipped (${e.message})`);
    return null;
  };
  const fs = { readText: (p: string) => ctx.fs.readText(p).catch(skip(p)), list: (p: string) => ctx.fs.list(p).catch(skip(p)) };
  const json = async (path: string): Promise<any> => {
    // trim: an empty file holds nothing, and a byte order mark is no error
    const p = parseJson((await fs.readText(path))?.trim() || null);
    if (!p.ok) {
      warnings.push(`${path} is not valid JSON`);
      return undefined;
    }
    return p.value;
  };

  // settings layers: user, project (shared), local without plancia's own entries
  const user = asObj(await json(`${claude}/settings.json`));
  const project = isHome ? {} : asObj(await json(`${root}/.claude/settings.json`));
  const localPath = localSettingsPath(root);
  let local = asObj(await json(localPath));
  try {
    local = retractAll(local, (await readState(ctx.fs, ctx.state)).projects[root]).local;
  } catch (e) {
    warnings.push((e as Error).message);
  }
  const layers = [user, project, local];
  const merged = (key: string) => Object.assign({}, ...layers.map((l) => asObj(l[key])));
  const listAll = (get: (l: Record<string, any>) => unknown) => layers.flatMap((l) => asList(get(l)));
  const scalar = (key: string) => layers.reduce<unknown>((v, l) => (l[key] !== undefined ? l[key] : v), undefined);

  const cfgs = [asObj(await json(ctx.claudeJson)), asObj(await json(`${claude}/.config.json`))];
  const cfgProject = cfgs.map((c) => asObj(asObj(c.projects)[root]));

  const protectedKeys = await readProtected(ctx.fs, ctx.state);
  if (protectedKeys === null) warnings.push(`${protectedPath(ctx.state)} is not valid: every hook and rule counts as protected until /plancia setup writes it again`);
  const isProtected = (category: Category, k: string) => (protectedKeys === null ? category === 'hook' || category === 'rule' : !!protectedKeys?.includes(k));
  const items = new Map<string, Item>();
  const add = (category: Category, id: string, f: Omit<Item, 'category' | 'id' | 'protected' | 'locked'> & { locked?: Item['locked'] }) => {
    const k = `${category}:${id}`;
    if (!items.has(k)) items.set(k, { category, id, protected: isProtected(category, k), locked: null, ...f });
  };

  // ---- skills and agents
  const deny = new Set(listAll((l) => asObj(l.permissions).deny).filter((v): v is string => typeof v === 'string'));
  const overrides = merged('skillOverrides');
  const skill = (id: string, name: string, description: string, source: string, path: string, mech: Mechanism) => {
    const denied = deny.has(`Skill(${id})`);
    const on = !denied && (mech.kind !== 'skillOverride' || overrides[id] !== 'off');
    add('skill', id, { name, description, source, path, on, locked: denied ? 'user' : null, mech });
  };
  const skillDirs = async (dir: string, each: (id: string, fm: Record<string, string>, path: string) => void) => {
    for (const d of (await fs.list(dir)) ?? []) {
      if (d === 'synced' || d.startsWith('.')) continue;
      const path = `${dir}/${d}/SKILL.md`;
      const text = await fs.readText(path);
      if (text === null) continue;
      const fm = parseFrontmatter(text);
      each(fm.name || d, fm, path);
    }
  };
  if (!isHome) await skillDirs(`${root}/.claude/skills`, (id, fm, path) => skill(id, id, fm.description ?? '', 'project', path, { kind: 'skillOverride' }));
  await skillDirs(`${claude}/skills`, (id, fm, path) => skill(id, id, fm.description ?? '', 'user', path, { kind: 'skillOverride' }));
  // slash commands (*.md) are listed as skills too; switched with skillOverrides like the user's skills
  const commandDir = async (dir: string, source: string) => {
    for (const f of (await fs.list(dir)) ?? []) {
      if (!f.endsWith('.md')) continue;
      const path = `${dir}/${f}`;
      const text = (await fs.readText(path)) ?? '';
      const id = stripExt(f);
      skill(id, id, parseFrontmatter(text).description ?? firstLine(text), source, path, { kind: 'skillOverride' });
    }
  };
  if (!isHome) await commandDir(`${root}/.claude/commands`, 'project-command');
  await commandDir(`${claude}/commands`, 'user-command');

  // synced from claude.ai: bucket <organizationUuid>_<accountUuid> of the logged-in account
  const acc = cfgs.map((c) => asObj(c.oauthAccount)).find((a) => a.accountUuid);
  const syncedBucket = async (dir: string) => {
    const buckets = ((await fs.list(dir)) ?? []).filter((b) => !b.startsWith('.'));
    const bucket = acc ? buckets.find((b) => b === `${acc.organizationUuid}_${acc.accountUuid}`) : buckets.length === 1 ? buckets[0] : undefined;
    return bucket && `${dir}/${bucket}`;
  };
  const syncedSkills = await syncedBucket(`${claude}/skills/synced`); // anthropic-skills:<name>
  if (syncedSkills) {
    await skillDirs(syncedSkills, (id, fm, path) =>
      skill(`anthropic-skills:${id}`, id, fm.description ?? '', 'synced', path, { kind: 'skillOverride' }));
  }

  // ---- plugins and their skills
  const enabled = merged('enabledPlugins');
  const installed = asObj(asObj(await json(`${claude}/plugins/installed_plugins.json`)).plugins);
  const manifestOf = async (path: string) => asObj((await json(`${path}/.claude-plugin/plugin.json`)) ?? (await json(`${path}/plugin.json`)));
  const plugin = async (id: string, pname: string, manifest: Record<string, any>, source: string, ip: string, on: boolean, locked: Item['locked'] = null) => {
    add('plugin', id, { name: pname, description: String(manifest.description ?? ''), source, path: ip, on, locked, mech: { kind: 'plugin' } });
    if (!on) return;
    await skillDirs(`${ip}/skills`, (sid, fm, path) =>
      skill(`${pname}:${sid}`, sid, fm.description ?? '', `plugin:${id}`, path, { kind: 'denySkill' }));
    for (const f of (await fs.list(`${ip}/commands`)) ?? []) {
      if (!f.endsWith('.md')) continue;
      const path = `${ip}/commands/${f}`;
      const fm = parseFrontmatter((await fs.readText(path)) ?? '');
      skill(`${pname}:${stripExt(f)}`, stripExt(f), fm.description ?? '', `plugin:${id}`, path, { kind: 'denySkill' });
    }
  };
  for (const [id, entries] of Object.entries(installed)) {
    const pname = id.split('@')[0]!;
    if (pname === SELF_PLUGIN) continue;
    const inst = asList(entries).map(asObj).find((e) => e.scope === 'user' || e.projectPath === root);
    if (!inst || typeof inst.installPath !== 'string') continue;
    const ip: string = inst.installPath;
    await plugin(id, pname, await manifestOf(ip), 'user', ip, enabled[id] === true);
  }
  // Synced: what manifest.json lists, in its generation's folder; on unless something says off (Claude Code 2.1.332)
  const syncedPlugins = await syncedBucket(`${claude}/plugins/synced`);
  for (const row of syncedPlugins ? asList(asObj(await json(`${syncedPlugins}/manifest.json`)).plugins).map(asObj) : []) {
    if (typeof row.name !== 'string' || typeof (row.generation ?? 0) === 'object') continue;
    const path = `${syncedPlugins}/${row.name}${row.generation ? `~g${row.generation}` : ''}`;
    const manifest = await manifestOf(path);
    const id = `${manifest.name}@synced`;
    if (typeof manifest.name !== 'string' || manifest.name === SELF_PLUGIN || items.has(`plugin:${id}`)) continue;
    const required = row.installationPreference === 'required';
    await plugin(id, manifest.name, manifest, 'synced', path, required || (enabled[id] ?? manifest.defaultEnabled) !== false, required ? 'required' : null);
  }

  // ---- MCP servers
  const deniedMcp = new Set(listAll((l) => l.deniedMcpServers).map((d) => asObj(d).serverName).filter((n): n is string => typeof n === 'string'));
  const describe = (s: any) => {
    const o = asObj(s);
    const kind = o.type ?? (o.url ? 'http' : 'stdio');
    return typeof o.command === 'string' ? `${kind}: ${basename(o.command)}` : String(kind);
  };
  const mcpjson = asObj(asObj(await json(`${root}/.mcp.json`)).mcpServers);
  const disabledJson = new Set([...listAll((l) => l.disabledMcpjsonServers), ...cfgProject.flatMap((p) => asList(p.disabledMcpjsonServers))]);
  const enabledJson = new Set([...listAll((l) => l.enabledMcpjsonServers), ...cfgProject.flatMap((p) => asList(p.enabledMcpjsonServers))]);
  const enableAll = scalar('enableAllProjectMcpServers') === true || cfgProject.some((p) => p.enableAllProjectMcpServers === true);
  for (const [name, s] of Object.entries(mcpjson)) {
    const locked = disabledJson.has(name) || deniedMcp.has(name);
    add('mcp', name, {
      name, description: describe(s), source: 'project', path: `${root}/.mcp.json`,
      on: !locked && (enableAll || enabledJson.has(name)), locked: locked ? 'user' : null, mech: { kind: 'mcpjson' },
    });
  }
  const denyItem = (name: string, s: unknown, source: string, path: string) =>
    add('mcp', name, { name, description: s === null ? 'claude.ai connector' : describe(s), source, path, on: !deniedMcp.has(name), locked: deniedMcp.has(name) ? 'user' : null, mech: { kind: 'mcpDeny' } });
  const cfgPaths = [ctx.claudeJson, `${claude}/.config.json`];
  cfgProject.forEach((p, i) => { for (const [n, s] of Object.entries(asObj(p.mcpServers))) denyItem(n, s, 'local', cfgPaths[i]!); });
  cfgs.forEach((c, i) => { for (const [n, s] of Object.entries(asObj(c.mcpServers))) denyItem(n, s, 'user', cfgPaths[i]!); });
  const connectors = [...cfgs.flatMap((c) => asList(c.claudeAiMcpEverConnected)), ...deniedMcp].filter((n): n is string => typeof n === 'string' && n.startsWith('claude.ai '));
  for (const n of connectors) denyItem(n, null, 'connector', '');

  // ---- agents
  const agentDir = async (dir: string, source: string) => {
    for (const f of (await fs.list(dir)) ?? []) {
      if (!f.endsWith('.md')) continue;
      const path = `${dir}/${f}`;
      const fm = parseFrontmatter((await fs.readText(path)) ?? '');
      const id = fm.name || stripExt(f);
      const denied = deny.has(`Agent(${id})`);
      add('agent', id, { name: id, description: fm.description ?? '', source, path, on: !denied, locked: denied ? 'user' : null, mech: { kind: 'denyAgent' } });
    }
  };
  if (!isHome) await agentDir(`${root}/.claude/agents`, 'project');
  await agentDir(`${claude}/agents`, 'user');

  // ---- rules: CLAUDE.md files, their @imports, .claude/rules, auto-memory
  const excludes = listAll((l) => l.claudeMdExcludes).filter((g): g is string => typeof g === 'string').map((g) => expandHome(g, home, root));
  const excluded = (p: string) => excludes.some((g) => globMatch(g, p));
  const importers = new Map<string, Set<string>>(); // imported path → paths that import it
  const direct = new Set<string>();                  // rules loaded on their own, not only through an import
  const rule = async (path: string, source: string, parentOn: boolean, depth: number, from?: string): Promise<void> => {
    if (from) importers.set(path, (importers.get(path) ?? new Set()).add(from));
    else direct.add(path);
    const on = parentOn && !excluded(path);
    const known = items.get(`rule:${path}`);
    if (known?.on || (known && !on)) return;
    const text = await fs.readText(path);
    if (text === null) return;
    // off by the one importer met first, on by this one
    if (known) Object.assign(known, { on, locked: null });
    else add('rule', path, { name: basename(path), description: firstLine(text), source, path, on, locked: on ? null : 'user', mech: { kind: 'claudeMdExclude' } });
    if (depth >= IMPORT_DEPTH) return;
    for (const imp of parseImports(text)) await rule(expandHome(imp, home, dirname(path)), 'import', on, depth + 1, path);
  };
  const rulesDir = async (dir: string, source: string, depth = 0): Promise<void> => {
    for (const f of ((await fs.list(dir)) ?? []).sort()) {
      if (f.endsWith('.md')) await rule(`${dir}/${f}`, source, true, 0);
      else if (!f.startsWith('.') && depth < RULES_DEPTH) await rulesDir(`${dir}/${f}`, source, depth + 1);
    }
  };
  await rule(`${claude}/CLAUDE.md`, 'user', true, 0);
  await rulesDir(`${claude}/rules`, 'user');
  for (const f of ['CLAUDE.md', ...(isHome ? [] : ['.claude/CLAUDE.md']), 'CLAUDE.local.md']) await rule(`${root}/${f}`, 'project', true, 0);
  if (!isHome) await rulesDir(`${root}/.claude/rules`, 'project');
  for (let d = dirname(root); ; d = dirname(d)) {
    for (const f of ['CLAUDE.md', 'CLAUDE.local.md']) await rule(`${d === '/' ? '' : d}/${f}`, 'ancestor', true, 0);
    if (d === '/') break;
  }
  // Excluding a rule drops its imports, so a rule that imports a protected one (at any depth) is protected too
  for (let grew = true; grew; ) {
    grew = false;
    for (const [path, from] of importers) {
      if (!items.get(`rule:${path}`)?.protected) continue;
      for (const f of from) {
        const it = items.get(`rule:${f}`);
        if (it && !it.protected) { it.protected = true; grew = true; }
      }
    }
  }
  for (const [path, from] of importers) {
    const it = items.get(`rule:${path}`);
    if (it && !direct.has(path)) it.importedBy = [...from].filter((f) => items.has(`rule:${f}`)).map((f) => `rule:${f}`).sort();
  }

  const memDir = typeof scalar('autoMemoryDirectory') === 'string'
    ? expandHome(scalar('autoMemoryDirectory') as string, home, root)
    : `${claude}/projects/${slug(root)}/memory`;
  const memPath = `${memDir}/MEMORY.md`;
  add('rule', memPath, {
    name: 'MEMORY.md (auto memory)', description: firstLine((await fs.readText(memPath)) ?? 'auto memory'), source: 'memory',
    path: memPath, on: scalar('autoMemoryEnabled') !== false, mech: { kind: 'autoMemory' },
  });

  // ---- hooks of the user settings
  const sameName = new Map<string, { item: Item; line: string }[]>();
  for (const [event, groups] of Object.entries(asObj(user.hooks))) {
    for (const g of asList(groups).map(asObj)) {
      for (const h of asList(g.hooks).map(asObj)) {
        const id = hookId(event, h);
        const script = hookScript(h);
        const label = hookLabel(h);
        const name = script ? stripExt(label) : label.length > 60 ? `${label.slice(0, 59)}…` : label;
        const where = `${event}${g.matcher ? ` (${g.matcher})` : ''}`;
        const prev = items.get(`hook:${id}`);
        if (prev) { prev.description += `, ${g.matcher ?? '*'}`; continue; }
        add('hook', id, {
          name, description: where, source: 'settings', path: script && expandHome(script, home, home),
          on: true, locked: LOCKED_EVENTS.includes(event) ? 'session-start' : null, mech: { kind: 'hook', event },
        });
        const line = hookLine(h) || String(h.prompt ?? h.url ?? h.tool ?? '');
        sameName.set(name, [...(sameName.get(name) ?? []), { item: items.get(`hook:${id}`)!, line }]);
      }
    }
  }

  for (const same of sameName.values()) {
    if (same.length > 1) same.forEach(({ item, line }, n) => { item.name += ` (${n + 1})`; item.description += ` · ${line.replaceAll(`${home}/`, '~/')}`; });
  }

  // What was protected and is not there any more is said, before the rest. Of the other kinds another project may have it.
  const gone: string[] = [];
  for (const k of protectedKeys ?? []) {
    const path = k.startsWith('rule:') && !items.has(k) ? k.slice(5) : '';
    if (path && !path.endsWith('/MEMORY.md') && (await ctx.fs.readText(path).catch(() => '')) === null) {
      gone.push(`The protected rule file ${path.replace(`${home}/`, '~/')} is gone: under another name it is not protected, see /plancia setup`);
    }
  }
  const unread = warnings.some((w) => w.startsWith(`${claude}/settings.json `));
  for (const [k, now] of unread ? [] : lostHooks([...items.values()], protectedKeys)) {
    for (const n of now) items.get(n)!.protected = true;
    gone.push(`The protected hook ${hookName(k)} ${now.length
      ? 'changed: as it is now it counts as protected until you confirm it in /plancia setup'
      : 'is no longer in your settings: in another form (script, event) it is not protected, see /plancia setup'}`);
  }
  warnings.unshift(...gone);

  // a plugin switched off takes its protected skills along
  for (const i of items.values()) {
    const plugin = i.protected ? items.get(i.source) : undefined;
    if (plugin) plugin.protected = true;
  }
  return { root, localPath, items: [...items.values()], warnings, protectedKeys };
}

/**
 * What the pane shows: `desired`, with every rule loaded only through imports switched off when none of its
 * importers is on (excluding a CLAUDE.md drops what it imports). Least fixed point: import cycles stay off.
 */
export function withImports(items: Item[], desired: StateMap): StateMap {
  const out: StateMap = new Map(desired);
  const imported = items.filter((i) => i.category === 'rule' && i.importedBy);
  const want = new Map(imported.map((i) => [itemKey(i), desired.get(itemKey(i)) ?? i.on]));
  for (const i of imported) out.set(itemKey(i), false);
  for (let grew = true; grew; ) {
    grew = false;
    for (const i of imported) {
      const k = itemKey(i);
      if (out.get(k) || !want.get(k)) continue;
      if (i.importedBy!.some((p) => out.get(p) ?? items.find((x) => itemKey(x) === p)?.on)) { out.set(k, true); grew = true; }
    }
  }
  return out;
}
