import Foundation
import Testing

@testable import Dash

@Suite("Agent administration")
@MainActor
struct AgentsFeatureTests {
  @Test("cached agents publish before the first canonical refresh")
  func cachedFirst() async {
    let cached = agent(id: "cached", name: "Cached", status: .disabled)
    let fresh = agent(id: "fresh", name: "Fresh")
    let refreshGate = TestGate()
    let service = FakeAgentsService(cached: [cached], refreshGate: refreshGate)
    await service.enqueueRefresh(.success([fresh]))
    let feature = makeFeature(service: service)
    feature.consume(snapshot(connection: .online, agents: [cached]))

    let start = Task { await feature.start() }
    await refreshGate.waitUntilWaiting()

    #expect(feature.agents == [cached])
    #expect(feature.isAuthoritative == false)

    await refreshGate.release()
    await start.value

    #expect(feature.agents == [fresh])
    #expect(feature.isAuthoritative)
  }

  @Test("a sync snapshot wins over an older refresh and queues canonical reconciliation")
  func snapshotWinsRefreshRace() async {
    let stale = agent(id: "stale", name: "Stale")
    let snapshotValue = agent(id: "snapshot", name: "Snapshot")
    let canonical = agent(id: "canonical", name: "Canonical")
    let refreshGate = TestGate()
    let service = FakeAgentsService(refreshGate: refreshGate)
    await service.enqueueRefresh(.success([stale]))
    await service.enqueueRefresh(.success([canonical]))
    let feature = makeOnlineFeature(service: service)

    let refresh = Task { await feature.refresh() }
    await refreshGate.waitUntilWaiting()
    feature.consume(snapshot(connection: .online, agents: [snapshotValue]))

    #expect(feature.agents == [snapshotValue])

    await refreshGate.release()
    await refresh.value

    #expect(await service.refreshCallCount == 2)
    #expect(feature.agents == [canonical])
    #expect(feature.isAuthoritative)
  }

  @Test("create owns exactly name model and systemPrompt")
  func createOwnedFieldsOnly() async throws {
    let created = agent(id: "created", name: "Mobile agent")
    let service = FakeAgentsService()
    await service.enqueueCreate(.success(created))
    let feature = makeOnlineFeature(service: service)

    await feature.create(
      AgentEditorDraft(
        name: "  Mobile agent  ",
        model: "  openai/gpt-5  ",
        systemPrompt: "  Be useful.  "
      )
    )

    let request = try #require(await service.createRequests.first)
    let object = try #require(
      try JSONSerialization.jsonObject(with: ContractCoding.encoder().encode(request))
        as? [String: String]
    )
    #expect(Set(object.keys) == ["name", "model", "systemPrompt"])
    #expect(object["name"] == "Mobile agent")
    #expect(object["model"] == "openai/gpt-5")
    #expect(object["systemPrompt"] == "Be useful.")
    #expect(feature.agents == [created])
  }

  @Test("a buffered snapshot omission cannot hide a canonical create")
  func staleSnapshotPreservesCreate() async {
    let older = agent(id: "older", name: "Older")
    let created = agent(id: "created", name: "Created")
    let service = FakeAgentsService()
    await service.enqueueCreate(.success(created))
    let feature = makeOnlineFeature(service: service, agents: [older])

    await feature.create(
      AgentEditorDraft(name: created.name, model: created.config.model, systemPrompt: "")
    )
    feature.consume(snapshot(connection: .online, agents: [older]))

    #expect(feature.agents == [created, older])
  }

  @Test("edit sends only changed owned fields and a no-op sends nothing")
  func editOwnedFieldsOnly() async throws {
    let original = agent(id: "agent", model: "anthropic/old", prompt: "Original")
    let updated = agent(id: original.id, model: "openai/new", prompt: original.config.systemPrompt)
    let service = FakeAgentsService()
    await service.enqueueUpdate(.success(updated))
    let feature = makeOnlineFeature(service: service, agents: [original])

    await feature.update(
      id: original.id,
      original: original,
      draft: AgentEditorDraft(
        name: "Ignored rename", model: " openai/new ", systemPrompt: "Original")
    )

    let call = try #require(await service.updateCalls.first)
    let object = try #require(
      try JSONSerialization.jsonObject(with: ContractCoding.encoder().encode(call.request))
        as? [String: String]
    )
    #expect(Set(object.keys) == ["model"])

    await feature.update(
      id: updated.id,
      original: updated,
      draft: AgentEditorDraft(
        name: updated.name,
        model: updated.config.model,
        systemPrompt: updated.config.systemPrompt
      )
    )
    #expect(await service.updateCalls.count == 1)
  }

  @Test("a buffered snapshot cannot roll back a canonical edit")
  func staleSnapshotPreservesEdit() async {
    let original = agent(id: "agent", model: "anthropic/old")
    let updated = agent(id: original.id, model: "openai/new")
    let service = FakeAgentsService()
    await service.enqueueUpdate(.success(updated))
    let feature = makeOnlineFeature(service: service, agents: [original])

    await feature.update(
      id: original.id,
      original: original,
      draft: AgentEditorDraft(
        name: original.name,
        model: updated.config.model,
        systemPrompt: original.config.systemPrompt
      )
    )
    feature.consume(snapshot(connection: .online, agents: [original]))

    #expect(feature.agents == [updated])
  }

  @Test("an explicit canonical refresh retires local mutation overlays")
  func canonicalRefreshRetiresOverlay() async {
    let original = agent(id: "agent", model: "anthropic/old")
    let edited = agent(id: original.id, model: "openai/edited")
    let externallyUpdated = agent(id: original.id, model: "google/external")
    let service = FakeAgentsService()
    await service.enqueueUpdate(.success(edited))
    await service.enqueueRefresh(.success([externallyUpdated]))
    let feature = makeOnlineFeature(service: service, agents: [original])

    await feature.update(
      id: original.id,
      original: original,
      draft: AgentEditorDraft(
        name: original.name,
        model: edited.config.model,
        systemPrompt: original.config.systemPrompt
      )
    )
    feature.consume(snapshot(connection: .online, agents: [original]))
    #expect(feature.agents == [edited])

    await feature.refresh()

    #expect(feature.agents == [externallyUpdated])
  }

  @Test("a configured model missing from the catalog remains selectable")
  func missingConfiguredModel() async {
    let service = FakeAgentsService(
      models: [model("anthropic/current", provider: "anthropic")]
    )
    let feature = makeFeature(service: service)
    await feature.loadModels()

    #expect(
      feature.modelChoices(configuredModel: "legacy/private") == [
        .configured("legacy/private"),
        .catalog(model("anthropic/current", provider: "anthropic")),
      ]
    )
  }

  @Test("enable is optimistic and restores the exact DTO on failure")
  func optimisticEnableRollback() async {
    let disabled = agent(id: "agent", status: .disabled)
    let gate = TestGate()
    let service = FakeAgentsService(actionGate: gate)
    await service.enqueueAction(.failure(.gatewayOffline))
    let feature = makeOnlineFeature(service: service, agents: [disabled])

    let enable = Task { await feature.setEnabled(id: disabled.id, enabled: true, confirmed: true) }
    await gate.waitUntilWaiting()

    #expect(feature.agents.first?.status == .registered)

    await gate.release()
    await enable.value

    #expect(feature.agents == [disabled])
    #expect(feature.mutationError != nil)
  }

  @Test("disable sends nothing before confirmation")
  func disableRequiresConfirmation() async {
    let active = agent(id: "agent", status: .active)
    let disabled = agent(id: active.id, status: .disabled)
    let service = FakeAgentsService()
    await service.enqueueAction(.success(disabled))
    let feature = makeOnlineFeature(service: service, agents: [active])

    await feature.setEnabled(id: active.id, enabled: false, confirmed: false)
    #expect(await service.actionCalls.isEmpty)

    await feature.setEnabled(id: active.id, enabled: false, confirmed: true)
    #expect(await service.actionCalls == [.init(id: active.id, enabled: false)])
    #expect(feature.agents == [disabled])
  }

  @Test("delete requires the current name and leaves archived conversations to the service")
  func deleteRequiresExactName() async {
    let value = agent(id: "agent", name: "Exact Name")
    let service = FakeAgentsService(archivedConversationCount: 3)
    let feature = makeOnlineFeature(service: service, agents: [value])

    await feature.delete(id: value.id, confirmedName: "exact name")
    #expect(await service.deleteIDs.isEmpty)
    #expect(feature.agents == [value])

    await feature.delete(id: value.id, confirmedName: value.name)
    #expect(await service.deleteIDs == [value.id])
    #expect(await service.archivedConversationCount == 3)
    #expect(feature.agents.isEmpty)
  }

  @Test("a buffered snapshot cannot resurrect a deleted agent")
  func staleSnapshotDoesNotResurrectDelete() async {
    let value = agent(id: "agent", name: "Delete me")
    let service = FakeAgentsService()
    let feature = makeOnlineFeature(service: service, agents: [value])

    await feature.delete(id: value.id, confirmedName: value.name)
    feature.consume(snapshot(connection: .online, agents: [value]))

    #expect(feature.agents.isEmpty)
  }

  @Test("a stale 404 refreshes the canonical agent list")
  func notFoundRefreshes() async {
    let stale = agent(id: "stale")
    let canonical = agent(id: "canonical")
    let service = FakeAgentsService()
    await service.enqueueUpdate(.failure(.notFound))
    await service.enqueueRefresh(.success([canonical]))
    let feature = makeOnlineFeature(service: service, agents: [stale])

    await feature.update(
      id: stale.id,
      original: stale,
      draft: AgentEditorDraft(
        name: stale.name,
        model: "new/model",
        systemPrompt: stale.config.systemPrompt
      )
    )

    #expect(await service.refreshCallCount == 1)
    #expect(feature.agents == [canonical])
  }

  @Test("every write is disabled without canonical authority")
  func offlineDisablesWrites() async {
    let value = agent(id: "agent")
    let service = FakeAgentsService()
    let feature = makeFeature(service: service)
    feature.consume(snapshot(connection: .offline, agents: [value]))

    await feature.create(AgentEditorDraft(name: "New", model: "model", systemPrompt: "Prompt"))
    await feature.update(
      id: value.id,
      original: value,
      draft: AgentEditorDraft(name: value.name, model: "new/model", systemPrompt: "Prompt")
    )
    await feature.setEnabled(id: value.id, enabled: false, confirmed: true)
    await feature.delete(id: value.id, confirmedName: value.name)
    await feature.startChat(agentID: value.id)

    #expect(await service.mutationCallCount == 0)
    #expect(feature.mutationError != nil)
  }

  @Test("start chat exposes only the canonical conversation ID")
  func startChatUsesCanonicalConversation() async {
    let value = agent(id: "agent")
    let conversation = conversationSummary(id: "canonical-conversation", agent: value)
    let service = FakeAgentsService()
    await service.enqueueConversation(.success(conversation))
    let feature = makeOnlineFeature(service: service, agents: [value])

    await feature.startChat(agentID: value.id)

    #expect(await service.startedAgentIDs == [value.id])
    #expect(feature.startedConversationID == conversation.id)
  }

  @Test("offline Start Chat cannot reuse a prior conversation destination")
  func offlineStartChatClearsPriorDestination() async {
    let value = agent(id: "agent")
    let conversation = conversationSummary(id: "prior-conversation", agent: value)
    let service = FakeAgentsService()
    await service.enqueueConversation(.success(conversation))
    let feature = makeOnlineFeature(service: service, agents: [value])
    await feature.startChat(agentID: value.id)
    #expect(feature.startedConversationID == conversation.id)

    feature.consume(snapshot(connection: .offline, agents: [value]))
    await feature.startChat(agentID: value.id)

    #expect(await service.startedAgentIDs == [value.id])
    #expect(feature.startedConversationID == nil)
  }

  private func makeFeature(service: FakeAgentsService) -> AgentsFeature {
    AgentsFeature(gatewayID: "gateway", service: service)
  }

  private func makeOnlineFeature(
    service: FakeAgentsService,
    agents: [RegisteredAgentDTO] = []
  ) -> AgentsFeature {
    let feature = makeFeature(service: service)
    feature.consume(snapshot(connection: .online, agents: agents))
    return feature
  }

  private func snapshot(
    connection: GatewayConnectionState,
    agents: [RegisteredAgentDTO]
  ) -> SyncSnapshot {
    SyncSnapshot(
      connection: connection,
      conversations: [],
      agents: agents,
      lastSuccessfulSyncAt: nil
    )
  }

  private func agent(
    id: String,
    name: String = "Agent",
    model: String = "anthropic/model",
    prompt: String = "Be useful",
    status: RegisteredAgentStatus = .registered
  ) -> RegisteredAgentDTO {
    RegisteredAgentDTO(
      id: id,
      name: name,
      config: AgentConfigDTO(
        name: name,
        model: model,
        systemPrompt: prompt,
        fallbackModels: ["fallback/model"],
        tools: ["read"],
        skills: AgentSkillsDTO(paths: ["skills/core"], urls: ["https://example.test/skill"]),
        workspace: "/workspace",
        maxTokens: 4_096,
        mcpServers: ["docs"],
        swarm: AgentSwarmDTO(
          enabled: true,
          maxConcurrentWorkers: 4,
          maxWorkersPerRun: 2,
          maxSteersPerWorker: 3,
          maxRunSeconds: 120,
          allowedModels: [model]
        ),
        plugins: ["core"],
        providers: ["anthropic"]
      ),
      status: status,
      registeredAt: Date(timeIntervalSince1970: 10)
    )
  }

  private func model(_ value: String, provider: String) -> ModelDTO {
    ModelDTO(value: value, label: value, provider: provider)
  }

  private func conversationSummary(
    id: String,
    agent: RegisteredAgentDTO
  ) -> ConversationSummaryDTO {
    ConversationSummaryDTO(
      id: id,
      agentId: agent.id,
      agentName: agent.name,
      title: "New conversation",
      revision: 1,
      status: .idle,
      activeTurnId: nil,
      owningIssueId: nil,
      projectId: nil,
      lastSeq: 0,
      lastMessagePreview: nil,
      createdAt: Date(timeIntervalSince1970: 10),
      updatedAt: Date(timeIntervalSince1970: 10),
      deletedAt: nil
    )
  }
}

private enum FakeAgentsResult<Value: Sendable>: Sendable {
  case success(Value)
  case failure(GatewayError)

  func get() throws -> Value {
    switch self {
    case .success(let value): value
    case .failure(let error): throw error
    }
  }
}

private actor FakeAgentsService: AgentsServicing {
  struct UpdateCall: Sendable {
    let id: String
    let request: UpdateAgentRequest
  }

  struct ActionCall: Equatable, Sendable {
    let id: String
    let enabled: Bool
  }

  private let cached: [RegisteredAgentDTO]
  private let modelValues: [ModelDTO]
  private let refreshGate: TestGate?
  private let actionGate: TestGate?
  private var refreshResults: [FakeAgentsResult<[RegisteredAgentDTO]>] = []
  private var createResults: [FakeAgentsResult<RegisteredAgentDTO>] = []
  private var updateResults: [FakeAgentsResult<RegisteredAgentDTO>] = []
  private var actionResults: [FakeAgentsResult<RegisteredAgentDTO>] = []
  private var conversationResults: [FakeAgentsResult<ConversationSummaryDTO>] = []

  private(set) var createRequests: [CreateAgentRequest] = []
  private(set) var updateCalls: [UpdateCall] = []
  private(set) var actionCalls: [ActionCall] = []
  private(set) var deleteIDs: [String] = []
  private(set) var startedAgentIDs: [String] = []
  private(set) var refreshCallCount = 0
  private(set) var archivedConversationCount: Int

  init(
    cached: [RegisteredAgentDTO] = [],
    models: [ModelDTO] = [],
    refreshGate: TestGate? = nil,
    actionGate: TestGate? = nil,
    archivedConversationCount: Int = 0
  ) {
    self.cached = cached
    modelValues = models
    self.refreshGate = refreshGate
    self.actionGate = actionGate
    self.archivedConversationCount = archivedConversationCount
  }

  var mutationCallCount: Int {
    createRequests.count + updateCalls.count + actionCalls.count + deleteIDs.count
      + startedAgentIDs.count
  }

  func enqueueRefresh(_ result: FakeAgentsResult<[RegisteredAgentDTO]>) {
    refreshResults.append(result)
  }

  func enqueueCreate(_ result: FakeAgentsResult<RegisteredAgentDTO>) {
    createResults.append(result)
  }

  func enqueueUpdate(_ result: FakeAgentsResult<RegisteredAgentDTO>) {
    updateResults.append(result)
  }

  func enqueueAction(_ result: FakeAgentsResult<RegisteredAgentDTO>) {
    actionResults.append(result)
  }

  func enqueueConversation(_ result: FakeAgentsResult<ConversationSummaryDTO>) {
    conversationResults.append(result)
  }

  func cachedAgents() -> [RegisteredAgentDTO] { cached }

  func refreshAgents() async throws -> [RegisteredAgentDTO] {
    refreshCallCount += 1
    await refreshGate?.wait()
    guard refreshResults.isEmpty == false else { return cached }
    return try refreshResults.removeFirst().get()
  }

  func models() -> [ModelDTO] { modelValues }

  func create(_ request: CreateAgentRequest) throws -> RegisteredAgentDTO {
    createRequests.append(request)
    guard createResults.isEmpty == false else { throw GatewayError.updateRequired }
    return try createResults.removeFirst().get()
  }

  func update(id: String, request: UpdateAgentRequest) throws -> RegisteredAgentDTO {
    updateCalls.append(UpdateCall(id: id, request: request))
    guard updateResults.isEmpty == false else { throw GatewayError.updateRequired }
    return try updateResults.removeFirst().get()
  }

  func setEnabled(id: String, enabled: Bool) async throws -> RegisteredAgentDTO {
    actionCalls.append(ActionCall(id: id, enabled: enabled))
    await actionGate?.wait()
    guard actionResults.isEmpty == false else { throw GatewayError.updateRequired }
    return try actionResults.removeFirst().get()
  }

  func delete(id: String) {
    deleteIDs.append(id)
  }

  func startConversation(agentID: String) throws -> ConversationSummaryDTO {
    startedAgentIDs.append(agentID)
    guard conversationResults.isEmpty == false else { throw GatewayError.updateRequired }
    return try conversationResults.removeFirst().get()
  }

  func shutdown() {}
}

@Suite("Live agents service")
struct LiveAgentsServiceTests {
  private let gatewayID = "gateway-agents-service"

  @Test("deleting an agent removes only the agent cache and preserves archived conversations")
  func deletePreservesConversations() async throws {
    let store = try PersistenceStore.inMemory()
    let value = serviceAgent()
    let conversation = serviceConversation(agent: value)
    try await store.replaceAgents([value], gatewayID: gatewayID)
    try await store.upsertConversations([conversation], gatewayID: gatewayID)
    let conversations = AgentServiceConversationStub()
    let gateway = AgentServiceGatewayStub()
    let service = makeService(
      store: store,
      conversations: conversations,
      gateway: gateway
    )

    try await service.delete(id: value.id)

    #expect(try await store.agents(gatewayID: gatewayID).isEmpty)
    #expect(
      try await store.conversation(gatewayID: gatewayID, id: conversation.id)?.summary
        == conversation
    )
    #expect(await gateway.deletedAgentIDs == [value.id])
  }

  @Test("an agent update cannot clobber an interleaved canonical cache replacement")
  func updatePreservesInterleavedCanonicalAgents() async throws {
    let target = serviceAgent(name: "Before")
    let staleOther = serviceAgent(id: "agent-other", name: "Stale other")
    let updated = serviceAgent(name: "Updated")
    let canonicalOther = serviceAgent(id: staleOther.id, name: "Canonical other")
    let canonicalNew = serviceAgent(id: "agent-new", name: "Canonical new")
    let mutationGate = TestGate()
    let store = InterleavingAgentPersistence(
      agents: [target, staleOther],
      mutationGate: mutationGate
    )
    let service = makeService(
      store: store,
      conversations: AgentServiceConversationStub(),
      gateway: AgentServiceGatewayStub(updatedAgent: updated)
    )

    let update = Task {
      try await service.update(
        id: target.id,
        request: UpdateAgentRequest(model: "updated/model", systemPrompt: nil)
      )
    }
    await mutationGate.waitUntilWaiting()
    await store.installFullSync([target, canonicalOther, canonicalNew])
    await mutationGate.release()

    #expect(try await update.value == updated)
    let persisted = await store.persistedAgents()
    #expect(persisted.first(where: { $0.id == target.id }) == updated)
    #expect(persisted.first(where: { $0.id == staleOther.id }) == canonicalOther)
    #expect(persisted.first(where: { $0.id == canonicalNew.id }) == canonicalNew)
  }

  @Test("ambiguous Start Chat reconciles with the same request ID")
  func startConversationReusesRequestID() async throws {
    let canonical = serviceConversation(agent: serviceAgent())
    let conversations = AgentServiceConversationStub(canonicalConversation: canonical)
    let service = LiveAgentsService(
      gatewayID: gatewayID,
      store: try PersistenceStore.inMemory(),
      conversations: conversations,
      makeAPI: { throw GatewayError.updateRequired }
    )

    let result = try await service.startConversation(agentID: canonical.agentId)

    #expect(result == canonical)
    let create = try #require(await conversations.createRequests.first)
    let reconcile = try #require(await conversations.reconcileRequests.first)
    #expect(create.requestId == reconcile.requestId)
    #expect(create.agentId == canonical.agentId)
    #expect(create.title == nil)
    #expect(create.owningIssueId == nil)
    #expect(create.projectId == nil)
    #expect(await conversations.clearedAgentIDs == [canonical.agentId])
  }

  @Test("shutdown rejects new agent work before transport creation")
  func shutdownRejectsNewWork() async throws {
    let conversations = AgentServiceConversationStub()
    let apiCreations = AgentServiceCounter()
    let service = LiveAgentsService(
      gatewayID: gatewayID,
      store: try PersistenceStore.inMemory(),
      conversations: conversations,
      makeAPI: {
        await apiCreations.increment()
        throw GatewayError.updateRequired
      }
    )

    await service.shutdown()
    do {
      _ = try await service.refreshAgents()
      Issue.record("Expected cancellation")
    } catch is CancellationError {
      // Expected.
    } catch {
      Issue.record("Expected cancellation, received \(error)")
    }

    #expect(await apiCreations.value == 0)
    #expect(await conversations.shutdownCallCount == 1)
  }

  @Test("shutdown during Start Chat resolution preserves its retained request ID")
  func shutdownPreservesResolvingConversationRequestID() async throws {
    let canonical = serviceConversation(agent: serviceAgent())
    let clearGate = TestGate()
    let shutdownGate = TestGate()
    let conversations = AgentServiceConversationStub(
      canonicalConversation: canonical,
      clearGate: clearGate,
      shutdownGate: shutdownGate
    )
    let service = LiveAgentsService(
      gatewayID: gatewayID,
      store: try PersistenceStore.inMemory(),
      conversations: conversations,
      makeAPI: { throw GatewayError.updateRequired }
    )

    let start = Task { () -> Error? in
      do {
        _ = try await service.startConversation(agentID: canonical.agentId)
        return nil
      } catch {
        return error
      }
    }
    await clearGate.waitUntilWaiting()
    let requestID = try #require(await conversations.createRequests.first?.requestId)
    let shutdown = Task { await service.shutdown() }
    await shutdownGate.waitUntilWaiting()
    await shutdownGate.release()
    await clearGate.release()
    let startError = await start.value
    await shutdown.value

    #expect(startError is CancellationError)
    #expect(await conversations.retainedRequestID(agentID: canonical.agentId) == requestID)
  }

  private func makeService(
    store: any ConversationListPersisting,
    conversations: any ConversationListServicing,
    gateway: any AgentsGatewayServicing
  ) -> LiveAgentsService {
    return LiveAgentsService(
      gatewayID: gatewayID,
      store: store,
      conversations: conversations,
      makeAPI: { gateway }
    )
  }

  private func serviceAgent(
    id: String = "agent-service",
    name: String = "Service agent"
  ) -> RegisteredAgentDTO {
    RegisteredAgentDTO(
      id: id,
      name: name,
      config: AgentConfigDTO(
        name: name,
        model: "anthropic/model",
        systemPrompt: "Be useful",
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

  private func serviceConversation(agent: RegisteredAgentDTO) -> ConversationSummaryDTO {
    ConversationSummaryDTO(
      id: "conversation-archived",
      agentId: agent.id,
      agentName: agent.name,
      title: "Archived conversation",
      revision: 1,
      status: .idle,
      activeTurnId: nil,
      owningIssueId: nil,
      projectId: nil,
      lastSeq: 0,
      lastMessagePreview: "Preserve me",
      createdAt: Date(timeIntervalSince1970: 10),
      updatedAt: Date(timeIntervalSince1970: 20),
      deletedAt: nil
    )
  }
}

private actor AgentServiceCounter {
  private(set) var value = 0

  func increment() {
    value += 1
  }
}

private actor AgentServiceGatewayStub: AgentsGatewayServicing {
  private let updatedAgent: RegisteredAgentDTO?
  private(set) var deletedAgentIDs: [String] = []

  init(updatedAgent: RegisteredAgentDTO? = nil) {
    self.updatedAgent = updatedAgent
  }

  func listAgents() throws -> [RegisteredAgentDTO] { [] }

  func agent(id: String) throws -> RegisteredAgentDTO {
    _ = id
    throw GatewayError.updateRequired
  }

  func createAgent(_ request: CreateAgentRequest) throws -> RegisteredAgentDTO {
    _ = request
    throw GatewayError.updateRequired
  }

  func updateAgent(
    id: String,
    request: UpdateAgentRequest
  ) throws -> RegisteredAgentDTO {
    _ = id
    _ = request
    guard let updatedAgent else { throw GatewayError.updateRequired }
    return updatedAgent
  }

  func setAgentEnabled(id: String, enabled: Bool) {
    _ = id
    _ = enabled
  }

  func deleteAgent(id: String) {
    deletedAgentIDs.append(id)
  }

  func models() throws -> ModelsResponseDTO {
    throw GatewayError.updateRequired
  }

  func shutdown() {}
}

private actor InterleavingAgentPersistence: ConversationListPersisting {
  private var storedAgents: [RegisteredAgentDTO]
  private let mutationGate: TestGate

  init(agents: [RegisteredAgentDTO], mutationGate: TestGate) {
    storedAgents = agents
    self.mutationGate = mutationGate
  }

  func conversations(gatewayID: String, limit: Int) -> [CachedConversation] {
    _ = gatewayID
    _ = limit
    return []
  }

  func agents(gatewayID: String) async -> [RegisteredAgentDTO] {
    _ = gatewayID
    let stale = storedAgents
    await mutationGate.wait()
    return stale
  }

  func replaceAgents(_ values: [RegisteredAgentDTO], gatewayID: String) {
    _ = gatewayID
    storedAgents = values
  }

  func upsertAgent(_ value: RegisteredAgentDTO, gatewayID: String) async {
    _ = gatewayID
    await mutationGate.wait()
    if let index = storedAgents.firstIndex(where: { $0.id == value.id }) {
      storedAgents[index] = value
    } else {
      storedAgents.append(value)
    }
  }

  func removeAgent(gatewayID: String, agentID: String) {
    _ = gatewayID
    storedAgents.removeAll { $0.id == agentID }
  }

  func upsertConversations(_ values: [ConversationSummaryDTO], gatewayID: String) {
    _ = values
    _ = gatewayID
  }

  func applyTombstone(_ value: ConversationSummaryDTO, gatewayID: String) {
    _ = value
    _ = gatewayID
  }

  func persistConversationAndReturnCanonical(
    _ value: ConversationSummaryDTO,
    gatewayID: String
  ) -> CachedConversation {
    CachedConversation(gatewayID: gatewayID, summary: value)
  }

  func removeConversation(gatewayID: String, conversationID: String) {
    _ = gatewayID
    _ = conversationID
  }

  func removeConversationIfCanonicalUnchanged(
    gatewayID: String,
    conversationID: String,
    expectedCanonical: ConversationSummaryDTO?
  ) -> ConversationRemovalOutcome {
    _ = gatewayID
    _ = conversationID
    _ = expectedCanonical
    return .removed
  }

  func installFullSync(_ values: [RegisteredAgentDTO]) {
    storedAgents = values
  }

  func persistedAgents() -> [RegisteredAgentDTO] {
    storedAgents
  }
}

private actor AgentServiceConversationStub: ConversationListServicing {
  private let canonicalConversation: ConversationSummaryDTO?
  private let clearGate: TestGate?
  private let shutdownGate: TestGate?
  private var retainedRequestIDs: [String: String] = [:]
  private(set) var createRequests: [CreateConversationRequest] = []
  private(set) var reconcileRequests: [CreateConversationRequest] = []
  private(set) var clearedAgentIDs: [String] = []
  private(set) var shutdownCallCount = 0

  init(
    canonicalConversation: ConversationSummaryDTO? = nil,
    clearGate: TestGate? = nil,
    shutdownGate: TestGate? = nil
  ) {
    self.canonicalConversation = canonicalConversation
    self.clearGate = clearGate
    self.shutdownGate = shutdownGate
  }

  func cachedConversations() -> [CachedConversation] { [] }
  func cachedAgents() -> [RegisteredAgentDTO] { [] }
  func refreshAgents() -> [RegisteredAgentDTO] { [] }

  func conversations(
    agentID: String?,
    limit: Int,
    cursor: String?
  ) -> ConversationPageDTO {
    _ = agentID
    _ = limit
    _ = cursor
    return ConversationPageDTO(items: [], nextCursor: nil)
  }

  func conversation(id: String) throws -> ConversationSummaryDTO {
    guard let canonicalConversation, canonicalConversation.id == id else {
      throw GatewayError.notFound
    }
    return canonicalConversation
  }

  func create(_ request: CreateConversationRequest) throws -> ConversationSummaryDTO {
    createRequests.append(request)
    throw GatewayError.mutationOutcomeUnknown(resourceID: nil, requestID: request.requestId)
  }

  func reconcileCreate(_ request: CreateConversationRequest) throws -> ConversationSummaryDTO {
    reconcileRequests.append(request)
    guard let canonicalConversation else { throw GatewayError.updateRequired }
    return canonicalConversation
  }

  func rename(id: String, title: String, revision: Int) throws -> ConversationSummaryDTO {
    _ = id
    _ = title
    _ = revision
    throw GatewayError.updateRequired
  }

  func delete(id: String, revision: Int) throws -> ConversationSummaryDTO {
    _ = id
    _ = revision
    throw GatewayError.updateRequired
  }

  func replace(_ summary: ConversationSummaryDTO) -> ConversationSummaryDTO { summary }
  func remove(
    id: String,
    expectedCanonical: ConversationSummaryDTO
  ) -> ConversationRemovalOutcome {
    _ = id
    _ = expectedCanonical
    return .removed
  }
  func retainedCreateRequestID(agentID: String, suggested: String) -> String {
    if let retained = retainedRequestIDs[agentID] { return retained }
    retainedRequestIDs[agentID] = suggested
    return suggested
  }
  func clearRetainedCreateRequestID(agentID: String) async {
    await clearGate?.wait()
    retainedRequestIDs[agentID] = nil
    clearedAgentIDs.append(agentID)
  }
  func shutdown() async {
    shutdownCallCount += 1
    await shutdownGate?.wait()
  }

  func retainedRequestID(agentID: String) -> String? {
    retainedRequestIDs[agentID]
  }
}
