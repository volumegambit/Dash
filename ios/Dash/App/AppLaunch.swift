import Foundation
import Observation

enum AppLaunchState {
  case preparing
  case ready(AppModel)
  case failed(message: String)
}

@MainActor
@Observable
final class AppLaunch {
  private(set) var state: AppLaunchState = .preparing

  @ObservationIgnored private let factory: AppDependenciesFactory

  var appModel: AppModel? {
    guard case .ready(let appModel) = state else { return nil }
    return appModel
  }

  var errorMessage: String? {
    guard case .failed(let message) = state else { return nil }
    return message
  }

  init(factory: AppDependenciesFactory = .live) {
    self.factory = factory
    compose()
  }

  func retry() {
    state = .preparing
    compose()
  }

  private func compose() {
    do {
      state = .ready(AppModel(dependencies: try factory.make()))
    } catch {
      state = .failed(message: Self.message(for: error))
    }
  }

  /// Composition can fail for two very different reasons, and the screen must
  /// not lie about which one happened:
  ///
  /// * a `LocalizedError` (today: `AccountAuthConfig.ConfigError` — a build
  ///   with no/placeholder control-plane URL) knows exactly what is wrong and
  ///   who can fix it, so its own text is shown verbatim;
  /// * anything else is a store/disk failure with no useful description
  ///   (`localizedDescription` for a bare Swift error is the useless "The
  ///   operation couldn't be completed…"), so it keeps the storage guidance.
  static func message(for error: any Error) -> String {
    if let described = (error as? any LocalizedError)?.errorDescription {
      return described
    }
    return storageFailureMessage
  }

  static let storageFailureMessage =
    "Check available storage, then try again. Your gateway data has not been changed."
}
