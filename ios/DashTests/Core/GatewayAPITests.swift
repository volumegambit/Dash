import Foundation
import Testing

@testable import Dash

@Suite("Gateway API", .serialized)
struct GatewayAPITests {
  init() {
    URLProtocolStub.reset()
  }

  @Test("health is unauthenticated while identity uses the mobile namespace and bearer auth")
  func healthAndIdentityRequests() async throws {
    try URLProtocolStub.enqueue(status: 200, fixture: "health-capabilities.json")
    try URLProtocolStub.enqueue(status: 200, fixture: "identity.json")
    let api = makeAPI()

    let health = try await api.health()
    let identity = try await api.identity()

    #expect(health.apiVersion == 1)
    #expect(identity.gatewayId == "gateway-01")
    let requests = URLProtocolStub.requests
    #expect(requests.count == 2)
    #expect(requests[0].httpMethod == "GET")
    #expect(try encodedPath(requests[0]) == "/mobile/v1/health")
    #expect(requests[0].value(forHTTPHeaderField: "Authorization") == nil)
    #expect(requests[0].value(forHTTPHeaderField: "Accept") == "application/json")
    #expect(try encodedPath(requests[1]) == "/mobile/v1/identity")
    #expect(
      requests[1].value(forHTTPHeaderField: "Authorization")
        == "Bearer management-test-token"
    )
    #expect(requests[1].url?.absoluteString.contains("management-test-token") == false)
  }

  @Test("agent methods send exact paths, methods, and minimal bodies")
  func agentRequestShapes() async throws {
    let agentData = try registeredAgentData()
    try URLProtocolStub.enqueue(status: 200, fixture: "agents-list.json")
    URLProtocolStub.enqueue(status: 200, data: agentData)
    URLProtocolStub.enqueue(status: 201, data: agentData)
    URLProtocolStub.enqueue(status: 200, data: agentData)
    try URLProtocolStub.enqueue(status: 200, fixture: "agent-action-ok.json")
    try URLProtocolStub.enqueue(status: 200, fixture: "agent-action-ok.json")
    try URLProtocolStub.enqueue(status: 200, fixture: "agent-action-ok.json")
    let api = makeAPI()

    _ = try await api.listAgents()
    _ = try await api.agent(id: "agent/a ?")
    _ = try await api.createAgent(
      .init(
        name: "Mobile Helper",
        model: "anthropic/claude-sonnet-4-5",
        systemPrompt: "Help from anywhere."
      )
    )
    _ = try await api.updateAgent(
      id: "agent-01",
      request: .init(model: nil, systemPrompt: "Updated.")
    )
    try await api.setAgentEnabled(id: "agent-01", enabled: true)
    try await api.setAgentEnabled(id: "agent-01", enabled: false)
    try await api.deleteAgent(id: "agent-01")

    let requests = URLProtocolStub.requests
    #expect(requests.map(\.httpMethod) == ["GET", "GET", "POST", "PUT", "POST", "POST", "DELETE"])
    #expect(try encodedPath(requests[0]) == "/mobile/v1/agents")
    #expect(try encodedPath(requests[1]) == "/mobile/v1/agents/agent%2Fa%20%3F")
    #expect(try encodedPath(requests[2]) == "/mobile/v1/agents")
    #expect(try encodedPath(requests[3]) == "/mobile/v1/agents/agent-01")
    #expect(try encodedPath(requests[4]) == "/mobile/v1/agents/agent-01/enable")
    #expect(try encodedPath(requests[5]) == "/mobile/v1/agents/agent-01/disable")
    #expect(try encodedPath(requests[6]) == "/mobile/v1/agents/agent-01")

    let createBody = try stringBody(requests[2])
    #expect(
      createBody == [
        "name": "Mobile Helper",
        "model": "anthropic/claude-sonnet-4-5",
        "systemPrompt": "Help from anywhere.",
      ]
    )
    #expect(try stringBody(requests[3]) == ["systemPrompt": "Updated."])
    #expect(requests[2].value(forHTTPHeaderField: "Content-Type") == "application/json")
    #expect(requests[4].httpBody == nil)
    #expect(requests[5].httpBody == nil)
  }

  @Test("memory reads and delete ride the mobile namespace with percent-encoded names")
  func memoryRequestShapes() async throws {
    try URLProtocolStub.enqueue(status: 200, fixture: "memory-list.json")
    URLProtocolStub.enqueue(status: 200, data: Data(#"{"name":"user-timezone"}"#.utf8))
    URLProtocolStub.enqueue(status: 404, data: Data(#"{"error":"not found"}"#.utf8))
    let api = makeAPI()

    let memories = try await api.listMemories(agentID: "a")
    try await api.deleteMemory(agentID: "a", name: "user-timezone")
    await #expect(throws: GatewayError.notFound) {
      // The gateway answers the memory routes with a bare `{ error }` body
      // instead of the `MobileApiError` envelope; status mapping wins, so it
      // still surfaces as `.notFound`.
      try await api.deleteMemory(agentID: "a", name: "gone/1")
    }

    #expect(memories.map(\.name) == ["user-timezone", "repo-pnpm"])
    #expect(memories.map(\.type) == [.user, .project])
    let requests = URLProtocolStub.requests
    #expect(requests.map(\.httpMethod) == ["GET", "DELETE", "DELETE"])
    #expect(try encodedPath(requests[0]) == "/mobile/v1/agents/a/memory")
    #expect(try encodedPath(requests[1]) == "/mobile/v1/agents/a/memory/user-timezone")
    #expect(try encodedPath(requests[2]) == "/mobile/v1/agents/a/memory/gone%2F1")
    #expect(requests[1].httpBody == nil)
  }

  @Test("speech methods pin their paths, the kind query, and the audio Accept header")
  func speechRequestShapes() async throws {
    try URLProtocolStub.enqueue(status: 200, fixture: "speech-config.json")
    try URLProtocolStub.enqueue(status: 200, fixture: "speech-config.json")
    try URLProtocolStub.enqueue(status: 200, fixture: "speech-models.json")
    try URLProtocolStub.enqueue(status: 200, fixture: "speech-transcription.json")
    let mpeg = Data([0xFF, 0xFB, 0x90, 0x00])
    URLProtocolStub.enqueue(
      status: 200,
      data: mpeg,
      headers: ["Content-Type": "audio/mpeg"]
    )
    let api = makeAPI()

    let config = try await api.speechConfig()
    _ = try await api.patchSpeechConfig(SpeechConfigPatchDTO(tts: SpeechTtsPatchDTO(voice: "nova")))
    let models = try await api.speechModels(kind: .transcription)
    let transcript = try await api.transcribe(
      TranscriptionRequestDTO(audio: "AAAA", format: .wav, language: "en")
    )
    let audio = try await api.synthesize(text: "Ship the speech routes.")

    #expect(config.config.tts.voice == "alloy")
    #expect(models.map(\.id) == ["openai/whisper-large-v3", "openai/gpt-4o-mini-tts-2025-12-15"])
    #expect(transcript.text == "Ship the speech routes.")
    // Raw bytes, byte for byte — `send` would have tried to JSON-decode these.
    #expect(audio == mpeg)

    let requests = URLProtocolStub.requests
    #expect(requests.map(\.httpMethod) == ["GET", "PATCH", "GET", "POST", "POST"])
    #expect(try encodedPath(requests[0]) == "/mobile/v1/speech/config")
    #expect(try encodedPath(requests[1]) == "/mobile/v1/speech/config")
    #expect(try encodedPath(requests[2]) == "/mobile/v1/speech/models")
    #expect(try encodedPath(requests[3]) == "/mobile/v1/speech/transcriptions")
    #expect(try encodedPath(requests[4]) == "/mobile/v1/speech/speech")
    // `kind` is required by the route and carries no default.
    #expect(try queryNames(requests[2]) == ["kind"])
    #expect(try queryValues(requests[2]) == ["transcription"])
    #expect(requests[0].url?.query == nil)

    // Every speech call is authenticated; only `/health` is not.
    for request in requests {
      #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer management-test-token")
    }
    for index in 0..<4 {
      #expect(requests[index].value(forHTTPHeaderField: "Accept") == "application/json")
    }
    // The one operation whose success body is not JSON.
    #expect(requests[4].value(forHTTPHeaderField: "Accept") == "audio/mpeg")
    #expect(requests[4].value(forHTTPHeaderField: "Content-Type") == "application/json")
    #expect(try stringBody(requests[4]) == ["text": "Ship the speech routes."])
    #expect(try stringBody(requests[3]) == ["audio": "AAAA", "format": "wav", "language": "en"])
    #expect(requests[2].httpBody == nil)
  }

  /// A failing synthesis answers JSON on the SAME request that asked for
  /// `audio/mpeg`, so `sendData` must still route a non-2xx through
  /// `mapHTTPError` instead of handing back an error body as if it were audio.
  @Test("a failed synthesis maps to a gateway error, not to error-page bytes")
  func synthesisErrorsAreMapped() async throws {
    URLProtocolStub.enqueue(
      status: 413,
      data: Data(#"{"code":"too_long","error":"text is too long","retryable":false}"#.utf8)
    )
    let api = makeAPI()

    let error = await gatewayError { try await api.synthesize(text: "over the limit") }

    // `too_long` is a speech code the gateway passes through untranslated, so
    // it lands in the generic `.server` case carrying its status.
    guard case let .server(body, status)? = error else {
      Issue.record("expected .server, got \(String(describing: error))")
      return
    }
    #expect(body.code == "too_long")
    #expect(body.retryable == false)
    #expect(status == 413)
  }

  @Test("relay auth is present on HTTP")
  func relayHeaders() async throws {
    try URLProtocolStub.enqueue(status: 200, fixture: "agents-list.json")
    _ = try await makeAPI(relay: true).listAgents()

    let request = try #require(URLProtocolStub.requests.last)
    #expect(
      request.value(forHTTPHeaderField: "Authorization") == "Bearer management-test-token"
    )
    #expect(
      request.value(forHTTPHeaderField: "x-dash-relay-credential") == "relay-test-token"
    )
  }

  /// D8 ruling 4, at the REST path — the OTHER place a `DecodingError` became
  /// `GatewayError.updateRequired` (`HTTPTransport.send`). One malformed
  /// persisted event in a message page used to fail the WHOLE page, so the
  /// conversation could not be opened by recovery either. The page decodes now
  /// and the bad event is one `.unknown` inside it; every other message and
  /// every other event in the same message is untouched.
  ///
  /// `HTTPTransport` itself is unchanged: the fallback lives in
  /// `AgentEvent.init(from:)`, so both paths inherit it from one place.
  @Test("one malformed persisted event does not fail the whole message page")
  func malformedEventDoesNotFailThePage() async throws {
    let page = """
      {"items":[
      {"id":"m1","conversationId":"c1","turnId":"t1","ordinal":1,"role":"assistant",
       "status":"completed","content":{"type":"assistant","events":[
         {"type":"text_delta","text":"before"},
         {"type":"subagent_finished","subagentId":"sub-1","subagentType":"Explore",
          "description":"d","status":"done","report":"r","toolCallCount":1,
          "startedAt":"2026-09-04T00:00:00.000Z"},
         {"type":"text_delta","text":"after"}]},
       "createdAt":"2026-07-12T00:00:02.000Z","updatedAt":"2026-07-12T00:00:05.000Z",
       "origin":"user"}],
      "nextCursor":null,"throughSeq":5}
      """
    URLProtocolStub.enqueue(status: 200, data: Data(page.utf8))
    let api = makeAPI()

    let result = try await api.messages(conversationID: "c1", limit: 40, before: nil)

    #expect(result.items.count == 1)
    guard case let .assistant(events) = result.items[0].content else {
      Issue.record("expected an assistant message")
      return
    }
    #expect(events.count == 3)
    guard case let .unknown(type, _) = events[1] else {
      Issue.record("the malformed event was not degraded to .unknown")
      return
    }
    #expect(type == "subagent_finished")
    // Its neighbours in the SAME message are untouched.
    guard case let .textDelta(before) = events[0], case let .textDelta(after) = events[2] else {
      Issue.record("neighbouring events were lost")
      return
    }
    #expect(before == "before")
    #expect(after == "after")
  }

  @Test("models and every conversation read and mutation use exact routes")
  func conversationRequestShapes() async throws {
    try URLProtocolStub.enqueue(status: 200, fixture: "models-list.json")
    try URLProtocolStub.enqueue(status: 200, fixture: "conversations-page.json")
    try URLProtocolStub.enqueue(status: 201, fixture: "conversation-summary.json")
    try URLProtocolStub.enqueue(status: 200, fixture: "conversation-summary.json")
    try URLProtocolStub.enqueue(status: 200, fixture: "conversation-summary.json")
    try URLProtocolStub.enqueue(status: 200, fixture: "conversation-summary.json")
    try URLProtocolStub.enqueue(status: 200, fixture: "conversation-messages-page.json")
    try URLProtocolStub.enqueue(status: 200, fixture: "replay.json")
    let api = makeAPI()
    let conversationID = "conv/a ?"

    _ = try await api.models()
    _ = try await api.conversations(agentId: "agent-01", limit: 25, cursor: "opaque:cursor")
    _ = try await api.createConversation(
      .init(
        agentId: "agent-01",
        requestId: "request-01",
        title: "Mobile launch check",
        owningIssueId: nil,
        projectId: nil
      )
    )
    _ = try await api.conversation(id: conversationID)
    _ = try await api.patchConversation(
      id: conversationID,
      request: try PatchConversationRequest(title: "Renamed"),
      revision: 7
    )
    _ = try await api.deleteConversation(id: conversationID, revision: 8)
    _ = try await api.messages(conversationID: conversationID, limit: 40, before: "before:1")
    _ = try await api.replay(agentID: "agent/a", conversationID: conversationID, sinceSeq: 12)

    let requests = URLProtocolStub.requests
    #expect(
      requests.map(\.httpMethod) == ["GET", "GET", "POST", "GET", "PATCH", "DELETE", "GET", "GET"])
    #expect(try encodedPath(requests[0]) == "/mobile/v1/models")
    #expect(try encodedPath(requests[1]) == "/mobile/v1/conversations")
    #expect(try queryNames(requests[1]) == ["agentId", "limit", "cursor"])
    #expect(try queryValues(requests[1]) == ["agent-01", "25", "opaque:cursor"])
    #expect(try encodedPath(requests[2]) == "/mobile/v1/conversations")
    #expect(
      try stringBody(requests[2]) == [
        "agentId": "agent-01",
        "requestId": "request-01",
        "title": "Mobile launch check",
      ]
    )
    #expect(try encodedPath(requests[3]) == "/mobile/v1/conversations/conv%2Fa%20%3F")
    #expect(try encodedPath(requests[4]) == "/mobile/v1/conversations/conv%2Fa%20%3F")
    #expect(requests[4].value(forHTTPHeaderField: "If-Match") == "\"7\"")
    #expect(try stringBody(requests[4]) == ["title": "Renamed"])
    #expect(try encodedPath(requests[5]) == "/mobile/v1/conversations/conv%2Fa%20%3F")
    #expect(requests[5].value(forHTTPHeaderField: "If-Match") == "\"8\"")
    #expect(
      try encodedPath(requests[6])
        == "/mobile/v1/conversations/conv%2Fa%20%3F/messages"
    )
    #expect(try queryNames(requests[6]) == ["limit", "before"])
    #expect(try queryValues(requests[6]) == ["40", "before:1"])
    #expect(
      try encodedPath(requests[7])
        == "/mobile/v1/agents/agent%2Fa/conversations/conv%2Fa%20%3F/events"
    )
    #expect(try queryNames(requests[7]) == ["sinceSeq"])
    #expect(try queryValues(requests[7]) == ["12"])
  }

  @Test("conversation patch preserves an explicit null field")
  func conversationPatchExplicitNull() async throws {
    try URLProtocolStub.enqueue(status: 200, fixture: "conversation-summary.json")
    let api = makeAPI()

    _ = try await api.patchConversation(
      id: "conv-1",
      request: try PatchConversationRequest(owningIssueId: .null),
      revision: 4
    )

    let request = try #require(URLProtocolStub.requests.last)
    let body = try #require(request.httpBody)
    let json = try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])
    #expect(json.count == 1)
    #expect(json["owningIssueId"] is NSNull)
  }

  @Test("sub-agent reads and resumes use the mobile namespace and a minimal body")
  func subagentRequestShapes() async throws {
    try URLProtocolStub.enqueue(status: 200, fixture: "subagents-list.json")
    URLProtocolStub.enqueue(
      status: 200,
      data: Data(#"{"ok":true,"status":"running","mode":"queued"}"#.utf8)
    )
    URLProtocolStub.enqueue(
      status: 200,
      data: Data(#"{"ok":true,"status":"running","mode":"resumed"}"#.utf8)
    )
    let api = makeAPI()

    let list = try await api.subagents(conversationID: "conv/1 ?")
    let correlated = try await api.resumeSubagent(
      id: "sub/1 ?",
      message: "keep going",
      requestID: "req-1"
    )
    let uncorrelated = try await api.resumeSubagent(
      id: "sub-2",
      message: "keep going",
      requestID: nil
    )

    #expect(list.subagents.count == 3)
    #expect(correlated.mode == "queued")
    #expect(uncorrelated.mode == "resumed")

    let requests = URLProtocolStub.requests
    #expect(requests.map(\.httpMethod) == ["GET", "POST", "POST"])
    #expect(try encodedPath(requests[0]) == "/mobile/v1/conversations/conv%2F1%20%3F/subagents")
    #expect(requests[0].httpBody == nil)
    #expect(try encodedPath(requests[1]) == "/mobile/v1/subagents/sub%2F1%20%3F/resume")

    let correlatedData = try #require(requests[1].httpBody)
    let correlatedBody = try #require(
      JSONSerialization.jsonObject(with: correlatedData) as? [String: Any]
    )
    #expect(correlatedBody.count == 2)
    #expect(correlatedBody["message"] as? String == "keep going")
    #expect(correlatedBody["requestId"] as? String == "req-1")

    // Omitted, not null: the gateway 400s a blank/malformed `requestId`, and a
    // client that never sent one must look exactly like an older client.
    let uncorrelatedData = try #require(requests[2].httpBody)
    let uncorrelatedBody = try #require(
      JSONSerialization.jsonObject(with: uncorrelatedData) as? [String: Any]
    )
    #expect(uncorrelatedBody.count == 1)
    #expect(uncorrelatedBody["message"] as? String == "keep going")
  }

  @Test("stopping a sub-agent posts an empty body and reports the terminal status")
  func subagentStopRequestShape() async throws {
    URLProtocolStub.enqueue(
      status: 200,
      data: Data(#"{"ok":true,"status":"cancelled"}"#.utf8)
    )
    let api = makeAPI()

    let stopped = try await api.stopSubagent(id: "sub/1 ?")

    // The route's own status is authoritative: it falls back to writing
    // `cancelled` itself when the cascade reached a child this gateway process
    // no longer holds a handle for, so it is not always guessable.
    #expect(stopped.status == "cancelled")
    let request = try #require(URLProtocolStub.requests.last)
    #expect(request.httpMethod == "POST")
    #expect(try encodedPath(request) == "/mobile/v1/subagents/sub%2F1%20%3F/stop")
    #expect(request.httpBody == nil)
  }

  @Test("stopping a child that already finished surfaces the gateway's own refusal")
  func subagentStopAlreadyTerminal() async {
    URLProtocolStub.enqueue(
      status: 409,
      data: Data(
        #"{"code":"validation_failed","error":"Sub-agent sub-1 is already done","retryable":false}"#
          .utf8
      )
    )
    let api = makeAPI()

    let error = await gatewayError { _ = try await api.stopSubagent(id: "sub-1") }

    #expect(error == .validation("Sub-agent sub-1 is already done"))
  }

  @Test("a coordinator refusal to resume surfaces its own text, not a generic error")
  func subagentResumeRefusal() async {
    URLProtocolStub.enqueue(
      status: 409,
      data: Data(
        #"{"code":"validation_failed","error":"One-shot agents cannot be resumed","retryable":false}"#
          .utf8
      )
    )
    let api = makeAPI()

    let error = await gatewayError {
      _ = try await api.resumeSubagent(id: "sub-1", message: "again", requestID: "req-1")
    }

    // The composer shows this string verbatim (design 8.3: "disabled for
    // one-shot types and shows the reason"), so a mapping that collapsed it to
    // `.server` would leave the user with a status code.
    #expect(error == .validation("One-shot agents cannot be resumed"))
  }

  @Test("page limits are validated before a request is sent")
  func pageLimitValidation() async {
    let api = makeAPI()

    let low = await gatewayError {
      try await api.conversations(agentId: nil, limit: 0, cursor: nil)
    }
    let high = await gatewayError {
      try await api.messages(conversationID: "conv-1", limit: 101, before: nil)
    }

    #expect(low == .validation("limit must be between 1 and 100"))
    #expect(high == .validation("limit must be between 1 and 100"))
    #expect(URLProtocolStub.requests.isEmpty)
  }

  @Test("sendEmpty accepts only a successful zero-byte response")
  func emptyResponseRules() async {
    URLProtocolStub.enqueue(status: 204)
    URLProtocolStub.enqueue(status: 200)
    URLProtocolStub.enqueue(status: 200, data: Data("{}".utf8))
    let transport = makeTransport()
    let request = GatewayRequest(method: .get, path: ["mobile", "v1", "health"])

    do {
      try await transport.sendEmpty(request)
    } catch {
      Issue.record("Expected 204 with zero bytes to succeed, received \(error)")
    }
    let generic = await gatewayError {
      let _: HealthResponse = try await transport.send(request)
    }
    let nonempty = await gatewayError {
      try await transport.sendEmpty(request)
    }

    #expect(generic == .updateRequired)
    #expect(nonempty == .updateRequired)
  }

  @Test("structured HTTP errors map to stable GatewayError cases")
  func structuredErrorMapping() async throws {
    try URLProtocolStub.enqueue(status: 401, fixture: "errors/unauthorized.json")
    try URLProtocolStub.enqueue(
      status: 429,
      fixture: "errors/rate-limited.json",
      headers: ["Retry-After": "30"]
    )
    try URLProtocolStub.enqueue(status: 404, fixture: "errors/not-found.json")
    try URLProtocolStub.enqueue(status: 400, fixture: "errors/validation-failed.json")
    try URLProtocolStub.enqueue(status: 409, fixture: "errors/revision-conflict.json")
    try URLProtocolStub.enqueue(status: 409, fixture: "errors/conversation-busy.json")
    try URLProtocolStub.enqueue(status: 426, fixture: "errors/capability-required.json")
    try URLProtocolStub.enqueue(status: 500, fixture: "errors/gateway-offline.json")
    let api = makeAPI()

    #expect(await gatewayError { try await api.listAgents() } == .unauthorized)
    #expect(
      await gatewayError { try await api.listAgents() }
        == .rateLimited(retryAfter: .seconds(30))
    )
    #expect(await gatewayError { try await api.listAgents() } == .notFound)
    #expect(
      await gatewayError { try await api.listAgents() }
        == .validation("Request body is invalid")
    )

    let expectedCurrent = try FixtureLoader.decode(
      MobileAPIError.self,
      "errors/revision-conflict.json"
    )
    let current = try #require(try decodeCurrent(from: expectedCurrent))
    #expect(
      await gatewayError { try await api.listAgents() }
        == .revisionConflict(current: current)
    )
    #expect(
      await gatewayError { try await api.listAgents() }
        == .conversationBusy(activeTurnId: "018f0f4a-5c42-7a8b-9c01-2234567890ab")
    )
    #expect(await gatewayError { try await api.listAgents() } == .capabilityRequired)

    let serverBody = try FixtureLoader.decode(
      MobileAPIError.self,
      "errors/gateway-offline.json"
    )
    #expect(
      await gatewayError { try await api.listAgents() }
        == .server(serverBody, status: 500)
    )
  }

  @Test("relay 502 maps to gateway offline")
  func relayOfflineMapping() async throws {
    try URLProtocolStub.enqueue(status: 502, fixture: "errors/gateway-offline.json")
    #expect(await gatewayError { try await makeAPI(relay: true).listAgents() } == .gatewayOffline)
  }

  @Test("Retry-After dates use the injected clock and tombstones remain not found")
  func clockedRetryAfterAndTombstone() async throws {
    try URLProtocolStub.enqueue(
      status: 429,
      fixture: "errors/rate-limited.json",
      headers: ["Retry-After": "Thu, 01 Jan 1970 00:00:45 GMT"]
    )
    try URLProtocolStub.enqueue(status: 410, fixture: "errors/not-found.json")
    let api = makeAPI()

    #expect(
      await gatewayError { try await api.listAgents() }
        == .rateLimited(retryAfter: .seconds(45))
    )
    #expect(await gatewayError { try await api.listAgents() } == .notFound)
  }

  @Test("unrepresentable Retry-After seconds fall back safely")
  func unrepresentableRetryAfter() async throws {
    try URLProtocolStub.enqueue(
      status: 429,
      fixture: "errors/rate-limited.json",
      headers: ["Retry-After": "1e309"]
    )
    try URLProtocolStub.enqueue(
      status: 429,
      fixture: "errors/rate-limited.json",
      headers: ["Retry-After": "9223372036854776"]
    )
    try URLProtocolStub.enqueue(
      status: 429,
      fixture: "errors/rate-limited.json",
      headers: ["Retry-After": "-0.0004"]
    )
    URLProtocolStub.enqueue(
      status: 429,
      data: Data(
        """
        {
          "code": "rate_limited",
          "error": "Too many mobile requests",
          "retryable": true,
          "details": { "retryAfterSeconds": 1e300 }
        }
        """.utf8
      )
    )
    let api = makeAPI()

    #expect(
      await gatewayError { try await api.listAgents() }
        == .rateLimited(retryAfter: .seconds(30))
    )
    #expect(
      await gatewayError { try await api.listAgents() }
        == .rateLimited(retryAfter: .seconds(30))
    )
    #expect(
      await gatewayError { try await api.listAgents() }
        == .rateLimited(retryAfter: .seconds(30))
    )
    #expect(await gatewayError { try await api.listAgents() } == .rateLimited(retryAfter: nil))
  }

  @Test("contract decode failures require an app update")
  func decodeFailureMapping() async throws {
    URLProtocolStub.enqueue(status: 200, data: Data("{}".utf8))
    URLProtocolStub.enqueue(status: 200, data: Data("{}".utf8))
    try URLProtocolStub.enqueue(status: 200, fixture: "invalid/agent-action-not-ok.json")
    let transport = makeTransport()
    let request = GatewayRequest(method: .get, path: ["mobile", "v1", "agents"])

    let missingDTO = await gatewayError {
      let _: [RegisteredAgentDTO] = try await transport.send(request)
    }
    let requiredCapable = await gatewayError {
      let _: RequiredCapableResponse = try await transport.send(request)
    }
    let invalidAction = await gatewayError {
      try await makeAPI().setAgentEnabled(id: "agent-01", enabled: true)
    }

    #expect(missingDTO == .updateRequired)
    #expect(requiredCapable == .updateRequired)
    #expect(invalidAction == .updateRequired)
  }

  @Test("timeouts distinguish safe reads from ambiguous mutations")
  func timeoutMapping() async {
    URLProtocolStub.enqueue(failure: URLError(.timedOut))
    URLProtocolStub.enqueue(failure: URLError(.timedOut))
    URLProtocolStub.enqueue(failure: URLError(.timedOut))
    let api = makeAPI()

    let read = await gatewayError { try await api.identity() }
    let create = await gatewayError {
      try await api.createConversation(
        .init(
          agentId: "agent-01",
          requestId: "request-timeout",
          title: nil,
          owningIssueId: nil,
          projectId: nil
        )
      )
    }
    let patch = await gatewayError {
      try await api.patchConversation(
        id: "conv-1",
        request: try PatchConversationRequest(title: "Renamed"),
        revision: 2
      )
    }

    guard case .transport = read else {
      Issue.record("Expected GET timeout to map to transport, received \(String(describing: read))")
      return
    }
    #expect(
      create
        == .mutationOutcomeUnknown(resourceID: nil, requestID: "request-timeout")
    )
    #expect(patch == .mutationOutcomeUnknown(resourceID: "conv-1", requestID: nil))
  }

  @Test("a lost connection makes admitted mutations ambiguous")
  func connectionLostMapping() async throws {
    URLProtocolStub.enqueue(failure: URLError(.networkConnectionLost))
    URLProtocolStub.enqueue(failure: URLError(.networkConnectionLost))
    let api = makeAPI()

    let read = await gatewayError { try await api.identity() }
    let mutation = await gatewayError {
      try await api.patchConversation(
        id: "conv-1",
        request: try PatchConversationRequest(title: "Renamed"),
        revision: 2
      )
    }

    guard case .transport = read else {
      Issue.record("Expected a read transport error, received \(String(describing: read))")
      return
    }
    #expect(mutation == .mutationOutcomeUnknown(resourceID: "conv-1", requestID: nil))
  }

  @Test("cancelling an HTTP request remains structured cancellation")
  func cancellationMapping() async {
    URLProtocolStub.enqueue(status: 200, holdOpen: true)
    let api = makeAPI()
    let request = Task { try await api.identity() }

    for _ in 0..<100 where URLProtocolStub.requests.isEmpty {
      try? await Task.sleep(for: .milliseconds(1))
    }
    #expect(URLProtocolStub.requests.count == 1)

    request.cancel()

    await #expect(throws: CancellationError.self) {
      try await request.value
    }
    #expect(URLProtocolStub.stopLoadingCount >= 1)
  }
}

private struct RequiredCapableResponse: Decodable, Sendable {
  init(from decoder: Decoder) throws {
    throw ContractValidationError.requiredCapableField("seq")
  }
}

private func makeAPI(relay: Bool = false) -> GatewayAPI {
  GatewayAPI(transport: makeTransport(relay: relay))
}

private func makeTransport(relay: Bool = false) -> HTTPTransport {
  let secrets = ConnectionSecrets(
    managementToken: "management-test-token",
    chatToken: "chat-test-token",
    relayCredential: relay ? "relay-test-token" : nil
  )
  let profile = ConnectionProfile(
    id: UUID(),
    gatewayId: "gateway-01",
    publicKey: "public-key",
    label: "Test Gateway",
    host: "gateway.test",
    managementPort: relay ? 443 : 9400,
    chatPort: relay ? 443 : 9400,
    secure: true,
    mode: relay ? .relay : .lan,
    tlsCertificateSha256: relay
      ? nil
      : "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    createdAt: Date(timeIntervalSince1970: 0),
    lastSuccessfulSyncAt: nil
  )
  return HTTPTransport(
    endpoint: ConnectionEndpoint(profile: profile, secrets: secrets),
    secrets: secrets,
    session: testURLSession(),
    clock: TestAppClock(now: Date(timeIntervalSince1970: 0))
  )
}

private func registeredAgentData() throws -> Data {
  let agents = try FixtureLoader.decode([RegisteredAgentDTO].self, "agents-list.json")
  return try ContractCoding.encoder().encode(try #require(agents.first))
}

private func encodedPath(_ request: URLRequest) throws -> String {
  let url = try #require(request.url)
  return try #require(URLComponents(url: url, resolvingAgainstBaseURL: false)).percentEncodedPath
}

private func queryNames(_ request: URLRequest) throws -> [String] {
  let url = try #require(request.url)
  let components = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false))
  return (components.queryItems ?? []).map(\.name)
}

private func queryValues(_ request: URLRequest) throws -> [String?] {
  let url = try #require(request.url)
  let components = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false))
  return (components.queryItems ?? []).map(\.value)
}

private func stringBody(_ request: URLRequest) throws -> [String: String] {
  let data = try #require(request.httpBody)
  return try #require(JSONSerialization.jsonObject(with: data) as? [String: String])
}

private func decodeCurrent(from error: MobileAPIError) throws -> ConversationSummaryDTO? {
  guard let current = error.details?.objectValue?["current"] else { return nil }
  return try ContractCoding.decoder().decode(
    ConversationSummaryDTO.self,
    from: ContractCoding.encoder().encode(current)
  )
}

private func gatewayError<Value: Sendable>(
  _ operation: @Sendable () async throws -> Value
) async -> GatewayError? {
  do {
    _ = try await operation()
    Issue.record("Expected GatewayError")
    return nil
  } catch let error as GatewayError {
    return error
  } catch {
    Issue.record("Expected GatewayError, received \(error)")
    return nil
  }
}

@Suite("Notice content decoding")
struct MessageContentNoticeTests {
  private func decode(_ json: String) throws -> MessageContent {
    try JSONDecoder().decode(MessageContent.self, from: Data(json.utf8))
  }

  @Test("decodes a learned-skill notice")
  func decodesSkillNotice() throws {
    let content = try decode(
      #"{"type":"notice","kind":"skill_learned","text":"Learned: write-files"}"#
    )

    guard case let .notice(kind, text) = content else {
      Issue.record("expected a notice, got \(content)")
      return
    }
    #expect(kind == .skillLearned)
    #expect(text == "Learned: write-files")
  }

  @Test("decodes a swept-memory notice")
  func decodesMemoryNotice() throws {
    let content = try decode(
      #"{"type":"notice","kind":"memory_saved","text":"Remembered: prefers printf"}"#
    )

    guard case let .notice(kind, _) = content else {
      Issue.record("expected a notice")
      return
    }
    #expect(kind == .memorySaved)
  }

  @Test("an unknown notice kind degrades instead of throwing")
  func unknownKindDegrades() throws {
    // A gateway that adds a notice kind must not break decoding on this build.
    let content = try decode(#"{"type":"notice","kind":"quantum_insight","text":"hi"}"#)

    guard case let .notice(kind, _) = content else {
      Issue.record("expected a notice")
      return
    }
    #expect(kind == .unknown)
  }

  @Test("an unknown content type degrades instead of failing the page")
  func unknownContentDegrades() throws {
    // Messages decode as a page; one unrecognised message must not blank the
    // whole transcript. Same rule as AgentEvent.unknown.
    let content = try decode(#"{"type":"hologram","payload":{}}"#)

    guard case let .unknown(type) = content else {
      Issue.record("expected unknown, got \(content)")
      return
    }
    #expect(type == "hologram")
  }

  @Test("a notice round-trips through encode and decode")
  func roundTrips() throws {
    let original = MessageContent.notice(kind: .skillLearned, text: "Learned: x")
    let data = try JSONEncoder().encode(original)
    let decoded = try JSONDecoder().decode(MessageContent.self, from: data)

    #expect(decoded == original)
  }

  @Test("user and assistant content still decode")
  func existingShapesUnaffected() throws {
    guard case let .user(text, _) = try decode(#"{"type":"user","text":"hi"}"#) else {
      Issue.record("expected user content")
      return
    }
    #expect(text == "hi")

    guard case let .assistant(events) = try decode(#"{"type":"assistant","events":[]}"#) else {
      Issue.record("expected assistant content")
      return
    }
    #expect(events.isEmpty)
  }
}
