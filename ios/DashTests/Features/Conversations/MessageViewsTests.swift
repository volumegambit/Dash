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
