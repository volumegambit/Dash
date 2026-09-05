import { DEFAULT_SUBAGENT_TYPE, legacyWorkerDoneStatus } from './subagent-status.js';

/**
 * The legacy `worker_done` mirror is the only terminal event the shipped iOS
 * and Mission Control decoders understand, and they know exactly three
 * statuses. A newer status leaking through to them decodes as nothing at all,
 * which is a card that never terminalizes in a client nobody can hot-fix.
 */
describe('legacyWorkerDoneStatus', () => {
  it('passes the three statuses the iOS / Mission Control decoders understand', () => {
    expect(legacyWorkerDoneStatus('done')).toBe('done');
    expect(legacyWorkerDoneStatus('failed')).toBe('failed');
    expect(legacyWorkerDoneStatus('cancelled')).toBe('cancelled');
  });

  it('maps the newer terminal statuses onto failed for legacy decoders', () => {
    expect(legacyWorkerDoneStatus('interrupted')).toBe('failed');
    expect(legacyWorkerDoneStatus('max_turns')).toBe('failed');
  });

  it('names the type a caller who named none gets', () => {
    expect(DEFAULT_SUBAGENT_TYPE).toBe('general-purpose');
  });
});
