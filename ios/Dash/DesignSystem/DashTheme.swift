import SwiftUI

/// Dash's design tokens (chat-ux Phase 4 Task 2, audit #11). Every view
/// styles itself from these rather than from literals — the source-scan
/// guard `ios/scripts/design-tokens.test.ts` fails CI on any ad-hoc
/// `cornerRadius:` or `.opacity(0.x)` outside this file, and
/// `DashThemeTests` snapshots the values. Spacing deliberately stays on
/// SwiftUI's system defaults (`.padding()`, stack `spacing:`): native idiom
/// is the iOS constraint, and the platform already sizes those to its own
/// grid.
enum DashTheme {
  static let accent = Color(
    red: 37.0 / 255.0,
    green: 99.0 / 255.0,
    blue: 235.0 / 255.0
  )

  /// Status colours (were private to `EventViews`): tool success/failure,
  /// and the dark code-block ground shared with the web renderer.
  static let success = Color(red: 0x22 / 255, green: 0xc5 / 255, blue: 0x5e / 255)
  static let danger = Color(red: 0xf8 / 255, green: 0x71 / 255, blue: 0x71 / 255)
  static let codeBackground = Color(red: 0x16 / 255, green: 0x1b / 255, blue: 0x22 / 255)

  /// Corner radii on a 4pt scale. `small` = inline cards (tool/worker),
  /// `medium` = thumbnails and question cards, `large` = message bubbles and
  /// banners, `xLarge` = the composer field and scanner reticle, `xxLarge` =
  /// full-bleed panels (camera preview).
  enum Radius {
    static let small: CGFloat = 8
    static let medium: CGFloat = 12
    static let large: CGFloat = 16
    static let xLarge: CGFloat = 20
    static let xxLarge: CGFloat = 24
  }

  /// Alpha levels, one small ordered set. Fills: `fillSubtle` for resting
  /// card grounds, `fillMuted` for chips, selected rows, status banners and
  /// the composer field, `fillEmphasis` for the user bubble's accent wash.
  /// `strokeSubtle` matches `fillSubtle` so a hairline and its card read as
  /// one weight. `contentSecondary` dims text/strokes on strong grounds;
  /// `scrim` sits behind glyphs on imagery; `shadow` is the floating-control
  /// drop shadow.
  enum Opacity {
    static let fillSubtle = 0.08
    static let strokeSubtle = 0.08
    static let fillMuted = 0.12
    static let fillEmphasis = 0.14
    static let shadow = 0.18
    static let scrim = 0.7
    static let contentSecondary = 0.8
  }
}
