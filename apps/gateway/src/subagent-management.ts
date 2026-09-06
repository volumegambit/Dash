import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { parseAgentDefinition } from '@dash/agent';
import type { ConversationSummary, SubagentInfo, SubagentStatus } from '@dash/mobile-contract';
import { type SwarmCoordinator, scanSubagentOutput } from '@dash/swarm';
import type { Hono } from 'hono';

import type { AgentRegistry } from './agent-registry.js';
import { toMobileApiError } from './conversation-routes.js';
import { ConversationServiceError } from './conversation-service.js';
import type { ConversationService } from './conversation-service.js';
import type { ListedSubagentType, SubagentDefinitionRegistry } from './subagent-definitions.js';

/** The two error kinds these routes can produce, before shaping. */
export type SubagentRouteErrorKind = 'not_found' | 'validation_failed';

export interface SubagentDefinitionRoutesDeps {
  agentRegistry: AgentRegistry;
  /** The definition registry — the resolver, the listing AND the write root. */
  definitions: SubagentDefinitionRegistry;
  /**
   * Shape an error body for THIS mount. Defaults to the loopback management
   * shape (`{ error }`).
   *
   * `/mobile/v1` MUST pass a `MobileApiError` shaper. That namespace is a frozen
   * versioned contract in which `MobileApiError` is declared
   * `required: [code, error, retryable]` with `additionalProperties: false`, the
   * 401 emitted by the surrounding middleware is already typed, and every other
   * dual-mounted family (`mountConversationRoutes`, `mountAgentRoutes`) returns
   * the envelope on every error path. A second, untyped shape in the same
   * namespace makes a strict client decoder throw.
   */
  errorBody?: (kind: SubagentRouteErrorKind, message: string) => unknown;
}

/** The loopback management shape, matching the swarm/skills/plugin routes. */
const plainErrorBody = (_kind: SubagentRouteErrorKind, message: string) => ({ error: message });

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
  const errorBody = deps.errorBody ?? plainErrorBody;
  const notFound = (message = 'not found') => errorBody('not_found', message);
  const invalid = (message: string) => errorBody('validation_failed', message);

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
    if (!agentRegistry.get(id)) return c.json(notFound(), 404);
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
    if (agentName === undefined) return c.json(notFound(), 404);
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
    if (agentName === undefined) return c.json(notFound(), 404);
    const name = c.req.param('name');
    const resolved = resolveDefinitionFile(agentName, name);
    if (!resolved.ok) return c.json(invalid(resolved.error), 400);
    let raw: string;
    try {
      raw = await readFile(resolved.file, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') {
        return c.json(notFound(), 404);
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
    if (agentName === undefined) return c.json(notFound(), 404);
    const name = c.req.param('name');
    const resolved = resolveDefinitionFile(agentName, name);
    if (!resolved.ok) return c.json(invalid(resolved.error), 400);

    let body: { raw?: unknown };
    try {
      body = (await c.req.json()) as { raw?: unknown };
    } catch {
      return c.json(invalid('Invalid JSON'), 400);
    }
    const raw = body.raw;
    if (typeof raw !== 'string' || raw.trim() === '') {
      return c.json(invalid('raw must be a non-empty string'), 400);
    }
    if (Buffer.byteLength(raw, 'utf8') > MAX_DEFINITION_BYTES) {
      return c.json(invalid(`raw must be at most ${MAX_DEFINITION_BYTES} bytes`), 400);
    }

    const parsed = parseAgentDefinition(raw, { source: 'agent', location: resolved.file });
    if (!parsed.ok) return c.json(invalid(parsed.error), 422);
    // The URL addresses the FILE; the registry keys the roster on the
    // FRONTMATTER name. Allowing them to diverge produces a definition this API
    // cannot address: the listing reports `<name>` (which resolves to nothing),
    // the roster reports the frontmatter name, and DELETE of the roster name
    // 404s because the caller has to guess the filename. Two files declaring one
    // frontmatter name is worse still — the registry picks a winner and the
    // loser's edits land on disk and vanish from the roster. Compared BEFORE the
    // registry's built-in canonicalisation, so `explore.md` + `name: explore`
    // (which goes on to shadow the built-in `Explore`) is accepted.
    if (parsed.definition.name !== name) {
      return c.json(
        invalid(`definition name "${parsed.definition.name}" must match the path name "${name}"`),
        422,
      );
    }

    await mkdir(resolved.dir, { recursive: true });
    await writeFile(resolved.file, raw, 'utf8');
    // Roster rebuild + warm-backend refresh. Synchronous listener dispatch; the
    // rebuild itself lands on the agent's NEXT model turn.
    definitions.invalidate(id);
    return c.json({ ok: true, name });
  });

  // DELETE /agents/:id/subagent-definitions/:name → { ok: true, name }
  app.delete('/agents/:id/subagent-definitions/:name', async (c) => {
    const id = c.req.param('id');
    const agentName = agentNameFor(id);
    if (agentName === undefined) return c.json(notFound(), 404);
    const name = c.req.param('name');
    const resolved = resolveDefinitionFile(agentName, name);
    if (!resolved.ok) return c.json(invalid(resolved.error), 400);
    try {
      await unlink(resolved.file);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') {
        return c.json(notFound(), 404);
      }
      throw err;
    }
    definitions.invalidate(id);
    return c.json({ ok: true, name });
  });
}

/**
 * A sub-agent status nothing can change any more. A `stop` against one is a
 * 409 rather than a silent success, so a client that raced the child's own
 * finish learns which of the two won.
 */
const TERMINAL_SUBAGENT_STATUSES: ReadonlySet<SubagentStatus> = new Set<SubagentStatus>([
  'done',
  'failed',
  'cancelled',
  'interrupted',
  'max_turns',
]);

/** One child as `GET /conversations/:id/subagents` reports it (design §7.7). */
export interface SubagentListEntry {
  id: string;
  name?: string;
  type: string;
  description: string;
  status: SubagentStatus;
  background: boolean;
  depth: number;
  startedAt: string;
  endedAt?: string;
  usage?: { inputTokens: number; outputTokens: number };
  toolCallCount: number;
  /** SCANNED — see {@link toListEntry}. */
  report?: string;
  /** Explore / Plan: `resume` will refuse. */
  oneShot: boolean;
}

export interface SubagentRuntimeRoutesDeps {
  conversations: ConversationService;
  /**
   * The live coordinator. `stop` and `resume` are the only two things these
   * routes cannot do from the store alone: a cascade has to reach descendants
   * this process holds handles for, and a resume has to rebuild the child's
   * grant.
   */
  coordinator: Pick<SwarmCoordinator, 'cancelChild' | 'sendToChild'>;
}

/**
 * Project a child row for the wire.
 *
 * The report is SCANNED. It is model output produced by a sub-agent, this is
 * the one route that hands it to a client to render raw, and the same scan
 * already guards the copy that reaches the parent's prompt
 * (`composeNotificationText`) — leaving the HTTP copy unscanned would just move
 * the injection one hop.
 *
 * `prompt`, `model`, `isolation` and `workspace` are deliberately dropped: the
 * first two are already in the child's own transcript and the last two name
 * filesystem paths a list view has no use for. `GET /conversations/:childId`
 * returns the full `SubagentInfo` for anything that needs them.
 */
function toListEntry(summary: ConversationSummary, info: SubagentInfo): SubagentListEntry {
  return {
    id: summary.id,
    ...(info.name !== undefined ? { name: info.name } : {}),
    type: info.type,
    description: info.description,
    status: info.status,
    background: info.background,
    depth: info.depth,
    startedAt: info.startedAt,
    ...(info.endedAt !== undefined ? { endedAt: info.endedAt } : {}),
    ...(info.usage !== undefined ? { usage: info.usage } : {}),
    toolCallCount: info.toolCallCount,
    ...(info.report !== undefined ? { report: scanSubagentOutput(info.report).text } : {}),
    oneShot: info.oneShot,
  };
}

/**
 * Mounts the sub-agent RUNTIME routes (design §7.7) onto an already-authed Hono
 * app. Mounted on BOTH the loopback app and `/mobile/v1`, like
 * `mountConversationRoutes`:
 *
 *   GET  /conversations/:id/subagents  the conversation's children
 *   POST /subagents/:id/stop           cancel cascade; 409 when terminal
 *   POST /subagents/:id/resume         `send_message` from the parent
 *
 * Every error path returns the typed `MobileApiError` envelope on BOTH mounts —
 * the same choice `mountConversationRoutes` makes, and the one `/mobile/v1`
 * requires (it declares `MobileApiError` `additionalProperties: false`, so a
 * second untyped shape in that namespace makes a strict client decoder throw).
 * These routes are new, so no loopback client depends on the older `{ error }`
 * shape the definition routes above still emit.
 *
 * The LIST reads the child conversation ROWS rather than the coordinator's
 * in-memory registry: the rows are written on every status transition AND they
 * are the only source that survives a restart, which is exactly the state a
 * client opening the tasks panel after a gateway restart is looking at.
 */
export function mountSubagentRuntimeRoutes(app: Hono, deps: SubagentRuntimeRoutesDeps): void {
  const { conversations, coordinator } = deps;

  /** The child row, or the typed 404 — `:id` must name a sub-agent conversation. */
  function requireChild(id: string): { summary: ConversationSummary; info: SubagentInfo } {
    const summary = conversations.get(id);
    // A parent conversation id here is a 404, not a 409: `/subagents/:id`
    // addresses children, and a user conversation is simply not in it.
    if (!summary || summary.kind !== 'subagent' || !summary.subagent) {
      throw new ConversationServiceError('not_found', `Sub-agent ${id} was not found`, 404, false);
    }
    return { summary, info: summary.subagent };
  }

  app.get('/conversations/:id/subagents', (c) => {
    try {
      const id = c.req.param('id');
      if (!conversations.get(id, { includeDeleted: true })) {
        throw new ConversationServiceError('not_found', 'Conversation not found', 404, false);
      }
      const subagents = conversations
        .listSubagents(id)
        .flatMap((summary) => (summary.subagent ? [toListEntry(summary, summary.subagent)] : []));
      return c.json({ subagents });
    } catch (error) {
      const mapped = toMobileApiError(error);
      return c.json(mapped.body, mapped.status);
    }
  });

  app.post('/subagents/:id/stop', async (c) => {
    try {
      const id = c.req.param('id');
      const { info } = requireChild(id);
      if (TERMINAL_SUBAGENT_STATUSES.has(info.status)) {
        throw new ConversationServiceError(
          'validation_failed',
          `Sub-agent ${id} is already ${info.status}`,
          409,
          false,
        );
      }
      // Depth-first through every descendant. A child this process no longer
      // holds a handle for is a no-op there, so the row is terminalized here
      // too — otherwise a stop after a restart would report success and leave
      // the row running forever.
      await coordinator.cancelChild(id, 'stopped by the client');
      const after = conversations.get(id)?.subagent?.status;
      if (after && TERMINAL_SUBAGENT_STATUSES.has(after)) {
        return c.json({ ok: true, status: after });
      }
      // `endedAt` is stamped with the status, exactly as every other terminal
      // write does (`ChildHandle.finalizeTerminal`, boot recovery): the list
      // route reads it, and recovery's idempotency key is its presence.
      const terminal = conversations.updateSubagent(id, {
        status: 'cancelled',
        info: { endedAt: new Date().toISOString() },
      });
      return c.json({ ok: true, status: terminal.subagent?.status });
    } catch (error) {
      const mapped = toMobileApiError(error);
      return c.json(mapped.body, mapped.status);
    }
  });

  app.post('/subagents/:id/resume', async (c) => {
    try {
      const id = c.req.param('id');
      const { summary } = requireChild(id);
      const body = (await c.req.json().catch(() => {
        throw new ConversationServiceError(
          'validation_failed',
          'Request body must be valid JSON',
          400,
          false,
        );
      })) as { message?: unknown };
      const message = body.message;
      if (typeof message !== 'string' || message.trim() === '') {
        throw new ConversationServiceError(
          'validation_failed',
          'message must be a nonblank string',
          400,
          false,
        );
      }
      const parentConversationId = summary.parentConversationId;
      if (!parentConversationId) {
        throw new ConversationServiceError(
          'validation_failed',
          `Sub-agent ${id} has no parent conversation`,
          409,
          false,
        );
      }
      try {
        // Deliberately the SAME call `send_message` makes, addressed from the
        // parent: one narrowing path, so an HTTP resume can never widen a
        // child past what the tool would have granted it.
        const result = coordinator.sendToChild(parentConversationId, id, message);
        return c.json(result);
      } catch (err) {
        // The coordinator throws with actionable text for its three refusals —
        // one-shot type, steer cap, unrebuildable grant. All are 409: the
        // request was well-formed and the child simply cannot take it.
        throw new ConversationServiceError(
          'validation_failed',
          err instanceof Error ? err.message : String(err),
          409,
          false,
        );
      }
    } catch (error) {
      const mapped = toMobileApiError(error);
      return c.json(mapped.body, mapped.status);
    }
  });
}
