import Foundation
import Testing

@testable import Dash

@Suite("Chat connection", .serialized)
struct ChatConnectionTests {
  private let turnID = "018f0f4a-5c42-7a8b-9c01-2234567890ab"
  private let conversationID = "018f0f4a-5c42-7a8b-9c01-1234567890ab"

  @Test("detach closes without sending cancel")
  func detachDoesNotCancel() async throws {
    let task = FakeWebSocketTask()
    let connection = makeChatConnection(task: task)
    try await connection.connect()
    try await connection.sendTurn(
      id: turnID,
      agentID: "agent-1",
      conversationID: conversationID,
      text: "Hello",
      images: []
    )

    await connection.detach()

    #expect(await task.sentFrames.count == 1)
    guard let first = await task.sentFrames.first, case .message = first else {
      Issue.record("detach sent a non-message frame")
      return
    }
    #expect(await task.waitForClose() == .goingAway)
  }

  @Test("explicit cancel sends the canonical frame without closing")
  func explicitCancel() async throws {
    let task = FakeWebSocketTask()
    let connection = makeChatConnection(task: task)
    try await connection.connect()

    try await connection.cancel(turnID: turnID)

    #expect(await task.sentFrames.last == .cancel(id: turnID))
    #expect(await task.closeCode == nil)
    await connection.detach()
  }

  @Test("message resume and answer use the frozen mobile frame shapes")
  func outboundFrameShapes() async throws {
    let task = FakeWebSocketTask()
    let connection = makeChatConnection(task: task)
    try await connection.connect()
    let image = MessageImage(mediaType: .png, data: "aGVsbG8=")

    try await connection.sendTurn(
      id: turnID,
      agentID: "agent-1",
      conversationID: conversationID,
      text: "Hello",
      images: [image]
    )
    try await connection.resume(
      turnID: turnID,
      agentID: "agent-1",
      conversationID: conversationID,
      sinceSeq: 7
    )
    try await connection.answer(turnID: turnID, questionID: "question-1", answer: "Yes")

    #expect(
      await task.sentFrames == [
        .newTurn(
          id: turnID,
          agentId: "agent-1",
          conversationId: conversationID,
          text: "Hello",
          images: [image]
        ),
        .resume(
          id: turnID,
          agentId: "agent-1",
          conversationId: conversationID,
          sinceSeq: 7
        ),
        .answer(id: turnID, questionId: "question-1", answer: "Yes"),
      ]
    )
    await connection.detach()
  }

  @Test("a new turn carries the location the provider reports")
  func locationIsAttachedToANewTurn() async throws {
    let task = FakeWebSocketTask()
    let location = ClientLocation(
      timezone: "Asia/Singapore",
      utcOffsetMinutes: 480,
      locale: "en-SG",
      region: "SG",
      precise: nil
    )
    let connection = makeChatConnection(task: task, location: location)
    try await connection.connect()

    try await connection.sendTurn(
      id: turnID,
      agentID: "agent-1",
      conversationID: conversationID,
      text: "where am I?",
      images: []
    )

    guard case let .message(_, _, _, _, _, sent, _, _, _) = await task.sentFrames.first else {
      Issue.record("expected a message frame")
      return
    }
    #expect(sent == location)
    await connection.detach()
  }

  @Test("relay request keeps chat credentials out of the URL")
  func relayRequest() async throws {
    let task = FakeWebSocketTask()
    let session = FakeWebSocketSession(tasks: [task])
    let connection = ChatConnection(
      endpoint: relayEndpoint(chatToken: "chat token&value"),
      selection: .v1,
      session: session
    )

    try await connection.connect()

    let request = try #require(session.requests.first)
    let url = try #require(request.url)
    let components = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false))
    #expect(components.path == "/ws/chat")
    #expect(components.queryItems == nil)
    #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer chat token&value")
    #expect(request.url?.absoluteString.contains("chat%20token") == false)
    #expect(request.value(forHTTPHeaderField: "x-dash-relay-credential") == "relay-secret")
    #expect(request.url?.absoluteString.contains("management-secret") == false)
    #expect(request.url?.absoluteString.contains("relay-secret") == false)
    await connection.detach()
  }

  @Test("a fresh connect replaces the previous socket")
  func connectReplacesSocket() async throws {
    let first = FakeWebSocketTask()
    let second = FakeWebSocketTask()
    let session = FakeWebSocketSession(tasks: [first, second])
    let connection = makeChatConnection(session: session)

    try await connection.connect()
    try await connection.connect()

    #expect(await first.closeCode == .goingAway)
    #expect(await first.resumeCount == 1)
    #expect(await second.resumeCount == 1)
    #expect(session.requests.count == 2)
    await connection.detach()
  }

  @Test("background suspension keeps the production chat seam reusable")
  func suspendReconnectsAndResumes() async throws {
    let first = FakeWebSocketTask()
    let second = FakeWebSocketTask()
    let session = FakeWebSocketSession(tasks: [first, second])
    let connection = makeChatConnection(session: session)

    try await connection.connect()
    await connection.suspend()
    try await connection.connect()
    try await connection.resume(
      turnID: turnID,
      agentID: "agent-1",
      conversationID: conversationID,
      sinceSeq: 7
    )

    #expect(await first.closeCode == .goingAway)
    #expect(
      await second.sentFrames
        == [
          .resume(
            id: turnID,
            agentId: "agent-1",
            conversationId: conversationID,
            sinceSeq: 7
          )
        ]
    )
    #expect(session.requests.count == 2)
    await connection.detach()
  }

  @Test("a stale peer-close lookup cannot reconnect over a replacement socket")
  func stalePeerCloseCannotReconnect() async throws {
    let failed = FakeWebSocketTask()
    let replacement = FakeWebSocketTask()
    let unexpectedReconnect = FakeWebSocketTask()
    let session = FakeWebSocketSession(tasks: [failed, replacement, unexpectedReconnect])
    let clock = TestAppClock(now: Date(timeIntervalSince1970: 0))
    let connection = makeChatConnection(session: session, clock: clock)
    await failed.holdNextPeerClose()
    try await connection.connect()

    await failed.fail()
    await failed.waitForHeldPeerClose()
    try await connection.connect()
    await failed.releasePeerClose()
    await settleConcurrentWork()

    #expect(session.requests.count == 2)
    #expect(await clock.sleeps.isEmpty)
    #expect(await replacement.closeCode == nil)
    #expect(await unexpectedReconnect.resumeCount == 0)
    await connection.detach()
  }

  @Test("an older failed turn send cannot clear the newer active turn")
  func staleTurnSendFailureKeepsNewerActiveTurn() async throws {
    let olderTurnID = "018f0f4a-5c42-7a8b-9c01-999999999999"
    let task = FakeWebSocketTask()
    let connection = makeChatConnection(task: task)
    let receivedFrame = Task { await firstFrame(from: connection) }
    try await connection.connect()
    await task.holdNextSend()
    let olderSend = Task {
      do {
        try await connection.sendTurn(
          id: olderTurnID,
          agentID: "agent-1",
          conversationID: conversationID,
          text: "Older",
          images: []
        )
        return false
      } catch {
        return true
      }
    }
    await task.waitForHeldSend()

    try await connection.sendTurn(
      id: turnID,
      agentID: "agent-1",
      conversationID: conversationID,
      text: "Newer",
      images: []
    )
    await task.failHeldSend()
    #expect(await olderSend.value)
    let accepted = try fixture("chat-accepted.json")
    await task.enqueue(.string(serverJSON(accepted)))
    await task.fail(peerClose: .init(code: 4001, reason: Data("Unauthorized".utf8)))

    #expect(await receivedFrame.value == accepted)
  }

  @Test("an older failed resume cannot clear the newer capable turn")
  func staleResumeFailureKeepsNewerCapableTurn() async throws {
    let olderTurnID = "018f0f4a-5c42-7a8b-9c01-999999999999"
    let task = FakeWebSocketTask()
    let connection = makeChatConnection(task: task)
    let terminal = Task { await terminalError(from: connection) }
    try await connection.connect()
    await task.holdNextSend()
    let olderResume = Task {
      do {
        try await connection.resume(
          turnID: olderTurnID,
          agentID: "agent-1",
          conversationID: conversationID,
          sinceSeq: 0
        )
        return false
      } catch {
        return true
      }
    }
    await task.waitForHeldSend()

    try await connection.resume(
      turnID: turnID,
      agentID: "agent-1",
      conversationID: conversationID,
      sinceSeq: 0
    )
    await task.failHeldSend()
    #expect(await olderResume.value)
    await task.enqueue(
      .string(
        String(
          data: try FixtureLoader.data("invalid/chat-event-missing-conversation-id.json"),
          encoding: .utf8
        )!))
    await task.fail(peerClose: .init(code: 4001, reason: Data("Unauthorized".utf8)))

    #expect(await terminal.value == .updateRequired)
  }

  @Test("a send that succeeds on a replaced socket is rejected without clearing the newer turn")
  func staleSuccessfulSendAfterReplacement() async throws {
    let olderTurnID = "018f0f4a-5c42-7a8b-9c01-999999999999"
    let replaced = FakeWebSocketTask()
    let replacement = FakeWebSocketTask()
    let session = FakeWebSocketSession(tasks: [replaced, replacement])
    let connection = makeChatConnection(session: session)
    let receivedFrame = Task { await firstFrame(from: connection) }
    try await connection.connect()
    await replaced.holdNextSend()
    let staleSend = Task {
      await chatGatewayError {
        try await connection.sendTurn(
          id: olderTurnID,
          agentID: "agent-1",
          conversationID: conversationID,
          text: "Older",
          images: []
        )
      }
    }
    await replaced.waitForHeldSend()

    try await connection.connect()
    try await connection.sendTurn(
      id: turnID,
      agentID: "agent-1",
      conversationID: conversationID,
      text: "Newer",
      images: []
    )
    await replaced.succeedHeldSend()

    #expect(await staleSend.value == .transport("Chat connection changed while sending"))
    let accepted = try fixture("chat-accepted.json")
    await replacement.enqueue(.string(serverJSON(accepted)))
    await replacement.fail(peerClose: .init(code: 4001, reason: Data("Unauthorized".utf8)))
    #expect(await receivedFrame.value == accepted)
  }

  @Test("a resume that succeeds after detach is rejected")
  func staleSuccessfulResumeAfterDetach() async throws {
    let task = FakeWebSocketTask()
    let connection = makeChatConnection(task: task)
    try await connection.connect()
    await task.holdNextSend()
    let staleResume = Task {
      await chatGatewayError {
        try await connection.resume(
          turnID: turnID,
          agentID: "agent-1",
          conversationID: conversationID,
          sinceSeq: 0
        )
      }
    }
    await task.waitForHeldSend()

    await connection.detach()
    await task.succeedHeldSend()

    #expect(await staleResume.value == .transport("Chat connection changed while sending"))
  }

  @Test("only the active turn emits accepted event and terminal done frames with their sequences")
  func activeTurnFilteringAndSequences() async throws {
    let task = FakeWebSocketTask()
    let connection = makeChatConnection(task: task)
    let frames = Task { try await collectFrames(from: connection, count: 3) }
    try await connection.connect()
    try await connection.sendTurn(
      id: turnID,
      agentID: "agent-1",
      conversationID: conversationID,
      text: "Hello",
      images: []
    )

    await task.enqueue(
      .string(
        serverJSON(
          .accepted(
            id: "018f0f4a-5c42-7a8b-9c01-999999999999",
            conversationId: conversationID,
            userMessageId: "018f0f4a-5c42-7a8b-9c01-3234567890ab",
            assistantMessageId: "018f0f4a-5c42-7a8b-9c01-4234567890ab",
            revision: 2,
            seq: 1
          ))))
    let expected = try canonicalFrames()
    for frame in expected {
      await task.enqueue(.string(serverJSON(frame)))
    }

    #expect(try await frames.value == expected)
    await connection.detach()
  }

  @Test("simultaneous resumed turns retain and emit both live subscriptions")
  func simultaneousResumedTurns() async throws {
    let otherTurnID = "018f0f4a-5c42-7a8b-9c01-9234567890ab"
    let otherConversationID = "018f0f4a-5c42-7a8b-9c01-8234567890ab"
    let task = FakeWebSocketTask()
    let connection = makeChatConnection(task: task)
    let received = Task { try await collectFrames(from: connection, count: 2) }
    try await connection.connect()
    try await connection.resume(
      turnID: turnID,
      agentID: "agent-1",
      conversationID: conversationID,
      sinceSeq: 2
    )
    try await connection.resume(
      turnID: otherTurnID,
      agentID: "agent-2",
      conversationID: otherConversationID,
      sinceSeq: 4
    )
    let first = MobileWSServerFrame.event(
      id: turnID,
      conversationId: conversationID,
      seq: 3,
      event: .textDelta(text: "First")
    )
    let second = MobileWSServerFrame.event(
      id: otherTurnID,
      conversationId: otherConversationID,
      seq: 5,
      event: .textDelta(text: "Second")
    )

    await task.enqueue(.string(serverJSON(first)))
    await task.enqueue(.string(serverJSON(second)))

    #expect(try await received.value == [first, second])
    await connection.detach()
  }

  @Test("unsequenced conversation admission error remains a legal live frame")
  func admissionErrorWithoutSequence() async throws {
    let first = FakeWebSocketTask()
    let second = FakeWebSocketTask()
    let session = FakeWebSocketSession(tasks: [first, second])
    let clock = TestAppClock(now: Date(timeIntervalSince1970: 0))
    let connection = makeChatConnection(session: session, clock: clock)
    let received = Task { try await collectFrames(from: connection, count: 1) }
    try await connection.connect()
    try await connection.resume(
      turnID: "018f0f4a-5c42-7a8b-9c01-5234567890ab",
      agentID: "agent-1",
      conversationID: conversationID,
      sinceSeq: 2
    )
    let admission = MobileWSServerFrame.error(
      id: "018f0f4a-5c42-7a8b-9c01-5234567890ab",
      conversationId: conversationID,
      seq: nil,
      error: "Conversation already has an active turn",
      code: "conversation_busy",
      retryable: true,
      activeTurnId: turnID
    )

    await first.enqueue(.string(serverJSON(admission)))
    #expect(try await received.value == [admission])
    await first.fail()
    await waitForRequestCount(2, in: session)
    await settleConcurrentWork()

    #expect(await second.sentFrames.isEmpty)
    await connection.detach()
  }

  @Test("a capable event before new-turn acceptance requires an update")
  func eventBeforeAcceptanceRequiresUpdate() async throws {
    let task = FakeWebSocketTask()
    let connection = makeChatConnection(task: task)
    let terminal = Task { await terminalError(from: connection) }
    try await connection.connect()
    try await connection.sendTurn(
      id: turnID,
      agentID: "agent-1",
      conversationID: conversationID,
      text: "Hello",
      images: []
    )

    await task.enqueue(
      .string(
        serverJSON(
          .event(
            id: turnID,
            conversationId: conversationID,
            seq: 1,
            event: .textDelta(text: "Too early")
          ))))
    await task.fail(peerClose: .init(code: 4001, reason: Data("Unauthorized".utf8)))

    #expect(await terminal.value == .updateRequired)
    #expect(await task.closeCode == .goingAway)
  }

  @Test("a capable done before new-turn acceptance requires an update")
  func doneBeforeAcceptanceRequiresUpdate() async throws {
    let task = FakeWebSocketTask()
    let connection = makeChatConnection(task: task)
    let terminal = Task { await terminalError(from: connection) }
    try await connection.connect()
    try await connection.sendTurn(
      id: turnID,
      agentID: "agent-1",
      conversationID: conversationID,
      text: "Hello",
      images: []
    )

    await task.enqueue(
      .string(
        serverJSON(
          .done(
            id: turnID,
            conversationId: conversationID,
            seq: 1,
            outcome: .completed
          ))))
    await task.fail(peerClose: .init(code: 4001, reason: Data("Unauthorized".utf8)))

    #expect(await terminal.value == .updateRequired)
    #expect(await task.closeCode == .goingAway)
  }

  @Test("a valid rejection before new-turn acceptance remains a legal frame")
  func rejectionBeforeAcceptanceRemainsLegal() async throws {
    let task = FakeWebSocketTask()
    let connection = makeChatConnection(task: task)
    let received = Task { try await collectFrames(from: connection, count: 1) }
    try await connection.connect()
    try await connection.sendTurn(
      id: turnID,
      agentID: "agent-1",
      conversationID: conversationID,
      text: "Hello",
      images: []
    )
    let rejection = MobileWSServerFrame.error(
      id: turnID,
      conversationId: conversationID,
      seq: nil,
      error: "Conversation already has an active turn",
      code: "conversation_busy",
      retryable: true,
      activeTurnId: "other-turn"
    )

    await task.enqueue(.string(serverJSON(rejection)))

    #expect(try await received.value == [rejection])
    await connection.detach()
  }

  @Test("a sequenced error before new-turn acceptance requires an update")
  func sequencedErrorBeforeAcceptanceRequiresUpdate() async throws {
    let task = FakeWebSocketTask()
    let connection = makeChatConnection(task: task)
    let terminal = Task { await terminalError(from: connection) }
    try await connection.connect()
    try await connection.sendTurn(
      id: turnID,
      agentID: "agent-1",
      conversationID: conversationID,
      text: "Hello",
      images: []
    )

    await task.enqueue(
      .string(
        serverJSON(
          .error(
            id: turnID,
            conversationId: conversationID,
            seq: 1,
            error: "Terminal after hidden admission",
            code: "server_error",
            retryable: false,
            activeTurnId: nil
          ))))
    await task.fail(peerClose: .init(code: 4001, reason: Data("Unauthorized".utf8)))

    #expect(await terminal.value == .updateRequired)
    #expect(await task.closeCode == .goingAway)
  }

  @Test("malformed required fields on a resumed capable turn require an update")
  func malformedCapableFrame() async throws {
    let task = FakeWebSocketTask()
    let connection = makeChatConnection(task: task)
    let terminal = Task { await terminalError(from: connection) }
    try await connection.connect()
    try await connection.resume(
      turnID: turnID,
      agentID: "agent-1",
      conversationID: conversationID,
      sinceSeq: 0
    )

    await task.enqueue(
      .string(
        String(
          data: try FixtureLoader.data("invalid/chat-event-missing-conversation-id.json"),
          encoding: .utf8
        )!))
    await task.fail(peerClose: .init(code: 4001, reason: Data("Unauthorized".utf8)))

    #expect(await terminal.value == .updateRequired)
    #expect(await task.closeCode == .goingAway)
  }

  @Test("unknown agent events remain successful capable frames")
  func unknownAgentEvent() async throws {
    let task = FakeWebSocketTask()
    let connection = makeChatConnection(task: task)
    let frames = Task { try await collectFrames(from: connection, count: 2) }
    try await connection.connect()
    try await connection.sendTurn(
      id: turnID,
      agentID: "agent-1",
      conversationID: conversationID,
      text: "Hello",
      images: []
    )

    let accepted = try fixture("chat-accepted.json")
    let unknown = try fixtureLine("chat-resume.jsonl", index: 6, replacingID: turnID)
    await task.enqueue(.string(serverJSON(accepted)))
    await task.enqueue(.data(Data(serverJSON(unknown).utf8)))

    let values = try await frames.value
    #expect(values == [accepted, unknown])
    guard case .event(_, _, let seq, let event) = values.last else {
      Issue.record("Expected unknown agent event frame")
      return
    }
    #expect(seq == 8)
    guard case .unknown(let type, _) = event else {
      Issue.record("Unknown agent event was rejected")
      return
    }
    #expect(type == "future_runtime_marker")
    await connection.detach()
  }

  @Test("invalid UTF-8 binary frames require an update")
  func invalidBinaryUTF8() async throws {
    let task = FakeWebSocketTask()
    let connection = makeChatConnection(task: task)
    let terminal = Task { await terminalError(from: connection) }
    try await connection.connect()
    try await connection.sendTurn(
      id: turnID,
      agentID: "agent-1",
      conversationID: conversationID,
      text: "Hello",
      images: []
    )

    await task.enqueue(.data(Data([0xFF, 0xFE])))

    #expect(await terminal.value == .updateRequired)
    #expect(await task.closeCode == .goingAway)
  }

  @Test(arguments: [4001, 4401])
  func authenticationCloseCodesAreUnauthorized(code: Int) async throws {
    let task = FakeWebSocketTask()
    let session = FakeWebSocketSession(tasks: [task])
    let connection = makeChatConnection(session: session)
    let terminal = Task { await terminalError(from: connection) }
    try await connection.connect()

    await task.fail(peerClose: .init(code: code, reason: Data("Unauthorized".utf8)))

    #expect(await terminal.value == .unauthorized)
    #expect(session.requests.count == 1)
  }

  @Test("a terminal stream rejects reconnect instead of discarding future events")
  func terminalStreamRejectsReconnect() async throws {
    let terminalSocket = FakeWebSocketTask()
    let unusedSocket = FakeWebSocketTask()
    let session = FakeWebSocketSession(tasks: [terminalSocket, unusedSocket])
    let connection = makeChatConnection(session: session)
    let terminal = Task { await terminalError(from: connection) }
    try await connection.connect()
    await terminalSocket.fail(
      peerClose: .init(code: 4001, reason: Data("Unauthorized".utf8))
    )
    #expect(await terminal.value == .unauthorized)

    let error = await chatGatewayError { try await connection.connect() }

    #expect(error == .transport("Chat connection stream is finished"))
    #expect(session.requests.count == 1)
    #expect(await unusedSocket.resumeCount == 0)
    await connection.detach()
  }

  @Test("rate limit close parses safe numeric and JSON reasons")
  func rateLimitCloseReasons() async throws {
    for (reason, expected) in [
      ("30", GatewayError.rateLimited(retryAfter: .seconds(30))),
      (#"{"retryAfterSeconds":12.5}"#, .rateLimited(retryAfter: .milliseconds(12_500))),
      ("1e309", .rateLimited(retryAfter: nil)),
      (#"{"retryAfterSeconds":true}"#, .rateLimited(retryAfter: nil)),
      (#"{"retryAfterSeconds":1e300}"#, .rateLimited(retryAfter: nil)),
      (#"{"retryAfterSeconds":-1}"#, .rateLimited(retryAfter: nil)),
    ] {
      let task = FakeWebSocketTask()
      let connection = makeChatConnection(task: task)
      let terminal = Task { await terminalError(from: connection) }
      try await connection.connect()

      await task.fail(peerClose: .init(code: 4429, reason: Data(reason.utf8)))

      #expect(await terminal.value == expected)
    }
  }

  @Test("ordinary socket loss reconnects once after clocked backoff")
  func abnormalCloseReconnectsWithoutTightLoop() async throws {
    let first = FakeWebSocketTask()
    let second = FakeWebSocketTask()
    let session = FakeWebSocketSession(tasks: [first, second])
    let clock = TestAppClock(now: Date(timeIntervalSince1970: 0))
    let connection = makeChatConnection(session: session, clock: clock)
    let states = Task { try await collectStates(from: connection, count: 5) }
    try await connection.connect()

    await first.fail()

    #expect(
      try await states.value == [
        .connecting,
        .connected,
        .reconnecting(attempt: 1),
        .connecting,
        .connected,
      ]
    )
    #expect(await clock.sleeps == [.seconds(1)])
    #expect(session.requests.count == 2)
    await connection.detach()
  }

  @Test("a validated frame resets reconnect backoff for the next independent outage")
  func validatedFrameResetsReconnectBackoff() async throws {
    let first = FakeWebSocketTask()
    let recovered = FakeWebSocketTask()
    let secondRecovery = FakeWebSocketTask()
    let session = FakeWebSocketSession(tasks: [first, recovered, secondRecovery])
    let clock = TestAppClock(now: Date(timeIntervalSince1970: 0))
    let connection = makeChatConnection(session: session, clock: clock)
    let frameReceived = TestGate()
    let events = Task { () throws -> ([ChatTransportState], [MobileWSServerFrame]) in
      var states: [ChatTransportState] = []
      var frames: [MobileWSServerFrame] = []
      for try await event in await connection.events() {
        switch event {
        case .state(let state):
          states.append(state)
        case .frame(let frame):
          frames.append(frame)
          await frameReceived.release()
        case .v2Frame:
          break
        }
        if states.count == 8, frames.count == 1 { break }
      }
      return (states, frames)
    }
    let accepted = try fixture("chat-accepted.json")
    try await connection.connect()
    try await connection.sendTurn(
      id: turnID,
      agentID: "agent-1",
      conversationID: conversationID,
      text: "Recover twice",
      images: []
    )

    await first.fail()
    await waitForRequestCount(2, in: session)
    await recovered.enqueue(.string(serverJSON(accepted)))
    await frameReceived.wait()
    await recovered.fail()
    let (states, frames) = try await events.value

    #expect(
      states == [
        .connecting,
        .connected,
        .reconnecting(attempt: 1),
        .connecting,
        .connected,
        .reconnecting(attempt: 1),
        .connecting,
        .connected,
      ]
    )
    #expect(frames == [accepted])
    #expect(await clock.sleeps == [.seconds(1), .seconds(1)])
    #expect(session.requests.count == 3)
    await connection.detach()
  }

  @Test("transient reconnect replays the active resume subscription")
  func transientReconnectReplaysResume() async throws {
    let otherTurnID = "018f0f4a-5c42-7a8b-9c01-9234567890ab"
    let otherConversationID = "018f0f4a-5c42-7a8b-9c01-8234567890ab"
    let first = FakeWebSocketTask()
    let second = FakeWebSocketTask()
    let session = FakeWebSocketSession(tasks: [first, second])
    let clock = TestAppClock(now: Date(timeIntervalSince1970: 0))
    let connection = makeChatConnection(session: session, clock: clock)
    try await connection.connect()
    try await connection.resume(
      turnID: turnID,
      agentID: "agent-1",
      conversationID: conversationID,
      sinceSeq: 7
    )
    try await connection.resume(
      turnID: otherTurnID,
      agentID: "agent-2",
      conversationID: otherConversationID,
      sinceSeq: 9
    )

    await first.fail()
    await waitForRequestCount(2, in: session)
    await settleConcurrentWork()

    #expect(
      await second.sentFrames
        == [
          .resume(
            id: turnID,
            agentId: "agent-1",
            conversationId: conversationID,
            sinceSeq: 7
          ),
          .resume(
            id: otherTurnID,
            agentId: "agent-2",
            conversationId: otherConversationID,
            sinceSeq: 9
          ),
        ]
    )
    await connection.detach()
  }

  @Test("transient reconnect audits a sent turn that has not been accepted yet")
  func transientReconnectResumesPreAcceptedSend() async throws {
    let first = FakeWebSocketTask()
    let second = FakeWebSocketTask()
    let session = FakeWebSocketSession(tasks: [first, second])
    let clock = TestAppClock(now: Date(timeIntervalSince1970: 0))
    let connection = makeChatConnection(session: session, clock: clock)
    try await connection.connect()
    try await connection.sendTurn(
      id: turnID,
      agentID: "agent-1",
      conversationID: conversationID,
      text: "Maybe accepted",
      images: []
    )

    await first.fail()
    await waitForRequestCount(2, in: session)
    await settleConcurrentWork()

    #expect(
      await second.sentFrames
        == [
          .resume(
            id: turnID,
            agentId: "agent-1",
            conversationId: conversationID,
            sinceSeq: 0
          )
        ]
    )
    await connection.detach()
  }

  @Test("replayed pre-accepted turns enforce capable frame validation")
  func replayedPreAcceptedTurnIsCapable() async throws {
    let first = FakeWebSocketTask()
    let second = FakeWebSocketTask()
    let session = FakeWebSocketSession(tasks: [first, second])
    let clock = TestAppClock(now: Date(timeIntervalSince1970: 0))
    let connection = makeChatConnection(session: session, clock: clock)
    let terminal = Task { await terminalError(from: connection) }
    try await connection.connect()
    try await connection.sendTurn(
      id: turnID,
      agentID: "agent-1",
      conversationID: conversationID,
      text: "Maybe accepted",
      images: []
    )
    await second.holdNextSend()
    await first.fail()
    await second.waitForHeldSend()

    await second.enqueue(
      .string(
        String(
          data: try FixtureLoader.data("invalid/chat-event-missing-conversation-id.json"),
          encoding: .utf8
        )!))
    await settleConcurrentWork()
    await second.succeedHeldSend()
    await second.fail(peerClose: .init(code: 4001, reason: Data("Unauthorized".utf8)))

    #expect(await terminal.value == .updateRequired)
  }

  @Test("a stale replay-send failure cannot finish a suspended reusable stream")
  func staleReplaySendFailureCannotFinishSuspendedStream() async throws {
    let first = FakeWebSocketTask()
    let replaySocket = FakeWebSocketTask()
    let foregroundSocket = FakeWebSocketTask()
    let session = FakeWebSocketSession(tasks: [first, replaySocket, foregroundSocket])
    let clock = TestAppClock(now: Date(timeIntervalSince1970: 0))
    let connection = makeChatConnection(session: session, clock: clock)
    try await connection.connect()
    try await connection.resume(
      turnID: turnID,
      agentID: "agent-1",
      conversationID: conversationID,
      sinceSeq: 7
    )
    await replaySocket.holdNextSend()
    await first.fail()
    await replaySocket.waitForHeldSend()

    await connection.suspend()
    await replaySocket.succeedHeldSend()
    await settleConcurrentWork()

    let reconnectError = await chatGatewayError { try await connection.connect() }
    #expect(reconnectError == nil)
    #expect(await foregroundSocket.resumeCount == 1)
    await connection.detach()
  }

  @Test("a failed replay socket is closed before the next reconnect")
  func failedReplaySocketIsClosedBeforeReplacement() async throws {
    let first = FakeWebSocketTask()
    let replaySocket = FakeWebSocketTask()
    let replacement = FakeWebSocketTask()
    let session = FakeWebSocketSession(tasks: [first, replaySocket, replacement])
    let clock = TestAppClock(now: Date(timeIntervalSince1970: 0))
    let connection = makeChatConnection(session: session, clock: clock)
    try await connection.connect()
    try await connection.resume(
      turnID: turnID,
      agentID: "agent-1",
      conversationID: conversationID,
      sinceSeq: 7
    )
    await replaySocket.holdNextSend()
    await first.fail()
    await replaySocket.waitForHeldSend()

    await replaySocket.failHeldSend()
    await waitForRequestCount(3, in: session)
    await settleConcurrentWork()

    #expect(await replaySocket.closeCode == .goingAway)
    #expect(
      await replacement.sentFrames
        == [
          .resume(
            id: turnID,
            agentId: "agent-1",
            conversationId: conversationID,
            sinceSeq: 7
          )
        ]
    )
    await connection.detach()
  }

  @Test("transient reconnect forgets terminal turns but retains live subscriptions")
  func transientReconnectDropsTerminalTurns() async throws {
    let failedTurnID = "018f0f4a-5c42-7a8b-9c01-9234567890ab"
    let failedConversationID = "018f0f4a-5c42-7a8b-9c01-8234567890ab"
    let liveTurnID = "018f0f4a-5c42-7a8b-9c01-7234567890ab"
    let liveConversationID = "018f0f4a-5c42-7a8b-9c01-6234567890ab"
    let first = FakeWebSocketTask()
    let second = FakeWebSocketTask()
    let session = FakeWebSocketSession(tasks: [first, second])
    let clock = TestAppClock(now: Date(timeIntervalSince1970: 0))
    let connection = makeChatConnection(session: session, clock: clock)
    let terminalFrames = Task { try await collectFrames(from: connection, count: 2) }
    try await connection.connect()
    try await connection.resume(
      turnID: turnID,
      agentID: "agent-1",
      conversationID: conversationID,
      sinceSeq: 2
    )
    try await connection.resume(
      turnID: failedTurnID,
      agentID: "agent-2",
      conversationID: failedConversationID,
      sinceSeq: 4
    )
    try await connection.resume(
      turnID: liveTurnID,
      agentID: "agent-3",
      conversationID: liveConversationID,
      sinceSeq: 6
    )
    let done = MobileWSServerFrame.done(
      id: turnID,
      conversationId: conversationID,
      seq: 3,
      outcome: .completed
    )
    let failure = MobileWSServerFrame.error(
      id: failedTurnID,
      conversationId: failedConversationID,
      seq: 5,
      error: "Failed",
      code: "gateway_offline",
      retryable: true,
      activeTurnId: nil
    )
    await first.enqueue(.string(serverJSON(done)))
    await first.enqueue(.string(serverJSON(failure)))
    #expect(try await terminalFrames.value == [done, failure])

    await first.fail()
    await waitForRequestCount(2, in: session)
    await settleConcurrentWork()

    #expect(
      await second.sentFrames
        == [
          .resume(
            id: liveTurnID,
            agentId: "agent-3",
            conversationId: liveConversationID,
            sinceSeq: 6
          )
        ]
    )
    await connection.detach()
  }

  @Test("ordinary socket loss stops after the bounded reconnect limit")
  func reconnectLimit() async throws {
    let tasks = (0...5).map { _ in FakeWebSocketTask() }
    let session = FakeWebSocketSession(tasks: tasks)
    let clock = TestAppClock(now: Date(timeIntervalSince1970: 0))
    let connection = makeChatConnection(session: session, clock: clock)
    let terminal = Task { await terminalError(from: connection) }
    try await connection.connect()

    for (index, task) in tasks.enumerated() {
      await task.fail()
      if index < tasks.count - 1 {
        await waitForRequestCount(index + 2, in: session)
      }
    }

    guard case .transport? = await terminal.value else {
      Issue.record("Reconnect exhaustion did not terminate as transport loss")
      return
    }
    #expect(session.requests.count == 6)
    #expect(
      await clock.sleeps
        == [.seconds(1), .seconds(2), .seconds(4), .seconds(8), .seconds(16)]
    )
  }

  @Test("authentication probe accepts structured not found and always detaches")
  func authenticationProbe() async throws {
    let task = FakeWebSocketTask()
    let connection = makeChatConnection(task: task)
    let probe = Task { try await connection.probeAuthentication(selection: .v1) }

    let sent = await task.nextSentFrame()
    guard case .resume(let id, let agentID, let conversationID, let sinceSeq) = sent else {
      Issue.record("Probe did not send resume")
      return
    }
    #expect(agentID == "__dash_ios_pairing_probe__")
    #expect(sinceSeq == 0)
    #expect(UUID(uuidString: id) != nil)
    #expect(UUID(uuidString: conversationID) != nil)
    await task.enqueue(
      .string(
        serverJSON(
          .error(
            id: id,
            conversationId: nil,
            seq: nil,
            error: "Conversation not found",
            code: "not_found",
            retryable: false,
            activeTurnId: nil
          ))))

    try await probe.value
    #expect(await task.waitForClose() == .goingAway)
  }

  @Test("authentication probe cancels the socket it replaces")
  func authenticationProbeReplacesSocket() async throws {
    let existing = FakeWebSocketTask()
    let probeSocket = FakeWebSocketTask()
    let session = FakeWebSocketSession(tasks: [existing, probeSocket])
    let connection = makeChatConnection(session: session)
    try await connection.connect()

    let probe = Task { try await connection.probeAuthentication(selection: .v1) }
    _ = await probeSocket.nextSentFrame()
    #expect(await existing.closeCode == .goingAway)
    await probeSocket.enqueue(.string(serverJSON(try fixture("chat-accepted.json"))))

    try await probe.value
  }

  @Test("a stale authentication probe cannot detach a replacement socket")
  func staleAuthenticationProbeCannotDetachReplacement() async throws {
    let probeSocket = FakeWebSocketTask()
    let replacement = FakeWebSocketTask()
    let session = FakeWebSocketSession(tasks: [probeSocket, replacement])
    let connection = makeChatConnection(session: session)
    let probe = Task {
      await chatGatewayError { try await connection.probeAuthentication(selection: .v1) }
    }
    _ = await probeSocket.nextSentFrame()

    try await connection.connect()
    _ = await probe.value

    #expect(await replacement.closeCode == nil)
    try await connection.sendTurn(
      id: turnID,
      agentID: "agent-1",
      conversationID: conversationID,
      text: "Still connected",
      images: []
    )
    #expect(await replacement.sentFrames.count == 1)
    await connection.detach()
  }

  @Test("authentication probe accepts any successfully decoded server frame")
  func authenticationProbeAcceptsDecodedFrame() async throws {
    let task = FakeWebSocketTask()
    let connection = makeChatConnection(task: task)
    let probe = Task { try await connection.probeAuthentication(selection: .v1) }
    _ = await task.nextSentFrame()

    await task.enqueue(.string(serverJSON(try fixture("chat-accepted.json"))))

    try await probe.value
    #expect(await task.waitForClose() == .goingAway)
  }

  @Test("authentication probe accepts a decoded legacy frame without capable fields")
  func authenticationProbeAcceptsLegacyFrame() async throws {
    let task = FakeWebSocketTask()
    let connection = makeChatConnection(task: task)
    let probe = Task { try await connection.probeAuthentication(selection: .v1) }
    _ = await task.nextSentFrame()

    await task.enqueue(
      .string(
        serverJSON(
          .done(
            id: "018f0f4a-5c42-7a8b-9c01-999999999999",
            conversationId: nil,
            seq: nil,
            outcome: nil
          ))))

    try await probe.value
    #expect(await task.waitForClose() == .goingAway)
  }

  @Test(arguments: [4001, 4401])
  func authenticationProbeRejectsAuthClose(code: Int) async throws {
    let task = FakeWebSocketTask()
    let connection = makeChatConnection(task: task)
    let probe = Task {
      await chatGatewayError { try await connection.probeAuthentication(selection: .v1) }
    }
    _ = await task.nextSentFrame()

    await task.fail(peerClose: .init(code: code, reason: Data("Unauthorized".utf8)))

    #expect(await probe.value == .unauthorized)
    #expect(await task.waitForClose() == .goingAway)
  }

  @Test("authentication probe maps rate limit close reason")
  func authenticationProbeRateLimit() async throws {
    let task = FakeWebSocketTask()
    let connection = makeChatConnection(task: task)
    let probe = Task {
      await chatGatewayError { try await connection.probeAuthentication(selection: .v1) }
    }
    _ = await task.nextSentFrame()

    await task.fail(peerClose: .init(code: 4429, reason: Data("15".utf8)))

    #expect(await probe.value == .rateLimited(retryAfter: .seconds(15)))
    #expect(await task.waitForClose() == .goingAway)
  }

  @Test("authentication probe times out after five clocked seconds and detaches")
  func authenticationProbeTimeout() async throws {
    let task = FakeWebSocketTask()
    let clock = TestAppClock(now: Date(timeIntervalSince1970: 0))
    let connection = makeChatConnection(task: task, clock: clock)

    let error = await chatGatewayError {
      try await connection.probeAuthentication(selection: .v1)
    }

    #expect(error == .transport("Chat authentication probe timed out"))
    #expect(await clock.sleeps.contains(.seconds(5)))
    #expect(await task.waitForClose() == .goingAway)
  }

  @Test("v2 authentication probe reaches the socket with the required hello")
  func authenticationProbeV2Hello() async throws {
    let task = FakeWebSocketTask()
    let connection = makeChatConnection(task: task, selection: .v2Queue)
    let probe = Task { try await connection.probeAuthentication(selection: .v2Queue) }

    #expect(
      await task.nextSentV2Frame()
        == .hello(contractVersion: 2, capabilities: ["chat-input-queue-v1"])
    )
    await task.enqueue(
      .string(
        v2ServerJSON(
          .control(
            .helloAck(contractVersion: 2, capabilities: ["chat-input-queue-v1"])
          )
        )
      )
    )

    try await probe.value
    #expect(await task.resumeCount == 1)
    #expect(await task.waitForClose() == .goingAway)
  }

  @Test("v2 authentication probe rejects hello acknowledgement without queue capability")
  func authenticationProbeV2RequiresQueueCapability() async throws {
    let task = FakeWebSocketTask()
    let connection = makeChatConnection(task: task, selection: .v2Queue)
    let probe = Task {
      await chatGatewayError {
        try await connection.probeAuthentication(selection: .v2Queue)
      }
    }
    _ = await task.nextSentV2Frame()

    await task.enqueue(
      .string(
        v2ServerJSON(.control(.helloAck(contractVersion: 2, capabilities: ["other-v1"])))
      )
    )

    #expect(await probe.value == .updateRequired)
    #expect(await task.waitForClose() == .goingAway)
  }

  @Test("v2 authentication probe rejects a valid non-hello server frame")
  func authenticationProbeV2RequiresHelloAcknowledgement() async throws {
    let task = FakeWebSocketTask()
    let connection = makeChatConnection(task: task, selection: .v2Queue)
    let probe = Task {
      await chatGatewayError {
        try await connection.probeAuthentication(selection: .v2Queue)
      }
    }
    _ = await task.nextSentV2Frame()

    await task.enqueue(
      .string(
        v2ServerJSON(
          .control(
            .conversationSubscribed(
              id: turnID,
              conversationId: conversationID,
              v2ThroughSeq: 0
            )
          )
        )
      )
    )

    #expect(await probe.value == .updateRequired)
  }

  @Test("v2 authentication probe maps strict contract validation failures to update required")
  func authenticationProbeV2RejectsMalformedFrame() async throws {
    let task = FakeWebSocketTask()
    let connection = makeChatConnection(task: task, selection: .v2Queue)
    let probe = Task {
      await chatGatewayError {
        try await connection.probeAuthentication(selection: .v2Queue)
      }
    }
    _ = await task.nextSentV2Frame()

    await task.enqueue(
      .string(
        """
        {"type":"hello_ack","contractVersion":2,"capabilities":["chat-input-queue-v1"],"extra":true}
        """
      )
    )

    #expect(await probe.value == .updateRequired)
  }

  @Test("authentication probe selection mismatch fails closed before opening a socket")
  func authenticationProbeSelectionMismatch() async throws {
    let task = FakeWebSocketTask()
    let session = FakeWebSocketSession(tasks: [task])
    let connection = makeChatConnection(session: session, selection: .v2Queue)

    let error = await chatGatewayError {
      try await connection.probeAuthentication(selection: .v1)
    }

    #expect(error == .updateRequired)
    #expect(session.requests.isEmpty)
    #expect(await task.resumeCount == 0)
  }

  @Test("v2 authentication probe preserves unauthorized close mapping")
  func authenticationProbeV2RejectsAuthClose() async throws {
    let task = FakeWebSocketTask()
    let connection = makeChatConnection(task: task, selection: .v2Queue)
    let probe = Task {
      await chatGatewayError {
        try await connection.probeAuthentication(selection: .v2Queue)
      }
    }
    _ = await task.nextSentV2Frame()

    await task.fail(peerClose: .init(code: 4401, reason: Data("Unauthorized".utf8)))

    #expect(await probe.value == .unauthorized)
  }

  @Test("v2 handshakes, waits for the durable subscription watermark, and stays live after done")
  func v2SubscriptionReadinessAndTerminalFrame() async throws {
    let task = FakeWebSocketTask()
    let connection = makeChatConnection(task: task, selection: .v2Queue)
    let received = Task { try await collectV2Frames(from: connection, count: 3) }

    let connecting = Task { try await connection.connect() }
    await waitForV2FrameCount(1, on: task)
    #expect(
      await task.sentV2Frames.first
        == .hello(contractVersion: 2, capabilities: ["chat-input-queue-v1"])
    )
    await task.enqueue(.string(v2ServerJSON(.control(v2HelloAcknowledgement()))))
    try await connecting.value

    let subscribing = Task {
      try await connection.subscribeConversation(
        agentID: "agent-1",
        conversationID: conversationID,
        sinceV2Seq: 1
      )
    }
    await waitForV2FrameCount(2, on: task)
    let subscriptionID = try #require(await task.sentV2Frames.subscriptionID)
    try await subscribing.value
    await task.enqueue(
      .string(
        v2ServerJSON(
          .control(
            .conversationSubscribed(
              id: subscriptionID,
              conversationId: conversationID,
              v2ThroughSeq: 2
            )
          )
        )
      )
    )

    let firstSend = Task {
      try await connection.sendV2Turn(
        id: "turn-01",
        agentID: "agent-1",
        conversationID: conversationID,
        text: "after replay",
        images: []
      )
    }
    await settleConcurrentWork()
    #expect(await task.sentV2Frames.count == 2)

    await connection.acknowledgeAppliedV2Seq(2, conversationID: conversationID)
    try await firstSend.value
    await waitForV2FrameCount(3, on: task)
    await task.enqueue(
      .string(
        v2ServerJSON(
          .sequenced(
            .done(
              id: "turn-01",
              conversationId: conversationID,
              v2Seq: 3,
              runId: "turn-01",
              segmentTurnId: "00000000-0000-4000-8000-000000000031",
              outcome: .completed
            )
          )
        )
      )
    )
    await connection.acknowledgeAppliedV2Seq(3, conversationID: conversationID)

    let frames = try await received.value
    #expect(frames.map(\.v2TestTypeName) == ["hello_ack", "conversation_subscribed", "done"])
    #expect(await task.closeCode == nil)
    await connection.detach()
  }

  @Test("v2 command rejection before hello acknowledgement is terminal and unpublished")
  func v2CommandRejectionBeforeHelloIsTerminal() async throws {
    let task = FakeWebSocketTask()
    let connection = makeChatConnection(
      task: task,
      clock: ReconnectingTestAppClock(),
      selection: .v2Queue
    )
    let observation = Task { await firstV2Observation(from: connection) }
    let connecting = Task {
      await chatGatewayError { try await connection.connect() }
    }
    await waitForV2FrameCount(1, on: task)

    await task.enqueue(
      .string(
        v2ServerJSON(
          .control(
            .commandRejected(
              id: "00000000-0000-4000-8000-000000000048",
              conversationId: nil,
              code: "revision_conflict",
              error: "stale revision",
              retryable: false,
              details: nil
            )
          )
        )
      )
    )

    let firstObservation = await observation.value
    await connection.detach()
    #expect(firstObservation == .terminal(.updateRequired))
    #expect(await connecting.value == .updateRequired)
  }

  @Test("v2 registers commands before readiness and coalesces only an identical caller ID")
  func v2CommandRegistrationAndSameIDRules() async throws {
    let task = FakeWebSocketTask()
    let connection = makeChatConnection(task: task, selection: .v2Queue)
    try await connectV2(connection, task: task)
    let subscribing = Task {
      try await connection.subscribeConversation(
        agentID: "agent-1",
        conversationID: conversationID,
        sinceV2Seq: 0
      )
    }
    await waitForV2FrameCount(2, on: task)
    let subscriptionID = try #require(await task.sentV2Frames.subscriptionID)
    try await subscribing.value
    await task.enqueue(
      .string(
        v2ServerJSON(
          .control(
            .conversationSubscribed(
              id: subscriptionID,
              conversationId: conversationID,
              v2ThroughSeq: 1
            )
          )
        )
      )
    )

    let frame = MobileV2WsClientFrame.editFollowUp(
      id: "00000000-0000-4000-8000-000000000011",
      conversationId: conversationID,
      inputId: "00000000-0000-4000-8000-000000000021",
      expectedRevision: 3,
      text: "same",
      images: nil
    )
    let first = Task { try await connection.editFollowUp(frame) }
    let identical = Task { try await connection.editFollowUp(frame) }
    await settleConcurrentWork()
    #expect(await task.sentV2Frames.count == 2)

    let mismatch = await anyError {
      try await connection.editFollowUp(
        .editFollowUp(
          id: "00000000-0000-4000-8000-000000000011",
          conversationId: conversationID,
          inputId: "00000000-0000-4000-8000-000000000021",
          expectedRevision: 3,
          text: "different",
          images: nil
        )
      )
    }
    #expect(mismatch != nil)
    #expect(await task.sentV2Frames.count == 2)

    await connection.acknowledgeAppliedV2Seq(1, conversationID: conversationID)
    try await first.value
    try await identical.value
    #expect(await task.sentV2Frames.filter { $0 == frame }.count == 1)
    await connection.detach()
  }

  @Test("v2 settled command IDs accept only an identical no-op retry")
  func v2SettledCommandSameIDRules() async throws {
    let task = FakeWebSocketTask()
    let connection = makeChatConnection(task: task, selection: .v2Queue)
    let recorder = V2FrameRecorder()
    let recording = Task { await recordV2Frames(from: connection, in: recorder) }
    try await connectV2(connection, task: task)
    _ = try await subscribeV2(
      connection,
      task: task,
      conversationID: conversationID,
      cursor: 0
    )
    await waitForV2ServerFrameCount(2, in: recorder)

    let frame = MobileV2WsClientFrame.editFollowUp(
      id: "00000000-0000-4000-8000-000000000044",
      conversationId: conversationID,
      inputId: "00000000-0000-4000-8000-000000000054",
      expectedRevision: 3,
      text: "settled payload",
      images: [MessageImage(mediaType: .png, data: "aGVsbG8=")]
    )
    try await connection.editFollowUp(frame)
    await task.enqueue(
      .string(
        v2ServerJSON(
          .sequenced(
            .inputUpdated(
              id: "00000000-0000-4000-8000-000000000044",
              conversationId: conversationID,
              v2Seq: 1,
              queueRevision: 4,
              input: v2PendingInput(
                inputID: "00000000-0000-4000-8000-000000000054",
                revision: 4,
                text: "settled payload"
              )
            )
          )
        )
      )
    )
    await waitForV2ServerFrameCount(3, in: recorder)
    await connection.acknowledgeAppliedV2Seq(1, conversationID: conversationID)
    let sentCount = await task.sentV2Frames.count

    let mismatch = await chatGatewayError {
      try await connection.editFollowUp(
        .editFollowUp(
          id: "00000000-0000-4000-8000-000000000044",
          conversationId: conversationID,
          inputId: "00000000-0000-4000-8000-000000000054",
          expectedRevision: 3,
          text: "different payload",
          images: [MessageImage(mediaType: .png, data: "aGVsbG8=")]
        )
      )
    }
    let identical = await chatGatewayError {
      try await connection.editFollowUp(frame)
    }

    #expect(
      mismatch
        == .validation("v2 command id is already registered with another payload")
    )
    #expect(identical == nil)
    #expect(await task.sentV2Frames.count == sentCount)
    await connection.detach()
    await recording.value
  }

  @Test("v2 hello acknowledgement has an exact five-second terminal deadline")
  func v2HelloAcknowledgementTimeout() async {
    let clock = TestAppClock(now: Date(timeIntervalSince1970: 0))
    let task = FakeWebSocketTask()
    let session = FakeWebSocketSession(tasks: [task])
    let connection = makeChatConnection(
      session: session,
      clock: clock,
      selection: .v2Queue
    )
    let terminal = Task { await terminalError(from: connection) }

    let error = await chatGatewayError { try await connection.connect() }

    #expect(error == .updateRequired)
    #expect(await terminal.value == .updateRequired)
    #expect(await clock.sleeps == [.seconds(5)])
    #expect(session.requests.count == 1)
    #expect(await task.waitForClose() == .goingAway)
  }

  @Test("v2 reconnect uses a fresh subscription UUID and the stable durable cursor")
  func v2ReconnectSubscriptionIdentityAndCursor() async throws {
    let clock = ReconnectingTestAppClock()
    let first = FakeWebSocketTask()
    let second = FakeWebSocketTask()
    let session = FakeWebSocketSession(tasks: [first, second])
    let connection = makeChatConnection(
      session: session,
      clock: clock,
      selection: .v2Queue
    )
    try await connectV2(connection, task: first)
    let firstID = try await subscribeV2(
      connection,
      task: first,
      conversationID: conversationID,
      cursor: 3
    )
    try await connection.waitUntilConversationReady(conversationID: conversationID)

    await first.fail()
    await waitForRequestCount(2, in: session)
    await waitForV2FrameCount(1, on: second)
    await second.enqueue(.string(v2ServerJSON(.control(v2HelloAcknowledgement()))))
    await waitForV2FrameCount(2, on: second)
    let secondFrames = await second.sentV2Frames
    let secondID = try #require(secondFrames.subscriptionID)
    #expect(secondID != firstID)
    guard
      case let .subscribeConversation(_, agentID, receivedConversationID, cursor) =
        secondFrames[1]
    else {
      Issue.record("Reconnect did not send subscribe_conversation after hello")
      return
    }
    #expect(agentID == "agent-1")
    #expect(receivedConversationID == conversationID)
    #expect(cursor == 3)

    let ready = Task {
      try await connection.waitUntilConversationReady(conversationID: conversationID)
    }
    await second.enqueue(
      .string(
        v2ServerJSON(
          .control(
            .conversationSubscribed(
              id: secondID,
              conversationId: conversationID,
              v2ThroughSeq: 3
            )
          )
        )
      )
    )
    try await ready.value
    #expect((await clock.sleeps).contains(.seconds(1)))
    await connection.detach()
  }

  @Test("v2 sequenced correlation settles only after durable publication acknowledgement")
  func v2DurableCorrelationAcknowledgement() async throws {
    let clock = ReconnectingTestAppClock()
    let first = FakeWebSocketTask()
    let second = FakeWebSocketTask()
    let third = FakeWebSocketTask()
    let session = FakeWebSocketSession(tasks: [first, second, third])
    let connection = makeChatConnection(
      session: session,
      clock: clock,
      selection: .v2Queue
    )
    let received = Task { try await collectV2Frames(from: connection, count: 3) }
    try await connectV2(connection, task: first)
    _ = try await subscribeV2(
      connection,
      task: first,
      conversationID: conversationID,
      cursor: 0
    )

    let command = MobileV2WsClientFrame.editFollowUp(
      id: "00000000-0000-4000-8000-000000000011",
      conversationId: conversationID,
      inputId: "00000000-0000-4000-8000-000000000021",
      expectedRevision: 3,
      text: "durable",
      images: nil
    )
    try await connection.editFollowUp(command)
    await first.enqueue(
      .string(
        v2ServerJSON(
          .sequenced(
            .inputUpdated(
              id: "00000000-0000-4000-8000-000000000011",
              conversationId: conversationID,
              v2Seq: 1,
              queueRevision: 4,
              input: v2PendingInput(revision: 4, text: "durable")
            )
          )
        )
      )
    )
    _ = try await received.value

    await first.fail()
    await waitForRequestCount(2, in: session)
    await waitForV2FrameCount(1, on: second)
    await second.enqueue(.string(v2ServerJSON(.control(v2HelloAcknowledgement()))))
    await waitForV2FrameCount(2, on: second)
    let secondID = try #require(await second.sentV2Frames.subscriptionID)
    await second.enqueue(
      .string(
        v2ServerJSON(
          .control(
            .conversationSubscribed(
              id: secondID,
              conversationId: conversationID,
              v2ThroughSeq: 0
            )
          )
        )
      )
    )
    await waitForV2FrameCount(3, on: second)
    #expect(await second.sentV2Frames.last == command)

    await connection.acknowledgeAppliedV2Seq(1, conversationID: conversationID)
    await second.fail()
    await waitForRequestCount(3, in: session)
    await waitForV2FrameCount(1, on: third)
    await third.enqueue(.string(v2ServerJSON(.control(v2HelloAcknowledgement()))))
    await waitForV2FrameCount(2, on: third)
    let thirdFrames = await third.sentV2Frames
    let thirdID = try #require(thirdFrames.subscriptionID)
    guard case let .subscribeConversation(_, _, _, cursor) = thirdFrames[1] else {
      Issue.record("Second reconnect did not subscribe")
      return
    }
    #expect(cursor == 1)
    await third.enqueue(
      .string(
        v2ServerJSON(
          .control(
            .conversationSubscribed(
              id: thirdID,
              conversationId: conversationID,
              v2ThroughSeq: 1
            )
          )
        )
      )
    )
    await settleConcurrentWork()
    #expect(await third.sentV2Frames.count == 2)
    await connection.detach()
  }

  @Test("v2 command rejection settles only after the exact typed envelope is published")
  func v2CommandRejectionAcknowledgement() async throws {
    let clock = ReconnectingTestAppClock()
    let first = FakeWebSocketTask()
    let second = FakeWebSocketTask()
    let third = FakeWebSocketTask()
    let session = FakeWebSocketSession(tasks: [first, second, third])
    let connection = makeChatConnection(
      session: session,
      clock: clock,
      selection: .v2Queue
    )
    let recorder = V2FrameRecorder()
    let recording = Task { await recordV2Frames(from: connection, in: recorder) }
    try await connectV2(connection, task: first)
    _ = try await subscribeV2(
      connection,
      task: first,
      conversationID: conversationID,
      cursor: 0
    )

    let command = MobileV2WsClientFrame.removeFollowUp(
      id: "00000000-0000-4000-8000-000000000012",
      conversationId: conversationID,
      inputId: "00000000-0000-4000-8000-000000000022",
      expectedRevision: 2
    )
    try await connection.removeFollowUp(command)
    let rejection = MobileV2ControlFrame.commandRejected(
      id: "00000000-0000-4000-8000-000000000012",
      conversationId: conversationID,
      code: "revision_conflict",
      error: "stale revision",
      retryable: false,
      details: .object(["actualRevision": .number(3)])
    )
    await first.enqueue(.string(v2ServerJSON(.control(rejection))))
    await waitForV2ServerFrameCount(3, in: recorder)

    await connection.acknowledgeV2CommandRejected(
      .commandRejected(
        id: "00000000-0000-4000-8000-000000000012",
        conversationId: conversationID,
        code: "revision_conflict",
        error: "different envelope",
        retryable: false,
        details: .object(["actualRevision": .number(3)])
      )
    )
    await first.fail()
    await waitForRequestCount(2, in: session)
    await waitForV2FrameCount(1, on: second)
    await second.enqueue(.string(v2ServerJSON(.control(v2HelloAcknowledgement()))))
    await waitForV2FrameCount(2, on: second)
    let secondID = try #require(await second.sentV2Frames.subscriptionID)
    await second.enqueue(
      .string(
        v2ServerJSON(
          .control(
            .conversationSubscribed(
              id: secondID,
              conversationId: conversationID,
              v2ThroughSeq: 0
            )
          )
        )
      )
    )
    await waitForV2FrameCount(3, on: second)
    #expect(await second.sentV2Frames.last == command)

    await connection.acknowledgeV2CommandRejected(rejection)
    await second.fail()
    await waitForRequestCount(3, in: session)
    await waitForV2FrameCount(1, on: third)
    await third.enqueue(.string(v2ServerJSON(.control(v2HelloAcknowledgement()))))
    await waitForV2FrameCount(2, on: third)
    let thirdID = try #require(await third.sentV2Frames.subscriptionID)
    await third.enqueue(
      .string(
        v2ServerJSON(
          .control(
            .conversationSubscribed(
              id: thirdID,
              conversationId: conversationID,
              v2ThroughSeq: 0
            )
          )
        )
      )
    )
    await settleConcurrentWork()
    #expect(await third.sentV2Frames.count == 2)
    await connection.detach()
    await recording.value
  }

  @Test("v2 sticky cancel settles only on its durably published run terminal")
  func v2StickyCancelTerminalCorrelation() async throws {
    let clock = ReconnectingTestAppClock()
    let first = FakeWebSocketTask()
    let second = FakeWebSocketTask()
    let third = FakeWebSocketTask()
    let session = FakeWebSocketSession(tasks: [first, second, third])
    let connection = makeChatConnection(
      session: session,
      clock: clock,
      selection: .v2Queue
    )
    let recorder = V2FrameRecorder()
    let recording = Task { await recordV2Frames(from: connection, in: recorder) }
    try await connectV2(connection, task: first)
    _ = try await subscribeV2(
      connection,
      task: first,
      conversationID: conversationID,
      cursor: 0
    )

    try await connection.cancel(turnID: "run-target")
    await first.enqueue(
      .string(
        v2ServerJSON(
          .sequenced(
            .done(
              id: "run-other",
              conversationId: conversationID,
              v2Seq: 1,
              runId: "run-other",
              segmentTurnId: "00000000-0000-4000-8000-000000000031",
              outcome: .completed
            )
          )
        )
      )
    )
    await waitForV2ServerFrameCount(3, in: recorder)
    await connection.acknowledgeAppliedV2Seq(1, conversationID: conversationID)

    await first.fail()
    await waitForRequestCount(2, in: session)
    await waitForV2FrameCount(1, on: second)
    await second.enqueue(.string(v2ServerJSON(.control(v2HelloAcknowledgement()))))
    await waitForV2FrameCount(2, on: second)
    let secondID = try #require(await second.sentV2Frames.subscriptionID)
    await second.enqueue(
      .string(
        v2ServerJSON(
          .control(
            .conversationSubscribed(
              id: secondID,
              conversationId: conversationID,
              v2ThroughSeq: 1
            )
          )
        )
      )
    )
    await waitForV2FrameCount(3, on: second)
    #expect(await second.sentV2Frames.last == .cancel(id: "run-target"))

    await second.enqueue(
      .string(
        v2ServerJSON(
          .sequenced(
            .done(
              id: "run-target",
              conversationId: conversationID,
              v2Seq: 2,
              runId: "run-target",
              segmentTurnId: "00000000-0000-4000-8000-000000000032",
              outcome: .cancelled
            )
          )
        )
      )
    )
    await waitForV2ServerFrameCount(6, in: recorder)
    await connection.acknowledgeAppliedV2Seq(2, conversationID: conversationID)

    await second.fail()
    await waitForRequestCount(3, in: session)
    await waitForV2FrameCount(1, on: third)
    await third.enqueue(.string(v2ServerJSON(.control(v2HelloAcknowledgement()))))
    await waitForV2FrameCount(2, on: third)
    let thirdID = try #require(await third.sentV2Frames.subscriptionID)
    await third.enqueue(
      .string(
        v2ServerJSON(
          .control(
            .conversationSubscribed(
              id: thirdID,
              conversationId: conversationID,
              v2ThroughSeq: 2
            )
          )
        )
      )
    )
    await settleConcurrentWork()
    #expect(await third.sentV2Frames.count == 2)
    await connection.detach()
    await recording.value
  }

  @Test("v2 covered correlation preserves a current-generation retry waiter")
  func v2CoveredCorrelationPreservesRetryWaiter() async throws {
    let first = FakeWebSocketTask()
    let second = FakeWebSocketTask()
    let session = FakeWebSocketSession(tasks: [first, second])
    let connection = makeChatConnection(
      session: session,
      clock: ReconnectingTestAppClock(),
      selection: .v2Queue
    )
    let recorder = V2FrameRecorder()
    let recording = Task { await recordV2Frames(from: connection, in: recorder) }
    try await connectV2(connection, task: first)
    _ = try await subscribeV2(
      connection,
      task: first,
      conversationID: conversationID,
      cursor: 1
    )
    await waitForV2ServerFrameCount(2, in: recorder)

    let command = MobileV2WsClientFrame.editFollowUp(
      id: "00000000-0000-4000-8000-000000000041",
      conversationId: conversationID,
      inputId: "00000000-0000-4000-8000-000000000051",
      expectedRevision: 3,
      text: "exact retry payload",
      images: nil
    )
    try await connection.editFollowUp(command)
    await connection.suspend()

    let completion = ChatConnectionCompletionProbe()
    let retrying = Task {
      let error = await anyError { try await connection.editFollowUp(command) }
      if error == nil { await completion.markComplete() }
      return error
    }
    await settleConcurrentWork()
    #expect(await completion.isComplete == false)

    let connecting = Task { try await connection.connect() }
    await waitForV2FrameCount(1, on: second)
    await second.enqueue(.string(v2ServerJSON(.control(v2HelloAcknowledgement()))))
    try await connecting.value
    await waitForV2FrameCount(2, on: second)
    let subscriptionID = try #require(await second.sentV2Frames.subscriptionID)

    await second.enqueue(
      .string(
        v2ServerJSON(
          .sequenced(
            .inputUpdated(
              id: "00000000-0000-4000-8000-000000000041",
              conversationId: conversationID,
              v2Seq: 1,
              queueRevision: 4,
              input: v2PendingInput(
                inputID: "00000000-0000-4000-8000-000000000051",
                revision: 4,
                text: "exact retry payload"
              )
            )
          )
        )
      )
    )
    await waitForV2ServerFrameCount(4, in: recorder)
    await second.enqueue(
      .string(
        v2ServerJSON(
          .control(
            .conversationSubscribed(
              id: subscriptionID,
              conversationId: conversationID,
              v2ThroughSeq: 1
            )
          )
        )
      )
    )

    let completed = await waitForCompletion(completion)
    #expect(completed)
    #expect(await second.sentV2Frames.last == command)
    if completed {
      #expect(await retrying.value == nil)
    }
    await connection.detach()
    await recording.value
  }

  @Test("v2 published rejection preserves a current-generation retry waiter")
  func v2PublishedRejectionPreservesRetryWaiter() async throws {
    let first = FakeWebSocketTask()
    let second = FakeWebSocketTask()
    let session = FakeWebSocketSession(tasks: [first, second])
    let connection = makeChatConnection(
      session: session,
      clock: ReconnectingTestAppClock(),
      selection: .v2Queue
    )
    let recorder = V2FrameRecorder()
    let recording = Task { await recordV2Frames(from: connection, in: recorder) }
    try await connectV2(connection, task: first)
    _ = try await subscribeV2(
      connection,
      task: first,
      conversationID: conversationID,
      cursor: 0
    )
    await waitForV2ServerFrameCount(2, in: recorder)

    let command = MobileV2WsClientFrame.removeFollowUp(
      id: "00000000-0000-4000-8000-000000000042",
      conversationId: conversationID,
      inputId: "00000000-0000-4000-8000-000000000052",
      expectedRevision: 3
    )
    try await connection.removeFollowUp(command)
    await connection.suspend()

    let completion = ChatConnectionCompletionProbe()
    let retrying = Task {
      let error = await anyError { try await connection.removeFollowUp(command) }
      if error == nil { await completion.markComplete() }
      return error
    }
    await settleConcurrentWork()

    let connecting = Task { try await connection.connect() }
    await waitForV2FrameCount(1, on: second)
    await second.enqueue(.string(v2ServerJSON(.control(v2HelloAcknowledgement()))))
    try await connecting.value
    await waitForV2FrameCount(2, on: second)
    let subscriptionID = try #require(await second.sentV2Frames.subscriptionID)
    let rejection = MobileV2ControlFrame.commandRejected(
      id: "00000000-0000-4000-8000-000000000042",
      conversationId: conversationID,
      code: "revision_conflict",
      error: "stale revision",
      retryable: false,
      details: .object(["actualRevision": .number(4)])
    )
    await second.enqueue(.string(v2ServerJSON(.control(rejection))))
    await waitForV2ServerFrameCount(4, in: recorder)
    await connection.acknowledgeV2CommandRejected(rejection)
    await second.enqueue(
      .string(
        v2ServerJSON(
          .control(
            .conversationSubscribed(
              id: subscriptionID,
              conversationId: conversationID,
              v2ThroughSeq: 0
            )
          )
        )
      )
    )

    let completed = await waitForCompletion(completion)
    #expect(completed)
    #expect(await second.sentV2Frames.last == command)
    if completed {
      #expect(await retrying.value == nil)
    }
    await connection.detach()
    await recording.value
  }

  @Test("v2 covered terminal preserves a current-generation sticky-cancel waiter")
  func v2CoveredTerminalPreservesCancelRetryWaiter() async throws {
    let first = FakeWebSocketTask()
    let second = FakeWebSocketTask()
    let session = FakeWebSocketSession(tasks: [first, second])
    let connection = makeChatConnection(
      session: session,
      clock: ReconnectingTestAppClock(),
      selection: .v2Queue
    )
    let recorder = V2FrameRecorder()
    let recording = Task { await recordV2Frames(from: connection, in: recorder) }
    try await connectV2(connection, task: first)
    _ = try await subscribeV2(
      connection,
      task: first,
      conversationID: conversationID,
      cursor: 1
    )
    await waitForV2ServerFrameCount(2, in: recorder)

    try await connection.cancel(turnID: "run-covered")
    await connection.suspend()
    let completion = ChatConnectionCompletionProbe()
    let retrying = Task {
      let error = await anyError { try await connection.cancel(turnID: "run-covered") }
      if error == nil { await completion.markComplete() }
      return error
    }
    await settleConcurrentWork()

    let connecting = Task { try await connection.connect() }
    await waitForV2FrameCount(1, on: second)
    await second.enqueue(.string(v2ServerJSON(.control(v2HelloAcknowledgement()))))
    try await connecting.value
    await waitForV2FrameCount(2, on: second)
    let subscriptionID = try #require(await second.sentV2Frames.subscriptionID)
    await second.enqueue(
      .string(
        v2ServerJSON(
          .sequenced(
            .done(
              id: "run-covered",
              conversationId: conversationID,
              v2Seq: 1,
              runId: "run-covered",
              segmentTurnId: "00000000-0000-4000-8000-000000000061",
              outcome: .cancelled
            )
          )
        )
      )
    )
    await waitForV2ServerFrameCount(4, in: recorder)
    await second.enqueue(
      .string(
        v2ServerJSON(
          .control(
            .conversationSubscribed(
              id: subscriptionID,
              conversationId: conversationID,
              v2ThroughSeq: 1
            )
          )
        )
      )
    )

    let completed = await waitForCompletion(completion)
    #expect(completed)
    #expect(await second.sentV2Frames.last == .cancel(id: "run-covered"))
    if completed {
      #expect(await retrying.value == nil)
    }
    await connection.detach()
    await recording.value
  }

  @Test("v2 steer correlation requires the expected target run")
  func v2SteerCorrelationRequiresTargetRun() async throws {
    let first = FakeWebSocketTask()
    let second = FakeWebSocketTask()
    let session = FakeWebSocketSession(tasks: [first, second])
    let connection = makeChatConnection(
      session: session,
      clock: ReconnectingTestAppClock(),
      selection: .v2Queue
    )
    let recorder = V2FrameRecorder()
    let recording = Task { await recordV2Frames(from: connection, in: recorder) }
    try await connectV2(connection, task: first)
    _ = try await subscribeV2(
      connection,
      task: first,
      conversationID: conversationID,
      cursor: 0
    )
    await waitForV2ServerFrameCount(2, in: recorder)

    let command = MobileV2WsClientFrame.enqueueInput(
      id: "00000000-0000-4000-8000-000000000043",
      inputId: "00000000-0000-4000-8000-000000000053",
      agentId: "agent-1",
      channelId: "ios",
      conversationId: conversationID,
      text: "steer exactly here",
      images: [MessageImage(mediaType: .png, data: "aGVsbG8=")],
      behavior: .steer,
      expectedActiveTurnId: "run-target"
    )
    try await connection.enqueueInput(command)
    await first.enqueue(
      .string(
        v2ServerJSON(
          .sequenced(
            .inputAccepted(
              id: "00000000-0000-4000-8000-000000000043",
              conversationId: conversationID,
              v2Seq: 1,
              queueRevision: 1,
              input: v2PendingInput(
                inputID: "00000000-0000-4000-8000-000000000053",
                kind: .steer,
                targetTurnID: "run-other",
                revision: 1,
                text: "steer exactly here"
              )
            )
          )
        )
      )
    )
    await waitForV2ServerFrameCount(3, in: recorder)
    await connection.acknowledgeAppliedV2Seq(1, conversationID: conversationID)
    await connection.suspend()

    let connecting = Task { try await connection.connect() }
    await waitForV2FrameCount(1, on: second)
    await second.enqueue(.string(v2ServerJSON(.control(v2HelloAcknowledgement()))))
    try await connecting.value
    await waitForV2FrameCount(2, on: second)
    let subscriptionID = try #require(await second.sentV2Frames.subscriptionID)
    await second.enqueue(
      .string(
        v2ServerJSON(
          .control(
            .conversationSubscribed(
              id: subscriptionID,
              conversationId: conversationID,
              v2ThroughSeq: 1
            )
          )
        )
      )
    )

    #expect(await waitForV2FrameCountEventually(3, on: second))
    #expect(await second.sentV2Frames.count == 3)
    #expect(await second.sentV2Frames.last == command)
    await connection.detach()
    await recording.value
  }

  @Test("v2 follow-up correlation ignores a diagnostic target run")
  func v2FollowUpCorrelationIgnoresTargetRun() async throws {
    let first = FakeWebSocketTask()
    let second = FakeWebSocketTask()
    let session = FakeWebSocketSession(tasks: [first, second])
    let connection = makeChatConnection(
      session: session,
      clock: ReconnectingTestAppClock(),
      selection: .v2Queue
    )
    let recorder = V2FrameRecorder()
    let recording = Task { await recordV2Frames(from: connection, in: recorder) }
    try await connectV2(connection, task: first)
    _ = try await subscribeV2(
      connection,
      task: first,
      conversationID: conversationID,
      cursor: 0
    )
    await waitForV2ServerFrameCount(2, in: recorder)

    let command = MobileV2WsClientFrame.enqueueInput(
      id: "00000000-0000-4000-8000-000000000049",
      inputId: "00000000-0000-4000-8000-000000000059",
      agentId: "agent-1",
      channelId: "ios",
      conversationId: conversationID,
      text: "follow up later",
      images: nil,
      behavior: .followUp,
      expectedActiveTurnId: nil
    )
    try await connection.enqueueInput(command)
    await first.enqueue(
      .string(
        v2ServerJSON(
          .sequenced(
            .inputAccepted(
              id: "00000000-0000-4000-8000-000000000049",
              conversationId: conversationID,
              v2Seq: 1,
              queueRevision: 1,
              input: v2PendingInput(
                inputID: "00000000-0000-4000-8000-000000000059",
                kind: .followUp,
                targetTurnID: "run-diagnostic",
                revision: 1,
                text: "follow up later"
              )
            )
          )
        )
      )
    )
    await waitForV2ServerFrameCount(3, in: recorder)
    await connection.acknowledgeAppliedV2Seq(1, conversationID: conversationID)
    await connection.suspend()

    let connecting = Task { try await connection.connect() }
    await waitForV2FrameCount(1, on: second)
    await second.enqueue(.string(v2ServerJSON(.control(v2HelloAcknowledgement()))))
    try await connecting.value
    await waitForV2FrameCount(2, on: second)
    let subscriptionID = try #require(await second.sentV2Frames.subscriptionID)
    await second.enqueue(
      .string(
        v2ServerJSON(
          .control(
            .conversationSubscribed(
              id: subscriptionID,
              conversationId: conversationID,
              v2ThroughSeq: 1
            )
          )
        )
      )
    )
    await waitForV2ServerFrameCount(5, in: recorder)
    await settleConcurrentWork()

    #expect(await second.sentV2Frames.count == 2)
    #expect(await second.sentV2Frames.contains(command) == false)
    await connection.detach()
    await recording.value
  }

  @Test("v2 readiness flushes sticky cancels answers and user commands deterministically")
  func v2DeterministicFlushOrder() async throws {
    let task = FakeWebSocketTask()
    let connection = makeChatConnection(task: task, selection: .v2Queue)
    let recorder = V2FrameRecorder()
    let recording = Task { await recordV2Frames(from: connection, in: recorder) }
    try await connectV2(connection, task: task)
    let subscribing = Task {
      try await connection.subscribeConversation(
        agentID: "agent-1",
        conversationID: conversationID,
        sinceV2Seq: 0
      )
    }
    await waitForV2FrameCount(2, on: task)
    let subscriptionID = try #require(await task.sentV2Frames.subscriptionID)
    try await subscribing.value
    await task.enqueue(
      .string(
        v2ServerJSON(
          .control(
            .conversationSubscribed(
              id: subscriptionID,
              conversationId: conversationID,
              v2ThroughSeq: 1
            )
          )
        )
      )
    )
    await waitForV2ServerFrameCount(2, in: recorder)

    let cancel = Task { try await connection.cancel(turnID: "run-active") }
    await settleConcurrentWork()
    let answer = Task {
      try await connection.answer(
        turnID: "run-active",
        questionID: "question-1",
        answer: "yes"
      )
    }
    await settleConcurrentWork()
    let editFrame = MobileV2WsClientFrame.editFollowUp(
      id: "00000000-0000-4000-8000-000000000013",
      conversationId: conversationID,
      inputId: "00000000-0000-4000-8000-000000000023",
      expectedRevision: 1,
      text: "edit",
      images: nil
    )
    let edit = Task { try await connection.editFollowUp(editFrame) }
    await settleConcurrentWork()
    let removeFrame = MobileV2WsClientFrame.removeFollowUp(
      id: "00000000-0000-4000-8000-000000000014",
      conversationId: conversationID,
      inputId: "00000000-0000-4000-8000-000000000024",
      expectedRevision: 2
    )
    let remove = Task { try await connection.removeFollowUp(removeFrame) }
    await settleConcurrentWork()
    #expect(await task.sentV2Frames.count == 2)

    await connection.acknowledgeAppliedV2Seq(1, conversationID: conversationID)
    await waitForV2FrameCount(6, on: task)
    try await cancel.value
    try await answer.value
    try await edit.value
    try await remove.value
    let frames = await task.sentV2Frames
    #expect(
      frames.dropFirst(2).map(\.v2TestTypeName)
        == ["cancel", "answer", "edit_follow_up", "remove_follow_up"]
    )
    await connection.detach()
    await recording.value
  }

  @Test("v2 flush schedules a command registered during another command write")
  func v2FlushDoesNotLoseCommandWakeup() async throws {
    let task = FakeWebSocketTask()
    let connection = makeChatConnection(task: task, selection: .v2Queue)
    try await connectV2(connection, task: task)
    _ = try await subscribeV2(
      connection,
      task: task,
      conversationID: conversationID,
      cursor: 0
    )
    let firstFrame = MobileV2WsClientFrame.removeFollowUp(
      id: "00000000-0000-4000-8000-000000000031",
      conversationId: conversationID,
      inputId: "00000000-0000-4000-8000-000000000041",
      expectedRevision: 1
    )
    let secondFrame = MobileV2WsClientFrame.removeFollowUp(
      id: "00000000-0000-4000-8000-000000000032",
      conversationId: conversationID,
      inputId: "00000000-0000-4000-8000-000000000042",
      expectedRevision: 1
    )
    let firstCompletion = ChatConnectionCompletionProbe()
    let secondCompletion = ChatConnectionCompletionProbe()

    await task.holdNextSend()
    let firstSend = Task {
      let error = await anyError { try await connection.removeFollowUp(firstFrame) }
      if error == nil { await firstCompletion.markComplete() }
      return error
    }
    await task.waitForHeldSend()
    let secondSend = Task {
      let error = await anyError { try await connection.removeFollowUp(secondFrame) }
      if error == nil { await secondCompletion.markComplete() }
      return error
    }
    await settleConcurrentWork()

    await task.succeedHeldSend()
    await settleConcurrentWork()

    #expect(await firstCompletion.isComplete)
    #expect(await secondCompletion.isComplete)
    #expect(await task.sentV2Frames.filter { $0 == firstFrame }.count == 1)
    #expect(await task.sentV2Frames.filter { $0 == secondFrame }.count == 1)

    await connection.detach()
    _ = await firstSend.value
    _ = await secondSend.value
  }

  @Test("v2 flush schedules a sticky cancel registered during another cancel write")
  func v2FlushDoesNotLoseCancelWakeup() async throws {
    let task = FakeWebSocketTask()
    let connection = makeChatConnection(task: task, selection: .v2Queue)
    try await connectV2(connection, task: task)
    _ = try await subscribeV2(
      connection,
      task: task,
      conversationID: conversationID,
      cursor: 0
    )
    let firstCompletion = ChatConnectionCompletionProbe()
    let secondCompletion = ChatConnectionCompletionProbe()

    await task.holdNextSend()
    let firstCancel = Task {
      let error = await anyError { try await connection.cancel(turnID: "run-first") }
      if error == nil { await firstCompletion.markComplete() }
      return error
    }
    await task.waitForHeldSend()
    let secondCancel = Task {
      let error = await anyError { try await connection.cancel(turnID: "run-second") }
      if error == nil { await secondCompletion.markComplete() }
      return error
    }
    await settleConcurrentWork()

    await task.succeedHeldSend()
    await settleConcurrentWork()

    #expect(await firstCompletion.isComplete)
    #expect(await secondCompletion.isComplete)
    #expect(await task.sentV2Frames.filter { $0 == .cancel(id: "run-first") }.count == 1)
    #expect(await task.sentV2Frames.filter { $0 == .cancel(id: "run-second") }.count == 1)

    await connection.detach()
    _ = await firstCancel.value
    _ = await secondCancel.value
  }

  @Test("v2 flush replaces an in-flight subscription when its durable cursor advances")
  func v2FlushDoesNotLoseSubscriptionReplacement() async throws {
    let task = FakeWebSocketTask()
    let connection = makeChatConnection(task: task, selection: .v2Queue)
    try await connectV2(connection, task: task)
    let firstCompletion = ChatConnectionCompletionProbe()
    let replacementCompletion = ChatConnectionCompletionProbe()

    await task.holdNextSend()
    let firstSubscription = Task {
      let error = await anyError {
        try await connection.subscribeConversation(
          agentID: "agent-1",
          conversationID: conversationID,
          sinceV2Seq: 0
        )
      }
      if error == nil { await firstCompletion.markComplete() }
      return error
    }
    await task.waitForHeldSend()
    let replacementSubscription = Task {
      let error = await anyError {
        try await connection.subscribeConversation(
          agentID: "agent-1",
          conversationID: conversationID,
          sinceV2Seq: 1
        )
      }
      if error == nil { await replacementCompletion.markComplete() }
      return error
    }
    await settleConcurrentWork()

    await task.succeedHeldSend()
    await settleConcurrentWork()

    let subscriptions = await task.sentV2Frames.compactMap { frame -> (String, Int)? in
      guard case let .subscribeConversation(id, _, _, cursor) = frame else { return nil }
      return (id, cursor)
    }
    #expect(await firstCompletion.isComplete)
    #expect(await replacementCompletion.isComplete)
    #expect(subscriptions.count == 2)
    if subscriptions.count == 2 {
      #expect(subscriptions[0].0 != subscriptions[1].0)
      #expect(subscriptions.map(\.1) == [0, 1])
    }

    await connection.detach()
    _ = await firstSubscription.value
    _ = await replacementSubscription.value
  }

  @Test("v2 cursor replacement pauses the remaining in-flight command flush")
  func v2CursorReplacementPausesCommandFlush() async throws {
    let task = FakeWebSocketTask()
    let connection = makeChatConnection(task: task, selection: .v2Queue)
    let recorder = V2FrameRecorder()
    let recording = Task { await recordV2Frames(from: connection, in: recorder) }
    try await connectV2(connection, task: task)
    let initialSubscription = Task {
      try await connection.subscribeConversation(
        agentID: "agent-1",
        conversationID: conversationID,
        sinceV2Seq: 0
      )
    }
    await waitForV2FrameCount(2, on: task)
    let initialSubscriptionID = try #require(await task.sentV2Frames.subscriptionID)
    try await initialSubscription.value
    await task.enqueue(
      .string(
        v2ServerJSON(
          .control(
            .conversationSubscribed(
              id: initialSubscriptionID,
              conversationId: conversationID,
              v2ThroughSeq: 1
            )
          )
        )
      )
    )
    await waitForV2ServerFrameCount(2, in: recorder)

    let firstFrame = MobileV2WsClientFrame.editFollowUp(
      id: "00000000-0000-4000-8000-000000000046",
      conversationId: conversationID,
      inputId: "00000000-0000-4000-8000-000000000056",
      expectedRevision: 1,
      text: "first exact payload",
      images: nil
    )
    let secondFrame = MobileV2WsClientFrame.removeFollowUp(
      id: "00000000-0000-4000-8000-000000000047",
      conversationId: conversationID,
      inputId: "00000000-0000-4000-8000-000000000057",
      expectedRevision: 2
    )
    let firstCompletion = ChatConnectionCompletionProbe()
    let secondCompletion = ChatConnectionCompletionProbe()
    let firstSend = Task {
      let error = await anyError { try await connection.editFollowUp(firstFrame) }
      if error == nil { await firstCompletion.markComplete() }
      return error
    }
    await settleConcurrentWork()
    let secondSend = Task {
      let error = await anyError { try await connection.removeFollowUp(secondFrame) }
      if error == nil { await secondCompletion.markComplete() }
      return error
    }
    await settleConcurrentWork()
    await task.holdNextSend()
    await connection.acknowledgeAppliedV2Seq(1, conversationID: conversationID)
    await task.waitForHeldSend()

    let replacementSubscription = Task {
      try await connection.subscribeConversation(
        agentID: "agent-1",
        conversationID: conversationID,
        sinceV2Seq: 2
      )
    }
    await settleConcurrentWork()
    await task.succeedHeldSend()
    try await replacementSubscription.value

    let beforeReplacementAck = await task.sentV2Frames
    let replacementSubscriptionID = try #require(beforeReplacementAck.subscriptionID)
    let firstCompletedBeforeAck = await waitForCompletion(firstCompletion)
    #expect(beforeReplacementAck.contains(secondFrame) == false)
    #expect(beforeReplacementAck.filter { $0 == firstFrame }.count == 1)
    #expect(firstCompletedBeforeAck)
    #expect(await secondCompletion.isComplete == false)
    var replacementCursor: Int?
    if case let .subscribeConversation(_, _, _, cursor) = beforeReplacementAck.last {
      replacementCursor = cursor
    }
    #expect(replacementCursor == 2)

    await task.enqueue(
      .string(
        v2ServerJSON(
          .control(
            .conversationSubscribed(
              id: replacementSubscriptionID,
              conversationId: conversationID,
              v2ThroughSeq: 2
            )
          )
        )
      )
    )
    let secondCompleted = await waitForCompletion(secondCompletion)
    #expect(secondCompleted)
    let afterReplacementAck = await task.sentV2Frames
    #expect(afterReplacementAck.filter { $0 == firstFrame }.count == 1)
    #expect(afterReplacementAck.filter { $0 == secondFrame }.count == 1)

    await connection.detach()
    if firstCompletedBeforeAck {
      #expect(await firstSend.value == nil)
    }
    if secondCompleted {
      #expect(await secondSend.value == nil)
    }
    await recording.value
  }

  @Test("v2 cursor replacement commits an in-flight answer and pauses later answers")
  func v2CursorReplacementCommitsAnswerAndPausesLaterAnswer() async throws {
    let task = FakeWebSocketTask()
    let connection = makeChatConnection(task: task, selection: .v2Queue)
    let recorder = V2FrameRecorder()
    let recording = Task { await recordV2Frames(from: connection, in: recorder) }
    try await connectV2(connection, task: task)
    let initialSubscription = Task {
      try await connection.subscribeConversation(
        agentID: "agent-1",
        conversationID: conversationID,
        sinceV2Seq: 0
      )
    }
    await waitForV2FrameCount(2, on: task)
    let initialSubscriptionID = try #require(await task.sentV2Frames.subscriptionID)
    try await initialSubscription.value
    await task.enqueue(
      .string(
        v2ServerJSON(
          .control(
            .conversationSubscribed(
              id: initialSubscriptionID,
              conversationId: conversationID,
              v2ThroughSeq: 1
            )
          )
        )
      )
    )
    await waitForV2ServerFrameCount(2, in: recorder)

    let firstFrame = MobileV2WsClientFrame.answer(
      id: "run-first",
      questionId: "question-first",
      answer: "first answer"
    )
    let secondFrame = MobileV2WsClientFrame.answer(
      id: "run-second",
      questionId: "question-second",
      answer: "second answer"
    )
    let firstCompletion = ChatConnectionCompletionProbe()
    let secondCompletion = ChatConnectionCompletionProbe()
    let firstAnswer = Task {
      let error = await anyError {
        try await connection.answer(
          turnID: "run-first",
          questionID: "question-first",
          answer: "first answer"
        )
      }
      if error == nil { await firstCompletion.markComplete() }
      return error
    }
    await settleConcurrentWork()
    let secondAnswer = Task {
      let error = await anyError {
        try await connection.answer(
          turnID: "run-second",
          questionID: "question-second",
          answer: "second answer"
        )
      }
      if error == nil { await secondCompletion.markComplete() }
      return error
    }
    await settleConcurrentWork()
    await task.holdNextSend()
    await connection.acknowledgeAppliedV2Seq(1, conversationID: conversationID)
    await task.waitForHeldSend()

    let replacementSubscription = Task {
      try await connection.subscribeConversation(
        agentID: "agent-1",
        conversationID: conversationID,
        sinceV2Seq: 2
      )
    }
    await settleConcurrentWork()
    await task.succeedHeldSend()
    try await replacementSubscription.value

    let beforeReplacementAck = await task.sentV2Frames
    let replacementSubscriptionID = try #require(beforeReplacementAck.subscriptionID)
    let firstCompletedBeforeAck = await waitForCompletion(firstCompletion)
    #expect(beforeReplacementAck.filter { $0 == firstFrame }.count == 1)
    #expect(beforeReplacementAck.contains(secondFrame) == false)
    #expect(firstCompletedBeforeAck)
    #expect(await secondCompletion.isComplete == false)
    var replacementCursor: Int?
    if case let .subscribeConversation(_, _, _, cursor) = beforeReplacementAck.last {
      replacementCursor = cursor
    }
    #expect(replacementCursor == 2)

    await task.enqueue(
      .string(
        v2ServerJSON(
          .control(
            .conversationSubscribed(
              id: replacementSubscriptionID,
              conversationId: conversationID,
              v2ThroughSeq: 2
            )
          )
        )
      )
    )
    let secondCompleted = await waitForCompletion(secondCompletion)
    #expect(secondCompleted)
    let afterReplacementAck = await task.sentV2Frames
    #expect(afterReplacementAck.filter { $0 == firstFrame }.count == 1)
    #expect(afterReplacementAck.filter { $0 == secondFrame }.count == 1)

    await connection.detach()
    if firstCompletedBeforeAck {
      #expect(await firstAnswer.value == nil)
    }
    if secondCompleted {
      #expect(await secondAnswer.value == nil)
    }
    await recording.value
  }

  @Test("v2 cursor replacement settles an acknowledged in-flight command rejection")
  func v2CursorReplacementSettlesInFlightCommandRejection() async throws {
    let first = FakeWebSocketTask()
    let second = FakeWebSocketTask()
    let session = FakeWebSocketSession(tasks: [first, second])
    let connection = makeChatConnection(session: session, selection: .v2Queue)
    let recorder = V2FrameRecorder()
    let recording = Task { await recordV2Frames(from: connection, in: recorder) }
    try await connectV2(connection, task: first)
    _ = try await subscribeV2(
      connection,
      task: first,
      conversationID: conversationID,
      cursor: 0
    )
    await waitForV2ServerFrameCount(2, in: recorder)

    let command = MobileV2WsClientFrame.removeFollowUp(
      id: "00000000-0000-4000-8000-000000000061",
      conversationId: conversationID,
      inputId: "00000000-0000-4000-8000-000000000071",
      expectedRevision: 3
    )
    let completion = ChatConnectionCompletionProbe()
    await first.holdNextSend()
    let sending = Task {
      let error = await anyError { try await connection.removeFollowUp(command) }
      if error == nil { await completion.markComplete() }
      return error
    }
    await first.waitForHeldSend()

    let replacementSubscription = Task {
      try await connection.subscribeConversation(
        agentID: "agent-1",
        conversationID: conversationID,
        sinceV2Seq: 1
      )
    }
    await settleConcurrentWork()
    let rejection = MobileV2ControlFrame.commandRejected(
      id: "00000000-0000-4000-8000-000000000061",
      conversationId: conversationID,
      code: "revision_conflict",
      error: "stale revision",
      retryable: false,
      details: .object(["actualRevision": .number(4)])
    )
    await first.enqueue(.string(v2ServerJSON(.control(rejection))))
    await waitForV2ServerFrameCount(3, in: recorder)
    await connection.acknowledgeV2CommandRejected(rejection)

    await first.succeedHeldSend()
    try await replacementSubscription.value
    let completed = await waitForCompletion(completion)
    #expect(completed)
    #expect(await first.sentV2Frames.filter { $0 == command }.count == 1)

    await connection.suspend()
    let reconnecting = Task { try await connection.connect() }
    await waitForV2FrameCount(1, on: second)
    await second.enqueue(.string(v2ServerJSON(.control(v2HelloAcknowledgement()))))
    try await reconnecting.value
    await waitForV2FrameCount(2, on: second)
    let subscriptionID = try #require(await second.sentV2Frames.subscriptionID)
    await second.enqueue(
      .string(
        v2ServerJSON(
          .control(
            .conversationSubscribed(
              id: subscriptionID,
              conversationId: conversationID,
              v2ThroughSeq: 1
            )
          )
        )
      )
    )

    #expect(await waitForV2FrameCountEventually(3, on: second) == false)
    #expect(await second.sentV2Frames.contains(command) == false)
    await connection.detach()
    if completed {
      #expect(await sending.value == nil)
    }
    await recording.value
  }

  @Test("v2 cursor replacement settles a covered in-flight sticky cancel")
  func v2CursorReplacementSettlesInFlightStickyCancel() async throws {
    let first = FakeWebSocketTask()
    let second = FakeWebSocketTask()
    let session = FakeWebSocketSession(tasks: [first, second])
    let connection = makeChatConnection(session: session, selection: .v2Queue)
    let recorder = V2FrameRecorder()
    let recording = Task { await recordV2Frames(from: connection, in: recorder) }
    try await connectV2(connection, task: first)
    _ = try await subscribeV2(
      connection,
      task: first,
      conversationID: conversationID,
      cursor: 0
    )
    await waitForV2ServerFrameCount(2, in: recorder)

    let cancel = MobileV2WsClientFrame.cancel(id: "run-covered-in-flight")
    let completion = ChatConnectionCompletionProbe()
    await first.holdNextSend()
    let cancelling = Task {
      let error = await anyError {
        try await connection.cancel(turnID: "run-covered-in-flight")
      }
      if error == nil { await completion.markComplete() }
      return error
    }
    await first.waitForHeldSend()

    let replacementSubscription = Task {
      try await connection.subscribeConversation(
        agentID: "agent-1",
        conversationID: conversationID,
        sinceV2Seq: 1
      )
    }
    await settleConcurrentWork()
    await first.enqueue(
      .string(
        v2ServerJSON(
          .sequenced(
            .done(
              id: "run-covered-in-flight",
              conversationId: conversationID,
              v2Seq: 1,
              runId: "run-covered-in-flight",
              segmentTurnId: "00000000-0000-4000-8000-000000000081",
              outcome: .cancelled
            )
          )
        )
      )
    )
    await waitForV2ServerFrameCount(3, in: recorder)

    await first.succeedHeldSend()
    try await replacementSubscription.value
    let completed = await waitForCompletion(completion)
    #expect(completed)
    #expect(await first.sentV2Frames.filter { $0 == cancel }.count == 1)

    await connection.suspend()
    let reconnecting = Task { try await connection.connect() }
    await waitForV2FrameCount(1, on: second)
    await second.enqueue(.string(v2ServerJSON(.control(v2HelloAcknowledgement()))))
    try await reconnecting.value
    await waitForV2FrameCount(2, on: second)
    let subscriptionID = try #require(await second.sentV2Frames.subscriptionID)
    await second.enqueue(
      .string(
        v2ServerJSON(
          .control(
            .conversationSubscribed(
              id: subscriptionID,
              conversationId: conversationID,
              v2ThroughSeq: 1
            )
          )
        )
      )
    )

    #expect(await waitForV2FrameCountEventually(3, on: second) == false)
    #expect(await second.sentV2Frames.contains(cancel) == false)
    await connection.detach()
    if completed {
      #expect(await cancelling.value == nil)
    }
    await recording.value
  }

  @Test("v2 command completion ignores a successful write from a stale socket generation")
  func v2CommandCompletesOnCurrentGenerationWrite() async throws {
    let clock = ReconnectingTestAppClock()
    let first = FakeWebSocketTask()
    let second = FakeWebSocketTask()
    let session = FakeWebSocketSession(tasks: [first, second])
    let connection = makeChatConnection(
      session: session,
      clock: clock,
      selection: .v2Queue
    )
    try await connectV2(connection, task: first)
    _ = try await subscribeV2(
      connection,
      task: first,
      conversationID: conversationID,
      cursor: 0
    )

    let command = MobileV2WsClientFrame.editFollowUp(
      id: "00000000-0000-4000-8000-000000000015",
      conversationId: conversationID,
      inputId: "00000000-0000-4000-8000-000000000025",
      expectedRevision: 1,
      text: "generation",
      images: nil
    )
    let completion = ChatConnectionCompletionProbe()
    await first.holdNextSend()
    let sending = Task {
      let error = await anyError { try await connection.editFollowUp(command) }
      if error == nil { await completion.markComplete() }
      return error
    }
    await first.waitForHeldSend()

    await first.fail()
    await waitForRequestCount(2, in: session)
    await waitForV2FrameCount(1, on: second)
    await second.enqueue(.string(v2ServerJSON(.control(v2HelloAcknowledgement()))))
    await waitForV2FrameCount(2, on: second)
    let secondID = try #require(await second.sentV2Frames.subscriptionID)
    await second.holdNextSend()
    await second.enqueue(
      .string(
        v2ServerJSON(
          .control(
            .conversationSubscribed(
              id: secondID,
              conversationId: conversationID,
              v2ThroughSeq: 0
            )
          )
        )
      )
    )
    await second.waitForHeldSend()

    await first.succeedHeldSend()
    await settleConcurrentWork()
    #expect(await completion.isComplete == false)

    await second.succeedHeldSend()
    #expect(await sending.value == nil)
    #expect(await completion.isComplete)
    #expect(await second.sentV2Frames.last == command)
    await connection.detach()
  }

  @Test("v2 invalidates a failed generation before reconnect backoff")
  func v2FailureInvalidatesGenerationBeforeBackoff() async throws {
    let clock = HeldReconnectTestAppClock()
    let first = FakeWebSocketTask()
    let unused = FakeWebSocketTask()
    let session = FakeWebSocketSession(tasks: [first, unused])
    let connection = makeChatConnection(
      session: session,
      clock: clock,
      selection: .v2Queue
    )
    try await connectV2(connection, task: first)
    _ = try await subscribeV2(
      connection,
      task: first,
      conversationID: conversationID,
      cursor: 0
    )
    let command = MobileV2WsClientFrame.removeFollowUp(
      id: "00000000-0000-4000-8000-000000000019",
      conversationId: conversationID,
      inputId: "00000000-0000-4000-8000-000000000029",
      expectedRevision: 1
    )
    try await connection.removeFollowUp(command)

    await first.fail()
    await clock.waitForBackoff()

    let completion = ChatConnectionCompletionProbe()
    let retrying = Task {
      let error = await anyError { try await connection.removeFollowUp(command) }
      if error == nil { await completion.markComplete() }
      return error
    }
    await settleConcurrentWork()

    #expect(await completion.isComplete == false)
    #expect(await first.sentV2Frames.filter { $0 == command }.count == 1)
    #expect(session.requests.count == 1)

    await connection.detach()
    await clock.releaseBackoff()
    #expect(await retrying.value != nil)
  }

  @Test("v2 invalidates a failed socket before awaiting peer close metadata")
  func v2FailureInvalidatesSocketBeforePeerCloseLookup() async throws {
    let first = FakeWebSocketTask()
    let unused = FakeWebSocketTask()
    let session = FakeWebSocketSession(tasks: [first, unused])
    let connection = makeChatConnection(
      session: session,
      selection: .v2Queue
    )
    try await connectV2(connection, task: first)
    _ = try await subscribeV2(
      connection,
      task: first,
      conversationID: conversationID,
      cursor: 0
    )
    try await connection.waitUntilConversationReady(conversationID: conversationID)
    let terminal = Task { await terminalAnyError(from: connection) }

    await first.holdNextPeerClose()
    await first.fail(
      peerClose: .init(code: 1002, reason: Data("invalid_frame".utf8))
    )
    await first.waitForHeldPeerClose()

    let command = MobileV2WsClientFrame.removeFollowUp(
      id: "00000000-0000-4000-8000-000000000045",
      conversationId: conversationID,
      inputId: "00000000-0000-4000-8000-000000000055",
      expectedRevision: 1
    )
    let completion = ChatConnectionCompletionProbe()
    let sending = Task {
      let error = await anyError { try await connection.removeFollowUp(command) }
      if error == nil { await completion.markComplete() }
      return error
    }
    await settleConcurrentWork()

    #expect(await completion.isComplete == false)
    #expect(await first.sentV2Frames.contains(command) == false)

    await first.releasePeerClose()
    #expect(
      await sending.value as? V2ProtocolCloseError
        == V2ProtocolCloseError(reason: "invalid_frame")
    )
    #expect(
      await terminal.value as? V2ProtocolCloseError
        == V2ProtocolCloseError(reason: "invalid_frame")
    )
    #expect(session.requests.count == 1)
  }

  @Test("v2 suspend retains subscription readiness and command waiters for foreground resume")
  func v2SuspendRetainsSemanticState() async throws {
    let clock = ReconnectingTestAppClock()
    let first = FakeWebSocketTask()
    let second = FakeWebSocketTask()
    let session = FakeWebSocketSession(tasks: [first, second])
    let connection = makeChatConnection(
      session: session,
      clock: clock,
      selection: .v2Queue
    )
    let recorder = V2FrameRecorder()
    let recording = Task { await recordV2Frames(from: connection, in: recorder) }
    try await connectV2(connection, task: first)
    let subscribing = Task {
      try await connection.subscribeConversation(
        agentID: "agent-1",
        conversationID: conversationID,
        sinceV2Seq: 0
      )
    }
    await waitForV2FrameCount(2, on: first)
    let firstID = try #require(await first.sentV2Frames.subscriptionID)
    try await subscribing.value
    await first.enqueue(
      .string(
        v2ServerJSON(
          .control(
            .conversationSubscribed(
              id: firstID,
              conversationId: conversationID,
              v2ThroughSeq: 1
            )
          )
        )
      )
    )
    await waitForV2ServerFrameCount(2, in: recorder)

    let readiness = Task {
      try await connection.waitUntilConversationReady(conversationID: conversationID)
    }
    let command = MobileV2WsClientFrame.removeFollowUp(
      id: "00000000-0000-4000-8000-000000000016",
      conversationId: conversationID,
      inputId: "00000000-0000-4000-8000-000000000026",
      expectedRevision: 1
    )
    let sending = Task { try await connection.removeFollowUp(command) }
    await settleConcurrentWork()
    await connection.suspend()
    #expect(await first.waitForClose() == .goingAway)

    let connecting = Task { try await connection.connect() }
    await waitForV2FrameCount(1, on: second)
    await second.enqueue(.string(v2ServerJSON(.control(v2HelloAcknowledgement()))))
    try await connecting.value
    await waitForV2FrameCount(2, on: second)
    let secondID = try #require(await second.sentV2Frames.subscriptionID)
    #expect(secondID != firstID)
    await second.enqueue(
      .string(
        v2ServerJSON(
          .control(
            .conversationSubscribed(
              id: secondID,
              conversationId: conversationID,
              v2ThroughSeq: 0
            )
          )
        )
      )
    )
    try await readiness.value
    try await sending.value
    await waitForV2FrameCount(3, on: second)
    #expect(await second.sentV2Frames.last == command)
    await connection.detach()
    await recording.value
  }

  @Test(
    "v2 detach and shutdown fail pending readiness and command waiters",
    arguments: [false, true]
  )
  func v2TerminalLifecycleFailsPendingWaiters(useShutdown: Bool) async throws {
    let task = FakeWebSocketTask()
    let connection = makeChatConnection(task: task, selection: .v2Queue)
    try await connectV2(connection, task: task)
    let subscribing = Task {
      try await connection.subscribeConversation(
        agentID: "agent-1",
        conversationID: conversationID,
        sinceV2Seq: 0
      )
    }
    await waitForV2FrameCount(2, on: task)
    let subscriptionID = try #require(await task.sentV2Frames.subscriptionID)
    try await subscribing.value
    await task.enqueue(
      .string(
        v2ServerJSON(
          .control(
            .conversationSubscribed(
              id: subscriptionID,
              conversationId: conversationID,
              v2ThroughSeq: 1
            )
          )
        )
      )
    )
    await settleConcurrentWork()

    let readiness = Task {
      await anyError {
        try await connection.waitUntilConversationReady(conversationID: conversationID)
      }
    }
    let command = MobileV2WsClientFrame.removeFollowUp(
      id: "00000000-0000-4000-8000-000000000017",
      conversationId: conversationID,
      inputId: "00000000-0000-4000-8000-000000000027",
      expectedRevision: 1
    )
    let sending = Task { await anyError { try await connection.removeFollowUp(command) } }
    await settleConcurrentWork()

    if useShutdown {
      await connection.shutdown()
      await connection.shutdown()
    } else {
      await connection.detach()
      await connection.detach()
    }

    #expect(await readiness.value != nil)
    #expect(await sending.value != nil)
    #expect(await task.waitForClose() == .goingAway)
  }

  @Test(
    "bounded v2 protocol closes are typed and terminal",
    arguments: ["unsupported_version", "unexpected_hello", "hello_required", "invalid_frame"]
  )
  func v2ProtocolCloseIsTypedAndTerminal(reason: String) async throws {
    let task = FakeWebSocketTask()
    let unused = FakeWebSocketTask()
    let session = FakeWebSocketSession(tasks: [task, unused])
    let connection = makeChatConnection(
      session: session,
      selection: .v2Queue
    )
    try await connectV2(connection, task: task)
    let terminal = Task { await terminalAnyError(from: connection) }

    await task.fail(peerClose: .init(code: 1002, reason: Data(reason.utf8)))

    #expect(await terminal.value as? V2ProtocolCloseError == V2ProtocolCloseError(reason: reason))
    #expect(session.requests.count == 1)
    #expect(await task.waitForClose() == .goingAway)
  }

  @Test(
    "relay v2 raw 1002 uses the same typed terminal mapping",
    arguments: ["unsupported_version", "unexpected_hello", "hello_required", "invalid_frame"]
  )
  func relayV2ProtocolCloseIsTypedAndTerminal(reason: String) async throws {
    let task = FakeWebSocketTask()
    let unused = FakeWebSocketTask()
    let session = FakeWebSocketSession(tasks: [task, unused])
    let connection = ChatConnection(
      endpoint: relayEndpoint(chatToken: "chat-secret"),
      selection: .v2Queue,
      session: session,
      locationProvider: { nil }
    )
    try await connectV2(connection, task: task)
    let terminal = Task { await terminalAnyError(from: connection) }

    await task.fail(peerClose: .init(code: 1002, reason: Data(reason.utf8)))

    #expect(
      await terminal.value as? V2ProtocolCloseError
        == V2ProtocolCloseError(reason: reason)
    )
    #expect(session.requests.count == 1)
  }

  @Test("v2 protocol close fails a command waiting behind subscription readiness")
  func v2ProtocolCloseFailsPendingCommandWaiter() async throws {
    let task = FakeWebSocketTask()
    let unused = FakeWebSocketTask()
    let session = FakeWebSocketSession(tasks: [task, unused])
    let connection = makeChatConnection(session: session, selection: .v2Queue)
    try await connectV2(connection, task: task)
    let subscribing = Task {
      try await connection.subscribeConversation(
        agentID: "agent-1",
        conversationID: conversationID,
        sinceV2Seq: 0
      )
    }
    await waitForV2FrameCount(2, on: task)
    let subscriptionID = try #require(await task.sentV2Frames.subscriptionID)
    try await subscribing.value
    await task.enqueue(
      .string(
        v2ServerJSON(
          .control(
            .conversationSubscribed(
              id: subscriptionID,
              conversationId: conversationID,
              v2ThroughSeq: 1
            )
          )
        )
      )
    )
    await settleConcurrentWork()
    let command = Task {
      await anyError {
        try await connection.removeFollowUp(
          .removeFollowUp(
            id: "00000000-0000-4000-8000-000000000018",
            conversationId: conversationID,
            inputId: "00000000-0000-4000-8000-000000000028",
            expectedRevision: 1
          )
        )
      }
    }
    await settleConcurrentWork()

    await task.fail(peerClose: .init(code: 1002, reason: Data("invalid_frame".utf8)))

    #expect(
      await command.value as? V2ProtocolCloseError
        == V2ProtocolCloseError(reason: "invalid_frame")
    )
    #expect(session.requests.count == 1)
  }

  @Test("v2 raw 4002 remains an ordinary reconnecting socket close")
  func v2Raw4002IsNotProtocolCloseAlias() async throws {
    let clock = ReconnectingTestAppClock()
    let first = FakeWebSocketTask()
    let second = FakeWebSocketTask()
    let session = FakeWebSocketSession(tasks: [first, second])
    let connection = makeChatConnection(
      session: session,
      clock: clock,
      selection: .v2Queue
    )
    try await connectV2(connection, task: first)

    await first.fail(peerClose: .init(code: 4002, reason: Data("hello_required".utf8)))

    await waitForRequestCount(2, in: session)
    await waitForV2FrameCount(1, on: second)
    #expect(
      await second.sentV2Frames.first
        == .hello(contractVersion: 2, capabilities: ["chat-input-queue-v1"])
    )
    #expect((await clock.sleeps).contains(.seconds(1)))
    await connection.detach()
  }

  private func makeChatConnection(
    task: FakeWebSocketTask,
    clock: any AppClock = SystemAppClock(),
    location: ClientLocation? = nil,
    selection: MobileProtocolSelection = .v1
  ) -> ChatConnection {
    makeChatConnection(
      session: FakeWebSocketSession(tasks: [task]),
      clock: clock,
      location: location,
      selection: selection
    )
  }

  /// Defaults to reporting NO location so frame assertions are deterministic.
  /// The real provider reads this device's time zone and locale, which differ
  /// between a dev machine and a CI simulator — a frozen-frame assertion that
  /// depends on them passes wherever it was written and fails everywhere else.
  /// `locationIsAttachedToANewTurn` covers the populated case explicitly.
  private func makeChatConnection(
    session: FakeWebSocketSession,
    clock: any AppClock = SystemAppClock(),
    location: ClientLocation? = nil,
    selection: MobileProtocolSelection = .v1
  ) -> ChatConnection {
    ChatConnection(
      endpoint: lanEndpoint(),
      selection: selection,
      session: session,
      clock: clock,
      locationProvider: { location }
    )
  }

  private func lanEndpoint() -> ConnectionEndpoint {
    endpoint(mode: .lan, chatToken: "chat-secret")
  }

  private func relayEndpoint(chatToken: String) -> ConnectionEndpoint {
    endpoint(mode: .relay, chatToken: chatToken)
  }

  private func endpoint(mode: ConnectionMode, chatToken: String) -> ConnectionEndpoint {
    let relay = mode == .relay
    let profile = ConnectionProfile(
      id: UUID(),
      gatewayId: nil,
      publicKey: nil,
      label: "Test",
      host: relay ? "gateway.relay.example" : "127.0.0.1",
      managementPort: relay ? 443 : 9400,
      chatPort: relay ? 443 : 9400,
      secure: true,
      mode: mode,
      tlsCertificateSha256: relay
        ? nil
        : "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      createdAt: Date(timeIntervalSince1970: 0),
      lastSuccessfulSyncAt: nil
    )
    let secrets = ConnectionSecrets(
      managementToken: "management-secret",
      chatToken: chatToken,
      relayCredential: relay ? "relay-secret" : nil
    )
    return ConnectionEndpoint(profile: profile, secrets: secrets)
  }

  private func canonicalFrames() throws -> [MobileWSServerFrame] {
    [
      try fixture("chat-accepted.json"),
      try fixture("chat-event.json"),
      try fixture("chat-done.json"),
    ]
  }
}

private func collectFrames(
  from connection: ChatConnection,
  count: Int
) async throws -> [MobileWSServerFrame] {
  var frames: [MobileWSServerFrame] = []
  for try await event in await connection.events() {
    if case .frame(let frame) = event {
      frames.append(frame)
      if frames.count == count { break }
    }
  }
  return frames
}

private func collectV2Frames(
  from connection: ChatConnection,
  count: Int
) async throws -> [MobileV2WsServerFrame] {
  var frames: [MobileV2WsServerFrame] = []
  for try await event in await connection.events() {
    if case .v2Frame(let frame) = event {
      frames.append(frame)
      if frames.count == count { break }
    }
  }
  return frames
}

private enum FirstV2Observation: Equatable, Sendable {
  case frame(MobileV2WsServerFrame)
  case terminal(GatewayError)
  case ended
}

private func firstV2Observation(from connection: ChatConnection) async -> FirstV2Observation {
  do {
    for try await event in await connection.events() {
      if case .v2Frame(let frame) = event { return .frame(frame) }
    }
    return .ended
  } catch let error as GatewayError {
    return .terminal(error)
  } catch {
    return .ended
  }
}

private actor V2FrameRecorder {
  private(set) var frames: [MobileV2WsServerFrame] = []

  func append(_ frame: MobileV2WsServerFrame) {
    frames.append(frame)
  }
}

private func recordV2Frames(
  from connection: ChatConnection,
  in recorder: V2FrameRecorder
) async {
  do {
    for try await event in await connection.events() {
      if case .v2Frame(let frame) = event {
        await recorder.append(frame)
      }
    }
  } catch {
    // Terminal errors are asserted by the test that owns the recorder.
  }
}

private func waitForV2ServerFrameCount(_ count: Int, in recorder: V2FrameRecorder) async {
  while await recorder.frames.count < count {
    await Task.yield()
  }
}

private func terminalAnyError(from connection: ChatConnection) async -> (any Error)? {
  do {
    for try await _ in await connection.events() {}
    return nil
  } catch {
    return error
  }
}

private func anyError(_ operation: () async throws -> Void) async -> (any Error)? {
  do {
    try await operation()
    return nil
  } catch {
    return error
  }
}

private func waitForV2FrameCount(_ count: Int, on task: FakeWebSocketTask) async {
  while await task.sentV2Frames.count < count {
    await Task.yield()
  }
}

private func waitForV2FrameCountEventually(
  _ count: Int,
  on task: FakeWebSocketTask
) async -> Bool {
  for _ in 0..<1_000 {
    if await task.sentV2Frames.count >= count { return true }
    await Task.yield()
  }
  return await task.sentV2Frames.count >= count
}

private func connectV2(_ connection: ChatConnection, task: FakeWebSocketTask) async throws {
  let connecting = Task { try await connection.connect() }
  await waitForV2FrameCount(1, on: task)
  await task.enqueue(.string(v2ServerJSON(.control(v2HelloAcknowledgement()))))
  try await connecting.value
}

@discardableResult
private func subscribeV2(
  _ connection: ChatConnection,
  task: FakeWebSocketTask,
  conversationID: String,
  cursor: Int
) async throws -> String {
  let subscribing = Task {
    try await connection.subscribeConversation(
      agentID: "agent-1",
      conversationID: conversationID,
      sinceV2Seq: cursor
    )
  }
  await waitForV2FrameCount(2, on: task)
  let subscriptionID = try #require(await task.sentV2Frames.subscriptionID)
  try await subscribing.value
  await task.enqueue(
    .string(
      v2ServerJSON(
        .control(
          .conversationSubscribed(
            id: subscriptionID,
            conversationId: conversationID,
            v2ThroughSeq: cursor
          )
        )
      )
    )
  )
  return subscriptionID
}

private func v2HelloAcknowledgement() -> MobileV2ControlFrame {
  .helloAck(contractVersion: 2, capabilities: ["chat-input-queue-v1"])
}

private func firstFrame(from connection: ChatConnection) async -> MobileWSServerFrame? {
  do {
    for try await event in await connection.events() {
      if case .frame(let frame) = event { return frame }
    }
  } catch {
    return nil
  }
  return nil
}

private func framesUntilEnd(from connection: ChatConnection) async -> [MobileWSServerFrame] {
  var frames: [MobileWSServerFrame] = []
  do {
    for try await event in await connection.events() {
      if case .frame(let frame) = event {
        frames.append(frame)
      }
    }
  } catch {
    return frames
  }
  return frames
}

private func collectStates(
  from connection: ChatConnection,
  count: Int
) async throws -> [ChatTransportState] {
  var states: [ChatTransportState] = []
  for try await event in await connection.events() {
    if case .state(let state) = event {
      states.append(state)
      if states.count == count { break }
    }
  }
  return states
}

private func terminalError(from connection: ChatConnection) async -> GatewayError? {
  do {
    for try await _ in await connection.events() {}
    return nil
  } catch let error as GatewayError {
    return error
  } catch {
    Issue.record("Unexpected terminal error: \(error)")
    return nil
  }
}

private func chatGatewayError(
  _ operation: () async throws -> Void
) async -> GatewayError? {
  do {
    try await operation()
    return nil
  } catch let error as GatewayError {
    return error
  } catch {
    Issue.record("Unexpected error: \(error)")
    return nil
  }
}

private func waitForRequestCount(_ count: Int, in session: FakeWebSocketSession) async {
  while session.requests.count < count {
    await Task.yield()
  }
}

private func settleConcurrentWork() async {
  for _ in 0..<100 {
    await Task.yield()
  }
}

private func waitForCompletion(_ probe: ChatConnectionCompletionProbe) async -> Bool {
  for _ in 0..<1_000 {
    if await probe.isComplete { return true }
    await Task.yield()
  }
  return await probe.isComplete
}

private func serverJSON(_ frame: MobileWSServerFrame) -> String {
  let data = try! ContractCoding.encoder().encode(frame)
  return String(data: data, encoding: .utf8)!
}

private func v2ServerJSON(_ frame: MobileV2WsServerFrame) -> String {
  let data = try! ContractCoding.encoder().encode(frame)
  return String(data: data, encoding: .utf8)!
}

private func v2PendingInput(
  inputID: String = "00000000-0000-4000-8000-000000000021",
  kind: MobileV2PendingInputKind = .followUp,
  state: MobileV2PendingInputState = .queued,
  targetTurnID: String? = nil,
  revision: Int,
  text: String
) -> MobileV2PendingInput {
  MobileV2PendingInput(
    inputId: inputID,
    kind: kind,
    targetTurnId: targetTurnID ?? (kind == .steer ? "turn-active" : nil),
    text: text,
    images: nil,
    state: state,
    revision: revision,
    enqueueOrder: 1,
    runId: nil,
    segmentTurnId: nil,
    userMessageId: nil,
    assistantMessageId: nil,
    failureCode: nil,
    failureMessage: nil,
    createdAt: Date(timeIntervalSince1970: 0),
    updatedAt: Date(timeIntervalSince1970: 0),
    deliveredAt: nil
  )
}

private func fixture(_ name: String, replacingID: String? = nil) throws -> MobileWSServerFrame {
  var data = try FixtureLoader.data(name)
  if let replacingID {
    var object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    object["id"] = replacingID
    data = try JSONSerialization.data(withJSONObject: object)
  }
  return try ContractCoding.decoder().decode(MobileWSServerFrame.self, from: data)
}

private func fixtureLine(
  _ name: String,
  index: Int,
  replacingID: String? = nil
) throws -> MobileWSServerFrame {
  let source = String(decoding: try FixtureLoader.data(name), as: UTF8.self)
  let lines = source.split(whereSeparator: \.isNewline).map(String.init)
  var data = Data(lines[index].utf8)
  if let replacingID {
    var object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    object["id"] = replacingID
    data = try JSONSerialization.data(withJSONObject: object)
  }
  return try ContractCoding.decoder().decode(
    MobileWSServerFrame.self,
    from: data
  )
}

private extension Array where Element == MobileV2WsClientFrame {
  var subscriptionID: String? {
    for frame in reversed() {
      if case .subscribeConversation(let id, _, _, _) = frame { return id }
    }
    return nil
  }
}

private extension MobileV2WsClientFrame {
  var v2TestTypeName: String {
    switch self {
    case .hello: "hello"
    case .subscribeConversation: "subscribe_conversation"
    case .message: "message"
    case .enqueueInput: "enqueue_input"
    case .editFollowUp: "edit_follow_up"
    case .removeFollowUp: "remove_follow_up"
    case .resumeFollowUps: "resume_follow_ups"
    case .answer: "answer"
    case .cancel: "cancel"
    }
  }
}

private extension MobileV2WsServerFrame {
  var v2TestTypeName: String {
    switch self {
    case .control(.helloAck): "hello_ack"
    case .control(.conversationSubscribed): "conversation_subscribed"
    case .control(.commandRejected): "command_rejected"
    case .sequenced(.accepted): "accepted"
    case .sequenced(.event): "event"
    case .sequenced(.done): "done"
    case .sequenced(.error): "error"
    case .sequenced(.inputAccepted): "input_accepted"
    case .sequenced(.inputUpdated): "input_updated"
    case .sequenced(.inputRemoved): "input_removed"
    case .sequenced(.inputFailed): "input_failed"
    case .sequenced(.inputDelivered): "input_delivered"
    case .sequenced(.queuePaused): "queue_paused"
    case .sequenced(.queueResumed): "queue_resumed"
    }
  }
}
