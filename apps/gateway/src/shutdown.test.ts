import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeError, redactBotTokens, safeStep, withTimeout } from './shutdown.js';

describe('redactBotTokens', () => {
  it('redacts a Telegram bot token embedded in a URL', () => {
    const msg =
      'request to https://api.telegram.org/bot7212121212:AAE-abcDEF_ghi123JKLmno456pqr789stU/getUpdates failed, reason: connect ETIMEDOUT';
    const redacted = redactBotTokens(msg);
    expect(redacted).not.toContain('AAE-abcDEF_ghi123JKLmno456pqr789stU');
    expect(redacted).toContain('bot7212121212:<redacted>');
    expect(redacted).toContain('/getUpdates');
  });

  it('leaves text without tokens unchanged', () => {
    const msg = 'Network request for getUpdates failed';
    expect(redactBotTokens(msg)).toBe(msg);
  });
});

describe('describeError', () => {
  it('uses the stack when available and redacts tokens in it', () => {
    const err = new Error(
      'request to https://api.telegram.org/bot123456:secretTOKENvalue-here_0/getUpdates failed',
    );
    const out = describeError(err);
    expect(out).not.toContain('secretTOKENvalue-here_0');
    expect(out).toContain('bot123456:<redacted>');
  });

  it('stringifies non-Error values', () => {
    expect(describeError('boom')).toBe('boom');
  });
});

describe('safeStep', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs the step and resolves on success', async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    await safeStep('gateway.stop', fn);
    expect(fn).toHaveBeenCalled();
  });

  it('resolves and logs when an async step rejects', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      safeStep('gateway.stop', () => Promise.reject(new Error('network down'))),
    ).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('gateway.stop'),
      expect.stringContaining('network down'),
    );
  });

  it('resolves and logs when a sync step throws', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      safeStep('db.close', () => {
        throw new Error('already closed');
      }),
    ).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
  });

  it('redacts bot tokens from the logged failure', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await safeStep('gateway.stop', () =>
      Promise.reject(
        new Error(
          'request to https://api.telegram.org/bot99:SsEeCcRrEeTt-token_9/getUpdates failed',
        ),
      ),
    );
    const logged = errorSpy.mock.calls.flat().join(' ');
    expect(logged).not.toContain('SsEeCcRrEeTt-token_9');
    expect(logged).toContain('bot99:<redacted>');
  });
});

describe('withTimeout', () => {
  it('resolves with the value when the promise settles in time', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1000, 'fast op')).resolves.toBe('ok');
  });

  it('rejects with the original error when the promise rejects in time', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 1000, 'op')).rejects.toThrow(
      'boom',
    );
  });

  it('rejects with a labeled timeout error when the promise hangs', async () => {
    vi.useFakeTimers();
    try {
      const hang = new Promise(() => {});
      const raced = withTimeout(hang, 5000, 'adapter stop for channel "tg1"');
      const assertion = expect(raced).rejects.toThrow(
        'adapter stop for channel "tg1" timed out after 5000ms',
      );
      await vi.advanceTimersByTimeAsync(5000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
