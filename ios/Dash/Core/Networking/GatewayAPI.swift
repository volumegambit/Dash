import Foundation

actor GatewayAPI {
  private let transport: HTTPTransport
  private let selection: MobileProtocolSelection

  init(
    transport: HTTPTransport,
    selection: MobileProtocolSelection
  ) {
    self.transport = transport
    self.selection = selection
  }

  func shutdown() async {
    await transport.shutdown()
  }

  func health() async throws -> HealthResponse {
    try await transport.send(
      GatewayRequest(method: .get, path: mobilePath("health"))
    )
  }

  func healthV2() async throws -> MobileV2HealthResponse {
    try await transport.send(
      GatewayRequest(method: .get, path: ["mobile", "v2", "health"])
    )
  }

  func identity() async throws -> GatewayIdentityDTO {
    try await transport.send(
      GatewayRequest(method: .get, path: mobilePath("identity"))
    )
  }

  func identityV2() async throws -> GatewayIdentityDTO {
    let data = try await transport.sendData(
      GatewayRequest(method: .get, path: ["mobile", "v2", "identity"])
    )
    return try decodeExactGatewayIdentity(data)
  }

  func listAgents() async throws -> [RegisteredAgentDTO] {
    try await transport.send(
      GatewayRequest(method: .get, path: mobilePath("agents"))
    )
  }

  /// Read-only: the mobile namespace exposes no skill mutation.
  func listSkills(agentId: String) async throws -> [SkillDTO] {
    try await transport.send(
      GatewayRequest(method: .get, path: mobilePath("agents", agentId, "skills"))
    )
  }

  func agent(id: String) async throws -> RegisteredAgentDTO {
    try await transport.send(
      GatewayRequest(method: .get, path: mobilePath("agents", id))
    )
  }

  func createAgent(_ request: CreateAgentRequest) async throws -> RegisteredAgentDTO {
    try await transport.send(
      GatewayRequest(method: .post, path: mobilePath("agents")),
      body: request
    )
  }

  func updateAgent(
    id: String,
    request: UpdateAgentRequest
  ) async throws -> RegisteredAgentDTO {
    try await transport.send(
      GatewayRequest(
        method: .put,
        path: mobilePath("agents", id),
        resourceID: id
      ),
      body: request
    )
  }

  func setAgentEnabled(id: String, enabled: Bool) async throws {
    let action = enabled ? "enable" : "disable"
    let _: MobileActionResponseDTO = try await transport.send(
      GatewayRequest(
        method: .post,
        path: mobilePath("agents", id, action),
        resourceID: id
      )
    )
  }

  func deleteAgent(id: String) async throws {
    let _: MobileActionResponseDTO = try await transport.send(
      GatewayRequest(
        method: .delete,
        path: mobilePath("agents", id),
        resourceID: id
      )
    )
  }

  /// Read + delete only: the memory PUT and config routes are loopback-only
  /// by design, so the phone can browse and forget but never write.
  func listMemories(agentID: String) async throws -> [MemoryInfoDTO] {
    try await transport.send(
      GatewayRequest(method: .get, path: mobilePath("agents", agentID, "memory"))
    )
  }

  func deleteMemory(agentID: String, name: String) async throws {
    let _: MemoryDeleteResponseDTO = try await transport.send(
      GatewayRequest(
        method: .delete,
        path: mobilePath("agents", agentID, "memory", name),
        resourceID: agentID
      )
    )
  }

  func models() async throws -> ModelsResponseDTO {
    try await transport.send(
      GatewayRequest(method: .get, path: mobilePath("models"))
    )
  }

  func conversations(
    agentId: String?,
    limit: Int,
    cursor: String?
  ) async throws -> ConversationPageDTO {
    try requireSelection(.v1)
    try validate(limit: limit)
    let query = conversationPageQuery(agentId: agentId, limit: limit, cursor: cursor)
    return try await transport.send(
      GatewayRequest(
        method: .get,
        path: mobilePath("conversations"),
        query: query
      )
    )
  }

  func conversationsV2(
    agentId: String?,
    limit: Int,
    cursor: String?
  ) async throws -> MobileV2ConversationPage {
    try requireSelection(.v2Queue)
    try validate(limit: limit)
    let query = conversationPageQuery(agentId: agentId, limit: limit, cursor: cursor)
    return try await transport.send(
      GatewayRequest(
        method: .get,
        path: mobilePath("conversations"),
        query: query
      )
    )
  }

  func createConversation(
    _ request: CreateConversationRequest
  ) async throws -> ConversationSummaryDTO {
    try await transport.send(
      GatewayRequest(
        method: .post,
        path: mobilePath("conversations"),
        requestID: request.requestId
      ),
      body: request
    )
  }

  func conversation(id: String) async throws -> ConversationSummaryDTO {
    try await transport.send(
      GatewayRequest(method: .get, path: mobilePath("conversations", id))
    )
  }

  func bootstrap(conversationID: String) async throws -> MobileV2ConversationBootstrap {
    try requireSelection(.v2Queue)
    return try await transport.send(
      GatewayRequest(
        method: .get,
        path: mobilePath("conversations", conversationID, "bootstrap")
      )
    )
  }

  func patchConversation(
    id: String,
    request: PatchConversationRequest,
    revision: Int
  ) async throws -> ConversationSummaryDTO {
    try await transport.send(
      GatewayRequest(
        method: .patch,
        path: mobilePath("conversations", id),
        resourceID: id
      ),
      body: request,
      ifMatch: revision
    )
  }

  func deleteConversation(id: String, revision: Int) async throws -> ConversationSummaryDTO {
    try await transport.send(
      GatewayRequest(
        method: .delete,
        path: mobilePath("conversations", id),
        resourceID: id
      ),
      ifMatch: revision
    )
  }

  func messages(
    conversationID: String,
    limit: Int,
    before: String?
  ) async throws -> ConversationMessagePageDTO {
    try requireSelection(.v1)
    try validate(limit: limit)
    var query = [URLQueryItem(name: "limit", value: String(limit))]
    if let before {
      query.append(URLQueryItem(name: "before", value: before))
    }
    return try await transport.send(
      GatewayRequest(
        method: .get,
        path: mobilePath("conversations", conversationID, "messages"),
        query: query
      )
    )
  }

  func messagesV2(
    conversationID: String,
    limit: Int,
    before: String?
  ) async throws -> MobileV2ConversationMessagePage {
    try requireSelection(.v2Queue)
    try validate(limit: limit)
    var query = [URLQueryItem(name: "limit", value: String(limit))]
    if let before {
      query.append(URLQueryItem(name: "before", value: before))
    }
    return try await transport.send(
      GatewayRequest(
        method: .get,
        path: mobilePath("conversations", conversationID, "messages"),
        query: query
      )
    )
  }

  func replay(
    agentID: String,
    conversationID: String,
    sinceSeq: Int
  ) async throws -> ReplayPageDTO {
    try await transport.send(
      GatewayRequest(
        method: .get,
        path: mobilePath(
          "agents",
          agentID,
          "conversations",
          conversationID,
          "events"
        ),
        query: [URLQueryItem(name: "sinceSeq", value: String(sinceSeq))]
      )
    )
  }

  /// Children of a conversation (sub-agents design 7.7).
  func subagents(conversationID: String) async throws -> SubagentListResponseDTO {
    try await transport.send(
      GatewayRequest(
        method: .get,
        path: mobilePath("conversations", conversationID, "subagents")
      )
    )
  }

  /// Cancel a child and, depth-first, every descendant this gateway still
  /// holds a handle for (sub-agents design 7.7).
  ///
  /// No body, and no `resourceID`/`requestID` on the descriptor: the route is
  /// idempotent in effect but not in reporting — a second call against a child
  /// the first one terminalized is a 409 `validation_failed`, which is
  /// deliberate (it tells a caller that raced the child's own finish which of
  /// the two won) and is exactly why a blind retry would be wrong.
  func stopSubagent(id: String) async throws -> SubagentStopResponseDTO {
    try await transport.send(
      GatewayRequest(method: .post, path: mobilePath("subagents", id, "stop"))
    )
  }

  /// Type into a child (sub-agents design 7.7). See `SubagentResumeRequest`
  /// for why this is a REST call and not a `message` frame.
  ///
  /// `resourceID`/`requestID` are deliberately left nil on the descriptor.
  /// They exist so an ambiguous mutation timeout can be RETRIED or reconciled
  /// against a persisted idempotency key, and a resume has neither property:
  /// the gateway stores nothing under `requestId`, so replaying one would
  /// simply start a second turn on the child. `HTTPTransport.transportError`
  /// still classifies a timeout here as `mutationOutcomeUnknown`, with both
  /// fields nil — which is the honest answer, and the composer surfaces it
  /// rather than retrying.
  func resumeSubagent(
    id: String,
    message: String,
    requestID: String?
  ) async throws -> SubagentResumeResponseDTO {
    try await transport.send(
      GatewayRequest(method: .post, path: mobilePath("subagents", id, "resume")),
      body: SubagentResumeRequest(message: message, requestId: requestID)
    )
  }

  private func validate(limit: Int) throws {
    guard (1...100).contains(limit) else {
      throw GatewayError.validation("limit must be between 1 and 100")
    }
  }

  private func requireSelection(_ required: MobileProtocolSelection) throws {
    guard selection == required else {
      throw GatewayError.updateRequired
    }
  }

  private func conversationPageQuery(
    agentId: String?,
    limit: Int,
    cursor: String?
  ) -> [URLQueryItem] {
    var query: [URLQueryItem] = []
    if let agentId {
      query.append(URLQueryItem(name: "agentId", value: agentId))
    }
    query.append(URLQueryItem(name: "limit", value: String(limit)))
    if let cursor {
      query.append(URLQueryItem(name: "cursor", value: cursor))
    }
    return query
  }

  private func mobilePath(_ components: String...) -> [String] {
    ["mobile", selection.pathVersion] + components
  }

  private func decodeExactGatewayIdentity(_ data: Data) throws -> GatewayIdentityDTO {
    guard
      let value = try? JSONSerialization.jsonObject(with: data),
      let object = value as? [String: Any],
      Set(object.keys) == ["gatewayId", "publicKey"],
      let gatewayID = object["gatewayId"] as? String,
      gatewayID.isEmpty == false,
      let publicKey = object["publicKey"] as? String,
      publicKey.isEmpty == false
    else {
      throw GatewayError.updateRequired
    }
    return GatewayIdentityDTO(gatewayId: gatewayID, publicKey: publicKey)
  }
}
