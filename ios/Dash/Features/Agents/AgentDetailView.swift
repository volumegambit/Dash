import SwiftUI

struct AgentDetailView: View {
  let agentID: String

  @Environment(AppModel.self) private var appModel
  @Environment(AgentsFeature.self) private var feature
  @Environment(\.dismiss) private var dismiss
  @Environment(\.horizontalSizeClass) private var horizontalSizeClass

  @State private var showDisableConfirmation = false
  @State private var showDeleteConfirmation = false
  @State private var deleteName = ""
  @State private var isWorking = false

  var body: some View {
    Group {
      if let agent {
        List {
          Section("Agent") {
            LabeledContent("Status", value: agent.status.displayName)
            LabeledContent("Model", value: agent.config.model)
            if agent.config.systemPrompt.isEmpty == false {
              VStack(alignment: .leading, spacing: 6) {
                Text("System prompt")
                  .font(.caption)
                  .foregroundStyle(.secondary)
                Text(agent.config.systemPrompt)
                  .textSelection(.enabled)
              }
              .padding(.vertical, 4)
            }
          }

          Section {
            Button {
              Task { await startChat() }
            } label: {
              HStack {
                Spacer()
                if isWorking {
                  ProgressView()
                } else {
                  Label("Start Chat", systemImage: "bubble.left.and.text.bubble.right")
                }
                Spacer()
              }
              .frame(minHeight: 44)
            }
            .buttonStyle(.borderedProminent)
            .disabled(feature.mutationsAllowed == false || isWorking)
            .accessibilityHint(
              feature.mutationsAllowed ? "" : "Connect to the gateway to start a conversation"
            )
            .accessibilityIdentifier("agent.startChat")
          }

          configurationSection(agent)
          integrationsSection(agent)
          swarmSection(agent)
        }
        .accessibilityIdentifier("agent.detail.\(agentID)")
        .frame(maxWidth: DashTheme.Layout.readableWidth)
        .frame(maxWidth: .infinity)
      } else {
        ContentUnavailableView(
          "Agent unavailable",
          systemImage: "person.crop.circle.badge.questionmark",
          description: Text("Refresh the agent list and try again.")
        )
      }
    }
    .navigationTitle(agent?.name ?? "Agent")
    .toolbar {
      if let agent {
        ToolbarItem(placement: .topBarTrailing) {
          Button("Edit") {
            appModel.openAgent(
              .edit(agent.id),
              presentation: AdaptiveNavigationPolicy.presentation(
                horizontalSizeClass: horizontalSizeClass
              )
            )
          }
          .disabled(feature.mutationsAllowed == false || isWorking)
          .accessibilityHint(feature.mutationsAllowed ? "" : "Connect to the gateway to edit")
          .accessibilityIdentifier("agent.edit")
        }
        ToolbarItem(placement: .topBarTrailing) {
          agentActionsMenu(agent)
        }
      }
    }
    .alert("Delete \(agent?.name ?? "agent")?", isPresented: $showDeleteConfirmation) {
      TextField("Type the agent name", text: $deleteName)
        .textInputAutocapitalization(.never)
      Button("Cancel", role: .cancel) {}
      Button("Delete", role: .destructive) {
        Task { await deleteAgent() }
      }
      .disabled(deleteName != agent?.name)
    } message: {
      Text("Type the exact agent name. Its conversations stay archived and read-only.")
    }
  }

  /// The `agent.actions` toolbar menu, extracted from `body`'s `.toolbar`
  /// because attaching its confirmation dialog inline pushed that expression
  /// past the type-checker's budget.
  private func agentActionsMenu(_ agent: RegisteredAgentDTO) -> some View {
    Menu {
      if agent.status == .disabled {
        Button {
          Task { await setEnabled(true) }
        } label: {
          Label("Enable", systemImage: "play.circle")
        }
      } else {
        Button {
          showDisableConfirmation = true
        } label: {
          Label("Disable", systemImage: "pause.circle")
        }
      }
      Button(role: .destructive) {
        deleteName = ""
        showDeleteConfirmation = true
      } label: {
        Label("Delete", systemImage: "trash")
      }
    } label: {
      Label("Agent actions", systemImage: "ellipsis.circle")
        .frame(minWidth: 44, minHeight: 44)
    }
    .disabled(feature.mutationsAllowed == false || isWorking)
    .accessibilityHint(
      feature.mutationsAllowed ? "" : "Connect to the gateway to manage this agent"
    )
    .accessibilityIdentifier("agent.actions")
    // Presentation audit (iPad goal Phase D, Task 11): a `confirmationDialog`
    // is a POPOVER at iPad regular width, and UIKit takes its source rect from
    // the view the modifier is attached to. Attached to `body`'s root — where
    // this used to live — it anchored to the middle-left edge of the whole
    // agent-detail pane, diagonally opposite this toolbar button. Attached
    // here it anchors to the button. Compact width is unaffected: still a
    // bottom action sheet.
    //
    // Deliberately OUTSIDE the `.disabled(…)` above: presented content
    // inherits the presenter's environment, so wrapping it the other way round
    // would let `isWorking` grey out the dialog's own buttons.
    //
    // Review follow-up: moving the anchor here also coupled the dialog's
    // lifecycle to `agent` — this menu only exists inside `body`'s
    // `if let agent { ToolbarItem { agentActionsMenu(agent) } }`, and `agent`
    // is a lookup (`feature.agents.first { $0.id == agentID }`) over a live
    // array that `AgentsFeature.refresh()` replaces wholesale, so it can
    // transiently go nil. If that happens while this dialog is open, the
    // whole `ToolbarItem` — dialog included — is torn out of the hierarchy.
    // `showDisableConfirmation` is `@State` on `AgentDetailView`, not on this
    // menu, so the flag would otherwise outlive that teardown: if SwiftUI
    // does not reset the binding itself, a later refresh that repopulates
    // the same id would bring this menu back with the flag still `true` and
    // the dialog reappearing unprompted, unconfirmed. The `.onDisappear`
    // below makes that impossible regardless of what SwiftUI does with the
    // binding. It only fires when this menu's `ToolbarItem` actually leaves
    // the hierarchy (i.e. `agent` really went nil), not on an ordinary
    // refresh that keeps `agent` non-nil, so it cannot cancel a dialog the
    // user is actively looking at during a routine refresh.
    .onDisappear { showDisableConfirmation = false }
    .confirmationDialog(
      "Disable \(agent.name)?",
      isPresented: $showDisableConfirmation,
      titleVisibility: .visible
    ) {
      Button("Disable", role: .destructive) {
        Task { await setEnabled(false) }
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("Disabling this agent stops its active work. Existing conversations remain available.")
    }
  }

  private var agent: RegisteredAgentDTO? {
    feature.agents.first { $0.id == agentID }
  }

  @ViewBuilder
  private func configurationSection(_ agent: RegisteredAgentDTO) -> some View {
    Section("Configuration") {
      optionalList("Fallback models", agent.config.fallbackModels)
      optionalList("Tools", agent.config.tools)
      if let workspace = agent.config.workspace, workspace.isEmpty == false {
        LabeledContent("Workspace", value: workspace)
      }
      if let maxTokens = agent.config.maxTokens {
        LabeledContent("Max tokens", value: maxTokens.formatted())
      }
      optionalList("Providers", agent.config.providers)
      optionalList("Plugins", agent.config.plugins)
    }
  }

  @ViewBuilder
  private func integrationsSection(_ agent: RegisteredAgentDTO) -> some View {
    Section("Integrations") {
      optionalList("MCP servers", agent.config.mcpServers)
      optionalList("Skill paths", agent.config.skills?.paths)
      optionalList("Skill URLs", agent.config.skills?.urls)
    }
  }

  @ViewBuilder
  private func swarmSection(_ agent: RegisteredAgentDTO) -> some View {
    if let swarm = agent.config.swarm {
      Section("Swarm") {
        if let enabled = swarm.enabled {
          LabeledContent("Enabled", value: enabled ? "Yes" : "No")
        }
        optionalNumber("Concurrent workers", swarm.maxConcurrentWorkers)
        optionalNumber("Workers per run", swarm.maxWorkersPerRun)
        optionalNumber("Steers per worker", swarm.maxSteersPerWorker)
        optionalNumber("Maximum run seconds", swarm.maxRunSeconds)
        optionalList("Allowed models", swarm.allowedModels)
      }
    }
  }

  @ViewBuilder
  private func optionalList(_ title: String, _ values: [String]?) -> some View {
    if let values, values.isEmpty == false {
      VStack(alignment: .leading, spacing: 4) {
        Text(title)
          .font(.caption)
          .foregroundStyle(.secondary)
        Text(values.joined(separator: ", "))
          .textSelection(.enabled)
      }
      .padding(.vertical, 2)
    }
  }

  @ViewBuilder
  private func optionalNumber(_ title: String, _ value: Int?) -> some View {
    if let value {
      LabeledContent(title, value: value.formatted())
    }
  }

  private func setEnabled(_ enabled: Bool) async {
    isWorking = true
    defer { isWorking = false }
    await feature.setEnabled(id: agentID, enabled: enabled, confirmed: true)
  }

  private func deleteAgent() async {
    isWorking = true
    defer { isWorking = false }
    await feature.delete(id: agentID, confirmedName: deleteName)
    guard feature.agents.contains(where: { $0.id == agentID }) == false else { return }
    appModel.agentPath.removeAll()
    dismiss()
  }

  private func startChat() async {
    isWorking = true
    defer { isWorking = false }
    guard let conversationID = await feature.startChat(agentID: agentID) else { return }
    appModel.openConversation(
      conversationID,
      presentation: AdaptiveNavigationPolicy.presentation(
        horizontalSizeClass: horizontalSizeClass
      )
    )
  }
}
