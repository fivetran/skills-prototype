# AI Tools Repository

Prototype of AI Tools Repository. Includes
- `skills/` directory of all agent skills
- `.mcp.json` definition of all related MCP servers
- Marketplace plugin that bundles `skills/` and `mcps/` via GitHub action workflow

## Installation

### Skills

```
npx skills add fivetran/skills-prototype
```
See [Vercel's Skills docs](https://github.com/vercel-labs/skills) for more details on flags including `--global`, `--skill`, `--agent`, and `--list` to limit which skills are installed and how, as well as instructions for updating (skills installed this way are not automatically updated)


### MCP
`npx add-mcp` doesn't work as is because the test mcp server here isn't setup as its own package (TODO). See [Neon's add-mcp docs](https://github.com/neondatabase/add-mcp) for more info on how it might work.


### Claude Code CLI

```
/plugin marketplace add fivetran/skills-prototype
/plugin install base@skills-prototype       # default skills only
/plugin install all@skills-prototype        # every skill in the repo
/plugin install <plugin>@skills-prototype   # one named plugin (see Layout below)
```

### Claude Desktop App

1. Click **Customize** in the left nav and click the **+** next to Personal Plugins
2. Click **+ Create Plugin** → **Add Marketplace**


## Layout

Source (hand-edited):
- `skills/<name>/SKILL.md` — skill definitions. Add `metadata.plugin: <plugin-name>` to route a skill into a named plugin; skills with no `plugin` field land in `base`. (`base` and `all` are reserved.)
- `mcps/<name>/.mcp.json` — MCP server config fragments (merged at build)
- `mcps/<name>/` — MCP server source files
- `mcps/plugins.json` *(optional)* — maps each MCP directory name to an array of plugin names it should ship in. Example: `{ "test": ["ad-analytics"] }`. MCPs with no entry default to `base`. Every MCP also ships in `all` regardless.
- `hooks/hooks.json` + `hooks/*.sh` — plugin hooks (see **Analytics hook** below). Copied into every plugin.

Plugins emitted:
- `base` — every skill without a `metadata.plugin`, plus any MCP without (or explicitly opting into) a `mcps/plugins.json` entry. Replaces the old `fivetran-skills` plugin.
- One plugin per distinct `metadata.plugin` value (and/or per plugin name appearing in `mcps/plugins.json`).
- `all` — every skill and every MCP, regardless of declarations.

Generated (committed — regenerate before pushing):
- `.claude-plugin/marketplace.json`
- `.marketplace/<plugin>/.claude-plugin/plugin.json` (one per plugin)
- `.marketplace/<plugin>/.mcp.json` (merged from that plugin's MCP fragments)
- `.marketplace/<plugin>/skills/...` (copied from `skills/`)
- `.marketplace/<plugin>/mcps/...` (copied from `mcps/`, excluding `.mcp.json` fragments)
- `.marketplace/<plugin>/hooks/...` (copied from `hooks/`)

## Workflow

1. Edit sources under `skills/` or `mcps/`.
2. Regenerate:
   ```
   node scripts/generate-marketplace.mjs
   ```
3. Commit the source changes **and** the updated `.claude-plugin/` / `.marketplace/` artifacts together.
4. Open a PR. CI runs `--check` and fails the build if the committed artifacts don't match the sources.

To verify locally without writing:
```
node scripts/generate-marketplace.mjs --check
```

The CI check (`.github/workflows/check-marketplace.yml`) is read-only — no secrets, no push — so it's safe on a public repo and safe for fork PRs. Once it's run at least once, add it to the `main` ruleset's required status checks so stale artifacts can't merge.

## Analytics hook

This is only available if installed via the plugin marketplace

Fires on the `SessionStart` hook event and reports that the plugin loaded, along with its version. It reads the installed plugin's manifest from `$CLAUDE_PLUGIN_ROOT/.claude-plugin/plugin.json` and POSTs a payload like:

```json
{
  "event": "Plugin Session Start",
  "plugin": "fivetran-skills",
  "version": "1.0.2",
  "source": "startup",
  "model": "claude-sonnet-4-6",
  "session_id": "abc123",
  "timestamp": "2026-04-19T12:00:00Z"
}
```

`source` is `startup | resume | clear | compact` (how the session began). No tool usage is tracked, no email is captured. Delivery is fire-and-forget (`curl &` with short timeouts) so hook overhead stays low

For testing, the events can be viewed at
[https://www.postb.in/b/1776621187855-1227751318365]