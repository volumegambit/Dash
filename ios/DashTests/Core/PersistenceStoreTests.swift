import Foundation
import SwiftData
import Testing

@testable import Dash

@Suite("Persistence store", .serialized)
struct PersistenceStoreTests {
  @Test("same wire id remains isolated by gateway")
  func gatewayScopedUniqueness() async throws {
    let store = try PersistenceStore.inMemory()
    try await store.upsertConversations([summary(id: "same", title: "A")], gatewayID: "gw-a")
    try await store.upsertConversations([summary(id: "same", title: "B")], gatewayID: "gw-b")

    let gatewayA = try await store.conversations(gatewayID: "gw-a", limit: 50)
    let gatewayB = try await store.conversations(gatewayID: "gw-b", limit: 50)
    #expect(gatewayA.count == 1)
    #expect(gatewayB.count == 1)
    #expect(gatewayA.first?.summary.title == "A")
    #expect(gatewayB.first?.summary.title == "B")
  }

  @Test("higher summary revision overwrites cached data")
  func summaryRevisionOverwrite() async throws {
    let store = try PersistenceStore.inMemory()
    try await store.upsertConversations(
      [summary(id: "conversation", title: "Old", revision: 1)],
      gatewayID: "gw"
    )
    try await store.upsertConversations(
      [summary(id: "conversation", title: "New", revision: 3)],
      gatewayID: "gw"
    )

    let cached = try #require(
      try await store.conversation(gatewayID: "gw", id: "conversation")
    )
    #expect(cached.summary.revision == 3)
    #expect(cached.summary.title == "New")
  }

  @Test("lower summary revision cannot overwrite cached data")
  func lowerSummaryRevisionRejected() async throws {
    let store = try PersistenceStore.inMemory()
    try await store.upsertConversations(
      [summary(id: "conversation", title: "Current", revision: 4)],
      gatewayID: "gw"
    )
    try await store.upsertConversations(
      [summary(id: "conversation", title: "Stale", revision: 2)],
      gatewayID: "gw"
    )

    let cached = try #require(
      try await store.conversation(gatewayID: "gw", id: "conversation")
    )
    #expect(cached.summary.revision == 4)
    #expect(cached.summary.title == "Current")
  }

  @Test("message replay merge is idempotent")
  func messageMerge() async throws {
    let store = try PersistenceStore.inMemory()
    try await store.mergeMessages(
      [message(id: "m-1")],
      gatewayID: "gw",
      conversationID: "c"
    )
    try await store.mergeMessages(
      [message(id: "m-1")],
      gatewayID: "gw",
      conversationID: "c"
    )

    #expect(try await store.messages(gatewayID: "gw", conversationID: "c").count == 1)
  }

  @Test("messages are returned in chronological ordinal order")
  func chronologicalMessages() async throws {
    let store = try PersistenceStore.inMemory()
    try await store.mergeMessages(
      [message(id: "m-3", ordinal: 3), message(id: "m-1", ordinal: 1)],
      gatewayID: "gw",
      conversationID: "c"
    )
    try await store.mergeMessages(
      [message(id: "m-2", ordinal: 2)],
      gatewayID: "gw",
      conversationID: "c"
    )

    let values = try await store.messages(gatewayID: "gw", conversationID: "c")
    #expect(values.map(\.ordinal) == [1, 2, 3])
  }

  @Test("newest and backward message pages merge without regressing an updated row")
  func backwardPageMerge() async throws {
    let store = try PersistenceStore.inMemory()
    try await store.mergeMessages(
      [
        message(id: "m-3", ordinal: 3, text: "current", updatedOffset: 30),
        message(id: "m-4", ordinal: 4, updatedOffset: 40),
      ],
      gatewayID: "gw",
      conversationID: "c"
    )
    try await store.mergeMessages(
      [
        message(id: "m-1", ordinal: 1, updatedOffset: 10),
        message(id: "m-2", ordinal: 2, updatedOffset: 20),
        message(id: "m-3", ordinal: 3, text: "stale", updatedOffset: 10),
      ],
      gatewayID: "gw",
      conversationID: "c"
    )

    let values = try await store.messages(gatewayID: "gw", conversationID: "c")
    #expect(values.map(\.id) == ["m-1", "m-2", "m-3", "m-4"])
    guard case .user(let text, _)? = values.first(where: { $0.id == "m-3" })?.content else {
      Issue.record("Expected cached m-3 user content")
      return
    }
    #expect(text == "current")
  }

  @Test("assistant events round trip through encoded message content")
  func assistantEventRoundTrip() async throws {
    let store = try PersistenceStore.inMemory()
    let expected = ConversationMessageDTO(
      id: "assistant-1",
      conversationId: "c",
      turnId: "turn-1",
      ordinal: 1,
      role: .assistant,
      status: .streaming,
      content: .assistant(events: [
        .error(error: "Temporary failure", timestamp: instant(12)),
        .unknown(
          type: "future_event",
          raw: .object([
            "type": .string("future_event"),
            "value": .number(3),
          ])
        ),
      ]),
      createdAt: instant(10),
      updatedAt: instant(12)
    )

    try await store.mergeMessages([expected], gatewayID: "gw", conversationID: "c")

    #expect(try await store.messages(gatewayID: "gw", conversationID: "c") == [expected])
  }

  @Test("tombstone stays versioned while purging conversation content idempotently")
  func tombstonePurge() async throws {
    let store = try PersistenceStore.inMemory()
    let attachment = DraftAttachment(
      id: UUID(uuidString: "018f0f4a-5c42-7a8b-9c01-1234567890ab")!,
      mediaType: "image/png",
      data: Data("image".utf8)
    )
    let draft = ConversationDraft(
      text: "unsent",
      attachments: [attachment],
      updatedAt: instant(50)
    )
    try await store.upsertConversations(
      [summary(id: "c", title: "Before deletion", revision: 4)],
      gatewayID: "gw"
    )
    try await cacheConversationContent(store, draft: draft)
    let tombstone = summary(
      id: "c",
      title: "Deleted",
      revision: 5,
      status: .deleted,
      deletedAt: instant(60)
    )

    try await store.applyTombstone(tombstone, gatewayID: "gw")

    #expect(try await store.conversations(gatewayID: "gw", limit: 50).isEmpty)
    let retained = try #require(try await store.conversation(gatewayID: "gw", id: "c"))
    #expect(retained.summary.status == .deleted)
    #expect(retained.summary.revision == 5)
    try await expectConversationContentPurged(store)

    try await store.applyTombstone(tombstone, gatewayID: "gw")
    try await expectConversationContentPurged(store)
  }

  @Test("a non-deleted summary cannot be applied as a tombstone")
  func tombstoneRequiresDeletedStatus() async throws {
    let store = try PersistenceStore.inMemory()

    let error = await persistenceError {
      try await store.applyTombstone(
        summary(id: "c", title: "Not deleted", revision: 2),
        gatewayID: "gw"
      )
    }

    #expect(error == .invalidTombstoneStatus)
    #expect(try await store.conversation(gatewayID: "gw", id: "c") == nil)
  }

  @Test("a late message cannot repopulate a tombstoned conversation")
  func tombstoneRejectsLateMessage() async throws {
    let store = try await tombstonedStore()

    let error = await persistenceError {
      try await store.mergeMessages(
        [message(id: "late-message")],
        gatewayID: "gw",
        conversationID: "c"
      )
    }

    #expect(error == .conversationDeleted(gatewayID: "gw", conversationID: "c"))
    #expect(try await store.messages(gatewayID: "gw", conversationID: "c").isEmpty)
  }

  @Test("a late draft attachment cannot repopulate a tombstoned conversation")
  func tombstoneRejectsLateDraft() async throws {
    let store = try await tombstonedStore()
    let draft = ConversationDraft(
      text: "late draft",
      attachments: [
        DraftAttachment(
          id: UUID(uuidString: "018f0f4a-5c42-7a8b-9c01-1234567890ab")!,
          mediaType: "image/png",
          data: Data("late attachment".utf8)
        )
      ],
      updatedAt: instant(80)
    )

    let error = await persistenceError {
      try await store.saveDraft(draft, gatewayID: "gw", conversationID: "c")
    }

    #expect(error == .conversationDeleted(gatewayID: "gw", conversationID: "c"))
    #expect(try await store.draft(gatewayID: "gw", conversationID: "c") == nil)
  }

  @Test("a late replay cursor cannot repopulate a tombstoned conversation")
  func tombstoneRejectsLateCursor() async throws {
    let store = try await tombstonedStore()

    let error = await persistenceError {
      try await store.advanceCursor(gatewayID: "gw", conversationID: "c", to: 99)
    }

    #expect(error == .conversationDeleted(gatewayID: "gw", conversationID: "c"))
    #expect(try await store.cursor(gatewayID: "gw", conversationID: "c") == 0)
  }

  @Test("a conversation tombstone does not block gateway profile or agent writes")
  func tombstoneDoesNotBlockGatewayWrites() async throws {
    let store = try await tombstonedStore()
    try await store.upsertProfile(
      profile(),
      identity: .init(gatewayId: "gw", publicKey: "public-key")
    )
    try await store.markSuccessfulSync(gatewayID: "gw", at: instant(90))
    try await store.replaceAgents([agent(id: "agent-1", name: "Agent")], gatewayID: "gw")

    #expect(try await store.profile(gatewayID: "gw")?.profile.lastSuccessfulSyncAt == instant(90))
    #expect(try await store.agents(gatewayID: "gw").map(\.id) == ["agent-1"])
  }

  @Test("replay cursor advances monotonically")
  func replayCursorMonotonicity() async throws {
    let store = try PersistenceStore.inMemory()
    try await store.advanceCursor(gatewayID: "gw", conversationID: "c", to: 8)
    try await store.advanceCursor(gatewayID: "gw", conversationID: "c", to: 3)
    #expect(try await store.cursor(gatewayID: "gw", conversationID: "c") == 8)

    try await store.advanceCursor(gatewayID: "gw", conversationID: "c", to: 12)
    #expect(try await store.cursor(gatewayID: "gw", conversationID: "c") == 12)
  }

  @Test("draft text and externally stored attachment data round trip")
  func draftRoundTrip() async throws {
    let store = try PersistenceStore.inMemory()
    let draft = ConversationDraft(
      text: "Continue this later",
      attachments: [
        DraftAttachment(
          id: UUID(uuidString: "018f0f4a-5c42-7a8b-9c01-1234567890ab")!,
          mediaType: "image/webp",
          data: Data([0x00, 0x7F, 0xFF])
        )
      ],
      updatedAt: instant(40)
    )

    try await store.saveDraft(draft, gatewayID: "gw", conversationID: "c")

    #expect(try await store.draft(gatewayID: "gw", conversationID: "c") == draft)
    #expect(try await store.draft(gatewayID: "other", conversationID: "c") == nil)
  }

  @Test("agent replacement is gateway scoped and removes stale agents")
  func agentReplacement() async throws {
    let store = try PersistenceStore.inMemory()
    try await store.replaceAgents(
      [agent(id: "a-1", name: "One"), agent(id: "a-2", name: "Two")],
      gatewayID: "gw-a"
    )
    try await store.replaceAgents([agent(id: "b-1", name: "Other")], gatewayID: "gw-b")
    try await store.replaceAgents([agent(id: "a-1", name: "Updated")], gatewayID: "gw-a")

    let gatewayA = try await store.agents(gatewayID: "gw-a")
    #expect(gatewayA.map(\.id) == ["a-1"])
    #expect(gatewayA.first?.name == "Updated")
    #expect(try await store.agents(gatewayID: "gw-b").map(\.id) == ["b-1"])
  }

  @Test("profile identity and successful sync timestamp round trip without secrets")
  func profileSync() async throws {
    let store = try PersistenceStore.inMemory()
    let identity = GatewayIdentityDTO(gatewayId: "gw", publicKey: "public-key")
    try await store.upsertProfile(profile(), identity: identity)
    try await store.markSuccessfulSync(gatewayID: "gw", at: instant(90))

    let cached = try #require(try await store.profile(gatewayID: "gw"))
    #expect(cached.gatewayID == "gw")
    #expect(cached.profile.gatewayId == "gw")
    #expect(cached.profile.publicKey == "public-key")
    #expect(cached.profile.lastSuccessfulSyncAt == instant(90))
  }

  @Test("clearing a gateway removes every cache family without touching another gateway")
  func clearGateway() async throws {
    let store = try PersistenceStore.inMemory()
    for gatewayID in ["gw-a", "gw-b"] {
      try await store.upsertProfile(
        profile(label: gatewayID),
        identity: .init(gatewayId: gatewayID, publicKey: "public-\(gatewayID)")
      )
      try await store.upsertConversations(
        [summary(id: "c", title: gatewayID)],
        gatewayID: gatewayID
      )
      try await store.mergeMessages(
        [message(id: "m")],
        gatewayID: gatewayID,
        conversationID: "c"
      )
      try await store.saveDraft(
        .init(text: gatewayID, attachments: [], updatedAt: instant(20)),
        gatewayID: gatewayID,
        conversationID: "c"
      )
      try await store.replaceAgents([agent(id: "agent", name: gatewayID)], gatewayID: gatewayID)
      try await store.advanceCursor(gatewayID: gatewayID, conversationID: "c", to: 7)
    }

    try await store.clearGateway(gatewayID: "gw-a")

    #expect(try await store.profile(gatewayID: "gw-a") == nil)
    #expect(try await store.conversations(gatewayID: "gw-a", limit: 50).isEmpty)
    #expect(try await store.messages(gatewayID: "gw-a", conversationID: "c").isEmpty)
    #expect(try await store.draft(gatewayID: "gw-a", conversationID: "c") == nil)
    #expect(try await store.agents(gatewayID: "gw-a").isEmpty)
    #expect(try await store.cursor(gatewayID: "gw-a", conversationID: "c") == 0)
    #expect(try await store.profile(gatewayID: "gw-b") != nil)
    #expect(try await store.conversations(gatewayID: "gw-b", limit: 50).count == 1)
    #expect(try await store.messages(gatewayID: "gw-b", conversationID: "c").count == 1)
    #expect(try await store.draft(gatewayID: "gw-b", conversationID: "c") != nil)
    #expect(try await store.agents(gatewayID: "gw-b").count == 1)
    #expect(try await store.cursor(gatewayID: "gw-b", conversationID: "c") == 7)
  }

  @Test("SwiftData schema property names contain no connection secret material")
  func secretFreeSchema() {
    let schema = Schema([
      GatewayProfileRecord.self,
      ConversationRecord.self,
      MessageRecord.self,
      AgentRecord.self,
      DraftRecord.self,
      ReplayCursorRecord.self,
    ])
    let forbidden = schema.entities
      .flatMap(\.properties)
      .map { $0.name.lowercased() }
      .filter { name in
        ["token", "credential", "secret"].contains { name.contains($0) }
      }

    #expect(forbidden.isEmpty)
  }

  private func cacheConversationContent(
    _ store: PersistenceStore,
    draft: ConversationDraft
  ) async throws {
    try await store.mergeMessages(
      [message(id: "m-1")],
      gatewayID: "gw",
      conversationID: "c"
    )
    try await store.advanceCursor(gatewayID: "gw", conversationID: "c", to: 9)
    try await store.saveDraft(draft, gatewayID: "gw", conversationID: "c")
  }

  private func expectConversationContentPurged(_ store: PersistenceStore) async throws {
    #expect(try await store.messages(gatewayID: "gw", conversationID: "c").isEmpty)
    #expect(try await store.cursor(gatewayID: "gw", conversationID: "c") == 0)
    #expect(try await store.draft(gatewayID: "gw", conversationID: "c") == nil)
  }

  private func tombstonedStore() async throws -> PersistenceStore {
    let store = try PersistenceStore.inMemory()
    try await store.applyTombstone(
      summary(
        id: "c",
        title: "Deleted",
        revision: 2,
        status: .deleted,
        deletedAt: instant(20)
      ),
      gatewayID: "gw"
    )
    return store
  }

  private func summary(
    id: String,
    title: String,
    revision: Int = 1,
    status: ConversationStatus = .idle,
    deletedAt: Date? = nil
  ) -> ConversationSummaryDTO {
    ConversationSummaryDTO(
      id: id,
      agentId: "agent-1",
      agentName: "Agent One",
      title: title,
      revision: revision,
      status: status,
      activeTurnId: nil,
      owningIssueId: "issue-1",
      projectId: "project-1",
      lastSeq: revision,
      lastMessagePreview: "Preview \(revision)",
      createdAt: instant(0),
      updatedAt: instant(revision),
      deletedAt: deletedAt
    )
  }

  private func message(
    id: String,
    ordinal: Int = 1,
    text: String? = nil,
    updatedOffset: Int? = nil
  ) -> ConversationMessageDTO {
    let timestamp = updatedOffset ?? ordinal
    return ConversationMessageDTO(
      id: id,
      conversationId: "c",
      turnId: "turn-\(ordinal)",
      ordinal: ordinal,
      role: .user,
      status: .completed,
      content: .user(text: text ?? "Message \(ordinal)", images: nil),
      createdAt: instant(ordinal),
      updatedAt: instant(timestamp)
    )
  }

  private func agent(id: String, name: String) -> RegisteredAgentDTO {
    RegisteredAgentDTO(
      id: id,
      name: name,
      config: AgentConfigDTO(
        name: name,
        model: "provider/model",
        systemPrompt: "System prompt for \(name)",
        fallbackModels: nil,
        tools: nil,
        skills: nil,
        workspace: nil,
        maxTokens: nil,
        mcpServers: nil,
        swarm: nil,
        plugins: nil,
        providers: nil
      ),
      status: .registered,
      registeredAt: instant(0)
    )
  }

  private func profile(label: String = "Gateway") -> ConnectionProfile {
    ConnectionProfile(
      id: UUID(uuidString: "018f0f4a-5c42-7a8b-9c01-1234567890ab")!,
      gatewayId: nil,
      publicKey: nil,
      label: label,
      host: "gateway.local",
      managementPort: 9300,
      chatPort: 9200,
      secure: false,
      mode: .lan,
      createdAt: instant(0),
      lastSuccessfulSyncAt: nil
    )
  }

  private func instant(_ seconds: Int) -> Date {
    Date(timeIntervalSince1970: TimeInterval(seconds))
  }
}

private func persistenceError(
  _ operation: () async throws -> Void
) async -> PersistenceStoreError? {
  do {
    try await operation()
    return nil
  } catch let error as PersistenceStoreError {
    return error
  } catch {
    Issue.record("Unexpected persistence error: \(error)")
    return nil
  }
}
