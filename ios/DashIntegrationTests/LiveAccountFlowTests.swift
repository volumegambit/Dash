import Foundation
import XCTest

@testable import Dash

/// Task 9: the sign-in-shaped mint against a REAL control plane + relay +
/// gateway, then one chat round-trip. Unlike every other test in this target
/// (which drives a gateway reached directly over pinned-cert LAN TLS via
/// `LiveGatewayEnvironment`), this one drives the account sign-in surface
/// end to end exactly as the app does:
///
///   `ControlPlaneClient.listGateways` -> `AccountConnectFeature.connect`
///   (mint -> `PairingVerifying` -> `PairingProfileInstalling`) -> a live
///   `ChatConnection` built from the installed profile + its real Keychain
///   secrets.
///
/// `ios/scripts/run-live-account-flow-test.mjs` boots the real pieces this
/// exercises: a relay (hosted mode), a control plane (`RELAY_CP_DEV_STUB_AUTH`),
/// and the SAME scripted gateway `LiveGatewayEnvironment`'s suite uses,
/// enrolled and dialed into the relay with its own Ed25519 holder-of-key
/// identity — then a TLS terminator on a high port the simulator is told to
/// trust via `simctl keychain add-root-cert`. Production always terminates
/// v2/relay pairings on port 443 (`ConnectionEndpoint.swift`'s `validated()`);
/// this host can bind neither 127.0.0.1:443 (EACCES, unprivileged) nor
/// 0.0.0.0:443 (owned by another local service), so this test drives the
/// `#if DEBUG`-only `applyingDebugRelayPortOverride` seam instead — applied
/// AFTER `validated()` runs (see `PairingVerifier`/`AccountConnectFeature`),
/// never touching `validated()`'s hardcoded-443 production invariant.
final class LiveAccountFlowTests: XCTestCase {
  @MainActor
  func testAccountSignInMintAndChat() async throws {
    let environment = try LiveAccountFlowEnvironment.processInfo()

    let config = AccountAuthConfig(
      frontendAPIHost: "unused.invalid",
      clientID: "unused",
      controlPlaneURL: environment.controlPlaneURL,
      redirectURI: "dash://oauth-callback"
    )
    // The DEBUG-only pre-signed-in seed (T7): the control plane's dev stub
    // accepts any bearer as the account id, so no real PKCE round trip runs.
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

    // The SAME verify + install machinery QR/manual pairing use (mirrors
    // `AppDependencies.live()`'s wiring) — proves the account sign-in path
    // lands on a normal, production-shaped connection profile.
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
    let metadataStore = PersistencePairingMetadataStore(store: try PersistenceStore.inMemory())
    let keychain = SystemKeychainStore()
    let installer = PairingProfileInstaller(keychain: keychain, metadata: metadataStore)

    var mintedPairing: (gatewayId: String, pairingId: String)?
    var installedProfile: ConnectionProfileSnapshot?
    let feature = AccountConnectFeature(
      client: client,
      verifier: pairingVerifier,
      installer: installer,
      deviceLabel: "Dash iOS live integration test",
      onGrantMinted: { gatewayId, pairingId in mintedPairing = (gatewayId, pairingId) },
      onConnected: { profile in installedProfile = profile },
      debugRelayPortOverride: environment.relayPort
    )
    defer {
      if let mintedPairing {
        Task {
          try? await client.revokePairing(
            gatewayId: mintedPairing.gatewayId,
            pairingId: mintedPairing.pairingId
          )
        }
      }
    }

    try await feature.connect(to: gateway)

    let profile = try XCTUnwrap(installedProfile, "Expected AccountConnectFeature to install a profile")
    // The installed profile's gatewayID is the gateway's OWN self-reported
    // identity (what its /identity route answers), which `PairingVerifier`
    // trusts over the CP registration label (`environment.gatewayID`, "127" —
    // chosen purely for relay-routing, see the harness header comment).
    XCTAssertEqual(profile.gatewayID, environment.identityGatewayID)
    XCTAssertEqual(profile.profile.mode, .relay)
    XCTAssertTrue(profile.profile.secure)
    XCTAssertEqual(profile.profile.managementPort, environment.relayPort)
    XCTAssertEqual(profile.profile.chatPort, environment.relayPort)
    defer { Task { try? await keychain.delete(for: profile.id) } }

    let loadedSecrets = try await keychain.load(for: profile.id)
    let secrets = try XCTUnwrap(
      loadedSecrets,
      "Expected the installed pairing's secrets to be in the Keychain"
    )
    let endpoint = ConnectionEndpoint(profile: profile.profile, secrets: secrets)

    // One chat round-trip over the relay, mirroring `ChatResumeIntegrationTests`'
    // style but against the account-authenticated connection this test built.
    let chat = ChatConnection(endpoint: endpoint, clock: clock)
    let recording = await LiveChatRecording.start(chat: chat)
    defer { recording.cancel() }

    let api = GatewayAPI(transport: makeTransport(endpoint, secrets))
    let conversation = try await api.createConversation(
      CreateConversationRequest(
        agentId: environment.agentID,
        requestId: UUID().uuidString.lowercased(),
        title: "iOS live account flow",
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
  }
}
