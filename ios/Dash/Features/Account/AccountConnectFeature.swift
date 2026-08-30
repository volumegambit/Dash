import Foundation

/// Failures surfaced by `AccountConnectFeature.connect(to:)`. Distinct from
/// `ControlPlaneError` (which this feature also lets propagate unmapped) and
/// from the manual/QR pairing failures in `PairingFeature` — this is the
/// account-authenticated connect path's own error surface.
enum AccountConnectError: Error, Equatable {
  /// The signed-in account is not chat-enrolled on this gateway
  /// (`grant.chatToken` was absent).
  case notEnrolled
  /// The mint succeeded but the pairing still needs device-side approval
  /// (`grant.status != "active"`).
  case pendingApproval
  /// The relay-verified gateway (health/identity/agents/chat probe) rejected
  /// or failed to reach the newly minted grant.
  case verificationFailed
  /// The verified pairing could not be installed (Keychain/metadata).
  case installFailed
}

/// Drives the account-authenticated connect pipeline: mint a pairing grant
/// from the control plane for a chosen gateway, turn it into a relay
/// `PairingPayload`, and run it through the same verify + install machinery
/// QR/manual pairing already uses (`PairingVerifying`, `PairingProfileInstalling`).
@MainActor
final class AccountConnectFeature {
  private let client: ControlPlaneClient
  private let verifier: any PairingVerifying
  private let installer: any PairingProfileInstalling
  private let deviceLabel: String
  private let onGrantMinted: @MainActor @Sendable (String, String) -> Void
  private let onConnected: @MainActor @Sendable (ConnectionProfileSnapshot) async throws -> Void

  init(
    client: ControlPlaneClient,
    verifier: any PairingVerifying,
    installer: any PairingProfileInstalling,
    deviceLabel: String,
    onGrantMinted: @escaping @MainActor @Sendable (String, String) -> Void = { _, _ in },
    onConnected: @escaping @MainActor @Sendable (ConnectionProfileSnapshot) async throws -> Void
  ) {
    self.client = client
    self.verifier = verifier
    self.installer = installer
    self.deviceLabel = deviceLabel
    self.onGrantMinted = onGrantMinted
    self.onConnected = onConnected
  }

  /// Mints a mobile pairing grant for `gateway`, then verifies and installs it
  /// exactly like a scanned/manual relay pairing would.
  func connect(to gateway: GatewayInfoDTO) async throws {
    let grant = try await client.createPairing(gatewayId: gateway.gatewayId, deviceLabel: deviceLabel)
    // Reported regardless of the grant's outcome below so a caller (the
    // gateway picker UI) can best-effort revoke an abandoned mint — e.g. if
    // the account signs out before a `.pendingApproval`/`.notEnrolled` grant
    // is ever completed. Default no-op preserves existing callers' behavior.
    onGrantMinted(gateway.gatewayId, grant.pairingId)

    guard grant.status == "active" else {
      throw AccountConnectError.pendingApproval
    }
    guard let chatToken = grant.chatToken else {
      throw AccountConnectError.notEnrolled
    }

    // The canonical v2 relay payload shape: both mobile tokens equal
    // (required by `PairingPayload.validated`), no explicit ports
    // (validated() pins these to 443), `gateway.subdomain` carried verbatim
    // as the host.
    let payload = PairingPayload(
      v: 2,
      host: gateway.subdomain,
      mgmtToken: chatToken,
      chatToken: chatToken,
      mgmtPort: nil,
      chatPort: nil,
      label: nil,
      secure: true,
      relayCredential: grant.credential
    )

    let verified: VerifiedPairing
    do {
      verified = try await verifier.verify(payload: payload) { _ in }
    } catch {
      throw AccountConnectError.verificationFailed
    }

    let installed: ConnectionProfileSnapshot
    do {
      installed = try await installer.install(verified)
    } catch {
      throw AccountConnectError.installFailed
    }

    try await onConnected(installed)
  }
}
