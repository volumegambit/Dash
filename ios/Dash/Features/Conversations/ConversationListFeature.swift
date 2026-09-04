import Foundation
import Observation

enum ConversationLifecycleChange: Equatable, Sendable {
  case canonical(ConversationSummaryDTO)
  case removed(id: String, revisionFloor: Int?)
}

struct ConversationLifecycleAcknowledgement: Equatable, Sendable {
  let acceptedRemovedIDs: Set<String>

  static let ignored = ConversationLifecycleAcknowledgement(acceptedRemovedIDs: [])
}

struct ConversationRecoveryChangeSubscription: Sendable {
  let changes: AsyncStream<String>
  private let cancelAction: @Sendable () async -> Void

  init(
    changes: AsyncStream<String>,
    cancelAction: @escaping @Sendable () async -> Void
  ) {
    self.changes = changes
    self.cancelAction = cancelAction
  }

  func cancel() async {
    await cancelAction()
  }
}

protocol ConversationRecoveryChangeStreaming: Actor {
  func subscription(gatewayID: String) async -> ConversationRecoveryChangeSubscription
}

protocol ConversationRecoveryChangeSignaling: ConversationRecoveryChangeStreaming {
  func send(gatewayID: String) async
}

actor ConversationRecoveryChangeSignal: ConversationRecoveryChangeSignaling {
  private struct Subscriber {
    let gatewayID: String
    let continuation: AsyncStream<String>.Continuation
  }

  static let shared = ConversationRecoveryChangeSignal()

  private var subscribers: [UUID: Subscriber] = [:]
  var subscriberCount: Int { subscribers.count }

  func changes(gatewayID: String) async -> AsyncStream<String> {
    makeSubscription(gatewayID: gatewayID).changes
  }

  func subscription(gatewayID: String) async -> ConversationRecoveryChangeSubscription {
    makeSubscription(gatewayID: gatewayID)
  }

  private func makeSubscription(gatewayID: String) -> ConversationRecoveryChangeSubscription {
    let id = UUID()
    let changes = AsyncStream<String>(bufferingPolicy: .bufferingNewest(1)) { continuation in
      subscribers[id] = Subscriber(gatewayID: gatewayID, continuation: continuation)
      continuation.onTermination = { [weak self] _ in
        Task { await self?.removeContinuation(id, finish: false) }
      }
    }
    return ConversationRecoveryChangeSubscription(
      changes: changes,
      cancelAction: { [weak self] in
        await self?.removeContinuation(id, finish: true)
      }
    )
  }

  func send(gatewayID: String) async {
    for subscriber in subscribers.values where subscriber.gatewayID == gatewayID {
      subscriber.continuation.yield(gatewayID)
    }
  }

  private func removeContinuation(_ id: UUID, finish: Bool) {
    guard let subscriber = subscribers.removeValue(forKey: id) else { return }
    if finish {
      subscriber.continuation.finish()
    }
  }
}

enum ConversationMutationError: Equatable, Sendable {
  case offline
  case invalidTitle
  case outcomeUnknown
  case revisionConflict(current: ConversationSummaryDTO)
  case conversationBusy(conversationID: String, activeTurnID: String)
  case readOnly(conversationID: String)
  case failed
}

extension ConversationMutationError {
  /// User-facing copy shared by `ConversationListView`'s rename/delete error
  /// alert and `ChatView`'s toolbar Menu rename/delete error alert (audit
  /// #15) — both trigger the exact same `ConversationListFeature.rename`/
  /// `delete` calls, so they surface identical failures identically rather
  /// than drifting into two independently-worded copies of the same error.
  /// `.revisionConflict` is excluded on purpose: only `ConversationListView`
  /// owns the richer "this conversation changed on another device" conflict
  /// banner + retry flow, so callers gate presentation on
  /// `case .revisionConflict = error` before reading this.
  var userMessage: String {
    switch self {
    case .offline:
      "Connect to the gateway and try again."
    case .invalidTitle:
      "Enter a title that is not empty."
    case .outcomeUnknown:
      "Dash could not confirm the result. Retry to reconcile the same request."
    case .conversationBusy:
      "This conversation has an active turn. Resume or cancel it before deleting."
    case .readOnly:
      "This conversation was archived on another device and is now read-only."
    case .failed:
      "Dash couldn't complete the update. Try again."
    case .revisionConflict:
      ""
    }
  }
}

protocol ConversationListServicing: Actor {
  func cachedConversations() async throws -> [CachedConversation]
  func cachedAgents() async throws -> [RegisteredAgentDTO]
  func refreshAgents() async throws -> [RegisteredAgentDTO]
  func conversations(
    agentID: String?,
    limit: Int,
    cursor: String?
  ) async throws -> ConversationPageDTO
  func conversation(id: String) async throws -> ConversationSummaryDTO
  func create(_ request: CreateConversationRequest) async throws -> ConversationSummaryDTO
  func reconcileCreate(
    _ request: CreateConversationRequest
  ) async throws -> ConversationSummaryDTO
  func rename(id: String, title: String, revision: Int) async throws -> ConversationSummaryDTO
  func delete(id: String, revision: Int) async throws -> ConversationSummaryDTO
  func replace(_ summary: ConversationSummaryDTO) async throws -> ConversationSummaryDTO
  func remove(
    id: String,
    expectedCanonical: ConversationSummaryDTO
  ) async throws -> ConversationRemovalOutcome
  func retainedCreateRequestID(agentID: String, suggested: String) async -> String
  func clearRetainedCreateRequestID(agentID: String) async
  func shutdown() async
}

protocol ConversationListPersisting: Actor {
  func conversations(gatewayID: String, limit: Int) async throws -> [CachedConversation]
  func agents(gatewayID: String) async throws -> [RegisteredAgentDTO]
  func replaceAgents(_ values: [RegisteredAgentDTO], gatewayID: String) async throws
  func upsertAgent(_ value: RegisteredAgentDTO, gatewayID: String) async throws
  func removeAgent(gatewayID: String, agentID: String) async throws
  func upsertConversations(
    _ values: [ConversationSummaryDTO],
    gatewayID: String
  ) async throws
  func applyTombstone(_ value: ConversationSummaryDTO, gatewayID: String) async throws
  func persistConversationAndReturnCanonical(
    _ value: ConversationSummaryDTO,
    gatewayID: String
  ) async throws -> CachedConversation
  func removeConversation(gatewayID: String, conversationID: String) async throws
  func removeConversationIfCanonicalUnchanged(
    gatewayID: String,
    conversationID: String,
    expectedCanonical: ConversationSummaryDTO?
  ) async throws -> ConversationRemovalOutcome
}

extension PersistenceStore: ConversationListPersisting {}

protocol ConversationRecoveryServicing: Actor {
  func recoverablePendingSends() async throws -> [RecoverablePendingSend]
  func discard(_ recovery: RecoverablePendingSend) async throws -> Bool
}

actor EmptyConversationRecoveryService: ConversationRecoveryServicing {
  func recoverablePendingSends() -> [RecoverablePendingSend] { [] }

  func discard(_ recovery: RecoverablePendingSend) -> Bool {
    _ = recovery
    return false
  }
}

actor LiveConversationRecoveryService: ConversationRecoveryServicing {
  private let gatewayID: String
  private let store: PersistenceStore
  private let recoveryChanges: ConversationRecoveryChangeSignal

  init(
    gatewayID: String,
    store: PersistenceStore,
    recoveryChanges: ConversationRecoveryChangeSignal = .shared
  ) {
    self.gatewayID = gatewayID
    self.store = store
    self.recoveryChanges = recoveryChanges
  }

  func recoverablePendingSends() async throws -> [RecoverablePendingSend] {
    try await store.recoverablePendingSends(gatewayID: gatewayID)
  }

  func discard(_ recovery: RecoverablePendingSend) async throws -> Bool {
    guard recovery.gatewayID == gatewayID else { return false }
    let discarded = try await store.discardPendingSend(
      gatewayID: gatewayID,
      conversationID: recovery.conversationID,
      turnID: recovery.pendingSend.turnID,
      expectedConversationAvailable: recovery.conversationAvailable
    )
    if discarded {
      await recoveryChanges.send(gatewayID: gatewayID)
    }
    return discarded
  }
}

actor PendingConversationCreateStore {
  private let defaults: UserDefaults
  private let keyPrefix = "app.dash.ios.pending-conversation-create"

  init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
  }

  func retainedID(gatewayID: String, agentID: String, suggested: String) -> String {
    let key = key(gatewayID: gatewayID, agentID: agentID)
    if let retained = defaults.string(forKey: key) { return retained }
    defaults.set(suggested, forKey: key)
    return suggested
  }

  func clear(gatewayID: String, agentID: String) {
    defaults.removeObject(forKey: key(gatewayID: gatewayID, agentID: agentID))
  }

  func clear(gatewayID: String) {
    let prefix = "\(keyPrefix).\(encoded(gatewayID))."
    for key in defaults.dictionaryRepresentation().keys where key.hasPrefix(prefix) {
      defaults.removeObject(forKey: key)
    }
  }

  private func key(gatewayID: String, agentID: String) -> String {
    "\(keyPrefix).\(encoded(gatewayID)).\(encoded(agentID))"
  }

  private func encoded(_ value: String) -> String {
    Data(value.utf8).base64EncodedString()
  }
}

/// Compose-first new chat (Task 3, audit #16): where the "last agent used to
/// start a conversation on this gateway" lives. A protocol (rather than a
/// concrete `UserDefaults`-backed type injected directly) so
/// `UITestScenarioSupport` can substitute a per-launch in-memory fake — the
/// same reason `ConversationListServicing`'s `retainedCreateRequestID` exists
/// as a protocol method rather than a hardcoded `PendingConversationCreateStore`
/// call: real `UserDefaults.standard` persists across UI test launches on the
/// same simulator, which would let one test's agent selection leak into the
/// next. Kept as its OWN small protocol (not folded into
/// `ConversationListServicing`) since it's pure local preference state with
/// no gateway round-trip or retry semantics — adding it to the service
/// protocol would force every existing fake conformer (`ConversationListFeatureTests`,
/// `ChatFeatureTests`, `AgentsFeatureTests`, `AppModelTests`) to grow two new
/// stub methods for something they don't otherwise care about.
protocol LastUsedAgentStoring: Actor {
  func agentID(gatewayID: String) -> String?
  func setAgentID(_ agentID: String, gatewayID: String)
  /// Phase 4 minor 8: called from `AppDependencies.live`'s `clearProfileData`
  /// (forget-gateway / sign-out) so the preference doesn't outlive the pairing.
  func clear(gatewayID: String)
}

actor LastUsedAgentStore: LastUsedAgentStoring {
  private let defaults: UserDefaults
  private let keyPrefix = "app.dash.ios.last-used-agent"

  init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
  }

  func agentID(gatewayID: String) -> String? {
    defaults.string(forKey: key(gatewayID: gatewayID))
  }

  func setAgentID(_ agentID: String, gatewayID: String) {
    defaults.set(agentID, forKey: key(gatewayID: gatewayID))
  }

  func clear(gatewayID: String) {
    defaults.removeObject(forKey: key(gatewayID: gatewayID))
  }

  private func key(gatewayID: String) -> String {
    "\(keyPrefix).\(encoded(gatewayID))"
  }

  private func encoded(_ value: String) -> String {
    Data(value.utf8).base64EncodedString()
  }
}

actor LiveConversationListService: ConversationListServicing {
  private let gatewayID: String
  private let store: any ConversationListPersisting
  private let pendingCreates: PendingConversationCreateStore
  private let makeAPI: @Sendable () async throws -> GatewayAPI
  private var cachedAPI: GatewayAPI?
  private var lifecycleGeneration: UInt64 = 0
  private var activeOperations = 0
  private var isShutdown = false
  private var shutdownWaiters: [CheckedContinuation<Void, Never>] = []

  init(
    gatewayID: String,
    store: any ConversationListPersisting,
    pendingCreates: PendingConversationCreateStore,
    makeAPI: @escaping @Sendable () async throws -> GatewayAPI
  ) {
    self.gatewayID = gatewayID
    self.store = store
    self.pendingCreates = pendingCreates
    self.makeAPI = makeAPI
  }

  func cachedConversations() async throws -> [CachedConversation] {
    try await store.conversations(gatewayID: gatewayID, limit: 1_000)
  }

  func cachedAgents() async throws -> [RegisteredAgentDTO] {
    try await store.agents(gatewayID: gatewayID)
  }

  func refreshAgents() async throws -> [RegisteredAgentDTO] {
    let lifecycle = try beginOperation()
    defer { finishOperation() }
    let values = try await resolvedAPI().listAgents()
    try validate(lifecycle)
    try await store.replaceAgents(values, gatewayID: gatewayID)
    try validate(lifecycle)
    return values
  }

  func conversations(
    agentID: String?,
    limit: Int,
    cursor: String?
  ) async throws -> ConversationPageDTO {
    let lifecycle = try beginOperation()
    defer { finishOperation() }
    let page = try await resolvedAPI().conversations(
      agentId: agentID,
      limit: limit,
      cursor: cursor
    )
    try validate(lifecycle)
    var canonicalItems: [ConversationSummaryDTO] = []
    canonicalItems.reserveCapacity(page.items.count)
    for value in page.items {
      canonicalItems.append(try await persistCanonical(value))
      try validate(lifecycle)
    }
    return ConversationPageDTO(items: canonicalItems, nextCursor: page.nextCursor)
  }

  func conversation(id: String) async throws -> ConversationSummaryDTO {
    let lifecycle = try beginOperation()
    defer { finishOperation() }
    let summary = try await resolvedAPI().conversation(id: id)
    try validate(lifecycle)
    let persisted = try await persistCanonical(summary)
    try validate(lifecycle)
    return persisted
  }

  func create(_ request: CreateConversationRequest) async throws -> ConversationSummaryDTO {
    let lifecycle = try beginOperation()
    defer { finishOperation() }
    let summary = try await resolvedAPI().createConversation(request)
    try validate(lifecycle)
    let persisted: ConversationSummaryDTO
    do {
      persisted = try await persistCanonical(summary)
    } catch is CancellationError {
      throw CancellationError()
    } catch {
      throw GatewayError.mutationOutcomeUnknown(
        resourceID: summary.id,
        requestID: request.requestId
      )
    }
    try validate(lifecycle)
    return persisted
  }

  func reconcileCreate(
    _ request: CreateConversationRequest
  ) async throws -> ConversationSummaryDTO {
    let lifecycle = try beginOperation()
    defer { finishOperation() }
    let api = try await resolvedAPI()
    try validate(lifecycle)
    _ = try await api.listAgents()
    try validate(lifecycle)
    let summary = try await api.createConversation(request)
    try validate(lifecycle)
    let persisted: ConversationSummaryDTO
    do {
      persisted = try await persistCanonical(summary)
    } catch is CancellationError {
      throw CancellationError()
    } catch {
      throw GatewayError.mutationOutcomeUnknown(
        resourceID: summary.id,
        requestID: request.requestId
      )
    }
    try validate(lifecycle)
    return persisted
  }

  func rename(id: String, title: String, revision: Int) async throws -> ConversationSummaryDTO {
    let lifecycle = try beginOperation()
    defer { finishOperation() }
    let api = try await resolvedAPI()
    try validate(lifecycle)
    let summary: ConversationSummaryDTO
    do {
      summary = try await api.patchConversation(
        id: id,
        request: try PatchConversationRequest(title: title),
        revision: revision
      )
    } catch let error as GatewayError {
      summary = try await recoverRename(
        error: error,
        api: api,
        id: id,
        title: title,
        revision: revision
      )
    }
    try validate(lifecycle)
    let persisted = try await persistAfterMutation(summary, api: api)
    try validate(lifecycle)
    return persisted
  }

  func delete(id: String, revision: Int) async throws -> ConversationSummaryDTO {
    let lifecycle = try beginOperation()
    defer { finishOperation() }
    let api = try await resolvedAPI()
    try validate(lifecycle)
    let summary: ConversationSummaryDTO
    do {
      summary = try await api.deleteConversation(id: id, revision: revision)
    } catch let error as GatewayError {
      summary = try await recoverDelete(
        error: error,
        api: api,
        id: id,
        revision: revision
      )
    }
    try validate(lifecycle)
    let persisted = try await persistAfterMutation(summary, api: api)
    try validate(lifecycle)
    return persisted
  }

  func replace(_ summary: ConversationSummaryDTO) async throws -> ConversationSummaryDTO {
    let lifecycle = try beginOperation()
    defer { finishOperation() }
    let persisted = try await persistCanonical(summary)
    try validate(lifecycle)
    return persisted
  }

  func remove(
    id: String,
    expectedCanonical: ConversationSummaryDTO
  ) async throws -> ConversationRemovalOutcome {
    let lifecycle = try beginOperation()
    defer { finishOperation() }
    let outcome = try await store.removeConversationIfCanonicalUnchanged(
      gatewayID: gatewayID,
      conversationID: id,
      expectedCanonical: expectedCanonical
    )
    try validate(lifecycle)
    return outcome
  }

  func retainedCreateRequestID(agentID: String, suggested: String) async -> String {
    await pendingCreates.retainedID(
      gatewayID: gatewayID,
      agentID: agentID,
      suggested: suggested
    )
  }

  func clearRetainedCreateRequestID(agentID: String) async {
    await pendingCreates.clear(gatewayID: gatewayID, agentID: agentID)
  }

  func shutdown() async {
    if isShutdown == false {
      isShutdown = true
      lifecycleGeneration &+= 1
    }
    if let cachedAPI {
      await cachedAPI.shutdown()
    }
    guard activeOperations > 0 else { return }
    await withCheckedContinuation { continuation in
      shutdownWaiters.append(continuation)
    }
  }

  private func beginOperation() throws -> UInt64 {
    guard isShutdown == false else { throw CancellationError() }
    activeOperations += 1
    return lifecycleGeneration
  }

  private func finishOperation() {
    activeOperations -= 1
    guard activeOperations == 0 else { return }
    let waiters = shutdownWaiters
    shutdownWaiters.removeAll()
    for waiter in waiters { waiter.resume() }
  }

  private func validate(_ lifecycle: UInt64) throws {
    guard isShutdown == false, lifecycleGeneration == lifecycle else {
      throw CancellationError()
    }
  }

  private func resolvedAPI() async throws -> GatewayAPI {
    if let cachedAPI { return cachedAPI }
    let created = try await makeAPI()
    guard isShutdown == false else {
      await created.shutdown()
      throw CancellationError()
    }
    if let cachedAPI {
      await created.shutdown()
      return cachedAPI
    }
    cachedAPI = created
    return created
  }

  private func recoverRename(
    error: GatewayError,
    api: GatewayAPI,
    id: String,
    title: String,
    revision: Int
  ) async throws -> ConversationSummaryDTO {
    switch error {
    case .notFound:
      let current = try await api.conversation(id: id)
      guard current.status == .deleted else { throw GatewayError.updateRequired }
      return current
    case .mutationOutcomeUnknown:
      let current = try await api.conversation(id: id)
      if current.status == .deleted { return current }
      guard current.revision >= revision else { throw GatewayError.updateRequired }
      if current.revision == revision {
        return try await retryRename(
          api: api,
          id: id,
          title: title,
          revision: revision
        )
      }
      guard current.title == title else {
        throw GatewayError.revisionConflict(current: current)
      }
      return current
    default:
      throw error
    }
  }

  private func recoverDelete(
    error: GatewayError,
    api: GatewayAPI,
    id: String,
    revision: Int
  ) async throws -> ConversationSummaryDTO {
    switch error {
    case .notFound:
      let current = try await api.conversation(id: id)
      guard current.status == .deleted else { throw GatewayError.updateRequired }
      return current
    case .mutationOutcomeUnknown:
      let current = try await api.conversation(id: id)
      if current.status == .deleted { return current }
      guard current.revision >= revision else { throw GatewayError.updateRequired }
      guard current.revision == revision else {
        throw GatewayError.revisionConflict(current: current)
      }
      return try await retryDelete(api: api, id: id, revision: revision)
    default:
      throw error
    }
  }

  private func retryRename(
    api: GatewayAPI,
    id: String,
    title: String,
    revision: Int
  ) async throws -> ConversationSummaryDTO {
    do {
      return try await api.patchConversation(
        id: id,
        request: try PatchConversationRequest(title: title),
        revision: revision
      )
    } catch let error as GatewayError {
      let current: ConversationSummaryDTO
      switch error {
      case .notFound, .mutationOutcomeUnknown:
        current = try await api.conversation(id: id)
      case .revisionConflict(let canonical):
        current = canonical
      default:
        throw error
      }
      if current.status == .deleted { return current }
      guard current.revision >= revision else { throw GatewayError.updateRequired }
      if current.revision == revision {
        if case .notFound = error { throw GatewayError.updateRequired }
        throw error
      }
      guard current.title == title else {
        throw GatewayError.revisionConflict(current: current)
      }
      return current
    }
  }

  private func retryDelete(
    api: GatewayAPI,
    id: String,
    revision: Int
  ) async throws -> ConversationSummaryDTO {
    do {
      return try await api.deleteConversation(id: id, revision: revision)
    } catch let error as GatewayError {
      let current: ConversationSummaryDTO
      switch error {
      case .notFound, .mutationOutcomeUnknown:
        current = try await api.conversation(id: id)
      case .revisionConflict(let canonical):
        current = canonical
      default:
        throw error
      }
      if current.status == .deleted { return current }
      guard current.revision >= revision else { throw GatewayError.updateRequired }
      if current.revision == revision {
        if case .notFound = error { throw GatewayError.updateRequired }
        throw error
      }
      throw GatewayError.revisionConflict(current: current)
    }
  }

  private func persistAfterMutation(
    _ summary: ConversationSummaryDTO,
    api: GatewayAPI
  ) async throws -> ConversationSummaryDTO {
    do {
      return try await persistCanonical(summary)
    } catch is CancellationError {
      throw CancellationError()
    } catch {
      let current = try await api.conversation(id: summary.id)
      guard current.revision >= summary.revision else { throw GatewayError.updateRequired }
      return try await persistCanonical(current)
    }
  }

  private func persistCanonical(
    _ summary: ConversationSummaryDTO
  ) async throws -> ConversationSummaryDTO {
    try await store.persistConversationAndReturnCanonical(summary, gatewayID: gatewayID).summary
  }
}

@MainActor
@Observable
final class ConversationListFeature {
  private enum CanonicalReconciliation {
    case visible(ConversationSummaryDTO)
    case hidden
  }

  private enum PendingConflict: Equatable {
    case rename(id: String, title: String)
    case delete(id: String)
  }

  var conversations: [CachedConversation] = []
  var agents: [RegisteredAgentDTO] = []
  var selectedID: String?
  var selectedAgentID: String?
  var isRefreshing = false
  var isLoadingOlder = false
  var nextCursor: String?
  var mutationError: ConversationMutationError?
  var isAuthoritative = false
  var recoverablePendingSends: [RecoverablePendingSend] = []
  var recoveryError: String?
  var discardingRecoveryID: String?

  var mutationsAllowed: Bool { connection == .online }

  @ObservationIgnored private let gatewayID: String
  @ObservationIgnored private let service: any ConversationListServicing
  @ObservationIgnored private let recoveryService: any ConversationRecoveryServicing
  @ObservationIgnored private let recoveryChanges: any ConversationRecoveryChangeStreaming
  @ObservationIgnored private let lastUsedAgentStore: any LastUsedAgentStoring
  @ObservationIgnored private let requestID: @Sendable () -> UUID
  @ObservationIgnored private let pageSize: Int
  @ObservationIgnored private var allConversations: [CachedConversation] = []
  @ObservationIgnored private var connection: GatewayConnectionState = .connecting
  @ObservationIgnored private var loadedCursors: Set<String> = []
  @ObservationIgnored private var suppressedConversationIDs: Set<String> = []
  @ObservationIgnored private var tombstoneRevisionsByConversationID: [String: Int] = [:]
  @ObservationIgnored private var listGeneration: UInt64 = 0
  @ObservationIgnored private var refreshQueued = false
  @ObservationIgnored private var hasStarted = false
  @ObservationIgnored private var hasFinishedInitialCacheLoad = false
  @ObservationIgnored private var onlineRefreshTask: Task<Void, Never>?
  @ObservationIgnored private var onlineRefreshGeneration: UInt64 = 0
  @ObservationIgnored private var pendingCreateRequestID: String?
  @ObservationIgnored private var pendingCreateAgentID: String?
  // Compose-first new chat (Task 3, audit #16 / review fix I1): ids created
  // via `create(agentID:)` (the compose flow) THIS session, not yet known
  // to have any activity. `discardIfUnusedComposeCreation` consumes (and
  // clears) an entry the first time it's asked about, whether or not it
  // ends up deleting anything — see that method's doc comment.
  @ObservationIgnored private var composeCreatedConversationIDs: Set<String> = []
  @ObservationIgnored private var pendingConflict: PendingConflict?
  @ObservationIgnored private var recoveryGeneration: UInt64 = 0
  @ObservationIgnored private var recoveryReloadTask: Task<Void, Never>?
  @ObservationIgnored private var isExplicitRecoveryReloadInProgress = false
  @ObservationIgnored private var recoveryReloadRequested = false
  @ObservationIgnored private var explicitRecoveryReloadWaiters:
    [CheckedContinuation<Void, Never>] = []
  @ObservationIgnored private var recoveryChangeTask: Task<Void, Never>?
  @ObservationIgnored private var recoveryChangeGeneration: UInt64 = 0
  @ObservationIgnored private var isStartingRecoveryChangeObservation = false
  @ObservationIgnored private var activeRecoveryOperations = 0
  @ObservationIgnored private var recoveryOperationWaiters:
    [CheckedContinuation<Void, Never>] = []
  @ObservationIgnored private var isPreparedForShutdown = false
  @ObservationIgnored private var shutdownDrainTask: Task<Void, Never>?
  @ObservationIgnored private var gatewayErrorHandler:
    @MainActor @Sendable (GatewayError) async -> Void = { _ in }
  @ObservationIgnored private var lifecycleChangeHandler:
    @MainActor @Sendable ([ConversationLifecycleChange]) async
      -> ConversationLifecycleAcknowledgement = { _ in .ignored }

  init(
    gatewayID: String,
    service: any ConversationListServicing,
    recoveryService: any ConversationRecoveryServicing = EmptyConversationRecoveryService(),
    recoveryChanges: any ConversationRecoveryChangeStreaming = ConversationRecoveryChangeSignal.shared,
    lastUsedAgentStore: any LastUsedAgentStoring = LastUsedAgentStore(),
    requestID: @escaping @Sendable () -> UUID = { UUID() },
    pageSize: Int = 50
  ) {
    self.gatewayID = gatewayID
    self.service = service
    self.recoveryService = recoveryService
    self.recoveryChanges = recoveryChanges
    self.lastUsedAgentStore = lastUsedAgentStore
    self.requestID = requestID
    self.pageSize = pageSize
  }

  /// Compose-first new chat (Task 3, audit #16): the agent the compose
  /// button/chip should default to, persisted per-gateway so returning to
  /// this gateway later re-offers whichever agent conversations were last
  /// started with — falls back to `nil` (caller picks the first enabled
  /// agent) when nothing's been recorded yet.
  func lastUsedAgentID() async -> String? {
    await lastUsedAgentStore.agentID(gatewayID: gatewayID)
  }

  /// Records `agentID` as this gateway's last-used agent — called after a
  /// successful compose-flow create (`ConversationListView`'s compose button
  /// or `ChatView`'s agent-chip switch), never for `AgentDetailView`'s
  /// explicit per-agent "Start Chat" (that flow already disambiguates the
  /// agent by construction, so it's out of scope for this preference).
  func recordLastUsedAgent(_ agentID: String) async {
    await lastUsedAgentStore.setAgentID(agentID, gatewayID: gatewayID)
  }

  func consume(_ snapshot: SyncSnapshot?) {
    guard let snapshot else { return }
    let wasOnline = mutationsAllowed
    listGeneration &+= 1
    connection = snapshot.connection
    isAuthoritative = snapshot.connection == .online
    if isRefreshing, mutationsAllowed {
      refreshQueued = true
    }
    let scopedCanonical = snapshot.conversations.filter { $0.gatewayID == gatewayID }
    var currentByID = Dictionary(
      uniqueKeysWithValues: allConversations.map { ($0.id, $0.summary) }
    )
    var merged: [CachedConversation] = []
    var hiddenCanonicalIDs: Set<String> = []
    for incoming in scopedCanonical {
      switch reconcileCanonical(incoming.summary, current: currentByID[incoming.id]) {
      case .visible(let effective):
        currentByID[incoming.id] = effective
        merged.append(CachedConversation(gatewayID: gatewayID, summary: effective))
      case .hidden:
        currentByID[incoming.id] = nil
        hiddenCanonicalIDs.insert(incoming.id)
      }
    }
    suppressedConversationIDs.formUnion(snapshot.removedConversationIDs)
    let snapshotRemovalIDs = snapshot.removedConversationIDs.union(hiddenCanonicalIDs)
    merged.removeAll { snapshot.removedConversationIDs.contains($0.id) }
    if let selectedID, snapshotRemovalIDs.contains(selectedID) {
      self.selectedID = nil
    }
    if let pendingConflict {
      let conflictID: String
      switch pendingConflict {
      case .rename(let id, _), .delete(let id): conflictID = id
      }
      if snapshotRemovalIDs.contains(conflictID) {
        self.pendingConflict = nil
        if case .some(.revisionConflict) = mutationError {
          mutationError = nil
        }
      }
    }
    let incomingIDs = Set(scopedCanonical.map(\.id))
    let retained = allConversations.filter {
      incomingIDs.contains($0.id) == false
        && suppressedConversationIDs.contains($0.id) == false
    }
    for value in retained {
      let insertionIndex = merged.firstIndex {
        $0.summary.updatedAt < value.summary.updatedAt
      }
      merged.insert(value, at: insertionIndex ?? merged.endIndex)
    }
    allConversations = merged
    agents = snapshot.agents
    applyFilter()
    scheduleRecoveryReload()
    if hasFinishedInitialCacheLoad, wasOnline == false, mutationsAllowed {
      scheduleOnlineRefresh()
    }
  }

  func setGatewayErrorHandler(
    _ handler: @escaping @MainActor @Sendable (GatewayError) async -> Void
  ) {
    gatewayErrorHandler = handler
  }

  func setLifecycleChangeHandler(
    _ handler: @escaping @MainActor @Sendable ([ConversationLifecycleChange]) async
      -> ConversationLifecycleAcknowledgement
  ) {
    lifecycleChangeHandler = handler
  }

  func prepareForShutdown() {
    guard isPreparedForShutdown == false else { return }
    isPreparedForShutdown = true
    listGeneration &+= 1
    onlineRefreshGeneration &+= 1
    onlineRefreshTask?.cancel()
    refreshQueued = false
    recoveryGeneration &+= 1
    recoveryReloadTask?.cancel()
    recoveryChangeGeneration &+= 1
    isStartingRecoveryChangeObservation = false
    recoveryChangeTask?.cancel()
    lifecycleChangeHandler = { _ in .ignored }
    connection = .offline
    isAuthoritative = false
  }

  func shutdown() async {
    prepareForShutdown()
    if let shutdownDrainTask {
      await shutdownDrainTask.value
      return
    }

    let retiringOnlineRefresh = onlineRefreshTask
    let retiringRecoveryReload = recoveryReloadTask
    let retiringRecoveryChanges = recoveryChangeTask
    let serviceShutdown = Task { [service] in
      await service.shutdown()
    }
    let drain = Task { [self] in
      await serviceShutdown.value
      await retiringOnlineRefresh?.value
      await retiringRecoveryReload?.value
      await retiringRecoveryChanges?.value
      await waitForRecoveryOperationsToFinish()
    }
    shutdownDrainTask = drain
    await drain.value
    onlineRefreshTask = nil
    recoveryReloadTask = nil
    recoveryChangeTask = nil
  }

  func start() async {
    guard isPreparedForShutdown == false else { return }
    await startRecoveryChangeObservation()
    guard isPreparedForShutdown == false else { return }
    await reloadRecoverablePendingSends()
    guard isPreparedForShutdown == false else { return }
    guard hasStarted == false else { return }
    hasStarted = true
    let generation = listGeneration
    do {
      let cachedConversations = try await service.cachedConversations().filter {
        $0.gatewayID == gatewayID
      }
      let cachedAgents = try await service.cachedAgents()
      guard generation == listGeneration else {
        hasFinishedInitialCacheLoad = true
        if mutationsAllowed { await refresh() }
        return
      }
      allConversations = cachedConversations
      agents = cachedAgents
      isAuthoritative = false
      applyFilter()
    } catch is CancellationError {
      hasStarted = false
      hasFinishedInitialCacheLoad = false
      return
    } catch {
      mutationError = .failed
    }
    hasFinishedInitialCacheLoad = true
    if mutationsAllowed {
      await refresh()
    }
  }

  func refresh() async {
    guard mutationsAllowed else {
      isAuthoritative = false
      await reloadRecoverablePendingSends()
      return
    }
    guard isRefreshing == false else {
      refreshQueued = true
      return
    }
    isRefreshing = true
    listGeneration &+= 1
    let generation = listGeneration
    do {
      let page = try await service.conversations(
        agentID: selectedAgentID,
        limit: pageSize,
        cursor: nil
      )
      let refreshedAgents = try await service.refreshAgents()
      if generation == listGeneration {
        loadedCursors.removeAll()
        var currentByID = Dictionary(
          uniqueKeysWithValues: allConversations.map { ($0.id, $0.summary) }
        )
        var refreshed: [CachedConversation] = []
        var lifecycleChanges: [ConversationLifecycleChange] = []
        for incoming in page.items {
          let reconciliation = reconcileCanonical(incoming, current: currentByID[incoming.id])
          if let change = lifecycleChange(for: incoming, reconciliation: reconciliation) {
            lifecycleChanges.append(change)
          }
          switch reconciliation {
          case .visible(let effective):
            currentByID[incoming.id] = effective
            refreshed.append(CachedConversation(gatewayID: gatewayID, summary: effective))
          case .hidden:
            currentByID[incoming.id] = nil
          }
        }
        allConversations = refreshed
        agents = refreshedAgents
        nextCursor = page.nextCursor
        isAuthoritative = true
        mutationError = nil
        applyFilter()
        await publishLifecycleChanges(lifecycleChanges)
      }
    } catch is CancellationError {
      refreshQueued = false
    } catch {
      if generation == listGeneration {
        isAuthoritative = false
        mutationError = .failed
        await reportGatewayError(error)
      }
    }
    isRefreshing = false
    let shouldRefreshAgain = refreshQueued && mutationsAllowed
    refreshQueued = false
    if shouldRefreshAgain {
      await refresh()
    } else {
      await reloadRecoverablePendingSends()
    }
  }

  func reloadRecoverablePendingSends() async {
    guard beginRecoveryOperation() else { return }
    defer { finishRecoveryOperation() }
    guard isExplicitRecoveryReloadInProgress == false else {
      recoveryReloadRequested = true
      await withCheckedContinuation { continuation in
        explicitRecoveryReloadWaiters.append(continuation)
      }
      return
    }
    isExplicitRecoveryReloadInProgress = true
    defer {
      isExplicitRecoveryReloadInProgress = false
      let waiters = explicitRecoveryReloadWaiters
      explicitRecoveryReloadWaiters.removeAll()
      for waiter in waiters {
        waiter.resume()
      }
    }
    let retiringReload = recoveryReloadTask
    retiringReload?.cancel()
    recoveryReloadTask = nil
    await retiringReload?.value
    repeat {
      recoveryReloadRequested = false
      await performRecoveryReload()
    } while recoveryReloadRequested && isPreparedForShutdown == false
  }

  private func scheduleRecoveryReload() {
    guard isPreparedForShutdown == false else { return }
    if isExplicitRecoveryReloadInProgress {
      recoveryReloadRequested = true
      return
    }
    recoveryGeneration &+= 1
    recoveryReloadTask?.cancel()
    recoveryReloadTask = Task { [weak self] in
      await Task.yield()
      guard Task.isCancelled == false else { return }
      await self?.performTrackedRecoveryReload()
    }
  }

  private func performTrackedRecoveryReload() async {
    guard beginRecoveryOperation() else { return }
    defer { finishRecoveryOperation() }
    await performRecoveryReload()
  }

  private func performRecoveryReload() async {
    recoveryGeneration &+= 1
    let generation = recoveryGeneration
    do {
      let values = try await recoveryService.recoverablePendingSends()
      guard generation == recoveryGeneration else { return }
      recoverablePendingSends = values
      recoveryError = nil
    } catch is CancellationError {
      return
    } catch {
      guard generation == recoveryGeneration else { return }
      recoveryError = "Dash couldn't load saved messages that need recovery."
    }
  }

  private func startRecoveryChangeObservation() async {
    guard
      isPreparedForShutdown == false,
      recoveryChangeTask == nil,
      isStartingRecoveryChangeObservation == false
    else { return }
    guard beginRecoveryOperation() else { return }
    defer { finishRecoveryOperation() }
    isStartingRecoveryChangeObservation = true
    recoveryChangeGeneration &+= 1
    let generation = recoveryChangeGeneration
    defer {
      if generation == recoveryChangeGeneration {
        isStartingRecoveryChangeObservation = false
      }
    }
    let subscription = await recoveryChanges.subscription(gatewayID: gatewayID)
    guard
      isPreparedForShutdown == false,
      generation == recoveryChangeGeneration,
      recoveryChangeTask == nil
    else {
      await subscription.cancel()
      return
    }
    recoveryChangeTask = Task { [weak self, gatewayID] in
      guard Task.isCancelled == false else {
        await subscription.cancel()
        return
      }
      for await changedGatewayID in subscription.changes {
        guard Task.isCancelled == false else { break }
        guard changedGatewayID == gatewayID else { continue }
        self?.receiveRecoveryChange(generation: generation)
      }
      await subscription.cancel()
    }
  }

  private func receiveRecoveryChange(generation: UInt64) {
    guard
      isPreparedForShutdown == false,
      generation == recoveryChangeGeneration
    else { return }
    scheduleRecoveryReload()
  }

  private func beginRecoveryOperation() -> Bool {
    guard isPreparedForShutdown == false else { return false }
    activeRecoveryOperations += 1
    return true
  }

  private func finishRecoveryOperation() {
    activeRecoveryOperations -= 1
    guard activeRecoveryOperations == 0 else { return }
    let waiters = recoveryOperationWaiters
    recoveryOperationWaiters.removeAll()
    for waiter in waiters {
      waiter.resume()
    }
  }

  private func waitForRecoveryOperationsToFinish() async {
    guard activeRecoveryOperations > 0 else { return }
    await withCheckedContinuation { continuation in
      recoveryOperationWaiters.append(continuation)
    }
  }

  func discardRecovery(_ recovery: RecoverablePendingSend) async -> Bool {
    guard beginRecoveryOperation() else { return false }
    defer { finishRecoveryOperation() }
    guard discardingRecoveryID == nil else { return false }
    discardingRecoveryID = recovery.id
    defer { discardingRecoveryID = nil }
    do {
      let discarded = try await recoveryService.discard(recovery)
      await reloadRecoverablePendingSends()
      return discarded
    } catch is CancellationError {
      return false
    } catch {
      recoveryError = "Dash couldn't discard this saved message. It remains available."
      return false
    }
  }

  func setAgentFilter(_ agentID: String?) async {
    selectedAgentID = agentID
    listGeneration &+= 1
    loadedCursors.removeAll()
    nextCursor = nil
    isAuthoritative = false
    applyFilter()
    if mutationsAllowed {
      await refresh()
    }
  }

  /// `visibleConversations` defaults to `conversations` (the canonical,
  /// agent-filtered — but NOT search-filtered — list) for source
  /// compatibility with the pre-search call sites/tests. `ConversationListView`
  /// instead passes its own `filteredConversations` explicitly (review fix,
  /// audit #9): the "near the tail" position check below must be evaluated
  /// against whatever list the row is actually rendered from, or a search
  /// query that filters out the canonical list's last few rows silently
  /// stalls pagination — the visible (filtered) tail never lines up with the
  /// canonical tail that used to gate this, so older pages (that might
  /// contain matches) never load and the user sees "no results" instead of
  /// "haven't looked far enough yet." See also `loadOlderForEmptySearchResults`
  /// for the companion case where the filtered list is empty outright (no
  /// row exists to hang this check off at all).
  func loadOlderIfNeeded(
    currentID: String,
    visibleConversations: [CachedConversation]? = nil
  ) async {
    guard
      mutationsAllowed,
      isLoadingOlder == false,
      isRefreshing == false,
      let cursor = nextCursor,
      loadedCursors.contains(cursor) == false,
      shouldLoadOlder(currentID: currentID, in: visibleConversations ?? conversations)
    else { return }
    await performLoadOlder(cursor: cursor)
  }

  /// Companion to `loadOlderIfNeeded` (review fix, audit #9): when a local
  /// search filter matches nothing among the conversations loaded so far,
  /// `ConversationListView` renders `ContentUnavailableView.search` instead
  /// of any row — so there is no "last visible row" to trigger the usual
  /// near-the-tail pagination at all, even though an older, not-yet-loaded
  /// page might contain a match. This eagerly loads the next page whenever
  /// one exists, reusing the exact same has-more/single-flight guards as
  /// `loadOlderIfNeeded` (mutations allowed, not already loading/refreshing,
  /// a cursor exists, that cursor hasn't been consumed yet) minus the
  /// position check — there's no position to check. `ConversationListView`
  /// drives this via `.task(id: feature.nextCursor)` on its empty-results
  /// row, which stops re-firing on its own once either a match appears (the
  /// row — and its `.task` — disappears) or pages run out (`nextCursor`
  /// settles at `nil`, so the `id` stops changing).
  func loadOlderForEmptySearchResults() async {
    guard
      mutationsAllowed,
      isLoadingOlder == false,
      isRefreshing == false,
      let cursor = nextCursor,
      loadedCursors.contains(cursor) == false
    else { return }
    await performLoadOlder(cursor: cursor)
  }

  private func performLoadOlder(cursor: String) async {
    isLoadingOlder = true
    defer { isLoadingOlder = false }
    let generation = listGeneration
    do {
      let page = try await service.conversations(
        agentID: selectedAgentID,
        limit: pageSize,
        cursor: cursor
      )
      guard generation == listGeneration, nextCursor == cursor else { return }
      loadedCursors.insert(cursor)
      let lifecycleChanges = mergeOlder(page.items)
      nextCursor = page.nextCursor
      isAuthoritative = true
      mutationError = nil
      applyFilter()
      await publishLifecycleChanges(lifecycleChanges)
    } catch is CancellationError {
      return
    } catch {
      mutationError = .failed
      await reportGatewayError(error)
    }
  }

  /// Returns the id of the conversation this call resolved to, or `nil` on
  /// ANY failure — including the tombstone edge case (review fix I2, Task 3
  /// review): `mutationError == nil` alone used to be treated as "success"
  /// by callers, but a create that immediately reconciles as a hidden
  /// tombstone (see `resolveCreate`) also clears `mutationError` without
  /// ever advancing `selectedID`, which let callers silently navigate to a
  /// STALE `selectedID` left over from something unrelated. The return
  /// value is now the only success signal callers should trust —
  /// `ConversationListView.startCompose()` and `ChatView.switchAgent(to:)`
  /// both gate navigation on it directly rather than re-reading
  /// `selectedID`/`mutationError` afterward.
  @discardableResult
  func create(agentID: String) async -> String? {
    guard requireMutation() else { return nil }
    if pendingCreateAgentID != agentID {
      pendingCreateRequestID = nil
      pendingCreateAgentID = nil
    }
    let suggestedID = pendingCreateRequestID ?? requestID().uuidString.lowercased()
    let retainedID = await service.retainedCreateRequestID(
      agentID: agentID,
      suggested: suggestedID
    )
    pendingCreateRequestID = retainedID
    pendingCreateAgentID = agentID
    let request = CreateConversationRequest(
      agentId: agentID,
      requestId: retainedID,
      title: nil,
      owningIssueId: nil,
      projectId: nil
    )
    do {
      let canonical = try await service.create(request)
      return await resolveCreate(canonical)
    } catch is CancellationError {
      return nil
    } catch let error as GatewayError {
      switch error {
      case .mutationOutcomeUnknown, .transport:
        return await reconcileCreate(request)
      default:
        await reportGatewayError(error)
        await service.clearRetainedCreateRequestID(agentID: agentID)
        pendingCreateRequestID = nil
        pendingCreateAgentID = nil
        mutationError = .failed
        return nil
      }
    } catch {
      await service.clearRetainedCreateRequestID(agentID: agentID)
      pendingCreateRequestID = nil
      pendingCreateAgentID = nil
      mutationError = .failed
      await reportGatewayError(error)
      return nil
    }
  }

  func rename(id: String, title: String) async {
    guard requireMutation() else { return }
    let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.isEmpty == false else {
      mutationError = .invalidTitle
      return
    }
    guard let current = allConversations.first(where: { $0.id == id })?.summary else { return }
    do {
      let canonical = try await service.rename(
        id: id,
        title: trimmed,
        revision: current.revision
      )
      if let latest = allConversations.first(where: { $0.id == id })?.summary,
        latest.revision > canonical.revision
      {
        pendingConflict = .rename(id: id, title: trimmed)
        mutationError = .revisionConflict(current: latest)
        return
      }
      let reconciliation = replaceVisible(canonical)
      await publishLifecycleChange(for: canonical, reconciliation: reconciliation)
      pendingConflict = nil
      mutationError = nil
    } catch GatewayError.revisionConflict(let canonical) {
      await recordConflict(canonical, pending: .rename(id: id, title: trimmed))
    } catch GatewayError.notFound {
      await removeStale(
        expectedCanonical: current,
        pending: .rename(id: id, title: trimmed)
      )
    } catch GatewayError.validation(let message)
      where isArchivedReadOnlyValidation(message)
    {
      await reconcileReadOnlyMutation(
        conversationID: id,
        message: message,
        expectedCanonical: current,
        pending: .rename(id: id, title: trimmed)
      )
    } catch is CancellationError {
      return
    } catch {
      mutationError = .failed
      await reportGatewayError(error)
    }
  }

  func delete(id: String, confirmed: Bool) async {
    guard confirmed else { return }
    guard requireMutation() else { return }
    guard let current = allConversations.first(where: { $0.id == id })?.summary else { return }
    do {
      let tombstone = try await service.delete(id: id, revision: current.revision)
      let reconciliation = replaceVisible(tombstone)
      await publishLifecycleChange(for: tombstone, reconciliation: reconciliation)
      switch reconciliation {
      case .visible(let effective):
        pendingConflict = .delete(id: id)
        mutationError = .revisionConflict(current: effective)
      case .hidden:
        pendingConflict = nil
        mutationError = nil
      }
      await reloadRecoverablePendingSends()
    } catch GatewayError.revisionConflict(let canonical) {
      await recordConflict(canonical, pending: .delete(id: id))
    } catch GatewayError.notFound {
      await removeStale(
        expectedCanonical: current,
        pending: .delete(id: id)
      )
    } catch GatewayError.conversationBusy(let activeTurnID) {
      mutationError = .conversationBusy(
        conversationID: id,
        activeTurnID: activeTurnID
      )
      await reportGatewayError(GatewayError.conversationBusy(activeTurnId: activeTurnID))
    } catch GatewayError.validation(let message)
      where isArchivedReadOnlyValidation(message)
    {
      await reconcileReadOnlyMutation(
        conversationID: id,
        message: message,
        expectedCanonical: current,
        pending: .delete(id: id)
      )
    } catch is CancellationError {
      return
    } catch {
      mutationError = .failed
      await reportGatewayError(error)
    }
  }

  /// Best-effort cleanup for the compose-first flow (Task 3 review, I1):
  /// deletes a compose-created conversation IF it's still completely unused
  /// (no messages, no active turn) when the user leaves it — so backing out
  /// of compose without ever sending anything doesn't leave a permanent
  /// empty "New Conversation" row behind (the exact anti-pattern audit #16
  /// targets; the pre-compose-first `NewConversationView` Form never had
  /// this problem since creation only happened after an explicit "Start
  /// conversation" tap, never just from navigating to the screen).
  ///
  /// No-ops for any id NOT created via `create(agentID:)` THIS session — a
  /// conversation the user opened normally (however empty) is never
  /// touched. Each id can only ever be asked about once: the tracking
  /// entry is consumed on the first ask, `hasActivity` or not.
  ///
  /// Deliberately calls the low-level `service.delete(id:revision:)`
  /// directly rather than the public `delete(id:confirmed:)` this mirrors:
  /// that method's failure paths call `reportGatewayError`, which can flip
  /// the WHOLE APP's connection banner (`AppModel`'s `gatewayErrorHandler`
  /// reacts to it) — much too loud a side effect for a background cleanup
  /// the user never asked for and has no way to know failed. Any failure
  /// here (offline, conflict, already gone, network) is swallowed by
  /// design: the conversation — real but harmless and empty — is simply
  /// left for the user to clean up manually later (swipe-to-delete), same
  /// as if this method didn't exist. A 409-busy failure specifically can't
  /// happen here: `hasActivity == false` (checked above) already implies
  /// no active turn, which is the only thing that makes a delete busy.
  func discardIfUnusedComposeCreation(id: String, hasActivity: Bool) async {
    guard composeCreatedConversationIDs.remove(id) != nil else { return }
    guard hasActivity == false else { return }
    guard let current = allConversations.first(where: { $0.id == id })?.summary else { return }
    do {
      _ = try await service.delete(id: id, revision: current.revision)
      removeVisible(id: id)
    } catch {
      // Swallowed by design — see doc comment.
    }
  }

  func retryConflict() async {
    guard let pendingConflict else { return }
    mutationError = nil
    switch pendingConflict {
    case .rename(let id, let title):
      await rename(id: id, title: title)
    case .delete(let id):
      await delete(id: id, confirmed: true)
    }
  }

  private func requireMutation() -> Bool {
    guard mutationsAllowed else {
      mutationError = .offline
      return false
    }
    return true
  }

  private func scheduleOnlineRefresh() {
    onlineRefreshGeneration &+= 1
    let generation = onlineRefreshGeneration
    onlineRefreshTask?.cancel()
    onlineRefreshTask = Task { [weak self] in
      guard let self, Task.isCancelled == false else { return }
      await self.refresh()
      guard self.onlineRefreshGeneration == generation else { return }
      self.onlineRefreshTask = nil
    }
  }

  /// Returns the resolved conversation's id on success, `nil` otherwise.
  @discardableResult
  private func resolveCreate(_ canonical: ConversationSummaryDTO) async -> String? {
    await service.clearRetainedCreateRequestID(agentID: canonical.agentId)
    pendingCreateRequestID = nil
    pendingCreateAgentID = nil
    let reconciliation = replaceVisible(canonical, insertAtFront: true)
    await publishLifecycleChange(for: canonical, reconciliation: reconciliation)
    switch reconciliation {
    case .visible(let effective):
      mutationError = nil
      selectedID = effective.id
      // Compose-first new chat (Task 3, audit #16 / review fix I1): every
      // caller of the public `create(agentID:)` is a compose-flow entry
      // point (`ConversationListView.startCompose()` or
      // `ChatView.switchAgent(to:)`) — there is no other caller — so
      // tracking every successful resolution here scopes
      // `discardIfUnusedComposeCreation` precisely to "created via compose
      // this session," never a conversation the user opened normally.
      composeCreatedConversationIDs.insert(effective.id)
      return effective.id
    case .hidden:
      // Review fix I2: a create that reconciles as an already-tombstoned
      // canonical (e.g. a revision race where the just-created conversation
      // was deleted before this reconciliation ran) must NOT be reported as
      // success — `selectedID` would otherwise stay silently stale (still
      // pointing at whatever was selected before this call), and callers
      // gating navigation on "no error" would wrongly proceed to whatever
      // that stale id happens to be. Surfacing `.failed` makes this
      // (extremely rare) race visible instead of an invisible no-op.
      mutationError = .failed
      return nil
    }
  }

  /// Returns the resolved conversation's id on success, `nil` otherwise —
  /// see `create(agentID:)`'s doc comment.
  @discardableResult
  private func reconcileCreate(_ request: CreateConversationRequest) async -> String? {
    do {
      let canonical = try await service.reconcileCreate(request)
      return await resolveCreate(canonical)
    } catch GatewayError.mutationOutcomeUnknown, GatewayError.transport {
      mutationError = .outcomeUnknown
      return nil
    } catch is CancellationError {
      return nil
    } catch {
      mutationError = .failed
      await reportGatewayError(error)
      return nil
    }
  }

  private func recordConflict(
    _ canonical: ConversationSummaryDTO,
    pending: PendingConflict
  ) async {
    do {
      let persisted = try await service.replace(canonical)
      let reconciliation = replaceVisible(persisted)
      await publishLifecycleChange(for: persisted, reconciliation: reconciliation)
      switch reconciliation {
      case .visible(let effective):
        pendingConflict = pending
        mutationError = .revisionConflict(current: effective)
      case .hidden:
        pendingConflict = nil
        mutationError = nil
      }
    } catch is CancellationError {
      return
    } catch {
      mutationError = .failed
      await reportGatewayError(error)
    }
  }

  private func reconcileCanonical(
    _ incoming: ConversationSummaryDTO,
    current: ConversationSummaryDTO?
  ) -> CanonicalReconciliation {
    if incoming.status == .deleted {
      if let current, current.revision >= incoming.revision {
        suppressedConversationIDs.remove(current.id)
        tombstoneRevisionsByConversationID[current.id] = nil
        return .visible(current)
      }
      suppressTombstone(incoming)
      return .hidden
    }

    let effective: ConversationSummaryDTO
    if let current, current.revision > incoming.revision {
      effective = current
    } else {
      effective = incoming
    }
    if let tombstoneRevision = tombstoneRevisionsByConversationID[effective.id],
      effective.revision <= tombstoneRevision
    {
      return .hidden
    }
    suppressedConversationIDs.remove(effective.id)
    tombstoneRevisionsByConversationID[effective.id] = nil
    return .visible(effective)
  }

  private func suppressTombstone(_ value: ConversationSummaryDTO) {
    suppressedConversationIDs.insert(value.id)
    tombstoneRevisionsByConversationID[value.id] = max(
      tombstoneRevisionsByConversationID[value.id] ?? value.revision,
      value.revision
    )
  }

  private func removeStale(
    expectedCanonical: ConversationSummaryDTO,
    pending: PendingConflict
  ) async {
    let id = expectedCanonical.id
    if let latest = allConversations.first(where: { $0.id == id })?.summary,
      latest != expectedCanonical
    {
      pendingConflict = pending
      mutationError = .revisionConflict(current: latest)
      return
    }
    do {
      let outcome = try await service.remove(
        id: id,
        expectedCanonical: expectedCanonical
      )
      switch outcome {
      case .removed:
        if let latest = allConversations.first(where: { $0.id == id })?.summary,
          latest != expectedCanonical
        {
          pendingConflict = pending
          mutationError = .revisionConflict(current: latest)
          return
        }
        suppressedConversationIDs.insert(id)
        removeVisible(id: id)
        pendingConflict = nil
        mutationError = nil
        await publishLifecycleChanges([
          .removed(id: id, revisionFloor: expectedCanonical.revision)
        ])
        await reloadRecoverablePendingSends()

      case .retained(let canonical):
        let reconciliation = replaceVisible(canonical)
        await publishLifecycleChange(for: canonical, reconciliation: reconciliation)
        switch reconciliation {
        case .visible(let effective):
          pendingConflict = pending
          mutationError = .revisionConflict(current: effective)
        case .hidden:
          pendingConflict = nil
          mutationError = nil
        }
      }
    } catch is CancellationError {
      return
    } catch {
      mutationError = .failed
    }
  }

  private func shouldLoadOlder(currentID: String, in conversations: [CachedConversation]) -> Bool {
    guard let index = conversations.firstIndex(where: { $0.id == currentID }) else { return false }
    return index >= max(0, conversations.count - 5)
  }

  private func mergeOlder(
    _ values: [ConversationSummaryDTO]
  ) -> [ConversationLifecycleChange] {
    var lifecycleChanges: [ConversationLifecycleChange] = []
    for incoming in values {
      let index = allConversations.firstIndex { $0.id == incoming.id }
      let current = index.map { allConversations[$0].summary }
      let reconciliation = reconcileCanonical(incoming, current: current)
      if let change = lifecycleChange(for: incoming, reconciliation: reconciliation) {
        lifecycleChanges.append(change)
      }
      switch reconciliation {
      case .visible(let effective):
        let cached = CachedConversation(gatewayID: gatewayID, summary: effective)
        if let index {
          allConversations[index] = cached
        } else {
          allConversations.append(cached)
        }
      case .hidden:
        if let index {
          allConversations.remove(at: index)
        }
      }
    }
    return lifecycleChanges
  }

  private func lifecycleChange(
    for incoming: ConversationSummaryDTO,
    reconciliation: CanonicalReconciliation
  ) -> ConversationLifecycleChange? {
    switch reconciliation {
    case .visible(let effective):
      return .canonical(effective)
    case .hidden where incoming.status == .deleted:
      return .canonical(incoming)
    case .hidden:
      return nil
    }
  }

  private func publishLifecycleChange(
    for incoming: ConversationSummaryDTO,
    reconciliation: CanonicalReconciliation
  ) async {
    guard let change = lifecycleChange(for: incoming, reconciliation: reconciliation) else {
      return
    }
    await publishLifecycleChanges([change])
  }

  private func publishLifecycleChanges(_ changes: [ConversationLifecycleChange]) async {
    guard isPreparedForShutdown == false, changes.isEmpty == false else { return }
    _ = await lifecycleChangeHandler(changes)
  }

  @discardableResult
  private func replaceVisible(
    _ value: ConversationSummaryDTO,
    insertAtFront: Bool = false
  ) -> CanonicalReconciliation {
    listGeneration &+= 1
    let index = allConversations.firstIndex { $0.id == value.id }
    let current = index.map { allConversations[$0].summary }
    let reconciliation = reconcileCanonical(value, current: current)
    switch reconciliation {
    case .hidden:
      removeVisible(id: value.id)
    case .visible(let effective):
      let cached = CachedConversation(gatewayID: gatewayID, summary: effective)
      if let index {
        allConversations[index] = cached
      } else if insertAtFront {
        allConversations.insert(cached, at: 0)
      } else {
        allConversations.append(cached)
      }
      applyFilter()
    }
    return reconciliation
  }

  private func removeVisible(id: String) {
    listGeneration &+= 1
    allConversations.removeAll { $0.id == id }
    if selectedID == id { selectedID = nil }
    applyFilter()
  }

  private func reconcileReadOnlyMutation(
    conversationID: String,
    message: String,
    expectedCanonical: ConversationSummaryDTO,
    pending: PendingConflict
  ) async {
    do {
      let canonical = try await service.conversation(id: conversationID)
      let reconciliation = replaceVisible(canonical)
      await publishLifecycleChange(for: canonical, reconciliation: reconciliation)
      switch reconciliation {
      case .visible(let effective) where effective.status == .archived:
        pendingConflict = nil
        mutationError = .readOnly(conversationID: conversationID)
      case .visible(let effective):
        pendingConflict = pending
        mutationError = .revisionConflict(current: effective)
      case .hidden:
        pendingConflict = nil
        mutationError = .failed
      }
      await reportGatewayError(GatewayError.validation(message))
    } catch GatewayError.notFound {
      await removeStale(
        expectedCanonical: expectedCanonical,
        pending: pending
      )
    } catch is CancellationError {
      return
    } catch {
      mutationError = .failed
      await reportGatewayError(error)
    }
  }

  private func isArchivedReadOnlyValidation(_ message: String) -> Bool {
    let normalized = message.lowercased()
    return normalized.contains("archived conversation")
      && (normalized.contains("cannot be updated") || normalized.contains("cannot be deleted"))
  }

  private func reportGatewayError(_ error: Error) async {
    guard let gatewayError = error as? GatewayError else { return }
    switch gatewayError {
    case .unauthorized:
      connection = .repairRequired
    case .rateLimited:
      connection = .offline
    case .gatewayOffline:
      connection = .gatewayOffline
    case .updateRequired, .capabilityRequired:
      connection = .updateRequired
    case .transport, .server:
      connection = .offline
    case .notFound, .validation, .revisionConflict, .conversationBusy,
      .mutationOutcomeUnknown:
      break
    }
    if connection != .online { isAuthoritative = false }
    await gatewayErrorHandler(gatewayError)
  }

  private func applyFilter() {
    guard let selectedAgentID else {
      conversations = allConversations
      return
    }
    conversations = allConversations.filter { $0.summary.agentId == selectedAgentID }
  }
}
