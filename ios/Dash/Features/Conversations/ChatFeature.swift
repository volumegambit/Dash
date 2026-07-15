import Foundation
import Observation
import SwiftUI
import UIKit

struct ChatCanonicalSnapshot: Equatable, Sendable {
  let summary: ConversationSummaryDTO
  let messages: [ConversationMessageDTO]
  let nextCursor: String?
  let throughSeq: Int
}

protocol ChatFeaturePersisting: Actor {
  func messages(
    gatewayID: String,
    conversationID: String
  ) async throws -> [ConversationMessageDTO]
  func draft(gatewayID: String, conversationID: String) async throws -> ConversationDraft?
  func pendingSend(gatewayID: String, conversationID: String) async throws -> PendingChatSend?
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
  ) async throws
  func clearPendingSend(
    gatewayID: String,
    conversationID: String,
    turnID: String
  ) async throws
  func restorePendingSendAsDraft(
    gatewayID: String,
    conversationID: String,
    turnID: String
  ) async throws -> ConversationDraft?
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

  func pendingSend(gatewayID: String, conversationID: String) async throws -> PendingChatSend? {
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
  ) async throws {
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
  ) async throws {
    try await store.clearPendingSend(
      gatewayID: gatewayID,
      conversationID: conversationID,
      turnID: turnID
    )
  }

  func restorePendingSendAsDraft(
    gatewayID: String,
    conversationID: String,
    turnID: String
  ) async throws -> ConversationDraft? {
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
  func shutdown() async
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
    let summary = try await api.conversation(id: conversationID)
    try validate(lifecycle)
    guard summary.status != .deleted else {
      try await store.applyTombstone(summary, gatewayID: gatewayID)
      try validate(lifecycle)
      return ChatCanonicalSnapshot(
        summary: summary,
        messages: [],
        nextCursor: nil,
        throughSeq: summary.lastSeq
      )
    }

    let page = try await api.messages(
      conversationID: conversationID,
      limit: 50,
      before: before
    )
    try validate(lifecycle)
    try await store.upsertConversations([summary], gatewayID: gatewayID)
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
      summary: summary,
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
    let page = try await resolvedAPI().replay(
      agentID: agentID,
      conversationID: conversationID,
      sinceSeq: sinceSeq
    )
    try validate(lifecycle)
    return page.entries
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

  var canSend: Bool {
    guard
      sendAuthorityIsAvailable,
      pendingSendReconciliation == nil,
      isSending == false,
      state.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
        || state.attachments.isEmpty == false
    else { return false }
    return true
  }

  var draftEditingAllowed: Bool {
    isShutdown == false && isSending == false && pendingSendReconciliation == nil
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
  @ObservationIgnored private let makeID: @Sendable () -> String
  @ObservationIgnored private var eventTask: Task<Void, Never>?
  @ObservationIgnored private var eventTaskGeneration: UInt64 = 0
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
  @ObservationIgnored private var canonicalRefreshRevision: UInt64 = 0
  @ObservationIgnored private var gatewayErrorHandler: ChatGatewayErrorHandler?

  init(
    gatewayID: String,
    conversation: ConversationSummaryDTO,
    persistence: any ChatFeaturePersisting,
    synchronizer: any ChatFeatureSynchronizing,
    transport: any ChatFeatureTransporting,
    clock: any AppClock = SystemAppClock(),
    announcer: any ChatAccessibilityAnnouncing = SystemChatAccessibilityAnnouncer(),
    validator: ImageAttachmentValidator = ImageAttachmentValidator(),
    makeID: @escaping @Sendable () -> String = { UUID().uuidString.lowercased() }
  ) {
    self.gatewayID = gatewayID
    self.persistence = persistence
    self.synchronizer = synchronizer
    self.transport = transport
    self.clock = clock
    self.announcer = announcer
    self.validator = validator
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

  func setGatewayErrorHandler(_ handler: @escaping ChatGatewayErrorHandler) {
    gatewayErrorHandler = handler
  }

  func appear() async {
    guard rejectIfShutdown() == false else { return }
    let attachmentIntent = beginAttachmentIntent(attached: true)
    isVisible = true
    startEventTaskIfNeeded()
    if hasLoadedCache == false {
      isLoadingInitial = true
      await loadCache()
      hasLoadedCache = true
      isLoadingInitial = false
    }
    guard isCurrentAttachmentIntent(attachmentIntent, attached: true) else { return }
    guard connection == .online else { return }
    isAuthoritative = false
    await refreshCanonical(preserveLiveProjection: true)
    guard isCurrentAttachmentIntent(attachmentIntent, attached: true) else { return }
    await attachToCanonicalTurnIfNeeded()
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
    state.isLoadingOlder = true
    defer { state.isLoadingOlder = false }
    do {
      let canonical = try await synchronizer.refresh(
        conversationID: state.conversation.id,
        before: cursor
      )
      var next = state
      _ = ChatReducer.reduce(
        state: &next,
        action: .olderMessagesLoaded(canonical.messages, nextCursor: canonical.nextCursor)
      )
      if canonical.summary.revision >= next.conversation.revision {
        _ = ChatReducer.reduce(state: &next, action: .authoritativeSummary(canonical.summary))
      }
      state = next
      reconcileSubmittedAnswers()
      isAuthoritative = connection == .online
    } catch is CancellationError {
      return
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
      try await transport.sendTurn(
        id: turnID,
        agentID: state.conversation.agentId,
        conversationID: state.conversation.id,
        text: text,
        images: images
      )
    } catch is CancellationError {
      if localTurnIDs.contains(turnID) {
        await reconcileAmbiguousSend(pending)
      } else {
        await restorePendingSendAsDraft(pending)
      }
      return
    } catch {
      guard localTurnIDs.contains(turnID) else {
        await restorePendingSendAsDraft(pending)
        await applyFailure(error)
        return
      }
      if sendFailureIsAmbiguous(error) {
        await reconcileAmbiguousSend(pending)
      } else {
        await rejectSend(pending, error: error)
      }
    }
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
  }

  func shutdown() async {
    guard isShutdown == false else { return }
    isShutdown = true
    canonicalRefreshRevision &+= 1
    _ = beginAttachmentIntent(attached: false)
    isVisible = false
    let retiringEventTask = eventTask
    retiringEventTask?.cancel()
    eventTask = nil
    let retiringDraftWrite = draftWriteTask
    let transportShutdown = Task { [transport] in await transport.shutdown() }
    let synchronizerShutdown = Task { [synchronizer] in await synchronizer.shutdown() }
    await waitForSendCompletion()
    await transportShutdown.value
    await synchronizerShutdown.value
    await retiringEventTask?.value
    _ = await retiringDraftWrite?.value
    draftWriteTask = nil
    isConnected = false
    state.transport = .detached
  }

  private func loadCache() async {
    do {
      async let messages = persistence.messages(
        gatewayID: gatewayID,
        conversationID: state.conversation.id
      )
      async let draft = persistence.draft(
        gatewayID: gatewayID,
        conversationID: state.conversation.id
      )
      async let pendingSend = persistence.pendingSend(
        gatewayID: gatewayID,
        conversationID: state.conversation.id
      )
      async let cursor = persistence.cursor(
        gatewayID: gatewayID,
        conversationID: state.conversation.id
      )
      let (cachedMessages, cachedDraft, cachedPendingSend, cachedCursor) = try await (
        messages,
        draft,
        pendingSend,
        cursor
      )
      _ = ChatReducer.reduce(
        state: &state,
        action: .cachedMessagesLoaded(cachedMessages, cursor: cachedCursor)
      )
      if let cachedDraft {
        state.draft = cachedDraft.text
        state.attachments = cachedDraft.attachments
      }
      if let cachedPendingSend {
        pendingSendReconciliation = cachedPendingSend
        localTurnIDs.insert(cachedPendingSend.turnID)
        state.draft = ""
        state.attachments = []
        if cachedMessages.contains(where: { $0.turnId == cachedPendingSend.turnID }) {
          _ = await clearPendingSendDurably(cachedPendingSend)
        } else {
          do {
            let images = try cachedPendingSend.attachments.map { try $0.messageImage() }
            _ = ChatReducer.reduce(
              state: &state,
              action: .sendStarted(
                turnID: cachedPendingSend.turnID,
                localUserID: cachedPendingSend.localUserID,
                text: cachedPendingSend.draft.trimmingCharacters(in: .whitespacesAndNewlines),
                images: images
              )
            )
          } catch {
            state.errorBanner = "A pending message attachment couldn't be restored."
          }
        }
      }
    } catch is CancellationError {
      return
    } catch {
      state.errorBanner = "Saved conversation data couldn't be loaded."
    }
  }

  @discardableResult
  private func persistDraft() async -> Bool {
    guard pendingSendReconciliation == nil else { return true }
    return await persistDraft(text: state.draft, attachments: state.attachments)
  }

  private func persistDraft(text: String, attachments: [PreparedAttachment]) async -> Bool {
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

  private func refreshCanonical(preserveLiveProjection: Bool) async {
    canonicalRefreshRevision &+= 1
    let refreshRevision = canonicalRefreshRevision
    do {
      let canonical = try await synchronizer.refresh(
        conversationID: state.conversation.id,
        before: nil
      )
      guard
        isShutdown == false,
        canonicalRefreshRevision == refreshRevision
      else { return }
      if let pendingSendReconciliation {
        await resolvePendingSend(
          pendingSendReconciliation,
          from: canonical,
          preserveLiveProjection: preserveLiveProjection
        )
      } else {
        applyCanonical(canonical, preserveLiveProjection: preserveLiveProjection)
        state.errorBanner = nil
      }
      isAuthoritative = connection == .online && pendingSendReconciliation == nil
    } catch is CancellationError {
      return
    } catch {
      guard
        isShutdown == false,
        canonicalRefreshRevision == refreshRevision
      else { return }
      isAuthoritative = false
      await applyFailure(error)
    }
  }

  private func applyCanonical(
    _ canonical: ChatCanonicalSnapshot,
    preserveLiveProjection: Bool
  ) {
    let previousActiveTurnID = state.activeTurnID
    let isCaughtUp = canonical.throughSeq >= state.lastAppliedSeq
    let mayReplaceMessages = !preserveLiveProjection || state.messages.isEmpty || isCaughtUp
    if mayReplaceMessages {
      _ = ChatReducer.reduce(
        state: &state,
        action: .cachedMessagesLoaded(canonical.messages, cursor: canonical.throughSeq)
      )
    }
    state.olderCursor = canonical.nextCursor

    let canonicalIsCurrent =
      canonical.summary.revision >= state.conversation.revision
      && (!preserveLiveProjection || isCaughtUp || state.activeTurnID == nil)
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

  private func ensureConnected() async throws {
    startEventTaskIfNeeded()
    guard isConnected == false else { return }
    try await transport.connect()
    isConnected = true
    _ = ChatReducer.reduce(state: &state, action: .transportChanged(.connected))
  }

  private func suspendForDetachment() async {
    guard isConnected || state.transport != .detached else { return }
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
      _ = ChatReducer.reduce(state: &state, action: .transportChanged(transportState))
      if reconnectCompleted {
        await replayAndResumeActiveTurn()
      }

    case .frame(let frame):
      if frame.isAcceptedForFeature,
        let pendingSendReconciliation,
        pendingSendReconciliation.turnID == frame.turnIDForFeature
      {
        _ = await clearPendingSendDurably(pendingSendReconciliation)
      }
      await applyReducerAction(.frame(frame))
      if frame.isRejectionForFeature,
        let pendingSendReconciliation,
        pendingSendReconciliation.turnID == frame.turnIDForFeature
      {
        _ = await restorePendingSendAsDraft(pendingSendReconciliation)
      }
      if frame.isAdmissionOrTerminal {
        await refreshCanonical(preserveLiveProjection: true)
      }
      if frame.isTerminalForFeature {
        if pendingSendReconciliation?.turnID != frame.turnIDForFeature {
          localTurnIDs.remove(frame.turnIDForFeature)
          cancelRequestSent = false
          isCancelling = false
        }
        if isVisible == false {
          await suspendForDetachment()
        }
      }
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
      await applyReducerAction(.replayLoaded(entries))
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

  private func applyReducerAction(_ action: ChatAction) async {
    let previous = state
    var next = state
    var effects = ChatReducer.reduce(state: &next, action: action)
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
          effects.append(
            contentsOf: ChatReducer.reduce(
              state: &next,
              action: .cachedMessagesLoaded(
                canonical.messages,
                cursor: canonical.throughSeq
              )
            )
          )
          _ = ChatReducer.reduce(state: &next, action: .authoritativeSummary(canonical.summary))
          next.olderCursor = canonical.nextCursor

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
    } catch is CancellationError {
      state = preservingComposer(in: previous, from: state)
    } catch {
      state = preservingComposer(in: previous, from: state)
      await applyFailure(error)
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
      && state.activeTurnID == nil
      && state.composerBlock == nil
      && isConversationReadOnly == false
  }

  private var turnMutationAuthorityIsAvailable: Bool {
    isShutdown == false
      && connection == .online
      && isAuthoritative
      && pendingSendReconciliation == nil
      && state.activeTurnID != nil
      && state.composerBlock == nil
      && isConversationReadOnly == false
  }

  private var composerMutationAllowed: Bool {
    isShutdown == false
      && isSending == false
      && pendingSendReconciliation == nil
      && state.composerBlock == nil
      && isConversationReadOnly == false
  }

  private func stagedSendAuthorityIsAvailable(turnID: String) -> Bool {
    isShutdown == false
      && connection == .online
      && isAuthoritative
      && pendingSendReconciliation?.turnID == turnID
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
      try await persistence.stagePendingSend(
        pending,
        gatewayID: gatewayID,
        conversationID: state.conversation.id
      )
      draftStatus = .saved
      return true
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

  @discardableResult
  private func clearPendingSendDurably(_ pending: PendingChatSend) async -> Bool {
    guard pendingSendReconciliation?.turnID == pending.turnID else { return true }
    do {
      try await persistence.clearPendingSend(
        gatewayID: gatewayID,
        conversationID: state.conversation.id,
        turnID: pending.turnID
      )
      pendingSendReconciliation = nil
      return true
    } catch is CancellationError {
      state.errorBanner = "The message was accepted, but its local state couldn't be saved."
      return false
    } catch {
      state.errorBanner = "The message was accepted, but its local state couldn't be saved."
      return false
    }
  }

  @discardableResult
  private func restorePendingSendAsDraft(_ pending: PendingChatSend) async -> Bool {
    guard pendingSendReconciliation?.turnID == pending.turnID else { return true }
    do {
      guard
        let restored = try await persistence.restorePendingSendAsDraft(
          gatewayID: gatewayID,
          conversationID: state.conversation.id,
          turnID: pending.turnID
        )
      else {
        state.errorBanner =
          "The pending message couldn't be restored. Retry to check the conversation."
        return false
      }
      pendingSendReconciliation = nil
      localTurnIDs.remove(pending.turnID)
      _ = ChatReducer.reduce(state: &state, action: .sendRejected(turnID: pending.turnID))
      state.draft = restored.text
      state.attachments = restored.attachments
      draftStatus = .saved
      return true
    } catch is CancellationError {
      draftStatus = .failed
      state.errorBanner =
        "The pending message couldn't be restored. Retry to check the conversation."
      return false
    } catch {
      draftStatus = .failed
      state.errorBanner =
        "The pending message couldn't be restored. Retry to check the conversation."
      return false
    }
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
    pendingSendReconciliation = pending
    isConnected = false
    isAuthoritative = false
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
      try await transport.sendTurn(
        id: pending.turnID,
        agentID: state.conversation.agentId,
        conversationID: state.conversation.id,
        text: text,
        images: images
      )
    } catch is CancellationError {
      await reconcileAmbiguousSend(pending)
    } catch {
      if sendFailureIsAmbiguous(error) {
        await reconcileAmbiguousSend(pending)
      } else {
        await rejectSend(pending, error: error)
      }
    }
  }

  private func resolvePendingSend(
    _ pending: PendingChatSend,
    from canonical: ChatCanonicalSnapshot,
    preserveLiveProjection: Bool
  ) async {
    guard pendingSendReconciliation?.turnID == pending.turnID else { return }
    let sameTurn = canonical.messages.filter { $0.turnId == pending.turnID }
    let wasAdmitted = canonical.summary.activeTurnId == pending.turnID || sameTurn.isEmpty == false
    if wasAdmitted {
      let pendingProjection = state.messages.filter { $0.turnID == pending.turnID }
      applyCanonical(canonical, preserveLiveProjection: preserveLiveProjection)
      restoreMissingProjection(pendingProjection, for: pending.turnID)
      guard await clearPendingSendDurably(pending) else { return }
      state.errorBanner = nil
      guard
        canonical.summary.status == .running,
        canonical.summary.activeTurnId == pending.turnID
      else { return }
      do {
        try await ensureConnected()
        try await transport.resume(
          turnID: pending.turnID,
          agentID: canonical.summary.agentId,
          conversationID: canonical.summary.id,
          sinceSeq: canonical.throughSeq
        )
      } catch is CancellationError {
        return
      } catch {
        await applyFailure(error)
      }
      return
    }

    let pendingProjection = state.messages.filter { $0.turnID == pending.turnID }
    applyCanonical(canonical, preserveLiveProjection: preserveLiveProjection)
    restoreMissingProjection(pendingProjection, for: pending.turnID)
    if canonical.summary.status == .deleted {
      isAuthoritative = false
      state.errorBanner = nil
      return
    }
    if isConversationReadOnly == false, canonical.summary.activeTurnId == nil {
      state.activeTurnID = pending.turnID
    }
    isAuthoritative = false
    state.errorBanner = "The message outcome is unknown. Retry to send it again."
  }

  private func rejectSend(_ pending: PendingChatSend, error: Error) async {
    _ = await restorePendingSendAsDraft(pending)
    await applyFailure(error)
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
  fileprivate var isAcceptedForFeature: Bool {
    if case .accepted = self { return true }
    return false
  }

  fileprivate var isRejectionForFeature: Bool {
    if case .error = self { return true }
    return false
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
    case .accepted(let id, _, _, _, _, _),
      .event(let id, _, _, _),
      .done(let id, _, _, _),
      .error(let id, _, _, _, _, _, _):
      id
    }
  }
}
