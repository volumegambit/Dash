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

  @Test("active corrupt pending recovery blocks every chat mutation after canonical refresh")
  func activeCorruptPendingRecoveryBlocksChatMutations() async {
    let recovery = pendingRecovery(draft: "Saved message with damaged attachment")
    let persistence = FakeChatPersistence(pendingSendLoadResult: .recoveryRequired(recovery))
    let sync = FakeChatSynchronizer()
    await sync.enqueueRefresh(
      .success(
        snapshot(
          summary: summary(
            revision: 2,
            status: .running,
            activeTurnID: recovery.pendingSend.turnID,
            lastSeq: 1
          ),
          messages: [
            message(
              id: "assistant-recovery",
              turnID: recovery.pendingSend.turnID,
              role: .assistant,
              status: .streaming,
              events: [
                .question(id: "question-1", question: "Proceed?", options: ["A", "B"])
              ],
              ordinal: 1
            )
          ],
          throughSeq: 1
        )
      )
    )
    let chat = FakeChatFeatureTransport()
    let feature = makeFeature(persistence: persistence, sync: sync, chat: chat)
    feature.setConnection(.online)

    await feature.appear()
    await feature.updateDraft("Do not overwrite the guarded message")
    await feature.send()
    await feature.answer(questionID: "question-1", answer: "A")
    await feature.cancel()
    await feature.sceneDidEnterBackground()

    #expect(feature.pendingSendRecovery == recovery)
    #expect(feature.state.draft.isEmpty)
    #expect(feature.state.attachments.isEmpty)
    #expect(feature.canSend == false)
    #expect(feature.draftEditingAllowed == false)
    #expect(feature.canAnswerQuestions == false)
    #expect(feature.canCancel == false)
    #expect(feature.statusPresentation == .recoveryRequired)
    #expect(feature.composerDisabledReason == "A saved message needs recovery")
    #expect(await persistence.saveCallCount == 0)
    #expect(await persistence.stageCallCount == 0)
    #expect(await chat.calls.compactMap(\.sentPayload).isEmpty)
    #expect(await chat.calls.filter(\.isAnswer).isEmpty)
    #expect(await chat.calls.filter(\.isCancel).isEmpty)
  }

  @Test("other cache read failures cannot suppress corrupt pending recovery")
  func cacheReadFailuresPreservePendingRecoveryGuard() async {
    let recovery = pendingRecovery(draft: "Guard survives unrelated cache failures")
    let persistence = FakeChatPersistence(
      pendingSendLoadResult: .recoveryRequired(recovery),
      failingMessageLoad: true,
      failingDraftLoad: true,
      failingCursorLoad: true
    )
    let feature = makeFeature(persistence: persistence)

    await feature.appear()

    #expect(feature.pendingSendRecovery == recovery)
    #expect(feature.canSend == false)
    #expect(feature.draftEditingAllowed == false)
    #expect(feature.state.errorBanner == "Saved conversation data couldn't be loaded.")
  }

  @Test("cache load preserves a coexisting draft while a pending send blocks mutations")
  func cacheLoadPreservesCoexistingDraftBehindPendingSend() async {
    let attachment = PreparedAttachment(
      id: UUID(uuidString: "AAAAAAAA-1111-2222-3333-BBBBBBBBBBBB")!,
      mediaType: ImageMediaType.png.rawValue,
      data: Data([1, 2, 3])
    )
    let draft = ConversationDraft(
      text: "Newer coexisting draft",
      attachments: [attachment],
      updatedAt: Date(timeIntervalSince1970: 950)
    )
    let recovery = pendingRecovery(draft: "Older pending message")
    let pendingResults: [PendingSendLoadResult] = [
      .resumable(recovery.pendingSend),
      .recoveryRequired(recovery),
    ]

    for pendingResult in pendingResults {
      let refreshGate = TestGate()
      let persistence = FakeChatPersistence(
        draft: draft,
        pendingSendLoadResult: pendingResult
      )
      let sync = FakeChatSynchronizer()
      await sync.enqueueRefresh(.success(snapshot()), waitingOn: refreshGate)
      let feature = makeFeature(persistence: persistence, sync: sync)
      feature.setConnection(.online)

      let appearance = Task { await feature.appear() }
      await refreshGate.waitUntilWaiting()

      #expect(feature.state.draft == draft.text)
      #expect(feature.state.attachments == draft.attachments)
      #expect(feature.draftEditingAllowed == false)

      await refreshGate.release()
      await appearance.value
      await feature.shutdown()
    }
  }

  @Test("a recovery discard during cache loading cannot install a stale recovery guard")
  func recoveryDiscardDuringCacheLoadRejectsStalePendingRead() async {
    let remainingReadGate = TestGate()
    let recoveryChanges = DeliveryTrackedChatRecoveryChangeSignal()
    let recovery = pendingRecovery(draft: "Discarded while cache was loading")
    let persistence = FakeChatPersistence(
      pendingSendLoadResult: .recoveryRequired(recovery),
      draftLoadGate: remainingReadGate
    )
    let feature = makeFeature(
      persistence: persistence,
      recoveryChanges: recoveryChanges
    )

    let appearance = Task { await feature.appear() }
    await remainingReadGate.waitUntilWaiting()
    await eventually { await persistence.pendingLoadCallCount == 1 }
    await eventually { await recoveryChanges.nextRequestCount >= 1 }

    await persistence.setPendingSendLoadResult(.none)
    await recoveryChanges.send(gatewayID: "gateway-1")
    await eventually { await recoveryChanges.nextRequestCount >= 2 }
    await remainingReadGate.release()
    await appearance.value

    #expect(feature.pendingSendRecovery == nil)
    #expect(feature.draftEditingAllowed)
    await recoveryChanges.finish()
    await feature.shutdown()
  }

  @Test("a stage collision keeps the new draft and installs the old recovery guard")
  func stageCollisionPreservesNewDraftAndOldRecovery() async {
    let recovery = pendingRecovery(draft: "Older durable message")
    let persistence = FakeChatPersistence(stageCollisionRecovery: recovery)
    let chat = FakeChatFeatureTransport()
    let feature = makeFeature(persistence: persistence, chat: chat)
    feature.setConnection(.online)
    await feature.appear()
    await feature.updateDraft("New draft must not be erased")

    await feature.send()

    #expect(feature.pendingSendRecovery == recovery)
    #expect(feature.state.draft == "New draft must not be erased")
    #expect(feature.state.attachments.isEmpty)
    #expect(feature.canSend == false)
    #expect(feature.draftEditingAllowed == false)
    #expect(await persistence.persistedDraft?.text == "New draft must not be erased")
    #expect(await persistence.persistedPendingSend == recovery.pendingSend)
    #expect(await persistence.stageCallCount == 1)
    #expect(await chat.calls.compactMap(\.sentPayload).isEmpty)
  }

  @Test("recovery changes unblock chat only after the durable pending send is gone")
  func recoveryChangeRequiresDurableNoneBeforeUnblocking() async {
    let recovery = pendingRecovery(draft: "Discard from recovery UI")
    let sanitizedDraft = ConversationDraft(
      text: "  Exact newer composer text\nwith whitespace\t ",
      attachments: [],
      updatedAt: Date(timeIntervalSince1970: 951)
    )
    let recoveryChanges = ConversationRecoveryChangeSignal()
    let persistence = FakeChatPersistence(pendingSendLoadResult: .recoveryRequired(recovery))
    let feature = makeFeature(
      persistence: persistence,
      recoveryChanges: recoveryChanges
    )
    feature.setConnection(.online)
    await feature.appear()

    await recoveryChanges.send(gatewayID: "gateway-1")
    await eventually { await persistence.pendingLoadCallCount >= 2 }
    #expect(feature.pendingSendRecovery == recovery)
    #expect(feature.draftEditingAllowed == false)

    await persistence.setDraft(sanitizedDraft)
    await persistence.setPendingSendLoadResult(.none)
    await recoveryChanges.send(gatewayID: "gateway-1")
    await eventually { await feature.pendingSendRecovery == nil }

    #expect(feature.state.draft == sanitizedDraft.text)
    #expect(feature.state.attachments == sanitizedDraft.attachments)
    #expect(feature.draftStatus == .saved)
    #expect(feature.draftEditingAllowed)
    #expect(feature.canSend)

    await feature.updateDraft("Editing resumes after durable discard")

    #expect(feature.state.draft == "Editing resumes after durable discard")
    #expect(feature.draftEditingAllowed)
    #expect(feature.canSend)
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
    #expect(await chat.turnCalls.isEmpty)

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
        // `appear()` on an online conversation now connects and watches it,
        // so server-initiated turns reach this client (task C7).
        .subscribe(agentID: "agent-1", conversationID: "conv-1"),
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
    // The socket is already connected by `appear()` (task C7), so `connect`
    // no longer trails the staging step. What must still hold — and is the
    // point of the assertion — is that the pending send is DURABLE before the
    // socket write it recovers.
    #expect(stagedSend < send)
    #expect(connect < send)
  }

  @Test(
    """
    resendFromMessage retries a failed turn: truncates the target user message and everything \
    after it, then resends the original text through the normal send path (chat-ux Phase 2 \
    Task 4, audit #5)
    """
  )
  func resendFromMessageRetriesFailedTurn() async throws {
    let sync = FakeChatSynchronizer()
    await sync.enqueueRefresh(
      .success(
        snapshot(
          messages: [
            message(id: "kept-user", turnID: "turn-0", text: "Earlier turn", ordinal: 1),
            message(
              id: "kept-assistant",
              turnID: "turn-0",
              role: .assistant,
              ordinal: 2
            ),
            message(id: "u1", turnID: "turn-orig", text: "Hello", ordinal: 3),
            message(id: "a1", turnID: "turn-orig", role: .assistant, status: .failed, ordinal: 4),
          ],
          throughSeq: 4
        )
      )
    )
    let chat = FakeChatFeatureTransport()
    let turnID = UUID(uuidString: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE")!
    let localID = UUID(uuidString: "11111111-2222-3333-4444-555555555555")!
    let feature = makeFeature(
      sync: sync,
      chat: chat,
      ids: [turnID.uuidString.lowercased(), localID.uuidString.lowercased()]
    )
    feature.setConnection(.online)
    await feature.appear()

    #expect(featureMessageIDs(feature) == ["kept-user", "kept-assistant", "u1", "a1"])

    // fix I5: resolves `true` once the resend actually fired.
    let sent = await feature.resendFromMessage(id: "u1")
    #expect(sent)

    // The failed turn (u1 + a1) is gone; the earlier, unrelated turn is
    // untouched; a fresh optimistic user message replaces it.
    #expect(
      featureMessageIDs(feature) == [
        "kept-user", "kept-assistant", localID.uuidString.lowercased(),
      ])
    #expect(feature.state.messages.last?.turnID == turnID.uuidString.lowercased())
    #expect(feature.state.messages.last?.user?.text == "Hello")
    let calls = await chat.calls
    #expect(
      calls == [
        .connect,
        .subscribe(agentID: "agent-1", conversationID: "conv-1"),
        .send(
          turnID: turnID.uuidString.lowercased(),
          agentID: "agent-1",
          conversationID: "conv-1",
          text: "Hello",
          images: []
        ),
      ])
  }

  @Test(
    """
    resendFromMessage with editedText sends the edited text, not the original, and still \
    truncates from the target message (chat-ux Phase 2 Task 4, audit #5)
    """
  )
  func resendFromMessageEditAndResendUsesEditedText() async throws {
    let sync = FakeChatSynchronizer()
    await sync.enqueueRefresh(
      .success(
        snapshot(
          messages: [
            message(id: "u1", turnID: "turn-orig", text: "Original text", ordinal: 1),
            message(id: "a1", turnID: "turn-orig", role: .assistant, status: .failed, ordinal: 2),
          ],
          throughSeq: 2
        )
      )
    )
    let chat = FakeChatFeatureTransport()
    let turnID = UUID(uuidString: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE")!
    let localID = UUID(uuidString: "11111111-2222-3333-4444-555555555555")!
    let feature = makeFeature(
      sync: sync,
      chat: chat,
      ids: [turnID.uuidString.lowercased(), localID.uuidString.lowercased()]
    )
    feature.setConnection(.online)
    await feature.appear()

    let sent = await feature.resendFromMessage(id: "u1", editedText: "Edited text")
    #expect(sent)

    #expect(feature.state.messages.map(\.id) == [localID.uuidString.lowercased()])
    #expect(feature.state.messages.last?.user?.text == "Edited text")
    let calls = await chat.calls
    #expect(
      calls.compactMap(\.sentPayload).map(\.text) == ["Edited text"]
    )
  }

  @Test("resendFromMessage is a no-op for an id that isn't a user message in the transcript")
  func resendFromMessageIgnoresUnknownID() async throws {
    let sync = FakeChatSynchronizer()
    await sync.enqueueRefresh(
      .success(
        snapshot(
          messages: [
            message(id: "u1", turnID: "turn-orig", text: "Hello", ordinal: 1)
          ],
          throughSeq: 1
        )
      )
    )
    let chat = FakeChatFeatureTransport()
    let feature = makeFeature(sync: sync, chat: chat)
    feature.setConnection(.online)
    await feature.appear()

    // fix I5: resolves `false`, never a silent no-return, for this no-op.
    let sent = await feature.resendFromMessage(id: "does-not-exist")
    #expect(sent == false)

    #expect(featureMessageIDs(feature) == ["u1"])
    let calls = await chat.turnCalls
    #expect(calls.isEmpty)
  }

  @Test(
    """
    resendFromMessage is blocked while another turn is active, same as a plain send — resolves \
    `false` (fix I5) and leaves transcript AND composer state completely untouched, which is \
    what lets `ChatView`'s Edit & Resend sheet decide to stay open with the user's edited text \
    intact instead of dismissing and silently discarding it
    """
  )
  func resendFromMessageBlockedDuringActiveTurn() async throws {
    let sync = FakeChatSynchronizer()
    await sync.enqueueRefresh(
      .success(
        snapshot(
          summary: summary(revision: 2, status: .running, activeTurnID: "turn-active", lastSeq: 2),
          messages: [
            message(id: "u1", turnID: "turn-orig", text: "Hello", ordinal: 1),
            message(id: "a1", turnID: "turn-orig", role: .assistant, status: .failed, ordinal: 2),
          ],
          throughSeq: 2
        )
      )
    )
    let chat = FakeChatFeatureTransport()
    let feature = makeFeature(sync: sync, chat: chat)
    feature.setConnection(.online)
    await feature.appear()
    #expect(feature.state.activeTurnID == "turn-active")
    // `appear()` legitimately issues `.connect`/`.resume` to reattach to the
    // remote turn — capture that baseline so the assertion below is
    // specifically "resendFromMessage sent nothing", not "nothing happened
    // all session".
    let callsBeforeResend = await chat.calls
    let messagesBefore = feature.state.messages
    let draftBefore = feature.state.draft
    let attachmentsBefore = feature.state.attachments

    let sent = await feature.resendFromMessage(id: "u1")

    #expect(sent == false)
    #expect(featureMessageIDs(feature) == ["u1", "a1"])
    #expect(feature.state.messages == messagesBefore)
    #expect(feature.state.draft == draftBefore)
    #expect(feature.state.attachments == attachmentsBefore)
    let calls = await chat.calls
    #expect(calls == callsBeforeResend)
    #expect(calls.contains { $0.sendCall != nil } == false)
  }

  @Test(
    """
    resendFromMessage does not clobber an unrelated in-progress draft/attachment (fix I6) — \
    `send()` has no text/attachments parameter of its own, so a resend has to stage its payload \
    through the SAME `state.draft`/`state.attachments` a genuinely unsent draft lives in; this \
    asserts the snapshot/restore around that borrow actually round-trips the user's own draft \
    intact once the resend completes
    """
  )
  func resendFromMessagePreservesUnrelatedDraftAndAttachments() async throws {
    let sync = FakeChatSynchronizer()
    await sync.enqueueRefresh(
      .success(
        snapshot(
          messages: [
            message(id: "u1", turnID: "turn-orig", text: "Hello", ordinal: 1)
          ],
          throughSeq: 1
        )
      )
    )
    let chat = FakeChatFeatureTransport()
    let turnID = UUID(uuidString: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE")!
    let localID = UUID(uuidString: "11111111-2222-3333-4444-555555555555")!
    let feature = makeFeature(
      sync: sync,
      chat: chat,
      ids: [turnID.uuidString.lowercased(), localID.uuidString.lowercased()]
    )
    feature.setConnection(.online)
    await feature.appear()

    // The user has an unrelated message half-typed, with an image staged,
    // BEFORE triggering a resend of a completely different (older) message.
    await feature.updateDraft("unsent new text")
    await feature.addSelections([ImageSelection(data: Data([1, 2, 3]), type: .png)])
    let stagedAttachments = feature.state.attachments
    #expect(stagedAttachments.isEmpty == false)

    let sent = await feature.resendFromMessage(id: "u1")

    #expect(sent)
    // The resend itself still went through, targeting u1's own text — this
    // isn't a no-op, it's specifically the SUCCESSFUL-resend case where the
    // clobber used to happen.
    let calls = await chat.calls
    #expect(calls.compactMap(\.sentPayload).map(\.text) == ["Hello"])
    // The user's own unrelated draft/attachment — untouched by the resend
    // that borrowed the same composer state to stage ITS payload.
    #expect(feature.state.draft == "unsent new text")
    #expect(feature.state.attachments == stagedAttachments)
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

  @Test("summary-only admission resumes from the durable transcript cursor")
  func summaryOnlyAdmissionUsesDurableCursor() async {
    let persistence = FakeChatPersistence(cursor: 3)
    let sync = FakeChatSynchronizer()
    let chat = FakeChatFeatureTransport()
    await chat.enqueueSend(.failure(.transport("socket closed after send")))
    await sync.enqueueRefresh(
      .success(snapshot(summary: summary(lastSeq: 3), throughSeq: 3))
    )
    let feature = makeFeature(persistence: persistence, sync: sync, chat: chat)
    feature.setConnection(.online)
    await feature.appear()
    await sync.enqueueRefresh(
      .success(
        ChatCanonicalSnapshot(
          summary: summary(
            revision: 2,
            status: .running,
            activeTurnID: "turn-1",
            lastSeq: 8
          ),
          messages: [],
          nextCursor: nil,
          throughSeq: 8,
          hasCanonicalMessagePage: false
        )
      )
    )
    await feature.updateDraft("Resume without skipping stored events")

    await feature.send()

    #expect(
      await chat.calls.contains(
        .resume(
          turnID: "turn-1",
          agentID: "agent-1",
          conversationID: "conv-1",
          sinceSeq: 3
        )
      )
    )
    #expect(await persistence.persistedPendingSend == nil)
  }

  @Test("live tombstone refresh preserves a file-backed pending payload across restart")
  func liveTombstonePreservesPendingPayloadAcrossRestart() async throws {
    URLProtocolStub.reset()
    // `appear()` now reads the conversation's children (§8.4). Standing rather
    // than queued, so this test's POSITIONAL stubs stay in their own order.
    URLProtocolStub.stubEmptySubagentList()
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
    let recoveryChanges = ConversationRecoveryChangeSignal()
    let recoveryChangeStream = await recoveryChanges.changes(gatewayID: "gateway-1")
    let recoveryChange = Task<String?, Never> {
      for await gatewayID in recoveryChangeStream { return gatewayID }
      return nil
    }
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
      recoveryChanges: recoveryChanges,
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
    #expect(feature.statusPresentation == .recoveryRequired)
    #expect(
      pendingPayload(
        try await store.pendingSend(gatewayID: "gateway-1", conversationID: "conv-1")
      ) == expected
    )
    #expect(await recoveryChange.value == "gateway-1")
    #expect(await chat.calls.compactMap(\.sentPayload).count == 1)

    URLProtocolStub.enqueue(
      status: 200,
      data: try ContractCoding.encoder().encode(tombstone)
    )
    await feature.retryConnection()
    #expect(await chat.calls.compactMap(\.sentPayload).count == 1)

    await feature.shutdown()
    let reopened = try PersistenceStore.stored(at: storeURL)
    #expect(
      try await reopened.conversation(gatewayID: "gateway-1", id: "conv-1")?.summary
        == tombstone
    )
    #expect(
      pendingPayload(
        try await reopened.pendingSend(gatewayID: "gateway-1", conversationID: "conv-1")
      ) == expected
    )
    #expect(await chat.calls.compactMap(\.sentPayload).count == 1)
  }

  @Test("live refresh returns the stored canonical when the API summary is stale")
  func liveRefreshReturnsEffectiveStoredCanonical() async throws {
    URLProtocolStub.reset()
    let store = try PersistenceStore.inMemory()
    let current = summary(
      revision: 6,
      status: .running,
      activeTurnID: "turn-current",
      lastSeq: 8
    )
    let stale = summary(revision: 5, lastSeq: 4)
    try await store.upsertConversations([current], gatewayID: "gateway-1")
    URLProtocolStub.enqueue(
      status: 200,
      data: try ContractCoding.encoder().encode(stale)
    )
    URLProtocolStub.enqueue(
      status: 200,
      data: try ContractCoding.encoder().encode(
        ConversationMessagePageDTO(items: [], nextCursor: nil, throughSeq: 4)
      )
    )
    let api = makeChatGatewayAPI()
    let synchronizer = LiveChatSynchronizer(
      gatewayID: "gateway-1",
      store: store,
      makeAPI: { api }
    )

    let snapshot = try await synchronizer.refresh(conversationID: current.id, before: nil)

    #expect(snapshot.summary == current)
    #expect(snapshot.hasCanonicalMessagePage == false)
    #expect(
      try await store.conversation(gatewayID: "gateway-1", id: current.id)?.summary == current
    )
  }

  @Test("a delayed summary 404 cannot remove a newer canonical conversation or its content")
  func liveSummaryNotFoundRetainsNewerCanonical() async throws {
    URLProtocolStub.reset()
    let store = try PersistenceStore.inMemory()
    let initial = summary(revision: 1)
    let revived = summary(revision: 2, status: .running, activeTurnID: "turn-revived", lastSeq: 8)
    let revivedMessage = message(
      id: "revived-message",
      text: "Keep the revived transcript",
      ordinal: 1
    )
    let revivedDraft = ConversationDraft(
      text: "Keep the revived draft",
      attachments: [],
      updatedAt: Date(timeIntervalSince1970: 20)
    )
    try await store.upsertConversations([initial], gatewayID: "gateway-1")
    let responseGate = URLProtocolResponseGate()
    defer { responseGate.release() }
    URLProtocolStub.enqueue(status: 404, waitingOn: responseGate)
    let synchronizer = LiveChatSynchronizer(
      gatewayID: "gateway-1",
      store: store,
      makeAPI: { makeChatGatewayAPI() }
    )

    let refresh = Task {
      try await synchronizer.refresh(conversationID: initial.id, before: nil)
    }
    await eventually { URLProtocolStub.requests.count == 1 }
    try await store.upsertConversations([revived], gatewayID: "gateway-1")
    try await store.mergeMessages(
      [revivedMessage],
      gatewayID: "gateway-1",
      conversationID: revived.id
    )
    try await store.saveDraft(
      revivedDraft,
      gatewayID: "gateway-1",
      conversationID: revived.id
    )
    try await store.advanceCursor(gatewayID: "gateway-1", conversationID: revived.id, to: 8)
    responseGate.release()

    let snapshot = try await refresh.value

    #expect(snapshot.summary == revived)
    #expect(snapshot.hasCanonicalMessagePage == false)
    #expect(try await store.conversation(gatewayID: "gateway-1", id: revived.id)?.summary == revived)
    #expect(
      try await store.messages(gatewayID: "gateway-1", conversationID: revived.id)
        == [revivedMessage]
    )
    #expect(try await store.draft(gatewayID: "gateway-1", conversationID: revived.id) == revivedDraft)
    #expect(try await store.cursor(gatewayID: "gateway-1", conversationID: revived.id) == 8)
  }

  @Test("a delayed message 404 cannot remove a newer canonical conversation or its content")
  func liveMessageNotFoundRetainsNewerCanonical() async throws {
    URLProtocolStub.reset()
    let store = try PersistenceStore.inMemory()
    let initial = summary(revision: 1)
    let revived = summary(revision: 2, status: .running, activeTurnID: "turn-revived", lastSeq: 8)
    let revivedMessage = message(
      id: "revived-message",
      text: "Keep the revived transcript",
      ordinal: 1
    )
    try await store.upsertConversations([initial], gatewayID: "gateway-1")
    URLProtocolStub.enqueue(
      status: 200,
      data: try ContractCoding.encoder().encode(initial)
    )
    let responseGate = URLProtocolResponseGate()
    defer { responseGate.release() }
    URLProtocolStub.enqueue(status: 404, waitingOn: responseGate)
    let synchronizer = LiveChatSynchronizer(
      gatewayID: "gateway-1",
      store: store,
      makeAPI: { makeChatGatewayAPI() }
    )

    let refresh = Task {
      try await synchronizer.refresh(conversationID: initial.id, before: nil)
    }
    await eventually { URLProtocolStub.requests.count == 2 }
    try await store.upsertConversations([revived], gatewayID: "gateway-1")
    try await store.mergeMessages(
      [revivedMessage],
      gatewayID: "gateway-1",
      conversationID: revived.id
    )
    try await store.advanceCursor(gatewayID: "gateway-1", conversationID: revived.id, to: 8)
    responseGate.release()

    let snapshot = try await refresh.value

    #expect(snapshot.summary == revived)
    #expect(snapshot.hasCanonicalMessagePage == false)
    #expect(try await store.conversation(gatewayID: "gateway-1", id: revived.id)?.summary == revived)
    #expect(
      try await store.messages(gatewayID: "gateway-1", conversationID: revived.id)
        == [revivedMessage]
    )
    #expect(try await store.cursor(gatewayID: "gateway-1", conversationID: revived.id) == 8)
  }

  @Test("a delayed replay 404 reports a newer canonical conversation as a conflict")
  func liveReplayNotFoundRetainsNewerCanonical() async throws {
    URLProtocolStub.reset()
    let store = try PersistenceStore.inMemory()
    let initial = summary(revision: 1, status: .running, activeTurnID: "turn-initial")
    let revived = summary(
      revision: 2,
      status: .running,
      activeTurnID: "turn-revived",
      lastSeq: 8
    )
    try await store.upsertConversations([initial], gatewayID: "gateway-1")
    let responseGate = URLProtocolResponseGate()
    defer { responseGate.release() }
    URLProtocolStub.enqueue(status: 404, waitingOn: responseGate)
    let synchronizer = LiveChatSynchronizer(
      gatewayID: "gateway-1",
      store: store,
      makeAPI: { makeChatGatewayAPI() }
    )

    let replay = Task {
      try await synchronizer.replay(
        agentID: initial.agentId,
        conversationID: initial.id,
        sinceSeq: initial.lastSeq
      )
    }
    await eventually { URLProtocolStub.requests.count == 1 }
    try await store.upsertConversations([revived], gatewayID: "gateway-1")
    responseGate.release()

    do {
      _ = try await replay.value
      Issue.record("Expected the stale replay to report a revision conflict")
    } catch let error as GatewayError {
      #expect(error == .revisionConflict(current: revived))
    } catch {
      Issue.record("Expected GatewayError, received \(error)")
    }
    #expect(try await store.conversation(gatewayID: "gateway-1", id: revived.id)?.summary == revived)
  }

  @Test("a live 404 removes the stale cache and exposes the pending send for recovery")
  func liveNotFoundPreservesPendingPayloadForRecovery() async throws {
    URLProtocolStub.reset()
    // `appear()` now reads the conversation's children (§8.4). Standing rather
    // than queued, so this test's POSITIONAL stubs stay in their own order.
    URLProtocolStub.stubEmptySubagentList()
    let directory = FileManager.default.temporaryDirectory.appending(
      path: UUID().uuidString,
      directoryHint: .isDirectory
    )
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let storeURL = directory.appending(path: "dash.store")
    let store = try PersistenceStore.stored(at: storeURL)
    let initial = summary()
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
    URLProtocolStub.enqueue(status: 404)
    let api = makeChatGatewayAPI()
    let sync = LiveChatSynchronizer(
      gatewayID: "gateway-1",
      store: store,
      makeAPI: { api }
    )
    let recoveryChanges = ConversationRecoveryChangeSignal()
    let recoveryChangeStream = await recoveryChanges.changes(gatewayID: "gateway-1")
    let recoveryChange = Task<String?, Never> {
      for await gatewayID in recoveryChangeStream { return gatewayID }
      return nil
    }
    let chat = FakeChatFeatureTransport()
    await chat.enqueueSend(.failure(.transport("socket closed after send")))
    let ids = SequentialUUIDSource(ids: ["turn-missing", "local-missing"])
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
      recoveryChanges: recoveryChanges,
      makeID: { ids.next() }
    )
    feature.setConnection(.online)
    await feature.appear()
    await feature.updateDraft("  Preserve missing conversation text  ")

    await feature.send()

    let expected = PendingChatSend(
      turnID: "turn-missing",
      localUserID: "local-missing",
      draft: "  Preserve missing conversation text  ",
      attachments: [],
      createdAt: Date(timeIntervalSince1970: 1_000)
    )
    #expect(feature.state.conversation.status == .deleted)
    #expect(feature.statusPresentation == .recoveryRequired)
    #expect(feature.draftEditingAllowed == false)
    #expect(feature.canSend == false)
    let removed = try #require(
      try await store.conversation(gatewayID: "gateway-1", id: "conv-1")
    )
    #expect(removed.summary.status == .deleted)
    #expect(try await store.conversations(gatewayID: "gateway-1", limit: 50).isEmpty)
    #expect(
      pendingPayload(
        try await store.pendingSend(gatewayID: "gateway-1", conversationID: "conv-1")
      ) == expected
    )
    let recoveries = try await store.recoverablePendingSends(gatewayID: "gateway-1")
    #expect(recoveries.map(\.conversationID) == ["conv-1"])
    #expect(recoveries.first?.pendingSend == expected)
    #expect(await recoveryChange.value == "gateway-1")
    #expect(await chat.calls.compactMap(\.sentPayload).count == 1)

    URLProtocolStub.enqueue(status: 404)
    await feature.retryConnection()

    #expect(feature.state.conversation.status == .deleted)
    #expect(feature.statusPresentation == .recoveryRequired)
    #expect(
      pendingPayload(
        try await store.pendingSend(gatewayID: "gateway-1", conversationID: "conv-1")
      ) == expected
    )
    #expect(await chat.calls.compactMap(\.sentPayload).count == 1)
  }

  @Test("a deletion between summary and message reads preserves pending recovery")
  func messagesNotFoundPreservesPendingPayloadForRecovery() async throws {
    URLProtocolStub.reset()
    let store = try PersistenceStore.inMemory()
    let initial = summary()
    let pending = PendingChatSend(
      turnID: "turn-missing",
      localUserID: "local-missing",
      draft: "Preserve a mid-refresh deletion",
      attachments: [],
      createdAt: Date(timeIntervalSince1970: 1_000)
    )
    try await store.upsertConversations([initial], gatewayID: "gateway-1")
    try await store.stagePendingSend(
      pending,
      gatewayID: "gateway-1",
      conversationID: initial.id
    )
    URLProtocolStub.enqueue(
      status: 200,
      data: try ContractCoding.encoder().encode(initial)
    )
    URLProtocolStub.enqueue(status: 404)
    let api = makeChatGatewayAPI()
    let sync = LiveChatSynchronizer(
      gatewayID: "gateway-1",
      store: store,
      makeAPI: { api }
    )

    do {
      _ = try await sync.refresh(conversationID: initial.id, before: nil)
      Issue.record("Expected the message-page 404 to classify the conversation as missing")
    } catch GatewayError.notFound {
      // Expected: summary succeeded, then the canonical message page observed deletion.
    } catch {
      Issue.record("Expected notFound, got \(error)")
    }

    let removed = try #require(
      try await store.conversation(gatewayID: "gateway-1", id: initial.id)
    )
    #expect(removed.summary.status == .deleted)
    #expect(try await store.conversations(gatewayID: "gateway-1", limit: 50).isEmpty)
    #expect(
      pendingPayload(
        try await store.pendingSend(gatewayID: "gateway-1", conversationID: initial.id)
      ) == pending
    )
    #expect(
      try await store.recoverablePendingSends(gatewayID: "gateway-1").map(\.pendingSend)
        == [pending]
    )
  }

  @Test("a late acceptance waits for an in-flight missing-conversation classification")
  func lateAcceptanceCannotRaceInFlightMissingClassification() async {
    let refreshGate = TestGate()
    let persistence = FakeChatPersistence()
    let sync = FakeChatSynchronizer()
    let chat = FakeChatFeatureTransport()
    await chat.enqueueSend(.failure(.transport("socket closed after send")))
    let feature = makeFeature(persistence: persistence, sync: sync, chat: chat)
    feature.setConnection(.online)
    await feature.appear()
    await sync.enqueueRefresh(.failure(.notFound), waitingOn: refreshGate)
    await feature.updateDraft("Keep this while the missing chat is classified")

    let sending = Task { await feature.send() }
    await refreshGate.waitUntilWaiting()
    let expected = await persistence.persistedPendingSend
    await chat.yield(.frame(accepted(seq: 1)))
    await chat.yield(.state(.reconnecting(attempt: 6)))
    await eventually { await featureTransport(feature) == .reconnecting(attempt: 6) }

    #expect(await persistence.persistedPendingSend == expected)
    #expect(feature.state.draft.isEmpty)

    await refreshGate.release()
    await sending.value

    #expect(feature.state.conversation.status == .deleted)
    #expect(feature.statusPresentation == .recoveryRequired)
    #expect(await persistence.persistedPendingSend == expected)
    #expect(await chat.calls.compactMap(\.sentPayload).count == 1)
  }

  @Test("acceptance before an ambiguous send return cannot erase deleted recovery")
  func acceptanceBeforeAmbiguousSendReturnPreservesDeletedRecovery() async {
    let sendGate = TestGate()
    let persistence = FakeChatPersistence()
    let sync = FakeChatSynchronizer()
    let chat = FakeChatFeatureTransport(sendGate: sendGate)
    await chat.enqueueSend(.failure(.transport("socket closed after admission")))
    let feature = makeFeature(persistence: persistence, sync: sync, chat: chat)
    feature.setConnection(.online)
    await feature.appear()
    await sync.enqueueRefresh(.failure(.notFound))
    await feature.updateDraft("Keep this accepted message when its chat is gone")

    let sending = Task { await feature.send() }
    await sendGate.waitUntilWaiting()
    let expected = await persistence.persistedPendingSend

    await chat.yield(.frame(accepted(seq: 1)))
    await chat.yield(.state(.reconnecting(attempt: 9)))
    await eventually { await featureTransport(feature) == .reconnecting(attempt: 9) }
    let persistedAfterAccepted = await persistence.persistedPendingSend

    await sendGate.release()
    await sending.value

    #expect(expected != nil)
    #expect(persistedAfterAccepted == expected)
    #expect(await persistence.persistedPendingSend == expected)
    #expect(feature.state.conversation.status == .deleted)
    #expect(feature.statusPresentation == .recoveryRequired)
    #expect(feature.state.draft.isEmpty)
    #expect(await chat.calls.compactMap(\.sentPayload).count == 1)
  }

  @Test("a newer tombstone with a behind sequence drops deferred admission")
  func newerTombstoneWithBehindSequenceDropsDeferredAdmission() async {
    let sendGate = TestGate()
    let persistence = FakeChatPersistence()
    let sync = FakeChatSynchronizer()
    let chat = FakeChatFeatureTransport(sendGate: sendGate)
    await chat.enqueueSend(.failure(.transport("socket closed after admission")))
    let feature = makeFeature(
      conversation: summary(revision: 5, lastSeq: 8),
      persistence: persistence,
      sync: sync,
      chat: chat
    )
    feature.setConnection(.online)
    await feature.appear()
    await sync.enqueueRefresh(
      .success(snapshot(summary: deletedSummary(revision: 6), throughSeq: 0))
    )
    await feature.updateDraft("Keep this when a newer tombstone is authoritative")

    let sending = Task { await feature.send() }
    await sendGate.waitUntilWaiting()
    let expected = await persistence.persistedPendingSend
    await chat.yield(.frame(accepted(seq: 9)))
    await chat.yield(.state(.reconnecting(attempt: 13)))
    await eventually { await featureTransport(feature) == .reconnecting(attempt: 13) }

    await sendGate.release()
    await sending.value

    #expect(expected != nil)
    #expect(await persistence.persistedPendingSend == expected)
    #expect(feature.state.conversation.status == .deleted)
    #expect(feature.statusPresentation == .recoveryRequired)
    #expect(feature.state.draft.isEmpty)
  }

  @Test("a stale tombstone cannot invent recovery or block a newer accepted frame")
  func staleTombstoneRemainsConsistentWithStoreDuringDeferredAdmission() async throws {
    URLProtocolStub.reset()
    // `appear()` now reads the conversation's children (§8.4). Standing rather
    // than queued, so this test's POSITIONAL stubs stay in their own order.
    URLProtocolStub.stubEmptySubagentList()
    let store = try PersistenceStore.inMemory()
    let featureProjection = summary(revision: 4, lastSeq: 4)
    let current = summary(revision: 6, lastSeq: 8)
    let staleTombstone = deletedSummary(revision: 5)
    try await store.upsertConversations([current], gatewayID: "gateway-1")
    URLProtocolStub.enqueue(
      status: 200,
      data: try ContractCoding.encoder().encode(featureProjection)
    )
    URLProtocolStub.enqueue(
      status: 200,
      data: try ContractCoding.encoder().encode(staleTombstone)
    )
    URLProtocolStub.enqueue(
      status: 200,
      data: try ContractCoding.encoder().encode(current)
    )
    URLProtocolStub.enqueue(
      status: 200,
      data: try ContractCoding.encoder().encode(
        ConversationMessagePageDTO(items: [], nextCursor: nil, throughSeq: 8)
      )
    )
    let api = makeChatGatewayAPI()
    let synchronizer = LiveChatSynchronizer(
      gatewayID: "gateway-1",
      store: store,
      makeAPI: { api }
    )
    let sendGate = TestGate()
    let chat = FakeChatFeatureTransport(sendGate: sendGate)
    await chat.enqueueSend(.failure(.transport("socket closed after admission")))
    let ids = SequentialUUIDSource(ids: ["turn-stale", "local-stale"])
    let feature = ChatFeature(
      gatewayID: "gateway-1",
      conversation: featureProjection,
      persistence: LiveChatPersistence(store: store),
      synchronizer: synchronizer,
      transport: chat,
      clock: TestAppClock(now: Date(timeIntervalSince1970: 1_000)),
      announcer: FakeChatAccessibilityAnnouncer(),
      validator: ImageAttachmentValidator(),
      makeID: { ids.next() }
    )
    feature.setConnection(.online)
    await feature.appear()
    await feature.updateDraft("Accept this despite a stale tombstone")

    let sending = Task { await feature.send() }
    await sendGate.waitUntilWaiting()
    await chat.yield(
      .frame(
        .accepted(
          id: "turn-stale",
          conversationId: "conv-1",
          userMessageId: "user-stale",
          assistantMessageId: "assistant-stale",
          revision: 6,
          seq: 9,
          origin: nil,
          kind: nil,
          requestId: nil
        )
      )
    )
    await chat.yield(.state(.reconnecting(attempt: 17)))
    await eventually { await featureTransport(feature) == .reconnecting(attempt: 17) }
    await sendGate.release()
    await sending.value
    await feature.connectionDidBecomeOnline()

    #expect(feature.state.conversation.status != .deleted)
    #expect(
      try await store.conversation(gatewayID: "gateway-1", id: "conv-1")?.summary == current
    )
    #expect(
      pendingPayload(
        try await store.pendingSend(gatewayID: "gateway-1", conversationID: "conv-1")
      ) == nil
    )
    #expect(try await store.recoverablePendingSends(gatewayID: "gateway-1").isEmpty)
  }

  @Test("an equal-revision tombstone rejected by the store cannot invent recovery")
  func equalRevisionTombstoneRemainsConsistentWithStore() async throws {
    URLProtocolStub.reset()
    // `appear()` now reads the conversation's children (§8.4). Standing rather
    // than queued, so this test's POSITIONAL stubs stay in their own order.
    URLProtocolStub.stubEmptySubagentList()
    let store = try PersistenceStore.inMemory()
    let current = summary(revision: 5, lastSeq: 8)
    let rejectedTombstone = deletedSummary(revision: 5)
    try await store.upsertConversations([current], gatewayID: "gateway-1")
    try await store.mergeMessages(
      [message(id: "terminal-user", turnID: "turn-equal", text: "Already admitted", ordinal: 1)],
      gatewayID: "gateway-1",
      conversationID: current.id
    )
    URLProtocolStub.enqueue(
      status: 200,
      data: try ContractCoding.encoder().encode(current)
    )
    URLProtocolStub.enqueue(
      status: 200,
      data: try ContractCoding.encoder().encode(
        ConversationMessagePageDTO(items: [], nextCursor: nil, throughSeq: 8)
      )
    )
    URLProtocolStub.enqueue(
      status: 200,
      data: try ContractCoding.encoder().encode(rejectedTombstone)
    )
    URLProtocolStub.enqueue(
      status: 200,
      data: try ContractCoding.encoder().encode(rejectedTombstone)
    )
    let api = makeChatGatewayAPI()
    let synchronizer = LiveChatSynchronizer(
      gatewayID: "gateway-1",
      store: store,
      makeAPI: { api }
    )
    let chat = FakeChatFeatureTransport()
    await chat.enqueueSend(.failure(.transport("socket closed after send")))
    let ids = SequentialUUIDSource(ids: ["turn-equal", "local-equal"])
    let feature = ChatFeature(
      gatewayID: "gateway-1",
      conversation: current,
      persistence: LiveChatPersistence(store: store),
      synchronizer: synchronizer,
      transport: chat,
      clock: TestAppClock(now: Date(timeIntervalSince1970: 1_000)),
      announcer: FakeChatAccessibilityAnnouncer(),
      validator: ImageAttachmentValidator(),
      makeID: { ids.next() }
    )
    feature.setConnection(.online)
    await feature.appear()
    await feature.updateDraft("Keep this pending without inventing deleted recovery")
    await feature.send()
    await chat.yield(
      .frame(
        .error(
          id: "turn-equal",
          conversationId: "conv-1",
          seq: nil,
          error: "A stale rejection cannot override stored admission",
          code: "validation_failed",
          retryable: false,
          activeTurnId: nil
        )
      )
    )
    await chat.yield(.state(.reconnecting(attempt: 18)))
    await eventually { await featureTransport(feature) == .reconnecting(attempt: 18) }

    #expect(feature.state.conversation.status != .deleted)
    #expect(feature.statusPresentation != .recoveryRequired)
    #expect(
      try await store.conversation(gatewayID: "gateway-1", id: "conv-1")?.summary == current
    )
    #expect(
      pendingPayload(
        try await store.pendingSend(gatewayID: "gateway-1", conversationID: "conv-1")
      ) != nil
    )
    #expect(try await store.draft(gatewayID: "gateway-1", conversationID: "conv-1") == nil)
    #expect(feature.state.draft.isEmpty)
    #expect(try await store.recoverablePendingSends(gatewayID: "gateway-1").isEmpty)
  }

  @Test("a not-found rejection keeps pending bytes through canonical removal")
  func notFoundRejectionPreservesPendingRecovery() async throws {
    URLProtocolStub.reset()
    // `appear()` now reads the conversation's children (§8.4). Standing rather
    // than queued, so this test's POSITIONAL stubs stay in their own order.
    URLProtocolStub.stubEmptySubagentList()
    let store = try PersistenceStore.inMemory()
    let current = summary(revision: 5, lastSeq: 8)
    try await store.upsertConversations([current], gatewayID: "gateway-1")
    URLProtocolStub.enqueue(
      status: 200,
      data: try ContractCoding.encoder().encode(current)
    )
    URLProtocolStub.enqueue(
      status: 200,
      data: try ContractCoding.encoder().encode(
        ConversationMessagePageDTO(items: [], nextCursor: nil, throughSeq: 8)
      )
    )
    URLProtocolStub.enqueue(status: 404, data: Data())
    let api = makeChatGatewayAPI()
    let synchronizer = LiveChatSynchronizer(
      gatewayID: "gateway-1",
      store: store,
      makeAPI: { api }
    )
    let chat = FakeChatFeatureTransport()
    let ids = SequentialUUIDSource(ids: ["turn-not-found", "local-not-found"])
    let feature = ChatFeature(
      gatewayID: "gateway-1",
      conversation: current,
      persistence: LiveChatPersistence(store: store),
      synchronizer: synchronizer,
      transport: chat,
      clock: TestAppClock(now: Date(timeIntervalSince1970: 1_000)),
      announcer: FakeChatAccessibilityAnnouncer(),
      validator: ImageAttachmentValidator(),
      makeID: { ids.next() }
    )
    feature.setConnection(.online)
    await feature.appear()
    await feature.updateDraft("Keep these bytes after the gateway reports deletion")
    await feature.send()
    let expected = pendingPayload(
      try await store.pendingSend(
        gatewayID: "gateway-1",
        conversationID: "conv-1"
      )
    )

    await chat.yield(
      .frame(
        .error(
          id: "turn-not-found",
          conversationId: "conv-1",
          seq: nil,
          error: "Conversation was deleted",
          code: "not_found",
          retryable: false,
          activeTurnId: nil
        )
      )
    )
    await chat.yield(.state(.reconnecting(attempt: 19)))
    await eventually { await featureTransport(feature) == .reconnecting(attempt: 19) }

    #expect(expected != nil)
    #expect(
      pendingPayload(
        try await store.pendingSend(gatewayID: "gateway-1", conversationID: "conv-1")
      ) == expected
    )
    #expect(try await store.recoverablePendingSends(gatewayID: "gateway-1").count == 1)
    #expect(feature.state.conversation.status == .deleted)
    #expect(feature.statusPresentation == .recoveryRequired)
  }

  @Test("rejection before an ambiguous send return cannot purge deleted recovery")
  func rejectionBeforeAmbiguousSendReturnPreservesDeletedRecovery() async {
    let sendGate = TestGate()
    let persistence = FakeChatPersistence()
    let sync = FakeChatSynchronizer()
    let chat = FakeChatFeatureTransport(sendGate: sendGate)
    await chat.enqueueSend(.failure(.transport("socket closed after rejection")))
    let feature = makeFeature(persistence: persistence, sync: sync, chat: chat)
    feature.setConnection(.online)
    await feature.appear()
    await sync.enqueueRefresh(.failure(.notFound))
    await feature.updateDraft("Keep this rejected message when its chat is gone")

    let sending = Task { await feature.send() }
    await sendGate.waitUntilWaiting()
    let expected = await persistence.persistedPendingSend

    await chat.yield(
      .frame(
        .error(
          id: "turn-1",
          conversationId: "conv-1",
          seq: nil,
          error: "A rejection raced the transport return",
          code: "validation_failed",
          retryable: false,
          activeTurnId: nil
        )
      )
    )
    await chat.yield(.state(.reconnecting(attempt: 10)))
    await eventually { await featureTransport(feature) == .reconnecting(attempt: 10) }
    let persistedAfterRejection = await persistence.persistedPendingSend

    await sendGate.release()
    await sending.value

    #expect(expected != nil)
    #expect(persistedAfterRejection == expected)
    #expect(await persistence.persistedPendingSend == expected)
    #expect(feature.state.conversation.status == .deleted)
    #expect(feature.statusPresentation == .recoveryRequired)
    #expect(feature.state.draft.isEmpty)
    #expect(await chat.calls.compactMap(\.sentPayload).count == 1)
  }

  @Test("deferred acceptance stays durable until canonical classification is conclusive")
  func deferredAcceptanceWaitsThroughUnavailableClassification() async {
    let sendGate = TestGate()
    let persistence = FakeChatPersistence()
    let sync = FakeChatSynchronizer()
    let chat = FakeChatFeatureTransport(sendGate: sendGate)
    await chat.enqueueSend(.failure(.transport("socket closed after admission")))
    let feature = makeFeature(persistence: persistence, sync: sync, chat: chat)
    feature.setConnection(.online)
    await feature.appear()
    let refreshCountBeforeSend = await sync.refreshCalls.count
    await sync.enqueueRefresh(.failure(.transport("canonical read unavailable")))
    await feature.updateDraft("Keep accepted bytes until the canonical read succeeds")

    let sending = Task { await feature.send() }
    await sendGate.waitUntilWaiting()
    let expected = await persistence.persistedPendingSend
    await chat.yield(.frame(accepted(seq: 1)))
    await chat.yield(.state(.reconnecting(attempt: 11)))
    await eventually { await featureTransport(feature) == .reconnecting(attempt: 11) }

    await sendGate.release()
    await sending.value

    #expect(expected != nil)
    #expect(await persistence.persistedPendingSend == expected)
    #expect(feature.state.draft.isEmpty)
    #expect(await sync.refreshCalls.count == refreshCountBeforeSend + 1)

    await sync.enqueueRefresh(.failure(.notFound))
    feature.setConnection(.online)
    await feature.connectionDidBecomeOnline()

    #expect(await persistence.persistedPendingSend == expected)
    #expect(feature.state.conversation.status == .deleted)
    #expect(feature.statusPresentation == .recoveryRequired)
  }

  @Test("summary-only recovery performs at most one eager follow-up audit")
  func summaryOnlyRecoveryFollowUpIsBounded() async {
    let sendGate = TestGate()
    let persistence = FakeChatPersistence()
    let sync = FakeChatSynchronizer()
    let chat = FakeChatFeatureTransport(sendGate: sendGate)
    await chat.enqueueSend(.failure(.transport("socket closed after admission")))
    let feature = makeFeature(persistence: persistence, sync: sync, chat: chat)
    feature.setConnection(.online)
    await feature.appear()
    let refreshCountBeforeSend = await sync.refreshCalls.count
    let summaryOnly = ChatCanonicalSnapshot(
      summary: summary(revision: 2),
      messages: [],
      nextCursor: nil,
      throughSeq: 0,
      hasCanonicalMessagePage: false
    )
    await sync.enqueueRefresh(.success(summaryOnly))
    await sync.enqueueRefresh(.success(summaryOnly))
    await feature.updateDraft("Keep this after two summary-only reads")

    let sending = Task { await feature.send() }
    await sendGate.waitUntilWaiting()
    await chat.yield(.frame(accepted(seq: 1)))
    await sendGate.release()
    await sending.value

    #expect(await sync.refreshCalls.count == refreshCountBeforeSend + 2)
    #expect(await persistence.persistedPendingSend?.turnID == "turn-1")
    #expect(await chat.calls.compactMap(\.resumePayload).isEmpty)
  }

  @Test("summary-only recovery follows through to an admitted canonical transcript")
  func summaryOnlyRecoveryFollowUpResolvesAdmission() async {
    let sendGate = TestGate()
    let persistence = FakeChatPersistence(cursor: 3)
    let sync = FakeChatSynchronizer()
    let chat = FakeChatFeatureTransport(sendGate: sendGate)
    await chat.enqueueSend(.failure(.transport("socket closed after admission")))
    let feature = makeFeature(persistence: persistence, sync: sync, chat: chat)
    feature.setConnection(.online)
    await feature.appear()
    await sync.enqueueRefresh(
      .success(
        ChatCanonicalSnapshot(
          summary: summary(revision: 2, lastSeq: 3),
          messages: [],
          nextCursor: nil,
          throughSeq: 3,
          hasCanonicalMessagePage: false
        )
      )
    )
    await sync.enqueueRefresh(
      .success(
        snapshot(
          summary: summary(
            revision: 3,
            status: .running,
            activeTurnID: "turn-1",
            lastSeq: 4
          ),
          throughSeq: 4
        )
      )
    )
    await feature.updateDraft("Resolve this admitted message")

    let sending = Task { await feature.send() }
    await sendGate.waitUntilWaiting()
    await chat.yield(.frame(accepted(seq: 4)))
    await sendGate.release()
    await sending.value

    #expect(await persistence.persistedPendingSend == nil)
    #expect(
      await chat.calls.filter {
        $0.resumePayload?.turnID == "turn-1"
      }.count == 1
    )
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

  @Test("a late accepted frame consumes an armed summary-only follow-up")
  func lateAcceptanceTriggersArmedSummaryOnlyFollowUp() async {
    let sendGate = TestGate()
    let persistence = FakeChatPersistence()
    let sync = FakeChatSynchronizer()
    let chat = FakeChatFeatureTransport(sendGate: sendGate)
    await chat.enqueueSend(.failure(.transport("socket closed before late admission")))
    let feature = makeFeature(persistence: persistence, sync: sync, chat: chat)
    feature.setConnection(.online)
    await feature.appear()
    let refreshCountBeforeSend = await sync.refreshCalls.count
    await sync.enqueueRefresh(
      .success(
        ChatCanonicalSnapshot(
          summary: summary(revision: 2),
          messages: [],
          nextCursor: nil,
          throughSeq: 0,
          hasCanonicalMessagePage: false
        )
      )
    )
    await sync.enqueueRefresh(
      .success(
        snapshot(
          summary: summary(
            revision: 3,
            status: .running,
            activeTurnID: "turn-1",
            lastSeq: 1
          ),
          throughSeq: 1
        )
      )
    )
    await feature.updateDraft("Accept this after the first audit")

    let sending = Task { await feature.send() }
    await sendGate.waitUntilWaiting()
    await sendGate.release()
    await sending.value
    #expect(await sync.refreshCalls.count == refreshCountBeforeSend + 1)
    #expect(await persistence.persistedPendingSend?.turnID == "turn-1")

    await chat.yield(.frame(accepted(seq: 1)))
    await eventually { await persistence.persistedPendingSend == nil }

    #expect(await sync.refreshCalls.count == refreshCountBeforeSend + 2)
    #expect(feature.state.lastAppliedSeq == 1)
  }

  @Test("frames after a held acceptance preserve wire order through recovery")
  func deferredAdmissionPreservesFollowingEventOrder() async {
    let sendGate = TestGate()
    let persistence = FakeChatPersistence()
    let sync = FakeChatSynchronizer()
    let chat = FakeChatFeatureTransport(sendGate: sendGate)
    await chat.enqueueSend(.failure(.transport("socket closed after ordered frames")))
    let feature = makeFeature(persistence: persistence, sync: sync, chat: chat)
    feature.setConnection(.online)
    await feature.appear()
    await sync.enqueueRefresh(
      .success(
        ChatCanonicalSnapshot(
          summary: summary(revision: 2),
          messages: [],
          nextCursor: nil,
          throughSeq: 0,
          hasCanonicalMessagePage: false
        )
      )
    )
    await sync.enqueueRefresh(
      .success(
        snapshot(
          summary: summary(
            revision: 3,
            status: .running,
            activeTurnID: "turn-1",
            lastSeq: 2
          ),
          throughSeq: 0
        )
      )
    )
    await feature.updateDraft("Preserve the question after admission")

    let sending = Task { await feature.send() }
    await sendGate.waitUntilWaiting()
    await chat.yield(.frame(accepted(seq: 1)))
    await chat.yield(.frame(question(seq: 2)))
    await sendGate.release()
    await sending.value
    await eventually {
      await MainActor.run {
        feature.state.messages.first(where: { $0.role == .assistant })?
          .assistant?.pendingQuestion?.id == "question-1"
      }
    }

    #expect(feature.state.lastAppliedSeq == 2)
    #expect(
      feature.state.messages.first(where: { $0.role == .assistant })?
        .assistant?.pendingQuestion?.id == "question-1"
    )
    #expect(await sync.replayCalls.isEmpty)
  }

  @Test("frames arriving during deferred replay remain behind the accepted frame")
  func deferredReplayKeepsOwnershipAcrossPersistenceAwait() async {
    let sendGate = TestGate()
    let cursorGate = TestGate()
    let persistence = FakeChatPersistence(advanceGate: cursorGate)
    let sync = FakeChatSynchronizer()
    let chat = FakeChatFeatureTransport(sendGate: sendGate)
    await chat.enqueueSend(.failure(.transport("socket closed before deferred replay")))
    let feature = makeFeature(persistence: persistence, sync: sync, chat: chat)
    feature.setConnection(.online)
    await feature.appear()
    await sync.enqueueRefresh(
      .success(
        ChatCanonicalSnapshot(
          summary: summary(revision: 2),
          messages: [],
          nextCursor: nil,
          throughSeq: 0,
          hasCanonicalMessagePage: false
        )
      )
    )
    await sync.enqueueRefresh(
      .success(
        snapshot(
          summary: summary(
            revision: 3,
            status: .running,
            activeTurnID: "turn-1",
            lastSeq: 2
          ),
          throughSeq: 0
        )
      )
    )
    await feature.updateDraft("Keep the late question ordered")

    let sending = Task { await feature.send() }
    await sendGate.waitUntilWaiting()
    await chat.yield(.frame(accepted(seq: 1)))
    await sendGate.release()
    await cursorGate.waitUntilWaiting()

    await chat.yield(.frame(question(seq: 2)))
    await cursorGate.release()
    await sending.value
    await eventually {
      await MainActor.run {
        feature.state.messages.first(where: { $0.role == .assistant })?
          .assistant?.pendingQuestion?.id == "question-1"
      }
    }

    #expect(feature.state.lastAppliedSeq == 2)
    #expect(
      feature.state.messages.first(where: { $0.role == .assistant })?
        .assistant?.pendingQuestion?.id == "question-1"
    )
    #expect(await sync.replayCalls.isEmpty)
  }

  @Test("deferred rejection stays durable until canonical classification is conclusive")
  func deferredRejectionWaitsThroughUnavailableClassification() async {
    let sendGate = TestGate()
    let persistence = FakeChatPersistence()
    let sync = FakeChatSynchronizer()
    let chat = FakeChatFeatureTransport(sendGate: sendGate)
    await chat.enqueueSend(.failure(.transport("socket closed after rejection")))
    let feature = makeFeature(persistence: persistence, sync: sync, chat: chat)
    feature.setConnection(.online)
    await feature.appear()
    await sync.enqueueRefresh(.failure(.transport("canonical read unavailable")))
    await feature.updateDraft("Keep rejected bytes until the canonical read succeeds")

    let sending = Task { await feature.send() }
    await sendGate.waitUntilWaiting()
    let expected = await persistence.persistedPendingSend
    await chat.yield(
      .frame(
        .error(
          id: "turn-1",
          conversationId: "conv-1",
          seq: nil,
          error: "A rejection raced an unavailable canonical read",
          code: "validation_failed",
          retryable: false,
          activeTurnId: nil
        )
      )
    )
    await chat.yield(.state(.reconnecting(attempt: 12)))
    await eventually { await featureTransport(feature) == .reconnecting(attempt: 12) }

    await sendGate.release()
    await sending.value

    #expect(expected != nil)
    #expect(await persistence.persistedPendingSend == expected)
    #expect(feature.state.draft.isEmpty)

    await sync.enqueueRefresh(.failure(.notFound))
    feature.setConnection(.online)
    await feature.connectionDidBecomeOnline()

    #expect(await persistence.persistedPendingSend == expected)
    #expect(feature.state.conversation.status == .deleted)
    #expect(feature.statusPresentation == .recoveryRequired)
  }

  @Test("a late accepted frame cannot clear pending recovery or resurrect a deleted chat")
  func lateAcceptedFrameCannotResolveDeletedRecovery() async {
    let persistence = FakeChatPersistence()
    let sync = FakeChatSynchronizer()
    let chat = FakeChatFeatureTransport()
    await chat.enqueueSend(.failure(.transport("socket closed after send")))
    let feature = makeFeature(persistence: persistence, sync: sync, chat: chat)
    feature.setConnection(.online)
    await feature.appear()
    await sync.enqueueRefresh(.success(snapshot(summary: deletedSummary(revision: 2))))
    await feature.updateDraft("Recover this accepted race")
    await feature.send()
    let expected = await persistence.persistedPendingSend

    await chat.yield(.frame(accepted(seq: 1)))
    await chat.yield(.state(.reconnecting(attempt: 7)))
    await eventually { await featureTransport(feature) == .reconnecting(attempt: 7) }

    #expect(feature.state.conversation.status == .deleted)
    #expect(feature.statusPresentation == .recoveryRequired)
    #expect(await persistence.persistedPendingSend == expected)
    #expect(feature.state.draft.isEmpty)
    #expect(await chat.calls.compactMap(\.sentPayload).count == 1)
  }

  @Test("a late rejected frame cannot restore or clear pending recovery")
  func lateRejectedFrameCannotResolveDeletedRecovery() async {
    let persistence = FakeChatPersistence()
    let sync = FakeChatSynchronizer()
    let chat = FakeChatFeatureTransport()
    await chat.enqueueSend(.failure(.transport("socket closed after send")))
    let feature = makeFeature(persistence: persistence, sync: sync, chat: chat)
    feature.setConnection(.online)
    await feature.appear()
    await sync.enqueueRefresh(.success(snapshot(summary: deletedSummary(revision: 2))))
    await feature.updateDraft("Recover this rejected race")
    await feature.send()
    let expected = await persistence.persistedPendingSend

    await chat.yield(
      .frame(
        .error(
          id: "turn-1",
          conversationId: "conv-1",
          seq: nil,
          error: "A stale rejection",
          code: "validation_failed",
          retryable: false,
          activeTurnId: nil
        )
      )
    )
    await chat.yield(.state(.reconnecting(attempt: 8)))
    await eventually { await featureTransport(feature) == .reconnecting(attempt: 8) }

    #expect(feature.state.conversation.status == .deleted)
    #expect(feature.statusPresentation == .recoveryRequired)
    #expect(await persistence.persistedPendingSend == expected)
    #expect(feature.state.draft.isEmpty)
    #expect(await chat.calls.compactMap(\.sentPayload).count == 1)
  }

  @Test("a late terminal frame cannot clear pending recovery or resurrect a deleted chat")
  func lateTerminalFrameCannotResolveDeletedRecovery() async {
    let persistence = FakeChatPersistence()
    let sync = FakeChatSynchronizer()
    let chat = FakeChatFeatureTransport()
    await chat.enqueueSend(.failure(.transport("socket closed after send")))
    let feature = makeFeature(persistence: persistence, sync: sync, chat: chat)
    feature.setConnection(.online)
    await feature.appear()
    await sync.enqueueRefresh(.success(snapshot(summary: deletedSummary(revision: 2))))
    await feature.updateDraft("Recover this terminal race")
    await feature.send()
    let expected = await persistence.persistedPendingSend

    await chat.yield(
      .frame(.done(id: "turn-1", conversationId: "conv-1", seq: 1, outcome: .completed))
    )
    await chat.yield(.state(.reconnecting(attempt: 9)))
    await eventually { await featureTransport(feature) == .reconnecting(attempt: 9) }

    #expect(feature.state.conversation.status == .deleted)
    #expect(feature.statusPresentation == .recoveryRequired)
    #expect(await persistence.persistedPendingSend == expected)
    #expect(feature.state.draft.isEmpty)
    #expect(await chat.calls.compactMap(\.sentPayload).count == 1)
  }

  @Test("accepted cannot resolve pending after persistence learns a tombstone")
  func acceptedPreservesPendingWhenPersistenceConversationIsUnavailable() async {
    let persistence = FakeChatPersistence()
    let sync = FakeChatSynchronizer()
    let chat = FakeChatFeatureTransport()
    let feature = makeFeature(persistence: persistence, sync: sync, chat: chat)
    feature.setConnection(.online)
    await feature.appear()
    await feature.updateDraft("Preserve the cross-component accepted race")
    await feature.send()
    let expected = await persistence.persistedPendingSend
    await persistence.markConversationUnavailable()
    await sync.enqueueRefresh(.failure(.gatewayOffline))

    await chat.yield(.frame(accepted(seq: 1)))
    await chat.yield(.state(.reconnecting(attempt: 14)))
    await eventually { await featureTransport(feature) == .reconnecting(attempt: 14) }

    #expect(expected != nil)
    #expect(await persistence.persistedPendingSend == expected)
    #expect(await persistence.persistedDraft == nil)
    #expect(feature.state.conversation.status == .deleted)
    #expect(feature.statusPresentation == .recoveryRequired)
  }

  @Test("rejection cannot resolve pending after persistence learns a removal")
  func rejectionPreservesPendingWhenPersistenceConversationIsUnavailable() async {
    let persistence = FakeChatPersistence()
    let sync = FakeChatSynchronizer()
    let chat = FakeChatFeatureTransport()
    let feature = makeFeature(persistence: persistence, sync: sync, chat: chat)
    feature.setConnection(.online)
    await feature.appear()
    await feature.updateDraft("Preserve the cross-component rejection race")
    await feature.send()
    let expected = await persistence.persistedPendingSend
    await persistence.markConversationUnavailable()
    await sync.enqueueRefresh(.failure(.gatewayOffline))

    await chat.yield(
      .frame(
        .error(
          id: "turn-1",
          conversationId: "conv-1",
          seq: nil,
          error: "Rejected after remote removal",
          code: "validation_failed",
          retryable: false,
          activeTurnId: nil
        )
      )
    )
    await chat.yield(.state(.reconnecting(attempt: 15)))
    await eventually { await featureTransport(feature) == .reconnecting(attempt: 15) }

    #expect(expected != nil)
    #expect(await persistence.persistedPendingSend == expected)
    #expect(await persistence.persistedDraft == nil)
    #expect(feature.state.conversation.status == .deleted)
    #expect(feature.statusPresentation == .recoveryRequired)
  }

  @Test("deferred frames stop after accepted discovers unavailable persistence")
  func deferredReplayStopsAfterAcceptanceMarksRecoveryRequired() async {
    let sendGate = TestGate()
    let persistence = FakeChatPersistence()
    let sync = FakeChatSynchronizer()
    let chat = FakeChatFeatureTransport(sendGate: sendGate)
    let feature = makeFeature(persistence: persistence, sync: sync, chat: chat)
    feature.setConnection(.online)
    await feature.appear()
    await feature.updateDraft("Keep recovery through every deferred frame")

    let sending = Task { await feature.send() }
    await sendGate.waitUntilWaiting()
    let expected = await persistence.persistedPendingSend
    await persistence.markConversationUnavailable()
    await sync.enqueueRefresh(.success(snapshot()))
    await chat.yield(.frame(accepted(seq: 1)))
    await chat.yield(
      .frame(.done(id: "turn-1", conversationId: "conv-1", seq: 2, outcome: .completed))
    )
    await chat.yield(.state(.reconnecting(attempt: 18)))
    await eventually { await featureTransport(feature) == .reconnecting(attempt: 18) }
    await sendGate.release()
    await sending.value

    #expect(expected != nil)
    #expect(await persistence.persistedPendingSend == expected)
    #expect(feature.state.conversation.status == .deleted)
    #expect(feature.statusPresentation == .recoveryRequired)
    #expect(feature.state.draft.isEmpty)
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
    await sync.enqueueRefresh(.success(snapshot()))
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
      guard await persistence.persistedDraft?.text == "Rejected without admission" else {
        return false
      }
      return await featureDraftText(feature) == "Rejected without admission"
    }
    #expect(feature.state.draft == "Rejected without admission")
    #expect(feature.state.attachments == attachments)
    #expect(feature.state.activeTurnID == nil)
    #expect(await persistence.persistedPendingSend == nil)
    #expect(feature.canSend)
  }

  @Test("an explicit rejection preserves a newer draft beside the earlier pending message")
  func explicitRejectionPreservesNewerDraftAndPendingMessage() async throws {
    let persistence = FakeChatPersistence()
    let sync = FakeChatSynchronizer()
    let chat = FakeChatFeatureTransport()
    let recoveryChanges = ConversationRecoveryChangeSignal()
    let feature = makeFeature(
      persistence: persistence,
      sync: sync,
      chat: chat,
      recoveryChanges: recoveryChanges
    )
    feature.setConnection(.online)
    await feature.appear()
    await feature.updateDraft("Earlier message rejected without admission")

    await feature.send()
    let pending = try #require(await persistence.persistedPendingSend)
    let newerDraft = ConversationDraft(
      text: "Newer draft must remain separate",
      attachments: [
        PreparedAttachment(
          id: UUID(uuidString: "AAAAAAAA-1111-2222-3333-BBBBBBBBBBBB")!,
          mediaType: ImageMediaType.png.rawValue,
          data: Data([4, 5, 6])
        )
      ],
      updatedAt: Date(timeIntervalSince1970: 951)
    )
    try await persistence.saveDraft(
      newerDraft,
      gatewayID: "gateway-1",
      conversationID: "conv-1"
    )
    await sync.enqueueRefresh(.success(snapshot()))
    await chat.yield(
      .frame(
        .error(
          id: pending.turnID,
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
      guard await featureDraftText(feature) == newerDraft.text else { return false }
      return await persistence.persistedPendingSend == pending
    }
    #expect(feature.state.attachments == newerDraft.attachments)
    #expect(await persistence.persistedDraft == newerDraft)
    #expect(await persistence.persistedPendingSend == pending)
    #expect(feature.pendingSendRecovery?.pendingSend == pending)
    #expect(feature.state.activeTurnID == nil)
    #expect(feature.draftEditingAllowed == false)
    #expect(feature.canSend == false)
    #expect(feature.composerDisabledReason == "A saved message needs recovery")
    #expect(feature.statusPresentation == .recoveryRequired)
    #expect(feature.state.errorBanner == nil)

    await persistence.setPendingSendLoadResult(.none)
    await recoveryChanges.send(gatewayID: "gateway-1")
    await eventually { await feature.pendingSendRecovery == nil }

    #expect(feature.state.draft == newerDraft.text)
    #expect(feature.state.attachments == newerDraft.attachments)
    #expect(await persistence.persistedDraft == newerDraft)
    #expect(feature.draftEditingAllowed)
    #expect(feature.canSend)
    #expect(feature.composerDisabledReason == nil)
  }

  @Test("a transcript page behind its summary cannot prove rejection")
  func laggingTranscriptRejectionRetainsPendingSend() async {
    let persistence = FakeChatPersistence()
    let sync = FakeChatSynchronizer()
    let chat = FakeChatFeatureTransport()
    let feature = makeFeature(persistence: persistence, sync: sync, chat: chat)
    feature.setConnection(.online)
    await feature.appear()
    await feature.updateDraft("Keep pending until the transcript catches up")

    await feature.send()
    await sync.enqueueRefresh(
      .success(
        snapshot(
          summary: summary(revision: 2, lastSeq: 8),
          throughSeq: 4
        )
      )
    )
    await chat.yield(
      .frame(
        .error(
          id: "turn-1",
          conversationId: "conv-1",
          seq: nil,
          error: "The transcript is not caught up",
          code: "validation_failed",
          retryable: false,
          activeTurnId: nil
        )
      )
    )
    await chat.yield(.state(.reconnecting(attempt: 22)))
    await eventually { await featureTransport(feature) == .reconnecting(attempt: 22) }

    #expect(feature.state.draft.isEmpty)
    #expect(await persistence.persistedPendingSend?.turnID == "turn-1")
    #expect(await persistence.persistedDraft == nil)
    #expect(feature.canSend == false)
  }

  @Test("a sequenced terminal error cannot restore an admitted send after clear failure")
  func sequencedTerminalErrorDoesNotRestoreAdmittedPendingSend() async {
    let persistence = FakeChatPersistence(failingClearCalls: [1])
    let sync = FakeChatSynchronizer()
    let chat = FakeChatFeatureTransport()
    let feature = makeFeature(persistence: persistence, sync: sync, chat: chat)
    feature.setConnection(.online)
    await feature.appear()
    await feature.updateDraft("Do not make an admitted message resendable")
    await feature.send()
    await sync.enqueueRefresh(.success(snapshot()))

    await chat.yield(.frame(accepted(seq: 1)))
    await chat.yield(
      .frame(
        .error(
          id: "turn-1",
          conversationId: "conv-1",
          seq: 2,
          error: "The admitted turn failed",
          code: "agent_error",
          retryable: false,
          activeTurnId: nil
        )
      )
    )
    await chat.yield(.state(.reconnecting(attempt: 16)))
    await eventually { await featureTransport(feature) == .reconnecting(attempt: 16) }

    #expect(await persistence.persistedPendingSend?.turnID == "turn-1")
    #expect(await persistence.persistedDraft == nil)
    #expect(feature.state.draft.isEmpty)
  }

  @Test("an unsequenced rejection cannot restore a canonically admitted send")
  func unsequencedRejectionDoesNotRestoreAdmittedPendingSend() async {
    let persistence = FakeChatPersistence(failingClearCalls: [1])
    let sync = FakeChatSynchronizer()
    let chat = FakeChatFeatureTransport()
    let feature = makeFeature(persistence: persistence, sync: sync, chat: chat)
    feature.setConnection(.online)
    await feature.appear()
    await feature.updateDraft("Do not make this admitted turn resendable")
    await feature.send()
    await feature.disappear()
    await sync.enqueueRefresh(
      .success(
        snapshot(
          summary: summary(
            revision: 2,
            status: .running,
            activeTurnID: "turn-1",
            lastSeq: 1
          ),
          throughSeq: 1
        )
      )
    )

    await chat.yield(
      .frame(
        .error(
          id: "turn-1",
          conversationId: "conv-1",
          seq: nil,
          error: "A delayed rejection raced canonical admission",
          code: "validation_failed",
          retryable: false,
          activeTurnId: nil
        )
      )
    )
    await chat.yield(.state(.reconnecting(attempt: 20)))
    await eventually { await featureTransport(feature) == .reconnecting(attempt: 20) }

    #expect(await persistence.persistedPendingSend?.turnID == "turn-1")
    #expect(await persistence.persistedDraft == nil)
    #expect(feature.state.draft.isEmpty)
    #expect(await chat.calls.filter { $0 == .suspendForDetachment }.isEmpty)

    await sync.enqueueRefresh(
      .success(
        snapshot(
          summary: summary(
            revision: 2,
            status: .running,
            activeTurnID: "turn-1",
            lastSeq: 1
          ),
          throughSeq: 1
        )
      )
    )
    await feature.connectionDidBecomeOnline()
    #expect(await persistence.persistedPendingSend == nil)

    await feature.cancel()
    #expect(await chat.calls.filter(\.isCancel).count == 1)
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
    let persistence = FakeChatPersistence()
    let sync = FakeChatSynchronizer()
    let chat = FakeChatFeatureTransport()
    await chat.enqueueSend(.failure(.transport("socket closed after send")))
    let feature = makeFeature(persistence: persistence, sync: sync, chat: chat)
    feature.setConnection(.online)
    await feature.appear()
    await sync.enqueueRefresh(.success(snapshot(summary: summary(revision: 0))))
    await feature.updateDraft("Keep pending until a current read")

    await feature.send()

    await sync.enqueueRefresh(.success(snapshot(summary: summary(revision: 0))))
    await chat.yield(
      .frame(
        .error(
          id: "turn-1",
          conversationId: "conv-1",
          seq: nil,
          error: "A stale read cannot prove rejection",
          code: "validation_failed",
          retryable: false,
          activeTurnId: nil
        )
      )
    )
    await chat.yield(.state(.reconnecting(attempt: 21)))
    await eventually { await featureTransport(feature) == .reconnecting(attempt: 21) }

    #expect(feature.state.draft.isEmpty)
    #expect(feature.state.activeTurnID == "turn-1")
    #expect(feature.state.messages.first?.user?.text == "Keep pending until a current read")
    #expect(feature.isAuthoritative == false)
    #expect(feature.canSend == false)
    #expect(await persistence.persistedPendingSend?.turnID == "turn-1")
    #expect(await persistence.persistedDraft == nil)
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

    #expect(await chat.turnCalls.isEmpty)
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

    #expect(await chat.turnCalls.isEmpty)
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

  @Test("preparing shutdown synchronously rejects sends while the drain is blocked")
  func preparedShutdownRejectsSendBeforeDrainCompletes() async {
    let shutdownGate = TestGate()
    let persistence = FakeChatPersistence()
    let sync = FakeChatSynchronizer()
    let chat = FakeChatFeatureTransport(shutdownGate: shutdownGate)
    let feature = makeFeature(persistence: persistence, sync: sync, chat: chat)
    feature.setConnection(.online)
    await feature.appear()
    await feature.updateDraft("Do not send after retirement")

    feature.prepareForShutdown()
    #expect(feature.state.conversation.status == .idle)
    let firstShutdown = Task { await feature.shutdown() }
    let secondShutdown = Task { await feature.shutdown() }
    await shutdownGate.waitUntilWaiting()

    await feature.send()

    #expect(await chat.calls.compactMap(\.sentPayload).isEmpty)
    #expect(feature.isShutdown)
    await shutdownGate.release()
    await firstShutdown.value
    await secondShutdown.value
    #expect(await chat.calls.filter { $0 == .shutdown }.count == 1)
    #expect(await sync.shutdownCount == 1)
  }

  @Test("preparing shutdown synchronously rejects answer and cancel while the drain is blocked")
  func preparedShutdownRejectsTurnMutationsBeforeDrainCompletes() async {
    let shutdownGate = TestGate()
    let sync = FakeChatSynchronizer()
    let chat = FakeChatFeatureTransport(shutdownGate: shutdownGate)
    let feature = makeFeature(sync: sync, chat: chat)
    feature.setConnection(.online)
    await feature.appear()
    await feature.updateDraft("Hello")
    await feature.send()
    await chat.yield(.frame(accepted(seq: 1)))
    await chat.yield(.frame(question(seq: 2)))
    await eventually {
      let canCancel = await feature.canCancel
      let questionID = await pendingQuestion(in: feature)?.id
      return canCancel && questionID == "question-1"
    }
    let answerCount = await chat.calls.filter(\.isAnswer).count
    let cancelCount = await chat.calls.filter(\.isCancel).count

    feature.prepareForShutdown()
    let shutdown = Task { await feature.shutdown() }
    await shutdownGate.waitUntilWaiting()

    await feature.answer(questionID: "question-1", answer: "A")
    await feature.cancel()

    #expect(await chat.calls.filter(\.isAnswer).count == answerCount)
    #expect(await chat.calls.filter(\.isCancel).count == cancelCount)
    await shutdownGate.release()
    await shutdown.value
  }

  @Test("shutdown drains cache loading and rejects its retired result")
  func shutdownDrainsCacheLoadWithoutInstallingRecovery() async {
    let loadGate = TestGate()
    let recovery = pendingRecovery(draft: "Retired cache result")
    let persistence = FakeChatPersistence(
      pendingSendLoadResult: .recoveryRequired(recovery),
      pendingLoadGate: loadGate
    )
    let feature = makeFeature(persistence: persistence)
    let appearance = Task { await feature.appear() }
    await loadGate.waitUntilWaiting()
    let shutdownCompletion = AsyncCompletionProbe()

    let shutdown = Task {
      await feature.shutdown()
      await shutdownCompletion.markComplete()
    }
    await Task.yield()

    #expect(await shutdownCompletion.isComplete == false)
    await loadGate.release()
    await appearance.value
    await shutdown.value

    #expect(feature.pendingSendRecovery == nil)
    #expect(feature.state.draft.isEmpty)
    #expect(feature.state.attachments.isEmpty)
    #expect(feature.isShutdown)
  }

  @Test("shutdown drains recovery subscription acquisition and cancels the late subscription")
  func shutdownDrainsRecoverySubscriptionAcquisition() async {
    let subscriptionGate = TestGate()
    let recoveryChanges = GatedChatRecoveryChangeSignal(gate: subscriptionGate)
    let feature = ChatFeature(
      gatewayID: "gateway-1",
      conversation: summary(),
      persistence: FakeChatPersistence(),
      synchronizer: FakeChatSynchronizer(),
      transport: FakeChatFeatureTransport(),
      clock: TestAppClock(now: Date(timeIntervalSince1970: 1_000)),
      announcer: FakeChatAccessibilityAnnouncer(),
      validator: ImageAttachmentValidator(),
      recoveryChanges: recoveryChanges
    )
    let appearance = Task { await feature.appear() }
    await subscriptionGate.waitUntilWaiting()
    let shutdownCompletion = AsyncCompletionProbe()

    let shutdown = Task {
      await feature.shutdown()
      await shutdownCompletion.markComplete()
    }
    await Task.yield()

    #expect(await shutdownCompletion.isComplete == false)
    await subscriptionGate.release()
    await appearance.value
    await shutdown.value

    #expect(await recoveryChanges.subscriberCount() == 0)
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

    #expect(await chat.turnCalls.isEmpty)
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
          seq: 1,
          origin: nil,
          kind: nil,
          requestId: nil
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

  @Test("a terminal replay does not resume the completed turn")
  func terminalReplayDoesNotResumeCompletedTurn() async throws {
    let persistence = FakeChatPersistence(cursor: 1)
    let sync = FakeChatSynchronizer()
    await sync.enqueueReplay(
      .success([
        replay(seq: 2, payload: .done(outcome: .completed))
      ])
    )
    let chat = FakeChatFeatureTransport()
    let feature = makeFeature(persistence: persistence, sync: sync, chat: chat)
    feature.setConnection(.online)
    await feature.appear()
    await feature.updateDraft("Hello")
    await feature.send()
    await chat.yield(.frame(accepted(seq: 1)))
    await eventually { await feature.state.activeTurnID == "turn-1" }

    await chat.yield(.state(.reconnecting(attempt: 1)))
    await eventually { await feature.statusPresentation == .reconnecting(attempt: 1) }
    await chat.yield(.state(.connected))
    await eventually { await feature.state.lastAppliedSeq == 2 }

    #expect(feature.state.activeTurnID == nil)
    #expect(feature.state.conversation.status == .idle)
    #expect(feature.state.messages.last?.assistant?.terminal == .completed)
    #expect(await chat.calls.filter(\.isResume).isEmpty)
    #expect(
      await sync.replayCalls == [
        ChatReplayCall(agentID: "agent-1", conversationID: "conv-1", sinceSeq: 1)
      ])
  }

  @Test("a superseded active turn is not resumed after replay reports a revision conflict")
  func replayConflictDoesNotResumeSupersededTurn() async throws {
    let persistence = FakeChatPersistence(cursor: 1)
    let sync = FakeChatSynchronizer()
    let revived = summary(
      revision: 2,
      status: .running,
      activeTurnID: "turn-revived",
      lastSeq: 8
    )
    await sync.enqueueReplay(.failure(.revisionConflict(current: revived)))
    let chat = FakeChatFeatureTransport()
    let feature = makeFeature(persistence: persistence, sync: sync, chat: chat)
    feature.setConnection(.online)
    await feature.appear()
    await feature.updateDraft("Hello")
    await feature.send()
    await chat.yield(.frame(accepted(seq: 1)))
    await eventually { await feature.state.activeTurnID == "turn-1" }

    await chat.yield(.state(.reconnecting(attempt: 1)))
    await eventually { await feature.statusPresentation == .reconnecting(attempt: 1) }
    await chat.yield(.state(.connected))
    await eventually {
      await feature.state.errorBanner == "Conversation changed on another device"
    }

    #expect(await chat.calls.filter(\.isResume).isEmpty)
    #expect(
      await sync.replayCalls == [
        ChatReplayCall(agentID: "agent-1", conversationID: "conv-1", sinceSeq: 1)
      ])
  }

  @Test("a nested replay conflict aborts resume and preserves the last complete state")
  func nestedReplayConflictDoesNotResumeSupersededTurn() async throws {
    let persistence = FakeChatPersistence(cursor: 1)
    let sync = FakeChatSynchronizer()
    await sync.enqueueReplay(
      .success([
        replay(seq: 3, payload: .event(event: .textDelta(text: "Gapped")))
      ])
    )
    let revived = summary(
      revision: 3,
      status: .running,
      activeTurnID: "turn-revived",
      lastSeq: 9
    )
    await sync.enqueueReplay(.failure(.revisionConflict(current: revived)))
    let chat = FakeChatFeatureTransport()
    let feature = makeFeature(persistence: persistence, sync: sync, chat: chat)
    feature.setConnection(.online)
    await feature.appear()
    await feature.updateDraft("Hello")
    await feature.send()
    await chat.yield(.frame(accepted(seq: 1)))
    await eventually { await feature.state.activeTurnID == "turn-1" }

    await chat.yield(.state(.reconnecting(attempt: 1)))
    await eventually { await feature.statusPresentation == .reconnecting(attempt: 1) }
    await chat.yield(.state(.connected))
    await eventually {
      await feature.state.errorBanner == "Conversation changed on another device"
    }

    #expect(feature.state.activeTurnID == "turn-1")
    #expect(feature.state.lastAppliedSeq == 1)
    #expect(feature.state.pendingGapFrame == nil)
    #expect(feature.state.messages.contains { $0.assistant?.text == "Gapped" } == false)
    #expect(await chat.calls.filter(\.isResume).isEmpty)
    #expect(
      await sync.replayCalls == [
        ChatReplayCall(agentID: "agent-1", conversationID: "conv-1", sinceSeq: 1),
        ChatReplayCall(agentID: "agent-1", conversationID: "conv-1", sinceSeq: 1),
      ])
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
    // Two connects now: `appear()`'s (task C7 subscribes the open
    // conversation) and the one the recovery attaches with after the terminal
    // failure tore the first socket down.
    #expect(await chat.calls.filter { $0 == .connect }.count == 2)
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
    #expect(await chat.turnCalls.isEmpty)
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
    #expect(await chat.turnCalls.isEmpty)
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

  // MARK: - Host reference counting (whole-branch final review, blocking 1)
  //
  // Task 10 made ONE `ChatFeature` serve TWO hosts at once — the main
  // window's detail column and the chat-only scene `ConversationWindowView`
  // opens (see `ChatFeatureHostView`'s doc comment). The lifecycle
  // bookkeeping did not follow: visibility was a single `Bool`, so the FIRST
  // host to leave suspended the transport out from under a host that was
  // still on screen. This is over the counter itself — plain model logic, no
  // scene needed.

  @Test("one host leaving does not detach a transcript another host is still showing")
  func twoHostsShareOneAttachment() async {
    let running = summary(status: .running, activeTurnID: "turn-1", lastSeq: 2)
    let persistence = FakeChatPersistence(cursor: 2)
    let sync = FakeChatSynchronizer()
    await sync.enqueueRefresh(.success(snapshot(summary: running, throughSeq: 2)))
    await sync.enqueueRefresh(.success(snapshot(summary: running, throughSeq: 2)))
    let chat = FakeChatFeatureTransport()
    let feature = makeFeature(persistence: persistence, sync: sync, chat: chat)
    feature.setConnection(.online)

    // Two hosts on the SAME feature: the main window's detail column, then
    // the conversation window opened from "Open in New Window".
    await feature.appear()
    await feature.appear()
    #expect(feature.hasVisibleHosts)
    #expect(
      await chat.calls.filter { $0 == .connect }.count == 1,
      "the shared feature must really be connected, or the suspend assertions below are vacuous"
    )

    // The turn finishes while BOTH hosts are on screen, which leaves the
    // feature connected AND idle — precisely the state in which `disappear()`
    // suspends.
    await chat.yield(
      .frame(.done(id: "turn-1", conversationId: "conv-1", seq: 3, outcome: .completed))
    )
    await eventually { await feature.state.activeTurnID == nil }
    #expect(await chat.calls.filter { $0 == .suspendForDetachment }.isEmpty)

    await feature.disappear()

    #expect(
      await chat.calls.filter { $0 == .suspendForDetachment }.isEmpty,
      "the other host is still on screen, so its transcript must stay attached"
    )
    #expect(feature.state.transport != .detached)
    #expect(
      feature.hasVisibleHosts,
      "ChatView's onDisappear cleanup reads this to know the transcript is still shown somewhere"
    )

    await feature.disappear()

    #expect(await chat.calls.filter { $0 == .suspendForDetachment }.count == 1)
    #expect(feature.hasVisibleHosts == false)

    // An unbalanced extra teardown must not drive the count negative — that
    // would leave the NEXT genuine departure unable to suspend at all.
    await feature.disappear()
    #expect(await chat.calls.filter { $0 == .suspendForDetachment }.count == 1)
    #expect(feature.hasVisibleHosts == false)
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
    await model.consume(
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

  @Test("app model forwards scene lifecycle to every hidden cached chat")
  func appModelOwnsCachedChatSceneLifecycle() async {
    let profile = chatConnectionProfile(
      gatewayID: "gateway-1",
      id: UUID(uuidString: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE")!
    )
    let firstSummary = summary(
      id: "conv-1",
      status: .running,
      activeTurnID: "turn-1",
      lastSeq: 4
    )
    let secondSummary = summary(
      id: "conv-2",
      status: .running,
      activeTurnID: "turn-2",
      lastSeq: 8
    )
    let firstSync = FakeChatSynchronizer()
    let secondSync = FakeChatSynchronizer()
    await firstSync.enqueueRefresh(
      .success(snapshot(summary: firstSummary, throughSeq: firstSummary.lastSeq))
    )
    await secondSync.enqueueRefresh(
      .success(snapshot(summary: secondSummary, throughSeq: secondSummary.lastSeq))
    )
    let firstChat = FakeChatFeatureTransport()
    let secondChat = FakeChatFeatureTransport()
    let first = makeFeature(
      conversation: firstSummary,
      persistence: FakeChatPersistence(cursor: firstSummary.lastSeq),
      sync: firstSync,
      chat: firstChat
    )
    let second = makeFeature(
      conversation: secondSummary,
      persistence: FakeChatPersistence(cursor: secondSummary.lastSeq),
      sync: secondSync,
      chat: secondChat
    )
    let probe = ChatFeatureMapProbe(features: ["conv-1": first, "conv-2": second])
    let model = AppModel(
      dependencies: AppDependencies(
        clock: TestAppClock(now: Date(timeIntervalSince1970: 100)),
        loadProfile: { profile },
        makeSyncEngine: { _ in ChatLifecycleSyncEngine() },
        makeChatFeature: { _, conversation in probe.make(conversation: conversation) }
      )
    )
    await model.start()
    await model.consume(
      SyncSnapshot(
        connection: .online,
        conversations: [
          CachedConversation(gatewayID: profile.gatewayID, summary: firstSummary),
          CachedConversation(gatewayID: profile.gatewayID, summary: secondSummary),
        ],
        agents: [],
        lastSuccessfulSyncAt: Date(timeIntervalSince1970: 100)
      )
    )
    _ = await model.makeChatFeature(firstSummary)
    _ = await model.makeChatFeature(secondSummary)

    await model.sceneDidEnterBackground()
    await model.sceneWillEnterForeground()

    #expect(await firstChat.calls.contains(.suspendForDetachment))
    #expect(await secondChat.calls.contains(.suspendForDetachment))
    #expect(await firstChat.calls.contains(where: \.isResume))
    #expect(await secondChat.calls.contains(where: \.isResume))
  }

  @Test("a gateway transition supersedes an in-flight cached chat lifecycle pass")
  func gatewayTransitionSupersedesCachedChatSceneLifecycle() async {
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
    let sceneGate = TestGate()
    let activationGate = TestGate()
    let firstChat = FakeChatFeatureTransport()
    let secondChat = FakeChatFeatureTransport()
    let first = makeFeature(
      conversation: summary(id: "conv-1"),
      persistence: FakeChatPersistence(saveGates: [1: sceneGate]),
      chat: firstChat
    )
    let second = makeFeature(
      conversation: summary(id: "conv-2"),
      persistence: FakeChatPersistence(saveGates: [1: sceneGate]),
      chat: secondChat
    )
    let probe = ChatFeatureMapProbe(features: ["conv-1": first, "conv-2": second])
    let model = AppModel(
      dependencies: AppDependencies(
        clock: TestAppClock(now: Date(timeIntervalSince1970: 100)),
        loadProfile: { original },
        makeSyncEngine: { requestedProfile in
          if requestedProfile == replacement {
            await activationGate.wait()
            return replacementEngine
          }
          return originalEngine
        },
        makeChatFeature: { _, conversation in probe.make(conversation: conversation) }
      )
    )
    await model.start()
    await model.consume(
      SyncSnapshot(
        connection: .online,
        conversations: [
          CachedConversation(gatewayID: original.gatewayID, summary: summary(id: "conv-1")),
          CachedConversation(gatewayID: original.gatewayID, summary: summary(id: "conv-2")),
        ],
        agents: [],
        lastSuccessfulSyncAt: Date(timeIntervalSince1970: 100)
      )
    )
    _ = await model.makeChatFeature(summary(id: "conv-1"))
    _ = await model.makeChatFeature(summary(id: "conv-2"))

    let background = Task { await model.sceneDidEnterBackground() }
    await sceneGate.waitUntilWaiting()
    let activation = Task { await model.installPairedProfile(replacement) }
    await activationGate.waitUntilWaiting()
    await sceneGate.release()
    await background.value

    let firstSuspendCount = await firstChat.calls.filter { $0 == .suspendForDetachment }.count
    let secondSuspendCount = await secondChat.calls.filter { $0 == .suspendForDetachment }.count
    #expect(firstSuspendCount + secondSuspendCount == 1)
    #expect(await originalEngine.backgroundCallCount == 0)

    await activationGate.release()
    await activation.value
  }

  @Test("app model retires an optimistic pending chat when sync removes its conversation")
  func appModelRetiresRemovedPendingChat() async {
    let profile = chatConnectionProfile(
      gatewayID: "gateway-1",
      id: UUID(uuidString: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE")!
    )
    let engine = ChatLifecycleSyncEngine()
    let persistence = FakeChatPersistence()
    let sync = FakeChatSynchronizer()
    let chat = FakeChatFeatureTransport()
    await chat.enqueueSend(.failure(.transport("socket closed before removal")))
    let feature = makeFeature(persistence: persistence, sync: sync, chat: chat)
    let probe = ChatFactoryProbe(feature: feature)
    let model = AppModel(
      dependencies: AppDependencies(
        clock: TestAppClock(now: Date(timeIntervalSince1970: 100)),
        loadProfile: { profile },
        makeSyncEngine: { _ in engine },
        makeChatFeature: { profile, conversation in
          probe.make(profile: profile, conversation: conversation)
        }
      )
    )
    await model.start()
    await model.consume(
      SyncSnapshot(
        connection: .online,
        conversations: [CachedConversation(gatewayID: "gateway-1", summary: summary())],
        agents: [],
        lastSuccessfulSyncAt: Date(timeIntervalSince1970: 100)
      )
    )
    _ = await model.makeChatFeature(summary())
    await feature.appear()
    await sync.enqueueRefresh(.failure(.gatewayOffline))
    await feature.updateDraft("Retain this optimistic pending message")
    await feature.send()
    let expected = await persistence.persistedPendingSend

    await model.consume(
      SyncSnapshot(
        connection: .online,
        conversations: [],
        agents: [],
        lastSuccessfulSyncAt: Date(timeIntervalSince1970: 101),
        removedConversationIDs: ["conv-1"]
      )
    )

    await eventually { await featureIsShutdown(feature) }
    #expect(expected != nil)
    #expect(await persistence.persistedPendingSend == expected)
    #expect(feature.state.conversation.status == .deleted)
    #expect(feature.statusPresentation == .recoveryRequired)
    #expect(await chat.calls.contains(.shutdown))
    #expect(await sync.shutdownCount == 1)
  }

  @Test("app model rejects in-flight and stale-route chat creation after removal")
  func appModelRejectsChatCreationSupersededByRemoval() async {
    let profile = chatConnectionProfile(
      gatewayID: "gateway-1",
      id: UUID(uuidString: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE")!
    )
    let engine = ChatLifecycleSyncEngine()
    let firstChat = FakeChatFeatureTransport()
    let secondChat = FakeChatFeatureTransport()
    let firstFeature = makeFeature(chat: firstChat)
    let secondFeature = makeFeature(chat: secondChat)
    let factoryGate = TestGate()
    let factory = GatedChatFactoryProbe(
      gate: factoryGate,
      features: [firstFeature, secondFeature]
    )
    let model = AppModel(
      dependencies: AppDependencies(
        clock: TestAppClock(now: Date(timeIntervalSince1970: 100)),
        loadProfile: { profile },
        makeSyncEngine: { _ in engine },
        makeChatFeature: { profile, conversation in
          await factory.make(profile: profile, conversation: conversation)
        }
      )
    )
    await model.start()
    await model.consume(
      SyncSnapshot(
        connection: .online,
        conversations: [CachedConversation(gatewayID: "gateway-1", summary: summary())],
        agents: [],
        lastSuccessfulSyncAt: Date(timeIntervalSince1970: 100)
      )
    )

    let creation = Task { await model.makeChatFeature(summary()) }
    await factoryGate.waitUntilWaiting()
    model.conversationPath = [
      .transcript("conv-1"),
      .recovery("conv-1"),
      .transcript("conv-other"),
    ]
    model.splitConversationSelection = .transcript("conv-1")
    await model.consume(
      SyncSnapshot(
        connection: .online,
        conversations: [],
        agents: [],
        lastSuccessfulSyncAt: Date(timeIntervalSince1970: 101),
        removedConversationIDs: ["conv-1"]
      )
    )
    #expect(model.conversationPath == [.recovery("conv-1"), .transcript("conv-other")])
    #expect(model.splitConversationSelection == nil)
    model.openConversation("conv-1", presentation: .compact)
    #expect(model.conversationPath == [.recovery("conv-1"), .transcript("conv-other")])
    #expect(await model.makeChatFeature(summary()) == nil)
    #expect(factory.callCount == 1)

    await model.consume(
      SyncSnapshot(
        connection: .online,
        conversations: [CachedConversation(gatewayID: "gateway-1", summary: summary(revision: 2))],
        agents: [],
        lastSuccessfulSyncAt: Date(timeIntervalSince1970: 102)
      )
    )
    model.openConversation("conv-1", presentation: .compact)
    #expect(model.conversationPath.last == .transcript("conv-1"))
    await factoryGate.release()

    #expect(await creation.value == nil)
    #expect(firstFeature.isShutdown)
    #expect(await model.makeChatFeature(summary(revision: 2)) === secondFeature)
    #expect(factory.callCount == 2)
  }

  @Test("same-gateway reactivation preserves removal floors until a strictly newer revival")
  func sameGatewayReactivationPreservesConversationRemovalFloor() async {
    let profile = chatConnectionProfile(
      gatewayID: "gateway-1",
      id: UUID(uuidString: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE")!
    )
    let feature = makeFeature(conversation: summary(revision: 2))
    let factory = ChatFactoryProbe(feature: feature)
    let model = AppModel(
      dependencies: AppDependencies(
        clock: TestAppClock(now: Date(timeIntervalSince1970: 100)),
        loadProfile: { profile },
        makeSyncEngine: { _ in ChatLifecycleSyncEngine() },
        makeChatFeature: { profile, conversation in
          factory.make(profile: profile, conversation: conversation)
        }
      )
    )
    await model.start()
    await model.consume(
      SyncSnapshot(
        connection: .online,
        conversations: [
          CachedConversation(gatewayID: profile.gatewayID, summary: summary(revision: 1))
        ],
        agents: [],
        lastSuccessfulSyncAt: Date(timeIntervalSince1970: 100)
      )
    )
    await model.consume(
      SyncSnapshot(
        connection: .online,
        conversations: [],
        agents: [],
        lastSuccessfulSyncAt: Date(timeIntervalSince1970: 101),
        removedConversationIDs: ["conv-1"]
      )
    )

    await model.installPairedProfile(profile)
    model.openConversation("conv-1", presentation: .compact)
    #expect(model.conversationPath.isEmpty)
    #expect(await model.makeChatFeature(summary(revision: 1)) == nil)
    #expect(factory.callCount == 0)

    await model.consume(
      SyncSnapshot(
        connection: .online,
        conversations: [
          CachedConversation(gatewayID: profile.gatewayID, summary: summary(revision: 1))
        ],
        agents: [],
        lastSuccessfulSyncAt: Date(timeIntervalSince1970: 102)
      )
    )
    #expect(await model.makeChatFeature(summary(revision: 1)) == nil)

    await model.consume(
      SyncSnapshot(
        connection: .online,
        conversations: [
          CachedConversation(gatewayID: profile.gatewayID, summary: summary(revision: 2))
        ],
        agents: [],
        lastSuccessfulSyncAt: Date(timeIntervalSince1970: 103)
      )
    )
    model.openConversation("conv-1", presentation: .compact)
    #expect(model.conversationPath == [.transcript("conv-1")])
    #expect(await model.makeChatFeature(summary(revision: 2)) === feature)
    #expect(factory.callCount == 1)
  }

  @Test("snapshot removal blocks replacement bootstrap until chat retirement drains")
  func snapshotRemovalBlocksReplacementBootstrapUntilRetirementDrains() async {
    let profile = chatConnectionProfile(
      gatewayID: "gateway-1",
      id: UUID(uuidString: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE")!
    )
    let replacement = chatConnectionProfile(
      gatewayID: "gateway-2",
      id: UUID(uuidString: "11111111-2222-3333-4444-555555555555")!
    )
    let originalEngine = ChatLifecycleSyncEngine()
    let replacementEngine = ChatLifecycleSyncEngine()
    let shutdownGate = TestGate()
    let chat = FakeChatFeatureTransport(shutdownGate: shutdownGate)
    let feature = makeFeature(chat: chat)
    let probe = ChatFactoryProbe(feature: feature)
    let completion = AsyncCompletionProbe()
    let model = AppModel(
      dependencies: AppDependencies(
        clock: TestAppClock(now: Date(timeIntervalSince1970: 100)),
        loadProfile: { profile },
        makeSyncEngine: { requestedProfile in
          requestedProfile == profile ? originalEngine : replacementEngine
        },
        makeChatFeature: { profile, conversation in
          probe.make(profile: profile, conversation: conversation)
        }
      )
    )
    await model.start()
    await model.consume(
      SyncSnapshot(
        connection: .online,
        conversations: [CachedConversation(gatewayID: "gateway-1", summary: summary())],
        agents: [],
        lastSuccessfulSyncAt: Date(timeIntervalSince1970: 100)
      )
    )
    _ = await model.makeChatFeature(summary())

    let removal = Task {
      await model.consume(
        SyncSnapshot(
          connection: .online,
          conversations: [],
          agents: [],
          lastSuccessfulSyncAt: Date(timeIntervalSince1970: 101),
          removedConversationIDs: ["conv-1"]
        )
      )
      await completion.markComplete()
    }
    await shutdownGate.waitUntilWaiting()

    #expect(feature.state.conversation.status == .deleted)
    #expect(await completion.isComplete == false)
    let activation = Task { await model.installPairedProfile(replacement) }
    for _ in 0..<100 where model.selectedProfile != replacement {
      await Task.yield()
    }
    #expect(model.selectedProfile == replacement)
    #expect(await replacementEngine.bootstrapCallCount == 0)

    await shutdownGate.release()
    await removal.value
    await activation.value
    #expect(await completion.isComplete)
    #expect(feature.isShutdown)
    #expect(await replacementEngine.bootstrapCallCount == 1)
  }

  @Test("strictly newer revival waits for the removed chat scope to retire")
  func strictlyNewerRevivalWaitsForRemovedChatRetirement() async {
    let profile = chatConnectionProfile(
      gatewayID: "gateway-1",
      id: UUID(uuidString: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE")!
    )
    let shutdownGate = TestGate()
    let original = makeFeature(
      conversation: summary(revision: 1),
      chat: FakeChatFeatureTransport(shutdownGate: shutdownGate)
    )
    let replacement = makeFeature(conversation: summary(revision: 2))
    let factory = SequentialChatFactoryProbe(features: [original, replacement])
    let creationCompletion = AsyncCompletionProbe()
    let model = AppModel(
      dependencies: AppDependencies(
        clock: TestAppClock(now: Date(timeIntervalSince1970: 100)),
        loadProfile: { profile },
        makeSyncEngine: { _ in ChatLifecycleSyncEngine() },
        makeChatFeature: { profile, conversation in
          factory.make(profile: profile, conversation: conversation)
        }
      )
    )
    await model.start()
    await model.consume(
      SyncSnapshot(
        connection: .online,
        conversations: [
          CachedConversation(gatewayID: profile.gatewayID, summary: summary(revision: 1))
        ],
        agents: [],
        lastSuccessfulSyncAt: Date(timeIntervalSince1970: 100)
      )
    )
    #expect(await model.makeChatFeature(summary(revision: 1)) === original)

    let removal = Task {
      await model.consume(
        SyncSnapshot(
          connection: .online,
          conversations: [],
          agents: [],
          lastSuccessfulSyncAt: Date(timeIntervalSince1970: 101),
          removedConversationIDs: ["conv-1"]
        )
      )
    }
    await shutdownGate.waitUntilWaiting()
    await model.consume(
      SyncSnapshot(
        connection: .online,
        conversations: [
          CachedConversation(gatewayID: profile.gatewayID, summary: summary(revision: 2))
        ],
        agents: [],
        lastSuccessfulSyncAt: Date(timeIntervalSince1970: 102)
      )
    )

    let creation = Task {
      let feature = await model.makeChatFeature(summary(revision: 2))
      await creationCompletion.markComplete()
      return feature
    }
    for _ in 0..<100 { await Task.yield() }

    #expect(factory.callCount == 1)
    #expect(await creationCompletion.isComplete == false)
    await shutdownGate.release()
    await removal.value
    #expect(await creation.value === replacement)
    #expect(await creationCompletion.isComplete)
    #expect(factory.callCount == 2)
  }

  @Test("list removal blocks replacement bootstrap until chat retirement drains")
  func listRemovalBlocksReplacementBootstrapUntilRetirementDrains() async {
    let profile = chatConnectionProfile(
      gatewayID: "gateway-1",
      id: UUID(uuidString: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE")!
    )
    let replacement = chatConnectionProfile(
      gatewayID: "gateway-2",
      id: UUID(uuidString: "11111111-2222-3333-4444-555555555555")!
    )
    let originalEngine = ChatLifecycleSyncEngine()
    let replacementEngine = ChatLifecycleSyncEngine()
    let service = LifecycleConversationListService()
    await service.enqueueDelete(.success(deletedSummary(revision: 2)))
    let list = ConversationListFeature(gatewayID: profile.gatewayID, service: service)
    let shutdownGate = TestGate()
    let feature = makeFeature(
      conversation: summary(revision: 1),
      chat: FakeChatFeatureTransport(shutdownGate: shutdownGate)
    )
    let factory = ChatFactoryProbe(feature: feature)
    let model = AppModel(
      dependencies: AppDependencies(
        clock: TestAppClock(now: Date(timeIntervalSince1970: 100)),
        loadProfile: { profile },
        makeSyncEngine: { requestedProfile in
          requestedProfile == profile ? originalEngine : replacementEngine
        },
        makeConversationListFeature: { _ in list },
        makeChatFeature: { profile, conversation in
          factory.make(profile: profile, conversation: conversation)
        }
      )
    )
    await model.start()
    await model.consume(
      SyncSnapshot(
        connection: .online,
        conversations: [
          CachedConversation(gatewayID: profile.gatewayID, summary: summary(revision: 1))
        ],
        agents: [],
        lastSuccessfulSyncAt: Date(timeIntervalSince1970: 100)
      )
    )
    #expect(await model.makeChatFeature(summary(revision: 1)) === feature)

    let removal = Task { await list.delete(id: "conv-1", confirmed: true) }
    await shutdownGate.waitUntilWaiting()
    let activation = Task { await model.installPairedProfile(replacement) }
    for _ in 0..<100 where model.selectedProfile != replacement {
      await Task.yield()
    }

    #expect(model.selectedProfile == replacement)
    #expect(await replacementEngine.bootstrapCallCount == 0)
    await shutdownGate.release()
    await removal.value
    await activation.value
    #expect(feature.isShutdown)
    #expect(await replacementEngine.bootstrapCallCount == 1)
  }

  @Test("list-owned lifecycle changes retire chats and strictly newer refreshes revive them")
  func appModelAppliesListLifecycleWithoutSyncSnapshot() async {
    let profile = chatConnectionProfile(
      gatewayID: "gateway-1",
      id: UUID(uuidString: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE")!
    )
    let active = summary(revision: 1)
    let tombstone = deletedSummary(revision: 2)
    let revived = summary(revision: 3)
    let service = LifecycleConversationListService()
    await service.enqueueDelete(.success(tombstone))
    await service.enqueuePage(ConversationPageDTO(items: [revived], nextCursor: nil))
    await service.enqueueRename(.failure(.notFound))
    let list = ConversationListFeature(gatewayID: profile.gatewayID, service: service)
    let deletionShutdownGate = TestGate()
    let first = makeFeature(
      conversation: active,
      chat: FakeChatFeatureTransport(shutdownGate: deletionShutdownGate)
    )
    let second = makeFeature(conversation: revived)
    let factory = SequentialChatFactoryProbe(features: [first, second])
    let deletionCompletion = AsyncCompletionProbe()
    let model = AppModel(
      dependencies: AppDependencies(
        clock: TestAppClock(now: Date(timeIntervalSince1970: 100)),
        loadProfile: { profile },
        makeSyncEngine: { _ in ChatLifecycleSyncEngine() },
        makeConversationListFeature: { _ in list },
        makeChatFeature: { profile, conversation in
          factory.make(profile: profile, conversation: conversation)
        }
      )
    )
    await model.start()
    await model.consume(
      SyncSnapshot(
        connection: .online,
        conversations: [CachedConversation(gatewayID: profile.gatewayID, summary: active)],
        agents: [],
        lastSuccessfulSyncAt: Date(timeIntervalSince1970: 100)
      )
    )
    #expect(await model.makeChatFeature(active) === first)
    model.conversationPath = [.transcript(active.id), .recovery(active.id)]
    model.splitConversationSelection = .transcript(active.id)

    let deletion = Task {
      await list.delete(id: active.id, confirmed: true)
      await deletionCompletion.markComplete()
    }
    await deletionShutdownGate.waitUntilWaiting()

    #expect(await deletionCompletion.isComplete == false)
    #expect(model.conversationPath == [.recovery(active.id)])
    #expect(model.splitConversationSelection == nil)
    #expect(model.snapshot?.conversations.map(\.summary) == [tombstone])
    #expect(model.snapshot?.removedConversationIDs == [active.id])
    await deletionShutdownGate.release()
    await deletion.value
    #expect(first.isShutdown)
    model.openConversation(active.id, presentation: .compact)
    #expect(model.conversationPath == [.recovery(active.id)])

    await list.refresh()

    #expect(list.conversations.map(\.summary) == [revived])
    #expect(model.snapshot?.conversations.map(\.summary) == [revived])
    #expect(model.snapshot?.removedConversationIDs.isEmpty == true)
    model.openConversation(active.id, presentation: .compact)
    #expect(model.conversationPath.last == .transcript(active.id))
    #expect(await model.makeChatFeature(revived) === second)

    await list.rename(id: revived.id, title: "Still here")

    #expect(second.isShutdown)
    #expect(model.conversationPath == [.recovery(active.id)])
    #expect(model.snapshot?.conversations.isEmpty == true)
    #expect(model.snapshot?.removedConversationIDs == [active.id])
    #expect(factory.callCount == 2)
  }

  @Test("list archived reconciliation immediately makes a cached chat read-only")
  func appModelAppliesArchivedListCanonicalToCachedChat() async {
    let profile = chatConnectionProfile(
      gatewayID: "gateway-1",
      id: UUID(uuidString: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE")!
    )
    let active = summary(revision: 4)
    let archived = summary(revision: 5, status: .archived)
    let staleActive = summary(revision: 4)
    let service = LifecycleConversationListService()
    await service.enqueueDelete(
      .failure(.validation("Archived conversations cannot be deleted"))
    )
    await service.enqueueConversation(.success(archived))
    let list = ConversationListFeature(gatewayID: profile.gatewayID, service: service)
    let chat = makeFeature(conversation: active)
    let factory = ChatFactoryProbe(feature: chat)
    let model = AppModel(
      dependencies: AppDependencies(
        clock: TestAppClock(now: Date(timeIntervalSince1970: 100)),
        loadProfile: { profile },
        makeSyncEngine: { _ in ChatLifecycleSyncEngine() },
        makeConversationListFeature: { _ in list },
        makeChatFeature: { profile, conversation in
          factory.make(profile: profile, conversation: conversation)
        }
      )
    )
    await model.start()
    await model.consume(
      SyncSnapshot(
        connection: .online,
        conversations: [CachedConversation(gatewayID: profile.gatewayID, summary: active)],
        agents: [],
        lastSuccessfulSyncAt: Date(timeIntervalSince1970: 100)
      )
    )
    #expect(await model.makeChatFeature(active) === chat)
    #expect(chat.draftEditingAllowed)

    await list.delete(id: active.id, confirmed: true)

    #expect(list.conversations.map(\.summary) == [archived])
    #expect(chat.state.conversation == archived)
    #expect(chat.draftEditingAllowed == false)
    #expect(chat.canSend == false)

    await model.consume(
      SyncSnapshot(
        connection: .online,
        conversations: [CachedConversation(gatewayID: profile.gatewayID, summary: staleActive)],
        agents: [],
        lastSuccessfulSyncAt: Date(timeIntervalSince1970: 101)
      )
    )

    #expect(chat.state.conversation == archived)
    #expect(chat.draftEditingAllowed == false)
  }

  @Test("missing archived reconciliation retires the cached chat")
  func appModelRetiresCachedChatAfterMissingArchivedReconciliation() async {
    let profile = chatConnectionProfile(
      gatewayID: "gateway-1",
      id: UUID(uuidString: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE")!
    )
    let active = summary(revision: 4)
    let service = LifecycleConversationListService()
    await service.enqueueDelete(
      .failure(.validation("Archived conversations cannot be deleted"))
    )
    await service.enqueueConversation(.failure(.notFound))
    let list = ConversationListFeature(gatewayID: profile.gatewayID, service: service)
    let chat = makeFeature(conversation: active)
    let factory = ChatFactoryProbe(feature: chat)
    let model = AppModel(
      dependencies: AppDependencies(
        clock: TestAppClock(now: Date(timeIntervalSince1970: 100)),
        loadProfile: { profile },
        makeSyncEngine: { _ in ChatLifecycleSyncEngine() },
        makeConversationListFeature: { _ in list },
        makeChatFeature: { profile, conversation in
          factory.make(profile: profile, conversation: conversation)
        }
      )
    )
    await model.start()
    await model.consume(
      SyncSnapshot(
        connection: .online,
        conversations: [CachedConversation(gatewayID: profile.gatewayID, summary: active)],
        agents: [],
        lastSuccessfulSyncAt: Date(timeIntervalSince1970: 100)
      )
    )
    #expect(await model.makeChatFeature(active) === chat)

    await list.delete(id: active.id, confirmed: true)

    #expect(list.conversations.isEmpty)
    #expect(model.snapshot?.conversations.isEmpty == true)
    #expect(model.snapshot?.removedConversationIDs == [active.id])
    #expect(chat.isShutdown)
    #expect(await model.makeChatFeature(active) == nil)
  }

  @Test("chat-owned tombstones retire the cached chat without a sync snapshot")
  func appModelAppliesChatTombstoneWithoutSyncSnapshot() async {
    let sync = FakeChatSynchronizer()
    await sync.enqueueRefresh(
      .success(
        ChatCanonicalSnapshot(
          summary: deletedSummary(revision: 2),
          messages: [],
          nextCursor: nil,
          throughSeq: 0,
          hasCanonicalMessagePage: false
        )
      )
    )
    await assertChatLifecycleDiscoveryRetiresFeature(sync: sync)
  }

  @Test("chat-owned 404 removal retires the cached chat without a sync snapshot")
  func appModelAppliesChatNotFoundWithoutSyncSnapshot() async {
    let sync = FakeChatSynchronizer()
    await sync.enqueueRefresh(.failure(.notFound))
    await assertChatLifecycleDiscoveryRetiresFeature(sync: sync)
  }

  @Test("chat pagination 404 retires the cached chat without a sync snapshot")
  func appModelAppliesChatPaginationNotFoundWithoutSyncSnapshot() async {
    let sync = FakeChatSynchronizer()
    await sync.enqueueRefresh(
      .success(
        snapshot(
          summary: summary(revision: 1),
          nextCursor: "older",
          throughSeq: 0
        )
      )
    )
    await sync.enqueueRefresh(.failure(.notFound))
    let profile = chatConnectionProfile(
      gatewayID: "gateway-1",
      id: UUID(uuidString: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE")!
    )
    let active = summary(revision: 1)
    let list = ConversationListFeature(
      gatewayID: profile.gatewayID,
      service: LifecycleConversationListService()
    )
    let feature = makeFeature(conversation: active, sync: sync)
    let factory = SequentialChatFactoryProbe(features: [feature])
    let model = AppModel(
      dependencies: AppDependencies(
        clock: TestAppClock(now: Date(timeIntervalSince1970: 100)),
        loadProfile: { profile },
        makeSyncEngine: { _ in ChatLifecycleSyncEngine() },
        makeConversationListFeature: { _ in list },
        makeChatFeature: { profile, conversation in
          factory.make(profile: profile, conversation: conversation)
        }
      )
    )
    await model.start()
    await model.consume(
      SyncSnapshot(
        connection: .online,
        conversations: [CachedConversation(gatewayID: profile.gatewayID, summary: active)],
        agents: [],
        lastSuccessfulSyncAt: Date(timeIntervalSince1970: 100)
      )
    )
    #expect(await model.makeChatFeature(active) === feature)
    model.conversationPath = [.transcript(active.id), .recovery(active.id)]
    model.splitConversationSelection = .transcript(active.id)
    await feature.appear()
    #expect(feature.state.olderCursor == "older")

    await feature.loadOlder()
    await eventually { await featureIsShutdown(feature) }

    #expect(feature.state.conversation.status == .deleted)
    #expect(list.conversations.isEmpty)
    #expect(model.conversationPath == [.recovery(active.id)])
    #expect(model.snapshot?.removedConversationIDs == [active.id])
  }

  private func assertChatLifecycleDiscoveryRetiresFeature(
    sync: FakeChatSynchronizer
  ) async {
    let profile = chatConnectionProfile(
      gatewayID: "gateway-1",
      id: UUID(uuidString: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE")!
    )
    let active = summary(revision: 1)
    let list = ConversationListFeature(
      gatewayID: profile.gatewayID,
      service: LifecycleConversationListService()
    )
    let feature = makeFeature(conversation: active, sync: sync)
    let factory = SequentialChatFactoryProbe(features: [feature])
    let model = AppModel(
      dependencies: AppDependencies(
        clock: TestAppClock(now: Date(timeIntervalSince1970: 100)),
        loadProfile: { profile },
        makeSyncEngine: { _ in ChatLifecycleSyncEngine() },
        makeConversationListFeature: { _ in list },
        makeChatFeature: { profile, conversation in
          factory.make(profile: profile, conversation: conversation)
        }
      )
    )
    await model.start()
    await model.consume(
      SyncSnapshot(
        connection: .online,
        conversations: [CachedConversation(gatewayID: profile.gatewayID, summary: active)],
        agents: [],
        lastSuccessfulSyncAt: Date(timeIntervalSince1970: 100)
      )
    )
    #expect(await model.makeChatFeature(active) === feature)
    model.conversationPath = [.transcript(active.id), .recovery(active.id)]
    model.splitConversationSelection = .transcript(active.id)

    await feature.appear()

    await eventually { await featureIsShutdown(feature) }
    #expect(feature.isShutdown)
    #expect(feature.state.conversation.status == .deleted)
    #expect(list.conversations.isEmpty)
    #expect(model.conversationPath == [.recovery(active.id)])
    #expect(model.splitConversationSelection == nil)
    #expect(
      model.snapshot?.conversations.allSatisfy { $0.summary.status == .deleted } == true
    )
    #expect(model.snapshot?.removedConversationIDs == [active.id])
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

  @Test("resendFromMessage refuses a notification row: its text is a system notification, not user input")
  func resendRefusesANotificationRow() async {
    let sync = FakeChatSynchronizer()
    await sync.enqueueRefresh(
      .success(
        snapshot(
          messages: [
            message(
              id: "notif-user",
              turnID: "turn-notification",
              text: "[SYSTEM NOTIFICATION - NOT USER INPUT]",
              ordinal: 1,
              origin: "notification"
            )
          ],
          throughSeq: 1
        )
      )
    )
    let chat = FakeChatFeatureTransport()
    let feature = makeFeature(sync: sync, chat: chat)
    feature.setConnection(.online)
    await feature.appear()

    let sent = await feature.resendFromMessage(id: "notif-user")

    #expect(sent == false)
    #expect(await chat.turnCalls.isEmpty)
    #expect(featureMessageIDs(feature) == ["notif-user"])
  }

  // MARK: - Conversation subscriptions (task C7, sub-agents design 7.6)

  @Test("appearing on an online conversation connects and subscribes to it")
  func appearSubscribesToTheOpenConversation() async {
    let chat = FakeChatFeatureTransport()
    let feature = makeFeature(chat: chat)
    feature.setConnection(.online)

    await feature.appear()

    let calls = await chat.calls
    #expect(calls.contains(.connect))
    #expect(calls.contains(.subscribe(agentID: "agent-1", conversationID: "conv-1")))
  }

  @Test("a transient reconnect does not re-subscribe: the connection replays its own subscriptions")
  func transientReconnectKeepsTheSubscription() async {
    let chat = FakeChatFeatureTransport()
    let feature = makeFeature(chat: chat)
    feature.setConnection(.online)
    await feature.appear()
    await eventually { await chat.subscribeCount == 1 }

    // `ChatConnection.replayTurnSubscriptions` re-sends the subscribe frame
    // over the fresh socket, so the gateway is still watching — the feature
    // must not believe otherwise and send a second one.
    await chat.yield(.state(.reconnecting(attempt: 1)))
    await eventually { await featureTransport(feature) == .reconnecting(attempt: 1) }
    await chat.yield(.state(.connected))
    await eventually { await featureTransport(feature) == .connected }
    await feature.connectionDidBecomeOnline()

    #expect(await chat.subscribeCount == 1)
  }

  @Test("a fresh connect re-subscribes, because connecting clears the connection's subscriptions")
  func reconnectAfterDetachmentResubscribes() async {
    let chat = FakeChatFeatureTransport()
    let feature = makeFeature(chat: chat)
    feature.setConnection(.online)
    await feature.appear()
    await eventually { await chat.subscribeCount == 1 }

    await feature.disappear()
    await feature.appear()

    await eventually { await chat.subscribeCount == 2 }
    #expect(await chat.calls.filter { $0 == .connect }.count == 2)
  }

  @Test("leaving the conversation unsubscribes it, so a long session cannot accumulate subscriptions")
  func disappearUnsubscribes() async {
    let chat = FakeChatFeatureTransport()
    let feature = makeFeature(chat: chat)
    feature.setConnection(.online)
    await feature.appear()

    await feature.disappear()

    let calls = await chat.calls
    #expect(calls.contains(.unsubscribe(agentID: "agent-1", conversationID: "conv-1")))
    #expect(calls.contains(.suspendForDetachment))
  }

  @Test("an offline conversation neither connects nor subscribes")
  func offlineConversationDoesNotSubscribe() async {
    let chat = FakeChatFeatureTransport()
    let feature = makeFeature(chat: chat)
    feature.setConnection(.offline)

    await feature.appear()

    let calls = await chat.calls
    #expect(calls.contains(.connect) == false)
    #expect(calls.contains { if case .subscribe = $0 { return true } else { return false } } == false)
  }

  // MARK: - Sub-agent rows (task D5, sub-agents design 8.1-8.3)

  @Test("expanding a row reads the child's transcript and its oneShot fact, and subscribes to it")
  func expandingASubagentRowLoadsAndSubscribes() async {
    let sync = FakeChatSynchronizer()
    await sync.enqueueSubagentTranscript(
      .success(
        SubagentTranscriptSnapshot(
          messages: [childMessage(id: "c-1", text: "Check the logs")],
          oneShot: true
        )
      )
    )
    let chat = FakeChatFeatureTransport()
    let feature = makeFeature(sync: sync, chat: chat)
    feature.setConnection(.online)
    await feature.appear()

    await feature.setSubagentExpanded("child-1", true).value

    #expect(feature.state.subagentUI["child-1"]?.isExpanded == true)
    #expect(feature.state.subagentUI["child-1"]?.childMessages?.map(\.id) == ["c-1"])
    #expect(feature.state.subagentUI["child-1"]?.oneShot == true)
    #expect(await sync.subagentTranscriptCalls == ["child-1"])
    #expect(
      await chat.calls.contains(.subscribe(agentID: "agent-1", conversationID: "child-1"))
    )

    await feature.setSubagentExpanded("child-1", false).value

    #expect(feature.state.subagentUI["child-1"]?.isExpanded == false)
    #expect(
      await chat.calls.contains(.unsubscribe(agentID: "agent-1", conversationID: "child-1"))
    )
    // Collapsing does not re-read.
    #expect(await sync.subagentTranscriptCalls == ["child-1"])
  }

  @Test(
    """
    a child that cannot be opened reports on its own row and does NOT drive the     conversation into a failure state
    """
  )
  func anUnopenableChildDoesNotTakeTheTranscriptDown() async {
    let sync = FakeChatSynchronizer()
    await sync.enqueueSubagentTranscript(.failure(GatewayError.notFound))
    let feature = makeFeature(sync: sync)
    feature.setConnection(.online)
    await feature.appear()

    await feature.setSubagentExpanded("child-1", true).value

    #expect(feature.state.subagentUI["child-1"]?.lastError == "This agent is no longer available.")
    #expect(feature.state.subagentUI["child-1"]?.childMessages == nil)
    // The conversation itself is untouched — a 404 on a pruned child must not
    // look like the OPEN conversation being deleted.
    #expect(feature.state.errorBanner == nil)
    #expect(feature.connection == .online)
  }

  @Test(
    """
    a row collapsed while its transcript is still loading does not end up with     a live subscription nothing releases
    """
  )
  func collapsingDuringTheLoadLeaksNoSubscription() async {
    let sync = FakeChatSynchronizer()
    let gate = TestGate()
    await sync.enqueueSubagentTranscript(
      .success(SubagentTranscriptSnapshot(messages: [], oneShot: nil)),
      waitingOn: gate
    )
    let chat = FakeChatFeatureTransport()
    let feature = makeFeature(sync: sync, chat: chat)
    feature.setConnection(.online)
    await feature.appear()

    // The expansion parks inside the REST read; the user collapses the row;
    // only then does the read return and the late `subscribeToSubagent` run.
    let expanding = feature.setSubagentExpanded("child-1", true)
    await gate.waitUntilWaiting()
    await feature.setSubagentExpanded("child-1", false).value
    await gate.release()
    await expanding.value

    #expect(feature.state.subagentUI["child-1"]?.isExpanded == false)
    #expect(
      await chat.calls.contains(.subscribe(agentID: "agent-1", conversationID: "child-1")) == false
    )
  }

  @Test("a row at the depth cap toggles open without fetching or subscribing")
  func aCappedRowNeitherFetchesNorSubscribes() async {
    let sync = FakeChatSynchronizer()
    let chat = FakeChatFeatureTransport()
    let feature = makeFeature(sync: sync, chat: chat)
    feature.setConnection(.online)
    await feature.appear()

    await feature.setSubagentExpanded("grandchild-1", true, loadsTranscript: false).value

    #expect(feature.state.subagentUI["grandchild-1"]?.isExpanded == true)
    #expect(await sync.subagentTranscriptCalls.isEmpty)
    #expect(
      await chat.calls.contains(.subscribe(agentID: "agent-1", conversationID: "grandchild-1"))
        == false
    )
  }

  @Test("typing into a child goes through the REST resume, never a message frame")
  func sendingToASubagentUsesTheRestResume() async {
    let sync = FakeChatSynchronizer()
    let chat = FakeChatFeatureTransport()
    let feature = makeFeature(sync: sync, chat: chat, ids: ["req-1", "unused"])
    feature.setConnection(.online)
    await feature.appear()
    await feature.setSubagentExpanded("child-1", true).value

    let sent = await feature.sendToSubagent("child-1", text: "  keep going  ")

    #expect(sent)
    #expect(
      await sync.resumeCalls
        == [SubagentResumeCall(id: "child-1", message: "keep going", requestID: "req-1")]
    )
    // A `message` frame would reach `hub.start` and never
    // `ChildHandle.answerQuestion`. Nothing about a resume touches the socket.
    #expect(await chat.calls.compactMap(\.sentPayload).isEmpty)
    #expect(feature.state.subagentUI["child-1"]?.isSending == false)
    #expect(feature.state.subagentUI["child-1"]?.lastError == nil)
  }

  @Test("a coordinator refusal surfaces verbatim and the optimistic row is withdrawn")
  func aRefusedResumeSurfacesItsReason() async {
    let sync = FakeChatSynchronizer()
    await sync.enqueueResume(.failure(GatewayError.validation("One-shot agents cannot be resumed")))
    let feature = makeFeature(sync: sync, ids: ["req-1", "unused"])
    feature.setConnection(.online)
    await feature.appear()
    await feature.setSubagentExpanded("child-1", true).value

    let sent = await feature.sendToSubagent("child-1", text: "again")

    #expect(sent == false)
    #expect(
      feature.state.subagentUI["child-1"]?.lastError == "One-shot agents cannot be resumed"
    )
    #expect(feature.state.subagentUI["child-1"]?.childMessages?.isEmpty == true)
  }

  // MARK: - Optimism is derived from the subscription set (D5 fix round 1)
  //
  // These four are FEATURE-level on purpose. `SubagentUITests` pins that
  // `.subagentReplyStarted` respects the flag it is handed; nothing there can
  // see what value the send path produces, and that is the exact hole the
  // first review round fell through — a composer hardcoding `false` shipped
  // under a fully green reducer suite.

  @Test(
    """
    a send from a row whose subscription is HELD writes an optimistic row,     because only then can the echoed accepted reconcile it
    """
  )
  func aSubscribedSendIsOptimistic() async {
    let sync = FakeChatSynchronizer()
    let chat = FakeChatFeatureTransport()
    let feature = makeFeature(sync: sync, chat: chat, ids: ["req-1", "unused"])
    feature.setConnection(.online)
    await feature.appear()
    await feature.setSubagentExpanded("child-1", true).value
    #expect(
      await chat.calls.contains(.subscribe(agentID: "agent-1", conversationID: "child-1"))
    )

    #expect(await feature.sendToSubagent("child-1", text: "keep going"))

    #expect(feature.state.subagentUI["child-1"]?.pendingRequestIDs == ["req-1"])
    let row = feature.state.subagentUI["child-1"]?.childMessages?.first { $0.id == "req-1" }
    #expect(row?.user?.text == "keep going")
    #expect(row?.origin == .parent)
  }

  @Test(
    """
    a send with NO subscription held writes no optimistic row, so the accepted     it can never receive cannot leave a permanent duplicate
    """
  )
  func anUnsubscribedSendIsNotOptimistic() async {
    let sync = FakeChatSynchronizer()
    let chat = FakeChatFeatureTransport()
    let feature = makeFeature(sync: sync, chat: chat, ids: ["req-1", "unused"])
    feature.setConnection(.online)
    await feature.appear()
    // Never expanded: the `waiting_input` reply composer renders on a
    // COLLAPSED row, so this is the reply composer's live path.
    #expect(feature.state.subagentUI["child-1"] == nil)

    #expect(await feature.sendToSubagent("child-1", text: "the answer is yes"))

    #expect(feature.state.subagentUI["child-1"]?.pendingRequestIDs.isEmpty == true)
    #expect(feature.state.subagentUI["child-1"]?.childMessages == nil)
    #expect(
      await sync.resumeCalls
        == [SubagentResumeCall(id: "child-1", message: "the answer is yes", requestID: "req-1")]
    )
  }

  @Test(
    """
    backgrounding and returning re-reads and re-subscribes an expanded row, so     a send from the still-open body is not optimistic against a dropped     subscription
    """
  )
  func returningFromTheBackgroundRestoresChildSubscriptions() async {
    let sync = FakeChatSynchronizer()
    await sync.enqueueSubagentTranscript(
      .success(SubagentTranscriptSnapshot(messages: [], oneShot: false))
    )
    await sync.enqueueSubagentTranscript(
      .success(SubagentTranscriptSnapshot(messages: [], oneShot: false))
    )
    let chat = FakeChatFeatureTransport()
    let feature = makeFeature(sync: sync, chat: chat, ids: ["req-1", "unused"])
    feature.setConnection(.online)
    await feature.appear()
    await feature.setSubagentExpanded("child-1", true).value

    // `suspendForDetachment` drops the socket and `ChatConnection.clearAllTurns`
    // empties the gateway-side map with it, and the transport's `.idle` clears
    // `subscribedSubagentIDs` when `consume(.state)` drains it. The body stays
    // open and still looks live.
    await feature.sceneDidEnterBackground()
    await feature.sceneWillEnterForeground()

    #expect(await sync.subagentTranscriptCalls == ["child-1", "child-1"])
    #expect(
      await chat.calls.filter { $0 == .subscribe(agentID: "agent-1", conversationID: "child-1") }
        .count == 2
    )

    // And the send from that body is optimistic again, because the
    // subscription that makes an `accepted` reachable is genuinely back.
    #expect(await feature.sendToSubagent("child-1", text: "keep going"))
    #expect(feature.state.subagentUI["child-1"]?.pendingRequestIDs == ["req-1"])
  }

  @Test(
    """
    a row at the depth cap is NOT re-read or re-subscribed on return, because     its expansion never opened a transcript to stream into
    """
  )
  func returningFromTheBackgroundLeavesCappedRowsAlone() async {
    let sync = FakeChatSynchronizer()
    let chat = FakeChatFeatureTransport()
    let feature = makeFeature(sync: sync, chat: chat)
    feature.setConnection(.online)
    await feature.appear()
    await feature.setSubagentExpanded("grandchild-1", true, loadsTranscript: false).value

    await feature.sceneDidEnterBackground()
    await feature.sceneWillEnterForeground()

    #expect(feature.state.subagentUI["grandchild-1"]?.isExpanded == true)
    #expect(await sync.subagentTranscriptCalls.isEmpty)
    #expect(
      await chat.calls.contains(.subscribe(agentID: "agent-1", conversationID: "grandchild-1"))
        == false
    )
  }

  @Test(
    """
    a row whose subscribe never landed self-heals on the next appear(), because     the resubscribe filter reads the UI slice and not a record of what was     subscribed
    """
  )
  func aRowThatNeverSubscribedSelfHealsOnTheNextAppear() async {
    let sync = FakeChatSynchronizer()
    await sync.enqueueSubagentTranscript(
      .success(SubagentTranscriptSnapshot(messages: [], oneShot: false))
    )
    await sync.enqueueSubagentTranscript(
      .success(SubagentTranscriptSnapshot(messages: [], oneShot: false))
    )
    let chat = FakeChatFeatureTransport()
    let feature = makeFeature(sync: sync, chat: chat, ids: ["req-1", "unused"])

    // Expanding while `.offline` reproduces the STATE a swallowed subscribe
    // failure leaves behind, without needing a failure hook on the double:
    // `subscribeToSubagent` returns at its `connection == .online` guard,
    // before the insert, so the row is `isExpanded && opensTranscript` and
    // absent from `subscribedSubagentIDs` — the whole of what
    // `resubscribeExpandedSubagents`'s filter reads. What this does NOT
    // reproduce is a throw inside the `do` block; the swallow itself is still
    // only reasoned about.
    feature.setConnection(.offline)
    await feature.appear()
    await feature.setSubagentExpanded("child-1", true).value

    #expect(feature.state.subagentUI["child-1"]?.isExpanded == true)
    #expect(await sync.subagentTranscriptCalls == ["child-1"])
    #expect(
      await chat.calls.contains(.subscribe(agentID: "agent-1", conversationID: "child-1")) == false
    )

    feature.setConnection(.online)
    await feature.appear()

    #expect(await sync.subagentTranscriptCalls == ["child-1", "child-1"])
    #expect(
      await chat.calls.filter { $0 == .subscribe(agentID: "agent-1", conversationID: "child-1") }
        .count == 1
    )

    // And the row is genuinely subscribed again, so a send from it is
    // optimistic — the property the self-heal exists to restore. A filter keyed
    // on a REMEMBERED subscription set rather than on the UI slice would leave
    // this row out and redden all three assertions above and this one.
    #expect(await feature.sendToSubagent("child-1", text: "keep going"))
    #expect(feature.state.subagentUI["child-1"]?.pendingRequestIDs == ["req-1"])
  }

  @Test(
    """
    a transcript READ failing while a send is in flight leaves the send armed —     asserted where the ACTION is chosen, not where it is reduced
    """
  )
  func aFailedReadDoesNotDisarmAnInFlightSendAtTheFeatureLevel() async {
    let sync = FakeChatSynchronizer()
    let gate = TestGate()
    await sync.enqueueSubagentTranscript(
      .success(SubagentTranscriptSnapshot(messages: [], oneShot: false))
    )
    // The send parks inside the resume; the concurrent re-read fails.
    await sync.enqueueResume(.success(()), waitingOn: gate)
    await sync.enqueueSubagentTranscript(.failure(GatewayError.notFound))
    let feature = makeFeature(sync: sync, ids: ["req-1", "unused"])
    feature.setConnection(.online)
    await feature.appear()
    await feature.setSubagentExpanded("child-1", true).value

    let sending = Task { await feature.sendToSubagent("child-1", text: "keep going") }
    await gate.waitUntilWaiting()
    #expect(feature.state.subagentUI["child-1"]?.isSending == true)

    await feature.loadSubagentTranscript(childID: "child-1")

    // The read reports on the row and disarms nothing.
    #expect(feature.state.subagentUI["child-1"]?.lastError == "This agent is no longer available.")
    #expect(feature.state.subagentUI["child-1"]?.isSending == true)
    #expect(feature.state.subagentUI["child-1"]?.pendingRequestIDs == ["req-1"])

    await gate.release()
    #expect(await sending.value)
    #expect(feature.state.subagentUI["child-1"]?.isSending == false)
  }

  @Test(
    """
    an unsent sub-agent draft survives a collapse and is keyed per composer,     which is web's behaviour and what `@State` in the composer could not do
    """
  )
  func subagentComposerDraftsSurviveCollapseAndDoNotShareABuffer() async {
    let feature = makeFeature()
    feature.setConnection(.online)
    await feature.appear()
    await feature.setSubagentExpanded("child-1", true).value

    feature.setSubagentComposerDraft("body:child-1", "half a sentence")
    feature.setSubagentComposerDraft("reply:child-1", "the answer is yes")

    // One child renders BOTH composers when it is `waiting_input` and open.
    #expect(feature.subagentComposerDraft("body:child-1") == "half a sentence")
    #expect(feature.subagentComposerDraft("reply:child-1") == "the answer is yes")

    await feature.setSubagentExpanded("child-1", false).value
    await feature.setSubagentExpanded("child-1", true).value

    #expect(feature.subagentComposerDraft("body:child-1") == "half a sentence")
    #expect(feature.subagentComposerDraft("reply:child-1") == "the answer is yes")

    // Clearing REMOVES the key, so a long session does not accumulate one
    // entry per composer it has ever rendered.
    feature.setSubagentComposerDraft("body:child-1", "")
    #expect(feature.subagentComposerDraft("body:child-1").isEmpty)
    #expect(feature.subagentComposerDrafts.keys.contains("body:child-1") == false)
    #expect(feature.subagentComposerDrafts == ["reply:child-1": "the answer is yes"])
  }

  @Test("resendFromMessage refuses an orchestrator-authored row, not just a notification row")
  func resendRefusesOrchestratorAuthoredRows() async {
    // Seeded through the cache, which is the only writer of `state.messages`
    // a test can drive — and it is also the realistic path: a child transcript
    // reaches this client as ordinary `ConversationMessage` rows carrying
    // `origin: "parent"`.
    let parentAuthored = ConversationMessageDTO(
      id: "p1",
      conversationId: "conv-1",
      turnId: "child-turn",
      ordinal: 1,
      role: .user,
      status: .completed,
      content: .user(text: "Check the logs", images: nil),
      createdAt: Date(timeIntervalSince1970: 1),
      updatedAt: Date(timeIntervalSince1970: 1),
      origin: MessageOrigin.parent.rawValue
    )
    let persistence = FakeChatPersistence(messages: [parentAuthored])
    let sync = FakeChatSynchronizer()
    await sync.enqueueRefresh(.success(snapshot(messages: [parentAuthored], throughSeq: 1)))
    let feature = makeFeature(persistence: persistence, sync: sync)
    feature.setConnection(.online)
    await feature.appear()
    #expect(feature.state.messages.map(\.origin) == [.parent])

    let resent = await feature.resendFromMessage(id: "p1")

    #expect(resent == false)
    #expect(feature.state.messages.map(\.id) == ["p1"])
  }

  private func childMessage(id: String, text: String) -> ConversationMessageDTO {
    ConversationMessageDTO(
      id: id,
      conversationId: "child-1",
      turnId: "child-turn",
      ordinal: 1,
      role: .user,
      status: .completed,
      content: .user(text: text, images: nil),
      createdAt: Date(timeIntervalSince1970: 1),
      updatedAt: Date(timeIntervalSince1970: 1),
      origin: MessageOrigin.parent.rawValue
    )
  }

  // MARK: - Tasks list (§8.4)

  @Test(
    """
    the tasks list is read from REST on open, and its live count includes a     depth-capped child and an unknown status
    """
  )
  func theTasksListIsReadFromRESTOnOpen() async {
    let sync = FakeChatSynchronizer()
    await sync.enqueueSubagentList(
      .success([
        listEntry(id: "child-1", status: "running"),
        // Past `maxSubagentDepth`, so no ROW would open a transcript for it —
        // but §8.4's badge counts children, not openable rows.
        listEntry(id: "grandchild-1", status: "waiting_input", depth: 2),
        // A status this build has never heard of. Web reads an unknown status
        // as live (`isTerminalSubagentStatus` answers false), and hiding a
        // running child from the badge and from Stop is the worse of the two
        // failures.
        listEntry(id: "child-2", status: "hibernating"),
        listEntry(id: "child-3", status: "max_turns"),
      ])
    )
    let feature = makeFeature(sync: sync)
    feature.setConnection(.online)

    await feature.appear()

    #expect(await sync.subagentListCalls == ["conv-1"])
    #expect(feature.subagents.map(\.id) == ["child-1", "grandchild-1", "child-2", "child-3"])
    #expect(feature.liveSubagentCount == 3)
  }

  @Test("only the newest list read ever writes, however the two answer")
  func onlyTheNewestListReadEverWrites() async {
    let stale = TestGate()
    let sync = FakeChatSynchronizer()
    // First read: the child is still running. Gated, so it answers LAST.
    await sync.enqueueSubagentList(.success([listEntry(id: "child-1", status: "running")]), waitingOn: stale)
    // Second read, issued after it: the child has finished.
    await sync.enqueueSubagentList(.success([listEntry(id: "child-1", status: "done")]))
    let feature = makeFeature(sync: sync)
    feature.setConnection(.online)

    let first = Task { await feature.refreshSubagents() }
    // The gate is entered inside the fake, so waiting on it proves the first
    // read has taken its queued answer before the second is issued — without
    // it this test would be racing its own fixture rather than the guard.
    await stale.waitUntilWaiting()
    await feature.refreshSubagents()
    #expect(feature.subagents.first?.status == "done")

    await stale.release()
    await first.value

    // The stale answer lands second and must change nothing.
    #expect(feature.subagents.first?.status == "done")
    #expect(feature.liveSubagentCount == 0)
  }

  @Test("a list read that says nothing new invalidates nothing, and one that does, does")
  func anIdenticalListReadInvalidatesNothing() async {
    let sync = FakeChatSynchronizer()
    let entries = [listEntry(id: "child-1", status: "running")]
    await sync.enqueueSubagentList(.success(entries))
    await sync.enqueueSubagentList(.success(entries))
    await sync.enqueueSubagentList(.success([listEntry(id: "child-1", status: "done")]))
    let feature = makeFeature(sync: sync)
    feature.setConnection(.online)
    await feature.appear()

    // The badge re-reads on EVERY parent turn's `done`, so an ordinary chat
    // with one finished child pays for this once per assistant turn. It must
    // cost nothing when the answer has not moved.
    let identical = InvalidationFlag()
    withObservationTracking { _ = feature.subagents } onChange: { identical.fire() }
    await feature.refreshSubagents()
    #expect(await sync.subagentListCalls.count == 2)
    #expect(identical.didFire == false)

    // The positive control, in the SAME test, because a negative assertion
    // against an observation tracker is worthless without one — a dead tracker
    // and a silent write look identical.
    let changed = InvalidationFlag()
    withObservationTracking { _ = feature.subagents } onChange: { changed.fire() }
    await feature.refreshSubagents()
    #expect(changed.didFire)
    #expect(feature.subagents.first?.status == "done")
  }

  @Test("a list write never invalidates the transcript, because it is not in ChatState")
  func aListWriteDoesNotInvalidateTheTranscript() async {
    let sync = FakeChatSynchronizer()
    await sync.enqueueSubagentList(.success([listEntry(id: "child-1", status: "running")]))
    let feature = makeFeature(sync: sync)
    feature.setConnection(.online)

    // `ChatView` reads `feature.state`, which is ONE stored property, so a list
    // kept there would re-render the whole transcript once per assistant turn —
    // web measured exactly that fan-out as its D3 I3a. The control below proves
    // the tracker is live rather than dead.
    let stateInvalidated = InvalidationFlag()
    let listInvalidated = InvalidationFlag()
    withObservationTracking { _ = feature.state } onChange: { stateInvalidated.fire() }
    withObservationTracking { _ = feature.subagents } onChange: { listInvalidated.fire() }
    await feature.refreshSubagents()

    #expect(listInvalidated.didFire)
    #expect(stateInvalidated.didFire == false)
  }

  @Test("a list read that lands after the feature was retired writes nothing")
  func aListReadThatLandsAfterShutdownWritesNothing() async {
    let gate = TestGate()
    let sync = FakeChatSynchronizer()
    await sync.enqueueSubagentList(
      .success([listEntry(id: "child-1", status: "running")]),
      waitingOn: gate
    )
    let feature = makeFeature(sync: sync)
    feature.setConnection(.online)

    let read = Task { await feature.refreshSubagents() }
    await gate.waitUntilWaiting()
    feature.prepareForShutdown()
    await gate.release()
    await read.value

    // The iOS counterpart of web's conversation-switch guard: `AppModel` keys a
    // `ChatFeature` by (gateway, conversation), so a read can only ever land on
    // the conversation that issued it — but the feature can be retired under it.
    #expect(feature.subagents.isEmpty)
  }

  @Test(
    """
    a background child's finish is read from the notification turn's accepted     and again from the turn's done, and no other frame pays for a read
    """
  )
  func theListIsReadOnTheTriggersThatCanChangeIt() async {
    let sync = FakeChatSynchronizer()
    let chat = FakeChatFeatureTransport()
    let feature = makeFeature(sync: sync, chat: chat)
    feature.setConnection(.online)
    await feature.appear()
    #expect(await sync.subagentListCalls.count == 1)

    // An ordinary user turn's `accepted` says nothing about any child.
    await chat.yield(.frame(acceptedFrame(origin: nil)))
    await settle()
    #expect(await sync.subagentListCalls.count == 1)

    // The notification turn the gateway starts to hand the orchestrator a
    // BACKGROUND child's result — the only thing about that finish that ever
    // reaches the parent.
    await chat.yield(.frame(acceptedFrame(origin: .notification)))
    await eventually { await sync.subagentListCalls.count == 2 }

    // `subagent_progress` is transient and never persisted; reading on it would
    // be a round trip per tool call.
    await chat.yield(.frame(subagentProgressFrame()))
    await settle()
    #expect(await sync.subagentListCalls.count == 2)

    await chat.yield(.frame(subagentStartedFrame()))
    await eventually { await sync.subagentListCalls.count == 3 }

    // A CHILD's own frames reach this socket because the client subscribed to
    // the child; none of them says anything about the parent's children.
    await chat.yield(
      .frame(.done(id: "child-turn", conversationId: "child-1", seq: 1, outcome: .completed))
    )
    await settle()
    #expect(await sync.subagentListCalls.count == 3)

    await chat.yield(
      .frame(.done(id: "turn-1", conversationId: "conv-1", seq: 9, outcome: .completed))
    )
    await eventually { await sync.subagentListCalls.count == 4 }
  }

  @Test("stopping a child applies the route's own status before the re-read")
  func stoppingAChildAppliesTheRoutesOwnStatus() async {
    let sync = FakeChatSynchronizer()
    await sync.enqueueSubagentList(.success([listEntry(id: "child-1", status: "running")]))
    // The cascade reached a child this gateway no longer holds a handle for, so
    // the route terminalized the row itself — a status the client could not
    // have guessed from the child's own events.
    await sync.enqueueStop(.success("interrupted"))
    await sync.enqueueSubagentList(.success([listEntry(id: "child-1", status: "interrupted")]))
    let feature = makeFeature(sync: sync)
    feature.setConnection(.online)
    await feature.appear()

    #expect(await feature.stopSubagent("child-1"))

    #expect(await sync.stopCalls == ["child-1"])
    #expect(feature.subagents.first?.status == "interrupted")
    #expect(feature.liveSubagentCount == 0)
    #expect(feature.subagentStopErrors["child-1"] == nil)
  }

  @Test("a stop that only raced the child's own finish reports nothing")
  func aStopThatRacedTheChildsFinishReportsNothing() async {
    let sync = FakeChatSynchronizer()
    await sync.enqueueSubagentList(.success([listEntry(id: "child-1", status: "running")]))
    await sync.enqueueStop(.failure(.validation("Sub-agent child-1 is already done")))
    await sync.enqueueSubagentList(.success([listEntry(id: "child-1", status: "done")]))
    let feature = makeFeature(sync: sync)
    feature.setConnection(.online)
    await feature.appear()

    // iOS cannot read the 409 web keys on — `HTTPTransport` maps every
    // `validation_failed` to `GatewayError.validation(String)` and drops the
    // status — so what the server says is true AFTER the re-read decides.
    #expect(await feature.stopSubagent("child-1"))
    #expect(feature.subagentStopErrors["child-1"] == nil)
    #expect(feature.subagents.first?.status == "done")
  }

  @Test("a stop that failed with the child still running surfaces the gateway's own text")
  func aFailedStopSurfacesTheGatewaysText() async {
    let sync = FakeChatSynchronizer()
    await sync.enqueueSubagentList(.success([listEntry(id: "child-1", status: "running")]))
    await sync.enqueueStop(.failure(.validation("This agent cannot be stopped from here")))
    await sync.enqueueSubagentList(.success([listEntry(id: "child-1", status: "running")]))
    let feature = makeFeature(sync: sync)
    feature.setConnection(.online)
    await feature.appear()

    #expect(await feature.stopSubagent("child-1") == false)
    #expect(feature.subagentStopErrors["child-1"] == "This agent cannot be stopped from here")
    #expect(feature.liveSubagentCount == 1)
    #expect(feature.stoppingSubagentIDs.isEmpty)
  }

  @Test(
    """
    a resume the gateway refuses reaches the tasks row, which is the only     surface a background child has
    """
  )
  func aRefusedResumeIsTheTasksRowsError() async throws {
    URLProtocolStub.reset()
    // A REAL 409 on the wire, not a synthesised `GatewayError`: the point of
    // the test is the whole path — the route's status is dropped by
    // `HTTPTransport`, the prose survives, `subagentFailureText` keeps it
    // verbatim, and it has to arrive somewhere a view reads. The text is
    // `coordinator.resumeChild`'s own refusal (`coordinator.ts:717`), which is
    // what a finished child whose grant cannot be rebuilt answers.
    let refusal = #"Agent "scout" cannot be resumed: its grant cannot be rebuilt."#
    let body = try JSONSerialization.data(
      withJSONObject: ["code": "validation_failed", "error": refusal, "retryable": false]
    )
    URLProtocolStub.enqueue(status: 409, data: body)
    let store = try PersistenceStore.inMemory()
    let api = makeChatGatewayAPI()
    let feature = ChatFeature(
      gatewayID: "gateway-1",
      conversation: summary(),
      persistence: LiveChatPersistence(store: store),
      synchronizer: LiveChatSynchronizer(gatewayID: "gateway-1", store: store, makeAPI: { api }),
      transport: FakeChatFeatureTransport(),
      clock: TestAppClock(now: Date(timeIntervalSince1970: 1_000)),
      announcer: FakeChatAccessibilityAnnouncer(),
      validator: ImageAttachmentValidator(),
      makeID: { "req-1" }
    )
    feature.setConnection(.online)

    #expect(await feature.sendToSubagent("child-1", text: "one more pass") == false)

    // Where it lands today — rendered by `SubagentCardView`, i.e. by the
    // transcript row, which a background child that finished after its
    // spawning turn does not have.
    #expect(feature.state.subagentUI["child-1"]?.lastError == refusal)
    // Where the sheet reads. Before this, `TasksRowView` rendered
    // `subagentStopErrors` alone and a refused resume was silent.
    #expect(feature.subagentRowError("child-1") == refusal)
  }

  @Test("the tasks row's error line belongs to the last action taken, not to the older one")
  func theRowErrorLineBelongsToTheLastActionTaken() async {
    let sync = FakeChatSynchronizer()
    await sync.enqueueSubagentList(.success([listEntry(id: "child-1", status: "running")]))
    await sync.enqueueStop(.failure(.validation("This agent cannot be stopped from here")))
    await sync.enqueueSubagentList(.success([listEntry(id: "child-1", status: "running")]))
    await sync.enqueueResume(.failure(GatewayError.validation(#"steer cap reached for "scout""#)))
    // Three ids, not two: the resume takes one for its `requestId`.
    let feature = makeFeature(sync: sync, ids: ["turn-1", "local-1", "req-1"])
    feature.setConnection(.online)
    await feature.appear()

    #expect(await feature.stopSubagent("child-1") == false)
    #expect(feature.subagentRowError("child-1") == "This agent cannot be stopped from here")

    // A resume attempted after it OWNS the line: leaving the stop's older
    // refusal up would read as though the sentence had been refused for a
    // reason that has nothing to do with it.
    #expect(await feature.sendToSubagent("child-1", text: "one more pass") == false)
    #expect(feature.subagentRowError("child-1") == #"steer cap reached for "scout""#)

    // And back the other way. `stopSubagent` clears its own slot on the
    // attempt, so without clearing the resume's the row would show the
    // resume refusal for the whole of the next stop and, if that stop
    // succeeded, forever after.
    await sync.enqueueStop(.success("cancelled"))
    await sync.enqueueSubagentList(.success([listEntry(id: "child-1", status: "cancelled")]))
    #expect(await feature.stopSubagent("child-1"))
    #expect(feature.subagentRowError("child-1") == nil)
  }

  @Test("a stop's local write moves the read cursor, so an older read cannot undo it")
  func aStopsLocalWriteCannotBeUndoneByAnOlderRead() async {
    let stale = TestGate()
    let afterStop = TestGate()
    let sync = FakeChatSynchronizer()
    await sync.enqueueSubagentList(.success([listEntry(id: "child-1", status: "running")]))
    // Issued BEFORE the stop and still in flight when it lands: a read this old
    // carries the pre-stop row.
    await sync.enqueueSubagentList(
      .success([listEntry(id: "child-1", status: "running")]),
      waitingOn: stale
    )
    await sync.enqueueStop(.success("cancelled"))
    await sync.enqueueSubagentList(
      .success([listEntry(id: "child-1", status: "cancelled")]),
      waitingOn: afterStop
    )
    let feature = makeFeature(sync: sync)
    feature.setConnection(.online)
    await feature.appear()

    let staleRead = Task { await feature.refreshSubagents() }
    await stale.waitUntilWaiting()

    let stop = Task { await feature.stopSubagent("child-1") }
    // The stop's own re-read has been ISSUED, which is how we know
    // `applyStopped` has already run.
    await afterStop.waitUntilWaiting()
    #expect(feature.subagents.first?.status == "cancelled")

    await stale.release()
    await staleRead.value

    // The whole point: `applyStopped` writes the list without any read having
    // written it, so it must move the cursor too, or a read issued before it
    // still satisfies `readSeq > appliedSubagentReadSeq` and restores the
    // pre-stop row — Stop offered again for one frame on a child that is gone.
    #expect(feature.subagents.first?.status == "cancelled")
    #expect(feature.liveSubagentCount == 0)

    await afterStop.release()
    #expect(await stop.value)
  }

  @Test("the server's status for a row is nil for a child the list does not carry")
  func theServersRowStatusIsNilForAChildTheListDoesNotCarry() async {
    let sync = FakeChatSynchronizer()
    await sync.enqueueSubagentList(.success([listEntry(id: "child-1", status: "done")]))
    let feature = makeFeature(sync: sync)
    feature.setConnection(.online)
    await feature.appear()

    #expect(feature.restSubagentStatus("child-1") == .done)
    // Not a direct child of the OPEN conversation, so the route never returned
    // it and the row keeps reading its own fold. Answering `.running` here
    // instead would be the merge D3 rejected, wearing a different hat.
    #expect(feature.restSubagentStatus("grandchild-1") == nil)
  }

  @Test(
    """
    a resume re-reads the list, so a row that reads the server stops showing     the status the child had before it was resumed
    """
  )
  func aResumeReReadsTheList() async {
    let sync = FakeChatSynchronizer()
    // §8.4's Resume on its headline target: a BACKGROUND child that finished
    // after its spawning turn, whose `done` the notification turn's read
    // already brought here — and which `SubagentTaskRow.canResume` offers
    // Resume on precisely because `coordinator.resumeChild` is built to
    // rebuild a finished child's grant.
    await sync.enqueueSubagentList(.success([listEntry(id: "child-1", status: "done")]))
    await sync.enqueueResume(.success(()))
    await sync.enqueueSubagentList(.success([listEntry(id: "child-1", status: "running")]))
    let feature = makeFeature(sync: sync, ids: ["turn-1", "local-1", "req-1"])
    feature.setConnection(.online)
    await feature.appear()
    #expect(await sync.subagentListCalls.count == 1)
    #expect(feature.restSubagentStatus("child-1") == .done)

    #expect(await feature.sendToSubagent("child-1", text: "one more pass"))

    // Nothing else can close this window. A resume outside a live parent turn
    // reaches `Coordinator.emitToParent` with no live turn to emit into
    // (`packages/swarm/src/coordinator.ts:1549-1554`), so not one of the
    // child's frames — started, progress or finished — arrives on this socket,
    // and no other trigger fires until the SECOND run's notification turn.
    #expect(await sync.subagentListCalls.count == 2)
    // The row, the sheet, the strip and the badge all read this.
    #expect(feature.restSubagentStatus("child-1") == .running)
    #expect(feature.liveSubagentCount == 1)
  }

  @Test(
    """
    a send is not reported done until its re-read lands, so the composer cannot     re-arm on a sentence the gateway has already accepted
    """
  )
  func aSendIsNotDoneUntilItsReReadLands() async {
    let gate = TestGate()
    let sync = FakeChatSynchronizer()
    await sync.enqueueSubagentList(.success([listEntry(id: "child-1", status: "done")]))
    await sync.enqueueResume(.success(()))
    await sync.enqueueSubagentList(
      .success([listEntry(id: "child-1", status: "running")]),
      waitingOn: gate
    )
    let feature = makeFeature(sync: sync, ids: ["turn-1", "local-1", "req-1"])
    feature.setConnection(.online)
    await feature.appear()

    let sending = Task { await feature.sendToSubagent("child-1", text: "one more pass") }
    await gate.waitUntilWaiting()

    // `SubagentComposer.canSend` is `isEnabled && isSending == false && text
    // non-empty`, and the field is emptied only when `onSend` returns `true`
    // (`SubagentViews.swift:667-687`). So clearing `isSending` before the
    // re-read would light the Send button back up with the user's sentence
    // still sitting in it, for the length of a GET, on a resume the gateway has
    // already accepted — one tap from a duplicate steer. `stopSubagent` holds
    // its own gate across its re-read for the same reason: its
    // `defer { stoppingSubagentIDs.remove(...) }` fires after the read.
    #expect(feature.state.subagentUI["child-1"]?.isSending == true)

    await gate.release()
    #expect(await sending.value)
    #expect(feature.state.subagentUI["child-1"]?.isSending == false)
    #expect(feature.restSubagentStatus("child-1") == .running)
  }

  @Test("revealing a child the transcript has no row for expands nothing and fetches nothing")
  func revealingAChildWithNoCardExpandsNothing() async {
    let sync = FakeChatSynchronizer()
    // In the list and nowhere else — the sheet's headline case, a background
    // child whose start event sits in no message this client has loaded.
    await sync.enqueueSubagentList(.success([listEntry(id: "ghost-1", status: "running")]))
    let feature = makeFeature(sync: sync)
    feature.setConnection(.online)
    await feature.appear()
    #expect(feature.subagents.map(\.id) == ["ghost-1"])

    feature.revealSubagent("ghost-1")
    await settle()

    // Expanding it anyway would fetch a transcript and hold a subscription
    // that no view renders — the leak class D2, D3 and D5 each paid for.
    #expect(feature.state.subagentUI["ghost-1"] == nil)
    #expect(await sync.subagentTranscriptCalls.isEmpty)
  }

  private func acceptedFrame(origin: MessageOrigin?) -> MobileWSServerFrame {
    .accepted(
      id: "turn-notify",
      conversationId: "conv-1",
      userMessageId: "user-notify",
      assistantMessageId: "assistant-notify",
      revision: 2,
      seq: 40,
      origin: origin,
      kind: nil,
      requestId: nil
    )
  }

  private func subagentStartedFrame() -> MobileWSServerFrame {
    .event(
      id: "turn-1",
      conversationId: "conv-1",
      seq: 41,
      event: .subagentStarted(
        subagentId: "child-9",
        name: nil,
        subagentType: "researcher",
        description: "Look around",
        prompt: "Look around",
        model: "openai/gpt-5",
        background: true,
        depth: 1,
        startedAt: Date(timeIntervalSince1970: 2_000),
        isolation: nil,
        parentTurnId: "turn-1"
      )
    )
  }

  private func subagentProgressFrame() -> MobileWSServerFrame {
    .event(
      id: "turn-1",
      conversationId: "conv-1",
      seq: 42,
      event: .subagentProgress(
        subagentId: "child-9",
        status: .running,
        toolCallCount: 2,
        elapsedMs: 100,
        detail: nil,
        question: nil
      )
    )
  }

  private func listEntry(
    id: String,
    status: String,
    depth: Int = 1,
    oneShot: Bool = false,
    endedAt: Date? = nil
  ) -> SubagentListEntryDTO {
    SubagentListEntryDTO(
      id: id,
      name: nil,
      type: "researcher",
      description: "Look around",
      status: status,
      background: true,
      depth: depth,
      startedAt: Date(timeIntervalSince1970: 1_000),
      endedAt: endedAt,
      usage: nil,
      toolCallCount: 2,
      report: nil,
      oneShot: oneShot
    )
  }

  @Test("scroll anchor is remembered across re-hosting and cleared on leave")
  func scrollAnchorLifecycle() async {
    let feature = makeFeature()
    feature.scrollAnchorMessageID = "msg-7"
    #expect(feature.scrollAnchorMessageID == "msg-7")
    await feature.disappear()
    #expect(feature.scrollAnchorMessageID == "msg-7", "re-hosting keeps the anchor")
    feature.clearScrollAnchor()
    #expect(feature.scrollAnchorMessageID == nil)
  }

  @Test(
    "the pinned-to-bottom intent lives on the feature, so it survives a re-host too (Task 4 review fix, Important 2)"
  )
  func scrollPinnedIntentLifecycle() async {
    let feature = makeFeature()
    #expect(feature.scrollWasPinnedToBottom, "a transcript nobody scrolled is pinned")

    feature.recordScrollPinnedToBottom(false)
    feature.scrollAnchorMessageID = "msg-7"
    await feature.disappear()
    #expect(
      feature.scrollWasPinnedToBottom == false,
      "re-hosting must not resurrect the pinned default — that is what ChatView's own @State does"
    )

    feature.clearScrollAnchor()
    #expect(feature.scrollWasPinnedToBottom, "genuinely leaving resets to the pinned default")
    #expect(feature.scrollAnchorMessageID == nil)
  }

  // MARK: - lastAssistantText / canCopyLastAssistantText (Task 5 review fix, Important 1 & 3)
  //
  // `⌘⇧C` writes `lastAssistantText` straight to `UIPasteboard.general.string`
  // with no guard, so if `canCopyLastAssistantText` (the predicate that
  // enables the menu item) and `lastAssistantText` (what the action writes)
  // ever disagree about what counts as "empty", the command is enabled and
  // silently wipes the user's system clipboard — and, via Handoff, their
  // Universal Clipboard. Before this fix that disagreement was reachable
  // with no race at all: the predicate tested the RAW markdown for
  // non-emptiness while the action flattened it through
  // `markdownPlainTextAccessibilityLabel`, which drops thematic breaks
  // entirely (`MarkdownBlocksTests.plainTextAccessibilityLabelDropsHorizontalRules`).
  // A reply that is only `"---"` is non-empty raw markdown but flattens to
  // `""`.

  @Test(
    "⌘⇧C's predicate agrees with what it would actually copy: a reply that is only a thematic break must not read as copyable (Task 5 review fix, Important 1)"
  )
  func copyLastResponsePredicateAgreesWithFlattenedEmptiness() async {
    let sync = FakeChatSynchronizer()
    await sync.enqueueRefresh(
      .success(
        snapshot(
          messages: [
            message(
              id: "assistant-1", role: .assistant, status: .completed,
              events: [.textDelta(text: "---")], ordinal: 1
            )
          ],
          throughSeq: 1
        )
      )
    )
    let feature = makeFeature(sync: sync)
    feature.setConnection(.online)
    await feature.appear()

    #expect(feature.state.messages.last?.assistant?.text == "---")
    #expect(
      feature.canCopyLastAssistantText == (feature.lastAssistantText?.isEmpty == false),
      """
      the predicate and the action disagreed about emptiness here before the \
      Important 1 fix (canCopy == true, lastAssistantText == ""), which is \
      exactly the shape of the clipboard-wiping bug
      """
    )
    #expect(feature.canCopyLastAssistantText == false)
    #expect(feature.lastAssistantText == "")
  }

  @Test("⌘⇧C stays enabled and copies the flattened text for a reply with real content")
  func copyLastResponsePredicateEnabledForRealText() async {
    let sync = FakeChatSynchronizer()
    await sync.enqueueRefresh(
      .success(
        snapshot(
          messages: [
            message(
              id: "assistant-1", role: .assistant, status: .completed,
              events: [.textDelta(text: "**Ship it**")], ordinal: 1
            )
          ],
          throughSeq: 1
        )
      )
    )
    let feature = makeFeature(sync: sync)
    feature.setConnection(.online)
    await feature.appear()

    #expect(feature.canCopyLastAssistantText)
    #expect(feature.lastAssistantText == "Ship it")
  }

  @Test("⌘⇧C stays disabled for a whitespace-only reply")
  func copyLastResponsePredicateDisabledForWhitespaceOnlyReply() async {
    let sync = FakeChatSynchronizer()
    await sync.enqueueRefresh(
      .success(
        snapshot(
          messages: [
            message(
              id: "assistant-1", role: .assistant, status: .completed,
              events: [.textDelta(text: "   \n  ")], ordinal: 1
            )
          ],
          throughSeq: 1
        )
      )
    )
    let feature = makeFeature(sync: sync)
    feature.setConnection(.online)
    await feature.appear()

    #expect(feature.canCopyLastAssistantText == false)
    #expect(feature.lastAssistantText == nil)
  }

  @Test("⌘⇧C stays disabled before any assistant message has produced text")
  func copyLastResponsePredicateDisabledWithNoAssistantMessage() async {
    let feature = makeFeature()
    feature.setConnection(.online)
    await feature.appear()

    #expect(feature.canCopyLastAssistantText == false)
    #expect(feature.lastAssistantText == nil)
  }

  // MARK: - ChatCommandActions identity Equatable (Task 5 review fix, Important 3)
  //
  // `ChatCommandActions` is `Equatable` on `feature`'s IDENTITY (`===`), not
  // its stored closures, and deliberately so: `focusedSceneValue` re-applies
  // — and thereby invalidates the scene's focus entry — every time the value
  // it publishes changes, and a struct that also compared closures would be
  // a fresh, uncomparable value on every `ChatView` body pass (closures
  // don't conform to `Equatable`, so that variant wouldn't even compile —
  // the realistic regression is someone reintroducing a comparable STORED
  // snapshot field, like `let canSend: Bool`, which DOES compile and quietly
  // reopens the composer-loses-focus bug). This test pins that two values
  // built over the same feature compare equal regardless of which closures
  // they carry.

  @Test("two ChatCommandActions over the same feature compare equal regardless of closures")
  func chatCommandActionsEqualOnFeatureIdentity() {
    let feature = makeFeature()
    let first = ChatCommandActions(feature: feature, focusComposer: {}, close: {})
    let second = ChatCommandActions(
      feature: feature,
      focusComposer: { Issue.record("should never run") },
      close: { Issue.record("should never run") }
    )
    #expect(first == second)

    let otherFeature = makeFeature()
    let third = ChatCommandActions(feature: otherFeature, focusComposer: {}, close: {})
    #expect(first != third, "a different feature identity must compare unequal")
  }

  private func makeFeature(
    conversation: ConversationSummaryDTO = summary(),
    persistence: FakeChatPersistence = FakeChatPersistence(),
    sync: FakeChatSynchronizer = FakeChatSynchronizer(),
    chat: FakeChatFeatureTransport = FakeChatFeatureTransport(),
    announcer: FakeChatAccessibilityAnnouncer = FakeChatAccessibilityAnnouncer(),
    recoveryChanges: any ConversationRecoveryChangeSignaling = ConversationRecoveryChangeSignal(),
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
      recoveryChanges: recoveryChanges,
      makeID: { source.next() }
    )
  }

  private func pendingRecovery(draft: String) -> RecoverablePendingSend {
    RecoverablePendingSend(
      gatewayID: "gateway-1",
      conversationID: "conv-1",
      conversationTitle: "Conversation",
      agentName: "Agent One",
      pendingSend: PendingChatSend(
        turnID: "turn-recovery",
        localUserID: "local-recovery",
        draft: draft,
        attachments: [],
        createdAt: Date(timeIntervalSince1970: 900)
      ),
      attachmentIssue: .unreadableStoredPayload
    )
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
private final class SequentialChatFactoryProbe {
  private var features: [ChatFeature]
  private(set) var callCount = 0

  init(features: [ChatFeature]) {
    self.features = features
  }

  func make(
    profile: ConnectionProfileSnapshot,
    conversation: ConversationSummaryDTO
  ) -> ChatFeature? {
    _ = profile
    _ = conversation
    callCount += 1
    guard features.isEmpty == false else { return nil }
    return features.removeFirst()
  }
}

@MainActor
private final class GatedChatFactoryProbe {
  private let gate: TestGate
  private var features: [ChatFeature]
  private(set) var callCount = 0

  init(gate: TestGate, features: [ChatFeature]) {
    self.gate = gate
    self.features = features
  }

  func make(
    profile: ConnectionProfileSnapshot,
    conversation: ConversationSummaryDTO
  ) async -> ChatFeature? {
    _ = profile
    _ = conversation
    callCount += 1
    if callCount == 1 {
      await gate.wait()
    }
    guard features.isEmpty == false else { return nil }
    return features.removeFirst()
  }
}

private actor AsyncCompletionProbe {
  private(set) var isComplete = false

  func markComplete() {
    isComplete = true
  }
}

private actor GatedChatRecoveryChangeSignal: ConversationRecoveryChangeSignaling {
  private let gate: TestGate
  private let backing = ConversationRecoveryChangeSignal()

  init(gate: TestGate) {
    self.gate = gate
  }

  func subscription(gatewayID: String) async -> ConversationRecoveryChangeSubscription {
    await gate.wait()
    return await backing.subscription(gatewayID: gatewayID)
  }

  func send(gatewayID: String) async {
    await backing.send(gatewayID: gatewayID)
  }

  func subscriberCount() async -> Int {
    await backing.subscriberCount
  }
}

private actor DeliveryTrackedChatRecoveryChangeSignal: ConversationRecoveryChangeSignaling {
  private var subscribedGatewayID: String?
  private var queuedGatewayIDs: [String] = []
  private var nextWaiters: [CheckedContinuation<String?, Never>] = []
  private(set) var nextRequestCount = 0
  private var isFinished = false

  func subscription(gatewayID: String) async -> ConversationRecoveryChangeSubscription {
    subscribedGatewayID = gatewayID
    let changes = AsyncStream<String>(unfolding: { [weak self] in
      await self?.nextGatewayID()
    })
    return ConversationRecoveryChangeSubscription(
      changes: changes,
      cancelAction: { [weak self] in await self?.finish() }
    )
  }

  func send(gatewayID: String) async {
    guard isFinished == false else { return }
    guard gatewayID == subscribedGatewayID else { return }
    guard nextWaiters.isEmpty == false else {
      queuedGatewayIDs.append(gatewayID)
      return
    }
    nextWaiters.removeFirst().resume(returning: gatewayID)
  }

  private func nextGatewayID() async -> String? {
    nextRequestCount += 1
    guard isFinished == false else { return nil }
    guard queuedGatewayIDs.isEmpty else { return queuedGatewayIDs.removeFirst() }
    return await withCheckedContinuation { continuation in
      nextWaiters.append(continuation)
    }
  }

  func finish() {
    isFinished = true
    queuedGatewayIDs.removeAll()
    let waiters = nextWaiters
    nextWaiters.removeAll()
    for waiter in waiters {
      waiter.resume(returning: nil)
    }
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
  private(set) var bootstrapCallCount = 0
  private(set) var backgroundCallCount = 0

  func snapshots() -> AsyncStream<SyncSnapshot> {
    AsyncStream { continuation in continuation.finish() }
  }

  func bootstrap() async {
    bootstrapCallCount += 1
  }
  func sceneDidEnterBackground() async {
    backgroundCallCount += 1
  }
  func sceneWillEnterForeground() async {}
  func shutdown() async {}
}

private enum LifecycleConversationListResult<Value: Sendable>: Sendable {
  case success(Value)
  case failure(GatewayError)

  func get() throws -> Value {
    switch self {
    case .success(let value): return value
    case .failure(let error): throw error
    }
  }
}

private actor LifecycleConversationListService: ConversationListServicing {
  private var pages: [ConversationPageDTO] = []
  private var conversationResults: [LifecycleConversationListResult<ConversationSummaryDTO>] = []
  private var deleteResults: [LifecycleConversationListResult<ConversationSummaryDTO>] = []
  private var renameResults: [LifecycleConversationListResult<ConversationSummaryDTO>] = []

  func enqueuePage(_ page: ConversationPageDTO) {
    pages.append(page)
  }

  func enqueueConversation(
    _ result: LifecycleConversationListResult<ConversationSummaryDTO>
  ) {
    conversationResults.append(result)
  }

  func enqueueDelete(
    _ result: LifecycleConversationListResult<ConversationSummaryDTO>
  ) {
    deleteResults.append(result)
  }

  func enqueueRename(
    _ result: LifecycleConversationListResult<ConversationSummaryDTO>
  ) {
    renameResults.append(result)
  }

  func cachedConversations() -> [CachedConversation] { [] }
  func cachedAgents() -> [RegisteredAgentDTO] { [] }
  func refreshAgents() -> [RegisteredAgentDTO] { [] }

  func conversations(
    agentID: String?,
    limit: Int,
    cursor: String?
  ) -> ConversationPageDTO {
    _ = agentID
    _ = limit
    _ = cursor
    guard pages.isEmpty == false else {
      return ConversationPageDTO(items: [], nextCursor: nil)
    }
    return pages.removeFirst()
  }

  func conversation(id: String) throws -> ConversationSummaryDTO {
    _ = id
    guard conversationResults.isEmpty == false else { throw GatewayError.updateRequired }
    return try conversationResults.removeFirst().get()
  }

  func create(_ request: CreateConversationRequest) throws -> ConversationSummaryDTO {
    _ = request
    throw GatewayError.updateRequired
  }

  func reconcileCreate(_ request: CreateConversationRequest) throws -> ConversationSummaryDTO {
    _ = request
    throw GatewayError.updateRequired
  }

  func rename(id: String, title: String, revision: Int) throws -> ConversationSummaryDTO {
    _ = id
    _ = title
    _ = revision
    guard renameResults.isEmpty == false else { throw GatewayError.updateRequired }
    return try renameResults.removeFirst().get()
  }

  func delete(id: String, revision: Int) throws -> ConversationSummaryDTO {
    _ = id
    _ = revision
    guard deleteResults.isEmpty == false else { throw GatewayError.updateRequired }
    return try deleteResults.removeFirst().get()
  }

  func replace(_ summary: ConversationSummaryDTO) -> ConversationSummaryDTO { summary }
  func remove(
    id: String,
    expectedCanonical: ConversationSummaryDTO
  ) -> ConversationRemovalOutcome {
    _ = id
    _ = expectedCanonical
    return .removed
  }

  func retainedCreateRequestID(agentID: String, suggested: String) -> String {
    _ = agentID
    return suggested
  }

  func clearRetainedCreateRequestID(agentID: String) { _ = agentID }
  func shutdown() {}
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
  private let failingClearCalls: Set<Int>
  private let failingAdvanceCalls: Set<Int>
  private let failingMessageLoad: Bool
  private let failingDraftLoad: Bool
  private let failingCursorLoad: Bool
  private let saveGates: [Int: TestGate]
  private let advanceGate: TestGate?
  private let draftLoadGate: TestGate?
  private let pendingLoadGate: TestGate?
  private let stageCollisionRecovery: RecoverablePendingSend?
  private var cachedMessages: [ConversationMessageDTO]
  private var cachedDraft: ConversationDraft?
  private var cachedPendingSendLoadResult: PendingSendLoadResult
  private(set) var saveCallCount = 0
  private(set) var stageCallCount = 0
  private(set) var pendingLoadCallCount = 0
  private var clearCallCount = 0
  private var advanceCallCount = 0
  private var conversationAvailable = true
  private(set) var cursor: Int
  private(set) var savedDrafts: [ConversationDraft] = []

  var persistedDraft: ConversationDraft? { cachedDraft }
  var persistedPendingSend: PendingChatSend? {
    switch cachedPendingSendLoadResult {
    case .none:
      nil
    case .resumable(let pending):
      pending
    case .recoveryRequired(let recovery):
      recovery.pendingSend
    }
  }

  func markConversationUnavailable() {
    conversationAvailable = false
  }

  init(
    messages: [ConversationMessageDTO] = [],
    draft: ConversationDraft? = nil,
    pendingSend: PendingChatSend? = nil,
    pendingSendLoadResult: PendingSendLoadResult? = nil,
    cursor: Int = 0,
    failingSaveCalls: Set<Int> = [],
    failingClearCalls: Set<Int> = [],
    failingAdvanceCalls: Set<Int> = [],
    failingMessageLoad: Bool = false,
    failingDraftLoad: Bool = false,
    failingCursorLoad: Bool = false,
    saveGates: [Int: TestGate] = [:],
    advanceGate: TestGate? = nil,
    draftLoadGate: TestGate? = nil,
    pendingLoadGate: TestGate? = nil,
    stageCollisionRecovery: RecoverablePendingSend? = nil,
    recorder: ChatOperationRecorder? = nil
  ) {
    cachedMessages = messages
    cachedDraft = draft
    cachedPendingSendLoadResult =
      pendingSendLoadResult ?? pendingSend.map(PendingSendLoadResult.resumable) ?? .none
    self.cursor = cursor
    self.failingSaveCalls = failingSaveCalls
    self.failingClearCalls = failingClearCalls
    self.failingAdvanceCalls = failingAdvanceCalls
    self.failingMessageLoad = failingMessageLoad
    self.failingDraftLoad = failingDraftLoad
    self.failingCursorLoad = failingCursorLoad
    self.saveGates = saveGates
    self.advanceGate = advanceGate
    self.draftLoadGate = draftLoadGate
    self.pendingLoadGate = pendingLoadGate
    self.stageCollisionRecovery = stageCollisionRecovery
    self.recorder = recorder
  }

  func setPendingSendLoadResult(_ result: PendingSendLoadResult) {
    cachedPendingSendLoadResult = result
  }

  func setDraft(_ draft: ConversationDraft?) {
    cachedDraft = draft
  }

  func messages(gatewayID: String, conversationID: String) async throws
    -> [ConversationMessageDTO]
  {
    guard failingMessageLoad == false else { throw FakeChatPersistenceError.unavailable }
    return cachedMessages
  }

  func draft(gatewayID: String, conversationID: String) async throws -> ConversationDraft? {
    if let draftLoadGate { await draftLoadGate.wait() }
    guard failingDraftLoad == false else { throw FakeChatPersistenceError.unavailable }
    return cachedDraft
  }

  func pendingSend(
    gatewayID: String,
    conversationID: String
  ) async throws -> PendingSendLoadResult {
    pendingLoadCallCount += 1
    if let pendingLoadGate { await pendingLoadGate.wait() }
    return cachedPendingSendLoadResult
  }

  func cursor(gatewayID: String, conversationID: String) async throws -> Int {
    guard failingCursorLoad == false else { throw FakeChatPersistenceError.unavailable }
    return cursor
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
  ) async throws -> PendingSendStageResult {
    stageCallCount += 1
    saveCallCount += 1
    if let gate = saveGates[saveCallCount] { await gate.wait() }
    guard failingSaveCalls.contains(saveCallCount) == false else {
      throw FakeChatPersistenceError.unavailable
    }
    if let stageCollisionRecovery {
      cachedPendingSendLoadResult = .recoveryRequired(stageCollisionRecovery)
      return .pendingAlreadyExists
    }
    guard case .none = cachedPendingSendLoadResult else { return .pendingAlreadyExists }
    cachedPendingSendLoadResult = .resumable(pending)
    cachedDraft = nil
    await recorder?.record("persist.pending.stage")
    return .staged
  }

  func clearPendingSend(
    gatewayID: String,
    conversationID: String,
    turnID: String
  ) async throws -> PendingSendClearResult {
    clearCallCount += 1
    guard failingClearCalls.contains(clearCallCount) == false else {
      throw FakeChatPersistenceError.unavailable
    }
    guard conversationAvailable else { return .conversationUnavailable }
    guard persistedPendingSend?.turnID == turnID else { return .cleared }
    cachedPendingSendLoadResult = .none
    await recorder?.record("persist.pending.clear")
    return .cleared
  }

  func pendingSendAvailability(
    gatewayID: String,
    conversationID: String,
    turnID: String
  ) -> PendingSendAvailability {
    _ = gatewayID
    _ = conversationID
    guard persistedPendingSend?.turnID == turnID else { return .pendingMissing }
    return conversationAvailable ? .active : .conversationUnavailable
  }

  func restorePendingSendAsDraft(
    gatewayID: String,
    conversationID: String,
    turnID: String
  ) async throws -> PendingSendRestoreResult {
    guard conversationAvailable else { return .conversationUnavailable }
    guard let pending = persistedPendingSend, pending.turnID == turnID else {
      return .restored(nil)
    }
    if let cachedDraft {
      return .draftConflict(cachedDraft)
    }
    let draft = ConversationDraft(
      text: pending.draft,
      attachments: pending.attachments,
      updatedAt: pending.createdAt
    )
    cachedDraft = draft
    cachedPendingSendLoadResult = .none
    savedDrafts.append(draft)
    await recorder?.record("persist.pending.restore")
    return .restored(draft)
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

struct SubagentResumeCall: Equatable, Sendable {
  let id: String
  let message: String
  let requestID: String
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
  private var subagentTranscriptResults: [FakeChatResult<SubagentTranscriptSnapshot>] = []
  private var subagentTranscriptGates: [TestGate?] = []
  private var resumeResults: [FakeChatResult<Void>] = []
  private var resumeGates: [TestGate?] = []
  private(set) var subagentTranscriptCalls: [String] = []
  private(set) var resumeCalls: [SubagentResumeCall] = []
  private var subagentListResults: [FakeChatResult<[SubagentListEntryDTO]>] = []
  private var subagentListGates: [TestGate?] = []
  private var stopResults: [FakeChatResult<String>] = []
  private(set) var subagentListCalls: [String] = []
  private(set) var stopCalls: [String] = []

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

  func enqueueSubagentTranscript(
    _ result: FakeChatResult<SubagentTranscriptSnapshot>,
    waitingOn gate: TestGate? = nil
  ) {
    subagentTranscriptResults.append(result)
    subagentTranscriptGates.append(gate)
  }

  func enqueueResume(_ result: FakeChatResult<Void>, waitingOn gate: TestGate? = nil) {
    resumeResults.append(result)
    resumeGates.append(gate)
  }

  func subagentTranscript(childID: String) async throws -> SubagentTranscriptSnapshot {
    subagentTranscriptCalls.append(childID)
    guard subagentTranscriptResults.isEmpty == false else {
      return SubagentTranscriptSnapshot(messages: [], oneShot: nil)
    }
    if let gate = subagentTranscriptGates.removeFirst() { await gate.wait() }
    return try resolve(subagentTranscriptResults.removeFirst())
  }

  func enqueueSubagentList(
    _ result: FakeChatResult<[SubagentListEntryDTO]>,
    waitingOn gate: TestGate? = nil
  ) {
    subagentListResults.append(result)
    subagentListGates.append(gate)
  }

  func enqueueStop(_ result: FakeChatResult<String>) {
    stopResults.append(result)
  }

  func subagents(conversationID: String) async throws -> [SubagentListEntryDTO] {
    subagentListCalls.append(conversationID)
    guard subagentListResults.isEmpty == false else { return [] }
    // BOTH popped before the first `await`, so two concurrent reads take the
    // first and second queued answers in call order however their gates are
    // released. Popping the result after the gate would make an out-of-order
    // test's own fixture out of order.
    let result = subagentListResults.removeFirst()
    let gate = subagentListGates.removeFirst()
    if let gate { await gate.wait() }
    return try resolve(result)
  }

  func stopSubagent(id: String) async throws -> String {
    stopCalls.append(id)
    guard stopResults.isEmpty == false else { return "cancelled" }
    return try resolve(stopResults.removeFirst())
  }

  func resumeSubagent(id: String, message: String, requestID: String) async throws {
    resumeCalls.append(SubagentResumeCall(id: id, message: message, requestID: requestID))
    guard resumeResults.isEmpty == false else { return }
    if let gate = resumeGates.removeFirst() { await gate.wait() }
    _ = try resolve(resumeResults.removeFirst())
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

  /// Turn traffic only. `connect`/`subscribe`/`unsubscribe` are lifecycle
  /// bookkeeping that `appear()` now performs unconditionally on an online
  /// conversation (task C7, sub-agents design 7.6) — a test asserting "this
  /// guard sent nothing" means no TURN was sent.
  var subscribeCount: Int {
    calls.filter { if case .subscribe = $0 { true } else { false } }.count
  }

  var turnCalls: [FakeChatTransportCall] {
    calls.filter {
      switch $0 {
      case .connect, .subscribe, .unsubscribe: false
      default: true
      }
    }
  }

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

  func subscribe(agentID: String, conversationID: String) async throws {
    calls.append(.subscribe(agentID: agentID, conversationID: conversationID))
  }

  func unsubscribe(agentID: String, conversationID: String) async throws {
    calls.append(.unsubscribe(agentID: agentID, conversationID: conversationID))
  }

  func suspendForDetachment() async {
    calls.append(.suspendForDetachment)
    // What `ChatConnection.suspend()` really does (`ChatConnection.swift:249-257`):
    // cancel the socket, `clearAllTurns()`, then `transition(to: .idle)`. Yielding
    // that `.idle` matters because the feature-side clear of
    // `subscribedSubagentIDs` lives in `consume(.state)`, not in
    // `suspendForDetachment` — without this the lifecycle tests only ever
    // reached `ensureConnected`'s clear and the production path was unexercised.
    // `.idle` and not `.detached`: `.detached` is what the FEATURE reduces into
    // `state.transport`, and what the UI-test fake yields.
    continuation.yield(.state(.idle))
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
  case subscribe(agentID: String, conversationID: String)
  case unsubscribe(agentID: String, conversationID: String)
  case suspendForDetachment
  case resetAfterTerminalFailure
  case shutdown

  var sentPayload: (text: String, images: [MessageImage])? {
    guard case .send(_, _, _, let text, let images) = self else { return nil }
    return (text, images)
  }

  var resumePayload: (turnID: String, sinceSeq: Int)? {
    guard case .resume(let turnID, _, _, let sinceSeq) = self else { return nil }
    return (turnID, sinceSeq)
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
  ordinal: Int,
  origin: String? = nil
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
    updatedAt: Date(timeIntervalSince1970: TimeInterval(ordinal)),
    origin: origin
  )
}

private func accepted(seq: Int) -> MobileWSServerFrame {
  .accepted(
    id: "turn-1",
    conversationId: "conv-1",
    userMessageId: "user-1",
    assistantMessageId: "assistant-1",
    revision: 2,
    seq: seq,
    origin: nil,
    kind: nil,
    requestId: nil
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

@MainActor
private func featureIsShutdown(_ feature: ChatFeature) -> Bool {
  feature.isShutdown
}

@MainActor
private func featureDraftText(_ feature: ChatFeature) -> String {
  feature.state.draft
}

/// One-shot flag for a `withObservationTracking` probe. A class because
/// `onChange` is `@Sendable` and runs wherever the write happens, so a captured
/// `var` would not compile under strict concurrency.
private final class InvalidationFlag: @unchecked Sendable {
  private let lock = NSLock()
  private var value = false

  func fire() { lock.withLock { value = true } }
  var didFire: Bool { lock.withLock { value } }
}

/// Give any work a frame WOULD have started time to run, for the negative half
/// of a trigger test. The fake synchronizer resolves without IO, so a read that
/// was going to happen has happened long before this returns.
private func settle() async {
  for _ in 0..<500 { await Task.yield() }
}

private func eventually(
  _ predicate: @escaping @Sendable () async -> Bool
) async {
  for _ in 0..<2_000 {
    if await predicate() { return }
    try? await Task.sleep(for: .milliseconds(1))
  }
  Issue.record("Condition did not become true")
}

/// Composer draft-status chip (user report 2026-09-04: "Saving draft"
/// flickered on every keystroke — the debounced autosave flips
/// `.saving`/`.saved` per key). Nothing about a save in flight is
/// actionable, so it joins `.saved` in staying silent; only a FAILED save
/// still says anything. Pure so it's unit-testable without SwiftUI.
@Suite("ComposerDraftStatusPresentation")
struct ComposerDraftStatusPresentationTests {
  @Test("saving is silent — no chip to flicker while typing")
  func savingIsSilent() {
    #expect(ComposerDraftStatusPresentation.label(for: .saving) == nil)
  }

  @Test("saved stays silent")
  func savedIsSilent() {
    #expect(ComposerDraftStatusPresentation.label(for: .saved) == nil)
  }

  @Test("a failed save is the only state that shows a chip")
  func failedShows() {
    let label = ComposerDraftStatusPresentation.label(for: .failed)
    #expect(label?.text == "Draft couldn't be saved")
    #expect(label?.systemImage == "exclamationmark.circle")
  }
}
