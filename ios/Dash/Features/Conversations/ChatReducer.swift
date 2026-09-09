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
  /// Per-child UI state for the sub-agent rows (§8.1–§8.3), keyed by child
  /// conversation id.
  ///
  /// This is the slice D4 deliberately did NOT put on `SubagentCardState`, and
  /// the reason is the same one web hit as its D2 CRITICAL 1: `.cachedMessages
  /// Loaded` and `.olderMessagesLoaded` re-project whole messages from scratch
  /// (`:407`/`:415`), so expansion, a fetched child transcript or a REST fact
  /// hung off a folded card is destroyed by the next transcript refresh — and
  /// `ChatFeature` dispatches `cachedMessagesLoaded` from three sites,
  /// including the post-reconnect canonical snapshot. Keyed here, it survives.
  ///
  /// Lifetime is the conversation's: one `ChatFeature`/`ChatState` exists per
  /// open conversation, so this map is created and discarded with it and
  /// cannot accumulate across switches the way web's `subagentInfo` did before
  /// D3. It is deliberately NOT cleared on a transcript refresh — surviving
  /// one is the entire point.
  ///
  /// The composer's TEXT is NOT here; see `SubagentUIState`.
  var subagentUI: [String: SubagentUIState] = [:]

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

/// UI state for one sub-agent row, keyed by child conversation id in
/// `ChatState.subagentUI`.
///
/// **The composer draft is deliberately absent.** `ChatFeature` is
/// `@Observable` and `ChatView` reads `feature.state`, so a draft stored here
/// would invalidate the WHOLE transcript on every keystroke — the fan-out web
/// measured in its D3 I3 and deliberately kept its composers keyed away from.
/// iOS keeps the text in the composer view's own `@State`, the same way
/// `QuestionView` keeps `QuestionDraftState`. The cost is disclosed: collapsing
/// a row discards its unsent body draft, where web preserves it.
struct SubagentUIState: Equatable, Sendable {
  /// §8.3's disclosure state. Rows start collapsed.
  var isExpanded = false
  /// Whether THIS row's expansion opens a transcript — i.e. the row's `nested`,
  /// which is `depth < maxSubagentDepth`.
  ///
  /// Recorded rather than re-derived because the reconnect path
  /// (`ChatFeature.resubscribeExpandedSubagents`) has no depth to ask about:
  /// it walks `subagentUI` by id. A row AT the cap is `isExpanded == true`
  /// with no transcript and no subscription on purpose, and a foreground
  /// re-subscribe that could not tell the two apart would start fetching and
  /// subscribing grandchildren nothing renders — the leak class D2, D3 and
  /// D5's own second defect all paid for. `isExpanded` alone is not enough;
  /// this is the fact, not a proxy for it.
  var opensTranscript = false
  /// The child's own transcript. `nil` means NEVER FETCHED — distinct from a
  /// fetched-and-empty child, which renders "Nothing from this agent yet."
  /// rather than a loading line.
  var childMessages: [ChatMessageState]?
  /// `SubagentInfoDTO.oneShot`, which rides REST and never an event, so it is
  /// unknown until the first expansion reads the child's summary. `nil` leaves
  /// the body composer ENABLED: refusing a send on a guess would be worse than
  /// letting the coordinator's own 409 text land on the error line.
  var oneShot: Bool?
  /// A resume is in flight. Only ever set for a send this client made.
  var isSending = false
  /// The last refusal, verbatim from the gateway (`GatewayError.validation`
  /// carries the coordinator's actionable text). Cleared on the next attempt,
  /// never on success alone, so a refusal stays readable.
  var lastError: String?
  /// `requestId`s of optimistic rows still waiting for their `accepted` echo.
  ///
  /// An entry here is not a promise: a queued STEER produces an `accepted`
  /// once the child's current turn ends, but an ANSWER to a parked
  /// `ask_orchestrator` question resolves INSIDE the running turn and produces
  /// none, ever — and `SubagentResumeResponse.mode` reports both as `queued`.
  /// The row is written only when this client HOLDS a subscription for the
  /// child — read from `ChatFeature.subscribedSubagentIDs`, not inferred from
  /// the row being open — which is precisely when an echo could reach us.
  var pendingRequestIDs: Set<String> = []
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
  /// §8.3's disclosure toggle. Collapsing keeps the fetched transcript: a
  /// re-expansion re-reads anyway, and dropping it would blank the body for a
  /// round trip every time.
  case subagentExpanded(id: String, isExpanded: Bool, opensTranscript: Bool)
  /// The child's own messages, from `GET /conversations/{childId}/messages`.
  case subagentTranscriptLoaded(id: String, messages: [ConversationMessageDTO])
  /// `SubagentInfoDTO.oneShot` for a child, from its conversation summary.
  case subagentInfoLoaded(id: String, oneShot: Bool)
  /// The child's transcript could not be read. A separate action from
  /// `.subagentReplyFailed` on purpose: that one also clears `isSending` and
  /// withdraws a pending row, and a failed READ must not do either — a load
  /// racing an in-flight send would otherwise disarm the send's own spinner.
  case subagentTranscriptFailed(id: String, message: String)
  /// A `POST /subagents/{id}/resume` was just issued. `optimistic` is the
  /// caller's choice and must be true only when a subscription is held for
  /// this child, because that is the only condition under which an `accepted`
  /// can come back to reconcile the row.
  /// A new action was started on a child's tasks-sheet row, so the one error
  /// line that row shows is stale. Named for what it DOES rather than for the
  /// caller: `stopSubagent` clears `subagentStopErrors` itself and dispatches
  /// this for the other half of the same slot.
  ///
  /// Allocates NOTHING for a child that has no UI state: an entry created here
  /// would flip `ChatReducer`'s child-frame routing gate for an id this client
  /// holds no subscription for.
  case subagentRowErrorCleared(id: String)
  case subagentReplyStarted(id: String, requestID: String, text: String, optimistic: Bool)
  case subagentReplySucceeded(id: String, requestID: String)
  case subagentReplyFailed(id: String, requestID: String, message: String)
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
  /// The gateway's message id — or, before the `accepted` frame lands, the
  /// client-minted local id. `reconcileAccepted` rewrites this on ack; every
  /// lookup (retry, edit & resend, dedup, accessibility ids) goes by it.
  var id: String
  /// SwiftUI row identity (transcript scroll fix, 2026-09-05). Assigned once,
  /// at creation, and NEVER rewritten: `MessageListView`'s `ForEach` keys on
  /// this rather than `id`, so the ack swapping a local id for the server's
  /// (`reconcileAccepted`) is an in-place update of the same row instead of
  /// a remove + insert — which replayed the entrance transition on the bubble
  /// the user just sent, reset any `@State` inside the row (thinking/tool
  /// disclosures), and nudged the scroll position mid-stream. Canonical
  /// reloads (`cachedMessagesLoaded`, `olderMessagesLoaded`) carry the
  /// existing `rowID` over by message id so a refresh is equally invisible.
  let rowID: String
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

  /// Set only for a `notice` message — what the post-turn review recorded.
  /// Rendered as a chip; `user` and `assistant` are both nil for these.
  var notice: NoticeProjection? = nil

  init(
    id: String,
    turnID: String,
    ordinal: Int?,
    role: MessageRole,
    status: MessageStatus,
    user: UserMessageProjection?,
    assistant: AssistantMessageProjection?,
    origin: MessageOrigin? = nil,
    notice: NoticeProjection? = nil,
    rowID: String? = nil
  ) {
    self.id = id
    self.rowID = rowID ?? id
    self.turnID = turnID
    self.ordinal = ordinal
    self.role = role
    self.status = status
    self.user = user
    self.assistant = assistant
    self.origin = origin
    self.notice = notice
  }
}

struct UserMessageProjection: Equatable, Sendable {
  var text: String
  var images: [MessageImage]
}

/// A note the gateway appended after a turn finished. Carries no events — it is
/// not a turn — so it renders as a single chip rather than a bubble.
struct NoticeProjection: Equatable, Sendable {
  var kind: NoticeKind
  var text: String
}

enum AssistantTimelineBlock: Equatable, Sendable {
  case text(String)
  case thinking(String)
  case tool(ToolCardState)
  /// The position of this message's sub-agent rows in the event order — a
  /// MARKER, not the cards. The rows themselves are `subagentCards`, computed
  /// from `subagentDrafts` after the fold (end-of-stream terminalization and
  /// §8.2's clustering both need the whole message), so the timeline can only
  /// record WHERE the first child was spawned. Appended once per message, at
  /// the first draft.
  case subagents
  case status(StatusRowState)
  case question(QuestionState)
}

struct AssistantMessageProjection: Equatable, Sendable {
  var timeline: [AssistantTimelineBlock] = []
  var text = ""
  var thinking = ""
  // MC parity (design doc appendix §4): thinking is collapsed by default,
  // and — unlike the pre-MC-parity behavior — never auto-expands while
  // thinking streams in. Only an explicit user tap on the "Show
  // thinking"/"Hide thinking" toggle (`ThinkingView`) changes visibility.
  var isThinkingCollapsed = true
  var toolCards: [ToolCardState] = []
  /// Per-child accumulators for the sub-agent fold. Deliberately NOT the
  /// rendered rows: end-of-stream terminalization is a function of `terminal`,
  /// a value written AFTER the fold loop runs in `projectMessage`.
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

  /// The REST list's plain-string status (`SubagentListEntryDTO.status`), which
  /// is deliberately not an enum on the wire so a newer gateway's value cannot
  /// fail the decode of the whole page.
  ///
  /// An unrecognised value reads as `.running`, which is web's behaviour rather
  /// than a choice made here: `rowStatusOf` passes an unknown string straight
  /// through and `isTerminalSubagentStatus` answers false for it, so both
  /// clients count an unknown status as LIVE. The alternative is worse in the
  /// direction that matters — an unknown status read as terminal would hide a
  /// still-running child from the badge, from the strip and from Stop.
  init(wire: String) {
    if let live = SubagentLiveStatus(rawValue: wire) {
      self = SubagentCardStatus(live)
    } else if let terminal = SubagentTerminalStatus(rawValue: wire) {
      self = SubagentCardStatus(terminal)
    } else {
      self = .running
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
  /// The child's conversation id: `subagentId === childConversationId`
  /// (`coordinator.ts`, `child-handle.ts`). One id, one row.
  let id: String
  /// Optional human name from the `agent` tool call.
  var name: String?
  /// `subagentType`.
  var type: String
  /// One-line description.
  var description: String
  var status: SubagentCardStatus
  /// True when the child was spawned to outlive the turn.
  var background: Bool
  /// 1 for a child of a user conversation.
  var depth: Int
  /// `nil` until `subagent_started` arrives (an orphan terminal from a
  /// crash-split message has none).
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

/// One child's accumulated card, before end-of-stream terminalization.
///
/// Single-family since D8: the gateway retired the legacy `worker_*` mirrors,
/// so `subagent_started` is the only anchor and every field has ONE source.
/// A transcript PERSISTED before D8 still contains the mirrors; they still
/// DECODE (`AgentEvent` keeps the three cases for one release) and the fold
/// ignores them, which is the recorded policy — the gateway does not rewrite
/// them on replay.
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
  var name: String?
  var type: String?
  var descriptionText: String?
  var background: Bool?
  var depth: Int?
  var startedAt: Date?
  var endedAt: Date?
  var terminal: SubagentCardStatus?
  var report: String?
  var live: SubagentCardStatus?
  var detail: String?
  var question: String?
  var usage: UsageDTO?
  var progressToolCallCount: Int?
  var finishedToolCallCount: Int?

  /// Take a LATER copy of the same child, keeping THIS draft's anchor.
  ///
  /// D2's merge rule: a notification turn re-reports a child that already has a
  /// card, and the two copies disagree — the later one is better (it carries
  /// the terminal, the end time and the final tool count). Field-wise
  /// "later non-nil wins" is exactly what the message-scoped fold already does
  /// when a second event for the same child lands in the same message; the
  /// anchor fields (`anchorIndex`, `chromeRank`, `hasStart`, `isOrphan`) are
  /// deliberately NOT taken, so the card does not move and does not become an
  /// orphan.
  mutating func merge(later other: SubagentDraft) {
    name = other.name ?? name
    type = other.type ?? type
    descriptionText = other.descriptionText ?? descriptionText
    background = other.background ?? background
    depth = other.depth ?? depth
    startedAt = other.startedAt ?? startedAt
    endedAt = other.endedAt ?? endedAt
    terminal = other.terminal ?? terminal
    report = other.report ?? report
    live = other.live ?? live
    detail = other.detail ?? detail
    question = other.question ?? question
    usage = other.usage ?? usage
    progressToolCallCount = other.progressToolCallCount ?? progressToolCallCount
    finishedToolCallCount = other.finishedToolCallCount ?? finishedToolCallCount
  }

  func resolve(isStreaming: Bool, previous: SubagentDraft?) -> SubagentCardState {
    let description = descriptionText ?? ""
    let latestDetail = detail
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
      type: type ?? "",
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
      report: report,
      usage: usage,
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
  case memorySaved
  case memoryForgotten
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
      let rowIDs = rowIDsByMessageID(state.messages)
      state.messages = messages.sorted { $0.ordinal < $1.ordinal }.map {
        projectMessage($0, rowID: rowIDs[$0.id])
      }
      reconcileSubagentAnchors(&state.messages)
      state.lastAppliedSeq = max(state.lastAppliedSeq, cursor)
      state.pendingGapFrame = nil
      return []

    case let .olderMessagesLoaded(messages, nextCursor):
      var byID = Dictionary(uniqueKeysWithValues: state.messages.map { ($0.id, $0) })
      for message in messages {
        byID[message.id] = projectMessage(message, rowID: byID[message.id]?.rowID)
      }
      state.messages = byID.values.sorted(by: messageOrder)
      reconcileSubagentAnchors(&state.messages)
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
      // Child frames reach this socket because the client SUBSCRIBED to the
      // child conversation (design 7.6), and they must never touch the parent
      // transcript: a child's `seq` is its own sequence space, so letting one
      // through would advance `lastAppliedSeq`, corrupt the gap detector and
      // hand `activeTurnID` to a turn on another conversation. Before D5 they
      // were simply DROPPED by `frameBelongsToConversation`, which was safe
      // and invisible; now they are routed.
      if let childID = conversationID(of: frame),
        childID != state.conversation.id,
        state.subagentUI[childID] != nil
      {
        applyChildFrame(frame, childID: childID, state: &state)
        return []
      }
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
        if let question = assistant.pendingQuestion,
          let timelineIndex = assistant.timeline.firstIndex(where: {
            if case let .question(existing) = $0 { return existing.id == questionID }
            return false
          })
        {
          assistant.timeline[timelineIndex] = .question(question)
        }
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

    case let .subagentExpanded(id, isExpanded, opensTranscript):
      var ui = state.subagentUI[id] ?? SubagentUIState()
      ui.isExpanded = isExpanded
      ui.opensTranscript = opensTranscript
      state.subagentUI[id] = ui
      return []

    case let .subagentTranscriptLoaded(id, messages):
      var ui = state.subagentUI[id] ?? SubagentUIState()
      let loaded = messages.sorted { ($0.ordinal) < ($1.ordinal) }.map { projectMessage($0) }
      // Optimistic rows and any live rows already materialised from a `child`
      // frame are KEPT: the REST page is a snapshot taken before them, and
      // replacing wholesale would blank a row the user is watching stream.
      // Server ids win on collision, which is what adoption already produced.
      let loadedIDs = Set(loaded.map(\.id))
      let live = (ui.childMessages ?? []).filter { $0.ordinal == nil && !loadedIDs.contains($0.id) }
      ui.childMessages = loaded + live
      state.subagentUI[id] = ui
      return []

    case let .subagentTranscriptFailed(id, message):
      var ui = state.subagentUI[id] ?? SubagentUIState()
      ui.lastError = message
      state.subagentUI[id] = ui
      return []

    case let .subagentInfoLoaded(id, oneShot):
      var ui = state.subagentUI[id] ?? SubagentUIState()
      ui.oneShot = oneShot
      state.subagentUI[id] = ui
      return []

    case let .subagentRowErrorCleared(id):
      guard var ui = state.subagentUI[id] else { return [] }
      ui.lastError = nil
      state.subagentUI[id] = ui
      return []

    case let .subagentReplyStarted(id, requestID, text, optimistic):
      var ui = state.subagentUI[id] ?? SubagentUIState()
      ui.isSending = true
      // Cleared on the ATTEMPT, not on success: leaving the previous refusal
      // up while a new send is in flight reads as though the new one failed.
      ui.lastError = nil
      if optimistic {
        ui.pendingRequestIDs.insert(requestID)
        var rows = ui.childMessages ?? []
        // `origin: .parent` because that is what the gateway records and
        // echoes for a parent-authored turn on a child conversation
        // (`chat-accepted-subagent.json`) — so it renders as §8.5's muted
        // "from orchestrator" row, not as a user bubble with Retry/Edit.
        rows.append(
          ChatMessageState(
            id: requestID,
            turnID: requestID,
            ordinal: nil,
            role: .user,
            status: .accepted,
            user: UserMessageProjection(text: text, images: []),
            assistant: nil,
            origin: .parent
          )
        )
        ui.childMessages = rows
      }
      state.subagentUI[id] = ui
      return []

    case let .subagentReplySucceeded(id, requestID):
      guard var ui = state.subagentUI[id] else { return [] }
      ui.isSending = false
      _ = requestID
      state.subagentUI[id] = ui
      return []

    case let .subagentReplyFailed(id, requestID, message):
      guard var ui = state.subagentUI[id] else { return [] }
      ui.isSending = false
      ui.lastError = message
      // The turn never started, so no `accepted` is coming for this id: drop
      // the optimistic row rather than leaving the user's sentence sitting in
      // the child's transcript as though it had been delivered.
      if ui.pendingRequestIDs.remove(requestID) != nil {
        ui.childMessages?.removeAll { $0.id == requestID }
      }
      state.subagentUI[id] = ui
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

  /// Fold one frame for a SUBSCRIBED child conversation into that child's own
  /// transcript slice.
  ///
  /// Deliberately not `reduceFrame`: none of that function's parent-scoped
  /// bookkeeping applies to a child. There is no `lastAppliedSeq` for a child
  /// (its `seq` counts in its own conversation), so there is no gap detector
  /// and no replay request; there is no `activeTurnID`, because the composer
  /// being blocked is a property of the conversation the user has OPEN; and
  /// there is no cursor to persist, because the child's messages are not
  /// cached. What it does share is the event projector — `project(_:onto:)`
  /// and `projectMessage` — so a child renders through exactly the same fold
  /// as its parent (§8.3).
  private static func applyChildFrame(
    _ frame: MobileWSServerFrame,
    childID: String,
    state: inout ChatState
  ) {
    guard var ui = state.subagentUI[childID] else { return }
    // A child whose transcript was never fetched has nothing to fold onto, and
    // materialising rows here would produce a transcript with a hole in it —
    // everything the child said before this frame would be missing. The next
    // expansion re-reads from REST and gets the whole thing.
    guard var rows = ui.childMessages else { return }
    defer {
      ui.childMessages = rows
      state.subagentUI[childID] = ui
    }

    switch frame {
    case let .accepted(turnID, _, userMessageID, assistantMessageID, _, _, origin, _, requestID):
      // Adopt this client's own optimistic row rather than adding a second
      // one. Keyed on `requestId`, which is the ONLY correlation available:
      // the server picks the turn id for a resume, and the resume response
      // carries none.
      if let requestID, ui.pendingRequestIDs.remove(requestID) != nil,
        let index = rows.firstIndex(where: { $0.id == requestID })
      {
        rows[index] = ChatMessageState(
          id: userMessageID,
          turnID: turnID,
          ordinal: nil,
          role: .user,
          status: .accepted,
          user: rows[index].user,
          assistant: nil,
          origin: origin ?? .parent
        )
      } else if rows.contains(where: { $0.id == userMessageID }) == false {
        rows.append(
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
      if rows.contains(where: { $0.id == assistantMessageID }) == false {
        rows.append(
          ChatMessageState(
            id: assistantMessageID,
            turnID: turnID,
            ordinal: nil,
            role: .assistant,
            status: .streaming,
            user: nil,
            assistant: AssistantMessageProjection(),
            origin: nil
          )
        )
      }

    case let .event(turnID, _, _, event):
      let index = ensureChildAssistant(turnID: turnID, rows: &rows)
      var assistant = rows[index].assistant ?? AssistantMessageProjection()
      project(event, onto: &assistant)
      rows[index].assistant = assistant
      rows[index].status = .streaming

    case let .done(turnID, _, _, outcome):
      let index = ensureChildAssistant(turnID: turnID, rows: &rows)
      var assistant = rows[index].assistant ?? AssistantMessageProjection()
      switch outcome ?? .completed {
      case .completed:
        rows[index].status = .completed
        assistant.terminal = .completed
      case .cancelled:
        rows[index].status = .cancelled
        assistant.terminal = .cancelled
      }
      assistant.isThinkingCollapsed = true
      assistant.pendingQuestion = nil
      rows[index].assistant = assistant

    case let .error(turnID, _, _, error, _, _, _):
      let index = ensureChildAssistant(turnID: turnID, rows: &rows)
      var assistant = rows[index].assistant ?? AssistantMessageProjection()
      rows[index].status = .failed
      assistant.terminal = .failed(error)
      assistant.isThinkingCollapsed = true
      assistant.pendingQuestion = nil
      rows[index].assistant = assistant
    }
  }

  private static func ensureChildAssistant(
    turnID: String,
    rows: inout [ChatMessageState]
  ) -> Int {
    if let index = rows.firstIndex(where: { $0.turnID == turnID && $0.role == .assistant }) {
      return index
    }
    rows.append(
      ChatMessageState(
        id: turnID,
        turnID: turnID,
        ordinal: nil,
        role: .assistant,
        status: .streaming,
        user: nil,
        assistant: AssistantMessageProjection(),
        origin: nil
      )
    )
    return rows.count - 1
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
      // D2: only an event that names a child can create a duplicate card, so
      // the conversation-scoped pass runs on those three and not on every
      // token delta.
      if namesSubagent(event) { reconcileSubagentAnchors(&state.messages) }
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
      if case let .text(existing) = assistant.timeline.last {
        assistant.timeline[assistant.timeline.count - 1] = .text(existing + text)
      } else {
        assistant.timeline.append(.text(text))
      }

    case let .thinkingDelta(text):
      assistant.thinking += text
      if case let .thinking(existing) = assistant.timeline.last {
        assistant.timeline[assistant.timeline.count - 1] = .thinking(existing + text)
      } else {
        assistant.timeline.append(.thinking(text))
      }

    case let .toolUseStart(id, name, input):
      if let index = assistant.toolCards.firstIndex(where: { $0.id == id }) {
        assistant.toolCards[index].name = name
        assistant.toolCards[index].input = input
        assistant.toolCards[index].status = .running
        replaceTool(assistant.toolCards[index], in: &assistant)
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
        assistant.timeline.append(.tool(assistant.toolCards.last!))
      }

    case let .toolUseDelta(partialJSON):
      if let index = assistant.toolCards.lastIndex(where: { $0.status == .running }) {
        assistant.toolCards[index].partialJSON += partialJSON
        replaceTool(assistant.toolCards[index], in: &assistant)
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
        assistant.timeline.append(.tool(assistant.toolCards.last!))
      }

    case let .toolResult(id, name, content, isError, details):
      if let index = assistant.toolCards.firstIndex(where: { $0.id == id }) {
        assistant.toolCards[index].name = name
        assistant.toolCards[index].content = content
        assistant.toolCards[index].details = details
        assistant.toolCards[index].status = isError ? .failed : .succeeded
        replaceTool(assistant.toolCards[index], in: &assistant)
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
        assistant.timeline.append(.tool(assistant.toolCards.last!))
      }

    case let .response(content, usage):
      if assistant.text.isEmpty {
        assistant.text = content
        assistant.timeline.append(.text(content))
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

    // The retired `worker_*` mirrors (D8). They still DECODE — the three cases
    // stay on `AgentEvent` for one release, because a transcript PERSISTED
    // before D8 contains them — and they fold into NOTHING: they anchor no
    // row, contribute no field, and `isSubagentChrome` still claims them so
    // they never reach the `.unknown` branch below, which would redecorate
    // every old conversation with three "Gateway event: worker_…" rows per
    // child. The mirrors were never TWINNED in the log — a `worker_done` from
    // the consumer-gone cancel path has no `subagent_finished` beside it — so
    // dropping loses that one cancel report (TEST_PLAN §32.8 step 4). Dropping
    // is still the choice: a rewrite on replay would synthesise an event into
    // every old conversation's log.
    case .workerSpawned, .workerStatus, .workerDone:
      break

    case let .subagentStarted(
      subagentID, name, subagentType, description, _, _, background, depth, startedAt, _, _):
      upsertSubagent(id: subagentID, at: eventIndex, isStart: true, onto: &assistant) { draft in
        draft.name = nonEmpty(name) ?? draft.name
        draft.type = nonEmpty(subagentType) ?? draft.type
        draft.descriptionText = nonEmpty(description) ?? draft.descriptionText
        draft.background = background
        draft.depth = depth
        draft.startedAt = startedAt
      }

    case let .subagentProgress(subagentID, status, toolCallCount, _, detail, question):
      upsertSubagent(id: subagentID, at: eventIndex, isStart: false, onto: &assistant) { draft in
        draft.live = SubagentCardStatus(status)
        // Resolved as a UNIT with `live`: a running progress event deliberately
        // CLEARS the question, so `question` is assigned, never merged.
        draft.question = nonEmpty(question)
        // Sticky: a later progress event with no detail must not blank the
        // line the row is already showing.
        draft.detail = nonEmpty(question) ?? nonEmpty(detail) ?? draft.detail
        draft.progressToolCallCount = toolCallCount
        // `elapsedMs` is deliberately DISCARDED. It is a server-side stopwatch
        // sampled at most once a second and never replayed, so a row that read
        // it would freeze on reconnect and disagree with itself across a
        // refresh. Elapsed is derived from `startedAt`/`endedAt` instead.
      }

    case let .subagentFinished(
      subagentID, name, subagentType, description, status, report, usage, toolCallCount, startedAt,
      endedAt):
      upsertSubagent(id: subagentID, at: eventIndex, isStart: false, onto: &assistant) { draft in
        draft.name = nonEmpty(name) ?? draft.name
        draft.type = nonEmpty(subagentType) ?? draft.type
        draft.descriptionText = nonEmpty(description) ?? draft.descriptionText
        draft.terminal = SubagentCardStatus(status)
        draft.report = nonEmpty(report)
        draft.finishedToolCallCount = toolCallCount
        draft.startedAt = startedAt
        draft.endedAt = endedAt
        draft.usage = usage ?? draft.usage
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
      assistant.timeline.append(.question(assistant.pendingQuestion!))

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

    case let .memorySaved(_, description, _, action):
      appendStatus(
        kind: .memorySaved,
        title: action == .updated ? "Updated memory" : "Remembered",
        detail: description,
        onto: &assistant
      )

    case let .memoryForgotten(name):
      appendStatus(kind: .memoryForgotten, title: "Forgot memory", detail: name, onto: &assistant)

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
    assistant.timeline.append(.status(assistant.statusRows.last!))
  }

  private static func replaceTool(
    _ tool: ToolCardState,
    in assistant: inout AssistantMessageProjection
  ) {
    guard let index = assistant.timeline.firstIndex(where: {
      if case let .tool(existing) = $0 { return existing.id == tool.id }
      return false
    }) else { return }
    assistant.timeline[index] = .tool(tool)
  }

  /// True for an event that renders nothing of its own between two sub-agent
  /// rows. `agent_spawned` is the coordinator's name-only announcement, pushed
  /// just before a child's `subagent_started`; treating it as chrome is what
  /// lets back-to-back spawns still read as one parallel group (§8.2). The
  /// three retired `worker_*` mirrors stay here too: a persisted pre-D8
  /// message carries them, and they must not reach the `.unknown` branch.
  private static func isSubagentChrome(_ event: AgentEvent) -> Bool {
    switch event {
    case .subagentStarted, .subagentProgress, .subagentFinished,
      .workerSpawned, .workerStatus, .workerDone, .agentSpawned:
      true
    case let .toolUseStart(_, name, _) where name == spawningToolName:
      true
    case let .toolResult(_, name, _, _, _) where name == spawningToolName:
      true
    // The SPAWNING tool's own rows. A BACKGROUND spawn's `agent` tool result
    // comes back immediately ("launched in the background"), so with two
    // background children in one turn one child's result lands between the two
    // `subagent_started` anchors and splits what is unambiguously a parallel
    // group — both children still running. Two FOREGROUND children in the same
    // shape cluster fine, because their results arrive after both starts. That
    // race is D4; `subagent-background-pair-frames.jsonl` and
    // `subagent-parallel-frames.jsonl` are the two real gateway streams.
    //
    // Only the spawning tool. Any OTHER tool call between two spawns is real
    // content and still splits the cluster: this one is already rendered — as
    // the card.
    default:
      false
    }
  }

  /// The tool whose call IS a child, so its own rows are the card, not content.
  private static let spawningToolName = "agent"

  /// True for the three events that name a child and fold into a card.
  private static func namesSubagent(_ event: AgentEvent) -> Bool {
    switch event {
    case .subagentStarted, .subagentProgress, .subagentFinished: true
    default: false
    }
  }

  /// Fold every message's sub-agent drafts back onto the message that ANCHORED
  /// each child (D2). The iOS twin of MC's `mergeSubagentEventLists`
  /// (`chat.swarm.ts`) and web's (`blocks/subagents.ts`).
  ///
  /// The fold is message-scoped, and it must be: a card is anchored by the
  /// `subagent_started` in its own message. But a CONVERSATION is not. A
  /// background child's completion wakes the conversation with a
  /// server-initiated notification turn that REPLAYS its `subagent_finished`,
  /// and the rule that an orphan terminal still anchors its own card (§31.4,
  /// §32.8.4) — correct in isolation, and asserted on purpose by
  /// `subagents:e2e` — then draws a SECOND card for a child that already has
  /// one. `subagent-notification-frames.jsonl` is exactly that, captured.
  ///
  /// A merge and not a suppression: the later copy carries the terminal, and
  /// dropping it would leave the first card `running` for ever, since a
  /// background child is exempt from end-of-stream terminalization by design.
  ///
  /// A child with no EARLIER anchor is left exactly where it is — the
  /// crash-reconcile case §31.4 exists for, where the orphan terminal is the
  /// only card anyone will ever draw.
  ///
  /// Scoped to the conversation being viewed, matching MC, which merged
  /// `selectedMessages` only: a nested child transcript (`applyChildFrame`)
  /// still folds per message.
  static func reconcileSubagentAnchors(_ rows: inout [ChatMessageState]) {
    var anchorOf: [String: Int] = [:]
    for (index, row) in rows.enumerated() {
      guard let assistant = row.assistant else { continue }
      for draft in assistant.subagentDrafts where draft.hasStart {
        if anchorOf[draft.subagentID] == nil { anchorOf[draft.subagentID] = index }
      }
    }
    guard anchorOf.isEmpty == false else { return }

    for index in rows.indices {
      guard var assistant = rows[index].assistant,
        assistant.subagentDrafts.isEmpty == false
      else { continue }
      var moved: [SubagentDraft] = []
      assistant.subagentDrafts.removeAll { draft in
        guard let anchor = anchorOf[draft.subagentID], anchor != index else { return false }
        moved.append(draft)
        return true
      }
      guard moved.isEmpty == false else { continue }
      rows[index].assistant = assistant
      for draft in moved {
        guard let anchor = anchorOf[draft.subagentID],
          var target = rows[anchor].assistant,
          let slot = target.subagentDrafts.firstIndex(where: {
            $0.subagentID == draft.subagentID
          })
        else { continue }
        target.subagentDrafts[slot].merge(later: draft)
        rows[anchor].assistant = target
      }
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
      // The whole cluster block renders at the FIRST child's position in the
      // event order, which is where §8.2's group container belongs: a later
      // sibling joins the group rather than opening a second one.
      if assistant.subagentDrafts.count == 1 { assistant.timeline.append(.subagents) }
    }
    if isStart, assistant.subagentDrafts[slot].hasStart == false {
      // `subagent_started` is the ONLY anchor since D8.
      assistant.subagentDrafts[slot].anchorIndex = index
      assistant.subagentDrafts[slot].chromeRank = assistant.nonChromeEventCount
      assistant.subagentDrafts[slot].hasStart = true
      assistant.subagentDrafts[slot].isOrphan = false
    }
    update(&assistant.subagentDrafts[slot])
  }

  /// `[message id: rowID]` for the rows currently on screen, so a canonical
  /// re-projection of the same message keeps its SwiftUI row identity (see
  /// `ChatMessageState.rowID`). First one wins on the (never expected)
  /// duplicate-id case rather than trapping.
  private static func rowIDsByMessageID(_ messages: [ChatMessageState]) -> [String: String] {
    Dictionary(messages.map { ($0.id, $0.rowID) }, uniquingKeysWith: { first, _ in first })
  }

  /// `rowID`: the existing row's identity when this DTO replaces a message
  /// already on screen; `nil` (= the message id) for a genuinely new row.
  private static func projectMessage(
    _ message: ConversationMessageDTO,
    rowID: String? = nil
  ) -> ChatMessageState {
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
        origin: message.messageOrigin,
        rowID: rowID
      )

    case let .notice(kind, text):
      return ChatMessageState(
        id: message.id,
        turnID: message.turnId,
        ordinal: message.ordinal,
        role: message.role,
        status: message.status,
        user: nil,
        assistant: nil,
        notice: NoticeProjection(kind: kind, text: text),
        rowID: rowID
      )

    case let .unknown(type):
      // A content type this build predates. Render nothing rather than drop the
      // row: keeping it preserves ordinals and paging, and an empty row is a
      // smaller lie than a missing message.
      _ = type
      return ChatMessageState(
        id: message.id,
        turnID: message.turnId,
        ordinal: message.ordinal,
        role: message.role,
        status: message.status,
        user: nil,
        assistant: nil,
        notice: nil,
        rowID: rowID
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
        origin: message.messageOrigin,
        rowID: rowID
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
