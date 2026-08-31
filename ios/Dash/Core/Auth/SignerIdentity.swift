import CryptoKit
import Foundation

/// This device's Ed25519 signing identity for signer-gated approvals (Task 3's
/// `/v1/approvals/*` control-plane routes): a phone that already trusts an
/// account can approve/deny a NEW device (e.g. a browser) pairing to that
/// account's gateway. The key pair is generated once, on first use, and
/// persisted so the same identity survives app relaunches — there is no
/// server-side recovery path, so losing the Keychain entry means becoming a
/// new signer (re-registering via `ControlPlaneClient.registerSigner`).
///
/// Storage: reuses `KeychainStoring`'s `ConnectionSecrets`-for-`profileID`
/// shape (and, via `SystemKeychainStore`, the SAME Keychain service,
/// `app.dash.ios.gateway-secrets`) instead of adding a second Keychain
/// service just for one more secret. The raw 32-byte private key lives in
/// `ConnectionSecrets.managementToken` as plain (non-URL) base64 — this is
/// Keychain-internal storage, not the wire format — under
/// `SignerIdentity.keychainNamespace`, a fixed constant UUID that is never
/// used as a real connection's `profileID` (those are always freshly
/// generated with `UUID()` at pairing/install time), so this entry can never
/// collide with or be overwritten by a paired gateway's connection secrets.
/// `chatToken`/`relayCredential` are unused placeholders required by the
/// `ConnectionSecrets` shape.
actor SignerIdentity {
  static let keychainNamespace = UUID(uuidString: "5E16E4B0-51A1-4B0E-9C4A-51A1E4B00001")!

  private let keychain: any KeychainStoring
  private var cachedKey: Curve25519.Signing.PrivateKey?

  init(keychain: any KeychainStoring) {
    self.keychain = keychain
  }

  /// Unpadded base64url of the raw 32-byte Ed25519 public key
  /// (`Curve25519.Signing.PrivateKey.publicKey.rawRepresentation`). Creates
  /// (and persists) the key pair on first call if none exists yet.
  func publicKeyB64() async throws -> String {
    let key = try await loadOrCreateKey()
    return Self.base64URLUnpadded(key.publicKey.rawRepresentation)
  }

  /// Signs the exact approval-decision message the control plane's
  /// `approvalMessage()` builds server-side
  /// (`apps/relay-control-plane/src/provisioning.ts`) — MUST stay
  /// byte-for-byte identical to that function's wire format:
  /// `${approvalId}\n${pairingId}\n${decision}`, UTF-8. Any drift here means
  /// every decision this device signs 403s at `POST /v1/approvals/:id/decision`.
  /// Returns the signature as unpadded base64url.
  func sign(approvalId: String, pairingId: String, decision: String) async throws -> String {
    let key = try await loadOrCreateKey()
    let message = "\(approvalId)\n\(pairingId)\n\(decision)"
    let signature = try key.signature(for: Data(message.utf8))
    return Self.base64URLUnpadded(signature)
  }

  private func loadOrCreateKey() async throws -> Curve25519.Signing.PrivateKey {
    if let cachedKey {
      return cachedKey
    }
    if let stored = try await keychain.load(for: Self.keychainNamespace),
      let raw = Data(base64Encoded: stored.managementToken),
      let key = try? Curve25519.Signing.PrivateKey(rawRepresentation: raw)
    {
      cachedKey = key
      return key
    }
    let key = Curve25519.Signing.PrivateKey()
    try await keychain.save(
      ConnectionSecrets(
        managementToken: key.rawRepresentation.base64EncodedString(),
        chatToken: "",
        relayCredential: nil
      ),
      for: Self.keychainNamespace
    )
    cachedKey = key
    return key
  }

  /// This device's `signerId`, if `registerSigner` has ever completed and
  /// been recorded here (Task 6 calls `persistSignerId` right after a
  /// successful registration). `nil` until then — a fresh install, or one
  /// whose best-effort registration (`AccountConnectFeature.connect`) never
  /// succeeded, has a signing key but no registered `signerId` yet.
  func signerId() async throws -> String? {
    try await keychain.load(for: Self.keychainNamespace)?.relayCredential
  }

  /// Records `signerId` alongside this device's existing signing key so a
  /// later `signerId()` call returns it. Reuses `ConnectionSecrets`'
  /// otherwise-unused `relayCredential` slot (see the type doc comment) —
  /// there is no dedicated storage for this, and adding one would mean a
  /// second Keychain entry for what is conceptually one signer identity.
  /// Ensures a key exists first (creating one if this is somehow called
  /// before any `publicKeyB64()`/`sign(...)`) so the save never clobbers an
  /// as-yet-nonexistent key with a signerId-only record.
  func persistSignerId(_ signerId: String) async throws {
    let key = try await loadOrCreateKey()
    try await keychain.save(
      ConnectionSecrets(
        managementToken: key.rawRepresentation.base64EncodedString(),
        chatToken: "",
        relayCredential: signerId
      ),
      for: Self.keychainNamespace
    )
  }

  /// Wipes this device's ENTIRE signer identity — both the signing key and
  /// any persisted `signerId` — from the Keychain, and drops the in-memory
  /// cache. Called by `AppModel.signOutOfAccount()` so a signerId registered
  /// under one account can never be silently reused after signing into a
  /// DIFFERENT account on the same device: without this, `resolveSignerId()`
  /// would keep returning the previous account's stale `signerId` forever,
  /// and every approval decision would 403 with no path to recovery short of
  /// reinstalling. After this call, the next `publicKeyB64()`/`sign(...)`
  /// mints a brand-new key pair, and the next successful gateway connect
  /// (`AccountConnectFeature.connect`) re-registers it fresh under whichever
  /// account is signed in at that point.
  func reset() async throws {
    cachedKey = nil
    try await keychain.delete(for: Self.keychainNamespace)
  }

  private static func base64URLUnpadded(_ data: Data) -> String {
    data.base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }
}
