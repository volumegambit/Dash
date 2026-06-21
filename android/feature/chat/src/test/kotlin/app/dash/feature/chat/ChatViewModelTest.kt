package app.dash.feature.chat

import app.dash.model.AgentEvent
import app.dash.model.Usage
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ChatViewModelTest {
    @get:Rule val mainRule = MainDispatcherRule()

    @Test fun sendFoldsEventsIntoAssistantMessage() = runTest(mainRule.dispatcher) {
        val events = flowOf(
            AgentEvent.TextDelta("Hel"),
            AgentEvent.TextDelta("lo"),
            AgentEvent.Response("Hello", Usage(1, 1)),
        )
        val vm = ChatViewModel("agent", { events })
        vm.send("hi")
        advanceUntilIdle()
        val s = vm.state.value
        assertFalse(s.streaming)
        assertTrue(s.messages.first() is ChatMessage.User)
        val assistant = s.messages.last() as ChatMessage.Assistant
        assertEquals("Hello", assistant.text)
        assertTrue(assistant.done)
    }

    @Test fun streamErrorSetsErrorState() = runTest(mainRule.dispatcher) {
        val failing: Flow<AgentEvent> = flow { throw RuntimeException("boom") }
        val vm = ChatViewModel("agent", { failing })
        vm.send("hi")
        advanceUntilIdle()
        assertEquals("boom", vm.state.value.error)
        assertFalse(vm.state.value.streaming)
    }

    @Test fun blankSendIsIgnored() = runTest(mainRule.dispatcher) {
        val vm = ChatViewModel("agent", { flowOf() })
        vm.send("   ")
        advanceUntilIdle()
        assertTrue(vm.state.value.messages.isEmpty())
    }
}
