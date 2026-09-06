import SwiftUI

struct SceneLifecycleModifier: ViewModifier {
  @Environment(\.scenePhase) private var scenePhase
  @State private var sceneID = UUID()
  @State private var transitionTask: Task<Void, Never>?

  let appModel: AppModel

  func body(content: Content) -> some View {
    content
      // `initial: true` (rather than the brief's plain `onChange`): without
      // it, a bare `.onChange` never fires for the phase already in effect
      // when this scene first mounts (typically `.active`), so this scene's
      // id would never enter `activeSceneIDs` and its FIRST real
      // `.background` would be a same-count no-op — the engine would miss
      // suspending on the very first background of a cold launch. Firing
      // once on mount with whatever phase is current keeps the set accurate
      // from the start; `.inactive` at mount is still a no-op via the switch.
      .onChange(of: scenePhase, initial: true) { _, phase in
        switch phase {
        case .active:
          enqueue { await appModel.sceneChanged(id: sceneID, isActive: true) }
        case .background:
          enqueue { await appModel.sceneChanged(id: sceneID, isActive: false) }
        case .inactive:
          break
        @unknown default:
          break
        }
      }
      .onDisappear {
        // Multi-window (design §3.2): a closed window's scene never
        // transitions to `.background` — it just goes away — so without
        // this the closed scene's id would linger in `activeSceneIDs`
        // forever and the engine would never see the set go empty.
        enqueue { await appModel.sceneChanged(id: sceneID, isActive: false) }
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
