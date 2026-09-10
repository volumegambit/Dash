package app.dash.network

import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
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

    private fun client(selection: GatewayProtocolSelection = GatewayProtocolSelection.V1) =
        GatewayClient.selected(server.url("/").toString(), "tok", selection, ok)

    private fun negotiator(relayCredential: String? = null) =
        GatewayClient.forNegotiation(
            server.url("/").toString(),
            "tok",
            ok,
            relayCredential,
        )

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
        GatewayClient.selected(
            server.url("/").toString(),
            "tok",
            GatewayProtocolSelection.V1,
            ok,
            "relay-cred",
        ).listAgents()
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
            val agents = GatewayClient.selected(
                tlsServer.url("/").toString(),
                "tok",
                GatewayProtocolSelection.V1,
                pinned,
            ).listAgents()
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
            assertTrue(
                !GatewayClient.selected(
                    tlsServer.url("/").toString(),
                    "tok",
                    GatewayProtocolSelection.V1,
                    pinned,
                ).health(),
            )
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
            assertTrue(
                !GatewayClient.selected(
                    tlsServer.url("/").toString(),
                    "tok",
                    GatewayProtocolSelection.V1,
                    pinned,
                ).health(),
            )
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

    @Test fun unsupportedV2FallsBackButUnauthorizedDoesNot() = runTest {
        server.enqueue(MockResponse().setResponseCode(404))
        assertEquals(GatewayNegotiation.UnsupportedVersion, negotiator().negotiate())

        server.enqueue(MockResponse().setResponseCode(401).setBody("unauthorized"))
        val result = negotiator().negotiate()
        assertTrue(result is GatewayNegotiation.Failed.Authentication)
        result as GatewayNegotiation.Failed.Authentication
        assertEquals(401, result.status)
    }

    @Test fun onlyTypedCapabilityRequired426FallsBack() = runTest {
        server.enqueue(
            MockResponse().setResponseCode(426).setBody(
                """{"code":"capability_required","error":"Mobile API v2 is unsupported","retryable":false}""",
            ),
        )
        assertEquals(GatewayNegotiation.UnsupportedVersion, negotiator().negotiate())

        server.enqueue(
            MockResponse().setResponseCode(426).setBody(
                """{"code":"validation_failed","error":"bad request","retryable":false}""",
            ),
        )
        val result = negotiator().negotiate()
        assertTrue(result is GatewayNegotiation.Failed.Api)
    }

    @Test fun malformedCapabilityRequired426NeverFallsBack() = runTest {
        listOf(
            """{"code":"capability_required"}""",
            """{"code":"capability_required","error":"","retryable":false}""",
            """{"code":"capability_required","error":"unsupported","retryable":"false"}""",
            """{"code":"capability_required","error":"unsupported","retryable":false,"details":null}""",
            """{"code":"capability_required","error":"unsupported","retryable":false,"extra":1}""",
            """{"code":"future_code","error":"unsupported","retryable":false}""",
            "[]",
            "not-json",
        ).forEach { body ->
            server.enqueue(MockResponse().setResponseCode(426).setBody(body))
            assertTrue(body, negotiator().negotiate() is GatewayNegotiation.Failed.Malformed)
        }
    }

    @Test fun strictErrorAndIdentityHelpersRejectEveryNonExactBody() {
        assertEquals(
            "unsupported",
            decodeStrictMobileApiError(
                """{"code":"capability_required","error":"unsupported","retryable":false}""",
            )?.error,
        )
        assertEquals(
            "gw-1",
            decodeExactGatewayIdentity(
                """{"gatewayId":"gw-1","publicKey":"public-key"}""",
            )?.gatewayId,
        )
        listOf(
            "{}",
            """{"gatewayId":"gw-1"}""",
            """{"gatewayId":"","publicKey":"public-key"}""",
            """{"gatewayId":"gw-1","publicKey":""}""",
            """{"gatewayId":"gw-1","publicKey":"public-key","extra":true}""",
            "[]",
            "not-json",
        ).forEach { body -> assertNull(body, decodeExactGatewayIdentity(body)) }
    }

    @Test fun successfulNegotiationUsesExactV2PathsAndAuthMetadata() = runTest {
        server.enqueue(MockResponse().setBody(validHealth()))
        server.enqueue(MockResponse().setBody(validIdentity()))

        val result = negotiator("relay-cred").negotiate()

        assertEquals(
            GatewayNegotiation.V2("gw-1", setOf("chat-input-queue-v1", "future")),
            result,
        )
        val health = server.takeRequest()
        val identity = server.takeRequest()
        assertEquals("/mobile/v2/health", health.path)
        assertEquals("/mobile/v2/identity", identity.path)
        listOf(health, identity).forEach { request ->
            assertEquals("Bearer tok", request.getHeader("Authorization"))
            assertEquals("relay-cred", request.getHeader("x-dash-relay-credential"))
        }
    }

    @Test fun malformedHealthNeverRequestsIdentity() = runTest {
        listOf(
            "{}",
            validHealth().replace("\"startedAt\":\"2026-09-06T00:00:00Z\"", "\"startedAt\":\"bad\""),
            validHealth().replace("\"pid\":1", "\"pid\":0"),
            validHealth().replace("\"agents\":1", "\"agents\":-1"),
            validHealth().replace("\"channels\":1", "\"channels\":-1"),
            validHealth(listOf("chat-input-queue-v1", "chat-input-queue-v1")),
            validHealth().dropLast(1) + ",\"extra\":true}",
        ).forEachIndexed { index, body ->
            server.enqueue(MockResponse().setBody(body))
            assertTrue("case $index", negotiator().negotiate() is GatewayNegotiation.Failed.Malformed)
            assertEquals(index + 1, server.requestCount)
        }
    }

    @Test fun malformedIdentityNeverSelectsV2() = runTest {
        val bodies = listOf(
            "{}",
            """{"gatewayId":"gw-1"}""",
            """{"publicKey":"public-key"}""",
            """{"gatewayId":"","publicKey":"public-key"}""",
            """{"gatewayId":"gw-1","publicKey":""}""",
            """{"gatewayId":"gw-1","publicKey":"public-key","extra":true}""",
            "[]",
            "not-json",
        )
        bodies.forEachIndexed { index, body ->
            server.enqueue(MockResponse().setBody(validHealth()))
            server.enqueue(MockResponse().setBody(body))
            assertTrue(body, negotiator().negotiate() is GatewayNegotiation.Failed.Malformed)
            assertEquals((index + 1) * 2, server.requestCount)
        }
    }

    @Test fun missingQueueCapabilityIsTerminalAfterIdentity() = runTest {
        server.enqueue(MockResponse().setBody(validHealth(listOf("future"))))
        server.enqueue(MockResponse().setBody(validIdentity()))

        assertTrue(negotiator().negotiate() is GatewayNegotiation.Failed.Malformed)
        assertEquals(2, server.requestCount)
    }

    @Test fun oneSelectionRoutesEveryExistingAgentCallWithoutMixingVersions() = runTest {
        val v2 = client(GatewayProtocolSelection.V2("gw-1", setOf("chat-input-queue-v1")))
        server.enqueue(MockResponse().setBody(validV2Agents()))
        server.enqueue(MockResponse().setBody(validV2Agent()))
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        assertEquals("Ada", v2.listAgents().single().name)
        assertEquals("Ada", v2.getAgent("agent/1").name)
        v2.enable("agent/1")
        v2.disable("agent/1")
        assertEquals(
            listOf(
                "/mobile/v2/agents",
                "/mobile/v2/agents/agent%2F1",
                "/mobile/v2/agents/agent%2F1/enable",
                "/mobile/v2/agents/agent%2F1/disable",
            ),
            List(4) { server.takeRequest().path },
        )

        val v1 = client(GatewayProtocolSelection.V1)
        server.enqueue(MockResponse().setBody(validV1Agents()))
        assertEquals("Ada", v1.listAgents().single().name)
        assertEquals("/mobile/v1/agents", server.takeRequest().path)
    }

    @Test fun v2AgentsNeverSilentlyDecodeThroughTheFrozenV1Shape() = runTest {
        val v2 = client(GatewayProtocolSelection.V2("gw-1", setOf("chat-input-queue-v1")))
        listOf(
            validV1Agents(),
            "[${validV2Agent().dropLast(1)},\"extra\":true}]",
            "[${validV2Agent().replace("2026-09-06T00:00:00Z", "not-a-time")} ]",
        ).forEach { body ->
            server.enqueue(MockResponse().setBody(body))
            try {
                v2.listAgents()
                fail("expected strict mobile v2 agent decoding to fail")
            } catch (_: IllegalArgumentException) {
                // Expected from the v2-only contract boundary.
            }
        }
    }

    @Test fun v2EnableAndDisableRequireExactSuccessfulAcknowledgements() = runTest {
        val v2 = client(GatewayProtocolSelection.V2("gw-1", setOf("chat-input-queue-v1")))
        val actions = listOf<suspend (GatewayClient) -> Unit>(
            { it.enable("agent-1") },
            { it.disable("agent-1") },
        )
        val invalidBodies = listOf(
            "{}",
            """{"ok":false}""",
            """{"ok":"true"}""",
            """{"ok":true,"extra":1}""",
            "[]",
        )

        actions.forEach { action ->
            invalidBodies.forEach { body ->
                server.enqueue(MockResponse().setBody(body))
                try {
                    action(v2)
                    fail("expected exact mobile v2 action acknowledgement for $body")
                } catch (_: IllegalArgumentException) {
                    // Expected from the strict v2 response boundary.
                }
            }
        }
    }

    @Test fun cancellationAtHealthIdentityAndSelectedRestNeverFallsBack() = runTest {
        val healthServer = MockWebServer().also { it.start() }
        try {
            healthServer.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
            val health = async(Dispatchers.Default) {
                GatewayClient.forNegotiation(
                    healthServer.url("/").toString(),
                    "tok",
                    ok,
                ).negotiate()
            }
            assertTrue(healthServer.takeRequest(2, TimeUnit.SECONDS) != null)
            health.cancelAndJoin()
            assertTrue(health.isCancelled)
        } finally {
            healthServer.shutdown()
        }

        val identityServer = MockWebServer().also { it.start() }
        try {
            identityServer.enqueue(MockResponse().setBody(validHealth()))
            identityServer.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
            val identity = async(Dispatchers.Default) {
                GatewayClient.forNegotiation(
                    identityServer.url("/").toString(),
                    "tok",
                    ok,
                ).negotiate()
            }
            assertTrue(identityServer.takeRequest(2, TimeUnit.SECONDS) != null)
            assertTrue(identityServer.takeRequest(2, TimeUnit.SECONDS) != null)
            identity.cancelAndJoin()
            assertTrue(identity.isCancelled)
        } finally {
            identityServer.shutdown()
        }

        val restServer = MockWebServer().also { it.start() }
        try {
            restServer.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
            val rest = async(Dispatchers.Default) {
                GatewayClient.selected(
                    restServer.url("/").toString(),
                    "tok",
                    GatewayProtocolSelection.V1,
                    ok,
                ).listAgents()
            }
            assertTrue(restServer.takeRequest(2, TimeUnit.SECONDS) != null)
            rest.cancelAndJoin()
            assertTrue(rest.isCancelled)
        } finally {
            restServer.shutdown()
        }
    }

    @Test fun cancellationIsNeverMappedToANegotiationFailure() = runTest {
        val throwing = OkHttpClient.Builder().addInterceptor {
            throw java.io.IOException("cancelled", CancellationException("cancelled"))
        }.build()
        val client = GatewayClient.forNegotiation(server.url("/").toString(), "tok", throwing)
        try {
            client.negotiate()
            fail("expected cancellation")
        } catch (_: CancellationException) {
            assertEquals(0, server.requestCount)
        }
    }

    @Test fun savedSessionSelectionRejectsProtocolIdentityAndCapabilityChanges() {
        val v2 = GatewayNegotiation.V2("gw-1", setOf("chat-input-queue-v1"))
        assertEquals(
            GatewaySessionSelection.Selected(v2.selection()),
            selectGatewaySession("gw-1", v2),
        )
        assertEquals(
            GatewaySessionSelection.Selected(GatewayProtocolSelection.V1),
            selectGatewaySession(null, GatewayNegotiation.UnsupportedVersion),
        )

        listOf(
            selectGatewaySession("gw-1", GatewayNegotiation.UnsupportedVersion),
            selectGatewaySession(null, v2),
            selectGatewaySession(
                "gw-1",
                GatewayNegotiation.V2("gw-2", setOf("chat-input-queue-v1")),
            ),
            selectGatewaySession("gw-1", GatewayNegotiation.V2("gw-1", setOf("future"))),
            selectGatewaySession(
                "gw-1",
                GatewayNegotiation.Failed.Authentication(401, "unauthorized"),
            ),
        ).forEach { assertTrue(it is GatewaySessionSelection.Failed) }
    }

    private fun validHealth(
        capabilities: List<String> = listOf("chat-input-queue-v1", "future"),
    ): String =
        """{"status":"healthy","startedAt":"2026-09-06T00:00:00Z","pid":1,"agents":1,"channels":1,"apiVersion":2,"capabilities":${capabilities.joinToString(prefix = "[", postfix = "]") { "\"$it\"" }}}"""

    private fun validIdentity(): String =
        """{"gatewayId":"gw-1","publicKey":"public-key"}"""

    private fun validV1Agents(): String =
        """[{"id":"a","name":"Ada","config":{"model":"m","systemPrompt":"p"},"status":"active","registeredAt":"t"}]"""

    private fun validV2Agent(): String =
        """{"id":"a","name":"Ada","config":{"name":"Ada","model":"m","systemPrompt":"p"},"status":"active","registeredAt":"2026-09-06T00:00:00Z"}"""

    private fun validV2Agents(): String = "[${validV2Agent()}]"
}
