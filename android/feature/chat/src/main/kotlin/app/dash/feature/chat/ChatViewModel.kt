package app.dash.feature.chat

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.dash.model.AgentEvent
import app.dash.model.WsClientMessage
import java.util.UUID
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** One message's event stream + a channel for follow-up frames (answers/cancel). */
typealias ChatStreamProvider = (WsClientMessage.Message, Flow<WsClientMessage>) -> Flow<AgentEvent>

class ChatViewModel(
    private val agentId: String,
    private val streamProvider: ChatStreamProvider,
    private val channelId: String = "mobile",
    private val conversationId: String = UUID.randomUUID().toString(),
) : ViewModel() {
    private val _state = MutableStateFlow(ChatUiState())
    val state: StateFlow<ChatUiState> = _state.asStateFlow()

    private val outgoing = MutableSharedFlow<WsClientMessage>(extraBufferCapacity = 16)
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
                streamProvider(message, outgoing).collect { event ->
                    _state.update { ChatReducer.reduce(it, event) }
                }
                _state.update { it.copy(streaming = false) }
            } catch (e: Exception) {
                _state.update { it.copy(streaming = false, error = e.message ?: "Connection lost") }
            }
        }
    }

    /** Answers a `question` event on the live socket and clears it from the UI. */
    fun answer(questionId: String, answer: String) {
        val id = currentId ?: return
        outgoing.tryEmit(WsClientMessage.Answer(id, questionId, answer))
        _state.update { st ->
            val index = st.messages.indexOfLast { it is ChatMessage.Assistant }
            if (index < 0) return@update st
            val msgs = st.messages.toMutableList()
            msgs[index] = (msgs[index] as ChatMessage.Assistant).copy(question = null)
            st.copy(messages = msgs)
        }
    }

    fun stop() {
        currentId?.let { outgoing.tryEmit(WsClientMessage.Cancel(it)) }
        streamJob?.cancel()
        _state.update { it.copy(streaming = false) }
    }
}
