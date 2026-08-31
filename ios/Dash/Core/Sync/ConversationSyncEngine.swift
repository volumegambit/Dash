import Foundation

protocol ConversationSyncAPI: Sendable {
  func listAgents() async throws -> [RegisteredAgentDTO]
  func conversations(
    agentId: String?,
    limit: Int,
    cursor: String?
  ) async throws -> ConversationPageDTO
  func conversation(id: String) async throws -> ConversationSummaryDTO
  func messages(
    conversationID: String,
    limit: Int,
    before: String?
  ) async throws -> ConversationMessagePageDTO
  func replay(
    agentID: String,
    conversationID: String,
    sinceSeq: Int
  ) async throws -> ReplayPageDTO
  func createConversation(
    _ request: CreateConversationRequest
  ) async throws -> ConversationSummaryDTO
}

extension GatewayAPI: ConversationSyncAPI {}

protocol GatewayInvalidationStreaming: Sendable {
  func eventStream() async -> AsyncThrowingStream<GatewayInvalidationEvent, Error>
}

struct SSEInvalidationSource: GatewayInvalidationStreaming, Sendable {
  let client: SSEClient

  func eventStream() async -> AsyncThrowingStream<GatewayInvalidationEvent, Error> {
    await client.events()
  }
}

protocol ConversationChatting: Sendable {
  func suspend() async
  func shutdown() async
}

extension ChatConnection: ConversationChatting {
  func shutdown() async {
    detach()
  }
}

enum GatewayConnectionState: Equatable, Sendable {
  case connecting
  case online
  case reconnecting(attempt: Int, retryAt: Date)
  case offline
  case gatewayOffline
  case rateLimited(retryAt: Date)
  case repairRequired
  case updateRequired
}

struct SyncSnapshot: Equatable, Sendable {
  let connection: GatewayConnectionState
  let conversations: [CachedConversation]
  let agents: [RegisteredAgentDTO]
  let lastSuccessfulSyncAt: Date?
  let removedConversationIDs: Set<String>

  init(
    connection: GatewayConnectionState,
    conversations: [CachedConversation],
    agents: [RegisteredAgentDTO],
    lastSuccessfulSyncAt: Date?,
    removedConversationIDs: Set<String> = []
  ) {
    self.connection = connection
    self.conversations = conversations
    self.agents = agents
    self.lastSuccessfulSyncAt = lastSuccessfulSyncAt
    self.removedConversationIDs = removedConversationIDs
  }

  var mutationsAllowed: Bool { connection == .online }
}

actor ConversationSyncEngine {
  private struct MessageLoadToken: Equatable, Sendable {
    let conversationID: String
    let generation: Int
    let lifecycle: Int
  }

  private let gatewayID: String
  private let store: PersistenceStore
  private let api: any ConversationSyncAPI
  private let invalidations: any GatewayInvalidationStreaming
  private let chat: any ConversationChatting
  private let reachability: any ReachabilityStreaming
  private let clock: any AppClock
  private let pageSize: Int
  private let backoff = BackoffPolicy()
  private let stream: AsyncStream<SyncSnapshot>
  private let continuation: AsyncStream<SyncSnapshot>.Continuation

  private var connection: GatewayConnectionState = .connecting
  private var snapshotConversations: [CachedConversation] = []
  private var snapshotAgents: [RegisteredAgentDTO] = []
  private var pendingRemovedConversationIDs: Set<String> = []
  private var lastSuccessfulSyncAt: Date?
  private var conversationOrder: [String] = []
  private var conversationCursor: String?
  private var messageCursors: [String: String] = [:]
  private var reconcilers: [String: SequenceReconciler] = [:]
  private var invalidationTask: Task<Void, Never>?
  private var reconnectTask: Task<Void, Never>?
  private var reachabilityTask: Task<Void, Never>?
  private var reconnectAttempt = 0
  private var isShutdown = false
  private var lifecycleGeneration = 0
  private var sceneGeneration = 0
  private var conversationGeneration = 0
  private var conversationResetGeneration: Int?
  private var olderConversationGeneration: Int?
  private var messageGenerations: [String: Int] = [:]
  private var messageResetTokens: [String: MessageLoadToken] = [:]
  private var olderMessageTokens: [String: MessageLoadToken] = [:]

  init(
    gatewayID: String,
    store: PersistenceStore,
    api: any ConversationSyncAPI,
    invalidations: any GatewayInvalidationStreaming,
    chat: any ConversationChatting,
    reachability: any ReachabilityStreaming,
    clock: any AppClock = SystemAppClock(),
    pageSize: Int = 50
  ) {
    self.gatewayID = gatewayID
    self.store = store
    self.api = api
    self.invalidations = invalidations
    self.chat = chat
    self.reachability = reachability
    self.clock = clock
    self.pageSize = pageSize
    let pair = AsyncStream<SyncSnapshot>.makeStream()
    stream = pair.stream
    continuation = pair.continuation
  }

  func snapshots() -> AsyncStream<SyncSnapshot> {
    stream
  }

  func bootstrap() async {
    guard isShutdown == false else { return }
    let lifecycle = lifecycleGeneration
    conversationGeneration += 1
    let conversations = conversationGeneration
    conversationResetGeneration = conversations
    olderConversationGeneration = nil
    defer {
      if conversationResetGeneration == conversations {
        conversationResetGeneration = nil
      }
    }
    do {
      try await reloadSnapshot(lifecycle: lifecycle, conversations: conversations)
      try validate(lifecycle: lifecycle, conversations: conversations)
      publish(.connecting)
      startReachability()
      let agents = try await api.listAgents()
      try validate(lifecycle: lifecycle, conversations: conversations)
      try await store.replaceAgents(agents, gatewayID: gatewayID)
      try validate(lifecycle: lifecycle, conversations: conversations)
      try await refreshConversationsFromNetwork(
        reset: true,
        lifecycle: lifecycle,
        conversations: conversations
      )
      try await recordSuccessfulSync(lifecycle: lifecycle, conversations: conversations)
      try validate(lifecycle: lifecycle, conversations: conversations)
      reconnectAttempt = 0
      try await reloadSnapshot(lifecycle: lifecycle, conversations: conversations)
      try validate(lifecycle: lifecycle, conversations: conversations)
      publish(.online)
      startInvalidations()
    } catch is CancellationError {
      return
    } catch {
      await handle(error, lifecycle: lifecycle, conversations: conversations)
    }
  }

  func refreshConversations(reset: Bool) async {
    guard isShutdown == false else { return }
    let conversations: Int
    if reset {
      conversationGeneration += 1
      conversations = conversationGeneration
      conversationResetGeneration = conversations
      olderConversationGeneration = nil
    } else {
      guard
        conversationCursor != nil,
        conversationResetGeneration == nil,
        olderConversationGeneration == nil
      else { return }
      conversations = conversationGeneration
      olderConversationGeneration = conversations
    }
    let lifecycle = lifecycleGeneration
    defer {
      if reset {
        if conversationResetGeneration == conversations {
          conversationResetGeneration = nil
        }
      } else if olderConversationGeneration == conversations {
        olderConversationGeneration = nil
      }
    }
    do {
      if reset {
        let agents = try await api.listAgents()
        try validate(lifecycle: lifecycle, conversations: conversations)
        try await store.replaceAgents(agents, gatewayID: gatewayID)
        try validate(lifecycle: lifecycle, conversations: conversations)
      }
      try await refreshConversationsFromNetwork(
        reset: reset,
        lifecycle: lifecycle,
        conversations: conversations
      )
      try await recordSuccessfulSync(lifecycle: lifecycle, conversations: conversations)
      try validate(lifecycle: lifecycle, conversations: conversations)
      reconnectAttempt = 0
      try await reloadSnapshot(lifecycle: lifecycle, conversations: conversations)
      try validate(lifecycle: lifecycle, conversations: conversations)
      publish(.online)
      startInvalidations()
    } catch is CancellationError {
      return
    } catch {
      await handle(error, lifecycle: lifecycle, conversations: conversations)
    }
  }

  func loadOlderConversations() async {
    await refreshConversations(reset: false)
  }

  func refreshConversation(id: String) async {
    guard isShutdown == false else { return }
    let lifecycle = lifecycleGeneration
    let conversations = conversationGeneration
    do {
      let requestStartCanonical = try await store.conversation(
        gatewayID: gatewayID,
        id: id
      )?.summary
      try validate(lifecycle: lifecycle, conversations: conversations)
      do {
        let summary = try await api.conversation(id: id)
        try validate(lifecycle: lifecycle, conversations: conversations)
        _ = try await persist(summary, lifecycle: lifecycle, conversations: conversations)
        try await recordSuccessfulSync(lifecycle: lifecycle, conversations: conversations)
        try validate(lifecycle: lifecycle, conversations: conversations)
        try await reloadSnapshot(lifecycle: lifecycle, conversations: conversations)
        try validate(lifecycle: lifecycle, conversations: conversations)
        publish(.online)
      } catch GatewayError.notFound {
        _ = try await reconcileNotFoundRemoval(
          conversationID: id,
          requestStartCanonical: requestStartCanonical,
          lifecycle: lifecycle,
          conversations: conversations
        )
        try await reloadSnapshot(lifecycle: lifecycle, conversations: conversations)
        try validate(lifecycle: lifecycle, conversations: conversations)
        publish(.online)
      }
    } catch is CancellationError {
      return
    } catch {
      await handle(error, lifecycle: lifecycle, conversations: conversations)
    }
  }

  func loadMessages(conversationID: String, reset: Bool) async {
    guard isShutdown == false else { return }
    let lifecycle = lifecycleGeneration
    let conversations = conversationGeneration
    let messages: MessageLoadToken
    if reset {
      messages = beginMessageReset(conversationID: conversationID)
    } else {
      guard let older = beginOlderMessageLoad(conversationID: conversationID) else { return }
      messages = older
    }
    defer {
      if reset {
        finishMessageReset(messages)
      } else {
        finishOlderMessageLoad(messages)
      }
    }
    do {
      _ = try await loadMessagesFromNetwork(
        conversationID: conversationID,
        reset: reset,
        lifecycle: lifecycle,
        conversations: conversations,
        messages: messages
      )
      try await reloadSnapshot(lifecycle: lifecycle, conversations: conversations)
      try validate(
        lifecycle: lifecycle,
        conversations: conversations,
        messages: messages
      )
      publish(.online)
    } catch PersistenceStoreError.conversationDeleted {
      return
    } catch is CancellationError {
      return
    } catch {
      await handle(
        error,
        lifecycle: lifecycle,
        conversations: conversations,
        messages: messages
      )
    }
  }

  func loadOlderMessages(conversationID: String) async {
    await loadMessages(conversationID: conversationID, reset: false)
  }

  func consumeLiveFrame(_ frame: MobileWSServerFrame, agentID: String) async {
    guard isShutdown == false else { return }
    let lifecycle = lifecycleGeneration
    let conversations = conversationGeneration
    var messages: MessageLoadToken?
    defer {
      if let messages {
        finishMessageReset(messages)
      }
    }
    do {
      let capable = try CapableServerFrame.validating(frame)
      guard let sequenced = capable.sequenced else { return }
      let storedCursor = try await store.cursor(
        gatewayID: gatewayID,
        conversationID: sequenced.conversationID
      )
      try validate(lifecycle: lifecycle, conversations: conversations)
      var reconciler =
        reconcilers[sequenced.conversationID]
        ?? SequenceReconciler(lastAppliedSeq: storedCursor)
      switch reconciler.accept(seq: sequenced.seq) {
      case .duplicate:
        return
      case .contiguous:
        break
      case .gap(let sinceSeq, _):
        let replay = try await api.replay(
          agentID: agentID,
          conversationID: sequenced.conversationID,
          sinceSeq: sinceSeq
        )
        try validate(lifecycle: lifecycle, conversations: conversations)
        var replayReconciler = SequenceReconciler(lastAppliedSeq: sinceSeq)
        for entry in replay.entries {
          guard
            entry.agentId == agentID,
            entry.conversationId == sequenced.conversationID
          else {
            throw GatewayError.updateRequired
          }
          switch replayReconciler.accept(seq: entry.seq) {
          case .duplicate, .contiguous:
            break
          case .gap:
            throw GatewayError.updateRequired
          }
        }
        switch replayReconciler.accept(seq: sequenced.seq) {
        case .duplicate, .contiguous:
          break
        case .gap:
          throw GatewayError.updateRequired
        }
      }

      let messageReset = beginMessageReset(conversationID: sequenced.conversationID)
      messages = messageReset
      let page = try await loadMessagesFromNetwork(
        conversationID: sequenced.conversationID,
        reset: true,
        lifecycle: lifecycle,
        conversations: conversations,
        messages: messageReset
      )
      guard page.throughSeq >= sequenced.seq else {
        throw GatewayError.updateRequired
      }
      reconcilers[sequenced.conversationID] = SequenceReconciler(
        lastAppliedSeq: page.throughSeq
      )
      try await reloadSnapshot(lifecycle: lifecycle, conversations: conversations)
      try validate(lifecycle: lifecycle, conversations: conversations)
      publish(.online)
    } catch PersistenceStoreError.conversationDeleted {
      return
    } catch is CancellationError {
      return
    } catch {
      await handle(
        error,
        lifecycle: lifecycle,
        conversations: conversations,
        messages: messages
      )
    }
  }

  func sceneDidEnterBackground() async {
    guard isShutdown == false else { return }
    sceneGeneration += 1
    let scene = sceneGeneration
    lifecycleGeneration += 1
    conversationGeneration += 1
    conversationResetGeneration = nil
    olderConversationGeneration = nil
    messageResetTokens.removeAll()
    olderMessageTokens.removeAll()
    let invalidation = invalidationTask
    let reconnect = reconnectTask
    invalidation?.cancel()
    invalidationTask = nil
    reconnect?.cancel()
    reconnectTask = nil
    await invalidation?.value
    await reconnect?.value
    guard isShutdown == false, scene == sceneGeneration else { return }
    await chat.suspend()
  }

  func sceneWillEnterForeground() async {
    guard isShutdown == false else { return }
    sceneGeneration += 1
    conversationGeneration += 1
    let lifecycle = lifecycleGeneration
    let conversations = conversationGeneration
    conversationResetGeneration = conversations
    olderConversationGeneration = nil
    var messages: MessageLoadToken?
    defer {
      if conversationResetGeneration == conversations {
        conversationResetGeneration = nil
      }
      if let messages {
        finishMessageReset(messages)
      }
    }
    startReachability()
    startInvalidations()
    do {
      let agents = try await api.listAgents()
      try validate(lifecycle: lifecycle, conversations: conversations)
      try await store.replaceAgents(agents, gatewayID: gatewayID)
      try validate(lifecycle: lifecycle, conversations: conversations)
      let activeConversations = try await refreshAllConversationsFromNetwork(
        lifecycle: lifecycle,
        conversations: conversations
      )
      for canonical in activeConversations {
        let messageReset = beginMessageReset(conversationID: canonical.id)
        messages = messageReset
        var authoritativeFailure: Error?
        do {
          _ = try await loadMessagesFromNetwork(
            conversationID: canonical.id,
            reset: true,
            lifecycle: lifecycle,
            conversations: conversations,
            messages: messageReset
          )
        } catch {
          if isIsolatedForegroundResourceFailure(error) == false {
            authoritativeFailure = error
          }
        }
        finishMessageReset(messageReset)
        messages = nil
        if let authoritativeFailure {
          throw authoritativeFailure
        }
      }
      try await recordSuccessfulSync(lifecycle: lifecycle, conversations: conversations)
      try validate(lifecycle: lifecycle, conversations: conversations)
      try await reloadSnapshot(lifecycle: lifecycle, conversations: conversations)
      try validate(lifecycle: lifecycle, conversations: conversations)
      publish(.online)
    } catch is CancellationError {
      return
    } catch {
      await handle(
        error,
        lifecycle: lifecycle,
        conversations: conversations,
        messages: messages
      )
    }
  }

  func createConversation(
    _ request: CreateConversationRequest
  ) async throws -> ConversationSummaryDTO {
    try requireOnlineMutation()
    let lifecycle = lifecycleGeneration
    do {
      do {
        return try await createAndPersist(request, lifecycle: lifecycle)
      } catch GatewayError.mutationOutcomeUnknown {
        try await clock.sleep(for: backoff.delay(attempt: 0, unitRandom: 0.5))
        try validate(lifecycle: lifecycle)
        _ = try await api.listAgents()
        try validate(lifecycle: lifecycle)
        return try await createAndPersist(request, lifecycle: lifecycle)
      }
    } catch is CancellationError {
      throw CancellationError()
    } catch {
      await handle(error, lifecycle: lifecycle)
      throw error
    }
  }

  func shutdown() async {
    guard isShutdown == false else { return }
    isShutdown = true
    sceneGeneration += 1
    lifecycleGeneration += 1
    conversationGeneration += 1
    conversationResetGeneration = nil
    olderConversationGeneration = nil
    messageResetTokens.removeAll()
    olderMessageTokens.removeAll()
    let invalidation = invalidationTask
    let reconnect = reconnectTask
    let reachable = reachabilityTask
    invalidation?.cancel()
    reconnect?.cancel()
    reachable?.cancel()
    invalidationTask = nil
    reconnectTask = nil
    reachabilityTask = nil
    await invalidation?.value
    await reconnect?.value
    await reachable?.value
    await chat.shutdown()
    continuation.finish()
  }

  private func refreshConversationsFromNetwork(
    reset: Bool,
    lifecycle: Int,
    conversations: Int
  ) async throws {
    let knownIDs =
      if reset {
        Set(try await store.conversations(gatewayID: gatewayID, limit: 1_000).map(\.id))
      } else {
        Set<String>()
      }
    try validate(lifecycle: lifecycle, conversations: conversations)
    let cursor = reset ? nil : conversationCursor
    let page = try await api.conversations(agentId: nil, limit: pageSize, cursor: cursor)
    try validate(lifecycle: lifecycle, conversations: conversations)
    var effectiveItems: [ConversationSummaryDTO] = []
    effectiveItems.reserveCapacity(page.items.count)
    for item in page.items {
      effectiveItems.append(
        try await persist(
        item,
        lifecycle: lifecycle,
        conversations: conversations
      )
      )
    }
    let pageIDs = effectiveItems.filter { $0.status != .deleted }.map(\.id)
    if reset {
      conversationOrder = pageIDs
    } else {
      let pagedIDs = Set(pageIDs)
      conversationOrder.removeAll { pagedIDs.contains($0) }
      conversationOrder.append(contentsOf: pageIDs)
    }
    conversationCursor = page.nextCursor

    guard reset else { return }
    let omitted = knownIDs.subtracting(Set(page.items.map(\.id))).sorted()
    for id in omitted {
      let requestStartCanonical = try await store.conversation(
        gatewayID: gatewayID,
        id: id
      )?.summary
      try validate(lifecycle: lifecycle, conversations: conversations)
      do {
        let canonical = try await api.conversation(id: id)
        try validate(lifecycle: lifecycle, conversations: conversations)
        let effective = try await persist(
          canonical,
          lifecycle: lifecycle,
          conversations: conversations
        )
        if effective.status != .deleted, conversationOrder.contains(id) == false {
          conversationOrder.append(id)
        }
      } catch GatewayError.notFound {
        _ = try await reconcileNotFoundRemoval(
          conversationID: id,
          requestStartCanonical: requestStartCanonical,
          lifecycle: lifecycle,
          conversations: conversations
        )
      }
    }
  }

  private func refreshAllConversationsFromNetwork(
    lifecycle: Int,
    conversations: Int
  ) async throws -> [ConversationSummaryDTO] {
    let knownIDs = Set(
      try await store.conversations(gatewayID: gatewayID, limit: Int.max).map(\.id)
    )
    try validate(lifecycle: lifecycle, conversations: conversations)

    var cursor: String?
    var seenCursors: Set<String> = []
    var canonicalIDs: Set<String> = []
    var canonicalOrder: [String] = []
    var activeByID: [String: ConversationSummaryDTO] = [:]
    repeat {
      let page = try await api.conversations(agentId: nil, limit: pageSize, cursor: cursor)
      try validate(lifecycle: lifecycle, conversations: conversations)
      for item in page.items {
        canonicalIDs.insert(item.id)
        let effective = try await persist(
          item,
          lifecycle: lifecycle,
          conversations: conversations
        )
        if effective.status != .deleted, canonicalOrder.contains(effective.id) == false {
          canonicalOrder.append(effective.id)
        }
        if effective.status == .running {
          activeByID[effective.id] = effective
        } else {
          activeByID[effective.id] = nil
        }
      }
      guard let nextCursor = page.nextCursor else {
        cursor = nil
        break
      }
      guard seenCursors.insert(nextCursor).inserted else {
        throw GatewayError.updateRequired
      }
      cursor = nextCursor
    } while true

    conversationOrder = canonicalOrder
    conversationCursor = nil

    let omitted = knownIDs.subtracting(canonicalIDs).sorted()
    for id in omitted {
      let requestStartCanonical = try await store.conversation(
        gatewayID: gatewayID,
        id: id
      )?.summary
      try validate(lifecycle: lifecycle, conversations: conversations)
      let canonical: ConversationSummaryDTO
      do {
        canonical = try await api.conversation(id: id)
        try validate(lifecycle: lifecycle, conversations: conversations)
      } catch GatewayError.notFound {
        let retained = try await reconcileNotFoundRemoval(
          conversationID: id,
          requestStartCanonical: requestStartCanonical,
          lifecycle: lifecycle,
          conversations: conversations
        )
        if retained?.status == .running {
          activeByID[id] = retained
        } else {
          activeByID[id] = nil
        }
        continue
      } catch {
        guard isIsolatedForegroundResourceFailure(error) else { throw error }
        continue
      }
      let effective = try await persist(
        canonical,
        lifecycle: lifecycle,
        conversations: conversations
      )
      if effective.status == .running {
        activeByID[effective.id] = effective
      } else {
        activeByID[effective.id] = nil
      }
    }

    return conversationOrder.compactMap { activeByID[$0] }
  }

  private func isIsolatedForegroundResourceFailure(_ error: Error) -> Bool {
    guard let error = error as? GatewayError else { return false }
    switch error {
    case .notFound, .validation, .revisionConflict, .conversationBusy, .server:
      return true
    case .unauthorized, .rateLimited, .gatewayOffline, .capabilityRequired, .updateRequired,
      .transport, .mutationOutcomeUnknown:
      return false
    }
  }

  private func loadMessagesFromNetwork(
    conversationID: String,
    reset: Bool,
    lifecycle: Int,
    conversations: Int?,
    messages: MessageLoadToken
  ) async throws -> ConversationMessagePageDTO {
    let before = reset ? nil : messageCursors[conversationID]
    let page = try await api.messages(
      conversationID: conversationID,
      limit: pageSize,
      before: before
    )
    try validate(lifecycle: lifecycle, conversations: conversations, messages: messages)
    try await store.mergeMessages(
      page.items,
      gatewayID: gatewayID,
      conversationID: conversationID
    )
    try validate(lifecycle: lifecycle, conversations: conversations, messages: messages)
    try await store.advanceCursor(
      gatewayID: gatewayID,
      conversationID: conversationID,
      to: page.throughSeq
    )
    try validate(lifecycle: lifecycle, conversations: conversations, messages: messages)
    let durableCursor = try await store.cursor(
      gatewayID: gatewayID,
      conversationID: conversationID
    )
    try validate(lifecycle: lifecycle, conversations: conversations, messages: messages)
    messageCursors[conversationID] = page.nextCursor
    reconcilers[conversationID] = SequenceReconciler(lastAppliedSeq: durableCursor)
    return page
  }

  private func persist(
    _ summary: ConversationSummaryDTO,
    lifecycle: Int,
    conversations: Int?
  ) async throws -> ConversationSummaryDTO {
    try validate(lifecycle: lifecycle, conversations: conversations)
    let effective = try await store.persistConversationAndReturnCanonical(
      summary,
      gatewayID: gatewayID
    ).summary
    if effective.status == .deleted {
      resetMessageSyncState(conversationID: effective.id)
    }
    try validate(lifecycle: lifecycle, conversations: conversations)
    if effective.status == .deleted {
      pendingRemovedConversationIDs.insert(effective.id)
      conversationOrder.removeAll { $0 == effective.id }
    } else {
      pendingRemovedConversationIDs.remove(effective.id)
      if conversationOrder.contains(effective.id) == false {
        conversationOrder.append(effective.id)
      }
    }
    return effective
  }

  private func createAndPersist(
    _ request: CreateConversationRequest,
    lifecycle: Int
  ) async throws -> ConversationSummaryDTO {
    let summary = try await api.createConversation(request)
    try validate(lifecycle: lifecycle)
    let persisted = try await persist(summary, lifecycle: lifecycle, conversations: nil)
    try await reloadSnapshot(lifecycle: lifecycle)
    try validate(lifecycle: lifecycle)
    publish(.online)
    return persisted
  }

  private func reloadSnapshot(lifecycle: Int, conversations: Int? = nil) async throws {
    try validate(lifecycle: lifecycle, conversations: conversations)
    let cached = try await store.conversations(gatewayID: gatewayID, limit: 1_000)
    try validate(lifecycle: lifecycle, conversations: conversations)
    let ordered: [CachedConversation]
    if conversationOrder.isEmpty {
      ordered = cached
    } else {
      let values = Dictionary(uniqueKeysWithValues: cached.map { ($0.id, $0) })
      var snapshot = conversationOrder.compactMap { values[$0] }
      for value in cached where conversationOrder.contains(value.id) == false {
        snapshot.append(value)
      }
      ordered = snapshot
    }
    let agents = try await store.agents(gatewayID: gatewayID)
    try validate(lifecycle: lifecycle, conversations: conversations)
    let lastSync = try await store.profile(gatewayID: gatewayID)?.profile.lastSuccessfulSyncAt
    try validate(lifecycle: lifecycle, conversations: conversations)
    snapshotConversations = ordered
    pendingRemovedConversationIDs.subtract(ordered.map(\.id))
    snapshotAgents = agents
    lastSuccessfulSyncAt = lastSync
  }

  private func recordSuccessfulSync(lifecycle: Int, conversations: Int? = nil) async throws {
    try validate(lifecycle: lifecycle, conversations: conversations)
    let now = await clock.now()
    try validate(lifecycle: lifecycle, conversations: conversations)
    try await store.markSuccessfulSync(gatewayID: gatewayID, at: now)
    try validate(lifecycle: lifecycle, conversations: conversations)
  }

  private func publish(_ state: GatewayConnectionState) {
    connection = state
    let removedConversationIDs = pendingRemovedConversationIDs
    pendingRemovedConversationIDs.removeAll()
    continuation.yield(
      SyncSnapshot(
        connection: state,
        conversations: snapshotConversations,
        agents: snapshotAgents,
        lastSuccessfulSyncAt: lastSuccessfulSyncAt,
        removedConversationIDs: removedConversationIDs
      )
    )
  }

  private func startInvalidations() {
    guard invalidationTask == nil, isShutdown == false else { return }
    let lifecycle = lifecycleGeneration
    invalidationTask = Task { [weak self] in
      guard let self else { return }
      let events = await self.invalidations.eventStream()
      do {
        for try await event in events {
          if Task.isCancelled { return }
          await self.consume(event)
        }
      } catch is CancellationError {
        return
      } catch {
        await self.invalidationFailed(error, lifecycle: lifecycle)
      }
    }
  }

  private func consume(_ event: GatewayInvalidationEvent) async {
    switch event {
    case .conversationChanged(let conversationID, _),
      .conversationDeleted(let conversationID, _):
      await refreshConversation(id: conversationID)
    }
  }

  private func invalidationFailed(_ error: Error, lifecycle: Int) async {
    guard isCurrent(lifecycle: lifecycle) else { return }
    invalidationTask = nil
    await handle(error, lifecycle: lifecycle)
  }

  private func startReachability() {
    guard reachabilityTask == nil, isShutdown == false else { return }
    let statuses = reachability.statuses()
    reachabilityTask = Task { [weak self] in
      for await status in statuses {
        if Task.isCancelled { return }
        await self?.reachabilityChanged(status)
      }
    }
  }

  private func reachabilityChanged(_ status: ReachabilityStatus) {
    guard isShutdown == false, connection.isAuthoritativeFailure == false else { return }
    switch status {
    case .satisfied:
      if connection == .offline {
        publish(.connecting)
      }
    case .unsatisfied, .requiresConnection:
      publish(.offline)
    }
  }

  private func requireOnlineMutation() throws {
    guard isShutdown == false, connection == .online else {
      throw GatewayError.transport("Mutations require an online gateway")
    }
  }

  private func handle(
    _ error: Error,
    lifecycle: Int,
    conversations: Int? = nil,
    messages: MessageLoadToken? = nil
  ) async {
    guard
      isCurrent(lifecycle: lifecycle, conversations: conversations, messages: messages)
    else { return }
    let gatewayError =
      error as? GatewayError
      ?? GatewayError.transport(error.localizedDescription)
    switch gatewayError {
    case .unauthorized:
      publish(.repairRequired)
    case .rateLimited(let retryAfter):
      let now = await clock.now()
      guard
        isCurrent(lifecycle: lifecycle, conversations: conversations, messages: messages)
      else { return }
      let delay = retryAfter ?? backoff.delay(attempt: 0, unitRandom: 0.5)
      publish(.rateLimited(retryAt: now.addingTimeInterval(delay.timeInterval)))
    case .gatewayOffline:
      publish(.gatewayOffline)
    case .updateRequired, .capabilityRequired:
      publish(.updateRequired)
    case .transport:
      scheduleReconnect(
        lifecycle: lifecycle,
        conversations: conversations,
        messages: messages
      )
    default:
      publish(.offline)
    }
  }

  private func scheduleReconnect(
    lifecycle: Int,
    conversations: Int? = nil,
    messages: MessageLoadToken? = nil
  ) {
    guard
      isCurrent(lifecycle: lifecycle, conversations: conversations, messages: messages)
    else { return }
    reconnectAttempt += 1
    let attempt = reconnectAttempt
    let delay = backoff.delay(attempt: attempt - 1, unitRandom: 0.5)
    let clock = clock
    reconnectTask?.cancel()
    reconnectTask = Task { [weak self] in
      guard let self else { return }
      let retryAt = (await clock.now()).addingTimeInterval(delay.timeInterval)
      await self.publishReconnect(
        attempt: attempt,
        retryAt: retryAt,
        lifecycle: lifecycle,
        conversations: conversations,
        messages: messages
      )
      do {
        try await clock.sleep(for: delay)
      } catch {
        return
      }
      if Task.isCancelled == false,
        await self.isCurrent(
          lifecycle: lifecycle,
          conversations: conversations,
          messages: messages
        )
      {
        await self.bootstrap()
      }
    }
  }

  private func publishReconnect(
    attempt: Int,
    retryAt: Date,
    lifecycle: Int,
    conversations: Int?,
    messages: MessageLoadToken?
  ) {
    guard
      isCurrent(lifecycle: lifecycle, conversations: conversations, messages: messages)
    else { return }
    publish(.reconnecting(attempt: attempt, retryAt: retryAt))
  }

  private func beginMessageReset(conversationID: String) -> MessageLoadToken {
    let generation = messageGenerations[conversationID, default: 0] + 1
    messageGenerations[conversationID] = generation
    let token = MessageLoadToken(
      conversationID: conversationID,
      generation: generation,
      lifecycle: lifecycleGeneration
    )
    messageResetTokens[conversationID] = token
    olderMessageTokens[conversationID] = nil
    return token
  }

  private func resetMessageSyncState(conversationID: String) {
    messageCursors[conversationID] = nil
    reconcilers[conversationID] = nil
    messageGenerations[conversationID, default: 0] &+= 1
    messageResetTokens[conversationID] = nil
    olderMessageTokens[conversationID] = nil
  }

  private func reconcileNotFoundRemoval(
    conversationID: String,
    requestStartCanonical: ConversationSummaryDTO?,
    lifecycle: Int,
    conversations: Int
  ) async throws -> ConversationSummaryDTO? {
    try validate(lifecycle: lifecycle, conversations: conversations)
    let outcome = try await store.removeConversationIfCanonicalUnchanged(
      gatewayID: gatewayID,
      conversationID: conversationID,
      expectedCanonical: requestStartCanonical
    )
    try validate(lifecycle: lifecycle, conversations: conversations)
    switch outcome {
    case .removed:
      resetMessageSyncState(conversationID: conversationID)
      pendingRemovedConversationIDs.insert(conversationID)
      conversationOrder.removeAll { $0 == conversationID }
      return nil

    case .retained(let current):
      if current.status == .deleted {
        resetMessageSyncState(conversationID: conversationID)
        pendingRemovedConversationIDs.insert(conversationID)
        conversationOrder.removeAll { $0 == conversationID }
      } else {
        pendingRemovedConversationIDs.remove(conversationID)
        if conversationOrder.contains(conversationID) == false {
          conversationOrder.append(conversationID)
        }
      }
      return current
    }
  }

  private func finishMessageReset(_ token: MessageLoadToken) {
    if messageResetTokens[token.conversationID] == token {
      messageResetTokens[token.conversationID] = nil
    }
  }

  private func beginOlderMessageLoad(conversationID: String) -> MessageLoadToken? {
    guard messageCursors[conversationID] != nil else { return nil }
    guard messageResetTokens[conversationID] == nil, olderMessageTokens[conversationID] == nil
    else { return nil }
    let token = MessageLoadToken(
      conversationID: conversationID,
      generation: messageGenerations[conversationID, default: 0],
      lifecycle: lifecycleGeneration
    )
    olderMessageTokens[conversationID] = token
    return token
  }

  private func finishOlderMessageLoad(_ token: MessageLoadToken) {
    if olderMessageTokens[token.conversationID] == token {
      olderMessageTokens[token.conversationID] = nil
    }
  }

  private func validate(
    lifecycle: Int,
    conversations: Int? = nil,
    messages: MessageLoadToken? = nil
  ) throws {
    guard
      isCurrent(lifecycle: lifecycle, conversations: conversations, messages: messages),
      Task.isCancelled == false
    else {
      throw CancellationError()
    }
  }

  private func isCurrent(
    lifecycle: Int,
    conversations: Int? = nil,
    messages: MessageLoadToken? = nil
  ) -> Bool {
    guard isShutdown == false, lifecycle == lifecycleGeneration else { return false }
    if let conversations, conversations != conversationGeneration { return false }
    if let messages {
      guard messages.lifecycle == lifecycleGeneration else { return false }
      guard messageGenerations[messages.conversationID, default: 0] == messages.generation else {
        return false
      }
    }
    return true
  }
}

extension GatewayConnectionState {
  fileprivate var isAuthoritativeFailure: Bool {
    switch self {
    case .gatewayOffline, .rateLimited, .repairRequired, .updateRequired:
      return true
    case .connecting, .online, .reconnecting, .offline:
      return false
    }
  }
}

extension CapableServerFrame {
  fileprivate var sequenced: (conversationID: String, seq: Int)? {
    switch self {
    case .accepted(_, let conversationID, _, _, _, let seq),
      .event(_, let conversationID, let seq, _),
      .done(_, let conversationID, let seq, _):
      return (conversationID, seq)
    case .error(_, let conversationID, let seq, _, _, _, _):
      guard let conversationID, let seq else { return nil }
      return (conversationID, seq)
    }
  }
}

extension Duration {
  fileprivate var timeInterval: TimeInterval {
    let components = self.components
    return TimeInterval(components.seconds) + (TimeInterval(components.attoseconds) / 1e18)
  }
}
