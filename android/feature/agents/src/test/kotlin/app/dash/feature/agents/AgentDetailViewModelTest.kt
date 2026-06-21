package app.dash.feature.agents

import app.dash.model.AgentConfig
import app.dash.model.AgentStatus
import app.dash.model.RegisteredAgent
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class AgentDetailViewModelTest {
    @get:Rule val mainRule = MainDispatcherRule()

    private val disabled =
        RegisteredAgent("a", "Ada", AgentConfig("m", "p"), AgentStatus.DISABLED, "t")

    @Test fun loadsAgent() = runTest(mainRule.dispatcher) {
        val vm = AgentDetailViewModel("a", FakeAgentsRepository(agent = disabled))
        advanceUntilIdle()
        assertEquals("Ada", vm.state.value.agent?.name)
        assertFalse(vm.state.value.loading)
    }

    @Test fun toggleIsOptimisticThenKeptOnSuccess() = runTest(mainRule.dispatcher) {
        val gate = CompletableDeferred<Unit>()
        val repo = FakeAgentsRepository(agent = disabled, setEnabledGate = gate)
        val vm = AgentDetailViewModel("a", repo)
        advanceUntilIdle()
        vm.toggleEnabled()
        // optimistic flip happens synchronously, before the gated network call returns;
        // enable() yields `registered` server-side, so the optimistic state matches.
        assertEquals(AgentStatus.REGISTERED, vm.state.value.agent?.status)
        gate.complete(Unit)
        advanceUntilIdle()
        assertEquals(AgentStatus.REGISTERED, vm.state.value.agent?.status)
        assertNull(vm.state.value.toggleError)
        assertEquals("a" to true, repo.lastSetEnabled)
    }

    @Test fun toggleRevertsOnFailure() = runTest(mainRule.dispatcher) {
        val repo = FakeAgentsRepository(agent = disabled, failSetEnabled = true)
        val vm = AgentDetailViewModel("a", repo)
        advanceUntilIdle()
        vm.toggleEnabled()
        advanceUntilIdle()
        assertEquals(AgentStatus.DISABLED, vm.state.value.agent?.status)
        assertNotNull(vm.state.value.toggleError)
    }
}
