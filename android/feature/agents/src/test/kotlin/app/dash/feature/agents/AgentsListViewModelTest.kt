package app.dash.feature.agents

import app.dash.model.AgentConfig
import app.dash.model.AgentStatus
import app.dash.model.RegisteredAgent
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class AgentsListViewModelTest {
    @get:Rule val mainRule = MainDispatcherRule()

    private fun agent(id: String) =
        RegisteredAgent(id, "Agent $id", AgentConfig("m", "p"), AgentStatus.ACTIVE, "t")

    @Test fun loadsAgentsIntoLoadedState() = runTest(mainRule.dispatcher) {
        val vm = AgentsListViewModel(FakeAgentsRepository(agents = listOf(agent("1"), agent("2"))))
        advanceUntilIdle()
        val s = vm.state.value
        assertTrue(s is AgentsUiState.Loaded)
        assertEquals(2, (s as AgentsUiState.Loaded).agents.size)
    }

    @Test fun errorBecomesErrorState() = runTest(mainRule.dispatcher) {
        val vm = AgentsListViewModel(FakeAgentsRepository(failList = true))
        advanceUntilIdle()
        assertTrue(vm.state.value is AgentsUiState.Error)
    }
}
