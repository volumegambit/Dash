import type { LlmProvider, Message, TextBlock } from './types.js';

const COMPACTION_SYSTEM_PROMPT = `Summarize this conversation for a long-running AI agent. Include:
- Goal: what the user is trying to accomplish
- Discoveries: key facts, decisions, context uncovered
- Accomplished: actions taken and outcomes
- Relevant Files: file paths, tools, or resources involved
- Next Steps: what still needs to be done

Be specific — include exact file paths, command names, and error messages where relevant. Format as markdown.`;

export function estimateTokens(messages: Message[]): number {
  let totalChars = 0;
  for (const message of messages) {
    if (typeof message.content === 'string') {
      totalChars += message.content.length;
    } else {
      totalChars += JSON.stringify(message.content).length;
    }
  }
  return Math.ceil(totalChars / 4);
}

export function shouldCompact(messages: Message[], modelContextWindow: number): boolean {
  return estimateTokens(messages) > modelContextWindow * 0.8;
}

export async function compactSession(
  messages: Message[],
  provider: LlmProvider,
  model: string,
): Promise<string> {
  const requestMessages: Message[] = [
    ...messages,
    { role: 'user', content: 'Please summarize this conversation.' },
  ];

  const response = await provider.complete({
    model,
    messages: requestMessages,
    systemPrompt: COMPACTION_SYSTEM_PROMPT,
    maxTokens: 2048,
  });

  if (typeof response.content === 'string') {
    return response.content;
  }

  const summary = response.content
    .filter((block): block is TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
  if (!summary) {
    throw new Error('Compaction failed: provider returned no text content');
  }
  return summary;
}
