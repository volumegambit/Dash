@file:UseSerializers(JsonIntegralIntSerializer::class, JsonIntegralLongSerializer::class)

package app.dash.core.contracts

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.UseSerializers
import kotlinx.serialization.json.JsonObject

@Serializable
enum class MobileCapability {
  @SerialName("conversation-sync-v1")
  ConversationSyncV1,

  @SerialName("chat-resume-v1")
  ChatResumeV1,
}

@Serializable
data class MobileHealth(
  val status: String,
  val startedAt: String,
  val pid: Long,
  val agents: Long,
  val channels: Long,
  val apiVersion: Int,
  val capabilities: List<MobileCapability>,
)

@Serializable
data class GatewayIdentity(val gatewayId: String, val publicKey: String)

@Serializable
data class WsTicketResponse(val ticket: String, val expiresAt: String)

@Serializable
data class MobileApiError(
  val code: String,
  val error: String,
  val retryable: Boolean,
  val details: JsonObject? = null,
)

@Serializable
data class MemoryNotFoundError(val error: String)
