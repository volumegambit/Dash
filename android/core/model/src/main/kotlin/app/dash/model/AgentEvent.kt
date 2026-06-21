package app.dash.model

import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonContentPolymorphicSerializer
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/**
 * Mirror of the gateway's `AgentEvent` union (packages/agent/src/types.ts).
 *
 * Decoded from the `event` field of `WsServerMessage.Event`. Unrecognized
 * `type` discriminators decode to [Unknown] instead of throwing, so the app
 * tolerates gateway additions without crashing the chat stream.
 */
@Serializable(with = AgentEventSerializer::class)
sealed interface AgentEvent {
    @Serializable
    data class TextDelta(val text: String) : AgentEvent

    @Serializable
    data class ThinkingDelta(val text: String) : AgentEvent

    @Serializable
    data class ToolUseStart(
        val id: String,
        val name: String,
        val input: JsonObject? = null,
    ) : AgentEvent

    @Serializable
    data class ToolUseDelta(
        @SerialName("partial_json") val partialJson: String,
    ) : AgentEvent

    @Serializable
    data class ToolResult(
        val id: String,
        val name: String,
        val content: String,
        val isError: Boolean? = null,
        val details: JsonElement? = null,
    ) : AgentEvent

    @Serializable
    data class Response(
        val content: String,
        val usage: Usage,
    ) : AgentEvent

    /**
     * `error` arrives as a string: the gateway serializes the `Error` to its
     * message via a JSON replacer before sending (packages/chat/src/chat-server.ts).
     */
    @Serializable
    data class ErrorEvent(
        val error: String,
        val timestamp: String? = null,
    ) : AgentEvent

    @Serializable
    data class FileChanged(val files: List<String>) : AgentEvent

    @Serializable
    data class AgentSpawned(val name: String) : AgentEvent

    @Serializable
    data class AgentRetry(val attempt: Int, val reason: String) : AgentEvent

    @Serializable
    data class ContextCompacted(val overflow: Boolean) : AgentEvent

    @Serializable
    data class Question(
        val id: String,
        val question: String,
        val options: List<String> = emptyList(),
    ) : AgentEvent

    @Serializable
    data class SkillLoaded(val name: String) : AgentEvent

    @Serializable
    data class SkillCreated(val name: String, val description: String) : AgentEvent

    @Serializable
    data class McpServerError(val server: String, val error: String) : AgentEvent

    /** Forward-compatibility fallback for unrecognized event types. */
    data class Unknown(val type: String) : AgentEvent
}

@Serializable
data class Usage(
    val inputTokens: Int = 0,
    val outputTokens: Int = 0,
    val cacheReadTokens: Int? = null,
    val cacheWriteTokens: Int? = null,
)

/**
 * Dispatches on the `type` discriminator. Unknown types fall back to
 * [AgentEvent.Unknown] rather than throwing.
 */
object AgentEventSerializer : JsonContentPolymorphicSerializer<AgentEvent>(AgentEvent::class) {
    override fun selectDeserializer(element: JsonElement): DeserializationStrategy<AgentEvent> {
        val type = (element as? JsonObject)?.get("type")?.jsonPrimitive?.contentOrNull
        return when (type) {
            "text_delta" -> AgentEvent.TextDelta.serializer()
            "thinking_delta" -> AgentEvent.ThinkingDelta.serializer()
            "tool_use_start" -> AgentEvent.ToolUseStart.serializer()
            "tool_use_delta" -> AgentEvent.ToolUseDelta.serializer()
            "tool_result" -> AgentEvent.ToolResult.serializer()
            "response" -> AgentEvent.Response.serializer()
            "error" -> AgentEvent.ErrorEvent.serializer()
            "file_changed" -> AgentEvent.FileChanged.serializer()
            "agent_spawned" -> AgentEvent.AgentSpawned.serializer()
            "agent_retry" -> AgentEvent.AgentRetry.serializer()
            "context_compacted" -> AgentEvent.ContextCompacted.serializer()
            "question" -> AgentEvent.Question.serializer()
            "skill_loaded" -> AgentEvent.SkillLoaded.serializer()
            "skill_created" -> AgentEvent.SkillCreated.serializer()
            "mcp_server_error" -> AgentEvent.McpServerError.serializer()
            else -> UnknownAgentEventSerializer
        }
    }
}

private object UnknownAgentEventSerializer : KSerializer<AgentEvent.Unknown> {
    override val descriptor: SerialDescriptor =
        buildClassSerialDescriptor("app.dash.model.AgentEvent.Unknown")

    override fun deserialize(decoder: Decoder): AgentEvent.Unknown {
        val input = decoder as JsonDecoder
        val obj = input.decodeJsonElement().jsonObject
        val type = obj["type"]?.jsonPrimitive?.contentOrNull ?: "unknown"
        return AgentEvent.Unknown(type)
    }

    override fun serialize(encoder: Encoder, value: AgentEvent.Unknown) {
        val output = encoder as JsonEncoder
        output.encodeJsonElement(buildJsonObject { put("type", value.type) })
    }
}
