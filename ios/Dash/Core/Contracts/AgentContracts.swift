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
