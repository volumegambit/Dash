import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseFrontmatterFields } from '../skills/frontmatter.js';
import { renderIndex } from './index-render.js';
import {
  MEMORY_LIMITS,
  MEMORY_NAME_RE,
  MEMORY_SOURCES,
  type MemoryInfo,
  MemoryOpError,
  type MemoryRecord,
  type MemorySource,
  type SaveMemoryInput,
  isMemorySource,
  isMemoryType,
} from './types.js';

export const INDEX_FILENAME = 'MEMORY.md';

export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function str(fields: Record<string, string | string[]>, key: string): string {
  const v = fields[key];
  return typeof v === 'string' ? v.trim() : '';
}

/** Parse one memory file. Returns null when the file is not a valid memory. */
export function parseMemoryFile(raw: string, fallbackName: string): MemoryRecord | null {
  const parsed = parseFrontmatterFields(raw);
  if (!parsed) return null;
  const type = str(parsed.fields, 'type');
  if (!isMemoryType(type)) return null;
  const name = str(parsed.fields, 'name') || fallbackName;
  if (!MEMORY_NAME_RE.test(name)) return null;
  const sourceRaw = str(parsed.fields, 'source');
  const source = (MEMORY_SOURCES as readonly string[]).includes(sourceRaw)
    ? (sourceRaw as MemorySource)
    : 'agent';
  const createdAt = str(parsed.fields, 'created') || todayIso();
  return {
    name,
    description: str(parsed.fields, 'description'),
    type,
    source,
    createdAt,
    updatedAt: str(parsed.fields, 'updated') || createdAt,
    content: parsed.content.replace(/\n+$/, ''),
  };
}

/** Serialize a memory to its on-disk form (flat frontmatter + body + trailing newline). */
export function serializeMemory(record: MemoryRecord): string {
  return [
    '---',
    `name: ${record.name}`,
    `description: ${record.description}`,
    `type: ${record.type}`,
    `source: ${record.source}`,
    `created: ${record.createdAt}`,
    `updated: ${record.updatedAt}`,
    '---',
    record.content.replace(/\n+$/, ''),
    '',
  ].join('\n');
}

function validate(input: SaveMemoryInput): void {
  if (!MEMORY_NAME_RE.test(input.name)) {
    throw new MemoryOpError(
      'invalid',
      `Memory name "${input.name}" must be lowercase letters, digits and hyphens (max ${MEMORY_LIMITS.nameMax} chars)`,
    );
  }
  const description = input.description.trim();
  if (
    !description ||
    description.length > MEMORY_LIMITS.descriptionMax ||
    description.includes('\n')
  ) {
    throw new MemoryOpError(
      'invalid',
      `Memory description must be a single line of 1–${MEMORY_LIMITS.descriptionMax} chars`,
    );
  }
  if (!isMemoryType(input.type)) {
    throw new MemoryOpError(
      'invalid',
      'Memory type must be one of user, feedback, project, reference',
    );
  }
  if (!isMemorySource(input.source) || input.source.includes('\n')) {
    throw new MemoryOpError('invalid', 'Memory source must be one of agent, sweep, user, import');
  }
  const max = input.source === 'import' ? MEMORY_LIMITS.importContentMax : MEMORY_LIMITS.contentMax;
  if (!input.content.trim() || input.content.length > max) {
    throw new MemoryOpError('invalid', `Memory content must be 1–${max} chars`);
  }
}

export class MemoryStore {
  readonly indexPath: string;
  private readonly perAgent: number;

  constructor(
    readonly dir: string,
    opts: { perAgent?: number } = {},
  ) {
    this.indexPath = join(dir, INDEX_FILENAME);
    this.perAgent = opts.perAgent ?? MEMORY_LIMITS.perAgent;
  }

  private async readAll(): Promise<MemoryRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const out: MemoryRecord[] = [];
    for (const file of names.sort()) {
      if (!file.endsWith('.md') || file === INDEX_FILENAME) continue;
      try {
        const raw = await readFile(join(this.dir, file), 'utf8');
        const record = parseMemoryFile(raw, file.slice(0, -3));
        if (record) out.push(record);
      } catch {
        // unreadable file — skip, never throw (same policy as loadFlatSkills)
      }
    }
    return out;
  }

  async list(): Promise<MemoryInfo[]> {
    return (await this.readAll()).map(({ content, ...rest }) => ({
      ...rest,
      size: content.length,
    }));
  }

  async count(): Promise<number> {
    return (await this.readAll()).length;
  }

  async get(name: string): Promise<MemoryRecord | null> {
    if (!MEMORY_NAME_RE.test(name)) return null;
    try {
      const raw = await readFile(join(this.dir, `${name}.md`), 'utf8');
      return parseMemoryFile(raw, name);
    } catch {
      return null;
    }
  }

  async save(
    input: SaveMemoryInput,
  ): Promise<{ record: MemoryRecord; action: 'created' | 'updated' }> {
    validate(input);
    const existing = await this.get(input.name);
    if (!existing && (await this.count()) >= this.perAgent) {
      throw new MemoryOpError(
        'limit',
        `This agent already has ${this.perAgent} memories; update or forget one first`,
      );
    }
    const today = todayIso();
    // Provenance is sticky for user-authored memories: the agent (or the
    // sweep) may legitimately refine what the user wrote, but it must not
    // downgrade `source` to 'agent'/'sweep' — that would void the sweep's
    // "never clobber a hand-written memory" guard for every later turn and
    // make the "who wrote this" column lie. The human-facing API path
    // (source 'user') can still claim a memory the agent wrote.
    const userAuthored =
      existing !== null && (existing.source === 'user' || existing.source === 'import');
    const downgrading = input.source === 'agent' || input.source === 'sweep';
    const source = existing && userAuthored && downgrading ? existing.source : input.source;
    const record: MemoryRecord = {
      name: input.name,
      description: input.description.trim(),
      type: input.type,
      source,
      createdAt: existing?.createdAt ?? today,
      updatedAt: today,
      content: input.content.trim(),
    };
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, `${record.name}.md`), serializeMemory(record), 'utf8');
    await this.writeIndex();
    return { record, action: existing ? 'updated' : 'created' };
  }

  async remove(name: string): Promise<boolean> {
    if (!(await this.get(name))) return false;
    await rm(join(this.dir, `${name}.md`), { force: true });
    await this.writeIndex();
    return true;
  }

  /** Regenerate MEMORY.md from the files. Public so the API can repair it. */
  async writeIndex(): Promise<string> {
    const index = renderIndex(await this.list());
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.indexPath, index, 'utf8');
    return index;
  }
}
