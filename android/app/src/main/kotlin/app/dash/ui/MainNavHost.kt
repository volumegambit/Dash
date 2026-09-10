package app.dash.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import app.dash.AppContainer
import app.dash.connection.ConnectionProfile
import app.dash.feature.agents.AgentDetailScreen
import app.dash.feature.agents.AgentDetailViewModel
import app.dash.feature.agents.AgentsListViewModel
import app.dash.feature.agents.AgentsScreen
import app.dash.feature.agents.GatewayAgentsRepository
import app.dash.feature.chat.ChatScreen
import app.dash.feature.chat.ChatViewModel
import app.dash.network.GatewayProtocolSelection
import app.dash.network.GatewaySessionSelection
import app.dash.network.selectGatewaySession
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

private sealed interface MainSessionState {
    data object Loading : MainSessionState
    data class Ready(val selection: GatewayProtocolSelection) : MainSessionState
    data class Error(val message: String) : MainSessionState
}

/** Re-verifies the stored protocol and gateway identity before creating any session consumer. */
@Composable
fun MainNavHost(container: AppContainer, profile: ConnectionProfile) {
    var retry by remember(profile) { mutableIntStateOf(0) }
    val state by produceState<MainSessionState>(MainSessionState.Loading, profile, retry) {
        value = try {
            when (val selected = selectGatewaySession(profile.gatewayId, container.negotiate(profile))) {
                is GatewaySessionSelection.Failed -> MainSessionState.Error(selected.message)
                is GatewaySessionSelection.Selected -> {
                    if (
                        selected.value == GatewayProtocolSelection.V1 &&
                        !container.legacyHealthCheck(profile)
                    ) {
                        MainSessionState.Error("Could not reach gateway at ${profile.host}")
                    } else {
                        MainSessionState.Ready(selected.value)
                    }
                }
            }
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            MainSessionState.Error(error.message ?: "Could not establish gateway session")
        }
    }

    when (val current = state) {
        MainSessionState.Loading -> Box(Modifier.fillMaxSize()) {
            CircularProgressIndicator(Modifier.align(Alignment.Center))
        }
        is MainSessionState.Error -> Column(
            modifier = Modifier.fillMaxSize(),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(current.message)
            Button(onClick = { retry++ }) { Text("Retry") }
        }
        is MainSessionState.Ready -> SelectedMainNavHost(container, profile, current.selection)
    }
}

@Composable
private fun SelectedMainNavHost(
    container: AppContainer,
    profile: ConnectionProfile,
    selection: GatewayProtocolSelection,
) {
    val nav = rememberNavController()
    val scope = rememberCoroutineScope()
    val repository = remember(profile, selection) {
        GatewayAgentsRepository(container.gatewayClient(profile, selection))
    }

    NavHost(nav, startDestination = "agents") {
        composable("agents") {
            val vm: AgentsListViewModel = viewModel(
                factory = viewModelFactory { AgentsListViewModel(repository) },
            )
            AgentsScreen(
                viewModel = vm,
                onAgentClick = { nav.navigate("agent/$it") },
                onOpenSettings = { nav.navigate("settings") },
            )
        }
        composable("agent/{id}") { entry ->
            val id = entry.arguments?.getString("id").orEmpty()
            val vm: AgentDetailViewModel = viewModel(
                factory = viewModelFactory { AgentDetailViewModel(id, repository) },
            )
            AgentDetailScreen(
                viewModel = vm,
                onBack = { nav.popBackStack() },
                onChat = {
                    if (selection == GatewayProtocolSelection.V1) nav.navigate("chat/$it")
                },
            )
        }
        if (selection == GatewayProtocolSelection.V1) {
            composable("chat/{id}") { entry ->
                val id = entry.arguments?.getString("id").orEmpty()
                val vm: ChatViewModel = viewModel(
                    factory = viewModelFactory {
                        ChatViewModel(
                            agentId = id,
                            streamProvider = container.chatSocket(profile, selection)::stream,
                        )
                    },
                )
                ChatScreen(viewModel = vm, title = "Chat", onBack = { nav.popBackStack() })
            }
        }
        composable("settings") {
            SettingsScreen(
                profile = profile,
                onForget = { scope.launch { container.profileStore.clear() } },
                onBack = { nav.popBackStack() },
            )
        }
    }
}
