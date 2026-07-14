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
}

struct UserMessageProjection: Equatable, Sendable {
  var text: String
  var images: [MessageImage]
}

struct AssistantMessageProjection: Equatable, Sendable {
  var text = ""
  var thinking = ""
  var isThinkingCollapsed = false
  var toolCards: [ToolCardState] = []
  var workerCards: [WorkerCardState] = []
  var statusRows: [StatusRowState] = []
  var pendingQuestion: QuestionState?
  var usage: UsageDTO?
  var terminal: ChatTerminalState?
  var hasAnnouncedTerminal = false
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

struct WorkerKey: Equatable, Hashable, Sendable {
  let runID: String
  let workerID: String
}

enum WorkerCardStatus: Equatable, Sendable {
  case running
  case waitingInput
  case done
  case failed
  case cancelled
}

struct WorkerCardState: Equatable, Identifiable, Sendable {
  let key: WorkerKey
  var role: String
  var brief: String?
  var model: String?
  var status: WorkerCardStatus
  var detail: String?
  var question: String?
  var report: String?
  var usage: UsageDTO?

  var id: WorkerKey { key }
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
    case let .accepted(id, _, userMessageID, assistantMessageID, revision, seq):
      reconcileAccepted(
        turnID: id,
        userMessageID: userMessageID,
        assistantMessageID: assistantMessageID,
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
    state: inout ChatState
  ) {
    if let canonicalUser = state.messages.firstIndex(where: { $0.id == userMessageID }) {
      state.messages[canonicalUser].status = .accepted
    } else if let optimisticUser = state.messages.firstIndex(where: {
      $0.turnID == turnID && $0.role == .user
    }) {
      state.messages[optimisticUser].id = userMessageID
      state.messages[optimisticUser].status = .accepted
    } else {
      state.messages.append(
        ChatMessageState(
          id: userMessageID,
          turnID: turnID,
          ordinal: nil,
          role: .user,
          status: .accepted,
          user: UserMessageProjection(text: "", images: []),
          assistant: nil
        )
      )
    }
    deduplicate(turnID: turnID, role: .user, keepingID: userMessageID, state: &state)

    if let canonicalAssistant = state.messages.firstIndex(where: { $0.id == assistantMessageID }) {
      state.messages[canonicalAssistant].status = .streaming
    } else if let existingAssistant = state.messages.firstIndex(where: {
      $0.turnID == turnID && $0.role == .assistant
    }) {
      state.messages[existingAssistant].id = assistantMessageID
      state.messages[existingAssistant].status = .streaming
    } else {
      state.messages.append(
        ChatMessageState(
          id: assistantMessageID,
          turnID: turnID,
          ordinal: nil,
          role: .assistant,
          status: .streaming,
          user: nil,
          assistant: AssistantMessageProjection()
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
    switch event {
    case let .textDelta(text):
      assistant.text += text

    case let .thinkingDelta(text):
      assistant.thinking += text
      assistant.isThinkingCollapsed = false

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

    case let .workerSpawned(workerID, runID, role, brief, model):
      let key = WorkerKey(runID: runID, workerID: workerID)
      upsertWorker(key: key, onto: &assistant) { worker in
        worker.role = role
        worker.brief = brief
        worker.model = model
        worker.status = .running
      }

    case let .workerStatus(workerID, runID, role, status, detail, question):
      let key = WorkerKey(runID: runID, workerID: workerID)
      upsertWorker(key: key, onto: &assistant) { worker in
        worker.role = role
        worker.status = status == .running ? .running : .waitingInput
        worker.detail = detail
        worker.question = question
      }

    case let .workerDone(workerID, runID, role, status, report, usage):
      let key = WorkerKey(runID: runID, workerID: workerID)
      upsertWorker(key: key, onto: &assistant) { worker in
        worker.role = role
        worker.status =
          switch status {
          case .done: .done
          case .failed: .failed
          case .cancelled: .cancelled
          }
        worker.detail = nil
        worker.question = nil
        worker.report = report
        worker.usage = usage
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

  private static func upsertWorker(
    key: WorkerKey,
    onto assistant: inout AssistantMessageProjection,
    update: (inout WorkerCardState) -> Void
  ) {
    let index: Int
    if let existing = assistant.workerCards.firstIndex(where: { $0.key == key }) {
      index = existing
    } else {
      assistant.workerCards.append(
        WorkerCardState(
          key: key,
          role: "Worker",
          brief: nil,
          model: nil,
          status: .running,
          detail: nil,
          question: nil,
          report: nil,
          usage: nil
        )
      )
      index = assistant.workerCards.index(before: assistant.workerCards.endIndex)
    }
    update(&assistant.workerCards[index])
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
        assistant: nil
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
        assistant: assistant
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
    case let .accepted(_, _, _, _, _, seq): seq
    case let .event(_, _, seq, _): seq
    case let .done(_, _, seq, _): seq
    case let .error(_, _, seq, _, _, _, _): seq
    }
  }

  private static func conversationID(of frame: MobileWSServerFrame) -> String? {
    switch frame {
    case let .accepted(_, conversationID, _, _, _, _): conversationID
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
    case let .accepted(id, _, _, _, _, _): id
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
        seq: entry.seq
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
