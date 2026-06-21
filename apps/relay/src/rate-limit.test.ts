import { RateLimiter, TokenBucket } from './rate-limit.js';

describe('TokenBucket', () => {
  it('allows up to capacity, then rejects (burst)', () => {
    const b = new TokenBucket(3, 1, 0);
    expect(b.tryRemove(0)).toBe(true);
    expect(b.tryRemove(0)).toBe(true);
    expect(b.tryRemove(0)).toBe(true);
    expect(b.tryRemove(0)).toBe(false); // 4th in the same instant — empty
  });

  it('refills over elapsed time', () => {
    const b = new TokenBucket(2, 1, 0); // 1 token/sec
    expect(b.tryRemove(0)).toBe(true);
    expect(b.tryRemove(0)).toBe(true);
    expect(b.tryRemove(0)).toBe(false);
    // 1 second later → 1 token back.
    expect(b.tryRemove(1000)).toBe(true);
    expect(b.tryRemove(1000)).toBe(false);
  });

  it('never refills past capacity', () => {
    const b = new TokenBucket(2, 100, 0);
    // Idle a long time — tokens cap at 2, so only 2 succeed back-to-back.
    expect(b.tryRemove(10_000)).toBe(true);
    expect(b.tryRemove(10_000)).toBe(true);
    expect(b.tryRemove(10_000)).toBe(false);
  });
});

describe('RateLimiter', () => {
  it('keeps separate buckets per key', () => {
    const rl = new RateLimiter(1, 0); // burst of 1, no refill
    expect(rl.allow('a', 0)).toBe(true);
    expect(rl.allow('a', 0)).toBe(false);
    // A different gateway is unaffected by 'a' exhausting its bucket.
    expect(rl.allow('b', 0)).toBe(true);
  });

  it('forgets a key so its bucket resets', () => {
    const rl = new RateLimiter(1, 0);
    expect(rl.allow('a', 0)).toBe(true);
    expect(rl.allow('a', 0)).toBe(false);
    rl.forget('a');
    expect(rl.allow('a', 0)).toBe(true); // fresh bucket
  });
});
