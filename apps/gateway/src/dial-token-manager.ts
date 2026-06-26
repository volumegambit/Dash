import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeDialTokenClaims } from '@dash/relay';
import type { ControlPlaneClient } from './control-plane-client.js';

/** Filename of the persisted current dial token (0600, beside the key). */
const TOKEN_FILENAME = 'relay-dial-token';

export interface DialTokenManagerOptions {
  /** Mints fresh dial tokens via a gateway-signed assertion. */
  cpClient: ControlPlaneClient;
  /** Gateway data dir; the current token is persisted here 0600. */
  dataDir: string;
  /** The MC-supplied seed token (used only if no persisted token exists). */
  seedToken?: string;
  /** Re-dial the relay with the new token (relay-client `redialNow`). */
  redial: () => void;
  /** Clock (unix seconds). Injectable for tests. */
  now?: () => number;
  /** Timer factory. Injectable for deterministic tests. */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (h: ReturnType<typeof setTimeout>) => void;
  logger?: { info(m: string): void; warn(m: string): void };
  /** Refresh this many seconds before `exp` (proactive margin). Default 3600. */
  proactiveMarginSec?: number;
  /** Suppress repeat reactive refreshes within this window. Default 30000. */
  reactiveCooldownMs?: number;
  /** CP-down backoff base / cap (ms). Default 1000 / 30000. */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}

export interface DialTokenManager {
  /** The current dial token (relay-client reads this at dial time). */
  getToken(): string;
  /** Load/seed + refresh-if-near-exp, then arm the proactive timer. */
  start(): Promise<void>;
  /** Called by the relay-client on a relay `4401`; cooldown-guarded refresh. */
  onAuthFailure(): void;
  /** Clear any pending timers. */
  stop(): void;
}

/**
 * Owns the gateway's relay dial token end-to-end so the gateway recovers relay
 * connectivity autonomously — across reboots, proactive expiry, and relay
 * `4401`s — with no MC involvement. The persisted token is preferred over the MC
 * seed so a gateway that was offline past the TTL refreshes once on boot rather
 * than dialing a dead token forever (the original bug). All refresh failures are
 * swallowed and retried with backoff; the live tunnel is untouched (the token
 * gates only new dials).
 */
export function createDialTokenManager(opts: DialTokenManagerOptions): DialTokenManager {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h));
  const marginSec = opts.proactiveMarginSec ?? 3600;
  const cooldownMs = opts.reactiveCooldownMs ?? 30_000;
  const backoffBaseMs = opts.backoffBaseMs ?? 1000;
  const backoffMaxMs = opts.backoffMaxMs ?? 30_000;
  const tokenPath = join(opts.dataDir, TOKEN_FILENAME);

  let token = opts.seedToken ?? '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let backoffAttempt = 0;
  let lastReactiveMs = 0;

  const clearTimerIfAny = (): void => {
    if (timer) {
      clearTimer(timer);
      timer = undefined;
    }
  };

  /** Seconds until `exp` for `tok`; `-Infinity` if it can't be decoded. */
  const secsUntilExp = (tok: string): number => {
    const claims = decodeDialTokenClaims(tok);
    return claims ? claims.exp - now() : Number.NEGATIVE_INFINITY;
  };

  const persist = async (tok: string): Promise<void> => {
    await writeFile(tokenPath, tok, { mode: 0o600 });
  };

  /** Arm the proactive timer at `exp − margin` (min 0). No-op if undecodable. */
  const armProactive = (): void => {
    if (stopped) return;
    const remaining = secsUntilExp(token);
    if (!Number.isFinite(remaining)) return;
    const delayMs = Math.max(0, (remaining - marginSec) * 1000);
    clearTimerIfAny();
    timer = setTimer(() => {
      void refreshAndRedial('proactive');
    }, delayMs);
  };

  /** Re-arm a CP-down retry with exponential backoff (capped). */
  const armBackoff = (): void => {
    if (stopped) return;
    const delay = Math.min(backoffMaxMs, backoffBaseMs * 2 ** backoffAttempt);
    backoffAttempt += 1;
    clearTimerIfAny();
    timer = setTimer(() => {
      void refreshAndRedial('backoff');
    }, delay);
  };

  /**
   * Refresh the token, persist it, re-dial, and re-arm the proactive timer.
   * On any CP failure, keep the current token and schedule a backoff retry —
   * never throw into the caller (boot/timer/reactive paths all tolerate this).
   */
  const refreshAndRedial = async (reason: string): Promise<void> => {
    if (stopped) return;
    try {
      const fresh = await opts.cpClient.refreshDialToken();
      token = fresh;
      backoffAttempt = 0;
      await persist(fresh);
      opts.logger?.info(`[relay] dial token refreshed (${reason})`);
      opts.redial();
      armProactive();
    } catch (err) {
      opts.logger?.warn(`[relay] dial token refresh failed (${reason}): ${(err as Error).message}`);
      armBackoff();
    }
  };

  return {
    getToken: () => token,

    async start(): Promise<void> {
      // Prefer the persisted token over the MC seed: a gateway offline past the
      // TTL must refresh from its own last state, not re-dial the stale seed.
      try {
        const persisted = (await readFile(tokenPath, 'utf8')).trim();
        if (persisted) token = persisted;
      } catch {
        // No persisted token yet — keep the seed.
      }
      // Refresh before the first dial if missing or within the proactive margin.
      if (secsUntilExp(token) <= marginSec) {
        await refreshAndRedial('boot');
        return;
      }
      armProactive();
    },

    onAuthFailure(): void {
      const nowMs = Date.now();
      if (nowMs - lastReactiveMs < cooldownMs) return; // cooldown-guarded
      lastReactiveMs = nowMs;
      void refreshAndRedial('reactive');
    },

    stop(): void {
      stopped = true;
      clearTimerIfAny();
    },
  };
}
