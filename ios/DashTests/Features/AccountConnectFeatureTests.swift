import Foundation
import Testing

@testable import Dash

private struct PresenterFixtureError: Error, Sendable {}

/// Echoes the authorize URL's `state` back on the callback, letting
/// `AccountSession.signIn()` complete without any real Clerk interaction.
/// Duplicated from `ControlPlaneClientTests` (that helper is file-private) so
/// this suite can hand `AccountConnectFeature` a real, signed-in
/// `ControlPlaneClient` backed by `URLProtocolStub`.
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

private enum AccountConnectTestError: Error, Equatable {
  case verifierFailure
  case installerFailure
}

/// What `CapturingAccountVerifier` always reports as the gateway's
/// `/identity` public key. A `GatewayInfoDTO` carrying anything else models a
/// control-plane record that disagrees with the gateway actually reached.
private let verifiedPublicKey = "public-key-verified"

@Suite("Account connect feature", .serialized)
@MainActor
struct AccountConnectFeatureTests {
  init() {
    URLProtocolStub.reset()
  }

  @Test("connecting mints, verifies, installs, and hands the installer's snapshot to onConnected")
  func happyPathInstallsAndConnects() async throws {
    let client = try await stubbedClient(
      grant: PairingGrant(
        credential: "relay-cred-1",
        pairingId: "pairing-1",
        chatToken: "chat-1",
        status: "active"
      )
    )
    let verifier = CapturingAccountVerifier()
    let installedSnapshot = fixtureSnapshot(id: UUID(), gatewayID: "gateway-installed")
    let installer = RecordingAccountInstaller(result: installedSnapshot)
    let connected = ConnectedRecorder()
    let feature = AccountConnectFeature(
      client: client,
      verifier: verifier,
      installer: installer,
      signer: makeSigner(),
      deviceLabel: "Gerry's iPhone",
      onConnected: { connected.profiles.append($0) }
    )

    try await feature.connect(
      to: GatewayInfoDTO(
        gatewayId: "gw-1",
        subdomain: "mygw.relay.dash.example",
        status: "online",
        publicKey: verifiedPublicKey
      )
    )

    #expect(connected.profiles == [installedSnapshot])
    let payload = try #require(await verifier.payloads.first)
    #expect(payload.v == 2)
    #expect(payload.host == "mygw.relay.dash.example")
    #expect(payload.mgmtToken == "chat-1")
    #expect(payload.chatToken == "chat-1")
    #expect(payload.relayCredential == "relay-cred-1")
    #expect(await installer.installedPairings.count == 1)
  }

  @Test("the minted grant builds the exact relay profile: verbatim host, ports 443, .relay, secure")
  func buildsExactRelayProfile() async throws {
    let client = try await stubbedClient(
      grant: PairingGrant(
        credential: "relay-cred-2",
        pairingId: "pairing-2",
        chatToken: "chat-2",
        status: "active"
      )
    )
    let verifier = CapturingAccountVerifier()
    let feature = AccountConnectFeature(
      client: client,
      verifier: verifier,
      installer: RecordingAccountInstaller(),
      signer: makeSigner(),
      deviceLabel: "Device",
      onConnected: { _ in }
    )

    try await feature.connect(
      to: GatewayInfoDTO(
        gatewayId: "gw-9",
        subdomain: "gw9.relay.dash.example",
        status: "online",
        publicKey: verifiedPublicKey
      )
    )

    let payload = try #require(await verifier.payloads.first)
    let (profile, secrets) = try payload.validated(profileID: UUID())
    #expect(profile.host == "gw9.relay.dash.example")
    #expect(profile.managementPort == 443)
    #expect(profile.chatPort == 443)
    #expect(profile.mode == .relay)
    #expect(profile.secure == true)
    #expect(secrets.managementToken == "chat-2")
    #expect(secrets.chatToken == "chat-2")
    #expect(secrets.relayCredential == "relay-cred-2")
  }

  @Test("a grant without a chatToken maps to .notEnrolled without verifying or installing")
  func notEnrolledWhenChatTokenAbsent() async throws {
    let client = try await stubbedClient(
      grant: PairingGrant(
        credential: "relay-cred-3",
        pairingId: "pairing-3",
        chatToken: nil,
        status: "active"
      )
    )
    let verifier = CapturingAccountVerifier()
    let installer = RecordingAccountInstaller()
    let feature = AccountConnectFeature(
      client: client,
      verifier: verifier,
      installer: installer,
      signer: makeSigner(),
      deviceLabel: "Device",
      onConnected: { _ in Issue.record("must not connect") }
    )

    await #expect(throws: AccountConnectError.notEnrolled) {
      try await feature.connect(to: gatewayFixture())
    }

    #expect(await verifier.payloads.isEmpty)
    #expect(await installer.installedPairings.isEmpty)
  }

  @Test("a non-active grant status maps to .pendingApproval without verifying or installing")
  func pendingApprovalWhenGrantNotActive() async throws {
    let client = try await stubbedClient(
      grant: PairingGrant(
        credential: "relay-cred-4",
        pairingId: "pairing-4",
        chatToken: "chat-4",
        status: "pending"
      )
    )
    let verifier = CapturingAccountVerifier()
    let installer = RecordingAccountInstaller()
    let feature = AccountConnectFeature(
      client: client,
      verifier: verifier,
      installer: installer,
      signer: makeSigner(),
      deviceLabel: "Device",
      onConnected: { _ in Issue.record("must not connect") }
    )

    await #expect(throws: AccountConnectError.pendingApproval) {
      try await feature.connect(to: gatewayFixture())
    }

    #expect(await verifier.payloads.isEmpty)
    #expect(await installer.installedPairings.isEmpty)
  }

  @Test("a gateway whose verified identity key differs from the CP record never installs")
  func identityPublicKeyMismatchRejectsBeforeInstall() async throws {
    let client = try await stubbedClient(
      grant: PairingGrant(
        credential: "relay-cred-mismatch",
        pairingId: "pairing-mismatch",
        chatToken: "chat-mismatch",
        status: "active"
      )
    )
    let verifier = CapturingAccountVerifier()
    let installer = RecordingAccountInstaller()
    let feature = AccountConnectFeature(
      client: client,
      verifier: verifier,
      installer: installer,
      signer: makeSigner(),
      deviceLabel: "Device",
      onConnected: { _ in Issue.record("must not connect") }
    )

    // Verification itself SUCCEEDS — the gateway that answered is reachable,
    // healthy and capable. It is simply not the gateway this account enrolled.
    await #expect(throws: AccountConnectError.verificationFailed) {
      try await feature.connect(to: gatewayFixture(publicKey: "public-key-someone-else"))
    }

    #expect(await verifier.payloads.count == 1)
    #expect(await installer.installedPairings.isEmpty)
  }

  @Test("a matching identity key installs (the mismatch guard is not blanket-refusing)")
  func identityPublicKeyMatchStillInstalls() async throws {
    let client = try await stubbedClient(
      grant: PairingGrant(
        credential: "relay-cred-match",
        pairingId: "pairing-match",
        chatToken: "chat-match",
        status: "active"
      )
    )
    let installer = RecordingAccountInstaller()
    let feature = AccountConnectFeature(
      client: client,
      verifier: CapturingAccountVerifier(),
      installer: installer,
      signer: makeSigner(),
      deviceLabel: "Device",
      onConnected: { _ in }
    )

    try await feature.connect(to: gatewayFixture(publicKey: verifiedPublicKey))

    let installed = try #require(await installer.installedPairings.first)
    #expect(installed.identity.publicKey == verifiedPublicKey)
  }

  @Test("a verifier failure maps to .verificationFailed and never installs")
  func verifierFailureMapsToVerificationFailed() async throws {
    let client = try await stubbedClient(
      grant: PairingGrant(
        credential: "relay-cred-5",
        pairingId: "pairing-5",
        chatToken: "chat-5",
        status: "active"
      )
    )
    let verifier = CapturingAccountVerifier(error: AccountConnectTestError.verifierFailure)
    let installer = RecordingAccountInstaller()
    let feature = AccountConnectFeature(
      client: client,
      verifier: verifier,
      installer: installer,
      signer: makeSigner(),
      deviceLabel: "Device",
      onConnected: { _ in Issue.record("must not connect") }
    )

    await #expect(throws: AccountConnectError.verificationFailed) {
      try await feature.connect(to: gatewayFixture())
    }

    #expect(await installer.installedPairings.isEmpty)
  }

  @Test("an installer failure maps to .installFailed after verification already succeeded")
  func installerFailureMapsToInstallFailed() async throws {
    let client = try await stubbedClient(
      grant: PairingGrant(
        credential: "relay-cred-6",
        pairingId: "pairing-6",
        chatToken: "chat-6",
        status: "active"
      )
    )
    let verifier = CapturingAccountVerifier()
    let installer = RecordingAccountInstaller(error: AccountConnectTestError.installerFailure)
    let connected = ConnectedRecorder()
    let feature = AccountConnectFeature(
      client: client,
      verifier: verifier,
      installer: installer,
      signer: makeSigner(),
      deviceLabel: "Device",
      onConnected: { connected.profiles.append($0) }
    )

    await #expect(throws: AccountConnectError.installFailed) {
      try await feature.connect(to: gatewayFixture())
    }

    #expect(await verifier.payloads.count == 1)
    #expect(connected.profiles.isEmpty)
  }

  @Test("debugRelayPortOverride overrides the installed profile's relay ports (DEBUG-only test seam)")
  func debugRelayPortOverrideAppliesToInstalledProfile() async throws {
    let client = try await stubbedClient(
      grant: PairingGrant(
        credential: "relay-cred-7",
        pairingId: "pairing-7",
        chatToken: "chat-7",
        status: "active"
      )
    )
    let verifier = CapturingAccountVerifier()
    let installer = RecordingAccountInstaller()
    let feature = AccountConnectFeature(
      client: client,
      verifier: verifier,
      installer: installer,
      signer: makeSigner(),
      deviceLabel: "Device",
      onConnected: { _ in },
      debugRelayPortOverride: 18443
    )

    try await feature.connect(to: gatewayFixture())

    let installed = try #require(await installer.installedPairings.first)
    #expect(installed.profile.profile.managementPort == 18443)
    #expect(installed.profile.profile.chatPort == 18443)
    #expect(installed.profile.profile.mode == .relay)
  }

  @Test("without debugRelayPortOverride the installed profile keeps production's port 443")
  func noDebugRelayPortOverrideKeepsProductionPort() async throws {
    let client = try await stubbedClient(
      grant: PairingGrant(
        credential: "relay-cred-8",
        pairingId: "pairing-8",
        chatToken: "chat-8",
        status: "active"
      )
    )
    let verifier = CapturingAccountVerifier()
    let installer = RecordingAccountInstaller()
    let feature = AccountConnectFeature(
      client: client,
      verifier: verifier,
      installer: installer,
      signer: makeSigner(),
      deviceLabel: "Device",
      onConnected: { _ in }
    )

    try await feature.connect(to: gatewayFixture())

    let installed = try #require(await installer.installedPairings.first)
    #expect(installed.profile.profile.managementPort == 443)
    #expect(installed.profile.profile.chatPort == 443)
  }

  @Test("a successful connect registers this device's signer public key under the device label")
  func successfulConnectRegistersSigner() async throws {
    let client = try await stubbedClient(
      grant: PairingGrant(
        credential: "relay-cred-signer",
        pairingId: "pairing-signer",
        chatToken: "chat-signer",
        status: "active"
      )
    )
    URLProtocolStub.enqueue(status: 201, data: Data(#"{"signerId":"signer-1"}"#.utf8))
    let signer = makeSigner()
    let expectedPublicKey = try await signer.publicKeyB64()
    let feature = AccountConnectFeature(
      client: client,
      verifier: CapturingAccountVerifier(),
      installer: RecordingAccountInstaller(),
      signer: signer,
      deviceLabel: "Gerry's iPhone",
      onConnected: { _ in }
    )

    try await feature.connect(to: gatewayFixture())

    let request = try #require(URLProtocolStub.requests.last)
    #expect(request.httpMethod == "POST")
    #expect(request.url?.path == "/v1/signers")
    let body = try #require(request.httpBody)
    let json = try #require(JSONSerialization.jsonObject(with: body) as? [String: String])
    #expect(json == ["publicKey": expectedPublicKey, "label": "Gerry's iPhone"])
    // Task 6's scan-to-approve flow reads this back via `signer.signerId()`
    // instead of re-registering on every approval.
    #expect(try await signer.signerId() == "signer-1")
  }

  @Test("a signer registration failure is swallowed and never fails connect")
  func signerRegistrationFailureDoesNotFailConnect() async throws {
    let client = try await stubbedClient(
      grant: PairingGrant(
        credential: "relay-cred-signer-fail",
        pairingId: "pairing-signer-fail",
        chatToken: "chat-signer-fail",
        status: "active"
      )
    )
    // Deliberately no third stubbed response: the registerSigner request
    // finds an empty queue and fails with `.network` — this must not
    // propagate out of `connect(to:)`.
    let connected = ConnectedRecorder()
    var reportedFailure: (any Error)?
    let signer = makeSigner()
    let feature = AccountConnectFeature(
      client: client,
      verifier: CapturingAccountVerifier(),
      installer: RecordingAccountInstaller(),
      signer: signer,
      deviceLabel: "Device",
      onConnected: { connected.profiles.append($0) },
      onSignerRegistrationFailed: { error in reportedFailure = error }
    )

    try await feature.connect(to: gatewayFixture())

    #expect(connected.profiles.count == 1)
    #expect(reportedFailure as? ControlPlaneError == .network)
    // Never got a signerId back, so there is nothing to persist.
    #expect(try await signer.signerId() == nil)
  }
}

// MARK: - Fakes

private actor CapturingAccountVerifier: PairingVerifying {
  private(set) var payloads: [PairingPayload] = []
  private let error: (any Error)?

  init(error: (any Error)? = nil) {
    self.error = error
  }

  func verify(
    payload: PairingPayload,
    onStep: @escaping @MainActor @Sendable (PairingVerificationStep) -> Void
  ) async throws -> VerifiedPairing {
    payloads.append(payload)
    await onStep(.reachability)
    if let error {
      throw error
    }
    let (profile, secrets) = try payload.validated(profileID: UUID())
    let identity = GatewayIdentityDTO(gatewayId: "gateway-verified", publicKey: verifiedPublicKey)
    var identified = profile
    identified.gatewayId = identity.gatewayId
    identified.publicKey = identity.publicKey
    return VerifiedPairing(
      profile: ConnectionProfileSnapshot(gatewayID: identity.gatewayId, profile: identified),
      identity: identity,
      secrets: secrets
    )
  }
}

private actor RecordingAccountInstaller: PairingProfileInstalling {
  private let result: ConnectionProfileSnapshot?
  private let error: (any Error)?
  private(set) var installedPairings: [VerifiedPairing] = []

  init(result: ConnectionProfileSnapshot? = nil, error: (any Error)? = nil) {
    self.result = result
    self.error = error
  }

  func install(_ pairing: VerifiedPairing) async throws -> ConnectionProfileSnapshot {
    installedPairings.append(pairing)
    if let error {
      throw error
    }
    return result ?? pairing.profile
  }
}

@MainActor
private final class ConnectedRecorder {
  var profiles: [ConnectionProfileSnapshot] = []
}

/// Trivial in-memory `KeychainStoring`, dedicated to backing a throwaway
/// `SignerIdentity` per test — none of these tests assert anything about the
/// signer's own key material, they only need `AccountConnectFeature`'s
/// `signer:` parameter satisfied.
private actor FakeSignerKeychain: KeychainStoring {
  private var storage: [UUID: ConnectionSecrets] = [:]

  func save(_ secrets: ConnectionSecrets, for profileID: UUID) async throws {
    storage[profileID] = secrets
  }

  func load(for profileID: UUID) async throws -> ConnectionSecrets? {
    storage[profileID]
  }

  func delete(for profileID: UUID) async throws {
    storage[profileID] = nil
  }
}

// MARK: - Helpers

private func makeSigner() -> SignerIdentity {
  SignerIdentity(keychain: FakeSignerKeychain())
}

private func gatewayFixture(
  gatewayId: String = "gw-1",
  subdomain: String = "mygw.relay.dash.example",
  status: String = "online",
  publicKey: String = verifiedPublicKey
) -> GatewayInfoDTO {
  GatewayInfoDTO(
    gatewayId: gatewayId,
    subdomain: subdomain,
    status: status,
    publicKey: publicKey
  )
}

private func fixtureSnapshot(id: UUID, gatewayID: String) -> ConnectionProfileSnapshot {
  ConnectionProfileSnapshot(
    gatewayID: gatewayID,
    profile: ConnectionProfile(
      id: id,
      gatewayId: gatewayID,
      publicKey: "public-key",
      label: "Installed gateway",
      host: "installed.relay.dash.example",
      managementPort: 443,
      chatPort: 443,
      secure: true,
      mode: .relay,
      createdAt: Date(timeIntervalSince1970: 1),
      lastSuccessfulSyncAt: nil
    )
  )
}

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
/// directory afterward (success or throw). Mirrors `ControlPlaneClientTests`.
private func withConfigBundle<T>(
  _ entries: [String: String],
  _ body: (Bundle) throws -> T
) throws -> T {
  let directory = FileManager.default.temporaryDirectory
    .appendingPathComponent("AccountConnectFeatureTests-\(UUID().uuidString)", isDirectory: true)
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  defer { try? FileManager.default.removeItem(at: directory) }

  let data = try PropertyListSerialization.data(fromPropertyList: entries, format: .xml, options: 0)
  try data.write(to: directory.appendingPathComponent("Info.plist"))
  let bundle = try #require(Bundle(url: directory))
  return try body(bundle)
}

/// Drives a real `AccountSession.signIn()` against the shared `URLProtocolStub`
/// queue, then enqueues `grant` as the `createPairing` response, and returns a
/// `ControlPlaneClient` ready for `AccountConnectFeature.connect(to:)` to mint
/// against. Mirrors `ControlPlaneClientTests.signedInSession`.
private func stubbedClient(
  grant: PairingGrant,
  idToken: String = "id-token-account-connect"
) async throws -> ControlPlaneClient {
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

  var grantBody: [String: Any] = [
    "credential": grant.credential,
    "pairingId": grant.pairingId,
    "status": grant.status,
  ]
  if let chatToken = grant.chatToken {
    grantBody["chatToken"] = chatToken
  }
  URLProtocolStub.enqueue(
    status: 200,
    data: try JSONSerialization.data(withJSONObject: grantBody)
  )

  return ControlPlaneClient(config: try makeConfig(), tokens: session, session: testURLSession())
}
