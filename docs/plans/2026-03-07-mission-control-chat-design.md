# Mission Control Chat Design

**Date:** 2026-03-07
**Status:** Approved

## Goal

Allow users to chat with deployed agents from Mission Control with streaming responses, agent selection, full event visibility (text, thinking, tool use), persistent multi-conversation history, and all traffic routed through the gateway.

## Requirements

- Streaming text — live typing effect as the agent responds
- User selects which agent to chat with within a deployment
- Show all event types: `text_delta`, `thinking_delta`, `tool_use_start`, `tool_use_delta`, `tool_result`, `response`, `error`
- Persist conversations across app restarts
- Multiple conversations per agent (user can create new threads)
- Messages route through the gateway (not directly to the Chat API)

## Current State

`chat.tsx` already exists and connects to `deployment.chatPort` — which points to the gateway's `MissionControlAdapter`, not the Chat API directly. The variable is even called `gatewayUrl`. However the current implementation is broken:

1. Sends the wrong protocol (`{ type: 'message', conversationId, text }` — missing `agentName`)
2. Expects `{ type: 'response', text }` — no streaming, just final text
3. No conversation persistence
4. No agent selection within a deployment

## Architecture

```
MC Renderer
    ↕ IPC (AgentEvents pushed per event)
MC Main (ChatService + ConversationStore)
    ↕ WebSocket (ws://localhost:<chatPort>?token=<chatToken>)
Gateway (upgraded MissionControlAdapter — multi-agent, streaming)
    ↕ WebSocket (RemoteAgentClient → Chat API port 9101)
Agent Server
```

`deployment.chatPort` and `deployment.chatToken` already point to the gateway's MC adapter — no new deployment fields needed.

## Section 1: Gateway Changes

### `packages/channels` — Upgraded `MissionControlAdapter`

**Inbound message (MC → gateway):**
```ts
{ type: 'message', conversationId: string, agentName: string, text: string }
```

**Outbound messages (gateway → MC):**
```ts
{ type: 'event', conversationId: string, event: AgentEvent }
{ type: 'done',  conversationId: string }
{ type: 'error', conversationId: string, error: string }
```

**Multi-agent routing:** The adapter receives the full `agents: Map<string, AgentClient>` map and routes internally by `agentName`. It no longer goes through `MessageRouter` (the router's accumulate-then-send pattern is incompatible with streaming). The adapter runs its own streaming loop:

```ts
for await (const event of agent.chat('mission-control', conversationId, text)) {
  ws.send(JSON.stringify({ type: 'event', conversationId, event }))
}
ws.send(JSON.stringify({ type: 'done', conversationId }))
```

**Auth:** Token as query param (`?token=...`). Adapter closes with code `4001` if missing or invalid.

**Concurrent messages:** Multiple conversations can be in-flight simultaneously. Each message is independent (fire-and-forget per WS message).

### `apps/gateway` — `createGateway` change

When `config.adapter === 'mission-control'`, pass the full `agents` map and `config.token` directly to the adapter. Do not register it with `MessageRouter`.

### `apps/gateway` — Config

Add `token` field to the MC channel config:
```json
{
  "channels": {
    "mc": {
      "adapter": "mission-control",
      "port": 9200,
      "token": "your-mc-token"
    }
  }
}
```

## Section 2: Conversation Storage

### `packages/mc` — New `ConversationStore`

**Storage location:** `~/.mission-control/conversations/`

**Index file:** `~/.mission-control/conversations/index.json`
```ts
interface McConversation {
  id: string;          // UUID — also used as conversationId with the agent
  deploymentId: string;
  agentName: string;
  title: string;       // first 60 chars of first user message
  createdAt: string;
  updatedAt: string;
}
```

**Messages:** `~/.mission-control/conversations/<id>.jsonl` (append-only JSONL)
```ts
interface McMessage {
  id: string;
  role: 'user' | 'assistant';
  content:
    | { type: 'user'; text: string }
    | { type: 'assistant'; events: AgentEvent[] };
  timestamp: string;
}
```

**API:**
```ts
class ConversationStore {
  create(deploymentId: string, agentName: string): Promise<McConversation>
  list(deploymentId: string): Promise<McConversation[]>
  delete(id: string): Promise<void>
  appendMessage(conversationId: string, message: McMessage): Promise<void>
  getMessages(conversationId: string): Promise<McMessage[]>
}
```

**Session continuity:** Because the agent server keys sessions by `(channelId, conversationId)`, using the MC conversation UUID as `conversationId` and `'mission-control'` as `channelId` means the agent automatically maintains context across reconnects — no session replay needed from MC's side.

## Section 3: `ChatService` (Electron main process)

New file: `apps/mission-control/src/main/chat-service.ts`

```ts
class ChatService {
  constructor(
    private registry: AgentRegistry,
    private store: ConversationStore,
    private onEvent: (conversationId: string, event: AgentEvent) => void,
    private onDone: (conversationId: string) => void,
    private onError: (conversationId: string, error: string) => void,
  ) {}

  createConversation(deploymentId: string, agentName: string): Promise<McConversation>
  listConversations(deploymentId: string): Promise<McConversation[]>
  getMessages(conversationId: string): Promise<McMessage[]>
  deleteConversation(conversationId: string): Promise<void>
  sendMessage(conversationId: string, text: string): Promise<void>
  cancel(conversationId: string): void
}
```

**`sendMessage` flow:**
1. Load conversation → get `deploymentId`, `agentName`
2. Look up deployment → get `chatPort`, `chatToken`
3. If deployment not running or no `chatPort` → throw (surfaces as IPC error)
4. Append user message to JSONL store
5. Open WS to `ws://localhost:<chatPort>?token=<chatToken>`
6. Send `{ type: 'message', conversationId, agentName, text }`
7. Per event: call `onEvent` (IPC push) and accumulate events in memory
8. On `done`: append assembled assistant `McMessage` to store, call `onDone`
9. On `error`: call `onError`

**Cancellation:** An `AbortController` per active `conversationId`. `cancel()` closes the WS; partial accumulated events are saved so the partial response is visible on reload.

### IPC surface (replacing current chat handlers)

**Invoke (renderer → main):**
```ts
chatListConversations(deploymentId: string): Promise<McConversation[]>
chatCreateConversation(deploymentId: string, agentName: string): Promise<McConversation>
chatGetMessages(conversationId: string): Promise<McMessage[]>
chatDeleteConversation(conversationId: string): Promise<void>
chatSendMessage(conversationId: string, text: string): Promise<void>
chatCancel(conversationId: string): Promise<void>
```

**Push (main → renderer):**
```ts
chat:event  (conversationId: string, event: AgentEvent)
chat:done   (conversationId: string)
chat:error  (conversationId: string, error: string)
```

## Section 4: UI

### New `stores/chat.ts`

Nanostores holding:
- `conversations: McConversation[]` for the selected deployment
- `selectedConversationId: string | null`
- `messages: Record<string, McMessage[]>`
- `streamingEvents: Record<string, AgentEvent[]>` — accumulating events for the in-flight turn
- `sending: Record<string, boolean>`

### Updated `chat.tsx` — Two-panel layout

```
┌─────────────────┬──────────────────────────────────┐
│  Conversations  │  Message thread                  │
│                 │                                  │
│  [Agent picker] │  ┌──────────────────────────┐   │
│  ─────────────  │  │ user bubble              │   │
│  > Conv 1       │  └──────────────────────────┘   │
│    Conv 2       │  ┌──────────────────────────┐   │
│    Conv 3       │  │ 💭 Thinking...           │   │
│                 │  │ 🔧 bash(...)             │   │
│  [+ New]        │  │ streaming text here...   │   │
│                 │  └──────────────────────────┘   │
│                 │  [input]              [Send]     │
└─────────────────┴──────────────────────────────────┘
```

**Agent picker:** Dropdown at top of left panel. Filters conversation list and scopes new conversations to the selected agent.

**Event rendering:**

| Event | Display |
|---|---|
| `text_delta` | Appended inline to streaming assistant bubble |
| `thinking_delta` | Collapsible "Thinking…" block (dimmed) |
| `tool_use_start` + `tool_use_delta` | `🔧 <name>(streaming JSON...)` |
| `tool_result` | `✓ result` (green) or `✗ error` (red) |
| `response` | Finalises the bubble, no extra display |
| `error` | Red error bubble |

**Persisted message rendering:** Stored `events: AgentEvent[]` on assistant messages pass through the same rendering logic — no separate display path needed.

## Section 5: Error Handling

| Failure | Behaviour |
|---|---|
| WS connection failure | `chat:error` → red error bubble, conversation remains selectable to retry |
| Unknown `agentName` in gateway | Gateway sends `{ type: 'error' }` → same error bubble path |
| Deployment not running | `ChatService` throws before opening WS → IPC error → "Agent not running" state |
| Mid-stream WS close | Error emitted, partial events saved → partial response visible on reload |
| Cancel | WS closed, partial message saved to store |

## Section 6: Testing

- **`MissionControlAdapter`** — unit tests: routes to correct agent by name, streams all event types, rejects unknown agent, rejects bad token
- **`ConversationStore`** — unit tests: create/list/delete, appendMessage, getMessages, JSONL format correctness
- **`ChatService`** — unit tests with mock WS server: full send→event→done flow, cancel mid-stream, deployment-not-running error
- **`chat.tsx`** — Vitest + React Testing Library: conversation list renders, new conversation creates correctly, each event type renders correctly

## Files Changed

| File | Change |
|---|---|
| `packages/channels/src/adapters/mission-control.ts` | Upgrade protocol, multi-agent routing, auth, streaming |
| `packages/channels/src/adapters/mission-control.test.ts` | New tests |
| `packages/channels/src/types.ts` | No change (MC adapter bypasses ChannelAdapter interface for streaming) |
| `packages/mc/src/conversations.ts` | New `ConversationStore` |
| `packages/mc/src/conversations.test.ts` | New tests |
| `packages/mc/src/index.ts` | Export `ConversationStore`, `McConversation`, `McMessage` |
| `apps/gateway/src/gateway.ts` | Pass agents map + token to MC adapter; skip router registration |
| `apps/gateway/src/config.ts` | Add `token` field to MC channel config |
| `apps/mission-control/src/main/chat-service.ts` | New `ChatService` |
| `apps/mission-control/src/main/chat-service.test.ts` | New tests |
| `apps/mission-control/src/main/ipc.ts` | Replace chat handlers with `ChatService` delegates |
| `apps/mission-control/src/shared/ipc.ts` | Replace chat IPC types with new conversation + event API |
| `apps/mission-control/src/renderer/src/stores/chat.ts` | New chat store |
| `apps/mission-control/src/renderer/src/routes/chat.tsx` | Two-panel UI, event rendering |
