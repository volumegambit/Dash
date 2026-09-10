import Foundation
import SwiftData

@Model
final class GatewayProfileRecord {
  @Attribute(.unique) var gatewayID: String
  var profileID: UUID
  var label: String
  var host: String
  var managementPort: Int
  var chatPort: Int
  var secure: Bool
  var tlsCertificateSha256: String?
  var modeRaw: String
  var publicKey: String
  var createdAt: Date
  var lastSuccessfulSyncAt: Date?

  init(
    gatewayID: String,
    profileID: UUID,
    label: String,
    host: String,
    managementPort: Int,
    chatPort: Int,
    secure: Bool,
    tlsCertificateSha256: String? = nil,
    modeRaw: String,
    publicKey: String,
    createdAt: Date,
    lastSuccessfulSyncAt: Date?
  ) {
    self.gatewayID = gatewayID
    self.profileID = profileID
    self.label = label
    self.host = host
    self.managementPort = managementPort
    self.chatPort = chatPort
    self.secure = secure
    self.tlsCertificateSha256 = tlsCertificateSha256
    self.modeRaw = modeRaw
    self.publicKey = publicKey
    self.createdAt = createdAt
    self.lastSuccessfulSyncAt = lastSuccessfulSyncAt
  }
}

@Model
final class ConversationRecord {
  @Attribute(.unique) var scopedID: String
  var gatewayID: String
  var conversationID: String
  var agentID: String
  var agentName: String
  var title: String
  var revision: Int
  var statusRaw: String
  var activeTurnID: String?
  var owningIssueID: String?
  var projectID: String?
  var lastSeq: Int
  var lastMessagePreview: String?
  var createdAt: Date
  var updatedAt: Date
  var deletedAt: Date?
  var queuePaused: Bool = false
  var queueRevision: Int = 0
  var pendingFollowUpCount: Int = 0
  var v2LastSeq: Int = 0
  var v2NextMessageCursor: String?

  init(
    scopedID: String,
    gatewayID: String,
    conversationID: String,
    agentID: String,
    agentName: String,
    title: String,
    revision: Int,
    statusRaw: String,
    activeTurnID: String?,
    owningIssueID: String?,
    projectID: String?,
    lastSeq: Int,
    lastMessagePreview: String?,
    createdAt: Date,
    updatedAt: Date,
    deletedAt: Date?,
    queuePaused: Bool = false,
    queueRevision: Int = 0,
    pendingFollowUpCount: Int = 0,
    v2LastSeq: Int = 0,
    v2NextMessageCursor: String? = nil
  ) {
    self.scopedID = scopedID
    self.gatewayID = gatewayID
    self.conversationID = conversationID
    self.agentID = agentID
    self.agentName = agentName
    self.title = title
    self.revision = revision
    self.statusRaw = statusRaw
    self.activeTurnID = activeTurnID
    self.owningIssueID = owningIssueID
    self.projectID = projectID
    self.lastSeq = lastSeq
    self.lastMessagePreview = lastMessagePreview
    self.createdAt = createdAt
    self.updatedAt = updatedAt
    self.deletedAt = deletedAt
    self.queuePaused = queuePaused
    self.queueRevision = queueRevision
    self.pendingFollowUpCount = pendingFollowUpCount
    self.v2LastSeq = v2LastSeq
    self.v2NextMessageCursor = v2NextMessageCursor
  }
}

@Model
final class ConversationRemovalFenceRecord {
  @Attribute(.unique) var scopedConversationID: String
  var gatewayID: String
  var conversationID: String
  var revisionFloor: Int

  init(
    scopedConversationID: String,
    gatewayID: String,
    conversationID: String,
    revisionFloor: Int
  ) {
    self.scopedConversationID = scopedConversationID
    self.gatewayID = gatewayID
    self.conversationID = conversationID
    self.revisionFloor = revisionFloor
  }
}

@Model
final class MessageRecord {
  @Attribute(.unique) var scopedID: String
  var gatewayID: String
  var conversationID: String
  var messageID: String
  var turnID: String
  var ordinal: Int
  var roleRaw: String
  var statusRaw: String
  var contentData: Data
  var createdAt: Date
  var updatedAt: Date
  var runID: String?
  var segmentIndex: Int?
  var deliveryKindRaw: String?
  var deliveryStatusRaw: String?
  var isV2Anchor: Bool = false

  init(
    scopedID: String,
    gatewayID: String,
    conversationID: String,
    messageID: String,
    turnID: String,
    ordinal: Int,
    roleRaw: String,
    statusRaw: String,
    contentData: Data,
    createdAt: Date,
    updatedAt: Date,
    runID: String? = nil,
    segmentIndex: Int? = nil,
    deliveryKindRaw: String? = nil,
    deliveryStatusRaw: String? = nil,
    isV2Anchor: Bool = false
  ) {
    self.scopedID = scopedID
    self.gatewayID = gatewayID
    self.conversationID = conversationID
    self.messageID = messageID
    self.turnID = turnID
    self.ordinal = ordinal
    self.roleRaw = roleRaw
    self.statusRaw = statusRaw
    self.contentData = contentData
    self.createdAt = createdAt
    self.updatedAt = updatedAt
    self.runID = runID
    self.segmentIndex = segmentIndex
    self.deliveryKindRaw = deliveryKindRaw
    self.deliveryStatusRaw = deliveryStatusRaw
    self.isV2Anchor = isV2Anchor
  }
}

@Model
final class AgentRecord {
  @Attribute(.unique) var scopedID: String
  var gatewayID: String
  var agentID: String
  var agentData: Data
  var updatedAt: Date

  init(
    scopedID: String,
    gatewayID: String,
    agentID: String,
    agentData: Data,
    updatedAt: Date
  ) {
    self.scopedID = scopedID
    self.gatewayID = gatewayID
    self.agentID = agentID
    self.agentData = agentData
    self.updatedAt = updatedAt
  }
}

@Model
final class DraftRecord {
  @Attribute(.unique) var scopedConversationID: String
  var gatewayID: String
  var conversationID: String
  var text: String
  @Attribute(.externalStorage) var attachmentsData: Data
  var updatedAt: Date
  var revision: UInt64 = 0

  init(
    scopedConversationID: String,
    gatewayID: String,
    conversationID: String,
    text: String,
    attachmentsData: Data,
    updatedAt: Date,
    revision: UInt64 = 0
  ) {
    self.scopedConversationID = scopedConversationID
    self.gatewayID = gatewayID
    self.conversationID = conversationID
    self.text = text
    self.attachmentsData = attachmentsData
    self.updatedAt = updatedAt
    self.revision = revision
  }
}

@Model
final class PendingSendRecord {
  @Attribute(.unique) var scopedConversationID: String
  var gatewayID: String
  var conversationID: String
  var turnID: String
  var localUserID: String
  var draft: String
  @Attribute(.externalStorage) var attachmentsData: Data
  var createdAt: Date

  init(
    scopedConversationID: String,
    gatewayID: String,
    conversationID: String,
    turnID: String,
    localUserID: String,
    draft: String,
    attachmentsData: Data,
    createdAt: Date
  ) {
    self.scopedConversationID = scopedConversationID
    self.gatewayID = gatewayID
    self.conversationID = conversationID
    self.turnID = turnID
    self.localUserID = localUserID
    self.draft = draft
    self.attachmentsData = attachmentsData
    self.createdAt = createdAt
  }
}

@Model
final class ReplayCursorRecord {
  @Attribute(.unique) var scopedConversationID: String
  var gatewayID: String
  var conversationID: String
  var lastSeq: Int

  init(
    scopedConversationID: String,
    gatewayID: String,
    conversationID: String,
    lastSeq: Int
  ) {
    self.scopedConversationID = scopedConversationID
    self.gatewayID = gatewayID
    self.conversationID = conversationID
    self.lastSeq = lastSeq
  }
}

@Model
final class PendingInputRecord {
  @Attribute(.unique) var scopedID: String
  var gatewayID: String
  var conversationID: String
  var inputID: String
  var enqueueOrder: Int
  @Attribute(.externalStorage) var payloadData: Data

  init(
    scopedID: String,
    gatewayID: String,
    conversationID: String,
    inputID: String,
    enqueueOrder: Int,
    payloadData: Data
  ) {
    self.scopedID = scopedID
    self.gatewayID = gatewayID
    self.conversationID = conversationID
    self.inputID = inputID
    self.enqueueOrder = enqueueOrder
    self.payloadData = payloadData
  }
}

@Model
final class V2ReplayCursorRecord {
  @Attribute(.unique) var scopedConversationID: String
  var gatewayID: String
  var conversationID: String
  var lastV2Seq: Int
  var mutationRevision: Int = 0

  init(
    scopedConversationID: String,
    gatewayID: String,
    conversationID: String,
    lastV2Seq: Int,
    mutationRevision: Int = 0
  ) {
    self.scopedConversationID = scopedConversationID
    self.gatewayID = gatewayID
    self.conversationID = conversationID
    self.lastV2Seq = lastV2Seq
    self.mutationRevision = mutationRevision
  }
}

@Model
final class V2BootstrapAnchorRecord {
  @Attribute(.unique) var scopedConversationID: String
  var gatewayID: String
  var conversationID: String
  @Attribute(.externalStorage) var payloadData: Data

  init(
    scopedConversationID: String,
    gatewayID: String,
    conversationID: String,
    payloadData: Data
  ) {
    self.scopedConversationID = scopedConversationID
    self.gatewayID = gatewayID
    self.conversationID = conversationID
    self.payloadData = payloadData
  }
}

@Model
final class V2AppliedFrameRecord {
  @Attribute(.unique) var scopedSequenceID: String
  var gatewayID: String
  var conversationID: String
  var sequence: Int
  @Attribute(.externalStorage) var payloadData: Data

  init(
    scopedSequenceID: String,
    gatewayID: String,
    conversationID: String,
    sequence: Int,
    payloadData: Data
  ) {
    self.scopedSequenceID = scopedSequenceID
    self.gatewayID = gatewayID
    self.conversationID = conversationID
    self.sequence = sequence
    self.payloadData = payloadData
  }
}

@Model
final class PendingV2AdmissionRecord {
  @Attribute(.unique) var scopedConversationID: String
  var gatewayID: String
  var conversationID: String
  var commandID: String
  var inputID: String
  @Attribute(.externalStorage) var payloadData: Data
  var createdAt: Date

  init(
    scopedConversationID: String,
    gatewayID: String,
    conversationID: String,
    commandID: String,
    inputID: String,
    payloadData: Data,
    createdAt: Date
  ) {
    self.scopedConversationID = scopedConversationID
    self.gatewayID = gatewayID
    self.conversationID = conversationID
    self.commandID = commandID
    self.inputID = inputID
    self.payloadData = payloadData
    self.createdAt = createdAt
  }
}

enum PersistenceSchema {
  static func make() -> Schema {
    Schema([
      GatewayProfileRecord.self,
      ConversationRecord.self,
      ConversationRemovalFenceRecord.self,
      MessageRecord.self,
      AgentRecord.self,
      DraftRecord.self,
      PendingSendRecord.self,
      ReplayCursorRecord.self,
      PendingInputRecord.self,
      V2ReplayCursorRecord.self,
      V2BootstrapAnchorRecord.self,
      V2AppliedFrameRecord.self,
      PendingV2AdmissionRecord.self,
    ])
  }
}
