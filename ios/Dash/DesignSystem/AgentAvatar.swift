import SwiftUI

/// Agent identity mark (agents-list goal 2026-09-10), shared by
/// `AgentsListView` and `AgentPickerSheet` so the two agent surfaces read as
/// the same app: a filled circle with the agent's initials, coloured
/// deterministically from the agent's name — Messages/Mail convention for a
/// contact with no photo. The colour and initials derivations are pure
/// static functions so `AgentAvatarTests` can pin them without rendering.
struct AgentAvatar: View {
  let name: String
  var size: CGFloat = 36
  /// When set, a small status dot sits on the avatar's bottom-trailing
  /// corner — this replaced `AgentsListView`'s floating status glyph column,
  /// where `checkmark.circle` rendered on every healthy agent and so said
  /// nothing. `nil` (the picker) draws no dot: every agent offered there is
  /// enabled by construction, so a dot would be another always-on decoration.
  var status: RegisteredAgentStatus?

  var body: some View {
    ZStack(alignment: .bottomTrailing) {
      Circle()
        .fill(Self.color(for: name).opacity(DashTheme.Opacity.fillEmphasis))
      Text(Self.initials(for: name))
        .font(.system(size: size * 0.4, weight: .semibold, design: .rounded))
        .foregroundStyle(Self.color(for: name))
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      if let status, status != .registered {
        Circle()
          .fill(status.color)
          .frame(width: size * 0.3, height: size * 0.3)
          // Punches the dot out of the avatar edge so it reads as sitting
          // on top rather than clipped against it. `.black` is fine on
          // Dash's fixed dark ground the same way `codeBackground` is.
          .overlay(Circle().strokeBorder(.background, lineWidth: 2))
      }
    }
    .frame(width: size, height: size)
    .accessibilityHidden(true)
  }

  /// Up to two initials: first character of the first and last words
  /// ("Chief of Staff" → "CS", "Dev" → "D"). Empty/whitespace names — which
  /// the gateway shouldn't send but a cache migration might — fall back to
  /// "?" rather than an empty circle.
  static func initials(for name: String) -> String {
    let words = name.split(whereSeparator: \.isWhitespace)
    guard let first = words.first?.first else { return "?" }
    guard words.count > 1, let last = words.last?.first else {
      return String(first).uppercased()
    }
    return (String(first) + String(last)).uppercased()
  }

  /// Deterministic palette pick — same name, same colour, on every device
  /// and every launch, which is why this hashes character values rather
  /// than using `Hashable.hashValue` (seeded per-process since Swift 4.2).
  /// The palette leans on system colours so it adapts to both schemes.
  static func color(for name: String) -> Color {
    AgentAvatarPalette.colors[paletteIndex(for: name)]
  }

  /// The palette bucket a name maps to, as a stable `Int` index. Exposed
  /// separately from `color(for:)` because SwiftUI `Color` is not safely
  /// `Equatable` for test assertions — comparing two `Color` values crashes
  /// the test process. The bucket index is the pure, deterministic thing to
  /// pin in tests.
  ///
  /// Hashes `name.utf8` rather than `name.unicodeScalars`: the scalar view
  /// is a lazily-bridged collection whose iteration crosses an executor
  /// boundary and trips a dispatch-queue assertion under Swift 6.1's
  /// strict-concurrency test runner. UTF-8 bytes are contiguous and give the
  /// same deterministic, launch-stable result for the ASCII agent names in
  /// practice.
  static func paletteIndex(for name: String) -> Int {
    var hash: UInt64 = 5381
    for byte in name.utf8 {
      hash = hash &* 127 &+ UInt64(byte)
    }
    return Int(hash % UInt64(AgentAvatarPalette.colors.count))
  }
}

/// The fixed avatar palette. Kept separate from `AgentAvatar` so both the
/// rendering path and the count used for modulo-indexing stay in one place.
private enum AgentAvatarPalette {
  static let colors: [Color] = [
    DashTheme.accent, .teal, .indigo, .orange, .pink, .mint, .purple, .cyan,
  ]
}
