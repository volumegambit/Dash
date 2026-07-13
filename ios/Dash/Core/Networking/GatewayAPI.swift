import Foundation

actor GatewayAPI {
  private let transport: HTTPTransport

  init(transport: HTTPTransport) {
    self.transport = transport
  }

  func shutdown() async {
    await transport.shutdown()
  }

  func health() async throws -> HealthResponse {
    try await transport.send(
      GatewayRequest(method: .get, path: mobilePath("health"))
    )
  }

  func identity() async throws -> GatewayIdentityDTO {
    try await transport.send(
      GatewayRequest(method: .get, path: mobilePath("identity"))
    )
  }

  func listAgents() async throws -> [RegisteredAgentDTO] {
    try await transport.send(
      GatewayRequest(method: .get, path: mobilePath("agents"))
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
    try validate(limit: limit)
    var query: [URLQueryItem] = []
    if let agentId {
      query.append(URLQueryItem(name: "agentId", value: agentId))
    }
    query.append(URLQueryItem(name: "limit", value: String(limit)))
    if let cursor {
      query.append(URLQueryItem(name: "cursor", value: cursor))
    }
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

  private func validate(limit: Int) throws {
    guard (1...100).contains(limit) else {
      throw GatewayError.validation("limit must be between 1 and 100")
    }
  }

  private func mobilePath(_ components: String...) -> [String] {
    ["mobile", "v1"] + components
  }
}
