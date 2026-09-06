import { randomUUID } from 'node:crypto';
import type { LessonBook, LessonDelta } from '@dash/agent';
import {
  listBooks,
  looksLikeCorrection,
  mergeDeltas,
  persistBook,
  stagePending,
} from '@dash/agent';
import type { StructuredLogger } from '@dash/logging';
import type { ConversationService } from './conversation-service.js';

export interface SkillReviewInput {
  agentId: string;
  conversationId: string;
  runId: string;
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
  /** Queue a review for a finished run. Never throws; never blocks the run. */
  schedule(input: SkillReviewInput): void;
  /** Await every in-flight review (tests and shutdown). */
  flush(): Promise<void>;
}

export interface SkillReviewOptions {
  conversations: Pick<ConversationService, 'listRunMessages'>;
  /** Null when the agent has no managed skills directory to write to. */
  managedSkillsDir(agentId: string): string | null;
  /** Per-agent policy gate (`skills.learning`). */
  shouldReview(agentId: string): boolean;
  /** Minimum completed tool calls in the run before a review is worth paying for. */
  minToolCalls(agentId: string): number;
  /** When true, proposals are staged for human approval instead of applied. */
  requiresApproval?(agentId: string): boolean;
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

interface RunFacts {
  userText: string;
  assistantText: string;
  /** Completed tool calls — the effort signal the gate reads. */
  toolCalls: number;
  loadedSkills: string[];
}

/**
 * Pull what the review needs from one finished run.
 *
 * Tool-call count rather than message length is the effort signal: a long
 * conversational run teaches nothing reusable, while a short run that ran
 * five tools usually does.
 */
function readRun(
  conversations: Pick<ConversationService, 'listRunMessages'>,
  conversationId: string,
  runId: string,
): RunFacts | null {
  const messages = conversations.listRunMessages(conversationId, runId);
  if (messages.length === 0) return null;

  const userTexts: string[] = [];
  const assistantTexts: string[] = [];
  let toolCalls = 0;
  const loadedSkills: string[] = [];

  for (const message of messages) {
    const content = message.content;
    if (content.type === 'user') {
      if (message.deliveryKind === 'steer' && message.deliveryStatus !== 'delivered') continue;
      if (content.text) userTexts.push(content.text);
      continue;
    }
    if (content.type !== 'assistant') continue;

    let finalResponse = '';
    for (const event of content.events ?? []) {
      if (event.type === 'response' && typeof event.content === 'string') {
        finalResponse = event.content;
      }
      if (event.type === 'tool_result') toolCalls++;
      if (event.type === 'tool_use_start' && event.name === 'load_skill') {
        const name = (event.input as { name?: unknown } | undefined)?.name;
        if (typeof name === 'string' && !loadedSkills.includes(name)) loadedSkills.push(name);
      }
    }
    if (finalResponse) assistantTexts.push(finalResponse);
  }

  return {
    userText: userTexts.join('\n\n'),
    assistantText: assistantTexts.join('\n\n'),
    toolCalls,
    loadedSkills,
  };
}

/**
 * Post-run skill review: after a run that did real work, ask the agent's own
 * model whether the session produced a durable lesson, then merge what comes
 * back into the agent's own lesson books.
 *
 * Every failure is logged and swallowed — a review must never affect the run's
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

    const run = readRun(options.conversations, input.conversationId, input.runId);
    if (!run) return;

    // The effort gate, checked before anything is spent. A conversational turn
    // schedules nothing and costs nothing.
    //
    // A correction is exempt. "Stop doing that, always do this instead" is the
    // most valuable thing a session can teach, and it typically runs one tool
    // call or none — so counting tool calls alone would discard precisely the
    // signal this feature exists to capture.
    const enoughWork = run.toolCalls >= options.minToolCalls(input.agentId);
    if (!enoughWork && !looksLikeCorrection(run.userText)) return;
    if (!run.userText && !run.assistantText) return;

    const books = await listBooks(managedDir);
    // Resolved BEFORE the review so the names can go into the prompt: the merge
    // drops a colliding name, but a model told a rule it cannot check plays
    // safe and proposes nothing, which silently disables learning.
    const reservedNames = (await options
      .existingSkillNames?.(input.agentId)
      .catch(() => [] as string[])) as string[] | undefined;

    const deltas = await options.extract({
      agentId: input.agentId,
      userText: run.userText,
      assistantText: run.assistantText,
      books,
      loadedSkills: run.loadedSkills,
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

    // The approval gate. Deltas are staged rather than merged, so approving
    // later re-runs every merge rule against the library as it is at that
    // point rather than as it was when the review ran.
    if (options.requiresApproval?.(input.agentId)) {
      const id = `${input.runId}`.replace(/[^a-z0-9-]/gi, '').slice(0, 64) || randomUUID();
      await stagePending(managedDir, {
        id,
        conversationId: input.conversationId,
        deltas,
      });
      options.logger?.info('skill review staged lessons for approval', {
        agentId: input.agentId,
        conversationId: input.conversationId,
        id,
        lessons: deltas.length,
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
        let next: SkillReviewInput | undefined = input;
        try {
          while (next) {
            try {
              await runOnce(next);
            } catch (error) {
              options.logger?.warn('skill review failed', {
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

/**
 * Apply a previously staged proposal.
 *
 * Shares the merge with the unattended path deliberately: approval decides
 * *whether* lessons land, never *how*. Returns the books that changed.
 */
export async function applyPendingLessons(
  managedDir: string,
  deltas: LessonDelta[],
  reservedNames?: string[],
): Promise<{ skills: string[]; created: string[] }> {
  const books = await listBooks(managedDir);
  const merged = mergeDeltas(books, deltas, { reservedNames });

  const written: string[] = [];
  for (const book of merged.books) {
    await persistBook(managedDir, book);
    written.push(book.skill);
  }

  return {
    skills: written,
    created: merged.created.filter((name) => written.includes(name)),
  };
}
