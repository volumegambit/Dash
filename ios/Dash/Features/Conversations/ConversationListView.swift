import CoreTransferable
import ImageIO
import Observation
import SwiftUI
import UIKit
import UniformTypeIdentifiers

struct ConversationRowActionPolicy: Equatable {
  let showsRename: Bool
  let showsDelete: Bool
  let canRename: Bool
  let canDelete: Bool
  let renameDisabledHint: String
  let deleteDisabledHint: String

  init(summary: ConversationSummaryDTO, mutationsAllowed: Bool) {
    let isReadOnly = summary.status == .archived || summary.status == .deleted
    let hasActiveTurn = summary.status == .running || summary.activeTurnId != nil

    showsRename = isReadOnly == false
    showsDelete = isReadOnly == false
    canRename = showsRename && mutationsAllowed
    canDelete = showsDelete && mutationsAllowed && hasActiveTurn == false

    renameDisabledHint = mutationsAllowed ? "" : "Connect to the gateway to rename"
    if mutationsAllowed == false {
      deleteDisabledHint = "Connect to the gateway to delete"
    } else if hasActiveTurn {
      deleteDisabledHint = "Wait for the active turn to finish before deleting"
    } else {
      deleteDisabledHint = ""
    }
  }
}

/// Audit #9's local search filter, factored out of `ConversationListView` so
/// it's directly unit-testable (`@testable import Dash`) the same way
/// `ChatTranscriptSignature.of(_:)` is — SwiftUI's `.searchable` binding
/// itself isn't unit-testable, but the actual filtering decision is a pure
/// function of `(conversations, query)`. Case-insensitive `Locale`-aware
/// match over title + `lastMessagePreview`, mirroring the web conversation
/// search's client-side filter (Task 1, audit #8, `ConversationList.tsx`).
enum ConversationSearchFilter {
  static func apply(
    _ conversations: [CachedConversation],
    query: String
  ) -> [CachedConversation] {
    let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.isEmpty == false else { return conversations }
    return conversations.filter { conversation in
      conversation.summary.title.localizedCaseInsensitiveContains(trimmed)
        || (conversation.summary.lastMessagePreview?.localizedCaseInsensitiveContains(trimmed)
          ?? false)
    }
  }
}

/// Compose-first new chat (Task 3, audit #16), factored out of
/// `ConversationListView.startCompose()` the same way `ConversationSearchFilter`
/// is factored out of the search bar (review fix, minor: the brief called
/// for a persisted-agent-no-longer-exists fallback test, which needs a pure
/// function to test against — `startCompose()` itself is a private `View`
/// method that can't be unit-tested directly).
///
/// `lastUsedAgentID` may name an agent that's since been deleted or
/// disabled (no longer in `availableAgents`, which is already filtered to
/// `status != .disabled`) — that's not an error, just a stale preference,
/// so this falls back to the first available agent exactly the same way it
/// does when nothing's been recorded yet.
enum ComposeAgentSelection {
  /// Phase 4 minor 7: the pool compose picks from. Drops disabled agents and,
  /// when the list is filtered to one agent (`ConversationListFeature
  /// .selectedAgentID`), narrows to exactly that agent — otherwise compose
  /// under a filter could start a thread under the last-used agent, which
  /// the filtered list the user is looking at would never show. A disabled
  /// filtered agent yields an EMPTY pool (compose disables with its hint)
  /// rather than escaping the filter.
  static func availableAgents(
    _ agents: [RegisteredAgentDTO],
    filteredAgentID: String?
  ) -> [RegisteredAgentDTO] {
    agents.filter { agent in
      agent.status != .disabled && (filteredAgentID == nil || agent.id == filteredAgentID)
    }
  }

  static func resolve(
    availableAgents: [RegisteredAgentDTO],
    lastUsedAgentID: String?
  ) -> String? {
    guard availableAgents.isEmpty == false else { return nil }
    return availableAgents.first { $0.id == lastUsedAgentID }?.id ?? availableAgents[0].id
  }

  /// Whether compose can run at all right now — i.e. whether `resolve` above
  /// would return `nil`, or the gateway would refuse the create.
  ///
  /// Shared by BOTH compose entry points: `ConversationListView`'s toolbar
  /// button and `RootView`'s empty-detail "New conversation" button on the
  /// iPad two-column layout (design §1.1). The iPad button shipped
  /// always-enabled and silently no-op'd when there was no agent to compose
  /// under, which is why this predicate lives here rather than staying a
  /// private computed property on the list view.
  ///
  /// Reentrancy is deliberately NOT part of this: each call site owns its own
  /// in-flight flag, since only that site knows whether its own compose is
  /// still running.
  static func isUnavailable(
    _ agents: [RegisteredAgentDTO],
    filteredAgentID: String?,
    mutationsAllowed: Bool
  ) -> Bool {
    mutationsAllowed == false
      || availableAgents(agents, filteredAgentID: filteredAgentID).isEmpty
  }

  /// The accessibility hint explaining why `isUnavailable` is `true` — empty
  /// when compose is available, so it can be attached unconditionally.
  ///
  /// `isConnecting` distinguishes the liminal `.connecting` state from a
  /// genuinely broken connection: while connecting, the app is already doing
  /// the thing "Connect to the gateway…" would ask the user to do, so the
  /// hint says so instead of issuing an instruction that can't be acted on.
  static func unavailableHint(
    _ agents: [RegisteredAgentDTO],
    filteredAgentID: String?,
    mutationsAllowed: Bool,
    isConnecting: Bool
  ) -> String {
    if mutationsAllowed == false {
      return isConnecting
        ? "Connecting to the gateway"
        : "Connect to the gateway to create a conversation"
    }
    if availableAgents(agents, filteredAgentID: filteredAgentID).isEmpty {
      return "Enable or create an agent before starting a conversation"
    }
    return ""
  }
}

struct ConversationListView: View {
  @Environment(AppModel.self) private var appModel
  @Environment(ConversationListFeature.self) private var feature
  /// iPad goal Phase C: opens the `WindowGroup(id: "conversation", …)`
  /// scene `DashApp` declares. A no-op on a device that cannot host a
  /// second scene, which is why the affordance below is gated on
  /// `supportsMultipleScenes` rather than being offered everywhere.
  @Environment(\.openWindow) private var openWindow

  let presentation: NavigationPresentation

  @State private var renameTarget: CachedConversation?
  @State private var renameTitle = ""
  @State private var deleteTarget: CachedConversation?
  // Audit #9: local-only filter over the (already agent-filtered)
  // `feature.conversations` — no server round-trip, mirrors the web
  // conversation search (Task 1, audit #8) which is likewise a client-side
  // filter over title + lastMessagePreview.
  @State private var searchText = ""
  // Compose-first new chat (Task 3, audit #16): `isComposing` covers the
  // async gap between tapping the compose button and `appModel.openConversation`
  // actually navigating — the old `NewConversationView.isCreating` this
  // replaces guarded the exact same window, just one screen later (after an
  // explicit "Start conversation" tap instead of the compose tap itself).
  @State private var isComposing = false
  /// Focus of the `.searchable` field, driven by ⌘F
  /// (`KeyboardCommand.focusSearch`). Bound through `dashSearchFocused(_:)`,
  /// which is the identity modifier below iOS 18 — see its doc comment for
  /// why ⌘F is listed but DISABLED there rather than hidden.
  @FocusState private var isSearchFocused: Bool

  var body: some View {
    List {
      if feature.recoverablePendingSends.isEmpty == false {
        Section("Needs Recovery") {
          ForEach(feature.recoverablePendingSends) { recovery in
            recoveryRow(recovery)
          }
        }
      }

      if feature.conversations.isEmpty, feature.recoverablePendingSends.isEmpty {
        emptyState
          .listRowBackground(Color.clear)
      } else if feature.conversations.isEmpty == false {
        // The nav title already says "Conversations"; a section header
        // repeating it only earns its place when "Needs Recovery" is also
        // on screen and the two need telling apart.
        if feature.recoverablePendingSends.isEmpty {
          Section { conversationSectionContent }
        } else {
          Section("Conversations") { conversationSectionContent }
        }
      }
    }
    .accessibilityIdentifier("conversation.list")
    .listStyle(.plain)
    .navigationTitle("Conversations")
    .searchable(text: $searchText, prompt: "Search conversations")
    .dashSearchFocused($isSearchFocused)
    // iPad goal Phase B: the list surface's slice of `DashCommands`.
    // `canCompose` mirrors `composeDisabled`'s agent-availability check so
    // ⌘N is greyed out for the same reason the toolbar's compose button is
    // — see `ListCommandActions.canCompose` for why it deliberately does
    // NOT also fold in `isComposing`.
    .background {
      ListCommandPublisher(
        actions: ListCommandActions(
          feature: feature,
          newConversation: { Task { await startCompose() } },
          focusSearch: { isSearchFocused = true },
          previous: { step(-1) },
          next: { step(1) }
        )
      )
      .equatable()
    }
    .refreshable { await feature.refresh() }
    .toolbar {
      ToolbarItem(placement: .topBarLeading) {
        agentFilter
      }
      ToolbarItem(placement: .topBarTrailing) {
        Button {
          Task { await startCompose() }
        } label: {
          // A spinner rather than a greyed pencil while the sync engine is
          // still `.connecting`: that state deliberately shows no offline
          // banner (`AppModel.consume` maps it to `banner = nil` to avoid
          // flicker on every cold start), so without this the button reads
          // as inexplicably dead — the list underneath renders cached rows
          // and looks perfectly healthy. Every OTHER non-online state has
          // a banner explaining itself.
          if isComposing || feature.isConnecting {
            ProgressView()
              .frame(minWidth: 44, minHeight: 44)
          } else {
            Label("New conversation", systemImage: "square.and.pencil")
              .frame(minWidth: 44, minHeight: 44)
          }
        }
        .disabled(composeDisabled)
        .accessibilityIdentifier("conversation.new")
        .accessibilityHint(composeDisabledHint)
      }
    }
    .safeAreaInset(edge: .top) {
      conflictBanner
    }
    .task { await feature.start() }
    .alert("Rename conversation", isPresented: renamePresented) {
      TextField("Title", text: $renameTitle)
      Button("Cancel", role: .cancel) { renameTarget = nil }
      Button("Rename") {
        guard let target = renameTarget else { return }
        renameTarget = nil
        Task { await feature.rename(id: target.id, title: renameTitle) }
      }
    } message: {
      Text("Enter a title for this conversation.")
    }
    // Final-review fix m6: verbatim copy per the plan — see the matching
    // comment on `ChatView`'s own delete confirmation, which this mirrors
    // exactly (previously both interpolated the conversation's own title
    // into the question and used a different, non-verbatim message).
    .confirmationDialog(
      "Delete this conversation?",
      isPresented: deletePresented,
      titleVisibility: .visible
    ) {
      Button("Delete", role: .destructive) {
        guard let target = deleteTarget else { return }
        deleteTarget = nil
        Task { await feature.delete(id: target.id, confirmed: true) }
      }
      Button("Cancel", role: .cancel) { deleteTarget = nil }
    } message: {
      Text("This can't be undone.")
    }
    .alert("Conversation update failed", isPresented: genericErrorPresented) {
      if let conversationID = actionableConversationID {
        Button("Open Conversation") {
          feature.mutationError = nil
          appModel.openConversation(conversationID, presentation: presentation)
        }
      }
      Button("OK") { feature.mutationError = nil }
    } message: {
      Text(genericErrorMessage)
    }
  }

  private var renamePresented: Binding<Bool> {
    Binding(
      get: { renameTarget != nil },
      set: { if $0 == false { renameTarget = nil } }
    )
  }

  private var deletePresented: Binding<Bool> {
    Binding(
      get: { deleteTarget != nil },
      set: { if $0 == false { deleteTarget = nil } }
    )
  }

  private var genericErrorPresented: Binding<Bool> {
    Binding(
      get: {
        guard let error = feature.mutationError else { return false }
        if case .revisionConflict = error { return false }
        return true
      },
      set: { if $0 == false { feature.mutationError = nil } }
    )
  }

  private var genericErrorMessage: String {
    feature.mutationError?.userMessage ?? "Dash couldn't complete the update. Try again."
  }

  private var actionableConversationID: String? {
    switch feature.mutationError {
    case .conversationBusy(let conversationID, _), .readOnly(let conversationID):
      conversationID
    case .offline, .invalidTitle, .outcomeUnknown, .revisionConflict, .failed, .none:
      nil
    }
  }

  @ViewBuilder
  private var conflictBanner: some View {
    if case .revisionConflict(let current)? = feature.mutationError {
      HStack(spacing: 12) {
        Image(systemName: "arrow.triangle.2.circlepath")
          .accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 2) {
          Text("This conversation changed on another device")
            .font(.subheadline.weight(.semibold))
          Text("\(current.title) · \(current.status.displayName)")
            .font(.caption)
        }
        Spacer()
        Button("Retry") {
          Task { await feature.retryConflict() }
        }
        .frame(minWidth: 44, minHeight: 44)
      }
      .padding(.horizontal)
      .background(.regularMaterial)
      .accessibilityElement(children: .combine)
    }
  }

  private var agentFilter: some View {
    Menu {
      Button("All agents") {
        Task { await feature.setAgentFilter(nil) }
      }
      ForEach(feature.agents) { agent in
        Button(agent.name) {
          Task { await feature.setAgentFilter(agent.id) }
        }
      }
    } label: {
      Label("Filter", systemImage: "line.3.horizontal.decrease.circle")
        .frame(minWidth: 44, minHeight: 44)
    }
    .accessibilityValue(selectedAgentName ?? "All agents")
  }

  private var selectedAgentName: String? {
    feature.agents.first { $0.id == feature.selectedAgentID }?.name
  }

  // MARK: - Compose-first new chat (Task 3, audit #16)

  private var composeDisabled: Bool {
    ComposeAgentSelection.isUnavailable(
      feature.agents,
      filteredAgentID: feature.selectedAgentID,
      mutationsAllowed: feature.mutationsAllowed
    ) || isComposing
  }

  private var composeDisabledHint: String {
    ComposeAgentSelection.unavailableHint(
      feature.agents,
      filteredAgentID: feature.selectedAgentID,
      mutationsAllowed: feature.mutationsAllowed,
      isConnecting: feature.isConnecting
    )
  }

  /// Replaces `NewConversationView`'s Form (agent `Picker` + "Start
  /// conversation" button — three taps before typing) with a single tap
  /// straight into `ChatView`. The agent choice itself isn't asked for here
  /// anymore: it defaults to whichever agent this gateway was last used
  /// with (`ConversationListFeature.lastUsedAgentID()`, persisted per
  /// gateway), falling back to the first enabled agent the very first time —
  /// see `ComposeAgentSelection.resolve(availableAgents:lastUsedAgentID:)`.
  /// `ChatView`'s header agent chip is now the ONLY place to override that
  /// choice, and only while the resulting conversation is still empty — see
  /// `AgentPickerSheet`'s doc comment.
  private func startCompose() async {
    guard isComposing == false else { return }
    // Armed BEFORE the first `await` below: `composeConversation()` suspends,
    // and a second tap landing in that window would otherwise pass the
    // reentrancy guard and compose twice.
    isComposing = true
    defer { isComposing = false }
    // `ConversationListFeature.composeConversation()` (iPad goal Phase A,
    // Task 2) owns the last-used-agent resolution and idempotent create —
    // see its doc comment for why callers just check the returned id rather
    // than re-reading `feature.selectedID`/`mutationError` afterward.
    guard let conversationID = await feature.composeConversation() else { return }
    // Phase 4 minor 2 (iOS half; web: `ConversationList.tsx` `handleCreate`):
    // drop any active search, otherwise the conversation about to be opened
    // is filtered out of the list beside it — selected, being typed into,
    // and with no row. Reachable on iPadOS 26, where the sidebar keeps its
    // toolbar during a search (iOS 18 collapses it to the field + Cancel).
    searchText = ""
    appModel.openConversation(conversationID, presentation: presentation)
  }

  /// ⌘⇧[ / ⌘⇧] (`KeyboardCommand.previousConversation` / `.nextConversation`):
  /// walks `filteredConversations` — the list the user is actually looking
  /// at, so the agent filter and an active search both scope the keyboard
  /// walk exactly as they scope the rows.
  ///
  /// No-op at the ends: stepping past either edge deliberately does nothing
  /// rather than wrapping, so holding the chord can't cycle forever past the
  /// conversation the user wanted. With nothing open (or with the open
  /// conversation hidden by the current filter) it enters the list from the
  /// end it is travelling towards — first row for next, last for previous.
  private func step(_ offset: Int) {
    let conversations = filteredConversations
    guard conversations.isEmpty == false else { return }
    guard let index = openConversationID.flatMap({ id in
      conversations.firstIndex { $0.id == id }
    }) else {
      let entry = offset < 0 ? conversations[conversations.count - 1] : conversations[0]
      appModel.openConversation(entry.id, presentation: presentation)
      return
    }
    let target = index + offset
    guard conversations.indices.contains(target) else { return }
    appModel.openConversation(conversations[target].id, presentation: presentation)
  }

  /// Which conversation `step(_:)` walks from. Branches on presentation for
  /// the same reason `ChatView`'s `onDisappear` does: a compact back-button
  /// pop mutates the bound `conversationPath` but never clears
  /// `splitConversationSelection`, which would leave the compact walk
  /// stepping from a conversation the user has already left.
  private var openConversationID: String? {
    let route: ConversationRoute? = switch presentation {
    case .compact: appModel.conversationPath.last
    case .regular: appModel.splitConversationSelection
    }
    if case .transcript(let id) = route { return id }
    return nil
  }

  /// Audit #9: local filter over `feature.conversations` (already scoped by
  /// `agentFilter`) so search and the agent-filter menu compose rather than
  /// fight each other.
  private var filteredConversations: [CachedConversation] {
    ConversationSearchFilter.apply(feature.conversations, query: searchText)
  }

  /// Shared by the context menu and the swipe actions (audit #10) so
  /// availability/disabled-state/hints can never drift between the two entry
  /// points for the same row.
  private func actionPolicy(for conversation: CachedConversation) -> ConversationRowActionPolicy {
    ConversationRowActionPolicy(
      summary: conversation.summary,
      mutationsAllowed: feature.mutationsAllowed
    )
  }

  @ViewBuilder
  private var emptyState: some View {
    if feature.mutationsAllowed {
      ContentUnavailableView(
        "No conversations",
        systemImage: "bubble.left.and.bubble.right",
        description: Text("Start a conversation with one of your agents.")
      )
    } else {
      ContentUnavailableView(
        "No cached conversations",
        systemImage: "wifi.slash",
        description: Text("Connect to the gateway to load conversations.")
      )
    }
  }

  /// The `Conversations` section's rows plus the search/pagination tail,
  /// extracted from the `List` body so the section can be built with or
  /// without a header without duplicating its contents.
  @ViewBuilder
  private var conversationSectionContent: some View {
    ForEach(filteredConversations) { conversation in
      decoratedConversationRow(conversation)
    }

    if filteredConversations.isEmpty {
      ContentUnavailableView.search(text: searchText)
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
        // Review fix (audit #9): with zero locally-matching rows
        // there's no row left to hang the usual near-the-tail
        // pagination trigger off, so eagerly keep loading older pages
        // while this empty-results state is showing — an unloaded
        // page might still contain a match. Keyed on `nextCursor` so
        // it re-fires after each successful page load and stops on
        // its own once a match appears (this view disappears) or
        // pages run out (`nextCursor` settles at `nil`).
        .task(id: feature.nextCursor) {
          await feature.loadOlderForEmptySearchResults()
        }
    } else if feature.isLoadingOlder {
      HStack {
        Spacer()
        ProgressView("Loading older conversations")
        Spacer()
      }
      .listRowSeparator(.hidden)
    }
  }

  /// The conversation row plus every per-row modifier, extracted from the
  /// `ForEach` closure as one unit: with Task 10's "Open in New Window" item
  /// and `.draggable` added inline, the closure tipped the type checker over
  /// its budget ("unable to type-check this expression in reasonable time").
  /// Keeping the whole chain in ONE function preserves the co-location of
  /// `.contextMenu` and `.draggable` that Task 8's review fix (aeda641d)
  /// established, rather than scattering them across views.
  @ViewBuilder
  private func decoratedConversationRow(_ conversation: CachedConversation) -> some View {
    conversationRow(conversation)
      .task {
        // Review fix (audit #9): pass the FILTERED list a search is
        // actively rendering from, not the canonical
        // `feature.conversations` — see `loadOlderIfNeeded`'s doc
        // comment for why the canonical list silently stalls
        // pagination once a query hides its tail rows.
        await feature.loadOlderIfNeeded(
          currentID: conversation.id,
          visibleConversations: filteredConversations
        )
      }
      // iPad goal Phase C (design §3.2). Gated on
      // `supportsMultipleScenes` so the item never appears where
      // tapping it could do nothing: UIKit reports `false` for any
      // app that cannot host a second scene, which is the honest
      // source of truth here rather than an idiom check.
      // `.draggable` below is co-located on this same chain rather
      // than pushed inside `conversationRow`, matching the
      // arrangement Task 8's review fix (aeda641d) settled on for
      // message bubbles.
      .contextMenu {
        let actions = actionPolicy(for: conversation)

        if UIApplication.shared.supportsMultipleScenes,
          let gatewayID = appModel.selectedProfile?.gatewayID
        {
          Button {
            ConversationWindowSceneGuard.noteOpened()
            openWindow(
              value: ConversationWindowValue(
                gatewayID: gatewayID,
                conversationID: conversation.id
              )
            )
          } label: {
            Label("Open in New Window", systemImage: "macwindow.badge.plus")
          }
          .accessibilityIdentifier("conversation.openInWindow.\(conversation.id)")
        }

        if actions.showsRename {
          Button {
            renameTarget = conversation
            renameTitle = conversation.summary.title
          } label: {
            Label("Rename", systemImage: "pencil")
          }
          .disabled(actions.canRename == false)
          .accessibilityHint(actions.renameDisabledHint)
        }

        if actions.showsDelete {
          Button(role: .destructive) {
            deleteTarget = conversation
          } label: {
            Label("Delete", systemImage: "trash")
          }
          .disabled(actions.canDelete == false)
          .accessibilityHint(actions.deleteDisabledHint)
        }
      }
      // Review fix round 1 (Important 2): gated on `supportsMultipleScenes`
      // too, matching the "Open in New Window" menu item above. Without it,
      // every iPhone row lifted under a drag with no device-reachable
      // consumer — worse than no drag at all.
      .draggableConversation(
        UIApplication.shared.supportsMultipleScenes
          ? appModel.selectedProfile.map {
            ConversationWindowValue(gatewayID: $0.gatewayID, conversationID: conversation.id)
          }
          : nil
      )
      // Audit #10: same `ConversationRowActionPolicy` the context
      // menu above uses — availability, disabled state, and hints
      // stay identical across both entry points.
      .swipeActions(edge: .leading, allowsFullSwipe: true) {
        let actions = actionPolicy(for: conversation)
        if actions.showsRename {
          Button {
            renameTarget = conversation
            renameTitle = conversation.summary.title
          } label: {
            Label("Rename", systemImage: "pencil")
          }
          .disabled(actions.canRename == false)
          .accessibilityHint(actions.renameDisabledHint)
          .tint(DashTheme.accent)
        }
      }
      .swipeActions(edge: .trailing, allowsFullSwipe: true) {
        let actions = actionPolicy(for: conversation)
        if actions.showsDelete {
          Button(role: .destructive) {
            deleteTarget = conversation
          } label: {
            Label("Delete", systemImage: "trash")
          }
          .disabled(actions.canDelete == false)
          .accessibilityHint(actions.deleteDisabledHint)
        }
      }
  }

  private func conversationRow(_ conversation: CachedConversation) -> some View {
    Button {
      appModel.openConversation(
        conversation.id,
        presentation: presentation
      )
    } label: {
      // Two lines, Mail-style (list density 2026-09-05). This was four —
      // an unbounded-height title, the agent, the preview, and a status
      // badge — which fit about four and a half conversations on a phone.
      VStack(alignment: .leading, spacing: 3) {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          // `lineLimit(1)`: titles are generated from the conversation and
          // run long ("I can't check your emails — I don't have access to
          // your"), so an unbounded title silently doubled a row's height.
          Text(conversation.summary.title)
            .font(.headline)
            .foregroundStyle(.primary)
            .lineLimit(1)
            .truncationMode(.tail)
          Spacer(minLength: 4)
          Text(RelativeTimestamp.label(for: conversation.summary.updatedAt))
            .font(.caption)
            .foregroundStyle(.secondary)
            .layoutPriority(1)
        }

        // Agent and preview shared one style (`.subheadline`/`.secondary`),
        // so four grey lines of equal weight stacked up with nothing to
        // scan by. One line, with the agent carrying the emphasis: it is
        // the stable identifier you look for, the preview is the detail.
        // The agent takes the emphasis (Messages puts the sender here) and
        // the preview stays `.secondary`. Demoting the preview to
        // `.tertiary` would have read as cleaner hierarchy but is roughly
        // 3.6:1 against this app's black ground — under the 4.5:1 body-text
        // floor. Weight and colour carry the hierarchy instead of dimming.
        HStack(spacing: 0) {
          Text(conversation.summary.agentName)
            .font(.subheadline.weight(.medium))
            .foregroundStyle(.primary)
          if let preview = conversation.summary.lastMessagePreview, preview.isEmpty == false {
            Text(verbatim: " · ")
              .font(.subheadline)
              .foregroundStyle(.secondary)
            Text(preview)
              .font(.subheadline)
              .foregroundStyle(.secondary)
          }
        }
        .lineLimit(1)
        .truncationMode(.tail)

        // Only states that change what you would do next. `idle` was
        // rendered on every row, and a badge that is always present
        // carries no information while costing every row a line.
        if conversation.summary.status != .idle || feature.isAuthoritative == false {
          HStack {
            if conversation.summary.status != .idle {
              StatusBadge(
                title: LocalizedStringKey(conversation.summary.status.displayName),
                systemImage: conversation.summary.status.systemImage,
                color: conversation.summary.status.color
              )
            }
            if feature.isAuthoritative == false {
              Label("Cached", systemImage: "internaldrive")
                .font(.caption)
                .foregroundStyle(.secondary)
            }
          }
        }
      }
      .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .hoverEffect(.highlight)
    .listRowBackground(
      isSelected(conversation.id) ? DashTheme.accent.opacity(DashTheme.Opacity.fillMuted) : Color.clear
    )
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(isSelected(conversation.id) ? .isSelected : [])
    .accessibilityIdentifier("conversation.row.\(conversation.id)")
    // Left the separator starting a third of the way across the row,
    // aligned under the status badge rather than under the text column.
    .alignmentGuide(.listRowSeparatorLeading) { _ in 0 }
  }

  private func recoveryRow(_ recovery: RecoverablePendingSend) -> some View {
    Button {
      appModel.openConversationRecovery(
        recovery.conversationID,
        presentation: presentation
      )
    } label: {
      VStack(alignment: .leading, spacing: 6) {
        HStack(alignment: .firstTextBaseline) {
          Label(recovery.conversationTitle ?? "Recovered message", systemImage: "tray.full")
            .font(.headline)
            .foregroundStyle(.primary)
          Spacer()
          Text(recovery.pendingSend.createdAt, style: .relative)
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        if let agentName = recovery.agentName {
          Text(agentName)
            .font(.subheadline)
            .foregroundStyle(.secondary)
        }
        let preview = recovery.pendingSend.draft.trimmingCharacters(
          in: .whitespacesAndNewlines
        )
        if preview.isEmpty == false {
          Text(preview)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .lineLimit(2)
        }
        if recovery.pendingSend.attachments.isEmpty == false {
          let count = recovery.pendingSend.attachments.count
          Label(
            "\(count) image attachment\(count == 1 ? "" : "s")",
            systemImage: "photo"
          )
          .font(.caption)
          .foregroundStyle(.secondary)
        }
        if let issue = RecoveryAttachmentIssuePresentation(recovery: recovery) {
          Label(issue.rowLabel, systemImage: "photo.badge.exclamationmark")
            .font(.caption)
            .foregroundStyle(.orange)
        }
        Text("Saved locally — it will not be sent automatically")
          .font(.caption)
          .foregroundStyle(.orange)
      }
      .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .hoverEffect(.highlight)
    .listRowBackground(
      isRecoverySelected(recovery.conversationID)
        ? DashTheme.accent.opacity(DashTheme.Opacity.fillMuted) : Color.clear
    )
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(isRecoverySelected(recovery.conversationID) ? .isSelected : [])
    .accessibilityHint("Opens the saved message without sending it")
    .accessibilityIdentifier("conversation.recovery.\(recovery.conversationID)")
  }

  private func isSelected(_ conversationID: String) -> Bool {
    guard case .regular = presentation else { return false }
    return appModel.splitConversationSelection == .transcript(conversationID)
  }

  private func isRecoverySelected(_ conversationID: String) -> Bool {
    guard case .regular = presentation else { return false }
    return appModel.splitConversationSelection == .recovery(conversationID)
  }
}

enum PendingSendRecoveryPresentation {
  static func explanation(for recovery: RecoverablePendingSend) -> String {
    if recovery.coexistingDraft != nil {
      return
        "Dash could not confirm whether the earlier message was sent. A newer draft was also "
        + "saved. Both local copies are kept separately and will not be sent automatically. "
        + "Copy their exact text or share their readable images before discarding this "
        + "recovery item."
    }
    if recovery.attachmentIssue == .unreadableStoredPayload {
      return
        "Dash could not read this saved message's image data. The exact text is still "
        + "available and will not be sent automatically. Copy it before discarding this "
        + "recovery item. Its unreadable images cannot be previewed or shared."
    }
    return
      "Dash could not confirm whether this message was sent. This saved copy is kept separately "
      + "and will not be sent automatically. Copy the exact text or share its readable images "
      + "before discarding it."
  }

  static func discardTitle(for recovery: RecoverablePendingSend) -> String {
    if recovery.coexistingDraft != nil, recovery.conversationAvailable == false {
      return "Discard both recovery copies?"
    }
    return "Discard this recovered message?"
  }

  static func discardMessage(for recovery: RecoverablePendingSend) -> String {
    if recovery.coexistingDraft != nil {
      if recovery.conversationAvailable {
        return
          "This permanently removes the earlier message recovery. The newer draft remains "
          + "saved with its conversation."
      }
      return
        "This permanently removes both the earlier message and the newer draft, including "
        + "their images. It cannot be undone."
    }
    return "This permanently removes the saved text and images. It cannot be undone."
  }
}

struct PendingSendRecoveryView: View {
  @Environment(AppModel.self) private var appModel
  @Environment(ConversationListFeature.self) private var feature

  let recovery: RecoverablePendingSend
  let presentation: NavigationPresentation

  @State private var showsDiscardConfirmation = false

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        Label("Saved for recovery", systemImage: "tray.full")
          .font(.headline)
          .foregroundStyle(.orange)

        Text(PendingSendRecoveryPresentation.explanation(for: recovery))
        .font(.callout)
        .foregroundStyle(.secondary)

        GroupBox(recovery.coexistingDraft == nil ? "Message" : "Earlier Message") {
          Text(recovery.pendingSend.draft)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 4)
            .textSelection(.enabled)
            .accessibilityIdentifier("recovery.text.\(recovery.conversationID)")
        }

        Button {
          RecoveryClipboardAction(clipboard: SystemRecoveryClipboard()).copy(recovery)
        } label: {
          Label(
            recovery.coexistingDraft == nil ? "Copy Message" : "Copy Earlier Message",
            systemImage: "doc.on.doc"
          )
            .frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.bordered)
        .accessibilityHint("Copies the exact saved text without sending it")
        .accessibilityIdentifier("recovery.copy.\(recovery.conversationID)")

        if recovery.pendingSend.attachments.isEmpty == false {
          VStack(alignment: .leading, spacing: 12) {
            Text("Image Attachments")
              .font(.headline)
            ForEach(recovery.pendingSend.attachments.indices, id: \.self) { index in
              attachmentView(
                recovery.pendingSend.attachments[index],
                ordinal: index + 1,
                count: recovery.pendingSend.attachments.count
              )
            }
          }
        }

        if let issue = RecoveryAttachmentIssuePresentation(recovery: recovery) {
          GroupBox {
            Text(issue.message)
              .frame(maxWidth: .infinity, alignment: .leading)
          } label: {
            Label(issue.title, systemImage: "photo.badge.exclamationmark")
          }
          .accessibilityElement(children: .ignore)
          .accessibilityLabel(issue.accessibilityLabel)
          .accessibilityIdentifier(issue.identifier)
        }

        if let draft = recovery.coexistingDraft {
          Divider()

          GroupBox("Newer Draft") {
            Text(draft.text)
              .frame(maxWidth: .infinity, alignment: .leading)
              .padding(.vertical, 4)
              .textSelection(.enabled)
              .accessibilityIdentifier("recovery.draft.text.\(recovery.conversationID)")
          }

          Button {
            RecoveryClipboardAction(clipboard: SystemRecoveryClipboard()).copy(draft)
          } label: {
            Label("Copy Newer Draft", systemImage: "doc.on.doc")
              .frame(maxWidth: .infinity, minHeight: 44)
          }
          .buttonStyle(.bordered)
          .accessibilityHint("Copies the exact newer draft text without sending it")
          .accessibilityIdentifier("recovery.draft.copy.\(recovery.conversationID)")

          if draft.attachments.isEmpty == false {
            VStack(alignment: .leading, spacing: 12) {
              Text("Newer Draft Image Attachments")
                .font(.headline)
              ForEach(draft.attachments.indices, id: \.self) { index in
                attachmentView(
                  draft.attachments[index],
                  ordinal: index + 1,
                  count: draft.attachments.count
                )
              }
            }
          }

          if let issue = RecoveryAttachmentIssuePresentation(
            recovery: recovery,
            scope: .coexistingDraft
          ) {
            GroupBox {
              Text(issue.message)
                .frame(maxWidth: .infinity, alignment: .leading)
            } label: {
              Label(issue.title, systemImage: "photo.badge.exclamationmark")
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(issue.accessibilityLabel)
            .accessibilityIdentifier(issue.identifier)
          }
        }

        Button(role: .destructive) {
          showsDiscardConfirmation = true
        } label: {
          Label("Discard Recovered Message", systemImage: "trash")
            .frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.bordered)
        .disabled(feature.discardingRecoveryID != nil)
        .accessibilityHint(
          recovery.coexistingDraft == nil
            ? "Requires confirmation and permanently removes this local copy"
            : "Requires confirmation and explains which local copies will be removed"
        )
        .accessibilityIdentifier("recovery.discard.\(recovery.conversationID)")
      }
      .padding()
    }
    .navigationTitle(recovery.conversationTitle ?? "Message Recovery")
    .navigationBarTitleDisplayMode(.inline)
    .modifier(
      PendingSendRecoveryConfirmationModifier(
        recovery: recovery,
        isPresented: $showsDiscardConfirmation,
        discard: discardRecovery
      )
    )
  }

  private func discardRecovery() {
    Task {
      if await feature.discardRecovery(recovery) {
        appModel.closeConversationRecovery(
          recovery.conversationID,
          presentation: presentation
        )
      }
    }
  }

  @ViewBuilder
  private func attachmentView(
    _ attachment: PreparedAttachment,
    ordinal: Int,
    count: Int
  ) -> some View {
    let presentation = RecoveryAttachmentPresentation(
      attachment: attachment,
      ordinal: ordinal,
      count: count
    )
    VStack(alignment: .leading, spacing: 8) {
      RecoveryAttachmentPreviewView(
        attachment: attachment,
        presentation: presentation
      )

      ShareLink(
        item: RecoveryAttachmentTransfer(attachment: attachment),
        preview: SharePreview("Recovered image", image: Image(systemName: "photo"))
      ) {
        Label("Share Attachment", systemImage: "square.and.arrow.up")
          .frame(minWidth: 44, minHeight: 44)
      }
      .accessibilityLabel(presentation.shareAccessibilityLabel)
      .accessibilityHint("Shares the original saved image without sending the message")
      .accessibilityIdentifier("recovery.share.\(attachment.id.uuidString)")
    }
  }
}

private struct PendingSendRecoveryConfirmationModifier: ViewModifier {
  let recovery: RecoverablePendingSend
  @Binding var isPresented: Bool
  let discard: () -> Void

  func body(content: Content) -> some View {
    content.alert(
      PendingSendRecoveryPresentation.discardTitle(for: recovery),
      isPresented: $isPresented
    ) {
      Button("Discard Recovered Message", role: .destructive, action: discard)
      Button("Cancel", role: .cancel) {}
    } message: {
      Text(PendingSendRecoveryPresentation.discardMessage(for: recovery))
    }
  }
}

private struct RecoveryAttachmentPreviewView: View {
  let attachment: PreparedAttachment
  let presentation: RecoveryAttachmentPresentation

  @State private var model = RecoveryAttachmentPreviewModel()

  private var request: RecoveryAttachmentPreviewRequest {
    RecoveryAttachmentPreviewRequest(attachment: attachment)
  }

  var body: some View {
    Group {
      switch model.phase {
      case .available(let key, let preview) where key == request.key:
        Image(uiImage: preview.image)
          .resizable()
          .scaledToFit()
          .frame(maxWidth: .infinity, maxHeight: 280)
          .clipShape(RoundedRectangle(cornerRadius: DashTheme.Radius.medium))
          .accessibilityLabel(presentation.previewAccessibilityLabel)
          .accessibilityIdentifier(presentation.previewIdentifier)
      case .unavailable(let key) where key == request.key:
        unavailablePreview
      case .idle, .loading, .available, .unavailable:
        ProgressView("Loading image preview")
          .frame(maxWidth: .infinity, minHeight: 120)
          .accessibilityLabel("Loading \(presentation.previewAccessibilityLabel.lowercased())")
          .accessibilityIdentifier(
            "recovery.previewLoading.\(presentation.attachmentID.uuidString)"
          )
      }
    }
    .task(id: request.key) {
      await model.load(request, using: .shared)
    }
  }

  private var unavailablePreview: some View {
    ContentUnavailableView(
      "Image unavailable",
      systemImage: "photo.badge.exclamationmark",
      description: Text(
        "Dash couldn't preview this saved attachment, but you can still share it."
      )
    )
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(presentation.fallbackAccessibilityLabel)
    .accessibilityIdentifier(presentation.fallbackIdentifier)
  }
}

struct RecoveryAttachmentPreview: @unchecked Sendable, Equatable {
  let image: UIImage
  let pixelWidth: Int
  let pixelHeight: Int

  static func == (lhs: RecoveryAttachmentPreview, rhs: RecoveryAttachmentPreview) -> Bool {
    lhs.image === rhs.image
      && lhs.pixelWidth == rhs.pixelWidth
      && lhs.pixelHeight == rhs.pixelHeight
  }

  var estimatedCost: Int {
    let pixels = pixelWidth.multipliedReportingOverflow(by: pixelHeight)
    guard pixels.overflow == false else { return Int.max }
    let bytes = pixels.partialValue.multipliedReportingOverflow(by: 4)
    return bytes.overflow ? Int.max : max(1, bytes.partialValue)
  }
}

struct RecoveryAttachmentPreviewKey: Hashable, Sendable {
  let attachmentID: UUID
  let mediaType: String
  let byteCount: Int
  let maximumPixelDimension: Int
}

struct RecoveryAttachmentPreviewRequest: Sendable {
  static let maximumPixelDimension = 1_024

  let attachment: PreparedAttachment
  let requestedMaxPixelDimension: Int
  let key: RecoveryAttachmentPreviewKey

  init(
    attachment: PreparedAttachment,
    requestedMaxPixelDimension: Int = maximumPixelDimension
  ) {
    let boundedTarget = min(
      Self.maximumPixelDimension,
      max(1, requestedMaxPixelDimension)
    )
    self.attachment = attachment
    self.requestedMaxPixelDimension = boundedTarget
    key = RecoveryAttachmentPreviewKey(
      attachmentID: attachment.id,
      mediaType: attachment.mediaType,
      byteCount: attachment.data.count,
      maximumPixelDimension: boundedTarget
    )
  }
}

enum RecoveryAttachmentThumbnailDecoder {
  static func decode(
    _ data: Data,
    maxPixelDimension: Int
  ) async -> RecoveryAttachmentPreview? {
    let target = min(
      RecoveryAttachmentPreviewRequest.maximumPixelDimension,
      max(1, maxPixelDimension)
    )
    return await Task.detached(priority: .utility) {
      guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
      let options: [CFString: Any] = [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceThumbnailMaxPixelSize: target,
        kCGImageSourceShouldCacheImmediately: true,
      ]
      guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
      else { return nil }
      return RecoveryAttachmentPreview(
        image: UIImage(cgImage: image),
        pixelWidth: image.width,
        pixelHeight: image.height
      )
    }.value
  }
}

actor RecoveryAttachmentPreviewLoader {
  typealias Decoder = @Sendable (Data, Int) async -> RecoveryAttachmentPreview?

  static let shared = RecoveryAttachmentPreviewLoader()

  private struct CacheEntry {
    let preview: RecoveryAttachmentPreview?
    let cost: Int
    var access: UInt64
  }

  private let maximumEntryCount: Int
  private let maximumCachedCost: Int
  private let decoder: Decoder
  private var cache: [RecoveryAttachmentPreviewKey: CacheEntry] = [:]
  private var inFlight: [
    RecoveryAttachmentPreviewKey: Task<RecoveryAttachmentPreview?, Never>
  ] = [:]
  private var cachedCost = 0
  private var accessCounter: UInt64 = 0

  init(
    maximumEntryCount: Int = 12,
    maximumCachedCost: Int = 24 * 1_024 * 1_024,
    decoder: @escaping Decoder = { data, target in
      await RecoveryAttachmentThumbnailDecoder.decode(data, maxPixelDimension: target)
    }
  ) {
    self.maximumEntryCount = max(1, maximumEntryCount)
    self.maximumCachedCost = max(1, maximumCachedCost)
    self.decoder = decoder
  }

  func preview(
    for attachment: PreparedAttachment,
    requestedMaxPixelDimension: Int = RecoveryAttachmentPreviewRequest.maximumPixelDimension
  ) async -> RecoveryAttachmentPreview? {
    let request = RecoveryAttachmentPreviewRequest(
      attachment: attachment,
      requestedMaxPixelDimension: requestedMaxPixelDimension
    )
    if var cached = cache[request.key] {
      cached.access = nextAccess()
      cache[request.key] = cached
      return cached.preview
    }
    if let existing = inFlight[request.key] {
      return await existing.value
    }

    let decoder = decoder
    let data = attachment.data
    let target = request.requestedMaxPixelDimension
    let task = Task { await decoder(data, target) }
    inFlight[request.key] = task
    let decoded = await task.value
    inFlight[request.key] = nil
    insert(decoded, for: request.key)
    return decoded
  }

  private func insert(
    _ preview: RecoveryAttachmentPreview?,
    for key: RecoveryAttachmentPreviewKey
  ) {
    let cost = preview?.estimatedCost ?? 1
    cache[key] = CacheEntry(preview: preview, cost: cost, access: nextAccess())
    cachedCost = addingClamped(cachedCost, cost)
    evictIfNeeded()
  }

  private func evictIfNeeded() {
    while cache.count > maximumEntryCount || cachedCost > maximumCachedCost {
      guard let oldest = cache.min(by: { $0.value.access < $1.value.access }) else { return }
      cache[oldest.key] = nil
      cachedCost = max(0, cachedCost - oldest.value.cost)
    }
  }

  private func nextAccess() -> UInt64 {
    accessCounter &+= 1
    return accessCounter
  }

  private func addingClamped(_ lhs: Int, _ rhs: Int) -> Int {
    let result = lhs.addingReportingOverflow(rhs)
    return result.overflow ? Int.max : result.partialValue
  }
}

@MainActor
@Observable
final class RecoveryAttachmentPreviewModel {
  enum Phase: @unchecked Sendable {
    case idle
    case loading(RecoveryAttachmentPreviewKey)
    case available(RecoveryAttachmentPreviewKey, RecoveryAttachmentPreview)
    case unavailable(RecoveryAttachmentPreviewKey)
  }

  private(set) var phase: Phase = .idle
  private var revision: UInt64 = 0

  func load(
    _ request: RecoveryAttachmentPreviewRequest,
    using loader: RecoveryAttachmentPreviewLoader
  ) async {
    revision &+= 1
    let loadRevision = revision
    phase = .loading(request.key)
    let preview = await loader.preview(
      for: request.attachment,
      requestedMaxPixelDimension: request.requestedMaxPixelDimension
    )
    guard Task.isCancelled == false, revision == loadRevision else { return }
    if let preview {
      phase = .available(request.key, preview)
    } else {
      phase = .unavailable(request.key)
    }
  }
}

@MainActor
protocol RecoveryClipboardWriting {
  func write(_ text: String)
}

@MainActor
struct SystemRecoveryClipboard: RecoveryClipboardWriting {
  func write(_ text: String) {
    UIPasteboard.general.string = text
  }
}

@MainActor
struct RecoveryClipboardAction {
  let clipboard: any RecoveryClipboardWriting

  func copy(_ recovery: RecoverablePendingSend) {
    clipboard.write(recovery.pendingSend.draft)
  }

  func copy(_ draft: ConversationDraft) {
    clipboard.write(draft.text)
  }
}

struct RecoveryAttachmentPresentation: Equatable {
  let attachmentID: UUID
  let ordinal: Int
  let count: Int
  let formatName: String

  init(attachment: PreparedAttachment, ordinal: Int, count: Int) {
    attachmentID = attachment.id
    self.ordinal = ordinal
    self.count = count
    formatName = switch attachment.mediaType {
    case ImageMediaType.jpeg.rawValue: "JPEG"
    case ImageMediaType.png.rawValue: "PNG"
    case ImageMediaType.gif.rawValue: "GIF"
    case ImageMediaType.webp.rawValue: "WebP"
    default: "image"
    }
  }

  var previewAccessibilityLabel: String {
    "Recovered image attachment \(ordinal) of \(count), \(formatName)"
  }

  var fallbackAccessibilityLabel: String {
    "\(previewAccessibilityLabel), preview unavailable"
  }

  var shareAccessibilityLabel: String {
    "Share recovered image attachment \(ordinal) of \(count), \(formatName)"
  }

  var previewIdentifier: String {
    "recovery.preview.\(attachmentID.uuidString)"
  }

  var fallbackIdentifier: String {
    "recovery.previewFallback.\(attachmentID.uuidString)"
  }
}

enum RecoveryAttachmentIssueScope: Equatable {
  case pendingMessage
  case coexistingDraft
}

struct RecoveryAttachmentIssuePresentation: Equatable {
  let conversationID: String
  let scope: RecoveryAttachmentIssueScope

  init?(
    recovery: RecoverablePendingSend,
    scope: RecoveryAttachmentIssueScope = .pendingMessage
  ) {
    let issue = switch scope {
    case .pendingMessage: recovery.attachmentIssue
    case .coexistingDraft: recovery.coexistingDraftAttachmentIssue
    }
    guard issue == .unreadableStoredPayload else { return nil }
    conversationID = recovery.conversationID
    self.scope = scope
  }

  var rowLabel: String {
    switch scope {
    case .pendingMessage: "Saved image attachments unavailable"
    case .coexistingDraft: "Newer draft image attachments unavailable"
    }
  }

  var title: String {
    switch scope {
    case .pendingMessage: "Saved attachments unavailable"
    case .coexistingDraft: "Newer draft attachments unavailable"
    }
  }

  var message: String {
    switch scope {
    case .pendingMessage:
      "Dash couldn't read the saved image data. The exact message text is still available."
    case .coexistingDraft:
      "Dash couldn't read the newer draft's saved image data. Its exact text is still available."
    }
  }

  var accessibilityLabel: String {
    switch scope {
    case .pendingMessage:
      "Saved image attachments unavailable. The exact message text is still available."
    case .coexistingDraft:
      "Newer draft image attachments unavailable. Its exact text is still available."
    }
  }

  var identifier: String {
    switch scope {
    case .pendingMessage: "recovery.attachmentsUnavailable.\(conversationID)"
    case .coexistingDraft: "recovery.draft.attachmentsUnavailable.\(conversationID)"
    }
  }
}

extension View {
  /// Applies `.draggable` only when there IS a gateway to name in the
  /// payload, rather than dragging a `ConversationWindowValue` with an empty
  /// `gatewayID` that no consumer could ever match. Same shape as
  /// `MessageViews`' `draggable(_:when:)` gate, under a distinct name so the
  /// two don't read as overloads of each other.
  @ViewBuilder
  fileprivate func draggableConversation(_ value: ConversationWindowValue?) -> some View {
    if let value {
      draggable(value)
    } else {
      self
    }
  }
}

extension UTType {
  /// The app's own exported type for a conversation reference, declared in
  /// `Info.plist` under `UTExportedTypeDeclarations` (identifier
  /// `app.dash.ios.conversation`, conforming to `public.data`) and kept in
  /// the bundle id's reverse-DNS namespace. The plist declaration is what
  /// makes this a DECLARED exported type rather than an undeclared one, so
  /// the entry is load-bearing, not decoration.
  static let dashConversation = UTType(exportedAs: "app.dash.ios.conversation")
}

extension ConversationWindowValue: Transferable {
  /// Makes a conversation row a drag SOURCE carrying the same value
  /// "Open in New Window" passes to `openWindow`. Honest scope: nothing in
  /// Dash consumes this type yet — it is the payload half of the
  /// drag-a-conversation-out gesture, not by itself a way to open a window.
  static var transferRepresentation: some TransferRepresentation {
    CodableRepresentation(contentType: .dashConversation)
  }
}

struct RecoveryAttachmentExport: Equatable {
  let data: Data
  let mimeType: String
  let contentType: UTType
  let suggestedFileName: String
}

struct RecoveryAttachmentTransfer: Transferable {
  let export: RecoveryAttachmentExport

  init(attachment: PreparedAttachment) {
    let (contentType, fileExtension): (UTType, String?) =
      switch attachment.mediaType {
      case ImageMediaType.jpeg.rawValue: (.jpeg, "jpg")
      case ImageMediaType.png.rawValue: (.png, "png")
      case ImageMediaType.gif.rawValue: (.gif, "gif")
      case ImageMediaType.webp.rawValue: (.webP, "webp")
      default: (.data, nil)
      }
    let basename = "recovered-\(attachment.id.uuidString)"
    export = RecoveryAttachmentExport(
      data: attachment.data,
      mimeType: attachment.mediaType,
      contentType: contentType,
      suggestedFileName: fileExtension.map { "\(basename).\($0)" } ?? basename
    )
  }

  static var transferRepresentation: some TransferRepresentation {
    DataRepresentation(exportedContentType: .jpeg) { $0.export.data }
      .exportingCondition { $0.export.contentType == .jpeg }
      .suggestedFileName { $0.export.suggestedFileName }
    DataRepresentation(exportedContentType: .png) { $0.export.data }
      .exportingCondition { $0.export.contentType == .png }
      .suggestedFileName { $0.export.suggestedFileName }
    DataRepresentation(exportedContentType: .gif) { $0.export.data }
      .exportingCondition { $0.export.contentType == .gif }
      .suggestedFileName { $0.export.suggestedFileName }
    DataRepresentation(exportedContentType: .webP) { $0.export.data }
      .exportingCondition { $0.export.contentType == .webP }
      .suggestedFileName { $0.export.suggestedFileName }
    DataRepresentation(exportedContentType: .data) { $0.export.data }
      .exportingCondition { $0.export.contentType == .data }
      .suggestedFileName { $0.export.suggestedFileName }
  }
}

extension ConversationStatus {
  fileprivate var displayName: String {
    rawValue.capitalized
  }

  fileprivate var systemImage: String {
    switch self {
    case .idle: "checkmark.circle"
    case .running: "waveform"
    case .interrupted: "exclamationmark.circle"
    case .archived: "archivebox"
    case .deleted: "trash"
    }
  }

  fileprivate var color: Color {
    switch self {
    case .idle: .secondary
    case .running: DashTheme.accent
    case .interrupted: .orange
    case .archived: .secondary
    case .deleted: .red
    }
  }
}
