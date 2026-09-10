package app.dash.connection

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import java.io.File
import java.nio.file.Files
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class ConversationPointerStoreTest {
    @Test fun roundTripsAndSeparatesCollisionProneGatewayAndAgentIds() = runBlocking {
        val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
        val file = File(Files.createTempDirectory("pointers").toFile(), "profile.preferences_pb")
        val dataStore = PreferenceDataStoreFactory.create(scope = scope) { file }
        val store = DataStoreConversationPointerStore(dataStore)
        val first = ConversationPointer("conversation/one", 9)
        val second = ConversationPointer("conversation.two", 10)

        store.save("gateway.one", "agent/two", first)
        store.save("gateway", "one.agent/two", second)

        assertEquals(first, store.read("gateway.one", "agent/two"))
        assertEquals(second, store.read("gateway", "one.agent/two"))
        assertNull(store.read("gateway.one", "one.agent/two"))
        scope.cancel()
    }

    @Test fun removeAndRemoveGatewayAreNarrowlyScoped() = runBlocking {
        val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
        val file = File(Files.createTempDirectory("pointers").toFile(), "profile.preferences_pb")
        val dataStore = PreferenceDataStoreFactory.create(scope = scope) { file }
        val store = DataStoreConversationPointerStore(dataStore)
        store.save("gw/1", "agent.1", ConversationPointer("a", 1))
        store.save("gw/1", "agent.2", ConversationPointer("b", 2))
        store.save("gw", "1.agent.1", ConversationPointer("c", 3))

        store.remove("gw/1", "agent.1")
        assertNull(store.read("gw/1", "agent.1"))
        assertEquals(ConversationPointer("b", 2), store.read("gw/1", "agent.2"))

        store.removeGateway("gw/1")
        assertNull(store.read("gw/1", "agent.2"))
        assertEquals(ConversationPointer("c", 3), store.read("gw", "1.agent.1"))
        scope.cancel()
    }

    @Test fun validatesScopeAndSafeCursorBeforeMutating() = runBlocking {
        val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
        val file = File(Files.createTempDirectory("pointers").toFile(), "profile.preferences_pb")
        val dataStore = PreferenceDataStoreFactory.create(scope = scope) { file }
        val store = DataStoreConversationPointerStore(dataStore)
        listOf<suspend () -> Unit>(
            { store.save("", "agent", ConversationPointer("conversation", 0)) },
            { store.save("gateway", "", ConversationPointer("conversation", 0)) },
            { store.save("gateway", "agent", ConversationPointer("", 0)) },
            { store.save("gateway", "agent", ConversationPointer("conversation", -1)) },
            {
                store.save(
                    "gateway",
                    "agent",
                    ConversationPointer("conversation", 9_007_199_254_740_992L),
                )
            },
        ).forEach { invalid ->
            try {
                invalid()
                throw AssertionError("expected invalid pointer to fail")
            } catch (_: IllegalArgumentException) {
                // Expected.
            }
        }
        assertNull(store.read("gateway", "agent"))
        scope.cancel()
    }
}
