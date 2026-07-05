import type { SwarmRunSummary, SwarmRunWorkerSnapshot } from '@dash/management';
import { describe, expect, it } from 'vitest';
import {
  formatElapsed,
  formatTokens,
  isRunLive,
  isRunTerminal,
  isWorkerTerminal,
  parseAllowedModels,
  parsePositiveInt,
  sortRuns,
  workerElapsedMs,
  workerStatusLabel,
  workerTotalTokens,
} from './SwarmPanel.helpers.js';

function run(over: Partial<SwarmRunSummary>): SwarmRunSummary {
  return {
    runId: 'run-1',
    agentId: 'agent-1',
    conversationId: 'conv-1',
    startedAt: 1000,
    finalized: false,
    workerCount: 0,
    activeCount: 0,
    ...over,
  };
}

function worker(over: Partial<SwarmRunWorkerSnapshot>): SwarmRunWorkerSnapshot {
  return {
    workerId: 'w1',
    role: 'coder',
    status: 'running',
    brief: 'do the thing',
    model: 'anthropic/claude',
    usage: { inputTokens: 0, outputTokens: 0 },
    ...over,
  };
}

describe('isRunTerminal / isRunLive', () => {
  it('a finalized run is terminal and not live', () => {
    const r = run({ finalized: true });
    expect(isRunTerminal(r)).toBe(true);
    expect(isRunLive(r)).toBe(false);
  });

  it('a non-finalized run is live', () => {
    const r = run({ finalized: false });
    expect(isRunTerminal(r)).toBe(false);
    expect(isRunLive(r)).toBe(true);
  });

  it('null/undefined is not live', () => {
    expect(isRunLive(null)).toBe(false);
    expect(isRunLive(undefined)).toBe(false);
  });
});

describe('isWorkerTerminal', () => {
  it('done / failed / cancelled are terminal', () => {
    expect(isWorkerTerminal('done')).toBe(true);
    expect(isWorkerTerminal('failed')).toBe(true);
    expect(isWorkerTerminal('cancelled')).toBe(true);
  });
  it('spawning / running / waiting_input are not terminal', () => {
    expect(isWorkerTerminal('spawning')).toBe(false);
    expect(isWorkerTerminal('running')).toBe(false);
    expect(isWorkerTerminal('waiting_input')).toBe(false);
  });
});

describe('sortRuns', () => {
  it('puts live runs before finalized ones, newest first within a group', () => {
    const runs = [
      run({ runId: 'old-live', startedAt: 100, finalized: false }),
      run({ runId: 'finished-new', startedAt: 500, finalized: true }),
      run({ runId: 'new-live', startedAt: 400, finalized: false }),
      run({ runId: 'finished-old', startedAt: 200, finalized: true }),
    ];
    expect(sortRuns(runs).map((r) => r.runId)).toEqual([
      'new-live',
      'old-live',
      'finished-new',
      'finished-old',
    ]);
  });

  it('does not mutate the input array', () => {
    const runs = [run({ runId: 'a', startedAt: 1 }), run({ runId: 'b', startedAt: 2 })];
    const copy = [...runs];
    sortRuns(runs);
    expect(runs).toEqual(copy);
  });
});

describe('workerElapsedMs', () => {
  it('uses endedAt - startedAt when both known', () => {
    expect(workerElapsedMs(worker({ startedAt: 1000, endedAt: 4000 }), 9999)).toBe(3000);
  });
  it('uses now - startedAt for a running worker', () => {
    expect(workerElapsedMs(worker({ startedAt: 1000, endedAt: undefined }), 6000)).toBe(5000);
  });
  it('returns undefined when the worker has not started', () => {
    expect(workerElapsedMs(worker({ startedAt: undefined }), 6000)).toBeUndefined();
  });
  it('clamps clock skew to zero', () => {
    expect(workerElapsedMs(worker({ startedAt: 5000, endedAt: 4000 }), 9999)).toBe(0);
  });
});

describe('formatElapsed', () => {
  it('renders seconds only under a minute', () => {
    expect(formatElapsed(12_000)).toBe('12s');
    expect(formatElapsed(0)).toBe('0s');
  });
  it('renders minutes and zero-padded seconds', () => {
    expect(formatElapsed(184_000)).toBe('3m 04s');
  });
  it('renders hours and zero-padded minutes', () => {
    expect(formatElapsed(3_720_000)).toBe('1h 02m');
  });
  it('renders an em dash for undefined', () => {
    expect(formatElapsed(undefined)).toBe('—');
  });
});

describe('workerTotalTokens / formatTokens', () => {
  it('sums input and output tokens', () => {
    expect(workerTotalTokens({ inputTokens: 100, outputTokens: 42 })).toBe(142);
  });
  it('formats compactly', () => {
    expect(formatTokens(842)).toBe('842');
    expect(formatTokens(12_345)).toBe('12.3k');
    expect(formatTokens(1_250_000)).toBe('1.3M');
  });
});

describe('workerStatusLabel', () => {
  it('maps each status to a human label', () => {
    expect(workerStatusLabel('waiting_input')).toBe('Waiting');
    expect(workerStatusLabel('spawning')).toBe('Spawning');
    expect(workerStatusLabel('cancelled')).toBe('Cancelled');
  });
});

describe('parseAllowedModels', () => {
  it('trims, drops blanks, and de-duplicates preserving order', () => {
    expect(parseAllowedModels(' a , b ,, a, c ')).toEqual(['a', 'b', 'c']);
  });
  it('returns an empty array for a blank input', () => {
    expect(parseAllowedModels('   ,  ,')).toEqual([]);
    expect(parseAllowedModels('')).toEqual([]);
  });
});

describe('parsePositiveInt', () => {
  it('parses a positive integer', () => {
    expect(parsePositiveInt('8')).toBe(8);
    expect(parsePositiveInt('  24  ')).toBe(24);
  });
  it('returns undefined for blank / zero / negative / non-integer / non-numeric', () => {
    expect(parsePositiveInt('')).toBeUndefined();
    expect(parsePositiveInt('0')).toBeUndefined();
    expect(parsePositiveInt('-3')).toBeUndefined();
    expect(parsePositiveInt('2.5')).toBeUndefined();
    expect(parsePositiveInt('abc')).toBeUndefined();
  });
});
