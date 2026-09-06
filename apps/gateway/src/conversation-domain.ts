export type RunOutcome = 'completed' | 'cancelled' | 'failed' | 'interrupted';
export type PendingInputKind = 'steer' | 'follow_up';
export type PendingInputState = 'queued' | 'delivering' | 'delivered' | 'removed' | 'failed';

export interface StoredConversation {
  id: string;
  createRequestId: string;
  agentId: string;
  agentName: string;
  title: string;
  revision: number;
  status: 'idle' | 'running' | 'interrupted' | 'archived' | 'deleted';
  activeRunId: string | null;
  owningIssueId: string | null;
  projectId: string | null;
  lastSeq: number;
  v2LastSeq: number;
  queuePaused: boolean;
  queueRevision: number;
  nextMessageOrdinal: number;
  pendingFollowUpCount: number;
  lastMessagePreview: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface StoredConversationMessage {
  id: string;
  conversationId: string;
  turnId: string;
  runId: string;
  segmentIndex: number;
  ordinal: number;
  role: 'user' | 'assistant';
  status: 'accepted' | 'streaming' | 'completed' | 'cancelled' | 'failed' | 'interrupted';
  deliveryKind: 'normal' | 'steer' | 'follow_up';
  deliveryStatus?: 'pending' | 'delivered' | 'not_delivered';
  content: import('@dash/mobile-contract').ConversationContent;
  createdAt: string;
  updatedAt: string;
}

export interface StoredPendingInput {
  inputId: string;
  enqueueCommandId: string;
  conversationId: string;
  agentId: string;
  channelId: string;
  kind: PendingInputKind;
  targetTurnId: string | null;
  text: string;
  images?: import('@dash/mobile-contract').MobileImage[];
  payloadBytes: number;
  state: PendingInputState;
  revision: number;
  enqueueOrder: number;
  reservedRunId: string;
  reservedSegmentTurnId: string;
  reservedUserMessageId: string;
  reservedAssistantMessageId: string;
  reservedUserOrdinal: number | null;
  reservedAssistantOrdinal: number | null;
  segmentIndex: number;
  failureCode?: import('@dash/mobile-contract').MobileApiErrorCode;
  failureMessage?: string;
  createdAt: string;
  updatedAt: string;
  deliveredAt?: string;
}

type WithoutV2Seq<T> = T extends { v2Seq: number } ? Omit<T, 'v2Seq'> : never;
export type MobileV2SequencedPayload = WithoutV2Seq<
  import('@dash/mobile-contract-v2').MobileV2SequencedFrame
>;

export interface AcceptRunInput {
  protocol: 'v1' | 'v2';
  agentId: string;
  channelId: string;
  conversationId: string;
  runId: string;
  text: string;
  images?: import('@dash/mobile-contract').MobileImage[];
}

export interface AcceptedRun {
  conversation: StoredConversation;
  runId: string;
  segmentTurnId: string;
  channelId: string;
  text: string;
  images?: import('@dash/mobile-contract').MobileImage[];
  userMessage: StoredConversationMessage;
  assistantMessage: StoredConversationMessage;
  v1Seq: number;
  v2Frame: Extract<import('@dash/mobile-contract-v2').MobileV2SequencedFrame, { type: 'accepted' }>;
  created: boolean;
  firstUserMessage: boolean;
  sourceInputId?: string;
}

export interface AppendRunEventInput {
  conversationId: string;
  runId: string;
  segmentTurnId: string;
  event: import('@dash/agent').AgentEvent;
}

export interface PersistedRunFrames {
  conversation: StoredConversation;
  v1Seq: number;
  v2Frame: import('@dash/mobile-contract-v2').MobileV2SequencedFrame;
}

export interface DeliverSteerInput {
  conversationId: string;
  runId: string;
  inputId: string;
}

export interface DeliveredInput {
  conversation: StoredConversation;
  input: StoredPendingInput;
  segmentTurnId: string;
  userMessage: StoredConversationMessage;
  assistantMessage: StoredConversationMessage;
  frame: Extract<
    import('@dash/mobile-contract-v2').MobileV2SequencedFrame,
    { type: 'input_delivered' }
  >;
}

export interface TerminalizeSteersInput {
  conversationId: string;
  runId: string;
  inputIds: readonly string[];
  code: import('@dash/mobile-contract').MobileApiErrorCode;
  error: string;
}

export interface PersistedInputTransition {
  conversation: StoredConversation;
  input: StoredPendingInput;
  frame: Extract<
    import('@dash/mobile-contract-v2').MobileV2SequencedFrame,
    {
      type:
        | 'input_accepted'
        | 'input_updated'
        | 'input_removed'
        | 'input_delivered'
        | 'input_failed';
    }
  >;
}

export interface PersistedQueueTransition {
  conversation: StoredConversation;
  frame: Extract<
    import('@dash/mobile-contract-v2').MobileV2SequencedFrame,
    { type: 'queue_paused' | 'queue_resumed' }
  >;
}

export interface EnqueueInputCommand {
  commandId: string;
  inputId: string;
  agentId: string;
  channelId: string;
  conversationId: string;
  text: string;
  images?: import('@dash/mobile-contract').MobileImage[];
  behavior: 'steer' | 'followUp';
  expectedActiveTurnId?: string;
}

export interface EditFollowUpCommand {
  commandId: string;
  conversationId: string;
  inputId: string;
  expectedRevision: number;
  text: string;
  images?: import('@dash/mobile-contract').MobileImage[];
}

export interface RemoveFollowUpCommand {
  commandId: string;
  conversationId: string;
  inputId: string;
  expectedRevision: number;
}

export interface ResumeFollowUpsCommand {
  commandId: string;
  conversationId: string;
  expectedQueueRevision: number;
}

export interface CommandMutationResult {
  replayed: boolean;
  frames: readonly (
    | import('@dash/mobile-contract-v2').MobileV2SequencedFrame
    | import('@dash/mobile-contract-v2').MobileV2ControlFrame
  )[];
  promotedRun?: AcceptedRun;
}

export type StoredCommandOutcome =
  | { kind: 'sequenced'; v2Seqs: number[] }
  | {
      kind: 'rejected';
      frame: Extract<
        import('@dash/mobile-contract-v2').MobileV2ControlFrame,
        { type: 'command_rejected' }
      >;
    };

export type FinishRunInput = {
  conversationId: string;
  runId: string;
  segmentTurnId: string;
  suppressPromotion?: boolean;
} & (
  | { outcome: 'completed' | 'cancelled' | 'interrupted' }
  | {
      outcome: 'failed';
      error: string;
      code?: import('@dash/mobile-contract').MobileApiErrorCode;
      retryable: boolean;
    }
);

export interface FinishRunResult {
  terminal: PersistedRunFrames;
  transitions: Array<PersistedInputTransition | PersistedQueueTransition>;
  claimedRun?: AcceptedRun;
}

export interface DeliveredSteerContext {
  inputId: string;
  text: string;
  images?: import('@dash/mobile-contract').MobileImage[];
}

export interface V2RecoveryResult {
  conversationsInterrupted: number;
  terminalsAppended: number;
  eligibleConversationIds: string[];
}
