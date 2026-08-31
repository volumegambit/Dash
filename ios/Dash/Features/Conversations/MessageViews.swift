import SwiftUI
import UIKit

/// Turn ids whose assistant reply failed (chat-ux Phase 2, Task 4 / audit
/// #5's message actions). "Failed" is only ever recorded on the
/// assistant/turn side — never directly on the user message
/// (`ChatReducer.reduceFrame`'s `.error` case, mirrored server-side by the
/// gateway's `finishTurn`) — so a user bubble's Retry affordance is derived
/// by checking whether ITS turn shows up here, not by inspecting the user
/// message's own `status` (which only ever reaches `.accepted`, never
/// `.failed`). Internal (not `private`) so `DashTests` can exercise it
/// directly without rendering SwiftUI, same pattern as
/// `ChatTranscriptSignature`/`ChatScrollGeometry` in `ChatView.swift`.
func failedTurnIDs(in messages: [ChatMessageState]) -> Set<String> {
  Set(messages.compactMap { $0.role == .assistant && $0.status == .failed ? $0.turnID : nil })
}

/// The user message id that started `turnID`, for a failed assistant
/// bubble's inline Retry button to resolve which message
/// `ChatFeature.resendFromMessage` should target — it always resends a USER
/// message, never the assistant reply itself (regenerating an assistant
/// turn in place is out of scope; see `resendFromMessage`'s doc comment).
func userMessageID(forTurnID turnID: String, in messages: [ChatMessageState]) -> String? {
  messages.first { $0.role == .user && $0.turnID == turnID }?.id
}

struct MessageListView: View {
  let messages: [ChatMessageState]
  let isAnsweringEnabled: Bool
  let onAnswer: (String, String) -> Void
  let onRetry: (String) -> Void
  let onEditAndResend: (String) -> Void

  init(
    messages: [ChatMessageState],
    isAnsweringEnabled: Bool = true,
    onAnswer: @escaping (String, String) -> Void = { _, _ in },
    onRetry: @escaping (String) -> Void = { _ in },
    onEditAndResend: @escaping (String) -> Void = { _ in }
  ) {
    self.messages = messages
    self.isAnsweringEnabled = isAnsweringEnabled
    self.onAnswer = onAnswer
    self.onRetry = onRetry
    self.onEditAndResend = onEditAndResend
  }

  var body: some View {
    let failedTurns = failedTurnIDs(in: messages)
    LazyVStack(spacing: 16) {
      ForEach(messages) { message in
        ChatMessageView(
          message: message,
          isAnsweringEnabled: isAnsweringEnabled,
          isFailedTurn: message.role == .user && failedTurns.contains(message.turnID),
          retryTargetID: message.role == .assistant && message.status == .failed
            ? userMessageID(forTurnID: message.turnID, in: messages) : nil,
          onAnswer: onAnswer,
          onRetry: onRetry,
          onEditAndResend: onEditAndResend
        )
      }
    }
  }
}

struct ChatMessageView: View {
  let message: ChatMessageState
  let isAnsweringEnabled: Bool
  /// True when this is a `.user` message whose turn's assistant reply
  /// failed — offers Retry in the context menu. Meaningless for `.assistant`
  /// rows (see `retryTargetID` instead).
  let isFailedTurn: Bool
  /// Non-nil only for a `.assistant` row whose own `status == .failed`: the
  /// user message id its inline Retry button should resend.
  let retryTargetID: String?
  let onAnswer: (String, String) -> Void
  let onRetry: (String) -> Void
  let onEditAndResend: (String) -> Void

  init(
    message: ChatMessageState,
    isAnsweringEnabled: Bool = true,
    isFailedTurn: Bool = false,
    retryTargetID: String? = nil,
    onAnswer: @escaping (String, String) -> Void = { _, _ in },
    onRetry: @escaping (String) -> Void = { _ in },
    onEditAndResend: @escaping (String) -> Void = { _ in }
  ) {
    self.message = message
    self.isAnsweringEnabled = isAnsweringEnabled
    self.isFailedTurn = isFailedTurn
    self.retryTargetID = retryTargetID
    self.onAnswer = onAnswer
    self.onRetry = onRetry
    self.onEditAndResend = onEditAndResend
  }

  var body: some View {
    HStack(alignment: .top, spacing: 0) {
      switch message.role {
      case .user:
        // User keeps the bubble: right-aligned, accent-tinted background,
        // rounded corners, held off the leading edge by a min-width spacer.
        Spacer(minLength: 44)
        if let user = message.user {
          UserMessageView(message: user)
            .padding(12)
            .background(DashTheme.accent.opacity(0.14), in: RoundedRectangle(cornerRadius: 16))
            .contextMenu { userContextMenuItems(user) }
            .accessibilityElement(children: .contain)
            .accessibilityLabel(message.accessibilityStatusLabel)
            .accessibilityIdentifier("chat.message.\(message.id)")
        }

      case .assistant:
        // De-bubbled (world-class UX audit ruling, binding for iOS): no
        // background and no trailing spacer — the assistant's response
        // renders full-bleed within the column instead of a bordered card.
        // This is a deliberate iOS divergence from the MC web reference,
        // whose ToolBlock/assistant bubble treatment (design doc appendix
        // §6) keeps the `bg-[#141414] border-2` card.
        if let assistant = message.assistant {
          VStack(alignment: .leading, spacing: 8) {
            AssistantEventViews(
              projection: assistant,
              status: message.status,
              isAnsweringEnabled: isAnsweringEnabled,
              onAnswer: onAnswer,
              exposesResponseToAccessibility: message.exposesAssistantTextToAccessibility
            )

            // Inline Retry (chat-ux Phase 2, Task 4 / audit #5): shown
            // directly on the failed bubble, in addition to Retry being
            // reachable from the originating user bubble's context menu.
            if message.status == .failed, let retryTargetID {
              InlineRetryButton(targetMessageID: retryTargetID) {
                onRetry(retryTargetID)
              }
            }
          }
          .padding(.vertical, 12)
          .frame(maxWidth: .infinity, alignment: .leading)
          .contextMenu { assistantContextMenuItems(assistant) }
          .accessibilityElement(children: .contain)
          .accessibilityLabel(message.accessibilityStatusLabel)
          .accessibilityIdentifier("chat.message.\(message.id)")
          // Haptics (chat-ux Phase 2, audit #7): success/error on this
          // message's own terminal transition — nil→cancelled/interrupted
          // deliberately fire nothing, matching the chrome-trim principle
          // (audit #17) that only completed/failed need a reaction.
          .sensoryFeedback(trigger: assistant.terminal) { _, newValue in
            switch newValue {
            case .completed: .success
            case .failed: .error
            case .cancelled, .interrupted, nil: nil
            }
          }
        }
      }
    }
    .frame(maxWidth: .infinity)
  }

  @ViewBuilder
  private func userContextMenuItems(_ user: UserMessageProjection) -> some View {
    if !user.text.isEmpty {
      Button {
        UIPasteboard.general.string = user.text
      } label: {
        Label("Copy", systemImage: "doc.on.doc")
      }
      ShareLink(item: user.text) {
        Label("Share", systemImage: "square.and.arrow.up")
      }
    }
    Button {
      onEditAndResend(message.id)
    } label: {
      Label("Edit & Resend", systemImage: "pencil")
    }
    if isFailedTurn {
      Button {
        onRetry(message.id)
      } label: {
        Label("Retry", systemImage: "arrow.clockwise")
      }
    }
  }

  @ViewBuilder
  private func assistantContextMenuItems(_ assistant: AssistantMessageProjection) -> some View {
    if !assistant.text.isEmpty {
      let plainText = markdownPlainTextAccessibilityLabel(for: assistant.text)
      Button {
        UIPasteboard.general.string = plainText
      } label: {
        Label("Copy", systemImage: "doc.on.doc")
      }
      ShareLink(item: plainText) {
        Label("Share", systemImage: "square.and.arrow.up")
      }
    }
  }
}

/// Inline Retry affordance on a failed assistant bubble (chat-ux Phase 2,
/// Task 4 / audit #5) — a visible, no-long-press-required alternative to the
/// context-menu Retry on the originating user bubble. `targetMessageID` is
/// always a USER message id (see `userMessageID(forTurnID:in:)`), since
/// `ChatFeature.resendFromMessage` resends the user turn, not the assistant
/// reply.
private struct InlineRetryButton: View {
  let targetMessageID: String
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Label("Retry", systemImage: "arrow.clockwise")
        .font(.footnote.weight(.semibold))
    }
    .buttonStyle(.bordered)
    .tint(.red)
    .frame(minHeight: 44)
    .accessibilityLabel("Retry sending this message")
    .accessibilityIdentifier("chat.message.\(targetMessageID).retry")
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
