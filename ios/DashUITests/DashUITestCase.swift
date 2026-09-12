import XCTest

@MainActor
class DashUITestCase: XCTestCase {
  static let accessibilityXXXL = "UICTContentSizeCategoryAccessibilityXXXL"

  override func setUp() {
    super.setUp()
    continueAfterFailure = false
  }

  @discardableResult
  /// `conversationID`: open this conversation on launch through
  /// `UITestLaunchOptions.initialConversationID` — no tab or row taps, so a
  /// test that is about the chat surface itself runs the same on every
  /// runtime, including iPadOS 26, whose sidebar-tab layout has no `tab.*`
  /// bar for `selectTab` to find on `main` today.
  func launch(
    scenario: String,
    contentSize: String? = nil,
    reduceMotion: Bool = false,
    conversationID: String? = nil
  ) -> XCUIApplication {
    let app = XCUIApplication()
    let dataIdentifier = UUID().uuidString
    app.launchEnvironment["DASH_UI_TEST_SCENARIO"] = scenario
    app.launchEnvironment["DASH_UI_TEST_DATA_IDENTIFIER"] = dataIdentifier
    if let conversationID {
      app.launchEnvironment["DASH_UI_TEST_CONVERSATION"] = conversationID
    }
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

  /// Wait for an element's accessible LABEL to settle on a value.
  ///
  /// Needed wherever the value a test asserts arrives from a round trip the
  /// app made after the tap — a stopped row's status comes back from the stop
  /// route and then again from the list re-read, so reading the label straight
  /// after the tap is a race the test would lose intermittently.
  func waitForLabel(
    _ element: XCUIElement,
    _ expected: String,
    timeout: TimeInterval = 5
  ) -> Bool {
    let expectation = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "label == %@", expected),
      object: element
    )
    return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
  }

  /// The same, for an element's `value`.
  func waitForValue(
    _ element: XCUIElement,
    _ expected: String,
    timeout: TimeInterval = 5
  ) -> Bool {
    let expectation = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "value == %@", expected),
      object: element
    )
    return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
  }

  /// Wait until a text field no longer carries `text` — an empty `TextField`
  /// reports its PLACEHOLDER as its value, so "cleared" cannot be asserted as
  /// an empty string.
  func waitForClearedValue(
    _ element: XCUIElement,
    _ text: String,
    timeout: TimeInterval = 5
  ) -> Bool {
    let expectation = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "value != %@", text),
      object: element
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
    // `Self.exposureWait`, not a sub-second peek: at regular width the
    // sidebar footer publishes `tab.*` as BUTTONS, so this is the branch the
    // iPad takes, and one prematurely-expired wait here falls all the way
    // through to `tabBarFallback` — a tab bar that cannot exist at regular
    // width — turning a timing blip into "Expected the tab bar button for
    // tab.agents". See `exposureWait` for why sub-second windows expire
    // before a query round-trips on a contended host.
    let compactButton = app.buttons.matching(identifier: identifier).firstMatch
    if compactButton.waitForExistence(timeout: Self.exposureWait) {
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

  /// How long every `waitUntilExposed` check inside `revealSidebarIfNeeded`
  /// — and the regular-width button lookup in `tab(_:in:)` — gets.
  /// A single XCUITest element query round-trips in roughly a second on
  /// a contended host, so the sub-second timeouts this used to pass expired
  /// before `XCTNSPredicateExpectation` ever evaluated its predicate once:
  /// the check reported "not exposed" no matter what was on screen, and the
  /// caller always fell through to tapping a control it did not need.
  ///
  /// That misfire is destructive on the iPad two-column layout (design
  /// §1.1), where Agents is a PUSH inside the sidebar's own `NavigationStack`
  /// rather than a separate column: the unnecessary "BackButton" tap popped
  /// the very page `selectTab("tab.agents")` had just navigated to, so
  /// `agent.list` was gone by the time it was checked for. Giving each check
  /// a full poll cycle lets it see the already-correct screen and return
  /// without touching anything.
  ///
  /// A window this wide necessarily spans UIKit transition animations, during
  /// which `isHittable` RAISES on a control with no usable activation point —
  /// see `isSafelyHittable`, which is what makes a long poll safe.
  private static let exposureWait: TimeInterval = 2

  func revealSidebarIfNeeded(
    toExpose identifier: String,
    in app: XCUIApplication,
    file: StaticString = #filePath,
    line: UInt = #line
  ) {
    if waitUntilExposed(identifier, in: app, timeout: Self.exposureWait) { return }

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
      if waitUntilExposed(identifier, in: app, timeout: Self.exposureWait) { return }
      // `isSafelyHittable`, not `isHittable`: a back/toggle control that is
      // itself mid-transition raises rather than reporting false, and this
      // loop now polls long enough to catch one in that state.
      if let control = controls.first(where: { isSafelyHittable($0, in: app) }) {
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
          if isSafelyHittable(compactButton, in: app) {
            return true
          }
          let regularLabel = app.staticTexts.matching(identifier: identifier).firstMatch
          if isSafelyHittable(regularLabel, in: app) {
            return true
          }
          // See `tabBarFallback(_:in:)`: the tab-bar button is there and
          // hittable, but SwiftUI may never publish the `.tabItem` label's
          // accessibility identifier onto it for this launch.
          guard let titleFallback else { return false }
          return isSafelyHittable(app.tabBars.buttons[titleFallback], in: app)
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
    // Deliberately a hand-rolled poll rather than
    // `XCTNSPredicateExpectation(NSPredicate(format: "hittable == true"))`.
    //
    // Two reasons. First, evaluating `hittable` on an element that is
    // mid-transition RAISES instead of returning false, and the raise escapes
    // the predicate and fails the test outright — the hazard `isSafelyHittable`
    // exists for, and one this helper is fully exposed to since it polls for
    // the whole of `exposureWait` and its callers pass rows and controls that
    // animate. Second, a *block* predicate is not a drop-in replacement for a
    // format predicate here: XCTest re-evaluates it as fast as the UI settles
    // and every property read inside takes a fresh accessibility snapshot, and
    // at accessibility text sizes that snapshot is big enough that the extra
    // traffic made the app's UI queries time out. A fixed 0.25s cadence keeps
    // the safe probe affordable.
    let app = XCUIApplication()
    let deadline = Date().addingTimeInterval(timeout)
    repeat {
      if isSafelyHittable(element, in: app) { return true }
      _ = XCTWaiter.wait(for: [XCTestExpectation(description: "settle")], timeout: 0.25)
    } while Date() < deadline
    return false
  }

  /// Polls `ChatView`'s DEBUG `chat.scrollAnchor` probe (only rendered by the
  /// `long-transcript` scenario) until it reports a real `ChatMessageState.id`
  /// — i.e. until `.scrollPosition(id:)` has tracked a transcript row rather
  /// than `"none"` or one of the outer stack's non-message children. Returns
  /// the tracked id (Task 4 review fix, Important 1).
  func waitForTrackedScrollAnchor(
    prefix: String,
    in app: XCUIApplication,
    timeout: TimeInterval = 10,
    file: StaticString = #filePath,
    line: UInt = #line
  ) -> String {
    let probe = element("chat.scrollAnchor", in: app, file: file, line: line)
    let expectation = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "label BEGINSWITH %@", prefix),
      object: probe
    )
    XCTAssertEqual(
      XCTWaiter.wait(for: [expectation], timeout: timeout),
      .completed,
      """
      Expected .scrollPosition(id:) to track a real message id after scrolling, \
      got "\(probe.label)". A value of "none" means the scroll anchor is never \
      populated — the tracking direction is dead.
      """,
      file: file,
      line: line
    )
    return probe.label
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

  /// Wait for an element to STOP existing.
  ///
  /// `XCTAssertFalse(element.exists)` straight after a tap is a race with the
  /// disclosure animation and with whatever relayout the tap caused; it passed
  /// on one run of this suite and failed on the next once a second scripted
  /// child made the transcript taller. Asserting the absence rather than
  /// sampling it is the fix.
  func waitForNoElement(
    _ identifier: String,
    in app: XCUIApplication,
    timeout: TimeInterval = 5
  ) -> Bool {
    let expectation = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "exists == false"),
      object: app.descendants(matching: .any)[identifier]
    )
    return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
  }

  /// Swipe the transcript until an element that ALREADY EXISTS becomes
  /// hittable.
  ///
  /// `scrollToElement` swipes only while the element does not exist, which is
  /// the wrong condition for a row that is mounted but sits below the visible
  /// viewport: XCUITest then reports "Activation point invalid and no suggested
  /// hit points based on element frame" rather than "does not exist". A second
  /// scripted child pushed the transcript past one screen, so this is the
  /// difference between a deterministic test and one whose result depends on
  /// how much text had streamed when it looked.
  @discardableResult
  func scrollUntilHittable(
    _ element: XCUIElement,
    in app: XCUIApplication,
    maxSwipes: Int = 6,
    file: StaticString = #filePath,
    line: UInt = #line
  ) -> XCUIElement {
    XCTAssertTrue(element.waitForExistence(timeout: 8), file: file, line: line)
    // Swipe the TRANSCRIPT, not the app. `app.swipeUp()` starts its gesture in
    // the middle of the screen, which is inside the keyboard whenever the
    // composer has focus — the swipe then scrolls nothing at all, and the loop
    // below burns all its attempts without moving. That is not hypothetical:
    // this test passed in isolation and failed inside the full suite, where the
    // keyboard is up from `openFirstConversation`.
    let scroller = app.descendants(matching: .any)["chat.transcript"]
    let surface = scroller.exists ? scroller : app
    // **The scroller's frame is not the visible band.** `chat.transcript` is a
    // full-screen `ScrollView` — measured `(0, 0, 402, 874)` — and everything
    // that covers its bottom (the composer, §8.4's tasks strip, and the
    // software keyboard whenever the composer has focus) sits INSIDE that frame
    // while hiding what is under it. A midpoint inside `surface.frame` is
    // therefore not enough, which is exactly how this helper failed once the
    // frame loop was in place: `Expected chat.subagent.ui-subagent.header to be
    // hittable once inside (0.0, 0.0, 402.0, 874.0)`. The band below is the
    // scroller minus whatever is actually on top of it.
    //
    // **Re-sampled inside the loop below, because a swipe can change it.** The
    // keyboard is the occluder that moves — a swipe on the transcript dismisses
    // it and a later tap raises it again — and a band measured once before the
    // loop is one the loop goes on steering into after it has stopped matching
    // the screen. Costs one extra `visibleBand` per swipe actually taken, and
    // nothing at all for a row that is already in view.
    var visible = visibleBand(of: surface, in: app)

    // **`isHittable` is not a predicate on an off-screen row — it RAISES.**
    // Measured, not inferred: on a fresh iOS 26.5 simulator this helper failed
    // at its first loop CONDITION, before a single swipe, with `Failed to
    // determine hittability of "chat.subagent.ui-subagent-2.reply" TextField:
    // Activation point invalid and no suggested hit points based on element
    // frame`. A row that is mounted but outside the scroller has no activation
    // point, so asking whether it is hittable fails the test instead of
    // answering. It reproduces on the UNTOUCHED tree, so it is a property of
    // the device instance and the layout, not of any one change.
    //
    // So the scrolling is driven by the element's FRAME, which is always
    // readable, and hittability is asked exactly once, at the end, when the row
    // is known to be inside the scroller. One loop rather than an up pass
    // followed by a down pass, because the direction can CHANGE between two
    // checks while a turn is still streaming — and a pass structure cannot go
    // back, which is how the same helper once burned twelve swipes travelling
    // away from its target.
    for _ in 0..<(maxSwipes * 3) {
      let frame = element.frame
      if frame.height > 0, visible.contains(CGPoint(x: frame.midX, y: frame.midY)) { break }
      // An unreadable (zero) frame is treated as "below", which is the common
      // case for a row the transcript has grown under.
      if frame.height == 0 || frame.midY >= visible.midY {
        surface.swipeUp()
      } else {
        surface.swipeDown()
      }
      visible = visibleBand(of: surface, in: app)
    }

    let frame = element.frame
    // `isHittable` is only SAFE to ask once the row is where a tap can reach it
    // — anywhere else it raises rather than answering.
    //
    // The BAND, not `surface.frame`: the whole point of the loop above is that
    // a midpoint inside the scroller can still be behind the keyboard, and a
    // guard on the frame lets exactly that case through to `isHittable`, which
    // is the call this helper exists to protect. It fails either way — false,
    // or a raise with no explanation — so this is the diagnostic, not a
    // strengthening: the loop's own break condition and this guard now ask the
    // same question.
    guard frame.height > 0, visible.contains(CGPoint(x: frame.midX, y: frame.midY)) else {
      XCTFail(
        """
        Expected \(element.identifier) to be scrolled into the visible band \(visible);         its frame is \(frame) and the scroller's is \(surface.frame)
        """,
        file: file,
        line: line
      )
      return element
    }
    XCTAssertTrue(
      element.isHittable,
      "Expected \(element.identifier) at \(frame) to be hittable inside the visible band \(visible)",
      file: file,
      line: line
    )
    return element
  }

  /// The part of `surface` a tap can actually reach: its own frame, minus the
  /// chrome that overlays it.
  ///
  /// Every occluder here overlays the transcript rather than sitting outside
  /// it: the software KEYBOARD (up whenever the composer has focus, which
  /// `openFirstConversation` leaves it with), the COMPOSER and §8.4's tasks
  /// STRIP in the bottom safe area, and the NAVIGATION BAR at the top. The
  /// keyboard and the composer are the two that have actually cost a run; the
  /// strip and the bar are here because they are the same shape of thing and
  /// cost nothing to exclude. Each is looked up by existence, so a screen
  /// without one is unaffected.
  private func visibleBand(of surface: XCUIElement, in app: XCUIApplication) -> CGRect {
    let bounds = surface.frame
    var top = bounds.minY
    var bottom = bounds.maxY
    let navigationBar = app.navigationBars.firstMatch
    if navigationBar.exists, navigationBar.frame.height > 0 {
      top = max(top, navigationBar.frame.maxY)
    }
    let occluders = [
      app.keyboards.firstMatch,
      app.descendants(matching: .any)["chat.tasks.strip"],
      app.descendants(matching: .any)["chat.composer"],
    ]
    for occluder in occluders where occluder.exists && occluder.frame.height > 0 {
      bottom = min(bottom, occluder.frame.minY)
    }
    guard bottom > top else { return bounds }
    return CGRect(x: bounds.minX, y: top, width: bounds.width, height: bottom - top)
  }

  /// Retire the software keyboard so the transcript's visible band is the whole
  /// scroller again.
  ///
  /// Why this is needed at all, and why it appeared with the `main` merge: with
  /// the keyboard up the band `visibleBand` computes is ~330pt of an 874pt
  /// transcript, and a row inside the covered region cannot be swiped out from
  /// under it while the transcript is pinned to the end of a STREAMING turn —
  /// every swipe up is undone by the re-pin. Main's per-type tool bodies (an
  /// auto-expanded TodoWrite checklist) added enough height above the sub-agent
  /// rows to push `chat.subagent.<id>.reply` and the expanded body composer
  /// into exactly that region, which is a real thing a user meets too: they
  /// dismiss the keyboard, and so does this.
  ///
  /// `ChatView` answers `.scrollDismissesKeyboard(.interactively)`, so this is a
  /// slow drag DOWN rather than a tap, repeated until the keyboard is actually
  /// gone — one flick sometimes only moves it. Returns whether it went, so a
  /// caller can assert rather than assume.
  ///
  /// **Sending takes the keyboard down and the end of the turn brings it back,
  /// so this waits for it before retiring it.** `ComposerView` writes
  /// `.disabled(feature.draftEditingAllowed == false)` on the draft field, and
  /// `ChatFeature.draftEditingAllowed` is false for the whole of a send
  /// (`isSending`, then `state.activeTurnID != nil`). A DISABLED `TextField`
  /// resigns first responder — the keyboard genuinely goes away — and when the
  /// turn ends the field re-enables with `@FocusState` still `true`, so it
  /// comes straight back at the frame it left (`{0, 583, 402, 233}`, measured
  /// 1.2s to 7s after the tap, varying with load). A helper that samples
  /// inside that gap retires nothing, returns `true`, and the keyboard then
  /// arrives on top of the row the caller wanted to reach — which is how the
  /// two sub-agent tests passed in isolation and failed in the full suite,
  /// twice.
  ///
  /// So: wait for the composer to be usable again (the same edge that
  /// re-presents the keyboard), then drag UNCONDITIONALLY. A drag with no
  /// keyboard up costs a scroll the caller's `scrollUntilHittable` undoes; a
  /// skipped drag costs the assertion its meaning.
  @discardableResult
  func dismissKeyboard(in app: XCUIApplication, attempts: Int = 4) -> Bool {
    let scroller = app.descendants(matching: .any)["chat.transcript"]
    guard scroller.exists else { return keyboardStaysGone(in: app) }
    waitForTheKeyboardSendTookDown(in: app)
    for attempt in 0..<attempts {
      if attempt > 0, keyboardStaysGone(in: app) { return true }
      scroller.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25))
        .press(
          forDuration: 0.25,
          thenDragTo: scroller.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7))
        )
    }
    return keyboardStaysGone(in: app)
  }

  /// Wait out the window in which `chat.send` has taken the keyboard down and
  /// the composer has not yet re-enabled, because the keyboard comes back with
  /// it. No wait at all when the field is already usable — that is the case
  /// where the keyboard is up and there is nothing to wait for.
  private func waitForTheKeyboardSendTookDown(
    in app: XCUIApplication,
    timeout: TimeInterval = 10
  ) {
    let composer = app.descendants(matching: .any)["chat.composer"]
    guard composer.exists, composer.isEnabled == false else { return }
    let usable = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "enabled == true"),
      object: composer
    )
    guard XCTWaiter().wait(for: [usable], timeout: timeout) == .completed else { return }
    _ = app.keyboards.firstMatch.waitForExistence(timeout: 3)
  }

  /// The keyboard is gone AND stays gone for `settle` seconds.
  ///
  /// Measured on this simulator, in the failing runs' own logs: absent at
  /// t=27.16s (right after `chat.send`), back at {0, 583} by t=29.94s in one
  /// run; absent from t=27.21s and back at t=34.10s in another. The settle is
  /// 4s so that a keyboard on its way back is seen returning rather than
  /// reported gone — and because it cannot cover the 7s case, it is a stop
  /// condition only, never the reason a drag is skipped.
  ///
  /// An INVERTED predicate expectation waited on a standalone `XCTWaiter`:
  /// inverted so that "never became true" is the success, standalone so a
  /// return records nothing against the test — the caller decides what a
  /// returning keyboard means.
  private func keyboardStaysGone(in app: XCUIApplication, settle: TimeInterval = 4) -> Bool {
    guard app.keyboards.firstMatch.exists == false else { return false }
    let returns = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "exists == true"),
      object: app.keyboards.firstMatch
    )
    returns.isInverted = true
    return XCTWaiter().wait(for: [returns], timeout: settle) == .completed
  }

  /// Asserts that every glyph `element` renders lies inside the window
  /// horizontally.
  ///
  /// Use this instead of `assertFitsHorizontally` when the element under test
  /// is a CONTAINER whose frame the system, not the app, positions. A `List`
  /// and its cells expand into safe areas by design, so their frames describe
  /// the safe area rather than where anything is drawn. On iPadOS 18.4
  /// `NavigationSplitView` puts its sidebar column's host view 100 pt off the
  /// window's leading edge -- `(-100, 0, column + 100, height)` -- with a
  /// matching 100 pt leading safe-area inset that puts the drawn content back,
  /// so `conversation.list`, its cells and the row buttons inside them all
  /// report `minX == -100` while every glyph sits at `x >= 16`. That overhang
  /// is the system's column geometry, not this app's layout: it is identical at
  /// the DEFAULT text size, widening the column moves it instead of removing
  /// it, and a bare `List { Text("hello") }` as the entire sidebar reproduces
  /// it exactly (sixteen variants measured; see task-2-report.md).
  ///
  /// This is not a relaxation of `assertFitsHorizontally`. There is no
  /// tolerance -- each text element is held to the same window edge plus or
  /// minus 1 pt -- and checking the glyphs individually is what actually
  /// detects the failure the assertion exists for: text grown by Dynamic Type
  /// past the width of its column. A container's frame never showed that,
  /// because the container keeps its layout width while its contents overflow.
  func assertTextFitsHorizontally(
    _ element: XCUIElement,
    in app: XCUIApplication,
    file: StaticString = #filePath,
    line: UInt = #line
  ) {
    XCTAssertTrue(element.exists, file: file, line: line)
    let texts = element.descendants(matching: .staticText).allElementsBoundByIndex
    XCTAssertFalse(
      texts.isEmpty,
      "Expected \(element) to render some text to check for clipping",
      file: file,
      line: line
    )
    for text in texts where text.frame.isEmpty == false {
      assertFitsHorizontally(text, in: app, file: file, line: line)
    }
  }

  /// Scrolls the Settings list until `identifier` is on screen and hittable.
  ///
  /// Settings is a full-height column on compact width but a form SHEET on the
  /// iPad two-column layout (design §1.1), and a sheet is a much shorter
  /// viewport — rows below its fold are neither hittable nor reliably present
  /// in the accessibility hierarchy at all. Swiping the list itself (rather
  /// than the app) also keeps the gesture off the sheet's own drag-to-dismiss
  /// area.
  func scrollSettingsToElement(
    _ identifier: String,
    in app: XCUIApplication,
    maxSwipes: Int = 6,
    file: StaticString = #filePath,
    line: UInt = #line
  ) -> XCUIElement {
    let settingsList = element("settings.list", in: app, file: file, line: line)
    let window = app.windows.firstMatch
    XCTAssertTrue(
      window.waitForExistence(timeout: 2),
      "Expected the app window before scrolling settings",
      file: file,
      line: line
    )
    let value = app.descendants(matching: .any)[identifier]

    func isExposed() -> Bool {
      guard value.exists, value.isHittable else { return false }
      return value.frame.intersects(settingsList.frame) && value.frame.intersects(window.frame)
    }

    for _ in 0..<maxSwipes where isExposed() == false {
      settingsList.swipeUp()
    }
    XCTAssertTrue(
      isExposed(),
      "Expected \(identifier) to be exposed and hittable after \(maxSwipes) settings-list swipes",
      file: file,
      line: line
    )
    return value
  }

  /// Returns the conversation list's `.searchable` search field, first
  /// scrolling the list back to the top if the search bar is hidden.
  ///
  /// UIKit hides a `.searchable` search bar as soon as its list scrolls
  /// (`hidesSearchBarWhenScrolling`). On the iPad two-column layout (design
  /// §1.1) the conversation list IS the split view's sidebar, and that column
  /// can settle a few points scrolled once it has laid out, so the search bar
  /// is sometimes already hidden by the time a test looks for it and never
  /// comes back on its own — the same lookup passes or fails purely on
  /// timing. Scrolling back to the top is what a person would do to reach it,
  /// and it makes the lookup deterministic.
  func revealSearchField(
    in app: XCUIApplication,
    maxSwipes: Int = 4,
    file: StaticString = #filePath,
    line: UInt = #line
  ) -> XCUIElement {
    let field = app.searchFields.firstMatch
    let list = app.descendants(matching: .any)["conversation.list"]
    for _ in 0..<maxSwipes where field.exists == false {
      guard list.exists else { break }
      list.swipeDown()
    }
    XCTAssertTrue(
      field.waitForExistence(timeout: 5),
      "Expected the conversation search field after \(maxSwipes) downward swipes",
      file: file,
      line: line
    )
    return field
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

/// `isHittable`, but never fatal for an element that is mid-transition.
///
/// `XCUIElement.isHittable` does not return `false` for an element that exists
/// yet has no usable activation point — it RAISES ("Failed to determine
/// hittability of … : Activation point invalid and no suggested hit points
/// based on element frame"), and that raise escapes an `NSPredicate` block and
/// fails the whole test. A UIKit tab-bar button passes through exactly that
/// state while the bar animates in or out (iOS 26 hides the phone's tab bar
/// under a pushed detail), so ANY poll long enough to span a transition — see
/// `DashUITestCase.exposureWait` — will eventually sample it. The failure is
/// therefore a property of the poll window, not of the app.
///
/// So ask `isHittable` only when the element's frame is real and OVERLAPS the
/// window, rather than requiring the window to fully contain it. Full
/// containment was tried first and is too strong: at accessibility XXXL a
/// conversation row is taller than the visible viewport, so its frame can
/// never be fully inside the window even though the row is genuinely on
/// screen and tappable (`AccessibilityUITests.testAccessibilityXXXL`) — the
/// stricter guard reported it as permanently "not exposed" and
/// `revealSidebarIfNeeded` never returned. An element whose frame is entirely
/// outside the window — the actual mid-transition case above, where a
/// tab-bar button slides fully off before it settles — has no overlap at all
/// and is still correctly rejected here without ever reaching `isHittable`.
/// Once there is real overlap, `isHittable` itself resolves the activation
/// point from the visible, on-screen portion, so it neither raises nor lies
/// about a partially-visible control. Nothing is weakened for settled UI: a
/// settled control fully overlaps the window too, so `isHittable` is still
/// consulted and still decides.
///
/// A free function purely for locality — it is `@MainActor` all the same, and
/// must be. `XCUIElement`'s `exists` / `frame` / `isHittable` and
/// `XCUIApplication.windows` are main-actor-isolated under the iOS 18 SDK, so
/// a nonisolated version of this cannot read any of them: Xcode 16.3 / Swift
/// 6.1 rejected exactly that with "main actor-isolated property 'exists' can
/// not be referenced from a nonisolated context" (and the same for `frame`,
/// `windows`, `firstMatch`, `isHittable`), failing the whole `DashUITests`
/// target before a single test could run.
///
/// Being `@MainActor` costs the callers nothing, which is the part worth
/// recording: `NSPredicate(block:)` does NOT take a `@Sendable` closure, so
/// the blocks in `waitUntilExposed` and `waitUntilVisible` INHERIT the
/// isolation of the `@MainActor` method that builds them. That is why those
/// blocks already read `app.buttons…firstMatch` and `element.frame` directly
/// without complaint. Every call site here is likewise already isolated, so
/// no `MainActor.assumeIsolated` is needed anywhere.
@MainActor
private func isSafelyHittable(_ element: XCUIElement, in app: XCUIApplication) -> Bool {
  guard element.exists else { return false }
  let frame = element.frame
  guard frame.isNull == false, frame.isInfinite == false, frame.isEmpty == false else {
    return false
  }
  let window = app.windows.firstMatch.frame
  // 1pt of slack: a settled control may round a hair past the window edge,
  // which would otherwise make two touching-but-not-overlapping rects report
  // no intersection.
  guard window.isEmpty == false, window.insetBy(dx: -1, dy: -1).intersects(frame) else {
    return false
  }
  return element.isHittable
}
