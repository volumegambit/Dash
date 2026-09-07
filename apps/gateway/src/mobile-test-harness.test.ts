import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ConversationMessagePage,
  ConversationSummary,
  MobileWsServerFrame,
  ReplayPage,
} from '@dash/mobile-contract';
import type {
  MobileV2ConversationBootstrap,
  MobileV2ConversationSummary,
  MobileV2ReplayPage,
  MobileV2WsClientFrame,
  MobileV2WsServerFrame,
} from '@dash/mobile-contract-v2';
import { WebSocket, WebSocketServer } from 'ws';
import { type RunningMobileTestHarness, startMobileTestHarness } from './mobile-test-harness.js';

function mobileRequest(
  harness: RunningMobileTestHarness,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${harness.chatToken}`);
  return fetch(`${harness.managementBaseUrl}/mobile/v1${path}`, { ...init, headers });
}

function mobileV2Request(
  harness: RunningMobileTestHarness,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${harness.chatToken}`);
  return fetch(`${harness.managementBaseUrl}/mobile/v2${path}`, { ...init, headers });
}

function pinnedSurfaceRequest(
  harness: RunningMobileTestHarness,
  path: string,
  token?: string,
  method = 'GET',
): Promise<{ status: number; certificateSha256: string }> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      `${harness.mobileBaseUrl}${path}`,
      {
        method,
        rejectUnauthorized: false,
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      },
      (response) => {
        const socket = response.socket as typeof response.socket & {
          getPeerCertificate(): { raw?: Buffer };
        };
        const raw = socket.getPeerCertificate().raw;
        if (!raw) {
          reject(new Error('Pinned mobile TLS response has no peer leaf certificate'));
          return;
        }
        response.resume();
        response.once('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            certificateSha256: createHash('sha256').update(raw).digest('hex'),
          }),
        );
      },
    );
    request.once('error', reject);
    request.end();
  });
}

function pinnedJsonRequest(
  harness: RunningMobileTestHarness,
  path: string,
  options: { method?: 'GET' | 'POST'; body?: unknown } = {},
): Promise<{ status: number; value: unknown }> {
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      `${harness.mobileBaseUrl}${path}`,
      {
        method: options.method ?? 'GET',
        rejectUnauthorized: false,
        headers: {
          Authorization: `Bearer ${harness.chatToken}`,
          ...(payload === undefined
            ? {}
            : {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
              }),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.once('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let value: unknown = null;
          if (text) {
            try {
              value = JSON.parse(text) as unknown;
            } catch {
              value = text;
            }
          }
          resolve({ status: response.statusCode ?? 0, value });
        });
      },
    );
    request.once('error', reject);
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}

async function createConversation(
  harness: RunningMobileTestHarness,
  agentId = harness.agentId,
): Promise<ConversationSummary> {
  const response = await mobileRequest(harness, '/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId, requestId: randomUUID() }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as ConversationSummary;
}

async function createV2Conversation(
  harness: RunningMobileTestHarness,
  requestId = randomUUID(),
): Promise<MobileV2ConversationSummary> {
  const response = await mobileV2Request(harness, '/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: harness.agentId, requestId }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as MobileV2ConversationSummary;
}

function testUuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;
}

class FrameInbox {
  readonly frames: MobileWsServerFrame[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      this.frames.push(JSON.parse(String(event.data)) as MobileWsServerFrame);
      for (const listener of this.listeners) listener();
    });
  }

  send(value: object): void {
    this.socket.send(JSON.stringify(value));
  }

  async waitFor(
    predicate: (frame: MobileWsServerFrame) => boolean,
    timeoutMs = 4000,
  ): Promise<MobileWsServerFrame> {
    const find = (): MobileWsServerFrame | undefined => this.frames.find(predicate);
    const existing = find();
    if (existing) return existing;
    return new Promise<MobileWsServerFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(check);
        reject(new Error(`Timed out waiting for frame; received ${JSON.stringify(this.frames)}`));
      }, timeoutMs);
      const check = (): void => {
        const frame = find();
        if (!frame) return;
        clearTimeout(timer);
        this.listeners.delete(check);
        resolve(frame);
      };
      this.listeners.add(check);
    });
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise<void>((resolve) => {
      this.socket.addEventListener('close', () => resolve(), { once: true });
    });
    this.socket.close();
    await closed;
  }
}

class V2FrameInbox {
  readonly frames: MobileV2WsServerFrame[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      this.frames.push(JSON.parse(String(event.data)) as MobileV2WsServerFrame);
      for (const listener of this.listeners) listener();
    });
  }

  send(value: MobileV2WsClientFrame): void {
    this.socket.send(JSON.stringify(value));
  }

  async waitFor(
    predicate: (frame: MobileV2WsServerFrame) => boolean,
    timeoutMs = 4_000,
  ): Promise<MobileV2WsServerFrame> {
    const find = (): MobileV2WsServerFrame | undefined => this.frames.find(predicate);
    const existing = find();
    if (existing) return existing;
    return new Promise<MobileV2WsServerFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(check);
        reject(
          new Error(`Timed out waiting for v2 frame; received ${JSON.stringify(this.frames)}`),
        );
      }, timeoutMs);
      const check = (): void => {
        const frame = find();
        if (!frame) return;
        clearTimeout(timer);
        this.listeners.delete(check);
        resolve(frame);
      };
      this.listeners.add(check);
    });
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise<void>((resolve) => {
      this.socket.addEventListener('close', () => resolve(), { once: true });
    });
    this.socket.close();
    await closed;
  }
}

async function openChat(harness: RunningMobileTestHarness): Promise<FrameInbox> {
  const socket = new WebSocket(
    `${harness.chatWebSocketUrl}?token=${encodeURIComponent(harness.chatToken)}`,
  );
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', (event) => reject(event.error), { once: true });
  });
  return new FrameInbox(socket);
}

async function openV2Chat(harness: RunningMobileTestHarness): Promise<V2FrameInbox> {
  const socket = new WebSocket(
    `${harness.chatWebSocketUrl}?token=${encodeURIComponent(harness.chatToken)}`,
  );
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', (event) => reject(event.error), { once: true });
  });
  const inbox = new V2FrameInbox(socket);
  inbox.send({ type: 'hello', contractVersion: 2, capabilities: ['chat-input-queue-v1'] });
  await inbox.waitFor((frame) => frame.type === 'hello_ack');
  return inbox;
}

/**
 * Resolve how the server judged a `/ws/chat` upgrade.
 *
 * The reject path completes the HTTP handshake and only then closes with 4001
 * (Hono's `upgradeWebSocket` can only act in `onOpen`), so a client always sees
 * `open` first — racing `open` against `close` would pass even when rejected.
 * We therefore wait for the close, and treat "still open after a grace period"
 * as accepted: the rejection closes in the same tick the handshake completes.
 */
async function chatUpgradeOutcome(
  url: string,
  options?: { rejectUnauthorized?: boolean; headers?: Record<string, string> },
): Promise<'open' | number> {
  const socket = new WebSocket(url, options);
  try {
    return await new Promise<'open' | number>((resolve, reject) => {
      const timer = setTimeout(() => resolve('open'), 400);
      socket.addEventListener(
        'close',
        (event) => {
          clearTimeout(timer);
          resolve(event.code);
        },
        { once: true },
      );
      socket.addEventListener(
        'error',
        (event) => {
          clearTimeout(timer);
          reject(event.error);
        },
        { once: true },
      );
    });
  } finally {
    socket.close();
  }
}

async function mintWsTicket(harness: RunningMobileTestHarness): Promise<string> {
  const response = await mobileRequest(harness, '/ws-ticket', { method: 'POST' });
  expect(response.status).toBe(200);
  const { ticket } = (await response.json()) as { ticket: string };
  expect(typeof ticket).toBe('string');
  return ticket;
}

function turnFrames(inbox: FrameInbox, turnId: string): MobileWsServerFrame[] {
  return inbox.frames.filter((frame) => frame.id === turnId);
}

function settlesWithin<T>(promise: Promise<T>, timeoutMs = 1000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Operation did not settle within ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

describe('mobile test harness', () => {
  it('self-reports the caller-supplied public key from /identity', async () => {
    // The account-flow rig (`live-account-flow-harness-cli.ts`) enrolls this
    // harness with a control plane under its REAL Ed25519 relay identity, and
    // the iOS client refuses to install a pairing whose verified identity
    // disagrees with the enrolled record — so the harness must be able to
    // report the same key rather than a hardcoded stand-in.
    const harness = await startMobileTestHarness({
      scenario: 'stream',
      publicKey: 'caller-supplied-public-key',
    });
    try {
      expect(harness.publicKey).toBe('caller-supplied-public-key');
      const identity = await mobileRequest(harness, '/identity');
      expect(await identity.json()).toEqual({
        gatewayId: harness.gatewayId,
        publicKey: 'caller-supplied-public-key',
      });
    } finally {
      await harness.stop();
    }
  });

  it('starts real ephemeral management and chat listeners', async () => {
    const harness = await startMobileTestHarness({ scenario: 'stream' });
    try {
      expect(harness.managementBaseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(harness.chatWebSocketUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/ws\/chat$/);

      const health = await fetch(`${harness.managementBaseUrl}/mobile/v1/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({
        status: 'healthy',
        capabilities: expect.arrayContaining(['conversation-sync-v1', 'chat-resume-v1']),
      });
    } finally {
      await harness.stop();
    }
  });

  it('serves only the pinned HTTPS mobile API and WSS chat surface on one port', async () => {
    const harness = await startMobileTestHarness({ scenario: 'stream' });
    try {
      expect(harness.mobileBaseUrl).toMatch(/^https:\/\/127\.0\.0\.1:\d+$/);
      expect(harness.mobileChatWebSocketUrl).toBe(
        `${harness.mobileBaseUrl.replace('https://', 'wss://')}/ws/chat`,
      );

      const health = await pinnedSurfaceRequest(harness, '/mobile/v1/health');
      expect(health.status).toBe(200);
      expect(health.certificateSha256).toBe(harness.tlsCertificateSha256);
      expect((await pinnedSurfaceRequest(harness, '/agents', harness.chatToken)).status).toBe(404);
      expect((await pinnedSurfaceRequest(harness, '/mobile/v10', harness.chatToken)).status).toBe(
        404,
      );
      expect(
        (await pinnedSurfaceRequest(harness, '/mobile/v1/agents', harness.chatToken)).status,
      ).toBe(200);

      const socket = new WebSocket(
        `${harness.mobileChatWebSocketUrl}?token=${encodeURIComponent(harness.chatToken)}`,
        { rejectUnauthorized: false },
      );
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => resolve(), { once: true });
        socket.addEventListener('error', (event) => reject(event.error), { once: true });
      });
      socket.close();
    } finally {
      await harness.stop();
    }
  });

  it('redeems a ws-ticket minted over the management surface at the relayed chat listener', async () => {
    // The exact shipped topology a browser hits: the relay forwards `/ws/chat`
    // to the CHAT listener (`chatWebSocketUrl`), NOT the pinned LAN surface. A
    // ticket minted over `/mobile/v1/ws-ticket` must be redeemable there or the
    // web client's socket is dead on arrival with a 4001.
    const harness = await startMobileTestHarness({ scenario: 'stream' });
    try {
      const ticket = await mintWsTicket(harness);
      const outcome = await chatUpgradeOutcome(
        `${harness.chatWebSocketUrl}?ticket=${encodeURIComponent(ticket)}`,
      );
      expect(outcome).toBe('open');
    } finally {
      await harness.stop();
    }
  });

  it('serves a real turn over a ticket-authenticated relayed chat socket', async () => {
    // Beyond "not closed": the ticketed socket is a fully working chat socket.
    const harness = await startMobileTestHarness({ scenario: 'stream' });
    let chat: FrameInbox | undefined;
    try {
      const ticket = await mintWsTicket(harness);
      const conversation = await createConversation(harness);
      const socket = new WebSocket(
        `${harness.chatWebSocketUrl}?ticket=${encodeURIComponent(ticket)}`,
      );
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => resolve(), { once: true });
        socket.addEventListener('error', (event) => reject(event.error), { once: true });
      });
      chat = new FrameInbox(socket);
      const turnId = randomUUID();
      chat.send({
        type: 'message',
        id: turnId,
        agentId: harness.agentId,
        channelId: 'web',
        conversationId: conversation.id,
        text: 'Hello from a ticketed browser socket',
      });
      await chat.waitFor((frame) => frame.type === 'done' && frame.id === turnId);
    } finally {
      await chat?.close();
      await harness.stop();
    }
  });

  it('burns a ws-ticket on redemption — the same ticket cannot open a second socket', async () => {
    const harness = await startMobileTestHarness({ scenario: 'stream' });
    try {
      const ticket = await mintWsTicket(harness);
      const url = `${harness.chatWebSocketUrl}?ticket=${encodeURIComponent(ticket)}`;
      expect(await chatUpgradeOutcome(url)).toBe('open');
      expect(await chatUpgradeOutcome(url)).toBe(4001);
    } finally {
      await harness.stop();
    }
  });

  it('shares ONE ticket store across the chat and pinned LAN listeners', async () => {
    // Both listeners mount `/ws/chat` from the same store, so a ticket works at
    // whichever surface the client reaches — and is single-use across both.
    const harness = await startMobileTestHarness({ scenario: 'stream' });
    try {
      const ticket = await mintWsTicket(harness);
      const lan = await chatUpgradeOutcome(
        `${harness.mobileChatWebSocketUrl}?ticket=${encodeURIComponent(ticket)}`,
        { rejectUnauthorized: false },
      );
      expect(lan).toBe('open');

      // Redeemed on the LAN surface — the chat listener must reject the reuse.
      const reused = await chatUpgradeOutcome(
        `${harness.chatWebSocketUrl}?ticket=${encodeURIComponent(ticket)}`,
      );
      expect(reused).toBe(4001);
    } finally {
      await harness.stop();
    }
  });

  it('rejects an unknown ticket at the relayed chat listener', async () => {
    const harness = await startMobileTestHarness({ scenario: 'stream' });
    try {
      expect(await chatUpgradeOutcome(`${harness.chatWebSocketUrl}?ticket=not-a-ticket`)).toBe(
        4001,
      );
    } finally {
      await harness.stop();
    }
  });

  it('treats an empty Authorization header as absent, and does not burn the ticket', async () => {
    // An empty header (a proxy can add one) must be "no header" for BOTH the
    // ticket fallback and the header branch. When they disagreed, the header
    // branch rejected the upgrade AFTER the fallback had already redeemed —
    // burning a single-use ticket on a request that could never succeed.
    const harness = await startMobileTestHarness({ scenario: 'stream' });
    try {
      const ticket = await mintWsTicket(harness);
      const url = `${harness.chatWebSocketUrl}?ticket=${encodeURIComponent(ticket)}`;
      expect(await chatUpgradeOutcome(url, { headers: { authorization: '' } })).toBe('open');
    } finally {
      await harness.stop();
    }
  });

  it('closes a real gateway socket with 4001 for the wrong chat token', async () => {
    const harness = await startMobileTestHarness({ scenario: 'stream' });
    try {
      const socket = new WebSocket(`${harness.chatWebSocketUrl}?token=wrong-token`);
      const code = await new Promise<number>((resolve, reject) => {
        socket.addEventListener('error', (event) => reject(event.error));
        socket.addEventListener('close', (event) => resolve(event.code));
      });
      expect(code).toBe(4001);
    } finally {
      await harness.stop();
    }
  });

  it('stops idempotently with a live authenticated slow WebSocket client', async () => {
    const harness = await startMobileTestHarness({ scenario: 'slow' });
    let chat: FrameInbox | undefined;
    try {
      const conversation = await createConversation(harness);
      chat = await openChat(harness);
      const turnId = randomUUID();
      chat.send({
        type: 'message',
        id: turnId,
        agentId: harness.agentId,
        channelId: 'mobile-ios',
        conversationId: conversation.id,
        text: 'Stay connected during shutdown',
        resumable: true,
      });
      await chat.waitFor(
        (frame) =>
          frame.type === 'event' && frame.id === turnId && frame.event.type === 'text_delta',
      );

      const clientClosed = new Promise<void>((resolve) => {
        chat?.socket.addEventListener('close', () => resolve(), { once: true });
      });
      const stopping = harness.stop();
      expect(harness.stop()).toBe(stopping);
      await settlesWithin(stopping);
      await settlesWithin(clientClosed);
      expect(chat.socket.readyState).toBe(WebSocket.CLOSED);
    } finally {
      if (chat && chat.socket.readyState !== WebSocket.CLOSED) chat.socket.terminate();
      await harness.stop();
    }
  });

  it('seals an active typed slow run without releasing its provider gate', async () => {
    const harness = await startMobileTestHarness({ scenario: 'slow' });
    let chat: FrameInbox | undefined;
    try {
      const conversation = await createConversation(harness);
      chat = await openChat(harness);
      const turnId = randomUUID();
      chat.send({
        type: 'message',
        id: turnId,
        agentId: harness.agentId,
        channelId: 'mobile-ios',
        conversationId: conversation.id,
        text: 'Cancel before release',
        resumable: true,
      });
      await chat.waitFor(
        (frame) =>
          frame.type === 'event' && frame.id === turnId && frame.event.type === 'text_delta',
      );

      chat.send({ type: 'cancel', id: turnId });
      const cancelled = await chat.waitFor((frame) => frame.type === 'done' && frame.id === turnId);

      expect(cancelled).toMatchObject({ outcome: 'cancelled' });
      expect(JSON.stringify(turnFrames(chat, turnId))).not.toContain('Working');
    } finally {
      await chat?.close();
      await harness.stop();
    }
  });

  it('holds the second slow event until the harness release signal', async () => {
    const harness = await startMobileTestHarness({ scenario: 'slow' });
    let chat: FrameInbox | undefined;
    try {
      const conversation = await createConversation(harness);
      chat = await openChat(harness);
      const turnId = randomUUID();
      chat.send({
        type: 'message',
        id: turnId,
        agentId: harness.agentId,
        channelId: 'mobile-ios',
        conversationId: conversation.id,
        text: 'Wait for release',
        resumable: true,
      });

      const first = await chat.waitFor((frame) => frame.type === 'event' && frame.id === turnId);
      expect(first).toMatchObject({
        type: 'event',
        event: { type: 'text_delta', text: 'Starting' },
      });
      const beforeRelease = (await (
        await mobileRequest(harness, `/conversations/${conversation.id}/messages`)
      ).json()) as ConversationMessagePage;
      expect(JSON.stringify(beforeRelease.items)).not.toContain('Working');

      const adminDenied = await pinnedSurfaceRequest(
        harness,
        '/mobile/v1/__mobile-test/slow/release',
        harness.managementToken,
        'POST',
      );
      expect(adminDenied.status).toBe(401);
      const released = await pinnedSurfaceRequest(
        harness,
        '/mobile/v1/__mobile-test/slow/release',
        harness.chatToken,
        'POST',
      );
      expect(released.status).toBe(204);
      const second = await chat.waitFor(
        (frame) =>
          frame.type === 'event' &&
          frame.id === turnId &&
          frame.event.type === 'text_delta' &&
          frame.event.text === 'Working',
      );
      expect(second).toMatchObject({
        type: 'event',
        event: { type: 'text_delta', text: 'Working' },
      });
    } finally {
      await chat?.close();
      await harness.stop();
    }
  });

  it.each(['/events', '/mobile/v1/events', '/mobile/v2/events'])(
    'stops promptly without client cancellation while an SSE response is open on %s',
    async (path) => {
      const harness = await startMobileTestHarness({ scenario: 'stream' });
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        const token = path === '/events' ? harness.managementToken : harness.chatToken;
        const eventsResponsePromise = fetch(`${harness.managementBaseUrl}${path}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        await new Promise((resolve) => setTimeout(resolve, 25));
        await createConversation(harness);
        const eventsResponse = await eventsResponsePromise;
        expect(eventsResponse.status).toBe(200);
        reader = eventsResponse.body?.getReader();
        if (!reader) throw new Error('SSE response has no body reader');
        expect((await reader.read()).done).toBe(false);
        const clientClosed = reader.closed.catch(() => undefined);

        await settlesWithin(harness.stop());
        await settlesWithin(clientClosed);
      } finally {
        await reader?.cancel().catch(() => undefined);
        await harness.stop();
      }
    },
  );

  it('flushes and closes direct and LAN chat sockets during gateway shutdown', async () => {
    const harness = await startMobileTestHarness({ scenario: 'stream' });
    const direct = new WebSocket(
      `${harness.chatWebSocketUrl}?token=${encodeURIComponent(harness.chatToken)}`,
    );
    const lan = new WebSocket(
      `${harness.mobileChatWebSocketUrl}?token=${encodeURIComponent(harness.chatToken)}`,
      { rejectUnauthorized: false },
    );
    let stopping: Promise<void> | undefined;
    try {
      await Promise.all(
        [direct, lan].map(
          (socket) =>
            new Promise<void>((resolve, reject) => {
              socket.addEventListener('open', () => resolve(), { once: true });
              socket.addEventListener('error', (event) => reject(event.error), { once: true });
            }),
        ),
      );
      const directClosed = new Promise<{ code: number; reason: string }>((resolve) => {
        direct.addEventListener(
          'close',
          (event) => resolve({ code: event.code, reason: event.reason }),
          { once: true },
        );
      });
      const lanClosed = new Promise<{ code: number; reason: string }>((resolve) => {
        lan.addEventListener(
          'close',
          (event) => resolve({ code: event.code, reason: event.reason }),
          { once: true },
        );
      });

      stopping = harness.stop();
      await settlesWithin(stopping);
      await expect(directClosed).resolves.toEqual({ code: 1012, reason: 'gateway_shutdown' });
      await expect(lanClosed).resolves.toEqual({ code: 1012, reason: 'gateway_shutdown' });
    } finally {
      direct.terminate();
      lan.terminate();
      await stopping?.catch(() => undefined);
      await harness.stop();
    }
  });

  it('preserves a Follow Up across disable, requires resume, and fences deletion end to end', async () => {
    const harness = await startMobileTestHarness({ scenario: 'slow' });
    let chat: V2FrameInbox | undefined;
    try {
      const conversation = await createConversation(harness);
      chat = await openV2Chat(harness);
      const subscriptionId = randomUUID();
      chat.send({
        type: 'subscribe_conversation',
        id: subscriptionId,
        agentId: harness.agentId,
        conversationId: conversation.id,
        sinceV2Seq: 0,
      });
      await chat.waitFor(
        (frame) => frame.type === 'conversation_subscribed' && frame.id === subscriptionId,
      );

      const firstRunId = randomUUID();
      chat.send({
        type: 'message',
        id: firstRunId,
        agentId: harness.agentId,
        channelId: 'mobile-ios',
        conversationId: conversation.id,
        text: 'Work until disabled',
        resumable: true,
      });
      await chat.waitFor(
        (frame) =>
          frame.type === 'event' && frame.runId === firstRunId && frame.event.type === 'text_delta',
      );

      const firstInputId = randomUUID();
      const enqueueId = randomUUID();
      chat.send({
        type: 'enqueue_input',
        id: enqueueId,
        inputId: firstInputId,
        agentId: harness.agentId,
        channelId: 'mobile-ios',
        conversationId: conversation.id,
        text: 'Run only after I resume',
        behavior: 'followUp',
      });
      const queued = await chat.waitFor(
        (frame) => frame.type === 'input_accepted' && frame.id === enqueueId,
      );
      if (queued.type !== 'input_accepted' || !queued.input.runId) {
        throw new Error('Follow Up acknowledgement did not reserve a run');
      }
      const queuedRunId = queued.input.runId;

      const disabled = await mobileV2Request(harness, `/agents/${harness.agentId}/disable`, {
        method: 'POST',
      });
      expect(disabled.status).toBe(200);
      await chat.waitFor(
        (frame) =>
          frame.type === 'done' && frame.runId === firstRunId && frame.outcome === 'interrupted',
      );
      await chat.waitFor((frame) => frame.type === 'queue_paused' && frame.queuePaused);

      const lateCommandId = randomUUID();
      chat.send({
        type: 'enqueue_input',
        id: lateCommandId,
        inputId: randomUUID(),
        agentId: harness.agentId,
        channelId: 'mobile-ios',
        conversationId: conversation.id,
        text: 'Must be rejected while disabled',
        behavior: 'followUp',
      });
      const rejected = await chat.waitFor(
        (frame) => frame.type === 'command_rejected' && frame.id === lateCommandId,
      );
      expect(rejected).toMatchObject({ type: 'command_rejected', code: 'gateway_offline' });

      let bootstrap = (await (
        await mobileV2Request(harness, `/conversations/${conversation.id}/bootstrap`)
      ).json()) as MobileV2ConversationBootstrap;
      expect(bootstrap).toMatchObject({
        queuePaused: true,
        pendingInputs: [expect.objectContaining({ inputId: firstInputId, state: 'queued' })],
      });

      const enabled = await mobileV2Request(harness, `/agents/${harness.agentId}/enable`, {
        method: 'POST',
      });
      expect(enabled.status).toBe(200);
      bootstrap = (await (
        await mobileV2Request(harness, `/conversations/${conversation.id}/bootstrap`)
      ).json()) as MobileV2ConversationBootstrap;
      expect(bootstrap.queuePaused).toBe(true);
      expect(chat.frames.some((frame) => frame.type === 'input_delivered')).toBe(false);

      chat.send({
        type: 'resume_follow_ups',
        id: randomUUID(),
        conversationId: conversation.id,
        expectedQueueRevision: bootstrap.queueRevision,
      });
      await chat.waitFor(
        (frame) => frame.type === 'input_delivered' && frame.input.inputId === firstInputId,
      );
      await chat.waitFor(
        (frame) =>
          frame.type === 'event' &&
          frame.runId === queuedRunId &&
          frame.event.type === 'text_delta',
      );

      const deleteInputId = randomUUID();
      const deleteEnqueueId = randomUUID();
      chat.send({
        type: 'enqueue_input',
        id: deleteEnqueueId,
        inputId: deleteInputId,
        agentId: harness.agentId,
        channelId: 'mobile-ios',
        conversationId: conversation.id,
        text: 'Must fail when the agent is deleted',
        behavior: 'followUp',
      });
      await chat.waitFor(
        (frame) => frame.type === 'input_accepted' && frame.id === deleteEnqueueId,
      );

      const deleted = await mobileV2Request(harness, `/agents/${harness.agentId}`, {
        method: 'DELETE',
      });
      expect(deleted.status).toBe(200);
      await chat.waitFor(
        (frame) => frame.type === 'input_failed' && frame.input.inputId === deleteInputId,
      );

      const archived = (await (
        await mobileV2Request(harness, `/conversations/${conversation.id}/bootstrap`)
      ).json()) as MobileV2ConversationBootstrap;
      expect(archived.conversation.status).toBe('archived');
      expect(archived.pendingInputs).toEqual([]);

      const afterDeleteId = randomUUID();
      chat.send({
        type: 'subscribe_conversation',
        id: afterDeleteId,
        agentId: harness.agentId,
        conversationId: conversation.id,
        sinceV2Seq: archived.v2ThroughSeq,
      });
      const afterDelete = await chat.waitFor(
        (frame) => frame.type === 'command_rejected' && frame.id === afterDeleteId,
      );
      expect(afterDelete).toMatchObject({ type: 'command_rejected', code: 'gateway_offline' });
    } finally {
      await chat?.close();
      await harness.stop();
    }
  });

  it('proves Follow Up v2 cross-client mutation and exact-once restart promotion', async () => {
    const harness = await startMobileTestHarness({ scenario: 'follow-up-v2-restart' });
    let firstClient: Awaited<ReturnType<typeof harness.connectV2>> | undefined;
    let secondClient: Awaited<ReturnType<typeof harness.connectV2>> | undefined;
    let restartedClient: Awaited<ReturnType<typeof harness.connectV2>> | undefined;
    try {
      const stableEnvironment = {
        managementBaseUrl: harness.managementBaseUrl,
        chatWebSocketUrl: harness.chatWebSocketUrl,
        mobileBaseUrl: harness.mobileBaseUrl,
        mobileChatWebSocketUrl: harness.mobileChatWebSocketUrl,
        tlsCertificateSha256: harness.tlsCertificateSha256,
        managementToken: harness.managementToken,
        chatToken: harness.chatToken,
        gatewayId: harness.gatewayId,
        agentId: harness.agentId,
        dataDir: harness.dataDir,
      };
      const conversation = await createV2Conversation(harness, testUuid(101));
      firstClient = await harness.connectV2();
      secondClient = await harness.connectV2();
      await harness.subscribeConversation(firstClient, {
        commandId: testUuid(102),
        conversationId: conversation.id,
        sinceV2Seq: conversation.v2LastSeq,
      });
      await harness.subscribeConversation(secondClient, {
        commandId: testUuid(103),
        conversationId: conversation.id,
        sinceV2Seq: conversation.v2LastSeq,
      });

      const outerRunId = testUuid(104);
      harness.holdProviderGate(outerRunId, 'beforeSafeBoundary');
      harness.holdProviderGate(outerRunId, 'beforeRunTerminal');
      firstClient.send({
        type: 'message',
        id: outerRunId,
        agentId: harness.agentId,
        channelId: 'mobile-ios',
        conversationId: conversation.id,
        text: 'Hold the active response',
        resumable: true,
      });
      await firstClient.waitFor((frame) => frame.type === 'event' && frame.runId === outerRunId);
      await harness.waitForProviderGate(outerRunId, 'beforeSafeBoundary');

      const steer = await harness.enqueueInput(firstClient, {
        commandId: testUuid(105),
        inputId: testUuid(106),
        conversationId: conversation.id,
        text: 'Use the durable boundary',
        behavior: 'steer',
        expectedActiveTurnId: outerRunId,
      });
      const queued = await Promise.all(
        [
          { commandId: testUuid(107), inputId: testUuid(108), text: 'one' },
          { commandId: testUuid(109), inputId: testUuid(110), text: 'two' },
          { commandId: testUuid(111), inputId: testUuid(112), text: 'three' },
        ].map((input) =>
          harness.enqueueInput(firstClient as NonNullable<typeof firstClient>, {
            ...input,
            conversationId: conversation.id,
            behavior: 'followUp',
          }),
        ),
      );
      const queuedRunIds = queued.map((frame) => {
        if (!frame.input.runId) throw new Error('Follow Up did not reserve a run ID');
        return frame.input.runId;
      });

      harness.releaseProviderGate(outerRunId, 'beforeSafeBoundary');
      await firstClient.waitFor(
        (frame) => frame.type === 'input_delivered' && frame.input.inputId === steer.input.inputId,
      );
      await harness.waitForProviderGate(outerRunId, 'beforeRunTerminal');

      const firstBeforeEdit = firstClient.lastV2Seq;
      const edited = await harness.editFollowUp(secondClient, {
        commandId: testUuid(113),
        conversationId: conversation.id,
        inputId: queued[1].input.inputId,
        expectedRevision: queued[1].input.revision,
        text: 'two edited by client B',
      });
      await firstClient.waitFor(
        (frame) => frame.type === 'input_updated' && frame.input.inputId === edited.input.inputId,
        { afterV2Seq: firstBeforeEdit },
      );
      const secondBeforeRemove = secondClient.lastV2Seq;
      const removed = await harness.removeFollowUp(firstClient, {
        commandId: testUuid(114),
        conversationId: conversation.id,
        inputId: queued[2].input.inputId,
        expectedRevision: queued[2].input.revision,
      });
      await secondClient.waitFor(
        (frame) => frame.type === 'input_removed' && frame.inputId === removed.inputId,
        { afterV2Seq: secondBeforeRemove },
      );
      const converged = await harness.bootstrapV2(conversation.id);
      expect(converged.pendingInputs.map((input) => input.inputId)).toEqual([
        queued[0].input.inputId,
        queued[1].input.inputId,
      ]);
      expect(converged.pendingInputs[1]?.text).toBe('two edited by client B');
      await secondClient.close();
      secondClient = undefined;

      harness.holdProviderGate(queuedRunIds[0], 'beforeRunTerminal');
      harness.holdProviderGate(queuedRunIds[1], 'beforeRunTerminal');
      const cancelled = await harness.cancelRun(firstClient, outerRunId);
      expect(cancelled).toMatchObject({ type: 'done', outcome: 'cancelled' });
      await firstClient.waitFor(
        (frame) =>
          frame.type === 'input_delivered' && frame.input.inputId === queued[0].input.inputId,
      );
      await harness.waitForProviderGate(queuedRunIds[0], 'beforeRunTerminal');
      expect(
        await harness.providerExecutionCount({
          conversationId: conversation.id,
          inputId: queued[0].input.inputId,
        }),
      ).toBe(1);

      const restartCursor = firstClient.lastV2Seq;
      await harness.restartGateway();
      expect({
        managementBaseUrl: harness.managementBaseUrl,
        chatWebSocketUrl: harness.chatWebSocketUrl,
        mobileBaseUrl: harness.mobileBaseUrl,
        mobileChatWebSocketUrl: harness.mobileChatWebSocketUrl,
        tlsCertificateSha256: harness.tlsCertificateSha256,
        managementToken: harness.managementToken,
        chatToken: harness.chatToken,
        gatewayId: harness.gatewayId,
        agentId: harness.agentId,
        dataDir: harness.dataDir,
      }).toEqual(stableEnvironment);

      restartedClient = await harness.connectV2();
      await harness.subscribeConversation(restartedClient, {
        commandId: testUuid(115),
        conversationId: conversation.id,
        sinceV2Seq: restartCursor,
      });
      await harness.waitForProviderGate(queuedRunIds[1], 'beforeRunTerminal');
      expect(edited.input.text).toBe('two edited by client B');
      expect(
        await harness.providerExecutionCount({
          conversationId: conversation.id,
          inputId: queued[0].input.inputId,
        }),
      ).toBe(1);
      expect(
        await harness.providerExecutionCount({
          conversationId: conversation.id,
          inputId: queued[1].input.inputId,
        }),
      ).toBe(1);
      expect(
        await harness.providerExecutionCount({
          conversationId: conversation.id,
          inputId: queued[2].input.inputId,
        }),
      ).toBe(0);

      harness.releaseProviderGate(queuedRunIds[1], 'beforeRunTerminal');
      await restartedClient.waitFor(
        (frame) => frame.type === 'done' && frame.runId === queuedRunIds[1],
      );
      const bootstrap = await harness.bootstrapV2(conversation.id);
      const messageIds = bootstrap.messages.map((message) => message.id);
      expect(new Set(messageIds).size).toBe(messageIds.length);
      expect(bootstrap.pendingInputs).toEqual([]);
    } finally {
      await firstClient?.close().catch(() => undefined);
      await secondClient?.close().catch(() => undefined);
      await restartedClient?.close().catch(() => undefined);
      await harness.stop();
    }
  });

  it('keeps an ordinary failure pause durable across restart until explicit resume Follow Ups', async () => {
    const harness = await startMobileTestHarness({ scenario: 'follow-up-v2-restart' });
    let firstClient: Awaited<ReturnType<typeof harness.connectV2>> | undefined;
    let restartedClient: Awaited<ReturnType<typeof harness.connectV2>> | undefined;
    try {
      const conversation = await createV2Conversation(harness, testUuid(121));
      firstClient = await harness.connectV2();
      await harness.subscribeConversation(firstClient, {
        commandId: testUuid(122),
        conversationId: conversation.id,
        sinceV2Seq: 0,
      });
      const failingRunId = testUuid(123);
      harness.holdProviderGate(failingRunId, 'beforeSafeBoundary');
      harness.failRun(failingRunId);
      firstClient.send({
        type: 'message',
        id: failingRunId,
        agentId: harness.agentId,
        channelId: 'mobile-ios',
        conversationId: conversation.id,
        text: 'Fail this ordinary run',
        resumable: true,
      });
      await harness.waitForProviderGate(failingRunId, 'beforeSafeBoundary');
      const first = await harness.enqueueInput(firstClient, {
        commandId: testUuid(124),
        inputId: testUuid(125),
        conversationId: conversation.id,
        text: 'first queued after failure',
        behavior: 'followUp',
      });
      const second = await harness.enqueueInput(firstClient, {
        commandId: testUuid(126),
        inputId: testUuid(127),
        conversationId: conversation.id,
        text: 'second queued after failure',
        behavior: 'followUp',
      });
      if (!first.input.runId || !second.input.runId) {
        throw new Error('Failure-pause Follow Ups did not reserve run IDs');
      }
      harness.holdProviderGate(first.input.runId, 'beforeRunTerminal');
      harness.holdProviderGate(second.input.runId, 'beforeRunTerminal');
      harness.releaseProviderGate(failingRunId, 'beforeSafeBoundary');
      await firstClient.waitFor(
        (frame) => frame.type === 'queue_paused' && frame.conversationId === conversation.id,
      );

      await harness.restartGateway();
      let bootstrap = await harness.bootstrapV2(conversation.id);
      expect(bootstrap.queuePaused).toBe(true);
      expect(bootstrap.pendingInputs.map((input) => input.inputId)).toEqual([
        first.input.inputId,
        second.input.inputId,
      ]);
      expect(
        await harness.providerExecutionCount({
          conversationId: conversation.id,
          inputId: first.input.inputId,
        }),
      ).toBe(0);
      expect(
        await harness.providerExecutionCount({
          conversationId: conversation.id,
          inputId: second.input.inputId,
        }),
      ).toBe(0);

      restartedClient = await harness.connectV2();
      await harness.subscribeConversation(restartedClient, {
        commandId: testUuid(128),
        conversationId: conversation.id,
        sinceV2Seq: bootstrap.v2ThroughSeq,
      });
      await harness.resumeFollowUps(restartedClient, {
        commandId: testUuid(129),
        conversationId: conversation.id,
        expectedQueueRevision: bootstrap.queueRevision,
      });
      await harness.waitForProviderGate(first.input.runId, 'beforeRunTerminal');
      expect(
        await harness.providerExecutionCount({
          conversationId: conversation.id,
          inputId: second.input.inputId,
        }),
      ).toBe(0);
      harness.releaseProviderGate(first.input.runId, 'beforeRunTerminal');
      await harness.waitForProviderGate(second.input.runId, 'beforeRunTerminal');
      bootstrap = await harness.bootstrapV2(conversation.id);
      expect(bootstrap.queuePaused).toBe(false);
      expect(
        await harness.providerExecutionCount({
          conversationId: conversation.id,
          inputId: first.input.inputId,
        }),
      ).toBe(1);
      expect(
        await harness.providerExecutionCount({
          conversationId: conversation.id,
          inputId: second.input.inputId,
        }),
      ).toBe(1);
    } finally {
      await firstClient?.close().catch(() => undefined);
      await restartedClient?.close().catch(() => undefined);
      await harness.stop();
    }
  });

  it('exposes exact v1 fallback while the Follow Up v2 health probe returns 404', async () => {
    const harness = await startMobileTestHarness({ scenario: 'follow-up-v1-fallback' });
    let chat: FrameInbox | undefined;
    try {
      const v2Health = await fetch(`${harness.managementBaseUrl}/mobile/v2/health`);
      expect(v2Health.status).toBe(404);
      const v1Health = await fetch(`${harness.managementBaseUrl}/mobile/v1/health`);
      expect(v1Health.status).toBe(200);

      const conversation = await createConversation(harness);
      chat = await openChat(harness);
      const runId = testUuid(131);
      chat.send({
        type: 'message',
        id: runId,
        agentId: harness.agentId,
        channelId: 'mobile-ios',
        conversationId: conversation.id,
        text: 'Use the frozen v1 path',
        resumable: true,
      });
      await chat.waitFor((frame) => frame.type === 'done' && frame.id === runId);
      expect(turnFrames(chat, runId).every((frame) => !('v2Seq' in frame))).toBe(true);
    } finally {
      await chat?.close();
      await harness.stop();
    }
  });

  it('cleans partial listeners after an injected restart failure and safely retries', async () => {
    const harness = await startMobileTestHarness({
      scenario: 'follow-up-v2-restart',
      failRestartOnceAfterManagementListen: true,
    });
    try {
      const stableManagementUrl = harness.managementBaseUrl;
      await expect(harness.restartGateway()).rejects.toThrow('Injected harness restart failure');
      await expect(fetch(`${stableManagementUrl}/mobile/v2/health`)).rejects.toThrow();

      await harness.restartGateway();
      expect(harness.managementBaseUrl).toBe(stableManagementUrl);
      const health = await fetch(`${stableManagementUrl}/mobile/v2/health`);
      expect(health.status).toBe(200);
    } finally {
      await harness.stop();
    }
  });

  it('closes initialization resources after a pre-listener restart failure and safely retries', async () => {
    const harness = await startMobileTestHarness({
      scenario: 'follow-up-v2-restart',
      failRestartOnceDuringInitialization: true,
    });
    try {
      expect(harness.runtimeResourceCounts()).toEqual({ created: 1, closed: 0 });
      await expect(harness.restartGateway()).rejects.toThrow(
        'Injected harness initialization failure',
      );
      expect(harness.runtimeResourceCounts()).toEqual({ created: 2, closed: 2 });

      await harness.restartGateway();
      expect(harness.runtimeResourceCounts()).toEqual({ created: 3, closed: 2 });
      expect((await fetch(`${harness.managementBaseUrl}/mobile/v2/health`)).status).toBe(200);
    } finally {
      await harness.stop();
    }
  });

  it('keeps an invalid v2 socket frame fatal even when a later frame matches the waiter', async () => {
    const harness = await startMobileTestHarness({ scenario: 'follow-up-v2' });
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    let client: Awaited<ReturnType<typeof harness.connectV2>> | undefined;
    try {
      await new Promise<void>((resolve) => server.once('listening', () => resolve()));
      server.on('connection', (socket) => {
        socket.on('message', () => {
          socket.send(
            JSON.stringify({
              type: 'hello_ack',
              contractVersion: 2,
              capabilities: ['chat-input-queue-v1'],
            }),
          );
        });
      });
      const address = server.address() as { port: number };
      client = await harness.connectV2({
        webSocketUrl: `ws://127.0.0.1:${address.port}`,
        token: 'ignored-by-test-server',
      });
      const socket = [...server.clients][0];
      if (!socket) throw new Error('Review regression server did not accept a client');
      const replyId = testUuid(151);
      const conversationId = testUuid(152);
      const runId = testUuid(153);
      socket.send(
        JSON.stringify({
          type: 'done',
          id: runId,
          conversationId,
          runId,
          segmentTurnId: runId,
          v2Seq: 1,
          outcome: 'completed',
        }),
      );
      await vi.waitFor(() => expect(client?.lastV2Seq).toBe(1));
      socket.send('{"type":"not_a_v2_frame"}');
      socket.send(
        JSON.stringify({
          type: 'conversation_subscribed',
          id: replyId,
          conversationId,
          v2ThroughSeq: 1,
        }),
      );
      await vi.waitFor(() =>
        expect(
          client?.frames.some(
            (frame) => frame.type === 'conversation_subscribed' && frame.id === replyId,
          ),
        ).toBe(true),
      );

      await expect(client.waitForV2Seq(1)).rejects.toThrow(/schema validation/);
      await expect(
        client.waitFor((frame) => frame.type === 'conversation_subscribed' && frame.id === replyId),
      ).rejects.toThrow(/schema validation/);
    } finally {
      await client?.close().catch(() => undefined);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await harness.stop();
    }
  });

  it('rejects provider execution envelopes containing anything beyond IDs and counts', async () => {
    const harness = await startMobileTestHarness({ scenario: 'follow-up-v2' });
    const realFetch = globalThis.fetch;
    try {
      globalThis.fetch = vi.fn(async () =>
        Response.json({ executions: [], prompt: 'must never cross the harness boundary' }),
      );
      await expect(harness.providerExecutions('review-conversation')).rejects.toThrow(
        'provider execution response is invalid',
      );
    } finally {
      globalThis.fetch = realFetch;
      await harness.stop();
    }
  });

  it('exposes sanitized failure, release, and execution controls on the pinned mobile surface', async () => {
    const harness = await startMobileTestHarness({ scenario: 'follow-up-v2' });
    let client: Awaited<ReturnType<typeof harness.connectV2>> | undefined;
    try {
      const conversation = await createV2Conversation(harness, testUuid(161));
      client = await harness.connectV2();
      await harness.subscribeConversation(client, {
        commandId: testUuid(162),
        conversationId: conversation.id,
      });
      const runId = testUuid(163);
      client.send({
        type: 'message',
        id: runId,
        agentId: harness.agentId,
        channelId: 'mobile-ios',
        conversationId: conversation.id,
        text: 'Fail through the public test control',
        resumable: true,
      });
      await harness.waitForProviderGate(runId, 'beforeSafeBoundary');

      const failed = await pinnedJsonRequest(
        harness,
        '/mobile/v2/__mobile-test/provider-runs/fail',
        { method: 'POST', body: { runId } },
      );
      expect(failed).toEqual({ status: 200, value: { ok: true } });
      const released = await pinnedJsonRequest(
        harness,
        '/mobile/v2/__mobile-test/provider-gates/release',
        { method: 'POST', body: { runId, gate: 'beforeSafeBoundary' } },
      );
      expect(released).toEqual({ status: 200, value: { ok: true } });
      await client.waitFor((frame) => frame.type === 'error' && frame.runId === runId);

      const observed = await pinnedJsonRequest(
        harness,
        `/mobile/v2/__mobile-test/provider-executions?conversationId=${encodeURIComponent(
          conversation.id,
        )}`,
      );
      expect(observed.status).toBe(200);
      expect(Object.keys(observed.value as object)).toEqual(['executions']);
      expect(observed.value).toEqual({ executions: [{ runId, inputId: null, count: 1 }] });
    } finally {
      await client?.close().catch(() => undefined);
      await harness.stop();
    }
  });

  it('stops gateway services without deleting state and restarts them on the same URLs', async () => {
    const harness = await startMobileTestHarness({ scenario: 'follow-up-v2-restart' });
    try {
      const conversation = await createV2Conversation(harness, testUuid(141));
      const urls = {
        managementBaseUrl: harness.managementBaseUrl,
        chatWebSocketUrl: harness.chatWebSocketUrl,
        mobileBaseUrl: harness.mobileBaseUrl,
        mobileChatWebSocketUrl: harness.mobileChatWebSocketUrl,
      };
      await harness.stopGateway();
      await expect(fetch(`${harness.managementBaseUrl}/mobile/v2/health`)).rejects.toThrow();

      await harness.restartGateway();
      expect({
        managementBaseUrl: harness.managementBaseUrl,
        chatWebSocketUrl: harness.chatWebSocketUrl,
        mobileBaseUrl: harness.mobileBaseUrl,
        mobileChatWebSocketUrl: harness.mobileChatWebSocketUrl,
      }).toEqual(urls);
      expect((await harness.bootstrapV2(conversation.id)).conversation.id).toBe(conversation.id);
    } finally {
      await harness.stop();
    }
  });

  it('recovers a gracefully interrupted run and hands its queued Follow Up off after restart', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dash-mobile-recovery-'));
    let first: RunningMobileTestHarness | undefined;
    let second: RunningMobileTestHarness | undefined;
    let chat: V2FrameInbox | undefined;
    try {
      first = await startMobileTestHarness({ dataDir, scenario: 'slow' });
      const originalAgentId = first.agentId;
      const conversation = await createConversation(first);
      chat = await openV2Chat(first);
      const subscriptionId = randomUUID();
      chat.send({
        type: 'subscribe_conversation',
        id: subscriptionId,
        agentId: first.agentId,
        conversationId: conversation.id,
        sinceV2Seq: 0,
      });
      await chat.waitFor(
        (frame) => frame.type === 'conversation_subscribed' && frame.id === subscriptionId,
      );
      const runId = randomUUID();
      chat.send({
        type: 'message',
        id: runId,
        agentId: first.agentId,
        channelId: 'mobile-ios',
        conversationId: conversation.id,
        text: 'Interrupt this during shutdown',
        resumable: true,
      });
      await chat.waitFor(
        (frame) =>
          frame.type === 'event' && frame.runId === runId && frame.event.type === 'text_delta',
      );
      const queuedInputId = randomUUID();
      const enqueueId = randomUUID();
      chat.send({
        type: 'enqueue_input',
        id: enqueueId,
        inputId: queuedInputId,
        agentId: first.agentId,
        channelId: 'mobile-ios',
        conversationId: conversation.id,
        text: 'Run after restart',
        behavior: 'followUp',
      });
      const accepted = await chat.waitFor(
        (frame) =>
          frame.type === 'input_accepted' &&
          frame.id === enqueueId &&
          frame.input.inputId === queuedInputId,
      );
      if (accepted.type !== 'input_accepted' || !accepted.input.runId) {
        throw new Error('Recovered Follow Up acknowledgement did not reserve a run');
      }
      const queuedRunId = accepted.input.runId;

      await settlesWithin(first.stop());
      first = undefined;
      chat = undefined;

      second = await startMobileTestHarness({ dataDir, scenario: 'stream' });
      expect(second.agentId).toBe(originalAgentId);
      await vi.waitFor(
        async () => {
          const response = await mobileV2Request(
            second as RunningMobileTestHarness,
            `/conversations/${conversation.id}/bootstrap`,
          );
          expect(response.status).toBe(200);
          const bootstrap = (await response.json()) as MobileV2ConversationBootstrap;
          expect(bootstrap.conversation).toMatchObject({ status: 'idle', activeTurnId: null });
          expect(bootstrap.pendingInputs).toEqual([]);
          const recoveredRunMessages = bootstrap.messages.filter(
            (message) => message.runId === queuedRunId,
          );
          expect(recoveredRunMessages).toHaveLength(2);
          expect(recoveredRunMessages).toEqual([
            expect.objectContaining({
              role: 'user',
              status: 'accepted',
              content: { type: 'user', text: 'Run after restart' },
              runId: queuedRunId,
              deliveryKind: 'follow_up',
            }),
            expect.objectContaining({
              role: 'assistant',
              status: 'completed',
              runId: queuedRunId,
              deliveryKind: 'follow_up',
            }),
          ]);
        },
        { timeout: 4_000 },
      );

      const replayResponse = await mobileV2Request(
        second,
        `/agents/${second.agentId}/conversations/${conversation.id}/events?sinceV2Seq=0`,
      );
      expect(replayResponse.status).toBe(200);
      const replay = (await replayResponse.json()) as MobileV2ReplayPage;
      expect(
        replay.frames.filter(
          (frame) => frame.type === 'input_accepted' && frame.input.inputId === queuedInputId,
        ),
      ).toHaveLength(1);
      expect(
        replay.frames.filter(
          (frame) => frame.type === 'input_delivered' && frame.input.inputId === queuedInputId,
        ),
      ).toEqual([
        expect.objectContaining({
          type: 'input_delivered',
          input: expect.objectContaining({ inputId: queuedInputId, runId: queuedRunId }),
        }),
      ]);
      expect(
        replay.frames.filter((frame) => frame.type === 'done' && frame.runId === queuedRunId),
      ).toEqual([
        expect.objectContaining({ type: 'done', runId: queuedRunId, outcome: 'completed' }),
      ]);
    } finally {
      await chat?.close().catch(() => undefined);
      await first?.stop();
      await second?.stop();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('exercises strict agent actions and the complete stream conversation lifecycle', async () => {
    const harness = await startMobileTestHarness({ scenario: 'stream' });
    let chat: FrameInbox | undefined;
    try {
      const identity = await mobileRequest(harness, '/identity');
      expect(identity.status).toBe(200);
      expect(await identity.json()).toEqual({
        gatewayId: harness.gatewayId,
        publicKey: 'mobile-test-public-key',
      });

      const invalidAgent = await mobileRequest(harness, '/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'invalid-mobile-agent',
          model: 'test/scripted',
          systemPrompt: 'Invalid extra field.',
          tools: [],
        }),
      });
      expect(invalidAgent.status).toBe(400);
      expect(await invalidAgent.json()).toMatchObject({
        code: 'validation_failed',
        retryable: false,
      });

      const createAgent = await mobileRequest(harness, '/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'phone-created-agent',
          model: 'test/scripted',
          systemPrompt: 'Created through mobile v1.',
        }),
      });
      expect(createAgent.status).toBe(201);
      const createdAgent = (await createAgent.json()) as { id: string; status: string };
      const detail = await mobileRequest(harness, `/agents/${createdAgent.id}`);
      expect(detail.status).toBe(200);

      const updateAgent = await mobileRequest(harness, `/agents/${createdAgent.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'test/scripted-v2',
          systemPrompt: 'Updated through mobile v1.',
        }),
      });
      expect(updateAgent.status).toBe(200);
      expect(await updateAgent.json()).toMatchObject({
        id: createdAgent.id,
        config: { model: 'test/scripted-v2', systemPrompt: 'Updated through mobile v1.' },
      });

      for (const action of ['disable', 'enable']) {
        const response = await mobileRequest(harness, `/agents/${createdAgent.id}/${action}`, {
          method: 'POST',
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true });
      }
      const missingAction = await mobileRequest(harness, '/agents/missing-agent/enable', {
        method: 'POST',
      });
      expect(missingAction.status).toBe(404);
      expect(await missingAction.json()).toMatchObject({ code: 'not_found', retryable: false });
      const unauthorizedAction = await fetch(
        `${harness.managementBaseUrl}/mobile/v1/agents/${createdAgent.id}/disable`,
        { method: 'POST' },
      );
      expect(unauthorizedAction.status).toBe(401);
      expect(await unauthorizedAction.json()).toMatchObject({
        code: 'unauthorized',
        retryable: false,
      });

      const conversation = await createConversation(harness);
      chat = await openChat(harness);
      const turnId = randomUUID();
      chat.send({
        type: 'message',
        id: turnId,
        agentId: harness.agentId,
        channelId: 'mobile-ios',
        conversationId: conversation.id,
        text: 'Say hello',
        resumable: true,
      });
      await chat.waitFor((frame) => frame.type === 'done' && frame.id === turnId);
      const frames = turnFrames(chat, turnId);
      expect(frames.map((frame) => frame.type)).toEqual([
        'accepted',
        'event',
        'event',
        'event',
        'done',
      ]);
      expect(frames.map((frame) => frame.seq)).toEqual([1, 2, 3, 4, 5]);
      expect(frames.filter((frame) => frame.type === 'event').map((frame) => frame.event)).toEqual([
        { type: 'text_delta', text: 'Hello' },
        { type: 'text_delta', text: ' from Dash' },
        {
          type: 'response',
          content: 'Hello from Dash',
          usage: { inputTokens: 4, outputTokens: 3 },
        },
      ]);

      const messagesResponse = await mobileRequest(
        harness,
        `/conversations/${conversation.id}/messages`,
      );
      expect(messagesResponse.status).toBe(200);
      const messages = (await messagesResponse.json()) as ConversationMessagePage;
      expect(messages.throughSeq).toBe(5);
      expect(messages.items).toHaveLength(2);
      expect(messages.items[1]).toMatchObject({
        turnId,
        role: 'assistant',
        status: 'completed',
        content: { type: 'assistant', events: expect.any(Array) },
      });

      const replayResponse = await mobileRequest(
        harness,
        `/agents/${harness.agentId}/conversations/${conversation.id}/events?sinceSeq=0`,
      );
      expect(replayResponse.status).toBe(200);
      const replay = (await replayResponse.json()) as ReplayPage;
      expect(replay.entries.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5]);

      let current = (await (
        await mobileRequest(harness, `/conversations/${conversation.id}`)
      ).json()) as ConversationSummary;
      await vi.waitFor(async () => {
        current = (await (
          await mobileRequest(harness, `/conversations/${conversation.id}`)
        ).json()) as ConversationSummary;
        expect(current.title).toBe('Mobile test conversation');
      });
      const renamedResponse = await mobileRequest(harness, `/conversations/${conversation.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'If-Match': `"${current.revision}"`,
        },
        body: JSON.stringify({ title: 'Renamed on phone' }),
      });
      expect(renamedResponse.status).toBe(200);
      const renamed = (await renamedResponse.json()) as ConversationSummary;
      expect(renamed.title).toBe('Renamed on phone');

      const deletedResponse = await mobileRequest(harness, `/conversations/${conversation.id}`, {
        method: 'DELETE',
        headers: { 'If-Match': `"${renamed.revision}"` },
      });
      expect(deletedResponse.status).toBe(200);
      const tombstone = (await deletedResponse.json()) as ConversationSummary;
      expect(tombstone).toMatchObject({ id: conversation.id, status: 'deleted', lastSeq: 5 });
      const tombstoneRead = await mobileRequest(harness, `/conversations/${conversation.id}`);
      expect(await tombstoneRead.json()).toMatchObject({ id: conversation.id, status: 'deleted' });
    } finally {
      await chat?.close();
      await harness.stop();
    }
  });

  it('detaches after the first event and resumes without duplicate durable sequences', async () => {
    const harness = await startMobileTestHarness({ scenario: 'stream' });
    let first: FrameInbox | undefined;
    let resumed: FrameInbox | undefined;
    try {
      const conversation = await createConversation(harness);
      const turnId = randomUUID();
      first = await openChat(harness);
      first.send({
        type: 'message',
        id: turnId,
        agentId: harness.agentId,
        channelId: 'mobile-ios',
        conversationId: conversation.id,
        text: 'Keep streaming',
        resumable: true,
      });
      await first.waitFor((frame) => frame.type === 'event' && frame.id === turnId);
      await first.close();
      const firstFrames = turnFrames(first, turnId);
      const sinceSeq = Math.max(...firstFrames.map((frame) => frame.seq ?? 0));

      resumed = await openChat(harness);
      resumed.send({
        type: 'resume',
        id: turnId,
        agentId: harness.agentId,
        conversationId: conversation.id,
        sinceSeq,
      });
      await resumed.waitFor((frame) => frame.type === 'done' && frame.id === turnId);

      const allFrames = [...firstFrames, ...turnFrames(resumed, turnId)];
      const sequences = allFrames.map((frame) => frame.seq as number);
      expect(sequences).toEqual([1, 2, 3, 4, 5]);
      expect(new Set(sequences).size).toBe(sequences.length);
      const messages = (await (
        await mobileRequest(harness, `/conversations/${conversation.id}/messages`)
      ).json()) as ConversationMessagePage;
      expect(messages.items).toHaveLength(2);
      expect(messages.items[1]).toMatchObject({ status: 'completed' });
    } finally {
      await first?.close();
      await resumed?.close();
      await harness.stop();
    }
  });

  it('unblocks the question backend through the production answer frame', async () => {
    const harness = await startMobileTestHarness({ scenario: 'question' });
    let chat: FrameInbox | undefined;
    try {
      const conversation = await createConversation(harness);
      const turnId = randomUUID();
      chat = await openChat(harness);
      chat.send({
        type: 'message',
        id: turnId,
        agentId: harness.agentId,
        channelId: 'mobile-ios',
        conversationId: conversation.id,
        text: 'Choose',
        resumable: true,
      });
      await chat.waitFor(
        (frame) =>
          frame.type === 'event' &&
          frame.id === turnId &&
          frame.event.type === 'question' &&
          frame.event.id === 'question-01',
      );
      chat.send({ type: 'answer', id: turnId, questionId: 'question-01', answer: 'Blue' });
      await chat.waitFor((frame) => frame.type === 'done' && frame.id === turnId);
      expect(turnFrames(chat, turnId)).toContainEqual(
        expect.objectContaining({
          type: 'event',
          event: {
            type: 'response',
            content: 'Selected: Blue',
            usage: { inputTokens: 5, outputTokens: 2 },
          },
        }),
      );
    } finally {
      await chat?.close();
      await harness.stop();
    }
  });

  it('preserves a busy slow turn until explicit cancel and revision-refreshed delete', async () => {
    const harness = await startMobileTestHarness({ scenario: 'slow' });
    let owner: FrameInbox | undefined;
    let competitor: FrameInbox | undefined;
    try {
      const conversation = await createConversation(harness);
      const activeTurnId = randomUUID();
      owner = await openChat(harness);
      owner.send({
        type: 'message',
        id: activeTurnId,
        agentId: harness.agentId,
        channelId: 'mobile-ios',
        conversationId: conversation.id,
        text: 'Work slowly',
        resumable: true,
      });
      await owner.waitFor(
        (frame) =>
          frame.type === 'event' && frame.id === activeTurnId && frame.event.type === 'text_delta',
      );

      competitor = await openChat(harness);
      const competingTurnId = randomUUID();
      competitor.send({
        type: 'message',
        id: competingTurnId,
        agentId: harness.agentId,
        channelId: 'mobile-ios',
        conversationId: conversation.id,
        text: 'Compete',
        resumable: true,
      });
      const socketBusy = await competitor.waitFor(
        (frame) => frame.type === 'error' && frame.id === competingTurnId,
      );
      expect(socketBusy).toMatchObject({
        code: 'conversation_busy',
        activeTurnId,
        conversationId: conversation.id,
      });

      const running = (await (
        await mobileRequest(harness, `/conversations/${conversation.id}`)
      ).json()) as ConversationSummary;
      const busyDelete = await mobileRequest(harness, `/conversations/${conversation.id}`, {
        method: 'DELETE',
        headers: { 'If-Match': `"${running.revision}"` },
      });
      expect(busyDelete.status).toBe(409);
      const restBusy = (await busyDelete.json()) as {
        code: string;
        retryable: boolean;
        details: { activeTurnId: string };
      };
      expect(restBusy).toMatchObject({
        code: 'conversation_busy',
        details: { activeTurnId },
      });
      expect(restBusy.details.activeTurnId).toBe(
        (socketBusy as { activeTurnId?: string }).activeTurnId,
      );
      const retained = (await (
        await mobileRequest(harness, `/conversations/${conversation.id}/messages`)
      ).json()) as ConversationMessagePage;
      expect(retained.items).toHaveLength(2);

      owner.send({ type: 'cancel', id: activeTurnId });
      const cancelled = await owner.waitFor(
        (frame) => frame.type === 'done' && frame.id === activeTurnId,
      );
      expect(cancelled).toMatchObject({ outcome: 'cancelled' });
      const released = (await (
        await mobileRequest(harness, `/conversations/${conversation.id}`)
      ).json()) as ConversationSummary;
      expect(released.activeTurnId).toBeNull();

      const deleted = await mobileRequest(harness, `/conversations/${conversation.id}`, {
        method: 'DELETE',
        headers: { 'If-Match': `"${released.revision}"` },
      });
      expect(deleted.status).toBe(200);
      expect(await deleted.json()).toMatchObject({ status: 'deleted', activeTurnId: null });
    } finally {
      await owner?.close();
      await competitor?.close();
      await harness.stop();
    }
  });

  it('keeps archived REST history readable after deleting its agent', async () => {
    const harness = await startMobileTestHarness({ scenario: 'stream' });
    let chat: FrameInbox | undefined;
    try {
      const conversation = await createConversation(harness);
      const turnId = randomUUID();
      chat = await openChat(harness);
      chat.send({
        type: 'message',
        id: turnId,
        agentId: harness.agentId,
        channelId: 'mobile-ios',
        conversationId: conversation.id,
        text: 'Retain this',
        resumable: true,
      });
      await chat.waitFor((frame) => frame.type === 'done' && frame.id === turnId);
      await chat.close();

      const deletedAgent = await mobileRequest(harness, `/agents/${harness.agentId}`, {
        method: 'DELETE',
      });
      expect(deletedAgent.status).toBe(200);
      expect(await deletedAgent.json()).toEqual({ ok: true });

      const archived = await mobileRequest(harness, `/conversations/${conversation.id}`);
      expect(archived.status).toBe(200);
      expect(await archived.json()).toMatchObject({
        id: conversation.id,
        agentId: harness.agentId,
        agentName: 'mobile-test-agent',
        status: 'archived',
      });
      const messages = await mobileRequest(harness, `/conversations/${conversation.id}/messages`);
      expect(messages.status).toBe(200);
      expect(((await messages.json()) as ConversationMessagePage).items).toHaveLength(2);
      const replay = await mobileRequest(
        harness,
        `/agents/${harness.agentId}/conversations/${conversation.id}/events`,
      );
      expect(replay.status).toBe(200);
      expect(((await replay.json()) as ReplayPage).entries).toHaveLength(5);
    } finally {
      await chat?.close();
      await harness.stop();
    }
  });
});
