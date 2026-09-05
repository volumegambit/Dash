import Foundation

/// Compact relative age for a trailing timestamp — conversation rows and
/// the Settings "Last sync" row (2026-09-05).
///
/// Replaces `Text(date, style: .relative)`, which rendered "7 hrs, 39 min" —
/// long enough to crowd the title, and precise to the minute for something
/// eight hours old, which nobody reads. `.relative` is also a *self-updating*
/// text style: SwiftUI drives it on a timer, so every visible row re-rendered
/// once a minute forever to change a digit. And it can only ever count
/// elapsed units, so it has no way to say "Yesterday" or "Wed".
///
/// The ladder is elapsed-first for the first day (`now` -> `39m` -> `7h`),
/// then calendar-based (`Yesterday` -> `Wed` -> `26 Aug`). Elapsed wins
/// inside the first 24 hours deliberately: 20 hours before noon is late
/// yesterday afternoon, and "20h" locates that better than "Yesterday" does.
///
/// Pure and fully injectable (`now`/`calendar`/`locale`) so it is directly
/// unit-testable — see `RelativeTimestampTests`. Lives here rather than
/// beside either caller now that two features share it. Uses `Date.FormatStyle`
/// rather than a cached `DateFormatter`: the latter is a mutable reference
/// type that Swift 6 strict concurrency will not let this share.
enum RelativeTimestamp {
  static func label(
    for date: Date,
    now: Date = Date(),
    calendar: Calendar = .current,
    locale: Locale = .current
  ) -> String {
    let elapsed = now.timeIntervalSince(date)

    // A device clock behind the gateway's makes `elapsed` negative; clamp
    // rather than render "-3m".
    guard elapsed >= 60 else { return "now" }
    if elapsed < 3600 { return "\(Int(elapsed / 60))m" }
    if elapsed < 86_400 { return "\(Int(elapsed / 3600))h" }
    if calendar.isDateInYesterday(date) { return "Yesterday" }

    let style = Date.FormatStyle(
      locale: locale,
      calendar: calendar,
      timeZone: calendar.timeZone
    )

    let days = calendar.dateComponents([.day], from: date, to: now).day ?? 0
    if days < 7 {
      return date.formatted(style.weekday(.abbreviated))
    }

    let dated = style.day().month(.abbreviated)
    let sameYear = calendar.component(.year, from: date) == calendar.component(.year, from: now)
    return date.formatted(sameYear ? dated : dated.year())
  }
}
