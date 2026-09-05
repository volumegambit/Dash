import type { AgentEvent } from '@dash/agent';
import type {
  ChildConversationInput,
  ChildInfo,
  ChildSnapshot,
  ChildSpec,
  ChildTurnDriver,
  ChildTurnOutcome,
  ChildTurnRef,
  WorkerSpec,
  WorkerStatus,
} from './types.js';

/**
 * TEST SUPPORT ONLY — deliberately NOT exported from `src/index.ts`.
 *
 * The gateway runs a child as a real conversation over `ResumableChatHub` +
 * `ConversationService`, and that is now the ONLY {@link ChildTurnDriver} in
 * the product: Task C4 retired the in-process `WorkerFactory` / `WorkerHandle`
 * path so there are not two child lifetimes. What survives here is a fake
 * TRANSPORT for this package's own tests — status, caps, steers, the report and
 * every terminal transition still live in `ChildHandle`, so a test driving this
 * exercises the same state machine the gateway does.
 */

/** One conversational segment of a fake child. Duck-typed over DashAgent.chat. */
export interface WorkerBackend {
  chat(message: string): AsyncGenerator<AgentEvent>;
  abort(): void;
  stop(): Promise<void>;
  /** Where the child ran (an isolated child's own checkout). */
  workspace?: string;
}

export type WorkerFactory = (spec: WorkerSpec) => Promise<WorkerBackend>;

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

/** A fake conversation-less {@link ChildTurnDriver} over {@link WorkerBackend}s. */
export function createFakeChildDriver(factory: WorkerFactory): ChildTurnDriver & {
  /**
   * Rows a resumed / restarted child is read back from, standing in for the
   * conversation store. Empty by default, so a test that does not opt in sees
   * exactly the children the coordinator still holds handles for.
   */
  persisted: ChildSnapshot[];
} {
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
      // reports the construction failure's message verbatim.
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

  const persisted: ChildSnapshot[] = [];

  return {
    persisted,

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
     * Only what a test seeded into {@link persisted}: this driver has no store
     * behind it, so by default every child it knows about is one the
     * coordinator still holds a live handle for.
     */
    listChildren(parentConversationId: string): ChildSnapshot[] {
      return persisted.filter((row) => row.parentConversationId === parentConversationId);
    },

    isChildAlive(childConversationId: string): boolean {
      const entry = entries.get(childConversationId);
      if (entry) return entry.alive;
      // A resumable child with no live entry: alive iff a row says so.
      return persisted.some((row) => row.subagentId === childConversationId);
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
