import Foundation

struct UsageDTO: Codable, Hashable, Sendable {
  let inputTokens: Int
  let outputTokens: Int
  let cacheReadTokens: Int?
  let cacheWriteTokens: Int?
}

/// The live half of a child's lifecycle (`subagent_progress`, sub-agents
/// design §7.2). Also decodes the retired `worker_status`, which a transcript
/// persisted before D8 still contains.
enum SubagentLiveStatus: String, Codable, Hashable, Sendable {
  case running
  case waitingInput = "waiting_input"
}

/// The terminal half (`subagent_finished`), and also the retired `worker_done`.
///
/// FIVE cases. Pre-D8 the mirror carried only three — every producer flattened
/// through `legacyWorkerDoneStatus`, which mapped `interrupted` and
/// `max_turns` to `failed` — but D8 retired that flatten with the mirrors, so
/// all five now reach every client on `subagent_finished`. The extra two
/// remain accepted on a persisted `worker_done` because widening it costs
/// nothing and means one enum serves both.
///
/// Modelling only three would therefore not have been a pre-existing bug — it
/// would have been a bug D4 INTRODUCED. §8.1 gives all five a finished glyph.
enum SubagentTerminalStatus: String, Codable, Hashable, Sendable {
  case done
  case failed
  case cancelled
  case interrupted
  case maxTurns = "max_turns"
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
    status: SubagentLiveStatus,
    detail: String?,
    question: String?
  )
  case workerDone(
    workerId: String,
    runId: String,
    role: String,
    status: SubagentTerminalStatus,
    report: String,
    usage: UsageDTO?
  )
  /// Canonical child lifecycle (sub-agents design §7.2), persisted in the
  /// parent's event log. The only anchor since D8.
  case subagentStarted(
    subagentId: String,
    name: String?,
    subagentType: String,
    description: String,
    prompt: String,
    model: String,
    background: Bool,
    depth: Int,
    startedAt: Date,
    /// `"worktree"` today. Modelled as a free string, not an enum, so a new
    /// isolation kind degrades to an unrecognised value rather than failing
    /// the frame.
    isolation: String?,
    parentTurnId: String?
  )
  /// Transient: live stream only, never logged. Clients derive the same state
  /// from the child transcript on replay.
  case subagentProgress(
    subagentId: String,
    status: SubagentLiveStatus,
    toolCallCount: Int,
    elapsedMs: Int,
    detail: String?,
    question: String?
  )
  case subagentFinished(
    subagentId: String,
    name: String?,
    subagentType: String,
    description: String,
    status: SubagentTerminalStatus,
    report: String,
    usage: UsageDTO?,
    toolCallCount: Int,
    startedAt: Date,
    endedAt: Date
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
    case subagentId
    case subagentType
    case prompt
    case background
    case depth
    case startedAt
    case endedAt
    case isolation
    case parentTurnId
    case toolCallCount
    case elapsedMs
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
    let subagentId: String?
    let subagentType: String?
    let prompt: String?
    let background: Bool?
    let depth: Int?
    let startedAt: Date?
    let endedAt: Date?
    let isolation: String?
    let parentTurnId: String?
    let toolCallCount: Int?
    let elapsedMs: Int?

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
      case subagentId
      case subagentType
      case prompt
      case background
      case depth
      case startedAt
      case endedAt
      case isolation
      case parentTurnId
      case toolCallCount
      case elapsedMs
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
      "subagent_started",
      "subagent_progress",
      "subagent_finished",
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
    // ONE malformed persisted event must not make a conversation permanently
    // unopenable (sub-agents design, D8 ruling 4). Both iOS decode paths map a
    // `DecodingError` to `GatewayError.updateRequired` — `ChatConnection`'s
    // `decodedFrame` for the socket and `HTTPTransport.send` for the REST
    // page — so a single bad event in a persisted transcript used to kill WS
    // replay AND REST recovery for that conversation, for ever.
    //
    // It degrades to `.unknown` instead, which is exactly what an event type
    // this build has never heard of already does. That is the argument for the
    // narrowing, not merely a mitigation: `updateRequired` NEVER fired for a
    // newer gateway sending a new event type — the `knownTypes` guard above
    // has always tolerated those — so the only thing it ever caught was a
    // KNOWN type with a bad payload, which is corruption, not version skew.
    // Version skew is negotiated in `health-capabilities`, not inferred from a
    // malformed row.
    //
    // Scope, deliberately narrow: only the per-type PAYLOAD decode is relaxed.
    // An event with no `type` at all still throws (above), and the envelope,
    // the frame and every DTO keep the strict decode D4 gave them. The one
    // thing genuinely lost is the signal a SIXTH `SubagentTerminalStatus`
    // would have raised: it now draws a placeholder row rather than a hard
    // stop.
    do {
      self = try Self.decodeKnown(type: type, raw: raw)
    } catch is DecodingError {
      self = .unknown(type: type, raw: raw)
    }
  }

  /// The strict per-type decode. Throws `DecodingError` for a known type whose
  /// payload does not match; {@link init(from:)} is what decides that a throw
  /// here is non-fatal.
  private static func decodeKnown(type: String, raw: JSONValue) throws -> AgentEvent {
    let data = try ContractCoding.encoder().encode(raw)
    let payload = try ContractCoding.decoder().decode(Payload.self, from: data)

    switch type {
    case "text_delta":
      return .textDelta(text: try required(payload.text, "text", type))
    case "thinking_delta":
      return .thinkingDelta(text: try required(payload.text, "text", type))
    case "tool_use_start":
      return .toolUseStart(
        id: try required(payload.id, "id", type),
        name: try required(payload.name, "name", type),
        input: payload.input
      )
    case "tool_use_delta":
      return .toolUseDelta(partialJSON: try required(payload.partialJSON, "partial_json", type))
    case "tool_result":
      return .toolResult(
        id: try required(payload.id, "id", type),
        name: try required(payload.name, "name", type),
        content: try required(payload.content, "content", type),
        isError: payload.isError ?? false,
        details: payload.details
      )
    case "response":
      return .response(
        content: try required(payload.content, "content", type),
        usage: try required(payload.usage, "usage", type)
      )
    case "error":
      return .error(error: try required(payload.error, "error", type), timestamp: payload.timestamp)
    case "file_changed":
      return .fileChanged(files: try required(payload.files, "files", type))
    case "agent_spawned":
      return .agentSpawned(name: try required(payload.name, "name", type))
    case "worker_spawned":
      return .workerSpawned(
        workerId: try required(payload.workerId, "workerId", type),
        runId: try required(payload.runId, "runId", type),
        role: try required(payload.role, "role", type),
        brief: try required(payload.brief, "brief", type),
        model: try required(payload.model, "model", type)
      )
    case "worker_status":
      let statusValue: String = try required(payload.status, "status", type)
      guard let status = SubagentLiveStatus(rawValue: statusValue) else {
        throw corrupt("status", type)
      }
      return .workerStatus(
        workerId: try required(payload.workerId, "workerId", type),
        runId: try required(payload.runId, "runId", type),
        role: try required(payload.role, "role", type),
        status: status,
        detail: payload.detail,
        question: payload.question
      )
    case "worker_done":
      let statusValue: String = try required(payload.status, "status", type)
      guard let status = SubagentTerminalStatus(rawValue: statusValue) else {
        throw corrupt("status", type)
      }
      return .workerDone(
        workerId: try required(payload.workerId, "workerId", type),
        runId: try required(payload.runId, "runId", type),
        role: try required(payload.role, "role", type),
        status: status,
        report: try required(payload.report, "report", type),
        usage: payload.usage
      )
    case "subagent_started":
      return .subagentStarted(
        subagentId: try required(payload.subagentId, "subagentId", type),
        name: payload.name,
        subagentType: try required(payload.subagentType, "subagentType", type),
        description: try required(payload.description, "description", type),
        prompt: try required(payload.prompt, "prompt", type),
        model: try required(payload.model, "model", type),
        background: try required(payload.background, "background", type),
        depth: try required(payload.depth, "depth", type),
        startedAt: try required(payload.startedAt, "startedAt", type),
        isolation: payload.isolation,
        parentTurnId: payload.parentTurnId
      )
    case "subagent_progress":
      let statusValue: String = try required(payload.status, "status", type)
      guard let status = SubagentLiveStatus(rawValue: statusValue) else {
        throw corrupt("status", type)
      }
      return .subagentProgress(
        subagentId: try required(payload.subagentId, "subagentId", type),
        status: status,
        toolCallCount: try required(payload.toolCallCount, "toolCallCount", type),
        elapsedMs: try required(payload.elapsedMs, "elapsedMs", type),
        detail: payload.detail,
        question: payload.question
      )
    case "subagent_finished":
      let statusValue: String = try required(payload.status, "status", type)
      guard let status = SubagentTerminalStatus(rawValue: statusValue) else {
        throw corrupt("status", type)
      }
      return .subagentFinished(
        subagentId: try required(payload.subagentId, "subagentId", type),
        name: payload.name,
        subagentType: try required(payload.subagentType, "subagentType", type),
        description: try required(payload.description, "description", type),
        status: status,
        report: try required(payload.report, "report", type),
        usage: payload.usage,
        toolCallCount: try required(payload.toolCallCount, "toolCallCount", type),
        startedAt: try required(payload.startedAt, "startedAt", type),
        endedAt: try required(payload.endedAt, "endedAt", type)
      )
    case "agent_retry":
      return .agentRetry(
        attempt: try required(payload.attempt, "attempt", type),
        reason: try required(payload.reason, "reason", type)
      )
    case "context_compacted":
      return .contextCompacted(overflow: try required(payload.overflow, "overflow", type))
    case "question":
      return .question(
        id: try required(payload.id, "id", type),
        question: try required(payload.question, "question", type),
        options: try required(payload.options, "options", type)
      )
    case "skill_loaded":
      return .skillLoaded(name: try required(payload.name, "name", type))
    case "skill_created":
      return .skillCreated(
        name: try required(payload.name, "name", type),
        description: try required(payload.description, "description", type)
      )
    case "mcp_server_error":
      return .mcpServerError(
        server: try required(payload.server, "server", type),
        error: try required(payload.error, "error", type)
      )
    case "memory_saved":
      // The memory bucket list is a product-level enum that is expected to grow,
      // and every other client renders an unrecognised bucket rather than
      // failing. Throwing here would be fatal far beyond this one chip: the
      // frame decoder maps any DecodingError to GatewayError.updateRequired and
      // tears down the whole receive loop, and a history page decodes
      // [AgentEvent] as a unit. So degrade THE EVENT to .unknown instead — the
      // raw object is preserved and re-encoded verbatim.
      let memoryTypeValue: String = try required(payload.memoryType, "memoryType", type)
      guard let memoryType = MemoryTypeDTO(rawValue: memoryTypeValue) else {
        return .unknown(type: type, raw: raw)
      }
      let actionValue: String = try required(payload.action, "action", type)
      guard let action = MemorySaveAction(rawValue: actionValue) else {
        return .unknown(type: type, raw: raw)
      }
      return .memorySaved(
        name: try required(payload.name, "name", type),
        description: try required(payload.description, "description", type),
        memoryType: memoryType,
        action: action
      )
    case "memory_forgotten":
      return .memoryForgotten(name: try required(payload.name, "name", type))
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
    case let .subagentStarted(
      subagentID, name, subagentType, description, prompt, model, background, depth, startedAt,
      isolation, parentTurnID):
      try container.encode("subagent_started", forKey: .type)
      try container.encode(subagentID, forKey: .subagentId)
      try container.encodeIfPresent(name, forKey: .name)
      try container.encode(subagentType, forKey: .subagentType)
      try container.encode(description, forKey: .description)
      try container.encode(prompt, forKey: .prompt)
      try container.encode(model, forKey: .model)
      try container.encode(background, forKey: .background)
      try container.encode(depth, forKey: .depth)
      try container.encode(startedAt, forKey: .startedAt)
      try container.encodeIfPresent(isolation, forKey: .isolation)
      try container.encodeIfPresent(parentTurnID, forKey: .parentTurnId)
    case let .subagentProgress(subagentID, status, toolCallCount, elapsedMs, detail, question):
      try container.encode("subagent_progress", forKey: .type)
      try container.encode(subagentID, forKey: .subagentId)
      try container.encode(status, forKey: .status)
      try container.encode(toolCallCount, forKey: .toolCallCount)
      try container.encode(elapsedMs, forKey: .elapsedMs)
      try container.encodeIfPresent(detail, forKey: .detail)
      try container.encodeIfPresent(question, forKey: .question)
    case let .subagentFinished(
      subagentID, name, subagentType, description, status, report, usage, toolCallCount, startedAt,
      endedAt):
      try container.encode("subagent_finished", forKey: .type)
      try container.encode(subagentID, forKey: .subagentId)
      try container.encodeIfPresent(name, forKey: .name)
      try container.encode(subagentType, forKey: .subagentType)
      try container.encode(description, forKey: .description)
      try container.encode(status, forKey: .status)
      try container.encode(report, forKey: .report)
      try container.encodeIfPresent(usage, forKey: .usage)
      try container.encode(toolCallCount, forKey: .toolCallCount)
      try container.encode(startedAt, forKey: .startedAt)
      try container.encode(endedAt, forKey: .endedAt)
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
