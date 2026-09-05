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
            // Two lines, matching the conversation list (UI-quality goal,
            // Phase C). This was three: name / model / status — and the
            // status line read "Ready" on every agent that was not disabled,
            // so the badge meant to flag the unusual case cost a line on
            // every row where nothing was wrong. Three agents filled a
            // column that now holds eight.
            HStack(alignment: .firstTextBaseline, spacing: 12) {
              // `firstTextBaseline`, not centre: against a multi-line row the
              // glyph used to float halfway down instead of sitting with the
              // name it describes.
              Image(systemName: agent.status.systemImage)
                .foregroundStyle(agent.status.color)
                .frame(width: 28)
                .accessibilityHidden(true)
              VStack(alignment: .leading, spacing: 3) {
                Text(agent.name)
                  .font(.headline)
                  .foregroundStyle(.primary)
                  .lineLimit(1)
                  .truncationMode(.tail)
                HStack(spacing: 0) {
                  // Provider prefix dropped: in a sidebar-width column
                  // "anthropic/claude-sonnet-4-5 · Disabled" truncated to
                  // "anthropi...nnet-4-5 · Disabled", which is unreadable.
                  // The prefix is the least distinguishing part of the id —
                  // the same reason `ToolPresentation.shortenCommand` drops
                  // a binary's directory. `ModelCatalog.label` uses this
                  // fallback too.
                  Text(agent.config.model.split(separator: "/").last.map(String.init)
                    ?? agent.config.model)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                  // Only the states worth reacting to. `registered` ("Ready")
                  // is nearly every agent, so naming it says nothing.
                  if agent.status != .registered {
                    Text(verbatim: " · ")
                      .font(.subheadline)
                      .foregroundStyle(.secondary)
                    Text(agent.status.displayName)
                      .font(.subheadline.weight(.medium))
                      .foregroundStyle(agent.status.color)
                  }
                }
                .lineLimit(1)
                .truncationMode(.middle)
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
            isSelected(agent.id) ? DashTheme.accent.opacity(DashTheme.Opacity.fillMuted) : Color.clear
          )
          .accessibilityElement(children: .combine)
          // Explicit, because the visual row now hides the status for
          // `registered` agents. `children: .combine` would drop it from the
          // spoken label with it; VoiceOver users lose nothing here.
          .accessibilityLabel(
            "\(agent.name), \(agent.config.model), \(agent.status.displayName)"
          )
          .accessibilityAddTraits(isSelected(agent.id) ? .isSelected : [])
          .accessibilityIdentifier("agent.row.\(agent.id)")
          // Squares the separator with the row instead of leaving it inset
          // under the text column — same fix as `ConversationListView`.
          .alignmentGuide(.listRowSeparatorLeading) { _ in 0 }
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
