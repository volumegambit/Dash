import type { LessonBook, LessonDelta, PluginModelCatalog } from '@dash/agent';
import { LESSON_LIMITS, buildReviewPrompt, flattenOneLine, resolveModelString } from '@dash/agent';
import { complete } from '@earendil-works/pi-ai';
import type { CompleteFn } from './conversation-title.js';

/** Longest prefix of each side of the exchange the review model sees. */
const MAX_SIDE_CHARS = 4000;

export type LearningPolicy = 'auto' | 'on' | 'off';

/**
 * Completed tool calls a turn must have made before a review is worth paying
 * for. Three is low enough to catch a short debugging exchange and high enough
 * that pure conversation never triggers a call.
 */
export const DEFAULT_MIN_TOOL_CALLS = 3;

/**
 * Whether skill learning runs for this agent.
 *
 * Unlike the memory sweep — where `'auto'` *disables* the sweep for frontier
 * models because those models reliably save memories themselves — skill
 * learning has no self-save path to defer to. No model spontaneously stops
 * mid-task to reconsider its skill library. So `'auto'` means on.
 */
export function shouldReviewSkills(policy: LearningPolicy | undefined): boolean {
  return policy !== 'off';
}

function readText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readAugments(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
}

/**
 * Parse the review model's reply into deltas.
 *
 * Tolerant by construction: a review that returns unusable output must cost one
 * wasted call, never a failed turn. Every malformed delta is dropped
 * individually so one bad entry cannot discard the good ones alongside it.
 */
export function parseReviewReply(raw: string): LessonDelta[] {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return [];

  let parsed: { deltas?: unknown };
  try {
    parsed = JSON.parse(raw.slice(start, end + 1)) as { deltas?: unknown };
  } catch {
    return [];
  }
  if (!Array.isArray(parsed.deltas)) return [];

  const out: LessonDelta[] = [];
  for (const item of parsed.deltas) {
    if (!item || typeof item !== 'object') continue;
    const d = item as Record<string, unknown>;
    const skill = readText(d.skill);
    if (!skill) continue;

    if (d.op === 'add') {
      // Flattened here, at the boundary, so nothing downstream ever holds a
      // multi-line lesson: the text is replayed into a later review prompt as
      // well as into SKILL.md.
      const text = flattenOneLine(readText(d.text), LESSON_LIMITS.maxLessonChars);
      if (!text) continue;
      out.push({
        op: 'add',
        skill,
        text,
        description: flattenOneLine(readText(d.description), 200),
        augments: readAugments(d.augments),
      });
      continue;
    }

    if (d.op === 'helpful' || d.op === 'harmful') {
      const id = readText(d.id);
      if (!id) continue;
      if (d.op === 'helpful') out.push({ op: 'helpful', skill, id });
      else out.push({ op: 'harmful', skill, id, reason: flattenOneLine(readText(d.reason), 200) });
    }
  }
  return out;
}

/**
 * Ask the agent's own model what this turn should have taught it.
 *
 * One completion, on the agent's own model with the agent's own credentials, so
 * turn text never reaches a provider the agent is not already talking to. The
 * caller swallows failures — a review never affects the turn.
 *
 * Throws on resolution/credential/provider errors.
 */
export async function extractLessonDeltas(options: {
  /** Agent's `provider/model` string. */
  modelStr: string;
  /** Agent's provider allow-list (same gate as the chat loop). */
  allowedProviders?: string[];
  pluginModelCatalog: PluginModelCatalog | undefined;
  /** provider id -> API key, from the gateway credential store. */
  providerApiKeys: Record<string, string>;
  userText: string;
  assistantText: string;
  /** Lessons the agent already holds, so it can mark them instead of restating. */
  books: LessonBook[];
  /** Skills loaded during the turn under review. */
  loadedSkills: string[];
  completeFn?: CompleteFn;
}): Promise<LessonDelta[]> {
  const completeFn = options.completeFn ?? complete;
  const model = resolveModelString(
    options.modelStr,
    options.pluginModelCatalog,
    options.allowedProviders,
  );
  const apiKey = options.providerApiKeys[model.provider];
  if (!apiKey) throw new Error(`No API key stored for provider "${model.provider}"`);

  const exchange = `USER:\n${options.userText.slice(0, MAX_SIDE_CHARS)}\n\nASSISTANT:\n${options.assistantText.slice(0, MAX_SIDE_CHARS)}`;

  const message = await completeFn(
    model,
    {
      systemPrompt: buildReviewPrompt({
        books: options.books,
        loadedSkills: options.loadedSkills,
      }),
      messages: [{ role: 'user', content: exchange, timestamp: Date.now() }],
    },
    { apiKey, maxTokens: 1200, temperature: 0.1 },
  );

  const raw = message.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join(' ');

  return parseReviewReply(raw);
}
