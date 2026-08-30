import XCTest

/// Exercises the account sign-in flow that fronts every unpaired launch:
/// `SignInView` -> `GatewayPickerView` (loaded / error / connect-failure
/// states). Mirrors `AccessibilityUITests`' black-box style — no `@testable
/// import Dash` in this target, so copy strings below are hardcoded verbatim
/// against `AccountCopy` (see `GatewayPickerView.swift`) rather than
/// referenced directly.
@MainActor
final class AccountUITests: DashUITestCase {
  private static let cpUnreachableCopy =
    "Couldn't reach your Dash account service. Check your connection and try again."
  private static let notEnrolledCopy =
    "This gateway needs to be re-enrolled from Mission Control before app access works."

  func testSignedOutShowsSignIn() {
    let app = launch(scenario: "signed-out")
    XCTAssertTrue(element("account.signin", in: app).isHittable)
  }

  func testAccountPickerListsGatewayAndConnectsThroughToConversations() {
    let app = launch(scenario: "account-picker")

    let gatewayRow = element("account.gateway.ui-picker-gateway", in: app)
    XCTAssertTrue(gatewayRow.isHittable)
    gatewayRow.tap()

    selectTab("tab.conversations", in: app)
    revealSidebarIfNeeded(toExpose: "conversation.row.shared-plan", in: app)
    XCTAssertTrue(element("conversation.row.shared-plan", in: app).isHittable)
  }

  func testAccountPickerErrorShowsUnreachableCopyAndRetry() {
    let app = launch(scenario: "account-picker-error")

    XCTAssertTrue(app.staticTexts[Self.cpUnreachableCopy].waitForExistence(timeout: 5))
    XCTAssertTrue(element("account.retry", in: app).isHittable)
    // T6 review gap #3: `account.picker`'s identifier sits on the whole
    // `content` switch, not per-state — confirm it's still queryable while
    // showing `.error`, not just the initial `.loading` frame.
    XCTAssertTrue(app.descendants(matching: .any)["account.picker"].exists)
  }

  func testAccountNotEnrolledShowsExactCopyInConnectAlert() {
    let app = launch(scenario: "account-not-enrolled")

    let gatewayRow = element("account.gateway.ui-not-enrolled-gateway", in: app)
    XCTAssertTrue(gatewayRow.isHittable)
    gatewayRow.tap()

    let alert = confirmationDialog(titled: "Couldn't connect", in: app)
    XCTAssertTrue(alert.staticTexts[Self.notEnrolledCopy].waitForExistence(timeout: 5))
    alert.buttons["OK"].tap()

    // Dismissing the alert returns to the still-loaded picker, not a crash or
    // a stuck spinner.
    XCTAssertTrue(element("account.gateway.ui-not-enrolled-gateway", in: app).isHittable)
  }
}
