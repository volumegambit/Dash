import { resolveModelString } from '@dash/agent';
import type { PluginModelCatalog } from '@dash/agent';
import type { Api, AssistantMessage, Context, Model, StreamOptions } from '@earendil-works/pi-ai';
import { complete } from '@earendil-works/pi-ai';

/**
 * Signature of pi-ai's `complete` — injectable so route tests can stub the
 * LLM call without network access.
 */
export type CompleteFn = (
  model: Model<Api>,
  context: Context,
  options?: StreamOptions,
) => Promise<AssistantMessage>;

/** A project candidate offered to the model for classification. */
export interface ProjectCandidate {
  key: string;
  name: string;
  description?: string;
}

const TITLE_RULES =
  'a concise title of 3 to 6 words in the same language as the message — ' +
  'plain text, no quotes, no trailing punctuation, no emoji';

const TITLE_ONLY_PROMPT = `You title chat conversations. Given the opening user message, reply with ONLY ${TITLE_RULES}. No explanations.`;

function titleAndProjectPrompt(projects: ProjectCandidate[]): string {
  const list = projects
    .map((p) => `- ${p.key}: ${p.name}${p.description ? ` — ${p.description}` : ''}`)
    .join('\n');
  return `You title chat conversations and classify them into projects. Given the opening user message, reply with ONLY minified JSON of the shape {"title":"...","project":"..."} where title is ${TITLE_RULES}, and project is the KEY of the single best-matching project from the list below, or null when the message does not clearly relate to any of them. No explanations.\n\nProjects:\n${list}`;
}

/** Longest prefix of the user message the title model sees. */
const MAX_INPUT_CHARS = 2000;

/** Hard cap applied to whatever the model returns. */
export const MAX_TITLE_CHARS = 60;

/** Most project candidates offered to the model. */
const MAX_PROJECT_CANDIDATES = 25;

/**
 * Normalize a model reply into a list-friendly title: single line, no
 * wrapping quotes, no trailing punctuation, capped at {@link MAX_TITLE_CHARS}.
 * Returns '' when nothing usable remains — callers treat that as a failure
 * and keep their fallback title.
 */
export function sanitizeTitle(raw: string): string {
  let title = raw.split('\n')[0].trim();
  title = title.replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '').trim();
  title = title.replace(/[.!?,;:]+$/g, '').trim();
  if (title.length > MAX_TITLE_CHARS) {
    const cut = title.slice(0, MAX_TITLE_CHARS);
    const lastSpace = cut.lastIndexOf(' ');
    title = (lastSpace > 20 ? cut.slice(0, lastSpace) : cut).trim();
  }
  return title;
}

/**
 * Parse the title/project JSON reply. Tolerant of wrapping prose or code
 * fences; falls back to treating the whole reply as a plain title when no
 * parsable object is found (small models occasionally ignore the format).
 */
export function parseTitleReply(
  raw: string,
  projects: ProjectCandidate[],
): { title: string; projectKey: string | null } {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1)) as {
        title?: unknown;
        project?: unknown;
      };
      const title = typeof parsed.title === 'string' ? sanitizeTitle(parsed.title) : '';
      const wanted = typeof parsed.project === 'string' ? parsed.project.trim().toLowerCase() : '';
      const match = wanted ? (projects.find((p) => p.key.toLowerCase() === wanted) ?? null) : null;
      if (title) return { title, projectKey: match?.key ?? null };
    } catch {
      // fall through to plain-title handling
    }
  }
  return { title: sanitizeTitle(raw), projectKey: null };
}

/**
 * Generate a short conversation title — and, when project candidates are
 * provided, classify the conversation into one of them — from the user's
 * opening message with a single cheap completion on the agent's own model
 * (its provider credentials are guaranteed to exist — the agent could not
 * chat otherwise).
 *
 * Throws on resolution/credential/provider errors; the caller decides the
 * fallback (MC keeps its truncated-first-message title).
 */
export async function generateConversationTitle(options: {
  /** Agent's `provider/model` string. */
  modelStr: string;
  /** Agent's provider allow-list (same gate as the chat loop). */
  allowedProviders?: string[];
  pluginModelCatalog: PluginModelCatalog | undefined;
  /** provider id -> API key, from the gateway credential store. */
  providerApiKeys: Record<string, string>;
  /** The user's first message. */
  text: string;
  /** Active projects the conversation may belong to (may be empty). */
  projects?: ProjectCandidate[];
  completeFn?: CompleteFn;
}): Promise<{ title: string; projectKey: string | null }> {
  const { modelStr, allowedProviders, pluginModelCatalog, providerApiKeys, text } = options;
  const completeFn = options.completeFn ?? complete;
  const projects = (options.projects ?? []).slice(0, MAX_PROJECT_CANDIDATES);

  const model = resolveModelString(modelStr, pluginModelCatalog, allowedProviders);
  const apiKey = providerApiKeys[model.provider];
  if (!apiKey) {
    throw new Error(`No API key stored for provider "${model.provider}"`);
  }

  const message = await completeFn(
    model,
    {
      systemPrompt: projects.length ? titleAndProjectPrompt(projects) : TITLE_ONLY_PROMPT,
      messages: [{ role: 'user', content: text.slice(0, MAX_INPUT_CHARS), timestamp: Date.now() }],
    },
    { apiKey, maxTokens: 128, temperature: 0.2 },
  );

  const raw = message.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join(' ');

  const result = projects.length
    ? parseTitleReply(raw, projects)
    : { title: sanitizeTitle(raw), projectKey: null };
  if (!result.title) throw new Error('Title model returned no usable text');
  return result;
}
