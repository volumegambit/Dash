import type { McpLogger, McpManager, McpServerConfig } from '@dash/mcp';
import type { Hono } from 'hono';
import type { AgentRegistry } from './agent-registry.js';
import type { EventBus } from './event-bus.js';
import type { McpConfigStore } from './mcp-store.js';

export interface McpManagementDeps {
  manager: McpManager;
  configStore: McpConfigStore;
  registry?: AgentRegistry;
  logger?: McpLogger;
  eventBus?: EventBus;
}

/** Extract the server URL from a transport config, or undefined for stdio */
function getServerUrl(config: McpServerConfig): string | undefined {
  const t = config.transport;
  if (t.type === 'sse' || t.type === 'streamable-http') return t.url;
  return undefined;
}

export function mountMcpRoutes(app: Hono, deps: McpManagementDeps): void {
  const { manager, configStore } = deps;

  // --- Servers ---

  app.post('/runtime/mcp/servers', async (c) => {
    let body: McpServerConfig;
    try {
      body = await c.req.json<McpServerConfig>();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    if (!body.name || !body.transport) {
      return c.json({ error: 'Missing required fields: name, transport' }, 400);
    }

    // Allowlist check
    const url = getServerUrl(body);
    if (url) {
      const allowed = await configStore.isAllowed(url);
      if (!allowed) {
        deps.logger?.info(
          `[mcp:audit] mcp:proposal:rejected source=api server=${body.name} reason=allowlist`,
        );
        return c.json({ error: 'Server URL not in allowlist' }, 403);
      }
    }

    // Connect
    try {
      await manager.addServer(body);
      await configStore.addConfig(body);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      if (message.includes('already exists')) {
        return c.json({ error: message }, 409);
      }
      return c.json({ error: message }, 500);
    }

    const tools = manager
      .getTools()
      .filter((t) => t.name.startsWith(`${body.name}__`))
      .map((t) => t.name);

    deps.logger?.info(
      `[mcp:audit] mcp:server:added source=api server=${body.name} url=${getServerUrl(body) ?? 'stdio'}`,
    );
    deps.eventBus?.emit({ type: 'mcp:server-added', server: body.name });
    return c.json({ status: 'connected', serverName: body.name, tools }, 201);
  });

  app.get('/runtime/mcp/servers', async (c) => {
    const configs = await configStore.loadConfigs();
    const servers = configs.map((cfg) => ({
      name: cfg.name,
      transport: cfg.transport,
      status: manager.getServerStatus(cfg.name),
      tools: manager
        .getTools()
        .filter((t) => t.name.startsWith(`${cfg.name}__`))
        .map((t) => t.name),
    }));
    return c.json(servers);
  });

  app.get('/runtime/mcp/servers/:name', async (c) => {
    const name = c.req.param('name');
    const configs = await configStore.loadConfigs();
    const cfg = configs.find((x) => x.name === name);
    if (!cfg) return c.json({ error: 'not found' }, 404);
    return c.json({
      name: cfg.name,
      transport: cfg.transport,
      status: manager.getServerStatus(name),
      tools: manager
        .getTools()
        .filter((t) => t.name.startsWith(`${name}__`))
        .map((t) => t.name),
    });
  });

  app.delete('/runtime/mcp/servers/:name', async (c) => {
    const name = c.req.param('name');
    try {
      await manager.removeServer(name);
      await configStore.removeConfig(name);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      if (message.includes('not found')) {
        return c.json({ error: message }, 404);
      }
      return c.json({ error: message }, 500);
    }
    // Remove from all agent configs
    if (deps.registry) {
      let agentConfigChanged = false;
      for (const agent of deps.registry.list()) {
        const servers = agent.config.mcpServers ?? [];
        if (servers.includes(name)) {
          deps.registry.update(agent.name, {
            mcpServers: servers.filter((s) => s !== name),
          });
          agentConfigChanged = true;
        }
      }
      if (agentConfigChanged) {
        await deps.registry.save();
      }
    }

    deps.logger?.info(`[mcp:audit] mcp:server:removed source=api server=${name}`);
    deps.eventBus?.emit({ type: 'mcp:server-removed', server: name });
    return c.json({ ok: true });
  });

  app.post('/runtime/mcp/servers/:name/reconnect', async (c) => {
    const name = c.req.param('name');
    const configs = await configStore.loadConfigs();
    const cfg = configs.find((x) => x.name === name);
    if (!cfg) return c.json({ error: 'not found' }, 404);

    try {
      try {
        await manager.removeServer(name);
      } catch {
        // May not be connected — that's fine
      }
      await manager.addServer(cfg);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      return c.json({ error: message }, 500);
    }
    deps.logger?.info(`[mcp:audit] mcp:server:reconnected source=api server=${name}`);
    return c.json({ ok: true, status: manager.getServerStatus(name) });
  });

  app.post('/runtime/mcp/servers/:name/reauthorize', async (c) => {
    const name = c.req.param('name');
    try {
      await manager.reauthorize(name);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      if (message.includes('not found')) return c.json({ error: message }, 404);
      return c.json({ error: message }, 500);
    }
    deps.logger?.info(`[mcp:audit] mcp:server:reauthorized source=api server=${name}`);
    return c.json({ ok: true, status: manager.getServerStatus(name) });
  });

  // --- Allowlist ---

  app.get('/runtime/mcp/allowlist', async (c) => {
    const list = await configStore.loadAllowlist();
    return c.json(list);
  });

  app.put('/runtime/mcp/allowlist', async (c) => {
    let patterns: string[];
    try {
      patterns = await c.req.json<string[]>();
    } catch {
      return c.json({ error: 'Invalid JSON — expected string array' }, 400);
    }
    if (!Array.isArray(patterns) || !patterns.every((p) => typeof p === 'string')) {
      return c.json({ error: 'Expected an array of URL patterns' }, 400);
    }
    await configStore.saveAllowlist(patterns);
    deps.logger?.info(`[mcp:audit] mcp:allowlist:updated count=${patterns.length}`);
    return c.json({ ok: true, count: patterns.length });
  });
}
