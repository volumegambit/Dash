# Getting Started

## Prerequisites

- **Node.js 22+** — Dash uses ESM and modern language features requiring Node 22 or later
- **Anthropic API key** — sign up at [console.anthropic.com](https://console.anthropic.com) and create an API key
- **Telegram bot token** (optional) — only needed if running the Telegram channel

## Installation

```bash
git clone <repo-url> Dash
cd Dash
npm install
npm run build
```

## Configuration

### Option A: Environment variables

Copy the example `.env` file and fill in your keys:

```bash
cp .env.example .env
```

Edit `.env`:

```env
ANTHROPIC_API_KEY=sk-ant-...
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
TELEGRAM_ALLOWED_USERS=123456789
LOG_LEVEL=info
```

### Option B: Credentials file

Copy the example credentials file:

```bash
cp config.example/credentials.json config/credentials.json
```

Edit `config/credentials.json`:

```json
{
  "anthropic": {
    "apiKey": "sk-ant-..."
  },
  "telegram": {
    "botToken": "123456:ABC-DEF..."
  }
}
```

Environment variables take precedence over `credentials.json` when both are set.

### Agent configuration

Copy the example config:

```bash
cp config.example/dash.json config/dash.json
```

See [Configuration](configuration.md) for the full schema.

## Running Dash

### TUI (terminal interface)

The TUI connects to the `cli` channel agent and provides an interactive REPL:

```bash
npm run dev --workspace=packages/tui
```

You'll see a header showing the active agent, model, tools, and workspace path. Type a message and press Enter.

### Server mode (Telegram)

The server starts the gateway and connects all configured channel adapters:

```bash
npm run dev
```

This requires both `ANTHROPIC_API_KEY` and `TELEGRAM_BOT_TOKEN` to be set.

### Docker

```bash
docker compose up --build
```

Session data is persisted via a volume mount at `./data/sessions`. Config is mounted read-only from `./config`.

## Next steps

- [Configuration](configuration.md) — full config schema and defaults
- [Channels](channels.md) — Telegram setup and CLI usage
- [Tools](tools.md) — built-in tools and workspace sandboxing
- [Extended Thinking](extended-thinking.md) — enable deeper reasoning
