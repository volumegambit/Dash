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
              HStack {
                Text(agent.name)
                  .foregroundStyle(.primary)
                Spacer()
                if agent.id == currentAgentID {
                  Image(systemName: "checkmark")
                    .foregroundStyle(DashTheme.accent)
                }
              }
              .frame(minHeight: 44)
              .contentShape(Rectangle())
            }
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

  private var availableAgents: [RegisteredAgentDTO] {
    agents.filter { $0.status != .disabled }
  }
}
