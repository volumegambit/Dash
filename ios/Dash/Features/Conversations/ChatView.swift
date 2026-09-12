import SwiftUI

struct ChatView: View {
  /// What ⌘W does for THIS host (whole-branch final review, blocking 2).
  /// `UIMenuSystem` is process-wide while `@FocusedValue` is per-scene, so
  /// the chat-only window publishes `chatCommands` and ⌘W is enabled there
  /// too — with one hardcoded action it closed nothing and silently
  /// deselected the conversation in the OTHER window. The main window passes
  /// the deselect; `ConversationWindowView` passes `dismissWindow`.
  let onClose: () -> Void

  @Environment(ChatFeature.self) private var feature
  @Environment(AppModel.self) private var appModel
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.horizontalSizeClass) private var horizontalSizeClass

  /// iOS 17 only (audit #4): "the bottom sentinel is within 100pt of the
  /// viewport's bottom edge" — drives both auto-follow and the jump button
  /// there. iOS 18+ uses `isPinnedToBottom` instead; see `scrollView(_:)`.
  @State private var isNearBottom = true
  /// iOS 18+ pin state (transcript scroll fix, 2026-09-05). While pinned the
  /// ScrollView itself keeps the bottom edge in view through content growth
  /// (`defaultScrollAnchor(.bottom, for: .sizeChanges)`) — no per-token
  /// `scrollTo`, so nothing animates against the user's finger. Unpinned by
  /// any user-driven scroll that moves the bottom out of view; re-pinned by
  /// scrolling back to the bottom or tapping the jump button.
  @State private var isPinnedToBottom = true
  /// Mirrors `onScrollPhaseChange` (iOS 18+): true for tracking /
  /// interacting / decelerating — i.e. the user, not us, is moving the view.
  @State private var scrollPhaseIsUserDriven = false
  /// The transcript's visible (inset-adjusted) height. iOS 17 keeps it fresh
  /// through `ScrollViewportHeightKey` (audit #4's fallback, also its
  /// `isNearBottom` input); iOS 18+ through `onScrollGeometryChange`. Both
  /// feed the "Load earlier" position hold in `transcript`.
  @State private var viewportHeight: CGFloat = 0
  /// The first message row's frame in `scrollSpace` — where, within the
  /// viewport, the row the user is reading at the top sits — reported by
  /// `MessageListView` through `FirstMessageRowFrameKey`. Read at the moment
  /// a "Load earlier" page lands, so the hold can put that same row back at
  /// exactly that spot. See `ChatScrollGeometry.holdAnchor`.
  @State private var firstRowFrame: CGRect = .zero
  /// Whether `transcript`'s `onAppear` has already taken its
  /// `ChatScrollRestoration` decision for THIS host (iPad goal Phase A, Task
  /// 4 review fix, Important 2). Local `@State` on purpose: it is a
  /// per-host latch, so resetting to `false` on every re-host is the correct
  /// behavior, unlike the pinned-vs-anchored intent it guards.
  @State private var hasRestoredScrollPosition = false

  private let bottomID = "chat-bottom"
  /// Named coordinate space for the transcript ScrollView — anchors
  /// `BottomSentinelOffsetKey` (iOS 17) and `FirstMessageRowFrameKey` (all
  /// versions) to the ScrollView's own bounds rather than the screen, so
  /// their `minY` is viewport-relative wherever the ScrollView sits.
  static let scrollSpace = "chatTranscriptScroll"

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
  // Change model from the conversation (goal 2026-09-04).
  // Seeded from a debug launch option so the model sheet — presented from
  // this view's own state, not `AppModel` — can be captured without a tap.
  // In a Release build `UITestLaunchOptions` does not exist and this is
  // always `false`.
  @State private var isModelPickerPresented = ChatView.initialModelPickerPresented

  private static var initialModelPickerPresented: Bool {
    #if DEBUG
      return UITestLaunchOptions.initialSheet == "model-picker"
    #else
      return false
    #endif
  }
  @State private var modelChangeToast: AgentsFeature.ModelChange?

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
  /// Bumped by ⌘L (`KeyboardCommand.focusComposer`) and handed to
  /// `ComposerView`, which owns the `@FocusState` the text field is bound to.
  /// A counter rather than a flag so a second ⌘L after tapping away still
  /// changes the value and therefore still fires `ComposerView`'s `onChange`.
  @State private var composerFocusRequest = 0
  /// iPad goal Phase B, Task 7 (extended Task 8): whether a drag carrying
  /// `DroppedImage`s is currently hovering the chat surface — drives the
  /// dashed drop-target overlay below. Shared with `ComposerView` (passed
  /// down as a binding) since Task 8 found this destination alone doesn't
  /// cover a drop released over the composer and gave `ComposerView` its
  /// OWN `.dropDestination` for that surface — see that modifier's comment
  /// below for what was actually observed (review fix round 1, Minor 2: the
  /// original comment here over-claimed the mechanism).
  @State private var isDropTargeted = false

  /// §8.4's tasks sheet. `ChatView` owns the presentation flag but deliberately
  /// never reads the live COUNT: `TasksToolbarButton` and `TasksStrip` read it
  /// from inside their own bodies, so a list re-read on every parent turn's
  /// `done` invalidates those two views and not this whole screen.
  @State private var isTasksPresented = false

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
    // Handles drops released over the TRANSCRIPT only, in practice — Task 8
    // found (via `IPadUITests.testDroppingAnImageAttachesIt`, retargeted to
    // each drop location with everything else held constant) that a drag
    // released over `chat.transcript` reaches this destination 3/3 isolated
    // reruns, while one released over `chat.composer` (the `TextField`)
    // does not, 3/3 isolated reruns. That differential is real and
    // reproduced, but WHY is not fully isolated: this destination is
    // applied to the transcript `VStack` before `.safeAreaInset` below adds
    // the composer, so it may simply never have had a hit-testable region
    // over the composer's screen area at all (regardless of what view sits
    // there) — as plausible a cause as the `TextField`'s own built-in drop
    // interaction claiming the session first. Both explanations point to
    // the same fix and neither was isolated further (review fix round 1,
    // Minor 2 — the previous version of this comment asserted the
    // `TextField`-claims-it mechanism as fact, which was not established).
    // `ComposerView` below has its OWN `.dropDestination` for that surface,
    // correct under either explanation, sharing `isDropTargeted` with this
    // one so the single highlight overlay lights up for either.
    .dropDestination(for: DroppedImage.self) { items, _ in
      let selections = DroppedImage.selections(from: items)
      guard selections.isEmpty == false else { return false }
      Task { await feature.addSelections(selections) }
      return true
    } isTargeted: { isDropTargeted = $0 }
    .safeAreaInset(edge: .bottom, spacing: 0) {
      VStack(spacing: 0) {
        // §8.4's pinned strip. It renders nothing while no child is live, so
        // placing it costs no read of the count here.
        TasksStrip { isTasksPresented = true }
        ComposerView(focusRequest: composerFocusRequest, isDropTargeted: $isDropTargeted)
      }
    }
    // Applied AFTER `.safeAreaInset`, not before, so the dashed highlight's
    // frame is the WHOLE chat surface — transcript AND composer — rather
    // than just the transcript's bounds from before the composer's
    // safe-area inset was added. It previously sat directly on the
    // transcript `VStack` above, ahead of `.safeAreaInset`, which meant the
    // highlight was sized to the transcript alone and never visibly covered
    // the composer.
    .overlay {
      if isDropTargeted {
        RoundedRectangle(cornerRadius: DashTheme.Radius.large)
          .strokeBorder(DashTheme.accent, style: StrokeStyle(lineWidth: 2, dash: [8]))
          .padding(8)
          .allowsHitTesting(false)
          .accessibilityIdentifier("chat.dropTarget")
      }
    }
    // iPad goal Phase B: the chat surface's slice of `DashCommands`. The
    // `can*` flags are the same predicates the composer's own send/stop
    // buttons are disabled by, so the ⌘ overlay and the on-screen controls
    // can never disagree. `ComposerView` keeps its per-button
    // `.keyboardShortcut`s as harmless duplicates — SwiftUI resolves the
    // first responder, and keeping them leaves iOS 17 behaviour unchanged.
    .background {
      ChatCommandPublisher(
        actions: ChatCommandActions(
          feature: feature,
          focusComposer: { composerFocusRequest += 1 },
          close: onClose
        )
      )
      .equatable()
    }
    .navigationTitle(feature.state.conversation.title)
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .principal) {
        conversationHeader
      }
      // §8.4: "a toolbar item beside `chat.options` that shows a badge with the
      // live count".
      ToolbarItem(placement: .topBarTrailing) {
        TasksToolbarButton { isTasksPresented = true }
      }
      ToolbarItem(placement: .topBarTrailing) {
        conversationOptionsMenu
      }
    }
    .sheet(isPresented: $isModelPickerPresented) {
      if let agentsFeature = appModel.agentsFeature {
        ChatModelPickerSheet(
          agentID: feature.state.conversation.agentId,
          currentModel: currentModel,
          agentsFeature: agentsFeature
        ) { change in
          showModelChangeToast(change)
        }
        // `.medium` on a phone, where it covers half the screen and the
        // transcript stays visible behind it. On iPad `.medium` is a short
        // centred card showing about three models — it undercut the density
        // work this very sheet had just received (captured 2026-09-05), so
        // regular width goes straight to `.large`.
        .presentationDetents(
          horizontalSizeClass == .regular ? [.large] : [.medium, .large]
        )
        // Presentation audit (iPad goal Phase D, Task 11 / design §4): the
        // detents above only apply at compact width, so without this the
        // model picker is a full-height iPad card holding a short list.
        // Kept ALONGSIDE the regular-width `.large` above (merge with main,
        // 2026-09-07). They are independent controls rather than two
        // spellings of one fix: `presentationSizing(.form)` chooses the
        // sheet's iPad SIZE CLASS, `presentationDetents` its height within
        // that. Neither subsumes the other, so both sides are kept.
        // Verified together by `testChatToolbarModelPickerChangesTheAgentModel`
        // on iPad 26.5 and iPad 18.4.
        .modifier(FormSheetSizing())
      }
    }
    .overlay(alignment: .top) {
      if let toast = modelChangeToast {
        Text("Model changed to \(toast.modelLabel)")
          .font(.footnote.weight(.semibold))
          .padding(.horizontal, 14)
          .padding(.vertical, 8)
          .background(.regularMaterial, in: Capsule())
          .overlay(Capsule().strokeBorder(Color.primary.opacity(DashTheme.Opacity.strokeSubtle)))
          .padding(.top, 8)
          .transition(reduceMotion ? .identity : .move(edge: .top).combined(with: .opacity))
          .accessibilityIdentifier("chat.modelToast")
      }
    }
    .task {
      await feature.appear()
    }
    // Read aloud follows the SAME gate the composer's mic does
    // (`AppModel.speechAvailable`), driven from the view for the same reason:
    // the capability belongs to the connection and can land after this
    // conversation is already on screen.
    .task {
      feature.syncReadAloud(available: appModel.speechAvailable)
    }
    .onChange(of: appModel.speechAvailable) { _, available in
      feature.syncReadAloud(available: available)
    }
    .task {
      // Model picker (goal 2026-09-04): the toolbar label wants the catalog's
      // human label ("GPT-5", not "gpt-5"), so load it with the view rather
      // than only when the sheet opens.
      if appModel.agentsFeature?.models.isEmpty == true {
        await appModel.agentsFeature?.loadModels()
      }
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
        // `feature.hasVisibleHosts` (whole-branch final review, blocking 1):
        // `stillNavigatedTo` above is computed from the MAIN window's
        // navigation state alone, so it is structurally blind to the
        // chat-only scene `ConversationWindowView` puts on screen. Without
        // this second condition, tapping a different conversation in the main
        // window while the same one is open in its own window ran BOTH
        // cleanups against a transcript that is still visible — discarding
        // the other window's scroll position, and deleting the conversation
        // outright when it was a still-empty compose-created one.
        guard stillNavigatedTo == false, feature.hasVisibleHosts == false else { return }
        // Scroll anchor (iPad goal Phase A, Task 4): only drop the
        // remembered position when the conversation is genuinely being
        // left, mirroring the compose-cleanup branch right below — a
        // transient re-host (size-class flip) also fires `onDisappear` but
        // keeps `stillNavigatedTo == true`, so the anchor survives it.
        feature.clearScrollAnchor()
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
    // Hands-free voice mode (speech Phase B, Task B9). A full-screen cover
    // rather than a sheet: it is a mode, not a detail, and the transcript
    // underneath has to keep rendering — the chat screen's conversation
    // subscription is what stays live while the gateway drops the voice
    // turn's own (Task B6).
    .fullScreenCover(item: voiceModeBinding) { voice in
      VoiceModeView(voice: voice)
    }
    .sheet(isPresented: $isTasksPresented) {
      TasksSheet { childID in
        feature.revealSubagent(childID)
      }
      .environment(feature)
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
      // Presentation audit (iPad goal Phase D, Task 11 / design §4).
      .modifier(FormSheetSizing())
    }
  }

  /// The cover's presentation is `ChatFeature.voiceMode` itself: clearing it
  /// IS the dismissal, so a session that ends on its own (the gateway
  /// stopping, a lost socket) takes the cover down without the view needing
  /// to hear about it. A dismissal that starts on the VIEW side — the system
  /// taking the cover away — routes back through `stopVoiceMode()` so the
  /// microphone and the gateway session go with it.
  private var voiceModeBinding: Binding<VoiceModeFeature?> {
    Binding(
      get: { feature.voiceMode },
      set: { value in
        guard value == nil else { return }
        Task { await feature.stopVoiceMode() }
      }
    )
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

  /// UI-test probe (Task 4 review fix, Important 1): surfaces the id
  /// `.scrollPosition(id:)` is currently tracking so a real-swipe UI test can
  /// assert it is a genuine transcript row identity (`ChatMessageState.rowID`
  /// since main re-keyed the `ForEach`) rather than one of the outer stack's
  /// children. DEBUG-only AND gated on the single
  /// `long-transcript` scenario, so no shipping build and no other UI suite
  /// ever sees this element. Invisible rather than hidden: `.hidden()` /
  /// zero opacity would also remove it from the accessibility tree, which is
  /// the one thing it exists for.
  #if DEBUG
    @ViewBuilder
    private var scrollAnchorProbe: some View {
      if UITestProbe.isScrollAnchorProbeEnabled {
        Text(feature.scrollAnchorMessageID ?? "none")
          .font(.system(size: 1))
          .foregroundStyle(.clear)
          .allowsHitTesting(false)
          .accessibilityIdentifier("chat.scrollAnchor")
      }
    }
  #endif

  private var transcript: some View {
    ScrollViewReader { proxy in
      scrollView(proxy)
        .overlay(alignment: .topLeading) {
          #if DEBUG
            scrollAnchorProbe
          #endif
        }
        .overlay(alignment: .bottomTrailing) {
          if showsJumpToBottom {
            JumpToBottomButton {
              jumpToBottom(proxy)
            }
            .padding(.trailing, 16)
            .padding(.bottom, 16)
            .transition(.opacity.combined(with: .scale(scale: 0.85, anchor: .bottomTrailing)))
          }
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.15), value: showsJumpToBottom)
        .onAppear {
          // Scroll anchor (iPad goal Phase A, Task 4; review fix, Important
          // 2): the restore decision is taken from state that SURVIVES a
          // re-host — `feature.scrollAnchorMessageID` and
          // `feature.scrollWasPinnedToBottom` — never from the local
          // `isNearBottom` `@State`, which resets to its `true` default on
          // exactly the re-host this feature exists for and is not
          // guaranteed to have been refreshed by
          // `onScrollGeometryChange`/`onPreferenceChange` before this
          // closure runs. The choice itself is `ChatScrollRestoration`'s,
          // so it is unit-testable without rendering SwiftUI.
          switch ChatScrollRestoration.decide(
            anchor: feature.scrollAnchorMessageID,
            wasPinnedToBottom: feature.scrollWasPinnedToBottom,
            // `rowID`, not `id` (merge with main, 2026-09-07): main re-keyed
            // `MessageListView`'s `ForEach` to `\.rowID`, so the identity
            // `scrollPosition(id:)` reports and `scrollTo` matches is the
            // rowID. Comparing a stored rowID against a set of `id`s would
            // have compiled and quietly stopped restoring as soon as an ack
            // rewrote an id.
            messageIDs: Set(feature.state.messages.map(\.rowID))
          ) {
          case .bottom:
            // Clear the anchor before pinning so the declarative
            // `.scrollPosition(id:)` binding below cannot immediately pull
            // the transcript back up to a stale position (the Minor note's
            // "two mechanisms on one ScrollView": this is how they are kept
            // in agreement rather than by adding a third).
            feature.scrollAnchorMessageID = nil
            // Record the intent this branch just acted on (deferred Task 4
            // fix). `decide` also returns `.bottom` when the anchor no
            // longer exists in the loaded transcript — with
            // `scrollWasPinnedToBottom == false` that left the feature
            // claiming "scrolled away" while the transcript was in fact
            // pinned to the bottom, and nothing corrected it until an
            // `isNearBottom` transition that a user sitting at the bottom
            // never makes.
            feature.recordScrollPinnedToBottom(true)
            isPinnedToBottom = true
            scrollToBottom(proxy, animated: false)
          case .message(let id):
            // Unpin BEFORE scrolling (merge with main, 2026-09-07).
            // `isPinnedToBottom` is `@State` and re-initializes to `true` on
            // the very re-host this restore serves, so without this main's
            // `defaultScrollAnchor(.bottom, for: .sizeChanges)` would still
            // be armed and would drag the restored position back to the tail
            // on the next content change — and `showsJumpToBottom` would stay
            // false, hiding the jump button for a user who is demonstrably
            // not at the bottom.
            isPinnedToBottom = false
            proxy.scrollTo(id, anchor: .top)
          }
          hasRestoredScrollPosition = true
        }
        .onChange(of: showsJumpToBottom) { _, showsJump in
          // Mirror the pinned-vs-scrolled-away intent onto the feature, which
          // outlives this view. Gated on the restore having already run: a
          // fresh host starts at content offset 0, so a geometry report that
          // lands BEFORE `onAppear` describes the un-restored ScrollView, not
          // where the user actually was. Ignoring those leaves the feature
          // holding its pre-re-host value, which is precisely the truth the
          // restore needs.
          //
          // Keyed on `showsJumpToBottom`, not on `isNearBottom` (merge with
          // main, 2026-09-07): main's iOS 18+ geometry callback stopped
          // writing `isNearBottom` altogether — it maintains
          // `isPinnedToBottom` instead — so an `onChange(of: isNearBottom)`
          // would be dead code on every OS the fleet actually runs, and the
          // feature would keep its stale `true` forever.
          guard hasRestoredScrollPosition else { return }
          feature.recordScrollPinnedToBottom(showsJump == false)
        }
        .onChange(of: transcriptSignature) { oldValue, newValue in
          // iOS 17 only: follow the stream by scrolling to the sentinel on
          // every delta. Not animated — the previous 0.2s ease on every
          // token meant overlapping animations that never let the view
          // rest. iOS 18+ needs nothing here: while pinned, the bottom
          // anchor for size changes keeps the tail in view by itself.
          if #unavailable(iOS 18.0) {
            guard oldValue != newValue, isNearBottom else { return }
            scrollToBottom(proxy, animated: false)
          }
        }
        .onChange(of: feature.state.messages.first?.rowID) { previousFirst, currentFirst in
          holdReadingPosition(proxy, previousFirst: previousFirst, currentFirst: currentFirst)
        }
    }
  }

  /// Two-way binding onto `feature.scrollAnchorMessageID` for
  /// `scrollPosition(id:anchor:)` below: SwiftUI both reads it (to restore
  /// position on a re-host) and writes it (as the user scrolls, tracking
  /// the topmost visible row) through this binding.
  ///
  /// PIN-GATED (merge with main, 2026-09-07). This is the one place our
  /// scroll-anchor work and main's anchor-driven pinning genuinely fight: a
  /// non-nil `scrollPosition(id:)` holds the tracked row in place through
  /// content growth, which is exactly what
  /// `defaultScrollAnchor(.bottom, for: .sizeChanges)` must be free to
  /// override while a reply streams. So the GETTER reports an id only while
  /// the transcript is scrolled away from the bottom (`showsJumpToBottom`) —
  /// where holding the user's row is the correct behaviour and agrees with
  /// main's `.top` size-change anchor — and reports `nil` while pinned,
  /// leaving main's bottom anchor as the sole authority over the offset.
  ///
  /// The SETTER always records, so tracking keeps working while pinned; a
  /// `nil` from SwiftUI is ignored rather than written, because with the
  /// getter deliberately reporting `nil` a write-back of `nil` would erase a
  /// good anchor. The two places that genuinely mean "forget it" —
  /// `ChatFeature.clearScrollAnchor()` and the `.bottom` restore branch —
  /// set the property directly, not through this binding.
  private var anchorBinding: Binding<String?> {
    Binding(
      get: { showsJumpToBottom ? feature.scrollAnchorMessageID : nil },
      set: { newValue in
        guard let newValue else { return }
        feature.scrollAnchorMessageID = newValue
      }
    )
  }

  /// "Load earlier" (transcript scroll fix, 2026-09-05): a page prepends
  /// above the row the user is reading, and a ScrollView keeps its offset
  /// from the TOP, so without this the new page fills the viewport and the
  /// user's row is a page below. Runs in the same update as the prepend
  /// (before layout, animations disabled), so the row is put back where it
  /// was — `firstRowFrame`, measured on the last pass — with no visible
  /// frame in between. Only while scrolled away from the bottom: pinned,
  /// the bottom anchor is the right behaviour and this must not fight it.
  private func holdReadingPosition(
    _ proxy: ScrollViewProxy,
    previousFirst: String?,
    currentFirst: String?
  ) {
    guard
      let previousFirst, let currentFirst, previousFirst != currentFirst,
      showsJumpToBottom,
      feature.state.messages.contains(where: { $0.rowID == previousFirst })
    else { return }
    let anchor = ChatScrollGeometry.holdAnchor(
      rowFrame: firstRowFrame,
      viewportHeight: viewportHeight
    )
    var transaction = Transaction()
    transaction.disablesAnimations = true
    withTransaction(transaction) {
      proxy.scrollTo(previousFirst, anchor: anchor)
    }
  }

  /// Whether the transcript is currently scrolled away from its tail — the
  /// single "am I pinned?" question, answered by main's `isPinnedToBottom`
  /// on iOS 18+ and by audit #4's `isNearBottom` on iOS 17. Everything that
  /// used to read `isNearBottom` directly now goes through this, so nothing
  /// reads a value that main stopped updating on iOS 18+.
  private var showsJumpToBottom: Bool {
    if #available(iOS 18.0, *) {
      return isPinnedToBottom == false
    } else {
      return isNearBottom == false
    }
  }

  private func jumpToBottom(_ proxy: ScrollViewProxy) {
    isPinnedToBottom = true
    scrollToBottom(proxy, animated: true)
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
  ///
  /// iOS 18+ (transcript scroll fix, 2026-09-05) is anchor-driven instead of
  /// `scrollTo`-driven:
  /// - `initialOffset: .bottom` opens the conversation on its newest message
  ///   with no animated scroll from the top;
  /// - `sizeChanges: .bottom` while pinned keeps the tail in view as tokens,
  ///   tool cards and late-sized rows grow the content — SwiftUI adjusts the
  ///   offset in the same layout pass, so there is nothing to animate and
  ///   nothing that can fight a drag; unpinned it is the ordinary `.top`;
  /// - `alignment: .top` keeps a short thread at the top, as before.
  /// `onScrollPhaseChange` tells user-driven motion from ours, and the
  /// geometry callback applies `ChatScrollGeometry.pinTransition` — unpin on
  /// any user scroll that takes the bottom out of view, re-pin when the user
  /// brings it back — and re-pins once, exactly, when the VISIBLE height
  /// changes (keyboard, composer growth, rotation), which the anchor does
  /// not cover. Deliberately NOT an "if pinned and not at the bottom, scroll
  /// there" rule: a first cut had one, and a `scrollTo` that lands a point
  /// short re-fires it on every geometry change, so the app never went idle
  /// (XCUITest's taps stalled for 40s).
  @ViewBuilder
  private func scrollView(_ proxy: ScrollViewProxy) -> some View {
    if #available(iOS 18.0, *) {
      transcriptScrollView
        .defaultScrollAnchor(.bottom, for: .initialOffset)
        .defaultScrollAnchor(.top, for: .alignment)
        .defaultScrollAnchor(isPinnedToBottom ? .bottom : .top, for: .sizeChanges)
        .onScrollPhaseChange { previousPhase, phase, context in
          let userDriven = phase == .tracking || phase == .interacting || phase == .decelerating
          scrollPhaseIsUserDriven = userDriven
          // The finger (or its fling) has come to rest: decide from where it
          // left the view. Independent of whether the geometry callback saw
          // the movement first — for a short, quick drag it may not have.
          let previousUserDriven =
            previousPhase == .tracking || previousPhase == .interacting
            || previousPhase == .decelerating
          if previousUserDriven, phase == .idle || phase == .decelerating {
            let distance = ChatScrollGeometry.distanceFromBottom(
              contentHeight: context.geometry.contentSize.height,
              visibleMaxY: context.geometry.visibleRect.maxY,
              bottomInset: context.geometry.contentInsets.bottom
            )
            isPinnedToBottom = ChatScrollGeometry.isPinnedAtGestureEnd(distance: distance)
          }
        }
        .onScrollGeometryChange(for: TranscriptScrollMetrics.self) { geometry in
          TranscriptScrollMetrics(
            distanceFromBottom: ChatScrollGeometry.distanceFromBottom(
              contentHeight: geometry.contentSize.height,
              visibleMaxY: geometry.visibleRect.maxY,
              bottomInset: geometry.contentInsets.bottom
            ),
            viewportHeight: geometry.containerSize.height
          )
        } action: { previous, current in
          viewportHeight = current.viewportHeight
          if scrollPhaseIsUserDriven {
            if let pinned = ChatScrollGeometry.pinTransition(
              previousDistance: previous.distanceFromBottom,
              distance: current.distanceFromBottom
            ) {
              isPinnedToBottom = pinned
            }
          } else if isPinnedToBottom,
            ChatScrollGeometry.viewportChangeNeedsRepin(previous: previous, current: current)
          {
            // The keyboard rising, the composer growing a line, a rotation
            // or a split-view resize all change the VISIBLE height, which
            // the size-change anchor above ignores (it tracks content size
            // only) — so the tail slides under the keyboard. One exact
            // `scrollTo` per such change, keyed on the height change rather
            // than on "not at the bottom", so it cannot re-fire itself.
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) {
              proxy.scrollTo(bottomID, anchor: .bottom)
            }
          }
        }
    } else {
      transcriptScrollView
        .background(
          GeometryReader { proxy in
            Color.clear.preference(
              key: ScrollViewportHeightKey.self,
              value: proxy.size.height
            )
          }
        )
        .onPreferenceChange(ScrollViewportHeightKey.self) { viewportHeight = $0 }
        .onPreferenceChange(BottomSentinelOffsetKey.self) { sentinelMinY in
          isNearBottom = ChatScrollGeometry.isNearBottom(
            sentinelMinY: sentinelMinY,
            viewportHeight: viewportHeight
          )
        }
    }
  }

  private var transcriptScrollView: some View {
    ScrollView {
      // VStack, not LazyVStack — see `MessageListView.body`.
      VStack(spacing: 16) {
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
            firstRowFrameCoordinateSpace: Self.scrollSpace,
            isAnsweringEnabled: feature.canAnswerQuestions,
            isScrollTarget: true,
            // Read aloud and voice mode are mutually exclusive: read
            // aloud's `.playback` session category evicts voice mode's live
            // capture, so the menu item goes away entirely while the cover
            // is up rather than offering a tap that kills the microphone.
            readAloud: feature.voiceMode == nil ? feature.readAloud : nil,
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
            },
            subagentInteraction: SubagentInteraction(
              state: { feature.state.subagentUI[$0] ?? SubagentUIState() },
              // Called synchronously, INSIDE the row's `withAnimation` — the
              // state write has to land in that transaction or the disclosure
              // does not animate. `setSubagentExpanded` writes the reducer
              // straight through and returns its network follow-up.
              setExpanded: { childID, isExpanded, loadsTranscript in
                feature.setSubagentExpanded(
                  childID,
                  isExpanded,
                  loadsTranscript: loadsTranscript
                )
              },
              send: { childID, text in
                await feature.sendToSubagent(childID, text: text)
              },
              // Read INSIDE `SubagentComposer.body`, never here: constructing a
              // closure is not an access, so `ChatView.body` never subscribes
              // to `subagentComposerDrafts` and the per-keystroke fan-out
              // stays at one composer.
              draft: { feature.subagentComposerDraft($0) },
              setDraft: { feature.setSubagentComposerDraft($0, $1) },
              // Gated on `unauthorized` ALONE, never on socket state: the send
              // is REST, and a reconnect must not stop the user answering a
              // child parked in `waiting_input`, whose `waitForQuestion` fails
              // the child's tool call ten minutes later.
              isEnabled: feature.connection != .repairRequired,
              // Read inside `SubagentCardView.body`, never here, for the same
              // reason as `draft`: constructing a closure is not an access, so
              // a list re-read invalidates the sub-agent ROWS and not
              // `ChatView.body`'s whole transcript.
              restStatus: { feature.restSubagentStatus($0) }
            )
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
      // NOTE (Task 4 review fix, Important 1): `.scrollTargetLayout()`
      // deliberately does NOT live here. This stack's direct arranged
      // children are `olderMessagesControl`, `MessageListView` as one opaque
      // box, and the bottom sentinel — none of which carry a transcript row
      // identity. The tag lives on `MessageListView`'s own stack instead
      // (`isScrollTarget: true` above), which is the container that actually
      // holds `ForEach(messages, id: \.rowID)`.
      .frame(maxWidth: DashTheme.Layout.readableWidth)
      .padding(.horizontal)
      .padding(.vertical, 12)
      .frame(maxWidth: .infinity)
    }
    .coordinateSpace(name: Self.scrollSpace)
    .onPreferenceChange(FirstMessageRowFrameKey.self) { firstRowFrame = $0 }
    .scrollDismissesKeyboard(.interactively)
    .scrollPosition(id: anchorBinding, anchor: .top)
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
  // MARK: - Change model (goal 2026-09-04)

  /// The conversation's agent's current model, read from the agents
  /// feature (canonical after a change) with the conversation list's agent
  /// cache as fallback.
  private var currentModel: String {
    let agentID = feature.state.conversation.agentId
    if let model = appModel.agentsFeature?.agents.first(where: { $0.id == agentID })?.config.model {
      return model
    }
    return appModel.conversationListFeature?.agents.first(where: { $0.id == agentID })?.config.model ?? ""
  }

  private var currentModelLabel: String {
    ModelCatalog.label(for: currentModel, in: appModel.agentsFeature?.models ?? [])
  }

  /// Disabled mid-turn (the running turn already has its model) and while
  /// the gateway can't take mutations.
  private var modelChangeDisabled: Bool {
    feature.state.activeTurnID != nil
      || appModel.agentsFeature?.mutationsAllowed != true
      || currentModel.isEmpty
  }

  /// Title over model, both centered (chat UI polish 2026-09-05).
  ///
  /// The model used to be a `.topBarTrailing` item capped at `maxWidth: 140`
  /// alongside the options menu, which left `.navigationTitle` roughly ten
  /// characters on a 393pt phone — "I can't che…". Two trailing controls plus
  /// a title is one item too many for a compact-width navigation bar, and the
  /// one that lost was the screen's own identity.
  ///
  /// A `.principal` item is the iOS 18-compatible way to get a subtitle
  /// (`.navigationSubtitle` is iOS 26, and this target still builds against
  /// the CI-pinned iOS 18 SDK). `.navigationTitle` stays set even though the
  /// principal view supersedes it visually — the navigation stack still reads
  /// it for the back button of anything pushed from here.
  private var conversationHeader: some View {
    VStack(spacing: 0) {
      Text(feature.state.conversation.title)
        .font(.headline)
        .lineLimit(1)
        .truncationMode(.tail)
        .accessibilityAddTraits(.isHeader)
      modelButton
    }
    .frame(maxWidth: 240)
  }

  private var modelButton: some View {
    Button {
      isModelPickerPresented = true
    } label: {
      HStack(spacing: 3) {
        Text(currentModelLabel)
          .font(.caption2)
          .lineLimit(1)
          .truncationMode(.middle)
        Image(systemName: "chevron.down")
          .font(.system(size: 8, weight: .semibold))
      }
      .foregroundStyle(modelChangeDisabled ? Color.secondary : DashTheme.accent)
      // Deliberately short of the 44pt minimum: a navigation-bar subtitle
      // that tall would double the bar's height. The horizontal padding
      // widens the target in the axis that has room, and the control is a
      // shortcut — the same change is reachable at full size from the
      // agent editor.
      .padding(.horizontal, 8)
      .padding(.vertical, 2)
      .contentShape(Rectangle())
    }
    .disabled(modelChangeDisabled)
    .accessibilityLabel(currentModelLabel)
    .accessibilityHint(
      feature.state.activeTurnID != nil
        ? "Wait for the response to finish before changing the model"
        : "Change model"
    )
    .accessibilityIdentifier("chat.model")
  }

  private func showModelChangeToast(_ change: AgentsFeature.ModelChange) {
    withAnimation(reduceMotion ? nil : .snappy) { modelChangeToast = change }
    AccessibilityNotification.Announcement("Model changed to \(change.modelLabel)").post()
    appModel.agentsFeature?.lastModelChange = nil
    Task {
      try? await Task.sleep(for: .seconds(3.5))
      withAnimation(reduceMotion ? nil : .easeOut) {
        if modelChangeToast == change { modelChangeToast = nil }
      }
    }
  }

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
    // Presentation audit (iPad goal Phase D, Task 11): a `confirmationDialog`
    // is a POPOVER at iPad regular width, and UIKit takes its source rect
    // from the view the modifier is attached to. Attached to `body`'s root —
    // where this used to live — it anchored to the middle-left edge of the
    // whole chat pane, diagonally opposite the toolbar button that opened it.
    // Attached here it anchors to this menu's own ellipsis button. Compact
    // width is unaffected: there it is still a bottom action sheet.
    //
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
    // Summed in steps: the single chained `+` over five optional-chained
    // counts is one Xcode 16.3 (CI) refuses to type-check in reasonable time.
    let assistant = last.assistant
    let textCount: Int = assistant?.text.count ?? 0
    let thinkingCount: Int = assistant?.thinking.count ?? 0
    let toolCount: Int = assistant?.toolCards.count ?? 0
    // The DRAFT count, not `subagentCards.count`: they are always equal, and
    // this signature runs on every transcript change, so it must not pay for
    // the fold's sort.
    let subagentCount: Int = assistant?.subagentDrafts.count ?? 0
    let statusCount: Int = assistant?.statusRows.count ?? 0
    let contentCount = textCount + thinkingCount + toolCount + subagentCount + statusCount
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

  /// iOS 18+ pin rules (transcript scroll fix, 2026-09-05), on the distance
  /// in points between the content's bottom edge and the viewport's bottom
  /// edge (0 = pinned exactly; negative = rubber-banding past the end).
  /// Applied only while the scroll phase is user-driven.
  /// - `repinDistance`: within this of the bottom counts as "back at the
  ///   bottom" — re-pin. Small, so a token arriving while the user is a
  ///   screen up never re-pins them; large enough that a finger settling at
  ///   the very end does.
  static let repinDistance: CGFloat = 8
  /// Sub-point layout rounding must not count as "the tail slid out of view".
  static let pinSlack: CGFloat = 1

  /// iOS 18+: should a pinned transcript scroll back to its tail because the
  /// viewport's height just changed (keyboard/composer/rotation)? Keyed on
  /// the height change so a `scrollTo` that lands a point short cannot
  /// trigger another; and only when the tail actually left the viewport.
  static func viewportChangeNeedsRepin(
    previous: TranscriptScrollMetrics,
    current: TranscriptScrollMetrics
  ) -> Bool {
    previous.viewportHeight != current.viewportHeight
      && current.distanceFromBottom > pinSlack
  }

  /// How much content is hidden below the transcript's visible bottom edge
  /// (0 = the tail is exactly in view; negative = rubber-banding). Measured
  /// on the iOS 26.5 simulator: `ScrollGeometry.visibleRect` spans the scroll
  /// view's frame PLUS its content insets (it reaches under the navigation
  /// bar and the composer), so at the true bottom `visibleRect.maxY` is
  /// `contentSize.height + contentInsets.bottom`. Adding the bottom inset
  /// back makes 0 mean "tail at the composer's top edge" — the same edge
  /// `scrollTo(_, anchor: .bottom)` and the bottom anchor align to, and the
  /// same height (`containerSize.height`) they align within.
  static func distanceFromBottom(
    contentHeight: CGFloat,
    visibleMaxY: CGFloat,
    bottomInset: CGFloat
  ) -> CGFloat {
    contentHeight - visibleMaxY + bottomInset
  }

  /// The state once a user gesture (and any fling after it) has come to
  /// rest: pinned exactly when the user left the bottom in view.
  static func isPinnedAtGestureEnd(distance: CGFloat) -> Bool {
    distance <= repinDistance
  }

  /// Where to scroll the previously-first row after a "Load earlier" page
  /// prepends above it, so it lands back at the viewport position it had:
  /// `scrollTo(_:anchor:)` aligns the row's unit point with the SAME unit
  /// point of the scroll view's frame (`containerSize.height`, measured on
  /// the iOS 26.5 sim: 0.0891 × (611 − 66) landed the row at 48.5pt), so
  /// for a row of height `h` at frame `y = m` in a frame of height `V`,
  /// `t = m / (V - h)` reproduces `m`. A row taller than the frame (or one
  /// whose top was above it) falls back to `.top`.
  static func holdAnchor(rowFrame: CGRect, viewportHeight: CGFloat) -> UnitPoint {
    let room = viewportHeight - rowFrame.height
    guard room > 0, rowFrame.minY > 0 else { return .top }
    return UnitPoint(x: 0, y: min(rowFrame.minY / room, 1))
  }

  /// `true` to pin, `false` to unpin, `nil` to leave the state alone.
  /// Unpins on any user-driven movement AWAY from the bottom that also
  /// leaves the bottom genuinely out of view (`distance > repinDistance`) —
  /// so a rubber-band bounce back to 0 after over-scrolling the end, which
  /// also "moves away", does not unpin. Re-pins as soon as the user brings
  /// the bottom back within `repinDistance`.
  static func pinTransition(previousDistance: CGFloat, distance: CGFloat) -> Bool? {
    if distance <= repinDistance {
      return true
    }
    if distance > previousDistance {
      return false
    }
    return nil
  }

  static func isNearBottom(
    sentinelMinY: CGFloat,
    viewportHeight: CGFloat,
    threshold: CGFloat = nearBottomThreshold
  ) -> Bool {
    sentinelMinY <= viewportHeight + threshold
  }
}

/// The first message row's frame in `ChatView.scrollSpace`, written by
/// `MessageListView` (every OS version) for the "Load earlier" hold.
struct FirstMessageRowFrameKey: PreferenceKey {
  static let defaultValue: CGRect = .zero
  /// Only the first row sets this; every other sibling in the stack
  /// contributes `defaultValue`, and a plain "last one wins" reduce would
  /// hand back `.zero` from the last row (it did — the hold fell back to
  /// `.top` until this ignored empty frames).
  static func reduce(value: inout CGRect, nextValue: () -> CGRect) {
    let next = nextValue()
    if next != .zero { value = next }
  }
}

/// What `ChatView`'s iOS 18+ geometry callback tracks per layout pass:
/// how far the content's bottom edge is below the visible bottom edge
/// (`ChatScrollGeometry.distanceFromBottom`), and the scroll view's frame
/// height (`containerSize.height` — what `scrollTo` anchors are measured
/// against; it shrinks when the keyboard rises).
struct TranscriptScrollMetrics: Equatable {
  var distanceFromBottom: CGFloat
  var viewportHeight: CGFloat
}

/// What a freshly-hosted `ChatView` should do with its transcript's scroll
/// position (iPad goal Phase A, Task 4 review fix, Important 2 + 3).
///
/// Spec §1.3 requires that a re-hosted `ChatView` restore its position
/// instead of jumping, and that a transcript that was pinned to the bottom
/// stay pinned. Both halves reduce to one decision, and that decision is
/// pure — so it lives here, testable as a table, rather than inline in an
/// `onAppear` closure where the only way to observe it is to render SwiftUI
/// and watch a scroll view move.
///
/// This is the RE-HOST question and nothing else. It does not overlap with
/// main's `ChatScrollGeometry` pin rules (merge, 2026-09-07), which answer
/// the WITHIN-a-host question of whether a live transcript should follow its
/// tail. `ChatScrollRestoration` decides where a brand-new host opens;
/// `ChatScrollGeometry` decides what it does from then on. The two meet at
/// exactly one point: this decision seeds `ChatView.isPinnedToBottom`, so
/// the geometry rules start from the state the user actually left behind.
///
/// Deliberately NOT a function of `ChatView.isNearBottom` /
/// `isPinnedToBottom`: both are view `@State`, destroyed and re-initialized
/// by exactly the re-host this decision serves. The inputs are instead the
/// two facts that survive on `ChatFeature` (cached per conversation by
/// `AppModel`), plus the row identities currently in the transcript — an
/// anchor that no longer exists (edit & resend truncation, a cache reload
/// that dropped it) must fall back to the bottom rather than silently scroll
/// nowhere and strand the user at the top.
///
/// `messageIDs` are `ChatMessageState.rowID`s, matching what
/// `MessageListView`'s `ForEach` is keyed on and therefore what
/// `scrollPosition(id:)` reports and `scrollTo` matches.
enum ChatScrollRestoration: Equatable {
  /// Pin to the bottom sentinel — the pre-existing behavior, and the
  /// fallback whenever there is nothing trustworthy to restore.
  case bottom
  /// Restore the remembered message to the top of the viewport.
  case message(id: String)

  static func decide(
    anchor: String?,
    wasPinnedToBottom: Bool,
    messageIDs: Set<String>
  ) -> ChatScrollRestoration {
    guard wasPinnedToBottom == false else { return .bottom }
    guard let anchor, messageIDs.contains(anchor) else { return .bottom }
    return .message(id: anchor)
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
/// overlay shown while `showsJumpToBottom`. Styled as a native circular
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
        .shadow(
          color: .black.opacity(DashTheme.Opacity.shadow),
          radius: DashTheme.Shadow.floatingBlur,
          y: DashTheme.Shadow.floatingOffsetY
        )
        .contentShape(Circle())
    }
    .buttonStyle(.plain)
    .hoverEffect(.lift)
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
