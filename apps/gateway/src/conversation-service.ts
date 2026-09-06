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
import type {
  MobileV2ConversationBootstrap,
  MobileV2ConversationMessagePage,
  MobileV2ConversationPage,
  MobileV2ConversationSummary,
} from '@dash/mobile-contract-v2';
import type {
  AcceptRunInput,
  AcceptedRun,
  AppendRunEventInput,
  ClaimedFollowUp,
  CommandMutationResult,
  DeliverSteerInput,
  DeliveredInput,
  DeliveredSteerContext,
  EditFollowUpCommand,
  EnqueueInputCommand,
  FinishRunInput,
  FinishRunResult,
  PersistedInputTransition,
  PersistedQueueTransition,
  PersistedRunFrames,
  RemoveFollowUpCommand,
  ResumeFollowUpsCommand,
  StoredConversationMessage,
  TerminalizeSteersInput,
  V2RecoveryResult,
  V2ReplayResult,
} from './conversation-domain.js';
import type { EventLogPayload, EventLogStore } from './event-log-store.js';

export const DEFAULT_CONVERSATION_TITLE = 'New Conversation';
export const MAX_PENDING_INPUTS_PER_KIND = 20;
export const MAX_PENDING_INPUT_BYTES = 100 * 1024 * 1024;

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
  createV2(input: CreateConversationInput): MobileV2ConversationSummary;
  get(id: string, options?: { includeDeleted?: boolean }): ConversationSummary | null;
  getV2(id: string, options?: { includeDeleted?: boolean }): MobileV2ConversationSummary | null;
  list(input: ListConversationsInput): ConversationPage;
  listV2(input: ListConversationsInput): MobileV2ConversationPage;
  update(
    id: string,
    expectedRevision: number,
    patch: ConversationPatchRequest,
  ): ConversationSummary;
  updateV2(
    id: string,
    expectedRevision: number,
    patch: ConversationPatchRequest,
  ): MobileV2ConversationSummary;
  delete(id: string, expectedRevision: number): ConversationSummary;
  deleteV2(id: string, expectedRevision: number): MobileV2ConversationSummary;
  listMessages(input: ListMessagesInput): ConversationMessagePage;
  listMessagesV2(input: ListMessagesInput): MobileV2ConversationMessagePage;
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
  acceptRun(input: AcceptRunInput): AcceptedRun;
  appendRunEvent(input: AppendRunEventInput): PersistedRunFrames | null;
  appendCurrentRunEvent(
    agentId: string,
    conversationId: string,
    runId: string,
    event: AgentEvent,
  ): PersistedRunFrames | null;
  deliverSteer(input: DeliverSteerInput): DeliveredInput;
  terminalizeSteersNotDelivered(input: TerminalizeSteersInput): PersistedInputTransition[];
  enqueueInput(
    input: EnqueueInputCommand,
    options?: { steerAdmissionOpen?: boolean },
  ): CommandMutationResult;
  editFollowUp(input: EditFollowUpCommand): CommandMutationResult;
  removeFollowUp(input: RemoveFollowUpCommand): CommandMutationResult;
  resumeFollowUps(input: ResumeFollowUpsCommand): CommandMutationResult;
  pauseFollowUpsForAgentDisable(agentId: string): PersistedQueueTransition[];
  finishRunAndClaimNext(input: FinishRunInput): FinishRunResult;
  claimNextFollowUp(conversationId: string): ClaimedFollowUp | null;
  bootstrapV2(input: ListMessagesInput): MobileV2ConversationBootstrap;
  readV2Since(agentId: string, conversationId: string, sinceV2Seq: number): V2ReplayResult;
  listDeliveredSteers(conversationId: string): DeliveredSteerContext[];
  recoverV2State(): V2RecoveryResult;
  listRunMessages(conversationId: string, runId: string): StoredConversationMessage[];
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
