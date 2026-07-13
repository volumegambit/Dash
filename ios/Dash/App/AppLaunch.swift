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
      state = .failed(message: error.localizedDescription)
    }
  }
}
