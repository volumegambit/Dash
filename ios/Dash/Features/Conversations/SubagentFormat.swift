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

  /// §8.1's right-aligned meta. Elapsed is omitted entirely when it is
  /// unknown — a terminal child with no `endedAt` has no honest duration to
  /// show, and the row's own age is not one.
  static func meta(toolCallCount: Int, elapsedMs: Int?) -> String {
    guard let elapsedMs else { return toolCount(toolCallCount) }
    return "\(toolCount(toolCallCount)) · \(elapsed(elapsedMs))"
  }

  /// §8.2's parallel-group summary line, e.g. `3 agents · 2 running · 1 done`.
  /// Empty buckets are omitted and the order is fixed, so the line reads the
  /// same way every render rather than following whichever status was seen
  /// first.
  ///
  /// The web twin is `formatClusterSummary` in
  /// `apps/web/src/ui/blocks/subagents.ts`. Unlike `elapsed`/`toolCount` this
  /// pair is NOT locked by `scripts/fixtures/rendering-fixtures.json` — there
  /// is no `clusterSummary` case kind — so the parity here is by construction
  /// and by review, and a divergence would not fail `RenderingParityTests`.
  static func clusterSummary(_ statuses: [SubagentCardStatus]) -> String {
    var parts = ["\(statuses.count) \(statuses.count == 1 ? "agent" : "agents")"]
    for status in statusOrder {
      let count = statuses.count { $0 == status }
      if count > 0 { parts.append("\(count) \(statusWord(status))") }
    }
    return parts.joined(separator: " · ")
  }

  private static let statusOrder: [SubagentCardStatus] = [
    .running, .waiting, .done, .failed, .cancelled, .interrupted, .maxTurns,
  ]

  private static func statusWord(_ status: SubagentCardStatus) -> String {
    switch status {
    case .running: "running"
    case .waiting: "waiting"
    case .done: "done"
    case .failed: "failed"
    case .cancelled: "cancelled"
    case .interrupted: "interrupted"
    case .maxTurns: "max turns"
    }
  }

  private static func padded(_ value: Int) -> String {
    value < 10 ? "0\(value)" : "\(value)"
  }
}
