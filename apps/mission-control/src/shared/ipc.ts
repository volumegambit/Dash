import type { AgentDeployment, RuntimeStatus } from '@dash/mc';

export interface DeployWithConfigOptions {
  name: string;
  model: string;
  systemPrompt: string;
  tools: string[];
  enableTelegram: boolean;
}

export interface SetupStatus {
  needsSetup: boolean;
  needsApiKey: boolean;
}

export interface MissionControlAPI {
  getVersion(): Promise<string>;

  // Setup
  setupGetStatus(): Promise<SetupStatus>;

  // Chat
  chatConnect(gatewayUrl: string): Promise<void>;
  chatDisconnect(): Promise<void>;
  chatSend(conversationId: string, text: string): Promise<void>;
  chatOnResponse(callback: (conversationId: string, text: string) => void): () => void;
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
  deploymentsRemove(id: string): Promise<void>;
  deploymentsGetStatus(id: string): Promise<RuntimeStatus>;
  deploymentsLogsSubscribe(id: string): Promise<void>;
  deploymentsLogsUnsubscribe(id: string): Promise<void>;

  // Events (push from main → renderer)
  onDeploymentLog(callback: (id: string, line: string) => void): () => void;
  onDeploymentStatusChange(callback: (id: string, status: string) => void): () => void;
}
