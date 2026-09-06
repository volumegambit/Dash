@file:UseSerializers(JsonIntegralLongSerializer::class)

package app.dash.core.contracts

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.UseSerializers
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

@Serializable
data class MobileAgent(
  val id: String,
  val name: String,
  val config: MobileAgentConfig,
  val status: AgentStatus,
  val registeredAt: String,
)

@Serializable
data class MobileAgentConfig(
  val name: String,
  val model: String,
  val systemPrompt: String,
  val fallbackModels: List<String>? = null,
  val tools: List<String>? = null,
  val skills: AgentSkills? = null,
  val workspace: String? = null,
  val maxTokens: Long? = null,
  val mcpServers: List<String>? = null,
  val plugins: List<String>? = null,
  val providers: List<String>? = null,
  val swarm: AgentSwarm? = null,
)

@Serializable
data class AgentSkills(val paths: List<String>? = null, val urls: List<String>? = null)

@Serializable
data class AgentSwarm(
  val enabled: Boolean? = null,
  val maxConcurrentWorkers: Long? = null,
  val maxWorkersPerRun: Long? = null,
  val maxSteersPerWorker: Long? = null,
  val maxRunSeconds: Long? = null,
  val allowedModels: List<String>? = null,
)

@Serializable
enum class AgentStatus {
  @SerialName("registered")
  Registered,

  @SerialName("active")
  Active,

  @SerialName("disabled")
  Disabled,
}

@Serializable
data class CreateMobileAgentRequest(
  val name: String,
  val model: String,
  val systemPrompt: String,
)

@Serializable
data class UpdateMobileAgentRequest(
  val model: String? = null,
  val systemPrompt: String? = null,
)

@Serializable
data class MobileActionResponse(val ok: Boolean) {
  init {
    require(ok) { "MobileActionResponse.ok must be true" }
  }
}

@Serializable(with = MobileSkillSourceSerializer::class)
sealed interface MobileSkillSource {
  data object Managed : MobileSkillSource

  data object Agent : MobileSkillSource

  data object Remote : MobileSkillSource

  data object Plugin : MobileSkillSource

  data class Unknown(val wireValue: String) : MobileSkillSource
}

object MobileSkillSourceSerializer : KSerializer<MobileSkillSource> {
  override val descriptor = PrimitiveSerialDescriptor("MobileSkillSource", PrimitiveKind.STRING)

  override fun deserialize(decoder: Decoder): MobileSkillSource = when (val value = decoder.decodeString()) {
    "managed" -> MobileSkillSource.Managed
    "agent" -> MobileSkillSource.Agent
    "remote" -> MobileSkillSource.Remote
    "plugin" -> MobileSkillSource.Plugin
    else -> {
      if (value.isEmpty()) throw SerializationException("MobileSkill.source must be nonempty")
      MobileSkillSource.Unknown(value)
    }
  }

  override fun serialize(encoder: Encoder, value: MobileSkillSource) {
    val wireValue = when (value) {
      MobileSkillSource.Managed -> "managed"
      MobileSkillSource.Agent -> "agent"
      MobileSkillSource.Remote -> "remote"
      MobileSkillSource.Plugin -> "plugin"
      is MobileSkillSource.Unknown -> value.wireValue
    }
    if (wireValue.isEmpty()) throw SerializationException("MobileSkill.source must be nonempty")
    encoder.encodeString(wireValue)
  }
}

@Serializable
data class MobileSkill(
  val name: String,
  val description: String,
  val trigger: String? = null,
  val source: MobileSkillSource,
  val content: String? = null,
)

@Serializable
data class MobileMemoryInfo(
  val name: String,
  val description: String,
  val type: String,
  val source: String,
  val createdAt: String,
  val updatedAt: String,
  val size: Long,
)

@Serializable
data class MobileMemoryRecord(
  val name: String,
  val description: String,
  val type: String,
  val source: String,
  val createdAt: String,
  val updatedAt: String,
  val content: String,
)

@Serializable
data class MobileMemoryDeleteResponse(val name: String)

@Serializable
data class MobileModel(val value: String, val label: String, val provider: String)

@Serializable
data class MobileModelsResponse(
  val models: List<MobileModel>,
  val source: String,
  val errors: Map<String, String>,
  val fetchedAt: String,
  val supportedModelsReviewedAt: String,
)

@Serializable(with = AgentEventSerializer::class)
data class AgentEvent(val type: String, val raw: JsonObject)

object AgentEventSerializer : KSerializer<AgentEvent> {
  override val descriptor = buildClassSerialDescriptor("AgentEvent")

  override fun deserialize(decoder: Decoder): AgentEvent {
    val raw = decoder.decodeSerializableValue(JsonObject.serializer())
    val type = raw["type"] as? JsonPrimitive
    if (type == null || !type.isString || type.content.isEmpty()) {
      throw SerializationException("AgentEvent.type must be a nonempty string")
    }
    WireRules.validateAgentEvent(raw)
    return AgentEvent(type.content, raw)
  }

  override fun serialize(encoder: Encoder, value: AgentEvent) {
    val rawType = value.raw["type"] as? JsonPrimitive
    if (
      value.type.isEmpty() ||
      rawType == null ||
      !rawType.isString ||
      rawType.content != value.type
    ) {
      throw SerializationException("AgentEvent.type must match its raw object")
    }
    WireRules.validateAgentEvent(value.raw)
    encoder.encodeSerializableValue(JsonObject.serializer(), value.raw)
  }
}
