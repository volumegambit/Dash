import type { AgentClient } from '@dash/agent';
import type { ChannelAdapter } from '@dash/channels';
import { TelegramAdapter, WhatsAppAdapter } from '@dash/channels';
import { type StructuredLogger, createConsoleLogger } from '@dash/logging';
import { Hono } from 'hono';
import type { Context } from 'hono';

import type { AgentChatCoordinator } from './agent-chat-coordinator.js';
import type { AgentRegistry, GatewayAgentConfig, RegisteredAgent } from './agent-registry.js';
import type { ChannelRegistry, ChannelRoutingRule } from './channel-registry.js';
import type { GatewayCredentialStore } from './credential-store.js';
import type { EventBus, GatewayEvent } from './event-bus.js';
import type { EventLogStore } from './event-log-store.js';
import type { DynamicGateway } from './gateway.js';
import type { McpManagementDeps } from './mcp-management.js';
import { mountMcpRoutes } from './mcp-management.js';
import { createModelsRoute } from './models-route.js';
import type { ModelsStore } from './models-store.js';

export interface GatewayManagementOptions {
  gateway: DynamicGateway;
  agents: AgentChatCoordinator;
  agentRegistry: AgentRegistry;
  channelRegistry: ChannelRegistry;
  credentialStore: GatewayCredentialStore;
  /**
   * Persistent model store. Created in `apps/gateway/src/index.ts` from
   * the gateway data dir. Mounted by the models route below; also
   * cleared by the credential POST/DELETE handlers so the next
   * `GET /models` triggers a fresh fetch with the new credential set.
   */
  modelsStore: ModelsStore;
  /**
   * Durable event log used by the chat-ws streaming path to record
   * every outbound event. The management API exposes a replay
   * endpoint that MC polls after a WebSocket drop. Optional only so
   * tests that don't exercise replay can skip wiring it up.
   */
  eventLogStore?: EventLogStore;
  token?: string;
  startedAt?: string;
  eventBus?: EventBus;
  mcpDeps?: McpManagementDeps;
  /**
   * Logger for request/response logging and internal events. Defaults to a
   * text-format console logger scoped to the `gateway-api` component. Pass a
   * shared logger from the gateway entrypoint to unify log streams.
   */
  logger?: StructuredLogger;
}

/**
 * Keys whose values must never appear in logs. Matched case-insensitively
 * against every property name in a request body. The match is exact (not
 * substring) to keep this tight — fields like `workspace` or `deploymentKey`
 * stay visible, while `providerApiKeys`, `value` (credentials payload),
 * `token`, etc. get redacted.
 */
const SECRET_KEY_PATTERN =
  /^(providerApiKeys|token|secret|password|apiKey|apikey|value|credentials?)$/i;

/**
 * Deep-clone a request body with any secret-keyed values replaced by
 * `[REDACTED]`. Non-mutating: returns a new object so the handler still
 * sees the unredacted body when it calls `c.req.json()` a second time.
 */
function redactSecrets(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redactSecrets);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_PATTERN.test(k)) {
      out[k] = '[REDACTED]';
    } else {
      out[k] = redactSecrets(v);
    }
  }
  return out;
}

/** Strip providerApiKeys from agent entries before returning to clients. */
function stripSecrets(entry: RegisteredAgent): RegisteredAgent {
  const { config, ...rest } = entry;
  const { providerApiKeys: _, ...safeConfig } = config;
  return { ...rest, config: safeConfig as GatewayAgentConfig };
}

/**
 * Parse the request body as JSON, returning a discriminated result. Callers
 * return `result.response` on failure, `result.body` on success. Avoids
 * repeating the same 4-line try/catch in every PUT/POST handler.
 */
async function parseJsonBody<T = Record<string, unknown>>(
  c: Context,
): Promise<{ ok: true; body: T } | { ok: false; response: Response }> {
  try {
    const body = (await c.req.json()) as T;
    return { ok: true, body };
  } catch {
    return { ok: false, response: c.json({ error: 'Invalid JSON' }, 400) };
  }
}

export function createGatewayManagementApp(options: GatewayManagementOptions): Hono {
  const { gateway, agents, agentRegistry, channelRegistry, credentialStore, token, eventBus } =
    options;
  const logger = options.logger ?? createConsoleLogger('info', 'text', 'gateway-api');
  const startedAt = options.startedAt ?? new Date().toISOString();
  const app = new Hono();

  // Request/response logging middleware. Placed first so unauthorized
  // attempts are logged too, and so the duration measurement wraps auth +
  // handler. `/health` is excluded to keep polling noise out of logs.
  //
  // Bodies are captured via `c.req.json()`, which Hono caches per request —
  // handlers that later call `c.req.json()` get the same parsed result, so
  // pre-reading here is non-destructive. Malformed JSON is caught and logged
  // as `[invalid json]`, leaving the handler's own try/catch to return 400.
  app.use('*', async (c, next) => {
    if (c.req.path === '/health') {
      await next();
      return;
    }
    const start = Date.now();
    const method = c.req.method;
    const path = c.req.path;
    const query = c.req.query();

    let body: unknown;
    if (method !== 'GET' && method !== 'DELETE') {
      const contentType = c.req.header('Content-Type') ?? '';
      if (contentType.includes('application/json')) {
        try {
          body = redactSecrets(await c.req.json());
        } catch {
          body = '[invalid json]';
        }
      }
    }

    const requestContext: Record<string, unknown> = { method, path };
    if (Object.keys(query).length > 0) requestContext.query = query;
    if (body !== undefined) requestContext.body = body;
    logger.info(`→ ${method} ${path}`, requestContext);

    try {
      await next();
    } finally {
      logger.info(`← ${method} ${path} ${c.res.status}`, {
        method,
        path,
        status: c.res.status,
        durationMs: Date.now() - start,
      });
    }
  });

  /**
   * Build the inline `AgentClient` bridge used by channel routing rules.
   * One place so any future change (e.g., agent lookup, metrics, tracing)
   * lands in all three call sites: POST /agents, POST /channels, and
   * startup restore (which lives in index.ts, not here).
   */
  function buildBridgeClient(agentId: string): AgentClient {
    return {
      chat(channelId, conversationId, text) {
        return agents.chat({ agentId, conversationId, channelId, text });
      },
    };
  }

  /**
   * Telegram token-rotation helper: when `POST /credentials` sets a key
   * matching `channel:<name>:token` and the named channel already exists,
   * stop the old adapter and re-register with a fresh `TelegramAdapter`
   * that captures the new token. Idempotent: if the channel doesn't
   * exist yet (initial setup flow), no-op and the credential is simply
   * staged for when POST /channels runs.
   *
   * Errors are logged but not re-raised — the credential itself has been
   * persisted successfully, which is what the HTTP caller asked for;
   * adapter restart failures leave the channel in a non-running state
   * that a subsequent gateway restart (or manual DELETE+POST) will heal.
   */
  async function restartChannelForTokenRotation(credentialKey: string): Promise<void> {
    const match = credentialKey.match(/^channel:(.+):token$/);
    if (!match) return;
    const channelName = match[1];
    const entry = channelRegistry.get(channelName);
    if (!entry || entry.adapter !== 'telegram') return;

    const newToken = await credentialStore.get(credentialKey);
    if (!newToken) return;

    try {
      await gateway.stopChannel(channelName);
      const adapter = new TelegramAdapter(
        newToken,
        () => channelRegistry.get(channelName)?.allowedUsers ?? [],
      );
      await gateway.registerChannel(channelName, adapter, {
        globalDenyList: entry.globalDenyList,
        routing: entry.routing,
      });
      // Re-bridge agents — registerAgent is idempotent (overwrites the
      // existing bridge client with one closing over the same agentId).
      for (const rule of entry.routing) {
        if (agentRegistry.get(rule.agentId)) {
          gateway.registerAgent(rule.agentId, buildBridgeClient(rule.agentId));
        }
      }
      eventBus?.emit({
        type: 'channel:restarted',
        channel: channelName,
        reason: 'token-rotation',
      });
      logger.info(`channel "${channelName}" restarted after token rotation`, {
        channel: channelName,
        reason: 'token-rotation',
      });
    } catch (err) {
      logger.error(
        `channel "${channelName}" token-rotation restart failed`,
        err instanceof Error ? err : undefined,
        { channel: channelName },
      );
    }
  }

  // Auth middleware — /health is exempt
  app.use('*', async (c, next) => {
    if (c.req.path === '/health') {
      await next();
      return;
    }
    if (token) {
      const auth = c.req.header('Authorization');
      if (!auth || auth !== `Bearer ${token}`) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
    }
    await next();
  });

  // --- Health ---

  app.get('/health', (c) => {
    return c.json({
      status: 'healthy',
      startedAt,
      // `pid` is load-bearing for MC's GatewaySupervisor: it lets the
      // supervisor identify the actual process holding port 9300
      // independently of its own gateway-state.json file. When state
      // drifts (e.g. an orphan gateway inherited by init after a parent
      // crashed), the supervisor's `state.pid` can point at the wrong
      // process — we'd SIGTERM the wrong thing and then hit EADDRINUSE
      // trying to spawn. Reading the real PID from the server itself
      // lets the supervisor kill the correct process every time.
      pid: process.pid,
      agents: agentRegistry.list().length,
      channels: channelRegistry.list().length,
    });
  });

  // --- Agent routes ---

  app.post('/agents', async (c) => {
    let body: GatewayAgentConfig;
    try {
      body = await c.req.json<GatewayAgentConfig>();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    if (!body.name || !body.model || body.systemPrompt == null) {
      return c.json({ error: 'Missing required fields: name, model, systemPrompt' }, 400);
    }
    try {
      const entry = agentRegistry.register(body);
      gateway.registerAgent(entry.id, buildBridgeClient(entry.id));
      await agentRegistry.save();
      eventBus?.emit({ type: 'agent:config-changed', agent: entry.name, fields: ['*'] });
      return c.json(stripSecrets(entry), 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      return c.json({ error: message }, 409);
    }
  });

  app.get('/agents', (c) => {
    return c.json(agentRegistry.list().map(stripSecrets));
  });

  app.get('/agents/:id', (c) => {
    const entry = agentRegistry.get(c.req.param('id'));
    if (!entry) return c.json({ error: 'not found' }, 404);
    return c.json(stripSecrets(entry));
  });

  app.put('/agents/:id', async (c) => {
    const id = c.req.param('id');
    const entry = agentRegistry.get(id);
    if (!entry) return c.json({ error: 'not found' }, 404);
    const parsed = await parseJsonBody<Partial<Omit<GatewayAgentConfig, 'name'>>>(c);
    if (!parsed.ok) return parsed.response;
    try {
      const updated = agentRegistry.update(id, parsed.body);
      await agentRegistry.save();
      eventBus?.emit({
        type: 'agent:config-changed',
        agent: entry.name,
        fields: Object.keys(parsed.body),
      });
      return c.json(stripSecrets(updated));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      return c.json({ error: message }, 500);
    }
  });

  app.delete('/agents/:id', async (c) => {
    const id = c.req.param('id');
    const entry = agentRegistry.get(id);
    if (!entry) return c.json({ error: 'not found' }, 404);
    try {
      const removedChannels = await gateway.deregisterAgent(id);
      for (const name of removedChannels) {
        channelRegistry.remove(name);
      }
      channelRegistry.removeRoutesForAgent(id);
      // Evict warm backends before removing the registry entry so any
      // in-flight streams are aborted and backend.stop() is called. The
      // pool is keyed independently of the registry, so order doesn't
      // affect correctness of the eviction itself — but doing it before
      // the registry remove means races that race a delete with a chat
      // get aborted rather than serving a deleted agent's state.
      await agents.evict(id);
      agentRegistry.remove(id);
      await agentRegistry.save();
      await channelRegistry.save();
      // Wipe the agent's durable event log last. If this throws we
      // still return ok — the registry + channel removal has already
      // happened and is the user-visible contract of DELETE; an
      // orphaned event-log row for a removed agent is benign (no
      // replay endpoint will return it because the agent lookup
      // fails first).
      try {
        options.eventLogStore?.deleteAgent(id);
      } catch (err) {
        logger.warn?.('Failed to delete event logs for agent', {
          agentId: id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return c.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      return c.json({ error: message }, 500);
    }
  });

  app.post('/agents/:id/disable', async (c) => {
    const id = c.req.param('id');
    try {
      agentRegistry.disable(id);
      await agentRegistry.save();
      return c.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      if (message.includes('not found')) return c.json({ error: message }, 404);
      return c.json({ error: message }, 500);
    }
  });

  app.post('/agents/:id/enable', async (c) => {
    const id = c.req.param('id');
    try {
      agentRegistry.enable(id);
      await agentRegistry.save();
      return c.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      if (message.includes('not found')) return c.json({ error: message }, 404);
      return c.json({ error: message }, 500);
    }
  });

  // --- Channel routes ---

  app.post('/channels', async (c) => {
    const parsed = await parseJsonBody<{
      name: string;
      adapter: string;
      routing: unknown[];
      globalDenyList?: string[];
      allowedUsers?: string[];
    }>(c);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;

    if (!body.name || !body.adapter || !body.routing) {
      return c.json({ error: 'Missing required fields: name, adapter, routing' }, 400);
    }
    if (body.allowedUsers !== undefined && !Array.isArray(body.allowedUsers)) {
      return c.json({ error: 'allowedUsers must be an array of strings' }, 400);
    }

    const routing = body.routing as ChannelRoutingRule[];
    const globalDenyList = body.globalDenyList ?? [];
    const allowedUsers = body.allowedUsers ?? [];
    const channelName = body.name;

    // Referential integrity: reject routing rules that reference agents
    // that don't exist. This is symmetric with `DELETE /agents/:id`,
    // which cascades to remove channel rules for the deleted agent.
    // Without this check, channels.json could accumulate dangling refs.
    const missingAgents = routing.map((r) => r.agentId).filter((id) => !agentRegistry.get(id));
    if (missingAgents.length > 0) {
      return c.json(
        {
          error: `routing references unknown agent(s): ${[...new Set(missingAgents)].join(', ')}`,
        },
        400,
      );
    }

    // Pre-register in the channel registry BEFORE constructing the adapter.
    // Two reasons:
    //   1. The TelegramAdapter is constructed with a closure that reads
    //      `allowedUsers` from the registry on every inbound message. If
    //      we registered after `adapter.start()`, there's a race where a
    //      message arriving immediately would see `undefined` and fall
    //      through as "no filter".
    //   2. The gateway's `resolveRouting` (wired in `index.ts`) also reads
    //      from the registry on every message — same race for routing.
    //
    // On failure we roll back the in-memory entry below so the registry
    // stays consistent with the running gateway.
    if (channelRegistry.has(channelName)) {
      return c.json({ error: `Channel '${channelName}' already exists` }, 409);
    }
    channelRegistry.register({
      name: channelName,
      adapter: body.adapter as 'telegram' | 'whatsapp',
      globalDenyList,
      allowedUsers,
      routing,
    });

    // Create adapter from credentials. Telegram uses a pull-based closure
    // over the registry so runtime edits to allowedUsers take effect on
    // the next message without restarting the bot.
    let adapter: ChannelAdapter;
    if (body.adapter === 'telegram') {
      const credKey = `channel:${channelName}:token`;
      const tok = await credentialStore.get(credKey);
      if (!tok) {
        channelRegistry.remove(channelName); // rollback
        return c.json({ error: `No credential found for key '${credKey}'` }, 400);
      }
      adapter = new TelegramAdapter(
        tok,
        () => channelRegistry.get(channelName)?.allowedUsers ?? [],
      );
    } else if (body.adapter === 'whatsapp') {
      const credKey = `channel:${channelName}:whatsapp-auth`;
      const authJson = await credentialStore.get(credKey);
      if (!authJson) {
        channelRegistry.remove(channelName); // rollback
        return c.json({ error: `No credential found for key '${credKey}'` }, 400);
      }
      const auth = JSON.parse(authJson) as Record<string, string>;
      adapter = new WhatsAppAdapter(auth, `data/whatsapp/${channelName}`);
    } else {
      channelRegistry.remove(channelName); // rollback
      return c.json({ error: `Unknown adapter type: ${body.adapter}` }, 400);
    }

    try {
      await gateway.registerChannel(channelName, adapter, { globalDenyList, routing });

      // Bridge agents for each routing rule. The agentIds were already
      // validated above, so every `agentRegistry.get()` here is guaranteed
      // to hit — the re-check stays as defense-in-depth against concurrent
      // agent removal between validation and registration.
      for (const rule of routing) {
        if (agentRegistry.get(rule.agentId)) {
          gateway.registerAgent(rule.agentId, buildBridgeClient(rule.agentId));
        }
      }

      await channelRegistry.save();
      eventBus?.emit({ type: 'channel:created', channel: channelName });
      return c.json({ ok: true }, 201);
    } catch (err) {
      // Registration with the gateway failed — roll back the registry
      // entry so the persisted state matches the running state. Best-effort
      // stop the adapter in case it partially started.
      await gateway.stopChannel(channelName).catch(() => {});
      channelRegistry.remove(channelName);
      const message = err instanceof Error ? err.message : 'Internal error';
      return c.json({ error: message }, 500);
    }
  });

  app.get('/channels', (c) => {
    return c.json(channelRegistry.list());
  });

  app.get('/channels/:name', (c) => {
    const name = decodeURIComponent(c.req.param('name'));
    const entry = channelRegistry.get(name);
    if (!entry) return c.json({ error: 'not found' }, 404);
    return c.json(entry);
  });

  app.put('/channels/:name', async (c) => {
    const name = decodeURIComponent(c.req.param('name'));
    const entry = channelRegistry.get(name);
    if (!entry) return c.json({ error: 'not found' }, 404);
    const parsed = await parseJsonBody(c);
    if (!parsed.ok) return parsed.response;
    const patch = parsed.body;

    // Validate array-typed fields so garbage input doesn't poison the
    // in-memory registry. Missing fields are fine — they're treated as
    // "no patch for this field".
    if (patch.allowedUsers !== undefined && !Array.isArray(patch.allowedUsers)) {
      return c.json({ error: 'allowedUsers must be an array of strings' }, 400);
    }
    if (patch.globalDenyList !== undefined && !Array.isArray(patch.globalDenyList)) {
      return c.json({ error: 'globalDenyList must be an array of strings' }, 400);
    }
    if (patch.routing !== undefined && !Array.isArray(patch.routing)) {
      return c.json({ error: 'routing must be an array of rules' }, 400);
    }

    // Referential integrity for routing edits: if the caller is replacing
    // the routing array, every new agentId must resolve. Stale agentIds
    // would otherwise route to nowhere and get audit-logged as
    // `agent_not_found` forever.
    if (patch.routing !== undefined) {
      const newRouting = patch.routing as ChannelRoutingRule[];
      const missingAgents = newRouting.map((r) => r.agentId).filter((id) => !agentRegistry.get(id));
      if (missingAgents.length > 0) {
        return c.json(
          {
            error: `routing references unknown agent(s): ${[...new Set(missingAgents)].join(', ')}`,
          },
          400,
        );
      }
    }

    try {
      // Runtime routing + allowedUsers edits propagate immediately: the
      // gateway's `resolveRouting` and the Telegram adapter's
      // `getAllowedUsers` closure both read from this registry on every
      // inbound message. No reconciliation plumbing required.
      const updated = channelRegistry.update(name, patch);
      await channelRegistry.save();
      eventBus?.emit({
        type: 'channel:config-changed',
        channel: name,
        fields: Object.keys(patch),
      });
      return c.json(updated);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      return c.json({ error: message }, 500);
    }
  });

  app.delete('/channels/:name', async (c) => {
    const name = decodeURIComponent(c.req.param('name'));
    const entry = channelRegistry.get(name);
    if (!entry) return c.json({ error: 'not found' }, 404);
    // Stop the adapter BEFORE removing from the registry. The gateway's
    // `resolveRouting` pulls from the registry on every message, so if we
    // removed first, in-flight messages between the remove and the stop
    // would be audit-logged as `channel_removed` rather than routed —
    // technically correct but chatty. Stopping first makes the shutdown
    // clean: no new messages, no polling, no stale routing.
    await gateway.stopChannel(name);
    channelRegistry.remove(name);
    await channelRegistry.save();
    eventBus?.emit({ type: 'channel:removed', channel: name });
    return c.json({ ok: true });
  });

  // --- Credential routes ---
  //
  // Writes only mutate the store; running agent backends pick up changes on
  // their next `run()` because they pull from the store via a credential
  // provider function (see apps/gateway/src/index.ts `createBackend`). This
  // means OAuth refresh, token rotation, and raw key set/delete all "just
  // work" without any propagation plumbing — the store is the single source
  // of truth.

  app.post('/credentials', async (c) => {
    const parsed = await parseJsonBody<{ key: string; value: string }>(c);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    if (!body.key || !body.value) {
      return c.json({ error: 'Missing required fields: key, value' }, 400);
    }
    await credentialStore.set(body.key, body.value);
    // If this is a provider API key, invalidate the model store so the
    // next GET /models triggers a fresh fetch with the new credential.
    if (/^[^:]+-api-key:/.test(body.key)) {
      await options.modelsStore.clear();
    }
    // Telegram token rotation: if this credential keys a running
    // Telegram channel, restart its adapter so the grammy Bot captures
    // the new token. No-op for other keys; no-op if no such channel
    // exists yet. Errors are logged but do not fail the request.
    await restartChannelForTokenRotation(body.key);
    return c.json({ ok: true }, 201);
  });

  app.get('/credentials', async (c) => {
    const keys = await credentialStore.list();
    return c.json(keys);
  });

  app.delete('/credentials/:key', async (c) => {
    const key = decodeURIComponent(c.req.param('key'));
    await credentialStore.delete(key);
    // Same invalidation as POST: provider key removed → model store stale.
    if (/^[^:]+-api-key:/.test(key)) {
      await options.modelsStore.clear();
    }
    return c.json({ ok: true });
  });

  // --- Models routes ---
  app.route('/models', createModelsRoute({ store: options.modelsStore, credentialStore }));

  // --- Event-log replay ---
  //
  // Called by MC after a chat WebSocket drops to fetch any events it
  // missed between the last seq it saw and the current tail. MC
  // passes `sinceSeq` as a query param; the gateway returns every
  // entry with `seq > sinceSeq` in seq order. Empty array when
  // there's nothing to replay.
  if (options.eventLogStore) {
    const eventLogStore = options.eventLogStore;
    app.get('/agents/:agentId/conversations/:conversationId/events', (c) => {
      const agentId = c.req.param('agentId');
      const conversationId = c.req.param('conversationId');
      if (!agentRegistry.get(agentId)) {
        return c.json({ error: 'agent not found' }, 404);
      }
      const sinceSeqRaw = c.req.query('sinceSeq');
      const sinceSeq = sinceSeqRaw === undefined ? 0 : Number.parseInt(sinceSeqRaw, 10);
      if (!Number.isFinite(sinceSeq) || sinceSeq < 0) {
        return c.json({ error: 'invalid sinceSeq' }, 400);
      }
      const entries = eventLogStore.readSince(agentId, conversationId, sinceSeq);
      return c.json({ entries });
    });
  }

  // --- MCP routes ---
  if (options.mcpDeps) {
    mountMcpRoutes(app, options.mcpDeps);
  }

  // --- SSE event stream ---

  if (eventBus) {
    const bus = eventBus;
    app.get('/events', (c) => {
      return c.newResponse(
        new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            const send = (event: GatewayEvent) => {
              try {
                controller.enqueue(
                  encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`),
                );
              } catch {
                // Stream may be closed
              }
            };
            const keepalive = setInterval(() => {
              try {
                controller.enqueue(encoder.encode(': keepalive\n\n'));
              } catch {
                clearInterval(keepalive);
              }
            }, 30_000);
            const unsub = bus.subscribe(send);
            c.req.raw.signal.addEventListener('abort', () => {
              unsub();
              clearInterval(keepalive);
            });
          },
        }),
        {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          },
        },
      );
    });
  }

  return app;
}
