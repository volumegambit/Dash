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
    let cached = CachedConversation(gatewayID: profile.gatewayID, summary: conversation())
    model.consume(
      SyncSnapshot(
        connection: .online,
        conversations: [cached],
        agents: [agent()],
        lastSuccessfulSyncAt: Date(timeIntervalSince1970: 100)
      )
    )

    let disconnect = Task { try await model.disconnectAndForget() }
    await shutdownGate.waitUntilWaiting()

    #expect(model.route == .paired(tab: .conversations))
    #expect(model.selectedProfile == profile)
    #expect(model.snapshot?.conversations == [cached])
    #expect(model.snapshot?.mutationsAllowed == false)
    #expect(model.connectionState == .connecting)

    await shutdownGate.release()
    try await disconnect.value

    #expect(model.route == .connect)
    #expect(model.selectedProfile == nil)
    #expect(await engine.shutdownCallCount == 1)
  }

  @Test("failed profile replacement does not reuse the torn-down sync engine")
  func failedProfileReplacementKeepsMatchingState() async {
    let engine = FakeAppSyncEngine()
    let original = connectionProfile()
    let replacement = replacementProfile()
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
        }
      )
    )
    await model.start()
    let cached = CachedConversation(gatewayID: original.gatewayID, summary: conversation())
    model.consume(
      SyncSnapshot(
        connection: .online,
        conversations: [cached],
        agents: [],
        lastSuccessfulSyncAt: Date(timeIntervalSince1970: 100)
      )
    )

    await model.installPairedProfile(replacement)
    await model.sceneDidEnterBackground()

    #expect(model.selectedProfile == original)
    #expect(model.snapshot?.conversations == [cached])
    #expect(model.connectionState == .online)
    #expect(await engine.shutdownCallCount == 0)
    #expect(await engine.backgroundCallCount == 1)
  }

  @Test("a restored activation cannot overwrite a newer installed profile")
  func staleStartActivationIsDiscarded() async {
    let original = connectionProfile()
    let replacement = replacementProfile()
    let originalEngine = FakeAppSyncEngine()
    let replacementEngine = FakeAppSyncEngine()
    let originalCreation = TestGate()
    let clock = TestAppClock(now: Date(timeIntervalSince1970: 100))
    let model = AppModel(
      dependencies: AppDependencies(
        clock: clock,
        loadProfile: { original },
        makeSyncEngine: { profile in
          if profile == original {
            await originalCreation.wait()
            return originalEngine
          }
          return replacementEngine
        }
      )
    )

    let start = Task { await model.start() }
    await originalCreation.waitUntilWaiting()
    await model.installPairedProfile(replacement)
    await originalCreation.release()
    await start.value

    #expect(model.selectedProfile == replacement)
    #expect(model.route == .paired(tab: .conversations))
    #expect(await replacementEngine.bootstrapCallCount == 1)
    #expect(await originalEngine.bootstrapCallCount == 0)
    #expect(await originalEngine.shutdownCallCount == 1)
  }

  @Test("disconnect invalidates an installed profile still creating its engine")
  func disconnectInvalidatesPendingInstall() async throws {
    let original = connectionProfile()
    let replacement = replacementProfile()
    let originalEngine = FakeAppSyncEngine()
    let replacementEngine = FakeAppSyncEngine()
    let replacementCreation = TestGate()
    let clock = TestAppClock(now: Date(timeIntervalSince1970: 100))
    let model = AppModel(
      dependencies: AppDependencies(
        clock: clock,
        loadProfile: { original },
        makeSyncEngine: { profile in
          if profile == replacement {
            await replacementCreation.wait()
            return replacementEngine
          }
          return originalEngine
        }
      )
    )
    await model.start()

    let install = Task { await model.installPairedProfile(replacement) }
    await replacementCreation.waitUntilWaiting()
    try await model.disconnectAndForget()
    await replacementCreation.release()
    await install.value

    #expect(model.route == .connect)
    #expect(model.selectedProfile == nil)
    #expect(await replacementEngine.bootstrapCallCount == 0)
    #expect(await replacementEngine.shutdownCallCount == 1)
  }

  @Test("a pairing attempt cannot interrupt an active disconnect")
  func installDuringDisconnectDoesNotStrandTeardown() async throws {
    let shutdownGate = TestGate()
    let engine = FakeAppSyncEngine(shutdownGate: shutdownGate)
    let profile = connectionProfile()
    let model = AppModel(dependencies: dependencies(profile: profile, engine: engine))
    await model.start()

    let disconnect = Task { try await model.disconnectAndForget() }
    await shutdownGate.waitUntilWaiting()

    await model.installPairedProfile(replacementProfile())
    await shutdownGate.release()
    try await disconnect.value

    #expect(model.route == .connect)
    #expect(model.selectedProfile == nil)
    #expect(model.banner == nil)
    #expect(await engine.shutdownCallCount == 1)
  }

  @Test("background intent reaches an engine created after the transition")
  func backgroundDuringEngineCreationDefersBootstrap() async {
    let engine = FakeAppSyncEngine()
    let creation = TestGate()
    let profile = connectionProfile()
    let clock = TestAppClock(now: Date(timeIntervalSince1970: 100))
    let model = AppModel(
      dependencies: AppDependencies(
        clock: clock,
        loadProfile: { profile },
        makeSyncEngine: { _ in
          await creation.wait()
          return engine
        }
      )
    )

    let start = Task { await model.start() }
    await creation.waitUntilWaiting()
    await model.sceneDidEnterBackground()
    await creation.release()
    await start.value

    #expect(await engine.events == [.background])

    await model.sceneWillEnterForeground()

    #expect(await engine.events == [.background, .bootstrap, .foreground])
  }

  @Test("foreground intent is replayed when bootstrap spans a background cycle")
  func foregroundDuringBootstrapIsReplayed() async {
    let bootstrapGate = TestGate()
    let engine = FakeAppSyncEngine(bootstrapGate: bootstrapGate)
    let profile = connectionProfile()
    let model = AppModel(dependencies: dependencies(profile: profile, engine: engine))

    let start = Task { await model.start() }
    await bootstrapGate.waitUntilWaiting()

    await model.sceneDidEnterBackground()
    await model.sceneWillEnterForeground()

    await bootstrapGate.release()
    await start.value

    #expect(await engine.events == [.bootstrap, .background, .bootstrap, .foreground])
  }

  @Test("foreground reconciliation follows a bootstrap interrupted in background")
  func foregroundAfterInterruptedBootstrapReconciles() async {
    let bootstrapGate = TestGate()
    let engine = FakeAppSyncEngine(bootstrapGate: bootstrapGate)
    let profile = connectionProfile()
    let model = AppModel(dependencies: dependencies(profile: profile, engine: engine))

    let start = Task { await model.start() }
    await bootstrapGate.waitUntilWaiting()
    await model.sceneDidEnterBackground()
    await bootstrapGate.release()
    await start.value

    await model.sceneWillEnterForeground()

    #expect(await engine.events == [.bootstrap, .background, .bootstrap, .foreground])
  }

  @Test("Keychain forget failure retains matching cache in a non-writable repair state")
  func keychainForgetFailureIsRetryableAndOrdered() async throws {
    let engine = FakeAppSyncEngine()
    let profile = connectionProfile()
    let forget = FakeForgetPipeline(deleteFailureCount: 1)
    let clock = TestAppClock(now: Date(timeIntervalSince1970: 100))
    let model = AppModel(
      dependencies: AppDependencies(
        clock: clock,
        loadProfile: { profile },
        makeSyncEngine: { _ in engine },
        deleteProfileSecrets: { profile in
          try await forget.deleteSecrets(profile)
        },
        clearProfileData: { profile in
          try await forget.clearData(profile)
        },
        forgetProfileSelection: { _ in }
      )
    )
    await model.start()
    let cached = CachedConversation(gatewayID: profile.gatewayID, summary: conversation())
    model.consume(
      SyncSnapshot(
        connection: .online,
        conversations: [cached],
        agents: [],
        lastSuccessfulSyncAt: Date(timeIntervalSince1970: 100)
      )
    )

    do {
      try await model.disconnectAndForget()
      Issue.record("Expected the first Keychain-delete attempt to fail")
    } catch {
      #expect(error is TestAppDependencyError)
    }

    #expect(model.selectedProfile == profile)
    #expect(model.snapshot?.conversations == [cached])
    #expect(model.snapshot?.mutationsAllowed == false)
    #expect(model.connectionState == .repairRequired)
    #expect(model.banner == .repairRequired)
    #expect(await forget.calls == [.deleteSecrets])

    try await model.disconnectAndForget()

    #expect(model.route == .connect)
    #expect(await forget.calls == [.deleteSecrets, .deleteSecrets, .clearData])
  }

  @Test("cache purge failure after Keychain deletion clears the unusable profile")
  func cachePurgeFailureClearsProfile() async throws {
    let engine = FakeAppSyncEngine()
    let profile = connectionProfile()
    let forget = FakeForgetPipeline(clearFailureCount: 1)
    let model = AppModel(
      dependencies: AppDependencies(
        clock: TestAppClock(now: Date(timeIntervalSince1970: 100)),
        loadProfile: { profile },
        makeSyncEngine: { _ in engine },
        deleteProfileSecrets: { profile in
          try await forget.deleteSecrets(profile)
        },
        clearProfileData: { profile in
          try await forget.clearData(profile)
        },
        forgetProfileSelection: { _ in }
      )
    )
    await model.start()
    model.consume(
      SyncSnapshot(
        connection: .online,
        conversations: [CachedConversation(gatewayID: profile.gatewayID, summary: conversation())],
        agents: [agent()],
        lastSuccessfulSyncAt: Date(timeIntervalSince1970: 100)
      )
    )

    do {
      try await model.disconnectAndForget()
      Issue.record("Expected the cache-purge attempt to fail")
    } catch {
      #expect(error is TestAppDependencyError)
    }

    #expect(model.route == .connect)
    #expect(model.selectedProfile == nil)
    #expect(model.snapshot == nil)
    #expect(model.banner == .failed("Dash couldn't remove all local gateway data."))
    #expect(await forget.calls == [.deleteSecrets, .clearData])
  }

  @Test("persistent profile selection clears before cache purge can suspend")
  func persistentSelectionClearsBeforeCachePurge() async throws {
    let engine = FakeAppSyncEngine()
    let profile = connectionProfile()
    let purgeGate = TestGate()
    var selectionForgotten = false
    let model = AppModel(
      dependencies: AppDependencies(
        clock: TestAppClock(now: Date(timeIntervalSince1970: 100)),
        loadProfile: { profile },
        makeSyncEngine: { _ in engine },
        deleteProfileSecrets: { _ in },
        clearProfileData: { _ in
          let selectionWasForgotten = await MainActor.run { selectionForgotten }
          #expect(selectionWasForgotten)
          await purgeGate.wait()
        },
        forgetProfileSelection: { _ in selectionForgotten = true }
      )
    )
    await model.start()

    let disconnect = Task { try await model.disconnectAndForget() }
    await purgeGate.waitUntilWaiting()

    #expect(selectionForgotten)
    #expect(model.selectedProfile == profile)
    #expect(model.connectionState == .connecting)

    await purgeGate.release()
    try await disconnect.value

    #expect(model.route == .connect)
  }

  @Test("dependency composition failure can be retried without terminating")
  func startupCompositionFailureCanRetry() {
    var attempts = 0
    let engine = FakeAppSyncEngine()
    let bootstrap = AppLaunch(
      factory: AppDependenciesFactory {
        attempts += 1
        guard attempts > 1 else { throw TestAppDependencyError.unavailable }
        return dependencies(profile: nil, engine: engine)
      }
    )

    #expect(bootstrap.appModel == nil)
    #expect(bootstrap.errorMessage != nil)
    #expect(attempts == 1)

    bootstrap.retry()

    #expect(bootstrap.appModel != nil)
    #expect(bootstrap.errorMessage == nil)
    #expect(attempts == 2)
  }

  @Test("a current profile and cached snapshot publish before bootstrap finishes")
  func cacheIsVisibleWhileBootstrapIsPending() async {
    let profile = connectionProfile()
    let cached = CachedConversation(gatewayID: profile.gatewayID, summary: conversation())
    let bootstrapGate = TestGate()
    let engine = FakeAppSyncEngine(
      bootstrapGate: bootstrapGate,
      initialSnapshots: [
        SyncSnapshot(
          connection: .connecting,
          conversations: [cached],
          agents: [],
          lastSuccessfulSyncAt: Date(timeIntervalSince1970: 100)
        )
      ]
    )
    let model = AppModel(dependencies: dependencies(profile: profile, engine: engine))

    let start = Task { await model.start() }
    await bootstrapGate.waitUntilWaiting()
    for _ in 0..<5 { await Task.yield() }

    #expect(model.selectedProfile == profile)
    #expect(model.route == .paired(tab: .conversations))
    #expect(model.snapshot?.conversations == [cached])

    await bootstrapGate.release()
    await start.value
  }

  @Test("switching gateways clears old data and compact and split detail routes")
  func crossGatewayPublishClearsEntireSnapshot() async {
    let original = connectionProfile()
    let replacement = replacementProfile()
    let originalEngine = FakeAppSyncEngine()
    let replacementEngine = FakeAppSyncEngine()
    let model = AppModel(
      dependencies: AppDependencies(
        clock: TestAppClock(now: Date(timeIntervalSince1970: 100)),
        loadProfile: { original },
        makeSyncEngine: { profile in
          profile == original ? originalEngine : replacementEngine
        }
      )
    )
    await model.start()
    model.consume(
      SyncSnapshot(
        connection: .online,
        conversations: [],
        agents: [agent()],
        lastSuccessfulSyncAt: Date(timeIntervalSince1970: 100)
      )
    )
    model.conversationPath = [.transcript("old-compact-conversation")]
    model.agentPath = [.detail("old-compact-agent")]
    model.splitConversationSelection = .transcript("old-split-conversation")

    await model.installPairedProfile(replacement)

    #expect(model.selectedProfile == replacement)
    #expect(model.snapshot == nil)
    #expect(model.connectionState == .connecting)
    #expect(model.conversationPath.isEmpty)
    #expect(model.agentPath.isEmpty)
    #expect(model.splitConversationSelection == nil)
  }

  @Test("same-gateway replacement keeps cache visible but non-writable until bootstrap")
  func sameGatewayReplacementDowngradesCachedState() async {
    let original = connectionProfile()
    let replacement = replacementProfile(gatewayID: original.gatewayID)
    let originalEngine = FakeAppSyncEngine()
    let bootstrapGate = TestGate()
    let replacementEngine = FakeAppSyncEngine(bootstrapGate: bootstrapGate)
    let model = AppModel(
      dependencies: AppDependencies(
        clock: TestAppClock(now: Date(timeIntervalSince1970: 100)),
        loadProfile: { original },
        makeSyncEngine: { profile in
          profile == original ? originalEngine : replacementEngine
        }
      )
    )
    await model.start()
    let cached = CachedConversation(gatewayID: original.gatewayID, summary: conversation())
    model.consume(
      SyncSnapshot(
        connection: .online,
        conversations: [cached],
        agents: [agent()],
        lastSuccessfulSyncAt: Date(timeIntervalSince1970: 100)
      )
    )

    let install = Task { await model.installPairedProfile(replacement) }
    await bootstrapGate.waitUntilWaiting()

    #expect(model.selectedProfile == replacement)
    #expect(model.snapshot?.conversations == [cached])
    #expect(model.snapshot?.agents == [agent()])
    #expect(model.snapshot?.mutationsAllowed == false)
    #expect(model.connectionState == .connecting)

    await bootstrapGate.release()
    await install.value
  }

  private func dependencies(
    profile: ConnectionProfileSnapshot?,
    engine: FakeAppSyncEngine
  ) -> AppDependencies {
    let clock = TestAppClock(now: Date(timeIntervalSince1970: 100))
    return AppDependencies(
      clock: clock,
      loadProfile: { profile },
      makeSyncEngine: { _ in engine }
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

  private func replacementProfile(gatewayID: String = "gateway-2") -> ConnectionProfileSnapshot {
    ConnectionProfileSnapshot(
      gatewayID: gatewayID,
      profile: ConnectionProfile(
        id: UUID(uuidString: "11111111-2222-3333-4444-555555555555")!,
        gatewayId: gatewayID,
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

  private func agent() -> RegisteredAgentDTO {
    RegisteredAgentDTO(
      id: "agent-old",
      name: "Old agent",
      config: AgentConfigDTO(
        name: "Old agent",
        model: "test/model",
        systemPrompt: "",
        fallbackModels: nil,
        tools: nil,
        skills: nil,
        workspace: nil,
        maxTokens: nil,
        mcpServers: nil,
        swarm: nil,
        plugins: nil,
        providers: nil
      ),
      status: .registered,
      registeredAt: Date(timeIntervalSince1970: 10)
    )
  }
}

private actor FakeAppSyncEngine: AppSyncing {
  enum Event: Equatable, Sendable {
    case bootstrap
    case background
    case foreground
    case shutdown
  }

  private(set) var bootstrapCallCount = 0
  private(set) var backgroundCallCount = 0
  private(set) var shutdownCallCount = 0
  private(set) var events: [Event] = []
  private let shutdownGate: TestGate?
  private let bootstrapGate: TestGate?
  private let initialSnapshots: [SyncSnapshot]

  init(
    shutdownGate: TestGate? = nil,
    bootstrapGate: TestGate? = nil,
    initialSnapshots: [SyncSnapshot] = []
  ) {
    self.shutdownGate = shutdownGate
    self.bootstrapGate = bootstrapGate
    self.initialSnapshots = initialSnapshots
  }

  func snapshots() -> AsyncStream<SyncSnapshot> {
    AsyncStream { continuation in
      for snapshot in initialSnapshots {
        continuation.yield(snapshot)
      }
      continuation.finish()
    }
  }

  func bootstrap() async {
    bootstrapCallCount += 1
    events.append(.bootstrap)
    await bootstrapGate?.wait()
  }

  func sceneDidEnterBackground() async {
    backgroundCallCount += 1
    events.append(.background)
  }

  func sceneWillEnterForeground() async {
    events.append(.foreground)
  }

  func shutdown() async {
    shutdownCallCount += 1
    events.append(.shutdown)
    await shutdownGate?.wait()
  }
}

private actor FakeForgetPipeline {
  enum Call: Equatable, Sendable {
    case deleteSecrets
    case clearData
  }

  private var deleteFailureCount: Int
  private var clearFailureCount: Int
  private(set) var calls: [Call] = []

  init(deleteFailureCount: Int = 0, clearFailureCount: Int = 0) {
    self.deleteFailureCount = deleteFailureCount
    self.clearFailureCount = clearFailureCount
  }

  func deleteSecrets(_ profile: ConnectionProfileSnapshot) throws {
    _ = profile
    calls.append(.deleteSecrets)
    guard deleteFailureCount > 0 else { return }
    deleteFailureCount -= 1
    throw TestAppDependencyError.unavailable
  }

  func clearData(_ profile: ConnectionProfileSnapshot) throws {
    _ = profile
    calls.append(.clearData)
    guard clearFailureCount > 0 else { return }
    clearFailureCount -= 1
    throw TestAppDependencyError.unavailable
  }
}

private enum TestAppDependencyError: Error {
  case unavailable
}
