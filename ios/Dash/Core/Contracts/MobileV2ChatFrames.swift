import Foundation

enum MobileV2InputBehavior: String, Codable, Hashable, Sendable {
  case steer
  case followUp
}

private enum MobileV2FrameCodingKeys: String, CodingKey, CaseIterable {
  case type
  case id
  case inputId
  case agentId
  case channelId
  case conversationId
  case text
  case location
  case images
  case resumable
  case behavior
  case expectedActiveTurnId
  case expectedRevision
  case expectedQueueRevision
  case questionId
  case answer
  case contractVersion
  case capabilities
  case sinceV2Seq
  case v2ThroughSeq
  case code
  case error
  case retryable
  case details
  case v2Seq
  case runId
  case segmentTurnId
  case userMessageId
  case assistantMessageId
  case revision
  case origin
  case kind
  case requestId
  case event
  case outcome
  case queueRevision
  case input
  case queuePaused
  case pendingFollowUpCount
}

private func validateFrameKeys(
  _ decoder: Decoder,
  allowed: [MobileV2FrameCodingKeys],
  required: [MobileV2FrameCodingKeys]
) throws {
  try MobileV2ContractValidation.validateKeys(
    decoder,
    allowed: Set(allowed.map(\.rawValue)),
    required: Set(required.map(\.rawValue))
  )
}

private func decodeFrameType(_ decoder: Decoder) throws -> String {
  let container = try decoder.container(keyedBy: MobileV2FrameCodingKeys.self)
  return try container.decode(String.self, forKey: .type)
}

private func validateFrameUUID(_ value: String, _ key: MobileV2FrameCodingKeys) throws {
  if case .conversationId = key {
    try MobileV2ContractValidation.validateConversationIdentifier(value, field: key.rawValue)
  } else {
    try MobileV2ContractValidation.validateCanonicalUUID(value, field: key.rawValue)
  }
}

private func validateFrameLegacyRunID(_ value: String, _ key: MobileV2FrameCodingKeys) throws {
  try MobileV2ContractValidation.validateLegacyRunID(value, field: key.rawValue)
}

private func validateFrameImages(_ images: [MessageImage]?) throws {
  guard let images else { return }
  try MobileV2ContractValidation.require(images.count <= 4, field: "images")
  var totalBytes = 0
  for image in images {
    try MobileV2ContractValidation.validateNonempty(image.data, field: "images.data")
    guard let decoded = Data(base64Encoded: image.data), decoded.base64EncodedString() == image.data
    else {
      throw MobileV2ContractValidationError.invalidField("images.data")
    }
    try MobileV2ContractValidation.require(decoded.count <= 5 * 1_024 * 1_024, field: "images")
    totalBytes += decoded.count
  }
  try MobileV2ContractValidation.require(totalBytes <= 12 * 1_024 * 1_024, field: "images")
}

private func isValidFrameRFC3339(_ value: String) -> Bool {
  let pattern =
    #"^[0-9]{4}-[0-9]{2}-[0-9]{2}[Tt][0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?(?:[Zz]|[+-][0-9]{2}:[0-9]{2})$"#
  let fullRange = value.startIndex..<value.endIndex
  guard value.range(of: pattern, options: .regularExpression) == fullRange else {
    return false
  }

  let bytes = Array(value.utf8)
  func decimal(_ range: Range<Int>) -> Int {
    range.reduce(0) { result, index in result * 10 + Int(bytes[index] - 0x30) }
  }
  func daysInMonth(year: Int, month: Int) -> Int {
    if month == 2 {
      let isLeapYear = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
      return isLeapYear ? 29 : 28
    }
    return [4, 6, 9, 11].contains(month) ? 30 : 31
  }

  let year = decimal(0..<4)
  let month = decimal(5..<7)
  let day = decimal(8..<10)
  let hour = decimal(11..<13)
  let minute = decimal(14..<16)
  let second = decimal(17..<19)
  guard
    (1...12).contains(month),
    (1...daysInMonth(year: year, month: month)).contains(day),
    hour <= 23,
    minute <= 59,
    second <= 60
  else {
    return false
  }

  let hasNumericOffset = bytes.last != 0x5A && bytes.last != 0x7A
  let offsetSign = hasNumericOffset && bytes[bytes.count - 6] == 0x2D ? -1 : 1
  let offsetHour = hasNumericOffset ? decimal((bytes.count - 5)..<(bytes.count - 3)) : 0
  let offsetMinute = hasNumericOffset ? decimal((bytes.count - 2)..<bytes.count) : 0
  guard offsetHour <= 23, offsetMinute <= 59 else { return false }
  guard second == 60 else { return true }

  let utcMinute = minute - offsetMinute * offsetSign
  let utcHour = hour - offsetHour * offsetSign - (utcMinute < 0 ? 1 : 0)
  return (utcHour == 23 || utcHour == -1) && (utcMinute == 59 || utcMinute == -1)
}

private func validateFrameLocation(_ location: ClientLocation?) throws {
  guard let location else { return }
  try MobileV2ContractValidation.require(
    (1...200).contains(location.timezone.unicodeScalars.count),
    field: "location.timezone"
  )
  try MobileV2ContractValidation.require(
    (-840...840).contains(location.utcOffsetMinutes),
    field: "location.utcOffsetMinutes"
  )
  try MobileV2ContractValidation.require(
    (1...200).contains(location.locale.unicodeScalars.count),
    field: "location.locale"
  )
  if let region = location.region {
    try MobileV2ContractValidation.require(
      region.unicodeScalars.count == 2,
      field: "location.region"
    )
  }
  if let precise = location.precise {
    try MobileV2ContractValidation.require(
      (-90...90).contains(precise.latitude),
      field: "location.precise.latitude"
    )
    try MobileV2ContractValidation.require(
      (-180...180).contains(precise.longitude),
      field: "location.precise.longitude"
    )
    try MobileV2ContractValidation.require(
      precise.accuracyMeters.isFinite
        && precise.accuracyMeters >= 0
        && precise.accuracyMeters <= Double(MobileV2ContractValidation.maxSafeInteger)
        && precise.accuracyMeters.rounded(.towardZero) == precise.accuracyMeters,
      field: "location.precise.accuracyMeters"
    )
    try MobileV2ContractValidation.require(
      isValidFrameRFC3339(precise.capturedAt),
      field: "location.precise.capturedAt"
    )
    if let place = precise.place {
      try MobileV2ContractValidation.require(
        (1...200).contains(place.unicodeScalars.count),
        field: "location.precise.place"
      )
    }
  }
}

enum MobileV2WsClientFrame: Codable, Hashable, Sendable {
  case hello(contractVersion: Int, capabilities: [String])
  case subscribeConversation(
    id: String,
    agentId: String,
    conversationId: String,
    sinceV2Seq: Int
  )
  case message(
    id: String,
    agentId: String,
    channelId: String,
    conversationId: String,
    text: String,
    location: ClientLocation?,
    images: [MessageImage]?,
    resumable: Bool
  )
  case enqueueInput(
    id: String,
    inputId: String,
    agentId: String,
    channelId: String,
    conversationId: String,
    text: String,
    images: [MessageImage]?,
    behavior: MobileV2InputBehavior,
    expectedActiveTurnId: String?
  )
  case editFollowUp(
    id: String,
    conversationId: String,
    inputId: String,
    expectedRevision: Int,
    text: String,
    images: [MessageImage]?
  )
  case removeFollowUp(
    id: String,
    conversationId: String,
    inputId: String,
    expectedRevision: Int
  )
  case resumeFollowUps(
    id: String,
    conversationId: String,
    expectedQueueRevision: Int
  )
  case answer(id: String, questionId: String, answer: String)
  case cancel(id: String)

  init(from decoder: Decoder) throws {
    let type = try decodeFrameType(decoder)
    let container = try decoder.container(keyedBy: MobileV2FrameCodingKeys.self)
    switch type {
    case "hello":
      try validateFrameKeys(
        decoder,
        allowed: [.type, .contractVersion, .capabilities],
        required: [.type, .contractVersion, .capabilities]
      )
      let contractVersion = try container.decode(Int.self, forKey: .contractVersion)
      let capabilities = try container.decode([String].self, forKey: .capabilities)
      try MobileV2ContractValidation.require(contractVersion == 2, field: "contractVersion")
      try MobileV2ContractValidation.validateCapabilities(capabilities)
      self = .hello(contractVersion: contractVersion, capabilities: capabilities)
    case "subscribe_conversation":
      try validateFrameKeys(
        decoder,
        allowed: [.type, .id, .agentId, .conversationId, .sinceV2Seq],
        required: [.type, .id, .agentId, .conversationId, .sinceV2Seq]
      )
      let id = try container.decode(String.self, forKey: .id)
      let agentId = try container.decode(String.self, forKey: .agentId)
      let conversationId = try container.decode(String.self, forKey: .conversationId)
      let sinceV2Seq = try container.decode(Int.self, forKey: .sinceV2Seq)
      try validateFrameUUID(id, .id)
      try MobileV2ContractValidation.validateNonempty(agentId, field: "agentId")
      try validateFrameUUID(conversationId, .conversationId)
      try MobileV2ContractValidation.validateNonnegative(sinceV2Seq, field: "sinceV2Seq")
      self = .subscribeConversation(
        id: id,
        agentId: agentId,
        conversationId: conversationId,
        sinceV2Seq: sinceV2Seq
      )
    case "message":
      try validateFrameKeys(
        decoder,
        allowed: [
          .type, .id, .agentId, .channelId, .conversationId, .text, .location, .images,
          .resumable,
        ],
        required: [.type, .id, .agentId, .channelId, .conversationId, .text, .resumable]
      )
      try MobileV2ContractValidation.validateOptionalNonNull(container, key: .location)
      try MobileV2ContractValidation.validateOptionalNonNull(container, key: .images)
      let id = try container.decode(String.self, forKey: .id)
      let agentId = try container.decode(String.self, forKey: .agentId)
      let channelId = try container.decode(String.self, forKey: .channelId)
      let conversationId = try container.decode(String.self, forKey: .conversationId)
      let text = try container.decode(String.self, forKey: .text)
      let location = try container.decodeIfPresent(
        MobileV2StrictClientLocation.self,
        forKey: .location
      )?.value
      let images = try container.decodeIfPresent(
        [MobileV2StrictImage].self,
        forKey: .images
      )?.map(\.value)
      let resumable = try container.decode(Bool.self, forKey: .resumable)
      try validateFrameLegacyRunID(id, .id)
      try MobileV2ContractValidation.validateNonempty(agentId, field: "agentId")
      try MobileV2ContractValidation.validateNonempty(channelId, field: "channelId")
      try validateFrameUUID(conversationId, .conversationId)
      try validateFrameLocation(location)
      try validateFrameImages(images)
      try MobileV2ContractValidation.require(resumable, field: "resumable")
      self = .message(
        id: id,
        agentId: agentId,
        channelId: channelId,
        conversationId: conversationId,
        text: text,
        location: location,
        images: images,
        resumable: resumable
      )
    case "enqueue_input":
      try validateFrameKeys(
        decoder,
        allowed: [
          .type, .id, .inputId, .agentId, .channelId, .conversationId, .text, .images,
          .behavior, .expectedActiveTurnId,
        ],
        required: [
          .type, .id, .inputId, .agentId, .channelId, .conversationId, .text, .behavior,
        ]
      )
      try MobileV2ContractValidation.validateOptionalNonNull(container, key: .images)
      try MobileV2ContractValidation.validateOptionalNonNull(
        container,
        key: .expectedActiveTurnId
      )
      let id = try container.decode(String.self, forKey: .id)
      let inputId = try container.decode(String.self, forKey: .inputId)
      let agentId = try container.decode(String.self, forKey: .agentId)
      let channelId = try container.decode(String.self, forKey: .channelId)
      let conversationId = try container.decode(String.self, forKey: .conversationId)
      let text = try container.decode(String.self, forKey: .text)
      let images = try container.decodeIfPresent(
        [MobileV2StrictImage].self,
        forKey: .images
      )?.map(\.value)
      let behavior = try container.decode(MobileV2InputBehavior.self, forKey: .behavior)
      let expectedActiveTurnId = try container.decodeIfPresent(
        String.self,
        forKey: .expectedActiveTurnId
      )
      try validateFrameUUID(id, .id)
      try validateFrameUUID(inputId, .inputId)
      try MobileV2ContractValidation.validateNonempty(agentId, field: "agentId")
      try MobileV2ContractValidation.validateNonempty(channelId, field: "channelId")
      try validateFrameUUID(conversationId, .conversationId)
      try validateFrameImages(images)
      switch behavior {
      case .steer:
        guard let expectedActiveTurnId else {
          throw MobileV2ContractValidationError.invalidField("expectedActiveTurnId")
        }
        try validateFrameLegacyRunID(expectedActiveTurnId, .expectedActiveTurnId)
      case .followUp:
        try MobileV2ContractValidation.require(
          expectedActiveTurnId == nil,
          field: "expectedActiveTurnId"
        )
      }
      self = .enqueueInput(
        id: id,
        inputId: inputId,
        agentId: agentId,
        channelId: channelId,
        conversationId: conversationId,
        text: text,
        images: images,
        behavior: behavior,
        expectedActiveTurnId: expectedActiveTurnId
      )
    case "edit_follow_up":
      try validateFrameKeys(
        decoder,
        allowed: [.type, .id, .conversationId, .inputId, .expectedRevision, .text, .images],
        required: [.type, .id, .conversationId, .inputId, .expectedRevision, .text]
      )
      try MobileV2ContractValidation.validateOptionalNonNull(container, key: .images)
      let id = try container.decode(String.self, forKey: .id)
      let conversationId = try container.decode(String.self, forKey: .conversationId)
      let inputId = try container.decode(String.self, forKey: .inputId)
      let expectedRevision = try container.decode(Int.self, forKey: .expectedRevision)
      let text = try container.decode(String.self, forKey: .text)
      let images = try container.decodeIfPresent(
        [MobileV2StrictImage].self,
        forKey: .images
      )?.map(\.value)
      try validateFrameUUID(id, .id)
      try validateFrameUUID(conversationId, .conversationId)
      try validateFrameUUID(inputId, .inputId)
      try MobileV2ContractValidation.validateNonnegative(
        expectedRevision,
        field: "expectedRevision"
      )
      try validateFrameImages(images)
      self = .editFollowUp(
        id: id,
        conversationId: conversationId,
        inputId: inputId,
        expectedRevision: expectedRevision,
        text: text,
        images: images
      )
    case "remove_follow_up":
      try validateFrameKeys(
        decoder,
        allowed: [.type, .id, .conversationId, .inputId, .expectedRevision],
        required: [.type, .id, .conversationId, .inputId, .expectedRevision]
      )
      let id = try container.decode(String.self, forKey: .id)
      let conversationId = try container.decode(String.self, forKey: .conversationId)
      let inputId = try container.decode(String.self, forKey: .inputId)
      let expectedRevision = try container.decode(Int.self, forKey: .expectedRevision)
      try validateFrameUUID(id, .id)
      try validateFrameUUID(conversationId, .conversationId)
      try validateFrameUUID(inputId, .inputId)
      try MobileV2ContractValidation.validateNonnegative(
        expectedRevision,
        field: "expectedRevision"
      )
      self = .removeFollowUp(
        id: id,
        conversationId: conversationId,
        inputId: inputId,
        expectedRevision: expectedRevision
      )
    case "resume_follow_ups":
      try validateFrameKeys(
        decoder,
        allowed: [.type, .id, .conversationId, .expectedQueueRevision],
        required: [.type, .id, .conversationId, .expectedQueueRevision]
      )
      let id = try container.decode(String.self, forKey: .id)
      let conversationId = try container.decode(String.self, forKey: .conversationId)
      let expectedQueueRevision = try container.decode(Int.self, forKey: .expectedQueueRevision)
      try validateFrameUUID(id, .id)
      try validateFrameUUID(conversationId, .conversationId)
      try MobileV2ContractValidation.validateNonnegative(
        expectedQueueRevision,
        field: "expectedQueueRevision"
      )
      self = .resumeFollowUps(
        id: id,
        conversationId: conversationId,
        expectedQueueRevision: expectedQueueRevision
      )
    case "answer":
      try validateFrameKeys(
        decoder,
        allowed: [.type, .id, .questionId, .answer],
        required: [.type, .id, .questionId, .answer]
      )
      let id = try container.decode(String.self, forKey: .id)
      let questionId = try container.decode(String.self, forKey: .questionId)
      let answer = try container.decode(String.self, forKey: .answer)
      try validateFrameLegacyRunID(id, .id)
      try MobileV2ContractValidation.validateNonempty(questionId, field: "questionId")
      self = .answer(id: id, questionId: questionId, answer: answer)
    case "cancel":
      try validateFrameKeys(decoder, allowed: [.type, .id], required: [.type, .id])
      let id = try container.decode(String.self, forKey: .id)
      try validateFrameLegacyRunID(id, .id)
      self = .cancel(id: id)
    default:
      throw MobileV2ContractValidationError.invalidField("type")
    }
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: MobileV2FrameCodingKeys.self)
    switch self {
    case let .hello(contractVersion, capabilities):
      try MobileV2ContractValidation.require(contractVersion == 2, field: "contractVersion")
      try MobileV2ContractValidation.validateCapabilities(capabilities)
      try container.encode("hello", forKey: .type)
      try container.encode(contractVersion, forKey: .contractVersion)
      try container.encode(capabilities, forKey: .capabilities)
    case let .subscribeConversation(id, agentId, conversationId, sinceV2Seq):
      try validateFrameUUID(id, .id)
      try MobileV2ContractValidation.validateNonempty(agentId, field: "agentId")
      try validateFrameUUID(conversationId, .conversationId)
      try MobileV2ContractValidation.validateNonnegative(sinceV2Seq, field: "sinceV2Seq")
      try container.encode("subscribe_conversation", forKey: .type)
      try container.encode(id, forKey: .id)
      try container.encode(agentId, forKey: .agentId)
      try container.encode(conversationId, forKey: .conversationId)
      try container.encode(sinceV2Seq, forKey: .sinceV2Seq)
    case let .message(
      id,
      agentId,
      channelId,
      conversationId,
      text,
      location,
      images,
      resumable
    ):
      try validateFrameLegacyRunID(id, .id)
      try MobileV2ContractValidation.validateNonempty(agentId, field: "agentId")
      try MobileV2ContractValidation.validateNonempty(channelId, field: "channelId")
      try validateFrameUUID(conversationId, .conversationId)
      try validateFrameLocation(location)
      try validateFrameImages(images)
      try MobileV2ContractValidation.require(resumable, field: "resumable")
      try container.encode("message", forKey: .type)
      try container.encode(id, forKey: .id)
      try container.encode(agentId, forKey: .agentId)
      try container.encode(channelId, forKey: .channelId)
      try container.encode(conversationId, forKey: .conversationId)
      try container.encode(text, forKey: .text)
      if let location {
        try container.encode(MobileV2StrictClientLocation(location), forKey: .location)
      }
      if let images {
        try container.encode(images.map(MobileV2StrictImage.init), forKey: .images)
      }
      try container.encode(resumable, forKey: .resumable)
    case let .enqueueInput(
      id,
      inputId,
      agentId,
      channelId,
      conversationId,
      text,
      images,
      behavior,
      expectedActiveTurnId
    ):
      try validateFrameUUID(id, .id)
      try validateFrameUUID(inputId, .inputId)
      try MobileV2ContractValidation.validateNonempty(agentId, field: "agentId")
      try MobileV2ContractValidation.validateNonempty(channelId, field: "channelId")
      try validateFrameUUID(conversationId, .conversationId)
      try validateFrameImages(images)
      switch behavior {
      case .steer:
        guard let expectedActiveTurnId else {
          throw MobileV2ContractValidationError.invalidField("expectedActiveTurnId")
        }
        try validateFrameLegacyRunID(expectedActiveTurnId, .expectedActiveTurnId)
      case .followUp:
        try MobileV2ContractValidation.require(
          expectedActiveTurnId == nil,
          field: "expectedActiveTurnId"
        )
      }
      try container.encode("enqueue_input", forKey: .type)
      try container.encode(id, forKey: .id)
      try container.encode(inputId, forKey: .inputId)
      try container.encode(agentId, forKey: .agentId)
      try container.encode(channelId, forKey: .channelId)
      try container.encode(conversationId, forKey: .conversationId)
      try container.encode(text, forKey: .text)
      if let images {
        try container.encode(images.map(MobileV2StrictImage.init), forKey: .images)
      }
      try container.encode(behavior, forKey: .behavior)
      try container.encodeIfPresent(expectedActiveTurnId, forKey: .expectedActiveTurnId)
    case let .editFollowUp(id, conversationId, inputId, expectedRevision, text, images):
      try validateFrameUUID(id, .id)
      try validateFrameUUID(conversationId, .conversationId)
      try validateFrameUUID(inputId, .inputId)
      try MobileV2ContractValidation.validateNonnegative(
        expectedRevision,
        field: "expectedRevision"
      )
      try validateFrameImages(images)
      try container.encode("edit_follow_up", forKey: .type)
      try container.encode(id, forKey: .id)
      try container.encode(conversationId, forKey: .conversationId)
      try container.encode(inputId, forKey: .inputId)
      try container.encode(expectedRevision, forKey: .expectedRevision)
      try container.encode(text, forKey: .text)
      if let images {
        try container.encode(images.map(MobileV2StrictImage.init), forKey: .images)
      }
    case let .removeFollowUp(id, conversationId, inputId, expectedRevision):
      try validateFrameUUID(id, .id)
      try validateFrameUUID(conversationId, .conversationId)
      try validateFrameUUID(inputId, .inputId)
      try MobileV2ContractValidation.validateNonnegative(
        expectedRevision,
        field: "expectedRevision"
      )
      try container.encode("remove_follow_up", forKey: .type)
      try container.encode(id, forKey: .id)
      try container.encode(conversationId, forKey: .conversationId)
      try container.encode(inputId, forKey: .inputId)
      try container.encode(expectedRevision, forKey: .expectedRevision)
    case let .resumeFollowUps(id, conversationId, expectedQueueRevision):
      try validateFrameUUID(id, .id)
      try validateFrameUUID(conversationId, .conversationId)
      try MobileV2ContractValidation.validateNonnegative(
        expectedQueueRevision,
        field: "expectedQueueRevision"
      )
      try container.encode("resume_follow_ups", forKey: .type)
      try container.encode(id, forKey: .id)
      try container.encode(conversationId, forKey: .conversationId)
      try container.encode(expectedQueueRevision, forKey: .expectedQueueRevision)
    case let .answer(id, questionId, answer):
      try validateFrameLegacyRunID(id, .id)
      try MobileV2ContractValidation.validateNonempty(questionId, field: "questionId")
      try container.encode("answer", forKey: .type)
      try container.encode(id, forKey: .id)
      try container.encode(questionId, forKey: .questionId)
      try container.encode(answer, forKey: .answer)
    case let .cancel(id):
      try validateFrameLegacyRunID(id, .id)
      try container.encode("cancel", forKey: .type)
      try container.encode(id, forKey: .id)
    }
  }
}

enum MobileV2ControlFrame: Codable, Hashable, Sendable {
  case helloAck(contractVersion: Int, capabilities: [String])
  case conversationSubscribed(id: String, conversationId: String, v2ThroughSeq: Int)
  case commandRejected(
    id: String,
    conversationId: String?,
    code: String,
    error: String,
    retryable: Bool,
    details: JSONValue?
  )

  init(from decoder: Decoder) throws {
    let type = try decodeFrameType(decoder)
    let container = try decoder.container(keyedBy: MobileV2FrameCodingKeys.self)
    switch type {
    case "hello_ack":
      try validateFrameKeys(
        decoder,
        allowed: [.type, .contractVersion, .capabilities],
        required: [.type, .contractVersion, .capabilities]
      )
      let contractVersion = try container.decode(Int.self, forKey: .contractVersion)
      let capabilities = try container.decode([String].self, forKey: .capabilities)
      try MobileV2ContractValidation.require(contractVersion == 2, field: "contractVersion")
      try MobileV2ContractValidation.validateCapabilities(capabilities)
      self = .helloAck(contractVersion: contractVersion, capabilities: capabilities)
    case "conversation_subscribed":
      try validateFrameKeys(
        decoder,
        allowed: [.type, .id, .conversationId, .v2ThroughSeq],
        required: [.type, .id, .conversationId, .v2ThroughSeq]
      )
      let id = try container.decode(String.self, forKey: .id)
      let conversationId = try container.decode(String.self, forKey: .conversationId)
      let v2ThroughSeq = try container.decode(Int.self, forKey: .v2ThroughSeq)
      try validateFrameUUID(id, .id)
      try validateFrameUUID(conversationId, .conversationId)
      try MobileV2ContractValidation.validateNonnegative(v2ThroughSeq, field: "v2ThroughSeq")
      self = .conversationSubscribed(
        id: id,
        conversationId: conversationId,
        v2ThroughSeq: v2ThroughSeq
      )
    case "command_rejected":
      try validateFrameKeys(
        decoder,
        allowed: [.type, .id, .conversationId, .code, .error, .retryable, .details],
        required: [.type, .id, .code, .error, .retryable]
      )
      try MobileV2ContractValidation.validateOptionalNonNull(container, key: .conversationId)
      try MobileV2ContractValidation.validateOptionalNonNull(container, key: .details)
      let id = try container.decode(String.self, forKey: .id)
      let conversationId = try container.decodeIfPresent(String.self, forKey: .conversationId)
      let code = try container.decode(String.self, forKey: .code)
      let error = try container.decode(String.self, forKey: .error)
      let retryable = try container.decode(Bool.self, forKey: .retryable)
      let details = try container.decodeIfPresent(JSONValue.self, forKey: .details)
      try validateFrameLegacyRunID(id, .id)
      if let conversationId {
        try validateFrameUUID(conversationId, .conversationId)
      }
      try MobileV2ContractValidation.require(
        MobileV2ContractValidation.apiErrorCodes.contains(code),
        field: "code"
      )
      try MobileV2ContractValidation.validateNonempty(error, field: "error")
      if let details {
        guard case .object = details else {
          throw MobileV2ContractValidationError.invalidField("details")
        }
      }
      self = .commandRejected(
        id: id,
        conversationId: conversationId,
        code: code,
        error: error,
        retryable: retryable,
        details: details
      )
    default:
      throw MobileV2ContractValidationError.invalidField("type")
    }
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: MobileV2FrameCodingKeys.self)
    switch self {
    case let .helloAck(contractVersion, capabilities):
      try MobileV2ContractValidation.require(contractVersion == 2, field: "contractVersion")
      try MobileV2ContractValidation.validateCapabilities(capabilities)
      try container.encode("hello_ack", forKey: .type)
      try container.encode(contractVersion, forKey: .contractVersion)
      try container.encode(capabilities, forKey: .capabilities)
    case let .conversationSubscribed(id, conversationId, v2ThroughSeq):
      try validateFrameUUID(id, .id)
      try validateFrameUUID(conversationId, .conversationId)
      try MobileV2ContractValidation.validateNonnegative(v2ThroughSeq, field: "v2ThroughSeq")
      try container.encode("conversation_subscribed", forKey: .type)
      try container.encode(id, forKey: .id)
      try container.encode(conversationId, forKey: .conversationId)
      try container.encode(v2ThroughSeq, forKey: .v2ThroughSeq)
    case let .commandRejected(id, conversationId, code, error, retryable, details):
      try validateFrameLegacyRunID(id, .id)
      if let conversationId {
        try validateFrameUUID(conversationId, .conversationId)
      }
      try MobileV2ContractValidation.require(
        MobileV2ContractValidation.apiErrorCodes.contains(code),
        field: "code"
      )
      try MobileV2ContractValidation.validateNonempty(error, field: "error")
      if let details {
        guard case .object = details else {
          throw MobileV2ContractValidationError.invalidField("details")
        }
      }
      try container.encode("command_rejected", forKey: .type)
      try container.encode(id, forKey: .id)
      try container.encodeIfPresent(conversationId, forKey: .conversationId)
      try container.encode(code, forKey: .code)
      try container.encode(error, forKey: .error)
      try container.encode(retryable, forKey: .retryable)
      try container.encodeIfPresent(details, forKey: .details)
    }
  }
}

enum MobileV2TurnOutcome: String, Codable, Hashable, Sendable {
  case completed
  case cancelled
  case interrupted
}

private typealias MobileV2FrameDecodingContainer =
  KeyedDecodingContainer<MobileV2FrameCodingKeys>
private typealias MobileV2FrameEncodingContainer =
  KeyedEncodingContainer<MobileV2FrameCodingKeys>

private func decodeRunFrameBase(
  _ container: MobileV2FrameDecodingContainer
) throws -> (
  id: String,
  conversationId: String,
  v2Seq: Int,
  runId: String,
  segmentTurnId: String
) {
  let id = try container.decode(String.self, forKey: .id)
  let conversationId = try container.decode(String.self, forKey: .conversationId)
  let v2Seq = try container.decode(Int.self, forKey: .v2Seq)
  let runId = try container.decode(String.self, forKey: .runId)
  let segmentTurnId = try container.decode(String.self, forKey: .segmentTurnId)
  try validateFrameLegacyRunID(id, .id)
  try validateFrameUUID(conversationId, .conversationId)
  try MobileV2ContractValidation.validateNonnegative(v2Seq, field: "v2Seq")
  try validateFrameLegacyRunID(runId, .runId)
  try validateFrameLegacyRunID(segmentTurnId, .segmentTurnId)
  return (id, conversationId, v2Seq, runId, segmentTurnId)
}

private func encodeRunFrameBase(
  _ container: inout MobileV2FrameEncodingContainer,
  id: String,
  conversationId: String,
  v2Seq: Int,
  runId: String,
  segmentTurnId: String
) throws {
  try validateFrameLegacyRunID(id, .id)
  try validateFrameUUID(conversationId, .conversationId)
  try MobileV2ContractValidation.validateNonnegative(v2Seq, field: "v2Seq")
  try validateFrameLegacyRunID(runId, .runId)
  try validateFrameLegacyRunID(segmentTurnId, .segmentTurnId)
  try container.encode(id, forKey: .id)
  try container.encode(conversationId, forKey: .conversationId)
  try container.encode(v2Seq, forKey: .v2Seq)
  try container.encode(runId, forKey: .runId)
  try container.encode(segmentTurnId, forKey: .segmentTurnId)
}

private func decodeInputFrameBase(
  _ container: MobileV2FrameDecodingContainer
) throws -> (
  id: String,
  conversationId: String,
  v2Seq: Int,
  queueRevision: Int,
  input: MobileV2PendingInput
) {
  let id = try container.decode(String.self, forKey: .id)
  let conversationId = try container.decode(String.self, forKey: .conversationId)
  let v2Seq = try container.decode(Int.self, forKey: .v2Seq)
  let queueRevision = try container.decode(Int.self, forKey: .queueRevision)
  let input = try container.decode(MobileV2PendingInput.self, forKey: .input)
  try validateFrameUUID(id, .id)
  try validateFrameUUID(conversationId, .conversationId)
  try MobileV2ContractValidation.validateNonnegative(v2Seq, field: "v2Seq")
  try MobileV2ContractValidation.validateNonnegative(queueRevision, field: "queueRevision")
  return (id, conversationId, v2Seq, queueRevision, input)
}

private func encodeInputFrameBase(
  _ container: inout MobileV2FrameEncodingContainer,
  id: String,
  conversationId: String,
  v2Seq: Int,
  queueRevision: Int,
  input: MobileV2PendingInput
) throws {
  try validateFrameUUID(id, .id)
  try validateFrameUUID(conversationId, .conversationId)
  try MobileV2ContractValidation.validateNonnegative(v2Seq, field: "v2Seq")
  try MobileV2ContractValidation.validateNonnegative(queueRevision, field: "queueRevision")
  try container.encode(id, forKey: .id)
  try container.encode(conversationId, forKey: .conversationId)
  try container.encode(v2Seq, forKey: .v2Seq)
  try container.encode(queueRevision, forKey: .queueRevision)
  try container.encode(input, forKey: .input)
}

enum MobileV2SequencedFrame: Codable, Hashable, Sendable {
  case accepted(
    id: String,
    conversationId: String,
    v2Seq: Int,
    runId: String,
    segmentTurnId: String,
    userMessageId: String,
    assistantMessageId: String,
    revision: Int,
    origin: MessageOrigin? = nil,
    kind: ConversationKind? = nil,
    requestId: String? = nil
  )
  case event(
    id: String,
    conversationId: String,
    v2Seq: Int,
    runId: String,
    segmentTurnId: String,
    event: AgentEvent
  )
  case done(
    id: String,
    conversationId: String,
    v2Seq: Int,
    runId: String,
    segmentTurnId: String,
    outcome: MobileV2TurnOutcome
  )
  case error(
    id: String,
    conversationId: String,
    v2Seq: Int,
    runId: String,
    segmentTurnId: String,
    error: String,
    code: String?,
    retryable: Bool?
  )
  case inputAccepted(
    id: String,
    conversationId: String,
    v2Seq: Int,
    queueRevision: Int,
    input: MobileV2PendingInput
  )
  case inputUpdated(
    id: String,
    conversationId: String,
    v2Seq: Int,
    queueRevision: Int,
    input: MobileV2PendingInput
  )
  case inputRemoved(
    id: String,
    conversationId: String,
    v2Seq: Int,
    queueRevision: Int,
    input: MobileV2PendingInput
  )
  case inputFailed(
    id: String,
    conversationId: String,
    v2Seq: Int,
    queueRevision: Int,
    input: MobileV2PendingInput
  )
  case inputDelivered(
    id: String,
    conversationId: String,
    v2Seq: Int,
    queueRevision: Int,
    input: MobileV2PendingInput,
    runId: String,
    segmentTurnId: String,
    userMessageId: String,
    assistantMessageId: String
  )
  case queuePaused(
    id: String?,
    conversationId: String,
    v2Seq: Int,
    queueRevision: Int,
    queuePaused: Bool,
    pendingFollowUpCount: Int
  )
  case queueResumed(
    id: String?,
    conversationId: String,
    v2Seq: Int,
    queueRevision: Int,
    queuePaused: Bool,
    pendingFollowUpCount: Int
  )

  init(from decoder: Decoder) throws {
    let type = try decodeFrameType(decoder)
    let container = try decoder.container(keyedBy: MobileV2FrameCodingKeys.self)
    switch type {
    case "accepted":
      try validateFrameKeys(
        decoder,
        allowed: [
          .type, .id, .conversationId, .v2Seq, .runId, .segmentTurnId, .userMessageId,
          .assistantMessageId, .revision, .origin, .kind, .requestId,
        ],
        required: [
          .type, .id, .conversationId, .v2Seq, .runId, .segmentTurnId, .userMessageId,
          .assistantMessageId, .revision,
        ]
      )
      try MobileV2ContractValidation.validateOptionalNonNull(container, key: .origin)
      try MobileV2ContractValidation.validateOptionalNonNull(container, key: .kind)
      try MobileV2ContractValidation.validateOptionalNonNull(container, key: .requestId)
      let base = try decodeRunFrameBase(container)
      let userMessageId = try container.decode(String.self, forKey: .userMessageId)
      let assistantMessageId = try container.decode(String.self, forKey: .assistantMessageId)
      let revision = try container.decode(Int.self, forKey: .revision)
      let origin = try container.decodeIfPresent(MessageOrigin.self, forKey: .origin)
      let kind = try container.decodeIfPresent(ConversationKind.self, forKey: .kind)
      let requestId = try container.decodeIfPresent(String.self, forKey: .requestId)
      try validateFrameUUID(userMessageId, .userMessageId)
      try validateFrameUUID(assistantMessageId, .assistantMessageId)
      try MobileV2ContractValidation.validateNonnegative(revision, field: "revision")
      if let requestId {
        try MobileV2ContractValidation.require(
          (1...256).contains(requestId.unicodeScalars.count),
          field: "requestId"
        )
      }
      self = .accepted(
        id: base.id,
        conversationId: base.conversationId,
        v2Seq: base.v2Seq,
        runId: base.runId,
        segmentTurnId: base.segmentTurnId,
        userMessageId: userMessageId,
        assistantMessageId: assistantMessageId,
        revision: revision,
        origin: origin,
        kind: kind,
        requestId: requestId
      )
    case "event":
      try validateFrameKeys(
        decoder,
        allowed: [.type, .id, .conversationId, .v2Seq, .runId, .segmentTurnId, .event],
        required: [.type, .id, .conversationId, .v2Seq, .runId, .segmentTurnId, .event]
      )
      let base = try decodeRunFrameBase(container)
      self = .event(
        id: base.id,
        conversationId: base.conversationId,
        v2Seq: base.v2Seq,
        runId: base.runId,
        segmentTurnId: base.segmentTurnId,
        event: try container.decode(MobileV2StrictAgentEvent.self, forKey: .event).value
      )
    case "done":
      try validateFrameKeys(
        decoder,
        allowed: [.type, .id, .conversationId, .v2Seq, .runId, .segmentTurnId, .outcome],
        required: [.type, .id, .conversationId, .v2Seq, .runId, .segmentTurnId, .outcome]
      )
      let base = try decodeRunFrameBase(container)
      self = .done(
        id: base.id,
        conversationId: base.conversationId,
        v2Seq: base.v2Seq,
        runId: base.runId,
        segmentTurnId: base.segmentTurnId,
        outcome: try container.decode(MobileV2TurnOutcome.self, forKey: .outcome)
      )
    case "error":
      try validateFrameKeys(
        decoder,
        allowed: [
          .type, .id, .conversationId, .v2Seq, .runId, .segmentTurnId, .error, .code,
          .retryable,
        ],
        required: [.type, .id, .conversationId, .v2Seq, .runId, .segmentTurnId, .error]
      )
      try MobileV2ContractValidation.validateOptionalNonNull(container, key: .code)
      try MobileV2ContractValidation.validateOptionalNonNull(container, key: .retryable)
      let base = try decodeRunFrameBase(container)
      let error = try container.decode(String.self, forKey: .error)
      let code = try container.decodeIfPresent(String.self, forKey: .code)
      let retryable = try container.decodeIfPresent(Bool.self, forKey: .retryable)
      try MobileV2ContractValidation.validateNonempty(error, field: "error")
      if let code {
        try MobileV2ContractValidation.require(
          MobileV2ContractValidation.apiErrorCodes.contains(code),
          field: "code"
        )
      }
      self = .error(
        id: base.id,
        conversationId: base.conversationId,
        v2Seq: base.v2Seq,
        runId: base.runId,
        segmentTurnId: base.segmentTurnId,
        error: error,
        code: code,
        retryable: retryable
      )
    case "input_accepted", "input_updated", "input_removed", "input_failed":
      try validateFrameKeys(
        decoder,
        allowed: [.type, .id, .conversationId, .v2Seq, .queueRevision, .input],
        required: [.type, .id, .conversationId, .v2Seq, .queueRevision, .input]
      )
      let base = try decodeInputFrameBase(container)
      switch type {
      case "input_accepted":
        self = .inputAccepted(
          id: base.id,
          conversationId: base.conversationId,
          v2Seq: base.v2Seq,
          queueRevision: base.queueRevision,
          input: base.input
        )
      case "input_updated":
        self = .inputUpdated(
          id: base.id,
          conversationId: base.conversationId,
          v2Seq: base.v2Seq,
          queueRevision: base.queueRevision,
          input: base.input
        )
      case "input_removed":
        self = .inputRemoved(
          id: base.id,
          conversationId: base.conversationId,
          v2Seq: base.v2Seq,
          queueRevision: base.queueRevision,
          input: base.input
        )
      default:
        self = .inputFailed(
          id: base.id,
          conversationId: base.conversationId,
          v2Seq: base.v2Seq,
          queueRevision: base.queueRevision,
          input: base.input
        )
      }
    case "input_delivered":
      try validateFrameKeys(
        decoder,
        allowed: [
          .type, .id, .conversationId, .v2Seq, .queueRevision, .input, .runId,
          .segmentTurnId, .userMessageId, .assistantMessageId,
        ],
        required: [
          .type, .id, .conversationId, .v2Seq, .queueRevision, .input, .runId,
          .segmentTurnId, .userMessageId, .assistantMessageId,
        ]
      )
      let base = try decodeInputFrameBase(container)
      let runId = try container.decode(String.self, forKey: .runId)
      let segmentTurnId = try container.decode(String.self, forKey: .segmentTurnId)
      let userMessageId = try container.decode(String.self, forKey: .userMessageId)
      let assistantMessageId = try container.decode(String.self, forKey: .assistantMessageId)
      try validateFrameLegacyRunID(runId, .runId)
      try validateFrameUUID(segmentTurnId, .segmentTurnId)
      try validateFrameUUID(userMessageId, .userMessageId)
      try validateFrameUUID(assistantMessageId, .assistantMessageId)
      self = .inputDelivered(
        id: base.id,
        conversationId: base.conversationId,
        v2Seq: base.v2Seq,
        queueRevision: base.queueRevision,
        input: base.input,
        runId: runId,
        segmentTurnId: segmentTurnId,
        userMessageId: userMessageId,
        assistantMessageId: assistantMessageId
      )
    case "queue_paused", "queue_resumed":
      try validateFrameKeys(
        decoder,
        allowed: [
          .type, .id, .conversationId, .v2Seq, .queueRevision, .queuePaused,
          .pendingFollowUpCount,
        ],
        required: [
          .type, .conversationId, .v2Seq, .queueRevision, .queuePaused,
          .pendingFollowUpCount,
        ]
      )
      try MobileV2ContractValidation.validateOptionalNonNull(container, key: .id)
      let id = try container.decodeIfPresent(String.self, forKey: .id)
      let conversationId = try container.decode(String.self, forKey: .conversationId)
      let v2Seq = try container.decode(Int.self, forKey: .v2Seq)
      let queueRevision = try container.decode(Int.self, forKey: .queueRevision)
      let queuePaused = try container.decode(Bool.self, forKey: .queuePaused)
      let pendingFollowUpCount = try container.decode(Int.self, forKey: .pendingFollowUpCount)
      if let id { try validateFrameUUID(id, .id) }
      try validateFrameUUID(conversationId, .conversationId)
      try MobileV2ContractValidation.validateNonnegative(v2Seq, field: "v2Seq")
      try MobileV2ContractValidation.validateNonnegative(queueRevision, field: "queueRevision")
      try MobileV2ContractValidation.validateNonnegative(
        pendingFollowUpCount,
        field: "pendingFollowUpCount"
      )
      if type == "queue_paused" {
        self = .queuePaused(
          id: id,
          conversationId: conversationId,
          v2Seq: v2Seq,
          queueRevision: queueRevision,
          queuePaused: queuePaused,
          pendingFollowUpCount: pendingFollowUpCount
        )
      } else {
        self = .queueResumed(
          id: id,
          conversationId: conversationId,
          v2Seq: v2Seq,
          queueRevision: queueRevision,
          queuePaused: queuePaused,
          pendingFollowUpCount: pendingFollowUpCount
        )
      }
    default:
      throw MobileV2ContractValidationError.invalidField("type")
    }
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: MobileV2FrameCodingKeys.self)
    switch self {
    case let .accepted(
      id,
      conversationId,
      v2Seq,
      runId,
      segmentTurnId,
      userMessageId,
      assistantMessageId,
      revision,
      origin,
      kind,
      requestId
    ):
      try encodeRunFrameBase(
        &container,
        id: id,
        conversationId: conversationId,
        v2Seq: v2Seq,
        runId: runId,
        segmentTurnId: segmentTurnId
      )
      try validateFrameUUID(userMessageId, .userMessageId)
      try validateFrameUUID(assistantMessageId, .assistantMessageId)
      try MobileV2ContractValidation.validateNonnegative(revision, field: "revision")
      if let requestId {
        try MobileV2ContractValidation.require(
          (1...256).contains(requestId.unicodeScalars.count),
          field: "requestId"
        )
      }
      try container.encode("accepted", forKey: .type)
      try container.encode(userMessageId, forKey: .userMessageId)
      try container.encode(assistantMessageId, forKey: .assistantMessageId)
      try container.encode(revision, forKey: .revision)
      try container.encodeIfPresent(origin, forKey: .origin)
      try container.encodeIfPresent(kind, forKey: .kind)
      try container.encodeIfPresent(requestId, forKey: .requestId)
    case let .event(id, conversationId, v2Seq, runId, segmentTurnId, event):
      try encodeRunFrameBase(
        &container,
        id: id,
        conversationId: conversationId,
        v2Seq: v2Seq,
        runId: runId,
        segmentTurnId: segmentTurnId
      )
      try container.encode("event", forKey: .type)
      try container.encode(MobileV2StrictAgentEvent(event), forKey: .event)
    case let .done(id, conversationId, v2Seq, runId, segmentTurnId, outcome):
      try encodeRunFrameBase(
        &container,
        id: id,
        conversationId: conversationId,
        v2Seq: v2Seq,
        runId: runId,
        segmentTurnId: segmentTurnId
      )
      try container.encode("done", forKey: .type)
      try container.encode(outcome, forKey: .outcome)
    case let .error(
      id,
      conversationId,
      v2Seq,
      runId,
      segmentTurnId,
      error,
      code,
      retryable
    ):
      try encodeRunFrameBase(
        &container,
        id: id,
        conversationId: conversationId,
        v2Seq: v2Seq,
        runId: runId,
        segmentTurnId: segmentTurnId
      )
      try MobileV2ContractValidation.validateNonempty(error, field: "error")
      if let code {
        try MobileV2ContractValidation.require(
          MobileV2ContractValidation.apiErrorCodes.contains(code),
          field: "code"
        )
      }
      try container.encode("error", forKey: .type)
      try container.encode(error, forKey: .error)
      try container.encodeIfPresent(code, forKey: .code)
      try container.encodeIfPresent(retryable, forKey: .retryable)
    case let .inputAccepted(id, conversationId, v2Seq, queueRevision, input):
      try encodeInputFrame(
        &container,
        type: "input_accepted",
        id: id,
        conversationId: conversationId,
        v2Seq: v2Seq,
        queueRevision: queueRevision,
        input: input
      )
    case let .inputUpdated(id, conversationId, v2Seq, queueRevision, input):
      try encodeInputFrame(
        &container,
        type: "input_updated",
        id: id,
        conversationId: conversationId,
        v2Seq: v2Seq,
        queueRevision: queueRevision,
        input: input
      )
    case let .inputRemoved(id, conversationId, v2Seq, queueRevision, input):
      try encodeInputFrame(
        &container,
        type: "input_removed",
        id: id,
        conversationId: conversationId,
        v2Seq: v2Seq,
        queueRevision: queueRevision,
        input: input
      )
    case let .inputFailed(id, conversationId, v2Seq, queueRevision, input):
      try encodeInputFrame(
        &container,
        type: "input_failed",
        id: id,
        conversationId: conversationId,
        v2Seq: v2Seq,
        queueRevision: queueRevision,
        input: input
      )
    case let .inputDelivered(
      id,
      conversationId,
      v2Seq,
      queueRevision,
      input,
      runId,
      segmentTurnId,
      userMessageId,
      assistantMessageId
    ):
      try encodeInputFrameBase(
        &container,
        id: id,
        conversationId: conversationId,
        v2Seq: v2Seq,
        queueRevision: queueRevision,
        input: input
      )
      try validateFrameLegacyRunID(runId, .runId)
      try validateFrameUUID(segmentTurnId, .segmentTurnId)
      try validateFrameUUID(userMessageId, .userMessageId)
      try validateFrameUUID(assistantMessageId, .assistantMessageId)
      try container.encode("input_delivered", forKey: .type)
      try container.encode(runId, forKey: .runId)
      try container.encode(segmentTurnId, forKey: .segmentTurnId)
      try container.encode(userMessageId, forKey: .userMessageId)
      try container.encode(assistantMessageId, forKey: .assistantMessageId)
    case let .queuePaused(
      id,
      conversationId,
      v2Seq,
      queueRevision,
      queuePaused,
      pendingFollowUpCount
    ):
      try encodeQueueFrame(
        &container,
        type: "queue_paused",
        id: id,
        conversationId: conversationId,
        v2Seq: v2Seq,
        queueRevision: queueRevision,
        queuePaused: queuePaused,
        pendingFollowUpCount: pendingFollowUpCount
      )
    case let .queueResumed(
      id,
      conversationId,
      v2Seq,
      queueRevision,
      queuePaused,
      pendingFollowUpCount
    ):
      try encodeQueueFrame(
        &container,
        type: "queue_resumed",
        id: id,
        conversationId: conversationId,
        v2Seq: v2Seq,
        queueRevision: queueRevision,
        queuePaused: queuePaused,
        pendingFollowUpCount: pendingFollowUpCount
      )
    }
  }

  private func encodeInputFrame(
    _ container: inout MobileV2FrameEncodingContainer,
    type: String,
    id: String,
    conversationId: String,
    v2Seq: Int,
    queueRevision: Int,
    input: MobileV2PendingInput
  ) throws {
    try encodeInputFrameBase(
      &container,
      id: id,
      conversationId: conversationId,
      v2Seq: v2Seq,
      queueRevision: queueRevision,
      input: input
    )
    try container.encode(type, forKey: .type)
  }

  private func encodeQueueFrame(
    _ container: inout MobileV2FrameEncodingContainer,
    type: String,
    id: String?,
    conversationId: String,
    v2Seq: Int,
    queueRevision: Int,
    queuePaused: Bool,
    pendingFollowUpCount: Int
  ) throws {
    if let id { try validateFrameUUID(id, .id) }
    try validateFrameUUID(conversationId, .conversationId)
    try MobileV2ContractValidation.validateNonnegative(v2Seq, field: "v2Seq")
    try MobileV2ContractValidation.validateNonnegative(queueRevision, field: "queueRevision")
    try MobileV2ContractValidation.validateNonnegative(
      pendingFollowUpCount,
      field: "pendingFollowUpCount"
    )
    try container.encode(type, forKey: .type)
    try container.encodeIfPresent(id, forKey: .id)
    try container.encode(conversationId, forKey: .conversationId)
    try container.encode(v2Seq, forKey: .v2Seq)
    try container.encode(queueRevision, forKey: .queueRevision)
    try container.encode(queuePaused, forKey: .queuePaused)
    try container.encode(pendingFollowUpCount, forKey: .pendingFollowUpCount)
  }
}

enum MobileV2WsServerFrame: Codable, Hashable, Sendable {
  case control(MobileV2ControlFrame)
  case sequenced(MobileV2SequencedFrame)

  init(from decoder: Decoder) throws {
    switch try decodeFrameType(decoder) {
    case "hello_ack", "conversation_subscribed", "command_rejected":
      self = .control(try MobileV2ControlFrame(from: decoder))
    case "accepted", "event", "done", "error", "input_accepted", "input_updated",
      "input_removed", "input_failed", "input_delivered", "queue_paused", "queue_resumed":
      self = .sequenced(try MobileV2SequencedFrame(from: decoder))
    default:
      throw MobileV2ContractValidationError.invalidField("type")
    }
  }

  func encode(to encoder: Encoder) throws {
    switch self {
    case let .control(frame):
      try frame.encode(to: encoder)
    case let .sequenced(frame):
      try frame.encode(to: encoder)
    }
  }

  var conversationId: String? {
    switch self {
    case .control(.helloAck):
      nil
    case let .control(.conversationSubscribed(_, conversationId, _)):
      conversationId
    case let .control(.commandRejected(_, conversationId, _, _, _, _)):
      conversationId
    case let .sequenced(frame):
      frame.conversationId
    }
  }

  var v2Seq: Int? {
    guard case let .sequenced(frame) = self else { return nil }
    return frame.v2Seq
  }

  var isTerminalRunFrame: Bool {
    guard case let .sequenced(frame) = self else { return false }
    return switch frame {
    case .done, .error:
      true
    default:
      false
    }
  }
}

extension MobileV2SequencedFrame {
  var conversationId: String {
    switch self {
    case let .accepted(_, value, _, _, _, _, _, _, _, _, _),
      let .event(_, value, _, _, _, _),
      let .done(_, value, _, _, _, _),
      let .error(_, value, _, _, _, _, _, _),
      let .inputAccepted(_, value, _, _, _),
      let .inputUpdated(_, value, _, _, _),
      let .inputRemoved(_, value, _, _, _),
      let .inputFailed(_, value, _, _, _),
      let .inputDelivered(_, value, _, _, _, _, _, _, _),
      let .queuePaused(_, value, _, _, _, _),
      let .queueResumed(_, value, _, _, _, _):
      value
    }
  }

  var v2Seq: Int {
    switch self {
    case let .accepted(_, _, value, _, _, _, _, _, _, _, _),
      let .event(_, _, value, _, _, _),
      let .done(_, _, value, _, _, _),
      let .error(_, _, value, _, _, _, _, _),
      let .inputAccepted(_, _, value, _, _),
      let .inputUpdated(_, _, value, _, _),
      let .inputRemoved(_, _, value, _, _),
      let .inputFailed(_, _, value, _, _),
      let .inputDelivered(_, _, value, _, _, _, _, _, _),
      let .queuePaused(_, _, value, _, _, _),
      let .queueResumed(_, _, value, _, _, _):
      value
    }
  }
}
