import Foundation
import Testing

@testable import Dash

/// Task D5 — the keyed `ChatState.subagentUI` slice and its writers, the child
/// frame route, and the §8.1–§8.3 view helpers.
///
/// A `DashTests` unit suite. It was called `SubagentUITests.swift` and the
/// name was defended in this comment — in a repo where `DashUITests` is a real
/// target in a different scheme (`DashUI`), that is a name a reader has to be
/// talked out of. The UI-level cover really does live in
/// `DashUITests/ConversationUITests.swift`.
@Suite("Sub-agent rows: slice, child frames, chrome")
struct SubagentSliceTests {

  // MARK: - Task D6: the tasks-sheet row (§8.4)

  @Test("a wire status this build has never heard of counts as LIVE, exactly as it does on web")
  func unknownWireStatusReadsAsLive() {
    #expect(SubagentCardStatus(wire: "running") == .running)
    #expect(SubagentCardStatus(wire: "waiting_input") == .waiting)
    #expect(SubagentCardStatus(wire: "max_turns") == .maxTurns)
    #expect(SubagentCardStatus(wire: "cancelled") == .cancelled)
    // Web's `rowStatusOf` passes an unrecognised string straight through and
    // `isTerminalSubagentStatus` answers false for it. Reading it as terminal
    // instead would hide a still-running child from §8.4's badge and from Stop,
    // which is the worse of the two failures.
    #expect(SubagentCardStatus(wire: "hibernating") == .running)
    #expect(SubagentCardStatus(wire: "hibernating").isTerminal == false)
  }

  @Test("a terminal child with no endedAt shows no elapsed at all, never its own age")
  func terminalRowWithNoEndedAtHasNoElapsed() {
    let started = Date(timeIntervalSince1970: 1_000)
    #expect(subagentFrozenElapsedMs(startedAt: started, endedAt: nil) == nil)
    #expect(subagentFrozenElapsedMs(startedAt: nil, endedAt: started) == nil)
    #expect(
      subagentFrozenElapsedMs(startedAt: started, endedAt: started.addingTimeInterval(72)) == 72_000
    )
    // A clock that went backwards clamps rather than rendering a negative run.
    #expect(
      subagentFrozenElapsedMs(startedAt: started, endedAt: started.addingTimeInterval(-5)) == 0
    )
    // And the meta line omits elapsed entirely rather than leaving a separator.
    #expect(SubagentFormat.meta(toolCallCount: 3, elapsedMs: nil) == "3 tool uses")
  }

  @Test("a sheet row offers Stop only while the child is live, and Resume unless it is a spent one-shot")
  func sheetRowAffordances() {
    let running = SubagentTaskRow(listEntry(status: "running"))
    #expect(running.canStop)
    #expect(running.canResume)
    #expect(running.accessibilityName == "Agent researcher, Running")

    // The route answers 409 for a terminal child, deliberately, so offering
    // Stop there would be offering a refusal.
    let done = SubagentTaskRow(listEntry(status: "done"))
    #expect(done.canStop == false)
    #expect(done.accessibilityName == "Agent researcher, Completed")

    // A one-shot child can be ANSWERED but not steered: `coordinator.sendToChild`
    // exempts a live child parked on a question and refuses everything else.
    #expect(SubagentTaskRow(listEntry(status: "running", oneShot: true)).canResume == false)
    #expect(SubagentTaskRow(listEntry(status: "waiting_input", oneShot: true)).canResume)

    // An empty `subagentType` reads as `agent`, the same fallback the
    // transcript row's header applies.
    #expect(SubagentTaskRow(listEntry(status: "running", type: "")).type == "agent")
  }

  private func listEntry(
    status: String,
    type: String = "researcher",
    oneShot: Bool = false
  ) -> SubagentListEntryDTO {
    SubagentListEntryDTO(
      id: "child-1",
      name: nil,
      type: type,
      description: "Look around",
      status: status,
      background: true,
      depth: 1,
      startedAt: Date(timeIntervalSince1970: 1_000),
      endedAt: nil,
      usage: nil,
      toolCallCount: 3,
      report: nil,
      oneShot: oneShot
    )
  }

  // MARK: - Ruling 2: the slice survives what the card could not

  @Test(
    """
    expansion, a fetched child transcript and oneShot survive a whole-transcript \
    re-projection — the reason D4 kept them off the card
    """
  )
  func sliceSurvivesReprojection() {
    var state = chatState()
    apply(&state, .subagentExpanded(id: "child-1", isExpanded: true, opensTranscript: true))
    apply(&state, .subagentInfoLoaded(id: "child-1", oneShot: true))
    apply(
      &state,
      .subagentTranscriptLoaded(
        id: "child-1",
        messages: [childMessage(id: "c-1", ordinal: 1, text: "Look at the logs")]
      )
    )

    // The exact action that destroys anything folded onto a message
    // (`ChatReducer:407` replaces `state.messages` wholesale) — dispatched
    // from three sites in `ChatFeature`, including the post-reconnect
    // canonical snapshot, so this is a routine refresh and not an exotic one.
    apply(&state, .cachedMessagesLoaded([], cursor: 4))

    #expect(state.subagentUI["child-1"]?.isExpanded == true)
    #expect(state.subagentUI["child-1"]?.oneShot == true)
    #expect(state.subagentUI["child-1"]?.childMessages?.count == 1)
  }

  @Test("collapsing keeps the fetched transcript rather than blanking the body")
  func collapseKeepsTranscript() {
    var state = chatState()
    apply(&state, .subagentExpanded(id: "child-1", isExpanded: true, opensTranscript: true))
    apply(
      &state,
      .subagentTranscriptLoaded(
        id: "child-1",
        messages: [childMessage(id: "c-1", ordinal: 1, text: "Look at the logs")]
      )
    )

    apply(&state, .subagentExpanded(id: "child-1", isExpanded: false, opensTranscript: true))

    #expect(state.subagentUI["child-1"]?.isExpanded == false)
    #expect(state.subagentUI["child-1"]?.childMessages?.count == 1)
  }

  // MARK: - Child frames

  @Test(
    """
    a child's accepted lands in that child's slice and touches neither the \
    parent transcript nor its sequence cursor
    """
  )
  func childAcceptedDoesNotDisturbTheParent() {
    var state = chatState(cursor: 7)
    apply(&state, .subagentExpanded(id: "child-1", isExpanded: true, opensTranscript: true))
    apply(&state, .subagentTranscriptLoaded(id: "child-1", messages: []))

    let effects = ChatReducer.reduce(
      state: &state,
      action: .frame(
        .accepted(
          id: "child-turn",
          conversationId: "child-1",
          userMessageId: "child-user",
          assistantMessageId: "child-assistant",
          revision: 3,
          // A child's `seq` counts in ITS OWN conversation. Letting one
          // through the parent path would advance `lastAppliedSeq` past 7,
          // wedge the gap detector and request a bogus replay.
          seq: 1,
          origin: .parent,
          kind: .subagent,
          requestId: nil
        )
      )
    )

    #expect(state.messages.isEmpty)
    #expect(state.lastAppliedSeq == 7)
    #expect(state.activeTurnID == nil)
    #expect(state.pendingGapFrame == nil)
    #expect(effects.isEmpty)
    #expect(
      state.subagentUI["child-1"]?.childMessages?.map(\.id) == ["child-user", "child-assistant"]
    )
  }

  @Test("a frame for a conversation that is neither the parent nor a known child is dropped")
  func unknownConversationFrameIsDropped() {
    var state = chatState(cursor: 7)

    _ = ChatReducer.reduce(
      state: &state,
      action: .frame(.event(id: "t", conversationId: "somebody-else", seq: 1, event: .textDelta(text: "hi")))
    )

    #expect(state.messages.isEmpty)
    #expect(state.subagentUI.isEmpty)
    #expect(state.lastAppliedSeq == 7)
  }

  @Test(
    """
    a child frame for a row whose transcript was never fetched is ignored — \
    materialising rows there would build a transcript with a hole in it
    """
  )
  func childFrameWithoutAFetchedTranscriptIsIgnored() {
    var state = chatState()
    apply(&state, .subagentExpanded(id: "child-1", isExpanded: true, opensTranscript: true))

    _ = ChatReducer.reduce(
      state: &state,
      action: .frame(
        .event(id: "child-turn", conversationId: "child-1", seq: 1, event: .textDelta(text: "hi"))
      )
    )

    #expect(state.subagentUI["child-1"]?.childMessages == nil)
  }

  @Test("a child's events and terminal frame project onto that child's own assistant row")
  func childEventsProjectOntoTheChild() {
    var state = chatState()
    apply(&state, .subagentExpanded(id: "child-1", isExpanded: true, opensTranscript: true))
    apply(&state, .subagentTranscriptLoaded(id: "child-1", messages: []))

    for frame in [
      MobileWSServerFrame.event(
        id: "child-turn",
        conversationId: "child-1",
        seq: 1,
        event: .textDelta(text: "checking")
      ),
      .done(id: "child-turn", conversationId: "child-1", seq: 2, outcome: .completed),
    ] {
      _ = ChatReducer.reduce(state: &state, action: .frame(frame))
    }

    let rows = try? #require(state.subagentUI["child-1"]?.childMessages)
    #expect(rows?.count == 1)
    #expect(rows?.first?.assistant?.text == "checking")
    #expect(rows?.first?.assistant?.terminal == .completed)
    #expect(rows?.first?.status == .completed)
    // Still nothing in the parent's transcript.
    #expect(state.messages.isEmpty)
  }

  // MARK: - Ruling 1: the composer, correlated by requestId

  @Test("an optimistic reply is written only when the caller asks for one, and reads as parent-origin")
  func optimisticRowIsOptIn() {
    var state = chatState()
    apply(&state, .subagentExpanded(id: "child-1", isExpanded: true, opensTranscript: true))
    apply(&state, .subagentTranscriptLoaded(id: "child-1", messages: []))

    apply(
      &state,
      .subagentReplyStarted(id: "child-1", requestID: "req-1", text: "keep going", optimistic: true)
    )
    apply(
      &state,
      .subagentReplyStarted(id: "child-1", requestID: "req-2", text: "quiet one", optimistic: false)
    )

    let rows = state.subagentUI["child-1"]?.childMessages ?? []
    #expect(rows.map(\.id) == ["req-1"])
    #expect(rows.first?.user?.text == "keep going")
    // §8.5: the gateway records a parent-authored turn on a child conversation
    // as `origin: parent` (`chat-accepted-subagent.json`), so the optimistic
    // row must say so too — otherwise it renders as a user bubble WITH
    // Retry/Edit for the moment before the echo lands.
    #expect(rows.first?.origin == .parent)
    #expect(state.subagentUI["child-1"]?.pendingRequestIDs == ["req-1"])
    #expect(state.subagentUI["child-1"]?.isSending == true)
  }

  @Test("the echoed requestId adopts the optimistic row instead of adding a second one")
  func acceptedAdoptsTheOptimisticRow() {
    var state = chatState()
    apply(&state, .subagentExpanded(id: "child-1", isExpanded: true, opensTranscript: true))
    apply(&state, .subagentTranscriptLoaded(id: "child-1", messages: []))
    apply(
      &state,
      .subagentReplyStarted(id: "child-1", requestID: "req-1", text: "keep going", optimistic: true)
    )

    _ = ChatReducer.reduce(
      state: &state,
      action: .frame(
        .accepted(
          id: "child-turn",
          conversationId: "child-1",
          userMessageId: "server-user",
          assistantMessageId: "server-assistant",
          revision: 3,
          seq: 1,
          origin: .parent,
          kind: .subagent,
          requestId: "req-1"
        )
      )
    )

    let rows = state.subagentUI["child-1"]?.childMessages ?? []
    #expect(rows.map(\.id) == ["server-user", "server-assistant"])
    // The user's own sentence survives adoption: the `accepted` frame carries
    // no text, so taking the server row wholesale would blank it for the whole
    // child turn.
    #expect(rows.first?.user?.text == "keep going")
    #expect(state.subagentUI["child-1"]?.pendingRequestIDs.isEmpty == true)
  }

  @Test(
    """
    an accepted with NO requestId does not adopt a pending row — an older \
    gateway echoes nothing and a positional guess would mis-pair
    """
  )
  func acceptedWithoutARequestIdDoesNotAdopt() {
    var state = chatState()
    apply(&state, .subagentExpanded(id: "child-1", isExpanded: true, opensTranscript: true))
    apply(&state, .subagentTranscriptLoaded(id: "child-1", messages: []))
    apply(
      &state,
      .subagentReplyStarted(id: "child-1", requestID: "req-1", text: "keep going", optimistic: true)
    )

    _ = ChatReducer.reduce(
      state: &state,
      action: .frame(
        .accepted(
          id: "child-turn",
          conversationId: "child-1",
          userMessageId: "server-user",
          assistantMessageId: "server-assistant",
          revision: 3,
          seq: 1,
          origin: .parent,
          kind: .subagent,
          requestId: nil
        )
      )
    )

    let rows = state.subagentUI["child-1"]?.childMessages ?? []
    #expect(rows.map(\.id) == ["req-1", "server-user", "server-assistant"])
    #expect(state.subagentUI["child-1"]?.pendingRequestIDs == ["req-1"])
  }

  @Test(
    """
    a failure that lands AFTER the accepted already adopted the row leaves the     adopted row alone — the turn really started
    """
  )
  func aLateFailureCannotWithdrawAnAdoptedRow() {
    var state = chatState()
    apply(&state, .subagentExpanded(id: "child-1", isExpanded: true, opensTranscript: true))
    apply(&state, .subagentTranscriptLoaded(id: "child-1", messages: []))
    apply(
      &state,
      .subagentReplyStarted(id: "child-1", requestID: "req-1", text: "keep going", optimistic: true)
    )
    _ = ChatReducer.reduce(
      state: &state,
      action: .frame(
        .accepted(
          id: "child-turn",
          conversationId: "child-1",
          userMessageId: "server-user",
          assistantMessageId: "server-assistant",
          revision: 3,
          seq: 1,
          origin: .parent,
          kind: .subagent,
          requestId: "req-1"
        )
      )
    )

    // The server processed the resume and its response was lost. Withdrawal is
    // keyed on the row still being PENDING, and adoption already cleared that,
    // so the row survives — which is right, because the turn is real.
    apply(
      &state,
      .subagentReplyFailed(id: "child-1", requestID: "req-1", message: "The request timed out")
    )

    #expect(state.subagentUI["child-1"]?.childMessages?.map(\.id)
      == ["server-user", "server-assistant"])
    #expect(state.subagentUI["child-1"]?.lastError == "The request timed out")
  }

  @Test(
    """
    a failed transcript READ reports on the row without disarming an in-flight     send — a different action from a failed reply, deliberately
    """
  )
  func aFailedReadDoesNotDisarmASend() {
    var state = chatState()
    apply(&state, .subagentExpanded(id: "child-1", isExpanded: true, opensTranscript: true))
    apply(
      &state,
      .subagentReplyStarted(id: "child-1", requestID: "req-1", text: "keep going", optimistic: false)
    )

    apply(
      &state,
      .subagentTranscriptFailed(id: "child-1", message: "This agent is no longer available.")
    )

    #expect(state.subagentUI["child-1"]?.lastError == "This agent is no longer available.")
    #expect(state.subagentUI["child-1"]?.isSending == true)
  }

  @Test("a refused reply drops its optimistic row and keeps the gateway's own text")
  func refusalDropsTheRowAndKeepsTheReason() {
    var state = chatState()
    apply(&state, .subagentExpanded(id: "child-1", isExpanded: true, opensTranscript: true))
    apply(&state, .subagentTranscriptLoaded(id: "child-1", messages: []))
    apply(
      &state,
      .subagentReplyStarted(id: "child-1", requestID: "req-1", text: "keep going", optimistic: true)
    )

    apply(
      &state,
      .subagentReplyFailed(
        id: "child-1",
        requestID: "req-1",
        message: "One-shot agents cannot be resumed"
      )
    )

    #expect(state.subagentUI["child-1"]?.childMessages?.isEmpty == true)
    #expect(state.subagentUI["child-1"]?.pendingRequestIDs.isEmpty == true)
    #expect(state.subagentUI["child-1"]?.isSending == false)
    #expect(state.subagentUI["child-1"]?.lastError == "One-shot agents cannot be resumed")
  }

  @Test("the next attempt clears the previous refusal, so a stale reason cannot read as a new one")
  func attemptClearsThePreviousError() {
    var state = chatState()
    apply(&state, .subagentExpanded(id: "child-1", isExpanded: true, opensTranscript: true))
    apply(&state, .subagentReplyFailed(id: "child-1", requestID: "req-0", message: "Steer cap"))

    apply(
      &state,
      .subagentReplyStarted(id: "child-1", requestID: "req-1", text: "again", optimistic: false)
    )

    #expect(state.subagentUI["child-1"]?.lastError == nil)
  }

  @Test("a REST page merges under an in-flight optimistic row rather than replacing it")
  func transcriptLoadKeepsLiveRows() {
    var state = chatState()
    apply(&state, .subagentExpanded(id: "child-1", isExpanded: true, opensTranscript: true))
    apply(&state, .subagentTranscriptLoaded(id: "child-1", messages: []))
    apply(
      &state,
      .subagentReplyStarted(id: "child-1", requestID: "req-1", text: "keep going", optimistic: true)
    )

    // A refresh whose snapshot predates the optimistic row.
    apply(
      &state,
      .subagentTranscriptLoaded(
        id: "child-1",
        messages: [childMessage(id: "c-1", ordinal: 1, text: "Look at the logs")]
      )
    )

    #expect(state.subagentUI["child-1"]?.childMessages?.map(\.id) == ["c-1", "req-1"])
  }

  // MARK: - §8.2 clustering

  @Test("adjacent rows cluster and a non-adjacent row starts a new cluster")
  func clusteringSplitsOnAdjacency() {
    let cards = [
      card(id: "a", adjacent: false),
      card(id: "b", adjacent: true),
      card(id: "c", adjacent: false),
      card(id: "d", adjacent: true),
    ]

    let clusters = subagentClusters(cards)

    #expect(clusters.map { $0.map(\.id) } == [["a", "b"], ["c", "d"]])
  }

  @Test("a lone row is a cluster of one, and an empty fold produces no clusters")
  func clusteringEdges() {
    #expect(subagentClusters([]).isEmpty)
    #expect(subagentClusters([card(id: "a", adjacent: false)]).map { $0.map(\.id) } == [["a"]])
    // Defensive: the fold never marks the FIRST row adjacent, but a row that
    // claims adjacency with nothing before it must not crash or vanish.
    #expect(subagentClusters([card(id: "a", adjacent: true)]).map { $0.map(\.id) } == [["a"]])
  }

  // MARK: - Ruling 4: nesting depth

  @Test(
    """
    a row in the orchestrator's transcript opens its child; a row INSIDE a     child does not — depth 1, matching web's MAX_SUBAGENT_DEPTH
    """
  )
  func nestingStopsAtDepthOne() {
    #expect(maxSubagentDepth == 1)
    #expect(subagentRowIsNested(depth: 0))
    #expect(subagentRowIsNested(depth: 1) == false)
    #expect(subagentRowIsNested(depth: 2) == false)
    // A recorded divergence from §8.3's "unlimited by the renderer": every
    // level costs a live subscription and a REST read, an unbounded renderer
    // recurses on server-controlled data, and a doubly-indented transcript is
    // unreadable on a phone. The row is still drawn at the cap — only its body
    // is replaced, with copy byte-identical to web's.
    #expect(subagentDeadEndCopy == "Nested agents this deep are not opened here.")
    #expect(oneShotComposerTitle == "One-shot agents cannot be resumed")
  }

  // MARK: - §8.1/§8.2 formatting

  @Test("the meta line joins tool count and elapsed, and omits elapsed when it is unknown")
  func metaFormatting() {
    #expect(SubagentFormat.meta(toolCallCount: 3, elapsedMs: 72000) == "3 tool uses · 1m 12s")
    #expect(SubagentFormat.meta(toolCallCount: 1, elapsedMs: nil) == "1 tool use")
  }

  @Test("the cluster summary counts by status in a fixed order and omits empty buckets")
  func clusterSummaryFormatting() {
    #expect(
      SubagentFormat.clusterSummary([.done, .running, .running]) == "3 agents · 2 running · 1 done"
    )
    #expect(SubagentFormat.clusterSummary([.maxTurns]) == "1 agent · 1 max turns")
    #expect(SubagentFormat.clusterSummary([]) == "0 agents")
  }

  // MARK: - Helpers

  private func apply(_ state: inout ChatState, _ action: ChatAction) {
    _ = ChatReducer.reduce(state: &state, action: action)
  }

  private func card(id: String, adjacent: Bool) -> SubagentCardState {
    SubagentCardState(
      id: id,
      name: nil,
      type: "researcher",
      description: "",
      status: .running,
      background: false,
      depth: 1,
      startedAt: nil,
      endedAt: nil,
      toolCallCount: 0,
      detail: nil,
      question: nil,
      report: nil,
      usage: nil,
      isOrphan: false,
      isAdjacentToPrevious: adjacent
    )
  }

  private func childMessage(id: String, ordinal: Int, text: String) -> ConversationMessageDTO {
    ConversationMessageDTO(
      id: id,
      conversationId: "child-1",
      turnId: "child-turn-\(ordinal)",
      ordinal: ordinal,
      role: .user,
      status: .completed,
      content: .user(text: text, images: nil),
      createdAt: Date(timeIntervalSince1970: TimeInterval(ordinal)),
      updatedAt: Date(timeIntervalSince1970: TimeInterval(ordinal)),
      origin: MessageOrigin.parent.rawValue
    )
  }

  private func chatState(cursor: Int = 0) -> ChatState {
    ChatState(
      conversation: ConversationSummaryDTO(
        id: "conv-1",
        agentId: "agent-1",
        agentName: "Agent",
        title: "Chat",
        revision: 1,
        status: .idle,
        activeTurnId: nil,
        owningIssueId: nil,
        projectId: nil,
        lastSeq: cursor,
        lastMessagePreview: nil,
        createdAt: Date(timeIntervalSince1970: 0),
        updatedAt: Date(timeIntervalSince1970: 0),
        deletedAt: nil
      ),
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
}
