package app.dash.connection

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import java.io.File
import java.nio.file.Files
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
    private val fakeCipher = object : TokenCipher {
        override fun encrypt(plaintext: String) = "enc($plaintext)"
        override fun decrypt(ciphertext: String) =
            ciphertext.removePrefix("enc(").removeSuffix(")")
    }

    private fun newStore(scope: CoroutineScope): ProfileStore {
        val dir = Files.createTempDirectory("profilestore").toFile()
        val file = File(dir, "profile.preferences_pb")
        val ds = PreferenceDataStoreFactory.create(scope = scope) { file }
        return ProfileStore(ds, fakeCipher)
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
}
