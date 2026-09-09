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
          seq: 1,
          origin: nil,
          kind: nil,
          requestId: nil
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
          seq: 1,
          origin: nil,
          kind: nil,
          requestId: nil
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

  /// The row is keyed on the CHILD ID ALONE, not on `(runId, workerId)`.
  ///
  /// This replaces the old "worker updates are keyed by run and worker ids"
  /// test, which asserted that the same `workerId` under two `runId`s produced
  /// TWO cards. That was never reachable — a worker id IS the child's
  /// conversation id (`coordinator.ts:499-510`, `child-handle.ts:169`), so it
  /// is unique across runs — and it is incompatible with the canonical family,
  /// which carries no `runId` at all. Keying on the id alone is what makes
  /// ruling 4 hold: `subagentId === workerId === childConversationId`, so a
  /// child emitting BOTH families lands on exactly one card.
  @Test("both event families for one child fold into a single card")
  func subagentDualFamilyFoldsIntoOneCard() {
    var state = acceptedState(cursor: 1)

    // Emission order as the gateway actually produces it today: the legacy
    // mirror first, the canonical event immediately after.
    _ = apply(
      .workerSpawned(
        workerId: "child-1",
        runId: "run-1",
        role: "researcher",
        brief: "Inspect",
        model: "test/model"
      ),
      seq: 2,
      to: &state
    )
    _ = apply(
      .subagentStarted(
        subagentId: "child-1",
        name: "scout",
        subagentType: "Explore",
        description: "map code",
        prompt: "map it",
        model: "test/model",
        background: false,
        depth: 1,
        startedAt: Date(timeIntervalSince1970: 1_788_480_000),
        isolation: nil,
        parentTurnId: nil
      ),
      seq: 3,
      to: &state
    )
    _ = apply(
      .subagentProgress(
        subagentId: "child-1",
        status: .running,
        toolCallCount: 3,
        elapsedMs: 7200,
        detail: "reading files",
        question: nil
      ),
      seq: 4,
      to: &state
    )
    _ = apply(
      .subagentFinished(
        subagentId: "child-1",
        name: "scout",
        subagentType: "Explore",
        description: "map code",
        status: .done,
        report: "Two findings.",
        usage: usage(),
        toolCallCount: 3,
        startedAt: Date(timeIntervalSince1970: 1_788_480_000),
        endedAt: Date(timeIntervalSince1970: 1_788_480_072)
      ),
      seq: 5,
      to: &state
    )

    let cards = state.messages.last?.assistant?.subagentCards ?? []
    #expect(cards.count == 1)
    let card = cards.first
    #expect(card?.id == "child-1")
    #expect(card?.name == "scout")
    #expect(card?.type == "Explore")
    #expect(card?.description == "map code")
    #expect(card?.status == .done)
    #expect(card?.toolCallCount == 3)
    #expect(card?.report == "Two findings.")
    #expect(card?.usage == usage())
    #expect(card?.startedAt == Date(timeIntervalSince1970: 1_788_480_000))
    #expect(card?.endedAt == Date(timeIntervalSince1970: 1_788_480_072))
    #expect(card?.depth == 1)
    #expect(card?.background == false)
    #expect(card?.isOrphan == false)
  }

  /// Field precedence must not depend on which family happens to arrive last.
  /// The web twin keeps the two families in separate slots and prefers the
  /// canonical one at resolve time for exactly this reason.
  @Test("the canonical family wins even when the legacy mirror arrives after it")
  func subagentCanonicalWinsRegardlessOfOrder() {
    var state = acceptedState(cursor: 1)

    _ = apply(
      .subagentFinished(
        subagentId: "child-1",
        name: nil,
        subagentType: "Explore",
        description: "map code",
        status: .done,
        report: "canonical report",
        usage: nil,
        toolCallCount: 4,
        startedAt: Date(timeIntervalSince1970: 1_788_480_000),
        endedAt: Date(timeIntervalSince1970: 1_788_480_072)
      ),
      seq: 2,
      to: &state
    )
    _ = apply(
      .workerDone(
        workerId: "child-1",
        runId: "run-1",
        role: "researcher",
        status: .failed,
        report: "legacy report",
        usage: nil
      ),
      seq: 3,
      to: &state
    )

    let card = state.messages.last?.assistant?.subagentCards.first
    #expect(card?.status == .done)
    #expect(card?.report == "canonical report")
    #expect(card?.type == "Explore")
  }

  /// A running canonical progress event deliberately CLEARS the question. A
  /// per-field `modern ?? legacy` fallback would let the stale mirrored
  /// question reappear, so the two progress slots resolve as a unit.
  @Test("a running canonical progress clears a question the legacy mirror set")
  func subagentRunningProgressClearsMirroredQuestion() {
    var state = acceptedState(cursor: 1)

    _ = apply(
      .workerStatus(
        workerId: "child-1",
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
      .subagentProgress(
        subagentId: "child-1",
        status: .running,
        toolCallCount: 1,
        elapsedMs: 100,
        detail: nil,
        question: nil
      ),
      seq: 3,
      to: &state
    )

    let card = state.messages.last?.assistant?.subagentCards.first
    #expect(card?.status == .running)
    #expect(card?.question == nil)
  }

  @Test("interrupted and max_turns are first-class terminal statuses")
  func subagentWiderTerminalStatuses() {
    for (wire, expected) in [
      (SubagentTerminalStatus.interrupted, SubagentCardStatus.interrupted),
      (SubagentTerminalStatus.maxTurns, SubagentCardStatus.maxTurns),
    ] {
      var state = acceptedState(cursor: 1)
      _ = apply(
        .subagentFinished(
          subagentId: "child-1",
          name: nil,
          subagentType: "Explore",
          description: "map code",
          status: wire,
          report: "stopped",
          usage: nil,
          toolCallCount: 0,
          startedAt: Date(timeIntervalSince1970: 1_788_480_000),
          endedAt: Date(timeIntervalSince1970: 1_788_480_072)
        ),
        seq: 2,
        to: &state
      )
      let card = state.messages.last?.assistant?.subagentCards.first
      #expect(card?.status == expected)
      #expect(card?.status.isTerminal == true)
    }
  }

  /// End-of-stream terminalization (Mission Control's `deriveWorkerStatus`,
  /// ported to web in D1): the parent turn ended and this child never reported
  /// back, so the row reads `cancelled` — and, critically, must NOT keep the
  /// question it was waiting on. This path reaches a terminal status with NO
  /// terminal event at all, which is why the question gate reads the RESOLVED
  /// status rather than the presence of a terminal event.
  @Test("a waiting child with no terminal event is cancelled at end of stream, without its question")
  func subagentEndOfStreamTerminalization() {
    var state = acceptedState(cursor: 1)
    _ = apply(
      .subagentProgress(
        subagentId: "child-1",
        status: .waitingInput,
        toolCallCount: 2,
        elapsedMs: 500,
        detail: nil,
        question: "Which branch?"
      ),
      seq: 2,
      to: &state
    )

    let live = state.messages.last?.assistant?.subagentCards.first
    #expect(live?.status == .waiting)
    #expect(live?.question == "Which branch?")

    _ = ChatReducer.reduce(
      state: &state,
      action: .frame(.done(id: "turn-1", conversationId: "conv-1", seq: 3, outcome: .completed))
    )

    let ended = state.messages.last?.assistant?.subagentCards.first
    #expect(ended?.status == .cancelled)
    #expect(ended?.question == nil)
    // The question survives as the last thing the child said, so the row can
    // still show it as context — it just no longer means "reply here".
    #expect(ended?.detail == "Which branch?")
  }

  /// A background child is spawned precisely to OUTLIVE the turn that spawned
  /// it, so the parent's message ending says nothing about whether it is still
  /// working. Only a real terminal event ends one.
  @Test("a background child is exempt from end-of-stream cancellation")
  func subagentBackgroundExemptFromEndOfStream() {
    var state = acceptedState(cursor: 1)
    _ = apply(
      .subagentStarted(
        subagentId: "child-1",
        name: nil,
        subagentType: "Explore",
        description: "map code",
        prompt: "map it",
        model: "m",
        background: true,
        depth: 1,
        startedAt: Date(timeIntervalSince1970: 1_788_480_000),
        isolation: nil,
        parentTurnId: nil
      ),
      seq: 2,
      to: &state
    )
    _ = apply(
      .subagentProgress(
        subagentId: "child-1",
        status: .waitingInput,
        toolCallCount: 0,
        elapsedMs: 10,
        detail: nil,
        question: "Which branch?"
      ),
      seq: 3,
      to: &state
    )
    _ = ChatReducer.reduce(
      state: &state,
      action: .frame(.done(id: "turn-1", conversationId: "conv-1", seq: 4, outcome: .completed))
    )

    let card = state.messages.last?.assistant?.subagentCards.first
    #expect(card?.background == true)
    #expect(card?.status == .waiting)
    // Still live, so the inline reply affordance stays.
    #expect(card?.question == "Which branch?")
  }

  /// Crash-reconcile can split one child across two persisted messages: the
  /// start lands in message A and the terminal event in message B. In B the
  /// terminal is an orphan — it still yields a row, flagged so the renderer
  /// can draw the compact standalone form and keep it out of a parallel
  /// cluster.
  @Test("a terminal event with no start in the same message is an orphan row")
  func subagentOrphanTerminal() {
    var state = acceptedState(cursor: 1)
    _ = apply(
      .subagentFinished(
        subagentId: "child-1",
        name: nil,
        subagentType: "Explore",
        description: "map code",
        status: .done,
        report: "done",
        usage: nil,
        toolCallCount: 1,
        startedAt: Date(timeIntervalSince1970: 1_788_480_000),
        endedAt: Date(timeIntervalSince1970: 1_788_480_072)
      ),
      seq: 2,
      to: &state
    )
    let card = state.messages.last?.assistant?.subagentCards.first
    #expect(card?.isOrphan == true)
    #expect(card?.isAdjacentToPrevious == false)
  }

  /// §8.2: children whose start events are adjacent — nothing but sub-agent
  /// chrome between them — render inside one parallel group. Adjacency is
  /// computed in the fold because it needs the event stream, which the card
  /// list no longer carries.
  @Test("adjacent spawns are marked adjacent and a text delta between them breaks it")
  func subagentAdjacency() {
    func start(_ id: String) -> AgentEvent {
      .subagentStarted(
        subagentId: id,
        name: nil,
        subagentType: "Explore",
        description: "map code",
        prompt: "map it",
        model: "m",
        background: false,
        depth: 1,
        startedAt: Date(timeIntervalSince1970: 1_788_480_000),
        isolation: nil,
        parentTurnId: nil
      )
    }

    var parallel = acceptedState(cursor: 1)
    _ = apply(start("a"), seq: 2, to: &parallel)
    // `agent_spawned` is the coordinator's name-only announcement, pushed
    // between two spawns; it is chrome, not content.
    _ = apply(.agentSpawned(name: "b"), seq: 3, to: &parallel)
    _ = apply(start("b"), seq: 4, to: &parallel)
    let parallelCards = parallel.messages.last?.assistant?.subagentCards ?? []
    #expect(parallelCards.map(\.id) == ["a", "b"])
    #expect(parallelCards.first?.isAdjacentToPrevious == false)
    #expect(parallelCards.last?.isAdjacentToPrevious == true)

    var split = acceptedState(cursor: 1)
    _ = apply(start("a"), seq: 2, to: &split)
    _ = apply(.textDelta(text: "thinking about it"), seq: 3, to: &split)
    _ = apply(start("b"), seq: 4, to: &split)
    let splitCards = split.messages.last?.assistant?.subagentCards ?? []
    #expect(splitCards.map(\.id) == ["a", "b"])
    #expect(splitCards.last?.isAdjacentToPrevious == false)
  }

  /// A legacy-only child (no canonical event ever arrives) still renders, with
  /// `role`/`brief` standing in for `subagentType`/`description`. It carries no
  /// timestamps at all, which is why `startedAt` is optional: D5 must render
  /// nothing for elapsed rather than the row's own age.
  @Test("a retired worker_* mirror folds into nothing")
  func subagentLegacyOnly() {
    var state = acceptedState(cursor: 1)
    _ = apply(
      .workerSpawned(
        workerId: "child-1",
        runId: "run-1",
        role: "researcher",
        brief: "Inspect",
        model: "test/model"
      ),
      seq: 2,
      to: &state
    )

    // D8: it anchors no card...
    #expect(state.messages.last?.assistant?.subagentCards.isEmpty == true)
    // ...and it is still CHROME, so it never reaches the `.unknown` branch,
    // which would draw "Gateway event: worker_spawned" on every persisted
    // pre-D8 conversation.
    #expect(state.messages.last?.assistant?.statusRows.isEmpty == true)
  }

  /// The whole pre-D8 sequence one child used to produce. It must render
  /// exactly the card its canonical half describes — no second card, no
  /// unknown-event rows, and no field taken from a mirror.
  @Test("a persisted pre-D8 transcript renders one normal card")
  func subagentPreD8Transcript() {
    var state = acceptedState(cursor: 1)
    _ = apply(
      .workerSpawned(
        workerId: "child-1", runId: "run-1", role: "researcher", brief: "Inspect",
        model: "test/model"),
      seq: 2, to: &state)
    _ = apply(.agentSpawned(name: "researcher"), seq: 3, to: &state)
    _ = apply(
      .subagentStarted(
        subagentId: "child-1", name: "scout", subagentType: "Explore", description: "Map it",
        prompt: "p", model: "test/model", background: false, depth: 1,
        startedAt: Date(timeIntervalSince1970: 100), isolation: nil, parentTurnId: nil),
      seq: 4, to: &state)
    _ = apply(
      .workerStatus(
        workerId: "child-1", runId: "run-1", role: "researcher", status: .waitingInput,
        detail: "legacy detail", question: "Legacy question?"),
      seq: 5, to: &state)
    _ = apply(
      .subagentProgress(
        subagentId: "child-1", status: .running, toolCallCount: 4, elapsedMs: 1,
        detail: "modern detail", question: nil),
      seq: 6, to: &state)
    _ = apply(
      .workerDone(
        workerId: "child-1", runId: "run-1", role: "researcher", status: .cancelled,
        report: "Legacy report", usage: nil),
      seq: 7, to: &state)
    _ = apply(
      .subagentFinished(
        subagentId: "child-1", name: "scout", subagentType: "Explore", description: "Map it",
        status: .done, report: "Modern report", usage: nil, toolCallCount: 6,
        startedAt: Date(timeIntervalSince1970: 100),
        endedAt: Date(timeIntervalSince1970: 160)),
      seq: 8, to: &state)

    let cards = state.messages.last?.assistant?.subagentCards ?? []
    #expect(cards.count == 1)
    #expect(cards.first?.type == "Explore")
    #expect(cards.first?.description == "Map it")
    #expect(cards.first?.status == .done)
    #expect(cards.first?.report == "Modern report")
    #expect(cards.first?.detail == "modern detail")
    #expect(cards.first?.toolCallCount == 6)
    #expect(cards.first?.isOrphan == false)
    #expect(state.messages.last?.assistant?.statusRows.contains { $0.kind == .unknown } == false)
  }

  /// The fold DISCARDS `subagent_progress.elapsedMs` — D1 parked this and D2
  /// confirmed it — so elapsed is derived from `startedAt`/`endedAt` and a
  /// terminal run with no `endedAt` must render nothing rather than its own
  /// age. Pinned here so nobody "helpfully" adds the field back and gives D5
  /// two disagreeing sources.
  @Test("elapsedMs is not folded onto the card")
  func subagentDiscardsElapsedMs() {
    var state = acceptedState(cursor: 1)
    _ = apply(
      .subagentProgress(
        subagentId: "child-1",
        status: .running,
        toolCallCount: 1,
        elapsedMs: 999_999,
        detail: nil,
        question: nil
      ),
      seq: 2,
      to: &state
    )
    let card = state.messages.last?.assistant?.subagentCards.first
    #expect(card?.startedAt == nil)
    #expect(card?.endedAt == nil)
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

  /// An explicit terminal event is the OTHER path by which a question can leak
  /// onto a dead row (the first is end-of-stream terminalization above). §8.1
  /// hangs the inline reply affordance off `question`, so a finished child
  /// carrying one renders a live reply box on a corpse.
  @Test("an explicit terminal event clears the waiting-input question")
  func subagentTerminalEventClearsQuestion() {
    var state = acceptedState(cursor: 1)
    _ = apply(
      .subagentProgress(
        subagentId: "child-1",
        status: .waitingInput,
        toolCallCount: 1,
        elapsedMs: 100,
        detail: "Need context",
        question: "Continue?"
      ),
      seq: 2,
      to: &state
    )
    _ = apply(
      .subagentFinished(
        subagentId: "child-1",
        name: nil,
        subagentType: "Explore",
        description: "map code",
        status: .cancelled,
        report: "",
        usage: nil,
        toolCallCount: 1,
        startedAt: Date(timeIntervalSince1970: 1_788_480_000),
        endedAt: Date(timeIntervalSince1970: 1_788_480_072)
      ),
      seq: 3,
      to: &state
    )

    let card = state.messages.last?.assistant?.subagentCards.first
    #expect(card?.status == .cancelled)
    #expect(card?.question == nil)
    #expect(card?.detail == "Continue?")
  }

  /// D8 retired the `worker_*` family. A persisted pre-D8 `worker_status`
  /// must NOT park the row, and a `worker_done` must NOT terminalize it: the
  /// canonical half of the same transcript is what says both.
  @Test("a retired worker_status/worker_done pair changes nothing")
  func legacyWorkerDoneClearsWaitingInput() {
    var state = acceptedState(cursor: 1)
    _ = apply(
      .subagentStarted(
        subagentId: "child-1", name: nil, subagentType: "Explore", description: "Map it",
        prompt: "p", model: "m", background: false, depth: 1,
        startedAt: Date(timeIntervalSince1970: 100), isolation: nil, parentTurnId: nil),
      seq: 2, to: &state)
    _ = apply(
      .workerStatus(
        workerId: "child-1",
        runId: "run-1",
        role: "researcher",
        status: .waitingInput,
        detail: "Need context",
        question: "Continue?"
      ),
      seq: 3,
      to: &state
    )
    _ = apply(
      .workerDone(
        workerId: "child-1",
        runId: "run-1",
        role: "researcher",
        status: .done,
        report: "Complete",
        usage: nil
      ),
      seq: 4,
      to: &state
    )

    let card = state.messages.last?.assistant?.subagentCards.first
    // Live (the parent turn is still streaming) and never parked.
    #expect(card?.status == .running)
    #expect(card?.question == nil)
    #expect(card?.report == nil)
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

  // MARK: - Streaming presence / chrome trim (chat-ux Phase 2, Task 5,
  // audit #6 / #17): `AssistantMessageProjection.isEmpty` drives
  // `TypingIndicatorView` (EventViews.swift) and `ChatTerminalState
  // .isChromeWorthy` drives `TerminalView`'s render gate. Both are pure,
  // view-independent — same rationale `MessageViewsTests.swift` gives for
  // testing `failedTurnIDs`/`userMessageID` directly.

  @Test("a freshly-accepted projection (no events yet) is empty")
  func freshlyAcceptedProjectionIsEmpty() {
    let state = acceptedState(cursor: 1)
    #expect(state.messages.last?.assistant?.isEmpty == true)
  }

  /// Regression for chat-ux Phase 2, Task 5 fix round 1: the first cut of
  /// `TypingIndicatorView`'s gate checked `status == .accepted`, which is
  /// dead code — `ChatReducer.reconcileAccepted` never assigns `.accepted`
  /// to the assistant message, only `.streaming` (`.accepted` is exclusively
  /// the USER message's status; see `reconcileAccepted`'s two branches at
  /// `ChatReducer.swift` — the assistant branch a few lines below always
  /// sets `.streaming`). This drives the reducer through the real `accepted`
  /// → `event` sequence and asserts against `shouldShowTypingIndicator`
  /// itself — the exact composed predicate `AssistantEventViews.body`
  /// calls — not a hand-rolled boolean expression that could itself drift
  /// from what the view does.
  @Test(
    "shouldShowTypingIndicator is true immediately after accept (status .streaming, empty projection) and flips false on the first text delta"
  )
  func typingIndicatorGateTracksAcceptToFirstTokenWindow() {
    var state = acceptedState(cursor: 1)
    let assistantAfterAccept = state.messages.last
    #expect(assistantAfterAccept?.role == .assistant)
    #expect(assistantAfterAccept?.status == .streaming)
    #expect(
      shouldShowTypingIndicator(
        status: assistantAfterAccept!.status,
        projection: assistantAfterAccept!.assistant!
      ) == true
    )

    _ = apply(.textDelta(text: "Hi"), seq: 2, to: &state)
    let assistantAfterDelta = state.messages.last
    #expect(assistantAfterDelta?.status == .streaming)
    #expect(
      shouldShowTypingIndicator(
        status: assistantAfterDelta!.status,
        projection: assistantAfterDelta!.assistant!
      ) == false
    )
  }

  @Test("a text delta makes the projection non-empty")
  func textDeltaEndsEmptiness() {
    var state = acceptedState(cursor: 1)
    _ = apply(.textDelta(text: "Hi"), seq: 2, to: &state)
    #expect(state.messages.last?.assistant?.isEmpty == false)
  }

  @Test("a tool-use-only projection (no text yet) is also non-empty")
  func toolUseOnlyProjectionIsNonEmpty() {
    var state = acceptedState(cursor: 1)
    _ = apply(.toolUseStart(id: "tool-1", name: "Bash", input: nil), seq: 2, to: &state)
    #expect(state.messages.last?.assistant?.isEmpty == false)
  }

  @Test("usage alone (no other content) does not count as non-empty — it's no longer rendered")
  func usageAloneDoesNotCountAsContent() {
    var projection = AssistantMessageProjection()
    projection.usage = usage()
    #expect(projection.isEmpty == true)
  }

  @Test("terminal state alone counts as non-empty content")
  func terminalStateCountsAsContent() {
    var projection = AssistantMessageProjection()
    projection.terminal = .completed
    #expect(projection.isEmpty == false)
  }

  @Test("only a completed terminal is chrome-free; cancelled/failed/interrupted are chrome-worthy")
  func terminalChromeWorthiness() {
    #expect(ChatTerminalState.completed.isChromeWorthy == false)
    #expect(ChatTerminalState.cancelled.isChromeWorthy == true)
    #expect(ChatTerminalState.failed("boom").isChromeWorthy == true)
    #expect(ChatTerminalState.interrupted.isChromeWorthy == true)
  }

  // MARK: - hasComposeActivity (final-review fix C2)
  //
  // The choke point `ChatView`'s `onDisappear` consults before letting
  // `discardIfUnusedComposeCreation` silently delete a compose-created,
  // still-navigated-away-from conversation. A truly untouched compose
  // conversation (empty messages, no active turn, empty draft, no
  // attachments, still the gateway's default title) must be discarded —
  // everything else must be kept.

  @Test("a completely untouched compose conversation has no activity — the baseline the discard path relies on")
  func hasComposeActivityFalseForUntouchedConversation() {
    let state = composeActivityState()
    #expect(state.hasComposeActivity == false)
  }

  @Test("a non-empty draft counts as activity, even with no messages/attachments/rename")
  func hasComposeActivityTrueForDraftOnly() {
    let state = composeActivityState(draft: "half-typed thought")
    #expect(state.hasComposeActivity == true)
  }

  @Test("a whitespace-only draft does NOT count as activity — matches the trimmed-empty check elsewhere")
  func hasComposeActivityFalseForWhitespaceOnlyDraft() {
    let state = composeActivityState(draft: "   \n\t  ")
    #expect(state.hasComposeActivity == false)
  }

  @Test("a staged attachment counts as activity, even with no draft text/messages/rename")
  func hasComposeActivityTrueForAttachmentOnly() {
    let state = composeActivityState(
      attachments: [PreparedAttachment(id: UUID(), mediaType: "image/png", data: Data([0x01]))]
    )
    #expect(state.hasComposeActivity == true)
  }

  @Test("a title changed away from the gateway's default counts as activity, even with no messages/draft/attachments")
  func hasComposeActivityTrueForRenamedOnly() {
    let state = composeActivityState(title: "Trip planning")
    #expect(state.hasComposeActivity == true)
  }

  @Test("a non-empty message list counts as activity (pre-existing behavior, unchanged by this fix)")
  func hasComposeActivityTrueForMessages() {
    var state = composeActivityState()
    state.messages = [
      ChatMessageState(
        id: "u1",
        turnID: "turn-1",
        ordinal: 1,
        role: .user,
        status: .completed,
        user: UserMessageProjection(text: "hi", images: []),
        assistant: nil
      )
    ]
    #expect(state.hasComposeActivity == true)
  }

  @Test("an active turn counts as activity (pre-existing behavior, unchanged by this fix)")
  func hasComposeActivityTrueForActiveTurn() {
    var state = composeActivityState()
    state.activeTurnID = "turn-1"
    #expect(state.hasComposeActivity == true)
  }

  private func composeActivityState(
    draft: String = "",
    attachments: [PreparedAttachment] = [],
    title: String = ChatState.defaultConversationTitle
  ) -> ChatState {
    ChatState(
      conversation: summary(title: title),
      messages: [],
      draft: draft,
      attachments: attachments,
      transport: .connected,
      lastAppliedSeq: 0,
      activeTurnID: nil,
      pendingGapFrame: nil,
      isLoadingOlder: false,
      olderCursor: nil,
      composerBlock: nil,
      errorBanner: nil
    )
  }

  private func apply(
    _ event: AgentEvent,
    seq: Int,
    to state: inout ChatState
  ) -> [ChatEffect] {
    ChatReducer.reduce(state: &state, action: .frame(eventFrame(seq: seq, event: event)))
  }

  private func chatState(cursor: Int = 0, conversationID: String = "conv-1") -> ChatState {
    ChatState(
      conversation: summary(lastSeq: cursor, id: conversationID),
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

  // MARK: - Server-initiated turns (task C7, sub-agents design 7.6/8.5)

  @Test("an accepted for an unknown turn with a notification origin registers the turn as a notification row, not a blank user bubble")
  func acceptedNotificationRegistersNotificationRow() {
    var state = chatState()

    _ = ChatReducer.reduce(
      state: &state,
      action: .frame(
        .accepted(
          id: "turn-notification",
          conversationId: "conv-1",
          userMessageId: "notif-user",
          assistantMessageId: "notif-assistant",
          revision: 4,
          seq: 1,
          origin: .notification,
          kind: .user,
          requestId: nil
        )
      )
    )

    #expect(state.messages.map(\.id) == ["notif-user", "notif-assistant"])
    let user = state.messages.first
    #expect(user?.role == .user)
    #expect(user?.origin == .notification)
    #expect(isNotificationRow(user!))
    #expect(state.messages.last?.origin == .notification)
    #expect(state.activeTurnID == "turn-notification")
  }

  @Test("an accepted with no origin still reconciles an ordinary turn as a user message")
  func acceptedWithoutOriginStaysAUserTurn() {
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
          seq: 1,
          origin: nil,
          kind: nil,
          requestId: nil
        )
      )
    )

    #expect(state.messages.first?.origin == nil)
    #expect(isNotificationRow(state.messages[0]) == false)
  }

  @Test("a replayed accepted, which carries no origin at all, never downgrades an origin the canonical row already reported")
  func replayedAcceptedKeepsKnownOrigin() {
    var state = chatState()
    _ = ChatReducer.reduce(
      state: &state,
      action: .cachedMessagesLoaded(
        [
          message(
            id: "notif-user",
            turnID: "turn-notification",
            ordinal: 1,
            role: .user,
            status: .completed,
            content: .user(text: "[SYSTEM NOTIFICATION - NOT USER INPUT]", images: nil),
            origin: "notification"
          )
        ],
        cursor: 0
      )
    )
    #expect(state.messages.first?.origin == .notification)

    _ = ChatReducer.reduce(
      state: &state,
      action: .frame(
        .accepted(
          id: "turn-notification",
          conversationId: "conv-1",
          userMessageId: "notif-user",
          assistantMessageId: "notif-assistant",
          revision: 4,
          seq: 1,
          origin: nil,
          kind: nil,
          requestId: nil
        )
      )
    )

    #expect(state.messages.first?.origin == .notification)
  }

  @Test("canonical messages carry their origin into the projection")
  func projectedMessagesCarryOrigin() {
    var state = chatState()

    _ = ChatReducer.reduce(
      state: &state,
      action: .cachedMessagesLoaded(
        [
          message(
            id: "notif-user",
            turnID: "turn-notification",
            ordinal: 1,
            role: .user,
            status: .completed,
            content: .user(text: "notification text", images: nil),
            origin: "notification"
          ),
          message(
            id: "u1",
            turnID: "turn-1",
            ordinal: 2,
            role: .user,
            status: .completed,
            content: .user(text: "Hello", images: nil)
          ),
        ],
        cursor: 0
      )
    )

    #expect(state.messages.first?.origin == .notification)
    #expect(state.messages.last?.origin == nil)
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
          seq: 1,
          origin: nil,
          kind: nil,
          requestId: nil
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
    lastSeq: Int = 0,
    title: String = "Chat",
    id: String = "conv-1"
  ) -> ConversationSummaryDTO {
    ConversationSummaryDTO(
      id: id,
      agentId: "agent-1",
      agentName: "Dash",
      title: title,
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
    content: MessageContent,
    origin: String? = nil
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
      updatedAt: Date(timeIntervalSince1970: TimeInterval(ordinal)),
      origin: origin
    )
  }

  private func usage() -> UsageDTO {
    UsageDTO(inputTokens: 12, outputTokens: 6, cacheReadTokens: 2, cacheWriteTokens: 1)
  }

  // MARK: - D4: captured gateway streams

  /// §8.2's parallel-group container, against streams a REAL gateway sent.
  ///
  /// Both files were captured verbatim by
  /// `scripts/subagents-e2e/capture-fixtures.mjs` and they DISAGREE, which is
  /// the finding. Two FOREGROUND `agent` calls put both children's
  /// `tool_result`s after both `subagent_started`s and the group renders. Two
  /// BACKGROUND calls return each child's "launched in the background"
  /// `tool_result` IMMEDIATELY, so one lands between the anchors — and the
  /// group vanishes while both children are still RUNNING, which is exactly
  /// the case §8.2 exists for.
  ///
  /// Synthetic fixtures are why this survived three clients: every hand-written
  /// adjacency test put `agent_spawned` and nothing else between two starts.
  @Test("two foreground children in one captured turn render one parallel group")
  func capturedForegroundPairIsAdjacent() throws {
    let cards = try foldCapture("subagent-parallel-frames.jsonl")
    #expect(cards.count == 2)
    #expect(cards.first?.isAdjacentToPrevious == false)
    #expect(cards.last?.isAdjacentToPrevious == true)
  }

  @Test("two background children in one captured turn render one parallel group")
  func capturedBackgroundPairIsAdjacent() throws {
    // RED before the fix: `false`. Each child's own `agent` tool result lands
    // between the two anchors, so `chromeRank` differs and the pair splits.
    let cards = try foldCapture("subagent-background-pair-frames.jsonl")
    #expect(cards.count == 2)
    #expect(cards.first?.isAdjacentToPrevious == false)
    #expect(cards.last?.isAdjacentToPrevious == true)
  }

  @Test("a non-spawning tool call between two captured spawns still splits the group")
  func capturedOtherToolBreaksAdjacency() throws {
    let events = try capturedEvents("subagent-background-pair-frames.jsonl")
    var patched: [AgentEvent] = []
    var startsSeen = 0
    for event in events {
      if case .subagentStarted = event {
        startsSeen += 1
        if startsSeen == 2 {
          patched.append(
            .toolResult(id: "t9", name: "bash", content: "ok", isError: false, details: nil)
          )
        }
      }
      patched.append(event)
    }
    let cards = foldEvents(patched)
    #expect(cards.count == 2)
    #expect(cards.last?.isAdjacentToPrevious == false)
  }

  /// The events of the FIRST turn in a captured `MobileWSServerFrame` stream.
  // MARK: - D2: a notification turn re-anchoring a child that already has a card

  /// D2 on iOS — every background child drew a SECOND card.
  ///
  /// Fixed on Mission Control by `01eae2ed` and on web beside this commit;
  /// E3-x1 recorded iOS as affected and unfixed. The fold is per MESSAGE on
  /// every client by construction — a card is anchored by the
  /// `subagent_started` in its own message — so it cannot see that this child
  /// already has a card earlier in the conversation, and §31.4/§32.8.4's rule
  /// that an orphan terminal anchors its own card draws a second one.
  ///
  /// `subagent-notification-frames.jsonl` is one real conversation, captured
  /// verbatim: an assistant turn that spawns a background `writer`, then the
  /// server-initiated notification turn its completion wakes, which REPLAYS
  /// the child's `subagent_finished`. Every frame is driven through the
  /// reducer the way the socket drives it.
  @Test("a notification turn draws no second card for a child that already has one")
  func capturedNotificationTurnDrawsOneCard() throws {
    let frames = try capturedFrames("subagent-notification-frames.jsonl")
    // The capture's OWN conversation id: `reduceFrame` drops every frame for
    // another conversation, so a mismatched fixture would assert on nothing.
    var state = chatState(conversationID: "643362aa-97e0-4a2d-8f1f-1f9b7cdca560")
    for frame in frames {
      _ = ChatReducer.reduce(state: &state, action: .frame(frame))
    }
    // Two assistant messages, one child.
    #expect(state.messages.filter { $0.role == .assistant }.count == 2)
    let cards = state.messages.compactMap(\.assistant).flatMap(\.subagentCards)
    #expect(cards.map(\.id) == ["sub_01M21PVS839FQA3STD22Z2BNKM"])
    // A MERGE, not a suppression: the surviving card carries the terminal the
    // notification turn delivered, and is still anchored by its OWN start.
    #expect(cards.first?.status == .done)
    #expect(cards.first?.endedAt != nil)
    #expect(cards.first?.isOrphan == false)
    #expect(cards.first?.background == true)
  }

  /// The crash-reconcile case §31.4 / §32.8.4 exist for: when only the orphan
  /// terminal survives, it is the ONLY card anyone will ever draw and it keeps
  /// its own anchor.
  @Test("an orphan terminal with no earlier anchor still draws its own card")
  func capturedOrphanTerminalKeepsItsCard() throws {
    let frames = try capturedFrames("subagent-notification-frames.jsonl")
    // Cursor 11 so the notification turn's own `seq: 12` is the NEXT frame:
    // starting at 0 would trip the gap detector and park every frame.
    var state = chatState(cursor: 11, conversationID: "643362aa-97e0-4a2d-8f1f-1f9b7cdca560")
    // Everything from the notification turn's `accepted` onwards.
    guard
      let notificationStart = frames.firstIndex(where: { frame in
        if case let .accepted(_, _, _, _, _, _, origin, _, _) = frame { return origin != nil }
        return false
      })
    else {
      Issue.record("the capture has no notification accepted")
      return
    }
    for frame in frames[notificationStart...] {
      _ = ChatReducer.reduce(state: &state, action: .frame(frame))
    }
    let cards = state.messages.compactMap(\.assistant).flatMap(\.subagentCards)
    #expect(cards.map(\.id) == ["sub_01M21PVS839FQA3STD22Z2BNKM"])
    #expect(cards.first?.isOrphan == true)
  }

  private func capturedEvents(_ name: String) throws -> [AgentEvent] {
    let text = String(decoding: try FixtureLoader.data(name), as: UTF8.self)
    let decoder = ContractCoding.decoder()
    var turnID: String?
    var events: [AgentEvent] = []
    for line in text.split(whereSeparator: \.isNewline) where line.isEmpty == false {
      let frame = try decoder.decode(MobileWSServerFrame.self, from: Data(line.utf8))
      switch frame {
      case let .accepted(id, _, _, _, _, _, _, _, _):
        if turnID == nil { turnID = id }
      case let .event(id, _, _, event):
        if id == turnID { events.append(event) }
      default:
        continue
      }
    }
    return events
  }

  /// Every frame in a capture, in order — `accepted`/`event`/`done` alike, so
  /// a multi-TURN capture drives the reducer the way the socket does.
  private func capturedFrames(_ name: String) throws -> [MobileWSServerFrame] {
    let text = String(decoding: try FixtureLoader.data(name), as: UTF8.self)
    let decoder = ContractCoding.decoder()
    return try text.split(whereSeparator: \.isNewline)
      .filter { $0.isEmpty == false }
      .map { try decoder.decode(MobileWSServerFrame.self, from: Data($0.utf8)) }
  }

  private func foldCapture(_ name: String) throws -> [SubagentCardState] {
    foldEvents(try capturedEvents(name))
  }

  private func foldEvents(_ events: [AgentEvent]) -> [SubagentCardState] {
    var state = acceptedState(cursor: 1)
    for (offset, event) in events.enumerated() {
      _ = apply(event, seq: offset + 2, to: &state)
    }
    return state.messages.last?.assistant?.subagentCards ?? []
  }
}
