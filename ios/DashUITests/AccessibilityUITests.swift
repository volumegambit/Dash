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
    // Settings is a sheet on the iPad two-column layout (design §1.1), a much
    // shorter viewport than the old full-height column: `settings.disconnect`
    // sits below its fold and is absent from the hierarchy until scrolled to.
    scrollSettingsToElement("settings.disconnect", in: app).tap()
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
    // The sidebar is checked on the rendered TEXT of a conversation row rather
    // than on `conversation.list`'s frame. `NavigationSplitView` overhangs the
    // sidebar column's host view -- and every cell, row button and section
    // header inside it -- 100 pt past the window's leading edge on iPadOS 18.4,
    // with a compensating safe-area inset, so all of those frames measure the
    // system's column geometry instead of this app's layout. The row's labels
    // are the sidebar content a user actually reads and the thing Dynamic Type
    // grows, so they are what a clip at XXXL would show up in. See
    // `assertTextFitsHorizontally`.
    assertTextFitsHorizontally(element("conversation.row.shared-plan", in: app), in: app)
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
    // Task D5: the sub-agent row's disclosure is state, not animation timing —
    // it must open under reduce-motion exactly as it does without it
    // (§8.6). `withAnimation(reduceMotion ? nil : .snappy)` is the mechanism;
    // this is the assertion that it did not become "animate or nothing".
    element("chat.subagent.ui-subagent.header", in: app).tap()
    XCTAssertTrue(element("chat.subagent.ui-subagent.tool.ui-tool", in: app).exists)
    XCTAssertEqual(
      element("chat.subagent.ui-subagent", in: app).label, "Agent researcher, Running")

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
    XCTAssertEqual(element("chat.tool.ui-tool", in: app).label, "Tool Search, Tool succeeded")
    // Renamed in task D4 with the sub-agent row: `chat.worker.<runId+workerId>`
    // → `chat.subagent.<subagentId>` (sub-agents design §8.6). The scenario
    // emits both event families for one child, and this is the canonical
    // family's type and status.
    XCTAssertEqual(
      element("chat.subagent.ui-subagent", in: app).label, "Agent researcher, Running")

    let final = element("chat.final.response", in: app, timeout: 8)
    XCTAssertEqual(final.label, "Recovered exactly once.")
    XCTAssertEqual(message.label, "Assistant message, completed")
    // Chrome trim (chat-ux Phase 2, audit #17): `TerminalView` no longer
    // renders for a successful turn — "silence on success" — so there's no
    // "Response completed" row to find here anymore. The message's own
    // accessibility label above already conveys the completed state.
    XCTAssertFalse(app.staticTexts["Response completed"].exists)
  }
}
