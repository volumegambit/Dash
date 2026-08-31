import Foundation

struct ConnectionProfileSnapshot: Identifiable, Hashable, Sendable {
  let gatewayID: String
  let profile: ConnectionProfile

  var id: UUID { profile.id }
}

struct CachedConversation: Identifiable, Hashable, Sendable {
  let gatewayID: String
  let summary: ConversationSummaryDTO

  var id: String { summary.id }
}

struct PreparedAttachment: Codable, Equatable, Identifiable, Sendable {
  let id: UUID
  let mediaType: String
  let data: Data
}

typealias DraftAttachment = PreparedAttachment

struct ConversationDraft: Equatable, Sendable {
  let text: String
  let attachments: [DraftAttachment]
  let updatedAt: Date
}

struct PendingChatSend: Equatable, Sendable {
  let turnID: String
  let localUserID: String
  let draft: String
  let attachments: [PreparedAttachment]
  let createdAt: Date
}

enum PendingSendLoadResult: Equatable, Sendable {
  case none
  case resumable(PendingChatSend)
  case recoveryRequired(RecoverablePendingSend)
}

enum PendingSendStageResult: Equatable, Sendable {
  case staged
  case pendingAlreadyExists
}

enum PendingSendClearResult: Equatable, Sendable {
  case cleared
  case conversationUnavailable
}

enum PendingSendAvailability: Equatable, Sendable {
  case active
  case conversationUnavailable
  case pendingMissing
}

enum PendingSendRestoreResult: Equatable, Sendable {
  case restored(ConversationDraft?)
  case draftConflict(ConversationDraft)
  case conversationUnavailable
}

enum RecoverableAttachmentIssue: Equatable, Sendable {
  case unreadableStoredPayload
}

struct RecoverablePendingSend: Equatable, Identifiable, Sendable {
  let gatewayID: String
  let conversationID: String
  let conversationTitle: String?
  let agentName: String?
  let pendingSend: PendingChatSend
  let attachmentIssue: RecoverableAttachmentIssue?
  let coexistingDraft: ConversationDraft?
  let coexistingDraftAttachmentIssue: RecoverableAttachmentIssue?
  let conversationAvailable: Bool

  init(
    gatewayID: String,
    conversationID: String,
    conversationTitle: String?,
    agentName: String?,
    pendingSend: PendingChatSend,
    attachmentIssue: RecoverableAttachmentIssue? = nil,
    coexistingDraft: ConversationDraft? = nil,
    coexistingDraftAttachmentIssue: RecoverableAttachmentIssue? = nil,
    conversationAvailable: Bool = false
  ) {
    self.gatewayID = gatewayID
    self.conversationID = conversationID
    self.conversationTitle = conversationTitle
    self.agentName = agentName
    self.pendingSend = pendingSend
    self.attachmentIssue = attachmentIssue
    self.coexistingDraft = coexistingDraft
    self.coexistingDraftAttachmentIssue = coexistingDraftAttachmentIssue
    self.conversationAvailable = conversationAvailable
  }

  var id: String { "\(gatewayID)\u{1f}\(conversationID)" }
}
