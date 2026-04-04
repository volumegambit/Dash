import { beforeEach, vi } from 'vitest';
import type { MissionControlAPI } from './src/shared/ipc.js';

function createMockApi(): Record<keyof MissionControlAPI, ReturnType<typeof vi.fn>> {
  return {
    // Version
    getVersion: vi.fn().mockResolvedValue('0.0.0-test'),

    // Shell
    openExternal: vi.fn().mockResolvedValue(undefined),
    openPath: vi.fn().mockResolvedValue(undefined),
    dialogOpenDirectory: vi.fn().mockResolvedValue(null),

    // Agents (gateway passthrough)
    agentsList: vi.fn().mockResolvedValue([]),
    agentsGet: vi.fn().mockResolvedValue(null),
    agentsCreate: vi.fn().mockResolvedValue({
      id: 'test-agent-id',
      name: 'test',
      config: { model: 'claude-sonnet-4-6', systemPrompt: '' },
      status: 'registered',
      registeredAt: new Date().toISOString(),
    }),
    agentsUpdate: vi.fn().mockResolvedValue(null),
    agentsRemove: vi.fn().mockResolvedValue(undefined),
    agentsDisable: vi.fn().mockResolvedValue(undefined),
    agentsEnable: vi.fn().mockResolvedValue(undefined),

    // Channels (gateway passthrough)
    channelsList: vi.fn().mockResolvedValue([]),
    channelsGet: vi.fn().mockResolvedValue(null),
    channelsCreate: vi.fn().mockResolvedValue(undefined),
    channelsUpdate: vi.fn().mockResolvedValue(undefined),
    channelsRemove: vi.fn().mockResolvedValue(undefined),
    channelsVerifyTelegramToken: vi.fn().mockResolvedValue({ username: 'bot', firstName: 'Bot' }),

    // Credentials (gateway passthrough)
    credentialsSet: vi.fn().mockResolvedValue(undefined),
    credentialsList: vi
      .fn()
      .mockResolvedValue([
        'anthropic-api-key:default',
        'openai-api-key:default',
        'google-api-key:default',
      ]),
    credentialsRemove: vi.fn().mockResolvedValue(undefined),

    // Codex OAuth
    codexStartOAuth: vi.fn().mockResolvedValue({ success: true }),
    codexRefreshToken: vi.fn().mockResolvedValue({ success: true }),

    // Claude OAuth
    claudePrepareOAuth: vi
      .fn()
      .mockResolvedValue({ authorizeUrl: 'https://example.com', state: 's', verifier: 'v' }),
    claudeCompleteOAuth: vi.fn().mockResolvedValue({ success: true }),

    // Chat
    chatCreateConversation: vi.fn().mockResolvedValue({
      id: 'conv-1',
      agentId: 'agent-1',
      title: 'New Conversation',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
    chatListConversations: vi.fn().mockResolvedValue([]),
    chatGetMessages: vi.fn().mockResolvedValue([]),
    chatSend: vi.fn().mockResolvedValue(undefined),
    chatCancel: vi.fn().mockResolvedValue(undefined),
    chatRenameConversation: vi.fn().mockResolvedValue(undefined),
    chatDeleteConversation: vi.fn().mockResolvedValue(undefined),
    chatAnswerQuestion: vi.fn().mockResolvedValue(undefined),

    // Events (push from main -> renderer)
    onAgentEvent: vi.fn().mockReturnValue(() => {}),
    onChatDone: vi.fn().mockReturnValue(() => {}),
    onChatError: vi.fn().mockReturnValue(() => {}),

    // Skills (gateway passthrough)
    skillsList: vi.fn().mockResolvedValue([]),
    skillsGet: vi.fn().mockResolvedValue(null),
    skillsUpdateContent: vi.fn().mockResolvedValue(undefined),
    skillsCreate: vi.fn().mockResolvedValue(null),
    skillsGetConfig: vi.fn().mockResolvedValue({ paths: [], urls: [] }),
    skillsUpdateConfig: vi.fn().mockResolvedValue({ requiresRestart: false }),

    // Settings
    settingsGet: vi.fn().mockResolvedValue({}),
    settingsSet: vi.fn().mockResolvedValue(undefined),

    // Logs
    logsRead: vi.fn().mockResolvedValue(''),
    logsPaths: vi.fn().mockResolvedValue({ mc: '/tmp/mc.log', gateway: '/tmp/gateway.log', dataDir: '/tmp' }),

    // Models & Tools
    modelsList: vi.fn().mockResolvedValue([]),
    modelsRefresh: vi.fn().mockResolvedValue([]),
    toolsList: vi.fn().mockResolvedValue([]),

    // Connectors (MCP)
    mcpListConnectors: vi.fn().mockResolvedValue([]),
    mcpGetConnector: vi.fn().mockResolvedValue(null),
    mcpAddConnector: vi.fn().mockResolvedValue({ status: 'connected', serverName: 'test' }),
    mcpRemoveConnector: vi.fn().mockResolvedValue(undefined),
    mcpReconnectConnector: vi.fn().mockResolvedValue(undefined),
    mcpGetAllowlist: vi.fn().mockResolvedValue([]),
    mcpSetAllowlist: vi.fn().mockResolvedValue(undefined),
    mcpReauthorize: vi.fn().mockResolvedValue(undefined),

    // MCP status events
    onMcpStatusChanged: vi.fn().mockReturnValue(() => {}),

    // Gateway
    gatewayGetStatus: vi.fn().mockResolvedValue('healthy'),
    gatewayOnStatus: vi.fn().mockReturnValue(() => {}),

    // Gateway events (SSE)
    onGatewayEvent: vi.fn().mockReturnValue(() => {}),

    // Setup (simplified)
    setupStatus: vi.fn().mockResolvedValue({ needsSetup: false, gatewayReady: true }),
    setupEnsureGateway: vi.fn().mockResolvedValue(undefined),

    // WhatsApp
    whatsappStartPairing: vi.fn().mockResolvedValue(undefined),
    whatsappOnQr: vi.fn().mockReturnValue(() => {}),
    whatsappOnLinked: vi.fn().mockReturnValue(() => {}),
    whatsappOnError: vi.fn().mockReturnValue(() => {}),

    // Updates
    onUpdateAvailable: vi.fn().mockReturnValue(() => {}),
  };
}

export let mockApi = createMockApi();

if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'api', {
    value: mockApi,
    writable: true,
    configurable: true,
  });
}

beforeEach(() => {
  mockApi = createMockApi();
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'api', {
      value: mockApi,
      writable: true,
      configurable: true,
    });
  }
});
