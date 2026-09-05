import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from './store.js';
import { createForgetMemoryTool, createRecallMemoryTool, createSaveMemoryTool } from './tools.js';

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
    expect(created.content[0].text).toBe('Saved memory "user-timezone" (created).');
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
    expect(r.content[0].text.startsWith('Error:')).toBe(true);
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
    expect((await recall.execute('t', { name: 'a' })).content[0].text).toBe(
      '# a (project)\nd\n\nthe body',
    );
    const missing = await recall.execute('t', { name: 'zzz' });
    expect(missing.content[0].text).toBe('Memory "zzz" not found. Known memories: a');
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
    expect(r.content[0].text).toBe('Forgot memory "a".');
    expect(r.details).toEqual({ memory: { name: 'a', action: 'forgotten' } });
    expect((await forget.execute('t', { name: 'a' })).content[0].text).toBe(
      'Memory "a" not found.',
    );
  });
});
