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
    app.tap()

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

    let recoveryRow = element("conversation.recovery.deleted-plan", in: app)
    XCTAssertFalse(app.buttons["Retry"].exists)
    recoveryRow.tap()
    dismissSplitOverlayIfPresent(in: app)

    XCTAssertEqual(
      element("recovery.text.deleted-plan", in: app).label,
      "  Preserve this exact recovery text  "
    )
    XCTAssertTrue(
      element(
        "recovery.attachment.018F0F4A-5C42-7A8B-9C01-1234567890AB",
        in: app
      ).exists
    )
    XCTAssertTrue(element("recovery.share.018F0F4A-5C42-7A8B-9C01-1234567890AB", in: app).exists)
    XCTAssertTrue(
      element(
        "recovery.attachment.018F0F4A-5C42-7A8B-9C01-1234567890AC",
        in: app
      ).exists
    )
    XCTAssertTrue(element("recovery.share.018F0F4A-5C42-7A8B-9C01-1234567890AC", in: app).exists)
    XCTAssertTrue(element("recovery.copy.deleted-plan", in: app).exists)
    XCTAssertFalse(app.buttons["Retry"].exists)

    element("recovery.discard.deleted-plan", in: app).tap()
    let confirmation = app.sheets.buttons["Discard Recovered Message"].firstMatch
    XCTAssertTrue(confirmation.waitForExistence(timeout: 5))
    confirmation.tap()

    XCTAssertTrue(recoveryRow.waitForNonExistence(timeout: 5))
    XCTAssertFalse(app.buttons["Retry"].exists)
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
