/**
 * A precise position reported by a client. Present ONLY when the user opted in
 * in-app AND the OS granted a location permission.
 */
export interface PreciseLocation {
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  /** RFC 3339. May predate the message — clients may send a cached fix. */
  capturedAt: string;
  /** Reverse-geocoded place, when the client resolved one. Best-effort. */
  place?: string;
}

/**
 * Location context a client reported for one message.
 *
 * Mirrors `MobileClientLocation` in `@dash/mobile-contract`. Declared here
 * rather than imported because `@dash/agent` must not depend on the mobile
 * contract — the gateway maps contract → agent type at the boundary, exactly
 * as it already does for `MobileImage → ImageBlock`.
 */
export interface ClientLocation {
  /** IANA time zone id, e.g. "Asia/Singapore". */
  timezone: string;
  /** Minutes EAST of UTC at send time (Singapore = 480). */
  utcOffsetMinutes: number;
  /** BCP-47 language tag, e.g. "en-SG". */
  locale: string;
  /** ISO 3166-1 alpha-2 region when the platform exposes one. */
  region?: string;
  precise?: PreciseLocation;
}
