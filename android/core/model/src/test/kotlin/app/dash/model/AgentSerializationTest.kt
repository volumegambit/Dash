package app.dash.model

import kotlinx.serialization.decodeFromString
import org.junit.Assert.assertEquals
import org.junit.Test

class AgentSerializationTest {
    private val json = DashJson.instance

    @Test fun decodesRegisteredAgent() {
        val a = json.decodeFromString<RegisteredAgent>(
            """{"id":"a","name":"Ada","config":{"model":"claude","systemPrompt":"p","tools":["files"]},"status":"active","registeredAt":"2026-01-01"}""",
        )
        assertEquals("Ada", a.name)
        assertEquals(AgentStatus.ACTIVE, a.status)
        assertEquals("claude", a.config.model)
        assertEquals(listOf("files"), a.config.tools)
    }

    @Test fun decodesListAndIgnoresExtraFields() {
        val list = json.decodeFromString<List<RegisteredAgent>>(
            """[{"id":"a","name":"Ada","config":{"model":"m","systemPrompt":"p","maxTokens":1000},"status":"disabled","registeredAt":"t","extra":"ignored"}]""",
        )
        assertEquals(1, list.size)
        assertEquals(AgentStatus.DISABLED, list[0].status)
    }

    @Test fun decodesAllThreeStatuses() {
        fun status(s: String) = json.decodeFromString<RegisteredAgent>(
            """{"id":"x","name":"n","config":{"model":"m","systemPrompt":"p"},"status":"$s","registeredAt":"t"}""",
        ).status
        assertEquals(AgentStatus.REGISTERED, status("registered"))
        assertEquals(AgentStatus.ACTIVE, status("active"))
        assertEquals(AgentStatus.DISABLED, status("disabled"))
    }
}
