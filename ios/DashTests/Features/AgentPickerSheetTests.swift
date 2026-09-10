import Foundation
import Testing

@testable import Dash

/// `AgentPickerSheet.availableAgents` (agents-list goal 2026-09-10): the
/// sheet drops disabled agents and floats the current agent to the top —
/// the default you are re-confirming or switching away from belongs first,
/// not wherever registration order left it. Static and pure for the same
/// reason `ComposeAgentSelection.resolve` is.
@Suite("AgentPickerSheet ordering (agents-list goal 2026-09-10)")
struct AgentPickerSheetTests {
  @Test("current agent floats to the top, others keep their order")
  func currentAgentFirst() {
    let ordered = AgentPickerSheet.availableAgents(
      [agent(id: "a"), agent(id: "b"), agent(id: "c")],
      currentAgentID: "b"
    )
    #expect(ordered.map(\.id) == ["b", "a", "c"])
  }

  @Test("no current agent (compose has never run) keeps registration order")
  func noCurrentAgent() {
    let ordered = AgentPickerSheet.availableAgents(
      [agent(id: "a"), agent(id: "b")],
      currentAgentID: nil
    )
    #expect(ordered.map(\.id) == ["a", "b"])
  }

  @Test("a stale current id (agent deleted since) is a no-op, not a crash")
  func staleCurrentAgent() {
    let ordered = AgentPickerSheet.availableAgents(
      [agent(id: "a"), agent(id: "b")],
      currentAgentID: "gone"
    )
    #expect(ordered.map(\.id) == ["a", "b"])
  }

  @Test("disabled agents are dropped even when current")
  func disabledDropped() {
    let ordered = AgentPickerSheet.availableAgents(
      [agent(id: "a"), agent(id: "b", status: .disabled), agent(id: "c")],
      currentAgentID: "b"
    )
    #expect(ordered.map(\.id) == ["a", "c"])
  }

  private func agent(
    id: String,
    status: RegisteredAgentStatus = .registered
  ) -> RegisteredAgentDTO {
    RegisteredAgentDTO(
      id: id,
      name: "Agent \(id)",
      config: AgentConfigDTO(
        name: "Agent \(id)",
        model: "test/model",
        systemPrompt: "",
        fallbackModels: nil,
        tools: nil,
        skills: nil,
        workspace: nil,
        maxTokens: nil,
        mcpServers: nil,
        swarm: nil,
        plugins: nil,
        providers: nil
      ),
      status: status,
      registeredAt: Date(timeIntervalSince1970: 10)
    )
  }
}
