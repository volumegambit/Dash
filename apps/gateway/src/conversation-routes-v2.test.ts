import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import addFormats from 'ajv-formats';
import Ajv2020 from 'ajv/dist/2020.js';
import type { Database as DatabaseType } from 'better-sqlite3';
import { parse } from 'yaml';
import { AgentRegistry } from './agent-registry.js';
import { ChannelRegistry } from './channel-registry.js';
import { SqliteConversationService } from './conversation-service-sqlite.js';
import { type GatewayManagementOptions, createGatewayManagementApp } from './management-api.js';

const MANAGEMENT_AUTH = { Authorization: 'Bearer management-token' };
const MOBILE_AUTH = { Authorization: 'Bearer mobile-token' };
const MOBILE_JSON = { ...MOBILE_AUTH, 'Content-Type': 'application/json' };
const MANAGEMENT_JSON = { ...MANAGEMENT_AUTH, 'Content-Type': 'application/json' };
const contractRoot = fileURLToPath(new URL('../../../contracts/mobile/v2/', import.meta.url));
const openapi = parse(readFileSync(join(contractRoot, 'openapi.yaml'), 'utf8')) as object;
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(openapi, 'mobile-v2-openapi-routes');

function expectSchema(schema: string, value: unknown): void {
  const validate = ajv.compile({
    $ref: `mobile-v2-openapi-routes#/components/schemas/${schema}`,
  });
  expect(validate(value), ajv.errorsText(validate.errors)).toBe(true);
}

function unsafeMessageCursor(): string {
  return Buffer.from(
    JSON.stringify({ v: 1, ordinal: 9_007_199_254_740_992, id: 'unsafe-message' }),
    'utf8',
  ).toString('base64url');
}

function createDependencies(tmpDir: string) {
  let uuidCounter = 0;
  const conversations = new SqliteConversationService({
    dataDir: tmpDir,
    now: () => '2026-09-06T10:00:00.000Z',
    uuid: () => `50000000-0000-4000-8000-${String(++uuidCounter).padStart(12, '0')}`,
  });
  const agentRegistry = new AgentRegistry();
  const agent = agentRegistry.register({
    name: 'Mobile Helper',
    model: 'test/model',
    systemPrompt: '',
  });
  const options = {
    gateway: {
      registerAgent() {},
      async deregisterAgent() {
        return [];
      },
      async registerChannel() {},
      async stopChannel() {
        return true;
      },
      agentCount: () => 1,
      channelCount: () => 0,
      async start() {},
      async stop() {},
    },
    agents: {
      chat() {
        throw new Error('not used');
      },
      listSkills: async () => [],
      listMemories: async () => [],
      getMemory: async () => null,
      removeMemory: async () => false,
      evict: async () => {},
    },
    agentRegistry,
    channelRegistry: new ChannelRegistry(),
    identity: { gatewayId: 'gateway-v2', publicKey: 'public-key' },
    credentialStore: {
      list: async () => [],
      readProviderApiKeys: async () => ({}),
    },
    modelsStore: {
      load: async () => null,
      save: async () => {},
      clear: async () => {},
    },
    conversationService: conversations,
    resumableChatHub: { allowAgent() {}, async cancelAgent() {} },
    token: 'management-token',
    mobileToken: 'mobile-token',
    startedAt: '2026-09-06T00:00:00.000Z',
  } as unknown as GatewayManagementOptions;
  return { app: createGatewayManagementApp(options), conversations, agent };
}

describe('mobile v2 conversation REST routes', () => {
  let tmpDir: string;
  let harness: ReturnType<typeof createDependencies>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'conversation-routes-v2-'));
    harness = createDependencies(tmpDir);
  });

  afterEach(async () => {
    harness.conversations.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function createConversation(requestId = 'request-v2') {
    const response = await harness.app.request('/mobile/v2/conversations', {
      method: 'POST',
      headers: MOBILE_JSON,
      body: JSON.stringify({ agentId: harness.agent.id, requestId }),
    });
    expect(response.status).toBe(201);
    const value = await response.json();
    expectSchema('MobileV2ConversationSummary', value);
    return value as { id: string; revision: number };
  }

  function routeMounts(conversationId: string, agentId = harness.agent.id) {
    return [
      {
        label: 'mobile v2',
        headers: MOBILE_AUTH,
        messages: `/mobile/v2/conversations/${conversationId}/messages`,
        bootstrap: `/mobile/v2/conversations/${conversationId}/bootstrap`,
        replay: `/mobile/v2/agents/${agentId}/conversations/${conversationId}/events`,
      },
      {
        label: 'management',
        headers: MANAGEMENT_AUTH,
        messages: `/conversations/${conversationId}/messages-v2`,
        bootstrap: `/conversations/${conversationId}/bootstrap`,
        replay: `/agents/${agentId}/conversations/${conversationId}/events-v2`,
      },
    ] as const;
  }

  it('schema-validates all six lossless CRUD/page operations and v2 conflict bodies', async () => {
    const created = await createConversation();
    const run = harness.conversations.acceptRun({
      protocol: 'v2',
      agentId: harness.agent.id,
      channelId: 'mobile',
      conversationId: created.id,
      runId: 'turn-01',
      text: 'Initial run',
    });
    harness.conversations.enqueueInput({
      commandId: '50000000-0000-4000-8000-000000000101',
      inputId: '50000000-0000-4000-8000-000000000102',
      agentId: harness.agent.id,
      channelId: 'mobile',
      conversationId: created.id,
      text: 'Follow Up',
      behavior: 'followUp',
    });
    harness.conversations.finishRunAndClaimNext({
      conversationId: created.id,
      runId: run.runId,
      segmentTurnId: run.segmentTurnId,
      outcome: 'completed',
      suppressPromotion: true,
    });

    const listResponse = await harness.app.request('/mobile/v2/conversations?limit=10', {
      headers: MOBILE_AUTH,
    });
    expect(listResponse.status).toBe(200);
    const list = await listResponse.json();
    expectSchema('MobileV2ConversationPage', list);
    expect(list.items[0]).toMatchObject({
      queueRevision: 1,
      pendingFollowUpCount: 1,
      v2LastSeq: 3,
    });

    const getResponse = await harness.app.request(`/mobile/v2/conversations/${created.id}`, {
      headers: MOBILE_AUTH,
    });
    expect(getResponse.status).toBe(200);
    const current = await getResponse.json();
    expectSchema('MobileV2ConversationSummary', current);

    for (const method of ['PATCH', 'DELETE']) {
      const response = await harness.app.request(`/mobile/v2/conversations/${created.id}`, {
        method,
        ...(method === 'PATCH' ? { body: JSON.stringify({ title: 'Stale' }) } : {}),
        // Force a stale revision while preserving a syntactically valid header.
        headers: {
          ...(method === 'PATCH' ? MOBILE_JSON : MOBILE_AUTH),
          'If-Match': '"0"',
        },
      });
      expect(response.status, method).toBe(409);
      const conflict = await response.json();
      expectSchema('RevisionConflictError', conflict);
      expect(conflict.details.current).toEqual(current);
      expect(conflict.details.current).toMatchObject({
        queueRevision: 1,
        pendingFollowUpCount: 1,
        v2LastSeq: 3,
      });
    }

    const patchedResponse = await harness.app.request(`/mobile/v2/conversations/${created.id}`, {
      method: 'PATCH',
      headers: { ...MOBILE_JSON, 'If-Match': `"${current.revision}"` },
      body: JSON.stringify({ title: 'Renamed' }),
    });
    expect(patchedResponse.status).toBe(200);
    const patched = await patchedResponse.json();
    expectSchema('MobileV2ConversationSummary', patched);

    const messagesResponse = await harness.app.request(
      `/mobile/v2/conversations/${created.id}/messages`,
      { headers: MOBILE_AUTH },
    );
    expect(messagesResponse.status).toBe(200);
    expectSchema('MobileV2ConversationMessagePage', await messagesResponse.json());

    harness.conversations.removeFollowUp({
      commandId: '50000000-0000-4000-8000-000000000103',
      conversationId: created.id,
      inputId: '50000000-0000-4000-8000-000000000102',
      expectedRevision: 1,
    });
    const deletable = await (
      await harness.app.request(`/mobile/v2/conversations/${created.id}`, { headers: MOBILE_AUTH })
    ).json();
    const deletedResponse = await harness.app.request(`/mobile/v2/conversations/${created.id}`, {
      method: 'DELETE',
      headers: { ...MOBILE_AUTH, 'If-Match': `"${deletable.revision}"` },
    });
    expect(deletedResponse.status).toBe(200);
    expectSchema('MobileV2ConversationSummary', await deletedResponse.json());
  });

  it('returns schema-valid archived and busy errors with bounded inherited active run IDs', async () => {
    const archived = await createConversation('request-archived');
    const db = (harness.conversations as unknown as { db: DatabaseType }).db;
    db.prepare("UPDATE conversations SET status = 'archived' WHERE id = ?").run(archived.id);

    for (const method of ['PATCH', 'DELETE']) {
      const response = await harness.app.request(`/mobile/v2/conversations/${archived.id}`, {
        method,
        headers: {
          ...(method === 'PATCH' ? MOBILE_JSON : MOBILE_AUTH),
          'If-Match': `"${archived.revision}"`,
        },
        ...(method === 'PATCH' ? { body: JSON.stringify({ title: 'No' }) } : {}),
      });
      expect(response.status, method).toBe(409);
      expectSchema('ConversationArchivedError', await response.json());
    }

    const busy = await createConversation('request-busy');
    harness.conversations.acceptTurn({
      agentId: harness.agent.id,
      conversationId: busy.id,
      turnId: 'turn-01',
      text: 'Keep running',
    });
    const busyResponse = await harness.app.request(`/mobile/v2/conversations/${busy.id}`, {
      method: 'DELETE',
      headers: { ...MOBILE_AUTH, 'If-Match': `"${busy.revision}"` },
    });
    expect(busyResponse.status).toBe(409);
    const body = await busyResponse.json();
    expectSchema('ConversationBusyError', body);
    expect(body.details.activeTurnId).toBe('turn-01');

    for (const activeTurnId of [' '.repeat(4), 'x'.repeat(257)]) {
      expectSchema('MobileApiError', { ...body, details: { activeTurnId } });
      const validate = ajv.compile({
        $ref: 'mobile-v2-openapi-routes#/components/schemas/ConversationBusyError',
      });
      expect(validate({ ...body, details: { activeTurnId } })).toBe(false);
    }
  });

  it('serves coherent bootstrap and rejects unsafe message cursors on mobile and management aliases', async () => {
    const created = await createConversation();
    harness.conversations.acceptRun({
      protocol: 'v2',
      agentId: harness.agent.id,
      channelId: 'mobile',
      conversationId: created.id,
      runId: 'turn-01',
      text: 'Start',
    });
    harness.conversations.enqueueInput({
      commandId: '50000000-0000-4000-8000-000000000201',
      inputId: '50000000-0000-4000-8000-000000000202',
      agentId: harness.agent.id,
      channelId: 'mobile',
      conversationId: created.id,
      text: 'Later',
      behavior: 'followUp',
    });

    for (const [path, headers] of [
      [`/mobile/v2/conversations/${created.id}/bootstrap?limit=10`, MOBILE_AUTH],
      [`/conversations/${created.id}/bootstrap?limit=10`, MANAGEMENT_AUTH],
    ] as const) {
      const response = await harness.app.request(path, { headers });
      expect(response.status, path).toBe(200);
      const bootstrap = await response.json();
      expectSchema('MobileV2ConversationBootstrap', bootstrap);
      expect(bootstrap.v2ThroughSeq).toBe(bootstrap.conversation.v2LastSeq);
      expect(bootstrap.queueRevision).toBe(bootstrap.conversation.queueRevision);
    }

    const unsafe = unsafeMessageCursor();
    for (const [path, headers] of [
      [`/mobile/v2/conversations/${created.id}/messages?before=${unsafe}`, MOBILE_AUTH],
      [`/mobile/v2/conversations/${created.id}/bootstrap?before=${unsafe}`, MOBILE_AUTH],
      [`/conversations/${created.id}/messages-v2?before=${unsafe}`, MANAGEMENT_AUTH],
      [`/conversations/${created.id}/bootstrap?before=${unsafe}`, MANAGEMENT_AUTH],
    ] as const) {
      const response = await harness.app.request(path, { headers });
      expect(response.status, path).toBe(400);
      expectSchema('MobileApiError', await response.json());
    }
  });

  it('returns true v2 replay on both mounts with strict safe queries and no v1 cursor', async () => {
    const created = await createConversation();
    const run = harness.conversations.acceptRun({
      protocol: 'v2',
      agentId: harness.agent.id,
      channelId: 'mobile',
      conversationId: created.id,
      runId: 'turn-01',
      text: 'Start',
    });
    for (let index = 1; index <= 3; index++) {
      const commandId = `50000000-0000-4000-8000-${String(300 + index).padStart(12, '0')}`;
      const inputId = `50000000-0000-4000-8000-${String(310 + index).padStart(12, '0')}`;
      harness.conversations.enqueueInput({
        commandId,
        inputId,
        agentId: harness.agent.id,
        channelId: 'mobile',
        conversationId: created.id,
        text: `Later ${index}`,
        behavior: 'followUp',
      });
      harness.conversations.editFollowUp({
        commandId: `50000000-0000-4000-8000-${String(320 + index).padStart(12, '0')}`,
        conversationId: created.id,
        inputId,
        expectedRevision: 1,
        text: `Edited ${index}`,
      });
    }
    for (let seq = 2; seq <= 4; seq++) {
      harness.conversations.eventLog.append(harness.agent.id, created.id, run.runId, {
        type: 'event',
        event: { type: 'text_delta', text: `legacy ${seq}` },
      });
    }
    harness.conversations.appendRunEvent({
      conversationId: created.id,
      runId: run.runId,
      segmentTurnId: run.segmentTurnId,
      event: { type: 'text_delta', text: 'v2 event' },
    });

    for (const [path, headers] of [
      [
        `/mobile/v2/agents/${harness.agent.id}/conversations/${created.id}/events?sinceV2Seq=0`,
        MOBILE_AUTH,
      ],
      [
        `/agents/${harness.agent.id}/conversations/${created.id}/events-v2?sinceV2Seq=0`,
        MANAGEMENT_AUTH,
      ],
    ] as const) {
      const response = await harness.app.request(path, { headers });
      expect(response.status, path).toBe(200);
      const page = await response.json();
      expectSchema('MobileV2ReplayPage', page);
      expect(page.frames.map((frame: { type: string }) => frame.type)).toEqual([
        'accepted',
        'input_accepted',
        'input_updated',
        'input_accepted',
        'input_updated',
        'input_accepted',
        'input_updated',
        'event',
      ]);
      expect(page.frames.map((frame: { v2Seq: number }) => frame.v2Seq)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8,
      ]);
      expect(page.frames[0]).toMatchObject({ id: 'turn-01', runId: 'turn-01' });
      expect(page.frames.at(-1)).toMatchObject({
        type: 'event',
        id: 'turn-01',
        runId: 'turn-01',
        v2Seq: 8,
        event: { type: 'text_delta', text: 'v2 event' },
      });
      expect(JSON.stringify(page)).not.toContain('"seq"');

      const future = await harness.app.request(path.replace('sinceV2Seq=0', 'sinceV2Seq=999'), {
        headers,
      });
      expect(await future.json()).toEqual({ frames: [], v2ThroughSeq: 8 });
    }

    const v1 = await harness.app.request(
      `/mobile/v1/agents/${harness.agent.id}/conversations/${created.id}/events?sinceSeq=4`,
      { headers: MOBILE_AUTH },
    );
    expect(v1.status).toBe(200);
    expect(await v1.json()).toMatchObject({
      entries: [
        {
          seq: 5,
          payload: { type: 'event', event: { type: 'text_delta', text: 'v2 event' } },
        },
      ],
    });

    for (const mount of routeMounts(created.id)) {
      for (const query of [
        '',
        'sinceV2Seq=',
        'sinceV2Seq=-1',
        'sinceV2Seq=1.5',
        'sinceV2Seq=1&sinceV2Seq=2',
        'sinceV2Seq=9007199254740992',
        'sinceV2Seq=0&extra=1',
      ]) {
        const response = await harness.app.request(`${mount.replay}?${query}`, {
          headers: mount.headers,
        });
        expect(response.status, `${mount.label}: ${query}`).toBe(400);
        expectSchema('MobileApiError', await response.json());
      }
    }

    const other = harness.agent.id === 'missing' ? 'other' : 'missing';
    for (const mount of routeMounts(created.id, other)) {
      const notOwned = await harness.app.request(`${mount.replay}?sinceV2Seq=0`, {
        headers: mount.headers,
      });
      expect(notOwned.status, mount.label).toBe(404);
      expectSchema('MobileApiError', await notOwned.json());
    }

    const missingId = '00000000-0000-4000-8000-000000009999';
    for (const mount of routeMounts(missingId)) {
      const missing = await harness.app.request(`${mount.replay}?sinceV2Seq=0`, {
        headers: mount.headers,
      });
      expect(missing.status, mount.label).toBe(404);
      expectSchema('MobileApiError', await missing.json());
    }
  });

  it('maps unknown, duplicate, and malformed v2 queries to typed 400/404 bodies', async () => {
    const created = await createConversation();
    for (const mount of routeMounts(created.id)) {
      for (const suffix of [
        '?unknown=1',
        '?limit=1&limit=2',
        '?limit=nope',
        '?before=',
        '?before=not-a-cursor',
      ]) {
        for (const route of ['messages', 'bootstrap'] as const) {
          const response = await harness.app.request(`${mount[route]}${suffix}`, {
            headers: mount.headers,
          });
          expect(response.status, `${mount.label}: ${route}${suffix}`).toBe(400);
          expectSchema('MobileApiError', await response.json());
        }
      }
    }

    const missingId = '00000000-0000-4000-8000-000000009999';
    for (const mount of routeMounts(missingId)) {
      for (const route of ['messages', 'bootstrap'] as const) {
        const missing = await harness.app.request(mount[route], { headers: mount.headers });
        expect(missing.status, `${mount.label}: ${route}`).toBe(404);
        expectSchema('MobileApiError', await missing.json());
      }
    }

    const unknownAgent = await harness.app.request('/mobile/v2/conversations', {
      method: 'POST',
      headers: MOBILE_JSON,
      body: JSON.stringify({ agentId: 'missing', requestId: 'missing-agent' }),
    });
    expect(unknownAgent.status).toBe(404);
    expectSchema('MobileApiError', await unknownAgent.json());

    const unknownListQuery = await harness.app.request('/mobile/v2/conversations?unknown=1', {
      headers: MOBILE_AUTH,
    });
    expect(unknownListQuery.status).toBe(400);
    expectSchema('MobileApiError', await unknownListQuery.json());

    for (const value of [undefined, '1', '"01"', 'W/"1"']) {
      const response = await harness.app.request(`/mobile/v2/conversations/${created.id}`, {
        method: 'DELETE',
        headers: {
          ...MOBILE_AUTH,
          ...(value === undefined ? {} : { 'If-Match': value }),
        },
      });
      expect(response.status, String(value)).toBe(400);
      expectSchema('MobileApiError', await response.json());
    }
  });

  it.each(['PATCH', 'DELETE'] as const)(
    'accepts the largest safe If-Match revision and rejects the next value on %s',
    async (method) => {
      const created = await createConversation(`if-match-${method.toLowerCase()}`);
      const request = (value: string) =>
        harness.app.request(`/mobile/v2/conversations/${created.id}`, {
          method,
          headers: {
            ...(method === 'PATCH' ? MOBILE_JSON : MOBILE_AUTH),
            'If-Match': value,
          },
          ...(method === 'PATCH' ? { body: JSON.stringify({ title: 'Bounded' }) } : {}),
        });

      const maximum = await request('"9007199254740991"');
      expect(maximum.status).toBe(409);
      expectSchema('RevisionConflictError', await maximum.json());

      const overflow = await request('"9007199254740992"');
      expect(overflow.status).toBe(400);
      expectSchema('MobileApiError', await overflow.json());
    },
  );
});
