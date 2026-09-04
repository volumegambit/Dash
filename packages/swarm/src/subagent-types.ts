export const READ_ONLY_TOOLS = [
  'read',
  'grep',
  'find',
  'ls',
  'web_fetch',
  'web_search',
  'load_skill',
] as const;
export const ROSTER_TOKEN_BUDGET = 15_000;

export interface ResolvedSubagentType {
  name: string;
  description: string;
  systemPrompt: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: string;
  skills?: string[];
  maxTurns?: number;
  background?: boolean;
  isolation?: 'worktree';
  skipMemory?: boolean;
  oneShot?: boolean;
  source: 'builtin' | 'workspace' | 'agent' | 'plugin';
  location?: string;
}

export interface SubagentTypeResolver {
  list(): ResolvedSubagentType[];
  resolve(type: string): ResolvedSubagentType | undefined;
}

const GENERAL_PURPOSE_PROMPT =
  'You are a general-purpose agent working on one task delegated by a ' +
  'parent agent. Complete the task fully, then put your complete findings ' +
  'or results in your FINAL message — the parent sees only that message. Do ' +
  'not ask the user questions; if you are blocked on a decision only the ' +
  'parent can make, call ask_orchestrator once and continue.';
const EXPLORE_PROMPT =
  'You are a read-only exploration agent. Locate code, files, and ' +
  'conventions across the repository by sweeping broadly and reading ' +
  'excerpts, not whole files. You locate; you do not review or audit. ' +
  'Respect the requested search breadth. Report file paths with line ' +
  'references and a concise conclusion in your FINAL message.';
const PLAN_PROMPT =
  'You are a software architect. Research the codebase read-only and ' +
  'produce a step-by-step implementation plan: the critical files, the ' +
  'order of changes, interfaces to preserve, and the trade-offs considered. ' +
  'Put the complete plan in your FINAL message.';

export function builtinSubagentTypes(): ResolvedSubagentType[] {
  return [
    {
      name: 'general-purpose',
      description:
        'General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. Use when the task needs exploration and action.',
      systemPrompt: GENERAL_PURPOSE_PROMPT,
      source: 'builtin',
    },
    {
      name: 'Explore',
      description:
        'Read-only search agent for broad fan-out searches — when answering means sweeping many files or naming conventions and you only need the conclusion. Specify search breadth: "medium" or "very thorough".',
      systemPrompt: EXPLORE_PROMPT,
      tools: [...READ_ONLY_TOOLS],
      skipMemory: true,
      oneShot: true,
      source: 'builtin',
    },
    {
      name: 'Plan',
      description:
        'Software architect agent for designing implementation plans. Returns step-by-step plans, identifies critical files, and considers trade-offs.',
      systemPrompt: PLAN_PROMPT,
      tools: [...READ_ONLY_TOOLS],
      skipMemory: true,
      oneShot: true,
      source: 'builtin',
    },
  ];
}

export function createStaticResolver(types: ResolvedSubagentType[]): SubagentTypeResolver {
  const byName = new Map(types.map((t) => [t.name, t] as const));
  return { list: () => [...byName.values()], resolve: (type) => byName.get(type) };
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function buildRosterText(
  types: ResolvedSubagentType[],
  effectiveTools: (t: ResolvedSubagentType) => string,
): string {
  const lines = types.map((t) => `- ${t.name}: ${t.description} (Tools: ${effectiveTools(t)})`);
  return `Available agent types and the tools they have access to:\n${lines.join('\n')}`;
}
