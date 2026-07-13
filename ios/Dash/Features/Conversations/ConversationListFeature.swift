import Foundation
import Observation

enum ConversationMutationError: Equatable, Sendable {
  case offline
  case invalidTitle
  case outcomeUnknown
  case revisionConflict(current: ConversationSummaryDTO)
  case failed
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
  func create(_ request: CreateConversationRequest) async throws -> ConversationSummaryDTO
  func reconcileCreate(
    _ request: CreateConversationRequest
  ) async throws -> ConversationSummaryDTO
  func rename(id: String, title: String, revision: Int) async throws -> ConversationSummaryDTO
  func delete(id: String, revision: Int) async throws -> ConversationSummaryDTO
  func replace(_ summary: ConversationSummaryDTO) async throws
  func remove(id: String) async throws
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
  func removeConversation(gatewayID: String, conversationID: String) async throws
}

extension PersistenceStore: ConversationListPersisting {}

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
    try await store.upsertConversations(page.items, gatewayID: gatewayID)
    try validate(lifecycle)
    return page
  }

  func create(_ request: CreateConversationRequest) async throws -> ConversationSummaryDTO {
    let lifecycle = try beginOperation()
    defer { finishOperation() }
    let summary = try await resolvedAPI().createConversation(request)
    try validate(lifecycle)
    do {
      try await replace(summary)
    } catch is CancellationError {
      throw CancellationError()
    } catch {
      throw GatewayError.mutationOutcomeUnknown(
        resourceID: summary.id,
        requestID: request.requestId
      )
    }
    try validate(lifecycle)
    return summary
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
    do {
      try await replace(summary)
    } catch is CancellationError {
      throw CancellationError()
    } catch {
      throw GatewayError.mutationOutcomeUnknown(
        resourceID: summary.id,
        requestID: request.requestId
      )
    }
    try validate(lifecycle)
    return summary
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

  func replace(_ summary: ConversationSummaryDTO) async throws {
    let lifecycle = try beginOperation()
    defer { finishOperation() }
    if summary.status == .deleted {
      try await store.applyTombstone(summary, gatewayID: gatewayID)
    } else {
      try await store.upsertConversations([summary], gatewayID: gatewayID)
    }
    try validate(lifecycle)
  }

  func remove(id: String) async throws {
    let lifecycle = try beginOperation()
    defer { finishOperation() }
    try await store.removeConversation(gatewayID: gatewayID, conversationID: id)
    try validate(lifecycle)
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
      try await replace(summary)
      return summary
    } catch is CancellationError {
      throw CancellationError()
    } catch {
      let current = try await api.conversation(id: summary.id)
      guard current.revision >= summary.revision else { throw GatewayError.updateRequired }
      try await replace(current)
      return current
    }
  }
}

@MainActor
@Observable
final class ConversationListFeature {
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

  var mutationsAllowed: Bool { connection == .online }

  @ObservationIgnored private let gatewayID: String
  @ObservationIgnored private let service: any ConversationListServicing
  @ObservationIgnored private let requestID: @Sendable () -> UUID
  @ObservationIgnored private let pageSize: Int
  @ObservationIgnored private var allConversations: [CachedConversation] = []
  @ObservationIgnored private var connection: GatewayConnectionState = .connecting
  @ObservationIgnored private var loadedCursors: Set<String> = []
  @ObservationIgnored private var suppressedConversationIDs: Set<String> = []
  @ObservationIgnored private var listGeneration: UInt64 = 0
  @ObservationIgnored private var refreshQueued = false
  @ObservationIgnored private var hasStarted = false
  @ObservationIgnored private var hasFinishedInitialCacheLoad = false
  @ObservationIgnored private var onlineRefreshTask: Task<Void, Never>?
  @ObservationIgnored private var onlineRefreshGeneration: UInt64 = 0
  @ObservationIgnored private var pendingCreateRequestID: String?
  @ObservationIgnored private var pendingCreateAgentID: String?
  @ObservationIgnored private var pendingConflict: PendingConflict?
  @ObservationIgnored private var gatewayErrorHandler:
    @MainActor @Sendable (GatewayError) async -> Void = { _ in }

  init(
    gatewayID: String,
    service: any ConversationListServicing,
    requestID: @escaping @Sendable () -> UUID = { UUID() },
    pageSize: Int = 50
  ) {
    self.gatewayID = gatewayID
    self.service = service
    self.requestID = requestID
    self.pageSize = pageSize
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
    suppressedConversationIDs.formUnion(snapshot.removedConversationIDs)
    allConversations.removeAll { snapshot.removedConversationIDs.contains($0.id) }
    if let selectedID, snapshot.removedConversationIDs.contains(selectedID) {
      self.selectedID = nil
    }
    if let pendingConflict {
      let conflictID: String
      switch pendingConflict {
      case .rename(let id, _), .delete(let id): conflictID = id
      }
      if snapshot.removedConversationIDs.contains(conflictID) {
        self.pendingConflict = nil
        if case .some(.revisionConflict) = mutationError {
          mutationError = nil
        }
      }
    }
    let scoped = snapshot.conversations.filter {
      $0.gatewayID == gatewayID && suppressedConversationIDs.contains($0.id) == false
    }
    let current = Dictionary(uniqueKeysWithValues: allConversations.map { ($0.id, $0) })
    var merged = scoped.map { incoming in
      guard let existing = current[incoming.id] else { return incoming }
      return existing.summary.revision > incoming.summary.revision ? existing : incoming
    }
    let incomingIDs = Set(scoped.map(\.id))
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
    if hasFinishedInitialCacheLoad, wasOnline == false, mutationsAllowed {
      scheduleOnlineRefresh()
    }
  }

  func setGatewayErrorHandler(
    _ handler: @escaping @MainActor @Sendable (GatewayError) async -> Void
  ) {
    gatewayErrorHandler = handler
  }

  func prepareForShutdown() {
    listGeneration &+= 1
    onlineRefreshGeneration &+= 1
    onlineRefreshTask?.cancel()
    onlineRefreshTask = nil
    refreshQueued = false
    connection = .offline
    isAuthoritative = false
  }

  func shutdown() async {
    prepareForShutdown()
    await service.shutdown()
  }

  func start() async {
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
        suppressedConversationIDs.formUnion(
          page.items.filter { $0.status == .deleted }.map(\.id)
        )
        allConversations = page.items.compactMap {
          guard
            $0.status != .deleted,
            suppressedConversationIDs.contains($0.id) == false
          else { return nil }
          return CachedConversation(gatewayID: gatewayID, summary: $0)
        }
        agents = refreshedAgents
        nextCursor = page.nextCursor
        isAuthoritative = true
        mutationError = nil
        applyFilter()
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
    }
  }

  func loadAgentChoices() async {
    do {
      agents = try await service.cachedAgents()
    } catch is CancellationError {
      return
    } catch {
      mutationError = .failed
      await reportGatewayError(error)
    }
    guard mutationsAllowed else { return }
    do {
      agents = try await service.refreshAgents()
    } catch is CancellationError {
      return
    } catch {
      mutationError = .failed
      await reportGatewayError(error)
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

  func loadOlderIfNeeded(currentID: String) async {
    guard
      mutationsAllowed,
      isLoadingOlder == false,
      isRefreshing == false,
      let cursor = nextCursor,
      loadedCursors.contains(cursor) == false,
      shouldLoadOlder(currentID: currentID)
    else { return }
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
      mergeOlder(page.items)
      nextCursor = page.nextCursor
      isAuthoritative = true
      mutationError = nil
      applyFilter()
    } catch is CancellationError {
      return
    } catch {
      mutationError = .failed
      await reportGatewayError(error)
    }
  }

  func create(agentID: String) async {
    guard requireMutation() else { return }
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
      await resolveCreate(canonical)
    } catch is CancellationError {
      return
    } catch let error as GatewayError {
      switch error {
      case .mutationOutcomeUnknown, .transport:
        await reconcileCreate(request)
      default:
        await reportGatewayError(error)
        await service.clearRetainedCreateRequestID(agentID: agentID)
        pendingCreateRequestID = nil
        pendingCreateAgentID = nil
        mutationError = .failed
      }
    } catch {
      await service.clearRetainedCreateRequestID(agentID: agentID)
      pendingCreateRequestID = nil
      pendingCreateAgentID = nil
      mutationError = .failed
      await reportGatewayError(error)
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
      replaceVisible(canonical)
      pendingConflict = nil
      mutationError = nil
    } catch GatewayError.revisionConflict(let canonical) {
      await recordConflict(canonical, pending: .rename(id: id, title: trimmed))
    } catch GatewayError.notFound {
      await removeStale(id: id)
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
      guard tombstone.status == .deleted else {
        mutationError = .failed
        return
      }
      suppressedConversationIDs.insert(id)
      removeVisible(id: id)
      pendingConflict = nil
      mutationError = nil
    } catch GatewayError.revisionConflict(let canonical) {
      await recordConflict(canonical, pending: .delete(id: id))
    } catch GatewayError.notFound {
      await removeStale(id: id)
    } catch is CancellationError {
      return
    } catch {
      mutationError = .failed
      await reportGatewayError(error)
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

  private func resolveCreate(_ canonical: ConversationSummaryDTO) async {
    await service.clearRetainedCreateRequestID(agentID: canonical.agentId)
    pendingCreateRequestID = nil
    pendingCreateAgentID = nil
    mutationError = nil
    replaceVisible(canonical, insertAtFront: true)
    selectedID = canonical.id
  }

  private func reconcileCreate(_ request: CreateConversationRequest) async {
    do {
      let canonical = try await service.reconcileCreate(request)
      await resolveCreate(canonical)
    } catch GatewayError.mutationOutcomeUnknown, GatewayError.transport {
      mutationError = .outcomeUnknown
    } catch is CancellationError {
      return
    } catch {
      mutationError = .failed
      await reportGatewayError(error)
    }
  }

  private func recordConflict(
    _ canonical: ConversationSummaryDTO,
    pending: PendingConflict
  ) async {
    do {
      try await service.replace(canonical)
      replaceVisible(canonical)
      guard canonical.status != .deleted else {
        pendingConflict = nil
        mutationError = nil
        return
      }
      pendingConflict = pending
      mutationError = .revisionConflict(current: canonical)
    } catch is CancellationError {
      return
    } catch {
      mutationError = .failed
      await reportGatewayError(error)
    }
  }

  private func removeStale(id: String) async {
    do {
      try await service.remove(id: id)
      suppressedConversationIDs.insert(id)
      removeVisible(id: id)
      pendingConflict = nil
      mutationError = nil
    } catch is CancellationError {
      return
    } catch {
      mutationError = .failed
    }
  }

  private func shouldLoadOlder(currentID: String) -> Bool {
    guard let index = conversations.firstIndex(where: { $0.id == currentID }) else { return false }
    return index >= max(0, conversations.count - 5)
  }

  private func mergeOlder(_ values: [ConversationSummaryDTO]) {
    for value in values {
      if value.status == .deleted {
        suppressedConversationIDs.insert(value.id)
        allConversations.removeAll { $0.id == value.id }
        continue
      }
      guard suppressedConversationIDs.contains(value.id) == false else { continue }
      if let index = allConversations.firstIndex(where: { $0.id == value.id }) {
        if value.revision >= allConversations[index].summary.revision {
          allConversations[index] = CachedConversation(gatewayID: gatewayID, summary: value)
        }
      } else {
        allConversations.append(CachedConversation(gatewayID: gatewayID, summary: value))
      }
    }
  }

  private func replaceVisible(
    _ value: ConversationSummaryDTO,
    insertAtFront: Bool = false
  ) {
    listGeneration &+= 1
    if value.status == .deleted {
      suppressedConversationIDs.insert(value.id)
      removeVisible(id: value.id)
      return
    }
    let cached = CachedConversation(gatewayID: gatewayID, summary: value)
    if let index = allConversations.firstIndex(where: { $0.id == value.id }) {
      guard value.revision >= allConversations[index].summary.revision else { return }
      allConversations[index] = cached
    } else if insertAtFront {
      allConversations.insert(cached, at: 0)
    } else {
      allConversations.append(cached)
    }
    applyFilter()
  }

  private func removeVisible(id: String) {
    listGeneration &+= 1
    allConversations.removeAll { $0.id == id }
    if selectedID == id { selectedID = nil }
    applyFilter()
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
