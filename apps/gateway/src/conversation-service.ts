import type { AgentEvent } from '@dash/agent';
import type {
  ConversationCreateRequest,
  ConversationKind,
  ConversationMessage,
  ConversationMessageOrigin,
  ConversationMessagePage,
  ConversationNoticeKind,
  ConversationPage,
  ConversationPatchRequest,
  ConversationSummary,
  MobileApiError,
  MobileImage,
  SubagentInfo,
  SubagentStatus,
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

export interface AppendNoticeInput {
  conversationId: string;
  kind: ConversationNoticeKind;
  /** Display-ready text; clients render it verbatim inside a chip. */
  text: string;
}

export interface CreateSubagentConversationInput {
  id: string;
  agentId: string;
  agentName: string;
  parentConversationId: string;
  parentTurnId: string;
  title: string;
  subagent: SubagentInfo;
  /**
   * The child's resolved {@link SubagentGrant}, written in the SAME transaction
   * as the row. It used to be a separate `putSubagentGrant` immediately after
   * the create, and a process death between the two left a durable child row
   * with no grant — a child that can never take another turn, refused with the
   * generic `its grant cannot be rebuilt`. Omitted only where the caller has no
   * spec to derive one from.
   */
  grant?: SubagentGrant;
}

/**
 * The half of a child that `SubagentInfo` structurally cannot carry: its
 * resolved GRANT — what tools, MCP servers, spawnable types and workspace the
 * spawn actually gave it, plus the definition body it ran under.
 *
 * Gateway-internal on purpose: it is NOT part of the mobile contract's
 * `SubagentInfo` and never reaches a client. It exists so a child can be
 * RESUMED after its in-memory spec is gone (it finished, it was LRU-evicted, or
 * the gateway restarted) — the resume rebuilds a spec from this and
 * re-intersects it against what the parent holds at that moment.
 */
export interface SubagentGrant {
  /** Built-in tool names the child was granted. */
  tools: string[];
  /** Fully-qualified `server__tool` names. Absent = no MCP. */
  mcpTools?: string[];
  /** `agent(a, b)` — the types this child may itself spawn. Unset = all. */
  spawnableTypes?: string[];
  /** Whether the child holds `agent` / `send_message` at all. */
  canSpawn?: boolean;
  /** Where it ran — its own worktree when it was isolated. */
  workspace: string;
  depth: number;
  /** The definition body (plus any preloaded skills) it ran under. */
  systemPrompt?: string;
  /** Explore / Plan: no memory at all (not even read-only). */
  skipMemory?: boolean;
  maxTurns?: number;
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
  /** Append a standalone notice message (see the sqlite implementation). */
  appendNotice(input: AppendNoticeInput): ConversationMessage | null;
  appendTurnEvent(
    conversationId: string,
    turnId: string,
    event: AgentEvent,
  ): PersistedTurnFrame | null;
  finishTurn(input: FinishTurnInput): PersistedTurnFrame;
  createSubagent(input: CreateSubagentConversationInput): ConversationSummary;
  updateSubagent(id: string, patch: UpdateSubagentInput): ConversationSummary;
  /**
   * Record (or clear) a child's resolved {@link SubagentGrant}. Written on
   * every spawn AND on every resume, so a grant that has been narrowed since
   * the child last ran is what the next rebuild reads. Never bumps the
   * conversation revision: no client sees this field.
   */
  putSubagentGrant(id: string, grant: SubagentGrant | undefined): void;
  /** The child's resolved grant, or undefined for a row written without one. */
  getSubagentGrant(id: string): SubagentGrant | undefined;
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
  /**
   * The conversation's queued notifications in creation order, LEFT IN PLACE.
   *
   * Delivery peeks, starts the parent turn, then {@link ackNotifications}s the
   * rows it carried. A destructive drain that re-inserts on a busy parent would
   * lose the queue if the process died in that window and would re-stamp
   * `created_at`, reordering the queue against later arrivals.
   */
  peekNotifications(conversationId: string): PendingNotification[];
  /** Deletes exactly these rows. Unknown ids are ignored. */
  ackNotifications(ids: string[]): void;
  trySetAutoTitle(id: string, title: string): ConversationSummary | null;
  archiveAgentConversations(agentId: string): ConversationSummary[];
  /**
   * Boot recovery: terminalize every turn a dead process left mid-flight and —
   * design §7.5 — mark every non-terminal CHILD `interrupted`, since after a
   * restart no child is running.
   */
  recoverInterruptedTurns(): {
    conversationsInterrupted: number;
    terminalsAppended: number;
    subagentsInterrupted: number;
  };
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
  listActiveRunsForRecovery(): Array<{
    agentId: string;
    conversationId: string;
    runId: string;
  }>;
  recoverV2State(options?: { excludeConversationIds?: ReadonlySet<string> }): V2RecoveryResult;
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
