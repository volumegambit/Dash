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
  let revision: UInt64

  init(
    text: String,
    attachments: [DraftAttachment],
    updatedAt: Date,
    revision: UInt64 = 0
  ) {
    self.text = text
    self.attachments = attachments
    self.updatedAt = updatedAt
    self.revision = revision
  }
}

struct MobileV2MessageDelivery: Codable, Equatable, Sendable {
  let runId: String
  let segmentIndex: Int
  let kind: MobileV2DeliveryKind
  let status: MobileV2DeliveryStatus?
}

struct CachedV2ConversationBootstrap: Equatable, Sendable {
  let conversation: ConversationSummaryDTO
  let messages: [ConversationMessageDTO]
  let deliveryByMessageID: [String: MobileV2MessageDelivery]
  let pendingInputs: [MobileV2PendingInput]
  let nextCursor: String?
  let queuePaused: Bool
  let queueRevision: Int
  let pendingFollowUpCount: Int
  let v2ThroughSeq: Int
}

struct CachedV2ConversationProjection: Equatable, Sendable {
  var anchor: CachedV2ConversationBootstrap
  var appliedFrames: [MobileV2SequencedFrame]
  var committedV2Seq: Int
}

struct V2ProjectionVersion: Equatable, Sendable {
  let committedV2Seq: Int
  let mutationRevision: Int
}

struct VersionedV2ConversationProjection: Equatable, Sendable {
  let projection: CachedV2ConversationProjection
  let version: V2ProjectionVersion
}

enum V2BootstrapApplyDisposition: Equatable, Sendable {
  case installed
  case advanced
  case compacted
  case unchanged
  case stale
}

struct V2BootstrapApplyResult: Equatable, Sendable {
  let disposition: V2BootstrapApplyDisposition
  let current: VersionedV2ConversationProjection
}

enum V2FrameCommitResult: Equatable, Sendable {
  case committed(VersionedV2ConversationProjection)
  case alreadyCovered(VersionedV2ConversationProjection)
  case staleWriter(VersionedV2ConversationProjection)

  var currentProjection: VersionedV2ConversationProjection {
    switch self {
    case .committed(let value), .alreadyCovered(let value), .staleWriter(let value):
      value
    }
  }

  var isCommitted: Bool {
    if case .committed = self { return true }
    return false
  }

  var isAlreadyCovered: Bool {
    if case .alreadyCovered = self { return true }
    return false
  }

  var isStaleWriter: Bool {
    if case .staleWriter = self { return true }
    return false
  }
}

struct V2ProjectionHint: Equatable, Sendable {
  let conversationID: String
  let version: V2ProjectionVersion
}

struct CachedV2ConversationMessagePage: Equatable, Sendable {
  let messages: [ConversationMessageDTO]
  let deliveryByMessageID: [String: MobileV2MessageDelivery]
  let nextCursor: String?
  let throughSeq: Int
}

struct PendingV2Admission: Codable, Equatable, Sendable {
  let commandID: String
  let inputID: String
  let behavior: MobileV2InputBehavior
  let expectedActiveTurnID: String?
  let text: String
  let images: [MessageImage]
  let draftRevision: UInt64
}

struct RecoverableV2Admission: Equatable, Identifiable, Sendable {
  let gatewayID: String
  let conversationID: String
  let conversationTitle: String?
  let agentName: String?
  let commandID: String
  let inputID: String
  let createdAt: Date
  let admission: PendingV2Admission?
  let payloadIssue: RecoverableAttachmentIssue?
  let coexistingDraft: ConversationDraft?
  let coexistingDraftAttachmentIssue: RecoverableAttachmentIssue?
  let conversationAvailable: Bool

  var id: String {
    "\(gatewayID)\u{1f}\(conversationID)\u{1f}\(commandID)\u{1f}\(inputID)"
  }
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
