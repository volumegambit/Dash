import Foundation
import Testing

@testable import Dash

@Suite("Conversation list feature")
@MainActor
struct ConversationListFeatureTests {
  @Test("recoverable pending sends load from cache and disappear only after exact discard")
  func recoverablePendingSendsLoadAndDiscard() async {
    let recovery = RecoverablePendingSend(
      gatewayID: "gateway-1",
      conversationID: "deleted",
      conversationTitle: "Deleted launch plan",
      agentName: "Research Agent",
      pendingSend: PendingChatSend(
        turnID: "turn-pending",
        localUserID: "local-user",
        draft: "  Recover this exact text  ",
        attachments: [
          PreparedAttachment(
            id: UUID(uuidString: "018f0f4a-5c42-7a8b-9c01-1234567890ab")!,
            mediaType: "image/png",
            data: Data([0x00, 0x7F, 0xFF])
          )
        ],
        createdAt: Date(timeIntervalSince1970: 42)
      )
    )
    let recoveryService = FakeConversationRecoveryService(values: [recovery])
    let feature = makeFeature(
      service: FakeConversationListService(),
      recoveryService: recoveryService
    )
    feature.consume(snapshot(connection: .offline, conversations: []))

    await feature.start()

    #expect(feature.recoverablePendingSends == [recovery])
    #expect(feature.recoveryError == nil)

    let discarded = await feature.discardRecovery(recovery)

    #expect(discarded)
    #expect(feature.recoverablePendingSends.isEmpty)
    #expect(await recoveryService.discarded == [recovery])
  }

  @Test("last-used agent is nil until recorded, then persists per gateway")
  func lastUsedAgentPersistsPerGateway() async {
    let store = FakeLastUsedAgentStore()
    let featureA = makeFeature(
      service: FakeConversationListService(),
      lastUsedAgentStore: store,
      gatewayID: "gateway-a"
    )
    let featureB = makeFeature(
      service: FakeConversationListService(),
      lastUsedAgentStore: store,
      gatewayID: "gateway-b"
    )

    #expect(await featureA.lastUsedAgentID() == nil)
    #expect(await featureB.lastUsedAgentID() == nil)

    await featureA.recordLastUsedAgent("research-agent")

    #expect(await featureA.lastUsedAgentID() == "research-agent")
    // Compose-first new chat (Task 3, audit #16): recording a last-used
    // agent on one gateway must never leak into another gateway's default —
    // each paired gateway's compose button should offer ITS OWN most
    // recently used agent, not whichever gateway was used last overall.
    #expect(await featureB.lastUsedAgentID() == nil)

    await featureA.recordLastUsedAgent("delete-agent")
    #expect(await featureA.lastUsedAgentID() == "delete-agent")
  }

  @Test("live recovery discard keeps an active corrupt newer draft readable after restart")
  func liveRecoveryDiscardPreservesCorruptCoexistingDraftText() async throws {
    let directory = FileManager.default.temporaryDirectory.appending(
      path: UUID().uuidString,
      directoryHint: .isDirectory
    )
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let storeURL = directory.appending(path: "dash.store")
    let pending = PendingChatSend(
      turnID: "turn-earlier",
      localUserID: "local-earlier",
      draft: "Earlier message",
      attachments: [],
      createdAt: Date(timeIntervalSince1970: 41)
    )
    let newerDraft = ConversationDraft(
      text: "Newer composer text survives",
      attachments: [
        PreparedAttachment(
          id: UUID(uuidString: "018f0f4a-5c42-7a8b-9c01-1234567890ae")!,
          mediaType: "image/webp",
          data: Data([0x02])
        )
      ],
      updatedAt: Date(timeIntervalSince1970: 42)
    )
    let store = try PersistenceStore.stored(at: storeURL)
    try await store.upsertConversations(
      [summary(id: "active", title: "Active conversation")],
      gatewayID: "gateway-1"
    )
    #expect(
      try await store.stagePendingSend(
        pending,
        gatewayID: "gateway-1",
        conversationID: "active"
      ) == .staged
    )
    try await store.saveDraft(
      newerDraft,
      gatewayID: "gateway-1",
      conversationID: "active",
      encodeAttachments: { _ in Data("corrupt-draft-attachments".utf8) }
    )
    let service = LiveConversationRecoveryService(gatewayID: "gateway-1", store: store)
    let recovery = try #require(try await service.recoverablePendingSends().first)
    #expect(recovery.coexistingDraftAttachmentIssue == .unreadableStoredPayload)
    #expect(recovery.conversationAvailable)

    #expect(try await service.discard(recovery))

    let reopenedStore = try PersistenceStore.stored(at: storeURL)
    let chatPersistence = LiveChatPersistence(store: reopenedStore)
    let restoredDraft = try? await chatPersistence.draft(
      gatewayID: "gateway-1",
      conversationID: "active"
    )
    #expect(
      restoredDraft
        == ConversationDraft(
          text: newerDraft.text,
          attachments: [],
          updatedAt: newerDraft.updatedAt
        )
    )
    #expect(
      try await reopenedStore.pendingSend(gatewayID: "gateway-1", conversationID: "active")
        == .none
    )
  }

  @Test("a burst of sync snapshots coalesces recovery enumeration")
  func snapshotBurstCoalescesRecoveryReload() async {
    let recoveryService = FakeConversationRecoveryService()
    let feature = makeFeature(
      service: FakeConversationListService(),
      recoveryService: recoveryService
    )

    feature.consume(snapshot(connection: .offline, conversations: []))
    feature.consume(snapshot(connection: .offline, conversations: []))
    feature.consume(snapshot(connection: .offline, conversations: []))
    try? await Task.sleep(for: .milliseconds(20))

    let callCount = await recoveryService.recoverableCallCount
    #expect(callCount == 1)
    feature.prepareForShutdown()
  }

  @Test("gateway-scoped recovery changes refresh the list without another sync snapshot")
  func recoveryChangeSignalRefreshesMatchingGateway() async {
    let recoveryService = FakeConversationRecoveryService()
    let recoveryChanges = ConversationRecoveryChangeSignal()
    let feature = makeFeature(
      service: FakeConversationListService(),
      recoveryService: recoveryService,
      recoveryChanges: recoveryChanges
    )
    feature.consume(snapshot(connection: .offline, conversations: []))
    await feature.start()
    let initialCount = await recoveryService.recoverableCallCount

    await recoveryChanges.send(gatewayID: "other-gateway")
    try? await Task.sleep(for: .milliseconds(20))
    let afterUnrelatedChange = await recoveryService.recoverableCallCount
    #expect(afterUnrelatedChange == initialCount)

    await recoveryChanges.send(gatewayID: "gateway-1")
    try? await Task.sleep(for: .milliseconds(20))
    let afterMatchingChange = await recoveryService.recoverableCallCount
    #expect(afterMatchingChange == initialCount + 1)
    feature.prepareForShutdown()
  }

  @Test("recovery signal preserves a matching change across unrelated gateway changes")
  func recoverySignalPreservesMatchingChangeAcrossUnrelatedGateways() async {
    let recoveryChanges = ConversationRecoveryChangeSignal()
    let subscription = await recoveryChanges.subscription(gatewayID: "gateway-1")
    #expect(await recoveryChanges.subscriberCount == 1)

    await recoveryChanges.send(gatewayID: "gateway-1")
    await recoveryChanges.send(gatewayID: "gateway-2")
    var iterator = subscription.changes.makeAsyncIterator()

    #expect(await iterator.next() == "gateway-1")
    await subscription.cancel()
    #expect(await recoveryChanges.subscriberCount == 0)
  }

  @Test("overlapping starts acquire exactly one recovery change subscription")
  func overlappingStartsAcquireOneRecoveryChangeSubscription() async {
    let recoveryService = FakeConversationRecoveryService()
    let signal = ConversationRecoveryChangeSignal()
    let recoveryChanges = CoordinatedRecoveryChangeSource(
      signal: signal,
      releaseOnSecondAcquisition: true
    )
    let feature = makeFeature(
      service: FakeConversationListService(),
      recoveryService: recoveryService,
      recoveryChanges: recoveryChanges
    )

    let firstStart = Task { await feature.start() }
    await recoveryChanges.waitUntilAcquisitionCount(1)
    let overlappingStart = Task { await feature.start() }
    await recoveryService.waitUntilRecoverableCallCount(1)
    await recoveryChanges.releaseAcquisition()
    await firstStart.value
    await overlappingStart.value

    #expect(await recoveryChanges.acquisitionCount == 1)
    #expect(await signal.subscriberCount == 1)
    feature.prepareForShutdown()
  }

  @Test("teardown during recovery subscription acquisition prevents a post-shutdown reload")
  func teardownDuringRecoverySubscriptionAcquisition() async {
    let recoveryService = FakeConversationRecoveryService()
    let signal = ConversationRecoveryChangeSignal()
    let recoveryChanges = CoordinatedRecoveryChangeSource(signal: signal)
    let feature = makeFeature(
      service: FakeConversationListService(),
      recoveryService: recoveryService,
      recoveryChanges: recoveryChanges
    )

    let start = Task { await feature.start() }
    await recoveryChanges.waitUntilAcquisitionCount(1)
    feature.prepareForShutdown()
    await recoveryChanges.releaseAcquisition()
    await start.value

    #expect(await recoveryService.recoverableCallCount == 0)
    #expect(await signal.subscriberCount == 0)
    feature.prepareForShutdown()
  }

  @Test("shutdown drains an in-flight recovery subscription acquisition")
  func shutdownDrainsRecoverySubscriptionAcquisition() async {
    let signal = ConversationRecoveryChangeSignal()
    let recoveryChanges = CoordinatedRecoveryChangeSource(signal: signal)
    let service = FakeConversationListService()
    let feature = makeFeature(
      service: service,
      recoveryChanges: recoveryChanges
    )

    let start = Task { await feature.start() }
    await recoveryChanges.waitUntilAcquisitionCount(1)
    let completion = ShutdownCompletionProbe()
    let shutdown = Task {
      await feature.shutdown()
      await completion.record()
    }
    try? await Task.sleep(for: .milliseconds(20))

    #expect(await completion.count == 0)

    await recoveryChanges.releaseAcquisition()
    await start.value
    await shutdown.value

    #expect(await completion.count == 1)
    #expect(await signal.subscriberCount == 0)
    #expect(await service.shutdownCallCount == 1)
  }

  @Test("shutdown drains a direct in-flight recovery reload")
  func shutdownDrainsDirectRecoveryReload() async {
    let recoveryGate = TestGate()
    let recoveryService = FakeConversationRecoveryService()
    await recoveryService.gateNextRecoverableCall(recoveryGate)
    let service = FakeConversationListService()
    let feature = makeFeature(service: service, recoveryService: recoveryService)

    let reload = Task { await feature.reloadRecoverablePendingSends() }
    await recoveryGate.waitUntilWaiting()
    let completion = ShutdownCompletionProbe()
    let shutdown = Task {
      await feature.shutdown()
      await completion.record()
    }
    try? await Task.sleep(for: .milliseconds(20))

    #expect(await completion.count == 0)

    await recoveryGate.release()
    await reload.value
    await shutdown.value

    #expect(await completion.count == 1)
    #expect(await service.shutdownCallCount == 1)
  }

  @Test("a discard awaits an overlapping explicit recovery reload through its final pass")
  func discardAwaitsOverlappingExplicitRecoveryReload() async throws {
    let recovery = RecoverablePendingSend(
      gatewayID: "gateway-1",
      conversationID: "deleted",
      conversationTitle: "Deleted conversation",
      agentName: "Agent",
      pendingSend: PendingChatSend(
        turnID: "turn-pending",
        localUserID: "local-user",
        draft: "Recover me",
        attachments: [],
        createdAt: Date(timeIntervalSince1970: 42)
      )
    )
    let recoveryService = FakeConversationRecoveryService(values: [recovery])
    let feature = makeFeature(
      service: FakeConversationListService(),
      recoveryService: recoveryService
    )
    feature.consume(snapshot(connection: .offline, conversations: []))
    await feature.start()

    let reloadGate = TestGate()
    await recoveryService.gateNextRecoverableCall(reloadGate)
    let leadingReload = Task { await feature.reloadRecoverablePendingSends() }
    await reloadGate.waitUntilWaiting()

    let discardCompletion = ShutdownCompletionProbe()
    let discard = Task {
      let discarded = await feature.discardRecovery(recovery)
      await discardCompletion.record()
      return discarded
    }
    try await Task.sleep(for: .milliseconds(20))

    #expect(await discardCompletion.count == 0)

    await reloadGate.release()
    await leadingReload.value
    #expect(await discard.value)
    #expect(feature.recoverablePendingSends.isEmpty)
    await feature.shutdown()
  }

  @Test("shutdown drains recovery discard and rejects another discard")
  func shutdownDrainsRecoveryDiscard() async {
    let recovery = RecoverablePendingSend(
      gatewayID: "gateway-1",
      conversationID: "deleted",
      conversationTitle: "Deleted conversation",
      agentName: "Agent",
      pendingSend: PendingChatSend(
        turnID: "turn-pending",
        localUserID: "local-user",
        draft: "Recover me",
        attachments: [],
        createdAt: Date(timeIntervalSince1970: 42)
      )
    )
    let discardGate = TestGate()
    let recoveryService = FakeConversationRecoveryService(values: [recovery])
    await recoveryService.gateNextDiscard(discardGate)
    let service = FakeConversationListService()
    let feature = makeFeature(service: service, recoveryService: recoveryService)

    let discard = Task { await feature.discardRecovery(recovery) }
    await discardGate.waitUntilWaiting()
    #expect(feature.discardingRecoveryID == recovery.id)
    let completion = ShutdownCompletionProbe()
    let shutdown = Task {
      await feature.shutdown()
      await completion.record()
    }
    try? await Task.sleep(for: .milliseconds(20))

    #expect(await completion.count == 0)

    await discardGate.release()
    #expect(await discard.value)
    await shutdown.value

    #expect(await completion.count == 1)
    #expect(feature.discardingRecoveryID == nil)
    #expect(await service.shutdownCallCount == 1)
    #expect(await feature.discardRecovery(recovery) == false)
    #expect(await recoveryService.discarded == [recovery])
  }

  @Test("shutdown drains cancelled refresh and recovery work exactly once")
  func shutdownDrainsCancelledRefreshAndRecoveryWork() async {
    let pageGate = TestGate()
    let recoveryGate = TestGate()
    let serviceShutdownGate = TestGate()
    let service = FakeConversationListService(
      pageGate: pageGate,
      shutdownGate: serviceShutdownGate
    )
    let recoveryService = FakeConversationRecoveryService()
    let feature = makeFeature(service: service, recoveryService: recoveryService)
    await feature.start()
    await recoveryService.gateNextRecoverableCall(recoveryGate)

    feature.consume(snapshot(connection: .online, conversations: []))
    await pageGate.waitUntilWaiting()
    await recoveryGate.waitUntilWaiting()

    feature.prepareForShutdown()
    let completion = ShutdownCompletionProbe()
    let firstShutdown = Task {
      await feature.shutdown()
      await completion.record()
    }
    await serviceShutdownGate.waitUntilWaiting()
    let overlappingShutdown = Task {
      await feature.shutdown()
      await completion.record()
    }

    await serviceShutdownGate.release()
    try? await Task.sleep(for: .milliseconds(20))
    #expect(await completion.count == 0)

    await pageGate.release()
    try? await Task.sleep(for: .milliseconds(20))
    #expect(await completion.count == 0)

    await recoveryGate.release()
    await firstShutdown.value
    await overlappingShutdown.value
    await feature.shutdown()

    #expect(await completion.count == 2)
    #expect(await service.shutdownCallCount == 1)
  }

  @Test("shutdown waits for recovery stream cancellation to release its subscriber")
  func shutdownWaitsForRecoveryStreamTermination() async {
    let signal = ConversationRecoveryChangeSignal()
    let cancellationGate = TestGate()
    let recoveryChanges = GatedCancellationRecoveryChangeSource(
      signal: signal,
      cancellationGate: cancellationGate
    )
    let feature = makeFeature(
      service: FakeConversationListService(),
      recoveryChanges: recoveryChanges
    )
    await feature.start()
    #expect(await signal.subscriberCount == 1)

    let completion = ShutdownCompletionProbe()
    let shutdown = Task {
      await feature.shutdown()
      await completion.record()
    }
    await cancellationGate.waitUntilWaiting()
    try? await Task.sleep(for: .milliseconds(20))

    #expect(await completion.count == 0)

    await cancellationGate.release()
    await shutdown.value

    #expect(await completion.count == 1)
    #expect(await signal.subscriberCount == 0)
  }

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

  @Test("refresh cannot replace a newer active row with stale or equal tombstones")
  func refreshRejectsNonNewerTombstones() async {
    let active = summary(id: "conversation", title: "Active", revision: 6)
    let staleTombstone = summary(
      id: active.id,
      title: active.title,
      revision: 5,
      status: .deleted
    )
    let equalTombstone = summary(
      id: active.id,
      title: active.title,
      revision: active.revision,
      status: .deleted
    )
    let service = FakeConversationListService()
    await service.enqueuePage(
      .success(ConversationPageDTO(items: [staleTombstone], nextCursor: nil))
    )
    await service.enqueuePage(
      .success(ConversationPageDTO(items: [equalTombstone], nextCursor: nil))
    )
    let feature = makeFeature(service: service)
    feature.consume(snapshot(connection: .online, conversations: [cachedConversation(active)]))

    await feature.refresh()
    #expect(feature.conversations.map(\.summary) == [active])

    await feature.refresh()
    #expect(feature.conversations.map(\.summary) == [active])
  }

  @Test("refresh revives a tombstone only with a strictly newer active row")
  func refreshRevivesTombstoneWithNewerActiveRow() async {
    let tombstone = summary(id: "conversation", revision: 3, status: .deleted)
    let revived = summary(id: tombstone.id, title: "Revived", revision: 4)
    let service = FakeConversationListService()
    await service.enqueuePage(
      .success(ConversationPageDTO(items: [revived], nextCursor: nil))
    )
    let feature = makeFeature(service: service)
    feature.consume(snapshot(connection: .online, conversations: [cachedConversation(tombstone)]))

    await feature.refresh()

    #expect(feature.conversations.map(\.summary) == [revived])
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

  @Test(
    """
    a search filter matching only early rows still triggers pagination via the visible \
    (filtered) list, not the canonical one — review fix, audit #9
    """
  )
  func searchFilteredPaginationTriggersFromVisibleList() async {
    let firstPage = (0..<8).map { summary(id: "new-\($0)", updatedAt: 100 - $0) }
    let older = [summary(id: "older-1", updatedAt: 10)]
    let service = FakeConversationListService()
    await service.enqueuePage(
      .success(ConversationPageDTO(items: firstPage, nextCursor: "opaque/+cursor=="))
    )
    await service.enqueuePage(
      .success(ConversationPageDTO(items: older, nextCursor: nil))
    )
    let feature = makeFeature(service: service)
    feature.consume(snapshot(connection: .online, conversations: []))
    await feature.start()

    // Simulates `ConversationListView.filteredConversations` for a query
    // matching only the first three of the eight loaded rows. Its last row
    // ("new-2") sits at index 2 of 3 — inside the last-5 trigger window of
    // this FILTERED list — but at index 2 of 8 in the canonical
    // `feature.conversations`, nowhere near ITS last-5 window. That gap is
    // exactly the stall the review fix addresses: a query that filters out
    // the canonical list's tail rows must not silently stop pagination.
    let visibleDuringSearch = firstPage.prefix(3).map(cachedConversation)

    // Regression guard: the pre-fix call shape (no `visibleConversations`,
    // defaulting to the canonical list) must NOT trigger here — otherwise
    // this test would no longer be reproducing the bug the fix addresses.
    await feature.loadOlderIfNeeded(currentID: "new-2")
    #expect(await service.pageCalls.map(\.cursor) == [nil])

    // The fix: passing the actually-visible (search-filtered) list — the
    // same one `ConversationListView` now passes — triggers pagination.
    await feature.loadOlderIfNeeded(
      currentID: "new-2",
      visibleConversations: visibleDuringSearch
    )

    #expect(await service.pageCalls.map(\.cursor) == [nil, "opaque/+cursor=="])
    #expect(feature.conversations.map(\.id) == firstPage.map(\.id) + older.map(\.id))
  }

  @Test(
    """
    loadOlderForEmptySearchResults eagerly loads the next page when a search matches nothing \
    loaded yet, since there is no row to hang the usual trigger off — review fix, audit #9
    """
  )
  func emptySearchResultsEagerlyPaginates() async {
    let firstPage = (0..<8).map { summary(id: "new-\($0)", updatedAt: 100 - $0) }
    let matching = [summary(id: "match-1", updatedAt: 5)]
    let service = FakeConversationListService()
    await service.enqueuePage(
      .success(ConversationPageDTO(items: firstPage, nextCursor: "opaque/+cursor=="))
    )
    await service.enqueuePage(
      .success(ConversationPageDTO(items: matching, nextCursor: nil))
    )
    let feature = makeFeature(service: service)
    feature.consume(snapshot(connection: .online, conversations: []))
    await feature.start()
    #expect(await service.pageCalls.map(\.cursor) == [nil])

    // No locally-loaded row would match this fixture's hypothetical query —
    // `ConversationListView` would be rendering `ContentUnavailableView
    // .search` instead of any row — but a further page does contain a
    // match, so this must still page forward to find it.
    await feature.loadOlderForEmptySearchResults()

    #expect(await service.pageCalls.map(\.cursor) == [nil, "opaque/+cursor=="])
    #expect(feature.conversations.map(\.id) == firstPage.map(\.id) + matching.map(\.id))
  }

  @Test("pagination cannot replace a newer active row with stale or equal tombstones")
  func paginationRejectsNonNewerTombstones() async {
    let active = summary(id: "conversation", title: "Active", revision: 6, updatedAt: 200)
    let fillers = (0..<8).map { summary(id: "filler-\($0)", updatedAt: 100 - $0) }
    let staleTombstone = summary(
      id: active.id,
      title: active.title,
      revision: 5,
      status: .deleted
    )
    let equalTombstone = summary(
      id: active.id,
      title: active.title,
      revision: active.revision,
      status: .deleted
    )
    let service = FakeConversationListService()
    await service.enqueuePage(
      .success(ConversationPageDTO(items: [active] + fillers, nextCursor: "older"))
    )
    await service.enqueuePage(
      .success(
        ConversationPageDTO(items: [staleTombstone, equalTombstone], nextCursor: nil)
      )
    )
    let feature = makeFeature(service: service)
    feature.consume(snapshot(connection: .online, conversations: []))
    await feature.start()

    await feature.loadOlderIfNeeded(currentID: fillers[3].id)

    #expect(feature.conversations.first?.summary == active)
  }

  @Test("pagination revives a tombstone only with a strictly newer active row")
  func paginationRevivesTombstoneWithNewerActiveRow() async {
    let tombstone = summary(id: "conversation", revision: 3, status: .deleted)
    let revived = summary(id: tombstone.id, title: "Revived", revision: 4)
    let fillers = (0..<8).map { summary(id: "filler-\($0)", updatedAt: 100 - $0) }
    let service = FakeConversationListService()
    await service.enqueuePage(
      .success(ConversationPageDTO(items: fillers + [tombstone], nextCursor: "older"))
    )
    await service.enqueuePage(
      .success(ConversationPageDTO(items: [revived], nextCursor: nil))
    )
    let feature = makeFeature(service: service)
    feature.consume(snapshot(connection: .online, conversations: []))
    await feature.start()

    await feature.loadOlderIfNeeded(currentID: fillers[3].id)

    #expect(feature.conversations.last?.summary == revived)
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

  @Test("a newer tombstone during create finalization prevents deleted selection")
  func createFinalizationDoesNotSelectNewerTombstone() async {
    let created = summary(id: "created", revision: 7)
    let newerTombstone = summary(id: created.id, revision: 8, status: .deleted)
    let clearGate = TestGate()
    let service = FakeConversationListService()
    await service.enqueueCreate(.success(created))
    await service.gateNextClearRetainedCreateRequestID(clearGate)
    let feature = makeFeature(service: service)
    feature.consume(snapshot(connection: .online, conversations: []))

    let create = Task { await feature.create(agentID: created.agentId) }
    await clearGate.waitUntilWaiting()
    feature.consume(
      snapshot(connection: .online, conversations: [cachedConversation(newerTombstone)])
    )
    await clearGate.release()
    let resolvedID = await create.value

    // Review fix I2: this hidden-tombstone reconciliation is exactly the
    // case where `mutationError == nil` alone used to be a false success
    // signal — `resolveCreate` cleared `mutationError` unconditionally
    // BEFORE branching on the reconciliation outcome, so callers gating
    // navigation on "no error" would proceed with whatever `selectedID`
    // happened to already hold (here, still `nil`, but in general a STALE
    // id from something unrelated) instead of correctly treating this as a
    // failure. `create(agentID:)`'s return value is now the only signal
    // callers should trust: `nil` here, with `mutationError` actually set.
    #expect(resolvedID == nil)
    #expect(feature.mutationError == .failed)
    #expect(feature.conversations.isEmpty)
    #expect(feature.selectedID == nil)
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

  @Test("leaving an unused compose-created conversation deletes it")
  func discardIfUnusedComposeCreationDeletesUnsentConversation() async {
    let created = summary(id: "created", agentID: "agent-1", revision: 3)
    let tombstone = summary(id: created.id, agentID: "agent-1", revision: 4, status: .deleted)
    let service = FakeConversationListService()
    await service.enqueueCreate(.success(created))
    await service.enqueueDelete(.success(tombstone))
    let feature = makeFeature(service: service)
    feature.consume(snapshot(connection: .online, conversations: []))
    let resolvedID = await feature.create(agentID: "agent-1")
    #expect(resolvedID == created.id)

    await feature.discardIfUnusedComposeCreation(id: created.id, hasActivity: false)

    // Review fix I1: audit #16's whole point is that compose-first must
    // never leave behind a permanent empty "New Conversation" row — backing
    // out without sending anything deletes the conversation this created.
    #expect(await service.deleteCalls == [.init(id: created.id, revision: created.revision)])
    #expect(feature.conversations.isEmpty)
  }

  @Test("leaving a compose-created conversation that has activity does not delete it")
  func discardIfUnusedComposeCreationKeepsSentConversation() async {
    let created = summary(id: "created", agentID: "agent-1", revision: 3)
    let service = FakeConversationListService()
    await service.enqueueCreate(.success(created))
    let feature = makeFeature(service: service)
    feature.consume(snapshot(connection: .online, conversations: []))
    await feature.create(agentID: "agent-1")

    await feature.discardIfUnusedComposeCreation(id: created.id, hasActivity: true)

    #expect(await service.deleteCalls.isEmpty)
    #expect(feature.conversations.map(\.id) == [created.id])
  }

  @Test("discardIfUnusedComposeCreation only ever considers a given id once")
  func discardIfUnusedComposeCreationIsOneShot() async {
    let created = summary(id: "created", agentID: "agent-1", revision: 3)
    let service = FakeConversationListService()
    await service.enqueueCreate(.success(created))
    let feature = makeFeature(service: service)
    feature.consume(snapshot(connection: .online, conversations: []))
    await feature.create(agentID: "agent-1")

    // First ask reports activity, so nothing is deleted — but the tracking
    // entry is consumed regardless of outcome, so a SECOND ask for the same
    // id (e.g. a duplicate `onDisappear` firing) can't delete it either,
    // even if it now (wrongly) claims no activity.
    await feature.discardIfUnusedComposeCreation(id: created.id, hasActivity: true)
    await feature.discardIfUnusedComposeCreation(id: created.id, hasActivity: false)

    #expect(await service.deleteCalls.isEmpty)
  }

  @Test("discardIfUnusedComposeCreation never touches a conversation not created via compose")
  func discardIfUnusedComposeCreationIgnoresNonComposeConversations() async {
    let existing = summary(id: "existing", agentID: "agent-1")
    let service = FakeConversationListService()
    let feature = makeFeature(service: service)
    feature.consume(snapshot(connection: .online, conversations: [cachedConversation(existing)]))

    await feature.discardIfUnusedComposeCreation(id: existing.id, hasActivity: false)

    #expect(await service.deleteCalls.isEmpty)
    #expect(feature.conversations.map(\.id) == [existing.id])
  }

  @Test("discardIfUnusedComposeCreation swallows a delete failure without surfacing mutationError")
  func discardIfUnusedComposeCreationSwallowsFailure() async {
    let created = summary(id: "created", agentID: "agent-1", revision: 3)
    let service = FakeConversationListService()
    await service.enqueueCreate(.success(created))
    await service.enqueueDelete(.failure(.gatewayOffline))
    let feature = makeFeature(service: service)
    feature.consume(snapshot(connection: .online, conversations: []))
    await feature.create(agentID: "agent-1")
    #expect(feature.mutationError == nil)

    await feature.discardIfUnusedComposeCreation(id: created.id, hasActivity: false)

    // Best-effort by design (review comment, I1): a failed cleanup delete
    // must stay invisible — no `mutationError`, no gateway-error reporting
    // that would flip the app's connection banner for a cleanup the user
    // never asked for. The (harmless, empty) conversation is simply left
    // behind for the user to remove manually later.
    #expect(feature.mutationError == nil)
    #expect(feature.conversations.map(\.id) == [created.id])
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

  @Test("conflict reconciliation applies the effective persisted canonical")
  func conflictReconciliationUsesEffectivePersistedCanonical() async {
    let local = summary(id: "conversation", title: "Local", revision: 5)
    let staleTombstone = summary(
      id: local.id,
      title: local.title,
      revision: 6,
      status: .deleted
    )
    let effective = summary(id: local.id, title: "Newer active", revision: 7)
    let service = FakeConversationListService()
    await service.enqueueRename(.failure(.revisionConflict(current: staleTombstone)))
    await service.enqueueReplace(.success(effective))
    let feature = makeFeature(service: service)
    feature.consume(snapshot(connection: .online, conversations: [cachedConversation(local)]))

    await feature.rename(id: local.id, title: "Mine")

    #expect(feature.conversations.map(\.summary) == [effective])
    #expect(feature.mutationError == .revisionConflict(current: effective))
  }

  @Test("a newer active snapshot during conflict persistence remains retryable")
  func conflictPersistenceKeepsNewerActiveSnapshotRetryable() async {
    let local = summary(id: "conversation", title: "Local", revision: 5)
    let conflict = summary(id: local.id, revision: 6, status: .deleted)
    let persisted = summary(id: local.id, revision: 7, status: .deleted)
    let newerActive = summary(id: local.id, title: "Newer active", revision: 8)
    let replaceGate = TestGate()
    let service = FakeConversationListService()
    await service.enqueueRename(.failure(.revisionConflict(current: conflict)))
    await service.enqueueReplace(.success(persisted), gate: replaceGate)
    let feature = makeFeature(service: service)
    feature.consume(snapshot(connection: .online, conversations: [cachedConversation(local)]))

    let rename = Task { await feature.rename(id: local.id, title: "Mine") }
    await replaceGate.waitUntilWaiting()
    feature.consume(
      snapshot(connection: .online, conversations: [cachedConversation(newerActive)])
    )
    await replaceGate.release()
    await rename.value

    #expect(feature.conversations.map(\.summary) == [newerActive])
    #expect(feature.mutationError == .revisionConflict(current: newerActive))
  }

  @Test("a newer tombstone snapshot during conflict persistence clears a stale banner")
  func conflictPersistenceKeepsNewerTombstoneAuthoritative() async {
    let local = summary(id: "conversation", title: "Local", revision: 5)
    let conflict = summary(id: local.id, title: "Conflict", revision: 6)
    let persisted = summary(id: local.id, title: "Persisted", revision: 7)
    let newerTombstone = summary(id: local.id, revision: 8, status: .deleted)
    let replaceGate = TestGate()
    let service = FakeConversationListService()
    await service.enqueueRename(.failure(.revisionConflict(current: conflict)))
    await service.enqueueReplace(.success(persisted), gate: replaceGate)
    let feature = makeFeature(service: service)
    feature.consume(snapshot(connection: .online, conversations: [cachedConversation(local)]))

    let rename = Task { await feature.rename(id: local.id, title: "Mine") }
    await replaceGate.waitUntilWaiting()
    feature.consume(
      snapshot(connection: .online, conversations: [cachedConversation(newerTombstone)])
    )
    await replaceGate.release()
    await rename.value

    #expect(feature.conversations.isEmpty)
    #expect(feature.mutationError == nil)
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
    let lifecycle = ConversationLifecycleChangeProbe()
    feature.consume(snapshot(connection: .online, conversations: [cachedConversation(local)]))
    await feature.start()
    feature.setLifecycleChangeHandler { changes in
      await lifecycle.record(changes)
      return .ignored
    }

    await feature.delete(id: local.id, confirmed: false)
    #expect(feature.conversations.map(\.id) == [local.id])
    #expect(await service.deleteCalls.isEmpty)

    await feature.delete(id: local.id, confirmed: true)

    #expect(feature.conversations.isEmpty)
    #expect(await service.deleteCalls.map(\.revision) == [4])
    #expect(await lifecycle.changes == [.canonical(tombstone)])
  }

  @Test("conversation row actions respect canonical status and connectivity")
  func conversationRowActionsRespectCanonicalState() {
    let idle = summary(id: "idle")
    let running = summary(id: "running", status: .running)
    let archived = summary(id: "archived", status: .archived)

    let onlineIdle = ConversationRowActionPolicy(summary: idle, mutationsAllowed: true)
    #expect(onlineIdle.showsRename)
    #expect(onlineIdle.showsDelete)
    #expect(onlineIdle.canRename)
    #expect(onlineIdle.canDelete)

    let onlineRunning = ConversationRowActionPolicy(summary: running, mutationsAllowed: true)
    #expect(onlineRunning.showsRename)
    #expect(onlineRunning.showsDelete)
    #expect(onlineRunning.canRename)
    #expect(onlineRunning.canDelete == false)
    #expect(
      onlineRunning.deleteDisabledHint
        == "Wait for the active turn to finish before deleting"
    )

    let onlineArchived = ConversationRowActionPolicy(summary: archived, mutationsAllowed: true)
    #expect(onlineArchived.showsRename == false)
    #expect(onlineArchived.showsDelete == false)

    let offlineIdle = ConversationRowActionPolicy(summary: idle, mutationsAllowed: false)
    #expect(offlineIdle.showsRename)
    #expect(offlineIdle.showsDelete)
    #expect(offlineIdle.canRename == false)
    #expect(offlineIdle.canDelete == false)
    #expect(offlineIdle.renameDisabledHint == "Connect to the gateway to rename")
    #expect(offlineIdle.deleteDisabledHint == "Connect to the gateway to delete")
  }

  @Test("a raced delete busy response remains actionable")
  func busyDeleteMapsToActionableMutationError() async {
    let local = summary(id: "conversation", title: "Busy", revision: 4)
    let service = FakeConversationListService(cachedConversations: [cachedConversation(local)])
    await service.enqueueDelete(.failure(.conversationBusy(activeTurnId: "remote-turn")))
    let feature = makeFeature(service: service)
    feature.consume(snapshot(connection: .online, conversations: [cachedConversation(local)]))

    await feature.delete(id: local.id, confirmed: true)

    #expect(
      feature.mutationError
        == .conversationBusy(conversationID: local.id, activeTurnID: "remote-turn")
    )
    #expect(feature.conversations.map(\.summary) == [local])
  }

  @Test("a raced archived delete reconciles only its canonical read-only row")
  func archivedDeleteRaceReconcilesCanonicalState() async {
    let local = summary(id: "conversation", title: "Local", revision: 4)
    let unrelated = summary(id: "unrelated", title: "Keep me", revision: 7)
    let archived = summary(
      id: local.id,
      title: "Archived elsewhere",
      revision: 5,
      status: .archived
    )
    let service = FakeConversationListService(
      cachedConversations: [cachedConversation(local), cachedConversation(unrelated)]
    )
    await service.enqueueDelete(
      .failure(.validation("Archived conversations cannot be deleted"))
    )
    await service.enqueueConversation(.success(archived))
    let feature = makeFeature(service: service)
    let lifecycle = ConversationLifecycleChangeProbe()
    feature.consume(
      snapshot(
        connection: .online,
        conversations: [cachedConversation(local), cachedConversation(unrelated)]
      )
    )
    feature.setLifecycleChangeHandler { changes in
      await lifecycle.record(changes)
      return .ignored
    }

    await feature.delete(id: local.id, confirmed: true)

    #expect(feature.conversations.map(\.summary) == [archived, unrelated])
    #expect(feature.mutationError == .readOnly(conversationID: local.id))
    #expect(await service.conversationCalls == [local.id])
    #expect(await service.pageCalls.isEmpty)
    #expect(await service.refreshAgentCallCount == 0)
    #expect(await lifecycle.changes == [.canonical(archived)])
  }

  @Test("a missing archived reconciliation target removes its stale row")
  func missingArchivedReconciliationTargetRemovesStaleRow() async {
    let local = summary(id: "conversation", title: "Local", revision: 4)
    let service = FakeConversationListService(cachedConversations: [cachedConversation(local)])
    await service.enqueueDelete(
      .failure(.validation("Archived conversations cannot be deleted"))
    )
    await service.enqueueConversation(.failure(.notFound))
    let feature = makeFeature(service: service)
    let lifecycle = ConversationLifecycleChangeProbe()
    feature.consume(snapshot(connection: .online, conversations: [cachedConversation(local)]))
    feature.setLifecycleChangeHandler { changes in
      await lifecycle.record(changes)
      return .ignored
    }

    await feature.delete(id: local.id, confirmed: true)

    #expect(feature.conversations.isEmpty)
    #expect(feature.mutationError == nil)
    #expect(await service.conversationCalls == [local.id])
    #expect(await service.removedIDs == [local.id])
    #expect(await service.pageCalls.isEmpty)
    #expect(
      await lifecycle.changes == [.removed(id: local.id, revisionFloor: local.revision)]
    )
  }

  @Test("a failed archived reconciliation target does not claim read-only")
  func failedArchivedReconciliationTargetDoesNotClaimReadOnly() async {
    let local = summary(id: "conversation", title: "Local", revision: 4)
    let service = FakeConversationListService(cachedConversations: [cachedConversation(local)])
    await service.enqueueRename(
      .failure(.validation("Archived conversations cannot be updated"))
    )
    await service.enqueueConversation(.failure(.transport("connection lost")))
    let feature = makeFeature(service: service)
    feature.consume(snapshot(connection: .online, conversations: [cachedConversation(local)]))

    await feature.rename(id: local.id, title: "Requested title")

    #expect(feature.conversations.map(\.summary) == [local])
    #expect(feature.mutationError == .failed)
    #expect(await service.conversationCalls == [local.id])
    #expect(await service.pageCalls.isEmpty)
  }

  @Test("a newer active row wins an archived reconciliation race")
  func activeRowWinsArchivedReconciliationRace() async {
    let local = summary(id: "conversation", title: "Local", revision: 4)
    let archived = summary(id: local.id, title: "Archived", revision: 5, status: .archived)
    let newerActive = summary(id: local.id, title: "Active again", revision: 6)
    let targetGate = TestGate()
    let service = FakeConversationListService(cachedConversations: [cachedConversation(local)])
    await service.enqueueDelete(
      .failure(.validation("Archived conversations cannot be deleted"))
    )
    await service.enqueueConversation(.success(archived), gate: targetGate)
    let feature = makeFeature(service: service)
    let lifecycle = ConversationLifecycleChangeProbe()
    feature.consume(snapshot(connection: .online, conversations: [cachedConversation(local)]))
    feature.setLifecycleChangeHandler { changes in
      await lifecycle.record(changes)
      return .ignored
    }

    let deletion = Task { await feature.delete(id: local.id, confirmed: true) }
    await targetGate.waitUntilWaiting()
    feature.consume(
      snapshot(connection: .online, conversations: [cachedConversation(newerActive)])
    )
    await targetGate.release()
    await deletion.value

    #expect(feature.conversations.map(\.summary) == [newerActive])
    #expect(feature.mutationError == .revisionConflict(current: newerActive))
    #expect(await service.conversationCalls == [local.id])
    #expect(await lifecycle.changes == [.canonical(newerActive)])
  }

  @Test("a missing archived reconciliation target cannot remove a newer active row")
  func missingArchivedReconciliationTargetKeepsNewerActiveRow() async {
    let local = summary(id: "conversation", title: "Local", revision: 4)
    let newerActive = summary(id: local.id, title: "Active again", revision: 6)
    let targetGate = TestGate()
    let service = FakeConversationListService(cachedConversations: [cachedConversation(local)])
    await service.enqueueDelete(
      .failure(.validation("Archived conversations cannot be deleted"))
    )
    await service.enqueueConversation(.failure(.notFound), gate: targetGate)
    let feature = makeFeature(service: service)
    let lifecycle = ConversationLifecycleChangeProbe()
    feature.consume(snapshot(connection: .online, conversations: [cachedConversation(local)]))
    feature.setLifecycleChangeHandler { changes in
      await lifecycle.record(changes)
      return .ignored
    }

    let deletion = Task { await feature.delete(id: local.id, confirmed: true) }
    await targetGate.waitUntilWaiting()
    feature.consume(
      snapshot(connection: .online, conversations: [cachedConversation(newerActive)])
    )
    await targetGate.release()
    await deletion.value

    #expect(feature.conversations.map(\.summary) == [newerActive])
    #expect(feature.mutationError == .revisionConflict(current: newerActive))
    #expect(await service.conversationCalls == [local.id])
    #expect(await service.removedIDs.isEmpty)
    #expect(await lifecycle.changes.isEmpty)
  }

  @Test("delete exposes the effective active canonical when its tombstone is rejected")
  func deleteRejectedByPersistenceBecomesConflict() async {
    let local = summary(id: "current", title: "Current", revision: 2)
    let effective = summary(id: local.id, title: "Newer active", revision: 4)
    let service = FakeConversationListService(cachedConversations: [cachedConversation(local)])
    await service.enqueueDelete(.success(effective))
    let feature = makeFeature(service: service)
    feature.consume(snapshot(connection: .online, conversations: [cachedConversation(local)]))

    await feature.delete(id: local.id, confirmed: true)

    #expect(feature.conversations.map(\.summary) == [effective])
    #expect(feature.mutationError == .revisionConflict(current: effective))
  }

  @Test("a newer active snapshot during delete remains visible and retryable")
  func deleteKeepsNewerActiveSnapshotRetryable() async {
    let local = summary(id: "conversation", title: "Local", revision: 5)
    let returnedTombstone = summary(id: local.id, revision: 7, status: .deleted)
    let newerActive = summary(id: local.id, title: "Newer active", revision: 8)
    let deleteGate = TestGate()
    let service = FakeConversationListService()
    await service.enqueueDelete(.success(returnedTombstone), gate: deleteGate)
    let feature = makeFeature(service: service)
    feature.consume(snapshot(connection: .online, conversations: [cachedConversation(local)]))

    let delete = Task { await feature.delete(id: local.id, confirmed: true) }
    await deleteGate.waitUntilWaiting()
    feature.consume(
      snapshot(connection: .online, conversations: [cachedConversation(newerActive)])
    )
    await deleteGate.release()
    await delete.value

    #expect(feature.conversations.map(\.summary) == [newerActive])
    #expect(feature.mutationError == .revisionConflict(current: newerActive))
  }

  @Test("mutation reconciliation cannot replace an active row with an equal tombstone")
  func mutationReconciliationRejectsEqualTombstone() async {
    let active = summary(id: "conversation", title: "Active", revision: 6)
    let equalTombstone = summary(
      id: active.id,
      title: active.title,
      revision: active.revision,
      status: .deleted
    )
    let service = FakeConversationListService()
    await service.enqueueRename(.success(equalTombstone))
    let feature = makeFeature(service: service)
    feature.consume(snapshot(connection: .online, conversations: [cachedConversation(active)]))

    await feature.rename(id: active.id, title: "Requested title")

    #expect(feature.conversations.map(\.summary) == [active])
  }

  @Test("a stale 404 removes the local row")
  func notFoundRemovesStaleRow() async {
    let local = summary(id: "stale", title: "Stale", revision: 2)
    let service = FakeConversationListService(cachedConversations: [cachedConversation(local)])
    await service.enqueueRename(.failure(.notFound))
    let feature = makeFeature(service: service)
    let lifecycle = ConversationLifecycleChangeProbe()
    feature.consume(snapshot(connection: .online, conversations: [cachedConversation(local)]))
    await feature.start()
    feature.setLifecycleChangeHandler { changes in
      await lifecycle.record(changes)
      return .ignored
    }

    await feature.rename(id: local.id, title: "Still stale")

    #expect(feature.conversations.isEmpty)
    #expect(await service.removedIDs == [local.id])
    #expect(
      await lifecycle.changes == [.removed(id: local.id, revisionFloor: local.revision)]
    )
  }

  @Test("a delayed 404 cannot remove an equal-revision newer active row")
  func delayedNotFoundRetainsNewerActiveRow() async {
    let local = summary(id: "conversation", title: "Before revival", revision: 5, updatedAt: 20)
    let revived = summary(
      id: local.id,
      title: "Revived elsewhere",
      revision: local.revision,
      status: .running,
      updatedAt: 30
    )
    let responseGate = TestGate()
    let service = FakeConversationListService(cachedConversations: [cachedConversation(local)])
    await service.enqueueRename(.failure(.notFound), gate: responseGate)
    let feature = makeFeature(service: service)
    let lifecycle = ConversationLifecycleChangeProbe()
    feature.consume(snapshot(connection: .online, conversations: [cachedConversation(local)]))
    await feature.start()
    feature.setLifecycleChangeHandler { changes in
      await lifecycle.record(changes)
      return .ignored
    }

    let rename = Task { await feature.rename(id: local.id, title: "Rename") }
    await responseGate.waitUntilWaiting()
    feature.consume(snapshot(connection: .online, conversations: [cachedConversation(revived)]))
    await responseGate.release()
    await rename.value

    #expect(feature.conversations.map(\.summary) == [revived])
    #expect(feature.mutationError == .revisionConflict(current: revived))
    #expect(await service.removedIDs.isEmpty)
    #expect(await lifecycle.changes.isEmpty)
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

  @Test("a snapshot cannot replace a newer active row with stale or equal tombstones")
  func snapshotRejectsNonNewerTombstones() async {
    let active = summary(id: "conversation", title: "Active", revision: 6)
    let staleTombstone = summary(
      id: active.id,
      title: active.title,
      revision: 5,
      status: .deleted
    )
    let equalTombstone = summary(
      id: active.id,
      title: active.title,
      revision: active.revision,
      status: .deleted
    )
    let feature = makeFeature(service: FakeConversationListService())
    feature.consume(snapshot(connection: .online, conversations: [cachedConversation(active)]))

    feature.consume(
      snapshot(connection: .online, conversations: [cachedConversation(staleTombstone)])
    )
    #expect(feature.conversations.map(\.summary) == [active])

    feature.consume(
      snapshot(connection: .online, conversations: [cachedConversation(equalTombstone)])
    )
    #expect(feature.conversations.map(\.summary) == [active])
  }

  @Test("a deleted canonical snapshot row suppresses the visible row without a removal ID")
  func deletedCanonicalSnapshotSuppressesVisibleRow() async {
    let local = summary(id: "deleted", title: "Delete me", revision: 2)
    let tombstone = summary(
      id: local.id,
      title: local.title,
      revision: 3,
      status: .deleted
    )
    let feature = makeFeature(service: FakeConversationListService())
    feature.consume(snapshot(connection: .online, conversations: [cachedConversation(local)]))

    feature.consume(snapshot(connection: .online, conversations: [cachedConversation(tombstone)]))

    #expect(feature.conversations.isEmpty)
  }

  @Test("an equal-revision active snapshot cannot override a canonical tombstone")
  func equalRevisionSnapshotDoesNotResurrectDeletedRow() async {
    let tombstone = summary(id: "deleted", revision: 3, status: .deleted)
    let equalRevisionActive = summary(id: tombstone.id, revision: tombstone.revision)
    let feature = makeFeature(service: FakeConversationListService())
    feature.consume(snapshot(connection: .online, conversations: [cachedConversation(tombstone)]))

    feature.consume(
      snapshot(connection: .online, conversations: [cachedConversation(equalRevisionActive)])
    )

    #expect(feature.conversations.isEmpty)
  }

  @Test("a strictly newer active snapshot revives a canonical tombstone")
  func newerActiveSnapshotRevivesDeletedRow() async {
    let tombstone = summary(id: "deleted", revision: 3, status: .deleted)
    let revived = summary(id: tombstone.id, title: "Revived", revision: 4)
    let feature = makeFeature(service: FakeConversationListService())
    feature.consume(snapshot(connection: .online, conversations: [cachedConversation(tombstone)]))

    feature.consume(snapshot(connection: .online, conversations: [cachedConversation(revived)]))

    #expect(feature.conversations.map(\.summary) == [revived])
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

  @Test("an explicit sync removal wins over an active row in the same snapshot")
  func explicitSyncRemovalWinsOverSameSnapshotRow() async {
    let local = summary(id: "removed", revision: 2)
    let service = FakeConversationListService(cachedConversations: [cachedConversation(local)])
    let feature = makeFeature(service: service)
    feature.consume(snapshot(connection: .online, conversations: [cachedConversation(local)]))

    feature.consume(
      SyncSnapshot(
        connection: .online,
        conversations: [cachedConversation(local)],
        agents: [],
        lastSuccessfulSyncAt: Date(timeIntervalSince1970: 200),
        removedConversationIDs: [local.id]
      )
    )

    #expect(feature.conversations.isEmpty)
  }

  @Test("a later active canonical snapshot revives an explicitly removed row")
  func activeCanonicalSnapshotRevivesRemovedRow() async {
    let removed = summary(id: "revived", revision: 2)
    let revived = summary(id: removed.id, title: "Revived", revision: 3)
    let feature = makeFeature(service: FakeConversationListService())

    feature.consume(
      SyncSnapshot(
        connection: .online,
        conversations: [],
        agents: [],
        lastSuccessfulSyncAt: Date(timeIntervalSince1970: 200),
        removedConversationIDs: [removed.id]
      )
    )
    feature.consume(
      snapshot(connection: .online, conversations: [cachedConversation(revived)])
    )

    #expect(feature.conversations.map(\.summary) == [revived])
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
    recoveryService: any ConversationRecoveryServicing = FakeConversationRecoveryService(),
    recoveryChanges: any ConversationRecoveryChangeStreaming = ConversationRecoveryChangeSignal(),
    lastUsedAgentStore: any LastUsedAgentStoring = FakeLastUsedAgentStore(),
    gatewayID: String = "gateway-1",
    requestID: @escaping @Sendable () -> UUID = { UUID() }
  ) -> ConversationListFeature {
    ConversationListFeature(
      gatewayID: gatewayID,
      service: service,
      recoveryService: recoveryService,
      recoveryChanges: recoveryChanges,
      lastUsedAgentStore: lastUsedAgentStore,
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

/// Audit #9 (iOS conversation search): `ConversationSearchFilter.apply` is
/// the pure function `ConversationListView`'s `.searchable` filtering
/// delegates to.
@Suite("ConversationSearchFilter (audit #9)")
struct ConversationSearchFilterTests {
  @Test("an empty or whitespace-only query returns every conversation, unfiltered")
  func emptyQueryReturnsAll() {
    let conversations = [
      searchFixture(id: "a", title: "Launch plan", preview: "ship it"),
      searchFixture(id: "b", title: "Budget review", preview: "numbers"),
    ]
    #expect(ConversationSearchFilter.apply(conversations, query: "").map(\.id) == ["a", "b"])
    #expect(ConversationSearchFilter.apply(conversations, query: "   ").map(\.id) == ["a", "b"])
  }

  @Test("matches on title, case-insensitively")
  func matchesTitleCaseInsensitively() {
    let conversations = [
      searchFixture(id: "a", title: "Launch Plan", preview: "n/a"),
      searchFixture(id: "b", title: "Budget review", preview: "n/a"),
    ]
    #expect(ConversationSearchFilter.apply(conversations, query: "launch").map(\.id) == ["a"])
  }

  @Test("matches on lastMessagePreview, case-insensitively, when the title doesn't match")
  func matchesPreviewCaseInsensitively() {
    let conversations = [
      searchFixture(id: "a", title: "Launch plan", preview: "Ship it Friday"),
      searchFixture(id: "b", title: "Budget review", preview: "Numbers look good"),
    ]
    #expect(ConversationSearchFilter.apply(conversations, query: "FRIDAY").map(\.id) == ["a"])
  }

  @Test("a conversation with no lastMessagePreview never crashes and simply doesn't match on it")
  func nilPreviewIsSkippedSafely() {
    let conversations = [searchFixture(id: "a", title: "Launch plan", preview: nil)]
    #expect(ConversationSearchFilter.apply(conversations, query: "anything").isEmpty)
    #expect(ConversationSearchFilter.apply(conversations, query: "launch").map(\.id) == ["a"])
  }

  @Test("a query matching neither title nor preview returns an empty result")
  func noMatchReturnsEmpty() {
    let conversations = [searchFixture(id: "a", title: "Launch plan", preview: "ship it")]
    #expect(ConversationSearchFilter.apply(conversations, query: "budget").isEmpty)
  }

  private func searchFixture(
    id: String,
    title: String,
    preview: String?
  ) -> CachedConversation {
    CachedConversation(
      gatewayID: "gateway-1",
      summary: ConversationSummaryDTO(
        id: id,
        agentId: "agent-1",
        agentName: "Agent",
        title: title,
        revision: 1,
        status: .idle,
        activeTurnId: nil,
        owningIssueId: nil,
        projectId: nil,
        lastSeq: 0,
        lastMessagePreview: preview,
        createdAt: Date(timeIntervalSince1970: 10),
        updatedAt: Date(timeIntervalSince1970: 20),
        deletedAt: nil
      )
    )
  }
}

/// Compose-first new chat (Task 3, audit #16): `ComposeAgentSelection.resolve`
/// is the pure function `ConversationListView.startCompose()` delegates the
/// agent choice to.
@Suite("ComposeAgentSelection (Task 3, audit #16)")
struct ComposeAgentSelectionTests {
  @Test("prefers the last-used agent when it's still available")
  func prefersLastUsedAgent() {
    let agents = [
      agentFixture(id: "agent-a", name: "Agent A"),
      agentFixture(id: "agent-b", name: "Agent B"),
    ]
    #expect(
      ComposeAgentSelection.resolve(availableAgents: agents, lastUsedAgentID: "agent-b")
        == "agent-b"
    )
  }

  @Test("falls back to the first available agent when nothing has been recorded yet")
  func fallsBackToFirstWhenNoLastUsedAgent() {
    let agents = [
      agentFixture(id: "agent-a", name: "Agent A"),
      agentFixture(id: "agent-b", name: "Agent B"),
    ]
    #expect(
      ComposeAgentSelection.resolve(availableAgents: agents, lastUsedAgentID: nil) == "agent-a"
    )
  }

  /// The brief called for this explicitly (review fix, minor): the
  /// persisted last-used agent id may name an agent that's since been
  /// deleted or disabled (so it's no longer in `availableAgents`, which is
  /// already filtered to `status != .disabled`) — that's a stale
  /// preference, not an error, so this falls back exactly like the
  /// nothing-recorded-yet case rather than producing no selection at all.
  @Test("falls back to the first available agent when the persisted agent no longer exists")
  func fallsBackToFirstWhenLastUsedAgentIsGone() {
    let agents = [
      agentFixture(id: "agent-a", name: "Agent A"),
      agentFixture(id: "agent-b", name: "Agent B"),
    ]
    #expect(
      ComposeAgentSelection.resolve(availableAgents: agents, lastUsedAgentID: "agent-deleted")
        == "agent-a"
    )
  }

  @Test("returns nil when there are no available agents at all")
  func returnsNilWithNoAgents() {
    #expect(ComposeAgentSelection.resolve(availableAgents: [], lastUsedAgentID: "agent-a") == nil)
  }

  private func agentFixture(id: String, name: String) -> RegisteredAgentDTO {
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

private actor FakeConversationRecoveryService: ConversationRecoveryServicing {
  private var values: [RecoverablePendingSend]
  private(set) var discarded: [RecoverablePendingSend] = []
  private(set) var recoverableCallCount = 0
  private var recoverableCallObservers:
    [(count: Int, continuation: CheckedContinuation<Void, Never>)] = []
  private var nextRecoverableGate: TestGate?
  private var nextDiscardGate: TestGate?

  init(values: [RecoverablePendingSend] = []) {
    self.values = values
  }

  func recoverablePendingSends() async -> [RecoverablePendingSend] {
    recoverableCallCount += 1
    let ready = recoverableCallObservers.filter { $0.count <= recoverableCallCount }
    recoverableCallObservers.removeAll { $0.count <= recoverableCallCount }
    for observer in ready {
      observer.continuation.resume()
    }
    let gate = nextRecoverableGate
    nextRecoverableGate = nil
    await gate?.wait()
    return values
  }

  func gateNextRecoverableCall(_ gate: TestGate) {
    nextRecoverableGate = gate
  }

  func gateNextDiscard(_ gate: TestGate) {
    nextDiscardGate = gate
  }

  func waitUntilRecoverableCallCount(_ count: Int) async {
    guard recoverableCallCount < count else { return }
    await withCheckedContinuation { continuation in
      recoverableCallObservers.append((count: count, continuation: continuation))
    }
  }

  func discard(_ recovery: RecoverablePendingSend) async -> Bool {
    discarded.append(recovery)
    let gate = nextDiscardGate
    nextDiscardGate = nil
    await gate?.wait()
    let count = values.count
    values.removeAll {
      $0.conversationID == recovery.conversationID
        && $0.pendingSend.turnID == recovery.pendingSend.turnID
    }
    return values.count < count
  }
}

private actor CoordinatedRecoveryChangeSource: ConversationRecoveryChangeStreaming {
  private let acquisitionGate = TestGate()
  private let signal: ConversationRecoveryChangeSignal
  private let releaseOnSecondAcquisition: Bool
  private var acquisitionObservers:
    [(count: Int, continuation: CheckedContinuation<Void, Never>)] = []
  private(set) var acquisitionCount = 0

  init(
    signal: ConversationRecoveryChangeSignal,
    releaseOnSecondAcquisition: Bool = false
  ) {
    self.signal = signal
    self.releaseOnSecondAcquisition = releaseOnSecondAcquisition
  }

  func subscription(gatewayID: String) async -> ConversationRecoveryChangeSubscription {
    acquisitionCount += 1
    let ready = acquisitionObservers.filter { $0.count <= acquisitionCount }
    acquisitionObservers.removeAll { $0.count <= acquisitionCount }
    for observer in ready {
      observer.continuation.resume()
    }
    if releaseOnSecondAcquisition, acquisitionCount == 2 {
      await acquisitionGate.release()
    }
    await acquisitionGate.wait()
    return await signal.subscription(gatewayID: gatewayID)
  }

  func waitUntilAcquisitionCount(_ count: Int) async {
    guard acquisitionCount < count else { return }
    await withCheckedContinuation { continuation in
      acquisitionObservers.append((count: count, continuation: continuation))
    }
  }

  func releaseAcquisition() async {
    await acquisitionGate.release()
  }
}

private actor GatedCancellationRecoveryChangeSource: ConversationRecoveryChangeStreaming {
  private let signal: ConversationRecoveryChangeSignal
  private let cancellationGate: TestGate

  init(signal: ConversationRecoveryChangeSignal, cancellationGate: TestGate) {
    self.signal = signal
    self.cancellationGate = cancellationGate
  }

  func subscription(gatewayID: String) async -> ConversationRecoveryChangeSubscription {
    let subscription = await signal.subscription(gatewayID: gatewayID)
    let cancellationGate = cancellationGate
    return ConversationRecoveryChangeSubscription(
      changes: subscription.changes,
      cancelAction: {
        await cancellationGate.wait()
        await subscription.cancel()
      }
    )
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
  private var conversationResults: [GatedMutationResult] = []
  private var createResults: [FakeListResult<ConversationSummaryDTO>] = []
  private var reconcileResults: [FakeListResult<ConversationSummaryDTO>] = []
  private var renameResults: [GatedMutationResult] = []
  private var deleteResults: [GatedMutationResult] = []
  private var replaceResults: [GatedMutationResult] = []
  private var clearRetainedCreateGate: TestGate?
  private let shutdownGate: TestGate?

  private(set) var pageCalls: [PageCall] = []
  private(set) var conversationCalls: [String] = []
  private(set) var createRequests: [CreateConversationRequest] = []
  private(set) var reconcileRequests: [CreateConversationRequest] = []
  private(set) var renameCalls: [RenameCall] = []
  private(set) var deleteCalls: [DeleteCall] = []
  private(set) var removedIDs: [String] = []
  private(set) var refreshAgentCallCount = 0
  private(set) var shutdownCallCount = 0
  private var retainedCreateIDs: [String: String] = [:]

  init(
    cachedConversations: [CachedConversation] = [],
    cachedAgents: [RegisteredAgentDTO] = [],
    pageGate: TestGate? = nil,
    shutdownGate: TestGate? = nil
  ) {
    cachedConversationValues = cachedConversations
    cachedAgentValues = cachedAgents
    self.pageGate = pageGate
    self.shutdownGate = shutdownGate
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

  func enqueueConversation(
    _ result: FakeListResult<ConversationSummaryDTO>,
    gate: TestGate? = nil
  ) {
    conversationResults.append(GatedMutationResult(result: result, gate: gate))
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

  func enqueueReplace(
    _ result: FakeListResult<ConversationSummaryDTO>,
    gate: TestGate? = nil
  ) {
    replaceResults.append(GatedMutationResult(result: result, gate: gate))
  }

  func gateNextClearRetainedCreateRequestID(_ gate: TestGate) {
    clearRetainedCreateGate = gate
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

  func conversation(id: String) async throws -> ConversationSummaryDTO {
    conversationCalls.append(id)
    guard conversationResults.isEmpty == false else { throw GatewayError.updateRequired }
    let queued = conversationResults.removeFirst()
    await queued.gate?.wait()
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

  func replace(_ summary: ConversationSummaryDTO) async throws -> ConversationSummaryDTO {
    guard replaceResults.isEmpty == false else { return summary }
    let queued = replaceResults.removeFirst()
    await queued.gate?.wait()
    return try queued.result.get()
  }

  func remove(
    id: String,
    expectedCanonical: ConversationSummaryDTO
  ) -> ConversationRemovalOutcome {
    removedIDs.append(id)
    _ = expectedCanonical
    return .removed
  }

  func retainedCreateRequestID(agentID: String, suggested: String) -> String {
    if let retained = retainedCreateIDs[agentID] { return retained }
    retainedCreateIDs[agentID] = suggested
    return suggested
  }

  func clearRetainedCreateRequestID(agentID: String) async {
    let gate = clearRetainedCreateGate
    clearRetainedCreateGate = nil
    await gate?.wait()
    retainedCreateIDs[agentID] = nil
  }

  func shutdown() async {
    shutdownCallCount += 1
    await shutdownGate?.wait()
  }
}

/// Compose-first new chat (Task 3, audit #16): in-memory `LastUsedAgentStoring`
/// fake — mirrors `LastUsedAgentStore`'s real per-gateway `UserDefaults`
/// scoping without touching real UserDefaults from a unit test.
private actor FakeLastUsedAgentStore: LastUsedAgentStoring {
  private var values: [String: String] = [:]

  func agentID(gatewayID: String) -> String? {
    values[gatewayID]
  }

  func setAgentID(_ agentID: String, gatewayID: String) {
    values[gatewayID] = agentID
  }
}

private actor ConversationLifecycleChangeProbe {
  private(set) var changes: [ConversationLifecycleChange] = []

  func record(_ values: [ConversationLifecycleChange]) {
    changes.append(contentsOf: values)
  }
}

private actor ShutdownCompletionProbe {
  private(set) var count = 0

  func record() {
    count += 1
  }
}
