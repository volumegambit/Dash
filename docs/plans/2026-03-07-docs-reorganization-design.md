# Docs Reorganization Design

**Date:** 2026-03-07

## Overview

Move user-facing docs from `docs/` to `user_docs/`, and add three new reference pages: Management API, CLI reference, and LLM providers. Update `configuration.mdx` to reflect OpenAI and Google support added in recent PRs.

## File Changes

### Move

All user-facing content moves from `docs/` to `user_docs/`:

```
user_docs/
├── docs.json              # Mintlify config (updated navigation)
├── introduction.mdx
├── getting-started.mdx
├── channels.mdx
├── extended-thinking.mdx
├── configuration.mdx      # updated
├── tools.mdx
├── architecture.mdx
├── troubleshooting.mdx
├── api-reference.mdx      # new
├── cli-reference.mdx      # new
└── providers.mdx          # new

docs/
└── plans/                 # unchanged
```

### New Pages

**`api-reference.mdx` — Management API**

Full REST reference for the Management API (port 9100):
- Auth: `Authorization: Bearer <token>` on all requests; 401 on bad/missing token
- `GET /health` → `{ status: "healthy", uptime: number, version: string }`
- `GET /info` → `{ agents: [{ name, model, tools }] }`
- `POST /lifecycle/shutdown` → `{ success: true }`
- Error shape: `{ error: string }`

**`cli-reference.mdx` — Mission Control CLI**

Full `mc` command reference in two groups:

Deployment commands:
- `mc deploy <config-dir>`
- `mc status [id]`
- `mc stop <id>`
- `mc remove <id>`
- `mc logs <id>`
- `mc health [id]`
- `mc info [id]`

Secrets commands:
- `mc secrets list`
- `mc secrets get <key> [--reveal]`
- `mc secrets set <key> [--value v]`
- `mc secrets delete <key>`
- `mc secrets change-password`
- `mc lock`
- `mc unlock`

**`providers.mdx` — LLM Providers**

All three providers: Anthropic, OpenAI, Google. For each:
- How to set the API key (env var and `credentials.json` field)
- Model naming convention and how routing works (prefix-based)

Updated `credentials.json` example showing all three fields.

### Updated Pages

**`configuration.mdx`**
- Add `GOOGLE_API_KEY` and `OPENAI_API_KEY` to the env vars table
- Update `credentials.json` example to include `google` and `openai` fields
- Add cross-link to `providers.mdx`

**`docs.json`**
- Add `providers`, `api-reference`, and `cli-reference` to the Reference navigation group

## What Stays

`docs/plans/` is unchanged — the superpowers skill writes design docs there.
