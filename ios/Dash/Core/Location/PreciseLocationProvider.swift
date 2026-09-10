import CoreLocation
import Foundation

/// Opt-in precise position, off until the user turns it on AND CoreLocation
/// grants the permission.
///
/// The cached fix is what rides an outgoing turn: sending is synchronous at the
/// frame, so a send must NEVER wait on a location callback. A fresh fix rides
/// the next turn. A denied or restricted authorization simply leaves the cache
/// empty, which degrades to the coarse tier.
final class PreciseLocationProvider: NSObject, CLLocationManagerDelegate, @unchecked Sendable {
  static let shared = PreciseLocationProvider()

  /// `UserDefaults` key for the opt-in. Absent or `false` means off.
  static let enabledKey = "dash.location.precise"

  /// Created lazily, and only from `@MainActor` entry points.
  ///
  /// `CLLocationManager` must be created on a thread with an active run loop
  /// or its delegate callbacks never fire. `LocationProvider.current()` is
  /// called from `ChatConnection`, which is an `actor` and therefore NOT the
  /// main thread — so constructing the manager in `init` would tie its
  /// lifetime to whichever executor happened to touch `.shared` first.
  /// `cachedFix()` deliberately never touches it.
  private var manager: CLLocationManager?
  private let defaults: UserDefaults
  private let lock = NSLock()
  private var fix: PreciseLocation?
  private var geocoding = false

  private static let maximumWireAccuracyMeters = 9_007_199_254_740_991.0

  init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
    super.init()
  }

  @MainActor
  private func ensureManager() -> CLLocationManager {
    if let manager { return manager }
    let created = CLLocationManager()
    created.delegate = self
    // Hundred-metre accuracy is plenty to answer "roughly where am I" and is
    // far cheaper on battery than kCLLocationAccuracyBest.
    created.desiredAccuracy = kCLLocationAccuracyHundredMeters
    manager = created
    return created
  }

  var isEnabled: Bool {
    defaults.bool(forKey: Self.enabledKey)
  }

  /// Turn the opt-in on or off. Turning it on asks for authorization and starts
  /// updates; turning it off stops updates AND forgets the position already
  /// held, not merely future refreshes.
  @MainActor
  func setEnabled(_ enabled: Bool) {
    defaults.set(enabled, forKey: Self.enabledKey)
    let manager = ensureManager()
    if enabled {
      manager.requestWhenInUseAuthorization()
      manager.startUpdatingLocation()
    } else {
      manager.stopUpdatingLocation()
      lock.lock()
      fix = nil
      lock.unlock()
    }
  }

  /// Start updates if the user already opted in during a previous launch.
  /// Called from app startup — without it the opt-in survives a relaunch in
  /// `UserDefaults` but no fix is ever captured again.
  @MainActor
  func resumeIfEnabled() {
    guard isEnabled else { return }
    let manager = ensureManager()
    manager.requestWhenInUseAuthorization()
    manager.startUpdatingLocation()
  }

  /// The last known fix, or `nil` when the opt-in is off or nothing has been
  /// captured yet. Never blocks.
  func cachedFix() -> PreciseLocation? {
    guard isEnabled else { return nil }
    lock.lock()
    defer { lock.unlock() }
    return fix
  }

  // MARK: - CLLocationManagerDelegate

  func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    guard let location = locations.last else { return }
    let captured = ISO8601DateFormatter().string(from: location.timestamp)
    lock.lock()
    let existingPlace = fix?.place
    fix = PreciseLocation(
      latitude: location.coordinate.latitude,
      longitude: location.coordinate.longitude,
      accuracyMeters: Self.normalizedAccuracyMeters(location.horizontalAccuracy),
      capturedAt: captured,
      place: existingPlace
    )
    lock.unlock()
    reverseGeocode(location)
  }

  private static func normalizedAccuracyMeters(_ accuracy: CLLocationAccuracy) -> Double {
    guard accuracy.isFinite else { return maximumWireAccuracyMeters }
    return min(max(accuracy, 0), maximumWireAccuracyMeters).rounded(.up)
  }

  func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
    // Leave the cache alone. A failure degrades to the coarse tier rather than
    // interrupting the user, who did not ask for a location right now.
  }

  func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    switch manager.authorizationStatus {
    case .denied, .restricted:
      lock.lock()
      fix = nil
      lock.unlock()
    case .authorizedWhenInUse, .authorizedAlways:
      if isEnabled { manager.startUpdatingLocation() }
    case .notDetermined:
      break
    default:
      break
    }
  }

  // MARK: - Reverse geocoding

  /// Best-effort place name. Needs network, so its absence is normal and must
  /// never delay or block a send — it lands on the cache for a later turn.
  private func reverseGeocode(_ location: CLLocation) {
    lock.lock()
    if geocoding {
      lock.unlock()
      return
    }
    geocoding = true
    lock.unlock()

    CLGeocoder().reverseGeocodeLocation(location) { [weak self] placemarks, _ in
      guard let self else { return }
      let name = placemarks?.first.map { placemark in
        [placemark.name, placemark.locality, placemark.administrativeArea]
          .compactMap { $0 }
          .first
      } ?? nil
      self.lock.lock()
      self.geocoding = false
      if let name, let current = self.fix {
        self.fix = PreciseLocation(
          latitude: current.latitude,
          longitude: current.longitude,
          accuracyMeters: current.accuracyMeters,
          capturedAt: current.capturedAt,
          place: name
        )
      }
      self.lock.unlock()
    }
  }
}
