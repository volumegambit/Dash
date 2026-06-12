# Dash Plugins — Mission Control UI Implementation Plan (Plan 3 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the Dash plugin system in Mission Control: a **Settings → Plugins** page (status, capability badges, enable/disable toggles, failure detail, hook counters, read-only masked config, restart-required banner), a reusable **schema-driven config form** primitive, data-driven adapter picking + a generic plugin-channel setup flow in **Messaging Apps**, plugin provider credential cards in **AI Providers**, a per-agent **Plugins** assignment control on the agent detail page and deploy wizard, and a "plugin" tag in the model dropdowns. Extend the manual TEST_PLAN with Section 28 and amend Sections 3/5/15/18/20/22/24.

**Spec:** `docs/superpowers/specs/2026-06-10-dash-plugins-design.md` (MC sections). This plan renders the wire shapes that Plan 2 (gateway/agent/management surfaces) implements. **The PINNED CONTRACTS below are normative — do not deviate.**

**Architecture:** Mission Control is an Electron app. The renderer (React 19) never talks to the gateway directly — it calls `window.api.*` (the `MissionControlAPI` contextBridge surface in `apps/mission-control/src/shared/ipc.ts`). The main process (`apps/mission-control/src/main/ipc.ts`) owns clients to the gateway and forwards calls. Plugins follow the exact pattern the Projects feature established:

- Shared transport types in `apps/mission-control/src/shared/plugins-ipc.ts` with must-match comments (mirrors `projects-ipc.ts`).
- Main-process `ipcMain.handle` handlers using the existing `getDirectManagementClient(feature)` factory (see `getProjectsClient` / `getMcpClient` at `src/main/ipc.ts:860` / `:814`), calling `@dash/management` `ManagementClient` methods that **Plan 2 implements** (`listPlugins`, `setPluginEnabled`, `listChannelAdapters`, plus the extended provider listing).
- Preload wires `pluginsList` / `pluginsSetEnabled` / `channelsListAdapters` / `providersList` onto `window.api` (naming convention: `<domain><Verb>` like `projectsListProjects`, `channelsList`).
- Renderer state in a Zustand 5 store `stores/plugins.ts` (template: `stores/projects.ts`).
- Routing: TanStack Router file-based routes. `routeTree.gen.ts` is auto-generated — never hand-edit it; it regenerates on `npm run mc:dev` / `mc:build`.
- Styling: Tailwind v4 with the project's CSS variables (`bg-surface`, `border-border`, `text-muted`, `text-accent`, `bg-card-bg`, `bg-sidebar-hover`, `bg-green-tint text-green`, `bg-red-tint text-red`, `font-[family-name:var(--font-mono)]` — copy from existing routes, do not invent tokens). Icons: lucide-react.
- Tests: Vitest (globals enabled) + jsdom + @testing-library/react. Config: root `vitest.config.ts`; setup `apps/mission-control/vitest.setup.ts` (mocks `window.api` — its `Record<keyof MissionControlAPI, …>` type forces mock exhaustiveness).

**Tech Stack:** React 19, TanStack Router 1 (file-based), Zustand 5, Tailwind v4, lucide-react, electron-vite, Vitest + @testing-library/react.

---

## Cross-plan reconciliation needed (cross-reviewer: check these against Plan 2)

These are the only places where this plan had to fix a wire detail the pinned contracts leave open. Each is marked inline at the task that uses it. **Flag mismatches, don't silently adapt.**

1. **Provider listing endpoint + client method name.** Pinned: "existing endpoint, extended" with entry shape `{ id, label, credentialPrefix, source? }`. MC currently has NO provider-listing fetch (the AI Providers page renders a static `PROVIDERS` array in `src/renderer/src/components/providers.ts`). This plan assumes `ManagementClient.listProviders(): Promise<ProviderListingEntry[]>` against `GET /providers`. If Plan 2 named the method differently or hung the entries off another endpoint (e.g. `/models?debug=true`), adapt ONLY the main-process handler in Task 4 — the shared type and all renderer code stay unchanged.
2. **Plugin channel config on channel CRUD.** The channel factory receives validated channel config, so `POST /channels` must carry it. This plan extends the existing `channels:create` IPC + `GatewayManagementClient.registerChannel` body with `config?: Record<string, unknown>`. Plan 2 must accept a `config` field on `POST /channels` (validate against the adapter's configSchema, persist). Field name `config` is this plan's choice — reconcile.
3. **Errored-channel wire shape.** Spec: "Missing factory at startup → channel marked errored with reason, config preserved, visible in MC." Not pinned. This plan adds optional `status?: 'active' | 'error'` and `error?: string` to `GatewayChannel` (in `packages/mc/src/runtime/gateway-client.ts`) and renders them defensively (absent ⇒ behave exactly as today). Reconcile field names with Plan 2's `GET /channels` payload.
4. **Reset-to-all plugins wire encoding.** `plugins?: string[]` — unset = all. To go from a subset back to "all", the agent-update patch must *delete* the field. This plan sends `{ plugins: null }` in the `PUT /agents/:id` patch and expects the gateway to clear the field on explicit `null`. Reconcile with Plan 2's agent routes.
5. **`listPlugins()` return shape.** Pinned IPC: `plugins:list → PluginView[]` while the HTTP envelope is `{ plugins: PluginView[] }`. This plan assumes the client method unwraps the envelope and returns `PluginView[]` (same for `listChannelAdapters` unwrapping `{ adapters }`). If Plan 2's methods return envelopes, unwrap in the Task 4 handlers.

**Prerequisite:** Plan 2's `@dash/management` client methods must exist before Task 4 compiles. If executing before Plan 2 lands, Task 4 includes fallback client-method code (matching the pinned wire contract exactly) with a marker comment so cross-review can dedupe.

---

## PINNED CONTRACTS (Plan 2 implements these — render them verbatim)

```ts
// GET /plugins → { plugins: PluginView[] }   (IPC: plugins:list → PluginView[])
interface PluginView {
  name: string; version: string; description?: string;
  status: 'loaded' | 'disabled' | 'error';
  capabilities: Array<'tools' | 'channels' | 'providers' | 'hooks'>;
  failure?: { phase: 'manifest' | 'compat' | 'config' | 'import' | 'register'; error: string; failedAt: string };
  registrations: { tools: number; channels: number; providers: number; hooks: number };
  hookCounters: Partial<Record<string, { fired: number; modified: number; blocked: number; failed: number; timedOut: number }>>;
  configSchema?: Record<string, unknown>;
  config?: Record<string, unknown>;    // sensitive fields ALREADY masked to '•••' by the API
  enabled: boolean;
}
// PATCH /plugins/:name { enabled: boolean } → { plugin: PluginView, restartRequired: true }
//   (IPC: plugins:setEnabled(name, enabled) → { plugin: PluginView; restartRequired: boolean })
// GET /channels/adapters → { adapters: ChannelAdapterInfo[] }  (IPC: channels:listAdapters → ChannelAdapterInfo[])
interface ChannelAdapterInfo {
  name: string;            // adapter key, e.g. 'telegram', 'discord'
  builtIn: boolean;
  pluginName?: string;     // set when builtIn === false
  configSchema?: Record<string, unknown>;  // JSON Schema; string props may carry sensitive: true, title, description
}
// Provider listing entries (existing endpoint, extended): plugin providers carry
//   { id, label, credentialPrefix, source: 'plugin:<name>' } — built-ins have no `source`.
// GET /models items: optional `source?: string` ('plugin:<name>').
// Hook names for the counters table: 'message_received' | 'before_tool_call' | 'after_tool_call'
//   | 'message_sending' | 'agent_run_start' | 'agent_run_end'.
// Agent config field (agent routes, Plan 2): plugins?: string[] — unset = all plugin tools; [] = none;
//   CONTRACT: plugin identity = plugin name (manifest name).
```

Behavioral notes from the spec:
1. **NO plugin config editing in MC v1** — the Plugins page shows config read-only (the API masks `sensitive` values to `'•••'` before they reach MC). Exception: plugin **channel** config rides the existing channel CRUD.
2. Enable/disable takes effect on gateway **restart** — always raise the restart-required banner after a toggle.
3. Discovered-but-not-configured plugins arrive as `status: 'disabled'` with `enabled: false`.
4. Empty state: "No plugins installed. Drop a plugin into `<dataDir>/plugins/` and enable it here." (`dataDir` from `window.api.logsPaths().dataDir`, which is the gateway data dir — `src/main/ipc.ts` passes the same `DATA_DIR` to both supervisor and logs).

**Known codebase facts the executor should not "fix":** `apps/mission-control/src/shared/ipc.test.ts` is stale (it references long-removed `deployments*`/`secrets*` methods and passes only because esbuild strips types without checking). Do not pattern new tests on it and do not repair it in this plan — runtime contract tests follow the `stores/projects.test.ts` style instead. Similarly, `stores/messaging-apps.ts` imports `GatewayChannel` from `'../../../shared/ipc.js'` (not actually re-exported there) — leave that import alone.

**Build note (load-bearing):** the root `vitest.config.ts` aliases `@dash/mc` to `packages/mc/dist/index.js`. After ANY change to `packages/mc/src`, run `npm run build` (root) before running MC tests, or the tests exercise stale types/code.

---

## Task 1 — Shared plugins IPC types

**Files:**
- Create: `apps/mission-control/src/shared/plugins-ipc.ts`
- Test: `apps/mission-control/src/shared/plugins-ipc.test.ts`

Steps:

- [ ] Write the FAILING test `apps/mission-control/src/shared/plugins-ipc.test.ts`:

```ts
import type {
  ChannelAdapterInfo,
  PluginView,
  ProviderListingEntry,
  SetPluginEnabledResult,
} from './plugins-ipc.js';
import { HOOK_NAMES } from './plugins-ipc.js';

// Contract tests: sample literals typed against the interfaces. If Plan 2's
// wire shapes drift from these, fix Plan 2 or escalate — these mirror the
// pinned contracts verbatim.
describe('plugins IPC contract', () => {
  it('PluginView accepts the full wire shape', () => {
    const plugin: PluginView = {
      name: 'discord-channel',
      version: '0.1.0',
      description: 'Discord channel adapter',
      status: 'error',
      capabilities: ['channels', 'hooks'],
      failure: { phase: 'config', error: 'botToken is required', failedAt: '2026-06-10T00:00:00Z' },
      registrations: { tools: 0, channels: 1, providers: 0, hooks: 2 },
      hookCounters: {
        before_tool_call: { fired: 3, modified: 1, blocked: 0, failed: 0, timedOut: 0 },
      },
      configSchema: { type: 'object', properties: {} },
      config: { botToken: '•••' },
      enabled: true,
    };
    expect(plugin.status).toBe('error');
    expect(plugin.failure?.phase).toBe('config');
  });

  it('minimal PluginView omits all optional fields', () => {
    const plugin: PluginView = {
      name: 'audit-log',
      version: '1.0.0',
      status: 'disabled',
      capabilities: ['hooks'],
      registrations: { tools: 0, channels: 0, providers: 0, hooks: 0 },
      hookCounters: {},
      enabled: false,
    };
    expect(plugin.enabled).toBe(false);
  });

  it('SetPluginEnabledResult carries plugin + restartRequired', () => {
    const result: SetPluginEnabledResult = {
      plugin: {
        name: 'a',
        version: '1.0.0',
        status: 'loaded',
        capabilities: ['tools'],
        registrations: { tools: 1, channels: 0, providers: 0, hooks: 0 },
        hookCounters: {},
        enabled: false,
      },
      restartRequired: true,
    };
    expect(result.restartRequired).toBe(true);
  });

  it('ChannelAdapterInfo distinguishes built-ins from plugin adapters', () => {
    const builtIn: ChannelAdapterInfo = { name: 'telegram', builtIn: true };
    const fromPlugin: ChannelAdapterInfo = {
      name: 'discord',
      builtIn: false,
      pluginName: 'discord-channel',
      configSchema: {
        type: 'object',
        properties: { botToken: { type: 'string', sensitive: true, title: 'Bot token' } },
        required: ['botToken'],
      },
    };
    expect(builtIn.pluginName).toBeUndefined();
    expect(fromPlugin.pluginName).toBe('discord-channel');
  });

  it('ProviderListingEntry: built-ins have no source, plugin providers do', () => {
    const builtIn: ProviderListingEntry = {
      id: 'anthropic',
      label: 'Anthropic',
      credentialPrefix: 'anthropic-api-key',
    };
    const fromPlugin: ProviderListingEntry = {
      id: 'groq',
      label: 'Groq',
      credentialPrefix: 'groq-api-key',
      source: 'plugin:groq-provider',
    };
    expect(builtIn.source).toBeUndefined();
    expect(fromPlugin.source).toBe('plugin:groq-provider');
  });

  it('HOOK_NAMES lists the six hooks in dispatch order', () => {
    expect(HOOK_NAMES).toEqual([
      'message_received',
      'before_tool_call',
      'after_tool_call',
      'message_sending',
      'agent_run_start',
      'agent_run_end',
    ]);
  });
});
```

- [ ] Run: `npx vitest run apps/mission-control/src/shared/plugins-ipc.test.ts` → FAILS (module not found).
- [ ] Create `apps/mission-control/src/shared/plugins-ipc.ts` with the COMPLETE content below.

```ts
// apps/mission-control/src/shared/plugins-ipc.ts
//
// Transport types for the Plugins IPC surface. These MUST match the wire
// shapes served by the gateway's management routes (Plan 2,
// packages/management — plugins routes + channel adapters + provider listing):
//   - PluginView / SetPluginEnabledResult — GET /plugins, PATCH /plugins/:name
//   - ChannelAdapterInfo                  — GET /channels/adapters
//   - ProviderListingEntry                — provider listing (existing endpoint, extended)
// Keep field names byte-identical; MC renders these verbatim. Pure types +
// one const, no other runtime.

/** The six lifecycle hooks, in dispatch-table order. Used as the row order of
 *  the hook-counters table on the Plugins page. */
export const HOOK_NAMES = [
  'message_received',
  'before_tool_call',
  'after_tool_call',
  'message_sending',
  'agent_run_start',
  'agent_run_end',
] as const;

export type HookName = (typeof HOOK_NAMES)[number];

export interface PluginHookCounter {
  fired: number;
  modified: number;
  blocked: number;
  failed: number;
  timedOut: number;
}

export type PluginCapability = 'tools' | 'channels' | 'providers' | 'hooks';

export type PluginFailurePhase = 'manifest' | 'compat' | 'config' | 'import' | 'register';

/** GET /plugins → { plugins: PluginView[] }. IPC plugins:list returns PluginView[]. */
export interface PluginView {
  name: string;
  version: string;
  description?: string;
  status: 'loaded' | 'disabled' | 'error';
  capabilities: PluginCapability[];
  failure?: { phase: PluginFailurePhase; error: string; failedAt: string };
  registrations: { tools: number; channels: number; providers: number; hooks: number };
  /** Keyed by HookName (string-keyed on the wire). Only registered hooks appear. */
  hookCounters: Partial<Record<string, PluginHookCounter>>;
  configSchema?: Record<string, unknown>;
  /** Sensitive fields ALREADY masked to '•••' by the API — render as-is, never editable. */
  config?: Record<string, unknown>;
  enabled: boolean;
}

/** PATCH /plugins/:name { enabled } response. restartRequired is always true
 *  on today's wire; typed boolean so MC keys behavior off the field, not the
 *  assumption. */
export interface SetPluginEnabledResult {
  plugin: PluginView;
  restartRequired: boolean;
}

/** GET /channels/adapters → { adapters: ChannelAdapterInfo[] }.
 *  IPC channels:listAdapters returns ChannelAdapterInfo[]. */
export interface ChannelAdapterInfo {
  /** Adapter key, e.g. 'telegram', 'discord'. */
  name: string;
  builtIn: boolean;
  /** Set when builtIn === false. */
  pluginName?: string;
  /** JSON Schema (object type); string props may carry sensitive: true, title, description. */
  configSchema?: Record<string, unknown>;
}

/** Provider listing entry (existing endpoint, extended by Plan 2).
 *  Built-ins have no `source`; plugin providers carry source: 'plugin:<name>'. */
export interface ProviderListingEntry {
  id: string;
  label: string;
  /** Credential key prefix, e.g. 'groq-api-key'. Keys are stored as `${credentialPrefix}:<label>`. */
  credentialPrefix: string;
  source?: string; // 'plugin:<name>'
}
```

- [ ] Run: `npx vitest run apps/mission-control/src/shared/plugins-ipc.test.ts` → PASSES.
- [ ] Commit: `git add apps/mission-control/src/shared/plugins-ipc.ts apps/mission-control/src/shared/plugins-ipc.test.ts && git commit -m "mc(plugins): shared IPC contract types"`

---

## Task 2 — `@dash/mc` wire-type extensions (TDD)

**Files:**
- Modify: `packages/mc/src/runtime/gateway-client.ts`
- Test: `packages/mc/src/runtime/gateway-client.test.ts`

Steps:

- [ ] Add FAILING tests to `packages/mc/src/runtime/gateway-client.test.ts` (append a new `describe`; reuse the file's existing fetch-stubbing helpers if present, otherwise use `vi.stubGlobal` as below):

```ts
describe('registerChannel plugin config passthrough', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('includes config in the POST /channels body when provided', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new GatewayManagementClient('http://127.0.0.1:9100', 'tok');
    await client.registerChannel({
      name: 'disc-1',
      adapter: 'discord',
      config: {        botToken: 'x',
        guildId: 'g',
      },
      globalDenyList: [],
      routing: [],
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:9100/channels');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.adapter).toBe('discord');
    expect(body.config).toEqual({ botToken: 'x', guildId: 'g' });
  });

  it('omits config from the body when not provided', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new GatewayManagementClient('http://127.0.0.1:9100', 'tok');
    await client.registerChannel({
      name: 'tg-1',
      adapter: 'telegram',
      globalDenyList: [],
      routing: [],
    });
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect('config' in body).toBe(false);
  });
});
```

- [ ] Run: `npx vitest run packages/mc` → the new describe FAILS (type error on `config` — esbuild won't fail on the type alone, so the first test fails on the body assertion only after the implementation; treat the type-level red as the signal and proceed).
- [ ] Apply ALL of the following edits to `packages/mc/src/runtime/gateway-client.ts`:

1. `GatewayAgent.config` — add after `mcpServers?: string[];`:

```ts
    /** Plugin-tool assignment. unset = all plugin tools; [] = none.
     *  Plugin identity = plugin name (manifest name). See plugins spec. */
    plugins?: string[];
```

2. `CreateAgentRequest` — add after `mcpServers?: string[];`:

```ts
  plugins?: string[];
```

3. `GatewayChannel` — change `adapter: 'telegram' | 'whatsapp';` to:

```ts
  /** Adapter key. Built-ins: 'telegram' | 'whatsapp'; plugin adapters widen this to any string. */
  adapter: string;
  /** RECONCILE WITH PLAN 2 (errored-channel wire shape): set when the
   *  channel's adapter factory is missing at startup (plugin disabled or
   *  uninstalled). Absent on healthy channels — render defensively. */
  status?: 'active' | 'error';
  error?: string;
```

4. `GatewayModel` — add after `provider: string;`:

```ts
  /** Provenance tag for plugin catalog models: 'plugin:<name>'. Absent on built-ins. */
  source?: string;
```

5. `registerChannel` — add `config?: Record<string, unknown>;` to the parameter type, after `adapter: string;`. The body already does `JSON.stringify(config)` of the whole object, so no further change:

```ts
  async registerChannel(config: {
    name: string;
    adapter: string;
    config?: Record<string, unknown>;
    globalDenyList?: string[];
    allowedUsers?: string[];
    routing: GatewayChannel['routing'];
  }): Promise<void> {
```

- [ ] Run: `npx vitest run packages/mc` → PASSES.
- [ ] Run: `npm run build` (root — required: vitest aliases `@dash/mc` to `packages/mc/dist`).
- [ ] Commit: `git add packages/mc/src/runtime/gateway-client.ts packages/mc/src/runtime/gateway-client.test.ts && git commit -m "mc: plugin fields on gateway wire types (plugins, adapter widening, model source, channel config)"`

---

## Task 3 — `MissionControlAPI` + preload + test mocks

**Files:**
- Modify: `apps/mission-control/src/shared/ipc.ts`
- Modify: `apps/mission-control/src/preload/index.ts`
- Modify: `apps/mission-control/vitest.setup.ts`

Steps:

- [ ] In `apps/mission-control/src/shared/ipc.ts`, add below the existing `projects-ipc.js` import block:

```ts
import type {
  ChannelAdapterInfo,
  PluginView,
  ProviderListingEntry,
  SetPluginEnabledResult,
} from './plugins-ipc.js';
```

- [ ] In the `MissionControlAPI` interface, widen `channelsCreate`'s config parameter (add `config?: Record<string, unknown>;` after `token?: string;`):

```ts
  channelsCreate(config: {
    name: string;
    adapter: string;
    token?: string;
    config?: Record<string, unknown>;
    globalDenyList?: string[];
    routing: GatewayChannel['routing'];
  }): Promise<void>;
```

- [ ] Add `channelsListAdapters` directly after `channelsVerifyTelegramToken` in the Channels block:

```ts
  channelsListAdapters(): Promise<ChannelAdapterInfo[]>;
```

- [ ] Add a new block before the closing brace of the interface (after the Projects events block):

```ts
  // Plugins (gateway passthrough)
  pluginsList(): Promise<PluginView[]>;
  pluginsSetEnabled(name: string, enabled: boolean): Promise<SetPluginEnabledResult>;

  // Providers (gateway passthrough; built-ins + plugin providers)
  providersList(): Promise<ProviderListingEntry[]>;
```

- [ ] In `apps/mission-control/src/preload/index.ts`, add after `channelsVerifyTelegramToken`:

```ts
  channelsListAdapters: () => ipcRenderer.invoke('channels:listAdapters'),
```

and after the Projects block (before the closing `};` of `api`):

```ts
  // Plugins
  pluginsList: () => ipcRenderer.invoke('plugins:list'),
  pluginsSetEnabled: (name, enabled) => ipcRenderer.invoke('plugins:setEnabled', name, enabled),

  // Providers
  providersList: () => ipcRenderer.invoke('providers:list'),
```

- [ ] In `apps/mission-control/vitest.setup.ts`, add inside `createMockApi()` (after the Projects mocks — the `Record<keyof MissionControlAPI, …>` return type fails compilation until all four exist):

```ts
    // Plugins (gateway passthrough)
    pluginsList: vi.fn().mockResolvedValue([]),
    pluginsSetEnabled: vi.fn().mockResolvedValue({ plugin: null, restartRequired: true }),

    // Channels — adapter registry
    channelsListAdapters: vi.fn().mockResolvedValue([
      { name: 'telegram', builtIn: true },
      { name: 'whatsapp', builtIn: true },
    ]),

    // Providers
    providersList: vi.fn().mockResolvedValue([]),
```

- [ ] Verify: `npx vitest run apps/mission-control` → all existing tests still pass.
- [ ] Commit: `git add apps/mission-control/src/shared/ipc.ts apps/mission-control/src/preload/index.ts apps/mission-control/vitest.setup.ts && git commit -m "mc(plugins): IPC contract, preload wiring, test mocks"`

---

## Task 4 — Main-process IPC handlers

**Files:**
- Modify: `apps/mission-control/src/main/ipc.ts`
- Modify (fallback only): `packages/management/src/client.ts`, `packages/management/src/types.ts`

Steps:

- [ ] Check whether `packages/management/src/client.ts` already has `listPlugins` / `setPluginEnabled` / `listChannelAdapters` / `listProviders` (Plan 2). **If yes, skip the next step.**
- [ ] FALLBACK (only if Plan 2 absent — RECONCILE: delete on merge if Plan 2 added equivalents). Append to `packages/management/src/types.ts`:

```ts
// --- Plugins (FALLBACK for MC UI plan 2026-06-10 — DELETE if Plan 2 added these) ---

export interface PluginView {
  name: string;
  version: string;
  description?: string;
  status: 'loaded' | 'disabled' | 'error';
  capabilities: Array<'tools' | 'channels' | 'providers' | 'hooks'>;
  failure?: {
    phase: 'manifest' | 'compat' | 'config' | 'import' | 'register';
    error: string;
    failedAt: string;
  };
  registrations: { tools: number; channels: number; providers: number; hooks: number };
  hookCounters: Partial<
    Record<string, { fired: number; modified: number; blocked: number; failed: number; timedOut: number }>
  >;
  configSchema?: Record<string, unknown>;
  config?: Record<string, unknown>;
  enabled: boolean;
}

export interface ChannelAdapterInfo {
  name: string;
  builtIn: boolean;
  pluginName?: string;
  configSchema?: Record<string, unknown>;
}

export interface ProviderListingEntry {
  id: string;
  label: string;
  credentialPrefix: string;
  source?: string;
}
```

and append to `ManagementClient` in `packages/management/src/client.ts` (import the three types; RECONCILIATION POINTS 1 + 5 live here):

```ts
  // --- Plugins (FALLBACK for MC UI plan 2026-06-10 — DELETE if Plan 2 added these) ---

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

  // RECONCILE WITH PLAN 2: endpoint path + method name for the extended
  // provider listing. Entry shape is pinned; the path is this plan's choice.
  async listProviders(): Promise<ProviderListingEntry[]> {
    const result = await this.request<{ providers: ProviderListingEntry[] }>('GET', '/providers');
    return result.providers;
  }
```

- [ ] In `apps/mission-control/src/main/ipc.ts`, insert after the Projects handler block (after `projects:markInboxRead`, before the WhatsApp pairing section):

```ts
  // -----------------------------------------------------------------------
  // Plugins
  // -----------------------------------------------------------------------

  const getPluginsClient = (): Promise<ManagementClient> => getDirectManagementClient('Plugins');

  ipcMain.handle('plugins:list', async () => (await getPluginsClient()).listPlugins());
  ipcMain.handle('plugins:setEnabled', async (_e, name: string, enabled: boolean) =>
    (await getPluginsClient()).setPluginEnabled(name, enabled),
  );
  ipcMain.handle('channels:listAdapters', async () =>
    (await getPluginsClient()).listChannelAdapters(),
  );
  ipcMain.handle('providers:list', async () => (await getPluginsClient()).listProviders());
```

- [ ] Update the `channels:create` handler (currently at `src/main/ipc.ts:440`) to accept and forward `config` (RECONCILIATION POINT 2). Replace the handler with:

```ts
  ipcMain.handle(
    'channels:create',
    async (
      _e,
      config: {
        name: string;
        adapter: string;
        token?: string;
        config?: Record<string, unknown>;
        globalDenyList?: string[];
        routing: GatewayChannel['routing'];
      },
    ) => {
      const client = await getClient(gw);
      // If token provided (built-in Telegram path), store as credential first
      if (config.token) {
        await client.setCredential(`channel:${config.name}:token`, config.token);
      }
      await client.registerChannel({
        name: config.name,
        adapter: config.adapter,
        config: config.config,
        globalDenyList: config.globalDenyList ?? [],
        routing: config.routing,
      });
    },
  );
```

- [ ] Verify build: `npm run build`.
- [ ] Commit: `git add apps/mission-control/src/main/ipc.ts packages/management/src/client.ts packages/management/src/types.ts && git commit -m "mc(plugins): main-process IPC handlers via direct management client"` (drop the management files from the add if the fallback was skipped).

---

## Task 5 — Renderer plugins store (TDD)

**Files:**
- Create: `apps/mission-control/src/renderer/src/stores/plugins.ts`
- Test: `apps/mission-control/src/renderer/src/stores/plugins.test.ts`

Steps:

- [ ] Write the FAILING tests `apps/mission-control/src/renderer/src/stores/plugins.test.ts`:

```ts
import { mockApi } from '../../../../vitest.setup.js';
import type { PluginView } from '../../../shared/plugins-ipc.js';
import { usePluginsStore } from './plugins.js';

function plugin(name: string, patch: Partial<PluginView> = {}): PluginView {
  return {
    name,
    version: '1.0.0',
    status: 'loaded',
    capabilities: ['tools'],
    registrations: { tools: 1, channels: 0, providers: 0, hooks: 0 },
    hookCounters: {},
    enabled: true,
    ...patch,
  };
}

beforeEach(() => {
  usePluginsStore.setState({
    plugins: [],
    adapters: [],
    loading: false,
    error: null,
    restartRequired: false,
  });
});

describe('usePluginsStore.load', () => {
  it('loads plugins from the IPC surface', async () => {
    mockApi.pluginsList.mockResolvedValue([
      plugin('a'),
      plugin('b', { status: 'disabled', enabled: false }),
    ]);
    await usePluginsStore.getState().load();
    const s = usePluginsStore.getState();
    expect(s.plugins.map((p) => p.name)).toEqual(['a', 'b']);
    expect(s.loading).toBe(false);
    expect(s.error).toBeNull();
  });

  it('captures the error message on failure', async () => {
    mockApi.pluginsList.mockRejectedValue(new Error('gateway down'));
    await usePluginsStore.getState().load();
    expect(usePluginsStore.getState().error).toBe('gateway down');
    expect(usePluginsStore.getState().loading).toBe(false);
  });
});

describe('usePluginsStore.setEnabled', () => {
  it('optimistically flips enabled, then applies the server plugin and sets restartRequired', async () => {
    usePluginsStore.setState({ plugins: [plugin('a', { enabled: true })] });
    let resolve: (v: { plugin: PluginView; restartRequired: boolean }) => void = () => {};
    mockApi.pluginsSetEnabled.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const done = usePluginsStore.getState().setEnabled('a', false);
    // optimistic flip is visible before the IPC resolves
    expect(usePluginsStore.getState().plugins[0].enabled).toBe(false);
    expect(usePluginsStore.getState().restartRequired).toBe(false);
    resolve({ plugin: plugin('a', { enabled: false }), restartRequired: true });
    await done;
    expect(usePluginsStore.getState().plugins[0].enabled).toBe(false);
    expect(usePluginsStore.getState().restartRequired).toBe(true);
    expect(mockApi.pluginsSetEnabled).toHaveBeenCalledWith('a', false);
  });

  it('reverts the optimistic flip and records the error on failure', async () => {
    usePluginsStore.setState({ plugins: [plugin('a', { enabled: true })] });
    mockApi.pluginsSetEnabled.mockRejectedValue(new Error('nope'));
    await usePluginsStore.getState().setEnabled('a', false);
    const s = usePluginsStore.getState();
    expect(s.plugins[0].enabled).toBe(true);
    expect(s.error).toBe('nope');
    expect(s.restartRequired).toBe(false);
  });
});

describe('usePluginsStore.loadAdapters', () => {
  it('loads channel adapters', async () => {
    mockApi.channelsListAdapters.mockResolvedValue([
      { name: 'telegram', builtIn: true },
      { name: 'discord', builtIn: false, pluginName: 'discord-channel' },
    ]);
    await usePluginsStore.getState().loadAdapters();
    expect(usePluginsStore.getState().adapters).toHaveLength(2);
  });
});

describe('usePluginsStore.clearRestartRequired', () => {
  it('clears the flag', () => {
    usePluginsStore.setState({ restartRequired: true });
    usePluginsStore.getState().clearRestartRequired();
    expect(usePluginsStore.getState().restartRequired).toBe(false);
  });
});
```

- [ ] Run: `npx vitest run apps/mission-control/src/renderer/src/stores/plugins.test.ts` → FAILS.
- [ ] Create `apps/mission-control/src/renderer/src/stores/plugins.ts`:

```ts
import { create } from 'zustand';
import type { ChannelAdapterInfo, PluginView } from '../../../shared/plugins-ipc.js';

interface PluginsState {
  plugins: PluginView[];
  adapters: ChannelAdapterInfo[];
  loading: boolean;
  error: string | null;
  /** Set after any successful enable/disable toggle. Cleared only when the
   *  gateway is restarted (see clearRestartRequired). */
  restartRequired: boolean;

  load(): Promise<void>;
  loadAdapters(): Promise<void>;
  setEnabled(name: string, enabled: boolean): Promise<void>;
  clearRestartRequired(): void;
}

export const usePluginsStore = create<PluginsState>((set, get) => ({
  plugins: [],
  adapters: [],
  loading: false,
  error: null,
  restartRequired: false,

  async load() {
    set({ loading: true, error: null });
    try {
      const plugins = await window.api.pluginsList();
      set({ plugins, loading: false });
    } catch (err) {
      set({ loading: false, error: (err as Error).message });
    }
  },

  async loadAdapters() {
    try {
      const adapters = await window.api.channelsListAdapters();
      set({ adapters });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  async setEnabled(name, enabled) {
    const before = get().plugins;
    // Optimistic flip; revert on error.
    set({
      plugins: before.map((p) => (p.name === name ? { ...p, enabled } : p)),
      error: null,
    });
    try {
      const result = await window.api.pluginsSetEnabled(name, enabled);
      set((s) => ({
        plugins: s.plugins.map((p) => (p.name === name ? result.plugin : p)),
        restartRequired: s.restartRequired || result.restartRequired,
      }));
    } catch (err) {
      set({ plugins: before, error: (err as Error).message });
    }
  },

  clearRestartRequired() {
    set({ restartRequired: false });
  },
}));
```

- [ ] Run: `npx vitest run apps/mission-control/src/renderer/src/stores/plugins.test.ts` → PASSES.
- [ ] Commit: `git add apps/mission-control/src/renderer/src/stores/plugins.ts apps/mission-control/src/renderer/src/stores/plugins.test.ts && git commit -m "mc(plugins): renderer store with optimistic toggle"`

---

## Task 6 — SchemaForm component (TDD)

**Files:**
- Create: `apps/mission-control/src/renderer/src/components/SchemaForm.tsx`
- Test: `apps/mission-control/src/renderer/src/components/SchemaForm.test.tsx`

Steps:

- [ ] Write the FAILING tests `apps/mission-control/src/renderer/src/components/SchemaForm.test.tsx`:

```tsx
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SchemaForm, validateSchemaValues } from './SchemaForm.js';

const schema = {
  type: 'object',
  properties: {
    botToken: {
      type: 'string',
      title: 'Bot token',
      sensitive: true,
      description: 'From the developer portal',
    },
    guildId: { type: 'string', title: 'Server ID' },
    maxRetries: { type: 'integer', title: 'Max retries' },
    verbose: { type: 'boolean', title: 'Verbose logging' },
    region: { type: 'string', title: 'Region', enum: ['us', 'eu'] },
    nested: { type: 'object', title: 'Nested' },
  },
  required: ['botToken'],
};

describe('SchemaForm', () => {
  it('renders title as label and description as help text', () => {
    render(<SchemaForm schema={schema} values={{}} onChange={() => {}} />);
    expect(screen.getByLabelText(/Bot token/)).toBeInTheDocument();
    expect(screen.getByText('From the developer portal')).toBeInTheDocument();
  });

  it('renders sensitive strings as password inputs in editable mode', () => {
    render(<SchemaForm schema={schema} values={{}} onChange={() => {}} />);
    expect(screen.getByLabelText(/Bot token/)).toHaveAttribute('type', 'password');
  });

  it('renders number, boolean, and enum fields', () => {
    render(<SchemaForm schema={schema} values={{}} onChange={() => {}} />);
    expect(screen.getByLabelText(/Max retries/)).toHaveAttribute('type', 'number');
    expect(screen.getByLabelText(/Verbose logging/)).toHaveAttribute('type', 'checkbox');
    expect(screen.getByLabelText(/Region/)).toBeInstanceOf(HTMLSelectElement);
  });

  it('marks required fields with an asterisk', () => {
    render(<SchemaForm schema={schema} values={{}} onChange={() => {}} />);
    expect(screen.getByText('Bot token').closest('label')).toHaveTextContent('*');
  });

  it('calls onChange with the updated values map', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<SchemaForm schema={schema} values={{}} onChange={onChange} />);
    await user.type(screen.getByLabelText(/Server ID/), 'g');
    expect(onChange).toHaveBeenCalledWith({ guildId: 'g' });
  });

  it('disables every input in read-only mode and shows masked values verbatim', () => {
    render(<SchemaForm schema={schema} values={{ botToken: '•••', guildId: 'g-1' }} readOnly />);
    const token = screen.getByLabelText(/Bot token/);
    expect(token).toBeDisabled();
    expect(token).toHaveValue('•••');
    // values arrive pre-masked from the API; read-only shows them as text
    expect(token).toHaveAttribute('type', 'text');
    expect(screen.getByLabelText(/Server ID/)).toBeDisabled();
  });

  it('renders an unsupported-type notice for object/array properties', () => {
    render(<SchemaForm schema={schema} values={{}} onChange={() => {}} />);
    expect(screen.getByText(/Unsupported field type "object"/)).toBeInTheDocument();
  });

  it('renders a fallback message for an empty schema', () => {
    render(<SchemaForm schema={{}} values={{}} onChange={() => {}} />);
    expect(screen.getByText('No configuration fields.')).toBeInTheDocument();
  });

  it('shows a field error passed via the errors prop', () => {
    render(
      <SchemaForm
        schema={schema}
        values={{}}
        onChange={() => {}}
        errors={{ botToken: 'Bot token is required' }}
      />,
    );
    expect(screen.getByText('Bot token is required')).toBeInTheDocument();
  });
});

describe('validateSchemaValues', () => {
  it('flags missing required fields', () => {
    expect(validateSchemaValues(schema, {})).toEqual({ botToken: 'Bot token is required' });
  });

  it('flags non-numeric values for number fields', () => {
    const errors = validateSchemaValues(schema, { botToken: 't', maxRetries: 'abc' });
    expect(errors.maxRetries).toBe('Max retries must be a number');
  });

  it('flags non-integer values for integer fields', () => {
    const errors = validateSchemaValues(schema, { botToken: 't', maxRetries: 1.5 });
    expect(errors.maxRetries).toBe('Max retries must be an integer');
  });

  it('returns no errors for a valid value set', () => {
    expect(
      validateSchemaValues(schema, { botToken: 't', maxRetries: 3, verbose: true, region: 'us' }),
    ).toEqual({});
  });
});
```

- [ ] Run: `npx vitest run apps/mission-control/src/renderer/src/components/SchemaForm.test.tsx` → FAILS.
- [ ] Create `apps/mission-control/src/renderer/src/components/SchemaForm.tsx`:

```tsx
// Schema-driven config form. Renders a JSON-Schema object's `properties` as
// form fields. v1 supports: string (sensitive: true → password input),
// number / integer, boolean (checkbox), enum (select). Nested objects and
// arrays render an unsupported-type notice. Two modes:
//   - editable: pass onChange; used by the Messaging Apps plugin-channel wizard
//   - readOnly: all inputs disabled; used by Settings → Plugins masked config
//     (sensitive values ARRIVE masked as '•••' from the API — render as-is)

export interface SchemaProperty {
  type?: string;
  title?: string;
  description?: string;
  enum?: Array<string | number>;
  sensitive?: boolean;
}

export interface SchemaField {
  name: string;
  prop: SchemaProperty;
  required: boolean;
}

export function schemaFields(schema: Record<string, unknown>): SchemaField[] {
  const properties = (schema.properties ?? {}) as Record<string, SchemaProperty>;
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  return Object.entries(properties).map(([name, prop]) => ({
    name,
    prop: prop ?? {},
    required: required.has(name),
  }));
}

/** Simple v1 validation: required presence + number/integer/boolean type checks. */
export function validateSchemaValues(
  schema: Record<string, unknown>,
  values: Record<string, unknown>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const { name, prop, required } of schemaFields(schema)) {
    const label = prop.title ?? name;
    const value = values[name];
    const empty = value === undefined || value === null || value === '';
    if (required && empty) {
      errors[name] = `${label} is required`;
      continue;
    }
    if (empty) continue;
    if (prop.type === 'number' || prop.type === 'integer') {
      const n = typeof value === 'number' ? value : Number(value);
      if (Number.isNaN(n)) {
        errors[name] = `${label} must be a number`;
      } else if (prop.type === 'integer' && !Number.isInteger(n)) {
        errors[name] = `${label} must be an integer`;
      }
    }
    if (prop.type === 'boolean' && typeof value !== 'boolean') {
      errors[name] = `${label} must be true or false`;
    }
  }
  return errors;
}

interface SchemaFormProps {
  schema: Record<string, unknown>;
  values: Record<string, unknown>;
  onChange?: (values: Record<string, unknown>) => void;
  readOnly?: boolean;
  errors?: Record<string, string>;
}

const INPUT_CLASS =
  'w-full border border-border bg-card-bg px-3 py-2 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none disabled:opacity-60';

export function SchemaForm({
  schema,
  values,
  onChange,
  readOnly = false,
  errors = {},
}: SchemaFormProps): JSX.Element {
  const fields = schemaFields(schema);
  const setValue = (name: string, value: unknown): void => {
    onChange?.({ ...values, [name]: value });
  };

  if (fields.length === 0) {
    return <p className="text-xs text-muted">No configuration fields.</p>;
  }

  return (
    <div className="space-y-3">
      {fields.map(({ name, prop, required }) => {
        const id = `schema-field-${name}`;
        const label = prop.title ?? name;
        const error = errors[name];
        const kind = prop.enum ? 'enum' : (prop.type ?? 'string');

        if (kind === 'object' || kind === 'array') {
          return (
            <div key={name}>
              <span className="mb-1 block text-xs text-muted">
                {label}
                {required && <span className="text-red"> *</span>}
              </span>
              <p className="text-xs italic text-muted">
                Unsupported field type "{kind}" — edit this value in the config file.
              </p>
            </div>
          );
        }

        return (
          <div key={name}>
            {kind !== 'boolean' && (
              <label htmlFor={id} className="mb-1 block text-xs text-muted">
                {label}
                {required && <span className="text-red"> *</span>}
              </label>
            )}

            {kind === 'enum' && (
              <select
                id={id}
                value={String(values[name] ?? '')}
                disabled={readOnly}
                onChange={(e) => setValue(name, e.target.value)}
                className={INPUT_CLASS}
              >
                <option value="">Select…</option>
                {(prop.enum ?? []).map((opt) => (
                  <option key={String(opt)} value={String(opt)}>
                    {String(opt)}
                  </option>
                ))}
              </select>
            )}

            {(kind === 'number' || kind === 'integer') && (
              <input
                id={id}
                type="number"
                value={values[name] === undefined || values[name] === null ? '' : String(values[name])}
                disabled={readOnly}
                onChange={(e) =>
                  setValue(name, e.target.value === '' ? undefined : Number(e.target.value))
                }
                className={INPUT_CLASS}
              />
            )}

            {kind === 'boolean' && (
              <label
                htmlFor={id}
                className="flex cursor-pointer items-center gap-2 text-sm text-foreground"
              >
                <input
                  id={id}
                  type="checkbox"
                  checked={values[name] === true}
                  disabled={readOnly}
                  onChange={(e) => setValue(name, e.target.checked)}
                  className="accent-accent"
                />
                {label}
                {required && <span className="text-red"> *</span>}
              </label>
            )}

            {kind === 'string' && (
              <input
                id={id}
                type={prop.sensitive && !readOnly ? 'password' : 'text'}
                value={String(values[name] ?? '')}
                disabled={readOnly}
                onChange={(e) => setValue(name, e.target.value)}
                className={INPUT_CLASS}
              />
            )}

            {prop.description && <p className="mt-1 text-[11px] text-muted">{prop.description}</p>}
            {error && <p className="mt-1 text-xs text-red">{error}</p>}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] Run: `npx vitest run apps/mission-control/src/renderer/src/components/SchemaForm.test.tsx` → PASSES.
- [ ] Commit: `git add apps/mission-control/src/renderer/src/components/SchemaForm.tsx apps/mission-control/src/renderer/src/components/SchemaForm.test.tsx && git commit -m "mc(plugins): schema-driven config form primitive"`

---

---

## Task 7 — Settings route restructure (layout + index)

The Plugins page lives at `/settings/plugins`. `routes/settings.tsx` is currently a flat route with no `<Outlet/>`, so restructure it exactly like Messaging Apps (`routes/messaging-apps.tsx` layout + `routes/messaging-apps/index.tsx`). The only in-app reference to `/settings` is the Sidebar link (`components/Sidebar.tsx:59`), which keeps working — TanStack `Link` active-matching is fuzzy by default, so it also highlights on `/settings/plugins`.

**Files:**
- Modify: `apps/mission-control/src/renderer/src/routes/settings.tsx`
- Create: `apps/mission-control/src/renderer/src/routes/settings/index.tsx`

Steps:

- [ ] Replace the ENTIRE content of `apps/mission-control/src/renderer/src/routes/settings.tsx` with:

```tsx
import { Outlet, createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/settings')({
  component: () => <Outlet />,
});
```

- [ ] Create `apps/mission-control/src/renderer/src/routes/settings/index.tsx`. This is the previous Settings component moved one directory down (import paths gain one `../`), with three additions: (1) the restart-required notice inside the Gateway card, anchored next to the existing Restart Gateway button; (2) clearing the plugins store's `restartRequired` flag when that button succeeds; (3) a Plugins link card between Gateway and About. COMPLETE content:

```tsx
import { Link, createFileRoute } from '@tanstack/react-router';
import { AlertTriangle, ChevronRight, Puzzle, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { AppSettings } from '../../../../shared/ipc.js';
import { ModelChainEditor } from '../../components/ModelChainEditor.js';
import { useAvailableModels } from '../../hooks/useAvailableModels.js';
import { usePluginsStore } from '../../stores/plugins.js';

function Settings(): JSX.Element {
  const [version, setVersion] = useState<string>('...');
  const [settings, setSettings] = useState<AppSettings>({});
  const [saving, setSaving] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [restartStatus, setRestartStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const pluginsRestartRequired = usePluginsStore((s) => s.restartRequired);
  const clearPluginsRestartRequired = usePluginsStore((s) => s.clearRestartRequired);
  const {
    models: availableModels,
    refreshing: modelsRefreshing,
    refresh: refreshModels,
  } = useAvailableModels();

  useEffect(() => {
    window.api.getVersion().then(setVersion);
    window.api
      .settingsGet()
      .then(setSettings)
      .catch(() => {});
  }, []);

  const handleRestartGateway = useCallback(async () => {
    setRestarting(true);
    setRestartStatus('idle');
    try {
      await window.api.gatewayRestart();
      clearPluginsRestartRequired();
      setRestartStatus('success');
      setTimeout(() => setRestartStatus('idle'), 3000);
    } catch {
      setRestartStatus('error');
      setTimeout(() => setRestartStatus('idle'), 5000);
    } finally {
      setRestarting(false);
    }
  }, [clearPluginsRestartRequired]);

  const handleChainChange = async (model: string, fallbackModels: string[]): Promise<void> => {
    const patch: AppSettings = { defaultModel: model, defaultFallbackModels: fallbackModels };
    setSettings((prev) => ({ ...prev, ...patch }));
    setSaving(true);
    try {
      await window.api.settingsSet(patch);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Page header */}
      <div className="bg-surface px-8 py-4 border-b border-border flex items-center justify-between shrink-0">
        <div>
          <h1 className="font-[family-name:var(--font-display)] text-[22px] font-semibold text-foreground">
            Settings
          </h1>
          <p className="mt-1 text-sm text-muted">Application settings and configuration.</p>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-8">
        <div className="rounded-lg border border-border bg-card-bg p-4">
          <h2 className="mb-1 font-[family-name:var(--font-mono)] text-[11px] uppercase tracking-[2px] text-accent">
            Default Model Chain
          </h2>
          <p className="mb-4 text-xs text-muted">
            Pre-populates the model selection when creating a new agent.
            {saving && <span className="ml-2 text-accent">Saving...</span>}
          </p>
          <ModelChainEditor
            model={settings.defaultModel ?? availableModels[0]?.value ?? ''}
            fallbackModels={settings.defaultFallbackModels ?? []}
            availableModels={availableModels}
            onChange={handleChainChange}
            onRefresh={refreshModels}
            refreshing={modelsRefreshing}
          />
        </div>

        <div className="mt-6 rounded-lg border border-border bg-card-bg p-4">
          <h2 className="mb-1 font-[family-name:var(--font-mono)] text-[11px] uppercase tracking-[2px] text-accent">
            Gateway
          </h2>
          <p className="mb-3 text-xs text-muted">
            The gateway process manages agents, channels, and credentials.
          </p>
          {pluginsRestartRequired && (
            <div className="mb-3 flex items-center gap-2 rounded-lg border border-yellow-700/50 bg-yellow-900/20 px-3 py-2 text-xs text-yellow">
              <AlertTriangle size={14} />
              Restart the gateway to apply plugin changes
            </div>
          )}
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleRestartGateway}
              disabled={restarting}
              className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted hover:text-foreground hover:bg-card-hover transition-colors disabled:opacity-50"
            >
              <RefreshCw size={14} className={restarting ? 'animate-spin' : ''} />
              {restarting ? 'Restarting...' : 'Restart Gateway'}
            </button>
            {restartStatus === 'success' && (
              <span className="text-xs text-green">Gateway restarted successfully</span>
            )}
            {restartStatus === 'error' && (
              <span className="text-xs text-red">Failed to restart gateway</span>
            )}
          </div>
        </div>

        <Link
          to="/settings/plugins"
          className="mt-6 flex items-center justify-between rounded-lg border border-border bg-card-bg p-4 transition-colors hover:bg-card-hover"
        >
          <div className="flex items-center gap-3">
            <Puzzle size={16} className="text-muted" />
            <div>
              <h2 className="font-[family-name:var(--font-mono)] text-[11px] uppercase tracking-[2px] text-accent">
                Plugins
              </h2>
              <p className="mt-1 text-xs text-muted">
                Installed gateway plugins — status, capabilities, enable/disable.
              </p>
            </div>
          </div>
          <ChevronRight size={16} className="text-muted" />
        </Link>

        <div className="mt-6 rounded-lg border border-border bg-card-bg p-4">
          <h2 className="font-[family-name:var(--font-mono)] text-[11px] uppercase tracking-[2px] text-accent">
            About
          </h2>
          <p className="mt-2 text-sm text-muted">
            DashSquad v<span className="text-foreground">{version}</span>
          </p>
        </div>
      </div>
    </div>
  );
}

export const Route = createFileRoute('/settings/')({
  component: Settings,
});
```

- [ ] Verify: `npm run mc:build` (regenerates `routeTree.gen.ts`; `/settings` and `/settings/` resolve) and `npx vitest run apps/mission-control` → green.
- [ ] Commit: `git add apps/mission-control/src/renderer/src/routes/settings.tsx apps/mission-control/src/renderer/src/routes/settings/index.tsx && git commit -m "mc(plugins): settings becomes layout route with plugins link and restart notice"`

---

## Task 8 — Settings → Plugins page (TDD on helpers)

**Files:**
- Create: `apps/mission-control/src/renderer/src/routes/settings/-lib/plugins.ts`
- Test: `apps/mission-control/src/renderer/src/routes/settings/-lib/plugins.test.ts`
- Create: `apps/mission-control/src/renderer/src/routes/settings/plugins.tsx`

Steps:

- [ ] Write the FAILING tests `apps/mission-control/src/renderer/src/routes/settings/-lib/plugins.test.ts`:

```ts
import { activeHookRows, registrationSummary } from './plugins.js';

describe('registrationSummary', () => {
  it('lists only non-zero kinds, pluralized, joined with middots', () => {
    expect(registrationSummary({ tools: 3, channels: 1, providers: 0, hooks: 2 })).toBe(
      '3 tools · 1 channel · 2 hooks',
    );
  });

  it('singularizes counts of one', () => {
    expect(registrationSummary({ tools: 1, channels: 0, providers: 1, hooks: 0 })).toBe(
      '1 tool · 1 provider',
    );
  });

  it('falls back when nothing is registered', () => {
    expect(registrationSummary({ tools: 0, channels: 0, providers: 0, hooks: 0 })).toBe(
      'no registrations',
    );
  });
});

describe('activeHookRows', () => {
  it('returns only hooks with activity, in HOOK_NAMES order', () => {
    const rows = activeHookRows({
      agent_run_end: { fired: 2, modified: 0, blocked: 0, failed: 0, timedOut: 0 },
      before_tool_call: { fired: 5, modified: 1, blocked: 1, failed: 0, timedOut: 0 },
      message_sending: { fired: 0, modified: 0, blocked: 0, failed: 0, timedOut: 0 },
    });
    expect(rows.map((r) => r.hook)).toEqual(['before_tool_call', 'agent_run_end']);
    expect(rows[0].blocked).toBe(1);
  });

  it('counts any non-zero column as activity', () => {
    const rows = activeHookRows({
      message_received: { fired: 0, modified: 0, blocked: 0, failed: 0, timedOut: 1 },
    });
    expect(rows).toHaveLength(1);
  });

  it('returns an empty array for empty counters', () => {
    expect(activeHookRows({})).toEqual([]);
  });
});
```

- [ ] Run: `npx vitest run apps/mission-control/src/renderer/src/routes/settings/-lib/plugins.test.ts` → FAILS.
- [ ] Create `apps/mission-control/src/renderer/src/routes/settings/-lib/plugins.ts`:

```ts
import type { PluginHookCounter, PluginView } from '../../../../../shared/plugins-ipc.js';
import { HOOK_NAMES } from '../../../../../shared/plugins-ipc.js';

/** "3 tools · 1 channel · 2 hooks" — only non-zero kinds, singular/plural. */
export function registrationSummary(registrations: PluginView['registrations']): string {
  const parts: string[] = [];
  const push = (count: number, singular: string): void => {
    if (count > 0) parts.push(`${count} ${singular}${count === 1 ? '' : 's'}`);
  };
  push(registrations.tools, 'tool');
  push(registrations.channels, 'channel');
  push(registrations.providers, 'provider');
  push(registrations.hooks, 'hook');
  return parts.length > 0 ? parts.join(' · ') : 'no registrations';
}

export interface HookRow extends PluginHookCounter {
  hook: string;
}

/** Rows for the hook-counters table: only hooks with any activity, in
 *  HOOK_NAMES (dispatch) order. */
export function activeHookRows(hookCounters: PluginView['hookCounters']): HookRow[] {
  return HOOK_NAMES.filter((h) => {
    const c = hookCounters[h];
    return (
      c !== undefined &&
      (c.fired > 0 || c.modified > 0 || c.blocked > 0 || c.failed > 0 || c.timedOut > 0)
    );
  }).map((h) => ({ hook: h, ...(hookCounters[h] as PluginHookCounter) }));
}
```

- [ ] Run the helper tests → PASSES.
- [ ] Create `apps/mission-control/src/renderer/src/routes/settings/plugins.tsx` with the COMPLETE content below:

```tsx
import { Link, createFileRoute } from '@tanstack/react-router';
import { AlertTriangle, ArrowLeft, ChevronDown, ChevronUp, Puzzle, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { PluginView } from '../../../../shared/plugins-ipc.js';
import { SchemaForm } from '../../components/SchemaForm.js';
import { usePluginsStore } from '../../stores/plugins.js';
import { activeHookRows, registrationSummary } from './-lib/plugins.js';

function PluginStatusPill({ status }: { status: PluginView['status'] }): JSX.Element {
  if (status === 'loaded') {
    return (
      <span className="bg-green-tint text-green rounded px-2 py-0.5 text-[10px] font-[family-name:var(--font-mono)] font-semibold">
        loaded
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className="bg-red-tint text-red rounded px-2 py-0.5 text-[10px] font-[family-name:var(--font-mono)] font-semibold">
        error
      </span>
    );
  }
  return (
    <span className="bg-sidebar-hover text-muted rounded px-2 py-0.5 text-[10px] font-[family-name:var(--font-mono)] font-semibold">
      disabled
    </span>
  );
}

function CapabilityBadges({
  capabilities,
}: {
  capabilities: PluginView['capabilities'];
}): JSX.Element {
  return (
    <span className="flex items-center gap-1">
      {capabilities.map((c) => (
        <span
          key={c}
          className="rounded border border-border px-1.5 py-0.5 text-[9px] font-[family-name:var(--font-mono)] uppercase tracking-wide text-muted"
        >
          {c}
        </span>
      ))}
    </span>
  );
}

function EnableToggle({ plugin }: { plugin: PluginView }): JSX.Element {
  const setEnabled = usePluginsStore((s) => s.setEnabled);
  return (
    <button
      type="button"
      role="switch"
      aria-checked={plugin.enabled}
      aria-label={`${plugin.enabled ? 'Disable' : 'Enable'} ${plugin.name}`}
      onClick={(e) => {
        e.stopPropagation();
        void setEnabled(plugin.name, !plugin.enabled);
      }}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
        plugin.enabled ? 'bg-accent' : 'bg-border'
      }`}
    >
      <span
        className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
          plugin.enabled ? 'translate-x-4' : ''
        }`}
      />
    </button>
  );
}

function HookCountersTable({ plugin }: { plugin: PluginView }): JSX.Element | null {
  const rows = activeHookRows(plugin.hookCounters);
  if (rows.length === 0) return null;
  return (
    <div>
      <p className="mb-1 font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[2px] text-accent">
        Hook activity
      </p>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-muted">
            <th className="py-1 text-left font-medium">Hook</th>
            <th className="py-1 text-right font-medium">Fired</th>
            <th className="py-1 text-right font-medium">Modified</th>
            <th className="py-1 text-right font-medium">Blocked</th>
            <th className="py-1 text-right font-medium">Failed</th>
            <th className="py-1 text-right font-medium">Timed out</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.hook} className="border-t border-border">
              <td className="py-1 font-[family-name:var(--font-mono)]">{r.hook}</td>
              <td className="py-1 text-right">{r.fired}</td>
              <td className="py-1 text-right">{r.modified}</td>
              <td className="py-1 text-right">{r.blocked}</td>
              <td className="py-1 text-right">{r.failed}</td>
              <td className="py-1 text-right">{r.timedOut}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1 text-[11px] text-muted">In-memory since the last gateway restart.</p>
    </div>
  );
}

function PluginRow({ plugin }: { plugin: PluginView }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="bg-card-bg border border-border">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-center gap-4 px-5 py-4 text-left transition-colors hover:bg-card-hover"
      >
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-foreground">
            {plugin.name}
            <span className="ml-2 font-[family-name:var(--font-mono)] text-xs font-normal text-muted">
              v{plugin.version}
            </span>
          </p>
          {plugin.description && (
            <p className="mt-0.5 truncate text-xs text-muted">{plugin.description}</p>
          )}
        </div>
        <CapabilityBadges capabilities={plugin.capabilities} />
        <PluginStatusPill status={plugin.status} />
        <EnableToggle plugin={plugin} />
        {expanded ? (
          <ChevronUp size={16} className="shrink-0 text-muted" />
        ) : (
          <ChevronDown size={16} className="shrink-0 text-muted" />
        )}
      </button>

      {expanded && (
        <div className="space-y-4 border-t border-border px-5 py-4">
          {plugin.status === 'error' && plugin.failure && (
            <div className="rounded border border-red-900/50 bg-red-900/20 px-3 py-2">
              <p className="text-xs font-medium text-red">
                Failed during the{' '}
                <span className="font-[family-name:var(--font-mono)]">{plugin.failure.phase}</span>{' '}
                phase
              </p>
              <p className="mt-1 text-xs text-red">{plugin.failure.error}</p>
              <p className="mt-1 text-[11px] text-muted">
                {new Date(plugin.failure.failedAt).toLocaleString()}
              </p>
            </div>
          )}

          <p className="text-xs text-muted">{registrationSummary(plugin.registrations)}</p>

          <HookCountersTable plugin={plugin} />

          {plugin.configSchema && plugin.config && (
            <div>
              <p className="mb-2 font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[2px] text-accent">
                Configuration (read-only)
              </p>
              <SchemaForm schema={plugin.configSchema} values={plugin.config} readOnly />
              <p className="mt-2 text-[11px] text-muted">
                Plugin config is edited in the gateway config file. Sensitive values are masked.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RestartBanner(): JSX.Element | null {
  const restartRequired = usePluginsStore((s) => s.restartRequired);
  const clearRestartRequired = usePluginsStore((s) => s.clearRestartRequired);
  const load = usePluginsStore((s) => s.load);
  const [restarting, setRestarting] = useState(false);
  if (!restartRequired) return null;

  const handleRestart = async (): Promise<void> => {
    setRestarting(true);
    try {
      await window.api.gatewayRestart();
      clearRestartRequired();
      await load();
    } finally {
      setRestarting(false);
    }
  };

  return (
    <div className="mb-4 flex items-center justify-between rounded-lg border border-yellow-700/50 bg-yellow-900/20 px-4 py-3">
      <div className="flex items-center gap-2 text-sm text-yellow">
        <AlertTriangle size={16} />
        Restart the gateway to apply plugin changes
      </div>
      <button
        type="button"
        onClick={handleRestart}
        disabled={restarting}
        className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:bg-card-hover hover:text-foreground disabled:opacity-50"
      >
        <RefreshCw size={14} className={restarting ? 'animate-spin' : ''} />
        {restarting ? 'Restarting...' : 'Restart Gateway'}
      </button>
    </div>
  );
}

function PluginsPage(): JSX.Element {
  const { plugins, loading, error, load } = usePluginsStore();
  const [dataDir, setDataDir] = useState('');

  useEffect(() => {
    void load();
    window.api
      .logsPaths()
      .then((p) => setDataDir(p.dataDir))
      .catch(() => {});
  }, [load]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="bg-surface px-8 py-4 border-b border-border flex items-center gap-4 shrink-0">
        <Link
          to="/settings"
          className="rounded p-1.5 text-muted transition-colors hover:bg-card-hover hover:text-foreground"
        >
          <ArrowLeft size={16} />
        </Link>
        <div>
          <h1 className="font-[family-name:var(--font-display)] text-[22px] font-semibold text-foreground">
            Plugins
          </h1>
          <p className="text-sm text-muted">
            Trusted in-process gateway extensions. Changes apply on gateway restart.
          </p>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-8">
        <RestartBanner />

        {error && (
          <div className="mb-4 rounded-lg border border-red-900/50 bg-red-900/20 px-4 py-3 text-sm text-red">
            {error}
          </div>
        )}

        {!loading && plugins.length === 0 ? (
          <div className="rounded-lg border border-border bg-surface p-8 text-center">
            <Puzzle size={24} className="mx-auto mb-2 text-muted" />
            <p className="text-sm font-medium">No plugins installed.</p>
            <p className="mt-1 text-sm text-muted">
              Drop a plugin into{' '}
              <code className="font-[family-name:var(--font-mono)] text-xs">
                {dataDir ? `${dataDir}/plugins/` : '<dataDir>/plugins/'}
              </code>{' '}
              and enable it here.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {plugins.map((p) => (
              <PluginRow key={p.name} plugin={p} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export const Route = createFileRoute('/settings/plugins')({
  component: PluginsPage,
});
```

- [ ] Verify: `npm run mc:build` (routeTree regen) and `npx vitest run apps/mission-control` → green.
- [ ] Commit: `git add apps/mission-control/src/renderer/src/routes/settings/plugins.tsx apps/mission-control/src/renderer/src/routes/settings/-lib/plugins.ts apps/mission-control/src/renderer/src/routes/settings/-lib/plugins.test.ts && git commit -m "mc(plugins): settings plugins page with toggles, counters, masked config"`

---

## Task 9 — Messaging Apps integration

**Files:**
- Modify: `apps/mission-control/src/renderer/src/stores/messaging-apps.ts`
- Modify: `apps/mission-control/src/renderer/src/routes/messaging-apps/index.tsx`
- Create: `apps/mission-control/src/renderer/src/routes/messaging-apps/new-plugin.$adapter.tsx`
- Modify: `apps/mission-control/src/renderer/src/routes/messaging-apps/$id.tsx`

Steps:

- [ ] In `stores/messaging-apps.ts`, add `config?: Record<string, unknown>;` to the `createChannel` config parameter type (in the `ChannelsState` interface, after `token?: string;`). The implementation already forwards the whole object to `window.api.channelsCreate`.

- [ ] In `routes/messaging-apps/index.tsx`:

1. Add imports: `Puzzle` to the lucide import, `useEffect` is already imported, and:

```tsx
import { usePluginsStore } from '../../stores/plugins.js';
```

2. In `PlatformIcon`, add as the FIRST statement (before the whatsapp branch) a fallback for plugin adapters:

```tsx
  if (type !== 'whatsapp' && type !== 'telegram') {
    return <Puzzle size={24} className="text-muted" role="img" aria-label={type} />;
  }
```

3. In the `MessagingApps` component, load adapters and derive plugin entries:

```tsx
  const { adapters, loadAdapters } = usePluginsStore();

  useEffect(() => {
    loadAdapters();
  }, [loadAdapters]);

  const pluginAdapters = adapters.filter((a) => !a.builtIn);
```

4. In the header's button group (after the "Connect App" Link), render one button per plugin adapter — built-ins keep their bespoke wizards, plugin adapters route to the generic flow:

```tsx
          {pluginAdapters.map((a) => (
            <Link
              key={a.name}
              to="/messaging-apps/new-plugin/$adapter"
              params={{ adapter: a.name }}
              className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm text-muted transition-colors hover:bg-card-hover hover:text-foreground"
            >
              <Plus size={16} />
              Add {a.name}
            </Link>
          ))}
```

5. Replace `ChannelCard`'s body so errored channels (RECONCILIATION POINT 3 — fields optional, healthy channels unchanged) show the reason inline:

```tsx
function ChannelCard({
  channel,
  agentCount,
}: {
  channel: GatewayChannel;
  agentCount: number;
}): JSX.Element {
  const errored = channel.status === 'error';
  return (
    <Link
      to="/messaging-apps/$id"
      params={{ id: channel.name }}
      className="bg-card-bg border border-border p-5 flex flex-col gap-3 hover:bg-card-hover transition-colors cursor-pointer"
    >
      {/* Header row */}
      <div className="flex justify-between items-center">
        <div className="flex items-center gap-2">
          <PlatformIcon type={channel.adapter} />
          <span className="font-semibold text-[16px] text-foreground">{channel.name}</span>
        </div>
        {errored ? (
          <span className="bg-red-tint text-red px-2 py-0.5 text-[10px] font-[family-name:var(--font-mono)] font-semibold">
            Error
          </span>
        ) : (
          <span className="bg-green-tint text-green px-2 py-0.5 text-[10px] font-[family-name:var(--font-mono)] font-semibold">
            Connected
          </span>
        )}
      </div>

      {errored && channel.error && <p className="text-xs text-red">{channel.error}</p>}

      {/* Agent count */}
      <p className="text-xs text-muted">
        {agentCount} agent{agentCount !== 1 ? 's' : ''} connected
      </p>
    </Link>
  );
}
```

- [ ] Create `routes/messaging-apps/new-plugin.$adapter.tsx` (generic plugin-channel setup: name + editable SchemaForm → assistant → save via the EXISTING channel CRUD with `adapter` + `config`; RECONCILIATION POINT 2):

```tsx
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, ArrowRight, Check, CheckCircle, Loader } from 'lucide-react';
import { useEffect, useState } from 'react';
import { SchemaForm, validateSchemaValues } from '../../components/SchemaForm.js';
import { useAgentsStore } from '../../stores/agents.js';
import { useChannelsStore } from '../../stores/messaging-apps.js';
import { usePluginsStore } from '../../stores/plugins.js';

type StepId = 'configure' | 'choose-assistant' | 'done';

function NewPluginChannelWizard(): JSX.Element {
  const { adapter } = Route.useParams();
  const navigate = useNavigate();
  const { adapters, loadAdapters } = usePluginsStore();
  const { agents, loadAgents } = useAgentsStore();
  const { createChannel } = useChannelsStore();

  const [step, setStep] = useState<StepId>('configure');
  const [name, setName] = useState('');
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [agentId, setAgentId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  useEffect(() => {
    loadAdapters();
    loadAgents();
  }, [loadAdapters, loadAgents]);

  const info = adapters.find((a) => a.name === adapter && !a.builtIn);

  const availableAgents = agents
    .filter((a) => a.status === 'active' || a.status === 'registered')
    .map((a) => ({ label: a.name, agentId: a.id }));

  function handleConfigureNext(): void {
    const errors = validateSchemaValues(info?.configSchema ?? {}, values);
    setFieldErrors(errors);
    if (!name.trim() || Object.keys(errors).length > 0) return;
    setStep('choose-assistant');
  }

  async function handleSave(): Promise<void> {
    if (!agentId) return;
    setSaving(true);
    setSaveError('');
    try {
      await createChannel({
        name: name.trim(),
        adapter,
        config: values,
        globalDenyList: [],
        routing: [{ condition: { type: 'default' }, agentId, allowList: [], denyList: [] }],
      });
      setStep('done');
    } catch (err) {
      setSaveError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (adapters.length > 0 && !info) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <p className="text-sm text-muted">
          Adapter "{adapter}" is not available. The plugin providing it may be disabled.
        </p>
        <button
          type="button"
          onClick={() => navigate({ to: '/messaging-apps' })}
          className="inline-flex items-center gap-2 border border-border px-4 py-2 text-sm text-muted transition-colors hover:bg-card-hover hover:text-foreground"
        >
          <ArrowLeft size={14} />
          Back to Messaging Apps
        </button>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto p-8">
        <div className="mx-auto max-w-2xl">
          <div className="min-h-[360px]">
            {step === 'configure' && (
              <div>
                <h2 className="text-xl font-bold font-[family-name:var(--font-display)]">
                  Connect {adapter}
                </h2>
                {info?.pluginName && (
                  <p className="mt-1 text-xs text-muted">
                    Adapter provided by plugin{' '}
                    <span className="font-[family-name:var(--font-mono)]">{info.pluginName}</span>
                  </p>
                )}
                <div className="mt-6">
                  <label
                    htmlFor="connection-name"
                    className="mb-1 block font-[family-name:var(--font-mono)] text-xs uppercase tracking-wider text-muted"
                  >
                    Connection Name
                  </label>
                  <input
                    id="connection-name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={`e.g. "My ${adapter} bot"`}
                    className="w-full border border-border bg-card-bg px-3 py-2 text-sm focus:border-accent focus:outline-none"
                  />
                </div>
                <div className="mt-5">
                  <SchemaForm
                    schema={info?.configSchema ?? {}}
                    values={values}
                    onChange={setValues}
                    errors={fieldErrors}
                  />
                </div>
                <div className="mt-8 flex items-center justify-between">
                  <button
                    type="button"
                    onClick={() => navigate({ to: '/messaging-apps' })}
                    className="inline-flex items-center gap-2 border border-border px-4 py-2 text-sm text-muted transition-colors hover:bg-card-hover hover:text-foreground"
                  >
                    <ArrowLeft size={14} />
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleConfigureNext}
                    disabled={!name.trim()}
                    className="inline-flex items-center gap-2 bg-accent px-4 py-2 text-sm text-white transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Continue
                    <ArrowRight size={14} />
                  </button>
                </div>
              </div>
            )}

            {step === 'choose-assistant' && (
              <div>
                <h2 className="text-xl font-bold font-[family-name:var(--font-display)]">
                  Choose your assistant
                </h2>
                <p className="mt-4 text-base leading-relaxed">
                  Which AI assistant should handle messages from this channel?
                </p>
                {availableAgents.length === 0 ? (
                  <div className="mt-4 border border-border bg-card-bg p-4 text-sm text-muted">
                    No agents are running. Deploy an agent first, then come back here.
                  </div>
                ) : (
                  <div className="mt-4 flex flex-col gap-2">
                    {availableAgents.map((a) => (
                      <button
                        key={a.agentId}
                        type="button"
                        onClick={() => setAgentId(a.agentId)}
                        className={`border-2 px-4 py-3 text-left text-sm transition-colors ${
                          agentId === a.agentId
                            ? 'border-accent bg-accent/10'
                            : 'border-border hover:border-accent/50 hover:bg-card-hover'
                        }`}
                      >
                        <span className="font-medium">{a.label}</span>
                      </button>
                    ))}
                  </div>
                )}
                {saveError && <p className="mt-3 text-sm text-red">Error: {saveError}</p>}
                <div className="mt-8 flex items-center justify-between">
                  <button
                    type="button"
                    onClick={() => setStep('configure')}
                    className="inline-flex items-center gap-2 border border-border px-4 py-2 text-sm text-muted transition-colors hover:bg-card-hover hover:text-foreground"
                  >
                    <ArrowLeft size={14} />
                    Back
                  </button>
                  <button
                    type="button"
                    onClick={handleSave}
                    disabled={!agentId || saving}
                    className="inline-flex items-center gap-2 bg-accent px-5 py-2 text-sm text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {saving ? <Loader size={14} className="animate-spin" /> : <Check size={14} />}
                    {saving ? 'Connecting…' : 'Connect'}
                  </button>
                </div>
              </div>
            )}

            {step === 'done' && (
              <div className="flex flex-col items-center py-12 text-center">
                <CheckCircle size={64} className="text-green" />
                <h2 className="mt-6 text-2xl font-bold font-[family-name:var(--font-display)]">
                  You're all set!
                </h2>
                <p className="mt-3 text-base text-muted">
                  Your <strong>{adapter}</strong> channel <strong>{name}</strong> is now connected.
                </p>
                <button
                  type="button"
                  onClick={() => navigate({ to: '/messaging-apps' })}
                  className="mt-6 bg-accent px-6 py-2 text-sm text-white hover:opacity-90"
                >
                  Done
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export const Route = createFileRoute('/messaging-apps/new-plugin/$adapter')({
  component: NewPluginChannelWizard,
});
```

- [ ] In `routes/messaging-apps/$id.tsx`, replace the static "Connected" badge in the header (the `<span className="bg-green-tint text-green …">Connected</span>` at the end of the header row) with:

```tsx
        {channel.status === 'error' ? (
          <span className="bg-red-tint text-red rounded px-2 py-0.5 text-[10px] font-[family-name:var(--font-mono)] font-semibold">
            Error
          </span>
        ) : (
          <span className="bg-green-tint text-green rounded px-2 py-0.5 text-[10px] font-[family-name:var(--font-mono)] font-semibold">
            Connected
          </span>
        )}
```

and add at the very top of the body scroll area (immediately before the existing `{error && …}` block):

```tsx
        {channel.status === 'error' && channel.error && (
          <div className="mb-4 rounded-lg border border-red-600/40 bg-red-tint px-4 py-3 text-sm text-red">
            This channel's adapter is unavailable: {channel.error}. The plugin providing it may be
            disabled — check Settings → Plugins. The channel's configuration is preserved.
          </div>
        )}
```

- [ ] Verify: `npm run mc:build` and `npx vitest run apps/mission-control` → green.
- [ ] Commit: `git add apps/mission-control/src/renderer/src/stores/messaging-apps.ts apps/mission-control/src/renderer/src/routes/messaging-apps/index.tsx "apps/mission-control/src/renderer/src/routes/messaging-apps/new-plugin.\$adapter.tsx" "apps/mission-control/src/renderer/src/routes/messaging-apps/\$id.tsx" && git commit -m "mc(plugins): data-driven adapters, generic plugin channel wizard, errored channel display"`

---

## Task 10 — AI Providers integration (TDD)

**Files:**
- Create: `apps/mission-control/src/renderer/src/components/PluginProviderKeyModal.tsx`
- Modify: `apps/mission-control/src/renderer/src/routes/connections.tsx`
- Test: `apps/mission-control/src/renderer/src/routes/connections.test.tsx`

Steps:

- [ ] Add FAILING tests to `connections.test.tsx` (append to the existing describe; the default `providersList` mock resolves `[]`, so existing tests are unaffected):

```tsx
  it('renders a plugin provider card with a from-plugin badge', async () => {
    mockApi.providersList.mockResolvedValue([
      { id: 'groq', label: 'Groq', credentialPrefix: 'groq-api-key', source: 'plugin:groq-provider' },
    ]);
    mockApi.credentialsList.mockResolvedValue(['groq-api-key:default']);
    render(<AiProviders />);
    expect(await screen.findByText('Groq')).toBeInTheDocument();
    expect(screen.getByText('from plugin: groq-provider')).toBeInTheDocument();
  });

  it('does not render built-in provider entries from the listing as plugin cards', async () => {
    mockApi.providersList.mockResolvedValue([
      { id: 'anthropic', label: 'Anthropic', credentialPrefix: 'anthropic-api-key' },
    ]);
    render(<AiProviders />);
    await screen.findByText('Claude by Anthropic');
    expect(screen.queryByText(/from plugin:/)).not.toBeInTheDocument();
  });

  it('stores a plugin provider key under its credentialPrefix', async () => {
    const user = userEvent.setup();
    mockApi.providersList.mockResolvedValue([
      { id: 'groq', label: 'Groq', credentialPrefix: 'groq-api-key', source: 'plugin:groq-provider' },
    ]);
    mockApi.credentialsList.mockResolvedValue([]);
    render(<AiProviders />);
    await screen.findByText('Groq');
    await user.click(screen.getByRole('button', { name: 'Add key for Groq' }));
    await user.type(screen.getByLabelText('Key label'), 'default');
    await user.type(screen.getByLabelText('API key'), 'gsk-test');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(mockApi.credentialsSet).toHaveBeenCalledWith('groq-api-key:default', 'gsk-test');
  });
```

- [ ] Run: `npx vitest run apps/mission-control/src/renderer/src/routes/connections.test.tsx` → new tests FAIL.
- [ ] Create `apps/mission-control/src/renderer/src/components/PluginProviderKeyModal.tsx`:

```tsx
import { KeyRound, Loader, X } from 'lucide-react';
import { useState } from 'react';
import type { ProviderListingEntry } from '../../../shared/plugins-ipc.js';

const KEY_NAME_PATTERN = /^[a-zA-Z0-9-]+$/;

interface PluginProviderKeyModalProps {
  provider: ProviderListingEntry;
  keyName?: string;
  onClose: () => void;
  onSaved: () => void;
}

/** Generic key-entry modal for plugin providers. Keys are stored under the
 *  provider catalog's credentialPrefix via the EXISTING credential flow:
 *  `${credentialPrefix}:<label>` (same shape as built-in `<id>-api-key:<label>`). */
export function PluginProviderKeyModal({
  provider,
  keyName,
  onClose,
  onSaved,
}: PluginProviderKeyModalProps): JSX.Element {
  const [name, setName] = useState(keyName ?? 'default');
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async (): Promise<void> => {
    const trimmedName = name.trim();
    const trimmedKey = apiKey.trim();
    if (!trimmedName || !trimmedKey) return;
    if (!KEY_NAME_PATTERN.test(trimmedName)) {
      setError('Label must contain only letters, numbers, and hyphens.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await window.api.credentialsSet(`${provider.credentialPrefix}:${trimmedName}`, trimmedKey);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  };

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: custom modal uses div for flexible Tailwind styling */}
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-md bg-background border border-border p-6"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between">
          <div className="flex items-center gap-2">
            <KeyRound size={20} className="text-muted" />
            <h2 className="text-lg font-semibold text-foreground">Connect to {provider.label}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-muted hover:text-foreground"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        {provider.source?.startsWith('plugin:') && (
          <p className="mb-4 text-xs text-muted">
            Provider registered by plugin{' '}
            <span className="font-[family-name:var(--font-mono)]">
              {provider.source.slice('plugin:'.length)}
            </span>
            . The key is stored as{' '}
            <span className="font-[family-name:var(--font-mono)]">
              {provider.credentialPrefix}:&lt;label&gt;
            </span>
            .
          </p>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSave();
          }}
          className="space-y-3"
        >
          <div>
            <label className="mb-1.5 block text-xs text-muted" htmlFor="plugin-key-name">
              Key label
            </label>
            <input
              id="plugin-key-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. default, personal, work"
              className="w-full border border-border bg-card-bg px-4 py-3 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs text-muted" htmlFor="plugin-key-value">
              API key
            </label>
            <input
              id="plugin-key-value"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="Paste the provider API key"
              className="w-full border border-border bg-card-bg px-4 py-3 text-sm font-mono text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
            />
          </div>
          {error && <p className="text-sm text-red">{error}</p>}
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 border border-border px-4 py-2 text-sm text-muted hover:text-foreground transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!name.trim() || !apiKey.trim() || saving}
              className="flex-1 bg-accent px-4 py-2 text-sm text-white transition-colors hover:bg-primary-hover disabled:opacity-50 inline-flex items-center justify-center gap-1"
            >
              {saving && <Loader size={14} className="animate-spin" />}
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
```

- [ ] Modify `routes/connections.tsx`:

1. Add imports:

```tsx
import type { ProviderListingEntry } from '../../../shared/plugins-ipc.js';
import { PluginProviderKeyModal } from '../components/PluginProviderKeyModal.js';
```

2. Add state inside `AiProviders` (next to `providerKeys`):

```tsx
  const [pluginProviders, setPluginProviders] = useState<ProviderListingEntry[]>([]);
  const [pluginKeys, setPluginKeys] = useState<Record<string, string[]>>({});
  const [pluginModal, setPluginModal] = useState<{
    provider: ProviderListingEntry;
    keyName?: string;
  } | null>(null);
  const [pluginRemoveConfirm, setPluginRemoveConfirm] = useState<{
    providerId: string;
    keyName: string;
  } | null>(null);
```

3. Extend `loadKeys` — append before `setProviderKeys(grouped);` (RECONCILIATION POINT 1 lives behind `providersList`; only entries WITH a `plugin:` source render as plugin cards, so the built-in card rendering is untouched):

```tsx
    const listing = await window.api.providersList().catch(() => [] as ProviderListingEntry[]);
    const fromPlugins = listing.filter((e) => e.source?.startsWith('plugin:'));
    setPluginProviders(fromPlugins);
    const pluginGrouped: Record<string, string[]> = {};
    for (const e of fromPlugins) {
      const prefix = `${e.credentialPrefix}:`;
      pluginGrouped[e.id] = allKeys
        .filter((k: string) => k.startsWith(prefix))
        .map((k: string) => k.slice(prefix.length));
    }
    setPluginKeys(pluginGrouped);
```

4. Render the plugin section after the built-in `PROVIDERS.map(...)` block's closing `</div>` (still inside the body scroll area):

```tsx
        {pluginProviders.length > 0 && (
          <>
            <p className="mt-8 font-[family-name:var(--font-mono)] text-[11px] uppercase tracking-[2px] text-accent">
              From Plugins
            </p>
            <div className="flex flex-col gap-3 mt-4">
              {pluginProviders.map((p) => {
                const keys = pluginKeys[p.id] ?? [];
                const hasKeys = keys.length > 0;
                const pluginName = p.source?.slice('plugin:'.length) ?? '';
                return (
                  <div key={p.id} className="bg-card-bg border border-border">
                    <div className="px-5 py-4 flex items-center gap-4 hover:bg-card-hover transition-colors">
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-foreground flex items-center gap-2">
                          {p.label}
                          <span className="rounded bg-sidebar-hover px-1.5 py-0.5 text-[10px] font-[family-name:var(--font-mono)] font-normal text-muted">
                            from plugin: {pluginName}
                          </span>
                        </p>
                        <p className="font-[family-name:var(--font-mono)] text-xs text-muted mt-0.5">
                          {hasKeys ? keys.join(', ') : 'No key configured'}
                        </p>
                      </div>
                      <div className="flex items-center gap-3">
                        {hasKeys ? (
                          <span className="bg-green-tint text-green rounded px-2 py-0.5 text-[10px] font-[family-name:var(--font-mono)] font-semibold">
                            Active
                          </span>
                        ) : (
                          <span className="bg-red-tint text-red rounded px-2 py-0.5 text-[10px] font-[family-name:var(--font-mono)] font-semibold">
                            Disabled
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() =>
                            setPluginModal({ provider: p, keyName: hasKeys ? undefined : 'default' })
                          }
                          className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted hover:text-foreground hover:bg-card-hover transition-colors"
                          aria-label={`Add key for ${p.label}`}
                        >
                          <Plus size={14} />
                          Add Key
                        </button>
                      </div>
                    </div>

                    {keys.length > 0 && (
                      <div className="px-5 pb-4 space-y-2">
                        {keys.map((keyName) => {
                          const isConfirming =
                            pluginRemoveConfirm?.providerId === p.id &&
                            pluginRemoveConfirm?.keyName === keyName;
                          return (
                            <div
                              key={keyName}
                              className="flex items-center justify-between rounded border border-border bg-background px-3 py-2"
                            >
                              <div className="flex items-center gap-2">
                                <span className="text-xs font-medium text-foreground">{keyName}</span>
                                <span className="text-xs text-muted">••••••••</span>
                              </div>
                              <div className="flex items-center gap-2">
                                {!isConfirming && (
                                  <>
                                    <button
                                      type="button"
                                      onClick={() => setPluginModal({ provider: p, keyName })}
                                      className="text-xs text-accent hover:underline"
                                    >
                                      Update
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setPluginRemoveConfirm({ providerId: p.id, keyName })
                                      }
                                      className="text-xs text-muted hover:text-foreground"
                                    >
                                      Remove
                                    </button>
                                  </>
                                )}
                                {isConfirming && (
                                  <div className="flex items-center gap-2">
                                    <span className="text-xs text-muted">Remove key?</span>
                                    <button
                                      type="button"
                                      onClick={async () => {
                                        await window.api.credentialsRemove(
                                          `${p.credentialPrefix}:${keyName}`,
                                        );
                                        setPluginRemoveConfirm(null);
                                        loadKeys();
                                      }}
                                      className="text-xs text-red hover:underline"
                                    >
                                      Yes, remove
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setPluginRemoveConfirm(null)}
                                      className="text-xs text-muted hover:text-foreground"
                                    >
                                      Cancel
                                    </button>
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
```

5. Render the modal at the bottom of the component, next to the existing `{modal && (<ProviderConnectModal …/>)}`:

```tsx
      {pluginModal && (
        <PluginProviderKeyModal
          provider={pluginModal.provider}
          keyName={pluginModal.keyName}
          onClose={() => setPluginModal(null)}
          onSaved={() => {
            setPluginModal(null);
            loadKeys();
          }}
        />
      )}
```

- [ ] Run: `npx vitest run apps/mission-control/src/renderer/src/routes/connections.test.tsx` → PASSES (including pre-existing tests).
- [ ] Commit: `git add apps/mission-control/src/renderer/src/components/PluginProviderKeyModal.tsx apps/mission-control/src/renderer/src/routes/connections.tsx apps/mission-control/src/renderer/src/routes/connections.test.tsx && git commit -m "mc(plugins): plugin provider credential cards"`

---

## Task 11 — Agent detail Plugins card + deploy wizard (TDD)

The existing MCP-server assignment control is the **Connectors card** on `AgentConfigTab` (`routes/agents/-components/AgentConfigTab.tsx`) — NOT the deploy wizard, which has no MCP control today (codebase contradicts the prompt here; mirror the card on agent detail, add a fresh section to the wizard). RECONCILIATION POINT 4 (the `plugins: null` reset encoding) lives in this task.

**Files:**
- Modify: `apps/mission-control/src/renderer/src/routes/agents/-components/AgentConfigTab.tsx`
- Test: `apps/mission-control/src/renderer/src/routes/agents/$id.test.tsx`
- Modify: `apps/mission-control/src/renderer/src/routes/deploy.tsx`
- Test: `apps/mission-control/src/renderer/src/routes/deploy.test.tsx`

Steps:

- [ ] Add FAILING tests to `routes/agents/$id.test.tsx` (append to the existing describe; reuse the `activeAgent` fixture):

```tsx
  // CONTRACT: agent config `plugins` — unset = all plugin tools; [] = none;
  // identity = plugin manifest name. The card only renders when at least one
  // LOADED plugin has the 'tools' capability.
  it('shows the Plugins card with "All plugins" when config.plugins is unset', async () => {
    mockApi.pluginsList.mockResolvedValue([
      {
        name: 'web-extras',
        version: '1.0.0',
        status: 'loaded',
        capabilities: ['tools'],
        registrations: { tools: 2, channels: 0, providers: 0, hooks: 0 },
        hookCounters: {},
        enabled: true,
      },
    ]);
    const user = userEvent.setup();
    render(<AgentDetail />);
    await user.click(await screen.findByText('Configuration'));
    expect(await screen.findByText('Plugins')).toBeInTheDocument();
    expect(screen.getByText('All plugins')).toBeInTheDocument();
  });

  it('hides the Plugins card when no loaded plugin has tools capability', async () => {
    mockApi.pluginsList.mockResolvedValue([
      {
        name: 'audit-log',
        version: '1.0.0',
        status: 'loaded',
        capabilities: ['hooks'],
        registrations: { tools: 0, channels: 0, providers: 0, hooks: 1 },
        hookCounters: {},
        enabled: true,
      },
      {
        name: 'broken-tools',
        version: '1.0.0',
        status: 'error',
        capabilities: ['tools'],
        registrations: { tools: 0, channels: 0, providers: 0, hooks: 0 },
        hookCounters: {},
        enabled: true,
      },
    ]);
    const user = userEvent.setup();
    render(<AgentDetail />);
    await user.click(await screen.findByText('Configuration'));
    await screen.findByText('Tools'); // config tab rendered
    expect(screen.queryByText('Plugins')).not.toBeInTheDocument();
  });
```

- [ ] Run: `npx vitest run "apps/mission-control/src/renderer/src/routes/agents/\$id.test.tsx"` → new tests FAIL.
- [ ] Modify `AgentConfigTab.tsx`:

1. Add import:

```tsx
import type { PluginView } from '../../../../shared/plugins-ipc.js';
```

2. Extend `ConfigPatch`:

```tsx
type ConfigPatch = {
  model?: string;
  fallbackModels?: string[];
  tools?: string[];
  systemPrompt?: string;
  workspace?: string;
  mcpServers?: string[];
  /** unset = all plugin tools; [] = none. `null` on the wire requests
   *  clearing the field (reset to "all") — RECONCILE WITH PLAN 2. */
  plugins?: string[] | null;
};
```

3. Widen the `openCard` union with `'plugins'`:

```tsx
  const [openCard, setOpenCard] = useState<
    'workspace' | 'models' | 'prompt' | 'tools' | 'connectors' | 'plugins' | null
  >(null);
```

4. Add state + load (next to the Connectors state):

```tsx
  // Plugins assignment state. null draft = "all plugins" (field unset).
  const [toolPlugins, setToolPlugins] = useState<PluginView[]>([]);
  const [pluginsDraft, setPluginsDraft] = useState<string[] | null>(null);
  const [pluginsSaving, setPluginsSaving] = useState(false);

  useEffect(() => {
    window.api
      .pluginsList()
      .then((all) =>
        setToolPlugins(
          all.filter((p) => p.status === 'loaded' && p.capabilities.includes('tools')),
        ),
      )
      .catch(() => {});
  }, []);

  const handleSavePlugins = async (): Promise<void> => {
    setPluginsSaving(true);
    try {
      await updateConfig(agentId, { plugins: pluginsDraft });
      setOpenCard(null);
    } finally {
      setPluginsSaving(false);
    }
  };
```

5. Add a summary next to the other summaries:

```tsx
  const assignedPlugins = agentConfig.plugins;
  const pluginsSummary =
    assignedPlugins === undefined
      ? 'All plugins'
      : assignedPlugins.length === 0
        ? 'None'
        : `${assignedPlugins.length} selected`;
```

6. Add the card after the Connectors card (mirrors its structure; rendered only when a loaded tools-capable plugin exists):

```tsx
      {/* Plugins card */}
      {toolPlugins.length > 0 && (
        <div className="rounded-lg border border-border bg-card-bg">
          <button
            type="button"
            onClick={() => {
              if (openCard !== 'plugins') setPluginsDraft(agentConfig.plugins ?? null);
              setOpenCard(openCard === 'plugins' ? null : 'plugins');
            }}
            className="flex w-full items-center justify-between p-4 text-left"
          >
            <div>
              <h3 className="text-sm font-medium">Plugins</h3>
              <p className="text-xs text-muted mt-0.5">{pluginsSummary}</p>
            </div>
            {openCard === 'plugins' ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>

          {openCard === 'plugins' && (
            <div className="border-t border-border p-4">
              <div className="space-y-2">
                <label className="flex cursor-pointer items-center gap-2 text-xs">
                  <input
                    type="radio"
                    name="agent-plugins-mode"
                    checked={pluginsDraft === null}
                    onChange={() => setPluginsDraft(null)}
                    className="accent-accent"
                  />
                  All plugins (tracks plugins added later automatically)
                </label>
                <label className="flex cursor-pointer items-center gap-2 text-xs">
                  <input
                    type="radio"
                    name="agent-plugins-mode"
                    checked={pluginsDraft !== null}
                    onChange={() => setPluginsDraft(agentConfig.plugins ?? [])}
                    className="accent-accent"
                  />
                  Selected plugins only
                </label>
                {pluginsDraft !== null && (
                  <div className="ml-6 space-y-1">
                    {toolPlugins.map((p) => (
                      <label
                        key={p.name}
                        className="flex cursor-pointer items-center gap-2 text-xs"
                      >
                        <input
                          type="checkbox"
                          checked={pluginsDraft.includes(p.name)}
                          onChange={() =>
                            setPluginsDraft((prev) => {
                              const current = prev ?? [];
                              return current.includes(p.name)
                                ? current.filter((n) => n !== p.name)
                                : [...current, p.name];
                            })
                          }
                          className="accent-accent"
                        />
                        <span className="font-[family-name:var(--font-mono)]">{p.name}</span>
                        <span className="text-muted">
                          ({p.registrations.tools} tool{p.registrations.tools === 1 ? '' : 's'})
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
              <p className="mt-2 text-[11px] text-muted">
                Which plugin tools this agent can use. Takes effect on the agent's next run.
              </p>
              <div className="mt-3 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={handleSavePlugins}
                  disabled={pluginsSaving}
                  className="rounded-lg bg-accent px-3 py-1.5 text-xs text-white hover:bg-primary-hover disabled:opacity-50"
                >
                  {pluginsSaving ? 'Saving...' : 'Save'}
                </button>
                <button
                  type="button"
                  onClick={() => setOpenCard(null)}
                  className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted hover:text-foreground"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
```

- [ ] Run the `$id` tests → PASS.
- [ ] Add FAILING tests to `deploy.test.tsx` (append inside the existing describe — the default `pluginsList` mock resolves `[]`, so existing tests stay green):

```tsx
  it('does not render the Plugins section when no tool plugins are loaded', async () => {
    render(<DeployWizard />);
    await screen.findByText('Deploy Agent');
    expect(screen.queryByText('All plugins')).not.toBeInTheDocument();
  });

  it('includes the selected plugin subset in the deploy payload', async () => {
    mockApi.pluginsList.mockResolvedValue([
      {
        name: 'web-extras',
        version: '1.0.0',
        status: 'loaded',
        capabilities: ['tools'],
        registrations: { tools: 2, channels: 0, providers: 0, hooks: 0 },
        hookCounters: {},
        enabled: true,
      },
    ]);
    const user = userEvent.setup();
    render(<DeployWizard />);
    await user.type(screen.getByPlaceholderText('my-agent'), 'plugged-agent');
    await screen.findByLabelText('All plugins');
    await user.click(screen.getByLabelText('Selected plugins only'));
    await user.click(screen.getByLabelText('web-extras'));
    await user.click(screen.getByRole('button', { name: /next/i }));
    await user.click(screen.getByRole('button', { name: /deploy/i }));
    await waitFor(() =>
      expect(mockApi.agentsCreate).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'plugged-agent', plugins: ['web-extras'] }),
      ),
    );
  });

  it('omits the plugins field when "All plugins" is selected', async () => {
    mockApi.pluginsList.mockResolvedValue([
      {
        name: 'web-extras',
        version: '1.0.0',
        status: 'loaded',
        capabilities: ['tools'],
        registrations: { tools: 2, channels: 0, providers: 0, hooks: 0 },
        hookCounters: {},
        enabled: true,
      },
    ]);
    const user = userEvent.setup();
    render(<DeployWizard />);
    await user.type(screen.getByPlaceholderText('my-agent'), 'all-agent');
    await screen.findByLabelText('All plugins');
    await user.click(screen.getByRole('button', { name: /next/i }));
    await user.click(screen.getByRole('button', { name: /deploy/i }));
    await waitFor(() => expect(mockApi.agentsCreate).toHaveBeenCalled());
    expect('plugins' in mockApi.agentsCreate.mock.calls[0][0]).toBe(false);
  });
```

- [ ] Run: `npx vitest run apps/mission-control/src/renderer/src/routes/deploy.test.tsx` → new tests FAIL.
- [ ] Modify `deploy.tsx`:

1. Add import:

```tsx
import type { PluginView } from '../../../shared/plugins-ipc.js';
```

2. Extend the local `AgentConfig` interface:

```tsx
interface AgentConfig {
  name: string;
  model: string;
  fallbackModels: string[];
  systemPrompt: string;
  tools: string[];
  workspace: string; // '' means auto-generate
  plugins?: string[]; // undefined = all plugin tools (field omitted from the payload)
}
```

3. Add plugin state + load inside `DeployWizard`:

```tsx
  const [toolPlugins, setToolPlugins] = useState<PluginView[]>([]);

  useEffect(() => {
    window.api
      .pluginsList()
      .then((all) =>
        setToolPlugins(
          all.filter((p) => p.status === 'loaded' && p.capabilities.includes('tools')),
        ),
      )
      .catch(() => {});
  }, []);
```

4. In `handleDeploy`, extend the `createAgent` payload (after `workspace: agent.workspace || undefined,`):

```tsx
        ...(agent.plugins !== undefined ? { plugins: agent.plugins } : {}),
```

5. Add the Plugins section in the `agent` step, after the Tools block and before Working Directory:

```tsx
              {toolPlugins.length > 0 && (
                <div>
                  <span className="mb-2 block font-[family-name:var(--font-mono)] text-[11px] uppercase tracking-[2px] text-muted">
                    Plugins
                  </span>
                  <div className="space-y-2">
                    <label className="flex cursor-pointer items-center gap-2 text-sm">
                      <input
                        type="radio"
                        name="plugins-mode"
                        checked={agent.plugins === undefined}
                        onChange={() => setAgent((prev) => ({ ...prev, plugins: undefined }))}
                        className="accent-accent"
                      />
                      All plugins
                    </label>
                    <label className="flex cursor-pointer items-center gap-2 text-sm">
                      <input
                        type="radio"
                        name="plugins-mode"
                        checked={agent.plugins !== undefined}
                        onChange={() => setAgent((prev) => ({ ...prev, plugins: [] }))}
                        className="accent-accent"
                      />
                      Selected plugins only
                    </label>
                    {agent.plugins !== undefined && (
                      <div className="ml-6 space-y-1">
                        {toolPlugins.map((p) => (
                          <label
                            key={p.name}
                            className="flex cursor-pointer items-center gap-2 text-sm"
                          >
                            <input
                              type="checkbox"
                              checked={agent.plugins?.includes(p.name) ?? false}
                              onChange={() =>
                                setAgent((prev) => {
                                  const current = prev.plugins ?? [];
                                  return {
                                    ...prev,
                                    plugins: current.includes(p.name)
                                      ? current.filter((n) => n !== p.name)
                                      : [...current, p.name],
                                  };
                                })
                              }
                              className="accent-accent"
                            />
                            {p.name}
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-muted">
                    Tools from loaded plugins. "All plugins" tracks plugins added later
                    automatically.
                  </p>
                </div>
              )}
```

6. Add a review row in the `review` step (after the Tools `ReviewRow`):

```tsx
                {toolPlugins.length > 0 && (
                  <ReviewRow
                    label="Plugins"
                    value={
                      agent.plugins === undefined
                        ? 'All plugins'
                        : agent.plugins.length > 0
                          ? agent.plugins.join(', ')
                          : '(none)'
                    }
                  />
                )}
```

- [ ] Run: `npx vitest run apps/mission-control/src/renderer/src/routes/deploy.test.tsx "apps/mission-control/src/renderer/src/routes/agents/\$id.test.tsx"` → PASSES.
- [ ] Commit: `git add apps/mission-control/src/renderer/src/routes/agents/-components/AgentConfigTab.tsx "apps/mission-control/src/renderer/src/routes/agents/\$id.test.tsx" apps/mission-control/src/renderer/src/routes/deploy.tsx apps/mission-control/src/renderer/src/routes/deploy.test.tsx && git commit -m "mc(plugins): per-agent plugin assignment on agent detail and deploy wizard"`

---

## Task 12 — Models dropdown plugin tag (TDD)

The model list itself is unchanged — MC renders whatever the gateway returns (`useAvailableModels` → `GET /models`); plugin catalog models simply appear once Plan 2 merges them. The only UI change: where the dropdowns show provider metadata, surface the `source` provenance tag. `ChatModelPicker` is a custom popover with provider group headers → gets a styled "plugin" tag per model. `ModelChainEditor` uses native `<optgroup>/<option>` which cannot host styled elements → gets a ` · plugin` label suffix. No other change needed.

**Files:**
- Modify: `apps/mission-control/src/renderer/src/components/deploy-options.ts`
- Modify: `apps/mission-control/src/renderer/src/hooks/useAvailableModels.ts`
- Modify: `apps/mission-control/src/renderer/src/routes/chat.model-picker.tsx`
- Test: `apps/mission-control/src/renderer/src/routes/chat.model-picker.test.tsx`
- Modify: `apps/mission-control/src/renderer/src/components/ModelChainEditor.tsx`

Steps:

- [ ] Add a FAILING test to `chat.model-picker.test.tsx` (append; build models with the file's existing fixture helper if present, otherwise inline):

```tsx
  it('shows a plugin tag on models with a plugin source', async () => {
    const user = userEvent.setup();
    const models = [
      { value: 'anthropic/claude-opus-4-5', label: 'Claude Opus 4.5', provider: 'anthropic', secretKey: 'anthropic-api-key' },
      { value: 'groq/llama-4-70b', label: 'Llama 4 70B', provider: 'groq', secretKey: 'groq-api-key', source: 'plugin:groq-provider' },
    ];
    render(<ChatModelPicker value="anthropic/claude-opus-4-5" models={models} onChange={() => {}} />);
    await user.click(screen.getByTestId('chat-model-picker-trigger'));
    const option = screen.getByTestId('chat-model-picker-option-groq/llama-4-70b');
    expect(option).toHaveTextContent('plugin');
    expect(screen.getByTestId('chat-model-picker-option-anthropic/claude-opus-4-5')).not.toHaveTextContent('plugin');
  });
```

- [ ] Run: `npx vitest run apps/mission-control/src/renderer/src/routes/chat.model-picker.test.tsx` → FAILS.
- [ ] In `components/deploy-options.ts`, extend `ModelOption`:

```ts
export interface ModelOption {
  value: string; // e.g. 'anthropic/claude-sonnet-4-20250514'
  label: string; // e.g. 'Claude Sonnet 4'
  provider: string; // built-ins: 'anthropic' | 'openai' | 'google'; plugin providers widen this
  secretKey: string; // e.g. 'anthropic-api-key'
  source?: string; // provenance tag for plugin catalog models: 'plugin:<name>'
}
```

(Note: `provider` widens from the three-way union to `string` — plugin providers carry arbitrary ids. `PROVIDER_LABELS[provider] ?? provider` fallbacks in both dropdowns already handle unknown ids.)

- [ ] In `hooks/useAvailableModels.ts`, pass `source` through `toModelOption`:

```ts
function toModelOption(m: {
  value: string;
  label: string;
  provider: string;
  source?: string;
}): ModelOption {
  return {
    value: m.value,
    label: m.label,
    provider: m.provider,
    secretKey: `${m.provider}-api-key`,
    source: m.source,
  };
}
```

- [ ] In `routes/chat.model-picker.tsx`, replace the option's label span (`<span className="truncate">{m.label}</span>`) with:

```tsx
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate">{m.label}</span>
                        {m.source?.startsWith('plugin:') && (
                          <span className="shrink-0 rounded bg-sidebar-hover px-1 py-0.5 text-[9px] uppercase tracking-wide text-muted">
                            plugin
                          </span>
                        )}
                      </span>
```

- [ ] In `components/ModelChainEditor.tsx`, change the `<option>` content (line ~44) from `{m.label}` to:

```tsx
              {m.source?.startsWith('plugin:') ? `${m.label} · plugin` : m.label}
```

- [ ] Run: `npx vitest run apps/mission-control` → all green (the `GatewayModel.source` wire field was added in Task 2).
- [ ] Commit: `git add apps/mission-control/src/renderer/src/components/deploy-options.ts apps/mission-control/src/renderer/src/hooks/useAvailableModels.ts apps/mission-control/src/renderer/src/routes/chat.model-picker.tsx apps/mission-control/src/renderer/src/routes/chat.model-picker.test.tsx apps/mission-control/src/renderer/src/components/ModelChainEditor.tsx && git commit -m "mc(plugins): plugin provenance tag in model dropdowns"`

---

## Task 13 — TEST_PLAN.md Section 28 + amendments

**Files:**
- Modify: `apps/mission-control/TEST_PLAN.md`

Steps:

- [ ] Insert the following new section immediately BEFORE `## Appendix: Test Run Log`:

```markdown
## Section 28: Plugins

**Precondition:** App running. For 28.2+ at least one plugin installed under `<dataDir>/plugins/` and configured in the gateway config's `plugins.entries` block (the in-repo reference plugin under `examples/plugins/` works). For 28.1 only: no plugins installed.

### 28.1 Empty State
1. Navigate to Settings → click the Plugins card
2. **Verify:** Page shows "No plugins installed. Drop a plugin into <dataDir>/plugins/ and enable it here." with the real data directory path rendered

### 28.2 Plugin List
1. With at least one plugin installed and configured, navigate to Settings → Plugins
2. **Verify:** Each plugin row shows: name, version, status pill (loaded = green, disabled = gray, error = red), capability badges (tools/channels/providers/hooks), and an enable toggle
3. **Verify:** A plugin that is discovered on disk but has no `plugins.entries` config shows status "disabled" with the toggle off

### 28.3 Enable/Disable + Restart Banner
1. Toggle a plugin off
2. **Verify:** The toggle flips immediately (optimistic update)
3. **Verify:** A "Restart the gateway to apply plugin changes" banner appears at the top of the Plugins page with a Restart Gateway button
4. Navigate to Settings (index)
5. **Verify:** The same restart notice appears inside the Gateway section, next to the Restart Gateway button
6. Click Restart Gateway (either location); wait for the restart to complete
7. **Verify:** The banner clears; the plugin list reloads; the toggled plugin now shows status "disabled"
8. Toggle it back on and restart again
9. **Verify:** Status returns to "loaded"
10. Stop the gateway (or kill it) and attempt a toggle
11. **Verify:** The toggle reverts and an error message is shown (optimistic revert)

### 28.4 Error Rendering
1. Break a plugin's config (e.g. remove a required field from its `plugins.entries.config`) and restart the gateway
2. Navigate to Settings → Plugins and expand the errored plugin's row
3. **Verify:** Status pill is red "error"
4. **Verify:** Failure detail shows the phase (manifest/compat/config/import/register), the error message, and a timestamp

### 28.5 Registration Summary & Hook Counters
1. Expand a loaded plugin's row
2. **Verify:** A registration summary line like "3 tools · 1 channel · 2 hooks" (only non-zero kinds listed, singular/plural correct)
3. Drive traffic through a hook-registering plugin (e.g. chat with an agent so before_tool_call fires)
4. Reload the Plugins page and expand the row
5. **Verify:** The hook-activity table lists ONLY hooks with activity, columns: Fired / Modified / Blocked / Failed / Timed out
6. Restart the gateway; **Verify:** counters reset (in-memory)

### 28.6 Read-Only Masked Config
1. Expand a configured plugin's row
2. **Verify:** Config fields render from the plugin's configSchema with titles/descriptions, all inputs disabled (no editing in MC v1)
3. **Verify:** Fields marked `sensitive` display "•••" — never the real value
```

- [ ] Apply the following amendments (append each subsection/step inside the named existing section):

1. **Section 3 (AI Providers)** — append:

```markdown
### 3.5 Plugin Provider Card
1. With a provider-capability plugin loaded (e.g. a Groq catalog plugin), navigate to AI Providers
2. **Verify:** A "From Plugins" group appears below the built-ins; the provider card shows a "from plugin: <name>" badge
3. Click Add Key → enter label `default` and a key → Save
4. **Verify:** The key appears on the card; the credential is stored as `<credentialPrefix>:default`
5. Remove the key (inline confirm) → **Verify:** the card returns to Disabled
6. **Verify:** Built-in provider cards (Anthropic/OpenAI/Google) are unchanged, including OAuth buttons
```

2. **Section 5 (Agent Detail Page)** — in 5.3 Configuration Tab, append verify steps:

```markdown
10. With a loaded tools-capability plugin present, **Verify:** a "Plugins" collapsible card appears after Connectors; collapsed summary reads "All plugins" when the agent has no plugin restriction
11. Expand it, choose "Selected plugins only", check a subset, Save → **Verify:** summary shows "N selected"; switch back to "All plugins" and Save → **Verify:** summary returns to "All plugins"
12. With NO tools-capability plugin loaded, **Verify:** the Plugins card is absent entirely
```

3. **Section 15 (Chat — Credential & MCP Banners)** — append:

```markdown
### 15.x Plugin Provider Credentials
1. Set an agent's model to a plugin-provider model (e.g. a Groq model) with no key stored for that provider
2. Send a chat message
3. **Verify:** The missing-credential banner/error names the plugin provider; adding the key on AI Providers (Section 3.5) resolves it
```

4. **Section 18 (Agents List)** — append:

```markdown
### 18.x Plugin Assignment Survives Creation
1. Create an agent via the deploy wizard with "Selected plugins only" and a one-plugin subset (requires a loaded tools-capability plugin)
2. Open the agent's detail → Configuration tab
3. **Verify:** The Plugins card summary shows "1 selected" with the chosen plugin checked
```

5. **Section 20 (Messaging Apps)** — append:

```markdown
### 20.10 Plugin Channel Setup (generic schema flow)
1. With a channel-capability plugin loaded, navigate to Messaging Apps
2. **Verify:** An "Add <adapter>" button appears for the plugin adapter; built-ins keep their bespoke wizards (Telegram/WhatsApp buttons unchanged)
3. Click it → **Verify:** generic setup: connection-name input + a form generated from the adapter's configSchema; sensitive fields are password inputs; titles/descriptions render
4. Leave a required field empty and Continue → **Verify:** inline "<field> is required" error; wizard does not advance
5. Fill the form, choose an assistant, Connect
6. **Verify:** The channel appears in the list with a generic plugin icon and the adapter name

### 20.11 Errored Channel (missing adapter)
1. Disable the channel plugin (Settings → Plugins) and restart the gateway
2. Navigate to Messaging Apps
3. **Verify:** The channel's card shows an "Error" badge and the reason inline; the channel is NOT deleted
4. Open the channel detail → **Verify:** header shows "Error" and a banner explains the adapter is unavailable, pointing to Settings → Plugins
5. Re-enable the plugin and restart → **Verify:** the channel returns to "Connected" with its original configuration intact

6. **Section 22 (Settings)** — append:

```markdown
### 22.5 Settings Index + Plugins Navigation
1. Navigate to Settings
2. **Verify:** A "Plugins" link card appears between the Gateway and About sections
3. Click it → **Verify:** Navigates to the Plugins page (`/settings/plugins`); back arrow returns to Settings
4. Toggle any plugin on the Plugins page, then return to Settings
5. **Verify:** The Gateway section shows the "Restart the gateway to apply plugin changes" notice
6. Click Restart Gateway → wait for success → **Verify:** the notice clears (both on Settings and on the Plugins page)
7. **Verify:** Sidebar "Settings" entry stays highlighted while on `/settings/plugins`
```

7. **Section 24 (Cross-Feature Integration)** — append:

```markdown
### 24.x Plugin Capabilities Propagate After Restart
1. Enable a plugin that registers providers + channels + tools (or a combination across two plugins); restart the gateway
2. **Verify:** AI Providers gains the plugin provider card (3.5)
3. **Verify:** Messaging Apps gains the "Add <adapter>" button (20.10)
4. **Verify:** After adding the provider key, the model dropdowns (deploy wizard, agent Models card, chat model picker) include the plugin's models — the chat picker shows a "plugin" tag, the chain editor shows a " · plugin" label suffix
5. **Verify:** Agent detail Configuration gains the Plugins card (5.3)
6. Disable the plugin and restart → **Verify:** provider card, adapter button, models, and Plugins card all disappear; existing plugin channels show errored state (20.11)
```

- [ ] Commit: `git add apps/mission-control/TEST_PLAN.md && git commit -m "mc(plugins): TEST_PLAN Section 28 and cross-section amendments"`

---

## Task 14 — Final verification

**Files:** none new — full-repo gate.

Steps:

- [ ] Run `npm run lint` → zero errors. Fix any Biome findings (2-space indent, single quotes, semicolons, 100-char lines); re-run until clean. Use `npm run lint:fix` for mechanical fixes only — review its diff.
- [ ] Run `npm run build` → all packages and apps build (also regenerates MC's `routeTree.gen.ts`; confirm `/settings/`, `/settings/plugins`, and `/messaging-apps/new-plugin/$adapter` appear in it — generated, never hand-edited).
- [ ] Run `npm test` → entire suite green, including the new suites:
  - `apps/mission-control/src/shared/plugins-ipc.test.ts`
  - `packages/mc/src/runtime/gateway-client.test.ts` (registerChannel config)
  - `apps/mission-control/src/renderer/src/stores/plugins.test.ts`
  - `apps/mission-control/src/renderer/src/components/SchemaForm.test.tsx`
  - `apps/mission-control/src/renderer/src/routes/settings/-lib/plugins.test.ts`
  - `connections.test.tsx`, `deploy.test.tsx`, `$id.test.tsx`, `chat.model-picker.test.tsx` (extended)
- [ ] Re-check the **Cross-plan reconciliation needed** list at the top of this plan against the merged Plan 2 code: provider listing method/path (Task 4), `POST /channels` `config` field (Tasks 2/4/9), errored-channel fields (Tasks 2/9), `plugins: null` reset handling (Task 11), `listPlugins` envelope unwrapping (Task 4). Resolve or escalate each before declaring done.
- [ ] If the Task 4 fallback `ManagementClient` methods were added and Plan 2 has since landed its own, dedupe now (keep Plan 2's, re-run tests).
- [ ] Manual QA: run TEST_PLAN Sections 28, 3.5, 5.3 (steps 10–12), 20.10–20.11, 22.5, and 24.x per the section-to-feature mapping in CLAUDE.md.
- [ ] Commit any final fixes as focused commits (one concern per commit, specific files only — no `git add -A`).
