import XCTest

/// Dictation in the composer, end to end through the app's own views
/// (speech Phase A, Task A8).
///
/// The microphone, the audio session and the gateway are all substituted in
/// `UITestScenarioSupport` — a simulator has no input route and a UI test
/// cannot answer the system permission alert — so what these prove is the
/// half no unit test can: that the mic is on screen only when the gateway
/// advertises `speech-v1`, that recording really replaces the text field,
/// and that finishing puts the transcript in the draft rather than sending
/// it.
@MainActor
final class DictationUITests: DashUITestCase {
  func testDictateIsOfferedOnAGatewayWithSpeech() {
    let app = openChat(scenario: "paired-online")

    let dictate = element("chat.dictate", in: app)
    XCTAssertTrue(dictate.isEnabled)
    XCTAssertTrue(element("chat.attachments", in: app).exists)
  }

  func testDictateIsHiddenOnAGatewayWithoutSpeech() {
    let app = openChat(scenario: "paired-offline")

    // `paired-offline` advertises `conversation-sync-v1` and `chat-resume-v1`
    // only — the legacy gateway. Offering a mic there would produce a 404 on
    // an endpoint that does not exist.
    XCTAssertFalse(
      app.descendants(matching: .any)["chat.dictate"].waitForExistence(timeout: 2),
      "A gateway without speech-v1 must not show a mic. UI: \(app.debugDescription)"
    )
    XCTAssertTrue(element("chat.attachments", in: app).exists)
  }

  func testRecordingReplacesTheFieldAndInsertsTheTranscript() {
    let app = openChat(scenario: "paired-online")

    element("chat.dictate", in: app).tap()

    // The bar takes the field's place: meter, countdown, and the only two
    // actions that end a recording.
    let finish = element("chat.dictation.finish", in: app)
    XCTAssertTrue(element("chat.dictation.countdown", in: app).exists)
    XCTAssertTrue(element("chat.dictation.cancel", in: app).exists)
    // The container AND its children: a plain `.accessibilityIdentifier` on a
    // SwiftUI container merges the children away, so naming the bar without
    // `.accessibilityElement(children: .contain)` silently costs every
    // control inside it its own identifier.
    XCTAssertTrue(element("chat.dictation.bar", in: app).exists)
    XCTAssertFalse(
      app.descendants(matching: .any)["chat.composer"].exists,
      "The text field must be replaced while recording, not sit beside the meter"
    )

    finish.tap()

    let composer = element("chat.composer", in: app)
    XCTAssertTrue(
      waitForComposerValue(composer, containing: "hello world"),
      "Expected the fake transcriber's text in the draft, got \(String(describing: composer.value))"
    )
    // Dictation types; it never sends.
    XCTAssertTrue(element("chat.send", in: app).exists)
  }

  func testCancellingADictationLeavesTheDraftAlone() {
    let app = openChat(scenario: "paired-online")
    let composer = element("chat.composer", in: app)
    replaceText(in: composer, with: "typed by hand")

    element("chat.dictate", in: app).tap()
    element("chat.dictation.cancel", in: app).tap()

    let restored = element("chat.composer", in: app)
    XCTAssertTrue(
      waitForComposerValue(restored, containing: "typed by hand"),
      "Cancelling must discard the audio and leave the draft untouched"
    )
    XCTAssertTrue(element("chat.dictate", in: app).exists)
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

  private func waitForComposerValue(
    _ field: XCUIElement,
    containing expected: String,
    timeout: TimeInterval = 5
  ) -> Bool {
    let expectation = XCTNSPredicateExpectation(
      predicate: NSPredicate { object, _ in
        guard let field = object as? XCUIElement else { return false }
        return (field.value as? String)?.contains(expected) == true
      },
      object: field
    )
    return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
  }
}
