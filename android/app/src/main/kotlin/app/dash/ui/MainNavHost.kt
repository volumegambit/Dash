package app.dash.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
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
import kotlinx.coroutines.launch

@Composable
fun MainNavHost(container: AppContainer, profile: ConnectionProfile) {
    val nav = rememberNavController()
    val scope = rememberCoroutineScope()
    val repository = remember(profile) {
        GatewayAgentsRepository(container.gatewayClient(profile))
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
                onChat = { nav.navigate("chat/$it") },
            )
        }
        composable("chat/{id}") { entry ->
            val id = entry.arguments?.getString("id").orEmpty()
            val vm: ChatViewModel = viewModel(
                factory = viewModelFactory {
                    ChatViewModel(agentId = id, streamProvider = container.chatSocket(profile)::stream)
                },
            )
            ChatScreen(viewModel = vm, title = "Chat", onBack = { nav.popBackStack() })
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
