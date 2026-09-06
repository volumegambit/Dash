import type { LessonBook, LessonDelta } from '@dash/agent';
import { listBooks, mergeDeltas, persistBook } from '@dash/agent';
import type { StructuredLogger } from '@dash/logging';
import type { ConversationService } from './conversation-service.js';

export interface SkillReviewInput {
  agentId: string;
  conversationId: string;
  turnId: string;
}

export interface SkillLearnedReport {
  agentId: string;
  conversationId: string;
  /** Books that changed. */
  skills: string[];
  /** Books created by this review. */
  created: string[];
}

export interface SkillReviewService {
  /** Queue a review for a finished turn. Never throws; never blocks the turn. */
  schedule(input: SkillReviewInput): void;
  /** Await every in-flight review (tests and shutdown). */
  flush(): Promise<void>;
}

export interface SkillReviewOptions {
  conversations: Pick<ConversationService, 'listMessages'>;
  /** Null when the agent has no managed skills directory to write to. */
  managedSkillsDir(agentId: string): string | null;
  /** Per-agent policy gate (`skills.learning`). */
  shouldReview(agentId: string): boolean;
  /** Minimum completed tool calls in the turn before a review is worth paying for. */
  minToolCalls(agentId: string): number;
  extract(input: {
    agentId: string;
    userText: string;
    assistantText: string;
    books: LessonBook[];
    loadedSkills: string[];
  }): Promise<LessonDelta[]>;
  onLearned?(report: SkillLearnedReport): void;
  logger?: Pick<StructuredLogger, 'info' | 'warn'>;
}

/**
 * How many trailing messages to scan for the turn. `listMessages` returns the
 * newest page ordered oldest-first and the review runs immediately after the
 * turn, so the turn's own messages are always inside it.
 */
const TURN_LOOKBACK = 40;

interface TurnFacts {
  userText: string;
  assistantText: string;
  /** Completed tool calls — the effort signal the gate reads. */
  toolCalls: number;
  loadedSkills: string[];
}

/**
 * Pull what the review needs from one finished turn.
 *
 * Tool-call count rather than message length is the effort signal: a long
 * conversational turn teaches nothing reusable, while a short turn that ran
 * five tools usually does.
 */
function readTurn(
  conversations: Pick<ConversationService, 'listMessages'>,
  conversationId: string,
  turnId: string,
): TurnFacts | null {
  const page = conversations.listMessages({ conversationId, limit: TURN_LOOKBACK });
  const mine = page.items.filter((m) => m.turnId === turnId);
  if (mine.length === 0) return null;

  let userText = '';
  let assistantText = '';
  let toolCalls = 0;
  const loadedSkills: string[] = [];

  for (const message of mine) {
    const content = message.content;
    if (content.type === 'user') userText = content.text ?? '';
    if (content.type !== 'assistant') continue;

    for (const event of content.events ?? []) {
      if (event.type === 'response' && typeof event.content === 'string') {
        assistantText = event.content;
      }
      if (event.type === 'tool_result') toolCalls++;
      if (event.type === 'tool_use_start' && event.name === 'load_skill') {
        const name = (event.input as { name?: unknown } | undefined)?.name;
        if (typeof name === 'string' && !loadedSkills.includes(name)) loadedSkills.push(name);
      }
    }
  }

  return { userText, assistantText, toolCalls, loadedSkills };
}

/**
 * Post-turn skill review: after a turn that did real work, ask the agent's own
 * model whether the session produced a durable lesson, then merge what comes
 * back into the agent's own lesson books.
 *
 * Every failure is logged and swallowed — a review must never affect the turn's
 * outcome. Reviews coalesce per conversation: a schedule arriving while one is
 * running triggers exactly one rerun afterwards.
 */
export function createSkillReviewService(options: SkillReviewOptions): SkillReviewService {
  const pending = new Map<string, Promise<void>>();
  const rerun = new Map<string, SkillReviewInput>();

  const runOnce = async (input: SkillReviewInput): Promise<void> => {
    if (!options.shouldReview(input.agentId)) return;
    const managedDir = options.managedSkillsDir(input.agentId);
    if (!managedDir) return;

    const turn = readTurn(options.conversations, input.conversationId, input.turnId);
    if (!turn) return;

    // The effort gate, checked before anything is spent. A conversational turn
    // schedules nothing and costs nothing.
    if (turn.toolCalls < options.minToolCalls(input.agentId)) return;
    if (!turn.userText && !turn.assistantText) return;

    const books = await listBooks(managedDir);
    const deltas = await options.extract({
      agentId: input.agentId,
      userText: turn.userText,
      assistantText: turn.assistantText,
      books,
      loadedSkills: turn.loadedSkills,
    });
    if (deltas.length === 0) return;

    const merged = mergeDeltas(books, deltas);

    for (const dropped of merged.dropped) {
      options.logger?.warn('skill review dropped a lesson', {
        agentId: input.agentId,
        skill: dropped.delta.skill,
        reason: dropped.reason,
      });
    }

    const written: string[] = [];
    for (const book of merged.books) {
      try {
        await persistBook(managedDir, book);
        written.push(book.skill);
      } catch (error) {
        // One unwritable book must not lose the others.
        options.logger?.warn('skill review could not write a lesson book', {
          agentId: input.agentId,
          skill: book.skill,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (written.length === 0) return;

    options.logger?.info('skill review recorded lessons', {
      agentId: input.agentId,
      conversationId: input.conversationId,
      skills: written,
      created: merged.created,
    });
    options.onLearned?.({
      agentId: input.agentId,
      conversationId: input.conversationId,
      skills: written,
      created: merged.created.filter((name) => written.includes(name)),
    });
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
          options.logger?.warn('skill review failed', {
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
