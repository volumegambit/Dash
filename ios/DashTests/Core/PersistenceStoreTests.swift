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
    try await store.upsertConversations(
      [summary(id: "c", title: "Conversation")],
      gatewayID: "gw"
    )
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
    try await store.upsertConversations(
      [summary(id: "c", title: "Conversation")],
      gatewayID: "gw"
    )
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
    try await store.upsertConversations(
      [summary(id: "c", title: "Conversation")],
      gatewayID: "gw"
    )
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
    try await store.upsertConversations(
      [summary(id: "c", title: "Conversation")],
      gatewayID: "gw"
    )
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

  @Test("message origin round trips through the v1 cache")
  func messageOriginRoundTrip() async throws {
    let store = try PersistenceStore.inMemory()
    try await store.upsertConversations(
      [summary(id: "c", title: "Conversation")],
      gatewayID: "gw"
    )
    let expected = message(id: "m-origin", origin: MessageOrigin.parent.rawValue)

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
    let pending = PendingChatSend(
      turnID: "turn-pending",
      localUserID: "local-user",
      draft: draft.text,
      attachments: draft.attachments,
      createdAt: instant(51)
    )
    try await store.stagePendingSend(pending, gatewayID: "gw", conversationID: "c")
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
    #expect(
      pendingPayload(try await store.pendingSend(gatewayID: "gw", conversationID: "c"))
        == pending
    )

    try await store.applyTombstone(tombstone, gatewayID: "gw")
    try await expectConversationContentPurged(store)
    #expect(
      pendingPayload(try await store.pendingSend(gatewayID: "gw", conversationID: "c"))
        == pending
    )
  }

  @Test("remote removal preserves the recoverable pending send payload")
  func remoteRemovalPreservesPendingSend() async throws {
    let store = try PersistenceStore.inMemory()
    let draft = ConversationDraft(
      text: "Recover after remote removal",
      attachments: [],
      updatedAt: instant(40)
    )
    let pending = PendingChatSend(
      turnID: "turn-pending",
      localUserID: "local-user",
      draft: "Recover after remote removal",
      attachments: [
        PreparedAttachment(
          id: UUID(uuidString: "018f0f4a-5c42-7a8b-9c01-1234567890ab")!,
          mediaType: "image/png",
          data: Data([0x00, 0x7F, 0xFF])
        )
      ],
      createdAt: instant(41)
    )
    try await store.upsertConversations(
      [summary(id: "c", title: "Remote conversation")],
      gatewayID: "gw"
    )
    try await cacheConversationContent(store, draft: draft)
    try await store.stagePendingSend(pending, gatewayID: "gw", conversationID: "c")

    try await store.removeConversation(gatewayID: "gw", conversationID: "c")

    let retained = try #require(try await store.conversation(gatewayID: "gw", id: "c"))
    #expect(retained.summary.status == .deleted)
    #expect(retained.summary.revision == 1)
    #expect(retained.summary.title == "Remote conversation")
    #expect(try await store.conversations(gatewayID: "gw", limit: 50).isEmpty)
    try await expectConversationContentPurged(store)
    #expect(
      pendingPayload(try await store.pendingSend(gatewayID: "gw", conversationID: "c"))
        == pending
    )
  }

  @Test("a stale removal fingerprint retains an equal-revision revived conversation and content")
  func conditionalRemovalRequiresExactCanonicalFingerprint() async throws {
    let store = try PersistenceStore.inMemory()
    let requestStart = summary(
      id: "c",
      title: "Before revival",
      revision: 5,
      updatedAt: instant(10)
    )
    let revived = summary(
      id: "c",
      title: "Revived elsewhere",
      revision: 5,
      status: .running,
      activeTurnID: "turn-revived",
      updatedAt: instant(20)
    )
    let draft = ConversationDraft(
      text: "Keep the revived draft",
      attachments: [],
      updatedAt: instant(21)
    )
    let revivedMessage = message(id: "revived-message")
    try await store.upsertConversations([revived], gatewayID: "gw")
    try await store.mergeMessages(
      [revivedMessage],
      gatewayID: "gw",
      conversationID: revived.id
    )
    try await store.saveDraft(draft, gatewayID: "gw", conversationID: revived.id)
    try await store.advanceCursor(gatewayID: "gw", conversationID: revived.id, to: 9)

    let outcome = try await store.removeConversationIfCanonicalUnchanged(
      gatewayID: "gw",
      conversationID: revived.id,
      expectedCanonical: requestStart
    )

    #expect(outcome == .retained(revived))
    #expect(try await store.conversation(gatewayID: "gw", id: revived.id)?.summary == revived)
    #expect(
      try await store.messages(gatewayID: "gw", conversationID: revived.id) == [revivedMessage]
    )
    #expect(try await store.draft(gatewayID: "gw", conversationID: revived.id) == draft)
    #expect(try await store.cursor(gatewayID: "gw", conversationID: revived.id) == 9)
  }

  @Test("a removal that started absent retains a conversation inserted before the 404")
  func conditionalRemovalRetainsConversationInsertedAfterAbsentStart() async throws {
    let store = try PersistenceStore.inMemory()
    let inserted = summary(id: "c", title: "Inserted while loading", revision: 1)
    try await store.upsertConversations([inserted], gatewayID: "gw")

    let outcome = try await store.removeConversationIfCanonicalUnchanged(
      gatewayID: "gw",
      conversationID: inserted.id,
      expectedCanonical: nil
    )

    #expect(outcome == .retained(inserted))
    #expect(try await store.conversation(gatewayID: "gw", id: inserted.id)?.summary == inserted)
  }

  @Test("removal fence rejects stale and equal canonical summaries until a newer revision revives")
  func removalFenceRequiresStrictlyNewerRevision() async throws {
    let store = try PersistenceStore.inMemory()
    try await store.upsertConversations(
      [summary(id: "c", title: "Current", revision: 5)],
      gatewayID: "gw"
    )

    try await store.removeConversation(
      gatewayID: "gw",
      conversationID: "c",
      revisionFloor: 6
    )
    try await store.upsertConversations(
      [
        summary(id: "c", title: "Stale", revision: 4),
        summary(id: "c", title: "Equal", revision: 6),
      ],
      gatewayID: "gw"
    )

    let fenced = try #require(try await store.conversation(gatewayID: "gw", id: "c"))
    #expect(fenced.summary.status == .deleted)
    #expect(fenced.summary.revision == 6)
    #expect(try await store.conversations(gatewayID: "gw", limit: 50).isEmpty)

    let revived = summary(id: "c", title: "Revived", revision: 7)
    try await store.upsertConversations([revived], gatewayID: "gw")
    #expect(try await store.conversation(gatewayID: "gw", id: "c")?.summary == revived)

    try await store.mergeMessages(
      [message(id: "after-revival")],
      gatewayID: "gw",
      conversationID: "c"
    )
    try await store.advanceCursor(gatewayID: "gw", conversationID: "c", to: 7)
    #expect(try await store.messages(gatewayID: "gw", conversationID: "c").count == 1)
    #expect(try await store.cursor(gatewayID: "gw", conversationID: "c") == 7)
  }

  @Test("unknown and fenced conversations reject late messages and cursors without creating rows")
  func missingAndFencedConversationsRejectLateContent() async throws {
    let store = try PersistenceStore.inMemory()

    let missingMessageError = await persistenceError {
      try await store.mergeMessages(
        [message(id: "missing-message")],
        gatewayID: "gw",
        conversationID: "missing"
      )
    }
    let missingCursorError = await persistenceError {
      try await store.advanceCursor(gatewayID: "gw", conversationID: "missing", to: 4)
    }
    #expect(
      missingMessageError == .conversationDeleted(gatewayID: "gw", conversationID: "missing")
    )
    #expect(
      missingCursorError == .conversationDeleted(gatewayID: "gw", conversationID: "missing")
    )
    #expect(try await store.messages(gatewayID: "gw", conversationID: "missing").isEmpty)
    #expect(try await store.cursor(gatewayID: "gw", conversationID: "missing") == 0)

    try await store.removeConversation(
      gatewayID: "gw",
      conversationID: "missing",
      revisionFloor: 3
    )
    let surrogate = try #require(
      try await store.conversation(gatewayID: "gw", id: "missing")
    )
    #expect(surrogate.summary.status == .deleted)
    #expect(surrogate.summary.revision == 3)
    #expect(try await store.conversations(gatewayID: "gw", limit: 50).isEmpty)

    let fencedMessageError = await persistenceError {
      try await store.mergeMessages(
        [message(id: "fenced-message")],
        gatewayID: "gw",
        conversationID: "missing"
      )
    }
    let fencedCursorError = await persistenceError {
      try await store.advanceCursor(gatewayID: "gw", conversationID: "missing", to: 5)
    }
    #expect(
      fencedMessageError == .conversationDeleted(gatewayID: "gw", conversationID: "missing")
    )
    #expect(
      fencedCursorError == .conversationDeleted(gatewayID: "gw", conversationID: "missing")
    )
    #expect(try await store.messages(gatewayID: "gw", conversationID: "missing").isEmpty)
    #expect(try await store.cursor(gatewayID: "gw", conversationID: "missing") == 0)

    try await store.upsertConversations(
      [summary(id: "missing", title: "Equal", revision: 3)],
      gatewayID: "gw"
    )
    #expect(try await store.conversation(gatewayID: "gw", id: "missing")?.summary.status == .deleted)

    let revived = summary(id: "missing", title: "Newer", revision: 4)
    try await store.upsertConversations([revived], gatewayID: "gw")
    #expect(try await store.conversation(gatewayID: "gw", id: "missing")?.summary == revived)
  }

  @Test("tombstones and repeated removals only raise a removal fence")
  func removalFenceIsMonotonic() async throws {
    let store = try PersistenceStore.inMemory()
    try await store.removeConversation(
      gatewayID: "gw",
      conversationID: "c",
      revisionFloor: 5
    )

    try await store.applyTombstone(
      summary(
        id: "c",
        title: "Newer tombstone",
        revision: 7,
        status: .deleted,
        deletedAt: instant(70)
      ),
      gatewayID: "gw"
    )
    try await store.removeConversation(
      gatewayID: "gw",
      conversationID: "c",
      revisionFloor: 6
    )

    #expect(try await store.conversation(gatewayID: "gw", id: "c")?.summary.revision == 7)
    try await store.upsertConversations(
      [summary(id: "c", title: "Equal active", revision: 7)],
      gatewayID: "gw"
    )
    #expect(try await store.conversation(gatewayID: "gw", id: "c")?.summary.status == .deleted)

    let revived = summary(id: "c", title: "New active", revision: 8)
    try await store.upsertConversations([revived], gatewayID: "gw")
    #expect(try await store.conversation(gatewayID: "gw", id: "c")?.summary == revived)
  }

  @Test("failed removal rolls back the surrogate fence and content purge")
  func failedRemovalRollsBack() async throws {
    let store = try PersistenceStore.inMemory()
    let original = summary(id: "c", title: "Still active", revision: 5)
    let draft = ConversationDraft(text: "Keep", attachments: [], updatedAt: instant(50))
    let pending = PendingChatSend(
      turnID: "pending-turn",
      localUserID: "local-user",
      draft: draft.text,
      attachments: [],
      createdAt: instant(51)
    )
    try await store.upsertConversations([original], gatewayID: "gw")
    try await store.stagePendingSend(pending, gatewayID: "gw", conversationID: "c")
    try await cacheConversationContent(store, draft: draft)

    await #expect(throws: PersistenceStoreTestError.save) {
      try await store.removeConversation(
        gatewayID: "gw",
        conversationID: "c",
        revisionFloor: 6,
        saveChanges: { throw PersistenceStoreTestError.save }
      )
    }

    #expect(try await store.conversation(gatewayID: "gw", id: "c")?.summary == original)
    #expect(try await store.messages(gatewayID: "gw", conversationID: "c") == [message(id: "m-1")])
    #expect(try await store.cursor(gatewayID: "gw", conversationID: "c") == 9)
    let rolledBackDraft = try await store.draft(gatewayID: "gw", conversationID: "c")
    #expect(rolledBackDraft == draft)
    #expect(
      pendingPayload(try await store.pendingSend(gatewayID: "gw", conversationID: "c"))
        == pending
    )

    let equalToRolledBackFence = summary(id: "c", title: "Accepted", revision: 6)
    try await store.upsertConversations([equalToRolledBackFence], gatewayID: "gw")
    #expect(
      try await store.conversation(gatewayID: "gw", id: "c")?.summary
        == equalToRolledBackFence
    )
  }

  @Test("removal fence migrates a legacy store and survives file reopen")
  @MainActor
  func removalFenceMigratesAndSurvivesReopen() async throws {
    let directory = FileManager.default.temporaryDirectory.appending(
      path: UUID().uuidString,
      directoryHint: .isDirectory
    )
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let storeURL = directory.appending(path: "dash.store")
    try writeLegacyConversation(summary(id: "c", title: "Legacy", revision: 4), at: storeURL)

    let migratedStore = try PersistenceStore.stored(at: storeURL)
    #expect(
      try await migratedStore.conversation(gatewayID: "gw", id: "c")?.summary.title == "Legacy"
    )
    try await migratedStore.removeConversation(
      gatewayID: "gw",
      conversationID: "c",
      revisionFloor: 5
    )

    let reopenedStore = try PersistenceStore.stored(at: storeURL)
    try await reopenedStore.upsertConversations(
      [summary(id: "c", title: "Equal after reopen", revision: 5)],
      gatewayID: "gw"
    )
    #expect(try await reopenedStore.conversation(gatewayID: "gw", id: "c")?.summary.status == .deleted)

    let revived = summary(id: "c", title: "Newer after reopen", revision: 6)
    try await reopenedStore.upsertConversations([revived], gatewayID: "gw")
    #expect(try await reopenedStore.conversation(gatewayID: "gw", id: "c")?.summary == revived)
  }

  @Test("a stale tombstone cannot purge newer conversation content")
  func staleTombstonePreservesNewerContent() async throws {
    let store = try PersistenceStore.inMemory()
    let current = summary(id: "c", title: "Current", revision: 6)
    let draft = ConversationDraft(
      text: "Keep the newer draft",
      attachments: [],
      updatedAt: instant(50)
    )
    let pending = PendingChatSend(
      turnID: "turn-pending",
      localUserID: "local-user",
      draft: draft.text,
      attachments: [],
      createdAt: instant(51)
    )
    let staleTombstone = summary(
      id: "c",
      title: "Stale deletion",
      revision: 5,
      status: .deleted,
      deletedAt: instant(40)
    )
    let pendingConversation = summary(id: "pending", title: "Pending current", revision: 6)
    let stalePendingTombstone = summary(
      id: "pending",
      title: "Stale pending deletion",
      revision: 5,
      status: .deleted,
      deletedAt: instant(40)
    )
    try await store.upsertConversations([current], gatewayID: "gw")
    try await cacheConversationContent(store, draft: draft)
    try await store.upsertConversations([pendingConversation], gatewayID: "gw")
    try await store.stagePendingSend(pending, gatewayID: "gw", conversationID: "pending")

    try await store.upsertConversations(
      [staleTombstone, stalePendingTombstone],
      gatewayID: "gw"
    )
    let staleCanonical = try await store.applyTombstoneAndReturnCanonical(
      staleTombstone,
      gatewayID: "gw"
    )
    try await store.applyTombstone(stalePendingTombstone, gatewayID: "gw")

    #expect(staleCanonical.summary == current)
    #expect(try await store.conversation(gatewayID: "gw", id: "c")?.summary == current)
    #expect(
      try await store.conversation(gatewayID: "gw", id: "pending")?.summary
        == pendingConversation
    )
    #expect(try await store.messages(gatewayID: "gw", conversationID: "c") == [message(id: "m-1")])
    #expect(try await store.cursor(gatewayID: "gw", conversationID: "c") == 9)
    #expect(try await store.draft(gatewayID: "gw", conversationID: "c") == draft)
    #expect(
      pendingPayload(
        try await store.pendingSend(gatewayID: "gw", conversationID: "pending")
      ) == pending
    )

    let equalTombstone = summary(
      id: "c",
      title: "Equal deletion",
      revision: 6,
      status: .deleted,
      deletedAt: instant(60)
    )
    let equalCanonical = try await store.applyTombstoneAndReturnCanonical(
      equalTombstone,
      gatewayID: "gw"
    )
    #expect(equalCanonical.summary == current)
    #expect(try await store.draft(gatewayID: "gw", conversationID: "c") == draft)
  }

  @Test("failed tombstone save rolls back summary purge and pending intent changes")
  func failedTombstoneSaveRollsBack() async throws {
    let store = try PersistenceStore.inMemory()
    let original = summary(id: "c", title: "Still present", revision: 4)
    let cachedMessage = message(id: "m-1")
    let pending = PendingChatSend(
      turnID: "turn-pending",
      localUserID: "local-user",
      draft: "Keep this intent",
      attachments: [
        PreparedAttachment(
          id: UUID(uuidString: "018f0f4a-5c42-7a8b-9c01-1234567890ab")!,
          mediaType: "image/webp",
          data: Data([0x01, 0x02, 0x03])
        )
      ],
      createdAt: instant(41)
    )
    try await store.upsertConversations([original], gatewayID: "gw")
    try await store.mergeMessages([cachedMessage], gatewayID: "gw", conversationID: "c")
    try await store.advanceCursor(gatewayID: "gw", conversationID: "c", to: 9)
    try await store.stagePendingSend(pending, gatewayID: "gw", conversationID: "c")

    await #expect(throws: PersistenceStoreTestError.save) {
      try await store.applyTombstone(
        summary(
          id: "c",
          title: "Deleted",
          revision: 5,
          status: .deleted,
          deletedAt: instant(60)
        ),
        gatewayID: "gw",
        saveChanges: { throw PersistenceStoreTestError.save }
      )
    }

    #expect(try await store.conversation(gatewayID: "gw", id: "c")?.summary == original)
    #expect(try await store.messages(gatewayID: "gw", conversationID: "c") == [cachedMessage])
    #expect(try await store.cursor(gatewayID: "gw", conversationID: "c") == 9)
    #expect(
      pendingPayload(try await store.pendingSend(gatewayID: "gw", conversationID: "c"))
        == pending
    )
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
    try await store.upsertConversations(
      [summary(id: "c", title: "Conversation")],
      gatewayID: "gw"
    )
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

  @Test("pending send staging and restoration move attachment bytes atomically")
  func pendingSendRoundTrip() async throws {
    let store = try PersistenceStore.inMemory()
    try await store.upsertConversations(
      [summary(id: "c", title: "Active conversation")],
      gatewayID: "gw"
    )
    let attachment = PreparedAttachment(
      id: UUID(uuidString: "018f0f4a-5c42-7a8b-9c01-1234567890ab")!,
      mediaType: "image/png",
      data: Data([0x00, 0x7F, 0xFF])
    )
    let originalDraft = ConversationDraft(
      text: "Recover me",
      attachments: [attachment],
      updatedAt: instant(40)
    )
    let pending = PendingChatSend(
      turnID: "turn-pending",
      localUserID: "local-user",
      draft: originalDraft.text,
      attachments: originalDraft.attachments,
      createdAt: instant(41)
    )
    try await store.saveDraft(originalDraft, gatewayID: "gw", conversationID: "c")

    try await store.stagePendingSend(pending, gatewayID: "gw", conversationID: "c")

    #expect(try await store.draft(gatewayID: "gw", conversationID: "c") == nil)
    #expect(
      pendingPayload(try await store.pendingSend(gatewayID: "gw", conversationID: "c"))
        == pending
    )

    let result = try await store.restorePendingSendAsDraft(
      gatewayID: "gw",
      conversationID: "c",
      turnID: pending.turnID
    )
    guard case .restored(let restoredDraft) = result else {
      Issue.record("Expected the active conversation pending send to be restored")
      return
    }
    let restored = try #require(restoredDraft)

    #expect(restored.text == originalDraft.text)
    #expect(restored.attachments == originalDraft.attachments)
    #expect(
      pendingPayload(try await store.pendingSend(gatewayID: "gw", conversationID: "c")) == nil
    )
    #expect(
      try await store.draft(gatewayID: "gw", conversationID: "c")?.attachments == [attachment]
    )
  }

  @Test("pending rejection preserves a newer coexisting draft")
  func pendingSendRestorePreservesNewerDraft() async throws {
    let directory = FileManager.default.temporaryDirectory.appending(
      path: UUID().uuidString,
      directoryHint: .isDirectory
    )
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let storeURL = directory.appending(path: "dash.store")
    let pendingAttachment = PreparedAttachment(
      id: UUID(uuidString: "018f0f4a-5c42-7a8b-9c01-1234567890ab")!,
      mediaType: "image/png",
      data: Data([0x01])
    )
    let newerDraftAttachment = PreparedAttachment(
      id: UUID(uuidString: "018f0f4a-5c42-7a8b-9c01-1234567890ac")!,
      mediaType: "image/webp",
      data: Data([0x02])
    )
    let pending = PendingChatSend(
      turnID: "turn-rejected",
      localUserID: "local-rejected",
      draft: "Rejected message",
      attachments: [pendingAttachment],
      createdAt: instant(41)
    )
    let newerDraft = ConversationDraft(
      text: "Do not overwrite this newer draft",
      attachments: [newerDraftAttachment],
      updatedAt: instant(42)
    )
    let store = try PersistenceStore.stored(at: storeURL)
    try await store.upsertConversations(
      [summary(id: "c", title: "Active conversation")],
      gatewayID: "gw"
    )
    #expect(
      try await store.stagePendingSend(pending, gatewayID: "gw", conversationID: "c")
        == .staged
    )
    #expect(try await store.recoverablePendingSends(gatewayID: "gw").isEmpty)
    try await store.saveDraft(newerDraft, gatewayID: "gw", conversationID: "c")

    let result = try await store.restorePendingSendAsDraft(
      gatewayID: "gw",
      conversationID: "c",
      turnID: pending.turnID
    )

    #expect(result == .draftConflict(newerDraft))
    #expect(try await store.draft(gatewayID: "gw", conversationID: "c") == newerDraft)
    let loadResult = try await store.pendingSend(gatewayID: "gw", conversationID: "c")
    guard case .recoveryRequired(let recovery) = loadResult else {
      Issue.record("Expected the colliding pending send to require manual recovery")
      return
    }
    #expect(recovery.pendingSend == pending)
    #expect(recovery.coexistingDraft == newerDraft)
    #expect(recovery.conversationAvailable)
    #expect(
      try await store.recoverablePendingSends(gatewayID: "gw").map(\.pendingSend)
        == [pending]
    )

    let reopenedStore = try PersistenceStore.stored(at: storeURL)
    #expect(try await reopenedStore.draft(gatewayID: "gw", conversationID: "c") == newerDraft)
    let reopenedLoad = try await reopenedStore.pendingSend(gatewayID: "gw", conversationID: "c")
    guard case .recoveryRequired(let reopenedRecovery) = reopenedLoad else {
      Issue.record("Expected manual recovery to survive reopening the store")
      return
    }
    #expect(reopenedRecovery.pendingSend == pending)
    #expect(reopenedRecovery.coexistingDraft == newerDraft)
    #expect(reopenedRecovery.conversationAvailable)
    #expect(
      try await reopenedStore.recoverablePendingSends(gatewayID: "gw").map(\.pendingSend)
        == [pending]
    )

    #expect(
      try await reopenedStore.discardPendingSend(
        gatewayID: "gw",
        conversationID: "c",
        turnID: pending.turnID
      )
    )
    #expect(try await reopenedStore.draft(gatewayID: "gw", conversationID: "c") == newerDraft)
    #expect(try await reopenedStore.pendingSend(gatewayID: "gw", conversationID: "c") == .none)
    #expect(try await reopenedStore.recoverablePendingSends(gatewayID: "gw").isEmpty)
  }

  @Test("deletion preserves both conflicting payloads until explicit recovery discard")
  func deletedDraftConflictPreservesBothPayloads() async throws {
    for removalKind in ["tombstone", "not-found"] {
      let directory = FileManager.default.temporaryDirectory.appending(
        path: UUID().uuidString,
        directoryHint: .isDirectory
      )
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      defer { try? FileManager.default.removeItem(at: directory) }
      let storeURL = directory.appending(path: "dash.store")
      let pending = PendingChatSend(
        turnID: "turn-\(removalKind)",
        localUserID: "local-\(removalKind)",
        draft: "Earlier message with uncertain delivery",
        attachments: [
          PreparedAttachment(
            id: UUID(),
            mediaType: "image/png",
            data: Data([0x01])
          )
        ],
        createdAt: instant(41)
      )
      let newerDraft = ConversationDraft(
        text: "Newer draft that must survive deletion",
        attachments: [
          PreparedAttachment(
            id: UUID(),
            mediaType: "image/webp",
            data: Data([0x02])
          )
        ],
        updatedAt: instant(42)
      )
      let store = try PersistenceStore.stored(at: storeURL)
      try await store.upsertConversations(
        [summary(id: "c", title: "Active conversation")],
        gatewayID: "gw"
      )
      #expect(
        try await store.stagePendingSend(pending, gatewayID: "gw", conversationID: "c")
          == .staged
      )
      try await store.saveDraft(newerDraft, gatewayID: "gw", conversationID: "c")
      #expect(
        try await store.restorePendingSendAsDraft(
          gatewayID: "gw",
          conversationID: "c",
          turnID: pending.turnID
        ) == .draftConflict(newerDraft)
      )
      let activeRecovery = try #require(
        try await store.recoverablePendingSends(gatewayID: "gw").first
      )
      #expect(activeRecovery.conversationAvailable)

      if removalKind == "tombstone" {
        try await store.applyTombstone(
          summary(
            id: "c",
            title: "Deleted conversation",
            revision: 2,
            status: .deleted,
            deletedAt: instant(43)
          ),
          gatewayID: "gw"
        )
      } else {
        try await store.removeConversation(gatewayID: "gw", conversationID: "c")
      }

      let reopenedStore = try PersistenceStore.stored(at: storeURL)
      let recoveries = try await reopenedStore.recoverablePendingSends(gatewayID: "gw")
      #expect(recoveries.count == 1)
      let recovery = try #require(recoveries.first)
      #expect(recovery.pendingSend == pending)
      #expect(recovery.coexistingDraft == newerDraft)
      #expect(recovery.conversationAvailable == false)
      #expect(try await reopenedStore.draft(gatewayID: "gw", conversationID: "c") == newerDraft)

      #expect(
        try await reopenedStore.discardPendingSend(
          gatewayID: "gw",
          conversationID: "c",
          turnID: pending.turnID,
          expectedConversationAvailable: activeRecovery.conversationAvailable
        ) == false
      )
      #expect(
        try await reopenedStore.recoverablePendingSends(gatewayID: "gw") == [recovery]
      )
      #expect(try await reopenedStore.draft(gatewayID: "gw", conversationID: "c") == newerDraft)

      #expect(
        try await reopenedStore.discardPendingSend(
          gatewayID: "gw",
          conversationID: "c",
          turnID: pending.turnID,
          expectedConversationAvailable: recovery.conversationAvailable
        )
      )
      let discardedStore = try PersistenceStore.stored(at: storeURL)
      #expect(try await discardedStore.pendingSend(gatewayID: "gw", conversationID: "c") == .none)
      #expect(try await discardedStore.draft(gatewayID: "gw", conversationID: "c") == nil)
      #expect(try await discardedStore.recoverablePendingSends(gatewayID: "gw").isEmpty)
    }
  }

  @Test("canonical admission durably clears only the matching pending turn")
  func pendingSendClearRequiresMatchingTurn() async throws {
    let store = try PersistenceStore.inMemory()
    try await store.upsertConversations(
      [summary(id: "c", title: "Active conversation")],
      gatewayID: "gw"
    )
    let pending = PendingChatSend(
      turnID: "turn-pending",
      localUserID: "local-user",
      draft: "Sent",
      attachments: [],
      createdAt: instant(41)
    )
    try await store.stagePendingSend(pending, gatewayID: "gw", conversationID: "c")

    let mismatched = try await store.clearPendingSend(
      gatewayID: "gw",
      conversationID: "c",
      turnID: "different-turn"
    )
    #expect(mismatched == .cleared)
    #expect(
      pendingPayload(try await store.pendingSend(gatewayID: "gw", conversationID: "c"))
        == pending
    )
    #expect(
      try await store.pendingSendAvailability(
        gatewayID: "gw",
        conversationID: "c",
        turnID: pending.turnID
      ) == .active
    )

    let cleared = try await store.clearPendingSend(
      gatewayID: "gw",
      conversationID: "c",
      turnID: pending.turnID
    )
    #expect(cleared == .cleared)
    #expect(
      pendingPayload(try await store.pendingSend(gatewayID: "gw", conversationID: "c")) == nil
    )
    #expect(
      try await store.pendingSendAvailability(
        gatewayID: "gw",
        conversationID: "c",
        turnID: pending.turnID
      ) == .pendingMissing
    )
  }

  @Test("canonical acceptance cannot clear a pending send after its conversation is tombstoned")
  func pendingSendClearPreservesTombstonedRecovery() async throws {
    let store = try PersistenceStore.inMemory()
    let pending = PendingChatSend(
      turnID: "turn-pending",
      localUserID: "local-user",
      draft: "Preserve the accepted race",
      attachments: [],
      createdAt: instant(41)
    )
    try await store.upsertConversations(
      [summary(id: "c", title: "Active conversation")],
      gatewayID: "gw"
    )
    try await store.stagePendingSend(pending, gatewayID: "gw", conversationID: "c")
    try await store.applyTombstone(
      summary(
        id: "c",
        title: "Deleted conversation",
        revision: 2,
        status: .deleted,
        deletedAt: instant(42)
      ),
      gatewayID: "gw"
    )

    let result = try await store.clearPendingSend(
      gatewayID: "gw",
      conversationID: "c",
      turnID: pending.turnID
    )

    #expect(result == .conversationUnavailable)
    #expect(
      try await store.pendingSendAvailability(
        gatewayID: "gw",
        conversationID: "c",
        turnID: pending.turnID
      ) == .conversationUnavailable
    )
    #expect(
      pendingPayload(try await store.pendingSend(gatewayID: "gw", conversationID: "c"))
        == pending
    )
    #expect(
      try await store.recoverablePendingSends(gatewayID: "gw").map(\.pendingSend) == [pending]
    )
  }

  @Test("canonical rejection cannot restore and erase a pending send after cache removal")
  func pendingSendRestorePreservesMissingRecovery() async throws {
    let store = try PersistenceStore.inMemory()
    let pending = PendingChatSend(
      turnID: "turn-pending",
      localUserID: "local-user",
      draft: "Preserve the rejected race",
      attachments: [],
      createdAt: instant(41)
    )
    try await store.upsertConversations(
      [summary(id: "c", title: "Active conversation")],
      gatewayID: "gw"
    )
    try await store.stagePendingSend(pending, gatewayID: "gw", conversationID: "c")
    try await store.removeConversation(gatewayID: "gw", conversationID: "c")

    let result = try await store.restorePendingSendAsDraft(
      gatewayID: "gw",
      conversationID: "c",
      turnID: pending.turnID
    )

    #expect(result == .conversationUnavailable)
    #expect(
      try await store.pendingSendAvailability(
        gatewayID: "gw",
        conversationID: "c",
        turnID: pending.turnID
      ) == .conversationUnavailable
    )
    #expect(
      pendingPayload(try await store.pendingSend(gatewayID: "gw", conversationID: "c"))
        == pending
    )
    #expect(try await store.draft(gatewayID: "gw", conversationID: "c") == nil)
    #expect(
      try await store.recoverablePendingSends(gatewayID: "gw").map(\.pendingSend) == [pending]
    )
  }

  @Test("pending attachment bytes survive reopening the persistent store")
  func pendingAttachmentSurvivesStoreRestart() async throws {
    let directory = FileManager.default.temporaryDirectory.appending(
      path: UUID().uuidString,
      directoryHint: .isDirectory
    )
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let storeURL = directory.appending(path: "dash.store")
    let attachment = PreparedAttachment(
      id: UUID(uuidString: "018f0f4a-5c42-7a8b-9c01-1234567890ab")!,
      mediaType: "image/webp",
      data: Data([0x00, 0x7F, 0xFF])
    )
    let pending = PendingChatSend(
      turnID: "turn-pending",
      localUserID: "local-user",
      draft: "Recover after restart",
      attachments: [attachment],
      createdAt: instant(41)
    )
    let initialStore = try PersistenceStore.stored(at: storeURL)
    try await initialStore.stagePendingSend(pending, gatewayID: "gw", conversationID: "c")

    let reopenedStore = try PersistenceStore.stored(at: storeURL)

    #expect(
      pendingPayload(
        try await reopenedStore.pendingSend(gatewayID: "gw", conversationID: "c")
      ) == pending
    )
  }

  @Test("deleted and missing pending sends remain recoverable after restart until discarded")
  func recoverablePendingSendsSurviveStoreRestart() async throws {
    let directory = FileManager.default.temporaryDirectory.appending(
      path: UUID().uuidString,
      directoryHint: .isDirectory
    )
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let storeURL = directory.appending(path: "dash.store")
    let attachment = PreparedAttachment(
      id: UUID(uuidString: "018f0f4a-5c42-7a8b-9c01-1234567890ab")!,
      mediaType: "image/png",
      data: Data([0x00, 0x7F, 0xFF])
    )
    let deletedPending = PendingChatSend(
      turnID: "turn-deleted",
      localUserID: "local-deleted",
      draft: "  Preserve deleted text exactly  ",
      attachments: [attachment],
      createdAt: instant(43)
    )
    let missingPending = PendingChatSend(
      turnID: "turn-missing",
      localUserID: "local-missing",
      draft: "Preserve missing text",
      attachments: [],
      createdAt: instant(42)
    )
    let activePending = PendingChatSend(
      turnID: "turn-active",
      localUserID: "local-active",
      draft: "Still belongs to an active chat",
      attachments: [],
      createdAt: instant(41)
    )
    let initialStore = try PersistenceStore.stored(at: storeURL)
    try await initialStore.upsertConversations(
      [
        summary(id: "deleted", title: "Deleted launch plan"),
        summary(id: "missing", title: "Removed remotely"),
        summary(id: "active", title: "Active conversation"),
      ],
      gatewayID: "gw"
    )
    try await initialStore.stagePendingSend(
      deletedPending,
      gatewayID: "gw",
      conversationID: "deleted"
    )
    try await initialStore.stagePendingSend(
      missingPending,
      gatewayID: "gw",
      conversationID: "missing"
    )
    try await initialStore.stagePendingSend(
      activePending,
      gatewayID: "gw",
      conversationID: "active"
    )
    try await initialStore.applyTombstone(
      summary(
        id: "deleted",
        title: "Deleted launch plan",
        revision: 2,
        status: .deleted,
        deletedAt: instant(44)
      ),
      gatewayID: "gw"
    )
    try await initialStore.removeConversation(gatewayID: "gw", conversationID: "missing")

    let reopenedStore = try PersistenceStore.stored(at: storeURL)
    let recoveries = try await reopenedStore.recoverablePendingSends(gatewayID: "gw")

    #expect(recoveries.map(\.conversationID) == ["deleted", "missing"])
    #expect(recoveries[0].conversationTitle == "Deleted launch plan")
    #expect(recoveries[0].agentName == "Agent One")
    #expect(recoveries[0].pendingSend == deletedPending)
    #expect(recoveries[1].conversationTitle == "Removed remotely")
    #expect(recoveries[1].agentName == "Agent One")
    #expect(recoveries[1].pendingSend == missingPending)

    let mismatchedClear = try await reopenedStore.clearPendingSend(
      gatewayID: "gw",
      conversationID: "deleted",
      turnID: "different-turn"
    )
    #expect(mismatchedClear == .conversationUnavailable)
    #expect(try await reopenedStore.recoverablePendingSends(gatewayID: "gw") == recoveries)

    let protectedClear = try await reopenedStore.clearPendingSend(
      gatewayID: "gw",
      conversationID: "deleted",
      turnID: deletedPending.turnID
    )
    #expect(protectedClear == .conversationUnavailable)
    #expect(try await reopenedStore.recoverablePendingSends(gatewayID: "gw") == recoveries)

    #expect(
      try await reopenedStore.discardPendingSend(
        gatewayID: "gw",
        conversationID: "deleted",
        turnID: deletedPending.turnID
      )
    )
    #expect(
      try await reopenedStore.recoverablePendingSends(gatewayID: "gw").map(\.conversationID)
        == ["missing"]
    )
  }

  @Test("recovery discard atomically reports whether the exact pending turn was removed")
  func recoverablePendingSendDiscardIsAtomicAndExact() async throws {
    let store = try PersistenceStore.inMemory()
    let pending = PendingChatSend(
      turnID: "turn-pending",
      localUserID: "local-user",
      draft: "Preserve me",
      attachments: [],
      createdAt: instant(41)
    )
    try await store.stagePendingSend(pending, gatewayID: "gw", conversationID: "missing")

    #expect(
      try await store.discardPendingSend(
        gatewayID: "gw",
        conversationID: "missing",
        turnID: "different-turn"
      ) == false
    )
    #expect(
      pendingPayload(
        try await store.pendingSend(gatewayID: "gw", conversationID: "missing")
      ) == pending
    )
    #expect(
      try await store.discardPendingSend(
        gatewayID: "gw",
        conversationID: "missing",
        turnID: pending.turnID
      )
    )
    #expect(
      pendingPayload(
        try await store.pendingSend(gatewayID: "gw", conversationID: "missing")
      ) == nil
    )
    #expect(
      try await store.discardPendingSend(
        gatewayID: "gw",
        conversationID: "missing",
        turnID: pending.turnID
      ) == false
    )
  }

  @Test("one corrupt attachment payload remains explicit without hiding healthy recoveries")
  func corruptRecoveryAttachmentDoesNotHideHealthyRecoveries() async throws {
    let store = try PersistenceStore.inMemory()
    let healthyAttachment = PreparedAttachment(
      id: UUID(uuidString: "018f0f4a-5c42-7a8b-9c01-1234567890ab")!,
      mediaType: "image/png",
      data: Data([0x00, 0x7F, 0xFF])
    )
    let corrupt = PendingChatSend(
      turnID: "turn-corrupt",
      localUserID: "local-corrupt",
      draft: "Text survives a damaged attachment",
      attachments: [healthyAttachment],
      createdAt: instant(42)
    )
    let healthy = PendingChatSend(
      turnID: "turn-healthy",
      localUserID: "local-healthy",
      draft: "Healthy recovery",
      attachments: [healthyAttachment],
      createdAt: instant(41)
    )
    try await store.stagePendingSend(
      corrupt,
      gatewayID: "gw",
      conversationID: "corrupt",
      encodeAttachments: { _ in Data("not-json".utf8) }
    )
    try await store.stagePendingSend(healthy, gatewayID: "gw", conversationID: "healthy")

    let recoveries = try await store.recoverablePendingSends(gatewayID: "gw")

    #expect(recoveries.map(\.conversationID) == ["corrupt", "healthy"])
    #expect(recoveries[0].pendingSend.draft == corrupt.draft)
    #expect(recoveries[0].pendingSend.attachments.isEmpty)
    #expect(recoveries[0].attachmentIssue == .unreadableStoredPayload)
    #expect(recoveries[1].pendingSend == healthy)
    #expect(recoveries[1].attachmentIssue == nil)
  }

  @Test("one corrupt coexisting draft payload keeps both texts and healthy recoveries visible")
  func corruptCoexistingDraftDoesNotHideRecoveries() async throws {
    let directory = FileManager.default.temporaryDirectory.appending(
      path: UUID().uuidString,
      directoryHint: .isDirectory
    )
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let storeURL = directory.appending(path: "dash.store")
    let store = try PersistenceStore.stored(at: storeURL)
    try await store.upsertConversations(
      [
        summary(id: "corrupt", title: "Corrupt draft"),
        summary(id: "healthy", title: "Healthy draft"),
      ],
      gatewayID: "gw"
    )
    let pendingAttachment = PreparedAttachment(
      id: UUID(),
      mediaType: "image/png",
      data: Data([0x01])
    )
    let draftAttachment = PreparedAttachment(
      id: UUID(),
      mediaType: "image/webp",
      data: Data([0x02])
    )
    let corruptPending = PendingChatSend(
      turnID: "turn-corrupt-draft",
      localUserID: "local-corrupt-draft",
      draft: "Earlier corrupt-draft message",
      attachments: [pendingAttachment],
      createdAt: instant(42)
    )
    let healthyPending = PendingChatSend(
      turnID: "turn-healthy-draft",
      localUserID: "local-healthy-draft",
      draft: "Earlier healthy message",
      attachments: [],
      createdAt: instant(41)
    )
    let corruptDraft = ConversationDraft(
      text: "Exact newer text survives corrupt image bytes",
      attachments: [draftAttachment],
      updatedAt: instant(43)
    )
    let healthyDraft = ConversationDraft(
      text: "Healthy newer draft",
      attachments: [draftAttachment],
      updatedAt: instant(43)
    )
    try await store.stagePendingSend(
      corruptPending,
      gatewayID: "gw",
      conversationID: "corrupt"
    )
    try await store.stagePendingSend(
      healthyPending,
      gatewayID: "gw",
      conversationID: "healthy"
    )
    try await store.saveDraft(
      corruptDraft,
      gatewayID: "gw",
      conversationID: "corrupt",
      encodeAttachments: { _ in Data("corrupt-draft-attachments".utf8) }
    )
    try await store.saveDraft(healthyDraft, gatewayID: "gw", conversationID: "healthy")

    let recoveries = try await store.recoverablePendingSends(gatewayID: "gw")
    #expect(recoveries.map(\.conversationID) == ["corrupt", "healthy"])
    #expect(recoveries[0].pendingSend == corruptPending)
    #expect(recoveries[0].coexistingDraft?.text == corruptDraft.text)
    #expect(recoveries[0].coexistingDraft?.attachments.isEmpty == true)
    #expect(recoveries[0].coexistingDraftAttachmentIssue == .unreadableStoredPayload)
    #expect(recoveries[1].pendingSend == healthyPending)
    #expect(recoveries[1].coexistingDraft == healthyDraft)
    #expect(recoveries[1].coexistingDraftAttachmentIssue == nil)

    let reopenedStore = try PersistenceStore.stored(at: storeURL)
    let reopenedRecoveries = try await reopenedStore.recoverablePendingSends(gatewayID: "gw")
    #expect(reopenedRecoveries == recoveries)
    guard case .recoveryRequired(let directRecovery) = try await reopenedStore.pendingSend(
      gatewayID: "gw",
      conversationID: "corrupt"
    ) else {
      Issue.record("Expected corrupt coexisting draft data to remain a recovery item")
      return
    }
    #expect(directRecovery == recoveries[0])
  }

  @Test("active recovery discard preserves corrupt newer draft text after restart")
  func activeRecoveryDiscardSanitizesCorruptCoexistingDraft() async throws {
    let directory = FileManager.default.temporaryDirectory.appending(
      path: UUID().uuidString,
      directoryHint: .isDirectory
    )
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let storeURL = directory.appending(path: "dash.store")
    let pending = PendingChatSend(
      turnID: "turn-earlier",
      localUserID: "local-earlier",
      draft: "Earlier message with uncertain delivery",
      attachments: [],
      createdAt: instant(41)
    )
    let newerDraft = ConversationDraft(
      text: "  Exact newer draft text\nwith whitespace\t ",
      attachments: [
        PreparedAttachment(
          id: UUID(uuidString: "018f0f4a-5c42-7a8b-9c01-1234567890ad")!,
          mediaType: "image/png",
          data: Data([0x01])
        )
      ],
      updatedAt: instant(42)
    )
    let initialStore = try PersistenceStore.stored(at: storeURL)
    try await initialStore.upsertConversations(
      [summary(id: "active", title: "Active conversation")],
      gatewayID: "gw"
    )
    #expect(
      try await initialStore.stagePendingSend(
        pending,
        gatewayID: "gw",
        conversationID: "active"
      ) == .staged
    )
    try await initialStore.saveDraft(
      newerDraft,
      gatewayID: "gw",
      conversationID: "active",
      encodeAttachments: { _ in Data("corrupt-draft-attachments".utf8) }
    )

    let recoveryStore = try PersistenceStore.stored(at: storeURL)
    let recovery = try #require(
      try await recoveryStore.recoverablePendingSends(gatewayID: "gw").first
    )
    #expect(recovery.coexistingDraft?.text == newerDraft.text)
    #expect(recovery.coexistingDraft?.attachments.isEmpty == true)
    #expect(recovery.coexistingDraftAttachmentIssue == .unreadableStoredPayload)
    #expect(recovery.conversationAvailable)

    #expect(
      try await recoveryStore.discardPendingSend(
        gatewayID: "gw",
        conversationID: "active",
        turnID: pending.turnID,
        expectedConversationAvailable: true
      )
    )

    let reopenedStore = try PersistenceStore.stored(at: storeURL)
    let expectedDraft = ConversationDraft(
      text: newerDraft.text,
      attachments: [],
      updatedAt: newerDraft.updatedAt
    )
    let restoredDraft = try? await reopenedStore.draft(
      gatewayID: "gw",
      conversationID: "active"
    )
    #expect(restoredDraft == expectedDraft)
    #expect(
      try await reopenedStore.pendingSend(gatewayID: "gw", conversationID: "active") == .none
    )
    #expect(try await reopenedStore.recoverablePendingSends(gatewayID: "gw").isEmpty)
  }

  @Test("an active corrupt pending send loads as explicit recovery after restart")
  func activeCorruptPendingSendLoadsAsRecoveryAfterRestart() async throws {
    let directory = FileManager.default.temporaryDirectory.appending(
      path: UUID().uuidString,
      directoryHint: .isDirectory
    )
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let storeURL = directory.appending(path: "dash.store")
    let corruptBytes = Data("corrupt-active-attachments".utf8)
    let pending = PendingChatSend(
      turnID: "turn-corrupt-active",
      localUserID: "local-corrupt-active",
      draft: "Keep this active message recoverable",
      attachments: [],
      createdAt: instant(45)
    )
    let initialStore = try PersistenceStore.stored(at: storeURL)
    try await initialStore.upsertConversations(
      [summary(id: "active", title: "Active launch plan")],
      gatewayID: "gw"
    )
    #expect(
      try await initialStore.stagePendingSend(
        pending,
        gatewayID: "gw",
        conversationID: "active",
        encodeAttachments: { _ in corruptBytes }
      ) == .staged
    )

    let reopenedStore = try PersistenceStore.stored(at: storeURL)
    let expected = RecoverablePendingSend(
      gatewayID: "gw",
      conversationID: "active",
      conversationTitle: "Active launch plan",
      agentName: "Agent One",
      pendingSend: pending,
      attachmentIssue: .unreadableStoredPayload,
      conversationAvailable: true
    )

    #expect(
      try await reopenedStore.pendingSend(gatewayID: "gw", conversationID: "active")
        == .recoveryRequired(expected)
    )
    #expect(try await reopenedStore.recoverablePendingSends(gatewayID: "gw") == [expected])
  }

  @Test("pending send staging is insert only and preserves corrupt bytes and draft")
  func pendingSendStageCollisionPreservesStoredRecovery() async throws {
    let directory = FileManager.default.temporaryDirectory.appending(
      path: UUID().uuidString,
      directoryHint: .isDirectory
    )
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let storeURL = directory.appending(path: "dash.store")
    let corruptBytes = Data("original-corrupt-bytes".utf8)
    let original = PendingChatSend(
      turnID: "turn-original",
      localUserID: "local-original",
      draft: "Original saved message",
      attachments: [],
      createdAt: instant(45)
    )
    let replacement = PendingChatSend(
      turnID: "turn-replacement",
      localUserID: "local-replacement",
      draft: "Replacement must remain a draft",
      attachments: [],
      createdAt: instant(46)
    )
    let coexistingDraft = ConversationDraft(
      text: replacement.draft,
      attachments: [],
      updatedAt: instant(46)
    )
    let initialStore = try PersistenceStore.stored(at: storeURL)
    try await initialStore.upsertConversations(
      [summary(id: "active", title: "Active launch plan")],
      gatewayID: "gw"
    )
    #expect(
      try await initialStore.stagePendingSend(
        original,
        gatewayID: "gw",
        conversationID: "active",
        encodeAttachments: { _ in corruptBytes }
      ) == .staged
    )
    try await initialStore.saveDraft(coexistingDraft, gatewayID: "gw", conversationID: "active")

    let encoder = PendingAttachmentEncodeProbe()
    #expect(
      try await initialStore.stagePendingSend(
        replacement,
        gatewayID: "gw",
        conversationID: "active",
        encodeAttachments: encoder.encode
      ) == .pendingAlreadyExists
    )
    #expect(encoder.count == 0)
    #expect(
      try await initialStore.draft(gatewayID: "gw", conversationID: "active")
        == coexistingDraft
    )

    let reopenedStore = try PersistenceStore.stored(at: storeURL)
    let decoder = PendingAttachmentDecodeProbe()
    let recoveries = try await reopenedStore.recoverablePendingSends(
      gatewayID: "gw",
      decodeAttachments: decoder.decode
    )
    let recovery = try #require(recoveries.first)
    #expect(recoveries.count == 1)
    #expect(recovery.conversationID == "active")
    #expect(recovery.pendingSend.turnID == original.turnID)
    #expect(recovery.pendingSend.localUserID == original.localUserID)
    #expect(recovery.pendingSend.draft == original.draft)
    #expect(recovery.pendingSend.createdAt == original.createdAt)
    #expect(recovery.pendingSend.attachments.isEmpty)
    #expect(recovery.attachmentIssue == .unreadableStoredPayload)
    #expect(decoder.values == [corruptBytes])
    #expect(
      try await reopenedStore.draft(gatewayID: "gw", conversationID: "active")
        == coexistingDraft
    )
  }

  @Test("unchanged recovery enumeration reuses decoded attachment payloads")
  func recoverablePendingSendEnumerationCachesDecodedPayloads() async throws {
    let store = try PersistenceStore.inMemory()
    let pending = PendingChatSend(
      turnID: "turn-pending",
      localUserID: "local-user",
      draft: "Recover me",
      attachments: [
        PreparedAttachment(id: UUID(), mediaType: "image/png", data: Data([0x01]))
      ],
      createdAt: instant(41)
    )
    try await store.stagePendingSend(pending, gatewayID: "gw", conversationID: "missing")
    let decoder = RecoveryAttachmentDecodeCounter()

    _ = try await store.recoverablePendingSends(
      gatewayID: "gw",
      decodeAttachments: decoder.decode
    )
    try await store.upsertConversations(
      [summary(id: "healthy", title: "Healthy")],
      gatewayID: "gw"
    )
    _ = try await store.recoverablePendingSends(
      gatewayID: "gw",
      decodeAttachments: decoder.decode
    )

    #expect(decoder.count == 1)
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

  @Test("single-agent cache mutations preserve unrelated agents and gateways")
  func singleAgentMutationsAreScoped() async throws {
    let store = try PersistenceStore.inMemory()
    let original = agent(id: "a-1", name: "Original")
    let unrelated = agent(id: "a-2", name: "Unrelated")
    let otherGateway = agent(id: "b-1", name: "Other gateway")
    try await store.replaceAgents([original, unrelated], gatewayID: "gw-a")
    try await store.replaceAgents([otherGateway], gatewayID: "gw-b")

    let updated = agent(id: original.id, name: "Updated")
    try await store.upsertAgent(updated, gatewayID: "gw-a")

    #expect(try await store.agents(gatewayID: "gw-a") == [updated, unrelated])
    #expect(try await store.agents(gatewayID: "gw-b") == [otherGateway])

    try await store.removeAgent(gatewayID: "gw-a", agentID: original.id)

    #expect(try await store.agents(gatewayID: "gw-a") == [unrelated])
    #expect(try await store.agents(gatewayID: "gw-b") == [otherGateway])
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
    #expect(
      cached.profile.tlsCertificateSha256
        == "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    )
    #expect(cached.profile.lastSuccessfulSyncAt == instant(90))
  }

  @Test("failed profile save rolls back dirty SwiftData metadata")
  func failedProfileSaveRollsBackDirtyMetadata() async throws {
    let store = try PersistenceStore.inMemory()
    let originalIdentity = GatewayIdentityDTO(gatewayId: "gw", publicKey: "old-public-key")
    let replacementIdentity = GatewayIdentityDTO(gatewayId: "gw", publicKey: "new-public-key")
    try await store.upsertProfile(profile(label: "Original"), identity: originalIdentity)

    await #expect(throws: PersistenceStoreTestError.save) {
      try await store.upsertProfile(
        profile(label: "Replacement"),
        identity: replacementIdentity,
        saveChanges: { throw PersistenceStoreTestError.save }
      )
    }

    let retained = try #require(try await store.profile(gatewayID: "gw"))
    #expect(retained.profile.label == "Original")
    #expect(retained.profile.publicKey == "old-public-key")
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

  @Test("clearing a gateway removes only that gateway's removal fences")
  func clearGatewayScopesRemovalFences() async throws {
    let store = try PersistenceStore.inMemory()
    for gatewayID in ["gw-a", "gw-b"] {
      try await store.removeConversation(
        gatewayID: gatewayID,
        conversationID: "same",
        revisionFloor: 5
      )
    }

    try await store.clearGateway(gatewayID: "gw-a")
    let equal = summary(id: "same", title: "Equal", revision: 5)
    try await store.upsertConversations([equal], gatewayID: "gw-a")
    try await store.upsertConversations([equal], gatewayID: "gw-b")

    #expect(try await store.conversation(gatewayID: "gw-a", id: "same")?.summary == equal)
    #expect(
      try await store.conversation(gatewayID: "gw-b", id: "same")?.summary.status == .deleted
    )
  }

  @Test("v2 bootstrap atomically installs an independently versioned projection")
  func v2BootstrapRoundTrip() async throws {
    let store = try PersistenceStore.inMemory()
    let bootstrap = try v2BootstrapFixture()

    let result = try await store.replaceV2Bootstrap(bootstrap, gatewayID: "gw")
    let cached = try #require(
      try await store.v2Bootstrap(
        gatewayID: "gw",
        conversationID: bootstrap.conversation.id
      )
    )
    let versioned = try #require(
      try await store.v2Projection(
        gatewayID: "gw",
        conversationID: bootstrap.conversation.id
      )
    )

    #expect(result.disposition == .installed)
    #expect(cached.v2ThroughSeq == bootstrap.v2ThroughSeq)
    #expect(cached.pendingInputs == bootstrap.pendingInputs)
    #expect(cached.pendingFollowUpCount == bootstrap.conversation.pendingFollowUpCount)
    #expect(cached.deliveryByMessageID.values.contains { $0.kind == .normal })
    #expect(versioned.projection.anchor == cached)
    #expect(versioned.projection.appliedFrames.isEmpty)
    #expect(versioned.version == .init(committedV2Seq: bootstrap.v2ThroughSeq, mutationRevision: 1))
    #expect(
      try await store.v2Cursor(
        gatewayID: "gw",
        conversationID: bootstrap.conversation.id
      ) == bootstrap.v2ThroughSeq
    )
    #expect(
      try await store.cursor(
        gatewayID: "gw",
        conversationID: bootstrap.conversation.id
      ) == 0
    )
  }

  @Test("v2 child bootstrap retains every conversation-summary field through the cache")
  func v2ChildSummaryProjectionRoundTrip() async throws {
    let store = try PersistenceStore.inMemory()
    let child = try MobileV2FixtureLoader.decode(
      MobileV2ConversationSummary.self,
      "conversation-summary-subagent.json"
    )
    let bootstrap = MobileV2ConversationBootstrap(
      conversation: child,
      messages: [],
      nextCursor: nil,
      pendingInputs: [],
      queuePaused: child.queuePaused,
      queueRevision: child.queueRevision,
      v2ThroughSeq: child.v2LastSeq
    )
    let expected = ConversationSummaryDTO(
      id: child.id,
      agentId: child.agentId,
      agentName: child.agentName,
      title: child.title,
      revision: child.revision,
      status: child.status,
      activeTurnId: child.activeTurnId,
      owningIssueId: child.owningIssueId,
      projectId: child.projectId,
      lastSeq: child.lastSeq,
      lastMessagePreview: child.lastMessagePreview,
      createdAt: child.createdAt,
      updatedAt: child.updatedAt,
      deletedAt: child.deletedAt,
      kind: child.kind.rawValue,
      parentConversationId: child.parentConversationId,
      parentTurnId: child.parentTurnId,
      subagent: child.subagent
    )
    let preMetadataCache = ConversationSummaryDTO(
      id: child.id,
      agentId: child.agentId,
      agentName: child.agentName,
      title: child.title,
      revision: child.revision - 1,
      status: child.status,
      activeTurnId: child.activeTurnId,
      owningIssueId: child.owningIssueId,
      projectId: child.projectId,
      lastSeq: child.lastSeq,
      lastMessagePreview: child.lastMessagePreview,
      createdAt: child.createdAt,
      updatedAt: child.updatedAt.addingTimeInterval(-1),
      deletedAt: child.deletedAt
    )
    try await store.upsertConversations([preMetadataCache], gatewayID: "gw")
    #expect(
      try await store.conversation(gatewayID: "gw", id: child.id)?.summary
        == preMetadataCache
    )

    let installed = try await store.replaceV2Bootstrap(bootstrap, gatewayID: "gw")

    #expect(installed.current.projection.anchor.conversation == expected)
    #expect(
      try await store.v2Bootstrap(gatewayID: "gw", conversationID: child.id)?.conversation
        == expected
    )
    #expect(try await store.conversation(gatewayID: "gw", id: child.id)?.summary == expected)
    #expect(try await store.conversations(gatewayID: "gw", limit: 10).map(\.summary) == [expected])

    let updated = ConversationSummaryDTO(
      id: child.id,
      agentId: child.agentId,
      agentName: child.agentName,
      title: "Updated child",
      revision: child.revision + 1,
      status: child.status,
      activeTurnId: child.activeTurnId,
      owningIssueId: child.owningIssueId,
      projectId: child.projectId,
      lastSeq: child.lastSeq,
      lastMessagePreview: child.lastMessagePreview,
      createdAt: child.createdAt,
      updatedAt: child.updatedAt.addingTimeInterval(1),
      deletedAt: child.deletedAt,
      kind: child.kind.rawValue,
      parentConversationId: child.parentConversationId,
      parentTurnId: child.parentTurnId,
      subagent: child.subagent
    )
    try await store.upsertConversations([updated], gatewayID: "gw")
    #expect(try await store.conversation(gatewayID: "gw", id: child.id)?.summary == updated)
  }

  @Test("v2 bootstrap is monotonic and same-watermark compaction is versioned")
  func v2BootstrapMonotonicDispositions() async throws {
    let store = try PersistenceStore.inMemory()
    let first = try v2BootstrapFixture()
    _ = try await store.replaceV2Bootstrap(first, gatewayID: "gw")

    let unchanged = try await store.replaceV2Bootstrap(first, gatewayID: "gw")
    #expect(unchanged.disposition == .unchanged)
    #expect(unchanged.current.version.mutationRevision == 1)

    let compactedValue = v2Bootstrap(
      from: first,
      title: "Canonical repair",
      revision: first.conversation.revision + 1
    )
    let compacted = try await store.replaceV2Bootstrap(compactedValue, gatewayID: "gw")
    #expect(compacted.disposition == .compacted)
    #expect(compacted.current.version.mutationRevision == 2)
    #expect(compacted.current.projection.anchor.conversation.title == "Canonical repair")

    let staleValue = v2Bootstrap(
      from: compactedValue,
      title: "Future metadata on stale sequence",
      revision: compactedValue.conversation.revision + 1,
      v2ThroughSeq: first.v2ThroughSeq - 1
    )
    let stale = try await store.replaceV2Bootstrap(staleValue, gatewayID: "gw")
    #expect(stale.disposition == .stale)
    #expect(stale.current.version == compacted.current.version)
    #expect(stale.current.projection.anchor.conversation.title == "Canonical repair")

    let caughtUp = try await store.replaceV2Bootstrap(
      v2Bootstrap(from: staleValue, v2ThroughSeq: first.v2ThroughSeq),
      gatewayID: "gw"
    )
    #expect(caughtUp.disposition == .compacted)
    #expect(caughtUp.current.projection.anchor.conversation.title == "Future metadata on stale sequence")

    let advancedValue = v2Bootstrap(
      from: compactedValue,
      v2ThroughSeq: first.v2ThroughSeq + 4,
      queueRevision: compactedValue.queueRevision + 1
    )
    let advanced = try await store.replaceV2Bootstrap(advancedValue, gatewayID: "gw")
    #expect(advanced.disposition == .advanced)
    #expect(advanced.current.version.committedV2Seq == first.v2ThroughSeq + 4)
    #expect(advanced.current.version.mutationRevision == 4)
    #expect(
      advanced.current.projection.anchor.conversation.title
        == "Future metadata on stale sequence"
    )
  }

  @Test("v2 message origin participates in exact bootstrap repair and round trips")
  func v2MessageOriginRoundTripAndEquality() async throws {
    let store = try PersistenceStore.inMemory()
    let fixture = try v2BootstrapFixture()
    let firstMessage = fixture.messages[0]
    let messageWithOrigin = v2Message(
      from: firstMessage,
      origin: MessageOrigin.parent.rawValue
    )
    let bootstrap = v2Bootstrap(
      from: fixture,
      messages: [messageWithOrigin] + Array(fixture.messages.dropFirst())
    )
    let installed = try await store.replaceV2Bootstrap(bootstrap, gatewayID: "gw")
    #expect(
      installed.current.projection.anchor.messages.first?.origin
        == MessageOrigin.parent.rawValue
    )

    var conflictingV1 = messageWithOrigin.v1Projection
    conflictingV1.origin = MessageOrigin.notification.rawValue
    try await store.mergeMessages(
      [conflictingV1],
      gatewayID: "gw",
      conversationID: bootstrap.conversation.id
    )
    #expect(
      try await store.messages(
        gatewayID: "gw",
        conversationID: bootstrap.conversation.id
      ).first?.origin == MessageOrigin.notification.rawValue
    )

    let repaired = try await store.replaceV2Bootstrap(bootstrap, gatewayID: "gw")
    #expect(repaired.disposition == .compacted)
    #expect(
      repaired.current.projection.anchor.messages.first?.origin
        == MessageOrigin.parent.rawValue
    )

    let unchanged = try await store.replaceV2Bootstrap(bootstrap, gatewayID: "gw")
    #expect(unchanged.disposition == .unchanged)
    #expect(unchanged.current == repaired.current)
  }

  @Test("v2 frame commit is compare-and-swap and preserves canonical bytes")
  func v2FrameCommitCAS() async throws {
    let store = try PersistenceStore.inMemory()
    let bootstrap = try v2BootstrapFixture()
    let installed = try await store.replaceV2Bootstrap(bootstrap, gatewayID: "gw")
    let frame = v2QueueFrame(
      conversationID: bootstrap.conversation.id,
      sequence: bootstrap.v2ThroughSeq + 1,
      queueRevision: bootstrap.queueRevision + 1
    )

    let committed = try await store.commitV2Frame(
      frame,
      gatewayID: "gw",
      expected: installed.current.version
    )
    let committedProjection = committed.currentProjection
    #expect(committed.isCommitted)
    #expect(committedProjection.projection.appliedFrames == [frame])
    #expect(committedProjection.version.committedV2Seq == bootstrap.v2ThroughSeq + 1)
    #expect(committedProjection.version.mutationRevision == 2)

    let covered = try await store.commitV2Frame(
      frame,
      gatewayID: "gw",
      expected: installed.current.version
    )
    #expect(covered.isAlreadyCovered)
    #expect(covered.currentProjection == committedProjection)

    let conflicting = v2QueueFrame(
      id: "00000000-0000-4000-8000-000000000099",
      conversationID: bootstrap.conversation.id,
      sequence: bootstrap.v2ThroughSeq + 1,
      queueRevision: bootstrap.queueRevision + 1
    )
    await #expect(throws: PersistenceStoreError.conflictingV2Frame) {
      _ = try await store.commitV2Frame(
        conflicting,
        gatewayID: "gw",
        expected: installed.current.version
      )
    }
  }

  @Test("v2 frame commit rejects gaps regressions stale writers and durable-behind state")
  func v2FrameCommitGuards() async throws {
    let store = try PersistenceStore.inMemory()
    let bootstrap = try v2BootstrapFixture()
    let installed = try await store.replaceV2Bootstrap(bootstrap, gatewayID: "gw")

    await #expect(throws: PersistenceStoreError.nonContiguousV2Overlay) {
      _ = try await store.commitV2Frame(
        v2QueueFrame(
          conversationID: bootstrap.conversation.id,
          sequence: bootstrap.v2ThroughSeq + 2,
          queueRevision: bootstrap.queueRevision + 1
        ),
        gatewayID: "gw",
        expected: installed.current.version
      )
    }
    await #expect(throws: PersistenceStoreError.v2QueueRevisionRegression) {
      _ = try await store.commitV2Frame(
        v2QueueFrame(
          conversationID: bootstrap.conversation.id,
          sequence: bootstrap.v2ThroughSeq + 1,
          queueRevision: bootstrap.queueRevision - 1
        ),
        gatewayID: "gw",
        expected: installed.current.version
      )
    }

    let compacted = try await store.replaceV2Bootstrap(
      v2Bootstrap(
        from: bootstrap,
        title: "Compacted",
        revision: bootstrap.conversation.revision + 1
      ),
      gatewayID: "gw"
    )
    let staleWriter = try await store.commitV2Frame(
      v2QueueFrame(
        conversationID: bootstrap.conversation.id,
        sequence: bootstrap.v2ThroughSeq + 1,
        queueRevision: bootstrap.queueRevision + 1
      ),
      gatewayID: "gw",
      expected: installed.current.version
    )
    #expect(staleWriter.isStaleWriter)
    #expect(staleWriter.currentProjection == compacted.current)

    await #expect(throws: PersistenceStoreError.durableV2CursorBehind) {
      _ = try await store.commitV2Frame(
        v2QueueFrame(
          conversationID: bootstrap.conversation.id,
          sequence: bootstrap.v2ThroughSeq + 2,
          queueRevision: bootstrap.queueRevision + 1
        ),
        gatewayID: "gw",
        expected: .init(
          committedV2Seq: bootstrap.v2ThroughSeq + 1,
          mutationRevision: compacted.current.version.mutationRevision
        )
      )
    }
  }

  @Test("failed v2 bootstrap and frame saves leave the previous projection intact")
  func v2WritesRollback() async throws {
    let store = try PersistenceStore.inMemory()
    let bootstrap = try v2BootstrapFixture()
    let installed = try await store.replaceV2Bootstrap(bootstrap, gatewayID: "gw")

    await #expect(throws: PersistenceStoreTestError.save) {
      _ = try await store.replaceV2Bootstrap(
        v2Bootstrap(
          from: bootstrap,
          v2ThroughSeq: bootstrap.v2ThroughSeq + 2,
          queueRevision: bootstrap.queueRevision + 1
        ),
        gatewayID: "gw",
        saveChanges: { throw PersistenceStoreTestError.save }
      )
    }
    #expect(
      try await store.v2Projection(
        gatewayID: "gw",
        conversationID: bootstrap.conversation.id
      ) == installed.current
    )

    await #expect(throws: PersistenceStoreTestError.save) {
      _ = try await store.commitV2Frame(
        v2QueueFrame(
          conversationID: bootstrap.conversation.id,
          sequence: bootstrap.v2ThroughSeq + 1,
          queueRevision: bootstrap.queueRevision + 1
        ),
        gatewayID: "gw",
        expected: installed.current.version,
        saveChanges: { throw PersistenceStoreTestError.save }
      )
    }
    #expect(
      try await store.v2Projection(
        gatewayID: "gw",
        conversationID: bootstrap.conversation.id
      ) == installed.current
    )
  }

  @Test("v2 history pages retain delivery metadata without advancing replay")
  func v2HistoryPageMerge() async throws {
    let store = try PersistenceStore.inMemory()
    let fixture = try v2BootstrapFixture(nextCursor: "before-2")
    let bootstrap = v2Bootstrap(
      from: fixture,
      nextCursor: .some("before-2"),
      messages: [
        v2Message(from: fixture.messages[0], ordinal: 5),
        v2Message(from: fixture.messages[1], ordinal: 6),
      ]
    )
    let installed = try await store.replaceV2Bootstrap(bootstrap, gatewayID: "gw")
    let overlap = bootstrap.messages[0]
    let sourceAssistant = bootstrap.messages[1]
    let olderAssistant = MobileV2ConversationMessage(
      id: "00000000-0000-4000-8000-000000000092",
      conversationId: bootstrap.conversation.id,
      turnId: sourceAssistant.turnId,
      ordinal: 4,
      role: sourceAssistant.role,
      status: .completed,
      content: sourceAssistant.content,
      createdAt: sourceAssistant.createdAt,
      updatedAt: sourceAssistant.updatedAt,
      runId: sourceAssistant.runId,
      segmentIndex: 2,
      deliveryKind: .normal,
      deliveryStatus: .delivered
    )
    let olderSteer = v2Message(
      id: "00000000-0000-4000-8000-000000000091",
      conversationID: bootstrap.conversation.id,
      ordinal: 3,
      segmentIndex: 1,
      deliveryKind: .steer
    )
    let firstPage = MobileV2ConversationMessagePage(
      items: [olderAssistant, overlap],
      nextCursor: "before-1",
      throughSeq: bootstrap.v2ThroughSeq + 50
    )

    let firstMerge = try await store.mergeV2MessagePage(
      firstPage,
      gatewayID: "gw",
      conversationID: bootstrap.conversation.id,
      expectedBefore: "before-2"
    )
    let secondPage = MobileV2ConversationMessagePage(
      items: [olderSteer, olderAssistant],
      nextCursor: nil,
      throughSeq: bootstrap.v2ThroughSeq + 100
    )
    let secondMerge = try await store.mergeV2MessagePage(
      secondPage,
      gatewayID: "gw",
      conversationID: bootstrap.conversation.id,
      expectedBefore: "before-1"
    )
    let projection = try #require(
      try await store.v2Projection(
        gatewayID: "gw",
        conversationID: bootstrap.conversation.id
      )
    )

    #expect(firstMerge.messages.map(\.id) == [olderAssistant.id, overlap.id])
    #expect(firstMerge.deliveryByMessageID[olderAssistant.id]?.segmentIndex == 2)
    #expect(secondMerge.messages.map(\.id) == [olderSteer.id, olderAssistant.id])
    #expect(secondMerge.deliveryByMessageID[olderSteer.id]?.kind == .steer)
    #expect(secondMerge.deliveryByMessageID[olderSteer.id]?.segmentIndex == 1)
    #expect(projection.projection.anchor.messages.map(\.id).contains(olderSteer.id))
    #expect(projection.projection.anchor.messages.map(\.id).contains(olderAssistant.id))
    #expect(projection.version.committedV2Seq == bootstrap.v2ThroughSeq)
    #expect(projection.projection.anchor.nextCursor == nil)

    let staleWriter = try await store.commitV2Frame(
      v2QueueFrame(
        conversationID: bootstrap.conversation.id,
        sequence: bootstrap.v2ThroughSeq + 1,
        queueRevision: bootstrap.queueRevision + 1
      ),
      gatewayID: "gw",
      expected: installed.current.version
    )
    #expect(staleWriter.isStaleWriter)
    #expect(staleWriter.currentProjection == projection)

    let repeatedBootstrap = try await store.replaceV2Bootstrap(bootstrap, gatewayID: "gw")
    #expect(repeatedBootstrap.disposition == .unchanged)
    #expect(repeatedBootstrap.current == projection)
    #expect(repeatedBootstrap.current.projection.anchor.nextCursor == nil)

    let advancedBootstrap = v2Bootstrap(
      from: bootstrap,
      v2ThroughSeq: bootstrap.v2ThroughSeq + 1,
      nextCursor: .some("advanced-before"),
      messages: [
        v2Message(
          from: bootstrap.messages[0],
          id: "00000000-0000-4000-8000-000000000094",
          ordinal: 10
        ),
        v2Message(
          from: bootstrap.messages[1],
          id: "00000000-0000-4000-8000-000000000095",
          ordinal: 11
        ),
      ]
    )
    let advanced = try await store.replaceV2Bootstrap(advancedBootstrap, gatewayID: "gw")
    #expect(advanced.disposition == .advanced)
    #expect(advanced.current.projection.anchor.nextCursor == "advanced-before")
    let gapPage = try await store.mergeV2MessagePage(
      MobileV2ConversationMessagePage(
        items: [
          v2Message(
            id: "00000000-0000-4000-8000-000000000096",
            conversationID: bootstrap.conversation.id,
            ordinal: 9,
            segmentIndex: 3,
            deliveryKind: .followUp
          )
        ],
        nextCursor: nil,
        throughSeq: advancedBootstrap.v2ThroughSeq
      ),
      gatewayID: "gw",
      conversationID: bootstrap.conversation.id,
      expectedBefore: "advanced-before"
    )
    #expect(gapPage.messages.map(\.id) == ["00000000-0000-4000-8000-000000000096"])
  }

  @Test("v2 history enriches newer legacy rows without regressing their base payload")
  func v2HistoryPageEnrichesNewerLegacyRows() async throws {
    let store = try PersistenceStore.inMemory()
    let bootstrap = try v2BootstrapFixture(nextCursor: "before-bad")
    _ = try await store.replaceV2Bootstrap(bootstrap, gatewayID: "gw")
    let legacyID = "00000000-0000-4000-8000-000000000093"
    try await store.mergeMessages(
      [
        message(
          id: legacyID,
          updatedOffset: 1_000,
          origin: MessageOrigin.parent.rawValue
        )
      ],
      gatewayID: "gw",
      conversationID: bootstrap.conversation.id
    )
    let before = try #require(
      try await store.v2Projection(
        gatewayID: "gw",
        conversationID: bootstrap.conversation.id
      )
    )
    let olderWireValue = v2Message(
      id: legacyID,
      conversationID: bootstrap.conversation.id,
      ordinal: 1,
      segmentIndex: 1,
      deliveryKind: .steer
    )

    let merged = try await store.mergeV2MessagePage(
      MobileV2ConversationMessagePage(
        items: [olderWireValue],
        nextCursor: nil,
        throughSeq: bootstrap.v2ThroughSeq + 10
      ),
      gatewayID: "gw",
      conversationID: bootstrap.conversation.id,
      expectedBefore: "before-bad"
    )
    let after = try #require(
      try await store.v2Projection(
        gatewayID: "gw",
        conversationID: bootstrap.conversation.id
      )
    )

    #expect(merged.messages.count == 1)
    #expect(merged.messages[0].updatedAt == instant(1_000))
    #expect(merged.messages[0].content == .user(text: "Message 1", images: nil))
    #expect(merged.messages[0].origin == MessageOrigin.parent.rawValue)
    #expect(merged.deliveryByMessageID[legacyID]?.kind == .steer)
    #expect(merged.deliveryByMessageID[legacyID]?.segmentIndex == 1)
    #expect(after.projection.anchor.nextCursor == nil)
    #expect(after.version.committedV2Seq == before.version.committedV2Seq)
    #expect(after.version.mutationRevision == before.version.mutationRevision + 1)
  }

  @Test("v2 projection breaks equal message ordinals by stable message id")
  func v2ProjectionUsesStableMessageIDTieBreak() async throws {
    let store = try PersistenceStore.inMemory()
    let bootstrap = try v2BootstrapFixture(nextCursor: "same-ordinal")
    _ = try await store.replaceV2Bootstrap(bootstrap, gatewayID: "gw")
    let lowerID = "00000000-0000-4000-8000-000000000091"
    let higherID = "00000000-0000-4000-8000-000000000092"
    let lowerIDWithLaterTimestamp = v2Message(
      id: lowerID,
      conversationID: bootstrap.conversation.id,
      ordinal: 99,
      segmentIndex: 1,
      deliveryKind: .normal,
      createdAt: instant(20)
    )
    let higherIDWithEarlierTimestamp = v2Message(
      id: higherID,
      conversationID: bootstrap.conversation.id,
      ordinal: 99,
      segmentIndex: 2,
      deliveryKind: .normal,
      createdAt: instant(10)
    )

    _ = try await store.mergeV2MessagePage(
      MobileV2ConversationMessagePage(
        items: [higherIDWithEarlierTimestamp, lowerIDWithLaterTimestamp],
        nextCursor: nil,
        throughSeq: bootstrap.v2ThroughSeq
      ),
      gatewayID: "gw",
      conversationID: bootstrap.conversation.id,
      expectedBefore: "same-ordinal"
    )
    let projection = try #require(
      try await store.v2Projection(
        gatewayID: "gw",
        conversationID: bootstrap.conversation.id
      )
    )

    #expect(
      projection.projection.anchor.messages
        .filter { $0.id == lowerID || $0.id == higherID }
        .map(\.id) == [lowerID, higherID]
    )
  }

  @Test("v2 admission acknowledgement clears only the exact submitted draft revision")
  func v2AdmissionAcknowledgement() async throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appendingPathComponent("cache.store")
    let bootstrap = try v2BootstrapFixture()
    let draft = ConversationDraft(
      text: "Follow up",
      attachments: [],
      updatedAt: instant(100),
      revision: 7
    )
    let admission = PendingV2Admission(
      commandID: "00000000-0000-4000-8000-000000000081",
      inputID: "00000000-0000-4000-8000-000000000082",
      behavior: .followUp,
      expectedActiveTurnID: nil,
      text: draft.text,
      images: [],
      draftRevision: draft.revision
    )
    do {
      let store = try PersistenceStore.stored(at: url)
      _ = try await store.replaceV2Bootstrap(bootstrap, gatewayID: "gw")
      try await store.saveDraft(
        draft,
        gatewayID: "gw",
        conversationID: bootstrap.conversation.id
      )
      try await store.stageV2Admission(
        admission,
        gatewayID: "gw",
        conversationID: bootstrap.conversation.id
      )
    }

    do {
      let reopened = try PersistenceStore.stored(at: url)
      #expect(
        try await reopened.pendingV2Admission(
          gatewayID: "gw",
          conversationID: bootstrap.conversation.id
        ) == admission
      )
      let retained = try await reopened.acknowledgeV2Admission(
        commandID: admission.commandID,
        inputID: admission.inputID,
        gatewayID: "gw",
        conversationID: bootstrap.conversation.id
      )
      #expect(retained == nil)
      #expect(
        try await reopened.pendingV2Admission(
          gatewayID: "gw",
          conversationID: bootstrap.conversation.id
        ) == nil
      )
      #expect(
        try await reopened.draft(
          gatewayID: "gw",
          conversationID: bootstrap.conversation.id
        ) == nil
      )
    }
  }

  @Test("v2 admission acknowledgement preserves newer typing and rejects the wrong command")
  func v2AdmissionPreservesNewerDraft() async throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appendingPathComponent("cache.store")
    let bootstrap = try v2BootstrapFixture()
    let submittedAttachment = PreparedAttachment(
      id: UUID(uuidString: "018f0f4a-5c42-7a8b-9c01-1234567890ab")!,
      mediaType: "image/png",
      data: Data([0x01, 0x02])
    )
    let admission = PendingV2Admission(
      commandID: "00000000-0000-4000-8000-000000000081",
      inputID: "00000000-0000-4000-8000-000000000082",
      behavior: .steer,
      expectedActiveTurnID: bootstrap.conversation.activeTurnId,
      text: "Original",
      images: [
        MessageImage(mediaType: .png, data: submittedAttachment.data.base64EncodedString())
      ],
      draftRevision: 2
    )
    let newerAttachment = PreparedAttachment(
      id: UUID(uuidString: "018f0f4a-5c42-7a8b-9c01-1234567890ac")!,
      mediaType: "image/webp",
      data: Data([0x03, 0x04])
    )
    let newer = ConversationDraft(
      text: "New typing",
      attachments: [newerAttachment],
      updatedAt: instant(101),
      revision: 3
    )
    do {
      let store = try PersistenceStore.stored(at: url)
      _ = try await store.replaceV2Bootstrap(bootstrap, gatewayID: "gw")
      try await store.saveDraft(
        .init(
          text: "Original",
          attachments: [submittedAttachment],
          updatedAt: instant(100),
          revision: 2
        ),
        gatewayID: "gw",
        conversationID: bootstrap.conversation.id
      )
      try await store.stageV2Admission(
        admission,
        gatewayID: "gw",
        conversationID: bootstrap.conversation.id
      )
      try await store.saveDraft(
        newer,
        gatewayID: "gw",
        conversationID: bootstrap.conversation.id
      )
    }

    do {
      let reopened = try PersistenceStore.stored(at: url)
      let wrong = try await reopened.acknowledgeV2Admission(
        commandID: "00000000-0000-4000-8000-000000000089",
        inputID: admission.inputID,
        gatewayID: "gw",
        conversationID: bootstrap.conversation.id
      )
      #expect(wrong == newer)
      #expect(
        try await reopened.pendingV2Admission(
          gatewayID: "gw",
          conversationID: bootstrap.conversation.id
        ) == admission
      )

      let retained = try await reopened.acknowledgeV2Admission(
        commandID: admission.commandID,
        inputID: admission.inputID,
        gatewayID: "gw",
        conversationID: bootstrap.conversation.id
      )
      #expect(retained == newer)
      #expect(
        try await reopened.draft(
          gatewayID: "gw",
          conversationID: bootstrap.conversation.id
        ) == newer
      )
    }
  }

  @Test("frame-first and bootstrap-first races converge without replay duplication")
  func v2FrameBootstrapRaces() async throws {
    let bootstrap = try v2BootstrapFixture()
    let frame = v2QueueFrame(
      conversationID: bootstrap.conversation.id,
      sequence: bootstrap.v2ThroughSeq + 1,
      queueRevision: bootstrap.queueRevision + 1
    )
    let coveringBootstrap = v2Bootstrap(
      from: bootstrap,
      v2ThroughSeq: bootstrap.v2ThroughSeq + 1,
      queueRevision: bootstrap.queueRevision + 1,
      queuePaused: true
    )

    let frameFirst = try PersistenceStore.inMemory()
    let frameFirstAnchor = try await frameFirst.replaceV2Bootstrap(bootstrap, gatewayID: "gw")
    _ = try await frameFirst.commitV2Frame(
      frame,
      gatewayID: "gw",
      expected: frameFirstAnchor.current.version
    )
    let compacted = try await frameFirst.replaceV2Bootstrap(
      coveringBootstrap,
      gatewayID: "gw"
    )
    #expect(compacted.disposition == .compacted)
    #expect(compacted.current.projection.appliedFrames.isEmpty)
    #expect(compacted.current.projection.anchor.v2ThroughSeq == frame.v2Seq)

    let bootstrapFirst = try PersistenceStore.inMemory()
    let advanced = try await bootstrapFirst.replaceV2Bootstrap(
      coveringBootstrap,
      gatewayID: "gw"
    )
    let covered = try await bootstrapFirst.commitV2Frame(
      frame,
      gatewayID: "gw",
      expected: advanced.current.version
    )
    #expect(covered.isAlreadyCovered)
    #expect(covered.currentProjection == advanced.current)
  }

  @Test("invalid v2 bootstraps mutate nothing")
  func invalidV2BootstrapValidation() async throws {
    let store = try PersistenceStore.inMemory()
    let valid = try v2BootstrapFixture()
    let installed = try await store.replaceV2Bootstrap(valid, gatewayID: "gw")
    let invalidValues = [
      v2Bootstrap(
        from: valid,
        messages: [
          v2Message(from: valid.messages[0], conversationID: "00000000-0000-4000-8000-000000000099")
        ]
      ),
      v2Bootstrap(from: valid, messages: [valid.messages[0], valid.messages[0]]),
      v2Bootstrap(from: valid, summaryQueueRevision: valid.queueRevision + 1),
      v2Bootstrap(from: valid, pendingInputs: Array(valid.pendingInputs.reversed())),
      v2Bootstrap(
        from: valid,
        pendingFollowUpCount: valid.conversation.pendingFollowUpCount + 1
      ),
      v2Bootstrap(from: valid, title: "Contradiction"),
      v2Bootstrap(
        from: valid,
        revision: valid.conversation.revision + 1,
        status: .deleted
      ),
    ]

    for invalid in invalidValues {
      await #expect(throws: PersistenceStoreError.invalidV2Bootstrap) {
        _ = try await store.replaceV2Bootstrap(invalid, gatewayID: "gw")
      }
      #expect(
        try await store.v2Projection(
          gatewayID: "gw",
          conversationID: valid.conversation.id
        ) == installed.current
      )
    }
  }

  @Test("v2 stable IDs cannot move between conversations or staged admissions")
  func v2StableIDOwnershipIsConversationScoped() async throws {
    let store = try PersistenceStore.inMemory()
    let first = try v2BootstrapFixture()
    let secondConversationID = "00000000-0000-4000-8000-000000000002"
    let secondMessages = [
      v2Message(
        from: first.messages[0],
        conversationID: secondConversationID,
        id: "00000000-0000-4000-8000-000000000113"
      ),
      v2Message(
        from: first.messages[1],
        conversationID: secondConversationID,
        id: "00000000-0000-4000-8000-000000000114"
      ),
    ]
    let secondInputs = zip(
      first.pendingInputs,
      [
        "00000000-0000-4000-8000-000000000122",
        "00000000-0000-4000-8000-000000000124",
        "00000000-0000-4000-8000-000000000128",
      ]
    ).map { v2PendingInput(from: $0.0, inputID: $0.1) }
    let second = v2Bootstrap(
      from: first,
      conversationID: secondConversationID,
      title: "Second conversation",
      nextCursor: .some("second-before"),
      messages: secondMessages,
      pendingInputs: secondInputs
    )
    _ = try await store.replaceV2Bootstrap(first, gatewayID: "gw")
    _ = try await store.replaceV2Bootstrap(second, gatewayID: "gw")
    let firstBefore = try #require(
      try await store.v2Projection(gatewayID: "gw", conversationID: first.conversation.id)
    )
    let secondBefore = try #require(
      try await store.v2Projection(gatewayID: "gw", conversationID: second.conversation.id)
    )

    let messageCollision = v2Bootstrap(
      from: second,
      messages: [
        v2Message(from: second.messages[0], id: first.messages[0].id),
        second.messages[1],
      ]
    )
    var collidingInputs = second.pendingInputs
    collidingInputs[0] = v2PendingInput(
      from: collidingInputs[0],
      inputID: first.pendingInputs[0].inputId
    )
    let inputCollision = v2Bootstrap(from: second, pendingInputs: collidingInputs)
    for collision in [messageCollision, inputCollision] {
      await #expect(throws: PersistenceStoreError.invalidV2Bootstrap) {
        _ = try await store.replaceV2Bootstrap(collision, gatewayID: "gw")
      }
    }
    await #expect(throws: PersistenceStoreError.invalidV2Bootstrap) {
      _ = try await store.mergeV2MessagePage(
        MobileV2ConversationMessagePage(
          items: [
            v2Message(
              from: second.messages[0],
              id: first.messages[0].id,
              ordinal: second.messages[0].ordinal - 1
            )
          ],
          nextCursor: nil,
          throughSeq: second.v2ThroughSeq
        ),
        gatewayID: "gw",
        conversationID: second.conversation.id,
        expectedBefore: "second-before"
      )
    }

    let firstAdmission = PendingV2Admission(
      commandID: "00000000-0000-4000-8000-000000000181",
      inputID: "00000000-0000-4000-8000-000000000182",
      behavior: .followUp,
      expectedActiveTurnID: nil,
      text: "First admission",
      images: [],
      draftRevision: 1
    )
    try await store.stageV2Admission(
      firstAdmission,
      gatewayID: "gw",
      conversationID: first.conversation.id
    )
    let admissionCollisions = [
      PendingV2Admission(
        commandID: firstAdmission.commandID,
        inputID: "00000000-0000-4000-8000-000000000183",
        behavior: .followUp,
        expectedActiveTurnID: nil,
        text: "Command collision",
        images: [],
        draftRevision: 1
      ),
      PendingV2Admission(
        commandID: "00000000-0000-4000-8000-000000000184",
        inputID: firstAdmission.inputID,
        behavior: .followUp,
        expectedActiveTurnID: nil,
        text: "Input collision",
        images: [],
        draftRevision: 1
      ),
      PendingV2Admission(
        commandID: "00000000-0000-4000-8000-000000000185",
        inputID: second.pendingInputs[0].inputId,
        behavior: .followUp,
        expectedActiveTurnID: nil,
        text: "Canonical input collision",
        images: [],
        draftRevision: 1
      ),
    ]
    for collision in admissionCollisions {
      await #expect(throws: PersistenceStoreError.conflictingV2Admission) {
        try await store.stageV2Admission(
          collision,
          gatewayID: "gw",
          conversationID: second.conversation.id
        )
      }
    }

    #expect(
      try await store.v2Projection(
        gatewayID: "gw",
        conversationID: first.conversation.id
      ) == firstBefore
    )
    #expect(
      try await store.v2Projection(
        gatewayID: "gw",
        conversationID: second.conversation.id
      ) == secondBefore
    )
    #expect(
      try await store.pendingV2Admission(
        gatewayID: "gw",
        conversationID: first.conversation.id
      ) == firstAdmission
    )
    #expect(
      try await store.pendingV2Admission(
        gatewayID: "gw",
        conversationID: second.conversation.id
      ) == nil
    )
  }

  @Test("v2 tombstone preserves recovery admission but purges canonical projection")
  func v2TombstoneRecoveryBoundary() async throws {
    let store = try PersistenceStore.inMemory()
    let bootstrap = try v2BootstrapFixture()
    let installed = try await store.replaceV2Bootstrap(bootstrap, gatewayID: "gw")
    _ = try await store.commitV2Frame(
      v2QueueFrame(
        conversationID: bootstrap.conversation.id,
        sequence: bootstrap.v2ThroughSeq + 1,
        queueRevision: bootstrap.queueRevision + 1
      ),
      gatewayID: "gw",
      expected: installed.current.version
    )
    let draft = ConversationDraft(
      text: "Recover me",
      attachments: [],
      updatedAt: instant(100),
      revision: 4
    )
    let admission = PendingV2Admission(
      commandID: "00000000-0000-4000-8000-000000000081",
      inputID: "00000000-0000-4000-8000-000000000082",
      behavior: .followUp,
      expectedActiveTurnID: nil,
      text: draft.text,
      images: [],
      draftRevision: draft.revision
    )
    try await store.saveDraft(
      draft,
      gatewayID: "gw",
      conversationID: bootstrap.conversation.id
    )
    try await store.stageV2Admission(
      admission,
      gatewayID: "gw",
      conversationID: bootstrap.conversation.id
    )
    try await store.applyTombstone(v2Tombstone(from: bootstrap), gatewayID: "gw")

    #expect(
      try await store.v2Projection(
        gatewayID: "gw",
        conversationID: bootstrap.conversation.id
      ) == nil
    )
    #expect(
      try await store.v2Cursor(
        gatewayID: "gw",
        conversationID: bootstrap.conversation.id
      ) == 0
    )
    #expect(
      try await store.pendingV2Admission(
        gatewayID: "gw",
        conversationID: bootstrap.conversation.id
      ) == admission
    )
    #expect(
      try await store.draft(
        gatewayID: "gw",
        conversationID: bootstrap.conversation.id
      ) == draft
    )
    await #expect(throws: PersistenceStoreError.conversationDeleted(
      gatewayID: "gw",
      conversationID: bootstrap.conversation.id
    )) {
      _ = try await store.acknowledgeV2Admission(
        commandID: admission.commandID,
        inputID: admission.inputID,
        gatewayID: "gw",
        conversationID: bootstrap.conversation.id
      )
    }

    try await store.clearGateway(gatewayID: "gw")
    #expect(
      try await store.pendingV2Admission(
        gatewayID: "gw",
        conversationID: bootstrap.conversation.id
      ) == nil
    )
    #expect(
      try await store.draft(
        gatewayID: "gw",
        conversationID: bootstrap.conversation.id
      ) == nil
    )
  }

  @Test("tombstoned v2 admission survives restart and exact discard is atomic")
  func recoverableV2AdmissionRestartAndDiscard() async throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appendingPathComponent("cache.store")
    let bootstrap = try v2BootstrapFixture()
    let draft = ConversationDraft(
      text: "Recover the accepted draft",
      attachments: [],
      updatedAt: instant(100),
      revision: 9
    )
    let admission = PendingV2Admission(
      commandID: "00000000-0000-4000-8000-000000000281",
      inputID: "00000000-0000-4000-8000-000000000282",
      behavior: .followUp,
      expectedActiveTurnID: nil,
      text: draft.text,
      images: [],
      draftRevision: draft.revision
    )
    do {
      let store = try PersistenceStore.stored(at: url)
      _ = try await store.replaceV2Bootstrap(bootstrap, gatewayID: "gw")
      try await store.saveDraft(
        draft,
        gatewayID: "gw",
        conversationID: bootstrap.conversation.id
      )
      try await store.stageV2Admission(
        admission,
        gatewayID: "gw",
        conversationID: bootstrap.conversation.id
      )
      try await store.applyTombstone(v2Tombstone(from: bootstrap), gatewayID: "gw")
    }

    let reopened = try PersistenceStore.stored(at: url)
    let recovery = try #require(
      try await reopened.recoverableV2Admissions(gatewayID: "gw").first
    )
    #expect(recovery.commandID == admission.commandID)
    #expect(recovery.inputID == admission.inputID)
    #expect(recovery.admission == admission)
    #expect(recovery.payloadIssue == nil)
    #expect(recovery.coexistingDraft == draft)
    #expect(recovery.conversationAvailable == false)
    #expect(
      try await reopened.discardV2Admission(
        gatewayID: "gw",
        conversationID: bootstrap.conversation.id,
        commandID: admission.commandID,
        inputID: "00000000-0000-4000-8000-000000000289",
        expectedConversationAvailable: false
      ) == false
    )
    #expect(
      try await reopened.discardV2Admission(
        gatewayID: "gw",
        conversationID: bootstrap.conversation.id,
        commandID: admission.commandID,
        inputID: admission.inputID,
        expectedConversationAvailable: true
      ) == false
    )
    await #expect(throws: PersistenceStoreTestError.save) {
      _ = try await reopened.discardV2Admission(
        gatewayID: "gw",
        conversationID: bootstrap.conversation.id,
        commandID: admission.commandID,
        inputID: admission.inputID,
        expectedConversationAvailable: false,
        saveChanges: { throw PersistenceStoreTestError.save }
      )
    }
    #expect(try await reopened.recoverableV2Admissions(gatewayID: "gw").count == 1)
    #expect(
      try await reopened.draft(
        gatewayID: "gw",
        conversationID: bootstrap.conversation.id
      ) == draft
    )
    #expect(
      try await reopened.discardV2Admission(
        gatewayID: "gw",
        conversationID: bootstrap.conversation.id,
        commandID: admission.commandID,
        inputID: admission.inputID,
        expectedConversationAvailable: false
      )
    )
    #expect(try await reopened.recoverableV2Admissions(gatewayID: "gw").isEmpty)
    #expect(
      try await reopened.draft(
        gatewayID: "gw",
        conversationID: bootstrap.conversation.id
      ) == nil
    )
  }

  @Test("one corrupt v2 admission does not hide a recoverable sibling")
  func corruptRecoverableV2AdmissionIsIsolated() async throws {
    let store = try PersistenceStore.inMemory()
    let firstConversationID = "recovery-a"
    let secondConversationID = "recovery-b"
    try await store.upsertConversations(
      [
        summary(id: firstConversationID, title: "First"),
        summary(id: secondConversationID, title: "Second"),
      ],
      gatewayID: "gw"
    )
    let first = PendingV2Admission(
      commandID: "00000000-0000-4000-8000-000000000291",
      inputID: "00000000-0000-4000-8000-000000000292",
      behavior: .followUp,
      expectedActiveTurnID: nil,
      text: "First",
      images: [],
      draftRevision: 1
    )
    let second = PendingV2Admission(
      commandID: "00000000-0000-4000-8000-000000000293",
      inputID: "00000000-0000-4000-8000-000000000294",
      behavior: .followUp,
      expectedActiveTurnID: nil,
      text: "Second",
      images: [],
      draftRevision: 1
    )
    try await store.stageV2Admission(first, gatewayID: "gw", conversationID: firstConversationID)
    try await store.stageV2Admission(second, gatewayID: "gw", conversationID: secondConversationID)
    try await store.applyTombstone(
      summary(
        id: firstConversationID,
        title: "First",
        revision: 2,
        status: .deleted,
        deletedAt: instant(2)
      ),
      gatewayID: "gw"
    )
    try await store.applyTombstone(
      summary(
        id: secondConversationID,
        title: "Second",
        revision: 2,
        status: .deleted,
        deletedAt: instant(2)
      ),
      gatewayID: "gw"
    )
    let firstPayload = try ContractCoding.encoder().encode(first)
    let recoveries = try await store.recoverableV2Admissions(
      gatewayID: "gw",
      decodeAdmission: { data in
        if data == firstPayload { throw PersistenceStoreTestError.decode }
        return try ContractCoding.decoder().decode(PendingV2Admission.self, from: data)
      }
    )

    #expect(recoveries.count == 2)
    let corrupt = try #require(recoveries.first { $0.commandID == first.commandID })
    let healthy = try #require(recoveries.first { $0.commandID == second.commandID })
    #expect(corrupt.admission == nil)
    #expect(corrupt.payloadIssue == .unreadableStoredPayload)
    #expect(healthy.admission == second)
    #expect(healthy.payloadIssue == nil)
  }

  @Test("active v2 admission with corrupt draft remains recoverable and discard sanitizes it")
  func activeV2AdmissionDiscardSanitizesCorruptDraft() async throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appendingPathComponent("cache.store")
    let bootstrap = try v2BootstrapFixture()
    let draft = ConversationDraft(
      text: "  Preserve this exact newer draft\n",
      attachments: [
        PreparedAttachment(
          id: UUID(uuidString: "018f0f4a-5c42-7a8b-9c01-1234567890ad")!,
          mediaType: "image/png",
          data: Data([0x01])
        )
      ],
      updatedAt: instant(100),
      revision: 11
    )
    let admission = PendingV2Admission(
      commandID: "00000000-0000-4000-8000-000000000381",
      inputID: "00000000-0000-4000-8000-000000000382",
      behavior: .followUp,
      expectedActiveTurnID: nil,
      text: draft.text,
      images: [],
      draftRevision: draft.revision
    )
    do {
      let store = try PersistenceStore.stored(at: url)
      _ = try await store.replaceV2Bootstrap(bootstrap, gatewayID: "gw")
      try await store.saveDraft(
        draft,
        gatewayID: "gw",
        conversationID: bootstrap.conversation.id,
        encodeAttachments: { _ in Data("corrupt-draft-attachments".utf8) }
      )
      try await store.stageV2Admission(
        admission,
        gatewayID: "gw",
        conversationID: bootstrap.conversation.id
      )
    }

    let recoveryStore = try PersistenceStore.stored(at: url)
    let recovery = try #require(
      try await recoveryStore.recoverableV2Admissions(gatewayID: "gw").first
    )
    #expect(recovery.admission == admission)
    #expect(recovery.payloadIssue == nil)
    #expect(recovery.coexistingDraft?.text == draft.text)
    #expect(recovery.coexistingDraft?.attachments.isEmpty == true)
    #expect(recovery.coexistingDraftAttachmentIssue == .unreadableStoredPayload)
    #expect(recovery.conversationAvailable)

    await #expect(throws: DecodingError.self) {
      _ = try await recoveryStore.acknowledgeV2Admission(
        commandID: admission.commandID,
        inputID: admission.inputID,
        gatewayID: "gw",
        conversationID: bootstrap.conversation.id
      )
    }
    #expect(
      try await recoveryStore.pendingV2Admission(
        gatewayID: "gw",
        conversationID: bootstrap.conversation.id
      ) == admission
    )
    #expect(
      try await recoveryStore.discardV2Admission(
        gatewayID: "gw",
        conversationID: bootstrap.conversation.id,
        commandID: admission.commandID,
        inputID: admission.inputID,
        expectedConversationAvailable: true
      )
    )

    let reopenedStore = try PersistenceStore.stored(at: url)
    #expect(
      try await reopenedStore.draft(
        gatewayID: "gw",
        conversationID: bootstrap.conversation.id
      ) == ConversationDraft(
        text: draft.text,
        attachments: [],
        updatedAt: draft.updatedAt,
        revision: draft.revision
      )
    )
    #expect(
      try await reopenedStore.pendingV2Admission(
        gatewayID: "gw",
        conversationID: bootstrap.conversation.id
      ) == nil
    )
    #expect(try await reopenedStore.recoverableV2Admissions(gatewayID: "gw").isEmpty)
  }

  @Test("on-disk v2 projection restores anchor history overlay and cursor")
  func v2ProjectionReopensFromDisk() async throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appendingPathComponent("cache.store")
    let bootstrap = try v2BootstrapFixture(nextCursor: "before-1")
    let frame = v2QueueFrame(
      conversationID: bootstrap.conversation.id,
      sequence: bootstrap.v2ThroughSeq + 1,
      queueRevision: bootstrap.queueRevision + 1
    )
    let expected: VersionedV2ConversationProjection
    do {
      let store = try PersistenceStore.stored(at: url)
      let installed = try await store.replaceV2Bootstrap(bootstrap, gatewayID: "gw")
      _ = try await store.mergeV2MessagePage(
        MobileV2ConversationMessagePage(
          items: [
            v2Message(
              id: "00000000-0000-4000-8000-000000000091",
              conversationID: bootstrap.conversation.id,
              ordinal: 3,
              segmentIndex: 2,
              deliveryKind: .steer
            )
          ],
          nextCursor: nil,
          throughSeq: bootstrap.v2ThroughSeq
        ),
        gatewayID: "gw",
        conversationID: bootstrap.conversation.id,
        expectedBefore: "before-1"
      )
      let afterHistory = try #require(
        try await store.v2Projection(
          gatewayID: "gw",
          conversationID: bootstrap.conversation.id
        )
      )
      let committed = try await store.commitV2Frame(
        frame,
        gatewayID: "gw",
        expected: afterHistory.version
      )
      expected = committed.currentProjection
      #expect(expected.version.mutationRevision == installed.current.version.mutationRevision + 2)
    }

    do {
      let reopened = try PersistenceStore.stored(at: url)
      let restored = try #require(
        try await reopened.v2Projection(
          gatewayID: "gw",
          conversationID: bootstrap.conversation.id
        )
      )
      #expect(restored == expected)
      #expect(restored.projection.anchor.messages.count == bootstrap.messages.count + 1)
      #expect(restored.projection.appliedFrames == [frame])
    }
  }

  @Test("SwiftData schema property names contain no connection secret material")
  func secretFreeSchema() {
    let schema = PersistenceSchema.make()
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

  private func v2BootstrapFixture(nextCursor: String? = nil) throws
    -> MobileV2ConversationBootstrap
  {
    let fixture = try MobileV2FixtureLoader.decode(
      MobileV2ConversationBootstrap.self,
      "conversation-bootstrap.json"
    )
    return v2Bootstrap(from: fixture, nextCursor: nextCursor)
  }

  private func v2Bootstrap(
    from source: MobileV2ConversationBootstrap,
    conversationID: String? = nil,
    title: String? = nil,
    revision: Int? = nil,
    status: ConversationStatus? = nil,
    v2ThroughSeq: Int? = nil,
    queueRevision: Int? = nil,
    summaryQueueRevision: Int? = nil,
    queuePaused: Bool? = nil,
    pendingFollowUpCount: Int? = nil,
    nextCursor: String?? = nil,
    messages: [MobileV2ConversationMessage]? = nil,
    pendingInputs: [MobileV2PendingInput]? = nil
  ) -> MobileV2ConversationBootstrap {
    let sequence = v2ThroughSeq ?? source.v2ThroughSeq
    let queueRevision = queueRevision ?? source.queueRevision
    let queuePaused = queuePaused ?? source.queuePaused
    let summary = source.conversation
    let conversationID = conversationID ?? summary.id
    return MobileV2ConversationBootstrap(
      conversation: MobileV2ConversationSummary(
        id: conversationID,
        agentId: summary.agentId,
        agentName: summary.agentName,
        title: title ?? summary.title,
        revision: revision ?? summary.revision,
        status: status ?? summary.status,
        activeTurnId: summary.activeTurnId,
        owningIssueId: summary.owningIssueId,
        projectId: summary.projectId,
        lastSeq: summary.lastSeq,
        lastMessagePreview: summary.lastMessagePreview,
        createdAt: summary.createdAt,
        updatedAt: summary.updatedAt,
        deletedAt: summary.deletedAt,
        queuePaused: queuePaused,
        queueRevision: summaryQueueRevision ?? queueRevision,
        pendingFollowUpCount: pendingFollowUpCount ?? summary.pendingFollowUpCount,
        v2LastSeq: sequence
      ),
      messages: messages ?? source.messages,
      nextCursor: nextCursor ?? source.nextCursor,
      pendingInputs: pendingInputs ?? source.pendingInputs,
      queuePaused: queuePaused,
      queueRevision: queueRevision,
      v2ThroughSeq: sequence
    )
  }

  private func v2QueueFrame(
    id: String = "00000000-0000-4000-8000-000000000088",
    conversationID: String,
    sequence: Int,
    queueRevision: Int
  ) -> MobileV2SequencedFrame {
    .queuePaused(
      id: id,
      conversationId: conversationID,
      v2Seq: sequence,
      queueRevision: queueRevision,
      queuePaused: true,
      pendingFollowUpCount: 2
    )
  }

  private func v2PendingInput(
    from source: MobileV2PendingInput,
    inputID: String
  ) -> MobileV2PendingInput {
    MobileV2PendingInput(
      inputId: inputID,
      kind: source.kind,
      targetTurnId: source.targetTurnId,
      text: source.text,
      images: source.images,
      state: source.state,
      revision: source.revision,
      enqueueOrder: source.enqueueOrder,
      runId: source.runId,
      segmentTurnId: source.segmentTurnId,
      userMessageId: source.userMessageId,
      assistantMessageId: source.assistantMessageId,
      failureCode: source.failureCode,
      failureMessage: source.failureMessage,
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
      deliveredAt: source.deliveredAt
    )
  }

  private func v2Message(
    id: String,
    conversationID: String,
    ordinal: Int,
    segmentIndex: Int,
    deliveryKind: MobileV2DeliveryKind,
    createdAt: Date? = nil
  ) -> MobileV2ConversationMessage {
    let timestamp = createdAt ?? instant(1)
    return MobileV2ConversationMessage(
      id: id,
      conversationId: conversationID,
      turnId: "turn-01",
      ordinal: ordinal,
      role: .user,
      status: .completed,
      content: .user(text: "Older segment", images: nil),
      createdAt: timestamp,
      updatedAt: timestamp,
      runId: "turn-01",
      segmentIndex: segmentIndex,
      deliveryKind: deliveryKind,
      deliveryStatus: .delivered
    )
  }

  private func v2Tombstone(
    from bootstrap: MobileV2ConversationBootstrap
  ) -> ConversationSummaryDTO {
    let summary = bootstrap.conversation
    return ConversationSummaryDTO(
      id: summary.id,
      agentId: summary.agentId,
      agentName: summary.agentName,
      title: summary.title,
      revision: summary.revision + 1,
      status: .deleted,
      activeTurnId: nil,
      owningIssueId: summary.owningIssueId,
      projectId: summary.projectId,
      lastSeq: summary.lastSeq,
      lastMessagePreview: summary.lastMessagePreview,
      createdAt: summary.createdAt,
      updatedAt: instant(200),
      deletedAt: instant(200)
    )
  }

  private func v2Message(
    from source: MobileV2ConversationMessage,
    conversationID: String? = nil,
    id: String? = nil,
    ordinal: Int? = nil,
    origin: String? = nil
  ) -> MobileV2ConversationMessage {
    MobileV2ConversationMessage(
      id: id ?? source.id,
      conversationId: conversationID ?? source.conversationId,
      turnId: source.turnId,
      ordinal: ordinal ?? source.ordinal,
      role: source.role,
      status: source.status,
      content: source.content,
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
      runId: source.runId,
      segmentIndex: source.segmentIndex,
      deliveryKind: source.deliveryKind,
      deliveryStatus: source.deliveryStatus,
      origin: origin ?? source.origin
    )
  }

  @MainActor
  private func writeLegacyConversation(
    _ value: ConversationSummaryDTO,
    at url: URL
  ) throws {
    let schema = Schema([
      GatewayProfileRecord.self,
      ConversationRecord.self,
      MessageRecord.self,
      AgentRecord.self,
      DraftRecord.self,
      PendingSendRecord.self,
      ReplayCursorRecord.self,
    ])
    let container = try ModelContainer(
      for: schema,
      configurations: [
        ModelConfiguration(schema: schema, url: url, cloudKitDatabase: .none)
      ]
    )
    let context = ModelContext(container)
    context.insert(
      ConversationRecord(
        scopedID: "gw|\(value.id)",
        gatewayID: "gw",
        conversationID: value.id,
        agentID: value.agentId,
        agentName: value.agentName,
        title: value.title,
        revision: value.revision,
        statusRaw: value.status.rawValue,
        activeTurnID: value.activeTurnId,
        owningIssueID: value.owningIssueId,
        projectID: value.projectId,
        lastSeq: value.lastSeq,
        lastMessagePreview: value.lastMessagePreview,
        createdAt: value.createdAt,
        updatedAt: value.updatedAt,
        deletedAt: value.deletedAt
      )
    )
    try context.save()
  }

  private func summary(
    id: String,
    title: String,
    revision: Int = 1,
    status: ConversationStatus = .idle,
    activeTurnID: String? = nil,
    updatedAt: Date? = nil,
    deletedAt: Date? = nil
  ) -> ConversationSummaryDTO {
    ConversationSummaryDTO(
      id: id,
      agentId: "agent-1",
      agentName: "Agent One",
      title: title,
      revision: revision,
      status: status,
      activeTurnId: activeTurnID,
      owningIssueId: "issue-1",
      projectId: "project-1",
      lastSeq: revision,
      lastMessagePreview: "Preview \(revision)",
      createdAt: instant(0),
      updatedAt: updatedAt ?? instant(revision),
      deletedAt: deletedAt
    )
  }

  private func message(
    id: String,
    ordinal: Int = 1,
    text: String? = nil,
    updatedOffset: Int? = nil,
    origin: String? = nil
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
      updatedAt: instant(timestamp),
      origin: origin
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
      secure: true,
      mode: .lan,
      tlsCertificateSha256:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      createdAt: instant(0),
      lastSuccessfulSyncAt: nil
    )
  }

  private func instant(_ seconds: Int) -> Date {
    Date(timeIntervalSince1970: TimeInterval(seconds))
  }

  private func pendingPayload(_ result: PendingSendLoadResult) -> PendingChatSend? {
    switch result {
    case .none:
      nil
    case .resumable(let pending):
      pending
    case .recoveryRequired(let recovery):
      recovery.pendingSend
    }
  }
}

private final class RecoveryAttachmentDecodeCounter: @unchecked Sendable {
  private let lock = NSLock()
  private var value = 0

  var count: Int { lock.withLock { value } }

  func decode(_ data: Data) throws -> [PreparedAttachment] {
    lock.withLock { value += 1 }
    return try ContractCoding.decoder().decode([PreparedAttachment].self, from: data)
  }
}

private final class PendingAttachmentEncodeProbe: @unchecked Sendable {
  private let lock = NSLock()
  private var value = 0

  var count: Int { lock.withLock { value } }

  func encode(_ attachments: [PreparedAttachment]) throws -> Data {
    lock.withLock { value += 1 }
    return try ContractCoding.encoder().encode(attachments)
  }
}

private final class PendingAttachmentDecodeProbe: @unchecked Sendable {
  private let lock = NSLock()
  private var decodedValues: [Data] = []

  var values: [Data] { lock.withLock { decodedValues } }

  func decode(_ data: Data) throws -> [PreparedAttachment] {
    lock.withLock { decodedValues.append(data) }
    throw DecodingError.dataCorrupted(
      .init(codingPath: [], debugDescription: "Test payload is intentionally corrupt")
    )
  }
}

private enum PersistenceStoreTestError: Error {
  case decode
  case save
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
