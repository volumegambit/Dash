import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ConversationMessagePage,
  ConversationPage,
  FixtureCase,
  FixtureManifest,
  GatewayIdentity,
  MobileHealth,
  WsTicketResponse,
} from '@dash/mobile-contract';
import { MobileRestClient, type TokenSource } from './rest';

// apps/web/src/api -> apps/web -> apps -> repo root
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const FIXTURES_DIR = join(REPO_ROOT, 'contracts/mobile/v1/fixtures');

function readFixture(file: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, file), 'utf8'));
}

function fixedTokenSource(): TokenSource {
  return { getToken: () => Promise.resolve('fixture-token') };
}

function clientResolving(body: unknown): MobileRestClient {
  const fetchImpl = (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
  return new MobileRestClient('https://relay.example/mobile/v1', fixedTokenSource(), fetchImpl);
}

const manifest = JSON.parse(
  readFileSync(join(FIXTURES_DIR, 'manifest.json'), 'utf8'),
) as FixtureManifest;

/**
 * Only fixture cases whose schema is one of the client's return types are in
 * scope for this file, per the Task 8 brief. The client performs no runtime
 * validation (types are compile-time only), so there is nothing meaningful to
 * assert about `valid: false` cases here — they're covered by the contract
 * package's own ajv-backed tests. Instead, for each valid, in-scope fixture,
 * feed it through the real client method with a fake fetch and assert it
 * round-trips untouched and is shaped as the real `types.ts` properties
 * declare.
 */
const SCHEMA_HANDLERS: Record<
  string,
  {
    call: (client: MobileRestClient) => Promise<unknown>;
    assertShape: (value: unknown) => void;
  }
> = {
  MobileHealth: {
    call: (client) => client.health(),
    assertShape: (value) => {
      const health = value as MobileHealth;
      expect(health.status).toBe('healthy');
      expect(typeof health.apiVersion).toBe('number');
      expect(Array.isArray(health.capabilities)).toBe(true);
    },
  },
  GatewayIdentity: {
    call: (client) => client.identity(),
    assertShape: (value) => {
      const identity = value as GatewayIdentity;
      expect(typeof identity.gatewayId).toBe('string');
      expect(typeof identity.publicKey).toBe('string');
    },
  },
  ConversationPage: {
    call: (client) => client.listConversations(),
    assertShape: (value) => {
      const page = value as ConversationPage;
      expect(Array.isArray(page.items)).toBe(true);
      expect('nextCursor' in page).toBe(true);
    },
  },
  ConversationMessagePage: {
    call: (client) => client.getMessages('any-conversation-id'),
    assertShape: (value) => {
      const page = value as ConversationMessagePage;
      expect(Array.isArray(page.items)).toBe(true);
      expect(typeof page.throughSeq).toBe('number');
    },
  },
  WsTicketResponse: {
    call: (client) => client.createWsTicket(),
    assertShape: (value) => {
      const ticket = value as WsTicketResponse;
      expect(typeof ticket.ticket).toBe('string');
      expect(typeof ticket.expiresAt).toBe('string');
    },
  },
};

function inScope(testCase: FixtureCase): boolean {
  return testCase.document === 'openapi' && testCase.valid && testCase.schema in SCHEMA_HANDLERS;
}

describe('mobile v1 contract fixtures via MobileRestClient', () => {
  const cases = manifest.cases.filter(inScope);

  it('covers every client-return-type schema with at least one fixture', () => {
    const coveredSchemas = new Set(cases.map((c) => c.schema));
    for (const schema of Object.keys(SCHEMA_HANDLERS)) {
      expect(coveredSchemas.has(schema)).toBe(true);
    }
  });

  for (const testCase of cases) {
    it(`round-trips ${testCase.file} (${testCase.schema}) through MobileRestClient`, async () => {
      const fixtureBody = readFixture(testCase.file);
      const client = clientResolving(fixtureBody);
      const { call, assertShape } = SCHEMA_HANDLERS[testCase.schema];

      const result = await call(client);

      expect(result).toEqual(fixtureBody);
      assertShape(result);
    });
  }
});
