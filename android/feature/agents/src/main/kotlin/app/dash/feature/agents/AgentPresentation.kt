package app.dash.feature.agents

import app.dash.model.AgentStatus

/**
 * What a status is called on screen. Mirrors iOS `RegisteredAgentStatus.displayName`
 * — the raw enum name (`registered`) used to leak into the detail screen.
 */
fun AgentStatus.displayName(): String = when (this) {
    AgentStatus.REGISTERED -> "Ready"
    AgentStatus.ACTIVE -> "Active"
    AgentStatus.DISABLED -> "Disabled"
}

/** Pure decisions behind [AgentDetailScreen]; mirrors iOS `AgentDetailPresentation`. */
object AgentPresentation {
    /**
     * The gateway refuses to run a disabled agent, so offering Chat for one could
     * only produce a conversation that errors on first send.
     */
    fun canStartChat(status: AgentStatus): Boolean = status != AgentStatus.DISABLED
}

/**
 * Kotlin mirror of Mission Control's tool vocabulary
 * (`apps/mission-control/src/renderer/src/components/deploy-options.ts`) and the
 * iOS `AgentToolCatalog`: the same friendly labels, plain-language descriptions
 * and functional groups, so an agent's enabled tools read identically on every
 * client. Ids the table does not know fall back to a humanized label under
 * "Other" rather than being dropped.
 */
object AgentToolCatalog {
    data class ToolGroup(val name: String, val description: String?, val tools: List<String>)

    private data class GroupDefinition(val name: String, val description: String, val tools: List<String>)

    private val labels = mapOf(
        "bash" to "Bash",
        "read" to "Read",
        "write" to "Write",
        "edit" to "Edit",
        "find" to "Find",
        "ls" to "List Directory",
        "grep" to "Grep",
        "web_search" to "Web Search",
        "web_fetch" to "Web Fetch",
        "create_skill" to "Create Skill",
        "install_skill" to "Install Skill",
        "remove_skill" to "Remove Skill",
        "mcp" to "MCP",
        "mcp_add_server" to "Add Connector",
        "mcp_list_servers" to "List Connectors",
        "mcp_remove_server" to "Remove Connector",
    )

    private val groupDefinitions = listOf(
        GroupDefinition("Read & Search", "Browse and search the project", listOf("read", "ls", "find", "grep")),
        GroupDefinition("Modify Files", "Create and change files", listOf("write", "edit")),
        GroupDefinition("Shell", "Run terminal commands", listOf("bash")),
        GroupDefinition("Web", "Search the internet and fetch pages", listOf("web_search", "web_fetch")),
        GroupDefinition(
            "Skills",
            "Create, install, and manage reusable agent skills",
            listOf("create_skill", "install_skill", "remove_skill"),
        ),
        GroupDefinition(
            "Manage Connectors / MCP Servers",
            "Let agents connect to, list, and remove external tool servers",
            listOf("mcp", "mcp_add_server", "mcp_list_servers", "mcp_remove_server"),
        ),
    )

    /** "web_fetch" → "Web Fetch"; unknown ids are title-cased from their snake_case id. */
    fun label(id: String): String = labels[id] ?: humanize(id)

    /**
     * The enabled tools bucketed into the wizard's groups, in group order; ids
     * belonging to no group are collected under "Other". Empty groups are omitted.
     */
    fun groups(enabled: List<String>): List<ToolGroup> {
        val enabledSet = enabled.toSet()
        val claimed = mutableSetOf<String>()
        val result = mutableListOf<ToolGroup>()
        for (group in groupDefinitions) {
            val tools = group.tools.filter { it in enabledSet }
            claimed += tools
            if (tools.isNotEmpty()) result += ToolGroup(group.name, group.description, tools)
        }
        val other = enabled.filter { it !in claimed }
        if (other.isNotEmpty()) result += ToolGroup("Other", null, other)
        return result
    }

    private fun humanize(id: String): String =
        id.split('_').filter { it.isNotEmpty() }.joinToString(" ") { word ->
            word.replaceFirstChar { it.uppercaseChar() }
        }.ifEmpty { id }
}
