import type { SwarmCoordinator } from '@dash/swarm';
import type { Hono } from 'hono';

import type { AgentRegistry } from './agent-registry.js';

export interface SwarmManagementDeps {
  swarmCoordinator: SwarmCoordinator;
  agentRegistry: AgentRegistry;
}

/**
 * Mounts the swarm panel management routes onto an already-authed Hono app.
 * Called from `management-api.ts` behind the bearer middleware, and only when a
 * `swarmCoordinator` was wired (so tests/embedders that skip swarm still
 * construct the app). Mirrors the `eventLogStore` replay-route mount pattern.
 *
 * All routes 404 `{error:'not found'}` for an unknown agent (registry check
 * first, matching `GET /agents/:id/skills`) and for an unknown run.
 *
 * Cancel/send map the coordinator's `{ok, reason?}` result: `ok:true` → 200
 * `{ok:true}`; `ok:false` → 409 `{ok:false, reason}`. The coordinator's reasons
 * (`'run finalized'`, `'worker terminal'`) already encode the failure cause.
 */
export function mountSwarmRoutes(app: Hono, deps: SwarmManagementDeps): void {
  const { swarmCoordinator, agentRegistry } = deps;

  // GET /agents/:id/swarm/runs → { runs: RunSummary[] }
  app.get('/agents/:id/swarm/runs', (c) => {
    const id = c.req.param('id');
    if (!agentRegistry.get(id)) return c.json({ error: 'not found' }, 404);
    return c.json({ runs: swarmCoordinator.getRuns(id) });
  });

  // GET /agents/:id/swarm/runs/:runId → RunSnapshot
  app.get('/agents/:id/swarm/runs/:runId', (c) => {
    const id = c.req.param('id');
    if (!agentRegistry.get(id)) return c.json({ error: 'not found' }, 404);
    const snapshot = swarmCoordinator.getRun(id, c.req.param('runId'));
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
