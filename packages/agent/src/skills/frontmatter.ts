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

/** Raw frontmatter fields plus the body, without requiring a `name`. */
export interface ParsedFrontmatterFields {
  fields: Record<string, string | string[]>;
  content: string;
}

/** Leading-whitespace count (spaces + tabs) of a line. */
function indentOf(line: string): number {
  const match = line.match(/^[ \t]*/);
  return match ? match[0].length : 0;
}

/**
 * Consume a YAML block scalar starting at `startIdx` (the first line AFTER the
 * `key: |`/`key: >` indicator line). Returns the assembled string value and the
 * index of the first line that is NOT part of the block.
 *
 * The block body is every following line that is blank OR indented more than the
 * top-level key (indent 0). The block indent is taken from the first non-blank
 * body line; the block ends at the first non-blank line indented less than that.
 */
function consumeBlockScalar(
  lines: string[],
  startIdx: number,
  style: '|' | '>',
  chomp: '' | '-' | '+',
): { value: string; nextIdx: number } {
  // Find the indent of the first non-blank body line.
  let blockIndent = -1;
  let j = startIdx;
  for (; j < lines.length; j++) {
    if (lines[j].trim() === '') continue;
    if (indentOf(lines[j]) === 0) break; // back at top level — no body
    blockIndent = indentOf(lines[j]);
    break;
  }

  // No indented body at all: empty block.
  if (blockIndent === -1) {
    return { value: '', nextIdx: j };
  }

  const bodyLines: string[] = [];
  let i = startIdx;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') {
      bodyLines.push('');
      continue;
    }
    if (indentOf(line) < blockIndent) break; // dedent past block — block ends
    bodyLines.push(line.slice(blockIndent));
  }

  // Drop trailing blank lines that belong to the gap before the next key.
  while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] === '') {
    bodyLines.pop();
  }

  let value: string;
  if (style === '|') {
    value = bodyLines.join('\n');
  } else {
    // Folded: join with spaces, but a blank line becomes a newline (paragraph
    // break). Collapse runs and trim around the breaks.
    const parts: string[] = [];
    let current = '';
    for (const bl of bodyLines) {
      if (bl === '') {
        parts.push(current.trim());
        current = '';
      } else {
        current = current === '' ? bl : `${current} ${bl}`;
      }
    }
    if (current !== '') parts.push(current.trim());
    value = parts.filter((p) => p !== '').join('\n');
  }

  // Chomping: '+' (keep) would preserve trailing newlines, but we have already
  // trimmed trailing blanks. 'clip' (default) and '-' (strip) both leave us
  // with no trailing newline here, which is the safe default for our use.
  void chomp;

  return { value, nextIdx: i };
}

/**
 * Parse YAML frontmatter fields from a skill/command file WITHOUT requiring a
 * `name`. Returns the raw field map and the body, or null if the frontmatter
 * delimiters are missing/unterminated.
 *
 * Supports:
 * - Key-value pairs: `key: value`
 * - Inline arrays: `key: [a, b, c]`
 * - Multi-line arrays: `key:\n  - item`
 */
export function parseFrontmatterFields(raw: string): ParsedFrontmatterFields | null {
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
  const fields: Record<string, string | string[]> = {};
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

    // Check for a YAML block scalar: `key: |` (literal) or `key: >` (folded),
    // each optionally with a chomping indicator (`-`/`+`) and/or an explicit
    // indent digit (e.g. `|2`). The block body follows on indented lines.
    const blockMatch = valueRaw.match(/^([|>])([+-]?)\d*\s*$/);
    if (blockMatch) {
      const style = blockMatch[1] as '|' | '>';
      const chomp = blockMatch[2] as '' | '-' | '+';
      const { value, nextIdx } = consumeBlockScalar(lines, i + 1, style, chomp);
      fields[key] = value;
      i = nextIdx;
      continue;
    }

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
      fields[key] = items;
      continue;
    }

    fields[key] = parseValue(valueRaw);
    i++;
  }

  return { fields, content: rest.trimStart().trimEnd() };
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
  const parsed = parseFrontmatterFields(raw);
  if (!parsed) {
    return null;
  }
  const fm = parsed.fields;

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

  return { frontmatter, content: parsed.content };
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
