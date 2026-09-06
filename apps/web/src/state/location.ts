import type { MobileClientLocation } from '@dash/mobile-contract';

/**
 * Read the coarse location tier from platform APIs that need no permission:
 * `Intl` and `navigator.language`, which every locale-aware UI already reads.
 *
 * Returns `undefined` rather than a partial object when the platform cannot
 * supply the required fields. That is deliberate: the gateway's validator
 * rejects the ENTIRE coarse tier on an empty string, so a half-filled object
 * is strictly worse than sending nothing.
 */
export function readCoarseLocation(): MobileClientLocation | undefined {
  let timezone: string | undefined;
  let locale: string | undefined;
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
    locale = navigator.language || undefined;
  } catch {
    return undefined;
  }
  if (!timezone || !locale) return undefined;

  // `getTimezoneOffset()` is minutes WEST of UTC (Singapore = -480); the
  // contract wants minutes EAST (Singapore = 480). Hence the negation — this
  // is the opposite of Swift's `TimeZone.secondsFromGMT()`, which is already
  // east-positive.
  const utcOffsetMinutes = -new Date().getTimezoneOffset();

  let region: string | undefined;
  try {
    // `undefined` for a bare tag like 'en'. Omit the key rather than sending
    // an empty string, which the gateway would reject.
    region = new Intl.Locale(locale).region ?? undefined;
  } catch {
    region = undefined;
  }

  return {
    timezone,
    utcOffsetMinutes,
    locale,
    ...(region ? { region } : {}),
  };
}

/**
 * The location to attach to an outgoing turn. Coarse today; Task 7 folds in
 * the opt-in precise fix here so the store keeps one call site.
 */
export function readClientLocation(): MobileClientLocation | undefined {
  return readCoarseLocation();
}
