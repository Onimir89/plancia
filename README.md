# Plancia

A control panel for Claude Code: choose per project, or per chat, which skills, plugins, MCP servers, subagents, rule files and hooks are on, and keep the choice as presets.

> **Before you disable or uninstall Plancia, run `/plancia reset --all`.** What you switched off with Make default is written in each project's `.claude/settings.local.json` and stays off without Plancia.

- Switch items one by one, or all those a search shows.
- Apply a choice to this chat only, or make it the project's default.
- See a summary, and confirm it, before anything is written.
- Mark hooks and rule files as protected: switching them off takes an extra confirmation.
- Undo everything Plancia wrote, in one project or in all of them.

## Requirements

- Linux or WSL. On macOS and native Windows Plancia says it needs Linux or WSL and does nothing else.
- Claude Code 2.1.326 or later.

## Install

```
/plugin marketplace add Onimir89/plancia
/plugin install plancia@plancia
```

Then `/reload-plugins`, or start a new session.

## First run

`/plancia` opens the panel. The first time, it lists the items it proposes to protect: your `PreToolUse` hooks and your rule files, all checked. Confirm saves the list, Skip protects nothing. Nothing is written before you click one of them. `/plancia setup` brings the list back at any time.

A protected hook is known by its whole command. When you change the command, the panel warns and counts the new one, same script and event, as protected until you confirm it in `/plancia setup`. It also warns when a protected hook or rule file is gone. It cannot tell for items of other kinds: another project may have them.

## The panel

| Key | What it does |
|---|---|
| `1`–`6` | Tab: Skills, Plugins, MCP, Agents, Rules, Hooks |
| `n` / `f` | All on / All off, for the items the search shows |
| `t` / `s` | Taller / Shorter list |
| `Tab`, `Enter` | To the next button, press it |
| Arrows, `PageUp`, `PageDown` | Scroll |
| `Esc` | Close |

The letters and digits are buttons too; where the keys do not work (VS Code), click. `Ctrl+X Tab` moves from the prompt to the row above it, where `Enter` opens the panel.

- Click a name for its detail. `◆` marks a difference from the preset's parent, `protected` in red a protected item, `[locked]` one Plancia cannot switch.
- Presets: **Default** is your configuration without Plancia; **Minimal** switches off every item of the six tabs that can be switched. Plancia, the locked items and what no tab lists stay: built-in skills and agents, the hooks of projects, `CLAUDE.md` files in subfolders. Applied to a chat it leaves subagents, skills of plugins and plugins synced from claude.ai to the project's default. Save as… makes your own: it keeps its differences from the preset it starts from.
- **Apply** is for this chat only. **Make default** is for this project: new chats, and this one.
- A chat's choice follows it through `/clear` and `/branch`, comes back with `/resume`, and expires after 30 days.

### When a choice takes effect

| | Apply (this chat) | Make default (project) |
|---|---|---|
| Skills | now | now |
| MCP servers | from your next message | from the next session |
| Hooks | now | from the next session |
| Plugins | after `/reload-plugins`: Plancia runs it in the terminal, you type it in VS Code | the same |
| Rule files | from the next conversation (`/clear`) | from the next session |
| Subagents, skills of plugins | no choice per chat: they follow the project's default | now |
| Plugins synced from claude.ai | no choice per chat: Claude Code loads them whatever a chat chooses | after `/reload-plugins`, as the other plugins |

- The band counts your choices, not what is loaded.
- If Claude Code has not read its settings again about 8 seconds after a press that writes (waiting for another window included), the panel and a toast say so: the change waits for that, at the latest for a restart of the session.
- Plugins synced from claude.ai are read from their folder: seen in the chat of VS Code (2.1.332), Claude Code had not loaded them, and the panel lists them as on.
- An MCP server switched off for a chat that has already started stays connected, and listed in `/mcp`: from your next message Claude no longer has its tools.
- Subagents and skills of plugins that are off are blocked, but Claude still sees them listed.
- `SessionStart` hooks cannot be switched off: they run before Plancia can act.
- Only the hooks of your own `settings.json` are listed, not those of projects or plugins. A project or plugin hook stays on, even with the same command as one you switched off.

## Undo

- `/plancia reset`: takes back what Plancia wrote for this project.
- `/plancia reset --all`: the same for every project. It counts the projects reset and names only the others, such as a project whose folder is gone.

The settings come back, not the layout of the file: Plancia rewrites it as JSON with two-space indents, and an integer beyond 2^53 loses its last digits. Its permissions stay; its backup holds the file as it was.

Settings you wrote or changed by hand stay. Presets, protected items and backups stay too: to remove them, delete Plancia's folder.

## Where the files are

- Plancia's own: `${XDG_CONFIG_HOME:-~/.config}/plancia/`, with `state.json`, `presets.json`, `protected.json`, `panel.json` and `backups/` (the last 5 of each project's local settings).
- In a project: only `.claude/settings.local.json`. Apply creates it as `{}` when it is missing: Claude Code reads the settings again only when a settings file changes.
- When Claude Code has not done so half-way through the wait, at most 4 seconds, Plancia touches your own `settings.json` (`touch -c`: the content stays as it is, every open session reads it again). Claude Code stops watching a project's `.claude/` once it has been removed, as a reset does with the one Plancia made.
- `CLAUDE_CONFIG_DIR` is followed. Files that are symbolic links are written through the link.
- Plancia makes no network request and installs no package.

## Update

```
claude plugin marketplace update plancia
claude plugin update plancia@plancia
```

## Limits

- Claude's Write, Edit, MultiEdit and NotebookEdit tools cannot change Plancia's folder. Bash can: Plancia does not inspect shell commands.
- That guard follows symbolic links in the path it is given, knows the folder by its inode under any name, and refuses every path in `/proc` and `/dev/fd` and the standard streams, which can lead there. It does not see hard links, nor the real files when you keep Plancia's own files as links to another folder.
- Protection is a confirmation in the panel, not a lock: it does not stop anyone from editing the settings by hand.
- If Plancia fails while it filters the settings, they stay as you configured them: hooks and items switched off for a chat are then on.
- Every choice made for a chat is kept 30 days after it was last made, then dropped at the next write, and all are read at each draw of the line above the prompt: with 600 choices of 250 items (6.6 MB) a read takes about 40 ms.
- claude.ai connectors you have never connected are not listed, and Claude keeps the tools that sign in to them.
- Skills, hooks and rule files are found the way Claude Code 2.1.331 lays them out, plugins synced from claude.ai the way 2.1.332 does; a later version may move them.

## Bugs

<https://github.com/Onimir89/plancia/issues>: the Claude Code version (`claude --version`), the system, what you did and what you saw.

## Development

`npm test` (`test:core` needs Node 22.18 or later, `test:mod` needs Claude Code), `npm run check` and `claude plugin validate --strict .`.

## License

[MIT](LICENSE)
