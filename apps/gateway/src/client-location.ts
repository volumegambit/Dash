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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
): boolean {
  const allowedSet = new Set(allowed);
  return (
    Object.keys(value).every((key) => allowedSet.has(key)) &&
    required.every((key) => Object.hasOwn(value, key))
  );
}

function v2String(value: unknown, min: number, max: number): string | undefined {
  if (typeof value !== 'string' || value.length < min || value.length > max * 2) return undefined;
  const length = Array.from(value).length;
  return length >= min && length <= max ? value : undefined;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isV2Rfc3339(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)(?:[Zz]|([+-])(\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second >= 61
  ) {
    return false;
  }
  const offsetSign = match[7] === '-' ? -1 : 1;
  const offsetHour = Number(match[8] ?? 0);
  const offsetMinute = Number(match[9] ?? 0);
  if (match[7] !== undefined && (offsetHour > 23 || offsetMinute > 59)) return false;
  if (second < 60) return true;

  const utcMinute = minute - offsetMinute * offsetSign;
  const utcHour = hour - offsetHour * offsetSign - (utcMinute < 0 ? 1 : 0);
  return (utcHour === 23 || utcHour === -1) && (utcMinute === 59 || utcMinute === -1);
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

/** Strict v2 location normalization shared by frame admission and provider dispatch. */
export function toClientLocationV2(raw: unknown): ClientLocation | undefined {
  if (
    !isRecord(raw) ||
    !hasExactKeys(
      raw,
      ['timezone', 'utcOffsetMinutes', 'locale', 'region', 'precise'],
      ['timezone', 'utcOffsetMinutes', 'locale'],
    )
  ) {
    return undefined;
  }
  const timezone = v2String(raw.timezone, 1, MAX_STRING);
  const locale = v2String(raw.locale, 1, MAX_STRING);
  if (
    timezone === undefined ||
    locale === undefined ||
    !Number.isSafeInteger(raw.utcOffsetMinutes) ||
    (raw.utcOffsetMinutes as number) < -MAX_OFFSET_MINUTES ||
    (raw.utcOffsetMinutes as number) > MAX_OFFSET_MINUTES
  ) {
    return undefined;
  }

  let region: string | undefined;
  if (Object.hasOwn(raw, 'region')) {
    region = v2String(raw.region, 2, 2);
    if (region === undefined) return undefined;
  }

  let precise: PreciseLocation | undefined;
  if (Object.hasOwn(raw, 'precise')) {
    if (
      !isRecord(raw.precise) ||
      !hasExactKeys(
        raw.precise,
        ['latitude', 'longitude', 'accuracyMeters', 'capturedAt', 'place'],
        ['latitude', 'longitude', 'accuracyMeters', 'capturedAt'],
      ) ||
      typeof raw.precise.latitude !== 'number' ||
      !Number.isFinite(raw.precise.latitude) ||
      raw.precise.latitude < -90 ||
      raw.precise.latitude > 90 ||
      typeof raw.precise.longitude !== 'number' ||
      !Number.isFinite(raw.precise.longitude) ||
      raw.precise.longitude < -180 ||
      raw.precise.longitude > 180 ||
      !Number.isSafeInteger(raw.precise.accuracyMeters) ||
      (raw.precise.accuracyMeters as number) < 0 ||
      !isV2Rfc3339(raw.precise.capturedAt)
    ) {
      return undefined;
    }
    let place: string | undefined;
    if (Object.hasOwn(raw.precise, 'place')) {
      place = v2String(raw.precise.place, 1, MAX_STRING);
      if (place === undefined) return undefined;
    }
    precise = {
      latitude: raw.precise.latitude,
      longitude: raw.precise.longitude,
      accuracyMeters: raw.precise.accuracyMeters as number,
      capturedAt: raw.precise.capturedAt,
      ...(place !== undefined ? { place } : {}),
    };
  }

  return {
    timezone,
    utcOffsetMinutes: raw.utcOffsetMinutes as number,
    locale,
    ...(region !== undefined ? { region } : {}),
    ...(precise !== undefined ? { precise } : {}),
  };
}
