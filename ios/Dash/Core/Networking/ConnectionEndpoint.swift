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
  let createdAt: Date
  var lastSuccessfulSyncAt: Date?
}

enum PairingValidationError: Error, Equatable, Sendable {
  case unsupportedVersion(Int)
  case invalidHost
  case invalidPort(String)
  case blankSecret(String)
  case missingRelayCredential
}

extension PairingPayload {
  func validated(profileID: UUID) throws -> (ConnectionProfile, ConnectionSecrets) {
    let normalizedHost = try validatedHost(host)
    let managementToken = try nonblank(mgmtToken, field: "mgmtToken")
    let normalizedChatToken = try nonblank(chatToken, field: "chatToken")
    let normalizedLabel = label?.trimmingCharacters(in: .whitespacesAndNewlines)
    let profileLabel = if let normalizedLabel, normalizedLabel.isEmpty == false {
      normalizedLabel
    } else {
      normalizedHost
    }

    switch v {
    case 1:
      let managementPort = try validatedPort(mgmtPort ?? 9300, field: "mgmtPort")
      let chatPort = try validatedPort(chatPort ?? 9200, field: "chatPort")
      return (
        ConnectionProfile(
          id: profileID,
          gatewayId: nil,
          publicKey: nil,
          label: profileLabel,
          host: normalizedHost,
          managementPort: managementPort,
          chatPort: chatPort,
          secure: secure ?? false,
          mode: .lan,
          createdAt: Date(),
          lastSuccessfulSyncAt: nil
        ),
        ConnectionSecrets(
          managementToken: managementToken,
          chatToken: normalizedChatToken,
          relayCredential: nil
        )
      )
    case 2:
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
          createdAt: Date(),
          lastSuccessfulSyncAt: nil
        ),
        ConnectionSecrets(
          managementToken: managementToken,
          chatToken: normalizedChatToken,
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
      path: "/ws",
      query: [URLQueryItem(name: "token", value: secrets.chatToken)]
    )
    var request = URLRequest(url: chatURL)
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
    let encoded = try normalized
      .split(separator: "/", omittingEmptySubsequences: false)
      .map { segment -> String in
        guard let value = String(segment).addingPercentEncoding(withAllowedCharacters: allowed) else {
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
    URLComponents(string: trimmed)?.scheme == nil,
    let components = URLComponents(string: "//\(trimmed)"),
    let host = components.host,
    host.isEmpty == false,
    components.user == nil,
    components.password == nil,
    components.port == nil,
    components.query == nil,
    components.fragment == nil,
    components.path.isEmpty || components.path == "/"
  else {
    throw PairingValidationError.invalidHost
  }
  return host
}

private func validatedPort(_ value: Int, field: String) throws -> Int {
  guard (1 ... 65_535).contains(value) else {
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
