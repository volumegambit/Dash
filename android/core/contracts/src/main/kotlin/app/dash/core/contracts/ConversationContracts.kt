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
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.put

@Serializable
enum class ConversationStatus {
  @SerialName("idle")
  Idle,

  @SerialName("running")
  Running,

  @SerialName("interrupted")
  Interrupted,

  @SerialName("archived")
  Archived,

  @SerialName("deleted")
  Deleted,
}

@Serializable
enum class ConversationMessageStatus {
  @SerialName("accepted")
  Accepted,

  @SerialName("streaming")
  Streaming,

  @SerialName("completed")
  Completed,

  @SerialName("cancelled")
  Cancelled,

  @SerialName("failed")
  Failed,

  @SerialName("interrupted")
  Interrupted,
}

@Serializable
enum class ConversationRole {
  @SerialName("user")
  User,

  @SerialName("assistant")
  Assistant,
}

@Serializable
data class MobileImage(val mediaType: String, val data: String)

@Serializable(with = ConversationNoticeKindSerializer::class)
sealed interface ConversationNoticeKind {
  data object SkillLearned : ConversationNoticeKind

  data object MemorySaved : ConversationNoticeKind

  data class Unknown(val wireValue: String) : ConversationNoticeKind
}

object ConversationNoticeKindSerializer : KSerializer<ConversationNoticeKind> {
  override val descriptor = PrimitiveSerialDescriptor("ConversationNoticeKind", PrimitiveKind.STRING)

  override fun deserialize(decoder: Decoder): ConversationNoticeKind = when (val value = decoder.decodeString()) {
    "skill_learned" -> ConversationNoticeKind.SkillLearned
    "memory_saved" -> ConversationNoticeKind.MemorySaved
    else -> {
      if (value.isEmpty()) throw SerializationException("Conversation notice kind must be nonempty")
      ConversationNoticeKind.Unknown(value)
    }
  }

  override fun serialize(encoder: Encoder, value: ConversationNoticeKind) {
    val wireValue = when (value) {
      ConversationNoticeKind.SkillLearned -> "skill_learned"
      ConversationNoticeKind.MemorySaved -> "memory_saved"
      is ConversationNoticeKind.Unknown -> value.wireValue
    }
    if (wireValue.isEmpty()) throw SerializationException("Conversation notice kind must be nonempty")
    encoder.encodeString(wireValue)
  }
}

@Serializable(with = ConversationContentSerializer::class)
sealed interface ConversationContent {
  @Serializable
  data class User(val text: String, val images: List<MobileImage> = emptyList()) : ConversationContent

  @Serializable
  data class Assistant(val events: List<AgentEvent>) : ConversationContent

  @Serializable
  data class Notice(val kind: ConversationNoticeKind, val text: String) : ConversationContent

  data class Unknown(val type: String, val raw: JsonObject) : ConversationContent
}

object ConversationContentSerializer : KSerializer<ConversationContent> {
  override val descriptor = buildClassSerialDescriptor("ConversationContent")

  override fun deserialize(decoder: Decoder): ConversationContent {
    val raw = decoder.decodeSerializableValue(JsonObject.serializer())
    val type = raw["type"] as? JsonPrimitive
    if (type == null || !type.isString || type.content.isEmpty()) {
      throw SerializationException("ConversationContent.type must be a nonempty string")
    }
    return when (type.content) {
      "user" -> {
        raw.requireExactContentKeys(setOf("type", "text"), setOf("images"))
        ContractJson.strict.decodeFromJsonElement<ConversationContent.User>(JsonObject(raw - "type"))
      }
      "assistant" -> {
        raw.requireExactContentKeys(setOf("type", "events"))
        ContractJson.strict.decodeFromJsonElement<ConversationContent.Assistant>(JsonObject(raw - "type"))
      }
      "notice" -> {
        raw.requireExactContentKeys(setOf("type", "kind", "text"))
        ContractJson.strict.decodeFromJsonElement<ConversationContent.Notice>(JsonObject(raw - "type"))
      }
      else -> ConversationContent.Unknown(type.content, raw)
    }
  }

  override fun serialize(encoder: Encoder, value: ConversationContent) {
    val raw = when (value) {
      is ConversationContent.User -> taggedContent("user", value)
      is ConversationContent.Assistant -> taggedContent("assistant", value)
      is ConversationContent.Notice -> taggedContent("notice", value)
      is ConversationContent.Unknown -> {
        val rawType = value.raw["type"] as? JsonPrimitive
        if (
          value.type.isEmpty() ||
          rawType == null ||
          !rawType.isString ||
          rawType.content != value.type
        ) {
          throw SerializationException("ConversationContent.type must match its raw object")
        }
        value.raw
      }
    }
    encoder.encodeSerializableValue(JsonObject.serializer(), raw)
  }

  private inline fun <reified T> taggedContent(type: String, value: T): JsonObject = buildJsonObject {
    put("type", type)
    ContractJson.strict.encodeToJsonElement(value).let { encoded ->
      (encoded as JsonObject).forEach { (key, node) -> put(key, node) }
    }
  }

  private fun JsonObject.requireExactContentKeys(
    required: Set<String>,
    optional: Set<String> = emptySet(),
  ) {
    if (!keys.containsAll(required) || keys.any { it !in required && it !in optional }) {
      throw SerializationException("ConversationContent has invalid keys")
    }
  }
}

@Serializable
data class ConversationDefaults(val defaultConversationTitle: String) {
  init {
    require(defaultConversationTitle == DEFAULT_CONVERSATION_TITLE) {
      "ConversationDefaults.defaultConversationTitle must be New Conversation"
    }
  }

  companion object {
    const val DEFAULT_CONVERSATION_TITLE = "New Conversation"
  }
}

@Serializable
data class ConversationSummary(
  val id: String,
  val agentId: String,
  val agentName: String,
  val title: String,
  val revision: Long,
  val status: ConversationStatus,
  val activeTurnId: String?,
  val owningIssueId: String?,
  val projectId: String?,
  val lastSeq: Long,
  val lastMessagePreview: String?,
  val createdAt: String,
  val updatedAt: String,
  val deletedAt: String? = null,
)

@Serializable
data class ConversationMessage(
  val id: String,
  val conversationId: String,
  val turnId: String,
  val ordinal: Long,
  val role: ConversationRole,
  val status: ConversationMessageStatus,
  val content: ConversationContent,
  val createdAt: String,
  val updatedAt: String,
)

@Serializable
data class ConversationPage(val items: List<ConversationSummary>, val nextCursor: String?)

@Serializable
data class ConversationMessagePage(
  val items: List<ConversationMessage>,
  val nextCursor: String?,
  val throughSeq: Long,
)

@Serializable
data class ConversationCreateRequest(
  val agentId: String,
  val requestId: String,
  val title: String? = null,
  val owningIssueId: String? = null,
  val projectId: String? = null,
)

sealed interface NullablePatchField<out T> {
  data object Omitted : NullablePatchField<Nothing>

  data class Value<T>(val value: T) : NullablePatchField<T>

  data object Null : NullablePatchField<Nothing>
}

@Serializable(with = ConversationPatchRequestSerializer::class)
data class ConversationPatchRequest(
  val title: String? = null,
  val owningIssueId: NullablePatchField<String> = NullablePatchField.Omitted,
  val projectId: NullablePatchField<String> = NullablePatchField.Omitted,
)

object ConversationPatchRequestSerializer : KSerializer<ConversationPatchRequest> {
  override val descriptor = buildClassSerialDescriptor("ConversationPatchRequest")

  override fun deserialize(decoder: Decoder): ConversationPatchRequest {
    val raw = decoder.decodeSerializableValue(JsonObject.serializer())
    if (raw.isEmpty()) throw SerializationException("ConversationPatchRequest must not be empty")
    if (raw.keys.any { it !in setOf("title", "owningIssueId", "projectId") }) {
      throw SerializationException("ConversationPatchRequest has invalid keys")
    }
    val title = when (val node = raw["title"]) {
      null -> null
      JsonNull -> throw SerializationException("ConversationPatchRequest.title must not be null")
      is JsonPrimitive -> if (node.isString) node.content else {
        throw SerializationException("ConversationPatchRequest.title must be a string")
      }
      else -> throw SerializationException("ConversationPatchRequest.title must be a string")
    }
    return ConversationPatchRequest(
      title = title,
      owningIssueId = raw.patchField("owningIssueId"),
      projectId = raw.patchField("projectId"),
    )
  }

  override fun serialize(encoder: Encoder, value: ConversationPatchRequest) {
    val raw = buildJsonObject {
      value.title?.let { put("title", it) }
      putPatchField("owningIssueId", value.owningIssueId)
      putPatchField("projectId", value.projectId)
    }
    if (raw.isEmpty()) throw SerializationException("ConversationPatchRequest must not be empty")
    encoder.encodeSerializableValue(JsonObject.serializer(), raw)
  }

  private fun JsonObject.patchField(field: String): NullablePatchField<String> = when (
    val node = get(field)
  ) {
    null -> NullablePatchField.Omitted
    JsonNull -> NullablePatchField.Null
    is JsonPrimitive -> if (node.isString) NullablePatchField.Value(node.content) else {
      throw SerializationException("ConversationPatchRequest.$field must be a string or null")
    }
    else -> throw SerializationException("ConversationPatchRequest.$field must be a string or null")
  }

  private fun kotlinx.serialization.json.JsonObjectBuilder.putPatchField(
    field: String,
    value: NullablePatchField<String>,
  ) {
    when (value) {
      NullablePatchField.Omitted -> Unit
      NullablePatchField.Null -> put(field, JsonNull)
      is NullablePatchField.Value -> put(field, value.value)
    }
  }
}
