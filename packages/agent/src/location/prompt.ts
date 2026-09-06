import { escapeClosingTag } from '../memory/escape.js';
import type { ClientLocation } from './types.js';

const PREAMBLE =
  "Context your client reported for this message. It is client-asserted, may be stale, and describes the user's device — not you.";

const CLOSING =
  'Use this for time, distance, units, currency and language defaults without asking. Do not repeat it back unless it is relevant.';

const TOOL_HINT = ' If a task needs a more precise or fresher position, call get_location.';

/** `480` → `UTC+08:00`, `-240` → `UTC-04:00`. */
function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `UTC${sign}${hh}:${mm}`;
}

/** Wall-clock time at `minutes` east of UTC, as `YYYY-MM-DD HH:MM`. */
function formatLocalTime(now: Date, minutes: number): string {
  return new Date(now.getTime() + minutes * 60_000).toISOString().slice(0, 16).replace('T', ' ');
}

/**
 * Render the per-turn `<environment>` block.
 *
 * Pure and total — it never throws and never does I/O, so a malformed location
 * can never break a turn. `opts.tool` gates the sentence naming `get_location`
 * so the block never tells a model to call a tool it was not registered with;
 * this mirrors the `tools` flag on `composeMemoryPrompt`, which exists for the
 * same reason.
 *
 * Every interpolated string is OS-derived and untrusted, so all of them go
 * through `escapeClosingTag` — text containing `</environment>` would
 * otherwise leave the rest of the block floating at the top level of the
 * system prompt on every turn.
 */
export function composeLocationPrompt(
  location: ClientLocation,
  opts?: { tool?: boolean; now?: Date },
): string {
  const esc = (value: string): string => escapeClosingTag(value, 'environment');
  const now = opts?.now ?? new Date();

  const lines = [
    `- Local time: ${formatLocalTime(now, location.utcOffsetMinutes)} (${formatOffset(location.utcOffsetMinutes)})`,
    `- Time zone: ${esc(location.timezone)}`,
    `- Locale: ${esc(location.locale)}`,
  ];
  if (location.region) lines.push(`- Region: ${esc(location.region)}`);

  const precise = location.precise;
  if (precise) {
    const near = precise.place ? `, near ${esc(precise.place)}` : '';
    lines.push(
      `- Position: ${precise.latitude}, ${precise.longitude} (±${Math.round(precise.accuracyMeters)} m, captured ${esc(precise.capturedAt)})${near}`,
    );
  } else {
    lines.push(
      '- Approximate location: inferred from the time zone alone. Treat it as the metropolitan area, not an address.',
    );
  }

  const closing = opts?.tool ? `${CLOSING}${TOOL_HINT}` : CLOSING;
  return `<environment>\n${PREAMBLE}\n\n${lines.join('\n')}\n\n${closing}\n</environment>`;
}
