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
            // Same measure as the gateway picker and sign-in. A primary
            // action stretched across ~700pt of an 11-inch iPad detail column
            // reads as an unfinished phone layout; the constraint is what the
            // other pre-connection screens already use.
            .frame(maxWidth: 520)
            .frame(maxWidth: .infinity)
            .disabled(feature.mutationsAllowed == false || isWorking)
            .accessibilityHint(
              feature.mutationsAllowed ? "" : "Connect to the gateway to start a conversation"
            )
            .accessibilityIdentifier("agent.startChat")
          }

          configurationSection(agent)
          integrationsSection(agent)
          memorySection(agent)
          swarmSection(agent)
        }
        .accessibilityIdentifier("agent.detail.\(agentID)")
      } else {
        ContentUnavailableView(
          "Agent unavailable",
          systemImage: "person.crop.circle.badge.questionmark",
          description: Text("Refresh the agent list and try again.")
        )
      }
    }
    .navigationTitle(agent?.name ?? "Agent")
    // Loaded from the view root, not from `memorySection`: a `.task` attached
    // to a `Section` restarts every time the section is rebuilt, and the load
    // itself writes `feature.memories`, so it re-triggers itself forever.
    .task(id: agentID) { await feature.loadMemories(agentID: agentID) }
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
        }
      }
    }
    .confirmationDialog(
      "Disable \(agent?.name ?? "agent")?",
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
    // Only when there is something to integrate. Every value inside is
    // optional, so an agent with no MCP servers and no skills rendered a
    // bare "Integrations" header over nothing — a section title is a promise
    // that content follows.
    if hasIntegrations(agent) {
      Section("Integrations") {
        optionalList("MCP servers", agent.config.mcpServers)
        optionalList("Skill paths", agent.config.skills?.paths)
        optionalList("Skill URLs", agent.config.skills?.urls)
      }
    }
  }

  private func hasIntegrations(_ agent: RegisteredAgentDTO) -> Bool {
    let lists = [agent.config.mcpServers, agent.config.skills?.paths, agent.config.skills?.urls]
    return lists.contains { ($0?.isEmpty == false) }
  }

  /// The Memory section, grouped by `MemoryTypeDTO` bucket (the enum is
  /// `CaseIterable` for exactly this). Swipe-to-delete is the only mutation
  /// the phone gets — writes stay loopback-only.
  ///
  /// Accessibility identifiers deliberately sit on LEAF views: the section
  /// header carries `agent.memory.list` and each row carries
  /// `agent.memory.row.<name>`. Putting an identifier on the `Section` (a
  /// container) makes XCUITest collapse it into one element and erases the
  /// per-row identifiers underneath it.
  @ViewBuilder
  private func memorySection(_ agent: RegisteredAgentDTO) -> some View {
    Section {
      let rows = feature.memories[agent.id] ?? []
      if rows.isEmpty {
        Text("No memories yet.")
          .foregroundStyle(.secondary)
          .accessibilityIdentifier("agent.memory.empty")
      } else {
        ForEach(MemoryTypeDTO.allCases, id: \.self) { type in
          let group = rows.filter { $0.type == type }
          if group.isEmpty == false {
            Text(memoryTypeTitle(type))
              .font(.caption)
              .foregroundStyle(.secondary)
            ForEach(group) { memory in
              memoryRow(agentID: agent.id, memory: memory)
            }
          }
        }
      }
    } header: {
      Text("Memory")
        .accessibilityIdentifier("agent.memory.list")
    }
  }

  @ViewBuilder
  private func memoryRow(agentID: String, memory: MemoryInfoDTO) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(memory.description)
      Text(memory.name)
        .font(.caption)
        .foregroundStyle(.secondary)
    }
    .padding(.vertical, 2)
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("agent.memory.row.\(memory.name)")
    .swipeActions(edge: .trailing) {
      Button("Delete", role: .destructive) {
        Task { await feature.deleteMemory(agentID: agentID, name: memory.name) }
      }
      .disabled(feature.mutationsAllowed == false)
    }
  }

  private func memoryTypeTitle(_ type: MemoryTypeDTO) -> String {
    switch type {
    case .user: "User"
    case .feedback: "Feedback"
    case .project: "Project"
    case .reference: "Reference"
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
