import type {
  ConversationMessage,
  ConversationSummary,
  MobileAgentEvent,
  MobileApiErrorCode,
  MobileHealth,
  MobileImage,
  MobileWsClientFrame,
} from '@dash/mobile-contract';

export const MOBILE_V2_CONTRACT_VERSION = 2 as const;
export const CHAT_INPUT_QUEUE_CAPABILITY = 'chat-input-queue-v1' as const;

export interface MobileV2HealthResponse extends Omit<MobileHealth, 'apiVersion' | 'capabilities'> {
  apiVersion: 2;
  capabilities: string[];
}

export interface MobileV2ConversationSummary extends ConversationSummary {
  queuePaused: boolean;
  queueRevision: number;
  pendingFollowUpCount: number;
  v2LastSeq: number;
}

export type MobileV2DeliveryKind = 'normal' | 'steer' | 'follow_up';
export type MobileV2DeliveryStatus = 'pending' | 'delivered' | 'not_delivered';
export type MobileV2PendingInputKind = 'steer' | 'follow_up';
export type MobileV2PendingInputState =
  | 'queued'
  | 'delivering'
  | 'delivered'
  | 'removed'
  | 'failed';

export interface MobileV2ConversationMessage extends ConversationMessage {
  runId: string;
  segmentIndex: number;
  deliveryKind: MobileV2DeliveryKind;
  deliveryStatus?: MobileV2DeliveryStatus;
}

export interface MobileV2PendingInput {
  inputId: string;
  kind: MobileV2PendingInputKind;
  targetTurnId?: string;
  text: string;
  images?: MobileImage[];
  state: MobileV2PendingInputState;
  revision: number;
  enqueueOrder: number;
  runId?: string;
  segmentTurnId?: string;
  userMessageId?: string;
  assistantMessageId?: string;
  failureCode?: MobileApiErrorCode;
  failureMessage?: string;
  createdAt: string;
  updatedAt: string;
  deliveredAt?: string;
}

export interface MobileV2ConversationBootstrap {
  conversation: MobileV2ConversationSummary;
  messages: MobileV2ConversationMessage[];
  nextCursor: string | null;
  pendingInputs: MobileV2PendingInput[];
  queuePaused: boolean;
  queueRevision: number;
  v2ThroughSeq: number;
}

export type MobileV2WsClientFrame =
  | { type: 'hello'; contractVersion: 2; capabilities: string[] }
  | {
      type: 'subscribe_conversation';
      id: string;
      agentId: string;
      conversationId: string;
      sinceV2Seq: number;
    }
  | (Omit<Extract<MobileWsClientFrame, { type: 'message' }>, 'streamingBehavior'> & {
      resumable: true;
    })
  | {
      type: 'enqueue_input';
      id: string;
      inputId: string;
      agentId: string;
      channelId: string;
      conversationId: string;
      text: string;
      images?: MobileImage[];
      behavior: 'steer' | 'followUp';
      expectedActiveTurnId?: string;
    }
  | {
      type: 'edit_follow_up';
      id: string;
      conversationId: string;
      inputId: string;
      expectedRevision: number;
      text: string;
      images?: MobileImage[];
    }
  | {
      type: 'remove_follow_up';
      id: string;
      conversationId: string;
      inputId: string;
      expectedRevision: number;
    }
  | {
      type: 'resume_follow_ups';
      id: string;
      conversationId: string;
      expectedQueueRevision: number;
    }
  | Extract<MobileWsClientFrame, { type: 'answer' | 'cancel' }>;

export type MobileV2ControlFrame =
  | { type: 'hello_ack'; contractVersion: 2; capabilities: string[] }
  | {
      type: 'conversation_subscribed';
      id: string;
      conversationId: string;
      v2ThroughSeq: number;
    }
  | {
      type: 'command_rejected';
      id: string;
      conversationId?: string;
      code: MobileApiErrorCode;
      error: string;
      retryable: boolean;
      details?: Record<string, unknown>;
    };

interface MobileV2RunFrameBase {
  id: string;
  conversationId: string;
  runId: string;
  segmentTurnId: string;
  v2Seq: number;
}

interface MobileV2InputFrameBase {
  id: string;
  conversationId: string;
  v2Seq: number;
  queueRevision: number;
  input: MobileV2PendingInput;
}

export type MobileV2SequencedFrame =
  | (MobileV2RunFrameBase & {
      type: 'accepted';
      userMessageId: string;
      assistantMessageId: string;
      revision: number;
    })
  | (MobileV2RunFrameBase & { type: 'event'; event: MobileAgentEvent })
  | (MobileV2RunFrameBase & {
      type: 'done';
      outcome: 'completed' | 'cancelled' | 'interrupted';
    })
  | (MobileV2RunFrameBase & {
      type: 'error';
      error: string;
      code?: MobileApiErrorCode;
      retryable?: boolean;
    })
  | (MobileV2InputFrameBase & { type: 'input_accepted' })
  | (MobileV2InputFrameBase & { type: 'input_updated' })
  | (MobileV2InputFrameBase & { type: 'input_removed' })
  | (MobileV2InputFrameBase & { type: 'input_failed' })
  | (MobileV2InputFrameBase & {
      type: 'input_delivered';
      runId: string;
      segmentTurnId: string;
      userMessageId: string;
      assistantMessageId: string;
    })
  | {
      type: 'queue_paused';
      id?: string;
      conversationId: string;
      v2Seq: number;
      queueRevision: number;
      queuePaused: boolean;
      pendingFollowUpCount: number;
    }
  | {
      type: 'queue_resumed';
      id?: string;
      conversationId: string;
      v2Seq: number;
      queueRevision: number;
      queuePaused: boolean;
      pendingFollowUpCount: number;
    };

export type MobileV2WsServerFrame = MobileV2ControlFrame | MobileV2SequencedFrame;
