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

  /// iPad goal Phase B, Task 7 (design §2.3) + Task 8: dragging a
  /// transcript image onto the composer attaches it via the same
  /// `addSelections` path the photo picker/camera/Files importer use. The
  /// drag SOURCE (`chat.message.image.<index>` + `.draggable`) and the
  /// drop-target identifier (`chat.attachment.<index>`) both landed in
  /// Task 8, and the `paired-online`/`shared-plan` fixture's cached
  /// `cached-user` message already carries a decodable 1x1 PNG (audit #19),
  /// so this genuinely drags a real image rather than skipping.
  ///
  /// The source query is the type-agnostic `app.descendants(matching:
  /// .any)` (Task 8 handoff concern #1 from the Task 7 report), not
  /// `app.images`: `MessageImageView`'s identifier sits on the `Button`
  /// (never moved onto the inner `Image`, since a SwiftUI `Button` always
  /// vends ONE `.button`-trait accessibility element for its label, so
  /// `app.images` would never match it regardless of where the identifier
  /// modifier sits). This mirrors the target-side `chat.attachment.0`
  /// assertion below, which already used `app.descendants(matching: .any)`.
  func testDroppingAnImageAttachesIt() throws {
    let app = launch(scenario: "paired-online")
    try XCTSkipUnless(app.windows.firstMatch.frame.width >= 700, "iPad-only")
    element("conversation.row.shared-plan", in: app).tap()
    let image = app.descendants(matching: .any)
      .matching(NSPredicate(format: "identifier BEGINSWITH 'chat.message.image.'")).firstMatch
    XCTAssertTrue(
      image.waitForExistence(timeout: 5),
      "Expected the shared-plan fixture's cached image message to render a draggable thumbnail"
    )
    let composer = element("chat.composer", in: app)
    image.press(forDuration: 1.0, thenDragTo: composer)
    XCTAssertTrue(app.descendants(matching: .any)["chat.attachment.0"].waitForExistence(timeout: 5))
  }

  /// iPad goal Phase C (design §3.2): "Open in New Window" puts the same
  /// conversation into its OWN scene, sharing the single `AppModel`
  /// `AppLaunch` composed, so both windows are looking at one `ChatFeature`.
  ///
  /// The window count is asserted as a DIFFERENTIAL against the count taken
  /// before the tap, not just as `>= 2`: an app hosting a single scene can
  /// already report two or more `windows` (UIKit's own
  /// `UITextEffectsWindow` appears once the `.searchable` field exists), so
  /// a bare `>= 2` could pass without any second scene ever opening. The
  /// brief's `>= 2` is kept alongside it rather than replaced.
  func testOpenInNewWindowShowsASecondTranscript() throws {
    let app = launch(scenario: "paired-online")
    try XCTSkipUnless(app.windows.firstMatch.frame.width >= 700, "iPad-only")
    XCTAssertTrue(element("conversation.list", in: app).waitForExistence(timeout: 5))
    let baselineWindows = app.windows.count

    element("conversation.row.shared-plan", in: app).press(forDuration: 1.0)
    let open = app.buttons["Open in New Window"].firstMatch
    XCTAssertTrue(open.waitForExistence(timeout: 3))
    open.tap()
    // `terminate()` alone does NOT close every scene: measured on iPad 26.5,
    // the conversation scene's SESSION survives it, and the next launch
    // comes up with the chat-only window frontmost, the main window demoted
    // to "1 Hidden Window", and an EMPTY accessibility hierarchy for ~8s —
    // which failed the two `IPadUITests` cases that happened to run next.
    // `ConversationWindowSceneGuard` closes that restored window (and with
    // it the session), but only from INSIDE the relaunched process, so one
    // launch is still spent recovering. This teardown spends that launch
    // here, in the test that created the state, instead of handing it to
    // whichever test runs next.
    addTeardownBlock {
      app.terminate()
      app.launch()
      // Review fix round 1 (Important 3): without this wait, whether the
      // restored window was dismissed before this teardown's own
      // `terminate()` fires is a race — and losing it hands the next test
      // the exact poisoned session this teardown exists to prevent, just
      // disguised as an unrelated failure. The main window's sidebar
      // existing IS the evidence that the restored scene is already gone.
      _ = self.element("conversation.list", in: app).waitForExistence(timeout: 10)
      app.terminate()
    }

    let transcripts = app.descendants(matching: .any).matching(identifier: "chat.transcript")
    let expectation = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "count >= 1"), object: transcripts)
    XCTAssertEqual(XCTWaiter.wait(for: [expectation], timeout: 8), .completed)
    XCTAssertGreaterThanOrEqual(app.windows.count, 2, "a second scene should exist")
    XCTAssertGreaterThan(
      app.windows.count,
      baselineWindows,
      """
      Expected opening a conversation window to ADD a window on top of the \
      \(baselineWindows) the single-scene app already reported — a count that \
      merely happens to be >= 2 proves nothing.
      """
    )

    // The transcript is in the OTHER window, not this one: the main window's
    // sidebar AND its empty-detail "New conversation" button are both still
    // on screen, which is only possible if the main window never navigated.
    // (Measured on iPad 26.5: `windows.count` goes 1 -> 5 across the tap,
    // one transcript, `conversation.list` and `detail.newConversation` both
    // still present.)
    XCTAssertTrue(
      app.descendants(matching: .any)["conversation.list"].exists,
      "the main window's sidebar should still be up"
    )
    XCTAssertTrue(
      app.descendants(matching: .any)["detail.newConversation"].exists,
      """
      The main window's detail should still be EMPTY — if the transcript had \
      opened in this window instead of a new one, this button would be gone.
      """
    )
  }
}
