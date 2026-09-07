/**
 * Pure, framework-free helpers for the sub-agent panel (`SwarmPanel.tsx`).
 * Kept in a separate module so they can be unit-tested under the app's vitest
 * config without a DOM.
 *
 * The run-scoped helpers this file used to carry (`isRunTerminal`, `isRunLive`,
 * `sortRuns`, `workerElapsedMs`, `workerStatusLabel`, `isWorkerTerminal`,
 * `workerTotalTokens`) went with the run-scoped panel. Their replacements are
 * in `routes/chat.swarm.ts`, where the transcript card reads them too — one
 * status vocabulary and one terminal predicate for both surfaces. In
 * particular `workerElapsedMs` reported `now - startedAt` for a terminal worker
 * with no `endedAt`, which is the row's own AGE rather than the run's duration;
 * `subagentElapsedMs` reports nothing at all in that case.
 *
 * What is left is used by two callers that have nothing to do with sub-agent
 * lifecycles: the panel's token column, and the agent configuration tab's
 * numeric/CSV fields.
 */

/**
 * Format a token count compactly: `842`, `12.3k`, `1.2M`. Thousands/millions
 * are shown with one decimal so a busy worker's usage stays readable in a
 * narrow column.
 */
export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

/**
 * Parse the comma-separated `allowedModels` input into a clean string[]:
 * trims each entry, drops blanks, de-duplicates preserving first-seen order.
 * An input with no real entries yields an empty array.
 */
export function parseAllowedModels(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

/**
 * Coerce a numeric-field text input to a positive integer, or undefined when
 * the field is blank / non-numeric / non-positive. Used by the swarm settings
 * caps fields so an empty field means "use the gateway default", not zero.
 */
export function parsePositiveInt(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return undefined;
  return n;
}
