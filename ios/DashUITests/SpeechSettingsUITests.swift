import XCTest

/// Settings › Speech (Task A10). Black-box, like the rest of this target — no
/// `@testable import Dash`, so every string below is written out verbatim
/// against `SpeechSettingsView`/`SettingsView`.
///
/// The scenarios do the gating: only `paired-online` advertises `speech-v1`
/// (see `UITestScenario.capabilities`), so `paired-offline` is what a gateway
/// without a speech provider looks like.
@MainActor
final class SpeechSettingsUITests: DashUITestCase {
  private static let unavailableCopy = "Update your gateway to use speech."

  func testSpeechRowIsOfferedWhenTheGatewayAdvertisesSpeech() {
    let app = launch(scenario: "paired-online")
    selectTab("tab.settings", in: app)

    let row = scrollSettingsToElement("settings.speech", in: app)
    XCTAssertTrue(row.isHittable)
    XCTAssertTrue(waitForNoElement("settings.speech.unavailable", in: app, timeout: 2))
  }

  func testWithoutTheCapabilityTheRowIsReplacedByTheUpdateFooter() {
    let app = launch(scenario: "paired-offline")
    selectTab("tab.settings", in: app)

    let footer = scrollSettingsToElement("settings.speech.unavailable", in: app)
    XCTAssertEqual(footer.label, Self.unavailableCopy)
    XCTAssertTrue(waitForNoElement("settings.speech", in: app, timeout: 2))
  }

  func testSpeechScreenShowsTheModelVoiceLanguageAndPreviewControls() {
    let app = launch(scenario: "paired-online")
    selectTab("tab.settings", in: app)
    scrollSettingsToElement("settings.speech", in: app).tap()

    _ = element("settings.speech.list", in: app)
    XCTAssertTrue(element("settings.speech.sttModel", in: app).exists)
    XCTAssertTrue(element("settings.speech.ttsModel", in: app).exists)
    XCTAssertTrue(element("settings.speech.voice", in: app).exists)
    XCTAssertTrue(element("settings.speech.preview", in: app).exists)
    XCTAssertTrue(element("settings.speech.language", in: app).exists)
    // Realtime is shown rather than hidden, carrying the gateway's own
    // reason. Asserted on the LABEL, not on `isEnabled`: the row is
    // `.disabled(true)` but it is a `LabeledContent`, and SwiftUI publishes
    // the not-enabled trait for controls only — measured on iOS 26.5, where
    // a disabled `LabeledContent` still reports `isEnabled == true`.
    let realtime = element("settings.speech.realtime", in: app)
    XCTAssertTrue(
      realtime.label.contains("No configured provider offers realtime speech yet."),
      "Expected the realtime reason. Label: \(realtime.label)"
    )
  }
}
