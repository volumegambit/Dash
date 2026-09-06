package app.dash.core.security

import app.dash.core.contracts.GatewayScope
import java.util.Base64
import kotlinx.serialization.Serializable

@Serializable
data class StoredSigner(val serializedPrivateKeyset: ByteArray, val signerId: String?) {
  override fun toString(): String =
    "StoredSigner(serializedPrivateKeyset=<redacted>, signerId=$signerId)"
}

@Serializable
data class GatewayCredential(
  val scope: GatewayScope,
  val pairingId: String,
  val bearerToken: String,
  val relayCredential: String,
) {
  override fun toString(): String =
    "GatewayCredential(scope=$scope, pairingId=$pairingId, " +
      "bearerToken=<redacted>, relayCredential=<redacted>)"
}

internal object SecretRecordKeys {
  const val SIGNER = "signer"

  fun gateway(scope: GatewayScope): String =
    "gateway:${component(scope.accountScope.value)}:${component(scope.gatewayId)}"

  private fun component(value: String): String =
    Base64.getUrlEncoder().withoutPadding().encodeToString(value.encodeToByteArray())
}

sealed class SecretFailure(message: String) : Exception(message) {
  data class Unrecoverable(val recordKey: String) : SecretFailure("secret record is unrecoverable")
  data class Persistence(val operation: String) : SecretFailure("secret persistence failed")
}

interface SecretStore {
  suspend fun readSigner(): StoredSigner?
  suspend fun writeSigner(signer: StoredSigner)
  suspend fun clearSigner()
  suspend fun readGatewayCredential(scope: GatewayScope): GatewayCredential?
  suspend fun writeGatewayCredential(credential: GatewayCredential)
  suspend fun deleteGatewayCredential(scope: GatewayScope)
}
