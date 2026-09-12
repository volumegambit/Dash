import Foundation

enum RegisteredAgentStatus: String, Codable, Hashable, Sendable {
  case registered
  case active
  case disabled
}

struct AgentSkillsDTO: Codable, Hashable, Sendable {
  let paths: [String]?
  let urls: [String]?
}

struct AgentSwarmDTO: Codable, Hashable, Sendable {
  let enabled: Bool?
  let maxConcurrentWorkers: Int?
  let maxWorkersPerRun: Int?
  let maxSteersPerWorker: Int?
  let maxRunSeconds: Int?
  let allowedModels: [String]?
}

struct AgentConfigDTO: Codable, Hashable, Sendable {
  let name: String
  let model: String
  let systemPrompt: String
  let fallbackModels: [String]?
  let tools: [String]?
  let skills: AgentSkillsDTO?
  let workspace: String?
  let maxTokens: Int?
  let mcpServers: [String]?
  let swarm: AgentSwarmDTO?
  let plugins: [String]?
  let providers: [String]?
}

/// A skill as the mobile API exposes it: read-only, without the gateway's
/// on-disk path. `source` says where it came from — `agent` means the agent
/// wrote it for itself.
struct SkillDTO: Codable, Hashable, Identifiable, Sendable {
  var id: String { name }
  let name: String
  let description: String
  let trigger: String?
  let source: SkillSource
  let content: String?
}

/// Unknown sources decode to `.unknown` rather than throwing, so a gateway
/// that adds one does not break skill listing on an older app.
enum SkillSource: String, Codable, Hashable, Sendable {
  case managed
  case agent
  case remote
  case plugin
  case unknown

  init(from decoder: Decoder) throws {
    let raw = try decoder.singleValueContainer().decode(String.self)
    self = SkillSource(rawValue: raw) ?? .unknown
  }

  /// How the source reads to a user.
  var label: String {
    switch self {
    case .agent: return "Learned"
    case .managed: return "Added"
    case .remote: return "Installed"
    case .plugin: return "Built-in"
    case .unknown: return "Other"
    }
  }
}

struct RegisteredAgentDTO: Codable, Hashable, Identifiable, Sendable {
  let id: String
  let name: String
  let config: AgentConfigDTO
  let status: RegisteredAgentStatus
  let registeredAt: Date
}

struct CreateAgentRequest: Codable, Hashable, Sendable {
  let name: String
  let model: String
  let systemPrompt: String
}

struct UpdateAgentRequest: Codable, Hashable, Sendable {
  let model: String?
  let systemPrompt: String?

  func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encodeIfPresent(model, forKey: .model)
    try container.encodeIfPresent(systemPrompt, forKey: .systemPrompt)
  }
}

enum ModelsSource: String, Codable, Hashable, Sendable {
  case live
  case bootstrap
}

struct ModelDTO: Codable, Hashable, Sendable {
  let value: String
  let label: String
  let provider: String
}

struct ModelsResponseDTO: Codable, Hashable, Sendable {
  let models: [ModelDTO]
  let source: ModelsSource
  let errors: [String: String]
  let fetchedAt: Date
  let supportedModelsReviewedAt: String
}

/// A memory row as the mobile memory routes serve it. `type` reuses
/// `MemoryTypeDTO` (declared in `AgentEvent.swift`, where the `memory_saved`
/// event needs it) so the buckets can never drift apart. `createdAt` and
/// `updatedAt` are bare `YYYY-MM-DD` days on the wire, not RFC 3339
/// timestamps, so they stay `String` — `ContractCoding`'s date strategy
/// would reject them.
struct MemoryInfoDTO: Codable, Hashable, Identifiable, Sendable {
  var id: String { name }
  let name: String
  let description: String
  let type: MemoryTypeDTO
  let source: String
  let createdAt: String
  let updatedAt: String
  let size: Int
}

struct MemoryDeleteResponseDTO: Codable, Hashable, Sendable {
  let name: String
}
