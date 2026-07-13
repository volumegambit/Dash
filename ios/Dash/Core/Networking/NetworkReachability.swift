import Foundation
import Network

enum ReachabilityStatus: Equatable, Sendable {
  case satisfied
  case unsatisfied
  case requiresConnection
}

protocol ReachabilityStreaming: Sendable {
  func statuses() -> AsyncStream<ReachabilityStatus>
}

protocol NetworkPathMonitoring: AnyObject, Sendable {
  var pathUpdateHandler: (@Sendable (NWPath) -> Void)? { get set }
  func start(queue: DispatchQueue)
  func cancel()
}

extension NWPathMonitor: NetworkPathMonitoring {}

struct NetworkReachability: ReachabilityStreaming, @unchecked Sendable {
  private let monitor: any NetworkPathMonitoring
  private let queue: DispatchQueue

  init(
    monitor: any NetworkPathMonitoring = NWPathMonitor(),
    queue: DispatchQueue = DispatchQueue(label: "app.dash.network-reachability")
  ) {
    self.monitor = monitor
    self.queue = queue
  }

  func statuses() -> AsyncStream<ReachabilityStatus> {
    let monitor = monitor
    let queue = queue
    return AsyncStream { continuation in
      monitor.pathUpdateHandler = { path in
        continuation.yield(Self.status(for: path.status))
      }
      continuation.onTermination = { @Sendable _ in
        monitor.cancel()
      }
      monitor.start(queue: queue)
    }
  }

  static func status(for value: NWPath.Status) -> ReachabilityStatus {
    switch value {
    case .satisfied:
      return .satisfied
    case .unsatisfied:
      return .unsatisfied
    case .requiresConnection:
      return .requiresConnection
    @unknown default:
      return .requiresConnection
    }
  }
}
