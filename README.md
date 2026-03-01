# Dash

Multi-channel AI agent system. TypeScript monorepo that connects LLM providers (Anthropic, OpenAI, Google) to messaging channels (Telegram, CLI) with tool use, session persistence, and a terminal UI.

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
     │  (tools, skills, sessions) │
     └────────────┬───────────────┘
                  v
            ┌──────────┐
            │   llm    │
            └──────────┘
```

| Package | Purpose |
|---------|---------|
| `@dash/llm` | Multi-provider LLM client (Anthropic SDK) |
| `@dash/agent` | Agent runtime — tool registry, session management, agentic loop |
| `@dash/channels` | Channel adapters (Telegram via grammY, CLI) + message router |
| `@dash/tui` | Terminal UI for interactive use |
| `@dash/server` | Gateway entry point, config loading, lifecycle |

## Quick Start

### Prerequisites

- Node.js 22+
- An Anthropic API key
- A Telegram bot token (for Telegram channel)

### Setup

```bash
git clone <repo-url> && cd Dash
npm install
cp -r config.example config
# Edit config/credentials.json with your API keys
# Edit config/dash.json for agent and channel settings
```

### Run (development)

```bash
npm run dev
```

### Run (Docker)

```bash
docker compose up --build
```

### Run tests

```bash
npm test
```

## Configuration

### Credentials (`config/credentials.json`)

API keys and bot tokens live in `config/credentials.json` (gitignored):

```json
{
  "anthropic": { "apiKey": "sk-ant-..." },
  "telegram": { "botToken": "123456:ABC-DEF..." }
}
```

Environment variables (`.env` or shell) override `credentials.json`, useful for CI or Docker:

```
ANTHROPIC_API_KEY=sk-ant-...
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
TELEGRAM_ALLOWED_USERS=123456789,@username
LOG_LEVEL=info
```

### Agent Config (`config/dash.json`)

Define named agent profiles with model, system prompt, tools, and token limits. Map channels to agent profiles:

```json
{
  "agents": {
    "default": {
      "model": "claude-sonnet-4-20250514",
      "tools": ["bash", "read_file"],
      "maxTokens": 4096
    }
  },
  "channels": {
    "telegram": { "agent": "default" },
    "cli": { "agent": "coder" }
  }
}
```

## Project Structure

```
Dash/
├── packages/
│   ├── llm/          # LLM provider abstraction
│   ├── agent/        # Agent runtime, tools, sessions
│   ├── channels/     # Telegram + CLI adapters, message router
│   ├── tui/          # Terminal UI
│   └── server/       # Entry point, gateway, config
├── config.example/
│   ├── credentials.json  # Credential placeholders
│   └── dash.json         # Default agent + channel configuration
├── config/           # User's runtime config (gitignored)
├── skills/           # User's skill files (gitignored)
├── data/
│   └── sessions/     # JSONL session files (persisted)
├── docker-compose.yml
├── Dockerfile
└── vitest.config.ts
```

## Documentation

Full documentation is in the [`docs/`](docs/) directory:

- [Getting Started](docs/getting-started.md) — install, configure, first run
- [Configuration](docs/configuration.md) — `dash.json` schema, env vars, defaults
- [Tools](docs/tools.md) — bash and read_file: parameters, sandboxing, limits
- [Channels](docs/channels.md) — Telegram setup, CLI usage, access control
- [Extended Thinking](docs/extended-thinking.md) — budget tuning, constraints
- [Architecture](docs/architecture.md) — package map, data flow, session format
- [Troubleshooting](docs/troubleshooting.md) — common errors, debugging tips

## Tooling

| | Choice |
|-|--------|
| Runtime | Node.js 22+ (ESM) |
| Build | tsup |
| Lint/Format | Biome |
| Test | Vitest |
| Telegram | grammY |
| Sessions | JSONL (append-only) |
| Logging | pino |
| Docker | node:22-slim, multi-stage |

## License

Private
