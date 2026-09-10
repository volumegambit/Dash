package app.dash.feature.pairing

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.dash.connection.ConnectionProfile
import app.dash.connection.PairingPayload
import app.dash.connection.TlsCertificatePin
import app.dash.network.GatewayNegotiation
import kotlinx.coroutines.CancellationException
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
    private val negotiate: suspend (ConnectionProfile) -> GatewayNegotiation,
    private val legacyHealthCheck: suspend (ConnectionProfile) -> Boolean,
) : ViewModel() {
    private val _state = MutableStateFlow<PairingUiState>(PairingUiState.Idle)
    val state: StateFlow<PairingUiState> = _state.asStateFlow()

    fun submitScanned(raw: String) {
        PairingPayload.parse(raw).fold(
            onSuccess = { pairAndSave(it) },
            onFailure = { _state.value = PairingUiState.Error(it.message ?: "Invalid pairing code") },
        )
    }

    fun submitManual(
        host: String,
        mobileToken: String,
        tlsCertificateSha256: String,
        label: String? = null,
    ) {
        val normalizedHost = host.trim()
        if (
            normalizedHost.isBlank() ||
            mobileToken.isBlank() ||
            tlsCertificateSha256.isBlank()
        ) {
            _state.value = PairingUiState.Error(
                "Host, mobile token, and the certificate SHA-256 are required",
            )
            return
        }
        if (!PairingPayload.isValidHost(normalizedHost)) {
            _state.value = PairingUiState.Error("Enter a host or IP without a URL scheme or path")
            return
        }
        val normalizedCertificateSha256 = TlsCertificatePin.normalize(tlsCertificateSha256)
        if (normalizedCertificateSha256 == null) {
            _state.value = PairingUiState.Error(
                "Certificate SHA-256 must be 64 hexadecimal characters",
            )
            return
        }
        pairAndSave(
            ConnectionProfile(
                label = label?.takeIf { it.isNotBlank() } ?: normalizedHost,
                host = normalizedHost,
                mgmtPort = ConnectionProfile.DEFAULT_PINNED_LAN_PORT,
                chatPort = ConnectionProfile.DEFAULT_PINNED_LAN_PORT,
                mgmtToken = mobileToken.trim(),
                chatToken = mobileToken.trim(),
                secure = true,
                tlsCertificateSha256 = normalizedCertificateSha256,
            ),
        )
    }

    fun reset() {
        _state.value = PairingUiState.Idle
    }

    private fun pairAndSave(profile: ConnectionProfile) {
        _state.value = PairingUiState.Validating
        viewModelScope.launch {
            val negotiation = try {
                negotiate(profile)
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                _state.value = PairingUiState.Error(
                    error.message ?: "Could not negotiate with gateway at ${profile.host}",
                )
                return@launch
            }

            val verifiedProfile = when (negotiation) {
                is GatewayNegotiation.V2 -> {
                    if (REQUIRED_V2_CAPABILITY !in negotiation.capabilities) {
                        _state.value = PairingUiState.Error(
                            "Mobile API v2 omitted required capability $REQUIRED_V2_CAPABILITY",
                        )
                        return@launch
                    }
                    profile.copy(gatewayId = negotiation.gatewayId)
                }
                GatewayNegotiation.UnsupportedVersion -> {
                    val reachable = try {
                        legacyHealthCheck(profile)
                    } catch (error: CancellationException) {
                        throw error
                    } catch (_: Exception) {
                        false
                    }
                    if (!reachable) {
                        _state.value = PairingUiState.Error(
                            "Could not reach gateway at ${profile.host}",
                        )
                        return@launch
                    }
                    profile.copy(gatewayId = null)
                }
                is GatewayNegotiation.Failed -> {
                    _state.value = PairingUiState.Error(negotiation.userMessage())
                    return@launch
                }
            }

            try {
                saveProfile(verifiedProfile)
                _state.value = PairingUiState.Paired
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                _state.value = PairingUiState.Error(
                    error.message ?: "Could not save the gateway profile",
                )
            }
        }
    }

    private fun GatewayNegotiation.Failed.userMessage(): String = when (this) {
        is GatewayNegotiation.Failed.Authentication ->
            "Gateway authentication failed (HTTP $status)"
        is GatewayNegotiation.Failed.Malformed -> message
        is GatewayNegotiation.Failed.Api -> error.error
        is GatewayNegotiation.Failed.Transport ->
            cause.message ?: "Could not reach gateway"
    }

    private companion object {
        const val REQUIRED_V2_CAPABILITY = "chat-input-queue-v1"
    }
}
