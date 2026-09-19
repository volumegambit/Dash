import type { RunSnapshot, RunSummary, SwarmCoordinator } from '@dash/swarm';
import type { Hono } from 'hono';

import type { AgentRegistry } from './agent-registry.js';
import type { ConversationService } from './conversation-service.js';

/**
 * How many of an agent's child conversations the panel walks back through to
 * find the parents of past runs. The panel shows recent runs, and every row
 * read parses that child's `subagent_meta`; an agent that has been delegating
 * for months would otherwise scan its whole history on every panel open.
 */
const MAX_SCANNED_CHILDREN = 200;

export interface SwarmManagementDeps {
  swarmCoordinator: SwarmCoordinator;
  agentRegistry: AgentRegistry;
  /**
   * Where the panel finds runs from BEFORE this process started. Optional so
   * embedders that wire a coordinator but no store still get live runs.
   */
  conversations?: Pick<ConversationService, 'list'>;
}

/**
 * Mounts the swarm panel management routes onto an already-authed Hono app.
 * Called from `management-api.ts` behind the bearer middleware, and only when a
 * `swarmCoordinator` was wired (so tests/embedders that skip swarm still
 * construct the app). Mirrors the `eventLogStore` replay-route mount pattern.
 *
 * A RUN IS NOW A VIEW, NOT A MEMORY (design §7.7). The coordinator used to keep
 * a 20-deep ring buffer of finalized `RunSnapshot`s per agent, which vanished
 * on restart and could drift from the child transcripts it claimed to
 * summarise. It is gone: a run is the set of children sharing a
 * `parentTurnId`, read through `SwarmCoordinator.runsForConversation` (which
 * merges live handles over persisted child rows). The conversations to look in
 * are the ones this process holds children for, plus the parents of the agent's
 * most recent {@link MAX_SCANNED_CHILDREN} child conversations — the second
 * half is what makes a pre-restart run visible at all.
 *
 * All routes 404 `{error:'not found'}` for an unknown agent (registry check
 * first, matching `GET /agents/:id/skills`) and for an unknown run.
 *
 * Cancel/send map the coordinator's `{ok, reason?}` result: `ok:true` → 200
 * `{ok:true}`; `ok:false` → 409 `{ok:false, reason}`. `:runId` is opaque to
 * both — the coordinator resolves the worker from the cross-turn child
 * registry, so the panel can steer or cancel a DETACHED background child whose
 * spawning turn ended long ago.
 */
export function mountSwarmRoutes(app: Hono, deps: SwarmManagementDeps): void {
  const { swarmCoordinator, agentRegistry, conversations } = deps;

  /** Every conversation of this agent that could hold a run, newest first. */
  function conversationsFor(agentId: string): string[] {
    const ids = new Set(swarmCoordinator.liveConversations(agentId));
    const page = conversations?.list({
      agentId,
      kind: 'subagent',
      limit: MAX_SCANNED_CHILDREN,
    });
    for (const child of page?.items ?? []) {
      if (child.parentConversationId) ids.add(child.parentConversationId);
    }
    return [...ids];
  }

  function runsFor(agentId: string): RunSnapshot[] {
    return conversationsFor(agentId).flatMap((conversationId) =>
      swarmCoordinator.runsForConversation(agentId, conversationId),
    );
  }

  // GET /agents/:id/swarm/runs → { runs: RunSummary[] }
  app.get('/agents/:id/swarm/runs', (c) => {
    const id = c.req.param('id');
    if (!agentRegistry.get(id)) return c.json({ error: 'not found' }, 404);
    const runs: RunSummary[] = runsFor(id).map(({ workers: _workers, ...summary }) => summary);
    return c.json({ runs });
  });

  // GET /agents/:id/swarm/runs/:runId → RunSnapshot
  app.get('/agents/:id/swarm/runs/:runId', (c) => {
    const id = c.req.param('id');
    if (!agentRegistry.get(id)) return c.json({ error: 'not found' }, 404);
    const runId = c.req.param('runId');
    const snapshot = runsFor(id).find((run) => run.runId === runId);
    if (!snapshot) return c.json({ error: 'not found' }, 404);
    return c.json(snapshot);
  });

  // POST /agents/:id/swarm/runs/:runId/workers/:workerId/cancel
  //   → {ok:true} | 409 {ok:false, reason}
  app.post('/agents/:id/swarm/runs/:runId/workers/:workerId/cancel', (c) => {
    const id = c.req.param('id');
    if (!agentRegistry.get(id)) return c.json({ error: 'not found' }, 404);
    const result = swarmCoordinator.cancelWorker(id, c.req.param('runId'), c.req.param('workerId'));
    if (!result.ok) return c.json({ ok: false, reason: result.reason }, 409);
    return c.json({ ok: true });
  });

  // POST /agents/:id/conversations/:conversationId/swarm/cancel
  //   → { cancelled: boolean }
  //
  // Terminalizes the conversation's live swarm turn (all non-terminal
  // workers → Cancelled, terminal events appended to the event log). MC's
  // chat stop button calls this over HTTP because the swarm's lifetime is
  // NOT tied to the orchestrator's WS stream — workers keep running (by
  // design) after the stream ends, so a stream-scoped cancel can't reach
  // them. Idempotent: `cancelled:false` when there is no live turn.
  app.post('/agents/:id/conversations/:conversationId/swarm/cancel', (c) => {
    const id = c.req.param('id');
    if (!agentRegistry.get(id)) return c.json({ error: 'not found' }, 404);
    const cancelled = swarmCoordinator.cancelTurn(id, c.req.param('conversationId'));
    return c.json({ cancelled });
  });

  // POST /agents/:id/swarm/runs/:runId/workers/:workerId/send  body {message}
  //   → {ok:true} | 409 {ok:false, reason} | 400 on missing/empty message
  app.post('/agents/:id/swarm/runs/:runId/workers/:workerId/send', async (c) => {
    const id = c.req.param('id');
    if (!agentRegistry.get(id)) return c.json({ error: 'not found' }, 404);
    let message: unknown;
    try {
      ({ message } = (await c.req.json()) as { message?: unknown });
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    if (typeof message !== 'string' || message.trim() === '') {
      return c.json({ error: 'message must be a non-empty string' }, 400);
    }
    const result = swarmCoordinator.sendPanelMessage(
      id,
      c.req.param('runId'),
      c.req.param('workerId'),
      message,
    );
    if (!result.ok) return c.json({ ok: false, reason: result.reason }, 409);
    return c.json({ ok: true });
  });
}
