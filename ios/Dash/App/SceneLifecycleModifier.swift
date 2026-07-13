import SwiftUI

struct SceneLifecycleModifier: ViewModifier {
  @Environment(\.scenePhase) private var scenePhase
  @State private var wasBackgrounded = false
  @State private var transitionTask: Task<Void, Never>?

  let appModel: AppModel

  func body(content: Content) -> some View {
    content.onChange(of: scenePhase) { _, phase in
      switch phase {
      case .background:
        wasBackgrounded = true
        enqueue { await appModel.sceneDidEnterBackground() }
      case .active where wasBackgrounded:
        wasBackgrounded = false
        enqueue { await appModel.sceneWillEnterForeground() }
      case .active, .inactive:
        break
      @unknown default:
        break
      }
    }
  }

  private func enqueue(_ operation: @escaping @MainActor @Sendable () async -> Void) {
    let preceding = transitionTask
    transitionTask = Task {
      await preceding?.value
      guard Task.isCancelled == false else { return }
      await operation()
    }
  }
}

extension View {
  func handlesSceneLifecycle(with appModel: AppModel) -> some View {
    modifier(SceneLifecycleModifier(appModel: appModel))
  }
}
