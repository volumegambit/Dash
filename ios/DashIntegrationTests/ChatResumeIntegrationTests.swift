import Foundation
import XCTest

@testable import Dash

final class ChatResumeIntegrationTests: XCTestCase {
  func testDetachReplayResume() async throws {
    let environment = try LiveGatewayEnvironment.processInfo()
    try XCTSkipUnless(environment.scenario == "stream", "Requires the stream harness")
    let firstClient = try environment.makeClient()
    let conversation = try await createConversation(
      api: firstClient.api,
      agentID: environment.agentID,
      title: "iOS detach and resume"
    )
    let turnID = UUID().uuidString.lowercased()
    let firstRecording = await LiveChatRecording.start(chat: firstClient.chat)

    try await firstClient.chat.connect()
    try await firstClient.chat.sendTurn(
      id: turnID,
      agentID: environment.agentID,
      conversationID: conversation.id,
      text: "Keep streaming",
      images: []
    )
    _ = try await firstRecording.recorder.waitForFrame(turnID: turnID) {
      $0.liveIsAccepted
    }
    _ = try await firstRecording.recorder.waitForFrame(turnID: turnID) {
      $0.liveEvent != nil
    }
    await firstClient.chat.detach()
    await firstRecording.finished()

    let firstFrames = await firstRecording.recorder.frames(turnID: turnID)
    let firstSequences = firstFrames.compactMap(\.liveSequence)
    let sinceSequence = try XCTUnwrap(firstSequences.max())
    let durableReplay = try await waitForReplay(
      api: firstClient.api,
      agentID: environment.agentID,
      conversationID: conversation.id,
      sinceSequence: sinceSequence
    )
    XCTAssertFalse(durableReplay.entries.isEmpty)

    let resumedClient = try firstClient.rebuiltOverSharedStore()
    let resumedRecording = await LiveChatRecording.start(chat: resumedClient.chat)
    defer { resumedRecording.cancel() }
    try await resumedClient.chat.connect()
    try await resumedClient.chat.resume(
      turnID: turnID,
      agentID: environment.agentID,
      conversationID: conversation.id,
      sinceSeq: sinceSequence
    )
    let terminal = try await resumedRecording.recorder.waitForFrame(turnID: turnID) {
      $0.liveOutcome != nil
    }
    XCTAssertEqual(terminal.liveOutcome, .completed)

    let resumedFrames = await resumedRecording.recorder.frames(turnID: turnID)
    let frames = firstFrames + resumedFrames
    let sequences = frames.compactMap(\.liveSequence)
    XCTAssertEqual(sequences, sequences.sorted())
    XCTAssertEqual(Set(sequences).count, sequences.count)
    XCTAssertEqual(sequences, Array(1...sequences.count))
    XCTAssertEqual(
      durableReplay.entries.map(\.seq),
      resumedFrames.compactMap(\.liveSequence)
    )

    let transcript = try await resumedClient.api.messages(
      conversationID: conversation.id,
      limit: 100,
      before: nil
    )
    XCTAssertEqual(transcript.items.count, 2)
    let assistant = try XCTUnwrap(transcript.items.first { $0.role == .assistant })
    XCTAssertEqual(assistant.status, .completed)
    guard case .assistant(let persistedEvents) = assistant.content else {
      return XCTFail("Expected an assistant transcript")
    }
    XCTAssertEqual(persistedEvents, frames.compactMap(\.liveEvent))
    await resumedClient.chat.detach()
  }

  func testQuestionAnswer() async throws {
    let environment = try LiveGatewayEnvironment.processInfo()
    try XCTSkipUnless(environment.scenario == "question", "Requires the question harness")
    let client = try environment.makeClient()
    let conversation = try await createConversation(
      api: client.api,
      agentID: environment.agentID,
      title: "iOS question and answer"
    )
    let turnID = UUID().uuidString.lowercased()
    let recording = await LiveChatRecording.start(chat: client.chat)
    defer { recording.cancel() }

    try await client.chat.connect()
    try await client.chat.sendTurn(
      id: turnID,
      agentID: environment.agentID,
      conversationID: conversation.id,
      text: "Choose",
      images: []
    )
    let questionFrame = try await recording.recorder.waitForFrame(turnID: turnID) { frame in
      guard case .question = frame.liveEvent else { return false }
      return true
    }
    guard case .question(let questionID, let question, let options) = questionFrame.liveEvent else {
      return XCTFail("Expected the canonical question event")
    }
    XCTAssertEqual(question, "Choose a color")
    XCTAssertEqual(options, ["Blue", "Green"])
    try await client.chat.answer(turnID: turnID, questionID: questionID, answer: "Blue")
    let terminal = try await recording.recorder.waitForFrame(turnID: turnID) {
      $0.liveOutcome != nil
    }
    XCTAssertEqual(terminal.liveOutcome, .completed)

    let transcript = try await client.api.messages(
      conversationID: conversation.id,
      limit: 100,
      before: nil
    )
    let assistant = try XCTUnwrap(transcript.items.first { $0.role == .assistant })
    guard case .assistant(let events) = assistant.content else {
      return XCTFail("Expected persisted assistant events")
    }
    XCTAssertTrue(events.contains(questionFrame.liveEvent!))
    XCTAssertTrue(
      events.contains {
        guard case .response(let content, _) = $0 else { return false }
        return content == "Selected: Blue"
      }
    )
    await client.chat.detach()
  }

  func testExplicitCancel() async throws {
    let environment = try LiveGatewayEnvironment.processInfo()
    try XCTSkipUnless(environment.scenario == "slow", "Requires the slow harness")
    let client = try environment.makeClient()
    let conversation = try await createConversation(
      api: client.api,
      agentID: environment.agentID,
      title: "iOS explicit cancel"
    )
    let turnID = UUID().uuidString.lowercased()
    let recording = await LiveChatRecording.start(chat: client.chat)
    defer { recording.cancel() }

    try await client.chat.connect()
    try await client.chat.sendTurn(
      id: turnID,
      agentID: environment.agentID,
      conversationID: conversation.id,
      text: "Work slowly",
      images: []
    )
    _ = try await recording.recorder.waitForFrame(turnID: turnID) { $0.liveIsAccepted }
    _ = try await recording.recorder.waitForFrame(turnID: turnID) { $0.liveEvent != nil }
    try await client.chat.cancel(turnID: turnID)
    let terminal = try await recording.recorder.waitForFrame(turnID: turnID) {
      $0.liveOutcome != nil
    }
    XCTAssertEqual(terminal.liveOutcome, .cancelled)

    let summary = try await client.api.conversation(id: conversation.id)
    XCTAssertNil(summary.activeTurnId)
    XCTAssertNotEqual(summary.status, .running)

    let badClient = try environment.replacing(chatToken: "incorrect-token").makeClient()
    let rawCloseCode = try await closeCode(for: badClient.endpoint.chatRequest())
    XCTAssertEqual(rawCloseCode, 4001)

    let badRecording = await LiveChatRecording.start(chat: badClient.chat)
    defer { badRecording.cancel() }
    try await badClient.chat.connect()
    let mappedError = try await badRecording.recorder.waitForFailure()
    XCTAssertEqual(mappedError, .unauthorized)
    await client.chat.detach()
  }
}

private func createConversation(
  api: GatewayAPI,
  agentID: String,
  title: String
) async throws -> ConversationSummaryDTO {
  try await api.createConversation(
    CreateConversationRequest(
      agentId: agentID,
      requestId: UUID().uuidString.lowercased(),
      title: title,
      owningIssueId: nil,
      projectId: nil
    )
  )
}

private func waitForReplay(
  api: GatewayAPI,
  agentID: String,
  conversationID: String,
  sinceSequence: Int
) async throws -> ReplayPageDTO {
  let clock = ContinuousClock()
  let deadline = clock.now.advanced(by: .seconds(15))
  while clock.now < deadline {
    let replay = try await api.replay(
      agentID: agentID,
      conversationID: conversationID,
      sinceSeq: sinceSequence
    )
    if replay.entries.contains(where: { entry in
      guard case .done = entry.payload else { return false }
      return true
    }) {
      return replay
    }
    try await clock.sleep(for: .milliseconds(40))
  }
  throw LiveGatewayTestError.timeout
}

private func closeCode(for request: URLRequest) async throws -> Int {
  let task = URLSession.shared.webSocketTask(with: request)
  task.resume()
  defer { task.cancel(with: .goingAway, reason: nil) }
  do {
    _ = try await task.receive()
  } catch {
    // The mounted gateway reports authentication failures through its close frame.
  }

  let clock = ContinuousClock()
  let deadline = clock.now.advanced(by: .seconds(15))
  while clock.now < deadline {
    if task.closeCode != .invalid {
      return Int(task.closeCode.rawValue)
    }
    try await clock.sleep(for: .milliseconds(20))
  }
  throw LiveGatewayTestError.timeout
}

extension MobileWSServerFrame {
  var liveSequence: Int? {
    switch self {
    case .accepted(_, _, _, _, _, let sequence):
      return sequence
    case .event(_, _, let sequence, _),
      .done(_, _, let sequence, _),
      .error(_, _, let sequence, _, _, _, _):
      return sequence
    }
  }

  var liveEvent: AgentEvent? {
    guard case .event(_, _, _, let event) = self else { return nil }
    return event
  }

  var liveOutcome: TurnOutcome? {
    guard case .done(_, _, _, let outcome) = self else { return nil }
    return outcome
  }

  var liveIsAccepted: Bool {
    guard case .accepted = self else { return false }
    return true
  }
}
