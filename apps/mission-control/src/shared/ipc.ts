import type {
  PluginInstallRequest,
  PluginInstallResponse,
  PluginRecord,
  PluginSetStateRequest,
  RuntimePluginsResponse,
  SkillContent,
  SkillInfo,
  SkillsConfig,
  SwarmRunSnapshot,
  SwarmRunSummary,
  SwarmWorkerActionResult,
} from '@dash/management';
import type {
  ConversationRef,
  CreateAgentRequest,
  GatewayAgent,
  GatewayChannel,
  GatewayConnectionSettings,
  GatewayModelsDebugResponse,
  GatewayModelsResponse,
  McConversationListResult,
  McConversationView,
  VpsGatewayDeployRequest,
} from '@dash/mc';
import type {
  ConversationMessagePage,
  MobileApiError,
  MobileImage,
  MobileWsServerFrame,
} from '@dash/mobile-contract';
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
export type { GatewayConnectionSettings } from '@dash/mc';

// Top-level setup/onboarding status. Distinguishes a genuine first run
// (`needs-setup`) from a configured user whose gateway cannot start
// (`gateway-failed`) — the latter must NOT be shown the onboarding wizard.
export type SetupStatus =
  | { state: 'needs-setup' }
  | { state: 'ready' }
  | { state: 'gateway-failed'; error: string };

// Serializable AgentEvent (error is string, not Error object, for IPC transport).
// The worker_* variants mirror @dash/agent's AgentEvent exactly — they carry no
// Error objects, so their fields are copied as-is (the error-as-string
// convention only applies to the `error` variant above).
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
  | {
      type: 'worker_spawned';
      workerId: string;
      runId: string;
      role: string;
      brief: string;
      model: string;
    }
  | {
      type: 'worker_status';
      workerId: string;
      runId: string;
      role: string;
      status: 'running' | 'waiting_input';
      detail?: string;
      question?: string;
    }
  | {
      type: 'worker_done';
      workerId: string;
      runId: string;
      role: string;
      status: 'done' | 'failed' | 'cancelled';
      report: string;
      usage?: { inputTokens: number; outputTokens: number };
    }
  | { type: 'error'; error: string; timestamp: string }
  // Transient provider failure the backend is auto-retrying (pi auto-retry).
  // Rendered as a "Retrying…" notice, not a terminal error.
  | { type: 'agent_retry'; attempt: number; reason: string };

export interface TelegramBotInfo {
  username: string;
  firstName: string;
}

export interface AppSettings {
  defaultModel?: string;
  defaultFallbackModels?: string[];
}

export type GatewayStatus = 'starting' | 'healthy' | 'unhealthy';

export type ChatAcceptedFrame = Extract<MobileWsServerFrame, { type: 'accepted' }>;

export interface ConversationInvalidation {
  type: 'changed' | 'deleted';
  conversation: ConversationRef;
}

export type GatewayConnectionIssueKind =
  | 'gateway_offline'
  | 'repair_required'
  | 'rate_limited'
  | 'server'
  | 'update_required';

export interface GatewayConnectionIssue {
  kind: GatewayConnectionIssueKind;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
  closeCode?: number;
}

export interface ChatConnectionIssue extends GatewayConnectionIssue {
  conversation: ConversationRef;
}

export type ChatIpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { message: string; apiError?: MobileApiError } };

function structuredMobileError(error: unknown): MobileApiError | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = 'apiError' in error ? error.apiError : error;
  if (
    !candidate ||
    typeof candidate !== 'object' ||
    !('code' in candidate) ||
    typeof candidate.code !== 'string' ||
    !('error' in candidate) ||
    typeof candidate.error !== 'string'
  ) {
    return undefined;
  }
  return candidate as MobileApiError;
}

export async function captureChatIpcResult<T>(
  operation: () => Promise<T>,
): Promise<ChatIpcResult<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const apiError = structuredMobileError(error);
    if (apiError) return { ok: false, error: { message, apiError } };
    if (error instanceof Error && error.name === 'ConversationRepositoryOfflineError') {
      return {
        ok: false,
        error: {
          message,
          apiError: { code: 'gateway_offline', error: message, retryable: true },
        },
      };
    }
    return { ok: false, error: { message } };
  }
}

export function unwrapChatIpcResult<T>(result: ChatIpcResult<T>): T {
  if (result.ok) return result.value;
  const error = new Error(result.error.message);
  if (result.error.apiError) Object.assign(error, { apiError: result.error.apiError });
  throw error;
}

// Coarse per-session status the companion pet renders. Single source of
// truth: the renderer's companion/types.ts re-exports this.
export type CompanionStatus = 'working' | 'needs' | 'done' | 'error';

// One entry per live session the companion tracks, carrying the identity of
// the agent it belongs to plus a short human-readable preview of what that
// session is doing right now (the live tool, the question, the error, or the
// final text). Crew mode groups these by `agentId` to map fleet members to
// agents; the speech bubbles render `preview`. The single-pet path derives its
// aggregate mood from `entries.map((e) => e.status)`, unchanged.
export interface CompanionAgentStatus {
  agentId: string;
  agentName: string;
  status: CompanionStatus;
  preview: string;
}

export type PetKind =
  | 'astronaut'
  | 'bear'
  | 'beauty-guru'
  | 'bigfoot'
  | 'bollywood-star'
  | 'cat'
  | 'chef'
  | 'dog'
  | 'fitness-influencer'
  | 'fortune-god'
  | 'knight'
  | 'lion'
  | 'maneki-neko'
  | 'merlion'
  | 'ninja'
  | 'pig'
  | 'pirate'
  | 'quokka'
  | 'rabbit'
  | 'red-panda'
  | 'robot'
  | 'royal-guard'
  | 'streamer'
  | 'tech-reviewer'
  | 'travel-vlogger'
  | 'unicorn'
  | 'wizard'
  | 'wok-uncle'
  | 'sous-chef'
  | 'pastry-chef'
  | 'sushi-chef'
  | 'butcher'
  | 'dishwasher'
  | 'boss'
  | 'accountant'
  | 'intern'
  | 'it-support'
  | 'receptionist'
  | 'waiter'
  | 'barista'
  | 'sommelier'
  | 'bartender'
  | 'bubble-tea-maker'
  | 'sergeant'
  | 'scout'
  | 'combat-medic'
  | 'rifleman'
  | 'rocket-soldier'
  | 'police-officer'
  | 'detective'
  | 'k9-handler'
  | 'swat'
  | 'motorcycle-cop'
  | 'firefighter'
  | 'fire-chief'
  | 'ladder-firefighter'
  | 'rookie-firefighter'
  | 'fire-dalmatian'
  | 'baker'
  | 'blacksmith'
  | 'fisherman'
  | 'shepherd'
  | 'delivery-courier'
  | 'farmer'
  | 'dairy-farmer'
  | 'fruit-picker'
  | 'beekeeper'
  | 'scarecrow'
  | 'sled-pusher'
  | 'wall-baller'
  | 'rower'
  | 'kettlebell-athlete'
  | 'weightlifter';

// A themed group of five pets that can be selected as a whole; the widget then
// renders the crew as a fleet, one member per running agent. The renderer's
// companion/pets/crews.ts owns the rosters and re-exports this type.
export type CrewKind =
  | 'kitchen'
  | 'office'
  | 'wait'
  | 'soldier'
  | 'police'
  | 'fire'
  | 'villager'
  | 'farmer'
  | 'gym';

// What the user selected for the companion widget: either a single pet or a
// whole crew (rendered as a fleet). Persisted as a string in localStorage and
// forwarded over IPC. Old persisted `PetKind` values parse as `{ type: 'pet' }`
// unchanged (see parseCompanionSelection).
export type CompanionSelection = PetKind | `crew:${CrewKind}`;

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
  secure: true;
  mgmtPort: number;
  chatPort: number;
  mgmtToken: string;
  chatToken: string;
  /** Lowercase SHA-256 of the exact self-signed leaf certificate. */
  tlsCertificateSha256: string;
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

export interface GatewayConnectionStatus {
  profile: GatewayConnectionSettings;
  hasRemoteSecrets: boolean;
  health: 'unknown' | 'healthy' | 'unhealthy';
  issue?: GatewayConnectionIssue;
}

export type GatewayConnectionTestResult =
  | { ok: true; status: GatewayConnectionStatus }
  | { ok: false; message: string };

export interface GatewayRelayConnectionInput {
  mode: 'relay' | 'hosted';
  name?: string;
  managementBaseUrl: string;
  chatBaseUrl?: string;
  managementToken: string;
  chatToken: string;
  relayCredential?: string;
}

export interface McVpsGatewayDeployRequest
  extends Omit<VpsGatewayDeployRequest, 'managementToken' | 'chatToken'> {
  name?: string;
  managementToken?: string;
  chatToken?: string;
  relayCredential?: string;
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
  chatCreateConversation(agentId: string, requestId: string): Promise<McConversationView>;
  chatListConversations(cursor?: string): Promise<McConversationListResult>;
  chatGetConversation(conversation: ConversationRef): Promise<McConversationView | null>;
  chatGetMessages(conversation: ConversationRef, before?: string): Promise<ConversationMessagePage>;
  chatSend(
    conversation: ConversationRef,
    turnId: string,
    text: string,
    images?: MobileImage[],
  ): Promise<ChatAcceptedFrame | undefined>;
  chatCancel(conversation: ConversationRef, turnId: string): void;
  chatRenameConversation(
    conversation: ConversationRef,
    revision: number,
    title: string,
  ): Promise<McConversationView>;
  chatDeleteConversation(conversation: ConversationRef, revision: number): Promise<void>;
  chatAnswerQuestion(
    conversation: ConversationRef,
    turnId: string,
    questionId: string,
    answer: string,
  ): void;

  // Events (push from main -> renderer)
  onChatFrame(callback: (frame: MobileWsServerFrame) => void): () => void;
  onChatConnectionError(callback: (issue: ChatConnectionIssue) => void): () => void;
  onChatConversationInvalidated(callback: (event: ConversationInvalidation) => void): () => void;
  onAgentEvent(callback: (conversationId: string, event: McAgentEvent) => void): () => void;
  onChatDone(callback: (conversationId: string) => void): () => void;
  onChatError(callback: (conversationId: string, error: string) => void): () => void;
  onChatConversationRenamed(callback: (conversationId: string, title: string) => void): () => void;

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

  // Swarm panel (gateway passthrough). `cancelWorker`/`swarmSend` resolve to
  // `{ok, reason?}`: the underlying client surfaces the gateway's 409
  // (run finalized / worker terminal) as `{ok:false, reason}` rather than a
  // rejection, so the panel can render the reason.
  swarmListRuns(agentId: string): Promise<SwarmRunSummary[]>;
  swarmGetRun(agentId: string, runId: string): Promise<SwarmRunSnapshot>;
  swarmCancelWorker(
    agentId: string,
    runId: string,
    workerId: string,
  ): Promise<SwarmWorkerActionResult>;
  swarmSend(
    agentId: string,
    runId: string,
    workerId: string,
    message: string,
  ): Promise<SwarmWorkerActionResult>;

  // Settings
  settingsGet(): Promise<AppSettings>;
  settingsSet(patch: Partial<AppSettings>): Promise<void>;

  // Remote access via the hosted control plane. Sign in (Clerk, system
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
  gatewayConnectionGet(): Promise<GatewayConnectionStatus>;
  gatewayConnectionUseLocal(): Promise<GatewayConnectionStatus>;
  gatewayConnectionTest(input: GatewayRelayConnectionInput): Promise<GatewayConnectionTestResult>;
  gatewayConnectionSaveRelay(input: GatewayRelayConnectionInput): Promise<GatewayConnectionStatus>;
  gatewayDeployVps(input: McVpsGatewayDeployRequest): Promise<GatewayConnectionStatus>;

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

  // Companion widget. The main window publishes coarse per-session statuses and
  // the selected pet; main forwards both into the widget window and can ask the
  // main window to re-publish (replay) when the widget (re)opens.
  companionPublishStatuses(statuses: CompanionAgentStatus[]): void;
  companionPublishPet(selection: CompanionSelection): void;
  companionSetVisible(visible: boolean): Promise<void>;
  onCompanionStatuses(callback: (statuses: CompanionAgentStatus[]) => void): () => void;
  onCompanionPet(callback: (selection: CompanionSelection) => void): () => void;
  onCompanionReplayRequest(callback: () => void): () => void;

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
  projectsDeleteIssue(id: string): Promise<void>;
  /** Dispatch an agent onto a task: creates a chat conversation, links it to
   *  the issue, sets in_progress/agent_working, and sends the kickoff
   *  message. `agentName` is config.name (the session-link key), `agentId`
   *  the registry id. Resolves to the new conversation id. */
  projectsAssignAgent(issueId: string, agentId: string, agentName: string): Promise<string>;
  projectsAddComment(issueId: string, body: string): Promise<IssueComment>;
  projectsEditComment(issueId: string, commentId: string, body: string): Promise<IssueComment>;
  projectsDeleteComment(issueId: string, commentId: string): Promise<void>;
  projectsListInbox(): Promise<InboxItem[]>;
  projectsMarkInboxRead(issueId: string): Promise<void>;

  // Projects events (push from main -> renderer)
  onProjectsEvent(callback: (event: ProjectsEvent) => void): () => void;
}
