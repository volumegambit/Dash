# Dash Plugins — Plan 2: Gateway + Agent + Management Surfaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the plugin system (built by Plan 1 as `@dash/plugin-sdk` + `@dash/plugins`) into the gateway, the `PiAgentBackend`, and the management API — plugin tools reach agents with per-agent filtering, lifecycle hooks fire around tool calls / runs / channel messages, plugin provider catalogs serve model resolution and the models/providers listings, channel adapters become a factory registry, and MC gets the `/plugins`, `/channels/adapters`, `/providers`, and `/info` wire surfaces.

**Architecture:** Core packages never import `@dash/plugins` — all integration is structural typing (the `ExtraTool` trick). `PiAgentBackend` gains an optional 10th constructor param `pluginIntegration?: { hookRunner?, modelCatalog? }`; absent = zero behavior change. The gateway's channel if/else ladder becomes a `ChannelFactoryRegistry` shared by startup restore and `POST /channels`. All real `@dash/plugins` imports are confined to `apps/gateway/src/index.ts` (Task 15), so every other task is independently buildable and testable before Plan 1 merges. Management routes live in `packages/management/src/plugins-routes.ts` behind the existing bearer middleware, with structural dep types (same pattern as `mountProjectsRoutes`).

**Tech Stack:** TypeScript (strict, ES2024, NodeNext), Hono, Vitest (mkdtemp temp-dir pattern), `@sinclair/typebox` ^0.34.0 (channel config validation), `@mariozechner/pi-ai` / `pi-coding-agent` 0.67.68, Biome (single quotes, 2-space indent, semicolons, 100-char).

---

## Execution prerequisites & ordering

1. **Tasks 1–14 have no dependency on Plan 1.** They use structural types only and are individually green.
2. **Task 15 (gateway startup wiring) REQUIRES Plan 1 merged** — it adds `"@dash/plugins": "*"` to `apps/gateway/package.json` and imports `loadPlugins`, `PluginConfigStore`, `createModelCatalog`. Do not start Task 15 until `packages/plugins` exists in the workspace with the pinned exports.
3. Each task ends with a commit that leaves `npm run lint && npm run build && npm test` green.
4. Conventions: ESM `.js` extensions on local imports, single quotes, 2-space indent, semicolons, 100-char lines, vitest helpers imported from `'vitest'` (matches existing test files even though globals are enabled), temp dirs via `mkdtemp` in `beforeEach` + cleanup in `afterEach`.

## Pinned cross-plan contracts consumed here (import from `@dash/plugins`; never redefine)

`loadPlugins(opts: { pluginsDir, entries, dashVersion, getCredential, logger })` → `LoadedPlugins { tools: Array<{pluginName, tool}>, channelFactories: Map<string, {pluginName, factory(config), configSchema?}>, providerCatalogs: ProviderCatalog[], hookBus, registry: { list(), get(name) }, shutdown() }`; `PluginConfigStore(dataDir)` → file `<dataDir>/plugins/config.json`, `load()`, `setEnabled(name, enabled)`; `createModelCatalog(catalogs)` → `{ lookup(provider, modelId) }`. HookBus verdicts: `beforeToolCall` → `{params} | {blocked: true, reason}` (reason pre-formatted `policy (<plugin>): <raw>`; backend throws `denied by ${reason}`), `afterToolCall` → `{result}`, `messageReceived` → `{message} | {dropped: true}`, `messageSending` → `{content} | {cancelled: true}`, `agentRunStart/End` → void, `counters()`. `PluginRecord.config` arrives UNmasked — this plan masks at the route layer.

Wire contract Plan 3 renders: `PluginView` and `GET /channels/adapters` (Task 12), `GET /models` item `source?` and provider-listing `source?` (Task 14).

## Out of scope for this plan

1. `@dash/plugin-sdk` / `@dash/plugins` internals (Plan 1).
2. MC UI, IPC, `src/shared/plugins-ipc.ts` (Plan 3).
3. User docs (`docs/plugins.mdx` etc.) and the `examples/plugins/` reference plugin — coordinate ownership at cross-review.
4. MC chat (`chat-ws`) message hooks — explicitly v1-deferred by the spec; channel path only.

## File map

| File | Action | Task |
|---|---|---|
| `packages/agent/src/types.ts` | add `AgentHookRunner`, `ResolvedCatalogModel`, `ModelCatalogLookup`, `PluginIntegration` | 1 |
| `packages/agent/src/backends/catalog-model.ts` | create — pure pi-ai `Model` builder | 1 |
| `packages/agent/src/backends/piagent.ts` | 10th ctor param; resolveModel fallback; wrapper hooks; run() hooks; wrap MCP tools | 1–3 |
| `packages/agent/src/index.ts` | export new types | 1 |
| `packages/agent/src/backends/piagent.catalog.test.ts` | create | 1 |
| `packages/agent/src/backends/piagent.hooks.test.ts` | create | 2 |
| `packages/agent/src/backends/piagent.run-hooks.test.ts` | create | 3 |
| `apps/gateway/src/channel-registry.ts` | `adapter: string`, `config?` field | 4 |
| `apps/gateway/src/plugin-channel-config.ts` | create — `${ENV_VAR}` interpolation + TypeBox validation | 5 |
| `apps/gateway/src/channel-factories.ts` | create — registry + built-ins + plugin wrapper | 6 |
| `apps/gateway/src/channel-startup.ts` | create — `restorePersistedChannels` + runtime status | 7 |
| `apps/gateway/src/management-api.ts` | channel routes via factories (8); plugin surfaces `/providers` `/info` (14) | 8, 14 |
| `apps/gateway/src/plugin-wiring.ts` | create — filtering, hook bridge, provider keys, collision guard | 9 |
| `apps/gateway/src/agent-registry.ts` | `plugins?: string[]` | 10 |
| `apps/gateway/src/gateway.ts` | `hooks` option, message_received / message_sending | 11 |
| `packages/management/src/types.ts` | `PluginView`, `ChannelAdapterInfo`, `InfoResponse.plugins` | 12, 13 |
| `packages/management/src/plugins-routes.ts` | create — `mountPluginsRoutes` | 12 |
| `packages/management/src/client.ts` | `listPlugins`, `setPluginEnabled`, `listChannelAdapters` | 13 |
| `packages/models/src/types.ts` | `FilteredModel.source?` | 14 |
| `apps/gateway/src/models-route.ts` | `pluginModels` merge | 14 |
| `apps/gateway/src/index.ts` | startup wiring + shutdown | 15 |

---

### Task 1: @dash/agent — plugin integration types + catalog model fallback

**Files:**
- Modify: `packages/agent/src/types.ts` (append after `ExtraTool`, ~line 114)
- Create: `packages/agent/src/backends/catalog-model.ts`
- Modify: `packages/agent/src/backends/piagent.ts` (constructor lines 127–139; `resolveModel` lines 294–311)
- Modify: `packages/agent/src/index.ts` (first export block, lines 1–9)
- Test: `packages/agent/src/backends/piagent.catalog.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/agent/src/backends/piagent.catalog.test.ts`. It uses the REAL `@mariozechner/pi-ai` (no `vi.mock`) — `getModel()` returns `undefined` for unknown provider/model pairs, which is exactly the miss path the fallback covers. Use a provider id (`acme`) that cannot exist in pi-ai's registry.

```ts
import { describe, expect, it } from 'vitest';
import type { ModelCatalogLookup, ResolvedCatalogModel } from '../types.js';
import { buildCatalogModel } from './catalog-model.js';
import { PiAgentBackend } from './piagent.js';

const acmeLarge: ResolvedCatalogModel = {
  provider: 'acme',
  modelId: 'acme-large',
  baseUrl: 'https://api.acme.test/v1',
  api: 'openai-completions',
  contextWindow: 128000,
  maxTokens: 32768,
};

// resolveModel is private; tests reach it via a deliberate any-cast at the
// test boundary (same precedent as syncMcpToolsToSession's session access).
function resolveVia(backend: PiAgentBackend, modelStr: string): Record<string, unknown> {
  // biome-ignore lint/suspicious/noExplicitAny: accessing private method under test
  return (backend as any).resolveModel(modelStr);
}

function makeBackend(catalog?: ModelCatalogLookup): PiAgentBackend {
  return new PiAgentBackend(
    { model: 'acme/acme-large', systemPrompt: 'x' },
    {},
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    [],
    catalog ? { modelCatalog: catalog } : undefined,
  );
}

describe('buildCatalogModel', () => {
  it('fills defaults: zero cost, text input, reasoning false, name = id', () => {
    const model = buildCatalogModel('acme', 'acme-large', acmeLarge);
    expect(model.id).toBe('acme-large');
    expect(model.name).toBe('acme-large');
    expect(model.provider).toBe('acme');
    expect(model.api).toBe('openai-completions');
    expect(model.baseUrl).toBe('https://api.acme.test/v1');
    expect(model.reasoning).toBe(false);
    expect(model.input).toEqual(['text']);
    expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(model.contextWindow).toBe(128000);
    expect(model.maxTokens).toBe(32768);
    expect('headers' in model).toBe(false);
    expect('compat' in model).toBe(false);
  });

  it('passes through name, cost, reasoning, input, compat, and headers', () => {
    const model = buildCatalogModel('acme', 'acme-large', {
      ...acmeLarge,
      name: 'Acme Large',
      reasoning: true,
      input: ['text', 'image'],
      cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
      compat: { supportsStore: false },
      headers: { 'X-Acme': 'on' },
    });
    expect(model.name).toBe('Acme Large');
    expect(model.reasoning).toBe(true);
    expect(model.input).toEqual(['text', 'image']);
    expect(model.cost).toEqual({ input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 });
    // biome-ignore lint/suspicious/noExplicitAny: compat is a passthrough field
    expect((model as any).compat).toEqual({ supportsStore: false });
    expect(model.headers).toEqual({ 'X-Acme': 'on' });
  });
});

describe('PiAgentBackend.resolveModel catalog fallback', () => {
  it('constructs a Model from the catalog when getModel misses', () => {
    const lookups: string[] = [];
    const catalog: ModelCatalogLookup = {
      lookup: (provider, modelId) => {
        lookups.push(`${provider}/${modelId}`);
        return provider === 'acme' && modelId === 'acme-large' ? acmeLarge : undefined;
      },
    };
    const model = resolveVia(makeBackend(catalog), 'acme/acme-large');
    expect(lookups).toEqual(['acme/acme-large']);
    expect(model.provider).toBe('acme');
    expect(model.baseUrl).toBe('https://api.acme.test/v1');
    expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it('splits on the FIRST slash only so OpenRouter-style ids keep their slashes', () => {
    const seen: Array<[string, string]> = [];
    const catalog: ModelCatalogLookup = {
      lookup: (provider, modelId) => {
        seen.push([provider, modelId]);
        return { ...acmeLarge, provider, modelId };
      },
    };
    resolveVia(makeBackend(catalog), 'acme/meta-llama/llama-3-70b');
    expect(seen).toEqual([['acme', 'meta-llama/llama-3-70b']]);
  });

  it('prefers getModel for built-in models and never consults the catalog', () => {
    const catalog: ModelCatalogLookup = {
      lookup: () => {
        throw new Error('catalog must not be consulted for built-in models');
      },
    };
    const model = resolveVia(makeBackend(catalog), 'anthropic/claude-sonnet-4-5');
    expect(model.provider).toBe('anthropic');
  });

  it('still throws for unknown models when no catalog is configured', () => {
    expect(() => resolveVia(makeBackend(), 'acme/acme-large')).toThrow('Unknown model');
  });

  it('throws for unknown models the catalog also misses', () => {
    const catalog: ModelCatalogLookup = { lookup: () => undefined };
    expect(() => resolveVia(makeBackend(catalog), 'acme/nope')).toThrow('Unknown model');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/agent/src/backends/piagent.catalog.test.ts`
Expected: FAIL — cannot resolve `./catalog-model.js`; `../types.js` has no exported member `ResolvedCatalogModel`.

- [ ] **Step 3: Add the types to `packages/agent/src/types.ts`**

Append after the `ExtraTool` interface (after line 114), before `AgentBackend`:

```ts
/**
 * Structurally-typed hook runner injected into the backend at construction
 * (the gateway wraps @dash/plugins' HookBus per agent). Kept loose so
 * @dash/agent has no dependency on @dash/plugins — same trick as ExtraTool.
 *
 * Contract notes:
 * - beforeToolCall: a `blocked` verdict carries a reason pre-formatted as
 *   `policy (<plugin>): <raw reason>`; the backend throws
 *   `denied by ${reason}` so the existing tools-throw-on-error path turns
 *   it into an error tool result and the agent loop continues.
 * - agentRunStart/agentRunEnd are observe-only (void, fire-and-forget).
 */
export interface AgentHookRunner {
  beforeToolCall(event: {
    toolName: string;
    toolCallId: string;
    params: unknown;
    sessionId?: string;
  }): Promise<{ params: unknown } | { blocked: true; reason: string }>;
  afterToolCall(event: {
    toolName: string;
    toolCallId: string;
    params: unknown;
    result: string;
    isError: boolean;
    sessionId?: string;
  }): Promise<{ result: string }>;
  agentRunStart(event: { sessionId?: string }): void;
  agentRunEnd(event: {
    sessionId?: string;
    usage?: { inputTokens: number; outputTokens: number };
    error?: string;
  }): void;
}

/**
 * A model resolved from a plugin provider catalog. `resolveModel()` consults
 * this when pi-ai's getModel() misses, then constructs the pi-ai Model object
 * itself (see backends/catalog-model.ts). `contextWindow` is required because
 * pi's compaction reads it.
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

/** Lookup over plugin provider catalogs (the gateway passes createModelCatalog's result). */
export interface ModelCatalogLookup {
  lookup(provider: string, modelId: string): ResolvedCatalogModel | undefined;
}

/** Optional 10th PiAgentBackend constructor param. Absent = zero behavior change. */
export interface PluginIntegration {
  hookRunner?: AgentHookRunner;
  modelCatalog?: ModelCatalogLookup;
}
```

- [ ] **Step 4: Create `packages/agent/src/backends/catalog-model.ts`**

```ts
import type { Api, Model } from '@mariozechner/pi-ai';
import type { ResolvedCatalogModel } from '../types.js';

/**
 * Construct a pi-ai Model from plugin provider-catalog data.
 *
 * Verified against @mariozechner/pi-ai 0.67.68: streaming dispatches purely
 * on `model.api` (open string union; 'openai-completions' and
 * 'anthropic-messages' are registered transports), `setModel()` does no
 * registry lookup, and both transports honor `model.baseUrl`. Cost defaults
 * to zeros; `compat`/`headers` pass through untouched.
 */
export function buildCatalogModel(
  provider: string,
  modelId: string,
  resolved: ResolvedCatalogModel,
): Model<Api> {
  const model: Model<Api> = {
    id: modelId,
    name: resolved.name ?? modelId,
    api: resolved.api as Api,
    provider,
    baseUrl: resolved.baseUrl,
    reasoning: resolved.reasoning ?? false,
    input: resolved.input ?? ['text'],
    cost: resolved.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: resolved.contextWindow,
    maxTokens: resolved.maxTokens,
    ...(resolved.headers ? { headers: resolved.headers } : {}),
    // biome-ignore lint/suspicious/noExplicitAny: compat is provider-specific passthrough
    ...(resolved.compat ? { compat: resolved.compat as any } : {}),
  };
  return model;
}
```

Implementer note: if the installed pi-ai `Model<Api>` type has additional required fields, extend the literal to satisfy the compiler — do NOT drop `baseUrl`, `contextWindow`, `maxTokens`, `cost`, or `api`.

- [ ] **Step 5: Wire the constructor param and resolveModel fallback in `piagent.ts`**

Add to the import block:

```ts
import { buildCatalogModel } from './catalog-model.js';
```

and add `PluginIntegration` to the existing `import type { ... } from '../types.js'` list.

Replace the constructor (lines 127–139):

```ts
  constructor(
    private config: DashAgentConfig,
    private providerApiKeysSource: ProviderApiKeysSource,
    private logger?: Logger,
    private sessionDir?: string,
    private managedSkillsDir?: string,
    private mcpManager?: McpManager,
    private mcpConfigStore?: McpConfigStoreInterface,
    private mcpAgentContext?: McpAgentContext,
    extraTools: ExtraTool[] = [],
    private pluginIntegration?: PluginIntegration,
  ) {
    this.extraTools = extraTools;
  }
```

Replace `resolveModel` (lines 294–311) — keep first-`/`-only parsing (OpenRouter ids contain `/`):

```ts
  /**
   * Resolve the model from "provider/model-id" format. pi-ai's registry is
   * consulted first; on a miss, the plugin model catalog (when injected)
   * constructs the Model from catalog data. Splits on the FIRST '/' only —
   * model ids may themselves contain slashes (OpenRouter).
   */
  private resolveModel(modelStr: string): Model<Api> {
    const slash = modelStr.indexOf('/');
    if (slash === -1) {
      throw new Error(
        `Model must be in "provider/model" format, got "${modelStr}". Example: "anthropic/claude-sonnet-4-20250514"`,
      );
    }
    const provider = modelStr.slice(0, slash);
    const modelId = modelStr.slice(slash + 1);
    // biome-ignore lint/suspicious/noExplicitAny: getModel requires generic provider/modelId that are not statically known
    const model = getModel(provider as any, modelId as any);
    if (model) return model;
    const resolved = this.pluginIntegration?.modelCatalog?.lookup(provider, modelId);
    if (resolved) return buildCatalogModel(provider, modelId, resolved);
    throw new Error(
      `Unknown model "${modelStr}". Check that the provider and model ID are correct.`,
    );
  }
```

- [ ] **Step 6: Export the new types from `packages/agent/src/index.ts`**

Replace the first export block (lines 1–9):

```ts
export type {
  AgentBackend,
  AgentHookRunner,
  AgentState,
  AgentEvent,
  ExtraTool,
  ImageBlock,
  ModelCatalogLookup,
  PluginIntegration,
  ResolvedCatalogModel,
  RunOptions,
  DashAgentConfig,
} from './types.js';
```

After the `export { PiAgentBackend } ...` line add:

```ts
export { buildCatalogModel } from './backends/catalog-model.js';
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run packages/agent/src/backends/piagent.catalog.test.ts`
Expected: PASS (7 tests). Then `npx vitest run packages/agent` — all green (piagent.test.ts mocks `getModel` to always return a model, so the unchanged hit path keeps it green).

- [ ] **Step 8: Commit**

```bash
git add packages/agent/src/types.ts packages/agent/src/backends/catalog-model.ts \
  packages/agent/src/backends/piagent.ts packages/agent/src/index.ts \
  packages/agent/src/backends/piagent.catalog.test.ts
git commit -m "feat(agent): resolve models from plugin catalogs when getModel misses"
```

---

### Task 2: @dash/agent — before/after tool-call hooks in the custom-tool wrapper

**Files:**
- Modify: `packages/agent/src/backends/piagent.ts` (`buildCustomTools` lines 349–468, especially the `wrap` closure at 356–372 and the MCP-tools push at 400–415)
- Test: `packages/agent/src/backends/piagent.hooks.test.ts`

The single `wrap()` closure in `buildCustomTools()` is the chokepoint for every *custom* tool kind: core tools (todowrite, load_skill), user-gated web tools, MCP management tools, and host-injected `extraTools`. **Verified exception:** MCP *server* tools from `this.mcpManager.getTools()` are currently pushed WITHOUT `wrap` (piagent.ts lines 400–415) — this task routes them through `wrap` too so hook coverage is uniform. pi's native filesystem tools (`read`/`bash`/`edit`/…) are passed via `createAgentSession({ tools })`, not `customTools`, and are outside hook coverage in v1 per the pinned scope ("the single wrapper path that adapts ExtraTool/MCP/built-in custom tools").

- [ ] **Step 1: Write the failing test**

Create `packages/agent/src/backends/piagent.hooks.test.ts`:

```ts
import { Type } from '@sinclair/typebox';
import { describe, expect, it } from 'vitest';
import type { AgentHookRunner } from '../types.js';
import { PiAgentBackend } from './piagent.js';

interface RecordedCall {
  kind: 'before' | 'after';
  toolName: string;
  toolCallId: string;
  params: unknown;
  result?: string;
  isError?: boolean;
  sessionId?: string;
}

function makeRecorder(overrides?: {
  before?: (e: {
    toolName: string;
    toolCallId: string;
    params: unknown;
    sessionId?: string;
  }) => { params: unknown } | { blocked: true; reason: string };
  after?: (e: { result: string }) => { result: string };
}): { calls: RecordedCall[]; runner: AgentHookRunner } {
  const calls: RecordedCall[] = [];
  const runner: AgentHookRunner = {
    beforeToolCall: async (e) => {
      calls.push({ kind: 'before', ...e });
      return overrides?.before ? overrides.before(e) : { params: e.params };
    },
    afterToolCall: async (e) => {
      calls.push({
        kind: 'after',
        toolName: e.toolName,
        toolCallId: e.toolCallId,
        params: e.params,
        result: e.result,
        isError: e.isError,
        sessionId: e.sessionId,
      });
      return overrides?.after ? overrides.after(e) : { result: e.result };
    },
    agentRunStart: () => {},
    agentRunEnd: () => {},
  };
  return { calls, runner };
}

function makeProbeTool(executed: { params: unknown[] }, opts?: { throwMessage?: string }) {
  return {
    name: 'probe_tool',
    label: 'Probe',
    description: 'records executions',
    parameters: Type.Object({ value: Type.String() }),
    execute: async (_toolCallId: string, params: unknown) => {
      executed.params.push(params);
      if (opts?.throwMessage) throw new Error(opts.throwMessage);
      return {
        content: [{ type: 'text' as const, text: `ok:${(params as { value: string }).value}` }],
        details: { probe: true },
      };
    },
  };
}

function makeBackend(runner?: AgentHookRunner, executed = { params: [] as unknown[] }) {
  const backend = new PiAgentBackend(
    { model: 'anthropic/claude-sonnet-4-5', systemPrompt: 'x', tools: [] },
    {},
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    [makeProbeTool(executed)],
    runner ? { hookRunner: runner } : undefined,
  );
  return { backend, executed };
}

// buildCustomTools is private; reached via any-cast at the test boundary
// (same precedent as the catalog test and syncMcpToolsToSession).
function customTool(backend: PiAgentBackend, name: string) {
  // biome-ignore lint/suspicious/noExplicitAny: accessing private method under test
  const customs = (backend as any).buildCustomTools() as Array<{
    name: string;
    execute: (
      id: string,
      params: unknown,
    ) => Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }>;
  }>;
  const tool = customs.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not found in custom tools`);
  return tool;
}

describe('PiAgentBackend tool-call hooks', () => {
  it('runs the tool with (possibly rewritten) params from beforeToolCall', async () => {
    const { calls, runner } = makeRecorder({
      before: () => ({ params: { value: 'rewritten' } }),
    });
    const { backend, executed } = makeBackend(runner);
    backend.setCurrentSessionId('conv-9');
    const tool = customTool(backend, 'probe_tool');
    const result = await tool.execute('call-1', { value: 'original' });
    expect(executed.params).toEqual([{ value: 'rewritten' }]);
    expect(result.content[0].text).toBe('ok:rewritten');
    expect(calls[0]).toMatchObject({
      kind: 'before',
      toolName: 'probe_tool',
      toolCallId: 'call-1',
      params: { value: 'original' },
      sessionId: 'conv-9',
    });
  });

  it('throws "denied by <reason>" on a blocked verdict without executing the tool', async () => {
    const { runner } = makeRecorder({
      before: () => ({ blocked: true, reason: 'policy (guard): writes are not allowed' }),
    });
    const { backend, executed } = makeBackend(runner);
    const tool = customTool(backend, 'probe_tool');
    await expect(tool.execute('call-1', { value: 'x' })).rejects.toThrow(
      'denied by policy (guard): writes are not allowed',
    );
    expect(executed.params).toEqual([]);
  });

  it('lets afterToolCall rewrite the result text, preserving details', async () => {
    const { calls, runner } = makeRecorder({
      after: () => ({ result: '[redacted]' }),
    });
    const { backend } = makeBackend(runner);
    const tool = customTool(backend, 'probe_tool');
    const result = await tool.execute('call-1', { value: 'a' });
    expect(result.content).toEqual([{ type: 'text', text: '[redacted]' }]);
    expect(result.details).toEqual({ probe: true });
    const after = calls.find((c) => c.kind === 'after');
    expect(after).toMatchObject({ result: 'ok:a', isError: false });
  });

  it('reports thrown tool errors to afterToolCall and rethrows its result', async () => {
    const { calls, runner } = makeRecorder({
      after: (e) => ({ result: `wrapped: ${e.result}` }),
    });
    const executed = { params: [] as unknown[] };
    const backend = new PiAgentBackend(
      { model: 'anthropic/claude-sonnet-4-5', systemPrompt: 'x', tools: [] },
      {},
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [makeProbeTool(executed, { throwMessage: 'disk full' })],
      { hookRunner: runner },
    );
    const tool = customTool(backend, 'probe_tool');
    await expect(tool.execute('call-1', { value: 'x' })).rejects.toThrow('wrapped: disk full');
    const after = calls.find((c) => c.kind === 'after');
    expect(after).toMatchObject({ result: 'disk full', isError: true });
  });

  it('executes tools untouched when no hookRunner is configured', async () => {
    const { backend, executed } = makeBackend(undefined);
    const tool = customTool(backend, 'probe_tool');
    const result = await tool.execute('call-1', { value: 'plain' });
    expect(executed.params).toEqual([{ value: 'plain' }]);
    expect(result.content[0].text).toBe('ok:plain');
  });

  it('wraps MCP server tools so hooks cover them too', async () => {
    const { calls, runner } = makeRecorder();
    const mcpExecuted: unknown[] = [];
    const stubMcpManager = {
      getTools: () => [
        {
          name: 'srv__echo',
          label: 'Echo',
          description: 'echo',
          parameters: Type.Object({}),
          execute: async (_id: string, params: unknown) => {
            mcpExecuted.push(params);
            return { content: [{ type: 'text' as const, text: 'echoed' }], details: {} };
          },
        },
      ],
      getFailedServers: () => [],
    };
    const backend = new PiAgentBackend(
      { model: 'anthropic/claude-sonnet-4-5', systemPrompt: 'x', tools: ['mcp'] },
      {},
      undefined,
      undefined,
      undefined,
      // biome-ignore lint/suspicious/noExplicitAny: structural stub of McpManager
      stubMcpManager as any,
      undefined,
      undefined,
      [],
      { hookRunner: runner },
    );
    const tool = customTool(backend, 'srv__echo');
    await tool.execute('call-7', {});
    expect(mcpExecuted).toHaveLength(1);
    expect(calls.filter((c) => c.toolName === 'srv__echo').map((c) => c.kind)).toEqual([
      'before',
      'after',
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/agent/src/backends/piagent.hooks.test.ts`
Expected: FAIL — params are not rewritten, blocked verdict not thrown, MCP tool hook calls missing (current `wrap` ignores `pluginIntegration`; MCP tools bypass `wrap`).

- [ ] **Step 3: Implement the hook-aware wrapper**

In `piagent.ts`, add a module-level helper above the class (after the `ProviderApiKeysSource` type):

```ts
/** Join the text blocks of a pi tool result into the string hooks operate on. */
function extractTextContent(result: unknown): string {
  if (
    result &&
    typeof result === 'object' &&
    Array.isArray((result as { content?: unknown }).content)
  ) {
    return (result as { content: Array<{ type: string; text?: string }> }).content
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('\n');
  }
  return String(result ?? '');
}
```

Replace the `wrap` closure inside `buildCustomTools()` (lines 356–372):

```ts
    // biome-ignore lint/suspicious/noExplicitAny: tool types from pi-coding-agent SDK lack exported interfaces
    const wrap = (tool: any) => ({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      parameters: tool.parameters,
      execute: (
        toolCallId: string,
        // biome-ignore lint/suspicious/noExplicitAny: tool param types from SDK are not exported
        params: any,
        signal?: AbortSignal,
        // biome-ignore lint/suspicious/noExplicitAny: onUpdate callback type from SDK is not exported
        onUpdate?: any,
        // biome-ignore lint/suspicious/noExplicitAny: ctx type from SDK is not exported
        _ctx?: any,
      ) => {
        const hookRunner = this.pluginIntegration?.hookRunner;
        if (!hookRunner) return tool.execute(toolCallId, params, signal, onUpdate);
        return this.executeWithHooks(hookRunner, tool, toolCallId, params, signal, onUpdate);
      },
    });
```

Add the private method to the class (place it directly after `buildCustomTools`):

```ts
  /**
   * Hook-aware tool execution. before_tool_call may rewrite params or block
   * (block → throw `denied by ${reason}`, riding the tools-throw-on-error
   * contract so the model sees a tool failure and the loop continues — the
   * reason arrives pre-formatted as `policy (<plugin>): <raw>`).
   * after_tool_call sees the result text (or the thrown error message with
   * isError=true) and may rewrite it.
   */
  private async executeWithHooks(
    hookRunner: AgentHookRunner,
    // biome-ignore lint/suspicious/noExplicitAny: tool types from pi-coding-agent SDK lack exported interfaces
    tool: any,
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: unknown,
  ): Promise<unknown> {
    const sessionId = this.currentSessionId ?? undefined;
    const verdict = await hookRunner.beforeToolCall({
      toolName: tool.name,
      toolCallId,
      params,
      sessionId,
    });
    if ('blocked' in verdict) {
      throw new Error(`denied by ${verdict.reason}`);
    }
    const effectiveParams = verdict.params;
    try {
      const result = await tool.execute(toolCallId, effectiveParams, signal, onUpdate);
      const text = extractTextContent(result);
      const after = await hookRunner.afterToolCall({
        toolName: tool.name,
        toolCallId,
        params: effectiveParams,
        result: text,
        isError: false,
        sessionId,
      });
      if (after.result === text) return result;
      // Rewritten result: replace text content, preserve details. Non-text
      // blocks are dropped by design — a rewriting hook takes ownership of
      // the textual result the model sees.
      return {
        ...(result && typeof result === 'object' ? result : {}),
        content: [{ type: 'text', text: after.result }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const after = await hookRunner.afterToolCall({
        toolName: tool.name,
        toolCallId,
        params: effectiveParams,
        result: message,
        isError: true,
        sessionId,
      });
      throw new Error(after.result);
    }
  }
```

Add `AgentHookRunner` to the `import type { ... } from '../types.js'` list in `piagent.ts`.

- [ ] **Step 4: Route MCP server tools through the wrapper**

In `buildCustomTools()` (lines 400–415), change both MCP pushes to map through `wrap`:

```ts
    // MCP server tools (from connected MCP servers, filtered by agent's assigned servers).
    // Wrapped like every other custom tool so plugin tool-call hooks cover
    // them uniformly (the wrap is a no-op identity adapter when no
    // hookRunner is injected).
    if (allowedNames.has('mcp') && this.mcpManager) {
      const assigned = this.config.assignedMcpServers;
      if (assigned && assigned.length > 0) {
        const assignedSet = new Set(assigned);
        customs.push(
          ...this.mcpManager
            .getTools()
            .filter((t) => {
              const serverName = t.name.split('__')[0];
              return assignedSet.has(serverName);
            })
            .map((t) => wrap(t)),
        );
      } else if (!assigned) {
        // No assignedMcpServers field = legacy/standalone mode, show all
        customs.push(...this.mcpManager.getTools().map((t) => wrap(t)));
      }
      // assignedMcpServers = [] means explicitly no servers assigned
    }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run packages/agent/src/backends/piagent.hooks.test.ts`
Expected: PASS (6 tests). Then `npx vitest run packages/agent` — all green.

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/backends/piagent.ts packages/agent/src/backends/piagent.hooks.test.ts
git commit -m "feat(agent): run before/after tool-call hooks in the custom-tool wrapper"
```

---

### Task 3: @dash/agent — agent_run_start / agent_run_end hooks around run()

**Files:**
- Modify: `packages/agent/src/backends/piagent.ts` (`run()` lines 576–594)
- Test: `packages/agent/src/backends/piagent.run-hooks.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/agent/src/backends/piagent.run-hooks.test.ts`. It mocks the pi SDK packages the same way `piagent.test.ts` does, but with a controllable fake session so `start()` + `run()` complete end-to-end:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeSession {
  subscribe: ReturnType<typeof vi.fn>;
  setModel: ReturnType<typeof vi.fn>;
  setActiveToolsByName: ReturnType<typeof vi.fn>;
  getActiveToolNames: ReturnType<typeof vi.fn>;
  prompt: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}

let fakeSession: FakeSession;
let promptBehavior: 'success' | 'reject' = 'success';

function makeFakeSession(): FakeSession {
  let subscriber: ((e: unknown) => void) | null = null;
  const session: FakeSession = {
    subscribe: vi.fn((fn: (e: unknown) => void) => {
      subscriber = fn;
      return () => {
        subscriber = null;
      };
    }),
    setModel: vi.fn(async () => {}),
    setActiveToolsByName: vi.fn(),
    getActiveToolNames: vi.fn(() => []),
    prompt: vi.fn(async () => {
      if (promptBehavior === 'reject') throw new Error('upstream exploded');
      subscriber?.({
        type: 'message_end',
        message: { usage: { input: 11, output: 7 } },
      });
      subscriber?.({ type: 'agent_end' });
    }),
    abort: vi.fn(async () => {}),
    dispose: vi.fn(),
  };
  return session;
}

vi.mock('@mariozechner/pi-coding-agent', () => ({
  AuthStorage: {
    inMemory: vi.fn(() => {
      const providers = new Set<string>();
      return {
        set: vi.fn((p: string) => providers.add(p)),
        get: vi.fn(),
        getApiKey: vi.fn(),
        list: vi.fn(() => [...providers]),
        remove: vi.fn((p: string) => providers.delete(p)),
      };
    }),
  },
  DefaultResourceLoader: vi.fn(() => ({
    reload: vi.fn().mockResolvedValue(undefined),
    getSkills: vi.fn(() => ({ skills: [], diagnostics: [] })),
    getSystemPrompt: vi.fn(() => undefined),
    getAppendSystemPrompt: vi.fn(() => []),
    getExtensions: vi.fn(() => ({ extensions: [], runtime: {} })),
    getPrompts: vi.fn(() => ({ prompts: [], diagnostics: [] })),
    getThemes: vi.fn(() => ({ themes: [], diagnostics: [] })),
    getAgentsFiles: vi.fn(() => ({ agentsFiles: [] })),
    getPathMetadata: vi.fn(() => new Map()),
    extendResources: vi.fn(),
  })),
  SessionManager: {
    inMemory: vi.fn(() => ({})),
    continueRecent: vi.fn(() => ({})),
  },
  createAgentSession: vi.fn(async () => {
    fakeSession = makeFakeSession();
    return { session: fakeSession };
  }),
  createBashTool: vi.fn(() => ({ name: 'bash' })),
  createEditTool: vi.fn(() => ({ name: 'edit' })),
  createFindTool: vi.fn(() => ({ name: 'find' })),
  createGrepTool: vi.fn(() => ({ name: 'grep' })),
  createLsTool: vi.fn(() => ({ name: 'ls' })),
  createReadTool: vi.fn(() => ({ name: 'read' })),
  createWriteTool: vi.fn(() => ({ name: 'write' })),
}));

vi.mock('@mariozechner/pi-ai', () => ({
  getModel: vi.fn(() => ({
    id: 'claude-sonnet-4-20250514',
    provider: 'anthropic',
    api: 'anthropic-messages',
  })),
}));

import type { AgentEvent, AgentHookRunner } from '../types.js';
import { PiAgentBackend } from './piagent.js';

interface LifecycleCall {
  kind: 'start' | 'end';
  sessionId?: string;
  usage?: { inputTokens: number; outputTokens: number };
  error?: string;
}

function makeLifecycleRecorder(): { calls: LifecycleCall[]; runner: AgentHookRunner } {
  const calls: LifecycleCall[] = [];
  const runner: AgentHookRunner = {
    beforeToolCall: async (e) => ({ params: e.params }),
    afterToolCall: async (e) => ({ result: e.result }),
    agentRunStart: (e) => calls.push({ kind: 'start', sessionId: e.sessionId }),
    agentRunEnd: (e) =>
      calls.push({ kind: 'end', sessionId: e.sessionId, usage: e.usage, error: e.error }),
  };
  return { calls, runner };
}

async function drain(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

beforeEach(() => {
  vi.clearAllMocks();
  promptBehavior = 'success';
});

describe('PiAgentBackend run lifecycle hooks', () => {
  async function startBackend(runner: AgentHookRunner): Promise<PiAgentBackend> {
    const backend = new PiAgentBackend(
      { model: 'anthropic/claude-sonnet-4-20250514', systemPrompt: 'x', tools: [] },
      {},
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [],
      { hookRunner: runner },
    );
    await backend.start('/tmp');
    return backend;
  }

  it('fires agentRunStart at entry and agentRunEnd with usage on success', async () => {
    const { calls, runner } = makeLifecycleRecorder();
    const backend = await startBackend(runner);
    const events = await drain(
      backend.run(
        {
          channelId: 'ch',
          conversationId: 'conv-1',
          message: 'hi',
          systemPrompt: 'x',
          model: 'anthropic/claude-sonnet-4-20250514',
        },
        {},
      ),
    );
    expect(events.some((e) => e.type === 'response')).toBe(true);
    expect(calls[0]).toEqual({ kind: 'start', sessionId: 'conv-1' });
    expect(calls[1]).toEqual({
      kind: 'end',
      sessionId: 'conv-1',
      usage: { inputTokens: 11, outputTokens: 7 },
      error: undefined,
    });
    expect(backend.getCurrentSessionId()).toBeNull();
  });

  it('reports the error message in agentRunEnd when the run yields an error event', async () => {
    promptBehavior = 'reject';
    const { calls, runner } = makeLifecycleRecorder();
    const backend = await startBackend(runner);
    const events = await drain(
      backend.run(
        {
          channelId: 'ch',
          conversationId: 'conv-2',
          message: 'hi',
          systemPrompt: 'x',
          model: 'anthropic/claude-sonnet-4-20250514',
        },
        {},
      ),
    );
    expect(events.some((e) => e.type === 'error')).toBe(true);
    const end = calls.find((c) => c.kind === 'end');
    expect(end?.error).toBe('upstream exploded');
    expect(end?.usage).toBeUndefined();
  });

  it('does not require a hookRunner (absent = zero behavior change)', async () => {
    const backend = new PiAgentBackend(
      { model: 'anthropic/claude-sonnet-4-20250514', systemPrompt: 'x', tools: [] },
      {},
    );
    await backend.start('/tmp');
    const events = await drain(
      backend.run(
        {
          channelId: 'ch',
          conversationId: 'conv-3',
          message: 'hi',
          systemPrompt: 'x',
          model: 'anthropic/claude-sonnet-4-20250514',
        },
        {},
      ),
    );
    expect(events.some((e) => e.type === 'response')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/agent/src/backends/piagent.run-hooks.test.ts`
Expected: FAIL — `calls` is empty (`run()` never invokes the hook runner). If `start()` fails for an unrelated mock-shape reason, fix the mock to match the SDK surface — do not change production code for the mock.

- [ ] **Step 3: Implement run() lifecycle hooks**

Replace `run()` in `piagent.ts` (lines 576–594):

```ts
  async *run(state: AgentState, options: RunOptions): AsyncGenerator<AgentEvent> {
    if (!this.session) {
      throw new Error('PiAgentBackend not started. Call start() first.');
    }

    this.abortRequested = false;
    this.fullText = '';
    this.lastCompactionReason = 'threshold';
    this.currentSessionId = state.conversationId;

    const hookRunner = this.pluginIntegration?.hookRunner;
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    let errorMessage: string | undefined;

    // agent_run_start/agent_run_end are observe-only and fire-and-forget;
    // they never gate or delay the run (dispatch policy lives in the bus).
    hookRunner?.agentRunStart({ sessionId: state.conversationId });
    try {
      for await (const event of this.runModelChain(state, options)) {
        if (event.type === 'response') {
          usage = {
            inputTokens: event.usage.inputTokens,
            outputTokens: event.usage.outputTokens,
          };
        } else if (event.type === 'error') {
          errorMessage = event.error.message;
        }
        yield event;
      }
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      hookRunner?.agentRunEnd({
        sessionId: state.conversationId,
        usage,
        error: errorMessage,
      });
      // Clear the in-flight session id so consumers calling getCurrentSessionId()
      // during async teardown after run() returns don't observe a stale id. Only
      // resets the field — does not affect the generator's return/throw semantics.
      this.currentSessionId = null;
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/agent/src/backends/piagent.run-hooks.test.ts`
Expected: PASS (3 tests). Then `npx vitest run packages/agent` — all green.

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/backends/piagent.ts \
  packages/agent/src/backends/piagent.run-hooks.test.ts
git commit -m "feat(agent): fire agent_run_start/end hooks around run()"
```

---

### Task 4: Gateway — widen `ChannelConfig.adapter` to string and add per-channel config

**Files:**
- Modify: `apps/gateway/src/channel-registry.ts` (interfaces lines 14–40; `register` 98–109; `update` 119–127)
- Test: `apps/gateway/src/channel-registry.test.ts` (append a describe block)

- [ ] **Step 1: Write the failing test**

Append to `apps/gateway/src/channel-registry.test.ts`:

```ts
describe('plugin channel support', () => {
  it('accepts arbitrary adapter names and persists per-channel config', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dash-chreg-plugin-'));
    try {
      const filePath = join(dir, 'channels.json');
      const registry = new ChannelRegistry(filePath);
      registry.register({
        name: 'disc1',
        adapter: 'discord',
        globalDenyList: [],
        config: { botToken: 'tok', guildId: 'g1' },
        routing: [],
      });
      await registry.save();

      const reloaded = new ChannelRegistry(filePath);
      await reloaded.load();
      const entry = reloaded.get('disc1');
      expect(entry?.adapter).toBe('discord');
      expect(entry?.config).toEqual({ botToken: 'tok', guildId: 'g1' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('patches config through update()', () => {
    const registry = new ChannelRegistry();
    registry.register({
      name: 'disc1',
      adapter: 'discord',
      globalDenyList: [],
      config: { botToken: 'old' },
      routing: [],
    });
    const updated = registry.update('disc1', { config: { botToken: 'new' } });
    expect(updated.config).toEqual({ botToken: 'new' });
  });
});
```

If the existing test file does not already import `mkdtemp`, `rm`, `tmpdir`, and `join`, add them to its imports (`node:fs/promises`, `node:os`, `node:path`).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/gateway/src/channel-registry.test.ts`
Expected: FAIL — type error: `'discord'` is not assignable to `'telegram' | 'whatsapp'`, and `config` does not exist on `ChannelConfig`.

- [ ] **Step 3: Implement**

In `apps/gateway/src/channel-registry.ts`:

1. `ChannelConfig.adapter` (line 15): change to

```ts
  /**
   * Adapter name. Built-ins: 'telegram' | 'whatsapp'. Plugin channel
   * factories register additional names at startup, so this is an open
   * string — channels whose adapter is unavailable (plugin disabled or
   * uninstalled) are preserved on disk and surfaced as errored at runtime.
   */
  adapter: string;
```

2. Add to `ChannelConfig` (after `allowedUsers`):

```ts
  /**
   * Adapter-specific config for plugin channels, validated against the
   * factory's configSchema at instantiation (with ${ENV_VAR} interpolation).
   * Unused by built-in adapters, which read from the credential store.
   */
  config?: Record<string, unknown>;
```

3. In `RegisteredChannel`: change `adapter: 'telegram' | 'whatsapp';` to `adapter: string;` and add `config?: Record<string, unknown>;` after `allowedUsers`.

4. In `register()` (line 99–106), add config to the entry:

```ts
    const entry: RegisteredChannel = {
      name: config.name,
      adapter: config.adapter,
      globalDenyList: config.globalDenyList,
      allowedUsers: config.allowedUsers ?? [],
      ...(config.config ? { config: config.config } : {}),
      routing: config.routing,
      registeredAt: new Date().toISOString(),
    };
```

5. In `update()` (after the `allowedUsers` line):

```ts
    if (patch.config !== undefined) entry.config = patch.config;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/gateway/src/channel-registry.test.ts`
Expected: PASS. Then `npm run build` — `apps/gateway/src/management-api.ts` still compiles because its POST cast `body.adapter as 'telegram' | 'whatsapp'` narrows to a subtype of `string` (it is removed properly in Task 8).

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/channel-registry.ts apps/gateway/src/channel-registry.test.ts
git commit -m "feat(gateway): widen channel adapter type and add per-channel config"
```

---

### Task 5: Gateway — plugin channel config helpers (`${ENV_VAR}` interpolation + TypeBox validation)

**Files:**
- Create: `apps/gateway/src/plugin-channel-config.ts`
- Modify: `apps/gateway/package.json` (add `"@sinclair/typebox": "^0.34.0"` to dependencies — same range as `packages/agent`)
- Test: `apps/gateway/src/plugin-channel-config.test.ts`

- [ ] **Step 1: Add the dependency**

In `apps/gateway/package.json` dependencies, after `"@hono/node-ws": "^1",` add:

```json
    "@sinclair/typebox": "^0.34.0",
```

Run: `npm install`

- [ ] **Step 2: Write the failing test**

Create `apps/gateway/src/plugin-channel-config.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { interpolateEnvVars, validateChannelConfig } from './plugin-channel-config.js';

const schema = {
  type: 'object',
  properties: {
    botToken: { type: 'string' },
    maxRetries: { type: 'number' },
  },
  required: ['botToken'],
};

describe('interpolateEnvVars', () => {
  afterEach(() => {
    delete process.env.DASH_TEST_TOKEN;
  });

  it('replaces ${ENV_VAR} references in strings, recursively', () => {
    process.env.DASH_TEST_TOKEN = 'secret-123';
    const out = interpolateEnvVars({
      botToken: '${DASH_TEST_TOKEN}',
      nested: { greeting: 'hi ${DASH_TEST_TOKEN}!' },
      list: ['${DASH_TEST_TOKEN}', 'plain'],
      count: 3,
    }) as Record<string, unknown>;
    expect(out.botToken).toBe('secret-123');
    expect((out.nested as Record<string, unknown>).greeting).toBe('hi secret-123!');
    expect(out.list).toEqual(['secret-123', 'plain']);
    expect(out.count).toBe(3);
  });

  it('leaves unresolved ${VAR} references intact so misconfiguration is visible', () => {
    const out = interpolateEnvVars({ botToken: '${DASH_TEST_NOT_SET}' }) as Record<string, unknown>;
    expect(out.botToken).toBe('${DASH_TEST_NOT_SET}');
  });
});

describe('validateChannelConfig', () => {
  it('accepts a config matching the schema', () => {
    expect(validateChannelConfig(schema, { botToken: 't', maxRetries: 2 })).toEqual({ ok: true });
  });

  it('rejects a config missing required fields with a readable error', () => {
    const result = validateChannelConfig(schema, { maxRetries: 2 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain('botToken');
  });

  it('accepts anything when no schema is provided', () => {
    expect(validateChannelConfig(undefined, { whatever: true })).toEqual({ ok: true });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run apps/gateway/src/plugin-channel-config.test.ts`
Expected: FAIL — cannot resolve `./plugin-channel-config.js`.

- [ ] **Step 4: Implement `apps/gateway/src/plugin-channel-config.ts`**

```ts
import type { TSchema } from '@sinclair/typebox';
import { TypeCompiler } from '@sinclair/typebox/compiler';

/**
 * Replace ${ENV_VAR} references in string values, recursively through
 * objects and arrays. Unresolved variables are left verbatim so a
 * misconfigured channel fails validation (or the adapter) loudly instead
 * of silently receiving an empty string. Secrets stay out of channels.json.
 */
export function interpolateEnvVars(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (match, name: string) => {
      const resolved = process.env[name];
      return resolved !== undefined ? resolved : match;
    });
  }
  if (Array.isArray(value)) return value.map(interpolateEnvVars);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = interpolateEnvVars(entry);
    }
    return out;
  }
  return value;
}

/**
 * Validate a plugin channel config against the factory's JSON-schema
 * configSchema (TypeBox-compiled, same approach as the plugin loader's
 * manifest config validation). Returns readable errors for the HTTP layer.
 */
export function validateChannelConfig(
  schema: Record<string, unknown> | undefined,
  config: Record<string, unknown>,
): { ok: true } | { ok: false; errors: string } {
  if (!schema) return { ok: true };
  const compiled = TypeCompiler.Compile(schema as unknown as TSchema);
  if (compiled.Check(config)) return { ok: true };
  const errors = [...compiled.Errors(config)]
    .map((e) => `${e.path || '/'}: ${e.message}`)
    .join('; ');
  return { ok: false, errors };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run apps/gateway/src/plugin-channel-config.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/package.json package-lock.json \
  apps/gateway/src/plugin-channel-config.ts apps/gateway/src/plugin-channel-config.test.ts
git commit -m "feat(gateway): add plugin channel config validation helpers"
```

---

### Task 6: Gateway — channel factory registry with built-in adapters

**Files:**
- Create: `apps/gateway/src/channel-factories.ts`
- Test: `apps/gateway/src/channel-factories.test.ts`

This extracts the adapter-construction closures verbatim from `apps/gateway/src/index.ts` (lines 237–256) into named factories. Two deliberate unifications (flagged in the plan report): (1) startup previously *skipped* a telegram channel with no token — the factory now throws, and Task 7 surfaces it as an errored channel instead of silently dropping it; (2) the WhatsApp session dir unifies on the startup path `join(dataDir, 'whatsapp-sessions', <name>)` — `POST /channels` previously used the literal `data/whatsapp/<name>`, which diverged from what restart used (a latent bug).

- [ ] **Step 1: Write the failing test**

Create `apps/gateway/src/channel-factories.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { ChannelRegistry, RegisteredChannel } from './channel-registry.js';
import {
  ChannelFactoryRegistry,
  createBuiltinChannelFactories,
  wrapPluginChannelFactory,
} from './channel-factories.js';

function makeChannel(overrides: Partial<RegisteredChannel> = {}): RegisteredChannel {
  return {
    name: 'ch1',
    adapter: 'telegram',
    globalDenyList: [],
    allowedUsers: [],
    routing: [],
    registeredAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeCredentialStore(values: Record<string, string> = {}) {
  return {
    get: async (key: string) => values[key] ?? null,
  };
}

const stubChannelRegistry = {
  get: () => undefined,
} as unknown as ChannelRegistry;

describe('ChannelFactoryRegistry', () => {
  it('is first-registration-wins', () => {
    const registry = new ChannelFactoryRegistry();
    const first = { name: 'telegram', builtIn: true, create: async () => ({}) };
    const second = { name: 'telegram', builtIn: false, pluginName: 'p', create: async () => ({}) };
    // biome-ignore lint/suspicious/noExplicitAny: structural test stubs
    expect(registry.register(first as any)).toBe(true);
    // biome-ignore lint/suspicious/noExplicitAny: structural test stubs
    expect(registry.register(second as any)).toBe(false);
    expect(registry.get('telegram')?.builtIn).toBe(true);
    expect(registry.list()).toHaveLength(1);
  });
});

describe('createBuiltinChannelFactories', () => {
  it('registers telegram and whatsapp', () => {
    const factories = createBuiltinChannelFactories({
      // biome-ignore lint/suspicious/noExplicitAny: structural credential stub
      credentialStore: makeCredentialStore() as any,
      channelRegistry: stubChannelRegistry,
      dataDir: '/tmp/dash-test',
    });
    expect(factories.map((f) => f.name).sort()).toEqual(['telegram', 'whatsapp']);
    expect(factories.every((f) => f.builtIn)).toBe(true);
  });

  it('telegram factory throws a credential error when the token is missing', async () => {
    const [telegram] = createBuiltinChannelFactories({
      // biome-ignore lint/suspicious/noExplicitAny: structural credential stub
      credentialStore: makeCredentialStore() as any,
      channelRegistry: stubChannelRegistry,
      dataDir: '/tmp/dash-test',
    }).filter((f) => f.name === 'telegram');
    await expect(telegram.create(makeChannel())).rejects.toThrow(
      "No credential found for key 'channel:ch1:token'",
    );
  });

  it('telegram factory exposes its required credential key for the POST pre-check', () => {
    const [telegram] = createBuiltinChannelFactories({
      // biome-ignore lint/suspicious/noExplicitAny: structural credential stub
      credentialStore: makeCredentialStore() as any,
      channelRegistry: stubChannelRegistry,
      dataDir: '/tmp/dash-test',    }).filter((f) => f.name === 'telegram');
    expect(telegram.requiredCredentialKey?.('ch1')).toBe('channel:ch1:token');
  });

  it('whatsapp factory exposes its required credential key', () => {
    const [whatsapp] = createBuiltinChannelFactories({
      // biome-ignore lint/suspicious/noExplicitAny: structural credential stub
      credentialStore: makeCredentialStore() as any,
      channelRegistry: stubChannelRegistry,
      dataDir: '/tmp/dash-test',
    }).filter((f) => f.name === 'whatsapp');
    expect(whatsapp.requiredCredentialKey?.('ch1')).toBe('channel:ch1:whatsapp-auth');
  });
});

describe('wrapPluginChannelFactory', () => {
  const configSchema = {
    type: 'object',
    properties: { botToken: { type: 'string' } },
    required: ['botToken'],
  };

  it('validates and interpolates config before calling the plugin factory', async () => {
    process.env.DASH_TEST_DISCORD = 'tok-9';
    try {
      const received: Record<string, unknown>[] = [];
      const factory = wrapPluginChannelFactory({
        adapterName: 'discord',
        pluginName: 'discord-channel',
        configSchema,
        factory: (config) => {
          received.push(config);
          return {
            name: 'discord',
            start: async () => {},
            stop: async () => {},
            send: async () => {},
            onMessage: () => {},
            // biome-ignore lint/suspicious/noExplicitAny: minimal structural adapter
          } as any;
        },
      });
      const adapter = await factory.create(
        makeChannel({ adapter: 'discord', config: { botToken: '${DASH_TEST_DISCORD}' } }),
      );
      expect(adapter.name).toBe('discord');
      expect(received).toEqual([{ botToken: 'tok-9' }]);
      expect(factory.builtIn).toBe(false);
      expect(factory.pluginName).toBe('discord-channel');
      expect(factory.configSchema).toEqual(configSchema);
    } finally {
      delete process.env.DASH_TEST_DISCORD;
    }
  });

  it('throws a readable validation error for invalid config', async () => {
    const factory = wrapPluginChannelFactory({
      adapterName: 'discord',
      pluginName: 'discord-channel',
      configSchema,
      factory: () => {
        throw new Error('factory must not be called for invalid config');
      },
    });
    await expect(factory.create(makeChannel({ adapter: 'discord', config: {} }))).rejects.toThrow(
      /invalid config for channel 'ch1'/,
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/gateway/src/channel-factories.test.ts`
Expected: FAIL — cannot resolve `./channel-factories.js`.

- [ ] **Step 3: Implement `apps/gateway/src/channel-factories.ts`**

```ts
import { join } from 'node:path';
import { TelegramAdapter, WhatsAppAdapter } from '@dash/channels';
import type { ChannelAdapter } from '@dash/channels';
import type { ChannelRegistry, RegisteredChannel } from './channel-registry.js';
import type { GatewayCredentialStore } from './credential-store.js';
import { interpolateEnvVars, validateChannelConfig } from './plugin-channel-config.js';

/**
 * One adapter kind the gateway can instantiate. Built-ins ('telegram',
 * 'whatsapp') register first; plugin factories merge after (first
 * registration wins — see ChannelFactoryRegistry.register). `create`
 * throws an Error with a human-readable reason on failure; startup turns
 * that into an errored channel (config preserved), POST /channels into a 400.
 */
export interface ChannelFactory {
  name: string;
  builtIn: boolean;
  pluginName?: string;
  /** JSON schema for plugin channel config (drives MC's schema form). */
  configSchema?: Record<string, unknown>;
  /**
   * Built-in adapters read their secret from the credential store; this
   * lets POST /channels pre-check the key and return the same clean 400
   * the pre-factory code produced. Plugin factories omit it.
   */
  requiredCredentialKey?: (channelName: string) => string;
  create(channel: RegisteredChannel): Promise<ChannelAdapter>;
}

/** First registration wins — built-ins always register before plugins. */
export class ChannelFactoryRegistry {
  private factories = new Map<string, ChannelFactory>();

  register(factory: ChannelFactory): boolean {
    if (this.factories.has(factory.name)) return false;
    this.factories.set(factory.name, factory);
    return true;
  }

  get(name: string): ChannelFactory | undefined {
    return this.factories.get(name);
  }

  list(): ChannelFactory[] {
    return [...this.factories.values()];
  }
}

export interface BuiltinFactoryDeps {
  credentialStore: GatewayCredentialStore;
  channelRegistry: ChannelRegistry;
  dataDir: string;
}

/**
 * The two built-in adapters, extracted from the index.ts restore loop.
 * Telegram keeps its pull-based allow-list closure (reads the channel
 * registry on every inbound message so PUT /channels/:name edits apply
 * without a restart). WhatsApp keeps the empty-auth tolerance the startup
 * path always had; POST /channels enforces presence via
 * requiredCredentialKey before calling create.
 */
export function createBuiltinChannelFactories(deps: BuiltinFactoryDeps): ChannelFactory[] {
  return [
    {
      name: 'telegram',
      builtIn: true,
      requiredCredentialKey: (channelName) => `channel:${channelName}:token`,
      async create(channel) {
        const credKey = `channel:${channel.name}:token`;
        const token = await deps.credentialStore.get(credKey);
        if (!token) throw new Error(`No credential found for key '${credKey}'`);
        const channelName = channel.name;
        return new TelegramAdapter(
          token,
          () => deps.channelRegistry.get(channelName)?.allowedUsers ?? [],
        );
      },
    },
    {
      name: 'whatsapp',
      builtIn: true,
      requiredCredentialKey: (channelName) => `channel:${channelName}:whatsapp-auth`,
      async create(channel) {
        const credKey = `channel:${channel.name}:whatsapp-auth`;
        const authRaw = await deps.credentialStore.get(credKey);
        const auth = authRaw ? (JSON.parse(authRaw) as Record<string, string>) : {};
        return new WhatsAppAdapter(auth, join(deps.dataDir, 'whatsapp-sessions', channel.name));
      },
    },
  ];
}

export interface PluginChannelFactoryInput {
  adapterName: string;
  pluginName: string;
  factory: (config: Record<string, unknown>) => ChannelAdapter;
  configSchema?: Record<string, unknown>;
}

/**
 * Adapt a plugin's channel factory (from LoadedPlugins.channelFactories)
 * to the gateway's ChannelFactory shape: the persisted per-channel config
 * is ${ENV_VAR}-interpolated, validated against the plugin's configSchema,
 * and handed to the plugin factory.
 */
export function wrapPluginChannelFactory(input: PluginChannelFactoryInput): ChannelFactory {
  return {
    name: input.adapterName,
    builtIn: false,
    pluginName: input.pluginName,
    configSchema: input.configSchema,
    async create(channel) {
      const config = interpolateEnvVars(channel.config ?? {}) as Record<string, unknown>;
      const result = validateChannelConfig(input.configSchema, config);
      if (!result.ok) {
        throw new Error(
          `invalid config for channel '${channel.name}' (adapter '${input.adapterName}'): ${result.errors}`,
        );
      }
      return input.factory(config);
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/gateway/src/channel-factories.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/channel-factories.ts apps/gateway/src/channel-factories.test.ts
git commit -m "feat(gateway): add channel factory registry with built-in adapters"
```

---

### Task 7: Gateway — restore persisted channels through the factory registry

**Files:**
- Create: `apps/gateway/src/channel-startup.ts`
- Test: `apps/gateway/src/channel-startup.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/gateway/src/channel-startup.test.ts`:

```ts
import type { AgentClient } from '@dash/agent';
import type { ChannelAdapter } from '@dash/channels';
import { describe, expect, it, vi } from 'vitest';
import { ChannelFactoryRegistry } from './channel-factories.js';
import type { ChannelFactory } from './channel-factories.js';
import { ChannelRegistry } from './channel-registry.js';
import { restorePersistedChannels } from './channel-startup.js';

function makeAdapter(name: string): ChannelAdapter {
  return {
    name,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn(),
    // biome-ignore lint/suspicious/noExplicitAny: minimal structural adapter
  } as any;
}

function makeFactory(name: string, behavior: 'ok' | 'throw'): ChannelFactory {
  return {
    name,
    builtIn: name === 'telegram',
    create: async (channel) => {
      if (behavior === 'throw') throw new Error(`no credential for ${channel.name}`);
      return makeAdapter(name);
    },
  };
}

function makeGateway() {
  return {
    registerChannel: vi.fn().mockResolvedValue(undefined),
    registerAgent: vi.fn(),
  };
}

const bridge: AgentClient = {
  // biome-ignore lint/suspicious/noExplicitAny: stub bridge client
  chat: (() => {}) as any,
};

describe('restorePersistedChannels', () => {
  it('instantiates channels via their factory and bridges routed agents', async () => {
    const channelRegistry = new ChannelRegistry();
    channelRegistry.register({
      name: 'tg1',
      adapter: 'telegram',
      globalDenyList: [],
      routing: [{ condition: { type: 'default' }, agentId: 'a1', allowList: [], denyList: [] }],
    });
    const factories = new ChannelFactoryRegistry();
    factories.register(makeFactory('telegram', 'ok'));
    const gateway = makeGateway();

    const statuses = await restorePersistedChannels({
      channelRegistry,
      factories,
      gateway,
      resolveAgentClient: (agentId) => (agentId === 'a1' ? bridge : null),
    });

    expect(gateway.registerChannel).toHaveBeenCalledWith(
      'tg1',
      expect.objectContaining({ name: 'telegram' }),
      expect.objectContaining({ routing: expect.any(Array) }),
    );
    expect(gateway.registerAgent).toHaveBeenCalledWith('a1', bridge);
    expect(statuses.get('tg1')).toEqual({ status: 'running' });
  });

  it('marks channels with a missing factory errored, preserves config, continues', async () => {
    const channelRegistry = new ChannelRegistry();
    channelRegistry.register({
      name: 'disc1',
      adapter: 'discord',
      globalDenyList: [],
      config: { botToken: 't' },
      routing: [],
    });
    channelRegistry.register({
      name: 'tg1',
      adapter: 'telegram',
      globalDenyList: [],
      routing: [],
    });
    const factories = new ChannelFactoryRegistry();
    factories.register(makeFactory('telegram', 'ok'));
    const gateway = makeGateway();

    const statuses = await restorePersistedChannels({
      channelRegistry,
      factories,
      gateway,
      resolveAgentClient: () => null,
    });

    expect(statuses.get('disc1')).toEqual({
      status: 'error',
      reason: "adapter not available (plugin disabled or not installed): 'discord'",
    });
    // Config preserved — the registry entry is untouched.
    expect(channelRegistry.get('disc1')?.config).toEqual({ botToken: 't' });
    // The other channel still started.
    expect(statuses.get('tg1')).toEqual({ status: 'running' });
  });

  it('marks channels whose factory.create throws as errored with the thrown reason', async () => {
    const channelRegistry = new ChannelRegistry();
    channelRegistry.register({
      name: 'tg1',
      adapter: 'telegram',
      globalDenyList: [],
      routing: [],
    });
    const factories = new ChannelFactoryRegistry();
    factories.register(makeFactory('telegram', 'throw'));
    const gateway = makeGateway();

    const statuses = await restorePersistedChannels({
      channelRegistry,
      factories,
      gateway,
      resolveAgentClient: () => null,
    });

    expect(statuses.get('tg1')).toEqual({ status: 'error', reason: 'no credential for tg1' });
    expect(gateway.registerChannel).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/gateway/src/channel-startup.test.ts`
Expected: FAIL — cannot resolve `./channel-startup.js`.

- [ ] **Step 3: Implement `apps/gateway/src/channel-startup.ts`**

```ts
import type { AgentClient } from '@dash/agent';
import type { ChannelFactoryRegistry } from './channel-factories.js';
import type { ChannelRegistry } from './channel-registry.js';

/** Runtime (non-persisted) health of a configured channel. */
export interface ChannelRuntimeStatus {
  status: 'running' | 'error';
  reason?: string;
}

export interface RestoreChannelsDeps {
  channelRegistry: ChannelRegistry;
  factories: ChannelFactoryRegistry;
  gateway: {
    registerChannel(
      channelName: string,
      // biome-ignore lint/suspicious/noExplicitAny: structural — matches DynamicGateway.registerChannel
      adapter: any,
      config: {
        globalDenyList: string[];
        // biome-ignore lint/suspicious/noExplicitAny: structural — matches DynamicGateway.registerChannel
        routing: any[];
      },
    ): Promise<void>;
    registerAgent(agentId: string, client: AgentClient): void;
  };
  /** Returns a bridge client for the agent, or null if the agent is unknown. */
  resolveAgentClient: (agentId: string) => AgentClient | null;
  log?: (msg: string) => void;
}

/**
 * Instantiate every persisted channel through the factory registry
 * (replaces the if/else adapter ladder that lived in index.ts).
 *
 * A channel whose factory is missing (plugin disabled or uninstalled) or
 * whose adapter fails to construct is marked errored — its channels.json
 * entry is PRESERVED and the gateway continues starting. The returned map
 * is merged into GET /channels responses so MC can show the reason inline.
 */
export async function restorePersistedChannels(
  deps: RestoreChannelsDeps,
): Promise<Map<string, ChannelRuntimeStatus>> {
  const statuses = new Map<string, ChannelRuntimeStatus>();
  for (const channel of deps.channelRegistry.list()) {
    const factory = deps.factories.get(channel.adapter);
    if (!factory) {
      const reason = `adapter not available (plugin disabled or not installed): '${channel.adapter}'`;
      statuses.set(channel.name, { status: 'error', reason });
      deps.log?.(`[gateway] channel ${channel.name} errored: ${reason}`);
      continue;
    }
    try {
      const adapter = await factory.create(channel);
      await deps.gateway.registerChannel(channel.name, adapter, {
        globalDenyList: channel.globalDenyList,
        routing: channel.routing,
      });
      for (const rule of channel.routing) {
        const client = deps.resolveAgentClient(rule.agentId);
        if (client) deps.gateway.registerAgent(rule.agentId, client);
      }
      statuses.set(channel.name, { status: 'running' });
      deps.log?.(`[gateway] restored channel: ${channel.name} (${channel.adapter})`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      statuses.set(channel.name, { status: 'error', reason });
      deps.log?.(`[gateway] failed to restore channel ${channel.name}: ${reason}`);
    }
  }
  return statuses;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/gateway/src/channel-startup.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/channel-startup.ts apps/gateway/src/channel-startup.test.ts
git commit -m "feat(gateway): restore persisted channels through the factory registry"
```

---

### Task 8: Gateway — drive the channel management routes through the factory registry

**Files:**
- Modify: `apps/gateway/src/management-api.ts` (options interface ~22–54; POST /channels 393–507; GET /channels 509–511; PUT /channels 520–575; DELETE /channels 577–592; imports)
- Modify: `apps/gateway/src/management-api-server.test.ts` (append new describes; existing tests must pass unchanged)

- [ ] **Step 1: Write the failing tests**

Append to `apps/gateway/src/management-api-server.test.ts` (inside the top-level `describe('createGatewayManagementApp', ...)`, after the existing channel describes; reuse the file's `createApp`, `AUTH`, `JSON_HEADERS` helpers):

```ts
  describe('plugin channel adapters', () => {
    function makePluginFactories() {
      const registry = new ChannelFactoryRegistry();
      registry.register(
        wrapPluginChannelFactory({
          adapterName: 'discord',
          pluginName: 'discord-channel',
          configSchema: {
            type: 'object',
            properties: { botToken: { type: 'string' } },
            required: ['botToken'],
          },
          factory: () =>
            ({
              name: 'discord',
              start: async () => {},
              stop: async () => {},
              send: async () => {},
              onMessage: () => {},
              // biome-ignore lint/suspicious/noExplicitAny: minimal structural adapter
            }) as any,
        }),
      );
      return registry;
    }

    it('creates a channel for a plugin adapter with valid config', async () => {
      const { app, channelRegistry, agentRegistry } = createApp({
        channelFactories: makePluginFactories(),
      });
      (agentRegistry.register as ReturnType<typeof vi.fn>)({
        name: 'bot-a1',
        model: 'm',
        systemPrompt: 'p',
      });
      const res = await app.request('/channels', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          name: 'disc1',
          adapter: 'discord',
          config: { botToken: 'tok' },
          routing: [
            { condition: { type: 'default' }, agentId: 'a1', allowList: [], denyList: [] },
          ],
        }),
      });
      expect(res.status).toBe(201);
      expect(channelRegistry.register).toHaveBeenCalledWith(
        expect.objectContaining({ adapter: 'discord', config: { botToken: 'tok' } }),
      );
    });

    it('rejects a plugin channel with config that fails the schema', async () => {
      const { app, agentRegistry } = createApp({ channelFactories: makePluginFactories() });
      (agentRegistry.register as ReturnType<typeof vi.fn>)({
        name: 'bot-a1',
        model: 'm',
        systemPrompt: 'p',
      });
      const res = await app.request('/channels', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          name: 'disc1',
          adapter: 'discord',
          config: {},
          routing: [
            { condition: { type: 'default' }, agentId: 'a1', allowList: [], denyList: [] },
          ],
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('invalid config');
    });
  });

  describe('channel runtime status', () => {
    it('merges runtime status into GET /channels when provided', async () => {
      const channelRuntimeStatus = new Map([
        ['tg1', { status: 'error' as const, reason: 'adapter not available' }],
      ]);
      const { app, channelRegistry } = createApp({ channelRuntimeStatus });
      (channelRegistry.register as ReturnType<typeof vi.fn>)({
        name: 'tg1',
        adapter: 'telegram',
        globalDenyList: [],
        routing: [],
      });
      const res = await app.request('/channels', { headers: AUTH });
      const body = await res.json();
      expect(body[0].runtime).toEqual({ status: 'error', reason: 'adapter not available' });
    });
  });
```

Add the imports at the top of the test file:

```ts
import { ChannelFactoryRegistry, wrapPluginChannelFactory } from './channel-factories.js';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run apps/gateway/src/management-api-server.test.ts`
Expected: the two new describes FAIL (`channelFactories`/`channelRuntimeStatus` options unknown, plugin adapter → 400 `Unknown adapter type`); all pre-existing tests still PASS.

- [ ] **Step 3: Implement in `management-api.ts`**

1. Imports — remove `WhatsAppAdapter` from the `@dash/channels` import (keep `TelegramAdapter` for `restartChannelForTokenRotation`), and add:

```ts
import type { ChannelFactoryRegistry } from './channel-factories.js';
import { ChannelFactoryRegistry as ChannelFactoryRegistryImpl } from './channel-factories.js';
import { createBuiltinChannelFactories } from './channel-factories.js';
import type { RegisteredChannel } from './channel-registry.js';
import type { ChannelRuntimeStatus } from './channel-startup.js';
import { interpolateEnvVars, validateChannelConfig } from './plugin-channel-config.js';
```

(Biome will merge these into grouped imports on `npm run lint:fix`.)

2. Extend `GatewayManagementOptions`:

```ts
  /**
   * Channel adapter factories (built-ins + plugin-registered). When omitted
   * (tests, legacy callers) a registry containing only the built-ins is
   * constructed internally so POST /channels behavior is unchanged.
   */
  channelFactories?: ChannelFactoryRegistry;
  /**
   * Per-channel runtime status produced by restorePersistedChannels at
   * startup. Merged into GET /channels responses; updated by POST/DELETE.
   */
  channelRuntimeStatus?: Map<string, ChannelRuntimeStatus>;
  /**
   * Gateway data dir, used by the internally-constructed built-in factory
   * registry (WhatsApp session dirs). index.ts passes the real value.
   */
  dataDir?: string;
```

3. At the top of `createGatewayManagementApp`, after the `logger` line:

```ts
  const channelFactories =
    options.channelFactories ??
    (() => {
      const registry = new ChannelFactoryRegistryImpl();
      for (const factory of createBuiltinChannelFactories({
        credentialStore,
        channelRegistry,
        dataDir: options.dataDir ?? 'data',
      })) {
        registry.register(factory);
      }
      return registry;
    })();
```

4. Replace the whole `app.post('/channels', ...)` handler (lines 393–507):

```ts
  app.post('/channels', async (c) => {
    const parsed = await parseJsonBody<{
      name: string;
      adapter: string;
      routing: unknown[];
      globalDenyList?: string[];
      allowedUsers?: string[];
      config?: Record<string, unknown>;
    }>(c);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;

    if (!body.name || !body.adapter || !body.routing) {
      return c.json({ error: 'Missing required fields: name, adapter, routing' }, 400);
    }
    if (body.allowedUsers !== undefined && !Array.isArray(body.allowedUsers)) {
      return c.json({ error: 'allowedUsers must be an array of strings' }, 400);
    }
    if (
      body.config !== undefined &&
      (typeof body.config !== 'object' || body.config === null || Array.isArray(body.config))
    ) {
      return c.json({ error: 'config must be an object' }, 400);
    }

    const factory = channelFactories.get(body.adapter);
    if (!factory) {
      return c.json({ error: `Unknown adapter type: ${body.adapter}` }, 400);
    }

    const routing = body.routing as ChannelRoutingRule[];
    const globalDenyList = body.globalDenyList ?? [];
    const allowedUsers = body.allowedUsers ?? [];
    const channelName = body.name;

    // Referential integrity: reject routing rules that reference agents
    // that don't exist. Symmetric with DELETE /agents/:id cascade.
    const missingAgents = routing.map((r) => r.agentId).filter((id) => !agentRegistry.get(id));
    if (missingAgents.length > 0) {
      return c.json(
        {
          error: `routing references unknown agent(s): ${[...new Set(missingAgents)].join(', ')}`,
        },
        400,
      );
    }

    // Built-in adapters require their credential up front so the API keeps
    // returning the same clean 400 as before the factory refactor.
    if (factory.requiredCredentialKey) {
      const credKey = factory.requiredCredentialKey(channelName);
      if (!(await credentialStore.get(credKey))) {
        return c.json({ error: `No credential found for key '${credKey}'` }, 400);
      }
    }

    if (channelRegistry.has(channelName)) {
      return c.json({ error: `Channel '${channelName}' already exists` }, 409);
    }
    // Pre-register BEFORE constructing the adapter: the Telegram allow-list
    // closure and the gateway's resolveRouting both read the registry on
    // every inbound message (see the original comment, preserved intent).
    // Rolled back below on any failure.
    channelRegistry.register({
      name: channelName,
      adapter: body.adapter,
      globalDenyList,
      allowedUsers,
      ...(body.config ? { config: body.config } : {}),
      routing,
    });

    let adapter: ChannelAdapter;
    try {
      adapter = await factory.create(channelRegistry.get(channelName) as RegisteredChannel);
    } catch (err) {
      channelRegistry.remove(channelName); // rollback
      const message = err instanceof Error ? err.message : 'adapter creation failed';
      return c.json({ error: message }, 400);
    }

    try {
      await gateway.registerChannel(channelName, adapter, { globalDenyList, routing });
      for (const rule of routing) {
        if (agentRegistry.get(rule.agentId)) {
          gateway.registerAgent(rule.agentId, buildBridgeClient(rule.agentId));
        }
      }
      await channelRegistry.save();
      options.channelRuntimeStatus?.set(channelName, { status: 'running' });
      eventBus?.emit({ type: 'channel:created', channel: channelName });
      return c.json({ ok: true }, 201);
    } catch (err) {
      await gateway.stopChannel(channelName).catch(() => {});
      channelRegistry.remove(channelName);
      const message = err instanceof Error ? err.message : 'Internal error';
      return c.json({ error: message }, 500);
    }
  });
```

5. Replace `app.get('/channels', ...)` (lines 509–511):

```ts
  app.get('/channels', (c) => {
    const statuses = options.channelRuntimeStatus;
    return c.json(
      channelRegistry.list().map((entry) => {
        const runtime = statuses?.get(entry.name);
        return runtime ? { ...entry, runtime } : entry;
      }),
    );
  });
```

6. In `app.put('/channels/:name', ...)`, after the existing `routing must be an array` check, add:

```ts
    if (patch.config !== undefined) {
      if (
        typeof patch.config !== 'object' ||
        patch.config === null ||
        Array.isArray(patch.config)
      ) {
        return c.json({ error: 'config must be an object' }, 400);
      }
      const factory = channelFactories.get(entry.adapter);
      if (factory?.configSchema) {
        const interpolated = interpolateEnvVars(patch.config) as Record<string, unknown>;
        const validation = validateChannelConfig(factory.configSchema, interpolated);
        if (!validation.ok) {
          return c.json({ error: `invalid channel config: ${validation.errors}` }, 400);
        }
      }
      // Persisted now; the running adapter keeps its construction-time
      // config until the channel (or gateway) restarts — mirrors plugin
      // enable/disable restart semantics.
    }
```

7. In `app.delete('/channels/:name', ...)`, after `channelRegistry.remove(name);` add:

```ts
    options.channelRuntimeStatus?.delete(name);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/gateway/src/management-api-server.test.ts`
Expected: PASS — all pre-existing channel tests (telegram POST 201, missing credential 400 with `No credential found`, unknown adapter 400 with `Unknown adapter`, allowedUsers persistence, duplicate 409) plus the 3 new ones. Then `npx vitest run apps/gateway` — all green.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/management-api.ts apps/gateway/src/management-api-server.test.ts
git commit -m "feat(gateway): drive channel routes through the factory registry"
```

---

### Task 9: Gateway — plugin wiring helpers (tool filtering, hook bridge, provider keys, collision guard)

**Files:**
- Create: `apps/gateway/src/plugin-wiring.ts`
- Test: `apps/gateway/src/plugin-wiring.test.ts`

Everything here is structurally typed — NO import of `@dash/plugins` — so this task is buildable and testable before Plan 1 lands. Only `index.ts` (Task 15) touches the real package.

- [ ] **Step 1: Write the failing test**

Create `apps/gateway/src/plugin-wiring.test.ts`:

```ts
import { PiAgentBackend } from '@dash/agent';
import { Type } from '@sinclair/typebox';
import { describe, expect, it, vi } from 'vitest';
import type { LoadedPluginTool, PluginRegistryLike, ProviderCatalogLike } from './plugin-wiring.js';
import {
  BUILTIN_TOOL_NAMES,
  applyBuiltinCollisionGuard,
  buildAgentHookRunner,
  buildPluginModels,
  buildPluginProviders,
  filterPluginTools,
  overrideRegistry,
  resolveCatalogOwners,
  resolvePluginProviderKeys,
} from './plugin-wiring.js';

function makeTool(pluginName: string, name: string): LoadedPluginTool {
  return {
    pluginName,
    tool: {
      name,
      label: name,
      description: 'test tool',
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: 'text' as const, text: 'ok' }], details: {} }),
    },
  };
}

const groqCatalog: ProviderCatalogLike = {
  id: 'groq',
  label: 'Groq',
  credentialPrefix: 'groq-api-key',
  baseUrl: 'https://api.groq.com/openai/v1',
  api: 'openai-completions',
  models: [{ id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B' }, { id: 'qwq-32b' }],
};

const ollamaCatalog: ProviderCatalogLike = {
  id: 'ollama',
  label: 'Ollama',
  credentialPrefix: 'ollama-api-key',
  baseUrl: 'http://localhost:11434/v1',
  api: 'openai-completions',
  models: [{ id: 'llama3' }],
  dynamicModels: true,
  placeholderKey: 'ollama-local',
};

function makeRegistry(records: Array<Partial<Parameters<PluginRegistryLike['list']>[0]>>) {
  // helper unused — kept simple below
}

describe('filterPluginTools', () => {
  const tools = [makeTool('p1', 't1'), makeTool('p2', 't2'), makeTool('p2', 't3')];

  it('returns all plugin tools when the agent has no plugins field', () => {
    expect(filterPluginTools(tools, undefined).map((t) => t.name)).toEqual(['t1', 't2', 't3']);
  });

  it('filters to assigned plugins only', () => {
    expect(filterPluginTools(tools, ['p2']).map((t) => t.name)).toEqual(['t2', 't3']);
  });

  it('returns no tools for an explicit empty assignment', () => {
    expect(filterPluginTools(tools, [])).toEqual([]);
  });

  it('composes with PiAgentBackend extraTools injection', () => {
    const backend = new PiAgentBackend(
      { model: 'anthropic/claude-sonnet-4-5', systemPrompt: 'x' },
      {},
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      filterPluginTools(tools, ['p1']),
    );
    expect(backend.listExtraToolNames()).toEqual(['t1']);
  });
});

describe('buildAgentHookRunner', () => {
  it('injects agentName into every HookBus call and threads payloads back', async () => {
    const calls: Array<{ hook: string; event: unknown; ctx: unknown }> = [];
    const hookBus = {
      beforeToolCall: vi.fn(async (event: unknown, ctx: unknown) => {
        calls.push({ hook: 'before', event, ctx });
        return { params: { rewritten: true } };
      }),
      afterToolCall: vi.fn(async (event: unknown, ctx: unknown) => {
        calls.push({ hook: 'after', event, ctx });
        return { result: 'rewritten-result' };
      }),
      agentRunStart: vi.fn((event: unknown, ctx: unknown) => {
        calls.push({ hook: 'start', event, ctx });
      }),
      agentRunEnd: vi.fn((event: unknown, ctx: unknown) => {
        calls.push({ hook: 'end', event, ctx });
      }),
    };
    const runner = buildAgentHookRunner(hookBus, 'helper-bot');

    const before = await runner.beforeToolCall({
      toolName: 'bash',
      toolCallId: 'c1',
      params: { a: 1 },
      sessionId: 's1',
    });
    expect(before).toEqual({ params: { rewritten: true } });
    expect(calls[0]).toEqual({
      hook: 'before',
      event: { toolName: 'bash', toolCallId: 'c1', params: { a: 1 } },
      ctx: { agentName: 'helper-bot', sessionId: 's1' },
    });

    const after = await runner.afterToolCall({
      toolName: 'bash',
      toolCallId: 'c1',
      params: { a: 1 },
      result: 'out',
      isError: false,
      sessionId: 's1',
    });
    expect(after).toEqual({ result: 'rewritten-result' });

    runner.agentRunStart({ sessionId: 's1' });
    runner.agentRunEnd({ sessionId: 's1', usage: { inputTokens: 1, outputTokens: 2 } });
    expect(calls[2]).toEqual({
      hook: 'start',
      event: { agentName: 'helper-bot', sessionId: 's1' },
      ctx: { agentName: 'helper-bot', sessionId: 's1' },
    });
    expect(calls[3].event).toEqual({
      agentName: 'helper-bot',
      sessionId: 's1',
      usage: { inputTokens: 1, outputTokens: 2 },
      error: undefined,
    });
  });
});

describe('resolvePluginProviderKeys', () => {
  function makeStore(values: Record<string, string>) {
    return {
      list: async () => Object.keys(values),
      get: async (key: string) => values[key] ?? null,
    };
  }

  it('maps stored credentials under the catalog id', async () => {
    const keys = await resolvePluginProviderKeys(makeStore({ 'groq-api-key:default': 'gk1' }), [
      groqCatalog,
    ]);
    expect(keys).toEqual({ groq: 'gk1' });
  });

  it('falls back to placeholderKey for keyless locals WITHOUT writing the store', async () => {
    const store = makeStore({});
    const keys = await resolvePluginProviderKeys(store, [ollamaCatalog]);
    expect(keys).toEqual({ ollama: 'ollama-local' });
  });

  it('prefers a real credential over the placeholder', async () => {
    const keys = await resolvePluginProviderKeys(
      makeStore({ 'ollama-api-key:default': 'real' }),
      [ollamaCatalog],
    );
    expect(keys).toEqual({ ollama: 'real' });
  });

  it('omits providers with neither credential nor placeholder', async () => {
    const keys = await resolvePluginProviderKeys(makeStore({}), [groqCatalog]);
    expect(keys).toEqual({});
  });
});

describe('applyBuiltinCollisionGuard', () => {
  const builtins = {
    channelAdapters: ['telegram', 'whatsapp'],
    providerIds: ['anthropic', 'openai', 'google'],
    toolNames: BUILTIN_TOOL_NAMES,
  };

  it('marks a plugin errored when its tool collides with a built-in and drops ALL its registrations', () => {
    const result = applyBuiltinCollisionGuard({
      tools: [makeTool('bad-plugin', 'bash'), makeTool('bad-plugin', 'fine'), makeTool('ok', 'x')],
      channelFactories: new Map([['slack', { pluginName: 'bad-plugin' }]]),
      providerCatalogs: [groqCatalog],
      catalogOwners: new Map([['groq', 'ok']]),
      builtins,
    });
    expect(result.errored.get('bad-plugin')?.phase).toBe('register');
    expect(result.errored.get('bad-plugin')?.error).toContain("tool 'bash'");
    expect(result.tools.map((t) => t.tool.name)).toEqual(['x']);
    expect(result.channelFactories.size).toBe(0);
    expect(result.providerCatalogs).toEqual([groqCatalog]);
  });

  it('marks a plugin errored for a built-in channel adapter name', () => {
    const result = applyBuiltinCollisionGuard({
      tools: [],
      channelFactories: new Map([['telegram', { pluginName: 'sneaky' }]]),
      providerCatalogs: [],
      catalogOwners: new Map(),
      builtins,
    });
    expect(result.errored.get('sneaky')?.error).toContain("channel adapter 'telegram'");
    expect(result.channelFactories.size).toBe(0);
  });

  it('drops a provider catalog colliding with a built-in id and marks the owner when known', () => {
    const collider: ProviderCatalogLike = { ...groqCatalog, id: 'anthropic' };
    const result = applyBuiltinCollisionGuard({
      tools: [],
      channelFactories: new Map(),
      providerCatalogs: [collider, groqCatalog],
      catalogOwners: new Map([
        ['anthropic', 'imposter'],
        ['groq', 'ok'],
      ]),
      builtins,
    });
    expect(result.errored.get('imposter')?.error).toContain("provider id 'anthropic'");
    expect(result.providerCatalogs).toEqual([groqCatalog]);
  });

  it('passes clean registrations through untouched', () => {
    const factories = new Map([['discord', { pluginName: 'discord-channel' }]]);
    const result = applyBuiltinCollisionGuard({
      tools: [makeTool('p', 'my_tool')],
      channelFactories: factories,
      providerCatalogs: [groqCatalog],
      catalogOwners: new Map([['groq', 'p']]),
      builtins,
    });
    expect(result.errored.size).toBe(0);
    expect(result.tools).toHaveLength(1);
    expect(result.channelFactories).toEqual(factories);
    expect(result.providerCatalogs).toEqual([groqCatalog]);
  });
});

describe('resolveCatalogOwners', () => {
  function registryWith(
    records: Array<{ name: string; status: 'loaded' | 'disabled' | 'error'; providers: number }>,
  ): PluginRegistryLike {
    const list = records.map((r) => ({
      name: r.name,
      version: '1.0.0',
      status: r.status,
      capabilities: ['providers' as const],
      registrations: { tools: 0, channels: 0, providers: r.providers, hooks: 0 },
    }));
    return { list: () => list, get: (name) => list.find((r) => r.name === name) };
  }

  it('attributes all catalogs when exactly one loaded plugin registered providers', () => {
    const owners = resolveCatalogOwners(
      registryWith([
        { name: 'groq-provider', status: 'loaded', providers: 1 },
        { name: 'audit', status: 'loaded', providers: 0 },
      ]),
      [groqCatalog],
    );
    expect(owners.get('groq')).toBe('groq-provider');
  });

  it('leaves catalogs unattributed when several provider plugins are loaded', () => {
    const owners = resolveCatalogOwners(
      registryWith([
        { name: 'a', status: 'loaded', providers: 1 },
        { name: 'b', status: 'loaded', providers: 1 },
      ]),
      [groqCatalog, ollamaCatalog],
    );
    expect(owners.size).toBe(0);
  });
});

describe('overrideRegistry', () => {
  it('rewrites status and failure for collision-errored plugins', () => {
    const base: PluginRegistryLike = {
      list: () => [
        {
          name: 'bad',
          version: '1.0.0',
          status: 'loaded',
          capabilities: ['tools'],
          registrations: { tools: 1, channels: 0, providers: 0, hooks: 0 },
        },
      ],
      get: (name) =>
        name === 'bad'
          ? {
              name: 'bad',
              version: '1.0.0',
              status: 'loaded',
              capabilities: ['tools'],
              registrations: { tools: 1, channels: 0, providers: 0, hooks: 0 },
            }
          : undefined,
    };
    const failure = {
      phase: 'register' as const,
      error: "tool 'bash' collides with a built-in tool",
      failedAt: '2026-06-10T00:00:00.000Z',
    };
    const wrapped = overrideRegistry(base, new Map([['bad', failure]]));
    expect(wrapped.list()[0].status).toBe('error');
    expect(wrapped.get('bad')?.failure).toEqual(failure);
    expect(wrapped.get('missing')).toBeUndefined();
  });
});

describe('buildPluginModels / buildPluginProviders', () => {
  it('builds provenance-tagged model entries; dynamicModels lists catalog models only', () => {
    const owners = new Map([
      ['groq', 'groq-provider'],
      ['ollama', 'ollama-provider'],
    ]);
    const models = buildPluginModels([groqCatalog, ollamaCatalog], owners);
    expect(models).toEqual([
      {
        value: 'groq/llama-3.3-70b-versatile',
        label: 'Llama 3.3 70B',
        provider: 'groq',
        source: 'plugin:groq-provider',
      },
      { value: 'groq/qwq-32b', label: 'qwq-32b', provider: 'groq', source: 'plugin:groq-provider' },
      { value: 'ollama/llama3', label: 'llama3', provider: 'ollama', source: 'plugin:ollama-provider' },
    ]);
  });

  it('tags unattributed catalogs with plain "plugin"', () => {
    const models = buildPluginModels([groqCatalog], new Map());
    expect(models[0].source).toBe('plugin');
  });

  it('builds provider listing entries', () => {
    const providers = buildPluginProviders([groqCatalog], new Map([['groq', 'groq-provider']]));
    expect(providers).toEqual([
      {
        id: 'groq',
        label: 'Groq',
        credentialPrefix: 'groq-api-key',
        source: 'plugin:groq-provider',
      },
    ]);
  });
});
```

Remove the unused `makeRegistry` placeholder above when transcribing (it is not part of the file — the helper used is `registryWith` inside its describe).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/gateway/src/plugin-wiring.test.ts`
Expected: FAIL — cannot resolve `./plugin-wiring.js`.

- [ ] **Step 3: Implement `apps/gateway/src/plugin-wiring.ts`**

```ts
import type { AgentHookRunner, ExtraTool } from '@dash/agent';

// ─── Structural mirrors of @dash/plugins shapes ──────────────────────────
// CONTRACT: these mirror the Plan 1 loader output structurally. The gateway
// deliberately does NOT import @dash/plugins here so this module (and its
// tests) compile before the plugins package exists; only index.ts imports
// the real package and its objects satisfy these shapes.

export interface LoadedPluginTool {
  pluginName: string;
  tool: ExtraTool;
}

export interface ProviderCatalogLike {
  id: string;
  label: string;
  credentialPrefix: string;
  baseUrl: string;
  api: string;
  models: Array<{ id: string; name?: string }>;
  dynamicModels?: boolean;
  placeholderKey?: string;
}

export interface PluginRecordLike {
  name: string;
  version: string;
  description?: string;
  status: 'loaded' | 'disabled' | 'error';
  capabilities: Array<'tools' | 'channels' | 'providers' | 'hooks'>;
  failure?: { phase: string; error: string; failedAt: string };
  registrations: { tools: number; channels: number; providers: number; hooks: number };
  configSchema?: Record<string, unknown>;
  config?: Record<string, unknown>;
}

export interface PluginRegistryLike {
  list(): PluginRecordLike[];
  get(name: string): PluginRecordLike | undefined;
}

interface HookCtx {
  agentName?: string;
  channel?: string;
  sessionId?: string;
}

/** Structural mirror of @dash/plugins' HookBus (agent-relevant subset). */
export interface AgentHookBusLike {
  beforeToolCall(
    event: { toolName: string; toolCallId: string; params: unknown },
    ctx: HookCtx,
  ): Promise<{ params: unknown } | { blocked: true; reason: string }>;
  afterToolCall(
    event: {
      toolName: string;
      toolCallId: string;
      params: unknown;
      result: string;
      isError: boolean;
    },
    ctx: HookCtx,
  ): Promise<{ result: string }>;
  agentRunStart(event: { agentName: string; sessionId?: string }, ctx: HookCtx): void;
  agentRunEnd(
    event: {
      agentName: string;
      sessionId?: string;
      usage?: { inputTokens: number; outputTokens: number };
      error?: string;
    },
    ctx: HookCtx,
  ): void;
}

// ─── Per-agent tool filtering ─────────────────────────────────────────────

/**
 * Filter plugin tools by the agent's `plugins?: string[]` assignment.
 * `undefined` = all plugin tools (default); `[]` = none; otherwise only
 * tools from the named plugins. Mirrors the assignedMcpServers contract.
 */
export function filterPluginTools(
  tools: LoadedPluginTool[],
  assignedPlugins?: string[],
): ExtraTool[] {
  if (!assignedPlugins) return tools.map((t) => t.tool);
  const allowed = new Set(assignedPlugins);
  return tools.filter((t) => allowed.has(t.pluginName)).map((t) => t.tool);
}

// ─── Per-agent hook runner bridge ─────────────────────────────────────────

/**
 * Wrap the global HookBus into the per-agent AgentHookRunner the backend
 * consumes, injecting agentName into every call.
 *
 * CONTRACT: hooks (and projects) identify an agent by config.name — NOT the
 * registry uuid used for chat addressing. Same contract as the projects
 * tools' agents_involved filter.
 */
export function buildAgentHookRunner(hookBus: AgentHookBusLike, agentName: string): AgentHookRunner {
  return {
    beforeToolCall: (e) =>
      hookBus.beforeToolCall(
        { toolName: e.toolName, toolCallId: e.toolCallId, params: e.params },
        { agentName, sessionId: e.sessionId },
      ),
    afterToolCall: (e) =>
      hookBus.afterToolCall(
        {
          toolName: e.toolName,
          toolCallId: e.toolCallId,
          params: e.params,
          result: e.result,
          isError: e.isError,
        },
        { agentName, sessionId: e.sessionId },
      ),
    agentRunStart: (e) =>
      hookBus.agentRunStart(
        { agentName, sessionId: e.sessionId },
        { agentName, sessionId: e.sessionId },
      ),
    agentRunEnd: (e) =>
      hookBus.agentRunEnd(
        { agentName, sessionId: e.sessionId, usage: e.usage, error: e.error },
        { agentName, sessionId: e.sessionId },
      ),
  };
}

// ─── Plugin provider credentials ──────────────────────────────────────────

export interface CredentialReader {
  list(): Promise<string[]>;
  get(key: string): Promise<string | null>;
}

/**
 * Resolve plugin provider credentials keyed by catalog id (the pi-ai
 * provider name a constructed Model carries). The first stored key under
 * `<credentialPrefix>:` wins, matching readProviderApiKeys' semantics.
 *
 * placeholderKey handling: keyless local providers (Ollama) get their
 * placeholder injected into the IN-MEMORY key map only — pi's setModel()
 * rejects empty/missing keys for a model's provider. The placeholder is
 * never written to the persistent credential store.
 */
export async function resolvePluginProviderKeys(
  store: CredentialReader,
  catalogs: ProviderCatalogLike[],
): Promise<Record<string, string>> {
  const storedKeys = await store.list();
  const out: Record<string, string> = {};
  for (const catalog of catalogs) {
    const match = storedKeys.find((k) => k.startsWith(`${catalog.credentialPrefix}:`));
    const value = match ? await store.get(match) : null;
    if (value) {
      out[catalog.id] = value;
    } else if (catalog.placeholderKey) {
      out[catalog.id] = catalog.placeholderKey;
    }
  }
  return out;
}

// ─── Built-in collision guard ─────────────────────────────────────────────

/**
 * Tool names owned by the gateway/core. The plugin loader (Plan 1) enforces
 * plugin-vs-plugin name collisions but cannot know Dash built-ins; this is
 * the gateway-side half of the spec's uniform collision policy (built-ins
 * always win, loser gets a structured registration error).
 */
export const BUILTIN_TOOL_NAMES: string[] = [
  'read',
  'bash',
  'edit',
  'write',
  'grep',
  'find',
  'ls',
  'todowrite',
  'load_skill',
  'create_skill',
  'web_fetch',
  'web_search',
  'mcp_add_server',
  'mcp_list_servers',
  'mcp_remove_server',
  'projects_list',
  'projects_read',
  'projects_create',
  'issues_list',
  'issues_read',
  'issues_create',
  'issues_update',
  'issues_comment',
  'issues_comment_edit',
  'issues_comment_delete',
];

export interface BuiltinNames {
  channelAdapters: string[];
  providerIds: string[];
  toolNames: string[];
}

export interface CollisionFailure {
  phase: 'register';
  error: string;
  failedAt: string;
}

export interface GuardInput<TFactory extends { pluginName: string }, TCatalog extends ProviderCatalogLike> {
  tools: LoadedPluginTool[];
  channelFactories: Map<string, TFactory>;
  providerCatalogs: TCatalog[];
  /** catalog.id → owning plugin name (see resolveCatalogOwners). */
  catalogOwners: Map<string, string>;
  builtins: BuiltinNames;
  log?: (msg: string) => void;
}

export interface GuardResult<TFactory extends { pluginName: string }, TCatalog> {
  errored: Map<string, CollisionFailure>;
  tools: LoadedPluginTool[];
  channelFactories: Map<string, TFactory>;
  providerCatalogs: TCatalog[];
}

/**
 * Post-load check for collisions with Dash built-ins (tool names, the
 * 'telegram'/'whatsapp' adapters, built-in provider ids). The loader can't
 * know built-ins (Plan 1 contract), so the gateway filters here: a colliding
 * plugin is marked errored (failurePhase 'register') and loses ALL its
 * registrations — partial registration would misrepresent plugin state.
 * The registry itself is read-only to us; overrideRegistry() projects these
 * failures onto the records served by GET /plugins and /info.
 */
export function applyBuiltinCollisionGuard<
  TFactory extends { pluginName: string },
  TCatalog extends ProviderCatalogLike,
>(input: GuardInput<TFactory, TCatalog>): GuardResult<TFactory, TCatalog> {
  const errored = new Map<string, CollisionFailure>();
  const fail = (pluginName: string, error: string): void => {
    if (!errored.has(pluginName)) {
      errored.set(pluginName, { phase: 'register', error, failedAt: new Date().toISOString() });
    }
    input.log?.(`[plugins] ${pluginName}: ${error}`);
  };

  const builtinTools = new Set(input.builtins.toolNames);
  for (const entry of input.tools) {
    if (builtinTools.has(entry.tool.name)) {
      fail(entry.pluginName, `tool '${entry.tool.name}' collides with a built-in tool`);
    }
  }

  const builtinAdapters = new Set(input.builtins.channelAdapters);
  for (const [adapterName, entry] of input.channelFactories) {
    if (builtinAdapters.has(adapterName)) {
      fail(
        entry.pluginName,
        `channel adapter '${adapterName}' collides with a built-in channel adapter`,
      );
    }
  }

  const builtinProviders = new Set(input.builtins.providerIds);
  for (const catalog of input.providerCatalogs) {
    if (builtinProviders.has(catalog.id)) {
      const owner = input.catalogOwners.get(catalog.id);
      if (owner) {
        fail(owner, `provider id '${catalog.id}' collides with a built-in provider`);
      } else {
        input.log?.(
          `[plugins] provider catalog '${catalog.id}' collides with a built-in provider — dropped (owning plugin unknown)`,
        );
      }
    }
  }

  const tools = input.tools.filter((t) => !errored.has(t.pluginName));
  const channelFactories = new Map(
    [...input.channelFactories].filter(
      ([name, entry]) => !errored.has(entry.pluginName) && !builtinAdapters.has(name),
    ),
  );
  const providerCatalogs = input.providerCatalogs.filter((catalog) => {
    if (builtinProviders.has(catalog.id)) return false;
    const owner = input.catalogOwners.get(catalog.id);
    return !(owner && errored.has(owner));
  });

  return { errored, tools, channelFactories, providerCatalogs };
}

/**
 * Best-effort catalog → plugin attribution.
 *
 * ADAPTATION POINT (cross-review): LoadedPlugins.providerCatalogs carries no
 * per-catalog pluginName (unlike tools and channelFactories). Until Plan 1
 * adds it, attribution is only possible when exactly one loaded plugin
 * registered providers; otherwise catalogs stay unattributed and their
 * models/providers are tagged `source: 'plugin'` without a name. When Plan 1
 * ships per-catalog owners, replace this function's body with a direct map.
 */
export function resolveCatalogOwners(
  registry: PluginRegistryLike,
  catalogs: ProviderCatalogLike[],
): Map<string, string> {
  const owners = new Map<string, string>();
  const providerPlugins = registry
    .list()
    .filter((p) => p.status === 'loaded' && p.registrations.providers > 0);
  if (providerPlugins.length === 1) {
    for (const catalog of catalogs) owners.set(catalog.id, providerPlugins[0].name);
  }
  return owners;
}

/**
 * Decorate the (read-only) plugin registry with the gateway's collision
 * failures so GET /plugins, /info, and the startup summary all see one
 * truth. The simplest honest approach given the loader can't know built-ins.
 */
export function overrideRegistry(
  registry: PluginRegistryLike,
  errored: Map<string, CollisionFailure>,
): PluginRegistryLike {
  const apply = (record: PluginRecordLike): PluginRecordLike => {
    const failure = errored.get(record.name);
    return failure ? { ...record, status: 'error', failure } : record;
  };
  return {
    list: () => registry.list().map(apply),
    get: (name) => {
      const record = registry.get(name);
      return record ? apply(record) : undefined;
    },
  };
}

// ─── Models / providers listing builders ─────────────────────────────────

export interface PluginModelEntry {
  value: string;
  label: string;
  provider: string;
  source: string;
}

/**
 * Catalog models for the GET /models merge, provenance-tagged
 * `plugin:<name>` (or plain `plugin` when the owner is unknown — see
 * resolveCatalogOwners). dynamicModels providers list catalog.models only:
 * dynamic ids resolve at runtime via createModelCatalog, not in listings.
 */
export function buildPluginModels(
  catalogs: ProviderCatalogLike[],
  owners: Map<string, string>,
): PluginModelEntry[] {
  const models: PluginModelEntry[] = [];
  for (const catalog of catalogs) {
    const owner = owners.get(catalog.id);
    const source = owner ? `plugin:${owner}` : 'plugin';
    for (const model of catalog.models) {
      models.push({
        value: `${catalog.id}/${model.id}`,
        label: model.name ?? model.id,
        provider: catalog.id,
        source,
      });
    }
  }
  return models;
}

export interface PluginProviderEntry {
  id: string;
  label: string;
  credentialPrefix: string;
  source: string;
}

/** Plugin provider entries for the GET /providers listing (MC credential cards). */
export function buildPluginProviders(
  catalogs: ProviderCatalogLike[],
  owners: Map<string, string>,
): PluginProviderEntry[] {
  return catalogs.map((catalog) => {
    const owner = owners.get(catalog.id);
    return {
      id: catalog.id,
      label: catalog.label,
      credentialPrefix: catalog.credentialPrefix,
      source: owner ? `plugin:${owner}` : 'plugin',
    };
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/gateway/src/plugin-wiring.test.ts`
Expected: PASS (17 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/plugin-wiring.ts apps/gateway/src/plugin-wiring.test.ts
git commit -m "feat(gateway): add plugin wiring helpers"
```

---

### Task 10: Gateway — per-agent plugin assignment in the agent registry

**Files:**
- Modify: `apps/gateway/src/agent-registry.ts` (`GatewayAgentConfig`, lines 5–16)
- Test: `apps/gateway/src/agent-registry.test.ts` (append)

`plugins?: string[]` flows exactly like `mcpServers?: string[]`: it is a `GatewayAgentConfig` field, so `POST /agents` (full-body register) and `PUT /agents/:id` (generic `update()` merge) pass it through with zero route changes, and `agents.json` persistence is automatic. No `ManagementClient.updateAgentConfig` change — `mcpServers` does not flow through that method either, and we mirror exactly.

- [ ] **Step 1: Write the failing test**

Append to `apps/gateway/src/agent-registry.test.ts` (reuse the file's existing imports/temp-dir helpers; if it has none for persistence, use the pattern below):

```ts
describe('per-agent plugin assignment', () => {
  it('persists plugins across save/load and patches via update()', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dash-agreg-plugins-'));
    try {
      const filePath = join(dir, 'agents.json');
      const registry = new AgentRegistry(filePath);
      const entry = registry.register({
        name: 'helper',
        model: 'anthropic/claude-sonnet-4-5',
        systemPrompt: 'x',
        plugins: ['audit-log'],
      });
      expect(entry.config.plugins).toEqual(['audit-log']);
      await registry.save();

      const reloaded = new AgentRegistry(filePath);
      await reloaded.load();
      expect(reloaded.get(entry.id)?.config.plugins).toEqual(['audit-log']);

      reloaded.update(entry.id, { plugins: [] });
      expect(reloaded.get(entry.id)?.config.plugins).toEqual([]);
      reloaded.update(entry.id, { plugins: undefined });
      // explicit undefined in a PUT body means "field not patched" at the
      // route layer; update() spreads it, restoring the unset default
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

Add `mkdtemp`, `rm`, `tmpdir`, `join` imports to the test file if missing.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/gateway/src/agent-registry.test.ts`
Expected: FAIL — type error: `plugins` does not exist on `GatewayAgentConfig`.

- [ ] **Step 3: Implement**

In `apps/gateway/src/agent-registry.ts`, add to `GatewayAgentConfig` after `mcpServers?: string[];`:

```ts
  /**
   * Plugin tool assignment: names of plugins whose tools this agent gets.
   * `undefined` = all plugin tools (default); `[]` = none. Mirrors the
   * mcpServers contract: flows through POST /agents and PUT /agents/:id
   * bodies via the generic update() merge and persists to agents.json.
   */
  plugins?: string[];
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/gateway/src/agent-registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/agent-registry.ts apps/gateway/src/agent-registry.test.ts
git commit -m "feat(gateway): add per-agent plugin assignment to the agent registry"
```

---

### Task 11: Gateway — message_received / message_sending hooks in the message router

**Files:**
- Modify: `apps/gateway/src/gateway.ts` (`DynamicGatewayOptions` lines 41–44; `handleMessage` lines 122–277; factory line 76–79)
- Test: `apps/gateway/src/gateway.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `apps/gateway/src/gateway.test.ts` (reuse the existing `makeFakeAdapter` helper; add a chat-recording agent):

```ts
describe('message hooks', () => {
  function makeRecordingAgent(): { agent: AgentClient; chats: string[] } {
    const chats: string[] = [];
    const agent: AgentClient = {
      // biome-ignore lint/suspicious/noExplicitAny: structural fake
      chat: ((_: string, __: string, text: string) => {
        chats.push(text);
        return (async function* () {
          yield { type: 'response', content: `echo:${text}` };
        })();
      }) as any,
    };
    return { agent, chats };
  }

  function makeMsg(text: string): InboundMessage {
    return {
      channelId: 'tg1',
      conversationId: 'conv1',
      senderId: 'u1',
      senderName: 'User',
      text,
      timestamp: new Date(),
    };
  }

  async function setup(hooks?: import('./gateway.js').GatewayMessageHooks) {
    const gw = createDynamicGateway({ hooks });
    const { agent, chats } = makeRecordingAgent();
    gw.registerAgent('agent1', agent);
    const adapter = makeFakeAdapter('telegram');
    await gw.registerChannel('tg1', adapter, {
      globalDenyList: [],
      routing: [{ condition: { type: 'default' }, agentId: 'agent1', allowList: [], denyList: [] }],
    });
    return { gw, adapter, chats };
  }

  it('passes the (possibly rewritten) inbound message to the agent', async () => {
    const { adapter, chats } = await setup({
      messageReceived: async (event) => ({
        message: { ...event.message, text: `${event.message.text} [tagged]` },
      }),
      messageSending: async (event) => ({ content: event.content }),
    });
    await adapter.trigger(makeMsg('hello'));
    expect(chats).toEqual(['hello [tagged]']);
  });

  it('drops the message and never dispatches when the hook returns dropped', async () => {
    const { adapter, chats } = await setup({
      messageReceived: async () => ({ dropped: true }),
      messageSending: async (event) => ({ content: event.content }),
    });
    await adapter.trigger(makeMsg('spam'));
    expect(chats).toEqual([]);
    expect(adapter.send).not.toHaveBeenCalled();
  });

  it('rewrites outbound content via message_sending', async () => {
    const { adapter } = await setup({
      messageReceived: async (event) => ({ message: event.message }),
      messageSending: async (event) => ({ content: `${event.content} [audited]` }),
    });
    await adapter.trigger(makeMsg('hi'));
    expect(adapter.send).toHaveBeenCalledWith('conv1', { text: 'echo:hi [audited]' });
  });

  it('skips adapter.send when message_sending cancels (response already persisted upstream)', async () => {
    const { adapter, chats } = await setup({
      messageReceived: async (event) => ({ message: event.message }),
      messageSending: async () => ({ cancelled: true }),
    });
    await adapter.trigger(makeMsg('hi'));
    expect(chats).toEqual(['hi']);
    expect(adapter.send).not.toHaveBeenCalled();
  });

  it('forwards channel and agentId context to message_sending', async () => {
    const seen: Array<{ channel: string; agentId: string; conversationId: string }> = [];
    const { adapter } = await setup({
      messageReceived: async (event) => ({ message: event.message }),
      messageSending: async (event) => {
        seen.push({
          channel: event.channel,
          agentId: event.agentId,
          conversationId: event.conversationId,
        });
        return { content: event.content };
      },
    });
    await adapter.trigger(makeMsg('hi'));
    expect(seen).toEqual([{ channel: 'tg1', agentId: 'agent1', conversationId: 'conv1' }]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/gateway/src/gateway.test.ts`
Expected: the new describe FAILS (`GatewayMessageHooks` not exported; hooks ignored); existing tests PASS.

- [ ] **Step 3: Implement in `gateway.ts`**

1. Add the hooks interface above `DynamicGatewayOptions` and extend it:

```ts
/**
 * Plugin message hooks, called by handleMessage on the CHANNEL path only.
 * MC chat (chat-ws) deliberately bypasses message hooks in v1 per the
 * plugins spec — tool/run hooks still fire there via the backend's
 * hookRunner. The gateway stays structurally typed: index.ts adapts
 * @dash/plugins' HookBus into this shape (mapping agentId → agent name for
 * hook context).
 */
export interface GatewayMessageHooks {
  messageReceived(event: {
    message: InboundMessage;
    channel: string;
  }): Promise<{ message: InboundMessage } | { dropped: true }>;
  messageSending(event: {
    conversationId: string;
    content: string;
    channel: string;
    agentId: string;
  }): Promise<{ content: string } | { cancelled: true }>;
}

export interface DynamicGatewayOptions {
  dataDir?: string;
  resolveRouting?: RoutingResolver;
  hooks?: GatewayMessageHooks;
}
```

2. In `createDynamicGateway`, next to `const resolveRouting = options?.resolveRouting;` add:

```ts
  const hooks = options?.hooks;
```

3. In `handleMessage`, after the allow-list check (`if (matched.allowList.length > 0 && ...) { ... return; }`) and BEFORE `const agent = agents.get(matched.agentId);`, insert:

```ts
      // message_received plugin hook — after the operator's allow/deny
      // checks (plugins never see messages the operator already blocked),
      // before agent dispatch (so a rewrite reaches the agent). The hook
      // bus is fail-open internally; a dropped verdict is audit-logged.
      let effectiveMsg = msg;
      if (hooks) {
        const verdict = await hooks.messageReceived({ message: msg, channel: channelName });
        if ('dropped' in verdict) {
          logMessage({ ...baseLog, outcome: 'blocked', agentName, blockReason: 'hook_dropped' });
          return;
        }
        effectiveMsg = verdict.message;
      }
```

4. Use `effectiveMsg` downstream of the hook. Specifically:
   - `const prefixedConvId = \`${channelName}:${effectiveMsg.conversationId}\`;`
   - `agent.chat(effectiveMsg.channelId, prefixedConvId, effectiveMsg.text)`
   - both `adapter.send(...)` calls use `effectiveMsg.conversationId`
   - error logs in the chat loop reference `effectiveMsg.conversationId`

5. Replace the outbound block (`if (fullResponse) { try { await adapter.send(...) } ... }`) with:

```ts
      if (fullResponse) {
        let outbound = fullResponse;
        if (hooks) {
          // message_sending plugin hook — last gate before delivery.
          // CHANNEL PATH ONLY (per spec): MC chat-ws is untouched. On
          // cancel, the assistant message has already been persisted to
          // the agent session — only channel delivery is suppressed.
          const verdict = await hooks.messageSending({
            conversationId: effectiveMsg.conversationId,
            content: fullResponse,
            channel: channelName,
            agentId: matched.agentId,
          });
          if ('cancelled' in verdict) {
            console.warn(
              `[gateway] message_sending hook cancelled delivery channel=${channelName} conversationId=${effectiveMsg.conversationId}`,
            );
            logMessage({
              ...baseLog,
              outcome: 'blocked',
              agentName,
              blockReason: 'hook_cancelled',
            });
            outbound = '';
          } else {
            outbound = verdict.content;
          }
        }
        if (outbound) {
          try {
            await adapter.send(effectiveMsg.conversationId, { text: outbound });
          } catch (err) {
            console.error(
              `[gateway] adapter.send failed channel=${channelName} conversationId=${effectiveMsg.conversationId}:`,
              err instanceof Error ? (err.stack ?? err.message) : err,
            );
            logMessage({
              ...baseLog,
              outcome: 'blocked',
              agentName,
              blockReason: `send_failed: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
        }
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/gateway/src/gateway.test.ts`
Expected: PASS — 5 new tests plus all pre-existing ones (no hooks configured = identical behavior).

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/gateway.ts apps/gateway/src/gateway.test.ts
git commit -m "feat(gateway): run message_received/message_sending hooks in routing"
```

---

### Task 12: @dash/management — PluginView wire types + plugins routes

**Files:**
- Modify: `packages/management/src/types.ts` (append)
- Create: `packages/management/src/plugins-routes.ts`
- Modify: `packages/management/src/index.ts` (exports)
- Test: `packages/management/src/plugins-routes.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/management/src/plugins-routes.test.ts`:

```ts
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PluginRecordLike, PluginsRoutesDeps } from './plugins-routes.js';
import { maskPluginConfig, mountPluginsRoutes } from './plugins-routes.js';
import type { PluginView } from './types.js';

const auditRecord: PluginRecordLike = {
  name: 'audit-log',
  version: '0.3.0',
  description: 'Audits tool calls',
  status: 'loaded',
  capabilities: ['hooks', 'tools'],
  registrations: { tools: 1, channels: 0, providers: 0, hooks: 2 },
  configSchema: {
    type: 'object',
    properties: {
      apiKey: { type: 'string', sensitive: true },
      level: { type: 'string' },
    },
  },
  config: { apiKey: 'super-secret', level: 'info' },
};

const brokenRecord: PluginRecordLike = {
  name: 'broken',
  version: '1.0.0',
  status: 'error',
  capabilities: ['channels'],
  failure: { phase: 'import', error: 'Cannot find module', failedAt: '2026-06-10T00:00:00Z' },
  registrations: { tools: 0, channels: 0, providers: 0, hooks: 0 },
};

function makeDeps(): PluginsRoutesDeps & { entries: Record<string, { enabled: boolean }> } {
  const entries: Record<string, { enabled: boolean }> = {
    'audit-log': { enabled: true },
    broken: { enabled: true },
  };
  const records = [auditRecord, brokenRecord];
  return {
    entries,
    registry: {
      list: () => records,
      get: (name) => records.find((r) => r.name === name),
    },
    hookBus: {
      counters: () => ({
        'audit-log': {
          before_tool_call: { fired: 4, modified: 1, blocked: 0, failed: 0, timedOut: 0 },
        },
      }),
    },
    configStore: {
      load: async () => entries,
      setEnabled: async (name, enabled) => {
        entries[name] = { enabled };
      },
    },
    adapters: [
      { name: 'telegram', builtIn: true },
      {
        name: 'discord',
        builtIn: false,
        pluginName: 'discord-channel',
        configSchema: { type: 'object' },
      },
    ],
  };
}

let app: Hono;
let deps: ReturnType<typeof makeDeps>;

beforeEach(() => {
  app = new Hono();
  deps = makeDeps();
  mountPluginsRoutes(app, deps);
});

describe('maskPluginConfig', () => {
  it('masks values whose schema property is sensitive', () => {
    expect(maskPluginConfig(auditRecord.configSchema, auditRecord.config ?? {})).toEqual({
      apiKey: '•••',
      level: 'info',
    });
  });

  it('masks nothing without a schema', () => {
    expect(maskPluginConfig(undefined, { a: 1 })).toEqual({ a: 1 });
  });
});

describe('GET /plugins', () => {
  it('returns the full PluginView list with masked config and hook counters', async () => {
    const res = await app.request('/plugins');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { plugins: PluginView[] };
    expect(body.plugins).toHaveLength(2);

    const audit = body.plugins.find((p) => p.name === 'audit-log');
    expect(audit).toMatchObject({
      name: 'audit-log',
      version: '0.3.0',
      description: 'Audits tool calls',
      status: 'loaded',
      capabilities: ['hooks', 'tools'],
      registrations: { tools: 1, channels: 0, providers: 0, hooks: 2 },
      enabled: true,
    });
    expect(audit?.config).toEqual({ apiKey: '•••', level: 'info' });
    expect(audit?.hookCounters.before_tool_call).toEqual({
      fired: 4,
      modified: 1,
      blocked: 0,
      failed: 0,
      timedOut: 0,
    });

    const broken = body.plugins.find((p) => p.name === 'broken');
    expect(broken?.status).toBe('error');
    expect(broken?.failure).toEqual({
      phase: 'import',
      error: 'Cannot find module',
      failedAt: '2026-06-10T00:00:00Z',
    });
    expect(broken?.hookCounters).toEqual({});
  });
});

describe('PATCH /plugins/:name', () => {
  it('flips enabled and reports restartRequired', async () => {
    const res = await app.request('/plugins/audit-log', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { plugin: PluginView; restartRequired: boolean };
    expect(body.restartRequired).toBe(true);
    expect(body.plugin.enabled).toBe(false);
    expect(deps.entries['audit-log']).toEqual({ enabled: false });
  });

  it('404s for unknown plugins with the pinned error shape', async () => {
    const res = await app.request('/plugins/nope', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'unknown plugin: nope' });
  });

  it('400s for a non-boolean enabled', async () => {
    const res = await app.request('/plugins/audit-log', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: 'yes' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /channels/adapters', () => {
  it('returns built-in and plugin adapters', async () => {
    const res = await app.request('/channels/adapters');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      adapters: [
        { name: 'telegram', builtIn: true },
        {
          name: 'discord',
          builtIn: false,
          pluginName: 'discord-channel',
          configSchema: { type: 'object' },
        },
      ],
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/management/src/plugins-routes.test.ts`
Expected: FAIL — cannot resolve `./plugins-routes.js`.

- [ ] **Step 3: Add the wire types to `packages/management/src/types.ts`**

Append at the end of the file:

```ts
// --- Plugins ---
//
// Wire types for the gateway's /plugins and /channels/adapters routes.
// Structural mirrors of @dash/plugins' registry records — @dash/management
// does NOT depend on @dash/plugins (same pattern as the Projects types
// above). PluginView is THE shape MC renders; keep in sync with
// apps/mission-control/src/shared/plugins-ipc.ts (Plan 3).

export type PluginCapability = 'tools' | 'channels' | 'providers' | 'hooks';

export type PluginHookCounters = Partial<
  Record<
    string,
    { fired: number; modified: number; blocked: number; failed: number; timedOut: number }
  >
>;

export interface PluginView {
  name: string;
  version: string;
  description?: string;
  status: 'loaded' | 'disabled' | 'error';
  capabilities: PluginCapability[];
  failure?: {
    phase: 'manifest' | 'compat' | 'config' | 'import' | 'register';
    error: string;
    failedAt: string;
  };
  registrations: { tools: number; channels: number; providers: number; hooks: number };
  hookCounters: PluginHookCounters;
  configSchema?: Record<string, unknown>;
  /** Sensitive fields masked to '•••' (per configSchema `sensitive: true`). */
  config?: Record<string, unknown>;
  enabled: boolean;
}

export interface ChannelAdapterInfo {
  name: string;
  builtIn: boolean;
  pluginName?: string;
  configSchema?: Record<string, unknown>;
}
```

- [ ] **Step 4: Implement `packages/management/src/plugins-routes.ts`**

```ts
import type { Hono } from 'hono';
import type {
  ChannelAdapterInfo,
  PluginCapability,
  PluginHookCounters,
  PluginView,
} from './types.js';

/**
 * Structural mirror of @dash/plugins' PluginRecord. `config` arrives
 * UNmasked from the registry — masking happens HERE at the route layer
 * (maskPluginConfig), never upstream.
 */
export interface PluginRecordLike {
  name: string;
  version: string;
  description?: string;
  status: 'loaded' | 'disabled' | 'error';
  capabilities: PluginCapability[];
  failure?: {
    phase: 'manifest' | 'compat' | 'config' | 'import' | 'register';
    error: string;
    failedAt: string;
  };
  registrations: { tools: number; channels: number; providers: number; hooks: number };
  configSchema?: Record<string, unknown>;
  config?: Record<string, unknown>;
}

export interface PluginsRoutesDeps {
  registry: {
    list(): PluginRecordLike[];
    get(name: string): PluginRecordLike | undefined;
  };
  hookBus: {
    counters(): Record<string, PluginHookCounters>;
  };
  configStore: {
    load(): Promise<Record<string, { enabled: boolean; config?: Record<string, unknown>; path?: string }>>;
    setEnabled(name: string, enabled: boolean): Promise<void>;
  };
  adapters: ChannelAdapterInfo[];
}

const MASK = '•••';

/** Mask config values whose schema property carries `sensitive: true`. */
export function maskPluginConfig(
  configSchema: Record<string, unknown> | undefined,
  config: Record<string, unknown>,
): Record<string, unknown> {
  const props = (configSchema?.properties ?? {}) as Record<string, { sensitive?: boolean }>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    out[key] = props[key]?.sensitive === true ? MASK : value;
  }
  return out;
}

/**
 * Mount /plugins, /plugins/:name, and /channels/adapters. Auth is the
 * caller's responsibility (the gateway management app applies its bearer
 * middleware before this is mounted — same DI pattern as
 * mountProjectsRoutes). IMPORTANT: the gateway must mount this BEFORE its
 * /channels/:name route so /channels/adapters wins the match.
 */
export function mountPluginsRoutes(app: Hono, deps: PluginsRoutesDeps): void {
  const toView = (
    record: PluginRecordLike,
    entries: Record<string, { enabled: boolean }>,
  ): PluginView => ({
    name: record.name,
    version: record.version,
    ...(record.description !== undefined ? { description: record.description } : {}),
    status: record.status,
    capabilities: record.capabilities,
    ...(record.failure ? { failure: record.failure } : {}),
    registrations: record.registrations,
    hookCounters: deps.hookBus.counters()[record.name] ?? {},
    ...(record.configSchema ? { configSchema: record.configSchema } : {}),
    ...(record.config ? { config: maskPluginConfig(record.configSchema, record.config) } : {}),
    enabled: entries[record.name]?.enabled ?? false,
  });

  app.get('/plugins', async (c) => {
    const entries = await deps.configStore.load();
    return c.json({ plugins: deps.registry.list().map((record) => toView(record, entries)) });
  });

  app.patch('/plugins/:name', async (c) => {
    const name = decodeURIComponent(c.req.param('name'));
    const record = deps.registry.get(name);
    if (!record) return c.json({ error: `unknown plugin: ${name}` }, 404);
    let body: { enabled?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    if (typeof body.enabled !== 'boolean') {
      return c.json({ error: 'enabled must be a boolean' }, 400);
    }
    await deps.configStore.setEnabled(name, body.enabled);
    const entries = await deps.configStore.load();
    // Enable/disable applies on gateway restart (no hot reload in v1).
    return c.json({ plugin: toView(record, entries), restartRequired: true });
  });

  app.get('/channels/adapters', (c) => c.json({ adapters: deps.adapters }));
}
```

- [ ] **Step 5: Export from `packages/management/src/index.ts`**

Add `PluginCapability`, `PluginHookCounters`, `PluginView`, `ChannelAdapterInfo` to the `export type { ... } from './types.js'` list, and after the projects-routes export line add:

```ts
export {
  mountPluginsRoutes,
  maskPluginConfig,
  type PluginRecordLike,
  type PluginsRoutesDeps,
} from './plugins-routes.js';
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run packages/management/src/plugins-routes.test.ts`
Expected: PASS (8 tests). Then `npx vitest run packages/management` — all green.

- [ ] **Step 7: Commit**

```bash
git add packages/management/src/types.ts packages/management/src/plugins-routes.ts \
  packages/management/src/index.ts packages/management/src/plugins-routes.test.ts
git commit -m "feat(management): add plugins routes and wire types"
```

---

### Task 13: @dash/management — ManagementClient plugin methods + InfoResponse summary

**Files:**
- Modify: `packages/management/src/types.ts` (`InfoResponse`, lines 14–16)
- Modify: `packages/management/src/client.ts` (imports lines 1–23; append methods)
- Test: `packages/management/src/client.plugins.test.ts` (new file — keeps the existing client.test.ts beforeEach untouched)

- [ ] **Step 1: Write the failing test**

Create `packages/management/src/client.plugins.test.ts`:

```ts
import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManagementClient } from './client.js';
import type { PluginView } from './types.js';

const TOKEN = 'plugins-test-token';

const view: PluginView = {
  name: 'audit-log',
  version: '0.3.0',
  status: 'loaded',
  capabilities: ['hooks'],
  registrations: { tools: 0, channels: 0, providers: 0, hooks: 2 },
  hookCounters: {},
  enabled: true,
};

describe('ManagementClient plugins methods', () => {
  let server: Server;
  let client: ManagementClient;
  const seenAuth: string[] = [];

  beforeEach(async () => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      seenAuth.push(c.req.header('Authorization') ?? '');
      await next();
    });
    app.get('/plugins', (c) => c.json({ plugins: [view] }));
    app.patch('/plugins/:name', async (c) => {
      const body = (await c.req.json()) as { enabled: boolean };
      return c.json({
        plugin: { ...view, name: c.req.param('name'), enabled: body.enabled },
        restartRequired: true,
      });
    });
    app.get('/channels/adapters', (c) =>
      c.json({ adapters: [{ name: 'telegram', builtIn: true }] }),
    );
    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () =>
        resolve(),
      ) as Server;
    });
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    client = new ManagementClient(`http://localhost:${port}`, TOKEN);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    seenAuth.length = 0;
  });

  it('listPlugins unwraps the plugins array and sends the bearer token', async () => {
    const plugins = await client.listPlugins();
    expect(plugins).toEqual([view]);
    expect(seenAuth[0]).toBe(`Bearer ${TOKEN}`);
  });

  it('setPluginEnabled PATCHes and returns plugin + restartRequired', async () => {
    const result = await client.setPluginEnabled('audit-log', false);
    expect(result.restartRequired).toBe(true);
    expect(result.plugin.enabled).toBe(false);
  });

  it('listChannelAdapters unwraps the adapters array', async () => {
    expect(await client.listChannelAdapters()).toEqual([{ name: 'telegram', builtIn: true }]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/management/src/client.plugins.test.ts`
Expected: FAIL — `listPlugins` does not exist on `ManagementClient`.

- [ ] **Step 3: Implement**

1. In `packages/management/src/types.ts`, replace `InfoResponse` (lines 14–16):

```ts
export interface InfoResponse {
  agents: AgentInfo[];
  /** Plugin summary (gateway /info). Absent on hosts without plugin support. */
  plugins?: Array<{ name: string; version: string; status: string }>;
}
```

2. In `packages/management/src/client.ts`, add `ChannelAdapterInfo` and `PluginView` to the type-import list, then append before the closing brace of the class (after the Inbox section):

```ts
  // --- Plugins ---

  async listPlugins(): Promise<PluginView[]> {
    const result = await this.request<{ plugins: PluginView[] }>('GET', '/plugins');
    return result.plugins;
  }

  async setPluginEnabled(
    name: string,
    enabled: boolean,
  ): Promise<{ plugin: PluginView; restartRequired: boolean }> {
    return this.requestWithBody<{ plugin: PluginView; restartRequired: boolean }>(
      'PATCH',
      `/plugins/${encodeURIComponent(name)}`,
      { enabled },
    );
  }

  async listChannelAdapters(): Promise<ChannelAdapterInfo[]> {
    const result = await this.request<{ adapters: ChannelAdapterInfo[] }>(
      'GET',
      '/channels/adapters',
    );
    return result.adapters;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/management`
Expected: PASS — 3 new tests; existing client/server tests unaffected (`InfoResponse.plugins` is optional).

- [ ] **Step 5: Commit**

```bash
git add packages/management/src/types.ts packages/management/src/client.ts \
  packages/management/src/client.plugins.test.ts
git commit -m "feat(management): add plugin methods to ManagementClient"
```

---

### Task 14: Gateway — plugin surfaces on the management API (mount, /providers, /info, models merge, credentials)

**Files:**
- Modify: `packages/models/src/types.ts` (`FilteredModel`, lines 20–27)
- Modify: `apps/gateway/src/models-route.ts` (options ~34–43; route handlers 129–156)
- Modify: `apps/gateway/src/management-api.ts` (options; mount + new routes)
- Test: `apps/gateway/src/management-api.plugins.test.ts` (new); `apps/gateway/src/models-route.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Create `apps/gateway/src/management-api.plugins.test.ts` (modeled on management-api.projects.test.ts but using `app.request`):

```ts
import { describe, expect, it } from 'vitest';
import { createGatewayManagementApp } from './management-api.js';
import type { GatewayManagementOptions } from './management-api.js';

const TOKEN = 'gw-token';
const AUTH = { Authorization: `Bearer ${TOKEN}` };

function makeApp(overrides: Partial<GatewayManagementOptions> = {}) {
  const entries: Record<string, { enabled: boolean }> = { 'groq-provider': { enabled: true } };
  const record = {
    name: 'groq-provider',
    version: '1.0.0',
    status: 'loaded' as const,
    capabilities: ['providers' as const],
    registrations: { tools: 0, channels: 0, providers: 1, hooks: 0 },
  };
  const credentialValues: Record<string, string> = {};
  const deps = {
    // biome-ignore lint/suspicious/noExplicitAny: stubs for unrelated subsystems
    gateway: {} as any,
    // biome-ignore lint/suspicious/noExplicitAny: stub
    agents: {} as any,
    agentRegistry: {
      list: () => [
        {
          id: 'a1',
          name: 'helper',
          status: 'registered',
          registeredAt: 'now',
          config: { name: 'helper', model: 'anthropic/claude-sonnet-4-5', systemPrompt: 'x' },
        },
      ],
      get: () => undefined,
      // biome-ignore lint/suspicious/noExplicitAny: stub
    } as any,
    // biome-ignore lint/suspicious/noExplicitAny: stub
    channelRegistry: { list: () => [], get: () => undefined } as any,
    credentialStore: {
      set: async (key: string, value: string) => {
        credentialValues[key] = value;
      },
      get: async (key: string) => credentialValues[key] ?? null,
      list: async () => Object.keys(credentialValues),
      delete: async () => {},
      readProviderApiKeys: async () => ({}),
      // biome-ignore lint/suspicious/noExplicitAny: stub
    } as any,
    modelsStore: {
      load: async () => ({
        models: [{ value: 'anthropic/claude-sonnet-4-5', label: 'Sonnet', provider: 'anthropic' }],
        fetchedAt: '2026-06-10T00:00:00Z',
        supportedModelsReviewedAt: '2026-06-01',
      }),
      save: async () => {},
      clear: async () => {},
      // biome-ignore lint/suspicious/noExplicitAny: stub
    } as any,
    token: TOKEN,
    pluginDeps: {
      routes: {
        registry: { list: () => [record], get: (n: string) => (n === record.name ? record : undefined) },
        hookBus: { counters: () => ({}) },
        configStore: {
          load: async () => entries,
          setEnabled: async (name: string, enabled: boolean) => {
            entries[name] = { enabled };
          },
        },
        adapters: [
          { name: 'telegram', builtIn: true },
          { name: 'discord', builtIn: false, pluginName: 'discord-channel' },
        ],
      },
      providers: [
        {
          id: 'groq',
          label: 'Groq',
          credentialPrefix: 'groq-api-key',
          source: 'plugin:groq-provider',
        },
      ],
      summaries: [{ name: 'groq-provider', version: '1.0.0', status: 'loaded' }],
      models: [
        {
          value: 'groq/llama-3.3-70b-versatile',
          label: 'Llama 3.3 70B',
          provider: 'groq',
          source: 'plugin:groq-provider',
        },
      ],
    },
    ...overrides,
  };
  // biome-ignore lint/suspicious/noExplicitAny: stub deps
  return { app: createGatewayManagementApp(deps as any), credentialValues };
}

describe('plugins routes mounting', () => {
  it('serves GET /plugins behind the bearer token', async () => {
    const { app } = makeApp();
    const res = await app.request('/plugins', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.plugins[0].name).toBe('groq-provider');
  });

  it('401s without the token', async () => {
    const { app } = makeApp();
    expect((await app.request('/plugins')).status).toBe(401);
  });

  it('serves /channels/adapters AHEAD of the /channels/:name param route', async () => {
    const { app } = makeApp();
    const res = await app.request('/channels/adapters', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.adapters.map((a: { name: string }) => a.name)).toEqual(['telegram', 'discord']);
  });

  it('PATCH /plugins/:name flips enabled with restartRequired', async () => {
    const { app } = makeApp();
    const res = await app.request('/plugins/groq-provider', {
      method: 'PATCH',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.restartRequired).toBe(true);
    expect(body.plugin.enabled).toBe(false);
  });
});

describe('GET /providers', () => {
  it('lists built-in providers plus plugin providers with source tags', async () => {
    const { app } = makeApp();
    const res = await app.request('/providers', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      providers: Array<{ id: string; credentialPrefix: string; source?: string }>;
    };
    const ids = body.providers.map((p) => p.id);
    expect(ids).toContain('anthropic');
    expect(ids).toContain('openai');
    expect(ids).toContain('google');
    const groq = body.providers.find((p) => p.id === 'groq');
    expect(groq).toEqual({
      id: 'groq',
      label: 'Groq',
      credentialPrefix: 'groq-api-key',
      source: 'plugin:groq-provider',
    });
    const anthropic = body.providers.find((p) => p.id === 'anthropic');
    expect(anthropic?.source).toBeUndefined();
  });

  it('serves only built-ins when no pluginDeps are configured', async () => {
    const { app } = makeApp({ pluginDeps: undefined });
    const res = await app.request('/providers', { headers: AUTH });
    const body = await res.json();
    expect(body.providers.some((p: { id: string }) => p.id === 'groq')).toBe(false);
  });
});

describe('GET /info', () => {
  it('includes agent and plugin summaries', async () => {
    const { app } = makeApp();
    const res = await app.request('/info', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agents).toEqual([
      { name: 'helper', model: 'anthropic/claude-sonnet-4-5', tools: [] },
    ]);
    expect(body.plugins).toEqual([{ name: 'groq-provider', version: '1.0.0', status: 'loaded' }]);
  });
});

describe('GET /models plugin merge', () => {
  it('appends plugin catalog models with their source tag', async () => {
    const { app } = makeApp();
    const res = await app.request('/models', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      models: Array<{ value: string; source?: string }>;
    };
    expect(body.models.map((m) => m.value)).toEqual([
      'anthropic/claude-sonnet-4-5',
      'groq/llama-3.3-70b-versatile',
    ]);
    expect(body.models[1].source).toBe('plugin:groq-provider');
    expect(body.models[0].source).toBeUndefined();
  });
});

describe('credentials accept arbitrary plugin prefixes', () => {
  it('stores keys under any credentialPrefix without provider validation', async () => {
    const { app, credentialValues } = makeApp();
    const res = await app.request('/credentials', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'groq-api-key:default', value: 'gk-1' }),
    });
    expect(res.status).toBe(201);
    expect(credentialValues['groq-api-key:default']).toBe('gk-1');
  });
});
```

Append to `apps/gateway/src/models-route.test.ts` (reuse its existing store/credential stubs if present; otherwise self-contained):

```ts
describe('plugin model merge', () => {
  it('appends pluginModels to stored responses', async () => {
    const route = createModelsRoute({
      store: {
        load: async () => ({
          models: [{ value: 'anthropic/claude-sonnet-4-5', label: 'Sonnet', provider: 'anthropic' }],
          fetchedAt: '2026-06-10T00:00:00Z',
          supportedModelsReviewedAt: '2026-06-01',
        }),
        save: async () => {},
        clear: async () => {},
        // biome-ignore lint/suspicious/noExplicitAny: stub store
      } as any,
      // biome-ignore lint/suspicious/noExplicitAny: stub credential store
      credentialStore: { readProviderApiKeys: async () => ({}) } as any,
      pluginModels: [
        { value: 'groq/qwq-32b', label: 'qwq-32b', provider: 'groq', source: 'plugin:groq-provider' },
      ],
    });
    const res = await route.request('/');
    const body = await res.json();
    expect(body.models).toHaveLength(2);
    expect(body.models[1]).toEqual({
      value: 'groq/qwq-32b',
      label: 'qwq-32b',
      provider: 'groq',
      source: 'plugin:groq-provider',
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run apps/gateway/src/management-api.plugins.test.ts apps/gateway/src/models-route.test.ts`
Expected: FAIL — `/plugins` 404, `/providers` 404, `/info` 404, no model merge, `pluginModels` option unknown.

- [ ] **Step 3: Add `source?` to `FilteredModel`**

In `packages/models/src/types.ts`, add to `FilteredModel` after `provider: string;`:

```ts
  /**
   * Provenance tag. Absent for curated provider-API models; the gateway
   * sets 'plugin:<name>' for models contributed by plugin provider
   * catalogs (merged at the /models route, never persisted to the store).
   */
  source?: string;
```

- [ ] **Step 4: Add the `pluginModels` merge to `models-route.ts`**

1. Extend `ModelsRouteOptions`:

```ts
  /**
   * Plugin catalog models appended (never persisted) to every response —
   * GET /models, POST /models/refresh, and the debug view. Built in
   * index.ts from loaded provider catalogs; dynamicModels providers list
   * their catalog models only.
   */
  pluginModels?: FilteredModel[];
```

2. In `createModelsRoute`, after `const discover = ...`:

```ts
  const pluginModels = options.pluginModels ?? [];
  const withPluginModels = (resp: ModelsRouteResponse): ModelsRouteResponse =>
    pluginModels.length === 0 ? resp : { ...resp, models: [...resp.models, ...pluginModels] };
```

3. Wrap the three response sites:
   - `app.get('/')` non-debug: `return c.json(withPluginModels(await getOrRefresh()));`
   - debug path: `const response = withPluginModels(await getOrRefresh());`
   - `app.post('/refresh')`: `return c.json(withPluginModels(await refreshNow()));`

(`refreshNow`/`getOrRefresh` stay untouched so `store.save()` never persists plugin entries.)

- [ ] **Step 5: Wire the management app**

In `apps/gateway/src/management-api.ts`:

1. Imports:

```ts
import { PROVIDERS } from '@dash/models';
import { mountPluginsRoutes } from '@dash/management';
import type { PluginsRoutesDeps } from '@dash/management';
import type { FilteredModel } from '@dash/models';
```

2. Extend `GatewayManagementOptions`:

```ts
  /**
   * Plugin surfaces, present only when the gateway loaded plugins
   * (index.ts builds these from the loader output + collision guard).
   * Everything here is plain data / structural — this module never
   * imports @dash/plugins.
   */
  pluginDeps?: {
    /** DI for mountPluginsRoutes (/plugins, /channels/adapters). */
    routes: PluginsRoutesDeps;
    /** Plugin provider entries appended to GET /providers. */
    providers: Array<{ id: string; label: string; credentialPrefix: string; source: string }>;
    /** Plugin summary for GET /info. */
    summaries: Array<{ name: string; version: string; status: string }>;
    /** Plugin catalog models appended to GET /models responses. */
    models: FilteredModel[];
  };
```

3. Mount the plugins routes immediately AFTER the auth middleware block (before the `// --- Health ---` section) — placement is load-bearing:

```ts
  // --- Plugin routes ---
  // Mounted BEFORE the channel routes so the static /channels/adapters
  // path is registered ahead of the /channels/:name param route and wins
  // the match. Bearer middleware above already guards these.
  if (options.pluginDeps) {
    mountPluginsRoutes(app, options.pluginDeps.routes);
  }
```

4. Add `GET /providers` right after the plugins mount (unconditional — built-ins always listed):

```ts
  // --- Provider listing ---
  // Drives MC's AI Providers page: built-in providers from @dash/models'
  // registry plus plugin provider catalogs (source: 'plugin:<name>'). Keys
  // are stored under `<credentialPrefix>:<name>` via the existing
  // /credentials routes, which accept arbitrary prefixes.
  app.get('/providers', (c) => {
    const builtIns = PROVIDERS.map((p) => ({
      id: p.id,
      label: p.label,
      credentialPrefix: p.credentialPrefix,
    }));
    return c.json({ providers: [...builtIns, ...(options.pluginDeps?.providers ?? [])] });
  });
```

5. Add `GET /info` next to it (the gateway management app had no /info route; this creates it with the `InfoResponse` shape plus the plugins summary):

```ts
  app.get('/info', (c) => {
    return c.json({
      agents: agentRegistry.list().map((entry) => ({
        name: entry.config.name,
        model: entry.config.model,
        tools: entry.config.tools ?? [],
      })),
      plugins: options.pluginDeps?.summaries ?? [],
    });
  });
```

6. Pass plugin models into the models route (line ~640):

```ts
  app.route(
    '/models',
    createModelsRoute({
      store: options.modelsStore,
      credentialStore,
      pluginModels: options.pluginDeps?.models,
    }),
  );
```

7. Credentials: verified — `POST /credentials` already accepts arbitrary keys (only `key`/`value` presence checks; the `/^[^:]+-api-key:/` regex is a cache-invalidation heuristic, not validation). No change; the new test pins this behavior.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run apps/gateway`
Expected: PASS — new plugins/providers/info/models tests plus all pre-existing gateway suites.

- [ ] **Step 7: Commit**

```bash
git add packages/models/src/types.ts apps/gateway/src/models-route.ts \
  apps/gateway/src/management-api.ts apps/gateway/src/management-api.plugins.test.ts \
  apps/gateway/src/models-route.test.ts
git commit -m "feat(gateway): expose plugins, providers, info and plugin models over the management API"
```

---

### Task 15: Gateway — load plugins at startup and wire everything (REQUIRES Plan 1 merged)

**Files:**
- Modify: `apps/gateway/package.json` (add `"@dash/plugins": "*"`)
- Modify: `apps/gateway/src/index.ts` (imports; plugin load after MCP ~line 90; registry reorder; gateway hooks ~100–107; channel restore 233–291; createBackend 125–218; management options 293–314; shutdown 366–380)

No new unit test — `main()` is composition-only and untested today; every helper it calls was tested in Tasks 6–14. Verification is `npm run build` + full suite + a manual smoke start.

- [ ] **Step 1: Add the dependency**

In `apps/gateway/package.json` dependencies, after `"@dash/projects": "*",` add:

```json
    "@dash/plugins": "*",
```

Run: `npm install` (must succeed — confirms Plan 1 is merged).

- [ ] **Step 2: Add imports to `apps/gateway/src/index.ts`**

```ts
import { readFile } from 'node:fs/promises';
import { PluginConfigStore, createModelCatalog, loadPlugins } from '@dash/plugins';
import { PROVIDERS } from '@dash/models';
import {
  ChannelFactoryRegistry,
  createBuiltinChannelFactories,
  wrapPluginChannelFactory,
} from './channel-factories.js';
import { restorePersistedChannels } from './channel-startup.js';
import {
  BUILTIN_TOOL_NAMES,
  applyBuiltinCollisionGuard,
  buildAgentHookRunner,
  buildPluginModels,
  buildPluginProviders,
  filterPluginTools,
  overrideRegistry,
  resolveCatalogOwners,
  resolvePluginProviderKeys,
} from './plugin-wiring.js';
```

- [ ] **Step 3: Load plugins after MCP setup (after line 90, before the gateway creation)**

```ts
  // --- Plugins ---
  // Loaded after the credential store + MCP setup and before the gateway,
  // coordinator, and channel instantiation so plugin tools, hooks, provider
  // catalogs, and channel factories are available to all of them. The
  // gateway ALWAYS starts: per-plugin failures are recorded in the plugin
  // registry, never thrown (Plan 1 loader contract).
  const gatewayPkg = JSON.parse(
    await readFile(resolve(__dirname, '../package.json'), 'utf-8'),
  ) as { version: string };
  const pluginConfigStore = new PluginConfigStore(dataDir);
  const pluginEntries = await pluginConfigStore.load();
  const loaded = await loadPlugins({
    pluginsDir: join(dataDir, 'plugins'),
    entries: pluginEntries,
    dashVersion: gatewayPkg.version,
    getCredential: async (key) => (await credentialStore.get(key)) ?? undefined,
    logger: {
      debug: (msg, data) => logger.debug(msg, data),
      info: (msg, data) => logger.info(msg, data),
      warn: (msg, data) => logger.warn(msg, data),
      error: (msg, data) => logger.error(msg, undefined, data),
    },
  });

  // Built-in collision guard: the loader can't know Dash built-ins, so the
  // gateway marks colliding plugins errored (failurePhase 'register') and
  // drops all their registrations. overrideRegistry projects those failures
  // onto the records served by GET /plugins and /info.
  const guard = applyBuiltinCollisionGuard({
    tools: loaded.tools,
    channelFactories: loaded.channelFactories,
    providerCatalogs: loaded.providerCatalogs,
    catalogOwners: resolveCatalogOwners(loaded.registry, loaded.providerCatalogs),
    builtins: {
      channelAdapters: ['telegram', 'whatsapp'],
      providerIds: PROVIDERS.map((p) => p.id),
      toolNames: BUILTIN_TOOL_NAMES,
    },
    log: (msg) => logger.warn(msg),
  });
  const pluginRegistry = overrideRegistry(loaded.registry, guard.errored);
  const catalogOwners = resolveCatalogOwners(pluginRegistry, guard.providerCatalogs);
  const modelCatalog = createModelCatalog(guard.providerCatalogs);
  const loadedSummary = pluginRegistry.list();
  if (loadedSummary.length > 0) {
    console.log(
      `[plugins] ${loadedSummary.filter((p) => p.status === 'loaded').length} loaded, ` +
        `${loadedSummary.filter((p) => p.status === 'error').length} errored, ` +
        `${loadedSummary.filter((p) => p.status === 'disabled').length} disabled`,
    );
  }
```

Note: `guard.providerCatalogs` are the loader's `ProviderCatalog` objects passed through generically, so `createModelCatalog(guard.providerCatalogs)` type-checks without casts. If TS narrows them to the structural `ProviderCatalogLike`, annotate the guard call with explicit generics: `applyBuiltinCollisionGuard<{ pluginName: string; factory: (config: Record<string, unknown>) => unknown; configSchema?: Record<string, unknown> }, ProviderCatalog>({ ... })`.

- [ ] **Step 4: Move the AgentRegistry block above the gateway and wire message hooks**

Move the `const registry = new AgentRegistry(...)` block (currently lines 109–124, including its comment and the `await registry.load()` + restored-count log) to BEFORE the `createDynamicGateway` call (currently line 100) — the hooks closure below reads it. Then replace the gateway creation:

```ts
  const gateway = createDynamicGateway({
    dataDir,
    resolveRouting: (name) => {
      const entry = channelRegistry.get(name);
      if (!entry) return null;
      return { globalDenyList: entry.globalDenyList, routing: entry.routing };
    },
    // Channel-path message hooks (per spec, MC chat-ws bypasses these).
    // The bridge maps the gateway's agentId (registry uuid) to config.name
    // for hook context — CONTRACT: hooks identify agents by config.name.
    hooks: {
      messageReceived: (event) =>
        loaded.hookBus.messageReceived(
          { message: event.message, channel: event.channel },
          { channel: event.channel },
        ),
      messageSending: (event) =>
        loaded.hookBus.messageSending(
          {
            conversationId: event.conversationId,
            content: event.content,
            channel: event.channel,
          },
          { channel: event.channel, agentName: registry.get(event.agentId)?.config.name },
        ),
    },
  });
```

- [ ] **Step 5: Update createBackend (lines 128–217)**

Inside `createBackend`, replace the credential provider:

```ts
      // Pull-based credential source: built-in provider keys from the
      // encrypted store, plus plugin provider keys keyed by catalog id
      // (with placeholderKey fallback for keyless locals — injected into
      // this in-memory map only, never written to the store).
      const credentialProvider = async (): Promise<Record<string, string>> => ({
        ...(await credentialStore.readProviderApiKeys()),
        ...(await resolvePluginProviderKeys(credentialStore, guard.providerCatalogs)),
      });
```

and replace the `new PiAgentBackend(...)` construction:

```ts
      // Plugin tools filtered by the agent's `plugins` assignment
      // (undefined = all), concatenated with the projects tools into the
      // backend's extraTools. CONTRACT: projects AND hooks identify this
      // agent by config.name (NOT the registry uuid used for chat routing).
      const pluginTools = filterPluginTools(guard.tools, agentConfig.plugins);
      const hookRunner = buildAgentHookRunner(loaded.hookBus, agentConfig.name);

      const backend: PiAgentBackend = new PiAgentBackend(
        {
          model: agentConfig.model,
          systemPrompt: agentConfig.systemPrompt,
          fallbackModels: agentConfig.fallbackModels,
          tools: agentConfig.tools,
          skills: agentConfig.skills,
        },
        credentialProvider,
        undefined,
        sessionDir,
        resolve(dataDir, 'skills', agentConfig.name),
        mcpManager,
        mcpConfigStore,
        mcpAgentContext,
        [
          ...pluginTools,
          ...createProjectsTools({
            db: projectsDb,
            getSessionId: () => backend.getCurrentSessionId(),
            getAgentId: () => agentConfig.name,
          }),
        ],
        { hookRunner, modelCatalog },
      );
      return backend;
```

(Preserve the existing projects CONTRACT comments when editing — fold them into the block above.)

- [ ] **Step 6: Replace the channel restore loop (lines 233–291)**

```ts
  // Channel adapter factories: built-ins first (first registration wins),
  // then plugin factories surviving the collision guard.
  const channelFactories = new ChannelFactoryRegistry();
  for (const factory of createBuiltinChannelFactories({
    credentialStore,
    channelRegistry,
    dataDir,
  })) {
    channelFactories.register(factory);
  }
  for (const [adapterName, entry] of guard.channelFactories) {
    const registered = channelFactories.register(
      wrapPluginChannelFactory({
        adapterName,
        pluginName: entry.pluginName,
        factory: entry.factory as (config: Record<string, unknown>) => ChannelAdapter,
        configSchema: entry.configSchema,
      }),
    );
    if (!registered) {
      logger.warn(
        `[plugins] channel adapter '${adapterName}' from plugin '${entry.pluginName}' collides with an existing adapter — keeping the existing one`,
      );
    }
  }

  // Restore persisted channels through the factories. Channels whose
  // adapter is unavailable (plugin disabled/uninstalled) or fails to
  // construct are marked errored — config preserved, gateway continues.
  const channelRuntimeStatus = await restorePersistedChannels({
    channelRegistry,
    factories: channelFactories,
    gateway,
    resolveAgentClient: (agentId) => {
      if (!registry.get(agentId)) return null;
      const bridgeClient: AgentClient = {
        chat(channelId: string, conversationId: string, text: string) {
          return agents.chat({ agentId, conversationId, channelId, text });
        },
      };
      return bridgeClient;
    },
    log: (msg) => console.log(msg),
  });
```

- [ ] **Step 7: Pass plugin surfaces to the management app (options object at line 294)**

Add to the `createGatewayManagementApp({ ... })` options:

```ts
    dataDir,
    channelFactories,
    channelRuntimeStatus,
    pluginDeps: {
      routes: {
        registry: pluginRegistry,
        hookBus: loaded.hookBus,
        configStore: pluginConfigStore,
        adapters: channelFactories.list().map((f) => ({
          name: f.name,
          builtIn: f.builtIn,
          ...(f.pluginName ? { pluginName: f.pluginName } : {}),
          ...(f.configSchema ? { configSchema: f.configSchema } : {}),
        })),
      },
      providers: buildPluginProviders(guard.providerCatalogs, catalogOwners),
      summaries: pluginRegistry
        .list()
        .map((p) => ({ name: p.name, version: p.version, status: p.status })),
      models: buildPluginModels(guard.providerCatalogs, catalogOwners),
    },
```

- [ ] **Step 8: Shutdown ordering**

In the `shutdown` function (lines 366–380), insert after `await gateway.stop();`:

```ts
    // Plugin onShutdown handlers (reverse load order, budgeted by the
    // loader) run after agents/channels stop but BEFORE the core stores
    // close so plugins can still flush state that touches credentials/data.
    await loaded.shutdown();
```

(Order: mcpManager.stop → agents.stop → gateway.stop → **loaded.shutdown()** → server closes → eventLogStore.close → projectsDb.db.close.)

- [ ] **Step 9: Verify**

Run: `npm run build && npm test`
Expected: clean build, all suites green.
Smoke: `npm run gateway -- --data-dir /tmp/dash-plugins-smoke` then `curl -s localhost:9300/health` (200), `curl -s -H "Authorization: Bearer <token>" localhost:9300/plugins` → `{"plugins":[]}`, `/providers` lists anthropic/openai/google, `/info` has `"plugins":[]`. Ctrl-C exits cleanly (shutdown path).

- [ ] **Step 10: Commit**

```bash
git add apps/gateway/package.json package-lock.json apps/gateway/src/index.ts
git commit -m "feat(gateway): load plugins at startup and wire them into agents and channels"
```

---

### Task 16: Final verification

- [ ] **Step 1: Full local gate**

Run: `npm run lint && npm run build && npm test`
Expected: all clean. Fix anything Biome flags with `npm run lint:fix` and re-run.

- [ ] **Step 2: Models freshness check (CLAUDE.md requirement — this plan touched model-selection surfaces)**

Run: `npm run models:check`
Expected: no stale warning. If `MODELS_REVIEWED_AT` is >30 days old, run `npm run models:audit:apply` before shipping and commit its changes separately.

- [ ] **Step 3: Push / PR**

This is a multi-package feature: per the project git workflow, the work should be on a feature branch with a PR against `main`. Verify every task committed only its own files, then open the PR.

---

## Self-review notes (kept in-plan for the executor)

1. **Hook coverage boundary:** pi-native filesystem tools (`read`/`bash`/`edit`/`write`/`grep`/`find`/`ls`) are passed to `createAgentSession({ tools })`, not `customTools`, and are NOT covered by tool-call hooks in v1. The pinned scope's wrapper covers ExtraTool + MCP + built-in *custom* tools; the spec's looser wording ("built-in, MCP, and extra tools uniformly") is interpreted per the pinned scope. Flagged for cross-review.
2. **MCP tools previously bypassed `wrap`** (piagent.ts 400–415) — fixed in Task 2 so coverage is uniform; the wrap is an identity adapter when no hookRunner exists, so this is behavior-neutral for non-plugin deployments.
3. **`agentName` in `hook_dropped`/`hook_cancelled` audit entries** is the routing rule's `agentId` (the existing `agentName` variable in handleMessage is already the id — pre-existing naming wart, unchanged). Hook *context* agentName is the real config.name, mapped in index.ts.
4. **WhatsApp dir unification** (Task 6): `POST /channels` previously created adapters against literal `data/whatsapp/<name>` while restart used `<dataDir>/whatsapp-sessions/<name>` — unified on the restart path; pairing data created via POST before this change will not be found (same situation as any restart today, so no migration).

---
