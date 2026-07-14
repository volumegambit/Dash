import Foundation

enum ConnectionMode: String, Codable, Sendable {
  case lan
  case relay
}

struct ConnectionProfile: Codable, Hashable, Identifiable, Sendable {
  let id: UUID
  var gatewayId: String?
  var publicKey: String?
  var label: String
  let host: String
  let managementPort: Int
  let chatPort: Int
  let secure: Bool
  let mode: ConnectionMode
  let tlsCertificateSha256: String?
  let createdAt: Date
  var lastSuccessfulSyncAt: Date?

  init(
    id: UUID,
    gatewayId: String?,
    publicKey: String?,
    label: String,
    host: String,
    managementPort: Int,
    chatPort: Int,
    secure: Bool,
    mode: ConnectionMode,
    tlsCertificateSha256: String? = nil,
    createdAt: Date,
    lastSuccessfulSyncAt: Date?
  ) {
    self.id = id
    self.gatewayId = gatewayId
    self.publicKey = publicKey
    self.label = label
    self.host = host
    self.managementPort = managementPort
    self.chatPort = chatPort
    self.secure = secure
    self.mode = mode
    self.tlsCertificateSha256 = tlsCertificateSha256
    self.createdAt = createdAt
    self.lastSuccessfulSyncAt = lastSuccessfulSyncAt
  }
}

enum PairingValidationError: Error, Equatable, Sendable {
  case unsupportedVersion(Int)
  case invalidHost
  case invalidPort(String)
  case blankSecret(String)
  case missingRelayCredential
  case insecureLanPairing
  case insecureRelayPairing
  case mismatchedLANPorts
  case mismatchedMobileTokens
  case invalidCertificatePin
}

extension PairingPayload {
  func validated(profileID: UUID) throws -> (ConnectionProfile, ConnectionSecrets) {
    switch v {
    case 1:
      throw PairingValidationError.insecureLanPairing
    case 2, 3:
      break
    default:
      throw PairingValidationError.unsupportedVersion(v)
    }

    let normalizedHost = try validatedHost(host)
    let managementToken = try nonblank(mgmtToken, field: "mgmtToken")
    let normalizedChatToken = try nonblank(chatToken, field: "chatToken")
    guard managementToken == normalizedChatToken else {
      throw PairingValidationError.mismatchedMobileTokens
    }
    let normalizedLabel = label?.trimmingCharacters(in: .whitespacesAndNewlines)
    let profileLabel =
      if let normalizedLabel, normalizedLabel.isEmpty == false {
        normalizedLabel
      } else {
        normalizedHost
      }

    switch v {
    case 3:
      guard secure == true else {
        throw PairingValidationError.insecureLanPairing
      }
      guard let mgmtPort, let chatPort else {
        throw PairingValidationError.invalidPort(mgmtPort == nil ? "mgmtPort" : "chatPort")
      }
      let validatedManagementPort = try validatedPort(mgmtPort, field: "mgmtPort")
      let validatedChatPort = try validatedPort(chatPort, field: "chatPort")
      guard validatedManagementPort == validatedChatPort else {
        throw PairingValidationError.mismatchedLANPorts
      }
      guard let pin = GatewayCertificatePin.normalize(tlsCertificateSha256) else {
        throw PairingValidationError.invalidCertificatePin
      }
      return (
        ConnectionProfile(
          id: profileID,
          gatewayId: nil,
          publicKey: nil,
          label: profileLabel,
          host: normalizedHost,
          managementPort: validatedManagementPort,
          chatPort: validatedChatPort,
          secure: true,
          mode: .lan,
          tlsCertificateSha256: pin,
          createdAt: Date(),
          lastSuccessfulSyncAt: nil
        ),
        ConnectionSecrets(
          managementToken: managementToken,
          chatToken: managementToken,
          relayCredential: nil
        )
      )
    case 2:
      guard secure == true else {
        throw PairingValidationError.insecureRelayPairing
      }
      guard let relayCredential else {
        throw PairingValidationError.missingRelayCredential
      }
      let normalizedRelayCredential = relayCredential.trimmingCharacters(
        in: .whitespacesAndNewlines
      )
      guard normalizedRelayCredential.isEmpty == false else {
        throw PairingValidationError.missingRelayCredential
      }
      return (
        ConnectionProfile(
          id: profileID,
          gatewayId: nil,
          publicKey: nil,
          label: profileLabel,
          host: normalizedHost,
          managementPort: 443,
          chatPort: 443,
          secure: true,
          mode: .relay,
          tlsCertificateSha256: nil,
          createdAt: Date(),
          lastSuccessfulSyncAt: nil
        ),
        ConnectionSecrets(
          managementToken: managementToken,
          chatToken: managementToken,
          relayCredential: normalizedRelayCredential
        )
      )
    default:
      throw PairingValidationError.unsupportedVersion(v)
    }
  }
}

struct ConnectionEndpoint: CustomStringConvertible, Sendable {
  let profile: ConnectionProfile
  private let secrets: ConnectionSecrets

  init(profile: ConnectionProfile, secrets: ConnectionSecrets) {
    self.profile = profile
    self.secrets = secrets
  }

  var description: String {
    "\(profile.mode.rawValue)://\(profile.host)"
  }

  func requireTrustedTransport() throws {
    guard profile.mode == .lan else { return }
    guard
      profile.secure,
      GatewayCertificatePin.normalize(profile.tlsCertificateSha256) != nil
    else {
      throw GatewayError.validation("Re-pair this gateway to use pinned LAN TLS")
    }
  }

  func managementURL(path: String, query: [URLQueryItem]) throws -> URL {
    try url(
      scheme: profile.secure ? "https" : "http",
      port: profile.managementPort,
      path: path,
      query: query
    )
  }

  func chatRequest() throws -> URLRequest {
    let chatURL = try url(
      scheme: profile.secure ? "wss" : "ws",
      port: profile.chatPort,
      path: "/ws/chat",
      query: []
    )
    var request = URLRequest(url: chatURL)
    request.setValue("Bearer \(secrets.chatToken)", forHTTPHeaderField: "Authorization")
    if profile.mode == .relay, let relayCredential = secrets.relayCredential {
      request.setValue(relayCredential, forHTTPHeaderField: "x-dash-relay-credential")
    }
    return request
  }

  private func url(
    scheme: String,
    port: Int,
    path: String,
    query: [URLQueryItem]
  ) throws -> URL {
    var components = URLComponents()
    components.scheme = scheme
    components.host = profile.host
    let defaultPort = profile.secure ? 443 : 80
    if port != defaultPort {
      components.port = port
    }
    components.percentEncodedPath = try encodedPath(path)
    components.queryItems = query.isEmpty ? nil : query
    guard let url = components.url else {
      throw URLError(.badURL)
    }
    return url
  }

  private func encodedPath(_ path: String) throws -> String {
    let normalized = path.isEmpty ? "/" : (path.hasPrefix("/") ? path : "/\(path)")
    var allowed = CharacterSet.urlPathAllowed
    allowed.remove(charactersIn: "/?#%")
    let encoded =
      try normalized
      .split(separator: "/", omittingEmptySubsequences: false)
      .map { segment -> String in
        guard let value = String(segment).addingPercentEncoding(withAllowedCharacters: allowed)
        else {
          throw URLError(.badURL)
        }
        return value
      }
      .joined(separator: "/")
    return encoded
  }
}

private func validatedHost(_ value: String) throws -> String {
  let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
  guard trimmed.isEmpty == false,
    trimmed.rangeOfCharacter(from: .whitespacesAndNewlines) == nil,
    trimmed.rangeOfCharacter(from: .controlCharacters) == nil,
    trimmed.rangeOfCharacter(from: CharacterSet(charactersIn: "/\\?#@%")) == nil,
    URLComponents(string: trimmed)?.scheme == nil,
    let components = URLComponents(string: "//\(trimmed)"),
    let host = components.host,
    host.isEmpty == false,
    components.user == nil,
    components.password == nil,
    components.port == nil,
    components.query == nil,
    components.fragment == nil,
    components.path.isEmpty
  else {
    throw PairingValidationError.invalidHost
  }
  return host
}

private func validatedPort(_ value: Int, field: String) throws -> Int {
  guard (1...65_535).contains(value) else {
    throw PairingValidationError.invalidPort(field)
  }
  return value
}

private func nonblank(_ value: String, field: String) throws -> String {
  let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
  guard trimmed.isEmpty == false else {
    throw PairingValidationError.blankSecret(field)
  }
  return trimmed
}
