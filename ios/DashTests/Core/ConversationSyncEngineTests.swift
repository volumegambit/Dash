import Foundation
import Network
import Testing

@testable import Dash

@Suite("Conversation sync engine", .serialized)
struct ConversationSyncEngineTests {
  @Test("bootstrap publishes cached conversations before canonical network state")
  func cacheFirstBootstrap() async throws {
    let store = try PersistenceStore.inMemory()
    try await store.upsertConversations(
      [summary(id: "cached", title: "Cached", revision: 1)],
      gatewayID: "gw"
    )
    let api = FakeConversationSyncAPI()
    let gate = TestGate()
    await api.holdConversationPages(on: gate)
    await api.enqueueConversationPage(
      .success(
        .init(items: [summary(id: "canonical", title: "Canonical", revision: 2)], nextCursor: nil))
    )
    let engine = makeEngine(store: store, api: api)
    let stream = await engine.snapshots()
    var snapshots = stream.makeAsyncIterator()
    let bootstrap = Task { await engine.bootstrap() }

    let cached = try #require(await snapshots.next())
    #expect(cached.connection == .connecting)
    #expect(cached.conversations.map(\.id) == ["cached"])

    await gate.release()
    await bootstrap.value
    let canonical = try #require(await snapshots.next())
    #expect(canonical.connection == .online)
    #expect(canonical.conversations.map(\.id) == ["canonical"])
    #expect(canonical.mutationsAllowed)
  }

  @Test("transport reconnect retries the full authoritative bootstrap")
  func reconnectRetriesAgentsAndConversations() async throws {
    let store = try PersistenceStore.inMemory()
    let api = FakeConversationSyncAPI()
    let canonicalAgent = agent(id: "agent-remote", name: "Remote Agent")
    await api.enqueueAgents(.failure(.transport("bootstrap unavailable")))
    await api.enqueueAgents(.success([canonicalAgent]))
    await api.enqueueConversationPage(
      .success(
        .init(items: [summary(id: "remote", title: "Remote")], nextCursor: nil)
      )
    )
    let engine = makeEngine(store: store, api: api)

    await engine.bootstrap()
    await eventually { await api.agentListCallCount == 2 }
    await eventually {
      (try? await store.agents(gatewayID: "gw")) == [canonicalAgent]
    }
    await eventually { await api.conversationListCalls.count == 1 }

    #expect(await api.agentListCallCount == 2)
    #expect(await api.conversationListCalls.count == 1)
    #expect(try await store.agents(gatewayID: "gw") == [canonicalAgent])
    #expect(try await store.conversation(gatewayID: "gw", id: "remote") != nil)
    await engine.shutdown()
  }

  @Test("authoritative reset replaces agents removed on another device")
  func resetRefreshRemovesStaleAgents() async throws {
    let store = try PersistenceStore.inMemory()
    let stale = agent(id: "removed", name: "Removed")
    try await store.replaceAgents([stale], gatewayID: "gw")
    let api = FakeConversationSyncAPI()
    await api.enqueueAgents(.success([]))
    await api.enqueueConversationPage(.success(.init(items: [], nextCursor: nil)))
    let engine = makeEngine(store: store, api: api)

    await engine.refreshConversations(reset: true)

    #expect(try await store.agents(gatewayID: "gw").isEmpty)
    #expect(await api.agentListCallCount == 1)
  }

  @Test("foreground reconciliation replaces agents removed on another device")
  func foregroundRemovesStaleAgents() async throws {
    let store = try PersistenceStore.inMemory()
    let stale = agent(id: "removed", name: "Removed")
    try await store.replaceAgents([stale], gatewayID: "gw")
    let api = FakeConversationSyncAPI()
    await api.enqueueAgents(.success([]))
    let engine = makeEngine(store: store, api: api)

    await engine.sceneWillEnterForeground()

    #expect(try await store.agents(gatewayID: "gw").isEmpty)
    #expect(await api.agentListCallCount == 1)
  }

  @Test("conversation pagination carries the opaque cursor and preserves gateway order")
  func pagination() async throws {
    let store = try PersistenceStore.inMemory()
    try await store.upsertConversations(
      [summary(id: "oldest", title: "Cached oldest", updatedAt: instant(10))],
      gatewayID: "gw"
    )
    let api = FakeConversationSyncAPI()
    await api.enqueueConversationPage(
      .success(
        .init(
          items: [
            summary(id: "newest", title: "Newest", updatedAt: instant(30)),
            summary(id: "middle", title: "Middle", updatedAt: instant(20)),
          ],
          nextCursor: "opaque-page-2"
        )
      )
    )
    await api.enqueueConversationPage(
      .success(
        .init(
          items: [
            summary(id: "older-middle", title: "Older middle", updatedAt: instant(15)),
            summary(id: "oldest", title: "Oldest", revision: 2, updatedAt: instant(10)),
          ],
          nextCursor: nil
        )
      )
    )
    await api.enqueueConversation(
      id: "oldest",
      result: .success(
        summary(id: "oldest", title: "Audited oldest", revision: 2, updatedAt: instant(10))
      )
    )
    let engine = makeEngine(store: store, api: api, pageSize: 2)
    let stream = await engine.snapshots()
    var snapshots = stream.makeAsyncIterator()

    await engine.bootstrap()
    _ = await snapshots.next()
    let firstPage = try #require(await snapshots.next())
    await engine.loadOlderConversations()
    let secondPage = try #require(await snapshots.next())

    #expect(firstPage.conversations.map(\.id) == ["newest", "middle", "oldest"])
    #expect(
      secondPage.conversations.map(\.id)
        == ["newest", "middle", "older-middle", "oldest"]
    )
    #expect(
      await api.conversationListCalls
        == [
          .init(agentID: nil, limit: 2, cursor: nil),
          .init(agentID: nil, limit: 2, cursor: "opaque-page-2"),
        ]
    )
    #expect(await api.conversationCalls == ["oldest"])
  }

  @Test("concurrent older load and reset serialize gateway order and opaque cursor")
  func concurrentResetSupersedesOlderLoad() async throws {
    let store = try PersistenceStore.inMemory()
    let api = FakeConversationSyncAPI()
    await api.enqueueConversationPage(
      .success(
        .init(
          items: [summary(id: "current", title: "Current", updatedAt: instant(20))],
          nextCursor: "old-cursor"
        )
      )
    )
    let engine = makeEngine(store: store, api: api)
    let recorder = SnapshotRecorder()
    let collector = Task {
      for await snapshot in await engine.snapshots() {
        await recorder.append(snapshot)
      }
    }
    await engine.bootstrap()
    await eventually { await recorder.count >= 2 }

    let olderGate = TestGate()
    await api.enqueueConversationPage(
      .success(
        .init(
          items: [summary(id: "older", title: "Older", updatedAt: instant(10))],
          nextCursor: nil
        )
      ),
      waitingOn: olderGate
    )
    await api.enqueueConversationPage(
      .success(
        .init(
          items: [
            summary(id: "older", title: "Canonical older", revision: 2, updatedAt: instant(30)),
            summary(id: "current", title: "Canonical current", revision: 2, updatedAt: instant(20)),
          ],
          nextCursor: "new-cursor"
        )
      )
    )
    await api.enqueueConversationPage(
      .success(.init(items: [], nextCursor: nil))
    )

    let older = Task { await engine.loadOlderConversations() }
    await olderGate.waitUntilWaiting()
    let reset = Task { await engine.refreshConversations(reset: true) }
    await reset.value
    await olderGate.release()
    await older.value
    await settleSyncWork()

    #expect(await recorder.last?.conversations.map(\.id) == ["older", "current"])
    await engine.loadOlderConversations()
    #expect(
      await api.conversationListCalls
        == [
          .init(agentID: nil, limit: 50, cursor: nil),
          .init(agentID: nil, limit: 50, cursor: "old-cursor"),
          .init(agentID: nil, limit: 50, cursor: nil),
          .init(agentID: nil, limit: 50, cursor: "new-cursor"),
        ]
    )
    collector.cancel()
    await engine.shutdown()
  }

  @Test("a stale reset failure cannot override a newer successful reset")
  func newerSuccessfulResetSupersedesStaleFailure() async throws {
    let store = try PersistenceStore.inMemory()
    let api = FakeConversationSyncAPI()
    let staleGate = TestGate()
    await api.enqueueConversationPage(
      .failure(.unauthorized),
      waitingOn: staleGate
    )
    await api.enqueueConversationPage(
      .success(.init(items: [summary(id: "current", title: "Current")], nextCursor: nil))
    )
    let engine = makeEngine(store: store, api: api)
    let recorder = SnapshotRecorder()
    let collector = Task {
      for await snapshot in await engine.snapshots() {
        await recorder.append(snapshot)
      }
    }

    let stale = Task { await engine.refreshConversations(reset: true) }
    await staleGate.waitUntilWaiting()
    await engine.refreshConversations(reset: true)
    await eventually { await recorder.last?.connection == .online }

    await staleGate.release()
    await stale.value
    await settleSyncWork()

    #expect(await recorder.last?.connection == .online)
    #expect(await recorder.last?.mutationsAllowed == true)
    collector.cancel()
    await engine.shutdown()
  }

  @Test("older conversation load cannot start while an authoritative reset is in flight")
  func resetBlocksOlderConversationLoad() async throws {
    let store = try PersistenceStore.inMemory()
    let api = FakeConversationSyncAPI()
    await api.enqueueConversationPage(
      .success(.init(items: [summary(id: "initial", title: "Initial")], nextCursor: "older"))
    )
    let resetGate = TestGate()
    await api.enqueueConversationPage(
      .success(.init(items: [summary(id: "reset", title: "Reset")], nextCursor: nil)),
      waitingOn: resetGate
    )
    await api.enqueueConversationPage(
      .success(.init(items: [summary(id: "unexpected", title: "Unexpected")], nextCursor: nil))
    )
    let engine = makeEngine(store: store, api: api)
    await engine.bootstrap()
    let reset = Task { await engine.refreshConversations(reset: true) }
    await resetGate.waitUntilWaiting()

    await engine.loadOlderConversations()
    await resetGate.release()
    await reset.value

    #expect(
      await api.conversationListCalls
        == [
          .init(agentID: nil, limit: 50, cursor: nil),
          .init(agentID: nil, limit: 50, cursor: nil),
        ]
    )
    #expect(try await store.conversation(gatewayID: "gw", id: "unexpected") == nil)
  }

  @Test("SSE invalidations refresh canonical summaries instead of persisting hint bodies")
  func sseHintsRefreshCanonicalState() async throws {
    let store = try PersistenceStore.inMemory()
    let api = FakeConversationSyncAPI()
    let invalidations = FakeInvalidationSource()
    await api.enqueueConversationPage(
      .success(.init(items: [summary(id: "c", title: "Initial", revision: 1)], nextCursor: nil))
    )
    await api.enqueueConversation(
      id: "c",
      result: .success(summary(id: "c", title: "Canonical change", revision: 2))
    )
    await api.enqueueConversation(
      id: "c",
      result: .success(
        summary(
          id: "c",
          title: "Canonical tombstone",
          revision: 3,
          status: .deleted,
          deletedAt: instant(40)
        )
      )
    )
    let engine = makeEngine(store: store, api: api, invalidations: invalidations)
    await engine.bootstrap()

    invalidations.yield(.conversationChanged(conversationID: "c", revision: 999))
    await eventually {
      let cached = try? await store.conversation(gatewayID: "gw", id: "c")
      return cached?.summary.revision == 2
    }
    let changed = try #require(try await store.conversation(gatewayID: "gw", id: "c"))
    #expect(changed.summary.title == "Canonical change")
    #expect(changed.summary.revision == 2)

    invalidations.yield(.conversationDeleted(conversationID: "c", revision: 1_000))
    await eventually {
      let cached = try? await store.conversation(gatewayID: "gw", id: "c")
      return cached?.summary.status == .deleted
    }
    let deleted = try #require(try await store.conversation(gatewayID: "gw", id: "c"))
    #expect(deleted.summary.title == "Canonical tombstone")
    #expect(deleted.summary.revision == 3)
    #expect(await api.conversationCalls == ["c", "c"])
  }

  @Test(
    "stale and equal tombstones cannot retire a newer active cached conversation",
    arguments: [5, 6]
  )
  func rejectedTombstoneDoesNotEmitRemoval(tombstoneRevision: Int) async throws {
    let store = try PersistenceStore.inMemory()
    let current = summary(id: "c", title: "Current", revision: 6, updatedAt: instant(60))
    try await store.upsertConversations([current], gatewayID: "gw")
    #expect(try await store.conversation(gatewayID: "gw", id: "c")?.summary == current)
    let api = FakeConversationSyncAPI()
    await api.enqueueConversationPage(
      .success(
        .init(
          items: [
            summary(
              id: "c",
              title: "Rejected tombstone",
              revision: tombstoneRevision,
              status: .deleted,
              updatedAt: instant(50),
              deletedAt: instant(50)
            )
          ],
          nextCursor: nil
        )
      )
    )
    let engine = makeEngine(store: store, api: api)
    let stream = await engine.snapshots()
    var snapshots = stream.makeAsyncIterator()

    await engine.refreshConversations(reset: true)

    let snapshot = try #require(await snapshots.next())
    #expect(snapshot.conversations.map(\.summary) == [current])
    #expect(snapshot.removedConversationIDs.isEmpty)
    #expect(try await store.conversation(gatewayID: "gw", id: "c")?.summary == current)
    await engine.shutdown()
  }

  @Test("an accepted tombstone resets message sync state before a newer revival")
  func acceptedTombstoneResetsMessageSyncState() async throws {
    try await expectDeletionResetsMessageSyncState(
      deletion: .success(
        summary(
          id: "c",
          title: "Deleted",
          revision: 2,
          status: .deleted,
          updatedAt: instant(20),
          deletedAt: instant(20)
        )
      ),
      revived: summary(id: "c", title: "Revived", revision: 3, updatedAt: instant(30))
    )
  }

  @Test("a direct 404 removal resets message sync state before a newer revival")
  func directNotFoundResetsMessageSyncState() async throws {
    try await expectDeletionResetsMessageSyncState(
      deletion: .failure(.notFound),
      revived: summary(id: "c", title: "Revived", revision: 2, updatedAt: instant(30))
    )
  }

  @Test("a delayed direct 404 retains a newer canonical conversation and its content")
  func delayedDirectNotFoundRetainsNewerCanonical() async throws {
    let store = try PersistenceStore.inMemory()
    let initial = summary(id: "c", title: "Initial", revision: 1, updatedAt: instant(10))
    let revived = summary(id: "c", title: "Revived", revision: 2, updatedAt: instant(20))
    let revivedMessage = message(id: "revived-message")
    let revivedDraft = ConversationDraft(
      text: "Keep the revived draft",
      attachments: [],
      updatedAt: instant(21)
    )
    try await store.upsertConversations([initial], gatewayID: "gw")
    let responseGate = TestGate()
    let api = FakeConversationSyncAPI()
    await api.enqueueConversation(id: initial.id, result: .failure(.notFound), waitingOn: responseGate)
    let engine = makeEngine(store: store, api: api)

    let refresh = Task { await engine.refreshConversation(id: initial.id) }
    await responseGate.waitUntilWaiting()
    try await store.upsertConversations([revived], gatewayID: "gw")
    try await store.mergeMessages(
      [revivedMessage],
      gatewayID: "gw",
      conversationID: revived.id
    )
    try await store.saveDraft(revivedDraft, gatewayID: "gw", conversationID: revived.id)
    try await store.advanceCursor(gatewayID: "gw", conversationID: revived.id, to: 8)
    await responseGate.release()
    await refresh.value

    #expect(try await store.conversation(gatewayID: "gw", id: revived.id)?.summary == revived)
    #expect(try await store.messages(gatewayID: "gw", conversationID: revived.id) == [revivedMessage])
    #expect(try await store.draft(gatewayID: "gw", conversationID: revived.id) == revivedDraft)
    #expect(try await store.cursor(gatewayID: "gw", conversationID: revived.id) == 8)
    await engine.shutdown()
  }

  @Test("a delayed omission 404 retains a newer canonical conversation without removal output")
  func delayedOmissionNotFoundRetainsNewerCanonical() async throws {
    let store = try PersistenceStore.inMemory()
    let initial = summary(id: "c", title: "Initial", revision: 1, updatedAt: instant(10))
    let revived = summary(id: "c", title: "Revived", revision: 2, updatedAt: instant(20))
    try await store.upsertConversations([initial], gatewayID: "gw")
    let responseGate = TestGate()
    let api = FakeConversationSyncAPI()
    await api.enqueueConversationPage(.success(.init(items: [], nextCursor: nil)))
    await api.enqueueConversation(id: initial.id, result: .failure(.notFound), waitingOn: responseGate)
    let engine = makeEngine(store: store, api: api)
    let stream = await engine.snapshots()
    var snapshots = stream.makeAsyncIterator()

    let refresh = Task { await engine.refreshConversations(reset: true) }
    await responseGate.waitUntilWaiting()
    try await store.upsertConversations([revived], gatewayID: "gw")
    await responseGate.release()
    await refresh.value
    let snapshot = try #require(await snapshots.next())

    #expect(snapshot.conversations.map(\.summary) == [revived])
    #expect(snapshot.removedConversationIDs.isEmpty)
    #expect(try await store.conversation(gatewayID: "gw", id: revived.id)?.summary == revived)
    await engine.shutdown()
  }

  @Test("a delayed foreground omission 404 retains a newer canonical conversation")
  func delayedForegroundOmissionNotFoundRetainsNewerCanonical() async throws {
    let store = try PersistenceStore.inMemory()
    let initial = summary(id: "c", title: "Initial", revision: 1, updatedAt: instant(10))
    let revived = summary(id: "c", title: "Revived", revision: 2, updatedAt: instant(20))
    try await store.upsertConversations([initial], gatewayID: "gw")
    let responseGate = TestGate()
    let api = FakeConversationSyncAPI()
    await api.enqueueConversationPage(.success(.init(items: [], nextCursor: nil)))
    await api.enqueueConversation(id: initial.id, result: .failure(.notFound), waitingOn: responseGate)
    let engine = makeEngine(store: store, api: api)
    let stream = await engine.snapshots()
    var snapshots = stream.makeAsyncIterator()

    let foreground = Task { await engine.sceneWillEnterForeground() }
    await responseGate.waitUntilWaiting()
    try await store.upsertConversations([revived], gatewayID: "gw")
    await responseGate.release()
    await foreground.value
    let snapshot = try #require(await snapshots.next())

    #expect(snapshot.conversations.map(\.summary) == [revived])
    #expect(snapshot.removedConversationIDs.isEmpty)
    #expect(try await store.conversation(gatewayID: "gw", id: revived.id)?.summary == revived)
    await engine.shutdown()
  }

  @Test("a revived row before publish suppresses a completed 404 removal output")
  func revivedConversationSuppressesCompletedNotFoundRemovalOutput() async throws {
    let store = try PersistenceStore.inMemory()
    let initial = summary(id: "c", title: "Initial", revision: 1, updatedAt: instant(10))
    let revived = summary(id: "c", title: "Revived", revision: 2, updatedAt: instant(20))
    try await store.upsertConversations([initial], gatewayID: "gw")
    let detailGate = TestGate()
    let publishGate = TestGate()
    let api = FakeConversationSyncAPI()
    await api.enqueueConversationPage(.success(.init(items: [], nextCursor: nil)))
    await api.enqueueConversation(id: initial.id, result: .failure(.notFound), waitingOn: detailGate)
    let engine = makeEngine(
      store: store,
      api: api,
      clock: GatedNowClock(value: instant(100), gate: publishGate)
    )
    let stream = await engine.snapshots()
    var snapshots = stream.makeAsyncIterator()

    let refresh = Task { await engine.refreshConversations(reset: true) }
    await detailGate.waitUntilWaiting()
    await detailGate.release()
    await publishGate.waitUntilWaiting()
    try await store.upsertConversations([revived], gatewayID: "gw")
    await publishGate.release()
    await refresh.value
    let snapshot = try #require(await snapshots.next())

    #expect(snapshot.conversations.map(\.summary) == [revived])
    #expect(snapshot.removedConversationIDs.isEmpty)
    await engine.shutdown()
  }

  @Test("a revived row before publish suppresses a completed tombstone removal output")
  func revivedConversationSuppressesCompletedTombstoneRemovalOutput() async throws {
    let store = try PersistenceStore.inMemory()
    let initial = summary(id: "c", title: "Initial", revision: 1, updatedAt: instant(10))
    let tombstone = summary(
      id: initial.id,
      title: "Deleted",
      revision: 2,
      status: .deleted,
      updatedAt: instant(20),
      deletedAt: instant(20)
    )
    let revived = summary(id: "c", title: "Revived", revision: 3, updatedAt: instant(30))
    try await store.upsertConversations([initial], gatewayID: "gw")
    let publishGate = TestGate()
    let api = FakeConversationSyncAPI()
    await api.enqueueConversationPage(.success(.init(items: [tombstone], nextCursor: nil)))
    let engine = makeEngine(
      store: store,
      api: api,
      clock: GatedNowClock(value: instant(100), gate: publishGate)
    )
    let stream = await engine.snapshots()
    var snapshots = stream.makeAsyncIterator()

    let refresh = Task { await engine.refreshConversations(reset: true) }
    await publishGate.waitUntilWaiting()
    try await store.upsertConversations([revived], gatewayID: "gw")
    await publishGate.release()
    await refresh.value
    let snapshot = try #require(await snapshots.next())

    #expect(snapshot.conversations.map(\.summary) == [revived])
    #expect(snapshot.removedConversationIDs.isEmpty)
    await engine.shutdown()
  }

  @Test("a live sequence gap replays from the durable cursor before applying the pending frame")
  func replayGap() async throws {
    let store = try PersistenceStore.inMemory()
    try await store.upsertConversations(
      [summary(id: "c", title: "Running", status: .running, activeTurnID: "turn-1")],
      gatewayID: "gw"
    )
    try await store.advanceCursor(gatewayID: "gw", conversationID: "c", to: 4)
    let api = FakeConversationSyncAPI()
    await api.enqueueReplay(
      .success(
        .init(entries: [
          replayEntry(seq: 5, payload: .event(event: .textDelta(text: "missing")))
        ])
      )
    )
    await api.enqueueMessages(
      conversationID: "c",
      result: .success(
        .init(items: [message(id: "assistant", turnID: "turn-1")], nextCursor: nil, throughSeq: 6)
      )
    )
    let engine = makeEngine(store: store, api: api)
    let pending = MobileWSServerFrame.event(
      id: "turn-1",
      conversationId: "c",
      seq: 6,
      event: .textDelta(text: "pending")
    )

    await engine.consumeLiveFrame(pending, agentID: "agent-1")
    await engine.consumeLiveFrame(pending, agentID: "agent-1")

    #expect(try await store.cursor(gatewayID: "gw", conversationID: "c") == 6)
    #expect(
      try await store.messages(gatewayID: "gw", conversationID: "c").map(\.id) == ["assistant"])
    #expect(
      await api.replayCalls
        == [.init(agentID: "agent-1", conversationID: "c", sinceSeq: 4)]
    )
    #expect(await api.messageListCalls.count == 1)
  }

  @Test("concurrent older-message load cannot regress a newer reset cursor")
  func concurrentOlderMessageLoadAndReset() async throws {
    let store = try PersistenceStore.inMemory()
    try await store.upsertConversations(
      [summary(id: "c", title: "Conversation")],
      gatewayID: "gw"
    )
    let api = FakeConversationSyncAPI()
    await api.enqueueMessages(
      conversationID: "c",
      result: .success(
        .init(items: [message(id: "initial")], nextCursor: "older-1", throughSeq: 1)
      )
    )
    let olderGate = TestGate()
    await api.enqueueMessages(
      conversationID: "c",
      result: .success(
        .init(items: [message(id: "stale-older")], nextCursor: nil, throughSeq: 2)
      ),
      waitingOn: olderGate
    )
    await api.enqueueMessages(
      conversationID: "c",
      result: .success(
        .init(items: [message(id: "reset")], nextCursor: "fresh-older", throughSeq: 3)
      )
    )
    await api.enqueueMessages(
      conversationID: "c",
      result: .success(
        .init(items: [message(id: "fresh-older")], nextCursor: nil, throughSeq: 4)
      )
    )
    let engine = makeEngine(store: store, api: api)
    await engine.loadMessages(conversationID: "c", reset: true)
    let staleOlder = Task { await engine.loadOlderMessages(conversationID: "c") }
    await olderGate.waitUntilWaiting()

    await engine.loadMessages(conversationID: "c", reset: true)
    await olderGate.release()
    await staleOlder.value
    await engine.loadOlderMessages(conversationID: "c")

    #expect(
      await api.messageListCalls
        == [
          .init(conversationID: "c", limit: 50, before: nil),
          .init(conversationID: "c", limit: 50, before: "older-1"),
          .init(conversationID: "c", limit: 50, before: nil),
          .init(conversationID: "c", limit: 50, before: "fresh-older"),
        ]
    )
    #expect(try await store.cursor(gatewayID: "gw", conversationID: "c") == 4)
  }

  @Test("older message load cannot start while a canonical reset is in flight")
  func messageResetBlocksOlderLoad() async throws {
    let store = try PersistenceStore.inMemory()
    try await store.upsertConversations(
      [summary(id: "c", title: "Conversation")],
      gatewayID: "gw"
    )
    let api = FakeConversationSyncAPI()
    await api.enqueueMessages(
      conversationID: "c",
      result: .success(
        .init(items: [message(id: "initial")], nextCursor: "older", throughSeq: 1)
      )
    )
    let resetGate = TestGate()
    await api.enqueueMessages(
      conversationID: "c",
      result: .success(
        .init(items: [message(id: "reset")], nextCursor: nil, throughSeq: 3)
      ),
      waitingOn: resetGate
    )
    await api.enqueueMessages(
      conversationID: "c",
      result: .success(
        .init(items: [message(id: "unexpected")], nextCursor: nil, throughSeq: 2)
      )
    )
    let engine = makeEngine(store: store, api: api)
    await engine.loadMessages(conversationID: "c", reset: true)
    let reset = Task { await engine.loadMessages(conversationID: "c", reset: true) }
    await resetGate.waitUntilWaiting()

    await engine.loadOlderMessages(conversationID: "c")
    await resetGate.release()
    await reset.value

    #expect(
      await api.messageListCalls
        == [
          .init(conversationID: "c", limit: 50, before: nil),
          .init(conversationID: "c", limit: 50, before: nil),
        ]
    )
    #expect(
      try await store.messages(gatewayID: "gw", conversationID: "c").map(\.id).contains(
        "unexpected"
      ) == false
    )
  }

  @Test("foreground canonical reconciliation refreshes running state without owning chat")
  func foregroundReconciliation() async throws {
    let store = try PersistenceStore.inMemory()
    try await store.upsertConversations(
      [
        summary(
          id: "running",
          title: "Running",
          status: .running,
          activeTurnID: "turn-running",
          updatedAt: instant(20)
        ),
        summary(
          id: "running-two",
          title: "Running two",
          status: .running,
          activeTurnID: "turn-running-two",
          updatedAt: instant(15)
        ),
        summary(id: "completed", title: "Completed", updatedAt: instant(10)),
      ],
      gatewayID: "gw"
    )
    try await store.advanceCursor(gatewayID: "gw", conversationID: "running", to: 4)
    try await store.advanceCursor(gatewayID: "gw", conversationID: "running-two", to: 2)
    try await store.advanceCursor(gatewayID: "gw", conversationID: "completed", to: 8)
    let api = FakeConversationSyncAPI()
    let canonicalAgent = agent(id: "agent-1", name: "Canonical Agent")
    await api.enqueueAgents(.success([canonicalAgent]))
    await api.enqueueConversationPage(
      .success(
        .init(
          items: [
            summary(
              id: "running",
              title: "Running",
              revision: 2,
              status: .running,
              activeTurnID: "turn-running",
              updatedAt: instant(22)
            ),
            summary(
              id: "running-two",
              title: "Running two",
              revision: 2,
              status: .running,
              activeTurnID: "turn-running-two",
              updatedAt: instant(17)
            ),
            summary(id: "completed", title: "Completed", revision: 2, updatedAt: instant(12)),
          ],
          nextCursor: nil
        )
      )
    )
    await api.enqueueMessages(
      conversationID: "running",
      result: .success(
        .init(
          items: [
            message(id: "running-message", conversationID: "running", turnID: "turn-running")
          ],
          nextCursor: nil,
          throughSeq: 6
        )
      )
    )
    await api.enqueueMessages(
      conversationID: "running-two",
      result: .success(
        .init(
          items: [
            message(
              id: "running-two-message",
              conversationID: "running-two",
              turnID: "turn-running-two"
            )
          ],
          nextCursor: nil,
          throughSeq: 3
        )
      )
    )
    let chat = FakeConversationChat()
    let engine = makeEngine(store: store, api: api, chat: chat)

    await engine.sceneDidEnterBackground()
    await engine.sceneWillEnterForeground()

    #expect(try await store.cursor(gatewayID: "gw", conversationID: "running") == 6)
    #expect(try await store.cursor(gatewayID: "gw", conversationID: "running-two") == 3)
    #expect(try await store.cursor(gatewayID: "gw", conversationID: "completed") == 8)
    #expect(try await store.agents(gatewayID: "gw") == [canonicalAgent])
    #expect(
      try await store.messages(gatewayID: "gw", conversationID: "running").map(\.id)
        == ["running-message"]
    )
    #expect(await api.messageListCalls.map(\.conversationID) == ["running", "running-two"])
    #expect(await api.conversationCalls.isEmpty)
    #expect(await chat.calls == [.suspend])
  }

  @Test("foreground reset discovers remote conversations across every canonical page before audit")
  func foregroundDiscoversRemoteConversationsAcrossPages() async throws {
    let store = try PersistenceStore.inMemory()
    try await store.upsertConversations(
      [
        summary(
          id: "cached-running",
          title: "Cached running",
          status: .running,
          activeTurnID: "turn-running",
          updatedAt: instant(10)
        )
      ],
      gatewayID: "gw"
    )
    let api = FakeConversationSyncAPI()
    await api.enqueueAgents(.success([]))
    await api.enqueueConversationPage(
      .success(
        .init(
          items: [
            summary(
              id: "created-remotely",
              title: "Created remotely",
              updatedAt: instant(30)
            )
          ],
          nextCursor: "page-2"
        )
      )
    )
    await api.enqueueConversationPage(
      .success(
        .init(
          items: [
            summary(
              id: "cached-running",
              title: "Canonical running",
              revision: 2,
              status: .running,
              activeTurnID: "turn-running",
              updatedAt: instant(20)
            )
          ],
          nextCursor: nil
        )
      )
    )
    await api.enqueueMessages(
      conversationID: "cached-running",
      result: .success(
        .init(
          items: [message(id: "running-message", conversationID: "cached-running")],
          nextCursor: nil,
          throughSeq: 2
        )
      )
    )
    let engine = makeEngine(store: store, api: api, pageSize: 1)

    await engine.sceneDidEnterBackground()
    await engine.sceneWillEnterForeground()

    #expect(
      await api.conversationListCalls
        == [
          .init(agentID: nil, limit: 1, cursor: nil),
          .init(agentID: nil, limit: 1, cursor: "page-2"),
        ]
    )
    #expect(await api.conversationCalls.isEmpty)
    #expect(await api.messageListCalls.map(\.conversationID) == ["cached-running"])
    #expect(try await store.conversation(gatewayID: "gw", id: "created-remotely") != nil)
  }

  @Test("foreground deletion audit isolates a failed detail probe")
  func foregroundDeletionAuditIsolatesDetailFailure() async throws {
    let store = try PersistenceStore.inMemory()
    try await store.upsertConversations(
      [
        summary(id: "probe-failed", title: "Probe failed"),
        summary(id: "removed", title: "Removed"),
      ],
      gatewayID: "gw"
    )
    let api = FakeConversationSyncAPI()
    await api.enqueueAgents(.success([]))
    await api.enqueueConversationPage(.success(.init(items: [], nextCursor: nil)))
    await api.enqueueConversation(
      id: "probe-failed",
      result: .failure(.validation("Malformed conversation"))
    )
    await api.enqueueConversation(id: "removed", result: .failure(.notFound))
    let engine = makeEngine(store: store, api: api)
    let recorder = SnapshotRecorder()
    let collector = Task {
      for await snapshot in await engine.snapshots() {
        await recorder.append(snapshot)
      }
    }

    await engine.sceneDidEnterBackground()
    await engine.sceneWillEnterForeground()

    #expect(await api.conversationCalls == ["probe-failed", "removed"])
    #expect(try await store.conversation(gatewayID: "gw", id: "probe-failed") != nil)
    #expect(
      try await store.conversation(gatewayID: "gw", id: "removed")?.summary.status == .deleted
    )
    #expect(await recorder.last?.connection == .online)
    collector.cancel()
    await engine.shutdown()
  }

  @Test("foreground transcript refresh isolates one active conversation failure")
  func foregroundTranscriptRefreshIsolatesFailure() async throws {
    let store = try PersistenceStore.inMemory()
    try await store.upsertConversations(
      [
        summary(
          id: "failed-running",
          title: "Failed running",
          status: .running,
          activeTurnID: "turn-failed"
        ),
        summary(
          id: "live-running",
          title: "Live running",
          status: .running,
          activeTurnID: "turn-live"
        ),
      ],
      gatewayID: "gw"
    )
    let api = FakeConversationSyncAPI()
    await api.enqueueAgents(.success([]))
    await api.enqueueConversationPage(
      .success(
        .init(
          items: [
            summary(
              id: "failed-running",
              title: "Failed running",
              revision: 2,
              status: .running,
              activeTurnID: "turn-failed"
            ),
            summary(
              id: "live-running",
              title: "Live running",
              revision: 2,
              status: .running,
              activeTurnID: "turn-live"
            ),
          ],
          nextCursor: nil
        )
      )
    )
    await api.enqueueMessages(
      conversationID: "failed-running",
      result: .failure(
        .server(
          MobileAPIError(
            code: "conversation_unavailable",
            error: "Conversation unavailable",
            retryable: true,
            details: nil
          ),
          status: 500
        )
      )
    )
    await api.enqueueMessages(
      conversationID: "live-running",
      result: .success(
        .init(
          items: [message(id: "live-message", conversationID: "live-running")],
          nextCursor: nil,
          throughSeq: 4
        )
      )
    )
    let engine = makeEngine(store: store, api: api)
    let stream = await engine.snapshots()
    var snapshots = stream.makeAsyncIterator()

    await engine.sceneDidEnterBackground()
    await engine.sceneWillEnterForeground()
    let snapshot = try #require(await snapshots.next())

    #expect(
      await api.messageListCalls.map(\.conversationID)
        == ["failed-running", "live-running"]
    )
    #expect(try await store.cursor(gatewayID: "gw", conversationID: "live-running") == 4)
    #expect(snapshot.connection == .online)
  }

  @Test(
    "foreground omitted-detail audit preserves authoritative gateway failures",
    arguments: [
      (GatewayError.unauthorized, GatewayConnectionState.repairRequired),
      (GatewayError.capabilityRequired, GatewayConnectionState.updateRequired),
      (GatewayError.updateRequired, GatewayConnectionState.updateRequired),
      (GatewayError.gatewayOffline, GatewayConnectionState.gatewayOffline),
      (
        GatewayError.rateLimited(retryAfter: .seconds(30)),
        GatewayConnectionState.rateLimited(retryAt: instant(130))
      ),
      (
        GatewayError.transport("detail transport failed"),
        GatewayConnectionState.reconnecting(attempt: 1, retryAt: instant(101))
      ),
    ]
  )
  func foregroundDetailAuditPreservesAuthoritativeFailure(
    failure: GatewayError,
    expected: GatewayConnectionState
  ) async throws {
    let store = try PersistenceStore.inMemory()
    try await store.upsertConversations(
      [summary(id: "omitted", title: "Omitted")],
      gatewayID: "gw"
    )
    let api = FakeConversationSyncAPI()
    await api.enqueueAgents(.success([]))
    await api.enqueueConversationPage(.success(.init(items: [], nextCursor: nil)))
    await api.enqueueConversation(id: "omitted", result: .failure(failure))
    let clock = SuspendedSleepClock(now: instant(100))
    let engine = makeEngine(store: store, api: api, clock: clock)
    let recorder = SnapshotRecorder()
    let collector = Task {
      for await snapshot in await engine.snapshots() {
        await recorder.append(snapshot)
      }
    }

    await engine.sceneDidEnterBackground()
    await engine.sceneWillEnterForeground()
    await eventually { await recorder.last?.connection == expected }
    await settleSyncWork()

    #expect(await recorder.last?.connection == expected)
    #expect(await recorder.connections.contains(.online) == false)
    #expect(await api.conversationCalls == ["omitted"])
    collector.cancel()
    await engine.shutdown()
  }

  @Test(
    "foreground transcript refresh preserves authoritative gateway failures",
    arguments: [
      (GatewayError.unauthorized, GatewayConnectionState.repairRequired),
      (GatewayError.capabilityRequired, GatewayConnectionState.updateRequired),
      (GatewayError.updateRequired, GatewayConnectionState.updateRequired),
      (GatewayError.gatewayOffline, GatewayConnectionState.gatewayOffline),
      (
        GatewayError.rateLimited(retryAfter: .seconds(30)),
        GatewayConnectionState.rateLimited(retryAt: instant(130))
      ),
      (
        GatewayError.transport("message transport failed"),
        GatewayConnectionState.reconnecting(attempt: 1, retryAt: instant(101))
      ),
    ]
  )
  func foregroundTranscriptPreservesAuthoritativeFailure(
    failure: GatewayError,
    expected: GatewayConnectionState
  ) async throws {
    let store = try PersistenceStore.inMemory()
    let running = summary(
      id: "running",
      title: "Running",
      status: .running,
      activeTurnID: "turn-running"
    )
    let api = FakeConversationSyncAPI()
    await api.enqueueAgents(.success([]))
    await api.enqueueConversationPage(.success(.init(items: [running], nextCursor: nil)))
    await api.enqueueMessages(conversationID: running.id, result: .failure(failure))
    let clock = SuspendedSleepClock(now: instant(100))
    let engine = makeEngine(store: store, api: api, clock: clock)
    let recorder = SnapshotRecorder()
    let collector = Task {
      for await snapshot in await engine.snapshots() {
        await recorder.append(snapshot)
      }
    }

    await engine.sceneDidEnterBackground()
    await engine.sceneWillEnterForeground()
    await eventually { await recorder.last?.connection == expected }
    await settleSyncWork()

    #expect(await recorder.last?.connection == expected)
    #expect(await recorder.connections.contains(.online) == false)
    #expect(await api.messageListCalls.map(\.conversationID) == [running.id])
    collector.cancel()
    await engine.shutdown()
  }

  @Test(
    "foreground reconciliation preserves direct URL transport failures",
    arguments: [ForegroundURLFailurePoint.omittedDetail, .activeTranscript]
  )
  func foregroundPreservesURLFailure(point: ForegroundURLFailurePoint) async throws {
    let store = try PersistenceStore.inMemory()
    if point == .omittedDetail {
      try await store.upsertConversations(
        [summary(id: "omitted", title: "Omitted")],
        gatewayID: "gw"
      )
    }
    let activeConversation = summary(
      id: "running",
      title: "Running",
      status: .running,
      activeTurnID: "turn-running"
    )
    let api = ForegroundURLFailureAPI(
      point: point,
      activeConversation: activeConversation
    )
    let clock = SuspendedSleepClock(now: instant(100))
    let engine = ConversationSyncEngine(
      gatewayID: "gw",
      store: store,
      api: api,
      invalidations: FakeInvalidationSource(),
      chat: FakeConversationChat(),
      reachability: FakeReachability(),
      clock: clock
    )
    let recorder = SnapshotRecorder()
    let collector = Task {
      for await snapshot in await engine.snapshots() {
        await recorder.append(snapshot)
      }
    }
    let expected = GatewayConnectionState.reconnecting(attempt: 1, retryAt: instant(101))

    await engine.sceneDidEnterBackground()
    await engine.sceneWillEnterForeground()
    await eventually { await recorder.last?.connection == expected }
    await settleSyncWork()

    #expect(await recorder.last?.connection == expected)
    #expect(await recorder.connections.contains(.online) == false)
    collector.cancel()
    await engine.shutdown()
  }

  @Test("foreground restarts invalidations before canonical reset completes")
  func foregroundStartsInvalidationsBeforeResetCompletes() async throws {
    let store = try PersistenceStore.inMemory()
    let api = FakeConversationSyncAPI()
    let invalidations = RestartableInvalidationSource()
    await api.enqueueAgents(.success([]))
    await api.enqueueConversationPage(.success(.init(items: [], nextCursor: nil)))
    let engine = ConversationSyncEngine(
      gatewayID: "gw",
      store: store,
      api: api,
      invalidations: invalidations,
      chat: FakeConversationChat(),
      reachability: FakeReachability(),
      clock: TestAppClock(now: instant(100))
    )
    await engine.bootstrap()
    await eventually { await invalidations.subscriptionCount == 1 }
    await engine.sceneDidEnterBackground()
    await api.enqueueAgents(.success([]))
    await api.enqueueConversationPage(.failure(.unauthorized))

    await engine.sceneWillEnterForeground()

    await eventually { await invalidations.subscriptionCount == 2 }
    await engine.shutdown()
  }

  @Test("foreground canonical reconciliation restarts SSE invalidations without owning chat")
  func foregroundRestartsInvalidations() async throws {
    let store = try PersistenceStore.inMemory()
    let api = FakeConversationSyncAPI()
    let invalidations = RestartableInvalidationSource()
    let chat = FakeConversationChat()
    await api.enqueueAgents(.success([]))
    await api.enqueueConversationPage(
      .success(
        .init(
          items: [
            summary(
              id: "c",
              title: "Initial",
              status: .running,
              activeTurnID: "turn-1"
            )
          ],
          nextCursor: nil
        )
      )
    )
    let engine = ConversationSyncEngine(
      gatewayID: "gw",
      store: store,
      api: api,
      invalidations: invalidations,
      chat: chat,
      reachability: FakeReachability(),
      clock: TestAppClock(now: instant(100))
    )
    await engine.bootstrap()
    await eventually { await invalidations.subscriptionCount == 1 }
    await engine.sceneDidEnterBackground()

    await api.enqueueAgents(.success([]))
    await api.enqueueConversation(
      id: "c",
      result: .success(
        summary(
          id: "c",
          title: "Foreground",
          revision: 2,
          status: .running,
          activeTurnID: "turn-1"
        )
      )
    )
    await api.enqueueMessages(
      conversationID: "c",
      result: .success(
        .init(
          items: [message(id: "foreground-message")],
          nextCursor: nil,
          throughSeq: 2
        )
      )
    )

    await engine.sceneWillEnterForeground()
    await eventually { await invalidations.subscriptionCount == 2 }

    await api.enqueueConversation(
      id: "c",
      result: .success(
        summary(
          id: "c",
          title: "Invalidated",
          revision: 3,
          status: .running,
          activeTurnID: "turn-1"
        )
      )
    )
    await invalidations.yield(.conversationChanged(conversationID: "c", revision: 3))
    await eventually {
      let cached = try? await store.conversation(gatewayID: "gw", id: "c")
      return cached?.summary.revision == 3
    }

    #expect(await api.conversationCalls == ["c", "c"])
    #expect(await chat.calls == [.suspend])
    await engine.shutdown()
  }

  @Test("offline reachability publishes cached state but cannot override authenticated success")
  func offlineReachability() async throws {
    let store = try PersistenceStore.inMemory()
    try await store.upsertConversations(
      [summary(id: "cached", title: "Cached")],
      gatewayID: "gw"
    )
    let api = FakeConversationSyncAPI()
    let gate = TestGate()
    await api.holdConversationPages(on: gate)
    await api.enqueueConversationPage(
      .success(.init(items: [summary(id: "online", title: "Online")], nextCursor: nil))
    )
    let reachability = FakeReachability()
    let engine = makeEngine(store: store, api: api, reachability: reachability)
    let stream = await engine.snapshots()
    var snapshots = stream.makeAsyncIterator()
    let bootstrap = Task { await engine.bootstrap() }
    _ = await snapshots.next()

    reachability.yield(.unsatisfied)
    let offline = try #require(await snapshots.next())
    #expect(offline.connection == .offline)
    #expect(offline.conversations.map(\.id) == ["cached"])
    #expect(offline.mutationsAllowed == false)
    let blocked = await syncGatewayError {
      _ = try await engine.createConversation(
        .init(
          agentId: "agent-1",
          requestId: "offline-request",
          title: nil,
          owningIssueId: nil,
          projectId: nil
        )
      )
    }
    #expect(blocked == .transport("Mutations require an online gateway"))
    #expect(await api.createRequests.isEmpty)

    await gate.release()
    await bootstrap.value
    let online = try #require(await snapshots.next())
    #expect(online.connection == .online)
    #expect(online.conversations.map(\.id) == ["online"])
  }

  @Test("a public refresh cannot commit after shutdown while its request is suspended")
  func shutdownInvalidatesSuspendedPublicRefresh() async throws {
    let store = try PersistenceStore.inMemory()
    let api = FakeConversationSyncAPI()
    let gate = TestGate()
    await api.enqueueConversationPage(
      .success(.init(items: [summary(id: "late", title: "Late")], nextCursor: nil)),
      waitingOn: gate
    )
    let chat = FakeConversationChat()
    let engine = makeEngine(store: store, api: api, chat: chat)
    let refresh = Task { await engine.refreshConversations(reset: true) }
    await gate.waitUntilWaiting()

    await engine.shutdown()
    await gate.release()
    await refresh.value

    #expect(try await store.conversation(gatewayID: "gw", id: "late") == nil)
    #expect(await chat.calls == [.shutdown])
  }

  @Test("shutdown during the successful-sync clock read cannot write stale metadata")
  func shutdownInvalidatesSuccessfulSyncClockRead() async throws {
    let store = try PersistenceStore.inMemory()
    let api = FakeConversationSyncAPI()
    let nowGate = TestGate()
    let clock = GatedNowClock(value: instant(100), gate: nowGate)
    let engine = makeEngine(store: store, api: api, clock: clock)
    let refresh = Task { await engine.refreshConversations(reset: true) }
    await nowGate.waitUntilWaiting()

    await engine.shutdown()
    await nowGate.release()
    await refresh.value

    #expect(try await store.profile(gatewayID: "gw")?.profile.lastSuccessfulSyncAt == nil)
  }

  @Test("shutdown waits for owned invalidation work and rejects its late result")
  func shutdownQuiescesOwnedInvalidation() async throws {
    let store = try PersistenceStore.inMemory()
    let api = FakeConversationSyncAPI()
    let invalidations = FakeInvalidationSource()
    await api.enqueueConversationPage(
      .success(.init(items: [summary(id: "c", title: "Initial")], nextCursor: nil))
    )
    let pointGate = TestGate()
    await api.enqueueConversation(
      id: "c",
      result: .success(summary(id: "c", title: "Late", revision: 2)),
      waitingOn: pointGate
    )
    let engine = makeEngine(store: store, api: api, invalidations: invalidations)
    await engine.bootstrap()
    invalidations.yield(.conversationChanged(conversationID: "c", revision: 2))
    await pointGate.waitUntilWaiting()

    let completion = CompletionProbe()
    let shutdown = Task {
      await engine.shutdown()
      await completion.finish()
    }
    await settleSyncWork()

    #expect(await completion.isFinished == false)
    await pointGate.release()
    await shutdown.value
    #expect(try await store.conversation(gatewayID: "gw", id: "c")?.summary.revision == 1)
  }

  @Test("a stale background transition cannot suspend chat after shutdown")
  func staleBackgroundCannotSuspendAfterShutdown() async throws {
    let store = try PersistenceStore.inMemory()
    let api = FakeConversationSyncAPI()
    let invalidations = FakeInvalidationSource()
    let chat = FakeConversationChat()
    await api.enqueueConversationPage(
      .success(.init(items: [summary(id: "c", title: "Initial")], nextCursor: nil))
    )
    let pointGate = TestGate()
    await api.enqueueConversation(
      id: "c",
      result: .success(summary(id: "c", title: "Late", revision: 2)),
      waitingOn: pointGate
    )
    let engine = makeEngine(store: store, api: api, invalidations: invalidations, chat: chat)
    await engine.bootstrap()
    invalidations.yield(.conversationChanged(conversationID: "c", revision: 2))
    await pointGate.waitUntilWaiting()
    let background = Task { await engine.sceneDidEnterBackground() }
    await settleSyncWork()

    await engine.shutdown()
    await pointGate.release()
    await background.value

    #expect(await chat.calls == [.shutdown])
  }

  @Test("shutdown rejects new mutations and later background callbacks without side effects")
  func shutdownRejectsNewPublicWork() async throws {
    let store = try PersistenceStore.inMemory()
    let api = FakeConversationSyncAPI()
    let chat = FakeConversationChat()
    let engine = makeEngine(store: store, api: api, chat: chat)
    await engine.bootstrap()
    await engine.shutdown()

    let createError = await syncGatewayError {
      _ = try await engine.createConversation(
        .init(
          agentId: "agent-1",
          requestId: "after-shutdown",
          title: nil,
          owningIssueId: nil,
          projectId: nil
        )
      )
    }
    await engine.sceneDidEnterBackground()

    #expect(createError == .transport("Mutations require an online gateway"))
    #expect(await api.createRequests.isEmpty)
    #expect(await chat.calls == [.shutdown])
  }

  @Test(
    "gateway failures map to stable repair states",
    arguments: [
      (GatewayError.unauthorized, GatewayConnectionState.repairRequired),
      (
        GatewayError.rateLimited(retryAfter: .seconds(30)),
        GatewayConnectionState.rateLimited(retryAt: instant(130))
      ),
      (GatewayError.gatewayOffline, GatewayConnectionState.gatewayOffline),
      (GatewayError.updateRequired, GatewayConnectionState.updateRequired),
    ]
  )
  func stableErrorStates(error: GatewayError, expected: GatewayConnectionState) async throws {
    let store = try PersistenceStore.inMemory()
    let api = FakeConversationSyncAPI()
    await api.enqueueConversationPage(.failure(error))
    let engine = makeEngine(
      store: store,
      api: api,
      clock: TestAppClock(now: instant(100))
    )
    let stream = await engine.snapshots()
    var snapshots = stream.makeAsyncIterator()

    await engine.bootstrap()
    _ = await snapshots.next()
    let failure = try #require(await snapshots.next())

    #expect(failure.connection == expected)
    #expect(failure.mutationsAllowed == false)
  }

  @Test(
    "late reachability hints cannot overwrite authoritative gateway failures",
    arguments: [
      (GatewayError.unauthorized, GatewayConnectionState.repairRequired),
      (
        GatewayError.rateLimited(retryAfter: .seconds(30)),
        GatewayConnectionState.rateLimited(retryAt: instant(130))
      ),
      (GatewayError.gatewayOffline, GatewayConnectionState.gatewayOffline),
      (GatewayError.updateRequired, GatewayConnectionState.updateRequired),
    ]
  )
  func reachabilityPreservesAuthoritativeFailure(
    error: GatewayError,
    expected: GatewayConnectionState
  ) async throws {
    let store = try PersistenceStore.inMemory()
    let api = FakeConversationSyncAPI()
    let reachability = FakeReachability()
    await api.enqueueConversationPage(.failure(error))
    let engine = makeEngine(store: store, api: api, reachability: reachability)
    let recorder = SnapshotRecorder()
    let collector = Task {
      for await snapshot in await engine.snapshots() {
        await recorder.append(snapshot)
      }
    }
    await engine.bootstrap()
    await eventually { await recorder.count >= 2 }

    reachability.yield(.unsatisfied)
    reachability.yield(.satisfied)
    await settleSyncWork()

    #expect(await recorder.last?.connection == expected)
    collector.cancel()
    await engine.shutdown()
  }

  @Test("ambiguous create retries the idempotent request with the exact request ID")
  func ambiguousCreateReusesRequestID() async throws {
    let store = try PersistenceStore.inMemory()
    let api = FakeConversationSyncAPI()
    let request = CreateConversationRequest(
      agentId: "agent-1",
      requestId: "request-stable",
      title: "Create once",
      owningIssueId: nil,
      projectId: nil
    )
    let canonical = summary(id: "created", title: "Create once")
    await api.enqueueCreate(
      .failure(.mutationOutcomeUnknown(resourceID: nil, requestID: "request-stable"))
    )
    await api.enqueueCreate(.success(canonical))
    let engine = makeEngine(store: store, api: api)
    await engine.bootstrap()

    let created = try await engine.createConversation(request)

    #expect(created == canonical)
    #expect(await api.createRequests == [request, request])
    #expect(await api.agentListCallCount == 2)
    #expect(try await store.conversation(gatewayID: "gw", id: "created")?.summary == canonical)
  }

  @Test(
    "create failures map connection state before rethrowing the exact gateway error",
    arguments: [
      (GatewayError.unauthorized, GatewayConnectionState.repairRequired),
      (
        GatewayError.rateLimited(retryAfter: .seconds(30)),
        GatewayConnectionState.rateLimited(retryAt: instant(130))
      ),
      (GatewayError.gatewayOffline, GatewayConnectionState.gatewayOffline),
      (GatewayError.updateRequired, GatewayConnectionState.updateRequired),
    ]
  )
  func createFailureMapsAndRethrows(
    error: GatewayError,
    expected: GatewayConnectionState
  ) async throws {
    let store = try PersistenceStore.inMemory()
    let api = FakeConversationSyncAPI()
    await api.enqueueCreate(.failure(error))
    let engine = makeEngine(store: store, api: api)
    let recorder = SnapshotRecorder()
    let collector = Task {
      for await snapshot in await engine.snapshots() {
        await recorder.append(snapshot)
      }
    }
    await engine.bootstrap()
    await eventually { await recorder.count >= 2 }

    let thrown = await syncGatewayError {
      _ = try await engine.createConversation(
        .init(
          agentId: "agent-1",
          requestId: "request-stable",
          title: "Create",
          owningIssueId: nil,
          projectId: nil
        )
      )
    }
    await settleSyncWork()

    #expect(thrown == error)
    #expect(await recorder.last?.connection == expected)
    collector.cancel()
    await engine.shutdown()
  }

  @Test("list omission point-audits tombstones and 404s without inferring deletion")
  func omissionPointAudit() async throws {
    let store = try PersistenceStore.inMemory()
    try await store.upsertConversations(
      [
        summary(id: "kept", title: "Kept"),
        summary(id: "deleted", title: "Delete me"),
        summary(id: "stale", title: "Stale"),
      ],
      gatewayID: "gw"
    )
    try await store.mergeMessages(
      [message(id: "stale-message", conversationID: "stale")],
      gatewayID: "gw",
      conversationID: "stale"
    )
    try await store.saveDraft(
      .init(text: "stale", attachments: [], updatedAt: instant(3)),
      gatewayID: "gw",
      conversationID: "stale"
    )
    try await store.advanceCursor(gatewayID: "gw", conversationID: "stale", to: 3)
    try await store.upsertConversations(
      [summary(id: "stale", title: "Other gateway")],
      gatewayID: "other"
    )
    let api = FakeConversationSyncAPI()
    await api.enqueueConversationPage(
      .success(
        .init(items: [summary(id: "kept", title: "Still kept", revision: 2)], nextCursor: nil))
    )
    await api.enqueueConversation(
      id: "deleted",
      result: .success(
        summary(
          id: "deleted",
          title: "Deleted",
          revision: 2,
          status: .deleted,
          deletedAt: instant(4)
        )
      )
    )
    await api.enqueueConversation(id: "stale", result: .failure(.notFound))
    let engine = makeEngine(store: store, api: api)

    await engine.refreshConversations(reset: true)

    #expect(await api.conversationCalls.sorted() == ["deleted", "stale"])
    #expect(
      try await store.conversation(gatewayID: "gw", id: "deleted")?.summary.status == .deleted)
    #expect(
      try await store.conversation(gatewayID: "gw", id: "stale")?.summary.status == .deleted
    )
    #expect(try await store.messages(gatewayID: "gw", conversationID: "stale").isEmpty)
    #expect(try await store.draft(gatewayID: "gw", conversationID: "stale") == nil)
    #expect(try await store.cursor(gatewayID: "gw", conversationID: "stale") == 0)
    #expect(try await store.conversation(gatewayID: "other", id: "stale") != nil)
  }

  @Test("reachability maps path status and cancels its monitor with the stream")
  func networkReachabilityLifecycle() async {
    #expect(NetworkReachability.status(for: .satisfied) == .satisfied)
    #expect(NetworkReachability.status(for: .unsatisfied) == .unsatisfied)
    #expect(NetworkReachability.status(for: .requiresConnection) == .requiresConnection)

    let monitor = FakeNetworkPathMonitor()
    let reachability = NetworkReachability(
      monitor: monitor,
      queue: DispatchQueue(label: "app.dash.tests.reachability")
    )
    let stream = reachability.statuses()
    let consumer = Task {
      var iterator = stream.makeAsyncIterator()
      _ = await iterator.next()
    }
    await eventually { monitor.startCount == 1 }

    consumer.cancel()
    await eventually { monitor.cancelCount == 1 }

    #expect(monitor.startCount == 1)
    #expect(monitor.cancelCount == 1)
  }

  private func expectDeletionResetsMessageSyncState(
    deletion: FakeSyncResult<ConversationSummaryDTO>,
    revived: ConversationSummaryDTO
  ) async throws {
    let store = try PersistenceStore.inMemory()
    try await store.upsertConversations(
      [summary(id: "c", title: "Current", revision: 1)],
      gatewayID: "gw"
    )
    let api = FakeConversationSyncAPI()
    await api.enqueueMessages(
      conversationID: "c",
      result: .success(
        .init(items: [message(id: "initial")], nextCursor: "stale-before", throughSeq: 4)
      )
    )
    let staleLoadGate = TestGate()
    await api.enqueueMessages(
      conversationID: "c",
      result: .success(
        .init(
          items: [message(id: "stale-after-delete")],
          nextCursor: "still-stale",
          throughSeq: 5
        )
      ),
      waitingOn: staleLoadGate
    )
    await api.enqueueMessages(
      conversationID: "c",
      result: .success(
        .init(items: [message(id: "revived-message")], nextCursor: nil, throughSeq: 1)
      )
    )
    await api.enqueueConversation(id: "c", result: deletion)
    await api.enqueueConversation(id: "c", result: .success(revived))
    let engine = makeEngine(store: store, api: api)

    await engine.loadMessages(conversationID: "c", reset: true)
    let staleLoad = Task { await engine.loadOlderMessages(conversationID: "c") }
    await staleLoadGate.waitUntilWaiting()

    await engine.refreshConversation(id: "c")
    #expect(try await store.conversation(gatewayID: "gw", id: "c")?.summary.status == .deleted)
    #expect(try await store.cursor(gatewayID: "gw", conversationID: "c") == 0)
    #expect(try await store.messages(gatewayID: "gw", conversationID: "c").isEmpty)

    await engine.refreshConversation(id: "c")
    #expect(try await store.conversation(gatewayID: "gw", id: "c")?.summary == revived)

    await staleLoadGate.release()
    await staleLoad.value
    #expect(try await store.cursor(gatewayID: "gw", conversationID: "c") == 0)
    #expect(try await store.messages(gatewayID: "gw", conversationID: "c").isEmpty)

    await engine.loadOlderMessages(conversationID: "c")
    await engine.consumeLiveFrame(
      .event(
        id: "turn-revived",
        conversationId: "c",
        seq: 1,
        event: .textDelta(text: "revived")
      ),
      agentID: "agent-1"
    )

    #expect(
      await api.messageListCalls
        == [
          .init(conversationID: "c", limit: 50, before: nil),
          .init(conversationID: "c", limit: 50, before: "stale-before"),
          .init(conversationID: "c", limit: 50, before: nil),
        ]
    )
    #expect(await api.replayCalls.isEmpty)
    #expect(
      try await store.messages(gatewayID: "gw", conversationID: "c").map(\.id)
        == ["revived-message"]
    )
    #expect(try await store.cursor(gatewayID: "gw", conversationID: "c") == 1)
    await engine.shutdown()
  }

  private func makeEngine(
    store: PersistenceStore,
    api: FakeConversationSyncAPI,
    invalidations: FakeInvalidationSource = FakeInvalidationSource(),
    chat: FakeConversationChat = FakeConversationChat(),
    reachability: FakeReachability = FakeReachability(),
    clock: any AppClock = TestAppClock(now: instant(100)),
    pageSize: Int = 50
  ) -> ConversationSyncEngine {
    ConversationSyncEngine(
      gatewayID: "gw",
      store: store,
      api: api,
      invalidations: invalidations,
      chat: chat,
      reachability: reachability,
      clock: clock,
      pageSize: pageSize
    )
  }

  private func summary(
    id: String,
    title: String,
    revision: Int = 1,
    status: ConversationStatus = .idle,
    activeTurnID: String? = nil,
    updatedAt: Date = instant(10),
    deletedAt: Date? = nil
  ) -> ConversationSummaryDTO {
    ConversationSummaryDTO(
      id: id,
      agentId: "agent-1",
      agentName: "Agent One",
      title: title,
      revision: revision,
      status: status,
      activeTurnId: activeTurnID,
      owningIssueId: nil,
      projectId: nil,
      lastSeq: revision,
      lastMessagePreview: title,
      createdAt: instant(0),
      updatedAt: updatedAt,
      deletedAt: deletedAt
    )
  }

  private func message(
    id: String,
    conversationID: String = "c",
    turnID: String = "turn-1",
    status: MessageStatus = .streaming
  ) -> ConversationMessageDTO {
    ConversationMessageDTO(
      id: id,
      conversationId: conversationID,
      turnId: turnID,
      ordinal: 1,
      role: .assistant,
      status: status,
      content: .assistant(events: [.textDelta(text: id)]),
      createdAt: instant(1),
      updatedAt: instant(2)
    )
  }

  private func replayEntry(seq: Int, payload: ReplayPayload) -> ReplayEntryDTO {
    ReplayEntryDTO(
      seq: seq,
      msgId: "turn-1",
      agentId: "agent-1",
      conversationId: "c",
      timestamp: instant(seq),
      payload: payload
    )
  }

  private func agent(id: String, name: String) -> RegisteredAgentDTO {
    RegisteredAgentDTO(
      id: id,
      name: name,
      config: AgentConfigDTO(
        name: name,
        model: "provider/model",
        systemPrompt: "System prompt for \(name)",
        fallbackModels: nil,
        tools: nil,
        skills: nil,
        workspace: nil,
        maxTokens: nil,
        mcpServers: nil,
        swarm: nil,
        plugins: nil,
        providers: nil
      ),
      status: .registered,
      registeredAt: instant(0)
    )
  }

}

private actor RestartableInvalidationSource: GatewayInvalidationStreaming {
  private var continuation: AsyncThrowingStream<GatewayInvalidationEvent, Error>.Continuation?
  private(set) var subscriptionCount = 0

  func eventStream() async -> AsyncThrowingStream<GatewayInvalidationEvent, Error> {
    let pair = AsyncThrowingStream<GatewayInvalidationEvent, Error>.makeStream()
    continuation = pair.continuation
    subscriptionCount += 1
    return pair.stream
  }

  func yield(_ event: GatewayInvalidationEvent) {
    continuation?.yield(event)
  }
}

private actor SnapshotRecorder {
  private var snapshots: [SyncSnapshot] = []

  var count: Int { snapshots.count }
  var last: SyncSnapshot? { snapshots.last }
  var connections: [GatewayConnectionState] { snapshots.map(\.connection) }

  func append(_ snapshot: SyncSnapshot) {
    snapshots.append(snapshot)
  }
}

enum ForegroundURLFailurePoint: Equatable, Sendable {
  case omittedDetail
  case activeTranscript
}

private struct ForegroundURLFailureAPI: ConversationSyncAPI, Sendable {
  let point: ForegroundURLFailurePoint
  let activeConversation: ConversationSummaryDTO

  func listAgents() async throws -> [RegisteredAgentDTO] { [] }

  func conversations(
    agentId _: String?,
    limit _: Int,
    cursor _: String?
  ) async throws -> ConversationPageDTO {
    ConversationPageDTO(
      items: point == .activeTranscript ? [activeConversation] : [],
      nextCursor: nil
    )
  }

  func conversation(id _: String) async throws -> ConversationSummaryDTO {
    throw URLError(.networkConnectionLost)
  }

  func messages(
    conversationID _: String,
    limit _: Int,
    before _: String?
  ) async throws -> ConversationMessagePageDTO {
    throw URLError(.networkConnectionLost)
  }

  func replay(
    agentID _: String,
    conversationID _: String,
    sinceSeq _: Int
  ) async throws -> ReplayPageDTO {
    throw GatewayError.updateRequired
  }

  func createConversation(
    _ request: CreateConversationRequest
  ) async throws -> ConversationSummaryDTO {
    _ = request
    throw GatewayError.updateRequired
  }
}

private actor SuspendedSleepClock: AppClock {
  private let current: Date

  init(now: Date) {
    current = now
  }

  func now() async -> Date { current }

  func sleep(for _: Duration) async throws {
    try await Task.sleep(for: .seconds(3_600))
  }
}

private actor CompletionProbe {
  private(set) var isFinished = false

  func finish() {
    isFinished = true
  }
}

private actor GatedNowClock: AppClock {
  private let value: Date
  private let gate: TestGate

  init(value: Date, gate: TestGate) {
    self.value = value
    self.gate = gate
  }

  func now() async -> Date {
    await gate.wait()
    return value
  }

  func sleep(for _: Duration) async throws {}
}

/// Polls `condition` for up to ~5 s. Time-based (1 ms sleeps), not
/// yield-based: on a slow CI runner (iPad job, 2026-09-04) 5,000 bare
/// `Task.yield()`s ran out before the engine's real async work completed and
/// "transport reconnect retries the full authoritative bootstrap" flaked.
private func eventually(
  _ condition: @escaping @Sendable () async -> Bool,
  attempts: Int = 5_000
) async {
  for _ in 0..<attempts {
    if await condition() { return }
    try? await Task.sleep(for: .milliseconds(1))
  }
  Issue.record("Condition did not become true")
}

private func settleSyncWork() async {
  for _ in 0..<1_000 {
    await Task.yield()
  }
}

private func instant(_ seconds: Int) -> Date {
  Date(timeIntervalSince1970: TimeInterval(seconds))
}

private func syncGatewayError(
  _ operation: () async throws -> Void
) async -> GatewayError? {
  do {
    try await operation()
    return nil
  } catch let error as GatewayError {
    return error
  } catch {
    Issue.record("Unexpected sync error: \(error)")
    return nil
  }
}
