import SwiftUI
import Testing

@testable import Dash

/// Chat UX Phase 4 Task 2 (audit #11): `DashTheme` grew from one accent
/// colour into semantic tokens. This is the token SNAPSHOT — the values a
/// designer signed off — plus the scale rules that keep them coherent. The
/// companion source-scan guard (`ios/scripts/design-tokens.test.ts`) is what
/// stops call sites from bypassing these with literals.
@Suite("DashTheme tokens (Phase 4 Task 2, audit #11)")
struct DashThemeTests {
  @Test("corner radii sit on the 4pt scale, ascend by name, and never collide")
  func radiiOnFourPointScale() {
    let radii: [CGFloat] = [
      DashTheme.Radius.small,
      DashTheme.Radius.medium,
      DashTheme.Radius.large,
      DashTheme.Radius.xLarge,
      DashTheme.Radius.xxLarge,
    ]
    for radius in radii {
      #expect(radius.truncatingRemainder(dividingBy: 4) == 0, "\(radius) is off the 4pt scale")
    }
    #expect(radii == radii.sorted())
    #expect(Set(radii).count == radii.count)
  }

  @Test("radius snapshot")
  func radiusSnapshot() {
    #expect(DashTheme.Radius.small == 8)
    #expect(DashTheme.Radius.medium == 12)
    #expect(DashTheme.Radius.large == 16)
    #expect(DashTheme.Radius.xLarge == 20)
    #expect(DashTheme.Radius.xxLarge == 24)
  }

  @Test("opacity levels form one small ordered set inside (0, 1)")
  func opacityLevelsOrdered() {
    let levels: [Double] = [
      DashTheme.Opacity.fillSubtle,
      DashTheme.Opacity.fillMuted,
      DashTheme.Opacity.fillEmphasis,
      DashTheme.Opacity.shadow,
      DashTheme.Opacity.scrim,
      DashTheme.Opacity.contentSecondary,
    ]
    for level in levels {
      #expect(level > 0 && level < 1)
    }
    #expect(levels == levels.sorted())
    // Hairline strokes share the subtle-fill level so cards and their
    // borders read as one weight.
    #expect(DashTheme.Opacity.strokeSubtle == DashTheme.Opacity.fillSubtle)
  }

  @Test("opacity snapshot")
  func opacitySnapshot() {
    #expect(DashTheme.Opacity.fillSubtle == 0.08)
    #expect(DashTheme.Opacity.fillMuted == 0.12)
    #expect(DashTheme.Opacity.fillEmphasis == 0.14)
    #expect(DashTheme.Opacity.shadow == 0.18)
    #expect(DashTheme.Opacity.scrim == 0.7)
    #expect(DashTheme.Opacity.contentSecondary == 0.8)
  }

  @Test("status colours are exposed as theme tokens, not private to one view")
  func statusColoursExposed() {
    #expect(DashTheme.success != DashTheme.danger)
    #expect(DashTheme.codeBackground != DashTheme.accent)
  }
}
