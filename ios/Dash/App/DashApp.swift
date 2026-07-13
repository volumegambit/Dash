import SwiftUI

@main
struct DashApp: App {
  @State private var appModel: AppModel

  init() {
    do {
      _appModel = State(initialValue: AppModel(dependencies: try AppDependencies.live()))
    } catch {
      fatalError("Unable to initialize Dash: \(error.localizedDescription)")
    }
  }

  var body: some Scene {
    WindowGroup {
      RootView()
        .environment(appModel)
        .task { await appModel.start() }
        .handlesSceneLifecycle(with: appModel)
    }
  }
}
