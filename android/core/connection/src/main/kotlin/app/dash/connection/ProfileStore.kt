package app.dash.connection

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

/**
 * Persists the active [ConnectionProfile] in a Preferences DataStore. Token
 * fields are run through [cipher] before storage and after retrieval, so the
 * plaintext tokens never hit disk.
 */
class ProfileStore(
    private val dataStore: DataStore<Preferences>,
    private val cipher: TokenCipher,
) {
    fun profile(): Flow<ConnectionProfile?> = dataStore.data.map { prefs ->
        val host = prefs[HOST] ?: return@map null
        val mgmtEnc = prefs[MGMT_TOKEN] ?: return@map null
        val chatEnc = prefs[CHAT_TOKEN] ?: return@map null
        ConnectionProfile(
            label = prefs[LABEL] ?: host,
            host = host,
            mgmtPort = prefs[MGMT_PORT] ?: ConnectionProfile.DEFAULT_MGMT_PORT,
            chatPort = prefs[CHAT_PORT] ?: ConnectionProfile.DEFAULT_CHAT_PORT,
            mgmtToken = cipher.decrypt(mgmtEnc),
            chatToken = cipher.decrypt(chatEnc),
            secure = prefs[SECURE] ?: false,
        )
    }

    suspend fun save(profile: ConnectionProfile) {
        dataStore.edit { prefs ->
            prefs[LABEL] = profile.label
            prefs[HOST] = profile.host
            prefs[MGMT_PORT] = profile.mgmtPort
            prefs[CHAT_PORT] = profile.chatPort
            prefs[MGMT_TOKEN] = cipher.encrypt(profile.mgmtToken)
            prefs[CHAT_TOKEN] = cipher.encrypt(profile.chatToken)
            prefs[SECURE] = profile.secure
        }
    }

    suspend fun clear() {
        dataStore.edit { it.clear() }
    }

    private companion object {
        val LABEL = stringPreferencesKey("label")
        val HOST = stringPreferencesKey("host")
        val MGMT_PORT = intPreferencesKey("mgmt_port")
        val CHAT_PORT = intPreferencesKey("chat_port")
        val MGMT_TOKEN = stringPreferencesKey("mgmt_token_enc")
        val CHAT_TOKEN = stringPreferencesKey("chat_token_enc")
        val SECURE = booleanPreferencesKey("secure")
    }
}
