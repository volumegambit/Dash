package app.dash.core.security

import com.google.crypto.tink.InsecureSecretKeyAccess
import com.google.crypto.tink.KeysetHandle
import com.google.crypto.tink.PublicKeySign
import com.google.crypto.tink.PublicKeyVerify
import com.google.crypto.tink.RegistryConfiguration
import com.google.crypto.tink.TinkProtoKeysetFormat
import com.google.crypto.tink.proto.Ed25519PublicKey
import com.google.crypto.tink.proto.Keyset
import com.google.crypto.tink.signature.PredefinedSignatureParameters
import com.google.crypto.tink.signature.SignatureConfig
import java.util.Base64

object TinkEd25519 {
  private val registry = RegistryConfiguration.get()

  init {
    SignatureConfig.register()
  }

  fun generateSerializedKeyset(): ByteArray = serialize(
    KeysetHandle.generateNew(PredefinedSignatureParameters.ED25519WithRawOutput),
  )

  fun sign(serialized: ByteArray, message: ByteArray): ByteArray =
    parse(serialized).getPrimitive(registry, PublicKeySign::class.java).sign(message)

  fun verify(serialized: ByteArray, signature: ByteArray, message: ByteArray) {
    parse(serialized).publicKeysetHandle
      .getPrimitive(registry, PublicKeyVerify::class.java)
      .verify(signature, message)
  }

  fun rawPublicKey(serialized: ByteArray): ByteArray {
    val publicProto = Keyset.parseFrom(
      TinkProtoKeysetFormat.serializeKeysetWithoutSecret(parse(serialized).publicKeysetHandle),
    )
    val only = publicProto.keyList.single()
    return Ed25519PublicKey.parseFrom(only.keyData.value).keyValue.toByteArray().also {
      require(it.size == 32) { "Ed25519 public key must be 32 bytes" }
    }
  }

  private fun serialize(handle: KeysetHandle): ByteArray = TinkProtoKeysetFormat.serializeKeyset(
    handle,
    InsecureSecretKeyAccess.get(),
    registry,
  )

  private fun parse(serialized: ByteArray): KeysetHandle = TinkProtoKeysetFormat.parseKeyset(
    serialized,
    InsecureSecretKeyAccess.get(),
    registry,
  )
}

object SignerIdentityEncoding {
  fun approvalMessage(approvalId: String, pairingId: String, decision: String): ByteArray =
    "$approvalId\n$pairingId\n$decision".toByteArray(Charsets.UTF_8)

  fun base64Url(bytes: ByteArray): String =
    Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
}
