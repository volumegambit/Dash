import type { AgentEvent } from '@dash/agent';
import type {
  ChildConversationInput,
  ChildInfo,
  ChildSnapshot,
  ChildSpec,
  ChildTurnDriver,
  ChildTurnOutcome,
  ChildTurnRef,
  WorkerBackend,
  WorkerFactory,
  WorkerStatus,
} from './types.js';

interface ChildEntry {
  spec: ChildSpec;
  info?: ChildInfo;
  alive: boolean;
  backendPromise?: Promise<WorkerBackend>;
  backend?: WorkerBackend;
  /** Turn ids abandoned by `cancelTurn`; their event loops stop yielding. */
  cancelled: Set<string>;
  turnSeq: number;
}

/**
 * A {@link ChildTurnDriver} that runs children as in-process
 * {@link WorkerBackend}s — the pre-Phase-C transport, kept behind the driver
 * seam so the coordinator has exactly ONE child lifetime.
 *
 * The gateway does not use this: it wires a driver over `ResumableChatHub` and
 * `ConversationService`, so a real child is a real conversation. This exists
 * for embedders (and the swarm package's own tests) that have a
 * {@link WorkerFactory} and no conversation store, and is retired with the
 * factory itself in Task C4.
 *
 * It is a TRANSPORT only. Status, caps, steers, the report and every terminal
 * transition live in `ChildHandle`, identically for both drivers.
 */
export function createInProcessChildDriver(factory: WorkerFactory): ChildTurnDriver {
  const entries = new Map<string, ChildEntry>();
  const eventListeners = new Set<(turn: ChildTurnRef, event: AgentEvent) => void>();
  const finishListeners = new Set<
    (turn: ChildTurnRef, outcome: ChildTurnOutcome, error?: string) => void
  >();

  const emitEvent = (turn: ChildTurnRef, event: AgentEvent): void => {
    for (const listener of [...eventListeners]) listener(turn, event);
  };
  const emitFinish = (turn: ChildTurnRef, outcome: ChildTurnOutcome, error?: string): void => {
    for (const listener of [...finishListeners]) listener(turn, outcome, error);
  };

  const runTurn = async (entry: ChildEntry, turn: ChildTurnRef, text: string): Promise<void> => {
    let backend: WorkerBackend;
    try {
      entry.backendPromise ??= factory(entry.spec);
      backend = await entry.backendPromise;
    } catch (err) {
      // Surfaced as an `error` EVENT (not just a failed outcome) so the handle
      // reports the construction failure's message verbatim, exactly as the
      // pre-driver `WorkerHandle` did.
      const error = err instanceof Error ? err : new Error(String(err));
      emitEvent(turn, { type: 'error', error });
      emitFinish(turn, 'failed', error.message);
      return;
    }
    entry.backend = backend;
    if (entry.cancelled.has(turn.turnId)) {
      emitFinish(turn, 'cancelled');
      return;
    }
    try {
      for await (const event of backend.chat(text)) {
        if (entry.cancelled.has(turn.turnId)) {
          emitFinish(turn, 'cancelled');
          return;
        }
        emitEvent(turn, event);
      }
    } catch (err) {
      emitFinish(turn, 'failed', err instanceof Error ? err.message : String(err));
      return;
    }
    if (entry.cancelled.has(turn.turnId)) {
      emitFinish(turn, 'cancelled');
      return;
    }
    emitFinish(turn, 'completed');
  };

  return {
    prepareChild(spec: ChildSpec): void {
      entries.set(spec.childConversationId, {
        spec,
        alive: true,
        cancelled: new Set(),
        turnSeq: 0,
      });
    },

    createChild(input: ChildConversationInput): void {
      const entry = entries.get(input.id);
      if (!entry) throw new Error(`no prepared child ${input.id}`);
      entry.info = input.subagent;
    },

    startTurn({ agentId, conversationId, text }): { turnId: string } {
      const entry = entries.get(conversationId);
      if (!entry) throw new Error(`no prepared child ${conversationId}`);
      const turnId = `${conversationId}#${++entry.turnSeq}`;
      const turn: ChildTurnRef = { agentId, conversationId, turnId };
      void runTurn(entry, turn, text);
      return { turnId };
    },

    cancelTurn(_agentId: string, conversationId: string): Promise<void> {
      const entry = entries.get(conversationId);
      if (!entry) return Promise.resolve();
      entry.cancelled.add(`${conversationId}#${entry.turnSeq}`);
      entry.backend?.abort();
      // Never awaited by the caller's cancel path — the handle races it against
      // its own grace period, so a `stop()` that hangs delays cleanup instead
      // of blocking the terminal transition.
      return entry.backend?.stop().catch(() => {}) ?? Promise.resolve();
    },

    updateChild(id: string, patch: { status?: WorkerStatus; info?: Partial<ChildInfo> }): void {
      const entry = entries.get(id);
      if (!entry?.info) return;
      entry.info = {
        ...entry.info,
        ...patch.info,
        ...(patch.status ? { status: patch.status } : {}),
      };
    },

    /**
     * Always empty: this driver has no store behind it, so every child it knows
     * about is one the coordinator still holds a live handle for. Cross-turn
     * and cross-restart resolution is the conversation-backed driver's job.
     */
    listChildren(): ChildSnapshot[] {
      return [];
    },

    isChildAlive(childConversationId: string): boolean {
      return entries.get(childConversationId)?.alive ?? false;
    },

    workspaceOf(childConversationId: string): string | undefined {
      // The BACKEND's workspace only. An isolated child's checkout is minted by
      // the factory, so before the backend resolves the honest answer is "not
      // known yet" rather than the parent's directory.
      return entries.get(childConversationId)?.backend?.workspace;
    },

    onEvent(listener) {
      eventListeners.add(listener);
      return () => {
        eventListeners.delete(listener);
      };
    },

    onFinish(listener) {
      finishListeners.add(listener);
      return () => {
        finishListeners.delete(listener);
      };
    },
  };
}
