package app.dash.feature.pairing

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.dash.connection.ConnectionProfile
import app.dash.connection.PairingPayload
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

sealed interface PairingUiState {
    data object Idle : PairingUiState
    data object Validating : PairingUiState
    data class Error(val message: String) : PairingUiState
    data object Paired : PairingUiState
}

/**
 * Validates a pairing target (scanned QR or manual entry) by reaching the
 * gateway's health endpoint, then persists it. Dependencies are functional
 * seams so the VM stays Android-free and unit-testable.
 */
class PairingViewModel(
    private val saveProfile: suspend (ConnectionProfile) -> Unit,
    private val healthCheck: suspend (ConnectionProfile) -> Boolean,
) : ViewModel() {
    private val _state = MutableStateFlow<PairingUiState>(PairingUiState.Idle)
    val state: StateFlow<PairingUiState> = _state.asStateFlow()

    fun submitScanned(raw: String) {
        PairingPayload.parse(raw).fold(
            onSuccess = { pairAndSave(it) },
            onFailure = { _state.value = PairingUiState.Error(it.message ?: "Invalid pairing code") },
        )
    }

    fun submitManual(host: String, mgmtToken: String, chatToken: String, label: String? = null) {
        if (host.isBlank() || mgmtToken.isBlank() || chatToken.isBlank()) {
            _state.value = PairingUiState.Error("Host and both tokens are required")
            return
        }
        pairAndSave(
            ConnectionProfile(
                label = label?.takeIf { it.isNotBlank() } ?: host.trim(),
                host = host.trim(),
                mgmtToken = mgmtToken.trim(),
                chatToken = chatToken.trim(),
            ),
        )
    }

    fun reset() {
        _state.value = PairingUiState.Idle
    }

    private fun pairAndSave(profile: ConnectionProfile) {
        _state.value = PairingUiState.Validating
        viewModelScope.launch {
            val reachable = try {
                healthCheck(profile)
            } catch (_: Exception) {
                false
            }
            if (!reachable) {
                _state.value = PairingUiState.Error("Could not reach gateway at ${profile.host}")
                return@launch
            }
            saveProfile(profile)
            _state.value = PairingUiState.Paired
        }
    }
}
