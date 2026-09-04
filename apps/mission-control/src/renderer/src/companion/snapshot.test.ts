import type { McConversationView } from '@dash/mc';
import { describe, expect, it } from 'vitest';
import { buildSnapshot } from './snapshot.js';

const gateway: McConversationView = {
  id: 'shared-id',
  agentId: 'a1',
  agentName: 'Gateway Bot',
  title: 'Gateway',
  revision: 1,
  status: 'idle',
  activeTurnId: null,
  owningIssueId: null,
  projectId: null,
  lastSeq: 0,
  lastMessagePreview: null,
  createdAt: '2026-07-12T00:00:00Z',
  updatedAt: '2026-07-12T00:00:00Z',
  origin: 'gateway',
  offline: false,
  readOnly: false,
};

describe('buildSnapshot', () => {
  it('preserves exact-origin selection and same-ID keyed session state', () => {
    const snap = buildSnapshot(
      {
        conversations: [gateway, { ...gateway, origin: 'local', agentName: '' }],
        selectedConversationRef: { id: 'shared-id', origin: 'local' },
        messages: {},
        streamingFrames: {},
        sending: { 'gateway:shared-id': true, 'local:shared-id': false },
        unreadConversations: new Set(['local:shared-id']),
      },
      { agents: [{ id: 'a1', name: 'Research Bot' }] },
    );

    expect(snap.selectedConversationRef).toEqual({ id: 'shared-id', origin: 'local' });
    expect(snap.sending['gateway:shared-id']).toBe(true);
    expect(snap.sending['local:shared-id']).toBe(false);
    expect(snap.unreadConversations.has('local:shared-id')).toBe(true);
    expect(snap.agentName('a1')).toBe('Research Bot');
  });

  it('falls back to a generic name for unknown agents', () => {
    const snap = buildSnapshot(
      {
        conversations: [],
        selectedConversationRef: null,
        messages: {},
        streamingFrames: {},
        sending: {},
        unreadConversations: new Set(),
      },
      { agents: [] },
    );
    expect(snap.agentName('missing')).toBe('Agent');
  });
});
