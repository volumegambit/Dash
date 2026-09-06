package app.dash.core.security

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.util.Base64
import app.dash.core.contracts.ContractJson
import app.dash.core.contracts.GatewayScope
import java.security.UnrecoverableKeyException
import javax.crypto.AEADBadTagException
import javax.crypto.BadPaddingException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.SerializationException
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString

class EncryptedSecretStore private constructor(
  private val preferences: SharedPreferences,
  private val aes: AesGcm,
  private val mutex: Mutex,
) : SecretStore {
  private val json = ContractJson.strict

  companion object {
    private const val PREFERENCES_NAME = "dash_encrypted_secrets_v1"
    @Volatile private var instance: EncryptedSecretStore? = null

    fun create(context: Context): EncryptedSecretStore =
      instance ?: synchronized(this) {
        instance
          ?: EncryptedSecretStore(
            context.applicationContext.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE),
            AndroidKeystoreAesGcm(),
            Mutex(),
          ).also { instance = it }
      }

    internal fun createForTest(
      preferences: SharedPreferences,
      aes: AesGcm,
      sharedMutex: Mutex,
    ): EncryptedSecretStore = EncryptedSecretStore(preferences, aes, sharedMutex)
  }

  override suspend fun readSigner(): StoredSigner? = mutex.withLock {
    read(SecretRecordKeys.SIGNER)
  }

  override suspend fun writeSigner(signer: StoredSigner) = mutex.withLock {
    write(SecretRecordKeys.SIGNER, signer)
  }

  override suspend fun clearSigner() = mutex.withLock { remove(SecretRecordKeys.SIGNER) }

  override suspend fun readGatewayCredential(scope: GatewayScope): GatewayCredential? =
    mutex.withLock { read(SecretRecordKeys.gateway(scope)) }

  override suspend fun writeGatewayCredential(credential: GatewayCredential) = mutex.withLock {
    write(SecretRecordKeys.gateway(credential.scope), credential)
  }

  override suspend fun deleteGatewayCredential(scope: GatewayScope) = mutex.withLock {
    remove(SecretRecordKeys.gateway(scope))
  }

  private fun remove(recordKey: String) = checkedCommit("remove:$recordKey") {
    preferences.edit().remove(recordKey)
  }

  private inline fun <reified T> read(recordKey: String): T? {
    val encoded =
      try {
        preferences.getString(recordKey, null)
      } catch (_: RuntimeException) {
        throw SecretFailure.Persistence("read:$recordKey")
      } ?: return null
    val envelope =
      try {
        Base64.decode(encoded, Base64.NO_WRAP)
      } catch (_: IllegalArgumentException) {
        repairUnreadable(recordKey)
      }
    val plaintext =
      try {
        aes.decrypt(recordKey, envelope)
      } catch (failure: Exception) {
        if (failure.isLostKeyFailure()) repairLostKeyEpoch()
        if (failure.isRecordCiphertextFailure()) repairUnreadable(recordKey)
        throw SecretFailure.Persistence("decrypt:$recordKey")
      }
    return try {
      try {
        json.decodeFromString<T>(plaintext.decodeToString())
      } catch (_: SerializationException) {
        repairUnreadable(recordKey)
      } catch (_: IllegalArgumentException) {
        repairUnreadable(recordKey)
      }
    } finally {
      plaintext.fill(0)
    }
  }

  private inline fun <reified T> write(recordKey: String, value: T) {
    val allowKeyCreation = requireWritableKeyEpoch()
    val plaintext =
      try {
        json.encodeToString(value).encodeToByteArray()
      } catch (_: RuntimeException) {
        throw SecretFailure.Persistence("encode:$recordKey")
      }
    try {
      val envelope =
        try {
          aes.encrypt(recordKey, plaintext, allowKeyCreation)
        } catch (_: MissingKeystoreKey) {
          repairLostKeyEpoch()
        } catch (failure: Exception) {
          if (failure.isLostKeyFailure()) repairLostKeyEpoch()
          throw SecretFailure.Persistence("encrypt:$recordKey")
        }
      checkedCommit("write:$recordKey") {
        preferences.edit().putString(recordKey, Base64.encodeToString(envelope, Base64.NO_WRAP))
      }
    } finally {
      plaintext.fill(0)
    }
  }

  private fun repairUnreadable(recordKey: String): Nothing {
    checkedCommit("repair:$recordKey") { preferences.edit().remove(recordKey) }
    throw SecretFailure.Unrecoverable(recordKey)
  }

  private fun requireWritableKeyEpoch(): Boolean {
    val keyExists =
      try {
        aes.hasExistingKey()
      } catch (failure: Exception) {
        if (failure.isLostKeyFailure()) repairLostKeyEpoch()
        throw SecretFailure.Persistence("inspect:keystore")
      }
    if (keyExists) return false
    val staleKeys = encryptedRecordKeys()
    if (staleKeys.isEmpty()) return true
    checkedCommit("repair:key-loss") {
      preferences.edit().also { editor -> staleKeys.forEach { editor.remove(it) } }
    }
    throw SecretFailure.Unrecoverable(staleKeys.first())
  }

  private fun repairLostKeyEpoch(): Nothing {
    val staleKeys = encryptedRecordKeys()
    try {
      aes.deleteExistingKey()
    } catch (_: Exception) {
      throw SecretFailure.Persistence("repair:keystore")
    }
    if (staleKeys.isNotEmpty()) {
      checkedCommit("repair:key-loss") {
        preferences.edit().also { editor -> staleKeys.forEach { editor.remove(it) } }
      }
    }
    throw SecretFailure.Unrecoverable(staleKeys.firstOrNull() ?: "keystore")
  }

  private fun encryptedRecordKeys(): List<String> =
    try {
      preferences.all.keys.sorted()
    } catch (_: RuntimeException) {
      throw SecretFailure.Persistence("inspect:key-loss")
    }

  private inline fun checkedCommit(
    operation: String,
    edit: () -> SharedPreferences.Editor,
  ) {
    val committed =
      try {
        edit().commit()
      } catch (_: RuntimeException) {
        false
      }
    if (!committed) throw SecretFailure.Persistence(operation)
  }
}

private fun Throwable.isLostKeyFailure(): Boolean =
  generateSequence(this) { it.cause }.any { cause ->
    cause is MissingKeystoreKey ||
      cause is KeyPermanentlyInvalidatedException ||
      cause is UnrecoverableKeyException
  }

private fun Throwable.isRecordCiphertextFailure(): Boolean =
  generateSequence(this) { it.cause }.any { cause ->
    cause is MalformedSecretEnvelope ||
      cause is AEADBadTagException ||
      cause is BadPaddingException
  }
