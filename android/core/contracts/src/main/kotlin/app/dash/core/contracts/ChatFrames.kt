@file:UseSerializers(JsonIntegralIntSerializer::class, JsonIntegralLongSerializer::class)

package app.dash.core.contracts

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.UseSerializers
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

@Serializable
data class MobilePreciseLocation(
  val latitude: Double,
  val longitude: Double,
  val accuracyMeters: Double,
  val capturedAt: String,
  val place: String? = null,
)

@Serializable
data class MobileClientLocation(
  val timezone: String,
  val utcOffsetMinutes: Int,
  val locale: String,
  val region: String? = null,
  val precise: MobilePreciseLocation? = null,
)

@Serializable
enum class StreamingBehavior {
  @SerialName("steer")
  Steer,

  @SerialName("followUp")
  FollowUp,
}

@Serializable
data class ChatMessageFrame(
  val id: String,
  val agentId: String,
  val channelId: String = "android",
  val conversationId: String,
  val text: String,
  val location: MobileClientLocation? = null,
  val images: List<MobileImage> = emptyList(),
  val streamingBehavior: StreamingBehavior? = null,
  val resumable: Boolean = true,
)

@Serializable
data class ChatResumeFrame(
  val id: String,
  val agentId: String,
  val conversationId: String,
  val sinceSeq: Long,
) {
  init {
    require(sinceSeq >= 0) { "ChatResumeFrame.sinceSeq must be nonnegative" }
  }
}

@Serializable
data class ChatAnswerFrame(val id: String, val questionId: String, val answer: String)

@Serializable
data class ChatCancelFrame(val id: String)

@Serializable(with = MobileWsClientFrameSerializer::class)
sealed interface MobileWsClientFrame {
  data class Message(val value: ChatMessageFrame) : MobileWsClientFrame

  data class Resume(val value: ChatResumeFrame) : MobileWsClientFrame

  data class Answer(val value: ChatAnswerFrame) : MobileWsClientFrame

  data class Cancel(val value: ChatCancelFrame) : MobileWsClientFrame
}

object MobileWsClientFrameSerializer : KSerializer<MobileWsClientFrame> {
  override val descriptor = buildClassSerialDescriptor("MobileWsClientFrame")

  override fun deserialize(decoder: Decoder): MobileWsClientFrame {
    val raw = decoder.decodeSerializableValue(JsonObject.serializer())
    val type = raw["type"]?.jsonPrimitive?.content
      ?: throw SerializationException("client frame type is required")
    val payload = JsonObject(raw - "type")
    return when (type) {
      "message" -> MobileWsClientFrame.Message(
        ContractJson.strict.decodeFromJsonElement(payload),
      )
      "resume" -> MobileWsClientFrame.Resume(
        ContractJson.strict.decodeFromJsonElement(payload),
      )
      "answer" -> MobileWsClientFrame.Answer(
        ContractJson.strict.decodeFromJsonElement(payload),
      )
      "cancel" -> MobileWsClientFrame.Cancel(
        ContractJson.strict.decodeFromJsonElement(payload),
      )
      else -> throw SerializationException("unsupported client frame type")
    }
  }

  override fun serialize(encoder: Encoder, value: MobileWsClientFrame) {
    val raw = when (value) {
      is MobileWsClientFrame.Message -> buildJsonObject {
        put("type", "message")
        put("id", value.value.id)
        put("agentId", value.value.agentId)
        put("channelId", value.value.channelId)
        put("conversationId", value.value.conversationId)
        put("text", value.value.text)
        value.value.location?.let { put("location", ContractJson.strict.encodeToJsonElement(it)) }
        if (value.value.images.isNotEmpty()) {
          put("images", ContractJson.strict.encodeToJsonElement(value.value.images))
        }
        value.value.streamingBehavior?.let {
          put("streamingBehavior", ContractJson.strict.encodeToJsonElement(it))
        }
        put("resumable", value.value.resumable)
      }
      is MobileWsClientFrame.Resume -> tagged("resume", value.value)
      is MobileWsClientFrame.Answer -> tagged("answer", value.value)
      is MobileWsClientFrame.Cancel -> tagged("cancel", value.value)
    }
    encoder.encodeSerializableValue(JsonObject.serializer(), raw)
  }

  private inline fun <reified T> tagged(type: String, value: T): JsonObject = buildJsonObject {
    put("type", type)
    ContractJson.strict.encodeToJsonElement(value).jsonObject.forEach { (key, node) ->
      put(key, node)
    }
  }
}

@Serializable
sealed interface MobileWsServerFrame {
  val id: String
  val conversationId: String?
  val seq: Long?

  @Serializable
  @SerialName("accepted")
  data class Accepted(
    override val id: String,
    override val conversationId: String,
    val userMessageId: String,
    val assistantMessageId: String,
    val revision: Long,
    override val seq: Long,
  ) : MobileWsServerFrame

  @Serializable
  @SerialName("event")
  data class Event(
    override val id: String,
    override val conversationId: String? = null,
    override val seq: Long? = null,
    val event: AgentEvent,
  ) : MobileWsServerFrame

  @Serializable
  @SerialName("done")
  data class Done(
    override val id: String,
    override val conversationId: String? = null,
    override val seq: Long? = null,
    val outcome: String? = null,
  ) : MobileWsServerFrame

  @Serializable
  @SerialName("error")
  data class Error(
    override val id: String,
    override val conversationId: String? = null,
    override val seq: Long? = null,
    val error: String,
    val code: String? = null,
    val retryable: Boolean? = null,
    val activeTurnId: String? = null,
  ) : MobileWsServerFrame
}

@Serializable
sealed interface ReplayPayload {
  @Serializable
  @SerialName("accepted")
  data class Accepted(
    val userMessageId: String,
    val assistantMessageId: String,
    val revision: Long,
  ) : ReplayPayload

  @Serializable
  @SerialName("event")
  data class Event(val event: AgentEvent) : ReplayPayload

  @Serializable
  @SerialName("done")
  data class Done(val outcome: String? = null) : ReplayPayload

  @Serializable
  @SerialName("error")
  data class Error(
    val error: String,
    val code: String? = null,
    val retryable: Boolean? = null,
  ) : ReplayPayload
}

@Serializable
data class ReplayEntry(
  val seq: Long,
  val msgId: String,
  val agentId: String,
  val conversationId: String,
  val timestamp: String,
  val payload: ReplayPayload,
)

@Serializable
data class ReplayPage(val entries: List<ReplayEntry>)

@Serializable
sealed interface GatewayInvalidation {
  val conversationId: String
  val revision: Long

  @Serializable
  @SerialName("conversation:changed")
  data class ConversationChanged(
    override val conversationId: String,
    override val revision: Long,
  ) : GatewayInvalidation

  @Serializable
  @SerialName("conversation:deleted")
  data class ConversationDeleted(
    override val conversationId: String,
    override val revision: Long,
  ) : GatewayInvalidation
}

object CapableServerFrameValidator {
  fun validate(frame: MobileWsServerFrame, capableBefore: Boolean): Boolean {
    val capable = capableBefore || frame is MobileWsServerFrame.Accepted
    if (!capable && !(frame is MobileWsServerFrame.Error && frame.seq == null)) {
      throw SerializationException("accepted must precede sequenced turn frames")
    }
    when (frame) {
      is MobileWsServerFrame.Accepted -> Unit
      is MobileWsServerFrame.Event -> {
        required(frame.conversationId, "conversationId")
        required(frame.seq, "seq")
      }
      is MobileWsServerFrame.Done -> {
        required(frame.conversationId, "conversationId")
        required(frame.seq, "seq")
        required(frame.outcome, "outcome")
      }
      is MobileWsServerFrame.Error -> if (frame.conversationId == null && frame.seq != null) {
        throw SerializationException("error seq requires conversationId")
      }
    }
    return capable
  }

  private fun <T : Any> required(value: T?, field: String): T = value
    ?: throw SerializationException("$field is required for capable frame")
}
