import { describe, expect, it } from 'vitest';
import { buildSnapshot } from './snapshot.js';

describe('buildSnapshot', () => {
  it('passes chat fields through and resolves agent names', () => {
    const snap = buildSnapshot(
      {
        conversations: [{ id: 'c1', agentId: 'a1', title: 'T', createdAt: 'x', updatedAt: 'x' }],
        selectedConversationId: 'c1',
        messages: {},
        streamingEvents: {},
        sending: { c1: true },
        unreadConversations: new Set(['c1']),
      },
      { agents: [{ id: 'a1', name: 'Research Bot' }] },
    );
    expect(snap.sending.c1).toBe(true);
    expect(snap.unreadConversations.has('c1')).toBe(true);
    expect(snap.agentName('a1')).toBe('Research Bot');
  });

  it('falls back to a generic name for unknown agents', () => {
    const snap = buildSnapshot(
      {
        conversations: [],
        selectedConversationId: null,
        messages: {},
        streamingEvents: {},
        sending: {},
        unreadConversations: new Set(),
      },
      { agents: [] },
    );
    expect(snap.agentName('missing')).toBe('Agent');
  });
});
