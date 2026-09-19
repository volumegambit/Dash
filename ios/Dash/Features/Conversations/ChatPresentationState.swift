import Foundation

/// Reader intent belongs to one window. Canonical conversation updates may
/// change the transcript, but only a gesture or explicit navigation changes
/// this value.
enum ChatReadingIntent: Equatable, Sendable {
  case following
  case reading
  case interacting
  case navigating
  case restoring
}

/// A restorable place in content. Row and block identities survive streaming
/// layout changes; `screenY` preserves where the passage sat in the unobscured
/// viewport rather than only which row happened to be visible.
struct ChatPassageAnchor: Equatable, Sendable {
  let rowID: String
  let blockID: String?
  let textMarker: String?
  let fraction: Double
  let screenY: Double

  init(
    rowID: String,
    blockID: String? = nil,
    textMarker: String? = nil,
    fraction: Double = 0,
    screenY: Double
  ) {
    self.rowID = rowID
    self.blockID = blockID
    self.textMarker = textMarker
    self.fraction = min(max(fraction, 0), 1)
    self.screenY = screenY
  }
}

enum ChatMeaningfulUpdate: Equatable, Sendable {
  case turn
  case question
  case error
  case completion
  case token
}

enum ChatDeliveryState: Equatable, Sendable {
  case ready
  case sending(commandID: String)
  case reconciling(commandID: String)
  case failed(commandID: String, message: String)
}

enum ChatExecutionState: Equatable, Sendable {
  case idle
  case starting
  case working
  case stopping(commandID: String)
  case needsInput(count: Int)
}

enum ChatCommandOperationState: Equatable, Sendable {
  case none
  case inFlight(id: String, command: ConversationCommand)
  case accepted(id: String, command: ConversationCommand)
  case rejected(id: String, command: ConversationCommand, reason: CommandReceiptReason?)
}

enum ChatControlPriority: Equatable, Sendable {
  case none
  case work(pendingCount: Int)
  case pausedPending(count: Int)
  case stopping
  case recovery(message: String)
  case requiredInput(count: Int)
}

struct ChatLocalReveal: Equatable, Sendable {
  let commandID: String
  let displacedPassage: ChatPassageAnchor?
}

struct ChatComposerPayload: Equatable, Sendable {
  let sourceWindowID: String?
  let revision: UInt64?
  let text: String
  let attachments: [PreparedAttachment]
}

struct ChatWindowDraftResolution: Equatable, Sendable {
  let commandID: String
  let sourceWindowID: String
  let submittedRevision: UInt64
  let accepted: Bool
}

struct ChatDictationInsertion: Equatable, Sendable {
  let sourceWindowID: String
  let text: String
  let sequence: UInt64
}

struct ChatInspectorPresentation: Equatable, Sendable {
  let activityID: String
  let triggerID: String
  let parentPassage: ChatPassageAnchor?
}

/// The text one window is composing. `ChatFeature` is shared by every scene
/// displaying a conversation, so binding the text field straight to its
/// canonical state makes typing in one window appear in another. This value
/// stays with the view and uses a revision to ensure an acknowledgement for
/// an older submission cannot erase text typed after Send.
struct ChatWindowDraftState: Equatable, Sendable {
  private(set) var windowID: String?
  private(set) var text = ""
  private(set) var attachments: [PreparedAttachment] = []
  private(set) var revision: UInt64 = 0
  private(set) var submittedRevision: UInt64?
  private(set) var pendingCommand: PendingWindowCommand?
  private(set) var isSeeded = false

  mutating func seed(
    text: String,
    attachments: [PreparedAttachment] = [],
    windowID: String,
    revision: UInt64 = 0,
    pendingCommand: PendingWindowCommand? = nil
  ) {
    guard isSeeded == false else { return }
    self.windowID = windowID
    self.text = text
    self.attachments = attachments
    self.revision = revision
    self.pendingCommand = pendingCommand
    submittedRevision = pendingCommand?.submittedRevision
    isSeeded = true
  }

  mutating func edit(_ value: String) {
    text = value
    revision &+= 1
  }

  mutating func replaceAttachments(_ value: [PreparedAttachment]) {
    attachments = value
    revision &+= 1
  }

  mutating func appendDictation(_ value: String) {
    let addition = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard addition.isEmpty == false else { return }
    if text.isEmpty {
      text = addition
    } else if text.last?.isWhitespace == true {
      text += addition
    } else {
      text += " " + addition
    }
    revision &+= 1
  }

  @discardableResult
  mutating func beginSubmission() -> UInt64 {
    submittedRevision = revision
    return revision
  }

  var payload: ChatComposerPayload? {
    guard let windowID else { return nil }
    return ChatComposerPayload(
      sourceWindowID: windowID,
      revision: revision,
      text: text,
      attachments: attachments
    )
  }

  /// Clears only the exact revision that was submitted. If the person has
  /// already typed more text, the acknowledgement consumes the marker and
  /// preserves the newer draft.
  mutating func acknowledgeSubmission(revision submittedRevision: UInt64? = nil) {
    let submittedRevision = submittedRevision ?? self.submittedRevision
    guard let submittedRevision else { return }
    self.submittedRevision = nil
    pendingCommand = nil
    guard revision == submittedRevision else { return }
    text = ""
    attachments = []
    revision &+= 1
  }


  mutating func rejectSubmission(revision submittedRevision: UInt64) {
    if self.submittedRevision == submittedRevision {
      self.submittedRevision = nil
    }
    if pendingCommand?.submittedRevision == submittedRevision {
      pendingCommand = nil
    }
  }

  @discardableResult
  mutating func apply(_ resolution: ChatWindowDraftResolution) -> Bool {
    guard resolution.sourceWindowID == windowID else { return false }
    if resolution.accepted {
      acknowledgeSubmission(revision: resolution.submittedRevision)
    } else {
      rejectSubmission(revision: resolution.submittedRevision)
    }
    return true
  }
}

/// All state that one reader can change without changing the shared
/// conversation. Each `ChatView` owns one instance even when several views
/// observe the same `ChatFeature`.
struct ChatPresentationState: Equatable, Sendable {
  var readingIntent: ChatReadingIntent = .following
  var passage: ChatPassageAnchor?
  var unreadMeaningfulUpdates = 0
  var reveal: ChatLocalReveal?
  var inspector: ChatInspectorPresentation?
  var expandedActivityIDs: Set<String> = []
  var delivery: ChatDeliveryState = .ready
  var connection: GatewayConnectionState = .connecting
  var execution: ChatExecutionState = .idle
  var pendingScheduling: PendingScheduling = .running
  var pendingCount = 0
  var recoveryMessage: String?
  var commandOperation: ChatCommandOperationState = .none
  var windowDraft = ChatWindowDraftState()

  var controlPriority: ChatControlPriority {
    if case .needsInput(let count) = execution { return .requiredInput(count: count) }
    if let recoveryMessage { return .recovery(message: recoveryMessage) }
    if case .stopping = execution { return .stopping }
    if pendingScheduling == .paused, pendingCount > 0 {
      return .pausedPending(count: pendingCount)
    }
    if execution != .idle || pendingCount > 0 { return .work(pendingCount: pendingCount) }
    return .none
  }

  mutating func userBeganInteraction() {
    readingIntent = .interacting
  }

  mutating func userRead(_ anchor: ChatPassageAnchor?) {
    passage = anchor
    readingIntent = .reading
  }

  mutating func interactionEnded(didMoveAway: Bool) {
    readingIntent = didMoveAway ? .reading : .following
  }

  mutating func showLatest() {
    readingIntent = .following
    passage = nil
    unreadMeaningfulUpdates = 0
    reveal = nil
  }

  mutating func receive(_ update: ChatMeaningfulUpdate, remote: Bool) {
    guard update != .token else { return }
    if readingIntent != .following { unreadMeaningfulUpdates += 1 }
    // Remote work is intentionally passive. A local caller invokes
    // `revealLocalExchange` only after durable command admission.
    _ = remote
  }

  @discardableResult
  mutating func revealLocalExchange(commandID: String) -> Bool {
    guard reveal?.commandID != commandID else { return false }
    let displacedPassage = readingIntent == .following ? nil : passage
    reveal = ChatLocalReveal(commandID: commandID, displacedPassage: displacedPassage)
    if displacedPassage != nil {
      readingIntent = .reading
    }
    unreadMeaningfulUpdates = 0
    return true
  }

  mutating func backToReading() -> ChatPassageAnchor? {
    let anchor = reveal?.displacedPassage
    reveal = nil
    if anchor != nil {
      passage = anchor
      readingIntent = .restoring
    }
    return anchor
  }

  mutating func openInspector(activityID: String, triggerID: String) {
    inspector = ChatInspectorPresentation(
      activityID: activityID,
      triggerID: triggerID,
      parentPassage: passage
    )
    readingIntent = .reading
  }

  mutating func dismissInspector() -> (passage: ChatPassageAnchor?, focusID: String)? {
    guard let inspector else { return nil }
    self.inspector = nil
    if let passage = inspector.parentPassage {
      self.passage = passage
      readingIntent = .restoring
    }
    return (inspector.parentPassage, inspector.triggerID)
  }

  @discardableResult
  mutating func beginCommand(id: String, command: ConversationCommand) -> Bool {
    if case .inFlight(let currentID, _) = commandOperation, currentID == id { return false }
    commandOperation = .inFlight(id: id, command: command)
    return true
  }

  @discardableResult
  mutating func reconcileReceipt(
    id: String,
    command: ConversationCommand,
    status: CommandReceiptStatus,
    reason: CommandReceiptReason?
  ) -> Bool {
    switch commandOperation {
    case .accepted(let currentID, _) where currentID == id,
      .rejected(let currentID, _, _) where currentID == id:
      return false
    default:
      break
    }
    switch status {
    case .accepted, .alreadyApplied:
      commandOperation = .accepted(id: id, command: command)
    case .rejected, .unknown:
      commandOperation = .rejected(id: id, command: command, reason: reason)
    }
    return true
  }
}
