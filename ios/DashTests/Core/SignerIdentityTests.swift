import CryptoKit
import Foundation
import Testing

@testable import Dash

/// A trivial in-memory `KeychainStoring` — no `SecItem*` calls, just a
/// dictionary keyed by `profileID`. Mirrors `RecordingPairingKeychain` in
/// `PairingPipelineTests` but only needs load/save (no delete assertions).
private actor FakeKeychain: KeychainStoring {
  private var storage: [UUID: ConnectionSecrets] = [:]
  private(set) var saveCount = 0

  func save(_ secrets: ConnectionSecrets, for profileID: UUID) async throws {
    storage[profileID] = secrets
    saveCount += 1
  }

  func load(for profileID: UUID) async throws -> ConnectionSecrets? {
    storage[profileID]
  }

  func delete(for profileID: UUID) async throws {
    storage[profileID] = nil
  }
}

@Suite("Signer identity")
struct SignerIdentityTests {
  @Test("publicKeyB64 creates a key on first use and is stable across repeated calls")
  func publicKeyStableAcrossCalls() async throws {
    let identity = SignerIdentity(keychain: FakeKeychain())

    let first = try await identity.publicKeyB64()
    let second = try await identity.publicKeyB64()

    #expect(first == second)
  }

  @Test("the private key persists in the keychain and survives a fresh SignerIdentity instance")
  func keyPersistsAcrossInstances() async throws {
    let keychain = FakeKeychain()
    let first = SignerIdentity(keychain: keychain)
    let originalKey = try await first.publicKeyB64()

    let second = SignerIdentity(keychain: keychain)
    let reloadedKey = try await second.publicKeyB64()

    #expect(originalKey == reloadedKey)
  }

  @Test("two SignerIdentity instances over independent keychains mint different keys")
  func independentKeychainsMintDifferentKeys() async throws {
    let a = SignerIdentity(keychain: FakeKeychain())
    let b = SignerIdentity(keychain: FakeKeychain())

    let keyA = try await a.publicKeyB64()
    let keyB = try await b.publicKeyB64()

    #expect(keyA != keyB)
  }

  @Test("publicKeyB64 is unpadded base64url of the raw 32-byte Ed25519 public key")
  func publicKeyIsUnpaddedBase64URL() async throws {
    let identity = SignerIdentity(keychain: FakeKeychain())

    let publicKeyB64 = try await identity.publicKeyB64()

    #expect(!publicKeyB64.contains("+"))
    #expect(!publicKeyB64.contains("/"))
    #expect(!publicKeyB64.contains("="))
    let decoded = try #require(Data(base64URLEncoded: publicKeyB64))
    #expect(decoded.count == 32)
    // Round-trips through CryptoKit's own Ed25519 public-key constructor.
    _ = try Curve25519.Signing.PublicKey(rawRepresentation: decoded)
  }

  @Test("sign produces an unpadded base64url signature that verifies over the exact message bytes")
  func signatureVerifiesOverExactMessageBytes() async throws {
    let identity = SignerIdentity(keychain: FakeKeychain())
    let approvalId = "approval-123"
    let pairingId = "pairing-456"
    let decision = "approve"

    let signatureB64 = try await identity.sign(
      approvalId: approvalId,
      pairingId: pairingId,
      decision: decision
    )
    let publicKeyB64 = try await identity.publicKeyB64()

    #expect(!signatureB64.contains("+"))
    #expect(!signatureB64.contains("/"))
    #expect(!signatureB64.contains("="))

    let publicKeyData = try #require(Data(base64URLEncoded: publicKeyB64))
    let signatureData = try #require(Data(base64URLEncoded: signatureB64))
    let publicKey = try Curve25519.Signing.PublicKey(rawRepresentation: publicKeyData)

    // MUST match `approvalMessage()` in
    // apps/relay-control-plane/src/provisioning.ts byte-for-byte:
    // `${approvalId}\n${pairingId}\n${decision}`, UTF-8.
    let expectedMessage = Data("\(approvalId)\n\(pairingId)\n\(decision)".utf8)
    #expect(publicKey.isValidSignature(signatureData, for: expectedMessage))
  }

  @Test("sign over a different decision value produces a signature that fails to verify")
  func signatureDoesNotVerifyForATamperedDecision() async throws {
    let identity = SignerIdentity(keychain: FakeKeychain())
    let signatureB64 = try await identity.sign(
      approvalId: "approval-123",
      pairingId: "pairing-456",
      decision: "approve"
    )
    let publicKeyData = try #require(Data(base64URLEncoded: try await identity.publicKeyB64()))
    let signatureData = try #require(Data(base64URLEncoded: signatureB64))
    let publicKey = try Curve25519.Signing.PublicKey(rawRepresentation: publicKeyData)

    let tamperedMessage = Data("approval-123\npairing-456\ndeny".utf8)
    #expect(!publicKey.isValidSignature(signatureData, for: tamperedMessage))
  }

  @Test("the signer's key is stored under a fixed namespace distinct from a real connection profileID")
  func signerStorageDoesNotCollideWithConnectionProfiles() async throws {
    let keychain = FakeKeychain()
    let identity = SignerIdentity(keychain: keychain)
    _ = try await identity.publicKeyB64()

    let unrelatedProfileID = UUID()
    let unrelatedSecrets = ConnectionSecrets(
      managementToken: "mgmt",
      chatToken: "chat",
      relayCredential: "cred"
    )
    try await keychain.save(unrelatedSecrets, for: unrelatedProfileID)

    // The signer's own namespaced entry is untouched by an unrelated
    // connection profile's save, and vice versa: reloading the signer still
    // yields the same key.
    let reloaded = try await keychain.load(for: unrelatedProfileID)
    #expect(reloaded == unrelatedSecrets)
    let stillSameKey = try await SignerIdentity(keychain: keychain).publicKeyB64()
    let originalKey = try await identity.publicKeyB64()
    #expect(stillSameKey == originalKey)
  }

  @Test("signerId is nil before any registration has been recorded")
  func signerIDIsNilBeforePersisted() async throws {
    let identity = SignerIdentity(keychain: FakeKeychain())
    // Creating the key alone (no registration yet) must not fabricate one.
    _ = try await identity.publicKeyB64()

    #expect(try await identity.signerId() == nil)
  }

  @Test("persistSignerId makes signerId return the persisted value")
  func persistSignerIDIsReadableAfterward() async throws {
    let identity = SignerIdentity(keychain: FakeKeychain())

    try await identity.persistSignerId("signer-abc")

    #expect(try await identity.signerId() == "signer-abc")
  }

  @Test("persistSignerId survives across a fresh SignerIdentity instance over the same keychain")
  func persistedSignerIDSurvivesAcrossInstances() async throws {
    let keychain = FakeKeychain()
    let first = SignerIdentity(keychain: keychain)
    try await first.persistSignerId("signer-xyz")

    let second = SignerIdentity(keychain: keychain)
    #expect(try await second.signerId() == "signer-xyz")
  }

  @Test("persistSignerId does not change the device's signing key")
  func persistSignerIDPreservesTheSigningKey() async throws {
    let identity = SignerIdentity(keychain: FakeKeychain())
    let keyBeforePersist = try await identity.publicKeyB64()

    try await identity.persistSignerId("signer-preserve")

    #expect(try await identity.publicKeyB64() == keyBeforePersist)
  }

  @Test("persistSignerId called before any key exists creates one rather than throwing")
  func persistSignerIDCreatesKeyIfNeeded() async throws {
    let keychain = FakeKeychain()
    let identity = SignerIdentity(keychain: keychain)

    try await identity.persistSignerId("signer-fresh")

    #expect(try await identity.signerId() == "signer-fresh")
    // The key it created is stable across a fresh instance, exactly like the
    // create-on-first-use path `publicKeyStableAcrossCalls` exercises.
    let reloaded = SignerIdentity(keychain: keychain)
    #expect(try await reloaded.publicKeyB64() == (try await identity.publicKeyB64()))
  }

  @Test("persisting a second signerId overwrites the first")
  func persistSignerIDOverwritesPreviousValue() async throws {
    let identity = SignerIdentity(keychain: FakeKeychain())
    try await identity.persistSignerId("signer-old")

    try await identity.persistSignerId("signer-new")

    #expect(try await identity.signerId() == "signer-new")
  }
}

// MARK: - Test helper

extension Data {
  /// Decodes unpadded base64url (the wire form `SignerIdentity` produces) back
  /// into raw bytes for CryptoKit round-trip assertions in this file.
  fileprivate init?(base64URLEncoded string: String) {
    var base64 = string
      .replacingOccurrences(of: "-", with: "+")
      .replacingOccurrences(of: "_", with: "/")
    while base64.count % 4 != 0 {
      base64.append("=")
    }
    self.init(base64Encoded: base64)
  }
}
