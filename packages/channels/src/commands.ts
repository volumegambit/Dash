/**
 * Chat slash-commands handled deterministically by the router before a message
 * reaches the agent. Unknown `/commands` return null so they pass through to
 * the LLM unchanged.
 */
export type SlashCommand =
  | { kind: 'skills' }
  | { kind: 'skill'; name: string; input: string }
  | { kind: 'help' };

export function parseSlashCommand(text: string): SlashCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;

  if (/^\/skills(?:\s|$)/.test(trimmed)) return { kind: 'skills' };
  if (/^\/help(?:\s|$)/.test(trimmed)) return { kind: 'help' };

  // /skill:<name> [input]  or  /skill <name> [input]
  const m = trimmed.match(/^\/skill(?::|\s+)(\S+)\s*([\s\S]*)$/);
  if (m) return { kind: 'skill', name: m[1], input: m[2].trim() };

  // Claude-style plugin command: /<plugin>:<command> [input]
  const ns = trimmed.match(/^\/([a-z0-9][a-z0-9-]*):(\S+)\s*([\s\S]*)$/i);
  if (ns) return { kind: 'skill', name: `${ns[1]}:${ns[2]}`, input: ns[3].trim() };

  return null;
}

export const SLASH_HELP = [
  'Commands:',
  '/skills — list available skills',
  '/skill:<name> [input] — run a skill',
  '/<plugin>:<command> [input] — run a plugin command',
  '/help — show this help',
].join('\n');

/** Render the `/skills` reply from a list of discovered skills. */
export function formatSkillList(skills: { name: string; description: string }[]): string {
  if (skills.length === 0) return 'No skills are available.';
  const lines = skills.map((s) => `• ${s.name} — ${s.description}`);
  return `Available skills (${skills.length}):\n${lines.join('\n')}\n\nRun one with /skill:<name>.`;
}

/** Rewrite a `/skill:<name> [input]` command into a prompt for the agent. */
export function skillPrompt(name: string, input: string): string {
  return input
    ? `Load and apply the skill '${name}'. Input: ${input}`
    : `Load and apply the skill '${name}'.`;
}
