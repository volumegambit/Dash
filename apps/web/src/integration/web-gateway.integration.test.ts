// @vitest-environment node
//
// End-to-end integration test: the REAL web protocol stack (`MobileRestClient`,
// `ChatSocket`, `createWebAppStore`) driven against a REAL gateway (real Hono
// HTTP + WS listeners, real SQLite-backed conversation service, a scripted-but-
// real agent backend) — no mocks anywhere in this file. This runs against the
// gateway directly (no relay hop; that path has its own tests — see Task 12b),
// so auth is the mobile bearer token via a `TokenSource` plus a ws-ticket
// minted at upgrade time, and no `relayCredential` is ever passed.
//
// Root `vitest.config.ts` maps `apps/web/**/*.test.{ts,tsx}` to `happy-dom`
// (see `environmentMatchGlobs`) for this app's React component tests. This
// file needs real `ws` sockets and a real Node HTTP server, so it opts back
// into the `node` environment via the per-file pragma above.
//
// Harness: `startMobileTestHarness` (apps/gateway/src/mobile-test-harness.ts)
// is the Phase-4 boot helper already used by the Node two-client acceptance
// test (scripts/mobile-v1-e2e.test.ts) and the gateway's own mobile-v1 test
// suite — reused here rather than standing up a second, parallel harness.
import { randomUUID } from 'node:crypto';
import type { CloseEvent, ErrorEvent } from 'ws';
import { WebSocket as NodeWebSocket } from 'ws';
import {
  type RunningMobileTestHarness,
  startMobileTestHarness,
} from '../../../gateway/src/mobile-test-harness.js';
import { ChatSocket } from '../api/chat-socket';
import { MobileRestClient, type TokenSource } from '../api/rest';
import { type WebAppState, createWebAppStore } from '../state/store';

function tokenSource(token: string): TokenSource {
  return { getToken: () => Promise.resolve(token) };
}

/** `ChatSocket`'s `wsFactory` hook, satisfied here by the `ws` package's
 * `WebSocket` (Node has no native client `WebSocket` that supports the
 * self-signed LAN certificate below) — matches the pattern already used for
 * Node-side gateway sockets elsewhere in the repo (e.g. Mission Control's
 * `resumable-chat-transport.ts`). The pinned LAN surface's certificate is
 * self-signed (see `lan-tls.ts`), so `rejectUnauthorized` is disabled here —
 * exactly as the gateway's own real-TLS tests already do (see
 * `mobile-test-harness.test.ts`'s `pinnedSurfaceRequest`/socket helpers). */
function nodeWsFactory(url: string, protocols?: string[]): WebSocket {
  return new NodeWebSocket(url, protocols, { rejectUnauthorized: false }) as unknown as WebSocket;
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 10_000,
  intervalMs = 20,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Races a raw `ws` connection's `close`/`error` events, resolving the close
 * code — mirrors the pattern already used by
 * `mobile-test-harness.test.ts`'s "closes a real gateway socket with 4001"
 * assertion (a rejected upgrade completes the HTTP 101 handshake, then the
 * server closes immediately from `onOpen`; no `error` event fires for that
 * path, only for genuine transport failures). */
function closeCode(socket: NodeWebSocket): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    socket.addEventListener('error', (event: ErrorEvent) => reject(event.error));
    socket.addEventListener('close', (event: CloseEvent) => resolve(event.code));
  });
}

function waitForOpen(socket: NodeWebSocket): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', (event: ErrorEvent) => reject(event.error), { once: true });
  });
}

describe('web protocol stack against a real gateway (no relay)', () => {
  let harness: RunningMobileTestHarness;
  let restBaseUrl: string;
  let wsBaseUrl: string;

  beforeAll(async () => {
    // Default 'stream' scenario: a deterministic 3-event scripted turn
    // (two `text_delta`s ~50ms apart, then a final `response`) — the fake
    // agent backend "per harness convention" the brief calls for.
    harness = await startMobileTestHarness({ scenario: 'stream' });
    // `managementBaseUrl` already serves the full `/mobile/v1` namespace
    // (mounted directly on the management app — see `management-api.ts`),
    // plain HTTP, matching the brief's `http://127.0.0.1:<port>/mobile/v1`.
    restBaseUrl = `${harness.managementBaseUrl}/mobile/v1`;
    // The ticketed chat WS only exists on the pinned LAN surface
    // (`createLanMobileAppWithTickets`, wss://.../ws/chat) — the plain
    // `chatWebSocketUrl` accepts only `?token=`/`Authorization`, never a
    // ticket. Both surfaces share the same management app instance (and
    // therefore the same `WsTicketStore`), so minting over `restBaseUrl`
    // and redeeming over `wsBaseUrl` is exactly the real production split.
    wsBaseUrl = harness.mobileChatWebSocketUrl;
  }, 30_000);

  afterAll(async () => {
    await harness.stop();
  });

  it('drives loadConversations -> create -> sendMessage -> streamed completion; a second REST client observes both messages', async () => {
    const rest = new MobileRestClient(restBaseUrl, tokenSource(harness.chatToken));
    const store = createWebAppStore({
      rest,
      socketFactory: (onFrame, onClose) =>
        new ChatSocket(wsBaseUrl, rest, onFrame, onClose, nodeWsFactory),
    });

    try {
      // REST list (empty gateway, freshly booted harness).
      await store.getState().loadConversations();
      expect(store.getState().conversations).toEqual([]);

      const created = await rest.createConversation({
        agentId: harness.agentId,
        requestId: randomUUID(),
      });
      await store.getState().loadConversations();
      expect(store.getState().conversations.map((c) => c.id)).toContain(created.id);

      // ws-ticket -> WS upgrade: openConversation mints a ticket via
      // `rest.createWsTicket()` and connects `ChatSocket` through it.
      await store.getState().openConversation(created.id);
      expect(store.getState().connection).toBe('connected');

      // send -> streamed frames -> transcript. The store always tags
      // outgoing `message` frames with `channelId: 'web'` (see
      // `CHANNEL_ID` in state/store.ts) — this call only converges to a
      // completed 2-message transcript (no `error` frame short-circuits
      // it) if the gateway actually accepts that channel id end to end.
      await store.getState().sendMessage(created.id, 'Hello gateway');

      await waitUntil(() => {
        const t = store.getState().transcripts[created.id];
        return t !== undefined && t.streaming === null && t.messages.length === 2;
      });

      const transcript = store.getState().transcripts[created.id];
      // Proves the gateway ACCEPTED channelId 'web' (carry-over debt
      // T11): a rejected channel would have surfaced an `error` frame
      // instead, which `applyServerFrame` deliberately leaves the
      // transcript's `messages`/`streaming` untouched for — so the wait
      // above would never have converged, and `error` would be set here.
      expect(transcript.error).toBeUndefined();
      expect(transcript.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
      expect(transcript.messages.every((m) => m.status === 'completed')).toBe(true);

      // Independent corroboration straight from the conversation summary:
      // an accepted-then-rejected channel would have flipped this to
      // 'interrupted' (see handleFrame's `error` branch in store.ts).
      const summaryAfter = store.getState().conversations.find((c) => c.id === created.id);
      expect(summaryAfter?.status).not.toBe('interrupted');

      // Cross-client visibility: a second, entirely independent
      // MobileRestClient (its own TokenSource, no shared state with the
      // store above) fetches the conversation's messages directly and
      // must see both sides by message id.
      const secondClient = new MobileRestClient(restBaseUrl, tokenSource(harness.chatToken));
      const page = await secondClient.getMessages(created.id);
      expect(page.items.map((m) => m.id).sort()).toEqual(
        transcript.messages.map((m) => m.id).sort(),
      );
      expect(page.items.map((m) => m.role)).toEqual(['user', 'assistant']);
    } finally {
      store.getState().dispose();
    }
  }, 20_000);

  it('resumes a dropped socket mid-turn: the transcript converges via sinceSeq replay against the real gateway', async () => {
    const rest = new MobileRestClient(restBaseUrl, tokenSource(harness.chatToken));
    const sockets: ChatSocket[] = [];
    const store = createWebAppStore({
      rest,
      socketFactory: (onFrame, onClose) => {
        const socket = new ChatSocket(wsBaseUrl, rest, onFrame, onClose, nodeWsFactory);
        sockets.push(socket);
        return socket;
      },
    });
    const connectionLog: WebAppState['connection'][] = [];
    const unsubscribe = store.subscribe((state) => {
      if (connectionLog[connectionLog.length - 1] !== state.connection) {
        connectionLog.push(state.connection);
      }
    });

    try {
      const created = await rest.createConversation({
        agentId: harness.agentId,
        requestId: randomUUID(),
      });
      await store.getState().loadConversations();
      await store.getState().openConversation(created.id);
      expect(store.getState().connection).toBe('connected');

      await store.getState().sendMessage(created.id, 'Please stream a real response');

      // Drop the socket mid-turn, from the test — not a store API call.
      // The resumable chat hub only detaches on a bare close (it does
      // NOT cancel the live turn — see `resumable-chat-hub.ts`'s
      // `detach` vs `cancelLive`), so the scripted backend keeps running
      // and persisting frames to the durable event log regardless of
      // whether anything is currently attached to read them.
      expect(sockets.length).toBe(1);
      sockets[0].close();

      // Store observes the drop and reconnects on its own (exponential
      // backoff, ~1s first attempt) — sending a `resume` frame with
      // `sinceSeq: lastSeq` once the fresh socket is open.
      await waitUntil(() => store.getState().connection === 'reconnecting', 2_000);
      await waitUntil(() => store.getState().connection === 'connected', 10_000);
      await waitUntil(() => sockets.length >= 2, 10_000);

      await waitUntil(() => {
        const t = store.getState().transcripts[created.id];
        return t !== undefined && t.streaming === null && t.messages.length === 2;
      });

      const transcript = store.getState().transcripts[created.id];
      expect(transcript.error).toBeUndefined();
      expect(transcript.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
      expect(transcript.messages.every((m) => m.status === 'completed')).toBe(true);
      // A single finalized assistant message, not a duplicate row from
      // the replayed `accepted`/`event` frames being re-applied.
      expect(transcript.messages.filter((m) => m.role === 'assistant')).toHaveLength(1);

      // Genuine reconnect happened (not a no-op): a second ChatSocket was
      // created, and the store visibly passed through 'reconnecting'.
      expect(sockets.length).toBeGreaterThanOrEqual(2);
      expect(connectionLog).toContain('reconnecting');
    } finally {
      unsubscribe();
      store.getState().dispose();
    }
  }, 20_000);

  describe('security: real ws-ticket handshake and no-auth REST', () => {
    it('mints a ticket over REST and redeems it on a genuine HTTP-upgraded WS handshake', async () => {
      const rest = new MobileRestClient(restBaseUrl, tokenSource(harness.chatToken));
      const { ticket } = await rest.createWsTicket();

      // First redemption: a real `ws` client, a real Hono HTTP server
      // upgrade, a real querystring — proving `c.req.query('ticket')` reads
      // the genuine upgrade request (chat-ws.test.ts only ever exercises
      // this against a hand-built mock `c.req`).
      const first = new NodeWebSocket(`${wsBaseUrl}?ticket=${encodeURIComponent(ticket)}`, {
        rejectUnauthorized: false,
      });
      await waitForOpen(first);
      first.close();

      // Reused ticket: single-use, so the second redemption attempt must
      // be rejected with the same unauthorized close code chat-ws.ts uses
      // for any failed upgrade.
      const second = new NodeWebSocket(`${wsBaseUrl}?ticket=${encodeURIComponent(ticket)}`, {
        rejectUnauthorized: false,
      });
      await expect(closeCode(second)).resolves.toBe(4001);
    });

    it('rejects a WS upgrade with no ticket and no Authorization', async () => {
      const noAuth = new NodeWebSocket(wsBaseUrl, { rejectUnauthorized: false });
      await expect(closeCode(noAuth)).resolves.toBe(4001);
    });

    it('rejects a mobile v1 REST call with no bearer token', async () => {
      const response = await fetch(`${restBaseUrl}/conversations`);
      expect(response.status).toBe(401);
    });
  });
});
