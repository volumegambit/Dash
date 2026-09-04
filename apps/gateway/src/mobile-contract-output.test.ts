import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConversationSummary, MobileWsServerFrame } from '@dash/mobile-contract';
import addFormats from 'ajv-formats';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { WebSocket } from 'ws';
import { parse } from 'yaml';
import { type RunningMobileTestHarness, startMobileTestHarness } from './mobile-test-harness.js';

type ContractDocument = 'openapi' | 'chat-ws';
type JsonObject = Record<string, unknown>;

const contractRoot = fileURLToPath(new URL('../../../contracts/mobile/v1/', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const fixturesRoot = join(contractRoot, 'fixtures');
const openapi = parse(readFileSync(join(contractRoot, 'openapi.yaml'), 'utf8')) as object;
const chatWs = JSON.parse(
  readFileSync(join(contractRoot, 'chat-ws.schema.json'), 'utf8'),
) as object;
const ajv = new Ajv2020({ allErrors: true, strict: false });
(addFormats as unknown as (instance: Ajv2020) => void)(ajv);
ajv.addSchema(openapi, 'mobile-openapi');
ajv.addSchema(chatWs, 'mobile-chat-ws');

function expectSchema(document: ContractDocument, schema: string, value: unknown): void {
  const prefix =
    document === 'openapi' ? 'mobile-openapi#/components/schemas/' : 'mobile-chat-ws#/$defs/';
  const validate = ajv.compile({ $ref: `${prefix}${schema}` });
  expect(validate(value), ajv.errorsText(validate.errors)).toBe(true);
}

function loadFixture<T>(name: string): T {
  const raw = readFileSync(join(fixturesRoot, name), 'utf8');
  if (name.endsWith('.txt')) {
    const data = raw
      .split('\n')
      .find((line) => line.startsWith('data: '))
      ?.slice(6);
    if (!data) throw new Error(`SSE fixture has no data record: ${name}`);
    return JSON.parse(data) as T;
  }
  return JSON.parse(raw) as T;
}

function firstObject(value: unknown): JsonObject {
  const candidate = Array.isArray(value) ? value[0] : value;
  expect(candidate).toBeTruthy();
  expect(typeof candidate).toBe('object');
  expect(Array.isArray(candidate)).toBe(false);
  return candidate as JsonObject;
}

function expectFixtureKeys(
  name: string,
  emitted: unknown,
  requiredKeys: string[],
  discriminators: string[] = ['type'],
): void {
  const canonical = firstObject(loadFixture<unknown>(name));
  const actual = firstObject(emitted);
  const expectedKeySet = new Set(Object.keys(canonical));
  expect(Object.keys(actual).filter((key) => !expectedKeySet.has(key))).toEqual([]);
  expect(requiredKeys.every((key) => Object.hasOwn(canonical, key))).toBe(true);
  expect(requiredKeys.every((key) => Object.hasOwn(actual, key))).toBe(true);
  for (const discriminator of discriminators) {
    if (Object.hasOwn(canonical, discriminator)) {
      expect(actual[discriminator]).toBe(canonical[discriminator]);
    }
  }
}

function exampleFrame(markdown: string, type: string): JsonObject {
  const matches = markdown
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{') && line.endsWith('}'))
    .map((line) => firstObject(JSON.parse(line) as unknown))
    .filter((value) => value.type === type);
  expect(matches).toHaveLength(1);
  return matches[0];
}

function mobileRequest(
  harness: RunningMobileTestHarness,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${harness.chatToken}`);
  return fetch(`${harness.managementBaseUrl}/mobile/v1${path}`, { ...init, headers });
}

async function createConversation(harness: RunningMobileTestHarness): Promise<ConversationSummary> {
  const canonical = loadFixture<JsonObject>('conversation-create.json');
  const response = await mobileRequest(harness, '/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...canonical,
      agentId: harness.agentId,
      requestId: randomUUID(),
    }),
  });
  expect(response.status).toBe(201);
  const conversation = (await response.json()) as ConversationSummary;
  expectSchema('openapi', 'ConversationSummary', conversation);
  return conversation;
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

class SseInbox {
  private buffer = '';
  private readonly decoder = new TextDecoder();

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  async next(): Promise<JsonObject> {
    while (true) {
      const end = this.buffer.indexOf('\n\n');
      if (end >= 0) {
        const block = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 2);
        if (block.startsWith(':')) continue;
        const event = block
          .split('\n')
          .find((line) => line.startsWith('event: '))
          ?.slice(7);
        const data = block
          .split('\n')
          .find((line) => line.startsWith('data: '))
          ?.slice(6);
        if (!event || !data) throw new Error(`Malformed SSE block: ${block}`);
        const value = JSON.parse(data) as JsonObject;
        expect(value.type).toBe(event);
        return value;
      }
      const chunk = await this.reader.read();
      if (chunk.done) throw new Error('SSE stream ended before the expected event');
      this.buffer += this.decoder.decode(chunk.value, { stream: true });
    }
  }
}

describe('mobile harness emitted contract output', () => {
  it('documents the mobile conversation surface', async () => {
    const docs = await readFile(join(repoRoot, 'docs/api-reference.mdx'), 'utf8');
    for (const term of [
      'conversation-sync-v1',
      'chat-resume-v1',
      'GET /identity',
      'GET /conversations',
      'POST /conversations',
      'PATCH /conversations/:id',
      'DELETE /conversations/:id',
      'GET /conversations/:id/messages',
      'revision_conflict',
      'conversation_busy',
    ]) {
      expect(docs).toContain(term);
    }
  });

  it('keeps documented WebSocket examples valid against the frozen contract', async () => {
    const apiReference = await readFile(join(repoRoot, 'docs/api-reference.mdx'), 'utf8');
    const troubleshooting = await readFile(join(repoRoot, 'docs/troubleshooting.mdx'), 'utf8');
    const message = exampleFrame(apiReference, 'message');
    const accepted = exampleFrame(apiReference, 'accepted');
    const resume = exampleFrame(troubleshooting, 'resume');

    expectSchema('chat-ws', 'ChatSend', message);
    expectSchema('chat-ws', 'MobileWsClientFrame', message);
    expectSchema('chat-ws', 'ChatAccepted', accepted);
    expectSchema('chat-ws', 'MobileWsServerFrame', accepted);
    expectSchema('chat-ws', 'ChatResume', resume);
    expectSchema('chat-ws', 'MobileWsClientFrame', resume);
  });

  it('validates real health, identity, agent, action, conversation, and error DTOs', async () => {
    const harness = await startMobileTestHarness({ scenario: 'stream' });
    try {
      const healthResponse = await fetch(`${harness.managementBaseUrl}/mobile/v1/health`);
      expect(healthResponse.status).toBe(200);
      const health = await healthResponse.json();
      expectSchema('openapi', 'MobileHealth', health);
      expectFixtureKeys('health-capabilities.json', health, [
        'status',
        'startedAt',
        'pid',
        'agents',
        'channels',
        'apiVersion',
        'capabilities',
      ]);

      const identityResponse = await mobileRequest(harness, '/identity');
      expect(identityResponse.status).toBe(200);
      const identity = await identityResponse.json();
      expectSchema('openapi', 'GatewayIdentity', identity);
      expectFixtureKeys('identity.json', identity, ['gatewayId', 'publicKey']);

      const agentsResponse = await mobileRequest(harness, '/agents');
      expect(agentsResponse.status).toBe(200);
      const agents = await agentsResponse.json();
      expectSchema('openapi', 'MobileAgentList', agents);
      expectFixtureKeys('agents-list.json', agents, [
        'id',
        'name',
        'config',
        'status',
        'registeredAt',
      ]);

      const createBody = loadFixture<JsonObject>('agent-create.json');
      const createResponse = await mobileRequest(harness, '/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createBody),
      });
      expect(createResponse.status).toBe(201);
      const created = (await createResponse.json()) as JsonObject;
      expectSchema('openapi', 'MobileAgent', created);
      expectFixtureKeys(
        'agents-list.json',
        [created],
        ['id', 'name', 'config', 'status', 'registeredAt'],
      );

      const detailResponse = await mobileRequest(harness, `/agents/${created.id}`);
      expect(detailResponse.status).toBe(200);
      expectSchema('openapi', 'MobileAgent', await detailResponse.json());

      const updateResponse = await mobileRequest(harness, `/agents/${created.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(loadFixture<JsonObject>('agent-update.json')),
      });
      expect(updateResponse.status).toBe(200);
      expectSchema('openapi', 'MobileAgent', await updateResponse.json());

      for (const action of ['disable', 'enable']) {
        const response = await mobileRequest(harness, `/agents/${created.id}/${action}`, {
          method: 'POST',
        });
        expect(response.status).toBe(200);
        const value = await response.json();
        expectSchema('openapi', 'MobileActionResponse', value);
        expectFixtureKeys('agent-action-ok.json', value, ['ok']);

        const unauthorizedResponse = await fetch(
          `${harness.managementBaseUrl}/mobile/v1/agents/${created.id}/${action}`,
          { method: 'POST' },
        );
        expect(unauthorizedResponse.status).toBe(401);
        const unauthorized = await unauthorizedResponse.json();
        expectSchema('openapi', 'MobileApiError', unauthorized);
        expectFixtureKeys(
          'errors/unauthorized.json',
          unauthorized,
          ['code', 'error', 'retryable'],
          ['code'],
        );

        const missingResponse = await mobileRequest(harness, `/agents/missing/${action}`, {
          method: 'POST',
        });
        expect(missingResponse.status).toBe(404);
        const missing = await missingResponse.json();
        expectSchema('openapi', 'MobileApiError', missing);
        expectFixtureKeys(
          'errors/not-found.json',
          missing,
          ['code', 'error', 'retryable'],
          ['code'],
        );
      }

      const invalidResponse = await mobileRequest(harness, '/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...createBody, tools: [] }),
      });
      expect(invalidResponse.status).toBe(400);
      const invalid = await invalidResponse.json();
      expectSchema('openapi', 'MobileApiError', invalid);
      expectFixtureKeys(
        'errors/validation-failed.json',
        invalid,
        ['code', 'error', 'retryable'],
        ['code'],
      );

      const conversation = await createConversation(harness);
      expectFixtureKeys('conversation-summary.json', conversation, [
        'id',
        'agentId',
        'agentName',
        'title',
        'revision',
        'status',
        'activeTurnId',
        'owningIssueId',
        'projectId',
        'lastSeq',
        'lastMessagePreview',
        'createdAt',
        'updatedAt',
      ]);

      const listResponse = await mobileRequest(harness, '/conversations');
      expect(listResponse.status).toBe(200);
      const list = await listResponse.json();
      expectSchema('openapi', 'ConversationPage', list);
      expectFixtureKeys('conversations-page.json', list, ['items', 'nextCursor']);

      const conflictResponse = await mobileRequest(harness, `/conversations/${conversation.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'If-Match': `"${conversation.revision + 1}"`,
        },
        body: JSON.stringify(loadFixture<JsonObject>('conversation-patch.json')),
      });
      expect(conflictResponse.status).toBe(409);
      const conflict = await conflictResponse.json();
      expectSchema('openapi', 'RevisionConflictError', conflict);
      expectFixtureKeys(
        'errors/revision-conflict.json',
        conflict,
        ['code', 'error', 'retryable', 'details'],
        ['code'],
      );

      const patchResponse = await mobileRequest(harness, `/conversations/${conversation.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'If-Match': `"${conversation.revision}"`,
        },
        body: JSON.stringify(loadFixture<JsonObject>('conversation-patch.json')),
      });
      expect(patchResponse.status).toBe(200);
      expectSchema('openapi', 'ConversationSummary', await patchResponse.json());
    } finally {
      await harness.stop();
    }
  });

  it('validates accepted, event, done, transcript, replay, and probe error output', async () => {
    const harness = await startMobileTestHarness({ scenario: 'stream' });
    let chat: FrameInbox | undefined;
    try {
      const conversation = await createConversation(harness);
      chat = await openChat(harness);
      const turnId = randomUUID();
      const send = {
        ...loadFixture<JsonObject>('chat-send.json'),
        id: turnId,
        agentId: harness.agentId,
        conversationId: conversation.id,
      };
      expectSchema('chat-ws', 'MobileWsClientFrame', send);
      chat.send(send);
      await chat.waitFor((frame) => frame.type === 'done' && frame.id === turnId);

      const frames = chat.frames.filter((frame) => frame.id === turnId);
      expect(frames.map((frame) => frame.type)).toEqual([
        'accepted',
        'event',
        'event',
        'event',
        'done',
      ]);
      for (const frame of frames) {
        expectSchema('chat-ws', 'MobileWsServerFrame', frame);
        if (frame.type === 'accepted') {
          expectSchema('chat-ws', 'ChatAccepted', frame);
          expectFixtureKeys('chat-accepted.json', frame, [
            'type',
            'id',
            'conversationId',
            'userMessageId',
            'assistantMessageId',
            'revision',
            'seq',
          ]);
        } else if (frame.type === 'event') {
          expectSchema('chat-ws', 'ChatEvent', frame);
          expectFixtureKeys('chat-event.json', frame, [
            'type',
            'id',
            'conversationId',
            'seq',
            'event',
          ]);
        } else if (frame.type === 'done') {
          expectSchema('chat-ws', 'ChatDone', frame);
          expectFixtureKeys('chat-done.json', frame, [
            'type',
            'id',
            'conversationId',
            'seq',
            'outcome',
          ]);
        }
      }

      const messagesResponse = await mobileRequest(
        harness,
        `/conversations/${conversation.id}/messages`,
      );
      expect(messagesResponse.status).toBe(200);
      const messages = await messagesResponse.json();
      expectSchema('openapi', 'ConversationMessagePage', messages);
      expectFixtureKeys('conversation-messages-page.json', messages, [
        'items',
        'nextCursor',
        'throughSeq',
      ]);

      const replayResponse = await mobileRequest(
        harness,
        `/agents/${harness.agentId}/conversations/${conversation.id}/events?sinceSeq=0`,
      );
      expect(replayResponse.status).toBe(200);
      const replay = await replayResponse.json();
      expectSchema('openapi', 'ReplayPage', replay);
      expectFixtureKeys('replay.json', replay, ['entries']);

      const probeId = randomUUID();
      const probe = {
        ...loadFixture<JsonObject>('chat-resume.json'),
        id: probeId,
        agentId: harness.agentId,
        conversationId: randomUUID(),
        sinceSeq: 0,
      };
      expectSchema('chat-ws', 'MobileWsClientFrame', probe);
      chat.send(probe);
      const probeError = await chat.waitFor(
        (frame) => frame.type === 'error' && frame.id === probeId,
      );
      expectSchema('chat-ws', 'MobileWsServerFrame', probeError);
      expect(probeError).not.toHaveProperty('seq');
    } finally {
      await chat?.close();
      await harness.stop();
    }
  });

  it('validates real busy REST/WebSocket errors and cancelled terminal output', async () => {
    const harness = await startMobileTestHarness({ scenario: 'slow' });
    let owner: FrameInbox | undefined;
    let competitor: FrameInbox | undefined;
    try {
      const conversation = await createConversation(harness);
      owner = await openChat(harness);
      const activeTurnId = randomUUID();
      owner.send({
        ...loadFixture<JsonObject>('chat-send.json'),
        id: activeTurnId,
        agentId: harness.agentId,
        conversationId: conversation.id,
      });
      await owner.waitFor(
        (frame) =>
          frame.type === 'event' && frame.id === activeTurnId && frame.event.type === 'text_delta',
      );

      competitor = await openChat(harness);
      const competingTurnId = randomUUID();
      competitor.send({
        ...loadFixture<JsonObject>('chat-send.json'),
        id: competingTurnId,
        agentId: harness.agentId,
        conversationId: conversation.id,
      });
      const busyFrame = await competitor.waitFor(
        (frame) => frame.type === 'error' && frame.id === competingTurnId,
      );
      expectSchema('chat-ws', 'MobileWsServerFrame', busyFrame);
      expectFixtureKeys('chat-error.json', busyFrame, ['type', 'id', 'error'], ['type', 'code']);

      const runningResponse = await mobileRequest(harness, `/conversations/${conversation.id}`);
      const running = (await runningResponse.json()) as ConversationSummary;
      expectSchema('openapi', 'ConversationSummary', running);
      const busyResponse = await mobileRequest(harness, `/conversations/${conversation.id}`, {
        method: 'DELETE',
        headers: { 'If-Match': `"${running.revision}"` },
      });
      expect(busyResponse.status).toBe(409);
      const busy = await busyResponse.json();
      expectSchema('openapi', 'ConversationBusyError', busy);
      expectFixtureKeys(
        'errors/conversation-busy.json',
        busy,
        ['code', 'error', 'retryable', 'details'],
        ['code'],
      );

      const cancel = {
        ...loadFixture<JsonObject>('chat-cancel.json'),
        id: activeTurnId,
      };
      expectSchema('chat-ws', 'MobileWsClientFrame', cancel);
      owner.send(cancel);
      const cancelled = await owner.waitFor(
        (frame) => frame.type === 'done' && frame.id === activeTurnId,
      );
      expectSchema('chat-ws', 'MobileWsServerFrame', cancelled);
      expectSchema('chat-ws', 'ChatDone', cancelled);
      expectFixtureKeys('chat-done.json', cancelled, [
        'type',
        'id',
        'conversationId',
        'seq',
        'outcome',
      ]);

      const messagesResponse = await mobileRequest(
        harness,
        `/conversations/${conversation.id}/messages`,
      );
      expectSchema('openapi', 'ConversationMessagePage', await messagesResponse.json());
    } finally {
      await owner?.close();
      await competitor?.close();
      await harness.stop();
    }
  });

  it('validates real changed and deleted SSE data objects', async () => {
    const harness = await startMobileTestHarness({ scenario: 'stream' });
    const abort = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const eventsResponsePromise = fetch(`${harness.managementBaseUrl}/mobile/v1/events`, {
        headers: { Authorization: `Bearer ${harness.chatToken}` },
        signal: abort.signal,
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      const conversation = await createConversation(harness);
      const eventsResponse = await eventsResponsePromise;
      expect(eventsResponse.status).toBe(200);
      expect(eventsResponse.body).toBeTruthy();
      reader = eventsResponse.body?.getReader();
      if (!reader) throw new Error('SSE response has no body reader');
      const events = new SseInbox(reader);

      const changed = await events.next();
      expectSchema('openapi', 'ConversationChangedEvent', changed);
      expectFixtureKeys('sse-conversation-changed.txt', changed, [
        'type',
        'conversationId',
        'revision',
      ]);

      const deleteResponse = await mobileRequest(harness, `/conversations/${conversation.id}`, {
        method: 'DELETE',
        headers: { 'If-Match': `"${conversation.revision}"` },
      });
      expect(deleteResponse.status).toBe(200);
      expectSchema('openapi', 'ConversationSummary', await deleteResponse.json());

      const deleted = await events.next();
      expectSchema('openapi', 'ConversationDeletedEvent', deleted);
      expectFixtureKeys('sse-conversation-deleted.txt', deleted, [
        'type',
        'conversationId',
        'revision',
      ]);
    } finally {
      await reader?.cancel();
      abort.abort();
      await harness.stop();
    }
  });
});
