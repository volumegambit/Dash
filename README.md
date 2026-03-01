# Dash

[![CI](https://github.com/volumegambit/Dash/actions/workflows/ci.yml/badge.svg)](https://github.com/volumegambit/Dash/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![ESM](https://img.shields.io/badge/module-ESM-F7DF1E?logo=javascript&logoColor=black)](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Modules)
[![Biome](https://img.shields.io/badge/Biome-lint%20%26%20format-60A5FA?logo=biome&logoColor=white)](https://biomejs.dev)
[![Vitest](https://img.shields.io/badge/Vitest-tests-6E9F18?logo=vitest&logoColor=white)](https://vitest.dev)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ED?logo=docker&logoColor=white)](https://www.docker.com)
[![License](https://img.shields.io/badge/license-private-red)]()

Dash is a desktop-first, private-cloud-first platform that empowers anyone to safely deploy autonomous "claw" agents within minutes. Bring your preferred AI model, connect via Telegram, WebSocket, or the terminal UI, and put your agents to work — all while maintaining absolute control over your private data.

We believe the best way to discover AI's potential is by easily experimenting with it. Dash accelerates how you launch personal and professional agents by prioritizing security from the ground up:

- **Secure defaults** — Out-of-the-box protection so you can launch with confidence.
- **Secrets management** — Safe handling of your API keys and credentials, with read-then-delete secrets files for deployments.
- **Strict isolation** — Clear operational boundaries to keep every agent's autonomous actions contained.

## Why Dash?

Run on your own hardware or private cloud. Your data never leaves your infrastructure. Connect to Anthropic, OpenAI, Google, or any LLM provider you choose. Interact with agents through Telegram, a real-time WebSocket Chat API, or the terminal UI. Secrets are separated from config, agents are sandboxed, and access controls are built in. Simple JSON configuration, Docker deployment, and clear documentation. Define multiple agents with different models, tools, and system prompts. Manage deployments from the Mission Control desktop app or CLI.

## Architecture

```mermaid
graph TB
  subgraph platforms ["Chat platforms"]
    telegram["Telegram"]
  end

  subgraph server ["Server (your infrastructure)"]
    agent-server["agent-server<br/><small>config, lifecycle</small>"]
    agent-server --> chat["chat<br/><small>WebSocket :9101</small>"]
    agent-server --> management["management<br/><small>HTTP :9100</small>"]
    chat --> agent["agent<br/><small>tools, sessions</small>"]
    agent --> llm["llm<br/><small>Anthropic API</small>"]
    gateway["gateway<br/><small>channel routing</small>"]
    gateway -- "WebSocket :9101" --> chat
  end

  subgraph client ["Client (your machine)"]
    tui["tui<br/><small>terminal UI</small>"]
    mc["mission-control / mc-cli"]
  end

  telegram -- "Bot API (polling)" --> gateway
  tui -. "in-process<br/>(no server needed)" .-> agent
  mc -- "HTTP :9100" --> management
  mc -- "WebSocket :9200" --> gateway
```

Dash has four components that can run on different machines:

- **Agent server** — runs on your infrastructure (a VPS, private cloud, or local machine). Hosts agents and exposes two APIs: a Chat API (WebSocket, port 9101) for real-time interaction and a Management API (HTTP, port 9100) for health checks and shutdown. Each API uses its own auth token.
- **Gateway** — runs alongside the agent server. Connects to external chat platforms (Telegram, etc.) and routes messages to agents via the Chat API. Mission Control's chat panel also connects through the gateway. One process, one config file for all channels.
- **TUI** — runs on your local machine. Connects to an agent in-process with no network involved. Best for development and quick experimentation.
- **Mission Control** — desktop app or CLI, runs on your local machine. Connects to the gateway for chat (WebSocket, port 9200) and to agent servers for monitoring (HTTP, port 9100).

Everything can run on a single machine for development, or split across machines for production — the agent server and gateway on a VPS, Mission Control on your laptop.

**Libraries** (`packages/`) — ordered by dependency layer, foundational first:

| Package | What it does |
|---------|-------------|
| `@dash/llm` | Wraps LLM provider SDKs (Anthropic) behind a streaming interface |
| `@dash/agent` | Runs the agentic loop — tool execution, session persistence, orchestration |
| `@dash/channels` | Routes messages from channel adapters (Telegram, MC) to agents |
| `@dash/chat` | Exposes agents over WebSocket for real-time streaming (port 9101) |
| `@dash/management` | HTTP endpoints for health checks, server info, and shutdown (port 9100) |
| `@dash/mc` | Manages agent deployments, secrets, and remote connections for Mission Control |

**Apps** (`apps/`) — things you run:

| Package | What it does |
|---------|-------------|
| `@dash/agent-server` | Headless server that wires up agents and starts the management + chat APIs |
| `@dash/gateway` | Channel gateway — routes Telegram, MC chat, and other channels to agents |
| `@dash/tui` | Interactive terminal UI — connects directly to an agent, no server needed |
| `@dash/mission-control` | Desktop app for managing agent deployments and chatting (Electron + React) |
| `@dash/mc-cli` | CLI equivalent of Mission Control — `health`, `info` commands |

## Quick Start

### Prerequisites

- Node.js 22+
- An Anthropic API key

### Setup

```bash
git clone <repo-url> && cd Dash
npm install
cp -r config.example config
# Edit config/credentials.json with your API key
# Edit config/dash.json for agent settings
```

### Run the TUI

```bash
npm run tui
```

### Run the agent server

```bash
# Set tokens in .env to enable the APIs
MANAGEMENT_API_TOKEN=your-mgmt-token
CHAT_API_TOKEN=your-chat-token

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

API keys live in `config/credentials.json` (gitignored):

```json
{
  "anthropic": { "apiKey": "sk-ant-..." }
}
```

Environment variables (`.env` or shell) override `credentials.json`, useful for CI or Docker:

```
ANTHROPIC_API_KEY=sk-ant-...
MANAGEMENT_API_TOKEN=your-mgmt-token
CHAT_API_TOKEN=your-chat-token
LOG_LEVEL=info
```

For deployments, use `--secrets` to pass a temporary secrets file that is deleted after reading:

```bash
node apps/dash/dist/index.js --config /path/to/dash.json --secrets /path/to/secrets.json
```

### Agent Config (`config/dash.json`)

Define named agent profiles with model, system prompt, tools, and token limits:

```json
{
  "agents": {
    "default": {
      "model": "claude-sonnet-4-20250514",
      "tools": ["bash", "read_file"],
      "maxTokens": 4096
    }
  }
}
```

## Project Structure

```
Dash/
├── packages/
│   ├── llm/          # LLM provider abstraction
│   ├── agent/        # Agent runtime, tools, sessions
│   ├── channels/     # Channel adapters (Telegram, MC) + message router
│   ├── chat/         # Chat API (WebSocket server)
│   ├── management/   # Management API (HTTP server)
│   └── mc/           # Deployment registry, secrets store
├── apps/
│   ├── dash/         # Agent server entry point, config
│   ├── gateway/      # Channel gateway (routes channels to agents)
│   ├── tui/          # Terminal UI
│   ├── mc-cli/       # Mission Control CLI
│   └── mission-control/  # Mission Control desktop app (Electron)
├── config.example/
│   ├── credentials.json  # Credential placeholders
│   └── dash.json         # Default agent configuration
├── config/           # User's runtime config (gitignored)
├── data/
│   └── sessions/     # JSONL session files (persisted)
├── docker-compose.yml
├── Dockerfile
└── vitest.config.ts
```

## Documentation

Full documentation is available at [dash-aa8db5b5.mintlify.app](https://dash-aa8db5b5.mintlify.app/introduction), or in the [`docs/`](docs/) directory:

- [Getting Started](docs/getting-started.mdx) — install, configure, first run
- [Configuration](docs/configuration.mdx) — `dash.json` schema, env vars, defaults
- [Tools](docs/tools.mdx) — bash and read_file: parameters, sandboxing, limits
- [Channels](docs/channels.mdx) — TUI usage, Chat API protocol
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
| WebSocket | @hono/node-ws |
| Desktop | Electron + React |
| Sessions | JSONL (append-only) |
| Logging | pino |
| Docker | node:22-slim, multi-stage |

## License

Private
