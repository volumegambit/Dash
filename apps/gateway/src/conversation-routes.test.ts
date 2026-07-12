import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConversationSummary } from '@dash/mobile-contract';
import { Hono } from 'hono';
import { AgentRegistry, type RegisteredAgent } from './agent-registry.js';
import { mountConversationRoutes } from './conversation-routes.js';
import { SqliteConversationService } from './conversation-service-sqlite.js';
import { EventBus, type GatewayEvent } from './event-bus.js';

const AUTH = { Authorization: 'Bearer test-token' };
const JSON_HEADERS = { ...AUTH, 'Content-Type': 'application/json' };

describe('conversation REST routes', () => {
  let tmpDir: string;
  let conversations: SqliteConversationService;
  let agentRegistry: AgentRegistry;
  let agent: RegisteredAgent;
  let eventBus: EventBus;
  let events: GatewayEvent[];
  let app: Hono;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'conversation-routes-'));
    conversations = new SqliteConversationService({ dataDir: tmpDir });
    agentRegistry = new AgentRegistry();
    agent = agentRegistry.register({
      name: 'Mobile Helper',
      model: 'test/model',
      systemPrompt: '',
    });
    eventBus = new EventBus();
    events = [];
    eventBus.subscribe((event) => events.push(event));
    app = new Hono();
    app.use('*', async (c, next) => {
      if (c.req.header('Authorization') !== 'Bearer test-token') {
        return c.json({ code: 'unauthorized', error: 'Unauthorized', retryable: false }, 401);
      }
      await next();
    });
    mountConversationRoutes(app, { conversations, agentRegistry, eventBus });
  });

  afterEach(async () => {
    conversations.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function createConversation(
    requestId = 'create-01',
    agentId = agent.id,
  ): Promise<ConversationSummary> {
    const response = await app.request('/conversations', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ agentId, requestId }),
    });
    expect(response.status).toBe(201);
    return (await response.json()) as ConversationSummary;
  }

  it('requires the exact bearer token', async () => {
    for (const headers of [{}, { Authorization: 'Bearer wrong' }] as Array<
      Record<string, string>
    >) {
      const response = await app.request('/conversations', { headers });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        code: 'unauthorized',
        error: 'Unauthorized',
        retryable: false,
      });
    }
  });

  it('creates idempotently with an immutable agent snapshot and ETag', async () => {
    const firstResponse = await app.request('/conversations', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        agentId: agent.id,
        requestId: 'create-01',
        title: '  Mobile planning  ',
        owningIssueId: 'issue-01',
        projectId: 'project-01',
      }),
    });
    expect(firstResponse.status).toBe(201);
    expect(firstResponse.headers.get('etag')).toBe('"1"');
    const first = (await firstResponse.json()) as ConversationSummary;
    expect(first).toMatchObject({
      agentId: agent.id,
      agentName: 'Mobile Helper',
      title: 'Mobile planning',
      owningIssueId: 'issue-01',
      projectId: 'project-01',
      revision: 1,
    });

    const retryResponse = await app.request('/conversations', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ agentId: agent.id, requestId: 'create-01', title: 'Ignored' }),
    });
    expect(retryResponse.status).toBe(201);
    expect(await retryResponse.json()).toEqual(first);
    expect(conversations.list({ limit: 10 }).items).toHaveLength(1);
  });

  it('rejects malformed or non-frozen create bodies without touching SQLite', async () => {
    const cases: Array<{ body: string; label: string }> = [
      { label: 'malformed JSON', body: '{' },
      { label: 'missing agentId', body: JSON.stringify({ requestId: 'request-01' }) },
      {
        label: 'blank agentId',
        body: JSON.stringify({ agentId: '  ', requestId: 'request-01' }),
      },
      {
        label: 'non-string agentId',
        body: JSON.stringify({ agentId: 4, requestId: 'request-01' }),
      },
      { label: 'missing requestId', body: JSON.stringify({ agentId: agent.id }) },
      {
        label: 'blank requestId',
        body: JSON.stringify({ agentId: agent.id, requestId: '' }),
      },
      {
        label: 'unknown key',
        body: JSON.stringify({ agentId: agent.id, requestId: 'request-01', extra: true }),
      },
      {
        label: 'wrong optional type',
        body: JSON.stringify({ agentId: agent.id, requestId: 'request-01', projectId: 1 }),
      },
    ];
    for (const testCase of cases) {
      const response = await app.request('/conversations', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: testCase.body,
      });
      expect(response.status, testCase.label).toBe(400);
      expect(await response.json()).toMatchObject({
        code: 'validation_failed',
        retryable: false,
      });
    }
    expect(conversations.list({ limit: 10 }).items).toEqual([]);

    const missingAgent = await app.request('/conversations', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ agentId: 'missing', requestId: 'request-01' }),
    });
    expect(missingAgent.status).toBe(404);
    expect(await missingAgent.json()).toEqual({
      code: 'not_found',
      error: 'Agent not found',
      retryable: false,
    });
  });

  it('lists with stable filtering, limits, cursors, and no tombstones', async () => {
    const otherAgent = agentRegistry.register({
      name: 'Other Helper',
      model: 'test/model',
      systemPrompt: '',
    });
    const first = await createConversation('create-01');
    await createConversation('create-02');
    await createConversation('create-03');
    await createConversation('create-other', otherAgent.id);

    const deleted = conversations.delete(first.id, first.revision);
    expect(deleted.status).toBe('deleted');

    const filtered = await app.request(`/conversations?agentId=${agent.id}&limit=1`, {
      headers: AUTH,
    });
    expect(filtered.status).toBe(200);
    const firstPage = await filtered.json();
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.items[0].agentId).toBe(agent.id);
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    const secondPageResponse = await app.request(
      `/conversations?agentId=${agent.id}&limit=1&cursor=${encodeURIComponent(firstPage.nextCursor)}`,
      { headers: AUTH },
    );
    expect(secondPageResponse.status).toBe(200);
    const secondPage = await secondPageResponse.json();
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.items[0].id).not.toBe(firstPage.items[0].id);
    expect(secondPage.nextCursor).toBeNull();

    const all = await app.request('/conversations', { headers: AUTH });
    expect(all.status).toBe(200);
    expect((await all.json()).items).toHaveLength(3);

    for (const query of ['limit=', 'limit=0', 'limit=101', 'limit=1.5', 'limit=1&limit=2']) {
      const invalid = await app.request(`/conversations?${query}`, { headers: AUTH });
      expect(invalid.status, query).toBe(400);
      expect(await invalid.json()).toMatchObject({ code: 'validation_failed' });
    }
  });

  it('returns tombstones from detail while requiring exact quoted revisions for mutations', async () => {
    const created = await createConversation();
    for (const value of [undefined, '1', '"01"', 'W/"1"', '"1" trailing']) {
      const headers = {
        ...JSON_HEADERS,
        ...(value === undefined ? {} : { 'If-Match': value }),
      };
      const response = await app.request(`/conversations/${created.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ title: 'Renamed' }),
      });
      expect(response.status, String(value)).toBe(400);
      expect(await response.json()).toMatchObject({ code: 'validation_failed' });
    }

    const stale = await app.request(`/conversations/${created.id}`, {
      method: 'PATCH',
      headers: { ...JSON_HEADERS, 'If-Match': '"0"' },
      body: JSON.stringify({ title: 'Renamed' }),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({
      code: 'revision_conflict',
      error: 'Conversation revision 0 is stale',
      retryable: false,
      details: { current: created },
    });

    for (const patch of [{}, { unknown: true }, { title: '  ' }, { owningIssueId: 1 }]) {
      const response = await app.request(`/conversations/${created.id}`, {
        method: 'PATCH',
        headers: { ...JSON_HEADERS, 'If-Match': '"1"' },
        body: JSON.stringify(patch),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: 'validation_failed' });
    }

    const renamedResponse = await app.request(`/conversations/${created.id}`, {
      method: 'PATCH',
      headers: { ...JSON_HEADERS, 'If-Match': '"1"' },
      body: JSON.stringify({ title: '  Renamed  ', owningIssueId: null }),
    });
    expect(renamedResponse.status).toBe(200);
    expect(renamedResponse.headers.get('etag')).toBe('"2"');
    const renamed = (await renamedResponse.json()) as ConversationSummary;
    expect(renamed).toMatchObject({ title: 'Renamed', revision: 2, owningIssueId: null });

    const deletedResponse = await app.request(`/conversations/${created.id}`, {
      method: 'DELETE',
      headers: { ...AUTH, 'If-Match': '"2"' },
    });
    expect(deletedResponse.status).toBe(200);
    expect(deletedResponse.headers.get('etag')).toBe('"3"');
    const deleted = await deletedResponse.json();
    const detail = await app.request(`/conversations/${created.id}`, { headers: AUTH });
    expect(detail.status).toBe(200);
    expect(detail.headers.get('etag')).toBe('"3"');
    expect(await detail.json()).toEqual(deleted);
  });

  it('keeps a busy transcript until explicit cancellation and a refreshed delete revision', async () => {
    const created = await createConversation();
    conversations.acceptTurn({
      agentId: agent.id,
      conversationId: created.id,
      turnId: 'turn-01',
      text: 'Keep this until I cancel',
    });
    conversations.appendTurnEvent(created.id, 'turn-01', {
      type: 'text_delta',
      text: 'Partial',
    });

    const busy = await app.request(`/conversations/${created.id}`, {
      method: 'DELETE',
      headers: { ...AUTH, 'If-Match': '"0"' },
    });
    expect(busy.status).toBe(409);
    expect(await busy.json()).toEqual({
      code: 'conversation_busy',
      error: 'Conversation has an active turn',
      retryable: false,
      details: { activeTurnId: 'turn-01' },
    });
    expect(
      conversations.listMessages({ conversationId: created.id, limit: 10 }).items,
    ).toHaveLength(2);
    expect(conversations.eventLog.readSince(agent.id, created.id, 0)).toHaveLength(2);

    const cancelled = conversations.finishTurn({
      conversationId: created.id,
      turnId: 'turn-01',
      outcome: 'cancelled',
    });
    const deleted = await app.request(`/conversations/${created.id}`, {
      method: 'DELETE',
      headers: {
        ...AUTH,
        'If-Match': `"${cancelled.conversation.revision}"`,
      },
    });
    expect(deleted.status).toBe(200);
    expect((await deleted.json()).status).toBe('deleted');
  });

  it('returns canonical message pages and rejects malformed pagination', async () => {
    const created = await createConversation();
    conversations.acceptTurn({
      agentId: agent.id,
      conversationId: created.id,
      turnId: 'turn-01',
      text: 'Hello',
    });
    conversations.appendTurnEvent(created.id, 'turn-01', {
      type: 'text_delta',
      text: 'Hi',
    });
    conversations.finishTurn({
      conversationId: created.id,
      turnId: 'turn-01',
      outcome: 'completed',
    });

    const response = await app.request(`/conversations/${created.id}/messages`, { headers: AUTH });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      items: [
        { role: 'user', content: { type: 'user', text: 'Hello' } },
        {
          role: 'assistant',
          content: { type: 'assistant', events: [{ type: 'text_delta', text: 'Hi' }] },
        },
      ],
      throughSeq: 3,
    });

    for (const query of [
      'limit=',
      'limit=0',
      'limit=201',
      'limit=2.5',
      'limit=1&limit=2',
      'before=',
      'before=not-a-cursor',
    ]) {
      const invalid = await app.request(`/conversations/${created.id}/messages?${query}`, {
        headers: AUTH,
      });
      expect(invalid.status, query).toBe(400);
      expect(await invalid.json()).toMatchObject({ code: 'validation_failed' });
    }
  });

  it('emits exact changed and deleted invalidations for successful writes', async () => {
    const created = await createConversation();
    const renamedResponse = await app.request(`/conversations/${created.id}`, {
      method: 'PATCH',
      headers: { ...JSON_HEADERS, 'If-Match': '"1"' },
      body: JSON.stringify({ title: 'Renamed' }),
    });
    const renamed = (await renamedResponse.json()) as ConversationSummary;
    await app.request(`/conversations/${created.id}`, {
      method: 'DELETE',
      headers: { ...AUTH, 'If-Match': `"${renamed.revision}"` },
    });

    expect(events).toEqual([
      { type: 'conversation:changed', conversationId: created.id, revision: 1 },
      { type: 'conversation:changed', conversationId: created.id, revision: 2 },
      { type: 'conversation:deleted', conversationId: created.id, revision: 3 },
    ]);
  });
});
