# Dash Plugins — Design Spec

**Date:** 2026-06-10
**Status:** Approved for implementation planning

## Summary

A plugin system for Dash: local Node packages that register **tools, channel adapters, LLM providers, and lifecycle hooks** through one typed `definePlugin(api)` facade, loaded by the gateway at startup. Inspired by openclaw's plugin architecture (researched in depth — loader, hook dispatcher, provider plugins, SDK packaging), adapted to Dash's existing seams and scale.

Plugins are the **trusted** extension tier: in-process, full speed, no sandbox. Installing a plugin = running its code with gateway permissions. MCP remains the isolated third-party tier.

## Goals

1. Add capabilities to Dash without forking core (the "Discord channel as a plugin" story).
2. A typed hook bus over the agent loop and message flow (policy, audit, redaction).
3. Plugin-registered LLM providers that actually serve inference (Groq, OpenRouter, Ollama).
4. Forward compatibility with a Claude-marketplace-style distribution story, without building it now.

## Non-goals (v1)

- Marketplace / install tooling (manifest + future index format are forward-compatible).
- Hot reload — enable/disable/config changes apply on gateway restart.
- Stream-level provider transports (`createStreamFn` escape hatch) — catalog providers only.
- Per-agent hook scoping, hook priority numbers (load order only).
- Plugin config editing from MC (file is the write path; exception: plugin *channel* config rides existing channel CRUD).
- HTTP routes, CLI commands, KV-store abstraction, sandboxing.

## Decisions

| # | Question | Decision |
|---|---|---|
| 1 | v1 scope | Hook bus + `definePlugin` facade + local loading; distribution deferred |
| 2 | Capabilities | Tools, hooks, channel adapters, LLM providers |
| 3 | Provider depth | Catalog-style: `{baseUrl, api shape, models, credentialPrefix}`; core constructs pi-ai `Model` (verified feasible against installed pi-ai 0.67.68) |
| 4 | Hook points | `message_received`, `before_tool_call`, `after_tool_call`, `message_sending`, `agent_run_start/end` |
| 5 | Dispatch semantics | Per-hook (openclaw's lesson): sequential **threaded** middleware for modify hooks, parallel fire-and-forget for observe hooks; terminal verdicts; fail-open default + per-handler `critical: true`; per-handler timeouts (10s default) |
| 6 | Packaging | `dash.plugin.json` manifest + built-ESM Node package; no TS-direct loading |
| 7 | Scope | Plugins load gateway-global; channels/providers/hooks global; plugin **tools** per-agent assignable (`plugins?: string[]`, unset = all) |
| 8 | MC surface | Settings → Plugins page (status, enable/disable, hook counters) + integration into AI Providers, Messaging Apps, agent detail/deploy wizard |

## Research findings that shaped the design

1. **openclaw hook dispatcher** (`src/plugins/hooks.ts`): four dispatch modes selected per hook, not one global model. Fail-open by default with per-hook timeout budgets — retrofitted from a real incident where a hung handler wedged the agent pipeline. Their documented wart: `before_tool_call`/`message_sending` accept rewrites but don't thread them to later handlers. **We adopt per-hook dispatch + timeouts, and fix the wart (consistent threading).**
2. **openclaw provider plugins**: catalog (`baseUrl` + `api` compat mode + models) over a core-owned transport covers ~90% of ~50 providers; `createStreamFn` is the escape hatch only Ollama-native needs. openclaw is built on a vendored pi fork — the same lineage Dash uses. **We adopt the catalog; defer the escape hatch.**
3. **pi-ai verification (local, installed `@mariozechner/*@0.67.68`)**: a hand-constructed `Model` flows end-to-end — dispatch is by `model.api` (open string union), `setModel()` does no registry lookup, both `openai-completions` and `anthropic-messages` transports honor `model.baseUrl`, and `AuthStorage` accepts arbitrary provider names. The only change is a fallback branch in `resolveModel()` (piagent.ts ~304). Caveats: keyless locals (Ollama) need a non-empty placeholder key; custom baseUrls may need explicit `compat` passthrough.
4. **openclaw loader/SDK**: SDK shipped as subpath exports of the host package (host version = plugin API version); manifest is the code-free contract (TypeBox-compiled config schema validated before plugin code runs); per-plugin failure records with phases, gateway always starts; their 3,200-line loader is dominated by TS-direct loading (jiti, alias maps) that their own docs tell published plugins to avoid. **We require built ESM and skip all of it.**
5. **Claude Code plugin/marketplace spec**: `plugin.json` ignores unknown fields and tolerates extra dirs — a repo can ship both a Claude plugin and a Dash plugin. Marketplace index shape to mirror later: `{name, owner, plugins: [{name, source, version?}]}` with five source types. We deliberately do **not** reuse Claude's hook event names (`PreToolUse` etc.) — theirs are shell-command hooks, ours are in-process typed functions.

## Architecture

### New packages

| Package | Role |
|---|---|
| `@dash/plugin-sdk` | Author-facing contract: `definePlugin()`, `DashPluginApi`, hook payload/verdict types, manifest types, `ProviderCatalog`, `createTestPluginApi()`. Types-heavy, near-zero runtime. Plugin API version = Dash version (unified semver); manifests declare `compat: { dash: ">=x.y.z" }`. |
| `@dash/plugins` | Host machinery: discovery, manifest + config validation (TypeBox `Compile`), loader (dynamic `import()` of built ESM), `HookBus`, `PluginRegistry` with structured failure records, runtime facade implementation. Depends on `@dash/plugin-sdk`. |

### Core changes (no core package imports `@dash/plugins`; structural typing throughout)

1. **`@dash/agent`** — `PiAgentBackend` gains two optional structural params (same trick as `ExtraTool`):
   - `hookRunner` — called at `before_tool_call`/`after_tool_call` inside the custom-tool wrapper (covers built-in, MCP, and extra tools uniformly) and at `run()` entry/`finally` for `agent_run_start/end`. Absent = zero overhead.
   - `modelCatalog` — lookup consulted by `resolveModel()` when `getModel()` misses; constructs the pi-ai `Model` from catalog data (`compat`/`headers` passthrough; `contextWindow` required — compaction reads it; cost defaults to zeros).
2. **`apps/gateway`** —
   - Channel if/else ladder → **channel factory registry** (`Map<string, ChannelFactory>`); `telegram`/`whatsapp` become built-in registrations; `ChannelConfig.adapter` widens to `string`.
   - Plugin loading slots in after credential store + MCP setup, before channel instantiation and the `createBackend` factory.
   - `message_received` hook in the message router (after channel allow-lists, before agent dispatch); `message_sending` just before `adapter.send()`. **Channel path only in v1** — MC chat (chat-ws) bypasses message hooks; tool/run hooks fire everywhere (they live in the backend). Documented explicitly.
   - `GET /models` merges plugin catalog models (provenance-tagged); credentials/provider listings include plugin providers; shutdown runs plugin `onShutdown` handlers (reverse load order, 5s budget each) before core stores close.
3. **`@dash/management`** — `GET /plugins`, `PATCH /plugins/:name`; agent routes/types gain `plugins?: string[]`.
4. **Mission Control** — see MC section.

### Startup flow

```
load config → discover <dataDir>/plugins/* + config `path:` entries
→ validate manifests (shape, compat.dash range) — no code execution
→ compile configSchema (TypeBox) → validate + default-fill config → interpolate ${ENV_VAR}
→ import(entry) → register(api) per plugin (isolated; registrations buffer, commit on success)
→ verify registrations ⊆ declared capabilities
→ loader output: { tools, channelFactories, providerCatalogs, hookBus, registry }
→ gateway wires output into existing seams (as plain data, like createProjectsTools today)
```

Any phase throwing → `{ status: 'error', failurePhase: 'manifest'|'compat'|'config'|'import'|'register', error, failedAt }` recorded, partial registrations discarded, next plugin continues. **The gateway always starts.**

## Plugin anatomy

### Layout

```
my-plugin/
├── dash.plugin.json      # manifest — read before any code executes
├── package.json          # "type": "module"
├── dist/index.js         # built ESM entry
└── src/…                 # not read by Dash
```

### Manifest (`dash.plugin.json`)

```json
{
  "name": "discord-channel",
  "version": "0.1.0",
  "description": "Discord channel adapter for Dash",
  "entry": "./dist/index.js",
  "compat": { "dash": ">=0.3.0" },
  "capabilities": ["channels", "hooks"],
  "configSchema": {
    "type": "object",
    "properties": {
      "botToken": { "type": "string", "title": "Bot token", "sensitive": true },
      "guildId": { "type": "string", "title": "Server ID" }
    },
    "required": ["botToken"]
  }
}
```

- Required: `name` (kebab-case, unique), `version`, `entry`, `compat.dash`. `capabilities` declares intent; registering an undeclared capability is a load error.
- `configSchema` is plain JSON Schema, TypeBox-compiled at load. `sensitive: true` masks values in MC and logs. Invalid user config = plugin errored before its code runs.
- Field names don't collide with Claude Code's `plugin.json`; one repo can ship both manifests.
- Channel-capable plugins additionally provide a per-channel `configSchema` with their `registerChannel` call (used by MC's schema-driven setup form and validated when channels are configured).

### Entry module

```ts
import { definePlugin } from '@dash/plugin-sdk';

export default definePlugin({
  register(api) {
    api.registerTool({ /* ExtraTool shape: name, label, description, TypeBox parameters, execute (throws on error) */ });
    api.registerChannel('discord', (cfg, deps) => new DiscordAdapter(cfg), { configSchema });
    api.registerProvider({ id: 'groq', label: 'Groq', credentialPrefix: 'groq-api-key',
      baseUrl: 'https://api.groq.com/openai/v1', api: 'openai-completions', models: [...] });
    api.on('before_tool_call', async (event, ctx) => { /* … */ }, { critical: true, timeoutMs: 5000 });
    api.lifecycle.onShutdown(async () => { /* … */ });
  },
});
```

`definePlugin()` is a typed identity function (compile-time check, zero runtime).

### `DashPluginApi` (full v1 surface)

| Member | Purpose |
|---|---|
| `api.registerTool(tool)` | tool for agents (per-agent assignment applies) |
| `api.registerChannel(adapterName, factory, opts)` | channel factory; instantiated per configured channel |
| `api.registerProvider(catalog)` | provider catalog → model list + `resolveModel()` fallback |
| `api.on(hook, handler, { critical?, timeoutMs? })` | typed lifecycle hooks |
| `api.lifecycle.onShutdown(fn)` | cleanup on gateway shutdown |
| `api.config` | this plugin's validated config (frozen) |
| `api.logger` | scoped child logger (`[plugin:<name>]`) |
| `api.runtime.dataDir` | plugin-scoped state dir (lazily created) |
| `api.runtime.getCredential(key)` | read-only bridge to the gateway credential store |
| `api.meta` | `{ name, version, dashVersion }` |

## Hook bus

### Types (in `@dash/plugin-sdk`)

```ts
type HookName = 'message_received' | 'before_tool_call' | 'after_tool_call'
              | 'message_sending' | 'agent_run_start' | 'agent_run_end';

interface HookContext {
  pluginName: string;       // set by the bus
  agentName?: string;       // config.name — same contract as projects agents_involved
  channel?: string;         // undefined for MC chat (tool/run hooks)
  sessionId?: string;
  logger: PluginLogger;
}
```

| Hook | Event payload | Verdict |
|---|---|---|
| `message_received` | `{ message: InboundMessage }` | `{ message? }` \| `{ drop: true, reason? }` \| void |
| `before_tool_call` | `{ toolName, toolCallId, params }` | `{ params? }` \| `{ block: true, reason }` \| void |
| `after_tool_call` | `{ toolName, toolCallId, params, result, isError }` | `{ result? }` \| void (no block — tool already ran) |
| `message_sending` | `{ conversationId, content, channel }` | `{ content? }` \| `{ cancel: true, reason? }` \| void |
| `agent_run_start` | `{ agentName, sessionId }` | void (observe-only) |
| `agent_run_end` | `{ agentName, sessionId, usage?, error? }` | void (observe-only) |

> **Hook coverage (v1):** `before_tool_call`/`after_tool_call` fire for plugin tools, MCP tools, and built-in management tools — i.e. everything routed through the custom-tool wrapper. The agent's pi-native filesystem/shell tools (`read`/`bash`/`edit`/`write`/`grep`/`find`/`ls`) are constructed and handed to the pi session directly and are **not** hookable in v1. A policy that needs to gate `bash` (e.g. "block `rm`") is therefore out of scope for v1 — see Future work. (`trigger` on `agent_run_start` was dropped: the backend cannot distinguish channel vs MC-chat runs without plumbing not worth adding in v1.)

### Dispatch semantics

1. **Sequential threaded middleware** for the four modify hooks: handlers run in plugin load order; each receives the event carrying the **latest threaded payload** (fixes openclaw's non-threading wart). Terminal verdicts (`drop`/`block`/`cancel`) stop the chain; the bus records which plugin decided.
2. **Parallel fire-and-forget** for `agent_run_start/end` — never delays the run.
3. **Timeouts**: 10s default per handler; `timeoutMs` override; timeout = handler failure.
4. **Failure policy**: fail-open + logged by default. With `critical: true`: `before_tool_call` → block; `after_tool_call` → result replaced with error placeholder; `message_sending` → cancel; `message_received` → drop. Principle: inbound fails open (availability), effectful fails closed when the author says so (safety).
5. **Verdict surfacing**: `block` reason goes to the model as the tool error text (`denied by policy (<plugin>): <reason>`) via the existing tools-throw-on-error contract — the loop continues and the model adapts. `drop`/`cancel` reasons go to logs only. On `cancel`, the assistant message is still persisted to the session; only delivery is suppressed.
6. **Counters**: per plugin × hook `{ fired, modified, blocked, failed, timedOut }` — in memory, exposed via `GET /plugins`, reset on restart.
7. **Exhaustiveness**: `never`-guard switch over `HookName` in the dispatcher (same pattern as projects `normalizeForWire`).

### Integration points

| Hook | Where | Mechanism |
|---|---|---|
| `message_received` | gateway message router, after allow-lists | direct call |
| `before/after_tool_call` | `PiAgentBackend` custom-tool wrapper (all tool kinds) | optional structural `hookRunner` param |
| `message_sending` | gateway outbound, before `adapter.send()` | direct call |
| `agent_run_start/end` | `PiAgentBackend.run()` entry / `finally` | same `hookRunner` param |

## Capability wiring

### Tools
`ExtraTool` shape; execute **throws** on error (established contract). Names are global; collision with a built-in or earlier plugin = registration error for the later plugin (load order is deterministic). `createBackend` filters by the agent's `plugins?: string[]` (unset = all plugin tools), then concatenates with projects tools into the existing `extraTools` param.

### Channels
Factory registry replaces the if/else ladder; built-in names reserved. Missing factory at startup (plugin disabled/uninstalled) → channel marked errored with reason, **config preserved**, gateway continues; visible in MC. Factory receives validated channel config (plugin's channel `configSchema` + `${ENV_VAR}` interpolation) and returns a `ChannelAdapter`; downstream (gateway registration, routing, health, allow-lists) is identical to built-ins.

### Providers

```ts
interface ProviderCatalog {
  id: string;                      // collision with built-ins = error
  label: string;
  credentialPrefix: string;        // key name in the credential store
  baseUrl: string;
  api: 'openai-completions' | 'anthropic-messages';
  models: CatalogModel[];          // id, name?, contextWindow (required), maxTokens, reasoning?, input?, cost?, compat?, headers?
  dynamicModels?: boolean;         // OpenRouter-style: accept any model id under this provider, defaults from catalog
  placeholderKey?: string;         // keyless locals (Ollama): auto-stored if no credential set
}
```

Consumers: (1) `GET /models` merge with provenance tag; (2) provider/credential listings for MC; (3) `resolveModel()` fallback constructing the pi-ai `Model`.

**Collision policy (uniform):** first registration wins, built-ins always win, loser gets a structured registration error — no shadowing/precedence rules.

## Loader, registry, config

### Config block

```json
{
  "plugins": {
    "entries": {
      "discord-channel": { "enabled": true, "config": { "botToken": "${DISCORD_BOT_TOKEN}" } },
      "audit-log":       { "enabled": false, "path": "/path/to/local/dev/plugin" }
    }
  }
}
```

- Discovery: `<dataDir>/plugins/<name>/` + `path` overrides for local dev.
- Discovered but not configured → **not loaded**, listed as `status: 'disabled'` (presence ≠ consent).
- `${ENV_VAR}` interpolation applied to plugin config values after schema validation (secrets stay out of config files). Full `SecretRef` objects deferred.

### Registry
`PluginRegistry`: per plugin `{ manifest, status: 'loaded'|'disabled'|'error', failure?, capabilities, registrationCounts, hookCounters }`. Single source of truth for `GET /plugins`, `/info`, startup log summary, MC.

### Runtime facade
- `api.runtime.dataDir` → `<dataDir>/plugins/<name>/state/` — sibling of code, survives reinstall.
- `api.lifecycle.onShutdown` handlers run in reverse load order, 5s budget each, before core stores close.
- `PATCH /plugins/:name` flips `enabled`, persists atomically (temp + rename), returns `restartRequired: true`.

## Management API & Mission Control

### Management API
1. `GET /plugins` → full registry view incl. `configSchema` + masked config (`sensitive` → `"•••"`), hook counters.
2. `PATCH /plugins/:name` `{ enabled }` → `{ plugin, restartRequired: true }`.
3. Absorbed into existing endpoints: `GET /models` (catalog models, `source: 'plugin:<name>'`), provider/credential listings, `GET /info` (plugin summary), agent routes (`plugins?: string[]`).

### MC surfaces
1. **Settings → Plugins**: table (name, version, status pill, capability badges, toggle); expanded row shows failure detail, registration summary, hook counters, read-only masked config. Restart-required banner anchors to existing gateway lifecycle controls.
2. **Messaging Apps**: adapter picker becomes data-driven from the factory registry; built-ins keep bespoke wizards; plugin adapters get the **schema-driven form** (editable — channel config rides existing channel CRUD). Errored channels show reason inline.
3. **AI Providers**: plugin providers render as credential cards from gateway data with a `from plugin` badge; keys stored under the catalog's `credentialPrefix` via existing credential routes.
4. **Agent detail / deploy wizard**: "Plugins" multi-select mirroring the MCP assignment control; unset = all.
5. **IPC**: `plugins:list`, `plugins:setEnabled`, `channels:listAdapters` via `getDirectManagementClient`; shared types in `src/shared/plugins-ipc.ts` with must-match comments.

The schema-driven config form is the one new UI primitive (two consumers: Plugins page read-only, channel setup editable).

## Testing

1. **`@dash/plugins` unit**: hook bus dispatch table (threading, terminal verdicts, order, timeouts, `critical`, counters — per-hook), loader phase isolation via on-disk fixture plugins (one per failure phase), registration buffering/commit, interpolation, collision policy.
2. **`@dash/plugin-sdk`**: `createTestPluginApi()` for author-side unit tests; **API baseline snapshot test** so accidental surface breaks fail CI.
3. **Integration**: gateway composition (per-agent tool filtering; channel factory from `channels.json`; `resolveModel()` fallback incl. `dynamicModels`/`placeholderKey`); management route tests; **dist-import test** for `@dash/plugins` (loader does filesystem work — projects migration-runner lesson).
4. **MC**: store/reducer tests, IPC contract tests, TEST_PLAN.md **Section 28** + amendments to Sections 3/15/24 (providers/credentials), 20 (messaging), 22 (settings), 5/18 (agent detail).

## Docs & reference plugin

- New user-facing `docs/plugins.mdx`: what plugins are, **trust model stated plainly** (full gateway permissions; install only code you trust; MCP is the isolated alternative), install/enable, complete worked example.
- Touches: `configuration.mdx` (plugins block), `channels.mdx`, `troubleshooting.mdx` (failure phases).
- **Reference plugin** in-repo at `examples/plugins/` — a provider catalog plugin (Groq or Ollama): exercises manifest, config, credentials, and the resolveModel path with the least code; doubles as living documentation and loader smoke test.

## Implementation plan structure

Three plans (projects pattern), cross-reviewed for contract drift before execution:
1. **sdk + host** — `@dash/plugin-sdk`, `@dash/plugins`: types, hook bus, loader, registry, fixtures.
2. **gateway surfaces** — backend structural params, channel factory registry, `resolveModel()` fallback, models/credentials merging, message hooks, management routes, shutdown.
3. **MC UI** — IPC, Plugins page, schema-driven form, Messaging Apps / AI Providers / agent detail integration.

## Future work (explicitly deferred)

1. **Distribution**: marketplace index mirroring Claude's `marketplace.json` (`{name, owner, plugins: [{name, source, version?}]}`, five source types), install tooling, install ledger.
2. **Foreign-bundle bridging**: read a Claude plugin's `.mcp.json` to auto-feed Dash's MCP tier.
3. **Installable contract test suites** (e.g. `runChannelAdapterContract(factory)`) once a second channel plugin exists.
4. **Per-entry capability permission overrides** in user config (meaningful when plugins are third-party).
5. **Provider stream escape hatch** (`createStreamFn`) for native-protocol providers.
6. **Hot reload; MC plugin-config editing** (requires a config-file mutation API).
7. **MC chat through message hooks** (v1: channel path only).
8. **Hook coverage for pi-native tools** (`bash`/`read`/`edit`/…) so tool-policy plugins can gate the agent's filesystem/shell access — the "block `rm`" use case. Feasible (the pi-native tool factories expose an `execute` surface the gateway can wrap before handing them to the pi session) but carries its own test matrix and a `Tool`-vs-`ToolDefinition` shape difference; deferred from v1.
