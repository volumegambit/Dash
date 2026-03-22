import { buildMemoryPreamble } from './memory.js';
import type { SkillDiscoveryResult } from './skills/types.js';
import type {
  AgentBackend,
  AgentEvent,
  AgentState,
  DashAgentConfig,
  ImageBlock,
  RunOptions,
} from './types.js';

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatSkillsForPrompt(skills: SkillDiscoveryResult[]): string {
  if (skills.length === 0) return '';

  const lines = [
    '\n\nThe following skills provide specialized instructions for specific tasks.',
    "Use the load_skill tool to load a skill when the task matches its description.",
    'When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.',
    '',
    '<available_skills>',
  ];
  for (const skill of skills) {
    lines.push('  <skill>');
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.location)}</location>`);
    lines.push('  </skill>');
  }
  lines.push('</available_skills>');
  return lines.join('\n');
}

export class DashAgent {
  constructor(
    private backend: AgentBackend,
    private config: DashAgentConfig,
  ) {}

  /** Update agent config at runtime (e.g. model, fallbackModels, tools, systemPrompt). */
  updateConfig(patch: {
    model?: string;
    fallbackModels?: string[];
    tools?: string[];
    systemPrompt?: string;
  }): void {
    if (patch.model !== undefined) this.config.model = patch.model;
    if (patch.fallbackModels !== undefined) this.config.fallbackModels = patch.fallbackModels;
    if (patch.tools !== undefined) this.config.tools = patch.tools;
    if (patch.systemPrompt !== undefined) this.config.systemPrompt = patch.systemPrompt;
  }

  async *chat(
    channelId: string,
    conversationId: string,
    userMessage: string,
    options: RunOptions & { images?: ImageBlock[] } = {},
  ): AsyncGenerator<AgentEvent> {
    let systemPrompt = this.config.systemPrompt;

    // Append available skills to the system prompt
    if (this.backend.listSkills) {
      const skills = await this.backend.listSkills();
      systemPrompt += formatSkillsForPrompt(skills);
    }

    // Memory preamble goes last — it's dynamic context from past conversations
    if (this.config.workspace) {
      const preamble = await buildMemoryPreamble(this.config.workspace);
      systemPrompt = `${systemPrompt}\n\n${preamble}`;
    }

    const state: AgentState = {
      channelId,
      conversationId,
      message: userMessage,
      model: this.config.model,
      fallbackModels: this.config.fallbackModels,
      systemPrompt,
      tools: this.config.tools,
      workspace: this.config.workspace,
      images: options.images,
    };

    yield* this.backend.run(state, options);
  }

  async answerQuestion(id: string, answers: string[][]): Promise<void> {
    await this.backend.answerQuestion?.(id, answers);
  }
}
