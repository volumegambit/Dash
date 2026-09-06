import Foundation

/// A precise position. Present ONLY when the user opted in in-app AND the OS
/// granted a location permission.
struct PreciseLocation: Codable, Hashable, Sendable {
  let latitude: Double
  let longitude: Double
  let accuracyMeters: Double
  /// RFC 3339. May predate the message — a cached fix is allowed.
  let capturedAt: String
  /// Reverse-geocoded place, when the device resolved one. Best-effort.
  let place: String?
}

/// Location context reported with a chat turn.
///
/// The coarse fields need no permission: they come from `TimeZone.current` and
/// `Locale.current`, which the UI already reads for formatting.
struct ClientLocation: Codable, Hashable, Sendable {
  let timezone: String
  /// Minutes EAST of UTC. `TimeZone.secondsFromGMT()` is already east-positive,
  /// so unlike the web client this needs no negation — only a divide by 60.
  let utcOffsetMinutes: Int
  let locale: String
  let region: String?
  let precise: PreciseLocation?
}
