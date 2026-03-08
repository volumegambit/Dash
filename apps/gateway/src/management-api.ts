import type { ChannelAdapter } from '@dash/channels';
import { TelegramAdapter, WhatsAppAdapter } from '@dash/channels';
import { RemoteAgentClient } from '@dash/chat';
import { Hono } from 'hono';

import type { DynamicGateway } from './gateway.js';

export interface RegisterAgentRequest {
  deploymentId: string;
  agentName: string;
  chatUrl: string;
  chatToken: string;
}

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

export interface AgentRegistration {
  agentName: string;
  chatUrl: string;
  chatToken: string;
}

export interface DeploymentRegistration {
  deploymentId: string;
  agents: AgentRegistration[];
  channels: RegisterChannelRequest[];
}

export interface GatewayHealthResponse {
  status: 'healthy';
  startedAt: string;
  agents: number;
  channels: number;
}

export function createGatewayManagementApp(
  gateway: DynamicGateway,
  startedAt: string,
  token?: string,
): Hono {
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

  app.get('/health', (c) => {
    return c.json({
      status: 'healthy' as const,
      startedAt,
      agents: gateway.agentCount(),
      channels: gateway.channelCount(),
    });
  });

  app.post('/agents', async (c) => {
    let body: RegisterAgentRequest;
    try {
      body = await c.req.json<RegisterAgentRequest>();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    if (!body.deploymentId || !body.agentName || !body.chatUrl || !body.chatToken) {
      return c.json(
        { error: 'Missing required fields: deploymentId, agentName, chatUrl, chatToken' },
        400,
      );
    }
    const client = new RemoteAgentClient(
      body.chatUrl,
      body.chatToken,
      `${body.deploymentId}:${body.agentName}`,
    );
    gateway.registerAgent(body.deploymentId, body.agentName, client);
    return c.json({ ok: true }, 201);
  });

  app.delete('/deployments/:id', async (c) => {
    const { id } = c.req.param();
    await gateway.deregisterDeployment(id);
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

    await gateway.registerChannel(body.deploymentId, body.channelName, adapter, {
      globalDenyList: cfg.globalDenyList ?? [],
      routing: cfg.routing,
    });
    return c.json({ ok: true }, 201);
  });

  return app;
}
