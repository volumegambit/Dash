# Agent Memory System Design

**Date:** 2026-03-08

## Problem

Agents deployed through Mission Control have no persistent memory. Every new conversation starts blank — the agent has forgotten everything from prior sessions. Additionally, long conversations grow unbounded, eventually hitting model context limits with no management strategy.

## Goals

- Every agent remembers important facts across conversations (user preferences, project context, recurring tasks).
- Agents proactively save memories and respond to explicit "remember this" requests.
- Long conversations are automatically compacted before they hit context limits.
- No changes required to existing tool, backend, or IPC code.

## Architecture

Two independent subsystems hang off `DashAgent.chat()`, both running before the backend:

```
DashAgent.chat(conversationId, text)
  │
  ├── 1. Load session messages from JSONL
  │
  ├── 2. [Memory] Read MEMORY.md → build system prompt preamble
  │        systemPrompt = memoryPreamble + "\n\n" + agent.systemPrompt
  │
  ├── 3. [Compaction] Estimate token count of session messages
  │        if > threshold → run compaction LLM call → replace old messages
  │
  └── 4. Run backend with augmented systemPrompt + (compacted) messages
```

`NativeBackend`, all tools, IPC, and the MC UI are untouched.

## Data Model

### MEMORY.md

Lives at `{workspace}/MEMORY.md`. Plain markdown, human-editable. The agent writes to it using the existing `write_file` tool.

```markdown
# Memory
- 2026-03-08: User's name is Gerry, prefers TypeScript over JavaScript
- 2026-03-08: Main project is Dash monorepo at ~/Projects/claude-workspace/Projects/Dash
- 2026-03-08: Preferred commit style: no Co-Authored-By lines
```

### Compaction Record

A new JSONL entry type `'compaction'` stored in the session file alongside existing `message`/`response` entries:

```jsonl
{"timestamp":"...","type":"compaction","data":{"summary":"## Goal\n...\n## Discoveries\n...","messageCount":47}}
```

When loading a session, if a compaction record exists, all messages before that point are discarded. The summary is injected as a synthetic assistant message at the start of the loaded history so the LLM sees it as prior context.

### Token Estimation

Simple heuristic: `Math.ceil(totalChars / 4)`. Compaction threshold: 80% of the model's declared context window. A small static map covers known Claude models; unknown models default to 100k tokens.

## Memory Preamble

A new `memory.ts` module reads `MEMORY.md` and returns a preamble string. `DashAgent` prepends it to the agent's configured system prompt before every `chat()` call.

**When MEMORY.md exists:**

```
You have a persistent memory file at {workspace}/MEMORY.md.

At the start of each conversation, read it to recall important context.
Proactively update it when you learn something worth remembering — user
preferences, project details, recurring tasks, important facts. Use
write_file to save memories. Keep entries concise and dated (YYYY-MM-DD).

Current memory:
---
{contents of MEMORY.md}
---
```

**When MEMORY.md does not exist yet:**

```
You have a persistent memory file at {workspace}/MEMORY.md (not yet created).
Create it with write_file when you learn something worth remembering.
```

**When agent has no workspace:** preamble is skipped entirely. Memory is implicitly opt-in — every MC-deployed agent gets a workspace automatically, so memory is on by default for all MC agents.

## Compaction

A new `compaction.ts` module. Called from `DashAgent.chat()` before the backend runs, only when the estimated token count exceeds the threshold.

**Compaction system prompt sent to the model:**

```
Summarize the following conversation into a structured handoff document.
Be detailed enough that the conversation can continue seamlessly.

## Goal
The main task or goal being worked on.

## Discoveries
Key facts, decisions, and information learned.

## Accomplished
What has been completed.

## Relevant Files
Important files and directories referenced.

## Next Steps
What needs to happen next (if known).
```

**Steps after a successful compaction:**

1. Write a `compaction` JSONL entry with the summary text and count of compacted messages.
2. Truncate the in-memory session — replace all prior messages with one synthetic assistant message containing the summary.
3. Append the user's new message after the summary and proceed.

**Error handling:** If the compaction LLM call fails, log a warning and proceed without compaction. Continuing slightly over the limit is safer than losing context.

## Files to Change

| File | Change |
|---|---|
| `packages/agent/src/memory.ts` | New — reads `MEMORY.md`, builds preamble string |
| `packages/agent/src/compaction.ts` | New — token estimation, compaction LLM call, session truncation |
| `packages/agent/src/session.ts` | Add `'compaction'` entry type; on load, stop at compaction record and inject summary as synthetic message |
| `packages/agent/src/agent.ts` | Call memory preamble builder; call compaction check; pass augmented systemPrompt to backend |
| `packages/agent/src/types.ts` | Add `compaction` to `SessionEntry` union type (if defined there) |

## What the Agent Gets for Free

The agent already has `write_file` to update `MEMORY.md` and `read_file` to inspect it. The preamble teaches it to use those tools. No new tools are needed.
