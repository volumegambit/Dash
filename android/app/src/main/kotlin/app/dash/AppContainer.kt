package app.dash

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.preferencesDataStoreFile
import app.dash.connection.ConnectionProfile
import app.dash.connection.KeystoreTokenCipher
import app.dash.connection.ProfileStore
import app.dash.connection.TokenCipher
import app.dash.network.ChatSocket
import app.dash.network.GatewayClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import okhttp3.OkHttpClient

/**
 * Hand-rolled dependency container — created once in [DashApplication]. Holds
 * the shared HTTP client and encrypted profile store, and builds per-connection
 * clients on demand.
 */
class AppContainer(context: Context) {
    private val appContext = context.applicationContext
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    val okHttp: OkHttpClient = OkHttpClient.Builder().build()

    private val cipher: TokenCipher = KeystoreTokenCipher()

    private val dataStore: DataStore<Preferences> =
        PreferenceDataStoreFactory.create(scope = scope) {
            appContext.preferencesDataStoreFile("dash_profile")
        }

    val profileStore: ProfileStore = ProfileStore(dataStore, cipher)

    fun gatewayClient(profile: ConnectionProfile): GatewayClient =
        GatewayClient(profile.mgmtBaseUrl, profile.mgmtToken, okHttp)

    fun chatSocket(profile: ConnectionProfile): ChatSocket =
        ChatSocket(profile.chatWsUrl, okHttp)

    suspend fun healthCheck(profile: ConnectionProfile): Boolean =
        gatewayClient(profile).health()
}
