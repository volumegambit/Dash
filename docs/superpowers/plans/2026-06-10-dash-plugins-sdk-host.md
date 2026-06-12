# Dash Plugins — SDK + Host Packages Implementation Plan (Plan 1 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `packages/plugin-sdk` (`@dash/plugin-sdk`, the author-facing typed contract: `definePlugin()`, all plugin API types, `createTestPluginApi()`, an API baseline test) and `packages/plugins` (`@dash/plugins`, the host machinery: manifest validation, compat check, TypeBox config validation + `${ENV_VAR}` interpolation, `HookBus` with per-hook dispatch semantics, phase-isolated loader with on-disk fixture plugins, `PluginRegistry`, runtime facade, `PluginConfigStore`, `createModelCatalog`). No gateway or MC wiring — those are Plans 2 and 3, which consume the exact exported surface pinned here.

**Architecture:** `@dash/plugin-sdk` is types-heavy with near-zero runtime (two functions) and **zero dependencies on other @dash packages** — its channel types are structural verbatim mirrors of `packages/channels/src/types.ts`, kept honest by a compile-time assignability test in `@dash/plugins` (which takes `@dash/channels` as a devDependency for that test only). `@dash/plugins` depends on `@dash/plugin-sdk` (types only at runtime) and `@sinclair/typebox@^0.34.0` (same version as `packages/projects`). The loader runs a per-plugin phase pipeline (manifest → compat → config → import → register) where any throw produces a structured `PluginFailure` record and the next plugin continues — the gateway always starts. Registrations made during `register(api)` are buffered per plugin and committed to the shared structures (tools list, channel factory map, provider catalogs, hook bus) only when the whole plugin succeeds. The `HookBus` implements sequential *threaded* middleware for the four modify hooks (each handler sees the latest threaded payload; terminal verdicts stop the chain) and parallel fire-and-forget for the two observe hooks, with per-handler timeouts (10s default), fail-open default, `critical: true` fail-closed semantics, and per-plugin×hook counters. Loader tests drive `loadPlugins` end-to-end over `mkdtemp` dirs against plain-JS fixture plugins in `packages/plugins/test/fixtures/`; a dist-import test (projects migration-runner lesson) exercises the BUILT `dist/index.js`.

**Tech Stack:** Node.js 22+, ESM only, TypeScript strict / ES2024 / NodeNext. tsup single-entry build (`src/index.ts` → `dist/`). Vitest globals (the new packages' tsconfigs add `"types": ["node", "vitest/globals"]` so `tsc --noEmit` accepts global `describe`/`it`/`expect`). Biome: 2-space indent, single quotes, semicolons, 100-char width. Local ESM imports use `.js` extensions. `@sinclair/typebox@^0.34.0` (`TypeCompiler` + `Value.Default`). No semver dependency — a hand-rolled `satisfiesMinVersion` supports `'>=x.y.z'` ranges only.

---

## Cross-plan contract (PINNED)

The exported names and signatures of both packages are a **cross-plan contract**: Plan 2 (gateway) and Plan 3 (MC) are written against them verbatim. Do not rename, restructure, or "improve" any type or signature in the code below. The API baseline test in `@dash/plugin-sdk` and the barrel of `@dash/plugins` exist to make accidental drift fail CI.

Two behavioral pins worth repeating (easy to get subtly wrong):

1. **The loader knows nothing about built-ins.** `loadPlugins` accepts NO list of built-in tool/channel/provider names. It only detects plugin-vs-plugin collisions (first registration wins; the later plugin gets a `register`-phase error and ALL its registrations are discarded). Collision-with-built-in checks happen in the gateway (Plan 2).
2. **Block reason formatting lives in the bus.** `HookBus.beforeToolCall` returns `{ blocked: true, reason }` where `reason` is ALREADY formatted as `policy (<pluginName>): <raw reason>`. Plan 2 renders the tool error as `denied by ${reason}` — i.e. the model sees `denied by policy (<pluginName>): <raw reason>`. Format in the bus so all consumers render identically.

## Implementation notes (verified against the repo)

1. **TypeBox cannot compile raw JSON Schema directly.** Verified against installed `@sinclair/typebox@0.34.48`: `TypeCompiler.Compile` dispatches on the `[Kind]` symbol, which plain JSON objects lack — it throws `TypeCompilerUnknownTypeError`. So `config.ts` converts the supported JSON Schema subset (object/string/number/integer/boolean/array/enum, `required`, `default`, `additionalProperties`, passthrough of foreign keywords like `sensitive`/`title`) into TypeBox types via `Type.*` constructors, then compiles. Unsupported constructs are a config-phase error with a clear message.
2. **vitest does not typecheck.** The channel assignability test and the SDK type-surface baseline are enforced by `tsc --noEmit` via new `typecheck` scripts wired into the root `lint` script (precedent: `apps/mission-control` typecheck already runs there). CI runs `build` before `lint`, so the `@dash/channels` / `@dash/plugin-sdk` `dist/index.d.ts` files these typechecks resolve through exist. Run `npm run build` locally before `npm run lint` the first time.
3. **`version:sync` needs no change** — it globs `packages/*/package.json`, so both new packages are covered automatically (verify in the final task).
4. **Fixtures are plain `.js`** (no build step) and do NOT import `@dash/plugin-sdk` — `definePlugin` is a typed identity, so fixtures simply `export default { register(api) { … } }`. Fixtures must still satisfy Biome formatting (single quotes, semicolons, 2-space).
5. **Vitest config** already globs `packages/*/src/**/*.test.ts`; fixtures live under `packages/plugins/test/` which is NOT matched (correct — they are not tests). Add a `'@dash/plugin-sdk'` source alias to `vitest.config.ts` (same pattern as the existing `@dash/projects` alias).

## File structure

| File | Responsibility |
|------|----------------|
| `packages/plugin-sdk/package.json` | `@dash/plugin-sdk`, tsup build, `typecheck` script, no deps. |
| `packages/plugin-sdk/tsconfig.json` | Extends base; `types: ["node", "vitest/globals"]`. |
| `packages/plugin-sdk/src/index.ts` | Entire pinned type surface + `definePlugin()` + re-export of test helper. |
| `packages/plugin-sdk/src/test-api.ts` | `createTestPluginApi()` + `TestPluginRegistrations`. |
| `packages/plugin-sdk/src/api-baseline.test.ts` | Runtime-export baseline + type-surface reference block. |
| `packages/plugin-sdk/src/test-api.test.ts` | Test-helper behavior. |
| `packages/plugins/package.json` | `@dash/plugins`; deps `@dash/plugin-sdk`, `@sinclair/typebox`; devDep `@dash/channels`. |
| `packages/plugins/tsconfig.json` | Extends base; `types: ["node", "vitest/globals"]`. |
| `packages/plugins/src/types.ts` | Host types: `PluginRecord`, `PluginRegistry`, `HookBus`, `LoadedPlugins`, etc. (pinned). |
| `packages/plugins/src/index.ts` | Barrel — exactly the pinned `@dash/plugins` surface. |
| `packages/plugins/src/channel-compat.test.ts` | Compile-time assignability: SDK channel mirrors ↔ `@dash/channels`. |
| `packages/plugins/src/manifest.ts` | `readManifest` / `validateManifest`. |
| `packages/plugins/src/compat.ts` | `satisfiesMinVersion` (`'>=x.y.z'` only, documented limitation). |
| `packages/plugins/src/config.ts` | JSON-Schema-subset → TypeBox, compile, default-fill, unknown-prop rejection, `${ENV_VAR}` interpolation. |
| `packages/plugins/src/hook-bus.ts` | `PluginHookBus` (implements `HookBus`), `hookDispatchMode` never-guard, counters. |
| `packages/plugins/src/plugin-api.ts` | `createPluginApi` (runtime facade + registration buffer), `childLogger`, `deepFreeze`, `validateRegistrations`. |
| `packages/plugins/src/model-catalog.ts` | `createModelCatalog` + `validateProviderCatalog`. |
| `packages/plugins/src/config-store.ts` | `PluginConfigStore` (atomic temp+rename writes). |
| `packages/plugins/src/loader.ts` | `loadPlugins`: discovery, phase pipeline, commit, registry, shutdown. |
| `packages/plugins/src/loader.dist.test.ts` | Imports BUILT `dist/index.js`, runs `loadPlugins` over a fixture. |
| `packages/plugins/test/fixtures/*` | `kitchen-sink`, `audit-log`, `bad-manifest`, `bad-compat`, `bad-config`, `import-throws`, `register-throws`, `undeclared-capability`, `dup-tool`. |
| Root `package.json` | `workspaces` + `build` + `lint` additions. |
| `vitest.config.ts` | `@dash/plugin-sdk` source alias. |

---

## Task 1 — Scaffold `@dash/plugin-sdk` with the full type surface and `definePlugin`

**Files:**
- Create: `packages/plugin-sdk/package.json`
- Create: `packages/plugin-sdk/tsconfig.json`
- Create: `packages/plugin-sdk/src/index.ts`
- Test: `packages/plugin-sdk/src/api-baseline.test.ts`
- Modify: `package.json` (root — workspaces, build, lint)
- Modify: `vitest.config.ts` (alias)

**Steps:**

- [ ] Write the failing test `packages/plugin-sdk/src/api-baseline.test.ts`:

```ts
import type {
  AfterToolCallEvent,
  AfterToolCallVerdict,
  AgentRunEndEvent,
  AgentRunStartEvent,
  BeforeToolCallEvent,
  BeforeToolCallVerdict,
  CatalogModel,
  ChannelAdapterFactory,
  DashPlugin,
  DashPluginApi,
  HookContext,
  HookHandlerMap,
  HookName,
  HookOptions,
  MessageReceivedEvent,
  MessageReceivedVerdict,
  MessageSendingEvent,
  MessageSendingVerdict,
  PluginCapability,
  PluginChannelAdapter,
  PluginChannelHealth,
  PluginInboundMessage,
  PluginLogger,
  PluginManifest,
  PluginMessageHandler,
  PluginOutboundMessage,
  PluginTool,
  ProviderCatalog,
} from './index.js';
import * as sdk from './index.js';

/**
 * API baseline: the SDK surface is a cross-plan contract (the gateway and MC
 * plans are written against it verbatim). Any change to the exported names
 * must be made deliberately, here, in the same commit.
 *
 * Runtime exports are asserted below. The type-only surface is referenced in
 * the tuple so a removed/renamed type fails
 * `npm run typecheck --workspace=packages/plugin-sdk`
 * (vitest erases types; tsc enforces this).
 */
export type TypeSurfaceBaseline = [
  PluginCapability,
  PluginManifest,
  PluginTool,
  PluginInboundMessage,
  PluginOutboundMessage,
  PluginMessageHandler,
  PluginChannelHealth,
  PluginChannelAdapter,
  ChannelAdapterFactory,
  CatalogModel,
  ProviderCatalog,
  HookName,
  PluginLogger,
  HookContext,
  MessageReceivedEvent,
  MessageReceivedVerdict,
  BeforeToolCallEvent,
  BeforeToolCallVerdict,
  AfterToolCallEvent,
  AfterToolCallVerdict,
  MessageSendingEvent,
  MessageSendingVerdict,
  AgentRunStartEvent,
  AgentRunEndEvent,
  HookHandlerMap,
  HookOptions,
  DashPluginApi,
  DashPlugin,
];

const EXPECTED_RUNTIME_EXPORTS = ['definePlugin'];

describe('@dash/plugin-sdk API baseline', () => {
  it('exports exactly the expected runtime names', () => {
    expect(Object.keys(sdk).sort()).toEqual(EXPECTED_RUNTIME_EXPORTS);
  });

  it('definePlugin is a typed identity', () => {
    const plugin: DashPlugin = { register() {} };
    expect(sdk.definePlugin(plugin)).toBe(plugin);
  });
});
```

- [ ] Run `npx vitest run packages/plugin-sdk/src/api-baseline.test.ts` — expect failure (cannot resolve `./index.js`).

- [ ] Create `packages/plugin-sdk/package.json`:

```json
{
  "name": "@dash/plugin-sdk",
  "version": "0.2.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "typecheck": "tsc --noEmit"
  },
  "tsup": {
    "entry": ["src/index.ts"],
    "format": ["esm"],
    "dts": true,
    "clean": true,
    "sourcemap": true
  }
}
```

- [ ] Create `packages/plugin-sdk/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "types": ["node", "vitest/globals"]
  },
  "include": ["src"]
}
```

- [ ] Create `packages/plugin-sdk/src/index.ts` — the complete pinned surface:

```ts
/**
 * @dash/plugin-sdk — the author-facing contract for Dash plugins.
 *
 * Types-heavy, near-zero runtime: the only runtime exports are definePlugin()
 * (a typed identity) and createTestPluginApi() (a test helper). This package
 * must not depend on any other @dash package — plugin authors consume it
 * standalone. The plugin API version is the Dash version (unified semver);
 * manifests declare compatibility as { dash: '>=x.y.z' }.
 */

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export type PluginCapability = 'tools' | 'channels' | 'providers' | 'hooks';

export interface PluginManifest {
  /** kebab-case, unique across installed plugins. */
  name: string;
  version: string;
  description?: string;
  /** Relative path to the built ESM entry, e.g. './dist/index.js'. */
  entry: string;
  /** Minimum Dash version; '>=x.y.z' ranges only. */
  compat: { dash: string };
  capabilities: PluginCapability[];
  /** JSON Schema; string props may carry sensitive: true (masked in MC and logs). */
  configSchema?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/**
 * Structural mirror of @dash/agent's ExtraTool — the gateway injects plugin
 * tools into the backend's custom-tool list, where they are duck-typed.
 *
 * CONTRACT: execute() THROWS on error — pi-agent-core only flags a tool
 * result as an error when execute throws. Do not return error payloads.
 */
export interface PluginTool {
  name: string;
  label: string;
  description: string;
  /** TypeBox schema (or a structurally compatible JSON schema object). */
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: unknown,
  ) => Promise<{ content: Array<{ type: 'text'; text: string }>; details: unknown }>;
}

// ---------------------------------------------------------------------------
// Channels — structural VERBATIM mirrors of @dash/channels types
// (packages/channels/src/types.ts). @dash/plugins carries a compile-time
// assignability test (channel-compat.test.ts) keeping both directions in sync.
// ---------------------------------------------------------------------------

export interface PluginInboundMessage {
  channelId: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: Date;
  raw?: unknown;
}

export interface PluginOutboundMessage {
  text: string;
  parseMode?: 'Markdown' | 'HTML';
}

export type PluginMessageHandler = (msg: PluginInboundMessage) => Promise<void>;

export type PluginChannelHealth = 'connected' | 'connecting' | 'disconnected' | 'needs_reauth';

export interface PluginChannelAdapter {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(conversationId: string, message: PluginOutboundMessage): Promise<void>;
  onMessage(handler: PluginMessageHandler): void;
  getHealth(): PluginChannelHealth;
  onHealthChange(handler: (health: PluginChannelHealth) => void): void;
}

export type ChannelAdapterFactory = (config: Record<string, unknown>) => PluginChannelAdapter;

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

export interface CatalogModel {
  id: string;
  name?: string;
  /** Required — compaction reads it. */
  contextWindow: number;
  maxTokens: number;
  reasoning?: boolean;
  input?: ('text' | 'image')[];
  /** Per 1M tokens. */
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  compat?: Record<string, unknown>;
  headers?: Record<string, string>;
}

export interface ProviderCatalog {
  id: string;
  label: string;
  credentialPrefix: string;
  baseUrl: string;
  api: 'openai-completions' | 'anthropic-messages';
  models: CatalogModel[];
  /** OpenRouter-style: accept any model id under this provider. */
  dynamicModels?: boolean;
  /** Required if dynamicModels — lookup defaults for unknown model ids. */
  dynamicModelDefaults?: { contextWindow: number; maxTokens: number };
  /** Keyless locals (Ollama). */
  placeholderKey?: string;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export type HookName =
  | 'message_received'
  | 'before_tool_call'
  | 'after_tool_call'
  | 'message_sending'
  | 'agent_run_start'
  | 'agent_run_end';

export interface PluginLogger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export interface HookContext {
  pluginName: string;
  agentName?: string;
  channel?: string;
  sessionId?: string;
  logger: PluginLogger;
}

export interface MessageReceivedEvent {
  message: PluginInboundMessage;
  channel: string;
}
export type MessageReceivedVerdict =
  | { message: PluginInboundMessage }
  | { drop: true; reason?: string }
  | void;

export interface BeforeToolCallEvent {
  toolName: string;
  toolCallId: string;
  params: unknown;
}
export type BeforeToolCallVerdict = { params: unknown } | { block: true; reason: string } | void;

export interface AfterToolCallEvent {
  toolName: string;
  toolCallId: string;
  params: unknown;
  result: string;
  isError: boolean;
}
export type AfterToolCallVerdict = { result: string } | void;

export interface MessageSendingEvent {
  conversationId: string;
  content: string;
  channel: string;
}
export type MessageSendingVerdict = { content: string } | { cancel: true; reason?: string } | void;

export interface AgentRunStartEvent {
  agentName: string;
  sessionId?: string;
}
export interface AgentRunEndEvent {
  agentName: string;
  sessionId?: string;
  usage?: { inputTokens: number; outputTokens: number };
  error?: string;
}

export interface HookHandlerMap {
  message_received: (
    event: MessageReceivedEvent,
    ctx: HookContext,
  ) => MessageReceivedVerdict | Promise<MessageReceivedVerdict>;
  before_tool_call: (
    event: BeforeToolCallEvent,
    ctx: HookContext,
  ) => BeforeToolCallVerdict | Promise<BeforeToolCallVerdict>;
  after_tool_call: (
    event: AfterToolCallEvent,
    ctx: HookContext,
  ) => AfterToolCallVerdict | Promise<AfterToolCallVerdict>;
  message_sending: (
    event: MessageSendingEvent,
    ctx: HookContext,
  ) => MessageSendingVerdict | Promise<MessageSendingVerdict>;
  agent_run_start: (event: AgentRunStartEvent, ctx: HookContext) => void | Promise<void>;
  agent_run_end: (event: AgentRunEndEvent, ctx: HookContext) => void | Promise<void>;
}

export interface HookOptions {
  critical?: boolean;
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Plugin API
// ---------------------------------------------------------------------------

export interface DashPluginApi {
  registerTool(tool: PluginTool): void;
  registerChannel(
    adapterName: string,
    factory: ChannelAdapterFactory,
    opts?: { configSchema?: Record<string, unknown> },
  ): void;
  registerProvider(catalog: ProviderCatalog): void;
  on<K extends HookName>(hook: K, handler: HookHandlerMap[K], opts?: HookOptions): void;
  lifecycle: { onShutdown(fn: () => void | Promise<void>): void };
  config: Readonly<Record<string, unknown>>;
  logger: PluginLogger;
  runtime: { dataDir: string; getCredential(key: string): Promise<string | undefined> };
  meta: { name: string; version: string; dashVersion: string };
}

export interface DashPlugin {
  register(api: DashPluginApi): void | Promise<void>;
}

/** Typed identity — compile-time checking only, zero runtime behavior. */
export function definePlugin(plugin: DashPlugin): DashPlugin {
  return plugin;
}
```

- [ ] Modify the root `package.json`: add `"packages/plugin-sdk"` to `workspaces` (between `"packages/models"` and `"packages/projects"`); add `-w packages/plugin-sdk` to the `build` script (immediately after `-w packages/projects`); change `lint` to:

```json
"lint": "biome check . && npm run typecheck --workspace=apps/mission-control && npm run typecheck --workspace=packages/plugin-sdk"
```

- [ ] Modify `vitest.config.ts` — add to `resolve.alias` (alongside `@dash/projects`):

```ts
      '@dash/plugin-sdk': resolve(__dirname, 'packages/plugin-sdk/src/index.ts'),
```

- [ ] Run `npm install` (links the new workspace).
- [ ] Run `npx vitest run packages/plugin-sdk/src/api-baseline.test.ts` — expect pass.
- [ ] Run `npm run build -w packages/plugin-sdk` — expect `dist/index.js` + `dist/index.d.ts`.
- [ ] Run `npm run typecheck --workspace=packages/plugin-sdk` — expect pass.
- [ ] Run `npx biome check packages/plugin-sdk vitest.config.ts package.json` — fix if flagged.
- [ ] Commit:

```bash
git add packages/plugin-sdk/package.json packages/plugin-sdk/tsconfig.json \
  packages/plugin-sdk/src/index.ts packages/plugin-sdk/src/api-baseline.test.ts \
  package.json package-lock.json vitest.config.ts
git commit -m "feat(plugin-sdk): scaffold @dash/plugin-sdk with plugin API types and definePlugin"
```

---

## Task 2 — `createTestPluginApi` test helper

**Files:**
- Create: `packages/plugin-sdk/src/test-api.ts`
- Test: `packages/plugin-sdk/src/test-api.test.ts`
- Modify: `packages/plugin-sdk/src/index.ts` (re-export)
- Modify: `packages/plugin-sdk/src/api-baseline.test.ts` (baseline gains one name)

**Steps:**

- [ ] Write the failing test `packages/plugin-sdk/src/test-api.test.ts`:

```ts
import type { DashPlugin } from './index.js';
import { createTestPluginApi } from './test-api.js';

describe('createTestPluginApi', () => {
  it('collects every kind of registration', async () => {
    const { api, registrations } = createTestPluginApi();
    const plugin: DashPlugin = {
      register(a) {
        a.registerTool({
          name: 'demo_tool',
          label: 'Demo',
          description: 'demo',
          parameters: { type: 'object', properties: {} },
          execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: {} }),
        });
        a.registerChannel(
          'demo-chat',
          () => ({
            name: 'demo-chat',
            start: async () => {},
            stop: async () => {},
            send: async () => {},
            onMessage: () => {},
            getHealth: () => 'connected' as const,
            onHealthChange: () => {},
          }),
          { configSchema: { type: 'object' } },
        );
        a.registerProvider({
          id: 'demoai',
          label: 'DemoAI',
          credentialPrefix: 'demoai-api-key',
          baseUrl: 'https://demo.example/v1',
          api: 'openai-completions',
          models: [{ id: 'demo-1', contextWindow: 8192, maxTokens: 2048 }],
        });
        a.on('before_tool_call', () => undefined, { critical: true, timeoutMs: 500 });
        a.lifecycle.onShutdown(() => {});
      },
    };
    await plugin.register(api);
    expect(registrations.tools.map((t) => t.name)).toEqual(['demo_tool']);
    expect(registrations.channels[0]?.adapterName).toBe('demo-chat');
    expect(registrations.channels[0]?.configSchema).toEqual({ type: 'object' });
    expect(registrations.providers[0]?.id).toBe('demoai');
    expect(registrations.hooks[0]?.hook).toBe('before_tool_call');
    expect(registrations.hooks[0]?.opts).toEqual({ critical: true, timeoutMs: 500 });
    expect(registrations.shutdownHandlers).toHaveLength(1);
  });

  it('applies config and dataDir overrides and freezes config', () => {
    const { api } = createTestPluginApi({ config: { greeting: 'hi' }, dataDir: '/tmp/x' });
    expect(api.config.greeting).toBe('hi');
    expect(Object.isFrozen(api.config)).toBe(true);
    expect(api.runtime.dataDir).toBe('/tmp/x');
    expect(api.meta.name).toBe('test-plugin');
  });

  it('getCredential resolves undefined by default', async () => {
    const { api } = createTestPluginApi();
    await expect(api.runtime.getCredential('any-key')).resolves.toBeUndefined();
  });
});
```

- [ ] Run `npx vitest run packages/plugin-sdk/src/test-api.test.ts` — expect failure (module missing).

- [ ] Create `packages/plugin-sdk/src/test-api.ts`:

```ts
import type {
  ChannelAdapterFactory,
  DashPluginApi,
  HookName,
  HookOptions,
  PluginLogger,
  PluginTool,
  ProviderCatalog,
} from './index.js';

export interface TestPluginRegistrations {
  tools: PluginTool[];
  channels: Array<{
    adapterName: string;
    factory: ChannelAdapterFactory;
    configSchema?: Record<string, unknown>;
  }>;
  providers: ProviderCatalog[];
  hooks: Array<{ hook: HookName; handler: unknown; opts?: HookOptions }>;
  shutdownHandlers: Array<() => void | Promise<void>>;
}

function noopLogger(): PluginLogger {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

/**
 * Author-side unit-test helper: a DashPluginApi whose registrations are
 * collected into plain arrays instead of a live gateway. Zero I/O.
 */
export function createTestPluginApi(overrides?: {
  config?: Record<string, unknown>;
  dataDir?: string;
}): { api: DashPluginApi; registrations: TestPluginRegistrations } {
  const registrations: TestPluginRegistrations = {
    tools: [],
    channels: [],
    providers: [],
    hooks: [],
    shutdownHandlers: [],
  };
  const api: DashPluginApi = {
    registerTool(tool) {
      registrations.tools.push(tool);
    },
    registerChannel(adapterName, factory, opts) {
      registrations.channels.push({ adapterName, factory, configSchema: opts?.configSchema });
    },
    registerProvider(catalog) {
      registrations.providers.push(catalog);
    },
    on(hook, handler, opts) {
      registrations.hooks.push({ hook, handler, opts });
    },
    lifecycle: {
      onShutdown(fn) {
        registrations.shutdownHandlers.push(fn);
      },
    },
    config: Object.freeze({ ...(overrides?.config ?? {}) }),
    logger: noopLogger(),
    runtime: {
      dataDir: overrides?.dataDir ?? '/tmp/dash-test-plugin',
      getCredential: async () => undefined,
    },
    meta: { name: 'test-plugin', version: '0.0.0', dashVersion: '0.0.0' },
  };
  return { api, registrations };
}
```

- [ ] Append to `packages/plugin-sdk/src/index.ts` (bottom of file):

```ts
export { createTestPluginApi } from './test-api.js';
export type { TestPluginRegistrations } from './test-api.js';
```

- [ ] Update `packages/plugin-sdk/src/api-baseline.test.ts`: change the expected list to `const EXPECTED_RUNTIME_EXPORTS = ['createTestPluginApi', 'definePlugin'];`, add `TestPluginRegistrations` to the type-import block and append it as the last member of `TypeSurfaceBaseline`.
- [ ] Run `npx vitest run packages/plugin-sdk` — expect both test files pass.
- [ ] Run `npm run build -w packages/plugin-sdk && npm run typecheck --workspace=packages/plugin-sdk` — expect pass.
- [ ] Commit:

```bash
git add packages/plugin-sdk/src/test-api.ts packages/plugin-sdk/src/test-api.test.ts \
  packages/plugin-sdk/src/index.ts packages/plugin-sdk/src/api-baseline.test.ts
git commit -m "feat(plugin-sdk): add createTestPluginApi test helper"
```

---

## Task 3 — Scaffold `@dash/plugins` with host types and the channel assignability test

**Files:**
- Create: `packages/plugins/package.json`
- Create: `packages/plugins/tsconfig.json`
- Create: `packages/plugins/src/types.ts`
- Create: `packages/plugins/src/index.ts`
- Test: `packages/plugins/src/channel-compat.test.ts`
- Modify: `package.json` (root — workspaces, build, lint)

**Steps:**

- [ ] Write the test `packages/plugins/src/channel-compat.test.ts` (fails until the package scaffolding exists and resolves):

```ts
import type {
  ChannelAdapter,
  ChannelHealth,
  InboundMessage,
  MessageHandler,
  OutboundMessage,
} from '@dash/channels';
import type {
  PluginChannelAdapter,
  PluginChannelHealth,
  PluginInboundMessage,
  PluginMessageHandler,
  PluginOutboundMessage,
} from '@dash/plugin-sdk';

/**
 * Compile-time assignability in BOTH directions: the SDK's channel types are
 * structural mirrors of @dash/channels and must stay verbatim-identical.
 * vitest erases types — these checks are enforced by
 * `npm run typecheck --workspace=packages/plugins` (wired into root lint).
 */
const adapterToCore: ChannelAdapter = {} as PluginChannelAdapter;
const adapterFromCore: PluginChannelAdapter = {} as ChannelAdapter;
const inboundToCore: InboundMessage = {} as PluginInboundMessage;
const inboundFromCore: PluginInboundMessage = {} as InboundMessage;
const outboundToCore: OutboundMessage = {} as PluginOutboundMessage;
const outboundFromCore: PluginOutboundMessage = {} as OutboundMessage;
const healthToCore: ChannelHealth = {} as PluginChannelHealth;
const healthFromCore: PluginChannelHealth = {} as ChannelHealth;
const handlerToCore: MessageHandler = {} as PluginMessageHandler;
const handlerFromCore: PluginMessageHandler = {} as MessageHandler;

const checks = [
  adapterToCore,
  adapterFromCore,
  inboundToCore,
  inboundFromCore,
  outboundToCore,
  outboundFromCore,
  healthToCore,
  healthFromCore,
  handlerToCore,
  handlerFromCore,
];

describe('PluginChannelAdapter / ChannelAdapter structural parity', () => {
  it('compiles in both directions (enforced by tsc, see header comment)', () => {
    expect(checks).toHaveLength(10);
  });
});
```

- [ ] Run `npx vitest run packages/plugins/src/channel-compat.test.ts` — expect failure (package not yet a workspace / module resolution).

- [ ] Create `packages/plugins/package.json`:

```json
{
  "name": "@dash/plugins",
  "version": "0.2.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@dash/plugin-sdk": "*",
    "@sinclair/typebox": "^0.34.0"
  },
  "devDependencies": {
    "@dash/channels": "*"
  },
  "tsup": {
    "entry": ["src/index.ts"],
    "format": ["esm"],
    "dts": true,
    "clean": true,
    "sourcemap": true
  }
}
```

- [ ] Create `packages/plugins/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "types": ["node", "vitest/globals"]
  },
  "include": ["src"]
}
```

- [ ] Create `packages/plugins/src/types.ts` — the pinned host types:

```ts
import type {
  AgentRunEndEvent,
  AgentRunStartEvent,
  AfterToolCallEvent,
  BeforeToolCallEvent,
  ChannelAdapterFactory,
  HookName,
  MessageReceivedEvent,
  MessageSendingEvent,
  PluginCapability,
  PluginInboundMessage,
  PluginTool,
  ProviderCatalog,
} from '@dash/plugin-sdk';

export type PluginStatus = 'loaded' | 'disabled' | 'error';

export type PluginFailurePhase = 'manifest' | 'compat' | 'config' | 'import' | 'register';

export interface PluginFailure {
  phase: PluginFailurePhase;
  error: string;
  /** ISO timestamp. */
  failedAt: string;
}

export interface PluginRecord {
  name: string;
  version: string;
  description?: string;
  status: PluginStatus;
  capabilities: PluginCapability[];
  failure?: PluginFailure;
  registrations: { tools: number; channels: number; providers: number; hooks: number };
  configSchema?: Record<string, unknown>;
  /** Validated + interpolated (NOT masked — masking is API-layer). */
  config?: Record<string, unknown>;
  dir: string;
}

export interface PluginRegistry {
  list(): PluginRecord[];
  get(name: string): PluginRecord | undefined;
}

export interface HookCounters {
  fired: number;
  modified: number;
  blocked: number;
  failed: number;
  timedOut: number;
}

export interface HookDispatchContext {
  agentName?: string;
  channel?: string;
  sessionId?: string;
}

export interface HookBus {
  messageReceived(
    event: MessageReceivedEvent,
    ctx: HookDispatchContext,
  ): Promise<{ message: PluginInboundMessage } | { dropped: true }>;
  messageSending(
    event: MessageSendingEvent,
    ctx: HookDispatchContext,
  ): Promise<{ content: string } | { cancelled: true }>;
  beforeToolCall(
    event: BeforeToolCallEvent,
    ctx: HookDispatchContext,
  ): Promise<{ params: unknown } | { blocked: true; reason: string }>;
  afterToolCall(event: AfterToolCallEvent, ctx: HookDispatchContext): Promise<{ result: string }>;
  /** Fire-and-forget. */
  agentRunStart(event: AgentRunStartEvent, ctx: HookDispatchContext): void;
  /** Fire-and-forget. */
  agentRunEnd(event: AgentRunEndEvent, ctx: HookDispatchContext): void;
  /** pluginName → hook → counters. */
  counters(): Record<string, Partial<Record<HookName, HookCounters>>>;
}

export interface PluginEntryConfig {
  enabled: boolean;
  config?: Record<string, unknown>;
  path?: string;
}

export interface LoadedPlugins {
  tools: Array<{ pluginName: string; tool: PluginTool }>;
  channelFactories: Map<
    string,
    { pluginName: string; factory: ChannelAdapterFactory; configSchema?: Record<string, unknown> }
  >;
  providerCatalogs: ProviderCatalog[];
  hookBus: HookBus;
  registry: PluginRegistry;
  shutdown(): Promise<void>;
}

/**
 * Model catalog output for @dash/agent's resolveModel fallback — structurally
 * matches the ModelCatalogLookup that Plan 2 declares in @dash/agent.
 */
export interface ResolvedCatalogModel {
  provider: string;
  modelId: string;
  baseUrl: string;
  api: string;
  name?: string;
  contextWindow: number;
  maxTokens: number;
  reasoning?: boolean;
  input?: ('text' | 'image')[];
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  compat?: Record<string, unknown>;
  headers?: Record<string, string>;
}
```

- [ ] Create `packages/plugins/src/index.ts` (barrel — grows in later tasks):

```ts
export type {
  HookBus,
  HookCounters,
  HookDispatchContext,
  LoadedPlugins,
  PluginEntryConfig,
  PluginFailure,
  PluginFailurePhase,
  PluginRecord,
  PluginRegistry,
  PluginStatus,
  ResolvedCatalogModel,
} from './types.js';
```

- [ ] Modify the root `package.json`: add `"packages/plugins"` to `workspaces` (right after `"packages/plugin-sdk"`); add `-w packages/plugins` to `build` (right after `-w packages/plugin-sdk`); append to `lint`: `&& npm run typecheck --workspace=packages/plugins`.
- [ ] Run `npm install`.
- [ ] Run `npx vitest run packages/plugins/src/channel-compat.test.ts` — expect pass.
- [ ] Run `npm run build -w packages/plugin-sdk -w packages/channels -w packages/plugins` then `npm run typecheck --workspace=packages/plugins` — expect pass (typecheck resolves `@dash/channels`/`@dash/plugin-sdk` through their built `dist/index.d.ts`).
- [ ] Run `npx biome check packages/plugins package.json` — fix if flagged.
- [ ] Commit:

```bash
git add packages/plugins/package.json packages/plugins/tsconfig.json \
  packages/plugins/src/types.ts packages/plugins/src/index.ts \
  packages/plugins/src/channel-compat.test.ts package.json package-lock.json
git commit -m "feat(plugins): scaffold @dash/plugins with host types and channel parity test"
```

---

## Task 4 — Manifest reading and validation

**Files:**
- Create: `packages/plugins/src/manifest.ts`
- Test: `packages/plugins/src/manifest.test.ts`

**Steps:**

- [ ] Write the failing test `packages/plugins/src/manifest.test.ts`:

```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MANIFEST_FILENAME, readManifest, validateManifest } from './manifest.js';

const VALID = {
  name: 'discord-channel',
  version: '0.1.0',
  description: 'Discord channel adapter',
  entry: './dist/index.js',
  compat: { dash: '>=0.3.0' },
  capabilities: ['channels', 'hooks'],
  configSchema: { type: 'object', properties: { botToken: { type: 'string', sensitive: true } } },
};

describe('validateManifest', () => {
  it('accepts a valid manifest and returns typed fields', () => {
    const m = validateManifest(VALID);
    expect(m.name).toBe('discord-channel');
    expect(m.compat.dash).toBe('>=0.3.0');
    expect(m.capabilities).toEqual(['channels', 'hooks']);
  });

  it('rejects non-object input', () => {
    expect(() => validateManifest([])).toThrow(/object/);
    expect(() => validateManifest('x')).toThrow(/object/);
  });

  it('requires name, version, entry, compat.dash', () => {
    expect(() => validateManifest({ ...VALID, name: undefined })).toThrow(/'name'/);
    expect(() => validateManifest({ ...VALID, version: undefined })).toThrow(/'version'/);
    expect(() => validateManifest({ ...VALID, entry: undefined })).toThrow(/'entry'/);
    expect(() => validateManifest({ ...VALID, compat: {} })).toThrow(/'compat.dash'/);
    expect(() => validateManifest({ ...VALID, compat: undefined })).toThrow(/'compat.dash'/);
  });

  it('enforces kebab-case names', () => {
    for (const bad of ['MyPlugin', 'my_plugin', '-lead', 'trail-', 'has space', 'UPPER']) {
      expect(() => validateManifest({ ...VALID, name: bad })).toThrow(/kebab-case/);
    }
    expect(() => validateManifest({ ...VALID, name: 'a-b-2' })).not.toThrow();
  });

  it('validates the capabilities array', () => {
    expect(() => validateManifest({ ...VALID, capabilities: 'tools' })).toThrow(/array/);
    expect(() => validateManifest({ ...VALID, capabilities: ['nope'] })).toThrow(/capability/);
    expect(validateManifest({ ...VALID, capabilities: [] }).capabilities).toEqual([]);
  });

  it('rejects non-object configSchema and non-string description', () => {
    expect(() => validateManifest({ ...VALID, configSchema: 'x' })).toThrow(/configSchema/);
    expect(() => validateManifest({ ...VALID, description: 5 })).toThrow(/description/);
  });
});

describe('readManifest', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'plugins-manifest-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads and validates dash.plugin.json from a dir', async () => {
    await writeFile(join(dir, MANIFEST_FILENAME), JSON.stringify(VALID));
    const m = await readManifest(dir);
    expect(m.name).toBe('discord-channel');
  });

  it('throws a clear error when the manifest file is missing', async () => {
    await expect(readManifest(dir)).rejects.toThrow(/missing dash\.plugin\.json/);
  });

  it('throws a clear error on invalid JSON (strict parse)', async () => {
    await writeFile(join(dir, MANIFEST_FILENAME), '{ name: nope }');
    await expect(readManifest(dir)).rejects.toThrow(/invalid JSON/);
  });
});
```

- [ ] Run `npx vitest run packages/plugins/src/manifest.test.ts` — expect failure (module missing).

- [ ] Create `packages/plugins/src/manifest.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PluginCapability, PluginManifest } from '@dash/plugin-sdk';

export const MANIFEST_FILENAME = 'dash.plugin.json';

const CAPABILITIES: readonly PluginCapability[] = ['tools', 'channels', 'providers', 'hooks'];
const KEBAB_CASE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Validates a parsed manifest object. Throws Error with a precise message. */
export function validateManifest(raw: unknown): PluginManifest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('manifest must be a JSON object');
  }
  const m = raw as Record<string, unknown>;
  if (typeof m.name !== 'string' || m.name.length === 0) {
    throw new Error("manifest 'name' is required and must be a string");
  }
  if (!KEBAB_CASE.test(m.name)) {
    throw new Error(`manifest 'name' must be kebab-case, got '${m.name}'`);
  }
  if (typeof m.version !== 'string' || m.version.length === 0) {
    throw new Error("manifest 'version' is required and must be a string");
  }
  if (typeof m.entry !== 'string' || m.entry.length === 0) {
    throw new Error("manifest 'entry' is required and must be a string");
  }
  const compat = m.compat as Record<string, unknown> | undefined;
  if (
    typeof compat !== 'object' ||
    compat === null ||
    typeof compat.dash !== 'string' ||
    compat.dash.length === 0
  ) {
    throw new Error("manifest 'compat.dash' is required and must be a string like '>=0.3.0'");
  }
  if (!Array.isArray(m.capabilities)) {
    throw new Error("manifest 'capabilities' must be an array");
  }
  for (const c of m.capabilities) {
    if (!CAPABILITIES.includes(c as PluginCapability)) {
      throw new Error(
        `manifest declares unknown capability '${String(c)}' (known: ${CAPABILITIES.join(', ')})`,
      );
    }
  }
  if (m.description !== undefined && typeof m.description !== 'string') {
    throw new Error("manifest 'description' must be a string when present");
  }
  if (
    m.configSchema !== undefined &&
    (typeof m.configSchema !== 'object' || m.configSchema === null || Array.isArray(m.configSchema))
  ) {
    throw new Error("manifest 'configSchema' must be a JSON Schema object when present");
  }
  return {
    name: m.name,
    version: m.version,
    description: m.description as string | undefined,
    entry: m.entry,
    compat: { dash: compat.dash },
    capabilities: m.capabilities as PluginCapability[],
    configSchema: m.configSchema as Record<string, unknown> | undefined,
  };
}

/** Reads + strictly parses + validates `<dir>/dash.plugin.json`. */
export async function readManifest(dir: string): Promise<PluginManifest> {
  const path = join(dir, MANIFEST_FILENAME);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new Error(`missing ${MANIFEST_FILENAME} in ${dir}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`invalid JSON in ${path}: ${(err as Error).message}`);
  }
  return validateManifest(raw);
}
```

- [ ] Run `npx vitest run packages/plugins/src/manifest.test.ts` — expect pass.
- [ ] Commit:

```bash
git add packages/plugins/src/manifest.ts packages/plugins/src/manifest.test.ts
git commit -m "feat(plugins): manifest reading and strict validation"
```

---

## Task 5 — `satisfiesMinVersion` compat check

**Files:**
- Create: `packages/plugins/src/compat.ts`
- Test: `packages/plugins/src/compat.test.ts`

**Steps:**

- [ ] Write the failing test `packages/plugins/src/compat.test.ts`:

```ts
import { satisfiesMinVersion } from './compat.js';

describe('satisfiesMinVersion', () => {
  it('accepts equal and greater versions', () => {
    expect(satisfiesMinVersion('>=0.3.0', '0.3.0')).toBe(true);
    expect(satisfiesMinVersion('>=0.3.0', '0.3.1')).toBe(true);
    expect(satisfiesMinVersion('>=0.3.0', '0.4.0')).toBe(true);
    expect(satisfiesMinVersion('>=0.3.0', '1.0.0')).toBe(true);
  });

  it('rejects lower versions', () => {
    expect(satisfiesMinVersion('>=0.3.0', '0.2.9')).toBe(false);
    expect(satisfiesMinVersion('>=1.2.3', '1.2.2')).toBe(false);
    expect(satisfiesMinVersion('>=2.0.0', '1.99.99')).toBe(false);
  });

  it('compares numerically, not lexically', () => {
    expect(satisfiesMinVersion('>=0.9.0', '0.10.0')).toBe(true);
  });

  it('tolerates whitespace and prerelease suffixes on the version', () => {
    expect(satisfiesMinVersion('>= 0.3.0', '0.3.0')).toBe(true);
    expect(satisfiesMinVersion('>=0.3.0', '0.3.0-beta.1')).toBe(true);
  });

  it('throws on unsupported range syntax (only >=x.y.z is supported)', () => {
    for (const bad of ['^0.3.0', '~0.3.0', '0.3.0', '>0.3.0', '<=0.3.0', '>=0.3', 'latest']) {
      expect(() => satisfiesMinVersion(bad, '0.3.0')).toThrow(/only '>=x\.y\.z'/);
    }
  });

  it('throws on an unparseable dash version', () => {
    expect(() => satisfiesMinVersion('>=0.3.0', 'dev')).toThrow(/invalid dash version/);
  });
});
```

- [ ] Run `npx vitest run packages/plugins/src/compat.test.ts` — expect failure (module missing).

- [ ] Create `packages/plugins/src/compat.ts`:

```ts
const RANGE = /^>=\s*(\d+)\.(\d+)\.(\d+)$/;
const VERSION = /^(\d+)\.(\d+)\.(\d+)/;

/**
 * Minimal semver-range check supporting ONLY '>=x.y.z' ranges — deliberately
 * not a semver dependency. LIMITATION (documented): no ^, ~, <, >, ||,
 * x-ranges, or prerelease ordering (a '-beta' suffix on the running version
 * is ignored; the numeric triple decides). Manifests must use '>=x.y.z'.
 */
export function satisfiesMinVersion(range: string, version: string): boolean {
  const r = RANGE.exec(range.trim());
  if (!r) {
    throw new Error(`unsupported compat range '${range}' — only '>=x.y.z' is supported`);
  }
  const v = VERSION.exec(version.trim());
  if (!v) {
    throw new Error(`invalid dash version '${version}'`);
  }
  const [rMaj, rMin, rPat] = [Number(r[1]), Number(r[2]), Number(r[3])];
  const [vMaj, vMin, vPat] = [Number(v[1]), Number(v[2]), Number(v[3])];
  if (vMaj !== rMaj) return vMaj > rMaj;
  if (vMin !== rMin) return vMin > rMin;
  return vPat >= rPat;
}
```

- [ ] Run `npx vitest run packages/plugins/src/compat.test.ts` — expect pass.
- [ ] Commit:

```bash
git add packages/plugins/src/compat.ts packages/plugins/src/compat.test.ts
git commit -m "feat(plugins): minimal >=x.y.z compat range check"
```

---

## Task 6 — Config validation (TypeBox) and `${ENV_VAR}` interpolation

**Files:**
- Create: `packages/plugins/src/config.ts`
- Test: `packages/plugins/src/config.test.ts`

**Steps:**

- [ ] Write the failing test `packages/plugins/src/config.test.ts`:

```ts
import { interpolateEnvConfig, validatePluginConfig } from './config.js';

const SCHEMA = {
  type: 'object',
  properties: {
    botToken: { type: 'string', title: 'Bot token', sensitive: true },
    guildId: { type: 'string' },
    retries: { type: 'number', default: 3 },
    verbose: { type: 'boolean', default: false },
    mode: { type: 'string', enum: ['poll', 'webhook'], default: 'poll' },
    tags: { type: 'array', items: { type: 'string' } },
  },
  required: ['botToken'],
};

describe('validatePluginConfig', () => {
  it('accepts valid config and fills defaults', () => {
    const out = validatePluginConfig(SCHEMA, { botToken: 'tok', tags: ['a'] });
    expect(out).toEqual({
      botToken: 'tok',
      retries: 3,
      verbose: false,
      mode: 'poll',
      tags: ['a'],
    });
  });

  it('rejects missing required props', () => {
    expect(() => validatePluginConfig(SCHEMA, {})).toThrow(/invalid config/);
  });

  it('rejects wrong types and bad enum values', () => {
    expect(() => validatePluginConfig(SCHEMA, { botToken: 5 })).toThrow(/invalid config/);
    expect(() => validatePluginConfig(SCHEMA, { botToken: 't', mode: 'push' })).toThrow(
      /invalid config/,
    );
  });

  it('rejects unknown props by default', () => {
    expect(() => validatePluginConfig(SCHEMA, { botToken: 't', nope: 1 })).toThrow(
      /invalid config/,
    );
  });

  it('no schema: empty config passes, non-empty config fails', () => {
    expect(validatePluginConfig(undefined, {})).toEqual({});
    expect(() => validatePluginConfig(undefined, { a: 1 })).toThrow(/no configSchema/);
  });

  it('throws a clear error on unsupported schema constructs', () => {
    expect(() =>
      validatePluginConfig({ type: 'object', properties: { x: { oneOf: [] } } }, { x: 1 }),
    ).toThrow(/unsupported configSchema/);
  });

  it('interpolates env vars after validation', () => {
    process.env.DASH_TEST_TOKEN = 'secret-1';
    try {
      const out = validatePluginConfig(SCHEMA, { botToken: '${DASH_TEST_TOKEN}' });
      expect(out.botToken).toBe('secret-1');
    } finally {
      delete process.env.DASH_TEST_TOKEN;
    }
  });
});

describe('interpolateEnvConfig', () => {
  beforeEach(() => {
    process.env.DASH_TEST_VAR = 'abc';
  });

  afterEach(() => {
    delete process.env.DASH_TEST_VAR;
  });

  it('replaces whole-value form', () => {
    expect(interpolateEnvConfig({ k: '${DASH_TEST_VAR}' })).toEqual({ k: 'abc' });
  });

  it('replaces embedded form', () => {
    expect(interpolateEnvConfig({ k: 'pre-${DASH_TEST_VAR}-post' })).toEqual({
      k: 'pre-abc-post',
    });
  });

  it('recurses into arrays and nested objects, leaves non-strings alone', () => {
    expect(
      interpolateEnvConfig({ a: ['${DASH_TEST_VAR}', 5], b: { c: '${DASH_TEST_VAR}' }, d: true }),
    ).toEqual({ a: ['abc', 5], b: { c: 'abc' }, d: true });
  });

  it('throws when the env var is missing', () => {
    expect(() => interpolateEnvConfig({ k: '${DASH_TEST_MISSING_VAR}' })).toThrow(
      /DASH_TEST_MISSING_VAR/,
    );
  });
});
```

- [ ] Run `npx vitest run packages/plugins/src/config.test.ts` — expect failure (module missing).

- [ ] Create `packages/plugins/src/config.ts`:

```ts
import { type TSchema, Type } from '@sinclair/typebox';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import { Value } from '@sinclair/typebox/value';

/**
 * Manifest configSchema is plain JSON Schema, but TypeBox's compiler
 * dispatches on the [Kind] symbol that plain JSON lacks (verified against
 * typebox 0.34: it throws TypeCompilerUnknownTypeError). So we convert the
 * supported JSON Schema subset into TypeBox types, then Compile.
 *
 * Supported subset: type object/string/number/integer/boolean/array, enum,
 * properties, required, items, default, additionalProperties. Foreign
 * keywords (sensitive, title, description, …) pass through as options.
 * Anything else is an error — plugin config schemas are deliberately simple.
 */
function toTypeBox(node: Record<string, unknown>): TSchema {
  const {
    type,
    properties,
    required,
    items,
    enum: enumValues,
    additionalProperties,
    ...rest
  } = node;
  if (Array.isArray(enumValues)) {
    const literals = enumValues.map((v) => Type.Literal(v as string | number | boolean));
    return Type.Union(literals, rest);
  }
  switch (type) {
    case 'object': {
      const props: Record<string, TSchema> = {};
      const req = new Set(Array.isArray(required) ? (required as string[]) : []);
      const propEntries = Object.entries(
        (properties ?? {}) as Record<string, Record<string, unknown>>,
      );
      for (const [key, sub] of propEntries) {
        const t = toTypeBox(sub);
        props[key] = req.has(key) ? t : Type.Optional(t);
      }
      // Unknown props are rejected unless the author explicitly allows them.
      return Type.Object(props, { ...rest, additionalProperties: additionalProperties === true });
    }
    case 'string':
      return Type.String(rest);
    case 'number':
      return Type.Number(rest);
    case 'integer':
      return Type.Integer(rest);
    case 'boolean':
      return Type.Boolean(rest);
    case 'array': {
      if (typeof items !== 'object' || items === null) {
        throw new Error("unsupported configSchema: array requires an 'items' schema");
      }
      return Type.Array(toTypeBox(items as Record<string, unknown>), rest);
    }
    default:
      throw new Error(
        `unsupported configSchema construct (type '${String(type)}'); supported: object, ` +
          'string, number, integer, boolean, array, enum',
      );
  }
}

/**
 * Validates user config against the manifest configSchema: default-fill,
 * type check, unknown-prop rejection — then ${ENV_VAR} interpolation (after
 * validation, so secrets stay out of config files but schemas see strings).
 * Throws Error on any failure (the loader records it as a 'config' phase
 * failure).
 */
export function validatePluginConfig(
  configSchema: Record<string, unknown> | undefined,
  config: Record<string, unknown>,
): Record<string, unknown> {
  if (!configSchema) {
    if (Object.keys(config).length > 0) {
      throw new Error('plugin declares no configSchema but config was provided');
    }
    return {};
  }
  const schema = toTypeBox(configSchema);
  const filled = Value.Default(schema, Value.Clone(config)) as Record<string, unknown>;
  const compiled = TypeCompiler.Compile(schema);
  if (!compiled.Check(filled)) {
    const first = compiled.Errors(filled).First();
    const detail = first ? ` at '${first.path || '/'}': ${first.message}` : '';
    throw new Error(`invalid config${detail}`);
  }
  return interpolateEnvConfig(filled);
}

const ENV_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Replaces ${ENV_VAR} in every string value (whole-value and embedded forms),
 * recursing into arrays and nested objects. A missing env var throws — the
 * loader records it as a 'config' phase failure.
 */
export function interpolateEnvConfig(config: Record<string, unknown>): Record<string, unknown> {
  return interpolateValue(config) as Record<string, unknown>;
}

function interpolateValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(ENV_PATTERN, (_match, name: string) => {
      const resolved = process.env[name];
      if (resolved === undefined) {
        throw new Error(`config references undefined environment variable \${${name}}`);
      }
      return resolved;
    });
  }
  if (Array.isArray(value)) {
    return value.map(interpolateValue);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, interpolateValue(v)]),
    );
  }
  return value;
}
```

- [ ] Run `npx vitest run packages/plugins/src/config.test.ts` — expect pass.
- [ ] Commit:

```bash
git add packages/plugins/src/config.ts packages/plugins/src/config.test.ts
git commit -m "feat(plugins): TypeBox config validation with defaults and env interpolation"
```

---

## Task 7 — HookBus core: threading, terminal verdicts, order, never-guard

**Files:**
- Create: `packages/plugins/src/hook-bus.ts`
- Test: `packages/plugins/src/hook-bus.test.ts`

**Steps:**

- [ ] Write the failing test `packages/plugins/src/hook-bus.test.ts`:

```ts
import type { MessageReceivedEvent, PluginInboundMessage, PluginLogger } from '@dash/plugin-sdk';
import { hookDispatchMode, PluginHookBus } from './hook-bus.js';

const silentLogger: PluginLogger = { debug() {}, info() {}, warn() {}, error() {} };

function inbound(text: string): PluginInboundMessage {
  return {
    channelId: 'telegram',
    conversationId: 'c1',
    senderId: 'u1',
    senderName: 'User',
    text,
    timestamp: new Date('2026-06-10T00:00:00Z'),
  };
}

function received(text: string): MessageReceivedEvent {
  return { message: inbound(text), channel: 'telegram' };
}

describe('hookDispatchMode', () => {
  it('classifies modify vs observe hooks and never-guards unknown names', () => {
    expect(hookDispatchMode('message_received')).toBe('threaded');
    expect(hookDispatchMode('before_tool_call')).toBe('threaded');
    expect(hookDispatchMode('after_tool_call')).toBe('threaded');
    expect(hookDispatchMode('message_sending')).toBe('threaded');
    expect(hookDispatchMode('agent_run_start')).toBe('observe');
    expect(hookDispatchMode('agent_run_end')).toBe('observe');
    // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid input
    expect(() => hookDispatchMode('PreToolUse' as any)).toThrow(/unknown hook/);
  });
});

describe('PluginHookBus threading and terminal verdicts', () => {
  let bus: PluginHookBus;

  beforeEach(() => {
    bus = new PluginHookBus(silentLogger);
  });

  it('messageReceived with no handlers passes the message through', async () => {
    const out = await bus.messageReceived(received('hi'), {});
    expect(out).toEqual({ message: inbound('hi') });
  });

  it('threads message rewrites in plugin load order', async () => {
    const seen: string[] = [];
    bus.addHandler(
      'p1',
      'message_received',
      (event) => {
        seen.push(event.message.text);
        return { message: { ...event.message, text: event.message.text.toUpperCase() } };
      },
      undefined,
      silentLogger,
    );
    bus.addHandler(
      'p2',
      'message_received',
      (event) => {
        seen.push(event.message.text);
        return { message: { ...event.message, text: `${event.message.text}!` } };
      },
      undefined,
      silentLogger,
    );
    const out = await bus.messageReceived(received('hi'), {});
    expect(seen).toEqual(['hi', 'HI']); // p2 saw p1's rewrite — threading fixed
    expect('message' in out && out.message.text).toBe('HI!');
  });

  it('drop verdict stops the chain', async () => {
    let secondRan = false;
    bus.addHandler('p1', 'message_received', () => ({ drop: true, reason: 'spam' }), undefined, silentLogger);
    bus.addHandler(
      'p2',
      'message_received',
      () => {
        secondRan = true;
      },
      undefined,
      silentLogger,
    );
    const out = await bus.messageReceived(received('buy now'), {});
    expect(out).toEqual({ dropped: true });
    expect(secondRan).toBe(false);
  });

  it('void verdict leaves the payload unchanged', async () => {
    bus.addHandler('p1', 'message_received', () => undefined, undefined, silentLogger);
    const out = await bus.messageReceived(received('hi'), {});
    expect('message' in out && out.message.text).toBe('hi');
  });

  it('beforeToolCall threads params and formats block reasons', async () => {
    bus.addHandler(
      'p1',
      'before_tool_call',
      (event) => ({ params: { ...(event.params as object), redacted: true } }),
      undefined,
      silentLogger,
    );
    const ok = await bus.beforeToolCall(
      { toolName: 'bash', toolCallId: 't1', params: { cmd: 'ls' } },
      {},
    );
    expect(ok).toEqual({ params: { cmd: 'ls', redacted: true } });

    bus.addHandler(
      'guard',
      'before_tool_call',
      () => ({ block: true, reason: 'rm is forbidden' }),
      undefined,
      silentLogger,
    );
    const blocked = await bus.beforeToolCall(
      { toolName: 'bash', toolCallId: 't2', params: { cmd: 'rm -rf /' } },
      {},
    );
    expect(blocked).toEqual({ blocked: true, reason: 'policy (guard): rm is forbidden' });
  });

  it('afterToolCall threads result rewrites (no terminal verdict)', async () => {
    bus.addHandler('p1', 'after_tool_call', (event) => ({ result: `${event.result} [a]` }), undefined, silentLogger);
    bus.addHandler('p2', 'after_tool_call', (event) => ({ result: `${event.result} [b]` }), undefined, silentLogger);
    const out = await bus.afterToolCall(
      { toolName: 'bash', toolCallId: 't1', params: {}, result: 'raw', isError: false },
      {},
    );
    expect(out).toEqual({ result: 'raw [a] [b]' });
  });

  it('messageSending threads content and cancel stops the chain', async () => {
    bus.addHandler('p1', 'message_sending', (event) => ({ content: `${event.content}.` }), undefined, silentLogger);
    const ok = await bus.messageSending(
      { conversationId: 'c1', content: 'done', channel: 'telegram' },
      {},
    );
    expect(ok).toEqual({ content: 'done.' });

    bus.addHandler('p2', 'message_sending', () => ({ cancel: true, reason: 'quiet hours' }), undefined, silentLogger);
    const cancelled = await bus.messageSending(
      { conversationId: 'c1', content: 'done', channel: 'telegram' },
      {},
    );
    expect(cancelled).toEqual({ cancelled: true });
  });

  it('builds HookContext with pluginName and dispatch context', async () => {
    let ctxSeen: unknown;
    bus.addHandler(
      'p1',
      'message_received',
      (_event, ctx) => {
        ctxSeen = { pluginName: ctx.pluginName, agentName: ctx.agentName, channel: ctx.channel };
      },
      undefined,
      silentLogger,
    );
    await bus.messageReceived(received('hi'), { agentName: 'dash', channel: 'telegram' });
    expect(ctxSeen).toEqual({ pluginName: 'p1', agentName: 'dash', channel: 'telegram' });
  });
});
```

- [ ] Run `npx vitest run packages/plugins/src/hook-bus.test.ts` — expect failure (module missing).

- [ ] Create `packages/plugins/src/hook-bus.ts`:

```ts
import type {
  AfterToolCallEvent,
  AfterToolCallVerdict,
  AgentRunEndEvent,
  AgentRunStartEvent,
  BeforeToolCallEvent,
  BeforeToolCallVerdict,
  HookContext,
  HookHandlerMap,
  HookName,
  HookOptions,
  MessageReceivedEvent,
  MessageReceivedVerdict,
  MessageSendingEvent,
  MessageSendingVerdict,
  PluginInboundMessage,
  PluginLogger,
} from '@dash/plugin-sdk';
import type { HookBus, HookCounters, HookDispatchContext } from './types.js';

export const DEFAULT_HOOK_TIMEOUT_MS = 10_000;

/**
 * Per-hook dispatch mode. Exhaustive over HookName with a never-guard — also
 * the runtime gate for hook names coming from plain-JS plugins.
 */
export function hookDispatchMode(hook: HookName): 'threaded' | 'observe' {
  switch (hook) {
    case 'message_received':
    case 'before_tool_call':
    case 'after_tool_call':
    case 'message_sending':
      return 'threaded';
    case 'agent_run_start':
    case 'agent_run_end':
      return 'observe';
    default: {
      const exhaustive: never = hook;
      throw new Error(`unknown hook '${String(exhaustive)}'`);
    }
  }
}

class HookTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`hook handler timed out after ${timeoutMs}ms`);
  }
}

interface RegisteredHandler {
  pluginName: string;
  hook: HookName;
  /** Stored untyped; addHandler's generic signature keeps registration safe. */
  handler: (event: unknown, ctx: HookContext) => unknown;
  critical: boolean;
  timeoutMs: number;
  logger: PluginLogger;
}

type InvokeResult =
  | { ok: true; verdict: unknown }
  | { ok: false; timedOut: boolean; error: Error };

/**
 * HookBus implementation. Dispatch semantics (per the spec table):
 * - Sequential THREADED middleware for message_received / before_tool_call /
 *   after_tool_call / message_sending: handlers run in plugin load order,
 *   each sees the latest threaded payload; terminal verdicts (drop / block /
 *   cancel) stop the chain.
 * - Parallel fire-and-forget for agent_run_start / agent_run_end.
 * - Per-handler timeout (10s default, HookOptions.timeoutMs override);
 *   timeout = handler failure.
 * - Fail-open by default. With critical: true a failure forces the
 *   fail-closed outcome: message_received → drop, before_tool_call → block,
 *   after_tool_call → result replaced with an error placeholder,
 *   message_sending → cancel.
 * - Counters per plugin × hook: fired (handler invocations), modified
 *   (payload rewrites, incl. forced after_tool_call placeholders), blocked
 *   (terminal verdicts incl. critical-forced ones), failed (thrown errors),
 *   timedOut (timeouts; disjoint from failed).
 * - Block reasons are formatted HERE as `policy (<pluginName>): <raw>` so
 *   every consumer renders identically (Plan 2 prefixes `denied by `).
 */
export class PluginHookBus implements HookBus {
  private handlers: RegisteredHandler[] = [];
  private stats = new Map<string, Map<HookName, HookCounters>>();

  constructor(private logger: PluginLogger) {}

  addHandler<K extends HookName>(
    pluginName: string,
    hook: K,
    handler: HookHandlerMap[K],
    opts: HookOptions | undefined,
    logger: PluginLogger,
  ): void {
    hookDispatchMode(hook); // throws on unknown hook names from plain-JS plugins
    this.handlers.push({
      pluginName,
      hook,
      handler: handler as (event: unknown, ctx: HookContext) => unknown,
      critical: opts?.critical === true,
      timeoutMs: opts?.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS,
      logger,
    });
  }

  async messageReceived(
    event: MessageReceivedEvent,
    ctx: HookDispatchContext,
  ): Promise<{ message: PluginInboundMessage } | { dropped: true }> {
    let message = event.message;
    for (const reg of this.handlersFor('message_received')) {
      const r = await this.invoke(reg, { message, channel: event.channel }, ctx);
      if (!r.ok) {
        if (reg.critical) {
          this.bump(reg.pluginName, 'message_received', 'blocked');
          return { dropped: true };
        }
        continue;
      }
      const verdict = r.verdict as MessageReceivedVerdict;
      if (!verdict || typeof verdict !== 'object') continue;
      if ('drop' in verdict && verdict.drop) {
        this.bump(reg.pluginName, 'message_received', 'blocked');
        this.logger.info('message dropped by plugin hook', {
          plugin: reg.pluginName,
          reason: verdict.reason,
        });
        return { dropped: true };
      }
      if ('message' in verdict) {
        message = verdict.message;
        this.bump(reg.pluginName, 'message_received', 'modified');
      }
    }
    return { message };
  }

  async beforeToolCall(
    event: BeforeToolCallEvent,
    ctx: HookDispatchContext,
  ): Promise<{ params: unknown } | { blocked: true; reason: string }> {
    let params = event.params;
    for (const reg of this.handlersFor('before_tool_call')) {
      const r = await this.invoke(
        reg,
        { toolName: event.toolName, toolCallId: event.toolCallId, params },
        ctx,
      );
      if (!r.ok) {
        if (reg.critical) {
          this.bump(reg.pluginName, 'before_tool_call', 'blocked');
          const raw = r.timedOut
            ? `hook timed out after ${reg.timeoutMs}ms`
            : `hook failed: ${r.error.message}`;
          return { blocked: true, reason: `policy (${reg.pluginName}): ${raw}` };
        }
        continue;
      }
      const verdict = r.verdict as BeforeToolCallVerdict;
      if (!verdict || typeof verdict !== 'object') continue;
      if ('block' in verdict && verdict.block) {
        this.bump(reg.pluginName, 'before_tool_call', 'blocked');
        return { blocked: true, reason: `policy (${reg.pluginName}): ${verdict.reason}` };
      }
      if ('params' in verdict) {
        params = verdict.params;
        this.bump(reg.pluginName, 'before_tool_call', 'modified');
      }
    }
    return { params };
  }

  async afterToolCall(
    event: AfterToolCallEvent,
    ctx: HookDispatchContext,
  ): Promise<{ result: string }> {
    let result = event.result;
    for (const reg of this.handlersFor('after_tool_call')) {
      const r = await this.invoke(reg, { ...event, result }, ctx);
      if (!r.ok) {
        if (reg.critical) {
          // Tool already ran — fail closed by withholding the result text.
          result = `[result withheld: after_tool_call hook failed in plugin ${reg.pluginName}]`;
          this.bump(reg.pluginName, 'after_tool_call', 'modified');
        }
        continue;
      }
      const verdict = r.verdict as AfterToolCallVerdict;
      if (!verdict || typeof verdict !== 'object') continue;
      if ('result' in verdict) {
        result = verdict.result;
        this.bump(reg.pluginName, 'after_tool_call', 'modified');
      }
    }
    return { result };
  }

  async messageSending(
    event: MessageSendingEvent,
    ctx: HookDispatchContext,
  ): Promise<{ content: string } | { cancelled: true }> {
    let content = event.content;
    for (const reg of this.handlersFor('message_sending')) {
      const r = await this.invoke(
        reg,
        { conversationId: event.conversationId, content, channel: event.channel },
        ctx,
      );
      if (!r.ok) {
        if (reg.critical) {
          this.bump(reg.pluginName, 'message_sending', 'blocked');
          return { cancelled: true };
        }
        continue;
      }
      const verdict = r.verdict as MessageSendingVerdict;
      if (!verdict || typeof verdict !== 'object') continue;
      if ('cancel' in verdict && verdict.cancel) {
        this.bump(reg.pluginName, 'message_sending', 'blocked');
        this.logger.info('outbound message cancelled by plugin hook', {
          plugin: reg.pluginName,
          reason: verdict.reason,
        });
        return { cancelled: true };
      }
      if ('content' in verdict) {
        content = verdict.content;
        this.bump(reg.pluginName, 'message_sending', 'modified');
      }
    }
    return { content };
  }

  agentRunStart(event: AgentRunStartEvent, ctx: HookDispatchContext): void {
    for (const reg of this.handlersFor('agent_run_start')) {
      void this.invoke(reg, event, ctx); // parallel fire-and-forget; never delays the run
    }
  }

  agentRunEnd(event: AgentRunEndEvent, ctx: HookDispatchContext): void {
    for (const reg of this.handlersFor('agent_run_end')) {
      void this.invoke(reg, event, ctx);
    }
  }

  counters(): Record<string, Partial<Record<HookName, HookCounters>>> {
    const out: Record<string, Partial<Record<HookName, HookCounters>>> = {};
    for (const [plugin, perHook] of this.stats) {
      const hooks: Partial<Record<HookName, HookCounters>> = {};
      for (const [hook, c] of perHook) {
        hooks[hook] = { ...c };
      }
      out[plugin] = hooks;
    }
    return out;
  }

  private handlersFor(hook: HookName): RegisteredHandler[] {
    return this.handlers.filter((h) => h.hook === hook);
  }

  private bump(pluginName: string, hook: HookName, key: keyof HookCounters): void {
    let perHook = this.stats.get(pluginName);
    if (!perHook) {
      perHook = new Map();
      this.stats.set(pluginName, perHook);
    }
    let c = perHook.get(hook);
    if (!c) {
      c = { fired: 0, modified: 0, blocked: 0, failed: 0, timedOut: 0 };
      perHook.set(hook, c);
    }
    c[key] += 1;
  }

  private async invoke(
    reg: RegisteredHandler,
    event: unknown,
    ctx: HookDispatchContext,
  ): Promise<InvokeResult> {
    const context: HookContext = {
      pluginName: reg.pluginName,
      agentName: ctx.agentName,
      channel: ctx.channel,
      sessionId: ctx.sessionId,
      logger: reg.logger,
    };
    this.bump(reg.pluginName, reg.hook, 'fired');
    let timer: NodeJS.Timeout | undefined;
    try {
      const verdict = await Promise.race([
        Promise.resolve().then(() => reg.handler(event, context)),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new HookTimeoutError(reg.timeoutMs)), reg.timeoutMs);
        }),
      ]);
      return { ok: true, verdict };
    } catch (err) {
      const timedOut = err instanceof HookTimeoutError;
      this.bump(reg.pluginName, reg.hook, timedOut ? 'timedOut' : 'failed');
      this.logger.warn(`hook ${reg.hook} handler ${timedOut ? 'timed out' : 'failed'}`, {
        plugin: reg.pluginName,
        error: (err as Error).message,
        critical: reg.critical,
      });
      return { ok: false, timedOut, error: err as Error };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
```

- [ ] Run `npx vitest run packages/plugins/src/hook-bus.test.ts` — expect pass.
- [ ] Commit:

```bash
git add packages/plugins/src/hook-bus.ts packages/plugins/src/hook-bus.test.ts
git commit -m "feat(plugins): HookBus with threaded middleware and terminal verdicts"
```

---

## Task 8 — HookBus timeouts, critical fail-closed, counters, fire-and-forget

**Files:**
- Test: `packages/plugins/src/hook-bus-failures.test.ts`
- Modify: `packages/plugins/src/hook-bus.ts` (only if a test exposes a gap — the Task 7 implementation already includes these paths; this task proves them)

**Steps:**

- [ ] Write the test `packages/plugins/src/hook-bus-failures.test.ts`:

```ts
import type { PluginLogger } from '@dash/plugin-sdk';
import { DEFAULT_HOOK_TIMEOUT_MS, PluginHookBus } from './hook-bus.js';

const silentLogger: PluginLogger = { debug() {}, info() {}, warn() {}, error() {} };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function bus(): PluginHookBus {
  return new PluginHookBus(silentLogger);
}

const TOOL_EVENT = { toolName: 'bash', toolCallId: 't1', params: { cmd: 'ls' } };
const SEND_EVENT = { conversationId: 'c1', content: 'hi', channel: 'telegram' };
const RECV_EVENT = {
  message: {
    channelId: 'telegram',
    conversationId: 'c1',
    senderId: 'u1',
    senderName: 'U',
    text: 'hi',
    timestamp: new Date(),
  },
  channel: 'telegram',
};
const AFTER_EVENT = { ...TOOL_EVENT, result: 'raw', isError: false };

describe('PluginHookBus failure policy', () => {
  it('default per-handler timeout is 10s', () => {
    expect(DEFAULT_HOOK_TIMEOUT_MS).toBe(10_000);
  });

  it('non-critical throw fails open and the chain continues', async () => {
    const b = bus();
    b.addHandler('flaky', 'before_tool_call', () => {
      throw new Error('boom');
    }, undefined, silentLogger);
    b.addHandler('p2', 'before_tool_call', () => ({ params: { ok: true } }), undefined, silentLogger);
    const out = await b.beforeToolCall(TOOL_EVENT, {});
    expect(out).toEqual({ params: { ok: true } });
    expect(b.counters().flaky?.before_tool_call).toEqual({
      fired: 1,
      modified: 0,
      blocked: 0,
      failed: 1,
      timedOut: 0,
    });
  });

  it('non-critical timeout fails open (timeoutMs override) and counts timedOut', async () => {
    const b = bus();
    b.addHandler('slow', 'before_tool_call', async () => {
      await sleep(80);
      return { params: { late: true } };
    }, { timeoutMs: 10 }, silentLogger);
    const out = await b.beforeToolCall(TOOL_EVENT, {});
    expect(out).toEqual({ params: TOOL_EVENT.params });
    expect(b.counters().slow?.before_tool_call).toEqual({
      fired: 1,
      modified: 0,
      blocked: 0,
      failed: 0,
      timedOut: 1,
    });
  });

  it('critical before_tool_call failure blocks with a formatted policy reason', async () => {
    const b = bus();
    b.addHandler('guard', 'before_tool_call', () => {
      throw new Error('policy db down');
    }, { critical: true }, silentLogger);
    const out = await b.beforeToolCall(TOOL_EVENT, {});
    expect(out).toEqual({      blocked: true,
      reason: 'policy (guard): hook failed: policy db down',
    });
    expect(b.counters().guard?.before_tool_call?.blocked).toBe(1);
  });

  it('critical before_tool_call timeout blocks with a timeout reason', async () => {
    const b = bus();
    b.addHandler('guard', 'before_tool_call', async () => {
      await sleep(80);
    }, { critical: true, timeoutMs: 10 }, silentLogger);
    const out = await b.beforeToolCall(TOOL_EVENT, {});
    expect(out).toEqual({
      blocked: true,
      reason: 'policy (guard): hook timed out after 10ms',
    });
  });

  it('critical message_received failure drops the message', async () => {
    const b = bus();
    b.addHandler('guard', 'message_received', () => {
      throw new Error('boom');
    }, { critical: true }, silentLogger);
    const out = await b.messageReceived(RECV_EVENT, {});
    expect(out).toEqual({ dropped: true });
  });

  it('critical message_sending failure cancels delivery', async () => {
    const b = bus();
    b.addHandler('guard', 'message_sending', () => {
      throw new Error('boom');
    }, { critical: true }, silentLogger);
    const out = await b.messageSending(SEND_EVENT, {});
    expect(out).toEqual({ cancelled: true });
  });

  it('critical after_tool_call failure replaces the result with a placeholder', async () => {
    const b = bus();
    b.addHandler('audit', 'after_tool_call', () => {
      throw new Error('boom');
    }, { critical: true }, silentLogger);
    const out = await b.afterToolCall(AFTER_EVENT, {});
    expect(out).toEqual({
      result: '[result withheld: after_tool_call hook failed in plugin audit]',
    });
  });

  it('non-critical after_tool_call failure leaves the result intact', async () => {
    const b = bus();
    b.addHandler('audit', 'after_tool_call', () => {
      throw new Error('boom');
    }, undefined, silentLogger);
    const out = await b.afterToolCall(AFTER_EVENT, {});
    expect(out).toEqual({ result: 'raw' });
  });

  it('agent_run_start/end are fire-and-forget and never delay the caller', async () => {
    const b = bus();
    const calls: string[] = [];
    b.addHandler('obs', 'agent_run_start', async () => {
      await sleep(20);
      calls.push('start');
    }, undefined, silentLogger);
    b.addHandler('obs', 'agent_run_end', () => {
      throw new Error('observer boom'); // swallowed + counted, never thrown
    }, undefined, silentLogger);
    b.agentRunStart({ agentName: 'dash' }, {});
    b.agentRunEnd({ agentName: 'dash' }, {});
    expect(calls).toEqual([]); // returned synchronously, handler still pending
    await sleep(50);
    expect(calls).toEqual(['start']);
    expect(b.counters().obs?.agent_run_start?.fired).toBe(1);
    expect(b.counters().obs?.agent_run_end?.failed).toBe(1);
  });

  it('counters() returns copies grouped per plugin and hook', async () => {
    const b = bus();
    b.addHandler('p1', 'message_received', (event) => ({ message: event.message }), undefined, silentLogger);
    await b.messageReceived(RECV_EVENT, {});
    const snapshot = b.counters();
    expect(snapshot.p1?.message_received).toEqual({
      fired: 1,
      modified: 1,
      blocked: 0,
      failed: 0,
      timedOut: 0,
    });
    snapshot.p1!.message_received!.fired = 99; // mutating the snapshot must not leak
    expect(b.counters().p1?.message_received?.fired).toBe(1);
  });
});
```

- [ ] Run `npx vitest run packages/plugins/src/hook-bus-failures.test.ts` — expect pass if Task 7's implementation is complete; if any case fails, fix `hook-bus.ts` so the documented semantics above hold (they are the spec).
- [ ] Run `npx vitest run packages/plugins` — all green.
- [ ] Commit:

```bash
git add packages/plugins/src/hook-bus-failures.test.ts packages/plugins/src/hook-bus.ts
git commit -m "test(plugins): hook bus timeouts, critical fail-closed semantics, counters"
```

---

## Task 9 — Runtime facade and registration buffer (`createPluginApi`, `validateRegistrations`)

**Files:**
- Create: `packages/plugins/src/plugin-api.ts`
- Test: `packages/plugins/src/plugin-api.test.ts`

**Steps:**

- [ ] Write the failing test `packages/plugins/src/plugin-api.test.ts`:

```ts
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginLogger, PluginManifest, PluginTool } from '@dash/plugin-sdk';
import { childLogger, createPluginApi, deepFreeze, validateRegistrations } from './plugin-api.js';

const silentLogger: PluginLogger = { debug() {}, info() {}, warn() {}, error() {} };

function manifest(overrides?: Partial<PluginManifest>): PluginManifest {
  return {
    name: 'demo-plugin',
    version: '0.1.0',
    entry: './index.js',
    compat: { dash: '>=0.1.0' },
    capabilities: ['tools', 'channels', 'providers', 'hooks'],
    ...overrides,
  };
}

function tool(name: string): PluginTool {
  return {
    name,
    label: name,
    description: 'd',
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: {} }),
  };
}

describe('createPluginApi', () => {
  let pluginsDir: string;

  beforeEach(async () => {
    pluginsDir = await mkdtemp(join(tmpdir(), 'plugins-api-'));
  });

  afterEach(async () => {
    await rm(pluginsDir, { recursive: true, force: true });
  });

  function make(config: Record<string, unknown> = {}) {
    return createPluginApi({
      manifest: manifest(),
      config,
      pluginsDir,
      dashVersion: '0.2.0',
      getCredential: async (key) => (key === 'demo-key' ? 'secret' : undefined),
      logger: silentLogger,
    });
  }

  it('buffers registrations without committing anywhere', () => {
    const { api, buffer } = make();
    api.registerTool(tool('demo_tool'));
    api.on('agent_run_start', () => {});
    api.lifecycle.onShutdown(() => {});
    expect(buffer.tools).toHaveLength(1);
    expect(buffer.hooks).toEqual([
      { hook: 'agent_run_start', handler: expect.any(Function), opts: undefined },
    ]);
    expect(buffer.shutdownHandlers).toHaveLength(1);
  });

  it('rejects unknown hook names at registration time (plain-JS plugins)', () => {
    const { api } = make();
    // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid input
    expect(() => api.on('PreToolUse' as any, () => {})).toThrow(/unknown hook/);
  });

  it('exposes frozen config (deep)', () => {
    const { api } = make({ a: { b: 1 } });
    expect(Object.isFrozen(api.config)).toBe(true);
    expect(Object.isFrozen(api.config.a)).toBe(true);
  });

  it('lazily creates <pluginsDir>/<name>/state on dataDir access', () => {
    const { api } = make();
    const expected = join(pluginsDir, 'demo-plugin', 'state');
    expect(existsSync(expected)).toBe(false);
    expect(api.runtime.dataDir).toBe(expected);
    expect(existsSync(expected)).toBe(true);
  });

  it('bridges getCredential and exposes meta', async () => {
    const { api } = make();
    await expect(api.runtime.getCredential('demo-key')).resolves.toBe('secret');
    expect(api.meta).toEqual({ name: 'demo-plugin', version: '0.1.0', dashVersion: '0.2.0' });
  });
});

describe('childLogger', () => {
  it('prefixes messages with [plugin:<name>]', () => {
    const lines: string[] = [];
    const base: PluginLogger = {
      debug(msg) {
        lines.push(`d:${msg}`);
      },
      info(msg) {
        lines.push(`i:${msg}`);
      },
      warn(msg) {
        lines.push(`w:${msg}`);
      },
      error(msg) {
        lines.push(`e:${msg}`);
      },
    };
    const child = childLogger(base, 'demo');
    child.info('hello');
    child.error('bad', { code: 1 });
    expect(lines).toEqual(['i:[plugin:demo] hello', 'e:[plugin:demo] bad']);
  });
});

describe('deepFreeze', () => {
  it('freezes nested objects and arrays', () => {
    const frozen = deepFreeze({ a: [{ b: 1 }] });
    expect(Object.isFrozen(frozen.a)).toBe(true);
    expect(Object.isFrozen(frozen.a[0])).toBe(true);
  });
});

describe('validateRegistrations', () => {
  function buffers() {
    const { api, buffer } = createPluginApi({
      manifest: manifest(),
      config: {},
      pluginsDir: '/tmp/unused',
      dashVersion: '0.2.0',
      getCredential: async () => undefined,
      logger: silentLogger,
    });
    return { api, buffer };
  }

  const emptyCommitted = () => ({
    toolNames: new Map<string, string>(),
    channelNames: new Map<string, string>(),
    providerIds: new Map<string, string>(),
  });

  it('passes a clean buffer', () => {
    const { api, buffer } = buffers();
    api.registerTool(tool('demo_tool'));
    expect(() => validateRegistrations(manifest(), buffer, emptyCommitted())).not.toThrow();
  });

  it('rejects registrations outside declared capabilities', () => {
    const { api, buffer } = buffers();
    api.registerTool(tool('demo_tool'));
    expect(() =>
      validateRegistrations(manifest({ capabilities: ['hooks'] }), buffer, emptyCommitted()),
    ).toThrow(/undeclared capability 'tools'/);
  });

  it('rejects duplicate tool names within the buffer', () => {
    const { api, buffer } = buffers();
    api.registerTool(tool('demo_tool'));
    api.registerTool(tool('demo_tool'));
    expect(() => validateRegistrations(manifest(), buffer, emptyCommitted())).toThrow(
      /tool 'demo_tool' is already registered/,
    );
  });

  it('rejects collisions with already-committed registrations from other plugins', () => {
    const { api, buffer } = buffers();
    api.registerTool(tool('demo_tool'));
    const committed = emptyCommitted();
    committed.toolNames.set('demo_tool', 'earlier-plugin');
    expect(() => validateRegistrations(manifest(), buffer, committed)).toThrow(
      /already registered by plugin 'earlier-plugin'/,
    );
  });

  it('rejects channel and provider collisions the same way', () => {
    const { api, buffer } = buffers();
    api.registerChannel('chat', () => ({}) as never);
    api.registerProvider({
      id: 'prov',
      label: 'P',
      credentialPrefix: 'prov-key',
      baseUrl: 'https://p.example',
      api: 'openai-completions',
      models: [{ id: 'm1', contextWindow: 8192, maxTokens: 1024 }],
    });
    const committed = emptyCommitted();
    committed.channelNames.set('chat', 'other');
    expect(() => validateRegistrations(manifest(), buffer, committed)).toThrow(
      /channel adapter 'chat' is already registered by plugin 'other'/,
    );
    committed.channelNames.clear();
    committed.providerIds.set('prov', 'other');
    expect(() => validateRegistrations(manifest(), buffer, committed)).toThrow(
      /provider 'prov' is already registered by plugin 'other'/,
    );
  });

  it('rejects dynamicModels without dynamicModelDefaults', () => {
    const { api, buffer } = buffers();
    api.registerProvider({
      id: 'router',
      label: 'Router',
      credentialPrefix: 'router-key',
      baseUrl: 'https://r.example',
      api: 'openai-completions',
      models: [],
      dynamicModels: true,
    });
    expect(() => validateRegistrations(manifest(), buffer, emptyCommitted())).toThrow(
      /dynamicModels requires dynamicModelDefaults/,
    );
  });
});
```

- [ ] Run `npx vitest run packages/plugins/src/plugin-api.test.ts` — expect failure (module missing).

- [ ] Create `packages/plugins/src/plugin-api.ts`:

```ts
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ChannelAdapterFactory,
  DashPluginApi,
  HookName,
  HookOptions,
  PluginLogger,
  PluginManifest,
  PluginTool,
  ProviderCatalog,
} from '@dash/plugin-sdk';
import { hookDispatchMode } from './hook-bus.js';
import { validateProviderCatalog } from './model-catalog.js';

/** Per-plugin registration buffer — committed by the loader only on success. */
export interface RegistrationBuffer {
  tools: PluginTool[];
  channels: Array<{
    adapterName: string;
    factory: ChannelAdapterFactory;
    configSchema?: Record<string, unknown>;
  }>;
  providers: ProviderCatalog[];
  hooks: Array<{ hook: HookName; handler: unknown; opts?: HookOptions }>;
  shutdownHandlers: Array<() => void | Promise<void>>;
}

/** Already-committed names from earlier plugins (plugin-vs-plugin collisions only). */
export interface CommittedNames {
  toolNames: Map<string, string>;
  channelNames: Map<string, string>;
  providerIds: Map<string, string>;
}

export function childLogger(base: PluginLogger, pluginName: string): PluginLogger {
  const prefix = `[plugin:${pluginName}] `;
  return {
    debug: (msg, data) => base.debug(prefix + msg, data),
    info: (msg, data) => base.info(prefix + msg, data),
    warn: (msg, data) => base.warn(prefix + msg, data),
    error: (msg, data) => base.error(prefix + msg, data),
  };
}

export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const v of Object.values(value)) {
      deepFreeze(v);
    }
    Object.freeze(value);
  }
  return value;
}

export function createPluginApi(opts: {
  manifest: PluginManifest;
  config: Record<string, unknown>;
  pluginsDir: string;
  dashVersion: string;
  getCredential: (key: string) => Promise<string | undefined>;
  logger: PluginLogger;
}): { api: DashPluginApi; buffer: RegistrationBuffer } {
  const buffer: RegistrationBuffer = {
    tools: [],
    channels: [],
    providers: [],
    hooks: [],
    shutdownHandlers: [],
  };
  // State dir lives under pluginsDir regardless of where the code lives
  // (path-override plugins included): sibling of the installed copy, survives
  // reinstall. Created lazily on first access.
  const stateDir = join(opts.pluginsDir, opts.manifest.name, 'state');
  const api: DashPluginApi = {
    registerTool(tool) {
      buffer.tools.push(tool);
    },
    registerChannel(adapterName, factory, o) {
      buffer.channels.push({ adapterName, factory, configSchema: o?.configSchema });
    },
    registerProvider(catalog) {
      buffer.providers.push(catalog);
    },
    on(hook, handler, o) {
      hookDispatchMode(hook); // throws on unknown hook names from plain-JS plugins
      buffer.hooks.push({ hook, handler, opts: o });
    },
    lifecycle: {
      onShutdown(fn) {
        buffer.shutdownHandlers.push(fn);
      },
    },
    config: deepFreeze({ ...opts.config }),
    logger: opts.logger,
    runtime: {
      get dataDir(): string {
        mkdirSync(stateDir, { recursive: true });
        return stateDir;
      },
      getCredential: opts.getCredential,
    },
    meta: {
      name: opts.manifest.name,
      version: opts.manifest.version,
      dashVersion: opts.dashVersion,
    },
  };
  return { api, buffer };
}

/**
 * Post-register validation: registrations ⊆ declared capabilities, no
 * duplicate names within the buffer, no collisions with earlier plugins'
 * committed registrations, provider catalogs structurally valid. Throws —
 * the loader records it as a 'register' phase failure and discards the
 * buffer. (Built-in name collisions are checked by the gateway, Plan 2.)
 */
export function validateRegistrations(
  manifest: PluginManifest,
  buffer: RegistrationBuffer,
  committed: CommittedNames,
): void {
  const declared = new Set(manifest.capabilities);
  if (buffer.tools.length > 0 && !declared.has('tools')) {
    throw new Error("registered a tool under undeclared capability 'tools'");
  }
  if (buffer.channels.length > 0 && !declared.has('channels')) {
    throw new Error("registered a channel under undeclared capability 'channels'");
  }
  if (buffer.providers.length > 0 && !declared.has('providers')) {
    throw new Error("registered a provider under undeclared capability 'providers'");
  }
  if (buffer.hooks.length > 0 && !declared.has('hooks')) {
    throw new Error("registered a hook under undeclared capability 'hooks'");
  }

  const seenTools = new Set<string>();
  for (const tool of buffer.tools) {
    const owner = committed.toolNames.get(tool.name);
    if (owner) {
      throw new Error(`tool '${tool.name}' is already registered by plugin '${owner}'`);
    }
    if (seenTools.has(tool.name)) {
      throw new Error(`tool '${tool.name}' is already registered by this plugin`);
    }
    seenTools.add(tool.name);
  }

  const seenChannels = new Set<string>();
  for (const ch of buffer.channels) {
    const owner = committed.channelNames.get(ch.adapterName);
    if (owner) {
      throw new Error(
        `channel adapter '${ch.adapterName}' is already registered by plugin '${owner}'`,
      );
    }
    if (seenChannels.has(ch.adapterName)) {
      throw new Error(`channel adapter '${ch.adapterName}' is already registered by this plugin`);
    }
    seenChannels.add(ch.adapterName);
  }

  const seenProviders = new Set<string>();
  for (const catalog of buffer.providers) {
    validateProviderCatalog(catalog);
    const owner = committed.providerIds.get(catalog.id);
    if (owner) {
      throw new Error(`provider '${catalog.id}' is already registered by plugin '${owner}'`);
    }
    if (seenProviders.has(catalog.id)) {
      throw new Error(`provider '${catalog.id}' is already registered by this plugin`);
    }
    seenProviders.add(catalog.id);
  }
}
```

- [ ] This imports `validateProviderCatalog` from `./model-catalog.js`, which does not exist yet. To keep this task self-contained and green, create `packages/plugins/src/model-catalog.ts` now with ONLY the validator (Task 10 adds `createModelCatalog` to the same file):

```ts
import type { ProviderCatalog } from '@dash/plugin-sdk';

/**
 * Structural validation for provider catalogs from plain-JS plugins.
 * Throws — surfaced as a 'register' phase failure by the loader.
 */
export function validateProviderCatalog(catalog: ProviderCatalog): void {
  if (typeof catalog.id !== 'string' || catalog.id.length === 0) {
    throw new Error('provider catalog requires a non-empty id');
  }
  const prefix = `provider '${catalog.id}':`;
  if (typeof catalog.label !== 'string' || catalog.label.length === 0) {
    throw new Error(`${prefix} label is required`);
  }
  if (typeof catalog.credentialPrefix !== 'string' || catalog.credentialPrefix.length === 0) {
    throw new Error(`${prefix} credentialPrefix is required`);
  }
  if (typeof catalog.baseUrl !== 'string' || catalog.baseUrl.length === 0) {
    throw new Error(`${prefix} baseUrl is required`);
  }
  if (catalog.api !== 'openai-completions' && catalog.api !== 'anthropic-messages') {
    throw new Error(`${prefix} api must be 'openai-completions' or 'anthropic-messages'`);
  }
  if (!Array.isArray(catalog.models)) {
    throw new Error(`${prefix} models must be an array`);
  }
  for (const model of catalog.models) {
    if (typeof model.id !== 'string' || model.id.length === 0) {
      throw new Error(`${prefix} every model requires a non-empty id`);
    }
    if (typeof model.contextWindow !== 'number' || model.contextWindow <= 0) {
      throw new Error(`${prefix} model '${model.id}' requires a positive contextWindow`);
    }
    if (typeof model.maxTokens !== 'number' || model.maxTokens <= 0) {
      throw new Error(`${prefix} model '${model.id}' requires a positive maxTokens`);
    }
  }
  if (catalog.dynamicModels === true && !catalog.dynamicModelDefaults) {
    throw new Error(`${prefix} dynamicModels requires dynamicModelDefaults`);
  }
  if (catalog.dynamicModelDefaults) {
    const d = catalog.dynamicModelDefaults;
    if (
      typeof d.contextWindow !== 'number' ||
      d.contextWindow <= 0 ||
      typeof d.maxTokens !== 'number' ||
      d.maxTokens <= 0
    ) {
      throw new Error(`${prefix} dynamicModelDefaults requires positive contextWindow/maxTokens`);
    }
  }
}
```

- [ ] Run `npx vitest run packages/plugins/src/plugin-api.test.ts` — expect pass.
- [ ] Commit:

```bash
git add packages/plugins/src/plugin-api.ts packages/plugins/src/plugin-api.test.ts \
  packages/plugins/src/model-catalog.ts
git commit -m "feat(plugins): plugin API facade with buffered registrations and validation"
```

---

## Task 10 — `createModelCatalog`

**Files:**
- Modify: `packages/plugins/src/model-catalog.ts`
- Test: `packages/plugins/src/model-catalog.test.ts`
- Modify: `packages/plugins/src/index.ts` (export)

**Steps:**

- [ ] Write the failing test `packages/plugins/src/model-catalog.test.ts`:

```ts
import type { ProviderCatalog } from '@dash/plugin-sdk';
import { createModelCatalog, validateProviderCatalog } from './model-catalog.js';

const GROQ: ProviderCatalog = {
  id: 'groq',
  label: 'Groq',
  credentialPrefix: 'groq-api-key',
  baseUrl: 'https://api.groq.com/openai/v1',
  api: 'openai-completions',
  models: [
    {
      id: 'llama-3.3-70b',
      name: 'Llama 3.3 70B',
      contextWindow: 131072,
      maxTokens: 32768,
      reasoning: false,
      input: ['text'],
      cost: { input: 0.59, output: 0.79, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsToolChoice: true },
      headers: { 'x-extra': 'y' },
    },
  ],
};

const OPENROUTER: ProviderCatalog = {
  id: 'openrouter',
  label: 'OpenRouter',
  credentialPrefix: 'openrouter-api-key',
  baseUrl: 'https://openrouter.ai/api/v1',
  api: 'openai-completions',
  models: [{ id: 'known/model', contextWindow: 200000, maxTokens: 8192 }],
  dynamicModels: true,
  dynamicModelDefaults: { contextWindow: 128000, maxTokens: 4096 },
};

describe('createModelCatalog', () => {
  const catalog = createModelCatalog([GROQ, OPENROUTER]);

  it('resolves an exact provider/model id with full passthrough', () => {
    expect(catalog.lookup('groq', 'llama-3.3-70b')).toEqual({
      provider: 'groq',
      modelId: 'llama-3.3-70b',
      baseUrl: 'https://api.groq.com/openai/v1',
      api: 'openai-completions',
      name: 'Llama 3.3 70B',
      contextWindow: 131072,
      maxTokens: 32768,
      reasoning: false,
      input: ['text'],
      cost: { input: 0.59, output: 0.79, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsToolChoice: true },
      headers: { 'x-extra': 'y' },
    });
  });

  it('returns undefined for unknown provider or unknown model on a static provider', () => {
    expect(catalog.lookup('nope', 'x')).toBeUndefined();
    expect(catalog.lookup('groq', 'unknown-model')).toBeUndefined();
  });

  it('dynamicModels: unknown ids resolve using catalog-level defaults', () => {
    expect(catalog.lookup('openrouter', 'anthropic/claude-opus-4.8')).toEqual({
      provider: 'openrouter',
      modelId: 'anthropic/claude-opus-4.8',
      baseUrl: 'https://openrouter.ai/api/v1',
      api: 'openai-completions',
      contextWindow: 128000,
      maxTokens: 4096,
    });
  });

  it('dynamicModels: exact entries still win over defaults', () => {
    expect(catalog.lookup('openrouter', 'known/model')?.contextWindow).toBe(200000);
  });

  it('dynamic provider without defaults is exact-match-only (defensive; the loader rejects it at registration)', () => {
    const broken = createModelCatalog([
      { ...OPENROUTER, dynamicModelDefaults: undefined },
    ]);
    expect(broken.lookup('openrouter', 'unknown')).toBeUndefined();
    expect(broken.lookup('openrouter', 'known/model')).toBeDefined();
  });
});

describe('validateProviderCatalog', () => {
  it('accepts valid catalogs', () => {
    expect(() => validateProviderCatalog(GROQ)).not.toThrow();
    expect(() => validateProviderCatalog(OPENROUTER)).not.toThrow();
  });

  it('rejects dynamicModels without dynamicModelDefaults', () => {
    expect(() =>
      validateProviderCatalog({ ...OPENROUTER, dynamicModelDefaults: undefined }),
    ).toThrow(/dynamicModels requires dynamicModelDefaults/);
  });

  it('rejects models missing contextWindow or maxTokens', () => {
    expect(() =>
      validateProviderCatalog({
        ...GROQ,
        // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid input
        models: [{ id: 'm' } as any],
      }),
    ).toThrow(/positive contextWindow/);
  });

  it('rejects bad api values', () => {
    expect(() =>
      // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid input
      validateProviderCatalog({ ...GROQ, api: 'grpc' as any }),
    ).toThrow(/api must be/);
  });
});
```

- [ ] Run `npx vitest run packages/plugins/src/model-catalog.test.ts` — expect failure (`createModelCatalog` not exported).

- [ ] Append to `packages/plugins/src/model-catalog.ts`:

```ts
import type { CatalogModel } from '@dash/plugin-sdk';
import type { ResolvedCatalogModel } from './types.js';
```

(merge these into the existing import block at the top of the file: `import type { CatalogModel, ProviderCatalog } from '@dash/plugin-sdk';` and `import type { ResolvedCatalogModel } from './types.js';`), then add:

```ts
function resolveModel(catalog: ProviderCatalog, model: CatalogModel): ResolvedCatalogModel {
  return {
    provider: catalog.id,
    modelId: model.id,
    baseUrl: catalog.baseUrl,
    api: catalog.api,
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    reasoning: model.reasoning,
    input: model.input,
    cost: model.cost,
    compat: model.compat,
    headers: model.headers,
  };
}

/**
 * Lookup over plugin provider catalogs, consumed by @dash/agent's
 * resolveModel() fallback (Plan 2). Exact provider/model ids resolve with
 * full passthrough. For dynamicModels providers, any unknown model id
 * resolves using the catalog-level dynamicModelDefaults (REQUIRED at
 * registration for dynamic providers — validateProviderCatalog enforces it;
 * a dynamic catalog somehow lacking defaults degrades to exact-match-only).
 */
export function createModelCatalog(catalogs: ProviderCatalog[]): {
  lookup(provider: string, modelId: string): ResolvedCatalogModel | undefined;
} {
  const byProvider = new Map<string, ProviderCatalog>();
  for (const catalog of catalogs) {
    byProvider.set(catalog.id, catalog);
  }
  return {
    lookup(provider, modelId) {
      const catalog = byProvider.get(provider);
      if (!catalog) return undefined;
      const model = catalog.models.find((m) => m.id === modelId);
      if (model) return resolveModel(catalog, model);
      if (catalog.dynamicModels === true && catalog.dynamicModelDefaults) {
        return {
          provider: catalog.id,
          modelId,
          baseUrl: catalog.baseUrl,
          api: catalog.api,
          contextWindow: catalog.dynamicModelDefaults.contextWindow,
          maxTokens: catalog.dynamicModelDefaults.maxTokens,
        };
      }
      return undefined;
    },
  };
}
```

- [ ] Append to `packages/plugins/src/index.ts`:

```ts
export { createModelCatalog } from './model-catalog.js';
```

- [ ] Run `npx vitest run packages/plugins/src/model-catalog.test.ts` — expect pass.
- [ ] Commit:

```bash
git add packages/plugins/src/model-catalog.ts packages/plugins/src/model-catalog.test.ts \
  packages/plugins/src/index.ts
git commit -m "feat(plugins): model catalog lookup with dynamicModels defaults"
```

---

## Task 11 — `PluginConfigStore`

**Files:**
- Create: `packages/plugins/src/config-store.ts`
- Test: `packages/plugins/src/config-store.test.ts`
- Modify: `packages/plugins/src/index.ts` (export)

**Steps:**

- [ ] Write the failing test `packages/plugins/src/config-store.test.ts`:

```ts
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginConfigStore } from './config-store.js';

describe('PluginConfigStore', () => {
  let dataDir: string;
  let store: PluginConfigStore;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'plugins-store-'));
    store = new PluginConfigStore(dataDir);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('load() returns {} when the file is missing', async () => {
    await expect(store.load()).resolves.toEqual({});
  });

  it('load() returns {} on corrupt JSON instead of throwing', async () => {
    await mkdir(join(dataDir, 'plugins'), { recursive: true });
    await writeFile(join(dataDir, 'plugins', 'config.json'), '{nope');
    await expect(store.load()).resolves.toEqual({});
  });

  it('load() normalizes entries and drops malformed values', async () => {
    await mkdir(join(dataDir, 'plugins'), { recursive: true });
    await writeFile(
      join(dataDir, 'plugins', 'config.json'),
      JSON.stringify({
        'discord-channel': { enabled: true, config: { botToken: '${TOK}' } },
        'audit-log': { enabled: false, path: '/dev/plugin' },
        broken: 'not-an-object',
      }),
    );
    await expect(store.load()).resolves.toEqual({
      'discord-channel': { enabled: true, config: { botToken: '${TOK}' }, path: undefined },
      'audit-log': { enabled: false, config: undefined, path: '/dev/plugin' },
    });
  });

  it('setEnabled() persists at <dataDir>/plugins/config.json, preserving other fields', async () => {
    await mkdir(join(dataDir, 'plugins'), { recursive: true });
    await writeFile(
      join(dataDir, 'plugins', 'config.json'),
      JSON.stringify({ 'audit-log': { enabled: true, config: { level: 'info' } } }),
    );
    await store.setEnabled('audit-log', false);
    const after = await store.load();
    expect(after['audit-log']).toEqual({
      enabled: false,
      config: { level: 'info' },
      path: undefined,
    });
  });

  it('setEnabled() creates the file and entry when absent', async () => {
    await store.setEnabled('new-plugin', true);
    const raw = JSON.parse(await readFile(join(dataDir, 'plugins', 'config.json'), 'utf8'));
    expect(raw['new-plugin'].enabled).toBe(true);
  });

  it('writes atomically (no .tmp left behind)', async () => {
    await store.setEnabled('p', true);
    const files = await readdir(join(dataDir, 'plugins'));
    expect(files).toEqual(['config.json']);
  });
});
```

- [ ] Run `npx vitest run packages/plugins/src/config-store.test.ts` — expect failure (module missing).

- [ ] Create `packages/plugins/src/config-store.ts` (atomic write pattern copied from `apps/gateway/src/agent-registry.ts` `save()`):

```ts
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { PluginEntryConfig } from './types.js';

/**
 * Persistence for the plugins config block at <dataDir>/plugins/config.json.
 * load() tolerates a missing or corrupt file (returns {}); writes are atomic
 * (temp + rename — same pattern as apps/gateway/src/agent-registry.ts).
 */
export class PluginConfigStore {
  private readonly filePath: string;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, 'plugins', 'config.json');
  }

  async load(): Promise<Record<string, PluginEntryConfig>> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.filePath, 'utf8'));
    } catch {
      return {}; // missing or corrupt file — start empty
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return {};
    }
    const entries: Record<string, PluginEntryConfig> = {};
    for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
      const v = value as Record<string, unknown>;
      entries[name] = {
        enabled: v.enabled === true,
        config:
          typeof v.config === 'object' && v.config !== null && !Array.isArray(v.config)
            ? (v.config as Record<string, unknown>)
            : undefined,
        path: typeof v.path === 'string' ? v.path : undefined,
      };
    }
    return entries;
  }

  async setEnabled(name: string, enabled: boolean): Promise<void> {
    const entries = await this.load();
    entries[name] = { ...(entries[name] ?? {}), enabled };
    await this.save(entries);
  }

  private async save(entries: Record<string, PluginEntryConfig>): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(entries, null, 2));
    await rename(tmpPath, this.filePath);
  }
}
```

- [ ] Append to `packages/plugins/src/index.ts`:

```ts
export { PluginConfigStore } from './config-store.js';
```

- [ ] Run `npx vitest run packages/plugins/src/config-store.test.ts` — expect pass.
- [ ] Commit:

```bash
git add packages/plugins/src/config-store.ts packages/plugins/src/config-store.test.ts \
  packages/plugins/src/index.ts
git commit -m "feat(plugins): PluginConfigStore with atomic persistence"
```

---

## Task 12 — Fixture plugins + loader happy path, discovery, disabled, registry, shutdown

**Files:**
- Create: `packages/plugins/test/fixtures/kitchen-sink/dash.plugin.json`
- Create: `packages/plugins/test/fixtures/kitchen-sink/index.js`
- Create: `packages/plugins/test/fixtures/audit-log/dash.plugin.json`
- Create: `packages/plugins/test/fixtures/audit-log/index.js`
- Create: `packages/plugins/src/loader.ts`
- Test: `packages/plugins/src/loader.test.ts`
- Modify: `packages/plugins/src/index.ts` (export)

**Steps:**

- [ ] Create `packages/plugins/test/fixtures/kitchen-sink/dash.plugin.json`:

```json
{
  "name": "kitchen-sink",
  "version": "0.1.0",
  "description": "Valid fixture registering one of each capability",
  "entry": "./index.js",
  "compat": { "dash": ">=0.1.0" },
  "capabilities": ["tools", "channels", "providers", "hooks"],
  "configSchema": {
    "type": "object",
    "properties": {
      "greeting": { "type": "string", "default": "hello" },
      "token": { "type": "string", "sensitive": true }
    }
  }
}
```

- [ ] Create `packages/plugins/test/fixtures/kitchen-sink/index.js`:

```js
export default {
  register(api) {
    api.registerTool({
      name: 'sink_echo',
      label: 'Sink Echo',
      description: 'Echoes input text and reports the plugin data dir.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      execute: async (_toolCallId, params) => ({
        content: [
          { type: 'text', text: JSON.stringify({ echo: params.text, dataDir: api.runtime.dataDir }) },
        ],
        details: {},
      }),
    });
    api.registerChannel(
      'sink-chat',
      () => ({
        name: 'sink-chat',
        start: async () => {},
        stop: async () => {},
        send: async () => {},
        onMessage: () => {},
        getHealth: () => 'connected',
        onHealthChange: () => {},
      }),
      { configSchema: { type: 'object', properties: { room: { type: 'string' } } } },
    );
    api.registerProvider({
      id: 'sinkai',
      label: 'SinkAI',
      credentialPrefix: 'sinkai-api-key',
      baseUrl: 'https://api.sink.example/v1',
      api: 'openai-completions',
      models: [{ id: 'sink-1', contextWindow: 8192, maxTokens: 2048 }],
    });
    api.on('message_received', (event) => ({
      message: { ...event.message, text: `${api.config.greeting}: ${event.message.text}` },
    }));
    api.lifecycle.onShutdown(() => {
      globalThis.__dashPluginShutdownLog = globalThis.__dashPluginShutdownLog || [];
      globalThis.__dashPluginShutdownLog.push('kitchen-sink');
    });
  },
};
```

- [ ] Create `packages/plugins/test/fixtures/audit-log/dash.plugin.json`:

```json
{
  "name": "audit-log",
  "version": "0.1.0",
  "description": "Hooks-only fixture",
  "entry": "./index.js",
  "compat": { "dash": ">=0.1.0" },
  "capabilities": ["hooks"]
}
```

- [ ] Create `packages/plugins/test/fixtures/audit-log/index.js`:

```js
export default {
  register(api) {
    api.on('before_tool_call', () => undefined);
    api.lifecycle.onShutdown(() => {
      globalThis.__dashPluginShutdownLog = globalThis.__dashPluginShutdownLog || [];
      globalThis.__dashPluginShutdownLog.push('audit-log');
    });
  },
};
```

- [ ] Write the failing test `packages/plugins/src/loader.test.ts`:

```ts
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PluginLogger } from '@dash/plugin-sdk';
import { loadPlugins } from './loader.js';

const silentLogger: PluginLogger = { debug() {}, info() {}, warn() {}, error() {} };
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');

describe('loadPlugins (happy path)', () => {
  let pluginsDir: string;

  beforeEach(async () => {
    pluginsDir = await mkdtemp(join(tmpdir(), 'plugins-loader-'));
    // biome-ignore lint/suspicious/noExplicitAny: test-only global
    (globalThis as any).__dashPluginShutdownLog = [];
  });

  afterEach(async () => {
    await rm(pluginsDir, { recursive: true, force: true });
  });

  function load(entries: Parameters<typeof loadPlugins>[0]['entries']) {
    return loadPlugins({
      pluginsDir,
      entries,
      dashVersion: '0.2.0',
      getCredential: async (key) => (key === 'sinkai-api-key' ? 'cred-1' : undefined),
      logger: silentLogger,
    });
  }

  it('loads a path-override plugin and commits all registrations', async () => {
    process.env.SINK_TOKEN = 'tok-1';
    try {
      const loaded = await load({
        'kitchen-sink': {
          enabled: true,
          path: join(FIXTURES, 'kitchen-sink'),
          config: { token: '${SINK_TOKEN}' },
        },
      });
      const record = loaded.registry.get('kitchen-sink');
      expect(record?.status).toBe('loaded');
      expect(record?.version).toBe('0.1.0');
      expect(record?.capabilities).toEqual(['tools', 'channels', 'providers', 'hooks']);
      expect(record?.registrations).toEqual({ tools: 1, channels: 1, providers: 1, hooks: 1 });
      // config is validated + default-filled + interpolated, NOT masked
      expect(record?.config).toEqual({ greeting: 'hello', token: 'tok-1' });
      expect(record?.configSchema).toBeDefined();
      expect(loaded.tools.map((t) => `${t.pluginName}:${t.tool.name}`)).toEqual([
        'kitchen-sink:sink_echo',
      ]);
      expect(loaded.channelFactories.get('sink-chat')?.pluginName).toBe('kitchen-sink');
      expect(loaded.providerCatalogs.map((c) => c.id)).toEqual(['sinkai']);
    } finally {
      delete process.env.SINK_TOKEN;
    }
  });

  it('committed hooks run through the bus with the plugin config applied', async () => {
    const loaded = await load({
      'kitchen-sink': {
        enabled: true,
        path: join(FIXTURES, 'kitchen-sink'),
        config: { greeting: 'yo' },
      },
    });
    const out = await loaded.hookBus.messageReceived(
      {
        message: {
          channelId: 'telegram',
          conversationId: 'c1',
          senderId: 'u1',
          senderName: 'U',
          text: 'hi',
          timestamp: new Date(),
        },
        channel: 'telegram',
      },
      { channel: 'telegram' },
    );
    expect('message' in out && out.message.text).toBe('yo: hi');
    expect(loaded.hookBus.counters()['kitchen-sink']?.message_received?.fired).toBe(1);
  });

  it('tool execution sees runtime.dataDir under <pluginsDir>/<name>/state', async () => {
    const loaded = await load({
      'kitchen-sink': { enabled: true, path: join(FIXTURES, 'kitchen-sink') },
    });
    const tool = loaded.tools[0]!.tool;
    const result = await tool.execute('t1', { text: 'ping' });
    const payload = JSON.parse(result.content[0]!.text) as { echo: string; dataDir: string };
    expect(payload.echo).toBe('ping');
    expect(payload.dataDir).toBe(join(pluginsDir, 'kitchen-sink', 'state'));
    expect(existsSync(payload.dataDir)).toBe(true);
  });

  it('discovers plugins from pluginsDir directories', async () => {
    await cp(join(FIXTURES, 'kitchen-sink'), join(pluginsDir, 'kitchen-sink'), {
      recursive: true,
    });
    const loaded = await load({ 'kitchen-sink': { enabled: true } });
    expect(loaded.registry.get('kitchen-sink')?.status).toBe('loaded');
    expect(loaded.registry.get('kitchen-sink')?.dir).toBe(join(pluginsDir, 'kitchen-sink'));
  });

  it('discovered without a config entry → disabled, not loaded (presence ≠ consent)', async () => {
    await cp(join(FIXTURES, 'kitchen-sink'), join(pluginsDir, 'kitchen-sink'), {
      recursive: true,
    });
    const loaded = await load({});
    const record = loaded.registry.get('kitchen-sink');
    expect(record?.status).toBe('disabled');
    expect(record?.registrations).toEqual({ tools: 0, channels: 0, providers: 0, hooks: 0 });
    expect(loaded.tools).toHaveLength(0);
  });

  it('enabled: false → disabled', async () => {
    const loaded = await load({
      'kitchen-sink': { enabled: false, path: join(FIXTURES, 'kitchen-sink') },
    });
    expect(loaded.registry.get('kitchen-sink')?.status).toBe('disabled');
  });

  it('missing pluginsDir yields an empty result, no throw', async () => {
    const loaded = await loadPlugins({
      pluginsDir: join(pluginsDir, 'does-not-exist'),
      entries: {},
      dashVersion: '0.2.0',
      getCredential: async () => undefined,
      logger: silentLogger,
    });
    expect(loaded.registry.list()).toEqual([]);
  });

  it('registry.list() returns copies; mutation does not leak', async () => {
    const loaded = await load({
      'kitchen-sink': { enabled: true, path: join(FIXTURES, 'kitchen-sink') },
    });
    const list = loaded.registry.list();
    list[0]!.status = 'error';
    expect(loaded.registry.get('kitchen-sink')?.status).toBe('loaded');
  });

  it('shutdown() runs handlers in reverse load order and never throws', async () => {
    const loaded = await load({
      'kitchen-sink': { enabled: true, path: join(FIXTURES, 'kitchen-sink') },
      'audit-log': { enabled: true, path: join(FIXTURES, 'audit-log') },
    });
    await loaded.shutdown();
    // biome-ignore lint/suspicious/noExplicitAny: test-only global
    expect((globalThis as any).__dashPluginShutdownLog).toEqual(['audit-log', 'kitchen-sink']);
  });
});
```

- [ ] Run `npx vitest run packages/plugins/src/loader.test.ts` — expect failure (loader missing).

- [ ] Create `packages/plugins/src/loader.ts`:

```ts
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DashPlugin, PluginLogger, PluginManifest, ProviderCatalog } from '@dash/plugin-sdk';
import { satisfiesMinVersion } from './compat.js';
import { validatePluginConfig } from './config.js';
import { PluginHookBus } from './hook-bus.js';
import { MANIFEST_FILENAME, readManifest } from './manifest.js';
import {
  childLogger,
  type CommittedNames,
  createPluginApi,
  validateRegistrations,
} from './plugin-api.js';
import type {
  LoadedPlugins,
  PluginEntryConfig,
  PluginFailurePhase,
  PluginRecord,
  PluginRegistry,
} from './types.js';

export interface LoadPluginsOptions {
  /** <dataDir>/plugins */
  pluginsDir: string;
  entries: Record<string, PluginEntryConfig>;
  dashVersion: string;
  getCredential: (key: string) => Promise<string | undefined>;
  /** The gateway adapts its unified logger to this shape. */
  logger: PluginLogger;
}

const SHUTDOWN_BUDGET_MS = 5_000;

const ZERO_REGISTRATIONS = { tools: 0, channels: 0, providers: 0, hooks: 0 };

interface Candidate {
  dir: string;
  /** Entry key for path overrides — the only name we have if the manifest is bad. */
  nameHint: string;
}

/**
 * Loads plugins through the phase pipeline manifest → compat → config →
 * import → register. Every phase failure produces a structured PluginFailure
 * record and the next plugin continues — the host always starts. Plugin
 * registrations are buffered and committed only when the whole plugin
 * succeeds. The loader knows nothing about built-in names (gateway concern).
 */
export async function loadPlugins(opts: LoadPluginsOptions): Promise<LoadedPlugins> {
  const records: PluginRecord[] = [];
  const hookBus = new PluginHookBus(opts.logger);
  const tools: LoadedPlugins['tools'] = [];
  const channelFactories: LoadedPlugins['channelFactories'] = new Map();
  const providerCatalogs: ProviderCatalog[] = [];
  const committed: CommittedNames = {
    toolNames: new Map(),
    channelNames: new Map(),
    providerIds: new Map(),
  };
  const shutdowns: Array<{ pluginName: string; handlers: Array<() => void | Promise<void>> }> = [];

  // --- Discovery: `path` overrides first (explicit dev intent), then
  // pluginsDir subdirectories containing a manifest, sorted for determinism.
  const candidates: Candidate[] = [];
  for (const [name, entry] of Object.entries(opts.entries)) {
    if (entry.path) {
      candidates.push({ dir: resolve(entry.path), nameHint: name });
    }
  }
  try {
    const dirents = await readdir(opts.pluginsDir, { withFileTypes: true });
    for (const d of dirents.filter((d) => d.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const dir = join(opts.pluginsDir, d.name);
      if (!existsSync(join(dir, MANIFEST_FILENAME))) continue; // stray dirs (e.g. state/)
      candidates.push({ dir, nameHint: d.name });
    }
  } catch {
    // pluginsDir missing — nothing installed; path overrides may still load.
  }

  const recordFailure = (
    name: string,
    version: string,
    dir: string,
    phase: PluginFailurePhase,
    err: unknown,
    extras?: Partial<PluginRecord>,
  ): void => {
    const error = err instanceof Error ? err.message : String(err);
    opts.logger.error(`plugin '${name}' failed to load`, { phase, error, dir });
    records.push({
      name,
      version,
      status: 'error',
      capabilities: [],
      failure: { phase, error, failedAt: new Date().toISOString() },
      registrations: { ...ZERO_REGISTRATIONS },
      dir,
      ...extras,
    });
  };

  const seenNames = new Set<string>();

  for (const candidate of candidates) {
    // Phase: manifest
    let manifest: PluginManifest;
    try {
      manifest = await readManifest(candidate.dir);
    } catch (err) {
      recordFailure(
        candidate.nameHint || basename(candidate.dir),
        'unknown',
        candidate.dir,
        'manifest',
        err,
      );
      continue;
    }
    if (seenNames.has(manifest.name)) {
      recordFailure(
        manifest.name,
        manifest.version,
        candidate.dir,
        'manifest',
        new Error(`duplicate plugin name '${manifest.name}' (already loaded from another dir)`),
      );
      continue;
    }
    seenNames.add(manifest.name);

    const base: Omit<PluginRecord, 'status'> = {
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      capabilities: manifest.capabilities,
      registrations: { ...ZERO_REGISTRATIONS },
      configSchema: manifest.configSchema,
      dir: candidate.dir,
    };

    // Disabled: discovered without a config entry, or enabled: false.
    const entry = opts.entries[manifest.name];
    if (!entry || !entry.enabled) {
      records.push({ ...base, status: 'disabled' });
      continue;
    }

    const fail = (phase: PluginFailurePhase, err: unknown): void =>
      recordFailure(manifest.name, manifest.version, candidate.dir, phase, err, {
        description: manifest.description,
        capabilities: manifest.capabilities,
        configSchema: manifest.configSchema,
      });

    // Phase: compat
    try {
      if (!satisfiesMinVersion(manifest.compat.dash, opts.dashVersion)) {
        throw new Error(
          `requires dash ${manifest.compat.dash}, running ${opts.dashVersion}`,
        );
      }
    } catch (err) {
      fail('compat', err);
      continue;
    }

    // Phase: config
    let config: Record<string, unknown>;
    try {
      config = validatePluginConfig(manifest.configSchema, entry.config ?? {});
    } catch (err) {
      fail('config', err);
      continue;
    }

    // Phase: import
    let plugin: DashPlugin;
    try {
      const entryPath = join(candidate.dir, manifest.entry);
      const mod = (await import(pathToFileURL(entryPath).href)) as { default?: unknown };
      const candidatePlugin = mod.default;
      if (
        !candidatePlugin ||
        typeof (candidatePlugin as DashPlugin).register !== 'function'
      ) {
        throw new Error('entry module must default-export a plugin object with register()');
      }
      plugin = candidatePlugin as DashPlugin;
    } catch (err) {
      fail('import', err);
      continue;
    }

    // Phase: register (buffered; committed only on success)
    const logger = childLogger(opts.logger, manifest.name);
    const { api, buffer } = createPluginApi({
      manifest,
      config,
      pluginsDir: opts.pluginsDir,
      dashVersion: opts.dashVersion,
      getCredential: opts.getCredential,
      logger,
    });
    try {
      await plugin.register(api);
      validateRegistrations(manifest, buffer, committed);
    } catch (err) {
      fail('register', err); // buffer discarded — partial registrations never commit
      continue;
    }

    // Commit
    for (const tool of buffer.tools) {
      tools.push({ pluginName: manifest.name, tool });
      committed.toolNames.set(tool.name, manifest.name);
    }
    for (const ch of buffer.channels) {
      channelFactories.set(ch.adapterName, {
        pluginName: manifest.name,
        factory: ch.factory,
        configSchema: ch.configSchema,
      });
      committed.channelNames.set(ch.adapterName, manifest.name);
    }
    for (const catalog of buffer.providers) {
      providerCatalogs.push(catalog);
      committed.providerIds.set(catalog.id, manifest.name);
    }
    for (const h of buffer.hooks) {
      // biome-ignore lint/suspicious/noExplicitAny: handler typing is enforced at api.on()
      hookBus.addHandler(manifest.name, h.hook, h.handler as any, h.opts, logger);
    }
    if (buffer.shutdownHandlers.length > 0) {
      shutdowns.push({ pluginName: manifest.name, handlers: buffer.shutdownHandlers });
    }
    records.push({
      ...base,
      status: 'loaded',
      config,
      registrations: {
        tools: buffer.tools.length,
        channels: buffer.channels.length,
        providers: buffer.providers.length,
        hooks: buffer.hooks.length,
      },
    });
    opts.logger.info(`plugin '${manifest.name}' loaded`, {
      version: manifest.version,
      capabilities: manifest.capabilities,
    });
  }

  const registry: PluginRegistry = {
    list: () => records.map((r) => ({ ...r })),
    get: (name) => {
      const r = records.find((x) => x.name === name);
      return r ? { ...r } : undefined;
    },
  };

  return {
    tools,
    channelFactories,
    providerCatalogs,
    hookBus,
    registry,
    async shutdown(): Promise<void> {
      // Reverse load order; 5s budget per handler; errors logged, never thrown.
      for (const { pluginName, handlers } of [...shutdowns].reverse()) {
        for (const handler of handlers) {
          let timer: NodeJS.Timeout | undefined;
          try {
            await Promise.race([
              Promise.resolve().then(() => handler()),
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                  () => reject(new Error(`shutdown handler timed out after ${SHUTDOWN_BUDGET_MS}ms`)),
                  SHUTDOWN_BUDGET_MS,
                );
              }),
            ]);
          } catch (err) {
            opts.logger.warn('plugin shutdown handler failed', {
              plugin: pluginName,
              error: (err as Error).message,
            });
          } finally {
            if (timer) clearTimeout(timer);
          }
        }
      }
    },
  };
}
```

- [ ] Append to `packages/plugins/src/index.ts`:

```ts
export { loadPlugins } from './loader.js';
export type { LoadPluginsOptions } from './loader.js';
```

- [ ] Run `npx vitest run packages/plugins/src/loader.test.ts` — expect pass.
- [ ] Run `npx biome check packages/plugins` — fixtures must pass formatting too.
- [ ] Commit:

```bash
git add packages/plugins/test/fixtures/kitchen-sink packages/plugins/test/fixtures/audit-log \
  packages/plugins/src/loader.ts packages/plugins/src/loader.test.ts packages/plugins/src/index.ts
git commit -m "feat(plugins): loader with phase pipeline, discovery, registry, shutdown"
```

---

## Task 13 — Failure-phase fixtures and loader isolation tests

**Files:**
- Create: `packages/plugins/test/fixtures/bad-manifest/dash.plugin.json`
- Create: `packages/plugins/test/fixtures/bad-compat/dash.plugin.json`
- Create: `packages/plugins/test/fixtures/bad-compat/index.js`
- Create: `packages/plugins/test/fixtures/bad-config/dash.plugin.json`
- Create: `packages/plugins/test/fixtures/bad-config/index.js`
- Create: `packages/plugins/test/fixtures/import-throws/dash.plugin.json`
- Create: `packages/plugins/test/fixtures/import-throws/index.js`
- Create: `packages/plugins/test/fixtures/register-throws/dash.plugin.json`
- Create: `packages/plugins/test/fixtures/register-throws/index.js`
- Create: `packages/plugins/test/fixtures/undeclared-capability/dash.plugin.json`
- Create: `packages/plugins/test/fixtures/undeclared-capability/index.js`
- Create: `packages/plugins/test/fixtures/dup-tool/dash.plugin.json`
- Create: `packages/plugins/test/fixtures/dup-tool/index.js`
- Test: `packages/plugins/src/loader-failures.test.ts`

**Steps:**

- [ ] Create the failure fixtures.

`packages/plugins/test/fixtures/bad-manifest/dash.plugin.json` (missing `entry`):

```json
{
  "name": "bad-manifest",
  "version": "0.1.0",
  "compat": { "dash": ">=0.1.0" },
  "capabilities": []
}
```

`packages/plugins/test/fixtures/bad-compat/dash.plugin.json`:

```json
{
  "name": "bad-compat",
  "version": "0.1.0",
  "entry": "./index.js",
  "compat": { "dash": ">=99.0.0" },
  "capabilities": []
}
```

`packages/plugins/test/fixtures/bad-compat/index.js`:

```js
export default {
  register() {},
};
```

`packages/plugins/test/fixtures/bad-config/dash.plugin.json`:

```json
{
  "name": "bad-config",
  "version": "0.1.0",
  "entry": "./index.js",
  "compat": { "dash": ">=0.1.0" },
  "capabilities": [],
  "configSchema": {
    "type": "object",
    "properties": { "token": { "type": "string", "sensitive": true } },
    "required": ["token"]
  }
}
```

`packages/plugins/test/fixtures/bad-config/index.js`:

```js
export default {
  register() {},
};
```

`packages/plugins/test/fixtures/import-throws/dash.plugin.json`:

```json
{
  "name": "import-throws",
  "version": "0.1.0",
  "entry": "./index.js",
  "compat": { "dash": ">=0.1.0" },
  "capabilities": []
}
```

`packages/plugins/test/fixtures/import-throws/index.js`:

```js
throw new Error('boom at import time');
```

`packages/plugins/test/fixtures/register-throws/dash.plugin.json`:

```json
{
  "name": "register-throws",
  "version": "0.1.0",
  "entry": "./index.js",
  "compat": { "dash": ">=0.1.0" },
  "capabilities": ["tools"]
}
```

`packages/plugins/test/fixtures/register-throws/index.js` (registers, THEN throws — proves buffering):

```js
export default {
  register(api) {
    api.registerTool({
      name: 'ghost_tool',
      label: 'Ghost',
      description: 'Should never be committed.',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ content: [{ type: 'text', text: 'x' }], details: {} }),
    });
    throw new Error('boom in register');
  },
};
```

`packages/plugins/test/fixtures/undeclared-capability/dash.plugin.json`:

```json
{
  "name": "undeclared-capability",
  "version": "0.1.0",
  "entry": "./index.js",
  "compat": { "dash": ">=0.1.0" },
  "capabilities": ["hooks"]
}
```

`packages/plugins/test/fixtures/undeclared-capability/index.js`:

```js
export default {
  register(api) {
    api.registerTool({
      name: 'sneaky_tool',
      label: 'Sneaky',
      description: 'Registers a tool without declaring the tools capability.',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ content: [{ type: 'text', text: 'x' }], details: {} }),
    });
  },
};
```

`packages/plugins/test/fixtures/dup-tool/dash.plugin.json`:

```json
{
  "name": "dup-tool",
  "version": "0.1.0",
  "entry": "./index.js",
  "compat": { "dash": ">=0.1.0" },
  "capabilities": ["tools"]
}
```

`packages/plugins/test/fixtures/dup-tool/index.js` (collides with kitchen-sink's `sink_echo`):

```js
export default {
  register(api) {
    api.registerTool({
      name: 'sink_echo',
      label: 'Imposter Echo',
      description: 'Collides with kitchen-sink sink_echo.',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ content: [{ type: 'text', text: 'x' }], details: {} }),
    });
  },
};
```

- [ ] Write the test `packages/plugins/src/loader-failures.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PluginLogger } from '@dash/plugin-sdk';
import { loadPlugins } from './loader.js';
import type { PluginFailurePhase } from './types.js';

const silentLogger: PluginLogger = { debug() {}, info() {}, warn() {}, error() {} };
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');

describe('loadPlugins (failure isolation)', () => {
  let pluginsDir: string;

  beforeEach(async () => {
    pluginsDir = await mkdtemp(join(tmpdir(), 'plugins-fail-'));
  });

  afterEach(async () => {
    await rm(pluginsDir, { recursive: true, force: true });
  });

  function load(entries: Parameters<typeof loadPlugins>[0]['entries']) {
    return loadPlugins({
      pluginsDir,
      entries,
      dashVersion: '0.2.0',
      getCredential: async () => undefined,
      logger: silentLogger,
    });
  }

  async function expectPhase(
    fixture: string,
    phase: PluginFailurePhase,
    errorPattern: RegExp,
    config?: Record<string, unknown>,
  ) {
    const loaded = await load({ [fixture]: { enabled: true, path: join(FIXTURES, fixture), config } });
    const record = loaded.registry.get(fixture);
    expect(record?.status).toBe('error');
    expect(record?.failure?.phase).toBe(phase);
    expect(record?.failure?.error).toMatch(errorPattern);
    expect(record?.failure?.failedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(record?.registrations).toEqual({ tools: 0, channels: 0, providers: 0, hooks: 0 });
    return loaded;
  }

  it("phase 'manifest': invalid manifest", async () => {
    await expectPhase('bad-manifest', 'manifest', /'entry'/);
  });

  it("phase 'compat': version too low", async () => {
    await expectPhase('bad-compat', 'compat', /requires dash >=99\.0\.0, running 0\.2\.0/);
  });

  it("phase 'config': missing required prop", async () => {
    await expectPhase('bad-config', 'config', /invalid config/);
  });

  it("phase 'config': missing env var during interpolation", async () => {
    await expectPhase('bad-config', 'config', /DASH_TEST_NO_SUCH_VAR/, {
      token: '${DASH_TEST_NO_SUCH_VAR}',
    });
  });

  it("phase 'import': entry throws at import time", async () => {
    await expectPhase('import-throws', 'import', /boom at import time/);
  });

  it("phase 'register': register() throws and buffered registrations are discarded", async () => {
    const loaded = await expectPhase('register-throws', 'register', /boom in register/);
    expect(loaded.tools).toHaveLength(0); // ghost_tool was buffered but never committed
  });

  it("phase 'register': undeclared capability", async () => {
    const loaded = await expectPhase(
      'undeclared-capability',
      'register',
      /undeclared capability 'tools'/,
    );
    expect(loaded.tools).toHaveLength(0);
  });

  it('plugin-vs-plugin tool collision: first wins, later plugin errors whole', async () => {
    const loaded = await load({
      'kitchen-sink': { enabled: true, path: join(FIXTURES, 'kitchen-sink') },
      'dup-tool': { enabled: true, path: join(FIXTURES, 'dup-tool') },
    });
    expect(loaded.registry.get('kitchen-sink')?.status).toBe('loaded');
    const dup = loaded.registry.get('dup-tool');
    expect(dup?.status).toBe('error');
    expect(dup?.failure?.phase).toBe('register');
    expect(dup?.failure?.error).toMatch(/'sink_echo' is already registered by plugin 'kitchen-sink'/);
    expect(loaded.tools.map((t) => t.pluginName)).toEqual(['kitchen-sink']);
  });

  it('one broken plugin never blocks the others (host always starts)', async () => {
    const loaded = await load({
      'import-throws': { enabled: true, path: join(FIXTURES, 'import-throws') },
      'kitchen-sink': { enabled: true, path: join(FIXTURES, 'kitchen-sink') },
    });
    expect(loaded.registry.get('import-throws')?.status).toBe('error');
    expect(loaded.registry.get('kitchen-sink')?.status).toBe('loaded');
    expect(loaded.tools).toHaveLength(1);
  });

  it('duplicate plugin names: later occurrence becomes a manifest-phase error', async () => {
    const loaded = await load({
      'kitchen-sink': { enabled: true, path: join(FIXTURES, 'kitchen-sink') },
      'kitchen-sink-copy': { enabled: true, path: join(FIXTURES, 'kitchen-sink') },
    });
    const all = loaded.registry.list().filter((r) => r.name === 'kitchen-sink');
    expect(all.map((r) => r.status).sort()).toEqual(['error', 'loaded']);
    expect(all.find((r) => r.status === 'error')?.failure?.error).toMatch(/duplicate plugin name/);
    expect(loaded.registry.get('kitchen-sink')?.status).toBe('loaded'); // get() returns first match
  });
});
```

- [ ] Run `npx vitest run packages/plugins/src/loader-failures.test.ts` — expect pass (the Task 12 loader implements all of this; fix the loader if any case fails).
- [ ] Run `npx vitest run packages/plugins` — all green.
- [ ] Commit:

```bash
git add packages/plugins/test/fixtures packages/plugins/src/loader-failures.test.ts
git commit -m "test(plugins): failure-phase fixtures and loader isolation coverage"
```

---

## Task 14 — Dist-import test

**Files:**
- Test: `packages/plugins/src/loader.dist.test.ts`

**Steps:**

- [ ] Write the test `packages/plugins/src/loader.dist.test.ts` (modeled on `packages/projects/src/migrations/runner.dist.test.ts`):

```ts
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PluginLogger } from '@dash/plugin-sdk';

/**
 * Regression test for the bundled/flattened layout (projects migration-runner
 * lesson). Unit tests import the loader from SOURCE; tsup flattens the whole
 * package into dist/index.js. The loader does filesystem work (discovery,
 * dynamic import of plugin entries, state-dir creation) — exercise it from
 * the BUILT artifact so dist-layout bugs fail here, not at gateway boot.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, '..');
const DIST_ENTRY = join(PKG_ROOT, 'dist', 'index.js');
const SDK_ROOT = join(PKG_ROOT, '..', 'plugin-sdk');
const FIXTURES = join(PKG_ROOT, 'test', 'fixtures');

const silentLogger: PluginLogger = { debug() {}, info() {}, warn() {}, error() {} };

describe('loadPlugins (bundled dist layout)', () => {
  let pluginsDir: string;

  beforeAll(() => {
    // Build if dist is absent; CI's build step also produces it.
    if (!existsSync(join(SDK_ROOT, 'dist', 'index.js'))) {
      execFileSync('npm', ['run', 'build'], { cwd: SDK_ROOT, stdio: 'inherit' });
    }
    if (!existsSync(DIST_ENTRY)) {
      execFileSync('npm', ['run', 'build'], { cwd: PKG_ROOT, stdio: 'inherit' });
    }
  }, 120_000);

  beforeEach(async () => {
    pluginsDir = await mkdtemp(join(tmpdir(), 'plugins-dist-'));
  });

  afterEach(async () => {
    await rm(pluginsDir, { recursive: true, force: true });
  });

  it('loads a fixture plugin end-to-end through the built package', async () => {
    const mod = (await import(DIST_ENTRY)) as typeof import('./index.js');
    const loaded = await mod.loadPlugins({
      pluginsDir,
      entries: { 'kitchen-sink': { enabled: true, path: join(FIXTURES, 'kitchen-sink') } },
      dashVersion: '0.2.0',
      getCredential: async () => undefined,
      logger: silentLogger,
    });
    expect(loaded.registry.get('kitchen-sink')?.status).toBe('loaded');
    expect(loaded.tools.map((t) => t.tool.name)).toEqual(['sink_echo']);
    expect(loaded.providerCatalogs.map((c) => c.id)).toEqual(['sinkai']);
    await loaded.shutdown();
  });
});
```

- [ ] Run `npm run build -w packages/plugin-sdk -w packages/plugins` then `npx vitest run packages/plugins/src/loader.dist.test.ts` — expect pass.
- [ ] Commit:

```bash
git add packages/plugins/src/loader.dist.test.ts
git commit -m "test(plugins): dist-import regression test for the built loader"
```

---

## Task 15 — Full verification

**Files:** none (verification only; fix anything that surfaces)

**Steps:**

- [ ] Run `npm run build` — all packages and apps build; confirm `packages/plugin-sdk` and `packages/plugins` appear in the build output.
- [ ] Run `npm run lint` — Biome clean; mission-control, plugin-sdk, and plugins typechecks pass (this enforces the channel assignability test and the SDK type-surface baseline).
- [ ] Run `npm test` — entire suite green, including both new packages and the dist-import test.
- [ ] Verify `npm run version:sync` covers the new packages: run it and confirm `packages/plugin-sdk/package.json` and `packages/plugins/package.json` carry the root version (the script globs `packages/*/package.json`, so no script change is expected — revert any version churn with `git checkout` if the root version was unchanged).
- [ ] Verify the pinned `@dash/plugins` barrel surface one last time against the contract: `PluginStatus`, `PluginFailurePhase`, `PluginFailure`, `PluginRecord`, `PluginRegistry`, `HookCounters`, `HookDispatchContext`, `HookBus`, `PluginEntryConfig`, `LoadedPlugins`, `ResolvedCatalogModel` (types) and `loadPlugins`, `PluginConfigStore`, `createModelCatalog` (runtime) are all exported from `packages/plugins/src/index.ts`.
- [ ] Commit anything that needed fixing; otherwise no commit (do not bump the version — that happens when the full plugins feature ships across all three plans).

---

## Out of scope for this plan (Plans 2 & 3)

1. Gateway: channel factory registry, `hookRunner`/`modelCatalog` structural params in `PiAgentBackend`, `GET /models` merging, message-router hook calls, shutdown wiring, built-in collision checks, `GET /plugins` / `PATCH /plugins/:name` management routes (Plan 2).
2. MC: Plugins settings page, schema-driven config form, Messaging Apps / AI Providers / agent-detail integration, IPC (Plan 3).
3. `examples/plugins/` reference plugin and `docs/plugins.mdx` user docs (ship with Plan 2, which makes them runnable).

