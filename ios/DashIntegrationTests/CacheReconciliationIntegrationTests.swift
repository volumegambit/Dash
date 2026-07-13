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
    let recording = await LiveChatRecording.start(
      chat: client.chat,
      sync: client.sync,
      agentID: environment.agentID
    )
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
    _ = try await recording.recorder.waitForFrame(turnID: turnID) { $0.liveIsAccepted }
    let firstEvent = try await recording.recorder.waitForFrame(turnID: turnID) {
      $0.liveEvent != nil
    }
    let detachedAt = try XCTUnwrap(firstEvent.liveSequence)

    await client.sync.sceneDidEnterBackground()
    try await Task.sleep(for: .milliseconds(150))
    let stillRunning = try await client.api.conversation(id: conversation.id)
    XCTAssertEqual(stillRunning.status, .running)
    XCTAssertEqual(stillRunning.activeTurnId, turnID)
    _ = try await client.api.replay(
      agentID: environment.agentID,
      conversationID: conversation.id,
      sinceSeq: detachedAt
    )

    await client.sync.sceneWillEnterForeground()
    try await client.chat.cancel(turnID: turnID)
    let terminal = try await recording.recorder.waitForFrame(turnID: turnID) {
      $0.liveOutcome != nil
    }
    XCTAssertEqual(terminal.liveOutcome, .cancelled)
    let terminalSequence = try XCTUnwrap(terminal.liveSequence)
    try await waitForCursor(
      terminalSequence,
      store: client.store,
      gatewayID: environment.gatewayID,
      conversationID: conversation.id
    )

    let frames = await recording.recorder.frames(turnID: turnID)
    let sequences = frames.compactMap(\.liveSequence)
    XCTAssertEqual(sequences, sequences.sorted())
    XCTAssertEqual(Set(sequences).count, sequences.count)
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
    await client.sync.shutdown()
  }
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
