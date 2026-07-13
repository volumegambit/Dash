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

private final class URLSessionWebSocketSession: WebSocketSessioning, @unchecked Sendable {
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
}

actor ChatConnection {
  private static let reconnectLimit = 5

  private struct TurnSubscription: Sendable {
    let agentID: String
    let conversationID: String
    var sinceSeq: Int
    var capable: Bool
    let operationGeneration: Int
  }

  private let endpoint: ConnectionEndpoint
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
  private var state: ChatTransportState = .idle
  private var streamFinished = false

  init(
    endpoint: ConnectionEndpoint,
    session: any WebSocketSessioning = URLSessionWebSocketSession(),
    clock: any AppClock = SystemAppClock()
  ) {
    self.endpoint = endpoint
    self.session = session
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
  }

  func sendTurn(
    id: String,
    agentID: String,
    conversationID: String,
    text: String,
    images: [MessageImage]
  ) async throws {
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
          images: images.isEmpty ? nil : images
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

  func answer(turnID: String, questionID: String, answer: String) async throws {
    try await send(.answer(id: turnID, questionId: questionID, answer: answer))
  }

  func cancel(turnID: String) async throws {
    try await send(.cancel(id: turnID))
  }

  func detach() {
    detachNow()
  }

  func suspend() {
    guard state != .detached else { return }
    generation += 1
    socket?.cancel(with: .goingAway, reason: nil)
    socket = nil
    clearAllTurns()
    reconnectAttempt = 0
    transition(to: .idle)
  }

  func probeAuthentication() async throws {
    try requireReusableStream()
    prepareForSocketReplacement()
    generation += 1
    let probeGeneration = generation
    transition(to: .connecting)
    let task = session.webSocketTask(with: try endpoint.chatRequest())
    socket = task
    task.resume()
    transition(to: .connected)
    defer { detachProbe(task: task, generation: probeGeneration) }

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
      _ = try decodedFrame(from: message)
    }
  }

  private func startSocket() throws {
    generation += 1
    let currentGeneration = generation
    transition(to: .connecting)
    let task = session.webSocketTask(with: try endpoint.chatRequest())
    socket = task
    task.resume()
    transition(to: .connected)
    Task { [weak self] in
      await self?.receiveLoop(task: task, generation: currentGeneration)
    }
  }

  private func receiveLoop(task: any WebSocketTasking, generation loopGeneration: Int) async {
    do {
      while loopGeneration == generation, state != .detached {
        let message = try await task.receive()
        guard loopGeneration == generation, state != .detached else { return }
        let frame = try decodedFrame(from: message)
        guard var subscription = turnSubscriptions[frame.id] else { continue }
        let capable = subscription.capable || frame.isAccepted
        _ = try validatedFrame(frame, capable: capable)
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
      finish(throwing: .updateRequired, generation: loopGeneration)
    } catch is ContractValidationError {
      finish(throwing: .updateRequired, generation: loopGeneration)
    } catch let error as GatewayError {
      finish(throwing: error, generation: loopGeneration)
    } catch {
      await handleReceiveFailure(error, task: task, generation: loopGeneration)
    }
  }

  private func handleReceiveFailure(
    _ error: Error,
    task: any WebSocketTasking,
    generation failedGeneration: Int
  ) async {
    guard failedGeneration == generation, state != .detached else { return }
    let close = await task.peerClose
    guard failedGeneration == generation, state != .detached else { return }
    if let close, let mapped = closeError(close) {
      finish(throwing: mapped, generation: failedGeneration)
      return
    }
    guard reconnectAttempt < Self.reconnectLimit else {
      finish(
        throwing: .transport(error.localizedDescription),
        generation: failedGeneration
      )
      return
    }

    reconnectAttempt += 1
    let attempt = reconnectAttempt
    transition(to: .reconnecting(attempt: attempt))
    do {
      try await clock.sleep(for: .seconds(min(30, 1 << min(attempt - 1, 4))))
    } catch {
      guard failedGeneration == generation, state != .detached else { return }
      finish(throwing: .transport(error.localizedDescription), generation: failedGeneration)
      return
    }
    guard failedGeneration == generation, state != .detached else { return }
    guard let currentSocket = socket, currentSocket === task else { return }
    task.cancel(with: .goingAway, reason: nil)
    socket = nil
    do {
      try startSocket()
    } catch {
      finish(throwing: .transport(error.localizedDescription), generation: generation)
      return
    }
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

  private func send(_ frame: MobileWSClientFrame) async throws {
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

  private func validatedFrame(
    _ frame: MobileWSServerFrame,
    capable: Bool
  ) throws -> CapableServerFrame? {
    guard capable else { return nil }
    return try CapableServerFrame.validating(frame)
  }

  private func closeError(_ close: WebSocketCloseInfo) -> GatewayError? {
    switch close.code {
    case 4001, 4401:
      return .unauthorized
    case 4429:
      return .rateLimited(retryAfter: retryAfter(from: close.reason))
    default:
      return nil
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

  private func transition(to next: ChatTransportState) {
    state = next
    continuation.yield(.state(next))
  }

  private func finish(throwing error: GatewayError, generation failedGeneration: Int) {
    guard failedGeneration == generation, streamFinished == false else { return }
    socket?.cancel(with: .goingAway, reason: nil)
    socket = nil
    clearAllTurns()
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
    clearAllTurns()
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
  }

  private func replayTurnSubscriptions() async throws {
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
    transition(to: .detached)
    socket?.cancel(with: .goingAway, reason: nil)
    socket = nil
    clearAllTurns()
    if streamFinished == false {
      streamFinished = true
      continuation.finish()
    }
  }
}

extension MobileWSServerFrame {
  fileprivate var id: String {
    switch self {
    case .accepted(let id, _, _, _, _, _),
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

  fileprivate var seq: Int? {
    switch self {
    case .accepted(_, _, _, _, _, let seq):
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
