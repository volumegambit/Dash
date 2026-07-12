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
      v: 1;
      host: string;
      mgmtToken: string;
      chatToken: string;
      mgmtPort?: number;
      chatPort?: number;
      label?: string;
      secure?: boolean;
    }
  | {
      v: 2;
      host: string;
      secure: true;
      mgmtToken: string;
      chatToken: string;
      relayCredential: string;
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
  | { type: 'cancel'; id: string };

export type MobileWsServerFrame =
  | {
      type: 'accepted';
      id: string;
      conversationId: string;
      userMessageId: string;
      assistantMessageId: string;
      revision: number;
      seq: number;
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
