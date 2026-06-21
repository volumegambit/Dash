package app.dash.feature.agents

import app.dash.model.RegisteredAgent
import app.dash.network.GatewayClient

/** Agent reads + enable/disable, backed by the gateway management API. */
interface AgentsRepository {
    suspend fun list(): List<RegisteredAgent>
    suspend fun get(id: String): RegisteredAgent
    suspend fun setEnabled(id: String, enabled: Boolean)
}

class GatewayAgentsRepository(
    private val client: GatewayClient,
) : AgentsRepository {
    override suspend fun list(): List<RegisteredAgent> = client.listAgents()

    override suspend fun get(id: String): RegisteredAgent = client.getAgent(id)

    override suspend fun setEnabled(id: String, enabled: Boolean) {
        if (enabled) client.enable(id) else client.disable(id)
    }
}
