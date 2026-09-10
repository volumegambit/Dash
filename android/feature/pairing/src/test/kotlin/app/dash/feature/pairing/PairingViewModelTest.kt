package app.dash.feature.pairing

import app.dash.connection.ConnectionProfile
import app.dash.network.GatewayNegotiation
import java.io.IOException
import kotlinx.coroutines.CancellationException
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

    private fun viewModel(
        saveProfile: suspend (ConnectionProfile) -> Unit = {},
        negotiation: GatewayNegotiation = GatewayNegotiation.UnsupportedVersion,
        legacyHealthCheck: suspend (ConnectionProfile) -> Boolean = { true },
    ) = PairingViewModel(
        saveProfile = saveProfile,
        negotiate = { negotiation },
        legacyHealthCheck = legacyHealthCheck,
    )

    @Test fun scannedValidPayloadOnHealthyGatewayPairs() = runTest(mainRule.dispatcher) {
        val saved = mutableListOf<ConnectionProfile>()
        val vm = viewModel(saveProfile = { saved += it })
        vm.submitScanned(validQr)
        advanceUntilIdle()
        assertEquals(PairingUiState.Paired, vm.state.value)
        assertEquals("10.0.0.5", saved.single().host)
    }

    @Test fun unhealthyGatewayErrorsAndDoesNotSave() = runTest(mainRule.dispatcher) {
        val saved = mutableListOf<ConnectionProfile>()
        val vm = viewModel(saveProfile = { saved += it }, legacyHealthCheck = { false })
        vm.submitScanned(validQr)
        advanceUntilIdle()
        assertTrue(vm.state.value is PairingUiState.Error)
        assertTrue(saved.isEmpty())
    }

    @Test fun malformedPayloadErrors() = runTest(mainRule.dispatcher) {
        val vm = viewModel()
        vm.submitScanned("not a qr code")
        advanceUntilIdle()
        assertTrue(vm.state.value is PairingUiState.Error)
    }

    @Test fun manualBlankFieldsError() = runTest(mainRule.dispatcher) {
        val vm = viewModel()
        vm.submitManual(
            host = "",
            mobileToken = "mobile",
            tlsCertificateSha256 = certificateSha256,
        )
        assertTrue(vm.state.value is PairingUiState.Error)
    }

    @Test fun manualMissingCertificatePinErrors() = runTest(mainRule.dispatcher) {
        var healthChecks = 0
        val vm = viewModel(
            legacyHealthCheck = {
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
        val vm = viewModel()
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
            val vm = viewModel(
                legacyHealthCheck = {
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
        val vm = viewModel(saveProfile = { saved += it })
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
        assertEquals(null, saved.single().gatewayId)
    }

    @Test fun successfulV2PairingPersistsVerifiedGatewayIdWithoutLegacyCall() =
        runTest(mainRule.dispatcher) {
            val saved = mutableListOf<ConnectionProfile>()
            var legacyCalls = 0
            val vm = viewModel(
                saveProfile = { saved += it },
                negotiation = GatewayNegotiation.V2(
                    "gw-1",
                    setOf("chat-input-queue-v1", "future"),
                ),
                legacyHealthCheck = {
                    legacyCalls++
                    true
                },
            )

            vm.submitScanned(validQr)
            advanceUntilIdle()

            assertEquals(PairingUiState.Paired, vm.state.value)
            assertEquals("gw-1", saved.single().gatewayId)
            assertEquals(0, legacyCalls)
        }

    @Test fun unsupportedV2UsesLegacyHealthAndPersistsExplicitV1Fallback() =
        runTest(mainRule.dispatcher) {
            val saved = mutableListOf<ConnectionProfile>()
            var legacyCalls = 0
            val vm = viewModel(
                saveProfile = { saved += it },
                legacyHealthCheck = {
                    legacyCalls++
                    true
                },
            )

            vm.submitScanned(validQr)
            advanceUntilIdle()

            assertEquals(1, legacyCalls)
            assertEquals(null, saved.single().gatewayId)
        }

    @Test fun failedOrCapabilityMissingV2NeverFallsBackOrSaves() =
        runTest(mainRule.dispatcher) {
            val outcomes = listOf<GatewayNegotiation>(
                GatewayNegotiation.V2("gw-1", setOf("future")),
                GatewayNegotiation.Failed.Authentication(401, "unauthorized"),
                GatewayNegotiation.Failed.Malformed("bad identity"),
                GatewayNegotiation.Failed.Transport(IOException("offline")),
            )
            outcomes.forEach { outcome ->
                val saved = mutableListOf<ConnectionProfile>()
                var legacyCalls = 0
                val vm = viewModel(
                    saveProfile = { saved += it },
                    negotiation = outcome,
                    legacyHealthCheck = {
                        legacyCalls++
                        true
                    },
                )
                vm.submitScanned(validQr)
                advanceUntilIdle()
                assertTrue(outcome.toString(), vm.state.value is PairingUiState.Error)
                assertTrue(saved.isEmpty())
                assertEquals(0, legacyCalls)
            }
        }

    @Test fun cancellationPerformsNoFallbackOrProfileSave() = runTest(mainRule.dispatcher) {
        val saved = mutableListOf<ConnectionProfile>()
        var legacyCalls = 0
        val vm = PairingViewModel(
            saveProfile = { saved += it },
            negotiate = { throw CancellationException("cancelled") },
            legacyHealthCheck = {
                legacyCalls++
                true
            },
        )
        vm.submitScanned(validQr)
        advanceUntilIdle()
        assertTrue(saved.isEmpty())
        assertEquals(0, legacyCalls)
    }
}
