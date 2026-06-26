import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signDialToken } from '@dash/relay';
import { createDialTokenManager } from './dial-token-manager.js';

const { privateKey } = generateKeyPairSync('ed25519');
/** A dial token whose `exp` is `expSec`, with a dummy cnf (P1 carries cnf). */
function tokenExpiringAt(expSec: number): string {
  return signDialToken({ tenantId: 't', gatewayId: 'gw-1', exp: expSec, cnf: 'abc' }, privateKey);
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gw-dtm-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A controllable timer scheduler: run pending callbacks on demand. */
function fakeTimers() {
  const pending: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  return {
    setTimer: (fn: () => void, ms: number) => {
      const t = { fn, ms, cleared: false };
      pending.push(t);
      return t as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (h: ReturnType<typeof setTimeout>) => {
      (h as unknown as { cleared: boolean }).cleared = true;
    },
    pending,
    async fireNext() {
      const next = pending.find((t) => !t.cleared);
      if (next) {
        next.cleared = true;
        await next.fn();
      }
    },
  };
}

/** Let pending microtasks + a macrotask settle (refresh → persist I/O → redial). */
function settle(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

/** Poll until `pred` holds (a refresh completes through its persist I/O). */
async function until(pred: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('until timeout');
    await new Promise((r) => setTimeout(r, 2));
  }
}

describe('dial-token-manager', () => {
  it('refreshes on boot when the seed token is already expired', async () => {
    const now = () => 1_000_000;
    const fresh = tokenExpiringAt(now() + 100_000);
    let refreshed = 0;
    const timers = fakeTimers();
    const mgr = createDialTokenManager({
      cpClient: {
        refreshDialToken: async () => {
          refreshed += 1;
          return fresh;
        },
      },
      dataDir: dir,
      seedToken: tokenExpiringAt(now() - 10), // already expired
      redial: () => {},
      now,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    await mgr.start();
    expect(refreshed).toBe(1);
    expect(mgr.getToken()).toBe(fresh);
    const st = await stat(join(dir, 'relay-dial-token'));
    expect(st.mode & 0o777).toBe(0o600);
  });

  it('prefers the persisted token over the MC seed on boot', async () => {
    const now = () => 1_000_000;
    const persisted = tokenExpiringAt(now() + 100_000);
    await writeFile(join(dir, 'relay-dial-token'), persisted, { mode: 0o600 });
    const seed = tokenExpiringAt(now() + 100_000);
    let refreshed = 0;
    const timers = fakeTimers();
    const mgr = createDialTokenManager({
      cpClient: {
        refreshDialToken: async () => {
          refreshed += 1;
          return 'x';
        },
      },
      dataDir: dir,
      seedToken: seed,
      redial: () => {},
      now,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    await mgr.start();
    expect(refreshed).toBe(0); // persisted is valid → no refresh
    expect(mgr.getToken()).toBe(persisted);
  });

  it('proactively refreshes and redials when the timer fires', async () => {
    const now = () => 1_000_000;
    const seed = tokenExpiringAt(now() + 100_000);
    const next = tokenExpiringAt(now() + 200_000);
    let redials = 0;
    const timers = fakeTimers();
    const mgr = createDialTokenManager({
      cpClient: { refreshDialToken: async () => next },
      dataDir: dir,
      seedToken: seed,
      redial: () => {
        redials += 1;
      },
      now,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    await mgr.start();
    expect(mgr.getToken()).toBe(seed);
    await timers.fireNext(); // proactive timer
    await until(() => redials === 1);
    expect(mgr.getToken()).toBe(next);
    expect(redials).toBe(1);
  });

  it('reactively refreshes on onAuthFailure, then ignores a second call within cooldown', async () => {
    const now = () => 1_000_000;
    const seed = tokenExpiringAt(now() + 100_000);
    const next = tokenExpiringAt(now() + 200_000);
    let refreshed = 0;
    let redials = 0;
    const timers = fakeTimers();
    const mgr = createDialTokenManager({
      cpClient: {
        refreshDialToken: async () => {
          refreshed += 1;
          return next;
        },
      },
      dataDir: dir,
      seedToken: seed,
      redial: () => {
        redials += 1;
      },
      now,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      reactiveCooldownMs: 60_000,
    });
    await mgr.start();
    mgr.onAuthFailure();
    await until(() => redials === 1);
    expect(refreshed).toBe(1);
    expect(redials).toBe(1);
    mgr.onAuthFailure(); // within cooldown → suppressed
    await settle();
    expect(refreshed).toBe(1);
  });

  it('keeps the current token and retries with backoff when the CP is down on boot', async () => {
    const now = () => 1_000_000;
    const expired = tokenExpiringAt(now() - 10);
    let attempts = 0;
    const timers = fakeTimers();
    const mgr = createDialTokenManager({
      cpClient: {
        refreshDialToken: async () => {
          attempts += 1;
          throw new Error('ECONNREFUSED');
        },
      },
      dataDir: dir,
      seedToken: expired,
      redial: () => {},
      now,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      backoffBaseMs: 100,
      backoffMaxMs: 30_000,
    });
    await mgr.start(); // must not throw
    expect(attempts).toBe(1);
    expect(mgr.getToken()).toBe(expired); // unchanged; a retry timer is armed
    expect(timers.pending.some((t) => !t.cleared)).toBe(true);
  });

  it('stop() clears the proactive timer', async () => {
    const now = () => 1_000_000;
    const seed = tokenExpiringAt(now() + 100_000);
    const timers = fakeTimers();
    const mgr = createDialTokenManager({
      cpClient: { refreshDialToken: async () => seed },
      dataDir: dir,
      seedToken: seed,
      redial: () => {},
      now,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    await mgr.start();
    mgr.stop();
    expect(timers.pending.every((t) => t.cleared)).toBe(true);
  });
});
