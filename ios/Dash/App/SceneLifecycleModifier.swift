import SwiftUI

/// Pure phase-to-intent table for `SceneLifecycleModifier`. Extracted so the
/// `.onChange(initial: true)` arms and the `.onDisappear` release can be unit
/// tested directly, without going through SwiftUI scene machinery — see
/// `SceneLifecycleDecisionTests`.
enum SceneLifecycleDecision {
  /// What a scene-phase value means for `AppModel.sceneChanged`: `nil` is a
  /// no-op (`.inactive`); otherwise the value to pass as `isActive`. This is
  /// invariant to *why* it's being evaluated — the same table applies
  /// whether the phase arrived via an ordinary change or via
  /// `.onChange(initial: true)` replaying the phase already current at
  /// mount, which is what makes attaching mid-session (e.g. after a cold
  /// launch reaches `.active` before the modifier mounts) safe: `.active`
  /// still registers, and `.background` still routes to a release (a
  /// harmless no-op if the scene was never registered).
  static func isActive(for phase: ScenePhase) -> Bool? {
    switch phase {
    case .active:
      return true
    case .background:
      return false
    case .inactive:
      return nil
    @unknown default:
      return nil
    }
  }

  /// A scene's `.onDisappear` always means release: a closed window's scene
  /// never transitions through `.background` on its way out (design §3.2),
  /// so without this the closed scene's id would linger in `activeSceneIDs`
  /// forever and the engine would never see the set go empty.
  static let onDisappear: Bool = false
}

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
      // from the start; `.inactive` at mount is still a no-op via the table.
      .onChange(of: scenePhase, initial: true) { _, phase in
        guard let isActive = SceneLifecycleDecision.isActive(for: phase) else { return }
        enqueue { await appModel.sceneChanged(id: sceneID, isActive: isActive) }
      }
      .onDisappear {
        enqueue {
          await appModel.sceneChanged(id: sceneID, isActive: SceneLifecycleDecision.onDisappear)
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
