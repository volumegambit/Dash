import Foundation
import Testing

@testable import Dash

/// Cross-checks `ComposerKeyContract` against the `ios` column of
/// `scripts/fixtures/composer-key-contract.json` — the same file
/// `apps/web/src/ui/ChatView.test.tsx` generates its tests from.
///
/// The fixture is the single source of truth for what each key does in the
/// composer on each client. It deliberately allows the clients to differ
/// where the platform demands it (Return is a newline here and a send on web
/// and Mission Control); what it forbids is UNINTENDED divergence. Changing
/// this app's behaviour without the fixture, or the fixture without this
/// app, fails here.
///
/// Loads the file by walking up from `#filePath` rather than from a bundle
/// resource — the same approach `RenderingParityTests` uses for
/// `rendering-fixtures.json`, so no target membership is involved.
@Suite("Composer key contract (cross-client)")
struct ComposerKeyContractTests {

  private struct Fixture: Decodable {
    let cases: [Case]
  }

  private struct Case: Decodable {
    let name: String
    let key: String
    let shift: Bool
    let meta: Bool
    let ios: String
    let mechanism: Mechanisms?

    struct Mechanisms: Decodable {
      let ios: String
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

  @Test("every fixture row's iOS action matches ComposerKeyContract")
  func actionsMatchFixture() {
    for testCase in Self.fixture.cases {
      let actual = ComposerKeyContract.action(
        key: testCase.key, shift: testCase.shift, command: testCase.meta)
      #expect(
        actual.rawValue == testCase.ios,
        "\(testCase.name): fixture says iOS should '\(testCase.ios)', contract says '\(actual.rawValue)'"
      )
    }
  }

  @Test("every fixture row's iOS mechanism matches ComposerKeyContract")
  func mechanismsMatchFixture() {
    for testCase in Self.fixture.cases {
      guard let expected = testCase.mechanism?.ios else { continue }
      let actual = ComposerKeyContract.mechanism(
        key: testCase.key, shift: testCase.shift, command: testCase.meta)
      let actualName = actual?.rawValue ?? "nil"
      #expect(
        actual?.rawValue == expected,
        "\(testCase.name): fixture mechanism '\(expected)', contract '\(actualName)'"
      )
    }
  }

  @Test("the historical bug is what this pins: Shift+Return must not send")
  func shiftReturnIsNotSend() {
    // `onSubmit` fired on every Return with no modifier awareness, so a
    // hardware keyboard could not type a newline at all. This is the row.
    #expect(ComposerKeyContract.action(key: "Enter", shift: true, command: false) == .newline)
    #expect(ComposerKeyContract.mechanism(key: "Enter", shift: true, command: false) == .native)
  }

  @Test("plain Tab is left to focus traversal, so the composer is not a trap")
  func plainTabIsFocus() {
    #expect(ComposerKeyContract.action(key: "Tab", shift: false, command: false) == .focus)
  }
}
