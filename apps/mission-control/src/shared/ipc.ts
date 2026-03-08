import type { AgentDeployment, McConversation, McMessage, MessagingApp, RuntimeStatus } from '@dash/mc';

// Serializable AgentEvent (error is string, not Error object, for IPC transport)
export type McAgentEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_delta'; partial_json: string }
  | { type: 'tool_result'; id: string; name: string; content: string; isError?: boolean }
  | { type: 'response'; content: string; usage: Record<string, number> }
  | { type: 'error'; error: string };

export interface DeployWithConfigOptions {
  name: string;
  model: string;
  systemPrompt: string;
  tools: string[];
  enableTelegram: boolean;
  workspace?: string;
}

export interface SetupStatus {
  needsSetup: boolean;
  needsApiKey: boolean;
}

export interface TelegramBotInfo {
  username: string;
  firstName: string;
}

export interface MissionControlAPI {
  getVersion(): Promise<string>;

  // Shell
  openExternal(url: string): Promise<void>;
  dialogOpenDirectory(): Promise<string | null>;

  // Setup
  setupGetStatus(): Promise<SetupStatus>;

  // Chat
  chatListConversations(deploymentId: string): Promise<McConversation[]>;
  chatCreateConversation(deploymentId: string, agentName: string): Promise<McConversation>;
  chatGetMessages(conversationId: string): Promise<McMessage[]>;
  chatDeleteConversation(conversationId: string): Promise<void>;
  chatSendMessage(conversationId: string, text: string): Promise<void>;
  chatCancel(conversationId: string): Promise<void>;
  chatOnEvent(callback: (conversationId: string, event: McAgentEvent) => void): () => void;
  chatOnDone(callback: (conversationId: string) => void): () => void;
  chatOnError(callback: (conversationId: string, error: string) => void): () => void;

  // Secrets
  secretsNeedsSetup(): Promise<boolean>;
  secretsNeedsMigration(): Promise<boolean>;
  secretsIsUnlocked(): Promise<boolean>;
  secretsSetup(password: string): Promise<void>;
  secretsUnlock(password: string): Promise<void>;
  secretsLock(): Promise<void>;
  secretsList(): Promise<string[]>;
  secretsGet(key: string): Promise<string | null>;
  secretsSet(key: string, value: string): Promise<void>;
  secretsDelete(key: string): Promise<void>;

  // Deployments
  deploymentsList(): Promise<AgentDeployment[]>;
  deploymentsGet(id: string): Promise<AgentDeployment | null>;
  deploymentsDeploy(configDir: string): Promise<string>;
  deploymentsDeployWithConfig(options: DeployWithConfigOptions): Promise<string>;
  deploymentsStop(id: string): Promise<void>;
  deploymentsRemove(id: string, deleteWorkspace?: boolean): Promise<void>;
  deploymentsGetStatus(id: string): Promise<RuntimeStatus>;
  deploymentsLogsSubscribe(id: string): Promise<void>;
  deploymentsLogsUnsubscribe(id: string): Promise<void>;

  // Messaging Apps
  messagingAppsList(): Promise<MessagingApp[]>;
  messagingAppsGet(id: string): Promise<MessagingApp | null>;
  messagingAppsCreate(app: Omit<MessagingApp, 'id' | 'createdAt' | 'credentialsKey'>, token: string): Promise<MessagingApp>;
  messagingAppsUpdate(id: string, patch: Partial<MessagingApp>): Promise<void>;
  messagingAppsDelete(id: string): Promise<void>;
  messagingAppsVerifyTelegramToken(token: string): Promise<TelegramBotInfo>;

  // Events (push from main → renderer)
  onDeploymentLog(callback: (id: string, line: string) => void): () => void;
  onDeploymentStatusChange(callback: (id: string, status: string) => void): () => void;
}
