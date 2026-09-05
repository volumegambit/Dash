import Foundation

struct UsageDTO: Codable, Hashable, Sendable {
  let inputTokens: Int
  let outputTokens: Int
  let cacheReadTokens: Int?
  let cacheWriteTokens: Int?
}

enum WorkerLiveStatus: String, Codable, Hashable, Sendable {
  case running
  case waitingInput = "waiting_input"
}

enum WorkerTerminalStatus: String, Codable, Hashable, Sendable {
  case done
  case failed
  case cancelled
}

/// Agent memory: the wire field is `memoryType` (`type` carries the event
/// discriminator). `CaseIterable` so the memory UI can enumerate the buckets.
enum MemoryTypeDTO: String, Codable, Hashable, Sendable, CaseIterable {
  case user
  case feedback
  case project
  case reference
}

enum MemorySaveAction: String, Codable, Hashable, Sendable {
  case created
  case updated
}

enum AgentEvent: Codable, Hashable, Sendable {
  case textDelta(text: String)
  case thinkingDelta(text: String)
  case toolUseStart(id: String, name: String, input: JSONValue?)
  case toolUseDelta(partialJSON: String)
  case toolResult(
    id: String,
    name: String,
    content: String,
    isError: Bool,
    details: JSONValue?
  )
  case response(content: String, usage: UsageDTO)
  case error(error: String, timestamp: Date?)
  case fileChanged(files: [String])
  case agentSpawned(name: String)
  case workerSpawned(workerId: String, runId: String, role: String, brief: String, model: String)
  case workerStatus(
    workerId: String,
    runId: String,
    role: String,
    status: WorkerLiveStatus,
    detail: String?,
    question: String?
  )
  case workerDone(
    workerId: String,
    runId: String,
    role: String,
    status: WorkerTerminalStatus,
    report: String,
    usage: UsageDTO?
  )
  case agentRetry(attempt: Int, reason: String)
  case contextCompacted(overflow: Bool)
  case question(id: String, question: String, options: [String])
  case skillLoaded(name: String)
  case skillCreated(name: String, description: String)
  case mcpServerError(server: String, error: String)
  case memorySaved(
    name: String,
    description: String,
    memoryType: MemoryTypeDTO,
    action: MemorySaveAction
  )
  case memoryForgotten(name: String)
  case unknown(type: String, raw: JSONValue)

  private enum CodingKeys: String, CodingKey {
    case type
    case text
    case id
    case name
    case input
    case partialJSON = "partial_json"
    case content
    case isError
    case details
    case usage
    case error
    case timestamp
    case files
    case workerId
    case runId
    case role
    case brief
    case model
    case status
    case detail
    case question
    case report
    case attempt
    case reason
    case overflow
    case options
    case description
    case server
    case memoryType
    case action
  }

  private struct Payload: Decodable {
    let type: String
    let text: String?
    let id: String?
    let name: String?
    let input: JSONValue?
    let partialJSON: String?
    let content: String?
    let isError: Bool?
    let details: JSONValue?
    let usage: UsageDTO?
    let error: String?
    let timestamp: Date?
    let files: [String]?
    let workerId: String?
    let runId: String?
    let role: String?
    let brief: String?
    let model: String?
    let status: String?
    let detail: String?
    let question: String?
    let report: String?
    let attempt: Int?
    let reason: String?
    let overflow: Bool?
    let options: [String]?
    let description: String?
    let server: String?
    let memoryType: String?
    let action: String?

    private enum CodingKeys: String, CodingKey {
      case type
      case text
      case id
      case name
      case input
      case partialJSON = "partial_json"
      case content
      case isError
      case details
      case usage
      case error
      case timestamp
      case files
      case workerId
      case runId
      case role
      case brief
      case model
      case status
      case detail
      case question
      case report
      case attempt
      case reason
      case overflow
      case options
      case description
      case server
      case memoryType
      case action
    }
  }

  init(from decoder: Decoder) throws {
    let raw = try JSONValue(from: decoder)
    guard
      let object = raw.objectValue,
      case let .string(type)? = object["type"]
    else {
      throw DecodingError.dataCorrupted(
        .init(codingPath: decoder.codingPath, debugDescription: "AgentEvent.type is required")
      )
    }
    let knownTypes = [
      "text_delta",
      "thinking_delta",
      "tool_use_start",
      "tool_use_delta",
      "tool_result",
      "response",
      "error",
      "file_changed",
      "agent_spawned",
      "worker_spawned",
      "worker_status",
      "worker_done",
      "agent_retry",
      "context_compacted",
      "question",
      "skill_loaded",
      "skill_created",
      "mcp_server_error",
      "memory_saved",
      "memory_forgotten",
    ]
    guard knownTypes.contains(type) else {
      self = .unknown(type: type, raw: raw)
      return
    }
    let data = try ContractCoding.encoder().encode(raw)
    let payload = try ContractCoding.decoder().decode(Payload.self, from: data)

    switch type {
    case "text_delta":
      self = .textDelta(text: try required(payload.text, "text", type))
    case "thinking_delta":
      self = .thinkingDelta(text: try required(payload.text, "text", type))
    case "tool_use_start":
      self = .toolUseStart(
        id: try required(payload.id, "id", type),
        name: try required(payload.name, "name", type),
        input: payload.input
      )
    case "tool_use_delta":
      self = .toolUseDelta(partialJSON: try required(payload.partialJSON, "partial_json", type))
    case "tool_result":
      self = .toolResult(
        id: try required(payload.id, "id", type),
        name: try required(payload.name, "name", type),
        content: try required(payload.content, "content", type),
        isError: payload.isError ?? false,
        details: payload.details
      )
    case "response":
      self = .response(
        content: try required(payload.content, "content", type),
        usage: try required(payload.usage, "usage", type)
      )
    case "error":
      self = .error(error: try required(payload.error, "error", type), timestamp: payload.timestamp)
    case "file_changed":
      self = .fileChanged(files: try required(payload.files, "files", type))
    case "agent_spawned":
      self = .agentSpawned(name: try required(payload.name, "name", type))
    case "worker_spawned":
      self = .workerSpawned(
        workerId: try required(payload.workerId, "workerId", type),
        runId: try required(payload.runId, "runId", type),
        role: try required(payload.role, "role", type),
        brief: try required(payload.brief, "brief", type),
        model: try required(payload.model, "model", type)
      )
    case "worker_status":
      let statusValue: String = try required(payload.status, "status", type)
      guard let status = WorkerLiveStatus(rawValue: statusValue) else {
        throw corrupt("status", type)
      }
      self = .workerStatus(
        workerId: try required(payload.workerId, "workerId", type),
        runId: try required(payload.runId, "runId", type),
        role: try required(payload.role, "role", type),
        status: status,
        detail: payload.detail,
        question: payload.question
      )
    case "worker_done":
      let statusValue: String = try required(payload.status, "status", type)
      guard let status = WorkerTerminalStatus(rawValue: statusValue) else {
        throw corrupt("status", type)
      }
      self = .workerDone(
        workerId: try required(payload.workerId, "workerId", type),
        runId: try required(payload.runId, "runId", type),
        role: try required(payload.role, "role", type),
        status: status,
        report: try required(payload.report, "report", type),
        usage: payload.usage
      )
    case "agent_retry":
      self = .agentRetry(
        attempt: try required(payload.attempt, "attempt", type),
        reason: try required(payload.reason, "reason", type)
      )
    case "context_compacted":
      self = .contextCompacted(overflow: try required(payload.overflow, "overflow", type))
    case "question":
      self = .question(
        id: try required(payload.id, "id", type),
        question: try required(payload.question, "question", type),
        options: try required(payload.options, "options", type)
      )
    case "skill_loaded":
      self = .skillLoaded(name: try required(payload.name, "name", type))
    case "skill_created":
      self = .skillCreated(
        name: try required(payload.name, "name", type),
        description: try required(payload.description, "description", type)
      )
    case "mcp_server_error":
      self = .mcpServerError(
        server: try required(payload.server, "server", type),
        error: try required(payload.error, "error", type)
      )
    case "memory_saved":
      let memoryTypeValue: String = try required(payload.memoryType, "memoryType", type)
      guard let memoryType = MemoryTypeDTO(rawValue: memoryTypeValue) else {
        throw corrupt("memoryType", type)
      }
      let actionValue: String = try required(payload.action, "action", type)
      guard let action = MemorySaveAction(rawValue: actionValue) else {
        throw corrupt("action", type)
      }
      self = .memorySaved(
        name: try required(payload.name, "name", type),
        description: try required(payload.description, "description", type),
        memoryType: memoryType,
        action: action
      )
    case "memory_forgotten":
      self = .memoryForgotten(name: try required(payload.name, "name", type))
    default:
      preconditionFailure("known AgentEvent discriminator was not handled")
    }
  }

  func encode(to encoder: Encoder) throws {
    if case let .unknown(_, raw) = self {
      try raw.encode(to: encoder)
      return
    }

    var container = encoder.container(keyedBy: CodingKeys.self)
    switch self {
    case let .textDelta(text):
      try container.encode("text_delta", forKey: .type)
      try container.encode(text, forKey: .text)
    case let .thinkingDelta(text):
      try container.encode("thinking_delta", forKey: .type)
      try container.encode(text, forKey: .text)
    case let .toolUseStart(id, name, input):
      try container.encode("tool_use_start", forKey: .type)
      try container.encode(id, forKey: .id)
      try container.encode(name, forKey: .name)
      try container.encodeIfPresent(input, forKey: .input)
    case let .toolUseDelta(partialJSON):
      try container.encode("tool_use_delta", forKey: .type)
      try container.encode(partialJSON, forKey: .partialJSON)
    case let .toolResult(id, name, content, isError, details):
      try container.encode("tool_result", forKey: .type)
      try container.encode(id, forKey: .id)
      try container.encode(name, forKey: .name)
      try container.encode(content, forKey: .content)
      try container.encode(isError, forKey: .isError)
      try container.encodeIfPresent(details, forKey: .details)
    case let .response(content, usage):
      try container.encode("response", forKey: .type)
      try container.encode(content, forKey: .content)
      try container.encode(usage, forKey: .usage)
    case let .error(error, timestamp):
      try container.encode("error", forKey: .type)
      try container.encode(error, forKey: .error)
      try container.encodeIfPresent(timestamp, forKey: .timestamp)
    case let .fileChanged(files):
      try container.encode("file_changed", forKey: .type)
      try container.encode(files, forKey: .files)
    case let .agentSpawned(name):
      try container.encode("agent_spawned", forKey: .type)
      try container.encode(name, forKey: .name)
    case let .workerSpawned(workerId, runId, role, brief, model):
      try container.encode("worker_spawned", forKey: .type)
      try container.encode(workerId, forKey: .workerId)
      try container.encode(runId, forKey: .runId)
      try container.encode(role, forKey: .role)
      try container.encode(brief, forKey: .brief)
      try container.encode(model, forKey: .model)
    case let .workerStatus(workerId, runId, role, status, detail, question):
      try container.encode("worker_status", forKey: .type)
      try container.encode(workerId, forKey: .workerId)
      try container.encode(runId, forKey: .runId)
      try container.encode(role, forKey: .role)
      try container.encode(status, forKey: .status)
      try container.encodeIfPresent(detail, forKey: .detail)
      try container.encodeIfPresent(question, forKey: .question)
    case let .workerDone(workerId, runId, role, status, report, usage):
      try container.encode("worker_done", forKey: .type)
      try container.encode(workerId, forKey: .workerId)
      try container.encode(runId, forKey: .runId)
      try container.encode(role, forKey: .role)
      try container.encode(status, forKey: .status)
      try container.encode(report, forKey: .report)
      try container.encodeIfPresent(usage, forKey: .usage)
    case let .agentRetry(attempt, reason):
      try container.encode("agent_retry", forKey: .type)
      try container.encode(attempt, forKey: .attempt)
      try container.encode(reason, forKey: .reason)
    case let .contextCompacted(overflow):
      try container.encode("context_compacted", forKey: .type)
      try container.encode(overflow, forKey: .overflow)
    case let .question(id, question, options):
      try container.encode("question", forKey: .type)
      try container.encode(id, forKey: .id)
      try container.encode(question, forKey: .question)
      try container.encode(options, forKey: .options)
    case let .skillLoaded(name):
      try container.encode("skill_loaded", forKey: .type)
      try container.encode(name, forKey: .name)
    case let .skillCreated(name, description):
      try container.encode("skill_created", forKey: .type)
      try container.encode(name, forKey: .name)
      try container.encode(description, forKey: .description)
    case let .mcpServerError(server, error):
      try container.encode("mcp_server_error", forKey: .type)
      try container.encode(server, forKey: .server)
      try container.encode(error, forKey: .error)
    case let .memorySaved(name, description, memoryType, action):
      try container.encode("memory_saved", forKey: .type)
      try container.encode(name, forKey: .name)
      try container.encode(description, forKey: .description)
      try container.encode(memoryType, forKey: .memoryType)
      try container.encode(action, forKey: .action)
    case let .memoryForgotten(name):
      try container.encode("memory_forgotten", forKey: .type)
      try container.encode(name, forKey: .name)
    case .unknown:
      break
    }
  }
}

private func required<T>(_ value: T?, _ field: String, _ type: String) throws -> T {
  guard let value else { throw corrupt(field, type) }
  return value
}

private func corrupt(_ field: String, _ type: String) -> DecodingError {
  DecodingError.dataCorrupted(
    .init(codingPath: [], debugDescription: "AgentEvent \(type) requires \(field)")
  )
}
