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

  // MARK: - Speech
  //
  // Gated on `MobileCapability.speechV1` (`AppModel.speechAvailable`): the
  // gateway mounts `/speech/*` and advertises the capability only while a
  // provider can really transcribe and speak, so calling these without
  // checking is how a UI ends up offering a mic that 404s.

  func speechConfig() async throws -> SpeechConfigResponseDTO {
    try await transport.send(
      GatewayRequest(method: .get, path: mobilePath("speech", "config"))
    )
  }

  /// Returns the MERGED configuration, so a caller never needs a follow-up
  /// read to learn what it now has.
  func patchSpeechConfig(_ patch: SpeechConfigPatchDTO) async throws -> SpeechConfigResponseDTO {
    try await transport.send(
      GatewayRequest(method: .patch, path: mobilePath("speech", "config")),
      body: patch
    )
  }

  /// `kind` is required by the route and has no default; omitting it is a 400.
  func speechModels(kind: SpeechModelKind) async throws -> [SpeechModelDTO] {
    let response: SpeechModelListDTO = try await transport.send(
      GatewayRequest(
        method: .get,
        path: mobilePath("speech", "models"),
        query: [URLQueryItem(name: "kind", value: kind.rawValue)]
      )
    )
    return response.models
  }

  func transcribe(_ request: TranscriptionRequestDTO) async throws -> TranscriptionResponseDTO {
    try await transport.send(
      GatewayRequest(method: .post, path: mobilePath("speech", "transcriptions")),
      body: request
    )
  }

  /// The MP3 bytes, whole. `sendData` rather than `send` because this is the
  /// only operation in the namespace whose success body is not JSON; a failure
  /// on the same request still comes back as a JSON `MobileApiError` and is
  /// mapped by `HTTPTransport` before the bytes are returned.
  ///
  /// No `resourceID`/`requestID` on the descriptor: synthesis creates nothing
  /// server-side, so a timeout has no outcome to reconcile — `POST` still
  /// classifies as `mutationOutcomeUnknown` with both fields nil, which is the
  /// honest answer, and a caller may simply ask again.
  func synthesize(text: String) async throws -> Data {
    try await transport.sendData(
      GatewayRequest(method: .post, path: mobilePath("speech", "speech")),
      body: SynthesisRequestDTO(text: text),
      accept: "audio/mpeg"
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
