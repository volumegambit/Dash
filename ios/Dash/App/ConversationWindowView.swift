import SwiftUI

/// Root of a chat-only window opened from "Open in New Window" (design
/// §3.2). Shares the ONE `AppModel` the main window composed — `AppLaunch`
/// builds it once in `init` and `DashApp` hands the same instance to both
/// scenes — so a turn streaming in one window is the same `ChatFeature`
/// streaming in the other, not a second connection to the same gateway.
///
/// `value` is optional because SwiftUI hands `nil` for a window restored
/// with no persisted value (or one opened by `openWindow(id:)` with no
/// value at all); the gateway check alongside it is what stops a window
/// restored under a DIFFERENT signed-in gateway from showing a conversation
/// that no longer belongs to the user.
struct ConversationWindowView: View {
  @Bindable var launch: AppLaunch
  let value: ConversationWindowValue?

  @Environment(\.dismissWindow) private var dismissWindow

  var body: some View {
    if let appModel = launch.appModel {
      NavigationStack {
        if let value, appModel.selectedProfile?.gatewayID == value.gatewayID,
          let conversation = appModel.conversationSummary(id: value.conversationID)
        {
          // ⌘W closes THIS window rather than reaching into the main
          // window's selection (whole-branch final review, blocking 2).
          ChatFeatureHostView(appModel: appModel, conversation: conversation) {
            dismissWindow()
          }
        } else {
          // Review fix round 1 (Important 1): the old copy told the user to
          // "Open it from the main Dash window" while affording no way to do
          // that. This branch is reachable while shipping — relaunch signed
          // out, and `selectedProfile` is nil — so it needs a real way out,
          // not just instructions. `dismissWindow` is already bound above;
          // closing this dead scene reveals the main window underneath it.
          ContentUnavailableView {
            Label("Conversation unavailable", systemImage: "bubble.left.and.bubble.right")
          } description: {
            Text("Open it from the main Dash window.")
          } actions: {
            Button("Show Main Window") {
              dismissWindow()
            }
            .accessibilityIdentifier("conversationWindow.showMainWindow")
          }
        }
      }
      .environment(appModel)
      // Idempotent: `AppModel.start()` returns immediately once a profile
      // and sync engine are published, so the second scene arriving after
      // the main window has already started re-enters and no-ops rather
      // than tearing down and re-publishing a live session.
      .task { await appModel.start() }
      // UI-test harness hygiene only — see
      // `ConversationWindowSceneGuard`. A no-op in every shipping build and
      // in any run that actually opened this window on purpose.
      .task { ConversationWindowSceneGuard.dismissIfRestored(dismissWindow) }
      // Task 9: registers THIS scene in `activeSceneIDs`, so backgrounding
      // the main window while this one is on screen no longer suspends
      // syncing, and closing this window releases only its own id.
      .handlesSceneLifecycle(with: appModel)
      .tint(DashTheme.accent)
    } else {
      ProgressView()
    }
  }
}

/// Closes a conversation window that iPadOS RESTORED from a previous run's
/// scene session, and ONLY under a UI-test scenario (the check lives in
/// `UITestProbe.isRunningUITestScenario`, which is `#if DEBUG`).
///
/// "Restored" is decided without guessing at scene metadata: `noteOpened()`
/// is called on the one code path that deliberately creates a conversation
/// window (`ConversationListView`'s "Open in New Window"), so a
/// `ConversationWindowView` that appears while this process has never asked
/// for one can only have come from the system replaying an old session.
/// That keeps `IPadUITests.testOpenInNewWindowShowsASecondTranscript`
/// honest: in the process that taps the menu item, the flag is already true
/// before `openWindow` runs, so the window it opens is never dismissed and
/// every assertion in that test is made against a real second scene.
@MainActor
enum ConversationWindowSceneGuard {
  private static var didOpenInThisProcess = false

  /// Call immediately BEFORE `openWindow(value:)`, so the flag is set by the
  /// time the new scene's view runs its `.task`.
  static func noteOpened() {
    didOpenInThisProcess = true
  }

  static func dismissIfRestored(_ dismissWindow: DismissWindowAction) {
    #if DEBUG
      guard UITestProbe.isRunningUITestScenario, didOpenInThisProcess == false else { return }
      dismissWindow()
    #endif
  }
}
