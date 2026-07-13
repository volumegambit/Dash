import Foundation
import Testing

@testable import Dash

@Suite("Reconnect backoff")
struct BackoffPolicyTests {
  @Test(
    "exponential backoff is bounded",
    arguments: [
      (0, 0.5, 1.0),
      (1, 0.5, 2.0),
      (4, 0.5, 16.0),
      (8, 0.5, 30.0),
    ]
  )
  func boundedBackoff(attempt: Int, random: Double, expected: Double) {
    #expect(BackoffPolicy().delay(attempt: attempt, unitRandom: random) == .seconds(expected))
  }

  @Test("jitter scales the exponential delay within the policy bounds")
  func jitterBounds() {
    let policy = BackoffPolicy()

    #expect(abs(seconds(policy.delay(attempt: 2, unitRandom: 0)) - 3.2) < 0.000_001)
    #expect(abs(seconds(policy.delay(attempt: 2, unitRandom: 1)) - 4.8) < 0.000_001)
    #expect(policy.delay(attempt: -1, unitRandom: 0) == .seconds(1))
    #expect(policy.delay(attempt: 8, unitRandom: 1) == .seconds(30))
  }

  private func seconds(_ duration: Duration) -> Double {
    let components = duration.components
    return Double(components.seconds) + (Double(components.attoseconds) / 1e18)
  }
}
