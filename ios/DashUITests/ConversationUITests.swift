import XCTest

@MainActor
final class ConversationUITests: DashUITestCase {
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
    XCTAssertTrue(app.buttons["Thinking"].exists)
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
      "  Preserve this exact newer draft text too  "
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
    if app.windows.firstMatch.frame.width < 700 {
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
    } else {
      let confirmation = app.sheets.matching(
        NSPredicate(format: "label == %@", "Discard both recovery copies?")
      ).firstMatch
      XCTAssertTrue(confirmation.waitForExistence(timeout: 3))
      let dismissRegion = app.otherElements.matching(identifier: "PopoverDismissRegion").firstMatch
      XCTAssertTrue(dismissRegion.waitForExistence(timeout: 3))
      dismissRegion.tap()
    }

    XCTAssertTrue(element("recovery.text.deleted-plan", in: app).exists)
    XCTAssertTrue(element("recovery.draft.text.deleted-plan", in: app).exists)
    XCTAssertTrue(element("recovery.discard.deleted-plan", in: app).exists)
    XCTAssertFalse(app.buttons["Retry"].exists)

    element("recovery.discard.deleted-plan", in: app).tap()
    if app.windows.firstMatch.frame.width < 700 {
      let confirmation = confirmationDialog(titled: "Discard both recovery copies?", in: app)
      confirmation.buttons["Discard Recovered Message"].tap()
    } else {
      let confirmation = app.sheets.matching(
        NSPredicate(format: "label == %@", "Discard both recovery copies?")
      ).firstMatch
      XCTAssertTrue(confirmation.waitForExistence(timeout: 3))
      confirmation.buttons["Discard Recovered Message"].tap()
    }

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
      "  Preserve this exact newer draft text too  "
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
      "  Preserve this exact newer draft text too  "
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
    let exactDraft = "  Preserve this exact newer draft text too  "
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
}
