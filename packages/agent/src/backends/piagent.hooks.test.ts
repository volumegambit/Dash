import { describe, expect, it, vi } from 'vitest';

import type { HookRunner } from '../types.js';
import { composeToolHooks } from './piagent.js';

/**
 * Minimal fake of pi's `Agent` for composition tests: only the two mutable
 * hook fields the backend touches. pi installs its OWN handlers in the
 * AgentSession ctor, so these fakes stand in for "pi's prior handlers".
 */
function makeFakeAgent(prior?: {
  before?: ReturnType<typeof vi.fn>;
  after?: ReturnType<typeof vi.fn>;
}) {
  return {
    beforeToolCall: prior?.before,
    afterToolCall: prior?.after,
  } as {
    // biome-ignore lint/suspicious/noExplicitAny: fake pi Agent hook fields
    beforeToolCall?: (ctx: any, signal?: AbortSignal) => Promise<any>;
    // biome-ignore lint/suspicious/noExplicitAny: fake pi Agent hook fields
    afterToolCall?: (ctx: any, signal?: AbortSignal) => Promise<any>;
  };
}

/** A HookRunner stub whose method results are supplied per-test. */
function makeRunner(overrides: Partial<HookRunner>): HookRunner {
  return {
    runPreToolUse: vi.fn().mockResolvedValue({ block: false }),
    runPostToolUse: vi.fn().mockResolvedValue({ block: false }),
    runSessionStart: vi.fn().mockResolvedValue({}),
    runStop: vi.fn().mockResolvedValue({}),
    hasHooks: true,
    ...overrides,
  } as HookRunner;
}

// A pi BeforeToolCallContext-shaped object. Tool name lives at toolCall.name
// (pi-ai ToolCall.name), NOT toolCall.toolName.
const beforeCtx = (name: string, args: unknown) => ({
  toolCall: { type: 'toolCall', id: 'tc1', name, arguments: args },
  args,
});

const afterCtx = (name: string, args: unknown, result: unknown, isError = false) => ({
  toolCall: { type: 'toolCall', id: 'tc1', name, arguments: args },
  args,
  result,
  isError,
});

describe('composeToolHooks', () => {
  it('runs pre-hook and blocks the tool when runPreToolUse returns block', async () => {
    const agent = makeFakeAgent();
    const runner = makeRunner({
      runPreToolUse: vi.fn().mockResolvedValue({ block: true, reason: 'nope' }),
    });

    composeToolHooks(agent, runner, { sessionId: 's1', cwd: '/w' });

    const res = await agent.beforeToolCall?.(beforeCtx('bash', { cmd: 'rm' }));
    expect(res).toEqual({ block: true, reason: 'nope' });
    expect(runner.runPreToolUse).toHaveBeenCalledWith({
      toolName: 'bash',
      toolInput: { cmd: 'rm' },
      sessionId: 's1',
      cwd: '/w',
    });
  });

  it('allows the tool when runPreToolUse does not block (returns pi prior result)', async () => {
    const prior = vi.fn().mockResolvedValue(undefined);
    const agent = makeFakeAgent({ before: prior });
    const runner = makeRunner({ runPreToolUse: vi.fn().mockResolvedValue({ block: false }) });

    composeToolHooks(agent, runner, {});

    const res = await agent.beforeToolCall?.(beforeCtx('read', { path: 'x' }));
    expect(prior).toHaveBeenCalled();
    expect(res).toBeUndefined();
  });

  it("preserves pi's prior beforeToolCall — a prior block wins and skips the plugin hook", async () => {
    const prior = vi.fn().mockResolvedValue({ block: true, reason: 'pi-said-no' });
    const agent = makeFakeAgent({ before: prior });
    const runPreToolUse = vi.fn().mockResolvedValue({ block: false });
    const runner = makeRunner({ runPreToolUse });

    composeToolHooks(agent, runner, {});

    const res = await agent.beforeToolCall?.(beforeCtx('bash', {}));
    expect(res).toEqual({ block: true, reason: 'pi-said-no' });
    // Plugin pre-hook must NOT run when pi's prior handler already blocked.
    expect(runPreToolUse).not.toHaveBeenCalled();
  });

  it('appends post-hook additionalContext to the tool result content', async () => {
    const prior = vi.fn().mockResolvedValue(undefined);
    const agent = makeFakeAgent({ after: prior });
    const runner = makeRunner({
      runPostToolUse: vi.fn().mockResolvedValue({ block: false, additionalContext: 'extra note' }),
    });

    composeToolHooks(agent, runner, {});

    const result = { content: [{ type: 'text', text: 'original' }], details: {} };
    const res = await agent.afterToolCall?.(afterCtx('read', {}, result));

    expect(res?.content).toEqual([
      { type: 'text', text: 'original' },
      { type: 'text', text: 'extra note' },
    ]);
    expect(runner.runPostToolUse).toHaveBeenCalledWith({
      toolName: 'read',
      toolInput: {},
      toolResponse: expect.any(String),
      sessionId: undefined,
      cwd: undefined,
    });
  });

  it('marks the result as an error when post-hook blocks', async () => {
    const agent = makeFakeAgent();
    const runner = makeRunner({
      runPostToolUse: vi.fn().mockResolvedValue({ block: true, reason: 'post-deny' }),
    });

    composeToolHooks(agent, runner, {});

    const result = { content: [{ type: 'text', text: 'ok' }], details: {} };
    const res = await agent.afterToolCall?.(afterCtx('write', {}, result));

    expect(res?.isError).toBe(true);
    // The block reason is surfaced in the content.
    const text = (res?.content ?? []).map((c: { text?: string }) => c.text).join('\n');
    expect(text).toContain('post-deny');
  });

  it("merges plugin post-hook on top of pi's prior afterToolCall override", async () => {
    // pi's prior handler replaces content; the plugin hook then appends to it.
    const prior = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'pi-override' }] });
    const agent = makeFakeAgent({ after: prior });
    const runner = makeRunner({
      runPostToolUse: vi.fn().mockResolvedValue({ block: false, additionalContext: 'plugin-add' }),
    });

    composeToolHooks(agent, runner, {});

    const result = { content: [{ type: 'text', text: 'original' }], details: {} };
    const res = await agent.afterToolCall?.(afterCtx('grep', {}, result));

    expect(prior).toHaveBeenCalled();
    expect(res?.content).toEqual([
      { type: 'text', text: 'pi-override' },
      { type: 'text', text: 'plugin-add' },
    ]);
  });
});
