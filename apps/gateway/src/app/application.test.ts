import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StructuredLoggerImpl } from '@dash/logging';
import { createAgentChatCoordinator } from '../agent-chat-coordinator.js';
import { AgentRegistry } from '../agent-registry.js';
import { ChannelRegistry } from '../channel-registry.js';
import { createConversationAutoTitleService } from '../conversation-auto-title.js';
import { SqliteConversationService } from '../conversation-service-sqlite.js';
import { GatewayCredentialStore } from '../credential-store.js';
import { createExecutionCoordinator } from '../execution-coordinator.js';
import { createDynamicGateway } from '../gateway.js';
import { ModelsStore } from '../models-store.js';
import { createResumableChatHub } from '../resumable-chat-hub.js';
import { createGatewayApplication } from './application.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function createApplication(lan = true) {
  const dataDir = await mkdtemp(join(tmpdir(), 'dash-application-'));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  const agentRegistry = new AgentRegistry(join(dataDir, 'agents.json'));
  const conversations = new SqliteConversationService({ dataDir });
  const agents = createAgentChatCoordinator({
    registry: agentRegistry,
    poolMaxSize: 4,
    createBackend: async () => {
      throw new Error('This test must not start a model');
    },
  });
  const autoTitle = createConversationAutoTitleService({
    conversations,
    generateTitle: async () => 'Application test',
  });
  const execution = createExecutionCoordinator({ conversations, agents, autoTitle });
  const hub = createResumableChatHub({ conversations, execution });
  cleanups.push(async () => {
    await execution.stop();
    hub.dispose();
    await autoTitle.flush();
    await agents.stop();
    conversations.close();
  });
  return createGatewayApplication({
    management: {
      gateway: createDynamicGateway(),
      agentRegistry,
      agents,
      channelRegistry: new ChannelRegistry(join(dataDir, 'channels.json')),
      credentialStore: new GatewayCredentialStore(dataDir),
      modelsStore: new ModelsStore(dataDir),
      conversationService: conversations,
      identity: { gatewayId: 'test-gateway', publicKey: 'test-public-key' },
      execution,
      token: 'admin-secret',
      mobileToken: 'chat-secret',
      dataDir,
      logger: new StructuredLoggerImpl('error', []),
    },
    hub,
    lan,
  });
}

describe('Gateway application assembly', () => {
  it('keeps administrative routes and credentials out of the LAN surface', async () => {
    const application = await createApplication();
    const lan = application.lan;
    expect(lan).toBeDefined();
    if (!lan) throw new Error('LAN surface missing');
    expect((await lan.app.request('/agents')).status).toBe(404);
    expect((await lan.app.request('/mobile/v1/agents')).status).toBe(401);
    const response = await lan?.app.request('/mobile/v1/agents', {
      headers: { Authorization: 'Bearer chat-secret' },
    });
    expect(response?.status).toBe(200);
    expect(
      (
        await application.management.app.request('/agents', {
          headers: { Authorization: 'Bearer chat-secret' },
        })
      ).status,
    ).toBe(401);
  });

  it('mints tickets through the same management app forwarded by LAN', async () => {
    const application = await createApplication();
    for (const surface of [application.management, application.lan]) {
      const response = await surface?.app.request('/mobile/v1/ws-ticket', {
        method: 'POST',
        headers: { Authorization: 'Bearer chat-secret' },
      });
      expect(response?.status).toBe(200);
      const body = (await response?.json()) as { ticket: string };
      expect(application.wsTickets.redeem(body.ticket)).toBe(true);
      expect(application.wsTickets.redeem(body.ticket)).toBe(false);
    }
  });

  it('supports a loopback-only application without creating a LAN surface', async () => {
    const application = await createApplication(false);
    expect(application.lan).toBeUndefined();
    expect((await application.management.app.request('/health')).status).toBe(200);
    expect((await application.chat.app.request('/agents')).status).toBe(404);
  });
});
