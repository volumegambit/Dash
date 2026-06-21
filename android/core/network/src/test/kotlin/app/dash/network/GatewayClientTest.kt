package app.dash.network

import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

class GatewayClientTest {
    private lateinit var server: MockWebServer
    private val ok = OkHttpClient()

    @Before fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @After fun tearDown() {
        server.shutdown()
    }

    private fun client() = GatewayClient(server.url("/").toString(), "tok", ok)

    @Test fun listAgentsParsesAndSendsBearer() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """[{"id":"a","name":"Ada","config":{"model":"m","systemPrompt":"p"},"status":"active","registeredAt":"t"}]""",
            ),
        )
        val list = client().listAgents()
        assertEquals("Ada", list.single().name)
        val req = server.takeRequest()
        assertEquals("/agents", req.path)
        assertEquals("Bearer tok", req.getHeader("Authorization"))
    }

    @Test fun errorStatusThrowsGatewayHttpError() = runTest {
        server.enqueue(MockResponse().setResponseCode(401).setBody("nope"))
        try {
            client().listAgents()
            fail("expected GatewayHttpError")
        } catch (e: GatewayHttpError) {
            assertEquals(401, e.status)
            assertEquals("nope", e.bodyText)
        }
    }

    @Test fun enablePostsToEnablePath() = runTest {
        server.enqueue(MockResponse().setResponseCode(200).setBody("{}"))
        client().enable("agent-1")
        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/agents/agent-1/enable", req.path)
        assertEquals("Bearer tok", req.getHeader("Authorization"))
    }

    @Test fun disablePostsToDisablePath() = runTest {
        server.enqueue(MockResponse().setResponseCode(200).setBody("{}"))
        client().disable("agent-1")
        assertEquals("/agents/agent-1/disable", server.takeRequest().path)
    }

    @Test fun healthTrueOn200() = runTest {
        server.enqueue(MockResponse().setResponseCode(200).setBody("{}"))
        assertTrue(client().health())
    }

    @Test fun healthFalseOn500() = runTest {
        server.enqueue(MockResponse().setResponseCode(500))
        assertTrue(!client().health())
    }
}
