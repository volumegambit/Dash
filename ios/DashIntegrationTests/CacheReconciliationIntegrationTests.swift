import Foundation
import XCTest

@testable import Dash

final class CacheReconciliationIntegrationTests: XCTestCase {
  func testColdBootstrapAndRestart() async throws {
    let environment = try LiveGatewayEnvironment.processInfo()
    try XCTSkipUnless(environment.scenario == "stream", "Requires the stream harness")
    let firstClient = try environment.makeClient()
    let firstChat = await LiveChatRecording.start(
      chat: firstClient.chat,
      sync: firstClient.sync,
      agentID: environment.agentID
    )
    await firstClient.sync.bootstrap()

    let conversation = try await firstClient.sync.createConversation(
      CreateConversationRequest(
        agentId: environment.agentID,
        requestId: UUID().uuidString.lowercased(),
        title: "iOS cold cache",
        owningIssueId: nil,
        projectId: nil
      )
    )
    let turnID = UUID().uuidString.lowercased()
    try await firstClient.sync.sendTurn(
      id: turnID,
      agentID: environment.agentID,
      conversationID: conversation.id,
      text: "Populate the cache",
      images: []
    )
    let terminal = try await firstChat.recorder.waitForFrame(turnID: turnID) {
      $0.liveOutcome != nil
    }
    let terminalSequence = try XCTUnwrap(terminal.liveSequence)
    try await waitForCursor(
      terminalSequence,
      store: firstClient.store,
      gatewayID: environment.gatewayID,
      conversationID: conversation.id
    )
    await firstClient.sync.loadMessages(conversationID: conversation.id, reset: true)

    let firstCachedList = try await firstClient.store.conversations(
      gatewayID: environment.gatewayID,
      limit: 100
    )
    let firstCachedTranscript = try await firstClient.store.messages(
      gatewayID: environment.gatewayID,
      conversationID: conversation.id
    )
    let firstCursor = try await firstClient.store.cursor(
      gatewayID: environment.gatewayID,
      conversationID: conversation.id
    )
    XCTAssertTrue(firstCachedList.contains { $0.id == conversation.id })
    XCTAssertFalse(firstCachedTranscript.isEmpty)
    XCTAssertEqual(firstCursor, terminalSequence)

    await firstClient.sync.shutdown()
    await firstChat.finished()
    let restartedClient = try firstClient.rebuiltOverSharedStore()
    XCTAssertTrue(firstClient.store === restartedClient.store)
    let snapshots = await LiveSyncRecording.start(restartedClient.sync)
    defer { snapshots.cancel() }
    let bootstrap = Task { await restartedClient.sync.bootstrap() }
    let cachedSnapshot = try await snapshots.recorder.waitFor { snapshot in
      snapshot.connection == .connecting
        && snapshot.conversations.contains { $0.id == conversation.id }
    }
    XCTAssertTrue(cachedSnapshot.conversations.contains { $0.id == conversation.id })
    await bootstrap.value
    _ = try await snapshots.recorder.waitFor { $0.connection == .online }

    let resumedCursor = try await restartedClient.store.cursor(
      gatewayID: environment.gatewayID,
      conversationID: conversation.id
    )
    XCTAssertEqual(resumedCursor, firstCursor)
    await restartedClient.sync.loadMessages(conversationID: conversation.id, reset: true)

    let refreshedCache = try await restartedClient.store.messages(
      gatewayID: environment.gatewayID,
      conversationID: conversation.id
    )
    let canonical = try await restartedClient.api.messages(
      conversationID: conversation.id,
      limit: 100,
      before: nil
    )
    XCTAssertEqual(refreshedCache, canonical.items)
    XCTAssertEqual(Set(refreshedCache.map(\.id)).count, refreshedCache.count)
    XCTAssertEqual(refreshedCache.count, firstCachedTranscript.count)

    try await restartedClient.store.saveDraft(
      ConversationDraft(
        text: "Unsaved draft",
        attachments: [
          PreparedAttachment(
            id: UUID(),
            mediaType: "image/png",
            data: Data([0x89, 0x50, 0x4E, 0x47])
          )
        ],
        updatedAt: Date()
      ),
      gatewayID: environment.gatewayID,
      conversationID: conversation.id
    )
    await restartedClient.sync.sceneDidEnterBackground()

    let mutationClient = try environment.makeClient()
    let current = try await mutationClient.api.conversation(id: conversation.id)
    _ = try await mutationClient.api.deleteConversation(
      id: conversation.id,
      revision: current.revision
    )
    let remoteList = try await mutationClient.api.conversations(
      agentId: nil,
      limit: 100,
      cursor: nil
    )
    XCTAssertFalse(remoteList.items.contains { $0.id == conversation.id })
    let cachedBeforePointRead = try await restartedClient.store.conversation(
      gatewayID: environment.gatewayID,
      id: conversation.id
    )
    XCTAssertNotEqual(cachedBeforePointRead?.summary.status, .deleted)

    await restartedClient.sync.sceneWillEnterForeground()
    let reconciledList = try await restartedClient.store.conversations(
      gatewayID: environment.gatewayID,
      limit: 100
    )
    let tombstone = try await restartedClient.store.conversation(
      gatewayID: environment.gatewayID,
      id: conversation.id
    )
    let purgedMessages = try await restartedClient.store.messages(
      gatewayID: environment.gatewayID,
      conversationID: conversation.id
    )
    let purgedCursor = try await restartedClient.store.cursor(
      gatewayID: environment.gatewayID,
      conversationID: conversation.id
    )
    let purgedDraft = try await restartedClient.store.draft(
      gatewayID: environment.gatewayID,
      conversationID: conversation.id
    )
    XCTAssertFalse(reconciledList.contains { $0.id == conversation.id })
    XCTAssertEqual(tombstone?.summary.status, .deleted)
    XCTAssertTrue(purgedMessages.isEmpty)
    XCTAssertEqual(purgedCursor, 0)
    XCTAssertNil(purgedDraft)
    await restartedClient.sync.shutdown()
  }

  func testBackgroundDetachForegroundReconciliation() async throws {
    let environment = try LiveGatewayEnvironment.processInfo()
    try XCTSkipUnless(environment.scenario == "slow", "Requires the slow harness")
    let client = try environment.makeClient()
    let recording = await LiveChatRecording.start(chat: client.chat)
    defer { recording.cancel() }
    await client.sync.bootstrap()

    let conversation = try await client.sync.createConversation(
      CreateConversationRequest(
        agentId: environment.agentID,
        requestId: UUID().uuidString.lowercased(),
        title: "iOS background reconciliation",
        owningIssueId: nil,
        projectId: nil
      )
    )
    let turnID = UUID().uuidString.lowercased()
    try await client.sync.sendTurn(
      id: turnID,
      agentID: environment.agentID,
      conversationID: conversation.id,
      text: "Continue while detached",
      images: []
    )
    _ = try await recording.recorder.waitForFrame(turnID: turnID) {
      $0.liveIsAccepted
    }
    let initial = try await recording.recorder.waitForFrame(turnID: turnID) {
      $0.liveEvent == .textDelta(text: "Starting")
    }
    let detachedAt = try XCTUnwrap(initial.liveSequence)
    await client.sync.consumeLiveFrame(initial, agentID: environment.agentID)
    try await waitForCursor(
      detachedAt,
      store: client.store,
      gatewayID: environment.gatewayID,
      conversationID: conversation.id
    )
    await client.sync.sceneDidEnterBackground()
    try await client.releaseSlowEvent()
    let missed = try await waitForReplayEvent(
      api: client.api,
      agentID: environment.agentID,
      conversationID: conversation.id,
      sinceSequence: detachedAt
    )
    XCTAssertGreaterThan(missed.seq, detachedAt)
    guard case .event(let missedEvent) = missed.payload else {
      return XCTFail("Expected a durable event after backgrounding")
    }
    XCTAssertEqual(missedEvent, .textDelta(text: "Working"))
    let detachedCursor = try await client.store.cursor(
      gatewayID: environment.gatewayID,
      conversationID: conversation.id
    )
    XCTAssertEqual(detachedCursor, detachedAt)

    let stillRunning = try await client.api.conversation(id: conversation.id)
    XCTAssertEqual(stillRunning.status, .running)
    XCTAssertEqual(stillRunning.activeTurnId, turnID)

    await client.sync.sceneWillEnterForeground()
    try await waitForCursor(
      missed.seq,
      store: client.store,
      gatewayID: environment.gatewayID,
      conversationID: conversation.id
    )
    let recovered = try await client.store.messages(
      gatewayID: environment.gatewayID,
      conversationID: conversation.id
    )
    let recoveredAssistant = try XCTUnwrap(recovered.first { $0.role == .assistant })
    guard case .assistant(let recoveredEvents) = recoveredAssistant.content else {
      return XCTFail("Expected a recovered assistant transcript")
    }
    XCTAssertEqual(recoveredEvents.filter { $0 == missedEvent }.count, 1)

    let replayMarker = await recording.recorder.marker(turnID: turnID)
    try await client.chat.connect()
    try await client.chat.resume(
      turnID: turnID,
      agentID: environment.agentID,
      conversationID: conversation.id,
      sinceSeq: detachedAt
    )
    let replayed = try await recording.recorder.waitForFrame(
      turnID: turnID,
      after: replayMarker
    ) {
      $0.liveSequence == missed.seq && $0.liveEvent == missedEvent
    }
    XCTAssertEqual(replayed.liveSequence, missed.seq)
    XCTAssertEqual(replayed.liveEvent, missedEvent)
    await client.sync.consumeLiveFrame(replayed, agentID: environment.agentID)

    try await client.chat.cancel(turnID: turnID)
    let terminal = try await recording.recorder.waitForFrame(
      turnID: turnID,
      after: replayMarker
    ) {
      $0.liveOutcome != nil
    }
    XCTAssertEqual(terminal.liveOutcome, .cancelled)
    await client.sync.consumeLiveFrame(terminal, agentID: environment.agentID)
    let terminalSequence = try XCTUnwrap(terminal.liveSequence)
    try await waitForCursor(
      terminalSequence,
      store: client.store,
      gatewayID: environment.gatewayID,
      conversationID: conversation.id
    )

    let frames = await recording.recorder.frames(turnID: turnID, after: replayMarker)
    let sequences = frames.compactMap(\.liveSequence)
    XCTAssertEqual(sequences, sequences.sorted())
    XCTAssertEqual(Set(sequences).count, sequences.count)
    XCTAssertEqual(
      frames.filter { $0.liveSequence == missed.seq && $0.liveEvent == missedEvent }.count,
      1
    )
    let cached = try await client.store.messages(
      gatewayID: environment.gatewayID,
      conversationID: conversation.id
    )
    let canonical = try await client.api.messages(
      conversationID: conversation.id,
      limit: 100,
      before: nil
    )
    XCTAssertEqual(cached, canonical.items)
    XCTAssertEqual(Set(cached.map(\.id)).count, cached.count)
    XCTAssertEqual(canonical.items.count, 2)
    let canonicalAssistant = try XCTUnwrap(canonical.items.first { $0.role == .assistant })
    guard case .assistant(let canonicalEvents) = canonicalAssistant.content else {
      return XCTFail("Expected a canonical assistant transcript")
    }
    XCTAssertEqual(canonicalEvents.filter { $0 == missedEvent }.count, 1)
    await client.sync.shutdown()
  }
}

private func waitForReplayEvent(
  api: GatewayAPI,
  agentID: String,
  conversationID: String,
  sinceSequence: Int
) async throws -> ReplayEntryDTO {
  let clock = ContinuousClock()
  let deadline = clock.now.advanced(by: .seconds(15))
  while clock.now < deadline {
    let replay = try await api.replay(
      agentID: agentID,
      conversationID: conversationID,
      sinceSeq: sinceSequence
    )
    if let event = replay.entries.first(where: { entry in
      guard entry.seq > sinceSequence else { return false }
      guard case .event = entry.payload else { return false }
      return true
    }) {
      return event
    }
    try await clock.sleep(for: .milliseconds(20))
  }
  throw LiveGatewayTestError.timeout
}

private func waitForCursor(
  _ expected: Int,
  store: PersistenceStore,
  gatewayID: String,
  conversationID: String
) async throws {
  let clock = ContinuousClock()
  let deadline = clock.now.advanced(by: .seconds(15))
  while clock.now < deadline {
    let cursor = try await store.cursor(gatewayID: gatewayID, conversationID: conversationID)
    if cursor >= expected { return }
    try await clock.sleep(for: .milliseconds(20))
  }
  throw LiveGatewayTestError.timeout
}
