package app.dash.core.security

import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import java.util.Base64
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

@Serializable
private data class ApprovalEd25519Vector(
  val version: Int,
  val algorithm: String,
  val outputPrefix: String,
  val seedBase64Url: String,
  val publicKeyBase64Url: String,
  val approvalId: String,
  val pairingId: String,
  val decision: String,
  val messageUtf8Base64Url: String,
  val signatureBase64Url: String,
)

class TinkEd25519VectorTest {
  @Test
  fun dashApprovalVectorMatchesRfc8032Seed() {
    val vector = resourceVector("approval-ed25519-v1.json")
    val seed = vector.seedBase64Url.base64UrlBytes()
    val pair = Ed25519Sign.KeyPair.newKeyPairFromSeed(seed)
    val message = SignerIdentityEncoding.approvalMessage(
      vector.approvalId,
      vector.pairingId,
      vector.decision,
    )
    val signature = Ed25519Sign(pair.privateKey).sign(message)

    assertEquals(1, vector.version)
    assertEquals("Ed25519", vector.algorithm)
    assertEquals("RAW", vector.outputPrefix)
    assertArrayEquals(vector.messageUtf8Base64Url.base64UrlBytes(), message)
    assertEquals(vector.messageUtf8Base64Url, SignerIdentityEncoding.base64Url(message))
    assertEquals(32, pair.publicKey.size)
    assertEquals(64, signature.size)
    assertArrayEquals(vector.publicKeyBase64Url.base64UrlBytes(), pair.publicKey)
    assertArrayEquals(vector.signatureBase64Url.base64UrlBytes(), signature)
    assertEquals(vector.publicKeyBase64Url, SignerIdentityEncoding.base64Url(pair.publicKey))
    assertEquals(vector.signatureBase64Url, SignerIdentityEncoding.base64Url(signature))
    Ed25519Verify(pair.publicKey).verify(signature, message)
  }

  @Test
  fun generatedTinkKeysetHasRawPublicKeyAndRawSignature() {
    val serialized = TinkEd25519.generateSerializedKeyset()
    val message = "dash".encodeToByteArray()
    val signature = TinkEd25519.sign(serialized, message)
    val rawPublicKey = TinkEd25519.rawPublicKey(serialized)
    assertEquals(64, signature.size)
    assertEquals(32, rawPublicKey.size)
    Ed25519Verify(rawPublicKey).verify(signature, message)
    TinkEd25519.verify(serialized, signature, message)
  }

  private fun resourceVector(name: String): ApprovalEd25519Vector {
    val resource = requireNotNull(javaClass.classLoader?.getResource(name))
    return Json.decodeFromString(resource.readText())
  }
}

private fun String.base64UrlBytes(): ByteArray = Base64.getUrlDecoder().decode(this)
