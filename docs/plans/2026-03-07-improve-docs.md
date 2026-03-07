# Docs Reorganization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move all user-facing docs from `docs/` to `user_docs/`, then add three new reference pages (Management API, CLI, LLM Providers) and update configuration docs for OpenAI/Google support.

**Architecture:** All user-facing Mintlify content (`.mdx` files + `docs.json`) moves to `user_docs/`. The `docs/plans/` directory stays untouched. Three new pages are created. Existing `configuration.mdx` is updated in-place after the move.

**Tech Stack:** Mintlify (MDX), git

---

### Task 1: Move user docs to user_docs/

**Files:**
- Create dir: `user_docs/`
- Move: all `docs/*.mdx` and `docs/docs.json` → `user_docs/`

**Step 1: Move the files with git mv**

```bash
mkdir -p user_docs
git mv docs/introduction.mdx user_docs/introduction.mdx
git mv docs/getting-started.mdx user_docs/getting-started.mdx
git mv docs/channels.mdx user_docs/channels.mdx
git mv docs/configuration.mdx user_docs/configuration.mdx
git mv docs/tools.mdx user_docs/tools.mdx
git mv docs/architecture.mdx user_docs/architecture.mdx
git mv docs/extended-thinking.mdx user_docs/extended-thinking.mdx
git mv docs/troubleshooting.mdx user_docs/troubleshooting.mdx
git mv docs/docs.json user_docs/docs.json
```

**Step 2: Verify the move**

Run: `ls user_docs/ && ls docs/`

Expected:
- `user_docs/` contains 8 `.mdx` files and `docs.json`
- `docs/` contains only the `plans/` directory

**Step 3: Commit**

```bash
git add -A
git commit -m "docs: move user-facing docs to user_docs/"
```

---

### Task 2: Update docs.json navigation

**Files:**
- Modify: `user_docs/docs.json`

**Step 1: Read the current docs.json**

Read `user_docs/docs.json`. Current content:

```json
{
  "$schema": "https://mintlify.com/docs.json",
  "theme": "maple",
  "name": "Dash",
  "colors": {
    "primary": "#3B82F6",
    "light": "#60A5FA",
    "dark": "#2563EB"
  },
  "navigation": {
    "groups": [
      {
        "group": "Getting started",
        "pages": ["introduction", "getting-started"]
      },
      {
        "group": "Guides",
        "pages": ["channels", "extended-thinking"]
      },
      {
        "group": "Reference",
        "pages": ["configuration", "tools", "architecture"]
      },
      {
        "group": "Help",
        "pages": ["troubleshooting"]
      }
    ]
  },
  "footerSocials": {
    "github": "https://github.com/volumegambit/Dash"
  }
}
```

**Step 2: Update the Reference group to include new pages**

Edit `user_docs/docs.json`. Change the Reference group pages from:
```json
["configuration", "tools", "architecture"]
```
to:
```json
["configuration", "providers", "tools", "architecture", "api-reference", "cli-reference"]
```

**Step 3: Commit**

```bash
git add user_docs/docs.json
git commit -m "docs: add providers, api-reference, cli-reference to navigation"
```

---

### Task 3: Update configuration.mdx for multi-provider support

**Files:**
- Modify: `user_docs/configuration.mdx`

**Step 1: Update the environment variables table**

Find the environment variables table (around line 136). It currently reads:

```
| `ANTHROPIC_API_KEY` | `credentials.json → anthropic.apiKey` | Anthropic API key (required) |
| `MANAGEMENT_API_TOKEN` | — | Enables the Management API when set |
| `MANAGEMENT_API_PORT` | — | Management API port (default: `9100`) |
| `CHAT_API_TOKEN` | — | Enables the Chat API when set |
| `CHAT_API_PORT` | — | Chat API port (default: `9101`) |
| `LOG_LEVEL` | `logging.level` | Log level override |
```

Replace with:

```
| `ANTHROPIC_API_KEY` | `credentials.json → anthropic.apiKey` | Anthropic API key |
| `OPENAI_API_KEY` | `credentials.json → openai.apiKey` | OpenAI API key |
| `GOOGLE_API_KEY` | `credentials.json → google.apiKey` | Google API key |
| `MANAGEMENT_API_TOKEN` | — | Enables the Management API when set |
| `MANAGEMENT_API_PORT` | — | Management API port (default: `9100`) |
| `CHAT_API_TOKEN` | — | Enables the Chat API when set |
| `CHAT_API_PORT` | — | Chat API port (default: `9101`) |
| `LOG_LEVEL` | `logging.level` | Log level override |
```

**Step 2: Update the credentials.json tab in getting-started**

In the "Credentials file" tab (around line 62-78), the example currently shows only `anthropic`. Update to show all three providers:

```json
{
  "anthropic": {
    "apiKey": "sk-ant-..."
  },
  "openai": {
    "apiKey": "sk-..."
  },
  "google": {
    "apiKey": "AIza..."
  }
}
```

**Step 3: Add a cross-link to providers page**

After the environment variables table, add a note:

```mdx
<Note>
  For details on which models each provider supports and how routing works, see [LLM Providers](/providers).
</Note>
```

**Step 4: Commit**

```bash
git add user_docs/configuration.mdx
git commit -m "docs: add OpenAI and Google to env vars and credentials schema"
```

---

### Task 4: Create providers.mdx

**Files:**
- Create: `user_docs/providers.mdx`

**Step 1: Write the file**

Create `user_docs/providers.mdx` with the following content:

```mdx
---
title: "LLM Providers"
description: "Configure Anthropic, OpenAI, and Google as LLM providers for your agents."
---

Dash supports multiple LLM providers. The provider for each agent is determined automatically from the model name — no extra configuration needed beyond supplying the right API key.

## Provider routing

Model names are matched by prefix:

| Model prefix | Provider |
|-------------|----------|
| `claude-*` | Anthropic |
| `gpt-*`, `o1*`, `o3*`, `o4*` | OpenAI |
| `gemini-*` | Google |

If the model prefix doesn't match any provider, Dash falls back to the first registered provider.

## Configuring credentials

Each provider needs an API key. Set it via environment variable, `credentials.json`, or a `--secrets` file (see [CLI flags](/configuration#cli-flags)).

### credentials.json

```json
{
  "anthropic": {
    "apiKey": "sk-ant-..."
  },
  "openai": {
    "apiKey": "sk-..."
  },
  "google": {
    "apiKey": "AIza..."
  }
}
```

You only need to include providers you're actually using.

### Environment variables

| Variable | Provider |
|----------|----------|
| `ANTHROPIC_API_KEY` | Anthropic |
| `OPENAI_API_KEY` | OpenAI |
| `GOOGLE_API_KEY` | Google |

Environment variables take precedence over `credentials.json`.

## Anthropic

Sign up at [console.anthropic.com](https://console.anthropic.com) to get an API key.

**Example models:**
- `claude-sonnet-4-20250514` — balanced performance and speed
- `claude-opus-4-20250514` — highest capability

**Configuration:**

```env
ANTHROPIC_API_KEY=sk-ant-...
```

or in `credentials.json`:

```json
{ "anthropic": { "apiKey": "sk-ant-..." } }
```

## OpenAI

Sign up at [platform.openai.com](https://platform.openai.com) to get an API key.

**Example models:**
- `gpt-4o` — multimodal, fast
- `o3` — advanced reasoning

**Configuration:**

```env
OPENAI_API_KEY=sk-...
```

or in `credentials.json`:

```json
{ "openai": { "apiKey": "sk-..." } }
```

## Google

Sign up at [aistudio.google.com](https://aistudio.google.com) to get an API key.

**Example models:**
- `gemini-2.0-flash` — fast, efficient
- `gemini-2.5-pro` — highest capability

**Configuration:**

```env
GOOGLE_API_KEY=AIza...
```

or in `credentials.json`:

```json
{ "google": { "apiKey": "AIza..." } }
```

## Using a provider in an agent

Set the `model` field in your agent config to any model from the provider:

```json
{
  "agents": {
    "default": {
      "model": "claude-sonnet-4-20250514",
      "systemPrompt": "You are a helpful assistant.",
      "tools": ["bash", "read_file"]
    },
    "gpt-agent": {
      "model": "gpt-4o",
      "systemPrompt": "You are a helpful assistant.",
      "tools": ["bash", "read_file"]
    },
    "gemini-agent": {
      "model": "gemini-2.0-flash",
      "systemPrompt": "You are a helpful assistant.",
      "tools": ["bash", "read_file"]
    }
  }
}
```

Dash will use the corresponding provider for each agent automatically.
```

**Step 2: Commit**

```bash
git add user_docs/providers.mdx
git commit -m "docs: add LLM providers reference page"
```

---

### Task 5: Create api-reference.mdx

**Files:**
- Create: `user_docs/api-reference.mdx`

**Step 1: Write the file**

Create `user_docs/api-reference.mdx` with the following content:

```mdx
---
title: "Management API"
description: "HTTP API for monitoring and controlling a running Dash agent server."
---

The Management API is an HTTP server that runs on port 9100 (configurable via `MANAGEMENT_API_PORT`). Enable it by setting `MANAGEMENT_API_TOKEN` in your environment or via `--secrets`.

All endpoints require a Bearer token in the `Authorization` header. Requests with a missing or invalid token return `401`.

## Authentication

```
Authorization: Bearer <your-management-token>
```

## Endpoints

### GET /health

Returns the current health status and uptime of the agent server.

**Request**

```bash
curl http://localhost:9100/health \
  -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
```

**Response**

```json
{
  "status": "healthy",
  "uptime": 42.3,
  "version": "0.1.0"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `status` | `"healthy"` | Always `"healthy"` when the server is up |
| `uptime` | `number` | Seconds since the server started |
| `version` | `string` | Server version |

---

### GET /info

Returns information about the configured agents.

**Request**

```bash
curl http://localhost:9100/info \
  -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
```

**Response**

```json
{
  "agents": [
    {
      "name": "default",
      "model": "claude-sonnet-4-20250514",
      "tools": ["bash", "read_file"]
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `agents` | `AgentInfo[]` | List of configured agents |
| `agents[].name` | `string` | Agent name (matches config key) |
| `agents[].model` | `string` | Model ID the agent uses |
| `agents[].tools` | `string[]` | Enabled tool names |

---

### POST /lifecycle/shutdown

Gracefully shuts down the agent server.

**Request**

```bash
curl -X POST http://localhost:9100/lifecycle/shutdown \
  -H "Authorization: Bearer $MANAGEMENT_API_TOKEN"
```

**Response**

```json
{ "success": true }
```

<Warning>
  This immediately initiates shutdown. In-flight requests may be interrupted. Use this only when you intend to stop the server.
</Warning>

---

## Error responses

All endpoints return the same error shape on failure:

```json
{ "error": "Unauthorized" }
```

| HTTP status | Meaning |
|------------|---------|
| `401` | Missing or invalid `Authorization` header |

## Binding

The Management API binds to `127.0.0.1` by default, so it is not accessible from other machines without a reverse proxy or tunnel.

<Note>
  The Management API and Chat API use separate tokens and separate ports. A management token cannot be used on the chat port, and vice versa.
</Note>
```

**Step 2: Commit**

```bash
git add user_docs/api-reference.mdx
git commit -m "docs: add Management API reference page"
```

---

### Task 6: Create cli-reference.mdx

**Files:**
- Create: `user_docs/cli-reference.mdx`

**Step 1: Write the file**

Create `user_docs/cli-reference.mdx` with the following content:

```mdx
---
title: "CLI Reference"
description: "Full reference for the mc (Mission Control) CLI."
---

The `mc` CLI manages Dash agent deployments and encrypted secrets. Run it with `npm run mc-cli -- <command>` from the project root, or use the `mc` binary if installed globally.

## Deployment commands

### mc deploy \<config-dir\>

Deploy an agent server (and optionally a gateway) from a config directory.

```bash
mc deploy ./my-config
```

The config directory should contain a `dash.json` and optionally a `gateway.json`. If a Telegram adapter is configured in `gateway.json`, you'll be prompted for the bot token if it hasn't been stored yet.

On first run, you'll be prompted for your Anthropic API key if it hasn't been stored. The key is saved to the encrypted secret store.

**Output:**

```
Deployment abc123 created.
  Status: running
  Management API: http://localhost:9100
  Chat API: ws://localhost:9101/ws
  Agent server PID: 12345
```

---

### mc status \[id\]

List all deployments, or show detailed status for a specific deployment.

```bash
mc status          # list all deployments
mc status abc123   # detailed status for abc123
```

**Output (list):**

```
abc123  my-config  running  2026-03-07T12:00:00.000Z
```

**Output (detail):**

```
Deployment: abc123
  State: running
  Management port: 9100
  Chat port: 9101
  Agent server PID: 12345
  Gateway PID: 12346
  Uptime: 300s
```

| State | Meaning |
|-------|---------|
| `running` | All processes are up |
| `stopped` | Processes have exited |
| `error` | One or more processes failed to start |

---

### mc stop \<id\>

Stop a running deployment.

```bash
mc stop abc123
```

Sends a shutdown signal to the agent server and gateway. Does not remove the deployment record — use `mc status` to confirm it stopped, and `mc remove` to clean up.

---

### mc remove \<id\>

Remove a deployment and clean up its associated secrets.

```bash
mc remove abc123
```

---

### mc logs \<id\>

Stream stdout/stderr from a running deployment.

```bash
mc logs abc123
```

Streams log lines until interrupted (Ctrl+C). Only works for locally running deployments.

---

### mc health \<target\>

Check the health of a Dash agent server.

```bash
mc health abc123                          # by deployment ID
mc health http://localhost:9100 -t $TOKEN # by URL
```

`target` can be a deployment ID (token is looked up automatically) or a full URL (token required via `--token`).

**Options:**

| Flag | Description |
|------|-------------|
| `-t, --token <token>` | Management API token (required when target is a URL) |

**Output:**

```json
{
  "status": "healthy",
  "uptime": 42.3,
  "version": "0.1.0"
}
```

---

### mc info \<target\>

Get agent configuration info from a running server.

```bash
mc info abc123
mc info http://localhost:9100 -t $TOKEN
```

**Options:**

| Flag | Description |
|------|-------------|
| `-t, --token <token>` | Management API token (required when target is a URL) |

**Output:**

```json
{
  "agents": [
    {
      "name": "default",
      "model": "claude-sonnet-4-20250514",
      "tools": ["bash", "read_file"]
    }
  ]
}
```

---

## Secrets commands

Secrets are stored in an AES-256-GCM encrypted file at `~/.mission-control/secrets.enc`. See [encrypted secrets](/configuration#encrypted-secrets) for how the encryption works.

### mc secrets list

List all stored secret key names (values are not shown).

```bash
mc secrets list
```

**Output:**

```
anthropic-api-key
telegram-bot-token
```

---

### mc secrets get \<key\>

Show a secret value (masked by default).

```bash
mc secrets get anthropic-api-key
mc secrets get anthropic-api-key --reveal
```

**Options:**

| Flag | Description |
|------|-------------|
| `--reveal` | Show the full value instead of a masked version |

---

### mc secrets set \<key\>

Store a secret. Prompts for the value interactively by default.

```bash
mc secrets set anthropic-api-key
mc secrets set anthropic-api-key --value sk-ant-...
```

**Options:**

| Flag | Description |
|------|-------------|
| `--value <v>` | Set the value inline (useful for scripting) |

---

### mc secrets delete \<key\>

Remove a stored secret.

```bash
mc secrets delete anthropic-api-key
```

---

### mc secrets change-password

Re-encrypt the entire secret store with a new password.

```bash
mc secrets change-password
```

You'll be prompted for your current password, then a new password. The store is decrypted and re-encrypted in place.

---

### mc lock

Clear the cached encryption key from the OS keychain. Subsequent secret commands will prompt for your password again.

```bash
mc lock
```

---

### mc unlock

Unlock the secret store and cache the derived key in the OS keychain. Avoids repeated password prompts across commands.

```bash
mc unlock
```
```

**Step 2: Commit**

```bash
git add user_docs/cli-reference.mdx
git commit -m "docs: add CLI reference page"
```

---

### Task 7: Final verification

**Step 1: Check all files exist**

```bash
ls user_docs/
```

Expected output includes:
```
api-reference.mdx
architecture.mdx
channels.mdx
cli-reference.mdx
configuration.mdx
docs.json
extended-thinking.mdx
getting-started.mdx
introduction.mdx
providers.mdx
tools.mdx
troubleshooting.mdx
troubleshooting.mdx
```

**Step 2: Verify docs/plans/ is untouched**

```bash
ls docs/plans/
```

Expected: plan files still present, nothing removed.

**Step 3: Check docs.json has all new pages**

```bash
grep -E "providers|api-reference|cli-reference" user_docs/docs.json
```

Expected: all three page names appear.

**Step 4: Check configuration.mdx has new env vars**

```bash
grep -E "OPENAI_API_KEY|GOOGLE_API_KEY" user_docs/configuration.mdx
```

Expected: both variables appear.

**Step 5: Verify git log looks clean**

```bash
git log --oneline -7
```

Expected: 5–6 commits for this feature on top of the design doc commit.
