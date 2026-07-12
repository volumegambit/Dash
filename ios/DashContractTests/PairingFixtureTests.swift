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
    #expect(payload.mgmtToken == "mgmt-test-token")
    #expect(payload.chatToken == "chat-test-token")
    #expect(payload.mgmtPort == nil)
    #expect(payload.chatPort == nil)
    #expect(payload.secure == true)
    #expect(payload.relayCredential == "relay-device-credential")
  }
}
