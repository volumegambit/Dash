package app.dash.network

import app.dash.model.AgentEvent
import app.dash.model.DashJson
import app.dash.model.WsClientMessage
import app.dash.model.WsServerMessage
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/** Raised when the gateway closes the chat socket with code 4001 (bad token). */
class GatewayAuthError(message: String = "Unauthorized") : RuntimeException(message)

/** Raised when the gateway sends an `error` frame for the active stream. */
class GatewayStreamError(message: String) : RuntimeException(message)

/**
 * Streams a single agent turn over the gateway chat WebSocket
 * (default port 9200, `/ws?token=<chatToken>`). Protocol:
 * packages/chat/src/chat-server.ts.
 */
class ChatSocket(
    private val chatUrl: String,
    private val client: OkHttpClient = OkHttpClient(),
) {
    private val json = DashJson.instance

    /**
     * Opens the socket, sends [message], and emits each [AgentEvent] for it.
     * The flow completes on the `done` frame and fails on an `error` frame or a
     * 4001 close. Cancelling the collector tears the socket down.
     *
     * [outgoing] carries follow-up frames for the same turn — e.g. an
     * `answer` to a `question` event, or a `cancel` — which are forwarded over
     * the live socket as they are emitted.
     */
    fun stream(
        message: WsClientMessage.Message,
        outgoing: Flow<WsClientMessage> = emptyFlow(),
    ): Flow<AgentEvent> = callbackFlow {
        val request = Request.Builder().url(chatUrl).build()
        val socket = client.newWebSocket(
            request,
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    webSocket.send(json.encodeToString(WsClientMessage.serializer(), message))
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    val msg = try {
                        json.decodeFromString(WsServerMessage.serializer(), text)
                    } catch (_: Exception) {
                        return // ignore frames we cannot parse
                    }
                    when (msg) {
                        is WsServerMessage.Event -> if (msg.id == message.id) trySend(msg.event)
                        is WsServerMessage.Done -> if (msg.id == message.id) close()
                        is WsServerMessage.ErrorMsg ->
                            if (msg.id == message.id) close(GatewayStreamError(msg.error))
                    }
                }

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    if (code == 4001) {
                        close(GatewayAuthError(reason.ifBlank { "Unauthorized" }))
                    } else {
                        close()
                    }
                    webSocket.close(NORMAL_CLOSURE, null)
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    close(t)
                }
            },
        )
        val pump = launch {
            outgoing.collect { socket.send(json.encodeToString(WsClientMessage.serializer(), it)) }
        }
        awaitClose {
            pump.cancel()
            socket.cancel()
        }
    }

    private companion object {
        const val NORMAL_CLOSURE = 1000
    }
}
