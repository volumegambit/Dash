import Foundation

struct MobileV2StrictImage: Codable {
  let value: MessageImage

  private enum CodingKeys: String, CodingKey, CaseIterable {
    case mediaType
    case data
  }

  init(_ value: MessageImage) {
    self.value = value
  }

  init(from decoder: Decoder) throws {
    let keys = Set(CodingKeys.allCases.map(\.rawValue))
    try MobileV2ContractValidation.validateKeys(decoder, allowed: keys, required: keys)
    let container = try decoder.container(keyedBy: CodingKeys.self)
    let value = MessageImage(
      mediaType: try container.decode(ImageMediaType.self, forKey: .mediaType),
      data: try container.decode(String.self, forKey: .data)
    )
    try MobileV2ContractValidation.validateNonempty(value.data, field: "images.data")
    self.value = value
  }

  func encode(to encoder: Encoder) throws {
    try MobileV2ContractValidation.validateNonempty(value.data, field: "images.data")
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(value.mediaType, forKey: .mediaType)
    try container.encode(value.data, forKey: .data)
  }
}

struct MobileV2StrictAgentEvent: Codable {
  let value: AgentEvent

  init(_ value: AgentEvent) {
    self.value = value
  }

  init(from decoder: Decoder) throws {
    let raw = try JSONValue(from: decoder)
    try Self.validateType(in: raw)
    let data = try ContractCoding.encoder().encode(raw)
    value = try ContractCoding.decoder().decode(AgentEvent.self, from: data)
  }

  func encode(to encoder: Encoder) throws {
    let data = try ContractCoding.encoder().encode(value)
    let raw = try ContractCoding.decoder().decode(JSONValue.self, from: data)
    try Self.validateType(in: raw)
    try raw.encode(to: encoder)
  }

  private static func validateType(in raw: JSONValue) throws {
    guard
      let object = raw.objectValue,
      case let .string(type)? = object["type"],
      type.isEmpty == false
    else {
      throw MobileV2ContractValidationError.invalidField("event.type")
    }
  }
}

struct MobileV2StrictPreciseLocation: Codable {
  let value: PreciseLocation

  private enum CodingKeys: String, CodingKey, CaseIterable {
    case latitude
    case longitude
    case accuracyMeters
    case capturedAt
    case place
  }

  init(_ value: PreciseLocation) {
    self.value = value
  }

  init(from decoder: Decoder) throws {
    let allowed = Set(CodingKeys.allCases.map(\.rawValue))
    let required = allowed.subtracting([CodingKeys.place.rawValue])
    try MobileV2ContractValidation.validateKeys(decoder, allowed: allowed, required: required)
    let container = try decoder.container(keyedBy: CodingKeys.self)
    try MobileV2ContractValidation.validateOptionalNonNull(container, key: .place)
    value = PreciseLocation(
      latitude: try container.decode(Double.self, forKey: .latitude),
      longitude: try container.decode(Double.self, forKey: .longitude),
      accuracyMeters: try container.decode(Double.self, forKey: .accuracyMeters),
      capturedAt: try container.decode(String.self, forKey: .capturedAt),
      place: try container.decodeIfPresent(String.self, forKey: .place)
    )
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(value.latitude, forKey: .latitude)
    try container.encode(value.longitude, forKey: .longitude)
    try container.encode(value.accuracyMeters, forKey: .accuracyMeters)
    try container.encode(value.capturedAt, forKey: .capturedAt)
    try container.encodeIfPresent(value.place, forKey: .place)
  }
}

struct MobileV2StrictClientLocation: Codable {
  let value: ClientLocation

  private enum CodingKeys: String, CodingKey, CaseIterable {
    case timezone
    case utcOffsetMinutes
    case locale
    case region
    case precise
  }

  init(_ value: ClientLocation) {
    self.value = value
  }

  init(from decoder: Decoder) throws {
    let allowed = Set(CodingKeys.allCases.map(\.rawValue))
    let required = allowed.subtracting([
      CodingKeys.region.rawValue,
      CodingKeys.precise.rawValue,
    ])
    try MobileV2ContractValidation.validateKeys(decoder, allowed: allowed, required: required)
    let container = try decoder.container(keyedBy: CodingKeys.self)
    try MobileV2ContractValidation.validateOptionalNonNull(container, key: .region)
    try MobileV2ContractValidation.validateOptionalNonNull(container, key: .precise)
    value = ClientLocation(
      timezone: try container.decode(String.self, forKey: .timezone),
      utcOffsetMinutes: try container.decode(Int.self, forKey: .utcOffsetMinutes),
      locale: try container.decode(String.self, forKey: .locale),
      region: try container.decodeIfPresent(String.self, forKey: .region),
      precise: try container.decodeIfPresent(
        MobileV2StrictPreciseLocation.self,
        forKey: .precise
      )?.value
    )
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(value.timezone, forKey: .timezone)
    try container.encode(value.utcOffsetMinutes, forKey: .utcOffsetMinutes)
    try container.encode(value.locale, forKey: .locale)
    try container.encodeIfPresent(value.region, forKey: .region)
    if let precise = value.precise {
      try container.encode(MobileV2StrictPreciseLocation(precise), forKey: .precise)
    }
  }
}

struct MobileV2StrictConversationContent: Codable {
  let value: MessageContent

  private enum CodingKeys: String, CodingKey, CaseIterable {
    case type
    case text
    case images
    case events
  }

  private enum Kind: String, Codable {
    case user
    case assistant
  }

  init(_ value: MessageContent) {
    self.value = value
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    switch try container.decode(Kind.self, forKey: .type) {
    case .user:
      try MobileV2ContractValidation.validateKeys(
        decoder,
        allowed: Set([CodingKeys.type, .text, .images].map(\.rawValue)),
        required: Set([CodingKeys.type, .text].map(\.rawValue))
      )
      try MobileV2ContractValidation.validateOptionalNonNull(container, key: .images)
      let images = try container.decodeIfPresent(
        [MobileV2StrictImage].self,
        forKey: .images
      )?.map(\.value)
      try MobileV2ContractValidation.require(
        (images?.count ?? 0) <= 4,
        field: "content.images"
      )
      value = .user(
        text: try container.decode(String.self, forKey: .text),
        images: images
      )
    case .assistant:
      try MobileV2ContractValidation.validateKeys(
        decoder,
        allowed: Set([CodingKeys.type, .events].map(\.rawValue)),
        required: Set([CodingKeys.type, .events].map(\.rawValue))
      )
      value = .assistant(
        events: try container.decode(
          [MobileV2StrictAgentEvent].self,
          forKey: .events
        ).map(\.value)
      )
    }
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    switch value {
    case let .user(text, images):
      try MobileV2ContractValidation.require(
        (images?.count ?? 0) <= 4,
        field: "content.images"
      )
      try container.encode(Kind.user, forKey: .type)
      try container.encode(text, forKey: .text)
      if let images {
        try container.encode(images.map(MobileV2StrictImage.init), forKey: .images)
      }
    case let .assistant(events):
      try container.encode(Kind.assistant, forKey: .type)
      try container.encode(events.map(MobileV2StrictAgentEvent.init), forKey: .events)
    }
  }
}

struct MobileV2ConversationSummary: Codable, Hashable, Identifiable, Sendable {
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
  let queuePaused: Bool
  let queueRevision: Int
  let pendingFollowUpCount: Int
  let v2LastSeq: Int

  private enum CodingKeys: String, CodingKey, CaseIterable {
    case id
    case agentId
    case agentName
    case title
    case revision
    case status
    case activeTurnId
    case owningIssueId
    case projectId
    case lastSeq
    case lastMessagePreview
    case createdAt
    case updatedAt
    case deletedAt
    case queuePaused
    case queueRevision
    case pendingFollowUpCount
    case v2LastSeq
  }

  init(
    id: String,
    agentId: String,
    agentName: String,
    title: String,
    revision: Int,
    status: ConversationStatus,
    activeTurnId: String?,
    owningIssueId: String?,
    projectId: String?,
    lastSeq: Int,
    lastMessagePreview: String?,
    createdAt: Date,
    updatedAt: Date,
    deletedAt: Date?,
    queuePaused: Bool,
    queueRevision: Int,
    pendingFollowUpCount: Int,
    v2LastSeq: Int
  ) {
    self.id = id
    self.agentId = agentId
    self.agentName = agentName
    self.title = title
    self.revision = revision
    self.status = status
    self.activeTurnId = activeTurnId
    self.owningIssueId = owningIssueId
    self.projectId = projectId
    self.lastSeq = lastSeq
    self.lastMessagePreview = lastMessagePreview
    self.createdAt = createdAt
    self.updatedAt = updatedAt
    self.deletedAt = deletedAt
    self.queuePaused = queuePaused
    self.queueRevision = queueRevision
    self.pendingFollowUpCount = pendingFollowUpCount
    self.v2LastSeq = v2LastSeq
  }

  init(from decoder: Decoder) throws {
    let allowed = Set(CodingKeys.allCases.map(\.rawValue))
    let required = allowed.subtracting([CodingKeys.deletedAt.rawValue])
    try MobileV2ContractValidation.validateKeys(decoder, allowed: allowed, required: required)
    let container = try decoder.container(keyedBy: CodingKeys.self)
    try MobileV2ContractValidation.validateOptionalNonNull(container, key: .deletedAt)
    id = try container.decode(String.self, forKey: .id)
    agentId = try container.decode(String.self, forKey: .agentId)
    agentName = try container.decode(String.self, forKey: .agentName)
    title = try container.decode(String.self, forKey: .title)
    revision = try container.decode(Int.self, forKey: .revision)
    status = try container.decode(ConversationStatus.self, forKey: .status)
    activeTurnId = try container.decodeIfPresent(String.self, forKey: .activeTurnId)
    owningIssueId = try container.decodeIfPresent(String.self, forKey: .owningIssueId)
    projectId = try container.decodeIfPresent(String.self, forKey: .projectId)
    lastSeq = try container.decode(Int.self, forKey: .lastSeq)
    lastMessagePreview = try container.decodeIfPresent(String.self, forKey: .lastMessagePreview)
    createdAt = try container.decode(Date.self, forKey: .createdAt)
    updatedAt = try container.decode(Date.self, forKey: .updatedAt)
    deletedAt = try container.decodeIfPresent(Date.self, forKey: .deletedAt)
    queuePaused = try container.decode(Bool.self, forKey: .queuePaused)
    queueRevision = try container.decode(Int.self, forKey: .queueRevision)
    pendingFollowUpCount = try container.decode(Int.self, forKey: .pendingFollowUpCount)
    v2LastSeq = try container.decode(Int.self, forKey: .v2LastSeq)
    try validate()
  }

  func encode(to encoder: Encoder) throws {
    try validate()
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(id, forKey: .id)
    try container.encode(agentId, forKey: .agentId)
    try container.encode(agentName, forKey: .agentName)
    try container.encode(title, forKey: .title)
    try container.encode(revision, forKey: .revision)
    try container.encode(status, forKey: .status)
    try container.encode(activeTurnId, forKey: .activeTurnId)
    try container.encode(owningIssueId, forKey: .owningIssueId)
    try container.encode(projectId, forKey: .projectId)
    try container.encode(lastSeq, forKey: .lastSeq)
    try container.encode(lastMessagePreview, forKey: .lastMessagePreview)
    try container.encode(createdAt, forKey: .createdAt)
    try container.encode(updatedAt, forKey: .updatedAt)
    try container.encodeIfPresent(deletedAt, forKey: .deletedAt)
    try container.encode(queuePaused, forKey: .queuePaused)
    try container.encode(queueRevision, forKey: .queueRevision)
    try container.encode(pendingFollowUpCount, forKey: .pendingFollowUpCount)
    try container.encode(v2LastSeq, forKey: .v2LastSeq)
  }

  private func validate() throws {
    try MobileV2ContractValidation.validateCanonicalUUID(id, field: "id")
    try MobileV2ContractValidation.validateNonempty(agentId, field: "agentId")
    try MobileV2ContractValidation.validateNonempty(agentName, field: "agentName")
    try MobileV2ContractValidation.validatePositive(revision, field: "revision")
    if let activeTurnId {
      try MobileV2ContractValidation.validateLegacyRunID(activeTurnId, field: "activeTurnId")
    }
    try MobileV2ContractValidation.validateNonnegative(lastSeq, field: "lastSeq")
    try MobileV2ContractValidation.validateNonnegative(queueRevision, field: "queueRevision")
    try MobileV2ContractValidation.validateNonnegative(
      pendingFollowUpCount,
      field: "pendingFollowUpCount"
    )
    try MobileV2ContractValidation.validateNonnegative(v2LastSeq, field: "v2LastSeq")
  }
}

struct MobileV2ConversationPage: Codable, Hashable, Sendable {
  let items: [MobileV2ConversationSummary]
  let nextCursor: String?

  private enum CodingKeys: String, CodingKey, CaseIterable {
    case items
    case nextCursor
  }

  init(items: [MobileV2ConversationSummary], nextCursor: String?) {
    self.items = items
    self.nextCursor = nextCursor
  }

  init(from decoder: Decoder) throws {
    let keys = Set(CodingKeys.allCases.map(\.rawValue))
    try MobileV2ContractValidation.validateKeys(decoder, allowed: keys, required: keys)
    let container = try decoder.container(keyedBy: CodingKeys.self)
    items = try container.decode([MobileV2ConversationSummary].self, forKey: .items)
    nextCursor = try container.decodeIfPresent(String.self, forKey: .nextCursor)
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(items, forKey: .items)
    try container.encode(nextCursor, forKey: .nextCursor)
  }
}

enum MobileV2DeliveryKind: String, Codable, Hashable, Sendable {
  case normal
  case steer
  case followUp = "follow_up"
}

enum MobileV2DeliveryStatus: String, Codable, Hashable, Sendable {
  case pending
  case delivered
  case notDelivered = "not_delivered"
}

struct MobileV2ConversationMessage: Codable, Hashable, Identifiable, Sendable {
  let id: String
  let conversationId: String
  let turnId: String
  let ordinal: Int
  let role: MessageRole
  let status: MessageStatus
  let content: MessageContent
  let createdAt: Date
  let updatedAt: Date
  let runId: String
  let segmentIndex: Int
  let deliveryKind: MobileV2DeliveryKind
  let deliveryStatus: MobileV2DeliveryStatus?

  private enum CodingKeys: String, CodingKey, CaseIterable {
    case id
    case conversationId
    case turnId
    case ordinal
    case role
    case status
    case content
    case createdAt
    case updatedAt
    case runId
    case segmentIndex
    case deliveryKind
    case deliveryStatus
  }

  init(
    id: String,
    conversationId: String,
    turnId: String,
    ordinal: Int,
    role: MessageRole,
    status: MessageStatus,
    content: MessageContent,
    createdAt: Date,
    updatedAt: Date,
    runId: String,
    segmentIndex: Int,
    deliveryKind: MobileV2DeliveryKind,
    deliveryStatus: MobileV2DeliveryStatus?
  ) {
    self.id = id
    self.conversationId = conversationId
    self.turnId = turnId
    self.ordinal = ordinal
    self.role = role
    self.status = status
    self.content = content
    self.createdAt = createdAt
    self.updatedAt = updatedAt
    self.runId = runId
    self.segmentIndex = segmentIndex
    self.deliveryKind = deliveryKind
    self.deliveryStatus = deliveryStatus
  }

  init(from decoder: Decoder) throws {
    let allowed = Set(CodingKeys.allCases.map(\.rawValue))
    let required = allowed.subtracting([CodingKeys.deliveryStatus.rawValue])
    try MobileV2ContractValidation.validateKeys(decoder, allowed: allowed, required: required)
    let container = try decoder.container(keyedBy: CodingKeys.self)
    try MobileV2ContractValidation.validateOptionalNonNull(container, key: .deliveryStatus)
    id = try container.decode(String.self, forKey: .id)
    conversationId = try container.decode(String.self, forKey: .conversationId)
    turnId = try container.decode(String.self, forKey: .turnId)
    ordinal = try container.decode(Int.self, forKey: .ordinal)
    role = try container.decode(MessageRole.self, forKey: .role)
    status = try container.decode(MessageStatus.self, forKey: .status)
    content = try container.decode(
      MobileV2StrictConversationContent.self,
      forKey: .content
    ).value
    createdAt = try container.decode(Date.self, forKey: .createdAt)
    updatedAt = try container.decode(Date.self, forKey: .updatedAt)
    runId = try container.decode(String.self, forKey: .runId)
    segmentIndex = try container.decode(Int.self, forKey: .segmentIndex)
    deliveryKind = try container.decode(MobileV2DeliveryKind.self, forKey: .deliveryKind)
    deliveryStatus = try container.decodeIfPresent(
      MobileV2DeliveryStatus.self,
      forKey: .deliveryStatus
    )
    try validate()
  }

  func encode(to encoder: Encoder) throws {
    try validate()
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(id, forKey: .id)
    try container.encode(conversationId, forKey: .conversationId)
    try container.encode(turnId, forKey: .turnId)
    try container.encode(ordinal, forKey: .ordinal)
    try container.encode(role, forKey: .role)
    try container.encode(status, forKey: .status)
    try container.encode(MobileV2StrictConversationContent(content), forKey: .content)
    try container.encode(createdAt, forKey: .createdAt)
    try container.encode(updatedAt, forKey: .updatedAt)
    try container.encode(runId, forKey: .runId)
    try container.encode(segmentIndex, forKey: .segmentIndex)
    try container.encode(deliveryKind, forKey: .deliveryKind)
    try container.encodeIfPresent(deliveryStatus, forKey: .deliveryStatus)
  }

  var v1Projection: ConversationMessageDTO {
    ConversationMessageDTO(
      id: id,
      conversationId: conversationId,
      turnId: turnId,
      ordinal: ordinal,
      role: role,
      status: status,
      content: content,
      createdAt: createdAt,
      updatedAt: updatedAt
    )
  }

  private func validate() throws {
    try MobileV2ContractValidation.validateCanonicalUUID(id, field: "id")
    try MobileV2ContractValidation.validateCanonicalUUID(conversationId, field: "conversationId")
    try MobileV2ContractValidation.validateLegacyRunID(turnId, field: "turnId")
    try MobileV2ContractValidation.validatePositive(ordinal, field: "ordinal")
    try MobileV2ContractValidation.validateLegacyRunID(runId, field: "runId")
    try MobileV2ContractValidation.validateNonnegative(segmentIndex, field: "segmentIndex")
  }
}

struct MobileV2ConversationMessagePage: Codable, Hashable, Sendable {
  let items: [MobileV2ConversationMessage]
  let nextCursor: String?
  let throughSeq: Int

  private enum CodingKeys: String, CodingKey, CaseIterable {
    case items
    case nextCursor
    case throughSeq
  }

  init(items: [MobileV2ConversationMessage], nextCursor: String?, throughSeq: Int) {
    self.items = items
    self.nextCursor = nextCursor
    self.throughSeq = throughSeq
  }

  init(from decoder: Decoder) throws {
    let keys = Set(CodingKeys.allCases.map(\.rawValue))
    try MobileV2ContractValidation.validateKeys(decoder, allowed: keys, required: keys)
    let container = try decoder.container(keyedBy: CodingKeys.self)
    items = try container.decode([MobileV2ConversationMessage].self, forKey: .items)
    nextCursor = try container.decodeIfPresent(String.self, forKey: .nextCursor)
    throughSeq = try container.decode(Int.self, forKey: .throughSeq)
    try MobileV2ContractValidation.validateNonnegative(throughSeq, field: "throughSeq")
  }

  func encode(to encoder: Encoder) throws {
    try MobileV2ContractValidation.validateNonnegative(throughSeq, field: "throughSeq")
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(items, forKey: .items)
    try container.encode(nextCursor, forKey: .nextCursor)
    try container.encode(throughSeq, forKey: .throughSeq)
  }
}

enum MobileV2PendingInputKind: String, Codable, Hashable, Sendable {
  case steer
  case followUp = "follow_up"
}

enum MobileV2PendingInputState: String, Codable, Hashable, Sendable {
  case queued
  case delivering
  case delivered
  case removed
  case failed
}

struct MobileV2PendingInput: Codable, Hashable, Identifiable, Sendable {
  var id: String { inputId }

  let inputId: String
  let kind: MobileV2PendingInputKind
  let targetTurnId: String?
  let text: String
  let images: [MessageImage]?
  let state: MobileV2PendingInputState
  let revision: Int
  let enqueueOrder: Int
  let runId: String?
  let segmentTurnId: String?
  let userMessageId: String?
  let assistantMessageId: String?
  let failureCode: String?
  let failureMessage: String?
  let createdAt: Date
  let updatedAt: Date
  let deliveredAt: Date?

  private enum CodingKeys: String, CodingKey, CaseIterable {
    case inputId
    case kind
    case targetTurnId
    case text
    case images
    case state
    case revision
    case enqueueOrder
    case runId
    case segmentTurnId
    case userMessageId
    case assistantMessageId
    case failureCode
    case failureMessage
    case createdAt
    case updatedAt
    case deliveredAt
  }

  init(
    inputId: String,
    kind: MobileV2PendingInputKind,
    targetTurnId: String?,
    text: String,
    images: [MessageImage]?,
    state: MobileV2PendingInputState,
    revision: Int,
    enqueueOrder: Int,
    runId: String?,
    segmentTurnId: String?,
    userMessageId: String?,
    assistantMessageId: String?,
    failureCode: String?,
    failureMessage: String?,
    createdAt: Date,
    updatedAt: Date,
    deliveredAt: Date?
  ) {
    self.inputId = inputId
    self.kind = kind
    self.targetTurnId = targetTurnId
    self.text = text
    self.images = images
    self.state = state
    self.revision = revision
    self.enqueueOrder = enqueueOrder
    self.runId = runId
    self.segmentTurnId = segmentTurnId
    self.userMessageId = userMessageId
    self.assistantMessageId = assistantMessageId
    self.failureCode = failureCode
    self.failureMessage = failureMessage
    self.createdAt = createdAt
    self.updatedAt = updatedAt
    self.deliveredAt = deliveredAt
  }

  init(from decoder: Decoder) throws {
    let allowed = Set(CodingKeys.allCases.map(\.rawValue))
    let required: Set<String> = [
      CodingKeys.inputId.rawValue,
      CodingKeys.kind.rawValue,
      CodingKeys.text.rawValue,
      CodingKeys.state.rawValue,
      CodingKeys.revision.rawValue,
      CodingKeys.enqueueOrder.rawValue,
      CodingKeys.createdAt.rawValue,
      CodingKeys.updatedAt.rawValue,
    ]
    try MobileV2ContractValidation.validateKeys(decoder, allowed: allowed, required: required)
    let container = try decoder.container(keyedBy: CodingKeys.self)
    for key in CodingKeys.allCases where required.contains(key.rawValue) == false {
      try MobileV2ContractValidation.validateOptionalNonNull(container, key: key)
    }
    inputId = try container.decode(String.self, forKey: .inputId)
    kind = try container.decode(MobileV2PendingInputKind.self, forKey: .kind)
    targetTurnId = try container.decodeIfPresent(String.self, forKey: .targetTurnId)
    text = try container.decode(String.self, forKey: .text)
    images = try container.decodeIfPresent(
      [MobileV2StrictImage].self,
      forKey: .images
    )?.map(\.value)
    state = try container.decode(MobileV2PendingInputState.self, forKey: .state)
    revision = try container.decode(Int.self, forKey: .revision)
    enqueueOrder = try container.decode(Int.self, forKey: .enqueueOrder)
    runId = try container.decodeIfPresent(String.self, forKey: .runId)
    segmentTurnId = try container.decodeIfPresent(String.self, forKey: .segmentTurnId)
    userMessageId = try container.decodeIfPresent(String.self, forKey: .userMessageId)
    assistantMessageId = try container.decodeIfPresent(String.self, forKey: .assistantMessageId)
    failureCode = try container.decodeIfPresent(String.self, forKey: .failureCode)
    failureMessage = try container.decodeIfPresent(String.self, forKey: .failureMessage)
    createdAt = try container.decode(Date.self, forKey: .createdAt)
    updatedAt = try container.decode(Date.self, forKey: .updatedAt)
    deliveredAt = try container.decodeIfPresent(Date.self, forKey: .deliveredAt)
    try validate()
  }

  func encode(to encoder: Encoder) throws {
    try validate()
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(inputId, forKey: .inputId)
    try container.encode(kind, forKey: .kind)
    try container.encodeIfPresent(targetTurnId, forKey: .targetTurnId)
    try container.encode(text, forKey: .text)
    if let images {
      try container.encode(images.map(MobileV2StrictImage.init), forKey: .images)
    }
    try container.encode(state, forKey: .state)
    try container.encode(revision, forKey: .revision)
    try container.encode(enqueueOrder, forKey: .enqueueOrder)
    try container.encodeIfPresent(runId, forKey: .runId)
    try container.encodeIfPresent(segmentTurnId, forKey: .segmentTurnId)
    try container.encodeIfPresent(userMessageId, forKey: .userMessageId)
    try container.encodeIfPresent(assistantMessageId, forKey: .assistantMessageId)
    try container.encodeIfPresent(failureCode, forKey: .failureCode)
    try container.encodeIfPresent(failureMessage, forKey: .failureMessage)
    try container.encode(createdAt, forKey: .createdAt)
    try container.encode(updatedAt, forKey: .updatedAt)
    try container.encodeIfPresent(deliveredAt, forKey: .deliveredAt)
  }

  private func validate() throws {
    try MobileV2ContractValidation.validateCanonicalUUID(inputId, field: "inputId")
    if kind == .steer {
      try MobileV2ContractValidation.require(targetTurnId != nil, field: "targetTurnId")
    }
    if let targetTurnId {
      try MobileV2ContractValidation.validateLegacyRunID(targetTurnId, field: "targetTurnId")
    }
    if let images {
      try MobileV2ContractValidation.require(images.count <= 4, field: "images")
      try MobileV2ContractValidation.require(
        images.allSatisfy { $0.data.isEmpty == false },
        field: "images"
      )
    }
    try MobileV2ContractValidation.validateNonnegative(revision, field: "revision")
    try MobileV2ContractValidation.validateNonnegative(enqueueOrder, field: "enqueueOrder")
    if let runId {
      try MobileV2ContractValidation.validateLegacyRunID(runId, field: "runId")
    }
    for (value, field) in [
      (segmentTurnId, "segmentTurnId"),
      (userMessageId, "userMessageId"),
      (assistantMessageId, "assistantMessageId"),
    ] where value != nil {
      try MobileV2ContractValidation.validateCanonicalUUID(value!, field: field)
    }
    if let failureCode {
      try MobileV2ContractValidation.require(
        MobileV2ContractValidation.apiErrorCodes.contains(failureCode),
        field: "failureCode"
      )
    }
    if let failureMessage {
      try MobileV2ContractValidation.validateNonempty(failureMessage, field: "failureMessage")
    }
  }
}

struct MobileV2ConversationBootstrap: Codable, Hashable, Sendable {
  let conversation: MobileV2ConversationSummary
  let messages: [MobileV2ConversationMessage]
  let nextCursor: String?
  let pendingInputs: [MobileV2PendingInput]
  let queuePaused: Bool
  let queueRevision: Int
  let v2ThroughSeq: Int

  private enum CodingKeys: String, CodingKey, CaseIterable {
    case conversation
    case messages
    case nextCursor
    case pendingInputs
    case queuePaused
    case queueRevision
    case v2ThroughSeq
  }

  init(
    conversation: MobileV2ConversationSummary,
    messages: [MobileV2ConversationMessage],
    nextCursor: String?,
    pendingInputs: [MobileV2PendingInput],
    queuePaused: Bool,
    queueRevision: Int,
    v2ThroughSeq: Int
  ) {
    self.conversation = conversation
    self.messages = messages
    self.nextCursor = nextCursor
    self.pendingInputs = pendingInputs
    self.queuePaused = queuePaused
    self.queueRevision = queueRevision
    self.v2ThroughSeq = v2ThroughSeq
  }

  init(from decoder: Decoder) throws {
    let keys = Set(CodingKeys.allCases.map(\.rawValue))
    try MobileV2ContractValidation.validateKeys(decoder, allowed: keys, required: keys)
    let container = try decoder.container(keyedBy: CodingKeys.self)
    conversation = try container.decode(MobileV2ConversationSummary.self, forKey: .conversation)
    messages = try container.decode([MobileV2ConversationMessage].self, forKey: .messages)
    nextCursor = try container.decodeIfPresent(String.self, forKey: .nextCursor)
    pendingInputs = try container.decode([MobileV2PendingInput].self, forKey: .pendingInputs)
    queuePaused = try container.decode(Bool.self, forKey: .queuePaused)
    queueRevision = try container.decode(Int.self, forKey: .queueRevision)
    v2ThroughSeq = try container.decode(Int.self, forKey: .v2ThroughSeq)
    try validate()
  }

  func encode(to encoder: Encoder) throws {
    try validate()
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(conversation, forKey: .conversation)
    try container.encode(messages, forKey: .messages)
    try container.encode(nextCursor, forKey: .nextCursor)
    try container.encode(pendingInputs, forKey: .pendingInputs)
    try container.encode(queuePaused, forKey: .queuePaused)
    try container.encode(queueRevision, forKey: .queueRevision)
    try container.encode(v2ThroughSeq, forKey: .v2ThroughSeq)
  }

  private func validate() throws {
    try MobileV2ContractValidation.validateNonnegative(queueRevision, field: "queueRevision")
    try MobileV2ContractValidation.validateNonnegative(v2ThroughSeq, field: "v2ThroughSeq")
  }
}

struct MobileV2ReplayPage: Codable, Hashable, Sendable {
  let frames: [MobileV2SequencedFrame]
  let v2ThroughSeq: Int

  private enum CodingKeys: String, CodingKey, CaseIterable {
    case frames
    case v2ThroughSeq
  }

  init(frames: [MobileV2SequencedFrame], v2ThroughSeq: Int) {
    self.frames = frames
    self.v2ThroughSeq = v2ThroughSeq
  }

  init(from decoder: Decoder) throws {
    let keys = Set(CodingKeys.allCases.map(\.rawValue))
    try MobileV2ContractValidation.validateKeys(decoder, allowed: keys, required: keys)
    let container = try decoder.container(keyedBy: CodingKeys.self)
    frames = try container.decode([MobileV2SequencedFrame].self, forKey: .frames)
    v2ThroughSeq = try container.decode(Int.self, forKey: .v2ThroughSeq)
    try MobileV2ContractValidation.validateNonnegative(v2ThroughSeq, field: "v2ThroughSeq")
  }

  func encode(to encoder: Encoder) throws {
    try MobileV2ContractValidation.validateNonnegative(v2ThroughSeq, field: "v2ThroughSeq")
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(frames, forKey: .frames)
    try container.encode(v2ThroughSeq, forKey: .v2ThroughSeq)
  }
}
