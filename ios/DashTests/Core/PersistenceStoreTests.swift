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
