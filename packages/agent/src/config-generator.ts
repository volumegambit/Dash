export const ALL_TOOLS = ['bash', 'edit', 'write', 'read'] as const;

export type AgentTool = (typeof ALL_TOOLS)[number];

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
  const allowList = tools ? new Set(tools) : new Set(ALL_TOOLS);
  return Object.fromEntries(ALL_TOOLS.map((t) => [t, allowList.has(t)]));
}
