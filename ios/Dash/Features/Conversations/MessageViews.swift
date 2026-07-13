import SwiftUI
import UIKit

struct MessageListView: View {
  let messages: [ChatMessageState]
  let onAnswer: (String, String) -> Void

  init(
    messages: [ChatMessageState],
    onAnswer: @escaping (String, String) -> Void = { _, _ in }
  ) {
    self.messages = messages
    self.onAnswer = onAnswer
  }

  var body: some View {
    LazyVStack(spacing: 16) {
      ForEach(messages) { message in
        ChatMessageView(message: message, onAnswer: onAnswer)
      }
    }
  }
}

struct ChatMessageView: View {
  let message: ChatMessageState
  let onAnswer: (String, String) -> Void

  init(
    message: ChatMessageState,
    onAnswer: @escaping (String, String) -> Void = { _, _ in }
  ) {
    self.message = message
    self.onAnswer = onAnswer
  }

  var body: some View {
    HStack(alignment: .top) {
      if message.role == .user {
        Spacer(minLength: 44)
      }

      messageContent
        .padding(12)
        .background(bubbleBackground, in: RoundedRectangle(cornerRadius: 16))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(message.accessibilityStatusLabel)

      if message.role == .assistant {
        Spacer(minLength: 44)
      }
    }
    .frame(maxWidth: .infinity)
  }

  @ViewBuilder
  private var messageContent: some View {
    switch message.role {
    case .user:
      if let user = message.user {
        UserMessageView(message: user)
      }
    case .assistant:
      if let assistant = message.assistant {
        AssistantEventViews(
          projection: assistant,
          onAnswer: onAnswer,
          exposesResponseToAccessibility: message.exposesAssistantTextToAccessibility
        )
      }
    }
  }

  private var bubbleBackground: Color {
    message.role == .user ? DashTheme.accent.opacity(0.14) : Color.secondary.opacity(0.1)
  }
}

extension ChatMessageState {
  var accessibilityStatusLabel: String {
    let role = role == .user ? "User" : "Assistant"
    let status =
      switch status {
      case .accepted: "accepted"
      case .streaming: "streaming"
      case .completed: "completed"
      case .cancelled: "cancelled"
      case .failed: "failed"
      case .interrupted: "interrupted"
      }
    return "\(role) message, \(status)"
  }

  var exposesAssistantTextToAccessibility: Bool {
    guard role == .assistant else { return true }
    return switch status {
    case .accepted, .streaming:
      false
    case .completed, .cancelled, .failed, .interrupted:
      true
    }
  }
}

private struct UserMessageView: View {
  let message: UserMessageProjection

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      if !message.text.isEmpty {
        Text(message.text)
          .textSelection(.enabled)
      }

      if !message.images.isEmpty {
        ScrollView(.horizontal) {
          HStack(spacing: 8) {
            ForEach(Array(message.images.enumerated()), id: \.offset) { _, image in
              MessageImageView(image: image)
            }
          }
        }
        .scrollIndicators(.hidden)
      }
    }
  }
}

private struct MessageImageView: View {
  let image: MessageImage

  var body: some View {
    Group {
      if let data = Data(base64Encoded: image.data),
        let uiImage = UIImage(data: data)
      {
        Image(uiImage: uiImage)
          .resizable()
          .scaledToFill()
      } else {
        Label("Image unavailable", systemImage: "photo.badge.exclamationmark")
          .labelStyle(.iconOnly)
          .foregroundStyle(.secondary)
      }
    }
    .frame(width: 88, height: 88)
    .background(Color.secondary.opacity(0.08))
    .clipShape(RoundedRectangle(cornerRadius: 10))
    .accessibilityLabel("Attached image")
  }
}
