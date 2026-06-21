# Dash Plugins — Claude Code Compatibility Design Spec

**Date:** 2026-06-21
**Status:** Approved for implementation planning
**Supersedes:** `2026-06-10-dash-plugins-design.md` for the plugin *format and loading* model (see [Relationship to the 2026-06-10 design](#relationship-to-the-2026-06-10-programmatic-design)). The provider-catalog and pi-ai findings from that doc are **reused**, not discarded.

## Summary

Make Dash able to **discover and run unmodified Claude Code plugins** — the same `.claude-plugin/plugin.json` packages, marketplaces, and on-disk layout that Claude Code uses — by routing each plugin component to a Dash subsystem Dash already owns. A Dash plugin **is** a Claude Code plugin: no Dash-specific files required, authored and validated with the standard `claude plugin` tooling, installable from the same marketplaces.

Two component types Claude Code's format structurally cannot express are handled separately:

1. **LLM providers** — Dash follows **OpenClaw's provider-plugin shape** (a catalog: `baseUrl` + API flavor + `models[]` + credential prefix) so Dash can inherit OpenClaw provider plugins in future. This rides the provider plumbing already verified in the 2026-06-10 design.
2. **Channel adapters** — kept **first-party** (not plugin-extensible) in this iteration. (Open item — see [Deferred](#deferred--open-items).)

Plugins are the **trusted** extension tier: hooks run shell commands and MCP/provider servers are spawned in-process — i.e. arbitrary code execution. A plugin only runs after an explicit per-plugin **enabled + trusted** gate. MCP remains the isolated third-party tier *within* a plugin.

## Goals

1. **Drop-in compatibility** — an unmodified Claude Code plugin (skills / commands / MCP / subagents / hooks / `bin`) installed by Claude Code is recognized and run by Dash, and vice-versa, by sharing the same on-disk contracts.
2. **Marketplace interop** — read/write the same `marketplace.json`, `installed_plugins.json`, `known_marketplaces.json`, `blocklist.json`, and `cache/<marketplace>/<plugin>/<version>/` layout Claude Code uses.
3. **Inherit OpenClaw LLM providers** — a provider-plugin contract shaped to OpenClaw's so future OpenClaw provider plugins load with only a thin adapter.
4. **Honest, tiered fidelity** — surface per-plugin what activated vs. no-op'd; never silently pretend full fidelity.

## Non-goals (this iteration)

- **Channel-adapter plugins** (kept first-party; see Deferred).
- **The full Claude Code runtime.** We emulate the load-bearing subset (path vars, hook protocol, MCP env). IDE/TUI-only surfaces are accepted and no-op'd (see [Include / exclude](#include--exclude)).
- **`permissionMode` semantics / auto-mode classifier** — Dash's trust model is per-channel, not Claude Code's mode hierarchy.
- **Hot reload of hooks/MCP** beyond a `reload-plugins`-style gateway action; theme/monitor live-reload is out.
- **Authoring a Dash-native programmatic plugin API** (`definePlugin(api)`). The format is Claude Code's; the host reads files, it does not run a registration callback. (The `@dash/plugin-sdk` package is retained only for *shared types* + the provider catalog contract.)
- **A Dash marketplace registry/CDN.** We consume existing marketplaces; we do not publish one.

## Decisions

| # | Question | Decision |
|---|----------|----------|
| 1 | Plugin format | **Claude Code's**, unmodified — `.claude-plugin/plugin.json`, standard component dirs, optional manifest with dir-name fallback. |
| 2 | Compat depth | **Drop-in**: shared on-disk install/marketplace contracts, not a paraphrase. |
| 3 | Scope | **Tier-1 + Tier-2**: skills, commands, MCP, `bin`, marketplace/install-state, path vars, `userConfig` **and** subagents + hooks. |
| 4 | Hook model | **Honor Claude Code's shell-command hooks** (reverses 2026-06-10 finding #5): mapped events fire the plugin's command with Claude Code's stdin JSON + exit-code/`hookSpecificOutput` protocol. Unmapped events no-op. |
| 5 | Hook attach points | `PreToolUse`/`PostToolUse` → pi-agent-core `beforeToolCall`/`afterToolCall` (native); `UserPromptSubmit`→router; `SessionStart`/`Stop`→run-loop; `SubagentStart`/`SubagentStop`→subagent runner. |
| 6 | Skills | **Direct fit** — `discoverSkills({ paths })` + `DashResourceLoader.setExtraSkills()`; Dash frontmatter is a strict superset of Claude's. Zero translation. |
| 7 | Commands | **= skills** (Claude Code merged them). Extend Dash's existing slash-command router with `/plugin:command` namespacing. |
| 8 | MCP | **Adapt** — translate Claude's `mcpServers` object-map → Dash `McpServerConfig[]`; map `stdio`/`http`/`streamable-http`/`sse`/`ws`; expand `${VAR}`/`${CLAUDE_PLUGIN_ROOT}`. |
| 9 | Subagents | **Net-new** — `agents/*.md` → a runner over a second `AgentSession` (pi has no native spawn); emits `agent_spawned`. |
| 10 | Providers | **OpenClaw-shaped catalog** over Dash's `resolveModel()` seam; a thin adapter isolates OpenClaw-specific manifest/packaging. |
| 11 | Trust | Per-plugin explicit **enabled + trusted** gate in config; no auto-run of hooks/MCP/providers from a freshly added marketplace. |
| 12 | Channels | **First-party** this iteration (deferred as a plugin axis). |

## Relationship to the 2026-06-10 programmatic design

The earlier design built a *Dash-native programmatic* plugin system: `definePlugin(api)` packages registering tools/channels/providers/hooks as in-process typed functions, with Dash's own `dash.plugin.json` manifest and Dash-named hook events. It explicitly chose **not** to reuse Claude Code's hook event names because "theirs are shell-command hooks, ours are in-process typed functions."

This design **changes the format to Claude Code's** and **embraces the shell-command hook model**, because the goal is now drop-in compatibility with the Claude Code ecosystem rather than a bespoke Dash API. What carries over unchanged:

1. **Provider catalog + pi-ai feasibility** (2026-06-10 finding #3): a hand-constructed pi-ai `Model` flows end-to-end; the only core change is a fallback branch in `resolveModel()` (`piagent.ts` ~291–308). Keyless locals need a placeholder key; custom `baseUrl`s may need `compat` passthrough. **Reused verbatim** for the provider half.
2. **The channel factory registry** refactor (gateway if/else ladder → `Map<string, ChannelFactory>`) is still worthwhile and is a prerequisite if/when channel plugins return. Out of scope now.
3. `@dash/plugin-sdk` is **retained as a types-only package** (manifest types, `ProviderCatalog`/`CatalogModel`, hook payload types) — but `definePlugin()` and the runtime registration facade are dropped; the host reads files.

## Research findings that shaped the design

All findings below are grounded in (a) the **real installed Claude Code plugins on this machine** (`~/.claude/plugins/`), (b) the **authoritative Anthropic docs** (`code.claude.com/docs/en/plugins*`), and (c) **direct inspection of the pi SDK** in `node_modules/@earendil-works/`.

1. **A plugin is a directory of declarative files, not code that registers.** `.claude-plugin/plugin.json` is *optional* (name falls back to the dir); every other component dir lives at the plugin root, not inside `.claude-plugin/`. Unrecognized top-level manifest fields are **ignored** (so a repo can ship Claude + Codex + Cursor + Dash manifests side by side — the real `superpowers` plugin ships `.claude-plugin/`, `.codex-plugin/`, `.cursor-plugin/`, `.kimi-plugin/`). This is what makes drop-in realistic: mostly *read files and route*, not *execute foreign registration*.
2. **pi-agent-core natively exposes tool interception.** `beforeToolCall` / `afterToolCall` in `AgentOptions` (`node_modules/@earendil-works/pi-agent-core/dist/types.d.ts:229,242`), already wired by pi-coding-agent, cover built-in + extra + MCP tools, with block/modify verdicts. **`PreToolUse`/`PostToolUse` are feasible without forking the SDK** — the single biggest Tier-2 risk, resolved.
3. **Skills are a direct fit.** Dash's `SkillFrontmatter` (`packages/agent/src/skills/types.ts`) is a strict superset of Claude's; `discoverSkills({ paths })` (`packages/agent/src/skills/discover.ts`) accepts arbitrary dirs; `DashResourceLoader.setExtraSkills()` merges with dedup-by-name and rebuilds the prompt each `run()`. A Claude `SKILL.md` loads with no translation.
4. **MCP is a low-cost adapt.** Claude's `.mcp.json` is an object-map (`mcpServers: { name: {command,args,env} | {type,url,headers} }`); Dash's `McpServerConfig[]` (`packages/mcp/src/types.ts:51`) is an array with a nested `transport`. One-to-one field mapping; transports line up (`stdio`/`sse`/`streamable-http` exist; `http`→`streamable-http`, `ws` added or no-op'd).
5. **Subagents are net-new.** pi has no spawn/child-session API; `agent_spawned` is typed (`packages/agent/src/types.ts:56`) but never emitted. Buildable on a second `AgentSession` via `createAgentSession()`.
6. **Commands are skills.** Current Claude Code merges custom commands into skills; Dash already has a deterministic slash-command router (`packages/channels/src/commands.ts`, `router.ts`) handling `/skill:`, `/skills`, `/help` — extend it, don't rebuild.
7. **Providers need a resolver fallback.** pi-ai's `getModel()` is a static-registry lookup; `resolveModel()` (`piagent.ts:291-308`) requires `provider/model-id`. A plugin provider registry consulted *before* `getModel()` is the clean seam (matches 2026-06-10 finding #3).
8. **OpenClaw provenance is unverified.** OpenClaw's AI-agent docs render and are internally consistent, but its popularity signals are fabricated (impossible star/commit counts; SEO-poisoned result set) and its plugin spec is near-identical to Dash's own prior plan. **We do not treat OpenClaw as an authoritative standard.** We design the provider layer toward the *verifiable* stable shape (an OpenAI/Anthropic-compatible endpoint catalog = Dash's `ProviderCatalog`) and isolate any OpenClaw-specific translation in a thin adapter to be pinned against live OpenClaw SDK types before locking. If OpenClaw proves unreal, the catalog provider still serves Groq/OpenRouter/Ollama standalone — no wasted work.

## Architecture

### New packages

| Package | Role |
|---------|------|
| `@dash/plugin-sdk` | **Types only.** Manifest types, component schemas, `ProviderCatalog`/`CatalogModel`, hook payload types, the Claude Code event enum. No `definePlugin()`, no runtime facade. Zero deps on other `@dash` packages. |
| `@dash/plugins` | **Host machinery.** Marketplace manager, loader pipeline, component routers, hook engine, subagent runner, provider adapter, plugin runtime (path-var substitution, data dir, `userConfig`), `PluginRegistry` with structured failure + activation records. Depends on `@dash/plugin-sdk`. No core package imports it (structural typing into `@dash/agent`). |

### The core — four parts

**1. Marketplace manager.** Reads/writes Claude Code's state files and cache layout so an install by either tool is mutually recognized:
- `known_marketplaces.json` — registered marketplaces (`{source:{source:"github",repo}, installLocation, lastUpdated}`).
- `installed_plugins.json` (`version: 2`) — per-plugin install records (`scope`, `installPath`, `version`, `gitCommitSha`, timestamps).
- `blocklist.json` — blocked `plugin@marketplace` ids.
- `marketplace.json` — catalog: `{name, owner, plugins:[{name, source, version?, ...}]}` with the five `source` forms (relative `./`, `github {repo,ref?,sha?}`, `url`, `git-subdir {url,path,...}`, `npm {package,version?,registry?}`).
- Fetch into `cache/<marketplace>/<plugin>/<version>/`. Version resolution order: `plugin.json` version → marketplace-entry version → git SHA → `unknown`.

**2. Loader pipeline** (per plugin, fail-isolated — gateway always starts).

*Discovery roots* (in precedence order): Dash's own `<dataDir>/plugins/` (mirroring Claude Code's `cache/<marketplace>/<plugin>/<version>/` layout, so marketplace installs land here), config-declared `path:` entries (local/linked dev plugins), and — optionally, for true cross-tool sharing — the user's `~/.claude/plugins/` install. Each root is scanned for plugin dirs; the same `installed_plugins.json`/`known_marketplaces.json` contracts apply so an install by either tool is mutually recognized.

```
discover .claude-plugin/plugin.json (optional → dir-name fallback)
  → resolve component paths (replace-vs-add rules: skills ADD to default; commands/agents/outputStyles/themes/monitors REPLACE; hooks/mcp/lsp own merge)
  → validate (kebab-case name, frontmatter/JSON well-formed; malformed hooks.json fails the whole plugin — match Claude)
  → check trust gate (enabled + trusted)
  → route each component
  → record PluginRecord { status, activated[], noop[], failure? }
```

**3. Component routers** (one per type — small, independently testable). The routing table, with verdicts:

| Component | Router target | Verdict |
|-----------|---------------|---------|
| `skills/<n>/SKILL.md` | `discoverSkills({paths})` → `setExtraSkills()` | Direct fit |
| `commands/*.md` | slash-command router, `/plugin:cmd` namespacing | Adapt (= skills) |
| `.mcp.json` | `McpManager.addServer()` after schema translation | Adapt |
| `bin/` | prepend to bash-tool `PATH` | Direct |
| `agents/*.md` | subagent runner | Net-new |
| `hooks/hooks.json` | hook engine | Net-new |
| `<provider>` | provider adapter → `resolveModel` registry | Net-new (OpenClaw) |

**4. Plugin runtime** (the substrate every router uses):
- **Path variables** — substitute *and* env-export `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}` (persistent per-plugin dir, sanitized id, survives updates), `${CLAUDE_PROJECT_DIR}`; standard `${VAR:-default}`.
- **`userConfig`** — prompt/store user-config options; `sensitive: true` → existing encrypted secret store / keychain; expose as `${user_config.KEY}` and `CLAUDE_PLUGIN_OPTION_<KEY>`.
- **Trust gate** — `plugins.entries[<name>].enabled` + `trusted`; only trusted plugins' hooks/MCP/providers run.

### pi-coding-agent seams (verified)

1. **Hooks** — install a hook-dispatch shim on the pi `Agent`'s `beforeToolCall`/`afterToolCall`; attach `UserPromptSubmit` in the message router, `SessionStart`/`Stop` at `run()` entry/finally, `SubagentStart`/`SubagentStop` in the subagent runner. Tool seam covers built-in/extra/MCP uniformly.
2. **Subagents** — `createAgentSession()` (`pi-coding-agent` sdk) with the subagent's system prompt (markdown body) + `tools` subset; route a sub-prompt, await completion, return result to parent; emit `agent_spawned`. Plugin subagents honor `name`, `description`, `model`, `tools`, `disallowedTools`, `skills`; ignore `hooks`/`mcpServers`/`permissionMode` (matching Claude's plugin-subagent security rules).
3. **Skills** — `resourceLoader.setExtraSkills(loadedFromPluginDirs)`; reloaded each `run()`.
4. **Providers** — fallback branch in `resolveModel()` consults the plugin provider registry before `getModel()`, constructing a pi-ai `Model` from the catalog (`api`, `baseUrl`, `compat`/`headers` passthrough, `contextWindow` required).

### Hook engine

- **Events mapped** (fire the plugin command): `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `SubagentStart`, `SubagentStop`. Matcher syntax honored (exact / `|`-list / regex; tool-name matchers incl. `mcp__<server>__<tool>`).
- **Protocol** (faithful): per-event stdin JSON (`session_id`, `cwd`, `hook_event_name`, `tool_name`/`tool_input`/`tool_response`, `prompt`, …), exit-code semantics (0 = parse stdout JSON; 2 = block + stderr to model; other = non-blocking), and `hookSpecificOutput` decisions (`PreToolUse` allow/deny/`updatedInput`; `PostToolUse` block/`updatedToolOutput`/`additionalContext`; `UserPromptSubmit` block/`additionalContext`; `continue`/`stopReason`/`systemMessage`).
- **Dispatch** — per-handler timeout (Claude defaults: 600s command), fail-open by default; `command`/`http` hook types in scope, `mcp_tool`/`prompt`/`agent` types deferred.
- **Unmapped events no-op** (`PermissionRequest`, `PreCompact`, `MessageDisplay`, `WorktreeCreate`, `CwdChanged`, …) — recorded in `noop[]`.
- **Coverage:** tool, run-loop, and subagent hooks (`PreToolUse`/`PostToolUse`/`PostToolUseFailure`/`SessionStart`/`Stop`/`SubagentStart`/`SubagentStop`) live in the backend and fire on **every** entry path (channels and MC chat). `UserPromptSubmit` fires where the inbound message is seen — the channel router, and MC chat only if it shares that entry (carry the 2026-06-10 "channel-path-only" caveat into the plan and close it if MC chat needs parity).

### Provider plugins (OpenClaw)

- Provider catalog = Dash's existing `ProviderCatalog` (`id`, `label`, `credentialPrefix`, `baseUrl`, `api: 'openai-completions'|'anthropic-messages'`, `models: CatalogModel[]`, `dynamicModels?`, `dynamicModelDefaults?`, `placeholderKey?`).
- A **thin OpenClaw adapter** translates OpenClaw's provider-plugin manifest/registration into this catalog. **Pinned to OpenClaw's live SDK types before lock** (the only file that changes if the spec differs). Until verified, the catalog provider works standalone (Groq / OpenRouter / Ollama).
- Wired through `GET /models` (provenance-tagged), credential listings (`credentialPrefix`), and the `resolveModel` fallback.

### Install-state & path-var interop

These two are the literal definition of "drop-in": Dash reading/writing the same state files (above) and emulating the path-variable substrate (above). Everything else is routing.

## Include / exclude

**Included (Tier-1 + Tier-2):** plugin/marketplace discovery, install-state files, skills, commands, MCP, `bin`, path vars, `userConfig`, subagents, mapped hook events.

**Excluded — accepted and no-op'd, with rationale:**

| Excluded | Why |
|----------|-----|
| `.lsp.json` (LSP servers) | IDE code-intelligence; irrelevant to a multi-channel chat gateway. |
| `monitors/monitors.json` | Claude Code itself skips these without the Monitor tool (interactive-CLI only); graceful degradation is spec-sanctioned. |
| `themes/`, `outputStyles/`, `settings.json` `subagentStatusLine` | Pure TUI rendering; no analog. |
| ~20 Claude-internal hook events | No Dash analog (permission dialogs, compaction internals, worktree/cwd, message-display). |
| `permissionMode` / auto-classifier | Dash trust model is per-channel. |
| `settings.json` `agent` main-thread takeover | Depends on Claude's subagent/system-prompt machinery; revisit with subagents. |

## "Drop-in unmodified" — honest scope

- **Genuinely drop-in:** skill / command / MCP / agent / `bin` bundles (the bulk of real plugins; `superpowers` is pure skills + one `SessionStart` hook).
- **Best-effort:** hook-heavy plugins — mapped events work, unmapped events no-op.
- **Transparency:** each `PluginRecord` reports `activated[]` vs `noop[]`; surfaced in logs and (later) MC, so compatibility is never silently overstated.

## Security / trust model

Plugins are the trusted tier (in-process, full speed, no sandbox; installing = running its code with gateway permissions). Because Dash runs headless (no interactive trust dialog), trust is **explicit and per-plugin in config**: a freshly added marketplace/plugin is inert until `plugins.entries[<name>] = { enabled: true, trusted: true }`. Hooks, MCP servers, providers, and `bin` only activate for trusted plugins. `blocklist.json` is honored. (MCP remains the *isolated* tier within a plugin.)

## Deferred / open items

1. **Channel-adapter plugins** — the one axis neither Claude Code nor OpenClaw's provider format expresses. Kept first-party now; if reintroduced, reuse the 2026-06-10 channel-factory-registry refactor + a small Dash-native extension.
2. **OpenClaw provider-contract pinning** — verify against live `openclaw/openclaw` SDK types before locking the adapter (provenance caveat, finding #8).
3. **MC UI** — plugin manager surface (status, enable/trust, activation report, hook counters) is a later plan, mirroring the 2026-06-10 MC section.
4. **Marketplace publishing** — consume only; no Dash marketplace registry.

## Build sequence (for the implementation plan)

All Tier-1 + Tier-2, ordered for safety so something runs early:

1. **Runtime + loader + marketplace + skills/commands** — gets real skill-only plugins (e.g. `superpowers`) running drop-in.
2. **MCP adapter + `bin`** — schema translation + PATH injection.
3. **Hook engine** — `beforeToolCall`/`afterToolCall` shim + router/run-loop attach + stdin/exit/`hookSpecificOutput` protocol.
4. **Subagent runner** — second `AgentSession`, `agents/*.md`, `agent_spawned`.
5. **Provider adapter** — catalog over `resolveModel`, pinned to verified OpenClaw contract.

## Testing strategy

- **Fixtures from real plugins** — copy `superpowers` (skills + `SessionStart` hook) and an `example-plugin` (skills + commands + agents + `.mcp.json`) shape into `packages/plugins/test/fixtures/`; assert drop-in load.
- **Loader** — `mkdtemp` dirs, fail-isolation (one bad plugin doesn't stop the gateway), replace-vs-add path rules, version resolution.
- **Routers** — skills discovered from arbitrary path; `.mcp.json` → `McpServerConfig[]` translation; `/plugin:cmd` parsing.
- **Hook engine** — stdin JSON shape per event, exit-code 0/2/other, `hookSpecificOutput` block/modify, timeout/fail-open.
- **Provider** — catalog → pi-ai `Model` end-to-end (reuse 2026-06-10 verification); `dynamicModels` path.
- **dist-import test** — exercise the built `dist/index.js` (projects migration-runner lesson).
- **Install-state interop** — write `installed_plugins.json`/`known_marketplaces.json` and re-read; assert shape matches Claude Code's so both tools agree.

## Risks

1. **OpenClaw provider contract unverified** → isolated in a thin adapter; catalog works standalone regardless (low residual risk).
2. **Hook protocol surface is large** → scope to mapped events + `command`/`http` types; no-op the rest with reporting.
3. **Subagent runner is net-new over pi** → start minimal (sequential sub-task, merge result); no parallel fan-out in v1.
4. **`${CLAUDE_PLUGIN_DATA}` persistence across updates** → implement the sanitized-id persistent dir + 7-day orphan grace to match Claude's expectations.
5. **Trust gate friction** → explicit per-plugin enable is intentional; document the one-line config to enable.
