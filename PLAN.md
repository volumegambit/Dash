# Dash: Multi-Channel AI Agent System

## Context

Build an OpenClaw-inspired agent system ("Dash") using Pi-Mono (`@mariozechner/pi-agent-core`) as the agent layer. Multi-provider LLM support, channel adapters starting with Telegram, and a full TUI. TypeScript monorepo deployed as a Docker service.

## Architecture

```
                   ┌──────────┐
                   │  server   │  gateway, config, bootstrap
                   └────┬─────┘
            ┌───────────┼───────────┐
            v           v           v
       ┌────────┐  ┌─────────┐
       │  tui   │  │channels │
       └────┬───┘  └────┬────┘
            │           │
            v           v
       ┌────────────────────────────┐
       │         agent              │
       │  (pi-agent-core, tools,   │
       │   skills, sessions)        │
       └────────────┬───────────────┘
                    v
              ┌──────────┐
              │   llm    │
              │ (pi-ai)  │
              └──────────┘
```

**5 packages** in `packages/` using npm workspaces:

| Package | Purpose | Key Dependencies |
|---------|---------|-----------------|
| `@dash/llm` | Multi-provider LLM — wraps `@mariozechner/pi-ai` | `@mariozechner/pi-ai` |
| `@dash/agent` | Agent runtime — wraps `@mariozechner/pi-agent-core`, tool registry, sessions, skills | `@dash/llm`, `@mariozechner/pi-agent-core` |
| `@dash/channels` | Channel adapters (Telegram, CLI, future: Slack) + message router | `@dash/agent`, `grammy` |
| `@dash/tui` | Rich terminal UI — wraps `@mariozechner/pi-tui` or uses Ink | `@dash/agent`, `ink` or `@mariozechner/pi-tui` |
| `@dash/server` | Gateway entry point, config, lifecycle | all packages, `pino`, `dotenv` |

## Pi-Mono Integration

Pi-Mono provides three core packages we build on:

### `@mariozechner/pi-ai` (LLM Layer)
- Unified LLM API across 20+ providers (Anthropic, OpenAI, Google, Ollama, etc.)
- Common streaming interface
- Mid-conversation provider handoffs (converts thinking blocks, preserves tool calls)
- `@dash/llm` wraps this, adding Dash-specific config and cost tracking

### `@mariozechner/pi-agent-core` (Agent Layer)
- `AgentState`: single state object (systemPrompt, model, tools, messages, pendingToolCalls)
- `Agent` class with method-based state updates
- Tool registry with dynamic enable/disable
- Event-driven architecture (subscribe to events, not poll)
- Steering Queue (interrupt) + Follow-Up Queue (wait for idle)
- `@dash/agent` wraps this, adding session persistence, skill injection, and Dash-specific tools

### `@mariozechner/pi-tui` (TUI Layer)
- Terminal rendering with differential updates
- Keyboard input handling
- Component system
- Evaluate whether to use directly or prefer Ink for more flexible React-based UI

## Key Types (Dash-specific, layered on Pi-Mono)

### Channel Adapter
```typescript
interface ChannelAdapter {
  readonly name: string;
  readonly type: 'telegram' | 'slack' | 'cli';
  start(): Promise<void>;
  stop(): Promise<void>;
  send(conversationId: string, message: OutboundMessage): Promise<void>;
  onMessage(handler: (msg: InboundMessage) => Promise<void>): void;
}

interface InboundMessage {
  channelType: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: number;
  raw: unknown;
}

interface OutboundMessage {
  text: string;
  format?: 'text' | 'markdown' | 'html';
}
```

### Session Store
```typescript
interface SessionStore {
  create(channelId: string, userId: string, model: string): Promise<Session>;
  load(sessionId: string): Promise<Session | null>;
  save(session: Session): Promise<void>;
  append(sessionId: string, message: AgentMessage): Promise<void>;
  list(filter?: { channelId?: string; userId?: string }): Promise<Session[]>;
}
```

### Message Router
```typescript
interface MessageRouter {
  route(message: InboundMessage): Promise<string>; // → sessionId
  streamToChannel(sessionId: string, events: AsyncGenerator<AgentEvent>,
                  adapter: ChannelAdapter, conversationId: string): Promise<void>;
}
```

## Project Structure

```
Dash/
├── package.json              # npm workspaces root
├── tsconfig.base.json
├── biome.json
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── PLAN.md
├── packages/
│   ├── llm/src/
│   │   ├── index.ts          # Re-exports pi-ai with Dash config
│   │   ├── config.ts         # Provider config, model defaults, cost tracking
│   │   └── __tests__/
│   ├── agent/src/
│   │   ├── index.ts
│   │   ├── dash-agent.ts     # Wraps pi-agent-core Agent with Dash features
│   │   ├── session.ts        # JSONL session persistence
│   │   ├── skills.ts         # Markdown skill loader + trigger-based injection
│   │   ├── tools/            # bash.ts, read-file.ts, web-search.ts, web-fetch.ts
│   │   └── __tests__/
│   ├── channels/src/
│   │   ├── index.ts
│   │   ├── types.ts          # ChannelAdapter, InboundMessage, OutboundMessage
│   │   ├── router.ts         # Message → session routing
│   │   └── adapters/         # telegram.ts, cli.ts
│   ├── tui/src/
│   │   ├── app.tsx           # Root component
│   │   └── components/       # chat, input, status-bar, tool-output
│   └── server/src/
│       ├── index.ts          # Entry point
│       ├── gateway.ts        # Bootstrap channels + agent
│       └── config.ts         # Config loader
├── skills/                   # Markdown skill files
│   ├── coding.md
│   ├── research.md
│   └── conversation.md
└── config/
    └── dash.default.json
```

## Implementation Phases

### Phase 1: Foundation — "Hello from Telegram"
1. Initialize monorepo (npm workspaces, TypeScript, Biome, tsup, vitest)
2. Install and configure `@mariozechner/pi-ai` — Anthropic provider
3. Install and configure `@mariozechner/pi-agent-core` — basic agent with no tools
4. `@dash/channels` — Telegram adapter (grammY, polling mode), message router
5. `@dash/server` — Gateway wiring, config from `.env`
6. JSONL session store (append-only, `~/.dash/sessions/`)
7. Dockerfile + docker-compose

**Milestone**: Send Telegram message → get Claude response. Sessions persist across restarts.

### Phase 2: Tools & Skills
1. Register tools with pi-agent-core's tool registry
2. Built-in tools: `bash`, `read_file`, `web_search`, `web_fetch`
3. Agent loop with tool execution (pi-agent-core handles the loop natively)
4. Skill loader (`.md` files) with trigger-based system prompt injection
5. Streaming responses to Telegram (chunked message updates)

**Milestone**: Bot executes tools and applies skills contextually.

### Phase 3: TUI
1. `@dash/tui` — evaluate pi-tui vs Ink, build terminal interface
2. Chat with streaming, tool output display, multi-line input, status bar
3. CLI channel adapter (direct pipe to agent)
4. Session management (list, resume)
5. `dash` CLI entry point

**Milestone**: Full terminal experience alongside Telegram.

### Phase 4: Multi-Provider
1. Enable additional pi-ai providers (OpenAI, Google, Ollama)
2. Per-channel model configuration
3. Mid-conversation model switching
4. Cost tracking

### Phase 5: Production Hardening
1. Structured logging (pino), graceful shutdown
2. Slack adapter (`@slack/bolt`)
3. Channel-level message queuing
4. Comprehensive test suite

## Tooling

| Tool | Choice |
|------|--------|
| Runtime | Node.js 22+ (ESM) |
| Agent | `@mariozechner/pi-agent-core` |
| LLM | `@mariozechner/pi-ai` |
| Build | tsup |
| Lint/Format | Biome |
| Test | vitest |
| Telegram | grammY |
| TUI | Ink or `@mariozechner/pi-tui` (evaluate) |
| Sessions | Custom JSONL (append-only) |
| Logging | pino |
| Docker | node:22-slim, multi-stage |

## Design Decisions

- **Pi-Mono as the agent layer** — Provides battle-tested agent loop, tool registry, event system, and multi-provider LLM out of the box. Dash adds channels, sessions, skills, and TUI on top.
- **JSONL sessions** — Human-readable, append-only, no binary deps (matches OpenClaw/Pi-Mono patterns)
- **grammY for Telegram** — TypeScript-first, actively maintained
- **npm workspaces** — Minimal tooling, sufficient for this scale

## Verification

1. **Phase 1**: `docker compose up` → send Telegram message → receive Claude response → restart → context retained
2. **Phase 2**: Ask bot to search web or read a file → tool executes → result in response
3. **Phase 3**: Run `npx dash` → interactive TUI with streaming and tool display
4. **All phases**: `npm test` passes across all packages
