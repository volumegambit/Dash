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
  @State private var isPromptExpanded = false

  var body: some View {
    Group {
      if let agent {
        List {
          // No section title: the navigation bar already names the agent, and
          // "Research Agent" over a card headed "Agent" said the noun twice
          // (agent-detail refinement 2026-09-07, finding 5).
          Section {
            LabeledContent("Status", value: agent.status.displayName)
            LabeledContent("Model", value: agent.config.model)
            if agent.config.systemPrompt.isEmpty == false {
              systemPromptRow(agent.config.systemPrompt)
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
            // Disabled for a disabled agent too, not just offline: the gateway
            // refuses to run a disabled agent, so the tap could only produce
            // an empty conversation that errors on first send. Mission Control
            // hides Chat in this state; the phone keeps the control visible
            // and greyed so the state has an explanation (finding 3).
            .disabled(canStartChat(agent) == false || isWorking)
            .accessibilityHint(
              AgentDetailPresentation.startChatHint(
                status: agent.status, online: feature.mutationsAllowed
              )
            )
            .accessibilityIdentifier("agent.startChat")
            // A prominent pill inside an inset-grouped row rendered as a
            // button in a box: the row's card background wrapped the capsule
            // with 16pt of padding on every side (finding 2). Clearing the
            // row chrome lets the pill stand alone the way the parity apps'
            // primary actions do.
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets())
          }

          configurationSection(agent)
          toolsSection(agent)
          integrationsSection(agent)
          memorySection(agent)
          skillsSection(agent)
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
    // Loaded from the view root, not from `memorySection`: a `.task` attached
    // to a `Section` restarts every time the section is rebuilt, and the load
    // itself writes `feature.memories`, so it re-triggers itself forever.
    .task(id: agentID) { await feature.loadMemories(agentID: agentID) }
    // Same reasoning as the memory load: attached to the view root, not the
    // section, so writing `feature.skills` cannot re-trigger it.
    .task(id: agentID) { await feature.loadSkills(agentID: agentID) }
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

  private func canStartChat(_ agent: RegisteredAgentDTO) -> Bool {
    AgentDetailPresentation.canStartChat(status: agent.status, online: feature.mutationsAllowed)
  }

  /// The system prompt, clamped to `AgentDetailPresentation.promptLineLimit`
  /// lines with a Show more / Show less toggle when it is long (finding 6).
  /// Real prompts run to hundreds of lines and used to push Start Chat — the
  /// screen's one action — below the fold. Short prompts get no toggle.
  @ViewBuilder
  private func systemPromptRow(_ prompt: String) -> some View {
    let isLong = AgentDetailPresentation.isPromptLong(prompt)
    VStack(alignment: .leading, spacing: 6) {
      Text("System prompt")
        .font(.caption)
        .foregroundStyle(.secondary)
      Text(prompt)
        .textSelection(.enabled)
        .lineLimit(isLong && isPromptExpanded == false ? AgentDetailPresentation.promptLineLimit : nil)
      if isLong {
        Button(isPromptExpanded ? "Show less" : "Show more") {
          withAnimation { isPromptExpanded.toggle() }
        }
        .font(.subheadline)
        .buttonStyle(.borderless)
        .accessibilityIdentifier("agent.prompt.toggle")
      }
    }
    .padding(.vertical, 4)
  }

  /// Only when at least one optional value is set. Every row inside is
  /// conditional, and for most agents (and every fixture agent) all of them
  /// are absent, which rendered a bare "Configuration" title over nothing,
  /// directly above "Tools" (finding 1). Same guard `integrationsSection`
  /// already applies.
  @ViewBuilder
  private func configurationSection(_ agent: RegisteredAgentDTO) -> some View {
    if AgentDetailPresentation.hasConfiguration(agent.config) {
      Section("Configuration") {
        optionalList("Fallback models", agent.config.fallbackModels)
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
  }

  /// The agent's enabled tools, grouped and described the way the deploy
  /// wizard and Mission Control's Tools card present them, rather than the
  /// comma-joined raw ids (`web_fetch, read_file, …`) this used to show.
  /// Omitted entirely when the agent has no tools — a section header is a
  /// promise that content follows.
  @ViewBuilder
  private func toolsSection(_ agent: RegisteredAgentDTO) -> some View {
    let enabled = agent.config.tools ?? []
    if enabled.isEmpty == false {
      let groups = AgentToolCatalog.groups(enabled: enabled)
      Section {
        ForEach(groups) { group in
          AgentToolGroupRow(group: group)
        }
      } header: {
        Text("Tools (\(enabled.count))")
          // Leaf anchor for UI tests, like `agent.memory.list`: iOS 18
          // upper-cases inset-grouped headers, so the rendered text differs
          // per runtime and cannot be matched literally.
          .accessibilityIdentifier("agent.tools.list")
      }
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
  /// Read-only. The mobile API exposes no skill mutation, so there is nothing
  /// to edit here — the value is seeing what the agent taught itself.
  private func skillsSection(_ agent: RegisteredAgentDTO) -> some View {
    Section {
      // `nil` means the load has not returned yet; `[]` means it returned
      // nothing (`loadSkills` writes `[]` on failure too, so this cannot
      // stick). Showing "No skills yet." for `nil` claimed an answer the
      // screen did not have (finding 7).
      if let rows = feature.skills[agent.id] {
        if rows.isEmpty {
          Text("No skills yet.")
            .foregroundStyle(.secondary)
            .accessibilityIdentifier("agent.skills.empty")
        } else {
          skillRows(rows)
        }
      } else {
        loadingRow("Loading skills", identifier: "agent.skills.loading")
      }
    } header: {
      Text("Skills")
        .accessibilityIdentifier("agent.skills.list")
    }
  }

  @ViewBuilder
  private func skillRows(_ rows: [SkillDTO]) -> some View {
    ForEach(rows) { skill in
      NavigationLink {
        SkillDetailView(skill: skill)
      } label: {
        VStack(alignment: .leading, spacing: 2) {
          HStack {
            Text(skill.name)
            Spacer(minLength: 8)
            Text(skill.source.label)
              .font(.caption)
              .foregroundStyle(.secondary)
          }
          Text(skill.description)
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(2)
        }
      }
      .accessibilityIdentifier("agent.skill.\(skill.name)")
    }
  }

  private func memorySection(_ agent: RegisteredAgentDTO) -> some View {
    Section {
      // Same nil-vs-empty distinction as `skillsSection`.
      if let rows = feature.memories[agent.id] {
        if rows.isEmpty {
          Text("No memories yet.")
            .foregroundStyle(.secondary)
            .accessibilityIdentifier("agent.memory.empty")
        } else {
          ForEach(MemoryTypeDTO.allCases, id: \.self) { type in
            let group = rows.filter { $0.type == type }
            if group.isEmpty == false {
              memoryBucketHeader(memoryTypeTitle(type))
              ForEach(group) { memory in
                memoryRow(agentID: agent.id, memory: memory)
              }
            }
          }
        }
      } else {
        loadingRow("Loading memories", identifier: "agent.memory.loading")
      }
    } header: {
      Text("Memory")
        .accessibilityIdentifier("agent.memory.list")
    }
  }

  /// A bucket title ("User", "Project") rendered as a sub-header rather than
  /// as a row: a plain caption `Text` got full row height and a separator on
  /// both sides, and read as an empty item between memories (finding 4).
  /// The bottom separator is dropped so the title attaches to the rows it
  /// introduces; the top one stays to close the bucket above.
  private func memoryBucketHeader(_ title: String) -> some View {
    Text(title)
      .font(.caption.weight(.semibold))
      .textCase(.uppercase)
      .foregroundStyle(.secondary)
      .listRowInsets(EdgeInsets(top: 12, leading: 20, bottom: 4, trailing: 20))
      .listRowSeparator(.hidden, edges: .bottom)
      .accessibilityAddTraits(.isHeader)
  }

  private func loadingRow(_ title: LocalizedStringKey, identifier: String) -> some View {
    HStack(spacing: 10) {
      ProgressView()
      Text(title)
        .foregroundStyle(.secondary)
    }
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier(identifier)
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

// ---------------------------------------------------------------------------
// Tools group row
// ---------------------------------------------------------------------------

/// One functional tool group (Read & Search, Web, …) rendered as a labeled
/// header, its plain-language description, and a wrapping row of tool-name
/// chips. Mirrors the grouped, described treatment of Mission Control's
/// agent-detail Tools card.
private struct AgentToolGroupRow: View {
  let group: AgentToolCatalog.ToolGroup

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(group.name)
        .font(.subheadline.weight(.medium))
      if let description = group.description {
        Text(description)
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      AgentToolChipFlow(tools: group.tools)
        .padding(.top, 2)
    }
    .padding(.vertical, 4)
    .accessibilityElement(children: .contain)
    .accessibilityLabel("\(group.name): \(group.tools.map(AgentToolCatalog.label(for:)).joined(separator: ", "))")
  }
}

/// A wrapping flow of tool-name chips. Uses SwiftUI's native `Layout` so the
/// chips wrap to as many lines as the width needs, rather than clipping or
/// scrolling.
private struct AgentToolChipFlow: View {
  let tools: [String]

  var body: some View {
    FlowLayout(spacing: 6, lineSpacing: 6) {
      ForEach(tools, id: \.self) { id in
        Text(AgentToolCatalog.label(for: id))
          .font(.caption)
          .padding(.horizontal, 8)
          .padding(.vertical, 3)
          .background(
            Color.secondary.opacity(DashTheme.Opacity.fillSubtle),
            in: Capsule()
          )
          .overlay(Capsule().strokeBorder(Color.secondary.opacity(DashTheme.Opacity.fillMuted)))
      }
    }
  }
}

/// Minimal wrapping layout: places subviews left to right, wrapping to a new
/// line when the next subview would overflow the proposed width.
private struct FlowLayout: Layout {
  var spacing: CGFloat = 6
  var lineSpacing: CGFloat = 6

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let maxWidth = proposal.width ?? .infinity
    var rows = layout(subviews: subviews, maxWidth: maxWidth)
    return rows.size
  }

  func placeSubviews(
    in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()
  ) {
    let rows = layout(subviews: subviews, maxWidth: bounds.width)
    var y = bounds.minY
    for row in rows.lines {
      var x = bounds.minX
      for index in row.indices {
        let size = row.sizes[index - row.startIndex]
        subviews[index].place(
          at: CGPoint(x: x, y: y),
          anchor: .topLeading,
          proposal: ProposedViewSize(size))
        x += size.width + spacing
      }
      y += row.height + lineSpacing
    }
  }

  private struct Row {
    var startIndex: Int
    var indices: Range<Int>
    var sizes: [CGSize]
    var height: CGFloat
  }

  private struct Rows {
    var lines: [Row]
    var size: CGSize
  }

  private func layout(subviews: Subviews, maxWidth: CGFloat) -> Rows {
    var lines: [Row] = []
    var currentSizes: [CGSize] = []
    var currentStart = 0
    var x: CGFloat = 0
    var rowHeight: CGFloat = 0
    var totalHeight: CGFloat = 0
    var maxRowWidth: CGFloat = 0

    func flush(endIndex: Int) {
      guard currentSizes.isEmpty == false else { return }
      lines.append(
        Row(
          startIndex: currentStart,
          indices: currentStart..<endIndex,
          sizes: currentSizes,
          height: rowHeight))
      totalHeight += rowHeight + lineSpacing
      maxRowWidth = max(maxRowWidth, x - spacing)
    }

    for index in subviews.indices {
      let size = subviews[index].sizeThatFits(.unspecified)
      if currentSizes.isEmpty == false, x + size.width > maxWidth {
        flush(endIndex: index)
        currentSizes = []
        currentStart = index
        x = 0
        rowHeight = 0
      }
      currentSizes.append(size)
      x += size.width + spacing
      rowHeight = max(rowHeight, size.height)
    }
    flush(endIndex: subviews.endIndex)

    let height = totalHeight > 0 ? totalHeight - lineSpacing : 0
    return Rows(lines: lines, size: CGSize(width: maxRowWidth, height: height))
  }
}

/// Read-only view of one skill's instructions.
///
/// For a skill the agent wrote for itself (`source == .agent`) the body is the
/// list of lessons it has accumulated. Showing it matters: without it "Learned"
/// is a claim the user has no way to check.
struct SkillDetailView: View {
  let skill: SkillDTO

  var body: some View {
    List {
      Section {
        Text(skill.description)
        if let trigger = skill.trigger, trigger.isEmpty == false {
          LabeledContent("Trigger", value: trigger)
        }
        LabeledContent("Source", value: skill.source.label)
      }

      if let content = skill.content, content.isEmpty == false {
        Section("Instructions") {
          Text(content)
            .font(.callout.monospaced())
            .textSelection(.enabled)
            .accessibilityIdentifier("skill.detail.content")
        }
      }
    }
    .navigationTitle(skill.name)
    .navigationBarTitleDisplayMode(.inline)
    .accessibilityIdentifier("skill.detail.\(skill.name)")
  }
}

// ---------------------------------------------------------------------------
// Presentation decisions
// ---------------------------------------------------------------------------

/// The pure decisions behind `AgentDetailView` (agent-detail refinement,
/// 2026-09-07), kept out of the view so they can be unit-tested without
/// rendering: which optional sections earn a header, whether Start Chat is
/// offered, and when a system prompt is long enough to clamp.
enum AgentDetailPresentation {
  /// Lines shown before "Show more" for a long system prompt.
  static let promptLineLimit = 6

  /// Beyond this many characters a prompt is treated as long even without
  /// newlines — a single 400-character paragraph wraps to well over
  /// `promptLineLimit` lines on a phone.
  static let promptCharacterLimit = 360

  /// True when any of the Configuration section's optional values is set.
  /// An empty array counts as absent: the gateway drops cleared keys, but a
  /// client that sends `[]` should not resurrect the header.
  static func hasConfiguration(_ config: AgentConfigDTO) -> Bool {
    let lists = [config.fallbackModels, config.providers, config.plugins]
    if lists.contains(where: { $0?.isEmpty == false }) { return true }
    if let workspace = config.workspace, workspace.isEmpty == false { return true }
    return config.maxTokens != nil
  }

  /// Start Chat needs an online gateway (mutations allowed) and an agent the
  /// gateway will actually run — a disabled one is refused at first send.
  static func canStartChat(status: RegisteredAgentStatus, online: Bool) -> Bool {
    online && status != .disabled
  }

  /// The accessibility hint for Start Chat: the blocking condition, offline
  /// first because it blocks everything else on the screen too. Empty when
  /// the button is live.
  static func startChatHint(status: RegisteredAgentStatus, online: Bool) -> String {
    if online == false { return "Connect to the gateway to start a conversation" }
    if status == .disabled { return "Enable this agent to start a conversation" }
    return ""
  }

  /// Whether the prompt gets the `promptLineLimit` clamp and a toggle.
  static func isPromptLong(_ prompt: String) -> Bool {
    if prompt.count > promptCharacterLimit { return true }
    let newlines = prompt.filter { $0 == "\n" }.count
    return newlines + 1 > promptLineLimit
  }
}
