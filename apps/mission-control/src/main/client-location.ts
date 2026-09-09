import type { MobileClientLocation } from '@dash/mobile-contract';

/**
 * The slice of Electron's `app` this module needs. Injected rather than
 * imported so the module (and its callers) stay testable in a plain Node
 * vitest environment, where `electron` is not resolvable.
 */
export interface LocaleSource {
  getLocale(): string;
  getLocaleCountryCode(): string;
}

/**
 * Read the coarse location tier in the Electron main process.
 *
 * Mission Control is **coarse-only by decision**: Electron 33's Chromium
 * geolocation needs a Google API key on desktop, and the send path lives in
 * the main process, so a precise fix would mean an unreliable result behind a
 * renderer IPC hop. Time zone, locale and region need none of that.
 *
 * Returns `undefined` rather than a partial object: the gateway rejects the
 * ENTIRE coarse tier on an empty string, so half-filled is worse than nothing.
 */
export function readCoarseLocation(source: LocaleSource): MobileClientLocation | undefined {
  let timezone: string | undefined;
  let locale: string | undefined;
  let country: string | undefined;
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
    locale = source.getLocale() || undefined;
    // Electron exposes the region directly -- more reliable than parsing it
    // back out of the locale string.
    country = source.getLocaleCountryCode() || undefined;
  } catch {
    return undefined;
  }
  if (!timezone || !locale) return undefined;

  // `getTimezoneOffset()` is minutes WEST of UTC; the contract wants minutes
  // EAST. Same negation as the web client, and the opposite of Swift.
  const utcOffsetMinutes = -new Date().getTimezoneOffset();
  const region = country && country.length === 2 ? country : undefined;

  return {
    timezone,
    utcOffsetMinutes,
    locale,
    ...(region ? { region } : {}),
  };
}
