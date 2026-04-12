import type { AgentClient } from '@dash/agent';
import type { ChannelAdapter } from '@dash/channels';
import { TelegramAdapter, WhatsAppAdapter } from '@dash/channels';
import { Hono } from 'hono';

import type { AgentRegistry, GatewayAgentConfig, RegisteredAgent } from './agent-registry.js';
import type { AgentRuntime } from './agent-runtime.js';
import type { ChannelRegistry, ChannelRoutingRule } from './channel-registry.js';
import type { GatewayCredentialStore } from './credential-store.js';
import type { EventBus, GatewayEvent } from './event-bus.js';
import type { DynamicGateway } from './gateway.js';
import type { McpManagementDeps } from './mcp-management.js';
import { mountMcpRoutes } from './mcp-management.js';

export interface GatewayManagementOptions {
  gateway: DynamicGateway;
  runtime: AgentRuntime;
  agentRegistry: AgentRegistry;
  channelRegistry: ChannelRegistry;
  credentialStore: GatewayCredentialStore;
  token?: string;
  startedAt?: string;
  eventBus?: EventBus;
  mcpDeps?: McpManagementDeps;
}

/** Strip providerApiKeys from agent entries before returning to clients. */
function stripSecrets(entry: RegisteredAgent): RegisteredAgent {
  const { config, ...rest } = entry;
  const { providerApiKeys: _, ...safeConfig } = config;
  return { ...rest, config: safeConfig as GatewayAgentConfig };
}

export function createGatewayManagementApp(options: GatewayManagementOptions): Hono {
  const { gateway, runtime, agentRegistry, channelRegistry, credentialStore, token, eventBus } =
    options;
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
    }
    await next();
  });

  // --- Health ---

  app.get('/health', (c) => {
    return c.json({
      status: 'healthy',
      startedAt,
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

      // Create bridge client that routes through runtime
      const agentId = entry.id;
      const rt = runtime;
      const bridgeClient: AgentClient = {
        chat(channelId, conversationId, text) {
          return rt.chat({ agentId, conversationId, channelId, text });
        },
      };
      gateway.registerAgent(agentId, bridgeClient);

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
    let patch: Partial<Omit<GatewayAgentConfig, 'name'>>;
    try {
      patch = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    try {
      const updated = agentRegistry.update(id, patch);
      await agentRegistry.save();
      eventBus?.emit({
        type: 'agent:config-changed',
        agent: entry.name,
        fields: Object.keys(patch),
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
      agentRegistry.remove(id);
      await agentRegistry.save();
      await channelRegistry.save();
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
    let body: { name: string; adapter: string; routing: unknown[]; globalDenyList?: string[] };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    if (!body.name || !body.adapter || !body.routing) {
      return c.json({ error: 'Missing required fields: name, adapter, routing' }, 400);
    }

    const routing = body.routing as ChannelRoutingRule[];
    const globalDenyList = body.globalDenyList ?? [];

    // Create adapter from credentials
    let adapter: ChannelAdapter;
    if (body.adapter === 'telegram') {
      const credKey = `channel:${body.name}:token`;
      const tok = await credentialStore.get(credKey);
      if (!tok) {
        return c.json({ error: `No credential found for key '${credKey}'` }, 400);
      }
      adapter = new TelegramAdapter(tok, []);
    } else if (body.adapter === 'whatsapp') {
      const credKey = `channel:${body.name}:whatsapp-auth`;
      const authJson = await credentialStore.get(credKey);
      if (!authJson) {
        return c.json({ error: `No credential found for key '${credKey}'` }, 400);
      }
      const auth = JSON.parse(authJson) as Record<string, string>;
      adapter = new WhatsAppAdapter(auth, `data/whatsapp/${body.name}`);
    } else {
      return c.json({ error: `Unknown adapter type: ${body.adapter}` }, 400);
    }

    try {
      await gateway.registerChannel(body.name, adapter, { globalDenyList, routing });

      // Bridge runtime agents for each routing rule
      for (const rule of routing) {
        const agentEntry = agentRegistry.get(rule.agentId);
        if (agentEntry) {
          const agentId = agentEntry.id;
          const rt = runtime;
          const bridgeClient: AgentClient = {
            chat(channelId, conversationId, text) {
              return rt.chat({ agentId, conversationId, channelId, text });
            },
          };
          gateway.registerAgent(rule.agentId, bridgeClient);
        }
      }

      channelRegistry.register({
        name: body.name,
        adapter: body.adapter as 'telegram' | 'whatsapp',
        globalDenyList,
        routing,
      });
      await channelRegistry.save();
      return c.json({ ok: true }, 201);
    } catch (err) {
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
    let patch: Record<string, unknown>;
    try {
      patch = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    try {
      const updated = channelRegistry.update(name, patch);
      await channelRegistry.save();
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
    channelRegistry.remove(name);
    await channelRegistry.save();
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
    let body: { key: string; value: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    if (!body.key || !body.value) {
      return c.json({ error: 'Missing required fields: key, value' }, 400);
    }
    await credentialStore.set(body.key, body.value);
    return c.json({ ok: true }, 201);
  });

  app.get('/credentials', async (c) => {
    const keys = await credentialStore.list();
    return c.json(keys);
  });

  app.delete('/credentials/:key', async (c) => {
    const key = decodeURIComponent(c.req.param('key'));
    await credentialStore.delete(key);
    return c.json({ ok: true });
  });

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
