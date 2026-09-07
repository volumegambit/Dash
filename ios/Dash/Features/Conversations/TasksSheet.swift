import SwiftUI

/// §8.4's iOS half: a sheet listing this conversation's sub-agent children
/// (`chat.tasks.sheet`, rows `chat.tasks.row.<id>`), opened from a toolbar item
/// beside `chat.options` badged with the live count (`chat.tasks`), plus a
/// pinned strip above the composer while any child is live
/// (`chat.tasks.strip`).
///
/// **The model is `ChatFeature.subagents` — REST, and nothing else.** The
/// transcript's own rows are folded from events and are a different thing on
/// purpose; see `ChatFeature.subagents` for why merging the two is a bug rather
/// than a saving. The consequence worth stating plainly: a background child's
/// collapsed ROW keeps reading `Running` after the parent turn ends, because
/// the fold exempts a background child from end-of-stream terminalization and
/// its real finish never reaches the parent's event stream at all. This sheet,
/// this strip and this badge are the surfaces that tell the truth; web's
/// `SubagentBlock` reads the fold's status too, and changing that on either
/// client is the merge D3 rejected.
///
/// Three structural rules, all easy to regress:
///
/// 1. **No second elapsed formatter and no second terminal predicate.**
///    `SubagentMetaView`, `SubagentStatusGlyph`, `SubagentCardStatus.isTerminal`
///    and `SubagentCardStatus.title` are the ones the transcript row uses, so a
///    row here and a row there can never disagree about whether a child has
///    finished or how long it ran. A terminal child with no `endedAt` therefore
///    renders NO elapsed here for free.
/// 2. **No subscription.** The sheet renders no transcript, so it needs none —
///    and a second, parallel subscription path would leak a watcher per child.
///    Its resume is consequently non-optimistic without anything here choosing
///    that: `ChatFeature.sendToSubagent` derives optimism from
///    `subscribedSubagentIDs`, which this surface never joins.
/// 3. **The identifier and the accessible name sit on the element a test
///    queries.** A container's accessibility identifier ERASES its children's
///    (D4 hit it one level in, D5 one level out), so the row's tap target and
///    its Stop button are SIBLING buttons carrying their own identifiers rather
///    than one identified container holding both.

/// One row of the sheet, derived from a REST entry alone.
///
/// A value type rather than logic inside the view so `DashTests` can pin the
/// derivations — which status word, which elapsed, which buttons — without
/// rendering SwiftUI.
struct SubagentTaskRow: Equatable, Identifiable, Sendable {
  let id: String
  let type: String
  let name: String?
  let description: String
  let status: SubagentCardStatus
  let startedAt: Date
  let endedAt: Date?
  let toolCallCount: Int
  let oneShot: Bool

  init(_ entry: SubagentListEntryDTO) {
    id = entry.id
    type = entry.type.isEmpty ? "agent" : entry.type
    name = entry.name
    description = entry.description
    status = SubagentCardStatus(wire: entry.status)
    startedAt = entry.startedAt
    endedAt = entry.endedAt
    toolCallCount = entry.toolCallCount
    oneShot = entry.oneShot
  }

  /// Only a live child can be stopped: the route answers 409 for a terminal
  /// one, deliberately, so a client that raced the child's own finish learns
  /// which of the two won.
  var canStop: Bool { status.isTerminal == false }

  /// A one-shot child can be ANSWERED but not steered — `coordinator.sendToChild`
  /// exempts a live child parked on a question and refuses everything else, and
  /// swarm was fixed on this branch precisely so somebody can answer one.
  var canResume: Bool { oneShot == false || status == .waiting }

  /// The row's accessible name, in the SAME vocabulary the transcript row uses
  /// (`SubagentCardStatus.title`), so the two surfaces never describe one child
  /// differently.
  var accessibilityName: String { "Agent \(type), \(status.title)" }
}

/// §8.4's toolbar item beside `chat.options`.
///
/// Reads `feature.liveSubagentCount` from inside ITS OWN body, never from
/// `ChatView.body`: Observation invalidates the view that performed the access,
/// so a list re-read on every parent turn's `done` costs this button and
/// nothing else.
struct TasksToolbarButton: View {
  @Environment(ChatFeature.self) private var feature
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Image(systemName: "person.2")
        .frame(minWidth: 44, minHeight: 44)
        .overlay(alignment: .topTrailing) { badge }
    }
    .accessibilityLabel("Tasks")
    // The count rides `accessibilityValue` rather than the badge `Text`: the
    // Button merges its children into one element, so the badge's own
    // identifier would not survive and its text would land in the label.
    //
    // NOTE for anyone querying this from a UI test: a SwiftUI `ToolbarItem`
    // publishes its content TWICE — an `Other` container and the `Button`
    // itself, both carrying this identifier at the same frame. That is not
    // something this view does; `chat.options` beside it has done the same
    // since it was written, which is why every existing test reaches a toolbar
    // item through `app.buttons.matching(identifier:).firstMatch` rather than
    // through `DashUITestCase.element(_:in:)`. Measured from the accessibility
    // tree, not inferred.
    .accessibilityValue(accessibilityValue)
    .accessibilityIdentifier("chat.tasks")
  }

  private var count: Int { feature.liveSubagentCount }

  @ViewBuilder private var badge: some View {
    if count > 0 {
      Text("\(count)")
        .font(.caption2.weight(.bold))
        .foregroundStyle(Color.white)
        .padding(.horizontal, 5)
        .padding(.vertical, 1)
        .background(DashTheme.accent, in: Capsule())
        .offset(x: -2, y: 6)
        .accessibilityHidden(true)
    }
  }

  private var accessibilityValue: String {
    count == 0 ? "No agents running" : "\(count) running"
  }
}

/// §8.4's pinned strip, above the composer while any child is live.
///
/// Renders nothing at all when nothing is live, so `ChatView` does not have to
/// read the count to decide whether to place it — which would put the
/// invalidation back on the transcript.
struct TasksStrip: View {
  @Environment(ChatFeature.self) private var feature
  let action: () -> Void

  var body: some View {
    if live.isEmpty == false {
      Button(action: action) {
        HStack(spacing: 8) {
          ProgressView().controlSize(.mini)
          // `SubagentFormat.clusterSummary` over the LIVE statuses, which is
          // §8.2's own summary line — not a second summary rule.
          Text(SubagentFormat.clusterSummary(live))
            .font(.caption)
            .foregroundStyle(.secondary)
          Spacer(minLength: 0)
          Image(systemName: "chevron.up")
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .background(Color.secondary.opacity(DashTheme.Opacity.fillSubtle))
      .accessibilityLabel(SubagentFormat.clusterSummary(live))
      .accessibilityIdentifier("chat.tasks.strip")
    }
  }

  private var live: [SubagentCardStatus] {
    feature.subagents
      .map { SubagentCardStatus(wire: $0.status) }
      .filter { $0.isTerminal == false }
  }
}

/// §8.4's sheet, modelled on `AgentPickerSheet`.
struct TasksSheet: View {
  @Environment(ChatFeature.self) private var feature
  @Environment(\.dismiss) private var dismiss
  /// Opens the child's row in the transcript. The iOS counterpart of web's
  /// "clicking a row scrolls to and expands the row"; iOS expands and dismisses
  /// without scrolling, which is disclosed rather than pretended.
  let onReveal: (String) -> Void

  var body: some View {
    NavigationStack {
      List {
        if rows.isEmpty {
          ContentUnavailableView(
            "No agents yet",
            systemImage: "person.2.slash",
            description: Text("Agents this conversation starts appear here.")
          )
        } else {
          ForEach(rows) { row in
            TasksRowView(
              row: row,
              onReveal: { childID in
                onReveal(childID)
                dismiss()
              }
            )
          }
        }
      }
      .navigationTitle("Tasks")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Done") { dismiss() }
            .accessibilityIdentifier("chat.tasks.done")
        }
      }
    }
    .accessibilityIdentifier("chat.tasks.sheet")
  }

  private var rows: [SubagentTaskRow] { feature.subagents.map(SubagentTaskRow.init) }
}

private struct TasksRowView: View {
  @Environment(ChatFeature.self) private var feature
  let row: SubagentTaskRow
  let onReveal: (String) -> Void

  @State private var isResumeOpen = false

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      // The row's tap target and the Stop button are SIBLINGS, and neither
      // container above them carries an identifier: an identified `.contain`
      // container erases its children's identifiers, which is the trap that has
      // now cost this branch time twice.
      Button {
        onReveal(row.id)
      } label: {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
          SubagentStatusGlyph(status: row.status)
          Text(row.type)
            .font(.callout.monospaced())
            .foregroundStyle(.primary)
          if let name = row.name, name.isEmpty == false {
            Text(name)
              .font(.caption.weight(.medium))
              .foregroundStyle(.secondary)
          }
          Text(row.description)
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .truncationMode(.tail)
          Spacer(minLength: 4)
          SubagentMetaView(
            isTerminal: row.status.isTerminal,
            toolCallCount: row.toolCallCount,
            startedAt: row.startedAt,
            endedAt: row.endedAt
          )
        }
        .frame(minHeight: 44)
        .contentShape(Rectangle())
      }
      // `.plain` on BOTH buttons in the cell: a `List` row with a default
      // button style makes the whole cell one tap target, and tapping Stop
      // would fire the row as well.
      .buttonStyle(.plain)
      .accessibilityLabel(row.accessibilityName)
      .accessibilityIdentifier("chat.tasks.row.\(row.id)")

      HStack(spacing: 12) {
        if row.canStop {
          Button("Stop") {
            Task { await feature.stopSubagent(row.id) }
          }
          .buttonStyle(.plain)
          .foregroundStyle(DashTheme.danger)
          .disabled(feature.stoppingSubagentIDs.contains(row.id))
          .frame(minHeight: 44)
          .accessibilityIdentifier("chat.tasks.stop.\(row.id)")
        }
        Button(isResumeOpen ? "Cancel" : "Resume") {
          isResumeOpen.toggle()
        }
        .buttonStyle(.plain)
        .disabled(row.canResume == false)
        .frame(minHeight: 44)
        .accessibilityHint(row.canResume ? "" : oneShotComposerTitle)
        .accessibilityIdentifier("chat.tasks.resume.\(row.id)")
        Spacer(minLength: 0)
      }
      .font(.caption)

      if let error = feature.subagentStopErrors[row.id] {
        Text(error)
          .font(.caption)
          .foregroundStyle(DashTheme.danger)
          .accessibilityIdentifier("chat.tasks.error.\(row.id)")
      }

      if isResumeOpen, row.canResume {
        // The SAME composer the transcript row uses, sending through the SAME
        // `sendToSubagent`. A second correlation scheme here would duplicate or
        // strand a row the first time an `accepted` went missing. Its draft gets
        // a `tasks:` key of its own, alongside `body:`/`reply:`, so a keystroke
        // here cannot share a buffer with the row's own composer.
        SubagentComposer(
          identifier: "chat.tasks.composer.\(row.id)",
          draftKey: "tasks:\(row.id)",
          placeholder: "Send a follow-up…",
          isEnabled: feature.connection != .repairRequired,
          isSending: feature.state.subagentUI[row.id]?.isSending ?? false,
          draft: { feature.subagentComposerDraft($0) },
          setDraft: { feature.setSubagentComposerDraft($0, $1) }
        ) { text in
          await feature.sendToSubagent(row.id, text: text)
        }
      }
    }
  }
}
