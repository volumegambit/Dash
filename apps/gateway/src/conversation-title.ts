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

const SYSTEM_PROMPT =
  'You title chat conversations. Given the opening user message, reply with ' +
  'ONLY a concise title of 3 to 6 words in the same language as the message. ' +
  'Plain text: no quotes, no trailing punctuation, no emoji, no explanations.';

/** Longest prefix of the user message the title model sees. */
const MAX_INPUT_CHARS = 2000;

/** Hard cap applied to whatever the model returns. */
export const MAX_TITLE_CHARS = 60;

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
 * Generate a short conversation title from the user's opening message with a
 * single cheap completion on the agent's own model (its provider credentials
 * are guaranteed to exist — the agent could not chat otherwise).
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
  completeFn?: CompleteFn;
}): Promise<string> {
  const { modelStr, allowedProviders, pluginModelCatalog, providerApiKeys, text } = options;
  const completeFn = options.completeFn ?? complete;

  const model = resolveModelString(modelStr, pluginModelCatalog, allowedProviders);
  const apiKey = providerApiKeys[model.provider];
  if (!apiKey) {
    throw new Error(`No API key stored for provider "${model.provider}"`);
  }

  const message = await completeFn(
    model,
    {
      systemPrompt: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: text.slice(0, MAX_INPUT_CHARS), timestamp: Date.now() }],
    },
    { apiKey, maxTokens: 64, temperature: 0.2 },
  );

  const raw = message.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join(' ');
  const title = sanitizeTitle(raw);
  if (!title) throw new Error('Title model returned no usable text');
  return title;
}
