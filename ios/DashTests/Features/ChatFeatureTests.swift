import Foundation
import Testing

@testable import Dash

@Suite("Chat feature", .serialized)
@MainActor
struct ChatFeatureTests {
  @Test("opening publishes cache and draft before the canonical first page")
  func cachedFirstOpening() async throws {
    let gate = TestGate()
    let cached = message(id: "cached-user", text: "Saved", ordinal: 1)
    let canonical = message(id: "canonical-user", text: "Fresh", ordinal: 2)
    let persistence = FakeChatPersistence(
      messages: [cached],
      draft: ConversationDraft(text: "unfinished", attachments: [], updatedAt: .distantPast),
      cursor: 3
    )
    let sync = FakeChatSynchronizer()
    await sync.enqueueRefresh(
      .success(snapshot(messages: [canonical], throughSeq: 4)),
      waitingOn: gate
    )
    let feature = makeFeature(persistence: persistence, sync: sync)
    feature.setConnection(.online)

    let opening = Task { await feature.appear() }
    await gate.waitUntilWaiting()

    #expect(feature.state.messages.map(\.id) == [cached.id])
    #expect(feature.state.draft == "unfinished")
    #expect(feature.state.lastAppliedSeq == 3)
    #expect(feature.isAuthoritative == false)

    await gate.release()
    await opening.value

    #expect(feature.state.messages.map(\.id) == [canonical.id])
    #expect(feature.state.lastAppliedSeq == 4)
    #expect(feature.isAuthoritative)
  }

  @Test("online transport does not authorize send before canonical refresh")
  func transportOnlineIsNotCanonicalAuthority() async {
    let gate = TestGate()
    let sync = FakeChatSynchronizer()
    await sync.enqueueRefresh(.success(snapshot()), waitingOn: gate)
    let chat = FakeChatFeatureTransport()
    let feature = makeFeature(sync: sync, chat: chat)
    feature.setConnection(.online)
    await feature.updateDraft("Wait for authority")

    #expect(feature.canSend == false)
    await feature.send()
    #expect(await chat.calls.isEmpty)

    let opening = Task { await feature.appear() }
    await gate.waitUntilWaiting()
    #expect(feature.canSend == false)
    await gate.release()
    await opening.value

    #expect(feature.canSend)
  }

  @Test("send trims outer whitespace, clears the persisted draft, and sends one resumable turn")
  func sendUsesOneTurnID() async throws {
    let recorder = ChatOperationRecorder()
    let persistence = FakeChatPersistence(recorder: recorder)
    let sync = FakeChatSynchronizer(recorder: recorder)
    let chat = FakeChatFeatureTransport(recorder: recorder)
    let turnID = UUID(uuidString: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE")!
    let localID = UUID(uuidString: "11111111-2222-3333-4444-555555555555")!
    let feature = makeFeature(
      persistence: persistence,
      sync: sync,
      chat: chat,
      ids: [turnID.uuidString.lowercased(), localID.uuidString.lowercased()]
    )
    feature.setConnection(.online)
    await feature.appear()
    await feature.updateDraft(" \n Hello Dash \n ")

    await feature.send()

    let calls = await chat.calls
    #expect(
      calls == [
        .connect,
        .send(
          turnID: turnID.uuidString.lowercased(),
          agentID: "agent-1",
          conversationID: "conv-1",
          text: "Hello Dash",
          images: []
        ),
      ])
    #expect(feature.state.draft.isEmpty)
    #expect(feature.state.attachments.isEmpty)
    #expect(feature.state.activeTurnID == turnID.uuidString.lowercased())
    #expect(feature.state.messages.last?.user?.text == "Hello Dash")
    let operations = await recorder.operations
    let stagedSend = try #require(operations.lastIndex(of: "persist.pending.stage"))
    let connect = try #require(operations.lastIndex(of: "chat.connect"))
    let send = try #require(operations.lastIndex(of: "chat.send"))
    #expect(stagedSend < connect)
    #expect(connect < send)
  }

  @Test("an ambiguous send that was admitted reconciles and resumes the same turn ID")
  func ambiguousAdmittedSendResumesSameTurn() async throws {
    let persistence = FakeChatPersistence()
    let sync = FakeChatSynchronizer()
    let chat = FakeChatFeatureTransport()
    await chat.enqueueSend(.failure(.transport("socket closed after send")))
    let feature = makeFeature(persistence: persistence, sync: sync, chat: chat)
    feature.setConnection(.online)
    await feature.appear()
    await sync.enqueueRefresh(
      .success(
        snapshot(
          summary: summary(revision: 2, status: .running, activeTurnID: "turn-1", lastSeq: 4),
          messages: [
            message(id: "user-1", text: "Keep this admitted message", ordinal: 1),
            message(
              id: "assistant-1",
              role: .assistant,
              status: .streaming,
              ordinal: 2
            ),
          ],
          throughSeq: 4
        )
      )
    )
    await feature.updateDraft("Keep this admitted message")

    await feature.send()

    #expect(feature.state.draft.isEmpty)
    #expect(feature.state.activeTurnID == "turn-1")
    #expect(feature.state.messages.map(\.id) == ["user-1", "assistant-1"])
    #expect(await persistence.persistedDraft == nil)
    let calls = await chat.calls
    let sends = calls.compactMap(\.sentPayload)
    #expect(sends.count == 1)
    #expect(
      calls.contains(
        .resume(
          turnID: "turn-1",
          agentID: "agent-1",
          conversationID: "conv-1",
          sinceSeq: 4
        )
      )
    )
  }

  @Test("live tombstone refresh preserves a file-backed pending payload across restart")
  func liveTombstonePreservesPendingPayloadAcrossRestart() async throws {
    URLProtocolStub.reset()
    let directory = FileManager.default.temporaryDirectory.appending(
      path: UUID().uuidString,
      directoryHint: .isDirectory
    )
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let storeURL = directory.appending(path: "dash.store")
    let store = try PersistenceStore.stored(at: storeURL)
    let initial = summary()
    let tombstone = deletedSummary(revision: 2)
    try await store.upsertConversations([initial], gatewayID: "gateway-1")
    URLProtocolStub.enqueue(
      status: 200,
      data: try ContractCoding.encoder().encode(initial)
    )
    URLProtocolStub.enqueue(
      status: 200,
      data: try ContractCoding.encoder().encode(
        ConversationMessagePageDTO(items: [], nextCursor: nil, throughSeq: 0)
      )
    )
    URLProtocolStub.enqueue(
      status: 200,
      data: try ContractCoding.encoder().encode(tombstone)
    )
    let api = makeChatGatewayAPI()
    let sync = LiveChatSynchronizer(
      gatewayID: "gateway-1",
      store: store,
      makeAPI: { api }
    )
    let chat = FakeChatFeatureTransport()
    await chat.enqueueSend(.failure(.transport("socket closed after send")))
    let ids = SequentialUUIDSource(ids: ["turn-live", "local-live"])
    let feature = ChatFeature(
      gatewayID: "gateway-1",
      conversation: initial,
      persistence: LiveChatPersistence(store: store),
      synchronizer: sync,
      transport: chat,
      clock: TestAppClock(now: Date(timeIntervalSince1970: 1_000)),
      announcer: FakeChatAccessibilityAnnouncer(),
      validator: ImageAttachmentValidator(makeID: {
        UUID(uuidString: "99999999-8888-7777-6666-555555555555")!
      }),
      makeID: { ids.next() }
    )
    feature.setConnection(.online)
    await feature.appear()
    await feature.updateDraft("  Preserve exact pending text  ")
    await feature.addSelections([ImageSelection(data: Data([0x00, 0x7F, 0xFF]), type: .png)])
    let attachments = feature.state.attachments

    await feature.send()

    let expected = PendingChatSend(
      turnID: "turn-live",
      localUserID: "local-live",
      draft: "  Preserve exact pending text  ",
      attachments: attachments,
      createdAt: Date(timeIntervalSince1970: 1_000)
    )
    #expect(feature.state.conversation == tombstone)
    #expect(feature.draftEditingAllowed == false)
    #expect(feature.canSend == false)
    #expect(
      try await store.pendingSend(gatewayID: "gateway-1", conversationID: "conv-1") == expected
    )
    #expect(await chat.calls.compactMap(\.sentPayload).count == 1)

    await feature.shutdown()
    let reopened = try PersistenceStore.stored(at: storeURL)
    #expect(
      try await reopened.conversation(gatewayID: "gateway-1", id: "conv-1")?.summary
        == tombstone
    )
    #expect(
      try await reopened.pendingSend(gatewayID: "gateway-1", conversationID: "conv-1")
        == expected
    )
    #expect(await chat.calls.compactMap(\.sentPayload).count == 1)
  }

  @Test("a protocol failure before acceptance keeps the pending composer locked")
  func protocolFailureBeforeAcceptanceKeepsPending() async {
    let persistence = FakeChatPersistence()
    let sync = FakeChatSynchronizer()
    let chat = FakeChatFeatureTransport()
    let feature = makeFeature(persistence: persistence, sync: sync, chat: chat)
    feature.setConnection(.online)
    await feature.appear()
    await feature.updateDraft("Keep this until acceptance")
    await feature.addSelections([ImageSelection(data: Data([1, 2, 3]), type: .png)])
    let originalAttachments = feature.state.attachments

    await feature.send()
    await sync.enqueueRefresh(.success(snapshot()))
    await chat.finish(throwing: GatewayError.updateRequired)

    await eventually {
      guard await persistence.persistedPendingSend?.turnID == "turn-1" else { return false }
      return await featureConnection(feature) == .updateRequired
    }
    #expect(feature.state.draft.isEmpty)
    #expect(feature.state.attachments.isEmpty)
    #expect(feature.state.activeTurnID == "turn-1")
    #expect(feature.state.messages.first?.user?.text == "Keep this until acceptance")
    #expect(feature.draftEditingAllowed == false)
    #expect(await persistence.persistedPendingSend?.attachments == originalAttachments)
    #expect(await persistence.persistedDraft == nil)
    #expect(await chat.calls.compactMap(\.sentPayload).count == 1)
  }

  @Test("an explicit pre-admission rejection restores the original composer payload")
  func explicitRejectionRestoresComposer() async {
    let persistence = FakeChatPersistence()
    let sync = FakeChatSynchronizer()
    let chat = FakeChatFeatureTransport()
    let feature = makeFeature(persistence: persistence, sync: sync, chat: chat)
    feature.setConnection(.online)
    await feature.appear()
    await feature.updateDraft("Rejected without admission")
    await feature.addSelections([ImageSelection(data: Data([3, 2, 1]), type: .png)])
    let attachments = feature.state.attachments

    await feature.send()
    await sync.enqueueRefresh(.failure(.gatewayOffline))
    await chat.yield(
      .frame(
        .error(
          id: "turn-1",
          conversationId: "conv-1",
          seq: nil,
          error: "The message was rejected",
          code: "validation_failed",
          retryable: false,
          activeTurnId: nil
        )
      )
    )

    await eventually {
      await persistence.persistedDraft?.text == "Rejected without admission"
    }
    #expect(feature.state.draft == "Rejected without admission")
    #expect(feature.state.attachments == attachments)
    #expect(feature.state.activeTurnID == nil)
    #expect(await persistence.persistedPendingSend == nil)
  }

  @Test("restart and explicit retry reuse one pending identity until delayed admission")
  func delayedAdmissionAfterRestartReusesPendingIdentity() async {
    let persistence = FakeChatPersistence()
    let firstSync = FakeChatSynchronizer()
    let firstChat = FakeChatFeatureTransport()
    await firstChat.enqueueSend(.failure(.transport("socket closed after send")))
    let first = makeFeature(persistence: persistence, sync: firstSync, chat: firstChat)
    first.setConnection(.online)
    await first.appear()
    await firstSync.enqueueRefresh(.failure(.gatewayOffline))
    await first.updateDraft("Recover after restart")
    await first.addSelections([ImageSelection(data: Data([4, 5, 6]), type: .png)])
    let originalAttachments = first.state.attachments

    await first.send()
    await first.shutdown()

    #expect(await persistence.persistedPendingSend?.turnID == "turn-1")
    #expect(await persistence.persistedPendingSend?.attachments == originalAttachments)

    let replacementSync = FakeChatSynchronizer()
    await replacementSync.enqueueRefresh(.success(snapshot()))
    let replacementChat = FakeChatFeatureTransport()
    let replacement = makeFeature(
      persistence: persistence,
      sync: replacementSync,
      chat: replacementChat,
      ids: ["fresh-turn-must-not-be-used", "fresh-local-must-not-be-used"]
    )
    replacement.setConnection(.online)
    await replacement.appear()

    #expect(replacement.state.draft.isEmpty)
    #expect(replacement.state.attachments.isEmpty)
    #expect(replacement.state.activeTurnID == "turn-1")
    #expect(replacement.state.messages.first?.id == "local-1")
    #expect(replacement.state.messages.first?.user?.text == "Recover after restart")
    #expect(replacement.draftEditingAllowed == false)
    #expect(await persistence.persistedPendingSend?.attachments == originalAttachments)
    #expect(await firstChat.calls.compactMap(\.sentPayload).count == 1)
    #expect(await replacementChat.calls.compactMap(\.sentPayload).isEmpty)

    await replacementSync.enqueueRefresh(.success(snapshot()))
    await replacement.sceneWillEnterForeground()
    #expect(await replacementChat.calls.compactMap(\.sentPayload).isEmpty)

    await replacementChat.yield(.state(.reconnecting(attempt: 1)))
    await replacementChat.yield(.state(.connected))
    await eventually { await featureTransport(replacement) == .connected }
    #expect(await replacementChat.calls.compactMap(\.sentPayload).isEmpty)

    await replacementSync.enqueueRefresh(.success(snapshot()))
    await replacement.retryConnection()

    let firstSend = await firstChat.calls.compactMap(\.sendCall).first
    let retriedSend = await replacementChat.calls.compactMap(\.sendCall).first
    #expect(retriedSend == firstSend)
    #expect(retriedSend?.turnID == "turn-1")
    #expect(retriedSend?.text == "Recover after restart")
    #expect(await persistence.persistedPendingSend?.turnID == "turn-1")
    #expect(replacement.draftEditingAllowed == false)

    await replacementSync.enqueueRefresh(
      .success(
        snapshot(
          summary: summary(revision: 2),
          messages: [
            message(
              id: "canonical-user",
              text: "Recover after restart",
              ordinal: 1
            ),
            message(
              id: "canonical-assistant",
              role: .assistant,
              ordinal: 2
            ),
          ],
          throughSeq: 1
        )
      )
    )
    await replacementChat.yield(.frame(accepted(seq: 1)))
    await eventually {
      guard await persistence.persistedPendingSend == nil else { return false }
      return await featureMessageIDs(replacement) == ["canonical-user", "canonical-assistant"]
    }

    #expect(Set(replacement.state.messages.map(\.turnID)) == ["turn-1"])
    #expect(replacement.state.messages.count == 2)
    #expect(await firstChat.calls.compactMap(\.sentPayload).count == 1)
    #expect(await replacementChat.calls.compactMap(\.sentPayload).count == 1)
  }

  @Test("an empty equal snapshot cannot prove that a pending send was not admitted")
  func equalSnapshotRetainsPendingComposer() async {
    let persistence = FakeChatPersistence()
    let sync = FakeChatSynchronizer()
    let chat = FakeChatFeatureTransport()
    await chat.enqueueSend(.failure(.transport("socket closed before send")))
    let feature = makeFeature(persistence: persistence, sync: sync, chat: chat)
    feature.setConnection(.online)
    await feature.appear()
    await sync.enqueueRefresh(.success(snapshot()))
    await feature.updateDraft("Keep this unsent message")
    await feature.addSelections([ImageSelection(data: Data([1, 2, 3]), type: .png)])
    let originalAttachments = feature.state.attachments

    await feature.send()

    #expect(feature.state.draft.isEmpty)
    #expect(feature.state.attachments.isEmpty)
    #expect(feature.state.activeTurnID == "turn-1")
    #expect(feature.state.messages.first?.user?.text == "Keep this unsent message")
    #expect(feature.draftEditingAllowed == false)
    #expect(feature.canSend == false)
    #expect(await persistence.persistedPendingSend?.attachments == originalAttachments)
    #expect(await persistence.persistedDraft == nil)
    #expect(await chat.calls.compactMap(\.sentPayload).count == 1)
  }

  @Test("automatic connection recovery audits a pending send without resending")
  func automaticConnectionRecoveryDoesNotRetryPendingSend() async {
    let persistence = FakeChatPersistence()
    let sync = FakeChatSynchronizer()
    let chat = FakeChatFeatureTransport()
    await chat.enqueueSend(.failure(.transport("socket closed after send")))
    let feature = makeFeature(persistence: persistence, sync: sync, chat: chat)
    feature.setConnection(.online)
    await feature.appear()
    await sync.enqueueRefresh(.failure(.gatewayOffline))
    await feature.updateDraft("Only retry after an explicit tap")
    await feature.send()
    feature.setConnection(.offline)
    await sync.enqueueRefresh(.success(snapshot(summary: summary(revision: 2))))

    feature.setConnection(.online)
    await feature.connectionDidBecomeOnline()

    #expect(await chat.calls.compactMap(\.sentPayload).count == 1)
    #expect(await persistence.persistedPendingSend?.turnID == "turn-1")
    #expect(feature.state.activeTurnID == "turn-1")
    #expect(feature.draftEditingAllowed == false)
  }

  @Test("admission by active turn keeps optimistic content until messages are readable")
  func admittedSummaryRetainsOptimisticMessage() async {
    let sync = FakeChatSynchronizer()
    let chat = FakeChatFeatureTransport()
    await chat.enqueueSend(.failure(.transport("socket closed after send")))
    let feature = makeFeature(sync: sync, chat: chat)
    feature.setConnection(.online)
    await feature.appear()
    await sync.enqueueRefresh(
      .success(
        snapshot(
          summary: summary(revision: 2, status: .running, activeTurnID: "turn-1", lastSeq: 1),
          throughSeq: 1
        )
      )
    )
    await feature.updateDraft("Keep the optimistic content")

    await feature.send()

    #expect(feature.state.activeTurnID == "turn-1")
    #expect(feature.state.messages.count == 1)
    #expect(feature.state.messages.first?.turnID == "turn-1")
    #expect(feature.state.messages.first?.user?.text == "Keep the optimistic content")
    #expect(await chat.calls.compactMap(\.sentPayload).count == 1)
  }

  @Test("unavailable reconciliation preserves the pending turn until an explicit retry")
  func unavailableSendReconciliationRetainsPendingTurn() async {
    let persistence = FakeChatPersistence()
    let sync = FakeChatSynchronizer()
    let chat = FakeChatFeatureTransport()
    await chat.enqueueSend(.failure(.transport("socket closed after send")))
    let feature = makeFeature(persistence: persistence, sync: sync, chat: chat)
    feature.setConnection(.online)
    await feature.appear()
    await sync.enqueueRefresh(.failure(.gatewayOffline))
    await feature.updateDraft("Do not lose or duplicate this")

    await feature.send()

    #expect(feature.state.draft.isEmpty)
    #expect(feature.state.activeTurnID == "turn-1")
    #expect(feature.state.messages.count == 1)
    #expect(feature.state.messages.first?.turnID == "turn-1")
    #expect(feature.state.messages.first?.user?.text == "Do not lose or duplicate this")
    #expect(feature.canSend == false)
    #expect(await chat.calls.compactMap(\.sentPayload).count == 1)

    feature.setConnection(.online)
    await sync.enqueueRefresh(.success(snapshot(summary: summary(revision: 2))))
    await feature.retryConnection()

    let sends = await chat.calls.compactMap(\.sendCall)
    #expect(sends.count == 2)
    #expect(sends.map(\.turnID) == ["turn-1", "turn-1"])
    #expect(
      sends.map(\.text) == ["Do not lose or duplicate this", "Do not lose or duplicate this"]
    )
    #expect(feature.state.draft.isEmpty)
    #expect(feature.state.activeTurnID == "turn-1")
    #expect(await persistence.persistedPendingSend?.turnID == "turn-1")
  }

  @Test("a stale canonical read cannot prove that an ambiguous turn was rejected")
  func staleSendReconciliationRetainsPendingTurn() async {
    let sync = FakeChatSynchronizer()
    let chat = FakeChatFeatureTransport()
    await chat.enqueueSend(.failure(.transport("socket closed after send")))
    let feature = makeFeature(sync: sync, chat: chat)
    feature.setConnection(.online)
    await feature.appear()
    await sync.enqueueRefresh(.success(snapshot(summary: summary(revision: 0))))
    await feature.updateDraft("Keep pending until a current read")

    await feature.send()

    #expect(feature.state.draft.isEmpty)
    #expect(feature.state.activeTurnID == "turn-1")
    #expect(feature.state.messages.first?.user?.text == "Keep pending until a current read")
    #expect(feature.isAuthoritative == false)
    #expect(feature.canSend == false)
    #expect(await chat.calls.compactMap(\.sentPayload).count == 1)
  }

  @Test("an image-only draft can send and base64 conversion happens at the send boundary")
  func sendsImageOnlyDraft() async throws {
    let raw = Data(repeating: 9, count: 8)
    let persistence = FakeChatPersistence()
    let chat = FakeChatFeatureTransport()
    let feature = makeFeature(persistence: persistence, chat: chat)
    feature.setConnection(.online)
    await feature.appear()
    await feature.addSelections([ImageSelection(data: raw, type: .png)])
    await feature.updateDraft("  \n ")

    await feature.send()

    let sent = try #require(await chat.calls.compactMap(\.sentPayload).first)
    #expect(sent.text.isEmpty)
    #expect(sent.images == [MessageImage(mediaType: .png, data: raw.base64EncodedString())])
    #expect(await persistence.persistedDraft == nil)
  }

  @Test("a failed draft clear aborts send and restores the unsent composer")
  func failedDraftClearAbortsSend() async {
    let persistence = FakeChatPersistence(failingSaveCalls: [2])
    let chat = FakeChatFeatureTransport()
    let feature = makeFeature(persistence: persistence, chat: chat)
    feature.setConnection(.online)
    await feature.appear()
    await feature.updateDraft("Keep this message")

    await feature.send()

    #expect(await chat.calls.isEmpty)
    #expect(feature.state.draft == "Keep this message")
    #expect(feature.state.activeTurnID == nil)
    #expect(feature.draftStatus == .failed)
  }

  @Test("authority loss while clearing the draft aborts send and restores the composer")
  func authorityLossDuringDraftClearAbortsSend() async {
    let clearGate = TestGate()
    let persistence = FakeChatPersistence(saveGates: [2: clearGate])
    let chat = FakeChatFeatureTransport()
    let feature = makeFeature(persistence: persistence, chat: chat)
    feature.setConnection(.online)
    await feature.appear()
    await feature.updateDraft("Keep this message")

    let sending = Task { await feature.send() }
    await clearGate.waitUntilWaiting()
    feature.setConnection(.offline)
    await clearGate.release()
    await sending.value

    #expect(await chat.calls.isEmpty)
    #expect(feature.state.draft == "Keep this message")
    #expect(await persistence.persistedDraft?.text == "Keep this message")
    #expect(feature.state.activeTurnID == nil)
  }

  @Test("shutdown during staging never clears the composer before the pending send is durable")
  func shutdownDuringPendingSendStagingPreservesDraft() async {
    let stageGate = TestGate()
    let persistence = FakeChatPersistence(saveGates: [2: stageGate])
    let chat = FakeChatFeatureTransport()
    let feature = makeFeature(persistence: persistence, chat: chat)
    feature.setConnection(.online)
    await feature.appear()
    await feature.updateDraft("Keep this through shutdown")

    let sending = Task { await feature.send() }
    await stageGate.waitUntilWaiting()
    #expect(feature.state.draft == "Keep this through shutdown")

    let shutdown = Task { await feature.shutdown() }
    await Task.yield()
    await stageGate.release()
    await sending.value
    await shutdown.value

    #expect(await chat.calls.compactMap(\.sentPayload).isEmpty)
    #expect(feature.state.draft == "Keep this through shutdown")
    #expect(await persistence.persistedDraft?.text == "Keep this through shutdown")
    #expect(await persistence.persistedPendingSend == nil)
  }

  @Test("shutdown closes dependencies before waiting for a blocked send")
  func shutdownUnblocksActiveSendAndRetainsPendingIntent() async {
    let sendGate = TestGate()
    let persistence = FakeChatPersistence()
    let sync = FakeChatSynchronizer()
    let chat = FakeChatFeatureTransport(
      sendGate: sendGate,
      unblockSendOnShutdown: true
    )
    let feature = makeFeature(persistence: persistence, sync: sync, chat: chat)
    feature.setConnection(.online)
    await feature.appear()
    await feature.updateDraft("Survive blocked transport shutdown")

    let send = Task { await feature.send() }
    await sendGate.waitUntilWaiting()
    let shutdown = Task { await feature.shutdown() }

    var dependenciesClosedBeforeFallback = false
    for _ in 0..<200 {
      let transportClosed = await chat.calls.contains(.shutdown)
      let synchronizerClosed = await sync.shutdownCount == 1
      if transportClosed && synchronizerClosed {
        dependenciesClosedBeforeFallback = true
        break
      }
      await Task.yield()
    }
    if dependenciesClosedBeforeFallback == false {
      await sendGate.release()
    }
    await shutdown.value
    await send.value

    #expect(dependenciesClosedBeforeFallback)
    #expect(await persistence.persistedPendingSend?.turnID == "turn-1")
    #expect(await persistence.persistedPendingSend?.draft == "Survive blocked transport shutdown")
    #expect(feature.isShutdown)
  }

  @Test("draft writes stay ordered when an older save finishes last")
  func draftWritesRemainOrdered() async {
    let firstSave = TestGate()
    let persistence = FakeChatPersistence(saveGates: [1: firstSave])
    let feature = makeFeature(persistence: persistence)

    let older = Task { await feature.updateDraft("Old") }
    await firstSave.waitUntilWaiting()
    let newest = Task { await feature.updateDraft("Newest") }
    await Task.yield()
    await firstSave.release()
    await older.value
    await newest.value

    #expect(await persistence.persistedDraft?.text == "Newest")
    #expect(feature.state.draft == "Newest")
  }

  @Test("cached attachments are revalidated before base64 conversion")
  func cachedAttachmentsAreRevalidatedBeforeSend() async {
    let attachments = (0..<5).map { index in
      PreparedAttachment(
        id: UUID(uuidString: "00000000-0000-0000-0000-00000000000\(index)")!,
        mediaType: ImageMediaType.png.rawValue,
        data: Data([UInt8(index)])
      )
    }
    let persistence = FakeChatPersistence(
      draft: ConversationDraft(text: "", attachments: attachments, updatedAt: .distantPast)
    )
    let chat = FakeChatFeatureTransport()
    let feature = makeFeature(persistence: persistence, chat: chat)
    feature.setConnection(.online)
    await feature.appear()

    await feature.send()

    #expect(await chat.calls.isEmpty)
    #expect(feature.state.attachments == attachments)
    #expect(feature.state.errorBanner == "Choose up to 4 images.")
  }

  @Test("accepted replaces optimistic IDs and persists canonical messages")
  func acceptedReconcilesCanonicalMessages() async throws {
    let acceptedMessages = [
      message(id: "user-1", turnID: "turn-1", text: "Hello", ordinal: 1),
      message(
        id: "assistant-1",
        turnID: "turn-1",
        role: .assistant,
        status: .streaming,
        events: [],
        ordinal: 2
      ),
    ]
    let persistence = FakeChatPersistence()
    let sync = FakeChatSynchronizer()
    let chat = FakeChatFeatureTransport()
    let feature = makeFeature(persistence: persistence, sync: sync, chat: chat)
    feature.setConnection(.online)
    await feature.appear()
    await sync.enqueueRefresh(.success(snapshot(messages: acceptedMessages, throughSeq: 1)))
    await feature.updateDraft("Hello")
    await feature.send()

    await chat.yield(
      .frame(
        .accepted(
          id: "turn-1",
          conversationId: "conv-1",
          userMessageId: "user-1",
          assistantMessageId: "assistant-1",
          revision: 2,
          seq: 1
        )
      )
    )
    await eventually { await feature.state.messages.map(\.id) == ["user-1", "assistant-1"] }

    #expect(await persistence.cursor == 1)
    #expect(await persistence.persistedPendingSend == nil)
    #expect(
      await sync.refreshCalls == [
        ChatRefreshCall(conversationID: "conv-1", before: nil),
        ChatRefreshCall(conversationID: "conv-1", before: nil),
      ])
  }

  @Test("socket reconnect preserves partial output, fills the replay gap, and resumes the cursor")
  func reconnectReplaysAndResumes() async throws {
    let persistence = FakeChatPersistence(cursor: 1)
    let sync = FakeChatSynchronizer()
    await sync.enqueueReplay(
      .success([
        replay(seq: 2, payload: .event(event: .textDelta(text: "A")))
      ])
    )
    await sync.enqueueReplay(.success([]))
    let chat = FakeChatFeatureTransport()
    let feature = makeFeature(persistence: persistence, sync: sync, chat: chat)
    feature.setConnection(.online)
    await feature.appear()
    await feature.updateDraft("Hello")
    await feature.send()
    await chat.yield(.frame(accepted(seq: 1)))
    await chat.yield(.frame(event(seq: 3, value: "B")))
    await eventually { await feature.state.messages.last?.assistant?.text == "AB" }

    await chat.yield(.state(.reconnecting(attempt: 1)))
    await eventually {
      await feature.statusPresentation == .reconnecting(attempt: 1)
    }
    #expect(feature.state.messages.last?.assistant?.text == "AB")
    #expect(feature.statusPresentation == .reconnecting(attempt: 1))

    await chat.yield(.state(.connected))
    await eventually {
      await chat.calls.contains(
        .resume(
          turnID: "turn-1",
          agentID: "agent-1",
          conversationID: "conv-1",
          sinceSeq: 3
        )
      )
    }
    #expect(await sync.replayCalls.map(\.sinceSeq) == [1, 3])
  }

  @Test("a terminal transport failure resets its stream and can resume authoritatively")
  func terminalTransportFailureCanRecover() async {
    let running = summary(status: .running, activeTurnID: "turn-1", lastSeq: 4)
    let persistence = FakeChatPersistence(cursor: 4)
    let sync = FakeChatSynchronizer()
    let chat = FakeChatFeatureTransport()
    let feature = makeFeature(persistence: persistence, sync: sync, chat: chat)
    feature.setConnection(.online)
    await feature.appear()

    await chat.finish(throwing: GatewayError.transport("socket exhausted"))
    await eventually { await feature.connection == .offline }
    await sync.enqueueRefresh(.success(snapshot(summary: running, throughSeq: 4)))

    feature.setConnection(.online)
    await feature.connectionDidBecomeOnline()

    #expect(await chat.calls.filter { $0 == .resetAfterTerminalFailure }.count == 1)
    #expect(await chat.eventStreamRequestCount == 2)
    #expect(await chat.calls.filter { $0 == .connect }.count == 1)
    #expect(
      await chat.calls.contains(
        .resume(
          turnID: "turn-1",
          agentID: "agent-1",
          conversationID: "conv-1",
          sinceSeq: 4
        )
      )
    )
  }

  @Test("an older failed refresh cannot override a newer authoritative refresh")
  func staleRefreshFailureCannotOverrideAuthority() async {
    let firstRefresh = TestGate()
    let sync = FakeChatSynchronizer()
    await sync.enqueueRefresh(.failure(.unauthorized), waitingOn: firstRefresh)
    let feature = makeFeature(sync: sync)
    feature.setConnection(.online)

    let opening = Task { await feature.appear() }
    await firstRefresh.waitUntilWaiting()
    await sync.enqueueRefresh(.success(snapshot()))
    await feature.retryConnection()
    #expect(feature.connection == .online)
    #expect(feature.isAuthoritative)

    await firstRefresh.release()
    await opening.value

    #expect(feature.connection == .online)
    #expect(feature.isAuthoritative)
  }

  @Test("gateway authority state outranks a stale socket reconnect banner")
  func gatewayAuthorityOutranksTransportState() async {
    let chat = FakeChatFeatureTransport()
    let feature = makeFeature(chat: chat)
    feature.setConnection(.online)
    await feature.appear()
    await chat.yield(.state(.reconnecting(attempt: 2)))
    await eventually { await feature.statusPresentation == .reconnecting(attempt: 2) }

    feature.setConnection(.repairRequired)

    #expect(feature.statusPresentation == .repairRequired)
  }

  @Test("chat authorization loss is reported to the app authority owner")
  func authorizationLossPropagates() async {
    let sync = FakeChatSynchronizer()
    await sync.enqueueRefresh(.failure(.unauthorized))
    let feature = makeFeature(sync: sync)
    let probe = ChatGatewayErrorProbe()
    feature.setGatewayErrorHandler { error in
      probe.record(error)
    }
    feature.setConnection(.online)

    await feature.appear()

    #expect(probe.errors == [.unauthorized])
    #expect(feature.connection == .repairRequired)
  }

  @Test("background detaches without cancel and foreground resumes only a canonical running turn")
  func backgroundForegroundLifecycle() async throws {
    let running = summary(status: .running, activeTurnID: "turn-1", lastSeq: 4)
    let persistence = FakeChatPersistence(cursor: 4)
    let sync = FakeChatSynchronizer()
    await sync.enqueueRefresh(.success(snapshot(summary: running, throughSeq: 4)))
    let chat = FakeChatFeatureTransport()
    let feature = makeFeature(persistence: persistence, sync: sync, chat: chat)
    feature.setConnection(.online)
    await feature.updateDraft("kept")

    await feature.sceneDidEnterBackground()
    await feature.sceneWillEnterForeground()

    #expect(await chat.calls.contains(.suspendForDetachment))
    #expect(await chat.calls.filter(\.isCancel).isEmpty)
    #expect(
      await chat.calls.contains(
        .resume(
          turnID: "turn-1",
          agentID: "agent-1",
          conversationID: "conv-1",
          sinceSeq: 4
        )
      )
    )
    #expect(await persistence.savedDrafts.last?.text == "kept")
  }

  @Test("a newer background intent prevents an in-flight foreground refresh from reattaching")
  func backgroundWinsForegroundRefreshRace() async {
    let gate = TestGate()
    let running = summary(status: .running, activeTurnID: "turn-1", lastSeq: 4)
    let persistence = FakeChatPersistence(cursor: 4)
    let sync = FakeChatSynchronizer()
    await sync.enqueueRefresh(
      .success(snapshot(summary: running, throughSeq: 4)),
      waitingOn: gate
    )
    let chat = FakeChatFeatureTransport()
    let feature = makeFeature(persistence: persistence, sync: sync, chat: chat)
    feature.setConnection(.online)

    let foreground = Task { await feature.sceneWillEnterForeground() }
    await gate.waitUntilWaiting()
    await feature.sceneDidEnterBackground()
    await gate.release()
    await foreground.value

    #expect(await chat.calls.filter(\.isResume).isEmpty)
    #expect(await chat.calls.last == .suspendForDetachment)
  }

  @Test("connection recovery after an offline foreground reattaches the canonical turn")
  func onlineRecoveryAfterForeground() async {
    let running = summary(status: .running, activeTurnID: "turn-1", lastSeq: 4)
    let persistence = FakeChatPersistence(cursor: 4)
    let sync = FakeChatSynchronizer()
    let chat = FakeChatFeatureTransport()
    let feature = makeFeature(persistence: persistence, sync: sync, chat: chat)
    feature.setConnection(.offline)
    await feature.appear()
    await feature.sceneDidEnterBackground()
    await feature.sceneWillEnterForeground()
    await sync.enqueueRefresh(.success(snapshot(summary: running, throughSeq: 4)))

    feature.setConnection(.online)
    await feature.connectionDidBecomeOnline()

    #expect(
      await chat.calls.contains(
        .resume(
          turnID: "turn-1",
          agentID: "agent-1",
          conversationID: "conv-1",
          sinceSeq: 4
        )
      )
    )
  }

  @Test("foreground leaves a completed canonical turn detached")
  func foregroundDoesNotResumeCompletedTurn() async {
    let idle = summary(status: .idle, activeTurnID: nil, lastSeq: 5)
    let sync = FakeChatSynchronizer()
    await sync.enqueueRefresh(.success(snapshot(summary: idle, throughSeq: 5)))
    let chat = FakeChatFeatureTransport()
    let feature = makeFeature(sync: sync, chat: chat)
    feature.setConnection(.online)

    await feature.sceneDidEnterBackground()
    await feature.sceneWillEnterForeground()

    #expect(await chat.calls.filter(\.isResume).isEmpty)
  }

  @Test("answer marks a question only after the frame sends successfully")
  func answerAfterSuccess() async throws {
    let chat = FakeChatFeatureTransport()
    await chat.enqueueAnswer(.failure(.transport("lost")))
    await chat.enqueueAnswer(.success(()))
    let feature = makeFeature(chat: chat)
    feature.setConnection(.online)
    await feature.appear()
    await feature.updateDraft("Hello")
    await feature.send()
    await chat.yield(.frame(accepted(seq: 1)))
    await chat.yield(.frame(question(seq: 2)))
    await eventually { await pendingQuestion(in: feature)?.id == "question-1" }

    await feature.answer(questionID: "question-1", answer: " First ")
    #expect(pendingQuestion(in: feature)?.answer == nil)

    await feature.answer(questionID: "question-1", answer: " Second ")
    #expect(pendingQuestion(in: feature)?.answer == "Second")
    #expect(await chat.calls.filter(\.isAnswer).count == 2)
  }

  @Test("concurrent answer intents emit only one frame")
  func concurrentAnswersSendOnce() async {
    let answerGate = TestGate()
    let chat = FakeChatFeatureTransport(answerGate: answerGate)
    let feature = makeFeature(chat: chat)
    feature.setConnection(.online)
    await feature.appear()
    await feature.updateDraft("Hello")
    await feature.send()
    await chat.yield(.frame(accepted(seq: 1)))
    await chat.yield(.frame(question(seq: 2)))
    await eventually { await pendingQuestion(in: feature)?.id == "question-1" }

    let first = Task {
      await feature.answer(questionID: "question-1", answer: "A")
    }
    await answerGate.waitUntilWaiting()
    await feature.answer(questionID: "question-1", answer: "A")

    #expect(await chat.calls.filter(\.isAnswer).count == 1)
    await answerGate.release()
    await first.value
    #expect(pendingQuestion(in: feature)?.answer == "A")
  }

  @Test("a successful answer survives canonical refresh of the pending question")
  func submittedAnswerSurvivesRefresh() async {
    let chat = FakeChatFeatureTransport()
    let sync = FakeChatSynchronizer()
    let feature = makeFeature(sync: sync, chat: chat)
    feature.setConnection(.online)
    await feature.appear()
    await feature.updateDraft("Hello")
    await feature.send()
    await chat.yield(.frame(accepted(seq: 1)))
    await chat.yield(.frame(question(seq: 2)))
    await eventually { await pendingQuestion(in: feature)?.id == "question-1" }
    await feature.answer(questionID: "question-1", answer: "A")
    let canonical = message(
      id: "assistant-1",
      turnID: "turn-1",
      role: .assistant,
      status: .streaming,
      events: [.question(id: "question-1", question: "Choose", options: ["A", "B"])],
      ordinal: 2
    )
    await sync.enqueueRefresh(
      .success(
        snapshot(
          summary: summary(revision: 2, status: .running, activeTurnID: "turn-1", lastSeq: 2),
          messages: [canonical],
          throughSeq: 2
        )
      )
    )

    await feature.retryConnection()

    #expect(pendingQuestion(in: feature)?.answer == "A")
  }

  @Test("cancel sends once and stays active until durable cancelled done")
  func cancelWaitsForDone() async {
    let chat = FakeChatFeatureTransport()
    let feature = makeFeature(chat: chat)
    feature.setConnection(.online)
    await feature.appear()
    await feature.updateDraft("Hello")
    await feature.send()
    await chat.yield(.frame(accepted(seq: 1)))
    await eventually { await feature.canCancel }

    await feature.cancel()
    await feature.cancel()

    #expect(await chat.calls.filter(\.isCancel).count == 1)
    #expect(feature.state.activeTurnID == "turn-1")
    #expect(feature.isCancelling)

    await chat.yield(
      .frame(.done(id: "turn-1", conversationId: "conv-1", seq: 2, outcome: .cancelled))
    )
    await eventually {
      let activeTurnID = await feature.state.activeTurnID
      let isCancelling = await feature.isCancelling
      return activeTurnID == nil && isCancelling == false
    }

    #expect(feature.state.messages.last?.status == .cancelled)
    #expect(feature.isCancelling == false)
    await feature.cancel()
    #expect(await chat.calls.filter(\.isCancel).count == 1)
  }

  @Test("concurrent cancel intents emit only one frame")
  func concurrentCancelsSendOnce() async {
    let cancelGate = TestGate()
    let chat = FakeChatFeatureTransport(cancelGate: cancelGate)
    let feature = makeFeature(chat: chat)
    feature.setConnection(.online)
    await feature.appear()
    await feature.updateDraft("Hello")
    await feature.send()
    await chat.yield(.frame(accepted(seq: 1)))
    await eventually { await feature.canCancel }

    let first = Task { await feature.cancel() }
    await cancelGate.waitUntilWaiting()
    await feature.cancel()

    #expect(await chat.calls.filter(\.isCancel).count == 1)
    await cancelGate.release()
    await first.value
    #expect(feature.isCancelling)
  }

  @Test("canonical completion clears cancellation state after detached delivery")
  func canonicalCompletionFinishesCancellation() async {
    let sync = FakeChatSynchronizer()
    let chat = FakeChatFeatureTransport()
    let feature = makeFeature(sync: sync, chat: chat)
    feature.setConnection(.online)
    await feature.appear()
    await feature.updateDraft("Hello")
    await feature.send()
    await chat.yield(.frame(accepted(seq: 1)))
    await eventually { await feature.canCancel }
    await feature.cancel()
    #expect(feature.isCancelling)

    await feature.sceneDidEnterBackground()
    await sync.enqueueRefresh(
      .success(
        snapshot(
          summary: summary(revision: 3, status: .idle, activeTurnID: nil, lastSeq: 2),
          throughSeq: 2
        )
      )
    )
    await feature.sceneWillEnterForeground()

    #expect(feature.state.activeTurnID == nil)
    #expect(feature.isCancelling == false)
  }

  @Test("remote active turn blocks the composer with curated copy")
  func remoteActiveTurnBlocksComposer() async {
    let running = summary(status: .running, activeTurnID: "remote-turn", lastSeq: 8)
    let sync = FakeChatSynchronizer()
    await sync.enqueueRefresh(.success(snapshot(summary: running, throughSeq: 8)))
    let feature = makeFeature(sync: sync)
    feature.setConnection(.online)

    await feature.appear()

    #expect(feature.canSend == false)
    #expect(feature.composerDisabledReason == "This conversation is active on another device")
  }

  @Test("offline transcript and draft remain available while send is disabled")
  func offlineReadAndDraft() async {
    let cached = message(id: "cached", text: "Saved", ordinal: 1)
    let persistence = FakeChatPersistence(messages: [cached])
    let chat = FakeChatFeatureTransport()
    let feature = makeFeature(persistence: persistence, chat: chat)
    feature.setConnection(.offline)

    await feature.appear()
    await feature.updateDraft("Can edit")
    await feature.send()

    #expect(feature.state.messages.map(\.id) == [cached.id])
    #expect(feature.state.draft == "Can edit")
    #expect(feature.draftEditingAllowed)
    #expect(feature.canSend == false)
    #expect(await chat.calls.isEmpty)
    #expect(await persistence.savedDrafts.last?.text == "Can edit")
  }

  @Test("offline authority blocks answer and cancel frames")
  func offlineTurnMutationsAreBlocked() async {
    let chat = FakeChatFeatureTransport()
    let feature = makeFeature(chat: chat)
    feature.setConnection(.online)
    await feature.appear()
    await feature.updateDraft("Hello")
    await feature.send()
    await chat.yield(.frame(accepted(seq: 1)))
    await chat.yield(.frame(question(seq: 2)))
    await eventually { await pendingQuestion(in: feature)?.id == "question-1" }
    feature.setConnection(.offline)

    await feature.answer(questionID: "question-1", answer: "A")
    await feature.cancel()

    #expect(await chat.calls.filter(\.isAnswer).isEmpty)
    #expect(await chat.calls.filter(\.isCancel).isEmpty)
  }

  @Test("archived conversations remain readable but cannot edit or send")
  func archivedConversationIsReadOnly() async {
    let archived = summary(status: .archived)
    let persistence = FakeChatPersistence(
      draft: ConversationDraft(text: "Do not send", attachments: [], updatedAt: .distantPast)
    )
    let sync = FakeChatSynchronizer()
    await sync.enqueueRefresh(.success(snapshot(summary: archived)))
    let chat = FakeChatFeatureTransport()
    let feature = makeFeature(persistence: persistence, sync: sync, chat: chat)
    feature.setConnection(.online)

    await feature.appear()
    await feature.updateDraft("Changed")
    await feature.addSelections([ImageSelection(data: Data([1]), type: .png)])
    await feature.send()

    #expect(feature.canSend == false)
    #expect(feature.draftEditingAllowed == false)
    #expect(feature.composerDisabledReason == "This conversation is read-only")
    #expect(feature.state.draft == "Do not send")
    #expect(feature.state.attachments.isEmpty)
    #expect(await chat.calls.isEmpty)
  }

  @Test("canonical terminal transcripts do not expose stale questions")
  func terminalTranscriptClearsQuestion() async {
    let completed = message(
      id: "assistant-1",
      role: .assistant,
      status: .completed,
      events: [.question(id: "question-1", question: "Too late?", options: ["Yes"])],
      ordinal: 1
    )
    let sync = FakeChatSynchronizer()
    await sync.enqueueRefresh(
      .success(snapshot(summary: summary(lastSeq: 2), messages: [completed], throughSeq: 2))
    )
    let feature = makeFeature(sync: sync)
    feature.setConnection(.online)

    await feature.appear()

    #expect(pendingQuestion(in: feature) == nil)
  }

  @Test("only final response posts one VoiceOver announcement")
  func announcesOnlyFinalResponse() async {
    let announcer = FakeChatAccessibilityAnnouncer(voiceOverRunning: true)
    let chat = FakeChatFeatureTransport()
    let feature = makeFeature(chat: chat, announcer: announcer)
    feature.setConnection(.online)
    await feature.appear()
    await feature.updateDraft("Hello")
    await feature.send()
    await chat.yield(.frame(accepted(seq: 1)))
    await chat.yield(.frame(event(seq: 2, value: "Hi")))
    await Task.yield()
    #expect(await announcer.announcements.isEmpty)

    let done = MobileWSServerFrame.done(
      id: "turn-1",
      conversationId: "conv-1",
      seq: 3,
      outcome: .completed
    )
    await chat.yield(.frame(done))
    await chat.yield(.frame(done))
    await eventually { await announcer.announcements.count == 1 }

    #expect(await announcer.announcements == ["Response complete"])
  }

  @Test("view detachment can reconnect and resume the same feature instance")
  func viewChurnIsReusable() async {
    let running = summary(status: .running, activeTurnID: "turn-1", lastSeq: 2)
    let persistence = FakeChatPersistence(cursor: 2)
    let sync = FakeChatSynchronizer()
    await sync.enqueueRefresh(.success(snapshot(summary: running, throughSeq: 2)))
    await sync.enqueueRefresh(.success(snapshot(summary: running, throughSeq: 2)))
    let chat = FakeChatFeatureTransport()
    let feature = makeFeature(persistence: persistence, sync: sync, chat: chat)
    feature.setConnection(.online)

    await feature.appear()
    await feature.disappear()
    await feature.appear()

    #expect(await chat.calls.filter { $0 == .suspendForDetachment }.isEmpty)
    #expect(await chat.calls.filter { $0 == .connect }.count == 1)
    #expect(await chat.calls.filter(\.isResume).count == 1)
    #expect(feature.isShutdown == false)
  }

  @Test("a hidden foreground turn stays attached until its durable terminal")
  func hiddenActiveTurnStaysAttached() async {
    let running = summary(status: .running, activeTurnID: "turn-1", lastSeq: 4)
    let persistence = FakeChatPersistence(cursor: 4)
    let sync = FakeChatSynchronizer()
    await sync.enqueueRefresh(.success(snapshot(summary: running, throughSeq: 4)))
    let chat = FakeChatFeatureTransport()
    let feature = makeFeature(persistence: persistence, sync: sync, chat: chat)
    feature.setConnection(.online)
    await feature.appear()

    await feature.disappear()

    #expect(await chat.calls.filter { $0 == .suspendForDetachment }.isEmpty)
    await chat.yield(
      .frame(.done(id: "turn-1", conversationId: "conv-1", seq: 5, outcome: .completed))
    )
    await eventually {
      await chat.calls.filter { $0 == .suspendForDetachment }.count == 1
    }
  }

  @Test("cursor persistence cannot roll back a newer composer edit")
  func cursorPersistencePreservesComposer() async {
    let cursorGate = TestGate()
    let persistence = FakeChatPersistence(advanceGate: cursorGate)
    let chat = FakeChatFeatureTransport()
    let feature = makeFeature(persistence: persistence, chat: chat)
    feature.setConnection(.online)
    await feature.appear()
    await feature.updateDraft("Hello")
    await feature.send()

    await chat.yield(.frame(accepted(seq: 1)))
    await cursorGate.waitUntilWaiting()
    await feature.updateDraft("Next message")
    await cursorGate.release()
    await eventually { await feature.state.lastAppliedSeq == 1 }

    #expect(feature.state.draft == "Next message")
  }

  @Test("a local cursor failure does not downgrade healthy gateway authority")
  func localPersistenceFailureDoesNotMarkGatewayOffline() async {
    let refreshGate = TestGate()
    let persistence = FakeChatPersistence(failingAdvanceCalls: [1])
    let sync = FakeChatSynchronizer()
    let chat = FakeChatFeatureTransport()
    let probe = ChatGatewayErrorProbe()
    let feature = makeFeature(persistence: persistence, sync: sync, chat: chat)
    feature.setGatewayErrorHandler { error in probe.record(error) }
    feature.setConnection(.online)
    await feature.appear()
    await feature.updateDraft("Hello")
    await feature.send()
    await sync.enqueueRefresh(.success(snapshot()), waitingOn: refreshGate)

    await chat.yield(.frame(accepted(seq: 1)))
    await refreshGate.waitUntilWaiting()

    #expect(feature.connection == .online)
    #expect(feature.isAuthoritative)
    #expect(feature.state.errorBanner == "Saved conversation data couldn't be updated.")
    #expect(probe.errors.isEmpty)
    await refreshGate.release()
  }

  @Test("terminal shutdown rejects later sends")
  func shutdownRejectsSend() async {
    let chat = FakeChatFeatureTransport()
    let feature = makeFeature(chat: chat)
    feature.setConnection(.online)
    await feature.updateDraft("Do not send")

    await feature.shutdown()
    await feature.send()

    #expect(await chat.calls == [.shutdown])
    #expect(feature.isShutdown)
    #expect(feature.state.errorBanner == "Chat session is closed")
  }

  @Test("app model reuses a chat across view churn and terminally retires it with the gateway")
  func appModelOwnsReusableChatLifecycle() async {
    let original = chatConnectionProfile(
      gatewayID: "gateway-1",
      id: UUID(uuidString: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE")!
    )
    let replacement = chatConnectionProfile(
      gatewayID: "gateway-2",
      id: UUID(uuidString: "11111111-2222-3333-4444-555555555555")!
    )
    let originalEngine = ChatLifecycleSyncEngine()
    let replacementEngine = ChatLifecycleSyncEngine()
    let sync = FakeChatSynchronizer()
    let chat = FakeChatFeatureTransport()
    let feature = makeFeature(sync: sync, chat: chat)
    let probe = ChatFactoryProbe(feature: feature)
    let model = AppModel(
      dependencies: AppDependencies(
        clock: TestAppClock(now: Date(timeIntervalSince1970: 100)),
        loadProfile: { original },
        makeSyncEngine: { profile in
          profile == original ? originalEngine : replacementEngine
        },
        makeChatFeature: { profile, conversation in
          probe.make(profile: profile, conversation: conversation)
        }
      )
    )
    await model.start()
    model.consume(
      SyncSnapshot(
        connection: .online,
        conversations: [],
        agents: [],
        lastSuccessfulSyncAt: Date(timeIntervalSince1970: 100)
      )
    )

    let first = await model.makeChatFeature(summary())
    let second = await model.makeChatFeature(summary())

    #expect(first === feature)
    #expect(second === feature)
    #expect(probe.callCount == 1)
    #expect(probe.profile == original)

    await sync.enqueueRefresh(.failure(.unauthorized))
    await feature.appear()
    #expect(model.connectionState == .repairRequired)
    #expect(model.banner == .repairRequired)

    await model.installPairedProfile(replacement)

    #expect(await chat.calls == [.shutdown])
    #expect(await sync.shutdownCount == 1)
    #expect(feature.isShutdown)
  }

  @Test("a superseding activation still drains every retired chat")
  func supersedingActivationDrainsRetiredChats() async {
    let original = chatConnectionProfile(
      gatewayID: "gateway-1",
      id: UUID(uuidString: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE")!
    )
    let replacement = chatConnectionProfile(
      gatewayID: "gateway-2",
      id: UUID(uuidString: "11111111-2222-3333-4444-555555555555")!
    )
    let superseding = chatConnectionProfile(
      gatewayID: "gateway-3",
      id: UUID(uuidString: "99999999-8888-7777-6666-555555555555")!
    )
    let shutdownGate = TestGate()
    let first = makeFeature(
      conversation: summary(id: "conv-1"),
      chat: FakeChatFeatureTransport(shutdownGate: shutdownGate)
    )
    let second = makeFeature(
      conversation: summary(id: "conv-2"),
      chat: FakeChatFeatureTransport(shutdownGate: shutdownGate)
    )
    let probe = ChatFeatureMapProbe(features: ["conv-1": first, "conv-2": second])
    let model = AppModel(
      dependencies: AppDependencies(
        clock: TestAppClock(now: Date(timeIntervalSince1970: 100)),
        loadProfile: { original },
        makeSyncEngine: { _ in ChatLifecycleSyncEngine() },
        makeChatFeature: { _, conversation in probe.make(conversation: conversation) }
      )
    )
    await model.start()
    _ = await model.makeChatFeature(summary(id: "conv-1"))
    _ = await model.makeChatFeature(summary(id: "conv-2"))

    let replacing = Task { await model.installPairedProfile(replacement) }
    await shutdownGate.waitUntilWaiting()
    await model.installPairedProfile(superseding)
    await shutdownGate.release()
    await replacing.value

    #expect(first.isShutdown)
    #expect(second.isShutdown)
  }

  private func makeFeature(
    conversation: ConversationSummaryDTO = summary(),
    persistence: FakeChatPersistence = FakeChatPersistence(),
    sync: FakeChatSynchronizer = FakeChatSynchronizer(),
    chat: FakeChatFeatureTransport = FakeChatFeatureTransport(),
    announcer: FakeChatAccessibilityAnnouncer = FakeChatAccessibilityAnnouncer(),
    ids: [String] = ["turn-1", "local-1"]
  ) -> ChatFeature {
    let source = SequentialUUIDSource(ids: ids)
    return ChatFeature(
      gatewayID: "gateway-1",
      conversation: conversation,
      persistence: persistence,
      synchronizer: sync,
      transport: chat,
      clock: TestAppClock(now: Date(timeIntervalSince1970: 1_000)),
      announcer: announcer,
      validator: ImageAttachmentValidator(makeID: {
        UUID(uuidString: "99999999-8888-7777-6666-555555555555")!
      }),
      makeID: { source.next() }
    )
  }
}

@MainActor
private final class ChatFactoryProbe {
  let feature: ChatFeature
  private(set) var callCount = 0
  private(set) var profile: ConnectionProfileSnapshot?

  init(feature: ChatFeature) {
    self.feature = feature
  }

  func make(
    profile: ConnectionProfileSnapshot,
    conversation: ConversationSummaryDTO
  ) -> ChatFeature {
    callCount += 1
    self.profile = profile
    #expect(conversation.id == "conv-1")
    return feature
  }
}

@MainActor
private final class ChatFeatureMapProbe {
  private let features: [String: ChatFeature]

  init(features: [String: ChatFeature]) {
    self.features = features
  }

  func make(conversation: ConversationSummaryDTO) -> ChatFeature? {
    features[conversation.id]
  }
}

@MainActor
private final class ChatGatewayErrorProbe {
  private(set) var errors: [GatewayError] = []

  func record(_ error: GatewayError) {
    errors.append(error)
  }
}

private actor ChatLifecycleSyncEngine: AppSyncing {
  func snapshots() -> AsyncStream<SyncSnapshot> {
    AsyncStream { continuation in continuation.finish() }
  }

  func bootstrap() async {}
  func sceneDidEnterBackground() async {}
  func sceneWillEnterForeground() async {}
  func shutdown() async {}
}

private actor ChatOperationRecorder {
  private(set) var operations: [String] = []

  func record(_ operation: String) {
    operations.append(operation)
  }
}

private final class SequentialUUIDSource: @unchecked Sendable {
  private let lock = NSLock()
  private var values: [String]

  init(ids: [String]) {
    values = ids
  }

  func next() -> String {
    lock.withLock {
      precondition(values.isEmpty == false)
      return values.removeFirst()
    }
  }
}

private enum FakeChatResult<Value: Sendable>: Sendable {
  case success(Value)
  case failure(GatewayError)
}

private enum FakeChatPersistenceError: Error {
  case unavailable
}

private actor FakeChatPersistence: ChatFeaturePersisting {
  private let recorder: ChatOperationRecorder?
  private let failingSaveCalls: Set<Int>
  private let failingAdvanceCalls: Set<Int>
  private let saveGates: [Int: TestGate]
  private let advanceGate: TestGate?
  private var cachedMessages: [ConversationMessageDTO]
  private var cachedDraft: ConversationDraft?
  private var cachedPendingSend: PendingChatSend?
  private var saveCallCount = 0
  private var advanceCallCount = 0
  private(set) var cursor: Int
  private(set) var savedDrafts: [ConversationDraft] = []

  var persistedDraft: ConversationDraft? { cachedDraft }
  var persistedPendingSend: PendingChatSend? { cachedPendingSend }

  init(
    messages: [ConversationMessageDTO] = [],
    draft: ConversationDraft? = nil,
    pendingSend: PendingChatSend? = nil,
    cursor: Int = 0,
    failingSaveCalls: Set<Int> = [],
    failingAdvanceCalls: Set<Int> = [],
    saveGates: [Int: TestGate] = [:],
    advanceGate: TestGate? = nil,
    recorder: ChatOperationRecorder? = nil
  ) {
    cachedMessages = messages
    cachedDraft = draft
    cachedPendingSend = pendingSend
    self.cursor = cursor
    self.failingSaveCalls = failingSaveCalls
    self.failingAdvanceCalls = failingAdvanceCalls
    self.saveGates = saveGates
    self.advanceGate = advanceGate
    self.recorder = recorder
  }

  func messages(gatewayID: String, conversationID: String) async throws
    -> [ConversationMessageDTO]
  {
    cachedMessages
  }

  func draft(gatewayID: String, conversationID: String) async throws -> ConversationDraft? {
    cachedDraft
  }

  func pendingSend(gatewayID: String, conversationID: String) async throws -> PendingChatSend? {
    cachedPendingSend
  }

  func cursor(gatewayID: String, conversationID: String) async throws -> Int {
    cursor
  }

  func saveDraft(
    _ draft: ConversationDraft,
    gatewayID: String,
    conversationID: String
  ) async throws {
    saveCallCount += 1
    if let gate = saveGates[saveCallCount] { await gate.wait() }
    guard failingSaveCalls.contains(saveCallCount) == false else {
      throw FakeChatPersistenceError.unavailable
    }
    cachedDraft = draft
    savedDrafts.append(draft)
    await recorder?.record(
      draft.text.isEmpty && draft.attachments.isEmpty
        ? "persist.draft.clear" : "persist.draft"
    )
  }

  func stagePendingSend(
    _ pending: PendingChatSend,
    gatewayID: String,
    conversationID: String
  ) async throws {
    saveCallCount += 1
    if let gate = saveGates[saveCallCount] { await gate.wait() }
    guard failingSaveCalls.contains(saveCallCount) == false else {
      throw FakeChatPersistenceError.unavailable
    }
    cachedPendingSend = pending
    cachedDraft = nil
    await recorder?.record("persist.pending.stage")
  }

  func clearPendingSend(
    gatewayID: String,
    conversationID: String,
    turnID: String
  ) async throws {
    guard cachedPendingSend?.turnID == turnID else { return }
    cachedPendingSend = nil
    await recorder?.record("persist.pending.clear")
  }

  func restorePendingSendAsDraft(
    gatewayID: String,
    conversationID: String,
    turnID: String
  ) async throws -> ConversationDraft? {
    guard let pending = cachedPendingSend, pending.turnID == turnID else { return nil }
    let draft = ConversationDraft(
      text: pending.draft,
      attachments: pending.attachments,
      updatedAt: pending.createdAt
    )
    cachedDraft = draft
    cachedPendingSend = nil
    savedDrafts.append(draft)
    await recorder?.record("persist.pending.restore")
    return draft
  }

  func advanceCursor(gatewayID: String, conversationID: String, to seq: Int) async throws {
    advanceCallCount += 1
    if let advanceGate { await advanceGate.wait() }
    guard failingAdvanceCalls.contains(advanceCallCount) == false else {
      throw FakeChatPersistenceError.unavailable
    }
    cursor = max(cursor, seq)
    await recorder?.record("persist.cursor.\(seq)")
  }
}

private struct ChatRefreshCall: Equatable, Sendable {
  let conversationID: String
  let before: String?
}

private struct ChatReplayCall: Equatable, Sendable {
  let agentID: String
  let conversationID: String
  let sinceSeq: Int
}

private actor FakeChatSynchronizer: ChatFeatureSynchronizing {
  private struct QueuedRefresh: Sendable {
    let result: FakeChatResult<ChatCanonicalSnapshot>
    let gate: TestGate?
  }

  private let recorder: ChatOperationRecorder?
  private var refreshResults: [QueuedRefresh] = []
  private var replayResults: [FakeChatResult<[ReplayEntryDTO]>] = []
  private(set) var refreshCalls: [ChatRefreshCall] = []
  private(set) var replayCalls: [ChatReplayCall] = []
  private(set) var shutdownCount = 0

  init(recorder: ChatOperationRecorder? = nil) {
    self.recorder = recorder
  }

  func enqueueRefresh(
    _ result: FakeChatResult<ChatCanonicalSnapshot>,
    waitingOn gate: TestGate? = nil
  ) {
    refreshResults.append(QueuedRefresh(result: result, gate: gate))
  }

  func enqueueReplay(_ result: FakeChatResult<[ReplayEntryDTO]>) {
    replayResults.append(result)
  }

  func refresh(conversationID: String, before: String?) async throws -> ChatCanonicalSnapshot {
    refreshCalls.append(ChatRefreshCall(conversationID: conversationID, before: before))
    await recorder?.record("sync.refresh")
    guard refreshResults.isEmpty == false else {
      return snapshot()
    }
    let queued = refreshResults.removeFirst()
    if let gate = queued.gate { await gate.wait() }
    return try resolve(queued.result)
  }

  func replay(
    agentID: String,
    conversationID: String,
    sinceSeq: Int
  ) throws -> [ReplayEntryDTO] {
    replayCalls.append(
      ChatReplayCall(agentID: agentID, conversationID: conversationID, sinceSeq: sinceSeq)
    )
    guard replayResults.isEmpty == false else { return [] }
    return try resolve(replayResults.removeFirst())
  }

  func shutdown() async {
    shutdownCount += 1
  }

  private func resolve<Value>(_ result: FakeChatResult<Value>) throws -> Value {
    switch result {
    case .success(let value): value
    case .failure(let error): throw error
    }
  }
}

private actor FakeChatFeatureTransport: ChatFeatureTransporting {
  private let recorder: ChatOperationRecorder?
  private let sendGate: TestGate?
  private let unblockSendOnShutdown: Bool
  private let answerGate: TestGate?
  private let cancelGate: TestGate?
  private let shutdownGate: TestGate?
  private var didUseAnswerGate = false
  private var didUseCancelGate = false
  private var stream: AsyncThrowingStream<ChatConnectionEvent, Error>
  private var continuation: AsyncThrowingStream<ChatConnectionEvent, Error>.Continuation
  private var sendResults: [FakeChatResult<Void>] = []
  private var answerResults: [FakeChatResult<Void>] = []
  private(set) var calls: [FakeChatTransportCall] = []
  private(set) var eventStreamRequestCount = 0

  init(
    recorder: ChatOperationRecorder? = nil,
    sendGate: TestGate? = nil,
    unblockSendOnShutdown: Bool = false,
    answerGate: TestGate? = nil,
    cancelGate: TestGate? = nil,
    shutdownGate: TestGate? = nil
  ) {
    self.recorder = recorder
    self.sendGate = sendGate
    self.unblockSendOnShutdown = unblockSendOnShutdown
    self.answerGate = answerGate
    self.cancelGate = cancelGate
    self.shutdownGate = shutdownGate
    let pair = AsyncThrowingStream<ChatConnectionEvent, Error>.makeStream()
    stream = pair.stream
    continuation = pair.continuation
  }

  func events() async -> AsyncThrowingStream<ChatConnectionEvent, Error> {
    eventStreamRequestCount += 1
    return stream
  }

  func resetAfterTerminalFailure() {
    calls.append(.resetAfterTerminalFailure)
    let pair = AsyncThrowingStream<ChatConnectionEvent, Error>.makeStream()
    stream = pair.stream
    continuation = pair.continuation
  }

  func enqueueAnswer(_ result: FakeChatResult<Void>) {
    answerResults.append(result)
  }

  func enqueueSend(_ result: FakeChatResult<Void>) {
    sendResults.append(result)
  }

  func connect() async throws {
    calls.append(.connect)
    await recorder?.record("chat.connect")
  }

  func sendTurn(
    id: String,
    agentID: String,
    conversationID: String,
    text: String,
    images: [MessageImage]
  ) async throws {
    calls.append(
      .send(
        turnID: id,
        agentID: agentID,
        conversationID: conversationID,
        text: text,
        images: images
      )
    )
    await recorder?.record("chat.send")
    if let sendGate {
      await sendGate.wait()
      if unblockSendOnShutdown { throw CancellationError() }
    }
    guard sendResults.isEmpty == false else { return }
    switch sendResults.removeFirst() {
    case .success:
      return
    case .failure(let error):
      throw error
    }
  }

  func resume(
    turnID: String,
    agentID: String,
    conversationID: String,
    sinceSeq: Int
  ) async throws {
    calls.append(
      .resume(
        turnID: turnID,
        agentID: agentID,
        conversationID: conversationID,
        sinceSeq: sinceSeq
      )
    )
  }

  func answer(turnID: String, questionID: String, answer: String) async throws {
    calls.append(.answer(turnID: turnID, questionID: questionID, answer: answer))
    if didUseAnswerGate == false, let answerGate {
      didUseAnswerGate = true
      await answerGate.wait()
    }
    guard answerResults.isEmpty == false else { return }
    _ = try resolve(answerResults.removeFirst())
  }

  func cancel(turnID: String) async throws {
    calls.append(.cancel(turnID: turnID))
    if didUseCancelGate == false, let cancelGate {
      didUseCancelGate = true
      await cancelGate.wait()
    }
  }

  func suspendForDetachment() async {
    calls.append(.suspendForDetachment)
  }

  func shutdown() async {
    calls.append(.shutdown)
    if unblockSendOnShutdown {
      await sendGate?.release()
    }
    if let shutdownGate { await shutdownGate.wait() }
  }

  func yield(_ event: ChatConnectionEvent) {
    continuation.yield(event)
  }

  func finish(throwing error: Error) {
    continuation.finish(throwing: error)
  }

  private func resolve<Value>(_ result: FakeChatResult<Value>) throws -> Value {
    switch result {
    case .success(let value): value
    case .failure(let error): throw error
    }
  }
}

private enum FakeChatTransportCall: Equatable, Sendable {
  case connect
  case send(
    turnID: String,
    agentID: String,
    conversationID: String,
    text: String,
    images: [MessageImage]
  )
  case resume(turnID: String, agentID: String, conversationID: String, sinceSeq: Int)
  case answer(turnID: String, questionID: String, answer: String)
  case cancel(turnID: String)
  case suspendForDetachment
  case resetAfterTerminalFailure
  case shutdown

  var sentPayload: (text: String, images: [MessageImage])? {
    guard case .send(_, _, _, let text, let images) = self else { return nil }
    return (text, images)
  }

  var sendCall: FakeChatTransportCall? {
    if case .send = self { return self }
    return nil
  }

  var turnID: String? {
    guard case .send(let turnID, _, _, _, _) = self else { return nil }
    return turnID
  }

  var text: String? {
    guard case .send(_, _, _, let text, _) = self else { return nil }
    return text
  }

  var isAnswer: Bool {
    if case .answer = self { return true }
    return false
  }

  var isCancel: Bool {
    if case .cancel = self { return true }
    return false
  }

  var isResume: Bool {
    if case .resume = self { return true }
    return false
  }
}

private actor FakeChatAccessibilityAnnouncer: ChatAccessibilityAnnouncing {
  let voiceOverRunning: Bool
  private(set) var announcements: [String] = []

  init(voiceOverRunning: Bool = false) {
    self.voiceOverRunning = voiceOverRunning
  }

  func isVoiceOverRunning() async -> Bool {
    voiceOverRunning
  }

  func announce(_ value: String) async {
    announcements.append(value)
  }
}

private func summary(
  id: String = "conv-1",
  revision: Int = 1,
  status: ConversationStatus = .idle,
  activeTurnID: String? = nil,
  lastSeq: Int = 0
) -> ConversationSummaryDTO {
  ConversationSummaryDTO(
    id: id,
    agentId: "agent-1",
    agentName: "Dash",
    title: "Test conversation",
    revision: revision,
    status: status,
    activeTurnId: activeTurnID,
    owningIssueId: nil,
    projectId: nil,
    lastSeq: lastSeq,
    lastMessagePreview: nil,
    createdAt: Date(timeIntervalSince1970: 1),
    updatedAt: Date(timeIntervalSince1970: 1),
    deletedAt: nil
  )
}

private func deletedSummary(revision: Int) -> ConversationSummaryDTO {
  ConversationSummaryDTO(
    id: "conv-1",
    agentId: "agent-1",
    agentName: "Dash",
    title: "Test conversation",
    revision: revision,
    status: .deleted,
    activeTurnId: nil,
    owningIssueId: nil,
    projectId: nil,
    lastSeq: 0,
    lastMessagePreview: nil,
    createdAt: Date(timeIntervalSince1970: 1),
    updatedAt: Date(timeIntervalSince1970: 2),
    deletedAt: Date(timeIntervalSince1970: 2)
  )
}

private func makeChatGatewayAPI() -> GatewayAPI {
  let profile = ConnectionProfile(
    id: UUID(),
    gatewayId: "gateway-1",
    publicKey: "public-key",
    label: "Test Gateway",
    host: "gateway.test",
    managementPort: 9400,
    chatPort: 9400,
    secure: true,
    mode: .lan,
    tlsCertificateSha256:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    createdAt: Date(timeIntervalSince1970: 0),
    lastSuccessfulSyncAt: nil
  )
  let secrets = ConnectionSecrets(
    managementToken: "management-test-token",
    chatToken: "chat-test-token",
    relayCredential: nil
  )
  return GatewayAPI(
    transport: HTTPTransport(
      endpoint: ConnectionEndpoint(profile: profile, secrets: secrets),
      secrets: secrets,
      session: testURLSession(),
      clock: TestAppClock(now: Date(timeIntervalSince1970: 0))
    )
  )
}

private func chatConnectionProfile(gatewayID: String, id: UUID) -> ConnectionProfileSnapshot {
  ConnectionProfileSnapshot(
    gatewayID: gatewayID,
    profile: ConnectionProfile(
      id: id,
      gatewayId: gatewayID,
      publicKey: "public-key",
      label: gatewayID,
      host: "dash.local",
      managementPort: 9300,
      chatPort: 9200,
      secure: false,
      mode: .lan,
      createdAt: Date(timeIntervalSince1970: 1),
      lastSuccessfulSyncAt: nil
    )
  )
}

private func snapshot(
  summary: ConversationSummaryDTO = summary(),
  messages: [ConversationMessageDTO] = [],
  nextCursor: String? = nil,
  throughSeq: Int = 0
) -> ChatCanonicalSnapshot {
  ChatCanonicalSnapshot(
    summary: summary,
    messages: messages,
    nextCursor: nextCursor,
    throughSeq: throughSeq
  )
}

private func message(
  id: String,
  turnID: String = "turn-1",
  role: MessageRole = .user,
  status: MessageStatus = .completed,
  text: String = "",
  events: [AgentEvent] = [],
  ordinal: Int
) -> ConversationMessageDTO {
  ConversationMessageDTO(
    id: id,
    conversationId: "conv-1",
    turnId: turnID,
    ordinal: ordinal,
    role: role,
    status: status,
    content: role == .user ? .user(text: text, images: nil) : .assistant(events: events),
    createdAt: Date(timeIntervalSince1970: TimeInterval(ordinal)),
    updatedAt: Date(timeIntervalSince1970: TimeInterval(ordinal))
  )
}

private func accepted(seq: Int) -> MobileWSServerFrame {
  .accepted(
    id: "turn-1",
    conversationId: "conv-1",
    userMessageId: "user-1",
    assistantMessageId: "assistant-1",
    revision: 2,
    seq: seq
  )
}

private func event(seq: Int, value: String) -> MobileWSServerFrame {
  .event(
    id: "turn-1",
    conversationId: "conv-1",
    seq: seq,
    event: .textDelta(text: value)
  )
}

private func question(seq: Int) -> MobileWSServerFrame {
  .event(
    id: "turn-1",
    conversationId: "conv-1",
    seq: seq,
    event: .question(id: "question-1", question: "Choose", options: ["A", "B"])
  )
}

private func replay(seq: Int, payload: ReplayPayload) -> ReplayEntryDTO {
  ReplayEntryDTO(
    seq: seq,
    msgId: "turn-1",
    agentId: "agent-1",
    conversationId: "conv-1",
    timestamp: Date(timeIntervalSince1970: TimeInterval(seq)),
    payload: payload
  )
}

@MainActor
private func pendingQuestion(in feature: ChatFeature) -> QuestionState? {
  feature.state.messages.compactMap(\.assistant?.pendingQuestion).first
}

@MainActor
private func featureMessageIDs(_ feature: ChatFeature) -> [String] {
  feature.state.messages.map(\.id)
}

@MainActor
private func featureConnection(_ feature: ChatFeature) -> GatewayConnectionState {
  feature.connection
}

@MainActor
private func featureTransport(_ feature: ChatFeature) -> ChatTransportState {
  feature.state.transport
}

private func eventually(
  _ predicate: @escaping @Sendable () async -> Bool
) async {
  for _ in 0..<200 {
    if await predicate() { return }
    await Task.yield()
  }
  Issue.record("Condition did not become true")
}
