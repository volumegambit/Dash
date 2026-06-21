package app.dash.network

import app.cash.turbine.test
import app.dash.model.AgentEvent
import app.dash.model.WsClientMessage
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class ChatSocketTest {
    private lateinit var server: MockWebServer
    private val ok = OkHttpClient()

    @Before fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @After fun tearDown() {
        server.shutdown()
    }

    private fun message(id: String = "1") = WsClientMessage.Message(
        id = id, agentId = "ada", channelId = "c", conversationId = "conv", text = "hi",
    )

    private fun socket(): ChatSocket {
        val url = server.url("/ws").toString().replaceFirst("http", "ws")
        return ChatSocket(url, ok)
    }

    @Test fun streamsEventsThenCompletes() = runTest {
        server.enqueue(
            MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                override fun onMessage(webSocket: WebSocket, text: String) {
                    webSocket.send("""{"type":"event","id":"1","event":{"type":"text_delta","text":"He"}}""")
                    webSocket.send("""{"type":"event","id":"1","event":{"type":"text_delta","text":"llo"}}""")
                    webSocket.send("""{"type":"done","id":"1"}""")
                }
            }),
        )
        socket().stream(message()).test {
            assertEquals(AgentEvent.TextDelta("He"), awaitItem())
            assertEquals(AgentEvent.TextDelta("llo"), awaitItem())
            awaitComplete()
        }
    }

    @Test fun errorFrameFailsTheFlow() = runTest {
        server.enqueue(
            MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                override fun onMessage(webSocket: WebSocket, text: String) {
                    webSocket.send("""{"type":"error","id":"1","error":"boom"}""")
                }
            }),
        )
        socket().stream(message()).test {
            val err = awaitError()
            assertTrue(err is GatewayStreamError)
            assertEquals("boom", err.message)
        }
    }

    @Test fun authCloseFailsWithAuthError() = runTest {
        server.enqueue(
            MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    webSocket.close(4001, "Unauthorized")
                }
            }),
        )
        socket().stream(message()).test {
            assertTrue(awaitError() is GatewayAuthError)
        }
    }

    @Test fun sendsRelayCredentialHeaderOnUpgrade() = runTest {
        server.enqueue(
            MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    webSocket.send("""{"type":"done","id":"1"}""")
                }
            }),
        )
        val url = server.url("/ws").toString().replaceFirst("http", "ws")
        ChatSocket(url, ok, "relay-cred").stream(message()).test { awaitComplete() }
        // The upgrade HTTP request must carry the relay credential header.
        assertEquals("relay-cred", server.takeRequest().getHeader("x-dash-relay-credential"))
    }
}
