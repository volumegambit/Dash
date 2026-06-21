package app.dash.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * A deployed agent as returned by `GET /agents`
 * (apps/gateway/src/agent-registry.ts: RegisteredAgent, with secrets stripped
 * server-side). The app never receives provider keys.
 */
@Serializable
data class RegisteredAgent(
    val id: String,
    val name: String,
    val config: AgentConfig,
    val status: AgentStatus,
    val registeredAt: String,
)

@Serializable
data class AgentConfig(
    val model: String,
    val systemPrompt: String,
    val tools: List<String>? = null,
    val fallbackModels: List<String>? = null,
)

@Serializable
enum class AgentStatus {
    @SerialName("registered")
    REGISTERED,

    @SerialName("active")
    ACTIVE,

    @SerialName("disabled")
    DISABLED,
}
