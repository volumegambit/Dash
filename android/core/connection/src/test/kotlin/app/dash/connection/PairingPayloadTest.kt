package app.dash.connection

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingPayloadTest {
    @Test fun parsesValidPayloadWithDefaults() {
        val p = PairingPayload.parse(
            """{"v":1,"host":"10.0.0.5","mgmtToken":"m","chatToken":"c"}""",
        ).getOrThrow()
        assertEquals("10.0.0.5", p.host)
        assertEquals(9300, p.mgmtPort)
        assertEquals(9200, p.chatPort)
        assertEquals("10.0.0.5", p.label) // defaults to host
        assertTrue(!p.secure)
    }

    @Test fun honorsCustomPortsLabelAndSecure() {
        val p = PairingPayload.parse(
            """{"v":1,"host":"h","mgmtToken":"m","chatToken":"c","mgmtPort":1,"chatPort":2,"label":"Office","secure":true}""",
        ).getOrThrow()
        assertEquals(1, p.mgmtPort)
        assertEquals(2, p.chatPort)
        assertEquals("Office", p.label)
        assertTrue(p.secure)
    }

    @Test fun rejectsUnsupportedVersion() {
        assertTrue(PairingPayload.parse("""{"v":2,"host":"h","mgmtToken":"m","chatToken":"c"}""").isFailure)
    }

    @Test fun rejectsMissingMgmtToken() {
        assertTrue(PairingPayload.parse("""{"v":1,"host":"h","chatToken":"c"}""").isFailure)
    }

    @Test fun rejectsBlankHost() {
        assertTrue(PairingPayload.parse("""{"v":1,"host":"","mgmtToken":"m","chatToken":"c"}""").isFailure)
    }

    @Test fun rejectsNonJson() {
        assertTrue(PairingPayload.parse("definitely not json").isFailure)
    }

    @Test fun ignoresUnknownFields() {
        val p = PairingPayload.parse(
            """{"v":1,"host":"h","mgmtToken":"m","chatToken":"c","futureField":"x"}""",
        ).getOrThrow()
        assertEquals("h", p.host)
    }
}
