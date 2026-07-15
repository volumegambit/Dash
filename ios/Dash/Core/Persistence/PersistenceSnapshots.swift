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

struct RecoverablePendingSend: Equatable, Identifiable, Sendable {
  let gatewayID: String
  let conversationID: String
  let conversationTitle: String?
  let agentName: String?
  let pendingSend: PendingChatSend

  var id: String { "\(gatewayID)\u{1f}\(conversationID)" }
}
