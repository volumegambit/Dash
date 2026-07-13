import Foundation
import Observation

struct AgentEditorDraft: Equatable, Sendable {
  var name: String
  var model: String
  var systemPrompt: String
}

enum AgentModelChoice: Equatable, Hashable, Sendable {
  case configured(String)
  case catalog(ModelDTO)

  var value: String {
    switch self {
    case .configured(let value): value
    case .catalog(let model): model.value
    }
  }
}

protocol AgentsServicing: Actor {
  func cachedAgents() async throws -> [RegisteredAgentDTO]
  func refreshAgents() async throws -> [RegisteredAgentDTO]
  func models() async throws -> [ModelDTO]
  func create(_ request: CreateAgentRequest) async throws -> RegisteredAgentDTO
  func update(id: String, request: UpdateAgentRequest) async throws -> RegisteredAgentDTO
  func setEnabled(id: String, enabled: Bool) async throws -> RegisteredAgentDTO
  func delete(id: String) async throws
  func startConversation(agentID: String) async throws -> ConversationSummaryDTO
  func shutdown() async
}

protocol AgentsGatewayServicing: Actor {
  func listAgents() async throws -> [RegisteredAgentDTO]
  func agent(id: String) async throws -> RegisteredAgentDTO
  func createAgent(_ request: CreateAgentRequest) async throws -> RegisteredAgentDTO
  func updateAgent(
    id: String,
    request: UpdateAgentRequest
  ) async throws -> RegisteredAgentDTO
  func setAgentEnabled(id: String, enabled: Bool) async throws
  func deleteAgent(id: String) async throws
  func models() async throws -> ModelsResponseDTO
  func shutdown() async
}

extension GatewayAPI: AgentsGatewayServicing {}

actor LiveAgentsService: AgentsServicing {
  private let gatewayID: String
  private let store: any ConversationListPersisting
  private let makeAPI: @Sendable () async throws -> any AgentsGatewayServicing
  private let conversations: any ConversationListServicing
  private var cachedAPI: (any AgentsGatewayServicing)?
  private var lifecycleGeneration: UInt64 = 0
  private var activeOperations = 0
  private var isShutdown = false
  private var shutdownWaiters: [CheckedContinuation<Void, Never>] = []

  init(
    gatewayID: String,
    store: any ConversationListPersisting,
    conversations: any ConversationListServicing,
    makeAPI: @escaping @Sendable () async throws -> any AgentsGatewayServicing
  ) {
    self.gatewayID = gatewayID
    self.store = store
    self.conversations = conversations
    self.makeAPI = makeAPI
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

  func models() async throws -> [ModelDTO] {
    let lifecycle = try beginOperation()
    defer { finishOperation() }
    let values = try await resolvedAPI().models().models
    try validate(lifecycle)
    return values
  }

  func create(_ request: CreateAgentRequest) async throws -> RegisteredAgentDTO {
    let lifecycle = try beginOperation()
    defer { finishOperation() }
    let value = try await resolvedAPI().createAgent(request)
    try validate(lifecycle)
    try await persist(value)
    try validate(lifecycle)
    return value
  }

  func update(id: String, request: UpdateAgentRequest) async throws -> RegisteredAgentDTO {
    let lifecycle = try beginOperation()
    defer { finishOperation() }
    let value = try await resolvedAPI().updateAgent(id: id, request: request)
    try validate(lifecycle)
    try await persist(value)
    try validate(lifecycle)
    return value
  }

  func setEnabled(id: String, enabled: Bool) async throws -> RegisteredAgentDTO {
    let lifecycle = try beginOperation()
    defer { finishOperation() }
    let api = try await resolvedAPI()
    try validate(lifecycle)
    try await api.setAgentEnabled(id: id, enabled: enabled)
    try validate(lifecycle)
    let value = try await api.agent(id: id)
    try validate(lifecycle)
    try await persist(value)
    try validate(lifecycle)
    return value
  }

  func delete(id: String) async throws {
    let lifecycle = try beginOperation()
    defer { finishOperation() }
    try await resolvedAPI().deleteAgent(id: id)
    try validate(lifecycle)
    let retained = try await store.agents(gatewayID: gatewayID).filter { $0.id != id }
    try await store.replaceAgents(retained, gatewayID: gatewayID)
    try validate(lifecycle)
  }

  func startConversation(agentID: String) async throws -> ConversationSummaryDTO {
    let lifecycle = try beginOperation()
    defer { finishOperation() }
    let suggested = UUID().uuidString.lowercased()
    let retained = await conversations.retainedCreateRequestID(
      agentID: agentID,
      suggested: suggested
    )
    let request = CreateConversationRequest(
      agentId: agentID,
      requestId: retained,
      title: nil,
      owningIssueId: nil,
      projectId: nil
    )
    do {
      let value = try await conversations.create(request)
      try validate(lifecycle)
      await conversations.clearRetainedCreateRequestID(agentID: agentID)
      try validate(lifecycle)
      return value
    } catch GatewayError.mutationOutcomeUnknown, GatewayError.transport {
      let value = try await conversations.reconcileCreate(request)
      try validate(lifecycle)
      await conversations.clearRetainedCreateRequestID(agentID: agentID)
      try validate(lifecycle)
      return value
    } catch is CancellationError {
      throw CancellationError()
    } catch {
      await conversations.clearRetainedCreateRequestID(agentID: agentID)
      throw error
    }
  }

  func shutdown() async {
    if isShutdown == false {
      isShutdown = true
      lifecycleGeneration &+= 1
    }
    if let cachedAPI {
      await cachedAPI.shutdown()
    }
    await conversations.shutdown()
    guard activeOperations > 0 else { return }
    await withCheckedContinuation { continuation in
      shutdownWaiters.append(continuation)
    }
  }

  private func persist(_ value: RegisteredAgentDTO) async throws {
    var values = try await store.agents(gatewayID: gatewayID)
    if let index = values.firstIndex(where: { $0.id == value.id }) {
      values[index] = value
    } else {
      values.append(value)
    }
    try await store.replaceAgents(values, gatewayID: gatewayID)
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

  private func resolvedAPI() async throws -> any AgentsGatewayServicing {
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
}

@MainActor
@Observable
final class AgentsFeature {
  private enum ReconciliationSource: Equatable {
    case cache
    case snapshot
    case authoritativeRefresh
  }

  var agents: [RegisteredAgentDTO] = []
  var models: [ModelDTO] = []
  var isAuthoritative = false
  var isRefreshing = false
  var mutationError: String?
  var startedConversationID: String?
  var savedAgentID: String?

  var mutationsAllowed: Bool { connection == .online }

  @ObservationIgnored private let gatewayID: String
  @ObservationIgnored private let service: any AgentsServicing
  @ObservationIgnored private var connection: GatewayConnectionState = .connecting
  @ObservationIgnored private var hasStarted = false
  @ObservationIgnored private var hasFinishedCacheLoad = false
  @ObservationIgnored private var refreshQueued = false
  @ObservationIgnored private var onlineRefreshTask: Task<Void, Never>?
  @ObservationIgnored private var onlineRefreshGeneration: UInt64 = 0
  @ObservationIgnored private var listGeneration: UInt64 = 0
  @ObservationIgnored private var optimisticStatuses: [String: RegisteredAgentStatus] = [:]
  @ObservationIgnored private var canonicalOverrides: [String: RegisteredAgentDTO] = [:]
  @ObservationIgnored private var suppressedAgentIDs: Set<String> = []
  @ObservationIgnored private var gatewayErrorHandler:
    @MainActor @Sendable (GatewayError) async -> Void = { _ in }

  init(gatewayID: String, service: any AgentsServicing) {
    self.gatewayID = gatewayID
    self.service = service
  }

  func setGatewayErrorHandler(
    _ handler: @escaping @MainActor @Sendable (GatewayError) async -> Void
  ) {
    gatewayErrorHandler = handler
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
    applyAgents(snapshot.agents, source: .snapshot)
    if hasFinishedCacheLoad, wasOnline == false, mutationsAllowed {
      scheduleOnlineRefresh()
    }
  }

  func start() async {
    guard hasStarted == false else { return }
    hasStarted = true
    let generation = listGeneration
    do {
      let cached = try await service.cachedAgents()
      guard generation == listGeneration else {
        hasFinishedCacheLoad = true
        if mutationsAllowed { await refresh() }
        return
      }
      applyAgents(cached, source: .cache)
      isAuthoritative = false
    } catch is CancellationError {
      hasStarted = false
      hasFinishedCacheLoad = false
      return
    } catch {
      mutationError = "Dash couldn't load cached agents."
    }
    hasFinishedCacheLoad = true
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
      let values = try await service.refreshAgents()
      if generation == listGeneration {
        applyAgents(values, source: .authoritativeRefresh)
        isAuthoritative = true
        mutationError = nil
      }
      await loadModels()
    } catch is CancellationError {
      refreshQueued = false
    } catch {
      if generation == listGeneration {
        isAuthoritative = false
        mutationError = "Dash couldn't refresh agents."
        await report(error)
      }
    }
    isRefreshing = false
    let shouldRefreshAgain = refreshQueued && mutationsAllowed
    refreshQueued = false
    if shouldRefreshAgain { await refresh() }
  }

  func loadModels() async {
    do {
      models = try await service.models().sorted {
        ($0.provider, $0.label, $0.value) < ($1.provider, $1.label, $1.value)
      }
    } catch is CancellationError {
      return
    } catch {
      mutationError = "Dash couldn't load the model catalog."
      await report(error)
    }
  }

  func modelChoices(configuredModel: String?) -> [AgentModelChoice] {
    var values = models.map(AgentModelChoice.catalog)
    if let configuredModel,
      configuredModel.isEmpty == false,
      models.contains(where: { $0.value == configuredModel }) == false
    {
      values.insert(.configured(configuredModel), at: 0)
    }
    return values
  }

  func create(_ draft: AgentEditorDraft) async {
    guard requireMutation() else { return }
    savedAgentID = nil
    let name = draft.name.trimmingCharacters(in: .whitespacesAndNewlines)
    let model = draft.model.trimmingCharacters(in: .whitespacesAndNewlines)
    let prompt = draft.systemPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
    guard name.isEmpty == false else {
      mutationError = "Enter an agent name."
      return
    }
    guard model.isEmpty == false else {
      mutationError = "Choose a model."
      return
    }
    do {
      let value = try await service.create(
        CreateAgentRequest(name: name, model: model, systemPrompt: prompt)
      )
      recordCanonical(value)
      savedAgentID = value.id
      mutationError = nil
    } catch is CancellationError {
      return
    } catch {
      await handleMutationFailure(error)
    }
  }

  func update(
    id: String,
    original: RegisteredAgentDTO,
    draft: AgentEditorDraft
  ) async {
    guard requireMutation() else { return }
    savedAgentID = nil
    let model = draft.model.trimmingCharacters(in: .whitespacesAndNewlines)
    let prompt = draft.systemPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
    guard model.isEmpty == false else {
      mutationError = "Choose a model."
      return
    }
    let request = UpdateAgentRequest(
      model: model == original.config.model ? nil : model,
      systemPrompt: prompt == original.config.systemPrompt ? nil : prompt
    )
    guard request.model != nil || request.systemPrompt != nil else {
      savedAgentID = original.id
      return
    }
    do {
      let value = try await service.update(id: id, request: request)
      recordCanonical(value)
      savedAgentID = value.id
      mutationError = nil
    } catch is CancellationError {
      return
    } catch {
      await handleMutationFailure(error)
    }
  }

  func setEnabled(id: String, enabled: Bool, confirmed: Bool) async {
    guard enabled || confirmed else { return }
    guard requireMutation() else { return }
    guard let prior = agents.first(where: { $0.id == id }) else { return }
    if enabled {
      optimisticStatuses[id] = .registered
      replaceDisplay(copy(prior, status: .registered))
    }
    do {
      let value = try await service.setEnabled(id: id, enabled: enabled)
      optimisticStatuses[id] = nil
      recordCanonical(value)
      mutationError = nil
    } catch is CancellationError {
      optimisticStatuses[id] = nil
      if enabled { replaceDisplay(prior) }
    } catch {
      optimisticStatuses[id] = nil
      if enabled { replaceDisplay(prior) }
      await handleMutationFailure(error)
    }
  }

  func delete(id: String, confirmedName: String) async {
    guard requireMutation() else { return }
    guard let value = agents.first(where: { $0.id == id }) else { return }
    guard confirmedName == value.name else {
      mutationError = "Enter the agent name exactly to delete it."
      return
    }
    do {
      try await service.delete(id: id)
      canonicalOverrides[id] = nil
      suppressedAgentIDs.insert(id)
      agents.removeAll { $0.id == id }
      mutationError = nil
    } catch is CancellationError {
      return
    } catch {
      await handleMutationFailure(error)
    }
  }

  func startChat(agentID: String) async {
    guard requireMutation() else { return }
    startedConversationID = nil
    do {
      let value = try await service.startConversation(agentID: agentID)
      startedConversationID = value.id
      mutationError = nil
    } catch is CancellationError {
      return
    } catch {
      await handleMutationFailure(error)
    }
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

  private func requireMutation() -> Bool {
    guard mutationsAllowed else {
      mutationError = "Connect to the gateway to make changes."
      return false
    }
    return true
  }

  private func handleMutationFailure(_ error: Error) async {
    if case GatewayError.notFound = error {
      await refresh()
      return
    }
    mutationError = "Dash couldn't complete the agent update."
    await report(error)
  }

  private func report(_ error: Error) async {
    guard let gatewayError = error as? GatewayError else { return }
    await gatewayErrorHandler(gatewayError)
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

  private func applyAgents(
    _ values: [RegisteredAgentDTO],
    source: ReconciliationSource
  ) {
    if source == .authoritativeRefresh {
      canonicalOverrides.removeAll()
      suppressedAgentIDs.removeAll()
    }
    let incomingIDs = Set(values.map(\.id))
    var reconciled: [RegisteredAgentDTO] = []
    for value in values {
      if suppressedAgentIDs.contains(value.id) { continue }
      if let canonical = canonicalOverrides[value.id] {
        reconciled.append(canonical)
        if source == .snapshot, canonical == value {
          canonicalOverrides[value.id] = nil
        }
      } else {
        reconciled.append(value)
      }
    }
    if source != .authoritativeRefresh {
      reconciled.append(
        contentsOf: canonicalOverrides.values.filter {
          incomingIDs.contains($0.id) == false && suppressedAgentIDs.contains($0.id) == false
        }
      )
    }
    if source == .snapshot {
      suppressedAgentIDs = Set(suppressedAgentIDs.filter { incomingIDs.contains($0) })
    }
    agents = reconciled.map { value in
      guard let status = optimisticStatuses[value.id] else { return value }
      return copy(value, status: status)
    }
    sortAgents()
  }

  private func recordCanonical(_ value: RegisteredAgentDTO) {
    canonicalOverrides[value.id] = value
    suppressedAgentIDs.remove(value.id)
    replaceDisplay(value)
  }

  private func replaceDisplay(_ value: RegisteredAgentDTO) {
    listGeneration &+= 1
    if let index = agents.firstIndex(where: { $0.id == value.id }) {
      agents[index] = value
    } else {
      agents.append(value)
    }
    sortAgents()
  }

  private func sortAgents() {
    agents.sort {
      let order = $0.name.localizedCaseInsensitiveCompare($1.name)
      if order == .orderedSame { return $0.id < $1.id }
      return order == .orderedAscending
    }
  }

  private func copy(
    _ value: RegisteredAgentDTO,
    status: RegisteredAgentStatus
  ) -> RegisteredAgentDTO {
    RegisteredAgentDTO(
      id: value.id,
      name: value.name,
      config: value.config,
      status: status,
      registeredAt: value.registeredAt
    )
  }
}
