# OpenAI Provider Support

## Summary

Add an `OpenAIProvider` to the LLM layer, enabling Dash agents to use OpenAI GPT and reasoning models (o1/o3/o4) via the Responses API.

## Decisions

- **API**: OpenAI Responses API (not Chat Completions)
- **Models**: GPT (`gpt-*`) and reasoning (`o1*`, `o3*`, `o4*`)
- **Architecture**: Single unified provider with model-aware parameter branching
- **Reasoning**: Map Dash's `thinking` config to OpenAI's `reasoning` parameter; stream reasoning summaries as `thinking_delta` chunks

## Provider: `OpenAIProvider`

Single class in `packages/llm/src/providers/openai.ts` implementing `LlmProvider`.

Uses the `openai` npm SDK. Constructor takes an optional API key, defaults to `OPENAI_API_KEY` env var (SDK default).

### Model detection

Helper function `isReasoningModel(model)` returns true for `o1*`, `o3*`, `o4*` prefixes. Used to branch parameter handling:

- **GPT models**: `temperature`, `instructions` (system prompt), standard function tools
- **Reasoning models**: `reasoning: { effort, summary }` when thinking is enabled, `instructions` for system prompt, no `temperature`

### Message mapping

Dash `Message[]` → Responses API `input` items:

| Dash type | Responses API type |
|---|---|
| `{ role: 'user', content: string }` | `{ role: 'user', content: text }` |
| `{ role: 'assistant', content: string }` | `{ role: 'assistant', content: text }` |
| `TextBlock` in assistant content | included in assistant message content |
| `ToolUseBlock` | `{ type: 'function_call', id, name, arguments: JSON.stringify(input) }` |
| `ToolResultBlock` | `{ type: 'function_call_output', call_id, output }` |
| `ThinkingBlock` / `RedactedThinkingBlock` | Skipped (Anthropic-specific) |
| `{ role: 'system', ... }` | Skipped (passed via `instructions` parameter instead) |

### Tool definitions

Dash `ToolDefinition` → `{ type: 'function', name, description, parameters: input_schema }`

### Streaming

Responses API stream events → Dash `StreamChunk`:

| Responses API event | StreamChunk |
|---|---|
| `response.output_text.delta` | `{ type: 'text_delta', text }` |
| `response.function_call_arguments.delta` | `{ type: 'tool_use_delta', toolUseDelta: { partial_json } }` |
| `response.function_call_arguments.done` | Accumulate into final tool use block |
| `response.output_item.added` (function_call) | `{ type: 'tool_use_start', toolUse: { id, name } }` |
| `response.reasoning_summary_text.delta` | `{ type: 'thinking_delta', thinking }` |
| `response.reasoning_summary_text.done` | `{ type: 'thinking_stop' }` |
| `response.completed` | `{ type: 'stop', stopReason }` |

### Stop reason mapping

| OpenAI status | Dash stopReason |
|---|---|
| `'completed'` | `'end_turn'` |
| `'incomplete'` with `max_output_tokens` | `'max_tokens'` |
| Has function calls in output | `'tool_use'` |

### `complete()` method

Calls `client.responses.create()` with `stream: false`. Extracts output items, maps to `CompletionResponse`. Usage from `response.usage`.

### `stream()` method

Calls `client.responses.create()` with `stream: true`. Iterates SSE events, yields `StreamChunk`s, accumulates state for the final `CompletionResponse` return value.

## Wiring

### New files

- `packages/llm/src/providers/openai.ts` — provider implementation
- `packages/llm/src/providers/openai.test.ts` — unit tests (mock SDK)

### Edited files

- `packages/llm/src/index.ts` — export `OpenAIProvider`
- `packages/llm/package.json` — add `openai` SDK dependency
- `apps/dash/src/config.ts` — add `openaiApiKey` to `DashConfig`, `CredentialsConfig`, `SecretsFile`
- `apps/dash/src/agent-server.ts` — register `OpenAIProvider` when key is present
- `packages/llm/src/registry.test.ts` — add OpenAI model resolution test
- `config.example/credentials.json` — add `openai` section
- `.env.example` — add `OPENAI_API_KEY`

## Non-goals

- OpenAI-specific tool types (web_search, file_search, code_interpreter)
- Image/audio input support
- Response caching or stored responses
- Batch API support
