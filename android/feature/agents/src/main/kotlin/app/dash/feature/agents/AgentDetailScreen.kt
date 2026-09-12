package app.dash.feature.agents

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.dash.model.AgentStatus
import app.dash.model.RegisteredAgent

/**
 * Agent detail. Refined 2026-09-07 to match the iOS treatment: status by its
 * display name (not the raw enum), tools grouped with friendly labels, a
 * confirmation before disabling, and Chat offered only when the gateway will
 * actually run the agent. Read-only beyond enable/disable — deploying and
 * configuring agents stays in Mission Control (see android/README.md).
 */
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
                AgentDetailBody(
                    agent = agent,
                    toggleError = state.toggleError,
                    onToggleEnabled = viewModel::toggleEnabled,
                    onChat = { onChat(agent.id) },
                    modifier = Modifier.fillMaxSize().padding(padding),
                )
        }
    }
}

@Composable
private fun AgentDetailBody(
    agent: RegisteredAgent,
    toggleError: String?,
    onToggleEnabled: () -> Unit,
    onChat: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var showDisableConfirmation by remember { mutableStateOf(false) }
    val enabled = agent.status != AgentStatus.DISABLED

    Column(modifier.padding(16.dp).verticalScroll(rememberScrollState())) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            StatusDot(agent.status)
            Spacer(Modifier.width(8.dp))
            Text(agent.status.displayName(), color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.weight(1f))
            Switch(
                checked = enabled,
                onCheckedChange = { wantsEnabled ->
                    // Disabling stops the agent's active work, so it asks first —
                    // the same confirmation iOS and Mission Control require.
                    // Enabling is harmless and applies straight away.
                    if (wantsEnabled) onToggleEnabled() else showDisableConfirmation = true
                },
            )
        }
        Spacer(Modifier.height(16.dp))

        Label("Model")
        Text(agent.config.model)
        agent.config.fallbackModels?.takeIf { it.isNotEmpty() }?.let { fallbacks ->
            Spacer(Modifier.height(12.dp))
            Label("Fallback models")
            Text(fallbacks.joinToString(", "))
        }
        Spacer(Modifier.height(12.dp))
        Label("System prompt")
        Text(agent.config.systemPrompt)

        val groups = AgentToolCatalog.groups(agent.config.tools.orEmpty())
        if (groups.isNotEmpty()) {
            Spacer(Modifier.height(16.dp))
            Label("Tools (${agent.config.tools.orEmpty().size})")
            for (group in groups) {
                Spacer(Modifier.height(8.dp))
                ToolGroupRow(group)
            }
        }

        toggleError?.let {
            Spacer(Modifier.height(12.dp))
            Text(it, color = MaterialTheme.colorScheme.error)
        }

        Spacer(Modifier.height(24.dp))
        val canChat = AgentPresentation.canStartChat(agent.status)
        Button(onClick = onChat, enabled = canChat, modifier = Modifier.fillMaxWidth()) {
            Text("Chat")
        }
        if (!canChat) {
            Spacer(Modifier.height(6.dp))
            Text(
                "Enable this agent to start a conversation",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }

    if (showDisableConfirmation) {
        AlertDialog(
            onDismissRequest = { showDisableConfirmation = false },
            title = { Text("Disable ${agent.name}?") },
            text = {
                Text("Disabling this agent stops its active work. Existing conversations remain available.")
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        showDisableConfirmation = false
                        onToggleEnabled()
                    },
                ) { Text("Disable") }
            },
            dismissButton = {
                TextButton(onClick = { showDisableConfirmation = false }) { Text("Cancel") }
            },
        )
    }
}

/**
 * One functional tool group: name, plain-language description, and a wrapping
 * row of tool-name chips — the grouped treatment iOS and Mission Control use.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ToolGroupRow(group: AgentToolCatalog.ToolGroup) {
    Column {
        Text(group.name, style = MaterialTheme.typography.bodyMedium)
        group.description?.let {
            Text(
                it,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Spacer(Modifier.height(6.dp))
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            for (id in group.tools) {
                ToolChip(AgentToolCatalog.label(id))
            }
        }
    }
}

@Composable
private fun ToolChip(label: String) {
    val shape = RoundedCornerShape(50)
    Text(
        label,
        style = MaterialTheme.typography.labelMedium,
        modifier = Modifier
            .background(MaterialTheme.colorScheme.surfaceVariant, shape)
            .border(1.dp, MaterialTheme.colorScheme.outlineVariant, shape)
            .padding(horizontal = 10.dp, vertical = 4.dp),
    )
}

@Composable
private fun Label(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.labelMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}
