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
  var conversationPath: [ConversationRoute] = []
  var agentPath: [AgentRoute] = [] {
    didSet {
      splitAgentSelection = agentPath.last
    }
  }
  var splitConversationSelection: ConversationRoute?
  var splitAgentSelection: AgentRoute?
  var banner: AppBanner?
  var snapshot: SyncSnapshot?
  var conversationListFeature: ConversationListFeature?
  var agentsFeature: AgentsFeature?
  var settingsFeature: SettingsFeature?
  private(set) var chatHostGeneration: UInt64 = 0

  var route: AppRoute {
    guard selectedProfile != nil else { return .connect }
    return .paired(tab: selectedTab)
  }

  @ObservationIgnored private let dependencies: AppDependencies
  @ObservationIgnored private var syncEngine: (any AppSyncing)?
  @ObservationIgnored private var snapshotTask: Task<Void, Never>?
  @ObservationIgnored private var chatFeatures: [String: ChatFeature] = [:]
  @ObservationIgnored private var chatLifecycleByScope: [String: ChatLifecycleState] = [:]
  @ObservationIgnored private var chatRetirementTasks: [String: ChatRetirementRecord] = [:]
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
  /// The most recently minted, not-yet-installed account pairing grant (from
  /// `GatewayPickerView`'s connect attempts this session), tracked so
  /// `signOutOfAccount()` can best-effort revoke an abandoned mint. Cleared
  /// once a connect attempt installs successfully.
  @ObservationIgnored private var lastAccountGrant: (gatewayId: String, pairingId: String)?

  private struct PreparedActivation {
    let engine: any AppSyncing
    let snapshots: AsyncStream<SyncSnapshot>
  }

  private struct ChatLifecycleState: Equatable {
    var generation: UInt64 = 0
    var isRemoved = false
    var revisionFloor: Int?
  }

  private struct ScopedChatFeature {
    let scope: String
    let feature: ChatFeature
  }

  private struct ChatRetirementRecord {
    let id: UUID
    let task: Task<Void, Never>
  }

  private enum CanonicalLifecycleResult {
    case active(ConversationSummaryDTO)
    case removed
    case ignored
  }

  private struct DetachedActivation {
    let engine: (any AppSyncing)?
    let snapshotTask: Task<Void, Never>?
    let conversationFeature: ConversationListFeature?
    let agentsFeature: AgentsFeature?
    let settingsFeature: SettingsFeature?
    let chatFeatures: [ChatFeature]
    let chatRetirementTasks: [Task<Void, Never>]
  }

  /// The tab to land on once a profile is active — `.conversations`,
  /// unless a debug build was launched with an initial-tab override.
  ///
  /// The override has to be re-applied here rather than only in `init`:
  /// profile activation is the last thing to write `selectedTab` during
  /// launch, so an init-time assignment is always overwritten before the
  /// first frame renders.
  private var defaultTabAfterActivation: AppTab {
    #if DEBUG
      if let tab = UITestLaunchOptions.initialTab { return tab }
    #endif
    return .conversations
  }

  #if DEBUG
    /// Opens a conversation named by a launch option, so the chat surface can
    /// be captured without a test runner.
    ///
    /// Sets BOTH navigation states rather than routing through
    /// `openConversation(_:presentation:)`: that needs a
    /// `NavigationPresentation`, which only the view knows, and the whole
    /// point here is to work before any view has laid out. `conversationPath`
    /// drives compact, `splitConversationSelection` drives regular — writing
    /// both means the same launch works on iPhone and iPad.
    private func applyUITestInitialRoute() {
      guard let id = UITestLaunchOptions.initialConversationID else { return }
      let destination = ConversationRoute.transcript(id)
      selectedTab = .conversations
      conversationPath = [destination]
      splitConversationSelection = destination
    }
  #endif

  init(dependencies: AppDependencies) {
    self.dependencies = dependencies
    #if DEBUG
      // Debug-only: lets `simctl launch` open straight onto a given tab so a
      // surface can be captured without a test runner. See
      // `UITestLaunchOptions`.
      if let tab = UITestLaunchOptions.initialTab { selectedTab = tab }
    #endif
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
      if let retiredFeature = retired.settingsFeature,
        retiredFeature !== settingsFeature
      {
        await retiredFeature.shutdown()
      }
      if let retiredFeature = retired.conversationFeature,
        retiredFeature !== conversationListFeature
      {
        await retiredFeature.shutdown()
      }
      if let retiredFeature = retired.agentsFeature,
        retiredFeature !== agentsFeature
      {
        await retiredFeature.shutdown()
      }
      for chatFeature in retired.chatFeatures {
        await chatFeature.shutdown()
      }
      for retirement in retired.chatRetirementTasks {
        await retirement.value
      }
      if let retiredEngine = retired.engine, sameEngine(retiredEngine, prepared.engine) == false {
        await retiredEngine.shutdown()
      }
      await retired.snapshotTask?.value
      guard activeEpoch == publishedEpoch, sameEngine(syncEngine, prepared.engine) else { return }
      await startPreparedEngine(prepared.engine, activeEpoch: publishedEpoch)
    } catch {
      guard isCurrent(epoch) else { return }
      banner = .failed(error.localizedDescription)
    }
  }

  func installPairedProfile(_ profile: ConnectionProfileSnapshot) async {
    _ = await activatePairedProfile(profile)
  }

  private func activatePairedProfile(
    _ profile: ConnectionProfileSnapshot,
    reportsFailureInBanner: Bool = true
  ) async -> Bool {
    guard isDisconnecting == false else { return false }
    if reportsFailureInBanner == false, case .failed = banner {
      banner = nil
    }
    let epoch = beginTransition()
    do {
      guard let prepared = try await prepareActivation(profile, epoch: epoch) else { return false }
      guard isCurrent(epoch) else {
        await prepared.engine.shutdown()
        return false
      }
      dependencies.rememberProfile(profile)
      let retired = publish(profile, prepared: prepared)
      let publishedEpoch = activeEpoch
      if let retiredFeature = retired.settingsFeature,
        retiredFeature !== settingsFeature
      {
        await retiredFeature.shutdown()
      }
      if let retiredFeature = retired.conversationFeature,
        retiredFeature !== conversationListFeature
      {
        await retiredFeature.shutdown()
      }
      if let retiredFeature = retired.agentsFeature,
        retiredFeature !== agentsFeature
      {
        await retiredFeature.shutdown()
      }
      for chatFeature in retired.chatFeatures {
        await chatFeature.shutdown()
      }
      for retirement in retired.chatRetirementTasks {
        await retirement.value
      }
      if let retiredEngine = retired.engine, sameEngine(retiredEngine, prepared.engine) == false {
        await retiredEngine.shutdown()
      }
      await retired.snapshotTask?.value
      guard activeEpoch == publishedEpoch, sameEngine(syncEngine, prepared.engine) else {
        return false
      }
      await startPreparedEngine(prepared.engine, activeEpoch: publishedEpoch)
      let didActivate = activeEpoch == publishedEpoch
        && sameEngine(syncEngine, prepared.engine)
        && selectedProfile == profile
      if didActivate {
        chatHostGeneration &+= 1
      }
      return didActivate
    } catch {
      guard isCurrent(epoch) else { return false }
      if reportsFailureInBanner {
        banner = .failed(error.localizedDescription)
      }
      return false
    }
  }

  func consume(_ snapshot: SyncSnapshot) async {
    connectionState = snapshot.connection
    let retiredChats: [ScopedChatFeature]
    if let gatewayID = selectedProfile?.gatewayID {
      retiredChats = reconcileSnapshotConversationLifecycle(snapshot, gatewayID: gatewayID)
    } else {
      self.snapshot = snapshot
      retiredChats = []
    }
    let effectiveSnapshot = self.snapshot ?? snapshot
    conversationListFeature?.consume(effectiveSnapshot)
    agentsFeature?.consume(effectiveSnapshot)
    settingsFeature?.consume(effectiveSnapshot)
    for feature in chatFeatures.values {
      feature.setConnection(snapshot.connection)
    }
    for cached in effectiveSnapshot.conversations {
      let scope = chatScope(
        gatewayID: cached.gatewayID,
        conversationID: cached.summary.id
      )
      chatFeatures[scope]?.consumeCanonicalSummary(cached.summary)
    }
    for retired in retiredChats {
      retired.feature.prepareForRemoteRemoval()
    }
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
    let retirements = retiredChats.map { retired in
      scheduleChatRetirement(retired.feature, scope: retired.scope)
    }
    for retirement in retirements {
      await retirement.value
    }
  }

  func openConversation(_ id: String, presentation: NavigationPresentation) {
    if let gatewayID = selectedProfile?.gatewayID,
      chatLifecycleByScope[chatScope(gatewayID: gatewayID, conversationID: id)]?.isRemoved
        == true
    {
      return
    }
    selectedTab = .conversations
    let destination = ConversationRoute.transcript(id)
    openConversationDestination(destination, presentation: presentation)
  }

  /// Compose-first new chat (Task 3, audit #16): swaps the chat header's
  /// agent chip from `oldID` to a freshly-created `newID` conversation under
  /// a different agent. `oldID` is always still-empty (no message ever sent
  /// — the chip only offers the picker while that's true, see `ChatView`),
  /// so the swap should REPLACE it in place rather than push on top the way
  /// `openConversation` does: leaving `oldID` on the compact
  /// `NavigationStack` would leave a dead "back" stop pointing at a
  /// conversation the user never meaningfully visited. `oldID` itself is
  /// left behind untouched (harmless — it's real but empty, same as if the
  /// pre-compose-first "New conversation" Form had been used to create it
  /// and then abandoned without sending).
  func replaceConversation(
    _ oldID: String,
    with newID: String,
    presentation: NavigationPresentation
  ) {
    if let gatewayID = selectedProfile?.gatewayID,
      chatLifecycleByScope[chatScope(gatewayID: gatewayID, conversationID: newID)]?.isRemoved
        == true
    {
      return
    }
    selectedTab = .conversations
    let destination = ConversationRoute.transcript(newID)
    if presentation == .compact, conversationPath.last == .transcript(oldID) {
      conversationPath[conversationPath.count - 1] = destination
      splitConversationSelection = destination
      return
    }
    openConversationDestination(destination, presentation: presentation)
  }

  func openConversationRecovery(_ id: String, presentation: NavigationPresentation) {
    selectedTab = .conversations
    let destination = ConversationRoute.recovery(id)
    openConversationDestination(destination, presentation: presentation)
  }

  func closeConversationRecovery(_ id: String, presentation: NavigationPresentation) {
    let destination = ConversationRoute.recovery(id)
    if splitConversationSelection == destination {
      splitConversationSelection = nil
    }
    switch presentation {
    case .compact:
      if conversationPath.last == destination {
        conversationPath.removeLast()
      } else {
        conversationPath.removeAll { $0 == destination }
      }
    case .regular:
      conversationPath.removeAll { $0 == destination }
    }
  }

  private func openConversationDestination(
    _ destination: ConversationRoute,
    presentation: NavigationPresentation
  ) {
    splitConversationSelection = destination
    switch presentation {
    case .compact:
      if conversationPath.last != destination {
        conversationPath.append(destination)
      }
    case .regular:
      conversationPath = [destination]
    }
  }

  func openAgent(_ route: AgentRoute, presentation: NavigationPresentation) {
    selectedTab = .agents
    splitAgentSelection = route
    switch presentation {
    case .compact:
      if agentPath.last != route {
        agentPath.append(route)
      }
    case .regular:
      agentPath = [route]
    }
  }

  func makePairingFeature() -> PairingFeature {
    dependencies.pairingFeatureFactory.make { [weak self] profile in
      guard
        let self,
        await self.activatePairedProfile(profile, reportsFailureInBanner: false)
      else {
        throw AppDependencyError.pairingActivationFailed
      }
    }
  }

  /// Whether the Clerk account session currently holds a live token. Checked
  /// on demand (rather than cached as `@Observable` state) since it reflects
  /// `AccountSession`'s own actor-isolated cache, not app-owned state.
  func isAccountSignedIn() async -> Bool {
    await dependencies.accountFeatureFactory.isSignedIn
  }

  func signInToAccount() async throws {
    try await dependencies.accountFeatureFactory.signIn()
  }

  /// Builds a `GatewayPickerViewModel` wired to this app's account/connect
  /// dependencies. `onSignedOut` lets the presenting view (which owns the
  /// signed-in/signed-out toggle) fall back to `SignInView` — the view model
  /// invokes it itself both after an explicit sign-out completes AND when a
  /// load/connect discovers the cached account token has gone stale
  /// (`ControlPlaneError.signInRequired`).
  func makeGatewayPickerViewModel(
    onSignedOut: @escaping @MainActor @Sendable () -> Void
  ) -> GatewayPickerViewModel {
    GatewayPickerViewModel(
      listGateways: { [dependencies] in
        try await dependencies.accountFeatureFactory.listGateways()
      },
      connect: { [weak self] gateway in
        guard let self else { throw AppDependencyError.pairingActivationFailed }
        try await self.connectToAccountGateway(gateway)
      },
      signOut: { [weak self] in
        await self?.signOutOfAccount()
      },
      onSignedOut: onSignedOut
    )
  }

  /// Builds a fresh `ApproveDeviceViewModel` for `SettingsView`'s
  /// "Approve a device" row (Task 6) — a new instance per tap, mirroring
  /// `makeGatewayPickerViewModel`'s per-presentation construction, so a
  /// previous scan/decide attempt never leaks into the next one.
  func makeApproveDeviceViewModel() -> ApproveDeviceViewModel {
    dependencies.accountFeatureFactory.makeApproveDeviceViewModel()
  }

  private func connectToAccountGateway(_ gateway: GatewayInfoDTO) async throws {
    let feature = dependencies.accountFeatureFactory.makeConnect(
      onGrantMinted: { [weak self] gatewayId, pairingId in
        self?.lastAccountGrant = (gatewayId, pairingId)
      },
      onConnected: { [weak self] profile in
        guard
          let self,
          await self.activatePairedProfile(profile, reportsFailureInBanner: false)
        else {
          throw AppDependencyError.pairingActivationFailed
        }
        self.lastAccountGrant = nil
      }
    )
    try await feature.connect(to: gateway)
  }

  /// Signs out of the Dash account: defensively tears down any active
  /// gateway connection this device holds (same Keychain-wipe +
  /// selection-forgetting + local-cache-clearing Settings' "Disconnect &
  /// Forget" performs — `GatewayPickerView` only shows once `selectedProfile`
  /// is already nil, so this is normally a no-op belt-and-suspenders check),
  /// best-effort revokes the most recently minted — but never completed —
  /// pairing grant from this session, wipes this device's signer identity
  /// (Task 6 review fix: without this, a signerId registered under THIS
  /// account would survive into a later sign-in as a different account,
  /// permanently 403ing every approval decision that account's Settings
  /// screen ever tries to post), then drops the cached account token.
  func signOutOfAccount() async {
    if selectedProfile != nil {
      try? await disconnectAndForget()
    }
    if let grant = lastAccountGrant {
      await dependencies.accountFeatureFactory.revokePairing(
        gatewayId: grant.gatewayId,
        pairingId: grant.pairingId
      )
      lastAccountGrant = nil
    }
    await dependencies.accountFeatureFactory.resetSignerIdentity()
    await dependencies.accountFeatureFactory.signOut()
  }

  func reconnect() async throws {
    guard
      let profile = selectedProfile,
      let engine = syncEngine,
      isDisconnecting == false
    else { return }
    let epoch = activeEpoch
    markCachedConnection(.connecting)
    do {
      try await dependencies.verifyProfile(profile)
      guard activeEpoch == epoch, sameEngine(syncEngine, engine) else { return }
      await engine.bootstrap()
      guard activeEpoch == epoch, sameEngine(syncEngine, engine) else { return }
    } catch {
      guard activeEpoch == epoch, sameEngine(syncEngine, engine) else { return }
      if let gatewayError = error as? GatewayError {
        switch gatewayError {
        case .notFound, .validation, .revisionConflict, .conversationBusy,
          .mutationOutcomeUnknown:
          markCachedConnection(.offline)
          banner = .offline
        default:
          await handleFeatureGatewayError(gatewayError, epoch: epoch)
        }
      } else if error is AppDependencyError
        || error is GatewayProfileVerificationError
      {
        markCachedConnection(.repairRequired)
        banner = .repairRequired
      } else {
        markCachedConnection(.offline)
        banner = .offline
      }
      throw error
    }
  }

  func makeChatFeature(_ conversation: ConversationSummaryDTO) async -> ChatFeature? {
    guard let profile = selectedProfile, conversation.status != .deleted else { return nil }
    let scope = chatScope(gatewayID: profile.gatewayID, conversationID: conversation.id)
    let lifecycle = chatLifecycleByScope[scope] ?? ChatLifecycleState()
    guard lifecycle.isRemoved == false else { return nil }
    let epoch = activeEpoch
    while let retirement = chatRetirementTasks[scope] {
      await retirement.task.value
      guard
        activeEpoch == epoch,
        selectedProfile == profile,
        (chatLifecycleByScope[scope] ?? ChatLifecycleState()) == lifecycle
      else { return nil }
    }
    if let feature = chatFeatures[scope] {
      feature.consumeCanonicalSummary(conversation)
      return feature
    }

    guard let feature = await dependencies.makeChatFeature(profile, conversation) else {
      return nil
    }
    guard
      activeEpoch == epoch,
      selectedProfile == profile,
      (chatLifecycleByScope[scope] ?? ChatLifecycleState()) == lifecycle
    else {
      await feature.shutdown()
      return nil
    }
    if let existing = chatFeatures[scope] {
      await feature.shutdown()
      guard
        activeEpoch == epoch,
        selectedProfile == profile,
        (chatLifecycleByScope[scope] ?? ChatLifecycleState()) == lifecycle,
        chatFeatures[scope] === existing
      else { return nil }
      existing.consumeCanonicalSummary(conversation)
      return existing
    }
    feature.setConnection(connectionState)
    feature.setGatewayErrorHandler { [weak self, weak feature] error in
      guard
        let self,
        let feature,
        self.activeEpoch == epoch,
        self.chatFeatures[scope] === feature
      else { return }
      await self.handleFeatureGatewayError(error, epoch: epoch)
    }
    feature.setLifecycleChangeHandler { [weak self, weak feature] changes in
      guard
        let self,
        let feature,
        self.activeEpoch == epoch,
        self.selectedProfile == profile,
        self.chatFeatures[scope] === feature
      else { return .ignored }
      return await self.applyConversationLifecycleChanges(
        changes,
        gatewayID: profile.gatewayID,
        originatingList: nil,
        originatingChat: feature
      )
    }
    chatFeatures[scope] = feature
    return feature
  }

  func sceneDidEnterBackground() async {
    isBackgrounded = true
    activeEngineSceneRevision &+= 1
    let sceneRevision = activeEngineSceneRevision
    let transition = transitionEpoch
    let epoch = activeEpoch
    let features = Array(chatFeatures.values)
    let engine = syncEngine
    for feature in features {
      guard
        isBackgrounded,
        activeEngineSceneRevision == sceneRevision,
        isCurrent(transition),
        activeEpoch == epoch
      else { return }
      await feature.sceneDidEnterBackground()
    }
    guard
      isBackgrounded,
      activeEngineSceneRevision == sceneRevision,
      isCurrent(transition),
      activeEpoch == epoch,
      let engine
    else { return }
    activeEngineNeedsForegroundResume = true
    await suspendEngineIfNeeded(engine, activeEpoch: epoch)
  }

  func sceneWillEnterForeground() async {
    isBackgrounded = false
    activeEngineSceneRevision &+= 1
    let sceneRevision = activeEngineSceneRevision
    let transition = transitionEpoch
    let epoch = activeEpoch
    let features = Array(chatFeatures.values)
    let engine = syncEngine
    activeEngineSuspended = false
    for feature in features {
      guard
        isBackgrounded == false,
        activeEngineSceneRevision == sceneRevision,
        isCurrent(transition),
        activeEpoch == epoch
      else { return }
      await feature.sceneWillEnterForeground()
    }
    guard
      isBackgrounded == false,
      activeEngineSceneRevision == sceneRevision,
      isCurrent(transition),
      activeEpoch == epoch,
      let engine
    else { return }
    await driveEngineToCurrentScene(engine, activeEpoch: epoch)
  }

  func disconnectAndForget() async throws {
    guard let profile = selectedProfile, isDisconnecting == false else { return }
    isDisconnecting = true
    defer { isDisconnecting = false }
    let epoch = beginTransition()
    let retired = detachActiveEngine()
    markCachedConnection(.connecting)
    if let feature = retired.settingsFeature {
      await feature.shutdown()
    }
    if let feature = retired.conversationFeature {
      await feature.shutdown()
    }
    if let feature = retired.agentsFeature {
      await feature.shutdown()
    }
    for chatFeature in retired.chatFeatures {
      await chatFeature.shutdown()
    }
    for retirement in retired.chatRetirementTasks {
      await retirement.value
    }
    if let engine = retired.engine {
      await engine.shutdown()
    }
    await retired.snapshotTask?.value
    guard isCurrent(epoch) else { return }
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
  ) -> DetachedActivation {
    let previousGatewayID = selectedProfile?.gatewayID
    let retired = DetachedActivation(
      engine: syncEngine,
      snapshotTask: snapshotTask,
      conversationFeature: conversationListFeature,
      agentsFeature: agentsFeature,
      settingsFeature: settingsFeature,
      chatFeatures: Array(chatFeatures.values),
      chatRetirementTasks: chatRetirementTasks.values.map(\.task)
    )
    retired.conversationFeature?.prepareForShutdown()
    retired.agentsFeature?.prepareForShutdown()
    retired.settingsFeature?.prepareForShutdown()
    for feature in retired.chatFeatures {
      feature.prepareForShutdown()
    }
    chatFeatures.removeAll()
    if previousGatewayID != profile.gatewayID {
      chatLifecycleByScope.removeAll()
    }
    chatRetirementTasks.removeAll()
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
    let conversationFeature = dependencies.makeConversationListFeature(profile)
    conversationFeature?.setGatewayErrorHandler { [weak self, weak conversationFeature] error in
      guard
        let self,
        let conversationFeature,
        self.activeEpoch == epoch,
        self.conversationListFeature === conversationFeature
      else { return }
      await self.handleFeatureGatewayError(error, epoch: epoch)
    }
    conversationFeature?.setLifecycleChangeHandler {
      [weak self, weak conversationFeature] changes in
      guard
        let self,
        let conversationFeature,
        self.activeEpoch == epoch,
        self.selectedProfile == profile,
        self.conversationListFeature === conversationFeature
      else { return .ignored }
      return await self.applyConversationLifecycleChanges(
        changes,
        gatewayID: profile.gatewayID,
        originatingList: conversationFeature,
        originatingChat: nil
      )
    }
    conversationListFeature = conversationFeature
    let agentsFeature = dependencies.makeAgentsFeature(profile)
    agentsFeature?.setGatewayErrorHandler { [weak self, weak agentsFeature] error in
      guard
        let self,
        let agentsFeature,
        self.activeEpoch == epoch,
        self.agentsFeature === agentsFeature
      else { return }
      await self.handleFeatureGatewayError(error, epoch: epoch)
    }
    self.agentsFeature = agentsFeature
    let carriesExistingState = previousGatewayID == nil || previousGatewayID == profile.gatewayID
    let settingsFeature = SettingsFeature(
      profile: profile,
      connection: carriesExistingState ? (snapshot?.connection ?? .connecting) : .connecting,
      lastSuccessfulSyncAt: carriesExistingState
        ? (snapshot?.lastSuccessfulSyncAt ?? profile.profile.lastSuccessfulSyncAt)
        : profile.profile.lastSuccessfulSyncAt,
      reconnectAction: { [weak self] in
        guard let self else { return }
        try await self.reconnect()
      },
      disconnectAction: { [weak self] in
        guard let self else { return }
        do {
          try await self.disconnectAndForget()
        } catch {
          if self.selectedProfile == nil {
            throw SettingsDisconnectError.localCleanup
          }
          throw SettingsDisconnectError.keychain
        }
      }
    )
    self.settingsFeature = settingsFeature
    // Not a bare `.conversations`: activating a profile is the last thing
    // to touch `selectedTab` on launch, so it is what overwrote the
    // debug-only initial-tab override set in `init`. See
    // `defaultTabAfterActivation`.
    selectedTab = defaultTabAfterActivation
    #if DEBUG
      applyUITestInitialRoute()
    #endif
    if previousGatewayID != nil, previousGatewayID != profile.gatewayID {
      conversationPath.removeAll()
      agentPath.removeAll()
      splitConversationSelection = nil
      snapshot = nil
      connectionState = .connecting
      splitAgentSelection = nil
    } else {
      markCachedConnection(.connecting)
    }
    banner = nil
    snapshotTask = Task { [weak self] in
      for await value in prepared.snapshots {
        guard Task.isCancelled == false else { return }
        guard let self, self.activeEpoch == epoch else { return }
        await self.consume(value)
      }
    }
    return retired
  }

  private func detachActiveEngine(clearFeatures: Bool = false) -> DetachedActivation {
    let retired = DetachedActivation(
      engine: syncEngine,
      snapshotTask: snapshotTask,
      conversationFeature: conversationListFeature,
      agentsFeature: agentsFeature,
      settingsFeature: settingsFeature,
      chatFeatures: Array(chatFeatures.values),
      chatRetirementTasks: chatRetirementTasks.values.map(\.task)
    )
    retired.conversationFeature?.prepareForShutdown()
    retired.agentsFeature?.prepareForShutdown()
    retired.settingsFeature?.prepareForShutdown()
    for feature in retired.chatFeatures {
      feature.prepareForShutdown()
    }
    chatFeatures.removeAll()
    chatLifecycleByScope.removeAll()
    chatRetirementTasks.removeAll()
    snapshotTask?.cancel()
    snapshotTask = nil
    syncEngine = nil
    activeEngineBootstrapped = false
    activeEngineLifecycleStarted = false
    activeEngineNeedsForegroundResume = false
    activeEngineSuspended = false
    activeEngineSuspensionStarted = false
    if clearFeatures {
      conversationListFeature = nil
      agentsFeature = nil
      settingsFeature = nil
    }
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
        lastSuccessfulSyncAt: snapshot.lastSuccessfulSyncAt,
        removedConversationIDs: snapshot.removedConversationIDs
      )
      conversationListFeature?.consume(self.snapshot)
      agentsFeature?.consume(self.snapshot)
    } else {
      snapshot = nil
    }
    banner = .repairRequired
    settingsFeature?.update(
      connection: .repairRequired,
      lastSuccessfulSyncAt: snapshot?.lastSuccessfulSyncAt
    )
  }

  private func markCachedConnection(_ connection: GatewayConnectionState) {
    connectionState = connection
    for feature in chatFeatures.values {
      feature.setConnection(connection)
    }
    settingsFeature?.update(
      connection: connection,
      lastSuccessfulSyncAt: snapshot?.lastSuccessfulSyncAt
    )
    guard let snapshot else { return }
    let updatedSnapshot = SyncSnapshot(
      connection: connection,
      conversations: snapshot.conversations,
      agents: snapshot.agents,
      lastSuccessfulSyncAt: snapshot.lastSuccessfulSyncAt,
      removedConversationIDs: snapshot.removedConversationIDs
    )
    self.snapshot = updatedSnapshot
    conversationListFeature?.consume(updatedSnapshot)
    agentsFeature?.consume(updatedSnapshot)
    settingsFeature?.consume(updatedSnapshot)
  }

  private func handleFeatureGatewayError(_ error: GatewayError, epoch: UInt64) async {
    guard activeEpoch == epoch else { return }
    let state: GatewayConnectionState
    switch error {
    case .unauthorized:
      state = .repairRequired
    case .rateLimited(let retryAfter):
      let now = await dependencies.clock.now()
      let delay = retryAfter ?? .seconds(1)
      let components = delay.components
      let seconds =
        TimeInterval(components.seconds)
        + (TimeInterval(components.attoseconds) / 1e18)
      guard activeEpoch == epoch else { return }
      state = .rateLimited(retryAt: now.addingTimeInterval(max(0, seconds)))
    case .gatewayOffline:
      state = .gatewayOffline
    case .updateRequired, .capabilityRequired:
      state = .updateRequired
    case .transport, .server:
      state = .offline
    case .notFound, .validation, .revisionConflict, .conversationBusy,
      .mutationOutcomeUnknown:
      return
    }
    guard activeEpoch == epoch else { return }
    let cached = snapshot?.conversations ?? conversationListFeature?.conversations ?? []
    let agents = agentsFeature?.agents ?? snapshot?.agents ?? conversationListFeature?.agents ?? []
    await consume(
      SyncSnapshot(
        connection: state,
        conversations: cached,
        agents: agents,
        lastSuccessfulSyncAt: snapshot?.lastSuccessfulSyncAt,
        removedConversationIDs: snapshot?.removedConversationIDs ?? []
      )
    )
  }

  private func beginTransition() -> UInt64 {
    transitionEpoch &+= 1
    return transitionEpoch
  }

  private func isCurrent(_ epoch: UInt64) -> Bool {
    transitionEpoch == epoch
  }

  private func reconcileSnapshotConversationLifecycle(
    _ incoming: SyncSnapshot,
    gatewayID: String
  ) -> [ScopedChatFeature] {
    let previousByID = Dictionary(
      uniqueKeysWithValues: (snapshot?.conversations ?? []).compactMap { cached in
        cached.gatewayID == gatewayID ? (cached.id, cached.summary) : nil
      }
    )
    var projected: [CachedConversation] = []
    var removedConversationIDs = incoming.removedConversationIDs

    for cached in incoming.conversations where cached.gatewayID == gatewayID {
      switch applyCanonicalLifecycle(
        cached.summary,
        gatewayID: gatewayID,
        currentRevision: previousByID[cached.id]?.revision
      ) {
      case .active(let effective):
        projected.append(CachedConversation(gatewayID: gatewayID, summary: effective))
        removedConversationIDs.remove(effective.id)

      case .removed:
        removedConversationIDs.insert(cached.id)
        if cached.summary.status == .deleted {
          projected.append(cached)
        }

      case .ignored:
        let scope = chatScope(gatewayID: gatewayID, conversationID: cached.id)
        if chatLifecycleByScope[scope]?.isRemoved == true {
          removedConversationIDs.insert(cached.id)
          if let previous = previousByID[cached.id], previous.status == .deleted {
            projected.append(CachedConversation(gatewayID: gatewayID, summary: previous))
          }
        } else if let previous = previousByID[cached.id] {
          projected.append(CachedConversation(gatewayID: gatewayID, summary: previous))
        }
      }
    }

    for conversationID in incoming.removedConversationIDs {
      let currentRevision = previousByID[conversationID]?.revision
        ?? incoming.conversations.first(where: { $0.id == conversationID })?.summary.revision
      applyLifecycleRemoval(
        conversationID: conversationID,
        revisionFloor: currentRevision,
        gatewayID: gatewayID
      )
      projected.removeAll { $0.id == conversationID }
      removedConversationIDs.insert(conversationID)
    }

    removedConversationIDs.formUnion(lifecycleRemovedConversationIDs(gatewayID: gatewayID))
    projected.removeAll { removedConversationIDs.contains($0.id) && $0.summary.status != .deleted }
    self.snapshot = SyncSnapshot(
      connection: incoming.connection,
      conversations: projected,
      agents: incoming.agents,
      lastSuccessfulSyncAt: incoming.lastSuccessfulSyncAt,
      removedConversationIDs: removedConversationIDs
    )
    pruneTranscriptRoutes(removedConversationIDs)
    return removedConversationIDs.compactMap { conversationID in
      let scope = chatScope(gatewayID: gatewayID, conversationID: conversationID)
      guard let feature = chatFeatures.removeValue(forKey: scope) else { return nil }
      return ScopedChatFeature(scope: scope, feature: feature)
    }
  }

  private func applyCanonicalLifecycle(
    _ incoming: ConversationSummaryDTO,
    gatewayID: String,
    currentRevision: Int?
  ) -> CanonicalLifecycleResult {
    let scope = chatScope(gatewayID: gatewayID, conversationID: incoming.id)
    var lifecycle = chatLifecycleByScope[scope] ?? ChatLifecycleState()
    lifecycle.revisionFloor = raisedRevisionFloor(
      lifecycle.revisionFloor,
      currentRevision
    )

    if incoming.status == .deleted {
      if lifecycle.isRemoved {
        if let floor = lifecycle.revisionFloor, incoming.revision < floor {
          chatLifecycleByScope[scope] = lifecycle
          return .ignored
        }
        lifecycle.revisionFloor = raisedRevisionFloor(
          lifecycle.revisionFloor,
          incoming.revision
        )
        chatLifecycleByScope[scope] = lifecycle
        return .removed
      }
      if let floor = lifecycle.revisionFloor, incoming.revision <= floor {
        chatLifecycleByScope[scope] = lifecycle
        return .ignored
      }
      lifecycle.generation &+= 1
      lifecycle.isRemoved = true
      lifecycle.revisionFloor = incoming.revision
      chatLifecycleByScope[scope] = lifecycle
      return .removed
    }

    if lifecycle.isRemoved {
      if let floor = lifecycle.revisionFloor, incoming.revision <= floor {
        chatLifecycleByScope[scope] = lifecycle
        return .ignored
      }
      lifecycle.generation &+= 1
      lifecycle.isRemoved = false
    } else if let floor = lifecycle.revisionFloor, incoming.revision < floor {
      chatLifecycleByScope[scope] = lifecycle
      return .ignored
    }
    lifecycle.revisionFloor = raisedRevisionFloor(lifecycle.revisionFloor, incoming.revision)
    chatLifecycleByScope[scope] = lifecycle
    return .active(incoming)
  }

  private func applyLifecycleRemoval(
    conversationID: String,
    revisionFloor: Int?,
    gatewayID: String
  ) {
    let scope = chatScope(gatewayID: gatewayID, conversationID: conversationID)
    var lifecycle = chatLifecycleByScope[scope] ?? ChatLifecycleState()
    lifecycle.revisionFloor = raisedRevisionFloor(lifecycle.revisionFloor, revisionFloor)
    if lifecycle.isRemoved == false {
      lifecycle.generation &+= 1
      lifecycle.isRemoved = true
    }
    chatLifecycleByScope[scope] = lifecycle
  }

  private func applyConversationLifecycleChanges(
    _ changes: [ConversationLifecycleChange],
    gatewayID: String,
    originatingList: ConversationListFeature?,
    originatingChat: ChatFeature?
  ) async -> ConversationLifecycleAcknowledgement {
    guard changes.isEmpty == false else { return .ignored }
    let base = snapshot
      ?? SyncSnapshot(
        connection: connectionState,
        conversations: [],
        agents: agentsFeature?.agents ?? conversationListFeature?.agents ?? [],
        lastSuccessfulSyncAt: selectedProfile?.profile.lastSuccessfulSyncAt
      )
    var projected = base.conversations
    var removedConversationIDs = base.removedConversationIDs
    var acceptedRemovedIDs: Set<String> = []
    var acceptedCanonicalByID: [String: ConversationSummaryDTO] = [:]

    for change in changes {
      switch change {
      case .canonical(let canonical):
        let currentRevision = projected.first(where: { $0.id == canonical.id })?.summary.revision
        switch applyCanonicalLifecycle(
          canonical,
          gatewayID: gatewayID,
          currentRevision: currentRevision
        ) {
        case .active(let effective):
          upsertSnapshotConversation(
            CachedConversation(gatewayID: gatewayID, summary: effective),
            in: &projected
          )
          removedConversationIDs.remove(effective.id)
          acceptedCanonicalByID[effective.id] = effective

        case .removed:
          acceptedRemovedIDs.insert(canonical.id)
          removedConversationIDs.insert(canonical.id)
          if canonical.status == .deleted {
            upsertSnapshotConversation(
              CachedConversation(gatewayID: gatewayID, summary: canonical),
              in: &projected
            )
          } else {
            projected.removeAll { $0.id == canonical.id }
          }

        case .ignored:
          break
        }

      case .removed(let id, let revisionFloor):
        let currentRevision = projected.first(where: { $0.id == id })?.summary.revision
        applyLifecycleRemoval(
          conversationID: id,
          revisionFloor: raisedRevisionFloor(revisionFloor, currentRevision),
          gatewayID: gatewayID
        )
        projected.removeAll { $0.id == id }
        removedConversationIDs.insert(id)
        acceptedRemovedIDs.insert(id)
      }
    }

    removedConversationIDs.formUnion(lifecycleRemovedConversationIDs(gatewayID: gatewayID))
    projected.removeAll { removedConversationIDs.contains($0.id) && $0.summary.status != .deleted }
    let effectiveSnapshot = SyncSnapshot(
      connection: base.connection,
      conversations: projected,
      agents: base.agents,
      lastSuccessfulSyncAt: base.lastSuccessfulSyncAt,
      removedConversationIDs: removedConversationIDs
    )
    snapshot = effectiveSnapshot
    pruneTranscriptRoutes(acceptedRemovedIDs)

    let retiredChats: [ScopedChatFeature] = acceptedRemovedIDs.compactMap { conversationID in
      let scope = chatScope(gatewayID: gatewayID, conversationID: conversationID)
      guard let feature = chatFeatures.removeValue(forKey: scope) else { return nil }
      return ScopedChatFeature(scope: scope, feature: feature)
    }
    for retired in retiredChats {
      retired.feature.prepareForRemoteRemoval()
    }

    if conversationListFeature !== originatingList {
      conversationListFeature?.consume(effectiveSnapshot)
    }
    for canonical in acceptedCanonicalByID.values {
      let scope = chatScope(gatewayID: gatewayID, conversationID: canonical.id)
      guard let feature = chatFeatures[scope], feature !== originatingChat else { continue }
      feature.consumeCanonicalSummary(canonical)
    }

    let retirements = retiredChats.map { retired in
      (
        feature: retired.feature,
        task: scheduleChatRetirement(retired.feature, scope: retired.scope)
      )
    }
    for retirement in retirements where retirement.feature !== originatingChat {
      await retirement.task.value
    }

    return ConversationLifecycleAcknowledgement(acceptedRemovedIDs: acceptedRemovedIDs)
  }

  private func scheduleChatRetirement(
    _ feature: ChatFeature,
    scope: String
  ) -> Task<Void, Never> {
    let predecessor = chatRetirementTasks[scope]?.task
    let id = UUID()
    let task = Task { [weak self] in
      await predecessor?.value
      await feature.retireAfterRemoteRemoval()
      self?.completeChatRetirement(scope: scope, id: id)
    }
    chatRetirementTasks[scope] = ChatRetirementRecord(id: id, task: task)
    return task
  }

  private func completeChatRetirement(scope: String, id: UUID) {
    guard chatRetirementTasks[scope]?.id == id else { return }
    chatRetirementTasks[scope] = nil
  }

  private func upsertSnapshotConversation(
    _ value: CachedConversation,
    in conversations: inout [CachedConversation]
  ) {
    if let index = conversations.firstIndex(where: { $0.id == value.id }) {
      conversations[index] = value
    } else {
      conversations.append(value)
    }
  }

  private func lifecycleRemovedConversationIDs(gatewayID: String) -> Set<String> {
    let prefix = "\(gatewayID)\u{1f}"
    return Set(
      chatLifecycleByScope.compactMap { scope, lifecycle in
        guard lifecycle.isRemoved, scope.hasPrefix(prefix) else { return nil }
        return String(scope.dropFirst(prefix.count))
      }
    )
  }

  private func raisedRevisionFloor(_ lhs: Int?, _ rhs: Int?) -> Int? {
    switch (lhs, rhs) {
    case (.some(let lhs), .some(let rhs)): return max(lhs, rhs)
    case (.some(let lhs), .none): return lhs
    case (.none, .some(let rhs)): return rhs
    case (.none, .none): return nil
    }
  }

  private func sameEngine(_ lhs: (any AppSyncing)?, _ rhs: any AppSyncing) -> Bool {
    guard let lhs else { return false }
    return ObjectIdentifier(lhs as AnyObject) == ObjectIdentifier(rhs as AnyObject)
  }

  private func chatScope(gatewayID: String, conversationID: String) -> String {
    "\(gatewayID)\u{1f}\(conversationID)"
  }

  private func pruneTranscriptRoutes(_ removedConversationIDs: Set<String>) {
    guard removedConversationIDs.isEmpty == false else { return }
    conversationPath.removeAll { route in
      if case .transcript(let id) = route {
        return removedConversationIDs.contains(id)
      }
      return false
    }
    if case .transcript(let id) = splitConversationSelection,
      removedConversationIDs.contains(id)
    {
      splitConversationSelection = nil
    }
  }

  private func resetToConnect() {
    _ = detachActiveEngine(clearFeatures: true)
    selectedProfile = nil
    connectionState = .connecting
    selectedTab = .conversations
    conversationPath.removeAll()
    agentPath.removeAll()
    splitConversationSelection = nil
    splitAgentSelection = nil
    snapshot = nil
    banner = nil
  }
}
