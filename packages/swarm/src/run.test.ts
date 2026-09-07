import { SwarmRun } from './run.js';
import type { WorkerBackend } from './types.js';

const caps = {
  maxConcurrentWorkers: 8,
  maxWorkersPerRun: 24,
  maxSteersPerWorker: 10,
  maxRunSeconds: 1_800,
};

describe('SwarmRun finalization lifecycle', () => {
  it('publishes one stable finalization promise before orchestrator abort can re-enter', async () => {
    let nested: Promise<unknown> | undefined;
    let didReenter = false;
    const orchestratorAbort = vi.fn(() => {
      if (didReenter) return;
      didReenter = true;
      nested = run.finalize('reentrant finalization');
    });
    const run = new SwarmRun({
      runId: 'run-1',
      agentId: 'agent-1',
      conversationId: 'conversation-1',
      caps,
      orchestratorAbort,
    });

    const outer = run.finalize('consumer gone');

    expect(nested).toBe(outer);
    await expect(outer).resolves.toEqual([]);
    expect(orchestratorAbort).toHaveBeenCalledOnce();
    expect(run.finalized).toBe(true);
    expect(run.closed.aborted).toBe(true);
  });

  it('contains a throwing wall-clock abort and exposes one awaited cleanup settlement', async () => {
    vi.useFakeTimers();
    try {
      const workerAbort = Promise.withResolvers<void>();
      const workerStop = Promise.withResolvers<void>();
      const backend: WorkerBackend = {
        async *chat() {
          await workerAbort.promise;
          yield* [];
        },
        abort: vi.fn(() => workerAbort.resolve()),
        stop: vi.fn(() => workerStop.promise),
      };
      const orchestratorAbort = vi.fn(() => {
        throw new Error('orchestrator abort failed');
      });
      const run = new SwarmRun({
        runId: 'run-wall-clock',
        agentId: 'agent-1',
        conversationId: 'conversation-1',
        caps: { ...caps, maxRunSeconds: 1 },
        orchestratorAbort,
      });
      run.register(
        {
          spec: {
            agentId: 'agent-1',
            agentName: 'Agent One',
            runId: 'run-wall-clock',
            workerId: 'worker-1',
            role: 'researcher',
            brief: 'investigate',
            model: 'test-model',
            workspace: '/tmp/workspace',
            tools: [],
          },
        },
        async () => backend,
      );
      await Promise.resolve();
      await Promise.resolve();

      await vi.advanceTimersByTimeAsync(1_000);

      expect(orchestratorAbort).toHaveBeenCalledOnce();
      expect(run.finalized).toBe(true);
      expect(run.closed.aborted).toBe(true);
      expect(backend.abort).toHaveBeenCalledOnce();
      expect(backend.stop).toHaveBeenCalledOnce();

      const first = run.finalize('join wall-clock finalization');
      const second = run.finalize('join again');
      expect(second).toBe(first);
      let settled = false;
      void first.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await Promise.resolve();
      expect(settled).toBe(false);

      workerStop.resolve();
      await expect(first).rejects.toThrow('orchestrator abort failed');
      expect(backend.stop).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
