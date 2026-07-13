import Foundation

protocol AppClock: Sendable {
  func now() async -> Date
  func sleep(for duration: Duration) async throws
}

struct SystemAppClock: AppClock {
  func now() async -> Date {
    Date()
  }

  func sleep(for duration: Duration) async throws {
    try await ContinuousClock().sleep(for: duration)
  }
}
