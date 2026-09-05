import { MEMORY_LIMITS, type MemoryInfo } from './types.js';

export const STOP_WORDS: ReadonlySet<string> = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'have',
  'has',
  'you',
  'your',
  'are',
  'was',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'how',
  'why',
  'can',
  'could',
  'should',
  'would',
  'about',
  'into',
  'onto',
  'please',
  'tell',
  'does',
  'did',
  'not',
  'but',
  'all',
  'any',
  'some',
  'use',
  'using',
  'used',
  'want',
  'need',
  'like',
  'just',
  'also',
  'there',
  'here',
  'they',
  'them',
  'our',
  'out',
  'get',
  'got',
  'let',
  'make',
  'made',
  'one',
  'two',
  'its',
  'then',
  'than',
  'too',
]);

export function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOP_WORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

/**
 * Pick the memories most relevant to a message by distinct token overlap
 * between the message and each memory's name + description. Deterministic,
 * no embeddings, no model call. Zero-score memories are never returned.
 */
export function selectRelevant(
  memories: MemoryInfo[],
  message: string,
  opts: { limit?: number } = {},
): MemoryInfo[] {
  const limit = opts.limit ?? MEMORY_LIMITS.recallLimit;
  const query = tokenize(message);
  if (query.size === 0) return [];
  const scored = memories
    .map((m) => {
      const own = tokenize(`${m.name.replace(/-/g, ' ')} ${m.description}`);
      let score = 0;
      for (const t of own) if (query.has(t)) score++;
      return { m, score };
    })
    .filter((s) => s.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.m.updatedAt.localeCompare(a.m.updatedAt) ||
        a.m.name.localeCompare(b.m.name),
    );
  return scored.slice(0, limit).map((s) => s.m);
}
