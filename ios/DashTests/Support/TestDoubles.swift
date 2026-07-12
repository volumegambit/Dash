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
