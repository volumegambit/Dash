import { escapeClosingTag } from '../memory/escape.js';
import type { ClientLocation } from './types.js';

const PREAMBLE =
  "Context your client reported for this message. It is client-asserted, may be stale, and describes the user's device — not you.";

const CLOSING =
  'Use this for time, distance, units, currency and language defaults without asking. Do not repeat it back unless it is relevant. When the user asks where they are, answer with what this block actually establishes and name its limits — never upgrade an approximate area into a specific city.';

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
  if (location.region) lines.push(`- Country/region: ${esc(location.region)} (reliable)`);

  const precise = location.precise;
  if (precise) {
    const near = precise.place ? `, near ${esc(precise.place)}` : '';
    lines.push(
      `- Position: ${precise.latitude}, ${precise.longitude} (±${Math.round(precise.accuracyMeters)} m, captured ${esc(precise.capturedAt)})${near}`,
    );
    if (!precise.place) {
      // Coordinates alone are NOT a place name. Left to itself a model will
      // name a specific district and be confidently wrong -- the measured case
      // answered "Bras Basah / Fort Canning" for a point 1.5 km away at Marina
      // Bay Sands. Same failure mode as naming a city from a time zone.
      lines.push(
        '- Note: no place name was resolved for those coordinates. Do not name a specific building, street or district unless you are certain it matches; give the broad area and the coordinates instead.',
      );
    }
  } else {
    // A time zone is a REGION, and its name is only the zone's label. Telling
    // the model to "treat it as the metropolitan area" made it answer
    // "New York City" for anyone in America/New_York — a zone spanning Maine
    // to Florida. Confidently wrong is worse than admittedly approximate.
    lines.push(
      "- Position: NOT shared. Only the time zone and country above are known. A time zone is a region, not a city: the city in its name is just the zone label, and the user may be anywhere in that zone. Do not state that city as the user's location. If asked where they are, say what is actually known — the country, and the time zone — and add that they can share their precise location from their Dash client's settings if they want a more specific answer.",
    );
  }

  const closing = opts?.tool ? `${CLOSING}${TOOL_HINT}` : CLOSING;
  return `<environment>\n${PREAMBLE}\n\n${lines.join('\n')}\n\n${closing}\n</environment>`;
}
