import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@dash/agent';
import type { SubagentInfo } from '@dash/mobile-contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteConversationService } from './conversation-service-sqlite.js';
import { MAX_QUEUED_NOTIFICATIONS } from './conversation-service.js';
import type { EventLogPayload } from './event-log-store.js';
import {
  INTERRUPTED_CHILD_REPORT,
  queueInterruptedSubagentNotifications,
  recoverInterruptedSubagentTails,
} from './swarm-log-recovery.js';

const AGENT = 'agent-a';

function eventPayload(event: AgentEvent): EventLogPayload {
  return { type: 'event', event };
}

function started(subagentId: string, overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    type: 'subagent_started',
    subagentId,
    name: `name-${subagentId}`,
    subagentType: 'general-purpose',
    description: `describe ${subagentId}`,
    prompt: `do ${subagentId}`,
    model: 'test/model',
    background: true,
    depth: 1,
    startedAt: '2026-09-06T00:00:00.000Z',
    ...overrides,
  } as AgentEvent;
}

function finished(subagentId: string, status = 'done'): AgentEvent {
  return {
    type: 'subagent_finished',
    subagentId,
    subagentType: 'general-purpose',
    description: `describe ${subagentId}`,
    status,
    report: 'all done',
    toolCallCount: 2,
    startedAt: '2026-09-06T00:00:00.000Z',
    endedAt: '2026-09-06T00:01:00.000Z',
  } as AgentEvent;
}

describe('recoverInterruptedSubagentTails', () => {
  let tmpDir: string;
  let service: SqliteConversationService;
  let uuidCounter: number;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'subagent-recovery-'));
    uuidCounter = 0;
    service = new SqliteConversationService({
      dataDir: tmpDir,
      uuid: () => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, '0')}`,
    });
  });

  afterEach(async () => {
    service.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  function parentWithOpenTurn(): { id: string; turnId: string } {
    const conversation = service.create({
      agentId: AGENT,
      agentName: 'Helper',
      requestId: `req-${++uuidCounter}`,
    });
    const turnId = `turn-${uuidCounter}`;
    service.acceptTurn({
      agentId: AGENT,
      conversationId: conversation.id,
      turnId,
      text: 'delegate this',
    });
    return { id: conversation.id, turnId };
  }

  it('terminalizes a dangling child and queues one parent notification without an error marker', () => {
    const parent = parentWithOpenTurn();
    service.appendTurnEvent(parent.id, parent.turnId, started('sub_a'));

    const result = recoverInterruptedSubagentTails({
      eventLog: service.eventLog,
      conversations: service,
    });

    expect(result).toMatchObject({
      conversationsRepaired: 1,
      childrenTerminalized: 1,
      notificationsQueued: 1,
      pendingDelivery: [{ agentId: AGENT, conversationId: parent.id }],
      canonicalConversationsRepaired: [],
      failedCanonicalConversationIds: [],
    });
    const tail = service.eventLog.readSince(AGENT, parent.id, 0);
    expect(tail.at(-1)?.payload).toEqual(
      eventPayload({
        type: 'subagent_finished',
        subagentId: 'sub_a',
        name: 'name-sub_a',
        subagentType: 'general-purpose',
        description: 'describe sub_a',
        status: 'interrupted',
        report: INTERRUPTED_CHILD_REPORT,
        toolCallCount: 0,
        startedAt: '2026-09-06T00:00:00.000Z',
        endedAt: expect.any(String),
      } as AgentEvent),
    );
    expect(tail.filter((entry) => entry.payload.type === 'error')).toHaveLength(0);
    expect(service.peekNotifications(parent.id)).toEqual([
      expect.objectContaining({
        kind: 'subagent_finished',
        payload: expect.objectContaining({ subagentId: 'sub_a', status: 'interrupted' }),
      }),
    ]);
  });

  it('tolerates a pre-child-conversation worker mirror and only appends the canonical terminal', () => {
    const parent = parentWithOpenTurn();
    service.appendTurnEvent(parent.id, parent.turnId, {
      type: 'worker_spawned',
      workerId: 'sub_a',
      runId: 'legacy-run',
      role: 'scout',
      brief: 'survey',
      model: 'test/model',
    });
    service.appendTurnEvent(parent.id, parent.turnId, started('sub_a'));

    expect(
      recoverInterruptedSubagentTails({ eventLog: service.eventLog, conversations: service }),
    ).toMatchObject({ childrenTerminalized: 1, notificationsQueued: 1 });
    const types = service.eventLog
      .readSince(AGENT, parent.id, 0)
      .map((entry) =>
        entry.payload.type === 'event' ? entry.payload.event.type : entry.payload.type,
      );
    expect(types.filter((type) => type === 'worker_done')).toEqual([]);
    expect(types.at(-1)).toBe('subagent_finished');
  });

  it('leaves already-finished children alone and is idempotent after a repair', () => {
    const finishedParent = parentWithOpenTurn();
    service.appendTurnEvent(finishedParent.id, finishedParent.turnId, started('sub_done'));
    service.appendTurnEvent(finishedParent.id, finishedParent.turnId, finished('sub_done'));
    const danglingParent = parentWithOpenTurn();
    service.appendTurnEvent(danglingParent.id, danglingParent.turnId, started('sub_dangling'));

    const first = recoverInterruptedSubagentTails({
      eventLog: service.eventLog,
      conversations: service,
    });
    const afterFirst = service.eventLog.readSince(AGENT, danglingParent.id, 0).length;
    const second = recoverInterruptedSubagentTails({
      eventLog: service.eventLog,
      conversations: service,
    });

    expect(first).toMatchObject({ conversationsRepaired: 1, childrenTerminalized: 1 });
    expect(second).toMatchObject({ conversationsRepaired: 0, childrenTerminalized: 0 });
    expect(service.eventLog.readSince(AGENT, danglingParent.id, 0)).toHaveLength(afterFirst);
    expect(service.peekNotifications(finishedParent.id)).toEqual([]);
    expect(service.peekNotifications(danglingParent.id)).toHaveLength(1);
  });

  it('uses the canonical current-segment journal for v2 recovery', () => {
    const conversation = service.create({
      agentId: AGENT,
      agentName: 'Canonical Helper',
      requestId: 'create-canonical',
    });
    const active = service.acceptRun({
      protocol: 'v2',
      agentId: AGENT,
      channelId: 'direct',
      conversationId: conversation.id,
      runId: 'outer-canonical',
      text: 'Delegate this canonically',
    });
    service.enqueueInput({
      commandId: 'command-steer',
      inputId: 'input-steer',
      agentId: AGENT,
      channelId: 'direct',
      conversationId: conversation.id,
      text: 'continue in the latest segment',
      behavior: 'steer',
      expectedActiveTurnId: active.runId,
    });
    const steer = service.deliverSteer({
      conversationId: conversation.id,
      runId: active.runId,
      inputId: 'input-steer',
    });
    service.appendRunEvent({
      conversationId: conversation.id,
      runId: active.runId,
      segmentTurnId: steer.segmentTurnId,
      event: started('sub_current'),
    });
    const beforeV1 = service.eventLog.readSince(AGENT, conversation.id, 0).length;
    const beforeV2 = service.bootstrapV2({
      conversationId: conversation.id,
      limit: 100,
    }).v2ThroughSeq;

    const result = recoverInterruptedSubagentTails({
      eventLog: service.eventLog,
      conversations: service,
      canonicalRuns: [
        { agentId: AGENT, conversationId: conversation.id, outerRunId: active.runId },
      ],
      appendCurrentRunEvent: (agentId, conversationId, runId, event) =>
        service.appendCurrentRunEvent(agentId, conversationId, runId, event),
    });

    expect(result).toMatchObject({
      conversationsRepaired: 1,
      childrenTerminalized: 1,
      canonicalConversationsRepaired: [conversation.id],
      failedCanonicalConversationIds: [],
    });
    expect(service.eventLog.readSince(AGENT, conversation.id, 0).slice(beforeV1)).toEqual([
      expect.objectContaining({
        msgId: active.runId,
        segmentTurnId: steer.segmentTurnId,
        payload: expect.objectContaining({
          type: 'event',
          event: expect.objectContaining({
            type: 'subagent_finished',
            subagentId: 'sub_current',
            status: 'interrupted',
          }),
        }),
      }),
    ]);
    expect(service.readV2Since(AGENT, conversation.id, beforeV2).frames).toEqual([
      expect.objectContaining({
        type: 'event',
        runId: active.runId,
        segmentTurnId: steer.segmentTurnId,
        event: expect.objectContaining({
          type: 'subagent_finished',
          subagentId: 'sub_current',
        }),
      }),
    ]);
  });

  it('never falls back to the legacy journal when a canonical dual append is rejected', () => {
    const conversation = service.create({
      agentId: AGENT,
      agentName: 'Canonical Helper',
      requestId: 'create-canonical-failure',
    });
    const active = service.acceptRun({
      protocol: 'v2',
      agentId: AGENT,
      channelId: 'direct',
      conversationId: conversation.id,
      runId: 'outer-failure',
      text: 'Delegate this canonically',
    });
    service.appendRunEvent({
      conversationId: conversation.id,
      runId: active.runId,
      segmentTurnId: active.segmentTurnId,
      event: started('sub_failure'),
    });
    const legacyAppend = vi.spyOn(service.eventLog, 'append');

    const result = recoverInterruptedSubagentTails({
      eventLog: service.eventLog,
      conversations: service,
      canonicalRuns: [
        { agentId: AGENT, conversationId: conversation.id, outerRunId: active.runId },
      ],
      appendCurrentRunEvent: () => null,
    });

    expect(result).toMatchObject({
      conversationsRepaired: 0,
      childrenTerminalized: 0,
      canonicalConversationsRepaired: [],
      failedCanonicalConversationIds: [conversation.id],
    });
    expect(legacyAppend).not.toHaveBeenCalled();
    expect(service.peekNotifications(conversation.id)).toEqual([]);
  });

  it('retries only a missing canonical child after a partial dual-journal repair', () => {
    const conversation = service.create({
      agentId: AGENT,
      agentName: 'Canonical Helper',
      requestId: 'create-partial',
    });
    const active = service.acceptRun({
      protocol: 'v2',
      agentId: AGENT,
      channelId: 'direct',
      conversationId: conversation.id,
      runId: 'outer-partial',
      text: 'Repair two children',
    });
    for (const subagentId of ['sub_one', 'sub_two']) {
      service.appendRunEvent({
        conversationId: conversation.id,
        runId: active.runId,
        segmentTurnId: active.segmentTurnId,
        event: started(subagentId),
      });
    }
    let rejectSecond = true;
    const appendCurrentRunEvent = vi.fn(
      (agentId: string, conversationId: string, runId: string, event: AgentEvent) => {
        if (rejectSecond && event.type === 'subagent_finished' && event.subagentId === 'sub_two') {
          return null;
        }
        return service.appendCurrentRunEvent(agentId, conversationId, runId, event);
      },
    );
    const options = {
      eventLog: service.eventLog,
      conversations: service,
      canonicalRuns: [
        { agentId: AGENT, conversationId: conversation.id, outerRunId: active.runId },
      ],
      appendCurrentRunEvent,
    };

    expect(recoverInterruptedSubagentTails(options)).toMatchObject({
      childrenTerminalized: 1,
      failedCanonicalConversationIds: [conversation.id],
    });
    rejectSecond = false;
    expect(recoverInterruptedSubagentTails(options)).toMatchObject({
      childrenTerminalized: 1,
      canonicalConversationsRepaired: [conversation.id],
      failedCanonicalConversationIds: [],
    });
    expect(
      appendCurrentRunEvent.mock.calls.filter(
        (call) => call[3].type === 'subagent_finished' && call[3].subagentId === 'sub_one',
      ),
    ).toHaveLength(1);
    expect(service.peekNotifications(conversation.id)).toHaveLength(2);
  });
});

describe('queueInterruptedSubagentNotifications', () => {
  let tmpDir: string;
  let service: SqliteConversationService;
  let uuidCounter: number;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'subagent-child-recovery-'));
    uuidCounter = 0;
    service = new SqliteConversationService({
      dataDir: tmpDir,
      uuid: () => `10000000-0000-4000-8000-${String(++uuidCounter).padStart(12, '0')}`,
    });
  });

  afterEach(async () => {
    service.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  function subagentInfo(overrides: Partial<SubagentInfo> = {}): SubagentInfo {
    return {
      type: 'general-purpose',
      status: 'running',
      description: 'survey the repo',
      prompt: 'survey',
      model: 'test/model',
      background: true,
      depth: 1,
      startedAt: '2026-09-06T00:00:00.000Z',
      toolCallCount: 3,
      oneShot: false,
      ...overrides,
    };
  }

  function parentWithChild(childId: string, info: Partial<SubagentInfo> = {}) {
    const parent = service.create({
      agentId: AGENT,
      agentName: 'Helper',
      requestId: `req-${++uuidCounter}`,
    });
    service.createSubagent({
      id: childId,
      agentId: AGENT,
      agentName: 'Helper',
      parentConversationId: parent.id,
      parentTurnId: 'turn-1',
      title: 'child',
      subagent: subagentInfo(info),
    });
    return parent;
  }

  it('queues one notification per freshly interrupted child and stamps endedAt', () => {
    const parent = parentWithChild('sub_a');
    service.updateSubagent('sub_a', { status: 'interrupted' });

    const result = queueInterruptedSubagentNotifications({ conversations: service });

    expect(result).toMatchObject({
      childrenNotified: 1,
      pendingDelivery: [{ agentId: AGENT, conversationId: parent.id }],
    });
    expect(service.peekNotifications(parent.id)[0]).toMatchObject({
      kind: 'subagent_finished',
      payload: {
        subagentId: 'sub_a',
        status: 'interrupted',
        subagentType: 'general-purpose',
        description: 'survey the repo',
        toolCallCount: 3,
      },
    });
    expect(service.get('sub_a')?.subagent?.endedAt).toEqual(expect.any(String));
  });

  it('does not double-queue a child already notified or finalized on an earlier boot', () => {
    const parent = parentWithChild('sub_a');
    service.updateSubagent('sub_a', { status: 'interrupted' });
    service.enqueueNotification({
      conversationId: parent.id,
      kind: 'subagent_finished',
      payload: { subagentId: 'sub_a', status: 'interrupted' },
    });

    expect(queueInterruptedSubagentNotifications({ conversations: service })).toMatchObject({
      childrenNotified: 0,
    });
    expect(service.peekNotifications(parent.id)).toHaveLength(1);

    service.updateSubagent('sub_a', { info: { endedAt: '2026-09-05T00:00:00.000Z' } });
    expect(queueInterruptedSubagentNotifications({ conversations: service })).toMatchObject({
      childrenNotified: 0,
    });
    expect(service.peekNotifications(parent.id)).toHaveLength(1);
  });

  it('contains a full parent queue and still notifies another child', () => {
    const full = parentWithChild('sub_full');
    for (let index = 0; index < MAX_QUEUED_NOTIFICATIONS; index++) {
      service.enqueueNotification({
        conversationId: full.id,
        kind: 'subagent_message',
        payload: { from: 'x', message: String(index) },
      });
    }
    service.updateSubagent('sub_full', { status: 'interrupted' });
    const parent = parentWithChild('sub_ok');
    service.updateSubagent('sub_ok', { status: 'interrupted' });
    const logged: string[] = [];

    const result = queueInterruptedSubagentNotifications({
      conversations: service,
      log: (message) => logged.push(message),
    });

    expect(result.childrenNotified).toBe(1);
    expect(logged.some((message) => message.includes('sub_full'))).toBe(true);
    expect(service.peekNotifications(parent.id)).toHaveLength(1);
  });
});
