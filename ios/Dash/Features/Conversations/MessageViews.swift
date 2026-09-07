import CoreTransferable
import SwiftUI
import UIKit
import UniformTypeIdentifiers

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
  /// When set, the FIRST row reports its frame in this named coordinate
  /// space through `FirstMessageRowFrameKey` — `ChatView`'s "Load earlier"
  /// hold needs to know where the row the user is reading sits in the
  /// viewport before a page prepends above it.
  let firstRowFrameCoordinateSpace: String?
  let isAnsweringEnabled: Bool
  /// Scroll anchor (iPad goal Phase A, Task 4 review fix, Important 1):
  /// tags THIS view's stack — the one that actually holds
  /// `ForEach(messages)` — as the enclosing `ScrollView`'s scroll-target
  /// layout, so `ChatView`'s `.scrollPosition(id:anchor:)` binding resolves
  /// real row identities. NOTE (merge with main, 2026-09-07): that identity
  /// is now `ChatMessageState.rowID`, not `.id` — main re-keyed the `ForEach`
  /// so the gateway ack rewriting `id` stops removing and re-inserting the
  /// row — so everything `scrollPosition` reports and everything
  /// `scrollTo` matches is a `rowID`. `ChatView.anchorBinding` and
  /// `ChatScrollRestoration.decide` were repointed to match. It previously
  /// sat on `ChatView`'s OUTER stack, whose direct arranged children are only
  /// `olderMessagesControl` / this whole view as one opaque box / the bottom
  /// sentinel; `scrollTargetLayout()` does not descend into a nested
  /// `LazyVStack` inside a custom `View` struct. Measured consequence (see
  /// the task-4 report): with the tag on the outer stack the RESTORE
  /// direction still worked — `.scrollPosition(id:)` will scroll to any
  /// `.id()`-tagged view in the scroll view — but the TRACKING direction was
  /// dead, so `scrollAnchorMessageID` stayed `nil` forever and there was
  /// never anything to restore.
  /// Opt-in (default `false`) rather than unconditional because it is only
  /// meaningful inside a `ScrollView` that reads it; `ChatView`'s transcript
  /// is the one place that does.
  let isScrollTarget: Bool
  let onAnswer: (String, String) -> Void
  let onRetry: (String) -> Void
  let onEditAndResend: (String) -> Void

  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  init(
    messages: [ChatMessageState],
    firstRowFrameCoordinateSpace: String? = nil,
    isAnsweringEnabled: Bool = true,
    isScrollTarget: Bool = false,
    onAnswer: @escaping (String, String) -> Void = { _, _ in },
    onRetry: @escaping (String) -> Void = { _ in },
    onEditAndResend: @escaping (String) -> Void = { _ in }
  ) {
    self.messages = messages
    self.firstRowFrameCoordinateSpace = firstRowFrameCoordinateSpace
    self.isAnsweringEnabled = isAnsweringEnabled
    self.isScrollTarget = isScrollTarget
    self.onAnswer = onAnswer
    self.onRetry = onRetry
    self.onEditAndResend = onEditAndResend
  }

  var body: some View {
    let failedTurns = failedTurnIDs(in: messages)
    // A plain VStack, not LazyVStack (transcript scroll fix, 2026-09-05): a
    // lazy stack's content size is an estimate until rows realize, and every
    // scroll mechanism above this view — the bottom anchor that follows a
    // stream, the initial-offset anchor that opens on the newest message,
    // `scrollTo` for jump-to-latest and for holding position across "Load
    // earlier" — computes against that size. With the estimate they landed
    // a turn short on open and, on send, scrolled past the end into blank
    // space (both seen on the iOS 26.5 sim). A page is at most 50 messages
    // (`ChatFeature`'s `limit: 50`) and grows only by explicit "Load
    // earlier", so exact geometry is affordable.
    VStack(spacing: 16) {
      // Keyed on `rowID`, not `id` (transcript scroll fix, 2026-09-05): the
      // gateway's `accepted` frame rewrites `id` from the local uuid to the
      // server's, and keying on it made SwiftUI remove + re-insert the row
      // the user just sent — replaying the entrance transition below and
      // resetting the row's `@State`. See `ChatMessageState.rowID`.
      ForEach(messages, id: \.rowID) { message in
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
        // Entrance animation (chat-ux Phase 3 Task 4, audit #18): a fresh
        // row (new `ChatMessageState.rowID`, `ForEach`'s identity) fades+rises
        // in rather than popping in place — never re-triggered by an
        // in-place content update to an EXISTING row (streamed
        // text/tool-card deltas mutate that row's own properties, they
        // don't change `messages`' identity list), since SwiftUI only
        // applies `.transition` to genuine insertions/removals it diffs
        // against the PREVIOUS `messages` array. `.identity` under reduce
        // motion is a real no-op transition (no fade, no offset) rather
        // than merely suppressing the `.animation` driving it below —
        // belt-and-suspenders with the `reduceMotion ? nil : .default`
        // gate, same "guard, then withAnimation-equivalent" idiom
        // `ChatView.scrollToBottom` uses for the jump-to-bottom scroll.
        .transition(
          reduceMotion
            ? .identity
            : .opacity.combined(with: .move(edge: .bottom))
        )
        .background(firstRowFrameReporter(for: message))
      }
    }
    .modifier(ScrollTargetLayoutIfNeeded(isEnabled: isScrollTarget))
    // `messageEntranceSignature(for:)` (review fix, chat-ux Phase 3 Task 4,
    // audit #18) — NOT `messages` itself (would animate on every streamed
    // token mutating the LAST message's own properties) and NOT
    // `messages.count`/`messages.map(\.id)` either: `.animation(value:)`
    // fires whenever this value differs from the PREVIOUS render's, and a
    // `Load Earlier` pagination prepend (`ChatReducer`'s
    // `.olderMessagesLoaded` case) grows `count` without changing which
    // message is LAST — a count-inclusive signature incorrectly fired the
    // fade+rise transition for every already-visible row too, right where
    // the user was reading. Keying purely on the last message's id fixes
    // that: a prepend never changes it, so no animation; see the function's
    // own doc comment for why an append always does.
    .animation(reduceMotion ? nil : .default, value: messageEntranceSignature(for: messages))
  }
}

extension MessageListView {
  @ViewBuilder
  fileprivate func firstRowFrameReporter(for message: ChatMessageState) -> some View {
    if let space = firstRowFrameCoordinateSpace, message.rowID == messages.first?.rowID {
      GeometryReader { proxy in
        Color.clear.preference(
          key: FirstMessageRowFrameKey.self,
          value: proxy.frame(in: .named(space))
        )
      }
    }
  }
}

/// Applies `scrollTargetLayout()` only when the caller is inside a
/// `ScrollView` that uses `.scrollPosition(id:)` (iPad goal Phase A, Task 4
/// review fix, Important 1). A `ViewModifier` rather than an inline `if` in
/// the `ViewBuilder` so the stack's view identity — and therefore the
/// `ForEach` rows' `@State`/transition bookkeeping — is unaffected by the
/// flag.
private struct ScrollTargetLayoutIfNeeded: ViewModifier {
  let isEnabled: Bool

  @ViewBuilder
  func body(content: Content) -> some View {
    if isEnabled {
      content.scrollTargetLayout()
    } else {
      content
    }
  }
}

/// The `.animation(value:)` signal for `MessageListView`'s entrance
/// transition (review fix, chat-ux Phase 3 Task 4, audit #18) — SwiftUI
/// re-animates exactly when this differs from the value it computed on the
/// PREVIOUS render, so "which changes should animate" reduces to "which
/// mutations change this function's output":
///
/// - **Append** (optimistic send, a streamed reply finalizing into a new
///   row, edit & resend's truncate-then-resend) always changes which
///   message is last → output changes → animates. Correct: exactly the
///   genuinely-new row the user just caused to appear.
/// - **Prepend** (`ChatReducer`'s `.olderMessagesLoaded`, the "Load
///   Earlier" pagination the `chat.loadOlder` control in `ChatView.swift`
///   drives) grows `messages.count` but never touches the last element →
///   output unchanged → no animation. This is the actual review fix: the
///   previous version of this signature included `messages.count`, which
///   made a prepend indistinguishable from an append and fired the
///   fade+rise transition for every already-visible row too.
/// - **Status/content mutation to the last message** (a streamed token,
///   thinking/tool-card delta, a terminal status flip) doesn't change ITS
///   id → output unchanged → no animation, same as before this fix.
/// - **Empty → non-empty initial population** doesn't need special-casing
///   HERE: `ChatView.swift`'s `if feature.state.messages.isEmpty {
///   ContentUnavailableView } else { MessageListView(...) }` branch means
///   this view is only ever constructed once `messages` is already
///   non-empty. SwiftUI has no PREVIOUS render of this view to diff
///   against for that transition — the whole subtree is freshly inserted,
///   not individually-transitioning rows — regardless of what this
///   function returns for that first render.
///
/// Internal (not `private`) so `DashTests` can exercise the append/prepend/
/// initial-load distinction directly, same pattern as `failedTurnIDs`/
/// `userMessageID` above and `ChatTranscriptSignature` in `ChatView.swift`.
func messageEntranceSignature(for messages: [ChatMessageState]) -> String? {
  // `rowID`, not `id`: the ack rewriting the last row's id is the same row
  // (see `ChatMessageState.rowID`), so it must not read as an append.
  messages.last?.rowID
}

extension View {
  /// Applies `.draggable` only `when` the payload is worth offering — used
  /// so an image-only user message (empty `text`) doesn't advertise an
  /// empty-string drag payload, matching `userContextMenuItems`'s existing
  /// `if !user.text.isEmpty` gate on Copy/Share (review fix round 1, Minor
  /// 1). Plain `if`/`else` rather than a ternary since `.draggable` isn't
  /// itself optional-payload-aware.
  @ViewBuilder
  func draggable(_ payload: String, when condition: Bool) -> some View {
    if condition {
      draggable(payload)
    } else {
      self
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
    // A notice is bookkeeping, not conversation: it renders as a single quiet
    // chip regardless of the role it was stored under (the gateway's message
    // table allows only 'user' and 'assistant', so notices arrive as
    // 'assistant').
    if let notice = message.notice {
      return AnyView(
        HStack {
          NoticeChipView(notice: notice)
          Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("chat.notice.\(message.id)")
      )
    }

    return AnyView(bubble)
  }

  private var bubble: some View {
    HStack(alignment: .top, spacing: 0) {
      switch message.role {
      case .user:
        // User keeps the bubble: right-aligned, accent-tinted background,
        // rounded corners, held off the leading edge by a min-width spacer.
        Spacer(minLength: 44)
        if let user = message.user {
          UserMessageView(message: user)
            .padding(12)
            .background(DashTheme.accent.opacity(DashTheme.Opacity.fillEmphasis), in: RoundedRectangle(cornerRadius: DashTheme.Radius.large))
            // Drag out (iPad goal Phase B, Task 8; review fix round 1,
            // Important 1): co-located with `.contextMenu` on this SAME
            // view, matching the assistant case below. This used to live
            // inside `UserMessageView`'s own body, on an inner `VStack` one
            // level removed from the `.contextMenu` applied here — see
            // `task-8-report.md`'s "Fix round 1" section for why that was a
            // risk and how it was verified. Gated on non-empty text (Minor
            // 1), mirroring `userContextMenuItems`'s own Copy/Share gate two
            // lines below, so an image-only message doesn't offer an
            // empty-string drag payload.
            .draggable(user.text, when: !user.text.isEmpty)
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
          // Drag out (iPad goal Phase B, Task 8): the same flattened plain
          // text the Copy/Share context menu items below use
          // (`markdownPlainTextAccessibilityLabel`), not the raw markdown —
          // one flattener shared by both affordances, per the task brief.
          .draggable(markdownPlainTextAccessibilityLabel(for: assistant.text))
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
    .hoverEffect(.lift)
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
  // Phase 4 Task 4 (audit #19): the tapped thumbnail, presented full screen.
  @State private var viewerImage: ViewerImage?

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      if !message.text.isEmpty {
        Text(message.text)
          .textSelection(.enabled)
      }

      if !message.images.isEmpty {
        ScrollView(.horizontal) {
          HStack(spacing: 8) {
            ForEach(Array(message.images.enumerated()), id: \.offset) { index, image in
              MessageImageView(image: image, index: index) { uiImage in
                viewerImage = ViewerImage(id: index, image: uiImage)
              }
            }
          }
        }
        .scrollIndicators(.hidden)
      }
    }
    // Drag out (iPad goal Phase B, Task 8): lets the whole bubble's text be
    // dragged into another app (Notes, Mail, another window) or dropped
    // back into this app's own composer. Applied by the CALLER
    // (`ChatMessageView.body`'s `.user` case), co-located with
    // `.contextMenu`, not here — review fix round 1, Important 1.
    .fullScreenCover(item: $viewerImage) { item in
      ImageViewerView(image: item.image) { viewerImage = nil }
    }
  }
}

/// One attached-image thumbnail (audit #19): a button that opens the
/// full-screen `ImageViewerView` when the bytes decode; undecodable bytes
/// stay a static placeholder rather than a button that opens nothing.
private struct MessageImageView: View {
  let image: MessageImage
  let index: Int
  let onOpen: (UIImage) -> Void

  var body: some View {
    Group {
      if let data = Data(base64Encoded: image.data),
        let uiImage = UIImage(data: data)
      {
        Button {
          onOpen(uiImage)
        } label: {
          Image(uiImage: uiImage)
            .resizable()
            .scaledToFill()
            .frame(width: 88, height: 88)
            .clipShape(RoundedRectangle(cornerRadius: DashTheme.Radius.medium))
        }
        .buttonStyle(.plain)
        .hoverEffect(.lift)
        // Drag out (iPad goal Phase B, Task 8): drop targets like the
        // composer, Files, or another app get the decoded image bytes for
        // this message's own `mediaType`, not a re-derived guess.
        .draggable(DraggableMessageImage(image))
        .accessibilityLabel("Attached image \(index + 1)")
        .accessibilityHint("Opens full screen")
        // Renamed from `chat.image.<n>` (Task 7 handoff): the identifier
        // stays on this `Button`, not the inner `Image` — a SwiftUI `Button`
        // always vends ONE accessibility element of trait `.button` for its
        // label, so moving the identifier onto the `Image` would not make
        // `XCUIApplication.images` (which matches by `XCUIElementType`, not
        // by identifier prefix) start seeing it as an image. The UI test
        // queries this identifier through the type-agnostic
        // `app.descendants(matching: .any)`, the same pattern the test
        // already uses for its target-side `chat.attachment.0` assertion —
        // see `IPadUITests.testDroppingAnImageAttachesIt`.
        .accessibilityIdentifier("chat.message.image.\(index)")
      } else {
        Label("Image unavailable", systemImage: "photo.badge.exclamationmark")
          .labelStyle(.iconOnly)
          .foregroundStyle(.secondary)
          .frame(width: 88, height: 88)
          .accessibilityLabel("Attached image \(index + 1), unavailable")
      }
    }
    .background(Color.secondary.opacity(DashTheme.Opacity.fillSubtle))
    .clipShape(RoundedRectangle(cornerRadius: DashTheme.Radius.medium))
  }
}

/// A transcript image, offered as a drag payload out of the chat (iPad goal
/// Phase B, Task 8) — the drag-source counterpart to `DroppedImage`
/// (`DroppedImage.swift`), which is the drop-destination side. Base64-decodes
/// `MessageImage.data` once at construction, mirroring
/// `RecoveryAttachmentTransfer`'s `.exportingCondition`-per-type pattern
/// (`ConversationListView.swift`) rather than re-deriving the type from raw
/// bytes: `MessageImage.mediaType` is already the ground truth for this
/// message, same four types as the rest of the image-attachment contract.
struct DraggableMessageImage: Transferable, Sendable {
  let data: Data
  let mediaType: ImageMediaType

  init(_ image: MessageImage) {
    data = Data(base64Encoded: image.data) ?? Data()
    mediaType = image.mediaType
  }

  static var transferRepresentation: some TransferRepresentation {
    DataRepresentation(exportedContentType: .jpeg) { $0.data }
      .exportingCondition { $0.mediaType == .jpeg }
    DataRepresentation(exportedContentType: .png) { $0.data }
      .exportingCondition { $0.mediaType == .png }
    DataRepresentation(exportedContentType: .gif) { $0.data }
      .exportingCondition { $0.mediaType == .gif }
    DataRepresentation(exportedContentType: .webP) { $0.data }
      .exportingCondition { $0.mediaType == .webp }
  }
}

/// The chip a `notice` message renders as — a skill the agent learned, or a
/// memory it saved, after the turn had already finished.
struct NoticeChipView: View {
  let notice: NoticeProjection

  private var systemImage: String {
    switch notice.kind {
    case .skillLearned: return "graduationcap"
    case .memorySaved: return "brain"
    case .unknown: return "sparkles"
    }
  }

  var body: some View {
    Label(notice.text, systemImage: systemImage)
      .font(.footnote)
      .foregroundStyle(.secondary)
      .padding(.horizontal, 10)
      .padding(.vertical, 5)
      .overlay(
        Capsule().stroke(Color.secondary.opacity(DashTheme.Opacity.fillEmphasis))
      )
      .accessibilityIdentifier("chat.notice.chip")
  }
}
