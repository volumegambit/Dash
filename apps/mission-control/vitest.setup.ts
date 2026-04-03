import { beforeEach, vi } from 'vitest';
import type { MissionControlAPI } from './src/shared/ipc.js';

function createMockApi(): Record<keyof MissionControlAPI, ReturnType<typeof vi.fn>> {
  return {
    // Version
    getVersion: vi.fn().mockResolvedValue('0.0.0-test'),

    // Shell
    openExternal: vi.fn().mockResolvedValue(undefined),
    openPath: vi.fn().mockResolvedValue(undefined),

    // Setup
    setupGetStatus: vi
      .fn()
      .mockResolvedValue({ needsSetup: false, needsUnlock: false, needsApiKey: false }),

    // Chat
    chatListConversations: vi.fn().mockResolvedValue([]),
    chatListAllConversations: vi.fn().mockResolvedValue([]),
    chatCreateConversation: vi.fn().mockResolvedValue({
      id: 'conv-1',
      deploymentId: 'dep-1',
      agentName: 'agent',
      title: 'New Conversation',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
    chatGetMessages: vi.fn().mockResolvedValue([]),
    chatRenameConversation: vi.fn().mockResolvedValue(undefined),
    chatDeleteConversation: vi.fn().mockResolvedValue(undefined),
    chatSendMessage: vi.fn().mockResolvedValue(undefined),
    chatCancel: vi.fn().mockResolvedValue(undefined),
    chatAnswerQuestion: vi.fn().mockResolvedValue(undefined),
    chatOnEvent: vi.fn().mockReturnValue(() => {}),
    chatOnDone: vi.fn().mockReturnValue(() => {}),
    chatOnError: vi.fn().mockReturnValue(() => {}),

    // Codex OAuth
    codexStartOAuth: vi.fn().mockResolvedValue({ success: true }),
    codexRefreshToken: vi.fn().mockResolvedValue({ success: true }),

    // Claude OAuth
    claudePrepareOAuth: vi
      .fn()
      .mockResolvedValue({ authorizeUrl: 'https://example.com', state: 's', verifier: 'v' }),
    claudeCompleteOAuth: vi.fn().mockResolvedValue({ success: true }),

    // Secrets
    secretsNeedsSetup: vi.fn().mockResolvedValue(false),
    secretsNeedsMigration: vi.fn().mockResolvedValue(false),
    secretsIsUnlocked: vi.fn().mockResolvedValue(true),
    secretsSetup: vi.fn().mockResolvedValue(undefined),
    secretsUnlock: vi.fn().mockResolvedValue(undefined),
    secretsLock: vi.fn().mockResolvedValue(undefined),
    secretsList: vi
      .fn()
      .mockResolvedValue([
        'anthropic-api-key:default',
        'openai-api-key:default',
        'google-api-key:default',
      ]),
    secretsGet: vi.fn().mockResolvedValue(null),
    secretsSet: vi.fn().mockResolvedValue(undefined),
    secretsDelete: vi.fn().mockResolvedValue(undefined),

    // Deployments
    deploymentsList: vi.fn().mockResolvedValue([]),
    deploymentsGet: vi.fn().mockResolvedValue(null),
    deploymentsDeploy: vi.fn().mockResolvedValue('test-deployment-id'),
    deploymentsDeployWithConfig: vi.fn().mockResolvedValue('test-deployment-id'),
    deploymentsStop: vi.fn().mockResolvedValue(undefined),
    deploymentsRestart: vi.fn().mockResolvedValue(undefined),
    deploymentsRemove: vi.fn().mockResolvedValue(undefined),
    deploymentsGetStatus: vi.fn().mockResolvedValue({ state: 'stopped' }),
    deploymentsLogsSubscribe: vi.fn().mockResolvedValue(undefined),
    deploymentsLogsUnsubscribe: vi.fn().mockResolvedValue(undefined),
    deploymentsUpdateConfig: vi.fn().mockResolvedValue(undefined),

    // Messaging Apps
    messagingAppsList: vi.fn().mockResolvedValue([]),
    messagingAppsGet: vi.fn().mockResolvedValue(null),
    messagingAppsCreate: vi.fn().mockResolvedValue(null),
    messagingAppsUpdate: vi.fn().mockResolvedValue(undefined),
    messagingAppsDelete: vi.fn().mockResolvedValue(undefined),
    messagingAppsVerifyTelegramToken: vi
      .fn()
      .mockResolvedValue({ username: 'bot', firstName: 'Bot' }),
    messagingAppsGetLog: vi.fn().mockResolvedValue([]),
    whatsappStartPairing: vi.fn().mockResolvedValue(undefined),
    whatsappOnQr: vi.fn().mockReturnValue(() => {}),
    whatsappOnLinked: vi.fn().mockReturnValue(() => {}),
    whatsappOnError: vi.fn().mockReturnValue(() => {}),
    messagingAppsCreateWhatsApp: vi.fn().mockResolvedValue(null),
    dialogOpenDirectory: vi.fn().mockResolvedValue(null),

    // Settings
    settingsGet: vi.fn().mockResolvedValue({}),
    settingsSet: vi.fn().mockResolvedValue(undefined),

    // Events
    onDeploymentLog: vi.fn().mockReturnValue(() => {}),
    onDeploymentStatusChange: vi.fn().mockReturnValue(() => {}),

    // Gateway
    gatewayGetStatus: vi.fn().mockResolvedValue('healthy'),
    gatewayOnStatus: vi.fn().mockReturnValue(() => {}),

    // Credentials
    onCredentialsPushFailed: vi.fn().mockReturnValue(() => {}),
    onCredentialStatusChanged: vi.fn().mockReturnValue(() => {}),
    credentialsGetAffectedAgents: vi.fn().mockResolvedValue([]),
    credentialsReassignKey: vi.fn().mockResolvedValue(undefined),
    deploymentsUpdateCredentialStatus: vi.fn().mockResolvedValue(undefined),

    // Models & Tools
    modelsList: vi.fn().mockResolvedValue([]),
    modelsRefresh: vi.fn().mockResolvedValue([]),
    toolsList: vi.fn().mockResolvedValue([]),

    // Updates
    onUpdateAvailable: vi.fn().mockReturnValue(() => {}),

    // MCP Connectors
    mcpListConnectors: vi.fn().mockResolvedValue([]),
    mcpGetConnector: vi.fn().mockResolvedValue(null),
    mcpAddConnector: vi.fn().mockResolvedValue({ status: 'connected', serverName: 'test' }),
    mcpRemoveConnector: vi.fn().mockResolvedValue(undefined),
    mcpReconnectConnector: vi.fn().mockResolvedValue(undefined),
    mcpGetAllowlist: vi.fn().mockResolvedValue([]),
    mcpSetAllowlist: vi.fn().mockResolvedValue(undefined),
    mcpReauthorize: vi.fn().mockResolvedValue(undefined),
    onMcpStatusChanged: vi.fn().mockReturnValue(() => {}),

    // Gateway events
    onGatewayEvent: vi.fn().mockReturnValue(() => {}),

    // Channel health & Skills
    deploymentsGetChannelHealth: vi.fn().mockResolvedValue([]),
    skillsList: vi.fn().mockResolvedValue([]),
    skillsGet: vi.fn().mockResolvedValue(null),
    skillsUpdateContent: vi.fn().mockResolvedValue(undefined),
    skillsCreate: vi.fn().mockResolvedValue(null),
    skillsGetConfig: vi.fn().mockResolvedValue({ paths: [], urls: [] }),
    skillsUpdateConfig: vi.fn().mockResolvedValue({ requiresRestart: false }),
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
