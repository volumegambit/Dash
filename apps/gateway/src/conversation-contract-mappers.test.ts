import {
  mapConversationV1,
  mapConversationV2,
  mapMessageV1,
  mapMessageV2,
} from './conversation-contract-mappers.js';
import type { StoredConversation, StoredConversationMessage } from './conversation-domain.js';

const NOW = '2026-09-06T00:00:00.000Z';

function expectNoV2Keys(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const forbiddenKey of [
    'activeRunId',
    'runId',
    'segmentIndex',
    'deliveryKind',
    'deliveryStatus',
    'queuePaused',
    'queueRevision',
    'pendingFollowUpCount',
    'nextMessageOrdinal',
    'v2LastSeq',
    'v2ThroughSeq',
    'sinceV2Seq',
  ]) {
    expect(serialized).not.toContain(`\"${forbiddenKey}\"`);
  }
}

function storedConversation(): StoredConversation {
  return {
    id: 'conversation-1',
    createRequestId: 'request-1',
    agentId: 'agent-1',
    agentName: 'Dash',
    title: 'Conversation',
    revision: 3,
    status: 'running',
    activeRunId: 'run-1',
    owningIssueId: 'issue-1',
    projectId: 'project-1',
    lastSeq: 7,
    v2LastSeq: 11,
    queuePaused: true,
    queueRevision: 5,
    nextMessageOrdinal: 9,
    pendingFollowUpCount: 2,
    lastMessagePreview: 'focus here',
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function steerUserMessage(
  overrides: Partial<StoredConversationMessage> = {},
): StoredConversationMessage {
  return {
    id: 'message-1',
    conversationId: 'conversation-1',
    turnId: 'turn-1',
    runId: 'run-1',
    segmentIndex: 1,
    ordinal: 3,
    role: 'user',
    status: 'accepted',
    deliveryKind: 'steer',
    content: { type: 'user', text: 'focus here' },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('conversation contract mappers', () => {
  it('maps one internal conversation to isolated v1 and v2 shapes', () => {
    const stored = storedConversation();

    const v1 = mapConversationV1(stored);
    expect(v1).toEqual({
      id: stored.id,
      agentId: stored.agentId,
      agentName: stored.agentName,
      title: stored.title,
      revision: stored.revision,
      status: stored.status,
      activeTurnId: 'run-1',
      owningIssueId: 'issue-1',
      projectId: 'project-1',
      lastSeq: 7,
      lastMessagePreview: 'focus here',
      createdAt: NOW,
      updatedAt: NOW,
    });
    expectNoV2Keys(v1);
    expect(mapConversationV2(stored)).toEqual({
      ...v1,
      queuePaused: true,
      queueRevision: 5,
      pendingFollowUpCount: 2,
      v2LastSeq: 11,
    });
  });

  it('maps one internal message to isolated v1 and v2 shapes', () => {
    const stored = steerUserMessage({ deliveryStatus: 'pending' });
    const v1 = mapMessageV1(stored);

    expect(v1).toEqual({
      id: stored.id,
      conversationId: stored.conversationId,
      turnId: stored.turnId,
      ordinal: stored.ordinal,
      role: 'user',
      status: 'accepted',
      content: { type: 'user', text: 'focus here' },
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(mapMessageV2(stored)).toMatchObject({
      runId: 'run-1',
      segmentIndex: 1,
      deliveryKind: 'steer',
      deliveryStatus: 'pending',
    });

    expectNoV2Keys(v1);
  });

  it('omits absent delivery status from v2 messages', () => {
    expect(mapMessageV2(steerUserMessage())).not.toHaveProperty('deliveryStatus');
  });
});
