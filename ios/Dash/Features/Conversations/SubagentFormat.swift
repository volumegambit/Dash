import Foundation

/// Meta formatting for the collapsed sub-agent row (sub-agents design §8.1:
/// right-aligned `N tool uses · 1m 12s`).
///
/// The web twin is `formatElapsed` / `formatToolCount` in
/// `apps/web/src/ui/blocks/subagents.ts`. Both platforms are asserted against
/// the SAME cases in `scripts/fixtures/rendering-fixtures.json` (`kind:
/// "elapsed"` and `kind: "toolCount"`), so any padding, flooring or
/// pluralization divergence fails `RenderingParityTests` on one side — the
/// fixture, not convention, is what keeps these byte-identical.
///
/// Deliberately free of `DateComponentsFormatter` and
/// `NumberFormatter`/`.formatted()`: both are locale-sensitive, and the point
/// of this type is output that matches a TypeScript template literal exactly,
/// on every device, in every locale.
enum SubagentFormat {

  /// `45s`, `1m 12s`, `2h 03m`. Seconds are floored (never rounded up into the
  /// next unit) and the trailing unit is zero-padded to two digits once a
  /// larger unit is shown. Negative input clamps to zero.
  static func elapsed(_ milliseconds: Int) -> String {
    let totalSeconds = max(0, milliseconds) / 1000
    if totalSeconds < 60 { return "\(totalSeconds)s" }

    let totalMinutes = totalSeconds / 60
    if totalMinutes < 60 { return "\(totalMinutes)m \(padded(totalSeconds % 60))s" }

    let hours = totalMinutes / 60
    return "\(hours)h \(padded(totalMinutes % 60))m"
  }

  /// `1 tool use`, `12 tool uses`. Zero pluralizes, matching English usage and
  /// the web twin.
  static func toolCount(_ count: Int) -> String {
    "\(count) tool \(count == 1 ? "use" : "uses")"
  }

  private static func padded(_ value: Int) -> String {
    value < 10 ? "0\(value)" : "\(value)"
  }
}
