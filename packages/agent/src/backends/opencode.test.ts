import { describe, expect, it, vi } from 'vitest';

vi.mock('@opencode-ai/sdk/v2', () => ({
  createOpencodeServer: vi.fn(),
  createOpencodeClient: vi.fn(),
}));

import { OpenCodeBackend, extractSkillName } from './opencode.js';

function makeBackend() {
  return new OpenCodeBackend(
    { model: 'anthropic/claude-opus-4-5', systemPrompt: 'You are helpful.' },
    {},
  );
}

const makeEvent = (type: string, properties: object) => ({ type, properties });

describe('OpenCodeBackend.normalizeEvent', () => {
  it('returns text_delta for message.part.delta with field=text', () => {
    const backend = makeBackend();
    const result = backend.normalizeEvent(
      makeEvent('message.part.delta', { sessionID: 'sess-1', field: 'text', delta: 'Hello' }),
      'sess-1',
    );
    expect(result).toEqual({ type: 'text_delta', text: 'Hello' });
  });

  it('returns thinking_delta for message.part.delta with field=reasoning', () => {
    const backend = makeBackend();
    const result = backend.normalizeEvent(
      makeEvent('message.part.delta', {
        sessionID: 'sess-1',
        field: 'reasoning',
        delta: 'Thinking...',
      }),
      'sess-1',
    );
    expect(result).toEqual({ type: 'thinking_delta', text: 'Thinking...' });
  });

  it('returns null for message.part.delta with unknown field', () => {
    const backend = makeBackend();
    const result = backend.normalizeEvent(
      makeEvent('message.part.delta', { sessionID: 'sess-1', field: 'other', delta: 'x' }),
      'sess-1',
    );
    expect(result).toBeNull();
  });

  it('filters events from other sessions', () => {
    const backend = makeBackend();
    const result = backend.normalizeEvent(
      makeEvent('message.part.delta', { sessionID: 'other', field: 'text', delta: 'Hi' }),
      'sess-1',
    );
    expect(result).toBeNull();
  });

  it('returns tool_use_start for pending tool part', () => {
    const backend = makeBackend();
    const result = backend.normalizeEvent(
      makeEvent('message.part.updated', {
        part: {
          type: 'tool',
          sessionID: 'sess-1',
          callID: 'call-1',
          tool: 'bash',
          state: { status: 'pending', input: {}, raw: '' },
        },
      }),
      'sess-1',
    );
    expect(result).toEqual({ type: 'tool_use_start', id: 'call-1', name: 'bash' });
  });

  it('returns tool_result for completed tool part', () => {
    const backend = makeBackend();
    const result = backend.normalizeEvent(
      makeEvent('message.part.updated', {
        part: {
          type: 'tool',
          sessionID: 'sess-1',
          callID: 'call-1',
          tool: 'bash',
          state: {
            status: 'completed',
            input: {},
            output: 'done',
            title: 'bash',
            metadata: {},
            time: { start: 0, end: 1 },
          },
        },
      }),
      'sess-1',
    );
    expect(result).toEqual({ type: 'tool_result', id: 'call-1', name: 'bash', content: 'done' });
  });

  it('returns file_changed for patch part', () => {
    const backend = makeBackend();
    const result = backend.normalizeEvent(
      makeEvent('message.part.updated', {
        part: { type: 'patch', sessionID: 'sess-1', hash: 'abc', files: ['src/foo.ts'] },
      }),
      'sess-1',
    );
    expect(result).toEqual({ type: 'file_changed', files: ['src/foo.ts'] });
  });

  it('returns context_compacted for compaction part', () => {
    const backend = makeBackend();
    const result = backend.normalizeEvent(
      makeEvent('message.part.updated', {
        part: { type: 'compaction', sessionID: 'sess-1', auto: true, overflow: true },
      }),
      'sess-1',
    );
    expect(result).toEqual({ type: 'context_compacted', overflow: true });
  });

  it('returns null for session.status idle (handled by run loop, not normalizeEvent)', () => {
    const backend = makeBackend();
    const result = backend.normalizeEvent(
      makeEvent('session.status', { sessionID: 'sess-1', status: { type: 'idle' } }),
      'sess-1',
    );
    expect(result).toBeNull();
  });

  it('returns agent_retry for session.status retry', () => {
    const backend = makeBackend();
    const result = backend.normalizeEvent(
      makeEvent('session.status', {
        sessionID: 'sess-1',
        status: { type: 'retry', attempt: 2, message: 'Rate limit' },
      }),
      'sess-1',
    );
    expect(result).toEqual({ type: 'agent_retry', attempt: 2, reason: 'Rate limit' });
  });

  it('returns error for session.error', () => {
    const backend = makeBackend();
    const result = backend.normalizeEvent(
      makeEvent('session.error', { sessionID: 'sess-1', error: { message: 'API key invalid' } }),
      'sess-1',
    );
    expect(result).toEqual({ type: 'error', error: new Error('API key invalid') });
  });

  it('returns question for question.asked', () => {
    const backend = makeBackend();
    const result = backend.normalizeEvent(
      makeEvent('question.asked', {
        sessionID: 'sess-1',
        id: 'q-1',
        questions: [
          {
            question: 'Which approach?',
            header: 'Approach',
            options: [
              { label: 'A', description: 'Option A' },
              { label: 'B', description: 'Option B' },
            ],
          },
        ],
      }),
      'sess-1',
    );
    expect(result).toEqual({
      type: 'question',
      id: 'q-1',
      question: 'Which approach?',
      options: ['A', 'B'],
    });
  });

  it('returns null for unknown event type', () => {
    const backend = makeBackend();
    const result = backend.normalizeEvent(makeEvent('tui.prompt.append', { text: 'x' }), 'sess-1');
    expect(result).toBeNull();
  });
});

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
