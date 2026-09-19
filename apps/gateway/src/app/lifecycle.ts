import { safeStep } from '../shutdown.js';

/** Dependencies remain available until work using them has settled. */
export const STOP_ORDER = {
  execution: 0,
  subscriptions: 10,
  relay: 20,
  dialTokens: 21,
  mcp: 30,
  maintenance: 40,
  swarm: 50,
  runtimes: 60,
  channels: 70,
  listeners: 80,
  databases: 90,
} as const;

export function createGatewayLifecycle() {
  const steps: Array<{ name: string; order: number; close: () => unknown | Promise<unknown> }> = [];
  let stopping = false;
  let completion: Promise<void> | undefined;
  return {
    add(name: string, order: number, close: () => unknown | Promise<unknown>): void {
      if (stopping) throw new Error('HQ is stopping; cannot register resources');
      steps.push({ name, order, close });
    },
    stop(): Promise<void> {
      if (completion) return completion;
      stopping = true;
      completion = (async () => {
        for (const step of steps.sort((a, b) => a.order - b.order)) {
          await safeStep(step.name, step.close);
        }
      })();
      return completion;
    },
  };
}
