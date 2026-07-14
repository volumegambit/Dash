import Foundation
import SwiftData

enum PersistenceStoreError: Error, Equatable, Sendable {
  case invalidTombstoneStatus
  case invalidStoredValue(String)
  case conversationDeleted(gatewayID: String, conversationID: String)
}

@ModelActor
actor PersistenceStore {
  static func inMemory() throws -> PersistenceStore {
    let schema = persistenceSchema()
    let configuration = ModelConfiguration(schema: schema, isStoredInMemoryOnly: true)
    let container = try ModelContainer(for: schema, configurations: [configuration])
    return PersistenceStore(modelContainer: container)
  }

  static func stored(at url: URL) throws -> PersistenceStore {
    let schema = persistenceSchema()
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
    do {
      for value in values {
        let wasApplied = try upsertConversation(value, gatewayID: gatewayID)
        if wasApplied, value.status == .deleted {
          try purgeConversationContent(gatewayID: gatewayID, conversationID: value.id)
        }
      }
      try modelContext.save()
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
    do {
      try stageTombstone(value, gatewayID: gatewayID)
      try modelContext.save()
    } catch {
      modelContext.rollback()
      throw error
    }
  }

  func applyTombstone(
    _ value: ConversationSummaryDTO,
    gatewayID: String,
    saveChanges: @Sendable () throws -> Void
  ) throws {
    do {
      try stageTombstone(value, gatewayID: gatewayID)
      try saveChanges()
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

  func removeConversation(gatewayID: String, conversationID: String) throws {
    do {
      if let record = try conversationRecord(
        gatewayID: gatewayID,
        conversationID: conversationID
      ) {
        modelContext.delete(record)
      }
      try purgeConversationContent(gatewayID: gatewayID, conversationID: conversationID)
      try modelContext.save()
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
    try requireWritableConversation(gatewayID: gatewayID, conversationID: conversationID)
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
    conversationID: String
  ) throws {
    try requireWritableConversation(gatewayID: gatewayID, conversationID: conversationID)
    let key = scopedID(gatewayID: gatewayID, resourceID: conversationID)
    let attachments = try ContractCoding.encoder().encode(draft.attachments)
    if let record = try draftRecord(scopedConversationID: key) {
      record.text = draft.text
      record.attachmentsData = attachments
      record.updatedAt = draft.updatedAt
    } else {
      modelContext.insert(
        DraftRecord(
          scopedConversationID: key,
          gatewayID: gatewayID,
          conversationID: conversationID,
          text: draft.text,
          attachmentsData: attachments,
          updatedAt: draft.updatedAt
        )
      )
    }
    try modelContext.save()
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
      updatedAt: record.updatedAt
    )
  }

  func pendingSend(gatewayID: String, conversationID: String) throws -> PendingChatSend? {
    let key = scopedID(gatewayID: gatewayID, resourceID: conversationID)
    guard let record = try pendingSendRecord(scopedConversationID: key) else { return nil }
    return PendingChatSend(
      turnID: record.turnID,
      localUserID: record.localUserID,
      draft: record.draft,
      attachments: try ContractCoding.decoder().decode(
        [PreparedAttachment].self,
        from: record.attachmentsData
      ),
      createdAt: record.createdAt
    )
  }

  func stagePendingSend(
    _ pending: PendingChatSend,
    gatewayID: String,
    conversationID: String
  ) throws {
    try requireWritableConversation(gatewayID: gatewayID, conversationID: conversationID)
    let key = scopedID(gatewayID: gatewayID, resourceID: conversationID)
    let attachments = try ContractCoding.encoder().encode(pending.attachments)
    if let record = try pendingSendRecord(scopedConversationID: key) {
      record.turnID = pending.turnID
      record.localUserID = pending.localUserID
      record.draft = pending.draft
      record.attachmentsData = attachments
      record.createdAt = pending.createdAt
    } else {
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
    }
    if let draft = try draftRecord(scopedConversationID: key) {
      modelContext.delete(draft)
    }
    do {
      try modelContext.save()
    } catch {
      modelContext.rollback()
      throw error
    }
  }

  func clearPendingSend(
    gatewayID: String,
    conversationID: String,
    turnID: String
  ) throws {
    let key = scopedID(gatewayID: gatewayID, resourceID: conversationID)
    guard let record = try pendingSendRecord(scopedConversationID: key),
      record.turnID == turnID
    else { return }
    modelContext.delete(record)
    do {
      try modelContext.save()
    } catch {
      modelContext.rollback()
      throw error
    }
  }

  func restorePendingSendAsDraft(
    gatewayID: String,
    conversationID: String,
    turnID: String
  ) throws -> ConversationDraft? {
    try requireWritableConversation(gatewayID: gatewayID, conversationID: conversationID)
    let key = scopedID(gatewayID: gatewayID, resourceID: conversationID)
    guard let pending = try pendingSendRecord(scopedConversationID: key),
      pending.turnID == turnID
    else { return nil }
    let attachments = try ContractCoding.decoder().decode(
      [PreparedAttachment].self,
      from: pending.attachmentsData
    )
    let draftText = pending.draft
    let updatedAt = Date()
    if let draft = try draftRecord(scopedConversationID: key) {
      draft.text = draftText
      draft.attachmentsData = pending.attachmentsData
      draft.updatedAt = updatedAt
    } else {
      modelContext.insert(
        DraftRecord(
          scopedConversationID: key,
          gatewayID: gatewayID,
          conversationID: conversationID,
          text: draftText,
          attachmentsData: pending.attachmentsData,
          updatedAt: updatedAt
        )
      )
    }
    modelContext.delete(pending)
    do {
      try modelContext.save()
    } catch {
      modelContext.rollback()
      throw error
    }
    return ConversationDraft(text: draftText, attachments: attachments, updatedAt: updatedAt)
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
    try requireWritableConversation(gatewayID: gatewayID, conversationID: conversationID)
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

  func clearGateway(gatewayID: String) throws {
    let targetGatewayID = gatewayID
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
    try modelContext.save()
  }

  private func upsertConversation(
    _ value: ConversationSummaryDTO,
    gatewayID: String
  ) throws -> Bool {
    if let record = try conversationRecord(gatewayID: gatewayID, conversationID: value.id) {
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
    return true
  }

  private func requireWritableConversation(
    gatewayID: String,
    conversationID: String
  ) throws {
    let record = try conversationRecord(
      gatewayID: gatewayID,
      conversationID: conversationID
    )
    guard record?.statusRaw != ConversationStatus.deleted.rawValue else {
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
    for record in try modelContext.fetch(
      FetchDescriptor<DraftRecord>(
        predicate: #Predicate {
          $0.gatewayID == targetGatewayID && $0.conversationID == targetConversationID
        }
      )
    ) {
      modelContext.delete(record)
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

  private func scopedID(gatewayID: String, resourceID: String) -> String {
    "\(gatewayID)|\(resourceID)"
  }
}

private func persistenceSchema() -> Schema {
  Schema([
    GatewayProfileRecord.self,
    ConversationRecord.self,
    MessageRecord.self,
    AgentRecord.self,
    DraftRecord.self,
    PendingSendRecord.self,
    ReplayCursorRecord.self,
  ])
}
