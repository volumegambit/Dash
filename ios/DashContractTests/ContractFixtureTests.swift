import Foundation
import Testing

@testable import Dash

private final class ContractFixtureBundleToken {}

private struct FixtureManifest: Decodable {
  let version: Int
  let cases: [FixtureCase]
}

private struct FixtureCase: Decodable {
  let file: String
  let document: String
  let schema: String
  let valid: Bool
  let format: String?
}

private struct ConversationDefaultsFixture: Decodable {
  let defaultConversationTitle: String
}

private enum FixtureDispatchError: Error {
  case unsupported(String)
}

@Suite("mobile v1 contract fixtures")
struct ContractFixtureTests {
  @Test("required REST shapes decode")
  func restFixtures() throws {
    let health = try FixtureLoader.decode(HealthResponse.self, "health-capabilities.json")
    #expect(health.apiVersion == 1)
    #expect(Set(health.capabilities) == [.conversationSyncV1, .chatResumeV1])

    let identity = try FixtureLoader.decode(GatewayIdentityDTO.self, "identity.json")
    #expect(identity.gatewayId.isEmpty == false)

    let page = try FixtureLoader.decode(ConversationPageDTO.self, "conversations-page.json")
    #expect(page.items.isEmpty == false)
  }

  @Test("the memory list fixture decodes with bare ISO dates and grouped types")
  func memoryListFixture() throws {
    let memories = try FixtureLoader.decode([MemoryInfoDTO].self, "memory-list.json")

    #expect(memories.count == 2)
    #expect(memories.map(\.name) == ["user-timezone", "repo-pnpm"])
    #expect(memories.map(\.type) == [.user, .project])
    #expect(memories.map(\.source) == ["agent", "sweep"])
    // `createdAt`/`updatedAt` are bare `YYYY-MM-DD` days, not RFC 3339
    // timestamps, so they stay `String` — `ContractCoding`'s date strategy
    // would reject them.
    #expect(memories[0].createdAt == "2026-09-05")
    #expect(memories[0].updatedAt == "2026-09-05")
    #expect(memories[0].size == 24)
    #expect(memories[0].id == memories[0].name)
  }

  @Test("contract coding round-trips JSON and RFC 3339 dates")
  func codingPrimitives() throws {
    let json = Data(#"{"a":[null,true,1,"x"],"o":{"n":2}}"#.utf8)
    let value = try ContractCoding.decoder().decode(JSONValue.self, from: json)
    let encodedJSON = try canonicalJSON(ContractCoding.encoder().encode(value))
    let sourceJSON = try canonicalJSON(json)
    #expect(encodedJSON == sourceJSON)

    let fractional = try FixtureLoader.decode(HealthResponse.self, "health-capabilities.json")
    let noFraction = Data(
      #"{"status":"healthy","startedAt":"2026-07-12T00:00:00Z","pid":1,"agents":0,"channels":0,"apiVersion":1,"capabilities":[]}"#
        .utf8
    )
    let standard = try ContractCoding.decoder().decode(HealthResponse.self, from: noFraction)
    #expect(standard.startedAt == fractional.startedAt)
    let encoded = String(decoding: try ContractCoding.encoder().encode(standard), as: UTF8.self)
    #expect(encoded.contains(#""startedAt":"2026-07-12T00:00:00.000Z""#))
  }

  @Test("unknown agent event preserves and re-encodes its full raw object")
  func unknownEvent() throws {
    let json = Data(#"{"type":"future_status","detail":{"n":1},"items":[true,null]}"#.utf8)
    let event = try ContractCoding.decoder().decode(AgentEvent.self, from: json)
    guard case let .unknown(type, raw) = event else {
      Issue.record("expected unknown event")
      return
    }
    #expect(type == "future_status")
    #expect(raw.objectValue?["detail"]?.objectValue?["n"] == .number(1))
    let encodedJSON = try canonicalJSON(ContractCoding.encoder().encode(event))
    let sourceJSON = try canonicalJSON(json)
    #expect(encodedJSON == sourceJSON)
  }

  @Test("every current agent event discriminator round-trips as a known case")
  func knownAgentEvents() throws {
    let samples = [
      #"{"type":"text_delta","text":"hello"}"#,
      #"{"type":"thinking_delta","text":"hmm"}"#,
      #"{"type":"tool_use_start","id":"tool-1","name":"read","input":{"path":"a"}}"#,
      #"{"type":"tool_use_delta","partial_json":"{\"path\":"}"#,
      #"{"type":"tool_result","id":"tool-1","name":"read","content":"ok","isError":false,"details":{"size":1}}"#,
      #"{"type":"response","content":"done","usage":{"inputTokens":4,"outputTokens":2,"cacheReadTokens":1,"cacheWriteTokens":1}}"#,
      #"{"type":"error","error":"failed","timestamp":"2026-07-12T00:00:00.000Z"}"#,
      #"{"type":"file_changed","files":["a.txt"]}"#,
      #"{"type":"agent_spawned","name":"worker"}"#,
      #"{"type":"worker_spawned","workerId":"w1","runId":"r1","role":"reviewer","brief":"review","model":"openai/gpt-5"}"#,
      #"{"type":"worker_status","workerId":"w1","runId":"r1","role":"reviewer","status":"waiting_input","detail":"paused","question":"continue?"}"#,
      #"{"type":"worker_done","workerId":"w1","runId":"r1","role":"reviewer","status":"done","report":"ok","usage":{"inputTokens":3,"outputTokens":2}}"#,
      #"{"type":"agent_retry","attempt":2,"reason":"network"}"#,
      #"{"type":"context_compacted","overflow":true}"#,
      #"{"type":"question","id":"q1","question":"Proceed?","options":["Yes","No"]}"#,
      #"{"type":"skill_loaded","name":"mobile"}"#,
      #"{"type":"skill_created","name":"mobile","description":"Mobile help"}"#,
      #"{"type":"mcp_server_error","server":"linear","error":"offline"}"#,
      #"{"type":"memory_saved","name":"user-timezone","description":"Gerry is in Singapore","memoryType":"user","action":"created"}"#,
      #"{"type":"memory_forgotten","name":"old-fact"}"#,
    ]

    for sample in samples {
      let source = Data(sample.utf8)
      let event = try ContractCoding.decoder().decode(AgentEvent.self, from: source)
      if case .unknown = event {
        Issue.record("known event decoded as unknown: \(sample)")
      }
      let encodedJSON = try canonicalJSON(ContractCoding.encoder().encode(event))
      let sourceJSON = try canonicalJSON(source)
      #expect(encodedJSON == sourceJSON, "round-trip failed for \(sample)")
    }
  }

  /// Agent memory Phase D: the wire field for the memory bucket is
  /// `memoryType` (`type` is the discriminator) and `action` is
  /// `created`/`updated`. Assert the decoded payload, not just round-tripping.
  @Test("memory events decode their bucket and action")
  func memoryEventPayloads() throws {
    let saved = try ContractCoding.decoder().decode(
      AgentEvent.self,
      from: Data(
        #"{"type":"memory_saved","name":"a","description":"d","memoryType":"feedback","action":"updated"}"#
          .utf8
      )
    )
    guard case let .memorySaved(name, description, memoryType, action) = saved else {
      Issue.record("memory_saved did not decode")
      return
    }
    #expect(name == "a")
    #expect(description == "d")
    #expect(memoryType == .feedback)
    #expect(action == .updated)

    let forgotten = try ContractCoding.decoder().decode(
      AgentEvent.self,
      from: Data(#"{"type":"memory_forgotten","name":"old-fact"}"#.utf8)
    )
    #expect(forgotten == .memoryForgotten(name: "old-fact"))

    #expect(MemoryTypeDTO.allCases.map(\.rawValue) == ["user", "feedback", "project", "reference"])
  }

  /// Agent memory: the bucket list is a product-level enum expected to grow, and
  /// every other client renders an unrecognised bucket rather than failing. On
  /// iOS a thrown `DecodingError` is fatal well beyond the chip — the frame
  /// decoder maps it to `GatewayError.updateRequired` and tears down the whole
  /// receive loop, and a history page decodes `[AgentEvent]` as a unit. So an
  /// unknown `memoryType`/`action` must degrade THE EVENT to `.unknown`.
  @Test("unknown memory bucket or action degrades to an unknown event")
  func memoryEventUnknownEnumValuesDegrade() throws {
    let futureBucket = try ContractCoding.decoder().decode(
      AgentEvent.self,
      from: Data(
        #"{"type":"memory_saved","name":"a","description":"d","memoryType":"future_bucket","action":"created"}"#
          .utf8
      )
    )
    guard case let .unknown(type, raw) = futureBucket else {
      Issue.record("unknown memoryType did not degrade to .unknown: \(futureBucket)")
      return
    }
    #expect(type == "memory_saved")
    #expect(raw.objectValue?["memoryType"] == .string("future_bucket"))

    let futureAction = try ContractCoding.decoder().decode(
      AgentEvent.self,
      from: Data(
        #"{"type":"memory_saved","name":"a","description":"d","memoryType":"user","action":"archived"}"#
          .utf8
      )
    )
    guard case let .unknown(actionType, actionRaw) = futureAction else {
      Issue.record("unknown action did not degrade to .unknown: \(futureAction)")
      return
    }
    #expect(actionType == "memory_saved")
    #expect(actionRaw.objectValue?["action"] == .string("archived"))
  }

  @Test("all positive REST fixtures decode")
  func positiveRESTFixtures() throws {
    _ = try FixtureLoader.decode(HealthResponse.self, "health-capabilities.json")
    _ = try FixtureLoader.decode(GatewayIdentityDTO.self, "identity.json")
    _ = try FixtureLoader.decode([RegisteredAgentDTO].self, "agents-list.json")
    _ = try FixtureLoader.decode(CreateAgentRequest.self, "agent-create.json")
    _ = try FixtureLoader.decode(UpdateAgentRequest.self, "agent-update.json")
    _ = try FixtureLoader.decode(MobileActionResponseDTO.self, "agent-action-ok.json")
    _ = try FixtureLoader.decode(ModelsResponseDTO.self, "models-list.json")
    _ = try FixtureLoader.decode(CreateConversationRequest.self, "conversation-create.json")
    _ = try FixtureLoader.decode(PatchConversationRequest.self, "conversation-patch.json")
    _ = try FixtureLoader.decode(ConversationSummaryDTO.self, "conversation-summary.json")
    _ = try FixtureLoader.decode(ConversationPageDTO.self, "conversations-page.json")
    _ = try FixtureLoader.decode(
      ConversationMessagePageDTO.self,
      "conversation-messages-page.json"
    )
    _ = try FixtureLoader.decode(ReplayPageDTO.self, "replay.json")
  }

  /// Chat UX Phase 4 Task 6: `ChatState.defaultConversationTitle` hand-mirrors
  /// the gateway's `DEFAULT_CONVERSATION_TITLE`, and compose-cleanup (final
  /// review C2) is only correct while they agree — the fix wave's one real
  /// regression was exactly this drift. `conversation-defaults.json` is
  /// `const`-pinned in openapi.yaml and asserted by the gateway too, so this
  /// closes the cross-language loop.
  @Test("default conversation title matches the contract fixture")
  func defaultConversationTitleMatchesContract() throws {
    let defaults = try FixtureLoader.decode(
      ConversationDefaultsFixture.self,
      "conversation-defaults.json"
    )
    #expect(ChatState.defaultConversationTitle == defaults.defaultConversationTitle)
  }

  @Test("request fixtures re-encode to the frozen wire shape")
  func requestRoundTrips() throws {
    try expectRoundTrip(CreateAgentRequest.self, "agent-create.json")
    try expectRoundTrip(UpdateAgentRequest.self, "agent-update.json")
    try expectRoundTrip(CreateConversationRequest.self, "conversation-create.json")
    try expectRoundTrip(PatchConversationRequest.self, "conversation-patch.json")
    try expectRoundTrip(MobileWSClientFrame.self, "chat-send.json")
    try expectRoundTrip(MobileWSClientFrame.self, "chat-resume.json")
    try expectRoundTrip(MobileWSClientFrame.self, "chat-answer.json")
    try expectRoundTrip(MobileWSClientFrame.self, "chat-cancel.json")
  }

  @Test("conversation patch construction preserves omitted, value, and null")
  func patchConstruction() throws {
    let clearAndSet = try PatchConversationRequest(
      owningIssueId: .null,
      projectId: .value("project-1")
    )
    let object = try #require(
      JSONSerialization.jsonObject(
        with: ContractCoding.encoder().encode(clearAndSet)
      ) as? [String: Any]
    )
    #expect(object.keys.sorted() == ["owningIssueId", "projectId"])
    #expect(object["owningIssueId"] is NSNull)
    #expect(object["projectId"] as? String == "project-1")

    let titleOnly = try PatchConversationRequest(title: "Renamed")
    let titleObject = try #require(
      JSONSerialization.jsonObject(
        with: ContractCoding.encoder().encode(titleOnly)
      ) as? [String: Any]
    )
    #expect(titleObject.keys.sorted() == ["title"])

    #expect(throws: PatchConversationRequestError.self) {
      try PatchConversationRequest()
    }
  }

  @Test("new iOS turn builder freezes channel and resumability")
  func newTurnBuilder() {
    let frame = MobileWSClientFrame.newTurn(
      id: "turn-1",
      agentId: "agent-1",
      conversationId: "conversation-1",
      text: "Hello",
      images: nil
    )
    guard case let .message(_, _, channelId, _, _, _, resumable, streamingBehavior) = frame else {
      Issue.record("expected message frame")
      return
    }
    #expect(channelId == "ios")
    #expect(resumable == true)
    #expect(streamingBehavior == nil)
  }

  @Test("server and mixed JSONL streams decode by discriminator")
  func streamFixtures() throws {
    let serverLines = try jsonLines("chat-stream.jsonl")
    #expect(serverLines.count == 5)
    for line in serverLines {
      let frame = try ContractCoding.decoder().decode(MobileWSServerFrame.self, from: line)
      _ = try CapableServerFrame.validating(frame)
    }

    let mixedLines = try jsonLines("chat-resume.jsonl")
    #expect(mixedLines.count == 7)
    for line in mixedLines {
      let type = try discriminator(line)
      switch type {
      case "message", "resume", "answer", "cancel":
        _ = try ContractCoding.decoder().decode(MobileWSClientFrame.self, from: line)
      case "accepted", "event", "done", "error":
        _ = try ContractCoding.decoder().decode(MobileWSServerFrame.self, from: line)
      default:
        Issue.record("unclassified mixed stream discriminator: \(type)")
      }
    }
  }

  @Test("legacy frames decode but capable validation rejects ambiguous cursors")
  func capableFrameValidation() throws {
    let missingConversation = try FixtureLoader.decode(
      MobileWSServerFrame.self,
      "invalid/chat-event-missing-conversation-id.json"
    )
    #expect(throws: ContractValidationError.self) {
      try CapableServerFrame.validating(missingConversation)
    }

    let missingOutcome = try FixtureLoader.decode(
      MobileWSServerFrame.self,
      "invalid/chat-done-missing-outcome.json"
    )
    #expect(throws: ContractValidationError.self) {
      try CapableServerFrame.validating(missingOutcome)
    }

    let admissionJSON = Data(
      #"{"type":"error","id":"e1","conversationId":"c1","error":"failed","code":"conversation_busy"}"#
        .utf8
    )
    let admissionError = try ContractCoding.decoder().decode(
      MobileWSServerFrame.self,
      from: admissionJSON
    )
    guard
      case .error(_, let conversationID, let seq, _, _, _, _) =
        try CapableServerFrame
        .validating(admissionError)
    else {
      Issue.record("expected admission error")
      return
    }
    #expect(conversationID != nil)
    #expect(seq == nil)

    let preAcceptanceError = Data(#"{"type":"error","id":"e1","error":"failed"}"#.utf8)
    let preAcceptance = try ContractCoding.decoder().decode(
      MobileWSServerFrame.self,
      from: preAcceptanceError
    )
    _ = try CapableServerFrame.validating(preAcceptance)
  }

  @Test("all structured API errors decode")
  func structuredErrors() throws {
    let files = [
      "errors/unauthorized.json",
      "errors/not-found.json",
      "errors/validation-failed.json",
      "errors/revision-conflict.json",
      "errors/conversation-busy.json",
      "errors/rate-limited.json",
      "errors/gateway-offline.json",
      "errors/capability-required.json",
    ]
    for file in files {
      let error = try FixtureLoader.decode(MobileAPIError.self, file)
      #expect(error.code.isEmpty == false)
      #expect(error.error.isEmpty == false)
    }
  }

  @Test("action response rejects false")
  func actionMustBeTrue() {
    #expect(throws: (any Error).self) {
      try FixtureLoader.decode(MobileActionResponseDTO.self, "invalid/agent-action-not-ok.json")
    }
  }

  @Test("secret leak fixture cannot surface or re-encode provider keys")
  func agentSecretLeak() throws {
    let agents = try FixtureLoader.decode(
      [RegisteredAgentDTO].self,
      "invalid/agents-list-secret-leak.json"
    )
    let encoded = String(decoding: try ContractCoding.encoder().encode(agents), as: UTF8.self)
    #expect(encoded.contains("providerApiKeys") == false)
    #expect(encoded.contains("secret-that-must-never-be-emitted") == false)
  }

  @Test("SSE fixtures contain one event and one data line")
  func sseShape() throws {
    try assertSSEShape("sse-conversation-changed.txt")
    try assertSSEShape("sse-conversation-deleted.txt")
  }

  @Test("manifest inventory is exhaustive and every case has an explicit dispatcher")
  func manifestInventory() throws {
    let manifest = try FixtureLoader.decode(FixtureManifest.self, "manifest.json")
    let bundledFiles = try bundledFixtureFiles()
    #expect(manifest.version == 1)
    #expect(Set(manifest.cases.map(\.file)).count == manifest.cases.count)
    #expect(manifest.cases.map(\.file).sorted() == bundledFiles)
    for fixture in manifest.cases {
      try dispatch(fixture)
    }
  }

  private func dispatch(_ fixture: FixtureCase) throws {
    switch (fixture.format ?? "json", fixture.document, fixture.schema) {
    case ("jsonl", "chat-ws", "MobileWsServerFrame"):
      guard fixture.valid else { throw FixtureDispatchError.unsupported(fixture.file) }
      for line in try jsonLines(fixture.file) {
        _ = try ContractCoding.decoder().decode(MobileWSServerFrame.self, from: line)
      }
    case ("jsonl", "chat-ws", "MobileWsFrame"):
      guard fixture.valid else { throw FixtureDispatchError.unsupported(fixture.file) }
      for line in try jsonLines(fixture.file) {
        let type = try discriminator(line)
        if ["message", "resume", "answer", "cancel"].contains(type) {
          _ = try ContractCoding.decoder().decode(MobileWSClientFrame.self, from: line)
        } else if ["accepted", "event", "done", "error"].contains(type) {
          _ = try ContractCoding.decoder().decode(MobileWSServerFrame.self, from: line)
        } else {
          throw FixtureDispatchError.unsupported("\(fixture.file):\(type)")
        }
      }
    case ("sse", "openapi", "ConversationChangedEvent"),
      ("sse", "openapi", "ConversationDeletedEvent"):
      guard fixture.valid else { throw FixtureDispatchError.unsupported(fixture.file) }
      try assertSSEShape(fixture.file)
    case ("json", "openapi", "PairingPayload"):
      _ = try FixtureLoader.decode(PairingPayload.self, fixture.file)
    case ("json", "openapi", "MobileHealth"):
      try decodeIfValid(HealthResponse.self, fixture)
    case ("json", "openapi", "GatewayIdentity"):
      try decodeIfValid(GatewayIdentityDTO.self, fixture)
    case ("json", "openapi", "WsTicketResponse"):
      if fixture.valid {
        _ = try FixtureLoader.decode(WsTicketResponseDTO.self, fixture.file)
      } else {
        #expect(throws: (any Error).self) {
          try FixtureLoader.decode(WsTicketResponseDTO.self, fixture.file)
        }
      }
    case ("json", "openapi", "MobileAgentList"):
      if fixture.valid {
        _ = try FixtureLoader.decode([RegisteredAgentDTO].self, fixture.file)
      } else {
        _ = try FixtureLoader.data(fixture.file)
      }
    case ("json", "openapi", "MemoryInfoList"):
      if fixture.valid {
        _ = try FixtureLoader.decode([MemoryInfoDTO].self, fixture.file)
      } else {
        _ = try FixtureLoader.data(fixture.file)
      }
    case ("json", "openapi", "CreateMobileAgentRequest"):
      try decodeIfValid(CreateAgentRequest.self, fixture)
    case ("json", "openapi", "UpdateMobileAgentRequest"):
      try decodeIfValid(UpdateAgentRequest.self, fixture)
    case ("json", "openapi", "MobileActionResponse"):
      if fixture.valid {
        _ = try FixtureLoader.decode(MobileActionResponseDTO.self, fixture.file)
      } else {
        #expect(throws: (any Error).self) {
          try FixtureLoader.decode(MobileActionResponseDTO.self, fixture.file)
        }
      }
    case ("json", "openapi", "MobileModelsResponse"):
      try decodeIfValid(ModelsResponseDTO.self, fixture)
    case ("json", "openapi", "ConversationCreateRequest"):
      try decodeIfValid(CreateConversationRequest.self, fixture)
    case ("json", "openapi", "ConversationPatchRequest"):
      try decodeIfValid(PatchConversationRequest.self, fixture)
    case ("json", "openapi", "ConversationDefaults"):
      try decodeIfValid(ConversationDefaultsFixture.self, fixture)
    case ("json", "openapi", "ConversationSummary"):
      try decodeIfValid(ConversationSummaryDTO.self, fixture)
    case ("json", "openapi", "ConversationPage"):
      try decodeIfValid(ConversationPageDTO.self, fixture)
    case ("json", "openapi", "ConversationMessagePage"):
      try decodeIfValid(ConversationMessagePageDTO.self, fixture)
    case ("json", "openapi", "ReplayPage"):
      try decodeIfValid(ReplayPageDTO.self, fixture)
    case ("json", "openapi", "MobileApiError"),
      ("json", "openapi", "RevisionConflictError"),
      ("json", "openapi", "ConversationBusyError"):
      try decodeIfValid(MobileAPIError.self, fixture)
    case ("json", "chat-ws", "ChatSend"),
      ("json", "chat-ws", "ChatResume"),
      ("json", "chat-ws", "ChatAnswer"),
      ("json", "chat-ws", "ChatCancel"):
      try decodeIfValid(MobileWSClientFrame.self, fixture)
    case ("json", "chat-ws", "ChatAccepted"),
      ("json", "chat-ws", "ChatEvent"),
      ("json", "chat-ws", "ChatDone"),
      ("json", "chat-ws", "ChatError"):
      if fixture.valid {
        _ = try FixtureLoader.decode(MobileWSServerFrame.self, fixture.file)
      } else {
        _ = try FixtureLoader.data(fixture.file)
      }
    default:
      throw FixtureDispatchError.unsupported(
        "\(fixture.format ?? "json"):\(fixture.document):\(fixture.schema)"
      )
    }
  }

  private func decodeIfValid<T: Decodable>(_ type: T.Type, _ fixture: FixtureCase) throws {
    if fixture.valid {
      _ = try FixtureLoader.decode(type, fixture.file)
    } else {
      _ = try FixtureLoader.data(fixture.file)
    }
  }

  private func expectRoundTrip<T: Codable>(_ type: T.Type, _ name: String) throws {
    let source = try FixtureLoader.data(name)
    let value = try ContractCoding.decoder().decode(type, from: source)
    let encodedJSON = try canonicalJSON(ContractCoding.encoder().encode(value))
    let sourceJSON = try canonicalJSON(source)
    #expect(encodedJSON == sourceJSON)
  }

  private func canonicalJSON(_ data: Data) throws -> Data {
    let object = try JSONSerialization.jsonObject(with: data)
    return try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
  }

  private func jsonLines(_ name: String) throws -> [Data] {
    String(decoding: try FixtureLoader.data(name), as: UTF8.self)
      .split(whereSeparator: \.isNewline)
      .filter { $0.isEmpty == false }
      .map { Data($0.utf8) }
  }

  private func discriminator(_ data: Data) throws -> String {
    let value = try ContractCoding.decoder().decode(JSONValue.self, from: data)
    guard case let .string(type)? = value.objectValue?["type"] else {
      throw FixtureDispatchError.unsupported("missing type")
    }
    return type
  }

  private func assertSSEShape(_ name: String) throws {
    let lines = String(decoding: try FixtureLoader.data(name), as: UTF8.self)
      .split(whereSeparator: \.isNewline)
      .map(String.init)
    let events = lines.filter { $0.hasPrefix("event: ") && $0.dropFirst(7).isEmpty == false }
    let data = lines.filter { $0.hasPrefix("data: ") && $0.dropFirst(6).isEmpty == false }
    #expect(events.count == 1)
    #expect(data.count == 1)
  }

  private func bundledFixtureFiles() throws -> [String] {
    guard
      let root = Bundle(for: ContractFixtureBundleToken.self).resourceURL?
        .appendingPathComponent("fixtures", isDirectory: true),
      let enumerator = FileManager.default.enumerator(atPath: root.path)
    else {
      throw FixtureError.missing("fixtures/<root>")
    }
    var files: [String] = []
    while let path = enumerator.nextObject() as? String {
      var isDirectory: ObjCBool = false
      let fullPath = root.appendingPathComponent(path).path
      if FileManager.default.fileExists(atPath: fullPath, isDirectory: &isDirectory),
        isDirectory.boolValue == false,
        path != "manifest.json"
      {
        files.append(path)
      }
    }
    return files.sorted()
  }
}
