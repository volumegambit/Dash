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

  init(dependencies: AppDependencies) {
    self.dependencies = dependencies
  }

  func start() async {
    guard selectedProfile == nil, syncEngine == nil else { return }
    do {
      guard let profile = try await dependencies.loadProfile() else {
        resetToConnect()
        return
      }
      try await activate(profile)
    } catch {
      banner = .failed(error.localizedDescription)
    }
  }

  func installPairedProfile(_ profile: ConnectionProfileSnapshot) async {
    await syncEngine?.shutdown()
    syncEngine = nil
    snapshotTask?.cancel()
    snapshotTask = nil
    do {
      await dependencies.rememberProfile(profile)
      try await activate(profile)
    } catch {
      selectedProfile = profile
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
    await syncEngine?.sceneDidEnterBackground()
  }

  func sceneWillEnterForeground() async {
    await syncEngine?.sceneWillEnterForeground()
  }

  func disconnectAndForget() async throws {
    guard let profile = selectedProfile else { return }
    await syncEngine?.shutdown()
    try await dependencies.forgetProfile(profile)
    snapshotTask?.cancel()
    snapshotTask = nil
    syncEngine = nil
    resetToConnect()
  }

  private func activate(_ profile: ConnectionProfileSnapshot) async throws {
    selectedProfile = profile
    selectedTab = .conversations
    pairingPath.removeAll()
    banner = nil
    let engine = try await dependencies.makeSyncEngine(profile)
    syncEngine = engine
    snapshotTask?.cancel()
    let stream = await engine.snapshots()
    snapshotTask = Task { [weak self] in
      for await snapshot in stream {
        guard Task.isCancelled == false else { return }
        self?.consume(snapshot)
      }
    }
    await engine.bootstrap()
  }

  private func resetToConnect() {
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
