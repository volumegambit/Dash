import SwiftUI

/// Compose-first new chat (Task 3, audit #16): the ONLY agent-disambiguation
/// surface left in the app now that `NewConversationView`'s Form (agent
/// `Picker` + "Start conversation" button — three taps before typing) is
/// gone. `ConversationListView`'s compose button deliberately does NOT
/// present this — it goes straight from tap to `ChatView` using the
/// last-used (or first enabled) agent silently, no intermediate picker.
/// Instead this is presented solely by `ChatView`'s header agent chip, while
/// the open conversation is still empty (no message ever sent) — picking a
/// different agent there can't patch the open conversation's agent in place
/// (the gateway's conversation API has no agent-reassignment endpoint;
/// `PatchConversationRequest` only carries `title`/`owningIssueId`/
/// `projectId`), so `ChatView` creates a fresh conversation under the chosen
/// agent and swaps over to it instead — see `ChatView.switchAgent(to:)` and
/// `AppModel.replaceConversation`.
///
/// Deliberately list-based (not `NewConversationView`'s inline `Form` +
/// `Picker`) since it now stands alone as a sheet rather than sharing a
/// screen with a "Start conversation" button.
struct AgentPickerSheet: View {
  @Environment(\.dismiss) private var dismiss

  let agents: [RegisteredAgentDTO]
  let currentAgentID: String?
  let onSelect: (RegisteredAgentDTO) -> Void

  var body: some View {
    NavigationStack {
      List {
        if availableAgents.isEmpty {
          ContentUnavailableView(
            "No available agents",
            systemImage: "person.2.slash",
            description: Text("Enable or create an agent before starting a conversation.")
          )
        } else {
          ForEach(availableAgents) { agent in
            Button {
              onSelect(agent)
              dismiss()
            } label: {
              // Two-line row mirroring `AgentsListView` (agents-list goal
              // 2026-09-10) — this sheet was bare accent-blue text rows,
              // which read as links rather than choices, with nothing to
              // tell two agents on the same model apart at a glance. Name
              // carries `.primary` (not accent), the model's short name
              // sits under it, and the avatar gives each agent a stable
              // identity mark shared with the Agents tab.
              HStack(spacing: 12) {
                AgentAvatar(name: agent.name)
                VStack(alignment: .leading, spacing: 2) {
                  Text(agent.name)
                    .font(.headline)
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                  Text(agent.config.model.split(separator: "/").last.map(String.init)
                    ?? agent.config.model)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                }
                Spacer()
                if agent.id == currentAgentID {
                  Image(systemName: "checkmark")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(DashTheme.accent)
                    .accessibilityHidden(true)
                }
              }
              .frame(minHeight: 44)
              .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            // The faint wash the conversation and agent lists use for their
            // selected row, so "which one is current" reads the same way on
            // every list surface — the checkmark alone had to carry it before.
            .listRowBackground(
              agent.id == currentAgentID
                ? DashTheme.accent.opacity(DashTheme.Opacity.fillMuted)
                : Color.clear
            )
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(agent.name), \(agent.config.model)")
            .accessibilityIdentifier("chat.agentPicker.row.\(agent.id)")
            .accessibilityAddTraits(agent.id == currentAgentID ? .isSelected : [])
          }
        }
      }
      .navigationTitle("Choose Agent")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
        }
      }
    }
    .accessibilityIdentifier("chat.agentPicker.sheet")
  }

  /// Enabled agents, current one first (the default you are most likely
  /// re-confirming or switching away from belongs at the top, not wherever
  /// registration order left it). Pure and static so the ordering rule is
  /// unit-testable the way `ComposeAgentSelection.resolve` is.
  private var availableAgents: [RegisteredAgentDTO] {
    Self.availableAgents(agents, currentAgentID: currentAgentID)
  }

  static func availableAgents(
    _ agents: [RegisteredAgentDTO],
    currentAgentID: String?
  ) -> [RegisteredAgentDTO] {
    let enabled = agents.filter { $0.status != .disabled }
    guard let currentAgentID,
      let currentIndex = enabled.firstIndex(where: { $0.id == currentAgentID }),
      currentIndex != 0
    else { return enabled }
    var reordered = enabled
    let current = reordered.remove(at: currentIndex)
    reordered.insert(current, at: 0)
    return reordered
  }
}
