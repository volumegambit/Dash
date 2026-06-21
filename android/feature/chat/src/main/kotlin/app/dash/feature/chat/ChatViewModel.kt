package app.dash.feature.chat

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.dash.model.AgentEvent
import app.dash.model.WsClientMessage
import java.util.UUID
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** Opens the event stream for one chat message (production: ChatSocket::stream). */
typealias ChatStreamProvider = (WsClientMessage.Message) -> Flow<AgentEvent>

class ChatViewModel(
    private val agentId: String,
    private val streamProvider: ChatStreamProvider,
    private val channelId: String = "mobile",
    private val conversationId: String = UUID.randomUUID().toString(),
) : ViewModel() {
    private val _state = MutableStateFlow(ChatUiState())
    val state: StateFlow<ChatUiState> = _state.asStateFlow()

    private var streamJob: Job? = null
    private var currentId: String? = null
    private var counter = 0

    fun send(text: String) {
        val trimmed = text.trim()
        if (trimmed.isEmpty() || _state.value.streaming) return
        val id = "m${counter++}"
        currentId = id
        _state.update {
            it.copy(
                messages = it.messages + ChatMessage.User(trimmed) + ChatMessage.Assistant(),
                streaming = true,
                error = null,
            )
        }
        val message = WsClientMessage.Message(id, agentId, channelId, conversationId, trimmed)
        streamJob = viewModelScope.launch {
            try {
                streamProvider(message).collect { event ->
                    _state.update { ChatReducer.reduce(it, event) }
                }
                _state.update { it.copy(streaming = false) }
            } catch (e: Exception) {
                _state.update { it.copy(streaming = false, error = e.message ?: "Connection lost") }
            }
        }
    }

    fun stop() {
        // Cancelling the collector closes the socket; the gateway aborts the
        // active stream on disconnect (chat-server `onClose`), so no explicit
        // cancel frame is required.
        streamJob?.cancel()
        _state.update { it.copy(streaming = false) }
    }
}
