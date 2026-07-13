import Foundation
import Observation

protocol AppSyncing: Actor {
  func snapshots() -> AsyncStream<SyncSnapshot>
  func bootstrap() async
  func sceneDidEnterBackground() async
  func sceneWillEnterForeground() async
  func shutdown() async
}

extension ConversationSyncEngine: AppSyncing {}

@MainActor
@Observable
final class AppModel {
  var selectedProfile: ConnectionProfileSnapshot?
  var connectionState: GatewayConnectionState = .connecting
  var selectedTab: AppTab = .conversations
  var pairingPath: [PairingRoute] = []
  var conversationPath: [ConversationRoute] = []
  var agentPath: [AgentRoute] = []
  var splitConversationSelection: ConversationRoute?
  var banner: AppBanner?
  var snapshot: SyncSnapshot?

  var route: AppRoute {
    guard selectedProfile != nil else { return .connect }
    return .paired(tab: selectedTab)
  }

  @ObservationIgnored private let dependencies: AppDependencies
  @ObservationIgnored private var syncEngine: (any AppSyncing)?
  @ObservationIgnored private var snapshotTask: Task<Void, Never>?
  @ObservationIgnored private var transitionEpoch: UInt64 = 0
  @ObservationIgnored private var activeEpoch: UInt64 = 0
  @ObservationIgnored private var activeEngineBootstrapped = false
  @ObservationIgnored private var activeEngineLifecycleStarted = false
  @ObservationIgnored private var activeEngineNeedsForegroundResume = false
  @ObservationIgnored private var activeEngineSuspended = false
  @ObservationIgnored private var activeEngineSuspensionStarted = false
  @ObservationIgnored private var activeEngineSceneRevision: UInt64 = 0
  @ObservationIgnored private var isBackgrounded = false
  @ObservationIgnored private var isDisconnecting = false

  private struct PreparedActivation {
    let engine: any AppSyncing
    let snapshots: AsyncStream<SyncSnapshot>
  }

  init(dependencies: AppDependencies) {
    self.dependencies = dependencies
  }

  func start() async {
    guard selectedProfile == nil, syncEngine == nil else { return }
    let epoch = beginTransition()
    do {
      let profile = try await dependencies.loadProfile()
      guard isCurrent(epoch) else { return }
      guard let profile else {
        resetToConnect()
        return
      }
      guard let prepared = try await prepareActivation(profile, epoch: epoch) else { return }
      let retired = publish(profile, prepared: prepared)
      let publishedEpoch = activeEpoch
      if let retired, sameEngine(retired, prepared.engine) == false {
        await retired.shutdown()
        guard activeEpoch == publishedEpoch, sameEngine(syncEngine, prepared.engine) else { return }
      }
      await startPreparedEngine(prepared.engine, activeEpoch: publishedEpoch)
    } catch {
      guard isCurrent(epoch) else { return }
      banner = .failed(error.localizedDescription)
    }
  }

  func installPairedProfile(_ profile: ConnectionProfileSnapshot) async {
    guard isDisconnecting == false else { return }
    let epoch = beginTransition()
    do {
      guard let prepared = try await prepareActivation(profile, epoch: epoch) else { return }
      guard isCurrent(epoch) else {
        await prepared.engine.shutdown()
        return
      }
      dependencies.rememberProfile(profile)
      let retired = publish(profile, prepared: prepared)
      let publishedEpoch = activeEpoch
      if let retired, sameEngine(retired, prepared.engine) == false {
        await retired.shutdown()
        guard activeEpoch == publishedEpoch, sameEngine(syncEngine, prepared.engine) else { return }
      }
      await startPreparedEngine(prepared.engine, activeEpoch: publishedEpoch)
    } catch {
      guard isCurrent(epoch) else { return }
      banner = .failed(error.localizedDescription)
    }
  }

  func consume(_ snapshot: SyncSnapshot) {
    self.snapshot = snapshot
    connectionState = snapshot.connection
    switch snapshot.connection {
    case .connecting, .online:
      banner = nil
    case .reconnecting, .offline:
      banner = .offline
    case .gatewayOffline:
      banner = .gatewayOffline
    case .rateLimited(let retryAt):
      banner = .rateLimited(retryAt: retryAt)
    case .repairRequired:
      banner = .repairRequired
    case .updateRequired:
      banner = .updateRequired
    }
  }

  func openConversation(_ id: String, presentation: NavigationPresentation) {
    selectedTab = .conversations
    let destination = ConversationRoute.transcript(id)
    switch presentation {
    case .compact:
      conversationPath.append(destination)
    case .regular:
      conversationPath.removeAll()
      splitConversationSelection = destination
    }
  }

  func sceneDidEnterBackground() async {
    isBackgrounded = true
    activeEngineSceneRevision &+= 1
    guard let engine = syncEngine else { return }
    let epoch = activeEpoch
    activeEngineNeedsForegroundResume = true
    await suspendEngineIfNeeded(engine, activeEpoch: epoch)
  }

  func sceneWillEnterForeground() async {
    isBackgrounded = false
    activeEngineSceneRevision &+= 1
    activeEngineSuspended = false
    guard let engine = syncEngine else { return }
    let epoch = activeEpoch
    await driveEngineToCurrentScene(engine, activeEpoch: epoch)
  }

  func disconnectAndForget() async throws {
    guard let profile = selectedProfile, isDisconnecting == false else { return }
    isDisconnecting = true
    defer { isDisconnecting = false }
    let epoch = beginTransition()
    let retired = detachActiveEngine()
    markCachedConnection(.connecting)
    if let retired {
      await retired.shutdown()
      guard isCurrent(epoch) else { return }
    }
    do {
      try await dependencies.deleteProfileSecrets(profile)
      guard isCurrent(epoch) else { return }
    } catch {
      guard isCurrent(epoch) else { return }
      markForgetFailure(for: profile)
      throw error
    }
    dependencies.forgetProfileSelection(profile)
    do {
      try await dependencies.clearProfileData(profile)
      guard isCurrent(epoch) else { return }
    } catch {
      guard isCurrent(epoch) else { return }
      resetToConnect()
      banner = .failed("Dash couldn't remove all local gateway data.")
      throw error
    }
    resetToConnect()
  }

  private func prepareActivation(
    _ profile: ConnectionProfileSnapshot,
    epoch: UInt64
  ) async throws -> PreparedActivation? {
    let engine = try await dependencies.makeSyncEngine(profile)
    guard isCurrent(epoch) else {
      await engine.shutdown()
      return nil
    }

    let snapshots = await engine.snapshots()
    guard isCurrent(epoch) else {
      await engine.shutdown()
      return nil
    }

    return PreparedActivation(engine: engine, snapshots: snapshots)
  }

  private func startPreparedEngine(_ engine: any AppSyncing, activeEpoch: UInt64) async {
    guard self.activeEpoch == activeEpoch, sameEngine(syncEngine, engine) else { return }
    if isBackgrounded {
      activeEngineNeedsForegroundResume = true
      await suspendEngineIfNeeded(engine, activeEpoch: activeEpoch)
      return
    }
    await driveEngineToCurrentScene(engine, activeEpoch: activeEpoch)
  }

  private func suspendEngineIfNeeded(_ engine: any AppSyncing, activeEpoch: UInt64) async {
    guard
      self.activeEpoch == activeEpoch,
      sameEngine(syncEngine, engine),
      activeEngineSuspended == false,
      activeEngineSuspensionStarted == false
    else { return }
    activeEngineSuspended = true
    activeEngineSuspensionStarted = true
    await engine.sceneDidEnterBackground()
    guard self.activeEpoch == activeEpoch, sameEngine(syncEngine, engine) else { return }
    activeEngineSuspensionStarted = false
    if isBackgrounded == false {
      activeEngineSuspended = false
      await driveEngineToCurrentScene(engine, activeEpoch: activeEpoch)
    }
  }

  private func driveEngineToCurrentScene(_ engine: any AppSyncing, activeEpoch: UInt64) async {
    guard
      self.activeEpoch == activeEpoch,
      sameEngine(syncEngine, engine),
      isBackgrounded == false,
      activeEngineLifecycleStarted == false,
      activeEngineSuspensionStarted == false
    else { return }
    activeEngineLifecycleStarted = true
    defer {
      if self.activeEpoch == activeEpoch, sameEngine(syncEngine, engine) {
        activeEngineLifecycleStarted = false
      }
    }

    while isBackgrounded == false {
      if activeEngineBootstrapped == false {
        let revision = activeEngineSceneRevision
        await engine.bootstrap()
        guard self.activeEpoch == activeEpoch, sameEngine(syncEngine, engine) else { return }
        guard isBackgrounded == false else { continue }
        if activeEngineSceneRevision == revision {
          activeEngineBootstrapped = true
        }
        continue
      }

      guard activeEngineNeedsForegroundResume else { return }
      let revision = activeEngineSceneRevision
      await engine.sceneWillEnterForeground()
      guard self.activeEpoch == activeEpoch, sameEngine(syncEngine, engine) else { return }
      guard isBackgrounded == false else { continue }
      if activeEngineSceneRevision == revision {
        activeEngineNeedsForegroundResume = false
        return
      }
    }
  }

  @discardableResult
  private func publish(
    _ profile: ConnectionProfileSnapshot,
    prepared: PreparedActivation
  ) -> (any AppSyncing)? {
    let retired = syncEngine
    let previousGatewayID = selectedProfile?.gatewayID
    snapshotTask?.cancel()
    activeEpoch &+= 1
    let epoch = activeEpoch
    syncEngine = prepared.engine
    activeEngineBootstrapped = false
    activeEngineLifecycleStarted = false
    activeEngineNeedsForegroundResume = false
    activeEngineSuspended = false
    activeEngineSuspensionStarted = false
    selectedProfile = profile
    selectedTab = .conversations
    pairingPath.removeAll()
    if previousGatewayID != nil, previousGatewayID != profile.gatewayID {
      snapshot = nil
      connectionState = .connecting
    } else {
      markCachedConnection(.connecting)
    }
    banner = nil
    snapshotTask = Task { [weak self] in
      for await value in prepared.snapshots {
        guard Task.isCancelled == false else { return }
        guard let self, self.activeEpoch == epoch else { return }
        self.consume(value)
      }
    }
    return retired
  }

  private func detachActiveEngine() -> (any AppSyncing)? {
    let retired = syncEngine
    snapshotTask?.cancel()
    snapshotTask = nil
    syncEngine = nil
    activeEngineBootstrapped = false
    activeEngineLifecycleStarted = false
    activeEngineNeedsForegroundResume = false
    activeEngineSuspended = false
    activeEngineSuspensionStarted = false
    activeEpoch &+= 1
    return retired
  }

  private func markForgetFailure(for profile: ConnectionProfileSnapshot) {
    connectionState = .repairRequired
    if let snapshot,
      snapshot.conversations.allSatisfy({ $0.gatewayID == profile.gatewayID })
    {
      self.snapshot = SyncSnapshot(
        connection: .repairRequired,
        conversations: snapshot.conversations,
        agents: snapshot.agents,
        lastSuccessfulSyncAt: snapshot.lastSuccessfulSyncAt
      )
    } else {
      snapshot = nil
    }
    banner = .repairRequired
  }

  private func markCachedConnection(_ connection: GatewayConnectionState) {
    connectionState = connection
    guard let snapshot else { return }
    self.snapshot = SyncSnapshot(
      connection: connection,
      conversations: snapshot.conversations,
      agents: snapshot.agents,
      lastSuccessfulSyncAt: snapshot.lastSuccessfulSyncAt
    )
  }

  private func beginTransition() -> UInt64 {
    transitionEpoch &+= 1
    return transitionEpoch
  }

  private func isCurrent(_ epoch: UInt64) -> Bool {
    transitionEpoch == epoch
  }

  private func sameEngine(_ lhs: (any AppSyncing)?, _ rhs: any AppSyncing) -> Bool {
    guard let lhs else { return false }
    return ObjectIdentifier(lhs as AnyObject) == ObjectIdentifier(rhs as AnyObject)
  }

  private func resetToConnect() {
    _ = detachActiveEngine()
    selectedProfile = nil
    connectionState = .connecting
    selectedTab = .conversations
    pairingPath.removeAll()
    conversationPath.removeAll()
    agentPath.removeAll()
    splitConversationSelection = nil
    snapshot = nil
    banner = nil
  }
}
