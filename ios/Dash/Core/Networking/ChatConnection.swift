import Foundation

protocol WebSocketTasking: AnyObject, Sendable {
  func resume()
  func send(_ message: URLSessionWebSocketTask.Message) async throws
  func receive() async throws -> URLSessionWebSocketTask.Message
  func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?)
  var peerClose: WebSocketCloseInfo? { get async }
}

struct WebSocketCloseInfo: Equatable, Sendable {
  let code: Int
  let reason: Data?
}

protocol WebSocketSessioning: Sendable {
  func webSocketTask(with request: URLRequest) -> any WebSocketTasking
}

private final class URLSessionWebSocketTaskAdapter: WebSocketTasking, @unchecked Sendable {
  private let task: URLSessionWebSocketTask

  init(task: URLSessionWebSocketTask) {
    self.task = task
  }

  func resume() {
    task.resume()
  }

  func send(_ message: URLSessionWebSocketTask.Message) async throws {
    try await task.send(message)
  }

  func receive() async throws -> URLSessionWebSocketTask.Message {
    try await task.receive()
  }

  func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
    task.cancel(with: closeCode, reason: reason)
  }

  var peerClose: WebSocketCloseInfo? {
    get async {
      guard task.closeCode != .invalid else { return nil }
      return WebSocketCloseInfo(code: Int(task.closeCode.rawValue), reason: task.closeReason)
    }
  }
}

final class URLSessionWebSocketSession: WebSocketSessioning, @unchecked Sendable {
  private let session: URLSession

  init(session: URLSession = .shared) {
    self.session = session
  }

  func webSocketTask(with request: URLRequest) -> any WebSocketTasking {
    URLSessionWebSocketTaskAdapter(task: session.webSocketTask(with: request))
  }
}

enum ChatTransportState: Equatable, Sendable {
  case idle
  case connecting
  case connected
  case reconnecting(attempt: Int)
  case detached
}

enum ChatConnectionEvent: Equatable, Sendable {
  case state(ChatTransportState)
  case frame(MobileWSServerFrame)
  case v2Frame(MobileV2WsServerFrame)
}

struct V2ProtocolCloseError: Error, Equatable, Sendable {
  let reason: String
}

actor ChatConnection {
  private static let reconnectLimit = 5
  private static let v2Capability = "chat-input-queue-v1"
  private static let v2ProtocolCloseReasons: Set<String> = [
    "unsupported_version",
    "unexpected_hello",
    "hello_required",
    "invalid_frame",
  ]

  private struct TurnSubscription: Sendable {
    let agentID: String
    let conversationID: String
    var sinceSeq: Int
    var capable: Bool
    let operationGeneration: Int
  }

  private struct ConversationSubscription: Sendable {
    let agentID: String
    let conversationID: String
    var lastAppliedV2Seq: Int
    var requestedV2Seq: Int
    var operationID: String?
    var operationGeneration: Int?
    var writtenGeneration: Int?
    var acknowledgedGeneration: Int?
    var acknowledgedWatermark: Int?
  }

  private enum V2ExpectedResponse: Equatable, Sendable {
    case accepted(runID: String)
    case inputAccepted(
      inputID: String,
      behavior: MobileV2InputBehavior,
      targetRunID: String?
    )
    case inputUpdated(inputID: String, afterRevision: Int)
    case inputRemoved(inputID: String, afterRevision: Int)
    case queueResumed(afterRevision: Int)
  }

  private struct PendingV2Command: Sendable {
    let frame: MobileV2WsClientFrame
    let conversationID: String
    let expected: V2ExpectedResponse
    let insertionOrder: UInt64
    var writtenGeneration: Int?
    var isCorrelated: Bool
    var writeWaiters: [CheckedContinuation<Void, Error>]
  }

  private struct SettledV2Command: Sendable {
    let frame: MobileV2WsClientFrame
    let conversationID: String
    let expected: V2ExpectedResponse
  }

  private struct PendingV2Answer: Sendable {
    let frame: MobileV2WsClientFrame
    let insertionOrder: UInt64
    var writeWaiters: [CheckedContinuation<Void, Error>]
  }

  private struct PendingV2Cancel: Sendable {
    let runID: String
    let insertionOrder: UInt64
    var writtenGeneration: Int?
    var isCorrelated: Bool
    var writeWaiters: [CheckedContinuation<Void, Error>]
  }

  private let endpoint: ConnectionEndpoint
  private let selection: MobileProtocolSelection
  private let session: any WebSocketSessioning
  private let clock: any AppClock
  private let stream: AsyncThrowingStream<ChatConnectionEvent, Error>
  private let continuation: AsyncThrowingStream<ChatConnectionEvent, Error>.Continuation

  private var socket: (any WebSocketTasking)?
  private var generation = 0
  private var turnOperationGeneration = 0
  private var reconnectAttempt = 0
  private var turnSubscriptions: [String: TurnSubscription] = [:]
  private var turnSubscriptionOrder: [String] = []
  private var conversationSubscription: ConversationSubscription?
  private var helloAcknowledgedGeneration: Int?
  private var helloWaiters: [CheckedContinuation<Void, Error>] = []
  private var subscriptionWriteWaiters: [CheckedContinuation<Void, Error>] = []
  private var readinessWaiters: [CheckedContinuation<Void, Error>] = []
  private var pendingV2Commands: [String: PendingV2Command] = [:]
  private var pendingV2CommandOrder: [String] = []
  private var settledV2Commands: [String: SettledV2Command] = [:]
  private var pendingV2Answers: [PendingV2Answer] = []
  private var pendingV2Cancels: [String: PendingV2Cancel] = [:]
  private var pendingV2CancelOrder: [String] = []
  private var v2CorrelationCandidates: [MobileV2SequencedFrame] = []
  private var v2RejectionCandidates: [MobileV2ControlFrame] = []
  private var acknowledgedV2Rejections: [MobileV2ControlFrame] = []
  private var nextV2InsertionOrder: UInt64 = 0
  private var v2FlushGeneration: Int?
  private var v2FlushRequested = false
  private var helloTimeoutTask: Task<Void, Never>?
  /// Conversations this socket watches, `conversationID -> agentID`
  /// (sub-agents design 7.6). Server-initiated turns arrive with a turn id
  /// this client never issued; without this set `receiveLoop` would drop them
  /// for exactly that reason. Cleared with the turn subscriptions whenever the
  /// socket's state is gone (connect, suspend, detach, terminal failure), and
  /// re-sent by `replayTurnSubscriptions` after a transient reconnect — a
  /// blip must not silently stop the notifications for the rest of the
  /// session.
  private var conversationSubscriptions: [String: String] = [:]
  private var conversationSubscriptionOrder: [String] = []
  private var state: ChatTransportState = .idle
  private var streamFinished = false
  private let locationProvider: @Sendable () -> ClientLocation?

  init(
    endpoint: ConnectionEndpoint,
    selection: MobileProtocolSelection,
    session: (any WebSocketSessioning)? = nil,
    clock: any AppClock = SystemAppClock(),
    /// Location attached to outgoing turns. Injected so frame-shape tests are
    /// deterministic: the real provider reads this device's time zone and
    /// locale, which differ between a dev machine and a CI simulator, and a
    /// frozen-frame assertion that depends on them fails wherever it did not
    /// happen to be written.
    locationProvider: @Sendable @escaping () -> ClientLocation? = { LocationProvider.current() }
  ) {
    self.locationProvider = locationProvider
    self.endpoint = endpoint
    self.selection = selection
    self.session =
      session
      ?? URLSessionWebSocketSession(
        session: GatewayURLSessionFactory.make(profile: endpoint.profile)
      )
    self.clock = clock
    let pair = AsyncThrowingStream<ChatConnectionEvent, Error>.makeStream()
    stream = pair.stream
    continuation = pair.continuation
  }

  func events() -> AsyncThrowingStream<ChatConnectionEvent, Error> {
    stream
  }

  func connect() async throws {
    try requireReusableStream()
    prepareForSocketReplacement()
    reconnectAttempt = 0
    try startSocket()
    if selection == .v2Queue {
      try await waitForHelloAcknowledgement()
    }
  }

  func sendTurn(
    id: String,
    agentID: String,
    conversationID: String,
    text: String,
    images: [MessageImage]
  ) async throws {
    guard selection == .v1 else {
      throw GatewayError.updateRequired
    }
    turnOperationGeneration += 1
    let operationGeneration = turnOperationGeneration
    registerTurn(
      id: id,
      agentID: agentID,
      conversationID: conversationID,
      sinceSeq: 0,
      capable: false,
      operationGeneration: operationGeneration
    )
    do {
      try await send(
        .newTurn(
          id: id,
          agentId: agentID,
          conversationId: conversationID,
          text: text,
          images: images.isEmpty ? nil : images,
          // Read per turn, not cached: a phone that crosses a time zone
          // reports the new one on the very next message.
          location: locationProvider()
        )
      )
    } catch {
      clearTurn(id: id, ifOwnedBy: operationGeneration)
      throw error
    }
  }

  func resume(
    turnID: String,
    agentID: String,
    conversationID: String,
    sinceSeq: Int
  ) async throws {
    guard selection == .v1 else {
      throw GatewayError.updateRequired
    }
    turnOperationGeneration += 1
    let operationGeneration = turnOperationGeneration
    registerTurn(
      id: turnID,
      agentID: agentID,
      conversationID: conversationID,
      sinceSeq: sinceSeq,
      capable: true,
      operationGeneration: operationGeneration
    )
    do {
      try await send(
        .resume(
          id: turnID,
          agentId: agentID,
          conversationId: conversationID,
          sinceSeq: sinceSeq
        )
      )
    } catch {
      clearTurn(id: turnID, ifOwnedBy: operationGeneration)
      throw error
    }
  }

  /// Watch `conversationID` so turns this socket did not start — the
  /// server-initiated notification turns of sub-agents design 7.6 — are
  /// accepted by `receiveLoop` instead of dropped for having an unknown turn
  /// id.
  func subscribe(agentID: String, conversationID: String) async throws {
    registerConversation(agentID: agentID, conversationID: conversationID)
    do {
      try await send(
        .subscribe(
          id: UUID().uuidString.lowercased(),
          agentId: agentID,
          conversationId: conversationID
        )
      )
    } catch {
      // The gateway never saw the frame, so nothing is watching over there —
      // do not leave this side believing otherwise.
      clearConversation(conversationID: conversationID)
      throw error
    }
  }

  func unsubscribe(agentID: String, conversationID: String) async throws {
    clearConversation(conversationID: conversationID)
    try await send(
      .unsubscribe(
        id: UUID().uuidString.lowercased(),
        agentId: agentID,
        conversationId: conversationID
      )
    )
  }

  func answer(turnID: String, questionID: String, answer: String) async throws {
    switch selection {
    case .v1:
      try await send(.answer(id: turnID, questionId: questionID, answer: answer))
    case .v2Queue:
      try requireDesiredV2Conversation()
      let frame = MobileV2WsClientFrame.answer(
        id: turnID,
        questionId: questionID,
        answer: answer
      )
      try await registerV2Answer(frame)
    }
  }

  func cancel(turnID: String) async throws {
    switch selection {
    case .v1:
      try await send(.cancel(id: turnID))
    case .v2Queue:
      try requireDesiredV2Conversation()
      try await registerV2Cancel(runID: turnID)
    }
  }

  func subscribeConversation(
    agentID: String,
    conversationID: String,
    sinceV2Seq: Int
  ) async throws {
    try requireV2Selection()
    guard sinceV2Seq >= 0 else {
      throw GatewayError.validation("v2 cursor must be nonnegative")
    }

    if var current = conversationSubscription {
      guard current.agentID == agentID, current.conversationID == conversationID else {
        throw GatewayError.validation("Chat connection already has another v2 conversation")
      }
      if sinceV2Seq > current.lastAppliedV2Seq {
        current.lastAppliedV2Seq = sinceV2Seq
        current.requestedV2Seq = sinceV2Seq
        current.operationID = nil
        current.operationGeneration = nil
        current.writtenGeneration = nil
        current.acknowledgedGeneration = nil
        current.acknowledgedWatermark = nil
        conversationSubscription = current
      }
    } else {
      conversationSubscription = ConversationSubscription(
        agentID: agentID,
        conversationID: conversationID,
        lastAppliedV2Seq: sinceV2Seq,
        requestedV2Seq: sinceV2Seq,
        operationID: nil,
        operationGeneration: nil,
        writtenGeneration: nil,
        acknowledgedGeneration: nil,
        acknowledgedWatermark: nil
      )
    }

    if conversationSubscription?.writtenGeneration == generation,
      helloAcknowledgedGeneration == generation
    {
      return
    }
    try await withCheckedThrowingContinuation { waiter in
      subscriptionWriteWaiters.append(waiter)
      scheduleV2Flush()
    }
  }

  func waitUntilConversationReady(conversationID: String) async throws {
    try requireV2Selection()
    guard conversationSubscription?.conversationID == conversationID else {
      throw GatewayError.validation("No matching v2 conversation subscription")
    }
    if isV2ConversationReady { return }
    try await withCheckedThrowingContinuation { waiter in
      readinessWaiters.append(waiter)
    }
  }

  func sendV2Turn(
    id: String,
    agentID: String,
    conversationID: String,
    text: String,
    images: [MessageImage]
  ) async throws {
    let subscription = try requireDesiredV2Conversation(conversationID: conversationID)
    guard subscription.agentID == agentID else {
      throw GatewayError.validation("v2 command agent does not match the subscription")
    }
    try await registerV2Command(
      .message(
        id: id,
        agentId: agentID,
        channelId: "ios",
        conversationId: conversationID,
        text: text,
        location: locationProvider(),
        images: images.isEmpty ? nil : images,
        resumable: true
      ),
      id: id,
      conversationID: conversationID,
      expected: .accepted(runID: id)
    )
  }

  func enqueueInput(_ frame: MobileV2WsClientFrame) async throws {
    guard
      case let .enqueueInput(
        id,
        inputID,
        _,
        _,
        conversationID,
        _,
        _,
        behavior,
        expectedActiveTurnID
      ) = frame
    else {
      throw GatewayError.validation("Expected enqueue_input frame")
    }
    _ = try requireDesiredV2Conversation(conversationID: conversationID)
    try await registerV2Command(
      frame,
      id: id,
      conversationID: conversationID,
      expected: .inputAccepted(
        inputID: inputID,
        behavior: behavior,
        targetRunID: expectedActiveTurnID
      )
    )
  }

  func editFollowUp(_ frame: MobileV2WsClientFrame) async throws {
    guard
      case let .editFollowUp(id, conversationID, inputID, revision, _, _) = frame
    else {
      throw GatewayError.validation("Expected edit_follow_up frame")
    }
    _ = try requireDesiredV2Conversation(conversationID: conversationID)
    try await registerV2Command(
      frame,
      id: id,
      conversationID: conversationID,
      expected: .inputUpdated(inputID: inputID, afterRevision: revision)
    )
  }

  func removeFollowUp(_ frame: MobileV2WsClientFrame) async throws {
    guard case let .removeFollowUp(id, conversationID, inputID, revision) = frame else {
      throw GatewayError.validation("Expected remove_follow_up frame")
    }
    _ = try requireDesiredV2Conversation(conversationID: conversationID)
    try await registerV2Command(
      frame,
      id: id,
      conversationID: conversationID,
      expected: .inputRemoved(inputID: inputID, afterRevision: revision)
    )
  }

  func resumeFollowUps(_ frame: MobileV2WsClientFrame) async throws {
    guard case let .resumeFollowUps(id, conversationID, revision) = frame else {
      throw GatewayError.validation("Expected resume_follow_ups frame")
    }
    _ = try requireDesiredV2Conversation(conversationID: conversationID)
    try await registerV2Command(
      frame,
      id: id,
      conversationID: conversationID,
      expected: .queueResumed(afterRevision: revision)
    )
  }

  func acknowledgeAppliedV2Seq(_ seq: Int, conversationID: String) async {
    guard selection == .v2Queue, seq >= 0,
      var subscription = conversationSubscription,
      subscription.conversationID == conversationID
    else { return }
    subscription.lastAppliedV2Seq = max(subscription.lastAppliedV2Seq, seq)
    conversationSubscription = subscription
    settleV2Candidates(through: seq, conversationID: conversationID)
    advanceV2ReadinessIfPossible()
  }

  func acknowledgeV2CommandRejected(_ frame: MobileV2ControlFrame) async {
    guard selection == .v2Queue,
      case .commandRejected = frame,
      let candidateIndex = v2RejectionCandidates.firstIndex(of: frame)
    else { return }
    v2RejectionCandidates.remove(at: candidateIndex)
    acknowledgedV2Rejections.append(frame)
    settleAcknowledgedV2Rejections()
  }

  func detach() {
    detachNow()
  }

  func shutdown() {
    detachNow()
  }

  func suspend() {
    guard state != .detached else { return }
    generation += 1
    helloTimeoutTask?.cancel()
    helloTimeoutTask = nil
    socket?.cancel(with: .goingAway, reason: nil)
    socket = nil
    v2FlushGeneration = nil
    v2FlushRequested = false
    helloAcknowledgedGeneration = nil
    if selection == .v1 {
      clearAllTurns()
    } else {
      resetV2WireState()
    }
    reconnectAttempt = 0
    transition(to: .idle)
  }

  func probeAuthentication(selection requestedSelection: MobileProtocolSelection) async throws {
    guard requestedSelection == selection else {
      throw GatewayError.updateRequired
    }
    try requireReusableStream()
    prepareForSocketReplacement()
    generation += 1
    let probeGeneration = generation
    transition(to: .connecting)
    try endpoint.requireTrustedTransport()
    let task = session.webSocketTask(with: try endpoint.chatRequest())
    socket = task
    task.resume()
    transition(to: .connected)
    defer { detachProbe(task: task, generation: probeGeneration) }

    switch selection {
    case .v1:
      let probeID = UUID().uuidString.lowercased()
      let conversationID = UUID().uuidString.lowercased()
      try await send(
        .resume(
          id: probeID,
          agentId: "__dash_ios_pairing_probe__",
          conversationId: conversationID,
          sinceSeq: 0
        )
      )
    case .v2Queue:
      try await sendV2ProbeHello()
    }

    enum ProbeResult: Sendable {
      case message(URLSessionWebSocketTask.Message)
      case timeout
    }

    let result: ProbeResult
    do {
      result = try await withThrowingTaskGroup(of: ProbeResult.self) { group in
        group.addTask { .message(try await task.receive()) }
        group.addTask { [clock] in
          try await clock.sleep(for: .seconds(5))
          return .timeout
        }
        guard let first = try await group.next() else {
          throw GatewayError.transport("Chat authentication probe failed")
        }
        task.cancel(with: .goingAway, reason: nil)
        group.cancelAll()
        return first
      }
    } catch {
      if let close = await task.peerClose, let mapped = closeError(close) {
        throw mapped
      }
      if error is CancellationError {
        throw GatewayError.transport("Chat authentication probe timed out")
      }
      throw GatewayError.transport(error.localizedDescription)
    }

    switch result {
    case .timeout:
      throw GatewayError.transport("Chat authentication probe timed out")
    case .message(let message):
      switch selection {
      case .v1:
        _ = try decodedFrame(from: message)
      case .v2Queue:
        try validateV2ProbeAcknowledgement(from: message)
      }
    }
  }

  private func startSocket() throws {
    generation += 1
    let currentGeneration = generation
    transition(to: .connecting)
    try endpoint.requireTrustedTransport()
    let task = session.webSocketTask(with: try endpoint.chatRequest())
    socket = task
    task.resume()
    transition(to: .connected)
    switch selection {
    case .v1:
      Task { [weak self] in
        await self?.receiveLoopV1(task: task, generation: currentGeneration)
      }
    case .v2Queue:
      beginV2Socket(task: task, generation: currentGeneration)
    }
  }

  private func receiveLoopV1(
    task: any WebSocketTasking,
    generation loopGeneration: Int
  ) async {
    do {
      while loopGeneration == generation, state != .detached {
        let message = try await task.receive()
        guard loopGeneration == generation, state != .detached else { return }
        let frame = try decodedFrame(from: message)
        // A turn this client never started, on a conversation it watches: the
        // server-initiated notification turns and child turns of sub-agents
        // design 7.6. Register the turn from its `accepted` so the rest of its
        // frames follow the ordinary path; anything else with an unknown turn
        // id is still dropped.
        if turnSubscriptions[frame.id] == nil,
          frame.isAccepted,
          let conversationID = frame.acceptedConversationID,
          let agentID = conversationSubscriptions[conversationID]
        {
          turnOperationGeneration += 1
          registerTurn(
            id: frame.id,
            agentID: agentID,
            conversationID: conversationID,
            sinceSeq: 0,
            capable: true,
            operationGeneration: turnOperationGeneration
          )
        }
        guard var subscription = turnSubscriptions[frame.id] else { continue }
        let capable = subscription.capable || frame.isAccepted
        _ = try validatedFrame(frame, capable: capable)
        reconnectAttempt = 0
        if frame.isAccepted {
          subscription.capable = true
        }
        if let seq = frame.seq {
          subscription.sinceSeq = max(subscription.sinceSeq, seq)
        }
        turnSubscriptions[frame.id] = subscription
        continuation.yield(.frame(frame))
        if frame.isTerminal {
          clearTurn(id: frame.id, ifOwnedBy: subscription.operationGeneration)
        }
      }
    } catch is DecodingError {
      finish(throwing: GatewayError.updateRequired, generation: loopGeneration)
    } catch is ContractValidationError {
      finish(throwing: GatewayError.updateRequired, generation: loopGeneration)
    } catch let error as GatewayError {
      finish(throwing: error, generation: loopGeneration)
    } catch {
      await handleReceiveFailure(error, task: task, generation: loopGeneration)
    }
  }

  private func beginV2Socket(task: any WebSocketTasking, generation socketGeneration: Int) {
    helloAcknowledgedGeneration = nil
    resetV2WireState()
    helloTimeoutTask?.cancel()
    helloTimeoutTask = Task { [weak self, clock] in
      do {
        try await clock.sleep(for: .seconds(5))
      } catch {
        return
      }
      await self?.v2HelloTimedOut(task: task, generation: socketGeneration)
    }
    Task { [weak self] in
      guard let self else { return }
      do {
        try await self.sendV2(
          .hello(
            contractVersion: 2,
            capabilities: [Self.v2Capability]
          ),
          task: task,
          generation: socketGeneration
        )
        await self.receiveLoopV2(task: task, generation: socketGeneration)
      } catch {
        await self.handleReceiveFailure(error, task: task, generation: socketGeneration)
      }
    }
  }

  private func receiveLoopV2(
    task: any WebSocketTasking,
    generation loopGeneration: Int
  ) async {
    do {
      while isCurrentSocket(task, generation: loopGeneration) {
        let message = try await task.receive()
        guard isCurrentSocket(task, generation: loopGeneration) else { return }
        let frame = try decodedV2Frame(from: message)
        try receiveV2Frame(frame, task: task, generation: loopGeneration)
      }
    } catch is DecodingError {
      finish(throwing: GatewayError.updateRequired, generation: loopGeneration)
    } catch is MobileV2ContractValidationError {
      finish(throwing: GatewayError.updateRequired, generation: loopGeneration)
    } catch let error as GatewayError {
      finish(throwing: error, generation: loopGeneration)
    } catch let error as V2ProtocolCloseError {
      finish(throwing: error, generation: loopGeneration)
    } catch {
      await handleReceiveFailure(error, task: task, generation: loopGeneration)
    }
  }

  private func receiveV2Frame(
    _ frame: MobileV2WsServerFrame,
    task: any WebSocketTasking,
    generation frameGeneration: Int
  ) throws {
    guard isCurrentSocket(task, generation: frameGeneration) else { return }
    switch frame {
    case let .control(.helloAck(_, capabilities)):
      guard helloAcknowledgedGeneration == nil,
        capabilities.contains(Self.v2Capability)
      else {
        throw GatewayError.updateRequired
      }
      helloAcknowledgedGeneration = frameGeneration
      helloTimeoutTask?.cancel()
      helloTimeoutTask = nil
      resumeHelloWaiters()
      continuation.yield(.v2Frame(frame))
      scheduleV2Flush()

    case let .control(.conversationSubscribed(id, conversationID, watermark)):
      guard helloAcknowledgedGeneration == frameGeneration,
        var subscription = conversationSubscription
      else {
        throw GatewayError.updateRequired
      }
      guard subscription.operationGeneration == frameGeneration,
        subscription.operationID == id
      else { return }
      guard subscription.conversationID == conversationID else {
        throw GatewayError.updateRequired
      }
      guard watermark >= subscription.requestedV2Seq else {
        throw GatewayError.updateRequired
      }
      subscription.acknowledgedGeneration = frameGeneration
      subscription.acknowledgedWatermark = watermark
      conversationSubscription = subscription
      continuation.yield(.v2Frame(frame))
      advanceV2ReadinessIfPossible()

    case let .control(control):
      guard helloAcknowledgedGeneration == frameGeneration else {
        throw GatewayError.updateRequired
      }
      guard case let .commandRejected(_, conversationID, _, _, _, _) = control else {
        throw GatewayError.updateRequired
      }
      if let conversationID {
        try requireV2FrameConversation(conversationID)
      }
      v2RejectionCandidates.append(control)
      continuation.yield(.v2Frame(frame))

    case let .sequenced(sequenced):
      guard helloAcknowledgedGeneration == frameGeneration else {
        throw GatewayError.updateRequired
      }
      try requireV2FrameConversation(sequenced.conversationId)
      continuation.yield(.v2Frame(frame))
      if isV2CorrelationCandidate(sequenced) {
        v2CorrelationCandidates.append(sequenced)
        if sequenced.v2Seq <= (conversationSubscription?.lastAppliedV2Seq ?? -1) {
          settleV2Candidates(
            through: conversationSubscription?.lastAppliedV2Seq ?? -1,
            conversationID: sequenced.conversationId
          )
        }
      }
    }
  }

  private func v2HelloTimedOut(
    task: any WebSocketTasking,
    generation timeoutGeneration: Int
  ) {
    guard isCurrentSocket(task, generation: timeoutGeneration),
      helloAcknowledgedGeneration != timeoutGeneration
    else { return }
    finish(throwing: GatewayError.updateRequired, generation: timeoutGeneration)
  }

  private func handleReceiveFailure(
    _ error: Error,
    task: any WebSocketTasking,
    generation failedGeneration: Int
  ) async {
    guard isCurrentSocket(task, generation: failedGeneration) else { return }
    generation += 1
    let reconnectGeneration = generation
    helloTimeoutTask?.cancel()
    helloTimeoutTask = nil
    socket = nil
    v2FlushGeneration = nil
    v2FlushRequested = false
    if selection == .v2Queue {
      helloAcknowledgedGeneration = nil
      resetV2WireState()
    }

    let close = await task.peerClose
    task.cancel(with: .goingAway, reason: nil)
    guard reconnectGeneration == generation, state != .detached, streamFinished == false else {
      return
    }
    if let close, let mapped = closeError(close) {
      finish(throwing: mapped, generation: reconnectGeneration)
      return
    }
    guard reconnectAttempt < Self.reconnectLimit else {
      finish(
        throwing: GatewayError.transport(error.localizedDescription),
        generation: reconnectGeneration
      )
      return
    }

    reconnectAttempt += 1
    let attempt = reconnectAttempt
    transition(to: .reconnecting(attempt: attempt))
    do {
      try await clock.sleep(for: .seconds(min(30, 1 << min(attempt - 1, 4))))
    } catch {
      guard reconnectGeneration == generation, state != .detached, streamFinished == false else {
        return
      }
      finish(
        throwing: GatewayError.transport(error.localizedDescription),
        generation: reconnectGeneration
      )
      return
    }
    guard reconnectGeneration == generation, state != .detached, streamFinished == false else {
      return
    }
    do {
      try startSocket()
    } catch {
      finish(
        throwing: GatewayError.transport(error.localizedDescription),
        generation: generation
      )
      return
    }
    if selection == .v1 {
      let replayGeneration = generation
      guard let replaySocket = socket else { return }
      do {
        try await replayTurnSubscriptions()
      } catch {
        await handleReceiveFailure(
          error,
          task: replaySocket,
          generation: replayGeneration
        )
      }
    }
  }

  private func send(_ frame: MobileWSClientFrame) async throws {
    guard selection == .v1 else {
      throw GatewayError.updateRequired
    }
    guard let socket, state == .connected else {
      throw GatewayError.transport("Chat connection is not connected")
    }
    let sendGeneration = generation
    let data = try ContractCoding.encoder().encode(frame)
    guard let text = String(data: data, encoding: .utf8) else {
      throw GatewayError.updateRequired
    }
    try await socket.send(.string(text))
    guard
      sendGeneration == generation,
      state == .connected,
      streamFinished == false,
      let currentSocket = self.socket,
      currentSocket === socket
    else {
      throw GatewayError.transport("Chat connection changed while sending")
    }
  }

  private func sendV2(
    _ frame: MobileV2WsClientFrame,
    task: any WebSocketTasking,
    generation sendGeneration: Int
  ) async throws {
    guard isCurrentSocket(task, generation: sendGeneration) else {
      throw GatewayError.transport("Chat connection changed while sending")
    }
    let data: Data
    do {
      data = try ContractCoding.encoder().encode(frame)
    } catch is MobileV2ContractValidationError {
      throw GatewayError.updateRequired
    }
    guard let text = String(data: data, encoding: .utf8) else {
      throw GatewayError.updateRequired
    }
    try await task.send(.string(text))
    guard isCurrentSocket(task, generation: sendGeneration) else {
      throw GatewayError.transport("Chat connection changed while sending")
    }
  }

  private func sendV2ProbeHello() async throws {
    guard let socket, state == .connected else {
      throw GatewayError.transport("Chat connection is not connected")
    }
    let sendGeneration = generation
    let data: Data
    do {
      data = try ContractCoding.encoder().encode(
        MobileV2WsClientFrame.hello(
          contractVersion: 2,
          capabilities: ["chat-input-queue-v1"]
        )
      )
    } catch is MobileV2ContractValidationError {
      throw GatewayError.updateRequired
    }
    guard let text = String(data: data, encoding: .utf8) else {
      throw GatewayError.updateRequired
    }
    try await socket.send(.string(text))
    guard
      sendGeneration == generation,
      state == .connected,
      streamFinished == false,
      let currentSocket = self.socket,
      currentSocket === socket
    else {
      throw GatewayError.transport("Chat connection changed while sending")
    }
  }

  private func validateV2ProbeAcknowledgement(
    from message: URLSessionWebSocketTask.Message
  ) throws {
    let data: Data
    switch message {
    case .string(let text):
      data = Data(text.utf8)
    case .data(let binary):
      guard String(data: binary, encoding: .utf8) != nil else {
        throw GatewayError.updateRequired
      }
      data = binary
    @unknown default:
      throw GatewayError.updateRequired
    }

    let frame: MobileV2WsServerFrame
    do {
      frame = try ContractCoding.decoder().decode(MobileV2WsServerFrame.self, from: data)
    } catch is DecodingError {
      throw GatewayError.updateRequired
    } catch is MobileV2ContractValidationError {
      throw GatewayError.updateRequired
    }

    guard
      case let .control(.helloAck(_, capabilities)) = frame,
      capabilities.contains("chat-input-queue-v1")
    else {
      throw GatewayError.updateRequired
    }
  }

  private func decodedFrame(
    from message: URLSessionWebSocketTask.Message
  ) throws -> MobileWSServerFrame {
    let data: Data
    switch message {
    case .string(let text):
      data = Data(text.utf8)
    case .data(let binary):
      guard String(data: binary, encoding: .utf8) != nil else {
        throw GatewayError.updateRequired
      }
      data = binary
    @unknown default:
      throw GatewayError.updateRequired
    }
    do {
      return try ContractCoding.decoder().decode(MobileWSServerFrame.self, from: data)
    } catch is DecodingError {
      throw GatewayError.updateRequired
    } catch is ContractValidationError {
      throw GatewayError.updateRequired
    }
  }

  private func decodedV2Frame(
    from message: URLSessionWebSocketTask.Message
  ) throws -> MobileV2WsServerFrame {
    let data: Data
    switch message {
    case .string(let text):
      data = Data(text.utf8)
    case .data(let binary):
      guard String(data: binary, encoding: .utf8) != nil else {
        throw GatewayError.updateRequired
      }
      data = binary
    @unknown default:
      throw GatewayError.updateRequired
    }
    do {
      return try ContractCoding.decoder().decode(MobileV2WsServerFrame.self, from: data)
    } catch is DecodingError {
      throw GatewayError.updateRequired
    } catch is MobileV2ContractValidationError {
      throw GatewayError.updateRequired
    }
  }

  private func validatedFrame(
    _ frame: MobileWSServerFrame,
    capable: Bool
  ) throws -> CapableServerFrame? {
    guard capable else {
      if case .error(_, _, nil, _, _, _, _) = frame {
        return try CapableServerFrame.validating(frame)
      }
      throw ContractValidationError.requiredCapableField("accepted")
    }
    return try CapableServerFrame.validating(frame)
  }

  private func closeError(_ close: WebSocketCloseInfo) -> (any Error)? {
    switch close.code {
    case 4001, 4401:
      return GatewayError.unauthorized
    case 4429:
      return GatewayError.rateLimited(retryAfter: retryAfter(from: close.reason))
    default:
      guard selection == .v2Queue,
        close.code == 1002,
        let reason = close.reason.flatMap({ String(data: $0, encoding: .utf8) }),
        Self.v2ProtocolCloseReasons.contains(reason)
      else { return nil }
      return V2ProtocolCloseError(reason: reason)
    }
  }

  private func retryAfter(from reason: Data?) -> Duration? {
    guard let reason, let raw = String(data: reason, encoding: .utf8) else { return nil }
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if let seconds = Double(trimmed), let duration = duration(seconds: seconds) {
      return duration
    }
    guard
      let json = try? ContractCoding.decoder().decode(JSONValue.self, from: Data(trimmed.utf8)),
      let object = json.objectValue
    else { return nil }
    for key in ["retryAfterSeconds", "retryAfter"] {
      if case .number(let seconds)? = object[key],
        let duration = duration(seconds: seconds)
      {
        return duration
      }
    }
    return nil
  }

  private func duration(seconds: Double) -> Duration? {
    guard seconds.isFinite, seconds >= 0 else { return nil }
    let milliseconds = (seconds * 1_000).rounded()
    guard milliseconds.isFinite, milliseconds < Double(Int64.max) else { return nil }
    return .milliseconds(Int64(milliseconds))
  }

  private var isV2ConversationReady: Bool {
    guard let subscription = conversationSubscription,
      subscription.acknowledgedGeneration == generation,
      let watermark = subscription.acknowledgedWatermark
    else { return false }
    return subscription.lastAppliedV2Seq >= watermark
  }

  private func waitForHelloAcknowledgement() async throws {
    if helloAcknowledgedGeneration == generation { return }
    try await withCheckedThrowingContinuation { waiter in
      helloWaiters.append(waiter)
    }
  }

  private func requireV2Selection() throws {
    try requireReusableStream()
    guard selection == .v2Queue else {
      throw GatewayError.updateRequired
    }
  }

  @discardableResult
  private func requireDesiredV2Conversation(
    conversationID: String? = nil
  ) throws -> ConversationSubscription {
    try requireV2Selection()
    guard let subscription = conversationSubscription,
      conversationID == nil || subscription.conversationID == conversationID
    else {
      throw GatewayError.validation("No matching v2 conversation subscription")
    }
    return subscription
  }

  private func requireV2FrameConversation(_ conversationID: String?) throws {
    guard let expected = conversationSubscription?.conversationID,
      conversationID == expected
    else {
      throw GatewayError.updateRequired
    }
  }

  private func registerV2Command(
    _ frame: MobileV2WsClientFrame,
    id: String,
    conversationID: String,
    expected: V2ExpectedResponse
  ) async throws {
    try validateV2OutboundFrame(frame)
    if let settled = settledV2Commands[id] {
      guard settled.frame == frame,
        settled.conversationID == conversationID,
        settled.expected == expected
      else {
        throw GatewayError.validation("v2 command id is already registered with another payload")
      }
      return
    }
    if let existing = pendingV2Commands[id] {
      guard existing.frame == frame,
        existing.conversationID == conversationID,
        existing.expected == expected
      else {
        throw GatewayError.validation("v2 command id is already registered with another payload")
      }
      if existing.writtenGeneration == generation, isV2ConversationReady { return }
    }

    try await withCheckedThrowingContinuation { waiter in
      if var existing = pendingV2Commands[id] {
        existing.writeWaiters.append(waiter)
        pendingV2Commands[id] = existing
      } else {
        nextV2InsertionOrder &+= 1
        pendingV2Commands[id] = PendingV2Command(
          frame: frame,
          conversationID: conversationID,
          expected: expected,
          insertionOrder: nextV2InsertionOrder,
          writtenGeneration: nil,
          isCorrelated: false,
          writeWaiters: [waiter]
        )
        pendingV2CommandOrder.append(id)
      }
      scheduleV2Flush()
    }
  }

  private func registerV2Answer(_ frame: MobileV2WsClientFrame) async throws {
    try validateV2OutboundFrame(frame)
    try await withCheckedThrowingContinuation { waiter in
      nextV2InsertionOrder &+= 1
      pendingV2Answers.append(
        PendingV2Answer(
          frame: frame,
          insertionOrder: nextV2InsertionOrder,
          writeWaiters: [waiter]
        )
      )
      scheduleV2Flush()
    }
  }

  private func registerV2Cancel(runID: String) async throws {
    let frame = MobileV2WsClientFrame.cancel(id: runID)
    try validateV2OutboundFrame(frame)
    if let existing = pendingV2Cancels[runID],
      existing.writtenGeneration == generation,
      isV2ConversationReady
    {
      return
    }
    try await withCheckedThrowingContinuation { waiter in
      if var existing = pendingV2Cancels[runID] {
        existing.writeWaiters.append(waiter)
        pendingV2Cancels[runID] = existing
      } else {
        nextV2InsertionOrder &+= 1
        pendingV2Cancels[runID] = PendingV2Cancel(
          runID: runID,
          insertionOrder: nextV2InsertionOrder,
          writtenGeneration: nil,
          isCorrelated: false,
          writeWaiters: [waiter]
        )
        pendingV2CancelOrder.append(runID)
      }
      scheduleV2Flush()
    }
  }

  private func validateV2OutboundFrame(_ frame: MobileV2WsClientFrame) throws {
    do {
      _ = try ContractCoding.encoder().encode(frame)
    } catch is MobileV2ContractValidationError {
      throw GatewayError.validation("Invalid v2 chat command")
    }
  }

  private func scheduleV2Flush() {
    guard selection == .v2Queue, streamFinished == false, state != .detached else { return }
    let flushGeneration = generation
    if v2FlushGeneration == flushGeneration {
      v2FlushRequested = true
      return
    }
    v2FlushRequested = false
    v2FlushGeneration = flushGeneration
    Task { [weak self] in
      await self?.flushV2(generation: flushGeneration)
    }
  }

  private func flushV2(generation flushGeneration: Int) async {
    defer {
      if v2FlushGeneration == flushGeneration {
        v2FlushGeneration = nil
        if v2FlushRequested {
          v2FlushRequested = false
          scheduleV2Flush()
        }
      }
    }
    guard selection == .v2Queue,
      helloAcknowledgedGeneration == flushGeneration,
      let task = socket,
      isCurrentSocket(task, generation: flushGeneration)
    else { return }

    do {
      try await sendV2SubscriptionIfNeeded(task: task, generation: flushGeneration)
      guard isCurrentSocket(task, generation: flushGeneration), isV2ConversationReady else {
        return
      }

      for runID in pendingV2CancelOrder {
        guard var pending = pendingV2Cancels[runID],
          pending.writtenGeneration != flushGeneration
        else { continue }
        guard
          let subscriptionOperationID = readyV2SubscriptionOperationID(
            task: task,
            generation: flushGeneration
          )
        else { return }
        try await sendV2(.cancel(id: runID), task: task, generation: flushGeneration)
        guard var current = pendingV2Cancels[runID], current.runID == pending.runID else {
          continue
        }
        current.writtenGeneration = flushGeneration
        let waiters = current.writeWaiters
        current.writeWaiters.removeAll()
        if current.isCorrelated {
          pendingV2Cancels[runID] = nil
          pendingV2CancelOrder.removeAll { $0 == runID }
        } else {
          pendingV2Cancels[runID] = current
        }
        for waiter in waiters { waiter.resume() }
        pending = current
        settleV2CandidatesForCurrentDurableCursor()
        guard
          readyV2SubscriptionOperationID(task: task, generation: flushGeneration)
            == subscriptionOperationID
        else { return }
      }

      while let pending = pendingV2Answers.min(by: {
        $0.insertionOrder < $1.insertionOrder
      }) {
        guard
          let subscriptionOperationID = readyV2SubscriptionOperationID(
            task: task,
            generation: flushGeneration
          )
        else { return }
        try await sendV2(pending.frame, task: task, generation: flushGeneration)
        guard let index = pendingV2Answers.firstIndex(where: {
          $0.insertionOrder == pending.insertionOrder && $0.frame == pending.frame
        }) else { continue }
        let written = pendingV2Answers.remove(at: index)
        for waiter in written.writeWaiters { waiter.resume() }
        guard
          readyV2SubscriptionOperationID(task: task, generation: flushGeneration)
            == subscriptionOperationID
        else { return }
      }

      for id in pendingV2CommandOrder {
        guard var pending = pendingV2Commands[id],
          pending.writtenGeneration != flushGeneration
        else { continue }
        guard
          let subscriptionOperationID = readyV2SubscriptionOperationID(
            task: task,
            generation: flushGeneration
          )
        else { return }
        try await sendV2(pending.frame, task: task, generation: flushGeneration)
        guard var current = pendingV2Commands[id], current.frame == pending.frame else {
          continue
        }
        current.writtenGeneration = flushGeneration
        let waiters = current.writeWaiters
        current.writeWaiters.removeAll()
        if current.isCorrelated {
          retireV2Command(id: id, pending: current)
        } else {
          pendingV2Commands[id] = current
        }
        for waiter in waiters { waiter.resume() }
        pending = current
        settleV2CandidatesForCurrentDurableCursor()
        settleAcknowledgedV2Rejections()
        guard
          readyV2SubscriptionOperationID(task: task, generation: flushGeneration)
            == subscriptionOperationID
        else { return }
      }
    } catch GatewayError.updateRequired {
      finish(throwing: GatewayError.updateRequired, generation: flushGeneration)
    } catch {
      await handleReceiveFailure(error, task: task, generation: flushGeneration)
    }
  }

  private func readyV2SubscriptionOperationID(
    task: any WebSocketTasking,
    generation expectedGeneration: Int
  ) -> String? {
    guard isCurrentSocket(task, generation: expectedGeneration),
      isV2ConversationReady,
      let subscription = conversationSubscription,
      subscription.operationGeneration == expectedGeneration,
      subscription.acknowledgedGeneration == expectedGeneration,
      let operationID = subscription.operationID
    else { return nil }
    return operationID
  }

  private func sendV2SubscriptionIfNeeded(
    task: any WebSocketTasking,
    generation sendGeneration: Int
  ) async throws {
    guard var subscription = conversationSubscription else { return }
    if subscription.operationGeneration != sendGeneration {
      subscription.operationID = UUID().uuidString.lowercased()
      subscription.operationGeneration = sendGeneration
      subscription.requestedV2Seq = subscription.lastAppliedV2Seq
      subscription.writtenGeneration = nil
      subscription.acknowledgedGeneration = nil
      subscription.acknowledgedWatermark = nil
      conversationSubscription = subscription
    }
    guard subscription.writtenGeneration != sendGeneration,
      let operationID = subscription.operationID
    else { return }
    let frame = MobileV2WsClientFrame.subscribeConversation(
      id: operationID,
      agentId: subscription.agentID,
      conversationId: subscription.conversationID,
      sinceV2Seq: subscription.requestedV2Seq
    )
    try await sendV2(frame, task: task, generation: sendGeneration)
    guard var current = conversationSubscription,
      current.operationGeneration == sendGeneration,
      current.operationID == operationID
    else { return }
    current.writtenGeneration = sendGeneration
    conversationSubscription = current
    let waiters = subscriptionWriteWaiters
    subscriptionWriteWaiters.removeAll()
    for waiter in waiters { waiter.resume() }
  }

  private func resumeHelloWaiters() {
    let waiters = helloWaiters
    helloWaiters.removeAll()
    for waiter in waiters { waiter.resume() }
  }

  private func advanceV2ReadinessIfPossible() {
    guard isV2ConversationReady else { return }
    reconnectAttempt = 0
    let waiters = readinessWaiters
    readinessWaiters.removeAll()
    for waiter in waiters { waiter.resume() }
    scheduleV2Flush()
  }

  private func isV2CorrelationCandidate(_ frame: MobileV2SequencedFrame) -> Bool {
    candidateHasRetainedTarget(frame)
  }

  private func candidateHasRetainedTarget(_ frame: MobileV2SequencedFrame) -> Bool {
    switch frame {
    case let .accepted(id, _, _, _, _, _, _, _, _, _, _),
      let .inputAccepted(id, _, _, _, _),
      let .inputUpdated(id, _, _, _, _),
      let .inputRemoved(id, _, _, _, _),
      let .queueResumed(id?, _, _, _, _, _):
      return pendingV2Commands[id] != nil
    case let .done(_, _, _, runID, _, _),
      let .error(_, _, _, runID, _, _, _, _):
      return pendingV2Cancels[runID] != nil
    case .event, .inputFailed, .inputDelivered, .queuePaused, .queueResumed(nil, _, _, _, _, _):
      return false
    }
  }

  private func settleV2CandidatesForCurrentDurableCursor() {
    guard let subscription = conversationSubscription else { return }
    settleV2Candidates(
      through: subscription.lastAppliedV2Seq,
      conversationID: subscription.conversationID
    )
  }

  private func settleV2Candidates(through seq: Int, conversationID: String) {
    var retained: [MobileV2SequencedFrame] = []
    for candidate in v2CorrelationCandidates {
      guard candidate.conversationId == conversationID, candidate.v2Seq <= seq else {
        retained.append(candidate)
        continue
      }
      if settleV2Candidate(candidate) == false, candidateHasRetainedTarget(candidate) {
        retained.append(candidate)
      }
    }
    v2CorrelationCandidates = retained
  }

  @discardableResult
  private func settleV2Candidate(_ frame: MobileV2SequencedFrame) -> Bool {
    switch frame {
    case let .accepted(id, conversationID, _, runID, _, _, _, _, _, _, _):
      return settleV2Command(id: id, conversationID: conversationID) { expected in
        expected == .accepted(runID: runID) && id == runID
      }
    case let .inputAccepted(id, conversationID, _, _, input):
      return settleV2Command(id: id, conversationID: conversationID) { expected in
        guard case let .inputAccepted(inputID, behavior, targetRunID) = expected else {
          return false
        }
        let kind: MobileV2PendingInputKind = behavior == .steer ? .steer : .followUp
        guard input.inputId == inputID, input.kind == kind else { return false }
        switch behavior {
        case .steer:
          return input.targetTurnId == targetRunID
        case .followUp:
          return true
        }
      }
    case let .inputUpdated(id, conversationID, _, _, input):
      return settleV2Command(id: id, conversationID: conversationID) { expected in
        guard case let .inputUpdated(inputID, revision) = expected else { return false }
        return input.inputId == inputID && input.revision > revision
      }
    case let .inputRemoved(id, conversationID, _, _, input):
      return settleV2Command(id: id, conversationID: conversationID) { expected in
        guard case let .inputRemoved(inputID, revision) = expected else { return false }
        return input.inputId == inputID && input.revision > revision && input.state == .removed
      }
    case let .queueResumed(id?, conversationID, _, queueRevision, queuePaused, _):
      return settleV2Command(id: id, conversationID: conversationID) { expected in
        guard case let .queueResumed(revision) = expected else { return false }
        return queuePaused == false && queueRevision > revision
      }
    case let .done(_, _, _, runID, _, _),
      let .error(_, _, _, runID, _, _, _, _):
      guard var pending = pendingV2Cancels[runID], pending.writtenGeneration != nil else {
        return false
      }
      if pending.writeWaiters.isEmpty {
        pendingV2Cancels[runID] = nil
        pendingV2CancelOrder.removeAll { $0 == runID }
      } else {
        pending.isCorrelated = true
        pendingV2Cancels[runID] = pending
      }
      return true
    case .event, .inputFailed, .inputDelivered, .queuePaused, .queueResumed(nil, _, _, _, _, _):
      return false
    }
  }

  private func settleV2Command(
    id: String,
    conversationID: String,
    matches: (V2ExpectedResponse) -> Bool
  ) -> Bool {
    guard var pending = pendingV2Commands[id],
      pending.conversationID == conversationID,
      pending.writtenGeneration != nil,
      matches(pending.expected)
    else { return false }
    if pending.writeWaiters.isEmpty {
      retireV2Command(id: id, pending: pending)
    } else {
      pending.isCorrelated = true
      pendingV2Commands[id] = pending
    }
    return true
  }

  private func settleAcknowledgedV2Rejections() {
    var retained: [MobileV2ControlFrame] = []
    for frame in acknowledgedV2Rejections {
      guard case let .commandRejected(id, conversationID, _, _, _, _) = frame else {
        continue
      }
      guard var pending = pendingV2Commands[id] else {
        continue
      }
      guard pending.writtenGeneration != nil else {
        retained.append(frame)
        continue
      }
      guard conversationID == pending.conversationID else { continue }
      if pending.writeWaiters.isEmpty {
        retireV2Command(id: id, pending: pending)
      } else {
        pending.isCorrelated = true
        pendingV2Commands[id] = pending
      }
    }
    acknowledgedV2Rejections = retained
  }

  private func retireV2Command(id: String, pending: PendingV2Command) {
    settledV2Commands[id] = SettledV2Command(
      frame: pending.frame,
      conversationID: pending.conversationID,
      expected: pending.expected
    )
    pendingV2Commands[id] = nil
    pendingV2CommandOrder.removeAll { $0 == id }
  }

  private func isCurrentSocket(
    _ task: any WebSocketTasking,
    generation expectedGeneration: Int
  ) -> Bool {
    guard expectedGeneration == generation,
      state != .detached,
      streamFinished == false,
      let current = socket
    else { return false }
    return current === task
  }

  private func resetV2WireState() {
    guard var subscription = conversationSubscription else { return }
    subscription.operationID = nil
    subscription.operationGeneration = nil
    subscription.writtenGeneration = nil
    subscription.acknowledgedGeneration = nil
    subscription.acknowledgedWatermark = nil
    conversationSubscription = subscription
  }

  private func transition(to next: ChatTransportState) {
    state = next
    continuation.yield(.state(next))
  }

  private func finish(throwing error: any Error, generation failedGeneration: Int) {
    guard failedGeneration == generation, streamFinished == false else { return }
    helloTimeoutTask?.cancel()
    helloTimeoutTask = nil
    socket?.cancel(with: .goingAway, reason: nil)
    socket = nil
    clearAllTurns()
    failAndClearV2State(error: error)
    streamFinished = true
    continuation.finish(throwing: error)
  }

  private func requireReusableStream() throws {
    guard state != .detached else {
      throw GatewayError.transport("Chat connection is detached")
    }
    guard streamFinished == false else {
      throw GatewayError.transport("Chat connection stream is finished")
    }
  }

  private func prepareForSocketReplacement() {
    if selection == .v1 {
      clearAllTurns()
    } else {
      helloTimeoutTask?.cancel()
      helloTimeoutTask = nil
      helloAcknowledgedGeneration = nil
      v2FlushGeneration = nil
      v2FlushRequested = false
      resetV2WireState()
    }
    guard let socket else { return }
    generation += 1
    socket.cancel(with: .goingAway, reason: nil)
    self.socket = nil
  }

  private func registerTurn(
    id: String,
    agentID: String,
    conversationID: String,
    sinceSeq: Int,
    capable: Bool,
    operationGeneration: Int
  ) {
    if turnSubscriptions[id] == nil {
      turnSubscriptionOrder.append(id)
    }
    turnSubscriptions[id] = TurnSubscription(
      agentID: agentID,
      conversationID: conversationID,
      sinceSeq: sinceSeq,
      capable: capable,
      operationGeneration: operationGeneration
    )
  }

  private func clearTurn(id: String, ifOwnedBy operationGeneration: Int) {
    guard turnSubscriptions[id]?.operationGeneration == operationGeneration else { return }
    turnSubscriptions[id] = nil
    turnSubscriptionOrder.removeAll { $0 == id }
  }

  private func clearAllTurns() {
    turnOperationGeneration += 1
    turnSubscriptions.removeAll()
    turnSubscriptionOrder.removeAll()
    conversationSubscriptions.removeAll()
    conversationSubscriptionOrder.removeAll()
  }

  private func registerConversation(agentID: String, conversationID: String) {
    if conversationSubscriptions[conversationID] == nil {
      conversationSubscriptionOrder.append(conversationID)
    }
    conversationSubscriptions[conversationID] = agentID
  }

  private func clearConversation(conversationID: String) {
    conversationSubscriptions[conversationID] = nil
    conversationSubscriptionOrder.removeAll { $0 == conversationID }
  }

  private func replayTurnSubscriptions() async throws {
    // Conversation subscriptions first: the fresh socket must be watching
    // before any turn traffic resumes over it.
    for conversationID in conversationSubscriptionOrder {
      guard let agentID = conversationSubscriptions[conversationID] else { continue }
      try await send(
        .subscribe(
          id: UUID().uuidString.lowercased(),
          agentId: agentID,
          conversationId: conversationID
        )
      )
    }
    for id in turnSubscriptionOrder {
      guard let subscription = turnSubscriptions[id] else { continue }
      if var current = turnSubscriptions[id],
        current.operationGeneration == subscription.operationGeneration
      {
        current.capable = true
        turnSubscriptions[id] = current
      }
      try await send(
        .resume(
          id: id,
          agentId: subscription.agentID,
          conversationId: subscription.conversationID,
          sinceSeq: subscription.sinceSeq
        )
      )
    }
  }

  private func detachProbe(task: any WebSocketTasking, generation probeGeneration: Int) {
    guard probeGeneration == generation else {
      task.cancel(with: .goingAway, reason: nil)
      return
    }
    detachNow()
  }

  private func detachNow() {
    guard state != .detached else { return }
    generation += 1
    helloTimeoutTask?.cancel()
    helloTimeoutTask = nil
    transition(to: .detached)
    socket?.cancel(with: .goingAway, reason: nil)
    socket = nil
    clearAllTurns()
    failAndClearV2State(
      error: GatewayError.transport("Chat connection is detached")
    )
    if streamFinished == false {
      streamFinished = true
      continuation.finish()
    }
  }

  private func failAndClearV2State(error: any Error) {
    let hello = helloWaiters
    helloWaiters.removeAll()
    let subscriptions = subscriptionWriteWaiters
    subscriptionWriteWaiters.removeAll()
    let readiness = readinessWaiters
    readinessWaiters.removeAll()
    let commandWaiters = pendingV2Commands.values.flatMap(\.writeWaiters)
    let answerWaiters = pendingV2Answers.flatMap(\.writeWaiters)
    let cancelWaiters = pendingV2Cancels.values.flatMap(\.writeWaiters)

    conversationSubscription = nil
    helloAcknowledgedGeneration = nil
    pendingV2Commands.removeAll()
    pendingV2CommandOrder.removeAll()
    settledV2Commands.removeAll()
    pendingV2Answers.removeAll()
    pendingV2Cancels.removeAll()
    pendingV2CancelOrder.removeAll()
    v2CorrelationCandidates.removeAll()
    v2RejectionCandidates.removeAll()
    acknowledgedV2Rejections.removeAll()
    v2FlushGeneration = nil
    v2FlushRequested = false

    for waiter in hello { waiter.resume(throwing: error) }
    for waiter in subscriptions { waiter.resume(throwing: error) }
    for waiter in readiness { waiter.resume(throwing: error) }
    for waiter in commandWaiters { waiter.resume(throwing: error) }
    for waiter in answerWaiters { waiter.resume(throwing: error) }
    for waiter in cancelWaiters { waiter.resume(throwing: error) }
  }
}

extension MobileWSServerFrame {
  fileprivate var id: String {
    switch self {
    case .accepted(let id, _, _, _, _, _, _, _, _),
      .event(let id, _, _, _),
      .done(let id, _, _, _),
      .error(let id, _, _, _, _, _, _):
      return id
    }
  }

  fileprivate var isAccepted: Bool {
    if case .accepted = self { return true }
    return false
  }

  /// Only an `accepted` frame carries a non-optional conversation id, which is
  /// exactly the frame a conversation subscription can register a turn from.
  fileprivate var acceptedConversationID: String? {
    if case .accepted(_, let conversationId, _, _, _, _, _, _, _) = self {
      return conversationId
    }
    return nil
  }

  fileprivate var seq: Int? {
    switch self {
    case .accepted(_, _, _, _, _, let seq, _, _, _):
      return seq
    case .event(_, _, let seq, _),
      .done(_, _, let seq, _),
      .error(_, _, let seq, _, _, _, _):
      return seq
    }
  }

  fileprivate var isTerminal: Bool {
    switch self {
    case .done, .error:
      return true
    case .accepted, .event:
      return false
    }
  }
}
