import SwiftUI

struct NewConversationView: View {
  @Environment(AppModel.self) private var appModel
  @Environment(ConversationListFeature.self) private var feature
  @Environment(\.dismiss) private var dismiss
  @Environment(\.horizontalSizeClass) private var horizontalSizeClass

  @State private var selectedAgentID: String?
  @State private var isCreating = false

  var body: some View {
    Form {
      Section("Agent") {
        if availableAgents.isEmpty {
          ContentUnavailableView(
            "No available agents",
            systemImage: "person.2.slash",
            description: Text("Enable or create an agent before starting a conversation.")
          )
        } else {
          Picker("Agent", selection: $selectedAgentID) {
            Text("Choose an agent").tag(String?.none)
            ForEach(availableAgents) { agent in
              Text(agent.name).tag(String?.some(agent.id))
            }
          }
        }
      }

      Section {
        Button {
          guard let selectedAgentID else { return }
          Task { await createConversation(agentID: selectedAgentID) }
        } label: {
          HStack {
            Spacer()
            if isCreating {
              ProgressView()
            } else {
              Text("Start conversation")
            }
            Spacer()
          }
          .frame(minHeight: 44)
        }
        .disabled(selectedAgentID == nil || feature.mutationsAllowed == false || isCreating)
        .accessibilityHint(
          feature.mutationsAllowed ? "" : "Connect to the gateway to create a conversation"
        )
      }

      if feature.mutationsAllowed == false {
        Section {
          Label("Connect to the gateway to start a conversation", systemImage: "wifi.slash")
            .foregroundStyle(.secondary)
        }
      }
    }
    .navigationTitle("New conversation")
    .task { await feature.loadAgentChoices() }
  }

  private var availableAgents: [RegisteredAgentDTO] {
    feature.agents.filter { $0.status != .disabled }
  }

  private func createConversation(agentID: String) async {
    isCreating = true
    defer { isCreating = false }
    let priorSelection = feature.selectedID
    await feature.create(agentID: agentID)
    guard let conversationID = feature.selectedID, conversationID != priorSelection else { return }
    dismiss()
    await Task.yield()
    appModel.openConversation(
      conversationID,
      presentation: AdaptiveNavigationPolicy.presentation(
        horizontalSizeClass: horizontalSizeClass
      )
    )
  }
}
