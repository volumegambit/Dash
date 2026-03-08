# Agent SDK Improvement: Replace NativeBackend with OpenCode

**Date:** 2026-03-07
**Branch:** worktree-agent-sdk-improvement
**Status:** Approved design, ready for implementation

---

## 1. Decision

Replace the custom `NativeBackend` with **OpenCode** as the execution foundation for all Dash agents. OpenCode provides a battle-tested agentic loop, 75+ provider support via Vercel AI SDK, built-in tools, SQLite session storage, and an HTTP+SSE interface. Dash retains its config/session orchestration layer on top.

**Process model:** One OpenCode server per deployed agent (process-per-agent). Each `DashAgent` instance spawns and owns its own `opencode serve` subprocess.

---

## 2. Architecture

### Approach: OpenCode Execution + Dash Orchestration

OpenCode handles:
- Agentic loop (multi-round tool calls, retries, compaction)
- All 10 built-in tools (bash, edit, write, read, glob, grep, ls, web_fetch, web_search, mcp)
- Provider routing (Anthropic, OpenAI, Google, and 72+ more via Vercel AI SDK)
- SQLite session persistence

Dash retains:
- `AgentBackend` interface as the normalization boundary
- `DashAgent` class as the channel-facing façade
- Config generation (`dash.json` → `opencode.json`)
- Session ID mapping (channelId:conversationId → OpenCode session UUID)
- Event normalization (OpenCode SSE events → `AgentEvent` union)
- `question.asked` routing to channel for interactive user response

### New Component: `OpenCodeBackend`

```
packages/agent/src/backends/opencode.ts
```

Implements `AgentBackend`. Manages:
1. Spawning `opencode serve` subprocess bound to a random local port
2. Constructing `@opencode-ai/sdk` client
3. Session ID map lookup/creation
4. Sending messages via `sdk.session.chat()`
5. Consuming SSE event stream and normalizing to `AgentEvent`
6. Auto-approving `permission.asked` events (headless mode)
7. Routing `question.asked` events to the calling channel

### New Component: `ConfigGenerator`

```
packages/agent/src/config-generator.ts
```

Converts `DashAgentConfig` → `opencode.json` written to a temp directory. Handles:
- `model` field: `"provider/model-id"` format
- `providerApiKeys` → provider-specific env or config keys
- `tools` → explicit allow-list of OpenCode tool names

### New Component: `SessionIdMap`

```
packages/agent/src/session-id-map.ts
```

In-memory map of `"${channelId}:${conversationId}"` → OpenCode session UUID.

- **On startup:** Calls `sdk.session.list()` and rebuilds map from session titles matching the `"channelId:conversationId"` pattern.
- **On new conversation:** Creates OpenCode session with title set to the Dash key; stores UUID in map.
- **Stale sessions:** If a stored session UUID returns 404 from OpenCode, treat as fresh — create new session.

---

## 3. Data Flow

```
Channel (Telegram / MC / TUI)
  → Gateway (WebSocket)
    → ChatServer
      → DashAgent.chat(channelId, conversationId, text)
        → OpenCodeBackend.run(state, options)
          → sdk.session.chat(sessionId, { content: text })
          → SSE stream → normalize → yield AgentEvent
        ← AsyncGenerator<AgentEvent>
      ← streams events back to channel
```

TUI is explicitly out of scope for this migration.

---

## 4. Tool Mapping

All 10 OpenCode tools are named explicitly in `dash.json`. Each tool name maps directly to OpenCode's internal tool identifier:

| OpenCode Tool | Permission Key | Description |
|---------------|---------------|-------------|
| `bash`        | `bash`        | Execute shell commands |
| `edit`        | `edit`        | Edit file content |
| `write`       | `edit`        | Write new files |
| `read`        | `read`        | Read file content |
| `glob`        | `glob`        | Find files by pattern |
| `grep`        | `grep`        | Search file content |
| `ls`          | `ls`          | List directory contents |
| `web_fetch`   | `web_fetch`   | Fetch a URL |
| `web_search`  | `web_search`  | Search the web |
| `mcp`         | `mcp`         | Call MCP tools |

Tools in `dash.json` `tools` array are passed through ConfigGenerator into `opencode.json` as the explicit allow-list. Tools absent from the array are denied.

---

## 5. Event Normalization

OpenCode SSE events → `AgentEvent` union:

### Subscribed SSE Events

| OpenCode Event | Trigger |
|---|---|
| `message.part.updated` | Full part snapshot (all types) |
| `message.part.delta` | Incremental text delta `{ field, delta }` |
| `session.status` | Turn lifecycle: `idle \| busy \| retry` |
| `permission.asked` | Tool permission request (headless: auto-approve) |
| `question.asked` | Agent asks user a multi-choice question |
| `file.edited` | File was modified by agent |

### Normalized `AgentEvent` Union

```typescript
export type AgentEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_delta'; partial_json: string }
  | { type: 'tool_result'; id: string; name: string; content: string; isError?: boolean }
  | { type: 'response'; content: string; usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } }
  | { type: 'error'; error: Error }
  | { type: 'file_changed'; files: string[] }
  | { type: 'agent_spawned'; name: string }
  | { type: 'agent_retry'; attempt: number; reason: string }
  | { type: 'context_compacted'; overflow: boolean }
  | { type: 'question'; id: string; question: string; options: string[] }
```

### Part Type → AgentEvent Mapping

| OpenCode Part Type | AgentEvent(s) emitted |
|---|---|
| `TextPart` (delta) | `text_delta` |
| `TextPart` (final via `message.part.updated`) | `response` (with usage from `AssistantMessage`) |
| `ReasoningPart` (delta) | `thinking_delta` |
| `ToolInvocationPart` (call, partial-call) | `tool_use_start`, `tool_use_delta` |
| `ToolInvocationPart` (result) | `tool_result` |
| `SnapshotPart` (PatchPart) | `file_changed` (files from `part.files`) |
| `AgentPart` | `agent_spawned` (name from `part.name`) |
| `StepStartPart`, `StepFinishPart` | Ignored (internal loop metadata) |

### Session Lifecycle Signals

| Signal | Action |
|---|---|
| `session.status { type: 'idle' }` | End of turn — stop consuming SSE, return from generator |
| `session.status { type: 'retry', attempt, message }` | Yield `agent_retry`, continue consuming |
| `session.status { type: 'busy' }` | No-op (expected during tool execution) |
| `session.idle` (deprecated) | Handled as fallback for backwards compat |

### Permission & Question Handling

**`permission.asked`:** In headless mode, OpenCode's `bash` tool can hang waiting for permission. `OpenCodeBackend` subscribes to `permission.asked` and immediately calls `sdk.permission.reply({ requestID, reply: 'once' })`. Logs a warning to agent log including the permission and patterns.

**`question.asked`:** Agent blocks execution waiting for a multi-choice answer. `OpenCodeBackend`:
1. Yields `{ type: 'question', id, question, options }` to the caller
2. The `DashAgent` routes this to the channel (same path as text response)
3. Channel user replies; `DashAgent` calls `sdk.question.reply({ requestID: id, answers })` to unblock the agent

---

## 6. Session ID Mapping

**Strategy:** Option B — embed Dash's `channelId:conversationId` as the OpenCode session title. Maintain an in-memory `SessionIdMap`. Rebuild on process startup by listing all OpenCode sessions and filtering by title pattern.

```typescript
// Key format
const key = `${channelId}:${conversationId}`

// On first message for a key
const session = await sdk.session.create({ title: key })
map.set(key, session.id)

// On subsequent messages
const sessionId = map.get(key)
// if sessionId returns 404 → create fresh session
```

**Startup rebuild:**
```typescript
const sessions = await sdk.session.list()
for (const s of sessions) {
  if (s.title?.includes(':')) map.set(s.title, s.id)
}
```

No JSON file. No external persistence beyond OpenCode's own SQLite.

---

## 7. Config Schema Changes (`dash.json`)

```jsonc
// Before
{
  "provider": "anthropic",
  "model": "claude-opus-4-5",
  "anthropicApiKey": "sk-ant-...",
  "tools": ["read_file", "run_bash"]
}

// After
{
  "model": "anthropic/claude-opus-4-5",
  "providerApiKeys": {
    "anthropic": "sk-ant-..."
  },
  "tools": ["bash", "edit", "write", "read", "glob", "grep", "ls", "web_fetch", "web_search", "mcp"]
}
```

`ConfigGenerator` converts this to `opencode.json` written to a temp working directory for each agent subprocess.

---

## 8. Migration

### Session History
Existing JSONL session files (`~/.dash/sessions/`) are orphaned. OpenCode stores all history in its own SQLite database. No migration of JSONL history. Conversations start fresh after the upgrade.

### Packages Removed
- `@dash/llm` — providers, token counting, message formatting
- `packages/agent/src/tools/` — BashTool, ReadFileTool (OpenCode handles these)
- `packages/agent/src/session.ts` — JsonlSessionStore
- `packages/agent/src/backends/native.ts` — NativeBackend

### Config Migration
Tool names change: `read_file` → `read`, `run_bash` → `bash`. Provider+model consolidate into single `"provider/model"` string. Per-provider key fields consolidate into `providerApiKeys` map.

### No API Surface Changes
The `AgentBackend` interface, WebSocket protocol, Gateway, ChatServer, and all channel integrations are unchanged. The only breaking change is internal: JSONL sessions are not carried forward.

### Process Lifecycle
Each `DashAgent` spawns one `opencode serve` subprocess on `start()` and terminates it on `stop()`. No persistent daemon.

---

## 9. Files Changed

### Removed
- `packages/agent/src/backends/native.ts`
- `packages/agent/src/session.ts`
- `packages/agent/src/tools/bash.ts`
- `packages/agent/src/tools/read-file.ts`
- `packages/llm/` (entire package)

### New
- `packages/agent/src/backends/opencode.ts` — OpenCodeBackend
- `packages/agent/src/config-generator.ts` — dash.json → opencode.json
- `packages/agent/src/session-id-map.ts` — SessionIdMap

### Modified
- `packages/agent/src/types.ts` — AgentEvent union (add 5 new variants), remove provider types
- `packages/agent/src/agent.ts` — remove SessionStore wiring, add question routing
- `packages/agent/src/index.ts` — update exports
- `apps/dash/src/config.ts` — new config schema
- `apps/dash/src/agent-server.ts` — remove ProviderRegistry, wire OpenCodeBackend
- `packages/agent/package.json` — add `@opencode-ai/sdk`, remove `@dash/llm`
