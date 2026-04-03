import type { AgentClient } from '@dash/agent';
import type { ChannelAdapter } from '@dash/channels';
import { TelegramAdapter, WhatsAppAdapter } from '@dash/channels';
import { Hono } from 'hono';

import type { GatewayAgentConfig } from './agent-registry.js';
import type { AgentRuntime } from './agent-runtime.js';
import type { EventBus, GatewayEvent } from './event-bus.js';
import type { DynamicGateway } from './gateway.js';
import { type McpManagementDeps, mountMcpRoutes } from './mcp-management.js';

export interface ChannelRoutingRule {
  condition:
    | { type: 'default' }
    | { type: 'sender'; ids: string[] }
    | { type: 'group'; ids: string[] };
  agentName: string;
  allowList: string[];
  denyList: string[];
}

export interface ChannelRegistrationConfig {
  adapter: 'telegram' | 'whatsapp';
  token?: string;
  authStateDir?: string;
  whatsappAuth?: Record<string, string>;
  globalDenyList?: string[];
  routing: ChannelRoutingRule[];
}

export interface RegisterChannelRequest {
  deploymentId: string;
  channelName: string;
  config: ChannelRegistrationConfig;
}

export interface GatewayHealthResponse {
  status: 'healthy';
  startedAt: string;
  agents: number;
  channels: number;
  mcpServers?: Array<{ name: string; status: string }>;
}

export interface GatewayManagementOptions {
  gateway: DynamicGateway;
  runtime?: AgentRuntime;
  token?: string;
  startedAt?: string;
  mcpDeps?: McpManagementDeps;
  eventBus?: EventBus;
}

export function createGatewayManagementApp(options: GatewayManagementOptions): Hono {
  const { gateway, runtime, token } = options;
  const startedAt = options.startedAt ?? new Date().toISOString();
  const app = new Hono();

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
    } else {
      // No token configured — all routes are public (dev/no-auth mode)
    }
    await next();
  });

  app.get('/health', (c) => {
    const health: Record<string, unknown> = {
      status: 'healthy',
      startedAt,
      agents: gateway.agentCount(),
      channels: gateway.channelCount(),
    };
    if (runtime) {
      health.pool = runtime.stats();
      health.runtimeAgents = runtime.registry.list().length;
    }
    if (options.mcpDeps?.manager) {
      health.mcpServers = options.mcpDeps.manager.getServerStatuses();
    }
    return c.json(health);
  });

  app.delete('/deployments/:id', async (c) => {
    const { id } = c.req.param();
    try {
      await gateway.deregisterDeployment(id);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      return c.json({ error: message }, 500);
    }
    return c.json({ ok: true });
  });

  app.post('/channels', async (c) => {
    let body: RegisterChannelRequest;
    try {
      body = await c.req.json<RegisterChannelRequest>();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    if (!body.deploymentId || !body.channelName || !body.config) {
      return c.json({ error: 'Missing required fields: deploymentId, channelName, config' }, 400);
    }

    const cfg = body.config;
    let adapter: ChannelAdapter;
    if (cfg.adapter === 'telegram') {
      if (!cfg.token) {
        return c.json({ error: 'Telegram adapter requires token' }, 400);
      }
      adapter = new TelegramAdapter(cfg.token, []);
    } else if (cfg.adapter === 'whatsapp') {
      if (!cfg.authStateDir) {
        return c.json({ error: 'WhatsApp adapter requires authStateDir' }, 400);
      }
      adapter = new WhatsAppAdapter(cfg.whatsappAuth ?? {}, cfg.authStateDir);
    } else {
      return c.json(
        { error: `Unknown adapter type: ${(cfg as { adapter: string }).adapter}` },
        400,
      );
    }

    try {
      await gateway.registerChannel(body.deploymentId, body.channelName, adapter, {
        globalDenyList: cfg.globalDenyList ?? [],
        routing: cfg.routing,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      return c.json({ error: message }, 500);
    }

    // Bridge runtime agents into the gateway agents map so channel routing can find them.
    // Channel routing looks up agents as "${deploymentId}:${agentName}" but runtime agents
    // are stored by name only. Register a thin AgentClient wrapper for each routing rule
    // whose agent exists in the runtime registry.
    if (runtime) {
      for (const rule of cfg.routing) {
        if (runtime.registry.get(rule.agentName)) {
          const agentName = rule.agentName;
          const rt = runtime;
          const bridgeClient: AgentClient = {
            chat(channelId, conversationId, text) {
              return rt.chat({ agentName, conversationId, channelId, text });
            },
          };
          gateway.registerAgent(body.deploymentId, agentName, bridgeClient);
        }
      }
    }

    return c.json({ ok: true }, 201);
  });

  // --- In-process agent management (only when runtime is available) ---

  if (runtime) {
    app.post('/runtime/agents', async (c) => {
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
        const entry = runtime.registry.register(body);
        await runtime.registry.save();
        options.eventBus?.emit({
          type: 'agent:config-changed',
          agent: body.name,
          fields: ['*'],
        });
        return c.json(entry, 201);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Internal error';
        return c.json({ error: message }, 409);
      }
    });

    app.get('/runtime/agents', (c) => {
      const agents = runtime.registry.list();
      return c.json(agents);
    });

    app.get('/runtime/agents/:name', (c) => {
      const name = c.req.param('name');
      const entry = runtime.registry.get(name);
      if (!entry) return c.json({ error: 'not found' }, 404);
      return c.json(entry);
    });

    app.put('/runtime/agents/:name', async (c) => {
      const name = c.req.param('name');
      const entry = runtime.registry.get(name);
      if (!entry) return c.json({ error: 'not found' }, 404);
      let patch: Partial<Omit<GatewayAgentConfig, 'name'>>;
      try {
        patch = await c.req.json();
      } catch {
        return c.json({ error: 'Invalid JSON' }, 400);
      }
      try {
        const updated = runtime.registry.update(name, patch);
        await runtime.registry.save();
        options.eventBus?.emit({
          type: 'agent:config-changed',
          agent: name,
          fields: Object.keys(patch),
        });
        return c.json(updated);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Internal error';
        return c.json({ error: message }, 500);
      }
    });

    app.delete('/runtime/agents/:name', async (c) => {
      const name = c.req.param('name');
      const entry = runtime.registry.get(name);
      if (!entry) return c.json({ error: 'not found' }, 404);
      try {
        await runtime.removeAgent(name);
        await runtime.registry.save();
        return c.json({ ok: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Internal error';
        return c.json({ error: message }, 500);
      }
    });

    app.post('/runtime/agents/:name/credentials', async (c) => {
      const name = c.req.param('name');
      const entry = runtime.registry.get(name);
      if (!entry) return c.json({ error: 'not found' }, 404);
      let body: { providerApiKeys: Record<string, string> };
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'Invalid JSON' }, 400);
      }
      if (!body.providerApiKeys) {
        return c.json({ error: 'Missing required field: providerApiKeys' }, 400);
      }
      runtime.registry.update(name, { providerApiKeys: body.providerApiKeys });
      await runtime.registry.save();
      options.eventBus?.emit({
        type: 'agent:config-changed',
        agent: name,
        fields: ['providerApiKeys'],
      });
      await runtime.updateCredentials(name, body.providerApiKeys);
      return c.json({ ok: true });
    });

    app.post('/runtime/agents/:name/disable', async (c) => {
      const name = c.req.param('name');
      try {
        runtime.registry.disable(name);
        await runtime.registry.save();
        return c.json({ ok: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Internal error';
        if (message.includes('not found')) return c.json({ error: message }, 404);
        return c.json({ error: message }, 500);
      }
    });

    app.post('/runtime/agents/:name/enable', async (c) => {
      const name = c.req.param('name');
      try {
        runtime.registry.enable(name);
        await runtime.registry.save();
        return c.json({ ok: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Internal error';
        if (message.includes('not found')) return c.json({ error: message }, 404);
        return c.json({ error: message }, 500);
      }
    });
  }

  if (options.mcpDeps) {
    mountMcpRoutes(app, options.mcpDeps);
  }

  // SSE event stream
  if (options.eventBus) {
    const eventBus = options.eventBus;
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
            // Send keepalive comment every 30s
            const keepalive = setInterval(() => {
              try {
                controller.enqueue(encoder.encode(': keepalive\n\n'));
              } catch {
                clearInterval(keepalive);
              }
            }, 30_000);
            const unsub = eventBus.subscribe(send);
            // Clean up when client disconnects
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
