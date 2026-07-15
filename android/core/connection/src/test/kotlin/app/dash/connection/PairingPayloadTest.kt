package app.dash.connection

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingPayloadTest {
    private val certificateSha256 =
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

    private fun sharedFixture(name: String): String =
        requireNotNull(javaClass.classLoader?.getResource(name)) {
            "Missing shared mobile contract fixture: $name"
        }.readText()

    @Test fun acceptsSharedCurrentPairingFixtures() {
        val lan = PairingPayload.parse(sharedFixture("pairing-lan-v3.json")).getOrThrow()
        val relay = PairingPayload.parse(sharedFixture("pairing-relay-v2.json")).getOrThrow()

        assertEquals(9400, lan.mgmtPort)
        assertEquals(lan.mgmtToken, lan.chatToken)
        assertTrue(lan.tlsCertificateSha256 != null)
        assertEquals(null, lan.relayCredential)
        assertEquals(443, relay.mgmtPort)
        assertEquals(relay.mgmtToken, relay.chatToken)
        assertTrue(relay.relayCredential != null)
        assertEquals(null, relay.tlsCertificateSha256)
    }

    @Test fun rejectsSharedLegacyAndInvalidPairingFixtures() {
        val rejected = listOf(
            "pairing-lan-v1.json",
            "invalid/pairing-blank-secret.json",
            "invalid/pairing-host-with-scheme.json",
            "invalid/pairing-port-out-of-range.json",
            "invalid/pairing-v2-mismatched-mobile-token.json",
            "invalid/pairing-v3-mismatched-mobile-token.json",
            "invalid/pairing-v3-mismatched-ports.json",
        )

        for (fixture in rejected) {
            assertTrue(fixture, PairingPayload.parse(sharedFixture(fixture)).isFailure)
        }
    }

    @Test fun parsesV3PinnedTlsLanPayload() {
        val p = PairingPayload.parse(
            """{"v":3,"host":"10.0.0.5","mgmtToken":"mobile","chatToken":"mobile","mgmtPort":9443,"chatPort":9443,"label":"Office","secure":true,"tlsCertificateSha256":"$certificateSha256"}""",
        ).getOrThrow()
        assertEquals("10.0.0.5", p.host)
        assertEquals(9443, p.mgmtPort)
        assertEquals(9443, p.chatPort)
        assertEquals("Office", p.label)
        assertTrue(p.secure)
        assertEquals(certificateSha256, p.tlsCertificateSha256)
        assertEquals(null, p.relayCredential)
    }

    @Test fun rejectsLegacyV1LanPayload() {
        assertTrue(
            PairingPayload.parse(
                """{"v":1,"host":"10.0.0.5","mgmtToken":"m","chatToken":"c"}""",
            ).isFailure,
        )
    }

    @Test fun rejectsV3WithoutCertificatePin() {
        assertTrue(
            PairingPayload.parse(
                """{"v":3,"host":"h","mgmtToken":"mobile","chatToken":"mobile","mgmtPort":9400,"chatPort":9400,"secure":true}""",
            ).isFailure,
        )
    }

    @Test fun rejectsV3WithoutSecureTrue() {
        assertTrue(
            PairingPayload.parse(
                """{"v":3,"host":"h","mgmtToken":"mobile","chatToken":"mobile","mgmtPort":9400,"chatPort":9400,"tlsCertificateSha256":"$certificateSha256"}""",
            ).isFailure,
        )
    }

    @Test fun rejectsV3WithMalformedCertificatePin() {
        assertTrue(
            PairingPayload.parse(
                """{"v":3,"host":"h","mgmtToken":"mobile","chatToken":"mobile","mgmtPort":9400,"chatPort":9400,"secure":true,"tlsCertificateSha256":"not-a-sha256"}""",
            ).isFailure,
        )
    }

    @Test fun normalizesV3UppercaseCertificatePin() {
        val profile = PairingPayload.parse(
            """{"v":3,"host":"h","mgmtToken":"mobile","chatToken":"mobile","mgmtPort":9400,"chatPort":9400,"secure":true,"tlsCertificateSha256":"${certificateSha256.uppercase()}"}""",
        ).getOrThrow()
        assertEquals(certificateSha256, profile.tlsCertificateSha256)
    }

    @Test fun rejectsV3WithoutPorts() {
        assertTrue(
            PairingPayload.parse(
                """{"v":3,"host":"h","mgmtToken":"mobile","chatToken":"mobile","secure":true,"tlsCertificateSha256":"$certificateSha256"}""",
            ).isFailure,
        )
    }

    @Test fun rejectsV3WithInvalidPort() {
        assertTrue(
            PairingPayload.parse(
                """{"v":3,"host":"h","mgmtToken":"mobile","chatToken":"mobile","mgmtPort":0,"chatPort":9400,"secure":true,"tlsCertificateSha256":"$certificateSha256"}""",
            ).isFailure,
        )
    }

    @Test fun rejectsV3WithMismatchedPorts() {
        assertTrue(
            PairingPayload.parse(
                """{"v":3,"host":"h","mgmtToken":"mobile","chatToken":"mobile","mgmtPort":9400,"chatPort":9401,"secure":true,"tlsCertificateSha256":"$certificateSha256"}""",
            ).isFailure,
        )
    }

    @Test fun rejectsV3WithDifferentMobileTokens() {
        assertTrue(
            PairingPayload.parse(
                """{"v":3,"host":"h","mgmtToken":"mobile-a","chatToken":"mobile-b","mgmtPort":9400,"chatPort":9400,"secure":true,"tlsCertificateSha256":"$certificateSha256"}""",
            ).isFailure,
        )
    }

    @Test fun rejectsHostsOutsideContractGrammar() {
        val invalidHosts = listOf(
            " gateway.example",
            "gateway.example ",
            "gateway example",
            "https://gateway.example",
            "https:gateway.example",
            "gateway.example/path",
            "gateway.example\\path",
            "gateway.example?query",
            "gateway.example#fragment",
            "trusted@evil.example",
            "gateway.example%2Fpath",
        )
        for (host in invalidHosts) {
            assertFalse(host, PairingPayload.isValidHost(host))
        }
    }

    @Test fun acceptsAuthoritySafeHostsIncludingBracketedIpv6() {
        val validHosts = listOf("gateway.example", "127.0.0.1", "[2001:db8::1]")
        for (host in validHosts) {
            assertTrue(host, PairingPayload.isValidHost(host))
        }
    }

    @Test fun normalizesAndComparesTrimmedMobileTokensBeforeStorage() {
        val profile = PairingPayload.parse(
            """{"v":3,"host":"gateway.example","mgmtToken":"  mobile-capability ","chatToken":"\tmobile-capability\n","mgmtPort":9400,"chatPort":9400,"secure":true,"tlsCertificateSha256":"$certificateSha256"}""",
        ).getOrThrow()
        assertEquals("mobile-capability", profile.mgmtToken)
        assertEquals("mobile-capability", profile.chatToken)
    }

    @Test fun rejectsUnsupportedVersion() {
        assertTrue(PairingPayload.parse("""{"v":99,"host":"h","mgmtToken":"m","chatToken":"c"}""").isFailure)
    }

    @Test fun parsesV2RelayPayload() {
        val p = PairingPayload.parse(
            """{"v":2,"host":"gw-1.relay.example.com","secure":true,"mgmtToken":"mobile","chatToken":"mobile","relayCredential":"cred-xyz"}""",
        ).getOrThrow()
        assertEquals("gw-1.relay.example.com", p.host)
        assertEquals("cred-xyz", p.relayCredential)
        assertTrue(p.secure) // relay is always TLS
        assertEquals(443, p.mgmtPort) // standard TLS port at the relay subdomain
        assertEquals(443, p.chatPort)
    }

    @Test fun rejectsV2WithoutRelayCredential() {
        assertTrue(
            PairingPayload.parse(
                """{"v":2,"host":"gw-1.relay.example.com","secure":true,"mgmtToken":"mobile","chatToken":"mobile"}""",
            ).isFailure,
        )
    }

    @Test fun rejectsV2WithoutSecureTrue() {
        assertTrue(
            PairingPayload.parse(
                """{"v":2,"host":"gw-1.relay.example.com","mgmtToken":"mobile","chatToken":"mobile","relayCredential":"cred-xyz"}""",
            ).isFailure,
        )
        assertTrue(
            PairingPayload.parse(
                """{"v":2,"host":"gw-1.relay.example.com","secure":false,"mgmtToken":"mobile","chatToken":"mobile","relayCredential":"cred-xyz"}""",
            ).isFailure,
        )
    }

    @Test fun rejectsV2WithDifferentMobileTokens() {
        assertTrue(
            PairingPayload.parse(
                """{"v":2,"host":"gw-1.relay.example.com","secure":true,"mgmtToken":"mobile-a","chatToken":"mobile-b","relayCredential":"cred-xyz"}""",
            ).isFailure,
        )
    }

    @Test fun rejectsMissingMgmtToken() {
        assertTrue(
            PairingPayload.parse(
                """{"v":3,"host":"h","chatToken":"c","mgmtPort":9400,"chatPort":9400,"secure":true,"tlsCertificateSha256":"$certificateSha256"}""",
            ).isFailure,
        )
    }

    @Test fun rejectsBlankHost() {
        assertTrue(
            PairingPayload.parse(
                """{"v":3,"host":"","mgmtToken":"mobile","chatToken":"mobile","mgmtPort":9400,"chatPort":9400,"secure":true,"tlsCertificateSha256":"$certificateSha256"}""",
            ).isFailure,
        )
    }

    @Test fun rejectsNonJson() {
        assertTrue(PairingPayload.parse("definitely not json").isFailure)
    }

    @Test fun ignoresUnknownFields() {
        val p = PairingPayload.parse(
            """{"v":3,"host":"h","mgmtToken":"mobile","chatToken":"mobile","mgmtPort":9400,"chatPort":9400,"secure":true,"tlsCertificateSha256":"$certificateSha256","futureField":"x"}""",
        ).getOrThrow()
        assertEquals("h", p.host)
    }
}
