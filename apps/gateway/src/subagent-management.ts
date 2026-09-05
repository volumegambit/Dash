import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { parseAgentDefinition } from '@dash/agent';
import type { Hono } from 'hono';

import type { AgentRegistry } from './agent-registry.js';
import type { ListedSubagentType, SubagentDefinitionRegistry } from './subagent-definitions.js';

export interface SubagentDefinitionRoutesDeps {
  agentRegistry: AgentRegistry;
  /** The definition registry — the resolver, the listing AND the write root. */
  definitions: SubagentDefinitionRegistry;
}

/**
 * The definition file-name grammar. Deliberately IDENTICAL to the `name`
 * pattern `parseAgentDefinition` enforces on the frontmatter, so `<name>.md`
 * and the definition inside it live in the same key space and a round-trip
 * (PUT → GET → DELETE) is exact.
 *
 * It is also the FIRST of two traversal defences: no `/`, no `\`, no `.`, so
 * `..`, `../../etc/passwd` and `foo/bar` are all rejected before any path is
 * built. The second defence is the containment check in `resolveDefinitionFile`
 * — the name in the URL is exactly as attacker-controlled as the agent name
 * `perAgentDir` sanitises, and this is the only WRITE path the gateway exposes
 * into a name-derived directory.
 */
const DEFINITION_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Cap on a stored definition, so a PUT cannot fill the data dir in one call. */
const MAX_DEFINITION_BYTES = 256 * 1024;

/** Everything a roster entry exposes over HTTP. */
interface SubagentTypeView {
  name: string;
  description: string;
  source: ListedSubagentType['source'];
  location?: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: string;
  skills?: string[];
  maxTurns?: number;
  background?: boolean;
  isolation?: 'worktree';
  shadowedBy?: string;
}

/**
 * Project a roster entry for the wire. `systemPrompt` is DROPPED: it is the
 * whole body of every definition (kilobytes each, built-ins included), the
 * roster is fetched by the phone on every panel open, and the body is already
 * reachable one request away via `GET …/subagent-definitions/:name`.
 */
function toTypeView(type: ListedSubagentType): SubagentTypeView {
  return {
    name: type.name,
    description: type.description,
    source: type.source,
    ...(type.location && { location: type.location }),
    ...(type.tools && { tools: type.tools }),
    ...(type.disallowedTools && { disallowedTools: type.disallowedTools }),
    ...(type.model && { model: type.model }),
    ...(type.skills && { skills: type.skills }),
    ...(type.maxTurns !== undefined && { maxTurns: type.maxTurns }),
    ...(type.background !== undefined && { background: type.background }),
    ...(type.isolation && { isolation: type.isolation }),
    ...(type.shadowedBy && { shadowedBy: type.shadowedBy }),
  };
}

/**
 * Mounts the per-agent sub-agent DEFINITION routes onto an already-authed Hono
 * app. Mounted on BOTH the loopback app and `/mobile/v1` (the same dual mount
 * `mountConversationRoutes` uses) so MC and the phone reach one implementation.
 *
 * Routes:
 *   GET    /agents/:id/subagent-types             the resolved roster
 *   GET    /agents/:id/subagent-definitions       files in the per-agent dir
 *   GET    /agents/:id/subagent-definitions/:name one file's raw markdown
 *   PUT    /agents/:id/subagent-definitions/:name write it (422 on parse error)
 *   DELETE /agents/:id/subagent-definitions/:name remove it
 *
 * Every route 404s `{error:'not found'}` for an unknown agent id (registry
 * check first, matching `GET /agents/:id/skills` and the swarm routes).
 *
 * EVERY MUTATION INVALIDATES. A write that skipped `invalidate` would leave the
 * old roster live in every warm backend until the gateway restarted, which is
 * indistinguishable to the operator from the write not having happened.
 */
export function mountSubagentDefinitionRoutes(app: Hono, deps: SubagentDefinitionRoutesDeps): void {
  const { agentRegistry, definitions } = deps;

  /**
   * Resolve `<perAgentDir>/<name>.md`, or an error response.
   *
   * TWO independent gates, because this is the gateway's first user-name-driven
   * write path and one of them being subtly wrong must not be enough:
   *
   * 1. the name grammar (no separators, no dots) — and
   * 2. a realpath-free containment check on the JOINED path.
   *
   * `perAgentDir` sanitises the AGENT name (Task B3); this sanitises the
   * DEFINITION name. Both halves of the path are operator/user input.
   */
  function resolveDefinitionFile(
    agentName: string,
    name: string,
  ): { ok: true; dir: string; file: string } | { ok: false; error: string } {
    if (!DEFINITION_NAME_RE.test(name)) {
      return { ok: false, error: `name must match ${DEFINITION_NAME_RE.source}` };
    }
    const dir = resolve(definitions.perAgentDir(agentName));
    const file = resolve(join(dir, `${name}.md`));
    // Belt and braces: the grammar above already makes escape unreachable, but
    // this is the invariant that actually matters, so it is asserted rather
    // than inferred. `dir + sep` (not `dir`) so a sibling `…/agent-evil` cannot
    // pass as a child of `…/agent`.
    if (file !== join(dir, `${name}.md`) || !file.startsWith(dir + sep)) {
      return { ok: false, error: 'name escapes the definition directory' };
    }
    return { ok: true, dir, file };
  }

  /** Resolve the agent, or the shared 404 body. */
  function agentNameFor(id: string): string | undefined {
    return agentRegistry.get(id)?.config.name;
  }

  // GET /agents/:id/subagent-types
  //   → { types: SubagentTypeView[], unknownAllowedTypes: string[] }
  //
  // `unknownAllowedTypes` is surfaced, not swallowed: the registry is the only
  // layer that knows every resolvable name, and an `allowedTypes` typo
  // otherwise yields an orchestrator that can spawn nothing with no visible
  // cause. It is a diagnostic, never an error — the valid entries still apply.
  app.get('/agents/:id/subagent-types', async (c) => {
    const id = c.req.param('id');
    if (!agentRegistry.get(id)) return c.json({ error: 'not found' }, 404);
    const { types, unknownAllowedTypes } = await definitions.listFor(id);
    return c.json({ types: types.map(toTypeView), unknownAllowedTypes });
  });

  // GET /agents/:id/subagent-definitions → { definitions: [{ name, file }] }
  //
  // The per-agent DIR only (source `agent`) — the writable layer. Workspace and
  // plugin definitions are read-only here and appear in `/subagent-types`.
  app.get('/agents/:id/subagent-definitions', async (c) => {
    const id = c.req.param('id');
    const agentName = agentNameFor(id);
    if (agentName === undefined) return c.json({ error: 'not found' }, 404);
    const dir = definitions.perAgentDir(agentName);
    let names: string[];
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      names = entries
        .filter((e) => e.isFile() && e.name.endsWith('.md'))
        .map((e) => e.name)
        .sort();
    } catch (err) {
      // No dir yet is the normal case for an agent that never authored one.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
      names = [];
    }
    return c.json({
      definitions: names.map((file) => ({ name: file.slice(0, -'.md'.length), file })),
    });
  });

  // GET /agents/:id/subagent-definitions/:name → { name, raw }
  app.get('/agents/:id/subagent-definitions/:name', async (c) => {
    const id = c.req.param('id');
    const agentName = agentNameFor(id);
    if (agentName === undefined) return c.json({ error: 'not found' }, 404);
    const name = c.req.param('name');
    const resolved = resolveDefinitionFile(agentName, name);
    if (!resolved.ok) return c.json({ error: resolved.error }, 400);
    let raw: string;
    try {
      raw = await readFile(resolved.file, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') {
        return c.json({ error: 'not found' }, 404);
      }
      throw err;
    }
    return c.json({ name, raw });
  });

  // PUT /agents/:id/subagent-definitions/:name  body { raw } → { ok, name }
  //
  // VALIDATES BEFORE WRITING (422 with the parser's own message). Storing an
  // unparseable definition is strictly worse than rejecting it: the registry
  // skips it with a log line the author never sees, so the write "succeeds"
  // and the type simply never appears.
  app.put('/agents/:id/subagent-definitions/:name', async (c) => {
    const id = c.req.param('id');
    const agentName = agentNameFor(id);
    if (agentName === undefined) return c.json({ error: 'not found' }, 404);
    const name = c.req.param('name');
    const resolved = resolveDefinitionFile(agentName, name);
    if (!resolved.ok) return c.json({ error: resolved.error }, 400);

    let body: { raw?: unknown };
    try {
      body = (await c.req.json()) as { raw?: unknown };
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    const raw = body.raw;
    if (typeof raw !== 'string' || raw.trim() === '') {
      return c.json({ error: 'raw must be a non-empty string' }, 400);
    }
    if (Buffer.byteLength(raw, 'utf8') > MAX_DEFINITION_BYTES) {
      return c.json({ error: `raw must be at most ${MAX_DEFINITION_BYTES} bytes` }, 400);
    }

    const parsed = parseAgentDefinition(raw, { source: 'agent', location: resolved.file });
    if (!parsed.ok) return c.json({ error: parsed.error }, 422);

    await mkdir(resolved.dir, { recursive: true });
    await writeFile(resolved.file, raw, 'utf8');
    // Roster rebuild + warm-backend refresh. Synchronous listener dispatch; the
    // rebuild itself lands on the agent's NEXT model turn.
    definitions.invalidate(id);
    return c.json({ ok: true, name, definition: parsed.definition.name });
  });

  // DELETE /agents/:id/subagent-definitions/:name → { ok: true, name }
  app.delete('/agents/:id/subagent-definitions/:name', async (c) => {
    const id = c.req.param('id');
    const agentName = agentNameFor(id);
    if (agentName === undefined) return c.json({ error: 'not found' }, 404);
    const name = c.req.param('name');
    const resolved = resolveDefinitionFile(agentName, name);
    if (!resolved.ok) return c.json({ error: resolved.error }, 400);
    try {
      await unlink(resolved.file);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') {
        return c.json({ error: 'not found' }, 404);
      }
      throw err;
    }
    definitions.invalidate(id);
    return c.json({ ok: true, name });
  });
}
