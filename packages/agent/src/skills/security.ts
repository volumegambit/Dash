export type SkillScanLevel = 'safe' | 'suspicious' | 'dangerous';

export interface SkillScanVerdict {
  verdict: SkillScanLevel;
  reasons: string[];
}

/**
 * Scans a skill's text for unsafe instructions. Returns a verdict; never
 * throws for content reasons. The default scanner combines this heuristic
 * prefilter with an LLM judgment (see {@link createLlmScanner}).
 */
export type SkillSecurityScanner = (content: string) => Promise<SkillScanVerdict>;

const DANGEROUS_PATTERNS: { re: RegExp; reason: string }[] = [
  {
    re: /\b(curl|wget)\b[^\n]*\|\s*(sh|bash|zsh)\b/i,
    reason: 'pipes a download straight into a shell',
  },
  { re: /\brm\s+-rf\s+[~/]/i, reason: 'destructive recursive delete of a root or home path' },
  {
    re: /ignore\s+(all\s+|any\s+)?(your\s+|the\s+|these\s+)?(previous|prior|above|earlier)\s+(instructions|prompts?|messages?)/i,
    reason: 'prompt-injection: tries to override prior instructions',
  },
  {
    re: /\b(send|exfiltrate|upload|post|leak|forward)\b[^\n]{0,60}\b(api[\s_-]?keys?|secrets?|tokens?|passwords?|credentials?|env(ironment)?\s+variables?)\b/i,
    reason: 'attempts to exfiltrate secrets or credentials',
  },
  { re: /-----BEGIN\s+[A-Z ]*PRIVATE KEY-----/, reason: 'embeds a private key' },
];

const SUSPICIOUS_PATTERNS: { re: RegExp; reason: string }[] = [
  {
    re: /\bbase64\b\s+(--decode|-d)\b|\batob\s*\(/i,
    reason: 'decodes base64 (possible obfuscation)',
  },
  { re: /\b(printenv|process\.env|cat\s+[^\n]*\.env\b)/i, reason: 'reads environment variables' },
];

/** Deterministic, dependency-free prefilter over a skill's text. */
export function heuristicScan(content: string): SkillScanVerdict {
  const reasons: string[] = [];
  let verdict: SkillScanLevel = 'safe';

  for (const { re, reason } of DANGEROUS_PATTERNS) {
    if (re.test(content)) {
      reasons.push(reason);
      verdict = 'dangerous';
    }
  }
  if (verdict !== 'dangerous') {
    for (const { re, reason } of SUSPICIOUS_PATTERNS) {
      if (re.test(content)) {
        reasons.push(reason);
        verdict = 'suspicious';
      }
    }
  }
  return { verdict, reasons };
}

const LEVEL_ORDER: Record<SkillScanLevel, number> = { safe: 0, suspicious: 1, dangerous: 2 };

export interface LlmScannerOptions {
  /**
   * Asks a model to classify the skill content. May throw — the resulting
   * scanner then rejects (callers must fail closed). Kept as an injected seam
   * so policy is testable without a live model.
   */
  classify: (content: string) => Promise<SkillScanVerdict>;
}

/**
 * Build a scanner that runs the heuristic prefilter first (short-circuiting on
 * a `dangerous` hit), then the model classifier, returning the stricter of the
 * two verdicts.
 */
export function createLlmScanner(opts: LlmScannerOptions): SkillSecurityScanner {
  return async (content: string): Promise<SkillScanVerdict> => {
    const heuristic = heuristicScan(content);
    if (heuristic.verdict === 'dangerous') return heuristic;

    const llm = await opts.classify(content);
    const verdict =
      LEVEL_ORDER[llm.verdict] >= LEVEL_ORDER[heuristic.verdict] ? llm.verdict : heuristic.verdict;
    return { verdict, reasons: [...heuristic.reasons, ...llm.reasons] };
  };
}
