import Foundation
import Testing

@testable import Dash

/// Reducer/view-model-level coverage for audit #4 (chat-ux Phase 2, Task 3):
/// the two `ChatView.swift` pieces that are pure enough to unit test without
/// rendering SwiftUI. `ChatView` itself (its `@State isNearBottom`, the
/// `ScrollViewReader`/`PreferenceKey` wiring) has no ViewInspector-style
/// harness in this repo, so the genuinely view-only plumbing is instead
/// covered by `ConversationUITests`' `testJumpToBottomAppearsAfterScrollingUp
/// AndRestoresPinningOnTap` UI smoke test.
@Suite("ChatTranscriptSignature")
struct ChatTranscriptSignatureTests {
  @Test("an empty transcript signs as the nil/zero baseline")
  func emptyTranscript() {
    let signature = ChatTranscriptSignature.of([])
    #expect(signature == ChatTranscriptSignature(messageID: nil, status: nil, contentCount: 0))
  }

  @Test("changes when the last message's id changes (a new message arrived)")
  func changesOnNewLastMessage() {
    let before = ChatTranscriptSignature.of([assistantMessage(id: "a-1")])
    let after = ChatTranscriptSignature.of([assistantMessage(id: "a-1"), assistantMessage(id: "a-2")])
    #expect(before != after)
  }

  @Test("changes when the last message's status transitions (e.g. streaming -> completed)")
  func changesOnStatusTransition() {
    let before = ChatTranscriptSignature.of([assistantMessage(id: "a-1", status: .streaming)])
    let after = ChatTranscriptSignature.of([assistantMessage(id: "a-1", status: .completed)])
    #expect(before != after)
  }

  @Test("changes when a token/tool/thinking delta grows the last message's content")
  func changesOnStreamedContentGrowth() {
    let before = ChatTranscriptSignature.of([
      assistantMessage(id: "a-1", status: .streaming, text: "Hel")
    ])
    let after = ChatTranscriptSignature.of([
      assistantMessage(id: "a-1", status: .streaming, text: "Hello there")
    ])
    #expect(before != after)
  }

  @Test("changes when a tool card, worker card, or status row is appended, not just text")
  func changesOnNonTextContentGrowth() {
    let before = ChatTranscriptSignature.of([assistantMessage(id: "a-1")])
    let after = ChatTranscriptSignature.of([
      assistantMessage(id: "a-1", toolCards: [toolCard(id: "tool-1")])
    ])
    #expect(before != after)
  }

  @Test(
    """
    ignores mutations to any message OTHER than the last one — this is the whole point of the \
    audit #4 fix: the old O(n) transcriptSignature joined every message's fields on every body \
    evaluation, but scroll-follow only ever needs to react to the newest message
    """
  )
  func ignoresEarlierMessageMutations() {
    let before = ChatTranscriptSignature.of([
      assistantMessage(id: "a-1", status: .completed, text: "first reply"),
      assistantMessage(id: "a-2", status: .completed, text: "second reply"),
    ])
    // Only the EARLIER message's content grows; the last message is
    // untouched.
    let after = ChatTranscriptSignature.of([
      assistantMessage(id: "a-1", status: .completed, text: "first reply, edited and much longer"),
      assistantMessage(id: "a-2", status: .completed, text: "second reply"),
    ])
    #expect(before == after)
  }
}

@Suite("ChatScrollGeometry.isNearBottom (iOS 17 fallback predicate, audit #4)")
struct ChatScrollGeometryTests {
  @Test("the sentinel sitting well inside the viewport counts as near-bottom")
  func sentinelWellInsideViewport() {
    #expect(ChatScrollGeometry.isNearBottom(sentinelMinY: 200, viewportHeight: 800))
  }

  @Test("the sentinel sitting far below the viewport's bottom edge is NOT near-bottom")
  func sentinelFarBelowViewport() {
    // 800 (viewport) + 100 (threshold) = 900 is the cutoff; 950 is past it.
    #expect(ChatScrollGeometry.isNearBottom(sentinelMinY: 950, viewportHeight: 800) == false)
  }

  @Test("the boundary exactly at viewportHeight + threshold is inclusive (still near-bottom)")
  func boundaryIsInclusive() {
    #expect(ChatScrollGeometry.isNearBottom(sentinelMinY: 900, viewportHeight: 800))
  }

  @Test("a custom threshold is honored instead of the default 100pt")
  func customThreshold() {
    #expect(
      ChatScrollGeometry.isNearBottom(sentinelMinY: 850, viewportHeight: 800, threshold: 25)
        == false
    )
    #expect(ChatScrollGeometry.isNearBottom(sentinelMinY: 820, viewportHeight: 800, threshold: 25))
  }

  @Test(
    """
    regression guard for the exact iOS 17 bug (audit #4): a user scrolled far up a long \
    transcript — the sentinel sits thousands of points below the viewport — must resolve to \
    NOT-near-bottom rather than the old code's permanent `true`, which force-scrolled every \
    token delta back to the bottom regardless of scroll position
    """
  )
  func scrolledAwayFromBottomIsNeverMisreportedAsNearBottom() {
    #expect(
      ChatScrollGeometry.isNearBottom(sentinelMinY: 6000, viewportHeight: 800) == false
    )
  }
}

/// Audit #15 (iOS chat-screen toolbar): `ChatTranscriptExport.plainText`
/// backs the toolbar Menu's "Share Transcript" `ShareLink`.
@Suite("ChatTranscriptExport (audit #15)")
struct ChatTranscriptExportTests {
  @Test("renders a user/assistant pair with You:/Assistant: prefixes")
  func rendersUserAndAssistantTurns() {
    let text = ChatTranscriptExport.plainText(for: [
      userMessage(id: "u-1", text: "What's the launch date?"),
      assistantMessage(id: "a-1", text: "The launch date is March 3rd."),
    ])
    #expect(
      text == "You: What's the launch date?\n\nAssistant: The launch date is March 3rd."
    )
  }

  @Test("strips markdown syntax from assistant text via the VoiceOver plain-text helper")
  func stripsMarkdownFromAssistantText() {
    let text = ChatTranscriptExport.plainText(for: [
      assistantMessage(id: "a-1", text: "**Ship it** now with `flag=true`")
    ])
    #expect(text.contains("**") == false)
    #expect(text.contains("Ship it now with flag=true"))
  }

  @Test("drops messages with no renderable text instead of emitting an empty line")
  func dropsEmptyMessages() {
    let text = ChatTranscriptExport.plainText(for: [
      userMessage(id: "u-1", text: "  "),
      assistantMessage(id: "a-1", text: ""),
      userMessage(id: "u-2", text: "Real question"),
    ])
    #expect(text == "You: Real question")
  }

  @Test("an empty transcript exports to an empty string")
  func emptyTranscriptExportsEmptyString() {
    #expect(ChatTranscriptExport.plainText(for: []).isEmpty)
  }

  @Test("preserves message order across multiple turns")
  func preservesOrder() {
    let text = ChatTranscriptExport.plainText(for: [
      userMessage(id: "u-1", text: "First"),
      assistantMessage(id: "a-1", text: "Second"),
      userMessage(id: "u-2", text: "Third"),
    ])
    #expect(text == "You: First\n\nAssistant: Second\n\nYou: Third")
  }

  // MARK: - Fidelity markers (final-review fix I3)

  @Test("prefixes a disclosure line when hasOlderMessages is true (unpaginated earlier history)")
  func prefixesOlderMessagesDisclosure() {
    let text = ChatTranscriptExport.plainText(
      for: [userMessage(id: "u-1", text: "Where were we?")],
      hasOlderMessages: true
    )
    #expect(text == "(Earlier messages not included)\n\nYou: Where were we?")
  }

  @Test("omits the disclosure line when hasOlderMessages is false (the default)")
  func omitsOlderMessagesDisclosureByDefault() {
    let text = ChatTranscriptExport.plainText(for: [userMessage(id: "u-1", text: "Hello")])
    #expect(text == "You: Hello")
  }

  @Test("does not prefix a disclosure line for an otherwise-empty export, even with hasOlderMessages true")
  func noDisclosurePrefixWhenNothingToExport() {
    let text = ChatTranscriptExport.plainText(for: [], hasOlderMessages: true)
    #expect(text.isEmpty)
  }

  @Test("marks a completed assistant turn with no suffix")
  func completedAssistantTurnHasNoMarker() {
    let text = ChatTranscriptExport.plainText(for: [
      assistantMessage(id: "a-1", status: .completed, text: "All done.")
    ])
    #expect(text == "Assistant: All done.")
  }

  @Test("marks a cancelled/failed/interrupted assistant turn with a trailing (interrupted) suffix")
  func nonCompletedAssistantTurnsAreMarkedInterrupted() {
    for status: MessageStatus in [.cancelled, .failed, .interrupted, .streaming, .accepted] {
      let text = ChatTranscriptExport.plainText(for: [
        assistantMessage(id: "a-1", status: status, text: "Partial reply")
      ])
      #expect(text == "Assistant: Partial reply (interrupted)", "status: \(status)")
    }
  }

  @Test("a completed turn followed by an interrupted one only marks the interrupted turn")
  func onlyInterruptedTurnsAreMarked() {
    let text = ChatTranscriptExport.plainText(for: [
      assistantMessage(id: "a-1", status: .completed, text: "First reply"),
      userMessage(id: "u-1", text: "Follow-up"),
      assistantMessage(id: "a-2", status: .cancelled, text: "Cut off"),
    ])
    #expect(
      text == "Assistant: First reply\n\nYou: Follow-up\n\nAssistant: Cut off (interrupted)"
    )
  }
}

private func userMessage(id: String, text: String) -> ChatMessageState {
  ChatMessageState(
    id: id,
    turnID: "turn-1",
    ordinal: 1,
    role: .user,
    status: .completed,
    user: UserMessageProjection(text: text, images: []),
    assistant: nil
  )
}

private func assistantMessage(
  id: String,
  status: MessageStatus = .completed,
  text: String = "",
  toolCards: [ToolCardState] = []
) -> ChatMessageState {
  var assistant = AssistantMessageProjection()
  assistant.text = text
  assistant.toolCards = toolCards
  return ChatMessageState(
    id: id,
    turnID: "turn-1",
    ordinal: 1,
    role: .assistant,
    status: status,
    user: nil,
    assistant: assistant
  )
}

private func toolCard(id: String) -> ToolCardState {
  ToolCardState(
    id: id,
    name: "bash",
    input: nil,
    partialJSON: "",
    status: .running,
    content: nil,
    details: nil
  )
}
