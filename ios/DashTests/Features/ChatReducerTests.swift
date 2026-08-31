import Foundation
import Testing

@testable import Dash

@Suite("Chat reducer")
struct ChatReducerTests {
  @Test("accepted replaces optimistic ids without duplicating the user message")
  func acceptedReconcilesIdentity() {
    var state = chatState()

    _ = ChatReducer.reduce(
      state: &state,
      action: .sendStarted(turnID: "turn-1", localUserID: "local-u", text: "Hello", images: [])
    )
    let effects = ChatReducer.reduce(
      state: &state,
      action: .frame(
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

    #expect(state.messages.map(\.id) == ["user-1", "assistant-1"])
    #expect(state.messages.filter { $0.role == .user }.count == 1)
    #expect(state.messages.last?.status == .streaming)
    #expect(state.activeTurnID == "turn-1")
    #expect(state.lastAppliedSeq == 1)
    #expect(effects == [.persistCursor(1)])
  }

  @Test("canonical cached messages replace optimistic identities without duplicates")
  func canonicalCacheReconcilesOptimisticMessages() {
    var state = chatState()
    _ = ChatReducer.reduce(
      state: &state,
      action: .sendStarted(turnID: "turn-1", localUserID: "local-u", text: "Hello", images: [])
    )

    _ = ChatReducer.reduce(
      state: &state,
      action: .cachedMessagesLoaded(
        [
          message(
            id: "user-1",
            turnID: "turn-1",
            ordinal: 1,
            role: .user,
            status: .completed,
            content: .user(text: "Hello", images: nil)
          ),
          message(
            id: "assistant-1",
            turnID: "turn-1",
            ordinal: 2,
            role: .assistant,
            status: .completed,
            content: .assistant(events: [.textDelta(text: "Hi")])
          ),
        ],
        cursor: 4
      )
    )

    #expect(state.messages.map(\.id) == ["user-1", "assistant-1"])
    #expect(state.messages.last?.assistant?.text == "Hi")
    #expect(state.lastAppliedSeq == 4)
  }

  @Test("accepted removes an optimistic duplicate when the canonical user already exists")
  func acceptedRemovesExistingOptimisticDuplicate() {
    var state = chatState()
    _ = ChatReducer.reduce(
      state: &state,
      action: .sendStarted(turnID: "turn-1", localUserID: "local-u", text: "Hello", images: [])
    )
    _ = ChatReducer.reduce(
      state: &state,
      action: .olderMessagesLoaded(
        [
          message(
            id: "user-1",
            turnID: "turn-1",
            ordinal: 1,
            role: .user,
            status: .completed,
            content: .user(text: "Hello", images: nil)
          )
        ],
        nextCursor: nil
      )
    )

    _ = ChatReducer.reduce(
      state: &state,
      action: .frame(
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

    #expect(state.messages.filter { $0.turnID == "turn-1" && $0.role == .user }.count == 1)
    #expect(state.messages.first?.id == "user-1")
  }

  @Test("duplicate sequence is a no-op")
  func duplicateSequence() {
    var state = chatState(cursor: 4)
    let before = state

    let effects = ChatReducer.reduce(
      state: &state,
      action: .frame(eventFrame(seq: 4, event: .textDelta(text: "dup")))
    )

    #expect(state == before)
    #expect(effects.isEmpty)
  }

  @Test("live frames for another conversation are ignored before sequencing")
  func ignoresLiveFrameForAnotherConversation() {
    var state = acceptedState(cursor: 1)
    let before = state

    let effects = ChatReducer.reduce(
      state: &state,
      action: .frame(
        .event(
          id: "other-turn",
          conversationId: "conv-2",
          seq: 2,
          event: .textDelta(text: "wrong conversation")
        )
      )
    )

    #expect(state == before)
    #expect(effects.isEmpty)
  }

  @Test("replay entries for another conversation are ignored before sequencing")
  func ignoresReplayEntryForAnotherConversation() {
    var state = acceptedState(cursor: 1)
    let before = state
    let replay = ReplayEntryDTO(
      seq: 2,
      msgId: "other-turn",
      agentId: "agent-1",
      conversationId: "conv-2",
      timestamp: Date(timeIntervalSince1970: 2),
      payload: .event(event: .textDelta(text: "wrong conversation"))
    )

    let effects = ChatReducer.reduce(state: &state, action: .replayLoaded([replay]))

    #expect(state == before)
    #expect(effects.isEmpty)
  }

  @Test("foreign-only replay cannot consume a pending current frame")
  func foreignReplayDoesNotConsumePendingFrame() {
    var state = acceptedState(cursor: 1)
    state.pendingGapFrame = eventFrame(seq: 2, event: .textDelta(text: "pending"))
    let before = state
    let replay = ReplayEntryDTO(
      seq: 2,
      msgId: "other-turn",
      agentId: "agent-1",
      conversationId: "conv-2",
      timestamp: Date(timeIntervalSince1970: 2),
      payload: .event(event: .textDelta(text: "wrong conversation"))
    )

    let effects = ChatReducer.reduce(state: &state, action: .replayLoaded([replay]))

    #expect(state == before)
    #expect(effects.isEmpty)
  }

  @Test("empty replay consumes a pending frame made contiguous by a live arrival")
  func emptyReplayConsumesNowContiguousPendingFrame() {
    var state = chatState()
    _ = ChatReducer.reduce(
      state: &state,
      action: .frame(eventFrame(seq: 2, event: .textDelta(text: "B")))
    )
    let firstEffects = ChatReducer.reduce(
      state: &state,
      action: .frame(eventFrame(seq: 1, event: .textDelta(text: "A")))
    )

    #expect(firstEffects == [.persistCursor(1)])
    #expect(state.lastAppliedSeq == 1)
    #expect(state.pendingGapFrame == eventFrame(seq: 2, event: .textDelta(text: "B")))

    let replayEffects = ChatReducer.reduce(state: &state, action: .replayLoaded([]))

    #expect(state.messages.last?.assistant?.text == "AB")
    #expect(state.lastAppliedSeq == 2)
    #expect(state.pendingGapFrame == nil)
    #expect(replayEffects == [.persistCursor(2)])
  }

  @Test("unscoped admission errors from unknown turns are ignored")
  func ignoresUnscopedAdmissionErrorForUnknownTurn() {
    var state = acceptedState(cursor: 1)
    let before = state

    let effects = ChatReducer.reduce(
      state: &state,
      action: .frame(
        .error(
          id: "other-local-turn",
          conversationId: nil,
          seq: nil,
          error: "Conversation is busy",
          code: "conversation_busy",
          retryable: false,
          activeTurnId: "other-remote-turn"
        )
      )
    )

    #expect(state == before)
    #expect(effects.isEmpty)
  }

  @Test("a sequence gap requests replay without applying the pending frame")
  func gapRequestsReplay() {
    var state = acceptedState(cursor: 1)

    let effects = ChatReducer.reduce(
      state: &state,
      action: .frame(eventFrame(seq: 3, event: .textDelta(text: "later")))
    )

    #expect(state.lastAppliedSeq == 1)
    #expect(state.messages.last?.assistant?.text.isEmpty == true)
    #expect(state.pendingGapFrame == eventFrame(seq: 3, event: .textDelta(text: "later")))
    #expect(effects == [.requestReplay(sinceSeq: 1)])
  }

  @Test("replay applies in sequence and then consumes the pending frame")
  func replayThenPendingFrame() {
    var state = acceptedState(cursor: 1)
    _ = ChatReducer.reduce(
      state: &state,
      action: .frame(eventFrame(seq: 3, event: .textDelta(text: "B")))
    )
    let replay = ReplayEntryDTO(
      seq: 2,
      msgId: "turn-1",
      agentId: "agent-1",
      conversationId: "conv-1",
      timestamp: Date(timeIntervalSince1970: 2),
      payload: .event(event: .textDelta(text: "A"))
    )

    let effects = ChatReducer.reduce(state: &state, action: .replayLoaded([replay]))

    #expect(state.messages.last?.assistant?.text == "AB")
    #expect(state.lastAppliedSeq == 3)
    #expect(state.pendingGapFrame == nil)
    #expect(effects == [.persistCursor(2), .persistCursor(3)])
  }

  @Test("replay interleaves a now-contiguous pending frame before later replay entries")
  func replayInterleavesPendingFrame() {
    var state = acceptedState(cursor: 1)
    _ = ChatReducer.reduce(
      state: &state,
      action: .frame(eventFrame(seq: 3, event: .textDelta(text: "B")))
    )
    let replay = [
      ReplayEntryDTO(
        seq: 2,
        msgId: "turn-1",
        agentId: "agent-1",
        conversationId: "conv-1",
        timestamp: Date(timeIntervalSince1970: 2),
        payload: .event(event: .textDelta(text: "A"))
      ),
      ReplayEntryDTO(
        seq: 4,
        msgId: "turn-1",
        agentId: "agent-1",
        conversationId: "conv-1",
        timestamp: Date(timeIntervalSince1970: 4),
        payload: .event(event: .textDelta(text: "C"))
      ),
    ]

    let effects = ChatReducer.reduce(state: &state, action: .replayLoaded(replay))

    #expect(state.messages.last?.assistant?.text == "ABC")
    #expect(state.lastAppliedSeq == 4)
    #expect(effects == [.persistCursor(2), .persistCursor(3), .persistCursor(4)])
  }

  @Test("a second gap keeps only the earliest pending frame")
  func keepsEarliestPendingGap() {
    var state = acceptedState(cursor: 1)

    _ = ChatReducer.reduce(
      state: &state,
      action: .frame(eventFrame(seq: 5, event: .textDelta(text: "five")))
    )
    _ = ChatReducer.reduce(
      state: &state,
      action: .frame(eventFrame(seq: 3, event: .textDelta(text: "three")))
    )

    #expect(state.pendingGapFrame == eventFrame(seq: 3, event: .textDelta(text: "three")))
  }

  @Test("thinking accumulates but stays collapsed by default, MC-parity, even while streaming")
  func thinkingProjection() {
    var state = acceptedState(cursor: 1)

    _ = apply(.thinkingDelta(text: "Plan "), seq: 2, to: &state)
    _ = apply(.thinkingDelta(text: "carefully"), seq: 3, to: &state)
    #expect(state.messages.last?.assistant?.thinking == "Plan carefully")
    #expect(state.messages.last?.assistant?.isThinkingCollapsed == true)

    _ = apply(.response(content: "Done", usage: usage()), seq: 4, to: &state)
    #expect(state.messages.last?.assistant?.isThinkingCollapsed == true)
  }

  @Test("tool start, partial JSON, and success result update one stable card")
  func toolSuccessProjection() {
    var state = acceptedState(cursor: 1)

    _ = apply(
      .toolUseStart(id: "tool-1", name: "read_file", input: .object(["path": .string("a")])),
      seq: 2,
      to: &state
    )
    _ = apply(.toolUseDelta(partialJSON: "{\"path\":"), seq: 3, to: &state)
    _ = apply(.toolUseDelta(partialJSON: "\"a\"}"), seq: 4, to: &state)
    _ = apply(
      .toolResult(
        id: "tool-1",
        name: "read_file",
        content: "contents",
        isError: false,
        details: nil
      ),
      seq: 5,
      to: &state
    )

    let cards = state.messages.last?.assistant?.toolCards ?? []
    #expect(cards.count == 1)
    #expect(cards[0].id == "tool-1")
    #expect(cards[0].partialJSON == "{\"path\":\"a\"}")
    #expect(cards[0].status == .succeeded)
    #expect(cards[0].content == "contents")
  }

  @Test("tool error preserves text and an icon-addressable failure state")
  func toolErrorProjection() {
    var state = acceptedState(cursor: 1)

    _ = apply(.toolUseStart(id: "tool-1", name: "bash", input: nil), seq: 2, to: &state)
    _ = apply(
      .toolResult(
        id: "tool-1",
        name: "bash",
        content: "permission denied",
        isError: true,
        details: .object(["exitCode": .number(1)])
      ),
      seq: 3,
      to: &state
    )

    let card = state.messages.last?.assistant?.toolCards.first
    #expect(card?.status == .failed)
    #expect(card?.content == "permission denied")
    #expect(card?.details == .object(["exitCode": .number(1)]))
  }

  @Test("worker updates are keyed by run and worker ids")
  func workerProjection() {
    var state = acceptedState(cursor: 1)

    _ = apply(
      .workerSpawned(
        workerId: "worker-1",
        runId: "run-1",
        role: "researcher",
        brief: "Inspect",
        model: "test/model"
      ),
      seq: 2,
      to: &state
    )
    _ = apply(
      .workerSpawned(
        workerId: "worker-1",
        runId: "run-2",
        role: "reviewer",
        brief: "Review",
        model: "test/model"
      ),
      seq: 3,
      to: &state
    )
    _ = apply(
      .workerStatus(
        workerId: "worker-1",
        runId: "run-1",
        role: "researcher",
        status: .waitingInput,
        detail: "Need context",
        question: "Continue?"
      ),
      seq: 4,
      to: &state
    )
    _ = apply(
      .workerDone(
        workerId: "worker-1",
        runId: "run-1",
        role: "researcher",
        status: .done,
        report: "Complete",
        usage: usage()
      ),
      seq: 5,
      to: &state
    )

    let workers = state.messages.last?.assistant?.workerCards ?? []
    #expect(workers.count == 2)
    let first = workers.first { $0.key == WorkerKey(runID: "run-1", workerID: "worker-1") }
    let second = workers.first { $0.key == WorkerKey(runID: "run-2", workerID: "worker-1") }
    #expect(first?.status == .done)
    #expect(first?.report == "Complete")
    #expect(first?.usage == usage())
    #expect(second?.status == .running)
  }

  @Test("question supports options and a free-text answer")
  func questionProjection() {
    var state = acceptedState(cursor: 1)
    _ = apply(
      .question(id: "question-1", question: "Choose", options: ["A", "B"]),
      seq: 2,
      to: &state
    )

    #expect(state.messages.last?.assistant?.pendingQuestion?.options == ["A", "B"])
    _ = ChatReducer.reduce(
      state: &state,
      action: .answerSubmitted(questionID: "question-1", answer: "Custom answer")
    )
    #expect(state.messages.last?.assistant?.pendingQuestion?.answer == "Custom answer")
  }

  @Test("question draft resets when the question identity changes")
  func questionDraftResetsForNewQuestion() {
    var draft = QuestionDraftState(
      question: QuestionState(id: "question-1", question: "First?", options: [], answer: nil)
    )
    draft.text = "Answer for the first question"

    draft.reconcile(
      with: QuestionState(id: "question-2", question: "Second?", options: [], answer: nil)
    )

    #expect(draft.questionID == "question-2")
    #expect(draft.text.isEmpty)
  }

  @Test("worker done clears waiting-input detail and question")
  func workerDoneClearsWaitingInput() {
    var state = acceptedState(cursor: 1)
    _ = apply(
      .workerStatus(
        workerId: "worker-1",
        runId: "run-1",
        role: "researcher",
        status: .waitingInput,
        detail: "Need context",
        question: "Continue?"
      ),
      seq: 2,
      to: &state
    )
    _ = apply(
      .workerDone(
        workerId: "worker-1",
        runId: "run-1",
        role: "researcher",
        status: .done,
        report: "Complete",
        usage: nil
      ),
      seq: 3,
      to: &state
    )

    let worker = state.messages.last?.assistant?.workerCards.first
    #expect(worker?.status == .done)
    #expect(worker?.detail == nil)
    #expect(worker?.question == nil)
  }

  @Test("response content is a fallback and usage is retained")
  func responseFallbackAndUsage() {
    var fallback = acceptedState(cursor: 1)
    _ = apply(.response(content: "Fallback", usage: usage()), seq: 2, to: &fallback)
    #expect(fallback.messages.last?.assistant?.text == "Fallback")
    #expect(fallback.messages.last?.assistant?.usage == usage())

    var streamed = acceptedState(cursor: 1)
    _ = apply(.textDelta(text: "Streamed"), seq: 2, to: &streamed)
    _ = apply(.response(content: "Duplicate", usage: usage()), seq: 3, to: &streamed)
    #expect(streamed.messages.last?.assistant?.text == "Streamed")
  }

  @Test("status-only frozen events project readable rows")
  func statusRowsCoverFrozenEvents() {
    var state = acceptedState(cursor: 1)
    let events: [AgentEvent] = [
      .error(error: "provider failed", timestamp: nil),
      .fileChanged(files: ["README.md"]),
      .agentSpawned(name: "helper"),
      .agentRetry(attempt: 2, reason: "rate limit"),
      .contextCompacted(overflow: true),
      .skillLoaded(name: "search"),
      .skillCreated(name: "new-skill", description: "Does work"),
      .mcpServerError(server: "github", error: "offline"),
    ]

    for (offset, event) in events.enumerated() {
      _ = apply(event, seq: offset + 2, to: &state)
    }

    let rows = state.messages.last?.assistant?.statusRows ?? []
    #expect(
      rows.map(\.kind) == [
        .agentError,
        .filesChanged,
        .agentSpawned,
        .retry,
        .contextCompacted,
        .skillLoaded,
        .skillCreated,
        .mcpError,
      ])
    #expect(rows[1].detail == "README.md")
    #expect(rows[4].detail?.contains("overflow") == true)
  }

  @Test("unknown events expose only their discriminator")
  func unknownEventProjection() {
    var state = acceptedState(cursor: 1)
    let raw: JSONValue = .object([
      "type": .string("future_event"),
      "secretPayload": .string("must-not-render"),
    ])

    _ = apply(.unknown(type: "future_event", raw: raw), seq: 2, to: &state)

    let row = state.messages.last?.assistant?.statusRows.last
    #expect(row?.kind == .unknown)
    #expect(row?.unknownType == "future_event")
    #expect(row?.title == "Gateway event: future_event")
    #expect(row?.detail == nil)
  }

  @Test("completed terminal announces the final response exactly once")
  func completionAnnouncesOnce() {
    var state = acceptedState(cursor: 1)
    _ = apply(.textDelta(text: "Final answer"), seq: 2, to: &state)
    let done = MobileWSServerFrame.done(
      id: "turn-1",
      conversationId: "conv-1",
      seq: 3,
      outcome: .completed
    )

    let first = ChatReducer.reduce(state: &state, action: .frame(done))
    let second = ChatReducer.reduce(state: &state, action: .frame(done))

    #expect(state.messages.last?.status == .completed)
    #expect(state.messages.last?.assistant?.terminal == .completed)
    #expect(first == [.persistCursor(3), .announceFinalResponse("Final answer")])
    #expect(second.isEmpty)
  }

  @Test("streamed tokens do not change the message accessibility label")
  func streamingAccessibilityLabelIsStable() {
    var state = acceptedState(cursor: 1)
    _ = apply(.textDelta(text: "First token"), seq: 2, to: &state)
    let initialLabel = state.messages.last?.accessibilityStatusLabel

    _ = apply(.textDelta(text: " second token"), seq: 3, to: &state)

    #expect(state.messages.last?.accessibilityStatusLabel == initialLabel)
    #expect(initialLabel == "Assistant message, streaming")
  }

  @Test("assistant response text becomes accessibility-visible only at terminal state")
  func assistantTextAccessibilityWaitsForTerminal() {
    var state = acceptedState(cursor: 1)
    _ = apply(.textDelta(text: "Final answer"), seq: 2, to: &state)

    #expect(state.messages.last?.exposesAssistantTextToAccessibility == false)

    _ = ChatReducer.reduce(
      state: &state,
      action: .frame(
        .done(
          id: "turn-1",
          conversationId: "conv-1",
          seq: 3,
          outcome: .completed
        )
      )
    )

    #expect(state.messages.last?.exposesAssistantTextToAccessibility == true)
    #expect(state.messages.last?.accessibilityStatusLabel == "Assistant message, completed")
  }

  @Test("a terminal frame advances the authoritative summary cursor")
  func terminalAdvancesSummaryCursor() {
    var state = acceptedState(cursor: 1)

    _ = ChatReducer.reduce(
      state: &state,
      action: .frame(
        .done(
          id: "turn-1",
          conversationId: "conv-1",
          seq: 2,
          outcome: .completed
        )
      )
    )

    #expect(state.conversation.lastSeq == 2)
    #expect(state.conversation.status == .idle)
  }

  @Test("cancelled terminal is projected and announced once")
  func cancellationAnnouncesOnce() {
    var state = acceptedState(cursor: 1)
    let done = MobileWSServerFrame.done(
      id: "turn-1",
      conversationId: "conv-1",
      seq: 2,
      outcome: .cancelled
    )

    let first = ChatReducer.reduce(state: &state, action: .frame(done))
    let second = ChatReducer.reduce(state: &state, action: .frame(done))

    #expect(state.messages.last?.status == .cancelled)
    #expect(state.messages.last?.assistant?.terminal == .cancelled)
    #expect(first == [.persistCursor(2), .announceFinalResponse("Response cancelled")])
    #expect(second.isEmpty)
  }

  @Test("failed terminal is projected and announced once")
  func failureAnnouncesOnce() {
    var state = acceptedState(cursor: 1)
    let frame = MobileWSServerFrame.error(
      id: "turn-1",
      conversationId: "conv-1",
      seq: 2,
      error: "Provider unavailable",
      code: "gateway_offline",
      retryable: true,
      activeTurnId: nil
    )

    let first = ChatReducer.reduce(state: &state, action: .frame(frame))
    let second = ChatReducer.reduce(state: &state, action: .frame(frame))

    #expect(state.messages.last?.status == .failed)
    #expect(state.messages.last?.assistant?.terminal == .failed("Provider unavailable"))
    #expect(
      first == [
        .persistCursor(2),
        .announceFinalResponse("Response failed: Provider unavailable"),
      ]
    )
    #expect(second.isEmpty)
  }

  @Test("cached failed and interrupted messages retain terminal state without announcements")
  func cachedTerminalProjection() {
    var state = chatState()
    let effects = ChatReducer.reduce(
      state: &state,
      action: .cachedMessagesLoaded(
        [
          message(
            id: "failed",
            turnID: "turn-failed",
            ordinal: 1,
            role: .assistant,
            status: .failed,
            content: .assistant(events: [.error(error: "failed", timestamp: nil)])
          ),
          message(
            id: "interrupted",
            turnID: "turn-interrupted",
            ordinal: 2,
            role: .assistant,
            status: .interrupted,
            content: .assistant(events: [.textDelta(text: "partial")])
          ),
        ],
        cursor: 2
      )
    )

    #expect(state.messages[0].assistant?.terminal == .failed("failed"))
    #expect(state.messages[1].assistant?.terminal == .interrupted)
    #expect(effects.isEmpty)
  }

  @Test("an authoritative active turn from another client blocks the composer")
  func remoteActiveTurn() {
    var state = chatState()
    let remote = summary(status: .running, activeTurnID: "remote-turn", lastSeq: 8)

    _ = ChatReducer.reduce(state: &state, action: .authoritativeSummary(remote))

    #expect(state.activeTurnID == "remote-turn")
    #expect(state.composerBlock == .remoteActiveTurn("remote-turn"))
    #expect(state.lastAppliedSeq == 0)
  }

  @Test("conversation_busy removes the rejected optimistic send and adopts the remote turn")
  func busyAdmissionError() {
    var state = chatState()
    _ = ChatReducer.reduce(
      state: &state,
      action: .cachedMessagesLoaded(
        [
          message(
            id: "existing-user",
            turnID: "existing-turn",
            ordinal: 1,
            role: .user,
            status: .completed,
            content: .user(text: "Existing", images: nil)
          ),
          message(
            id: "existing-assistant",
            turnID: "existing-turn",
            ordinal: 2,
            role: .assistant,
            status: .completed,
            content: .assistant(events: [.textDelta(text: "Canonical")])
          ),
        ],
        cursor: 0
      )
    )
    _ = ChatReducer.reduce(
      state: &state,
      action: .sendStarted(
        turnID: "local-turn",
        localUserID: "local-user",
        text: "Rejected message",
        images: []
      )
    )
    let summaryBeforeAdmission = state.conversation
    let frame = MobileWSServerFrame.error(
      id: "local-turn",
      conversationId: nil,
      seq: nil,
      error: "Conversation is busy",
      code: "conversation_busy",
      retryable: false,
      activeTurnId: "remote-turn"
    )

    let effects = ChatReducer.reduce(state: &state, action: .frame(frame))

    #expect(state.activeTurnID == "remote-turn")
    #expect(state.composerBlock == .remoteActiveTurn("remote-turn"))
    #expect(state.messages.map(\.id) == ["existing-user", "existing-assistant"])
    #expect(state.conversation == summaryBeforeAdmission)
    #expect(state.lastAppliedSeq == 0)
    #expect(effects.isEmpty)
  }

  @Test("a stale local terminal cannot clear an authoritative remote active turn")
  func staleTerminalPreservesRemoteTurn() {
    var state = chatState()
    let remote = summary(status: .running, activeTurnID: "remote-turn", lastSeq: 8)
    _ = ChatReducer.reduce(state: &state, action: .authoritativeSummary(remote))

    _ = ChatReducer.reduce(
      state: &state,
      action: .frame(
        .done(
          id: "stale-local-turn",
          conversationId: "conv-1",
          seq: nil,
          outcome: .completed
        )
      )
    )

    #expect(state.activeTurnID == "remote-turn")
    #expect(state.composerBlock == .remoteActiveTurn("remote-turn"))
    #expect(state.conversation.status == .running)
    #expect(state.conversation.activeTurnId == "remote-turn")
  }

  @Test("older pages merge by canonical id without duplicates")
  func olderPageDeduplicatesByID() {
    var state = chatState()
    _ = ChatReducer.reduce(
      state: &state,
      action: .cachedMessagesLoaded(
        [
          message(
            id: "new",
            turnID: "turn-new",
            ordinal: 2,
            role: .user,
            status: .completed,
            content: .user(text: "new", images: nil)
          )
        ],
        cursor: 3
      )
    )

    _ = ChatReducer.reduce(
      state: &state,
      action: .olderMessagesLoaded(
        [
          message(
            id: "old",
            turnID: "turn-old",
            ordinal: 1,
            role: .user,
            status: .completed,
            content: .user(text: "old", images: nil)
          ),
          message(
            id: "new",
            turnID: "turn-new",
            ordinal: 2,
            role: .user,
            status: .completed,
            content: .user(text: "new", images: nil)
          ),
        ],
        nextCursor: "older"
      )
    )

    #expect(state.messages.map(\.id) == ["old", "new"])
    #expect(state.olderCursor == "older")
    #expect(state.isLoadingOlder == false)
  }

  @Test("repair and update failures emit only reducer-owned guidance effects")
  func failureEffects() {
    var repair = chatState()
    #expect(
      ChatReducer.reduce(state: &repair, action: .failure(.unauthorized)) == [.showRepair]
    )
    #expect(repair.composerBlock == .repairRequired)

    var update = chatState()
    #expect(
      ChatReducer.reduce(state: &update, action: .failure(.updateRequired)) == [.showRepair]
    )
    #expect(update.composerBlock == .updateRequired)
  }

  private func apply(
    _ event: AgentEvent,
    seq: Int,
    to state: inout ChatState
  ) -> [ChatEffect] {
    ChatReducer.reduce(state: &state, action: .frame(eventFrame(seq: seq, event: event)))
  }

  private func chatState(cursor: Int = 0) -> ChatState {
    ChatState(
      conversation: summary(lastSeq: cursor),
      messages: [],
      draft: "",
      attachments: [],
      transport: .connected,
      lastAppliedSeq: cursor,
      activeTurnID: nil,
      pendingGapFrame: nil,
      isLoadingOlder: false,
      olderCursor: nil,
      composerBlock: nil,
      errorBanner: nil
    )
  }

  private func acceptedState(cursor: Int) -> ChatState {
    var state = chatState()
    _ = ChatReducer.reduce(
      state: &state,
      action: .sendStarted(turnID: "turn-1", localUserID: "local-u", text: "Hello", images: [])
    )
    _ = ChatReducer.reduce(
      state: &state,
      action: .frame(
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
    if cursor > 1 {
      state.lastAppliedSeq = cursor
    }
    return state
  }

  private func eventFrame(seq: Int, event: AgentEvent) -> MobileWSServerFrame {
    .event(id: "turn-1", conversationId: "conv-1", seq: seq, event: event)
  }

  private func summary(
    status: ConversationStatus = .idle,
    activeTurnID: String? = nil,
    lastSeq: Int = 0
  ) -> ConversationSummaryDTO {
    ConversationSummaryDTO(
      id: "conv-1",
      agentId: "agent-1",
      agentName: "Dash",
      title: "Chat",
      revision: 1,
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

  private func message(
    id: String,
    turnID: String,
    ordinal: Int,
    role: MessageRole,
    status: MessageStatus,
    content: MessageContent
  ) -> ConversationMessageDTO {
    ConversationMessageDTO(
      id: id,
      conversationId: "conv-1",
      turnId: turnID,
      ordinal: ordinal,
      role: role,
      status: status,
      content: content,
      createdAt: Date(timeIntervalSince1970: TimeInterval(ordinal)),
      updatedAt: Date(timeIntervalSince1970: TimeInterval(ordinal))
    )
  }

  private func usage() -> UsageDTO {
    UsageDTO(inputTokens: 12, outputTokens: 6, cacheReadTokens: 2, cacheWriteTokens: 1)
  }
}
