import { describe, expect, it, vi } from 'vitest';

import type { DynamicGateway } from './gateway.js';
import { createGatewayManagementApp } from './management-api.js';

function makeFakeGateway(): DynamicGateway {
  return {
    registerAgent: vi.fn(),
    deregisterDeployment: vi.fn().mockResolvedValue(undefined),
    registerChannel: vi.fn().mockResolvedValue(undefined),
    agentCount: vi.fn().mockReturnValue(2),
    channelCount: vi.fn().mockReturnValue(1),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

describe('createGatewayManagementApp', () => {
  it('GET /health returns startedAt and counts without auth', async () => {
    const gw = makeFakeGateway();
    const startedAt = '2026-03-08T00:00:00Z';
    const app = createGatewayManagementApp({ gateway: gw, startedAt });

    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('healthy');
    expect(body.startedAt).toBe(startedAt);
    expect(body.agents).toBe(2);
    expect(body.channels).toBe(1);
  });

  it('DELETE /deployments/:id deregisters deployment', async () => {
    const gw = makeFakeGateway();
    const app = createGatewayManagementApp({
      gateway: gw,
      startedAt: '2026-03-08T00:00:00Z',
      token: 'tok',
    });

    const res = await app.request('/deployments/dep1', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer tok' },
    });

    expect(res.status).toBe(200);
    expect(gw.deregisterDeployment).toHaveBeenCalledWith('dep1');
  });

  it('POST /channels registers telegram channel', async () => {
    const gw = makeFakeGateway();
    const app = createGatewayManagementApp({
      gateway: gw,
      startedAt: '2026-03-08T00:00:00Z',
      token: 'tok',
    });

    const res = await app.request('/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' },
      body: JSON.stringify({
        deploymentId: 'dep1',
        channelName: 'tg1',
        config: {
          adapter: 'telegram',
          token: 'bot-tok',
          globalDenyList: [],
          routing: [
            { condition: { type: 'default' }, agentName: 'default', allowList: [], denyList: [] },
          ],
        },
      }),
    });

    expect(res.status).toBe(201);
    expect(gw.registerChannel).toHaveBeenCalled();
  });

  it('POST /channels returns 400 for telegram missing token', async () => {
    const gw = makeFakeGateway();
    const app = createGatewayManagementApp({
      gateway: gw,
      startedAt: '2026-03-08T00:00:00Z',
      token: 'tok',
    });

    const res = await app.request('/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' },
      body: JSON.stringify({
        deploymentId: 'dep1',
        channelName: 'tg1',
        config: {
          adapter: 'telegram',
          globalDenyList: [],
          routing: [],
        },
      }),
    });

    expect(res.status).toBe(400);
    expect(gw.registerChannel).not.toHaveBeenCalled();
  });

});
