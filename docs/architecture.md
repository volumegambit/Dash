# Architecture

Dash is a TypeScript monorepo with five packages organized in a layered dependency graph.

## Package dependency graph

```
                 ┌──────────┐
                 │  server   │  entry point, config, gateway
                 └────┬─────┘
          ┌───────────┼───────────┐
          v           v           │
     ┌────────┐  ┌─────────┐     │
     │  tui   │  │channels │     │
     └────┬───┘  └────┬────┘     │
          │           │           │
          v           v           │
     ┌────────────────────────────┘
     │         agent              │
     │  (orchestration, tools,    │
     │   sessions)                │
     └────────────┬───────────────┘
                  v
            ┌──────────┐
            │   llm    │
            └──────────┘
```

Dependency flow: `llm` → `agent` → `channels` → `server`. The `tui` package depends on `agent` and `llm` directly (it has its own config loading, independent of `server`).

## Package responsibilities

### `@dash/llm`

LLM provider abstraction layer. Defines the core types (`Message`, `ContentBlock`, `CompletionRequest/Response`, `StreamChunk`) and the `LlmProvider` interface. The `AnthropicProvider` implements streaming via the `@anthropic-ai/sdk`, converting between Dash's type system and Anthropic's SDK types. Handles extended thinking blocks, tool use blocks, and content block serialization. The `ProviderRegistry` maps model name prefixes to providers.

### `@dash/agent`

Agent orchestration layer. `DashAgent` manages the conversation loop: loading sessions, appending messages, delegating to a backend, and persisting results. `NativeBackend` implements the agent loop — it streams LLM responses, detects tool use, executes tools, and loops until the model produces a final text response (up to 25 tool rounds). The tool system (`BashTool`, `ReadFileTool`) provides workspace-sandboxed command execution and file reading. `JsonlSessionStore` handles append-only session persistence.

### `@dash/channels`

Channel adapter layer. Defines the `ChannelAdapter` interface for messaging platforms and the `MessageRouter` that binds adapters to agents. The `TelegramAdapter` uses grammY for long-polling, handles user authorization via `allowedUsers`, and collects the full agent response before sending it as a single Telegram message.

### `@dash/tui`

Terminal UI package. An interactive REPL that connects directly to an agent (bypassing `channels` and `server`). Loads its own config from `config/dash.json`, creates an `AnthropicProvider` and `NativeBackend`, and renders streaming output with ANSI formatting. Shows a spinner during inference, formatted tool execution blocks, and token usage stats.

### `@dash/server`

Entry point for server mode. Loads `.env`, reads config via `loadConfig()`, creates agents and channel adapters, wires them through `MessageRouter`, and manages the gateway lifecycle (start/stop with signal handling).

## Data flow

### User message to response

```
User sends message (Telegram / TUI)
  │
  v
ChannelAdapter.onMessage() / readline
  │
  v
MessageRouter.handleMessage()
  │
  v
DashAgent.chat(channelId, conversationId, text)
  │
  ├─ Load or create session (JSONL)
  ├─ Append user message to session
  │
  v
NativeBackend.run(state)
  │
  ├─ LlmProvider.stream(request)  ──→  Anthropic API
  ├─ Yield streaming events (text_delta, thinking_delta, tool_use_*)
  │
  ├─ If stopReason == "tool_use":
  │     ├─ Execute tool(s)
  │     ├─ Yield tool_result events
  │     ├─ Append tool results to messages
  │     └─ Loop (next LLM round, up to 25 rounds)
  │
  ├─ If stopReason == "end_turn":
  │     ├─ Yield final response event
  │     └─ Append assistant message to session
  │
  v
Persist new messages to JSONL
  │
  v
Adapter sends response to user
```

## Agent loop

The `NativeBackend` implements a loop that allows the model to use tools iteratively:

1. Send messages + tools to the LLM via streaming
2. Collect text, thinking, and tool use blocks from the stream
3. If the model requests tool use (`stopReason: "tool_use"`):
   - Execute each tool and yield `tool_result` events
   - Append the assistant message and tool results to the session
   - Loop back to step 1 with the updated message history
4. If the model finishes (`stopReason: "end_turn"`):
   - Yield the final `response` event with accumulated token usage
   - Return

The loop is capped at **25 tool rounds** to prevent runaway execution. If the limit is reached, the last available text is returned.

## Content block system

Messages carry `content: string | ContentBlock[]`. When content is a plain string, it's a simple text message. When it's `ContentBlock[]`, it contains structured blocks:

| Block type | Description |
|------------|-------------|
| `TextBlock` | Visible text content (`{ type: "text", text: "..." }`) |
| `ToolUseBlock` | Tool call request (`{ type: "tool_use", id, name, input }`) |
| `ToolResultBlock` | Tool execution result (`{ type: "tool_result", tool_use_id, content, is_error }`) |
| `ThinkingBlock` | Model's internal reasoning (`{ type: "thinking", thinking, signature }`) |
| `RedactedThinkingBlock` | Redacted thinking (`{ type: "redacted_thinking", data }`) |

## Session persistence

Sessions are stored as append-only JSONL (one JSON object per line) files.

### Directory layout

```
{sessionDir}/{channelId}/{conversationId}/session.jsonl
```

Example:

```
data/sessions/telegram/123456789/session.jsonl
data/sessions/cli/cli:1706123456789/session.jsonl
```

### Entry types

Each line in a session file is a `SessionEntry`:

```typescript
interface SessionEntry {
  timestamp: string;        // ISO 8601
  type: 'message' | 'response' | 'tool_call' | 'tool_result' | 'error';
  data: Record<string, unknown>;
}
```

| Type | Data | Description |
|------|------|-------------|
| `message` | `{ role: "user", content: "..." }` | User message |
| `response` | `{ content: "..." \| ContentBlock[] }` | Assistant response |
| `tool_result` | `{ content: ContentBlock[] }` | Tool execution results |

On load, entries are replayed in order to reconstruct the message array for the session.

## Build system

- **tsup** — each package builds from `src/index.ts` to `dist/` as ESM
- **TypeScript 5.7+** — strict mode, ES2024 target, NodeNext module resolution
- **Biome** — linting and formatting (2-space indent, single quotes, semicolons)
- **Vitest** — test runner with globals enabled
- **npm workspaces** — monorepo management, `npm run build` builds all packages

## Docker

Multi-stage build using `node:22-slim`:

1. **Builder stage** — `npm ci`, copy source, `npm run build`
2. **Production stage** — `npm ci --omit=dev`, copy `dist/` from builder
3. **Entry point** — `node packages/server/dist/index.js`

Volumes:
- `./data/sessions:/app/data/sessions` — persist session data
- `./config:/app/config:ro` — mount config (read-only)
