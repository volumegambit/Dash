package app.dash.feature.chat

import app.dash.model.AgentEvent
import app.dash.model.Usage
import app.dash.model.WsClientMessage
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.launch
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
        val vm = ChatViewModel("agent", { _, _ -> events })
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
        val vm = ChatViewModel("agent", { _, _ -> failing })
        vm.send("hi")
        advanceUntilIdle()
        assertEquals("boom", vm.state.value.error)
        assertFalse(vm.state.value.streaming)
    }

    @Test fun blankSendIsIgnored() = runTest(mainRule.dispatcher) {
        val vm = ChatViewModel("agent", { _, _ -> flowOf() })
        vm.send("   ")
        advanceUntilIdle()
        assertTrue(vm.state.value.messages.isEmpty())
    }

    @Test fun answerForwardsAnswerFrameToOutgoing() = runTest(mainRule.dispatcher) {
        val received = mutableListOf<WsClientMessage>()
        // A stream that stays open and forwards `outgoing` into `received`, so the
        // collector is guaranteed active for the whole turn.
        val vm = ChatViewModel("agent", { _, out ->
            channelFlow<AgentEvent> {
                val job = launch { out.collect { received += it } }
                awaitClose { job.cancel() }
            }
        })
        vm.send("hi")
        advanceUntilIdle()
        vm.answer("q1", "a")
        advanceUntilIdle()
        assertTrue(
            received.any { it is WsClientMessage.Answer && it.questionId == "q1" && it.answer == "a" },
        )
        vm.stop()
        advanceUntilIdle()
    }
}
