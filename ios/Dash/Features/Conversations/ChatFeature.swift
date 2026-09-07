import Foundation
import Observation
import SwiftUI
import UIKit

struct ChatCanonicalSnapshot: Equatable, Sendable {
  let summary: ConversationSummaryDTO
  let messages: [ConversationMessageDTO]
  let nextCursor: String?
  let throughSeq: Int
  let hasCanonicalMessagePage: Bool

  init(
    summary: ConversationSummaryDTO,
    messages: [ConversationMessageDTO],
    nextCursor: String?,
    throughSeq: Int,
    hasCanonicalMessagePage: Bool = true
  ) {
    self.summary = summary
    self.messages = messages
    self.nextCursor = nextCursor
    self.throughSeq = throughSeq
    self.hasCanonicalMessagePage = hasCanonicalMessagePage
  }
}

protocol ChatFeaturePersisting: Actor {
  func messages(
    gatewayID: String,
    conversationID: String
  ) async throws -> [ConversationMessageDTO]
  func draft(gatewayID: String, conversationID: String) async throws -> ConversationDraft?
  func pendingSend(
    gatewayID: String,
    conversationID: String
  ) async throws -> PendingSendLoadResult
  func cursor(gatewayID: String, conversationID: String) async throws -> Int
  func saveDraft(
    _ draft: ConversationDraft,
    gatewayID: String,
    conversationID: String
  ) async throws
  func stagePendingSend(
    _ pending: PendingChatSend,
    gatewayID: String,
    conversationID: String
  ) async throws -> PendingSendStageResult
  func clearPendingSend(
    gatewayID: String,
    conversationID: String,
    turnID: String
  ) async throws -> PendingSendClearResult
  func pendingSendAvailability(
    gatewayID: String,
    conversationID: String,
    turnID: String
  ) async throws -> PendingSendAvailability
  func restorePendingSendAsDraft(
    gatewayID: String,
    conversationID: String,
    turnID: String
  ) async throws -> PendingSendRestoreResult
  func advanceCursor(
    gatewayID: String,
    conversationID: String,
    to seq: Int
  ) async throws
}

actor LiveChatPersistence: ChatFeaturePersisting {
  private let store: PersistenceStore

  init(store: PersistenceStore) {
    self.store = store
  }

  func messages(
    gatewayID: String,
    conversationID: String
  ) async throws -> [ConversationMessageDTO] {
    try await store.messages(gatewayID: gatewayID, conversationID: conversationID)
  }

  func draft(gatewayID: String, conversationID: String) async throws -> ConversationDraft? {
    try await store.draft(gatewayID: gatewayID, conversationID: conversationID)
  }

  func pendingSend(
    gatewayID: String,
    conversationID: String
  ) async throws -> PendingSendLoadResult {
    try await store.pendingSend(gatewayID: gatewayID, conversationID: conversationID)
  }

  func cursor(gatewayID: String, conversationID: String) async throws -> Int {
    try await store.cursor(gatewayID: gatewayID, conversationID: conversationID)
  }

  func saveDraft(
    _ draft: ConversationDraft,
    gatewayID: String,
    conversationID: String
  ) async throws {
    try await store.saveDraft(draft, gatewayID: gatewayID, conversationID: conversationID)
  }

  func stagePendingSend(
    _ pending: PendingChatSend,
    gatewayID: String,
    conversationID: String
  ) async throws -> PendingSendStageResult {
    try await store.stagePendingSend(
      pending,
      gatewayID: gatewayID,
      conversationID: conversationID
    )
  }

  func clearPendingSend(
    gatewayID: String,
    conversationID: String,
    turnID: String
  ) async throws -> PendingSendClearResult {
    try await store.clearPendingSend(
      gatewayID: gatewayID,
      conversationID: conversationID,
      turnID: turnID
    )
  }

  func pendingSendAvailability(
    gatewayID: String,
    conversationID: String,
    turnID: String
  ) async throws -> PendingSendAvailability {
    try await store.pendingSendAvailability(
      gatewayID: gatewayID,
      conversationID: conversationID,
      turnID: turnID
    )
  }

  func restorePendingSendAsDraft(
    gatewayID: String,
    conversationID: String,
    turnID: String
  ) async throws -> PendingSendRestoreResult {
    try await store.restorePendingSendAsDraft(
      gatewayID: gatewayID,
      conversationID: conversationID,
      turnID: turnID
    )
  }

  func advanceCursor(
    gatewayID: String,
    conversationID: String,
    to seq: Int
  ) async throws {
    try await store.advanceCursor(
      gatewayID: gatewayID,
      conversationID: conversationID,
      to: seq
    )
  }
}

protocol ChatFeatureSynchronizing: Actor {
  func refresh(conversationID: String, before: String?) async throws -> ChatCanonicalSnapshot
  func replay(
    agentID: String,
    conversationID: String,
    sinceSeq: Int
  ) async throws -> [ReplayEntryDTO]
  /// A child conversation's own messages and its `oneShot` fact, for an
  /// expanded sub-agent row (design 8.3).
  ///
  /// Deliberately NOT `refresh(conversationID:)`, even though that method
  /// accepts any id: `refresh` PERSISTS what it reads into the conversation
  /// cache and reconciles a `notFound` into a deletion, both of which are
  /// wrong for a child. A child is not in the user's conversation list
  /// (`conversation-routes.ts` refuses a `kind` filter), so caching one would
  /// put a row in the cache that nothing lists and nothing evicts, and a
  /// pruned child would look like the OPEN conversation being deleted.
  func subagentTranscript(childID: String) async throws -> SubagentTranscriptSnapshot
  /// Type into a child (design 7.7). See `SubagentResumeRequest` for why this
  /// is REST and not a `message` frame.
  func resumeSubagent(id: String, message: String, requestID: String) async throws
  /// This conversation's sub-agent children (design 7.7, §8.4) — the tasks
  /// sheet's SOLE model.
  ///
  /// Deliberately not merged with the transcript fold. The fold sees only
  /// children whose events sit in a message this client has loaded, it exempts
  /// a background child from end-of-stream terminalization (so that row reads
  /// `running` forever once its spawning turn ends), and after a gateway
  /// restart the recovered child ROWS are all there is. Worse, the fold's
  /// `done` comes from a PERSISTED event that never changes, so a resumed
  /// child would read `done` for the whole of its second run — the persistent
  /// bug web's D3 found and rejected the merge over.
  func subagents(conversationID: String) async throws -> [SubagentListEntryDTO]
  /// Cancel a child, returning the route's own terminal status — which is
  /// authoritative rather than guessable (`SubagentStopResponseDTO`).
  func stopSubagent(id: String) async throws -> String
  func shutdown() async
}

/// One read of a child conversation for an expanded row.
struct SubagentTranscriptSnapshot: Equatable, Sendable {
  let messages: [ConversationMessageDTO]
  /// `SubagentInfoDTO.oneShot`. `nil` when the summary carries no `subagent`
  /// block at all — an older gateway, or a conversation that is not a child —
  /// in which case the body composer stays enabled and the server decides.
  let oneShot: Bool?
}

protocol ChatFeatureTransporting: Actor {
  func events() async -> AsyncThrowingStream<ChatConnectionEvent, Error>
  func resetAfterTerminalFailure() async
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
  func answer(turnID: String, questionID: String, answer: String) async throws
  func cancel(turnID: String) async throws
  /// Watch the conversation the user has open, so server-initiated turns
  /// reach this client (sub-agents design 7.6).
  func subscribe(agentID: String, conversationID: String) async throws
  func unsubscribe(agentID: String, conversationID: String) async throws
  func suspendForDetachment() async
  func shutdown() async
}

protocol ChatAccessibilityAnnouncing: Actor {
  func isVoiceOverRunning() async -> Bool
  func announce(_ value: String) async
}

typealias ChatGatewayErrorHandler = @MainActor @Sendable (GatewayError) async -> Void

enum ChatDraftStatus: Equatable, Sendable {
  case saved
  case saving
  case failed
}

private enum DraftWriteResult: Sendable {
  case saved
  case cancelled
  case failed

  var didSave: Bool {
    if case .saved = self { return true }
    return false
  }
}

private enum ChatCacheReadResult<Value: Sendable>: Sendable {
  case value(Value)
  case cancelled
  case failed
}

private func readChatCacheValue<Value: Sendable>(
  _ operation: @escaping @Sendable () async throws -> Value
) async -> ChatCacheReadResult<Value> {
  do {
    let value = try await operation()
    return Task.isCancelled ? .cancelled : .value(value)
  } catch is CancellationError {
    return .cancelled
  } catch {
    return .failed
  }
}

private enum RecoveryClassificationResult: Equatable, Sendable {
  case conclusive
  case admitted
  case notAdmitted
  case deleted
  case inconclusive
  case summaryOnlyInconclusive
}

private enum PendingSendDraftResolution: Equatable, Sendable {
  case restored(ConversationDraft)
  case draftConflict(ConversationDraft)
}

enum ChatStatusPresentation: Equatable, Sendable {
  case recoveryRequired
  case reconnecting(attempt: Int)
  case offline
  case gatewayOffline
  case rateLimited(retryAt: Date)
  case repairRequired
  case updateRequired
  case failed(String)
}

actor LiveChatFeatureTransport: ChatFeatureTransporting {
  private let makeConnection: @Sendable () -> ChatConnection
  private var connection: ChatConnection

  init(makeConnection: @escaping @Sendable () -> ChatConnection) {
    self.makeConnection = makeConnection
    connection = makeConnection()
  }

  func events() async -> AsyncThrowingStream<ChatConnectionEvent, Error> {
    await connection.events()
  }

  func resetAfterTerminalFailure() {
    connection = makeConnection()
  }

  func connect() async throws {
    try await connection.connect()
  }

  func sendTurn(
    id: String,
    agentID: String,
    conversationID: String,
    text: String,
    images: [MessageImage]
  ) async throws {
    try await connection.sendTurn(
      id: id,
      agentID: agentID,
      conversationID: conversationID,
      text: text,
      images: images
    )
  }

  func resume(
    turnID: String,
    agentID: String,
    conversationID: String,
    sinceSeq: Int
  ) async throws {
    try await connection.resume(
      turnID: turnID,
      agentID: agentID,
      conversationID: conversationID,
      sinceSeq: sinceSeq
    )
  }

  func answer(turnID: String, questionID: String, answer: String) async throws {
    try await connection.answer(turnID: turnID, questionID: questionID, answer: answer)
  }

  func cancel(turnID: String) async throws {
    try await connection.cancel(turnID: turnID)
  }

  func subscribe(agentID: String, conversationID: String) async throws {
    try await connection.subscribe(agentID: agentID, conversationID: conversationID)
  }

  func unsubscribe(agentID: String, conversationID: String) async throws {
    try await connection.unsubscribe(agentID: agentID, conversationID: conversationID)
  }

  func suspendForDetachment() async {
    await connection.suspend()
  }

  func shutdown() async {
    await connection.detach()
  }
}

actor LiveChatSynchronizer: ChatFeatureSynchronizing {
  private let gatewayID: String
  private let store: PersistenceStore
  private let makeAPI: @Sendable () async throws -> GatewayAPI
  private var api: GatewayAPI?
  private var lifecycleGeneration: UInt64 = 0
  private var activeOperations = 0
  private var isShutdown = false
  private var shutdownWaiters: [CheckedContinuation<Void, Never>] = []

  init(
    gatewayID: String,
    store: PersistenceStore,
    makeAPI: @escaping @Sendable () async throws -> GatewayAPI
  ) {
    self.gatewayID = gatewayID
    self.store = store
    self.makeAPI = makeAPI
  }

  func refresh(conversationID: String, before: String?) async throws -> ChatCanonicalSnapshot {
    let lifecycle = try beginOperation()
    defer { finishOperation() }
    let api = try await resolvedAPI()
    try validate(lifecycle)
    let requestStartCanonical = try await store.conversation(
      gatewayID: gatewayID,
      id: conversationID
    )?.summary
    try validate(lifecycle)
    let summary: ConversationSummaryDTO
    do {
      summary = try await api.conversation(id: conversationID)
    } catch GatewayError.notFound {
      if let retained = try await retainedCanonicalAfterNotFound(
        conversationID: conversationID,
        requestStartCanonical: requestStartCanonical,
        lifecycle: lifecycle
      ) {
        return summaryOnlySnapshot(retained)
      }
      throw GatewayError.notFound
    }
    try validate(lifecycle)
    let persisted = try await store.persistConversationAndReturnCanonical(
      summary,
      gatewayID: gatewayID
    )
    try validate(lifecycle)
    guard persisted.summary == summary, persisted.summary.status != .deleted else {
      return ChatCanonicalSnapshot(
        summary: persisted.summary,
        messages: [],
        nextCursor: nil,
        throughSeq: persisted.summary.lastSeq,
        hasCanonicalMessagePage: false
      )
    }

    let page: ConversationMessagePageDTO
    do {
      page = try await api.messages(
        conversationID: conversationID,
        limit: 50,
        before: before
      )
    } catch GatewayError.notFound {
      if let retained = try await retainedCanonicalAfterNotFound(
        conversationID: conversationID,
        requestStartCanonical: persisted.summary,
        lifecycle: lifecycle
      ) {
        return summaryOnlySnapshot(retained)
      }
      throw GatewayError.notFound
    }
    try validate(lifecycle)
    try await store.mergeMessages(
      page.items,
      gatewayID: gatewayID,
      conversationID: conversationID
    )
    try validate(lifecycle)
    try await store.advanceCursor(
      gatewayID: gatewayID,
      conversationID: conversationID,
      to: page.throughSeq
    )
    try validate(lifecycle)
    return ChatCanonicalSnapshot(
      summary: persisted.summary,
      messages: page.items,
      nextCursor: page.nextCursor,
      throughSeq: page.throughSeq
    )
  }

  func replay(
    agentID: String,
    conversationID: String,
    sinceSeq: Int
  ) async throws -> [ReplayEntryDTO] {
    let lifecycle = try beginOperation()
    defer { finishOperation() }
    let api = try await resolvedAPI()
    try validate(lifecycle)
    let requestStartCanonical = try await store.conversation(
      gatewayID: gatewayID,
      id: conversationID
    )?.summary
    try validate(lifecycle)
    do {
      let page = try await api.replay(
        agentID: agentID,
        conversationID: conversationID,
        sinceSeq: sinceSeq
      )
      try validate(lifecycle)
      return page.entries
    } catch GatewayError.notFound {
      if let retained = try await retainedCanonicalAfterNotFound(
        conversationID: conversationID,
        requestStartCanonical: requestStartCanonical,
        lifecycle: lifecycle
      ) {
        guard retained.status != .deleted else { throw GatewayError.notFound }
        throw GatewayError.revisionConflict(current: retained)
      }
      throw GatewayError.notFound
    }
  }

  func shutdown() async {
    if isShutdown == false {
      isShutdown = true
      lifecycleGeneration &+= 1
    }
    if let api { await api.shutdown() }
    guard activeOperations > 0 else { return }
    await withCheckedContinuation { continuation in
      shutdownWaiters.append(continuation)
    }
  }

  func subagentTranscript(childID: String) async throws -> SubagentTranscriptSnapshot {
    let lifecycle = try beginOperation()
    defer { finishOperation() }
    let api = try await resolvedAPI()
    try validate(lifecycle)
    let page = try await api.messages(conversationID: childID, limit: 100, before: nil)
    try validate(lifecycle)
    // Best-effort: a child whose summary cannot be read still renders its
    // transcript, with `oneShot` unknown. Refusing the whole expansion because
    // one FACT is missing would be a worse trade — §8.3's body is the point.
    let oneShot = try? await api.conversation(id: childID).subagent?.oneShot
    return SubagentTranscriptSnapshot(messages: page.items, oneShot: oneShot)
  }

  func resumeSubagent(id: String, message: String, requestID: String) async throws {
    let lifecycle = try beginOperation()
    defer { finishOperation() }
    let api = try await resolvedAPI()
    try validate(lifecycle)
    _ = try await api.resumeSubagent(id: id, message: message, requestID: requestID)
  }

  func subagents(conversationID: String) async throws -> [SubagentListEntryDTO] {
    let lifecycle = try beginOperation()
    defer { finishOperation() }
    let api = try await resolvedAPI()
    try validate(lifecycle)
    return try await api.subagents(conversationID: conversationID).subagents
  }

  func stopSubagent(id: String) async throws -> String {
    let lifecycle = try beginOperation()
    defer { finishOperation() }
    let api = try await resolvedAPI()
    try validate(lifecycle)
    return try await api.stopSubagent(id: id).status
  }

  private func resolvedAPI() async throws -> GatewayAPI {
    if let api { return api }
    let created = try await makeAPI()
    guard isShutdown == false else {
      await created.shutdown()
      throw CancellationError()
    }
    if let api {
      await created.shutdown()
      return api
    }
    api = created
    return created
  }

  private func beginOperation() throws -> UInt64 {
    guard isShutdown == false else { throw CancellationError() }
    activeOperations += 1
    return lifecycleGeneration
  }

  private func finishOperation() {
    activeOperations -= 1
    guard activeOperations == 0 else { return }
    let waiters = shutdownWaiters
    shutdownWaiters.removeAll()
    for waiter in waiters { waiter.resume() }
  }

  private func retainedCanonicalAfterNotFound(
    conversationID: String,
    requestStartCanonical: ConversationSummaryDTO?,
    lifecycle: UInt64
  ) async throws -> ConversationSummaryDTO? {
    try validate(lifecycle)
    let outcome = try await store.removeConversationIfCanonicalUnchanged(
      gatewayID: gatewayID,
      conversationID: conversationID,
      expectedCanonical: requestStartCanonical
    )
    try validate(lifecycle)
    switch outcome {
    case .removed:
      return nil
    case .retained(let current):
      return current
    }
  }

  private func summaryOnlySnapshot(
    _ summary: ConversationSummaryDTO
  ) -> ChatCanonicalSnapshot {
    ChatCanonicalSnapshot(
      summary: summary,
      messages: [],
      nextCursor: nil,
      throughSeq: summary.lastSeq,
      hasCanonicalMessagePage: false
    )
  }

  private func validate(_ lifecycle: UInt64) throws {
    guard isShutdown == false, lifecycleGeneration == lifecycle else {
      throw CancellationError()
    }
  }
}

actor SystemChatAccessibilityAnnouncer: ChatAccessibilityAnnouncing {
  func isVoiceOverRunning() async -> Bool {
    await MainActor.run { UIAccessibility.isVoiceOverRunning }
  }

  func announce(_ value: String) async {
    await MainActor.run {
      AccessibilityNotification.Announcement(value).post()
    }
  }
}

@MainActor
@Observable
final class ChatFeature {
  private(set) var state: ChatState
  private(set) var connection: GatewayConnectionState = .connecting
  private(set) var isAuthoritative = false
  private(set) var isLoadingInitial = false
  private(set) var isSending = false
  private(set) var isCancelling = false
  private(set) var isShutdown = false
  private(set) var draftStatus: ChatDraftStatus = .saved
  private(set) var retryAt: Date?
  private(set) var pendingSendRecovery: RecoverablePendingSend?

  var canSend: Bool {
    guard
      sendAuthorityIsAvailable,
      pendingSendReconciliation == nil,
      pendingSendRecovery == nil,
      isSending == false,
      state.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
        || state.attachments.isEmpty == false
    else { return false }
    return true
  }

  var draftEditingAllowed: Bool {
    isShutdown == false && isSending == false && pendingSendReconciliation == nil
      && pendingSendRecovery == nil
      && state.activeTurnID == nil
      && state.composerBlock == nil && isConversationReadOnly == false
  }

  var canAnswerQuestions: Bool {
    turnMutationAuthorityIsAvailable
  }

  var canCancel: Bool {
    turnMutationAuthorityIsAvailable
      && state.activeTurnID.map(localTurnIDs.contains) == true
      && cancelRequestSent == false
      && cancelRequestInFlight == false
  }

  var composerDisabledReason: String? {
    if isShutdown { return "Chat session is closed" }
    if pendingSendRecovery != nil { return "A saved message needs recovery" }
    if isConversationReadOnly { return "This conversation is read-only" }
    if case .remoteActiveTurn? = state.composerBlock {
      return "This conversation is active on another device"
    }
    if state.composerBlock == .repairRequired { return "Re-pair this gateway to continue" }
    if state.composerBlock == .updateRequired { return "Update Dash to continue" }
    if connection != .online { return "Connect to the gateway to send" }
    if isSending { return "Sending message" }
    if pendingSendReconciliation != nil { return "Confirming whether your message was sent" }
    if state.activeTurnID != nil { return "A response is in progress" }
    return nil
  }

  var statusPresentation: ChatStatusPresentation? {
    if pendingSendRecovery != nil { return .recoveryRequired }
    if pendingSendReconciliation != nil, state.conversation.status == .deleted {
      return .recoveryRequired
    }

    switch connection {
    case .connecting, .online:
      if case .reconnecting(let attempt) = state.transport {
        return .reconnecting(attempt: attempt)
      }
      if let errorBanner = state.errorBanner { return .failed(errorBanner) }
      return nil
    case .reconnecting(let attempt, _):
      return .reconnecting(attempt: attempt)
    case .offline:
      return .offline
    case .gatewayOffline:
      return .gatewayOffline
    case .rateLimited(let retryAt):
      return .rateLimited(retryAt: retryAt)
    case .repairRequired:
      return .repairRequired
    case .updateRequired:
      return .updateRequired
    }
  }

  @ObservationIgnored private let gatewayID: String
  @ObservationIgnored private let persistence: any ChatFeaturePersisting
  @ObservationIgnored private let synchronizer: any ChatFeatureSynchronizing
  @ObservationIgnored private let transport: any ChatFeatureTransporting
  @ObservationIgnored private let clock: any AppClock
  @ObservationIgnored private let announcer: any ChatAccessibilityAnnouncing
  @ObservationIgnored private let validator: ImageAttachmentValidator
  @ObservationIgnored private let recoveryChanges: any ConversationRecoveryChangeSignaling
  @ObservationIgnored private let makeID: @Sendable () -> String
  @ObservationIgnored private var eventTask: Task<Void, Never>?
  @ObservationIgnored private var eventTaskGeneration: UInt64 = 0
  @ObservationIgnored private var cacheLoadTask: Task<Void, Never>?
  @ObservationIgnored private var cacheLoadGeneration: UInt64 = 0
  @ObservationIgnored private var recoveryChangeTask: Task<Void, Never>?
  @ObservationIgnored private var recoveryChangeGeneration: UInt64 = 0
  @ObservationIgnored private var pendingSendReadRevision: UInt64 = 0
  @ObservationIgnored private var isStartingRecoveryChangeObservation = false
  @ObservationIgnored private var activeRecoveryChangeOperations = 0
  @ObservationIgnored private var recoveryChangeOperationWaiters:
    [CheckedContinuation<Void, Never>] = []
  @ObservationIgnored private var hasLoadedCache = false
  @ObservationIgnored private var isVisible = false
  @ObservationIgnored private var isConnected = false
  @ObservationIgnored private var wasReconnecting = false
  @ObservationIgnored private var cancelRequestSent = false
  @ObservationIgnored private var cancelRequestInFlight = false
  @ObservationIgnored private var answerRequestsInFlight: Set<String> = []
  @ObservationIgnored private var submittedAnswers: [String: String] = [:]
  @ObservationIgnored private var localTurnIDs: Set<String> = []
  @ObservationIgnored private var pendingSendReconciliation: PendingChatSend?
  @ObservationIgnored private var sendCompletionWaiters: [CheckedContinuation<Void, Never>] = []
  @ObservationIgnored private var draftWriteTask: Task<DraftWriteResult, Never>?
  @ObservationIgnored private var draftWriteRevision: UInt64 = 0
  @ObservationIgnored private var attachmentIntentRevision: UInt64 = 0
  @ObservationIgnored private var attachmentRequested = false
  /// Whether this conversation is currently WATCHED over the live socket
  /// (sub-agents design 7.6). Reset whenever the transport stops being
  /// connected, so the next appear/reconnect re-establishes it.
  @ObservationIgnored private var isSubscribed = false
  /// Child conversations this socket is watching for §8.3's live nested
  /// transcript. One entry per EXPANDED row; cleared with the socket, like
  /// `isSubscribed`, because a reconnect drops the gateway's subscriptions.
  @ObservationIgnored private var subscribedSubagentIDs: Set<String> = []
  @ObservationIgnored private var canonicalRefreshRevision: UInt64 = 0
  @ObservationIgnored private var recoveryClassificationRevision: UInt64?
  @ObservationIgnored private var recoveryClassificationTurnID: String?
  @ObservationIgnored private var recoveryResolutionHoldTurnID: String?
  @ObservationIgnored private var summaryOnlyFollowUpTurnID: String?
  @ObservationIgnored private var transportSendInFlightTurnID: String?
  @ObservationIgnored private var deferredRecoveryFrames: [MobileWSServerFrame] = []
  @ObservationIgnored private var deferredReplayTurnID: String?
  @ObservationIgnored private var gatewayErrorHandler: ChatGatewayErrorHandler?
  @ObservationIgnored private var lifecycleChangeHandler:
    @MainActor @Sendable ([ConversationLifecycleChange]) async
      -> ConversationLifecycleAcknowledgement = { _ in .ignored }
  @ObservationIgnored private var shutdownDrainStarted = false
  @ObservationIgnored private var shutdownDrainCompleted = false
  @ObservationIgnored private var shutdownDrainWaiters: [CheckedContinuation<Void, Never>] = []

  init(
    gatewayID: String,
    conversation: ConversationSummaryDTO,
    persistence: any ChatFeaturePersisting,
    synchronizer: any ChatFeatureSynchronizing,
    transport: any ChatFeatureTransporting,
    clock: any AppClock = SystemAppClock(),
    announcer: any ChatAccessibilityAnnouncing = SystemChatAccessibilityAnnouncer(),
    validator: ImageAttachmentValidator = ImageAttachmentValidator(),
    recoveryChanges: any ConversationRecoveryChangeSignaling =
      ConversationRecoveryChangeSignal.shared,
    makeID: @escaping @Sendable () -> String = { UUID().uuidString.lowercased() }
  ) {
    self.gatewayID = gatewayID
    self.persistence = persistence
    self.synchronizer = synchronizer
    self.transport = transport
    self.clock = clock
    self.announcer = announcer
    self.validator = validator
    self.recoveryChanges = recoveryChanges
    self.makeID = makeID
    state = ChatState(
      conversation: conversation,
      messages: [],
      draft: "",
      attachments: [],
      transport: .idle,
      lastAppliedSeq: 0,
      activeTurnID: nil,
      pendingGapFrame: nil,
      isLoadingOlder: false,
      olderCursor: nil,
      composerBlock: nil,
      errorBanner: nil
    )
  }

  func setConnection(_ connection: GatewayConnectionState) {
    guard isShutdown == false else { return }
    let wasOnline = self.connection == .online
    self.connection = connection
    if connection != .online || wasOnline == false {
      isAuthoritative = false
    }
    switch connection {
    case .repairRequired:
      state.composerBlock = .repairRequired
    case .updateRequired:
      state.composerBlock = .updateRequired
    case .online:
      if state.composerBlock == .repairRequired || state.composerBlock == .updateRequired {
        state.composerBlock = nil
      }
      retryAt = nil
    case .rateLimited(let retryAt):
      self.retryAt = retryAt
    case .connecting, .reconnecting, .offline, .gatewayOffline:
      break
    }
  }

  func consumeCanonicalSummary(_ canonical: ConversationSummaryDTO) {
    guard
      isShutdown == false,
      canonical.id == state.conversation.id,
      canonical.status != .deleted,
      canonical.revision >= state.conversation.revision
    else { return }
    let previousActiveTurnID = state.activeTurnID
    _ = ChatReducer.reduce(state: &state, action: .authoritativeSummary(canonical))
    if let previousActiveTurnID, state.activeTurnID != previousActiveTurnID {
      localTurnIDs.remove(previousActiveTurnID)
      cancelRequestSent = false
      isCancelling = false
    }
    reconcileSubmittedAnswers()
  }

  func setGatewayErrorHandler(_ handler: @escaping ChatGatewayErrorHandler) {
    guard isShutdown == false else { return }
    gatewayErrorHandler = handler
  }

  func setLifecycleChangeHandler(
    _ handler: @escaping @MainActor @Sendable ([ConversationLifecycleChange]) async
      -> ConversationLifecycleAcknowledgement
  ) {
    guard isShutdown == false else { return }
    lifecycleChangeHandler = handler
  }

  func appear() async {
    guard rejectIfShutdown() == false else { return }
    let attachmentIntent = beginAttachmentIntent(attached: true)
    isVisible = true
    startEventTaskIfNeeded()
    await startRecoveryChangeObservation()
    guard isShutdown == false else { return }
    if hasLoadedCache == false {
      isLoadingInitial = true
      await loadCache()
      guard isShutdown == false else { return }
      hasLoadedCache = true
      isLoadingInitial = false
    }
    guard isCurrentAttachmentIntent(attachmentIntent, attached: true) else { return }
    guard connection == .online else { return }
    isAuthoritative = false
    await refreshCanonical(preserveLiveProjection: true)
    guard isCurrentAttachmentIntent(attachmentIntent, attached: true) else { return }
    await attachToCanonicalTurnIfNeeded()
    await subscribeToOpenConversation()
    await resubscribeExpandedSubagents()
    // §8.4's first read. The gateway replays nothing on a `subscribe`, so the
    // only way to learn about a child that started — or finished — while this
    // client was not watching is to ask.
    await refreshSubagents()
  }

  func disappear() async {
    guard isShutdown == false else { return }
    let attachmentIntent = beginAttachmentIntent(attached: false)
    isVisible = false
    await persistDraft()
    guard isCurrentAttachmentIntent(attachmentIntent, attached: false) else { return }
    guard state.activeTurnID == nil else { return }
    await suspendForDetachment()
  }

  func loadOlder() async {
    guard
      isShutdown == false,
      connection == .online,
      state.isLoadingOlder == false,
      let cursor = state.olderCursor
    else { return }
    let conversationID = state.conversation.id
    let revisionFloor = state.conversation.revision
    state.isLoadingOlder = true
    defer { state.isLoadingOlder = false }
    do {
      let canonical = try await synchronizer.refresh(
        conversationID: state.conversation.id,
        before: cursor
      )
      var next = state
      if canonical.hasCanonicalMessagePage {
        _ = ChatReducer.reduce(
          state: &next,
          action: .olderMessagesLoaded(canonical.messages, nextCursor: canonical.nextCursor)
        )
      }
      if canonical.summary.revision >= next.conversation.revision {
        _ = ChatReducer.reduce(state: &next, action: .authoritativeSummary(canonical.summary))
      }
      state = next
      reconcileSubmittedAnswers()
      isAuthoritative = connection == .online
      _ = await lifecycleChangeHandler([.canonical(canonical.summary)])
    } catch is CancellationError {
      return
    } catch GatewayError.notFound {
      markConversationDeletedForRecovery()
      if pendingSendReconciliation != nil {
        await recoveryChanges.send(gatewayID: gatewayID)
      }
      await applyFailure(GatewayError.notFound)
      _ = await lifecycleChangeHandler([
        .removed(id: conversationID, revisionFloor: revisionFloor)
      ])
    } catch {
      await applyFailure(error)
    }
  }

  func updateDraft(_ text: String) async {
    guard rejectIfShutdown() == false, composerMutationAllowed else { return }
    state.draft = text
    await persistDraft()
  }

  func addSelections(_ selections: [ImageSelection]) async {
    guard rejectIfShutdown() == false, composerMutationAllowed else { return }
    do {
      state.attachments = try validator.prepare(selections, appendingTo: state.attachments)
      state.errorBanner = nil
      await persistDraft()
    } catch {
      state.errorBanner = error.localizedDescription
    }
  }

  func removeAttachment(id: UUID) async {
    guard rejectIfShutdown() == false, composerMutationAllowed else { return }
    state.attachments.removeAll { $0.id == id }
    await persistDraft()
  }

  func send() async {
    guard rejectIfShutdown() == false else { return }
    guard canSend else { return }
    let text = state.draft.trimmingCharacters(in: .whitespacesAndNewlines)
    let originalDraft = state.draft
    let originalAttachments = state.attachments
    let images: [MessageImage]
    do {
      let validated = try validator.prepare([], appendingTo: originalAttachments)
      images = try validated.map { try $0.messageImage() }
    } catch {
      state.errorBanner = error.localizedDescription
      return
    }

    let turnID = makeID()
    let localUserID = makeID()
    isSending = true
    defer { finishSendOperation() }
    let pending = PendingChatSend(
      turnID: turnID,
      localUserID: localUserID,
      draft: originalDraft,
      attachments: originalAttachments,
      createdAt: await clock.now()
    )
    guard await stagePendingSend(pending) else { return }
    pendingSendReconciliation = pending
    state.draft = ""
    state.attachments = []
    guard stagedSendAuthorityIsAvailable(turnID: turnID) else {
      await restorePendingSendAsDraft(pending)
      return
    }

    do {
      try await ensureConnected()
      guard stagedSendAuthorityIsAvailable(turnID: turnID) else {
        await restorePendingSendAsDraft(pending)
        return
      }
      localTurnIDs.insert(turnID)
      _ = ChatReducer.reduce(
        state: &state,
        action: .sendStarted(
          turnID: turnID,
          localUserID: localUserID,
          text: text,
          images: images
        )
      )
      transportSendInFlightTurnID = turnID
      try await transport.sendTurn(
        id: turnID,
        agentID: state.conversation.agentId,
        conversationID: state.conversation.id,
        text: text,
        images: images
      )
      await finishTransportSendBarrier(
        turnID: turnID,
        classifyDeferredFrames: true,
        replayDeferredFrames: true
      )
    } catch is CancellationError {
      if localTurnIDs.contains(turnID) {
        await reconcileAmbiguousSend(pending)
        await finishTransportSendBarrier(
          turnID: turnID,
          classifyDeferredFrames: false,
          replayDeferredFrames: true
        )
      } else {
        await restorePendingSendAsDraft(pending)
        await finishTransportSendBarrier(
          turnID: turnID,
          classifyDeferredFrames: false,
          replayDeferredFrames: false
        )
      }
      return
    } catch {
      guard localTurnIDs.contains(turnID) else {
        await restorePendingSendAsDraft(pending)
        await finishTransportSendBarrier(
          turnID: turnID,
          classifyDeferredFrames: false,
          replayDeferredFrames: false
        )
        await applyFailure(error)
        return
      }
      if sendFailureIsAmbiguous(error) {
        await reconcileAmbiguousSend(pending)
        await finishTransportSendBarrier(
          turnID: turnID,
          classifyDeferredFrames: false,
          replayDeferredFrames: true
        )
      } else {
        await rejectSend(pending, error: error)
        await finishTransportSendBarrier(
          turnID: turnID,
          classifyDeferredFrames: false,
          replayDeferredFrames: false
        )
      }
    }
  }

  /// Message actions (chat-ux Phase 2, Task 4 / audit #5): retry-failed and
  /// edit-and-resend both funnel through here. Semantics (binding across iOS
  /// and web): truncate the LOCAL transcript after and including the target
  /// user message, then send `editedText ?? original text` through the
  /// EXISTING `send()` path — this is deliberately a thin wrapper, not a new
  /// transport code path, so every guard/staging/reconciliation behavior
  /// `send()` already has (offline handling, pending-send durability, draft
  /// clearing) applies to a resend for free.
  ///
  /// Retry on a failed message is `resendFromMessage(id)` with no edit.
  /// "Failed" is never recorded on the user message itself — only the
  /// assistant/turn side ever gets `.failed` (`ChatReducer`'s `.error` case,
  /// mirrored server-side in `finishTurn`) — so `MessageViews.swift` derives
  /// "this user bubble's turn failed" by checking for a sibling assistant
  /// message with the same `turnID` and `.failed` status before offering
  /// Retry; this method itself doesn't need to re-derive that, it just
  /// truncates from whichever user message id it's given.
  ///
  /// KNOWN DIVERGENCE FROM A "REAL" EDIT/REGENERATE: this only ever
  /// truncates the LOCAL projection. The gateway has no branch-truncation
  /// API — resending appends a brand-new turn server-side, so the
  /// previously-sent (now locally-hidden) turn still exists in the server's
  /// history and would reappear if the transcript were ever re-fetched from
  /// a point before this edit (e.g. a second device open on the same
  /// conversation, or a future `refresh()` that doesn't preserve the live
  /// projection). Full server-side branch truncation is out of scope for
  /// this task; regenerating an assistant turn in place (as opposed to
  /// resending the user turn that produced it) is also out of scope — it
  /// needs server support Dash doesn't have yet.
  /// RETURN VALUE (fix I5, final-review): `true` once the resend passed
  /// every guard below and actually truncated + called `send()` — same
  /// meaning as the web store's `resendFromMessage` returning
  /// `Promise<boolean>` (see its doc comment in `apps/web/src/state/
  /// store.ts`), NOT "the network round-trip succeeded" (a network-level
  /// failure inside `send()` still returns `true` here; it surfaces through
  /// the resent message's own `.failed` status instead, same as any other
  /// send). `false` covers every guard above that no-ops: the feature is
  /// shut down, `id` doesn't name a `role: .user` message currently in the
  /// transcript, or (the common case) another turn already has send
  /// authority (`composerMutationAllowed`/`sendAuthorityIsAvailable`).
  /// `@discardableResult` because `send()`'s own callers (a plain Retry)
  /// don't need it — only `ChatView`'s Edit & Resend sheet does, to decide
  /// whether it's safe to dismiss (see `EditAndResendSheet`) instead of
  /// silently discarding whatever the user just typed.
  @discardableResult
  func resendFromMessage(id: String, editedText: String? = nil) async -> Bool {
    guard rejectIfShutdown() == false else { return false }
    guard
      let index = state.messages.firstIndex(where: { $0.id == id && $0.role == .user }),
      let user = state.messages[index].user
    else { return false }
    // A `.user` row the user did not write (sub-agents design 8.5). Two of
    // them now: a NOTIFICATION row's text is the
    // `[SYSTEM NOTIFICATION - NOT USER INPUT]` block the orchestrator was fed,
    // and a PARENT row's is the orchestrator's own instruction inside a
    // child's transcript. Resending either would submit somebody else's words
    // as the user's. `MessageListView` withholds the affordance too; this
    // guard holds regardless of caller.
    guard isSystemAuthoredRow(state.messages[index]) == false else { return false }
    guard composerMutationAllowed, sendAuthorityIsAvailable else { return false }

    let attachments: [PreparedAttachment] = user.images.compactMap { image in
      guard let data = Data(base64Encoded: image.data) else { return nil }
      return PreparedAttachment(id: UUID(), mediaType: image.mediaType.rawValue, data: data)
    }
    // Fix I6 (final-review): `send()` takes no text/attachments parameter of
    // its own, so a resend has always had to stage its payload through the
    // SAME composer state (`state.draft`/`state.attachments`) a genuinely
    // unsent draft lives in. Snapshot whatever's already there BEFORE
    // borrowing it below, and restore it once `send()` settles — otherwise
    // an unrelated draft (or staged attachment) the user was mid-typing
    // gets silently overwritten by the resent text/images. Because
    // `state.draft` is disk-persisted (`persistDraft()`), an unrestored
    // clobber here doesn't just cost the user their in-progress typing for
    // the rest of this session — a resend failure that falls through to
    // `restorePendingSendAsDraft` (see `send()`) would persist the RESENT
    // text as "the draft" to disk, so the loss would still be there after
    // an app relaunch too. This directly contradicts the edit sheet's own
    // design rationale for persisting drafts in the first place (see
    // `ChatView.swift`'s doc comment on why drafts survive relaunch at
    // all).
    let draftSnapshot = state.draft
    let attachmentsSnapshot = state.attachments
    state.messages.removeSubrange(index...)
    state.draft = editedText ?? user.text
    state.attachments = attachments
    await send()
    // Restore in every case EXCEPT a draft-conflict recovery flow
    // (`pendingSendRecovery` gets installed by `applyPendingSendDraftConflict`
    // when `send()`'s own failure handling finds an unrelated disk draft
    // that collides with restoring the resend as one) — that flow already
    // populated `state.draft` with something the user needs to resolve
    // through ITS OWN UI, so overwriting it here would fight that flow
    // instead of complementing it. Every other outcome of `send()`
    // (dispatched and awaiting confirmation — by far the common case,
    // `pendingSendReconciliation` stays non-nil for that entire window
    // because confirmation arrives asynchronously off a separate event
    // stream, NOT synchronously inside `send()` itself — a clean failure
    // restored as a draft, or an ambiguous failure pending reconciliation)
    // leaves `state.draft`/`.attachments` as either `""`/`[]` (send()'s own
    // optimistic clear) or the resent text/images being redisplayed as if
    // they were "the draft" — neither of which is more correct to show
    // than the user's own actual unsent draft, so restoring is always
    // right here. `persistDraft()` below still no-ops (returns without
    // writing) while `pendingSendReconciliation` is active, same as every
    // other composer mutation already does during that window — the
    // in-memory `state.draft` this method's caller reads is correct
    // immediately regardless.
    guard pendingSendRecovery == nil else { return true }
    state.draft = draftSnapshot
    state.attachments = attachmentsSnapshot
    await persistDraft()
    return true
  }

  // MARK: - Sub-agent rows (design 8.1-8.3)

  /// Toggle one row's expanded body.
  ///
  /// The reducer write happens FIRST and unconditionally, so the disclosure
  /// animates immediately and never depends on the network; the fetch and the
  /// subscription follow. Both are best-effort by design: an unopenable child
  /// must not take the parent transcript down with it (web reached the same
  /// rule in D2), so a failure lands on that row's own error line.
  /// `loadsTranscript` is false for a row at `maxSubagentDepth`, whose body
  /// opens no transcript: fetching and subscribing there would hold a live
  /// subscription nothing renders.
  ///
  /// **Synchronous on purpose, returning its follow-up rather than awaiting
  /// it.** The caller runs this inside `withAnimation`, and a `Task` there
  /// would put the state write outside the transaction — SwiftUI would commit
  /// an empty animation and the row would pop open. The expansion write is
  /// effect-free, so it goes straight through `ChatReducer.reduce` the way
  /// `answer(questionID:answer:)` already does for `.answerSubmitted`; only
  /// the network follow-up is deferred. The returned `Task` is what tests
  /// await; callers in the view ignore it.
  @discardableResult
  func setSubagentExpanded(
    _ childID: String,
    _ isExpanded: Bool,
    loadsTranscript: Bool = true
  ) -> Task<Void, Never> {
    guard rejectIfShutdown() == false else { return Task {} }
    _ = ChatReducer.reduce(
      state: &state,
      action: .subagentExpanded(
        id: childID,
        isExpanded: isExpanded,
        opensTranscript: loadsTranscript
      )
    )
    guard loadsTranscript else { return Task {} }
    return Task { [self] in
      if isExpanded {
        await loadSubagentTranscript(childID: childID)
        await subscribeToSubagent(childID)
      } else {
        await unsubscribeFromSubagent(childID)
      }
    }
  }

  /// The child's own transcript (REST) plus its `oneShot` fact.
  ///
  /// Re-read on EVERY expansion rather than once: the row is collapsed most of
  /// the time, and while it is collapsed no subscription is held, so anything
  /// the child said in between reached nobody. A cached-once transcript would
  /// silently be stale exactly when the user goes looking.
  func loadSubagentTranscript(childID: String) async {
    guard isShutdown == false else { return }
    do {
      let snapshot = try await synchronizer.subagentTranscript(childID: childID)
      guard isShutdown == false, state.subagentUI[childID] != nil else { return }
      await applyReducerAction(
        .subagentTranscriptLoaded(id: childID, messages: snapshot.messages)
      )
      if let oneShot = snapshot.oneShot {
        await applyReducerAction(.subagentInfoLoaded(id: childID, oneShot: oneShot))
      }
    } catch is CancellationError {
      return
    } catch {
      guard isShutdown == false else { return }
      // Reported on the row, NOT through `applyFailure`: a child that 404s
      // (pruned, or on a gateway that does not know it) must not drive the
      // whole conversation into a repair state. `unauthorized` is the one
      // exception worth escalating, because every later request will fail too.
      if case GatewayError.unauthorized = error {
        await applyFailure(error)
        return
      }
      await applyReducerAction(
        .subagentTranscriptFailed(
          id: childID,
          message: subagentFailureText(error, fallback: "Couldn't load this agent's transcript.")
        )
      )
    }
  }

  /// Unsent composer text for sub-agent rows, keyed `reply:<childId>` and
  /// `body:<childId>` — web's keying verbatim
  /// (`apps/web/src/ui/blocks/SubagentBlock.tsx:674`, `:689`). One child can
  /// render BOTH a `waiting_input` reply and a body composer at once, so a
  /// bare child id would make them share one buffer.
  ///
  /// **Why it is a property here and not in `ChatState.subagentUI`.** `ChatView`
  /// reads `feature.state`, so a draft routed through the reducer invalidates
  /// every reader of `state` — the whole transcript — on each keystroke. That
  /// is the fan-out web measured (six Markdown re-renders per keystroke) and
  /// it is a real reason to keep the draft out of `ChatState`. It is not a
  /// reason to drop the draft: Swift Observation tracks access **per stored
  /// property**, so reading this one from inside `SubagentComposer.body`
  /// invalidates that composer and nothing else. The first round ruled out
  /// `ChatState` correctly and then stopped looking, and the cost was a
  /// divergence from web that the goal's parity requirement does not allow.
  ///
  /// **`Composer` is in the name deliberately.** `ChatAssistantState` already
  /// has an unrelated `subagentDrafts` (`ChatReducer.swift:198`) — the
  /// accumulating `[SubagentDraft]` sub-agent *cards*, which `ChatView` reads
  /// for the transcript signature. Two different things sharing one name in
  /// two files a reader of this feature has open at once is how a future
  /// reader chasing "the draft store" lands in the wrong one; the compiler
  /// would not stop them, because it separates the two by type, not by intent.
  var subagentComposerDrafts: [String: String] = [:]

  func subagentComposerDraft(_ key: String) -> String { subagentComposerDrafts[key] ?? "" }

  /// Empty text REMOVES the key rather than storing `""`, so a session that
  /// visits many rows does not accumulate one entry per composer it rendered.
  func setSubagentComposerDraft(_ key: String, _ text: String) {
    if text.isEmpty {
      subagentComposerDrafts.removeValue(forKey: key)
    } else {
      subagentComposerDrafts[key] = text
    }
  }

  // MARK: - Tasks sheet (§8.4)

  /// This conversation's sub-agent children, from `GET
  /// /conversations/{id}/subagents` and from NOTHING ELSE (§8.4, ruling R1).
  ///
  /// **Why this is not merged with the transcript fold.** Web tried the merge
  /// (terminal-wins) in its D3 and rejected it over a bug that never goes
  /// away: a resume restarts a `done` child, but the fold's `done` comes from a
  /// PERSISTED event that never changes, so the list would read `done` for the
  /// whole of the child's second run. The fold has three more limits on top of
  /// that — it sees only children anchored in a message this client has
  /// loaded, it exempts a background child from end-of-stream terminalization
  /// (which is correct for the ROW and wrong for a list that claims to say
  /// what is live), and after a gateway restart the recovered child rows are
  /// all there is.
  ///
  /// **Why a property on the feature and not a `ChatState` field.** Swift
  /// Observation tracks access per STORED property, and `ChatState` is one
  /// stored property that `ChatView`'s whole transcript reads. A list that
  /// re-reads on every parent `done` would therefore invalidate the transcript
  /// once per assistant turn — web measured exactly this fan-out as its D3 I3a
  /// and paid a fix round for it. Here the badge, the strip and the sheet are
  /// the only readers, and `feature.state` is untouched by a list write. Same
  /// reasoning, and the same precedent, as `subagentComposerDrafts`.
  private(set) var subagents: [SubagentListEntryDTO] = []

  /// Children with a `POST /subagents/{id}/stop` in flight. Held here rather
  /// than in the sheet's `@State` so the disabled Stop button survives the
  /// sheet being dismissed and re-presented mid-request.
  private(set) var stoppingSubagentIDs: Set<String> = []

  /// The last stop refusal per child, verbatim from the gateway. Cleared on the
  /// next attempt and by a re-read that shows the child terminal.
  private(set) var subagentStopErrors: [String: String] = [:]

  /// The one error line a tasks-sheet row can show, whichever of the row's two
  /// actions produced it.
  ///
  /// **Why this exists at all.** A refused RESUME does not land here — it lands
  /// on `ChatState.subagentUI[id].lastError`, whose only other render site is
  /// the transcript card. The sheet's headline case is a background child that
  /// finished after its spawning turn, which the transcript has NO card for, so
  /// before this accessor the gateway's three actionable 409s
  /// (`coordinator.ts:674/717/726` — one-shot type, unrebuildable grant, steer
  /// cap) were rendered by no view anywhere: the spinner stopped, the sentence
  /// stayed in the field, and nothing said why.
  ///
  /// **Precedence is "whichever action was taken last", and it is maintained by
  /// the two writers rather than by this reader.** `stopSubagent` clears BOTH
  /// slots on its attempt and `sendToSubagent` clears both on its, so at most
  /// one of them is non-nil for a child that has an action in flight, and a
  /// stale refusal from the other action can never mask the fresh one.
  func subagentRowError(_ childID: String) -> String? {
    subagentStopErrors[childID] ?? state.subagentUI[childID]?.lastError
  }

  /// Monotonic cursor for list reads, so only the NEWEST one ever writes.
  ///
  /// Every trigger fires in bursts — two children starting inside one turn is
  /// two reads, and the notification `accepted` and the turn's `done` are two
  /// more — and nothing makes REST answer them in order, so a read issued
  /// before a child finished can resolve after one issued after it.
  /// Last-write-wins would park the sheet on the older snapshot with nothing
  /// left to correct it.
  @ObservationIgnored private var subagentReadSeq: UInt64 = 0
  @ObservationIgnored private var appliedSubagentReadSeq: UInt64 = 0

  /// The most recent triggered list read. Production ignores it; it exists so a
  /// test can await the read a FRAME started, the same way
  /// `setSubagentExpanded` returns its own follow-up.
  @ObservationIgnored private(set) var subagentRefreshTask: Task<Void, Never>?

  /// How many children have not finished — §8.4's badge number, and what makes
  /// the pinned strip visible.
  ///
  /// Counts every entry the gateway returned, including one whose `depth`
  /// puts it past `maxSubagentDepth`: the cap governs whether a ROW opens a
  /// transcript, not whether a child is real.
  var liveSubagentCount: Int {
    subagents.count { SubagentCardStatus(wire: $0.status).isTerminal == false }
  }

  /// Re-read the child list. Every trigger funnels through here.
  func refreshSubagents() async {
    guard isShutdown == false else { return }
    subagentReadSeq &+= 1
    let readSeq = subagentReadSeq
    let entries: [SubagentListEntryDTO]
    do {
      entries = try await synchronizer.subagents(conversationID: state.conversation.id)
    } catch is CancellationError {
      return
    } catch {
      // Only a dead credential is worth escalating; every other failure leaves
      // the sheet on the snapshot it had, and a start, a finish, a turn end, a
      // reconnect or a foreground fires this again.
      if case GatewayError.unauthorized = error { await applyFailure(error) }
      return
    }
    apply(entries, readSeq: readSeq)
  }

  private func apply(_ entries: [SubagentListEntryDTO], readSeq: UInt64) {
    // The iOS counterpart of web's conversation-switch guard. Web needs that
    // one because one store serves every conversation; here `AppModel` keys a
    // `ChatFeature` by (gateway, conversation) and `consumeCanonicalSummary`
    // refuses a summary for any other id, so a read can only ever land on the
    // conversation that issued it. What CAN happen is the feature being
    // retired while a read is in flight.
    guard isShutdown == false else { return }
    guard readSeq > appliedSubagentReadSeq else { return }
    appliedSubagentReadSeq = readSeq
    // No "did anything change?" skip here, and that is a MEASURED decision
    // rather than an oversight. Web needed one (its D3 I3a): every read there
    // allocates a fresh `facts` object per child, its store subscribers compare
    // by reference, and an identical read re-rendered every mounted row and its
    // whole nested transcript. Swift Observation compares by VALUE — assigning
    // a value equal to the current one notifies NOBODY. Proven by probe rather
    // than assumed, in three shapes: the same array buffer, an assignment after
    // a suspension, and an equal array of `SubagentListEntryDTO`; none fired,
    // while a genuinely different value in the same probe did. A guard here
    // would be dead code, and the test that "covered" it could not have failed
    // — the exact pattern this branch keeps catching. The property it would
    // have protected is real and IS pinned, by
    // `anIdenticalListReadInvalidatesNothing`, which owns a positive control.
    subagents = entries
  }

  /// Cancel a child and, depth-first, its descendants (§8.4's Stop).
  @discardableResult
  func stopSubagent(_ childID: String) async -> Bool {
    guard rejectIfShutdown() == false else { return false }
    guard stoppingSubagentIDs.insert(childID).inserted else { return false }
    subagentStopErrors[childID] = nil
    // BOTH slots, because the row shows ONE line: leaving a previous resume
    // refusal up while a stop is in flight reads as though the stop had failed
    // for a reason that has nothing to do with it, and a stop that then
    // succeeds would leave it there for good.
    await applyReducerAction(.subagentActionRetried(id: childID))
    defer { stoppingSubagentIDs.remove(childID) }
    do {
      let status = try await synchronizer.stopSubagent(id: childID)
      guard isShutdown == false else { return false }
      // Applied BEFORE the re-read so the row stops offering a Stop on this
      // frame rather than one round trip later, and applied from the
      // RESPONSE because the route's status is authoritative: it terminalizes
      // the row itself when the cascade reached a child this gateway process
      // no longer holds a handle for, which is not a status the client could
      // have guessed.
      applyStopped(status, to: childID)
      await refreshSubagents()
      return true
    } catch is CancellationError {
      return false
    } catch {
      guard isShutdown == false else { return false }
      if case GatewayError.unauthorized = error { await applyFailure(error) }
      // The re-read comes FIRST, and then decides whether there is anything to
      // report. A stop that merely raced the child's own finish is refused
      // with the gateway's "already <status>" text, and web tells that case
      // apart by the 409 — which iOS cannot do, because
      // `HTTPTransport.swift:214` maps every `validation_failed` to
      // `GatewayError.validation(String)` and drops the status. Asking the
      // server what is true now is better evidence than the status code
      // anyway: if the child is terminal the stop's purpose is served,
      // whoever achieved it, and an error line would be noise. A partial
      // cascade that killed descendants before the refusal is picked up by
      // the same read.
      await refreshSubagents()
      guard isShutdown == false else { return false }
      if let entry = subagents.first(where: { $0.id == childID }),
        SubagentCardStatus(wire: entry.status).isTerminal
      {
        return true
      }
      subagentStopErrors[childID] = subagentFailureText(
        error,
        fallback: "Couldn't stop this agent. Try again."
      )
      return false
    }
  }

  private func applyStopped(_ status: String, to childID: String) {
    guard let index = subagents.firstIndex(where: { $0.id == childID }) else { return }
    // The list is being written by something that is NOT a read, so the read
    // cursor has to move with it. A read issued before the stop and still in
    // flight otherwise satisfies `readSeq > appliedSubagentReadSeq` when it
    // lands, restores the pre-stop row and re-offers Stop for a child that is
    // already gone. Costs at most one dropped read, and the stop's own
    // re-read — issued immediately after this and therefore newer than the
    // cursor — replaces the whole list anyway.
    appliedSubagentReadSeq = subagentReadSeq
    let entry = subagents[index]
    subagents[index] = SubagentListEntryDTO(
      id: entry.id,
      name: entry.name,
      type: entry.type,
      description: entry.description,
      status: status,
      background: entry.background,
      depth: entry.depth,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      usage: entry.usage,
      toolCallCount: entry.toolCallCount,
      report: entry.report,
      oneShot: entry.oneShot
    )
  }

  /// Open this child's row in the transcript, for a tap on a tasks-sheet row
  /// (§8.4: "clicking scrolls to and expands the row").
  ///
  /// **Guarded on the row existing.** The sheet's model is REST and the
  /// transcript's is the fold, and the two do not always overlap — a background
  /// child that finished after its spawning turn, or one whose start event sits
  /// in a message this client has not loaded, is in the list with no row to
  /// open. Expanding it anyway would fetch its transcript and hold a live
  /// subscription that nothing renders, which is the leak class D2, D3 and D5's
  /// own second defect all paid for.
  ///
  /// A row reached from here is a DIRECT child of the open conversation, so it
  /// renders at view depth 0 and `subagentRowIsNested` decides whether its
  /// expansion opens a transcript at all — the same call the row's own
  /// disclosure makes.
  func revealSubagent(_ childID: String) {
    guard hasSubagentCard(childID) else { return }
    setSubagentExpanded(childID, true, loadsTranscript: subagentRowIsNested(depth: 0))
  }

  /// Whether the open transcript renders a row for this child.
  func hasSubagentCard(_ childID: String) -> Bool {
    state.messages.contains { message in
      message.assistant?.subagentCards.contains { $0.id == childID } ?? false
    }
  }

  /// Fire a list read a frame or a lifecycle event asked for, without making
  /// the caller wait: `consume` runs the socket's event loop, and awaiting a
  /// REST round trip there would hold up every frame behind it.
  private func triggerSubagentRefresh() {
    subagentRefreshTask = Task { [self] in await refreshSubagents() }
  }

  /// Type into a child (design 8.3) through `POST /subagents/{id}/resume`.
  ///
  /// **Not a `message` WS frame.** That frame reaches `hub.start` →
  /// `acceptTurn` and can never reach `ChildHandle.answerQuestion`, the only
  /// thing that resolves a child parked on `ask_orchestrator`; against a busy
  /// child it is refused as `conversation_busy`, against an idle one it opens
  /// a second turn while the question stays blocked; and it bypasses the
  /// coordinator's one-shot, steer-cap and grant checks entirely.
  ///
  /// **Optimism is derived here, from `subscribedSubagentIDs`, and is not a
  /// parameter.** The rule is "optimistic exactly when a subscription is
  /// held", and this is the only place that knows whether one is. Every proxy
  /// for it has been wrong in both directions: `isExpanded && nested` is true
  /// for a row whose `subscribeToSubagent` swallowed a failure and true again
  /// after the app is backgrounded (which clears the set and the gateway's
  /// side with it), and in both states the `accepted` never arrives, the
  /// optimistic row is never adopted, and `.subagentTranscriptLoaded` keeps it
  /// forever beside the real server row — the user's sentence rendered twice
  /// for the life of the conversation. A hardcoded `false` is wrong the other
  /// way: a queued STEER *does* echo, finds nothing in `pendingRequestIDs`,
  /// and `applyChildFrame`'s else-branch appends a blank "from orchestrator"
  /// line. Web converged on the same rule after three rounds.
  @discardableResult
  func sendToSubagent(_ childID: String, text: String) async -> Bool {
    guard rejectIfShutdown() == false else { return false }
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.isEmpty == false else { return false }
    let optimistic = subscribedSubagentIDs.contains(childID)
    // The tasks row shows ONE error line for the child, so the action being
    // taken now owns it — `.subagentReplyStarted` clears `lastError` below and
    // this clears the stop's slot, which is the other half of the same rule.
    subagentStopErrors[childID] = nil
    let requestID = makeID()
    await applyReducerAction(
      .subagentReplyStarted(
        id: childID,
        requestID: requestID,
        text: trimmed,
        optimistic: optimistic
      )
    )
    do {
      try await synchronizer.resumeSubagent(id: childID, message: trimmed, requestID: requestID)
      guard isShutdown == false else { return false }
      await applyReducerAction(.subagentReplySucceeded(id: childID, requestID: requestID))
      return true
    } catch is CancellationError {
      return false
    } catch {
      guard isShutdown == false else { return false }
      if case GatewayError.unauthorized = error {
        await applyFailure(error)
      }
      await applyReducerAction(
        .subagentReplyFailed(
          id: childID,
          requestID: requestID,
          // The coordinator's three refusals (one-shot type, steer cap,
          // unrebuildable grant) arrive as 409 `validation_failed` with
          // actionable text. Showing it verbatim is design 8.3's "shows the
          // reason"; collapsing it to a generic line throws the only useful
          // part away.
          message: subagentFailureText(error, fallback: "Couldn't reach this agent.")
        )
      )
      return false
    }
  }

  private func subagentFailureText(_ error: Error, fallback: String) -> String {
    switch error as? GatewayError {
    case let .validation(message): message
    case let .server(body, _): body.error
    case .notFound: "This agent is no longer available."
    case .unauthorized: "Sign in again to reach this agent."
    default: fallback
    }
  }

  private func subscribeToSubagent(_ childID: String) async {
    guard isShutdown == false, connection == .online else { return }
    do {
      try await ensureConnected()
      guard isShutdown == false else { return }
      // The user can collapse the row while the REST read or the connect is in
      // flight. `unsubscribeFromSubagent` would have found nothing in the set
      // and returned, so without this the late subscribe would leak a live
      // subscription on a COLLAPSED row that nothing releases until the socket
      // resets — the refcount class D2 and D3 both paid for.
      guard state.subagentUI[childID]?.isExpanded == true else { return }
      try await transport.subscribe(
        agentID: state.conversation.agentId,
        conversationID: childID
      )
      subscribedSubagentIDs.insert(childID)
    } catch is CancellationError {
      return
    } catch {
      // A missing subscription costs live streaming into the open body, not
      // correctness: the REST read already populated it, and collapsing plus
      // re-expanding re-reads. Not worth driving the conversation into a
      // failure state for.
      return
    }
  }

  /// Re-establish the child subscriptions a socket reset dropped, beside the
  /// parent's own `subscribeToOpenConversation`.
  ///
  /// `subscribedSubagentIDs.removeAll()` fires in `ensureConnected`, on a
  /// terminal receive-loop failure and in `consume(.state)` for
  /// `.idle`/`.detached`. Clearing the set is correct — the gateway really has
  /// dropped those subscriptions — but until this existed, nothing put them
  /// back. A transient reconnect was already covered (`ChatConnection`'s
  /// `replayTurnSubscriptions` re-sends every conversation subscribe on
  /// `.reconnecting` → `.connected`); **backgrounding the app was not**, and
  /// that is the most routine lifecycle event on a phone. The mechanism, stated
  /// exactly: `suspendForDetachment` calls `ChatConnection.suspend()`, which
  /// cancels the socket, `clearAllTurns()`s the transport's own map and only
  /// then transitions to **`.idle`** — so the drop is genuine, but this set is
  /// cleared *asynchronously*, when the event task drains that `.idle` in
  /// `consume(.state)`'s `.idle`/`.detached` branch below. (`.detached` is
  /// what the FEATURE reduces into `state.transport`; the transport never
  /// emits it here.) Meanwhile the open body went on looking live while every
  /// send from it was optimistic against a subscription no longer held.
  ///
  /// The REST re-read is as load-bearing as the subscribe: everything the
  /// child said while this client was detached reached nobody, and the page is
  /// the only thing that fills the hole.
  ///
  /// Rows already in the set are skipped, so an `appear()` that did not reset
  /// the socket re-reads nothing. Rows at `maxSubagentDepth` are skipped by
  /// `opensTranscript`, which is the recorded fact rather than a guess:
  /// `setSubagentExpanded(loadsTranscript: false)` deliberately neither
  /// fetches nor subscribes, and a reconnect must not undo that.
  private func resubscribeExpandedSubagents() async {
    guard isShutdown == false, isVisible, connection == .online else { return }
    let dropped =
      state.subagentUI
      .filter { $0.value.isExpanded && $0.value.opensTranscript }
      .map(\.key)
      .filter { subscribedSubagentIDs.contains($0) == false }
      .sorted()
    for childID in dropped {
      guard isShutdown == false else { return }
      await loadSubagentTranscript(childID: childID)
      await subscribeToSubagent(childID)
    }
  }

  private func unsubscribeFromSubagent(_ childID: String) async {
    guard subscribedSubagentIDs.remove(childID) != nil, isConnected else { return }
    try? await transport.unsubscribe(
      agentID: state.conversation.agentId,
      conversationID: childID
    )
  }

  func answer(questionID: String, answer: String) async {
    guard rejectIfShutdown() == false else { return }
    guard canAnswerQuestions else { return }
    let trimmed = answer.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.isEmpty == false else { return }
    guard let turnID = turnID(forQuestion: questionID) else { return }
    guard answerRequestsInFlight.insert(questionID).inserted else { return }
    defer { answerRequestsInFlight.remove(questionID) }
    do {
      try await transport.answer(turnID: turnID, questionID: questionID, answer: trimmed)
      guard isShutdown == false, self.turnID(forQuestion: questionID) == turnID else { return }
      submittedAnswers[questionID] = trimmed
      _ = ChatReducer.reduce(
        state: &state,
        action: .answerSubmitted(questionID: questionID, answer: trimmed)
      )
      state.errorBanner = nil
    } catch is CancellationError {
      return
    } catch {
      if case .transport? = error as? GatewayError {
        state.errorBanner = "That answer couldn't be sent. Try again."
      } else {
        await applyFailure(error)
      }
    }
  }

  func cancel() async {
    guard rejectIfShutdown() == false else { return }
    guard
      canCancel,
      let turnID = state.activeTurnID,
      localTurnIDs.contains(turnID),
      cancelRequestSent == false,
      cancelRequestInFlight == false
    else { return }
    cancelRequestInFlight = true
    isCancelling = true
    defer { cancelRequestInFlight = false }
    do {
      try await transport.cancel(turnID: turnID)
      guard
        isShutdown == false,
        state.activeTurnID == turnID,
        localTurnIDs.contains(turnID)
      else { return }
      cancelRequestSent = true
      _ = ChatReducer.reduce(state: &state, action: .cancelRequested)
    } catch is CancellationError {
      isCancelling = false
      return
    } catch {
      isCancelling = false
      await applyFailure(error)
    }
  }

  func retryConnection() async {
    await recoverConnection(shouldRetryPendingSend: true)
  }

  func connectionDidBecomeOnline() async {
    await recoverConnection(shouldRetryPendingSend: false)
  }

  private func recoverConnection(shouldRetryPendingSend: Bool) async {
    guard rejectIfShutdown() == false, connection == .online else { return }
    let attachmentIntent = beginAttachmentIntent(attached: true)
    let pendingTurnID = shouldRetryPendingSend ? pendingSendReconciliation?.turnID : nil
    await refreshCanonical(preserveLiveProjection: true)
    guard isCurrentAttachmentIntent(attachmentIntent, attached: true) else { return }
    if shouldRetryPendingSend,
      let pendingSendReconciliation,
      pendingSendReconciliation.turnID == pendingTurnID
    {
      await retryPendingSend(pendingSendReconciliation)
      return
    }
    await attachToCanonicalTurnIfNeeded()
    await subscribeToOpenConversation()
    await resubscribeExpandedSubagents()
    // Same gap one level up: children that started or finished while the
    // socket was down left no trace on this client at all.
    await refreshSubagents()
  }

  func sceneDidEnterBackground() async {
    guard isShutdown == false else { return }
    let attachmentIntent = beginAttachmentIntent(attached: false)
    await persistDraft()
    guard isCurrentAttachmentIntent(attachmentIntent, attached: false) else { return }
    await suspendForDetachment()
  }

  func sceneWillEnterForeground() async {
    guard rejectIfShutdown() == false, connection == .online else { return }
    let attachmentIntent = beginAttachmentIntent(attached: true)
    startEventTaskIfNeeded()
    await refreshCanonical(preserveLiveProjection: true)
    guard isCurrentAttachmentIntent(attachmentIntent, attached: true) else { return }
    await attachToCanonicalTurnIfNeeded()
    await subscribeToOpenConversation()
    await resubscribeExpandedSubagents()
    // Same gap one level up: children that started or finished while the
    // socket was down left no trace on this client at all.
    await refreshSubagents()
  }

  func prepareForShutdown() {
    guard isShutdown == false else { return }
    isShutdown = true
    isAuthoritative = false
    isLoadingInitial = false
    gatewayErrorHandler = nil
    lifecycleChangeHandler = { _ in .ignored }
    canonicalRefreshRevision &+= 1
    recoveryClassificationRevision = nil
    recoveryClassificationTurnID = nil
    recoveryResolutionHoldTurnID = nil
    summaryOnlyFollowUpTurnID = nil
    transportSendInFlightTurnID = nil
    deferredReplayTurnID = nil
    deferredRecoveryFrames.removeAll()
    _ = beginAttachmentIntent(attached: false)
    isVisible = false
    eventTask?.cancel()
    cacheLoadGeneration &+= 1
    cacheLoadTask?.cancel()
    recoveryChangeGeneration &+= 1
    isStartingRecoveryChangeObservation = false
    recoveryChangeTask?.cancel()
  }

  func shutdown() async {
    prepareForShutdown()
    if shutdownDrainCompleted { return }
    if shutdownDrainStarted {
      await withCheckedContinuation { continuation in
        shutdownDrainWaiters.append(continuation)
      }
      return
    }
    shutdownDrainStarted = true
    let retiringEventTask = eventTask
    eventTask = nil
    let retiringCacheLoad = cacheLoadTask
    cacheLoadTask = nil
    let retiringRecoveryChangeTask = recoveryChangeTask
    recoveryChangeTask = nil
    let retiringDraftWrite = draftWriteTask
    let transportShutdown = Task { [transport] in await transport.shutdown() }
    let synchronizerShutdown = Task { [synchronizer] in await synchronizer.shutdown() }
    await waitForSendCompletion()
    await transportShutdown.value
    await synchronizerShutdown.value
    await retiringEventTask?.value
    await retiringCacheLoad?.value
    await retiringRecoveryChangeTask?.value
    await waitForRecoveryChangeOperationsToFinish()
    _ = await retiringDraftWrite?.value
    draftWriteTask = nil
    isConnected = false
    state.transport = .detached
    shutdownDrainCompleted = true
    let waiters = shutdownDrainWaiters
    shutdownDrainWaiters.removeAll()
    for waiter in waiters {
      waiter.resume()
    }
  }

  private func loadCache() async {
    cacheLoadGeneration &+= 1
    let generation = cacheLoadGeneration
    let task = Task { @MainActor [weak self] in
      guard let self else { return }
      await self.performCacheLoad(generation: generation)
    }
    cacheLoadTask = task
    await task.value
    if generation == cacheLoadGeneration {
      cacheLoadTask = nil
    }
  }

  private func performCacheLoad(generation: UInt64) async {
    let persistence = persistence
    let gatewayID = gatewayID
    let conversationID = state.conversation.id
    let initialPendingSendReadRevision = pendingSendReadRevision
    async let messagesRead = readChatCacheValue {
      try await persistence.messages(gatewayID: gatewayID, conversationID: conversationID)
    }
    async let draftRead = readChatCacheValue {
      try await persistence.draft(gatewayID: gatewayID, conversationID: conversationID)
    }
    async let pendingRead = readChatCacheValue {
      try await persistence.pendingSend(gatewayID: gatewayID, conversationID: conversationID)
    }
    async let cursorRead = readChatCacheValue {
      try await persistence.cursor(gatewayID: gatewayID, conversationID: conversationID)
    }
    let (messagesResult, draftResult, initialPendingResult, cursorResult) = await (
      messagesRead,
      draftRead,
      pendingRead,
      cursorRead
    )
    guard cacheLoadIsCurrent(generation) else { return }

    var pendingResult = initialPendingResult
    var observedPendingSendReadRevision = initialPendingSendReadRevision
    var pendingRefreshHadFailure = false
    while pendingSendReadRevision != observedPendingSendReadRevision {
      observedPendingSendReadRevision = pendingSendReadRevision
      let refreshedPendingResult = await readChatCacheValue {
        try await persistence.pendingSend(
          gatewayID: gatewayID,
          conversationID: conversationID
        )
      }
      guard cacheLoadIsCurrent(generation) else { return }
      switch refreshedPendingResult {
      case .value:
        pendingResult = refreshedPendingResult
      case .failed:
        pendingRefreshHadFailure = true
      case .cancelled:
        break
      }
    }

    var cachedMessages: [ConversationMessageDTO] = []
    var cachedCursor = state.lastAppliedSeq
    var hasMessageOrCursorValue = false
    var hasCachedDraft = false
    var hadFailure = pendingRefreshHadFailure
    switch messagesResult {
    case .value(let messages):
      cachedMessages = messages
      hasMessageOrCursorValue = true
    case .failed:
      hadFailure = true
    case .cancelled:
      break
    }
    switch cursorResult {
    case .value(let cursor):
      cachedCursor = cursor
      hasMessageOrCursorValue = true
    case .failed:
      hadFailure = true
    case .cancelled:
      break
    }
    if hasMessageOrCursorValue {
      _ = ChatReducer.reduce(
        state: &state,
        action: .cachedMessagesLoaded(cachedMessages, cursor: cachedCursor)
      )
    }
    guard cacheLoadIsCurrent(generation) else { return }

    switch draftResult {
    case .value(let draft):
      if let draft {
        hasCachedDraft = true
        state.draft = draft.text
        state.attachments = draft.attachments
      }
    case .failed:
      hadFailure = true
    case .cancelled:
      break
    }
    guard cacheLoadIsCurrent(generation) else { return }

    switch pendingResult {
    case .value(let result):
      await applyPendingSendLoadResult(
        result,
        cachedMessages: cachedMessages,
        preserveComposer: hasCachedDraft
      )
    case .failed:
      hadFailure = true
    case .cancelled:
      break
    }
    guard cacheLoadIsCurrent(generation) else { return }
    if hadFailure, state.errorBanner == nil {
      state.errorBanner = "Saved conversation data couldn't be loaded."
    }
  }

  private func cacheLoadIsCurrent(_ generation: UInt64) -> Bool {
    isShutdown == false && generation == cacheLoadGeneration && Task.isCancelled == false
  }

  private func applyPendingSendLoadResult(
    _ result: PendingSendLoadResult,
    cachedMessages: [ConversationMessageDTO],
    preserveComposer: Bool
  ) async {
    guard isShutdown == false else { return }
    switch result {
    case .none:
      pendingSendRecovery = nil
    case .recoveryRequired(let recovery):
      installPendingSendRecovery(recovery, clearComposer: preserveComposer == false)
    case .resumable(let pending):
      pendingSendRecovery = nil
      pendingSendReconciliation = pending
      localTurnIDs.insert(pending.turnID)
      if preserveComposer == false {
        state.draft = ""
        state.attachments = []
      }
      if cachedMessages.contains(where: { $0.turnId == pending.turnID }) {
        _ = await clearPendingSendDurably(pending)
      } else {
        do {
          let images = try pending.attachments.map { try $0.messageImage() }
          guard isShutdown == false else { return }
          _ = ChatReducer.reduce(
            state: &state,
            action: .sendStarted(
              turnID: pending.turnID,
              localUserID: pending.localUserID,
              text: pending.draft.trimmingCharacters(in: .whitespacesAndNewlines),
              images: images
            )
          )
        } catch {
          guard isShutdown == false else { return }
          state.errorBanner = "A pending message attachment couldn't be restored."
        }
      }
    }
  }

  private func installPendingSendRecovery(
    _ recovery: RecoverablePendingSend,
    clearComposer: Bool = true
  ) {
    guard isShutdown == false else { return }
    pendingSendRecovery = recovery
    pendingSendReconciliation = nil
    localTurnIDs.remove(recovery.pendingSend.turnID)
    if clearComposer {
      state.draft = ""
      state.attachments = []
    }
  }

  private func startRecoveryChangeObservation() async {
    guard
      isShutdown == false,
      recoveryChangeTask == nil,
      isStartingRecoveryChangeObservation == false
    else { return }
    guard beginRecoveryChangeOperation() else { return }
    defer { finishRecoveryChangeOperation() }
    isStartingRecoveryChangeObservation = true
    recoveryChangeGeneration &+= 1
    let generation = recoveryChangeGeneration
    defer {
      if generation == recoveryChangeGeneration {
        isStartingRecoveryChangeObservation = false
      }
    }
    let subscription = await recoveryChanges.subscription(gatewayID: gatewayID)
    guard
      isShutdown == false,
      generation == recoveryChangeGeneration,
      recoveryChangeTask == nil
    else {
      await subscription.cancel()
      return
    }
    recoveryChangeTask = Task { @MainActor [weak self, gatewayID] in
      guard Task.isCancelled == false else {
        await subscription.cancel()
        return
      }
      for await changedGatewayID in subscription.changes {
        guard Task.isCancelled == false else { break }
        guard changedGatewayID == gatewayID else { continue }
        await self?.receiveRecoveryChange(generation: generation)
      }
      await subscription.cancel()
    }
  }

  private func receiveRecoveryChange(generation: UInt64) async {
    guard
      isShutdown == false,
      generation == recoveryChangeGeneration
    else { return }
    pendingSendReadRevision &+= 1
    guard pendingSendRecovery != nil else { return }
    do {
      let result = try await persistence.pendingSend(
        gatewayID: gatewayID,
        conversationID: state.conversation.id
      )
      guard
        isShutdown == false,
        generation == recoveryChangeGeneration,
        pendingSendRecovery != nil
      else { return }
      switch result {
      case .none:
        let draft = try await persistence.draft(
          gatewayID: gatewayID,
          conversationID: state.conversation.id
        )
        guard
          isShutdown == false,
          generation == recoveryChangeGeneration,
          pendingSendRecovery != nil
        else { return }
        state.draft = draft?.text ?? ""
        state.attachments = draft?.attachments ?? []
        draftStatus = .saved
        pendingSendRecovery = nil
      case .recoveryRequired(let recovery):
        installPendingSendRecovery(recovery, clearComposer: false)
      case .resumable:
        break
      }
    } catch is CancellationError {
      return
    } catch {
      return
    }
  }

  private func beginRecoveryChangeOperation() -> Bool {
    guard isShutdown == false else { return false }
    activeRecoveryChangeOperations += 1
    return true
  }

  private func finishRecoveryChangeOperation() {
    activeRecoveryChangeOperations -= 1
    guard activeRecoveryChangeOperations == 0 else { return }
    let waiters = recoveryChangeOperationWaiters
    recoveryChangeOperationWaiters.removeAll()
    for waiter in waiters {
      waiter.resume()
    }
  }

  private func waitForRecoveryChangeOperationsToFinish() async {
    guard activeRecoveryChangeOperations > 0 else { return }
    await withCheckedContinuation { continuation in
      recoveryChangeOperationWaiters.append(continuation)
    }
  }

  @discardableResult
  private func persistDraft() async -> Bool {
    guard pendingSendReconciliation == nil, pendingSendRecovery == nil else { return true }
    return await persistDraft(text: state.draft, attachments: state.attachments)
  }

  private func persistDraft(text: String, attachments: [PreparedAttachment]) async -> Bool {
    guard pendingSendRecovery == nil else { return false }
    draftWriteRevision &+= 1
    let revision = draftWriteRevision
    let previousWrite = draftWriteTask
    let persistence = persistence
    let clock = clock
    let gatewayID = gatewayID
    let conversationID = state.conversation.id
    draftStatus = .saving
    let write = Task {
      _ = await previousWrite?.value
      do {
        let now = await clock.now()
        try await persistence.saveDraft(
          ConversationDraft(text: text, attachments: attachments, updatedAt: now),
          gatewayID: gatewayID,
          conversationID: conversationID
        )
        return DraftWriteResult.saved
      } catch is CancellationError {
        return DraftWriteResult.cancelled
      } catch {
        return DraftWriteResult.failed
      }
    }
    draftWriteTask = write
    let result = await write.value
    if revision == draftWriteRevision {
      switch result {
      case .saved:
        draftStatus = .saved
      case .cancelled:
        draftStatus = .failed
      case .failed:
        draftStatus = .failed
        state.errorBanner = "Draft couldn't be saved."
      }
    }
    return result.didSave
  }

  @discardableResult
  private func refreshCanonical(
    preserveLiveProjection: Bool,
    allowSummaryOnlyFollowUp: Bool = true
  ) async -> RecoveryClassificationResult {
    canonicalRefreshRevision &+= 1
    let refreshRevision = canonicalRefreshRevision
    let conversationID = state.conversation.id
    let revisionFloor = state.conversation.revision
    let recoveryTurnID = pendingSendReconciliation?.turnID
    if let recoveryTurnID {
      recoveryClassificationRevision = refreshRevision
      recoveryClassificationTurnID = recoveryTurnID
    }
    do {
      let canonical = try await synchronizer.refresh(
        conversationID: state.conversation.id,
        before: nil
      )
      guard
        isShutdown == false,
        canonicalRefreshRevision == refreshRevision
      else {
        await finishRecoveryClassification(
          revision: refreshRevision,
          turnID: recoveryTurnID,
          result: .inconclusive
        )
        return .inconclusive
      }
      let canonicalDeletionIsAuthoritative = canonical.summary.status == .deleted
      let result: RecoveryClassificationResult
      if let pendingSendReconciliation {
        result = await resolvePendingSend(
          pendingSendReconciliation,
          from: canonical,
          deletionIsAuthoritative: canonicalDeletionIsAuthoritative,
          preserveLiveProjection: preserveLiveProjection
        )
      } else {
        applyCanonical(canonical, preserveLiveProjection: preserveLiveProjection)
        state.errorBanner = nil
        result = .conclusive
      }
      isAuthoritative = connection == .online && pendingSendReconciliation == nil
      await finishRecoveryClassification(
        revision: refreshRevision,
        turnID: recoveryTurnID,
        result: result
      )
      _ = await lifecycleChangeHandler([.canonical(canonical.summary)])
      if result == .summaryOnlyInconclusive,
        allowSummaryOnlyFollowUp,
        let recoveryTurnID,
        pendingSendReconciliation?.turnID == recoveryTurnID
      {
        summaryOnlyFollowUpTurnID = recoveryTurnID
        if let followUp = await performSummaryOnlyFollowUpIfNeeded(for: recoveryTurnID) {
          return followUp
        }
      }
      return result
    } catch is CancellationError {
      await finishRecoveryClassification(
        revision: refreshRevision,
        turnID: recoveryTurnID,
        result: .inconclusive
      )
      return .inconclusive
    } catch {
      guard
        isShutdown == false,
        canonicalRefreshRevision == refreshRevision
      else {
        await finishRecoveryClassification(
          revision: refreshRevision,
          turnID: recoveryTurnID,
          result: .inconclusive
        )
        return .inconclusive
      }
      isAuthoritative = false
      var result: RecoveryClassificationResult
      let conversationWasRemoved: Bool
      if case GatewayError.notFound = error {
        markConversationDeletedForRecovery()
        if pendingSendReconciliation != nil {
          await recoveryChanges.send(gatewayID: gatewayID)
        }
        result = .deleted
        conversationWasRemoved = true
      } else {
        result = .inconclusive
        conversationWasRemoved = false
      }
      await applyFailure(error)
      if result == .inconclusive,
        let pendingSendReconciliation
      {
        result = await classifyPendingAvailability(pendingSendReconciliation)
      }
      if statusPresentation == .recoveryRequired {
        state.errorBanner = nil
      }
      await finishRecoveryClassification(
        revision: refreshRevision,
        turnID: recoveryTurnID,
        result: result
      )
      if conversationWasRemoved {
        _ = await lifecycleChangeHandler([
          .removed(id: conversationID, revisionFloor: revisionFloor)
        ])
      }
      return result
    }
  }

  private func applyCanonical(
    _ canonical: ChatCanonicalSnapshot,
    preserveLiveProjection: Bool
  ) {
    let previousActiveTurnID = state.activeTurnID
    let isCaughtUp =
      canonical.hasCanonicalMessagePage == false || canonical.throughSeq >= state.lastAppliedSeq
    if canonical.hasCanonicalMessagePage {
      let mayReplaceMessages = !preserveLiveProjection || state.messages.isEmpty || isCaughtUp
      if mayReplaceMessages {
        _ = ChatReducer.reduce(
          state: &state,
          action: .cachedMessagesLoaded(canonical.messages, cursor: canonical.throughSeq)
        )
      }
      state.olderCursor = canonical.nextCursor
    }

    let canonicalIsCurrent =
      canonical.summary.revision >= state.conversation.revision
      && (canonical.summary.status == .deleted
        || !preserveLiveProjection || isCaughtUp || state.activeTurnID == nil)
    if canonicalIsCurrent {
      _ = ChatReducer.reduce(state: &state, action: .authoritativeSummary(canonical.summary))
      if let previousActiveTurnID, state.activeTurnID != previousActiveTurnID {
        localTurnIDs.remove(previousActiveTurnID)
        cancelRequestSent = false
        isCancelling = false
      }
    }
    reconcileSubmittedAnswers()
  }

  private func attachToCanonicalTurnIfNeeded() async {
    guard
      attachmentRequested,
      state.conversation.status == .running,
      let turnID = state.conversation.activeTurnId,
      connection == .online,
      isShutdown == false
    else { return }
    guard isConnected == false else { return }
    do {
      try await ensureConnected()
      let cursor = try await persistence.cursor(
        gatewayID: gatewayID,
        conversationID: state.conversation.id
      )
      try await transport.resume(
        turnID: turnID,
        agentID: state.conversation.agentId,
        conversationID: state.conversation.id,
        sinceSeq: cursor
      )
    } catch is CancellationError {
      return
    } catch {
      await applyFailure(error)
    }
  }

  /// Watches the conversation the user has open, connecting first if nothing
  /// else has (sub-agents design 7.6, ruling 1). Without this an idle open
  /// conversation never hears the server-initiated turn that carries a
  /// background sub-agent's result — the whole point of the subscription.
  private func subscribeToOpenConversation() async {
    guard isShutdown == false, isVisible, connection == .online else { return }
    do {
      try await ensureConnected()
      guard isSubscribed == false, isShutdown == false else { return }
      try await transport.subscribe(
        agentID: state.conversation.agentId,
        conversationID: state.conversation.id
      )
      isSubscribed = true
    } catch is CancellationError {
      return
    } catch {
      await applyFailure(error)
    }
  }

  private func ensureConnected() async throws {
    startEventTaskIfNeeded()
    guard isConnected == false else { return }
    try await transport.connect()
    // A fresh connect replaces the socket, and `ChatConnection.connect()`
    // clears its subscriptions with it — so nothing is watched until
    // `subscribeToOpenConversation` says so again.
    isSubscribed = false
    // Same reason, for the expanded sub-agent rows (design 8.3): the gateway
    // is no longer watching those children, so the set must not claim it is.
    // A row already open re-subscribes on its next expansion; until then it
    // keeps the transcript the REST read gave it.
    subscribedSubagentIDs.removeAll()
    isConnected = true
    _ = ChatReducer.reduce(state: &state, action: .transportChanged(.connected))
  }

  private func suspendForDetachment() async {
    guard isConnected || state.transport != .detached else { return }
    // Drop the conversation subscription on the way out, so a long session
    // that visits many conversations never accumulates them (ruling 1).
    if isSubscribed {
      isSubscribed = false
      try? await transport.unsubscribe(
        agentID: state.conversation.agentId,
        conversationID: state.conversation.id
      )
    }
    await transport.suspendForDetachment()
    isConnected = false
    wasReconnecting = false
    _ = ChatReducer.reduce(state: &state, action: .transportChanged(.detached))
  }

  private func startEventTaskIfNeeded() {
    guard eventTask == nil, isShutdown == false else { return }
    eventTaskGeneration &+= 1
    let generation = eventTaskGeneration
    eventTask = Task { [weak self] in
      guard let self else { return }
      let events = await transport.events()
      do {
        for try await event in events {
          guard Task.isCancelled == false else { return }
          await consume(event)
        }
      } catch is CancellationError {
        finishEventTask(generation: generation)
        return
      } catch {
        await transport.resetAfterTerminalFailure()
        finishEventTask(generation: generation)
        guard isShutdown == false else { return }
        isConnected = false
        isSubscribed = false
        subscribedSubagentIDs.removeAll()
        wasReconnecting = false
        if let pendingSendReconciliation {
          await reconcileAmbiguousSend(pendingSendReconciliation)
        }
        await applyFailure(error)
      }
    }
  }

  private func finishEventTask(generation: UInt64) {
    guard eventTaskGeneration == generation else { return }
    eventTask = nil
  }

  private func consume(_ event: ChatConnectionEvent) async {
    guard isShutdown == false else { return }
    switch event {
    case .state(let transportState):
      let reconnectCompleted = wasReconnecting && transportState == .connected
      wasReconnecting = if case .reconnecting = transportState { true } else { false }
      isConnected = transportState == .connected
      // Mirror the transport truthfully rather than guessing from
      // "not connected": `ChatConnection` REPLAYS its conversation
      // subscriptions across a transient reconnect (`.reconnecting` →
      // `.connected`), and only drops them where it calls `clearAllTurns` —
      // `suspend()` (`.idle`) and `detach()` (`.detached`). A stale `false`
      // here would make the next `subscribeToOpenConversation` send a
      // duplicate frame for a conversation the gateway is already watching.
      switch transportState {
      case .idle, .detached:
        isSubscribed = false
        subscribedSubagentIDs.removeAll()
      case .connecting, .connected, .reconnecting: break
      }
      _ = ChatReducer.reduce(state: &state, action: .transportChanged(transportState))
      if reconnectCompleted {
        await replayAndResumeActiveTurn()
      }

    case .frame(let frame):
      // BEFORE the recovery deferral below, deliberately: the deferral is
      // about classifying a LOCAL send and returns early, and a list read has
      // nothing to do with that decision. Placed here it cannot be swallowed
      // by a path that was designed for something else, and the worst case is
      // one extra GET.
      if frame.refreshesSubagentList, isParentFrame(frame) {
        triggerSubagentRefresh()
      }
      if shouldDeferForRecoveryClassification(frame) {
        deferredRecoveryFrames.append(frame)
        if frame.isAcceptedForFeature {
          _ = await performSummaryOnlyFollowUpIfNeeded(for: frame.turnIDForFeature)
        }
        return
      }
      if state.conversation.status == .deleted,
        let pendingSendReconciliation,
        pendingSendReconciliation.turnID == frame.turnIDForFeature,
        frame.isAdmissionOrTerminal
      {
        return
      }
      await consumeFrame(frame)
    }
  }

  private func consumeFrame(_ frame: MobileWSServerFrame) async {
    let wasCoveredByCanonicalState = frame.sequenceForFeature.map {
      $0 <= state.lastAppliedSeq
    } ?? false
    if frame.isAcceptedForFeature,
      let pendingSendReconciliation,
      pendingSendReconciliation.turnID == frame.turnIDForFeature
    {
      guard await clearPendingSendDurably(pendingSendReconciliation) else { return }
    }
    if frame.isRejectionForFeature,
      let pendingSendReconciliation,
      pendingSendReconciliation.turnID == frame.turnIDForFeature
    {
      let rejectedPending = pendingSendReconciliation
      let classification = await refreshCanonical(preserveLiveProjection: true)
      switch classification {
      case .admitted:
        if state.conversation.status == .running,
          state.activeTurnID == rejectedPending.turnID
        {
          return
        }

      case .notAdmitted:
        await applyReducerAction(.frame(frame))
        if self.pendingSendReconciliation?.turnID == rejectedPending.turnID,
          state.conversation.status != .deleted,
          let resolution = await persistPendingSendAsDraft(rejectedPending)
        {
          await applyPendingSendDraftResolution(resolution, pending: rejectedPending)
          isAuthoritative = connection == .online && state.conversation.status != .deleted
          if case .restored = resolution {
            state.errorBanner = frame.rejectionMessageForFeature
          }
        }

      case .deleted:
        return

      case .conclusive, .inconclusive, .summaryOnlyInconclusive:
        await applyReducerAction(.frame(frame))
      }
      await finishTerminalFrame(frame)
      return
    }

    await applyReducerAction(.frame(frame))
    if frame.isAdmissionOrTerminal, wasCoveredByCanonicalState == false {
      await refreshCanonical(preserveLiveProjection: true)
    }
    await finishTerminalFrame(frame)
  }

  private func finishTerminalFrame(_ frame: MobileWSServerFrame) async {
    if frame.isTerminalForFeature {
      if pendingSendReconciliation?.turnID != frame.turnIDForFeature {
        localTurnIDs.remove(frame.turnIDForFeature)
        cancelRequestSent = false
        isCancelling = false
      }
      if isVisible == false, state.activeTurnID == nil {
        await suspendForDetachment()
      }
    }
  }

  /// A frame about THIS conversation rather than about a child of it.
  ///
  /// A child's frames reach this socket because the client subscribed to the
  /// child (design 7.6), and none of them says anything about which children
  /// the PARENT has. A missing `conversationId` is the parent's by convention
  /// — an older gateway omits it — which is the same rule
  /// `ChatReducer.frameBelongsToConversation` applies.
  private func isParentFrame(_ frame: MobileWSServerFrame) -> Bool {
    guard let conversationID = frame.conversationIDForFeature else { return true }
    return conversationID == state.conversation.id
  }

  private func shouldDeferForRecoveryClassification(_ frame: MobileWSServerFrame) -> Bool {
    let turnID = frame.turnIDForFeature
    return transportSendInFlightTurnID == turnID
      || recoveryResolutionHoldTurnID == turnID
      || deferredReplayTurnID == turnID
      || (recoveryClassificationRevision == canonicalRefreshRevision
        && recoveryClassificationTurnID == turnID)
  }

  private func performSummaryOnlyFollowUpIfNeeded(
    for turnID: String
  ) async -> RecoveryClassificationResult? {
    guard
      summaryOnlyFollowUpTurnID == turnID,
      pendingSendReconciliation?.turnID == turnID,
      deferredRecoveryFrames.contains(where: {
        $0.turnIDForFeature == turnID && $0.isAcceptedForFeature
      })
    else { return nil }
    summaryOnlyFollowUpTurnID = nil
    return await refreshCanonical(
      preserveLiveProjection: true,
      allowSummaryOnlyFollowUp: false
    )
  }

  private func finishRecoveryClassification(
    revision: UInt64,
    turnID: String?,
    result: RecoveryClassificationResult
  ) async {
    guard
      let turnID,
      recoveryClassificationRevision == revision,
      recoveryClassificationTurnID == turnID
    else { return }

    recoveryClassificationRevision = nil
    recoveryClassificationTurnID = nil
    guard isShutdown == false else { return }
    switch result {
    case .conclusive, .admitted, .notAdmitted:
      if summaryOnlyFollowUpTurnID == turnID {
        summaryOnlyFollowUpTurnID = nil
      }
      if recoveryResolutionHoldTurnID == turnID {
        recoveryResolutionHoldTurnID = nil
      }
      guard transportSendInFlightTurnID != turnID else { return }
      await replayDeferredRecoveryFrames(for: turnID)

    case .deleted:
      if summaryOnlyFollowUpTurnID == turnID {
        summaryOnlyFollowUpTurnID = nil
      }
      if recoveryResolutionHoldTurnID == turnID {
        recoveryResolutionHoldTurnID = nil
      }
      deferredRecoveryFrames.removeAll { $0.turnIDForFeature == turnID }

    case .inconclusive, .summaryOnlyInconclusive:
      guard pendingSendReconciliation?.turnID == turnID else {
        if recoveryResolutionHoldTurnID == turnID {
          recoveryResolutionHoldTurnID = nil
        }
        guard transportSendInFlightTurnID != turnID else { return }
        await replayDeferredRecoveryFrames(for: turnID)
        return
      }
      recoveryResolutionHoldTurnID = turnID
    }
  }

  private func finishTransportSendBarrier(
    turnID: String,
    classifyDeferredFrames: Bool,
    replayDeferredFrames: Bool
  ) async {
    guard transportSendInFlightTurnID == turnID else { return }
    if classifyDeferredFrames,
      pendingSendReconciliation?.turnID == turnID,
      deferredRecoveryFrames.contains(where: { $0.turnIDForFeature == turnID })
    {
      await refreshCanonical(preserveLiveProjection: true)
    }
    guard transportSendInFlightTurnID == turnID else { return }
    transportSendInFlightTurnID = nil
    guard replayDeferredFrames else {
      if recoveryResolutionHoldTurnID == turnID {
        recoveryResolutionHoldTurnID = nil
      }
      deferredRecoveryFrames.removeAll { $0.turnIDForFeature == turnID }
      return
    }
    await replayDeferredRecoveryFrames(for: turnID)
  }

  private func replayDeferredRecoveryFrames(for turnID: String) async {
    guard
      recoveryResolutionHoldTurnID != turnID,
      deferredReplayTurnID != turnID
    else { return }
    deferredReplayTurnID = turnID
    defer {
      if deferredReplayTurnID == turnID {
        deferredReplayTurnID = nil
      }
    }

    while isShutdown == false {
      guard recoveryResolutionHoldTurnID != turnID else { return }
      if state.conversation.status == .deleted,
        pendingSendReconciliation?.turnID == turnID
      {
        return
      }
      guard let index = deferredRecoveryFrames.firstIndex(where: {
        $0.turnIDForFeature == turnID
      }) else { return }
      let frame = deferredRecoveryFrames.remove(at: index)
      if state.conversation.status == .deleted,
        pendingSendReconciliation?.turnID == turnID,
        frame.isAdmissionOrTerminal
      {
        return
      }
      await consumeFrame(frame)
    }
  }

  private func replayAndResumeActiveTurn() async {
    guard let turnID = state.activeTurnID else { return }
    do {
      let entries = try await synchronizer.replay(
        agentID: state.conversation.agentId,
        conversationID: state.conversation.id,
        sinceSeq: state.lastAppliedSeq
      )
      guard await applyReducerAction(.replayLoaded(entries)), state.activeTurnID == turnID else {
        return
      }
      try await transport.resume(
        turnID: turnID,
        agentID: state.conversation.agentId,
        conversationID: state.conversation.id,
        sinceSeq: state.lastAppliedSeq
      )
    } catch is CancellationError {
      return
    } catch {
      await applyFailure(error)
    }
  }

  @discardableResult
  private func applyReducerAction(_ action: ChatAction) async -> Bool {
    let previous = state
    var next = state
    var effects = ChatReducer.reduce(state: &next, action: action)
    var lifecycleChanges: [ConversationLifecycleChange] = []
    do {
      while effects.isEmpty == false {
        let effect = effects.removeFirst()
        switch effect {
        case .persistCursor(let seq):
          try await persistence.advanceCursor(
            gatewayID: gatewayID,
            conversationID: next.conversation.id,
            to: seq
          )

        case .requestReplay(let sinceSeq):
          let entries = try await synchronizer.replay(
            agentID: next.conversation.agentId,
            conversationID: next.conversation.id,
            sinceSeq: sinceSeq
          )
          effects.append(
            contentsOf: ChatReducer.reduce(state: &next, action: .replayLoaded(entries))
          )

        case .refreshTranscript:
          let canonical = try await synchronizer.refresh(
            conversationID: next.conversation.id,
            before: nil
          )
          if canonical.hasCanonicalMessagePage {
            effects.append(
              contentsOf: ChatReducer.reduce(
                state: &next,
                action: .cachedMessagesLoaded(
                  canonical.messages,
                  cursor: canonical.throughSeq
                )
              )
            )
            next.olderCursor = canonical.nextCursor
          }
          _ = ChatReducer.reduce(state: &next, action: .authoritativeSummary(canonical.summary))
          lifecycleChanges.append(.canonical(canonical.summary))

        case .announceFinalResponse:
          if await announcer.isVoiceOverRunning() {
            await announcer.announce("Response complete")
          }

        case .showRepair:
          break

        case .showRetryCountdown(let retryAt):
          self.retryAt = retryAt
        }
      }
      state = preservingComposer(in: next, from: state)
      reconcileSubmittedAnswers()
      if lifecycleChanges.isEmpty == false {
        _ = await lifecycleChangeHandler(lifecycleChanges)
      }
      return true
    } catch is CancellationError {
      state = preservingComposer(in: previous, from: state)
      return false
    } catch GatewayError.notFound {
      state = preservingComposer(in: previous, from: state)
      markConversationDeletedForRecovery()
      if pendingSendReconciliation != nil {
        await recoveryChanges.send(gatewayID: gatewayID)
      }
      await applyFailure(GatewayError.notFound)
      _ = await lifecycleChangeHandler([
        .removed(
          id: previous.conversation.id,
          revisionFloor: previous.conversation.revision
        )
      ])
      return false
    } catch {
      state = preservingComposer(in: previous, from: state)
      await applyFailure(error)
      return false
    }
  }

  private func applyFailure(_ error: Error) async {
    guard let gatewayError = error as? GatewayError else {
      state.errorBanner = "Saved conversation data couldn't be updated."
      return
    }
    await applyReducerActionWithoutRecursion(.failure(gatewayError))
    switch gatewayError {
    case .unauthorized:
      connection = .repairRequired
      isAuthoritative = false
    case .rateLimited(let duration):
      let now = await clock.now()
      let delay = duration ?? .seconds(1)
      let components = delay.components
      let seconds =
        TimeInterval(components.seconds)
        + TimeInterval(components.attoseconds) / 1e18
      let retryAt = now.addingTimeInterval(max(0, seconds))
      connection = .rateLimited(retryAt: retryAt)
      self.retryAt = retryAt
      isAuthoritative = false
    case .gatewayOffline:
      connection = .gatewayOffline
      isAuthoritative = false
    case .updateRequired, .capabilityRequired:
      connection = .updateRequired
      isAuthoritative = false
    case .transport:
      connection = .offline
      isAuthoritative = false
    case .notFound, .validation, .revisionConflict, .conversationBusy,
      .mutationOutcomeUnknown, .server:
      break
    }
    await gatewayErrorHandler?(gatewayError)
  }

  private func applyReducerActionWithoutRecursion(_ action: ChatAction) async {
    var next = state
    let effects = ChatReducer.reduce(state: &next, action: action)
    state = next
    for effect in effects {
      switch effect {
      case .announceFinalResponse:
        if await announcer.isVoiceOverRunning() {
          await announcer.announce("Response complete")
        }
      case .showRetryCountdown(let retryAt):
        self.retryAt = retryAt
      case .persistCursor, .requestReplay, .refreshTranscript, .showRepair:
        break
      }
    }
  }

  private func turnID(forQuestion questionID: String) -> String? {
    state.messages.first { message in
      message.assistant?.pendingQuestion?.id == questionID
        && message.assistant?.pendingQuestion?.answer == nil
    }?.turnID
  }

  private func reconcileSubmittedAnswers() {
    var pendingQuestionIDs: Set<String> = []
    for index in state.messages.indices {
      guard var assistant = state.messages[index].assistant,
        var question = assistant.pendingQuestion
      else { continue }
      pendingQuestionIDs.insert(question.id)
      guard let answer = submittedAnswers[question.id] else { continue }
      question.answer = answer
      assistant.pendingQuestion = question
      state.messages[index].assistant = assistant
    }
    submittedAnswers = submittedAnswers.filter { pendingQuestionIDs.contains($0.key) }
  }

  private var sendAuthorityIsAvailable: Bool {
    isShutdown == false
      && connection == .online
      && isAuthoritative
      && pendingSendReconciliation == nil
      && pendingSendRecovery == nil
      && state.activeTurnID == nil
      && state.composerBlock == nil
      && isConversationReadOnly == false
  }

  private var turnMutationAuthorityIsAvailable: Bool {
    isShutdown == false
      && connection == .online
      && isAuthoritative
      && pendingSendReconciliation == nil
      && pendingSendRecovery == nil
      && state.activeTurnID != nil
      && state.composerBlock == nil
      && isConversationReadOnly == false
  }

  private var composerMutationAllowed: Bool {
    isShutdown == false
      && isSending == false
      && pendingSendReconciliation == nil
      && pendingSendRecovery == nil
      && state.composerBlock == nil
      && isConversationReadOnly == false
  }

  private func stagedSendAuthorityIsAvailable(turnID: String) -> Bool {
    isShutdown == false
      && connection == .online
      && isAuthoritative
      && pendingSendReconciliation?.turnID == turnID
      && pendingSendRecovery == nil
      && state.activeTurnID == nil
      && state.composerBlock == nil
      && isConversationReadOnly == false
  }

  private func stagePendingSend(_ pending: PendingChatSend) async -> Bool {
    draftWriteRevision &+= 1
    let previousWrite = draftWriteTask
    draftStatus = .saving
    _ = await previousWrite?.value
    draftWriteTask = nil
    do {
      switch
        try await persistence.stagePendingSend(
          pending,
          gatewayID: gatewayID,
          conversationID: state.conversation.id
        )
      {
      case .staged:
        draftStatus = .saved
        return true
      case .pendingAlreadyExists:
        draftStatus = .saved
        await reconcilePendingSendStageCollision()
        return false
      }
    } catch is CancellationError {
      draftStatus = .failed
      state.errorBanner = "Draft couldn't be saved."
      return false
    } catch {
      draftStatus = .failed
      state.errorBanner = "Draft couldn't be saved."
      return false
    }
  }

  private func reconcilePendingSendStageCollision() async {
    do {
      let result = try await persistence.pendingSend(
        gatewayID: gatewayID,
        conversationID: state.conversation.id
      )
      guard isShutdown == false else { return }
      switch result {
      case .none:
        state.errorBanner = "A saved message changed while sending. Try again."
      case .resumable(let existing):
        pendingSendRecovery = nil
        pendingSendReconciliation = existing
        localTurnIDs.insert(existing.turnID)
        state.errorBanner = "Confirming whether your earlier message was sent."
      case .recoveryRequired(let recovery):
        installPendingSendRecovery(recovery, clearComposer: false)
        state.errorBanner = nil
        await recoveryChanges.send(gatewayID: gatewayID)
      }
    } catch is CancellationError {
      return
    } catch {
      guard isShutdown == false else { return }
      state.errorBanner = "A saved message changed while sending. Try again."
    }
  }

  @discardableResult
  private func clearPendingSendDurably(_ pending: PendingChatSend) async -> Bool {
    guard pendingSendReconciliation?.turnID == pending.turnID else { return true }
    do {
      switch
        try await persistence.clearPendingSend(
          gatewayID: gatewayID,
          conversationID: state.conversation.id,
          turnID: pending.turnID
        )
      {
      case .cleared:
        pendingSendReconciliation = nil
        if summaryOnlyFollowUpTurnID == pending.turnID {
          summaryOnlyFollowUpTurnID = nil
        }
        return true
      case .conversationUnavailable:
        markConversationDeletedForRecovery()
        state.errorBanner = nil
        await recoveryChanges.send(gatewayID: gatewayID)
        await publishConversationRemoval()
        return false
      }
    } catch is CancellationError {
      state.errorBanner = "The message was accepted, but its local state couldn't be saved."
      return false
    } catch {
      state.errorBanner = "The message was accepted, but its local state couldn't be saved."
      return false
    }
  }

  private func classifyPendingAvailability(
    _ pending: PendingChatSend
  ) async -> RecoveryClassificationResult {
    guard pendingSendReconciliation?.turnID == pending.turnID else { return .conclusive }
    do {
      switch
        try await persistence.pendingSendAvailability(
          gatewayID: gatewayID,
          conversationID: state.conversation.id,
          turnID: pending.turnID
        )
      {
      case .active, .pendingMissing:
        return .inconclusive
      case .conversationUnavailable:
        markConversationDeletedForRecovery()
        state.errorBanner = nil
        await recoveryChanges.send(gatewayID: gatewayID)
        await publishConversationRemoval()
        return .deleted
      }
    } catch {
      return .inconclusive
    }
  }

  @discardableResult
  private func restorePendingSendAsDraft(
    _ pending: PendingChatSend
  ) async -> PendingSendDraftResolution? {
    guard let resolution = await persistPendingSendAsDraft(pending) else { return nil }
    await applyPendingSendDraftResolution(resolution, pending: pending)
    return resolution
  }

  private func persistPendingSendAsDraft(
    _ pending: PendingChatSend
  ) async -> PendingSendDraftResolution? {
    guard pendingSendReconciliation?.turnID == pending.turnID else { return nil }
    do {
      switch
        try await persistence.restorePendingSendAsDraft(
          gatewayID: gatewayID,
          conversationID: state.conversation.id,
          turnID: pending.turnID
        )
      {
      case .restored(let restored):
        guard let restored else {
          state.errorBanner =
            "The pending message couldn't be restored. Retry to check the conversation."
          return nil
        }
        return .restored(restored)
      case .draftConflict(let draft):
        return .draftConflict(draft)
      case .conversationUnavailable:
        markConversationDeletedForRecovery()
        state.errorBanner = nil
        await recoveryChanges.send(gatewayID: gatewayID)
        await publishConversationRemoval()
        return nil
      }
    } catch is CancellationError {
      draftStatus = .failed
      state.errorBanner =
        "The pending message couldn't be restored. Retry to check the conversation."
      return nil
    } catch {
      draftStatus = .failed
      state.errorBanner =
        "The pending message couldn't be restored. Retry to check the conversation."
      return nil
    }
  }

  private func applyPendingSendDraftResolution(
    _ resolution: PendingSendDraftResolution,
    pending: PendingChatSend
  ) async {
    switch resolution {
    case .restored(let draft):
      applyRestoredPendingSend(pending, draft: draft)
    case .draftConflict(let draft):
      await applyPendingSendDraftConflict(pending, draft: draft)
    }
  }

  private func applyPendingSendDraftConflict(
    _ pending: PendingChatSend,
    draft: ConversationDraft
  ) async {
    guard pendingSendReconciliation?.turnID == pending.turnID else { return }
    _ = ChatReducer.reduce(state: &state, action: .sendRejected(turnID: pending.turnID))
    installPendingSendRecovery(
      RecoverablePendingSend(
        gatewayID: gatewayID,
        conversationID: state.conversation.id,
        conversationTitle: state.conversation.title,
        agentName: nil,
        pendingSend: pending,
        coexistingDraft: draft,
        conversationAvailable: true
      ),
      clearComposer: false
    )
    state.draft = draft.text
    state.attachments = draft.attachments
    draftStatus = .saved
    state.errorBanner = nil
    await recoveryChanges.send(gatewayID: gatewayID)
  }

  private func applyRestoredPendingSend(
    _ pending: PendingChatSend,
    draft restored: ConversationDraft
  ) {
    guard pendingSendReconciliation?.turnID == pending.turnID else {
      if pendingSendReconciliation == nil {
        state.errorBanner =
          "The pending message couldn't be restored. Retry to check the conversation."
      }
      return
    }
    pendingSendReconciliation = nil
    if summaryOnlyFollowUpTurnID == pending.turnID {
      summaryOnlyFollowUpTurnID = nil
    }
    localTurnIDs.remove(pending.turnID)
    _ = ChatReducer.reduce(state: &state, action: .sendRejected(turnID: pending.turnID))
    state.draft = restored.text
    state.attachments = restored.attachments
    draftStatus = .saved
  }

  private func sendFailureIsAmbiguous(_ error: Error) -> Bool {
    if error is URLError { return true }
    guard let gatewayError = error as? GatewayError else { return true }
    switch gatewayError {
    case .transport, .mutationOutcomeUnknown:
      return true
    case .unauthorized, .rateLimited, .gatewayOffline, .notFound, .validation,
      .revisionConflict, .conversationBusy, .capabilityRequired, .updateRequired, .server:
      return false
    }
  }

  private func reconcileAmbiguousSend(_ pending: PendingChatSend) async {
    guard pendingSendReconciliation?.turnID == pending.turnID else { return }
    isConnected = false
    isAuthoritative = false
    if state.conversation.status == .deleted {
      state.errorBanner = nil
      return
    }
    await refreshCanonical(preserveLiveProjection: true)
  }

  private func retryPendingSend(_ pending: PendingChatSend) async {
    guard
      isShutdown == false,
      connection == .online,
      pendingSendReconciliation?.turnID == pending.turnID,
      isSending == false,
      state.conversation.activeTurnId == nil,
      state.composerBlock == nil,
      isConversationReadOnly == false
    else { return }

    let text = pending.draft.trimmingCharacters(in: .whitespacesAndNewlines)
    let images: [MessageImage]
    do {
      let validated = try validator.prepare([], appendingTo: pending.attachments)
      images = try validated.map { try $0.messageImage() }
    } catch {
      state.errorBanner = error.localizedDescription
      return
    }

    isSending = true
    defer { finishSendOperation() }
    do {
      try await ensureConnected()
      guard
        isShutdown == false,
        connection == .online,
        pendingSendReconciliation?.turnID == pending.turnID,
        state.conversation.activeTurnId == nil,
        state.composerBlock == nil,
        isConversationReadOnly == false
      else { return }
      localTurnIDs.insert(pending.turnID)
      _ = ChatReducer.reduce(
        state: &state,
        action: .sendStarted(
          turnID: pending.turnID,
          localUserID: pending.localUserID,
          text: text,
          images: images
        )
      )
      transportSendInFlightTurnID = pending.turnID
      try await transport.sendTurn(
        id: pending.turnID,
        agentID: state.conversation.agentId,
        conversationID: state.conversation.id,
        text: text,
        images: images
      )
      await finishTransportSendBarrier(
        turnID: pending.turnID,
        classifyDeferredFrames: true,
        replayDeferredFrames: true
      )
    } catch is CancellationError {
      await reconcileAmbiguousSend(pending)
      await finishTransportSendBarrier(
        turnID: pending.turnID,
        classifyDeferredFrames: false,
        replayDeferredFrames: true
      )
    } catch {
      if sendFailureIsAmbiguous(error) {
        await reconcileAmbiguousSend(pending)
        await finishTransportSendBarrier(
          turnID: pending.turnID,
          classifyDeferredFrames: false,
          replayDeferredFrames: true
        )
      } else {
        await rejectSend(pending, error: error)
        await finishTransportSendBarrier(
          turnID: pending.turnID,
          classifyDeferredFrames: false,
          replayDeferredFrames: false
        )
      }
    }
  }

  private func resolvePendingSend(
    _ pending: PendingChatSend,
    from canonical: ChatCanonicalSnapshot,
    deletionIsAuthoritative: Bool,
    preserveLiveProjection: Bool
  ) async -> RecoveryClassificationResult {
    guard pendingSendReconciliation?.turnID == pending.turnID else { return .conclusive }
    let minimumSummaryRevision = state.conversation.revision
    let minimumThroughSeq = state.lastAppliedSeq
    if deletionIsAuthoritative {
      let pendingProjection = state.messages.filter { $0.turnID == pending.turnID }
      applyCanonical(canonical, preserveLiveProjection: preserveLiveProjection)
      restoreMissingProjection(pendingProjection, for: pending.turnID)
      markConversationDeletedForRecovery()
      state.errorBanner = nil
      await recoveryChanges.send(gatewayID: gatewayID)
      return .deleted
    }
    let sameTurn = canonical.messages.filter { $0.turnId == pending.turnID }
    let wasAdmitted = canonical.summary.activeTurnId == pending.turnID || sameTurn.isEmpty == false
    if wasAdmitted {
      let pendingProjection = state.messages.filter { $0.turnID == pending.turnID }
      applyCanonical(canonical, preserveLiveProjection: preserveLiveProjection)
      restoreMissingProjection(pendingProjection, for: pending.turnID)
      guard await clearPendingSendDurably(pending) else { return .admitted }
      state.errorBanner = nil
      guard
        canonical.summary.status == .running,
        canonical.summary.activeTurnId == pending.turnID
      else {
        localTurnIDs.remove(pending.turnID)
        cancelRequestSent = false
        isCancelling = false
        return .admitted
      }
      do {
        try await ensureConnected()
        try await transport.resume(
          turnID: pending.turnID,
          agentID: canonical.summary.agentId,
          conversationID: canonical.summary.id,
          sinceSeq: state.lastAppliedSeq
        )
      } catch is CancellationError {
        return .admitted
      } catch {
        await applyFailure(error)
      }
      return .admitted
    }

    let absenceIsConclusive =
      canonical.hasCanonicalMessagePage
      && canonical.summary.revision >= minimumSummaryRevision
      && canonical.throughSeq >= minimumThroughSeq
      && canonical.throughSeq >= canonical.summary.lastSeq
    let pendingProjection = state.messages.filter { $0.turnID == pending.turnID }
    applyCanonical(canonical, preserveLiveProjection: preserveLiveProjection)
    restoreMissingProjection(pendingProjection, for: pending.turnID)
    if isConversationReadOnly == false, canonical.summary.activeTurnId == nil {
      state.activeTurnID = pending.turnID
    }
    isAuthoritative = false
    state.errorBanner = "The message outcome is unknown. Retry to send it again."
    if canonical.hasCanonicalMessagePage == false {
      return .summaryOnlyInconclusive
    }
    return absenceIsConclusive ? .notAdmitted : .inconclusive
  }

  private func rejectSend(_ pending: PendingChatSend, error: Error) async {
    let resolution = await persistPendingSendAsDraft(pending)
    await applyFailure(error)
    if let resolution {
      await applyPendingSendDraftResolution(resolution, pending: pending)
    }
  }

  private func restoreMissingProjection(_ projection: [ChatMessageState], for turnID: String) {
    for message in projection
    where state.messages.contains(where: { value in
      value.turnID == turnID && value.role == message.role
    }) == false {
      if message.role == .user,
        let assistant = state.messages.firstIndex(where: {
          $0.turnID == turnID && $0.role == .assistant
        })
      {
        state.messages.insert(message, at: assistant)
      } else {
        state.messages.append(message)
      }
    }
  }

  private func finishSendOperation() {
    isSending = false
    let waiters = sendCompletionWaiters
    sendCompletionWaiters.removeAll()
    for waiter in waiters {
      waiter.resume()
    }
  }

  private func waitForSendCompletion() async {
    guard isSending else { return }
    await withCheckedContinuation { continuation in
      sendCompletionWaiters.append(continuation)
    }
  }

  private var isConversationReadOnly: Bool {
    state.conversation.status == .archived || state.conversation.status == .deleted
  }

  private func markConversationDeletedForRecovery() {
    let current = state.conversation
    let deleted = ConversationSummaryDTO(
      id: current.id,
      agentId: current.agentId,
      agentName: current.agentName,
      title: current.title,
      revision: current.revision,
      status: .deleted,
      activeTurnId: nil,
      owningIssueId: current.owningIssueId,
      projectId: current.projectId,
      lastSeq: current.lastSeq,
      lastMessagePreview: current.lastMessagePreview,
      createdAt: current.createdAt,
      updatedAt: current.updatedAt,
      deletedAt: current.deletedAt ?? current.updatedAt
    )
    _ = ChatReducer.reduce(state: &state, action: .authoritativeSummary(deleted))
    isAuthoritative = false
  }

  private func publishConversationRemoval() async {
    _ = await lifecycleChangeHandler([
      .removed(
        id: state.conversation.id,
        revisionFloor: state.conversation.revision
      )
    ])
  }

  func prepareForRemoteRemoval() {
    guard isShutdown == false else { return }
    markConversationDeletedForRecovery()
    state.errorBanner = nil
    prepareForShutdown()
  }

  func retireAfterRemoteRemoval() async {
    prepareForRemoteRemoval()
    if pendingSendReconciliation != nil {
      await recoveryChanges.send(gatewayID: gatewayID)
    }
    await shutdown()
  }

  private func preservingComposer(in value: ChatState, from current: ChatState) -> ChatState {
    var preserved = value
    preserved.draft = current.draft
    preserved.attachments = current.attachments
    return preserved
  }

  private func rejectIfShutdown() -> Bool {
    guard isShutdown else { return false }
    state.errorBanner = "Chat session is closed"
    return true
  }

  private func beginAttachmentIntent(attached: Bool) -> UInt64 {
    attachmentIntentRevision &+= 1
    attachmentRequested = attached
    return attachmentIntentRevision
  }

  private func isCurrentAttachmentIntent(_ revision: UInt64, attached: Bool) -> Bool {
    attachmentIntentRevision == revision && attachmentRequested == attached && isShutdown == false
  }
}

extension MobileWSServerFrame {
  fileprivate var conversationIDForFeature: String? {
    switch self {
    case let .accepted(_, conversationID, _, _, _, _, _, _, _): conversationID
    case let .event(_, conversationID, _, _): conversationID
    case let .done(_, conversationID, _, _): conversationID
    case let .error(_, conversationID, _, _, _, _, _): conversationID
    }
  }

  /// True for a frame that changes which of a conversation's children are
  /// live, or that reports one having changed (§8.4).
  ///
  /// Four triggers, each covering a case the others do not:
  ///
  /// 1. `subagent_started` / `subagent_finished` — a FOREGROUND child's row
  ///    moving while its spawning turn is still running. The legacy
  ///    `worker_spawned`/`worker_done` mirrors are deliberately excluded: the
  ///    gateway emits both families for the same child, so reading on them too
  ///    would double every read for no new information. `subagent_progress`
  ///    is excluded for a different reason — it is transient and never
  ///    persisted, so refreshing on it would be a round trip per tool call for
  ///    a row whose only live field ticks locally anyway.
  /// 2. `accepted` with `origin == .notification` — the ONLY thing that tells
  ///    a parent about a BACKGROUND child's finish. Nothing about that finish
  ///    reaches the parent's own event stream, and the gateway starts a
  ///    notification turn to wake the orchestrator with the result. Without
  ///    this the sheet would read `running` for the whole length of the turn
  ///    that child's own finish triggered. An ordinary user turn's `accepted`
  ///    says nothing about any child, and its `done` already reads.
  /// 3. `done` — the backstop for every trigger above going missing, and the
  ///    only way to see a child that was spawned DURING a turn on a client
  ///    that missed the start. One read per parent turn.
  fileprivate var refreshesSubagentList: Bool {
    switch self {
    case let .accepted(_, _, _, _, _, _, origin, _, _): origin == .notification
    case .done: true
    case let .event(_, _, _, event):
      switch event {
      case .subagentStarted, .subagentFinished: true
      default: false
      }
    case .error: false
    }
  }

  fileprivate var isAcceptedForFeature: Bool {
    if case .accepted = self { return true }
    return false
  }

  fileprivate var isRejectionForFeature: Bool {
    if case .error(_, _, seq: nil, _, _, _, _) = self { return true }
    return false
  }

  fileprivate var rejectionMessageForFeature: String? {
    if case .error(_, _, seq: nil, let error, _, _, _) = self { return error }
    return nil
  }

  fileprivate var isAdmissionOrTerminal: Bool {
    switch self {
    case .accepted, .done, .error: true
    case .event: false
    }
  }

  fileprivate var isTerminalForFeature: Bool {
    switch self {
    case .done, .error: true
    case .accepted, .event: false
    }
  }

  fileprivate var turnIDForFeature: String {
    switch self {
    case .accepted(let id, _, _, _, _, _, _, _, _),
      .event(let id, _, _, _),
      .done(let id, _, _, _),
      .error(let id, _, _, _, _, _, _):
      id
    }
  }

  fileprivate var sequenceForFeature: Int? {
    switch self {
    case .accepted(_, _, _, _, _, let seq, _, _, _):
      seq
    case .event(_, _, let seq, _),
      .done(_, _, let seq, _):
      seq
    case .error(_, _, let seq, _, _, _, _):
      seq
    }
  }
}
