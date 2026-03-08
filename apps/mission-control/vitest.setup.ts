import { beforeEach, vi } from 'vitest';
import type { MissionControlAPI } from './src/shared/ipc.js';

function createMockApi(): Record<keyof MissionControlAPI, ReturnType<typeof vi.fn>> {
  return {
    // Version
    getVersion: vi.fn().mockResolvedValue('0.0.0-test'),

    // Shell
    openExternal: vi.fn().mockResolvedValue(undefined),

    // Setup
    setupGetStatus: vi.fn().mockResolvedValue({ needsSetup: false, needsApiKey: false }),

    // Chat
    chatListConversations: vi.fn().mockResolvedValue([]),
    chatCreateConversation: vi.fn().mockResolvedValue({
      id: 'conv-1',
      deploymentId: 'dep-1',
      agentName: 'agent',
      title: 'New conversation',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
    chatGetMessages: vi.fn().mockResolvedValue([]),
    chatDeleteConversation: vi.fn().mockResolvedValue(undefined),
    chatSendMessage: vi.fn().mockResolvedValue(undefined),
    chatCancel: vi.fn().mockResolvedValue(undefined),
    chatOnEvent: vi.fn().mockReturnValue(() => {}),
    chatOnDone: vi.fn().mockReturnValue(() => {}),
    chatOnError: vi.fn().mockReturnValue(() => {}),

    // Secrets
    secretsNeedsSetup: vi.fn().mockResolvedValue(false),
    secretsNeedsMigration: vi.fn().mockResolvedValue(false),
    secretsIsUnlocked: vi.fn().mockResolvedValue(true),
    secretsSetup: vi.fn().mockResolvedValue(undefined),
    secretsUnlock: vi.fn().mockResolvedValue(undefined),
    secretsLock: vi.fn().mockResolvedValue(undefined),
    secretsList: vi.fn().mockResolvedValue([]),
    secretsGet: vi.fn().mockResolvedValue(null),
    secretsSet: vi.fn().mockResolvedValue(undefined),
    secretsDelete: vi.fn().mockResolvedValue(undefined),

    // Deployments
    deploymentsList: vi.fn().mockResolvedValue([]),
    deploymentsGet: vi.fn().mockResolvedValue(null),
    deploymentsDeploy: vi.fn().mockResolvedValue('test-deployment-id'),
    deploymentsDeployWithConfig: vi.fn().mockResolvedValue('test-deployment-id'),
    deploymentsStop: vi.fn().mockResolvedValue(undefined),
    deploymentsRemove: vi.fn().mockResolvedValue(undefined),
    deploymentsGetStatus: vi.fn().mockResolvedValue('stopped'),
    deploymentsLogsSubscribe: vi.fn().mockResolvedValue(undefined),
    deploymentsLogsUnsubscribe: vi.fn().mockResolvedValue(undefined),

    // Events
    onDeploymentLog: vi.fn().mockReturnValue(() => {}),
    onDeploymentStatusChange: vi.fn().mockReturnValue(() => {}),
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
