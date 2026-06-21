package app.dash.feature.chat

import app.dash.model.AgentEvent

data class ChatUiState(
    val messages: List<ChatMessage> = emptyList(),
    val streaming: Boolean = false,
    val error: String? = null,
)

sealed interface ChatMessage {
    data class User(val text: String) : ChatMessage

    data class Assistant(
        val text: String = "",
        val thinking: String = "",
        val toolCalls: List<ToolCall> = emptyList(),
        val question: AgentEvent.Question? = null,
        val done: Boolean = false,
    ) : ChatMessage
}

data class ToolCall(
    val id: String,
    val name: String,
    val result: String? = null,
    val isError: Boolean = false,
)
