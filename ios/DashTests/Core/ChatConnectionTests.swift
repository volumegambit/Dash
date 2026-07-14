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

  @Test("relay request preserves encoded chat token and relay header")
  func relayRequest() async throws {
    let task = FakeWebSocketTask()
    let session = FakeWebSocketSession(tasks: [task])
    let connection = ChatConnection(
      endpoint: relayEndpoint(chatToken: "chat token&value"),
      session: session
    )

    try await connection.connect()

    let request = try #require(session.requests.first)
    let url = try #require(request.url)
    let components = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false))
    #expect(components.path == "/ws/chat")
    #expect(components.queryItems == [URLQueryItem(name: "token", value: "chat token&value")])
    #expect(request.url?.absoluteString.contains("token=chat%20token%26value") == true)
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
    let probe = Task { try await connection.probeAuthentication() }

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

    let probe = Task { try await connection.probeAuthentication() }
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
      await chatGatewayError { try await connection.probeAuthentication() }
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
    let probe = Task { try await connection.probeAuthentication() }
    _ = await task.nextSentFrame()

    await task.enqueue(.string(serverJSON(try fixture("chat-accepted.json"))))

    try await probe.value
    #expect(await task.waitForClose() == .goingAway)
  }

  @Test("authentication probe accepts a decoded legacy frame without capable fields")
  func authenticationProbeAcceptsLegacyFrame() async throws {
    let task = FakeWebSocketTask()
    let connection = makeChatConnection(task: task)
    let probe = Task { try await connection.probeAuthentication() }
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
      await chatGatewayError { try await connection.probeAuthentication() }
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
      await chatGatewayError { try await connection.probeAuthentication() }
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
      try await connection.probeAuthentication()
    }

    #expect(error == .transport("Chat authentication probe timed out"))
    #expect(await clock.sleeps.contains(.seconds(5)))
    #expect(await task.waitForClose() == .goingAway)
  }

  private func makeChatConnection(
    task: FakeWebSocketTask,
    clock: any AppClock = SystemAppClock()
  ) -> ChatConnection {
    makeChatConnection(session: FakeWebSocketSession(tasks: [task]), clock: clock)
  }

  private func makeChatConnection(
    session: FakeWebSocketSession,
    clock: any AppClock = SystemAppClock()
  ) -> ChatConnection {
    ChatConnection(endpoint: lanEndpoint(), session: session, clock: clock)
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
      managementPort: relay ? 443 : 9300,
      chatPort: relay ? 443 : 9200,
      secure: relay,
      mode: mode,
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

private func serverJSON(_ frame: MobileWSServerFrame) -> String {
  let data = try! ContractCoding.encoder().encode(frame)
  return String(data: data, encoding: .utf8)!
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
