import Foundation
import Testing

@testable import Dash

@Suite("RelativeTimestamp (list density 2026-09-05)")
struct RelativeTimestampTests {

  /// Saturday 2026-09-05 12:00 UTC, so "3 days ago" lands on a Wednesday.
  private let now = Date(timeIntervalSince1970: 1_788_609_600)
  private let calendar: Calendar = {
    var c = Calendar(identifier: .gregorian)
    c.timeZone = TimeZone(identifier: "UTC")!
    return c
  }()
  private let locale = Locale(identifier: "en_US")

  private func label(minusSeconds seconds: TimeInterval) -> String {
    RelativeTimestamp.label(
      for: now.addingTimeInterval(-seconds), now: now, calendar: calendar, locale: locale)
  }

  @Test("under a minute reads as now")
  func justNow() {
    #expect(label(minusSeconds: 0) == "now")
    #expect(label(minusSeconds: 59) == "now")
  }

  @Test("a clock-skewed future timestamp does not render a negative age")
  func futureDate() {
    // The gateway stamps `updatedAt`; a device clock behind the server's
    // yields a negative interval, which must not surface as "-3m".
    #expect(
      RelativeTimestamp.label(
        for: now.addingTimeInterval(600), now: now, calendar: calendar, locale: locale) == "now")
  }

  @Test("minutes within the hour")
  func minutes() {
    #expect(label(minusSeconds: 60) == "1m")
    #expect(label(minusSeconds: 39 * 60) == "39m")
    #expect(label(minusSeconds: 59 * 60 + 59) == "59m")
  }

  @Test("hours up to a full day, replacing SwiftUI's \"7 hrs, 39 min\"")
  func hours() {
    #expect(label(minusSeconds: 3600) == "1h")
    #expect(label(minusSeconds: 7 * 3600 + 39 * 60) == "7h")
    #expect(label(minusSeconds: 23 * 3600) == "23h")
  }

  @Test("elapsed hours win over the calendar day inside the first 24h")
  func hoursAcrossMidnight() {
    // 20h before noon Saturday is 16:00 Friday — a different calendar day,
    // but "20h" is more useful than "Yesterday" for something that recent.
    #expect(label(minusSeconds: 20 * 3600) == "20h")
  }

  @Test("past a day, the calendar takes over")
  func yesterday() {
    #expect(label(minusSeconds: 30 * 3600) == "Yesterday")
  }

  @Test("within the past week, the weekday")
  func weekday() {
    #expect(label(minusSeconds: 3 * 86_400) == "Wed")
    #expect(label(minusSeconds: 6 * 86_400) == "Sun")
  }

  @Test("beyond a week, an abbreviated date")
  func olderThanAWeek() {
    let result = label(minusSeconds: 10 * 86_400)
    #expect(result.contains("Aug"))
    #expect(result.contains("26"))
  }

  @Test("a different year carries the year")
  func differentYear() {
    #expect(label(minusSeconds: 400 * 86_400).contains("2025"))
  }
}
