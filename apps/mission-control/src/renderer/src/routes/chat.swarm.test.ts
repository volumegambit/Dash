import { describe, expect, it } from 'vitest';
import type { McAgentEvent } from '../../../shared/ipc.js';
import {
  type WorkerGroup,
  deriveWorkerStatus,
  groupWorkerEvents,
  isTerminalStatus,
  latestWorkerDetail,
  summarizeSwarmStrip,
} from './chat.swarm.js';

// --- Event builders (keep tests terse + type-safe) ---

function spawned(workerId: string, role = 'coder', model = 'anthropic/claude'): McAgentEvent {
  return { type: 'worker_spawned', workerId, runId: 'run-1', role, brief: `${role} brief`, model };
}

function status(
  workerId: string,
  status: 'running' | 'waiting_input',
  extra: { role?: string; detail?: string; question?: string } = {},
): McAgentEvent {
  return {
    type: 'worker_status',
    workerId,
    runId: 'run-1',
    role: extra.role ?? 'coder',
    status,
    detail: extra.detail,
    question: extra.question,
  };
}

function done(
  workerId: string,
  status: 'done' | 'failed' | 'cancelled',
  extra: {
    role?: string;
    report?: string;
    usage?: { inputTokens: number; outputTokens: number };
  } = {},
): McAgentEvent {
  return {
    type: 'worker_done',
    workerId,
    runId: 'run-1',
    role: extra.role ?? 'coder',
    status,
    report: extra.report ?? 'report',
    usage: extra.usage,
  };
}

const text = (t: string): McAgentEvent => ({ type: 'text_delta', text: t });

function asRecords(events: McAgentEvent[]): Record<string, unknown>[] {
  return events as unknown as Record<string, unknown>[];
}

describe('groupWorkerEvents', () => {
  it('returns an empty map when there are no worker events', () => {
    const groups = groupWorkerEvents(asRecords([text('hi'), text(' there')]));
    expect(groups.size).toBe(0);
  });

  it('groups spawn + status + done by workerId', () => {
    const events = [
      spawned('w1', 'coder'),
      status('w1', 'running', { detail: 'reading files' }),
      done('w1', 'done', { report: '# done' }),
    ];
    const groups = groupWorkerEvents(asRecords(events));
    expect(groups.size).toBe(1);
    const g = groups.get('w1') as WorkerGroup;
    expect(g.role).toBe('coder');
    expect(g.model).toBe('anthropic/claude');
    expect(g.spawned?.type).toBe('worker_spawned');
    expect(g.statuses).toHaveLength(1);
    expect(g.done?.status).toBe('done');
    expect(g.orphan).toBe(false);
    expect(g.anchorIndex).toBe(0); // anchors at the spawn position
  });

  it('separates multiple workers and preserves first-seen order', () => {
    const events = [
      spawned('w1', 'coder'),
      spawned('w2', 'reviewer'),
      status('w1', 'running'),
      status('w2', 'running'),
      done('w2', 'done'),
      done('w1', 'done'),
    ];
    const groups = groupWorkerEvents(asRecords(events));
    expect([...groups.keys()]).toEqual(['w1', 'w2']);
    expect(groups.get('w1')?.anchorIndex).toBe(0);
    expect(groups.get('w2')?.anchorIndex).toBe(1);
  });

  it('anchors the card at the spawn position even when text is interleaved', () => {
    const events = [
      text('Let me spawn some workers.'),
      spawned('w1', 'coder'),
      text('meanwhile...'),
      status('w1', 'running', { detail: 'step 1' }),
      text('more prose'),
      done('w1', 'done'),
    ];
    const groups = groupWorkerEvents(asRecords(events));
    const g = groups.get('w1') as WorkerGroup;
    expect(g.anchorIndex).toBe(1);
    expect(g.statuses).toHaveLength(1);
    expect(g.done).toBeDefined();
    expect(g.orphan).toBe(false);
  });

  it('marks a terminal-only group (no spawn in this message) as an orphan', () => {
    // Crash-reconcile: the done event lands in a message with no spawn.
    const events = [text('resuming…'), done('w9', 'done', { role: 'researcher' })];
    const groups = groupWorkerEvents(asRecords(events));
    const g = groups.get('w9') as WorkerGroup;
    expect(g.orphan).toBe(true);
    expect(g.role).toBe('researcher'); // sourced from the self-describing event
    expect(g.anchorIndex).toBe(1);
    expect(g.spawned).toBeUndefined();
  });

  it('de-orphans a group if a spawn arrives after a status', () => {
    // Out-of-order arrival: status seen before spawn in the same message.
    const events = [status('w1', 'running'), spawned('w1', 'coder')];
    const groups = groupWorkerEvents(asRecords(events));
    const g = groups.get('w1') as WorkerGroup;
    expect(g.orphan).toBe(false);
    expect(g.anchorIndex).toBe(1); // re-anchors to the spawn position
  });
});

describe('deriveWorkerStatus', () => {
  function group(events: McAgentEvent[]): WorkerGroup {
    return groupWorkerEvents(asRecords(events)).values().next().value as WorkerGroup;
  }

  it('returns the terminal done status verbatim', () => {
    expect(deriveWorkerStatus(group([spawned('w1'), done('w1', 'done')]), true)).toBe('done');
    expect(deriveWorkerStatus(group([spawned('w1'), done('w1', 'failed')]), true)).toBe('failed');
    expect(deriveWorkerStatus(group([spawned('w1'), done('w1', 'cancelled')]), true)).toBe(
      'cancelled',
    );
  });

  it('reflects the latest status while streaming', () => {
    expect(deriveWorkerStatus(group([spawned('w1'), status('w1', 'running')]), true)).toBe(
      'running',
    );
    expect(
      deriveWorkerStatus(
        group([spawned('w1'), status('w1', 'running'), status('w1', 'waiting_input')]),
        true,
      ),
    ).toBe('waiting');
  });

  it('defaults to running for a bare spawn while streaming', () => {
    expect(deriveWorkerStatus(group([spawned('w1')]), true)).toBe('running');
  });

  it('terminalizes a non-terminal group to cancelled when the stream has ended', () => {
    expect(deriveWorkerStatus(group([spawned('w1'), status('w1', 'running')]), false)).toBe(
      'cancelled',
    );
    // Even a waiting_input group becomes cancelled once the stream ends.
    expect(deriveWorkerStatus(group([spawned('w1'), status('w1', 'waiting_input')]), false)).toBe(
      'cancelled',
    );
  });

  it('keeps a terminal done status even when not streaming', () => {
    expect(deriveWorkerStatus(group([spawned('w1'), done('w1', 'done')]), false)).toBe('done');
  });
});

describe('isTerminalStatus', () => {
  it('classifies terminal vs non-terminal statuses', () => {
    expect(isTerminalStatus('done')).toBe(true);
    expect(isTerminalStatus('failed')).toBe(true);
    expect(isTerminalStatus('cancelled')).toBe(true);
    expect(isTerminalStatus('running')).toBe(false);
    expect(isTerminalStatus('waiting')).toBe(false);
  });
});

describe('latestWorkerDetail', () => {
  function group(events: McAgentEvent[]): WorkerGroup {
    return groupWorkerEvents(asRecords(events)).values().next().value as WorkerGroup;
  }

  it('returns the newest status detail', () => {
    const g = group([
      spawned('w1'),
      status('w1', 'running', { detail: 'step 1' }),
      status('w1', 'running', { detail: 'step 2' }),
    ]);
    expect(latestWorkerDetail(g)).toBe('step 2');
  });

  it('prefers the question when waiting on input', () => {
    const g = group([
      spawned('w1'),
      status('w1', 'running', { detail: 'step 1' }),
      status('w1', 'waiting_input', { question: 'Which path?' }),
    ]);
    expect(latestWorkerDetail(g)).toBe('Which path?');
  });

  it('falls back to the brief when there are no status details', () => {
    const g = group([spawned('w1', 'coder')]);
    expect(latestWorkerDetail(g)).toBe('coder brief');
  });
});

describe('summarizeSwarmStrip', () => {
  it('returns null when there are no worker groups', () => {
    expect(summarizeSwarmStrip([text('hi')], true)).toBeNull();
  });

  it('returns null when all workers are terminal', () => {
    const events = [spawned('w1'), done('w1', 'done'), spawned('w2'), done('w2', 'failed')];
    expect(summarizeSwarmStrip(events, true)).toBeNull();
  });

  it('summarizes mixed running / waiting / done workers', () => {
    const events = [
      spawned('w1', 'coder'),
      status('w1', 'running'),
      spawned('w2', 'reviewer'),
      status('w2', 'waiting_input'),
      spawned('w3', 'researcher'),
      done('w3', 'done'),
    ];
    const summary = summarizeSwarmStrip(events, true);
    expect(summary).not.toBeNull();
    expect(summary?.total).toBe(3);
    expect(summary?.running).toBe(1);
    expect(summary?.waiting).toBe(1);
    expect(summary?.workers.map((w) => w.status)).toEqual(['running', 'waiting', 'done']);
  });

  it('ignores orphan terminal groups (finished work from a prior message)', () => {
    // Only an orphan done → nothing live to pin.
    const events = [done('w1', 'done')];
    expect(summarizeSwarmStrip(events, true)).toBeNull();
  });

  it('still returns null once the stream ends (everything terminalizes)', () => {
    const events = [spawned('w1'), status('w1', 'running')];
    // While streaming, this is a live running worker.
    expect(summarizeSwarmStrip(events, true)?.running).toBe(1);
    // Once streaming ends, the group terminalizes to cancelled → nothing to pin.
    expect(summarizeSwarmStrip(events, false)).toBeNull();
  });
});
