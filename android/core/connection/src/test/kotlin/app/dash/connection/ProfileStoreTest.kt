package app.dash.connection

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.MutablePreferences
import androidx.datastore.core.DataStore
import java.io.File
import java.nio.file.Files
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class ProfileStoreTest {
    private val certificateSha256 =
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

    private val fakeCipher = object : TokenCipher {
        override fun encrypt(plaintext: String) = "enc($plaintext)"
        override fun decrypt(ciphertext: String) =
            ciphertext.removePrefix("enc(").removeSuffix(")")
    }

    private fun newDataStore(scope: CoroutineScope): DataStore<Preferences> {
        val dir = Files.createTempDirectory("profilestore").toFile()
        val file = File(dir, "profile.preferences_pb")
        return PreferenceDataStoreFactory.create(scope = scope) { file }
    }

    private fun newStore(scope: CoroutineScope): ProfileStore {
        val dataStore = newDataStore(scope)
        return ProfileStore(dataStore, fakeCipher, DataStoreConversationPointerStore(dataStore))
    }

    @Test fun saveThenReadRoundTrips() = runBlocking {
        val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
        val store = newStore(scope)
        val profile = ConnectionProfile("Home", "1.2.3.4", mgmtToken = "m", chatToken = "c")
        store.save(profile)
        assertEquals(profile, store.profile().first())
        scope.cancel()
    }

    @Test fun nullBeforeAnySave() = runBlocking {
        val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
        val store = newStore(scope)
        assertNull(store.profile().first())
        scope.cancel()
    }

    @Test fun clearRemovesProfile() = runBlocking {
        val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
        val store = newStore(scope)
        store.save(ConnectionProfile("l", "h", mgmtToken = "m", chatToken = "c"))
        store.clear()
        assertNull(store.profile().first())
        scope.cancel()
    }

    @Test fun decryptsTokensOnRead() = runBlocking {
        val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
        val store = newStore(scope)
        store.save(ConnectionProfile("l", "h", mgmtToken = "secret-m", chatToken = "secret-c"))
        val read = store.profile().first()!!
        assertEquals("secret-m", read.mgmtToken)
        assertEquals("secret-c", read.chatToken)
        scope.cancel()
    }

    @Test fun roundTripsEncryptedRelayCredential() = runBlocking {
        val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
        val store = newStore(scope)
        store.save(
            ConnectionProfile(
                "l", "gw.relay", mgmtToken = "m", chatToken = "c",
                secure = true, relayCredential = "rc-secret",
            ),
        )
        assertEquals("rc-secret", store.profile().first()!!.relayCredential)
        scope.cancel()
    }

    @Test fun roundTripsPinnedTlsCertificateDigest() = runBlocking {
        val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
        val store = newStore(scope)
        store.save(
            ConnectionProfile(
                "LAN",
                "10.0.0.5",
                mgmtToken = "m",
                chatToken = "c",
                secure = true,
                tlsCertificateSha256 = certificateSha256,
            ),
        )
        assertEquals(certificateSha256, store.profile().first()!!.tlsCertificateSha256)
        scope.cancel()
    }

    @Test fun lanProfileHasNullRelayCredential() = runBlocking {
        val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
        val store = newStore(scope)
        store.save(ConnectionProfile("l", "h", mgmtToken = "m", chatToken = "c"))
        assertNull(store.profile().first()!!.relayCredential)
        scope.cancel()
    }

    @Test fun savingLanProfileClearsStaleRelayCredential() = runBlocking {
        val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
        val store = newStore(scope)
        store.save(
            ConnectionProfile("l", "gw.relay", mgmtToken = "m", chatToken = "c", relayCredential = "rc"),
        )
        // Re-pairing over LAN must not leave the old relay credential behind.
        store.save(ConnectionProfile("l", "h", mgmtToken = "m", chatToken = "c"))
        assertNull(store.profile().first()!!.relayCredential)
        scope.cancel()
    }

    @Test fun savingUnpinnedProfileClearsStaleCertificateDigest() = runBlocking {
        val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
        val store = newStore(scope)
        store.save(
            ConnectionProfile(
                "LAN",
                "10.0.0.5",
                mgmtToken = "m",
                chatToken = "c",
                secure = true,
                tlsCertificateSha256 = certificateSha256,
            ),
        )
        store.save(
            ConnectionProfile(
                "Relay",
                "gateway.relay.example",
                mgmtToken = "m",
                chatToken = "c",
                secure = true,
                relayCredential = "relay-credential",
            ),
        )
        assertNull(store.profile().first()!!.tlsCertificateSha256)
        scope.cancel()
    }

    @Test fun roundTripsVerifiedGatewayIdentity() = runBlocking {
        val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
        val store = newStore(scope)
        val profile = ConnectionProfile(
            "Relay",
            "gateway.relay.example",
            mgmtToken = "m",
            chatToken = "m",
            relayCredential = "credential",
            gatewayId = "gateway-1",
        )
        store.save(profile)
        assertEquals("gateway-1", store.profile().first()!!.gatewayId)
        scope.cancel()
    }

    @Test fun clearProfileAlsoClearsOnlyThatGatewaysConversationPointers() = runBlocking {
        val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
        val dataStore = newDataStore(scope)
        val pointers = DataStoreConversationPointerStore(dataStore)
        val store = ProfileStore(dataStore, fakeCipher, pointers)
        store.save(
            ConnectionProfile(
                "Relay",
                "gateway.relay.example",
                mgmtToken = "m",
                chatToken = "m",
                relayCredential = "credential",
                gatewayId = "gw-1",
            ),
        )
        pointers.save("gw-1", "agent-1", ConversationPointer("conv-1", 9))
        pointers.save("gw-2", "agent-1", ConversationPointer("conv-2", 3))

        store.clear()

        assertNull(store.profile().first())
        assertNull(pointers.read("gw-1", "agent-1"))
        assertEquals(ConversationPointer("conv-2", 3), pointers.read("gw-2", "agent-1"))
        scope.cancel()
    }

    @Test fun pointerCleanupFailureOrCancellationRollsBackProfileAndPointers() = runBlocking {
        listOf<Throwable>(IllegalStateException("disk failed"), CancellationException("cancelled"))
            .forEach { failure ->
                val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
                val dataStore = newDataStore(scope)
                val pointer = ConversationPointer("conv-1", 9)
                val storedPointers = DataStoreConversationPointerStore(dataStore)
                storedPointers.save("gw-1", "agent-1", pointer)
                val failingPointers = object : TransactionalConversationPointerStore {
                    override suspend fun read(gatewayId: String, agentId: String) =
                        storedPointers.read(gatewayId, agentId)

                    override suspend fun save(
                        gatewayId: String,
                        agentId: String,
                        value: ConversationPointer,
                    ) = storedPointers.save(gatewayId, agentId, value)

                    override suspend fun remove(gatewayId: String, agentId: String) =
                        storedPointers.remove(gatewayId, agentId)

                    override suspend fun removeGateway(gatewayId: String) {
                        storedPointers.removeGateway(gatewayId)
                        throw failure
                    }

                    override fun isBackedBy(dataStore: DataStore<Preferences>) =
                        storedPointers.isBackedBy(dataStore)

                    override fun removeGatewayInTransaction(
                        preferences: MutablePreferences,
                        gatewayId: String,
                    ) {
                        storedPointers.removeGatewayInTransaction(preferences, gatewayId)
                        throw failure
                    }
                }
                val store = ProfileStore(dataStore, fakeCipher, failingPointers)
                val profile = ConnectionProfile(
                    "Relay",
                    "gateway.relay.example",
                    mgmtToken = "m",
                    chatToken = "m",
                    relayCredential = "credential",
                    gatewayId = "gw-1",
                )
                store.save(profile)

                try {
                    store.clear()
                    throw AssertionError("expected pointer cleanup to fail")
                } catch (actual: Throwable) {
                    assertEquals(failure::class.java.name, actual::class.java.name)
                    assertEquals(failure.message, actual.message)
                }
                assertEquals(profile, store.profile().first())
                assertEquals(pointer, storedPointers.read("gw-1", "agent-1"))
                scope.cancel()
            }
    }
}
