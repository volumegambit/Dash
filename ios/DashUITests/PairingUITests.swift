import XCTest

@MainActor
final class PairingUITests: DashUITestCase {
  func testCameraDenialKeepsPairingAlternativesAvailable() {
    XCUIApplication().resetAuthorizationStatus(for: .camera)
    let app = launch(scenario: "unpaired")

    var deniedSystemCameraAlert = false
    addUIInterruptionMonitor(withDescription: "Camera permission") { alert in
      for label in ["Don’t Allow", "Don't Allow"] {
        let button = alert.buttons[label]
        if button.exists {
          deniedSystemCameraAlert = true
          button.tap()
          return true
        }
      }
      return false
    }

    element("pairing.scan", in: app).tap()
    app.tap()

    let paste = element("pairing.paste", in: app)
    let manual = element("pairing.manual", in: app)
    XCTAssertTrue(
      app.staticTexts[
        "Camera access is unavailable. Paste the code or enter the connection manually."
      ].waitForExistence(timeout: 5)
    )
    XCTAssertTrue(paste.isHittable)
    XCTAssertTrue(manual.isHittable)
    XCTAssertEqual(paste.label, "Paste Pairing Code")
    XCTAssertEqual(manual.label, "Enter Manually")
    XCTAssertTrue(deniedSystemCameraAlert, "Expected the iOS camera permission alert")
  }

  func testManualLANPairingValidatesAndOpensConversations() {
    let app = launch(scenario: "unpaired")
    element("pairing.manual", in: app).tap()

    replaceText(
      in: field(withPlaceholder: "gateway.local", from: app.textFields),
      with: "192.168.1.50",
      clearExisting: false
    )
    replaceText(
      in: field(withPlaceholder: "9400", from: app.textFields),
      with: "9400",
      clearExisting: false
    )
    replaceText(
      in: field(withPlaceholder: "Mobile token", from: app.secureTextFields),
      with: "mobile-test-token",
      clearExisting: false
    )
    replaceText(
      in: field(withPlaceholder: "Certificate SHA-256", from: app.secureTextFields),
      with: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      clearExisting: false
    )
    app.collectionViews.buttons["Connect"].tap()

    selectTab("tab.conversations", in: app)
    revealSidebarIfNeeded(toExpose: "tab.conversations", in: app)
    waitUntilSelected(tab("tab.conversations", in: app))
    revealSidebarIfNeeded(toExpose: "conversation.list", in: app)
    XCTAssertTrue(element("conversation.list", in: app).exists)
  }

  func testPasteAcceptsCanonicalLANAndRelayFixtures() {
    let fixtures = ["canonical-lan", "canonical-relay"]

    for fixture in fixtures {
      let app = launch(scenario: "unpaired", pasteboardFixture: fixture)
      element("pairing.paste", in: app).tap()
      selectTab("tab.conversations", in: app)
      revealSidebarIfNeeded(toExpose: "tab.conversations", in: app)
      waitUntilSelected(tab("tab.conversations", in: app))
      revealSidebarIfNeeded(toExpose: "conversation.list", in: app)
      XCTAssertTrue(element("conversation.list", in: app).exists)
      app.terminate()
    }
  }

  func testPasteRejectsMalformedSchemePathAndPort() {
    let malformed = ["malformed-scheme", "malformed-path", "malformed-port"]

    for value in malformed {
      let app = launch(scenario: "unpaired", pasteboardFixture: value)
      element("pairing.paste", in: app).tap()
      XCTAssertTrue(app.staticTexts["Invalid connection details"].waitForExistence(timeout: 5))
      XCTAssertTrue(element("pairing.manual", in: app).isHittable)
      app.terminate()
    }
  }

  private func field(withPlaceholder placeholder: String, from query: XCUIElementQuery)
    -> XCUIElement
  {
    query.matching(NSPredicate(format: "placeholderValue == %@", placeholder)).firstMatch
  }
}
