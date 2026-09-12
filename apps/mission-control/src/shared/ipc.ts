import type {
  LessonBookInfo,
  MemoryConfig,
  MemoryContent,
  MemoryInfo,
  MemoryType,
  PluginInstallRequest,
  PluginInstallResponse,
  PluginRecord,
  PluginSetStateRequest,
  RuntimePluginsResponse,
  SkillContent,
  SkillInfo,
  SkillsConfig,
  SubagentResumeResult,
  SubagentStopResult,
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
  SubagentListEntry,
} from '@dash/mobile-contract';
import type {
  MobileV2ConversationBootstrap,
  MobileV2ConversationMessagePage,
  MobileV2SequencedFrame,
  MobileV2WsServerFrame,
} from '@dash/mobile-contract-v2';
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
export type { MemoryConfig, MemoryContent, MemoryInfo, MemoryType } from '@dash/management';
export type { GatewayConnectionSettings } from '@dash/mc';

// Top-level setup/onboarding status. Distinguishes a genuine first run
// (`needs-setup`) from a configured user whose gateway cannot start
// (`gateway-failed`) — the latter must NOT be shown the onboarding wizard.
export type SetupStatus =
  | { state: 'needs-setup' }
  | { state: 'ready' }
  | { state: 'gateway-failed'; error: string };

// Serializable AgentEvent (error is string, not Error object, for IPC transport).
// @deprecated The worker_* variants are the mirrors D8 retired. Nothing emits
// one; they stay for ONE release because a PERSISTED pre-D8 transcript still
// contains them and the renderer must recognise them rather than draw
// "Activity from a newer Dash version". They mirror @dash/agent's AgentEvent
// exactly — they carry no
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
  | {
      type: 'memory_saved';
      name: string;
      description: string;
      memoryType: 'user' | 'feedback' | 'project' | 'reference';
      action: 'created' | 'updated';
    }
  | { type: 'memory_forgotten'; name: string }
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
      status: 'done' | 'failed' | 'cancelled' | 'interrupted' | 'max_turns';
      report: string;
      usage?: { inputTokens: number; outputTokens: number };
    }
  // The canonical sub-agent family (design §7.2), mirroring @dash/agent's
  // AgentEvent exactly. The gateway emitted these alongside the retired
  // `worker_*`
  // variants above for every child until task D8 retires the mirrors; the
  // child's conversation id IS its worker id, so both families name the same
  // string and `chat.swarm.ts` folds them onto ONE card.
  | {
      type: 'subagent_started';
      subagentId: string;
      name?: string;
      subagentType: string;
      description: string;
      prompt: string;
      model: string;
      background: boolean;
      depth: number;
      startedAt: string;
      isolation?: 'worktree';
      parentTurnId?: string;
    }
  | {
      type: 'subagent_progress';
      subagentId: string;
      status: 'running' | 'waiting_input';
      toolCallCount: number;
      elapsedMs: number;
      detail?: string;
      question?: string;
    }
  | {
      type: 'subagent_finished';
      subagentId: string;
      name?: string;
      subagentType: string;
      description: string;
      status: 'done' | 'failed' | 'cancelled' | 'interrupted' | 'max_turns';
      report: string;
      usage?: { inputTokens: number; outputTokens: number };
      toolCallCount: number;
      startedAt: string;
      endedAt: string;
    }
  // The coordinator's name-only spawn announcement, pushed between a child's
  // `agent_spawned` and its `subagent_started`. It renders nothing of its own
  // — the sub-agent card is the announcement — but it has to be MODELLED, or
  // the transcript draws "Activity from a newer Dash version" beside every
  // child this gateway spawns.
  | { type: 'agent_spawned'; name: string }
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

export type ChatInitialState =
  | { protocol: 'v1'; page: ConversationMessagePage }
  | { protocol: 'v2'; bootstrap: MobileV2ConversationBootstrap };

export type ChatOlderMessagePage =
  | { protocol: 'v1'; page: ConversationMessagePage }
  | { protocol: 'v2'; page: MobileV2ConversationMessagePage };

export type ChatAcceptedFrame =
  | {
      protocol: 'v1';
      frame: Extract<MobileWsServerFrame, { type: 'accepted' }>;
    }
  | {
      protocol: 'v2';
      frame: Extract<MobileV2SequencedFrame, { type: 'accepted' }>;
    };

export interface ChatEnqueueInputRequest {
  commandId: string;
  inputId: string;
  behavior: 'steer' | 'followUp';
  expectedActiveTurnId?: string;
  text: string;
  images?: MobileImage[];
}

export interface ChatEditFollowUpRequest {
  commandId: string;
  inputId: string;
  expectedRevision: number;
  text: string;
  images?: MobileImage[];
}

export interface ChatV2CommandIssue {
  conversation: ConversationRef;
  commandId: string;
  kind: 'cancel' | 'answer';
  localDispatchToken: string;
  questionId?: string;
  ambiguousCorrelation: boolean;
  apiError: MobileApiError;
}

export class ConversationChatSupersededError extends Error {
  readonly name = 'ConversationChatSupersededError';

  constructor() {
    super('Conversation subscription changed before the command was acknowledged');
  }
}

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
  | {
      ok: false;
      error: { message: string; kind?: 'superseded'; apiError?: MobileApiError };
    };

const MOBILE_API_ERROR_CODES: Record<MobileApiError['code'], true> = {
  unauthorized: true,
  not_found: true,
  validation_failed: true,
  revision_conflict: true,
  conversation_busy: true,
  rate_limited: true,
  gateway_offline: true,
  capability_required: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isMobileApiError(value: unknown): value is MobileApiError {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (
    keys.length < 3 ||
    keys.length > 4 ||
    !keys.every((key) => ['code', 'error', 'retryable', 'details'].includes(key))
  ) {
    return false;
  }
  if (
    !Object.hasOwn(value, 'code') ||
    !Object.hasOwn(value, 'error') ||
    !Object.hasOwn(value, 'retryable') ||
    typeof value.code !== 'string' ||
    !Object.hasOwn(MOBILE_API_ERROR_CODES, value.code) ||
    typeof value.error !== 'string' ||
    value.error.length === 0 ||
    typeof value.retryable !== 'boolean'
  ) {
    return false;
  }
  return !Object.hasOwn(value, 'details') || isRecord(value.details);
}

function structuredMobileError(error: unknown): MobileApiError | undefined {
  if (!isRecord(error)) return undefined;
  const candidate = Object.hasOwn(error, 'apiError') ? error.apiError : error;
  return isMobileApiError(candidate) ? candidate : undefined;
}

export async function captureChatIpcResult<T>(
  operation: () => Promise<T>,
): Promise<ChatIpcResult<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof ConversationChatSupersededError) {
      return { ok: false, error: { kind: 'superseded', message } };
    }
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

/**
 * The two channels a watched child's stream lifecycle rides on (§7.6, C2).
 *
 * Constants rather than literals on both sides because a typo in either one
 * ships GREEN: nothing crosses this boundary in a test, `tsc` cannot compare
 * two string literals in two files, and biome has no opinion about them. In
 * production a mistyped name would silently disable the whole C2 fix —
 * `markSubagentWatchLost` would never fire, `live` would stay `true`, and the
 * permanent duplicate row would be back. With one exported constant there is
 * only one string, and a mistyped IDENTIFIER is a compile error.
 */
export const CHAT_SUBAGENT_WATCH_LOST = 'chat:subagentWatchLost';
/** @see CHAT_SUBAGENT_WATCH_LOST */
export const CHAT_SUBAGENT_RESUBSCRIBED = 'chat:subagentResubscribed';

export function unwrapChatIpcResult<T>(result: ChatIpcResult<T>): T {
  if (result.ok) return result.value;
  if (result.error.kind === 'superseded') throw new ConversationChatSupersededError();
  const error = new Error(result.error.message);
  if (isMobileApiError(result.error.apiError)) {
    Object.assign(error, { apiError: result.error.apiError });
  }
  throw error;
}

// Coarse per-session status the companion pet renders. Single source of
// truth: the renderer's companion/types.ts re-exports this.
export type CompanionStatus = 'working' | 'needs' | 'done' | 'error';

// One entry per live session the squad widget tracks, carrying the identity of
// the agent it belongs to plus a short human-readable preview of what that
// session is doing right now (the live tool, the question, the error, or the
// final text). The widget groups these by `agentId` to map squad members to
// agents; the speech bubbles render `preview`.
export interface CompanionAgentStatus {
  agentId: string;
  agentName: string;
  status: CompanionStatus;
  preview: string;
}

// Every pixel-art sprite is a member of exactly one squad (see the rosters in
// the renderer's companion/pets/squads.ts). Individual pets are not selectable.
export type PetKind =
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

// A themed squad of five pets, the only selectable unit; the widget renders
// one member per running agent. The renderer's companion/pets/squads.ts owns
// the rosters and re-exports this type.
export type SquadKind =
  | 'kitchen'
  | 'office'
  | 'wait'
  | 'soldier'
  | 'police'
  | 'fire'
  | 'villager'
  | 'farmer'
  | 'gym';

// What the user selected for the squad widget. Persisted as a string in
// localStorage and forwarded over IPC. Legacy persisted values (`crew:<kind>`
// from the crew era, or a bare pet id from the single-pet era) are normalized
// by parseCompanionSelection.
export type CompanionSelection = SquadKind;

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
  /** Nonsecret control-plane id used only to match this rendered QR for revocation. */
  pairingId: string;
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

  // Pairing (mobile apps)
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
  chatGetInitialState(conversation: ConversationRef): Promise<ChatInitialState>;
  chatGetOlderMessages(
    conversation: ConversationRef,
    before: string,
    limit?: number,
  ): Promise<ChatOlderMessagePage>;
  chatSend(
    conversation: ConversationRef,
    turnId: string,
    text: string,
    images?: MobileImage[],
  ): Promise<ChatAcceptedFrame | undefined>;
  chatCancel(conversation: ConversationRef, turnId: string, localDispatchToken: string): void;
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
    localDispatchToken: string,
  ): void;
  chatSubscribeV2(conversation: ConversationRef, sinceV2Seq: number): Promise<void>;
  chatUnsubscribeV2(conversation: ConversationRef): Promise<void>;
  chatEnqueueInput(
    conversation: ConversationRef,
    request: ChatEnqueueInputRequest,
  ): Promise<Extract<MobileV2SequencedFrame, { type: 'input_accepted' }>>;
  chatEditFollowUp(
    conversation: ConversationRef,
    request: ChatEditFollowUpRequest,
  ): Promise<Extract<MobileV2SequencedFrame, { type: 'input_updated' }>>;
  chatRemoveFollowUp(
    conversation: ConversationRef,
    commandId: string,
    inputId: string,
    expectedRevision: number,
  ): Promise<Extract<MobileV2SequencedFrame, { type: 'input_removed' }>>;
  chatResumeFollowUps(
    conversation: ConversationRef,
    commandId: string,
    expectedQueueRevision: number,
  ): Promise<Extract<MobileV2SequencedFrame, { type: 'queue_resumed' }>>;

  // Events (push from main -> renderer)
  onChatFrame(callback: (frame: MobileWsServerFrame) => void): () => void;
  onChatV2Frame(callback: (frame: MobileV2WsServerFrame) => void): () => void;
  onChatV2CommandError(callback: (issue: ChatV2CommandIssue) => void): () => void;
  onChatConnectionError(callback: (issue: ChatConnectionIssue) => void): () => void;
  onChatConversationInvalidated(callback: (event: ConversationInvalidation) => void): () => void;
  onAgentEvent(callback: (conversationId: string, event: McAgentEvent) => void): () => void;
  onChatDone(callback: (conversationId: string) => void): () => void;
  onChatError(callback: (conversationId: string, error: string) => void): () => void;
  onChatConversationRenamed(callback: (conversationId: string, title: string) => void): () => void;
  /**
   * A watched child conversation's stream dropped and came back. Subscribing
   * replays NOTHING (`apps/gateway/src/chat-ws.ts:425-427`), so everything the
   * child emitted while the socket was down is only recoverable by re-reading
   * its transcript over REST — which is what this asks for.
   */
  onSubagentResubscribed(callback: (conversationId: string) => void): () => void;
  /**
   * The socket behind a watch this renderer holds is NOT OPEN — the factory
   * threw, the socket closed, an older gateway refused the `subscribe` frame,
   * or the hold was taken while main had no transport at all.
   *
   * A hold is bookkeeping; only an open socket can carry an `accepted`. The
   * store answers by turning optimism off for that child, and keeps the hold
   * so the subscribe/unsubscribe pairing stays 1:1. `onSubagentResubscribed`
   * is the only thing that takes it back.
   */
  onSubagentWatchLost(callback: (conversationId: string) => void): () => void;

  // Skills (gateway passthrough)
  skillsList(agentId: string): Promise<SkillInfo[]>;
  /** Null when the skill is not a learned lesson book. */
  skillsLessons(agentId: string, skillName: string): Promise<LessonBookInfo | null>;
  skillsRetireLesson(agentId: string, skillName: string, lessonId: string): Promise<LessonBookInfo>;
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

  // Agent memory (gateway passthrough). `memoryGet` resolves to `null` when the
  // gateway answers 404, mirroring `skillsGet`.
  memoryList(agentId: string): Promise<MemoryInfo[]>;
  memoryGet(agentId: string, name: string): Promise<MemoryContent | null>;
  memoryPut(
    agentId: string,
    name: string,
    input: { description: string; type: MemoryType; content: string },
  ): Promise<void>;
  memoryRemove(agentId: string, name: string): Promise<void>;
  memoryGetConfig(agentId: string): Promise<MemoryConfig>;
  memoryUpdateConfig(agentId: string, patch: Partial<MemoryConfig>): Promise<MemoryConfig>;

  // Sub-agents (gateway passthrough, design §7.7). The children-of-conversation
  // family that replaces the run-scoped calls above.
  //
  // `subagentStop`/`subagentResume` resolve to `{ok:true, …}` or
  // `{ok:false, reason}`: the gateway's three actionable refusals (one-shot
  // type, unrebuildable grant, steer cap) are 409s, and a rejected
  // `ipcMain.handle` reaches the renderer as an Error the bridge has rewritten,
  // so a refusal a human has to read must be a VALUE. Everything else (a 404,
  // a malformed request) still rejects.
  /** This conversation's DEPTH-0 children. A grandchild is not in the list. */
  subagentsList(conversationId: string): Promise<SubagentListEntry[]>;
  subagentStop(subagentId: string): Promise<SubagentStopResult>;
  /**
   * Send a message to a child from its parent. `requestId` is echoed on the
   * `accepted` frame of the turn this becomes — for a client subscribed to the
   * CHILD's stream, which Mission Control is not; it is sent because the
   * correlation is the server's to offer and cannot be claimed later.
   */
  subagentResume(
    subagentId: string,
    message: string,
    requestId?: string,
  ): Promise<SubagentResumeResult>;
  /** One page of any conversation's messages — the child transcript a card expands into. */
  conversationMessages(conversationId: string, before?: string): Promise<ConversationMessagePage>;
  /**
   * Take one hold on a child conversation's live stream (design §7.6, §8.3),
   * so its frames reach `onChatFrame` while a card is expanded or the panel is
   * open. `agentId` is the PARENT's — a child belongs to the same agent, and
   * the gateway's hub keys its watcher registry on that pair.
   *
   * Both halves ride ONE channel rather than two, so the pair can never
   * arrive out of order and leave main holding a watch nobody wants. Main
   * refcounts; the renderer must send exactly one release per hold.
   */
  subagentSubscribe(agentId: string, conversationId: string): void;
  /** Release one hold. The last one out sends `unsubscribe` and closes. */
  subagentUnsubscribe(conversationId: string): void;
  /**
   * Ask for a fresh socket on a hold that is ALREADY counted, because the one
   * behind it died (§7.6, C2). Takes no hold and releases none — the count is
   * exactly what it was — so the 1:1 subscribe/unsubscribe pairing main
   * refcounts on is untouched.
   *
   * This exists because the renderer is the only side that knows a watch is
   * dead: `subagentSubscribe` on a conversation already held never reaches
   * main at all (the store returns on the existing entry), so with two holders
   * — the panel open AND a card expanded — nothing could revive it.
   */
  subagentRewatch(agentId: string, conversationId: string): void;

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
