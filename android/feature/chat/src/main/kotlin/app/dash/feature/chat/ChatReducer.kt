package app.dash.feature.chat

import app.dash.model.AgentEvent

/**
 * Pure fold of a streamed [AgentEvent] onto the chat state. All updates target
 * the last assistant message (the in-flight turn). Unhandled event types are
 * no-ops so the stream never breaks on something new.
 */
object ChatReducer {
    fun reduce(state: ChatUiState, event: AgentEvent): ChatUiState = when (event) {
        is AgentEvent.TextDelta ->
            updateLastAssistant(state) { it.copy(text = it.text + event.text) }

        is AgentEvent.ThinkingDelta ->
            updateLastAssistant(state) { it.copy(thinking = it.thinking + event.text) }

        is AgentEvent.ToolUseStart ->
            updateLastAssistant(state) { it.copy(toolCalls = it.toolCalls + ToolCall(event.id, event.name)) }

        is AgentEvent.ToolResult ->
            updateLastAssistant(state) { assistant ->
                assistant.copy(
                    toolCalls = assistant.toolCalls.map { call ->
                        if (call.id == event.id) {
                            call.copy(result = event.content, isError = event.isError == true)
                        } else {
                            call
                        }
                    },
                )
            }

        is AgentEvent.Question ->
            updateLastAssistant(state) { it.copy(question = event) }

        is AgentEvent.Response ->
            updateLastAssistant(state) { it.copy(text = it.text.ifEmpty { event.content }, done = true) }

        is AgentEvent.ErrorEvent ->
            state.copy(error = event.error)

        else -> state
    }

    private inline fun updateLastAssistant(
        state: ChatUiState,
        transform: (ChatMessage.Assistant) -> ChatMessage.Assistant,
    ): ChatUiState {
        val index = state.messages.indexOfLast { it is ChatMessage.Assistant }
        if (index < 0) return state
        val updated = state.messages.toMutableList()
        updated[index] = transform(updated[index] as ChatMessage.Assistant)
        return state.copy(messages = updated)
    }
}
