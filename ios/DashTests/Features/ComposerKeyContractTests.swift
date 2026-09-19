import Foundation
import Testing

@testable import Dash

/// Cross-checks `ComposerKeyContract` against the `ios` column of
/// `scripts/fixtures/composer-key-contract.json` — the same file
/// `apps/web/src/ui/ChatView.test.tsx` and Mission Control's
/// `chat.helpers.test.ts` generate their tests from.
///
/// The fixture is the single source of truth for what each key does in the
/// composer on each client. Plain Return is now a SHARED, configurable setting
/// (`returnKeySends`, default false), modelled by each Enter row's `enter` map
/// rather than a single per-client answer; what the fixture forbids is
/// UNINTENDED divergence. Changing this app's behaviour without the fixture, or
/// the fixture without this app, fails here.
///
/// Loads the file by walking up from `#filePath` rather than from a bundle
/// resource — the same approach `RenderingParityTests` uses for
/// `rendering-fixtures.json`, so no target membership is involved.
@Suite("Composer key contract (cross-client)")
struct ComposerKeyContractTests {

  private struct Fixture: Decodable {
    let cases: [Case]
  }

  /// A row is either mode-independent (a flat `ios` answer) or mode-dependent
  /// (an `enter` map keyed `newline`/`send`). `Decodable` with optional
  /// members plus a manual `init(from:)` keeps that clean.
  private struct Case: Decodable {
    let name: String
    let key: String
    let shift: Bool
    let meta: Bool
    let ios: String?
    let mechanism: Mechanisms?
    let enter: EnterModes?

    struct Mechanisms: Decodable {
      let ios: String
    }

    /// `enter.newline` / `enter.send`, each carrying the per-mode `ios` answer
    /// and (for the newline mode) the newline mechanism.
    struct EnterModes: Decodable {
      let newline: Mode
      let send: Mode
    }

    struct Mode: Decodable {
      let ios: String
      let mechanism: Mechanisms?
    }

    /// The answer for the single `returnKeySends` mode this test is running.
    func expectedAction(returnKeySends: Bool) -> String {
      if let enter { return returnKeySends ? enter.send.ios : enter.newline.ios }
      return ios!
    }

    func expectedMechanism(returnKeySends: Bool) -> String? {
      if let enter { return returnKeySends ? nil : enter.newline.mechanism?.ios }
      return mechanism?.ios
    }
  }

  private static let fixture: Fixture = {
    let thisFile = URL(fileURLWithPath: #filePath)
    let repoRoot =
      thisFile
      .deletingLastPathComponent()  // ComposerKeyContractTests.swift -> Features/
      .deletingLastPathComponent()  // Features/ -> DashTests/
      .deletingLastPathComponent()  // DashTests/ -> ios/
      .deletingLastPathComponent()  // ios/ -> repo root
    let url =
      repoRoot
      .appendingPathComponent("scripts", isDirectory: true)
      .appendingPathComponent("fixtures", isDirectory: true)
      .appendingPathComponent("composer-key-contract.json", isDirectory: false)
    guard let data = try? Data(contentsOf: url) else {
      fatalError("Could not read composer-key-contract.json at \(url.path)")
    }
    guard let decoded = try? JSONDecoder().decode(Fixture.self, from: data) else {
      fatalError("Could not decode composer-key-contract.json at \(url.path)")
    }
    return decoded
  }()

  @Test("the fixture actually carries rows, so a silent empty file cannot pass everything")
  func fixtureIsNotEmpty() {
    #expect(Self.fixture.cases.count >= 5)
  }

  /// Both modes, because plain Return is now configurable: the contract must
  /// match the fixture in the default (newline) mode AND the send mode.
  static let modes: [Bool] = [false, true]

  @Test("every fixture row's iOS action matches ComposerKeyContract in every mode")
  func actionsMatchFixture() {
    for testCase in Self.fixture.cases {
      for returnKeySends in Self.modes {
        let actual = ComposerKeyContract.action(
          key: testCase.key,
          shift: testCase.shift,
          command: testCase.meta,
          returnKeySends: returnKeySends)
        let expected = testCase.expectedAction(returnKeySends: returnKeySends)
        #expect(
          actual.rawValue == expected,
          "\(testCase.name) (returnKeySends=\(returnKeySends)): fixture says iOS should '\(expected)', contract says '\(actual.rawValue)'"
        )
      }
    }
  }

  @Test("every fixture row's iOS mechanism matches ComposerKeyContract in every mode")
  func mechanismsMatchFixture() {
    for testCase in Self.fixture.cases {
      for returnKeySends in Self.modes {
        let expected = testCase.expectedMechanism(returnKeySends: returnKeySends)
        guard let expected else { continue }
        let actual = ComposerKeyContract.mechanism(
          key: testCase.key,
          shift: testCase.shift,
          command: testCase.meta,
          returnKeySends: returnKeySends)
        let actualName = actual?.rawValue ?? "nil"
        #expect(
          actual?.rawValue == expected,
          "\(testCase.name) (returnKeySends=\(returnKeySends)): fixture mechanism '\(expected)', contract '\(actualName)'"
        )
      }
    }
  }

  @Test("the historical bug is what this pins: Shift+Return must not send")
  func shiftReturnIsNotSend() {
    // `onSubmit` fired on every Return with no modifier awareness, so a
    // hardware keyboard could not type a newline at all. This is the row.
    #expect(ComposerKeyContract.action(key: "Enter", shift: true, command: false, returnKeySends: false) == .newline)
    #expect(ComposerKeyContract.action(key: "Enter", shift: true, command: false, returnKeySends: true) == .newline)
    #expect(ComposerKeyContract.mechanism(key: "Enter", shift: true, command: false, returnKeySends: false) == .handler)
  }

  @Test("plain Return follows the setting but never overrides Cmd+Return to send")
  func plainReturnFollowsSetting() {
    #expect(ComposerKeyContract.action(key: "Enter", shift: false, command: false, returnKeySends: false) == .newline)
    #expect(ComposerKeyContract.action(key: "Enter", shift: false, command: false, returnKeySends: true) == .send)
    // Cmd+Return is send regardless of the setting.
    #expect(ComposerKeyContract.action(key: "Enter", shift: false, command: true, returnKeySends: false) == .send)
  }

  @Test("plain Tab is left to focus traversal, so the composer is not a trap")
  func plainTabIsFocus() {
    #expect(ComposerKeyContract.action(key: "Tab", shift: false, command: false, returnKeySends: false) == .focus)
  }
}