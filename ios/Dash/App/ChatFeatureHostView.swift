import SwiftUI

/// Loads (or reuses) the `ChatFeature` for one conversation and hosts
/// `ChatView` on it. Lifted out of `RootView` and made internal in Task 10
/// (multi-window): the chat-only scene `ConversationWindowView` puts on
/// screen is the SAME host, so a conversation open in both the main window's
/// detail column and its own window resolves to the one cached
/// `AppModel.chatFeatures` instance and streams into both at once.
@MainActor
struct ChatFeatureHostView: View {
  @Bindable var appModel: AppModel
  let conversation: ConversationSummaryDTO
  /// Threaded down to `ChatView`'s ⌘W command — see its `onClose` doc
  /// comment. Owned by the host because "close this conversation" means
  /// something different in each scene: deselect in the main window, close
  /// the window in `ConversationWindowView`.
  let onClose: () -> Void

  @State private var feature: ChatFeature?
  @State private var didFailToLoad = false

  var body: some View {
    Group {
      if let feature {
        ChatView(onClose: onClose)
          .environment(feature)
          .id(ObjectIdentifier(feature))
      } else if didFailToLoad {
        ContentUnavailableView(
          "Chat unavailable",
          systemImage: "exclamationmark.bubble",
          description: Text("Check this gateway's connection and try again.")
        )
        .navigationTitle(conversation.title)
      } else {
        ProgressView("Opening conversation")
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .navigationTitle(conversation.title)
      }
    }
    .task(
      id: ChatHostTaskID(
        conversationID: conversation.id,
        appGeneration: appModel.chatHostGeneration
      )
    ) {
      feature = nil
      didFailToLoad = false
      let loaded = await appModel.makeChatFeature(conversation)
      guard Task.isCancelled == false else { return }
      feature = loaded
      didFailToLoad = loaded == nil
    }
    .onChange(of: appModel.connectionState) { _, connection in
      feature?.setConnection(connection)
      if connection == .online, let feature {
        Task { await feature.connectionDidBecomeOnline() }
      }
    }
  }
}

private struct ChatHostTaskID: Equatable {
  let conversationID: String
  let appGeneration: UInt64
}
