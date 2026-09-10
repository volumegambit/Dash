package app.dash

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.preferencesDataStoreFile
import app.dash.connection.ConnectionProfile
import app.dash.connection.DataStoreConversationPointerStore
import app.dash.connection.KeystoreTokenCipher
import app.dash.connection.ProfileStore
import app.dash.connection.TokenCipher
import app.dash.network.ChatSocket
import app.dash.network.GatewayClient
import app.dash.network.GatewayNegotiation
import app.dash.network.GatewayProtocolSelection
import app.dash.network.PinnedTlsClientFactory
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

    val conversationPointerStore = DataStoreConversationPointerStore(dataStore)

    val profileStore: ProfileStore = ProfileStore(dataStore, cipher, conversationPointerStore)

    fun negotiationClient(profile: ConnectionProfile): GatewayClient =
        GatewayClient.forNegotiation(
            profile.mgmtBaseUrl,
            profile.mgmtToken,
            clientFor(profile),
            profile.relayCredential,
        )

    fun gatewayClient(
        profile: ConnectionProfile,
        selection: GatewayProtocolSelection,
    ): GatewayClient = GatewayClient.selected(
        profile.mgmtBaseUrl,
        profile.mgmtToken,
        selection,
        clientFor(profile),
        profile.relayCredential,
    )

    fun chatSocket(
        profile: ConnectionProfile,
        selection: GatewayProtocolSelection,
    ): ChatSocket {
        require(selection == GatewayProtocolSelection.V1) {
            "Mobile v2 sessions must use the v2 conversation transport"
        }
        return ChatSocket(
            profile.chatWsUrl,
            profile.chatToken,
            clientFor(profile),
            profile.relayCredential,
        )
    }

    suspend fun negotiate(profile: ConnectionProfile): GatewayNegotiation =
        negotiationClient(profile).negotiate()

    suspend fun legacyHealthCheck(profile: ConnectionProfile): Boolean =
        gatewayClient(profile, GatewayProtocolSelection.V1).health()

    private fun clientFor(profile: ConnectionProfile): OkHttpClient {
        val certificateSha256 = profile.tlsCertificateSha256 ?: return okHttp
        return PinnedTlsClientFactory.create(okHttp, profile.host, certificateSha256)
    }
}
