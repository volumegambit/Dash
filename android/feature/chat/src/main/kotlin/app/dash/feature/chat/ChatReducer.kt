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
            updateLastAssistant(state) {
                it.copy(text = it.text + event.text, blocks = it.blocks.appendText(event.text))
            }

        is AgentEvent.ThinkingDelta ->
            updateLastAssistant(state) {
                it.copy(thinking = it.thinking + event.text, blocks = it.blocks.appendThinking(event.text))
            }

        is AgentEvent.ToolUseStart ->
            updateLastAssistant(state) {
                val call = ToolCall(event.id, event.name)
                it.copy(toolCalls = it.toolCalls + call, blocks = it.blocks + AssistantBlock.Tool(call))
            }

        is AgentEvent.ToolResult ->
            updateLastAssistant(state) { assistant ->
                val existing = assistant.toolCalls.any { it.id == event.id }
                val calls = assistant.toolCalls.map { call ->
                        if (call.id == event.id) {
                            call.copy(result = event.content, isError = event.isError == true)
                        } else {
                            call
                        }
                    }.let { calls ->
                        if (existing) calls else calls + ToolCall(
                            event.id,
                            event.name,
                            event.content,
                            event.isError == true,
                        )
                    }
                val updated = calls.first { it.id == event.id }
                assistant.copy(
                    toolCalls = calls,
                    blocks = assistant.blocks.map { block ->
                        if (block is AssistantBlock.Tool && block.call.id == event.id) {
                            AssistantBlock.Tool(updated)
                        } else {
                            block
                        }
                    }.let { blocks ->
                        if (existing) blocks else blocks + AssistantBlock.Tool(updated)
                    },
                )
            }

        is AgentEvent.Question ->
            updateLastAssistant(state) {
                it.copy(question = event, blocks = it.blocks + AssistantBlock.Question(event))
            }

        is AgentEvent.WorkerSpawned -> updateLastAssistant(state) {
            val worker = WorkerCard(
                event.workerId,
                event.runId,
                event.role,
                "running",
                event.brief,
            )
            it.copy(blocks = it.blocks + AssistantBlock.Worker(worker))
        }

        is AgentEvent.WorkerStatus -> updateLastAssistant(state) {
            it.copy(blocks = it.blocks.updateWorker(event.workerId, event.runId) { worker ->
                worker.copy(role = event.role, status = event.status, detail = event.question ?: event.detail)
            })
        }

        is AgentEvent.WorkerDone -> updateLastAssistant(state) {
            it.copy(blocks = it.blocks.updateWorker(event.workerId, event.runId) { worker ->
                worker.copy(role = event.role, status = event.status, detail = event.report)
            })
        }

        is AgentEvent.FileChanged -> appendStatus(state, "Files changed", event.files.joinToString())
        is AgentEvent.AgentSpawned -> appendStatus(state, "Agent started", event.name)
        is AgentEvent.AgentRetry -> appendStatus(state, "Retrying agent", event.reason)
        is AgentEvent.ContextCompacted -> appendStatus(state, "Context compacted")
        is AgentEvent.SkillLoaded -> appendStatus(state, "Skill loaded", event.name)
        is AgentEvent.SkillCreated -> appendStatus(state, "Skill created: ${event.name}", event.description)
        is AgentEvent.McpServerError -> appendStatus(state, "MCP server error: ${event.server}", event.error)
        is AgentEvent.Unknown -> appendStatus(state, "Gateway event: ${event.type}")

        is AgentEvent.Response ->
            updateLastAssistant(state) {
                if (it.text.isEmpty()) {
                    it.copy(
                        text = event.content,
                        blocks = it.blocks.appendText(event.content),
                        done = true,
                    )
                } else {
                    it.copy(done = true)
                }
            }

        is AgentEvent.ErrorEvent ->
            appendStatus(state, "Agent error", event.error).copy(error = event.error)

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

    private fun List<AssistantBlock>.appendText(text: String): List<AssistantBlock> =
        if (lastOrNull() is AssistantBlock.Text) {
            dropLast(1) + AssistantBlock.Text((last() as AssistantBlock.Text).text + text)
        } else {
            this + AssistantBlock.Text(text)
        }

    private fun List<AssistantBlock>.appendThinking(text: String): List<AssistantBlock> =
        if (lastOrNull() is AssistantBlock.Thinking) {
            dropLast(1) + AssistantBlock.Thinking((last() as AssistantBlock.Thinking).text + text)
        } else {
            this + AssistantBlock.Thinking(text)
        }

    private fun appendStatus(state: ChatUiState, title: String, detail: String? = null): ChatUiState =
        updateLastAssistant(state) {
            it.copy(blocks = it.blocks + AssistantBlock.Status(title, detail))
        }

    private fun List<AssistantBlock>.updateWorker(
        workerId: String,
        runId: String,
        update: (WorkerCard) -> WorkerCard,
    ): List<AssistantBlock> {
        var found = false
        val updated = map { block ->
            if (block is AssistantBlock.Worker &&
                block.worker.workerId == workerId && block.worker.runId == runId
            ) {
                found = true
                AssistantBlock.Worker(update(block.worker))
            } else {
                block
            }
        }
        return if (found) updated else updated + AssistantBlock.Worker(
            update(WorkerCard(workerId, runId, "Worker", "running")),
        )
    }
}
