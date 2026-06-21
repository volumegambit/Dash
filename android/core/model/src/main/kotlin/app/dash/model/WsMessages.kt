package app.dash.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** An inline image sent with a chat message (packages/chat/src/types.ts: WsMessageImage). */
@Serializable
data class WsMessageImage(
    val mediaType: String,
    val data: String,
)

/**
 * Messages the app SENDS over the chat WebSocket
 * (packages/chat/src/types.ts: WsClientMessage). Encoded with a `type`
 * discriminator (see [DashJson]).
 */
@Serializable
sealed interface WsClientMessage {
    @Serializable
    @SerialName("message")
    data class Message(
        val id: String,
        val agent: String,
        val channelId: String,
        val conversationId: String,
        val text: String,
        val images: List<WsMessageImage>? = null,
    ) : WsClientMessage

    @Serializable
    @SerialName("cancel")
    data class Cancel(val id: String) : WsClientMessage

    @Serializable
    @SerialName("answer")
    data class Answer(
        val id: String,
        val questionId: String,
        val answer: String,
    ) : WsClientMessage
}

/**
 * Messages the app RECEIVES over the chat WebSocket
 * (packages/chat/src/types.ts: WsServerMessage).
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
