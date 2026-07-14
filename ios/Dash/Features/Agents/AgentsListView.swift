import SwiftUI

struct AgentsListView: View {
  @Environment(AppModel.self) private var appModel
  @Environment(AgentsFeature.self) private var feature

  let presentation: NavigationPresentation

  var body: some View {
    List {
      if feature.agents.isEmpty {
        ContentUnavailableView(
          feature.mutationsAllowed ? "No agents" : "No cached agents",
          systemImage: feature.mutationsAllowed ? "person.2.slash" : "wifi.slash",
          description: Text(
            feature.mutationsAllowed
              ? "Create an agent to start a conversation."
              : "Connect to the gateway to load agents."
          )
        )
        .listRowBackground(Color.clear)
      } else {
        ForEach(feature.agents) { agent in
          Button {
            appModel.openAgent(
              .detail(agent.id),
              presentation: presentation
            )
          } label: {
            HStack(spacing: 12) {
              Image(systemName: agent.status.systemImage)
                .foregroundStyle(agent.status.color)
                .frame(width: 28)
                .accessibilityHidden(true)
              VStack(alignment: .leading, spacing: 4) {
                Text(agent.name)
                  .font(.headline)
                  .foregroundStyle(.primary)
                Text(agent.config.model)
                  .font(.subheadline)
                  .foregroundStyle(.secondary)
                  .lineLimit(1)
                Text(agent.status.displayName)
                  .font(.caption)
                  .foregroundStyle(.secondary)
              }
              Spacer()
              Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tertiary)
                .accessibilityHidden(true)
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .listRowBackground(
            isSelected(agent.id) ? DashTheme.accent.opacity(0.12) : Color.clear
          )
          .accessibilityElement(children: .combine)
          .accessibilityAddTraits(isSelected(agent.id) ? .isSelected : [])
          .accessibilityIdentifier("agent.row.\(agent.id)")
        }
      }
    }
    .listStyle(.plain)
    .navigationTitle("Agents")
    .accessibilityIdentifier("agent.list")
    .refreshable { await feature.refresh() }
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Button {
          appModel.openAgent(
            .create,
            presentation: presentation
          )
        } label: {
          Label("Create agent", systemImage: "person.badge.plus")
            .frame(minWidth: 44, minHeight: 44)
        }
        .disabled(feature.mutationsAllowed == false)
        .accessibilityIdentifier("agent.create")
        .accessibilityHint(
          feature.mutationsAllowed ? "" : "Connect to the gateway to create an agent"
        )
      }
    }
    .task { await feature.start() }
    .alert("Agent update failed", isPresented: errorPresented) {
      Button("OK") { feature.mutationError = nil }
    } message: {
      Text(feature.mutationError ?? "Dash couldn't complete the update.")
    }
  }

  private var errorPresented: Binding<Bool> {
    Binding(
      get: { feature.mutationError != nil },
      set: { if $0 == false { feature.mutationError = nil } }
    )
  }

  private func isSelected(_ agentID: String) -> Bool {
    guard case .regular = presentation else { return false }
    return appModel.splitAgentSelection?.selectsAgent(agentID) == true
  }
}

extension RegisteredAgentStatus {
  var displayName: String {
    switch self {
    case .registered: "Ready"
    case .active: "Active"
    case .disabled: "Disabled"
    }
  }

  var systemImage: String {
    switch self {
    case .registered: "checkmark.circle"
    case .active: "waveform.circle"
    case .disabled: "pause.circle"
    }
  }

  var color: Color {
    switch self {
    case .registered: DashTheme.accent
    case .active: .green
    case .disabled: .secondary
    }
  }
}
