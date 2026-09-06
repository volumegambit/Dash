import Foundation

enum ConversationStatus: String, Codable, Hashable, Sendable {
  case idle
  case running
  case interrupted
  case archived
  case deleted
}

enum MessageRole: String, Codable, Hashable, Sendable {
  case user
  case assistant
}

/// Who caused a turn (sub-agents design 7.6). `notification` is a turn the
/// GATEWAY started to wake this conversation's orchestrator with a background
/// child's result; `parent` is an orchestrator message inside a child
/// transcript. Absent means `user` for a live turn, and UNKNOWN for a replayed
/// one — hence every use site keeps it optional rather than defaulting.
enum MessageOrigin: String, Codable, Hashable, Sendable {
  case user
  case notification
  case parent
}

/// `subagent` conversations are sub-agent children (sub-agents design 7.4).
/// Absent means `user`: an older gateway does not send the field at all, and a
/// client that read absence as "not a user conversation" would hide every
/// conversation it has (see `ConversationSummaryDTO.conversationKind`).
enum ConversationKind: String, Codable, Hashable, Sendable {
  case user
  case subagent
}

enum MessageStatus: String, Codable, Hashable, Sendable {
  case accepted
  case streaming
  case completed
  case cancelled
  case failed
  case interrupted
}

enum ImageMediaType: String, Codable, Hashable, Sendable {
  case jpeg = "image/jpeg"
  case png = "image/png"
  case gif = "image/gif"
  case webp = "image/webp"
}

struct MessageImage: Codable, Hashable, Sendable {
  let mediaType: ImageMediaType
  let data: String
}

enum MessageContent: Codable, Hashable, Sendable {
  case user(text: String, images: [MessageImage]?)
  case assistant(events: [AgentEvent])

  private enum CodingKeys: String, CodingKey {
    case type
    case text
    case images
    case events
  }

  private enum Kind: String, Codable {
    case user
    case assistant
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    switch try container.decode(Kind.self, forKey: .type) {
    case .user:
      self = .user(
        text: try container.decode(String.self, forKey: .text),
        images: try container.decodeIfPresent([MessageImage].self, forKey: .images)
      )
    case .assistant:
      self = .assistant(events: try container.decode([AgentEvent].self, forKey: .events))
    }
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    switch self {
    case let .user(text, images):
      try container.encode(Kind.user, forKey: .type)
      try container.encode(text, forKey: .text)
      try container.encodeIfPresent(images, forKey: .images)
    case let .assistant(events):
      try container.encode(Kind.assistant, forKey: .type)
      try container.encode(events, forKey: .events)
    }
  }
}

struct ConversationSummaryDTO: Codable, Hashable, Identifiable, Sendable {
  let id: String
  let agentId: String
  let agentName: String
  let title: String
  let revision: Int
  let status: ConversationStatus
  let activeTurnId: String?
  let owningIssueId: String?
  let projectId: String?
  let lastSeq: Int
  let lastMessagePreview: String?
  let createdAt: Date
  let updatedAt: Date
  let deletedAt: Date?
  /// Raw so an unrecognized kind from a newer gateway degrades to "treat it as
  /// a user conversation" instead of failing the decode of the whole page.
  /// Read `conversationKind`, never this.
  var kind: String? = nil
  var parentConversationId: String? = nil
  var parentTurnId: String? = nil
  var subagent: SubagentInfoDTO? = nil

  /// Ruling: absent `kind` means `.user`. A `kind == .user` test written
  /// against the raw field would silently drop every conversation returned by
  /// a gateway that predates the field.
  var conversationKind: ConversationKind {
    kind.flatMap(ConversationKind.init(rawValue:)) ?? .user
  }
}

/// The sub-agent facts a child conversation's summary carries (sub-agents
/// design 7.4). `status` and `isolation` are plain strings for the same
/// forward-compatibility reason as `SubagentListEntryDTO.status`.
struct SubagentInfoDTO: Codable, Hashable, Sendable {
  let type: String
  let name: String?
  let status: String
  let description: String
  let prompt: String
  let model: String
  let background: Bool
  let isolation: String?
  let depth: Int
  let startedAt: Date
  let endedAt: Date?
  let usage: SubagentUsageDTO?
  let toolCallCount: Int
  let report: String?
  let oneShot: Bool
  let workspace: String?
}

struct ConversationMessageDTO: Codable, Hashable, Identifiable, Sendable {
  let id: String
  let conversationId: String
  let turnId: String
  let ordinal: Int
  let role: MessageRole
  let status: MessageStatus
  let content: MessageContent
  let createdAt: Date
  let updatedAt: Date
  /// Raw for forward compatibility (see `ConversationSummaryDTO.kind`); read
  /// `messageOrigin`. Absent on a row written before origins existed.
  var origin: String? = nil

  var messageOrigin: MessageOrigin? {
    origin.flatMap(MessageOrigin.init(rawValue:))
  }
}

struct ConversationPageDTO: Codable, Hashable, Sendable {
  let items: [ConversationSummaryDTO]
  let nextCursor: String?
}

struct ConversationMessagePageDTO: Codable, Hashable, Sendable {
  let items: [ConversationMessageDTO]
  let nextCursor: String?
  let throughSeq: Int
}

/// One child of a conversation, as `GET /conversations/{id}/subagents` reports
/// it (sub-agents design 7.7). `status` is a plain `String` rather than an enum
/// because the sub-agent UX (phase D) has not landed on iOS yet and a new
/// status shipped by a newer gateway must not fail the decode of the whole
/// page — the tasks list is read-only here.
struct SubagentListEntryDTO: Codable, Hashable, Identifiable, Sendable {
  let id: String
  let name: String?
  let type: String
  let description: String
  let status: String
  let background: Bool
  let depth: Int
  let startedAt: Date
  let endedAt: Date?
  let usage: SubagentUsageDTO?
  let toolCallCount: Int
  let report: String?
  let oneShot: Bool
}

struct SubagentUsageDTO: Codable, Hashable, Sendable {
  let inputTokens: Int
  let outputTokens: Int
}

struct SubagentListResponseDTO: Codable, Hashable, Sendable {
  let subagents: [SubagentListEntryDTO]
}

struct CreateConversationRequest: Codable, Hashable, Sendable {
  let agentId: String
  let requestId: String
  let title: String?
  let owningIssueId: String?
  let projectId: String?
}

enum NullablePatchField<Value: Hashable & Sendable>: Hashable, Sendable {
  case omitted
  case value(Value)
  case null
}

enum PatchConversationRequestError: Error, Equatable, Sendable {
  case emptyPatch
}

struct PatchConversationRequest: Codable, Hashable, Sendable {
  let title: String?
  let owningIssueId: String?
  let projectId: String?

  private let includedKeys: Set<String>

  init(
    title: String? = nil,
    owningIssueId: NullablePatchField<String> = .omitted,
    projectId: NullablePatchField<String> = .omitted
  ) throws {
    self.title = title
    self.owningIssueId = if case let .value(value) = owningIssueId { value } else { nil }
    self.projectId = if case let .value(value) = projectId { value } else { nil }

    var keys: Set<String> = []
    if title != nil { keys.insert(CodingKeys.title.rawValue) }
    if owningIssueId != .omitted { keys.insert(CodingKeys.owningIssueId.rawValue) }
    if projectId != .omitted { keys.insert(CodingKeys.projectId.rawValue) }
    guard keys.isEmpty == false else { throw PatchConversationRequestError.emptyPatch }
    includedKeys = keys
  }

  private enum CodingKeys: String, CodingKey {
    case title
    case owningIssueId
    case projectId
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    title = try container.decodeIfPresent(String.self, forKey: .title)
    owningIssueId = try container.decodeIfPresent(String.self, forKey: .owningIssueId)
    projectId = try container.decodeIfPresent(String.self, forKey: .projectId)
    includedKeys = Set(container.allKeys.map(\.rawValue))
  }

  func encode(to encoder: Encoder) throws {
    guard includedKeys.isEmpty == false else { throw PatchConversationRequestError.emptyPatch }
    var container = encoder.container(keyedBy: CodingKeys.self)
    if includedKeys.contains(CodingKeys.title.rawValue) {
      try container.encodeIfPresent(title, forKey: .title)
      if title == nil { try container.encodeNil(forKey: .title) }
    }
    if includedKeys.contains(CodingKeys.owningIssueId.rawValue) {
      try container.encodeIfPresent(owningIssueId, forKey: .owningIssueId)
      if owningIssueId == nil { try container.encodeNil(forKey: .owningIssueId) }
    }
    if includedKeys.contains(CodingKeys.projectId.rawValue) {
      try container.encodeIfPresent(projectId, forKey: .projectId)
      if projectId == nil { try container.encodeNil(forKey: .projectId) }
    }
  }
}

enum TurnOutcome: String, Codable, Hashable, Sendable {
  case completed
  case cancelled
}

enum ReplayPayload: Codable, Hashable, Sendable {
  case accepted(userMessageId: String, assistantMessageId: String, revision: Int)
  case event(event: AgentEvent)
  case done(outcome: TurnOutcome?)
  case error(error: String, code: String?, retryable: Bool?)

  private enum CodingKeys: String, CodingKey {
    case type
    case userMessageId
    case assistantMessageId
    case revision
    case event
    case outcome
    case error
    case code
    case retryable
  }

  private enum Kind: String, Codable {
    case accepted
    case event
    case done
    case error
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    switch try container.decode(Kind.self, forKey: .type) {
    case .accepted:
      self = .accepted(
        userMessageId: try container.decode(String.self, forKey: .userMessageId),
        assistantMessageId: try container.decode(String.self, forKey: .assistantMessageId),
        revision: try container.decode(Int.self, forKey: .revision)
      )
    case .event:
      self = .event(event: try container.decode(AgentEvent.self, forKey: .event))
    case .done:
      self = .done(outcome: try container.decodeIfPresent(TurnOutcome.self, forKey: .outcome))
    case .error:
      self = .error(
        error: try container.decode(String.self, forKey: .error),
        code: try container.decodeIfPresent(String.self, forKey: .code),
        retryable: try container.decodeIfPresent(Bool.self, forKey: .retryable)
      )
    }
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    switch self {
    case let .accepted(userMessageId, assistantMessageId, revision):
      try container.encode(Kind.accepted, forKey: .type)
      try container.encode(userMessageId, forKey: .userMessageId)
      try container.encode(assistantMessageId, forKey: .assistantMessageId)
      try container.encode(revision, forKey: .revision)
    case let .event(event):
      try container.encode(Kind.event, forKey: .type)
      try container.encode(event, forKey: .event)
    case let .done(outcome):
      try container.encode(Kind.done, forKey: .type)
      try container.encodeIfPresent(outcome, forKey: .outcome)
    case let .error(error, code, retryable):
      try container.encode(Kind.error, forKey: .type)
      try container.encode(error, forKey: .error)
      try container.encodeIfPresent(code, forKey: .code)
      try container.encodeIfPresent(retryable, forKey: .retryable)
    }
  }
}

struct ReplayEntryDTO: Codable, Hashable, Sendable {
  let seq: Int
  let msgId: String
  let agentId: String
  let conversationId: String
  let timestamp: Date
  let payload: ReplayPayload
}

struct ReplayPageDTO: Codable, Hashable, Sendable {
  let entries: [ReplayEntryDTO]
}
