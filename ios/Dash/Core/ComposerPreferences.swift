import Foundation
import Observation

/// The user-facing "what does Return do in the composer" setting, shared by
/// the composer (which consults it on every Return) and Settings (which flips
/// it). The default is `false` — Return inserts a newline, Cmd+Return sends —
/// matching the composer key contract fixture
/// (`scripts/fixtures/composer-key-contract.json`, whose `enter.newline` mode is
/// the default).
///
/// The design doc is `docs/plans/2026-09-13-composer-return-key-configurable-design.md`.
///
/// `returnKeySends` is a STORED property seeded from `UserDefaults` and written
/// through on change, mirroring `SettingsFeature.sharePreciseLocation`: an
/// `@Observable` only tracks stored properties, so a computed passthrough would
/// leave a bound Picker visually stuck. The view and the composer both read
/// `ComposerPreferences.shared`, so they can never disagree.
@MainActor
@Observable
final class ComposerPreferences {
  static let shared = ComposerPreferences()

  /// `UserDefaults` key. Absent or `false` means "Return inserts a newline".
  static let returnKeySendsKey = "dash.composer.returnKeySends"

  @ObservationIgnored private let defaults: UserDefaults

  var returnKeySends: Bool {
    didSet {
      defaults.set(returnKeySends, forKey: Self.returnKeySendsKey)
    }
  }

  init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
    self.returnKeySends = defaults.bool(forKey: Self.returnKeySendsKey)
  }
}