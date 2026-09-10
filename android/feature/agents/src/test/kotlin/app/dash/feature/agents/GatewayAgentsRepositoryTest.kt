package app.dash.feature.agents

import app.dash.network.GatewayClient
import app.dash.network.GatewayProtocolSelection
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test

class GatewayAgentsRepositoryTest {
    @Test fun repositoryRetainsTheClientsImmutableSelection() {
        val selection = GatewayProtocolSelection.V2(
            gatewayId = "gw-1",
            capabilities = setOf("chat-input-queue-v1"),
        )
        val client = GatewayClient.selected("http://127.0.0.1:9300", "token", selection)

        val repository = GatewayAgentsRepository(client)

        assertEquals(selection, repository.protocolSelection)
        assertEquals(selection, client.protocolSelection)
    }

    @Test fun negotiationOnlyClientIsRejectedBeforeAnyAgentRequestCanRun() {
        val client = GatewayClient.forNegotiation("http://127.0.0.1:9300", "token")
        try {
            GatewayAgentsRepository(client)
            fail("expected explicit protocol selection")
        } catch (_: IllegalArgumentException) {
            // Expected.
        }
    }
}
