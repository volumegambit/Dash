import Foundation
import Testing

@testable import Dash

/// Cross-platform rendering-parity fixtures (Task 5, output-rendering plan).
///
/// `scripts/fixtures/rendering-fixtures.json` (repo root) is the single
/// source of truth for `ToolPresentation.swift` (this file's target) and its
/// web twin, `apps/web/src/ui/blocks/tool-presentation.ts`, asserted against
/// by `apps/web/src/ui/blocks/rendering-parity.test.ts`. Both consumers read
/// the SAME JSON — if this file's expectations and the web test's
/// expectations ever disagree, that's a real behavioral divergence, not a
/// fixture-authoring mistake, because there's only one fixture to author.
///
/// Located via `#filePath`-relative traversal: this file lives at
/// `ios/DashTests/Features/RenderingParityTests.swift`, so four `deletingLastPathComponent()`
/// hops (Features -> DashTests -> ios -> repo root) reach the repo root, then
/// down into `scripts/fixtures/rendering-fixtures.json`. This works because
/// the `Dash` scheme's tests run on the iOS *Simulator*, which executes as a
/// normal macOS process with host filesystem access (unlike a physical
/// device) — no app-sandbox entitlement blocks reading an absolute host
/// path. If that ever stops working, the fallback is bundling the fixture
/// into the test target via `project.yml` resources (see the
/// `ContractFixtures` resource folder wired for `DashTests` as prior art) and
/// reading it through `Bundle`, the same pattern `FixtureLoader.swift` uses
/// for the mobile-contract fixtures.
@Suite("Rendering parity fixtures (cross-platform, shared with apps/web)")
struct RenderingParityTests {

  // MARK: - Fixture loading

  struct FixtureCase: Decodable, Sendable {
    let name: String
    let kind: String
    let toolName: String?
    let input: JSONValue?
    let expectedLabel: String?
    let expectedSummary: String?
    let expectedTruncated: String?
    let expectedDetails: [DetailEntry]?
    /// `null` in the fixture means the tool is still running — no
    /// `tool_result` has arrived — which decodes to `nil` here and is the
    /// literal input `resultSummary` takes. The web consumer maps the same
    /// null to `undefined` for the same reason.
    let resultContent: String?
    let isError: Bool?
    let resultDetails: JSONValue?
    let expectedResultSummary: String?
  }

  struct DetailEntry: Decodable, Equatable, Sendable {
    let key: String
    let value: String
  }

  struct Fixture: Decodable, Sendable {
    let cases: [FixtureCase]
  }

  static let fixture: Fixture = {
    let thisFile = URL(fileURLWithPath: #filePath)
    // thisFile is .../<repo root>/ios/DashTests/Features/RenderingParityTests.swift.
    // The first deletingLastPathComponent() strips the filename itself, landing
    // in Features/; three more hops (DashTests/, ios/, and finally the repo
    // root's own last component) reach the repo root.
    let repoRoot =
      thisFile
      .deletingLastPathComponent()  // RenderingParityTests.swift -> Features/
      .deletingLastPathComponent()  // Features/ -> DashTests/
      .deletingLastPathComponent()  // DashTests/ -> ios/
      .deletingLastPathComponent()  // ios/ -> repo root
    let fixtureURL =
      repoRoot
      .appendingPathComponent("scripts", isDirectory: true)
      .appendingPathComponent("fixtures", isDirectory: true)
      .appendingPathComponent("rendering-fixtures.json", isDirectory: false)
    guard let data = try? Data(contentsOf: fixtureURL) else {
      fatalError("Could not read rendering-fixtures.json at \(fixtureURL.path)")
    }
    guard let decoded = try? JSONDecoder().decode(Fixture.self, from: data) else {
      fatalError("Could not decode rendering-fixtures.json at \(fixtureURL.path)")
    }
    return decoded
  }()

  static var labelCases: [FixtureCase] { fixture.cases.filter { $0.kind == "label" } }
  static var summarizeCases: [FixtureCase] { fixture.cases.filter { $0.kind == "summarize" } }
  static var truncateCases: [FixtureCase] { fixture.cases.filter { $0.kind == "truncate" } }
  static var detailsCases: [FixtureCase] { fixture.cases.filter { $0.kind == "details" } }
  static var resultSummaryCases: [FixtureCase] {
    fixture.cases.filter { $0.kind == "resultSummary" }
  }

  @Test("Fixture loads a non-empty set covering all five case kinds")
  func fixtureLoadsAllKinds() {
    #expect(!Self.fixture.cases.isEmpty)
    #expect(!Self.labelCases.isEmpty)
    #expect(!Self.summarizeCases.isEmpty)
    #expect(!Self.truncateCases.isEmpty)
    #expect(!Self.detailsCases.isEmpty)
    #expect(!Self.resultSummaryCases.isEmpty)
  }

  // MARK: - label

  @Test("label fixture case matches toolLabel", arguments: Self.labelCases)
  func labelMatches(_ c: FixtureCase) {
    #expect(ToolPresentation.toolLabel(c.toolName!) == c.expectedLabel, "\(c.name)")
  }

  // MARK: - summarize

  @Test("summarize fixture case matches ToolPresentation.summarize", arguments: Self.summarizeCases)
  func summarizeMatches(_ c: FixtureCase) {
    // Web's summarize() returns '' for "nothing to show"; the fixture uses
    // null (decoded here as a missing/absent expectedSummary) as the shared
    // "empty" sentinel across platforms, which maps to Swift's `nil`.
    let result = ToolPresentation.summarize(name: c.toolName!, input: c.input)
    #expect(result == c.expectedSummary, "\(c.name)")
  }

  // MARK: - truncate

  @Test("truncate fixture case matches middleTruncate", arguments: Self.truncateCases)
  func truncateMatches(_ c: FixtureCase) {
    guard case let .string(input)? = c.input else {
      Issue.record("truncate fixture case \(c.name) has non-string input")
      return
    }
    #expect(ToolPresentation.middleTruncate(input) == c.expectedTruncated, "\(c.name)")
  }

  // MARK: - resultSummary

  @Test(
    "resultSummary fixture case matches ToolPresentation.resultSummary",
    arguments: Self.resultSummaryCases)
  func resultSummaryMatches(_ c: FixtureCase) {
    let result = ToolPresentation.resultSummary(
      name: c.toolName!, content: c.resultContent, isError: c.isError ?? false,
      details: c.resultDetails)
    #expect(result == c.expectedResultSummary, "\(c.name)")
  }

  // MARK: - details

  // formatDetails/formatVisibleDetails key ORDER is a known acceptable
  // divergence between platforms (JS insertion order vs Swift alphabetical
  // sort — see ToolPresentation.swift's type doc comment). Compare detail
  // rows as a key-sorted list so that divergence can never cause a false
  // failure here.
  private static func sortedByKey(_ details: [ToolPresentation.ToolDetail]) -> [ToolPresentation.ToolDetail] {
    details.sorted { $0.key < $1.key }
  }

  private static func sortedByKey(_ entries: [DetailEntry]) -> [DetailEntry] {
    entries.sorted { $0.key < $1.key }
  }

  @Test("details fixture case matches ToolPresentation.formatDetails", arguments: Self.detailsCases)
  func detailsMatches(_ c: FixtureCase) {
    let result = ToolPresentation.formatDetails(name: c.toolName!, input: c.input)
    let expected = (c.expectedDetails ?? []).map {
      ToolPresentation.ToolDetail(key: $0.key, value: $0.value)
    }
    #expect(Self.sortedByKey(result) == Self.sortedByKey(expected), "\(c.name)")
  }
}
