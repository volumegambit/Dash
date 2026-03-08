import { describe, expect, it } from 'vitest';
import type { RegisterAgentRequest, RegisterChannelRequest } from './management-api.js';

describe('management-api types', () => {
  it('RegisterAgentRequest has required fields', () => {
    const req: RegisterAgentRequest = {
      deploymentId: 'abc123',
      agentName: 'default',
      chatUrl: 'ws://localhost:9101/ws',
      chatToken: 'tok',
    };
    expect(req.deploymentId).toBe('abc123');
    expect(req.agentName).toBe('default');
  });

  it('RegisterChannelRequest has required fields', () => {
    const req: RegisterChannelRequest = {
      deploymentId: 'abc123',
      channelName: 'messaging-app-tg1',
      config: {
        adapter: 'telegram',
        token: 'bot-token',
        globalDenyList: [],
        routing: [
          {
            condition: { type: 'default' },
            agentName: 'default',
            allowList: [],
            denyList: [],
          },
        ],
      },
    };
    expect(req.channelName).toBe('messaging-app-tg1');
  });
});
