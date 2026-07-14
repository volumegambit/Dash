import Foundation
import Testing

@testable import Dash

@Suite("SSE client", .serialized)
struct SSEClientTests {
  init() {
    URLProtocolStub.reset()
  }

  @Test("fragmented LF and CRLF bytes yield changed and deleted invalidations")
  func fragmentedInvalidations() async throws {
    let payload = """
      : keepalive\r
      \r
      event: conversation:changed\r
      data: {"type":"conversation:changed","conversationId":"conv-1","revision":2}\r
      \r
      event: conversation:deleted
      data: {"type":"conversation:deleted","conversationId":"conv-1","revision":3}

      """
    let data = Data((payload + "\n").utf8)
    URLProtocolStub.enqueue(status: 200, chunks: chunks(data, widths: [1, 2, 5, 3, 8, 1]))

    let result = await collect(from: makeSSEClient())

    #expect(
      result.events == [
        .conversationChanged(conversationID: "conv-1", revision: 2),
        .conversationDeleted(conversationID: "conv-1", revision: 3),
      ]
    )
    #expect(result.error != nil)
  }

  @Test("canonical changed and deleted fixtures use the same parser")
  func canonicalFixtures() async throws {
    try URLProtocolStub.enqueue(
      status: 200,
      fixture: "sse-conversation-changed.txt",
      headers: ["Content-Type": "text/event-stream"]
    )
    try URLProtocolStub.enqueue(
      status: 200,
      fixture: "sse-conversation-deleted.txt",
      headers: ["Content-Type": "text/event-stream"]
    )
    let client = makeSSEClient()

    let changed = await collect(from: client)
    let deleted = await collect(from: client)

    #expect(
      changed.events == [
        .conversationChanged(
          conversationID: "018f0f4a-5c42-7a8b-9c01-1234567890ab",
          revision: 2
        )
      ]
    )
    #expect(
      deleted.events == [
        .conversationDeleted(
          conversationID: "018f0f4a-5c42-7a8b-9c01-1234567890ab",
          revision: 3
        )
      ]
    )
  }

  @Test("comments and unknown events are ignored while multiline data joins with a newline")
  func multilineAndUnknownEvents() async {
    let payload = """
      : comment

      event: gateway:unknown
      data: this is deliberately not JSON

      event: conversation:changed
      data: {"type":"conversation:changed",
      data: "conversationId":"conv-2","revision":4}

      """
    URLProtocolStub.enqueue(status: 200, data: Data((payload + "\n").utf8))

    let result = await collect(from: makeSSEClient())

    #expect(
      result.events == [.conversationChanged(conversationID: "conv-2", revision: 4)]
    )
  }

  @Test("SSE uses the mobile event route with bearer and relay headers")
  func requestHeaders() async throws {
    try URLProtocolStub.enqueue(status: 200, fixture: "sse-conversation-changed.txt")

    _ = await collect(from: makeSSEClient(relay: true))

    let request = try #require(URLProtocolStub.requests.last)
    let url = try #require(request.url)
    let components = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false))
    #expect(request.httpMethod == "GET")
    #expect(components.percentEncodedPath == "/mobile/v1/events")
    #expect(request.value(forHTTPHeaderField: "Accept") == "text/event-stream")
    #expect(
      request.value(forHTTPHeaderField: "Authorization") == "Bearer management-test-token"
    )
    #expect(
      request.value(forHTTPHeaderField: "x-dash-relay-credential") == "relay-test-token"
    )
  }

  @Test("cancelling the consumer cancels the URLSession task")
  func cancellationStopsLoading() async throws {
    URLProtocolStub.enqueue(
      status: 200,
      headers: ["Content-Type": "text/event-stream"],
      holdOpen: true
    )
    let stream = await makeSSEClient().events()
    let consumer = Task {
      do {
        for try await _ in stream {}
      } catch {
        // Cancellation is the expected terminal condition.
      }
    }

    try await waitUntil { URLProtocolStub.requests.count == 1 }
    consumer.cancel()
    await consumer.value
    try await waitUntil { URLProtocolStub.stopLoadingCount > 0 }

    #expect(URLProtocolStub.stopLoadingCount > 0)
  }
}

private struct SSECollection {
  let events: [GatewayInvalidationEvent]
  let error: Error?
}

private func collect(from client: SSEClient) async -> SSECollection {
  let stream = await client.events()
  var events: [GatewayInvalidationEvent] = []
  do {
    for try await event in stream {
      events.append(event)
    }
    return .init(events: events, error: nil)
  } catch {
    return .init(events: events, error: error)
  }
}

private func makeSSEClient(relay: Bool = false) -> SSEClient {
  let secrets = ConnectionSecrets(
    managementToken: "management-test-token",
    chatToken: "chat-test-token",
    relayCredential: relay ? "relay-test-token" : nil
  )
  let profile = ConnectionProfile(
    id: UUID(),
    gatewayId: "gateway-01",
    publicKey: "public-key",
    label: "Test Gateway",
    host: "gateway.test",
    managementPort: relay ? 443 : 9400,
    chatPort: relay ? 443 : 9400,
    secure: true,
    mode: relay ? .relay : .lan,
    tlsCertificateSha256: relay
      ? nil
      : "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    createdAt: Date(timeIntervalSince1970: 0),
    lastSuccessfulSyncAt: nil
  )
  return SSEClient(
    endpoint: ConnectionEndpoint(profile: profile, secrets: secrets),
    secrets: secrets,
    session: testURLSession()
  )
}

private func chunks(_ data: Data, widths: [Int]) -> [Data] {
  guard data.isEmpty == false else { return [] }
  let bytes = Array(data)
  var result: [Data] = []
  var offset = 0
  var widthIndex = 0
  while offset < bytes.count {
    let width = widths[widthIndex % widths.count]
    let end = min(offset + width, bytes.count)
    result.append(Data(bytes[offset..<end]))
    offset = end
    widthIndex += 1
  }
  return result
}

private func waitUntil(
  _ predicate: @Sendable () -> Bool
) async throws {
  for _ in 0..<100 {
    if predicate() { return }
    try await Task.sleep(for: .milliseconds(10))
  }
  throw URLError(.timedOut)
}
