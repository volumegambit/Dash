# Model Selection Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add primary + fallback model chain to agent setup, with credential-aware model picker across deploy wizard, settings, and agent detail page.

**Architecture:** All models use `provider/model-id` format (e.g. `anthropic/claude-sonnet-4-20250514`). `ProviderRegistry.resolveProvider` parses the prefix explicitly — no heuristics. `NativeBackend` retries through an ordered chain on retryable errors. A shared `ModelChainEditor` React component is used in three surfaces; it filters models by which provider keys exist in secrets.

**Tech Stack:** TypeScript monorepo, Vitest, React + @testing-library/react, Electron IPC, Zustand, TanStack Router.

**Design doc:** `docs/plans/2026-03-08-model-selection-design.md`

---

### Task 1: Add `bareModelId` utility + update `ProviderRegistry`

**Files:**
- Create: `packages/llm/src/utils.ts`
- Modify: `packages/llm/src/registry.ts`
- Modify: `packages/llm/src/registry.test.ts`
- Modify: `packages/llm/src/index.ts`

**Step 1: Write the failing tests**

Replace entire `packages/llm/src/registry.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ProviderRegistry, bareModelId } from './registry.js';
import type { CompletionRequest, CompletionResponse, LlmProvider, StreamChunk } from './types.js';

function mockProvider(name: string): LlmProvider {
  return {
    name,
    complete: async () => ({}) as CompletionResponse,
    async *stream(): AsyncGenerator<StreamChunk, CompletionResponse> {
      yield { type: 'text_delta' } as StreamChunk;
      return {} as CompletionResponse;
    },
  };
}

describe('ProviderRegistry', () => {
  it('registers and retrieves providers', () => {
    const registry = new ProviderRegistry();
    const provider = mockProvider('test');
    registry.register(provider);
    expect(registry.get('test')).toBe(provider);
    expect(registry.has('test')).toBe(true);
    expect(registry.list()).toEqual(['test']);
  });

  it('throws on unknown provider', () => {
    const registry = new ProviderRegistry();
    expect(() => registry.get('nope')).toThrow('LLM provider "nope" not registered');
  });

  it('resolves provider from provider/model-id format', () => {
    const registry = new ProviderRegistry();
    const anthropic = mockProvider('anthropic');
    const openai = mockProvider('openai');
    const google = mockProvider('google');
    registry.register(anthropic);
    registry.register(openai);
    registry.register(google);

    expect(registry.resolveProvider('anthropic/claude-sonnet-4-20250514')).toBe(anthropic);
    expect(registry.resolveProvider('openai/gpt-4o')).toBe(openai);
    expect(registry.resolveProvider('google/gemini-2.0-flash')).toBe(google);
  });

  it('throws for bare model IDs without provider prefix', () => {
    const registry = new ProviderRegistry();
    registry.register(mockProvider('anthropic'));
    expect(() => registry.resolveProvider('claude-sonnet-4')).toThrow(
      'Invalid model format "claude-sonnet-4": expected "provider/model-id"',
    );
  });
});

describe('bareModelId', () => {
  it('strips provider prefix', () => {
    expect(bareModelId('anthropic/claude-sonnet-4-20250514')).toBe('claude-sonnet-4-20250514');
    expect(bareModelId('openai/gpt-4o')).toBe('gpt-4o');
    expect(bareModelId('google/gemini-2.0-flash')).toBe('gemini-2.0-flash');
  });

  it('returns bare ID unchanged when no slash', () => {
    expect(bareModelId('bare-model')).toBe('bare-model');
  });
});
```

**Step 2: Run to confirm failures**

```bash
npx vitest run packages/llm/src/registry.test.ts
```

Expected: FAIL — `bareModelId` not exported, `resolveProvider` still uses heuristics.

**Step 3: Implement**

Replace `packages/llm/src/registry.ts`:

```ts
import type { LlmProvider } from './types.js';

export function bareModelId(model: string): string {
  const slash = model.indexOf('/');
  return slash !== -1 ? model.slice(slash + 1) : model;
}

export class ProviderRegistry {
  private providers = new Map<string, LlmProvider>();

  register(provider: LlmProvider): void {
    this.providers.set(provider.name, provider);
  }

  get(name: string): LlmProvider {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new Error(
        `LLM provider "${name}" not registered. Available: ${this.list().join(', ')}`,
      );
    }
    return provider;
  }

  has(name: string): boolean {
    return this.providers.has(name);
  }

  list(): string[] {
    return [...this.providers.keys()];
  }

  resolveProvider(model: string): LlmProvider {
    const slash = model.indexOf('/');
    if (slash === -1) {
      throw new Error(`Invalid model format "${model}": expected "provider/model-id"`);
    }
    return this.get(model.slice(0, slash));
  }
}
```

Export `bareModelId` from `packages/llm/src/index.ts` — add to the existing exports:

```ts
export { ProviderRegistry, bareModelId } from './registry.js';
```

**Step 4: Run tests**

```bash
npx vitest run packages/llm/src/registry.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add packages/llm/src/registry.ts packages/llm/src/registry.test.ts packages/llm/src/index.ts
git commit -m "feat(llm): parse provider/model-id format in resolveProvider, add bareModelId"
```

---

### Task 2: Update provider implementations to use `bareModelId`

**Files:**
- Modify: `packages/llm/src/providers/anthropic.ts`
- Modify: `packages/llm/src/providers/google.ts`
- Modify: `packages/llm/src/providers/openai.ts`

**Step 1: Update each provider to strip prefix before API call**

In `anthropic.ts`, add import at the top and use `bareModelId` in both `complete` and `stream`:

```ts
import { bareModelId } from '../registry.js';
```

In `complete`:
```ts
const params: Anthropic.MessageCreateParamsNonStreaming = {
  model: bareModelId(request.model),  // was: request.model
  // ... rest unchanged
};
```

In `stream`:
```ts
const params: Anthropic.MessageCreateParamsStreaming = {
  model: bareModelId(request.model),  // was: request.model
  // ... rest unchanged
};
```

Apply the same pattern to `google.ts` and `openai.ts` — find the line that sets `model: request.model` in each and change it to `model: bareModelId(request.model)`.

**Step 2: Run existing provider tests**

```bash
npx vitest run packages/llm/src/providers/
```

Expected: PASS (the existing tests should still pass — they mock the SDK, so the `bareModelId` call just returns the model string as-is when there's no slash)

**Step 3: Commit**

```bash
git add packages/llm/src/providers/
git commit -m "feat(llm): strip provider prefix before forwarding model ID to SDKs"
```

---

### Task 3: Add `fallbackModels` to agent and config types

**Files:**
- Modify: `packages/agent/src/types.ts`
- Modify: `apps/dash/src/config.ts`
- Modify: `packages/mc/src/types.ts`

**Step 1: No tests needed** — these are type-only changes. TypeScript compiler is the validator.

**Step 2: Update `packages/agent/src/types.ts`**

In `DashAgentConfig`, add:
```ts
fallbackModels?: string[];
```

In `AgentState`, add:
```ts
fallbackModels?: string[];
```

**Step 3: Update `apps/dash/src/config.ts`**

In `AgentConfig` interface, add:
```ts
fallbackModels?: string[];
```

In `DashConfig` interface, change `anthropicApiKey: string` to `anthropicApiKey?: string` (it becomes optional since other providers may be present).

**Step 4: Update `packages/mc/src/types.ts`**

In `AgentDeployAgentConfig`, add:
```ts
fallbackModels?: string[];
```

**Step 5: Build to confirm no type errors**

```bash
npx tsc --noEmit -p packages/agent/tsconfig.json
npx tsc --noEmit -p apps/dash/tsconfig.json
```

Expected: no errors (the new fields are optional so nothing breaks)

**Step 6: Commit**

```bash
git add packages/agent/src/types.ts apps/dash/src/config.ts packages/mc/src/types.ts
git commit -m "feat: add fallbackModels field to agent config types"
```

---

### Task 4: Make provider API keys optional in DashConfig + agent-server

**Files:**
- Modify: `apps/dash/src/config.ts`
- Modify: `apps/dash/src/agent-server.ts`
- Modify: `apps/dash/src/config.test.ts`

**Step 1: Update validation in `config.ts`**

Find the block that throws if `anthropicApiKey` is missing:

```ts
const anthropicApiKey =
  secrets?.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY ?? credentials.anthropic?.apiKey;
if (!anthropicApiKey) {
  throw new Error(
    'Missing ANTHROPIC_API_KEY. Set it in config/credentials.json or as an env var.',
  );
}
```

Replace with:

```ts
const anthropicApiKey =
  secrets?.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY ?? credentials.anthropic?.apiKey;
const googleApiKey =
  secrets?.googleApiKey ?? process.env.GOOGLE_API_KEY ?? credentials.google?.apiKey;
const openaiApiKey =
  secrets?.openaiApiKey ?? process.env.OPENAI_API_KEY ?? credentials.openai?.apiKey;

if (!anthropicApiKey && !googleApiKey && !openaiApiKey) {
  throw new Error(
    'No LLM provider API key configured. Set at least one API key (Anthropic, Google, or OpenAI).',
  );
}
```

**Step 2: Update `agent-server.ts`**

Change the unconditional Anthropic registration:

```ts
// Before:
registry.register(new AnthropicProvider(config.anthropicApiKey));

// After:
if (config.anthropicApiKey) {
  registry.register(new AnthropicProvider(config.anthropicApiKey));
}
```

Add a guard after all registrations:

```ts
if (registry.list().length === 0) {
  throw new Error('No LLM providers registered. Configure at least one API key.');
}
```

**Step 3: Update `config.test.ts`**

Find any test that asserts the error `'Missing ANTHROPIC_API_KEY'` and update the message to match the new error text. Also check for any test that provides only `anthropicApiKey` — those still pass. Add a test for the new multi-provider validation:

Check the existing tests and update the expected error string in the "throws when no API key" test:

```ts
// Find a test like:
it('throws when anthropic key is missing', async () => {
  // ... update expected message to:
  await expect(loadConfig(...)).rejects.toThrow(
    'No LLM provider API key configured',
  );
});
```

**Step 4: Run config tests**

```bash
npx vitest run apps/dash/src/config.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add apps/dash/src/config.ts apps/dash/src/agent-server.ts apps/dash/src/config.test.ts
git commit -m "feat(dash): make provider API keys optional, register any configured provider"
```

---

### Task 5: Update `AgentSecretsFile` + `ProcessRuntime.deploy` for multi-provider

**Files:**
- Modify: `packages/mc/src/runtime/process.ts`
- Modify: `packages/mc/src/runtime/process.test.ts`

**Step 1: Update `AgentSecretsFile`**

Change:
```ts
export interface AgentSecretsFile {
  anthropicApiKey: string;
  managementToken: string;
  chatToken: string;
}
```

To:
```ts
export interface AgentSecretsFile {
  anthropicApiKey?: string;
  googleApiKey?: string;
  openaiApiKey?: string;
  managementToken: string;
  chatToken: string;
}
```

**Step 2: Update `ProcessRuntime.deploy` secrets block**

Find:
```ts
const anthropicApiKey = await this.secrets.get('anthropic-api-key');
if (!anthropicApiKey) {
  throw new Error(
    'Missing anthropic-api-key in secret store. Run `mc deploy` to be prompted, or set it manually.',
  );
}

const agentSecretsFile: AgentSecretsFile = {
  anthropicApiKey,
  managementToken,
  chatToken,
};
```

Replace with:
```ts
const anthropicApiKey = (await this.secrets.get('anthropic-api-key')) ?? undefined;
const googleApiKey = (await this.secrets.get('google-api-key')) ?? undefined;
const openaiApiKey = (await this.secrets.get('openai-api-key')) ?? undefined;

if (!anthropicApiKey && !googleApiKey && !openaiApiKey) {
  throw new Error(
    'No provider API key configured. Add at least one API key in Mission Control Settings.',
  );
}

const agentSecretsFile: AgentSecretsFile = {
  anthropicApiKey,
  googleApiKey,
  openaiApiKey,
  managementToken,
  chatToken,
};
```

**Step 3: Also update the `AgentCfg` local interface and config reading in `deploy`**

Find the local `AgentCfg` interface inside `deploy`:
```ts
interface AgentCfg {
  name: string;
  model: string;
  systemPrompt: string;
  tools?: string[];
}
```

Add `fallbackModels`:
```ts
interface AgentCfg {
  name: string;
  model: string;
  fallbackModels?: string[];
  systemPrompt: string;
  tools?: string[];
}
```

Find the line that builds `agentConfigs[name]`:
```ts
agentConfigs[name] = {
  name,
  model: cfg.model ?? '',
  systemPrompt: cfg.systemPrompt ?? '',
  tools: cfg.tools,
};
```

Add `fallbackModels`:
```ts
agentConfigs[name] = {
  name,
  model: cfg.model ?? '',
  fallbackModels: cfg.fallbackModels,
  systemPrompt: cfg.systemPrompt ?? '',
  tools: cfg.tools,
};
```

**Step 4: Run process tests**

```bash
npx vitest run packages/mc/src/runtime/process.test.ts
```

Expected: PASS (the mock secrets store in tests returns null for missing keys, which now maps to undefined — verify the tests pass with this change)

**Step 5: Commit**

```bash
git add packages/mc/src/runtime/process.ts packages/mc/src/runtime/process.test.ts
git commit -m "feat(mc): support multi-provider secrets in ProcessRuntime.deploy"
```

---

### Task 6: Update `NativeBackend` with fallback chain

**Files:**
- Modify: `packages/agent/src/backends/native.ts`
- Create: `packages/agent/src/backends/native.test.ts`

**Step 1: Write the failing test**

Create `packages/agent/src/backends/native.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { NativeBackend } from './native.js';
import type { AgentBackend, AgentState } from '../types.js';
import type { LlmProvider, CompletionResponse, StreamChunk } from '@dash/llm';

function makeState(model: string, fallbackModels?: string[]): AgentState {
  return {
    session: {
      id: 'test',
      channelId: 'ch',
      conversationId: 'conv',
      createdAt: new Date().toISOString(),
      messages: [],
    },
    systemPrompt: 'you are helpful',
    model,
    fallbackModels,
  };
}

function makeProvider(name: string, shouldFail = false): LlmProvider {
  return {
    name,
    complete: async () => ({}) as CompletionResponse,
    async *stream(): AsyncGenerator<StreamChunk, CompletionResponse> {
      if (shouldFail) throw new Error('429 rate limit exceeded');
      yield { type: 'text_delta', text: `response from ${name}` };
      yield { type: 'stop', stopReason: 'end_turn' };
      return {
        content: `response from ${name}`,
        model: name,
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: 'end_turn',
      } as CompletionResponse;
    },
  };
}

describe('NativeBackend fallback', () => {
  it('uses primary model when it succeeds', async () => {
    const provider = makeProvider('primary');
    const backend = new NativeBackend(provider);
    const events: string[] = [];

    for await (const event of backend.run(makeState('anthropic/primary'), {})) {
      if (event.type === 'text_delta') events.push(event.text);
    }

    expect(events).toContain('response from primary');
  });

  it('falls back to next model on retryable error', async () => {
    // Provider that fails for primary model, succeeds for fallback
    let callCount = 0;
    const provider: LlmProvider = {
      name: 'test',
      complete: async () => ({}) as CompletionResponse,
      async *stream(): AsyncGenerator<StreamChunk, CompletionResponse> {
        callCount++;
        if (callCount === 1) throw new Error('429 rate limit exceeded');
        yield { type: 'text_delta', text: 'fallback response' };
        yield { type: 'stop', stopReason: 'end_turn' };
        return {
          content: 'fallback response',
          model: 'fallback',
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: 'end_turn',
        } as CompletionResponse;
      },
    };

    const backend = new NativeBackend(provider);
    const events: Array<{ type: string; text?: string }> = [];

    for await (const event of backend.run(
      makeState('test/primary', ['test/fallback']),
      {},
    )) {
      events.push(event);
    }

    const switchMsg = events.find(
      (e) => e.type === 'text_delta' && e.text?.includes('Switching to fallback'),
    );
    const response = events.find((e) => e.type === 'response');
    expect(switchMsg).toBeDefined();
    expect(response).toBeDefined();
  });

  it('yields error after all models exhausted', async () => {
    const provider: LlmProvider = {
      name: 'test',
      complete: async () => ({}) as CompletionResponse,
      async *stream(): AsyncGenerator<StreamChunk, CompletionResponse> {
        throw new Error('503 service unavailable');
        yield { type: 'stop' } as StreamChunk;
        return {} as CompletionResponse;
      },
    };

    const backend = new NativeBackend(provider);
    const events: Array<{ type: string }> = [];

    for await (const event of backend.run(
      makeState('test/primary', ['test/fallback1']),
      {},
    )) {
      events.push(event);
    }

    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
  });
});
```

**Step 2: Run to confirm failure**

```bash
npx vitest run packages/agent/src/backends/native.test.ts
```

Expected: FAIL — `native.test.ts` imports work but fallback logic doesn't exist yet.

**Step 3: Refactor `native.ts`**

Add `isRetryableError` at module level (above the class):

```ts
function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return (
    msg.includes('429') ||
    msg.includes('rate limit') ||
    msg.includes('500') ||
    msg.includes('503') ||
    msg.includes('overloaded') ||
    msg.includes('service unavailable')
  );
}
```

Rename the existing `run` body to `runWithModel` — create a new private method with the same signature as the current `run`. Move the entire existing `for` loop and try/catch inside it, but **remove the outer try/catch** (let errors propagate):

```ts
private async *runWithModel(
  state: AgentState,
  options: RunOptions,
): AsyncGenerator<AgentEvent> {
  const toolDefs = state.tools?.map((t) => t.definition);
  const toolMap = new Map(state.tools?.map((t) => [t.name, t]) ?? []);

  const totalUsage = { inputTokens: 0, outputTokens: 0 };
  let finalTextContent = '';

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (this.abortController!.signal.aborted) break;

    // ... (entire existing loop body, unchanged) ...
  }

  yield {
    type: 'response',
    content: finalTextContent || '(max tool rounds reached)',
    usage: totalUsage,
  };
  // Note: no try/catch — errors propagate to the caller (run)
}
```

Replace the public `run` method with the chain-aware version:

```ts
async *run(state: AgentState, options: RunOptions): AsyncGenerator<AgentEvent> {
  this.abortController = new AbortController();
  const modelChain = [state.model, ...(state.fallbackModels ?? [])];
  let modelIndex = 0;

  while (modelIndex < modelChain.length) {
    const activeModel = modelChain[modelIndex];
    try {
      yield* this.runWithModel({ ...state, model: activeModel }, options);
      return;
    } catch (error) {
      if (isRetryableError(error) && modelIndex < modelChain.length - 1) {
        modelIndex++;
        yield {
          type: 'text_delta',
          text: `\n[Switching to fallback model: ${modelChain[modelIndex]}]\n`,
        };
        continue;
      }
      yield { type: 'error', error: error as Error };
      return;
    }
  }
}
```

**Step 4: Run tests**

```bash
npx vitest run packages/agent/src/backends/native.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add packages/agent/src/backends/native.ts packages/agent/src/backends/native.test.ts
git commit -m "feat(agent): implement ordered fallback chain in NativeBackend"
```

---

### Task 7: Create `SettingsStore`

**Files:**
- Create: `packages/mc/src/settings-store.ts`
- Create: `packages/mc/src/settings-store.test.ts`
- Modify: `packages/mc/src/index.ts`

**Step 1: Write the failing test**

Create `packages/mc/src/settings-store.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsStore } from './settings-store.js';

describe('SettingsStore', () => {
  let dir: string;
  let store: SettingsStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'settings-test-'));
    store = new SettingsStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true });
  });

  it('returns empty object when file does not exist', async () => {
    const settings = await store.get();
    expect(settings).toEqual({});
  });

  it('persists and retrieves settings', async () => {
    await store.set({ defaultModel: 'anthropic/claude-sonnet-4-20250514' });
    const settings = await store.get();
    expect(settings.defaultModel).toBe('anthropic/claude-sonnet-4-20250514');
  });

  it('merges patch into existing settings', async () => {
    await store.set({ defaultModel: 'anthropic/claude-sonnet-4-20250514' });
    await store.set({ defaultFallbackModels: ['anthropic/claude-haiku-4-5-20251001'] });
    const settings = await store.get();
    expect(settings.defaultModel).toBe('anthropic/claude-sonnet-4-20250514');
    expect(settings.defaultFallbackModels).toEqual(['anthropic/claude-haiku-4-5-20251001']);
  });

  it('overwrites a key on set', async () => {
    await store.set({ defaultModel: 'anthropic/claude-sonnet-4-20250514' });
    await store.set({ defaultModel: 'openai/gpt-4o' });
    const settings = await store.get();
    expect(settings.defaultModel).toBe('openai/gpt-4o');
  });
});
```

**Step 2: Run to confirm failure**

```bash
npx vitest run packages/mc/src/settings-store.test.ts
```

Expected: FAIL — module not found.

**Step 3: Create `settings-store.ts`**

```ts
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface AppSettings {
  defaultModel?: string;
  defaultFallbackModels?: string[];
}

export class SettingsStore {
  private filePath: string;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, 'settings.json');
  }

  async get(): Promise<AppSettings> {
    if (!existsSync(this.filePath)) return {};
    const raw = await readFile(this.filePath, 'utf-8');
    return JSON.parse(raw) as AppSettings;
  }

  async set(patch: Partial<AppSettings>): Promise<void> {
    const current = await this.get();
    const updated = { ...current, ...patch };
    await writeFile(this.filePath, JSON.stringify(updated, null, 2));
  }
}
```

**Step 4: Export from `packages/mc/src/index.ts`**

Add:
```ts
export { SettingsStore } from './settings-store.js';
export type { AppSettings } from './settings-store.js';
```

**Step 5: Run tests**

```bash
npx vitest run packages/mc/src/settings-store.test.ts
```

Expected: PASS

**Step 6: Commit**

```bash
git add packages/mc/src/settings-store.ts packages/mc/src/settings-store.test.ts packages/mc/src/index.ts
git commit -m "feat(mc): add SettingsStore for persisting global model chain defaults"
```

---

### Task 8: Add `updateAgentConfig` to `ProcessRuntime`

**Files:**
- Modify: `packages/mc/src/runtime/process.ts`
- Modify: `packages/mc/src/runtime/process.test.ts`

**Step 1: Write the failing test**

Open `packages/mc/src/runtime/process.test.ts` and add a test for `updateAgentConfig`. Find the existing test structure and add after existing deploy tests:

```ts
describe('ProcessRuntime.updateAgentConfig', () => {
  it('rewrites model and fallbackModels in the agent JSON file', async () => {
    // Setup: create a temp config dir with an agent JSON
    const configDir = await mkdtemp(join(tmpdir(), 'mc-update-test-'));
    const agentsDir = join(configDir, 'agents');
    await mkdir(agentsDir, { recursive: true });
    await writeFile(
      join(agentsDir, 'my-agent.json'),
      JSON.stringify({ model: 'anthropic/claude-sonnet-4-20250514', systemPrompt: 'hello' }),
    );

    // Create a fake registry that returns a deployment with the configDir
    const fakeDeployment = {
      id: 'test-id',
      configDir,
      status: 'running',
      name: 'my-agent',
      target: 'local',
      createdAt: new Date().toISOString(),
      config: { target: 'local', channels: {} },
    };
    const fakeRegistry = {
      get: async () => fakeDeployment,
      list: async () => [fakeDeployment],
      add: async () => {},
      update: async () => {},
      remove: async () => {},
    };
    const fakeSecrets = {
      get: async () => null,
      set: async () => {},
      delete: async () => {},
      list: async () => [],
    };

    const runtime = new ProcessRuntime(fakeRegistry as any, fakeSecrets as any, '/');
    await runtime.updateAgentConfig('test-id', {
      model: 'openai/gpt-4o',
      fallbackModels: ['anthropic/claude-haiku-4-5-20251001'],
    });

    const updated = JSON.parse(
      await readFile(join(agentsDir, 'my-agent.json'), 'utf-8'),
    );
    expect(updated.model).toBe('openai/gpt-4o');
    expect(updated.fallbackModels).toEqual(['anthropic/claude-haiku-4-5-20251001']);
    expect(updated.systemPrompt).toBe('hello'); // unchanged

    await rm(configDir, { recursive: true });
  });
});
```

Make sure to add `mkdir`, `writeFile`, `readFile`, `rm` from `node:fs/promises` to the imports at the top of the test file (they may already be present — check and add only what's missing).

**Step 2: Run to confirm failure**

```bash
npx vitest run packages/mc/src/runtime/process.test.ts
```

Expected: FAIL — `updateAgentConfig` method does not exist.

**Step 3: Implement `updateAgentConfig` in `process.ts`**

Add this method to the `ProcessRuntime` class:

```ts
async updateAgentConfig(
  id: string,
  patch: { model?: string; fallbackModels?: string[] },
): Promise<void> {
  const deployment = await this.registry.get(id);
  if (!deployment) throw new Error(`Deployment "${id}" not found`);

  const configDir = deployment.configDir;
  if (!configDir) throw new Error(`Deployment "${id}" has no config directory`);

  const agentsDir = join(configDir, 'agents');
  const files = await readdir(agentsDir);
  const jsonFile = files.find((f) => f.endsWith('.json'));
  if (!jsonFile) throw new Error(`No agent config file found in ${agentsDir}`);

  const filePath = join(agentsDir, jsonFile);
  const raw = await readFile(filePath, 'utf-8');
  const config = JSON.parse(raw) as Record<string, unknown>;

  if (patch.model !== undefined) config.model = patch.model;
  if (patch.fallbackModels !== undefined) config.fallbackModels = patch.fallbackModels;

  await writeFile(filePath, JSON.stringify(config, null, 2));
}
```

**Step 4: Run tests**

```bash
npx vitest run packages/mc/src/runtime/process.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add packages/mc/src/runtime/process.ts packages/mc/src/runtime/process.test.ts
git commit -m "feat(mc): add ProcessRuntime.updateAgentConfig for post-deploy model chain edits"
```

---

### Task 9: Update IPC shared types + preload

**Files:**
- Modify: `apps/mission-control/src/shared/ipc.ts`
- Modify: `apps/mission-control/src/preload/index.ts`

**Step 1: No unit tests** — IPC types are validated by TypeScript.

**Step 2: Update `DeployWithConfigOptions` in `shared/ipc.ts`**

Add `fallbackModels` to the interface:
```ts
export interface DeployWithConfigOptions {
  name: string;
  model: string;
  fallbackModels?: string[];
  systemPrompt: string;
  tools: string[];
  enableTelegram: boolean;
}
```

**Step 3: Add settings and updateConfig to `MissionControlAPI`**

First add the `AppSettings` type import at the top (or inline it):

```ts
export interface AppSettings {
  defaultModel?: string;
  defaultFallbackModels?: string[];
}
```

Add to `MissionControlAPI`:
```ts
// Settings
settingsGet(): Promise<AppSettings>;
settingsSet(patch: Partial<AppSettings>): Promise<void>;

// Add to Deployments section:
deploymentsUpdateConfig(
  id: string,
  patch: { model?: string; fallbackModels?: string[] },
): Promise<void>;
```

**Step 4: Wire in `preload/index.ts`**

Add to the `api` object:

```ts
// Settings
settingsGet: () => ipcRenderer.invoke('settings:get'),
settingsSet: (patch) => ipcRenderer.invoke('settings:set', patch),

// In deployments section:
deploymentsUpdateConfig: (id, patch) =>
  ipcRenderer.invoke('deployments:updateConfig', id, patch),
```

**Step 5: Build check**

```bash
npx tsc --noEmit -p apps/mission-control/tsconfig.json
```

Expected: errors only if the main IPC handlers haven't been added yet (those come next). Alternatively just check the preload compiles:

```bash
npx tsc --noEmit -p apps/mission-control/tsconfig.node.json
```

**Step 6: Commit**

```bash
git add apps/mission-control/src/shared/ipc.ts apps/mission-control/src/preload/index.ts
git commit -m "feat(mc-ipc): add settings and deploymentsUpdateConfig to IPC interface"
```

---

### Task 10: Add new IPC handlers in main process

**Files:**
- Modify: `apps/mission-control/src/main/ipc.ts`
- Modify: `apps/mission-control/src/shared/ipc.test.ts` (if it exists — skip if only type tests)

**Step 1: Add `SettingsStore` import and singleton**

At the top of `ipc.ts`, import:
```ts
import { SettingsStore } from '@dash/mc';
```

Add a singleton getter alongside the existing ones:

```ts
let settingsStore: SettingsStore | undefined;

function getSettingsStore(): SettingsStore {
  if (!settingsStore) {
    settingsStore = new SettingsStore(DATA_DIR);
  }
  return settingsStore;
}
```

**Step 2: Add new IPC handlers**

At the end of `registerIpcHandlers`, before the closing `}`, add:

```ts
// Settings handlers
ipcMain.handle('settings:get', async () => {
  return getSettingsStore().get();
});

ipcMain.handle('settings:set', async (_event, patch: Partial<{ defaultModel: string; defaultFallbackModels: string[] }>) => {
  return getSettingsStore().set(patch);
});

// Update agent config
ipcMain.handle(
  'deployments:updateConfig',
  async (_event, id: string, patch: { model?: string; fallbackModels?: string[] }) => {
    return getRuntime().updateAgentConfig(id, patch);
  },
);
```

**Step 3: Update `deployments:deployWithConfig` handler**

Find:
```ts
const agentConfig = {
  name,
  model,
  systemPrompt,
  tools: tools.length > 0 ? tools : undefined,
};
```

Update to:
```ts
const { name, model, fallbackModels, systemPrompt, tools, enableTelegram } = options;
// ...
const agentConfig = {
  name,
  model,
  fallbackModels: fallbackModels && fallbackModels.length > 0 ? fallbackModels : undefined,
  systemPrompt,
  tools: tools.length > 0 ? tools : undefined,
};
```

**Step 4: Update `setup:getStatus` to accept any provider key**

Find:
```ts
const apiKey = await store.get('anthropic-api-key');
return { needsSetup: false, needsApiKey: !apiKey };
```

Replace with:
```ts
const providerKeys = ['anthropic-api-key', 'openai-api-key', 'google-api-key'];
const keyValues = await Promise.all(providerKeys.map((k) => store.get(k)));
const hasAnyKey = keyValues.some(Boolean);
return { needsSetup: false, needsApiKey: !hasAnyKey };
```

**Step 5: Build check**

```bash
npx tsc --noEmit -p apps/mission-control/tsconfig.node.json
```

Expected: no errors

**Step 6: Commit**

```bash
git add apps/mission-control/src/main/ipc.ts
git commit -m "feat(mc-main): add settings IPC handlers, updateConfig, multi-provider setup check"
```

---

### Task 11: Extend `deploy-options.ts` with provider-annotated models

**Files:**
- Modify: `apps/mission-control/src/renderer/src/components/deploy-options.ts`
- Modify: `apps/mission-control/src/renderer/src/components/deploy-options.test.ts`

**Step 1: Write the new tests**

Replace `deploy-options.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { AVAILABLE_MODELS } from './deploy-options.js';

describe('AVAILABLE_MODELS', () => {
  it('all models use provider/model-id format', () => {
    for (const m of AVAILABLE_MODELS) {
      expect(m.value, `${m.value} must contain a slash`).toContain('/');
    }
  });

  it('all models have a provider field', () => {
    for (const m of AVAILABLE_MODELS) {
      expect(['anthropic', 'openai', 'google']).toContain(m.provider);
    }
  });

  it('all models have a secretKey field', () => {
    for (const m of AVAILABLE_MODELS) {
      expect(m.secretKey).toBeTruthy();
    }
  });

  it('includes Claude, GPT, and Gemini models', () => {
    const providers = new Set(AVAILABLE_MODELS.map((m) => m.provider));
    expect(providers.has('anthropic')).toBe(true);
    expect(providers.has('openai')).toBe(true);
    expect(providers.has('google')).toBe(true);
  });

  it('anthropic models use anthropic-api-key', () => {
    const anthropicModels = AVAILABLE_MODELS.filter((m) => m.provider === 'anthropic');
    for (const m of anthropicModels) {
      expect(m.secretKey).toBe('anthropic-api-key');
    }
  });
});
```

**Step 2: Run to confirm failure**

```bash
npx vitest run apps/mission-control/src/renderer/src/components/deploy-options.test.ts
```

Expected: FAIL — `ModelOption` lacks `provider` and `secretKey`, models don't use `provider/` format.

**Step 3: Replace `deploy-options.ts`**

```ts
export interface ModelOption {
  value: string;    // e.g. 'anthropic/claude-sonnet-4-20250514'
  label: string;    // e.g. 'Claude Sonnet 4'
  provider: 'anthropic' | 'openai' | 'google';
  secretKey: string; // e.g. 'anthropic-api-key'
}

export interface ToolOption {
  value: string;
  label: string;
}

export const AVAILABLE_MODELS: ModelOption[] = [
  {
    value: 'anthropic/claude-sonnet-4-20250514',
    label: 'Claude Sonnet 4',
    provider: 'anthropic',
    secretKey: 'anthropic-api-key',
  },
  {
    value: 'anthropic/claude-haiku-4-5-20251001',
    label: 'Claude Haiku 4.5',
    provider: 'anthropic',
    secretKey: 'anthropic-api-key',
  },
  {
    value: 'openai/gpt-4o',
    label: 'GPT-4o',
    provider: 'openai',
    secretKey: 'openai-api-key',
  },
  {
    value: 'openai/o3-mini',
    label: 'o3 mini',
    provider: 'openai',
    secretKey: 'openai-api-key',
  },
  {
    value: 'google/gemini-2.0-flash',
    label: 'Gemini 2.0 Flash',
    provider: 'google',
    secretKey: 'google-api-key',
  },
];

export const AVAILABLE_TOOLS: ToolOption[] = [
  { value: 'read_file', label: 'Read File' },
  { value: 'write_file', label: 'Write File' },
  { value: 'list_directory', label: 'List Directory' },
  { value: 'execute_command', label: 'Execute Command' },
  { value: 'web_search', label: 'Web Search' },
  { value: 'web_fetch', label: 'Web Fetch' },
];
```

**Step 4: Run tests**

```bash
npx vitest run apps/mission-control/src/renderer/src/components/deploy-options.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add apps/mission-control/src/renderer/src/components/deploy-options.ts apps/mission-control/src/renderer/src/components/deploy-options.test.ts
git commit -m "feat(mc): extend AVAILABLE_MODELS with OpenAI and Google, add provider/secretKey metadata"
```

---

### Task 12: Extend `providers.ts` setup wizard with OpenAI and Google

**Files:**
- Modify: `apps/mission-control/src/renderer/src/components/providers.ts`
- Modify: `apps/mission-control/src/renderer/src/components/providers.test.ts`
- Note: `SetupWizard.test.tsx` has a test for "Claude by Anthropic" — it will still pass since Anthropic remains the first/default provider.

**Step 1: Update `providers.ts`**

Replace entirely:

```ts
export type Provider = 'anthropic' | 'openai' | 'google';

export interface ProviderOption {
  id: Provider;
  name: string;
  description: string;
  available: boolean;
}

export interface ProviderConfig {
  title: string;
  secretKey: string;
  placeholder: string;
  consoleUrl: string;
  apiKeysUrl: string;
  helpUrl: string;
  helpLabel: string;
  explanation: string;
  steps: string[];
}

export const PROVIDERS: ProviderOption[] = [
  {
    id: 'anthropic',
    name: 'Claude by Anthropic',
    description: 'A powerful AI assistant known for being helpful, harmless, and honest.',
    available: true,
  },
  {
    id: 'openai',
    name: 'OpenAI (GPT-4o, o3)',
    description: 'GPT-4o and reasoning models from OpenAI.',
    available: true,
  },
  {
    id: 'google',
    name: 'Google Gemini',
    description: 'Fast and capable models from Google DeepMind.',
    available: true,
  },
];

export const PROVIDER_CONFIG: Record<Provider, ProviderConfig> = {
  anthropic: {
    title: 'Connect to Claude',
    secretKey: 'anthropic-api-key',
    placeholder: 'sk-ant-...',
    consoleUrl: 'https://console.anthropic.com',
    apiKeysUrl: 'https://console.anthropic.com/settings/keys',
    helpUrl: 'https://docs.anthropic.com/en/docs/initial-setup#prerequisites',
    helpLabel: 'How to get your API key',
    explanation:
      'To connect your agents to Claude, you need an API key. This is a secret code that gives your agents permission to use the Claude AI service.',
    steps: [
      'Click "Create Key", give it a name, and copy the key.',
      'Paste it below. It starts with sk-ant-.',
    ],
  },
  openai: {
    title: 'Connect to OpenAI',
    secretKey: 'openai-api-key',
    placeholder: 'sk-...',
    consoleUrl: 'https://platform.openai.com',
    apiKeysUrl: 'https://platform.openai.com/api-keys',
    helpUrl: 'https://platform.openai.com/docs/quickstart',
    helpLabel: 'OpenAI quickstart guide',
    explanation:
      'To use GPT-4o and other OpenAI models, you need an API key from the OpenAI platform.',
    steps: [
      'Click "Create new secret key", give it a name, and copy the key.',
      'Paste it below. It starts with sk-.',
    ],
  },
  google: {
    title: 'Connect to Google Gemini',
    secretKey: 'google-api-key',
    placeholder: 'AIza...',
    consoleUrl: 'https://aistudio.google.com',
    apiKeysUrl: 'https://aistudio.google.com/app/apikey',
    helpUrl: 'https://ai.google.dev/gemini-api/docs/quickstart',
    helpLabel: 'Gemini API quickstart',
    explanation:
      'To use Gemini models, you need an API key from Google AI Studio.',
    steps: [
      'Click "Create API key", select a project, and copy the key.',
      'Paste it below. It starts with AIza.',
    ],
  },
};
```

**Step 2: Run provider tests**

```bash
npx vitest run apps/mission-control/src/renderer/src/components/providers.test.ts
```

Expected: PASS (the existing tests check for at least one available provider, matching config entries, valid URLs — all still hold)

**Step 3: Run SetupWizard tests to confirm nothing broke**

```bash
npx vitest run apps/mission-control/src/renderer/src/components/SetupWizard.test.tsx
```

Expected: PASS — the wizard test checks for "Claude by Anthropic" as the default which is still first in the list.

**Step 4: Commit**

```bash
git add apps/mission-control/src/renderer/src/components/providers.ts
git commit -m "feat(mc): add OpenAI and Google to setup wizard provider list"
```

---

### Task 13: Create `useAvailableModels` hook

**Files:**
- Create: `apps/mission-control/src/renderer/src/hooks/useAvailableModels.ts`

**Step 1: No separate unit test** — this hook calls `window.api` which is mocked in integration. The deploy wizard test in Task 16 will validate its behavior end-to-end.

**Step 2: Create the hook**

```ts
import { useEffect, useState } from 'react';
import { AVAILABLE_MODELS } from '../components/deploy-options.js';
import type { ModelOption } from '../components/deploy-options.js';

export function useAvailableModels(): ModelOption[] {
  const [secretKeys, setSecretKeys] = useState<string[]>([]);

  useEffect(() => {
    window.api.secretsList().then(setSecretKeys).catch(() => setSecretKeys([]));
  }, []);

  return AVAILABLE_MODELS.filter((m) => secretKeys.includes(m.secretKey));
}
```

**Step 3: Commit**

```bash
git add apps/mission-control/src/renderer/src/hooks/useAvailableModels.ts
git commit -m "feat(mc): add useAvailableModels hook for credential-aware model filtering"
```

---

### Task 14: Create `ModelChainEditor` component

**Files:**
- Create: `apps/mission-control/src/renderer/src/components/ModelChainEditor.tsx`
- Create: `apps/mission-control/src/renderer/src/components/ModelChainEditor.test.tsx`

**Step 1: Write the failing tests**

```tsx
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ModelChainEditor } from './ModelChainEditor.js';
import type { ModelOption } from './deploy-options.js';

const models: ModelOption[] = [
  { value: 'anthropic/claude-sonnet-4-20250514', label: 'Claude Sonnet 4', provider: 'anthropic', secretKey: 'anthropic-api-key' },
  { value: 'anthropic/claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', provider: 'anthropic', secretKey: 'anthropic-api-key' },
  { value: 'openai/gpt-4o', label: 'GPT-4o', provider: 'openai', secretKey: 'openai-api-key' },
];

describe('ModelChainEditor', () => {
  it('renders primary model selector', () => {
    const onChange = vi.fn();
    render(
      <ModelChainEditor
        model="anthropic/claude-sonnet-4-20250514"
        fallbackModels={[]}
        availableModels={models}
        onChange={onChange}
      />,
    );
    expect(screen.getByDisplayValue('Claude Sonnet 4')).toBeInTheDocument();
  });

  it('calls onChange when primary model changes', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ModelChainEditor
        model="anthropic/claude-sonnet-4-20250514"
        fallbackModels={[]}
        availableModels={models}
        onChange={onChange}
      />,
    );
    await user.selectOptions(screen.getByRole('combobox', { name: /primary model/i }), 'openai/gpt-4o');
    expect(onChange).toHaveBeenCalledWith('openai/gpt-4o', []);
  });

  it('renders fallback model rows', () => {
    const onChange = vi.fn();
    render(
      <ModelChainEditor
        model="anthropic/claude-sonnet-4-20250514"
        fallbackModels={['openai/gpt-4o']}
        availableModels={models}
        onChange={onChange}
      />,
    );
    expect(screen.getByDisplayValue('GPT-4o')).toBeInTheDocument();
  });

  it('adds a fallback model on "Add fallback" click', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ModelChainEditor
        model="anthropic/claude-sonnet-4-20250514"
        fallbackModels={[]}
        availableModels={models}
        onChange={onChange}
      />,
    );
    await user.click(screen.getByText('Add fallback'));
    expect(onChange).toHaveBeenCalled();
    const [, fallbacks] = onChange.mock.calls[0] as [string, string[]];
    expect(fallbacks.length).toBe(1);
  });

  it('removes a fallback model on remove click', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ModelChainEditor
        model="anthropic/claude-sonnet-4-20250514"
        fallbackModels={['openai/gpt-4o']}
        availableModels={models}
        onChange={onChange}
      />,
    );
    await user.click(screen.getByRole('button', { name: /remove fallback/i }));
    expect(onChange).toHaveBeenCalledWith('anthropic/claude-sonnet-4-20250514', []);
  });

  it('shows empty state when no models available', () => {
    const onChange = vi.fn();
    render(
      <ModelChainEditor
        model=""
        fallbackModels={[]}
        availableModels={[]}
        onChange={onChange}
      />,
    );
    expect(screen.getByText(/add api keys in settings/i)).toBeInTheDocument();
  });
});
```

**Step 2: Run to confirm failure**

```bash
npx vitest run apps/mission-control/src/renderer/src/components/ModelChainEditor.test.tsx
```

Expected: FAIL — module not found.

**Step 3: Create `ModelChainEditor.tsx`**

```tsx
import { X } from 'lucide-react';
import type { ModelOption } from './deploy-options.js';

interface ModelChainEditorProps {
  model: string;
  fallbackModels: string[];
  availableModels: ModelOption[];
  onChange: (model: string, fallbackModels: string[]) => void;
}

export function ModelChainEditor({
  model,
  fallbackModels,
  availableModels,
  onChange,
}: ModelChainEditorProps): JSX.Element {
  if (availableModels.length === 0) {
    return (
      <p className="text-sm text-muted">
        No models available. Add API keys in Settings to get started.
      </p>
    );
  }

  const usedModels = new Set([model, ...fallbackModels]);

  const handlePrimaryChange = (value: string): void => {
    onChange(value, fallbackModels);
  };

  const handleFallbackChange = (index: number, value: string): void => {
    const updated = [...fallbackModels];
    updated[index] = value;
    onChange(model, updated);
  };

  const handleRemoveFallback = (index: number): void => {
    onChange(model, fallbackModels.filter((_, i) => i !== index));
  };

  const handleAddFallback = (): void => {
    const next = availableModels.find((m) => !usedModels.has(m.value));
    if (next) onChange(model, [...fallbackModels, next.value]);
  };

  const canAddFallback = availableModels.some((m) => !usedModels.has(m.value));

  return (
    <div className="space-y-3">
      <div>
        <label className="mb-1 block text-xs font-medium text-muted">Primary model</label>
        <select
          aria-label="Primary model"
          value={model}
          onChange={(e) => handlePrimaryChange(e.target.value)}
          className="w-full rounded-lg border border-border bg-sidebar-bg px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
        >
          {availableModels.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </div>

      {fallbackModels.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted">Fallback models (in order)</p>
          {fallbackModels.map((fb, i) => {
            const optionsForRow = availableModels.filter(
              (m) => m.value === fb || !usedModels.has(m.value) || fallbackModels.indexOf(m.value) === i,
            );
            return (
              <div key={`${fb}-${i}`} className="flex items-center gap-2">
                <span className="text-xs text-muted w-4">{i + 1}.</span>
                <select
                  value={fb}
                  onChange={(e) => handleFallbackChange(i, e.target.value)}
                  className="flex-1 rounded-lg border border-border bg-sidebar-bg px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
                >
                  {optionsForRow.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  aria-label="Remove fallback"
                  onClick={() => handleRemoveFallback(i)}
                  className="rounded p-1 text-muted hover:text-foreground"
                >
                  <X size={14} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {canAddFallback && (
        <button
          type="button"
          onClick={handleAddFallback}
          className="text-xs text-primary hover:underline"
        >
          + Add fallback
        </button>
      )}
    </div>
  );
}
```

**Step 4: Run tests**

```bash
npx vitest run apps/mission-control/src/renderer/src/components/ModelChainEditor.test.tsx
```

Expected: PASS

**Step 5: Commit**

```bash
git add apps/mission-control/src/renderer/src/components/ModelChainEditor.tsx apps/mission-control/src/renderer/src/components/ModelChainEditor.test.tsx
git commit -m "feat(mc): add ModelChainEditor component for primary + fallback model selection"
```

---

### Task 15: Update deploy wizard

**Files:**
- Modify: `apps/mission-control/src/renderer/src/routes/deploy.tsx`

**Step 1: Check `deploy.test.tsx` first**

Open `apps/mission-control/src/renderer/src/routes/deploy.test.tsx` and read the existing tests. Run them to see current state:

```bash
npx vitest run apps/mission-control/src/renderer/src/routes/deploy.test.tsx
```

Note any tests that check for the model `<select>` — these will need updating. The key change is: the simple model `<select>` becomes `<ModelChainEditor>`.

**Step 2: Update `deploy.tsx`**

Add imports:

```tsx
import { ModelChainEditor } from '../components/ModelChainEditor.js';
import { useAvailableModels } from '../hooks/useAvailableModels.js';
import { useEffect } from 'react'; // add if not already imported
```

In `DeployWizard`, add:

```tsx
const availableModels = useAvailableModels();
```

Load global defaults at mount to pre-populate the form:

```tsx
useEffect(() => {
  window.api.settingsGet().then((settings) => {
    if (settings.defaultModel) {
      setAgent((prev) => ({
        ...prev,
        model: settings.defaultModel!,
        fallbackModels: settings.defaultFallbackModels ?? [],
      }));
    }
  }).catch(() => {});
}, []);
```

Update the `AgentConfig` type definition to include fallbacks:

```tsx
interface AgentConfig {
  name: string;
  model: string;
  fallbackModels: string[];
  systemPrompt: string;
  tools: string[];
}
```

Update the initial state:

```tsx
const [agent, setAgent] = useState<AgentConfig>({
  name: '',
  model: availableModels[0]?.value ?? '',
  fallbackModels: [],
  systemPrompt: '',
  tools: [],
});
```

Replace the model `<select>` block entirely with:

```tsx
<div>
  <span className="mb-1 block text-sm font-medium">Model</span>
  <ModelChainEditor
    model={agent.model}
    fallbackModels={agent.fallbackModels}
    availableModels={availableModels}
    onChange={(model, fallbackModels) =>
      setAgent((prev) => ({ ...prev, model, fallbackModels }))
    }
  />
</div>
```

Update `handleDeploy` call to include fallbackModels:

```tsx
const id = await deployWithConfig({
  name: agent.name.trim(),
  model: agent.model,
  fallbackModels: agent.fallbackModels.length > 0 ? agent.fallbackModels : undefined,
  systemPrompt: agent.systemPrompt,
  tools: agent.tools,
  enableTelegram: channels.enableTelegram,
});
```

Update the review step `ReviewRow` for model to show the chain:

```tsx
<ReviewRow
  label="Model"
  value={[agent.model, ...agent.fallbackModels]
    .map((v) => availableModels.find((m) => m.value === v)?.label ?? v)
    .join(' → ')}
/>
```

**Step 3: Update `deploy.test.tsx`**

Find tests that interact with the model select and update them to work with the new `ModelChainEditor`. The key change: `screen.getByRole('combobox')` targeting the model selector should now find `screen.getByRole('combobox', { name: /primary model/i })`.

**Step 4: Run tests**

```bash
npx vitest run apps/mission-control/src/renderer/src/routes/deploy.test.tsx
```

Expected: PASS

**Step 5: Commit**

```bash
git add apps/mission-control/src/renderer/src/routes/deploy.tsx apps/mission-control/src/renderer/src/routes/deploy.test.tsx
git commit -m "feat(mc): replace model select with ModelChainEditor in deploy wizard"
```

---

### Task 16: Update settings page with default model chain

**Files:**
- Modify: `apps/mission-control/src/renderer/src/routes/settings.tsx`

**Step 1: No new tests** — settings page is straightforward UI wiring. The `ModelChainEditor` component is already tested.

**Step 2: Update `settings.tsx`**

```tsx
import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { ModelChainEditor } from '../components/ModelChainEditor.js';
import type { AppSettings } from '../../../shared/ipc.js';
import { useAvailableModels } from '../hooks/useAvailableModels.js';

function Settings(): JSX.Element {
  const [version, setVersion] = useState<string>('...');
  const [settings, setSettings] = useState<AppSettings>({});
  const [saving, setSaving] = useState(false);
  const availableModels = useAvailableModels();

  useEffect(() => {
    window.api.getVersion().then(setVersion);
    window.api.settingsGet().then(setSettings).catch(() => {});
  }, []);

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
    <div>
      <h1 className="text-2xl font-bold">Settings</h1>
      <p className="mt-2 text-muted">Application settings and configuration.</p>

      <div className="mt-6 rounded-lg border border-border bg-sidebar-bg p-4">
        <h2 className="mb-1 text-sm font-semibold">Default Model Chain</h2>
        <p className="mb-4 text-xs text-muted">
          Pre-populates the model selection when creating a new agent.
          {saving && <span className="ml-2 text-primary">Saving...</span>}
        </p>
        <ModelChainEditor
          model={settings.defaultModel ?? availableModels[0]?.value ?? ''}
          fallbackModels={settings.defaultFallbackModels ?? []}
          availableModels={availableModels}
          onChange={handleChainChange}
        />
      </div>

      <div className="mt-6 rounded-lg border border-border bg-sidebar-bg p-4">
        <h2 className="text-sm font-semibold">About</h2>
        <p className="mt-2 text-sm text-muted">
          Mission Control v<span className="text-foreground">{version}</span>
        </p>
      </div>
    </div>
  );
}

export const Route = createFileRoute('/settings')({
  component: Settings,
});
```

**Step 3: Commit**

```bash
git add apps/mission-control/src/renderer/src/routes/settings.tsx
git commit -m "feat(mc): add default model chain editor to settings page"
```

---

### Task 17: Update agent detail page with model chain editor

**Files:**
- Modify: `apps/mission-control/src/renderer/src/routes/agents/$id.tsx`
- Modify: `apps/mission-control/src/renderer/src/stores/deployments.ts`

**Step 1: Add `updateConfig` action to deployments store**

In `deployments.ts`, add to the `DeploymentsState` interface:

```ts
updateConfig(id: string, patch: { model?: string; fallbackModels?: string[] }): Promise<void>;
```

Add the implementation in the `create` call:

```ts
async updateConfig(id: string, patch: { model?: string; fallbackModels?: string[] }) {
  try {
    await window.api.deploymentsUpdateConfig(id, patch);
    await get().loadDeployments();
  } catch (err) {
    set({ error: (err as Error).message });
    throw err;
  }
},
```

**Step 2: Update agent detail page `$id.tsx`**

Add imports:

```tsx
import { ModelChainEditor } from '../../components/ModelChainEditor.js';
import { useAvailableModels } from '../../hooks/useAvailableModels.js';
```

In `AgentDetail`, add:

```tsx
const { updateConfig } = useDeploymentsStore();
const availableModels = useAvailableModels();
const [editingChain, setEditingChain] = useState(false);
const [chainModel, setChainModel] = useState('');
const [chainFallbacks, setChainFallbacks] = useState<string[]>([]);
const [chainSaving, setChainSaving] = useState(false);
```

Initialize chain state when `agentConfig` loads:

```tsx
useEffect(() => {
  if (agentConfig?.model) {
    setChainModel(agentConfig.model);
    setChainFallbacks(agentConfig.fallbackModels ?? []);
  }
}, [agentConfig?.model]);
```

Add a save handler:

```tsx
const handleSaveChain = async (): Promise<void> => {
  setChainSaving(true);
  try {
    await updateConfig(id, { model: chainModel, fallbackModels: chainFallbacks });
    setEditingChain(false);
  } finally {
    setChainSaving(false);
  }
};
```

Add a "Model Chain" section after the `InfoCard` grid (after the `</div>` that closes the grid):

```tsx
{agentConfig && (
  <div className="mb-6">
    <div className="mb-2 flex items-center justify-between">
      <h2 className="text-sm font-medium text-muted">Model Chain</h2>
      {!editingChain && (
        <button
          type="button"
          onClick={() => setEditingChain(true)}
          className="text-xs text-primary hover:underline"
        >
          Edit
        </button>
      )}
    </div>
    {editingChain ? (
      <div className="rounded-lg border border-border bg-sidebar-bg p-3">
        <ModelChainEditor
          model={chainModel}
          fallbackModels={chainFallbacks}
          availableModels={availableModels}
          onChange={(m, fb) => { setChainModel(m); setChainFallbacks(fb); }}
        />
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={handleSaveChain}
            disabled={chainSaving}
            className="rounded-lg bg-primary px-3 py-1.5 text-xs text-white hover:bg-primary-hover disabled:opacity-50"
          >
            {chainSaving ? 'Saving...' : 'Save'}
          </button>
          <button
            type="button"
            onClick={() => setEditingChain(false)}
            className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted hover:bg-sidebar-hover"
          >
            Cancel
          </button>
        </div>
      </div>
    ) : (
      <div className="rounded-lg border border-border bg-sidebar-bg p-3 text-sm">
        {[chainModel, ...chainFallbacks]
          .map((v) => availableModels.find((m) => m.value === v)?.label ?? v)
          .join(' → ') || agentConfig.model}
      </div>
    )}
  </div>
)}
```

**Step 3: Build check**

```bash
npx tsc --noEmit -p apps/mission-control/tsconfig.web.json
```

Expected: no errors

**Step 4: Commit**

```bash
git add apps/mission-control/src/renderer/src/routes/agents/\$id.tsx apps/mission-control/src/renderer/src/stores/deployments.ts
git commit -m "feat(mc): add model chain editor to agent detail page"
```

---

### Task 18: Full test run + cleanup

**Step 1: Run all tests**

```bash
npm test
```

Expected: all tests pass.

**Step 2: Fix any failures**

If tests fail due to type errors or import issues, fix them. Common issues:
- `deploy.test.tsx` may need `mockApi.settingsGet` added to the mock in `vitest.setup.ts`
- `SetupWizard.test.tsx` — if any test hardcodes the number of providers, update the count

**Step 3: Final commit**

```bash
git add -A
git commit -m "test: ensure all tests pass after model selection feature"
```

---

## Summary of Files Changed

| File | Change |
|---|---|
| `packages/llm/src/registry.ts` | `bareModelId` utility, `resolveProvider` parses `provider/model-id` |
| `packages/llm/src/index.ts` | Export `bareModelId` |
| `packages/llm/src/providers/anthropic.ts` | `bareModelId(request.model)` in complete + stream |
| `packages/llm/src/providers/google.ts` | Same |
| `packages/llm/src/providers/openai.ts` | Same |
| `packages/agent/src/types.ts` | `fallbackModels?: string[]` on `DashAgentConfig` + `AgentState` |
| `packages/agent/src/backends/native.ts` | Fallback chain loop + `isRetryableError` |
| `apps/dash/src/config.ts` | `anthropicApiKey` optional, multi-provider validation |
| `apps/dash/src/agent-server.ts` | Conditional Anthropic registration |
| `packages/mc/src/types.ts` | `fallbackModels?: string[]` on `AgentDeployAgentConfig` |
| `packages/mc/src/runtime/process.ts` | Multi-provider secrets + `updateAgentConfig` |
| `packages/mc/src/settings-store.ts` | **New** — plain-JSON settings persistence |
| `packages/mc/src/index.ts` | Export `SettingsStore` + `AppSettings` |
| `apps/mission-control/src/shared/ipc.ts` | `fallbackModels` on `DeployWithConfigOptions`, settings + updateConfig in `MissionControlAPI` |
| `apps/mission-control/src/preload/index.ts` | Wire settings + updateConfig IPC |
| `apps/mission-control/src/main/ipc.ts` | Settings handlers, `deploymentsUpdateConfig`, multi-provider `setup:getStatus` |
| `apps/mission-control/src/renderer/src/components/deploy-options.ts` | `ModelOption` with `provider`/`secretKey`, all three providers' models |
| `apps/mission-control/src/renderer/src/components/providers.ts` | OpenAI + Google added |
| `apps/mission-control/src/renderer/src/components/ModelChainEditor.tsx` | **New** — shared model chain UI |
| `apps/mission-control/src/renderer/src/hooks/useAvailableModels.ts` | **New** — credential-aware model filter hook |
| `apps/mission-control/src/renderer/src/routes/deploy.tsx` | `ModelChainEditor` + settings pre-population |
| `apps/mission-control/src/renderer/src/routes/settings.tsx` | Default model chain section |
| `apps/mission-control/src/renderer/src/routes/agents/$id.tsx` | Model chain editor section |
| `apps/mission-control/src/renderer/src/stores/deployments.ts` | `updateConfig` action |
