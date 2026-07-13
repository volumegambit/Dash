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
  func connect() async throws
  func sendTurn(
    id: String,
    agentID: String,
    conversationID: String,
    text: String,
    images: [MessageImage]
  ) async throws
  func resume(
    turnID: String,
    agentID: String,
    conversationID: String,
    sinceSeq: Int
  ) async throws
  func disconnect() async
}

extension ChatConnection: ConversationChatting {
  func disconnect() async {
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

  var mutationsAllowed: Bool { connection == .online }
}

actor ConversationSyncEngine {
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
  private var lastSuccessfulSyncAt: Date?
  private var conversationOrder: [String] = []
  private var conversationCursor: String?
  private var messageCursors: [String: String] = [:]
  private var reconcilers: [String: SequenceReconciler] = [:]
  private var invalidationTask: Task<Void, Never>?
  private var reconnectTask: Task<Void, Never>?
  private var reachabilityTask: Task<Void, Never>?
  private var reconnectAttempt = 0
  private var chatConnected = false
  private var isShutdown = false

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
    do {
      try await reloadSnapshot()
      publish(.connecting)
      startReachability()
      let agents = try await api.listAgents()
      try await store.replaceAgents(agents, gatewayID: gatewayID)
      try await refreshConversationsFromNetwork(reset: true)
      try await recordSuccessfulSync()
      reconnectAttempt = 0
      try await reloadSnapshot()
      publish(.online)
      startInvalidations()
    } catch {
      await handle(error)
    }
  }

  func refreshConversations(reset: Bool) async {
    guard isShutdown == false else { return }
    do {
      try await refreshConversationsFromNetwork(reset: reset)
      try await recordSuccessfulSync()
      reconnectAttempt = 0
      try await reloadSnapshot()
      publish(.online)
      startInvalidations()
    } catch {
      await handle(error)
    }
  }

  func loadOlderConversations() async {
    guard conversationCursor != nil else { return }
    await refreshConversations(reset: false)
  }

  func refreshConversation(id: String) async {
    guard isShutdown == false else { return }
    do {
      let summary = try await api.conversation(id: id)
      try await persist(summary)
      try await recordSuccessfulSync()
      try await reloadSnapshot()
      publish(.online)
    } catch GatewayError.notFound {
      do {
        try await store.removeConversation(gatewayID: gatewayID, conversationID: id)
        conversationOrder.removeAll { $0 == id }
        try await reloadSnapshot()
        publish(.online)
      } catch {
        await handle(error)
      }
    } catch {
      await handle(error)
    }
  }

  func loadMessages(conversationID: String, reset: Bool) async {
    guard isShutdown == false else { return }
    do {
      _ = try await loadMessagesFromNetwork(conversationID: conversationID, reset: reset)
      try await reloadSnapshot()
      publish(.online)
    } catch PersistenceStoreError.conversationDeleted {
      return
    } catch {
      await handle(error)
    }
  }

  func loadOlderMessages(conversationID: String) async {
    guard messageCursors[conversationID] != nil else { return }
    await loadMessages(conversationID: conversationID, reset: false)
  }

  func consumeLiveFrame(_ frame: MobileWSServerFrame, agentID: String) async {
    guard isShutdown == false else { return }
    do {
      let capable = try CapableServerFrame.validating(frame)
      guard let sequenced = capable.sequenced else { return }
      let storedCursor = try await store.cursor(
        gatewayID: gatewayID,
        conversationID: sequenced.conversationID
      )
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

      let page = try await loadMessagesFromNetwork(
        conversationID: sequenced.conversationID,
        reset: true
      )
      guard page.throughSeq >= sequenced.seq else {
        throw GatewayError.updateRequired
      }
      reconcilers[sequenced.conversationID] = SequenceReconciler(
        lastAppliedSeq: page.throughSeq
      )
      try await reloadSnapshot()
      publish(.online)
    } catch PersistenceStoreError.conversationDeleted {
      return
    } catch {
      await handle(error)
    }
  }

  func sceneDidEnterBackground() async {
    invalidationTask?.cancel()
    invalidationTask = nil
    reconnectTask?.cancel()
    reconnectTask = nil
    await chat.disconnect()
    chatConnected = false
  }

  func sceneWillEnterForeground() async {
    guard isShutdown == false else { return }
    startReachability()
    do {
      let cached = try await store.conversations(gatewayID: gatewayID, limit: 1_000)
      for value in cached {
        let canonical: ConversationSummaryDTO
        do {
          canonical = try await api.conversation(id: value.id)
        } catch GatewayError.notFound {
          try await store.removeConversation(gatewayID: gatewayID, conversationID: value.id)
          conversationOrder.removeAll { $0 == value.id }
          continue
        }
        try await persist(canonical)
        guard canonical.status != .deleted else { continue }
        _ = try await loadMessagesFromNetwork(conversationID: canonical.id, reset: true)
        guard canonical.status == .running, let turnID = canonical.activeTurnId else { continue }
        try await ensureChatConnected()
        let cursor = try await store.cursor(
          gatewayID: gatewayID,
          conversationID: canonical.id
        )
        try await chat.resume(
          turnID: turnID,
          agentID: canonical.agentId,
          conversationID: canonical.id,
          sinceSeq: cursor
        )
      }
      try await recordSuccessfulSync()
      try await reloadSnapshot()
      publish(.online)
      startInvalidations()
    } catch {
      await handle(error)
    }
  }

  func createConversation(
    _ request: CreateConversationRequest
  ) async throws -> ConversationSummaryDTO {
    try requireOnlineMutation()
    do {
      let summary = try await api.createConversation(request)
      try await persist(summary)
      try await reloadSnapshot()
      publish(.online)
      return summary
    } catch GatewayError.mutationOutcomeUnknown {
      try await clock.sleep(for: backoff.delay(attempt: 0, unitRandom: 0.5))
      _ = try await api.listAgents()
      let summary = try await api.createConversation(request)
      try await persist(summary)
      try await reloadSnapshot()
      publish(.online)
      return summary
    }
  }

  func sendTurn(
    id: String,
    agentID: String,
    conversationID: String,
    text: String,
    images: [MessageImage]
  ) async throws {
    try requireOnlineMutation()
    try await ensureChatConnected()
    do {
      try await chat.sendTurn(
        id: id,
        agentID: agentID,
        conversationID: conversationID,
        text: text,
        images: images
      )
    } catch let error as GatewayError {
      guard case .transport = error else { throw error }
      try await recoverAmbiguousSend(
        id: id,
        agentID: agentID,
        conversationID: conversationID,
        text: text,
        images: images
      )
    } catch is URLError {
      try await recoverAmbiguousSend(
        id: id,
        agentID: agentID,
        conversationID: conversationID,
        text: text,
        images: images
      )
    }
  }

  func shutdown() async {
    guard isShutdown == false else { return }
    isShutdown = true
    invalidationTask?.cancel()
    reconnectTask?.cancel()
    reachabilityTask?.cancel()
    invalidationTask = nil
    reconnectTask = nil
    reachabilityTask = nil
    await chat.disconnect()
    chatConnected = false
    continuation.finish()
  }

  private func refreshConversationsFromNetwork(reset: Bool) async throws {
    let knownIDs =
      if reset {
        Set(try await store.conversations(gatewayID: gatewayID, limit: 1_000).map(\.id))
      } else {
        Set<String>()
      }
    let cursor = reset ? nil : conversationCursor
    let page = try await api.conversations(agentId: nil, limit: pageSize, cursor: cursor)
    for item in page.items {
      try await persist(item)
    }
    let pageIDs = page.items.filter { $0.status != .deleted }.map(\.id)
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
      do {
        let canonical = try await api.conversation(id: id)
        try await persist(canonical)
        if canonical.status != .deleted, conversationOrder.contains(id) == false {
          conversationOrder.append(id)
        }
      } catch GatewayError.notFound {
        try await store.removeConversation(gatewayID: gatewayID, conversationID: id)
        conversationOrder.removeAll { $0 == id }
      }
    }
  }

  private func loadMessagesFromNetwork(
    conversationID: String,
    reset: Bool
  ) async throws -> ConversationMessagePageDTO {
    let before = reset ? nil : messageCursors[conversationID]
    let page = try await api.messages(
      conversationID: conversationID,
      limit: pageSize,
      before: before
    )
    try await store.mergeMessages(
      page.items,
      gatewayID: gatewayID,
      conversationID: conversationID
    )
    try await store.advanceCursor(
      gatewayID: gatewayID,
      conversationID: conversationID,
      to: page.throughSeq
    )
    messageCursors[conversationID] = page.nextCursor
    let durableCursor = try await store.cursor(
      gatewayID: gatewayID,
      conversationID: conversationID
    )
    reconcilers[conversationID] = SequenceReconciler(lastAppliedSeq: durableCursor)
    return page
  }

  private func persist(_ summary: ConversationSummaryDTO) async throws {
    if summary.status == .deleted {
      try await store.applyTombstone(summary, gatewayID: gatewayID)
      conversationOrder.removeAll { $0 == summary.id }
    } else {
      try await store.upsertConversations([summary], gatewayID: gatewayID)
      if conversationOrder.contains(summary.id) == false {
        conversationOrder.append(summary.id)
      }
    }
  }

  private func recoverAmbiguousSend(
    id: String,
    agentID: String,
    conversationID: String,
    text: String,
    images: [MessageImage]
  ) async throws {
    let page = try await loadMessagesFromNetwork(conversationID: conversationID, reset: true)
    let sameTurn = page.items.filter { $0.turnId == id }
    if sameTurn.isEmpty {
      try await chat.sendTurn(
        id: id,
        agentID: agentID,
        conversationID: conversationID,
        text: text,
        images: images
      )
      return
    }
    let isTerminal = sameTurn.allSatisfy { message in
      [.completed, .cancelled, .failed, .interrupted].contains(message.status)
    }
    guard isTerminal == false else { return }
    let cursor = try await store.cursor(gatewayID: gatewayID, conversationID: conversationID)
    try await chat.resume(
      turnID: id,
      agentID: agentID,
      conversationID: conversationID,
      sinceSeq: cursor
    )
  }

  private func reloadSnapshot() async throws {
    let cached = try await store.conversations(gatewayID: gatewayID, limit: 1_000)
    if conversationOrder.isEmpty {
      snapshotConversations = cached
    } else {
      let values = Dictionary(uniqueKeysWithValues: cached.map { ($0.id, $0) })
      snapshotConversations = conversationOrder.compactMap { values[$0] }
      for value in cached where conversationOrder.contains(value.id) == false {
        snapshotConversations.append(value)
      }
    }
    snapshotAgents = try await store.agents(gatewayID: gatewayID)
    lastSuccessfulSyncAt = try await store.profile(gatewayID: gatewayID)?
      .profile.lastSuccessfulSyncAt
  }

  private func recordSuccessfulSync() async throws {
    try await store.markSuccessfulSync(gatewayID: gatewayID, at: await clock.now())
  }

  private func publish(_ state: GatewayConnectionState) {
    connection = state
    continuation.yield(
      SyncSnapshot(
        connection: state,
        conversations: snapshotConversations,
        agents: snapshotAgents,
        lastSuccessfulSyncAt: lastSuccessfulSyncAt
      )
    )
  }

  private func startInvalidations() {
    guard invalidationTask == nil, isShutdown == false else { return }
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
        await self.invalidationFailed(error)
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

  private func invalidationFailed(_ error: Error) async {
    invalidationTask = nil
    await handle(error)
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
    switch status {
    case .satisfied:
      if connection == .offline {
        publish(.connecting)
      }
    case .unsatisfied, .requiresConnection:
      publish(.offline)
    }
  }

  private func ensureChatConnected() async throws {
    guard chatConnected == false else { return }
    try await chat.connect()
    chatConnected = true
  }

  private func requireOnlineMutation() throws {
    guard connection == .online else {
      throw GatewayError.transport("Mutations require an online gateway")
    }
  }

  private func handle(_ error: Error) async {
    let gatewayError =
      error as? GatewayError
      ?? GatewayError.transport(error.localizedDescription)
    switch gatewayError {
    case .unauthorized:
      publish(.repairRequired)
    case .rateLimited(let retryAfter):
      let now = await clock.now()
      let delay = retryAfter ?? backoff.delay(attempt: 0, unitRandom: 0.5)
      publish(.rateLimited(retryAt: now.addingTimeInterval(delay.timeInterval)))
    case .gatewayOffline:
      publish(.gatewayOffline)
    case .updateRequired, .capabilityRequired:
      publish(.updateRequired)
    case .transport:
      scheduleReconnect()
    default:
      publish(.offline)
    }
  }

  private func scheduleReconnect() {
    reconnectAttempt += 1
    let attempt = reconnectAttempt
    let delay = backoff.delay(attempt: attempt - 1, unitRandom: 0.5)
    let clock = clock
    reconnectTask?.cancel()
    reconnectTask = Task { [weak self] in
      guard let self else { return }
      let retryAt = (await clock.now()).addingTimeInterval(delay.timeInterval)
      await self.publishReconnect(attempt: attempt, retryAt: retryAt)
      do {
        try await clock.sleep(for: delay)
      } catch {
        return
      }
      if Task.isCancelled == false {
        await self.refreshConversations(reset: true)
      }
    }
  }

  private func publishReconnect(attempt: Int, retryAt: Date) {
    publish(.reconnecting(attempt: attempt, retryAt: retryAt))
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
