import type {
  ConversationSummary,
  MobileWsClientFrame,
  MobileWsServerFrame,
} from '@dash/mobile-contract';
import type { AgentChatCoordinator } from './agent-chat-coordinator.js';
import type { ConversationAutoTitleService } from './conversation-auto-title.js';
import {
  type AcceptedTurn,
  type ConversationService,
  ConversationServiceError,
  type PersistedTurnFrame,
} from './conversation-service.js';
import type { EventLogEntry } from './event-log-store.js';

export type ResumableSendFrame = Extract<MobileWsClientFrame, { type: 'message' }> & {
  resumable: true;
};
export type ResumeFrame = Extract<MobileWsClientFrame, { type: 'resume' }>;

export interface TurnFrameSink {
  send(frame: MobileWsServerFrame): void;
}

export interface ResumableChatHubOptions {
  conversations: ConversationService;
  agents: AgentChatCoordinator;
  autoTitle: ConversationAutoTitleService;
  swarmCoordinator?: { cancelTurn(agentId: string, conversationId: string): boolean };
  onChanged?(summary: ConversationSummary): void;
}

export interface ResumableChatHub {
  start(frame: ResumableSendFrame, sink: TurnFrameSink): void;
  resume(frame: ResumeFrame, sink: TurnFrameSink): void;
  answer(turnId: string, questionId: string, answer: string): Promise<void>;
  cancel(turnId: string, sink: TurnFrameSink): Promise<void>;
  detach(sink: TurnFrameSink): void;
  cancelAgent(agentId: string): Promise<void>;
  allowAgent(agentId: string): void;
  stop(): Promise<void>;
}

interface LiveTurn {
  turnId: string;
  agentId: string;
  conversationId: string;
  controller: AbortController;
  subscribers: Set<TurnFrameSink>;
  cancelled: boolean;
  terminal: boolean;
  promise: Promise<void>;
}

function frameFromEntry(entry: EventLogEntry): MobileWsServerFrame {
  const common = { id: entry.msgId, conversationId: entry.conversationId, seq: entry.seq };
  switch (entry.payload.type) {
    case 'accepted':
      return {
        type: 'accepted',
        ...common,
        userMessageId: entry.payload.userMessageId,
        assistantMessageId: entry.payload.assistantMessageId,
        revision: entry.payload.revision,
      };
    case 'event':
      return { type: 'event', ...common, event: entry.payload.event };
    case 'done':
      return { type: 'done', ...common, outcome: entry.payload.outcome ?? 'completed' };
    case 'error':
      return {
        type: 'error',
        ...common,
        error: entry.payload.error,
        code: entry.payload.code,
        retryable: entry.payload.retryable,
      };
  }
}

function frameFromPersisted(live: LiveTurn, persisted: PersistedTurnFrame): MobileWsServerFrame {
  return frameFromEntry({
    seq: persisted.seq,
    msgId: live.turnId,
    agentId: live.agentId,
    conversationId: live.conversationId,
    timestamp: '',
    payload: persisted.payload,
  });
}

function frameFromAccepted(frame: ResumableSendFrame, accepted: AcceptedTurn): MobileWsServerFrame {
  return {
    type: 'accepted',
    id: frame.id,
    conversationId: frame.conversationId,
    userMessageId: accepted.userMessage.id,
    assistantMessageId: accepted.assistantMessage.id,
    revision: accepted.revision,
    seq: accepted.seq,
  };
}

export function createResumableChatHub(options: ResumableChatHubOptions): ResumableChatHub {
  const { conversations, agents } = options;
  const turns = new Map<string, LiveTurn>();
  const quiescingAgents = new Set<string>();
  let stopped = false;

  const assertAccepting = (): void => {
    if (stopped) throw new Error('Resumable chat hub is stopped');
  };

  const assertAgentAccepting = (agentId: string): void => {
    assertAccepting();
    if (quiescingAgents.has(agentId)) {
      throw new ConversationServiceError(
        'conversation_busy',
        `Agent ${agentId} is not accepting new turns`,
        409,
        true,
      );
    }
  };

  const send = (sink: TurnFrameSink, frame: MobileWsServerFrame): boolean => {
    try {
      sink.send(frame);
      return true;
    } catch {
      return false;
    }
  };

  const broadcast = (live: LiveTurn, frame: MobileWsServerFrame): void => {
    for (const sink of live.subscribers) {
      if (!send(sink, frame)) live.subscribers.delete(sink);
    }
  };

  const replay = (
    agentId: string,
    conversationId: string,
    sinceSeq: number,
    sink: TurnFrameSink,
  ): boolean => {
    for (const entry of conversations.eventLog.readSince(agentId, conversationId, sinceSeq)) {
      if (!send(sink, frameFromEntry(entry))) return false;
    }
    return true;
  };

  const attachIfLive = (
    turnId: string,
    agentId: string,
    conversationId: string,
    sink: TurnFrameSink,
  ): void => {
    const conversation = conversations.get(conversationId);
    const live = turns.get(turnId);
    if (
      conversation?.activeTurnId === turnId &&
      live?.agentId === agentId &&
      live.conversationId === conversationId
    ) {
      live.subscribers.add(sink);
    }
  };

  const finish = (live: LiveTurn, outcome: 'completed' | 'cancelled'): PersistedTurnFrame => {
    const persisted = conversations.finishTurn({
      conversationId: live.conversationId,
      turnId: live.turnId,
      outcome,
    });
    live.terminal = true;
    broadcast(live, frameFromPersisted(live, persisted));
    options.onChanged?.(persisted.conversation);
    return persisted;
  };

  const runTurn = async (live: LiveTurn, frame: ResumableSendFrame): Promise<void> => {
    let stream: ReturnType<AgentChatCoordinator['chat']> | undefined;
    try {
      stream = agents.chat({
        agentId: frame.agentId,
        conversationId: frame.conversationId,
        channelId: frame.channelId,
        text: frame.text,
        images: frame.images?.length
          ? frame.images.map((image) => ({ type: 'image' as const, ...image }))
          : undefined,
        messageId: frame.id,
        signal: live.controller.signal,
      });
      while (true) {
        const result = await stream.next();
        if (result.done) break;
        const event = result.value;
        if (event.type === 'error') throw event.error;
        const persisted = conversations.appendTurnEvent(live.conversationId, live.turnId, event);
        if (persisted) broadcast(live, frameFromPersisted(live, persisted));
      }
      if (!live.cancelled) finish(live, 'completed');
    } catch (error) {
      if (!live.cancelled) {
        const persisted = conversations.finishTurn({
          conversationId: live.conversationId,
          turnId: live.turnId,
          outcome: 'failed',
          error: error instanceof Error ? error.message : String(error),
          retryable: false,
        });
        live.terminal = true;
        broadcast(live, frameFromPersisted(live, persisted));
        options.onChanged?.(persisted.conversation);
      }
    } finally {
      try {
        if (stream) await stream.return(undefined);
      } finally {
        if (turns.get(live.turnId) === live) turns.delete(live.turnId);
      }
    }
  };

  const cancelLive = (live: LiveTurn, sink?: TurnFrameSink): void => {
    if (live.terminal) return;
    if (sink) live.subscribers.add(sink);
    if (live.cancelled) return;
    finish(live, 'cancelled');
    live.cancelled = true;
    live.controller.abort();
    agents.cancel(live.agentId, live.conversationId);
    options.swarmCoordinator?.cancelTurn(live.agentId, live.conversationId);
  };

  const hub: ResumableChatHub = {
    start(frame, sink) {
      assertAgentAccepting(frame.agentId);
      const accepted = conversations.acceptTurn({
        agentId: frame.agentId,
        conversationId: frame.conversationId,
        turnId: frame.id,
        text: frame.text,
        images: frame.images,
      });
      const acceptedSent = send(sink, frameFromAccepted(frame, accepted));

      if (!accepted.created) {
        if (acceptedSent && replay(frame.agentId, frame.conversationId, accepted.seq, sink)) {
          attachIfLive(frame.id, frame.agentId, frame.conversationId, sink);
        }
        return;
      }

      const live: LiveTurn = {
        turnId: frame.id,
        agentId: frame.agentId,
        conversationId: frame.conversationId,
        controller: new AbortController(),
        subscribers: new Set(acceptedSent ? [sink] : []),
        cancelled: false,
        terminal: false,
        promise: Promise.resolve(),
      };
      turns.set(frame.id, live);
      if (accepted.firstUserMessage) {
        options.autoTitle.schedule({
          conversationId: frame.conversationId,
          agentId: frame.agentId,
          text: frame.text,
        });
      }
      options.onChanged?.(accepted.conversation);
      live.promise = runTurn(live, frame);
      void live.promise.catch(() => {});
    },

    resume(frame, sink) {
      assertAccepting();
      const conversation = conversations.get(frame.conversationId);
      if (!conversation || conversation.agentId !== frame.agentId) {
        throw new ConversationServiceError('not_found', 'Conversation not found', 404, false);
      }
      if (!replay(frame.agentId, frame.conversationId, frame.sinceSeq, sink)) return;
      attachIfLive(frame.id, frame.agentId, frame.conversationId, sink);
    },

    async answer(turnId, questionId, answer) {
      assertAccepting();
      const live = turns.get(turnId);
      if (!live || live.terminal) {
        throw new ConversationServiceError('not_found', `Turn ${turnId} is not live`, 404, false);
      }
      await agents.answerQuestion(live.agentId, live.conversationId, questionId, answer);
    },

    async cancel(turnId, sink) {
      assertAccepting();
      const live = turns.get(turnId);
      if (live) cancelLive(live, sink);
    },

    detach(sink) {
      for (const live of turns.values()) live.subscribers.delete(sink);
    },

    async cancelAgent(agentId) {
      quiescingAgents.add(agentId);
      const matching = [...turns.values()].filter((live) => live.agentId === agentId);
      for (const live of matching) cancelLive(live);
      await Promise.all(matching.map((live) => live.promise));
    },

    allowAgent(agentId) {
      quiescingAgents.delete(agentId);
    },

    async stop() {
      stopped = true;
      const active = [...turns.values()];
      for (const live of active) cancelLive(live);
      await Promise.all(active.map((live) => live.promise));
    },
  };

  return hub;
}
