/**
 * Shutdown hardening helpers. The signal handler in index.ts runs a sequence
 * of stop/close steps; any one of them throwing used to become an unhandled
 * rejection that hard-crashed the process mid-shutdown (skipping the DB
 * closes and the WAL checkpoint). These helpers make each step best-effort:
 * failures are logged (with credentials redacted) and the sequence continues.
 */

/**
 * Redact Telegram bot tokens from a string. grammY network errors embed the
 * full request URL — `https://api.telegram.org/bot<id>:<secret>/getUpdates` —
 * so logging them verbatim leaks the bot token. Keep the numeric bot id
 * (handy for telling bots apart) and strip the secret.
 */
export function redactBotTokens(text: string): string {
  return text.replace(/\bbot(\d+):[A-Za-z0-9_-]+/g, 'bot$1:<redacted>');
}

/** Render an unknown thrown value for logging, with credentials redacted. */
export function describeError(err: unknown): string {
  const raw = err instanceof Error ? (err.stack ?? err.message) : String(err);
  return redactBotTokens(raw);
}

/**
 * Run one shutdown step, logging (never propagating) any failure so the
 * remaining steps — and the final process.exit — always run.
 */
export async function safeStep(label: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(`[gateway] shutdown step "${label}" failed (continuing):`, describeError(err));
  }
}

/**
 * Reject with a labeled error if `promise` doesn't settle within `ms`.
 * The timer is cleared on settle so a completed race never keeps the
 * event loop alive.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}
