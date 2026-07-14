import XCTest

@MainActor
final class AccessibilityUITests: DashUITestCase {
  func testSettingsForgetReturnsToConnectAndRemovesCachedRows() {
    let app = launch(scenario: "settings-forget")
    selectTab("tab.settings", in: app)
    element("settings.disconnect", in: app).tap()
    let confirmation = confirmationDialog(titled: "Disconnect & Forget?", in: app)
    confirmation.buttons["Disconnect & Forget"].tap()

    XCTAssertTrue(element("pairing.scan", in: app).waitForExistence(timeout: 5))
    XCTAssertFalse(app.descendants(matching: .any)["conversation.row.shared-plan"].exists)
    XCTAssertFalse(app.descendants(matching: .any)["agent.row.research-agent"].exists)
  }

  func testAccessibilityXXXL() {
    var app = launch(scenario: "unpaired", contentSize: Self.accessibilityXXXL)
    assertFitsHorizontally(element("pairing.scan", in: app), in: app)
    assertFitsHorizontally(element("pairing.paste", in: app), in: app)
    assertFitsHorizontally(element("pairing.manual", in: app), in: app)
    app.terminate()

    app = launch(scenario: "paired-online", contentSize: Self.accessibilityXXXL)
    selectTab("tab.conversations", in: app)
    revealSidebarIfNeeded(toExpose: "conversation.row.shared-plan", in: app)
    assertFitsHorizontally(element("conversation.list", in: app), in: app)
    element("conversation.row.shared-plan", in: app).tap()
    dismissSplitOverlayIfPresent(in: app)
    assertFitsHorizontally(element("chat.transcript", in: app), in: app)
    assertFitsHorizontally(element("chat.composer", in: app), in: app)

    selectTab("tab.agents", in: app)
    revealSidebarIfNeeded(toExpose: "agent.row.research-agent", in: app)
    element("agent.row.research-agent", in: app).tap()
    dismissSplitOverlayIfPresent(in: app)
    assertFitsHorizontally(element("agent.detail.research-agent", in: app), in: app)

    selectTab("tab.settings", in: app)
    assertFitsHorizontally(scrollToElement("settings.disconnect", in: app), in: app)
  }

  func testReduceMotionStreamingUsesStateNotAnimationTiming() {
    let app = launch(scenario: "streaming-reconnect", reduceMotion: true)
    openFirstConversation(in: app)
    replaceText(
      in: element("chat.composer", in: app),
      with: "Stream without motion",
      clearExisting: false
    )
    let send = element("chat.send", in: app)
    waitUntilEnabled(send)
    send.tap()

    XCTAssertTrue(app.staticTexts["Reconnecting"].waitForExistence(timeout: 5))
    XCTAssertEqual(
      element("chat.final.response", in: app, timeout: 8).label, "Recovered exactly once.")
  }

  func testSemanticLabelsAndCompletedResponseExposure() {
    let app = launch(scenario: "streaming-reconnect")
    openFirstConversation(in: app)
    replaceText(
      in: element("chat.composer", in: app),
      with: "Inspect semantics",
      clearExisting: false
    )
    let send = element("chat.send", in: app)
    waitUntilEnabled(send)
    send.tap()

    let message = element("chat.message.assistant-ui-turn", in: app)
    XCTAssertEqual(message.label, "Assistant message, streaming")
    XCTAssertFalse(app.descendants(matching: .any)["chat.final.response"].exists)
    XCTAssertTrue(element("chat.question.ui-question", in: app).buttons["Ship it"].isEnabled)
    XCTAssertEqual(element("chat.tool.ui-tool", in: app).label, "Tool search, Tool succeeded")
    XCTAssertEqual(
      element("chat.worker.ui-worker", in: app).label, "Worker researcher, Worker running")

    let final = element("chat.final.response", in: app, timeout: 8)
    XCTAssertEqual(final.label, "Recovered exactly once.")
    XCTAssertEqual(message.label, "Assistant message, completed")
    XCTAssertTrue(app.staticTexts["Response completed"].exists)
  }
}
