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

  /// The only end-to-end check that `.scrollPosition(id:)` genuinely TRACKS
  /// real message ids (Task 4 review fix, Important 1 + 3). SwiftUI only
  /// writes the topmost visible id back into the binding for touch-driven
  /// scrolling, so no unit test can reach it; this swipes for real and reads
  /// the DEBUG `chat.scrollAnchor` probe. Asserting the probe begins with
  /// `filler-` is asserting the tracked value is a genuine
  /// `ChatMessageState.id` rather than `"none"` — which is all the
  /// OUTER-stack `.scrollTargetLayout()` placement ever produced (verified:
  /// reverting the placement fails this test with `got "none"`).
  ///
  /// Uses the `long-transcript` scenario because `paired-online`'s
  /// two-message fixture cannot overflow the viewport, so there is nothing to
  /// scroll away from — the reason the rotation test above was green before
  /// any implementation existed.
  ///
  /// Scope honesty: the post-rotation assertion is a no-jump integration
  /// guard, NOT proof of the restore branch. A full-screen iPad rotation does
  /// not re-host `ChatView` (measured: forcing `decide` to always return
  /// `.bottom` still passes this test), so SwiftUI preserves the offset
  /// natively here. A genuine re-host needs a horizontal size-class flip
  /// (Split View / Stage Manager), which XCUITest cannot drive. The restore
  /// decision itself is covered by `ChatScrollRestorationTests`' table and by
  /// `TranscriptScrollTargetTests`.
  func testScrollingAwayFromTheBottomSurvivesRotation() throws {
    let app = launch(scenario: "long-transcript")
    try XCTSkipUnless(app.windows.firstMatch.frame.width >= 700, "iPad-only")
    openFirstConversation(in: app)

    let transcript = element("chat.transcript", in: app)
    transcript.swipeDown()
    transcript.swipeDown()
    transcript.swipeDown()

    let anchored = waitForTrackedScrollAnchor(prefix: "filler-", in: app)
    let anchoredRow = app.descendants(matching: .any)["chat.message.\(anchored)"]
    XCTAssertTrue(anchoredRow.waitForExistence(timeout: 5))

    XCUIDevice.shared.orientation = .landscapeLeft
    addTeardownBlock { XCUIDevice.shared.orientation = .portrait }

    XCTAssertTrue(element("chat.transcript", in: app).waitForExistence(timeout: 5))
    XCTAssertTrue(
      waitUntilHittable(anchoredRow, timeout: 8),
      """
      Expected the message the user was reading (\(anchored)) to still be on \
      screen after rotating — a jump back to the newest message is the exact \
      regression spec §1.3 forbids.
      """
    )
  }

  /// iPad goal Phase B, Task 7 (design §2.3): dragging a transcript image
  /// onto the composer attaches it via the same `addSelections` path the
  /// photo picker/camera/Files importer use. The drag SOURCE
  /// (`chat.message.image.<index>` + `.draggable`) and the drop-target
  /// identifier (`chat.attachment.<index>`) both land in Task 8 — until
  /// then this skips for lack of a fixture image to drag, per the Task 7/8
  /// ordering ruling. `DroppedImageTests` and the `.dropDestination`
  /// wiring in `ChatView` are exercised (and green) independently of this
  /// test.
  func testDroppingAnImageAttachesIt() throws {
    let app = launch(scenario: "paired-online")
    try XCTSkipUnless(app.windows.firstMatch.frame.width >= 700, "iPad-only")
    element("conversation.row.shared-plan", in: app).tap()
    let image = app.images.matching(NSPredicate(format: "identifier BEGINSWITH 'chat.message.image.'")).firstMatch
    try XCTSkipUnless(image.waitForExistence(timeout: 5), "fixture has no image to drag")
    let composer = element("chat.composer", in: app)
    image.press(forDuration: 1.0, thenDragTo: composer)
    XCTAssertTrue(app.descendants(matching: .any)["chat.attachment.0"].waitForExistence(timeout: 5))
  }
}
