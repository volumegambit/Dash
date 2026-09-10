import Foundation
import Testing

@testable import Dash

@Suite("Mobile protocol negotiation", .serialized)
struct MobileProtocolNegotiatorTests {
  init() {
    URLProtocolStub.reset()
  }

  @Test("v2 queue capability wins and keeps health public")
  func v2Wins() async throws {
    try URLProtocolStub.enqueue(status: 200, fixture: "health-capabilities.json", version: 2)
    try URLProtocolStub.enqueue(status: 200, fixture: "identity.json")

    let result = try await makeNegotiator().negotiate()

    #expect(result.selection == .v2Queue)
    #expect(result.identity.gatewayId == "gateway-01")
    let requests = URLProtocolStub.requests
    #expect(requests.count == 2)
    #expect(try encodedPath(requests[0]) == "/mobile/v2/health")
    #expect(requests[0].value(forHTTPHeaderField: "Authorization") == nil)
    #expect(try encodedPath(requests[1]) == "/mobile/v2/identity")
    #expect(
      requests[1].value(forHTTPHeaderField: "Authorization")
        == "Bearer management-test-token"
    )
  }

  @Test("v2 success invalidates its short-lived session")
  func v2SuccessInvalidatesSession() async throws {
    let invalidations = SessionInvalidationRecorder()
    try URLProtocolStub.enqueue(status: 200, fixture: "health-capabilities.json", version: 2)
    try URLProtocolStub.enqueue(status: 200, fixture: "identity.json")

    _ = try await makeNegotiator(recording: invalidations).negotiate()

    try await invalidations.expect(v1: 0, v2: 1)
  }

  @Test("only v2 health not-found falls back to v1")
  func notFoundFallsBack() async throws {
    URLProtocolStub.enqueue(status: 404)
    try URLProtocolStub.enqueue(status: 200, fixture: "health-capabilities.json")
    try URLProtocolStub.enqueue(status: 200, fixture: "identity.json")

    let result = try await makeNegotiator().negotiate()

    #expect(result.selection == .v1)
    #expect(
      try URLProtocolStub.requests.map(encodedPath)
        == ["/mobile/v2/health", "/mobile/v1/health", "/mobile/v1/identity"]
    )
  }

  @Test("v2 to v1 fallback success invalidates both short-lived sessions")
  func fallbackSuccessInvalidatesSessions() async throws {
    let invalidations = SessionInvalidationRecorder()
    URLProtocolStub.enqueue(status: 404)
    try URLProtocolStub.enqueue(status: 200, fixture: "health-capabilities.json")
    try URLProtocolStub.enqueue(status: 200, fixture: "identity.json")

    _ = try await makeNegotiator(recording: invalidations).negotiate()

    try await invalidations.expect(v1: 1, v2: 1)
  }

  @Test("v2 to v1 fallback failure invalidates both short-lived sessions")
  func fallbackFailureInvalidatesSessions() async throws {
    let invalidations = SessionInvalidationRecorder()
    URLProtocolStub.enqueue(status: 404)
    URLProtocolStub.enqueue(status: 500)

    _ = await negotiationGatewayError(recording: invalidations)

    try await invalidations.expect(v1: 1, v2: 1)
    #expect(URLProtocolStub.requests.count == 2)
  }

  @Test("only an exact 426 capability_required envelope falls back to v1")
  func versionCapabilityFallsBack() async throws {
    URLProtocolStub.enqueue(
      status: 426,
      data: Data(
        #"{"code":"capability_required","error":"mobile v2 unavailable","retryable":false}"#.utf8
      )
    )
    try URLProtocolStub.enqueue(status: 200, fixture: "health-capabilities.json")
    try URLProtocolStub.enqueue(status: 200, fixture: "identity.json")

    let result = try await makeNegotiator().negotiate()

    #expect(result.selection == .v1)
    #expect(URLProtocolStub.requests.count == 3)
  }

  @Test(
    "malformed 426 envelopes never downgrade",
    arguments: [
      #"{"code":"capability_required"}"#,
      #"{"code":"capability_required","error":"","retryable":false}"#,
      #"{"code":"capability_required","error":"   ","retryable":false}"#,
      #"{"code":"capability_required","error":"unsupported","retryable":"false"}"#,
      #"{"code":"capability_required","error":"unsupported","retryable":false,"details":null}"#,
      #"{"code":"capability_required","error":"unsupported","retryable":false,"details":[]}"#,
      #"{"code":"capability_required","error":"unsupported","retryable":false,"extra":1}"#,
      #"{"code":"future_code","error":"unsupported","retryable":false}"#,
      #"[]"#,
      #"not json"#,
    ]
  )
  func malformedVersionEnvelopeDoesNotDowngrade(body: String) async {
    URLProtocolStub.enqueue(status: 426, data: Data(body.utf8))

    let error = await negotiationGatewayError()

    guard case .server? = error else {
      Issue.record("Expected an ordinary server error, received \(String(describing: error))")
      return
    }
    #expect(URLProtocolStub.requests.count == 1)
  }

  @Test("capability_required on a status other than 426 does not downgrade")
  func wrongStatusDoesNotDowngrade() async {
    URLProtocolStub.enqueue(
      status: 400,
      data: Data(
        #"{"code":"capability_required","error":"bad request","retryable":false}"#.utf8
      )
    )

    #expect(await negotiationGatewayError() == .capabilityRequired)
    #expect(URLProtocolStub.requests.count == 1)
  }

  @Test(
    "valid not_found on non-404 v2 health never downgrades",
    arguments: [400, 410, 426, 500]
  )
  func wrongStatusNotFoundDoesNotDowngrade(status: Int) async throws {
    URLProtocolStub.enqueue(
      status: status,
      data: Data(
        #"{"code":"not_found","error":"mobile v2 health failed","retryable":false}"#.utf8
      )
    )

    let error = await negotiationGatewayError()

    guard case let .server(body, mappedStatus)? = error else {
      Issue.record("Expected terminal server error, received \(String(describing: error))")
      return
    }
    #expect(mappedStatus == status)
    #expect(body.code == "not_found")
    #expect(URLProtocolStub.requests.count == 1)
    #expect(try encodedPath(#require(URLProtocolStub.requests.first)) == "/mobile/v2/health")
  }

  @Test("v2 transport and authorization failures do not downgrade", arguments: [401, 500])
  func v2FailuresDoNotDowngrade(status: Int) async {
    URLProtocolStub.enqueue(status: status)

    _ = await negotiationGatewayError()

    #expect(URLProtocolStub.requests.count == 1)
  }

  @Test("terminal v2 health failure invalidates its short-lived session")
  func healthFailureInvalidatesSession() async throws {
    let invalidations = SessionInvalidationRecorder()
    URLProtocolStub.enqueue(status: 500)

    _ = await negotiationGatewayError(recording: invalidations)

    try await invalidations.expect(v1: 0, v2: 1)
  }

  @Test("v2 identity failure after successful health does not downgrade")
  func identityFailureDoesNotDowngrade() async throws {
    try URLProtocolStub.enqueue(status: 200, fixture: "health-capabilities.json", version: 2)
    URLProtocolStub.enqueue(status: 404)

    #expect(await negotiationGatewayError() == .notFound)
    #expect(URLProtocolStub.requests.count == 2)
  }

  @Test("v2 identity authorization failure does not downgrade and invalidates its session")
  func identityAuthorizationDoesNotDowngrade() async throws {
    let invalidations = SessionInvalidationRecorder()
    try URLProtocolStub.enqueue(status: 200, fixture: "health-capabilities.json", version: 2)
    URLProtocolStub.enqueue(status: 401)

    #expect(await negotiationGatewayError(recording: invalidations) == .unauthorized)
    try await invalidations.expect(v1: 0, v2: 1)
    #expect(URLProtocolStub.requests.count == 2)
  }

  @Test("v2 identity cancellation does not downgrade and invalidates its session")
  func identityCancellationDoesNotDowngrade() async throws {
    let invalidations = SessionInvalidationRecorder()
    try URLProtocolStub.enqueue(status: 200, fixture: "health-capabilities.json", version: 2)
    URLProtocolStub.enqueue(failure: URLError(.cancelled))

    do {
      _ = try await makeNegotiator(recording: invalidations).negotiate()
      Issue.record("Expected identity request cancellation")
    } catch is CancellationError {
      // Expected terminal result. A cancelled v2 identity probe must never select v1.
    } catch {
      Issue.record("Expected CancellationError, received \(error)")
    }

    try await invalidations.expect(v1: 0, v2: 1)
    #expect(URLProtocolStub.requests.count == 2)
  }

  @Test("v2 identity 426 after successful health does not downgrade")
  func identityVersionCapabilityDoesNotDowngrade() async throws {
    try URLProtocolStub.enqueue(status: 200, fixture: "health-capabilities.json", version: 2)
    URLProtocolStub.enqueue(
      status: 426,
      data: Data(
        #"{"code":"capability_required","error":"identity unavailable","retryable":false}"#.utf8
      )
    )

    #expect(await negotiationGatewayError() == .mobileVersionCapabilityRequired)
    #expect(URLProtocolStub.requests.count == 2)
    #expect(
      try URLProtocolStub.requests.map(encodedPath)
        == ["/mobile/v2/health", "/mobile/v2/identity"]
    )
  }

  @Test(
    "v2 identity is an exact two-field nonempty object",
    arguments: [
      #"{}"#,
      #"{"gatewayId":"gateway-01"}"#,
      #"{"publicKey":"public-key"}"#,
      #"{"gatewayId":"","publicKey":"public-key"}"#,
      #"{"gatewayId":"gateway-01","publicKey":""}"#,
      #"{"gatewayId":"gateway-01","publicKey":"public-key","extra":true}"#,
      #"[]"#,
      #"not json"#,
    ]
  )
  func invalidIdentityDoesNotDowngrade(body: String) async throws {
    try URLProtocolStub.enqueue(status: 200, fixture: "health-capabilities.json", version: 2)
    URLProtocolStub.enqueue(status: 200, data: Data(body.utf8))

    #expect(await negotiationGatewayError() == .updateRequired)
    #expect(URLProtocolStub.requests.count == 2)
    #expect(
      try URLProtocolStub.requests.map(encodedPath)
        == ["/mobile/v2/health", "/mobile/v2/identity"]
    )
  }

  @Test(
    "invalid v2 health never downgrades",
    arguments: [
      #"{"status":"healthy","startedAt":"2026-09-06T09:00:00.000Z","pid":0,"agents":1,"channels":1,"apiVersion":2,"capabilities":["chat-input-queue-v1"]}"#,
      #"{"status":"healthy","startedAt":"2026-09-06T09:00:00.000Z","pid":1,"agents":-1,"channels":1,"apiVersion":2,"capabilities":["chat-input-queue-v1"]}"#,
      #"{"status":"healthy","startedAt":"2026-09-06T09:00:00.000Z","pid":1,"agents":1,"channels":-1,"apiVersion":2,"capabilities":["chat-input-queue-v1"]}"#,
      #"{"status":"healthy","startedAt":"2026-09-06T09:00:00.000Z","pid":1,"agents":1,"channels":1,"apiVersion":2,"capabilities":["chat-input-queue-v1","chat-input-queue-v1"]}"#,
      #"{"status":"healthy","startedAt":"not-a-date","pid":1,"agents":1,"channels":1,"apiVersion":2,"capabilities":["chat-input-queue-v1"]}"#,
      #"{"status":"healthy","startedAt":"2026-09-06T09:00:00.000Z","pid":1,"agents":1,"channels":1,"apiVersion":2}"#,
    ]
  )
  func invalidHealthDoesNotDowngrade(body: String) async {
    URLProtocolStub.enqueue(status: 200, data: Data(body.utf8))

    #expect(await negotiationGatewayError() == .updateRequired)
    #expect(URLProtocolStub.requests.count == 1)
  }

  @Test("v2 health without queue capability fails closed")
  func missingQueueCapabilityFailsClosed() async {
    URLProtocolStub.enqueue(
      status: 200,
      data: Data(
        #"{"status":"healthy","startedAt":"2026-09-06T09:00:00.000Z","pid":1,"agents":1,"channels":1,"apiVersion":2,"capabilities":["conversation-sync-v1","chat-resume-v1"]}"#.utf8
      )
    )

    #expect(await negotiationGatewayError() == .capabilityRequired)
    #expect(URLProtocolStub.requests.count == 1)
  }

  private func negotiationGatewayError(
    recording invalidations: SessionInvalidationRecorder? = nil
  ) async -> GatewayError? {
    do {
      _ = try await makeNegotiator(recording: invalidations).negotiate()
      Issue.record("Expected negotiation to fail")
      return nil
    } catch let error as GatewayError {
      return error
    } catch {
      Issue.record("Expected GatewayError, received \(error)")
      return nil
    }
  }

  private func makeNegotiator(
    recording invalidations: SessionInvalidationRecorder? = nil
  ) -> MobileProtocolNegotiator {
    MobileProtocolNegotiator { selection in
      GatewayAPI(
        transport: makeProtocolTransport(
          selection: selection,
          recording: invalidations
        ),
        selection: selection
      )
    }
  }

  private func makeProtocolTransport(
    selection: MobileProtocolSelection,
    recording invalidations: SessionInvalidationRecorder?
  ) -> HTTPTransport {
    let secrets = ConnectionSecrets(
      managementToken: "management-test-token",
      chatToken: "chat-test-token",
      relayCredential: nil
    )
    let profile = ConnectionProfile(
      id: UUID(),
      gatewayId: "gateway-01",
      publicKey: "public-key",
      label: "Test Gateway",
      host: "gateway.test",
      managementPort: 9400,
      chatPort: 9400,
      secure: true,
      mode: .lan,
      tlsCertificateSha256:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      createdAt: Date(timeIntervalSince1970: 0),
      lastSuccessfulSyncAt: nil
    )
    let session: URLSession
    if let invalidations {
      let configuration = URLSessionConfiguration.ephemeral
      configuration.protocolClasses = [URLProtocolStub.self]
      session = URLSession(
        configuration: configuration,
        delegate: SessionInvalidationDelegate(
          selection: selection,
          recorder: invalidations
        ),
        delegateQueue: nil
      )
    } else {
      session = testURLSession()
    }
    return HTTPTransport(
      endpoint: ConnectionEndpoint(profile: profile, secrets: secrets),
      secrets: secrets,
      session: session,
      clock: TestAppClock(now: Date(timeIntervalSince1970: 0))
    )
  }
}

private final class SessionInvalidationRecorder: @unchecked Sendable {
  private let lock = NSLock()
  private var v1Count = 0
  private var v2Count = 0

  func record(_ selection: MobileProtocolSelection) {
    lock.lock()
    defer { lock.unlock() }
    switch selection {
    case .v1:
      v1Count += 1
    case .v2Queue:
      v2Count += 1
    }
  }

  func expect(v1 expectedV1: Int, v2 expectedV2: Int) async throws {
    for _ in 0..<200 {
      let actual = counts()
      if actual.v1 == expectedV1, actual.v2 == expectedV2 { return }
      try await Task.sleep(for: .milliseconds(5))
    }
    let actual = counts()
    let expected = "(v1: \(expectedV1), v2: \(expectedV2))"
    let received = "(v1: \(actual.v1), v2: \(actual.v2))"
    Issue.record("Expected session invalidations \(expected), received \(received)")
  }

  private func counts() -> (v1: Int, v2: Int) {
    lock.lock()
    defer { lock.unlock() }
    return (v1Count, v2Count)
  }
}

private final class SessionInvalidationDelegate: NSObject, URLSessionDelegate,
  @unchecked Sendable
{
  private let selection: MobileProtocolSelection
  private let recorder: SessionInvalidationRecorder

  init(selection: MobileProtocolSelection, recorder: SessionInvalidationRecorder) {
    self.selection = selection
    self.recorder = recorder
  }

  func urlSession(_ session: URLSession, didBecomeInvalidWithError error: Error?) {
    recorder.record(selection)
  }
}

private func encodedPath(_ request: URLRequest) throws -> String {
  let url = try #require(request.url)
  return try #require(URLComponents(url: url, resolvingAgainstBaseURL: false)).percentEncodedPath
}
