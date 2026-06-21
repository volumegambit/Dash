package app.dash.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** An inline image sent with a chat message. */
@Serializable
data class WsMessageImage(
    val mediaType: String,
    val data: String,
)

/**
 * Messages the app SENDS over the chat WebSocket.
 *
 * Contract source of truth: the LIVE gateway route `/ws/chat`
 * (apps/gateway/src/chat-ws.ts) — NOT the unmounted legacy
 * packages/chat/src/chat-server.ts (`/ws`). The live `message` carries
 * `agentId` and an optional `streamingBehavior` (steer/followUp); it has no
 * `answer` frame. Encoded with a `type` discriminator (see [DashJson]).
 */
@Serializable
sealed interface WsClientMessage {
    @Serializable
    @SerialName("message")
    data class Message(
        val id: String,
        val agentId: String,
        val channelId: String,
        val conversationId: String,
        val text: String,
        val images: List<WsMessageImage>? = null,
    ) : WsClientMessage

    @Serializable
    @SerialName("cancel")
    data class Cancel(val id: String) : WsClientMessage
}

/**
 * Messages the app RECEIVES over the chat WebSocket (apps/gateway/src/chat-ws.ts:
 * `event` frames carry an optional `seq`, which the app ignores).
 */
@Serializable
sealed interface WsServerMessage {
    @Serializable
    @SerialName("event")
    data class Event(val id: String, val event: AgentEvent) : WsServerMessage

    @Serializable
    @SerialName("done")
    data class Done(val id: String) : WsServerMessage

    @Serializable
    @SerialName("error")
    data class ErrorMsg(val id: String, val error: String) : WsServerMessage
}
