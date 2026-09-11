import SwiftUI

/// The one moving thing in voice mode (speech Phase B, Task B9).
///
/// A `Canvas` rather than a stack of `Circle`s with `.animation` modifiers,
/// for two reasons: the whole orb is one draw call regardless of how many
/// rings it has, and — the one that matters — the shape is a PURE FUNCTION of
/// `(phase, level, elapsed)`, so `VoiceOrbView.scale` is unit-tested rather
/// than eyeballed. Implicit animations would have put the same behaviour
/// inside SwiftUI's animation engine, where a test cannot reach it.
///
/// `TimelineView(.animation(paused:))` drives it. Paused is a REAL pause: the
/// timeline stops asking for frames, so Reduce Motion costs nothing rather
/// than animating invisibly. That also keeps XCUITest's idle wait honest —
/// the voice UI tests run with Reduce Motion on for exactly that reason.
struct VoiceOrbView: View {
  let phase: VoiceModeState.Phase
  let level: Float
  /// False under Reduce Motion: the orb holds its resting size.
  var animates: Bool = true

  var body: some View {
    TimelineView(.animation(minimumInterval: 1 / 30, paused: animates == false)) { context in
      Canvas { drawing, size in
        let elapsed = animates ? context.date.timeIntervalSinceReferenceDate : 0
        let scale = Self.scale(for: phase, level: level, elapsed: elapsed)
        let side = min(size.width, size.height)
        let center = CGPoint(x: size.width / 2, y: size.height / 2)
        let radius = side / 2 * scale

        // A soft halo first, so the core reads as lit rather than flat.
        let halo = CGRect(
          x: center.x - radius,
          y: center.y - radius,
          width: radius * 2,
          height: radius * 2
        )
        drawing.fill(
          Path(ellipseIn: halo),
          with: .radialGradient(
            Gradient(colors: [
              Self.tint(for: phase).opacity(DashTheme.Opacity.contentTertiary),
              Self.tint(for: phase).opacity(0),
            ]),
            center: center,
            startRadius: radius * 0.55,
            endRadius: radius
          )
        )

        let coreRadius = radius * 0.72
        let core = CGRect(
          x: center.x - coreRadius,
          y: center.y - coreRadius,
          width: coreRadius * 2,
          height: coreRadius * 2
        )
        drawing.fill(
          Path(ellipseIn: core),
          with: .radialGradient(
            Gradient(colors: [
              Self.tint(for: phase),
              Self.tint(for: phase).opacity(DashTheme.Opacity.contentSecondary),
            ]),
            center: CGPoint(x: center.x, y: center.y - coreRadius * 0.35),
            startRadius: 0,
            endRadius: coreRadius
          )
        )
      }
    }
    // The drawing says nothing a screen reader can use — the state line does
    // that. What stays reachable is the TAP TARGET around this view, which
    // `VoiceModeView` labels with the action it performs.
    .accessibilityHidden(true)
  }

  /// The orb's radius as a fraction of its resting size.
  ///
  /// - `listening` breathes between 0.95 and 1.05 over 3 s — slow enough to
  ///   read as "waiting", not as "working".
  /// - `transcribing`/`thinking` pulse over 1.2 s. Transcribing shares the
  ///   thinking pulse for the same reason it shares the label: it is a
  ///   sub-second transient, and a third rhythm would only flicker.
  /// - `speaking` is driven by the microphone level instead of by time, so
  ///   the orb reacts to the room rather than to a clock.
  /// - `muted` sits slightly smaller and perfectly still; `connecting` and
  ///   `ended` rest at 1.
  ///
  /// `elapsed` is wall-clock seconds, and every animated case is periodic in
  /// it, so there is no start date to carry: an orb that appears mid-second
  /// simply joins the cycle where it is.
  static func scale(for phase: VoiceModeState.Phase, level: Float, elapsed: Double) -> Double {
    switch phase {
    case .listening:
      1 + 0.05 * sin(2 * .pi * elapsed / 3)
    case .transcribing, .thinking:
      1 + 0.06 * sin(2 * .pi * elapsed / 1.2)
    case .speaking:
      1 + 0.25 * Double(min(1, max(0, level)))
    case .muted:
      0.92
    case .connecting, .ended:
      1
    }
  }

  static func tint(for phase: VoiceModeState.Phase) -> Color {
    switch phase {
    case .speaking: DashTheme.accent
    case .muted, .ended: Color.secondary
    case .connecting, .listening, .transcribing, .thinking: DashTheme.accent
    }
  }
}
