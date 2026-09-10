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
import { CHAT_INPUT_QUEUE_CAPABILITY } from '@dash/mobile-contract-v2';
import type { CloseEvent, ErrorEvent } from 'ws';
import { WebSocket as NodeWebSocket } from 'ws';
import {
  type MobileTestHarnessV2Client,
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
 * `WebSocket` — matches the pattern already used for Node-side gateway sockets
 * elsewhere in the repo (e.g. Mission Control's `resumable-chat-transport.ts`).
 * `rejectUnauthorized` stays disabled so this factory also works against the
 * pinned LAN surface's self-signed certificate (see `lan-tls.ts`). */
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
    // Deliberately the CHANNEL listener, not the pinned LAN surface: this is
    // the socket the relay forwards a browser's `/ws/chat` to, so it is the one
    // a hosted web client actually reaches. (Using the LAN surface here is what
    // let a ticket store missing from this listener ship unnoticed.) One
    // `WsTicketStore` is shared across every `/ws/chat` mount, so minting over
    // `restBaseUrl` and redeeming here is exactly the production split.
    wsBaseUrl = harness.chatWebSocketUrl;
  }, 30_000);

  afterAll(async () => {
    await harness.stop();
  });

  it('drives loadConversations -> create -> sendMessage -> streamed completion; a second REST client observes both messages', async () => {
    const rest = new MobileRestClient(restBaseUrl, tokenSource(harness.chatToken));
    const store = createWebAppStore({
      protocol: { version: 1, capabilities: [] },
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
    const transports: NodeWebSocket[] = [];
    const capturingWsFactory = (url: string, protocols?: string[]): WebSocket => {
      const transport = new NodeWebSocket(url, protocols, { rejectUnauthorized: false });
      transports.push(transport);
      return transport as unknown as WebSocket;
    };
    const store = createWebAppStore({
      protocol: { version: 1, capabilities: [] },
      rest,
      socketFactory: (onFrame, onClose) => {
        const socket = new ChatSocket(wsBaseUrl, rest, onFrame, onClose, capturingWsFactory);
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
      expect(transports.length).toBe(1);
      transports[0].terminate();

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

  it('converges a v2 bootstrap with a replayed second-client mutation while the same gateway keeps ordinary v1 chat compatible', async () => {
    const v2Harness = await startMobileTestHarness({ scenario: 'follow-up-v2' });
    const capabilities = [CHAT_INPUT_QUEUE_CAPABILITY];
    const v2Rest = new MobileRestClient(
      `${v2Harness.managementBaseUrl}/mobile/v2`,
      tokenSource(v2Harness.chatToken),
    );
    const webTransports: NodeWebSocket[] = [];
    const capturingV2WsFactory = (url: string, protocols?: string[]): WebSocket => {
      const transport = new NodeWebSocket(url, protocols, { rejectUnauthorized: false });
      webTransports.push(transport);
      return transport as unknown as WebSocket;
    };
    const webStore = createWebAppStore({
      protocol: { version: 2, capabilities },
      rest: v2Rest,
      socketFactory: (onFrame, onClose) =>
        new ChatSocket(
          v2Harness.chatWebSocketUrl,
          v2Rest,
          onFrame,
          onClose,
          capturingV2WsFactory,
          undefined,
          { version: 2, capabilities },
        ),
    });
    let secondClient: MobileTestHarnessV2Client | undefined;
    let v1Store: ReturnType<typeof createWebAppStore> | undefined;

    try {
      const conversation = await v2Rest.createConversation({
        agentId: v2Harness.agentId,
        requestId: randomUUID(),
      });
      secondClient = await v2Harness.connectV2();
      await v2Harness.subscribeConversation(secondClient, {
        conversationId: conversation.id,
      });

      // Seed state from a second protocol client before Web opens. The
      // follow-up fixture holds this run at a deterministic safe boundary,
      // leaving both the live segment and queue available to bootstrap.
      const runId = randomUUID();
      secondClient.send({
        type: 'message',
        id: runId,
        agentId: v2Harness.agentId,
        channelId: 'mission-control',
        conversationId: conversation.id,
        text: 'Seed this conversation from Mission Control',
        resumable: true,
      });
      await v2Harness.waitForProviderGate(runId, 'beforeSafeBoundary');
      const queued = await v2Harness.enqueueInput(secondClient, {
        conversationId: conversation.id,
        text: 'Review the integration evidence next',
        behavior: 'followUp',
        channelId: 'mission-control',
      });

      await webStore.getState().loadConversations();
      await webStore.getState().openConversation(conversation.id);
      expect(webStore.getState().connection).toBe('connected');

      const bootstrapped = webStore.getState().v2Transcripts[conversation.id];
      expect(bootstrapped.queueOrder).toEqual([queued.input.inputId]);
      expect(bootstrapped.inputs[queued.input.inputId]).toEqual(queued.input);
      expect(Object.values(bootstrapped.messages)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            runId,
            role: 'user',
            content: expect.objectContaining({
              type: 'user',
              text: 'Seed this conversation from Mission Control',
            }),
          }),
        ]),
      );
      const bootstrapSeq = bootstrapped.lastAppliedV2Seq;

      // Drop Web's transport, then mutate from the second client while Web
      // is detached. Its automatic v2 resubscription must replay the missed
      // transition from bootstrapSeq without reopening or replacing the store.
      expect(webTransports).toHaveLength(1);
      webTransports[0].terminate();
      await waitUntil(() => webStore.getState().connection === 'reconnecting', 2_000);
      const updated = await v2Harness.editFollowUp(secondClient, {
        conversationId: conversation.id,
        inputId: queued.input.inputId,
        expectedRevision: queued.input.revision,
        text: 'Review the final integration evidence next',
      });
      await waitUntil(
        () =>
          webStore.getState().v2Transcripts[conversation.id]?.inputs[queued.input.inputId]
            ?.revision === updated.input.revision,
      );
      await waitUntil(() => webStore.getState().connection === 'connected');
      expect(webTransports.length).toBeGreaterThanOrEqual(2);

      const authoritative = await v2Rest.bootstrap(conversation.id);
      const converged = webStore.getState().v2Transcripts[conversation.id];
      expect(converged.lastAppliedV2Seq).toBeGreaterThan(bootstrapSeq);
      expect(converged.lastAppliedV2Seq).toBe(authoritative.v2ThroughSeq);
      expect(converged.queueRevision).toBe(authoritative.queueRevision);
      expect(converged.queueOrder).toEqual([updated.input.inputId]);
      expect(converged.inputs[updated.input.inputId]).toEqual(updated.input);
      expect(authoritative.pendingInputs).toContainEqual(updated.input);
      expect(Object.keys(converged.messages).sort()).toEqual(
        authoritative.messages.map((message) => message.id).sort(),
      );

      // Remove the queued item before letting the held v2 run finish so it
      // cannot promote another run while this fixture checks v1 compatibility.
      await v2Harness.removeFollowUp(secondClient, {
        conversationId: conversation.id,
        inputId: updated.input.inputId,
        expectedRevision: updated.input.revision,
      });
      await waitUntil(
        () => webStore.getState().v2Transcripts[conversation.id]?.queueOrder.length === 0,
      );
      v2Harness.releaseProviderGate(runId, 'beforeSafeBoundary');
      await waitUntil(
        () =>
          webStore.getState().v2Transcripts[conversation.id]?.conversation.activeTurnId === null,
      );

      const v1Rest = new MobileRestClient(
        `${v2Harness.managementBaseUrl}/mobile/v1`,
        tokenSource(v2Harness.chatToken),
      );
      v1Store = createWebAppStore({
        protocol: { version: 1, capabilities: [] },
        rest: v1Rest,
        socketFactory: (onFrame, onClose) =>
          new ChatSocket(
            v2Harness.chatWebSocketUrl,
            v1Rest,
            onFrame,
            onClose,
            nodeWsFactory,
            undefined,
            { version: 1 },
          ),
      });
      const v1Conversation = await v1Rest.createConversation({
        agentId: v2Harness.agentId,
        requestId: randomUUID(),
      });
      await v1Store.getState().loadConversations();
      await v1Store.getState().openConversation(v1Conversation.id);
      await v1Store.getState().sendMessage(v1Conversation.id, 'Ordinary v1 still works');
      await waitUntil(() => {
        const transcript = v1Store?.getState().transcripts[v1Conversation.id];
        return (
          transcript?.streaming?.type === 'assistant' && transcript.streaming.events.length > 0
        );
      });
      expect(v1Store.getState().protocol).toEqual({ version: 1, capabilities: [] });
      expect(v1Store.getState().transcripts[v1Conversation.id].error).toBeUndefined();
      expect(v1Store.getState().transcripts[v1Conversation.id].messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: { type: 'user', text: 'Ordinary v1 still works' },
          }),
        ]),
      );
    } finally {
      v1Store?.getState().dispose();
      webStore.getState().dispose();
      await secondClient?.close().catch(() => undefined);
      await v2Harness.stop();
    }
  }, 30_000);

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
