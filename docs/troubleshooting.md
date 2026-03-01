# Troubleshooting

## Missing API key

**Error:**
```
Missing ANTHROPIC_API_KEY. Set it in config/credentials.json or as an env var.
```

**Fix:** Set `ANTHROPIC_API_KEY` in your `.env` file or `config/credentials.json`. See [Getting Started](getting-started.md#configuration).

---

## Missing Telegram token

**Error (server mode):**
```
Missing TELEGRAM_BOT_TOKEN. Set it in config/credentials.json or as an env var.
```

**Fix:** Set `TELEGRAM_BOT_TOKEN` in `.env` or `config/credentials.json`. If you only want to use the TUI, run `npm run dev --workspace=packages/tui` instead — it doesn't require a Telegram token.

---

## Agent not found

**Error:**
```
Agent "myagent" not found. Available: default, coder
```

**Fix:** The `agent` field in your channel config references an agent name that doesn't exist in `agents`. Check `config/dash.json` and make sure the channel's `agent` value matches a key in the `agents` object.

---

## Telegram 409 conflict

**Error:**
```
Telegram bot error: 409: Conflict: terminated by other getUpdates request
```

**Cause:** Another instance of the bot is already polling. Only one process can poll a Telegram bot at a time.

**Fix:**
- Stop the other instance (check for running Docker containers or background processes)
- Dash drops pending updates on startup to mitigate stale sessions, but it can't fix a concurrent polling conflict

---

## Tool errors

### Workspace not found

If a tool reports it can't find files, check that the `workspace` path in your agent config exists. Dash creates the workspace directory automatically at startup, but if the config path is wrong, the tool may be looking in the wrong place.

### Path escape blocked

**Error:**
```
Error: path "../../etc/passwd" escapes the workspace directory
```

The `read_file` tool blocks paths that resolve outside the workspace. This is intentional — use absolute paths or paths relative to the workspace root.

### Command timeout

**Error:**
```
Command failed
```

The `bash` tool has a 30-second timeout. Long-running commands are killed after this period. Break long operations into smaller steps or increase the timeout in the source code if needed.

### Output truncation

The `bash` tool limits output to 100 KB. If a command produces more output, pipe it through `head`, `tail`, or redirect to a file and use `read_file` to retrieve specific sections.

---

## Config not found (TUI)

**Error:**
```
config/dash.json not found
```

The TUI requires a `config/dash.json` file. Copy the example:

```bash
cp config.example/dash.json config/dash.json
```

---

## Session issues

### Corrupt JSONL

If a session file has invalid JSON on a line (e.g. from a crash during write), the session loader will throw a parse error. To recover:

1. Find the session file: `data/sessions/{channelId}/{conversationId}/session.jsonl`
2. Open it in a text editor
3. Remove or fix the malformed line(s) — each line should be a valid JSON object
4. Restart Dash

Since JSONL is append-only, you can safely delete lines from the end without losing earlier conversation history.

### Starting fresh

To reset a conversation, delete its session directory:

```bash
rm -rf data/sessions/{channelId}/{conversationId}
```

To reset all sessions:

```bash
rm -rf data/sessions
```

---

## Docker issues

### Sessions lost on restart

Make sure the volume mount is in place in `docker-compose.yml`:

```yaml
volumes:
  - ./data/sessions:/app/data/sessions
```

Without this mount, session data lives only inside the container and is lost when it's recreated.

### Config changes not picked up

Config is mounted read-only (`./config:/app/config:ro`). Changes to `config/dash.json` on the host are reflected immediately on next container restart. If you need to apply changes without rebuilding:

```bash
docker compose restart
```

---

## Debug logging

Set `LOG_LEVEL=debug` in your `.env` file or environment for more verbose output:

```env
LOG_LEVEL=debug
```
