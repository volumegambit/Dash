import { createHash, randomUUID } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import type {
  ConversationMessagePage,
  ConversationSummary,
  MobileWsServerFrame,
  ReplayPage,
} from '@dash/mobile-contract';
import { WebSocket } from 'ws';
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

  it('stops promptly without client cancellation while an SSE response is open', async () => {
    const harness = await startMobileTestHarness({ scenario: 'stream' });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const eventsResponsePromise = fetch(`${harness.managementBaseUrl}/mobile/v1/events`, {
        headers: { Authorization: `Bearer ${harness.chatToken}` },
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
