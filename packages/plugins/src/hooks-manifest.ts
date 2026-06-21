import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HookCommand, HookMatcherGroup, HooksConfig } from '@dash/plugin-sdk';

/** Claude Code: a plugin's hooks live at `<pluginRoot>/hooks/hooks.json`. */
export const HOOKS_FILE = 'hooks/hooks.json';

/**
 * Reconstructs a `HookCommand` field-by-field (no raw spread — proto-safe,
 * consistent with `manifest.ts`). A command must be `{ type: 'command' }` with
 * a non-empty `command` string; `timeout`, when present, must be a number.
 */
function normalizeCommand(v: unknown, where: string): HookCommand {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new Error(`${where}: hook command must be an object`);
  }
  const c = v as Record<string, unknown>;
  if (c.type !== 'command') {
    throw new Error(`${where}: hook command 'type' must be 'command'`);
  }
  if (typeof c.command !== 'string' || c.command.length === 0) {
    throw new Error(`${where}: hook command 'command' must be a non-empty string`);
  }
  if (c.timeout !== undefined && typeof c.timeout !== 'number') {
    throw new Error(`${where}: hook command 'timeout' must be a number`);
  }
  return {
    type: 'command',
    command: c.command,
    ...(typeof c.timeout === 'number' ? { timeout: c.timeout } : {}),
  };
}

/**
 * Reconstructs a `HookMatcherGroup` field-by-field. A group must have a `hooks`
 * array; `matcher`, when present, must be a string.
 */
function normalizeGroup(v: unknown, where: string): HookMatcherGroup {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new Error(`${where}: hook group must be an object`);
  }
  const g = v as Record<string, unknown>;
  if (!Array.isArray(g.hooks)) {
    throw new Error(`${where}: hook group 'hooks' must be an array`);
  }
  if (g.matcher !== undefined && typeof g.matcher !== 'string') {
    throw new Error(`${where}: hook group 'matcher' must be a string`);
  }
  const hooks = g.hooks.map((h, i) => normalizeCommand(h, `${where}.hooks[${i}]`));
  return {
    ...(typeof g.matcher === 'string' ? { matcher: g.matcher } : {}),
    hooks,
  };
}

/**
 * Validates parsed `hooks.json` against Claude Code semantics. Tolerant of
 * UNKNOWN event keys (they are preserved; the engine only fires mapped events)
 * but STRICT on shape: the root must be an object, each event must map to an
 * array of groups, each group needs a `hooks` array, and each command needs
 * `type: 'command'` plus a non-empty `command` string. Built field-by-field
 * (no raw spread — proto-safe, consistent with `manifest.ts`).
 */
export function validateHooksJson(raw: unknown): HooksConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('hooks.json must be a JSON object');
  }
  const out: Record<string, HookMatcherGroup[]> = Object.create(null);
  for (const [event, value] of Object.entries(raw as Record<string, unknown>)) {
    if (event === '__proto__') continue;
    if (!Array.isArray(value)) {
      throw new Error(`hooks.json '${event}' must be an array of groups`);
    }
    out[event] = value.map((g, i) => normalizeGroup(g, `${event}[${i}]`));
  }
  return { ...out } as HooksConfig;
}

/**
 * Reads `<dir>/hooks/hooks.json`. The file is OPTIONAL: when absent, returns an
 * empty config `{}`. Strict JSON parse; shape validated via `validateHooksJson`.
 */
export async function readHooksJson(dir: string): Promise<HooksConfig> {
  const path = join(dir, HOOKS_FILE);
  if (!existsSync(path)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    throw new Error(`invalid JSON in ${path}: ${(err as Error).message}`);
  }
  return validateHooksJson(raw);
}
