# Dash

[![CI](https://github.com/volumegambit/Dash/actions/workflows/ci.yml/badge.svg)](https://github.com/volumegambit/Dash/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![ESM](https://img.shields.io/badge/module-ESM-F7DF1E?logo=javascript&logoColor=black)](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Modules)
[![Biome](https://img.shields.io/badge/Biome-lint%20%26%20format-60A5FA?logo=biome&logoColor=white)](https://biomejs.dev)
[![Vitest](https://img.shields.io/badge/Vitest-tests-6E9F18?logo=vitest&logoColor=white)](https://vitest.dev)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ED?logo=docker&logoColor=white)](https://www.docker.com)
[![License](https://img.shields.io/badge/license-private-red)]()

Dash empowers anyone to safely deploy autonomous "claw" agents on their own devices or private clouds. Bring your preferred AI model, connect to platforms like Telegram, and put your agents to work—all while maintaining absolute control over your private data.

We believe the best way to discover AI's potential is by easily experimenting with it. Dash accelerates how you launch personal and professional agents by prioritizing security from the ground up:

Secure Defaults: Out-of-the-box protection so you can launch with confidence.

Secrets Management: Safe, encrypted handling of your API keys and credentials.

Strict Isolation: Clear operational boundaries to keep every agent's autonomous actions contained.

## Why Dash?

- **Private by design** — Run on your own hardware or private cloud. Your data never leaves your infrastructure.
- **Bring your own model** — Connect to Anthropic, OpenAI, Google, or any LLM provider you choose.
- **Multi-channel** — Interact with your agents through Telegram, a terminal UI, or add your own channel adapter.
- **Safe defaults** — Secrets are separated from config, agents are sandboxed, and access controls are built in.
- **Non-technical friendly** — Simple JSON configuration, Docker deployment, and clear documentation.

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

- [Getting Started](docs/getting-started.mdx) — install, configure, first run
- [Configuration](docs/configuration.mdx) — `dash.json` schema, env vars, defaults
- [Tools](docs/tools.mdx) — bash and read_file: parameters, sandboxing, limits
- [Channels](docs/channels.mdx) — Telegram setup, CLI usage, access control
- [Extended Thinking](docs/extended-thinking.mdx) — budget tuning, constraints
- [Architecture](docs/architecture.mdx) — package map, data flow, session format
- [Troubleshooting](docs/troubleshooting.mdx) — common errors, debugging tips

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
