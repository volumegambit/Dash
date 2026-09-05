import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentClient, MemoryType } from '@dash/agent';
import { MemoryOpError } from '@dash/agent';
import type { ChannelAdapter } from '@dash/channels';
import { TelegramAdapter, WhatsAppAdapter } from '@dash/channels';
import { type StructuredLogger, createConsoleLogger } from '@dash/logging';
import { mountProjectsRoutes } from '@dash/management';
import type { GatewayIdentity, MobileApiError, MobileCapability } from '@dash/mobile-contract';
import type { PluginConfigStore } from '@dash/plugins';
import { heuristicPluginScan, installPluginToDir, realpathContained } from '@dash/plugins';
import type { ProjectsDb } from '@dash/projects';
import type { SwarmCoordinator } from '@dash/swarm';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { BlankEnv } from 'hono/types';

import type { AgentChatCoordinator } from './agent-chat-coordinator.js';
import type { AgentRegistry, GatewayAgentConfig, RegisteredAgent } from './agent-registry.js';
import type { ChannelRegistry, ChannelRoutingRule } from './channel-registry.js';
import { mountConversationRoutes } from './conversation-routes.js';
import type { ConversationService } from './conversation-service.js';
import { type CompleteFn, generateConversationTitle } from './conversation-title.js';
import type { GatewayCredentialStore } from './credential-store.js';
import type { EventBus, GatewayEvent } from './event-bus.js';
import type { DynamicGateway } from './gateway.js';
import type { McpManagementDeps } from './mcp-management.js';
import { mountMcpRoutes } from './mcp-management.js';
import { mobileCors } from './mobile-cors.js';
import { createModelsController, createModelsRoute } from './models-route.js';
import type { ModelsStore } from './models-store.js';
import type { PluginWiringState } from './plugins-wiring.js';
import type { ResumableChatHub } from './resumable-chat-hub.js';
import { mountSwarmRoutes } from './swarm-management.js';

const MOBILE_CAPABILITIES: MobileCapability[] = ['conversation-sync-v1', 'chat-resume-v1'];

export interface GatewayManagementOptions {
  gateway: DynamicGateway;
  agents: AgentChatCoordinator;
  agentRegistry: AgentRegistry;
  channelRegistry: ChannelRegistry;
  identity: GatewayIdentity;
  credentialStore: GatewayCredentialStore;
  /**
   * Persistent model store. Created in `apps/gateway/src/index.ts` from
   * the gateway data dir. Mounted by the models route below; also
   * cleared by the credential POST/DELETE handlers so the next
   * `GET /models` triggers a fresh fetch with the new credential set.
   */
  modelsStore: ModelsStore;
  /** Canonical conversation metadata, messages, and the shared durable event journal. */
  conversationService: ConversationService;
  /** Process-wide resumable turn owner used to quiesce an agent before backend eviction. */
  resumableChatHub: Pick<ResumableChatHub, 'allowAgent' | 'cancelAgent'>;
  /** Shared projects DB. When present, mounts /projects + /issues + /inbox. */
  projectsDb?: ProjectsDb;
  /**
   * The swarm coordinator. When present, mounts the swarm panel routes
   * (`GET/POST /agents/:id/swarm/...`) and threads the cancel cascade into the
   * disable/delete agent handlers. Optional so tests/embedders that don't run
   * swarms still construct the app; the swarm routes simply aren't mounted.
   */
  swarmCoordinator?: SwarmCoordinator;
  /** Capability bearer accepted only by the `/mobile/v1` namespace. */
  mobileToken?: string;
  /** Administrative bearer accepted by every non-mobile management route. */
  token?: string;
  /**
   * Browser origins allowed to call `/mobile/v1` cross-origin (exact match).
   * Empty/unset (the default) disables CORS entirely. Configured here — not
   * only on the LAN app — because the relay replays phone traffic directly
   * against this server, bypassing `createLanMobileApp`; without it a browser
   * reaching the gateway through the relay gets no preflight answer.
   */
  webOrigins?: readonly string[];
  /** SHA-256 fingerprint for the persistent LAN HTTPS leaf, exposed only to MC. */
  lanTlsFingerprint?: string;
  startedAt?: string;
  eventBus?: EventBus;
  mcpDeps?: McpManagementDeps;
  /**
   * Logger for request/response logging and internal events. Defaults to a
   * text-format console logger scoped to the `gateway-api` component. Pass a
   * shared logger from the gateway entrypoint to unify log streams.
   */
  logger?: StructuredLogger;
  // --- Plugin management (all optional; absent in tests that don't wire
  // plugins → the plugin routes return 500 'plugins not configured'). ---
  /**
   * Live getter for the current plugin wiring. MUST be a getter (not a
   * snapshot) so the routes observe the rebuilt state after a reload — the
   * entrypoint reassigns its `wiringState` holder, and this closure reads it.
   */
  getPluginWiringState?: () => PluginWiringState;
  /**
   * Injectable LLM completion for the conversation-title route. Tests stub
   * this to avoid network access; production leaves it unset (pi-ai's
   * `complete`).
   */
  titleCompleteFn?: CompleteFn;
  /** Persistence for the per-plugin enable/trust/installed entries. */
  pluginConfigStore?: PluginConfigStore;
  /**
   * Re-run plugin discovery + rebuild wiring + swap the live reference + evict
   * warm backends. Owned by the entrypoint (it alone can reassign the wiring
   * holder + re-register MCP servers); the routes call it after persisting a
   * config change. Resolves to the rebuilt wiring; rejects on any reload error.
   */
  reloadPlugins?: () => Promise<PluginWiringState>;
  /**
   * Absolute plugins directory (`<dataDir>/plugins`). Used by DELETE to compute
   * an installed plugin's dir and guard the `rm -rf` with a realpath check.
   */
  pluginsDir?: string;
  /**
   * Absolute host data directory. Used by POST /plugins/install as the install
   * root — the plugin lands at `<dataDir>/plugins/<name>` (see
   * `installPluginToDir`). The install route 500s ('plugins not configured')
   * when this is absent.
   */
  dataDir?: string;
  /**
   * Graceful-shutdown trigger. When present, mounts `POST /lifecycle/shutdown`
   * (bearer-authed), which MC's GatewaySupervisor calls before escalating to
   * SIGTERM. The entrypoint wires this to the same shutdown sequence as the
   * signal handlers. The route responds 200 first and invokes this on a short
   * deferral — the sequence closes this very server and exits the process, so
   * running it inline would kill the in-flight response.
   */
  onShutdown?: () => void | Promise<void>;
}

/** Strip providerApiKeys from agent entries before returning to clients. */
function stripSecrets(entry: RegisteredAgent): RegisteredAgent {
  const { config, ...rest } = entry;
  const { providerApiKeys: _, ...safeConfig } = config;
  return { ...rest, config: safeConfig as GatewayAgentConfig };
}

/** Describe failures without serializing their message, stack, cause, or custom properties. */
function errorLogContext(
  error: unknown,
  context: Record<string, unknown> = {},
): Record<string, unknown> {
  if (error instanceof Error) {
    return { ...context, errorKind: 'error', errorMessageLength: error.message.length };
  }
  if (typeof error === 'string') {
    return { ...context, errorKind: 'string', errorMessageLength: error.length };
  }
  return {
    ...context,
    errorKind: error === null ? 'null' : Array.isArray(error) ? 'array' : typeof error,
  };
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

const AGENT_CREATE_KEYS = new Set([
  'name',
  'model',
  'systemPrompt',
  'fallbackModels',
  'tools',
  'skills',
  'providerApiKeys',
  'workspace',
  'maxTokens',
  'mcpServers',
  'swarm',
  'plugins',
  'providers',
]);
const AGENT_UPDATE_KEYS = new Set([...AGENT_CREATE_KEYS].filter((key) => key !== 'name'));
const MOBILE_AGENT_CREATE_KEYS = new Set(['name', 'model', 'systemPrompt']);
const MOBILE_AGENT_UPDATE_KEYS = new Set(['model', 'systemPrompt']);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function requireAgentStringArray(value: unknown, field: string): void {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || item.trim().length === 0)
  ) {
    throw new Error(`${field} must be an array of nonblank strings`);
  }
}

function validateAgentSkills(value: unknown): void {
  if (!isPlainRecord(value) || Object.keys(value).some((key) => !['paths', 'urls'].includes(key))) {
    throw new Error('skills must contain only paths and urls');
  }
  if (value.paths !== undefined) requireAgentStringArray(value.paths, 'skills.paths');
  if (value.urls !== undefined) requireAgentStringArray(value.urls, 'skills.urls');
}

function validateAgentSwarm(value: unknown): void {
  const allowed = new Set([
    'enabled',
    'maxConcurrentWorkers',
    'maxWorkersPerRun',
    'maxSteersPerWorker',
    'maxRunSeconds',
    'allowedModels',
  ]);
  if (!isPlainRecord(value) || Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error('swarm contains unknown or invalid fields');
  }
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
    throw new Error('swarm.enabled must be a boolean');
  }
  for (const key of ['maxConcurrentWorkers', 'maxWorkersPerRun', 'maxRunSeconds'] as const) {
    const item = value[key];
    if (item !== undefined && (!Number.isInteger(item) || (item as number) < 1)) {
      throw new Error(`swarm.${key} must be a positive integer`);
    }
  }
  if (
    value.maxSteersPerWorker !== undefined &&
    (!Number.isInteger(value.maxSteersPerWorker) || (value.maxSteersPerWorker as number) < 0)
  ) {
    throw new Error('swarm.maxSteersPerWorker must be a non-negative integer');
  }
  if (value.allowedModels !== undefined) {
    requireAgentStringArray(value.allowedModels, 'swarm.allowedModels');
  }
}

function validateAgentField(key: string, value: unknown): void {
  if (key === 'name' || key === 'model') {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`${key} must be a nonblank string`);
    }
    return;
  }
  if (key === 'systemPrompt' || key === 'workspace') {
    if (typeof value !== 'string') throw new Error(`${key} must be a string`);
    return;
  }
  if (
    key === 'fallbackModels' ||
    key === 'tools' ||
    key === 'mcpServers' ||
    key === 'plugins' ||
    key === 'providers'
  ) {
    if ((key === 'plugins' || key === 'providers') && value === null) return;
    requireAgentStringArray(value, key);
    return;
  }
  if (key === 'skills') {
    validateAgentSkills(value);
    return;
  }
  if (key === 'providerApiKeys') {
    if (!isPlainRecord(value) || Object.values(value).some((item) => typeof item !== 'string')) {
      throw new Error('providerApiKeys must map providers to strings');
    }
    return;
  }
  if (key === 'maxTokens') {
    if (!Number.isInteger(value) || (value as number) < 1) {
      throw new Error('maxTokens must be a positive integer');
    }
    return;
  }
  if (key === 'swarm') validateAgentSwarm(value);
}

function parseAgentCreateRequest(
  value: unknown,
  allowedKeys: ReadonlySet<string> = AGENT_CREATE_KEYS,
): GatewayAgentConfig {
  if (!isPlainRecord(value)) throw new Error('Request body must be an object');
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new Error('Request body contains unknown fields');
  }
  for (const key of ['name', 'model', 'systemPrompt']) {
    if (!Object.hasOwn(value, key)) {
      throw new Error('Missing required fields: name, model, systemPrompt');
    }
  }
  for (const [key, item] of Object.entries(value)) validateAgentField(key, item);
  return value as unknown as GatewayAgentConfig;
}

type AgentUpdateRequest = Parameters<AgentRegistry['update']>[1];

function parseAgentUpdateRequest(
  value: unknown,
  allowedKeys: ReadonlySet<string> = AGENT_UPDATE_KEYS,
): AgentUpdateRequest {
  if (!isPlainRecord(value)) throw new Error('Request body must be an object');
  const keys = Object.keys(value);
  if (keys.length === 0) throw new Error('Request body must not be empty');
  if (keys.some((key) => !allowedKeys.has(key))) {
    throw new Error('Request body contains unknown fields');
  }
  for (const [key, item] of Object.entries(value)) validateAgentField(key, item);
  return value as AgentUpdateRequest;
}

function mobileValidationError(error: string): MobileApiError {
  return { code: 'validation_failed', error, retryable: false };
}

function mobileAgentNotFound(): MobileApiError {
  return { code: 'not_found', error: 'Agent not found', retryable: false };
}

function mobileGatewayError(): MobileApiError {
  return { code: 'gateway_offline', error: 'Internal gateway error', retryable: true };
}

/**
 * Map a plugin install/marketplace error to an HTTP status + body. Mirrors
 * `mapSkillError`, keyed on the `code` carried by `PluginOpError`:
 * - `not_found` → 404
 * - `duplicate` → 409
 * - `invalid_manifest` | `corrupt_archive` | `scan_failed` | `dangerous` → 422
 * - anything else → 500
 */
export function mapPluginError(err: unknown): {
  status: 404 | 409 | 422 | 500;
  body: { error: string };
} {
  const code = err instanceof Error && 'code' in err ? (err as { code?: string }).code : undefined;
  const message = err instanceof Error ? err.message : 'Internal error';
  const status: 404 | 409 | 422 | 500 =
    code === 'not_found'
      ? 404
      : code === 'duplicate'
        ? 409
        : code === 'invalid_manifest' ||
            code === 'corrupt_archive' ||
            code === 'scan_failed' ||
            code === 'dangerous'
          ? 422
          : 500;
  return { status, body: { error: message } };
}

/** Shared by the loopback and `/mobile/v1` registrations of the replay route. */
const REPLAY_EVENTS_PATH = '/agents/:agentId/conversations/:conversationId/events' as const;

export function createGatewayManagementApp(options: GatewayManagementOptions): Hono {
  const { gateway, agents, agentRegistry, channelRegistry, credentialStore, token, eventBus } =
    options;
  const logger = options.logger ?? createConsoleLogger('info', 'text', 'gateway-api');
  const startedAt = options.startedAt ?? new Date().toISOString();
  const app = new Hono();
  const mobileV1 = new Hono();

  // Request/response logging middleware. Placed first so unauthorized
  // attempts are logged too, and so the duration measurement wraps auth +
  // handler. `/health` is excluded to keep polling noise out of logs.
  //
  // Request values are deliberately excluded. Agent prompts, conversation
  // titles, answers, and query filters are user data, and Mission Control
  // persists this stream to gateway.log. Shape-only metadata is sufficient
  // for request diagnostics without creating a second transcript.
  app.use('*', async (c, next) => {
    if (c.req.path === '/health' || c.req.path === '/mobile/v1/health') {
      await next();
      return;
    }
    const start = Date.now();
    const method = c.req.method;
    const path = c.req.path;
    const queryKeys = Object.keys(c.req.query()).sort();
    const contentType = c.req.header('Content-Type') ?? '';
    const hasJsonBody =
      method !== 'GET' && method !== 'DELETE' && contentType.includes('application/json');

    const requestContext: Record<string, unknown> = { method, path };
    if (queryKeys.length > 0) requestContext.queryKeys = queryKeys;
    if (hasJsonBody) requestContext.hasJsonBody = true;
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
      listSkills() {
        return agents.listSkills(agentId);
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
      logger.info('channel restarted after token rotation', {
        channel: channelName,
        reason: 'token-rotation',
      });
    } catch (err) {
      logger.error(
        'channel token-rotation restart failed',
        undefined,
        errorLogContext(err, { channel: channelName }),
      );
    }
  }

  // CORS for the `/mobile/v1` namespace, registered BEFORE the auth middleware
  // so a preflight OPTIONS is answered and short-circuited here: browsers strip
  // author-set headers from preflights, so one can never carry a bearer. Scoped
  // to `/mobile/v1` only — every administrative route stays CORS-free. See
  // mobile-cors.ts for the exact-origin/no-credentials ruleset; an empty
  // allowlist (the default) mounts a no-op.
  const mobileCorsMiddleware = mobileCors(options.webOrigins ?? []);
  app.use('/mobile/v1', mobileCorsMiddleware);
  app.use('/mobile/v1/*', mobileCorsMiddleware);

  // Auth middleware — /health is exempt. /projects/ws is exempt too:
  // WebSocket clients cannot send an Authorization header, and the route
  // (mounted on this app by the gateway via mountProjectsWs) enforces the
  // same token itself through its ?token= query param.
  app.use('*', async (c, next) => {
    if (
      c.req.path === '/health' ||
      c.req.path === '/mobile/v1/health' ||
      c.req.path === '/projects/ws'
    ) {
      await next();
      return;
    }
    const mobileRoute = c.req.path === '/mobile/v1' || c.req.path.startsWith('/mobile/v1/');
    const expectedToken = mobileRoute ? options.mobileToken : token;
    const authConfigured = token !== undefined || options.mobileToken !== undefined;
    if (authConfigured) {
      const auth = c.req.header('Authorization');
      if (!expectedToken || !auth || auth !== `Bearer ${expectedToken}`) {
        return c.json({ code: 'unauthorized', error: 'Unauthorized', retryable: false }, 401);
      }
    }
    await next();
  });

  // --- Health ---

  const healthHandler = (c: Context) => {
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
      apiVersion: 1,
      capabilities: MOBILE_CAPABILITIES,
    });
  };
  app.get('/health', healthHandler);
  mobileV1.get('/health', healthHandler);

  // --- Lifecycle ---
  // Bearer-authed (the app.use('*') middleware above). MC's GatewaySupervisor
  // POSTs this as its graceful-shutdown attempt before SIGTERM
  // (shutdownStaleProcess in packages/mc/src/runtime/process.ts). Respond
  // first, tear down on a deferral: the shutdown sequence closes this server
  // and exits the process, which would otherwise drop the in-flight response.
  // MC also SIGTERMs right after — the entrypoint's shutdown() is idempotent,
  // so the overlap is harmless.
  if (options.onShutdown) {
    const onShutdown = options.onShutdown;
    app.post('/lifecycle/shutdown', (c) => {
      setTimeout(() => {
        Promise.resolve(onShutdown()).catch((err) => {
          logger.error('lifecycle shutdown failed', undefined, errorLogContext(err));
        });
      }, 100);
      return c.json({ ok: true });
    });
  }

  // --- Gateway identity ---
  // Authed (behind the bearer middleware registered above) and always mounted.
  const identityHandler = (c: Context) => c.json(options.identity);
  app.get('/identity', identityHandler);
  mobileV1.get('/identity', identityHandler);

  // Mission Control reads this over the loopback-only administrative API when
  // constructing a LAN pairing payload. It is deliberately absent from the
  // phone-scoped namespace: the fingerprint is transferred out-of-band in the
  // QR code and then treated as the trust anchor by native clients.
  if (options.lanTlsFingerprint) {
    app.get('/lan-tls', (c) => c.json({ certificateSha256: options.lanTlsFingerprint as string }));
  }

  mountConversationRoutes(app, {
    conversations: options.conversationService,
    agentRegistry,
    eventBus,
  });
  mountConversationRoutes(mobileV1, {
    conversations: options.conversationService,
    agentRegistry,
    eventBus,
  });

  // --- Agent routes ---
  const agentLifecycleTails = new Map<string, Promise<void>>();

  async function serializeAgentLifecycle<T>(
    agentId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = agentLifecycleTails.get(agentId) ?? Promise.resolve();
    let release!: () => void;
    const completed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => completed);
    agentLifecycleTails.set(agentId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (agentLifecycleTails.get(agentId) === tail) agentLifecycleTails.delete(agentId);
    }
  }

  function mountAgentRoutes(
    target: Hono,
    createKeys: ReadonlySet<string>,
    updateKeys: ReadonlySet<string>,
  ): void {
    target.post('/agents', async (c) => {
      let raw: unknown;
      try {
        raw = await c.req.json<unknown>();
      } catch {
        return c.json(mobileValidationError('Request body must be valid JSON'), 400);
      }
      let body: GatewayAgentConfig;
      try {
        body = parseAgentCreateRequest(raw, createKeys);
      } catch (error) {
        return c.json(
          mobileValidationError(error instanceof Error ? error.message : 'Request body is invalid'),
          400,
        );
      }
      let entry: RegisteredAgent;
      try {
        entry = agentRegistry.register(body);
      } catch (error) {
        return c.json(
          mobileValidationError(error instanceof Error ? error.message : 'Agent config is invalid'),
          400,
        );
      }
      try {
        gateway.registerAgent(entry.id, buildBridgeClient(entry.id));
        await agentRegistry.save();
        eventBus?.emit({ type: 'agent:config-changed', agent: entry.name, fields: ['*'] });
        return c.json(stripSecrets(entry), 201);
      } catch (error) {
        logger.error('mobile agent create failed', undefined, errorLogContext(error));
        return c.json(mobileGatewayError(), 500);
      }
    });

    target.get('/agents', (c) => c.json(agentRegistry.list().map(stripSecrets)));

    target.get('/agents/:id', (c) => {
      const entry = agentRegistry.get(c.req.param('id'));
      if (!entry) return c.json(mobileAgentNotFound(), 404);
      return c.json(stripSecrets(entry));
    });

    target.put('/agents/:id', async (c) => {
      const id = c.req.param('id');
      const entry = agentRegistry.get(id);
      if (!entry) return c.json(mobileAgentNotFound(), 404);
      let raw: unknown;
      try {
        raw = await c.req.json<unknown>();
      } catch {
        return c.json(mobileValidationError('Request body must be valid JSON'), 400);
      }
      let body: AgentUpdateRequest;
      try {
        body = parseAgentUpdateRequest(raw, updateKeys);
      } catch (error) {
        return c.json(
          mobileValidationError(error instanceof Error ? error.message : 'Request body is invalid'),
          400,
        );
      }
      // Snapshot the pre-update swarm block so we can detect a swarm-config change
      // after the update and evict warm backends (a running orchestrator caches
      // its swarm gate/caps; eviction forces the next chat to rebuild with the new
      // config). Deep-compared via JSON.stringify — the block is plain data.
      const oldSwarm = JSON.stringify(entry.config.swarm);
      let updated: RegisteredAgent;
      try {
        updated = agentRegistry.update(id, body);
      } catch (error) {
        return c.json(
          mobileValidationError(error instanceof Error ? error.message : 'Agent config is invalid'),
          400,
        );
      }
      try {
        await agentRegistry.save();
        eventBus?.emit({
          type: 'agent:config-changed',
          agent: entry.name,
          fields: Object.keys(body),
        });
        if (JSON.stringify(updated.config.swarm) !== oldSwarm) {
          await agents.evict(id);
        }
        return c.json(stripSecrets(updated));
      } catch (error) {
        logger.error(
          'mobile agent update failed',
          undefined,
          errorLogContext(error, { agentId: id }),
        );
        return c.json(mobileGatewayError(), 500);
      }
    });

    target.delete('/agents/:id', (c) => {
      const id = c.req.param('id');
      return serializeAgentLifecycle(id, async () => {
        const entry = agentRegistry.get(id);
        if (!entry) return c.json(mobileAgentNotFound(), 404);
        try {
          await options.resumableChatHub.cancelAgent(id);
          const removedChannels = await gateway.deregisterAgent(id);
          for (const name of removedChannels) {
            channelRegistry.remove(name);
          }
          channelRegistry.removeRoutesForAgent(id);
          // Finalize any live swarm runs for this agent before eviction. cancelRunsFor
          // cancels non-terminal workers + aborts the orchestrator synchronously, so
          // the subsequent evict() tears down an already-quiesced backend.
          options.swarmCoordinator?.cancelRunsFor(id);
          // Evict warm backends before removing the registry entry so any
          // in-flight streams are aborted and backend.stop() is called. The
          // pool is keyed independently of the registry, so order doesn't
          // affect correctness of the eviction itself — but doing it before
          // the registry remove means races that race a delete with a chat
          // get aborted rather than serving a deleted agent's state.
          await agents.evict(id);
          const archived = options.conversationService.archiveAgentConversations(id);
          agentRegistry.remove(id);
          await agentRegistry.save();
          await channelRegistry.save();
          for (const conversation of archived) {
            eventBus?.emit({
              type: 'conversation:changed',
              conversationId: conversation.id,
              revision: conversation.revision,
            });
          }
          eventBus?.emit({
            type: 'agent:config-changed',
            agent: entry.name,
            fields: ['removed'],
          });
          return c.json({ ok: true });
        } catch (error) {
          logger.error(
            'mobile agent delete failed',
            undefined,
            errorLogContext(error, { agentId: id }),
          );
          return c.json(mobileGatewayError(), 500);
        }
      });
    });

    target.post('/agents/:id/disable', (c) => {
      const id = c.req.param('id');
      return serializeAgentLifecycle(id, async () => {
        const entry = agentRegistry.get(id);
        if (!entry) return c.json(mobileAgentNotFound(), 404);
        try {
          agentRegistry.disable(id);
          await agentRegistry.save();
          await options.resumableChatHub.cancelAgent(id);
          // Disable must actually stop a running orchestrator: cancel its live swarm
          // runs, then evict the warm backend (which aborts the pinned in-flight
          // turn — intentional per the design, disable is a hard stop). Ordered so
          // the swarm runs quiesce before the backend teardown.
          options.swarmCoordinator?.cancelRunsFor(id);
          await agents.evict(id);
          eventBus?.emit({
            type: 'agent:config-changed',
            agent: entry.name,
            fields: ['enabled'],
          });
          return c.json({ ok: true });
        } catch (error) {
          logger.error(
            'mobile agent disable failed',
            undefined,
            errorLogContext(error, { agentId: id }),
          );
          return c.json(mobileGatewayError(), 500);
        }
      });
    });

    target.post('/agents/:id/enable', (c) => {
      const id = c.req.param('id');
      return serializeAgentLifecycle(id, async () => {
        const entry = agentRegistry.get(id);
        if (!entry) return c.json(mobileAgentNotFound(), 404);
        try {
          agentRegistry.enable(id);
          await agentRegistry.save();
          options.resumableChatHub.allowAgent(id);
          eventBus?.emit({
            type: 'agent:config-changed',
            agent: entry.name,
            fields: ['enabled'],
          });
          return c.json({ ok: true });
        } catch (error) {
          logger.error(
            'mobile agent enable failed',
            undefined,
            errorLogContext(error, { agentId: id }),
          );
          return c.json(mobileGatewayError(), 500);
        }
      });
    });

    // --- Memory: reads + delete ---
    // Mounted on `target`, so these exist on the loopback administrative API
    // *and* under `/mobile/v1` — the iOS client browses and deletes memories.
    // The write (PUT) and config routes are deliberately loopback-only and are
    // registered directly on `app` just below this function's call sites.
    target.get('/agents/:id/memory', async (c) => {
      const id = c.req.param('id');
      if (!agentRegistry.get(id)) return c.json({ error: 'not found' }, 404);
      // Reads never throw for a memory-disabled agent — the coordinator
      // degrades to an empty list, which renders as "no memories" rather than
      // an error banner.
      return c.json(await agents.listMemories(id));
    });

    target.get('/agents/:id/memory/:name', async (c) => {
      const id = c.req.param('id');
      if (!agentRegistry.get(id)) return c.json({ error: 'not found' }, 404);
      const record = await agents.getMemory(id, c.req.param('name'));
      if (!record) return c.json({ error: 'not found' }, 404);
      return c.json(record);
    });

    target.delete('/agents/:id/memory/:name', async (c) => {
      const id = c.req.param('id');
      if (!agentRegistry.get(id)) return c.json({ error: 'not found' }, 404);
      const name = c.req.param('name');
      try {
        const removed = await agents.removeMemory(id, name);
        if (!removed) return c.json({ error: 'not found' }, 404);
        return c.json({ name });
      } catch (err) {
        const m = mapMemoryError(err);
        return c.json(m.body, m.status);
      }
    });
  }

  // --- Memory routes: mapper + the loopback-only half ---

  /**
   * Status mapping for the memory routes, mirroring `mapSkillError` but keyed
   * on the `code` carried by `MemoryOpError`: `invalid` -> 400 (bad name/type/
   * oversized content), `not_found` -> 404, `limit` -> 409 (per-agent cap).
   * The coordinator's save path throws a plain Error when memory is disabled
   * for the agent, and every memory path throws when the embedding has no
   * memory directory at all; those are configuration states, not client
   * mistakes, so they surface as 503.
   */
  const mapMemoryError = (
    err: unknown,
  ): { status: 400 | 404 | 409 | 500 | 503; body: { error: string } } => {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof MemoryOpError) {
      const status: 400 | 404 | 409 =
        err.code === 'invalid' ? 400 : err.code === 'not_found' ? 404 : 409;
      return { status, body: { error: message } };
    }
    if (message.includes('Memory is disabled') || message.includes('Memory is not configured')) {
      return { status: 503, body: { error: message } };
    }
    return { status: 500, body: { error: message } };
  };

  /** `memory` absent means enabled with sweep 'auto' (legacy agents). */
  const resolveMemoryConfig = (
    memory: GatewayAgentConfig['memory'],
  ): { enabled: boolean; sweep: 'auto' | 'on' | 'off' } => ({
    enabled: memory?.enabled !== false,
    sweep: memory?.sweep ?? 'auto',
  });

  // ROUTE ORDER IS LOAD-BEARING. Hono runs *every* handler whose pattern
  // matches, in registration order, stopping at the first that returns a
  // Response. `mountAgentRoutes` registers `GET /agents/:id/memory/:name` on
  // `app`, so these `/agents/:id/memory/config` routes MUST be registered
  // BEFORE that call — otherwise `:name` wins and `/memory/config` 404s as
  // "no memory named config". Covered by the route-order test in
  // management-api-server.test.ts.
  //
  // These three routes are loopback-only (never mounted on `mobileV1`):
  // Mission Control is the only client that edits or configures memory.
  app.get('/agents/:id/memory/config', (c) => {
    const entry = agentRegistry.get(c.req.param('id'));
    if (!entry) return c.json({ error: 'not found' }, 404);
    return c.json(resolveMemoryConfig(entry.config.memory));
  });

  app.patch('/agents/:id/memory/config', async (c) => {
    const id = c.req.param('id');
    const entry = agentRegistry.get(id);
    if (!entry) return c.json({ error: 'not found' }, 404);
    const parsed = await parseJsonBody<{ enabled?: boolean; sweep?: 'auto' | 'on' | 'off' }>(c);
    if (!parsed.ok) return parsed.response;
    // `parseJsonBody` only rejects UNPARSEABLE JSON: `null`, `[]` and `"str"`
    // all parse fine. Reading a property off them below would throw outside any
    // try (and the app registers no onError), so Hono would answer 500 for what
    // is a client mistake. Check the shape before touching a single key.
    if (!parsed.body || typeof parsed.body !== 'object' || Array.isArray(parsed.body)) {
      return c.json({ error: 'Request body must be a JSON object' }, 400);
    }
    if (parsed.body.enabled !== undefined && typeof parsed.body.enabled !== 'boolean') {
      return c.json({ error: 'enabled must be a boolean' }, 400);
    }
    if (parsed.body.sweep !== undefined && !['auto', 'on', 'off'].includes(parsed.body.sweep)) {
      return c.json({ error: 'sweep must be auto, on or off' }, 400);
    }
    // Merge, don't replace: a patch that only carries `sweep` must not drop a
    // previously stored `enabled` (and vice versa). Keys are copied one by one
    // rather than spreading the raw body so unknown fields never reach disk.
    const memory: NonNullable<GatewayAgentConfig['memory']> = { ...entry.config.memory };
    if (parsed.body.enabled !== undefined) memory.enabled = parsed.body.enabled;
    if (parsed.body.sweep !== undefined) memory.sweep = parsed.body.sweep;
    const wasEnabled = resolveMemoryConfig(entry.config.memory).enabled;
    agentRegistry.update(id, { memory });
    await agentRegistry.save();
    // Same reason `PUT /agents/:id` evicts on a swarm change: the memory TOOLS
    // (save_memory/recall_memory/forget_memory) are registered when the backend
    // is built, not per turn, so a warm conversation would keep them live after
    // a disable — letting the model write memories the operator can then
    // neither list nor delete. Eviction forces the next turn to rebuild.
    // `sweep` needs no eviction: it is read from the registry per turn.
    if (resolveMemoryConfig(memory).enabled !== wasEnabled) {
      await agents.evict(id);
    }
    return c.json(resolveMemoryConfig(memory));
  });

  app.put('/agents/:id/memory/:name', async (c) => {
    const id = c.req.param('id');
    if (!agentRegistry.get(id)) return c.json({ error: 'not found' }, 404);
    const parsed = await parseJsonBody<{
      description: string;
      type: MemoryType;
      content: string;
    }>(c);
    if (!parsed.ok) return parsed.response;
    // See the PATCH handler: `null`, `[]` and `"str"` are all valid JSON, and
    // destructuring `null` below throws a TypeError outside the try -> 500.
    if (!parsed.body || typeof parsed.body !== 'object' || Array.isArray(parsed.body)) {
      return c.json({ error: 'Request body must be a JSON object' }, 400);
    }
    const { description, type, content } = parsed.body;
    // The store reaches for `.trim()` on these two, so a non-string would
    // surface as a TypeError -> 500. Reject it as the client error it is. An
    // invalid `type` needs no guard here: the store's own check raises
    // MemoryOpError('invalid'), which the mapper already turns into a 400.
    if (typeof description !== 'string' || typeof content !== 'string') {
      return c.json({ error: 'description and content must be strings' }, 400);
    }
    try {
      // Fields are passed explicitly rather than spread: the memory name comes
      // from the path, and a `name` in the body must not be able to redirect
      // the write to a different memory. The store validates the rest and the
      // per-agent cap; failures arrive as MemoryOpError. Writes are always
      // `source: 'user'` — the coordinator stamps that.
      return c.json(
        await agents.saveMemory(id, { name: c.req.param('name'), description, type, content }),
      );
    } catch (err) {
      const m = mapMemoryError(err);
      return c.json(m.body, m.status);
    }
  });

  mountAgentRoutes(app, AGENT_CREATE_KEYS, AGENT_UPDATE_KEYS);
  mountAgentRoutes(mobileV1, MOBILE_AGENT_CREATE_KEYS, MOBILE_AGENT_UPDATE_KEYS);

  // --- Skill routes ---
  const mapSkillError = (
    err: unknown,
  ): { status: 404 | 409 | 422 | 500; body: { error: string } } => {
    const code =
      err instanceof Error && 'code' in err ? (err as { code?: string }).code : undefined;
    const message = err instanceof Error ? err.message : 'Internal error';
    const status: 404 | 409 | 422 | 500 =
      code === 'not_found'
        ? 404
        : code === 'duplicate'
          ? 409
          : code === 'plugin' ||
              code === 'dangerous' ||
              code === 'invalid' ||
              code === 'scan_failed'
            ? 422
            : 500;
    return { status, body: { error: message } };
  };

  app.get('/agents/:id/skills', async (c) => {
    const id = c.req.param('id');
    if (!agentRegistry.get(id)) return c.json({ error: 'not found' }, 404);
    return c.json(await agents.listSkills(id));
  });

  app.get('/agents/:id/skills/config', (c) => {
    const entry = agentRegistry.get(c.req.param('id'));
    if (!entry) return c.json({ error: 'not found' }, 404);
    return c.json(entry.config.skills ?? {});
  });

  app.patch('/agents/:id/skills/config', async (c) => {
    const id = c.req.param('id');
    const entry = agentRegistry.get(id);
    if (!entry) return c.json({ error: 'not found' }, 404);
    const parsed = await parseJsonBody<{
      paths?: string[];
      urls?: string[];
    }>(c);
    if (!parsed.ok) return parsed.response;
    const skills = { ...entry.config.skills, ...parsed.body };
    agentRegistry.update(id, { skills });
    await agentRegistry.save();
    return c.json(skills);
  });

  app.get('/agents/:id/skills/:name', async (c) => {
    const id = c.req.param('id');
    if (!agentRegistry.get(id)) return c.json({ error: 'not found' }, 404);
    const skill = await agents.getSkill(id, c.req.param('name'));
    if (!skill) return c.json({ error: 'not found' }, 404);
    return c.json(skill);
  });

  app.post('/agents/:id/skills', async (c) => {
    const id = c.req.param('id');
    if (!agentRegistry.get(id)) return c.json({ error: 'not found' }, 404);
    const parsed = await parseJsonBody<{ name: string; description: string; content: string }>(c);
    if (!parsed.ok) return parsed.response;
    try {
      return c.json(await agents.createSkill(id, parsed.body), 201);
    } catch (err) {
      const m = mapSkillError(err);
      return c.json(m.body, m.status);
    }
  });

  app.put('/agents/:id/skills/:name', async (c) => {
    const id = c.req.param('id');
    if (!agentRegistry.get(id)) return c.json({ error: 'not found' }, 404);
    const parsed = await parseJsonBody<{ content: string }>(c);
    if (!parsed.ok) return parsed.response;
    try {
      return c.json(await agents.updateSkillContent(id, c.req.param('name'), parsed.body.content));
    } catch (err) {
      const m = mapSkillError(err);
      return c.json(m.body, m.status);
    }
  });

  app.delete('/agents/:id/skills/:name', async (c) => {
    const id = c.req.param('id');
    if (!agentRegistry.get(id)) return c.json({ error: 'not found' }, 404);
    try {
      return c.json(await agents.removeSkill(id, c.req.param('name')));
    } catch (err) {
      const m = mapSkillError(err);
      return c.json(m.body, m.status);
    }
  });

  app.post('/agents/:id/skills/install', async (c) => {
    const id = c.req.param('id');
    if (!agentRegistry.get(id)) return c.json({ error: 'not found' }, 404);
    const parsed = await parseJsonBody<{ source: string; name?: string }>(c);
    if (!parsed.ok) return parsed.response;
    try {
      return c.json(await agents.installSkill(id, parsed.body.source, parsed.body.name));
    } catch (err) {
      const m = mapSkillError(err);
      return c.json(m.body, m.status);
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
  const modelsOptions = {
    store: options.modelsStore,
    credentialStore,
    // Read provider catalogs LIVE through the wiring getter so a hot-reload
    // that adds/removes a plugin provider is reflected on the next GET
    // /models — not a boot snapshot. Empty when plugins aren't wired (tests).
    getProviderConfigs: () => options.getPluginWiringState?.().pluginProviderConfigs ?? [],
  };
  const modelsController = createModelsController(modelsOptions);
  app.route('/models', createModelsRoute({ ...modelsOptions, controller: modelsController }));
  mobileV1.route(
    '/models',
    createModelsRoute({ ...modelsOptions, controller: modelsController, strictReadOnly: true }),
  );

  // --- Event-log replay ---
  //
  // Called by MC after a chat WebSocket drops to fetch any events it
  // missed between the last seq it saw and the current tail. MC
  // passes `sinceSeq` as a query param; the gateway returns every
  // entry with `seq > sinceSeq` in seq order. Empty array when
  // there's nothing to replay.
  // Typed with its route path so `c.req.param()` returns `string`, not
  // `string | undefined`: a bare `Context` knows nothing about the path, and
  // both registrations below share these two params.
  const replayConversationEventsHandler = (c: Context<BlankEnv, typeof REPLAY_EVENTS_PATH>) => {
    const agentId = c.req.param('agentId');
    const conversationId = c.req.param('conversationId');
    const url = new URL(c.req.url);
    if ([...url.searchParams.keys()].some((key) => key !== 'sinceSeq')) {
      return c.json(mobileValidationError('Unknown replay query parameter'), 400);
    }
    const values = url.searchParams.getAll('sinceSeq');
    if (values.length > 1 || (values.length === 1 && !/^(0|[1-9][0-9]*)$/.test(values[0]))) {
      return c.json(mobileValidationError('sinceSeq must be a non-negative integer'), 400);
    }
    const sinceSeq = values.length === 0 ? 0 : Number.parseInt(values[0], 10);
    if (!Number.isSafeInteger(sinceSeq)) {
      return c.json(mobileValidationError('sinceSeq must be a non-negative integer'), 400);
    }

    const conversation = options.conversationService.get(conversationId, {
      includeDeleted: true,
    });
    if (conversation && conversation.agentId !== agentId) {
      return c.json({ code: 'not_found', error: 'Conversation not found', retryable: false }, 404);
    }
    if (conversation?.status === 'deleted') return c.json({ entries: [] });
    if (!conversation && !agentRegistry.get(agentId)) {
      return c.json({ code: 'not_found', error: 'Agent not found', retryable: false }, 404);
    }
    const entries = options.conversationService.eventLog.readSince(
      agentId,
      conversationId,
      sinceSeq,
    );
    return c.json({ entries });
  };
  app.get(REPLAY_EVENTS_PATH, replayConversationEventsHandler);
  mobileV1.get(REPLAY_EVENTS_PATH, replayConversationEventsHandler);

  // --- Conversation title generation ---
  //
  // MC calls this after the first user message of a conversation to
  // replace its truncated-first-message placeholder with a short
  // LLM-generated title. One cheap completion on the agent's own model
  // (its provider credentials are guaranteed — the agent couldn't chat
  // otherwise). When the projects DB is wired, the same completion also
  // classifies the conversation into one of the active projects; the
  // response then carries `project: { id, key } | null` so MC can file the
  // conversation's auto-created task. Failures return 502 and MC keeps the
  // placeholder.
  app.post('/agents/:agentId/conversation-title', async (c) => {
    const agentId = c.req.param('agentId');
    const entry = agentRegistry.get(agentId);
    if (!entry) return c.json({ error: 'agent not found' }, 404);
    const parsed = await parseJsonBody<{ text?: unknown }>(c);
    if (!parsed.ok) return parsed.response;
    const text = typeof parsed.body.text === 'string' ? parsed.body.text.trim() : '';
    if (!text) return c.json({ error: 'text is required' }, 400);
    const activeProjects = options.projectsDb?.projects.list({ status: 'active' }) ?? [];
    try {
      const storeKeys = await credentialStore.readProviderApiKeys();
      const { title, projectKey } = await generateConversationTitle({
        modelStr: entry.config.model,
        allowedProviders: entry.config.providers,
        pluginModelCatalog: options.getPluginWiringState?.().pluginModelCatalog,
        providerApiKeys: { ...storeKeys, ...(entry.config.providerApiKeys ?? {}) },
        text,
        projects: activeProjects.map((p) => ({
          key: p.key,
          name: p.name,
          description: p.description?.slice(0, 200) || undefined,
        })),
        completeFn: options.titleCompleteFn,
      });
      const project = projectKey
        ? (activeProjects.find((p) => p.key === projectKey) ?? null)
        : null;
      return c.json({ title, project: project ? { id: project.id, key: project.key } : null });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('conversation title generation failed', errorLogContext(err, { agentId }));
      return c.json({ error: message }, 502);
    }
  });

  // --- Swarm panel routes ---
  // Mounted behind the bearer middleware (registered above via app.use('*')).
  // Conditional on the coordinator dep so tests/embedders that don't run swarms
  // still construct the app — the swarm routes simply return 404 (unmatched).
  if (options.swarmCoordinator) {
    mountSwarmRoutes(app, {
      swarmCoordinator: options.swarmCoordinator,
      agentRegistry,
    });
  }

  // --- MCP routes ---
  if (options.mcpDeps) {
    mountMcpRoutes(app, options.mcpDeps);
  }

  // --- Plugin management routes ---
  //
  // Mounted behind the bearer middleware. The plugin options are OPTIONAL so
  // tests/embedders that don't wire plugins still construct the app; each
  // handler returns 500 'plugins not configured' when they're absent. State is
  // read LIVE via `getPluginWiringState()` so every read reflects the latest
  // reload. Mutations persist to the config store BEFORE calling `reloadPlugins`
  // (which re-reads the persisted entries), then return the now-fresh record.
  {
    const getWiring = options.getPluginWiringState;
    const pluginConfigStore = options.pluginConfigStore;
    const reloadPlugins = options.reloadPlugins;
    const pluginsDir = options.pluginsDir;
    const dataDir = options.dataDir;
    const notConfigured = (c: Context) => c.json({ error: 'plugins not configured' }, 500);

    // GET /plugins → all status records, sorted by name (incl. disabled/error).
    app.get('/plugins', (c) => {
      if (!getWiring) return notConfigured(c);
      const records = Object.values(getWiring().pluginRecords).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      return c.json({ records });
    });

    // POST /plugins/install → fetch + scan + install a plugin from `source` into
    // <dataDir>/plugins/<name>, persist its config (enabled+installed+source;
    // trusted stays false), reload, and return the InstalledPlugin record (201).
    // Errors map via mapPluginError (404 not_found, 409 duplicate, 422
    // dangerous/invalid/corrupt/scan_failed, else 500).
    app.post('/plugins/install', async (c) => {
      if (!pluginConfigStore || !reloadPlugins || !dataDir) return notConfigured(c);
      const parsed = await parseJsonBody<{ source: string; name?: string }>(c);
      if (!parsed.ok) return parsed.response;
      const { source, name } = parsed.body;
      if (typeof source !== 'string' || source.trim() === '') {
        return c.json({ error: 'source must be a non-empty string' }, 400);
      }
      let installed: Awaited<ReturnType<typeof installPluginToDir>>;
      try {
        // Pure functions (no @dash/agent dep): heuristicPluginScan + the installer.
        // M4: thread the gateway logger so unreadable/malformed payload notices
        // surface in the gateway log.
        installed = await installPluginToDir({
          dataDir,
          source,
          name,
          scanner: (dir) => heuristicPluginScan(dir, logger),
        });
        // A builtin name is reserved: the dir just landed under pluginsDir,
        // so roll it back and reject. (installPluginToDir can't catch this —
        // builtins have no dir there to collide with.)
        if (getWiring?.().pluginRecords[installed.name]?.builtin) {
          await rm(join(dataDir, 'plugins', installed.name), { recursive: true, force: true });
          return c.json({ error: `'${installed.name}' is a built-in plugin name` }, 409);
        }
        // Persist the four config fields BEFORE reload so the rebuild sees them.
        await pluginConfigStore.setEnabled(installed.name, true); // visible
        await pluginConfigStore.setSource(installed.name, source); // provenance
        await pluginConfigStore.setInstalled(installed.name, true); // gates P1 DELETE dir removal
        // Do NOT set trusted — it stays false; code components remain noop until
        // the user trusts the plugin via PUT /plugins/:name (P1).
      } catch (err) {
        // Pre-persist failure (fetch/scan/move/config write): nothing committed
        // beyond what the installer cleans up; map to the structured HTTP error.
        const m = mapPluginError(err);
        return c.json(m.body, m.status);
      }

      // I4: the dir is moved + config persisted. If the reload then fails, the
      // install LANDED — mirror PUT/DELETE's structured contract so the client
      // knows the plugin is installed and the wiring reconciles on next reload,
      // instead of a bare 500 that implies the install failed.
      try {
        await reloadPlugins();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'reload failed';
        eventBus?.emit({ type: 'plugin:installed', plugin: installed.name });
        return c.json(
          {
            ok: true,
            installed,
            note: 'installed and persisted; wiring reconciles on next reload',
            error: message,
          },
          200,
        );
      }
      eventBus?.emit({ type: 'plugin:installed', plugin: installed.name });
      return c.json(installed, 201);
    });

    // PUT /plugins/:name → patch enabled/trusted, then reload. 404 if unknown,
    // 400 on a bad body, 409 if the reload fails (config already persisted).
    app.put('/plugins/:name', async (c) => {
      if (!getWiring || !pluginConfigStore || !reloadPlugins) return notConfigured(c);
      const name = c.req.param('name');
      if (!getWiring().pluginRecords[name]) return c.json({ error: 'not found' }, 404);

      const parsed = await parseJsonBody<{ enabled?: unknown; trusted?: unknown }>(c);
      if (!parsed.ok) return parsed.response;
      const { enabled, trusted } = parsed.body;
      if (enabled !== undefined && typeof enabled !== 'boolean') {
        return c.json({ error: 'enabled must be a boolean' }, 400);
      }
      if (trusted !== undefined && typeof trusted !== 'boolean') {
        return c.json({ error: 'trusted must be a boolean' }, 400);
      }

      // Persist config BEFORE reload so the rebuild sees the new entries.
      const fields: string[] = [];
      if (enabled !== undefined) {
        await pluginConfigStore.setEnabled(name, enabled);
        fields.push('enabled');
      }
      if (trusted !== undefined) {
        await pluginConfigStore.setTrusted(name, trusted);
        fields.push('trusted');
      }

      try {
        await reloadPlugins();
      } catch (err) {
        // The config write already happened; the live wiring is genuinely
        // unchanged — a thrown reload rejects BEFORE swapping the live reference
        // (loadPlugins/rebuild run before the swap; post-swap clear/evict
        // failures are best-effort and do NOT reject). Surface this as a 409 so
        // the caller knows persisted config and running wiring have diverged.
        const message = err instanceof Error ? err.message : 'reload failed';
        return c.json(
          { error: message, plugin: name, note: 'config persisted; wiring unchanged' },
          409,
        );
      }

      eventBus?.emit({ type: 'plugin:config-changed', plugin: name, fields });
      // After a successful reload the plugin should be in the rebuilt records.
      // If it vanished (e.g. its dir disappeared between the write and the
      // reload), return a structured 409 rather than a 200 with a null body.
      const updated = getWiring().pluginRecords[name];
      if (!updated) {
        return c.json(
          {
            error: 'plugin not present after reload',
            plugin: name,
            note: 'config persisted; plugin no longer in wiring',
          },
          409,
        );
      }
      return c.json(updated);
    });

    // DELETE /plugins/:name → drop from store; for an installed plugin with a
    // resolvable dir under pluginsDir, also rm -rf it. Then reload.
    app.delete('/plugins/:name', async (c) => {
      if (!getWiring || !pluginConfigStore || !reloadPlugins) return notConfigured(c);
      const name = c.req.param('name');
      // Builtins ship with Dash and have no removable installation — refuse
      // with a pointer to disable, before the store lookup (a builtin usually
      // has no config entry and would otherwise 404 misleadingly).
      if (getWiring().pluginRecords[name]?.builtin) {
        return c.json({ error: 'built-in plugins cannot be removed — disable instead' }, 400);
      }
      const entries = await pluginConfigStore.load();
      const entry = entries[name];
      if (!entry) return c.json({ error: 'not found' }, 404);

      await pluginConfigStore.remove(name);

      // Only delete the directory for host-installed plugins (the `installed`
      // flag). A `path:` (linked dev) or manually-dropped plugin is left on
      // disk. The realpath guard refuses any dir that escapes pluginsDir.
      let deletedPath: string | undefined;
      if (entry.installed && pluginsDir) {
        const dirAbs = join(pluginsDir, name);
        if (realpathContained(pluginsDir, dirAbs)) {
          await rm(dirAbs, { recursive: true, force: true });
          deletedPath = dirAbs;
        } else {
          logger.warn?.('refusing to delete plugin dir outside plugins root', {
            plugin: name,
            dir: dirAbs,
            pluginsDir,
          });
        }
      }

      // Mirror PUT's failure contract: the entry (and, for an installed plugin,
      // its dir) is already removed. If the reload then fails, surface a
      // structured 409 — the removal stuck; the live wiring reconciles on the
      // next successful reload — rather than a raw 500.
      try {
        await reloadPlugins();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'reload failed';
        eventBus?.emit({ type: 'plugin:removed', plugin: name });
        return c.json(
          {
            ok: true,
            removed: true,
            ...(deletedPath ? { path: deletedPath } : {}),
            error: message,
            plugin: name,
            note: 'entry/dir removed; wiring reconciles on next reload',
          },
          409,
        );
      }
      eventBus?.emit({ type: 'plugin:removed', plugin: name });
      return c.json(deletedPath ? { ok: true, path: deletedPath } : { ok: true });
    });

    // POST /plugins/reload → re-run discovery with no config change.
    app.post('/plugins/reload', async (c) => {
      if (!reloadPlugins) return notConfigured(c);
      try {
        await reloadPlugins();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'reload failed';
        return c.json({ error: message }, 500);
      }
      eventBus?.emit({ type: 'plugin:reloaded' });
      return c.json({ ok: true, reloadedAt: new Date().toISOString() });
    });

    // GET /runtime/plugins → lightweight shape for MC pickers + credential form.
    app.get('/runtime/plugins', (c) => {
      if (!getWiring) return notConfigured(c);
      const ws = getWiring();
      const providers = ws.pluginProviderConfigs.map((p) => ({
        id: p.catalog.id,
        label: p.catalog.label,
        credentialPrefix: p.catalog.credentialPrefix,
        pluginName: p.pluginName,
        ui: p.catalog.ui,
      }));
      const plugins = Object.values(ws.pluginRecords)
        .filter((r) => r.status !== 'disabled')
        .map((r) => ({ name: r.name, displayName: r.displayName, version: r.version }));
      return c.json({ providers, plugins });
    });
  }

  // --- Projects routes (HTTP: /projects, /issues, /inbox) ---
  // Mounted behind the bearer middleware registered above. The /projects/ws
  // WebSocket mount lives in index.ts (it needs createNodeWebSocket at the
  // serve() site); mountProjectsRoutes only adds HTTP routes.
  if (options.projectsDb) {
    mountProjectsRoutes(app, { db: options.projectsDb });
  }

  // --- SSE event stream ---

  if (eventBus) {
    const bus = eventBus;
    const eventsHandler = (c: Context) => {
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
    };
    app.get('/events', eventsHandler);
    mobileV1.get('/events', eventsHandler);
  }

  app.route('/mobile/v1', mobileV1);

  return app;
}
