import Foundation

enum MobileCapability: String, Codable, Hashable, Sendable {
  case conversationSyncV1 = "conversation-sync-v1"
  case chatResumeV1 = "chat-resume-v1"
  /// `/speech/*` is mounted AND a provider can currently transcribe and speak.
  /// Unlike the other two this one comes and goes with the gateway's
  /// credentials, so it is read per verify rather than assumed.
  case speechV1 = "speech-v1"
}

struct HealthResponse: Codable, Hashable, Sendable {
  let status: String
  let startedAt: Date
  let pid: Int
  let agents: Int
  let channels: Int
  let apiVersion: Int
  let capabilities: [MobileCapability]

  /// Restated because the hand-written `init(from:)` below suppresses the
  /// synthesized memberwise initializer.
  init(
    status: String,
    startedAt: Date,
    pid: Int,
    agents: Int,
    channels: Int,
    apiVersion: Int,
    capabilities: [MobileCapability]
  ) {
    self.status = status
    self.startedAt = startedAt
    self.pid = pid
    self.agents = agents
    self.channels = channels
    self.apiVersion = apiVersion
    self.capabilities = capabilities
  }

  /// Decodes `capabilities` as raw strings and drops the ones this build does
  /// not know.
  ///
  /// A gateway ships before the app build that uses its new capability — that
  /// is the normal order — so `/health` will advertise unfamiliar strings to
  /// older installs. Decoding straight into `[MobileCapability]` made ONE such
  /// string a `DecodingError`, which `HTTPTransport.send` turns into
  /// `GatewayError.updateRequired`: the connection refuses to verify at all,
  /// rather than one unusable feature staying hidden. Unknown capabilities are
  /// exactly the case where absence is the safe fallback, since every consumer
  /// asks `contains(_:)` and a capability it cannot name is one it cannot use.
  /// A malformed array (not strings at all) still throws — that is a broken
  /// gateway, not a newer one.
  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    status = try container.decode(String.self, forKey: .status)
    startedAt = try container.decode(Date.self, forKey: .startedAt)
    pid = try container.decode(Int.self, forKey: .pid)
    agents = try container.decode(Int.self, forKey: .agents)
    channels = try container.decode(Int.self, forKey: .channels)
    apiVersion = try container.decode(Int.self, forKey: .apiVersion)
    capabilities = try container
      .decode([String].self, forKey: .capabilities)
      .compactMap(MobileCapability.init(rawValue:))
  }
}

struct GatewayIdentityDTO: Codable, Hashable, Sendable {
  let gatewayId: String
  let publicKey: String
}

struct WsTicketResponseDTO: Codable, Hashable, Sendable {
  let ticket: String
  let expiresAt: Date
}

struct MobileAPIError: Codable, Hashable, Sendable, Error {
  let code: String
  let error: String
  let retryable: Bool
  let details: JSONValue?
}

struct MobileActionResponseDTO: Codable, Hashable, Sendable {
  let ok: Bool

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    guard try container.decode(Bool.self, forKey: .ok) else {
      throw DecodingError.dataCorruptedError(
        forKey: .ok,
        in: container,
        debugDescription: "MobileActionResponse.ok must be true"
      )
    }
    ok = true
  }
}
