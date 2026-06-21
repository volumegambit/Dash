/**
 * Token-bucket rate limiting for the relay's public phone-facing edge.
 *
 * Each key (a gatewayId) gets its own bucket: `capacity` tokens that refill at
 * `refillPerSec`. A request consumes one token; when the bucket is empty the
 * request is rejected. This caps sustained throughput at `refillPerSec` while
 * still allowing short bursts up to `capacity` — the right shape for "normal app
 * traffic passes, floods get throttled". Keyed per gateway so one tenant's abuse
 * cannot starve another's.
 */

export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    now: number = Date.now(),
  ) {
    this.tokens = capacity;
    this.lastRefillMs = now;
  }

  /** Refill for elapsed time, then try to consume one token. */
  tryRemove(now: number = Date.now()): boolean {
    const elapsedSec = Math.max(0, (now - this.lastRefillMs) / 1000);
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSec);
    this.lastRefillMs = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

export class RateLimiter {
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
  ) {}

  /** True if a request for `key` is allowed now; consumes a token when so. */
  allow(key: string, now: number = Date.now()): boolean {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = new TokenBucket(this.capacity, this.refillPerSec, now);
      this.buckets.set(key, bucket);
    }
    return bucket.tryRemove(now);
  }

  /** Drop a key's bucket (e.g. when its gateway disconnects). */
  forget(key: string): void {
    this.buckets.delete(key);
  }
}
