import type { MemoryInfo, MemoryStore } from '@dash/agent';
import type { StructuredLogger } from '@dash/logging';
import type { ConversationService } from './conversation-service.js';
import type { SweepCandidate } from './memory-sweep-extract.js';

export interface MemorySweepInput {
  agentId: string;
  conversationId: string;
  turnId: string;
}

export interface MemorySweepService {
  /** Queue a sweep for a finished turn. Never throws; never blocks the turn. */
  schedule(input: MemorySweepInput): void;
  /** Await every in-flight sweep (tests and shutdown). */
  flush(): Promise<void>;
}

export interface MemorySweepOptions {
  conversations: Pick<ConversationService, 'listMessages'>;
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
  logger?: Pick<StructuredLogger, 'info' | 'warn'>;
}

const SELF_SAVE_TOOLS = new Set(['save_memory', 'forget_memory']);

/**
 * How many trailing messages to scan for the turn. `listMessages` returns the
 * newest page ordered oldest-first, and the sweep runs immediately after the
 * turn, so the turn's own messages are always inside it.
 */
const TURN_LOOKBACK = 20;

/** Pull the user text and the assistant's final text for one turn; null when the turn is not found. */
function readTurn(
  conversations: Pick<ConversationService, 'listMessages'>,
  conversationId: string,
  turnId: string,
): { userText: string; assistantText: string; selfSaved: boolean } | null {
  const page = conversations.listMessages({ conversationId, limit: TURN_LOOKBACK });
  const mine = page.items.filter((m) => m.turnId === turnId);
  if (mine.length === 0) return null;
  let userText = '';
  let assistantText = '';
  let selfSaved = false;
  for (const message of mine) {
    const content = message.content;
    if (content.type === 'user') userText = content.text ?? '';
    if (content.type === 'assistant') {
      for (const event of content.events ?? []) {
        if (event.type === 'response' && typeof event.content === 'string') {
          assistantText = event.content;
        }
        if (
          event.type === 'tool_result' &&
          SELF_SAVE_TOOLS.has(String(event.name)) &&
          !event.isError
        ) {
          selfSaved = true;
        }
      }
    }
  }
  return { userText, assistantText, selfSaved };
}

/**
 * Post-turn memory sweep: for models that do not save memories themselves, ask
 * a model after each finished turn whether the exchange contained anything
 * worth remembering, and write what it returns.
 *
 * Every failure is logged and swallowed — a sweep must never affect the turn's
 * outcome. Sweeps coalesce per conversation: a schedule that arrives while one
 * is running triggers exactly one rerun afterwards.
 */
export function createMemorySweepService(options: MemorySweepOptions): MemorySweepService {
  const pending = new Map<string, Promise<void>>();
  const rerun = new Map<string, MemorySweepInput>();

  const runOnce = async (input: MemorySweepInput): Promise<void> => {
    const store = options.memoryStore(input.agentId);
    if (!store || !options.shouldSweep(input.agentId)) return;
    const turn = readTurn(options.conversations, input.conversationId, input.turnId);
    // Nothing to work with, or the model already handled its own memory.
    if (!turn || turn.selfSaved || (!turn.userText && !turn.assistantText)) return;

    const index = await store.list();
    const candidates = await options.extract({
      agentId: input.agentId,
      userText: turn.userText,
      assistantText: turn.assistantText,
      index,
    });

    let saved = 0;
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
        try {
          await runOnce(input);
          const next = rerun.get(key);
          if (next) {
            rerun.delete(key);
            await runOnce(next);
          }
        } catch (error) {
          options.logger?.warn('memory sweep failed', {
            conversationId: key,
            error: error instanceof Error ? error.message : String(error),
          });
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
