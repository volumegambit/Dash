import Foundation
import Network

@testable import Dash

actor TestAppClock: AppClock {
  private var current: Date
  private(set) var sleeps: [Duration] = []

  init(now: Date) {
    current = now
  }

  func now() async -> Date {
    current
  }

  func sleep(for duration: Duration) async throws {
    sleeps.append(duration)
  }

  func setNow(_ value: Date) {
    current = value
  }
}

private final class URLProtocolStubState: @unchecked Sendable {
  struct Response {
    let status: Int
    let headers: [String: String]
    let chunks: [Data]
    let failure: URLError?
    let holdOpen: Bool
  }

  private let lock = NSLock()
  private var responses: [Response] = []
  private var recordedRequests: [URLRequest] = []
  private var recordedStopLoadingCount = 0

  func reset() {
    lock.lock()
    defer { lock.unlock() }
    responses.removeAll()
    recordedRequests.removeAll()
    recordedStopLoadingCount = 0
  }

  func enqueue(_ response: Response) {
    lock.lock()
    defer { lock.unlock() }
    responses.append(response)
  }

  func dequeue() -> Response? {
    lock.lock()
    defer { lock.unlock() }
    guard responses.isEmpty == false else { return nil }
    return responses.removeFirst()
  }

  func record(_ request: URLRequest) {
    lock.lock()
    defer { lock.unlock() }
    recordedRequests.append(request)
  }

  func recordStopLoading() {
    lock.lock()
    defer { lock.unlock() }
    recordedStopLoadingCount += 1
  }

  var requests: [URLRequest] {
    lock.lock()
    defer { lock.unlock() }
    return recordedRequests
  }

  var stopLoadingCount: Int {
    lock.lock()
    defer { lock.unlock() }
    return recordedStopLoadingCount
  }
}

final class URLProtocolStub: URLProtocol, @unchecked Sendable {
  private static let state = URLProtocolStubState()

  static var requests: [URLRequest] {
    state.requests
  }

  static var stopLoadingCount: Int {
    state.stopLoadingCount
  }

  static func reset() {
    state.reset()
  }

  static func enqueue(
    status: Int,
    fixture: String,
    headers: [String: String] = [:],
    holdOpen: Bool = false
  ) throws {
    enqueue(
      status: status,
      data: try FixtureLoader.data(fixture),
      headers: headers,
      holdOpen: holdOpen
    )
  }

  static func enqueue(
    status: Int,
    data: Data = Data(),
    headers: [String: String] = [:],
    chunks: [Data]? = nil,
    holdOpen: Bool = false
  ) {
    state.enqueue(
      .init(
        status: status,
        headers: headers,
        chunks: chunks ?? (data.isEmpty ? [] : [data]),
        failure: nil,
        holdOpen: holdOpen
      )
    )
  }

  static func enqueue(failure: URLError) {
    state.enqueue(
      .init(status: 0, headers: [:], chunks: [], failure: failure, holdOpen: false)
    )
  }

  override class func canInit(with request: URLRequest) -> Bool {
    true
  }

  override class func canonicalRequest(for request: URLRequest) -> URLRequest {
    request
  }

  override func startLoading() {
    Self.state.record(requestWithCapturedBody(request))
    guard let response = Self.state.dequeue() else {
      client?.urlProtocol(self, didFailWithError: URLError(.resourceUnavailable))
      return
    }
    if let failure = response.failure {
      client?.urlProtocol(self, didFailWithError: failure)
      return
    }
    guard let url = request.url,
      let httpResponse = HTTPURLResponse(
        url: url,
        statusCode: response.status,
        httpVersion: "HTTP/1.1",
        headerFields: response.headers
      )
    else {
      client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
      return
    }
    client?.urlProtocol(self, didReceive: httpResponse, cacheStoragePolicy: .notAllowed)
    for chunk in response.chunks {
      client?.urlProtocol(self, didLoad: chunk)
    }
    if response.holdOpen == false {
      client?.urlProtocolDidFinishLoading(self)
    }
  }

  override func stopLoading() {
    Self.state.recordStopLoading()
  }

  private func requestWithCapturedBody(_ request: URLRequest) -> URLRequest {
    guard request.httpBody == nil, let stream = request.httpBodyStream else { return request }
    stream.open()
    defer { stream.close() }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 4_096)
    while stream.hasBytesAvailable {
      let count = stream.read(&buffer, maxLength: buffer.count)
      guard count > 0 else { break }
      data.append(buffer, count: count)
    }
    var captured = request
    captured.httpBody = data
    return captured
  }
}

func testURLSession() -> URLSession {
  let configuration = URLSessionConfiguration.ephemeral
  configuration.protocolClasses = [URLProtocolStub.self]
  return URLSession(configuration: configuration)
}

private actor FakeWebSocketTaskState {
  private struct HeldSend {
    let message: URLSessionWebSocketTask.Message
    let continuation: CheckedContinuation<Void, Error>
  }

  private enum ReceiveStep {
    case message(URLSessionWebSocketTask.Message)
    case failure(any Error)
  }

  private var sentMessages: [URLSessionWebSocketTask.Message] = []
  private var shouldHoldNextSend = false
  private var heldSends: [HeldSend] = []
  private var heldSendWaiters: [CheckedContinuation<Void, Never>] = []
  private var receives: [ReceiveStep] = []
  private var receiveWaiters: [CheckedContinuation<URLSessionWebSocketTask.Message, Error>] = []
  private var sentWaiters: [CheckedContinuation<URLSessionWebSocketTask.Message, Never>] = []
  private var scriptedPeerClose: WebSocketCloseInfo?
  private var shouldHoldNextPeerClose = false
  private var peerCloseWaiter: CheckedContinuation<WebSocketCloseInfo?, Never>?
  private var heldPeerCloseWaiters: [CheckedContinuation<Void, Never>] = []

  func recordSent(_ message: URLSessionWebSocketTask.Message) {
    sentMessages.append(message)
    if sentWaiters.isEmpty == false {
      sentWaiters.removeFirst().resume(returning: message)
    }
  }

  func holdNextSend() {
    shouldHoldNextSend = true
  }

  func send(_ message: URLSessionWebSocketTask.Message) async throws {
    guard shouldHoldNextSend else {
      recordSent(message)
      return
    }
    shouldHoldNextSend = false
    try await withCheckedThrowingContinuation { continuation in
      heldSends.append(HeldSend(message: message, continuation: continuation))
      let waiters = heldSendWaiters
      heldSendWaiters.removeAll()
      for waiter in waiters {
        waiter.resume()
      }
    }
  }

  func waitForHeldSend() async {
    guard heldSends.isEmpty else { return }
    await withCheckedContinuation { continuation in
      heldSendWaiters.append(continuation)
    }
  }

  func resolveHeldSend(error: (any Error)?) {
    guard heldSends.isEmpty == false else { return }
    let held = heldSends.removeFirst()
    if let error {
      held.continuation.resume(throwing: error)
    } else {
      recordSent(held.message)
      held.continuation.resume()
    }
  }

  func allSentMessages() -> [URLSessionWebSocketTask.Message] {
    sentMessages
  }

  func nextSentMessage() async -> URLSessionWebSocketTask.Message {
    if let message = sentMessages.last {
      return message
    }
    return await withCheckedContinuation { continuation in
      sentWaiters.append(continuation)
    }
  }

  func enqueue(_ message: URLSessionWebSocketTask.Message) {
    deliver(.message(message))
  }

  func fail(_ error: any Error, peerClose: WebSocketCloseInfo?) {
    scriptedPeerClose = peerClose
    deliver(.failure(error))
  }

  func receive() async throws -> URLSessionWebSocketTask.Message {
    if receives.isEmpty == false {
      return try value(from: receives.removeFirst())
    }
    return try await withCheckedThrowingContinuation { continuation in
      receiveWaiters.append(continuation)
    }
  }

  func holdNextPeerClose() {
    shouldHoldNextPeerClose = true
  }

  func peerClose() async -> WebSocketCloseInfo? {
    guard shouldHoldNextPeerClose else { return scriptedPeerClose }
    shouldHoldNextPeerClose = false
    return await withCheckedContinuation { continuation in
      peerCloseWaiter = continuation
      let waiters = heldPeerCloseWaiters
      heldPeerCloseWaiters.removeAll()
      for waiter in waiters {
        waiter.resume()
      }
    }
  }

  func waitForHeldPeerClose() async {
    guard peerCloseWaiter == nil else { return }
    await withCheckedContinuation { continuation in
      heldPeerCloseWaiters.append(continuation)
    }
  }

  func releasePeerClose() {
    peerCloseWaiter?.resume(returning: scriptedPeerClose)
    peerCloseWaiter = nil
  }

  private func deliver(_ step: ReceiveStep) {
    guard receiveWaiters.isEmpty == false else {
      receives.append(step)
      return
    }
    let waiter = receiveWaiters.removeFirst()
    switch step {
    case .message(let message):
      waiter.resume(returning: message)
    case .failure(let error):
      waiter.resume(throwing: error)
    }
  }

  private func value(
    from step: ReceiveStep
  ) throws -> URLSessionWebSocketTask.Message {
    switch step {
    case .message(let message):
      return message
    case .failure(let error):
      throw error
    }
  }
}

final class FakeWebSocketTask: WebSocketTasking, @unchecked Sendable {
  private let state = FakeWebSocketTaskState()
  private let lock = NSLock()
  private var recordedCloseCode: URLSessionWebSocketTask.CloseCode?
  private var recordedResumeCount = 0

  func resume() {
    lock.lock()
    recordedResumeCount += 1
    lock.unlock()
  }

  func send(_ message: URLSessionWebSocketTask.Message) async throws {
    try await state.send(message)
  }

  func receive() async throws -> URLSessionWebSocketTask.Message {
    try await state.receive()
  }

  func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
    lock.lock()
    if recordedCloseCode == nil {
      recordedCloseCode = closeCode
    }
    lock.unlock()
    Task {
      await state.fail(CancellationError(), peerClose: nil)
    }
  }

  var peerClose: WebSocketCloseInfo? {
    get async { await state.peerClose() }
  }

  var sentFrames: [MobileWSClientFrame] {
    get async {
      await state.allSentMessages().compactMap(decodeClientFrame)
    }
  }

  var closeCode: URLSessionWebSocketTask.CloseCode? {
    get async {
      lock.withLock { recordedCloseCode }
    }
  }

  var resumeCount: Int {
    get async {
      lock.withLock { recordedResumeCount }
    }
  }

  func enqueue(_ message: URLSessionWebSocketTask.Message) async {
    await state.enqueue(message)
  }

  func holdNextSend() async {
    await state.holdNextSend()
  }

  func waitForHeldSend() async {
    await state.waitForHeldSend()
  }

  func failHeldSend(error: any Error = URLError(.networkConnectionLost)) async {
    await state.resolveHeldSend(error: error)
  }

  func succeedHeldSend() async {
    await state.resolveHeldSend(error: nil)
  }

  func holdNextPeerClose() async {
    await state.holdNextPeerClose()
  }

  func waitForHeldPeerClose() async {
    await state.waitForHeldPeerClose()
  }

  func releasePeerClose() async {
    await state.releasePeerClose()
  }

  func fail(
    peerClose: WebSocketCloseInfo? = nil,
    error: URLError = URLError(.networkConnectionLost)
  ) async {
    await state.fail(error, peerClose: peerClose)
  }

  func nextSentFrame() async -> MobileWSClientFrame {
    let message = await state.nextSentMessage()
    return decodeClientFrame(message)!
  }

  func waitForClose() async -> URLSessionWebSocketTask.CloseCode? {
    while await closeCode == nil {
      await Task.yield()
    }
    return await closeCode
  }

  private func decodeClientFrame(
    _ message: URLSessionWebSocketTask.Message
  ) -> MobileWSClientFrame? {
    let data: Data
    switch message {
    case .string(let value):
      data = Data(value.utf8)
    case .data(let value):
      data = value
    @unknown default:
      return nil
    }
    return try? ContractCoding.decoder().decode(MobileWSClientFrame.self, from: data)
  }
}

private final class FakeWebSocketSessionState: @unchecked Sendable {
  private let lock = NSLock()
  private var tasks: [FakeWebSocketTask]
  private var recordedRequests: [URLRequest] = []

  init(tasks: [FakeWebSocketTask]) {
    self.tasks = tasks
  }

  func nextTask(for request: URLRequest) -> FakeWebSocketTask {
    lock.lock()
    defer { lock.unlock() }
    recordedRequests.append(request)
    precondition(tasks.isEmpty == false, "FakeWebSocketSession has no scripted task")
    return tasks.removeFirst()
  }

  var requests: [URLRequest] {
    lock.lock()
    defer { lock.unlock() }
    return recordedRequests
  }
}

final class FakeWebSocketSession: WebSocketSessioning, @unchecked Sendable {
  private let state: FakeWebSocketSessionState

  init(tasks: [FakeWebSocketTask]) {
    state = FakeWebSocketSessionState(tasks: tasks)
  }

  var requests: [URLRequest] {
    state.requests
  }

  func webSocketTask(with request: URLRequest) -> any WebSocketTasking {
    state.nextTask(for: request)
  }
}

actor TestGate {
  private var isReleased = false
  private var waitCallCount = 0
  private var waiters: [CheckedContinuation<Void, Never>] = []
  private var waitObservers: [(count: Int, continuation: CheckedContinuation<Void, Never>)] = []

  func wait() async {
    waitCallCount += 1
    let ready = waitObservers.filter { $0.count <= waitCallCount }
    waitObservers.removeAll { $0.count <= waitCallCount }
    for observer in ready {
      observer.continuation.resume()
    }
    guard isReleased == false else { return }
    await withCheckedContinuation { continuation in
      waiters.append(continuation)
    }
  }

  func waitUntilWaiting(_ count: Int = 1) async {
    guard waitCallCount < count else { return }
    await withCheckedContinuation { continuation in
      waitObservers.append((count: count, continuation: continuation))
    }
  }

  func release() {
    isReleased = true
    let pending = waiters
    waiters.removeAll()
    for waiter in pending {
      waiter.resume()
    }
  }
}

enum FakeSyncResult<Value: Sendable>: Sendable {
  case success(Value)
  case failure(GatewayError)
}

private struct GatedSyncResult<Value: Sendable>: Sendable {
  let result: FakeSyncResult<Value>
  let gate: TestGate?
}

actor FakeConversationSyncAPI: ConversationSyncAPI {
  struct ConversationListCall: Equatable, Sendable {
    let agentID: String?
    let limit: Int
    let cursor: String?
  }

  struct MessageListCall: Equatable, Sendable {
    let conversationID: String
    let limit: Int
    let before: String?
  }

  struct ReplayCall: Equatable, Sendable {
    let agentID: String
    let conversationID: String
    let sinceSeq: Int
  }

  private var agentResults: [FakeSyncResult<[RegisteredAgentDTO]>] = []
  private var conversationPageResults: [GatedSyncResult<ConversationPageDTO>] = []
  private var conversationResults: [String: [GatedSyncResult<ConversationSummaryDTO>]] = [:]
  private var messageResults: [String: [GatedSyncResult<ConversationMessagePageDTO>]] = [:]
  private var replayResults: [FakeSyncResult<ReplayPageDTO>] = []
  private var createResults: [FakeSyncResult<ConversationSummaryDTO>] = []
  private var conversationGate: TestGate?

  private(set) var conversationListCalls: [ConversationListCall] = []
  private(set) var agentListCallCount = 0
  private(set) var conversationCalls: [String] = []
  private(set) var messageListCalls: [MessageListCall] = []
  private(set) var replayCalls: [ReplayCall] = []
  private(set) var createRequests: [CreateConversationRequest] = []

  func enqueueAgents(_ result: FakeSyncResult<[RegisteredAgentDTO]>) {
    agentResults.append(result)
  }

  func enqueueConversationPage(
    _ result: FakeSyncResult<ConversationPageDTO>,
    waitingOn gate: TestGate? = nil
  ) {
    conversationPageResults.append(.init(result: result, gate: gate))
  }

  func enqueueConversation(
    id: String,
    result: FakeSyncResult<ConversationSummaryDTO>,
    waitingOn gate: TestGate? = nil
  ) {
    conversationResults[id, default: []].append(.init(result: result, gate: gate))
  }

  func enqueueMessages(
    conversationID: String,
    result: FakeSyncResult<ConversationMessagePageDTO>,
    waitingOn gate: TestGate? = nil
  ) {
    messageResults[conversationID, default: []].append(.init(result: result, gate: gate))
  }

  func enqueueReplay(_ result: FakeSyncResult<ReplayPageDTO>) {
    replayResults.append(result)
  }

  func enqueueCreate(_ result: FakeSyncResult<ConversationSummaryDTO>) {
    createResults.append(result)
  }

  func holdConversationPages(on gate: TestGate) {
    conversationGate = gate
  }

  func listAgents() async throws -> [RegisteredAgentDTO] {
    agentListCallCount += 1
    guard agentResults.isEmpty == false else { return [] }
    return try resolve(agentResults.removeFirst())
  }

  func conversations(
    agentId: String?,
    limit: Int,
    cursor: String?
  ) async throws -> ConversationPageDTO {
    conversationListCalls.append(.init(agentID: agentId, limit: limit, cursor: cursor))
    guard conversationPageResults.isEmpty == false else {
      return ConversationPageDTO(items: [], nextCursor: nil)
    }
    let scripted = conversationPageResults.removeFirst()
    if let gate = scripted.gate ?? conversationGate {
      await gate.wait()
    }
    return try resolve(scripted.result)
  }

  func conversation(id: String) async throws -> ConversationSummaryDTO {
    conversationCalls.append(id)
    guard var results = conversationResults[id], results.isEmpty == false else {
      throw GatewayError.notFound
    }
    let scripted = results.removeFirst()
    conversationResults[id] = results
    if let gate = scripted.gate {
      await gate.wait()
    }
    return try resolve(scripted.result)
  }

  func messages(
    conversationID: String,
    limit: Int,
    before: String?
  ) async throws -> ConversationMessagePageDTO {
    messageListCalls.append(
      .init(conversationID: conversationID, limit: limit, before: before)
    )
    guard var results = messageResults[conversationID], results.isEmpty == false else {
      return ConversationMessagePageDTO(items: [], nextCursor: nil, throughSeq: 0)
    }
    let scripted = results.removeFirst()
    messageResults[conversationID] = results
    if let gate = scripted.gate {
      await gate.wait()
    }
    return try resolve(scripted.result)
  }

  func replay(
    agentID: String,
    conversationID: String,
    sinceSeq: Int
  ) async throws -> ReplayPageDTO {
    replayCalls.append(
      .init(agentID: agentID, conversationID: conversationID, sinceSeq: sinceSeq)
    )
    guard replayResults.isEmpty == false else { return ReplayPageDTO(entries: []) }
    return try resolve(replayResults.removeFirst())
  }

  func createConversation(
    _ request: CreateConversationRequest
  ) async throws -> ConversationSummaryDTO {
    createRequests.append(request)
    guard createResults.isEmpty == false else {
      throw GatewayError.transport("No scripted create result")
    }
    return try resolve(createResults.removeFirst())
  }

  private func resolve<Value>(_ result: FakeSyncResult<Value>) throws -> Value {
    switch result {
    case .success(let value):
      return value
    case .failure(let error):
      throw error
    }
  }
}

final class FakeInvalidationSource: GatewayInvalidationStreaming, @unchecked Sendable {
  private let stream: AsyncThrowingStream<GatewayInvalidationEvent, Error>
  private let continuation: AsyncThrowingStream<GatewayInvalidationEvent, Error>.Continuation

  init() {
    let pair = AsyncThrowingStream<GatewayInvalidationEvent, Error>.makeStream()
    stream = pair.stream
    continuation = pair.continuation
  }

  func eventStream() async -> AsyncThrowingStream<GatewayInvalidationEvent, Error> {
    stream
  }

  func yield(_ event: GatewayInvalidationEvent) {
    continuation.yield(event)
  }

  func fail(_ error: GatewayError) {
    continuation.finish(throwing: error)
  }
}

final class FakeReachability: ReachabilityStreaming, @unchecked Sendable {
  private let stream: AsyncStream<ReachabilityStatus>
  private let continuation: AsyncStream<ReachabilityStatus>.Continuation

  init() {
    let pair = AsyncStream<ReachabilityStatus>.makeStream()
    stream = pair.stream
    continuation = pair.continuation
  }

  func statuses() -> AsyncStream<ReachabilityStatus> {
    stream
  }

  func yield(_ status: ReachabilityStatus) {
    continuation.yield(status)
  }
}

actor FakeConversationChat: ConversationChatting {
  enum Call: Equatable, Sendable {
    case connect
    case sendTurn(
      id: String,
      agentID: String,
      conversationID: String,
      text: String,
      images: [MessageImage]
    )
    case resume(turnID: String, agentID: String, conversationID: String, sinceSeq: Int)
    case suspend
    case shutdown
    case disconnect
  }

  private var connectResults: [FakeSyncResult<Void>] = []
  private var sendResults: [FakeSyncResult<Void>] = []
  private var resumeResults: [FakeSyncResult<Void>] = []
  private(set) var calls: [Call] = []

  func enqueueConnect(_ result: FakeSyncResult<Void>) {
    connectResults.append(result)
  }

  func enqueueSend(_ result: FakeSyncResult<Void>) {
    sendResults.append(result)
  }

  func enqueueResume(_ result: FakeSyncResult<Void>) {
    resumeResults.append(result)
  }

  func connect() async throws {
    calls.append(.connect)
    guard connectResults.isEmpty == false else { return }
    _ = try resolve(connectResults.removeFirst())
  }

  func sendTurn(
    id: String,
    agentID: String,
    conversationID: String,
    text: String,
    images: [MessageImage]
  ) async throws {
    calls.append(
      .sendTurn(
        id: id,
        agentID: agentID,
        conversationID: conversationID,
        text: text,
        images: images
      )
    )
    guard sendResults.isEmpty == false else { return }
    _ = try resolve(sendResults.removeFirst())
  }

  func resume(
    turnID: String,
    agentID: String,
    conversationID: String,
    sinceSeq: Int
  ) async throws {
    calls.append(
      .resume(
        turnID: turnID,
        agentID: agentID,
        conversationID: conversationID,
        sinceSeq: sinceSeq
      )
    )
    guard resumeResults.isEmpty == false else { return }
    _ = try resolve(resumeResults.removeFirst())
  }

  func suspend() async {
    calls.append(.suspend)
  }

  func shutdown() async {
    calls.append(.shutdown)
  }

  func disconnect() async {
    calls.append(.disconnect)
  }

  private func resolve<Value>(_ result: FakeSyncResult<Value>) throws -> Value {
    switch result {
    case .success(let value):
      return value
    case .failure(let error):
      throw error
    }
  }
}

final class FakeNetworkPathMonitor: NetworkPathMonitoring, @unchecked Sendable {
  private let lock = NSLock()
  private var handler: (@Sendable (NWPath) -> Void)?
  private var recordedStartCount = 0
  private var recordedCancelCount = 0

  var pathUpdateHandler: (@Sendable (NWPath) -> Void)? {
    get { lock.withLock { handler } }
    set { lock.withLock { handler = newValue } }
  }

  var startCount: Int {
    lock.withLock { recordedStartCount }
  }

  var cancelCount: Int {
    lock.withLock { recordedCancelCount }
  }

  func start(queue: DispatchQueue) {
    lock.withLock { recordedStartCount += 1 }
  }

  func cancel() {
    lock.withLock { recordedCancelCount += 1 }
  }
}
