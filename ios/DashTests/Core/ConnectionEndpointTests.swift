import Foundation
import Testing

@testable import Dash

@Suite("connection endpoint and pairing validation")
struct ConnectionEndpointTests {
  @Test(
    arguments: [
      "https://host", "host/path", "host/", "host?x=1", "host#fragment", "host%2Fpath",
      "host%3Fx=1", "user%40host", "host%20evil", "host%00evil",
    ]
  )
  func rejectsNonHostInput(_ host: String) throws {
    let payload = PairingPayload(
      v: 1,
      host: host,
      mgmtToken: "m",
      chatToken: "c",
      mgmtPort: nil,
      chatPort: nil,
      label: nil,
      secure: nil,
      relayCredential: nil
    )
    #expect(throws: PairingValidationError.self) {
      try payload.validated(profileID: UUID())
    }
  }

  @Test(arguments: [0, 65_536])
  func rejectsInvalidPorts(_ port: Int) {
    let management = payload(mgmtPort: port)
    #expect(throws: PairingValidationError.self) {
      try management.validated(profileID: UUID())
    }

    let chat = payload(chatPort: port)
    #expect(throws: PairingValidationError.self) {
      try chat.validated(profileID: UUID())
    }
  }

  @Test("rejects unsupported versions and blank tokens")
  func rejectsVersionsAndTokens() {
    #expect(throws: PairingValidationError.self) {
      try payload(v: 99).validated(profileID: UUID())
    }
    #expect(throws: PairingValidationError.self) {
      try payload(mgmtToken: " \n ").validated(profileID: UUID())
    }
    #expect(throws: PairingValidationError.self) {
      try payload(chatToken: "\t").validated(profileID: UUID())
    }
    #expect(throws: PairingValidationError.self) {
      try payload(chatToken: "different-mobile-token").validated(profileID: UUID())
    }
    #expect(throws: PairingValidationError.self) {
      try payload(
        v: 2,
        chatToken: "different-mobile-token",
        secure: true,
        relayCredential: "relay-credential"
      ).validated(profileID: UUID())
    }
  }

  @Test("legacy plaintext LAN payloads require re-pairing")
  func legacyLANRejected() {
    #expect(throws: PairingValidationError.insecureLanPairing) {
      try payload(v: 1).validated(profileID: UUID())
    }
  }

  @Test("v3 LAN requires one pinned TLS port and normalizes the fingerprint")
  func secureLAN() throws {
    let raw = try FixtureLoader.decode(PairingPayload.self, "pairing-lan-v3.json")
    let (profile, _) = try raw.validated(profileID: UUID())
    #expect(profile.mode == .lan)
    #expect(profile.secure)
    #expect(profile.managementPort == 9400)
    #expect(profile.chatPort == 9400)
    #expect(
      profile.tlsCertificateSha256
        == "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    )
  }

  @Test("v3 LAN rejects plaintext, split ports, and malformed pins")
  func secureLANValidation() {
    #expect(throws: PairingValidationError.insecureLanPairing) {
      try payload(secure: false).validated(profileID: UUID())
    }
    #expect(throws: PairingValidationError.mismatchedLANPorts) {
      try payload(mgmtPort: 9400, chatPort: 9401).validated(profileID: UUID())
    }
    #expect(throws: PairingValidationError.invalidCertificatePin) {
      try payload(tlsCertificateSha256: "abc").validated(profileID: UUID())
    }
  }

  @Test("relay forces TLS, 443, and a credential")
  func relayDefaults() throws {
    let payload = try FixtureLoader.decode(PairingPayload.self, "pairing-relay-v2.json")
    let (profile, secrets) = try payload.validated(profileID: UUID())
    #expect(profile.mode == .relay)
    #expect(profile.secure)
    #expect(profile.managementPort == 443)
    #expect(profile.chatPort == 443)
    #expect(secrets.relayCredential?.isEmpty == false)
  }

  @Test("relay rejects a missing or blank credential")
  func relayRequiresCredential() {
    #expect(throws: PairingValidationError.self) {
      try payload(v: 2, secure: false, relayCredential: nil).validated(profileID: UUID())
    }
    #expect(throws: PairingValidationError.self) {
      try payload(v: 2, secure: false, relayCredential: "  ").validated(profileID: UUID())
    }
    #expect(throws: PairingValidationError.insecureRelayPairing) {
      try payload(v: 2, secure: false, relayCredential: "relay-credential")
        .validated(profileID: UUID())
    }
  }

  @Test(arguments: ["127.0.0.1", "192.168.1.50", "[2001:db8::1]"])
  func acceptsIPHosts(_ host: String) throws {
    let (profile, _) = try payload(host: host).validated(profileID: UUID())
    #expect(profile.host.isEmpty == false)
    let endpoint = ConnectionEndpoint(
      profile: profile,
      secrets: ConnectionSecrets(managementToken: "m", chatToken: "c", relayCredential: nil)
    )
    #expect(try endpoint.managementURL(path: "/health", query: []).host?.isEmpty == false)
  }

  @Test("unknown pairing fields are ignored")
  func ignoresUnknownFields() throws {
    let data = Data(
      #"{"v":3,"host":"gateway.local","secure":true,"mgmtToken":"m","chatToken":"m","mgmtPort":9400,"chatPort":9400,"tlsCertificateSha256":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","future":{"enabled":true}}"#
        .utf8
    )
    let raw = try ContractCoding.decoder().decode(PairingPayload.self, from: data)
    let (profile, _) = try raw.validated(profileID: UUID())
    #expect(profile.host == "gateway.local")
  }

  @Test("management URL encodes path components and query values without secrets")
  func managementURL() throws {
    let endpoint = lanEndpoint()
    let url = try endpoint.managementURL(
      path: "/agents/agent #1/models",
      query: [URLQueryItem(name: "cursor", value: "a b&c")]
    )
    #expect(url.scheme == "https")
    #expect(url.host == "192.168.1.50")
    #expect(url.port == 9400)
    #expect(url.path == "/agents/agent #1/models")
    #expect(url.absoluteString.contains("agent%20%231"))
    #expect(url.absoluteString.contains("cursor=a%20b%26c"))
    #expect(url.absoluteString.contains("management-secret") == false)
    #expect(url.absoluteString.contains("chat-secret") == false)
  }

  @Test("chat request keeps the chat token out of the URL and uses bearer auth")
  func chatRequest() throws {
    let endpoint = relayEndpoint()
    let request = try endpoint.chatRequest()
    let url = try #require(request.url)
    let components = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false))
    #expect(components.scheme == "wss")
    #expect(components.host == "gateway.relay.example")
    #expect(components.port == nil)
    #expect(components.path == "/ws/chat")
    #expect(components.queryItems == nil)
    #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer chat-secret")
    #expect(request.value(forHTTPHeaderField: "x-dash-relay-credential") == "relay-secret")
    #expect(request.url?.absoluteString.contains("management-secret") == false)
    #expect(request.url?.absoluteString.contains("chat-secret") == false)
  }

  @Test("persisted relay endpoints fail closed before constructing credentialed requests")
  func relayRequestUseValidation() {
    let invalidEndpoints = [
      relayEndpoint(secure: false),
      relayEndpoint(managementPort: 8443),
      relayEndpoint(chatPort: 8443),
      relayEndpoint(relayCredential: nil),
      relayEndpoint(relayCredential: " \n "),
    ]

    for endpoint in invalidEndpoints {
      #expect(throws: GatewayError.self) {
        try endpoint.requireTrustedTransport()
      }
      #expect(throws: GatewayError.self) {
        try endpoint.chatRequest()
      }
    }
  }

  @Test("LAN chat request uses its configured port and no relay header")
  func lanChatRequest() throws {
    let request = try lanEndpoint().chatRequest()
    #expect(request.url?.scheme == "wss")
    #expect(request.url?.port == 9400)
    #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer chat-secret")
    #expect(request.value(forHTTPHeaderField: "x-dash-relay-credential") == nil)
  }

  @Test("endpoint description never contains credentials")
  func redactedDescription() {
    let endpoint = relayEndpoint()
    #expect(endpoint.description == "relay://gateway.relay.example")
    #expect(endpoint.description.contains("management-secret") == false)
    #expect(endpoint.description.contains("chat-secret") == false)
    #expect(endpoint.description.contains("relay-secret") == false)
  }

  private func payload(
    v: Int = 3,
    host: String = "gateway.local",
    mgmtToken: String = "m",
    chatToken: String = "m",
    mgmtPort: Int? = 9400,
    chatPort: Int? = 9400,
    secure: Bool? = true,
    relayCredential: String? = nil,
    tlsCertificateSha256: String? =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  ) -> PairingPayload {
    PairingPayload(
      v: v,
      host: host,
      mgmtToken: mgmtToken,
      chatToken: chatToken,
      mgmtPort: mgmtPort,
      chatPort: chatPort,
      label: nil,
      secure: secure,
      relayCredential: relayCredential,
      tlsCertificateSha256: tlsCertificateSha256
    )
  }

  private func lanEndpoint() -> ConnectionEndpoint {
    ConnectionEndpoint(
      profile: ConnectionProfile(
        id: UUID(),
        gatewayId: nil,
        publicKey: nil,
        label: "Home",
        host: "192.168.1.50",
        managementPort: 9400,
        chatPort: 9400,
        secure: true,
        mode: .lan,
        tlsCertificateSha256:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        createdAt: Date(timeIntervalSince1970: 0),
        lastSuccessfulSyncAt: nil
      ),
      secrets: ConnectionSecrets(
        managementToken: "management-secret",
        chatToken: "chat-secret",
        relayCredential: nil
      )
    )
  }

  private func relayEndpoint(
    managementPort: Int = 443,
    chatPort: Int = 443,
    secure: Bool = true,
    relayCredential: String? = "relay-secret"
  ) -> ConnectionEndpoint {
    ConnectionEndpoint(
      profile: ConnectionProfile(
        id: UUID(),
        gatewayId: nil,
        publicKey: nil,
        label: "Relay",
        host: "gateway.relay.example",
        managementPort: managementPort,
        chatPort: chatPort,
        secure: secure,
        mode: .relay,
        createdAt: Date(timeIntervalSince1970: 0),
        lastSuccessfulSyncAt: nil
      ),
      secrets: ConnectionSecrets(
        managementToken: "management-secret",
        chatToken: "chat-secret",
        relayCredential: relayCredential
      )
    )
  }
}
