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
        val blocks: List<AssistantBlock> = emptyList(),
        val text: String = "",
        val thinking: String = "",
        val toolCalls: List<ToolCall> = emptyList(),
        val question: AgentEvent.Question? = null,
        val done: Boolean = false,
    ) : ChatMessage
}

sealed interface AssistantBlock {
    data class Text(val text: String) : AssistantBlock
    data class Thinking(val text: String) : AssistantBlock
    data class Tool(val call: ToolCall) : AssistantBlock
    data class Worker(val worker: WorkerCard) : AssistantBlock
    data class Status(val title: String, val detail: String? = null) : AssistantBlock
    data class Question(val question: AgentEvent.Question) : AssistantBlock
}

data class WorkerCard(
    val workerId: String,
    val runId: String,
    val role: String,
    val status: String,
    val detail: String? = null,
)

data class ToolCall(
    val id: String,
    val name: String,
    val result: String? = null,
    val isError: Boolean = false,
)
