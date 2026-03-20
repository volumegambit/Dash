import type { SkillFrontmatter } from './types.js';

export interface ParsedSkill {
  frontmatter: SkillFrontmatter;
  content: string;
}

/**
 * Parse a simple YAML value — handles strings, inline arrays, and booleans.
 */
function parseValue(raw: string): string | string[] {
  const trimmed = raw.trim();

  // Inline array: [a, b, c]
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1);
    if (inner.trim() === '') return [];
    return inner
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '');
  }

  return trimmed;
}

/**
 * Parse YAML frontmatter from a skill file.
 *
 * Supports:
 * - Key-value pairs: `key: value`
 * - Inline arrays: `key: [a, b, c]`
 * - Multi-line arrays: `key:\n  - item`
 *
 * Returns null if frontmatter is missing or name is empty.
 */
export function parseFrontmatter(raw: string): ParsedSkill | null {
  const normalized = raw.replace(/\r\n/g, '\n');

  // Must start with ---
  if (!normalized.startsWith('---\n') && normalized !== '---') {
    return null;
  }

  const afterOpen = normalized.slice(4);
  const closeIdx = afterOpen.indexOf('\n---');
  if (closeIdx === -1) {
    return null;
  }

  const yamlBlock = afterOpen.slice(0, closeIdx);
  const rest = afterOpen.slice(closeIdx + 4); // skip \n---

  // Parse YAML key-value pairs with multi-line array support
  const fm: Record<string, string | string[]> = {};
  const lines = yamlBlock.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Skip empty lines
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Indented line at top level — shouldn't happen for valid YAML but skip
    if (line.startsWith(' ') || line.startsWith('\t')) {
      i++;
      continue;
    }

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) {
      i++;
      continue;
    }

    const key = line.slice(0, colonIdx).trim();
    const valueRaw = line.slice(colonIdx + 1).trim();

    // Check for multi-line array (value is empty, next lines are `- item`)
    if (valueRaw === '') {
      const items: string[] = [];
      i++;
      while (i < lines.length) {
        const nextLine = lines[i];
        const listMatch = nextLine.match(/^[ \t]+-[ \t]+(.*)/);
        if (listMatch) {
          items.push(listMatch[1].trim());
          i++;
        } else {
          break;
        }
      }
      fm[key] = items;
      continue;
    }

    fm[key] = parseValue(valueRaw);
    i++;
  }

  // Validate required fields
  const name = typeof fm.name === 'string' ? fm.name : '';
  if (!name) {
    return null;
  }

  const description = typeof fm.description === 'string' ? fm.description : '';

  const frontmatter: SkillFrontmatter = { name, description };

  if (typeof fm.trigger === 'string' && fm.trigger) {
    frontmatter.trigger = fm.trigger;
  }
  if (Array.isArray(fm.tools)) {
    frontmatter.tools = fm.tools;
  }
  if (Array.isArray(fm.tags)) {
    frontmatter.tags = fm.tags;
  }
  if (typeof fm.model === 'string' && fm.model) {
    frontmatter.model = fm.model;
  }
  if (fm.context === 'fork') {
    frontmatter.context = 'fork';
  }
  if (Array.isArray(fm['allowed-tools'])) {
    frontmatter['allowed-tools'] = fm['allowed-tools'];
  }
  if (Array.isArray(fm.dependencies)) {
    frontmatter.dependencies = fm.dependencies;
  }

  const content = rest.trimStart().trimEnd();

  return { frontmatter, content };
}

/**
 * Generate a YAML frontmatter block for a skill file.
 *
 * Always includes name and description. Optional fields are only
 * included if they have values. Arrays are rendered as multi-line YAML.
 */
export function generateFrontmatter(fm: SkillFrontmatter, content: string): string {
  const lines: string[] = ['---'];

  lines.push(`name: ${fm.name}`);
  lines.push(`description: ${fm.description}`);

  if (fm.trigger !== undefined) {
    lines.push(`trigger: ${fm.trigger}`);
  }
  if (fm.tools !== undefined && fm.tools.length > 0) {
    lines.push('tools:');
    for (const t of fm.tools) {
      lines.push(`  - ${t}`);
    }
  }
  if (fm.tags !== undefined && fm.tags.length > 0) {
    lines.push('tags:');
    for (const t of fm.tags) {
      lines.push(`  - ${t}`);
    }
  }
  if (fm.model !== undefined) {
    lines.push(`model: ${fm.model}`);
  }
  if (fm.context !== undefined) {
    lines.push(`context: ${fm.context}`);
  }
  if (fm['allowed-tools'] !== undefined && fm['allowed-tools'].length > 0) {
    lines.push('allowed-tools:');
    for (const t of fm['allowed-tools']) {
      lines.push(`  - ${t}`);
    }
  }
  if (fm.dependencies !== undefined && fm.dependencies.length > 0) {
    lines.push('dependencies:');
    for (const d of fm.dependencies) {
      lines.push(`  - ${d}`);
    }
  }

  lines.push('---');

  return `${lines.join('\n')}\n\n${content}`;
}
