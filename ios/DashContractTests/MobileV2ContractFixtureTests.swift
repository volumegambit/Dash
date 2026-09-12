import Foundation
import Testing

@testable import Dash

@Suite("mobile v2 contract fixtures")
struct MobileV2ContractFixtureTests {
  @Test("health and bootstrap decode with independent v2 state")
  func healthAndBootstrap() throws {
    let health = try MobileV2FixtureLoader.decode(
      MobileV2HealthResponse.self,
      "health-capabilities.json"
    )
    let bootstrap = try MobileV2FixtureLoader.decode(
      MobileV2ConversationBootstrap.self,
      "conversation-bootstrap.json"
    )
    let messagePage = try MobileV2FixtureLoader.decode(
      MobileV2ConversationMessagePage.self,
      "conversation-message-page.json"
    )

    #expect(health.apiVersion == 2)
    #expect(health.capabilities.contains("chat-input-queue-v1"))
    #expect(bootstrap.v2ThroughSeq == bootstrap.conversation.v2LastSeq)
    #expect(
      bootstrap.pendingInputs.map(\.enqueueOrder)
        == bootstrap.pendingInputs.map(\.enqueueOrder).sorted()
    )
    #expect(messagePage.items.contains { $0.deliveryKind == .steer })
    #expect(messagePage.items.contains { $0.segmentIndex > 0 })
  }

  @Test("all v2 REST fixtures decode")
  func restFixtures() throws {
    try expectRoundTrip(
      MobileV2HealthResponse.self,
      "health-capabilities.json"
    )
    try expectRoundTrip(
      MobileV2ConversationSummary.self,
      "conversation-summary.json"
    )
    try expectRoundTrip(
      MobileV2ConversationSummary.self,
      "conversation-summary-subagent.json"
    )
    try expectRoundTrip(MobileV2ConversationPage.self, "conversation-page.json")
    try expectRoundTrip(
      MobileV2ConversationBootstrap.self,
      "conversation-bootstrap.json"
    )
    try expectRoundTrip(
      MobileV2ConversationBootstrap.self,
      "conversation-bootstrap-legacy-run.json"
    )
    try expectRoundTrip(
      MobileV2ConversationMessagePage.self,
      "conversation-message-page.json"
    )
    try expectRoundTrip(
      MobileV2ConversationMessage.self,
      "conversation-message-notice.json"
    )
    try expectRoundTrip(
      MobileV2ReplayPage.self,
      "conversation-replay-page.json"
    )
  }

  @Test("v2 conversation identifiers include subagent ULIDs without widening entity ids")
  func subagentConversationIdentifiers() throws {
    let child = try MobileV2FixtureLoader.decode(
      MobileV2ConversationSummary.self,
      "conversation-summary-subagent.json"
    )
    #expect(child.id == "sub_01ARZ3NDEKTSV4RRFFQ69G5FAV")
    #expect(child.kind == .subagent)
    #expect(child.parentConversationId == "00000000-0000-4000-8000-000000000001")
    #expect(child.parentTurnId == "turn-parent-01")
    #expect(child.subagent?.status == "done")
    #expect(child.subagent?.usage?.inputTokens == 120)

    try expectRoundTrip(MobileV2WsClientFrame.self, "chat-subscribe-subagent.json")

    #expect(throws: (any Error).self) {
      _ = try MobileV2FixtureLoader.decode(
        MobileV2ConversationSummary.self,
        "invalid/conversation-summary-bad-subagent-id.json"
      )
    }
    let subagentCommandID = Data(
      #"{"type":"subscribe_conversation","id":"sub_01ARZ3NDEKTSV4RRFFQ69G5FAV","agentId":"agent-01","conversationId":"sub_01ARZ3NDEKTSV4RRFFQ69G5FAV","sinceV2Seq":0}"#.utf8
    )
    #expect(throws: (any Error).self) {
      _ = try ContractCoding.decoder().decode(
        MobileV2WsClientFrame.self,
        from: subagentCommandID
      )
    }
  }

  @Test("v2 accepted exposes optional live origin kind and request correlation")
  func acceptedLiveMetadataAndReplayOmission() throws {
    let live = try MobileV2FixtureLoader.decode(
      MobileV2WsServerFrame.self,
      "chat-accepted.json"
    )
    guard case let .sequenced(
      .accepted(
        _, conversationId, _, _, _, _, _, _, origin, kind, requestId
      )
    ) = live else {
      Issue.record("Expected accepted frame")
      return
    }
    #expect(conversationId == "sub_01ARZ3NDEKTSV4RRFFQ69G5FAV")
    #expect(origin == .parent)
    #expect(kind == .subagent)
    #expect(requestId == "resume-01")

    let replay = try MobileV2FixtureLoader.decode(
      MobileV2ReplayPage.self,
      "conversation-replay-page.json"
    )
    guard case let .accepted(_, _, _, _, _, _, _, _, replayOrigin, replayKind, replayRequestId)
      = replay.frames.first
    else {
      Issue.record("Expected replayed accepted frame")
      return
    }
    #expect(replayOrigin == nil)
    #expect(replayKind == nil)
    #expect(replayRequestId == nil)

    #expect(throws: (any Error).self) {
      _ = try MobileV2FixtureLoader.decode(
        MobileV2WsServerFrame.self,
        "invalid/chat-accepted-bad-origin.json"
      )
    }
  }

  @Test("v2 conversation messages preserve only known optional origins")
  func conversationMessageOriginRoundTrip() throws {
    let source = conversationMessage(
      content: #"{"type":"user","text":"Hello"}"#,
      origin: #""parent""#
    )

    let decoded = try ContractCoding.decoder().decode(
      MobileV2ConversationMessage.self,
      from: source
    )

    #expect(decoded.origin == MessageOrigin.parent.rawValue)
    #expect(decoded.v1Projection.origin == MessageOrigin.parent.rawValue)
    #expect(try canonicalJSON(ContractCoding.encoder().encode(decoded)) == canonicalJSON(source))
    #expect(throws: (any Error).self) {
      _ = try ContractCoding.decoder().decode(
        MobileV2ConversationMessage.self,
        from: conversationMessage(
          content: #"{"type":"user","text":"Hello"}"#,
          origin: #""future""#
        )
      )
    }
  }

  @Test("v2 conversation messages preserve known notices and reject unknown content")
  func conversationMessageNoticeStrictness() throws {
    let source = conversationMessage(
      content: #"{"type":"notice","kind":"skill_learned","text":"Learned a skill"}"#
    )
    let decoded = try ContractCoding.decoder().decode(
      MobileV2ConversationMessage.self,
      from: source
    )

    #expect(decoded.content == .notice(kind: .skillLearned, text: "Learned a skill"))
    #expect(try canonicalJSON(ContractCoding.encoder().encode(decoded)) == canonicalJSON(source))
    #expect(throws: (any Error).self) {
      _ = try ContractCoding.decoder().decode(
        MobileV2ConversationMessage.self,
        from: conversationMessage(content: #"{"type":"future"}"#)
      )
    }
  }

  @Test("all v2 client fixtures round trip canonically")
  func websocketClientFramesRoundTrip() throws {
    for file in [
      "chat-hello.json", "chat-subscribe.json", "chat-subscribe-subagent.json", "chat-send.json",
      "chat-send-legacy-run.json", "chat-answer-legacy-run.json",
      "chat-cancel-legacy-run.json", "chat-send-legacy-run-max.json",
      "chat-enqueue-steer.json", "chat-enqueue-follow-up.json",
      "chat-edit-follow-up.json", "chat-remove-follow-up.json",
      "chat-resume-follow-ups.json",
    ] {
      try expectRoundTrip(MobileV2WsClientFrame.self, file)
    }
  }

  @Test("all v2 server fixtures round trip canonically")
  func websocketServerFramesRoundTrip() throws {
    let files = [
      "chat-hello-ack.json", "chat-conversation-subscribed.json",
      "chat-accepted.json", "chat-event.json", "chat-done.json", "chat-error.json",
      "input-accepted.json", "input-updated.json", "input-removed.json",
      "input-delivered.json", "input-failed.json", "queue-paused.json",
      "queue-resumed.json", "command-rejected.json", "command-rejected-legacy-run.json",
    ]
    let documents = try files.map { try MobileV2FixtureLoader.data($0) }
      + MobileV2FixtureLoader.jsonLines("chat-stream.jsonl")
      + MobileV2FixtureLoader.jsonLines("chat-stream-legacy-run.jsonl")
    for document in documents {
      let decoded = try ContractCoding.decoder().decode(
        MobileV2WsServerFrame.self,
        from: document
      )
      #expect(
        try canonicalJSON(ContractCoding.encoder().encode(decoded)) == canonicalJSON(document)
      )
    }
  }

  @Test("legacy run references remain opaque and preserve byte boundaries")
  func legacyRunReferences() throws {
    let bootstrap = try MobileV2FixtureLoader.decode(
      MobileV2ConversationBootstrap.self,
      "conversation-bootstrap-legacy-run.json"
    )
    #expect(bootstrap.conversation.activeTurnId == "turn-01")
    #expect(bootstrap.messages.first?.turnId == "turn-01")
    #expect(bootstrap.messages.first?.runId == "turn-01")

    let replay = try MobileV2FixtureLoader.decode(
      MobileV2ReplayPage.self,
      "conversation-replay-page.json"
    )
    #expect(replay.frames.first?.conversationId == bootstrap.conversation.id)

    let multibyteAtLimit = String(repeating: "🚀", count: 64)
    let multibyteOverLimit = multibyteAtLimit + "a"
    #expect(LegacyRunID.isValid(multibyteAtLimit))
    #expect(LegacyRunID.isValid(multibyteOverLimit) == false)
    #expect(LegacyRunID.isValid("\u{00a0}"))
    #expect(LegacyRunID.isValid(" \t\r\n") == false)
  }

  @Test("follow up pending metadata permits an optional target while steer requires one")
  func pendingInputTargetRules() throws {
    let followUpWithTarget = Data(
      #"{"inputId":"00000000-0000-4000-8000-000000000024","kind":"follow_up","targetTurnId":"turn-01","text":"Later","state":"queued","revision":0,"enqueueOrder":1,"createdAt":"2026-09-06T09:00:00.000Z","updatedAt":"2026-09-06T09:00:00.000Z"}"#
        .utf8
    )
    let decoded = try ContractCoding.decoder().decode(
      MobileV2PendingInput.self,
      from: followUpWithTarget
    )
    #expect(decoded.targetTurnId == "turn-01")
    #expect(
      try canonicalJSON(ContractCoding.encoder().encode(decoded))
        == canonicalJSON(followUpWithTarget)
    )

    let steerWithoutTarget = Data(
      #"{"inputId":"00000000-0000-4000-8000-000000000022","kind":"steer","text":"Now","state":"queued","revision":0,"enqueueOrder":1,"createdAt":"2026-09-06T09:00:00.000Z","updatedAt":"2026-09-06T09:00:00.000Z"}"#
        .utf8
    )
    #expect(throws: (any Error).self) {
      _ = try ContractCoding.decoder().decode(MobileV2PendingInput.self, from: steerWithoutTarget)
    }
  }

  @Test("invalid v2 frames fail decoding")
  func invalidFrames() throws {
    for file in [
      "invalid/control-with-v2-seq.json", "invalid/chat-accepted-bad-origin.json",
      "invalid/transition-without-v2-seq.json",
    ] {
      let data = try MobileV2FixtureLoader.data(file)
      #expect(throws: (any Error).self) {
        _ = try ContractCoding.decoder().decode(MobileV2WsServerFrame.self, from: data)
      }
    }
    for file in [
      "invalid/steer-without-target.json",
      "invalid/negative-revision.json",
      "invalid/non-uuid-command-id.json",
      "invalid/unknown-command-field.json",
      "invalid/legacy-run-id-too-large.json",
      "invalid/legacy-run-id-blank.json",
    ] {
      let data = try MobileV2FixtureLoader.data(file)
      #expect(throws: (any Error).self) {
        _ = try ContractCoding.decoder().decode(MobileV2WsClientFrame.self, from: data)
      }
    }

    let unknown = Data(#"{"type":"future_frame"}"#.utf8)
    #expect(throws: (any Error).self) {
      _ = try ContractCoding.decoder().decode(MobileV2WsServerFrame.self, from: unknown)
    }

    #expect(throws: (any Error).self) {
      _ = try MobileV2FixtureLoader.decode(
        MobileV2ConversationMessage.self,
        "invalid/conversation-message-bad-notice-kind.json"
      )
    }
  }

  @Test("v2 precise accuracy is a finite nonnegative safe integer on decode and encode")
  func preciseAccuracyValidation() throws {
    for accuracy in ["12.5", "-1", "9007199254740992"] {
      #expect(throws: MobileV2ContractValidationError.self) {
        _ = try ContractCoding.decoder().decode(
          MobileV2WsClientFrame.self,
          from: chatSend(location: clientLocation(accuracy: accuracy))
        )
      }
    }

    for accuracy in [12.5, -1, 9_007_199_254_740_992, .infinity, -.infinity, .nan] {
      let frame = MobileV2WsClientFrame.message(
        id: "turn-01",
        agentId: "agent-01",
        channelId: "mobile",
        conversationId: "00000000-0000-4000-8000-000000000001",
        text: "Where am I?",
        location: ClientLocation(
          timezone: "Asia/Singapore",
          utcOffsetMinutes: 480,
          locale: "en-SG",
          region: "SG",
          precise: PreciseLocation(
            latitude: 1.2966,
            longitude: 103.7764,
            accuracyMeters: accuracy,
            capturedAt: "2026-09-06T10:11:02Z",
            place: "Singapore"
          )
        ),
        images: nil,
        resumable: true
      )
      #expect(throws: MobileV2ContractValidationError.self) {
        _ = try ContractCoding.encoder().encode(frame)
      }
    }
  }

  @Test("v2 precise capturedAt decoding follows the locked RFC 3339 rules")
  func preciseCapturedAtDecoding() throws {
    for capturedAt in [
      #""2026-09-06T01:02:03Z""#,
      #""2026-09-06t01:02:03.123z""#,
      #""1990-12-31T23:59:60Z""#,
    ] {
      _ = try ContractCoding.decoder().decode(
        MobileV2WsClientFrame.self,
        from: chatSend(location: clientLocation(capturedAt: capturedAt))
      )
    }

    for capturedAt in [
      #""2026-02-30T01:02:03Z""#,
      #""2026-09-06 01:02:03Z""#,
      #""2026-09-06T01:02:60Z""#,
      #""2026-09-06T01:02:03Z\n""#,
      #""not-a-date""#,
    ] {
      #expect(throws: MobileV2ContractValidationError.self) {
        _ = try ContractCoding.decoder().decode(
          MobileV2WsClientFrame.self,
          from: chatSend(location: clientLocation(capturedAt: capturedAt))
        )
      }
    }
  }

  @Test("v2 precise capturedAt encoding rejects invalid RFC 3339")
  func preciseCapturedAtEncoding() {
    let frame = MobileV2WsClientFrame.message(
      id: "turn-01",
      agentId: "agent-01",
      channelId: "mobile",
      conversationId: "00000000-0000-4000-8000-000000000001",
      text: "Where am I?",
      location: ClientLocation(
        timezone: "Asia/Singapore",
        utcOffsetMinutes: 480,
        locale: "en-SG",
        region: "SG",
        precise: PreciseLocation(
          latitude: 1.2966,
          longitude: 103.7764,
          accuracyMeters: 13,
          capturedAt: "not-a-date",
          place: "Singapore"
        )
      ),
      images: nil,
      resumable: true
    )

    #expect(throws: MobileV2ContractValidationError.self) {
      _ = try ContractCoding.encoder().encode(frame)
    }
  }

  @Test("v2 nested AgentEvent decoding rejects an empty type")
  func nestedAgentEventTypeDecoding() {
    #expect(throws: MobileV2ContractValidationError.self) {
      _ = try ContractCoding.decoder().decode(
        MobileV2ConversationMessage.self,
        from: conversationMessage(
          content: #"{"type":"assistant","events":[{"type":""}]}"#
        )
      )
    }
    #expect(throws: MobileV2ContractValidationError.self) {
      _ = try ContractCoding.decoder().decode(
        MobileV2WsServerFrame.self,
        from: sequencedEvent(event: #"{"type":""}"#)
      )
    }
  }

  @Test("v2 nested AgentEvent encoding rejects an empty type")
  func nestedAgentEventTypeEncoding() {
    let event = AgentEvent.unknown(
      type: "",
      raw: .object(["type": .string("")])
    )
    let timestamp = Date(timeIntervalSince1970: 0)
    let message = MobileV2ConversationMessage(
      id: "00000000-0000-4000-8000-000000000111",
      conversationId: "00000000-0000-4000-8000-000000000101",
      turnId: "turn-01",
      ordinal: 1,
      role: .assistant,
      status: .completed,
      content: .assistant(events: [event]),
      createdAt: timestamp,
      updatedAt: timestamp,
      runId: "turn-01",
      segmentIndex: 0,
      deliveryKind: .normal,
      deliveryStatus: nil
    )
    let frame = MobileV2WsServerFrame.sequenced(
      .event(
        id: "00000000-0000-4000-8000-000000000003",
        conversationId: "00000000-0000-4000-8000-000000000001",
        v2Seq: 2,
        runId: "00000000-0000-4000-8000-000000000003",
        segmentTurnId: "00000000-0000-4000-8000-000000000003",
        event: event
      )
    )

    #expect(throws: MobileV2ContractValidationError.self) {
      _ = try ContractCoding.encoder().encode(message)
    }
    #expect(throws: MobileV2ContractValidationError.self) {
      _ = try ContractCoding.encoder().encode(frame)
    }
  }

  @Test("v2 nested AgentEvent preserves unknown nonempty types")
  func nestedUnknownAgentEventRoundTrips() throws {
    let rawEvent = #"{"type":"future_event","future":{"value":1}}"#
    let messageSource = conversationMessage(
      content: #"{"type":"assistant","events":["# + rawEvent + "]}"
    )
    let message = try ContractCoding.decoder().decode(
      MobileV2ConversationMessage.self,
      from: messageSource
    )
    #expect(
      try canonicalJSON(ContractCoding.encoder().encode(message))
        == canonicalJSON(messageSource)
    )

    let frameSource = sequencedEvent(event: rawEvent)
    let frame = try ContractCoding.decoder().decode(
      MobileV2WsServerFrame.self,
      from: frameSource
    )
    #expect(
      try canonicalJSON(ContractCoding.encoder().encode(frame))
        == canonicalJSON(frameSource)
    )
  }

  @Test("v2 location string bounds count Unicode code points")
  func locationStringCodePointBounds() throws {
    let exactBoundary = String(repeating: "e\u{301}", count: 100)
    let overBoundary = exactBoundary + "a"
    let twoCodePointRegion = "e\u{301}"

    _ = try ContractCoding.decoder().decode(
      MobileV2WsClientFrame.self,
      from: chatSend(
        location: clientLocation(
          timezone: try jsonString(exactBoundary),
          region: try jsonString(twoCodePointRegion)
        )
      )
    )
    #expect(throws: MobileV2ContractValidationError.self) {
      _ = try ContractCoding.decoder().decode(
        MobileV2WsClientFrame.self,
        from: chatSend(
          location: clientLocation(timezone: try jsonString(overBoundary))
        )
      )
    }
  }

  @Test("v2 nested contract objects reject extra keys")
  func nestedObjectsRejectExtraKeys() throws {
    let clientDocuments = [
      chatSend(
        location: clientLocation(extra: #","future":true"#)
      ),
      chatSend(
        location: clientLocation(
          preciseExtra: #","future":true"#
        )
      ),
      chatSend(images: #"[{"mediaType":"image/png","data":"aGVsbG8=","future":true}]"#),
    ]
    for document in clientDocuments {
      #expect(throws: MobileV2ContractValidationError.self) {
        _ = try ContractCoding.decoder().decode(MobileV2WsClientFrame.self, from: document)
      }
    }

    for content in [
      #"{"type":"user","text":"Hello","future":true}"#,
      #"{"type":"assistant","events":[],"future":true}"#,
      #"{"type":"user","text":"Hello","images":[{"mediaType":"image/png","data":"aGVsbG8=","future":true}]}"#,
    ] {
      #expect(throws: MobileV2ContractValidationError.self) {
        _ = try ContractCoding.decoder().decode(
          MobileV2ConversationMessage.self,
          from: conversationMessage(content: content)
        )
      }
    }

    #expect(throws: MobileV2ContractValidationError.self) {
      _ = try ContractCoding.decoder().decode(
        MobileV2PendingInput.self,
        from: pendingInput(
          images: #"[{"mediaType":"image/png","data":"aGVsbG8=","future":true}]"#
        )
      )
    }
  }

  @Test("v2 optional nested values reject explicit null")
  func optionalNestedValuesRejectExplicitNull() throws {
    for document in [
      chatSend(location: "null"),
      chatSend(images: "null"),
      chatSend(location: clientLocation(region: "null")),
      chatSend(location: clientLocation(precise: "null")),
      chatSend(location: clientLocation(place: "null")),
    ] {
      #expect(throws: MobileV2ContractValidationError.self) {
        _ = try ContractCoding.decoder().decode(MobileV2WsClientFrame.self, from: document)
      }
    }

    #expect(throws: MobileV2ContractValidationError.self) {
      _ = try ContractCoding.decoder().decode(
        MobileV2ConversationMessage.self,
        from: conversationMessage(
          content: #"{"type":"user","text":"Hello","images":null}"#
        )
      )
    }
    #expect(throws: MobileV2ContractValidationError.self) {
      _ = try ContractCoding.decoder().decode(
        MobileV2ConversationMessage.self,
        from: conversationMessage(
          content: #"{"type":"user","text":"Hello"}"#,
          origin: "null"
        )
      )
    }
    #expect(throws: MobileV2ContractValidationError.self) {
      _ = try ContractCoding.decoder().decode(
        MobileV2PendingInput.self,
        from: pendingInput(images: "null")
      )
    }
  }

  private func expectRoundTrip<T: Codable>(_ type: T.Type, _ name: String) throws {
    let source = try MobileV2FixtureLoader.data(name)
    let decoded = try ContractCoding.decoder().decode(type, from: source)
    #expect(try canonicalJSON(ContractCoding.encoder().encode(decoded)) == canonicalJSON(source))
  }

  private func canonicalJSON(_ data: Data) throws -> Data {
    let value = try JSONSerialization.jsonObject(with: data)
    return try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
  }

  private func chatSend(
    location: String? = nil,
    images: String? = nil
  ) -> Data {
    let locationField = location.map { #","location":"# + $0 } ?? ""
    let imagesField = images.map { #","images":"# + $0 } ?? ""
    return Data(
      """
      {"type":"message","id":"turn-01","agentId":"agent-01","channelId":"mobile","conversationId":"00000000-0000-4000-8000-000000000001","text":"Hello"\(locationField)\(imagesField),"resumable":true}
      """.utf8
    )
  }

  private func clientLocation(
    accuracy: String = "13",
    capturedAt: String = #""2026-09-06T10:11:02Z""#,
    timezone: String = #""Asia/Singapore""#,
    region: String = #""SG""#,
    precise: String? = nil,
    place: String = #""Singapore""#,
    extra: String = "",
    preciseExtra: String = ""
  ) -> String {
    let preciseValue = precise ??
      #"{"latitude":1.2966,"longitude":103.7764,"accuracyMeters":"#
      + accuracy
      + #","capturedAt":"#
      + capturedAt
      + #","place":"#
      + place
      + preciseExtra
      + "}"
    return
      #"{"timezone":"#
      + timezone
      + #","utcOffsetMinutes":480,"locale":"en-SG","region":"#
      + region
      + #","precise":"#
      + preciseValue
      + extra
      + "}"
  }

  private func sequencedEvent(event: String) -> Data {
    Data(
      """
      {"type":"event","id":"00000000-0000-4000-8000-000000000003","conversationId":"00000000-0000-4000-8000-000000000001","runId":"00000000-0000-4000-8000-000000000003","segmentTurnId":"00000000-0000-4000-8000-000000000003","v2Seq":2,"event":\(event)}
      """.utf8
    )
  }

  private func jsonString(_ value: String) throws -> String {
    String(decoding: try JSONEncoder().encode(value), as: UTF8.self)
  }

  private func conversationMessage(content: String, origin: String? = nil) -> Data {
    let originField = origin.map { #","origin":"# + $0 } ?? ""
    return Data(
      """
      {"id":"00000000-0000-4000-8000-000000000111","conversationId":"00000000-0000-4000-8000-000000000101","turnId":"turn-01","ordinal":1,"role":"user","status":"completed","content":\(content),"createdAt":"2026-09-06T09:01:00.000Z","updatedAt":"2026-09-06T09:01:00.000Z","runId":"turn-01","segmentIndex":0,"deliveryKind":"normal"\(originField)}
      """.utf8
    )
  }

  private func pendingInput(images: String) -> Data {
    Data(
      """
      {"inputId":"00000000-0000-4000-8000-000000000024","kind":"follow_up","text":"Later","images":\(images),"state":"queued","revision":0,"enqueueOrder":1,"createdAt":"2026-09-06T09:00:00.000Z","updatedAt":"2026-09-06T09:00:00.000Z"}
      """.utf8
    )
  }
}
