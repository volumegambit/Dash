import SwiftUI

/// The sub-agent row (§8.1), its parallel-group container (§8.2) and its
/// expanded nested transcript with composer (§8.3).
///
/// Built from the same primitives as `ToolCardView` in `EventViews.swift` — a
/// bordered card, a mono label, a status glyph, a `withAnimation(reduceMotion
/// ? nil : .snappy)` disclosure and `.sensoryFeedback(.selection,)` — so a
/// child reads as part of the same transcript rather than a second visual
/// language. The web twin is `apps/web/src/ui/blocks/SubagentBlock.tsx`.
///
/// Three structural rules, all of them easy to regress:
///
/// 1. **Nothing here holds per-row state that a re-projection would destroy.**
///    Expansion, the fetched child transcript and `oneShot` live in
///    `ChatState.subagentUI`, reached through `SubagentInteraction`, because
///    `ChatReducer` re-projects whole messages from scratch on every
///    `cachedMessagesLoaded` (three call sites, including the post-reconnect
///    canonical snapshot). The only `@State` in this file is the composer's
///    text, which is discussed on `SubagentUIState`.
/// 2. **`nested` is the depth guard.** A row inside a child's transcript still
///    renders — a grandchild must never vanish or degrade to nothing — but it
///    neither fetches nor shows a transcript of its own. See
///    `maxSubagentDepth`.
/// 3. **The identifier and the accessible label sit on the same `.contain`
///    container.** A container's accessibility identifier erases its
///    children's, so moving either would leave `chat.subagent.<id>` answering
///    from an element that no longer carries the label the UI tests read.

/// Matches web's `MAX_SUBAGENT_DEPTH` (`ContentBlocks.tsx:33`).
///
/// §8.3 says nesting is "unlimited by the renderer". Both clients cap it at
/// one level instead, with visible dead-end copy where a grandchild's
/// transcript would be, and the divergence is deliberate: every level holds a
/// live subscription and a REST read, an unbounded renderer recurses on data
/// the server controls, and on a phone a doubly-indented transcript is
/// unreadable anyway. Recorded as a divergence rather than silently applied.
let maxSubagentDepth = 1

/// Exact copy shown where a grandchild's transcript would be. Byte-identical
/// to web's dead-end line.
let subagentDeadEndCopy = "Nested agents this deep are not opened here."

/// Exact copy on a body composer that cannot send. Byte-identical to web's
/// `ONE_SHOT_COMPOSER_TITLE`.
let oneShotComposerTitle = "One-shot agents cannot be resumed"

/// Everything a rendered sub-agent row needs from outside the transcript.
///
/// A struct of closures rather than a reference to `ChatFeature`, for the same
/// reason `AssistantEventViews` takes `onAnswer`: `EventViews`/`MessageViews`
/// are constructed directly by `DashTests` with no feature behind them, and an
/// `@Observable` feature threaded down here would also make every row observe
/// every unrelated state change.
@MainActor
struct SubagentInteraction {
  /// Current UI state for one child. Never `nil` — an unvisited child reads as
  /// a default `SubagentUIState`, which is "collapsed, never fetched".
  var state: (String) -> SubagentUIState
  var setExpanded: (String, Bool) -> Void
  /// `optimistic` is the CALLER's choice, taken only where a subscription is
  /// held for that child — see `SubagentCardView`'s two call sites. Returns
  /// whether the gateway accepted it, which is the ONLY thing that clears the
  /// composer: a refused sentence stays where the user can edit it.
  var send: (_ childID: String, _ text: String, _ optimistic: Bool) async -> Bool
  /// False only for a dead credential. **Not** gated on socket state: the send
  /// is REST, and a reconnect must not stop the user answering a child parked
  /// in `waiting_input`, whose `waitForQuestion` fails the child's tool call
  /// after ten minutes.
  var isEnabled: Bool

  /// For previews, `DashTests` and any caller with no feature behind it. No
  /// composer is offered, because nothing would carry the text anywhere.
  static let inert = SubagentInteraction(
    state: { _ in SubagentUIState() },
    setExpanded: { _, _ in },
    send: { _, _, _ in false },
    isEnabled: false
  )
}

/// One parallel cluster (§8.2). A cluster of one renders as a bare row; two or
/// more gain the group chrome — a summary line, a per-child dot strip and a
/// collapse-as-a-unit toggle.
///
/// Groups default to OPEN, so the toggle's `@State` seed is `true`. Unlike the
/// per-row disclosure this genuinely is view-local: it is derived from the
/// cluster's own membership, which is recomputed from the event stream on
/// every projection, so there is nothing durable to key it by.
struct SubagentGroupView: View {
  let cards: [SubagentCardState]
  let nested: Bool
  let interaction: SubagentInteraction

  @State private var isExpanded = true
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    if cards.count <= 1 {
      ForEach(cards) { card in
        SubagentCardView(card: card, nested: nested, interaction: interaction)
      }
    } else {
      VStack(alignment: .leading, spacing: 8) {
        Button {
          withAnimation(reduceMotion ? nil : .snappy) {
            isExpanded.toggle()
          }
        } label: {
          HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(SubagentFormat.clusterSummary(cards.map(\.status)))
              .font(.caption.weight(.medium))
              .foregroundStyle(.secondary)
            HStack(spacing: 4) {
              ForEach(cards) { card in
                Circle()
                  .fill(card.status.dotColor)
                  .frame(width: 6, height: 6)
              }
            }
            .accessibilityHidden(true)
            Spacer(minLength: 0)
            Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
              .font(.caption2)
              .foregroundStyle(.secondary)
          }
        }
        .buttonStyle(.plain)

        if isExpanded {
          ForEach(cards) { card in
            SubagentCardView(card: card, nested: nested, interaction: interaction)
          }
        }
      }
      .accessibilityElement(children: .contain)
      .accessibilityLabel(SubagentFormat.clusterSummary(cards.map(\.status)))
      .accessibilityIdentifier("chat.subagentGroup.\(cards[0].id)")
      .sensoryFeedback(.selection, trigger: isExpanded)
    }
  }
}

/// One child, collapsed to a single scannable line until it is opened (§8.1).
struct SubagentCardView: View {
  let card: SubagentCardState
  /// False inside a child transcript: the row renders, but its body opens no
  /// transcript of its own (`maxSubagentDepth`).
  let nested: Bool
  let interaction: SubagentInteraction

  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  init(
    card: SubagentCardState,
    nested: Bool = true,
    interaction: SubagentInteraction = .inert
  ) {
    self.card = card
    self.nested = nested
    self.interaction = interaction
  }

  private var ui: SubagentUIState { interaction.state(card.id) }
  private var isExpanded: Bool { ui.isExpanded }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Button {
        // Same gating and idiom as `ToolCardView`'s disclosure. The write goes
        // to the reducer, not to `@State`: this row is rebuilt from scratch by
        // every transcript refresh.
        withAnimation(reduceMotion ? nil : .snappy) {
          interaction.setExpanded(card.id, !isExpanded)
        }
      } label: {
        header
      }
      .buttonStyle(.plain)
      .accessibilityIdentifier("chat.subagent.\(card.id).header")

      if let collapsedReport, isExpanded == false {
        Text(collapsedReport)
          .font(.caption)
          .foregroundStyle(.secondary)
          .lineLimit(1)
          .truncationMode(.tail)
      }

      // §8.1's second line. Gated on the card's `question`, which the fold
      // already clears the moment the row goes terminal by EITHER path — an
      // explicit terminal event or end-of-stream cancellation — so a dead
      // child can never carry a live reply affordance.
      if let question = card.question, question.isEmpty == false {
        waitingReply(question: question)
      }

      if isExpanded {
        expandedBody
      }

      if let error = ui.lastError {
        Text(error)
          .font(.caption)
          .foregroundStyle(DashTheme.danger)
          .accessibilityIdentifier("chat.subagent.\(card.id).error")
      }
    }
    .padding(10)
    .background(
      Color.secondary.opacity(DashTheme.Opacity.fillSubtle),
      in: RoundedRectangle(cornerRadius: DashTheme.Radius.medium)
    )
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Agent \(card.type), \(card.status.title)")
    .accessibilityIdentifier("chat.subagent.\(card.id)")
    .sensoryFeedback(.selection, trigger: isExpanded)
  }

  // MARK: - Collapsed row

  private var header: some View {
    HStack(alignment: .firstTextBaseline, spacing: 6) {
      SubagentStatusGlyph(status: card.status)
      Text(card.type.isEmpty ? "agent" : card.type)
        .font(.callout.monospaced())
        .foregroundStyle(.primary)
      if let name = card.name, name.isEmpty == false {
        Text(name)
          .font(.caption.weight(.medium))
          .foregroundStyle(.secondary)
      }
      Text(card.description)
        .font(.caption)
        .foregroundStyle(.secondary)
        .lineLimit(1)
        .truncationMode(.tail)
      Spacer(minLength: 4)
      SubagentMetaView(card: card)
    }
  }

  /// The report's first line, shown on a COLLAPSED terminal row (§8.3).
  private var collapsedReport: String? {
    guard card.status.isTerminal, let report = card.report else { return nil }
    let first = report.split(separator: "\n", omittingEmptySubsequences: false).first.map(String.init)
    guard let first, first.trimmingCharacters(in: .whitespaces).isEmpty == false else { return nil }
    return first
  }

  // MARK: - Composers

  /// The inline reply on a `waiting_input` row.
  ///
  /// Enabled even for a ONE-SHOT child: `coordinator.sendToChild` exempts a
  /// live child with a pending question from the one-shot refusal — swarm was
  /// fixed on this branch precisely so a one-shot child parked on
  /// `ask_orchestrator` can be answered by somebody. Only the BODY composer,
  /// which steers, stays disabled.
  private func waitingReply(question: String) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Label(question, systemImage: "questionmark.bubble")
        .font(.callout)
      SubagentComposer(
        identifier: "chat.subagent.\(card.id).reply",
        placeholder: "Reply…",
        isEnabled: interaction.isEnabled,
        isSending: ui.isSending
      ) { text in
        // NOT optimistic. An answer to `ask_orchestrator` usually resolves
        // inside the child's running turn and produces no `accepted` at all,
        // and this row may be collapsed — in which case no subscription is
        // held and no echo could reach us even for the queued-steer case a
        // resolved question falls through to. An unreconcilable optimistic row
        // is a permanent duplicate; web reached the same rule.
        await interaction.send(card.id, text, false)
      }
    }
  }

  // MARK: - Expanded body (§8.3)

  @ViewBuilder
  private var expandedBody: some View {
    VStack(alignment: .leading, spacing: 8) {
      if nested {
        SubagentTranscriptView(
          childID: card.id,
          messages: ui.childMessages,
          interaction: interaction
        )
      } else if card.report == nil {
        Text(subagentDeadEndCopy)
          .font(.caption)
          .foregroundStyle(.secondary)
          .accessibilityIdentifier("chat.subagent.\(card.id).deadEnd")
      }

      if let report = card.report, report.isEmpty == false {
        MarkdownTextView(text: report)
          .accessibilityElement(children: .combine)
          .accessibilityIdentifier("chat.subagent.\(card.id).report")
      }

      if let usage = card.usage {
        UsageView(usage: usage)
      }

      if nested {
        SubagentComposer(
          identifier: "chat.subagent.\(card.id).composer",
          placeholder: ui.oneShot == true ? oneShotComposerTitle : "Type into this agent…",
          // `oneShot == nil` means NOT YET KNOWN (it rides REST, never an
          // event). Enabled on unknown, deliberately: refusing on a guess is
          // worse than letting the coordinator's own 409 text land on the
          // error line, which is what §8.3's "shows the reason" asks for.
          isEnabled: interaction.isEnabled && ui.oneShot != true,
          isSending: ui.isSending
        ) { text in
          // Optimistic: the body is open, which on iOS is exactly the
          // condition under which a child subscription is held, so an
          // `accepted` can come back to reconcile the row.
          await interaction.send(card.id, text, true)
        }
      }
    }
    .padding(.leading, 10)
    .overlay(alignment: .leading) {
      // The §8.3 nesting rail.
      Rectangle()
        .fill(Color.secondary.opacity(DashTheme.Opacity.fillEmphasis))
        .frame(width: 2)
        .accessibilityHidden(true)
    }
  }
}

/// The child's own messages, through the same components the parent uses
/// (§8.3): `OrchestratorRowView`/`NotificationRowView` for the rows the user
/// did not write, and `AssistantEventViews` for everything the child said.
private struct SubagentTranscriptView: View {
  let childID: String
  let messages: [ChatMessageState]?
  let interaction: SubagentInteraction

  var body: some View {
    if let messages {
      if messages.isEmpty {
        Text("Nothing from this agent yet.")
          .font(.caption)
          .foregroundStyle(.secondary)
      } else {
        VStack(alignment: .leading, spacing: 8) {
          ForEach(messages) { message in
            SubagentTranscriptRow(
              childID: childID,
              message: message,
              interaction: interaction
            )
          }
        }
      }
    } else {
      Text("Loading this agent's transcript…")
        .font(.caption)
        .foregroundStyle(.secondary)
        .accessibilityIdentifier("chat.subagent.\(childID).loading")
    }
  }
}

private struct SubagentTranscriptRow: View {
  let childID: String
  let message: ChatMessageState
  let interaction: SubagentInteraction

  var body: some View {
    switch message.role {
    case .user where isOrchestratorRow(message):
      OrchestratorRowView(message: message)

    case .user where isNotificationRow(message):
      NotificationRowView(message: message)

    case .user:
      // A child transcript's `role: .user` rows are all parent-authored in
      // practice, but a row replayed from a gateway that predates `origin`
      // carries none — and an unattributed row must still show its text
      // rather than disappear. No bubble and no context menu either way: the
      // one thing that must never be reachable here is Retry/Edit on words the
      // user did not write.
      Text(message.user?.text ?? "")
        .font(.footnote)
        .frame(maxWidth: .infinity, alignment: .leading)

    case .assistant:
      if let assistant = message.assistant {
        AssistantEventViews(
          projection: assistant,
          status: message.status,
          // A child's own `ask_user` question is answered by the ORCHESTRATOR,
          // not by this client: there is no turn on this socket to answer
          // against.
          isAnsweringEnabled: false,
          exposesResponseToAccessibility: false,
          // Namespaced so a nested tool card cannot collide with a
          // same-id card in the parent's transcript (§8.6).
          identifierPrefix: "chat.subagent.\(childID)",
          // Depth guard: a grandchild row renders, but opens nothing.
          subagentNesting: false,
          subagentInteraction: interaction
        )
      }
    }
  }
}

/// §8.1's right-aligned meta, `12 tool uses · 1m 12s`.
///
/// Elapsed derives from `startedAt`/`endedAt` and NOTHING else. A terminal row
/// with no `endedAt` — a legacy-only `worker_done` child, or one
/// end-of-stream-terminalized to `cancelled` — renders no time at all, never
/// the row's own age, because the row's age keeps growing while the child has
/// been dead for an hour. The fold discards `subagent_progress.elapsedMs` for
/// the same reason: one source, not two that disagree.
private struct SubagentMetaView: View {
  let card: SubagentCardState

  var body: some View {
    if card.status.isTerminal {
      Text(SubagentFormat.meta(toolCallCount: card.toolCallCount, elapsedMs: frozenElapsedMs))
        .font(.caption.monospacedDigit())
        .foregroundStyle(.secondary)
    } else if let startedAt = card.startedAt {
      // Ticks while the child is live (§8.1). `TimelineView` re-evaluates the
      // text, it does not animate anything, so it needs no reduce-motion gate.
      TimelineView(.periodic(from: startedAt, by: 1)) { context in
        Text(
          SubagentFormat.meta(
            toolCallCount: card.toolCallCount,
            elapsedMs: Int(max(0, context.date.timeIntervalSince(startedAt)) * 1000)
          )
        )
        .font(.caption.monospacedDigit())
        .foregroundStyle(.secondary)
      }
    } else {
      Text(SubagentFormat.toolCount(card.toolCallCount))
        .font(.caption.monospacedDigit())
        .foregroundStyle(.secondary)
    }
  }

  private var frozenElapsedMs: Int? {
    guard let startedAt = card.startedAt, let endedAt = card.endedAt else { return nil }
    return Int(max(0, endedAt.timeIntervalSince(startedAt)) * 1000)
  }
}

private struct SubagentStatusGlyph: View {
  let status: SubagentCardStatus

  var body: some View {
    switch status {
    case .running:
      ProgressView()
        .controlSize(.mini)
        .frame(width: 12, height: 12)
    case .waiting:
      Image(systemName: "questionmark.circle")
        .font(.system(size: 10))
        .foregroundStyle(DashTheme.accent)
    case .done:
      Circle().fill(DashTheme.success).frame(width: 8, height: 8)
    case .failed:
      Image(systemName: "xmark.circle")
        .font(.system(size: 10))
        .foregroundStyle(DashTheme.danger)
    case .cancelled:
      Image(systemName: "nosign")
        .font(.system(size: 10))
        .foregroundStyle(.secondary)
    case .interrupted:
      Image(systemName: "pause.circle")
        .font(.system(size: 10))
        .foregroundStyle(.secondary)
    case .maxTurns:
      Image(systemName: "hourglass")
        .font(.system(size: 10))
        .foregroundStyle(.secondary)
    }
  }
}

/// One-line composer for a child.
///
/// The text is `@State` here rather than in `ChatState.subagentUI`: routing it
/// through the reducer would invalidate the whole transcript on every
/// keystroke, which is the fan-out web measured and deliberately keyed away
/// from. The cost is that collapsing a row discards its unsent text.
///
/// It is NOT cleared on submit and NOT cleared on failure — only on a send the
/// caller reports as successful, by way of the row's `isSending` returning to
/// false with no error. Keeping the sentence is the whole point: the
/// coordinator's refusals (one-shot type, steer cap, unrebuildable grant) are
/// all things the user might rephrase around.
struct SubagentComposer: View {
  let identifier: String
  let placeholder: String
  let isEnabled: Bool
  let isSending: Bool
  let onSend: (String) async -> Bool

  @State private var text = ""

  private var canSend: Bool {
    isEnabled && isSending == false
      && text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
  }

  var body: some View {
    HStack(alignment: .bottom, spacing: 8) {
      TextField(placeholder, text: $text, axis: .vertical)
        .textFieldStyle(.plain)
        .font(.callout)
        .lineLimit(1...4)
        .disabled(isEnabled == false)
        .accessibilityIdentifier(identifier)
      Button {
        // Deliberately NOT cleared here. A `POST /subagents/:id/resume` is
        // refused outright for a one-shot type, a spent steer cap or an
        // unrebuildable grant, and clearing on submit would throw away a
        // sentence the user is most likely to want to rephrase. Only a send
        // the gateway accepted empties the field.
        let outgoing = text
        Task { if await onSend(outgoing) { text = "" } }
      } label: {
        Image(systemName: "arrow.up.circle.fill")
          .font(.title3)
      }
      .buttonStyle(.plain)
      .disabled(canSend == false)
      .frame(minWidth: 44, minHeight: 44)
      .accessibilityLabel("Send to agent")
      .accessibilityIdentifier("\(identifier).send")
    }
    .padding(8)
    .background(
      Color.secondary.opacity(DashTheme.Opacity.fillSubtle),
      in: RoundedRectangle(cornerRadius: DashTheme.Radius.small)
    )
  }
}

extension SubagentCardStatus {
  fileprivate var dotColor: Color {
    switch self {
    case .running, .waiting: DashTheme.accent
    case .done: DashTheme.success
    case .failed: DashTheme.danger
    case .cancelled, .interrupted, .maxTurns: Color.secondary
    }
  }
}
