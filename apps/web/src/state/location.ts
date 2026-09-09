import type { MobileClientLocation, MobilePreciseLocation } from '@dash/mobile-contract';

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

const PRECISE_KEY = 'dash.location.precise';
/** A fix older than this is refreshed in the background on the next send. */
const MAX_FIX_AGE_MS = 5 * 60 * 1000;

let cachedFix: MobilePreciseLocation | undefined;
let cachedAtMs = 0;
let refreshInFlight = false;

/** Test seam: clears the module-level fix cache between cases. */
export function __resetPreciseLocationForTests(): void {
  cachedFix = undefined;
  cachedAtMs = 0;
  refreshInFlight = false;
}

/**
 * Whether precise location is even possible here.
 *
 * `navigator.geolocation` requires a SECURE CONTEXT, so a gateway reached over
 * a plain `http://192.168.x.x` LAN URL can never use it. The UI must explain
 * that rather than offering a toggle that silently does nothing.
 */
export function isPreciseLocationAvailable(): boolean {
  try {
    return Boolean(globalThis.isSecureContext) && 'geolocation' in navigator;
  } catch {
    return false;
  }
}

export function isPreciseLocationEnabled(): boolean {
  try {
    return localStorage.getItem(PRECISE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setPreciseLocationEnabled(on: boolean): void {
  try {
    if (on) {
      localStorage.setItem(PRECISE_KEY, '1');
    } else {
      localStorage.removeItem(PRECISE_KEY);
      // Opting out must forget the position we already hold, not merely stop
      // refreshing it.
      cachedFix = undefined;
      cachedAtMs = 0;
    }
  } catch {
    // A blocked localStorage just means the choice does not persist.
  }
}

/**
 * Kick off a background position refresh. Deliberately fire-and-forget:
 * `sendMessage` is synchronous at the frame literal, so a send must NEVER wait
 * on a geolocation fix. A fresh fix rides the NEXT turn; this one uses the
 * cache. Any denial, timeout or error simply leaves the cache alone, which
 * degrades to the coarse tier.
 */
function refreshPreciseLocation(): void {
  if (refreshInFlight || !isPreciseLocationAvailable()) return;
  refreshInFlight = true;
  try {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        refreshInFlight = false;
        cachedFix = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracyMeters: position.coords.accuracy,
          capturedAt: new Date(position.timestamp).toISOString(),
        };
        cachedAtMs = Date.now();
      },
      () => {
        refreshInFlight = false;
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: MAX_FIX_AGE_MS },
    );
  } catch {
    refreshInFlight = false;
  }
}

/**
 * The location to attach to an outgoing turn: the coarse tier always, plus a
 * cached precise fix when the user opted in and the OS granted one.
 */
export function readClientLocation(): MobileClientLocation | undefined {
  const coarse = readCoarseLocation();
  if (!coarse || !isPreciseLocationEnabled()) return coarse;

  if (!cachedFix || Date.now() - cachedAtMs > MAX_FIX_AGE_MS) refreshPreciseLocation();
  return cachedFix ? { ...coarse, precise: cachedFix } : coarse;
}
