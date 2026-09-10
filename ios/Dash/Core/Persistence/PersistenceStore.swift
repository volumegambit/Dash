import Foundation
import SwiftData

enum PersistenceStoreError: Error, Equatable, Sendable {
  case invalidTombstoneStatus
  case invalidStoredValue(String)
  case conversationDeleted(gatewayID: String, conversationID: String)
  case invalidV2Bootstrap
  case nonContiguousV2Overlay
  case durableV2CursorBehind
  case conflictingV2Frame
  case v2QueueRevisionRegression
  case v2HistoryCursorMismatch
  case conflictingV2Admission
}

enum ConversationRemovalOutcome: Equatable, Sendable {
  case removed
  case retained(ConversationSummaryDTO)
}

private enum ConversationRemovalPrecondition: Sendable {
  case unconditional
  case canonical(ConversationSummaryDTO?)
}

private struct PreparedV2Bootstrap {
  let value: MobileV2ConversationBootstrap
  let payload: Data
  let summary: ConversationSummaryDTO
}

private struct CachedV2MessageRow {
  let message: ConversationMessageDTO
  let delivery: MobileV2MessageDelivery?
}

@ModelActor
actor PersistenceStore {
  private var recoveryCache: [String: [RecoverablePendingSend]] = [:]

  static func inMemory() throws -> PersistenceStore {
    let schema = PersistenceSchema.make()
    let configuration = ModelConfiguration(schema: schema, isStoredInMemoryOnly: true)
    let container = try ModelContainer(for: schema, configurations: [configuration])
    return PersistenceStore(modelContainer: container)
  }

  static func stored(at url: URL) throws -> PersistenceStore {
    let schema = PersistenceSchema.make()
    let configuration = ModelConfiguration(
      schema: schema,
      url: url,
      cloudKitDatabase: .none
    )
    let container = try ModelContainer(for: schema, configurations: [configuration])
    return PersistenceStore(modelContainer: container)
  }

  func upsertProfile(
    _ profile: ConnectionProfile,
    identity: GatewayIdentityDTO,
    saveChanges: (@Sendable () throws -> Void)? = nil
  ) throws {
    let gatewayID = identity.gatewayId
    if let record = try profileRecord(gatewayID: gatewayID) {
      record.profileID = profile.id
      record.label = profile.label
      record.host = profile.host
      record.managementPort = profile.managementPort
      record.chatPort = profile.chatPort
      record.secure = profile.secure
      record.tlsCertificateSha256 = profile.tlsCertificateSha256
      record.modeRaw = profile.mode.rawValue
      record.publicKey = identity.publicKey
      record.createdAt = profile.createdAt
      record.lastSuccessfulSyncAt = profile.lastSuccessfulSyncAt
    } else {
      modelContext.insert(
        GatewayProfileRecord(
          gatewayID: gatewayID,
          profileID: profile.id,
          label: profile.label,
          host: profile.host,
          managementPort: profile.managementPort,
          chatPort: profile.chatPort,
          secure: profile.secure,
          tlsCertificateSha256: profile.tlsCertificateSha256,
          modeRaw: profile.mode.rawValue,
          publicKey: identity.publicKey,
          createdAt: profile.createdAt,
          lastSuccessfulSyncAt: profile.lastSuccessfulSyncAt
        )
      )
    }
    do {
      if let saveChanges {
        try saveChanges()
      } else {
        try modelContext.save()
      }
    } catch {
      modelContext.rollback()
      throw error
    }
  }

  func profile(gatewayID: String) throws -> ConnectionProfileSnapshot? {
    guard let record = try profileRecord(gatewayID: gatewayID) else { return nil }
    guard let mode = ConnectionMode(rawValue: record.modeRaw) else {
      throw PersistenceStoreError.invalidStoredValue("connection mode \(record.modeRaw)")
    }
    return ConnectionProfileSnapshot(
      gatewayID: gatewayID,
      profile: ConnectionProfile(
        id: record.profileID,
        gatewayId: record.gatewayID,
        publicKey: record.publicKey,
        label: record.label,
        host: record.host,
        managementPort: record.managementPort,
        chatPort: record.chatPort,
        secure: record.secure,
        mode: mode,
        tlsCertificateSha256: record.tlsCertificateSha256,
        createdAt: record.createdAt,
        lastSuccessfulSyncAt: record.lastSuccessfulSyncAt
      )
    )
  }

  func markSuccessfulSync(gatewayID: String, at: Date) throws {
    try profileRecord(gatewayID: gatewayID)?.lastSuccessfulSyncAt = at
    try modelContext.save()
  }

  func upsertConversations(
    _ values: [ConversationSummaryDTO],
    gatewayID: String
  ) throws {
    let cachedRecoveryConversationIDs = Set(
      recoveryCache[gatewayID]?.map(\.conversationID) ?? []
    )
    var shouldInvalidateRecoveryCache = false
    do {
      for value in values {
        let wasApplied = try upsertConversation(value, gatewayID: gatewayID)
        if wasApplied {
          if value.status == .deleted {
            try purgeConversationContent(gatewayID: gatewayID, conversationID: value.id)
            shouldInvalidateRecoveryCache = true
          } else if cachedRecoveryConversationIDs.contains(value.id) {
            shouldInvalidateRecoveryCache = true
          }
        }
      }
      try modelContext.save()
      if shouldInvalidateRecoveryCache {
        recoveryCache[gatewayID] = nil
      }
    } catch {
      modelContext.rollback()
      throw error
    }
  }

  func conversations(gatewayID: String, limit: Int) throws -> [CachedConversation] {
    guard limit > 0 else { return [] }
    let targetGatewayID = gatewayID
    let deleted = ConversationStatus.deleted.rawValue
    var descriptor = FetchDescriptor<ConversationRecord>(
      predicate: #Predicate { record in
        record.gatewayID == targetGatewayID && record.statusRaw != deleted
      },
      sortBy: [
        SortDescriptor(\ConversationRecord.updatedAt, order: .reverse),
        SortDescriptor(\ConversationRecord.conversationID),
      ]
    )
    descriptor.fetchLimit = limit
    return try modelContext.fetch(descriptor).map {
      try cachedConversation(from: $0)
    }
  }

  func conversation(gatewayID: String, id: String) throws -> CachedConversation? {
    guard let record = try conversationRecord(gatewayID: gatewayID, conversationID: id) else {
      return nil
    }
    return try cachedConversation(from: record)
  }

  func applyTombstone(_ value: ConversationSummaryDTO, gatewayID: String) throws {
    _ = try applyTombstoneAndReturnCanonical(value, gatewayID: gatewayID)
  }

  func applyTombstoneAndReturnCanonical(
    _ value: ConversationSummaryDTO,
    gatewayID: String
  ) throws -> CachedConversation {
    do {
      try stageTombstone(value, gatewayID: gatewayID)
      guard
        let record = try conversationRecord(
          gatewayID: gatewayID,
          conversationID: value.id
        )
      else {
        throw PersistenceStoreError.invalidStoredValue(
          "conversation \(gatewayID)/\(value.id) after tombstone"
        )
      }
      let canonical = try cachedConversation(from: record)
      try modelContext.save()
      recoveryCache[gatewayID] = nil
      return canonical
    } catch {
      modelContext.rollback()
      throw error
    }
  }

  func persistConversationAndReturnCanonical(
    _ value: ConversationSummaryDTO,
    gatewayID: String
  ) throws -> CachedConversation {
    if value.status == .deleted {
      return try applyTombstoneAndReturnCanonical(value, gatewayID: gatewayID)
    }
    try upsertConversations([value], gatewayID: gatewayID)
    guard let canonical = try conversation(gatewayID: gatewayID, id: value.id) else {
      throw PersistenceStoreError.invalidStoredValue(
        "conversation \(gatewayID)/\(value.id) after upsert"
      )
    }
    return canonical
  }

  func applyTombstone(
    _ value: ConversationSummaryDTO,
    gatewayID: String,
    saveChanges: @Sendable () throws -> Void
  ) throws {
    do {
      try stageTombstone(value, gatewayID: gatewayID)
      try saveChanges()
      recoveryCache[gatewayID] = nil
    } catch {
      modelContext.rollback()
      throw error
    }
  }

  private func stageTombstone(
    _ value: ConversationSummaryDTO,
    gatewayID: String
  ) throws {
    guard value.status == .deleted else {
      throw PersistenceStoreError.invalidTombstoneStatus
    }
    let wasApplied = try upsertConversation(value, gatewayID: gatewayID)
    if wasApplied {
      try purgeConversationContent(gatewayID: gatewayID, conversationID: value.id)
    }
  }

  func removeConversation(
    gatewayID: String,
    conversationID: String
  ) throws {
    _ = try performConversationRemoval(
      gatewayID: gatewayID,
      conversationID: conversationID,
      revisionFloor: nil,
      precondition: .unconditional,
      saveChanges: nil
    )
  }

  func removeConversation(
    gatewayID: String,
    conversationID: String,
    revisionFloor: Int?
  ) throws {
    _ = try performConversationRemoval(
      gatewayID: gatewayID,
      conversationID: conversationID,
      revisionFloor: revisionFloor,
      precondition: .unconditional,
      saveChanges: nil
    )
  }

  func removeConversation(
    gatewayID: String,
    conversationID: String,
    revisionFloor: Int?,
    saveChanges: @escaping @Sendable () throws -> Void
  ) throws {
    _ = try performConversationRemoval(
      gatewayID: gatewayID,
      conversationID: conversationID,
      revisionFloor: revisionFloor,
      precondition: .unconditional,
      saveChanges: saveChanges
    )
  }

  func removeConversationIfCanonicalUnchanged(
    gatewayID: String,
    conversationID: String,
    expectedCanonical: ConversationSummaryDTO?
  ) throws -> ConversationRemovalOutcome {
    try performConversationRemoval(
      gatewayID: gatewayID,
      conversationID: conversationID,
      revisionFloor: expectedCanonical?.revision,
      precondition: .canonical(expectedCanonical),
      saveChanges: nil
    )
  }

  private func performConversationRemoval(
    gatewayID: String,
    conversationID: String,
    revisionFloor requestedRevisionFloor: Int?,
    precondition: ConversationRemovalPrecondition,
    saveChanges: (@Sendable () throws -> Void)?
  ) throws -> ConversationRemovalOutcome {
    do {
      let record = try conversationRecord(
        gatewayID: gatewayID,
        conversationID: conversationID
      )
      if case .canonical(let expectedCanonical) = precondition, let record {
        let current = try cachedConversation(from: record).summary
        guard current == expectedCanonical else { return .retained(current) }
      }
      let fence = try removalFenceRecord(
        gatewayID: gatewayID,
        conversationID: conversationID
      )
      let revisionFloor = max(
        requestedRevisionFloor ?? 0,
        max(record?.revision ?? 0, fence?.revisionFloor ?? 0)
      )

      if let fence {
        fence.revisionFloor = revisionFloor
      } else {
        modelContext.insert(
          ConversationRemovalFenceRecord(
            scopedConversationID: scopedID(
              gatewayID: gatewayID,
              resourceID: conversationID
            ),
            gatewayID: gatewayID,
            conversationID: conversationID,
            revisionFloor: revisionFloor
          )
        )
      }

      if let record {
        record.revision = revisionFloor
        record.statusRaw = ConversationStatus.deleted.rawValue
        record.activeTurnID = nil
        record.deletedAt = record.deletedAt ?? record.updatedAt
      } else {
        let removedAt = Date()
        modelContext.insert(
          ConversationRecord(
            scopedID: scopedID(gatewayID: gatewayID, resourceID: conversationID),
            gatewayID: gatewayID,
            conversationID: conversationID,
            agentID: "",
            agentName: "",
            title: "",
            revision: revisionFloor,
            statusRaw: ConversationStatus.deleted.rawValue,
            activeTurnID: nil,
            owningIssueID: nil,
            projectID: nil,
            lastSeq: 0,
            lastMessagePreview: nil,
            createdAt: removedAt,
            updatedAt: removedAt,
            deletedAt: removedAt
          )
        )
      }
      try purgeConversationContent(gatewayID: gatewayID, conversationID: conversationID)
      if let saveChanges {
        try saveChanges()
      } else {
        try modelContext.save()
      }
      recoveryCache[gatewayID] = nil
      return .removed
    } catch {
      modelContext.rollback()
      throw error
    }
  }

  func mergeMessages(
    _ values: [ConversationMessageDTO],
    gatewayID: String,
    conversationID: String
  ) throws {
    try requireWritableConversation(
      gatewayID: gatewayID,
      conversationID: conversationID,
      allowMissing: false
    )
    for value in values {
      let key = scopedID(gatewayID: gatewayID, resourceID: value.id)
      let content = try ContractCoding.encoder().encode(value.content)
      if let record = try messageRecord(scopedID: key) {
        guard value.updatedAt >= record.updatedAt else { continue }
        record.conversationID = conversationID
        record.messageID = value.id
        record.turnID = value.turnId
        record.ordinal = value.ordinal
        record.roleRaw = value.role.rawValue
        record.statusRaw = value.status.rawValue
        record.contentData = content
        record.createdAt = value.createdAt
        record.updatedAt = value.updatedAt
      } else {
        modelContext.insert(
          MessageRecord(
            scopedID: key,
            gatewayID: gatewayID,
            conversationID: conversationID,
            messageID: value.id,
            turnID: value.turnId,
            ordinal: value.ordinal,
            roleRaw: value.role.rawValue,
            statusRaw: value.status.rawValue,
            contentData: content,
            createdAt: value.createdAt,
            updatedAt: value.updatedAt
          )
        )
      }
    }
    try modelContext.save()
    recoveryCache[gatewayID] = nil
  }

  func messages(
    gatewayID: String,
    conversationID: String
  ) throws -> [ConversationMessageDTO] {
    let targetGatewayID = gatewayID
    let targetConversationID = conversationID
    let descriptor = FetchDescriptor<MessageRecord>(
      predicate: #Predicate { record in
        record.gatewayID == targetGatewayID && record.conversationID == targetConversationID
      },
      sortBy: [
        SortDescriptor(\MessageRecord.ordinal),
        SortDescriptor(\MessageRecord.createdAt),
        SortDescriptor(\MessageRecord.messageID),
      ]
    )
    return try modelContext.fetch(descriptor).map { record in
      guard let role = MessageRole(rawValue: record.roleRaw) else {
        throw PersistenceStoreError.invalidStoredValue("message role \(record.roleRaw)")
      }
      guard let status = MessageStatus(rawValue: record.statusRaw) else {
        throw PersistenceStoreError.invalidStoredValue("message status \(record.statusRaw)")
      }
      return ConversationMessageDTO(
        id: record.messageID,
        conversationId: record.conversationID,
        turnId: record.turnID,
        ordinal: record.ordinal,
        role: role,
        status: status,
        content: try ContractCoding.decoder().decode(
          MessageContent.self,
          from: record.contentData
        ),
        createdAt: record.createdAt,
        updatedAt: record.updatedAt
      )
    }
  }

  func saveDraft(
    _ draft: ConversationDraft,
    gatewayID: String,
    conversationID: String,
    encodeAttachments: @Sendable ([DraftAttachment]) throws -> Data = {
      try ContractCoding.encoder().encode($0)
    }
  ) throws {
    try requireWritableConversation(gatewayID: gatewayID, conversationID: conversationID)
    let key = scopedID(gatewayID: gatewayID, resourceID: conversationID)
    let attachments = try encodeAttachments(draft.attachments)
    if let record = try draftRecord(scopedConversationID: key) {
      record.text = draft.text
      record.attachmentsData = attachments
      record.updatedAt = draft.updatedAt
      record.revision = draft.revision
    } else {
      modelContext.insert(
        DraftRecord(
          scopedConversationID: key,
          gatewayID: gatewayID,
          conversationID: conversationID,
          text: draft.text,
          attachmentsData: attachments,
          updatedAt: draft.updatedAt,
          revision: draft.revision
        )
      )
    }
    try modelContext.save()
    recoveryCache[gatewayID] = nil
  }

  func draft(gatewayID: String, conversationID: String) throws -> ConversationDraft? {
    let key = scopedID(gatewayID: gatewayID, resourceID: conversationID)
    guard let record = try draftRecord(scopedConversationID: key) else { return nil }
    return ConversationDraft(
      text: record.text,
      attachments: try ContractCoding.decoder().decode(
        [DraftAttachment].self,
        from: record.attachmentsData
      ),
      updatedAt: record.updatedAt,
      revision: record.revision
    )
  }

  func pendingSend(
    gatewayID: String,
    conversationID: String
  ) throws -> PendingSendLoadResult {
    let key = scopedID(gatewayID: gatewayID, resourceID: conversationID)
    guard let record = try pendingSendRecord(scopedConversationID: key) else { return .none }
    let conversation = try conversationRecord(
      gatewayID: gatewayID,
      conversationID: conversationID
    )
    let draftRecord = try draftRecord(scopedConversationID: key)
    let decodedDraft = draftRecord.map(decodeConversationDraft(from:))
    let decoded = decodePendingSend(record)
    if conversation?.statusRaw != ConversationStatus.deleted.rawValue,
      conversation != nil,
      decoded.attachmentIssue == nil,
      draftRecord == nil
    {
      return .resumable(decoded.pendingSend)
    }
    return .recoveryRequired(
      recoverablePendingSend(
        record: record,
        conversation: conversation,
        decoded: decoded,
        coexistingDraft: decodedDraft?.draft,
        coexistingDraftAttachmentIssue: decodedDraft?.attachmentIssue
      )
    )
  }

  func recoverablePendingSends(
    gatewayID: String,
    decodeAttachments: @Sendable (Data) throws -> [PreparedAttachment] = {
      try ContractCoding.decoder().decode([PreparedAttachment].self, from: $0)
    }
  ) throws -> [RecoverablePendingSend] {
    if let cached = recoveryCache[gatewayID] { return cached }
    let targetGatewayID = gatewayID
    let deleted = ConversationStatus.deleted.rawValue
    let records = try modelContext.fetch(
      FetchDescriptor<PendingSendRecord>(
        predicate: #Predicate { $0.gatewayID == targetGatewayID },
        sortBy: [
          SortDescriptor(\PendingSendRecord.createdAt, order: .reverse),
          SortDescriptor(\PendingSendRecord.conversationID),
        ]
      )
    )
    let conversations = try modelContext.fetch(
      FetchDescriptor<ConversationRecord>(
        predicate: #Predicate { $0.gatewayID == targetGatewayID }
      )
    )
    let drafts = try modelContext.fetch(
      FetchDescriptor<DraftRecord>(
        predicate: #Predicate { $0.gatewayID == targetGatewayID }
      )
    )
    let conversationsByID = Dictionary(
      uniqueKeysWithValues: conversations.map { ($0.conversationID, $0) }
    )
    let draftsByKey = Dictionary(
      uniqueKeysWithValues: drafts.map { ($0.scopedConversationID, $0) }
    )
    let recoveries: [RecoverablePendingSend] = records.compactMap { record in
      let conversation = conversationsByID[record.conversationID]
      let decoded = decodePendingSend(record, decodeAttachments: decodeAttachments)
      let draftRecord = draftsByKey[record.scopedConversationID]
      let decodedDraft = draftRecord.map(decodeConversationDraft(from:))
      guard
        conversation == nil || conversation?.statusRaw == deleted
          || decoded.attachmentIssue != nil
          || draftRecord != nil
      else { return nil }
      return recoverablePendingSend(
        record: record,
        conversation: conversation,
        decoded: decoded,
        coexistingDraft: decodedDraft?.draft,
        coexistingDraftAttachmentIssue: decodedDraft?.attachmentIssue
      )
    }
    recoveryCache[gatewayID] = recoveries
    return recoveries
  }

  @discardableResult
  func stagePendingSend(
    _ pending: PendingChatSend,
    gatewayID: String,
    conversationID: String,
    encodeAttachments: @Sendable ([PreparedAttachment]) throws -> Data = {
      try ContractCoding.encoder().encode($0)
    }
  ) throws -> PendingSendStageResult {
    try requireWritableConversation(gatewayID: gatewayID, conversationID: conversationID)
    let key = scopedID(gatewayID: gatewayID, resourceID: conversationID)
    guard try pendingSendRecord(scopedConversationID: key) == nil else {
      return .pendingAlreadyExists
    }
    let attachments = try encodeAttachments(pending.attachments)
    modelContext.insert(
      PendingSendRecord(
        scopedConversationID: key,
        gatewayID: gatewayID,
        conversationID: conversationID,
        turnID: pending.turnID,
        localUserID: pending.localUserID,
        draft: pending.draft,
        attachmentsData: attachments,
        createdAt: pending.createdAt
      )
    )
    if let draft = try draftRecord(scopedConversationID: key) {
      modelContext.delete(draft)
    }
    do {
      try modelContext.save()
      recoveryCache[gatewayID] = nil
      return .staged
    } catch {
      modelContext.rollback()
      throw error
    }
  }

  func clearPendingSend(
    gatewayID: String,
    conversationID: String,
    turnID: String
  ) throws -> PendingSendClearResult {
    guard
      let conversation = try conversationRecord(
        gatewayID: gatewayID,
        conversationID: conversationID
      ),
      conversation.statusRaw != ConversationStatus.deleted.rawValue
    else { return .conversationUnavailable }
    let key = scopedID(gatewayID: gatewayID, resourceID: conversationID)
    guard let record = try pendingSendRecord(scopedConversationID: key),
      record.turnID == turnID
    else { return .cleared }
    modelContext.delete(record)
    do {
      try modelContext.save()
      recoveryCache[gatewayID] = nil
      return .cleared
    } catch {
      modelContext.rollback()
      throw error
    }
  }

  func pendingSendAvailability(
    gatewayID: String,
    conversationID: String,
    turnID: String
  ) throws -> PendingSendAvailability {
    let key = scopedID(gatewayID: gatewayID, resourceID: conversationID)
    guard let pending = try pendingSendRecord(scopedConversationID: key),
      pending.turnID == turnID
    else { return .pendingMissing }
    guard
      let conversation = try conversationRecord(
        gatewayID: gatewayID,
        conversationID: conversationID
      ),
      conversation.statusRaw != ConversationStatus.deleted.rawValue
    else { return .conversationUnavailable }
    return .active
  }

  func discardPendingSend(
    gatewayID: String,
    conversationID: String,
    turnID: String,
    expectedConversationAvailable: Bool? = nil
  ) throws -> Bool {
    let key = scopedID(gatewayID: gatewayID, resourceID: conversationID)
    guard let record = try pendingSendRecord(scopedConversationID: key),
      record.turnID == turnID
    else { return false }
    let conversation = try conversationRecord(
      gatewayID: gatewayID,
      conversationID: conversationID
    )
    let conversationAvailable =
      conversation != nil && conversation?.statusRaw != ConversationStatus.deleted.rawValue
    if let expectedConversationAvailable,
      expectedConversationAvailable != conversationAvailable
    {
      return false
    }
    let draft = try draftRecord(scopedConversationID: key)
    if conversationAvailable,
      let draft,
      decodeConversationDraft(from: draft).attachmentIssue == .unreadableStoredPayload
    {
      draft.attachmentsData = try ContractCoding.encoder().encode([DraftAttachment]())
    }
    modelContext.delete(record)
    if conversationAvailable == false,
      let draft
    {
      modelContext.delete(draft)
    }
    do {
      try modelContext.save()
      recoveryCache[gatewayID] = nil
      return true
    } catch {
      modelContext.rollback()
      throw error
    }
  }

  func restorePendingSendAsDraft(
    gatewayID: String,
    conversationID: String,
    turnID: String
  ) throws -> PendingSendRestoreResult {
    guard
      let conversation = try conversationRecord(
        gatewayID: gatewayID,
        conversationID: conversationID
      ),
      conversation.statusRaw != ConversationStatus.deleted.rawValue
    else { return .conversationUnavailable }
    let key = scopedID(gatewayID: gatewayID, resourceID: conversationID)
    guard let pending = try pendingSendRecord(scopedConversationID: key),
      pending.turnID == turnID
    else { return .restored(nil) }
    if let draft = try draftRecord(scopedConversationID: key) {
      // Staging removes the old draft atomically, so a coexisting draft was saved afterward.
      return .draftConflict(
        ConversationDraft(
          text: draft.text,
          attachments: try ContractCoding.decoder().decode(
            [DraftAttachment].self,
            from: draft.attachmentsData
          ),
          updatedAt: draft.updatedAt,
          revision: draft.revision
        )
      )
    }
    let attachments = try ContractCoding.decoder().decode(
      [PreparedAttachment].self,
      from: pending.attachmentsData
    )
    let updatedAt = Date()
    modelContext.insert(
      DraftRecord(
        scopedConversationID: key,
        gatewayID: gatewayID,
        conversationID: conversationID,
        text: pending.draft,
        attachmentsData: pending.attachmentsData,
        updatedAt: updatedAt,
        revision: 0
      )
    )
    let restoredDraft = ConversationDraft(
      text: pending.draft,
      attachments: attachments,
      updatedAt: updatedAt,
      revision: 0
    )
    modelContext.delete(pending)
    do {
      try modelContext.save()
      recoveryCache[gatewayID] = nil
    } catch {
      modelContext.rollback()
      throw error
    }
    return .restored(restoredDraft)
  }

  func replaceAgents(_ values: [RegisteredAgentDTO], gatewayID: String) throws {
    let targetGatewayID = gatewayID
    let descriptor = FetchDescriptor<AgentRecord>(
      predicate: #Predicate { $0.gatewayID == targetGatewayID }
    )
    for record in try modelContext.fetch(descriptor) {
      modelContext.delete(record)
    }
    let updatedAt = Date()
    for value in values {
      modelContext.insert(
        AgentRecord(
          scopedID: scopedID(gatewayID: gatewayID, resourceID: value.id),
          gatewayID: gatewayID,
          agentID: value.id,
          agentData: try ContractCoding.encoder().encode(value),
          updatedAt: updatedAt
        )
      )
    }
    try modelContext.save()
  }

  func upsertAgent(_ value: RegisteredAgentDTO, gatewayID: String) throws {
    let data = try ContractCoding.encoder().encode(value)
    if let record = try agentRecord(gatewayID: gatewayID, agentID: value.id) {
      record.agentData = data
      record.updatedAt = Date()
    } else {
      modelContext.insert(
        AgentRecord(
          scopedID: scopedID(gatewayID: gatewayID, resourceID: value.id),
          gatewayID: gatewayID,
          agentID: value.id,
          agentData: data,
          updatedAt: Date()
        )
      )
    }
    try modelContext.save()
  }

  func removeAgent(gatewayID: String, agentID: String) throws {
    if let record = try agentRecord(gatewayID: gatewayID, agentID: agentID) {
      modelContext.delete(record)
    }
    try modelContext.save()
  }

  func agents(gatewayID: String) throws -> [RegisteredAgentDTO] {
    let targetGatewayID = gatewayID
    let descriptor = FetchDescriptor<AgentRecord>(
      predicate: #Predicate { $0.gatewayID == targetGatewayID },
      sortBy: [SortDescriptor(\AgentRecord.agentID)]
    )
    return try modelContext.fetch(descriptor).map {
      try ContractCoding.decoder().decode(RegisteredAgentDTO.self, from: $0.agentData)
    }
  }

  func advanceCursor(gatewayID: String, conversationID: String, to seq: Int) throws {
    try requireWritableConversation(
      gatewayID: gatewayID,
      conversationID: conversationID,
      allowMissing: false
    )
    let key = scopedID(gatewayID: gatewayID, resourceID: conversationID)
    if let record = try replayCursorRecord(scopedConversationID: key) {
      record.lastSeq = max(record.lastSeq, seq)
    } else {
      modelContext.insert(
        ReplayCursorRecord(
          scopedConversationID: key,
          gatewayID: gatewayID,
          conversationID: conversationID,
          lastSeq: max(0, seq)
        )
      )
    }
    try modelContext.save()
  }

  func cursor(gatewayID: String, conversationID: String) throws -> Int {
    let key = scopedID(gatewayID: gatewayID, resourceID: conversationID)
    return try replayCursorRecord(scopedConversationID: key)?.lastSeq ?? 0
  }

  @discardableResult
  func replaceV2Bootstrap(
    _ bootstrap: MobileV2ConversationBootstrap,
    gatewayID: String,
    saveChanges: (@Sendable () throws -> Void)? = nil
  ) throws -> V2BootstrapApplyResult {
    let prepared = try prepareV2Bootstrap(bootstrap, gatewayID: gatewayID)
    do {
      let existing = try v2Projection(
        gatewayID: gatewayID,
        conversationID: bootstrap.conversation.id
      )
      let committed = existing?.version.committedV2Seq ?? 0
      if bootstrap.v2ThroughSeq < committed {
        guard let existing else { throw PersistenceStoreError.invalidV2Bootstrap }
        return V2BootstrapApplyResult(disposition: .stale, current: existing)
      }
      if let existing,
        bootstrap.queueRevision < currentQueueRevision(for: existing.projection)
      {
        throw PersistenceStoreError.v2QueueRevisionRegression
      }
      let key = scopedID(
        gatewayID: gatewayID,
        resourceID: bootstrap.conversation.id
      )
      let anchorRecord = try v2BootstrapAnchorRecord(scopedConversationID: key)
      let overlays = try v2AppliedFrameRecords(
        gatewayID: gatewayID,
        conversationID: bootstrap.conversation.id
      )
      let historyCursor: String?
      if
        let anchorRecord,
        let conversation = try conversationRecord(
          gatewayID: gatewayID,
          conversationID: bootstrap.conversation.id
        )
      {
        let previousAnchor = try ContractCoding.decoder().decode(
          MobileV2ConversationBootstrap.self,
          from: anchorRecord.payloadData
        )
        let preservesHistoryFrontier = bootstrap.v2ThroughSeq == previousAnchor.v2ThroughSeq
          && bootstrap.nextCursor == previousAnchor.nextCursor
          && bootstrap.messages.map(\.id) == previousAnchor.messages.map(\.id)
        historyCursor = preservesHistoryFrontier
          ? conversation.v2NextMessageCursor
          : bootstrap.nextCursor
      } else {
        historyCursor = bootstrap.nextCursor
      }
      let exactRepeat = try anchorRecord?.payloadData == prepared.payload
        && overlays.isEmpty
        && existing != nil
        && isExactV2BootstrapDerivedState(prepared, gatewayID: gatewayID)
      if bootstrap.v2ThroughSeq == committed, exactRepeat {
        return V2BootstrapApplyResult(disposition: .unchanged, current: existing!)
      }

      try stageV2Bootstrap(prepared, gatewayID: gatewayID, historyCursor: historyCursor)
      for record in overlays { modelContext.delete(record) }
      let cursor = try v2ReplayCursorRecord(scopedConversationID: key)
      let nextMutationRevision = (cursor?.mutationRevision ?? 0) + 1
      if let cursor {
        cursor.lastV2Seq = bootstrap.v2ThroughSeq
        cursor.mutationRevision = nextMutationRevision
      } else {
        modelContext.insert(
          V2ReplayCursorRecord(
            scopedConversationID: key,
            gatewayID: gatewayID,
            conversationID: bootstrap.conversation.id,
            lastV2Seq: bootstrap.v2ThroughSeq,
            mutationRevision: nextMutationRevision
          )
        )
      }
      if let anchorRecord {
        anchorRecord.payloadData = prepared.payload
      } else {
        modelContext.insert(
          V2BootstrapAnchorRecord(
            scopedConversationID: key,
            gatewayID: gatewayID,
            conversationID: bootstrap.conversation.id,
            payloadData: prepared.payload
          )
        )
      }
      if let saveChanges { try saveChanges() } else { try modelContext.save() }

      guard
        let current = try v2Projection(
          gatewayID: gatewayID,
          conversationID: bootstrap.conversation.id
        )
      else { throw PersistenceStoreError.invalidV2Bootstrap }
      let disposition: V2BootstrapApplyDisposition
      if existing == nil {
        disposition = .installed
      } else if bootstrap.v2ThroughSeq > committed {
        disposition = .advanced
      } else {
        disposition = .compacted
      }
      return V2BootstrapApplyResult(disposition: disposition, current: current)
    } catch {
      modelContext.rollback()
      throw error
    }
  }

  func v2Bootstrap(
    gatewayID: String,
    conversationID: String
  ) throws -> CachedV2ConversationBootstrap? {
    try v2Projection(gatewayID: gatewayID, conversationID: conversationID)?.projection.anchor
  }

  func v2Projection(
    gatewayID: String,
    conversationID: String
  ) throws -> VersionedV2ConversationProjection? {
    let key = scopedID(gatewayID: gatewayID, resourceID: conversationID)
    guard
      let anchorRecord = try v2BootstrapAnchorRecord(scopedConversationID: key),
      let cursorRecord = try v2ReplayCursorRecord(scopedConversationID: key),
      let conversationRecord = try conversationRecord(
        gatewayID: gatewayID,
        conversationID: conversationID
      )
    else { return nil }
    guard
      anchorRecord.gatewayID == gatewayID,
      anchorRecord.conversationID == conversationID,
      cursorRecord.gatewayID == gatewayID,
      cursorRecord.conversationID == conversationID,
      conversationRecord.gatewayID == gatewayID,
      conversationRecord.conversationID == conversationID
    else {
      throw PersistenceStoreError.invalidStoredValue("v2 projection scope")
    }
    let wireAnchor = try ContractCoding.decoder().decode(
      MobileV2ConversationBootstrap.self,
      from: anchorRecord.payloadData
    )
    guard wireAnchor.conversation.id == conversationID else {
      throw PersistenceStoreError.invalidStoredValue("v2 bootstrap conversation scope")
    }
    let frames = try v2AppliedFrameRecords(
      gatewayID: gatewayID,
      conversationID: conversationID
    ).map {
      try ContractCoding.decoder().decode(MobileV2SequencedFrame.self, from: $0.payloadData)
    }
    try validateV2Overlay(
      conversationID: conversationID,
      anchorSequence: wireAnchor.v2ThroughSeq,
      committedSequence: cursorRecord.lastV2Seq,
      anchorQueueRevision: wireAnchor.queueRevision,
      frames: frames
    )
    let cachedMessages = try v2Messages(gatewayID: gatewayID, conversationID: conversationID)
    let pendingInputs = try pendingInputRecords(
      gatewayID: gatewayID,
      conversationID: conversationID
    ).map {
      try ContractCoding.decoder().decode(MobileV2PendingInput.self, from: $0.payloadData)
    }
    let anchor = CachedV2ConversationBootstrap(
      conversation: try cachedConversation(from: conversationRecord).summary,
      messages: cachedMessages.map(\.message),
      deliveryByMessageID: Dictionary(
        uniqueKeysWithValues: cachedMessages.compactMap { value in
          value.delivery.map { (value.message.id, $0) }
        }
      ),
      pendingInputs: pendingInputs,
      nextCursor: conversationRecord.v2NextMessageCursor,
      queuePaused: conversationRecord.queuePaused,
      queueRevision: conversationRecord.queueRevision,
      pendingFollowUpCount: conversationRecord.pendingFollowUpCount,
      v2ThroughSeq: wireAnchor.v2ThroughSeq
    )
    return VersionedV2ConversationProjection(
      projection: CachedV2ConversationProjection(
        anchor: anchor,
        appliedFrames: frames,
        committedV2Seq: cursorRecord.lastV2Seq
      ),
      version: V2ProjectionVersion(
        committedV2Seq: cursorRecord.lastV2Seq,
        mutationRevision: cursorRecord.mutationRevision
      )
    )
  }

  func v2Cursor(gatewayID: String, conversationID: String) throws -> Int {
    let key = scopedID(gatewayID: gatewayID, resourceID: conversationID)
    return try v2ReplayCursorRecord(scopedConversationID: key)?.lastV2Seq ?? 0
  }

  func commitV2Frame(
    _ frame: MobileV2SequencedFrame,
    gatewayID: String,
    expected: V2ProjectionVersion,
    saveChanges: (@Sendable () throws -> Void)? = nil
  ) throws -> V2FrameCommitResult {
    do {
      guard
        let current = try v2Projection(
          gatewayID: gatewayID,
          conversationID: frame.conversationId
        )
      else { throw PersistenceStoreError.invalidV2Bootstrap }
      try requireWritableConversation(
        gatewayID: gatewayID,
        conversationID: frame.conversationId,
        allowMissing: false
      )
      let sequence = frame.v2Seq
      let payload = try ContractCoding.encoder().encode(frame)
      if current.version.committedV2Seq >= sequence {
        if let existing = try v2AppliedFrameRecord(
          gatewayID: gatewayID,
          conversationID: frame.conversationId,
          sequence: sequence
        ), existing.payloadData != payload {
          throw PersistenceStoreError.conflictingV2Frame
        }
        return .alreadyCovered(current)
      }
      if current.version.committedV2Seq < expected.committedV2Seq {
        throw PersistenceStoreError.durableV2CursorBehind
      }
      guard current.version == expected else { return .staleWriter(current) }
      guard sequence == current.version.committedV2Seq + 1 else {
        throw PersistenceStoreError.nonContiguousV2Overlay
      }
      if let queueRevision = frame.queueRevision,
        queueRevision < currentQueueRevision(for: current.projection)
      {
        throw PersistenceStoreError.v2QueueRevisionRegression
      }

      let sequenceKey = v2SequenceID(
        gatewayID: gatewayID,
        conversationID: frame.conversationId,
        sequence: sequence
      )
      if let existing = try v2AppliedFrameRecord(scopedSequenceID: sequenceKey) {
        guard existing.payloadData == payload else {
          throw PersistenceStoreError.conflictingV2Frame
        }
      } else {
        modelContext.insert(
          V2AppliedFrameRecord(
            scopedSequenceID: sequenceKey,
            gatewayID: gatewayID,
            conversationID: frame.conversationId,
            sequence: sequence,
            payloadData: payload
          )
        )
      }
      let key = scopedID(gatewayID: gatewayID, resourceID: frame.conversationId)
      guard let cursor = try v2ReplayCursorRecord(scopedConversationID: key) else {
        throw PersistenceStoreError.invalidV2Bootstrap
      }
      cursor.lastV2Seq = sequence
      cursor.mutationRevision += 1
      if let saveChanges { try saveChanges() } else { try modelContext.save() }
      guard
        let committed = try v2Projection(
          gatewayID: gatewayID,
          conversationID: frame.conversationId
        )
      else { throw PersistenceStoreError.invalidV2Bootstrap }
      return .committed(committed)
    } catch {
      modelContext.rollback()
      throw error
    }
  }

  func mergeV2MessagePage(
    _ page: MobileV2ConversationMessagePage,
    gatewayID: String,
    conversationID: String,
    expectedBefore: String,
    saveChanges: (@Sendable () throws -> Void)? = nil
  ) throws -> CachedV2ConversationMessagePage {
    guard
      page.items.allSatisfy({ $0.conversationId == conversationID }),
      Set(page.items.map(\.id)).count == page.items.count
    else {
      throw PersistenceStoreError.invalidV2Bootstrap
    }
    try validateV2MessageOwnership(
      page.items,
      gatewayID: gatewayID,
      conversationID: conversationID
    )
    _ = try ContractCoding.encoder().encode(page)
    do {
      try requireWritableConversation(
        gatewayID: gatewayID,
        conversationID: conversationID,
        allowMissing: false
      )
      guard
        let conversation = try conversationRecord(
          gatewayID: gatewayID,
          conversationID: conversationID
        ),
        conversation.v2NextMessageCursor == expectedBefore
      else { throw PersistenceStoreError.v2HistoryCursorMismatch }
      var materiallyChanged = conversation.v2NextMessageCursor != page.nextCursor
      for message in page.items {
        if try upsertV2Message(message, gatewayID: gatewayID, isAnchor: false) {
          materiallyChanged = true
        }
      }
      conversation.v2NextMessageCursor = page.nextCursor
      if materiallyChanged {
        let key = scopedID(gatewayID: gatewayID, resourceID: conversationID)
        guard let cursor = try v2ReplayCursorRecord(scopedConversationID: key) else {
          throw PersistenceStoreError.invalidV2Bootstrap
        }
        cursor.mutationRevision += 1
      }
      let values = try page.items.map { value -> (ConversationMessageDTO, MobileV2MessageDelivery) in
        let key = scopedID(gatewayID: gatewayID, resourceID: value.id)
        guard let record = try messageRecord(scopedID: key) else {
          throw PersistenceStoreError.invalidStoredValue("v2 history message \(value.id)")
        }
        let decoded = try decodeV2Message(record)
        guard let delivery = decoded.delivery else {
          throw PersistenceStoreError.invalidStoredValue("v2 history delivery \(value.id)")
        }
        return (decoded.message, delivery)
      }.sorted { lhs, rhs in
        if lhs.0.ordinal != rhs.0.ordinal { return lhs.0.ordinal < rhs.0.ordinal }
        return lhs.0.id < rhs.0.id
      }
      if let saveChanges { try saveChanges() } else { try modelContext.save() }
      return CachedV2ConversationMessagePage(
        messages: values.map(\.0),
        deliveryByMessageID: Dictionary(
          uniqueKeysWithValues: values.map { ($0.0.id, $0.1) }
        ),
        nextCursor: page.nextCursor,
        throughSeq: page.throughSeq
      )
    } catch {
      modelContext.rollback()
      throw error
    }
  }

  func stageV2Admission(
    _ admission: PendingV2Admission,
    gatewayID: String,
    conversationID: String,
    saveChanges: (@Sendable () throws -> Void)? = nil
  ) throws {
    guard
      isCanonicalUUID(admission.commandID),
      isCanonicalUUID(admission.inputID),
      (admission.behavior == .followUp) == (admission.expectedActiveTurnID == nil)
    else { throw PersistenceStoreError.conflictingV2Admission }
    try requireWritableConversation(
      gatewayID: gatewayID,
      conversationID: conversationID,
      allowMissing: false
    )
    let payload = try ContractCoding.encoder().encode(admission)
    let key = scopedID(gatewayID: gatewayID, resourceID: conversationID)
    do {
      if let existing = try pendingV2AdmissionRecord(scopedConversationID: key) {
        guard existing.payloadData == payload else {
          throw PersistenceStoreError.conflictingV2Admission
        }
        return
      }
      if try pendingInputRecord(
        scopedID: scopedID(gatewayID: gatewayID, resourceID: admission.inputID)
      ) != nil {
        throw PersistenceStoreError.conflictingV2Admission
      }
      let collidesWithAnotherAdmission = try pendingV2AdmissionRecords(gatewayID: gatewayID)
        .contains { record in
          record.conversationID != conversationID
            && (record.commandID == admission.commandID || record.inputID == admission.inputID)
        }
      guard collidesWithAnotherAdmission == false else {
        throw PersistenceStoreError.conflictingV2Admission
      }
      modelContext.insert(
        PendingV2AdmissionRecord(
          scopedConversationID: key,
          gatewayID: gatewayID,
          conversationID: conversationID,
          commandID: admission.commandID,
          inputID: admission.inputID,
          payloadData: payload,
          createdAt: Date()
        )
      )
      if let saveChanges { try saveChanges() } else { try modelContext.save() }
    } catch {
      modelContext.rollback()
      throw error
    }
  }

  func pendingV2Admission(
    gatewayID: String,
    conversationID: String
  ) throws -> PendingV2Admission? {
    let key = scopedID(gatewayID: gatewayID, resourceID: conversationID)
    guard let record = try pendingV2AdmissionRecord(scopedConversationID: key) else {
      return nil
    }
    guard record.gatewayID == gatewayID, record.conversationID == conversationID else {
      throw PersistenceStoreError.conflictingV2Admission
    }
    let admission = try ContractCoding.decoder().decode(
      PendingV2Admission.self,
      from: record.payloadData
    )
    guard admission.commandID == record.commandID, admission.inputID == record.inputID else {
      throw PersistenceStoreError.conflictingV2Admission
    }
    return admission
  }

  func recoverableV2Admissions(
    gatewayID: String,
    decodeAdmission: @Sendable (Data) throws -> PendingV2Admission = {
      try ContractCoding.decoder().decode(PendingV2Admission.self, from: $0)
    }
  ) throws -> [RecoverableV2Admission] {
    let targetGatewayID = gatewayID
    let deleted = ConversationStatus.deleted.rawValue
    let records = try modelContext.fetch(
      FetchDescriptor<PendingV2AdmissionRecord>(
        predicate: #Predicate { $0.gatewayID == targetGatewayID },
        sortBy: [
          SortDescriptor(\PendingV2AdmissionRecord.createdAt, order: .reverse),
          SortDescriptor(\PendingV2AdmissionRecord.conversationID),
          SortDescriptor(\PendingV2AdmissionRecord.commandID),
        ]
      )
    )
    let conversations = try modelContext.fetch(
      FetchDescriptor<ConversationRecord>(
        predicate: #Predicate { $0.gatewayID == targetGatewayID }
      )
    )
    let drafts = try modelContext.fetch(
      FetchDescriptor<DraftRecord>(
        predicate: #Predicate { $0.gatewayID == targetGatewayID }
      )
    )
    let conversationsByID = Dictionary(
      uniqueKeysWithValues: conversations.map { ($0.conversationID, $0) }
    )
    let draftsByKey = Dictionary(
      uniqueKeysWithValues: drafts.map { ($0.scopedConversationID, $0) }
    )
    return records.compactMap { record in
      let conversation = conversationsByID[record.conversationID]
      let conversationAvailable = conversation != nil && conversation?.statusRaw != deleted
      let admission: PendingV2Admission?
      let payloadIssue: RecoverableAttachmentIssue?
      do {
        let decoded = try decodeAdmission(record.payloadData)
        guard decoded.commandID == record.commandID, decoded.inputID == record.inputID else {
          throw PersistenceStoreError.conflictingV2Admission
        }
        admission = decoded
        payloadIssue = nil
      } catch {
        admission = nil
        payloadIssue = .unreadableStoredPayload
      }
      let decodedDraft = draftsByKey[record.scopedConversationID]
        .map(decodeConversationDraft(from:))
      guard
        conversationAvailable == false || payloadIssue != nil
          || decodedDraft?.attachmentIssue != nil
      else { return nil }
      return RecoverableV2Admission(
        gatewayID: record.gatewayID,
        conversationID: record.conversationID,
        conversationTitle: conversation?.title,
        agentName: conversation?.agentName,
        commandID: record.commandID,
        inputID: record.inputID,
        createdAt: record.createdAt,
        admission: admission,
        payloadIssue: payloadIssue,
        coexistingDraft: decodedDraft?.draft,
        coexistingDraftAttachmentIssue: decodedDraft?.attachmentIssue,
        conversationAvailable: conversationAvailable
      )
    }
  }

  func discardV2Admission(
    gatewayID: String,
    conversationID: String,
    commandID: String,
    inputID: String,
    expectedConversationAvailable: Bool? = nil,
    saveChanges: (@Sendable () throws -> Void)? = nil
  ) throws -> Bool {
    let key = scopedID(gatewayID: gatewayID, resourceID: conversationID)
    guard
      let record = try pendingV2AdmissionRecord(scopedConversationID: key),
      record.gatewayID == gatewayID,
      record.conversationID == conversationID,
      record.commandID == commandID,
      record.inputID == inputID
    else { return false }
    let conversation = try conversationRecord(
      gatewayID: gatewayID,
      conversationID: conversationID
    )
    let conversationAvailable = conversation != nil
      && conversation?.statusRaw != ConversationStatus.deleted.rawValue
    if let expectedConversationAvailable,
      expectedConversationAvailable != conversationAvailable
    {
      return false
    }
    let draft = try draftRecord(scopedConversationID: key)
    do {
      if conversationAvailable,
        let draft,
        decodeConversationDraft(from: draft).attachmentIssue == .unreadableStoredPayload
      {
        draft.attachmentsData = try ContractCoding.encoder().encode([DraftAttachment]())
      }
      modelContext.delete(record)
      if conversationAvailable == false,
        let draft
      {
        modelContext.delete(draft)
      }
      if let saveChanges { try saveChanges() } else { try modelContext.save() }
      recoveryCache[gatewayID] = nil
      return true
    } catch {
      modelContext.rollback()
      throw error
    }
  }

  func acknowledgeV2Admission(
    commandID: String,
    inputID: String,
    gatewayID: String,
    conversationID: String,
    saveChanges: (@Sendable () throws -> Void)? = nil
  ) throws -> ConversationDraft? {
    try requireWritableConversation(
      gatewayID: gatewayID,
      conversationID: conversationID,
      allowMissing: false
    )
    let key = scopedID(gatewayID: gatewayID, resourceID: conversationID)
    guard
      let record = try pendingV2AdmissionRecord(scopedConversationID: key),
      record.commandID == commandID,
      record.inputID == inputID
    else { return try draft(gatewayID: gatewayID, conversationID: conversationID) }
    do {
      let admission = try ContractCoding.decoder().decode(
        PendingV2Admission.self,
        from: record.payloadData
      )
      guard admission.commandID == record.commandID, admission.inputID == record.inputID else {
        throw PersistenceStoreError.conflictingV2Admission
      }
      let draftRecord = try draftRecord(scopedConversationID: key)
      var retainedDraft = draftRecord.map(decodeConversationDraft(from:))?.draft
      if let draftRecord,
        draftRecord.revision == admission.draftRevision,
        draftRecord.text == admission.text,
        try preparedAttachmentsMatch(draftRecord.attachmentsData, images: admission.images)
      {
        modelContext.delete(draftRecord)
        retainedDraft = nil
      }
      modelContext.delete(record)
      if let saveChanges { try saveChanges() } else { try modelContext.save() }
      return retainedDraft
    } catch {
      modelContext.rollback()
      throw error
    }
  }

  func clearGateway(gatewayID: String) throws {
    let targetGatewayID = gatewayID
    do {
      for record in try modelContext.fetch(
      FetchDescriptor<GatewayProfileRecord>(
        predicate: #Predicate { $0.gatewayID == targetGatewayID }
      )
    ) {
      modelContext.delete(record)
    }
    for record in try modelContext.fetch(
      FetchDescriptor<ConversationRecord>(
        predicate: #Predicate { $0.gatewayID == targetGatewayID }
      )
    ) {
      modelContext.delete(record)
    }
    for record in try modelContext.fetch(
      FetchDescriptor<ConversationRemovalFenceRecord>(
        predicate: #Predicate { $0.gatewayID == targetGatewayID }
      )
    ) {
      modelContext.delete(record)
    }
    for record in try modelContext.fetch(
      FetchDescriptor<MessageRecord>(
        predicate: #Predicate { $0.gatewayID == targetGatewayID }
      )
    ) {
      modelContext.delete(record)
    }
    for record in try modelContext.fetch(
      FetchDescriptor<AgentRecord>(
        predicate: #Predicate { $0.gatewayID == targetGatewayID }
      )
    ) {
      modelContext.delete(record)
    }
    for record in try modelContext.fetch(
      FetchDescriptor<DraftRecord>(
        predicate: #Predicate { $0.gatewayID == targetGatewayID }
      )
    ) {
      modelContext.delete(record)
    }
    for record in try modelContext.fetch(
      FetchDescriptor<PendingSendRecord>(
        predicate: #Predicate { $0.gatewayID == targetGatewayID }
      )
    ) {
      modelContext.delete(record)
    }
    for record in try modelContext.fetch(
      FetchDescriptor<ReplayCursorRecord>(
        predicate: #Predicate { $0.gatewayID == targetGatewayID }
      )
    ) {
      modelContext.delete(record)
    }
    for record in try modelContext.fetch(
      FetchDescriptor<PendingInputRecord>(
        predicate: #Predicate { $0.gatewayID == targetGatewayID }
      )
    ) {
      modelContext.delete(record)
    }
    for record in try modelContext.fetch(
      FetchDescriptor<V2ReplayCursorRecord>(
        predicate: #Predicate { $0.gatewayID == targetGatewayID }
      )
    ) {
      modelContext.delete(record)
    }
    for record in try modelContext.fetch(
      FetchDescriptor<V2BootstrapAnchorRecord>(
        predicate: #Predicate { $0.gatewayID == targetGatewayID }
      )
    ) {
      modelContext.delete(record)
    }
    for record in try modelContext.fetch(
      FetchDescriptor<V2AppliedFrameRecord>(
        predicate: #Predicate { $0.gatewayID == targetGatewayID }
      )
    ) {
      modelContext.delete(record)
    }
    for record in try modelContext.fetch(
      FetchDescriptor<PendingV2AdmissionRecord>(
        predicate: #Predicate { $0.gatewayID == targetGatewayID }
      )
    ) {
      modelContext.delete(record)
    }
      try modelContext.save()
      recoveryCache[gatewayID] = nil
    } catch {
      modelContext.rollback()
      throw error
    }
  }

  private func upsertConversation(
    _ value: ConversationSummaryDTO,
    gatewayID: String
  ) throws -> Bool {
    let record = try conversationRecord(gatewayID: gatewayID, conversationID: value.id)
    let fence = try removalFenceRecord(gatewayID: gatewayID, conversationID: value.id)

    if let fence, value.revision <= fence.revisionFloor {
      return false
    }
    if let record {
      guard value.revision > record.revision else { return false }
      apply(value, to: record)
    } else {
      modelContext.insert(
        ConversationRecord(
          scopedID: scopedID(gatewayID: gatewayID, resourceID: value.id),
          gatewayID: gatewayID,
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
    }

    if value.status == .deleted {
      if let fence {
        fence.revisionFloor = max(fence.revisionFloor, value.revision)
      } else {
        modelContext.insert(
          ConversationRemovalFenceRecord(
            scopedConversationID: scopedID(gatewayID: gatewayID, resourceID: value.id),
            gatewayID: gatewayID,
            conversationID: value.id,
            revisionFloor: value.revision
          )
        )
      }
    } else if let fence {
      modelContext.delete(fence)
    }
    return true
  }

  private func requireWritableConversation(
    gatewayID: String,
    conversationID: String,
    allowMissing: Bool = true
  ) throws {
    let record = try conversationRecord(
      gatewayID: gatewayID,
      conversationID: conversationID
    )
    let fence = try removalFenceRecord(
      gatewayID: gatewayID,
      conversationID: conversationID
    )
    guard
      (allowMissing || record != nil),
      record?.statusRaw != ConversationStatus.deleted.rawValue,
      fence == nil
    else {
      throw PersistenceStoreError.conversationDeleted(
        gatewayID: gatewayID,
        conversationID: conversationID
      )
    }
  }

  private func apply(_ value: ConversationSummaryDTO, to record: ConversationRecord) {
    record.agentID = value.agentId
    record.agentName = value.agentName
    record.title = value.title
    record.revision = value.revision
    record.statusRaw = value.status.rawValue
    record.activeTurnID = value.activeTurnId
    record.owningIssueID = value.owningIssueId
    record.projectID = value.projectId
    record.lastSeq = value.lastSeq
    record.lastMessagePreview = value.lastMessagePreview
    record.createdAt = value.createdAt
    record.updatedAt = value.updatedAt
    record.deletedAt = value.deletedAt
  }

  private func purgeConversationContent(gatewayID: String, conversationID: String) throws {
    let key = scopedID(gatewayID: gatewayID, resourceID: conversationID)
    let preservesDraftForRecovery = try pendingSendRecord(scopedConversationID: key) != nil
      || pendingV2AdmissionRecord(scopedConversationID: key) != nil
    let targetGatewayID = gatewayID
    let targetConversationID = conversationID
    for record in try modelContext.fetch(
      FetchDescriptor<MessageRecord>(
        predicate: #Predicate {
          $0.gatewayID == targetGatewayID && $0.conversationID == targetConversationID
        }
      )
    ) {
      modelContext.delete(record)
    }
    if preservesDraftForRecovery == false {
      for record in try modelContext.fetch(
        FetchDescriptor<DraftRecord>(
          predicate: #Predicate {
            $0.gatewayID == targetGatewayID && $0.conversationID == targetConversationID
          }
        )
      ) {
        modelContext.delete(record)
      }
    }
    for record in try modelContext.fetch(
      FetchDescriptor<ReplayCursorRecord>(
        predicate: #Predicate {
          $0.gatewayID == targetGatewayID && $0.conversationID == targetConversationID
        }
      )
    ) {
      modelContext.delete(record)
    }
    for record in try pendingInputRecords(
      gatewayID: gatewayID,
      conversationID: conversationID
    ) {
      modelContext.delete(record)
    }
    if let record = try v2ReplayCursorRecord(scopedConversationID: key) {
      modelContext.delete(record)
    }
    if let record = try v2BootstrapAnchorRecord(scopedConversationID: key) {
      modelContext.delete(record)
    }
    for record in try v2AppliedFrameRecords(
      gatewayID: gatewayID,
      conversationID: conversationID
    ) {
      modelContext.delete(record)
    }
    if let conversation = try conversationRecord(
      gatewayID: gatewayID,
      conversationID: conversationID
    ) {
      conversation.queuePaused = false
      conversation.queueRevision = 0
      conversation.pendingFollowUpCount = 0
      conversation.v2LastSeq = 0
      conversation.v2NextMessageCursor = nil
    }
  }

  private func cachedConversation(from record: ConversationRecord) throws -> CachedConversation {
    guard let status = ConversationStatus(rawValue: record.statusRaw) else {
      throw PersistenceStoreError.invalidStoredValue(
        "conversation status \(record.statusRaw)"
      )
    }
    return CachedConversation(
      gatewayID: record.gatewayID,
      summary: ConversationSummaryDTO(
        id: record.conversationID,
        agentId: record.agentID,
        agentName: record.agentName,
        title: record.title,
        revision: record.revision,
        status: status,
        activeTurnId: record.activeTurnID,
        owningIssueId: record.owningIssueID,
        projectId: record.projectID,
        lastSeq: record.lastSeq,
        lastMessagePreview: record.lastMessagePreview,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        deletedAt: record.deletedAt
      )
    )
  }

  private func profileRecord(gatewayID: String) throws -> GatewayProfileRecord? {
    let targetGatewayID = gatewayID
    var descriptor = FetchDescriptor<GatewayProfileRecord>(
      predicate: #Predicate { $0.gatewayID == targetGatewayID }
    )
    descriptor.fetchLimit = 1
    return try modelContext.fetch(descriptor).first
  }

  private func conversationRecord(
    gatewayID: String,
    conversationID: String
  ) throws -> ConversationRecord? {
    let key = scopedID(gatewayID: gatewayID, resourceID: conversationID)
    var descriptor = FetchDescriptor<ConversationRecord>(
      predicate: #Predicate { $0.scopedID == key }
    )
    descriptor.fetchLimit = 1
    return try modelContext.fetch(descriptor).first
  }

  private func removalFenceRecord(
    gatewayID: String,
    conversationID: String
  ) throws -> ConversationRemovalFenceRecord? {
    let key = scopedID(gatewayID: gatewayID, resourceID: conversationID)
    var descriptor = FetchDescriptor<ConversationRemovalFenceRecord>(
      predicate: #Predicate { $0.scopedConversationID == key }
    )
    descriptor.fetchLimit = 1
    return try modelContext.fetch(descriptor).first
  }

  private func messageRecord(scopedID: String) throws -> MessageRecord? {
    let key = scopedID
    var descriptor = FetchDescriptor<MessageRecord>(
      predicate: #Predicate { $0.scopedID == key }
    )
    descriptor.fetchLimit = 1
    return try modelContext.fetch(descriptor).first
  }

  private func agentRecord(gatewayID: String, agentID: String) throws -> AgentRecord? {
    let key = scopedID(gatewayID: gatewayID, resourceID: agentID)
    var descriptor = FetchDescriptor<AgentRecord>(
      predicate: #Predicate { $0.scopedID == key }
    )
    descriptor.fetchLimit = 1
    return try modelContext.fetch(descriptor).first
  }

  private func draftRecord(scopedConversationID: String) throws -> DraftRecord? {
    let key = scopedConversationID
    var descriptor = FetchDescriptor<DraftRecord>(
      predicate: #Predicate { $0.scopedConversationID == key }
    )
    descriptor.fetchLimit = 1
    return try modelContext.fetch(descriptor).first
  }

  private func pendingSendRecord(scopedConversationID: String) throws -> PendingSendRecord? {
    let key = scopedConversationID
    var descriptor = FetchDescriptor<PendingSendRecord>(
      predicate: #Predicate { $0.scopedConversationID == key }
    )
    descriptor.fetchLimit = 1
    return try modelContext.fetch(descriptor).first
  }

  private func decodePendingSend(
    _ record: PendingSendRecord,
    decodeAttachments: @Sendable (Data) throws -> [PreparedAttachment] = {
      try ContractCoding.decoder().decode([PreparedAttachment].self, from: $0)
    }
  ) -> (pendingSend: PendingChatSend, attachmentIssue: RecoverableAttachmentIssue?) {
    let attachments: [PreparedAttachment]
    let attachmentIssue: RecoverableAttachmentIssue?
    do {
      attachments = try decodeAttachments(record.attachmentsData)
      attachmentIssue = nil
    } catch {
      attachments = []
      attachmentIssue = .unreadableStoredPayload
    }
    return (
      PendingChatSend(
        turnID: record.turnID,
        localUserID: record.localUserID,
        draft: record.draft,
        attachments: attachments,
        createdAt: record.createdAt
      ),
      attachmentIssue
    )
  }

  private func recoverablePendingSend(
    record: PendingSendRecord,
    conversation: ConversationRecord?,
    decoded: (pendingSend: PendingChatSend, attachmentIssue: RecoverableAttachmentIssue?),
    coexistingDraft: ConversationDraft?,
    coexistingDraftAttachmentIssue: RecoverableAttachmentIssue?
  ) -> RecoverablePendingSend {
    RecoverablePendingSend(
      gatewayID: record.gatewayID,
      conversationID: record.conversationID,
      conversationTitle: conversation?.title,
      agentName: conversation?.agentName,
      pendingSend: decoded.pendingSend,
      attachmentIssue: decoded.attachmentIssue,
      coexistingDraft: coexistingDraft,
      coexistingDraftAttachmentIssue: coexistingDraftAttachmentIssue,
      conversationAvailable: conversation != nil
        && conversation?.statusRaw != ConversationStatus.deleted.rawValue
    )
  }

  private func decodeConversationDraft(
    from record: DraftRecord
  ) -> (draft: ConversationDraft, attachmentIssue: RecoverableAttachmentIssue?) {
    let attachments: [DraftAttachment]
    let attachmentIssue: RecoverableAttachmentIssue?
    do {
      attachments = try ContractCoding.decoder().decode(
        [DraftAttachment].self,
        from: record.attachmentsData
      )
      attachmentIssue = nil
    } catch {
      attachments = []
      attachmentIssue = .unreadableStoredPayload
    }
    return (
      ConversationDraft(
        text: record.text,
        attachments: attachments,
        updatedAt: record.updatedAt,
        revision: record.revision
      ),
      attachmentIssue
    )
  }

  private func replayCursorRecord(
    scopedConversationID: String
  ) throws -> ReplayCursorRecord? {
    let key = scopedConversationID
    var descriptor = FetchDescriptor<ReplayCursorRecord>(
      predicate: #Predicate { $0.scopedConversationID == key }
    )
    descriptor.fetchLimit = 1
    return try modelContext.fetch(descriptor).first
  }

  private func prepareV2Bootstrap(
    _ bootstrap: MobileV2ConversationBootstrap,
    gatewayID: String
  ) throws -> PreparedV2Bootstrap {
    let pendingFollowUpCount = bootstrap.pendingInputs.filter { input in
      input.kind == .followUp && (input.state == .queued || input.state == .delivering)
    }.count
    let hasCanonicalQueueOrder = zip(
      bootstrap.pendingInputs,
      bootstrap.pendingInputs.dropFirst()
    ).allSatisfy { lhs, rhs in
      lhs.enqueueOrder < rhs.enqueueOrder
    }
    guard
      bootstrap.conversation.status != .deleted,
      bootstrap.v2ThroughSeq >= 0,
      bootstrap.conversation.v2LastSeq == bootstrap.v2ThroughSeq,
      bootstrap.conversation.queuePaused == bootstrap.queuePaused,
      bootstrap.conversation.queueRevision == bootstrap.queueRevision,
      bootstrap.conversation.pendingFollowUpCount == pendingFollowUpCount,
      Set(bootstrap.messages.map(\.id)).count == bootstrap.messages.count,
      Set(bootstrap.pendingInputs.map(\.inputId)).count == bootstrap.pendingInputs.count,
      bootstrap.messages.allSatisfy({ $0.conversationId == bootstrap.conversation.id }),
      hasCanonicalQueueOrder
    else { throw PersistenceStoreError.invalidV2Bootstrap }
    try validateV2MessageOwnership(
      bootstrap.messages,
      gatewayID: gatewayID,
      conversationID: bootstrap.conversation.id
    )
    try validateV2PendingInputOwnership(
      bootstrap.pendingInputs,
      gatewayID: gatewayID,
      conversationID: bootstrap.conversation.id
    )
    try requireWritableConversation(
      gatewayID: gatewayID,
      conversationID: bootstrap.conversation.id
    )
    let summary = v1SummaryProjection(bootstrap.conversation)
    if let current = try conversationRecord(
      gatewayID: gatewayID,
      conversationID: bootstrap.conversation.id
    ), current.revision == summary.revision,
      try cachedConversation(from: current).summary != summary
    {
      throw PersistenceStoreError.invalidV2Bootstrap
    }
    return PreparedV2Bootstrap(
      value: bootstrap,
      payload: try ContractCoding.encoder().encode(bootstrap),
      summary: summary
    )
  }

  private func stageV2Bootstrap(
    _ prepared: PreparedV2Bootstrap,
    gatewayID: String,
    historyCursor: String?
  ) throws {
    let bootstrap = prepared.value
    let conversationID = bootstrap.conversation.id
    let key = scopedID(gatewayID: gatewayID, resourceID: conversationID)
    let conversation: ConversationRecord
    if let existing = try conversationRecord(
      gatewayID: gatewayID,
      conversationID: conversationID
    ) {
      conversation = existing
      if prepared.summary.revision > existing.revision {
        apply(prepared.summary, to: existing)
      }
    } else {
      conversation = ConversationRecord(
        scopedID: key,
        gatewayID: gatewayID,
        conversationID: conversationID,
        agentID: prepared.summary.agentId,
        agentName: prepared.summary.agentName,
        title: prepared.summary.title,
        revision: prepared.summary.revision,
        statusRaw: prepared.summary.status.rawValue,
        activeTurnID: prepared.summary.activeTurnId,
        owningIssueID: prepared.summary.owningIssueId,
        projectID: prepared.summary.projectId,
        lastSeq: prepared.summary.lastSeq,
        lastMessagePreview: prepared.summary.lastMessagePreview,
        createdAt: prepared.summary.createdAt,
        updatedAt: prepared.summary.updatedAt,
        deletedAt: prepared.summary.deletedAt
      )
      modelContext.insert(conversation)
    }
    conversation.queuePaused = bootstrap.queuePaused
    conversation.queueRevision = bootstrap.queueRevision
    conversation.pendingFollowUpCount = bootstrap.conversation.pendingFollowUpCount
    conversation.v2LastSeq = bootstrap.v2ThroughSeq
    conversation.v2NextMessageCursor = historyCursor

    let targetGatewayID = gatewayID
    let targetConversationID = conversationID
    for record in try modelContext.fetch(
      FetchDescriptor<MessageRecord>(
        predicate: #Predicate {
          $0.gatewayID == targetGatewayID && $0.conversationID == targetConversationID
            && $0.isV2Anchor
        }
      )
    ) {
      record.isV2Anchor = false
    }
    for message in bootstrap.messages {
      _ = try upsertV2Message(
        message,
        gatewayID: gatewayID,
        isAnchor: true,
        authoritative: true
      )
    }

    for record in try pendingInputRecords(
      gatewayID: gatewayID,
      conversationID: conversationID
    ) {
      modelContext.delete(record)
    }
    for input in bootstrap.pendingInputs {
      modelContext.insert(
        PendingInputRecord(
          scopedID: scopedID(gatewayID: gatewayID, resourceID: input.inputId),
          gatewayID: gatewayID,
          conversationID: conversationID,
          inputID: input.inputId,
          enqueueOrder: input.enqueueOrder,
          payloadData: try ContractCoding.encoder().encode(input)
        )
      )
    }
  }

  private func isExactV2BootstrapDerivedState(
    _ prepared: PreparedV2Bootstrap,
    gatewayID: String
  ) throws -> Bool {
    let bootstrap = prepared.value
    let conversationID = bootstrap.conversation.id
    guard let conversation = try conversationRecord(
      gatewayID: gatewayID,
      conversationID: conversationID
    ),
      conversation.queuePaused == bootstrap.queuePaused,
      conversation.queueRevision == bootstrap.queueRevision,
      conversation.pendingFollowUpCount == bootstrap.conversation.pendingFollowUpCount,
      conversation.v2LastSeq == bootstrap.v2ThroughSeq
    else { return false }

    let targetGatewayID = gatewayID
    let targetConversationID = conversationID
    let currentPageRecords = try modelContext.fetch(
      FetchDescriptor<MessageRecord>(
        predicate: #Predicate {
          $0.gatewayID == targetGatewayID && $0.conversationID == targetConversationID
            && $0.isV2Anchor
        }
      )
    )
    guard currentPageRecords.count == bootstrap.messages.count else { return false }
    let recordsByID = Dictionary(
      uniqueKeysWithValues: currentPageRecords.map { ($0.messageID, $0) }
    )
    for message in bootstrap.messages {
      guard let record = recordsByID[message.id],
        record.conversationID == message.conversationId,
        record.turnID == message.turnId,
        record.ordinal == message.ordinal,
        record.roleRaw == message.role.rawValue,
        record.statusRaw == message.status.rawValue,
        record.contentData == (try ContractCoding.encoder().encode(message.content)),
        record.createdAt == message.createdAt,
        record.updatedAt == message.updatedAt,
        record.runID == message.runId,
        record.segmentIndex == message.segmentIndex,
        record.deliveryKindRaw == message.deliveryKind.rawValue,
        record.deliveryStatusRaw == message.deliveryStatus?.rawValue
      else { return false }
    }

    let pending = try pendingInputRecords(
      gatewayID: gatewayID,
      conversationID: conversationID
    )
    guard pending.count == bootstrap.pendingInputs.count else { return false }
    for (record, input) in zip(pending, bootstrap.pendingInputs) {
      guard
        record.inputID == input.inputId,
        record.enqueueOrder == input.enqueueOrder,
        record.payloadData == (try ContractCoding.encoder().encode(input))
      else { return false }
    }
    return true
  }

  @discardableResult
  private func upsertV2Message(
    _ value: MobileV2ConversationMessage,
    gatewayID: String,
    isAnchor: Bool,
    authoritative: Bool = false
  ) throws -> Bool {
    let key = scopedID(gatewayID: gatewayID, resourceID: value.id)
    let content = try ContractCoding.encoder().encode(value.content)
    if let record = try messageRecord(scopedID: key) {
      guard
        record.gatewayID == gatewayID,
        record.conversationID == value.conversationId,
        record.messageID == value.id
      else { throw PersistenceStoreError.invalidV2Bootstrap }
      let markerChanged = isAnchor && record.isV2Anchor == false
      let canReplace = authoritative || value.updatedAt >= record.updatedAt
      let payloadChanged = isStoredV2Message(record, equalTo: value, content: content) == false
      if canReplace && payloadChanged {
        record.conversationID = value.conversationId
        record.messageID = value.id
        record.turnID = value.turnId
        record.ordinal = value.ordinal
        record.roleRaw = value.role.rawValue
        record.statusRaw = value.status.rawValue
        record.contentData = content
        record.createdAt = value.createdAt
        record.updatedAt = value.updatedAt
        record.runID = value.runId
        record.segmentIndex = value.segmentIndex
        record.deliveryKindRaw = value.deliveryKind.rawValue
        record.deliveryStatusRaw = value.deliveryStatus?.rawValue
      } else if canReplace == false {
        let requiredMetadata = [
          record.runID != nil,
          record.segmentIndex != nil,
          record.deliveryKindRaw != nil,
        ]
        let hasNoMetadata = requiredMetadata.allSatisfy { $0 == false }
          && record.deliveryStatusRaw == nil
        let hasCompleteMetadata = requiredMetadata.allSatisfy { $0 }
        guard hasNoMetadata || hasCompleteMetadata else {
          throw PersistenceStoreError.invalidStoredValue("partial v2 delivery metadata")
        }
        if hasNoMetadata {
          record.runID = value.runId
          record.segmentIndex = value.segmentIndex
          record.deliveryKindRaw = value.deliveryKind.rawValue
          record.deliveryStatusRaw = value.deliveryStatus?.rawValue
        }
        if isAnchor { record.isV2Anchor = true }
        return hasNoMetadata || markerChanged
      }
      if isAnchor { record.isV2Anchor = true }
      return (canReplace && payloadChanged) || markerChanged
    }
    modelContext.insert(
      MessageRecord(
        scopedID: key,
        gatewayID: gatewayID,
        conversationID: value.conversationId,
        messageID: value.id,
        turnID: value.turnId,
        ordinal: value.ordinal,
        roleRaw: value.role.rawValue,
        statusRaw: value.status.rawValue,
        contentData: content,
        createdAt: value.createdAt,
        updatedAt: value.updatedAt,
        runID: value.runId,
        segmentIndex: value.segmentIndex,
        deliveryKindRaw: value.deliveryKind.rawValue,
        deliveryStatusRaw: value.deliveryStatus?.rawValue,
        isV2Anchor: isAnchor
      )
    )
    return true
  }

  private func v2Messages(
    gatewayID: String,
    conversationID: String
  ) throws -> [CachedV2MessageRow] {
    let targetGatewayID = gatewayID
    let targetConversationID = conversationID
    return try modelContext.fetch(
      FetchDescriptor<MessageRecord>(
        predicate: #Predicate {
          $0.gatewayID == targetGatewayID && $0.conversationID == targetConversationID
        },
        sortBy: [
          SortDescriptor(\MessageRecord.ordinal),
          SortDescriptor(\MessageRecord.messageID),
        ]
      )
    ).map(decodeV2Message)
  }

  private func decodeV2Message(_ record: MessageRecord) throws -> CachedV2MessageRow {
    guard let role = MessageRole(rawValue: record.roleRaw) else {
      throw PersistenceStoreError.invalidStoredValue("message role \(record.roleRaw)")
    }
    guard let status = MessageStatus(rawValue: record.statusRaw) else {
      throw PersistenceStoreError.invalidStoredValue("message status \(record.statusRaw)")
    }
    let message = ConversationMessageDTO(
      id: record.messageID,
      conversationId: record.conversationID,
      turnId: record.turnID,
      ordinal: record.ordinal,
      role: role,
      status: status,
      content: try ContractCoding.decoder().decode(MessageContent.self, from: record.contentData),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt
    )
    let metadata = [record.runID != nil, record.segmentIndex != nil, record.deliveryKindRaw != nil]
    guard metadata.allSatisfy({ $0 }) || metadata.allSatisfy({ !$0 }) else {
      throw PersistenceStoreError.invalidStoredValue("partial v2 delivery metadata")
    }
    guard
      let runID = record.runID,
      let segmentIndex = record.segmentIndex,
      let kindRaw = record.deliveryKindRaw
    else { return CachedV2MessageRow(message: message, delivery: nil) }
    guard let kind = MobileV2DeliveryKind(rawValue: kindRaw) else {
      throw PersistenceStoreError.invalidStoredValue("delivery kind \(kindRaw)")
    }
    let deliveryStatus: MobileV2DeliveryStatus?
    if let raw = record.deliveryStatusRaw {
      guard let value = MobileV2DeliveryStatus(rawValue: raw) else {
        throw PersistenceStoreError.invalidStoredValue("delivery status \(raw)")
      }
      deliveryStatus = value
    } else {
      deliveryStatus = nil
    }
    return CachedV2MessageRow(
      message: message,
      delivery: MobileV2MessageDelivery(
        runId: runID,
        segmentIndex: segmentIndex,
        kind: kind,
        status: deliveryStatus
      )
    )
  }

  private func isStoredV2Message(
    _ record: MessageRecord,
    equalTo value: MobileV2ConversationMessage,
    content: Data
  ) -> Bool {
    record.conversationID == value.conversationId
      && record.messageID == value.id
      && record.turnID == value.turnId
      && record.ordinal == value.ordinal
      && record.roleRaw == value.role.rawValue
      && record.statusRaw == value.status.rawValue
      && record.contentData == content
      && record.createdAt == value.createdAt
      && record.updatedAt == value.updatedAt
      && record.runID == value.runId
      && record.segmentIndex == value.segmentIndex
      && record.deliveryKindRaw == value.deliveryKind.rawValue
      && record.deliveryStatusRaw == value.deliveryStatus?.rawValue
  }

  private func validateV2Overlay(
    conversationID: String,
    anchorSequence: Int,
    committedSequence: Int,
    anchorQueueRevision: Int,
    frames: [MobileV2SequencedFrame]
  ) throws {
    guard committedSequence >= anchorSequence else {
      throw PersistenceStoreError.nonContiguousV2Overlay
    }
    let expected = committedSequence == anchorSequence
      ? []
      : Array((anchorSequence + 1)...committedSequence)
    guard
      frames.allSatisfy({ $0.conversationId == conversationID }),
      frames.map(\.v2Seq) == expected
    else {
      throw PersistenceStoreError.nonContiguousV2Overlay
    }
    var queueRevision = anchorQueueRevision
    for frame in frames {
      if let next = frame.queueRevision {
        if next < queueRevision {
          throw PersistenceStoreError.v2QueueRevisionRegression
        }
        queueRevision = next
      }
    }
  }

  private func currentQueueRevision(for projection: CachedV2ConversationProjection) -> Int {
    projection.appliedFrames.reduce(projection.anchor.queueRevision) { current, frame in
      max(current, frame.queueRevision ?? current)
    }
  }

  private func preparedAttachmentsMatch(_ data: Data, images: [MessageImage]) throws -> Bool {
    let attachments = try ContractCoding.decoder().decode([PreparedAttachment].self, from: data)
    guard attachments.count == images.count else { return false }
    return zip(attachments, images).allSatisfy { attachment, image in
      attachment.mediaType == image.mediaType.rawValue
        && attachment.data.base64EncodedString() == image.data
    }
  }

  private func isCanonicalUUID(_ value: String) -> Bool {
    guard let uuid = UUID(uuidString: value) else { return false }
    return uuid.uuidString.lowercased() == value
  }

  private func v1SummaryProjection(_ value: MobileV2ConversationSummary)
    -> ConversationSummaryDTO
  {
    ConversationSummaryDTO(
      id: value.id,
      agentId: value.agentId,
      agentName: value.agentName,
      title: value.title,
      revision: value.revision,
      status: value.status,
      activeTurnId: value.activeTurnId,
      owningIssueId: value.owningIssueId,
      projectId: value.projectId,
      lastSeq: value.lastSeq,
      lastMessagePreview: value.lastMessagePreview,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
      deletedAt: value.deletedAt
    )
  }

  private func pendingInputRecords(
    gatewayID: String,
    conversationID: String
  ) throws -> [PendingInputRecord] {
    let targetGatewayID = gatewayID
    let targetConversationID = conversationID
    return try modelContext.fetch(
      FetchDescriptor<PendingInputRecord>(
        predicate: #Predicate {
          $0.gatewayID == targetGatewayID && $0.conversationID == targetConversationID
        },
        sortBy: [
          SortDescriptor(\PendingInputRecord.enqueueOrder),
          SortDescriptor(\PendingInputRecord.inputID),
        ]
      )
    )
  }

  private func pendingInputRecord(scopedID: String) throws -> PendingInputRecord? {
    let key = scopedID
    var descriptor = FetchDescriptor<PendingInputRecord>(
      predicate: #Predicate { $0.scopedID == key }
    )
    descriptor.fetchLimit = 1
    return try modelContext.fetch(descriptor).first
  }

  private func validateV2MessageOwnership(
    _ messages: [MobileV2ConversationMessage],
    gatewayID: String,
    conversationID: String
  ) throws {
    for message in messages {
      let key = scopedID(gatewayID: gatewayID, resourceID: message.id)
      if let record = try messageRecord(scopedID: key),
        record.gatewayID != gatewayID || record.conversationID != conversationID
      {
        throw PersistenceStoreError.invalidV2Bootstrap
      }
    }
  }

  private func validateV2PendingInputOwnership(
    _ inputs: [MobileV2PendingInput],
    gatewayID: String,
    conversationID: String
  ) throws {
    let admissions = try pendingV2AdmissionRecords(gatewayID: gatewayID)
    for input in inputs {
      let key = scopedID(gatewayID: gatewayID, resourceID: input.inputId)
      if let record = try pendingInputRecord(scopedID: key),
        record.gatewayID != gatewayID || record.conversationID != conversationID
      {
        throw PersistenceStoreError.invalidV2Bootstrap
      }
      if admissions.contains(where: {
        $0.inputID == input.inputId && $0.conversationID != conversationID
      }) {
        throw PersistenceStoreError.invalidV2Bootstrap
      }
    }
  }

  private func v2AppliedFrameRecords(
    gatewayID: String,
    conversationID: String
  ) throws -> [V2AppliedFrameRecord] {
    let targetGatewayID = gatewayID
    let targetConversationID = conversationID
    return try modelContext.fetch(
      FetchDescriptor<V2AppliedFrameRecord>(
        predicate: #Predicate {
          $0.gatewayID == targetGatewayID && $0.conversationID == targetConversationID
        },
        sortBy: [SortDescriptor(\V2AppliedFrameRecord.sequence)]
      )
    )
  }

  private func v2BootstrapAnchorRecord(
    scopedConversationID: String
  ) throws -> V2BootstrapAnchorRecord? {
    let key = scopedConversationID
    var descriptor = FetchDescriptor<V2BootstrapAnchorRecord>(
      predicate: #Predicate { $0.scopedConversationID == key }
    )
    descriptor.fetchLimit = 1
    return try modelContext.fetch(descriptor).first
  }

  private func v2ReplayCursorRecord(
    scopedConversationID: String
  ) throws -> V2ReplayCursorRecord? {
    let key = scopedConversationID
    var descriptor = FetchDescriptor<V2ReplayCursorRecord>(
      predicate: #Predicate { $0.scopedConversationID == key }
    )
    descriptor.fetchLimit = 1
    return try modelContext.fetch(descriptor).first
  }

  private func v2AppliedFrameRecord(
    scopedSequenceID: String
  ) throws -> V2AppliedFrameRecord? {
    let key = scopedSequenceID
    var descriptor = FetchDescriptor<V2AppliedFrameRecord>(
      predicate: #Predicate { $0.scopedSequenceID == key }
    )
    descriptor.fetchLimit = 1
    return try modelContext.fetch(descriptor).first
  }

  private func v2AppliedFrameRecord(
    gatewayID: String,
    conversationID: String,
    sequence: Int
  ) throws -> V2AppliedFrameRecord? {
    try v2AppliedFrameRecord(
      scopedSequenceID: v2SequenceID(
        gatewayID: gatewayID,
        conversationID: conversationID,
        sequence: sequence
      )
    )
  }

  private func pendingV2AdmissionRecord(
    scopedConversationID: String
  ) throws -> PendingV2AdmissionRecord? {
    let key = scopedConversationID
    var descriptor = FetchDescriptor<PendingV2AdmissionRecord>(
      predicate: #Predicate { $0.scopedConversationID == key }
    )
    descriptor.fetchLimit = 1
    return try modelContext.fetch(descriptor).first
  }

  private func pendingV2AdmissionRecords(
    gatewayID: String
  ) throws -> [PendingV2AdmissionRecord] {
    let targetGatewayID = gatewayID
    return try modelContext.fetch(
      FetchDescriptor<PendingV2AdmissionRecord>(
        predicate: #Predicate { $0.gatewayID == targetGatewayID }
      )
    )
  }

  private func v2SequenceID(
    gatewayID: String,
    conversationID: String,
    sequence: Int
  ) -> String {
    "\(gatewayID)|\(conversationID)|\(sequence)"
  }

  private func scopedID(gatewayID: String, resourceID: String) -> String {
    "\(gatewayID)|\(resourceID)"
  }
}

private extension MobileV2SequencedFrame {
  var queueRevision: Int? {
    switch self {
    case let .inputAccepted(_, _, _, value, _),
      let .inputUpdated(_, _, _, value, _),
      let .inputRemoved(_, _, _, value, _),
      let .inputFailed(_, _, _, value, _),
      let .inputDelivered(_, _, _, value, _, _, _, _, _),
      let .queuePaused(_, _, _, value, _, _),
      let .queueResumed(_, _, _, value, _, _):
      value
    case .accepted, .event, .done, .error:
      nil
    }
  }
}
