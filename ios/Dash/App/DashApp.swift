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
        // The honest reason, not a fixed guess: a build that was never pointed
        // at a control plane says so (and how to fix it) instead of sending
        // the user off to free up disk space that was never the problem. See
        // `AppLaunch.message(for:)`.
        Text(launch.errorMessage ?? AppLaunch.storageFailureMessage)
      } actions: {
        Button("Retry") { launch.retry() }
          .frame(minWidth: 44, minHeight: 44)
      }
      .accessibilityElement(children: .contain)
    }
  }
}
