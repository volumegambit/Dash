import Foundation
import Testing

@testable import Dash

@Suite("App model")
@MainActor
struct AppModelTests {
  @Test("cold start without a saved profile opens Connect")
  func coldStartRoutesToConnect() async {
    let engine = FakeAppSyncEngine()
    let model = AppModel(dependencies: dependencies(profile: nil, engine: engine))

    await model.start()

    #expect(model.route == .connect)
    #expect(await engine.bootstrapCallCount == 0)
  }

  @Test("restored profile opens Conversations and bootstraps cached state")
  func restoredProfileBootstrapsSync() async {
    let engine = FakeAppSyncEngine()
    let profile = connectionProfile()
    let model = AppModel(dependencies: dependencies(profile: profile, engine: engine))

    await model.start()

    #expect(model.route == .paired(tab: .conversations))
    #expect(model.selectedProfile == profile)
    #expect(await engine.bootstrapCallCount == 1)
  }

  @Test("authorization loss asks for re-pairing without hiding cached content")
  func unauthorizedKeepsCachedContentVisible() async {
    let engine = FakeAppSyncEngine()
    let profile = connectionProfile()
    let model = AppModel(dependencies: dependencies(profile: profile, engine: engine))
    await model.start()
    let cached = CachedConversation(gatewayID: profile.gatewayID, summary: conversation())

    model.consume(
      SyncSnapshot(
        connection: .repairRequired,
        conversations: [cached],
        agents: [],
        lastSuccessfulSyncAt: Date(timeIntervalSince1970: 100)
      )
    )

    #expect(model.route == .paired(tab: .conversations))
    #expect(model.snapshot?.conversations == [cached])
    #expect(model.banner == .repairRequired)
  }

  @Test("opening a deep conversation in regular width selects the split detail")
  func deepConversationSelectsSplitDetail() {
    let model = AppModel(
      dependencies: dependencies(profile: nil, engine: FakeAppSyncEngine())
    )

    model.openConversation("conversation-deep", presentation: .regular)

    #expect(model.selectedTab == .conversations)
    #expect(model.splitConversationSelection == .transcript("conversation-deep"))
    #expect(model.conversationPath.isEmpty)
  }

  @Test("disconnect keeps paired content visible until teardown completes")
  func disconnectWaitsForTeardown() async throws {
    let shutdownGate = TestGate()
    let engine = FakeAppSyncEngine(shutdownGate: shutdownGate)
    let profile = connectionProfile()
    let model = AppModel(dependencies: dependencies(profile: profile, engine: engine))
    await model.start()

    let disconnect = Task { try await model.disconnectAndForget() }
    await shutdownGate.waitUntilWaiting()

    #expect(model.route == .paired(tab: .conversations))
    #expect(model.selectedProfile == profile)

    await shutdownGate.release()
    try await disconnect.value

    #expect(model.route == .connect)
    #expect(model.selectedProfile == nil)
    #expect(await engine.shutdownCallCount == 1)
  }

  @Test("failed profile replacement does not reuse the torn-down sync engine")
  func failedProfileReplacementDropsOldEngine() async {
    let engine = FakeAppSyncEngine()
    let original = connectionProfile()
    let replacement = ConnectionProfileSnapshot(
      gatewayID: "gateway-2",
      profile: ConnectionProfile(
        id: UUID(uuidString: "11111111-2222-3333-4444-555555555555")!,
        gatewayId: "gateway-2",
        publicKey: "replacement-public-key",
        label: "Away",
        host: "away.dash.local",
        managementPort: 9300,
        chatPort: 9200,
        secure: false,
        mode: .lan,
        createdAt: Date(timeIntervalSince1970: 20),
        lastSuccessfulSyncAt: nil
      )
    )
    let clock = TestAppClock(now: Date(timeIntervalSince1970: 100))
    let model = AppModel(
      dependencies: AppDependencies(
        clock: clock,
        loadProfile: { original },
        makeSyncEngine: { profile in
          guard profile.gatewayID != replacement.gatewayID else {
            throw TestAppDependencyError.unavailable
          }
          return engine
        },
        forgetProfile: { _ in }
      )
    )
    await model.start()

    await model.installPairedProfile(replacement)
    await model.sceneDidEnterBackground()

    #expect(model.selectedProfile == replacement)
    #expect(await engine.shutdownCallCount == 1)
    #expect(await engine.backgroundCallCount == 0)
  }

  private func dependencies(
    profile: ConnectionProfileSnapshot?,
    engine: FakeAppSyncEngine
  ) -> AppDependencies {
    let clock = TestAppClock(now: Date(timeIntervalSince1970: 100))
    return AppDependencies(
      clock: clock,
      loadProfile: { profile },
      makeSyncEngine: { _ in engine },
      forgetProfile: { _ in }
    )
  }

  private func connectionProfile() -> ConnectionProfileSnapshot {
    ConnectionProfileSnapshot(
      gatewayID: "gateway-1",
      profile: ConnectionProfile(
        id: UUID(uuidString: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE")!,
        gatewayId: "gateway-1",
        publicKey: "public-key",
        label: "Home",
        host: "dash.local",
        managementPort: 9300,
        chatPort: 9200,
        secure: false,
        mode: .lan,
        createdAt: Date(timeIntervalSince1970: 10),
        lastSuccessfulSyncAt: nil
      )
    )
  }

  private func conversation() -> ConversationSummaryDTO {
    ConversationSummaryDTO(
      id: "conversation-cached",
      agentId: "agent-1",
      agentName: "Dash",
      title: "Cached conversation",
      revision: 1,
      status: .idle,
      activeTurnId: nil,
      owningIssueId: nil,
      projectId: nil,
      lastSeq: 0,
      lastMessagePreview: "Available offline",
      createdAt: Date(timeIntervalSince1970: 20),
      updatedAt: Date(timeIntervalSince1970: 30),
      deletedAt: nil
    )
  }
}

private actor FakeAppSyncEngine: AppSyncing {
  private(set) var bootstrapCallCount = 0
  private(set) var backgroundCallCount = 0
  private(set) var shutdownCallCount = 0
  private let shutdownGate: TestGate?

  init(shutdownGate: TestGate? = nil) {
    self.shutdownGate = shutdownGate
  }

  func snapshots() -> AsyncStream<SyncSnapshot> {
    AsyncStream { continuation in
      continuation.finish()
    }
  }

  func bootstrap() async {
    bootstrapCallCount += 1
  }

  func sceneDidEnterBackground() async {
    backgroundCallCount += 1
  }

  func sceneWillEnterForeground() async {}

  func shutdown() async {
    shutdownCallCount += 1
    await shutdownGate?.wait()
  }
}

private enum TestAppDependencyError: Error {
  case unavailable
}
