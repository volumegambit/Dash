import Foundation

/// Supplies the location context attached to outgoing chat turns.
///
/// Two tiers. The coarse one reads `TimeZone.current` and `Locale.current`,
/// needs no permission prompt and no network, and is always sent. The precise
/// one is added by `PreciseLocationProvider` only after an in-app opt-in AND an
/// OS grant.
enum LocationProvider {
  /// Coarse tier: no permission prompt, no network, never fails loudly.
  ///
  /// Returns `nil` rather than a partial value when the platform cannot supply
  /// a required field — the gateway rejects the ENTIRE coarse tier on an empty
  /// string, so half-filled is worse than nothing.
  static func coarse() -> ClientLocation? {
    let timezone = TimeZone.current.identifier
    let locale = Locale.current.identifier
    guard !timezone.isEmpty, !locale.isEmpty else { return nil }

    let region = Locale.current.region?.identifier
    return ClientLocation(
      timezone: timezone,
      // Already minutes EAST of UTC — unlike JS's getTimezoneOffset(), which is
      // west-positive and has to be negated.
      utcOffsetMinutes: TimeZone.current.secondsFromGMT() / 60,
      locale: locale,
      // Never send an empty string; omit instead.
      region: (region?.isEmpty == false) ? region : nil,
      precise: nil
    )
  }

  /// The location for the next outgoing turn: coarse always, plus a cached
  /// precise fix when the user opted in and CoreLocation granted one.
  static func current() -> ClientLocation? {
    guard let coarse = coarse() else { return nil }
    guard let precise = PreciseLocationProvider.shared.cachedFix() else { return coarse }
    return ClientLocation(
      timezone: coarse.timezone,
      utcOffsetMinutes: coarse.utcOffsetMinutes,
      locale: coarse.locale,
      region: coarse.region,
      precise: precise
    )
  }
}
