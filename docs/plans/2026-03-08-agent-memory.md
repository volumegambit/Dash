# Agent Memory System Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give every agent persistent cross-conversation memory via `MEMORY.md` and automatic context compaction when conversations grow long.

**Architecture:** Two subsystems hang off `DashAgent.chat()` before the backend runs: (1) a memory preamble builder that reads `MEMORY.md` from the agent's workspace and prepends it to the system prompt, and (2) a compaction check that replaces old messages with an LLM-generated summary when the estimated token count exceeds 80% of the model's context window. The agent writes memories using its existing `write_file` tool — no new tools needed.

**Tech Stack:** Node.js `fs/promises`, existing `LlmProvider.stream()` interface for compaction LLM call, Vitest for tests.

---

### Task 1: Add `workspace` and `provider` to `DashAgentConfig`

**Files:**
- Modify: `packages/agent/src/types.ts`
- Modify: `apps/dash/src/agent-server.ts`

**Step 1: Add the two fields to `DashAgentConfig`**

In `packages/agent/src/types.ts`, add `LlmProvider` to the import and add two fields to `DashAgentConfig`:

```ts
import type { CompletionResponse, ContentBlock, LlmProvider, Message, ToolDefinition } from '@dash/llm';
```

```ts
export interface DashAgentConfig {
  model: string;
  systemPrompt: string;
  tools?: Tool[];
  maxTokens?: number;
  thinking?: { budgetTokens: number };
  workspace?: string;
  provider?: LlmProvider;
}
```

**Step 2: Pass `workspace` and `provider` in `agent-server.ts`**

In `apps/dash/src/agent-server.ts`, update the `new DashAgent(...)` call (around line 61):

```ts
const agent = new DashAgent(backend, sessionStore, {
  model: agentConfig.model,
  systemPrompt: agentConfig.systemPrompt,
  tools,
  maxTokens: agentConfig.maxTokens,
  thinking: agentConfig.thinking,
  workspace,
  provider,
});
```

**Step 3: Verify TypeScript compiles**

```bash
npm run build -w packages/agent
```
Expected: build succeeds.

**Step 4: Commit**

```bash
git add packages/agent/src/types.ts apps/dash/src/agent-server.ts
git commit -m "feat(agent): add workspace and provider to DashAgentConfig"
```

---

### Task 2: Implement `memory.ts`

**Files:**
- Create: `packages/agent/src/memory.ts`
- Create: `packages/agent/src/memory.test.ts`

**Step 1: Write the failing tests**

Create `packages/agent/src/memory.test.ts`:

```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildMemoryPreamble } from './memory.js';

describe('buildMemoryPreamble', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dash-memory-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true });
  });

  it('returns "not yet created" preamble when MEMORY.md does not exist', async () => {
    const preamble = await buildMemoryPreamble(dir);
    expect(preamble).toContain('not yet created');
    expect(preamble).toContain('MEMORY.md');
  });

  it('returns preamble with memory contents when MEMORY.md exists', async () => {
    await writeFile(join(dir, 'MEMORY.md'), '# Memory\n- User name: Gerry');
    const preamble = await buildMemoryPreamble(dir);
    expect(preamble).toContain('Current memory:');
    expect(preamble).toContain('User name: Gerry');
    expect(preamble).toContain('MEMORY.md');
  });

  it('returns "not yet created" preamble when MEMORY.md is empty', async () => {
    await writeFile(join(dir, 'MEMORY.md'), '   ');
    const preamble = await buildMemoryPreamble(dir);
    expect(preamble).toContain('not yet created');
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npx vitest run packages/agent/src/memory.test.ts
```
Expected: FAIL with "Cannot find module './memory.js'"

**Step 3: Implement `memory.ts`**

Create `packages/agent/src/memory.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function buildMemoryPreamble(workspace: string): Promise<string> {
  const memoryPath = join(workspace, 'MEMORY.md');
  let contents: string | null = null;

  try {
    contents = await readFile(memoryPath, 'utf-8');
  } catch {
    // File does not exist yet
  }

  if (contents && contents.trim()) {
    return `You have a persistent memory file at ${memoryPath}.

At the start of each conversation, read it to recall important context.
Proactively update it when you learn something worth remembering — user
preferences, project details, recurring tasks, important facts. Use
write_file to save memories. Keep entries concise and dated (YYYY-MM-DD).

Current memory:
---
${contents.trim()}
---`;
  }

  return `You have a persistent memory file at ${memoryPath} (not yet created).
Create it with write_file when you learn something worth remembering.`;
}
```

**Step 4: Run tests to verify they pass**

```bash
npx vitest run packages/agent/src/memory.test.ts
```
Expected: 3 tests pass.

**Step 5: Commit**

```bash
git add packages/agent/src/memory.ts packages/agent/src/memory.test.ts
git commit -m "feat(agent): add memory preamble builder"
```

---

### Task 3: Add `compaction` session entry type and update session loader

**Files:**
- Modify: `packages/agent/src/types.ts`
- Modify: `packages/agent/src/session.ts`
- Modify: `packages/agent/src/session.test.ts`

**Step 1: Add `compaction` to the `SessionEntry` type**

In `packages/agent/src/types.ts`, update the union:

```ts
export interface SessionEntry {
  timestamp: string;
  type: 'message' | 'response' | 'tool_call' | 'tool_result' | 'error' | 'compaction';
  data: Record<string, unknown>;
}
```

**Step 2: Write the failing test**

Add to `packages/agent/src/session.test.ts`:

```ts
it('loads session from compaction checkpoint — discards messages before it', async () => {
  const sessionId = 'ch:conv-compact';

  // Old messages before compaction
  await store.append(sessionId, {
    timestamp: '2026-01-01T00:00:00Z',
    type: 'message',
    data: { role: 'user', content: 'old message' },
  });

  // Compaction entry
  await store.append(sessionId, {
    timestamp: '2026-01-01T00:01:00Z',
    type: 'compaction',
    data: { summary: '## Goal\nHelping user with tasks', messageCount: 1 },
  });

  // New messages after compaction
  await store.append(sessionId, {
    timestamp: '2026-01-01T00:02:00Z',
    type: 'message',
    data: { role: 'user', content: 'new message' },
  });

  const session = await store.load('ch', 'conv-compact');
  expect(session).not.toBeNull();
  // old message discarded, compaction summary + new message
  expect(session?.messages).toHaveLength(2);
  expect(session?.messages[0]).toEqual({
    role: 'assistant',
    content: '## Goal\nHelping user with tasks',
  });
  expect(session?.messages[1]).toEqual({ role: 'user', content: 'new message' });
});
```

**Step 3: Run test to verify it fails**

```bash
npx vitest run packages/agent/src/session.test.ts
```
Expected: new test fails, existing 3 tests still pass.

**Step 4: Update `JsonlSessionStore.load()` to handle compaction**

Replace the `load()` method body in `packages/agent/src/session.ts`:

```ts
async load(channelId: string, conversationId: string): Promise<Session | null> {
  const file = this.sessionFile(channelId, conversationId);
  if (!existsSync(file)) return null;

  const content = await readFile(file, 'utf-8');
  const lines = content.trim().split('\n').filter(Boolean);

  const session: Session = {
    id: `${channelId}:${conversationId}`,
    channelId,
    conversationId,
    createdAt: new Date().toISOString(),
    messages: [],
  };

  // Find last compaction checkpoint — only replay from there
  let startIndex = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const entry = JSON.parse(lines[i]) as SessionEntry;
    if (entry.type === 'compaction') {
      startIndex = i;
      break;
    }
  }

  for (const line of lines.slice(startIndex)) {
    const entry: SessionEntry = JSON.parse(line);
    if (entry.type === 'compaction') {
      session.messages.push({ role: 'assistant', content: entry.data.summary as string });
    } else if (entry.type === 'message') {
      session.messages.push({
        role: entry.data.role as 'user' | 'assistant',
        content: entry.data.content as string,
      });
      if (!session.createdAt || entry.timestamp < session.createdAt) {
        session.createdAt = entry.timestamp;
      }
    } else if (entry.type === 'response') {
      const content = entry.data.content;
      session.messages.push({
        role: 'assistant',
        content: content as string | ContentBlock[],
      });
    } else if (entry.type === 'tool_result') {
      const content = entry.data.content;
      session.messages.push({
        role: 'user',
        content: content as ContentBlock[],
      });
    }
  }

  return session;
}
```

**Step 5: Run all session tests**

```bash
npx vitest run packages/agent/src/session.test.ts
```
Expected: all 4 tests pass.

**Step 6: Commit**

```bash
git add packages/agent/src/types.ts packages/agent/src/session.ts packages/agent/src/session.test.ts
git commit -m "feat(agent): add compaction session entry type and checkpoint loading"
```

---

### Task 4: Implement `compaction.ts`

**Files:**
- Create: `packages/agent/src/compaction.ts`
- Create: `packages/agent/src/compaction.test.ts`

**Step 1: Write the failing tests**

Create `packages/agent/src/compaction.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { LlmProvider, StreamChunk } from '@dash/llm';
import { estimateTokens, shouldCompact, compactSession } from './compaction.js';
import { JsonlSessionStore } from './session.js';
import type { Session } from './types.js';

const mockProvider: LlmProvider = {
  name: 'mock',
  complete: async () => ({
    content: 'summary text',
    usage: { inputTokens: 10, outputTokens: 10 },
    stopReason: 'end_turn' as const,
  }),
  async *stream() {
    yield { type: 'text_delta', text: '## Goal\nTest goal' } as StreamChunk;
    return {
      content: '## Goal\nTest goal',
      usage: { inputTokens: 10, outputTokens: 10 },
      stopReason: 'end_turn' as const,
    };
  },
};

describe('estimateTokens', () => {
  it('returns 0 for empty messages', () => {
    expect(estimateTokens([])).toBe(0);
  });

  it('estimates tokens from string content', () => {
    const messages = [{ role: 'user' as const, content: 'hello' }]; // 5 chars → ceil(5/4) = 2
    expect(estimateTokens(messages)).toBe(2);
  });

  it('estimates tokens from ContentBlock[] content', () => {
    const messages = [
      { role: 'assistant' as const, content: [{ type: 'text', text: 'hi' }] },
    ];
    expect(estimateTokens(messages)).toBeGreaterThan(0);
  });
});

describe('shouldCompact', () => {
  it('returns false for short sessions', () => {
    const messages = [{ role: 'user' as const, content: 'hi' }];
    expect(shouldCompact(messages, 'claude-sonnet-4-6')).toBe(false);
  });

  it('returns true when estimated tokens exceed 80% of context window', () => {
    // 100k default window * 0.8 = 80k tokens = ~320k chars
    const bigContent = 'a'.repeat(320_001);
    const messages = [{ role: 'user' as const, content: bigContent }];
    expect(shouldCompact(messages, 'unknown-model')).toBe(true);
  });
});

describe('compactSession', () => {
  let dir: string;
  let store: JsonlSessionStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dash-compact-test-'));
    store = new JsonlSessionStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true });
  });

  it('replaces session messages with a single summary message', async () => {
    const session: Session = {
      id: 'ch:conv1',
      channelId: 'ch',
      conversationId: 'conv1',
      createdAt: new Date().toISOString(),
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ],
    };

    await compactSession(session, 'claude-sonnet-4-6', mockProvider, store);

    expect(session.messages).toHaveLength(1);
    expect(session.messages[0].role).toBe('assistant');
    expect(session.messages[0].content).toContain('## Goal');
  });

  it('writes a compaction entry to the session store', async () => {
    const session: Session = {
      id: 'ch:conv2',
      channelId: 'ch',
      conversationId: 'conv2',
      createdAt: new Date().toISOString(),
      messages: [{ role: 'user', content: 'hello' }],
    };

    await compactSession(session, 'claude-sonnet-4-6', mockProvider, store);

    // Reload from store — should see compaction checkpoint
    const loaded = await store.load('ch', 'conv2');
    expect(loaded?.messages).toHaveLength(1);
    expect(loaded?.messages[0].role).toBe('assistant');
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npx vitest run packages/agent/src/compaction.test.ts
```
Expected: FAIL with "Cannot find module './compaction.js'"

**Step 3: Implement `compaction.ts`**

Create `packages/agent/src/compaction.ts`:

```ts
import type { LlmProvider } from '@dash/llm';
import type { Message, Session, SessionStore } from './types.js';

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'claude-opus-4-6': 200_000,
  'claude-sonnet-4-6': 200_000,
  'claude-haiku-4-5-20251001': 200_000,
  'claude-sonnet-4-20250514': 200_000,
  'claude-opus-4-20250514': 200_000,
  'claude-haiku-3-5-20241022': 200_000,
};
const DEFAULT_CONTEXT_WINDOW = 100_000;
const COMPACTION_THRESHOLD = 0.8;

const COMPACTION_SYSTEM_PROMPT = `Summarize the following conversation into a structured handoff document.
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
What needs to happen next (if known).`;

export function estimateTokens(messages: Message[]): number {
  let totalChars = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      totalChars += msg.content.length;
    } else {
      totalChars += JSON.stringify(msg.content).length;
    }
  }
  return Math.ceil(totalChars / 4);
}

export function shouldCompact(messages: Message[], model: string): boolean {
  const contextWindow = MODEL_CONTEXT_WINDOWS[model] ?? DEFAULT_CONTEXT_WINDOW;
  const threshold = Math.floor(contextWindow * COMPACTION_THRESHOLD);
  return estimateTokens(messages) > threshold;
}

export async function compactSession(
  session: Session,
  model: string,
  provider: LlmProvider,
  sessionStore: SessionStore,
): Promise<void> {
  let summary = '';
  try {
    for await (const chunk of provider.stream({
      model,
      systemPrompt: COMPACTION_SYSTEM_PROMPT,
      messages: session.messages,
      maxTokens: 4096,
    })) {
      if (chunk.type === 'text_delta') {
        summary += chunk.text;
      }
    }
  } catch (err) {
    console.warn('[compaction] LLM call failed, skipping:', err);
    return;
  }

  await sessionStore.append(session.id, {
    timestamp: new Date().toISOString(),
    type: 'compaction',
    data: { summary, messageCount: session.messages.length },
  });

  session.messages = [{ role: 'assistant', content: summary }];
}
```

**Step 4: Run tests to verify they pass**

```bash
npx vitest run packages/agent/src/compaction.test.ts
```
Expected: all 5 tests pass.

**Step 5: Commit**

```bash
git add packages/agent/src/compaction.ts packages/agent/src/compaction.test.ts
git commit -m "feat(agent): implement session compaction"
```

---

### Task 5: Wire memory and compaction into `DashAgent.chat()`

**Files:**
- Modify: `packages/agent/src/agent.ts`

**Step 1: Update `agent.ts`**

Replace the full contents of `packages/agent/src/agent.ts`:

```ts
import type {
  AgentBackend,
  AgentEvent,
  AgentState,
  DashAgentConfig,
  RunOptions,
  Session,
  SessionStore,
} from './types.js';
import { buildMemoryPreamble } from './memory.js';
import { shouldCompact, compactSession } from './compaction.js';

export class DashAgent {
  constructor(
    private backend: AgentBackend,
    private sessionStore: SessionStore,
    private config: DashAgentConfig,
  ) {}

  async getOrCreateSession(channelId: string, conversationId: string): Promise<Session> {
    const existing = await this.sessionStore.load(channelId, conversationId);
    if (existing) return existing;

    return {
      id: `${channelId}:${conversationId}`,
      channelId,
      conversationId,
      createdAt: new Date().toISOString(),
      messages: [],
    };
  }

  async *chat(
    channelId: string,
    conversationId: string,
    userMessage: string,
    options: RunOptions = {},
  ): AsyncGenerator<AgentEvent> {
    const session = await this.getOrCreateSession(channelId, conversationId);

    // Build system prompt — prepend memory preamble if workspace is configured
    let systemPrompt = this.config.systemPrompt;
    if (this.config.workspace) {
      const preamble = await buildMemoryPreamble(this.config.workspace);
      systemPrompt = `${preamble}\n\n${systemPrompt}`;
    }

    // Compact old messages before adding the new user message
    if (
      session.messages.length > 0 &&
      this.config.provider &&
      shouldCompact(session.messages, this.config.model)
    ) {
      await compactSession(session, this.config.model, this.config.provider, this.sessionStore);
    }

    // Append user message
    session.messages.push({ role: 'user', content: userMessage });
    await this.sessionStore.append(session.id, {
      timestamp: new Date().toISOString(),
      type: 'message',
      data: { role: 'user', content: userMessage },
    });

    const state: AgentState = {
      session,
      model: this.config.model,
      systemPrompt,
      tools: this.config.tools,
      maxTokens: this.config.maxTokens,
      thinking: this.config.thinking,
    };

    const messageCountBefore = session.messages.length;

    for await (const event of this.backend.run(state, options)) {
      yield event;
    }

    // Persist all new messages added by the backend (assistant responses, tool results)
    const newMessages = session.messages.slice(messageCountBefore);
    for (const msg of newMessages) {
      if (msg.role === 'assistant') {
        await this.sessionStore.append(session.id, {
          timestamp: new Date().toISOString(),
          type: 'response',
          data: { content: msg.content },
        });
      } else if (msg.role === 'user' && Array.isArray(msg.content)) {
        await this.sessionStore.append(session.id, {
          timestamp: new Date().toISOString(),
          type: 'tool_result',
          data: { content: msg.content },
        });
      }
    }
  }
}
```

**Step 2: Build and run all agent tests**

```bash
npm run build -w packages/agent && npx vitest run packages/agent
```
Expected: all tests pass, build succeeds.

**Step 3: Commit**

```bash
git add packages/agent/src/agent.ts
git commit -m "feat(agent): wire memory preamble and compaction into DashAgent.chat()"
```

---

### Task 6: Full test suite and verification

**Step 1: Run the full test suite**

```bash
npm test
```
Expected: all tests pass.

**Step 2: Run lint and typecheck**

```bash
npm run lint
```
Expected: no errors.

**Step 3: Build all packages**

```bash
npm run build
```
Expected: all packages build successfully.

**Step 4: Smoke test**

Start an agent and verify memory preamble appears:

```bash
# Start the agent server in one terminal
npm run mc:dev

# In MC, deploy a new agent and start a chat
# Tell the agent: "My name is Gerry, please remember this"
# Expected: agent writes to MEMORY.md in its workspace
# Then: start a new conversation and ask "what is my name?"
# Expected: agent recalls "Gerry" from MEMORY.md
```

**Step 5: Verify MEMORY.md was created**

```bash
ls ~/.mission-control/workspaces/<agent-name>-<id>/MEMORY.md
cat ~/.mission-control/workspaces/<agent-name>-<id>/MEMORY.md
```

**Step 6: Commit if any lint fixes were needed**

```bash
git add -p
git commit -m "chore: lint fixes for agent memory feature"
```
