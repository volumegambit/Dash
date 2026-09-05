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

  // MARK: - Transcript scrolling (goal 2026-09-05: smooth, no hiccups, in any state)
  //
  // All three run against `long-transcript`: 40 cached messages (ordinals
  // 11–50), a 10-message page behind "Load earlier", and a send that streams
  // 45 deltas over ~3s. See `UITestScenario.longTranscript`.

  func testOpeningALongConversationStartsAtTheLatestMessage() {
    let app = launch(scenario: "long-transcript")
    openFirstConversation(in: app)

    let transcript = element("chat.transcript", in: app)
    let latest = element("chat.message.long-assistant-50", in: app, timeout: 5)
    XCTAssertFalse(
      app.keyboards.firstMatch.waitForExistence(timeout: 1.5),
      "Opening an existing conversation must not raise the keyboard (keyboard-ready auto-focus is for never-used conversations only)"
    )
    XCTAssertTrue(
      waitUntilHittable(latest, timeout: 3),
      "The newest message must be on screen without any scrolling"
    )
    let frame = settledFrame(of: latest)
    XCTAssertLessThanOrEqual(
      frame.maxY, transcript.frame.maxY + 1,
      "The newest message must be fully inside the transcript, not cut off below it"
    )
    XCTAssertFalse(app.descendants(matching: .any)["chat.jumpToBottom"].exists)
  }

  func testLoadEarlierKeepsTheFirstVisibleMessageInPlace() {
    let app = launch(scenario: "long-transcript")
    openFirstConversation(in: app)

    let loadOlder = app.descendants(matching: .any)["chat.loadOlder"]
    for _ in 0..<24 where !(loadOlder.exists && loadOlder.isHittable) {
      app.swipeDown()
    }
    XCTAssertTrue(waitUntilHittable(loadOlder, timeout: 2), "Expected to reach the top of the page")
    let first = element("chat.message.long-user-11", in: app)
    let before = settledFrame(of: first)

    loadOlder.tap()
    XCTAssertTrue(
      waitUntilAbsent(loadOlder, timeout: 5),
      "The control should disappear once the last page has loaded"
    )
    let after = settledFrame(of: first)
    XCTAssertEqual(
      after.minY, before.minY, accuracy: 2,
      "Loading earlier messages must not move the message the user was reading"
    )
  }

  func testDraggingUpMidStreamUnpinsUntilJumpToLatest() {
    let app = launch(scenario: "long-transcript")
    openFirstConversation(in: app)

    replaceText(
      in: element("chat.composer", in: app),
      with: "Stream a long reply",
      clearExisting: false
    )
    let send = element("chat.send", in: app)
    waitUntilEnabled(send)
    send.tap()
    _ = element("chat.message.assistant-ui-turn", in: app, timeout: 5)

    // A short drag — well under the old 100pt near-bottom threshold — with the
    // finger moving DOWN, i.e. scrolling toward earlier messages.
    let transcript = element("chat.transcript", in: app)
    let start = transcript.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.45))
    start.press(forDuration: 0.1, thenDragTo: start.withOffset(CGVector(dx: 0, dy: 60)))

    let jump = app.descendants(matching: .any)["chat.jumpToBottom"]
    XCTAssertTrue(
      jump.waitForExistence(timeout: 2),
      "Any deliberate drag away from the bottom must unpin the transcript, even a short one"
    )
    XCTAssertFalse(
      waitUntilAbsent(jump, timeout: 1),
      "Arriving tokens must not re-pin a transcript the user scrolled away from"
    )

    jump.tap()
    XCTAssertTrue(waitUntilAbsent(jump, timeout: 2), "Jumping to the latest re-pins")
    // Re-pinned means the reply's TAIL is inside the transcript once the
    // stream completes. (Not `isHittable`: that tests the element's centre,
    // which for a reply taller than the viewport is legitimately off-screen.)
    // The streamed row, by message id: every completed reply in a long
    // transcript carries `chat.final.response`, so that one is ambiguous.
    XCTAssertTrue(
      waitUntilAbsent(app.descendants(matching: .any)["chat.cancel"], timeout: 15),
      "The stream should finish (Cancel gives way to Send)"
    )
    let final = element("chat.message.assistant-ui-turn", in: app)
    let tail = settledFrame(of: final)
    let transcriptFrame = transcript.frame
    XCTAssertLessThanOrEqual(
      tail.maxY, transcriptFrame.maxY + 1,
      "After jumping to latest, the end of the reply must stay in view while it finishes streaming"
    )
    XCTAssertGreaterThan(tail.maxY, transcriptFrame.minY, "The reply's end must be on screen")
  }

  private func waitUntilAbsent(_ element: XCUIElement, timeout: TimeInterval) -> Bool {
    let expectation = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "exists == false"),
      object: element
    )
    return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
  }

  /// The element's frame once two reads 250ms apart agree — scroll
  /// deceleration and layout settling otherwise make a single read a
  /// snapshot of a moving target.
  private func settledFrame(of element: XCUIElement) -> CGRect {
    var previous = element.frame
    for _ in 0..<12 {
      Thread.sleep(forTimeInterval: 0.25)
      let current = element.frame
      if current == previous { return current }
      previous = current
    }
    return previous
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
    // Existence, not hittability: on iOS 18 a toolbar Menu's node reports
    // `hittable == false` yet taps fine; the wait is for a slow CI runner.
    XCTAssertTrue(options.waitForExistence(timeout: 8))
    XCTAssertEqual(options.label, "Conversation options")
    XCTAssertTrue(options.isEnabled)
    options.tap()

    let renameItem = app.buttons["Rename"].firstMatch
    let deleteItem = app.buttons["Delete"].firstMatch
    let shareItem = app.buttons["Share Transcript"].firstMatch
    XCTAssertTrue(renameItem.waitForExistence(timeout: 8))
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

    let options = app.buttons.matching(identifier: "chat.options").firstMatch
    // Existence, not hittability: on iOS 18 a toolbar Menu's node reports
    // `hittable == false` yet taps fine; the wait is for a slow CI runner.
    XCTAssertTrue(options.waitForExistence(timeout: 8))
    options.tap()
    let renameItem = app.buttons["Rename"].firstMatch
    XCTAssertTrue(renameItem.waitForExistence(timeout: 8))
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

    let options = app.buttons.matching(identifier: "chat.options").firstMatch
    // Existence, not hittability: on iOS 18 a toolbar Menu's node reports
    // `hittable == false` yet taps fine; the wait is for a slow CI runner.
    XCTAssertTrue(options.waitForExistence(timeout: 8))
    options.tap()
    let deleteItem = app.buttons["Delete"].firstMatch
    XCTAssertTrue(deleteItem.waitForExistence(timeout: 8))
    deleteItem.tap()

    // Final-review fix m6: the dialog's title is now the plan's verbatim,
    // non-interpolated copy ("Delete this conversation? This can't be
    // undone.", split title/message) rather than "Delete <this
    // conversation's own title>?".
    let deleteConfirmation = confirmationDialog(titled: "Delete this conversation?", in: app)
    let confirmDelete = deleteConfirmation.buttons["Delete"].firstMatch
    XCTAssertTrue(
      waitUntilHittable(confirmDelete, timeout: 5),
      "Expected the delete confirmation's destructive action to be available"
    )

    dismissConfirmation(deleteConfirmation, in: app)
    XCTAssertTrue(element("chat.transcript", in: app).exists)
  }

  /// Phase 4 Task 4 (audit #19): an attached image is no longer a dead
  /// 88pt thumbnail — tapping it opens the full-screen viewer with Share
  /// and Save, and Close returns to the transcript.
  func testTappingAnAttachedImageOpensTheFullScreenViewer() {
    let app = launch(scenario: "paired-online")
    openFirstConversation(in: app)

    let thumbnail = element("chat.image.0", in: app)
    XCTAssertTrue(waitUntilHittable(thumbnail, timeout: 5))
    thumbnail.tap()

    XCTAssertTrue(element("chat.imageViewer.image", in: app).waitForExistence(timeout: 5))
    XCTAssertTrue(element("chat.imageViewer.save", in: app).exists)
    XCTAssertTrue(element("chat.imageViewer.share", in: app).exists)

    element("chat.imageViewer.close", in: app).tap()
    XCTAssertTrue(
      app.descendants(matching: .any)["chat.imageViewer.image"].waitForNonExistence(timeout: 5)
    )
    XCTAssertTrue(element("chat.transcript", in: app).exists)
  }

  /// iOS markdown parity (2026-09-04): agents emit GFM pipe tables
  /// constantly; they used to render as literal pipes. The seeded offline
  /// reply carries a two-column table.
  func testAssistantReplyRendersAGFMTable() {
    let app = launch(scenario: "paired-online")
    openFirstConversation(in: app)

    let table = element("chat.markdown.table", in: app)
    XCTAssertTrue(table.waitForExistence(timeout: 5))
    XCTAssertTrue(
      table.label.contains("Region, Status") && table.label.contains("EU, Ready"),
      "Expected the table's accessibility label to read header then rows, got: \(table.label)"
    )
    XCTAssertFalse(app.staticTexts["|:---|---:|"].exists, "Delimiter row must not render literally")
  }

  /// Goal 2026-09-04: change the model from inside a conversation (MC
  /// parity — `ChatModelPicker` there). The toolbar shows the agent's current
  /// model; tapping it opens a provider-grouped picker; choosing a row
  /// commits immediately, the label updates, and a toast confirms.
  func testChatToolbarModelPickerChangesTheAgentModel() {
    let app = launch(scenario: "paired-online")
    openFirstConversation(in: app)

    // `.buttons.matching(identifier:).firstMatch`, like the `chat.options`
    // tests: a toolbar Button bridges to more than one accessibility node.
    XCTAssertTrue(element("chat.model", in: app).waitForExistence(timeout: 5))
    let modelButton = app.buttons.matching(identifier: "chat.model").firstMatch
    XCTAssertTrue(
      waitUntilHittable(modelButton, timeout: 5),
      "Expected the model button to be hittable. UI: \(app.debugDescription)"
    )
    XCTAssertEqual(modelButton.label, "GPT-5")
    modelButton.tap()

    XCTAssertTrue(element("chat.modelPicker.sheet", in: app).waitForExistence(timeout: 5))
    let row = element("chat.modelPicker.row.openai/gpt-5-mini", in: app)
    XCTAssertTrue(waitUntilHittable(row, timeout: 5))
    row.tap()

    XCTAssertTrue(
      app.descendants(matching: .any)["chat.modelPicker.sheet"].waitForNonExistence(timeout: 5)
    )
    XCTAssertTrue(app.staticTexts["Model changed to GPT-5 mini"].waitForExistence(timeout: 5))
    let changed = app.buttons.matching(identifier: "chat.model").firstMatch
    XCTAssertEqual(changed.label, "GPT-5 mini")
  }

  /// Task cards (2026-09-05): the checklist renders, it is open without a
  /// tap, and completed/in-progress/pending items are all present. Before
  /// this the card body was the literal string "Todos: [3 items]".
  func testTaskCardShowsTheChecklistExpandedByDefault() {
    let app = launch(scenario: "streaming-reconnect")
    openFirstConversation(in: app)

    let composer = element("chat.composer", in: app)
    XCTAssertTrue(waitUntilHittable(composer, timeout: 5))
    composer.tap()
    composer.typeText("go")
    let send = element("chat.send", in: app)
    waitUntilEnabled(send)
    send.tap()

    let todos = app.descendants(matching: .any)["chat.tool.todos"]
    XCTAssertTrue(
      todos.waitForExistence(timeout: 10),
      "Expected the task checklist to render without expanding the card. UI: \(app.debugDescription)"
    )
    // Each item is its own combined a11y element, labelled by status.
    XCTAssertTrue(app.staticTexts["Done: Draft the plan"].exists)
    XCTAssertTrue(app.staticTexts["In progress: Check launch readiness"].exists)
    XCTAssertTrue(app.staticTexts["Pending: Ship it"].exists)
  }

  /// Composer newline keys (2026-09-05). Verifies the two halves of the
  /// change that no unit test can reach: that SwiftUI's `onKeyPress` fires
  /// at all for a focused `TextField` (the risky assumption), and that
  /// removing `.onSubmit` stopped Return from sending.
  func testShiftTabInsertsANewlineInsteadOfSending() {
    let app = launch(scenario: "paired-online")
    openFirstConversation(in: app)

    let composer = element("chat.composer", in: app)
    XCTAssertTrue(waitUntilHittable(composer, timeout: 5))
    composer.tap()
    composer.typeText("first")
    composer.typeKey(XCUIKeyboardKey.tab.rawValue, modifierFlags: .shift)
    composer.typeText("second")

    let value = composer.value as? String ?? ""
    XCTAssertTrue(
      value.contains("\n"),
      "Expected Shift+Tab to insert a newline. Composer value: \(value)"
    )
    XCTAssertTrue(value.contains("first"), "Composer value: \(value)")
    XCTAssertTrue(value.contains("second"), "Composer value: \(value)")
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

  /// Phase 4 minor 2 (iOS half; web half is `ConversationList.test.tsx`'s
  /// "clears an active search filter when a new conversation is created"):
  /// composing while a search query is active used to leave the query in
  /// place, so the conversation just opened was SELECTED but filtered out of
  /// the list — on iPad, side by side with a sidebar showing "No Results".
  /// Compose must clear the search so the sidebar and the transcript pane
  /// agree about what is open.
  func testComposeUnderActiveSearchClearsTheSearchSoTheOpenedConversationHasAVisibleRow() throws {
    let app = launch(scenario: "paired-online")
    // Compact width collapses the navigation bar to search-field + Cancel for
    // as long as a search is active (keyboard up or not), which hides the
    // toolbar's compose button entirely — verified on the iPhone 16 Pro
    // simulator, iOS 26 — so the selected-but-invisible state is only
    // reachable in the regular-width split view, where the sidebar keeps its
    // toolbar beside the open conversation.
    try XCTSkipIf(
      app.windows.firstMatch.frame.width < 700,
      "Compose-under-active-search is only reachable in the regular-width split view"
    )
    // iPadOS 26 opens straight onto the conversations column (sidebar-tab
    // layout, no `tab.*` bar to select from); older runtimes need the tab.
    if app.descendants(matching: .any)["conversation.list"].waitForExistence(timeout: 2) == false {
      selectTab("tab.conversations", in: app)
    }
    revealSidebarIfNeeded(toExpose: "conversation.row.shared-plan", in: app)
    let row = element("conversation.row.shared-plan", in: app)

    let searchField = app.searchFields.firstMatch
    XCTAssertTrue(searchField.waitForExistence(timeout: 5))
    searchField.tap()
    searchField.typeText("nonexistent conversation title")
    XCTAssertTrue(row.waitForNonExistence(timeout: 5))
    // Commit the search (keyboard "Search" key): the query stays, the
    // keyboard goes, and the collapsed navigation bar gives the toolbar —
    // and with it the compose button — back.
    searchField.typeText("\n")

    // The fake store's create dedups by agent, so compose here reopens the
    // (populated) shared-plan conversation rather than a fresh one — exactly
    // the row the search just hid.
    // iOS 18's `.searchable` collapses the sidebar's navigation bar to
    // search-field + Cancel for the whole active search, hiding the compose
    // toolbar item — there the bug is unreachable, and this test has nothing
    // to prove. iOS 26 keeps the toolbar beside the search field.
    let compose = app.descendants(matching: .any)["conversation.new"]
    try XCTSkipUnless(
      compose.waitForExistence(timeout: 3),
      "This runtime hides the compose toolbar item while a search is active"
    )
    waitUntilEnabled(compose)
    compose.tap()
    XCTAssertTrue(element("chat.transcript", in: app).waitForExistence(timeout: 5))

    revealSidebarIfNeeded(toExpose: "conversation.row.shared-plan", in: app)
    XCTAssertTrue(
      element("conversation.row.shared-plan", in: app).waitForExistence(timeout: 5),
      "Expected compose to clear the active search so the opened conversation's row is visible"
    )
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

  /// Review fix I1: backing out of a compose-created, still-empty
  /// conversation without ever sending anything used to leave a permanent
  /// empty "New Conversation" row — the exact anti-pattern audit #16
  /// targets. iPhone-only: on the regular/iPad split, tapping the sidebar
  /// toggle doesn't deselect the open conversation (`splitConversationSelection`
  /// is unchanged), so `ChatView.onDisappear`'s `stillNavigatedTo` guard
  /// deliberately does NOT treat that as "left" — see its doc comment.
  func testComposeThenBackWithoutSendingLeavesNoPermanentRow() throws {
    let app = launch(scenario: "compose-new-chat")
    try XCTSkipIf(app.windows.firstMatch.frame.width >= 700, "Compact back-navigation is iPhone-only")
    selectTab("tab.conversations", in: app)

    element("conversation.new", in: app).tap()
    XCTAssertTrue(element("chat.transcript", in: app).waitForExistence(timeout: 5))

    app.navigationBars.buttons.firstMatch.tap()

    XCTAssertTrue(element("conversation.list", in: app).exists)
    XCTAssertTrue(
      app.descendants(matching: .any)["conversation.row.conversation-research-agent"]
        .waitForNonExistence(timeout: 5),
      "Expected backing out of an unsent compose-created conversation to leave no permanent row"
    )
    XCTAssertTrue(app.staticTexts["No conversations"].waitForExistence(timeout: 5))
  }
}
