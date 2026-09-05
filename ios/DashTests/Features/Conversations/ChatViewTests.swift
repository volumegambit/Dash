import Foundation
import SwiftUI
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
@Suite("ChatScrollGeometry.pinTransition (iOS 18+ pin rules, transcript scroll fix 2026-09-05)")
struct ChatScrollPinTransitionTests {
  @Test("a user scroll that takes the bottom out of view unpins")
  func scrollingAwayUnpins() {
    #expect(ChatScrollGeometry.pinTransition(previousDistance: 0, distance: 40) == false)
    #expect(ChatScrollGeometry.pinTransition(previousDistance: 40, distance: 300) == false)
  }

  @Test("a short drag that keeps the bottom within repinDistance stays pinned")
  func shortDragStaysPinned() {
    #expect(ChatScrollGeometry.pinTransition(previousDistance: 0, distance: 5) == true)
  }

  @Test("scrolling back toward the bottom is not a change until the bottom is back in view")
  func scrollingTowardBottomIsNeutralUntilArrival() {
    #expect(ChatScrollGeometry.pinTransition(previousDistance: 300, distance: 120) == nil)
    #expect(ChatScrollGeometry.pinTransition(previousDistance: 120, distance: 7) == true)
  }

  @Test("a rubber-band bounce back to the end after over-scrolling does not unpin")
  func rubberBandBounceDoesNotUnpin() {
    #expect(ChatScrollGeometry.pinTransition(previousDistance: -40, distance: 0) == true)
    #expect(ChatScrollGeometry.pinTransition(previousDistance: -40, distance: -10) == true)
  }

  @Test("no movement is no change")
  func noMovementIsNoChange() {
    #expect(ChatScrollGeometry.pinTransition(previousDistance: 200, distance: 200) == nil)
  }
}

@Suite("ChatScrollGeometry.viewportChangeNeedsRepin (keyboard/composer/rotation, iOS 18+)")
struct ChatScrollViewportChangeTests {
  @Test("the keyboard shrinking the viewport while the tail slides out of view re-pins")
  func keyboardRiseRepins() {
    let before = TranscriptScrollMetrics(distanceFromBottom: 0, viewportHeight: 700)
    let after = TranscriptScrollMetrics(distanceFromBottom: 300, viewportHeight: 400)
    #expect(ChatScrollGeometry.viewportChangeNeedsRepin(previous: before, current: after))
  }

  @Test("a content-only change (a streamed token) is the anchor's job, never a scrollTo")
  func contentGrowthDoesNotRepin() {
    let before = TranscriptScrollMetrics(distanceFromBottom: 0, viewportHeight: 700)
    let after = TranscriptScrollMetrics(distanceFromBottom: 24, viewportHeight: 700)
    #expect(ChatScrollGeometry.viewportChangeNeedsRepin(previous: before, current: after) == false)
  }

  @Test("a viewport change that leaves the tail in view (keyboard dismissing) needs nothing")
  func keyboardDismissDoesNotRepin() {
    let before = TranscriptScrollMetrics(distanceFromBottom: 0, viewportHeight: 400)
    let after = TranscriptScrollMetrics(distanceFromBottom: 0.4, viewportHeight: 700)
    #expect(ChatScrollGeometry.viewportChangeNeedsRepin(previous: before, current: after) == false)
  }
}

@Suite("ChatScrollGeometry.isPinnedAtGestureEnd / holdAnchor (transcript scroll fix 2026-09-05)")
struct ChatScrollGestureEndAndHoldTests {
  @Test(
    "distanceFromBottom adds the bottom inset back: visibleRect reaches under the composer, so the tail at the composer's top edge is distance 0, not -inset"
  )
  func distanceAccountsForTheBottomInset() {
    // Measured on the iOS 26.5 sim at the very top of a 4626.7pt transcript
    // with a 611pt frame and insets (top 116, bottom 147): visibleRect =
    // (-116 ..< 758).
    #expect(
      ChatScrollGeometry.distanceFromBottom(contentHeight: 4626.7, visibleMaxY: 758, bottomInset: 147)
        == 4015.7
    )
    // At the true bottom visibleRect.maxY == contentHeight + bottomInset.
    #expect(
      ChatScrollGeometry.distanceFromBottom(contentHeight: 1000, visibleMaxY: 1147, bottomInset: 147)
        == 0
    )
  }

  @Test("a gesture that ends with the bottom in view leaves the transcript pinned; away from it, unpinned")
  func gestureEnd() {
    #expect(ChatScrollGeometry.isPinnedAtGestureEnd(distance: 0))
    #expect(ChatScrollGeometry.isPinnedAtGestureEnd(distance: -30))
    #expect(ChatScrollGeometry.isPinnedAtGestureEnd(distance: 60) == false)
  }

  @Test("the hold anchor reproduces the row's previous viewport position: t = minY / (viewport - rowHeight)")
  func holdAnchorReproducesPosition() {
    let anchor = ChatScrollGeometry.holdAnchor(
      rowFrame: CGRect(x: 0, y: 72, width: 300, height: 100),
      viewportHeight: 700
    )
    #expect(anchor.x == 0)
    #expect(abs(anchor.y - 0.12) < 0.0001)
  }

  @Test("a row taller than the viewport, or one that started above it, falls back to .top")
  func holdAnchorFallbacks() {
    #expect(
      ChatScrollGeometry.holdAnchor(
        rowFrame: CGRect(x: 0, y: 40, width: 300, height: 900),
        viewportHeight: 700
      ) == .top
    )
    #expect(
      ChatScrollGeometry.holdAnchor(
        rowFrame: CGRect(x: 0, y: -20, width: 300, height: 100),
        viewportHeight: 700
      ) == .top
    )
  }

  @Test("the anchor never exceeds the viewport (clamped to 1)")
  func holdAnchorClamps() {
    let anchor = ChatScrollGeometry.holdAnchor(
      rowFrame: CGRect(x: 0, y: 690, width: 300, height: 100),
      viewportHeight: 700
    )
    #expect(anchor.y == 1)
  }
}

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
