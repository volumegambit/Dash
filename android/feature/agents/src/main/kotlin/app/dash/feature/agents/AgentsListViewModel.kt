package app.dash.feature.agents

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.dash.model.RegisteredAgent
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

sealed interface AgentsUiState {
    data object Loading : AgentsUiState
    data class Error(val message: String) : AgentsUiState
    data class Loaded(val agents: List<RegisteredAgent>) : AgentsUiState
}

class AgentsListViewModel(
    private val repository: AgentsRepository,
) : ViewModel() {
    private val _state = MutableStateFlow<AgentsUiState>(AgentsUiState.Loading)
    val state: StateFlow<AgentsUiState> = _state.asStateFlow()

    init {
        refresh()
    }

    fun refresh() {
        viewModelScope.launch {
            _state.value = AgentsUiState.Loading
            _state.value = try {
                AgentsUiState.Loaded(repository.list())
            } catch (e: Exception) {
                AgentsUiState.Error(e.message ?: "Failed to load agents")
            }
        }
    }
}
