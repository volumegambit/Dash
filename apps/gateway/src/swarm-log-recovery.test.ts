import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@dash/agent';
import type { RunSnapshot } from '@dash/swarm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteConversationService } from './conversation-service-sqlite.js';
import { SqliteEventLogStore } from './event-log-store-sqlite.js';
import type { EventLogPayload } from './event-log-store.js';
import { recoverInterruptedSwarmTurns } from './swarm-log-recovery.js';

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
    return {
      type: 'worker_spawned',
      workerId,
      runId,
      role: `role-${workerId}`,
      brief: `brief for ${workerId}`,
      model: 'test-model',
    };
  }

  function done(
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

  it('synthesizes worker_done(cancelled) for each dangling worker plus one error marker', () => {
    store.append('agent-a', 'conv-1', 'msg-1', evt({ type: 'text_delta', text: 'spawning…' }));
    store.append('agent-a', 'conv-1', 'msg-1', evt(spawned('w-1')));
    store.append('agent-a', 'conv-1', 'msg-1', evt(spawned('w-2')));
    // gateway dies here — no worker_done, no done/error marker

    const result = recoverInterruptedSwarmTurns({ eventLog: store });

    expect(result).toEqual({ conversationsRepaired: 1, workersCancelled: 2 });

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

    expect(result).toEqual({ conversationsRepaired: 0, workersCancelled: 0 });
    expect(store.readSince('agent-a', 'conv-1', 0)).toHaveLength(1);
  });

  it('leaves a swarm turn alone when every spawned worker already has a terminal event', () => {
    // A user-cancelled turn: cancelTurn appended worker_done out-of-band,
    // but no done/error marker was ever logged. Must NOT be stamped with a
    // spurious error on the next boot.
    store.append('agent-a', 'conv-1', 'msg-1', evt(spawned('w-1')));
    store.append('agent-a', 'conv-1', 'msg-1', evt(done('w-1', 'cancelled')));

    const result = recoverInterruptedSwarmTurns({ eventLog: store });

    expect(result).toEqual({ conversationsRepaired: 0, workersCancelled: 0 });
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

    expect(result).toEqual({ conversationsRepaired: 0, workersCancelled: 0 });
    expect(store.readSince('agent-a', 'conv-1', 0)).toHaveLength(4);
  });

  it('synthesizes only for dangling workers when some workers already finished', () => {
    store.append('agent-a', 'conv-1', 'msg-1', evt(spawned('w-1')));
    store.append('agent-a', 'conv-1', 'msg-1', evt(spawned('w-2')));
    store.append('agent-a', 'conv-1', 'msg-1', evt(done('w-1', 'done')));

    const result = recoverInterruptedSwarmTurns({ eventLog: store });

    expect(result).toEqual({ conversationsRepaired: 1, workersCancelled: 1 });
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

    expect(second).toEqual({ conversationsRepaired: 0, workersCancelled: 0 });
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
});
