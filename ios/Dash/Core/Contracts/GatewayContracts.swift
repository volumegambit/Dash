import Foundation

enum MobileCapability: String, Codable, Hashable, Sendable {
  case conversationSyncV1 = "conversation-sync-v1"
  case chatResumeV1 = "chat-resume-v1"
}

struct HealthResponse: Codable, Hashable, Sendable {
  let status: String
  let startedAt: Date
  let pid: Int
  let agents: Int
  let channels: Int
  let apiVersion: Int
  let capabilities: [MobileCapability]
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
