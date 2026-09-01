import XCTest

@MainActor
final class ConversationUITests: DashUITestCase {
  private static let recoveredNewerDraftText =
    "  Preserve this exact newer draft text too through a "
    + "horizontally scrolling composer  "

  func testCachedOfflineHistoryAllowsDraftButBlocksRemoteMutations() {
    let app = launch(scenario: "paired-offline")

    revealSidebarIfNeeded(toExpose: "conversation.row.shared-plan", in: app)
    XCTAssertTrue(
      app.staticTexts["Offline — showing saved content"].waitForExistence(timeout: 5)
    )
    let list = element("conversation.list", in: app)
    XCTAssertTrue(list.exists)
    XCTAssertTrue(app.staticTexts["Cached"].waitForExistence(timeout: 5))
    XCTAssertFalse(element("conversation.new", in: app).isEnabled)

    let row = element("conversation.row.shared-plan", in: app)
    row.press(forDuration: 1)
    XCTAssertFalse(app.buttons["Rename"].isEnabled)
    XCTAssertFalse(app.buttons["Delete"].isEnabled)
    app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.08)).tap()
    XCTAssertTrue(
      waitUntilHittable(row, timeout: 3),
      "Expected the conversation row to become actionable after dismissing its context menu"
    )

    row.tap()
    dismissSplitOverlayIfPresent(in: app)
    XCTAssertTrue(element("chat.transcript", in: app).exists)
    XCTAssertTrue(app.staticTexts["Saved from your Mac"].waitForExistence(timeout: 5))
    let composer = element("chat.composer", in: app)
    XCTAssertTrue(composer.isEnabled)
    replaceText(in: composer, with: "Continue this draft offline", clearExisting: false)
    XCTAssertEqual(composer.value as? String, "Continue this draft offline")
    XCTAssertFalse(element("chat.send", in: app).isEnabled)
    XCTAssertTrue(app.staticTexts["Connect to the gateway to send"].exists)
  }

  func testCachedOfflineAgentsRemainVisibleButBlockRemoteMutations() {
    let app = launch(scenario: "paired-offline")

    selectTab("tab.agents", in: app)
    revealSidebarIfNeeded(toExpose: "agent.row.research-agent", in: app)
    XCTAssertTrue(element("agent.list", in: app).exists)
    XCTAssertTrue(element("agent.row.research-agent", in: app).exists)
    let createAgent = app.buttons.matching(identifier: "agent.create").firstMatch
    XCTAssertTrue(createAgent.waitForExistence(timeout: 5))
    XCTAssertFalse(createAgent.isEnabled)

    element("agent.row.research-agent", in: app).tap()
    dismissSplitOverlayIfPresent(in: app)
    for identifier in ["agent.startChat", "agent.edit", "agent.actions"] {
      let control = app.buttons.matching(identifier: identifier).firstMatch
      XCTAssertTrue(control.waitForExistence(timeout: 5))
      XCTAssertFalse(control.isEnabled)
    }
  }

  func testStreamingReconnectPreservesProjectionAndCompletesOnce() {
    let app = launch(scenario: "streaming-reconnect")
    openFirstConversation(in: app)

    replaceText(
      in: element("chat.composer", in: app),
      with: "Prepare the launch plan",
      clearExisting: false
    )
    let send = element("chat.send", in: app)
    waitUntilEnabled(send)
    send.tap()

    let message = element("chat.message.assistant-ui-turn", in: app)
    XCTAssertTrue(app.staticTexts["Reconnecting"].waitForExistence(timeout: 3))
    XCTAssertTrue(app.buttons["Show thinking"].exists)
    XCTAssertTrue(app.descendants(matching: .any)["chat.question.ui-question"].exists)
    XCTAssertTrue(app.descendants(matching: .any)["chat.tool.ui-tool"].exists)
    XCTAssertTrue(app.descendants(matching: .any)["chat.worker.ui-worker"].exists)
    XCTAssertTrue(message.exists, "Partial response must remain mounted while reconnecting")

    let final = element("chat.final.response", in: app, timeout: 8)
    XCTAssertEqual(final.label, "Recovered exactly once.")
    XCTAssertEqual(
      app.descendants(matching: .any).matching(identifier: "chat.final.response").count, 1)
    XCTAssertEqual(message.label, "Assistant message, completed")
  }

  /// Audit #4 / Task 3: minimal UI smoke test for the jump-to-bottom
  /// affordance. An earlier version of this test seeded extra filler history
  /// into the shared `streaming-reconnect` fixture so a real swipe-up
  /// gesture would have something to scroll away from — that broke every
  /// OTHER test built on this scenario two different ways: (1) SwiftUI's
  /// `LazyVStack` doesn't materialize far-off-screen rows, so
  /// `chat.message.assistant-ui-turn` stopped existing in the accessibility
  /// tree for tests that don't scroll; (2) every extra *completed* assistant
  /// filler message carries the same `chat.final.response` identifier as the
  /// live turn's, so "the" final-response lookup started matching multiple
  /// elements. Given that fragility, and this task's own guidance that UI
  /// scroll assertions are flaky, this stays a state-transition smoke test
  /// against the UNMODIFIED scenario: the pill must never appear during a
  /// normal (still-pinned) streaming turn, and the turn must still complete
  /// exactly once. The actual near-bottom threshold math (the iOS 17 fix
  /// itself) and the cheap-signature behavior are covered directly and
  /// deterministically by `ChatScrollGeometryTests`/`ChatTranscriptSignatureTests`
  /// in `DashTests`.
  func testJumpToBottomStaysHiddenThroughoutANormalPinnedStreamingTurn() {
    let app = launch(scenario: "streaming-reconnect")
    openFirstConversation(in: app)

    let jumpButton = app.descendants(matching: .any)["chat.jumpToBottom"]
    XCTAssertFalse(jumpButton.exists)

    replaceText(
      in: element("chat.composer", in: app),
      with: "Prepare the launch plan",
      clearExisting: false
    )
    let send = element("chat.send", in: app)
    waitUntilEnabled(send)
    send.tap()

    XCTAssertTrue(app.staticTexts["Reconnecting"].waitForExistence(timeout: 3))
    // Never shown while pinned — the transcript is short enough here that it
    // shouldn't overflow the viewport, but this also guards against a
    // regression that shows it unconditionally regardless of pin state.
    XCTAssertFalse(jumpButton.exists)

    let final = element("chat.final.response", in: app, timeout: 8)
    XCTAssertEqual(final.label, "Recovered exactly once.")
    XCTAssertFalse(jumpButton.exists)
  }

  func testCancelReplacesSendAndProducesCancelledTerminalState() {
    let app = launch(scenario: "streaming-reconnect")
    openFirstConversation(in: app)
    replaceText(
      in: element("chat.composer", in: app),
      with: "Start a cancellable task",
      clearExisting: false
    )
    let send = element("chat.send", in: app)
    waitUntilEnabled(send)
    send.tap()

    _ = element("chat.message.assistant-ui-turn", in: app)
    let cancel = element("chat.cancel", in: app)
    XCTAssertFalse(app.descendants(matching: .any)["chat.send"].exists)
    cancel.tap()

    XCTAssertTrue(app.staticTexts["Response cancelled"].waitForExistence(timeout: 5))
    XCTAssertEqual(
      element("chat.message.assistant-ui-turn", in: app).label, "Assistant message, cancelled")
  }

  func testRemoteActiveTurnBlocksComposer() {
    let app = launch(scenario: "remote-busy")
    openFirstConversation(in: app)

    XCTAssertFalse(element("chat.composer", in: app).isEnabled)
    XCTAssertFalse(element("chat.send", in: app).isEnabled)
    XCTAssertTrue(app.staticTexts["This conversation is active on another device"].exists)
    XCTAssertFalse(app.descendants(matching: .any)["chat.cancel"].exists)
  }

  func testDeletedPendingSendRecoveryIsReachablePreviewableAndExplicitlyDiscarded() {
    let app = launch(scenario: "pending-recovery")

    revealSidebarIfNeeded(toExpose: "conversation.recovery.deleted-plan", in: app)
    let recoveryRow = element("conversation.recovery.deleted-plan", in: app)
    XCTAssertFalse(app.buttons["Retry"].exists)
    recoveryRow.tap()
    dismissSplitOverlayIfPresent(in: app)

    XCTAssertEqual(
      element("recovery.text.deleted-plan", in: app).label,
      "  Preserve this exact recovery text  "
    )
    let validPreview = element(
      "recovery.preview.018F0F4A-5C42-7A8B-9C01-1234567890AB",
      in: app
    )
    XCTAssertTrue(validPreview.waitForExistence(timeout: 5))
    XCTAssertEqual(validPreview.label, "Recovered image attachment 1 of 2, PNG")
    XCTAssertEqual(
      element("recovery.share.018F0F4A-5C42-7A8B-9C01-1234567890AB", in: app).label,
      "Share recovered image attachment 1 of 2, PNG"
    )
    let unavailablePreview = element(
      "recovery.previewFallback.018F0F4A-5C42-7A8B-9C01-1234567890AC",
      in: app
    )
    XCTAssertTrue(unavailablePreview.waitForExistence(timeout: 5))
    XCTAssertEqual(
      unavailablePreview.label,
      "Recovered image attachment 2 of 2, JPEG, preview unavailable"
    )
    XCTAssertEqual(
      element("recovery.share.018F0F4A-5C42-7A8B-9C01-1234567890AC", in: app).label,
      "Share recovered image attachment 2 of 2, JPEG"
    )
    XCTAssertTrue(element("recovery.copy.deleted-plan", in: app).exists)

    XCTAssertEqual(
      element("recovery.draft.text.deleted-plan", in: app).label,
      Self.recoveredNewerDraftText
    )
    let draftPreview = element(
      "recovery.preview.018F0F4A-5C42-7A8B-9C01-1234567890AD",
      in: app
    )
    XCTAssertTrue(draftPreview.waitForExistence(timeout: 5))
    XCTAssertEqual(draftPreview.label, "Recovered image attachment 1 of 1, PNG")
    XCTAssertEqual(
      element("recovery.share.018F0F4A-5C42-7A8B-9C01-1234567890AD", in: app).label,
      "Share recovered image attachment 1 of 1, PNG"
    )
    XCTAssertTrue(element("recovery.draft.copy.deleted-plan", in: app).exists)
    XCTAssertFalse(app.buttons["Retry"].exists)

    element("recovery.discard.deleted-plan", in: app).tap()
    let confirmation = confirmationDialog(titled: "Discard both recovery copies?", in: app)
    let cancel = confirmation.buttons["Cancel"].firstMatch
    XCTAssertTrue(
      waitUntilHittable(cancel, timeout: 3),
      "Expected the recovery confirmation's Cancel action to be available"
    )
    cancel.tap()
    XCTAssertTrue(
      confirmation.waitForNonExistence(timeout: 3),
      "Expected Cancel to dismiss the recovery confirmation"
    )

    XCTAssertTrue(element("recovery.text.deleted-plan", in: app).exists)
    XCTAssertTrue(element("recovery.draft.text.deleted-plan", in: app).exists)
    XCTAssertTrue(element("recovery.discard.deleted-plan", in: app).exists)
    XCTAssertFalse(app.buttons["Retry"].exists)

    element("recovery.discard.deleted-plan", in: app).tap()
    let destructiveConfirmation = confirmationDialog(
      titled: "Discard both recovery copies?",
      in: app
    )
    let discard = destructiveConfirmation.buttons["Discard Recovered Message"].firstMatch
    XCTAssertTrue(
      waitUntilHittable(discard, timeout: 3),
      "Expected the recovery confirmation's destructive action to be available"
    )
    discard.tap()

    XCTAssertTrue(recoveryRow.waitForNonExistence(timeout: 5))
    if app.windows.firstMatch.frame.width < 700 {
      XCTAssertTrue(element("conversation.list", in: app).exists)
      XCTAssertTrue(tab("tab.conversations", in: app).isSelected)
      XCTAssertFalse(app.staticTexts["Select a conversation"].exists)
    } else {
      XCTAssertTrue(app.staticTexts["Select a conversation"].waitForExistence(timeout: 5))
      revealSidebarIfNeeded(toExpose: "conversation.list", in: app)
      XCTAssertTrue(element("conversation.list", in: app).exists)
    }
    XCTAssertFalse(app.descendants(matching: .any)["recovery.text.deleted-plan"].exists)
    XCTAssertFalse(app.descendants(matching: .any)["recovery.draft.text.deleted-plan"].exists)
    XCTAssertFalse(app.buttons["Retry"].exists)
  }

  func testActivePendingSendRecoveryDiscardPreservesNewerDraftInConversation() {
    let app = launch(scenario: "active-recovery")

    selectTab("tab.conversations", in: app)
    revealSidebarIfNeeded(toExpose: "conversation.row.shared-plan", in: app)
    element("conversation.row.shared-plan", in: app).tap()
    dismissSplitOverlayIfPresent(in: app)
    _ = element("chat.transcript", in: app)
    let guardedComposer = element("chat.composer", in: app)
    XCTAssertEqual(
      guardedComposer.value as? String,
      Self.recoveredNewerDraftText
    )
    XCTAssertFalse(guardedComposer.isEnabled)
    XCTAssertFalse(element("chat.send", in: app).isEnabled)
    XCTAssertTrue(app.staticTexts["Message saved for recovery"].exists)

    if app.windows.firstMatch.frame.width < 700 {
      let back = app.navigationBars.buttons.firstMatch
      XCTAssertTrue(
        waitUntilHittable(back, timeout: 3),
        "Expected compact navigation to return to the recovery list"
      )
      back.tap()
      _ = element("conversation.list", in: app)
    }

    revealSidebarIfNeeded(toExpose: "conversation.recovery.shared-plan", in: app)
    let recoveryRow = element("conversation.recovery.shared-plan", in: app)
    recoveryRow.tap()
    dismissSplitOverlayIfPresent(in: app)

    XCTAssertEqual(
      element("recovery.text.shared-plan", in: app).label,
      "  Preserve this exact recovery text  "
    )
    XCTAssertEqual(
      element("recovery.draft.text.shared-plan", in: app).label,
      Self.recoveredNewerDraftText
    )

    element("recovery.discard.shared-plan", in: app).tap()
    let confirmation = confirmationDialog(titled: "Discard this recovered message?", in: app)
    let preservationMessage =
      "This permanently removes the earlier message recovery. The newer draft remains saved "
      + "with its conversation."
    XCTAssertTrue(
      confirmation.staticTexts[preservationMessage].waitForExistence(timeout: 3),
      "Expected confirmation to explain that the newer draft remains saved"
    )
    confirmation.buttons["Discard Recovered Message"].tap()

    XCTAssertTrue(recoveryRow.waitForNonExistence(timeout: 5))
    revealSidebarIfNeeded(toExpose: "conversation.row.shared-plan", in: app)
    element("conversation.row.shared-plan", in: app).tap()
    dismissSplitOverlayIfPresent(in: app)

    let composer = element("chat.composer", in: app)
    let exactDraft = Self.recoveredNewerDraftText
    XCTAssertEqual(
      XCTWaiter.wait(
        for: [
          XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "value == %@", exactDraft),
            object: composer
          )
        ],
        timeout: 5
      ),
      .completed,
      "Expected the exact newer draft to load into the composer"
    )
    XCTAssertTrue(
      waitUntilHittable(composer, timeout: 5),
      "Expected the mounted chat composer to become editable after discard"
    )
    XCTAssertTrue(composer.isEnabled)
    let send = element("chat.send", in: app)
    waitUntilEnabled(send)
    let attachedImage1 = app.descendants(matching: .any).matching(
      NSPredicate(format: "label == %@", "Attached image 1")
    )
    XCTAssertTrue(attachedImage1.firstMatch.waitForExistence(timeout: 5))
    XCTAssertFalse(
      app.descendants(matching: .any).matching(
        NSPredicate(format: "label == %@", "Attached image 2")
      ).firstMatch.exists
    )

    replaceText(in: composer, with: "Edited after discard")
    XCTAssertEqual(composer.value as? String, "Edited after discard")
    XCTAssertTrue(composer.isEnabled)
    XCTAssertTrue(send.isEnabled)
  }

  /// Audit #15 (iOS chat-screen toolbar): presence smoke test for the "⋯"
  /// Menu — Rename/Delete/Share Transcript should all be offered, enabled,
  /// for an idle, online, mutable conversation (`shared-plan` in
  /// `paired-online`). Split into three single-open tests (this one plus
  /// the two below) rather than one test that reopens the Menu multiple
  /// times: reopening it produced flaky "multiple matching elements" lookups
  /// against stale, not-yet-torn-down `Menu` item elements from the
  /// previous presentation.
  func testChatToolbarMenuOffersRenameDeleteAndShareTranscript() {
    let app = launch(scenario: "paired-online")
    openFirstConversation(in: app)

    // `.buttons.matching(identifier:).firstMatch`, not the shared `element`
    // helper: this toolbar Menu — like `AgentDetailView`'s "agent.actions"
    // Menu (see its offline UI test) — resolves to more than one
    // accessibility node (its `UIBarButtonItem` bridging plus the SwiftUI
    // hierarchy), so a strict single-match lookup throws "multiple matching
    // elements".
    let options = app.buttons.matching(identifier: "chat.options").firstMatch
    XCTAssertTrue(options.waitForExistence(timeout: 5))
    XCTAssertEqual(options.label, "Conversation options")
    XCTAssertTrue(options.isEnabled)
    options.tap()

    let renameItem = app.buttons["Rename"].firstMatch
    let deleteItem = app.buttons["Delete"].firstMatch
    let shareItem = app.buttons["Share Transcript"].firstMatch
    XCTAssertTrue(renameItem.waitForExistence(timeout: 3))
    XCTAssertTrue(renameItem.isEnabled)
    XCTAssertTrue(deleteItem.exists)
    XCTAssertTrue(deleteItem.isEnabled)
    XCTAssertTrue(shareItem.exists)
    XCTAssertTrue(shareItem.isEnabled)
  }

  /// Rename should open the exact same alert copy `ConversationListView`'s
  /// context menu uses, prefilled with the conversation's current title —
  /// stops short of completing the rename since `ConversationListFeatureTests`
  /// already covers `rename` end-to-end at the feature layer this Menu item
  /// calls straight through to.
  func testChatToolbarRenameOpensPrefilledRenameAlert() {
    let app = launch(scenario: "paired-online")
    openFirstConversation(in: app)

    app.buttons.matching(identifier: "chat.options").firstMatch.tap()
    let renameItem = app.buttons["Rename"].firstMatch
    XCTAssertTrue(renameItem.waitForExistence(timeout: 3))
    renameItem.tap()

    let renameAlert = app.alerts["Rename conversation"]
    XCTAssertTrue(renameAlert.waitForExistence(timeout: 3))
    XCTAssertEqual(renameAlert.textFields.firstMatch.value as? String, "Shared launch plan")
    let cancelRename = renameAlert.buttons["Cancel"].firstMatch
    XCTAssertTrue(waitUntilHittable(cancelRename, timeout: 3))
    cancelRename.tap()
    XCTAssertTrue(renameAlert.waitForNonExistence(timeout: 3))
    XCTAssertTrue(element("chat.transcript", in: app).exists)
  }

  /// Delete should open the exact same confirmation copy
  /// `ConversationListView`'s context menu uses — stops short of completing
  /// the delete since `ConversationListFeatureTests` already covers `delete`
  /// end-to-end at the feature layer this Menu item calls straight through
  /// to, and this screen's pop-back-on-delete is exercised there via
  /// `pruneTranscriptRoutes`. Dismissed via `PopoverDismissRegion` rather
  /// than a "Cancel" button: on this simulator, a `confirmationDialog`
  /// triggered from a toolbar Menu's button action — including the
  /// pre-existing, unmodified `ConversationListView` one triggered from its
  /// `.contextMenu` — renders as a small anchored popover with only the
  /// destructive action and no separate Cancel row (dismiss-by-tapping-
  /// outside covers that role instead); this is a platform rendering choice
  /// unrelated to this task's changes, confirmed by probing the existing
  /// list dialog with the same shape.
  func testChatToolbarDeleteOpensConfirmationDialog() {
    let app = launch(scenario: "paired-online")
    openFirstConversation(in: app)

    app.buttons.matching(identifier: "chat.options").firstMatch.tap()
    let deleteItem = app.buttons["Delete"].firstMatch
    XCTAssertTrue(deleteItem.waitForExistence(timeout: 3))
    deleteItem.tap()

    let deleteConfirmation = confirmationDialog(titled: "Delete Shared launch plan?", in: app)
    let confirmDelete = deleteConfirmation.buttons["Delete"].firstMatch
    XCTAssertTrue(
      waitUntilHittable(confirmDelete, timeout: 5),
      "Expected the delete confirmation's destructive action to be available"
    )

    let dismissRegion = app.otherElements.matching(identifier: "PopoverDismissRegion").firstMatch
    XCTAssertTrue(dismissRegion.waitForExistence(timeout: 3))
    dismissRegion.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.6)).tap()
    XCTAssertTrue(deleteConfirmation.waitForNonExistence(timeout: 5))
    XCTAssertTrue(element("chat.transcript", in: app).exists)
  }

  func testConversationListSearchFiltersByTitleAndPreview() {
    let app = launch(scenario: "paired-online")
    selectTab("tab.conversations", in: app)
    revealSidebarIfNeeded(toExpose: "conversation.row.shared-plan", in: app)
    // Captured now, while it's known to exist — `waitForNonExistence` below
    // watches this same element handle disappear rather than re-resolving
    // the identifier (which would fail its own existence assertion first).
    let row = element("conversation.row.shared-plan", in: app)

    let searchField = app.searchFields.firstMatch
    XCTAssertTrue(searchField.waitForExistence(timeout: 5))
    searchField.tap()
    searchField.typeText("nonexistent conversation title")

    XCTAssertTrue(
      row.waitForNonExistence(timeout: 5),
      "Expected the shared-plan row to be filtered out by a non-matching search query"
    )

    searchField.buttons["Clear text"].tap()
    XCTAssertTrue(element("conversation.row.shared-plan", in: app).waitForExistence(timeout: 5))
  }

  func testIPhoneBackReturnsToConversationListInSameTab() throws {
    let app = launch(scenario: "paired-online")
    try XCTSkipIf(app.windows.firstMatch.frame.width >= 700, "Compact navigation is iPhone-only")
    openFirstConversation(in: app)

    app.navigationBars.buttons.firstMatch.tap()
    XCTAssertTrue(element("conversation.list", in: app).exists)
    XCTAssertTrue(tab("tab.conversations", in: app).isSelected)
  }

  func testIPadSplitNavigation() throws {
    let app = launch(scenario: "paired-online")
    try XCTSkipUnless(app.windows.firstMatch.frame.width >= 700, "Split navigation is iPad-only")

    revealSidebarIfNeeded(toExpose: "conversation.row.shared-plan", in: app)
    element("conversation.row.shared-plan", in: app).tap()
    XCTAssertTrue(element("chat.transcript", in: app).exists)
    revealSidebarIfNeeded(toExpose: "conversation.list", in: app)
    XCTAssertTrue(element("conversation.list", in: app).exists)
    waitUntilSelected(element("conversation.row.shared-plan", in: app))
  }

  // MARK: - Compose-first new chat (Task 3, audit #16)

  /// Tapping the compose button lands straight in a fresh, empty `ChatView`
  /// — no intermediate agent-picker Form (the old `NewConversationView`
  /// flow this replaces) — with the composer keyboard-ready and the header
  /// chip showing the default agent (the first enabled agent, since nothing
  /// has been used on this gateway yet).
  func testComposeButtonEntersChatDirectlyWithKeyboardReadyComposerAndDefaultAgent() {
    let app = launch(scenario: "compose-new-chat")
    selectTab("tab.conversations", in: app)

    let compose = element("conversation.new", in: app)
    waitUntilEnabled(compose)
    compose.tap()

    XCTAssertTrue(element("chat.transcript", in: app).waitForExistence(timeout: 5))
    let composer = element("chat.composer", in: app)
    XCTAssertTrue(
      waitUntilHittable(composer, timeout: 5),
      "Expected the composer to be immediately actionable after compose"
    )
    XCTAssertTrue(
      app.keyboards.firstMatch.waitForExistence(timeout: 5),
      "Expected the composer to be keyboard-ready without an extra tap"
    )

    let chip = element("chat.agentChip", in: app)
    XCTAssertEqual(chip.value as? String, "Research Agent")
  }

  /// Selecting a different agent from the header chip's picker can't patch
  /// the OPEN (still-empty) conversation's agent in place — the gateway has
  /// no such endpoint — so it creates a new conversation under the chosen
  /// agent and swaps over to it, AND remembers that choice: reopening
  /// compose afterward defaults to the newly-chosen agent instead of the
  /// original default. Once a message is actually sent, the chip disappears
  /// — the agent decision is locked in for that conversation, and the
  /// picker is (deliberately) not a way to reassign an in-use conversation.
  func testAgentChipSwitchesConversationAndPersistsLastUsedAgent() {
    let app = launch(scenario: "compose-new-chat")
    selectTab("tab.conversations", in: app)

    element("conversation.new", in: app).tap()
    let chip = element("chat.agentChip", in: app)
    XCTAssertEqual(chip.value as? String, "Research Agent")

    chip.tap()
    let sheet = element("chat.agentPicker.sheet", in: app)
    XCTAssertTrue(sheet.exists)
    element("chat.agentPicker.row.delete-agent", in: app).tap()

    XCTAssertTrue(sheet.waitForNonExistence(timeout: 5))
    XCTAssertTrue(element("chat.transcript", in: app).waitForExistence(timeout: 5))
    let switchedChip = element("chat.agentChip", in: app)
    XCTAssertEqual(switchedChip.value as? String, "Delete Me")

    // Back to the list, then compose again: last-used-agent persistence
    // means this lands back on the SAME "Delete Me" conversation rather
    // than defaulting to "Research Agent" again.
    revealSidebarIfNeeded(toExpose: "conversation.list", in: app)
    element("conversation.new", in: app).tap()
    let reopenedChip = element("chat.agentChip", in: app)
    XCTAssertEqual(reopenedChip.value as? String, "Delete Me")

    // Sending a message locks the agent in: the chip is no longer offered.
    let composer = element("chat.composer", in: app)
    replaceText(in: composer, with: "Kick off the plan", clearExisting: false)
    let send = element("chat.send", in: app)
    waitUntilEnabled(send)
    send.tap()
    XCTAssertTrue(
      app.descendants(matching: .any)["chat.agentChip"].waitForNonExistence(timeout: 5),
      "Expected the agent chip to disappear once a message has been sent"
    )
  }
}
