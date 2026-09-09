import { parseFrontmatterFields } from '../skills/frontmatter.js';

export interface AgentDefinition {
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
  ignoredKeys: string[];
  source: 'workspace' | 'agent' | 'plugin';
  location: string;
  namespace?: string;
}

export type ParseDefinitionResult =
  | { ok: true; definition: AgentDefinition }
  | { ok: false; error: string };

const IGNORED_KEY_LIST = [
  'permissionMode',
  'hooks',
  'mcpServers',
  'memory',
  'effort',
  'color',
  'experimental',
];

/**
 * Outcome of splitting a tool list. `items` is `undefined` when the input was
 * `undefined` or split to nothing; `ok: false` means the input's parentheses do
 * not balance, which the caller turns into a per-field parse error.
 */
export type SplitToolListResult =
  | { ok: true; items: string[] | undefined }
  | { ok: false; error: 'unbalanced parentheses' };

/**
 * Split a comma-separated tool list, respecting parentheses.
 * Handles strings like "read, agent(a, b), mcp__*" → ['read', 'agent(a, b)', 'mcp__*']
 * Also handles arrays and undefined.
 *
 * UNBALANCED INPUT IS AN ERROR, never a silent mis-split. A stray `)` used to
 * drive the depth counter negative, so every later comma looked "nested" and
 * `agent(a)), foo` collapsed into a single bogus entry that then reached tool
 * resolution. An unopened `)` and an unclosed `(` both return `ok: false`.
 */
export function splitToolList(value: string | string[] | undefined): SplitToolListResult {
  if (value === undefined) {
    return { ok: true, items: undefined };
  }

  if (Array.isArray(value)) {
    return { ok: true, items: value };
  }

  // Track parenthesis depth while splitting on commas
  const result: string[] = [];
  let current = '';
  let depth = 0;

  for (let i = 0; i < value.length; i++) {
    const char = value[i];

    if (char === '(') {
      depth++;
      current += char;
    } else if (char === ')') {
      if (depth === 0) {
        return { ok: false, error: 'unbalanced parentheses' };
      }
      depth--;
      current += char;
    } else if (char === ',' && depth === 0) {
      // Split on comma only at depth 0
      const trimmed = current.trim();
      if (trimmed) {
        result.push(trimmed);
      }
      current = '';
    } else {
      current += char;
    }
  }

  // An unclosed `(` is just as unbalanced as a stray `)`.
  if (depth !== 0) {
    return { ok: false, error: 'unbalanced parentheses' };
  }

  // Don't forget the last item
  const trimmed = current.trim();
  if (trimmed) {
    result.push(trimmed);
  }

  return { ok: true, items: result.length > 0 ? result : undefined };
}

/**
 * Parse a Claude Code agent definition from raw markdown with YAML frontmatter.
 */
export function parseAgentDefinition(
  raw: string,
  meta: { source: AgentDefinition['source']; location: string; namespace?: string },
): ParseDefinitionResult {
  const parsed = parseFrontmatterFields(raw);

  if (!parsed) {
    return { ok: false, error: 'frontmatter is required' };
  }

  const { fields } = parsed;
  const { content } = parsed;

  // Validate name (required and must match pattern)
  const rawName = typeof fields.name === 'string' ? fields.name : '';
  if (!rawName) {
    return { ok: false, error: 'name is required' };
  }

  const namePattern = /^[a-z0-9][a-z0-9-]*$/;
  if (!namePattern.test(rawName)) {
    return { ok: false, error: 'name must match ^[a-z0-9][a-z0-9-]*$' };
  }

  // Apply namespace if provided (for plugin definitions)
  const name = meta.namespace ? `${meta.namespace}:${rawName}` : rawName;

  // Validate description (required)
  const description = typeof fields.description === 'string' ? fields.description : '';
  if (!description) {
    return { ok: false, error: 'description is required' };
  }

  // Parse tools (optional). Unbalanced parentheses are a hard error: silently
  // keeping a mis-split entry would hand tool resolution a name no grant can
  // ever match.
  let tools: string[] | undefined;
  if (fields.tools !== undefined) {
    const toolsValue = Array.isArray(fields.tools) ? fields.tools.join(', ') : String(fields.tools);
    const split = splitToolList(toolsValue);
    if (!split.ok) {
      return { ok: false, error: 'unbalanced parentheses in tools list' };
    }
    if (split.items && split.items.length > 0) {
      tools = split.items;
    }
  }

  // Parse disallowedTools (optional) — same grammar, same rejection.
  let disallowedTools: string[] | undefined;
  if (fields.disallowedTools !== undefined) {
    const toolsValue = Array.isArray(fields.disallowedTools)
      ? fields.disallowedTools.join(', ')
      : String(fields.disallowedTools);
    const split = splitToolList(toolsValue);
    if (!split.ok) {
      return { ok: false, error: 'unbalanced parentheses in disallowedTools list' };
    }
    if (split.items && split.items.length > 0) {
      disallowedTools = split.items;
    }
  }

  // Parse model (optional)
  const model = typeof fields.model === 'string' && fields.model ? fields.model : undefined;

  // Parse skills (optional)
  let skills: string[] | undefined;
  if (Array.isArray(fields.skills) && fields.skills.length > 0) {
    skills = fields.skills;
  }

  // Parse maxTurns (optional, must be positive integer)
  let maxTurns: number | undefined;
  if (fields.maxTurns !== undefined) {
    const maxTurnsStr = String(fields.maxTurns);
    const parsed = Number.parseInt(maxTurnsStr, 10);
    if (Number.isNaN(parsed) || parsed <= 0) {
      return { ok: false, error: 'maxTurns must be a positive integer' };
    }
    maxTurns = parsed;
  }

  // Parse background (optional, expects 'true'/'false' string)
  let background: boolean | undefined;
  if (fields.background !== undefined) {
    const bgStr = String(fields.background);
    if (bgStr === 'true') {
      background = true;
    } else if (bgStr === 'false') {
      background = false;
    }
  }

  // Parse isolation (optional, must be 'worktree')
  let isolation: 'worktree' | undefined;
  if (fields.isolation !== undefined) {
    const isoStr = String(fields.isolation);
    if (isoStr !== 'worktree') {
      return { ok: false, error: 'isolation must be "worktree"' };
    }
    isolation = 'worktree';
  }

  // Collect ignored keys (keys that were present in frontmatter from the ignore list)
  const ignoredKeys: string[] = [];
  for (const key of IGNORED_KEY_LIST) {
    if (fields[key] !== undefined) {
      ignoredKeys.push(key);
    }
  }

  const definition: AgentDefinition = {
    name,
    description,
    systemPrompt: content.trim(),
    ...(tools && { tools }),
    ...(disallowedTools && { disallowedTools }),
    ...(model && { model }),
    ...(skills && { skills }),
    ...(maxTurns && { maxTurns }),
    ...(background !== undefined && { background }),
    ...(isolation && { isolation }),
    ignoredKeys,
    source: meta.source,
    location: meta.location,
    ...(meta.namespace && { namespace: meta.namespace }),
  };

  return { ok: true, definition };
}
