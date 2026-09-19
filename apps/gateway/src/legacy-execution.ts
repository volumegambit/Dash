import type { AgentEvent } from '@dash/agent';
import type { AgentChatCoordinator, ChatRequest } from './agent-chat-coordinator.js';
import { ConversationServiceError } from './conversation-service.js';

type LegacyRuntime = Pick<
  AgentChatCoordinator,
  'chat' | 'cancel' | 'answerQuestion' | 'steer' | 'followUp'
>;

export interface LegacyExecution extends LegacyRuntime {
  hasActiveTurn(agentId: string, conversationId: string): boolean;
  ownsTurn(agentId: string, conversationId: string, signal: AbortSignal): boolean;
  cancelAgent(agentId: string): Promise<void>;
  stop(): Promise<void>;
}

export interface LegacyExecutionOptions {
  agents: LegacyRuntime;
  swarmCoordinator?: { cancelTurn(agentId: string, conversationId: string): boolean };
  assertAccepting(agentId: string): void;
  hasCanonicalTurn(agentId: string, conversationId: string): boolean;
}

interface LegacyTurn {
  agentId: string;
  callerSignal?: AbortSignal;
  cancelled: boolean;
  settled: Promise<void>;
  close(value?: unknown): Promise<IteratorResult<AgentEvent>>;
}

/** Owns legacy provider streams without creating canonical conversation history. */
export function createLegacyExecution(options: LegacyExecutionOptions): LegacyExecution {
  const turns = new Map<string, LegacyTurn>();
  let stopped = false;
  const keyFor = (agentId: string, conversationId: string) =>
    JSON.stringify([agentId, conversationId]);
  const assertAccepting = (agentId: string) => {
    if (stopped) throw new Error('Legacy execution is stopped');
    options.assertAccepting(agentId);
  };
  const assertActive = (agentId: string, conversationId: string) => {
    assertAccepting(agentId);
    const turn = turns.get(keyFor(agentId, conversationId));
    if (!turn || turn.cancelled) throw new Error('No active legacy conversation');
  };
  const closeTurns = async (selected: LegacyTurn[]) => {
    // Every stream receives cancellation before waiting for any one provider.
    for (const turn of selected) void turn.close().catch(() => {});
    await Promise.all(selected.map((turn) => turn.settled));
  };

  return {
    chat(request: ChatRequest): AsyncGenerator<AgentEvent> {
      const key = keyFor(request.agentId, request.conversationId);
      let turn: LegacyTurn | undefined;
      let closing: Promise<IteratorResult<AgentEvent>> | undefined;
      const controller = new AbortController();
      const onAbort = () => {
        void turn?.close().catch(() => {});
      };
      const stream = (async function* (): AsyncGenerator<AgentEvent> {
        assertAccepting(request.agentId);
        if (request.signal?.aborted) return;
        if (turns.has(key) || options.hasCanonicalTurn(request.agentId, request.conversationId)) {
          throw new ConversationServiceError(
            'conversation_busy',
            'Conversation already has an active turn.',
            409,
            true,
          );
        }
        let settle!: () => void;
        turn = {
          agentId: request.agentId,
          callerSignal: request.signal,
          cancelled: false,
          settled: new Promise<void>((resolve) => {
            settle = resolve;
          }),
          close(value) {
            if (closing) return closing;
            if (turns.get(key) !== turn) return rawReturn(value);
            // Install the close promise before abort callbacks can re-enter us.
            let resolveClose!: (result: IteratorResult<AgentEvent>) => void;
            let rejectClose!: (error: unknown) => void;
            closing = new Promise((resolve, reject) => {
              resolveClose = resolve;
              rejectClose = reject;
            });
            // Owner-triggered closes may have no consumer awaiting their result.
            void closing.catch(() => {});
            this.cancelled = true;
            let cancellationError: unknown;
            try {
              options.agents.cancel(request.agentId, request.conversationId);
            } catch (error) {
              cancellationError = error;
            }
            try {
              options.swarmCoordinator?.cancelTurn(request.agentId, request.conversationId);
            } catch (error) {
              cancellationError ??= error;
            }
            controller.abort(request.signal?.reason);
            // Native generators queue return behind an outstanding next. Abort
            // above releases that next; this promise retains the admission fence
            // through the provider's asynchronous finally block, even if the
            // consumer is paused at a yield or has disappeared entirely.
            void (async () => {
              let result = await rawReturn(value);
              // A provider may yield from finally. Finish its cleanup even when
              // the departed consumer cannot request those remaining events.
              while (!result.done) result = await rawNext();
              if (cancellationError !== undefined) throw cancellationError;
              return result;
            })().then(resolveClose, rejectClose);
            return closing;
          },
        };
        turns.set(key, turn);
        request.signal?.addEventListener('abort', onAbort, { once: true });
        try {
          yield* options.agents.chat({ ...request, signal: controller.signal });
        } finally {
          request.signal?.removeEventListener('abort', onAbort);
          if (turns.get(key) === turn) turns.delete(key);
          settle();
        }
      })();
      const rawNext = stream.next.bind(stream);
      const rawReturn = stream.return.bind(stream);
      // A native async-generator return cannot interrupt a pending next on its
      // own. Signal cancellation synchronously before queuing that return.
      stream.return = (value) => turn?.close(value) ?? rawReturn(value);
      return stream;
    },
    hasActiveTurn(agentId, conversationId) {
      return turns.has(keyFor(agentId, conversationId));
    },
    ownsTurn(agentId, conversationId, signal) {
      const turn = turns.get(keyFor(agentId, conversationId));
      return !!turn && !turn.cancelled && turn.callerSignal === signal;
    },
    cancel(agentId, conversationId) {
      const turn = turns.get(keyFor(agentId, conversationId));
      if (!turn) return false;
      void turn.close().catch(() => {});
      return true;
    },
    async answerQuestion(agentId, conversationId, questionId, answer) {
      assertActive(agentId, conversationId);
      await options.agents.answerQuestion(agentId, conversationId, questionId, answer);
    },
    async steer(agentId, conversationId, text, images) {
      assertActive(agentId, conversationId);
      await options.agents.steer(agentId, conversationId, text, images);
    },
    async followUp(agentId, conversationId, text, images) {
      assertActive(agentId, conversationId);
      await options.agents.followUp(agentId, conversationId, text, images);
    },
    async cancelAgent(agentId) {
      await closeTurns([...turns.values()].filter((turn) => turn.agentId === agentId));
    },
    async stop() {
      stopped = true;
      await closeTurns([...turns.values()]);
    },
  };
}
