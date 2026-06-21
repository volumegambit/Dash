import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';
import { SkillOpError, createSkillInDir, installSkillToDir, removeSkillFromDir } from './manage.js';
import type { SkillSecurityScanner } from './security.js';
import type { SkillDiscoveryResult, SkillFrontmatter } from './types.js';

/** Build a plain text tool result. */
function textResult(text: string): AgentToolResult<Record<string, never>> {
  return { content: [{ type: 'text', text }], details: {} };
}

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
        return textResult(
          `Skill "${params.name}" not found. Available skills: ${available || '(none)'}`,
        );
      }
      return textResult(skill.content);
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

/**
 * Create the create_skill tool. Persists a new skill to the managed directory.
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
      const frontmatter: Partial<SkillFrontmatter> = {};
      if (params.trigger) frontmatter.trigger = params.trigger;
      if (params.tools && params.tools.length > 0) frontmatter.tools = params.tools;
      if (params.tags && params.tags.length > 0) frontmatter.tags = params.tags;
      if (params.model) frontmatter.model = params.model;
      if (params.context) frontmatter.context = params.context;
      if (params.allowed_tools && params.allowed_tools.length > 0) {
        frontmatter['allowed-tools'] = params.allowed_tools;
      }
      if (params.dependencies && params.dependencies.length > 0) {
        frontmatter.dependencies = params.dependencies;
      }

      try {
        const r = await createSkillInDir({
          managedDir: managedSkillsDir,
          name: params.name,
          description: params.description,
          content: params.content,
          frontmatter,
        });
        return textResult(
          `Skill "${r.name}" created at ${r.location}. It will be available in future conversations.`,
        );
      } catch (e) {
        if (e instanceof SkillOpError) return textResult(e.message);
        throw e;
      }
    },
  };
}

const installSkillSchema = Type.Object({
  source: Type.String({
    description:
      'Where to install from: git:owner/repo[/subpath][@ref], an https URL to a SKILL.md, or a local path.',
  }),
  name: Type.Optional(
    Type.String({
      description: "Optional name override (defaults to the skill's frontmatter name).",
    }),
  ),
});

type InstallSkillInput = Static<typeof installSkillSchema>;

/**
 * Create the install_skill tool. Fetches a text-only skill from the public
 * ecosystem (git/URL/local), security-scans it, and writes it to the managed
 * directory. Fails closed: a dangerous verdict or a scan error blocks install.
 */
export function createInstallSkillTool(
  managedSkillsDir: string,
  scanner: SkillSecurityScanner,
  onChange?: () => void | Promise<void>,
): AgentTool<typeof installSkillSchema> {
  return {
    name: 'install_skill',
    label: 'Install Skill',
    description:
      'Install a new skill from the public ecosystem so it becomes available in future turns. Source can be git:owner/repo[/subpath][@ref], an https URL to a SKILL.md, or a local path. The skill is text-only (executable scripts are stripped) and is security-scanned before install; dangerous skills are refused.',
    parameters: installSkillSchema,
    execute: async (
      _toolCallId: string,
      params: InstallSkillInput,
    ): Promise<AgentToolResult<Record<string, never>>> => {
      try {
        const r = await installSkillToDir({
          managedDir: managedSkillsDir,
          source: params.source,
          name: params.name,
          scanner,
        });
        await onChange?.();
        const warning =
          r.verdict.verdict === 'suspicious'
            ? ` Note: the security scan flagged it as suspicious (${r.verdict.reasons.join('; ')}). Review it before relying on it.`
            : '';
        return textResult(`Installed skill "${r.name}". It's available now.${warning}`);
      } catch (e) {
        if (e instanceof SkillOpError) {
          if (e.code === 'dangerous') return textResult(`Refused to install: ${e.message}`);
          if (e.code === 'scan_failed') {
            return textResult(
              `The skill was not installed: the security scan failed. ${e.message}`,
            );
          }
          return textResult(e.message);
        }
        throw e;
      }
    },
  };
}

const removeSkillSchema = Type.Object({
  name: Type.String({ description: 'The skill name to remove.' }),
});

type RemoveSkillInput = Static<typeof removeSkillSchema>;

/**
 * Create the remove_skill tool. Deletes a managed/installed/created skill.
 * Bundled skills are read-only and cannot be removed.
 */
export function createRemoveSkillTool(
  managedSkillsDir: string,
  listSkillsFn: () => Promise<SkillDiscoveryResult[]>,
  onChange?: () => void | Promise<void>,
): AgentTool<typeof removeSkillSchema> {
  return {
    name: 'remove_skill',
    label: 'Remove Skill',
    description:
      'Uninstall a previously installed or created skill by name. Bundled skills cannot be removed.',
    parameters: removeSkillSchema,
    execute: async (
      _toolCallId: string,
      params: RemoveSkillInput,
    ): Promise<AgentToolResult<Record<string, never>>> => {
      try {
        const r = await removeSkillFromDir({
          managedDir: managedSkillsDir,
          name: params.name,
          listFn: listSkillsFn,
        });
        await onChange?.();
        return textResult(`Removed skill "${r.name}".`);
      } catch (e) {
        if (e instanceof SkillOpError) return textResult(e.message);
        throw e;
      }
    },
  };
}
