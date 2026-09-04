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
  /// or failed to reach the newly minted grant — OR the gateway it reached
  /// answered `/identity` with a public key that does NOT match the one the
  /// account enrolled with the control plane. Deliberately the same case: a
  /// caller (and the copy it shows) must not have to distinguish "couldn't
  /// verify" from "verified something else", and an attacker learns nothing
  /// from the difference.
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
  private let signer: SignerIdentity
  private let deviceLabel: String
  private let onGrantMinted: @MainActor @Sendable (String, String) -> Void
  private let onConnected: @MainActor @Sendable (ConnectionProfileSnapshot) async throws -> Void
  /// Best-effort signer-registration failure hook — mirrors `onGrantMinted`'s
  /// shape (an injectable, defaulted callback rather than a swallowed
  /// `try?`) so tests can observe it, while the default just logs. Called
  /// AFTER `onConnected` succeeds; never affects `connect(to:)`'s own
  /// throw/return.
  private let onSignerRegistrationFailed: @MainActor @Sendable (any Error) -> Void
  #if DEBUG
    /// See `ConnectionProfile.applyingDebugRelayPortOverride`. Re-applied here
    /// (defensively — `verifier` may or may not have been configured with the
    /// same override) to whatever `VerifiedPairing` verification produces,
    /// before installing, so the persisted profile is guaranteed consistent.
    /// Never compiled into a Release build.
    private let debugRelayPortOverride: Int?
  #endif

  init(
    client: ControlPlaneClient,
    verifier: any PairingVerifying,
    installer: any PairingProfileInstalling,
    signer: SignerIdentity,
    deviceLabel: String,
    onGrantMinted: @escaping @MainActor @Sendable (String, String) -> Void = { _, _ in },
    onConnected: @escaping @MainActor @Sendable (ConnectionProfileSnapshot) async throws -> Void,
    onSignerRegistrationFailed: @escaping @MainActor @Sendable (any Error) -> Void = { error in
      print("AccountConnectFeature: best-effort signer registration failed: \(error)")
    },
    debugRelayPortOverride: Int? = nil
  ) {
    self.client = client
    self.verifier = verifier
    self.installer = installer
    self.signer = signer
    self.deviceLabel = deviceLabel
    self.onGrantMinted = onGrantMinted
    self.onConnected = onConnected
    self.onSignerRegistrationFailed = onSignerRegistrationFailed
    #if DEBUG
      self.debugRelayPortOverride = debugRelayPortOverride
    #else
      _ = debugRelayPortOverride
    #endif
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

    #if DEBUG
      let verified: VerifiedPairing
      do {
        let unadjusted = try await verifier.verify(payload: payload) { _ in }
        if let debugRelayPortOverride, unadjusted.profile.profile.mode == .relay {
          verified = unadjusted.applyingDebugRelayPortOverride(debugRelayPortOverride)
        } else {
          verified = unadjusted
        }
      } catch {
        throw AccountConnectError.verificationFailed
      }
    #else
      let verified: VerifiedPairing
      do {
        verified = try await verifier.verify(payload: payload) { _ in }
      } catch {
        throw AccountConnectError.verificationFailed
      }
    #endif

    // The security hinge of the whole account-connect path. Everything above
    // trusts the CP for WHERE to connect (`gateway.subdomain`) and the relay
    // for WHAT answered; only this compares the two. `verified.identity` is
    // the gateway's own signed-in-fact answer from `/identity` over the
    // established relay connection; `gateway.publicKey` is what the account
    // enrolled through Mission Control. If they disagree, the grant is thrown
    // away UNINSTALLED — no Keychain write, no profile, nothing to resume
    // later. Constant-time comparison is unnecessary: both values are public
    // keys, neither is a secret.
    guard verified.identity.publicKey == gateway.publicKey else {
      throw AccountConnectError.verificationFailed
    }

    let installed: ConnectionProfileSnapshot
    do {
      installed = try await installer.install(verified)
    } catch {
      throw AccountConnectError.installFailed
    }

    try await onConnected(installed)

    // Best-effort: this device is a signer for the account as of ANY
    // successful connect, not just when a browser needs approving — so it's
    // ready to approve a future signer-gated web pairing without a separate
    // enrollment step. Deliberately after `onConnected` and never allowed to
    // fail the connect: an account with a working gateway connection but a
    // still-unregistered signer is a strictly better outcome than losing the
    // connection over a registration hiccup (offline, CP blip, etc.) — a
    // later successful connect gets another chance to register.
    do {
      let publicKey = try await signer.publicKeyB64()
      let signerId = try await client.registerSigner(publicKey: publicKey, label: deviceLabel)
      // So Task 6's scan-to-approve flow can find this device's signerId
      // without re-registering on every approval — see
      // `SignerIdentity.persistSignerId`.
      try await signer.persistSignerId(signerId)
    } catch {
      onSignerRegistrationFailed(error)
    }
  }
}
