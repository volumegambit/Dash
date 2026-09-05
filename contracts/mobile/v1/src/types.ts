export type MobileCapability = 'conversation-sync-v1' | 'chat-resume-v1';
export type ConversationStatus = 'idle' | 'running' | 'interrupted' | 'archived' | 'deleted';
export type ConversationMessageStatus =
  | 'accepted'
  | 'streaming'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'interrupted';
export type ConversationRole = 'user' | 'assistant';
export type ConversationKind = 'user' | 'subagent';
export type ConversationMessageOrigin = 'user' | 'notification' | 'parent';
export type SubagentStatus =
  | 'running'
  | 'waiting_input'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'max_turns';
export type MobileImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

export interface FixtureManifest {
  version: 1;
  cases: FixtureCase[];
}

export interface FixtureCase {
  file: string;
  document: 'openapi' | 'chat-ws';
  schema: string;
  valid: boolean;
  format?: 'json' | 'jsonl' | 'sse';
}

export interface MobileHealth {
  status: 'healthy';
  startedAt: string;
  pid: number;
  agents: number;
  channels: number;
  apiVersion: 1;
  capabilities: MobileCapability[];
}

export interface GatewayIdentity {
  gatewayId: string;
  publicKey: string;
}

export type PairingPayload =
  | {
      v: 2;
      host: string;
      secure: true;
      mgmtToken: string;
      chatToken: string;
      relayCredential: string;
    }
  | {
      v: 3;
      host: string;
      secure: true;
      mgmtToken: string;
      chatToken: string;
      mgmtPort: number;
      chatPort: number;
      tlsCertificateSha256: string;
    };

export interface MobileAgent {
  id: string;
  name: string;
  config: {
    name: string;
    model: string;
    systemPrompt: string;
    fallbackModels?: string[];
    tools?: string[];
    skills?: { paths?: string[]; urls?: string[] };
    workspace?: string;
    maxTokens?: number;
    mcpServers?: string[];
    plugins?: string[];
    providers?: string[];
    swarm?: {
      enabled?: boolean;
      maxConcurrentWorkers?: number;
      maxWorkersPerRun?: number;
      maxSteersPerWorker?: number;
      maxRunSeconds?: number;
      allowedModels?: string[];
    };
  };
  status: 'registered' | 'active' | 'disabled';
  registeredAt: string;
}

export interface CreateMobileAgentRequest {
  name: string;
  model: string;
  systemPrompt: string;
}

export interface UpdateMobileAgentRequest {
  model?: string;
  systemPrompt?: string;
}

export interface MobileActionResponse {
  ok: true;
}

export interface MobileModel {
  value: string;
  label: string;
  provider: string;
}

export interface MobileModelsResponse {
  models: MobileModel[];
  source: 'live' | 'bootstrap';
  errors: Record<string, string>;
  fetchedAt: string;
  supportedModelsReviewedAt: string;
}

export interface MobileImage {
  mediaType: MobileImageMediaType;
  data: string;
}

export interface MobileAgentEvent {
  type: string;
  [key: string]: unknown;
}

export type ConversationContent =
  | { type: 'user'; text: string; images?: MobileImage[] }
  | { type: 'assistant'; events: MobileAgentEvent[] };

export interface SubagentUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * Everything a client needs to render a sub-agent row without fetching the
 * child transcript. `depth` is 1 for a child of a user conversation.
 */
export interface SubagentInfo {
  type: string;
  name?: string;
  status: SubagentStatus;
  description: string;
  prompt: string;
  model: string;
  background: boolean;
  isolation?: 'worktree';
  depth: number;
  startedAt: string;
  endedAt?: string;
  usage?: SubagentUsage;
  toolCallCount: number;
  report?: string;
  oneShot: boolean;
}

export interface ConversationSummary {
  id: string;
  agentId: string;
  agentName: string;
  title: string;
  revision: number;
  status: ConversationStatus;
  activeTurnId: string | null;
  owningIssueId: string | null;
  projectId: string | null;
  lastSeq: number;
  lastMessagePreview: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
  /** `'subagent'` rows are children; the conversation list shows `'user'` only. */
  kind: ConversationKind;
  parentConversationId?: string;
  parentTurnId?: string;
  subagent?: SubagentInfo;
}

export interface ConversationMessage {
  id: string;
  conversationId: string;
  turnId: string;
  ordinal: number;
  role: ConversationRole;
  status: ConversationMessageStatus;
  content: ConversationContent;
  createdAt: string;
  updatedAt: string;
  /** Who caused this turn. Absent on pre-`origin` clients; treat as `'user'`. */
  origin?: ConversationMessageOrigin;
}

export interface ConversationPage {
  items: ConversationSummary[];
  nextCursor: string | null;
}

export interface ConversationMessagePage {
  items: ConversationMessage[];
  nextCursor: string | null;
  throughSeq: number;
}

export interface ConversationCreateRequest {
  agentId: string;
  requestId: string;
  title?: string;
  owningIssueId?: string;
  projectId?: string;
}

export interface ConversationPatchRequest {
  title?: string;
  owningIssueId?: string | null;
  projectId?: string | null;
}

export type MobileApiErrorCode =
  | 'unauthorized'
  | 'not_found'
  | 'validation_failed'
  | 'revision_conflict'
  | 'conversation_busy'
  | 'rate_limited'
  | 'gateway_offline'
  | 'capability_required';

export interface MobileApiError {
  code: MobileApiErrorCode;
  error: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export type MobileWsClientFrame =
  | {
      type: 'message';
      id: string;
      agentId: string;
      channelId: string;
      conversationId: string;
      text: string;
      images?: MobileImage[];
      streamingBehavior?: 'steer' | 'followUp';
      resumable?: boolean;
    }
  | { type: 'resume'; id: string; agentId: string; conversationId: string; sinceSeq: number }
  | { type: 'answer'; id: string; questionId: string; answer: string }
  | { type: 'cancel'; id: string }
  /**
   * Watch a conversation the socket did not start a turn on, so server-initiated
   * turns (`accepted` with `origin: 'notification'`) and sub-agent child turns
   * reach it. `message` and `resume` subscribe implicitly; this frame is only
   * needed for a conversation the socket has not otherwise touched.
   */
  | { type: 'subscribe'; id: string; agentId: string; conversationId: string }
  | { type: 'unsubscribe'; id: string; agentId: string; conversationId: string };

export type MobileWsServerFrame =
  | {
      type: 'accepted';
      id: string;
      conversationId: string;
      userMessageId: string;
      assistantMessageId: string;
      revision: number;
      seq: number;
      /**
       * Who caused this turn. Omitted for an ordinary user turn on a user
       * conversation, so a pre-subscription client sees the same bytes it
       * always did; absent means `'user'`.
       */
      origin?: ConversationMessageOrigin;
      /** Conversation kind. Omitted alongside `origin`; absent means `'user'`. */
      kind?: ConversationKind;
    }
  | {
      type: 'event';
      id: string;
      conversationId?: string;
      seq?: number;
      event: MobileAgentEvent;
    }
  | {
      type: 'done';
      id: string;
      conversationId?: string;
      seq?: number;
      outcome?: 'completed' | 'cancelled';
    }
  | {
      type: 'error';
      id: string;
      conversationId?: string;
      seq?: number;
      error: string;
      code?: MobileApiErrorCode;
      retryable?: boolean;
      activeTurnId?: string;
    };

export type ReplayPayload =
  | {
      type: 'accepted';
      userMessageId: string;
      assistantMessageId: string;
      revision: number;
    }
  | { type: 'event'; event: MobileAgentEvent }
  | { type: 'done'; outcome?: 'completed' | 'cancelled' }
  | { type: 'error'; error: string; code?: MobileApiErrorCode; retryable?: boolean };

export interface ReplayEntry {
  seq: number;
  msgId: string;
  agentId: string;
  conversationId: string;
  timestamp: string;
  payload: ReplayPayload;
}

export interface ReplayPage {
  entries: ReplayEntry[];
}

export interface ConversationChangedEvent {
  type: 'conversation:changed';
  conversationId: string;
  revision: number;
}

export interface ConversationDeletedEvent {
  type: 'conversation:deleted';
  conversationId: string;
  revision: number;
}

/** Response of POST /mobile/v1/ws-ticket — single-use WebSocket upgrade ticket. */
export interface WsTicketResponse {
  ticket: string;
  expiresAt: string;
}
