package app.dash.connection

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.MutablePreferences
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import java.util.Base64
import kotlinx.coroutines.flow.first
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L
private const val POINTER_PREFIX = "conversation_pointer."

@Serializable
data class ConversationPointer(
    val conversationId: String,
    val lastAppliedV2Seq: Long,
) {
    init {
        require(conversationId.isNotEmpty())
        require(lastAppliedV2Seq in 0..MAX_SAFE_INTEGER)
    }
}

interface ConversationPointerStore {
    suspend fun read(gatewayId: String, agentId: String): ConversationPointer?
    suspend fun save(gatewayId: String, agentId: String, value: ConversationPointer)
    suspend fun remove(gatewayId: String, agentId: String)
    suspend fun removeGateway(gatewayId: String)
}

interface TransactionalConversationPointerStore : ConversationPointerStore {
    fun isBackedBy(dataStore: DataStore<Preferences>): Boolean

    fun removeGatewayInTransaction(
        preferences: MutablePreferences,
        gatewayId: String,
    )
}

class DataStoreConversationPointerStore(
    private val dataStore: DataStore<Preferences>,
) : TransactionalConversationPointerStore {
    private val json = Json {
        ignoreUnknownKeys = false
        isLenient = false
        encodeDefaults = true
    }

    override suspend fun read(gatewayId: String, agentId: String): ConversationPointer? {
        val key = pointerKey(gatewayId, agentId)
        return dataStore.data.first()[key]?.let {
            json.decodeFromString(ConversationPointer.serializer(), it)
        }
    }

    override suspend fun save(
        gatewayId: String,
        agentId: String,
        value: ConversationPointer,
    ) {
        val key = pointerKey(gatewayId, agentId)
        val encoded = json.encodeToString(ConversationPointer.serializer(), value)
        dataStore.edit { it[key] = encoded }
    }

    override suspend fun remove(gatewayId: String, agentId: String) {
        val key = pointerKey(gatewayId, agentId)
        dataStore.edit { it.remove(key) }
    }

    override suspend fun removeGateway(gatewayId: String) {
        dataStore.edit { preferences ->
            removeGatewayInTransaction(preferences, gatewayId)
        }
    }

    override fun isBackedBy(dataStore: DataStore<Preferences>): Boolean =
        this.dataStore === dataStore

    override fun removeGatewayInTransaction(
        preferences: MutablePreferences,
        gatewayId: String,
    ) {
        val prefix = "$POINTER_PREFIX${component(gatewayId)}."
        preferences.asMap().keys
            .filter { it.name.startsWith(prefix) }
            .forEach { preferences.remove(it) }
    }

    private fun pointerKey(gatewayId: String, agentId: String): Preferences.Key<String> =
        stringPreferencesKey("$POINTER_PREFIX${component(gatewayId)}.${component(agentId)}")

    private fun component(value: String): String {
        require(value.isNotEmpty())
        return Base64.getUrlEncoder()
            .withoutPadding()
            .encodeToString(value.toByteArray(Charsets.UTF_8))
    }
}
