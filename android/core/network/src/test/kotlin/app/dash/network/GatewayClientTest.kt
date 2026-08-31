package app.dash.network

import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
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
        assertEquals("/mobile/v1/agents", req.path)
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
        assertEquals("/mobile/v1/agents/agent-1/enable", req.path)
        assertEquals("Bearer tok", req.getHeader("Authorization"))
    }

    @Test fun disablePostsToDisablePath() = runTest {
        server.enqueue(MockResponse().setResponseCode(200).setBody("{}"))
        client().disable("agent-1")
        assertEquals("/mobile/v1/agents/agent-1/disable", server.takeRequest().path)
    }

    @Test fun healthTrueOn200() = runTest {
        server.enqueue(MockResponse().setResponseCode(200).setBody("{}"))
        assertTrue(client().health())
        assertEquals("/mobile/v1/health", server.takeRequest().path)
    }

    @Test fun healthFalseOn500() = runTest {
        server.enqueue(MockResponse().setResponseCode(500))
        assertTrue(!client().health())
    }

    @Test fun sendsRelayCredentialHeaderWhenSet() = runTest {
        server.enqueue(MockResponse().setResponseCode(200).setBody("[]"))
        GatewayClient(server.url("/").toString(), "tok", ok, "relay-cred").listAgents()
        val req = server.takeRequest()
        assertEquals("relay-cred", req.getHeader("x-dash-relay-credential"))
        assertEquals("Bearer tok", req.getHeader("Authorization"))
    }

    @Test fun omitsRelayCredentialHeaderForLan() = runTest {
        server.enqueue(MockResponse().setResponseCode(200).setBody("[]"))
        client().listAgents() // no relay credential
        assertNull(server.takeRequest().getHeader("x-dash-relay-credential"))
    }

    @Test fun exactLeafPinAllowsSelfSignedHttps() = runTest {
        val tlsServer = MockWebServer()
        tlsServer.useHttps(TlsTestFixture.serverSocketFactory, false)
        tlsServer.start()
        try {
            tlsServer.enqueue(MockResponse().setResponseCode(200).setBody("[]"))
            val pinned = PinnedTlsClientFactory.create(
                baseClient = ok,
                expectedHost = "localhost",
                certificateSha256 = TlsTestFixture.certificateSha256,
            )
            val agents = GatewayClient(tlsServer.url("/").toString(), "tok", pinned).listAgents()
            assertTrue(agents.isEmpty())
            assertEquals("Bearer tok", tlsServer.takeRequest().getHeader("Authorization"))
        } finally {
            tlsServer.shutdown()
        }
    }

    @Test fun wrongLeafPinRejectsHttpsBeforeBearerIsSent() = runTest {
        val tlsServer = MockWebServer()
        tlsServer.useHttps(TlsTestFixture.serverSocketFactory, false)
        tlsServer.start()
        try {
            val pinned = PinnedTlsClientFactory.create(
                baseClient = ok,
                expectedHost = "localhost",
                certificateSha256 = TlsTestFixture.differentCertificateSha256,
            )
            assertTrue(!GatewayClient(tlsServer.url("/").toString(), "tok", pinned).health())
            assertEquals(0, tlsServer.requestCount)
        } finally {
            tlsServer.shutdown()
        }
    }

    @Test fun pinnedClientRejectsUnexpectedHostEvenWithMatchingCertificate() = runTest {
        val tlsServer = MockWebServer()
        tlsServer.useHttps(TlsTestFixture.serverSocketFactory, false)
        tlsServer.start()
        try {
            val pinned = PinnedTlsClientFactory.create(
                baseClient = ok,
                expectedHost = "gateway.local",
                certificateSha256 = TlsTestFixture.certificateSha256,
            )
            assertTrue(!GatewayClient(tlsServer.url("/").toString(), "tok", pinned).health())
            assertEquals(0, tlsServer.requestCount)
        } finally {
            tlsServer.shutdown()
        }
    }

    @Test fun pinnedClientRejectsMalformedDigest() {
        try {
            PinnedTlsClientFactory.create(ok, "localhost", "not-a-sha256")
            fail("expected malformed certificate digest to be rejected")
        } catch (_: IllegalArgumentException) {
            // Expected.
        }
    }
}
