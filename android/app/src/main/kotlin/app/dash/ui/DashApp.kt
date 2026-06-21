package app.dash.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.dash.AppContainer
import app.dash.connection.ConnectionProfile
import app.dash.designsystem.DashTheme
import kotlinx.coroutines.flow.map

private sealed interface ProfileState {
    data object Loading : ProfileState
    data class Ready(val profile: ConnectionProfile?) : ProfileState
}

/**
 * Root composable. Routes between the pairing flow and the main app based on
 * whether a connection profile is stored — reactively, so pairing or
 * "forget device" switches the whole app automatically.
 */
@Composable
fun DashApp(container: AppContainer) {
    DashTheme {
        val flow = remember {
            container.profileStore.profile().map<ConnectionProfile?, ProfileState> {
                ProfileState.Ready(it)
            }
        }
        val state by flow.collectAsStateWithLifecycle(initialValue = ProfileState.Loading)

        when (val s = state) {
            is ProfileState.Loading ->
                Box(Modifier.fillMaxSize()) {
                    CircularProgressIndicator(Modifier.align(Alignment.Center))
                }

            is ProfileState.Ready ->
                if (s.profile == null) {
                    PairingNavHost(container)
                } else {
                    MainNavHost(container, s.profile)
                }
        }
    }
}
