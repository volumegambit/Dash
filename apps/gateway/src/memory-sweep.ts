import type { MemoryInfo, MemoryStore } from '@dash/agent';
import type { StructuredLogger } from '@dash/logging';
import type { ConversationService } from './conversation-service.js';
import type { SweepCandidate } from './memory-sweep-extract.js';

export interface MemorySweepInput {
  agentId: string;
  conversationId: string;
  runId: string;
}

export interface MemorySweepService {
  /** Queue a sweep for a finished run. Never throws; never blocks the run. */
  schedule(input: MemorySweepInput): void;
  /** Await every in-flight sweep (tests and shutdown). */
  flush(): Promise<void>;
}

export interface MemorySweepOptions {
  conversations: Pick<ConversationService, 'listRunMessages'>;
  /** Null when memory is disabled for the agent. */
  memoryStore(agentId: string): MemoryStore | null;
  /** Per-agent sweep policy gate (model + `memory.sweep` config). */
  shouldSweep(agentId: string): boolean;
  extract(input: {
    agentId: string;
    userText: string;
    assistantText: string;
    index: MemoryInfo[];
  }): Promise<SweepCandidate[]>;
  /**
   * Called once per sweep that saved something, so the caller can tell the user.
   * The sweep runs after the turn is finalised, so this is the only route by
   * which its work becomes visible in the conversation.
   */
  onSaved?(report: { agentId: string; conversationId: string; descriptions: string[] }): void;
  logger?: Pick<StructuredLogger, 'info' | 'warn'>;
}

const SELF_SAVE_TOOLS = new Set(['save_memory', 'forget_memory']);

/** Pull the text from every segment in one run; null when the run is not found. */
function readRun(
  conversations: Pick<ConversationService, 'listRunMessages'>,
  conversationId: string,
  runId: string,
): { userText: string; assistantText: string; selfSaved: boolean } | null {
  const messages = conversations.listRunMessages(conversationId, runId);
  if (messages.length === 0) return null;
  const userTexts: string[] = [];
  const assistantTexts: string[] = [];
  let selfSaved = false;
  for (const message of messages) {
    const content = message.content;
    if (content.type === 'user') {
      if (message.deliveryKind === 'steer' && message.deliveryStatus !== 'delivered') continue;
      if (content.text) userTexts.push(content.text);
      continue;
    }
    if (content.type === 'assistant') {
      let finalResponse = '';
      for (const event of content.events ?? []) {
        if (event.type === 'response' && typeof event.content === 'string') {
          finalResponse = event.content;
        }
        if (
          event.type === 'tool_result' &&
          SELF_SAVE_TOOLS.has(String(event.name)) &&
          !event.isError
        ) {
          selfSaved = true;
        }
      }
      if (finalResponse) assistantTexts.push(finalResponse);
    }
  }
  return {
    userText: userTexts.join('\n\n'),
    assistantText: assistantTexts.join('\n\n'),
    selfSaved,
  };
}

/**
 * Post-run memory sweep: for models that do not save memories themselves, ask
 * a model after each finished run whether the exchange contained anything
 * worth remembering, and write what it returns.
 *
 * Every failure is logged and swallowed — a sweep must never affect the run's
 * outcome. Sweeps coalesce per conversation: a schedule that arrives while one
 * is running triggers exactly one rerun afterwards.
 */
export function createMemorySweepService(options: MemorySweepOptions): MemorySweepService {
  const pending = new Map<string, Promise<void>>();
  const rerun = new Map<string, MemorySweepInput>();

  const runOnce = async (input: MemorySweepInput): Promise<void> => {
    const store = options.memoryStore(input.agentId);
    if (!store || !options.shouldSweep(input.agentId)) return;
    const run = readRun(options.conversations, input.conversationId, input.runId);
    // Nothing to work with, or the model already handled its own memory.
    if (!run || run.selfSaved || (!run.userText && !run.assistantText)) return;

    const index = await store.list();
    const candidates = await options.extract({
      agentId: input.agentId,
      userText: run.userText,
      assistantText: run.assistantText,
      index,
    });

    let saved = 0;
    const savedDescriptions: string[] = [];
    for (const candidate of candidates) {
      try {
        // The sweep is unattended and driven by a weaker model: it may never
        // clobber something the user wrote by hand. That includes 'import' —
        // the legacy `MEMORY.md` the user hand-wrote in their workspace, held
        // under the larger import budget a sweep rewrite would truncate.
        const existing = await store.get(candidate.name);
        if (existing?.source === 'user' || existing?.source === 'import') {
          options.logger?.warn('memory sweep refused to overwrite a user-authored memory', {
            agentId: input.agentId,
            name: candidate.name,
          });
          continue;
        }
        await store.save({ ...candidate, source: 'sweep' });
        savedDescriptions.push(candidate.description || candidate.name);
        saved++;
      } catch (error) {
        options.logger?.warn('memory sweep dropped a candidate', {
          name: candidate.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (saved > 0) {
      options.logger?.info('memory sweep saved memories', {
        agentId: input.agentId,
        conversationId: input.conversationId,
        saved,
      });
      options.onSaved?.({
        agentId: input.agentId,
        conversationId: input.conversationId,
        descriptions: savedDescriptions,
      });
    }
  };

  return {
    schedule(input) {
      const key = input.conversationId;
      if (pending.has(key)) {
        rerun.set(key, input);
        return;
      }
      const job = (async () => {
        let next: MemorySweepInput | undefined = input;
        try {
          while (next) {
            try {
              await runOnce(next);
            } catch (error) {
              options.logger?.warn('memory sweep failed', {
                conversationId: key,
                error: error instanceof Error ? error.message : String(error),
              });
            }
            next = rerun.get(key);
            rerun.delete(key);
          }
        } finally {
          rerun.delete(key);
          pending.delete(key);
        }
      })();
      pending.set(key, job);
    },

    async flush() {
      while (pending.size > 0) {
        await Promise.all([...pending.values()]);
      }
    },
  };
}
