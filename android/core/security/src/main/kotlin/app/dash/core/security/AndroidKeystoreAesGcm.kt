package app.dash.core.security

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.GeneralSecurityException
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal class MissingKeystoreKey : GeneralSecurityException("keystore alias is missing")
internal class MalformedSecretEnvelope : GeneralSecurityException("secret envelope is malformed")

internal interface AesGcm {
  fun hasExistingKey(): Boolean
  fun deleteExistingKey()
  fun encrypt(recordKey: String, plaintext: ByteArray, allowKeyCreation: Boolean): ByteArray
  fun decrypt(recordKey: String, envelope: ByteArray): ByteArray
}

internal class AndroidKeystoreAesGcm(
  private val alias: String = KEY_ALIAS,
) : AesGcm {
  override fun hasExistingKey(): Boolean = existingKeyOrNull() != null

  override fun deleteExistingKey() {
    KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(alias)
  }

  override fun encrypt(
    recordKey: String,
    plaintext: ByteArray,
    allowKeyCreation: Boolean,
  ): ByteArray {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, keyForEncryption(allowKeyCreation))
    cipher.updateAAD(recordKey.encodeToByteArray())
    val iv = cipher.iv.also { require(it.size == 12) { "AES-GCM IV must be 12 bytes" } }
    return byteArrayOf(1) + iv + cipher.doFinal(plaintext)
  }

  override fun decrypt(recordKey: String, envelope: ByteArray): ByteArray {
    val key = existingKey()
    if (envelope.size <= 29 || envelope[0] != 1.toByte()) throw MalformedSecretEnvelope()
    val iv = envelope.copyOfRange(1, 13)
    val ciphertext = envelope.copyOfRange(13, envelope.size)
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, iv))
    cipher.updateAAD(recordKey.encodeToByteArray())
    return cipher.doFinal(ciphertext)
  }

  private fun keyForEncryption(allowKeyCreation: Boolean): SecretKey {
    existingKeyOrNull()?.let { return it }
    if (!allowKeyCreation) throw MissingKeystoreKey()
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    generator.init(
      KeyGenParameterSpec.Builder(
        alias,
        KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
      ).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .setRandomizedEncryptionRequired(true)
        .build(),
    )
    return generator.generateKey()
  }

  private fun existingKey(): SecretKey = existingKeyOrNull() ?: throw MissingKeystoreKey()

  private fun existingKeyOrNull(): SecretKey? =
    (KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.getKey(alias, null) as? SecretKey)

  companion object {
    const val KEY_ALIAS = "app.dash.android.secrets.v1"
  }
}
