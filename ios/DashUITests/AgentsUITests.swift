import XCTest

@MainActor
final class AgentsUITests: DashUITestCase {
  func testCreateAndEditAgent() {
    let app = launch(scenario: "agents")
    revealSidebarIfNeeded(toExpose: "conversation.list", in: app)
    selectTab("tab.agents", in: app)
    revealSidebarIfNeeded(toExpose: "agent.create", in: app)
    element("agent.create", in: app).tap()
    dismissSplitOverlayIfPresent(in: app)

    replaceText(
      in: element("agent.editor.name", in: app),
      with: "Release Captain",
      clearExisting: false
    )
    replaceText(
      in: element("agent.editor.model", in: app),
      with: "openai/gpt-5",
      clearExisting: false
    )
    let prompt = revealPromptForTextEntry(in: app)
    replaceText(
      in: prompt,
      with: "Coordinate releases",
      clearExisting: false
    )
    element("agent.editor.save", in: app).tap()
    let postCreateDestination =
      app.windows.firstMatch.frame.width >= 700
      ? "agent.detail.release-captain"
      : "agent.row.release-captain"
    XCTAssertTrue(element(postCreateDestination, in: app).waitForExistence(timeout: 5))

    revealSidebarIfNeeded(toExpose: "agent.row.release-captain", in: app)
    element("agent.row.release-captain", in: app).tap()
    dismissSplitOverlayIfPresent(in: app)
    let edit = app.buttons.matching(identifier: "agent.edit").firstMatch
    XCTAssertTrue(edit.waitForExistence(timeout: 5))
    edit.tap()
    replaceText(
      in: revealPromptForTextEntry(in: app),
      with: "Coordinate releases and write summaries"
    )
    element("agent.editor.save", in: app).tap()

    XCTAssertTrue(edit.waitForExistence(timeout: 5))
    edit.tap()
    let savedPrompt = element("agent.editor.prompt", in: app)
    XCTAssertEqual(savedPrompt.value as? String, "Coordinate releases and write summaries")
  }

  private func revealPromptForTextEntry(in app: XCUIApplication) -> XCUIElement {
    let prompt = element("agent.editor.prompt", in: app)
    let tabBar = app.tabBars.firstMatch
    for _ in 0..<4 {
      let intendedTapY = prompt.frame.midY
      if prompt.isHittable, tabBar.exists == false || intendedTapY < tabBar.frame.minY {
        return prompt
      }
      app.swipeUp()
    }

    XCTAssertTrue(
      prompt.isHittable && (tabBar.exists == false || prompt.frame.midY < tabBar.frame.minY),
      "Expected the system prompt field's tap target to be above the tab bar"
    )
    return prompt
  }

  func testEnableFailureRollsBackAndDisableRequiresConfirmation() {
    let app = launch(scenario: "agents")
    openAgent("sleeping-agent", in: app)
    let sleepingActions = app.buttons.matching(identifier: "agent.actions").firstMatch
    XCTAssertTrue(sleepingActions.waitForExistence(timeout: 5))
    sleepingActions.tap()
    app.buttons["Enable"].tap()
    let failureAlert = app.alerts["Agent update failed"]
    XCTAssertTrue(failureAlert.waitForExistence(timeout: 5))
    let ok = failureAlert.buttons["OK"]
    XCTAssertTrue(waitUntilHittable(ok, timeout: 3))
    ok.tap()
    XCTAssertFalse(failureAlert.waitForExistence(timeout: 2))
    XCTAssertTrue(app.staticTexts["Status, Disabled"].waitForExistence(timeout: 3))

    openAgent("research-agent", in: app)
    let researchActions = app.buttons.matching(identifier: "agent.actions").firstMatch
    XCTAssertTrue(researchActions.waitForExistence(timeout: 5))
    researchActions.tap()
    app.buttons["Disable"].tap()
    let confirmation = confirmationDialog(titled: "Disable Research Agent?", in: app)
    confirmation.buttons["Disable"].tap()
    XCTAssertTrue(app.staticTexts["Status, Disabled"].waitForExistence(timeout: 5))
  }

  func testDeleteRequiresExactName() {
    let app = launch(scenario: "agents")
    openAgent("delete-agent", in: app)
    let actions = app.buttons.matching(identifier: "agent.actions").firstMatch
    XCTAssertTrue(actions.waitForExistence(timeout: 5))
    actions.tap()
    app.buttons["Delete"].tap()

    let alert = app.alerts["Delete Delete Me?"]
    XCTAssertTrue(alert.waitForExistence(timeout: 3))
    replaceText(in: alert.textFields["Type the agent name"], with: "wrong")
    XCTAssertFalse(alert.buttons["Delete"].isEnabled)
    alert.buttons["Cancel"].tap()
    XCTAssertFalse(alert.waitForExistence(timeout: 2))

    actions.tap()
    app.buttons["Delete"].tap()
    XCTAssertTrue(alert.waitForExistence(timeout: 3))
    replaceText(
      in: alert.textFields["Type the agent name"],
      with: "Delete Me",
      clearExisting: false
    )
    XCTAssertTrue(alert.buttons["Delete"].isEnabled)
    alert.buttons["Delete"].tap()
    XCTAssertFalse(
      app.descendants(matching: .any)["agent.row.delete-agent"].waitForExistence(timeout: 2))
  }

  func testStartChatOpensConversation() {
    let app = launch(scenario: "agents")
    openAgent("research-agent", in: app)
    element("agent.startChat", in: app).tap()

    XCTAssertTrue(element("chat.transcript", in: app).waitForExistence(timeout: 5))
    revealSidebarIfNeeded(toExpose: "tab.conversations", in: app)
    waitUntilSelected(tab("tab.conversations", in: app))
  }

  func testIPadSplitNavigation() throws {
    let app = launch(scenario: "agents")
    try XCTSkipUnless(app.windows.firstMatch.frame.width >= 700, "Split navigation is iPad-only")

    selectTab("tab.agents", in: app)
    revealSidebarIfNeeded(toExpose: "agent.row.research-agent", in: app)
    element("agent.row.research-agent", in: app).tap()
    XCTAssertTrue(element("agent.detail.research-agent", in: app).exists)
    revealSidebarIfNeeded(toExpose: "agent.list", in: app)
    XCTAssertTrue(element("agent.list", in: app).exists)
    waitUntilSelected(element("agent.row.research-agent", in: app))
  }
}
