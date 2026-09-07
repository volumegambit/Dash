import XCTest

@MainActor
final class AccessibilityUITests: DashUITestCase {
  func testCoreFlowsInCurrentAppearance() {
    let app = launch(scenario: "paired-online")

    selectTab("tab.conversations", in: app)
    revealSidebarIfNeeded(toExpose: "conversation.row.shared-plan", in: app)
    let conversation = element("conversation.row.shared-plan", in: app)
    XCTAssertTrue(conversation.isHittable)
    conversation.tap()
    dismissSplitOverlayIfPresent(in: app)
    XCTAssertTrue(element("chat.composer", in: app).isHittable)

    selectTab("tab.agents", in: app)
    revealSidebarIfNeeded(toExpose: "agent.row.research-agent", in: app)
    let agent = element("agent.row.research-agent", in: app)
    XCTAssertTrue(agent.isHittable)
    agent.tap()
    dismissSplitOverlayIfPresent(in: app)
    XCTAssertTrue(element("agent.startChat", in: app).isHittable)

    selectTab("tab.settings", in: app)
    XCTAssertTrue(scrollSettingsToElement("settings.disconnect", in: app).isHittable)
  }

  func testSettingsForgetReturnsToConnectAndRemovesCachedRows() {
    let app = launch(scenario: "settings-forget")
    selectTab("tab.settings", in: app)
    element("settings.disconnect", in: app).tap()
    let confirmation = confirmationDialog(titled: "Disconnect & Forget?", in: app)
    confirmation.buttons["Disconnect & Forget"].tap()

    XCTAssertTrue(element("account.picker", in: app).waitForExistence(timeout: 5))
    XCTAssertFalse(app.descendants(matching: .any)["conversation.row.shared-plan"].exists)
    XCTAssertFalse(app.descendants(matching: .any)["agent.row.research-agent"].exists)
  }

  func testAccessibilityXXXL() {
    var app = launch(scenario: "unpaired", contentSize: Self.accessibilityXXXL)
    assertFitsHorizontally(element("account.signin", in: app), in: app)
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
    assertFitsHorizontally(scrollSettingsToElement("settings.disconnect", in: app), in: app)
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
    // 20s, not the helper's default 8: these cards only exist once the
    // scripted stream has delivered them, and a contended CI runner can take
    // longer than the default to get there (passes locally on the same iPad).
    XCTAssertTrue(
      element("chat.question.ui-question", in: app, timeout: 20).buttons["Ship it"].isEnabled)
    XCTAssertEqual(
      element("chat.tool.ui-tool", in: app, timeout: 20).label, "Tool Search, Tool succeeded")
    XCTAssertEqual(
      element("chat.worker.ui-worker", in: app, timeout: 20).label,
      "Worker researcher, Worker running")

    let final = element("chat.final.response", in: app, timeout: 8)
    XCTAssertEqual(final.label, "Recovered exactly once.")
    XCTAssertEqual(message.label, "Assistant message, completed")
    // Chrome trim (chat-ux Phase 2, audit #17): `TerminalView` no longer
    // renders for a successful turn — "silence on success" — so there's no
    // "Response completed" row to find here anymore. The message's own
    // accessibility label above already conveys the completed state.
    XCTAssertFalse(app.staticTexts["Response completed"].exists)
  }

  private func scrollSettingsToElement(
    _ identifier: String,
    in app: XCUIApplication,
    maxSwipes: Int = 6,
    file: StaticString = #filePath,
    line: UInt = #line
  ) -> XCUIElement {
    let settingsList = element("settings.list", in: app, file: file, line: line)
    let window = app.windows.firstMatch
    XCTAssertTrue(
      window.waitForExistence(timeout: 2),
      "Expected the app window before scrolling settings",
      file: file,
      line: line
    )
    let value = app.descendants(matching: .any)[identifier]

    func isExposed() -> Bool {
      guard value.exists, value.isHittable else { return false }
      return value.frame.intersects(settingsList.frame) && value.frame.intersects(window.frame)
    }

    for _ in 0..<maxSwipes where isExposed() == false {
      settingsList.swipeUp()
    }
    XCTAssertTrue(
      isExposed(),
      "Expected \(identifier) to be exposed and hittable after \(maxSwipes) settings-list swipes",
      file: file,
      line: line
    )
    return value
  }
}
