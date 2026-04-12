export const ALL_AGENT_TOOLS = [
  'bash',
  'edit',
  'write',
  'read',
  'glob',
  'grep',
  'ls',
  'web_fetch',
  'web_search',
  'mcp',
  'skill',
] as const;

export type AgentTool = (typeof ALL_AGENT_TOOLS)[number];

export function parseModel(model: string): { providerID: string; modelID: string } {
  const slash = model.indexOf('/');
  if (slash === -1) {
    throw new Error(
      `Model must be in "provider/model" format, got "${model}". Example: "anthropic/claude-opus-4-5"`,
    );
  }
  return {
    providerID: model.slice(0, slash),
    modelID: model.slice(slash + 1),
  };
}

export function buildToolsMap(tools: string[] | undefined): Record<string, boolean> {
  const allowList = tools ? new Set(tools) : new Set(ALL_AGENT_TOOLS);
  return Object.fromEntries(ALL_AGENT_TOOLS.map((t) => [t, allowList.has(t)]));
}
