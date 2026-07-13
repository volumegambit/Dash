import Foundation
import Testing

@testable import Dash

@Suite("Conversation list feature")
@MainActor
struct ConversationListFeatureTests {
  @Test("cached rows and agents publish before the online refresh finishes")
  func cachedFirstLoad() async {
    let cached = cachedConversation(summary(id: "cached", title: "Cached"))
    let cachedAgent = agent(id: "agent-cached", name: "Cached agent")
    let fresh = summary(id: "fresh", title: "Fresh")
    let freshAgent = agent(id: "agent-fresh", name: "Fresh agent")
    let pageGate = TestGate()
    let service = FakeConversationListService(
      cachedConversations: [cached],
      cachedAgents: [cachedAgent],
      pageGate: pageGate
    )
    await service.enqueueAgents(.success([freshAgent]))
    await service.enqueuePage(.success(ConversationPageDTO(items: [fresh], nextCursor: "next")))
    let feature = makeFeature(service: service)
    feature.consume(snapshot(connection: .online, conversations: []))

    let start = Task { await feature.start() }
    await pageGate.waitUntilWaiting()

    #expect(feature.conversations == [cached])
    #expect(feature.agents == [cachedAgent])
    #expect(feature.isRefreshing)
    #expect(feature.isAuthoritative == false)

    await pageGate.release()
    await start.value

    #expect(feature.conversations.map(\.summary) == [fresh])
    #expect(feature.agents == [freshAgent])
    #expect(feature.nextCursor == "next")
    #expect(feature.isAuthoritative)
  }

  @Test("new-conversation agent choices load from cache while offline")
  func cachedAgentChoicesLoadOffline() async {
    let cachedAgent = agent(id: "agent-cached", name: "Cached agent")
    let service = FakeConversationListService(cachedAgents: [cachedAgent])
    let feature = makeFeature(service: service)
    feature.consume(snapshot(connection: .offline, conversations: []))

    await feature.loadAgentChoices()

    #expect(feature.agents == [cachedAgent])
    #expect(await service.refreshAgentCallCount == 0)
  }

  @Test("an agent-choice refresh failure reports one gateway error")
  func agentChoiceRefreshReportsOnce() async {
    let service = FakeConversationListService()
    await service.enqueueAgents(.failure(.gatewayOffline))
    let recorder = GatewayErrorRecorder()
    let feature = makeFeature(service: service)
    feature.setGatewayErrorHandler { error in
      await recorder.record(error)
    }
    feature.consume(snapshot(connection: .online, conversations: []))

    await feature.loadAgentChoices()

    #expect(await recorder.values == [.gatewayOffline])
  }

  @Test("becoming online after cache load fetches the first canonical page")
  func onlineTransitionStartsCanonicalRefresh() async {
    let cached = cachedConversation(summary(id: "cached", title: "Cached"))
    let fresh = summary(id: "fresh", title: "Fresh")
    let service = FakeConversationListService(cachedConversations: [cached])
    await service.enqueuePage(
      .success(ConversationPageDTO(items: [fresh], nextCursor: "older"))
    )
    let feature = makeFeature(service: service)
    feature.consume(snapshot(connection: .connecting, conversations: []))
    await feature.start()

    #expect(feature.conversations == [cached])
    #expect(await service.pageCalls.isEmpty)

    feature.consume(snapshot(connection: .online, conversations: [cached]))
    for _ in 0..<100 {
      if await service.pageCalls.isEmpty == false, feature.isRefreshing == false { break }
      await Task.yield()
    }

    #expect(await service.pageCalls.count == 1)
    #expect(feature.conversations.map(\.id) == [fresh.id])
    #expect(feature.nextCursor == "older")
    #expect(feature.isAuthoritative)
  }

  @Test("refresh resets pagination and preserves gateway tie order")
  func refreshResetsPaginationAndPreservesOrder() async {
    let service = FakeConversationListService()
    let first = summary(id: "first", title: "First", updatedAt: 20)
    let second = summary(id: "second", title: "Second", updatedAt: 20)
    await service.enqueuePage(
      .success(ConversationPageDTO(items: [first, second], nextCursor: "older"))
    )
    await service.enqueuePage(
      .success(ConversationPageDTO(items: [second, first], nextCursor: "reset-cursor"))
    )
    let feature = makeFeature(service: service)
    feature.consume(snapshot(connection: .online, conversations: []))
    await feature.start()

    await feature.refresh()

    #expect(feature.conversations.map(\.id) == ["second", "first"])
    #expect(feature.nextCursor == "reset-cursor")
    #expect(await service.pageCalls.map(\.cursor) == [nil, nil])
  }

  @Test("agent filter is applied to cache and sent on refresh")
  func agentFilter() async {
    let one = summary(id: "one", agentID: "agent-1")
    let two = summary(id: "two", agentID: "agent-2")
    let service = FakeConversationListService(cachedConversations: [
      cachedConversation(one), cachedConversation(two),
    ])
    await service.enqueuePage(
      .success(ConversationPageDTO(items: [two], nextCursor: nil))
    )
    let feature = makeFeature(service: service)
    feature.consume(snapshot(connection: .offline, conversations: []))
    await feature.start()

    await feature.setAgentFilter("agent-2")

    #expect(feature.conversations.map(\.id) == ["two"])

    feature.consume(
      snapshot(
        connection: .online,
        conversations: [
          cachedConversation(one), cachedConversation(two),
        ]))
    await feature.refresh()

    #expect(await service.pageCalls.last?.agentID == "agent-2")
  }

  @Test("fifth-from-last pagination loads an opaque cursor once")
  func paginationLoadsCursorOnce() async {
    let firstPage = (0..<8).map { summary(id: "new-\($0)", updatedAt: 100 - $0) }
    let older = [summary(id: "older-1", updatedAt: 10), summary(id: "older-2", updatedAt: 9)]
    let service = FakeConversationListService()
    await service.enqueuePage(
      .success(ConversationPageDTO(items: firstPage, nextCursor: "opaque/+cursor=="))
    )
    await service.enqueuePage(
      .success(ConversationPageDTO(items: older, nextCursor: "opaque/+cursor=="))
    )
    let feature = makeFeature(service: service)
    feature.consume(snapshot(connection: .online, conversations: []))
    await feature.start()

    await feature.loadOlderIfNeeded(currentID: "new-3")
    await feature.loadOlderIfNeeded(currentID: "older-2")

    #expect(feature.conversations.map(\.id) == firstPage.map(\.id) + older.map(\.id))
    #expect(await service.pageCalls.map(\.cursor) == [nil, "opaque/+cursor=="])
  }

  @Test("ambiguous create reconciliation reuses exactly one request ID")
  func createRetainsRequestID() async {
    let canonical = summary(id: "created", agentID: "agent-1", title: "New conversation")
    let service = FakeConversationListService()
    await service.enqueueCreate(.failure(.mutationOutcomeUnknown(resourceID: nil, requestID: nil)))
    await service.enqueueReconcile(.success(canonical))
    let requestID = UUID(uuidString: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE")!
    let feature = makeFeature(service: service, requestID: { requestID })
    feature.consume(snapshot(connection: .online, conversations: []))

    await feature.create(agentID: "agent-1")

    let create = await service.createRequests
    let reconcile = await service.reconcileRequests
    #expect(create.count == 1)
    #expect(reconcile.count == 1)
    #expect(create[0].requestId == requestID.uuidString.lowercased())
    #expect(create[0].agentId == "agent-1")
    #expect(create[0].title == nil)
    #expect(create[0].owningIssueId == nil)
    #expect(create[0].projectId == nil)
    #expect(reconcile[0].requestId == create[0].requestId)
    #expect(feature.selectedID == canonical.id)
    #expect(feature.conversations.map(\.summary) == [canonical])
  }

  @Test("an unresolved create keeps its request ID for an explicit retry")
  func unresolvedCreateKeepsRequestID() async {
    let canonical = summary(id: "created", agentID: "agent-1")
    let service = FakeConversationListService()
    await service.enqueueCreate(.failure(.mutationOutcomeUnknown(resourceID: nil, requestID: nil)))
    await service.enqueueReconcile(
      .failure(.mutationOutcomeUnknown(resourceID: nil, requestID: nil))
    )
    await service.enqueueCreate(.success(canonical))
    let requestID = UUID(uuidString: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE")!
    let feature = makeFeature(service: service, requestID: { requestID })
    feature.consume(snapshot(connection: .online, conversations: []))

    await feature.create(agentID: "agent-1")
    #expect(feature.mutationError == .outcomeUnknown)

    await feature.create(agentID: "agent-1")

    #expect(
      await service.createRequests.map(\.requestId) == [
        requestID.uuidString.lowercased(), requestID.uuidString.lowercased(),
      ])
    #expect(feature.selectedID == canonical.id)
  }

  @Test("connection loss after create admission reconciles the retained request ID")
  func transportCreateFailureKeepsRequestID() async {
    let canonical = summary(id: "created", agentID: "agent-1")
    let service = FakeConversationListService()
    await service.enqueueCreate(.failure(.transport("connection lost")))
    await service.enqueueReconcile(.success(canonical))
    let requestID = UUID(uuidString: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE")!
    let feature = makeFeature(service: service, requestID: { requestID })
    feature.consume(snapshot(connection: .online, conversations: []))

    await feature.create(agentID: "agent-1")

    #expect(await service.createRequests.first?.requestId == requestID.uuidString.lowercased())
    #expect(await service.reconcileRequests.first?.requestId == requestID.uuidString.lowercased())
    #expect(feature.selectedID == canonical.id)
  }

  @Test("an unresolved create request survives feature reconstruction")
  func unresolvedCreateSurvivesReconstruction() async {
    let canonical = summary(id: "created", agentID: "agent-1")
    let service = FakeConversationListService()
    await service.enqueueCreate(.failure(.mutationOutcomeUnknown(resourceID: nil, requestID: nil)))
    await service.enqueueReconcile(
      .failure(.mutationOutcomeUnknown(resourceID: nil, requestID: nil))
    )
    await service.enqueueCreate(.success(canonical))
    let firstID = UUID(uuidString: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE")!
    let replacementID = UUID(uuidString: "11111111-2222-3333-4444-555555555555")!
    let first = makeFeature(service: service, requestID: { firstID })
    first.consume(snapshot(connection: .online, conversations: []))
    await first.create(agentID: canonical.agentId)

    let reconstructed = makeFeature(service: service, requestID: { replacementID })
    reconstructed.consume(snapshot(connection: .online, conversations: []))
    await reconstructed.create(agentID: canonical.agentId)

    #expect(
      await service.createRequests.map(\.requestId) == [
        firstID.uuidString.lowercased(), firstID.uuidString.lowercased(),
      ])
    #expect(reconstructed.selectedID == canonical.id)
  }

  @Test("rename conflict replaces canonical state and Retry uses its revision")
  func renameConflictAndRetry() async {
    let local = summary(id: "conversation", title: "Local", revision: 2)
    let current = summary(id: "conversation", title: "Remote", revision: 3)
    let renamed = summary(id: "conversation", title: "Mine", revision: 4)
    let service = FakeConversationListService(cachedConversations: [cachedConversation(local)])
    await service.enqueueRename(.failure(.revisionConflict(current: current)))
    await service.enqueueRename(.success(renamed))
    let feature = makeFeature(service: service)
    feature.consume(snapshot(connection: .online, conversations: [cachedConversation(local)]))
    await feature.start()

    await feature.rename(id: local.id, title: " Mine ")

    #expect(feature.conversations.first?.summary == current)
    #expect(feature.mutationError == .revisionConflict(current: current))

    await feature.retryConflict()

    #expect(feature.conversations.first?.summary == renamed)
    #expect(feature.mutationError == nil)
    #expect(await service.renameCalls.map(\.revision) == [2, 3])
    #expect(await service.renameCalls.map(\.title) == ["Mine", "Mine"])
  }

  @Test("confirmed delete waits for and applies a canonical tombstone")
  func confirmedDeleteAppliesTombstone() async {
    let local = summary(id: "conversation", title: "Delete me", revision: 4)
    let tombstone = summary(
      id: local.id,
      title: local.title,
      revision: 5,
      status: .deleted
    )
    let service = FakeConversationListService(cachedConversations: [cachedConversation(local)])
    await service.enqueueDelete(.success(tombstone))
    let feature = makeFeature(service: service)
    feature.consume(snapshot(connection: .online, conversations: [cachedConversation(local)]))
    await feature.start()

    await feature.delete(id: local.id, confirmed: false)
    #expect(feature.conversations.map(\.id) == [local.id])
    #expect(await service.deleteCalls.isEmpty)

    await feature.delete(id: local.id, confirmed: true)

    #expect(feature.conversations.isEmpty)
    #expect(await service.deleteCalls.map(\.revision) == [4])
  }

  @Test("a stale 404 removes the local row")
  func notFoundRemovesStaleRow() async {
    let local = summary(id: "stale", title: "Stale", revision: 2)
    let service = FakeConversationListService(cachedConversations: [cachedConversation(local)])
    await service.enqueueRename(.failure(.notFound))
    let feature = makeFeature(service: service)
    feature.consume(snapshot(connection: .online, conversations: [cachedConversation(local)]))
    await feature.start()

    await feature.rename(id: local.id, title: "Still stale")

    #expect(feature.conversations.isEmpty)
    #expect(await service.removedIDs == [local.id])
  }

  @Test("offline and local validation disable every mutation")
  func offlineDisablesMutations() async {
    let local = summary(id: "conversation", title: "Local", revision: 2)
    let service = FakeConversationListService(cachedConversations: [cachedConversation(local)])
    let feature = makeFeature(service: service)
    feature.consume(snapshot(connection: .offline, conversations: [cachedConversation(local)]))
    await feature.start()

    await feature.create(agentID: "agent-1")
    await feature.rename(id: local.id, title: "Renamed")
    await feature.delete(id: local.id, confirmed: true)

    #expect(feature.mutationError == .offline)
    #expect(await service.createRequests.isEmpty)
    #expect(await service.renameCalls.isEmpty)
    #expect(await service.deleteCalls.isEmpty)

    feature.consume(snapshot(connection: .online, conversations: [cachedConversation(local)]))
    await feature.rename(id: local.id, title: "  \n ")

    #expect(feature.mutationError == .invalidTitle)
    #expect(await service.renameCalls.isEmpty)
  }

  @Test("a late snapshot cannot roll back a newer mutation revision")
  func staleSnapshotDoesNotRollbackMutation() async {
    let local = summary(id: "conversation", title: "Local", revision: 2)
    let renamed = summary(id: "conversation", title: "Renamed", revision: 3)
    let service = FakeConversationListService(cachedConversations: [cachedConversation(local)])
    await service.enqueueRename(.success(renamed))
    let feature = makeFeature(service: service)
    feature.consume(snapshot(connection: .online, conversations: [cachedConversation(local)]))

    await feature.rename(id: local.id, title: renamed.title)
    feature.consume(snapshot(connection: .online, conversations: [cachedConversation(local)]))

    #expect(feature.conversations.first?.summary == renamed)
  }

  @Test("refresh supersedes an older-page response already in flight")
  func refreshSupersedesInFlightPagination() async {
    let firstPage = (0..<8).map { summary(id: "first-\($0)", updatedAt: 100 - $0) }
    let staleOlder = [summary(id: "stale-older", updatedAt: 1)]
    let refreshed = [summary(id: "refreshed", updatedAt: 200)]
    let olderGate = TestGate()
    let service = FakeConversationListService()
    await service.enqueuePage(
      .success(ConversationPageDTO(items: firstPage, nextCursor: "older"))
    )
    await service.enqueuePage(
      .success(ConversationPageDTO(items: staleOlder, nextCursor: nil)),
      gate: olderGate
    )
    await service.enqueuePage(
      .success(ConversationPageDTO(items: refreshed, nextCursor: nil))
    )
    let feature = makeFeature(service: service)
    feature.consume(snapshot(connection: .online, conversations: []))
    await feature.start()

    let older = Task { await feature.loadOlderIfNeeded(currentID: "first-3") }
    await olderGate.waitUntilWaiting()
    await feature.refresh()
    await olderGate.release()
    await older.value

    #expect(feature.conversations.map(\.id) == ["refreshed"])
    #expect(feature.nextCursor == nil)
  }

  @Test("a stale snapshot cannot resurrect a canonical tombstone")
  func staleSnapshotDoesNotResurrectDeletedRow() async {
    let local = summary(id: "deleted", title: "Delete me", revision: 2)
    let tombstone = summary(
      id: local.id,
      title: local.title,
      revision: 3,
      status: .deleted
    )
    let service = FakeConversationListService(cachedConversations: [cachedConversation(local)])
    await service.enqueueDelete(.success(tombstone))
    let feature = makeFeature(service: service)
    feature.consume(snapshot(connection: .online, conversations: [cachedConversation(local)]))

    await feature.delete(id: local.id, confirmed: true)
    feature.consume(snapshot(connection: .online, conversations: [cachedConversation(local)]))

    #expect(feature.conversations.isEmpty)
  }

  @Test("a late reset refresh cannot roll back a completed rename")
  func renameSupersedesInFlightRefresh() async {
    let local = summary(id: "conversation", title: "Local", revision: 2)
    let renamed = summary(id: local.id, title: "Renamed", revision: 3)
    let refreshGate = TestGate()
    let service = FakeConversationListService(cachedConversations: [cachedConversation(local)])
    await service.enqueuePage(
      .success(ConversationPageDTO(items: [local], nextCursor: nil)),
      gate: refreshGate
    )
    await service.enqueueRename(.success(renamed))
    let feature = makeFeature(service: service)
    feature.consume(snapshot(connection: .online, conversations: [cachedConversation(local)]))

    let refresh = Task { await feature.refresh() }
    await refreshGate.waitUntilWaiting()
    await feature.rename(id: local.id, title: renamed.title)
    await refreshGate.release()
    await refresh.value

    #expect(feature.conversations.first?.summary == renamed)
  }

  @Test("filter change queues a first page and discards the previous opaque cursor")
  func filterChangeQueuesFreshFirstPage() async {
    let one = summary(id: "one", agentID: "agent-1")
    let two = summary(id: "two", agentID: "agent-2")
    let refreshGate = TestGate()
    let service = FakeConversationListService()
    await service.enqueuePage(
      .success(ConversationPageDTO(items: [one, two], nextCursor: "old-cursor"))
    )
    await service.enqueuePage(
      .success(ConversationPageDTO(items: [one, two], nextCursor: "stale-cursor")),
      gate: refreshGate
    )
    await service.enqueuePage(
      .success(ConversationPageDTO(items: [two], nextCursor: "agent-2-cursor"))
    )
    let feature = makeFeature(service: service)
    feature.consume(snapshot(connection: .online, conversations: []))
    await feature.start()

    let refresh = Task { await feature.refresh() }
    await refreshGate.waitUntilWaiting()
    await feature.setAgentFilter("agent-2")
    await refreshGate.release()
    await refresh.value

    #expect(await service.pageCalls.map(\.agentID) == [nil, nil, "agent-2"])
    #expect(await service.pageCalls.map(\.cursor) == [nil, nil, nil])
    #expect(feature.conversations.map(\.id) == [two.id])
    #expect(feature.nextCursor == "agent-2-cursor")
  }

  @Test("an online snapshot during refresh queues a fresh canonical first page")
  func snapshotDuringRefreshQueuesFreshFirstPage() async {
    let initial = summary(id: "initial", title: "Initial", revision: 1)
    let snapshotValue = summary(id: "snapshot", title: "Snapshot", revision: 2)
    let stale = summary(id: "stale", title: "Stale", revision: 1)
    let canonical = summary(id: "canonical", title: "Canonical", revision: 3)
    let refreshGate = TestGate()
    let service = FakeConversationListService()
    await service.enqueuePage(
      .success(ConversationPageDTO(items: [initial], nextCursor: "initial-cursor"))
    )
    await service.enqueuePage(
      .success(ConversationPageDTO(items: [stale], nextCursor: "stale-cursor")),
      gate: refreshGate
    )
    await service.enqueuePage(
      .success(ConversationPageDTO(items: [canonical], nextCursor: "canonical-cursor"))
    )
    let feature = makeFeature(service: service)
    feature.consume(snapshot(connection: .online, conversations: []))
    await feature.start()

    let refresh = Task { await feature.refresh() }
    await refreshGate.waitUntilWaiting()
    feature.consume(
      snapshot(
        connection: .online,
        conversations: [cachedConversation(snapshotValue)]
      )
    )
    await refreshGate.release()
    await refresh.value

    #expect(await service.pageCalls.map(\.cursor) == [nil, nil, nil])
    #expect(feature.conversations.map(\.id) == [canonical.id])
    #expect(feature.nextCursor == "canonical-cursor")
  }

  @Test("rename resolving to a tombstone suppresses stale rows without hard removal")
  func renameTombstoneRemainsSuppressed() async {
    let local = summary(id: "deleted", title: "Local", revision: 2)
    let tombstone = summary(
      id: local.id,
      title: local.title,
      revision: 3,
      status: .deleted
    )
    let service = FakeConversationListService(cachedConversations: [cachedConversation(local)])
    await service.enqueueRename(.success(tombstone))
    let feature = makeFeature(service: service)
    feature.consume(snapshot(connection: .online, conversations: [cachedConversation(local)]))

    await feature.rename(id: local.id, title: "Too late")
    feature.consume(snapshot(connection: .online, conversations: [cachedConversation(local)]))

    #expect(feature.conversations.isEmpty)
    #expect(await service.removedIDs.isEmpty)
  }

  @Test("a delayed rename response cannot overwrite a newer snapshot revision")
  func newerSnapshotWinsOverDelayedRename() async {
    let local = summary(id: "conversation", title: "Local", revision: 2)
    let renamed = summary(id: local.id, title: "My rename", revision: 3)
    let newer = summary(id: local.id, title: "Newer remote title", revision: 4)
    let renameGate = TestGate()
    let service = FakeConversationListService(cachedConversations: [cachedConversation(local)])
    await service.enqueueRename(.success(renamed), gate: renameGate)
    let feature = makeFeature(service: service)
    feature.consume(snapshot(connection: .online, conversations: [cachedConversation(local)]))

    let rename = Task { await feature.rename(id: local.id, title: renamed.title) }
    await renameGate.waitUntilWaiting()
    feature.consume(snapshot(connection: .online, conversations: [cachedConversation(newer)]))
    await renameGate.release()
    await rename.value

    #expect(feature.conversations.first?.summary == newer)
    #expect(feature.mutationError == .revisionConflict(current: newer))
  }

  @Test("pagination does not start from an old cursor during reset refresh")
  func paginationWaitsForRefresh() async {
    let firstPage = (0..<8).map { summary(id: "first-\($0)", updatedAt: 100 - $0) }
    let refreshed = (0..<8).map { summary(id: "refreshed-\($0)", updatedAt: 200 - $0) }
    let refreshGate = TestGate()
    let service = FakeConversationListService()
    await service.enqueuePage(
      .success(ConversationPageDTO(items: firstPage, nextCursor: "old-cursor"))
    )
    await service.enqueuePage(
      .success(ConversationPageDTO(items: refreshed, nextCursor: "new-cursor")),
      gate: refreshGate
    )
    let feature = makeFeature(service: service)
    feature.consume(snapshot(connection: .online, conversations: []))
    await feature.start()

    let refresh = Task { await feature.refresh() }
    await refreshGate.waitUntilWaiting()
    await feature.loadOlderIfNeeded(currentID: "first-3")
    await refreshGate.release()
    await refresh.value

    #expect(await service.pageCalls.map(\.cursor) == [nil, nil])
    #expect(feature.nextCursor == "new-cursor")
  }

  @Test("a buffered snapshot omission retains a newly canonical conversation")
  func snapshotOmissionDoesNotRemoveCanonicalCreate() async {
    let canonical = summary(id: "created", updatedAt: 200)
    let service = FakeConversationListService()
    await service.enqueueCreate(.success(canonical))
    let feature = makeFeature(service: service)
    feature.consume(snapshot(connection: .online, conversations: []))

    await feature.create(agentID: canonical.agentId)
    feature.consume(snapshot(connection: .online, conversations: []))

    #expect(feature.conversations.map(\.id) == [canonical.id])
  }

  @Test("a buffered snapshot omission keeps a newer canonical create first")
  func snapshotOmissionPreservesCanonicalCreateOrder() async {
    let older = summary(id: "older", updatedAt: 100)
    let canonical = summary(id: "created", updatedAt: 200)
    let service = FakeConversationListService()
    await service.enqueueCreate(.success(canonical))
    let feature = makeFeature(service: service)
    feature.consume(
      snapshot(connection: .online, conversations: [cachedConversation(older)])
    )

    await feature.create(agentID: canonical.agentId)
    feature.consume(
      snapshot(connection: .online, conversations: [cachedConversation(older)])
    )

    #expect(feature.conversations.map(\.id) == [canonical.id, older.id])
  }

  @Test("an explicit sync removal drops a row and suppresses stale snapshots")
  func explicitSyncRemovalDropsRow() async {
    let local = summary(id: "removed", revision: 2)
    let service = FakeConversationListService(cachedConversations: [cachedConversation(local)])
    let feature = makeFeature(service: service)
    feature.consume(snapshot(connection: .online, conversations: [cachedConversation(local)]))

    feature.consume(
      SyncSnapshot(
        connection: .online,
        conversations: [],
        agents: [],
        lastSuccessfulSyncAt: Date(timeIntervalSince1970: 200),
        removedConversationIDs: [local.id]
      )
    )
    feature.consume(snapshot(connection: .online, conversations: [cachedConversation(local)]))

    #expect(feature.conversations.isEmpty)
  }

  @Test("an explicit sync removal clears selection and conflict state")
  func explicitSyncRemovalClearsConflict() async {
    let local = summary(id: "removed", title: "Local", revision: 2)
    let canonical = summary(id: local.id, title: "Remote", revision: 3)
    let service = FakeConversationListService(cachedConversations: [cachedConversation(local)])
    await service.enqueueRename(.failure(.revisionConflict(current: canonical)))
    let feature = makeFeature(service: service)
    feature.consume(snapshot(connection: .online, conversations: [cachedConversation(local)]))
    feature.selectedID = local.id

    await feature.rename(id: local.id, title: "Mine")
    #expect(feature.mutationError == .revisionConflict(current: canonical))

    feature.consume(
      SyncSnapshot(
        connection: .online,
        conversations: [],
        agents: [],
        lastSuccessfulSyncAt: Date(timeIntervalSince1970: 200),
        removedConversationIDs: [local.id]
      )
    )

    #expect(feature.selectedID == nil)
    #expect(feature.mutationError == nil)
    await feature.retryConflict()
    #expect(await service.renameCalls.count == 1)
  }

  private func makeFeature(
    service: FakeConversationListService,
    requestID: @escaping @Sendable () -> UUID = { UUID() }
  ) -> ConversationListFeature {
    ConversationListFeature(
      gatewayID: "gateway-1",
      service: service,
      requestID: requestID
    )
  }

  private func snapshot(
    connection: GatewayConnectionState,
    conversations: [CachedConversation]
  ) -> SyncSnapshot {
    SyncSnapshot(
      connection: connection,
      conversations: conversations,
      agents: [],
      lastSuccessfulSyncAt: Date(timeIntervalSince1970: 100)
    )
  }

  private func cachedConversation(_ value: ConversationSummaryDTO) -> CachedConversation {
    CachedConversation(gatewayID: "gateway-1", summary: value)
  }

  private func summary(
    id: String,
    agentID: String = "agent-1",
    title: String = "Conversation",
    revision: Int = 1,
    status: ConversationStatus = .idle,
    updatedAt: Int = 20
  ) -> ConversationSummaryDTO {
    ConversationSummaryDTO(
      id: id,
      agentId: agentID,
      agentName: "Agent \(agentID)",
      title: title,
      revision: revision,
      status: status,
      activeTurnId: status == .running ? "turn-1" : nil,
      owningIssueId: nil,
      projectId: nil,
      lastSeq: 0,
      lastMessagePreview: "Preview",
      createdAt: Date(timeIntervalSince1970: 10),
      updatedAt: Date(timeIntervalSince1970: TimeInterval(updatedAt)),
      deletedAt: status == .deleted ? Date(timeIntervalSince1970: 30) : nil
    )
  }

  private func agent(id: String, name: String) -> RegisteredAgentDTO {
    RegisteredAgentDTO(
      id: id,
      name: name,
      config: AgentConfigDTO(
        name: name,
        model: "test/model",
        systemPrompt: "",
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
      registeredAt: Date(timeIntervalSince1970: 10)
    )
  }
}

private enum FakeListResult<Value: Sendable>: Sendable {
  case success(Value)
  case failure(GatewayError)

  func get() throws -> Value {
    switch self {
    case .success(let value): value
    case .failure(let error): throw error
    }
  }
}

private actor GatewayErrorRecorder {
  private(set) var values: [GatewayError] = []

  func record(_ error: GatewayError) {
    values.append(error)
  }
}

private actor FakeConversationListService: ConversationListServicing {
  private struct GatedPageResult: Sendable {
    let result: FakeListResult<ConversationPageDTO>
    let gate: TestGate?
  }

  private struct GatedMutationResult: Sendable {
    let result: FakeListResult<ConversationSummaryDTO>
    let gate: TestGate?
  }

  struct PageCall: Equatable, Sendable {
    let agentID: String?
    let limit: Int
    let cursor: String?
  }

  struct RenameCall: Equatable, Sendable {
    let id: String
    let title: String
    let revision: Int
  }

  struct DeleteCall: Equatable, Sendable {
    let id: String
    let revision: Int
  }

  private let cachedConversationValues: [CachedConversation]
  private let cachedAgentValues: [RegisteredAgentDTO]
  private let pageGate: TestGate?
  private var agentResults: [FakeListResult<[RegisteredAgentDTO]>] = []
  private var pageResults: [GatedPageResult] = []
  private var createResults: [FakeListResult<ConversationSummaryDTO>] = []
  private var reconcileResults: [FakeListResult<ConversationSummaryDTO>] = []
  private var renameResults: [GatedMutationResult] = []
  private var deleteResults: [GatedMutationResult] = []

  private(set) var pageCalls: [PageCall] = []
  private(set) var createRequests: [CreateConversationRequest] = []
  private(set) var reconcileRequests: [CreateConversationRequest] = []
  private(set) var renameCalls: [RenameCall] = []
  private(set) var deleteCalls: [DeleteCall] = []
  private(set) var removedIDs: [String] = []
  private(set) var refreshAgentCallCount = 0
  private var retainedCreateIDs: [String: String] = [:]

  init(
    cachedConversations: [CachedConversation] = [],
    cachedAgents: [RegisteredAgentDTO] = [],
    pageGate: TestGate? = nil
  ) {
    cachedConversationValues = cachedConversations
    cachedAgentValues = cachedAgents
    self.pageGate = pageGate
  }

  func enqueueAgents(_ result: FakeListResult<[RegisteredAgentDTO]>) {
    agentResults.append(result)
  }

  func enqueuePage(
    _ result: FakeListResult<ConversationPageDTO>,
    gate: TestGate? = nil
  ) {
    pageResults.append(GatedPageResult(result: result, gate: gate))
  }

  func enqueueCreate(_ result: FakeListResult<ConversationSummaryDTO>) {
    createResults.append(result)
  }

  func enqueueReconcile(_ result: FakeListResult<ConversationSummaryDTO>) {
    reconcileResults.append(result)
  }

  func enqueueRename(
    _ result: FakeListResult<ConversationSummaryDTO>,
    gate: TestGate? = nil
  ) {
    renameResults.append(GatedMutationResult(result: result, gate: gate))
  }

  func enqueueDelete(
    _ result: FakeListResult<ConversationSummaryDTO>,
    gate: TestGate? = nil
  ) {
    deleteResults.append(GatedMutationResult(result: result, gate: gate))
  }

  func cachedConversations() throws -> [CachedConversation] {
    cachedConversationValues
  }

  func cachedAgents() throws -> [RegisteredAgentDTO] {
    cachedAgentValues
  }

  func refreshAgents() throws -> [RegisteredAgentDTO] {
    refreshAgentCallCount += 1
    guard agentResults.isEmpty == false else { return cachedAgentValues }
    return try agentResults.removeFirst().get()
  }

  func conversations(
    agentID: String?,
    limit: Int,
    cursor: String?
  ) async throws -> ConversationPageDTO {
    pageCalls.append(PageCall(agentID: agentID, limit: limit, cursor: cursor))
    guard pageResults.isEmpty == false else {
      await pageGate?.wait()
      return ConversationPageDTO(items: cachedConversationValues.map(\.summary), nextCursor: nil)
    }
    let queued = pageResults.removeFirst()
    await (queued.gate ?? pageGate)?.wait()
    return try queued.result.get()
  }

  func create(_ request: CreateConversationRequest) throws -> ConversationSummaryDTO {
    createRequests.append(request)
    guard createResults.isEmpty == false else { throw GatewayError.updateRequired }
    return try createResults.removeFirst().get()
  }

  func reconcileCreate(_ request: CreateConversationRequest) throws -> ConversationSummaryDTO {
    reconcileRequests.append(request)
    guard reconcileResults.isEmpty == false else { throw GatewayError.updateRequired }
    return try reconcileResults.removeFirst().get()
  }

  func rename(id: String, title: String, revision: Int) async throws -> ConversationSummaryDTO {
    renameCalls.append(RenameCall(id: id, title: title, revision: revision))
    guard renameResults.isEmpty == false else { throw GatewayError.updateRequired }
    let queued = renameResults.removeFirst()
    await queued.gate?.wait()
    return try queued.result.get()
  }

  func delete(id: String, revision: Int) async throws -> ConversationSummaryDTO {
    deleteCalls.append(DeleteCall(id: id, revision: revision))
    guard deleteResults.isEmpty == false else { throw GatewayError.updateRequired }
    let queued = deleteResults.removeFirst()
    await queued.gate?.wait()
    return try queued.result.get()
  }

  func replace(_ summary: ConversationSummaryDTO) {
    _ = summary
  }

  func remove(id: String) {
    removedIDs.append(id)
  }

  func retainedCreateRequestID(agentID: String, suggested: String) -> String {
    if let retained = retainedCreateIDs[agentID] { return retained }
    retainedCreateIDs[agentID] = suggested
    return suggested
  }

  func clearRetainedCreateRequestID(agentID: String) {
    retainedCreateIDs[agentID] = nil
  }

  func shutdown() {}
}
