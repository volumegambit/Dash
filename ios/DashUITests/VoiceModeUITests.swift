import XCTest

/// Hands-free voice mode, end to end through the app's own views (speech
/// Phase B, Task B9).
///
/// The microphone, the speaker, the audio session and the gateway are all
/// substituted in `UITestScenarioSupport` — a simulator has no input route
/// and a UI test cannot answer the permission alert — so what these prove is
/// the half no unit test can: that the waveform is on screen only when the
/// gateway advertises `speech-v1`, that the cover actually presents, that
/// each state puts its own words and controls on screen, and that closing it
/// puts the chat back.
///
/// Every test that OPENS the cover launches with Reduce Motion on. That is
/// not a stylistic choice: the orb is a `TimelineView(.animation)`, and a
/// timeline asking for 30 frames a second is exactly what XCUITest's idle
/// wait was built to distrust. Reduce Motion pauses the timeline outright
/// (`VoiceOrbView`), so these tests exercise the same views with nothing
/// animating — and, by doing so, also assert the Reduce Motion path works.
@MainActor
final class VoiceModeUITests: DashUITestCase {
  // MARK: - The composer button

  func testVoiceModeIsOfferedOnAGatewayWithSpeech() {
    let app = openChat(scenario: "paired-online")

    let voice = element("chat.voice", in: app)
    XCTAssertTrue(voice.isEnabled)
    // Beside the other composer actions, not instead of them.
    XCTAssertTrue(element("chat.dictate", in: app).exists)
    XCTAssertTrue(element("chat.send", in: app).exists)
  }

  func testVoiceModeIsHiddenOnAGatewayWithoutSpeech() {
    let app = openChat(scenario: "paired-offline")

    // `paired-offline` advertises `conversation-sync-v1` and `chat-resume-v1`
    // only — the legacy gateway. A `voice_start` there is answered with
    // `voice_error { unavailable }`, so the button must not be there at all.
    XCTAssertFalse(
      app.descendants(matching: .any)["chat.voice"].waitForExistence(timeout: 2),
      "A gateway without speech-v1 must not offer voice mode. UI: \(app.debugDescription)"
    )
    XCTAssertTrue(element("chat.send", in: app).exists)
  }

  // MARK: - The five states

  func testListeningShowsTheUserCaption() {
    let app = openVoice(state: "listening")

    XCTAssertEqual(element("chat.voice.state", in: app).label, "Listening")
    XCTAssertTrue(
      element("chat.voice.captions", in: app).label.contains("weather"),
      "The partial transcript is what tells the user they were heard"
    )
    XCTAssertTrue(element("chat.voice.orb", in: app).exists)
    XCTAssertTrue(element("chat.voice.mute", in: app).isEnabled)
    XCTAssertTrue(element("chat.voice.close", in: app).isEnabled)
  }

  func testThinkingShowsTheThinkingState() {
    let app = openVoice(state: "thinking")

    XCTAssertEqual(element("chat.voice.state", in: app).label, "Thinking")
    XCTAssertTrue(element("chat.voice.captions", in: app).label.contains("weather"))
  }

  func testSpeakingShowsTheAssistantCaptionAndAnInterruptibleOrb() {
    let app = openVoice(state: "speaking")

    XCTAssertEqual(element("chat.voice.state", in: app).label, "Speaking")
    XCTAssertTrue(
      element("chat.voice.captions", in: app).label.contains("Singapore"),
      "What the assistant is saying has to be readable. UI: \(app.debugDescription)"
    )
    // The orb is the local interrupt affordance, and only while speaking.
    let orb = element("chat.voice.orb", in: app)
    XCTAssertTrue(orb.isEnabled)
    XCTAssertEqual(orb.label, "Interrupt the response")
  }

  func testMutedShowsTheMutedStateAndOffersUnmute() {
    let app = openVoice(state: "muted")

    XCTAssertEqual(element("chat.voice.state", in: app).label, "Muted")
    XCTAssertEqual(element("chat.voice.mute", in: app).label, "Unmute microphone")
    // Nothing to interrupt while muted.
    XCTAssertFalse(element("chat.voice.orb", in: app).isEnabled)
  }

  func testEndedShowsWhyItEnded() {
    let app = openVoice(state: "ended")

    XCTAssertEqual(element("chat.voice.state", in: app).label, "Voice mode ended")
    // The close button still works on an ended session — that is the only
    // action the reducer still honours.
    XCTAssertTrue(element("chat.voice.close", in: app).isEnabled)
  }

  // MARK: - Dismissal

  func testClosingTheCoverReturnsToTheConversation() {
    let app = openVoice(state: "listening")

    element("chat.voice.close", in: app).tap()

    XCTAssertTrue(
      element("chat.composer", in: app).waitForExistence(timeout: 8),
      "Closing voice mode puts the conversation back. UI: \(app.debugDescription)"
    )
    XCTAssertFalse(
      app.descendants(matching: .any)["chat.voice.state"].exists,
      "The cover must be gone, not merely behind the chat"
    )
  }

  // MARK: - Helpers

  private func openChat(scenario: String) -> XCUIApplication {
    let app = launch(scenario: scenario, conversationID: "shared-plan")
    dismissSplitOverlayIfPresent(in: app)
    _ = element("chat.transcript", in: app)
    let composer = element("chat.composer", in: app)
    XCTAssertTrue(
      waitUntilHittable(composer, timeout: 5),
      "Expected the composer to be actionable after opening the conversation"
    )
    return app
  }

  /// Launches straight into the cover in one state. `DASH_UI_TEST_VOICE`
  /// drives the real feature from canned frames; Reduce Motion pauses the
  /// orb's timeline so XCUITest sees an idle app.
  private func openVoice(state: String) -> XCUIApplication {
    let app = XCUIApplication()
    let dataIdentifier = UUID().uuidString
    app.launchEnvironment["DASH_UI_TEST_SCENARIO"] = "paired-online"
    app.launchEnvironment["DASH_UI_TEST_DATA_IDENTIFIER"] = dataIdentifier
    app.launchEnvironment["DASH_UI_TEST_CONVERSATION"] = "shared-plan"
    app.launchEnvironment["DASH_UI_TEST_VOICE"] = state
    app.launchArguments += [
      "-AppleLanguages",
      "(en)",
      "-AppleLocale",
      "en_US",
      "-UIAccessibilityReduceMotionEnabled",
      "YES",
      "--dash-ui-test-scenario",
      "paired-online",
      "--dash-ui-test-data-identifier",
      dataIdentifier,
      "--dash-ui-test-voice",
      state,
    ]
    app.launch()
    dismissSplitOverlayIfPresent(in: app)
    _ = element("chat.voice.state", in: app, timeout: 20)
    return app
  }
}
