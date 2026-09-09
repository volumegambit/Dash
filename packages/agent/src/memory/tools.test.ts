import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from './store.js';
import { createForgetMemoryTool, createRecallMemoryTool, createSaveMemoryTool } from './tools.js';
import type { MemoryToolDetails } from './tools.js';

/**
 * Every memory tool answers with exactly one text block, but the pi tool-result
 * content type is a text/image union — narrow it once here rather than casting
 * at each assertion. Throwing on anything else is the point: a tool that
 * stopped answering with text should fail this file, not silently pass.
 */
function toolText(result: AgentToolResult<MemoryToolDetails>): string {
  const first = result.content[0];
  if (first === undefined || first.type !== 'text') {
    throw new Error(`expected a text tool result, got ${first?.type ?? 'nothing'}`);
  }
  return first.text;
}

describe('memory tools', () => {
  let dir: string;
  let store: MemoryStore;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dash-memory-tools-'));
    store = new MemoryStore(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('save_memory creates, then updates, and reports the action in details', async () => {
    const save = createSaveMemoryTool(store);
    expect(save.name).toBe('save_memory');
    const created = await save.execute('t1', {
      name: 'user-timezone',
      description: 'Gerry is in Singapore',
      type: 'user',
      content: 'UTC+8',
    });
    expect(toolText(created)).toBe('Saved memory "user-timezone" (created).');
    expect(created.details).toEqual({
      memory: {
        name: 'user-timezone',
        description: 'Gerry is in Singapore',
        memoryType: 'user',
        action: 'created',
      },
    });
    const updated = await save.execute('t2', {
      name: 'user-timezone',
      description: 'Gerry is in Singapore (UTC+8)',
      type: 'user',
      content: 'Singapore, UTC+8',
    });
    expect(updated.details).toMatchObject({ memory: { action: 'updated' } });
    expect((await store.get('user-timezone'))?.source).toBe('agent');
  });

  it('save_memory returns an Error: text result with empty details on invalid input', async () => {
    const save = createSaveMemoryTool(store);
    const r = await save.execute('t', {
      name: 'Bad!',
      description: 'd',
      type: 'user',
      content: 'c',
    });
    expect(toolText(r).startsWith('Error:')).toBe(true);
    expect(r.details).toEqual({});
  });

  it('recall_memory returns the body or a not-found message listing names', async () => {
    await store.save({
      name: 'a',
      description: 'd',
      type: 'project',
      content: 'the body',
      source: 'agent',
    });
    const recall = createRecallMemoryTool(store);
    expect(toolText(await recall.execute('t', { name: 'a' }))).toBe('# a (project)\nd\n\nthe body');
    const missing = await recall.execute('t', { name: 'zzz' });
    expect(toolText(missing)).toBe('Memory "zzz" not found. Known memories: a');
  });

  it('forget_memory deletes and reports, or says not found', async () => {
    await store.save({
      name: 'a',
      description: 'd',
      type: 'project',
      content: 'x',
      source: 'agent',
    });
    const forget = createForgetMemoryTool(store);
    const r = await forget.execute('t', { name: 'a' });
    expect(toolText(r)).toBe('Forgot memory "a".');
    expect(r.details).toEqual({ memory: { name: 'a', action: 'forgotten' } });
    expect(toolText(await forget.execute('t', { name: 'a' }))).toBe('Memory "a" not found.');
  });

  it.each(['user', 'import'] as const)(
    'forget_memory refuses to delete a %s-authored memory',
    async (source) => {
      await store.save({
        name: 'deploy-policy',
        description: 'd',
        type: 'project',
        content: 'x',
        source,
      });
      const forget = createForgetMemoryTool(store);
      const r = await forget.execute('t', { name: 'deploy-policy' });
      expect(toolText(r)).toMatch(/written by the user/i);
      expect(toolText(r)).toMatch(/raise it with them/i);
      expect(r.details).toEqual({});
      expect(await store.get('deploy-policy')).not.toBeNull();
    },
  );

  it('save_memory keeps a user-authored source when the agent updates the entry', async () => {
    await store.save({
      name: 'deploy-policy',
      description: 'd',
      type: 'project',
      content: 'x',
      source: 'user',
    });
    const save = createSaveMemoryTool(store);
    await save.execute('t', {
      name: 'deploy-policy',
      description: 'd2',
      type: 'project',
      content: 'y',
    });
    const after = await store.get('deploy-policy');
    expect(after?.content).toBe('y');
    expect(after?.source).toBe('user');
  });
});
