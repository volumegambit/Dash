import XCTest

@MainActor
class DashUITestCase: XCTestCase {
  static let accessibilityXXXL = "UICTContentSizeCategoryAccessibilityXXXL"

  override func setUp() {
    super.setUp()
    continueAfterFailure = false
  }

  @discardableResult
  func launch(
    scenario: String,
    contentSize: String? = nil,
    reduceMotion: Bool = false
  ) -> XCUIApplication {
    let app = XCUIApplication()
    let dataIdentifier = UUID().uuidString
    app.launchEnvironment["DASH_UI_TEST_SCENARIO"] = scenario
    app.launchEnvironment["DASH_UI_TEST_DATA_IDENTIFIER"] = dataIdentifier
    app.launchArguments += [
      "-AppleLanguages",
      "(en)",
      "-AppleLocale",
      "en_US",
      "--dash-ui-test-scenario",
      scenario,
      "--dash-ui-test-data-identifier",
      dataIdentifier,
    ]
    if let contentSize {
      app.launchArguments += [
        "-UIPreferredContentSizeCategoryName",
        contentSize,
      ]
    }
    if reduceMotion {
      app.launchArguments += ["-UIAccessibilityReduceMotionEnabled", "YES"]
    }
    app.launch()
    return app
  }

  func element(
    _ identifier: String,
    in app: XCUIApplication,
    timeout: TimeInterval = 8,
    file: StaticString = #filePath,
    line: UInt = #line
  ) -> XCUIElement {
    let value = app.descendants(matching: .any)[identifier]
    XCTAssertTrue(
      value.waitForExistence(timeout: timeout),
      "Expected \(identifier) to exist. UI: \(app.debugDescription)",
      file: file,
      line: line
    )
    return value
  }

  func replaceText(
    in field: XCUIElement,
    with value: String,
    clearExisting: Bool = true,
    file: StaticString = #filePath,
    line: UInt = #line
  ) {
    let app = XCUIApplication()
    XCTAssertTrue(field.waitForExistence(timeout: 5), file: file, line: line)
    XCTAssertTrue(
      revealForTextEntry(field, in: app),
      "Expected \(field.identifier) to be visible for text entry",
      file: file,
      line: line
    )
    let initialValue = field.value as? String
    let initialText = initialValue == field.placeholderValue ? "" : (initialValue ?? "")
    let frame = field.frame
    let appFrame = app.windows.firstMatch.frame
    let center = CGPoint(x: frame.midX, y: frame.midY)
    if frame.isEmpty == false, appFrame.contains(center) {
      field.coordinate(withNormalizedOffset: CGVector(dx: 0.25, dy: 0.5)).tap()
    } else {
      field.tap()
    }
    if waitForTextEntryReadiness(in: field, app: app, timeout: 5) == false {
      field.tap()
      if field.elementType != .secureTextField {
        XCTAssertTrue(
          waitForTextEntryReadiness(in: field, app: app, timeout: 5),
          "Expected \(field.identifier) to receive keyboard focus",
          file: file,
          line: line
        )
      }
    }
    if clearExisting,
      let current = field.value as? String,
      current.isEmpty == false,
      current != field.placeholderValue
    {
      field.press(forDuration: 1.0)
      let selectAll = app.descendants(matching: .any).matching(
        NSPredicate(format: "label == %@", "Select All")
      ).firstMatch
      XCTAssertTrue(
        selectAll.waitForExistence(timeout: 3),
        "Expected the native Select All action for \(field.identifier)",
        file: file,
        line: line
      )
      selectAll.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
      field.typeText(XCUIKeyboardKey.delete.rawValue)
      XCTAssertTrue(
        waitForClearedTextValue(in: field, timeout: 5),
        "Expected \(field.identifier) to clear existing text before replacement",
        file: file,
        line: line
      )
    }
    field.typeText(value)

    let expectedValue = clearExisting ? value : initialText + value
    XCTAssertTrue(
      waitForTextValue(
        in: field,
        expected: expectedValue,
        changedFrom: initialValue,
        timeout: 5
      ),
      "Expected \(field.identifier) to receive typed text",
      file: file,
      line: line
    )
  }

  private func revealForTextEntry(
    _ field: XCUIElement,
    in app: XCUIApplication
  ) -> Bool {
    for _ in 0..<6 {
      if field.exists, field.isHittable { return true }
      let fieldFrame = field.frame
      let appFrame = app.windows.firstMatch.frame
      if fieldFrame.isEmpty == false, fieldFrame.maxY < appFrame.minY {
        app.swipeDown()
      } else {
        app.swipeUp()
      }
    }
    return waitUntilHittable(field, timeout: 2)
  }

  private func waitForTextEntryReadiness(
    in field: XCUIElement,
    app: XCUIApplication,
    timeout: TimeInterval
  ) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    repeat {
      if app.keyboards.firstMatch.exists { return true }
      let remaining = deadline.timeIntervalSinceNow
      guard remaining > 0 else { break }
      let focusExpectation = XCTNSPredicateExpectation(
        predicate: NSPredicate(format: "hasKeyboardFocus == true"),
        object: field
      )
      if XCTWaiter.wait(for: [focusExpectation], timeout: min(0.25, remaining)) == .completed {
        return true
      }
    } while Date() < deadline
    return app.keyboards.firstMatch.exists
  }

  private func waitForTextValue(
    in field: XCUIElement,
    expected: String,
    changedFrom initialValue: String?,
    timeout: TimeInterval
  ) -> Bool {
    let expectation = XCTNSPredicateExpectation(
      predicate: NSPredicate { object, _ in
        guard let field = object as? XCUIElement else { return false }
        let currentValue = field.value as? String
        if field.elementType == .secureTextField {
          return currentValue != initialValue
        }
        return currentValue == expected
      },
      object: field
    )
    return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
  }

  private func waitForClearedTextValue(
    in field: XCUIElement,
    timeout: TimeInterval
  ) -> Bool {
    let expectation = XCTNSPredicateExpectation(
      predicate: NSPredicate { object, _ in
        guard
          let field = object as? XCUIElement,
          let currentValue = field.value as? String
        else { return false }
        return currentValue.isEmpty || currentValue == (field.placeholderValue ?? "")
      },
      object: field
    )
    return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
  }

  func waitUntilEnabled(
    _ element: XCUIElement,
    timeout: TimeInterval = 5,
    file: StaticString = #filePath,
    line: UInt = #line
  ) {
    XCTAssertTrue(element.waitForExistence(timeout: timeout), file: file, line: line)
    let expectation = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "enabled == true"),
      object: element
    )
    XCTAssertEqual(
      XCTWaiter.wait(for: [expectation], timeout: timeout),
      .completed,
      "Expected \(element.identifier) to become enabled",
      file: file,
      line: line
    )
  }

  func openFirstConversation(in app: XCUIApplication) {
    selectTab("tab.conversations", in: app)
    revealSidebarIfNeeded(toExpose: "conversation.row.shared-plan", in: app)
    element("conversation.row.shared-plan", in: app).tap()
    dismissSplitOverlayIfPresent(in: app)
    _ = element("chat.transcript", in: app)
    let composer = element("chat.composer", in: app)
    XCTAssertTrue(
      waitUntilHittable(composer, timeout: 5),
      "Expected the composer to be actionable after opening the conversation"
    )
  }

  func openAgent(_ id: String, in app: XCUIApplication) {
    selectTab("tab.agents", in: app)
    revealSidebarIfNeeded(toExpose: "agent.row.\(id)", in: app)
    element("agent.row.\(id)", in: app).tap()
    dismissSplitOverlayIfPresent(in: app)
    _ = element("agent.detail.\(id)", in: app)
    let startChat = element("agent.startChat", in: app)
    XCTAssertTrue(
      waitUntilHittable(startChat, timeout: 5),
      "Expected the agent actions to be visible after opening the agent"
    )
  }

  func selectTab(
    _ identifier: String,
    in app: XCUIApplication,
    file: StaticString = #filePath,
    line: UInt = #line
  ) {
    revealSidebarIfNeeded(toExpose: identifier, in: app, file: file, line: line)
    let target = tab(identifier, in: app, file: file, line: line)
    target.tap()
    waitUntilSelected(target, file: file, line: line)
    dismissSplitOverlayIfPresent(in: app)

    if identifier == "tab.settings" {
      let settings = app.descendants(matching: .any)["settings.list"]
      XCTAssertTrue(settings.waitForExistence(timeout: 5), file: file, line: line)
      dismissSplitOverlayIfPresent(in: app)
      return
    }

    let contentIdentifier: String
    switch identifier {
    case "tab.agents":
      contentIdentifier = "agent.list"
    default:
      contentIdentifier = "conversation.list"
    }
    revealSidebarIfNeeded(toExpose: contentIdentifier, in: app, file: file, line: line)
  }

  func dismissSplitOverlayIfPresent(in app: XCUIApplication) {
    guard app.windows.firstMatch.frame.width >= 700 else { return }

    for _ in 0..<3 {
      let dismissRegion = app.otherElements.matching(identifier: "PopoverDismissRegion").firstMatch
      guard dismissRegion.waitForExistence(timeout: 2), dismissRegion.isHittable else {
        return
      }
      dismissRegion.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    }
  }

  /// Visible title of the tab-bar button backing a `tab.<x>` identifier —
  /// see `tabBarFallback(_:in:)`.
  private static let tabTitles = [
    "tab.conversations": "Conversations",
    "tab.agents": "Agents",
    "tab.settings": "Settings",
  ]

  /// Compact-width fallback locator for a tab, matched by its visible title
  /// inside the tab bar instead of by accessibility identifier.
  ///
  /// SwiftUI publishes the `.accessibilityIdentifier` set on a `.tabItem`'s
  /// `Label` onto the underlying `UITabBarItem` asynchronously, and on a
  /// contended host that publish frequently never happens for the lifetime of
  /// the launch: the tab bar renders, is hittable, and carries correct labels
  /// and traits, but its buttons have no `identifier` attribute at all — while
  /// every other element on the same screen (rows, toolbar buttons, the
  /// collection view) is present and correctly identified. Verified to
  /// reproduce on unmodified code, with a 20s wait (so it is not a race that
  /// eventually resolves), across every test class in this suite.
  ///
  /// Falling back to the title keeps the assertion just as strong — the tab-bar
  /// button for that tab must still exist and be hittable, and every downstream
  /// assertion is unchanged — while scoping the match to `app.tabBars` so it
  /// can never collide with same-titled content elsewhere on screen (the
  /// conversation list, for instance, also renders a "Conversations" header).
  /// Regular width is unaffected: its sidebar rows are ordinary SwiftUI views
  /// whose identifiers always publish, so this only ever applies on compact.
  private func tabBarFallback(_ identifier: String, in app: XCUIApplication) -> XCUIElement? {
    guard let title = Self.tabTitles[identifier] else { return nil }
    return app.tabBars.buttons[title]
  }

  func tab(
    _ identifier: String,
    in app: XCUIApplication,
    file: StaticString = #filePath,
    line: UInt = #line
  ) -> XCUIElement {
    let compactButton = app.buttons.matching(identifier: identifier).firstMatch
    if compactButton.waitForExistence(timeout: 0.5) {
      return compactButton
    }

    let regularLabel = app.staticTexts.matching(identifier: identifier).firstMatch
    if regularLabel.waitForExistence(timeout: 3) {
      return regularLabel
    }

    let fallback = tabBarFallback(identifier, in: app)
    // A contended CI runner can be mid-transition here (the tab bar
    // re-appearing after a pop) — wait, don't just peek.
    XCTAssertTrue(
      fallback?.waitForExistence(timeout: 5) == true,
      "Expected the tab bar button for \(identifier). UI: \(app.debugDescription)",
      file: file,
      line: line
    )
    return fallback ?? regularLabel
  }

  func revealSidebarIfNeeded(
    toExpose identifier: String,
    in app: XCUIApplication,
    file: StaticString = #filePath,
    line: UInt = #line
  ) {
    if waitUntilExposed(identifier, in: app, timeout: 0.25) { return }

    // iOS 26 publishes `BackButton`/`ToggleSidebar` identifiers; iOS 18 (the
    // CI runtime) exposes the back control only as an unidentified leading
    // button labelled with the previous screen's title — indistinguishable
    // from a root screen's own leading toolbar item (the list's Filter
    // menu). So on compact width, when no identified control exists and a
    // navigation bar is up, pop with the interactive left-edge swipe: it
    // needs no identifier and is a no-op on a root screen.
    let controls = [
      app.buttons.matching(identifier: "BackButton").firstMatch,
      app.buttons.matching(identifier: "ToggleSidebar").firstMatch,
    ]
    let isCompact = app.windows.firstMatch.frame.width < 700
    for _ in 0..<4 {
      if waitUntilExposed(identifier, in: app, timeout: 0.5) { return }
      if let control = controls.first(where: { $0.exists && $0.isHittable }) {
        control.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        continue
      }
      // Only from a pushed detail: on a root list the same drag would reveal
      // a row's leading swipe action instead of popping anything.
      let atRoot = ["conversation.list", "agent.list", "settings.list"].contains {
        app.descendants(matching: .any)[$0].exists
      }
      guard isCompact, atRoot == false, app.navigationBars.firstMatch.exists else { break }
      let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.005, dy: 0.5))
      let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.5))
      start.press(forDuration: 0.05, thenDragTo: end)
    }
    if waitUntilExposed(identifier, in: app, timeout: 3) { return }
    // SwiftUI intermittently never publishes `.tabItem` identifiers for a
    // launch (see `tabBarFallback`) — on those launches the title-matched
    // tab-bar button is the exposure signal, and `tab(_:)` will use it too.
    XCTAssertTrue(
      tabBarFallback(identifier, in: app)?.exists == true,
      "Expected \(identifier) after revealing the split-navigation columns. UI: \(app.debugDescription)",
      file: file,
      line: line
    )
  }

  private func matchingElement(_ identifier: String, in app: XCUIApplication) -> XCUIElement {
    guard identifier.hasPrefix("tab.") else {
      return app.descendants(matching: .any)[identifier]
    }

    let compactButton = app.buttons.matching(identifier: identifier).firstMatch
    if compactButton.exists {
      return compactButton
    }
    return app.staticTexts.matching(identifier: identifier).firstMatch
  }

  private func waitUntilExposed(
    _ identifier: String,
    in app: XCUIApplication,
    timeout: TimeInterval
  ) -> Bool {
    if identifier.hasPrefix("tab.") {
      let titleFallback = Self.tabTitles[identifier]
      let expectation = XCTNSPredicateExpectation(
        predicate: NSPredicate { object, _ in
          guard let app = object as? XCUIApplication else { return false }
          let compactButton = app.buttons.matching(identifier: identifier).firstMatch
          if compactButton.exists, compactButton.isHittable {
            return true
          }
          let regularLabel = app.staticTexts.matching(identifier: identifier).firstMatch
          if regularLabel.exists, regularLabel.isHittable {
            return true
          }
          // See `tabBarFallback(_:in:)`: the tab-bar button is there and
          // hittable, but SwiftUI may never publish the `.tabItem` label's
          // accessibility identifier onto it for this launch.
          guard let titleFallback else { return false }
          let barButton = app.tabBars.buttons[titleFallback]
          return barButton.exists && barButton.isHittable
        },
        object: app
      )
      return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
    }

    let element = matchingElement(identifier, in: app)
    let structuralIdentifiers = [
      "agent.list",
      "chat.transcript",
      "conversation.list",
      "settings.list",
    ]
    if structuralIdentifiers.contains(identifier) || identifier.hasPrefix("agent.detail.") {
      return waitUntilVisible(element, in: app, timeout: timeout)
    }
    return waitUntilHittable(element, timeout: timeout)
  }

  private func waitUntilVisible(
    _ element: XCUIElement,
    in app: XCUIApplication,
    timeout: TimeInterval
  ) -> Bool {
    let appFrame = app.windows.firstMatch.frame
    let expectation = XCTNSPredicateExpectation(
      predicate: NSPredicate { object, _ in
        guard let element = object as? XCUIElement, element.exists else { return false }
        let visibleFrame = element.frame.intersection(appFrame)
        return visibleFrame.isNull == false && visibleFrame.isEmpty == false
      },
      object: element
    )
    return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
  }

  func waitUntilHittable(_ element: XCUIElement, timeout: TimeInterval) -> Bool {
    let expectation = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "exists == true AND hittable == true"),
      object: element
    )
    return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
  }

  func waitUntilSelected(
    _ element: XCUIElement,
    timeout: TimeInterval = 5,
    file: StaticString = #filePath,
    line: UInt = #line
  ) {
    XCTAssertTrue(element.waitForExistence(timeout: timeout), file: file, line: line)
    let expectation = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "selected == true"),
      object: element
    )
    XCTAssertEqual(
      XCTWaiter.wait(for: [expectation], timeout: timeout),
      .completed,
      "Expected \(element.identifier) to become selected",
      file: file,
      line: line
    )
  }

  func confirmationDialog(
    titled title: String,
    in app: XCUIApplication,
    file: StaticString = #filePath,
    line: UInt = #line
  ) -> XCUIElement {
    let labeledAlert = app.alerts.matching(
      NSPredicate(format: "label == %@", title)
    ).firstMatch
    if labeledAlert.waitForExistence(timeout: 0.5) {
      return labeledAlert
    }

    let alert = app.alerts.containing(.staticText, identifier: title).firstMatch
    if alert.waitForExistence(timeout: 0.5) {
      return alert
    }

    let labeledSheet = app.sheets.matching(
      NSPredicate(format: "label == %@", title)
    ).firstMatch
    if labeledSheet.waitForExistence(timeout: 0.5) {
      return labeledSheet
    }

    let sheet = app.sheets.containing(.staticText, identifier: title).firstMatch
    if sheet.waitForExistence(timeout: 0.5) {
      return sheet
    }

    let labeledPopover = app.popovers.matching(
      NSPredicate(format: "label == %@", title)
    ).firstMatch
    if labeledPopover.waitForExistence(timeout: 0.5) {
      return labeledPopover
    }

    let popover = app.popovers.containing(.staticText, identifier: title).firstMatch
    XCTAssertTrue(
      popover.waitForExistence(timeout: 3),
      "Expected confirmation dialog titled \(title). UI: \(app.debugDescription)",
      file: file,
      line: line
    )
    return popover
  }

  /// Dismisses a confirmation without choosing its action. iOS 18 renders a
  /// toolbar-Menu-triggered `confirmationDialog` as a sheet with a Cancel
  /// row; iOS 26 renders an anchored popover with no Cancel, dismissed by
  /// tapping outside (`PopoverDismissRegion`).
  func dismissConfirmation(
    _ dialog: XCUIElement,
    in app: XCUIApplication,
    file: StaticString = #filePath,
    line: UInt = #line
  ) {
    let cancel = dialog.buttons["Cancel"].firstMatch
    if cancel.waitForExistence(timeout: 1) {
      cancel.tap()
    } else {
      let dismissRegion = app.otherElements.matching(identifier: "PopoverDismissRegion").firstMatch
      XCTAssertTrue(
        dismissRegion.waitForExistence(timeout: 3),
        "Expected a Cancel row or a popover dismiss region. UI: \(app.debugDescription)",
        file: file,
        line: line
      )
      dismissRegion.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.6)).tap()
    }
    XCTAssertTrue(dialog.waitForNonExistence(timeout: 5), file: file, line: line)
  }

  func assertFitsHorizontally(
    _ element: XCUIElement,
    in app: XCUIApplication,
    file: StaticString = #filePath,
    line: UInt = #line
  ) {
    XCTAssertTrue(element.exists, file: file, line: line)
    let appFrame = app.windows.firstMatch.frame
    let frame = element.frame
    XCTAssertGreaterThanOrEqual(frame.minX, appFrame.minX - 1, file: file, line: line)
    XCTAssertLessThanOrEqual(frame.maxX, appFrame.maxX + 1, file: file, line: line)
  }

  func scrollToElement(
    _ identifier: String,
    in app: XCUIApplication,
    maxSwipes: Int = 6,
    file: StaticString = #filePath,
    line: UInt = #line
  ) -> XCUIElement {
    let value = app.descendants(matching: .any)[identifier]
    for _ in 0..<maxSwipes where value.exists == false {
      app.swipeUp()
    }
    XCTAssertTrue(
      value.waitForExistence(timeout: 2),
      "Expected \(identifier) after \(maxSwipes) upward swipes",
      file: file,
      line: line
    )
    return value
  }
}
