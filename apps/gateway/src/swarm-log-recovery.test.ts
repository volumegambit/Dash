import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@dash/agent';
import type { SubagentInfo } from '@dash/mobile-contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteConversationService } from './conversation-service-sqlite.js';
import { MAX_QUEUED_NOTIFICATIONS } from './conversation-service.js';
import type { EventLogPayload } from './event-log-store.js';
import {
  INTERRUPTED_CHILD_REPORT,
  queueInterruptedSubagentNotifications,
  recoverInterruptedSubagentTails,
} from './swarm-log-recovery.js';

/**
 * Boot-time SUB-AGENT recovery (design §7.4, §7.5). Two halves, deliberately
 * split around the generic `recoverInterruptedTurns`:
 *
 * 1. `recoverInterruptedSubagentTails` — the PARENT side. Runs BEFORE the
 *    generic recovery so its synthesized `subagent_finished` lands before the
 *    terminal error marker (an event appended after that marker would leave the
 *    log non-terminal again and the conversation would be "interrupted" for
 *    ever).
 * 2. `queueInterruptedSubagentNotifications` — the CHILD side. Runs AFTER the
 *    generic recovery, which is what flips a running child's
 *    `subagent_status` to `interrupted`.
 */

const AGENT = 'agent-a';

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

  function evt(event: AgentEvent): EventLogPayload {
    return { type: 'event', event };
  }

  function started(subagentId: string, over: Partial<AgentEvent> = {}): AgentEvent {
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
      ...over,
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

  /** A parent conversation with a live (never-terminated) turn in its log. */
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

  it('synthesizes subagent_finished{interrupted} for a dangling subagent_started', () => {
    const parent = parentWithOpenTurn();
    service.appendTurnEvent(parent.id, parent.turnId, started('sub_a'));

    const result = recoverInterruptedSubagentTails({
      eventLog: service.eventLog,
      conversations: service,
    });

    expect(result).toMatchObject({ conversationsRepaired: 1, childrenTerminalized: 1 });
    const tail = service.eventLog.readSince(AGENT, parent.id, 0);
    expect(tail.at(-1)?.payload).toEqual(
      evt({
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
      }),
    );
    // The generic recovery owns the terminal stream marker now — this step
    // must NOT append one, or the parent would carry two.
    expect(tail.filter((entry) => entry.payload.type === 'error')).toHaveLength(0);
  });

  it('queues exactly one interrupted notification on the parent', () => {
    const parent = parentWithOpenTurn();
    service.appendTurnEvent(parent.id, parent.turnId, started('sub_a'));

    const result = recoverInterruptedSubagentTails({
      eventLog: service.eventLog,
      conversations: service,
    });

    expect(result.notificationsQueued).toBe(1);
    const queued = service.peekNotifications(parent.id);
    expect(queued).toHaveLength(1);
    expect(queued[0].kind).toBe('subagent_finished');
    expect(queued[0].payload).toMatchObject({
      subagentId: 'sub_a',
      status: 'interrupted',
      report: INTERRUPTED_CHILD_REPORT,
    });
  });

  it('repairs a PRE-D8 tail (legacy worker_spawned present) with the canonical pair only', () => {
    const parent = parentWithOpenTurn();
    // A transcript persisted before D8 still carries the retired mirror. The
    // dangling scan has always been driven off `subagent_started`, so the
    // repair is unchanged — and it no longer writes a `worker_done` of its own.
    service.appendTurnEvent(parent.id, parent.turnId, {
      type: 'worker_spawned',
      workerId: 'sub_a',
      runId: 'run-1',
      role: 'scout',
      brief: 'survey',
      model: 'test/model',
    });
    service.appendTurnEvent(parent.id, parent.turnId, started('sub_a'));

    const result = recoverInterruptedSubagentTails({
      eventLog: service.eventLog,
      conversations: service,
    });

    expect(result.childrenTerminalized).toBe(1);
    const tail = service.eventLog.readSince(AGENT, parent.id, 0);
    expect(tail.at(-1)?.payload).toMatchObject({
      type: 'event',
      event: { type: 'subagent_finished', subagentId: 'sub_a', status: 'interrupted' },
    });
    const appended = tail.map((t) => (t.payload as { event?: { type?: string } }).event?.type);
    expect(appended.filter((t) => t === 'worker_done')).toEqual([]);
    // D6's restart notification (`0da16410`) still fires for the repaired child.
    expect(result.notificationsQueued).toBe(1);
    expect(service.peekNotifications(parent.id)[0].payload).toMatchObject({
      subagentId: 'sub_a',
      status: 'interrupted',
    });
  });

  it('leaves a child that already finished alone', () => {
    const parent = parentWithOpenTurn();
    service.appendTurnEvent(parent.id, parent.turnId, started('sub_a'));
    service.appendTurnEvent(parent.id, parent.turnId, finished('sub_a'));
    const before = service.eventLog.readSince(AGENT, parent.id, 0).length;

    const result = recoverInterruptedSubagentTails({
      eventLog: service.eventLog,
      conversations: service,
    });

    expect(result).toMatchObject({ conversationsRepaired: 0, childrenTerminalized: 0 });
    expect(service.eventLog.readSince(AGENT, parent.id, 0)).toHaveLength(before);
    expect(service.peekNotifications(parent.id)).toEqual([]);
  });

  it('leaves an interrupted non-subagent turn alone', () => {
    const parent = parentWithOpenTurn();
    service.appendTurnEvent(parent.id, parent.turnId, { type: 'text_delta', text: 'cut off' });
    const before = service.eventLog.readSince(AGENT, parent.id, 0).length;

    expect(
      recoverInterruptedSubagentTails({ eventLog: service.eventLog, conversations: service }),
    ).toMatchObject({ conversationsRepaired: 0, childrenTerminalized: 0 });
    expect(service.eventLog.readSince(AGENT, parent.id, 0)).toHaveLength(before);
  });

  it('only considers the tail after the last terminal marker', () => {
    const parent = parentWithOpenTurn();
    service.appendTurnEvent(parent.id, parent.turnId, started('sub_old'));
    service.finishTurn({
      conversationId: parent.id,
      turnId: parent.turnId,
      outcome: 'completed',
    });
    service.acceptTurn({
      agentId: AGENT,
      conversationId: parent.id,
      turnId: 'turn-second',
      text: 'plain',
    });
    service.appendTurnEvent(parent.id, 'turn-second', { type: 'text_delta', text: 'plain' });

    expect(
      recoverInterruptedSubagentTails({ eventLog: service.eventLog, conversations: service }),
    ).toMatchObject({ conversationsRepaired: 0, childrenTerminalized: 0 });
  });

  it('is idempotent — a second scan appends nothing and queues nothing further', () => {
    const parent = parentWithOpenTurn();
    service.appendTurnEvent(parent.id, parent.turnId, started('sub_a'));

    recoverInterruptedSubagentTails({ eventLog: service.eventLog, conversations: service });
    const afterFirst = service.eventLog.readSince(AGENT, parent.id, 0).length;

    const second = recoverInterruptedSubagentTails({
      eventLog: service.eventLog,
      conversations: service,
    });

    expect(second).toMatchObject({ conversationsRepaired: 0, childrenTerminalized: 0 });
    expect(service.eventLog.readSince(AGENT, parent.id, 0)).toHaveLength(afterFirst);
    expect(service.peekNotifications(parent.id)).toHaveLength(1);
  });

  it('contains a per-conversation failure and still repairs the others', () => {
    const bad = parentWithOpenTurn();
    const ok = parentWithOpenTurn();
    service.appendTurnEvent(bad.id, bad.turnId, started('sub_bad'));
    service.appendTurnEvent(ok.id, ok.turnId, started('sub_ok'));
    // A row the conversations table has never heard of: the enqueue throws.
    service.eventLog.append(AGENT, 'ghost-conversation', 'msg-x', evt(started('sub_ghost')));

    const logged: string[] = [];
    const result = recoverInterruptedSubagentTails({
      eventLog: service.eventLog,
      conversations: service,
      log: (message) => logged.push(message),
    });

    expect(result.childrenTerminalized).toBe(3);
    expect(result.notificationsQueued).toBe(2);
    expect(logged.some((message) => message.includes('ghost-conversation'))).toBe(true);
    expect(service.peekNotifications(ok.id)).toHaveLength(1);
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
      uuid: () => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, '0')}`,
    });
  });

  afterEach(async () => {
    service.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  function subagentInfo(over: Partial<SubagentInfo> = {}): SubagentInfo {
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
      ...over,
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

    expect(result).toMatchObject({ childrenNotified: 1 });
    const queued = service.peekNotifications(parent.id);
    expect(queued).toHaveLength(1);
    expect(queued[0].payload).toMatchObject({
      subagentId: 'sub_a',
      status: 'interrupted',
      subagentType: 'general-purpose',
      description: 'survey the repo',
      toolCallCount: 3,
    });
    expect(service.get('sub_a')?.subagent?.endedAt).toEqual(expect.any(String));
  });

  it('skips a child already finalized on an earlier boot', () => {
    const parent = parentWithChild('sub_a');
    service.updateSubagent('sub_a', {
      status: 'interrupted',
      info: { endedAt: '2026-09-05T00:00:00.000Z' },
    });

    expect(queueInterruptedSubagentNotifications({ conversations: service })).toMatchObject({
      childrenNotified: 0,
    });
    expect(service.peekNotifications(parent.id)).toEqual([]);
  });

  it('does not double-queue when the parent tail step already notified', () => {
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
  });

  it('contains a per-child failure and still notifies the rest', () => {
    // A parent whose notification queue is already at the spec cap: the
    // enqueue for its child throws, and must not stop the other child.
    const full = parentWithChild('sub_full');
    for (let i = 0; i < MAX_QUEUED_NOTIFICATIONS; i++) {
      service.enqueueNotification({
        conversationId: full.id,
        kind: 'subagent_message',
        payload: { from: 'x', message: String(i) },
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
