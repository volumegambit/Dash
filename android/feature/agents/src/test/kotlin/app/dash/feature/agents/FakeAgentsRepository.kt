package app.dash.feature.agents

import app.dash.model.RegisteredAgent
import kotlinx.coroutines.CompletableDeferred

class FakeAgentsRepository(
    private val agents: List<RegisteredAgent> = emptyList(),
    private val agent: RegisteredAgent? = null,
    private val failList: Boolean = false,
    private val failSetEnabled: Boolean = false,
    /** When set, setEnabled suspends until this is completed (to observe optimism). */
    private val setEnabledGate: CompletableDeferred<Unit>? = null,
) : AgentsRepository {
    var lastSetEnabled: Pair<String, Boolean>? = null
        private set

    override suspend fun list(): List<RegisteredAgent> {
        if (failList) throw RuntimeException("load failed")
        return agents
    }

    override suspend fun get(id: String): RegisteredAgent =
        agent ?: throw RuntimeException("not found")

    override suspend fun setEnabled(id: String, enabled: Boolean) {
        setEnabledGate?.await()
        lastSetEnabled = id to enabled
        if (failSetEnabled) throw RuntimeException("toggle failed")
    }
}
