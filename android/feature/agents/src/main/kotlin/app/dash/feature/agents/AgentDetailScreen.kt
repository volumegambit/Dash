package app.dash.feature.agents

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.dash.model.AgentStatus

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AgentDetailScreen(
    viewModel: AgentDetailViewModel,
    onBack: () -> Unit,
    onChat: (String) -> Unit,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(state.agent?.name ?: "Agent") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
            )
        },
    ) { padding ->
        val agent = state.agent
        when {
            state.loading ->
                Box(Modifier.fillMaxSize().padding(padding)) {
                    CircularProgressIndicator(Modifier.align(Alignment.Center))
                }

            state.error != null ->
                Box(Modifier.fillMaxSize().padding(padding)) {
                    Text(
                        state.error!!,
                        Modifier.align(Alignment.Center),
                        color = MaterialTheme.colorScheme.error,
                    )
                }

            agent != null ->
                Column(
                    Modifier
                        .fillMaxSize()
                        .padding(padding)
                        .padding(16.dp)
                        .verticalScroll(rememberScrollState()),
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        StatusDot(agent.status)
                        Spacer(Modifier.width(8.dp))
                        Text(
                            agent.status.name.lowercase(),
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Spacer(Modifier.weight(1f))
                        Switch(
                            checked = agent.status != AgentStatus.DISABLED,
                            onCheckedChange = { viewModel.toggleEnabled() },
                        )
                    }
                    Spacer(Modifier.height(16.dp))
                    Label("Model")
                    Text(agent.config.model)
                    Spacer(Modifier.height(12.dp))
                    Label("System prompt")
                    Text(agent.config.systemPrompt)
                    agent.config.tools?.takeIf { it.isNotEmpty() }?.let { tools ->
                        Spacer(Modifier.height(12.dp))
                        Label("Tools")
                        Text(tools.joinToString(", "))
                    }
                    state.toggleError?.let {
                        Spacer(Modifier.height(12.dp))
                        Text(it, color = MaterialTheme.colorScheme.error)
                    }
                    Spacer(Modifier.height(24.dp))
                    Button(onClick = { onChat(agent.id) }, modifier = Modifier.fillMaxWidth()) {
                        Text("Chat")
                    }
                }
        }
    }
}

@Composable
private fun Label(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.labelMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}
