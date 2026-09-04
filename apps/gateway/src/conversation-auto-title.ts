import type { StructuredLogger } from '@dash/logging';
import type { ConversationSummary } from '@dash/mobile-contract';
import type { ConversationService } from './conversation-service.js';

export interface ConversationAutoTitleService {
  schedule(input: { conversationId: string; agentId: string; text: string }): void;
  flush(): Promise<void>;
}

export interface ConversationAutoTitleOptions {
  conversations: ConversationService;
  generateTitle(input: { agentId: string; text: string }): Promise<string>;
  onChanged?(summary: ConversationSummary): void;
  logger?: Pick<StructuredLogger, 'warn'>;
}

export function createConversationAutoTitleService(
  options: ConversationAutoTitleOptions,
): ConversationAutoTitleService {
  const pending = new Map<string, Promise<void>>();

  return {
    schedule(input) {
      if (pending.has(input.conversationId)) return;
      let generated: Promise<string>;
      try {
        generated = options.generateTitle({ agentId: input.agentId, text: input.text });
      } catch (error) {
        generated = Promise.reject(error);
      }
      const job = generated
        .then((title) => options.conversations.trySetAutoTitle(input.conversationId, title))
        .then((summary) => {
          if (summary) options.onChanged?.(summary);
        })
        .catch((error) => {
          options.logger?.warn('conversation auto-title failed', {
            conversationId: input.conversationId,
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          pending.delete(input.conversationId);
        });
      pending.set(input.conversationId, job);
    },

    async flush() {
      while (pending.size > 0) {
        await Promise.all([...pending.values()]);
      }
    },
  };
}
