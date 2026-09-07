import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@dash/agent';
import type { RunSnapshot } from '@dash/swarm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteConversationService } from './conversation-service-sqlite.js';
import { SqliteEventLogStore } from './event-log-store-sqlite.js';
import type { EventLogPayload } from './event-log-store.js';
import { recoverInterruptedSwarmTurns } from './swarm-log-recovery.js';

function canonicalSpawned(workerId: string, runId = 'run-1'): AgentEvent {
  return {
    type: 'worker_spawned',
    workerId,
    runId,
    role: `role-${workerId}`,
    brief: `brief for ${workerId}`,
    model: 'test-model',
  };
}

function canonicalDone(
  workerId: string,
  status: 'done' | 'failed' | 'cancelled' = 'done',
  runId = 'run-1',
): AgentEvent {
  return {
    type: 'worker_done',
    workerId,
    runId,
    role: `role-${workerId}`,
    status,
    report: `report from ${workerId}`,
    usage: { inputTokens: 10, outputTokens: 20 },
  };
}

/**
 * Boot-time recovery for swarm turns a previous gateway process died in
 * the middle of: the event log ends mid-turn with worker_spawned events
 * that never got a worker_done and no done/error stream marker. Recovery
 * appends synthesized terminal events so MC's replay terminalizes the
 * turn, and rebuilds a finalized RunSnapshot for the panel.
 */
describe('recoverInterruptedSwarmTurns', () => {
  let tmpDir: string;
  let store: SqliteEventLogStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'swarm-log-recovery-'));
    store = new SqliteEventLogStore({ dataDir: tmpDir });
  });

  afterEach(async () => {
    store.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  function evt(event: AgentEvent): EventLogPayload {
    return { type: 'event', event };
  }

  function spawned(workerId: string, runId = 'run-1'): AgentEvent {
    return canonicalSpawned(workerId, runId);
  }

  function done(
    workerId: string,
    status: 'done' | 'failed' | 'cancelled' = 'done',
    runId = 'run-1',
  ): AgentEvent {
    return canonicalDone(workerId, status, runId);
  }

  it('synthesizes worker_done(cancelled) for each dangling worker plus one error marker', () => {
    store.append('agent-a', 'conv-1', 'msg-1', evt({ type: 'text_delta', text: 'spawning…' }));
    store.append('agent-a', 'conv-1', 'msg-1', evt(spawned('w-1')));
    store.append('agent-a', 'conv-1', 'msg-1', evt(spawned('w-2')));
    // gateway dies here — no worker_done, no done/error marker

    const result = recoverInterruptedSwarmTurns({ eventLog: store });

    expect(result).toEqual({
      conversationsRepaired: 1,
      workersCancelled: 2,
      canonicalConversationsRepaired: [],
      failedCanonicalConversationIds: [],
    });

    const entries = store.readSince('agent-a', 'conv-1', 3);
    expect(entries).toHaveLength(3);
    // Synthesized terminal worker events, keyed to the interrupted message.
    for (const entry of entries.slice(0, 2)) {
      expect(entry.msgId).toBe('msg-1');
    }
    expect(entries[0].payload).toEqual(
      evt({
        type: 'worker_done',
        workerId: 'w-1',
        runId: 'run-1',
        role: 'role-w-1',
        status: 'cancelled',
        report: 'Gateway restarted while this worker was running.',
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
    );
    expect(entries[1].payload).toMatchObject({
      type: 'event',
      event: { type: 'worker_done', workerId: 'w-2', status: 'cancelled' },
    });
    // One terminal stream marker so replay consumers terminalize the turn.
    expect(entries[2].payload).toEqual({
      type: 'error',
      error:
        'Gateway restarted while this swarm run was in progress — remaining workers were cancelled.',
    });
  });

  it('leaves interrupted non-swarm turns alone', () => {
    store.append('agent-a', 'conv-1', 'msg-1', evt({ type: 'text_delta', text: 'cut off' }));

    const result = recoverInterruptedSwarmTurns({ eventLog: store });

    expect(result).toEqual({
      conversationsRepaired: 0,
      workersCancelled: 0,
      canonicalConversationsRepaired: [],
      failedCanonicalConversationIds: [],
    });
    expect(store.readSince('agent-a', 'conv-1', 0)).toHaveLength(1);
  });

  it('leaves a swarm turn alone when every spawned worker already has a terminal event', () => {
    // A user-cancelled turn: cancelTurn appended worker_done out-of-band,
    // but no done/error marker was ever logged. Must NOT be stamped with a
    // spurious error on the next boot.
    store.append('agent-a', 'conv-1', 'msg-1', evt(spawned('w-1')));
    store.append('agent-a', 'conv-1', 'msg-1', evt(done('w-1', 'cancelled')));

    const result = recoverInterruptedSwarmTurns({ eventLog: store });

    expect(result).toEqual({
      conversationsRepaired: 0,
      workersCancelled: 0,
      canonicalConversationsRepaired: [],
      failedCanonicalConversationIds: [],
    });
    expect(store.readSince('agent-a', 'conv-1', 0)).toHaveLength(2);
  });

  it('only considers the tail after the last terminal marker', () => {
    // Turn 1: a completed swarm turn.
    store.append('agent-a', 'conv-1', 'msg-1', evt(spawned('w-1')));
    store.append('agent-a', 'conv-1', 'msg-1', evt(done('w-1')));
    store.append('agent-a', 'conv-1', 'msg-1', { type: 'done' });
    // Turn 2: interrupted, but no swarm events in it.
    store.append('agent-a', 'conv-1', 'msg-2', evt({ type: 'text_delta', text: 'plain' }));

    const result = recoverInterruptedSwarmTurns({ eventLog: store });

    expect(result).toEqual({
      conversationsRepaired: 0,
      workersCancelled: 0,
      canonicalConversationsRepaired: [],
      failedCanonicalConversationIds: [],
    });
    expect(store.readSince('agent-a', 'conv-1', 0)).toHaveLength(4);
  });

  it('synthesizes only for dangling workers when some workers already finished', () => {
    store.append('agent-a', 'conv-1', 'msg-1', evt(spawned('w-1')));
    store.append('agent-a', 'conv-1', 'msg-1', evt(spawned('w-2')));
    store.append('agent-a', 'conv-1', 'msg-1', evt(done('w-1', 'done')));

    const result = recoverInterruptedSwarmTurns({ eventLog: store });

    expect(result).toEqual({
      conversationsRepaired: 1,
      workersCancelled: 1,
      canonicalConversationsRepaired: [],
      failedCanonicalConversationIds: [],
    });
    const tail = store.readSince('agent-a', 'conv-1', 3);
    expect(tail).toHaveLength(2);
    expect(tail[0].payload).toMatchObject({
      type: 'event',
      event: { type: 'worker_done', workerId: 'w-2', status: 'cancelled' },
    });
    expect(tail[1].payload).toMatchObject({ type: 'error' });
  });

  it('is idempotent — a second boot scan appends nothing further', () => {
    store.append('agent-a', 'conv-1', 'msg-1', evt(spawned('w-1')));

    recoverInterruptedSwarmTurns({ eventLog: store });
    const afterFirst = store.readSince('agent-a', 'conv-1', 0);

    const second = recoverInterruptedSwarmTurns({ eventLog: store });

    expect(second).toEqual({
      conversationsRepaired: 0,
      workersCancelled: 0,
      canonicalConversationsRepaired: [],
      failedCanonicalConversationIds: [],
    });
    expect(store.readSince('agent-a', 'conv-1', 0)).toHaveLength(afterFirst.length);
  });

  it('rebuilds a finalized RunSnapshot for the panel from the logged tail', () => {
    store.append('agent-a', 'conv-1', 'msg-1', evt(spawned('w-1')));
    store.append('agent-a', 'conv-1', 'msg-1', evt(spawned('w-2')));
    store.append('agent-a', 'conv-1', 'msg-1', evt(done('w-1', 'done')));

    const restored: RunSnapshot[] = [];
    recoverInterruptedSwarmTurns({ eventLog: store, restoreRun: (s) => restored.push(s) });

    expect(restored).toHaveLength(1);
    const snap = restored[0];
    expect(snap).toMatchObject({
      runId: 'run-1',
      agentId: 'agent-a',
      conversationId: 'conv-1',
      finalized: true,
      workerCount: 2,
      activeCount: 0,
    });
    expect(snap.startedAt).toBeLessThanOrEqual(snap.endedAt as number);
    expect(snap.workers).toHaveLength(2);
    expect(snap.workers[0]).toMatchObject({
      workerId: 'w-1',
      role: 'role-w-1',
      status: 'done',
      report: 'report from w-1',
      usage: { inputTokens: 10, outputTokens: 20 },
    });
    expect(snap.workers[1]).toMatchObject({
      workerId: 'w-2',
      role: 'role-w-2',
      status: 'cancelled',
      brief: 'brief for w-2',
      model: 'test-model',
      usage: { inputTokens: 0, outputTokens: 0 },
    });
  });

  it('a per-conversation failure is contained and other conversations still recover', () => {
    store.append('agent-a', 'conv-bad', 'msg-1', evt(spawned('w-1')));
    store.append('agent-a', 'conv-ok', 'msg-2', evt(spawned('w-2')));

    const failures: string[] = [];
    const result = recoverInterruptedSwarmTurns({
      eventLog: store,
      restoreRun: (snap) => {
        if (snap.conversationId === 'conv-bad') throw new Error('restore exploded');
      },
      log: (msg) => failures.push(msg),
    });

    // conv-ok repaired; conv-bad's failure logged, not thrown.
    expect(result.conversationsRepaired).toBeGreaterThanOrEqual(1);
    expect(store.readSince('agent-a', 'conv-ok', 1).at(-1)?.payload).toMatchObject({
      type: 'error',
    });
    expect(failures.some((m) => m.includes('restore exploded'))).toBe(true);
  });
});

describe('swarm and canonical conversation recovery ordering', () => {
  let tmpDir: string;
  let service: SqliteConversationService;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'swarm-conversation-recovery-'));
    let id = 0;
    service = new SqliteConversationService({
      dataDir: tmpDir,
      now: () => '2026-07-12T00:00:00.000Z',
      uuid: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
    });
  });

  afterEach(async () => {
    service.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('lets swarm repair append worker terminals before generic recovery reuses its error', () => {
    const conversation = service.create({
      agentId: 'agent-a',
      agentName: 'Swarm Helper',
      requestId: 'create-01',
    });
    service.acceptTurn({
      agentId: 'agent-a',
      conversationId: conversation.id,
      turnId: 'turn-01',
      text: 'Delegate this',
    });
    service.appendTurnEvent(conversation.id, 'turn-01', {
      type: 'worker_spawned',
      workerId: 'worker-01',
      runId: 'run-01',
      role: 'researcher',
      brief: 'Research the answer',
      model: 'test-model',
    });

    expect(recoverInterruptedSwarmTurns({ eventLog: service.eventLog })).toEqual({
      conversationsRepaired: 1,
      workersCancelled: 1,
      canonicalConversationsRepaired: [],
      failedCanonicalConversationIds: [],
    });
    expect(service.recoverInterruptedTurns()).toEqual({
      conversationsInterrupted: 1,
      terminalsAppended: 0,
    });

    const entries = service.eventLog.readSince('agent-a', conversation.id, 0);
    expect(entries.filter((entry) => entry.payload.type === 'error')).toHaveLength(1);
    expect(entries.at(-2)?.payload).toMatchObject({
      type: 'event',
      event: { type: 'worker_done', workerId: 'worker-01', status: 'cancelled' },
    });
    expect(entries.at(-1)?.payload).toMatchObject({ type: 'error' });
    expect(service.get(conversation.id)).toMatchObject({
      status: 'interrupted',
      activeTurnId: null,
      revision: 3,
      lastSeq: entries.at(-1)?.seq,
    });
  });

  it('repairs a canonical worker through the current segment journal and leaves the sole terminal to v2 recovery', () => {
    const conversation = service.create({
      agentId: 'agent-a',
      agentName: 'Canonical Helper',
      requestId: 'create-canonical',
    });
    service.acceptTurn({
      agentId: 'agent-a',
      conversationId: conversation.id,
      turnId: 'outer-run-1',
      text: 'Delegate this canonically',
    });
    service.appendTurnEvent(conversation.id, 'outer-run-1', canonicalSpawned('worker-canonical'));
    const before = service.eventLog.readSince('agent-a', conversation.id, 0).length;

    const recovered = recoverInterruptedSwarmTurns({
      eventLog: service.eventLog,
      canonicalRuns: [
        { agentId: 'agent-a', conversationId: conversation.id, outerRunId: 'outer-run-1' },
      ],
      appendCurrentRunEvent: (agentId, conversationId, outerRunId, event) =>
        service.appendCurrentRunEvent(agentId, conversationId, outerRunId, event),
    });

    expect(recovered).toMatchObject({
      conversationsRepaired: 1,
      workersCancelled: 1,
      canonicalConversationsRepaired: [conversation.id],
      failedCanonicalConversationIds: [],
    });
    const afterSwarm = service.eventLog.readSince('agent-a', conversation.id, before);
    expect(afterSwarm).toHaveLength(1);
    expect(afterSwarm[0]?.payload).toMatchObject({
      type: 'event',
      event: { type: 'worker_done', workerId: 'worker-canonical' },
    });
    expect(afterSwarm.some((entry) => entry.payload.type === 'error')).toBe(false);

    expect(service.recoverV2State()).toMatchObject({
      conversationsInterrupted: 1,
      terminalsAppended: 1,
    });
    expect(
      service.eventLog
        .readSince('agent-a', conversation.id, 0)
        .filter((entry) => entry.payload.type === 'error'),
    ).toHaveLength(1);
  });

  it('never falls back to the legacy journal when a canonical dual append returns null', () => {
    const conversation = service.create({
      agentId: 'agent-a',
      agentName: 'Canonical Helper',
      requestId: 'create-canonical-failure',
    });
    service.acceptTurn({
      agentId: 'agent-a',
      conversationId: conversation.id,
      turnId: 'outer-run-failure',
      text: 'Delegate this canonically',
    });
    service.appendTurnEvent(
      conversation.id,
      'outer-run-failure',
      canonicalSpawned('worker-failure'),
    );
    const legacyAppend = vi.spyOn(service.eventLog, 'append');

    const recovered = recoverInterruptedSwarmTurns({
      eventLog: service.eventLog,
      canonicalRuns: [
        {
          agentId: 'agent-a',
          conversationId: conversation.id,
          outerRunId: 'outer-run-failure',
        },
      ],
      appendCurrentRunEvent: () => null,
    });

    expect(recovered.failedCanonicalConversationIds).toEqual([conversation.id]);
    expect(legacyAppend).not.toHaveBeenCalled();
    expect(service.get(conversation.id)).toMatchObject({
      status: 'running',
      activeTurnId: 'outer-run-failure',
    });
  });

  it('repairs only the active post-compaction, post-Steer segment through both journals', () => {
    const conversation = service.create({
      agentId: 'agent-a',
      agentName: 'Canonical Helper',
      requestId: 'create-compacted',
    });
    const old = service.acceptRun({
      protocol: 'v2',
      agentId: 'agent-a',
      channelId: 'direct',
      conversationId: conversation.id,
      runId: 'outer-old',
      text: 'Old completed run',
    });
    service.appendRunEvent({
      conversationId: conversation.id,
      runId: old.runId,
      segmentTurnId: old.segmentTurnId,
      event: canonicalSpawned('worker-old', 'swarm-old'),
    });
    service.appendRunEvent({
      conversationId: conversation.id,
      runId: old.runId,
      segmentTurnId: old.segmentTurnId,
      event: canonicalDone('worker-old', 'done', 'swarm-old'),
    });
    service.finishRunAndClaimNext({
      conversationId: conversation.id,
      runId: old.runId,
      segmentTurnId: old.segmentTurnId,
      outcome: 'completed',
      suppressPromotion: true,
    });

    const active = service.acceptRun({
      protocol: 'v2',
      agentId: 'agent-a',
      channelId: 'direct',
      conversationId: conversation.id,
      runId: 'outer-active',
      text: 'Active canonical run',
    });
    service.enqueueInput({
      commandId: 'command-steer-recovery',
      inputId: 'input-steer-recovery',
      agentId: 'agent-a',
      channelId: 'direct',
      conversationId: conversation.id,
      text: 'Continue on a later segment',
      behavior: 'steer',
      expectedActiveTurnId: active.runId,
    });
    const steer = service.deliverSteer({
      conversationId: conversation.id,
      runId: active.runId,
      inputId: 'input-steer-recovery',
    });
    service.appendRunEvent({
      conversationId: conversation.id,
      runId: active.runId,
      segmentTurnId: steer.segmentTurnId,
      event: canonicalSpawned('worker-active', 'swarm-active'),
    });

    const recovered = recoverInterruptedSwarmTurns({
      eventLog: service.eventLog,
      canonicalRuns: [
        { agentId: 'agent-a', conversationId: conversation.id, outerRunId: active.runId },
      ],
      appendCurrentRunEvent: (agentId, conversationId, outerRunId, event) =>
        service.appendCurrentRunEvent(agentId, conversationId, outerRunId, event),
    });

    expect(recovered).toMatchObject({
      workersCancelled: 1,
      canonicalConversationsRepaired: [conversation.id],
      failedCanonicalConversationIds: [],
    });
    const repaired = service.eventLog.readSince('agent-a', conversation.id, 0).at(-1);
    expect(repaired).toMatchObject({
      msgId: active.runId,
      segmentTurnId: steer.segmentTurnId,
      payload: {
        type: 'event',
        event: { type: 'worker_done', workerId: 'worker-active', runId: 'swarm-active' },
      },
    });
    expect(
      service.eventLog
        .readSince('agent-a', conversation.id, 0)
        .filter(
          (entry) =>
            entry.payload.type === 'event' &&
            entry.payload.event.type === 'worker_done' &&
            entry.payload.event.workerId === 'worker-old',
        ),
    ).toHaveLength(1);
  });

  it('retries only missing canonical worker repairs after a partial dual-journal append', () => {
    const conversation = service.create({
      agentId: 'agent-a',
      agentName: 'Canonical Helper',
      requestId: 'create-partial',
    });
    const active = service.acceptRun({
      protocol: 'v2',
      agentId: 'agent-a',
      channelId: 'direct',
      conversationId: conversation.id,
      runId: 'outer-partial',
      text: 'Repair two workers',
    });
    for (const workerId of ['worker-one', 'worker-two']) {
      service.appendRunEvent({
        conversationId: conversation.id,
        runId: active.runId,
        segmentTurnId: active.segmentTurnId,
        event: canonicalSpawned(workerId, 'swarm-partial'),
      });
    }
    let failSecond = true;
    const appendCurrentRunEvent = vi.fn(
      (agentId: string, conversationId: string, outerRunId: string, event: AgentEvent) => {
        if (failSecond && event.type === 'worker_done' && event.workerId === 'worker-two') {
          return null;
        }
        return service.appendCurrentRunEvent(agentId, conversationId, outerRunId, event);
      },
    );
    const options = {
      eventLog: service.eventLog,
      canonicalRuns: [
        { agentId: 'agent-a', conversationId: conversation.id, outerRunId: active.runId },
      ],
      appendCurrentRunEvent,
    };

    const first = recoverInterruptedSwarmTurns(options);
    expect(first.failedCanonicalConversationIds).toEqual([conversation.id]);
    expect(service.get(conversation.id)).toMatchObject({
      status: 'running',
      activeTurnId: active.runId,
    });
    expect(
      service.eventLog
        .readSince('agent-a', conversation.id, 0)
        .filter(
          (entry) => entry.payload.type === 'event' && entry.payload.event.type === 'worker_done',
        )
        .map((entry) =>
          entry.payload.type === 'event' && entry.payload.event.type === 'worker_done'
            ? entry.payload.event.workerId
            : '',
        ),
    ).toEqual(['worker-one']);

    failSecond = false;
    const second = recoverInterruptedSwarmTurns(options);
    expect(second).toMatchObject({
      workersCancelled: 1,
      canonicalConversationsRepaired: [conversation.id],
      failedCanonicalConversationIds: [],
    });
    expect(
      appendCurrentRunEvent.mock.calls.filter(
        (call) => call[3].type === 'worker_done' && call[3].workerId === 'worker-one',
      ),
    ).toHaveLength(1);

    expect(service.recoverV2State()).toMatchObject({
      conversationsInterrupted: 1,
      terminalsAppended: 1,
    });
    const afterTerminal = service.eventLog.readSince('agent-a', conversation.id, 0);
    expect(afterTerminal.filter((entry) => entry.payload.type === 'error')).toHaveLength(1);
    expect(recoverInterruptedSwarmTurns(options)).toMatchObject({
      workersCancelled: 0,
      failedCanonicalConversationIds: [],
    });
    expect(service.eventLog.readSince('agent-a', conversation.id, 0)).toHaveLength(
      afterTerminal.length,
    );
  });

  it('restores a canonical active run whose workers are already terminal before the sole terminal', () => {
    const conversation = service.create({
      agentId: 'agent-a',
      agentName: 'Canonical Helper',
      requestId: 'create-terminal-workers',
    });
    const active = service.acceptRun({
      protocol: 'v2',
      agentId: 'agent-a',
      channelId: 'direct',
      conversationId: conversation.id,
      runId: 'outer-terminal-workers',
      text: 'Workers already settled',
    });
    service.appendRunEvent({
      conversationId: conversation.id,
      runId: active.runId,
      segmentTurnId: active.segmentTurnId,
      event: canonicalSpawned('worker-done', 'swarm-terminal-workers'),
    });
    service.appendRunEvent({
      conversationId: conversation.id,
      runId: active.runId,
      segmentTurnId: active.segmentTurnId,
      event: canonicalDone('worker-done', 'done', 'swarm-terminal-workers'),
    });
    const restoreRun = vi.fn();

    const repaired = recoverInterruptedSwarmTurns({
      eventLog: service.eventLog,
      canonicalRuns: [
        { agentId: 'agent-a', conversationId: conversation.id, outerRunId: active.runId },
      ],
      appendCurrentRunEvent: (agentId, conversationId, outerRunId, event) =>
        service.appendCurrentRunEvent(agentId, conversationId, outerRunId, event),
      restoreRun,
    });

    expect(repaired).toMatchObject({
      workersCancelled: 0,
      canonicalConversationsRepaired: [conversation.id],
      failedCanonicalConversationIds: [],
    });
    expect(restoreRun).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: conversation.id, finalized: true }),
    );
    expect(service.get(conversation.id)).toMatchObject({ status: 'running' });
    expect(service.recoverV2State()).toMatchObject({ terminalsAppended: 1 });
    expect(
      service.eventLog
        .readSince('agent-a', conversation.id, 0)
        .filter((entry) => entry.payload.type === 'error'),
    ).toHaveLength(1);
  });
});
