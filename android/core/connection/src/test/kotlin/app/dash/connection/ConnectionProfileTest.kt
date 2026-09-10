package app.dash.connection

import app.dash.model.DashJson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class ConnectionProfileTest {
    private val certificateSha256 =
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

    @Test fun buildsSecureUrlsByDefault() {
        val p = ConnectionProfile("l", "1.2.3.4", mgmtToken = "m", chatToken = "tok")
        assertEquals("https://1.2.3.4:9300", p.mgmtBaseUrl)
        assertEquals("wss://1.2.3.4:9200/ws/chat", p.chatWsUrl)
    }

    @Test fun buildsSecureUrlsWhenSecure() {
        val p = ConnectionProfile(
            "l",
            "host",
            mgmtToken = "m",
            chatToken = "t",
            secure = true,
            tlsCertificateSha256 = certificateSha256,
        )
        assertEquals("https://host:9300", p.mgmtBaseUrl)
        assertEquals("wss://host:9200/ws/chat", p.chatWsUrl)
        assertEquals(certificateSha256, p.tlsCertificateSha256)
    }

    @Test fun neverEmbedsMobileTokenInWebSocketUrl() {
        val p = ConnectionProfile("l", "h", mgmtToken = "m", chatToken = "a b/c")
        assertEquals("wss://h:9200/ws/chat", p.chatWsUrl)
    }

    @Test fun rejectsNonCanonicalCertificateDigest() {
        try {
            ConnectionProfile(
                "l",
                "h",
                mgmtToken = "m",
                chatToken = "c",
                tlsCertificateSha256 = certificateSha256.uppercase(),
            )
            fail("expected uppercase certificate digest to be rejected")
        } catch (_: IllegalArgumentException) {
            // Expected.
        }
    }

    @Test fun rejectsPinnedCleartextProfile() {
        try {
            ConnectionProfile(
                "l",
                "h",
                mgmtToken = "m",
                chatToken = "c",
                secure = false,
                tlsCertificateSha256 = certificateSha256,
            )
            fail("expected a pinned cleartext profile to be rejected")
        } catch (_: IllegalArgumentException) {
            // Expected.
        }
    }

    @Test fun legacyLanProfileRequiresRepairBeforeNetworking() {
        val profile = ConnectionProfile(
            "Legacy",
            "10.0.0.5",
            mgmtToken = "mobile",
            chatToken = "mobile",
            secure = false,
        )
        assertTrue(profile.requiresRepair)
    }

    @Test fun pinnedLanAndRelayProfilesDoNotRequireRepair() {
        val lan = ConnectionProfile(
            "LAN",
            "10.0.0.5",
            mgmtToken = "mobile",
            chatToken = "mobile",
            tlsCertificateSha256 = certificateSha256,
        )
        val relay = ConnectionProfile(
            "Relay",
            "gateway.relay.example",
            mgmtToken = "mobile",
            chatToken = "mobile",
            relayCredential = "device-credential",
        )
        assertFalse(lan.requiresRepair)
        assertFalse(relay.requiresRepair)
    }

    @Test fun gatewayIdentityIsOptionalForOldProfilesAndRoundTripsWhenPresent() {
        val old = DashJson.instance.decodeFromString<ConnectionProfile>(
            """{"label":"Old","host":"h","mgmtToken":"m","chatToken":"c"}""",
        )
        assertEquals(null, old.gatewayId)

        val selected = old.copy(gatewayId = "gateway-1")
        assertEquals(
            selected,
            DashJson.instance.decodeFromString<ConnectionProfile>(
                DashJson.instance.encodeToString(ConnectionProfile.serializer(), selected),
            ),
        )
    }

    @Test fun rejectsEmptyPersistedGatewayIdentity() {
        try {
            ConnectionProfile("l", "h", mgmtToken = "m", chatToken = "c", gatewayId = "")
            fail("expected empty gateway identity to be rejected")
        } catch (_: IllegalArgumentException) {
            // Expected.
        }
    }
}
