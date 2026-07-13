import Foundation

struct BackoffPolicy: Sendable {
  func delay(attempt: Int, unitRandom: Double) -> Duration {
    let base = min(30.0, pow(2.0, Double(attempt)))
    let jitter = 0.8 + (0.4 * unitRandom)
    return .seconds(min(30.0, max(1.0, base * jitter)))
  }
}
