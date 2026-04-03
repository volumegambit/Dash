import type {
  CachedModel,
  CreateAgentRequest,
  GatewayAgent,
  GatewayChannel,
  McConversation,
  McMessage,
} from '@dash/mc';
import type { SkillContent, SkillInfo, SkillsConfig } from '@dash/management';

// Serializable AgentEvent (error is string, not Error object, for IPC transport)
export type McAgentEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_use_start'; id: string; name: string; input?: Record<string, unknown> }
  | { type: 'tool_use_delta'; partial_json: string }
  | {
      type: 'tool_result';
      id: string;
      name: string;
      content: string;
      isError?: boolean;
      details?: unknown;
    }
  | { type: 'response'; content: string; usage: Record<string, number> }
  | { type: 'question'; id: string; question: string; options: string[] }
  | { type: 'skill_created'; name: string; description: string }
  | { type: 'error'; error: string; timestamp: string };

export interface TelegramBotInfo {
  username: string;
  firstName: string;
}

export interface AppSettings {
  defaultModel?: string;
  defaultFallbackModels?: string[];
}

export type GatewayStatus = 'starting' | 'healthy' | 'unhealthy';

// --- MCP Connectors ---

export interface McpConnectorInfo {
  name: string;
  transport: { type: string; url?: string; command?: string; args?: string[] };
  status: 'connected' | 'disconnected' | 'reconnecting' | 'error' | 'needs_reauth';
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

export interface McpStatusChange {
  serverName: string;
  status: 'connected' | 'disconnected' | 'reconnecting' | 'error' | 'needs_reauth';
}

export interface MissionControlAPI {
  getVersion(): Promise<string>;

  // Shell
  openExternal(url: string): Promise<void>;
  openPath(path: string): Promise<void>;
  dialogOpenDirectory(): Promise<string | null>;

  // Agents (gateway passthrough)
  agentsList(): Promise<GatewayAgent[]>;
  agentsGet(id: string): Promise<GatewayAgent>;
  agentsCreate(config: CreateAgentRequest): Promise<GatewayAgent>;
  agentsUpdate(id: string, patch: Partial<CreateAgentRequest>): Promise<GatewayAgent>;
  agentsRemove(id: string): Promise<void>;
  agentsDisable(id: string): Promise<void>;
  agentsEnable(id: string): Promise<void>;

  // Channels (gateway passthrough)
  channelsList(): Promise<GatewayChannel[]>;
  channelsGet(name: string): Promise<GatewayChannel>;
  channelsCreate(config: {
    name: string;
    adapter: string;
    token?: string;
    globalDenyList?: string[];
    routing: GatewayChannel['routing'];
  }): Promise<void>;
  channelsUpdate(
    name: string,
    patch: Partial<Pick<GatewayChannel, 'globalDenyList' | 'routing'>>,
  ): Promise<void>;
  channelsRemove(name: string): Promise<void>;
  channelsVerifyTelegramToken(token: string): Promise<TelegramBotInfo>;

  // Credentials (gateway passthrough)
  credentialsSet(key: string, value: string): Promise<void>;
  credentialsList(): Promise<string[]>;
  credentialsRemove(key: string): Promise<void>;

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

  // Chat
  chatCreateConversation(agentId: string): Promise<McConversation>;
  chatListConversations(): Promise<McConversation[]>;
  chatGetMessages(conversationId: string): Promise<McMessage[]>;
  chatSend(
    conversationId: string,
    text: string,
    images?: { mediaType: string; data: string }[],
  ): Promise<void>;
  chatCancel(conversationId: string): void;
  chatRenameConversation(conversationId: string, title: string): Promise<void>;
  chatDeleteConversation(conversationId: string): Promise<void>;
  chatAnswerQuestion(conversationId: string, questionId: string, answer: string): void;

  // Events (push from main -> renderer)
  onAgentEvent(callback: (conversationId: string, event: McAgentEvent) => void): () => void;
  onChatDone(callback: (conversationId: string) => void): () => void;
  onChatError(callback: (conversationId: string, error: string) => void): () => void;

  // Skills (gateway passthrough)
  skillsList(agentId: string): Promise<SkillInfo[]>;
  skillsGet(agentId: string, skillName: string): Promise<SkillContent | null>;
  skillsUpdateContent(agentId: string, skillName: string, content: string): Promise<void>;
  skillsCreate(
    agentId: string,
    name: string,
    description: string,
    content: string,
  ): Promise<SkillContent>;
  skillsGetConfig(agentId: string): Promise<SkillsConfig>;
  skillsUpdateConfig(agentId: string, config: SkillsConfig): Promise<{ requiresRestart: boolean }>;

  // Settings
  settingsGet(): Promise<AppSettings>;
  settingsSet(patch: Partial<AppSettings>): Promise<void>;

  // Models & Tools
  modelsList(): Promise<CachedModel[]>;
  modelsRefresh(): Promise<CachedModel[]>;
  toolsList(): Promise<string[]>;

  // Connectors (MCP)
  mcpListConnectors(): Promise<McpConnectorInfo[]>;
  mcpGetConnector(name: string): Promise<McpConnectorInfo>;
  mcpAddConnector(config: McpAddConnectorConfig): Promise<McpAddConnectorResult>;
  mcpRemoveConnector(name: string): Promise<void>;
  mcpReconnectConnector(name: string): Promise<void>;
  mcpGetAllowlist(): Promise<string[]>;
  mcpSetAllowlist(patterns: string[]): Promise<void>;
  mcpReauthorize(name: string): Promise<void>;

  // MCP status events (push from main -> renderer)
  onMcpStatusChanged(callback: (change: McpStatusChange) => void): () => void;

  // Gateway
  gatewayGetStatus(): Promise<GatewayStatus>;
  gatewayOnStatus(callback: (status: GatewayStatus) => void): () => void;

  // Gateway events (SSE)
  onGatewayEvent(callback: (eventType: string, data: string) => void): () => void;

  // Setup (simplified — no password)
  setupStatus(): Promise<{ needsSetup: boolean; gatewayReady: boolean }>;
  setupEnsureGateway(): Promise<void>;

  // WhatsApp
  whatsappStartPairing(appId: string): Promise<void>;
  whatsappOnQr(callback: (appId: string, qrDataUrl: string) => void): () => void;
  whatsappOnLinked(callback: (appId: string) => void): () => void;
  whatsappOnError(callback: (appId: string, message: string) => void): () => void;

  // Updates
  onUpdateAvailable(callback: (info: { version: string }) => void): () => void;
}
