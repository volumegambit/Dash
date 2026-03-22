import type { SkillContent, SkillInfo, SkillsConfig } from '@dash/management';
import type {
  AgentDeployment,
  McConversation,
  McMessage,
  MessagingApp,
  RuntimeStatus,
} from '@dash/mc';

// Serializable AgentEvent (error is string, not Error object, for IPC transport)
export type McAgentEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_use_start'; id: string; name: string; input?: Record<string, unknown> }
  | { type: 'tool_use_delta'; partial_json: string }
  | { type: 'tool_result'; id: string; name: string; content: string; isError?: boolean; details?: unknown }
  | { type: 'response'; content: string; usage: Record<string, number> }
  | { type: 'question'; id: string; question: string; options: string[] }
  | { type: 'skill_created'; name: string; description: string }
  | { type: 'error'; error: string; timestamp: string };

export interface DeployWithConfigMcpServer {
  name: string;
  transport:
    | { type: 'stdio'; command: string; args?: string[] }
    | { type: 'sse'; url: string }
    | { type: 'streamable-http'; url: string };
  env?: Record<string, string>;
}

export interface DeployWithConfigOptions {
  name: string;
  model: string;
  fallbackModels?: string[];
  systemPrompt: string;
  tools: string[];
  workspace?: string;
  credentialKeys?: Record<string, string>;
  mcpServers?: DeployWithConfigMcpServer[];
}

// --- MCP Connectors ---

export interface McpConnectorInfo {
  name: string;
  transport: { type: string; url?: string; command?: string; args?: string[] };
  status: 'connected' | 'disconnected' | 'reconnecting' | 'error';
  tools: string[];
}

export interface McpAddConnectorConfig {
  name: string;
  transport:
    | { type: 'stdio'; command: string; args?: string[] }
    | { type: 'sse'; url: string; headers?: Record<string, string> }
    | { type: 'streamable-http'; url: string; headers?: Record<string, string> };
  env?: Record<string, string>;
  auth?: {
    type: 'oauth';
    grantType?: 'authorization_code' | 'client_credentials';
    clientId?: string;
    clientSecret?: string;
    scopes?: string[];
  };
}

export interface McpAddConnectorResult {
  status: 'connected' | 'awaiting_authorization';
  serverName: string;
  tools?: string[];
  authUrl?: string;
}

export interface SetupStatus {
  needsSetup: boolean;
  needsUnlock: boolean;
  needsApiKey: boolean;
}

export interface TelegramBotInfo {
  username: string;
  firstName: string;
}

export interface AppSettings {
  defaultModel?: string;
  defaultFallbackModels?: string[];
}

export interface ChannelHealthEntry {
  appId: string;
  type: string;
  health: 'connected' | 'connecting' | 'disconnected' | 'needs_reauth';
}

export type GatewayStatus = 'starting' | 'healthy' | 'unhealthy' | 'restarting';

export class RendererDeploymentError extends Error {
  constructor(
    message: string,
    public readonly deploymentId: string,
    public readonly startupLogs: string[],
  ) {
    super(message);
    this.name = 'RendererDeploymentError';
  }
}

export interface CredentialPushFailure {
  deploymentId: string;
  name: string;
  error: string;
}

export interface MissionControlAPI {
  getVersion(): Promise<string>;

  // Shell
  openExternal(url: string): Promise<void>;
  openPath(path: string): Promise<void>;
  dialogOpenDirectory(): Promise<string | null>;

  // Setup
  setupGetStatus(): Promise<SetupStatus>;

  // Chat
  chatListConversations(deploymentId: string): Promise<McConversation[]>;
  chatListAllConversations(): Promise<McConversation[]>;
  chatCreateConversation(deploymentId: string, agentName: string): Promise<McConversation>;
  chatGetMessages(conversationId: string): Promise<McMessage[]>;
  chatRenameConversation(conversationId: string, title: string): Promise<void>;
  chatDeleteConversation(conversationId: string): Promise<void>;
  chatSendMessage(
    conversationId: string,
    text: string,
    images?: { mediaType: string; data: string }[],
  ): Promise<void>;
  chatCancel(conversationId: string): Promise<void>;
  chatAnswerQuestion(conversationId: string, questionId: string, answer: string): Promise<void>;
  chatOnEvent(callback: (conversationId: string, event: McAgentEvent) => void): () => void;
  chatOnDone(callback: (conversationId: string) => void): () => void;
  chatOnError(callback: (conversationId: string, error: string) => void): () => void;

  // Codex OAuth (OpenAI)
  codexStartOAuth(keyName: string): Promise<{ success: boolean; error?: string }>;
  codexRefreshToken(keyName: string): Promise<{ success: boolean; error?: string }>;

  // Claude OAuth (Anthropic) — two-step manual flow
  claudePrepareOAuth(): Promise<{ authorizeUrl: string; state: string; verifier: string }>;
  claudeCompleteOAuth(
    keyName: string,
    code: string,
    state: string,
    verifier: string,
  ): Promise<{ success: boolean; error?: string }>;

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
  deploymentsGetAgentConfig(agentName: string): Promise<{
    name: string;
    config: {
      name: string;
      model: string;
      systemPrompt: string;
      fallbackModels?: string[];
      tools?: string[];
      mcpServers?: string[];
      workspace?: string;
      skills?: { paths?: string[]; urls?: string[] };
    };
    status: string;
  }>;
  deploymentsDeploy(configDir: string): Promise<string>;
  deploymentsDeployWithConfig(options: DeployWithConfigOptions): Promise<string>;
  deploymentsStop(id: string): Promise<void>;
  deploymentsRestart(id: string): Promise<void>;
  deploymentsRemove(id: string, deleteWorkspace?: boolean): Promise<void>;
  deploymentsGetStatus(id: string): Promise<RuntimeStatus>;
  deploymentsUpdateConfig(
    id: string,
    patch: {
      name?: string;
      model?: string;
      fallbackModels?: string[];
      tools?: string[];
      systemPrompt?: string;
      mcpServers?: string[];
    },
  ): Promise<void>;
  deploymentsLogsSubscribe(id: string): Promise<void>;
  deploymentsLogsUnsubscribe(id: string): Promise<void>;
  deploymentsGetChannelHealth(deploymentId: string): Promise<ChannelHealthEntry[]>;

  // Messaging Apps
  messagingAppsList(): Promise<MessagingApp[]>;
  messagingAppsGet(id: string): Promise<MessagingApp | null>;
  messagingAppsCreate(
    app: Omit<MessagingApp, 'id' | 'createdAt' | 'credentialsKey'>,
    token: string,
  ): Promise<MessagingApp>;
  messagingAppsUpdate(id: string, patch: Partial<MessagingApp>): Promise<void>;
  messagingAppsDelete(id: string): Promise<void>;
  messagingAppsVerifyTelegramToken(token: string): Promise<TelegramBotInfo>;

  // WhatsApp
  whatsappStartPairing(appId: string): Promise<void>;
  whatsappOnQr(callback: (appId: string, qrDataUrl: string) => void): () => void;
  whatsappOnLinked(callback: (appId: string) => void): () => void;
  whatsappOnError(callback: (appId: string, message: string) => void): () => void;
  messagingAppsCreateWhatsApp(
    appId: string,
    app: Omit<MessagingApp, 'id' | 'createdAt' | 'credentialsKey'>,
  ): Promise<MessagingApp>;

  // Skills
  skillsList(deploymentId: string, agentName: string): Promise<SkillInfo[]>;
  skillsGet(
    deploymentId: string,
    agentName: string,
    skillName: string,
  ): Promise<SkillContent | null>;
  skillsUpdateContent(
    deploymentId: string,
    agentName: string,
    skillName: string,
    content: string,
  ): Promise<void>;
  skillsCreate(
    deploymentId: string,
    agentName: string,
    name: string,
    description: string,
    content: string,
  ): Promise<SkillContent>;
  skillsGetConfig(deploymentId: string, agentName: string): Promise<SkillsConfig>;
  skillsUpdateConfig(
    deploymentId: string,
    agentName: string,
    config: SkillsConfig,
  ): Promise<{ requiresRestart: boolean }>;

  // Events (push from main → renderer)
  onDeploymentLog(callback: (id: string, line: string) => void): () => void;
  onDeploymentStatusChange(callback: (id: string, status: string) => void): () => void;

  // Settings
  settingsGet(): Promise<AppSettings>;
  settingsSet(patch: Partial<AppSettings>): Promise<void>;

  // Gateway
  gatewayGetStatus(): Promise<GatewayStatus>;
  gatewayOnStatus(callback: (status: GatewayStatus) => void): () => void;

  // Credentials
  onCredentialsPushFailed(callback: (failures: CredentialPushFailure[]) => void): () => void;

  // Models & Tools
  modelsList(): Promise<Array<{ value: string; label: string; provider: string }>>;
  modelsRefresh(): Promise<Array<{ value: string; label: string; provider: string }>>;
  toolsList(): Promise<string[]>;

  // Connectors (MCP)
  mcpListConnectors(): Promise<McpConnectorInfo[]>;
  mcpGetConnector(name: string): Promise<McpConnectorInfo>;
  mcpAddConnector(config: McpAddConnectorConfig): Promise<McpAddConnectorResult>;
  mcpRemoveConnector(name: string): Promise<void>;
  mcpReconnectConnector(name: string): Promise<void>;
  mcpGetAllowlist(): Promise<string[]>;
  mcpSetAllowlist(patterns: string[]): Promise<void>;

  // Gateway events (SSE)
  onGatewayEvent(callback: (eventType: string, data: string) => void): () => void;

  // Updates
  onUpdateAvailable(callback: (info: { version: string }) => void): () => void;
}
