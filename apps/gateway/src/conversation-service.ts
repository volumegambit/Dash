import type { AgentEvent } from '@dash/agent';
import type {
  ConversationCreateRequest,
  ConversationKind,
  ConversationMessage,
  ConversationMessageOrigin,
  ConversationMessagePage,
  ConversationPage,
  ConversationPatchRequest,
  ConversationSummary,
  MobileApiError,
  MobileImage,
  SubagentInfo,
  SubagentStatus,
} from '@dash/mobile-contract';
import type { EventLogPayload, EventLogStore } from './event-log-store.js';

export const DEFAULT_CONVERSATION_TITLE = 'New Conversation';

/**
 * Spec cap on `maxQueuedNotifications`. Overflow throws rather than dropping —
 * a silently discarded notification is a child report the parent never sees.
 */
export const MAX_QUEUED_NOTIFICATIONS = 100;

/**
 * Default page size for {@link ConversationService.listSubagents}. The caller
 * that matters is the sub-agent coordinator's cross-turn registry, read on
 * every parent turn; an unbounded `SELECT *` over a conversation that has
 * spawned children for weeks is a scan plus one report-bearing JSON parse per
 * row, on the latency path of every message.
 */
export const DEFAULT_SUBAGENT_LIST_LIMIT = 100;

export interface CreateConversationInput extends ConversationCreateRequest {
  agentName: string;
}

export interface ListConversationsInput {
  agentId?: string;
  /**
   * Defaults to `'user'`. Child conversations stay out of the conversation list
   * unless a caller asks for them by kind: a child's prompt can quote parent
   * context, so exposing them by default would be a privacy regression.
   */
  kind?: ConversationKind;
  /**
   * Restricts the page to children of this conversation. Note that `kind`
   * still defaults to `'user'` and parents have no parent, so this filter
   * returns nothing unless you also pass `kind: 'subagent'`.
   */
  parentConversationId?: string;
  limit: number;
  cursor?: string;
}

export interface CreateSubagentConversationInput {
  id: string;
  agentId: string;
  agentName: string;
  parentConversationId: string;
  parentTurnId: string;
  title: string;
  subagent: SubagentInfo;
}

export interface UpdateSubagentInput {
  status?: SubagentStatus;
  info?: Partial<SubagentInfo>;
}

export interface PendingNotification {
  id: string;
  conversationId: string;
  kind: 'subagent_finished' | 'subagent_message';
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface ListMessagesInput {
  conversationId: string;
  limit: number;
  before?: string;
}

export interface AcceptTurnInput {
  agentId: string;
  conversationId: string;
  turnId: string;
  text: string;
  images?: MobileImage[];
  /** Defaults to `'user'`; server-initiated turns pass `'notification'`. */
  origin?: ConversationMessageOrigin;
}

export interface AcceptedTurn {
  conversation: ConversationSummary;
  userMessage: ConversationMessage;
  assistantMessage: ConversationMessage;
  seq: number;
  revision: number;
  created: boolean;
  firstUserMessage: boolean;
}

export type FinishTurnInput =
  | { conversationId: string; turnId: string; outcome: 'completed' | 'cancelled' }
  | {
      conversationId: string;
      turnId: string;
      outcome: 'failed';
      error: string;
      code?: MobileApiError['code'];
      retryable: boolean;
    };

export interface PersistedTurnFrame {
  conversation: ConversationSummary;
  seq: number;
  payload: EventLogPayload;
}

export interface ConversationService {
  readonly eventLog: EventLogStore;
  create(input: CreateConversationInput): ConversationSummary;
  get(id: string, options?: { includeDeleted?: boolean }): ConversationSummary | null;
  list(input: ListConversationsInput): ConversationPage;
  update(
    id: string,
    expectedRevision: number,
    patch: ConversationPatchRequest,
  ): ConversationSummary;
  delete(id: string, expectedRevision: number): ConversationSummary;
  listMessages(input: ListMessagesInput): ConversationMessagePage;
  acceptTurn(input: AcceptTurnInput): AcceptedTurn;
  appendTurnEvent(
    conversationId: string,
    turnId: string,
    event: AgentEvent,
  ): PersistedTurnFrame | null;
  finishTurn(input: FinishTurnInput): PersistedTurnFrame;
  createSubagent(input: CreateSubagentConversationInput): ConversationSummary;
  updateSubagent(id: string, patch: UpdateSubagentInput): ConversationSummary;
  /**
   * Children of a conversation, oldest first. BOUNDED: `limit` defaults to
   * {@link DEFAULT_SUBAGENT_LIST_LIMIT} and keeps the NEWEST children, because
   * every row read parses that child's whole `subagent_meta` blob — its report
   * included — and callers read this per parent turn.
   */
  listSubagents(parentConversationId: string, limit?: number): ConversationSummary[];
  listInterruptedSubagents(): ConversationSummary[];
  enqueueNotification(
    notification: Omit<PendingNotification, 'id' | 'createdAt'>,
  ): PendingNotification;
  drainNotifications(conversationId: string): PendingNotification[];
  trySetAutoTitle(id: string, title: string): ConversationSummary | null;
  archiveAgentConversations(agentId: string): ConversationSummary[];
  recoverInterruptedTurns(): { conversationsInterrupted: number; terminalsAppended: number };
  close(): void;
}

export class ConversationServiceError extends Error {
  constructor(
    readonly code: MobileApiError['code'],
    message: string,
    readonly status: 400 | 404 | 409 | 410 | 422,
    readonly retryable: boolean,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}
