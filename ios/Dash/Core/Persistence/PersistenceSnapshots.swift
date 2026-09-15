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

/// Text being composed in one restored scene. Conversation state is shared
/// across devices, while an unfinished editor belongs to the window where it
/// was typed. The revision lets persistence reject delayed writes and clear
/// only the exact draft that was submitted.
struct PendingWindowCommand: Codable, Equatable, Sendable {
  let id: String
  let command: ConversationCommand
  let expectedActiveTurnID: String?
  let text: String
  let attachments: [PreparedAttachment]
  let sourceWindowID: String
  let submittedRevision: UInt64
  let createdAt: Date
}

struct WindowConversationDraft: Equatable, Sendable {
  let text: String
  let attachments: [PreparedAttachment]
  let revision: UInt64
  let pendingCommand: PendingWindowCommand?
  let updatedAt: Date

  init(
    text: String,
    attachments: [PreparedAttachment] = [],
    revision: UInt64,
    pendingCommand: PendingWindowCommand? = nil,
    updatedAt: Date
  ) {
    self.text = text
    self.attachments = attachments
    self.revision = revision
    self.pendingCommand = pendingCommand
    self.updatedAt = updatedAt
  }
}

struct PendingChatSend: Equatable, Sendable {
  let turnID: String
  let localUserID: String
  let draft: String
  let attachments: [PreparedAttachment]
  let createdAt: Date
  let sourceWindowID: String?
  let submittedRevision: UInt64?

  init(
    turnID: String,
    localUserID: String,
    draft: String,
    attachments: [PreparedAttachment],
    createdAt: Date,
    sourceWindowID: String? = nil,
    submittedRevision: UInt64? = nil
  ) {
    self.turnID = turnID
    self.localUserID = localUserID
    self.draft = draft
    self.attachments = attachments
    self.createdAt = createdAt
    self.sourceWindowID = sourceWindowID
    self.submittedRevision = submittedRevision
  }
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
