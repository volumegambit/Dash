import Foundation
import XCTest

@testable import Dash

/// Reads the environment `ios/scripts/run-live-account-flow-test.mjs --flow
/// signer` injects into the simulator before running `LiveSignerFlowTests`.
/// Same shape and "throw when absent" convention as `LiveAccountFlowEnvironment`
/// (NOT an `XCTSkip`) — running the `DashIntegration` scheme directly, without
/// that script, naturally fails this test with a `missing(...)` error, exactly
/// like every other live test in this target. Kept as a private type in this
/// file (rather than a sibling `LiveSignerFlowEnvironment.swift`) per the
/// signer-device plan's Task 7 file list, which names only this test file.
enum LiveSignerFlowEnvironmentError: Error, Equatable, Sendable {
  case missing(String)
  case blank(String)
  case invalidURL(String)
  case invalidPort(String)
}

struct LiveSignerFlowEnvironment: Sendable {
  /// The (locally running, dev-stub-auth) control plane's base URL, actually
  /// the auth-shim in front of it — see `LiveAccountFlowEnvironment`'s doc
  /// comment for why a shim is needed at all.
  let controlPlaneURL: URL
  /// Accepted verbatim by the control-plane dev stub as the account id. This
  /// is a DIFFERENT account than `LiveAccountFlowTests` uses (isolated CP
  /// state per script invocation makes that unnecessary for correctness, but
  /// distinct ids keep the two flows' server-side records easy to tell apart
  /// in diagnostics).
  let bearer: String
  /// The gateway id (relay-routing/CP registration label) the orchestrating
  /// script registered and dialed into the relay.
  let gatewayID: String
  /// The scripted gateway's OWN self-reported identity (its `/identity`
  /// route's `gatewayId`) — see `LiveAccountFlowEnvironment`'s doc comment.
  let identityGatewayID: String
  /// The scripted agent id `mobile-test-harness.ts` always registers.
  let agentID: String
  /// The TLS terminator's high port — see `LiveAccountFlowEnvironment`'s doc
  /// comment on `relayPort` for why this host cannot use 443.
  let relayPort: Int

  static func environment(_ values: [String: String]) throws -> Self {
    let controlPlaneURLValue = try required("DASH_TEST_SIGNER_CONTROL_PLANE_URL", in: values)
    let bearer = try required("DASH_TEST_SIGNER_BEARER", in: values)
    let gatewayID = try required("DASH_TEST_SIGNER_GATEWAY_ID", in: values)
    let identityGatewayID = try required("DASH_TEST_SIGNER_IDENTITY_GATEWAY_ID", in: values)
    let agentID = try required("DASH_TEST_SIGNER_AGENT_ID", in: values)
    let relayPortValue = try required("DASH_TEST_SIGNER_RELAY_PORT", in: values)
    guard
      let components = URLComponents(string: controlPlaneURLValue),
      components.scheme?.isEmpty == false,
      components.host?.isEmpty == false,
      let url = components.url
    else {
      throw LiveSignerFlowEnvironmentError.invalidURL("DASH_TEST_SIGNER_CONTROL_PLANE_URL")
    }
    guard let relayPort = Int(relayPortValue), (1...65_535).contains(relayPort) else {
      throw LiveSignerFlowEnvironmentError.invalidPort("DASH_TEST_SIGNER_RELAY_PORT")
    }
    return LiveSignerFlowEnvironment(
      controlPlaneURL: url,
      bearer: bearer,
      gatewayID: gatewayID,
      identityGatewayID: identityGatewayID,
      agentID: agentID,
      relayPort: relayPort
    )
  }

  static func processInfo(_ processInfo: ProcessInfo = .processInfo) throws -> Self {
    try environment(processInfo.environment)
  }

  private static func required(_ name: String, in values: [String: String]) throws -> String {
    guard let value = values[name] else {
      throw LiveSignerFlowEnvironmentError.missing(name)
    }
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.isEmpty == false else {
      throw LiveSignerFlowEnvironmentError.blank(name)
    }
    return trimmed
  }
}

/// A minimal, deliberately raw HTTP client for the two control-plane routes a
/// BROWSER (not the mobile app) drives during the signer-approval loop: the
/// `clientKind: "web"` mint and the credential claim. `ControlPlaneClient`
/// intentionally has no methods for either — `createPairing` hardcodes
/// `clientKind: "mobile"`, and nothing in the shipped app ever claims a
/// pending pairing's credential (only a browser does, per the signer-device
/// design). Per the plan's Task 7 note ("the web side is plain fetches from
/// the test"), this test speaks the exact same wire protocol as
/// `apps/web`'s pairing UI would, using `URLSession` directly instead of
/// `ControlPlaneClient`, against the SAME shim URL/bearer scheme the mobile
/// client uses.
enum WebPairingClientError: Error, Equatable, Sendable {
  case network
  case unexpectedStatus(Int)
  case decoding
}

struct WebMintResult: Decodable, Sendable {
  let pairingId: String
  let status: String
  let approvalId: String
  let approvalExpiresAt: Int
}

enum WebClaimResult: Equatable, Sendable {
  case ok(credential: String, chatToken: String?)
  case pending
}

enum WebPairingClient {
  private struct MintRequestBody: Encodable {
    let deviceLabel: String
    let clientKind: String
  }

  private struct ClaimResponseBody: Decodable {
    let credential: String?
    let chatToken: String?
  }

  /// `POST /v1/gateways/:id/pairings/pairing-id-v1` with
  /// `clientKind: "web"` — the exact request a browser's pairing UI sends.
  /// On a signer-gated account this returns `{ pairingId, status: "pending",
  /// approvalId, approvalExpiresAt }` rather than a credential.
  static func mintWebPairing(
    controlPlaneURL: URL,
    bearer: String,
    gatewayId: String,
    deviceLabel: String
  ) async throws -> WebMintResult {
    var request = URLRequest(
      url: controlPlaneURL
        .appendingPathComponent("v1")
        .appendingPathComponent("gateways")
        .appendingPathComponent(gatewayId)
        .appendingPathComponent("pairings")
        .appendingPathComponent("pairing-id-v1")
    )
    request.httpMethod = "POST"
    request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONEncoder().encode(
      MintRequestBody(deviceLabel: deviceLabel, clientKind: "web")
    )
    let (data, response) = try await send(request)
    guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
      throw WebPairingClientError.unexpectedStatus((response as? HTTPURLResponse)?.statusCode ?? -1)
    }
    do {
      return try JSONDecoder().decode(WebMintResult.self, from: data)
    } catch {
      throw WebPairingClientError.decoding
    }
  }

  /// `POST /v1/gateways/:id/pairings/:pid/credential` — the browser's
  /// poll-and-claim call. `409 { status: "pending" }` means the approval has
  /// not been decided (or was rejected without transitioning the pairing)
  /// yet; this is the SAME signal the negative-path test uses to prove a
  /// pairing whose decision was rejected for a bad signature never activates.
  static func claimCredential(
    controlPlaneURL: URL,
    bearer: String,
    gatewayId: String,
    pairingId: String
  ) async throws -> WebClaimResult {
    var request = URLRequest(
      url: controlPlaneURL
        .appendingPathComponent("v1")
        .appendingPathComponent("gateways")
        .appendingPathComponent(gatewayId)
        .appendingPathComponent("pairings")
        .appendingPathComponent(pairingId)
        .appendingPathComponent("credential")
    )
    request.httpMethod = "POST"
    request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    let (data, response) = try await send(request)
    guard let http = response as? HTTPURLResponse else {
      throw WebPairingClientError.network
    }
    if http.statusCode == 409 {
      return .pending
    }
    guard (200..<300).contains(http.statusCode) else {
      throw WebPairingClientError.unexpectedStatus(http.statusCode)
    }
    let decoded: ClaimResponseBody
    do {
      decoded = try JSONDecoder().decode(ClaimResponseBody.self, from: data)
    } catch {
      throw WebPairingClientError.decoding
    }
    guard let credential = decoded.credential else {
      throw WebPairingClientError.decoding
    }
    return .ok(credential: credential, chatToken: decoded.chatToken)
  }

  private static func send(_ request: URLRequest) async throws -> (Data, URLResponse) {
    do {
      return try await URLSession.shared.data(for: request)
    } catch {
      throw WebPairingClientError.network
    }
  }
}

/// Task 7 of the signer-device plan: the live integration test proving the
/// whole signer-approval loop end to end against REAL processes (the same
/// relay + control plane + scripted gateway `LiveAccountFlowTests` uses, this
/// time booted by `run-live-account-flow-test.mjs --flow signer`):
///
///   iOS `SignerIdentity` registers a signer (`POST /v1/signers`) -> a
///   web-shaped mint (`clientKind: "web"`, a plain `URLSession` request
///   mimicking the browser pairing UI) on the now signer-gated account
///   returns a PENDING approval -> `ControlPlaneClient.fetchApproval` reads
///   it -> `SignerIdentity.sign` produces a real CryptoKit Ed25519 signature
///   over the control plane's exact wire message -> `postDecision` records
///   an "approve" -> a plain-fetch claim returns the now-activated
///   credential + chat token -> those credentials, run through the SAME
///   `PairingVerifier` machinery QR/account pairing use, open a real relay
///   chat round-trip.
///
/// The negative half proves the converse: a syntactically-valid but WRONG
/// signature on a second pending approval is rejected with `403` (mapped to
/// `ControlPlaneError.forbidden`), and — critically — the pairing it guards
/// never activates: a claim attempt afterward still reads back `409
/// {status: "pending"}`, not a credential. This is the same security
/// invariant `ProvisioningService.decideApproval` documents (signature
/// verification happens strictly BEFORE the approve/deny transition), proven
/// here against a real running control plane rather than just its unit
/// tests.
final class LiveSignerFlowTests: XCTestCase {
  @MainActor
  func testSignerApprovalLoop() async throws {
    let environment = try LiveSignerFlowEnvironment.processInfo()

    let config = AccountAuthConfig(
      frontendAPIHost: "unused.invalid",
      clientID: "unused",
      controlPlaneURL: environment.controlPlaneURL,
      redirectURI: "dash://oauth-callback"
    )
    let session = AccountSession(
      preSignedInWithIDToken: environment.bearer,
      expiresAt: Date().addingTimeInterval(3600),
      config: config,
      presenter: UnreachableWebAuthPresenter()
    )
    let client = ControlPlaneClient(config: config, tokens: session)

    let gateways = try await client.listGateways()
    let gateway = try XCTUnwrap(
      gateways.first { $0.gatewayId == environment.gatewayID },
      "Expected the harness-registered gateway in the account's gateway list"
    )
    XCTAssertEqual(gateway.status, "active")

    // This device's real signing identity — a fresh key + registration for
    // every run, regardless of whatever this simulator's Keychain happens to
    // carry from a previous local/live test (`SignerIdentity`'s Keychain
    // entry is a single fixed slot, unrelated to which account is signed in
    // — see its `reset()` doc comment). The account itself is always fresh
    // (a brand-new in-memory CP database per script invocation), so this is
    // belt-and-suspenders isolation, not a correctness requirement.
    let keychain = SystemKeychainStore()
    let signer = SignerIdentity(keychain: keychain)
    try await signer.reset()
    let publicKey = try await signer.publicKeyB64()
    let signerId = try await client.registerSigner(
      publicKey: publicKey,
      label: "Dash iOS live signer flow test"
    )
    try await signer.persistSignerId(signerId)

    // --- Positive path -----------------------------------------------

    // A web-shaped mint on a NOW signer-gated account (this device just
    // became the account's first registered signer) returns a pending
    // approval instead of a credential — `ProvisioningService.createPairing`
    // gates `clientKind: "web"` mints whenever `signerCount(accountId) > 0`.
    let mint = try await WebPairingClient.mintWebPairing(
      controlPlaneURL: environment.controlPlaneURL,
      bearer: environment.bearer,
      gatewayId: gateway.gatewayId,
      deviceLabel: "Live signer flow browser"
    )
    XCTAssertEqual(mint.status, "pending")
    defer {
      Task {
        try? await client.revokePairing(gatewayId: gateway.gatewayId, pairingId: mint.pairingId)
      }
    }

    let approval = try await client.fetchApproval(id: mint.approvalId)
    XCTAssertEqual(approval.pairingId, mint.pairingId)
    XCTAssertEqual(approval.gatewayId, gateway.gatewayId)

    let signature = try await signer.sign(
      approvalId: approval.approvalId,
      pairingId: approval.pairingId,
      decision: "approve"
    )
    try await client.postDecision(
      approvalId: approval.approvalId,
      decision: "approve",
      signerId: signerId,
      signature: signature
    )

    let claimed = try await WebPairingClient.claimCredential(
      controlPlaneURL: environment.controlPlaneURL,
      bearer: environment.bearer,
      gatewayId: gateway.gatewayId,
      pairingId: mint.pairingId
    )
    guard case .ok(let credential, let chatToken) = claimed else {
      return XCTFail("Expected the approved pairing's credential to be claimable")
    }
    XCTAssertFalse(credential.isEmpty)
    let claimedChatToken = try XCTUnwrap(chatToken, "Expected a chat token for a web pairing")

    // Run the claimed credentials through the SAME verify machinery
    // QR/account pairing use (mirrors `AccountConnectFeature.connect`'s
    // payload shape for a v2/relay pairing) — proves the signer-approval
    // loop lands on a normal, production-shaped connection, not a
    // special-cased test double.
    let clock = SystemAppClock()
    let makeTransport: @Sendable (ConnectionEndpoint, ConnectionSecrets) -> HTTPTransport = {
      endpoint, secrets in
      HTTPTransport(
        endpoint: endpoint,
        secrets: secrets,
        session: GatewayURLSessionFactory.make(profile: endpoint.profile),
        clock: clock
      )
    }
    let pairingVerifier = PairingVerifier(
      makeGateway: { endpoint, secrets in GatewayAPI(transport: makeTransport(endpoint, secrets)) },
      makeChat: { endpoint in ChatConnection(endpoint: endpoint, clock: clock) },
      debugRelayPortOverride: environment.relayPort
    )
    let payload = PairingPayload(
      v: 2,
      host: gateway.subdomain,
      mgmtToken: claimedChatToken,
      chatToken: claimedChatToken,
      mgmtPort: nil,
      chatPort: nil,
      label: nil,
      secure: true,
      relayCredential: credential
    )
    let unadjusted = try await pairingVerifier.verify(payload: payload) { _ in }
    let verified =
      unadjusted.profile.profile.mode == .relay
      ? unadjusted.applyingDebugRelayPortOverride(environment.relayPort)
      : unadjusted

    // The same cross-check `AccountConnectFeature.connect` enforces: the key
    // the relay-reached gateway signed in with at `/identity` matches the key
    // the account originally enrolled with the control plane.
    XCTAssertFalse(gateway.publicKey.isEmpty)
    XCTAssertEqual(verified.identity.publicKey, gateway.publicKey)
    XCTAssertEqual(verified.profile.gatewayID, environment.identityGatewayID)
    XCTAssertEqual(verified.profile.profile.mode, .relay)
    XCTAssertTrue(verified.profile.profile.secure)
    XCTAssertEqual(verified.profile.profile.managementPort, environment.relayPort)
    XCTAssertEqual(verified.profile.profile.chatPort, environment.relayPort)

    // One chat round-trip over the relay with the claimed credentials.
    let endpoint = ConnectionEndpoint(profile: verified.profile.profile, secrets: verified.secrets)
    let chat = ChatConnection(endpoint: endpoint, clock: clock)
    let recording = await LiveChatRecording.start(chat: chat)
    defer { recording.cancel() }

    let api = GatewayAPI(transport: makeTransport(endpoint, verified.secrets))
    let conversation = try await api.createConversation(
      CreateConversationRequest(
        agentId: environment.agentID,
        requestId: UUID().uuidString.lowercased(),
        title: "iOS live signer flow",
        owningIssueId: nil,
        projectId: nil
      )
    )

    let turnID = UUID().uuidString.lowercased()
    try await chat.connect()
    try await chat.sendTurn(
      id: turnID,
      agentID: environment.agentID,
      conversationID: conversation.id,
      text: "Say hello",
      images: []
    )
    let terminal = try await recording.recorder.waitForFrame(turnID: turnID) {
      $0.liveOutcome != nil
    }
    XCTAssertEqual(terminal.liveOutcome, .completed)

    let transcript = try await api.messages(conversationID: conversation.id, limit: 100, before: nil)
    let assistant = try XCTUnwrap(transcript.items.first { $0.role == .assistant })
    XCTAssertEqual(assistant.status, .completed)
    guard case .assistant(let events) = assistant.content else {
      return XCTFail("Expected an assistant transcript")
    }
    XCTAssertTrue(
      events.contains {
        guard case .response(let content, _) = $0 else { return false }
        return content == "Hello from Dash"
      }
    )
    await chat.detach()

    // --- Negative path: tampered signature -> 403, pairing stays pending --

    let tamperedMint = try await WebPairingClient.mintWebPairing(
      controlPlaneURL: environment.controlPlaneURL,
      bearer: environment.bearer,
      gatewayId: gateway.gatewayId,
      deviceLabel: "Live signer flow browser (tampered)"
    )
    XCTAssertEqual(tamperedMint.status, "pending")
    defer {
      Task {
        try? await client.revokePairing(
          gatewayId: gateway.gatewayId,
          pairingId: tamperedMint.pairingId
        )
      }
    }

    let tamperedApproval = try await client.fetchApproval(id: tamperedMint.approvalId)
    let genuineSignature = try await signer.sign(
      approvalId: tamperedApproval.approvalId,
      pairingId: tamperedApproval.pairingId,
      decision: "approve"
    )
    let tamperedSignature = tampered(genuineSignature)
    XCTAssertNotEqual(tamperedSignature, genuineSignature)

    do {
      try await client.postDecision(
        approvalId: tamperedApproval.approvalId,
        decision: "approve",
        signerId: signerId,
        signature: tamperedSignature
      )
      XCTFail("Expected a tampered signature to be rejected")
    } catch ControlPlaneError.forbidden {
      // Expected: `InvalidApprovalSignatureError` maps to 403.
    }

    // The pairing this bad decision targeted must never have activated: a
    // claim attempt still reads back the poll-and-retry `pending` signal, not
    // a credential — proving `decideApproval` really does verify the
    // signature BEFORE any state transition, not merely reject the response
    // while quietly approving server-side.
    let stillPending = try await WebPairingClient.claimCredential(
      controlPlaneURL: environment.controlPlaneURL,
      bearer: environment.bearer,
      gatewayId: gateway.gatewayId,
      pairingId: tamperedMint.pairingId
    )
    XCTAssertEqual(stillPending, .pending)
  }
}

/// Flips the trailing character of a base64url signature to a DIFFERENT
/// base64url character, corrupting the low-order bits of the real Ed25519
/// signature it encodes while staying syntactically valid base64url (so the
/// control plane's `Buffer.from(signature, 'base64url')` still decodes it —
/// this must fail SIGNATURE verification, not request parsing).
private func tampered(_ signature: String) -> String {
  guard let last = signature.last else { return "AA" }
  let replacement: Character = last == "A" ? "B" : "A"
  return String(signature.dropLast()) + String(replacement)
}
