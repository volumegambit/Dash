import type { ProjectsEmitter, ProjectsEventMap } from '@dash/projects';
import type { Hono } from 'hono';
import type { UpgradeWebSocket } from 'hono/ws';

/** Topics broadcast over /projects/ws — mirror the ProjectsEmitter events. */
export const PROJECTS_WS_TOPICS = [
  'issue.created',
  'issue.updated',
  'issue.event.appended',
  'comment.added',
  'comment.edited',
  'comment.deleted',
  'project.created',
  'project.updated',
  'session.linked',
] as const;

export type ProjectsWsTopic = (typeof PROJECTS_WS_TOPICS)[number];

export interface ProjectsWsDeps {
  emitter: ProjectsEmitter;
  upgradeWebSocket: UpgradeWebSocket;
  /** When set, clients must connect with ?token=<token>. */
  token?: string;
}

interface BroadcastClient {
  send(data: string): void;
}

/**
 * Normalize a raw emitter payload into the WIRE payload the MC reducer expects.
 *
 * The emitter payloads are wrapped objects (`{ issue }`, `{ project }`,
 * `{ comment }`, `{ event }`, `{ issueId, ... }` — see `ProjectsEventMap` in
 * @dash/projects). MC's reducer, however, reads the wire `payload` as either a
 * BARE entity (`payload as Issue` / `payload as Project`) for entity topics, or
 * as `{ issue_id }` for detail-mutating topics. Forwarding the raw wrapped
 * payload would silently no-op every reactive update. This unwraps each topic
 * to the contract MC already consumes, so MC needs no WS change.
 *
 * - issue.created / issue.updated      → bare Issue
 * - project.created / project.updated  → bare Project
 * - comment.added / comment.edited     → { issue_id } (from comment.issue_id)
 * - comment.deleted                    → { issue_id } (from issueId)
 * - issue.event.appended               → { issue_id } (from event.issue_id)
 * - session.linked                     → { issue_id } (from issueId)
 */
export function normalizeForWire<E extends ProjectsWsTopic>(
  topic: E,
  payload: ProjectsEventMap[E],
): unknown {
  switch (topic) {
    case 'issue.created':
    case 'issue.updated':
      return (payload as ProjectsEventMap['issue.created']).issue;
    case 'project.created':
    case 'project.updated':
      return (payload as ProjectsEventMap['project.created']).project;
    case 'comment.added':
    case 'comment.edited':
      return { issue_id: (payload as ProjectsEventMap['comment.added']).comment.issue_id };
    case 'comment.deleted':
      return { issue_id: (payload as ProjectsEventMap['comment.deleted']).issueId };
    case 'issue.event.appended':
      return { issue_id: (payload as ProjectsEventMap['issue.event.appended']).event.issue_id };
    case 'session.linked':
      return { issue_id: (payload as ProjectsEventMap['session.linked']).issueId };
    default: {
      // Exhaustiveness guard — a new topic must be added to PROJECTS_WS_TOPICS
      // and handled here.
      const _exhaustive: never = topic;
      return _exhaustive;
    }
  }
}

/**
 * Mount the /projects/ws WebSocket endpoint. Each connected client is
 * subscribed to every ProjectsEmitter topic; on emit we normalize the wrapped
 * emitter payload to the wire contract (see normalizeForWire) and fan out a
 * single { topic, payload } frame to all open clients. No per-client filtering
 * (v1). Auth mirrors the chat /ws endpoint: a ?token= query param compared to
 * deps.token.
 *
 * NOTE: the envelope field is `payload` (NOT `data`), and the payload is the
 * NORMALIZED entity (bare Issue/Project, or { issue_id }). The MC renderer
 * reads `payload`; forwarding the raw wrapped emitter payload would deliver
 * shapes MC ignores and no view would update.
 *
 * Call this exactly once per emitter instance — calling it twice attaches
 * duplicate listeners and doubles broadcast delivery. The Task 10 gateway
 * wiring is the single intended caller.
 */
export function mountProjectsWs(app: Hono, deps: ProjectsWsDeps): void {
  const { emitter, upgradeWebSocket } = deps;

  // Connected clients shared across all upgrades on this mount.
  const clients = new Set<BroadcastClient>();

  const broadcast = (topic: ProjectsWsTopic, payload: unknown): void => {
    const frame = JSON.stringify({ topic, payload });
    for (const client of clients) {
      try {
        client.send(frame);
      } catch {
        // Drop dead clients silently; onClose removes them.
      }
    }
  };

  // Subscribe once per mount. Listeners live for the process lifetime, which
  // matches the management server lifetime. Each raw emitter payload is
  // normalized to the wire contract before broadcast.
  for (const topic of PROJECTS_WS_TOPICS) {
    emitter.on(topic, (payload) => broadcast(topic, normalizeForWire(topic, payload)));
  }

  app.get(
    '/projects/ws',
    upgradeWebSocket((c) => {
      if (deps.token) {
        const token = c.req.query('token');
        if (!token || token !== deps.token) {
          return {
            onOpen(_event, ws) {
              ws.close(4001, 'Unauthorized');
            },
          };
        }
      }

      let client: BroadcastClient | null = null;

      return {
        onOpen(_event, ws) {
          client = { send: (data: string) => ws.send(data) };
          clients.add(client);
        },
        onClose() {
          if (client) clients.delete(client);
        },
      };
    }),
  );
}
