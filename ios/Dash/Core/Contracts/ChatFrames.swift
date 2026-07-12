enum StreamingBehavior: String, Codable, Hashable, Sendable {
  case steer
  case followUp
}

enum MobileWSClientFrame: Codable, Hashable, Sendable {
  case message(
    id: String,
    agentId: String,
    channelId: String,
    conversationId: String,
    text: String,
    images: [MessageImage]?,
    resumable: Bool?,
    streamingBehavior: StreamingBehavior?
  )
  case resume(id: String, agentId: String, conversationId: String, sinceSeq: Int)
  case answer(id: String, questionId: String, answer: String)
  case cancel(id: String)

  private enum CodingKeys: String, CodingKey {
    case type
    case id
    case agentId
    case channelId
    case conversationId
    case text
    case images
    case resumable
    case streamingBehavior
    case sinceSeq
    case questionId
    case answer
  }

  static func newTurn(
    id: String,
    agentId: String,
    conversationId: String,
    text: String,
    images: [MessageImage]?
  ) -> MobileWSClientFrame {
    .message(
      id: id,
      agentId: agentId,
      channelId: "ios",
      conversationId: conversationId,
      text: text,
      images: images,
      resumable: true,
      streamingBehavior: nil
    )
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    let type = try container.decode(String.self, forKey: .type)
    switch type {
    case "message":
      self = .message(
        id: try container.decode(String.self, forKey: .id),
        agentId: try container.decode(String.self, forKey: .agentId),
        channelId: try container.decode(String.self, forKey: .channelId),
        conversationId: try container.decode(String.self, forKey: .conversationId),
        text: try container.decode(String.self, forKey: .text),
        images: try container.decodeIfPresent([MessageImage].self, forKey: .images),
        resumable: try container.decodeIfPresent(Bool.self, forKey: .resumable),
        streamingBehavior: try container.decodeIfPresent(
          StreamingBehavior.self,
          forKey: .streamingBehavior
        )
      )
    case "resume":
      self = .resume(
        id: try container.decode(String.self, forKey: .id),
        agentId: try container.decode(String.self, forKey: .agentId),
        conversationId: try container.decode(String.self, forKey: .conversationId),
        sinceSeq: try container.decode(Int.self, forKey: .sinceSeq)
      )
    case "answer":
      self = .answer(
        id: try container.decode(String.self, forKey: .id),
        questionId: try container.decode(String.self, forKey: .questionId),
        answer: try container.decode(String.self, forKey: .answer)
      )
    case "cancel":
      self = .cancel(id: try container.decode(String.self, forKey: .id))
    default:
      throw DecodingError.dataCorruptedError(
        forKey: .type,
        in: container,
        debugDescription: "Unknown client frame type \(type)"
      )
    }
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    switch self {
    case let .message(
      id,
      agentId,
      channelId,
      conversationId,
      text,
      images,
      resumable,
      streamingBehavior
    ):
      try container.encode("message", forKey: .type)
      try container.encode(id, forKey: .id)
      try container.encode(agentId, forKey: .agentId)
      try container.encode(channelId, forKey: .channelId)
      try container.encode(conversationId, forKey: .conversationId)
      try container.encode(text, forKey: .text)
      try container.encodeIfPresent(images, forKey: .images)
      try container.encodeIfPresent(resumable, forKey: .resumable)
      try container.encodeIfPresent(streamingBehavior, forKey: .streamingBehavior)
    case let .resume(id, agentId, conversationId, sinceSeq):
      try container.encode("resume", forKey: .type)
      try container.encode(id, forKey: .id)
      try container.encode(agentId, forKey: .agentId)
      try container.encode(conversationId, forKey: .conversationId)
      try container.encode(sinceSeq, forKey: .sinceSeq)
    case let .answer(id, questionId, answer):
      try container.encode("answer", forKey: .type)
      try container.encode(id, forKey: .id)
      try container.encode(questionId, forKey: .questionId)
      try container.encode(answer, forKey: .answer)
    case let .cancel(id):
      try container.encode("cancel", forKey: .type)
      try container.encode(id, forKey: .id)
    }
  }
}

enum MobileWSServerFrame: Codable, Hashable, Sendable {
  case accepted(
    id: String,
    conversationId: String,
    userMessageId: String,
    assistantMessageId: String,
    revision: Int,
    seq: Int
  )
  case event(id: String, conversationId: String?, seq: Int?, event: AgentEvent)
  case done(id: String, conversationId: String?, seq: Int?, outcome: TurnOutcome?)
  case error(
    id: String,
    conversationId: String?,
    seq: Int?,
    error: String,
    code: String?,
    retryable: Bool?,
    activeTurnId: String?
  )

  private enum CodingKeys: String, CodingKey {
    case type
    case id
    case conversationId
    case userMessageId
    case assistantMessageId
    case revision
    case seq
    case event
    case outcome
    case error
    case code
    case retryable
    case activeTurnId
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    let type = try container.decode(String.self, forKey: .type)
    switch type {
    case "accepted":
      self = .accepted(
        id: try container.decode(String.self, forKey: .id),
        conversationId: try container.decode(String.self, forKey: .conversationId),
        userMessageId: try container.decode(String.self, forKey: .userMessageId),
        assistantMessageId: try container.decode(String.self, forKey: .assistantMessageId),
        revision: try container.decode(Int.self, forKey: .revision),
        seq: try container.decode(Int.self, forKey: .seq)
      )
    case "event":
      self = .event(
        id: try container.decode(String.self, forKey: .id),
        conversationId: try container.decodeIfPresent(String.self, forKey: .conversationId),
        seq: try container.decodeIfPresent(Int.self, forKey: .seq),
        event: try container.decode(AgentEvent.self, forKey: .event)
      )
    case "done":
      self = .done(
        id: try container.decode(String.self, forKey: .id),
        conversationId: try container.decodeIfPresent(String.self, forKey: .conversationId),
        seq: try container.decodeIfPresent(Int.self, forKey: .seq),
        outcome: try container.decodeIfPresent(TurnOutcome.self, forKey: .outcome)
      )
    case "error":
      self = .error(
        id: try container.decode(String.self, forKey: .id),
        conversationId: try container.decodeIfPresent(String.self, forKey: .conversationId),
        seq: try container.decodeIfPresent(Int.self, forKey: .seq),
        error: try container.decode(String.self, forKey: .error),
        code: try container.decodeIfPresent(String.self, forKey: .code),
        retryable: try container.decodeIfPresent(Bool.self, forKey: .retryable),
        activeTurnId: try container.decodeIfPresent(String.self, forKey: .activeTurnId)
      )
    default:
      throw DecodingError.dataCorruptedError(
        forKey: .type,
        in: container,
        debugDescription: "Unknown server frame type \(type)"
      )
    }
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    switch self {
    case let .accepted(id, conversationId, userMessageId, assistantMessageId, revision, seq):
      try container.encode("accepted", forKey: .type)
      try container.encode(id, forKey: .id)
      try container.encode(conversationId, forKey: .conversationId)
      try container.encode(userMessageId, forKey: .userMessageId)
      try container.encode(assistantMessageId, forKey: .assistantMessageId)
      try container.encode(revision, forKey: .revision)
      try container.encode(seq, forKey: .seq)
    case let .event(id, conversationId, seq, event):
      try container.encode("event", forKey: .type)
      try container.encode(id, forKey: .id)
      try container.encodeIfPresent(conversationId, forKey: .conversationId)
      try container.encodeIfPresent(seq, forKey: .seq)
      try container.encode(event, forKey: .event)
    case let .done(id, conversationId, seq, outcome):
      try container.encode("done", forKey: .type)
      try container.encode(id, forKey: .id)
      try container.encodeIfPresent(conversationId, forKey: .conversationId)
      try container.encodeIfPresent(seq, forKey: .seq)
      try container.encodeIfPresent(outcome, forKey: .outcome)
    case let .error(id, conversationId, seq, error, code, retryable, activeTurnId):
      try container.encode("error", forKey: .type)
      try container.encode(id, forKey: .id)
      try container.encodeIfPresent(conversationId, forKey: .conversationId)
      try container.encodeIfPresent(seq, forKey: .seq)
      try container.encode(error, forKey: .error)
      try container.encodeIfPresent(code, forKey: .code)
      try container.encodeIfPresent(retryable, forKey: .retryable)
      try container.encodeIfPresent(activeTurnId, forKey: .activeTurnId)
    }
  }
}

enum ContractValidationError: Error, Equatable, Sendable {
  case requiredCapableField(String)
}

enum CapableServerFrame: Hashable, Sendable {
  case accepted(
    id: String,
    conversationId: String,
    userMessageId: String,
    assistantMessageId: String,
    revision: Int,
    seq: Int
  )
  case event(id: String, conversationId: String, seq: Int, event: AgentEvent)
  case done(id: String, conversationId: String, seq: Int, outcome: TurnOutcome)
  case error(
    id: String,
    conversationId: String?,
    seq: Int?,
    error: String,
    code: String?,
    retryable: Bool?,
    activeTurnId: String?
  )

  static func validating(_ frame: MobileWSServerFrame) throws -> CapableServerFrame {
    switch frame {
    case let .accepted(id, conversationId, userMessageId, assistantMessageId, revision, seq):
      return .accepted(
        id: id,
        conversationId: conversationId,
        userMessageId: userMessageId,
        assistantMessageId: assistantMessageId,
        revision: revision,
        seq: seq
      )
    case let .event(id, conversationId, seq, event):
      guard let conversationId else {
        throw ContractValidationError.requiredCapableField("conversationId")
      }
      guard let seq else { throw ContractValidationError.requiredCapableField("seq") }
      return .event(id: id, conversationId: conversationId, seq: seq, event: event)
    case let .done(id, conversationId, seq, outcome):
      guard let conversationId else {
        throw ContractValidationError.requiredCapableField("conversationId")
      }
      guard let seq else { throw ContractValidationError.requiredCapableField("seq") }
      guard let outcome else { throw ContractValidationError.requiredCapableField("outcome") }
      return .done(id: id, conversationId: conversationId, seq: seq, outcome: outcome)
    case let .error(id, conversationId, seq, error, code, retryable, activeTurnId):
      if conversationId != nil, seq == nil {
        throw ContractValidationError.requiredCapableField("seq")
      }
      if conversationId == nil, seq != nil {
        throw ContractValidationError.requiredCapableField("conversationId")
      }
      return .error(
        id: id,
        conversationId: conversationId,
        seq: seq,
        error: error,
        code: code,
        retryable: retryable,
        activeTurnId: activeTurnId
      )
    }
  }
}
