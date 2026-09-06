package app.dash.core.security

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.util.Base64
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.dash.core.contracts.AccountScope
import app.dash.core.contracts.ContractJson
import app.dash.core.contracts.GatewayScope
import java.io.File
import java.security.GeneralSecurityException
import java.security.InvalidKeyException
import java.security.KeyStore
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.jsonObject
import org.junit.After
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AndroidKeystoreSecretStoreTest {
  @Before
  fun resetSecretFixture() {
    check(realBackingPreferences().edit().clear().commit())
    deleteTestAlias()
  }

  @After
  fun clearSecretFixture() {
    check(realBackingPreferences().edit().clear().commit())
    deleteTestAlias()
  }

  @Test
  fun secretsRoundTripAndDecodedEnvelopesDoNotContainSerializedPlaintext() = runTest {
    val store = instrumentedSecretStore()
    val scope = GatewayScope(AccountScope("acct"), "gateway-a")
    val signer =
      StoredSigner(
        "private-keyset-plaintext-sentinel-0123456789".encodeToByteArray(),
        "signer-a",
      )
    val credential =
      GatewayCredential(
        scope,
        "pairing-a",
        "bearer-plaintext-sentinel-0123456789",
        "relay-plaintext-sentinel-9876543210",
      )
    store.writeSigner(signer)
    store.writeGatewayCredential(credential)
    val reopened = instrumentedSecretStore()
    val restoredSigner = requireNotNull(reopened.readSigner())
    assertArrayEquals(signer.serializedPrivateKeyset, restoredSigner.serializedPrivateKeyset)
    assertEquals(signer.signerId, restoredSigner.signerId)
    assertEquals(credential, reopened.readGatewayCredential(scope))
    assertFalse(credential.toString().contains(credential.bearerToken))
    assertFalse(credential.toString().contains(credential.relayCredential))
    assertFalse(signer.toString().contains("private-keyset"))

    val signerEnvelope = decodedStoredEnvelope(SecretRecordKeys.SIGNER)
    val credentialEnvelope = decodedStoredEnvelope(SecretRecordKeys.gateway(scope))
    assertFalse(signerEnvelope.containsSubsequence(secretJsonBytes(signer)))
    assertFalse(
      signerEnvelope.containsSubsequence(
        serializedJsonFieldBytes(signer, "serializedPrivateKeyset"),
      ),
    )
    assertFalse(credentialEnvelope.containsSubsequence(secretJsonBytes(credential)))
    assertFalse(credentialEnvelope.containsSubsequence(credential.bearerToken.encodeToByteArray()))
    assertFalse(credentialEnvelope.containsSubsequence(credential.relayCredential.encodeToByteArray()))
    assertFalse(rawPreferenceXml().contains(credential.bearerToken))
    assertFalse(rawPreferenceXml().contains(credential.relayCredential))
  }

  @Test
  fun ciphertextCannotBeMovedBetweenRecordKeys() = runTest {
    val aes = testAesGcm()
    val scopeA = GatewayScope(AccountScope("acct"), "gateway-a")
    val scopeB = GatewayScope(AccountScope("acct"), "gateway-b")
    val keyA = SecretRecordKeys.gateway(scopeA)
    val keyB = SecretRecordKeys.gateway(scopeB)
    val sameTypedPlaintext =
      secretJsonBytes(
        GatewayCredential(
          scopeA,
          "pairing-a",
          "bearer-a",
          "relay-a",
        ),
      )
    val envelope =
      try {
        aes.encrypt(keyA, sameTypedPlaintext, allowKeyCreation = true)
      } finally {
        sameTypedPlaintext.fill(0)
      }
    try {
      aes.decrypt(keyB, envelope)
      throw AssertionError("expected AAD authentication failure")
    } catch (_: GeneralSecurityException) {}

    val store = instrumentedSecretStore()
    store.writeGatewayCredential(
      GatewayCredential(scopeA, "pairing-a", "bearer-a", "relay-a"),
    )
    copyCiphertext(keyA, keyB)
    try {
      store.readGatewayCredential(scopeB)
      throw AssertionError("expected unrecoverable ciphertext")
    } catch (_: SecretFailure.Unrecoverable) {}
    assertNull(rawEncryptedRecord(keyB))
    assertNotNull(rawEncryptedRecord(keyA))
  }

  @Test
  fun deletionIsDurableAndScopedToTheRequestedRecord() = runTest {
    val store = instrumentedSecretStore()
    val scopeA = GatewayScope(AccountScope("acct"), "gateway-a")
    val scopeB = GatewayScope(AccountScope("acct"), "gateway-b")
    store.writeSigner(StoredSigner(byteArrayOf(1, 2, 3), "signer-a"))
    store.writeGatewayCredential(
      GatewayCredential(scopeA, "pairing-a", "bearer-a", "relay-a"),
    )
    store.writeGatewayCredential(
      GatewayCredential(scopeB, "pairing-b", "bearer-b", "relay-b"),
    )

    store.clearSigner()
    store.deleteGatewayCredential(scopeA)

    assertEquals(setOf(SecretRecordKeys.gateway(scopeB)), rawPreferenceKeysFromDisk())
    val reopened = instrumentedSecretStore()
    assertNull(reopened.readSigner())
    assertNull(reopened.readGatewayCredential(scopeA))
    assertEquals(scopeB, requireNotNull(reopened.readGatewayCredential(scopeB)).scope)
  }

  @Test
  fun missingKeystoreAliasDeletesUnreadableCiphertext() = runTest {
    val store = instrumentedSecretStore()
    store.writeSigner(StoredSigner(byteArrayOf(1, 2, 3), "signer-a"))
    val scope = GatewayScope(AccountScope("acct"), "gateway-a")
    store.writeGatewayCredential(
      GatewayCredential(scope, "pairing-a", "bearer-a", "relay-a"),
    )
    deleteTestAlias()
    try {
      store.readSigner()
      throw AssertionError("expected missing-key failure")
    } catch (_: SecretFailure.Unrecoverable) {}
    assertTrue(allEncryptedRecords().isEmpty())
  }

  @Test
  fun writeAfterAliasLossPurgesStaleCiphertextWithoutSilentlyMintingAKey() = runTest {
    val store = instrumentedSecretStore()
    val scope = GatewayScope(AccountScope("acct"), "gateway-a")
    store.writeGatewayCredential(
      GatewayCredential(scope, "pairing-a", "bearer-a", "relay-a"),
    )
    deleteTestAlias()

    try {
      store.writeSigner(StoredSigner(byteArrayOf(1, 2, 3), null))
      throw AssertionError("expected explicit key-loss repair")
    } catch (_: SecretFailure.Unrecoverable) {}

    assertFalse(testAliasExists())
    assertTrue(allEncryptedRecords().isEmpty())
    store.writeSigner(StoredSigner(byteArrayOf(4, 5, 6), null))
    assertTrue(testAliasExists())
  }

  @Test
  fun permanentKeyFailureRepairsTheEpochAndAliasDeleteFailureIsSafe() = runTest {
    val repaired = scriptedSecretFixture().also { it.seedSignerAndGateway() }
    repaired.aes.throwOnNextDecrypt(KeyPermanentlyInvalidatedException())
    assertUnrecoverable { repaired.newStore().readSigner() }
    assertTrue(repaired.allEncryptedRecords().isEmpty())

    val blocked = scriptedSecretFixture().also { it.seedSignerAndGateway() }
    blocked.aes.throwOnNextDecrypt(KeyPermanentlyInvalidatedException())
    blocked.aes.throwOnNextDelete(RuntimeException("provider unavailable"))
    assertPersistence("repair:keystore") { blocked.newStore().readSigner() }
    assertTrue(blocked.allEncryptedRecords().isNotEmpty())
  }

  @Test
  fun failedCommitsNeverReportWriteClearOrRepairSuccess() = runTest {
    CommitFailureMode.entries.forEach { mode ->
      CommitOperation.entries.forEach { operation ->
        val fixture = commitFailureFixture(operation)
        fixture.preferences.failNextCommit(mode)
        assertPersistence(operation.expectedLabel(fixture.gatewayScope)) {
          fixture.exercise(operation)
        }
        assertEquals(1, fixture.preferences.failingCommitAttempts)
      }
    }
  }

  @Test
  fun transientReadAndProviderFailuresNeverTriggerDestructiveRepair() = runTest {
    val fixture = scriptedSecretFixture()
    val store = fixture.newStore()
    store.writeSigner(StoredSigner(byteArrayOf(1, 2, 3), "signer-a"))

    fixture.preferences.throwOnNextGet(IllegalArgumentException("transient preferences failure"))
    assertPersistence("read:signer") { store.readSigner() }
    assertNotNull(fixture.rawEncryptedRecord("signer"))

    fixture.aes.throwOnNextDecrypt(InvalidKeyException("generic provider failure"))
    assertPersistence("decrypt:signer") { store.readSigner() }
    assertNotNull(fixture.rawEncryptedRecord("signer"))
  }

  @Test
  fun delimiterContainingScopesHaveDistinctRecordKeysAndAad() {
    val left = GatewayScope(AccountScope("a:b"), "c")
    val right = GatewayScope(AccountScope("a"), "b:c")
    assertNotEquals(SecretRecordKeys.gateway(left), SecretRecordKeys.gateway(right))
  }

  @Test
  fun productionFactoryReturnsOneProcessOwnerForTheFixedEpoch() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext.applicationContext
    assertSame(EncryptedSecretStore.create(context), EncryptedSecretStore.create(context))
  }

  private fun instrumentedSecretStore(): EncryptedSecretStore =
    EncryptedSecretStore.createForTest(
      realBackingPreferences(),
      AndroidKeystoreAesGcm(TEST_KEY_ALIAS),
      sharedMutex,
    )

  private fun testAesGcm(): AesGcm = AndroidKeystoreAesGcm(TEST_KEY_ALIAS)

  private fun copyCiphertext(sourceRecordKey: String, destinationRecordKey: String) {
    check(
      realBackingPreferences()
        .edit()
        .putString(destinationRecordKey, requireNotNull(rawEncryptedRecord(sourceRecordKey)))
        .commit(),
    )
  }

  private fun rawEncryptedRecord(recordKey: String): String? =
    realBackingPreferences().getString(recordKey, null)

  private fun allEncryptedRecords(): Map<String, String> =
    realBackingPreferences().all.mapValues { (_, value) -> value as String }

  private fun scriptedSecretFixture(): ScriptedSecretFixture =
    ScriptedSecretFixture(
      CommitControllableSharedPreferences(
        testContext.getSharedPreferences(
          "dash_encrypted_secrets_scripted_${scriptedFixtureIndex++}",
          Context.MODE_PRIVATE,
        ),
      ),
    )

  private suspend fun commitFailureFixture(
    operation: CommitOperation,
  ): CommitFailureFixture {
    val preferences =
      CommitControllableSharedPreferences(
        testContext.getSharedPreferences(
          "dash_encrypted_secrets_commit_${commitFixtureIndex++}",
          Context.MODE_PRIVATE,
        ),
      )
    check(preferences.edit().clear().commit())
    val fixture = CommitFailureFixture(preferences)
    when (operation) {
      CommitOperation.WriteSigner -> Unit
      CommitOperation.ClearSigner -> fixture.seedSigner()
      CommitOperation.DeleteGatewayCredential -> fixture.seedGateway()
      CommitOperation.RepairUnreadableSigner -> {
        fixture.seedSigner()
        check(preferences.edit().putString(SecretRecordKeys.SIGNER, "%").commit())
      }
      CommitOperation.RepairWholeKeyEpoch -> {
        fixture.seedSigner()
        fixture.seedGateway()
        fixture.aes.loseKey()
      }
    }
    return fixture
  }

  private suspend fun assertUnrecoverable(block: suspend () -> Unit) {
    try {
      block()
      throw AssertionError("expected unrecoverable secret failure")
    } catch (_: SecretFailure.Unrecoverable) {}
  }

  private suspend fun assertPersistence(expectedOperation: String, block: suspend () -> Unit) {
    try {
      block()
      throw AssertionError("expected persistence failure for $expectedOperation")
    } catch (failure: SecretFailure.Persistence) {
      assertEquals(expectedOperation, failure.operation)
    }
  }

  private fun realBackingPreferences(): SharedPreferences =
    testContext.getSharedPreferences(TEST_PREFERENCES_NAME, Context.MODE_PRIVATE)

  private fun deleteTestAlias() {
    KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(TEST_KEY_ALIAS)
  }

  private fun testAliasExists(): Boolean =
    KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.containsAlias(TEST_KEY_ALIAS)

  private fun decodedStoredEnvelope(recordKey: String): ByteArray =
    Base64.decode(requireNotNull(realBackingPreferences().getString(recordKey, null)), Base64.NO_WRAP)

  private inline fun <reified T> secretJsonBytes(value: T): ByteArray =
    ContractJson.strict.encodeToString(value).encodeToByteArray()

  private inline fun <reified T> serializedJsonFieldBytes(value: T, field: String): ByteArray =
    ContractJson.strict
      .parseToJsonElement(ContractJson.strict.encodeToString(value))
      .jsonObject
      .getValue(field)
      .toString()
      .encodeToByteArray()

  private fun ByteArray.containsSubsequence(needle: ByteArray): Boolean =
    needle.isNotEmpty() && indices.any { start ->
      start + needle.size <= size && needle.indices.all { offset -> this[start + offset] == needle[offset] }
    }

  private fun rawPreferenceXml(): String = preferencesFile().readText()

  private fun rawPreferenceKeysFromDisk(): Set<String> =
    Regex("""<string name="([^"]+)"""")
      .findAll(preferencesFile().readText())
      .map { match -> match.groupValues[1] }
      .toSet()

  private fun preferencesFile(): File =
    File(testContext.applicationInfo.dataDir, "shared_prefs/$TEST_PREFERENCES_NAME.xml")

  private val testContext: Context
    get() = InstrumentationRegistry.getInstrumentation().targetContext.applicationContext

  private val sharedMutex = Mutex()
  private var scriptedFixtureIndex = 0
  private var commitFixtureIndex = 0

  private enum class CommitFailureMode {
    ReturnsFalse,
    ThrowsRuntimeException,
  }

  private enum class CommitOperation {
    WriteSigner,
    ClearSigner,
    DeleteGatewayCredential,
    RepairUnreadableSigner,
    RepairWholeKeyEpoch;

    fun expectedLabel(gatewayScope: GatewayScope): String =
      when (this) {
        WriteSigner -> "write:${SecretRecordKeys.SIGNER}"
        ClearSigner -> "remove:${SecretRecordKeys.SIGNER}"
        DeleteGatewayCredential -> "remove:${SecretRecordKeys.gateway(gatewayScope)}"
        RepairUnreadableSigner -> "repair:${SecretRecordKeys.SIGNER}"
        RepairWholeKeyEpoch -> "repair:key-loss"
      }
  }

  private class CommitFailureFixture(
    val preferences: CommitControllableSharedPreferences,
    val aes: ScriptedAesGcm = ScriptedAesGcm(),
    private val sharedMutex: Mutex = Mutex(),
  ) {
    val gatewayScope = GatewayScope(AccountScope("acct"), "gateway-a")

    private fun newStore(): EncryptedSecretStore =
      EncryptedSecretStore.createForTest(preferences, aes, sharedMutex)

    suspend fun seedSigner() {
      newStore().writeSigner(StoredSigner(byteArrayOf(1, 2, 3), "signer-a"))
    }

    suspend fun seedGateway() {
      newStore().writeGatewayCredential(
        GatewayCredential(gatewayScope, "pairing-a", "bearer-a", "relay-a"),
      )
    }

    suspend fun exercise(operation: CommitOperation) {
      val store = newStore()
      when (operation) {
        CommitOperation.WriteSigner ->
          store.writeSigner(StoredSigner(byteArrayOf(4, 5, 6), "signer-b"))
        CommitOperation.ClearSigner -> store.clearSigner()
        CommitOperation.DeleteGatewayCredential -> store.deleteGatewayCredential(gatewayScope)
        CommitOperation.RepairUnreadableSigner -> {
          store.readSigner()
          Unit
        }
        CommitOperation.RepairWholeKeyEpoch -> {
          store.readSigner()
          Unit
        }
      }
    }
  }

  private class CommitControllableSharedPreferences(
    private val delegate: SharedPreferences,
  ) : SharedPreferences by delegate {
    private var nextFailure: CommitFailureMode? = null
    private var nextGetFailure: RuntimeException? = null
    var failingCommitAttempts: Int = 0
      private set

    fun failNextCommit(mode: CommitFailureMode) {
      check(nextFailure == null)
      nextFailure = mode
    }

    fun throwOnNextGet(failure: RuntimeException) {
      check(nextGetFailure == null)
      nextGetFailure = failure
    }

    override fun getString(key: String?, defValue: String?): String? {
      nextGetFailure?.also { nextGetFailure = null }?.let { throw it }
      return delegate.getString(key, defValue)
    }

    override fun edit(): SharedPreferences.Editor = ControlledEditor(delegate.edit())

    private inner class ControlledEditor(
      private val delegateEditor: SharedPreferences.Editor,
    ) : SharedPreferences.Editor {
      override fun putString(key: String?, value: String?): SharedPreferences.Editor = apply {
        delegateEditor.putString(key, value)
      }

      override fun putStringSet(
        key: String?,
        values: MutableSet<String>?,
      ): SharedPreferences.Editor = apply { delegateEditor.putStringSet(key, values) }

      override fun putInt(key: String?, value: Int): SharedPreferences.Editor = apply {
        delegateEditor.putInt(key, value)
      }

      override fun putLong(key: String?, value: Long): SharedPreferences.Editor = apply {
        delegateEditor.putLong(key, value)
      }

      override fun putFloat(key: String?, value: Float): SharedPreferences.Editor = apply {
        delegateEditor.putFloat(key, value)
      }

      override fun putBoolean(key: String?, value: Boolean): SharedPreferences.Editor = apply {
        delegateEditor.putBoolean(key, value)
      }

      override fun remove(key: String?): SharedPreferences.Editor = apply {
        delegateEditor.remove(key)
      }

      override fun clear(): SharedPreferences.Editor = apply { delegateEditor.clear() }

      override fun commit(): Boolean {
        val failure = nextFailure ?: return delegateEditor.commit()
        nextFailure = null
        failingCommitAttempts += 1
        return when (failure) {
          CommitFailureMode.ReturnsFalse -> false
          CommitFailureMode.ThrowsRuntimeException ->
            throw RuntimeException("scripted commit failure")
        }
      }

      override fun apply() {
        delegateEditor.apply()
      }
    }
  }

  private class ScriptedSecretFixture(
    val preferences: CommitControllableSharedPreferences,
    val aes: ScriptedAesGcm = ScriptedAesGcm(),
    private val sharedMutex: Mutex = Mutex(),
  ) {
    init {
      check(preferences.edit().clear().commit())
    }

    fun newStore(): EncryptedSecretStore =
      EncryptedSecretStore.createForTest(preferences, aes, sharedMutex)

    suspend fun seedSignerAndGateway() {
      val store = newStore()
      store.writeSigner(StoredSigner(byteArrayOf(1, 2, 3), "signer-a"))
      val scope = GatewayScope(AccountScope("acct"), "gateway-a")
      store.writeGatewayCredential(
        GatewayCredential(scope, "pairing-a", "bearer-a", "relay-a"),
      )
    }

    fun allEncryptedRecords(): Map<String, String> =
      preferences.all.mapValues { (_, value) -> value as String }

    fun rawEncryptedRecord(recordKey: String): String? = preferences.getString(recordKey, null)
  }

  private class ScriptedAesGcm : AesGcm {
    private var keyExists = false
    private var nextDecryptFailure: Exception? = null
    private var nextDeleteFailure: Exception? = null

    override fun hasExistingKey(): Boolean = keyExists

    override fun deleteExistingKey() {
      nextDeleteFailure?.also { nextDeleteFailure = null }?.let { throw it }
      keyExists = false
    }

    override fun encrypt(
      recordKey: String,
      plaintext: ByteArray,
      allowKeyCreation: Boolean,
    ): ByteArray {
      if (!keyExists) {
        if (!allowKeyCreation) throw MissingKeystoreKey()
        keyExists = true
      }
      return plaintext.copyOf()
    }

    override fun decrypt(recordKey: String, envelope: ByteArray): ByteArray {
      nextDecryptFailure?.also { nextDecryptFailure = null }?.let { throw it }
      if (!keyExists) throw MissingKeystoreKey()
      return envelope.copyOf()
    }

    fun throwOnNextDecrypt(failure: Exception) {
      nextDecryptFailure = failure
    }

    fun throwOnNextDelete(failure: Exception) {
      nextDeleteFailure = failure
    }

    fun loseKey() {
      keyExists = false
    }
  }

  private companion object {
    const val TEST_PREFERENCES_NAME = "dash_encrypted_secrets_test_v1"
    const val TEST_KEY_ALIAS = "app.dash.android.secrets.test.v1"
  }
}
