# Skills System Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Integrate OpenCode's built-in skill system into Dash with config passthrough, explicit tool control, and a typed `skill_loaded` event.

**Architecture:** OpenCode already discovers and loads `SKILL.md` skills from `~/.claude/skills/` and `<workspace>/.claude/skills/` — identical to Claude Code's format. Dash adds (1) a `skills` config field passed through to OpenCode, (2) `skill` in the known tools list so it can be denied per-agent, and (3) a `skill_loaded` AgentEvent emitted alongside `tool_result` when the agent invokes a skill.

**Tech Stack:** TypeScript, Vitest, OpenCode SDK (`@opencode-ai/sdk`), Zod (OpenCode config schema)

---

## Task 1: Add `skill` to known tools list

**Files:**
- Modify: `packages/agent/src/config-generator.ts`
- Modify: `packages/agent/src/config-generator.test.ts`

**Step 1: Write the failing tests**

In `config-generator.test.ts`, update the two tests that assert 10 tools, and add one that checks `skill` is included:

```typescript
it('enables all tools when undefined passed', () => {
  const map = buildToolsMap(undefined);
  for (const tool of ALL_OPENCODE_TOOLS) {
    expect(map[tool]).toBe(true);
  }
  expect(Object.keys(map)).toHaveLength(11); // was 10
});

it('always includes all 11 tool keys regardless of input', () => {
  const map = buildToolsMap(['bash']);
  expect(Object.keys(map)).toHaveLength(11); // was 10
});

it('includes skill in the tools map', () => {
  const map = buildToolsMap(undefined);
  expect(map.skill).toBe(true);
});

it('can disable skill by omitting it from the list', () => {
  const map = buildToolsMap(['bash', 'read']);
  expect(map.skill).toBe(false);
});
```

**Step 2: Run tests to verify they fail**

```bash
npx vitest run packages/agent/src/config-generator.test.ts
```

Expected: FAIL — `toHaveLength(11)` fails (actual 10), `map.skill` is undefined.

**Step 3: Add `skill` to `ALL_OPENCODE_TOOLS`**

In `packages/agent/src/config-generator.ts`, add `'skill'` to the array:

```typescript
export const ALL_OPENCODE_TOOLS = [
  'bash',
  'edit',
  'write',
  'read',
  'glob',
  'grep',
  'ls',
  'web_fetch',
  'web_search',
  'mcp',
  'skill',
] as const
```

**Step 4: Run tests to verify they pass**

```bash
npx vitest run packages/agent/src/config-generator.test.ts
```

Expected: PASS — all 4 tests green.

**Step 5: Commit**

```bash
git add packages/agent/src/config-generator.ts packages/agent/src/config-generator.test.ts
git commit -m "feat(agent): add skill to known OpenCode tools list"
```

---

## Task 2: Add `skills` field to config types

**Files:**
- Modify: `packages/agent/src/types.ts`
- Modify: `apps/dash/src/config.ts`

No runtime logic — type-only changes. TypeScript compilation is the test.

**Step 1: Add `skills` to `DashAgentConfig` in `packages/agent/src/types.ts`**

Add after the `workspace` field:

```typescript
export interface DashAgentConfig {
  model: string; // "provider/model-id", e.g. "anthropic/claude-opus-4-5"
  systemPrompt: string;
  tools?: string[]; // OpenCode tool names
  workspace?: string;
  skills?: {
    paths?: string[]; // Local dirs to scan (supports ~/ and relative paths)
    urls?: string[];  // Remote skill registries to fetch from
  };
}
```

**Step 2: Add `skills` to `AgentConfig` in `apps/dash/src/config.ts`**

`AgentConfig` is the JSON-facing type (dash.json). Add `skills` after `workspace`:

```typescript
export interface AgentConfig {
  model: string; // "provider/model-id", e.g. "anthropic/claude-sonnet-4-5"
  systemPrompt: string;
  tools?: string[];
  workspace?: string;
  skills?: {
    paths?: string[];
    urls?: string[];
  };
}
```

**Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit -p packages/agent/tsconfig.json
npx tsc --noEmit -p apps/dash/tsconfig.json
```

Expected: no errors.

**Step 4: Commit**

```bash
git add packages/agent/src/types.ts apps/dash/src/config.ts
git commit -m "feat(agent): add skills field to DashAgentConfig and AgentConfig"
```

---

## Task 3: Add `skill_loaded` to AgentEvent

**Files:**
- Modify: `packages/agent/src/types.ts`

**Step 1: Add `skill_loaded` to the `AgentEvent` union in `packages/agent/src/types.ts`**

Add as the last member of the union:

```typescript
export type AgentEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_delta'; partial_json: string }
  | { type: 'tool_result'; id: string; name: string; content: string; isError?: boolean }
  | {
      type: 'response';
      content: string;
      usage: {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
      };
    }
  | { type: 'error'; error: Error }
  | { type: 'file_changed'; files: string[] }
  | { type: 'agent_spawned'; name: string }
  | { type: 'agent_retry'; attempt: number; reason: string }
  | { type: 'context_compacted'; overflow: boolean }
  | { type: 'question'; id: string; question: string; options: string[] }
  | { type: 'skill_loaded'; name: string };
```

**Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit -p packages/agent/tsconfig.json
```

Expected: no errors.

**Step 3: Commit**

```bash
git add packages/agent/src/types.ts
git commit -m "feat(agent): add skill_loaded to AgentEvent union"
```

---

## Task 4: Forward `skills` config to OpenCode and emit `skill_loaded`

**Files:**
- Modify: `packages/agent/src/backends/opencode.ts`

This task has two parts: (a) pass `skills` to `createOpencodeServer`, and (b) emit `skill_loaded` when the agent invokes a skill. We extract the skill-name detection into a pure helper so it can be tested without mocking the OpenCode SDK.

**Step 1: Write a failing test for `extractSkillName`**

Create `packages/agent/src/backends/opencode.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { extractSkillName } from './opencode.js';

describe('extractSkillName', () => {
  it('returns skill name from a completed skill tool event', () => {
    const event = {
      type: 'message.part.updated',
      properties: {
        part: {
          type: 'tool',
          tool: 'skill',
          callID: 'call-1',
          state: {
            status: 'completed',
            input: { name: 'brainstorming' },
            output: '<skill_content name="brainstorming">...</skill_content>',
          },
        },
      },
    };
    expect(extractSkillName(event)).toBe('brainstorming');
  });

  it('returns null for non-skill tools', () => {
    const event = {
      type: 'message.part.updated',
      properties: {
        part: {
          type: 'tool',
          tool: 'bash',
          callID: 'call-2',
          state: { status: 'completed', input: { command: 'ls' }, output: 'file.ts' },
        },
      },
    };
    expect(extractSkillName(event)).toBeNull();
  });

  it('returns null when status is not completed', () => {
    const event = {
      type: 'message.part.updated',
      properties: {
        part: {
          type: 'tool',
          tool: 'skill',
          callID: 'call-3',
          state: { status: 'running', input: { name: 'debugging' } },
        },
      },
    };
    expect(extractSkillName(event)).toBeNull();
  });

  it('returns null when input has no name', () => {
    const event = {
      type: 'message.part.updated',
      properties: {
        part: {
          type: 'tool',
          tool: 'skill',
          callID: 'call-4',
          state: { status: 'completed', input: {}, output: '' },
        },
      },
    };
    expect(extractSkillName(event)).toBeNull();
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npx vitest run packages/agent/src/backends/opencode.test.ts
```

Expected: FAIL — `extractSkillName` not exported.

**Step 3: Implement `extractSkillName` and wire up all changes in `opencode.ts`**

Three changes in `packages/agent/src/backends/opencode.ts`:

**3a — Export `extractSkillName` pure helper** (add near the top of the file, before the class):

```typescript
/** Extracts the skill name from a completed skill tool event. Returns null for all other events. */
export function extractSkillName(event: { type: string; properties: unknown }): string | null {
  // biome-ignore lint/suspicious/noExplicitAny: dynamic event shape
  const part = (event.properties as any)?.part;
  if (part?.type !== 'tool' || part.tool !== 'skill') return null;
  if (part.state?.status !== 'completed') return null;
  return part.state?.input?.name ?? null;
}
```

**3b — Forward `skills` to `createOpencodeServer`** (update the `start()` method):

```typescript
async start(workspace: string): Promise<void> {
  const server = await createOpencodeServer({
    config: {
      model: this.config.model,
      ...(this.config.skills && { skills: this.config.skills }),
    },
  });
  // ... rest of start() unchanged
```

**3c — Emit `skill_loaded` in `run()`** (after the existing `normalizeEvent` call, before `yield normalized`):

```typescript
const normalized = this.normalizeEvent(event, sessionId);
if (normalized !== null) {
  yield normalized;
  // Emit skill_loaded alongside tool_result for skill invocations
  if (normalized.type === 'tool_result' && normalized.name === 'skill') {
    const skillName = extractSkillName(event);
    if (skillName) {
      yield { type: 'skill_loaded', name: skillName };
    }
  }
}
```

**Step 4: Run the tests to verify they pass**

```bash
npx vitest run packages/agent/src/backends/opencode.test.ts
```

Expected: PASS — all 4 tests green.

**Step 5: Run the full test suite**

```bash
npx vitest run
```

Expected: all existing tests still pass.

**Step 6: Commit**

```bash
git add packages/agent/src/backends/opencode.ts packages/agent/src/backends/opencode.test.ts
git commit -m "feat(agent): forward skills config to OpenCode and emit skill_loaded event"
```

---

## Task 5: Final verification

**Step 1: TypeScript check across all packages**

```bash
npx tsc --noEmit -p packages/agent/tsconfig.json
npx tsc --noEmit -p apps/dash/tsconfig.json
```

Expected: no errors.

**Step 2: Full test suite**

```bash
npx vitest run
```

Expected: all tests pass.

**Step 3: Commit if clean**

If both pass with no changes needed:

```bash
git status
# should be clean
```

If any fixups were needed, stage and commit them:

```bash
git add <changed files>
git commit -m "fix(agent): address type errors in skills integration"
```

---

## Skill file format reference (for testing manually)

To verify end-to-end manually, create a test skill:

```bash
mkdir -p ~/.claude/skills/test-skill
cat > ~/.claude/skills/test-skill/SKILL.md << 'EOF'
---
name: test-skill
description: A test skill to verify the skills system works
---

# Test Skill

This skill is loaded for testing purposes.
EOF
```

Then run a Dash agent — the `skill` tool description should list `test-skill` in `<available_skills>`, and if the agent calls `skill(test-skill)`, a `skill_loaded` event should appear in the event stream alongside the `tool_result`.
