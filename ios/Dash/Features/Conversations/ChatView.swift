import SwiftUI

struct ChatView: View {
  @Environment(ChatFeature.self) private var feature
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  @State private var isNearBottom = true

  private let bottomID = "chat-bottom"

  var body: some View {
    VStack(spacing: 0) {
      if let presentation = feature.statusPresentation {
        ChatStatusBanner(presentation: presentation) {
          Task { await feature.retryConnection() }
        }
      } else if feature.isAuthoritative == false, feature.state.messages.isEmpty == false {
        CachedTranscriptBanner()
      }

      transcript
    }
    .safeAreaInset(edge: .bottom, spacing: 0) {
      ComposerView()
    }
    .navigationTitle(feature.state.conversation.title)
    .navigationBarTitleDisplayMode(.inline)
    .task {
      await feature.appear()
    }
    .onDisappear {
      Task { await feature.disappear() }
    }
  }

  private var transcript: some View {
    ScrollViewReader { proxy in
      scrollView
        .onAppear {
          scrollToBottom(proxy, animated: false)
        }
        .onChange(of: transcriptSignature) { oldValue, newValue in
          guard oldValue != newValue, isNearBottom else { return }
          scrollToBottom(proxy, animated: true)
        }
    }
  }

  @ViewBuilder
  private var scrollView: some View {
    if #available(iOS 18.0, *) {
      transcriptScrollView
        .onScrollGeometryChange(for: Bool.self) { geometry in
          geometry.visibleRect.maxY >= geometry.contentSize.height - 100
        } action: { _, nearBottom in
          isNearBottom = nearBottom
        }
    } else {
      transcriptScrollView
    }
  }

  private var transcriptScrollView: some View {
    ScrollView {
      LazyVStack(spacing: 16) {
        olderMessagesControl

        if feature.isLoadingInitial, feature.state.messages.isEmpty {
          ProgressView("Loading conversation")
            .frame(maxWidth: .infinity, minHeight: 160)
        } else if feature.state.messages.isEmpty {
          ContentUnavailableView(
            "No messages yet",
            systemImage: "bubble.left.and.text.bubble.right",
            description: Text("Send a message to start this conversation.")
          )
          .frame(maxWidth: .infinity, minHeight: 260)
        } else {
          MessageListView(
            messages: feature.state.messages,
            isAnsweringEnabled: feature.canAnswerQuestions
          ) { questionID, answer in
            Task { await feature.answer(questionID: questionID, answer: answer) }
          }
        }

        Color.clear
          .frame(height: 1)
          .id(bottomID)
      }
      .frame(maxWidth: 760)
      .padding(.horizontal)
      .padding(.vertical, 12)
      .frame(maxWidth: .infinity)
    }
    .scrollDismissesKeyboard(.interactively)
    .defaultScrollAnchor(.bottom)
    .accessibilityIdentifier("chat.transcript")
  }

  @ViewBuilder
  private var olderMessagesControl: some View {
    if feature.state.olderCursor != nil {
      Button {
        Task { await feature.loadOlder() }
      } label: {
        if feature.state.isLoadingOlder {
          ProgressView()
            .frame(minWidth: 44, minHeight: 44)
        } else {
          Label("Load earlier messages", systemImage: "arrow.up.circle")
            .frame(minHeight: 44)
        }
      }
      .disabled(feature.state.isLoadingOlder)
      .accessibilityIdentifier("chat.loadOlder")
    }
  }

  private var transcriptSignature: String {
    var parts: [String] = []
    parts.reserveCapacity(feature.state.messages.count)
    for message in feature.state.messages {
      let assistant = message.assistant
      let status = String(describing: message.status)
      let textCount = assistant?.text.count ?? 0
      let thinkingCount = assistant?.thinking.count ?? 0
      let toolCount = assistant?.toolCards.count ?? 0
      let workerCount = assistant?.workerCards.count ?? 0
      let rowCount = assistant?.statusRows.count ?? 0
      parts.append(
        "\(message.id):\(status):\(textCount):\(thinkingCount):\(toolCount):\(workerCount):\(rowCount)"
      )
    }
    return parts.joined(separator: "|")
  }

  private func scrollToBottom(_ proxy: ScrollViewProxy, animated: Bool) {
    let operation = {
      proxy.scrollTo(bottomID, anchor: .bottom)
    }
    guard animated, reduceMotion == false else {
      operation()
      return
    }
    withAnimation(.easeOut(duration: 0.2), operation)
  }
}

private struct CachedTranscriptBanner: View {
  var body: some View {
    Label("Showing saved messages while Dash checks for updates", systemImage: "internaldrive")
      .font(.callout)
      .foregroundStyle(.secondary)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.horizontal)
      .padding(.vertical, 8)
      .background(.bar)
      .accessibilityElement(children: .combine)
  }
}

private struct ChatStatusBanner: View {
  let presentation: ChatStatusPresentation
  let onRetry: () -> Void

  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: icon)
        .accessibilityHidden(true)

      VStack(alignment: .leading, spacing: 2) {
        Text(title)
          .font(.callout.weight(.semibold))
        detail
          .font(.caption)
      }

      Spacer(minLength: 8)

      if canRetry {
        Button("Retry", action: onRetry)
          .frame(minWidth: 44, minHeight: 44)
      }
    }
    .foregroundStyle(foregroundStyle)
    .padding(.horizontal)
    .padding(.vertical, 6)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(backgroundStyle)
    .accessibilityElement(children: .contain)
  }

  private var title: String {
    switch presentation {
    case .recoveryRequired:
      "Message saved for recovery"
    case .reconnecting:
      "Reconnecting"
    case .offline:
      "You're offline"
    case .gatewayOffline:
      "Gateway unavailable"
    case .rateLimited:
      "Sending is paused"
    case .repairRequired:
      "Re-pair this gateway"
    case .updateRequired:
      "Update Dash to continue"
    case .failed:
      "Conversation update failed"
    }
  }

  @ViewBuilder
  private var detail: some View {
    switch presentation {
    case .recoveryRequired:
      Text("Open Conversations to copy the message, share its attachments, or discard it.")
    case .reconnecting(let attempt):
      Text("Attempt \(attempt). Saved messages remain available.")
    case .offline:
      Text("Saved messages and your draft remain available.")
    case .gatewayOffline:
      Text("The gateway isn't responding. Try again when it's available.")
    case .rateLimited(let retryAt):
      Text("Try again ") + Text(retryAt, style: .relative) + Text(".")
    case .repairRequired:
      Text("Your credentials are no longer accepted. Saved messages remain available.")
    case .updateRequired:
      Text("This gateway requires a newer version of the app.")
    case .failed(let message):
      Text(message)
    }
  }

  private var icon: String {
    switch presentation {
    case .recoveryRequired: "archivebox"
    case .reconnecting: "arrow.triangle.2.circlepath"
    case .offline: "wifi.slash"
    case .gatewayOffline: "server.rack"
    case .rateLimited: "clock"
    case .repairRequired: "key.slash"
    case .updateRequired: "arrow.down.app"
    case .failed: "exclamationmark.triangle"
    }
  }

  private var canRetry: Bool {
    switch presentation {
    case .failed:
      true
    case .recoveryRequired, .reconnecting, .offline, .gatewayOffline, .rateLimited,
      .repairRequired, .updateRequired:
      false
    }
  }

  private var foregroundStyle: Color {
    switch presentation {
    case .repairRequired, .updateRequired, .failed:
      .red
    case .recoveryRequired, .reconnecting, .offline, .gatewayOffline, .rateLimited:
      .primary
    }
  }

  private var backgroundStyle: Color {
    switch presentation {
    case .repairRequired, .updateRequired, .failed:
      Color.red.opacity(0.12)
    case .recoveryRequired, .reconnecting, .offline, .gatewayOffline, .rateLimited:
      Color.orange.opacity(0.12)
    }
  }
}
