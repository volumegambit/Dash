# Skills System Design

**Date:** 2026-03-08
**Branch:** worktree-skills
**Status:** Approved, ready for implementation

---

## 1. Decision

Integrate OpenCode's built-in skill system into Dash with full configuration control and a typed `skill_loaded` event. OpenCode already implements Claude-compatible skill discovery (`SKILL.md` + YAML frontmatter, scans `~/.claude/skills/` and `<workspace>/.claude/skills/`). Dash's role is to wire config passthrough, register `skill` as a known tool ID, and surface skill invocations as a first-class `AgentEvent`.

**Scope:** 4 files, ~30 lines of net new code.

---

## 2. Background: How OpenCode Skills Work

OpenCode has a production-grade skill system that Dash agents already benefit from silently:

- **File format:** `SKILL.md` with YAML frontmatter (`name`, `description`) — identical to Claude Code's format
- **Discovery order:**
  1. Global: `~/.claude/skills/**/SKILL.md`, `~/.agents/skills/**/SKILL.md`
  2. Project: `<workspace>/.claude/skills/**/SKILL.md`, `<workspace>/.agents/skills/**/SKILL.md`
  3. OpenCode-specific: `<workspace>/.opencode/skill/**/SKILL.md`
  4. Config-defined: `config.skills.paths[]` (local dirs) and `config.skills.urls[]` (remote registries)
- **Invocation:** The `skill` tool is always-on in OpenCode's tool registry. The agent calls `skill(name)` to load the full content into context.
- **Tool description:** OpenCode dynamically builds the `skill` tool description with an `<available_skills>` XML block listing all discovered skills — the agent reads this and decides when to invoke.
- **Permission filtering:** Per-agent permission rules can deny specific skills.

**The gap:** Dash's `createOpencodeServer` only forwards `{ model }` — `skills.paths` and `skills.urls` from Dash config are never passed to OpenCode. The `skill` tool ID is also absent from Dash's known tools list, making it impossible to explicitly disable per agent.

---

## 3. Architecture

### Approach: Thin Config Passthrough + Typed Event

Dash deliberately avoids re-implementing any skill discovery or loading logic. OpenCode handles all of it. Dash's additions:

1. **Config schema** — expose `skills` in `AgentConfig` mirroring OpenCode's schema exactly
2. **Config passthrough** — forward `skills` to `createOpencodeServer`
3. **Tool registration** — add `skill` to `ALL_OPENCODE_TOOLS` so it can be explicitly allowed/denied
4. **Event surfacing** — emit `skill_loaded` alongside `tool_result` when the skill tool completes

---

## 4. Config Schema

```typescript
// packages/agent/src/types.ts
export interface DashAgentConfig {
  model: string
  systemPrompt: string
  tools?: string[]
  workspace?: string
  skills?: {           // NEW
    paths?: string[]   // Local dirs (supports ~/ and relative paths)
    urls?: string[]    // Remote skill registries
  }
}
```

Same shape added to `AgentConfig` in `apps/dash/src/config.ts`.

Example `dash.json`:
```json
{
  "agents": {
    "default": {
      "model": "anthropic/claude-sonnet-4-5",
      "systemPrompt": "You are Dash, a helpful AI assistant.",
      "skills": {
        "paths": ["~/my-skills", "./project-skills"],
        "urls": ["https://example.com/.well-known/skills/"]
      }
    }
  }
}
```

---

## 5. Config Passthrough

```typescript
// packages/agent/src/backends/opencode.ts — updated createOpencodeServer call
const server = await createOpencodeServer({
  config: {
    model: this.config.model,
    ...(this.config.skills && { skills: this.config.skills }),
  },
})
```

OpenCode handles path expansion (`~/`, relative paths resolved against workspace), URL fetching with timeout, deduplication, and error reporting. No translation logic in Dash.

---

## 6. Tool ID Registration

```typescript
// packages/agent/src/config-generator.ts
export const ALL_OPENCODE_TOOLS = [
  'bash', 'edit', 'write', 'read', 'glob', 'grep',
  'ls', 'web_fetch', 'web_search', 'mcp',
  'skill',   // NEW
] as const
```

**Default behavior unchanged:** if `tools` is omitted from `AgentConfig`, all tools including `skill` are enabled (no change from today — OpenCode enables it unconditionally).

**Opt-out is now possible:** an agent can explicitly exclude `skill` by omitting it from its `tools` array. `buildToolsMap` will emit `{ skill: false }` → OpenCode denies the tool.

---

## 7. `skill_loaded` AgentEvent

```typescript
// packages/agent/src/types.ts — new union member
| { type: 'skill_loaded'; name: string }
```

**Implementation in `opencode.ts`:** Track pending skill invocations using the `tool_use_start` event (where `name === 'skill'`), extract the skill name from the tool input JSON, then emit `skill_loaded` when the corresponding `tool_result` arrives.

```typescript
// In run(), alongside existing tool_result handling:
if (normalized?.type === 'tool_use_start' && normalized.name === 'skill') {
  pendingSkillName = parseSkillName(normalized) // from partial_json accumulation
}
if (normalized?.type === 'tool_result' && normalized.name === 'skill') {
  if (pendingSkillName) {
    yield { type: 'skill_loaded', name: pendingSkillName }
    pendingSkillName = null
  }
}
```

`skill_loaded` is emitted **in addition to** `tool_result`, not instead of it — full backward compatibility. Channels that don't care about skills continue working unchanged.

---

## 8. Skill File Format (Reference)

Compatible with Claude Code's SKILL.md format:

```markdown
---
name: brainstorming
description: Use before any creative work — explores intent and design before implementation
---

# Brainstorming Ideas Into Designs

[Full skill content here...]
```

Place skills at:
- `~/.claude/skills/<name>/SKILL.md` — global, available to all agents
- `<workspace>/.claude/skills/<name>/SKILL.md` — project-level, this workspace only
- Or configure explicit paths via `skills.paths` in `dash.json`

---

## 9. Files Changed

### Modified
| File | Change |
|---|---|
| `packages/agent/src/types.ts` | Add `skills` to `DashAgentConfig`; add `skill_loaded` to `AgentEvent` |
| `packages/agent/src/config-generator.ts` | Add `'skill'` to `ALL_OPENCODE_TOOLS` |
| `packages/agent/src/backends/opencode.ts` | Forward `skills` to `createOpencodeServer`; emit `skill_loaded` from `run()` |
| `apps/dash/src/config.ts` | Add `skills` field to `AgentConfig` interface |

### Not changed
- `AgentBackend` interface
- `DashAgent` class
- Gateway, ChatServer, channels
- `SessionIdMap`, `buildToolsMap` function body
