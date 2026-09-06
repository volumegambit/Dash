import type { ExtraTool } from '../types.js';
import type { ClientLocation } from './types.js';

export const GET_LOCATION_TOOL_NAME = 'get_location';

const DESCRIPTION = `Report where the user is, as their client last told this conversation.

The same information is already summarised in the <environment> block of your
system prompt, so you rarely need this tool. Call it when that block is no
longer in your context (for example after the conversation was compacted), or
when you want to state the user's position explicitly rather than infer it.

Takes no arguments. It never prompts the user and never asks their device for a
new reading, so it is free to call and cannot fail — if the client reported no
location, it says so.`;

const PARAMETERS = {
  type: 'object',
  properties: {},
  additionalProperties: false,
} as const;

function describe(location: ClientLocation): string {
  const lines = [
    `Time zone: ${location.timezone} (UTC${location.utcOffsetMinutes < 0 ? '-' : '+'}${String(Math.floor(Math.abs(location.utcOffsetMinutes) / 60)).padStart(2, '0')}:${String(Math.abs(location.utcOffsetMinutes) % 60).padStart(2, '0')})`,
    `Locale: ${location.locale}`,
  ];
  if (location.region) lines.push(`Country/region: ${location.region} (reliable)`);

  const precise = location.precise;
  if (precise) {
    lines.push(
      `Position: ${precise.latitude}, ${precise.longitude} (accurate to about ${Math.round(precise.accuracyMeters)} m, captured ${precise.capturedAt})`,
    );
    if (precise.place) lines.push(`Nearby: ${precise.place}`);
  } else {
    lines.push(
      "Position: NOT shared. Only the time zone and country above are known. A time zone is a region, not a city — the city in its name is just the zone label, and the user may be anywhere in that zone. Do not state that city as the user's location; report the country and time zone, and that no precise position was shared.",
    );
  }
  return lines.join('\n');
}

/**
 * A tool that reports the location the client attached to the current turn.
 *
 * `getLocation` is read at CALL time, not at construction, so a warm pooled
 * backend serving a user who has moved reports the new position on the next
 * turn. This is the same late-binding the swarm and projects tools use for
 * `conversationId: () => backend.getCurrentSessionId()`.
 *
 * It does NOT round-trip to the device for a fresh fix. There is no live
 * agent→client request channel: `AgentBackend.answerQuestion` is optional and
 * `PiAgentBackend` never implements it, so the `question`/`answer` frames have
 * no real producer. Clients already refresh their position in the background on
 * every send, so what this returns is at most one turn old.
 *
 * A missing location returns normal content, never `isError`. Channel adapters
 * (Slack, iMessage) have no client to report one, and an error result would
 * push the model into pointless retries.
 */
export function createGetLocationTool(getLocation: () => ClientLocation | undefined): ExtraTool {
  return {
    name: GET_LOCATION_TOOL_NAME,
    label: 'Get location',
    description: DESCRIPTION,
    parameters: PARAMETERS,
    async execute() {
      let location: ClientLocation | undefined;
      try {
        location = getLocation();
      } catch {
        location = undefined;
      }
      if (!location) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'This client did not report a location for this message. You have no location for the user — ask them if you need one, and do not guess.',
            },
          ],
          details: { location: null },
        };
      }
      return {
        content: [{ type: 'text' as const, text: describe(location) }],
        details: { location },
      };
    },
  };
}
