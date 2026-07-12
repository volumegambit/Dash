import Testing
@testable import Dash

@Suite("Project scaffold")
struct ProjectSmokeTests {
  @Test("root title is stable")
  @MainActor
  func rootTitle() {
    #expect(RootView.title == "Dash")
  }
}
