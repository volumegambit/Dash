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

struct CreateConversationRequest: Codable, Hashable, Sendable {
  let agentId: String
  let requestId: String
  let title: String?
  let owningIssueId: String?
  let projectId: String?
}

struct PatchConversationRequest: Codable, Hashable, Sendable {
  let title: String?
  let owningIssueId: String?
  let projectId: String?

  private let includedKeys: Set<String>

  init(title: String?, owningIssueId: String?, projectId: String?) {
    self.title = title
    self.owningIssueId = owningIssueId
    self.projectId = projectId
    includedKeys = [
      title == nil ? nil : CodingKeys.title.rawValue,
      owningIssueId == nil ? nil : CodingKeys.owningIssueId.rawValue,
      projectId == nil ? nil : CodingKeys.projectId.rawValue,
    ].compactMap { $0 }.reduce(into: []) { $0.insert($1) }
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
