import SwiftUI

@main
struct DashApp: App {
  @State private var launch = AppLaunch(factory: .processEnvironment)

  var body: some Scene {
    WindowGroup {
      AppLaunchView(launch: launch)
    }
  }
}

private struct AppLaunchView: View {
  @Bindable var launch: AppLaunch

  var body: some View {
    if let appModel = launch.appModel {
      RootView()
        .environment(appModel)
        .task { await appModel.start() }
        .handlesSceneLifecycle(with: appModel)
    } else {
      ContentUnavailableView {
        Label("Dash couldn't start", systemImage: "exclamationmark.triangle")
      } description: {
        Text("Check available storage, then try again. Your gateway data has not been changed.")
      } actions: {
        Button("Retry") { launch.retry() }
          .frame(minWidth: 44, minHeight: 44)
      }
      .accessibilityElement(children: .contain)
    }
  }
}
