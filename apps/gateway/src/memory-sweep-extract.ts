import type { MemoryInfo, MemoryType, PluginModelCatalog } from '@dash/agent';
import { MEMORY_LIMITS, MEMORY_NAME_RE, isMemoryType, resolveModelString } from '@dash/agent';
import { complete } from '@earendil-works/pi-ai';
import type { CompleteFn } from './conversation-title.js';

/**
 * Providers whose models reliably call the memory tools themselves, so the
 * post-turn sweep is redundant (and would double-charge) under `'auto'`.
 */
export const FRONTIER_PROVIDERS = ['anthropic', 'openai', 'google'] as const;

export type SweepPolicy = 'auto' | 'on' | 'off';

/** 'auto' = sweep only for models whose provider is not a frontier lab (they self-save). */
export function shouldSweepModel(policy: SweepPolicy | undefined, modelStr: string): boolean {
  if (policy === 'on') return true;
  if (policy === 'off') return false;
  const provider = modelStr.split('/')[0]?.toLowerCase() ?? '';
  return !(FRONTIER_PROVIDERS as readonly string[]).includes(provider);
}

export interface SweepCandidate {
  name: string;
  description: string;
  type: MemoryType;
  content: string;
}

/** Longest prefix of each side of the exchange the sweep model sees. */
const MAX_SIDE_CHARS = 3000;

function sweepPrompt(index: MemoryInfo[]): string {
  const existing = index.length
    ? index.map((m) => `- ${m.name} (${m.type}, source: ${m.source}): ${m.description}`).join('\n')
    : '(none)';
  return `You maintain long-term memory for an assistant. Given one exchange (user message and assistant reply), decide whether it contains facts worth remembering in future conversations: who the user is (type "user"), how they want the assistant to work (type "feedback"), ongoing work or constraints (type "project"), or pointers to external resources (type "reference"). Most exchanges contain nothing worth saving — then reply {"memories":[]}.

Reply with ONLY minified JSON of the shape {"memories":[{"name":"kebab-case-slug","description":"one line","type":"user|feedback|project|reference","content":"the fact, under ${MEMORY_LIMITS.contentMax} characters"}]}. Reuse an existing name below to update it instead of creating a near-duplicate. Entries listed as "source: user" were written by the user themselves: never reuse or modify those names — if you disagree with one, propose a NEW name instead. Never save secrets, credentials, or details that only matter for this one exchange.

Existing memories:
${existing}`;
}

/** Tolerant parse of the model reply; invalid entries are dropped, never fatal. */
export function parseSweepReply(raw: string): SweepCandidate[] {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return [];
  let parsed: { memories?: unknown };
  try {
    parsed = JSON.parse(raw.slice(start, end + 1)) as { memories?: unknown };
  } catch {
    return [];
  }
  if (!Array.isArray(parsed.memories)) return [];
  const out: SweepCandidate[] = [];
  for (const item of parsed.memories) {
    if (!item || typeof item !== 'object') continue;
    const m = item as Record<string, unknown>;
    const name = typeof m.name === 'string' ? m.name.trim() : '';
    const description = typeof m.description === 'string' ? m.description.trim() : '';
    const content = typeof m.content === 'string' ? m.content.trim() : '';
    if (!MEMORY_NAME_RE.test(name) || !description || !content || !isMemoryType(m.type)) continue;
    out.push({
      name,
      description,
      type: m.type,
      content: content.slice(0, MEMORY_LIMITS.contentMax),
    });
  }
  return out;
}

/**
 * Ask the agent's own model which facts from one finished exchange are worth
 * remembering. One cheap completion; the caller decides what to do with the
 * candidates (and swallows failures — a sweep never affects the turn).
 *
 * Throws on resolution/credential/provider errors.
 */
export async function extractMemoriesWithModel(options: {
  /** Agent's `provider/model` string. */
  modelStr: string;
  /** Agent's provider allow-list (same gate as the chat loop). */
  allowedProviders?: string[];
  pluginModelCatalog: PluginModelCatalog | undefined;
  /** provider id -> API key, from the gateway credential store. */
  providerApiKeys: Record<string, string>;
  userText: string;
  assistantText: string;
  /** Memories the agent already has, so the model can update instead of duplicating. */
  index: MemoryInfo[];
  completeFn?: CompleteFn;
}): Promise<SweepCandidate[]> {
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
      systemPrompt: sweepPrompt(options.index),
      messages: [{ role: 'user', content: exchange, timestamp: Date.now() }],
    },
    { apiKey, maxTokens: 800, temperature: 0.1 },
  );

  const raw = message.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join(' ');
  return parseSweepReply(raw);
}
