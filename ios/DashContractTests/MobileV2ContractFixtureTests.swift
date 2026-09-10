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
      MobileV2ReplayPage.self,
      "conversation-replay-page.json"
    )
  }

  @Test("all v2 client fixtures round trip canonically")
  func websocketClientFramesRoundTrip() throws {
    for file in [
      "chat-hello.json", "chat-subscribe.json", "chat-send.json",
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
      "invalid/control-with-v2-seq.json",
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
    region: String = #""SG""#,
    precise: String? = nil,
    place: String = #""Singapore""#,
    extra: String = "",
    preciseExtra: String = ""
  ) -> String {
    let preciseValue = precise ??
      #"{"latitude":1.2966,"longitude":103.7764,"accuracyMeters":"#
      + accuracy
      + #","capturedAt":"2026-09-06T10:11:02Z","place":"#
      + place
      + preciseExtra
      + "}"
    return
      #"{"timezone":"Asia/Singapore","utcOffsetMinutes":480,"locale":"en-SG","region":"#
      + region
      + #","precise":"#
      + preciseValue
      + extra
      + "}"
  }

  private func conversationMessage(content: String) -> Data {
    Data(
      """
      {"id":"00000000-0000-4000-8000-000000000111","conversationId":"00000000-0000-4000-8000-000000000101","turnId":"turn-01","ordinal":1,"role":"user","status":"completed","content":\(content),"createdAt":"2026-09-06T09:01:00.000Z","updatedAt":"2026-09-06T09:01:00.000Z","runId":"turn-01","segmentIndex":0,"deliveryKind":"normal"}
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
