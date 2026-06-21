package app.dash.model

import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Round-trips every wire variant of the gateway's AgentEvent union. */
class AgentEventSerializationTest {
    private val json = DashJson.instance
    private fun decode(s: String): AgentEvent = json.decodeFromString(s)

    @Test fun decodesTextDelta() {
        assertEquals(AgentEvent.TextDelta("hi"), decode("""{"type":"text_delta","text":"hi"}"""))
    }

    @Test fun decodesThinkingDelta() {
        assertEquals(AgentEvent.ThinkingDelta("t"), decode("""{"type":"thinking_delta","text":"t"}"""))
    }

    @Test fun decodesToolUseStartWithInput() {
        val ev = decode("""{"type":"tool_use_start","id":"1","name":"read","input":{"path":"a"}}""")
        ev as AgentEvent.ToolUseStart
        assertEquals("1", ev.id)
        assertEquals("read", ev.name)
        assertEquals("a", (ev.input?.get("path") as JsonPrimitive).content)
    }

    @Test fun decodesToolUseDeltaSnakeCase() {
        assertEquals(
            AgentEvent.ToolUseDelta("""{"a":1}"""),
            decode("""{"type":"tool_use_delta","partial_json":"{\"a\":1}"}"""),
        )
    }

    @Test fun decodesToolResult() {
        val ev = decode("""{"type":"tool_result","id":"1","name":"read","content":"ok","isError":false}""")
        ev as AgentEvent.ToolResult
        assertEquals("ok", ev.content)
        assertEquals(false, ev.isError)
    }

    @Test fun decodesResponseWithUsage() {
        val ev = decode("""{"type":"response","content":"done","usage":{"inputTokens":3,"outputTokens":5}}""")
        ev as AgentEvent.Response
        assertEquals(3, ev.usage.inputTokens)
        assertEquals(5, ev.usage.outputTokens)
    }

    @Test fun decodesError() {
        assertEquals(
            AgentEvent.ErrorEvent("boom", "t"),
            decode("""{"type":"error","error":"boom","timestamp":"t"}"""),
        )
    }

    @Test fun decodesFileChanged() {
        assertEquals(
            AgentEvent.FileChanged(listOf("a.kt")),
            decode("""{"type":"file_changed","files":["a.kt"]}"""),
        )
    }

    @Test fun decodesAgentSpawned() {
        assertEquals(AgentEvent.AgentSpawned("sub"), decode("""{"type":"agent_spawned","name":"sub"}"""))
    }

    @Test fun decodesAgentRetry() {
        assertEquals(
            AgentEvent.AgentRetry(2, "rate"),
            decode("""{"type":"agent_retry","attempt":2,"reason":"rate"}"""),
        )
    }

    @Test fun decodesContextCompacted() {
        assertEquals(
            AgentEvent.ContextCompacted(true),
            decode("""{"type":"context_compacted","overflow":true}"""),
        )
    }

    @Test fun decodesQuestion() {
        assertEquals(
            AgentEvent.Question("q1", "Pick?", listOf("a", "b")),
            decode("""{"type":"question","id":"q1","question":"Pick?","options":["a","b"]}"""),
        )
    }

    @Test fun decodesSkillLoaded() {
        assertEquals(AgentEvent.SkillLoaded("git"), decode("""{"type":"skill_loaded","name":"git"}"""))
    }

    @Test fun decodesSkillCreated() {
        assertEquals(
            AgentEvent.SkillCreated("git", "desc"),
            decode("""{"type":"skill_created","name":"git","description":"desc"}"""),
        )
    }

    @Test fun decodesMcpServerError() {
        assertEquals(
            AgentEvent.McpServerError("linear", "down"),
            decode("""{"type":"mcp_server_error","server":"linear","error":"down"}"""),
        )
    }

    @Test fun unknownVariantFallsBack() {
        val ev = decode("""{"type":"totally_new","x":1}""")
        assertTrue(ev is AgentEvent.Unknown)
        assertEquals("totally_new", (ev as AgentEvent.Unknown).type)
    }

    @Test fun toleratesExtraFieldsOnKnownVariant() {
        // Gateway may add fields; client must not crash.
        assertEquals(
            AgentEvent.TextDelta("hi"),
            decode("""{"type":"text_delta","text":"hi","futureField":42}"""),
        )
    }
}
