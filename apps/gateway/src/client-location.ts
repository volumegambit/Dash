import type { ClientLocation, PreciseLocation } from '@dash/agent';

const MAX_STRING = 200;
/** Widest real UTC offset is +14:00 / -12:00; 840 minutes covers both. */
const MAX_OFFSET_MINUTES = 840;

function str(value: unknown, max = MAX_STRING): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined;
}

function num(value: unknown, lo: number, hi: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= lo && value <= hi
    ? value
    : undefined;
}

function toPrecise(raw: unknown): PreciseLocation | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const p = raw as Record<string, unknown>;
  const latitude = num(p.latitude, -90, 90);
  const longitude = num(p.longitude, -180, 180);
  const accuracyMeters = num(p.accuracyMeters, 0, Number.MAX_SAFE_INTEGER);
  const capturedAt = str(p.capturedAt);
  if (
    latitude === undefined ||
    longitude === undefined ||
    accuracyMeters === undefined ||
    capturedAt === undefined ||
    Number.isNaN(Date.parse(capturedAt))
  ) {
    return undefined;
  }
  const place = p.place === undefined ? undefined : str(p.place);
  if (p.place !== undefined && place === undefined) return undefined;
  return { latitude, longitude, accuracyMeters, capturedAt, ...(place ? { place } : {}) };
}

/**
 * Validate a client-reported location arriving on an untrusted WS frame.
 *
 * Degrades rather than rejects, at two levels: a malformed `precise` block
 * still yields the coarse tier, and a malformed coarse tier yields
 * `undefined`. In NEITHER case may the caller drop the user's message — this
 * differs deliberately from image validation, which fails the whole frame. A
 * buggy geocoder or a sign error must not cost someone their turn.
 */
export function toClientLocation(raw: unknown): ClientLocation | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const l = raw as Record<string, unknown>;

  const timezone = str(l.timezone);
  const locale = str(l.locale);
  const utcOffsetMinutes = num(l.utcOffsetMinutes, -MAX_OFFSET_MINUTES, MAX_OFFSET_MINUTES);
  if (timezone === undefined || locale === undefined || utcOffsetMinutes === undefined) {
    return undefined;
  }
  if (!Number.isInteger(utcOffsetMinutes)) return undefined;

  const region = l.region === undefined ? undefined : str(l.region, 2);
  if (l.region !== undefined && (region === undefined || region.length !== 2)) return undefined;

  const precise = l.precise === undefined ? undefined : toPrecise(l.precise);

  return {
    timezone,
    utcOffsetMinutes,
    locale,
    ...(region ? { region } : {}),
    ...(precise ? { precise } : {}),
  };
}
