import Foundation
import Testing

@testable import Dash

@Suite("Chat feature")
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
    let clearedDraft = try #require(operations.lastIndex(of: "persist.draft.clear"))
    let connect = try #require(operations.lastIndex(of: "chat.connect"))
    let send = try #require(operations.lastIndex(of: "chat.send"))
    #expect(clearedDraft < connect)
    #expect(connect < send)
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
    #expect(await persistence.savedDrafts.last?.attachments.isEmpty == true)
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
    await feature.retryConnection()

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

  @Test("cancel sends once and stays active until durable cancelled done")
  func cancelWaitsForDone() async {
    let chat = FakeChatFeatureTransport()
    let feature = makeFeature(chat: chat)
    feature.setConnection(.online)
    await feature.appear()
    await feature.updateDraft("Hello")
    await feature.send()
    await chat.yield(.frame(accepted(seq: 1)))
    await eventually { await feature.state.activeTurnID == "turn-1" }

    await feature.cancel()
    await feature.cancel()

    #expect(await chat.calls.filter(\.isCancel).count == 1)
    #expect(feature.state.activeTurnID == "turn-1")
    #expect(feature.isCancelling)

    await chat.yield(
      .frame(.done(id: "turn-1", conversationId: "conv-1", seq: 2, outcome: .cancelled))
    )
    await eventually { await feature.state.activeTurnID == nil }

    #expect(feature.state.messages.last?.status == .cancelled)
    #expect(feature.isCancelling == false)
    await feature.cancel()
    #expect(await chat.calls.filter(\.isCancel).count == 1)
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
    await eventually { await feature.state.activeTurnID == "turn-1" }
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

    #expect(await chat.calls.filter { $0 == .suspendForDetachment }.count == 1)
    #expect(await chat.calls.filter { $0 == .connect }.count == 2)
    #expect(await chat.calls.filter(\.isResume).count == 2)
    #expect(feature.isShutdown == false)
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

  private func makeFeature(
    persistence: FakeChatPersistence = FakeChatPersistence(),
    sync: FakeChatSynchronizer = FakeChatSynchronizer(),
    chat: FakeChatFeatureTransport = FakeChatFeatureTransport(),
    announcer: FakeChatAccessibilityAnnouncer = FakeChatAccessibilityAnnouncer(),
    ids: [String] = ["turn-1", "local-1"]
  ) -> ChatFeature {
    let source = SequentialUUIDSource(ids: ids)
    return ChatFeature(
      gatewayID: "gateway-1",
      conversation: summary(),
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

private actor FakeChatPersistence: ChatFeaturePersisting {
  private let recorder: ChatOperationRecorder?
  private var cachedMessages: [ConversationMessageDTO]
  private var cachedDraft: ConversationDraft?
  private(set) var cursor: Int
  private(set) var savedDrafts: [ConversationDraft] = []

  init(
    messages: [ConversationMessageDTO] = [],
    draft: ConversationDraft? = nil,
    cursor: Int = 0,
    recorder: ChatOperationRecorder? = nil
  ) {
    cachedMessages = messages
    cachedDraft = draft
    self.cursor = cursor
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

  func cursor(gatewayID: String, conversationID: String) async throws -> Int {
    cursor
  }

  func saveDraft(
    _ draft: ConversationDraft,
    gatewayID: String,
    conversationID: String
  ) async throws {
    cachedDraft = draft
    savedDrafts.append(draft)
    await recorder?.record(
      draft.text.isEmpty && draft.attachments.isEmpty
        ? "persist.draft.clear" : "persist.draft"
    )
  }

  func advanceCursor(gatewayID: String, conversationID: String, to seq: Int) async throws {
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
  private let stream: AsyncThrowingStream<ChatConnectionEvent, Error>
  private let continuation: AsyncThrowingStream<ChatConnectionEvent, Error>.Continuation
  private var answerResults: [FakeChatResult<Void>] = []
  private(set) var calls: [FakeChatTransportCall] = []

  init(recorder: ChatOperationRecorder? = nil) {
    self.recorder = recorder
    let pair = AsyncThrowingStream<ChatConnectionEvent, Error>.makeStream()
    stream = pair.stream
    continuation = pair.continuation
  }

  func events() async -> AsyncThrowingStream<ChatConnectionEvent, Error> {
    stream
  }

  func enqueueAnswer(_ result: FakeChatResult<Void>) {
    answerResults.append(result)
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
    guard answerResults.isEmpty == false else { return }
    _ = try resolve(answerResults.removeFirst())
  }

  func cancel(turnID: String) async throws {
    calls.append(.cancel(turnID: turnID))
  }

  func suspendForDetachment() async {
    calls.append(.suspendForDetachment)
  }

  func shutdown() async {
    calls.append(.shutdown)
  }

  func yield(_ event: ChatConnectionEvent) {
    continuation.yield(event)
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
  case shutdown

  var sentPayload: (text: String, images: [MessageImage])? {
    guard case .send(_, _, _, let text, let images) = self else { return nil }
    return (text, images)
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
  revision: Int = 1,
  status: ConversationStatus = .idle,
  activeTurnID: String? = nil,
  lastSeq: Int = 0
) -> ConversationSummaryDTO {
  ConversationSummaryDTO(
    id: "conv-1",
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

private func eventually(
  _ predicate: @escaping @Sendable () async -> Bool
) async {
  for _ in 0..<200 {
    if await predicate() { return }
    await Task.yield()
  }
  Issue.record("Condition did not become true")
}
