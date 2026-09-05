import type { SubagentTypeResolver } from '@dash/swarm';
import type { SubagentDefinitionRegistry } from './subagent-definitions.js';

/**
 * The bridge between the definition REGISTRY (which rebuilds a roster) and the
 * WARM BACKENDS that are already advertising the old one.
 *
 * Two problems it solves, both invisible without it:
 *
 * 1. `registry.resolverFor()` is ASYNC and returns a snapshot. `createAgentTools`
 *    captures its `resolver` in a closure, so a resolver handed out at
 *    backend-creation time is frozen forever — a later `invalidate()` would
 *    build a fresh roster nobody reads. `resolverFor` here returns a DELEGATING
 *    resolver that reads a per-agent holder this module keeps current, so the
 *    tools see the new roster the moment the holder is swapped.
 * 2. The swap alone is not enough: pi's `AgentSession` froze `customTools` at
 *    `start()`, and `buildCustomTools` copied each tool's `parameters` BY VALUE
 *    while wrapping it. The rendered roster is only re-read when the backend
 *    rebuilds — hence `refreshCustomTools` on the coordinator. (`agent.parameters`
 *    is a GETTER for exactly this reason; a frozen object would silently re-push
 *    the stale roster.)
 *
 * TIMING: a refresh lands on the NEXT model turn. A turn already in flight keeps
 * the roster it started with.
 */
export interface SubagentRosterRefresher {
  /**
   * The resolver to hand `createSubagentExtraTools` for `agentId`. Delegates to
   * the latest build, so it never needs re-handing.
   */
  resolverFor(agentId: string): Promise<SubagentTypeResolver>;
  /**
   * Build every listed agent's roster now. Called at BOOT so the registry's
   * `allowedTypes` and roster-token-budget warnings reach the operator's log at
   * startup instead of at whatever hour the first chat happens to arrive.
   */
  prime(agentIds: string[]): Promise<void>;
  /**
   * Resolves when no refresh is in flight. `registry.onChange` listeners are
   * synchronous but the rebuild is async, so tests (and shutdown) need a join
   * point. Never rejects: a failed refresh is warned and swallowed, because a
   * roster rebuild must not take down the mutation that triggered it.
   */
  whenIdle(): Promise<void>;
  /** Detach the `onChange` listener. */
  dispose(): void;
}

export interface SubagentRosterRefresherOptions {
  registry: SubagentDefinitionRegistry;
  /** Pooled-backend refresh, keyed by the REGISTRY agent id (the pool's key). */
  refreshBackends: (agentId: string) => Promise<void>;
  /** Every known agent id — used when `invalidate()` names no agent. */
  listAgentIds: () => string[];
  warn: (message: string) => void;
}

export function createSubagentRosterRefresher(
  o: SubagentRosterRefresherOptions,
): SubagentRosterRefresher {
  /**
   * The live snapshot per agent. Keyed by registry id and kept for the process
   * lifetime: the delegating resolvers handed to warm backends read through it,
   * and a backend can outlive any single build. Bounded by the agent count.
   */
  const current = new Map<string, SubagentTypeResolver>();
  /** Serialises refreshes so two invalidations cannot interleave their builds. */
  let queue: Promise<void> = Promise.resolve();

  const rebuild = async (agentId: string): Promise<void> => {
    current.set(agentId, await o.registry.resolverFor(agentId));
  };

  const refresh = async (agentId: string | undefined): Promise<void> => {
    // `invalidate()` with no argument (a plugin hot-reload) dropped EVERY
    // agent's cache, so every agent's holder is stale. Agents with no holder
    // yet have no warm backend to refresh either, so the registry list is the
    // right set to walk: it also re-primes the budget warnings on reload.
    const ids = agentId === undefined ? o.listAgentIds() : [agentId];
    // `DELETE /agents/:id` invalidates too, and the agent is already gone by
    // then. Rebuilding would log "unknown agent id" on every delete and cache a
    // built-ins-only roster for an id that no longer exists; drop the holder
    // instead. Checked against the LIVE list, not the holder map, so an agent
    // registered after boot is still rebuilt.
    const known = new Set(o.listAgentIds());
    for (const id of ids) {
      if (!known.has(id)) {
        current.delete(id);
        continue;
      }
      try {
        await rebuild(id);
        await o.refreshBackends(id);
      } catch (err) {
        o.warn(`[subagents] roster refresh failed for agent "${id}": ${(err as Error).message}`);
      }
    }
  };

  const unsubscribe = o.registry.onChange((agentId) => {
    // Listeners are invoked synchronously from `invalidate()`; chain the async
    // rebuild onto the queue so the mutation that triggered it never waits and
    // never sees a rejection.
    queue = queue.then(() => refresh(agentId));
  });

  return {
    async resolverFor(agentId) {
      await rebuild(agentId);
      return {
        // Read the holder on EVERY call, never capture it: this object is what
        // the `agent` tool's roster getter closes over for the backend's life.
        list: () => current.get(agentId)?.list() ?? [],
        resolve: (type) => current.get(agentId)?.resolve(type),
      };
    },
    async prime(agentIds) {
      for (const id of agentIds) {
        try {
          await rebuild(id);
        } catch (err) {
          o.warn(`[subagents] roster build failed for agent "${id}": ${(err as Error).message}`);
        }
      }
    },
    whenIdle() {
      return queue;
    },
    dispose() {
      unsubscribe();
    },
  };
}
