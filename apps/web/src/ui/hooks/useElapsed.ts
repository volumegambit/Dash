import { useEffect, useState } from 'react';

/**
 * Wall-clock age of a sub-agent run, in milliseconds, for the collapsed row's
 * right-aligned meta (sub-agents design §8.1: "elapsed ticks live while
 * running; frozen on finish").
 *
 * Derived from the two ISO timestamps the fold carries
 * (`SubagentGroup.startedAt` / `.endedAt`), NEVER from
 * `subagent_progress.elapsedMs`: that field is discarded by
 * `blocks/subagents.ts`, and a row must keep counting between progress events
 * anyway. While the child is live this re-renders once a second off
 * `Date.now()`; once it stops the interval is torn down, so a transcript full
 * of finished children costs no timers at all.
 *
 * `running` is what actually decides that, NOT the presence of `endedAt`.
 * Plenty of finished children have no end timestamp: only
 * `subagent_finished` carries one, so an end-of-stream-terminalized child
 * (`cancelled`) and a legacy-only `worker_done` child both arrive terminal
 * with `endedAt: undefined`. Keying the clock off `endedAt` alone would leave
 * those rows counting up forever behind a finished glyph, one live interval
 * each.
 *
 * A terminal run with no `endedAt` reports `null`, not its last reading: the
 * run's duration is genuinely unknown, and `Date.now() - startedAt` would
 * answer a different question — how long ago it STARTED. Reopen the
 * conversation three hours later and that renders a child that ran for ten
 * seconds as `3h 00m`.
 *
 * Returns `null` — not `0`, not `NaN` — when there is no usable `startedAt`.
 * That is the real pre-D8 case: `worker_*` carries no timestamp, so a
 * legacy-only child folds to `startedAt: ''`, and the row is specified to show
 * no elapsed segment at all rather than a 1970-epoch duration. A clock that
 * jumped backwards (or an `endedAt` before its `startedAt`) clamps to `0`
 * instead of rendering a negative.
 */
export function useElapsed(
  startedAt: string | undefined,
  endedAt?: string,
  running = true,
): number | null {
  const start = parseIsoMs(startedAt);
  const end = parseIsoMs(endedAt);
  const live = running && start !== null && end === null;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!live) return;
    // Re-read the clock rather than accumulating: a tab that was backgrounded
    // (throttled timers) then returns must show the true age, not the number
    // of ticks that happened to fire.
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [live]);

  if (start === null) return null;
  if (end !== null) return Math.max(0, end - start);
  if (!running) return null;
  return Math.max(0, now - start);
}

function parseIsoMs(value: string | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}
