package app.dash.feature.pairing

import app.dash.connection.ConnectionProfile
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class PairingViewModelTest {
    @get:Rule val mainRule = MainDispatcherRule()

    private val certificateSha256 =
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    private val validQr =
        """{"v":3,"host":"10.0.0.5","mgmtToken":"mobile","chatToken":"mobile","mgmtPort":9400,"chatPort":9400,"secure":true,"tlsCertificateSha256":"$certificateSha256"}"""

    @Test fun scannedValidPayloadOnHealthyGatewayPairs() = runTest(mainRule.dispatcher) {
        val saved = mutableListOf<ConnectionProfile>()
        val vm = PairingViewModel(saveProfile = { saved += it }, healthCheck = { true })
        vm.submitScanned(validQr)
        advanceUntilIdle()
        assertEquals(PairingUiState.Paired, vm.state.value)
        assertEquals("10.0.0.5", saved.single().host)
    }

    @Test fun unhealthyGatewayErrorsAndDoesNotSave() = runTest(mainRule.dispatcher) {
        val saved = mutableListOf<ConnectionProfile>()
        val vm = PairingViewModel(saveProfile = { saved += it }, healthCheck = { false })
        vm.submitScanned(validQr)
        advanceUntilIdle()
        assertTrue(vm.state.value is PairingUiState.Error)
        assertTrue(saved.isEmpty())
    }

    @Test fun malformedPayloadErrors() = runTest(mainRule.dispatcher) {
        val vm = PairingViewModel(saveProfile = { }, healthCheck = { true })
        vm.submitScanned("not a qr code")
        advanceUntilIdle()
        assertTrue(vm.state.value is PairingUiState.Error)
    }

    @Test fun manualBlankFieldsError() = runTest(mainRule.dispatcher) {
        val vm = PairingViewModel(saveProfile = { }, healthCheck = { true })
        vm.submitManual(
            host = "",
            mobileToken = "mobile",
            tlsCertificateSha256 = certificateSha256,
        )
        assertTrue(vm.state.value is PairingUiState.Error)
    }

    @Test fun manualMissingCertificatePinErrors() = runTest(mainRule.dispatcher) {
        var healthChecks = 0
        val vm = PairingViewModel(
            saveProfile = { },
            healthCheck = {
                healthChecks++
                true
            },
        )
        vm.submitManual(
            host = "1.2.3.4",
            mobileToken = "mobile",
            tlsCertificateSha256 = "",
        )
        advanceUntilIdle()
        assertTrue(vm.state.value is PairingUiState.Error)
        assertEquals(0, healthChecks)
    }

    @Test fun manualMalformedCertificatePinErrors() = runTest(mainRule.dispatcher) {
        val vm = PairingViewModel(saveProfile = { }, healthCheck = { true })
        vm.submitManual(
            host = "1.2.3.4",
            mobileToken = "mobile",
            tlsCertificateSha256 = "not-a-sha256",
        )
        assertTrue(vm.state.value is PairingUiState.Error)
    }

    @Test fun manualHostOutsideContractGrammarErrorsBeforeHealthCheck() =
        runTest(mainRule.dispatcher) {
            var healthChecks = 0
            val vm = PairingViewModel(
                saveProfile = { },
                healthCheck = {
                    healthChecks++
                    true
                },
            )
            vm.submitManual(
                host = "https://gateway.example",
                mobileToken = "mobile",
                tlsCertificateSha256 = certificateSha256,
            )
            advanceUntilIdle()
            assertTrue(vm.state.value is PairingUiState.Error)
            assertEquals(0, healthChecks)
        }

    @Test fun manualValidEntryPairs() = runTest(mainRule.dispatcher) {
        val saved = mutableListOf<ConnectionProfile>()
        val vm = PairingViewModel(saveProfile = { saved += it }, healthCheck = { true })
        vm.submitManual(
            host = "1.2.3.4",
            mobileToken = "mobile-capability",
            tlsCertificateSha256 = "  ${certificateSha256.uppercase()}  ",
        )
        advanceUntilIdle()
        assertEquals(PairingUiState.Paired, vm.state.value)
        assertEquals("1.2.3.4", saved.single().host)
        assertEquals(9400, saved.single().mgmtPort)
        assertEquals(9400, saved.single().chatPort)
        assertTrue(saved.single().secure)
        assertEquals("mobile-capability", saved.single().mgmtToken)
        assertEquals("mobile-capability", saved.single().chatToken)
        assertEquals(certificateSha256, saved.single().tlsCertificateSha256)
    }
}
