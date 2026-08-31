import SwiftUI

struct ChatView: View {
  @Environment(ChatFeature.self) private var feature
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  @State private var isNearBottom = true
  // iOS 17 fallback geometry (audit #4): the transcript scroll view's own
  // visible-viewport height, kept fresh by `ScrollViewportHeightKey` below
  // whenever the ScrollView's bounds change (rotation, keyboard, split-view
  // resize). iOS 18+ gets an equivalent value for free from
  // `onScrollGeometryChange`'s `GeometryProxy`, so this state only feeds the
  // `#unavailable(iOS 18.0)` branch of `scrollView`.
  @State private var legacyViewportHeight: CGFloat = 0

  private let bottomID = "chat-bottom"
  /// Named coordinate space for the transcript ScrollView (iOS 17 fallback
  /// only) — anchors `BottomSentinelOffsetKey`'s reported `minY` to the
  /// ScrollView's own bounds rather than the screen, so it stays correct
  /// regardless of where the ScrollView sits on screen.
  private static let scrollSpace = "chatTranscriptScroll"

  /// Edit & Resend UX choice (chat-ux Phase 2, Task 4 / audit #5): a
  /// dedicated sheet rather than prefilling the composer + arming a
  /// pending-truncation flag. `ChatFeature`'s composer state
  /// (`state.draft`/`state.attachments`) is already load-bearing for a
  /// fairly intricate staging/durability/recovery pipeline (see
  /// `composerMutationAllowed`, `draftEditingAllowed`,
  /// `pendingSendRecovery` in `ChatFeature.swift`) — routing "the user is
  /// editing an old message" through that same state would mean either a
  /// new composer mode threaded through all of it, or risking clobbering an
  /// in-progress draft for a NEW message the user hadn't sent yet. An
  /// isolated, disposable `editingMessage` sheet keeps this feature
  /// self-contained: it owns its own text, and on submit calls the exact
  /// same `resendFromMessage(id:editedText:)` a Retry does.
  @State private var editingMessage: EditingMessage?

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
    .sheet(item: $editingMessage) { editing in
      EditAndResendSheet(
        text: editing.text,
        onResend: { editedText in
          editingMessage = nil
          Task { await feature.resendFromMessage(id: editing.id, editedText: editedText) }
        },
        onCancel: { editingMessage = nil }
      )
    }
  }

  private var transcript: some View {
    ScrollViewReader { proxy in
      scrollView
        .overlay(alignment: .bottomTrailing) {
          if isNearBottom == false {
            JumpToBottomButton {
              scrollToBottom(proxy, animated: true)
            }
            .padding(.trailing, 16)
            .padding(.bottom, 16)
            .transition(.opacity.combined(with: .scale(scale: 0.85, anchor: .bottomTrailing)))
          }
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.15), value: isNearBottom)
        .onAppear {
          scrollToBottom(proxy, animated: false)
        }
        .onChange(of: transcriptSignature) { oldValue, newValue in
          guard oldValue != newValue, isNearBottom else { return }
          scrollToBottom(proxy, animated: true)
        }
    }
  }

  /// Keeps `isNearBottom` accurate on every supported OS version (audit #4,
  /// the iOS 17 bug fix). Previously this only had an iOS 18+ arm
  /// (`onScrollGeometryChange`) — below 18.0 `isNearBottom` was never
  /// touched after its `true` initializer, so it stayed permanently `true`
  /// and every token delta force-scrolled to bottom even after the user
  /// scrolled up. The `else` branch below is a genuine, version-independent
  /// replacement for iOS 17.0 (the app's deployment target): a
  /// `GeometryReader`-backed `PreferenceKey` on the `bottomID` sentinel (see
  /// `transcriptScrollView`) reports that sentinel's offset within the
  /// ScrollView's own named coordinate space, compared against the
  /// ScrollView's own viewport height via `ChatScrollGeometry.isNearBottom`
  /// — the same "sentinel within `threshold` points of the visible bottom
  /// edge" concept `onScrollGeometryChange` expresses for 18+, just built
  /// from primitives available since 17.0.
  @ViewBuilder
  private var scrollView: some View {
    if #available(iOS 18.0, *) {
      transcriptScrollView
        .onScrollGeometryChange(for: Bool.self) { geometry in
          geometry.visibleRect.maxY
            >= geometry.contentSize.height - ChatScrollGeometry.nearBottomThreshold
        } action: { _, nearBottom in
          isNearBottom = nearBottom
        }
    } else {
      transcriptScrollView
        .coordinateSpace(name: Self.scrollSpace)
        .background(
          GeometryReader { proxy in
            Color.clear.preference(
              key: ScrollViewportHeightKey.self,
              value: proxy.size.height
            )
          }
        )
        .onPreferenceChange(ScrollViewportHeightKey.self) { legacyViewportHeight = $0 }
        .onPreferenceChange(BottomSentinelOffsetKey.self) { sentinelMinY in
          isNearBottom = ChatScrollGeometry.isNearBottom(
            sentinelMinY: sentinelMinY,
            viewportHeight: legacyViewportHeight
          )
        }
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
            isAnsweringEnabled: feature.canAnswerQuestions,
            onAnswer: { questionID, answer in
              Task { await feature.answer(questionID: questionID, answer: answer) }
            },
            onRetry: { id in
              Task { await feature.resendFromMessage(id: id) }
            },
            onEditAndResend: { id in
              guard let text = feature.state.messages.first(where: { $0.id == id })?.user?.text
              else { return }
              editingMessage = EditingMessage(id: id, text: text)
            }
          )
        }

        // Bottom-of-transcript sentinel: `bottomID` is the `scrollToBottom`
        // target (unchanged behavior). It also reports its own position via
        // `BottomSentinelOffsetKey`, which only the iOS 17 fallback above
        // consumes — but the report itself (a single CGFloat preference
        // write per layout pass) is cheap enough that leaving it active on
        // iOS 18+ too, where it's simply unused, isn't worth an extra
        // `#available` branch here.
        Color.clear
          .frame(height: 1)
          .id(bottomID)
          .background(
            GeometryReader { proxy in
              Color.clear.preference(
                key: BottomSentinelOffsetKey.self,
                value: proxy.frame(in: .named(Self.scrollSpace)).minY
              )
            }
          )
      }
      .frame(maxWidth: 760)
      .padding(.horizontal)
      .padding(.vertical, 12)
      .frame(maxWidth: .infinity)
    }
    .scrollDismissesKeyboard(.interactively)
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

  private var transcriptSignature: ChatTranscriptSignature {
    ChatTranscriptSignature.of(feature.state.messages)
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

/// Cheap replacement for the old O(n) string-joined `transcriptSignature`
/// (audit #4): auto-scroll-while-pinned only needs to detect "did the
/// *last* message's identity, terminal status, or content shape change", not
/// a fingerprint of the entire history — every mutation that matters for it
/// (a new message arriving, a status transition, a streamed
/// token/tool-card/thinking-delta) always touches `messages.last`. Internal
/// (not `private`) so `DashTests` can exercise `of(_:)` directly via
/// `@testable import Dash`, since the O(1)-vs-O(n) behavior is otherwise
/// only observable indirectly through SwiftUI's `onChange`, which isn't
/// unit-testable.
struct ChatTranscriptSignature: Equatable {
  let messageID: String?
  let status: MessageStatus?
  let contentCount: Int

  static func of(_ messages: [ChatMessageState]) -> ChatTranscriptSignature {
    guard let last = messages.last else {
      return ChatTranscriptSignature(messageID: nil, status: nil, contentCount: 0)
    }
    let assistant = last.assistant
    let contentCount =
      (assistant?.text.count ?? 0)
      + (assistant?.thinking.count ?? 0)
      + (assistant?.toolCards.count ?? 0)
      + (assistant?.workerCards.count ?? 0)
      + (assistant?.statusRows.count ?? 0)
    return ChatTranscriptSignature(
      messageID: last.id,
      status: last.status,
      contentCount: contentCount
    )
  }
}

/// Pure "is the bottom sentinel within `threshold` points of the visible
/// viewport's bottom edge" predicate (audit #4's iOS 17 fix), factored out
/// of `scrollView` so it's unit-testable without rendering real SwiftUI
/// geometry — the `PreferenceKey`/`GeometryReader` plumbing that produces
/// its inputs can't run outside a live view hierarchy, but this is the
/// actual decision that used to be permanently wrong (`isNearBottom` stuck
/// `true`) on iOS 17, so it's the part worth pinning down with a test.
/// Mirrors the iOS 18+ `onScrollGeometryChange` condition
/// (`visibleRect.maxY >= contentSize.height - threshold`): `sentinelMinY` is
/// the sentinel's offset from the top of the viewport, so "within threshold
/// of the bottom edge" is `sentinelMinY <= viewportHeight + threshold`.
enum ChatScrollGeometry {
  static let nearBottomThreshold: CGFloat = 100

  static func isNearBottom(
    sentinelMinY: CGFloat,
    viewportHeight: CGFloat,
    threshold: CGFloat = nearBottomThreshold
  ) -> Bool {
    sentinelMinY <= viewportHeight + threshold
  }
}

/// Sentinel-offset-within-viewport `PreferenceKey` feeding the iOS 17
/// fallback in `scrollView` (audit #4).
private struct BottomSentinelOffsetKey: PreferenceKey {
  static let defaultValue: CGFloat = .infinity
  static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
    value = nextValue()
  }
}

/// Scroll-viewport-height `PreferenceKey` feeding the iOS 17 fallback in
/// `scrollView` (audit #4).
private struct ScrollViewportHeightKey: PreferenceKey {
  static let defaultValue: CGFloat = 0
  static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
    value = nextValue()
  }
}

/// Floating "scroll to latest" affordance (audit #4): a bottom-trailing
/// overlay shown while `isNearBottom == false`. Styled as a native circular
/// floating-action button — matching the app's existing icon-only circular
/// controls (`ComposerView`'s send/cancel buttons) — rather than porting the
/// web pill verbatim, per the app's own rounded-native design language.
private struct JumpToBottomButton: View {
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Image(systemName: "arrow.down")
        .font(.body.weight(.semibold))
        .foregroundStyle(DashTheme.accent)
        .frame(width: 40, height: 40)
        .background(.regularMaterial, in: Circle())
        .overlay(Circle().strokeBorder(Color.primary.opacity(0.08)))
        .shadow(color: .black.opacity(0.18), radius: 8, y: 2)
        .contentShape(Circle())
    }
    .buttonStyle(.plain)
    .frame(minWidth: 44, minHeight: 44)
    .accessibilityLabel("Jump to latest messages")
    .accessibilityIdentifier("chat.jumpToBottom")
  }
}

/// Sheet payload for `ChatView`'s Edit & Resend flow (chat-ux Phase 2, Task
/// 4 / audit #5) — `Identifiable` so `.sheet(item:)` can drive presentation
/// off of it directly instead of a separate `Bool` flag plus stored id/text.
private struct EditingMessage: Identifiable, Equatable {
  let id: String
  let text: String
}

/// Edit & Resend sheet (chat-ux Phase 2, Task 4 / audit #5): prefilled with
/// the original message text; "Resend" hands the edited text back to
/// `ChatView`, which calls `ChatFeature.resendFromMessage(id:editedText:)` —
/// the exact same call a plain Retry makes, just with `editedText` set. See
/// `ChatView.editingMessage`'s doc comment for why this is a sheet rather
/// than a composer-prefill.
private struct EditAndResendSheet: View {
  @State private var text: String
  let onResend: (String) -> Void
  let onCancel: () -> Void

  init(text: String, onResend: @escaping (String) -> Void, onCancel: @escaping () -> Void) {
    _text = State(initialValue: text)
    self.onResend = onResend
    self.onCancel = onCancel
  }

  private var trimmedText: String {
    text.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  var body: some View {
    NavigationStack {
      TextEditor(text: $text)
        .padding()
        .navigationTitle("Edit & Resend")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button("Cancel", action: onCancel)
          }
          ToolbarItem(placement: .confirmationAction) {
            Button("Resend") {
              onResend(trimmedText)
            }
            .disabled(trimmedText.isEmpty)
          }
        }
    }
    .accessibilityIdentifier("chat.editAndResend.sheet")
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
