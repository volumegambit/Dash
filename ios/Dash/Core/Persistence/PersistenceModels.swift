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
    deletedAt: Date?
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
    updatedAt: Date
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

  init(
    scopedConversationID: String,
    gatewayID: String,
    conversationID: String,
    text: String,
    attachmentsData: Data,
    updatedAt: Date
  ) {
    self.scopedConversationID = scopedConversationID
    self.gatewayID = gatewayID
    self.conversationID = conversationID
    self.text = text
    self.attachmentsData = attachmentsData
    self.updatedAt = updatedAt
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
