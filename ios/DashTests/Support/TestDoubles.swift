import Foundation

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
