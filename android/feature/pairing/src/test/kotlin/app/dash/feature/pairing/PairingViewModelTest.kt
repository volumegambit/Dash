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

    private val validQr = """{"v":1,"host":"10.0.0.5","mgmtToken":"m","chatToken":"c"}"""

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
        vm.submitManual(host = "", mgmtToken = "m", chatToken = "c")
        assertTrue(vm.state.value is PairingUiState.Error)
    }

    @Test fun manualValidEntryPairs() = runTest(mainRule.dispatcher) {
        val saved = mutableListOf<ConnectionProfile>()
        val vm = PairingViewModel(saveProfile = { saved += it }, healthCheck = { true })
        vm.submitManual(host = "1.2.3.4", mgmtToken = "m", chatToken = "c")
        advanceUntilIdle()
        assertEquals(PairingUiState.Paired, vm.state.value)
        assertEquals("1.2.3.4", saved.single().host)
    }
}
