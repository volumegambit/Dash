import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConversationStore } from './conversations.js';

describe('ConversationStore', () => {
  let dataDir: string;
  let store: ConversationStore;

  beforeEach(async () => {
    dataDir = join(tmpdir(), `conv-test-${Date.now()}`);
    await mkdir(dataDir, { recursive: true });
    store = new ConversationStore(dataDir);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('creates a conversation with auto-generated id', async () => {
    const conv = await store.create('deploy-1', 'myagent');
    expect(conv.id).toBeTruthy();
    expect(conv.deploymentId).toBe('deploy-1');
    expect(conv.agentName).toBe('myagent');
    expect(conv.title).toBe('New conversation');
  });

  it('lists conversations filtered by deploymentId', async () => {
    await store.create('deploy-1', 'agent-a');
    await store.create('deploy-1', 'agent-b');
    await store.create('deploy-2', 'agent-a');

    const list = await store.list('deploy-1');
    expect(list).toHaveLength(2);
    expect(list.every((c) => c.deploymentId === 'deploy-1')).toBe(true);
  });

  it('returns empty array when no conversations exist', async () => {
    expect(await store.list('deploy-1')).toEqual([]);
  });

  it('gets a conversation by id', async () => {
    const conv = await store.create('deploy-1', 'agent');
    const found = await store.get(conv.id);
    expect(found?.id).toBe(conv.id);
  });

  it('returns null for unknown id', async () => {
    expect(await store.get('nonexistent')).toBeNull();
  });

  it('deletes a conversation and its messages', async () => {
    const conv = await store.create('deploy-1', 'agent');
    await store.appendMessage(conv.id, {
      id: 'msg-1',
      role: 'user',
      content: { type: 'user', text: 'hello' },
      timestamp: new Date().toISOString(),
    });

    await store.delete(conv.id);
    expect(await store.list('deploy-1')).toHaveLength(0);
    expect(await store.getMessages(conv.id)).toEqual([]);
  });

  it('appends messages and retrieves them in order', async () => {
    const conv = await store.create('deploy-1', 'agent');
    await store.appendMessage(conv.id, {
      id: 'msg-1',
      role: 'user',
      content: { type: 'user', text: 'hello' },
      timestamp: new Date().toISOString(),
    });
    await store.appendMessage(conv.id, {
      id: 'msg-2',
      role: 'assistant',
      content: { type: 'assistant', events: [{ type: 'text_delta', text: 'Hi' }] },
      timestamp: new Date().toISOString(),
    });

    const msgs = await store.getMessages(conv.id);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].id).toBe('msg-1');
    expect(msgs[1].id).toBe('msg-2');
  });

  it('sets title from first user message', async () => {
    const conv = await store.create('deploy-1', 'agent');
    await store.appendMessage(conv.id, {
      id: 'msg-1',
      role: 'user',
      content: { type: 'user', text: 'What is the weather today?' },
      timestamp: new Date().toISOString(),
    });

    const updated = await store.get(conv.id);
    expect(updated?.title).toBe('What is the weather today?');
  });

  it('truncates long titles to 60 chars', async () => {
    const conv = await store.create('deploy-1', 'agent');
    const longText = 'a'.repeat(100);
    await store.appendMessage(conv.id, {
      id: 'msg-1',
      role: 'user',
      content: { type: 'user', text: longText },
      timestamp: new Date().toISOString(),
    });

    const updated = await store.get(conv.id);
    expect(updated?.title).toHaveLength(60);
  });

  it('returns empty array from getMessages when no messages file exists', async () => {
    const conv = await store.create('deploy-1', 'agent');
    // No messages appended — JSONL file does not exist yet
    expect(await store.getMessages(conv.id)).toEqual([]);
  });

  it('does not overwrite title after it has been set', async () => {
    const conv = await store.create('deploy-1', 'agent');
    await store.appendMessage(conv.id, {
      id: 'msg-1',
      role: 'user',
      content: { type: 'user', text: 'First message sets the title' },
      timestamp: new Date().toISOString(),
    });
    await store.appendMessage(conv.id, {
      id: 'msg-2',
      role: 'user',
      content: { type: 'user', text: 'Second message should not change title' },
      timestamp: new Date().toISOString(),
    });

    const updated = await store.get(conv.id);
    expect(updated?.title).toBe('First message sets the title');
  });

  it('handles trailing blank line in JSONL gracefully', async () => {
    const conv = await store.create('deploy-1', 'agent');
    await store.appendMessage(conv.id, {
      id: 'msg-1',
      role: 'user',
      content: { type: 'user', text: 'hello' },
      timestamp: new Date().toISOString(),
    });
    // The JSONL file already has a trailing newline from appendMessage — verify getMessages still works
    const msgs = await store.getMessages(conv.id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].id).toBe('msg-1');
  });
});
