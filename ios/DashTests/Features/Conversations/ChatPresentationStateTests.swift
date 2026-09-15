import Foundation
import Testing

@testable import Dash

@Suite("Chat presentation state")
struct ChatPresentationStateTests {
  private let passage = ChatPassageAnchor(
    rowID: "row-42",
    blockID: "paragraph-3",
    textMarker: "migration",
    fraction: 0.4,
    screenY: 180
  )

  @Test("remote work never changes reader intent or creates a reveal")
  func remoteWorkIsPassive() {
    var state = ChatPresentationState(readingIntent: .reading, passage: passage)

    state.receive(.turn, remote: true)
    state.receive(.token, remote: true)

    #expect(state.readingIntent == .reading)
    #expect(state.passage == passage)
    #expect(state.reveal == nil)
    #expect(state.unreadMeaningfulUpdates == 1)
  }

  @Test("a local exchange reveals once and can return to the displaced passage")
  func localRevealIsOneShot() {
    var state = ChatPresentationState(readingIntent: .reading, passage: passage)

    let firstReveal = state.revealLocalExchange(commandID: "command-1")
    let duplicateReveal = state.revealLocalExchange(commandID: "command-1")
    #expect(firstReveal)
    #expect(duplicateReveal == false)
    #expect(state.readingIntent == .reading)
    #expect(state.backToReading() == passage)
    #expect(state.readingIntent == .restoring)
  }

  @Test("sending from the latest message keeps following the streamed response")
  func localRevealWhileFollowingStaysPinned() {
    var state = ChatPresentationState(readingIntent: .following, passage: passage)

    let revealed = state.revealLocalExchange(commandID: "command-1")
    #expect(revealed)
    #expect(state.readingIntent == .following)
    #expect(state.reveal?.displacedPassage == nil)
  }

  @Test("Latest is the only explicit recapture and clears meaningful unread work")
  func latestRecaptures() {
    var state = ChatPresentationState(readingIntent: .reading, passage: passage)
    state.receive(.question, remote: false)
    state.receive(.completion, remote: true)

    state.showLatest()

    #expect(state.readingIntent == .following)
    #expect(state.unreadMeaningfulUpdates == 0)
    #expect(state.passage == nil)
  }

  @Test("inspector dismissal restores its passage and trigger")
  func inspectorRestoresContext() throws {
    var state = ChatPresentationState(readingIntent: .reading, passage: passage)
    state.openInspector(activityID: "activity-1", triggerID: "activity-button-1")

    let dismissed = state.dismissInspector()
    let restoration = try #require(dismissed)

    #expect(restoration.passage == passage)
    #expect(restoration.focusID == "activity-button-1")
    #expect(state.readingIntent == .restoring)
  }

  @Test("control priority keeps one truthful highest-priority strip")
  func controlPriority() {
    var state = ChatPresentationState(
      execution: .working,
      pendingScheduling: .paused,
      pendingCount: 3
    )
    #expect(state.controlPriority == .pausedPending(count: 3))

    state.execution = .stopping(commandID: "stop-1")
    #expect(state.controlPriority == .stopping)

    state.recoveryMessage = "Reconnect to confirm Stop"
    #expect(state.controlPriority == .recovery(message: "Reconnect to confirm Stop"))

    state.execution = .needsInput(count: 2)
    #expect(state.controlPriority == .requiredInput(count: 2))
  }

  @Test("receipt reconciliation is idempotent by command id")
  func receiptIsIdempotent() {
    var state = ChatPresentationState()
    let began = state.beginCommand(id: "follow-1", command: .followUp)
    let accepted = state.reconcileReceipt(
      id: "follow-1",
      command: .followUp,
      status: .accepted,
      reason: nil
    )
    let duplicate = state.reconcileReceipt(
      id: "follow-1",
      command: .followUp,
      status: .alreadyApplied,
      reason: nil
    )
    #expect(began)
    #expect(accepted)
    #expect(duplicate == false)
  }

  @Test("window drafts are independent and an old acknowledgement preserves newer typing")
  func windowDraftsAreRevisionSafe() {
    var first = ChatWindowDraftState()
    var second = ChatWindowDraftState()
    first.seed(text: "Recovered", windowID: "window-a")
    second.seed(text: "", windowID: "window-b")

    first.edit("First message")
    _ = first.beginSubmission()
    first.edit("Typed after Send")
    first.acknowledgeSubmission()

    #expect(first.text == "Typed after Send")
    #expect(second.text.isEmpty)
    #expect(first.windowID == "window-a")
    #expect(second.windowID == "window-b")
  }

  @Test("an acknowledgement clears the submitted revision")
  func exactDraftRevisionClears() {
    var draft = ChatWindowDraftState()
    draft.seed(text: "", windowID: "window-a")
    draft.edit("Send me")
    _ = draft.beginSubmission()

    draft.acknowledgeSubmission()

    #expect(draft.text.isEmpty)
    #expect(draft.submittedRevision == nil)
  }

  @Test("attachments and acknowledgements stay in their source window")
  func attachmentsAreWindowOwned() {
    let firstAttachment = PreparedAttachment(
      id: UUID(),
      mediaType: "image/png",
      data: Data([1])
    )
    let secondAttachment = PreparedAttachment(
      id: UUID(),
      mediaType: "image/png",
      data: Data([2])
    )
    var first = ChatWindowDraftState()
    var second = ChatWindowDraftState()
    first.seed(text: "First", attachments: [firstAttachment], windowID: "window-a")
    second.seed(text: "Second", attachments: [secondAttachment], windowID: "window-b")
    let submittedRevision = first.beginSubmission()

    let applied = second.apply(
      ChatWindowDraftResolution(
        commandID: "command-1",
        sourceWindowID: "window-a",
        submittedRevision: submittedRevision,
        accepted: true
      )
    )

    #expect(applied == false)
    #expect(first.attachments == [firstAttachment])
    #expect(second.text == "Second")
    #expect(second.attachments == [secondAttachment])
  }
}
