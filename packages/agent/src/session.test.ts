import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JsonlSessionStore } from './session.js';

describe('JsonlSessionStore', () => {
  let dir: string;
  let store: JsonlSessionStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dash-test-'));
    store = new JsonlSessionStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true });
  });

  it('returns null for nonexistent session', async () => {
    const session = await store.load('telegram', '123');
    expect(session).toBeNull();
  });

  it('appends and loads entries', async () => {
    const sessionId = 'telegram:123';

    await store.append(sessionId, {
      timestamp: '2026-01-01T00:00:00Z',
      type: 'message',
      data: { role: 'user', content: 'Hello' },
    });

    await store.append(sessionId, {
      timestamp: '2026-01-01T00:00:01Z',
      type: 'response',
      data: { content: 'Hi there!' },
    });

    const session = await store.load('telegram', '123');
    expect(session).not.toBeNull();
    expect(session?.messages).toHaveLength(2);
    expect(session?.messages[0]).toEqual({ role: 'user', content: 'Hello' });
    expect(session?.messages[1]).toEqual({ role: 'assistant', content: 'Hi there!' });
  });

  it('handles structured content (ContentBlock[]) in responses', async () => {
    const sessionId = 'telegram:456';

    await store.append(sessionId, {
      timestamp: '2026-01-01T00:00:00Z',
      type: 'message',
      data: { role: 'user', content: 'run ls' },
    });

    // Assistant response with tool_use blocks (stored as ContentBlock[])
    const assistantContent = [
      { type: 'text', text: 'Let me run that.' },
      { type: 'tool_use', id: 'tu_1', name: 'bash', input: { command: 'ls' } },
    ];
    await store.append(sessionId, {
      timestamp: '2026-01-01T00:00:01Z',
      type: 'response',
      data: { content: assistantContent },
    });

    // Tool result
    const toolResultContent = [
      { type: 'tool_result', tool_use_id: 'tu_1', content: 'file1.txt\nfile2.txt' },
    ];
    await store.append(sessionId, {
      timestamp: '2026-01-01T00:00:02Z',
      type: 'tool_result',
      data: { content: toolResultContent },
    });

    // Final assistant text response
    await store.append(sessionId, {
      timestamp: '2026-01-01T00:00:03Z',
      type: 'response',
      data: { content: 'The directory contains file1.txt and file2.txt.' },
    });

    const session = await store.load('telegram', '456');
    expect(session).not.toBeNull();
    expect(session?.messages).toHaveLength(4);

    // User message
    expect(session?.messages[0]).toEqual({ role: 'user', content: 'run ls' });

    // Assistant with structured content
    expect(session?.messages[1].role).toBe('assistant');
    expect(Array.isArray(session?.messages[1].content)).toBe(true);
    const blocks = session?.messages[1].content as { type: string }[];
    expect(blocks[0].type).toBe('text');
    expect(blocks[1].type).toBe('tool_use');

    // Tool result
    expect(session?.messages[2].role).toBe('user');
    expect(Array.isArray(session?.messages[2].content)).toBe(true);

    // Final text response
    expect(session?.messages[3]).toEqual({
      role: 'assistant',
      content: 'The directory contains file1.txt and file2.txt.',
    });
  });
});
