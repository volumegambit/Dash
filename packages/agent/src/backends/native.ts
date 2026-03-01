import type { LlmProvider, ContentBlock, ToolUseBlock, StreamChunk } from '@dash/llm';
import type { AgentBackend, AgentEvent, AgentState, RunOptions } from '../types.js';

const MAX_TOOL_ROUNDS = 25;

export class NativeBackend implements AgentBackend {
  readonly name = 'native';
  private abortController: AbortController | null = null;

  constructor(private provider: LlmProvider) {}

  async *run(state: AgentState, options: RunOptions): AsyncGenerator<AgentEvent> {
    this.abortController = new AbortController();

    const toolDefs = state.tools?.map((t) => t.definition);
    const toolMap = new Map(state.tools?.map((t) => [t.name, t]) ?? []);

    let totalUsage = { inputTokens: 0, outputTokens: 0 };
    let finalTextContent = '';

    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        if (this.abortController.signal.aborted) break;

        const stream = this.provider.stream({
          model: state.model,
          systemPrompt: state.systemPrompt,
          messages: state.session.messages,
          maxTokens: state.maxTokens,
          tools: toolDefs,
          thinking: state.thinking
            ? { type: 'enabled', budgetTokens: state.thinking.budgetTokens }
            : undefined,
        });

        // Collect text and tool_use blocks from this round
        let roundText = '';
        const roundToolUses: ToolUseBlock[] = [];
        let currentToolId = '';
        let currentToolName = '';
        let currentToolJson = '';

        let result: IteratorResult<StreamChunk, import('@dash/llm').CompletionResponse>;

        while (!(result = await stream.next()).done) {
          if (this.abortController.signal.aborted) break;

          const chunk = result.value;
          if (chunk.type === 'thinking_delta' && chunk.thinking) {
            yield { type: 'thinking_delta', text: chunk.thinking };
          } else if (chunk.type === 'text_delta' && chunk.text) {
            roundText += chunk.text;
            options.onChunk?.(chunk.text);
            yield { type: 'text_delta', text: chunk.text };
          } else if (chunk.type === 'tool_use_start' && chunk.toolUse) {
            currentToolId = chunk.toolUse.id;
            currentToolName = chunk.toolUse.name;
            currentToolJson = '';
            yield {
              type: 'tool_use_start',
              id: chunk.toolUse.id,
              name: chunk.toolUse.name,
            };
          } else if (chunk.type === 'tool_use_delta' && chunk.toolUseDelta) {
            currentToolJson += chunk.toolUseDelta.partial_json;
            yield {
              type: 'tool_use_delta',
              partial_json: chunk.toolUseDelta.partial_json,
            };
          } else if (chunk.type === 'stop' && currentToolId) {
            // Finalize accumulated tool use block
            let input: Record<string, unknown> = {};
            try {
              input = currentToolJson ? JSON.parse(currentToolJson) : {};
            } catch {
              // malformed JSON
            }
            roundToolUses.push({
              type: 'tool_use',
              id: currentToolId,
              name: currentToolName,
              input,
            });
            currentToolId = '';
            currentToolName = '';
            currentToolJson = '';
          }
        }

        // Get the return value (CompletionResponse)
        if (!result.done || !result.value) break;

        const response = result.value;
        totalUsage.inputTokens += response.usage.inputTokens;
        totalUsage.outputTokens += response.usage.outputTokens;

        // Use tool blocks from the response if available (more reliable than stream accumulation)
        const responseToolUses: ToolUseBlock[] = [];
        if (Array.isArray(response.content)) {
          for (const block of response.content) {
            if (block.type === 'tool_use') {
              responseToolUses.push(block as ToolUseBlock);
            }
          }
        }
        const toolUses = responseToolUses.length > 0 ? responseToolUses : roundToolUses;

        if (response.stopReason === 'tool_use' && toolUses.length > 0 && toolMap.size > 0) {
          // Use full response.content if available (preserves thinking blocks), else build manually
          let assistantContent: ContentBlock[];
          if (Array.isArray(response.content)) {
            assistantContent = response.content;
          } else {
            assistantContent = [];
            if (roundText) assistantContent.push({ type: 'text', text: roundText });
            assistantContent.push(...toolUses);
          }
          state.session.messages.push({ role: 'assistant', content: assistantContent });

          // Execute each tool and collect results
          const resultBlocks: ContentBlock[] = [];
          for (const tu of toolUses) {
            const tool = toolMap.get(tu.name);
            let toolResult: { content: string; isError?: boolean };

            if (!tool) {
              toolResult = { content: `Unknown tool: ${tu.name}`, isError: true };
            } else {
              toolResult = await tool.execute(tu.input);
            }

            yield {
              type: 'tool_result',
              id: tu.id,
              name: tu.name,
              content: toolResult.content,
              isError: toolResult.isError,
            };

            resultBlocks.push({
              type: 'tool_result',
              tool_use_id: tu.id,
              content: toolResult.content,
              is_error: toolResult.isError,
            });
          }

          // Append tool results as user message and loop
          state.session.messages.push({ role: 'user', content: resultBlocks });
          finalTextContent = ''; // reset — more text may come in next round
          continue;
        }

        // No tool use — this is the final response
        finalTextContent = typeof response.content === 'string'
          ? response.content
          : (response.content as ContentBlock[])
              .filter((b) => b.type === 'text')
              .map((b) => (b as { text: string }).text)
              .join('');

        // Push final assistant message to session (preserve thinking blocks if present)
        if (Array.isArray(response.content) && response.content.some((b) => b.type === 'thinking' || b.type === 'redacted_thinking')) {
          state.session.messages.push({ role: 'assistant', content: response.content });
        } else {
          state.session.messages.push({ role: 'assistant', content: finalTextContent });
        }

        yield {
          type: 'response',
          content: finalTextContent,
          usage: totalUsage,
        };
        return;
      }

      // If we exhausted MAX_TOOL_ROUNDS, yield what we have
      yield {
        type: 'response',
        content: finalTextContent || '(max tool rounds reached)',
        usage: totalUsage,
      };
    } catch (error) {
      yield { type: 'error', error: error as Error };
    }
  }

  abort(): void {
    this.abortController?.abort();
  }
}
