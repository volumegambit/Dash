import Foundation

/// Swift mirror of Mission Control's tool vocabulary
/// (`apps/mission-control/src/renderer/src/components/deploy-options.ts`):
/// the same friendly labels, plain-language descriptions, and functional
/// groups the deploy wizard and the MC agent-detail Tools card use, so an
/// agent's enabled tools read identically on the phone and the desktop.
///
/// Kept as a small static table rather than fetched from the gateway: an
/// agent's `config.tools` is a list of ids, and this turns those ids into
/// something a person can read. Ids this table does not know (a future tool,
/// or one an MCP server provides) fall back to a humanized label and land in
/// the "Other" group rather than being dropped.
enum AgentToolCatalog {

  /// Friendly label for a tool id — "web_fetch" → "Web Fetch". Mirrors
  /// `AVAILABLE_TOOLS`; unknown ids are title-cased from their snake_case id.
  static func label(for id: String) -> String {
    labels[id] ?? humanize(id)
  }

  /// Plain-language description for a tool id, or nil when unknown. Mirrors
  /// `TOOL_DESCRIPTIONS`.
  static func description(for id: String) -> String? {
    descriptions[id]
  }

  struct ToolGroup: Identifiable {
    let name: String
    let description: String?
    let tools: [String]
    var id: String { name }
  }

  /// The enabled tools bucketed into the same groups the deploy wizard uses,
  /// in group order. Any enabled id belonging to no known group is collected
  /// under "Other" so it is still shown. Empty groups are omitted.
  static func groups(enabled: [String]) -> [ToolGroup] {
    let enabledSet = Set(enabled)
    var result: [ToolGroup] = []
    var claimed = Set<String>()

    for group in groupDefinitions {
      let tools = group.tools.filter { enabledSet.contains($0) }
      for tool in tools { claimed.insert(tool) }
      if tools.isEmpty == false {
        result.append(ToolGroup(name: group.name, description: group.description, tools: tools))
      }
    }

    let other = enabled.filter { claimed.contains($0) == false }
    if other.isEmpty == false {
      result.append(ToolGroup(name: "Other", description: nil, tools: other))
    }

    return result
  }

  private static func humanize(_ id: String) -> String {
    let words = id.split(separator: "_").filter { $0.isEmpty == false }
    guard words.isEmpty == false else { return id }
    return words.map { word in
      guard let first = word.first else { return String(word) }
      return first.uppercased() + word.dropFirst()
    }.joined(separator: " ")
  }

  private static let labels: [String: String] = [
    "bash": "Bash",
    "read": "Read",
    "write": "Write",
    "edit": "Edit",
    "find": "Find",
    "ls": "List Directory",
    "grep": "Grep",
    "web_search": "Web Search",
    "web_fetch": "Web Fetch",
    "create_skill": "Create Skill",
    "install_skill": "Install Skill",
    "remove_skill": "Remove Skill",
    "mcp": "MCP",
    "mcp_add_server": "Add Connector",
    "mcp_list_servers": "List Connectors",
    "mcp_remove_server": "Remove Connector",
  ]

  private static let descriptions: [String: String] = [
    "bash": "Run terminal commands on the system",
    "read": "Read files from the project",
    "write": "Create new files in the project",
    "edit": "Make changes to existing files",
    "find": "Find files by name or pattern",
    "ls": "See what files and folders exist",
    "grep": "Search for text inside files",
    "web_search": "Search the internet for information",
    "web_fetch": "Download content from web pages",
    "create_skill": "Create reusable skills the agent remembers across conversations",
    "install_skill": "Let the agent install new skills from a git repo, URL, or local path",
    "remove_skill": "Let the agent uninstall skills it previously installed or created",
    "mcp": "Connect to external MCP servers for additional tools",
    "mcp_add_server": "Let the agent connect to new external tool servers",
    "mcp_list_servers": "Let the agent see which external tool servers are available",
    "mcp_remove_server": "Let the agent disconnect external tool servers",
  ]

  private struct GroupDefinition {
    let name: String
    let description: String
    let tools: [String]
  }

  private static let groupDefinitions: [GroupDefinition] = [
    GroupDefinition(
      name: "Read & Search",
      description: "Browse and search the project",
      tools: ["read", "ls", "find", "grep"]),
    GroupDefinition(
      name: "Modify Files",
      description: "Create and change files",
      tools: ["write", "edit"]),
    GroupDefinition(
      name: "Shell",
      description: "Run terminal commands",
      tools: ["bash"]),
    GroupDefinition(
      name: "Web",
      description: "Search the internet and fetch pages",
      tools: ["web_search", "web_fetch"]),
    GroupDefinition(
      name: "Skills",
      description: "Create, install, and manage reusable agent skills",
      tools: ["create_skill", "install_skill", "remove_skill"]),
    GroupDefinition(
      name: "Manage Connectors / MCP Servers",
      description: "Let agents connect to, list, and remove external tool servers",
      tools: ["mcp", "mcp_add_server", "mcp_list_servers", "mcp_remove_server"]),
  ]
}
