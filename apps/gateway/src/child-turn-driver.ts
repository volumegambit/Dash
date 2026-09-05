import type { AgentEvent } from '@dash/agent';
import type { ConversationSummary, SubagentInfo, SubagentStatus } from '@dash/mobile-contract';
import type {
  ChildConversationInput,
  ChildInfo,
  ChildSnapshot,
  ChildSpec,
  ChildTurnDriver,
  ChildTurnOutcome,
  ChildTurnRef,
  WorkerStatus,
} from '@dash/swarm';
import { ChildTurnStartError } from '@dash/swarm';
import { type ConversationService, ConversationServiceError } from './conversation-service.js';
import type { ResumableChatHub } from './resumable-chat-hub.js';
import { grantFromSpec } from './subagent-resume.js';

export interface ChildTurnDriverOptions {
  conversations: ConversationService;
  /** Late-bound: the hub is constructed after the coordinator that uses it. */
  hub: () => ResumableChatHub | undefined;
  /** Where a child that could not be persisted is reported. */
  warn?(message: string): void;
}

/**
 * The gateway's {@link ChildTurnDriver}: a child is a REAL conversation
 * (`kind: 'subagent'`) whose turns run through the same `ResumableChatHub` as a
 * user's, so it persists with `seq`, replays, survives a restart, and can later
 * be resumed (design §7.1, §7.4).
 *
 * Everything the coordinator needs back — the child's events, its completion —
 * arrives through a single hub turn observer, filtered to child conversations.
 */
export function createChildTurnDriver(options: ChildTurnDriverOptions): ChildTurnDriver & {
  /** Wire the hub observer. Returns a disposer. */
  attachObserver(): () => void;
} {
  const { conversations } = options;
  const specs = new Map<string, ChildSpec>();
  const eventListeners = new Set<(turn: ChildTurnRef, event: AgentEvent) => void>();
  const finishListeners = new Set<
    (turn: ChildTurnRef, outcome: ChildTurnOutcome, error?: string) => void
  >();

  const isChild = (conversationId: string): boolean => specs.has(conversationId);

  const driver: ChildTurnDriver & { attachObserver(): () => void } = {
    prepareChild(spec: ChildSpec): void {
      specs.set(spec.childConversationId, spec);
    },

    createChild(input: ChildConversationInput): void {
      conversations.createSubagent({
        id: input.id,
        agentId: input.agentId,
        agentName: input.agentName,
        parentConversationId: input.parentConversationId,
        parentTurnId: input.parentTurnId,
        title: input.title,
        subagent: toSubagentInfo(input.subagent),
      });
      // The child's GRANT, beside the row rather than in it: `subagent_meta` is
      // the mobile contract's user-visible half and carries no tool or MCP
      // field, so without this a resume has nothing to rebuild a spec from
      // (design §5.2). Written on the idempotent create a RESUME performs too,
      // so a grant narrowed by the parent's current config replaces the stored
      // one instead of drifting behind it.
      const spec = specs.get(input.id);
      if (spec) conversations.putSubagentGrant(input.id, grantFromSpec(spec));
    },

    startTurn({ agentId, conversationId, text }): { turnId: string } {
      const hub = options.hub();
      if (!hub) {
        throw new ChildTurnStartError('stopped', 'the gateway chat hub is not running');
      }
      try {
        return hub.startSystemTurn({ agentId, conversationId, text, origin: 'parent' });
      } catch (err) {
        // TWO shapes reach here and they mean different things. `acceptTurn`
        // throws a typed `conversation_busy` when the child already holds a
        // turn lease — retryable. A STOPPED hub throws a BARE `Error`
        // ("Resumable chat hub is stopped"), which is terminal; classifying it
        // as busy would have the caller wait for a lease that will never free.
        if (err instanceof ConversationServiceError) {
          const reason = err.code === 'conversation_busy' ? 'busy' : 'error';
          throw new ChildTurnStartError(reason, err.message);
        }
        throw new ChildTurnStartError('stopped', err instanceof Error ? err.message : String(err));
      }
    },

    async cancelTurn(_agentId: string, conversationId: string): Promise<void> {
      const hub = options.hub();
      const turnId = conversations.get(conversationId, { includeDeleted: true })?.activeTurnId;
      if (!hub || !turnId) return;
      // The hub's cancel needs a sink to catch up; a child turn has none.
      await hub.cancel(turnId, { send: () => {} });
    },

    updateChild(id: string, patch: { status?: WorkerStatus; info?: Partial<ChildInfo> }): void {
      try {
        const status = persistedStatus(patch.status);
        conversations.updateSubagent(id, {
          ...(status ? { status } : {}),
          ...(patch.info ? { info: patch.info as Partial<SubagentInfo> } : {}),
        });
      } catch (err) {
        // A cascading parent delete removes the row mid-turn. The child stops
        // on its next liveness poll; losing its tombstone is not worth
        // breaking a terminal transition over.
        options.warn?.(
          `[subagents] could not update child ${id}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },

    listChildren(parentConversationId: string): ChildSnapshot[] {
      return conversations
        .listSubagents(parentConversationId)
        .map((row) => toChildSnapshot(row))
        .filter((row): row is ChildSnapshot => row !== undefined);
    },

    isChildAlive(childConversationId: string): boolean {
      const row = conversations.get(childConversationId);
      return row !== null && row.status !== 'deleted';
    },

    workspaceOf(childConversationId: string): string | undefined {
      return conversations.get(childConversationId)?.subagent?.workspace;
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

    releaseChild(childConversationId: string): void {
      // Only the resolved SPEC is dropped. The child's warm pool entry is left
      // to the pool's own LRU (design §7.1: "idle children are LRU-evictable"),
      // and its conversation is never touched — a finished child's transcript
      // stays addressable, which is the whole point of children being
      // conversations.
      specs.delete(childConversationId);
    },

    attachObserver(): () => void {
      const hub = options.hub();
      if (!hub) return () => {};
      return hub.addObserver({
        onEvent(turn, event) {
          if (!isChild(turn.conversationId)) return;
          for (const listener of [...eventListeners]) listener(turn, event);
        },
        onFinish(turn, outcome, error) {
          if (!isChild(turn.conversationId)) return;
          for (const listener of [...finishListeners]) listener(turn, outcome, error);
        },
      });
    },
  };

  return driver;
}

/**
 * `WorkerStatus` → the persisted `SubagentStatus`. The swarm's `'spawning'` has
 * no row-level meaning (a row exists only from the moment the child starts), so
 * it maps to nothing rather than being invented as a new persisted state.
 */
function persistedStatus(status: WorkerStatus | undefined): SubagentStatus | undefined {
  if (status === undefined || status === 'spawning') return undefined;
  return status;
}

/** `ChildInfo` (swarm's structural copy) → the contract's `SubagentInfo`. */
function toSubagentInfo(info: ChildInfo): SubagentInfo {
  return {
    type: info.type,
    ...(info.name !== undefined ? { name: info.name } : {}),
    // `spawning` is an in-memory pre-start state with no persisted meaning:
    // the row exists only once the child is created, which is when it runs.
    status: persistedStatus(info.status) ?? 'running',
    description: info.description,
    prompt: info.prompt,
    model: info.model,
    background: info.background,
    ...(info.isolation !== undefined ? { isolation: info.isolation } : {}),
    depth: info.depth,
    startedAt: info.startedAt,
    ...(info.endedAt !== undefined ? { endedAt: info.endedAt } : {}),
    ...(info.usage !== undefined ? { usage: info.usage } : {}),
    toolCallCount: info.toolCallCount,
    ...(info.report !== undefined ? { report: info.report } : {}),
    oneShot: info.oneShot,
    ...(info.workspace !== undefined ? { workspace: info.workspace } : {}),
  };
}

/**
 * A persisted child row → the snapshot the tools read. `brief`/`role` come from
 * the same two fields the spawn wrote, so a child listed from the store reads
 * the same as one this process still holds a handle for.
 */
export function toChildSnapshot(row: ConversationSummary): ChildSnapshot | undefined {
  const info = row.subagent;
  if (!info || !row.parentConversationId) return undefined;
  return {
    subagentId: row.id,
    workerId: row.id,
    parentConversationId: row.parentConversationId,
    parentTurnId: row.parentTurnId ?? '',
    role: info.name ?? info.type,
    status: info.status,
    brief: info.prompt,
    model: info.model,
    ...(info.report !== undefined ? { report: info.report } : {}),
    usage: info.usage ?? { inputTokens: 0, outputTokens: 0 },
    startedAt: Date.parse(info.startedAt) || undefined,
    endedAt: info.endedAt ? Date.parse(info.endedAt) || undefined : undefined,
    subagentType: info.type,
    description: info.description,
    ...(info.name !== undefined ? { name: info.name } : {}),
    toolCallCount: info.toolCallCount,
    background: info.background,
    oneShot: info.oneShot,
    depth: info.depth,
    ...(info.workspace !== undefined ? { workspace: info.workspace } : {}),
  };
}
