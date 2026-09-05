import XCTest

@MainActor
final class IPadUITests: DashUITestCase {
  /// Design §1.1: at regular width the sidebar is the conversation list and
  /// the detail is the chat — both visible at once, no tab bar column.
  func testTwoColumnLayoutShowsConversationsBesideTheChat() throws {
    let app = launch(scenario: "paired-online")
    try XCTSkipUnless(app.windows.firstMatch.frame.width >= 700, "iPad-only")

    XCTAssertTrue(element("conversation.list", in: app).waitForExistence(timeout: 5))
    XCTAssertTrue(element("tab.agents", in: app).exists, "Agents lives in the sidebar footer")
    XCTAssertTrue(element("tab.settings", in: app).exists, "Settings lives in the sidebar footer")
    XCTAssertTrue(element("detail.newConversation", in: app).exists, "empty detail is actionable")

    element("conversation.row.shared-plan", in: app).tap()
    XCTAssertTrue(element("chat.transcript", in: app).waitForExistence(timeout: 5))
    XCTAssertTrue(element("conversation.list", in: app).exists, "sidebar stays beside the chat")
    XCTAssertFalse(app.descendants(matching: .any)["detail.newConversation"].exists)
  }

  func testAgentsPushIntoTheSidebarAndSettingsPresentAsASheet() throws {
    let app = launch(scenario: "paired-online")
    try XCTSkipUnless(app.windows.firstMatch.frame.width >= 700, "iPad-only")

    selectTab("tab.agents", in: app)
    XCTAssertTrue(element("agent.list", in: app).exists)
    element("agent.row.research-agent", in: app).tap()
    XCTAssertTrue(element("agent.detail.research-agent", in: app).waitForExistence(timeout: 5))

    selectTab("tab.conversations", in: app)
    XCTAssertTrue(element("conversation.list", in: app).exists)

    selectTab("tab.settings", in: app)
    XCTAssertTrue(element("settings.list", in: app).exists)
  }

  /// iPad goal Phase A, Task 4: rotating the device (or resizing a Split
  /// View) flips the horizontal size class, re-hosting `ChatView` — the
  /// open conversation must stay open and selected through that, not get
  /// silently dropped back to an empty detail column.
  func testRotationKeepsTheOpenConversation() throws {
    let app = launch(scenario: "paired-online")
    try XCTSkipUnless(app.windows.firstMatch.frame.width >= 700, "iPad-only")
    element("conversation.row.shared-plan", in: app).tap()
    XCTAssertTrue(element("chat.transcript", in: app).waitForExistence(timeout: 5))

    XCUIDevice.shared.orientation = .landscapeLeft
    addTeardownBlock { XCUIDevice.shared.orientation = .portrait }

    XCTAssertTrue(element("chat.transcript", in: app).waitForExistence(timeout: 5))
    waitUntilSelected(element("conversation.row.shared-plan", in: app))
  }
}
