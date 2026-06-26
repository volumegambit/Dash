import type {
  PluginInstallRequest,
  PluginInstallResponse,
  PluginRecord,
  PluginSetStateRequest,
  RuntimePluginsResponse,
  SkillContent,
  SkillInfo,
  SkillsConfig,
} from '@dash/management';
import type {
  CreateAgentRequest,
  GatewayAgent,
  GatewayChannel,
  GatewayModelsDebugResponse,
  GatewayModelsResponse,
  McConversation,
  McMessage,
} from '@dash/mc';
import type {
  CreateIssueInput,
  CreateProjectInput,
  InboxItem,
  Issue,
  IssueComment,
  IssueDetail,
  IssueFilters,
  Project,
  ProjectWithCounts,
  ProjectsEvent,
} from './projects-ipc.js';

// Re-export shared gateway/management types so renderer stores and components
// can import them from this single IPC facade module.
export type { CreateAgentRequest, GatewayAgent, GatewayChannel } from '@dash/mc';
export type { ChannelHealthEntry } from '@dash/management';

// Top-level setup/onboarding status. Distinguishes a genuine first run
// (`needs-setup`) from a configured user whose gateway cannot start
// (`gateway-failed`) — the latter must NOT be shown the onboarding wizard.
export type SetupStatus =
  | { state: 'needs-setup' }
  | { state: 'ready' }
  | { state: 'gateway-failed'; error: string };

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
  | { type: 'context_compacted'; overflow: boolean }
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

/** LAN pairing: phone and gateway on the same network, direct connection. */
export interface LanPairingInfo {
  mode: 'lan';
  host: string;
  mgmtPort: number;
  chatPort: number;
  mgmtToken: string;
  chatToken: string;
}

/** Relay pairing: phone reaches the gateway over the internet via the relay. */
export interface RelayPairingInfo {
  mode: 'relay';
  /** `<gatewayId>.<zone>` — both HTTPS and WSS resolve here through the relay. */
  host: string;
  secure: true;
  mgmtToken: string;
  chatToken: string;
  /** Per-device credential the phone presents to the relay (x-dash-relay-credential). */
  relayCredential: string;
}

export type PairingInfo = LanPairingInfo | RelayPairingInfo;

/**
 * Hosted control-plane sign-in + enrollment status, safe to show the renderer.
 * Replaces the self-hosted relay config (zone / relay token / admin secret):
 * remote access now flows through the hosted control plane — the user signs in,
 * MC enrolls a gateway, and the control plane brokers the relay server-side.
 */
export interface ControlPlaneStatus {
  /** True once a control-plane session token is present (signed in). */
  signedIn: boolean;
  /** True once a gateway has been enrolled (issued-gateway record present). */
  enrolled: boolean;
  /** The enrolled gateway's relay subdomain `<gatewayId>.<host>`, when enrolled. */
  subdomain: string | null;
}

/** A paired device as surfaced to the renderer (label may be absent). */
export interface DeviceInfo {
  id: string;
  label: string | null;
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

  // Pairing (Android app)
  pairingGetInfo(): Promise<PairingInfo>;

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
  skillsUpdateConfig(agentId: string, config: SkillsConfig): Promise<SkillsConfig>;
  skillsInstall(agentId: string, source: string, name?: string): Promise<SkillInfo>;
  skillsRemove(agentId: string, skillName: string): Promise<void>;

  // Settings
  settingsGet(): Promise<AppSettings>;
  settingsSet(patch: Partial<AppSettings>): Promise<void>;

  // Remote access via the hosted control plane. Sign in (WorkOS, system
  // browser), enroll a gateway, and manage paired devices. The control-plane
  // session token + issued gateway record live in the OS keychain and are never
  // read back to the renderer — only the derived status.
  controlPlaneStatus(): Promise<ControlPlaneStatus>;
  /** Run the loopback-OAuth sign-in flow (opens the system browser). */
  controlPlaneSignIn(): Promise<void>;
  /** Forget the control-plane session token. */
  controlPlaneSignOut(): Promise<void>;
  /** True when `label` is an unclaimed, DNS-safe subdomain. Backs the picker. */
  subdomainCheck(label: string): Promise<boolean>;
  /** Claim `subdomain`, bind the gateway pubkey, and restart in relay mode. */
  gatewayEnroll(subdomain: string): Promise<void>;
  /** List the paired devices for the enrolled gateway. */
  devicesList(): Promise<DeviceInfo[]>;
  /** Revoke a single paired device by id. */
  devicesRevoke(deviceId: string): Promise<void>;

  // Models & Tools — gateway is the source of truth for the model list.
  // `modelsList` reads the gateway's persistent store (or its bootstrap
  // fallback when no credentials are configured); `modelsRefresh` forces
  // a fresh fetch from provider /v1/models endpoints; `modelsDebug`
  // returns the extended shape used by the Under the Hood debug page.
  modelsList(): Promise<GatewayModelsResponse>;
  modelsRefresh(): Promise<GatewayModelsResponse>;
  modelsDebug(): Promise<GatewayModelsDebugResponse>;
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

  // Plugins (gateway passthrough). Types are owned by @dash/management to avoid
  // drift with the gateway routes. `install` returns the PluginInstallResponse
  // union (flat InstalledPlugin or reload-pending body); the store narrows it.
  plugins: {
    list(): Promise<PluginRecord[]>;
    setState(name: string, patch: PluginSetStateRequest): Promise<PluginRecord>;
    install(req: PluginInstallRequest): Promise<PluginInstallResponse>;
    remove(name: string): Promise<{ ok: boolean; path?: string }>;
    reload(): Promise<{ ok: boolean; reloadedAt?: string }>;
    runtime(): Promise<RuntimePluginsResponse>;
  };

  // Gateway
  gatewayGetStatus(): Promise<GatewayStatus>;
  gatewayRestart(): Promise<void>;
  gatewayOnStatus(callback: (status: GatewayStatus) => void): () => void;

  // Gateway events (SSE)
  onGatewayEvent(callback: (eventType: string, data: string) => void): () => void;

  // Setup (simplified — no password)
  setupStatus(): Promise<SetupStatus>;
  setupEnsureGateway(): Promise<void>;

  // App lifecycle
  appQuit(): Promise<void>;

  // WhatsApp
  whatsappStartPairing(appId: string): Promise<void>;
  whatsappOnQr(callback: (appId: string, qrDataUrl: string) => void): () => void;
  whatsappOnLinked(callback: (appId: string) => void): () => void;
  whatsappOnError(callback: (appId: string, message: string) => void): () => void;

  // Logs (Under the Hood)
  logsRead(source: 'mc' | 'gateway', tailLines?: number): Promise<string>;
  logsPaths(): Promise<{ mc: string; gateway: string; dataDir: string }>;

  // Updates
  onUpdateAvailable(callback: (info: { version: string }) => void): () => void;

  // Projects (gateway passthrough)
  projectsListProjects(status?: Project['status']): Promise<Project[]>;
  projectsCreateProject(input: CreateProjectInput): Promise<Project>;
  projectsGetProject(id: string): Promise<ProjectWithCounts>;
  projectsPatchProject(id: string, patch: Partial<Project>): Promise<Project>;
  projectsListProjectIssues(id: string): Promise<Issue[]>;
  projectsListIssues(filters?: IssueFilters): Promise<Issue[]>;
  projectsCreateIssue(input: CreateIssueInput): Promise<Issue>;
  projectsGetIssue(id: string): Promise<IssueDetail>;
  projectsPatchIssue(id: string, patch: Partial<Issue>): Promise<Issue>;
  projectsAddComment(issueId: string, body: string): Promise<IssueComment>;
  projectsEditComment(issueId: string, commentId: string, body: string): Promise<IssueComment>;
  projectsDeleteComment(issueId: string, commentId: string): Promise<void>;
  projectsListInbox(): Promise<InboxItem[]>;
  projectsMarkInboxRead(issueId: string): Promise<void>;

  // Projects events (push from main -> renderer)
  onProjectsEvent(callback: (event: ProjectsEvent) => void): () => void;
}
