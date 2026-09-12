/**
 * Deprecated compatibility path. The child runtime now lives in
 * `subagent-wiring.ts`; keeping this re-export avoids breaking older imports
 * without retaining the retired in-process WorkerFactory lifetime.
 */
export * from './subagent-wiring.js';
