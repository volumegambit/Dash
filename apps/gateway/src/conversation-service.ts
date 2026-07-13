import type { AgentEvent } from '@dash/agent';
import type {
  ConversationCreateRequest,
  ConversationMessage,
  ConversationMessagePage,
  ConversationPage,
  ConversationPatchRequest,
  ConversationSummary,
  MobileApiError,
  MobileImage,
} from '@dash/mobile-contract';
import type { EventLogPayload, EventLogStore } from './event-log-store.js';

export const DEFAULT_CONVERSATION_TITLE = 'New Conversation';

export interface CreateConversationInput extends ConversationCreateRequest {
  agentName: string;
}

export interface ListConversationsInput {
  agentId?: string;
  limit: number;
  cursor?: string;
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
