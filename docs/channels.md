# Channels

Channels connect users to agents. Each channel adapter handles a specific messaging platform and routes messages to a configured agent.

## Telegram

### Setup

1. **Create a bot** — message [@BotFather](https://t.me/BotFather) on Telegram and follow the `/newbot` flow to get a bot token.

2. **Set the token** — add it to `.env` or `config/credentials.json`:

   ```env
   TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
   ```

3. **Find your user ID** — message [@userinfobot](https://t.me/userinfobot) to get your numeric Telegram user ID.

4. **Restrict access** (recommended) — set allowed users to prevent unauthorized access:

   ```env
   TELEGRAM_ALLOWED_USERS=123456789,987654321
   ```

   Or in `config/dash.json`:

   ```json
   {
     "channels": {
       "telegram": {
         "agent": "default",
         "allowedUsers": ["123456789", "@username"]
       }
     }
   }
   ```

   Users can be specified by numeric ID or `@username`. When the list is empty, **all users** are allowed.

5. **Start the server**:

   ```bash
   npm run dev
   ```

### How it works

- The Telegram adapter uses **long polling** (not webhooks) via the [grammY](https://grammy.dev/) framework
- On startup, pending updates are dropped to avoid 409 conflicts with stale polling sessions
- Only text messages are processed — other message types (photos, stickers, etc.) are ignored
- The full response is collected before sending — no streaming to Telegram
- Each Telegram chat ID maps to a separate conversation with its own session history

### Access control

When `allowedUsers` is set (via config or `TELEGRAM_ALLOWED_USERS`), the adapter checks incoming messages against the list. Users not on the list receive "Sorry, you are not authorized to use this bot." and their message is discarded.

Matching checks the user's numeric ID and username (with or without the `@` prefix).

## CLI (TUI)

The TUI is a terminal-based REPL that connects to an agent via the `cli` channel.

### Running

```bash
npm run dev --workspace=packages/tui
```

### Configuration

Map the `cli` channel to an agent in `config/dash.json`:

```json
{
  "channels": {
    "cli": {
      "agent": "coder"
    }
  }
}
```

If no `cli` channel is configured, the TUI falls back to the `default` agent.

### Features

- Streaming text output — tokens appear as they arrive
- Spinner with status — shows "thinking" during inference, "thinking deeply" during extended thinking
- Tool execution display — shows tool name, input, and result in a formatted block (truncated to 6 lines)
- Token usage — displayed after each response (input/output counts)
- Color support — ANSI colors with `NO_COLOR` environment variable respected

### Session handling

Each TUI session creates a conversation ID in the format `cli:<timestamp>`. Sessions are persisted to the JSONL session store but currently cannot be resumed — each TUI launch starts a new conversation.

## Channel-agent binding

The `channels` config maps channel names to agent names:

```json
{
  "channels": {
    "telegram": { "agent": "default" },
    "cli": { "agent": "coder" }
  }
}
```

The agent name must match a key in the `agents` config. If an agent name is not found, the server throws an error at startup:

```
Agent "unknown" not found. Available: default, coder
```

## Message flow

```
User message
  → Channel adapter receives message
  → MessageRouter finds the bound agent
  → agent.chat(channelId, conversationId, text)
  → Agent streams events (text, tool use, tool results)
  → Full response collected
  → Adapter sends response back to user
```

In the TUI, events are streamed directly to the terminal. In Telegram, the full response is sent as a single message after all tool rounds complete.
