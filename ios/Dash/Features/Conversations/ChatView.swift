import SwiftUI

struct ChatView: View {
  @Environment(ChatFeature.self) private var feature
  @Environment(AppModel.self) private var appModel
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.horizontalSizeClass) private var horizontalSizeClass

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

  /// Chat-screen toolbar (audit #15): rename/delete reuse the exact
  /// `ConversationListFeature.rename`/`delete` calls `ConversationListView`
  /// makes — `appModel.conversationListFeature` is the same `@Observable`
  /// instance the list's rows mutate through, so a delete fired from here
  /// flows through `AppModel`'s existing lifecycle-change plumbing
  /// (`applyConversationLifecycleChanges` → `pruneTranscriptRoutes`) and
  /// pops this screen off `conversationPath`/clears `splitConversationSelection`
  /// exactly as if the delete had come from the list — no bespoke
  /// "navigate back after delete" code needed here.
  @State private var isRenamePresented = false
  @State private var renameTitle = ""
  @State private var isDeletePresented = false

  /// Compose-first new chat (Task 3, audit #16): whether the header agent
  /// chip is shown/tappable at all. Gated on "no message has ever been sent
  /// in this conversation yet" — once that's no longer true the agent
  /// decision is locked in for real (the gateway has no
  /// agent-reassignment endpoint; see `AgentPickerSheet`'s doc comment), so
  /// showing a picker that can't actually change anything for THIS
  /// conversation would be misleading.
  private var showsAgentChip: Bool {
    feature.state.messages.isEmpty && feature.state.activeTurnID == nil
  }
  @State private var isAgentPickerPresented = false
  @State private var isSwitchingAgent = false

  var body: some View {
    VStack(spacing: 0) {
      if showsAgentChip {
        agentChipBar
      }

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
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        conversationOptionsMenu
      }
    }
    .task {
      await feature.appear()
    }
    .onDisappear {
      // Compose-first new chat (Task 3 review, I1): backing out of a
      // compose-created, still-empty conversation without ever sending
      // anything used to leave a permanent empty "New Conversation" row —
      // the exact anti-pattern audit #16 targets (the pre-compose-first
      // `NewConversationView` Form never had this problem, since creation
      // only happened after an explicit "Start conversation" tap). Values
      // captured synchronously, before the `Task`, since navigation state
      // can keep changing after this closure returns:
      //
      // - `hasActivity` — this conversation is exempt from cleanup once it
      //   has ever had a message or an active turn, OR (final-review fix
      //   C2 — see `ChatState.hasComposeActivity`'s doc comment)
      //   a non-empty draft, a staged attachment, or a title the user
      //   already changed away from the gateway's default.
      // - `stillNavigatedTo` — distinguishes a genuine "user backed out of
      //   this conversation" from a transient tab-switch-away (which also
      //   fires `onDisappear` — see `ChatFeature.disappear()`'s existing
      //   use of the same hook to suspend the connection — but doesn't
      //   remove this route from navigation, only hides it behind another
      //   tab). Branches on presentation exactly like `ConversationListView
      //   .isSelected(_:)` does, for the same reason: a compact back-button
      //   pop mutates the BOUND `conversationPath` array (that's what makes
      //   bound-path navigation work), but has no knowledge of
      //   `splitConversationSelection` at all — that property is only ever
      //   written by `AppModel`'s own navigation methods, never cleared by
      //   an interactive pop. Checking it for compact too (an earlier
      //   version of this did) meant it stayed permanently stale at
      //   whatever was last opened, silently defeating cleanup on iPhone
      //   entirely — caught by
      //   `testComposeThenBackWithoutSendingLeavesNoPermanentRow`. Regular
      //   width has the opposite asymmetry: its detail column's own
      //   NavigationStack isn't bound to `conversationPath` at all, so
      //   `splitConversationSelection` is the only thing that actually
      //   tracks what's open there.
      let conversationID = feature.state.conversation.id
      let hasActivity = feature.state.hasComposeActivity
      let stillNavigatedTo: Bool
      switch AdaptiveNavigationPolicy.presentation(horizontalSizeClass: horizontalSizeClass) {
      case .compact:
        stillNavigatedTo = appModel.conversationPath.contains(.transcript(conversationID))
      case .regular:
        stillNavigatedTo = appModel.splitConversationSelection == .transcript(conversationID)
      }
      Task {
        await feature.disappear()
        guard stillNavigatedTo == false else { return }
        await appModel.conversationListFeature?.discardIfUnusedComposeCreation(
          id: conversationID,
          hasActivity: hasActivity
        )
      }
    }
    .alert("Rename conversation", isPresented: $isRenamePresented) {
      TextField("Title", text: $renameTitle)
      Button("Cancel", role: .cancel) {}
      Button("Rename") {
        let conversationID = feature.state.conversation.id
        Task { await appModel.conversationListFeature?.rename(id: conversationID, title: renameTitle) }
      }
    } message: {
      Text("Enter a title for this conversation.")
    }
    // Final-review fix m6: verbatim copy per the plan (docs/plans/2026-09-01-
    // chat-ux-phase3-plan.md, "delete confirm 'Delete this conversation?
    // This can't be undone.' (both platforms verbatim)") — split across the
    // dialog's title/message the same way this app's other confirmation
    // dialogs do (a short question as the title, the consequence as the
    // message), previously a per-conversation-title interpolation plus a
    // different, non-verbatim sentence. `ConversationListView`'s own delete
    // confirmation shares this exact copy — see its matching comment.
    .confirmationDialog(
      "Delete this conversation?",
      isPresented: $isDeletePresented,
      titleVisibility: .visible
    ) {
      Button("Delete", role: .destructive) {
        let conversationID = feature.state.conversation.id
        Task { await appModel.conversationListFeature?.delete(id: conversationID, confirmed: true) }
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("This can't be undone.")
    }
    .alert("Conversation update failed", isPresented: chatMutationErrorPresented) {
      Button("OK") { appModel.conversationListFeature?.mutationError = nil }
    } message: {
      Text(chatMutationErrorMessage)
    }
    .sheet(item: $editingMessage) { editing in
      // Fix I5 (final-review): only dismiss on a `true` result —
      // `resendFromMessage` returns `false` for a guarded no-op (most
      // commonly: another turn already has send authority — see its doc
      // comment), and dismissing unconditionally here used to silently
      // discard whatever the user had just typed with no indication
      // anything went wrong. `EditAndResendSheet` keeps its own text state
      // and shows an inline note when `onResend` comes back `false`.
      EditAndResendSheet(
        text: editing.text,
        onResend: { editedText in
          await feature.resendFromMessage(id: editing.id, editedText: editedText)
        },
        onResendSucceeded: { editingMessage = nil },
        onCancel: { editingMessage = nil }
      )
    }
    .sheet(isPresented: $isAgentPickerPresented) {
      AgentPickerSheet(
        agents: appModel.conversationListFeature?.agents ?? [],
        currentAgentID: feature.state.conversation.agentId,
        onSelect: { agent in
          guard agent.id != feature.state.conversation.agentId else { return }
          Task { await switchAgent(to: agent.id) }
        }
      )
    }
  }

  /// Compose-first new chat (Task 3, audit #16): the header agent chip's
  /// tap target, shown only while `showsAgentChip` (this conversation is
  /// still empty). A capsule rather than a plain toolbar button since it
  /// needs to show the current agent's NAME, not just an icon — SwiftUI's
  /// nav bar doesn't have room for that alongside the title and the
  /// trailing options menu at every width this app supports.
  private var agentChipBar: some View {
    HStack {
      Button {
        isAgentPickerPresented = true
      } label: {
        HStack(spacing: 6) {
          Image(systemName: "person.crop.circle")
          Text(feature.state.conversation.agentName)
            .font(.subheadline.weight(.medium))
            .lineLimit(1)
          if isSwitchingAgent {
            ProgressView()
              .controlSize(.mini)
          } else {
            Image(systemName: "chevron.down")
              .font(.caption2)
          }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .frame(minHeight: 44)
        .background(Color.secondary.opacity(DashTheme.Opacity.fillMuted), in: Capsule())
      }
      .buttonStyle(.plain)
      .disabled(isSwitchingAgent)
      .accessibilityLabel("Change agent")
      .accessibilityValue(feature.state.conversation.agentName)
      .accessibilityIdentifier("chat.agentChip")

      Spacer()
    }
    .padding(.horizontal)
    .padding(.top, 8)
  }

  /// Handles a different agent being picked from `AgentPickerSheet` while
  /// this conversation is still empty. Can't patch the open conversation's
  /// agent in place (no such gateway endpoint — see `AgentPickerSheet`'s doc
  /// comment), so this creates a NEW conversation under the chosen agent and
  /// swaps `AppModel`'s navigation over to it via `replaceConversation`,
  /// leaving the current (still-empty) conversation behind untouched.
  /// Mirrors `ConversationListView.startCompose()`'s create call exactly,
  /// just landing on `replaceConversation` instead of `openConversation`
  /// since a conversation is already open here.
  private func switchAgent(to agentID: String) async {
    guard let listFeature = appModel.conversationListFeature else { return }
    guard isSwitchingAgent == false else { return }
    isSwitchingAgent = true
    defer { isSwitchingAgent = false }
    // Review fix I2: `create(agentID:)` returns the resolved conversation id
    // directly (or `nil` on ANY failure, including a rare tombstone-
    // reconciliation race) — see `ConversationListView.startCompose()`'s
    // matching comment for why re-reading `selectedID`/`mutationError`
    // afterward was wrong. The `!= current conversation` check is
    // defensive: `onSelect` above already guards `agentID` against the
    // CURRENT conversation's agent, and `create` dedups by agent, so a
    // resolved id equal to `feature.state.conversation.id` should be
    // unreachable — but if it ever happened, replacing a conversation with
    // itself would be a no-op worth skipping rather than a route churn.
    guard
      let newConversationID = await listFeature.create(agentID: agentID),
      newConversationID != feature.state.conversation.id
    else { return }
    await listFeature.recordLastUsedAgent(agentID)
    appModel.replaceConversation(
      feature.state.conversation.id,
      with: newConversationID,
      presentation: AdaptiveNavigationPolicy.presentation(horizontalSizeClass: horizontalSizeClass)
    )
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

  /// Chat-screen toolbar (audit #15). Rename/Delete availability mirrors
  /// `ConversationListView`'s context menu / swipe actions exactly —
  /// `ConversationRowActionPolicy` driven off this same conversation's
  /// current summary, so a read-only (archived) or busy (active-turn)
  /// conversation disables the same actions here that it would in the list.
  /// New Conversation is deliberately NOT offered here as its own toolbar
  /// entry (Task 3, audit #16, compose-first new chat): starting a new
  /// conversation now always goes through `ConversationListView`'s compose
  /// button, which lives on the list's own `NavigationStack`/split-view
  /// column — the regular (iPad split-view) presentation renders `ChatView`
  /// inside the `detail:` column's own bare `NavigationStack`, which has no
  /// `.navigationDestination(for: ConversationRoute.self)` registered at
  /// all, so a push from here would silently no-op there regardless. The
  /// only new-chat-adjacent affordance this screen owns is the header agent
  /// chip (`agentChipBar`), and only for changing THIS still-empty
  /// conversation's agent, not starting an unrelated one.
  private var conversationOptionsMenu: some View {
    let policy = ConversationRowActionPolicy(
      summary: feature.state.conversation,
      mutationsAllowed: feature.connection == .online
    )
    // Fix I3: `feature.state.olderCursor != nil` means there's more history
    // on the gateway this screen hasn't paginated in yet (`Load Earlier`) —
    // see `ChatTranscriptExport.plainText`'s doc comment.
    let transcriptText = ChatTranscriptExport.plainText(
      for: feature.state.messages,
      hasOlderMessages: feature.state.olderCursor != nil
    )
    return Menu {
      if policy.showsRename {
        Button {
          renameTitle = feature.state.conversation.title
          isRenamePresented = true
        } label: {
          Label("Rename", systemImage: "pencil")
        }
        .disabled(policy.canRename == false)
        .accessibilityHint(policy.renameDisabledHint)
      }

      if policy.showsDelete {
        Button(role: .destructive) {
          isDeletePresented = true
        } label: {
          Label("Delete", systemImage: "trash")
        }
        .disabled(policy.canDelete == false)
        .accessibilityHint(policy.deleteDisabledHint)
      }

      ShareLink(item: transcriptText) {
        Label("Share Transcript", systemImage: "square.and.arrow.up")
      }
      .disabled(transcriptText.isEmpty)
    } label: {
      Image(systemName: "ellipsis.circle")
        .frame(minWidth: 44, minHeight: 44)
    }
    .accessibilityLabel("Conversation options")
    .accessibilityIdentifier("chat.options")
  }

  /// Same "action failed" alert `ConversationListView` shows, reusing
  /// `ConversationMutationError.userMessage` — since Rename/Delete here call
  /// straight through to the shared `ConversationListFeature`, a failure
  /// surfaces with identical copy regardless of which screen triggered it.
  /// `.revisionConflict` is excluded: that richer "changed on another
  /// device" flow (with its retry banner) is owned by `ConversationListView`
  /// alone, so it's left to surface there instead of duplicating it here.
  private var chatMutationErrorPresented: Binding<Bool> {
    Binding(
      get: {
        guard let error = appModel.conversationListFeature?.mutationError else { return false }
        if case .revisionConflict = error { return false }
        return true
      },
      set: { if $0 == false { appModel.conversationListFeature?.mutationError = nil } }
    )
  }

  private var chatMutationErrorMessage: String {
    appModel.conversationListFeature?.mutationError?.userMessage
      ?? "Dash couldn't complete the update. Try again."
  }
}

/// Plain-text transcript export for the chat-screen toolbar's Share
/// Transcript action (audit #15). Assistant turns run through
/// `markdownPlainTextAccessibilityLabel` — the same markdown-stripping used
/// for VoiceOver — so a shared transcript reads as plain prose rather than
/// leaking raw `**markdown**` syntax; user turns are already plain text.
/// Messages with no renderable text (e.g. a still-streaming or tool-only
/// turn with an empty `assistant.text`) are dropped rather than emitting an
/// empty "Assistant:" line. Internal (not `private`) so `DashTests` can
/// exercise `plainText(for:)` directly via `@testable import Dash`.
///
/// Final-review fix I3: two fidelity markers, deliberately simple rather
/// than fetching/paginating in the full server-side history (out of scope
/// — see the plan's ruling):
///  - `hasOlderMessages`: this export only ever covers `messages` — whatever
///    this screen currently has loaded, not necessarily the conversation's
///    full history (`ChatState.olderCursor != nil` means there's more,
///    reachable only via "Load Earlier" pagination). Presenting a partial
///    transcript with no indication it's partial would misrepresent it as
///    complete, so callers pass `true` whenever `olderCursor != nil` and a
///    disclosure line is prefixed.
///  - a trailing `" (interrupted)"` marker on any assistant turn whose
///    `status` never reached `.completed` (cancelled, failed, or
///    interrupted mid-stream) — it still has SOME text worth keeping, but
///    presenting it identically to a normal, finished reply would overstate
///    it as the model's complete answer.
enum ChatTranscriptExport {
  static func plainText(for messages: [ChatMessageState], hasOlderMessages: Bool = false) -> String {
    let lines: [String] = messages.compactMap { message -> String? in
      switch message.role {
      case .user:
        guard let text = message.user?.text.trimmingCharacters(in: .whitespacesAndNewlines),
          text.isEmpty == false
        else { return nil }
        return "You: \(text)"
      case .assistant:
        guard let raw = message.assistant?.text, raw.isEmpty == false else { return nil }
        let plain = markdownPlainTextAccessibilityLabel(for: raw)
          .trimmingCharacters(in: .whitespacesAndNewlines)
        guard plain.isEmpty == false else { return nil }
        let interruptedMarker = message.status == .completed ? "" : " (interrupted)"
        return "Assistant: \(plain)\(interruptedMarker)"
      }
    }
    guard lines.isEmpty == false else { return "" }
    let olderMessagesPrefix = hasOlderMessages ? "(Earlier messages not included)\n\n" : ""
    return olderMessagesPrefix + lines.joined(separator: "\n\n")
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
        .overlay(Circle().strokeBorder(Color.primary.opacity(DashTheme.Opacity.strokeSubtle)))
        .shadow(color: .black.opacity(DashTheme.Opacity.shadow), radius: DashTheme.Radius.small, y: 2)
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
///
/// Fix I5 (final-review): `onResend` is now `async -> Bool` (mirroring
/// `ChatFeature.resendFromMessage`'s own return — see its doc comment) so
/// this sheet can tell "sent" apart from "guarded no-op" (most commonly:
/// another turn already has send authority). On `false` the sheet stays
/// open with `text` untouched and shows `blockedNote` under the editor;
/// `onResendSucceeded` — called only on `true` — is `ChatView`'s cue to
/// actually dismiss it. Before this fix the sheet dismissed unconditionally
/// on tapping Resend, silently discarding the user's edited text whenever
/// the resend was guarded.
private struct EditAndResendSheet: View {
  @State private var text: String
  @State private var blockedNote = false
  let onResend: (String) async -> Bool
  let onResendSucceeded: () -> Void
  let onCancel: () -> Void

  init(
    text: String,
    onResend: @escaping (String) async -> Bool,
    onResendSucceeded: @escaping () -> Void,
    onCancel: @escaping () -> Void
  ) {
    _text = State(initialValue: text)
    self.onResend = onResend
    self.onResendSucceeded = onResendSucceeded
    self.onCancel = onCancel
  }

  private var trimmedText: String {
    text.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  var body: some View {
    NavigationStack {
      VStack(alignment: .leading, spacing: 8) {
        TextEditor(text: $text)
        if blockedNote {
          Text("Wait for the current response to finish.")
            .font(.footnote)
            .foregroundStyle(.secondary)
            .accessibilityIdentifier("chat.editAndResend.blockedNote")
        }
      }
      .padding()
      .navigationTitle("Edit & Resend")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel", action: onCancel)
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Resend") {
            blockedNote = false
            Task {
              let sent = await onResend(trimmedText)
              if sent {
                onResendSucceeded()
              } else {
                blockedNote = true
              }
            }
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
      Color.red.opacity(DashTheme.Opacity.fillMuted)
    case .recoveryRequired, .reconnecting, .offline, .gatewayOffline, .rateLimited:
      Color.orange.opacity(DashTheme.Opacity.fillMuted)
    }
  }
}
