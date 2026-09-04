import Foundation
import Testing
@testable import Dash

@Suite("pairing payload fixtures")
struct PairingFixtureTests {
  @Test("LAN payload preserves raw fields")
  func lanPayload() throws {
    let payload = try FixtureLoader.decode(PairingPayload.self, "pairing-lan-v1.json")
    #expect(payload.v == 1)
    #expect(payload.host == "192.168.1.50")
    #expect(payload.mgmtToken == "mgmt-test-token")
    #expect(payload.chatToken == "chat-test-token")
    #expect(payload.mgmtPort == 9300)
    #expect(payload.chatPort == 9200)
    #expect(payload.secure == false)
    #expect(payload.relayCredential == nil)
  }

  @Test("relay payload preserves raw fields")
  func relayPayload() throws {
    let payload = try FixtureLoader.decode(PairingPayload.self, "pairing-relay-v2.json")
    #expect(payload.v == 2)
    #expect(payload.host == "gateway-01.relay.dash.example")
    #expect(payload.mgmtToken == "mobile-test-token")
    #expect(payload.chatToken == "mobile-test-token")
    #expect(payload.mgmtPort == nil)
    #expect(payload.chatPort == nil)
    #expect(payload.secure == true)
    #expect(payload.relayCredential == "relay-device-credential")
  }

  @Test("canonical secure pairing fixtures validate")
  func canonicalValidation() throws {
    let lan = try FixtureLoader.decode(PairingPayload.self, "pairing-lan-v3.json")
    let relay = try FixtureLoader.decode(PairingPayload.self, "pairing-relay-v2.json")
    #expect(try lan.validated(profileID: UUID()).0.mode == .lan)
    #expect(try relay.validated(profileID: UUID()).0.mode == .relay)
  }

  @Test("legacy plaintext LAN fixture remains rejected")
  func legacyLanRejection() throws {
    let legacy = try FixtureLoader.decode(PairingPayload.self, "pairing-lan-v1.json")
    #expect(throws: PairingValidationError.insecureLanPairing) {
      try legacy.validated(profileID: UUID())
    }
  }

  @Test("schema-invalid pairing producers fail semantic validation")
  func invalidProducers() throws {
    let unsupported = try FixtureLoader.decode(
      PairingPayload.self,
      "errors/unsupported-pairing-version.json"
    )
    let missingCredential = try FixtureLoader.decode(
      PairingPayload.self,
      "errors/missing-relay-credential.json"
    )
    #expect(throws: PairingValidationError.self) {
      try unsupported.validated(profileID: UUID())
    }
    #expect(throws: PairingValidationError.self) {
      try missingCredential.validated(profileID: UUID())
    }
  }
}
