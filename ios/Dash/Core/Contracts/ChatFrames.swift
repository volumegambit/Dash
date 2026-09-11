enum StreamingBehavior: String, Codable, Hashable, Sendable {
  case steer
  case followUp
}

/// Set only for a turn spoken through the Phase B voice session — never for a
/// dictated turn, which merely fills the text composer. `DashAgent.chat`
/// appends the `<voice>` spoken-mode prompt block when this is `.voice`.
enum Modality: String, Codable, Hashable, Sendable {
  case text
  case voice
}

enum MobileWSClientFrame: Codable, Hashable, Sendable {
  case message(
    id: String,
    agentId: String,
    channelId: String,
    conversationId: String,
    text: String,
    location: ClientLocation?,
    images: [MessageImage]?,
    resumable: Bool?,
    streamingBehavior: StreamingBehavior?,
    modality: Modality?
  )
  case resume(id: String, agentId: String, conversationId: String, sinceSeq: Int)
  case answer(id: String, questionId: String, answer: String)
  case cancel(id: String)
  /// Watch a conversation this socket did not start a turn on, so
  /// server-initiated turns reach it (sub-agents design 7.6). `message` and
  /// `resume` subscribe implicitly; this frame is for a conversation that is
  /// merely open.
  case subscribe(id: String, agentId: String, conversationId: String)
  case unsubscribe(id: String, agentId: String, conversationId: String)

  private enum CodingKeys: String, CodingKey {
    case type
    case id
    case agentId
    case channelId
    case conversationId
    case text
    case location
    case images
    case resumable
    case streamingBehavior
    case modality
    case sinceSeq
    case questionId
    case answer
  }

  static func newTurn(
    id: String,
    agentId: String,
    conversationId: String,
    text: String,
    images: [MessageImage]?,
    location: ClientLocation? = nil
  ) -> MobileWSClientFrame {
    .message(
      id: id,
      agentId: agentId,
      channelId: "ios",
      conversationId: conversationId,
      text: text,
      location: location,
      images: images,
      resumable: true,
      streamingBehavior: nil,
      // A dictated turn never carries modality — only the Phase B voice
      // session sets it.
      modality: nil
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
        location: try container.decodeIfPresent(ClientLocation.self, forKey: .location),
        images: try container.decodeIfPresent([MessageImage].self, forKey: .images),
        resumable: try container.decodeIfPresent(Bool.self, forKey: .resumable),
        streamingBehavior: try container.decodeIfPresent(
          StreamingBehavior.self,
          forKey: .streamingBehavior
        ),
        modality: try container.decodeIfPresent(Modality.self, forKey: .modality)
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
    case "subscribe":
      self = .subscribe(
        id: try container.decode(String.self, forKey: .id),
        agentId: try container.decode(String.self, forKey: .agentId),
        conversationId: try container.decode(String.self, forKey: .conversationId)
      )
    case "unsubscribe":
      self = .unsubscribe(
        id: try container.decode(String.self, forKey: .id),
        agentId: try container.decode(String.self, forKey: .agentId),
        conversationId: try container.decode(String.self, forKey: .conversationId)
      )
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
      location,
      images,
      resumable,
      streamingBehavior,
      modality
    ):
      try container.encode("message", forKey: .type)
      try container.encode(id, forKey: .id)
      try container.encode(agentId, forKey: .agentId)
      try container.encode(channelId, forKey: .channelId)
      try container.encode(conversationId, forKey: .conversationId)
      try container.encode(text, forKey: .text)
      try container.encodeIfPresent(location, forKey: .location)
      try container.encodeIfPresent(images, forKey: .images)
      try container.encodeIfPresent(resumable, forKey: .resumable)
      try container.encodeIfPresent(streamingBehavior, forKey: .streamingBehavior)
      try container.encodeIfPresent(modality, forKey: .modality)
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
    case let .subscribe(id, agentId, conversationId):
      try container.encode("subscribe", forKey: .type)
      try container.encode(id, forKey: .id)
      try container.encode(agentId, forKey: .agentId)
      try container.encode(conversationId, forKey: .conversationId)
    case let .unsubscribe(id, agentId, conversationId):
      try container.encode("unsubscribe", forKey: .type)
      try container.encode(id, forKey: .id)
      try container.encode(agentId, forKey: .agentId)
      try container.encode(conversationId, forKey: .conversationId)
    }
  }
}

enum MobileWSServerFrame: Codable, Hashable, Sendable {
  /// `origin`/`kind` are omitted by the gateway for an ordinary user turn on a
  /// user conversation, so absent means `.user` on a LIVE frame — and UNKNOWN
  /// (still `nil`) on the replay path, which never carries them at all
  /// (sub-agents design 7.6). Both decode leniently: a value this build has
  /// never heard of reads as `nil` rather than failing the frame and taking
  /// the whole socket down with `updateRequired`.
  case accepted(
    id: String,
    conversationId: String,
    userMessageId: String,
    assistantMessageId: String,
    revision: Int,
    seq: Int,
    origin: MessageOrigin?,
    kind: ConversationKind?,
    /// Echo of `SubagentResumeRequest.requestId` on the turn a
    /// `POST /subagents/:id/resume` became (sub-agents design 7.7) — the
    /// client's only way to pair one of its own in-flight follow-ups with the
    /// `accepted` it produced, because the SERVER picks the turn id for a
    /// resume.
    ///
    /// LIVE-ONLY and optional on both sides: it is deliberately absent from
    /// the replay payload (the durable event log stores server state, not a
    /// client's correlation id), an older gateway never echoes it, and an
    /// ANSWER to a parked `ask_orchestrator` question resolves inside the
    /// child's running turn and so produces no `accepted` at all. A client
    /// that sent one and gets an `accepted` back without one must treat that
    /// turn as UNCORRELATED rather than assuming it is its own.
    requestId: String?
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
    case origin
    case kind
    case requestId
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
        seq: try container.decode(Int.self, forKey: .seq),
        origin: try? container.decodeIfPresent(MessageOrigin.self, forKey: .origin),
        kind: try? container.decodeIfPresent(ConversationKind.self, forKey: .kind),
        // `try?`, like `origin`/`kind` above and unlike the required fields:
        // the contract already DEFINES the absent case as "this turn is
        // uncorrelated, do not guess", so degrading a malformed echo to that
        // costs one duplicate optimistic row, while throwing would map to
        // `GatewayError.updateRequired` and tear the socket down
        // (`ChatConnection.decodedFrame`). Leniency is only defensible where a
        // safe fallback is specified; this is such a field.
        requestId: try? container.decodeIfPresent(String.self, forKey: .requestId)
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
    case let .accepted(
      id,
      conversationId,
      userMessageId,
      assistantMessageId,
      revision,
      seq,
      origin,
      kind,
      requestId
    ):
      try container.encode("accepted", forKey: .type)
      try container.encode(id, forKey: .id)
      try container.encode(conversationId, forKey: .conversationId)
      try container.encode(userMessageId, forKey: .userMessageId)
      try container.encode(assistantMessageId, forKey: .assistantMessageId)
      try container.encode(revision, forKey: .revision)
      try container.encode(seq, forKey: .seq)
      try container.encodeIfPresent(origin, forKey: .origin)
      try container.encodeIfPresent(kind, forKey: .kind)
      try container.encodeIfPresent(requestId, forKey: .requestId)
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
  /// `seq` is OPTIONAL, and the gateway means it: a TRANSIENT event (spec
  /// §7.2 — `subagent_progress` today) is live-broadcast and never appended to
  /// the durable log, so `resumable-chat-hub.ts:382-390` emits it with no
  /// sequence at all. `MobileWsServerFrame` has always declared it optional.
  /// Requiring it here rejected every heartbeat a real child sends, and
  /// `ChatConnection` maps a `ContractValidationError` to
  /// `GatewayError.updateRequired` — so ONE heartbeat took the whole socket
  /// down. `conversationId` stays required: an event with no cursor AND no
  /// conversation is the ambiguity `invalid/chat-event-missing-conversation-id.json`
  /// is frozen to reject.
  case event(id: String, conversationId: String, seq: Int?, event: AgentEvent)
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
    case let .accepted(
      id, conversationId, userMessageId, assistantMessageId, revision, seq, _, _, _
    ):
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
      return .event(id: id, conversationId: conversationId, seq: seq, event: event)
    case let .done(id, conversationId, seq, outcome):
      guard let conversationId else {
        throw ContractValidationError.requiredCapableField("conversationId")
      }
      guard let seq else { throw ContractValidationError.requiredCapableField("seq") }
      guard let outcome else { throw ContractValidationError.requiredCapableField("outcome") }
      return .done(id: id, conversationId: conversationId, seq: seq, outcome: outcome)
    case let .error(id, conversationId, seq, error, code, retryable, activeTurnId):
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
