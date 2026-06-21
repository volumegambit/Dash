package app.dash.feature.agents

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.dash.model.AgentStatus
import app.dash.model.RegisteredAgent
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class AgentDetailUiState(
    val agent: RegisteredAgent? = null,
    val loading: Boolean = true,
    val error: String? = null,
    val toggleError: String? = null,
)

class AgentDetailViewModel(
    private val agentId: String,
    private val repository: AgentsRepository,
) : ViewModel() {
    private val _state = MutableStateFlow(AgentDetailUiState())
    val state: StateFlow<AgentDetailUiState> = _state.asStateFlow()

    init {
        load()
    }

    fun load() {
        viewModelScope.launch {
            _state.update { it.copy(loading = true, error = null) }
            try {
                val agent = repository.get(agentId)
                _state.update { it.copy(agent = agent, loading = false) }
            } catch (e: Exception) {
                _state.update { it.copy(loading = false, error = e.message ?: "Failed to load") }
            }
        }
    }

    /**
     * Flips the agent's enabled state optimistically (the UI updates before the
     * request returns) and reverts if the gateway call fails.
     */
    fun toggleEnabled() {
        val current = _state.value.agent ?: return
        val makeEnabled = current.status == AgentStatus.DISABLED
        val optimistic = current.copy(
            status = if (makeEnabled) AgentStatus.ACTIVE else AgentStatus.DISABLED,
        )
        _state.update { it.copy(agent = optimistic, toggleError = null) }
        viewModelScope.launch {
            try {
                repository.setEnabled(current.id, makeEnabled)
            } catch (e: Exception) {
                _state.update { it.copy(agent = current, toggleError = e.message ?: "Toggle failed") }
            }
        }
    }
}
