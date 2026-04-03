import { describe, expect, it, vi } from 'vitest';
import { pushCredentialsWithRetry } from './credential-push-retry.js';

describe('credential push retry', () => {
  it('retries failed pushes up to 3 times with backoff', async () => {
    const pushFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('agent busy'))
      .mockRejectedValueOnce(new Error('agent busy'))
      .mockResolvedValueOnce({ total: 1, succeeded: 1, failed: [] });

    const result = await pushCredentialsWithRetry(pushFn, { delays: [10, 20, 40] });
    expect(pushFn).toHaveBeenCalledTimes(3);
    expect(result.succeeded).toBe(1);
  });

  it('returns failure after all retries exhausted', async () => {
    const pushFn = vi.fn().mockRejectedValue(new Error('permanently broken'));

    const result = await pushCredentialsWithRetry(pushFn, { delays: [10, 20, 40] });
    expect(pushFn).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
    expect(result.failed.length).toBeGreaterThan(0);
  });
});
