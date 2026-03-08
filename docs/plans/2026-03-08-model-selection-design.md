# Model Selection Design

**Date:** 2026-03-08
**Branch:** improve_model_selection
**Status:** Approved

## Problem

Agent setup currently supports only a single model (always Claude). There is no fallback if the primary model fails, no support for OpenAI or Google models, and the UI does not reflect which providers the user has credentials for.

## Goals

- Primary model + ordered fallback chain per agent
- Automatic retry through the chain on retryable errors (429, 5xx)
- Credential-aware model picker — only show models for configured providers
- Global default chain in Settings, per-agent override in deploy wizard and agent detail page
- Clean break: all model identifiers use `provider/model-id` format, no legacy heuristics

## Model Identifier Format

All model values use `provider/model-id`:

```
anthropic/claude-sonnet-4-20250514
openai/gpt-4o
google/gemini-2.0-flash
```

Existing agent configurations are removed as part of this change — no backward compatibility required.

## Data Model Changes

### `packages/agent/src/types.ts`

`DashAgentConfig` and `AgentState` gain:

```ts
fallbackModels?: string[]
```

### `apps/dash/src/config.ts`

`AgentConfig` gains:

```ts
fallbackModels?: string[]
```

### `apps/mission-control/src/shared/ipc.ts`

`DeployWithConfigOptions` gains:

```ts
fallbackModels?: string[]
```

### `apps/mission-control/src/renderer/src/components/deploy-options.ts`

`ModelOption` gains provider metadata:

```ts
export interface ModelOption {
  value: string      // 'anthropic/claude-sonnet-4-20250514'
  label: string      // 'Claude Sonnet 4'
  provider: 'anthropic' | 'openai' | 'google'
  secretKey: string  // 'anthropic-api-key'
}
```

Initial model list covers Anthropic (Sonnet 4, Haiku 4.5), OpenAI (GPT-4o, o3 mini), and Google (Gemini 2.0 Flash).

### New: `AppSettings` (non-sensitive, plain JSON)

```ts
interface AppSettings {
  defaultModel?: string
  defaultFallbackModels?: string[]
}
```

Stored at `~/.mission-control/settings.json`.

## Backend

### `packages/llm/src/registry.ts` — `resolveProvider`

Parse `provider/model-id` format explicitly; no heuristics:

```ts
resolveProvider(model: string): LlmProvider {
  const slash = model.indexOf('/');
  if (slash === -1) throw new Error(`Invalid model format "${model}": expected "provider/model-id"`);
  return this.get(model.slice(0, slash));
}
```

New utility exported from the package:

```ts
export function bareModelId(model: string): string {
  const slash = model.indexOf('/');
  return slash !== -1 ? model.slice(slash + 1) : model;
}
```

Each provider implementation calls `bareModelId(model)` before forwarding to its SDK.

### `packages/agent/src/backends/native.ts` — Fallback Loop

The existing single-model try/catch is replaced with a chain-aware retry loop:

```ts
async *run(state: AgentState, options: RunOptions): AsyncGenerator<AgentEvent> {
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

The existing loop body moves into a private `runWithModel()` method.

**Retryable errors** (`isRetryableError`): HTTP 429, 500, 503, or messages containing "overloaded" / "rate limit".
**Fatal errors** (no fallback): 401, 400, unknown model — these would fail on any fallback too.

## UI

### Credential-Aware Hook

```ts
function useAvailableModels(): ModelOption[] {
  const [keys, setKeys] = useState<string[]>([]);
  useEffect(() => { window.api.secretsList().then(setKeys); }, []);
  return AVAILABLE_MODELS.filter(m => keys.includes(m.secretKey));
}
```

Used by all model-selection surfaces. If no keys are present, an empty list is returned and a "Add API keys in Settings" prompt is shown.

### `ModelChainEditor` Component

Shared component used in deploy wizard, agent detail page, and settings:

```tsx
interface ModelChainEditorProps {
  model: string
  fallbackModels: string[]
  availableModels: ModelOption[]
  onChange: (model: string, fallbackModels: string[]) => void
}
```

- Primary model: `<select>` from `availableModels`
- Fallbacks: ordered list, each row has a `<select>` + remove button + up/down arrows
- "Add fallback" button appends the first available model not already in the chain
- Models already selected are excluded from other rows' options

### Deploy Wizard (`apps/mission-control/src/renderer/src/routes/deploy.tsx`)

- Replace single model `<select>` with `<ModelChainEditor>`
- Pre-populate from global settings defaults at mount time
- Pass `model` + `fallbackModels` in `deployWithConfig` call

### Agent Detail Page (`apps/mission-control/src/renderer/src/routes/agents/$id.tsx`)

- Add collapsible "Model Chain" section with `<ModelChainEditor>`
- Save via new `deploymentsUpdateConfig(id, { model, fallbackModels })` IPC call
- Takes effect on the next conversation (no restart required)

### Settings Page (`apps/mission-control/src/renderer/src/routes/settings.tsx`)

- Add "Default Model Chain" section with `<ModelChainEditor>`
- Read/write via `settingsGet()` / `settingsSet()` IPC

### Setup Wizard (`apps/mission-control/src/renderer/src/components/SetupWizard.tsx`)

- `providers.ts` extended with OpenAI and Google (same shape as Anthropic: `secretKey`, `consoleUrl`, `apiKeysUrl`, `helpUrl`, `steps`)
- `setup:getStatus` check updated: considers setup complete if *any* known provider key exists (`anthropic-api-key`, `openai-api-key`, `google-api-key`)

## IPC

### New handlers

| Handler | Description |
|---|---|
| `settings:get` | Returns current `AppSettings` |
| `settings:set` | Merges patch into `AppSettings` and persists |
| `deployments:updateConfig` | Rewrites agent JSON with model chain patch |

### Updated handlers

| Handler | Change |
|---|---|
| `deployments:deployWithConfig` | Writes `fallbackModels` into agent JSON |
| `setup:getStatus` | Accepts any provider key, not just Anthropic |

### New `SettingsStore` (`packages/mc/src/settings-store.ts`)

Plain JSON read/write at `~/.mission-control/settings.json`. No encryption — settings are non-sensitive preferences.

### `ProcessRuntime.updateAgentConfig`

Locates the agent JSON for a deployment by ID and merges the patch. The updated chain is picked up on the next conversation without a process restart.

## Out of Scope (for now)

- Per-conversation manual model override in chat UI
- Per-model retry count configuration
- Model capability filtering (e.g. hiding models that don't support tools)
