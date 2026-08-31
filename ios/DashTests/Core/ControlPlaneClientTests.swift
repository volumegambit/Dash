import Foundation
import Testing

@testable import Dash

private struct PresenterFixtureError: Error, Sendable {}

/// Echoes the authorize URL's `state` back on the callback, letting
/// `AccountSession.signIn()` complete without any real Clerk interaction.
private actor FakeWebAuthPresenter: WebAuthPresenting {
  func authenticate(url: URL, callbackScheme: String) async throws -> URL {
    guard
      let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
      let state = components.queryItems?.first(where: { $0.name == "state" })?.value
    else {
      throw PresenterFixtureError()
    }
    var callback = URLComponents()
    callback.scheme = callbackScheme
    callback.host = "oauth-callback"
    callback.queryItems = [
      URLQueryItem(name: "code", value: "auth-code"),
      URLQueryItem(name: "state", value: state),
    ]
    guard let url = callback.url else { throw PresenterFixtureError() }
    return url
  }
}

@Suite("Control plane client", .serialized)
struct ControlPlaneClientTests {
  init() {
    URLProtocolStub.reset()
  }

  @Test("listGateways bearer-authenticates, hits the exact URL, and unwraps the envelope")
  func listGatewaysUnwrapsEnvelope() async throws {
    let session = try await signedInSession(idToken: "id-token-abc")
    URLProtocolStub.enqueue(
      status: 200,
      data: Data(
        """
        {
          "gateways": [
            {
              "gatewayId": "gw-1",
              "subdomain": "mygw.relay.dash.example",
              "status": "online",
              "createdAt": "2026-01-01T00:00:00.000Z",
              "publicKey": "pk-1"
            }
          ]
        }
        """.utf8
      )
    )
    let client = ControlPlaneClient(
      config: try makeConfig(),
      tokens: session,
      session: testURLSession()
    )

    let gateways = try await client.listGateways()

    #expect(
      gateways == [
        GatewayInfoDTO(
          gatewayId: "gw-1",
          subdomain: "mygw.relay.dash.example",
          status: "online",
          publicKey: "pk-1"
        )
      ]
    )
    let request = try #require(URLProtocolStub.requests.last)
    #expect(request.httpMethod == "GET")
    #expect(request.url?.absoluteString == "https://cp.dash.test/v1/gateways")
    #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer id-token-abc")
  }

  @Test("createPairing posts the exact mobile mint body and decodes a chatToken-present grant")
  func createPairingDecodesChatTokenPresentGrant() async throws {
    let session = try await signedInSession(idToken: "id-token-xyz")
    URLProtocolStub.enqueue(
      status: 200,
      data: Data(
        """
        {
          "credential": "cred-1",
          "pairingId": "pairing-1",
          "chatToken": "chat-1",
          "status": "active"
        }
        """.utf8
      )
    )
    let client = ControlPlaneClient(
      config: try makeConfig(),
      tokens: session,
      session: testURLSession()
    )

    let grant = try await client.createPairing(gatewayId: "gw-1", deviceLabel: "Gerry's iPhone")

    #expect(
      grant
        == PairingGrant(
          credential: "cred-1",
          pairingId: "pairing-1",
          chatToken: "chat-1",
          status: "active"
        )
    )
    let request = try #require(URLProtocolStub.requests.last)
    #expect(request.httpMethod == "POST")
    #expect(
      request.url?.absoluteString
        == "https://cp.dash.test/v1/gateways/gw-1/pairings/pairing-id-v1"
    )
    #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer id-token-xyz")
    let body = try #require(request.httpBody)
    let json = try #require(JSONSerialization.jsonObject(with: body) as? [String: String])
    #expect(json == ["deviceLabel": "Gerry's iPhone", "clientKind": "mobile"])
  }

  @Test("createPairing decodes a chatToken-absent grant without failing")
  func createPairingDecodesChatTokenAbsentGrant() async throws {
    let session = try await signedInSession(idToken: "id-token-xyz")
    URLProtocolStub.enqueue(
      status: 200,
      data: Data(
        """
        {
          "credential": "cred-2",
          "pairingId": "pairing-2",
          "status": "pending"
        }
        """.utf8
      )
    )
    let client = ControlPlaneClient(
      config: try makeConfig(),
      tokens: session,
      session: testURLSession()
    )

    let grant = try await client.createPairing(gatewayId: "gw-1", deviceLabel: "Gerry's iPhone")

    #expect(
      grant
        == PairingGrant(credential: "cred-2", pairingId: "pairing-2", chatToken: nil, status: "pending")
    )
  }

  @Test("revokePairing DELETEs the exact pairing URL with the bearer token")
  func revokePairingSendsDelete() async throws {
    let session = try await signedInSession(idToken: "id-token-del")
    URLProtocolStub.enqueue(status: 200, data: Data(#"{"ok":true}"#.utf8))
    let client = ControlPlaneClient(
      config: try makeConfig(),
      tokens: session,
      session: testURLSession()
    )

    try await client.revokePairing(gatewayId: "gw-1", pairingId: "pairing-1")

    let request = try #require(URLProtocolStub.requests.last)
    #expect(request.httpMethod == "DELETE")
    #expect(
      request.url?.absoluteString
        == "https://cp.dash.test/v1/gateways/gw-1/pairings/pairing-1"
    )
    #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer id-token-del")
  }

  @Test("a 401 response maps to .unauthorized")
  func unauthorizedMapping() async throws {
    let session = try await signedInSession(idToken: "id-token-401")
    URLProtocolStub.enqueue(status: 401, data: Data("{}".utf8))
    let client = ControlPlaneClient(
      config: try makeConfig(),
      tokens: session,
      session: testURLSession()
    )

    #expect(await controlPlaneError { try await client.listGateways() } == .unauthorized)
  }

  @Test("a connection failure maps to .network")
  func networkFailureMapping() async throws {
    let session = try await signedInSession(idToken: "id-token-net")
    URLProtocolStub.enqueue(failure: URLError(.networkConnectionLost))
    let client = ControlPlaneClient(
      config: try makeConfig(),
      tokens: session,
      session: testURLSession()
    )

    #expect(await controlPlaneError { try await client.listGateways() } == .network)
  }

  @Test("a non-401 non-2xx response maps sanely to .network")
  func otherNonSuccessMapping() async throws {
    let session = try await signedInSession(idToken: "id-token-409")
    URLProtocolStub.enqueue(status: 409, data: Data("{}".utf8))
    let client = ControlPlaneClient(
      config: try makeConfig(),
      tokens: session,
      session: testURLSession()
    )

    #expect(await controlPlaneError { try await client.listGateways() } == .network)
  }

  @Test("registerSigner posts the exact body and decodes signerId")
  func registerSignerPostsExactBodyAndDecodesSignerId() async throws {
    let session = try await signedInSession(idToken: "id-token-signer")
    URLProtocolStub.enqueue(status: 201, data: Data(#"{"signerId":"signer-1"}"#.utf8))
    let client = ControlPlaneClient(
      config: try makeConfig(),
      tokens: session,
      session: testURLSession()
    )

    let signerId = try await client.registerSigner(publicKey: "pubkey-abc", label: "Gerry's iPhone")

    #expect(signerId == "signer-1")
    let request = try #require(URLProtocolStub.requests.last)
    #expect(request.httpMethod == "POST")
    #expect(request.url?.absoluteString == "https://cp.dash.test/v1/signers")
    #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer id-token-signer")
    let body = try #require(request.httpBody)
    let json = try #require(JSONSerialization.jsonObject(with: body) as? [String: String])
    #expect(json == ["publicKey": "pubkey-abc", "label": "Gerry's iPhone"])
  }

  @Test("fetchApproval GETs the exact URL and decodes the approval shape")
  func fetchApprovalDecodesApproval() async throws {
    let session = try await signedInSession(idToken: "id-token-approval")
    URLProtocolStub.enqueue(
      status: 200,
      data: Data(
        """
        {
          "approvalId": "approval-1",
          "pairingId": "pairing-1",
          "gatewayId": "gw-1",
          "deviceLabel": "Chrome on Mac",
          "expiresAt": "2026-01-01T00:02:00.000Z"
        }
        """.utf8
      )
    )
    let client = ControlPlaneClient(
      config: try makeConfig(),
      tokens: session,
      session: testURLSession()
    )

    let approval = try await client.fetchApproval(id: "approval-1")

    #expect(
      approval
        == ApprovalRequestDTO(
          approvalId: "approval-1",
          pairingId: "pairing-1",
          gatewayId: "gw-1",
          deviceLabel: "Chrome on Mac",
          expiresAt: "2026-01-01T00:02:00.000Z"
        )
    )
    let request = try #require(URLProtocolStub.requests.last)
    #expect(request.httpMethod == "GET")
    #expect(request.url?.absoluteString == "https://cp.dash.test/v1/approvals/approval-1")
    #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer id-token-approval")
  }

  @Test("postDecision posts the exact decision body to the exact URL")
  func postDecisionPostsExactBody() async throws {
    let session = try await signedInSession(idToken: "id-token-decision")
    URLProtocolStub.enqueue(status: 204, data: Data())
    let client = ControlPlaneClient(
      config: try makeConfig(),
      tokens: session,
      session: testURLSession()
    )

    try await client.postDecision(
      approvalId: "approval-1",
      decision: "approve",
      signerId: "signer-1",
      signature: "sig-abc"
    )

    let request = try #require(URLProtocolStub.requests.last)
    #expect(request.httpMethod == "POST")
    #expect(
      request.url?.absoluteString == "https://cp.dash.test/v1/approvals/approval-1/decision"
    )
    #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer id-token-decision")
    let body = try #require(request.httpBody)
    let json = try #require(JSONSerialization.jsonObject(with: body) as? [String: String])
    #expect(json == ["decision": "approve", "signerId": "signer-1", "signature": "sig-abc"])
  }

  @Test("a 403 response from postDecision maps to .forbidden")
  func postDecisionForbiddenMapping() async throws {
    let session = try await signedInSession(idToken: "id-token-403")
    URLProtocolStub.enqueue(status: 403, data: Data(#"{"error":"invalid signature"}"#.utf8))
    let client = ControlPlaneClient(
      config: try makeConfig(),
      tokens: session,
      session: testURLSession()
    )

    let error = await controlPlaneError {
      try await client.postDecision(
        approvalId: "approval-1",
        decision: "approve",
        signerId: "signer-1",
        signature: "bad-sig"
      )
    }

    #expect(error == .forbidden)
  }

  @Test("a 410 response from postDecision maps to .expired")
  func postDecisionExpiredMapping() async throws {
    let session = try await signedInSession(idToken: "id-token-410")
    URLProtocolStub.enqueue(status: 410, data: Data(#"{"error":"expired"}"#.utf8))
    let client = ControlPlaneClient(
      config: try makeConfig(),
      tokens: session,
      session: testURLSession()
    )

    let error = await controlPlaneError {
      try await client.postDecision(
        approvalId: "approval-1",
        decision: "deny",
        signerId: "signer-1",
        signature: "sig-abc"
      )
    }

    #expect(error == .expired)
  }

  @Test("an AccountSession in .signInRequired state surfaces .signInRequired without a request")
  func signInRequiredSurfacesWithoutRequest() async throws {
    let presenter = FakeWebAuthPresenter()
    let session = AccountSession(
      config: try makeConfig(),
      presenter: presenter,
      session: testURLSession()
    )
    let client = ControlPlaneClient(
      config: try makeConfig(),
      tokens: session,
      session: testURLSession()
    )

    let error = await controlPlaneError { try await client.listGateways() }

    #expect(error == .signInRequired)
    #expect(URLProtocolStub.requests.isEmpty)
  }
}

// MARK: - Helpers

private func makeConfig() throws -> AccountAuthConfig {
  try withConfigBundle([
    "DashClerkFrontendAPI": "resolved-seahorse-39.clerk.accounts.dev",
    "DashClerkClientID": "test-client-id",
    "DashControlPlaneURL": "https://cp.dash.test",
  ]) { bundle in
    try AccountAuthConfig.fromBundle(bundle)
  }
}

/// Writes `entries` as a standalone `Info.plist` in a fresh temp directory,
/// loads it as a `Bundle`, hands it to `body`, and always removes the
/// directory afterward (success or throw) so repeated test runs don't leak
/// scratch directories under `/tmp`. Mirrors `AccountSessionTests`.
private func withConfigBundle<T>(
  _ entries: [String: String],
  _ body: (Bundle) throws -> T
) throws -> T {
  let directory = FileManager.default.temporaryDirectory
    .appendingPathComponent("ControlPlaneClientTests-\(UUID().uuidString)", isDirectory: true)
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  defer { try? FileManager.default.removeItem(at: directory) }

  let data = try PropertyListSerialization.data(fromPropertyList: entries, format: .xml, options: 0)
  try data.write(to: directory.appendingPathComponent("Info.plist"))
  let bundle = try #require(Bundle(url: directory))
  return try body(bundle)
}

/// Drives a real `AccountSession.signIn()` against the shared `URLProtocolStub`
/// queue so `ControlPlaneClient` tests exercise the actual bearer-token path
/// rather than a stand-in. Enqueues (and consumes) exactly one stubbed token
/// exchange response before returning.
private func signedInSession(idToken: String) async throws -> AccountSession {
  let presenter = FakeWebAuthPresenter()
  let session = AccountSession(
    config: try makeConfig(),
    presenter: presenter,
    session: testURLSession()
  )
  URLProtocolStub.enqueue(
    status: 200,
    data: try JSONSerialization.data(
      withJSONObject: ["id_token": idToken, "expires_in": 3600]
    )
  )
  try await session.signIn()
  return session
}

private func controlPlaneError(
  _ operation: () async throws -> Void
) async -> ControlPlaneError? {
  do {
    try await operation()
    Issue.record("Expected ControlPlaneError")
    return nil
  } catch let error as ControlPlaneError {
    return error
  } catch {
    Issue.record("Expected ControlPlaneError, received \(error)")
    return nil
  }
}
