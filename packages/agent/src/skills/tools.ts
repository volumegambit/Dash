import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';
import { generateFrontmatter } from './frontmatter.js';
import type { SkillDiscoveryResult, SkillFrontmatter } from './types.js';

const loadSkillSchema = Type.Object({
  name: Type.String({ description: 'The skill name to load' }),
});

type LoadSkillInput = Static<typeof loadSkillSchema>;

/**
 * Create the load_skill tool.
 * Loads a skill's full content into the conversation context.
 */
export function createLoadSkillTool(
  listSkillsFn: () => Promise<SkillDiscoveryResult[]>,
): AgentTool<typeof loadSkillSchema> {
  return {
    name: 'load_skill',
    label: 'Load Skill',
    description:
      'Load a skill into the current conversation context. Use when you identify that a task matches one of your available skills listed in your system prompt. Returns the full skill instructions.',
    parameters: loadSkillSchema,
    execute: async (
      _toolCallId: string,
      params: LoadSkillInput,
    ): Promise<AgentToolResult<Record<string, never>>> => {
      const skills = await listSkillsFn();
      const skill = skills.find((s) => s.name === params.name);

      if (!skill) {
        const available = skills.map((s) => s.name).join(', ');
        return {
          content: [
            {
              type: 'text',
              text: `Skill "${params.name}" not found. Available skills: ${available || '(none)'}`,
            },
          ],
          details: {},
        };
      }

      return {
        content: [{ type: 'text', text: skill.content }],
        details: {},
      };
    },
  };
}

const createSkillSchema = Type.Object({
  name: Type.String({
    description: 'Skill name (lowercase alphanumeric and hyphens, max 64 chars)',
  }),
  description: Type.String({
    description:
      'When to use this skill — powers automatic discovery, so be specific (e.g. "Use when deploying to staging via AWS")',
  }),
  content: Type.String({ description: 'The full skill instructions as markdown' }),
  trigger: Type.Optional(
    Type.String({ description: 'Trigger keyword or phrase for automatic activation' }),
  ),
  tools: Type.Optional(Type.Array(Type.String(), { description: 'Tool names this skill uses' })),
  tags: Type.Optional(Type.Array(Type.String(), { description: 'Tags for categorization' })),
  model: Type.Optional(
    Type.String({ description: 'Preferred model for this skill (provider/model format)' }),
  ),
  context: Type.Optional(
    Type.Union([Type.Literal('fork')], {
      description: 'Context mode — "fork" runs in a separate context',
    }),
  ),
  allowed_tools: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Restrict tool access to only these tools when skill is active',
    }),
  ),
  dependencies: Type.Optional(
    Type.Array(Type.String(), { description: 'Other skills this skill depends on' }),
  ),
});

type CreateSkillInput = Static<typeof createSkillSchema>;

/** Validate a skill name: lowercase alphanumeric + hyphens, max 64 chars */
function isValidSkillName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(name) && name.length <= 64;
}

/**
 * Create the create_skill tool.
 * Persists a new skill to the managed skills directory.
 */
export function createCreateSkillTool(
  managedSkillsDir: string,
): AgentTool<typeof createSkillSchema> {
  return {
    name: 'create_skill',
    label: 'Create Skill',
    description:
      'Create a reusable skill that persists across conversations. Use when the user asks you to remember a process, save a workflow, or create reusable instructions. The description should explain WHEN to use this skill — it powers automatic discovery, so be specific (e.g. "Use when deploying to staging via AWS" not "Deployment helper"). Content should be self-contained instructions that work without the current conversation context.',
    parameters: createSkillSchema,
    execute: async (
      _toolCallId: string,
      params: CreateSkillInput,
    ): Promise<AgentToolResult<Record<string, never>>> => {
      // Validate name
      if (!isValidSkillName(params.name)) {
        return {
          content: [
            {
              type: 'text',
              text: 'Invalid skill name. Must be lowercase alphanumeric with hyphens, max 64 characters, and start with a letter or digit.',
            },
          ],
          details: {},
        };
      }

      // Check for duplicates
      const skillDir = join(managedSkillsDir, params.name);
      if (existsSync(skillDir)) {
        return {
          content: [
            {
              type: 'text',
              text: `Skill "${params.name}" already exists at ${skillDir}. Choose a different name.`,
            },
          ],
          details: {},
        };
      }

      // Validate content
      if (!params.content.trim()) {
        return {
          content: [
            {
              type: 'text',
              text: 'Skill content cannot be empty. Provide self-contained instructions.',
            },
          ],
          details: {},
        };
      }

      // Build frontmatter
      const fm: SkillFrontmatter = {
        name: params.name,
        description: params.description,
      };
      if (params.trigger) fm.trigger = params.trigger;
      if (params.tools && params.tools.length > 0) fm.tools = params.tools;
      if (params.tags && params.tags.length > 0) fm.tags = params.tags;
      if (params.model) fm.model = params.model;
      if (params.context) fm.context = params.context;
      if (params.allowed_tools && params.allowed_tools.length > 0) {
        fm['allowed-tools'] = params.allowed_tools;
      }
      if (params.dependencies && params.dependencies.length > 0) {
        fm.dependencies = params.dependencies;
      }

      const fileContent = generateFrontmatter(fm, params.content);

      // Write skill files
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, 'SKILL.md'), fileContent, 'utf-8');
      await writeFile(join(skillDir, '.source'), 'agent', 'utf-8');

      return {
        content: [
          {
            type: 'text',
            text: `Skill "${params.name}" created at ${join(skillDir, 'SKILL.md')}. It will be available in future conversations.`,
          },
        ],
        details: {},
      };
    },
  };
}
