import { join } from 'node:path';
import type { LessonBook, LessonDelta } from '@dash/agent';
import { listBooks, looksLikeCorrection, mergeDeltas, persistBook, readBook } from '@dash/agent';
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
  /**
   * Every skill name already visible to the agent — plugin, installed,
   * user-authored, and agent-authored via `create_skill`.
   *
   * Supplied so the merge can refuse to write a lesson book onto a skill that
   * is not one, which would either replace instructions somebody meant to keep
   * or shadow a plugin skill of the same name in discovery.
   */
  existingSkillNames?(agentId: string): Promise<string[]>;
  extract(input: {
    agentId: string;
    userText: string;
    assistantText: string;
    books: LessonBook[];
    loadedSkills: string[];
    existingSkills?: string[];
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
    //
    // A correction is exempt. "Stop doing that, always do this instead" is the
    // most valuable thing a session can teach, and it typically runs one tool
    // call or none — so counting tool calls alone would discard precisely the
    // signal this feature exists to capture.
    const enoughWork = turn.toolCalls >= options.minToolCalls(input.agentId);
    if (!enoughWork && !looksLikeCorrection(turn.userText)) return;
    if (!turn.userText && !turn.assistantText) return;

    const books = await listBooks(managedDir);
    // Resolved BEFORE the review so the names can go into the prompt: the merge
    // drops a colliding name, but a model told a rule it cannot check plays
    // safe and proposes nothing, which silently disables learning.
    const reservedNames = (await options
      .existingSkillNames?.(input.agentId)
      .catch(() => [] as string[])) as string[] | undefined;

    const deltas = await options.extract({
      agentId: input.agentId,
      userText: turn.userText,
      assistantText: turn.assistantText,
      books,
      loadedSkills: turn.loadedSkills,
      existingSkills: reservedNames,
    });
    // Logged rather than returning silently: a review that records nothing is
    // indistinguishable from a review that never ran, which makes a broken loop
    // invisible. One line per reviewed turn is worth that.
    if (deltas.length === 0) {
      options.logger?.info('skill review found nothing to record', {
        agentId: input.agentId,
        conversationId: input.conversationId,
      });
      return;
    }

    const merged = mergeDeltas(books, deltas, { reservedNames });

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

/**
 * Remove one lesson from a book, by id.
 *
 * Retires rather than deletes, for the same reason the merge does: a lesson
 * that is gone without trace cannot be understood later, and a retired lesson
 * is also protected from being re-proposed by a future review.
 *
 * Returns the updated book, or null when the skill or the lesson is unknown.
 */
export async function retireLesson(
  managedDir: string,
  skill: string,
  lessonId: string,
): Promise<LessonBook | null> {
  const skillDir = join(managedDir, skill);
  const book = await readBook(skillDir);
  if (!book) return null;

  const lesson = book.bullets.find((bullet) => bullet.id === lessonId);
  if (!lesson) return null;

  const updated: LessonBook = {
    ...book,
    bullets: book.bullets.filter((bullet) => bullet.id !== lessonId),
    retired: [
      ...book.retired,
      { ...lesson, retiredAt: new Date().toISOString().slice(0, 10), retiredReason: 'harmful' },
    ],
  };

  await persistBook(managedDir, updated);
  return updated;
}
