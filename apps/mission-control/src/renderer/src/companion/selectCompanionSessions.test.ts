import type { McConversationView } from '@dash/mc';
import type {
  ConversationMessage,
  MobileAgentEvent,
  MobileWsServerFrame,
} from '@dash/mobile-contract';
import { describe, expect, it } from 'vitest';
import { selectCompanionSessions } from './selectCompanionSessions.js';
import type { CompanionSnapshot } from './types.js';

function conversation(
  id: string,
  origin: 'gateway' | 'local' = 'gateway',
  agentId = 'a1',
  updatedAt = '2026-06-21T10:00:00.000Z',
): McConversationView {
  return {
    id,
    agentId,
    agentName: agentId === 'a1' ? 'Research Bot' : 'Agent',
    title: `${origin}-${id}`,
    revision: 1,
    status: 'idle',
    activeTurnId: null,
    owningIssueId: null,
    projectId: null,
    lastSeq: 0,
    lastMessagePreview: null,
    createdAt: updatedAt,
    updatedAt,
    origin,
    offline: false,
    readOnly: false,
  };
}

function frame(conversationId: string, event: MobileAgentEvent): MobileWsServerFrame {
  return { type: 'event', id: `turn-${conversationId}`, conversationId, seq: 1, event };
}

function assistantMessage(conversationId: string, events: MobileAgentEvent[]): ConversationMessage {
  return {
    id: `message-${conversationId}`,
    conversationId,
    turnId: `turn-${conversationId}`,
    ordinal: 1,
    role: 'assistant',
    status: 'completed',
    content: { type: 'assistant', events },
    createdAt: '2026-06-21T10:00:00.000Z',
    updatedAt: '2026-06-21T10:00:00.000Z',
  };
}

function base(partial: Partial<CompanionSnapshot>): CompanionSnapshot {
  return {
    conversations: [],
    selectedConversationRef: null,
    messages: {},
    streamingFrames: {},
    sending: {},
    unreadConversations: new Set(),
    agentName: (id) => (id === 'a1' ? 'Research Bot' : 'Agent'),
    ...partial,
  };
}

describe('selectCompanionSessions', () => {
  it('returns empty when nothing is tracked', () => {
    expect(selectCompanionSessions(base({ conversations: [conversation('c1')] }))).toEqual([]);
  });

  it('keeps same-ID gateway and local activity distinct by canonical key and ref', () => {
    const snapshot = base({
      conversations: [conversation('shared-id'), conversation('shared-id', 'local', 'a2')],
      sending: { 'gateway:shared-id': true },
      streamingFrames: {
        'gateway:shared-id': [
          frame('shared-id', {
            type: 'tool_use_start',
            id: 'tool-1',
            name: 'bash',
            input: { command: 'npm test' },
          }),
        ],
      },
      unreadConversations: new Set(['local:shared-id']),
      messages: {
        'local:shared-id': [
          assistantMessage('shared-id', [{ type: 'text_delta', text: 'Local finished' }]),
        ],
      },
    });

    const sessions = selectCompanionSessions(snapshot);

    expect(sessions.map((session) => session.conversationKey)).toEqual([
      'gateway:shared-id',
      'local:shared-id',
    ]);
    expect(sessions[0].conversation).toEqual({ id: 'shared-id', origin: 'gateway' });
    expect(sessions[0].preview).toContain('npm test');
    expect(sessions[1].conversation).toEqual({ id: 'shared-id', origin: 'local' });
    expect(sessions[1].preview).toBe('Local finished');
  });

  it('lets a canonical question beat the active sending flag', () => {
    const snapshot = base({
      conversations: [conversation('c1')],
      sending: { 'gateway:c1': true },
      streamingFrames: {
        'gateway:c1': [
          frame('c1', { type: 'question', id: 'q1', question: 'Approve?', options: [] }),
        ],
      },
    });

    expect(selectCompanionSessions(snapshot)[0]).toMatchObject({
      status: 'needs',
      preview: 'Approve?',
    });
  });

  it('classifies a terminal assistant error as error', () => {
    const snapshot = base({
      conversations: [conversation('c1')],
      messages: {
        'gateway:c1': [assistantMessage('c1', [{ type: 'error', error: 'Boom' }])],
      },
    });

    expect(selectCompanionSessions(snapshot)[0]).toMatchObject({
      status: 'error',
      preview: 'Boom',
    });
  });

  it('orders needs before working before done', () => {
    const snapshot = base({
      conversations: [conversation('done'), conversation('work'), conversation('need')],
      sending: { 'gateway:work': true },
      streamingFrames: {
        'gateway:work': [frame('work', { type: 'text_delta', text: 'working' })],
        'gateway:need': [
          frame('need', { type: 'question', id: 'q', question: 'Need input', options: [] }),
        ],
      },
      unreadConversations: new Set(['gateway:done']),
      messages: {
        'gateway:done': [assistantMessage('done', [{ type: 'text_delta', text: 'done' }])],
      },
    });

    expect(selectCompanionSessions(snapshot).map((session) => session.conversationKey)).toEqual([
      'gateway:need',
      'gateway:work',
      'gateway:done',
    ]);
  });
});
