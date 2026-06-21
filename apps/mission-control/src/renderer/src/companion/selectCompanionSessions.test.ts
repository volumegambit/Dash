import { describe, expect, it } from 'vitest';
import { selectCompanionSessions } from './selectCompanionSessions.js';
import type { CompanionSnapshot } from './types.js';

function conv(id: string, agentId = 'a1', updatedAt = '2026-06-21T10:00:00.000Z') {
  return { id, agentId, title: `T-${id}`, createdAt: updatedAt, updatedAt };
}

function base(partial: Partial<CompanionSnapshot>): CompanionSnapshot {
  return {
    conversations: [],
    selectedConversationId: null,
    messages: {},
    streamingEvents: {},
    sending: {},
    unreadConversations: new Set<string>(),
    agentName: (id) => (id === 'a1' ? 'Research Bot' : 'Agent'),
    ...partial,
  };
}

describe('selectCompanionSessions', () => {
  it('returns empty when nothing is tracked', () => {
    const s = base({ conversations: [conv('c1')] });
    expect(selectCompanionSessions(s)).toEqual([]);
  });

  it('classifies a streaming conversation as working with a tool preview', () => {
    const s = base({
      conversations: [conv('c1')],
      sending: { c1: true },
      streamingEvents: {
        c1: [{ type: 'tool_use_start', id: 't1', name: 'bash', input: { command: 'npm test' } }],
      },
    });
    const [r] = selectCompanionSessions(s);
    expect(r.status).toBe('working');
    expect(r.preview).toContain('npm test');
    expect(r.agentName).toBe('Research Bot');
  });

  it('classifies an unanswered question as needs', () => {
    const s = base({
      conversations: [conv('c1')],
      streamingEvents: {
        c1: [{ type: 'question', id: 'q1', question: 'Approve refund?', options: [] }],
      },
    });
    const [r] = selectCompanionSessions(s);
    expect(r.status).toBe('needs');
    expect(r.preview).toBe('Approve refund?');
  });

  it('question beats an active sending flag', () => {
    const s = base({
      conversations: [conv('c1')],
      sending: { c1: true },
      streamingEvents: { c1: [{ type: 'question', id: 'q1', question: 'Pick one', options: [] }] },
    });
    expect(selectCompanionSessions(s)[0].status).toBe('needs');
  });

  it('classifies a finished assistant error message as error', () => {
    const s = base({
      conversations: [conv('c1')],
      messages: {
        c1: [
          {
            id: 'm1',
            role: 'assistant',
            content: { type: 'assistant', events: [{ type: 'error', error: 'Boom' }] },
            timestamp: '2026-06-21T10:00:00.000Z',
          },
        ],
      },
    });
    const [r] = selectCompanionSessions(s);
    expect(r.status).toBe('error');
    expect(r.preview).toBe('Boom');
  });

  it('classifies an unread finished conversation as done with text preview', () => {
    const s = base({
      conversations: [conv('c1')],
      unreadConversations: new Set(['c1']),
      messages: {
        c1: [
          {
            id: 'm1',
            role: 'assistant',
            content: {
              type: 'assistant',
              events: [{ type: 'text_delta', text: 'Deployed v0.4.2' }],
            },
            timestamp: '2026-06-21T10:00:00.000Z',
          },
        ],
      },
    });
    const [r] = selectCompanionSessions(s);
    expect(r.status).toBe('done');
    expect(r.preview).toBe('Deployed v0.4.2');
  });

  it('orders error/needs before working before done, then by recency', () => {
    const s = base({
      conversations: [
        conv('done1', 'a1', '2026-06-21T10:05:00.000Z'),
        conv('work1', 'a1', '2026-06-21T10:04:00.000Z'),
        conv('need1', 'a1', '2026-06-21T10:03:00.000Z'),
      ],
      sending: { work1: true },
      streamingEvents: {
        work1: [{ type: 'text_delta', text: 'thinking' }],
        need1: [{ type: 'question', id: 'q', question: 'Q?', options: [] }],
      },
      unreadConversations: new Set(['done1']),
      messages: {
        done1: [
          {
            id: 'm',
            role: 'assistant',
            content: { type: 'assistant', events: [{ type: 'text_delta', text: 'ok' }] },
            timestamp: '2026-06-21T10:05:00.000Z',
          },
        ],
      },
    });
    expect(selectCompanionSessions(s).map((r) => r.conversationId)).toEqual([
      'need1',
      'work1',
      'done1',
    ]);
  });

  it('ranks error before needs even when the error is less recent', () => {
    const s = base({
      conversations: [
        conv('need1', 'a1', '2026-06-21T10:05:00.000Z'),
        conv('err1', 'a1', '2026-06-21T10:00:00.000Z'),
      ],
      streamingEvents: {
        need1: [{ type: 'question', id: 'q', question: 'Q?', options: [] }],
      },
      messages: {
        err1: [
          {
            id: 'm',
            role: 'assistant',
            content: { type: 'assistant', events: [{ type: 'error', error: 'Boom' }] },
            timestamp: '2026-06-21T10:00:00.000Z',
          },
        ],
      },
    });
    expect(selectCompanionSessions(s).map((r) => r.conversationId)).toEqual(['err1', 'need1']);
  });
});
