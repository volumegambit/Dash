import Foundation
import Testing

@testable import Dash

/// Coverage for the pure, view-independent logic `MessageViews.swift`'s
/// message actions (chat-ux Phase 2, Task 4 / audit #5) are built on:
/// which turns are "failed" (offer Retry) and which user message a failed
/// assistant bubble's inline Retry button should target. The actual
/// `.contextMenu`/inline-button wiring has no ViewInspector-style harness in
/// this repo (same limitation `ChatViewTests.swift` notes for `ChatView`
/// itself), so this is the "contextMenu presence" coverage for Task 4: it
/// pins down exactly which id `ChatMessageView` would compute for
/// `isFailedTurn`/`retryTargetID` — the two inputs that gate whether Retry
/// shows up at all.
@Suite("Message actions: failedTurnIDs / userMessageID (chat-ux Phase 2 Task 4, audit #5)")
struct MessageActionsHelperTests {
  @Test("a turn with a completed assistant reply is not failed")
  func completedTurnIsNotFailed() {
    let messages = [
      userMessage(id: "u1", turnID: "turn-1", text: "Hi"),
      assistantMessage(id: "a1", turnID: "turn-1", status: .completed),
    ]
    #expect(failedTurnIDs(in: messages).isEmpty)
  }

  @Test("a turn whose assistant reply failed is reported, even though the user message's own status is untouched")
  func failedAssistantMarksTheTurnFailed() {
    let messages = [
      userMessage(id: "u1", turnID: "turn-1", text: "Hi", status: .accepted),
      assistantMessage(id: "a1", turnID: "turn-1", status: .failed),
    ]
    #expect(failedTurnIDs(in: messages) == Set(["turn-1"]))
    // The user message's own status is never mutated to `.failed` — see
    // `ChatReducer.reduceFrame`'s `.error` case — so this is genuinely
    // testing the derived signal, not a status the user row already has.
    #expect(messages.first(where: { $0.id == "u1" })?.status == .accepted)
  }

  @Test("only failed turns are reported — a mix of ok and failed turns resolves independently")
  func mixedTranscriptReportsOnlyFailedTurns() {
    let messages = [
      userMessage(id: "u1", turnID: "turn-1", text: "First"),
      assistantMessage(id: "a1", turnID: "turn-1", status: .completed),
      userMessage(id: "u2", turnID: "turn-2", text: "Second"),
      assistantMessage(id: "a2", turnID: "turn-2", status: .failed),
      userMessage(id: "u3", turnID: "turn-3", text: "Third"),
      assistantMessage(id: "a3", turnID: "turn-3", status: .cancelled),
    ]
    #expect(failedTurnIDs(in: messages) == Set(["turn-2"]))
  }

  @Test("a turn with no assistant message yet (still streaming/accepted) is not failed")
  func turnWithoutAssistantMessageIsNotFailed() {
    let messages = [userMessage(id: "u1", turnID: "turn-1", text: "Hi", status: .streaming)]
    #expect(failedTurnIDs(in: messages).isEmpty)
  }

  @Test("userMessageID resolves the user message that started a given turn")
  func userMessageIDResolvesForTurn() {
    let messages = [
      userMessage(id: "u1", turnID: "turn-1", text: "Hi"),
      assistantMessage(id: "a1", turnID: "turn-1", status: .failed),
    ]
    #expect(userMessageID(forTurnID: "turn-1", in: messages) == "u1")
  }

  @Test("userMessageID returns nil for a turn id with no user message (defensive; should not happen in practice)")
  func userMessageIDIsNilWhenMissing() {
    let messages = [assistantMessage(id: "a1", turnID: "turn-1", status: .failed)]
    #expect(userMessageID(forTurnID: "turn-1", in: messages) == nil)
  }
}

@Suite("Message entrance animation signal (chat-ux Phase 3 Task 4 review fix, audit #18)")
struct MessageEntranceSignatureTests {
  @Test(
    "append: a brand-new last message (optimistic send, a finalized reply, edit & resend's truncate-then-resend) changes the signal — fires the entrance transition for the new row"
  )
  func appendChangesSignal() {
    let before = [userMessage(id: "u1", turnID: "t1", text: "Hi")]
    let after = before + [assistantMessage(id: "a1", turnID: "t1", status: .completed)]
    #expect(messageEntranceSignature(for: before) != messageEntranceSignature(for: after))
  }

  @Test(
    "prepend: Load Earlier pagination growing the FRONT of the list (ChatReducer's .olderMessagesLoaded) leaves the signal unchanged — the already-visible rows must not re-animate just because more history loaded behind them"
  )
  func prependLeavesSignalUnchanged() {
    let before = [userMessage(id: "u2", turnID: "t2", text: "Recent")]
    let after = [
      userMessage(id: "u1", turnID: "t1", text: "Older"),
      userMessage(id: "u2", turnID: "t2", text: "Recent"),
    ]
    #expect(before.count != after.count, "sanity: this is genuinely a prepend, not a no-op")
    #expect(messageEntranceSignature(for: before) == messageEntranceSignature(for: after))
  }

  @Test(
    "a content/status mutation to the LAST message (a streamed token, thinking/tool-card delta, or a terminal status flip) leaves the signal unchanged — same id, no re-animation"
  )
  func lastMessageMutationLeavesSignalUnchanged() {
    var message = assistantMessage(id: "a1", turnID: "t1", status: .streaming)
    let before = [message]
    message.status = .completed
    let after = [message]
    #expect(messageEntranceSignature(for: before) == messageEntranceSignature(for: after))
  }

  @Test(
    "initial load: empty-to-non-empty naturally changes the signal (nil to the first message's id), but this is harmless — MessageListView is only ever constructed once `messages` is already non-empty (see ChatView.swift's isEmpty branch), so there is no PREVIOUS render of this view for `.animation(value:)` to diff against for that transition"
  )
  func initialLoadSignalGoesFromNilToTheFirstMessageID() {
    let after = [userMessage(id: "u1", turnID: "t1", text: "Hi")]
    #expect(messageEntranceSignature(for: []) == nil)
    #expect(messageEntranceSignature(for: after) == "u1")
  }
}

private func userMessage(
  id: String,
  turnID: String,
  text: String,
  status: MessageStatus = .completed
) -> ChatMessageState {
  ChatMessageState(
    id: id,
    turnID: turnID,
    ordinal: 1,
    role: .user,
    status: status,
    user: UserMessageProjection(text: text, images: []),
    assistant: nil
  )
}

private func assistantMessage(
  id: String,
  turnID: String,
  status: MessageStatus
) -> ChatMessageState {
  ChatMessageState(
    id: id,
    turnID: turnID,
    ordinal: 2,
    role: .assistant,
    status: status,
    user: nil,
    assistant: AssistantMessageProjection()
  )
}
