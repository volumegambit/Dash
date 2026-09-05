import type { WorkerStatus } from './types.js';

/** The default subagent type when a caller names none. */
export const DEFAULT_SUBAGENT_TYPE = 'general-purpose';

/**
 * The legacy `worker_done` event is a MIRROR of `subagent_finished` kept for the
 * iOS app and Mission Control, whose decoders only understand
 * `done | failed | cancelled`. Until those clients migrate, the newer terminal
 * statuses (`interrupted`, `max_turns`) are reported to them as `failed`; the
 * true status rides `subagent_finished.status`.
 */
export function legacyWorkerDoneStatus(status: WorkerStatus): 'done' | 'failed' | 'cancelled' {
  if (status === 'done' || status === 'cancelled') return status;
  return 'failed';
}
