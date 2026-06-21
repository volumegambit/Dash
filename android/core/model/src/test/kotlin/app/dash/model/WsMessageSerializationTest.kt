package app.dash.model

import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class WsMessageSerializationTest {
    private val json = DashJson.instance

    @Test fun encodesMessageWithTypeDiscriminator() {
        val msg: WsClientMessage = WsClientMessage.Message(
            id = "1", agent = "ada", channelId = "c", conversationId = "conv", text = "hi",
        )
        val obj = json.encodeToJsonElement(WsClientMessage.serializer(), msg).jsonObject
        assertEquals("message", obj["type"]?.jsonPrimitive?.content)
        assertEquals("ada", obj["agent"]?.jsonPrimitive?.content)
        assertEquals("conv", obj["conversationId"]?.jsonPrimitive?.content)
    }

    @Test fun encodesCancel() {
        val obj = json.encodeToJsonElement(
            WsClientMessage.serializer(), WsClientMessage.Cancel("9"),
        ).jsonObject
        assertEquals("cancel", obj["type"]?.jsonPrimitive?.content)
        assertEquals("9", obj["id"]?.jsonPrimitive?.content)
    }

    @Test fun encodesAnswerWithQuestionId() {
        val obj = json.encodeToJsonElement(
            WsClientMessage.serializer(), WsClientMessage.Answer("1", "q", "yes"),
        ).jsonObject
        assertEquals("answer", obj["type"]?.jsonPrimitive?.content)
        assertEquals("q", obj["questionId"]?.jsonPrimitive?.content)
    }

    @Test fun decodesServerEventWithNestedAgentEvent() {
        val m = json.decodeFromString<WsServerMessage>(
            """{"type":"event","id":"1","event":{"type":"text_delta","text":"hi"}}""",
        )
        m as WsServerMessage.Event
        assertEquals("1", m.id)
        assertEquals(AgentEvent.TextDelta("hi"), m.event)
    }

    @Test fun decodesServerDone() {
        val m = json.decodeFromString<WsServerMessage>("""{"type":"done","id":"1"}""")
        assertTrue(m is WsServerMessage.Done)
    }

    @Test fun decodesServerError() {
        assertEquals(
            WsServerMessage.ErrorMsg("1", "boom"),
            json.decodeFromString<WsServerMessage>("""{"type":"error","id":"1","error":"boom"}"""),
        )
    }
}
