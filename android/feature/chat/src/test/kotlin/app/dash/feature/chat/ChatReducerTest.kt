package app.dash.feature.chat

import app.dash.model.AgentEvent
import app.dash.model.Usage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatReducerTest {
    private fun withPendingAssistant() = ChatUiState(
        messages = listOf(ChatMessage.User("hi"), ChatMessage.Assistant()),
    )

    private fun reduce(state: ChatUiState, vararg events: AgentEvent): ChatUiState =
        events.fold(state) { acc, e -> ChatReducer.reduce(acc, e) }

    private fun lastAssistant(s: ChatUiState) = s.messages.last() as ChatMessage.Assistant

    @Test fun concatenatesTextDeltasAndCompletesOnResponse() {
        val s = reduce(
            withPendingAssistant(),
            AgentEvent.TextDelta("Hel"),
            AgentEvent.TextDelta("lo"),
            AgentEvent.Response("Hello", Usage(1, 1)),
        )
        val a = lastAssistant(s)
        assertEquals("Hello", a.text)
        assertTrue(a.done)
    }

    @Test fun accumulatesThinking() {
        val s = reduce(
            withPendingAssistant(),
            AgentEvent.ThinkingDelta("Let me "),
            AgentEvent.ThinkingDelta("think"),
        )
        assertEquals("Let me think", lastAssistant(s).thinking)
    }

    @Test fun addsToolCallThenAttachesResult() {
        val s = reduce(
            withPendingAssistant(),
            AgentEvent.ToolUseStart("t1", "read_file"),
            AgentEvent.ToolResult("t1", "read_file", "file contents", isError = false),
        )
        val call = lastAssistant(s).toolCalls.single()
        assertEquals("read_file", call.name)
        assertEquals("file contents", call.result)
        assertTrue(!call.isError)
    }

    @Test fun attachesQuestion() {
        val s = reduce(
            withPendingAssistant(),
            AgentEvent.Question("q1", "Which?", listOf("a", "b")),
        )
        assertEquals("q1", lastAssistant(s).question?.id)
    }

    @Test fun errorEventSetsError() {
        val s = reduce(withPendingAssistant(), AgentEvent.ErrorEvent("boom"))
        assertEquals("boom", s.error)
    }

    @Test fun responseUsesContentWhenNoDeltas() {
        val s = reduce(withPendingAssistant(), AgentEvent.Response("final", Usage(0, 0)))
        assertEquals("final", lastAssistant(s).text)
    }

    @Test fun unknownEventIsNoOp() {
        val before = withPendingAssistant()
        val after = ChatReducer.reduce(before, AgentEvent.Unknown("brand_new"))
        assertEquals(before, after)
        assertNull(after.error)
    }
}
