import Foundation

struct ChatState: Equatable, Sendable {
  var conversation: ConversationSummaryDTO
  var messages: [ChatMessageState]
  var draft: String
  var attachments: [PreparedAttachment]
  var transport: ChatTransportState
  var lastAppliedSeq: Int
  var activeTurnID: String?
  var pendingGapFrame: MobileWSServerFrame?
  var isLoadingOlder: Bool
  var olderCursor: String?
  var composerBlock: ComposerBlockReason?
  var errorBanner: String?

  /// The gateway's own default conversation title
  /// (`apps/gateway/src/conversation-service.ts`'s `DEFAULT_CONVERSATION_TITLE`,
  /// mirrored here rather than shared cross-language) — `create(agentID:)`
  /// (`ConversationListFeature.swift`) always passes `title: nil`, so a
  /// still-unrenamed compose-created conversation carries exactly this
  /// title.
  static let defaultConversationTitle = "New Conversation"

  /// Final-review fix C2: the single choke point `ChatView`'s `onDisappear`
  /// consults before letting `discardIfUnusedComposeCreation` silently
  /// delete a compose-created conversation the user is backing out of.
  /// Originally only checked `messages`/`activeTurnID` — extended to also
  /// count a non-empty (trimmed) draft, any staged attachment, and a title
  /// that's no longer the gateway's default: each is real user work (an
  /// unsent draft, staged photos, an explicit rename via the header/toolbar,
  /// all reachable before a first message ever sends) that a background
  /// cleanup the user has no visibility into must never discard.
  var hasComposeActivity: Bool {
    messages.isEmpty == false
      || activeTurnID != nil
      || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
      || attachments.isEmpty == false
      || conversation.title != ChatState.defaultConversationTitle
  }
}

enum ChatAction: Sendable {
  case cachedMessagesLoaded([ConversationMessageDTO], cursor: Int)
  case olderMessagesLoaded([ConversationMessageDTO], nextCursor: String?)
  case sendStarted(turnID: String, localUserID: String, text: String, images: [MessageImage])
  case sendRejected(turnID: String)
  case frame(MobileWSServerFrame)
  case replayLoaded([ReplayEntryDTO])
  case transportChanged(ChatTransportState)
  case answerSubmitted(questionID: String, answer: String)
  case cancelRequested
  case authoritativeSummary(ConversationSummaryDTO)
  case failure(GatewayError)
}

enum ChatEffect: Equatable, Sendable {
  case persistCursor(Int)
  case requestReplay(sinceSeq: Int)
  case refreshTranscript
  case announceFinalResponse(String)
  case showRepair
  case showRetryCountdown(Date)
}

enum ComposerBlockReason: Equatable, Sendable {
  case remoteActiveTurn(String)
  case repairRequired
  case updateRequired
}

struct ChatMessageState: Equatable, Identifiable, Sendable {
  var id: String
  let turnID: String
  var ordinal: Int?
  let role: MessageRole
  var status: MessageStatus
  var user: UserMessageProjection?
  var assistant: AssistantMessageProjection?
  /// Who caused this turn (sub-agents design 7.6). `nil` means UNKNOWN, which
  /// renders exactly like `.user`: a replayed `accepted` carries no origin at
  /// all, and an older gateway never sends one. A `.notification`/`.parent`
  /// user row renders as a compact system row instead of a bubble (8.5).
  var origin: MessageOrigin?
}

struct UserMessageProjection: Equatable, Sendable {
  var text: String
  var images: [MessageImage]
}

struct AssistantMessageProjection: Equatable, Sendable {
  var text = ""
  var thinking = ""
  // MC parity (design doc appendix §4): thinking is collapsed by default,
  // and — unlike the pre-MC-parity behavior — never auto-expands while
  // thinking streams in. Only an explicit user tap on the "Show
  // thinking"/"Hide thinking" toggle (`ThinkingView`) changes visibility.
  var isThinkingCollapsed = true
  var toolCards: [ToolCardState] = []
  /// Per-child accumulators for the sub-agent fold. Deliberately NOT the
  /// rendered rows: precedence between the canonical `subagent_*` family and
  /// the legacy `worker_*` mirrors is resolved at read time (`subagentCards`),
  /// which is what makes it independent of arrival order, and end-of-stream
  /// terminalization is a function of `terminal` — a value that is written
  /// AFTER the fold loop runs in `projectMessage`.
  fileprivate(set) var subagentDrafts: [SubagentDraft] = []
  /// How many events have been projected onto this message, and how many of
  /// those were not sub-agent chrome. Bookkeeping for the fold: the first
  /// gives each row a stable anchor position, the second is what §8.2's
  /// adjacency ("nothing but sub-agent chrome between two spawns") is measured
  /// against without keeping the whole event list around.
  fileprivate(set) var projectedEventCount = 0
  fileprivate(set) var nonChromeEventCount = 0
  var statusRows: [StatusRowState] = []
  var pendingQuestion: QuestionState?
  var usage: UsageDTO?
  var terminal: ChatTerminalState?
  var hasAnnouncedTerminal = false

  /// True when nothing in this projection would render any visible content
  /// — the window between the `accepted` WS FRAME (which creates an empty
  /// projection, `ChatReducer.reconcileAccepted`) and the first populating
  /// `event` frame. Today that window renders as an empty area (chat-ux
  /// Phase 2, audit #6); `EventViews.swift`'s `TypingIndicatorView` uses this
  /// — together with `status == .streaming`, NOT `.accepted` — to fill it
  /// with a 3-dot pulse instead. `.accepted` the `MessageStatus` is never
  /// assigned to an assistant message at all: `reconcileAccepted` sets the
  /// assistant row straight to `.streaming` the instant the `accepted` frame
  /// lands (`.accepted` only ever describes the USER message). `usage` is
  /// deliberately excluded from this check — chrome trim (audit #17) stopped
  /// rendering it per-turn, so its presence no longer corresponds to
  /// anything visible.
  var isEmpty: Bool {
    thinking.isEmpty && text.isEmpty && toolCards.isEmpty && subagentDrafts.isEmpty
      && statusRows.isEmpty && pendingQuestion == nil && terminal == nil
  }

  /// The collapsed sub-agent rows (§8.1), one per child, in anchor order.
  ///
  /// Computed rather than stored so that every terminal path — `done`,
  /// `error`, and each of `projectMessage`'s four message statuses — gets
  /// end-of-stream terminalization, the `background` exemption and the
  /// question gate for free, without any of them having to remember to
  /// re-fold. `terminal == nil` IS the parent turn's liveness, the iOS twin of
  /// web's `isStreaming` argument.
  var subagentCards: [SubagentCardState] {
    let isStreaming = terminal == nil
    let ordered = subagentDrafts.sorted { $0.anchorIndex < $1.anchorIndex }
    return ordered.enumerated().map { index, draft in
      draft.resolve(isStreaming: isStreaming, previous: index > 0 ? ordered[index - 1] : nil)
    }
  }
}

enum ToolCardStatus: Equatable, Sendable {
  case running
  case succeeded
  case failed
}

struct ToolCardState: Equatable, Identifiable, Sendable {
  let id: String
  var name: String
  var input: JSONValue?
  var partialJSON: String
  var status: ToolCardStatus
  var content: String?
  var details: JSONValue?
}

/// Coalesced lifecycle state for one child, as the collapsed row renders it
/// (sub-agents design §8.1). The iOS twin of web's `SubagentStatus` in
/// `apps/web/src/ui/blocks/subagents.ts`; the wire's `waiting_input` is
/// `waiting` here, exactly as it is there.
enum SubagentCardStatus: Equatable, Hashable, Sendable {
  case running
  case waiting
  case done
  case failed
  case cancelled
  case interrupted
  case maxTurns

  /// True when the child has finished, whatever the outcome. All five terminal
  /// outcomes count — §8.1 gives all five a finished glyph, and this is the
  /// ONE predicate, so nothing can grow a second list that has never heard of
  /// `interrupted` or `max_turns`.
  var isTerminal: Bool {
    switch self {
    case .running, .waiting: false
    case .done, .failed, .cancelled, .interrupted, .maxTurns: true
    }
  }

  init(_ status: SubagentTerminalStatus) {
    switch status {
    case .done: self = .done
    case .failed: self = .failed
    case .cancelled: self = .cancelled
    case .interrupted: self = .interrupted
    case .maxTurns: self = .maxTurns
    }
  }

  init(_ status: SubagentLiveStatus) {
    switch status {
    case .running: self = .running
    case .waitingInput: self = .waiting
    }
  }
}

/// Everything the collapsed row (§8.1) needs for one child, folded from every
/// event in a single assistant message that names it.
///
/// **Expansion state, the loaded child transcript and `oneShot` are
/// deliberately NOT here.** `ChatReducer` re-projects whole messages from
/// scratch on `cachedMessagesLoaded` and `olderMessagesLoaded`, so anything
/// hung off a folded card is destroyed by the next transcript refresh — that
/// is web's D2 CRITICAL 1 in iOS form, and web's fix was to hoist exactly
/// those into a store slice keyed by the child id (later D3's single
/// `subagentUi`). D5 adds the iOS equivalent on `ChatState` when it adds the
/// writers; do not move them onto this struct.
struct SubagentCardState: Equatable, Identifiable, Sendable {
  /// The child's conversation id — also its legacy `workerId`. One id, one
  /// row: `subagentId === workerId === childConversationId`
  /// (`coordinator.ts:499-510`, `child-handle.ts:169`), so a child emitting
  /// BOTH families can never produce two rows.
  let id: String
  /// Optional human name from the `agent` tool call.
  var name: String?
  /// `subagentType`, or a legacy-only child's `role`.
  var type: String
  /// One-line description, or a legacy-only child's `brief`.
  var description: String
  var status: SubagentCardStatus
  /// True when the child was spawned to outlive the turn.
  var background: Bool
  /// 1 for a child of a user conversation.
  var depth: Int
  /// `nil` for a legacy-only child: `worker_*` carries no timestamps at all.
  /// Moot once D8 removes the mirrors.
  var startedAt: Date?
  /// Present only once a terminal event has arrived. A terminal row with no
  /// `endedAt` must render NOTHING for elapsed, never the row's own age.
  var endedAt: Date?
  var toolCallCount: Int
  /// One-line detail for the collapsed row: newest question, else newest
  /// detail, else the kickoff description (MC's `latestWorkerDetail`).
  var detail: String?
  /// The pending question, present only while the row is NOT terminal — §8.1
  /// hangs the inline reply affordance off this field. The text survives in
  /// `detail` as the last thing the child said.
  var question: String?
  var report: String?
  var usage: UsageDTO?
  /// True when no start event for this child appeared in THIS message —
  /// crash-reconcile can split one child across two persisted messages.
  var isOrphan: Bool
  /// True when this row's start event is adjacent to the previous row's in the
  /// same message (§8.2's parallel group). Computed in the fold because it
  /// needs the event stream, which the card list does not carry; orphans never
  /// join a cluster.
  var isAdjacentToPrevious: Bool
}

/// Per-family accumulator for one child, before precedence is resolved.
///
/// Keeping the two families in separate slots — rather than last-writer-wins —
/// is what makes precedence order-independent: the `subagent_*` slot is
/// preferred at resolve time no matter which family arrived first. Today the
/// gateway emits `worker_spawned` immediately before `subagent_started` and
/// `worker_done` immediately before `subagent_finished`, but the fold does not
/// depend on that staying true.
struct SubagentDraft: Equatable, Sendable {
  let subagentID: String
  /// Position of this row's start event (or, for an orphan, of the first event
  /// that named the child). Rows render in this order.
  var anchorIndex: Int
  /// Non-chrome events seen before the anchor. Two anchors with the same rank
  /// have only sub-agent chrome between them.
  var chromeRank: Int
  var hasStart = false
  var isOrphan = true
  /// Once the canonical family reports progress the `worker_status` mirror is
  /// ignored WHOLESALE. A per-field `modern ?? legacy` is not enough, because
  /// `question` is deliberately cleared by a running progress event and an
  /// absent modern value would let a stale mirrored question leak back onto a
  /// row that is running again.
  var sawModernProgress = false
  var name: String?
  var modernType: String?
  var legacyType: String?
  var modernDescription: String?
  var legacyDescription: String?
  var background: Bool?
  var depth: Int?
  var startedAt: Date?
  var endedAt: Date?
  var modernTerminal: SubagentCardStatus?
  var legacyTerminal: SubagentCardStatus?
  var modernReport: String?
  var legacyReport: String?
  var modernLive: SubagentCardStatus?
  var legacyLive: SubagentCardStatus?
  var modernDetail: String?
  var legacyDetail: String?
  var modernQuestion: String?
  var legacyQuestion: String?
  var modernUsage: UsageDTO?
  var legacyUsage: UsageDTO?
  var progressToolCallCount: Int?
  var finishedToolCallCount: Int?

  func resolve(isStreaming: Bool, previous: SubagentDraft?) -> SubagentCardState {
    let description = modernDescription ?? legacyDescription ?? ""
    let terminal = modernTerminal ?? legacyTerminal
    // The progress slots resolve as a UNIT, not field by field — see
    // `sawModernProgress`.
    let live = sawModernProgress ? modernLive : legacyLive
    let question = sawModernProgress ? modernQuestion : legacyQuestion
    let latestDetail = sawModernProgress ? modernDetail : legacyDetail
    let isBackground = background ?? false
    // End-of-stream terminalization (MC's `deriveWorkerStatus`): the turn is
    // over and this child never reported back. The one exemption MC never
    // needed is `background`, which is spawned precisely to OUTLIVE the turn —
    // reporting `cancelled` there would draw a healthy agent as dead in every
    // finished message that ever spawned one.
    let status = terminal ?? ((isStreaming || isBackground) ? (live ?? .running) : .cancelled)

    return SubagentCardState(
      id: subagentID,
      name: name,
      type: modernType ?? legacyType ?? "",
      description: description,
      status: status,
      background: isBackground,
      depth: depth ?? 1,
      startedAt: startedAt,
      endedAt: endedAt,
      toolCallCount: finishedToolCallCount ?? progressToolCallCount ?? 0,
      detail: latestDetail ?? (description.isEmpty ? nil : description),
      // Gated on the RESOLVED status, not on the presence of a terminal event:
      // end-of-stream terminalization reaches `cancelled` with no terminal
      // event at all, and a dead child must never carry a live reply
      // affordance.
      question: status.isTerminal ? nil : question,
      report: modernReport ?? legacyReport,
      usage: modernUsage ?? legacyUsage,
      isOrphan: isOrphan,
      isAdjacentToPrevious: previous.map {
        $0.isOrphan == false && isOrphan == false && $0.chromeRank == chromeRank
      } ?? false
    )
  }
}

struct QuestionState: Equatable, Identifiable, Sendable {
  let id: String
  let question: String
  let options: [String]
  var answer: String?
}

enum StatusRowKind: Equatable, Sendable {
  case agentError
  case filesChanged
  case agentSpawned
  case retry
  case contextCompacted
  case skillLoaded
  case skillCreated
  case mcpError
  case unknown
}

struct StatusRowState: Equatable, Identifiable, Sendable {
  let id: String
  let kind: StatusRowKind
  let title: String
  let detail: String?
  let unknownType: String?
}

enum ChatTerminalState: Equatable, Sendable {
  case completed
  case cancelled
  case failed(String)
  case interrupted
}

extension ChatTerminalState {
  /// Chrome trim (chat-ux Phase 2, audit #17): a successful turn needs no
  /// explaining — `TerminalView` is noise on every ordinary reply. Only the
  /// outcomes a user wouldn't otherwise notice (cancelled/failed/
  /// interrupted) are worth a row.
  var isChromeWorthy: Bool {
    self != .completed
  }
}

enum ChatReducer {
  static func reduce(state: inout ChatState, action: ChatAction) -> [ChatEffect] {
    switch action {
    case let .cachedMessagesLoaded(messages, cursor):
      state.messages = messages.sorted { $0.ordinal < $1.ordinal }.map(projectMessage)
      state.lastAppliedSeq = max(state.lastAppliedSeq, cursor)
      state.pendingGapFrame = nil
      return []

    case let .olderMessagesLoaded(messages, nextCursor):
      var byID = Dictionary(uniqueKeysWithValues: state.messages.map { ($0.id, $0) })
      for message in messages {
        byID[message.id] = projectMessage(message)
      }
      state.messages = byID.values.sorted(by: messageOrder)
      state.olderCursor = nextCursor
      state.isLoadingOlder = false
      return []

    case let .sendStarted(turnID, localUserID, text, images):
      if !state.messages.contains(where: { $0.turnID == turnID && $0.role == .user }) {
        state.messages.append(
          ChatMessageState(
            id: localUserID,
            turnID: turnID,
            ordinal: nil,
            role: .user,
            status: .streaming,
            user: UserMessageProjection(text: text, images: images),
            assistant: nil
          )
        )
      }
      state.activeTurnID = turnID
      state.composerBlock = nil
      state.errorBanner = nil
      return []

    case .sendRejected(let turnID):
      state.messages.removeAll { message in
        message.turnID == turnID && message.ordinal == nil
      }
      if state.activeTurnID == turnID {
        state.activeTurnID = nil
      }
      return []

    case let .frame(frame):
      return reduceFrame(frame, state: &state)

    case let .replayLoaded(entries):
      let scopedEntries = entries.filter { $0.conversationId == state.conversation.id }
      if !entries.isEmpty && scopedEntries.isEmpty { return [] }
      var effects: [ChatEffect] = []
      for entry in scopedEntries.sorted(by: { $0.seq < $1.seq }) {
        effects += reduceFrame(replayFrame(entry), state: &state)
        effects += consumePendingFrame(state: &state)
      }
      effects += consumePendingFrame(state: &state)
      return effects

    case let .transportChanged(transport):
      state.transport = transport
      return []

    case let .answerSubmitted(questionID, answer):
      for index in state.messages.indices {
        guard var assistant = state.messages[index].assistant else { continue }
        guard assistant.pendingQuestion?.id == questionID else { continue }
        assistant.pendingQuestion?.answer = answer
        state.messages[index].assistant = assistant
        break
      }
      return []

    case .cancelRequested:
      return []

    case let .authoritativeSummary(summary):
      let localTurnID = state.activeTurnID
      state.conversation = summary
      state.activeTurnID = summary.activeTurnId
      if let activeTurnID = summary.activeTurnId {
        if activeTurnID != localTurnID {
          state.composerBlock = .remoteActiveTurn(activeTurnID)
        }
      } else if case .remoteActiveTurn? = state.composerBlock {
        state.composerBlock = nil
      }
      return []

    case let .failure(error):
      return reduceFailure(error, state: &state)
    }
  }

  private static func reduceFrame(
    _ frame: MobileWSServerFrame,
    state: inout ChatState
  ) -> [ChatEffect] {
    guard frameBelongsToConversation(frame, state: state) else { return [] }
    guard let seq = sequence(of: frame) else {
      return apply(frame, state: &state)
    }
    guard seq > state.lastAppliedSeq else { return [] }
    guard seq == state.lastAppliedSeq + 1 else {
      if let pendingSequence = state.pendingGapFrame.flatMap(sequence(of:)) {
        if seq < pendingSequence {
          state.pendingGapFrame = frame
        }
      } else {
        state.pendingGapFrame = frame
      }
      return [.requestReplay(sinceSeq: state.lastAppliedSeq)]
    }

    var effects = apply(frame, state: &state)
    state.lastAppliedSeq = seq
    state.conversation = summary(
      from: state.conversation,
      revision: state.conversation.revision,
      status: state.conversation.status,
      activeTurnID: state.conversation.activeTurnId,
      lastSeq: seq
    )
    effects.insert(.persistCursor(seq), at: 0)
    return effects
  }

  private static func consumePendingFrame(state: inout ChatState) -> [ChatEffect] {
    guard let pending = state.pendingGapFrame, let seq = sequence(of: pending) else { return [] }
    if seq <= state.lastAppliedSeq {
      state.pendingGapFrame = nil
      return []
    }
    guard seq == state.lastAppliedSeq + 1 else { return [] }
    state.pendingGapFrame = nil
    return reduceFrame(pending, state: &state)
  }

  private static func apply(
    _ frame: MobileWSServerFrame,
    state: inout ChatState
  ) -> [ChatEffect] {
    switch frame {
    case let .accepted(id, _, userMessageID, assistantMessageID, revision, seq, origin, _, _):
      reconcileAccepted(
        turnID: id,
        userMessageID: userMessageID,
        assistantMessageID: assistantMessageID,
        origin: origin,
        state: &state
      )
      state.activeTurnID = id
      state.composerBlock = nil
      state.conversation = summary(
        from: state.conversation,
        revision: revision,
        status: .running,
        activeTurnID: id,
        lastSeq: seq
      )
      return []

    case let .event(id, _, _, event):
      let index = ensureAssistant(turnID: id, state: &state)
      var assistant = state.messages[index].assistant ?? AssistantMessageProjection()
      project(event, onto: &assistant)
      state.messages[index].assistant = assistant
      state.messages[index].status = .streaming
      return []

    case let .done(id, _, _, outcome):
      let index = ensureAssistant(turnID: id, state: &state)
      var assistant = state.messages[index].assistant ?? AssistantMessageProjection()
      let announcement: String
      switch outcome ?? .completed {
      case .completed:
        state.messages[index].status = .completed
        assistant.terminal = .completed
        announcement = assistant.text.isEmpty ? "Response complete" : assistant.text
      case .cancelled:
        state.messages[index].status = .cancelled
        assistant.terminal = .cancelled
        announcement = "Response cancelled"
      }
      assistant.isThinkingCollapsed = true
      assistant.pendingQuestion = nil
      let shouldAnnounce = !assistant.hasAnnouncedTerminal
      assistant.hasAnnouncedTerminal = true
      state.messages[index].assistant = assistant
      finishTurn(id, state: &state)
      return shouldAnnounce ? [.announceFinalResponse(announcement)] : []

    case let .error(id, _, _, error, code, _, activeTurnID):
      if code == "conversation_busy", let activeTurnID {
        state.messages.removeAll { message in
          message.turnID == id && message.role == .user && message.ordinal == nil
            && message.status == .streaming
        }
        state.activeTurnID = activeTurnID
        state.composerBlock = .remoteActiveTurn(activeTurnID)
        return []
      }

      let index = ensureAssistant(turnID: id, state: &state)
      var assistant = state.messages[index].assistant ?? AssistantMessageProjection()
      state.messages[index].status = .failed
      assistant.terminal = .failed(error)
      assistant.isThinkingCollapsed = true
      assistant.pendingQuestion = nil
      let shouldAnnounce = !assistant.hasAnnouncedTerminal
      assistant.hasAnnouncedTerminal = true
      state.messages[index].assistant = assistant
      state.errorBanner = error
      finishTurn(id, state: &state)
      return shouldAnnounce ? [.announceFinalResponse("Response failed: \(error)")] : []
    }
  }

  private static func reconcileAccepted(
    turnID: String,
    userMessageID: String,
    assistantMessageID: String,
    origin: MessageOrigin?,
    state: inout ChatState
  ) {
    // `origin` is only ever WRITTEN when the frame carried one. A replayed
    // `accepted` carries none at all (sub-agents design 7.6), so treating
    // absent as `.user` here would turn a known notification row back into a
    // user bubble the moment a replay ran over it.
    if let canonicalUser = state.messages.firstIndex(where: { $0.id == userMessageID }) {
      state.messages[canonicalUser].status = .accepted
      if let origin { state.messages[canonicalUser].origin = origin }
    } else if let optimisticUser = state.messages.firstIndex(where: {
      $0.turnID == turnID && $0.role == .user
    }) {
      state.messages[optimisticUser].id = userMessageID
      state.messages[optimisticUser].status = .accepted
      if let origin { state.messages[optimisticUser].origin = origin }
    } else {
      // A turn this client never started. With a non-user origin this is a
      // server-initiated turn (design 7.3): the row is a compact system row,
      // not the blank user bubble an empty projection used to render as, and
      // its text arrives with the next canonical refresh.
      state.messages.append(
        ChatMessageState(
          id: userMessageID,
          turnID: turnID,
          ordinal: nil,
          role: .user,
          status: .accepted,
          user: UserMessageProjection(text: "", images: []),
          assistant: nil,
          origin: origin
        )
      )
    }
    deduplicate(turnID: turnID, role: .user, keepingID: userMessageID, state: &state)

    if let canonicalAssistant = state.messages.firstIndex(where: { $0.id == assistantMessageID }) {
      state.messages[canonicalAssistant].status = .streaming
      if let origin { state.messages[canonicalAssistant].origin = origin }
    } else if let existingAssistant = state.messages.firstIndex(where: {
      $0.turnID == turnID && $0.role == .assistant
    }) {
      state.messages[existingAssistant].id = assistantMessageID
      state.messages[existingAssistant].status = .streaming
      if let origin { state.messages[existingAssistant].origin = origin }
    } else {
      state.messages.append(
        ChatMessageState(
          id: assistantMessageID,
          turnID: turnID,
          ordinal: nil,
          role: .assistant,
          status: .streaming,
          user: nil,
          assistant: AssistantMessageProjection(),
          origin: origin
        )
      )
    }
    deduplicate(
      turnID: turnID,
      role: .assistant,
      keepingID: assistantMessageID,
      state: &state
    )
  }

  private static func deduplicate(
    turnID: String,
    role: MessageRole,
    keepingID: String,
    state: inout ChatState
  ) {
    var keptCanonical = false
    state.messages.removeAll { message in
      guard message.turnID == turnID, message.role == role else { return false }
      if message.id == keepingID, !keptCanonical {
        keptCanonical = true
        return false
      }
      return true
    }
  }

  private static func ensureAssistant(turnID: String, state: inout ChatState) -> Int {
    if let index = state.messages.firstIndex(where: {
      $0.turnID == turnID && $0.role == .assistant
    }) {
      return index
    }
    state.messages.append(
      ChatMessageState(
        id: "\(turnID)-assistant",
        turnID: turnID,
        ordinal: nil,
        role: .assistant,
        status: .streaming,
        user: nil,
        assistant: AssistantMessageProjection()
      )
    )
    return state.messages.index(before: state.messages.endIndex)
  }

  private static func project(_ event: AgentEvent, onto assistant: inout AssistantMessageProjection)
  {
    // Bookkeeping for the sub-agent fold. Every event gets a position (rows
    // render in anchor order) and every NON-chrome event bumps the rank that
    // §8.2 adjacency is measured against. Both counters advance before the
    // switch so a folded event's own rank is the count of content that
    // preceded it.
    let eventIndex = assistant.projectedEventCount
    assistant.projectedEventCount += 1
    if isSubagentChrome(event) == false {
      assistant.nonChromeEventCount += 1
    }

    switch event {
    case let .textDelta(text):
      assistant.text += text

    case let .thinkingDelta(text):
      assistant.thinking += text

    case let .toolUseStart(id, name, input):
      if let index = assistant.toolCards.firstIndex(where: { $0.id == id }) {
        assistant.toolCards[index].name = name
        assistant.toolCards[index].input = input
        assistant.toolCards[index].status = .running
      } else {
        assistant.toolCards.append(
          ToolCardState(
            id: id,
            name: name,
            input: input,
            partialJSON: "",
            status: .running,
            content: nil,
            details: nil
          )
        )
      }

    case let .toolUseDelta(partialJSON):
      if let index = assistant.toolCards.lastIndex(where: { $0.status == .running }) {
        assistant.toolCards[index].partialJSON += partialJSON
      } else {
        assistant.toolCards.append(
          ToolCardState(
            id: "partial-tool-\(assistant.toolCards.count)",
            name: "Tool",
            input: nil,
            partialJSON: partialJSON,
            status: .running,
            content: nil,
            details: nil
          )
        )
      }

    case let .toolResult(id, name, content, isError, details):
      if let index = assistant.toolCards.firstIndex(where: { $0.id == id }) {
        assistant.toolCards[index].name = name
        assistant.toolCards[index].content = content
        assistant.toolCards[index].details = details
        assistant.toolCards[index].status = isError ? .failed : .succeeded
      } else {
        assistant.toolCards.append(
          ToolCardState(
            id: id,
            name: name,
            input: nil,
            partialJSON: "",
            status: isError ? .failed : .succeeded,
            content: content,
            details: details
          )
        )
      }

    case let .response(content, usage):
      if assistant.text.isEmpty {
        assistant.text = content
      }
      assistant.usage = usage
      assistant.isThinkingCollapsed = true

    case let .error(error, _):
      appendStatus(
        kind: .agentError,
        title: "Agent error",
        detail: error,
        onto: &assistant
      )

    case let .fileChanged(files):
      appendStatus(
        kind: .filesChanged,
        title: files.count == 1 ? "File changed" : "Files changed",
        detail: files.joined(separator: ", "),
        onto: &assistant
      )

    case let .agentSpawned(name):
      appendStatus(
        kind: .agentSpawned,
        title: "Agent started",
        detail: name,
        onto: &assistant
      )

    // Legacy `worker_*` mirrors. They key on the SAME id as the canonical
    // family (a worker id is the child's conversation id), so both families
    // land on one card; `runId` is dropped because the canonical family has no
    // such concept. D8 removes these three branches with the mirrors.
    case let .workerSpawned(workerID, _, role, brief, _):
      upsertSubagent(id: workerID, at: eventIndex, isStart: true, onto: &assistant) { draft in
        draft.legacyType = nonEmpty(role) ?? draft.legacyType
        draft.legacyDescription = nonEmpty(brief) ?? draft.legacyDescription
      }

    case let .workerStatus(workerID, _, role, status, detail, question):
      upsertSubagent(id: workerID, at: eventIndex, isStart: false, onto: &assistant) { draft in
        draft.legacyLive = SubagentCardStatus(status)
        draft.legacyQuestion = nonEmpty(question)
        // Sticky, like MC's `latestWorkerDetail`: a later event with no detail
        // must not blank the line the row is already showing.
        draft.legacyDetail = nonEmpty(question) ?? nonEmpty(detail) ?? draft.legacyDetail
        draft.legacyType = nonEmpty(role) ?? draft.legacyType
      }

    case let .workerDone(workerID, _, role, status, report, usage):
      upsertSubagent(id: workerID, at: eventIndex, isStart: false, onto: &assistant) { draft in
        draft.legacyTerminal = SubagentCardStatus(status)
        draft.legacyReport = nonEmpty(report)
        draft.legacyType = nonEmpty(role) ?? draft.legacyType
        draft.legacyUsage = usage ?? draft.legacyUsage
      }

    case let .subagentStarted(
      subagentID, name, subagentType, description, _, _, background, depth, startedAt, _, _):
      upsertSubagent(id: subagentID, at: eventIndex, isStart: true, onto: &assistant) { draft in
        draft.name = nonEmpty(name) ?? draft.name
        draft.modernType = nonEmpty(subagentType) ?? draft.modernType
        draft.modernDescription = nonEmpty(description) ?? draft.modernDescription
        draft.background = background
        draft.depth = depth
        draft.startedAt = startedAt
      }

    case let .subagentProgress(subagentID, status, toolCallCount, _, detail, question):
      upsertSubagent(id: subagentID, at: eventIndex, isStart: false, onto: &assistant) { draft in
        draft.sawModernProgress = true
        draft.modernLive = SubagentCardStatus(status)
        draft.modernQuestion = nonEmpty(question)
        draft.modernDetail = nonEmpty(question) ?? nonEmpty(detail) ?? draft.modernDetail
        draft.progressToolCallCount = toolCallCount
        // `elapsedMs` is deliberately DISCARDED. It is a server-side stopwatch
        // sampled at most once a second and never replayed, so a row that read
        // it would freeze on reconnect and disagree with itself across a
        // refresh. Elapsed is derived from `startedAt`/`endedAt` instead — and
        // a legacy-only child, which has neither, renders nothing for it.
      }

    case let .subagentFinished(
      subagentID, name, subagentType, description, status, report, usage, toolCallCount, startedAt,
      endedAt):
      upsertSubagent(id: subagentID, at: eventIndex, isStart: false, onto: &assistant) { draft in
        draft.name = nonEmpty(name) ?? draft.name
        draft.modernType = nonEmpty(subagentType) ?? draft.modernType
        draft.modernDescription = nonEmpty(description) ?? draft.modernDescription
        draft.modernTerminal = SubagentCardStatus(status)
        draft.modernReport = nonEmpty(report)
        draft.finishedToolCallCount = toolCallCount
        draft.startedAt = startedAt
        draft.endedAt = endedAt
        draft.modernUsage = usage ?? draft.modernUsage
      }

    case let .agentRetry(attempt, reason):
      appendStatus(
        kind: .retry,
        title: "Retrying agent (attempt \(attempt))",
        detail: reason,
        onto: &assistant
      )

    case let .contextCompacted(overflow):
      appendStatus(
        kind: .contextCompacted,
        title: "Context compacted",
        detail: overflow ? "Compacted after context overflow" : "Conversation context reduced",
        onto: &assistant
      )

    case let .question(id, question, options):
      assistant.pendingQuestion = QuestionState(
        id: id,
        question: question,
        options: options,
        answer: nil
      )

    case let .skillLoaded(name):
      appendStatus(kind: .skillLoaded, title: "Skill loaded", detail: name, onto: &assistant)

    case let .skillCreated(name, description):
      appendStatus(
        kind: .skillCreated,
        title: "Skill created: \(name)",
        detail: description,
        onto: &assistant
      )

    case let .mcpServerError(server, error):
      appendStatus(
        kind: .mcpError,
        title: "MCP server error: \(server)",
        detail: error,
        onto: &assistant
      )

    case let .unknown(type, _):
      appendStatus(
        kind: .unknown,
        title: "Gateway event: \(type)",
        detail: nil,
        unknownType: type,
        onto: &assistant
      )
    }
  }

  private static func appendStatus(
    kind: StatusRowKind,
    title: String,
    detail: String?,
    unknownType: String? = nil,
    onto assistant: inout AssistantMessageProjection
  ) {
    assistant.statusRows.append(
      StatusRowState(
        id: "status-\(assistant.statusRows.count)",
        kind: kind,
        title: title,
        detail: detail,
        unknownType: unknownType
      )
    )
  }

  /// True for an event that renders nothing of its own between two sub-agent
  /// rows. `agent_spawned` is the coordinator's name-only announcement, pushed
  /// between a child's `worker_spawned` and its `subagent_started`; treating it
  /// as chrome is what lets back-to-back spawns still read as one parallel
  /// group (§8.2).
  private static func isSubagentChrome(_ event: AgentEvent) -> Bool {
    switch event {
    case .subagentStarted, .subagentProgress, .subagentFinished,
      .workerSpawned, .workerStatus, .workerDone, .agentSpawned:
      true
    default:
      false
    }
  }

  private static func upsertSubagent(
    id: String,
    at index: Int,
    isStart: Bool,
    onto assistant: inout AssistantMessageProjection,
    update: (inout SubagentDraft) -> Void
  ) {
    let slot: Int
    if let existing = assistant.subagentDrafts.firstIndex(where: { $0.subagentID == id }) {
      slot = existing
    } else {
      // Provisionally an orphan until (and unless) a start event shows up.
      assistant.subagentDrafts.append(
        SubagentDraft(
          subagentID: id,
          anchorIndex: index,
          chromeRank: assistant.nonChromeEventCount
        )
      )
      slot = assistant.subagentDrafts.index(before: assistant.subagentDrafts.endIndex)
    }
    if isStart, assistant.subagentDrafts[slot].hasStart == false {
      // The FIRST start wins the anchor: a child emits `worker_spawned` and
      // `subagent_started` back to back, and the row belongs at the earlier of
      // the two so it does not jump when D8 removes the mirror.
      assistant.subagentDrafts[slot].anchorIndex = index
      assistant.subagentDrafts[slot].chromeRank = assistant.nonChromeEventCount
      assistant.subagentDrafts[slot].hasStart = true
      assistant.subagentDrafts[slot].isOrphan = false
    }
    update(&assistant.subagentDrafts[slot])
  }

  private static func projectMessage(_ message: ConversationMessageDTO) -> ChatMessageState {
    switch message.content {
    case let .user(text, images):
      return ChatMessageState(
        id: message.id,
        turnID: message.turnId,
        ordinal: message.ordinal,
        role: message.role,
        status: message.status,
        user: UserMessageProjection(text: text, images: images ?? []),
        assistant: nil,
        origin: message.messageOrigin
      )

    case let .assistant(events):
      var assistant = AssistantMessageProjection()
      for event in events {
        project(event, onto: &assistant)
      }
      switch message.status {
      case .completed:
        assistant.terminal = .completed
        assistant.isThinkingCollapsed = true
        assistant.pendingQuestion = nil
      case .cancelled:
        assistant.terminal = .cancelled
        assistant.isThinkingCollapsed = true
        assistant.pendingQuestion = nil
      case .failed:
        let failure =
          assistant.statusRows.last(where: { $0.kind == .agentError })?.detail
          ?? "Response failed"
        assistant.terminal = .failed(failure)
        assistant.isThinkingCollapsed = true
        assistant.pendingQuestion = nil
      case .interrupted:
        assistant.terminal = .interrupted
        assistant.isThinkingCollapsed = true
        assistant.pendingQuestion = nil
      case .accepted, .streaming:
        break
      }
      return ChatMessageState(
        id: message.id,
        turnID: message.turnId,
        ordinal: message.ordinal,
        role: message.role,
        status: message.status,
        user: nil,
        assistant: assistant,
        origin: message.messageOrigin
      )
    }
  }

  private static func messageOrder(_ lhs: ChatMessageState, _ rhs: ChatMessageState) -> Bool {
    switch (lhs.ordinal, rhs.ordinal) {
    case let (left?, right?): left < right
    case (.some, nil): true
    case (nil, .some): false
    case (nil, nil): lhs.id < rhs.id
    }
  }

  private static func sequence(of frame: MobileWSServerFrame) -> Int? {
    switch frame {
    case let .accepted(_, _, _, _, _, seq, _, _, _): seq
    case let .event(_, _, seq, _): seq
    case let .done(_, _, seq, _): seq
    case let .error(_, _, seq, _, _, _, _): seq
    }
  }

  private static func conversationID(of frame: MobileWSServerFrame) -> String? {
    switch frame {
    case let .accepted(_, conversationID, _, _, _, _, _, _, _): conversationID
    case let .event(_, conversationID, _, _): conversationID
    case let .done(_, conversationID, _, _): conversationID
    case let .error(_, conversationID, _, _, _, _, _): conversationID
    }
  }

  private static func frameBelongsToConversation(
    _ frame: MobileWSServerFrame,
    state: ChatState
  ) -> Bool {
    if let conversationID = conversationID(of: frame) {
      return conversationID == state.conversation.id
    }
    let turnID = turnID(of: frame)
    return state.activeTurnID == turnID || state.messages.contains { $0.turnID == turnID }
  }

  private static func turnID(of frame: MobileWSServerFrame) -> String {
    switch frame {
    case let .accepted(id, _, _, _, _, _, _, _, _): id
    case let .event(id, _, _, _): id
    case let .done(id, _, _, _): id
    case let .error(id, _, _, _, _, _, _): id
    }
  }

  private static func replayFrame(_ entry: ReplayEntryDTO) -> MobileWSServerFrame {
    switch entry.payload {
    case let .accepted(userMessageID, assistantMessageID, revision):
      .accepted(
        id: entry.msgId,
        conversationId: entry.conversationId,
        userMessageId: userMessageID,
        assistantMessageId: assistantMessageID,
        revision: revision,
        seq: entry.seq,
        // The durable replay payload does not carry origin/kind, so this is
        // UNKNOWN, not `.user` (sub-agents design 7.6). `reconcileAccepted`
        // must therefore never overwrite an origin the REST row already knows.
        origin: nil,
        kind: nil,
        requestId: nil
      )
    case let .event(event):
      .event(
        id: entry.msgId,
        conversationId: entry.conversationId,
        seq: entry.seq,
        event: event
      )
    case let .done(outcome):
      .done(
        id: entry.msgId,
        conversationId: entry.conversationId,
        seq: entry.seq,
        outcome: outcome
      )
    case let .error(error, code, retryable):
      .error(
        id: entry.msgId,
        conversationId: entry.conversationId,
        seq: entry.seq,
        error: error,
        code: code,
        retryable: retryable,
        activeTurnId: nil
      )
    }
  }

  private static func finishTurn(_ turnID: String, state: inout ChatState) {
    if let activeTurnID = state.activeTurnID, activeTurnID != turnID {
      return
    }
    if let activeTurnID = state.conversation.activeTurnId, activeTurnID != turnID {
      return
    }
    if state.activeTurnID == turnID {
      state.activeTurnID = nil
    }
    if case .remoteActiveTurn? = state.composerBlock {
      // A remote turn owns this block; its authoritative summary clears it.
    } else {
      state.composerBlock = nil
    }
    state.conversation = summary(
      from: state.conversation,
      revision: state.conversation.revision,
      status: .idle,
      activeTurnID: nil,
      lastSeq: state.lastAppliedSeq
    )
  }

  private static func reduceFailure(
    _ error: GatewayError,
    state: inout ChatState
  ) -> [ChatEffect] {
    switch error {
    case .unauthorized, .capabilityRequired:
      state.composerBlock = .repairRequired
      return [.showRepair]
    case .updateRequired:
      state.composerBlock = .updateRequired
      return [.showRepair]
    case let .conversationBusy(activeTurnID):
      state.activeTurnID = activeTurnID
      state.composerBlock = .remoteActiveTurn(activeTurnID)
      return []
    case .gatewayOffline:
      state.errorBanner = "Gateway is offline"
    case .notFound:
      state.errorBanner = "Conversation not found"
    case let .validation(message), let .transport(message):
      state.errorBanner = message
    case .revisionConflict:
      state.errorBanner = "Conversation changed on another device"
    case .rateLimited:
      state.errorBanner = "The gateway is busy. Try again shortly."
    case .mutationOutcomeUnknown:
      state.errorBanner = "The message outcome is unknown. Refresh the conversation."
    case let .server(error, _):
      state.errorBanner = error.error
    }
    return []
  }

  private static func summary(
    from value: ConversationSummaryDTO,
    revision: Int,
    status: ConversationStatus,
    activeTurnID: String?,
    lastSeq: Int
  ) -> ConversationSummaryDTO {
    ConversationSummaryDTO(
      id: value.id,
      agentId: value.agentId,
      agentName: value.agentName,
      title: value.title,
      revision: revision,
      status: status,
      activeTurnId: activeTurnID,
      owningIssueId: value.owningIssueId,
      projectId: value.projectId,
      lastSeq: max(value.lastSeq, lastSeq),
      lastMessagePreview: value.lastMessagePreview,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
      deletedAt: value.deletedAt
    )
  }
}

/// `nil` for a missing OR empty string. The sub-agent fold treats `""` as
/// "not reported" so an empty field never blanks a value an earlier event
/// already supplied — the same rule as web's `str()` in
/// `apps/web/src/ui/blocks/subagents.ts`.
private func nonEmpty(_ value: String?) -> String? {
  guard let value, value.isEmpty == false else { return nil }
  return value
}
