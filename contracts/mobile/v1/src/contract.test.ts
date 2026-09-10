import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import addFormats from 'ajv-formats';
import Ajv2020 from 'ajv/dist/2020.js';
import { parse } from 'yaml';

interface FixtureCase {
  file: string;
  document: 'openapi' | 'chat-ws';
  schema: string;
  valid: boolean;
  format?: 'json' | 'jsonl' | 'sse';
}

function isAscendingReplay(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || !('entries' in value)) return true;
  const entries = (value as { entries?: Array<{ seq?: unknown }> }).entries;
  if (!Array.isArray(entries)) return true;
  return entries.every(
    (entry, index) =>
      typeof entry.seq === 'number' &&
      (index === 0 || entry.seq > (entries[index - 1].seq as number)),
  );
}

function isSemanticallyValidPairing(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || !('v' in value)) return true;
  const pairing = value as Record<string, unknown>;
  if (pairing.v !== 2 && pairing.v !== 3) return true;
  const managementToken =
    typeof pairing.mgmtToken === 'string' ? pairing.mgmtToken.trim() : pairing.mgmtToken;
  const chatToken =
    typeof pairing.chatToken === 'string' ? pairing.chatToken.trim() : pairing.chatToken;
  if (managementToken !== chatToken) return false;
  return pairing.v !== 3 || pairing.mgmtPort === pairing.chatPort;
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function parseSse(raw: string): unknown[] {
  expect(raw.endsWith('\n\n')).toBe(true);
  return raw
    .slice(0, -2)
    .split('\n\n')
    .map((block) => {
      const lines = block.split('\n');
      const event = lines.find((line) => line.startsWith('event: '))?.slice(7);
      const data = lines.find((line) => line.startsWith('data: '))?.slice(6);
      expect(event).toBeTruthy();
      expect(data).toBeTruthy();
      const value = JSON.parse(data as string) as { type?: unknown };
      expect(value.type).toBe(event);
      return value;
    });
}

/**
 * Assert an event carries exactly `required`, plus any subset of `optional`.
 * Sub-agent events (design 2026-09-04 sub-agents, 7.2) have optional members
 * (`name`, `isolation`, `usage`, `detail`, `question`), so an exact `toEqual`
 * cannot express them — but an unlisted key is still a contract drift.
 */
function assertEventShape(
  event: Record<string, unknown>,
  required: Record<string, unknown>,
  optional: readonly string[],
): void {
  expect(event).toMatchObject(required);
  const allowed = new Set([...Object.keys(required), ...optional]);
  expect(Object.keys(event).filter((key) => !allowed.has(key))).toEqual([]);
}

/**
 * The `worker_*` mirrors D8 retired. No producer emits one, and no VALID
 * fixture may carry one — a fixture is what a client is written against, so a
 * retired event in one is how a client re-grows a fold for something the
 * gateway will never send again. Persisted pre-D8 transcripts still contain
 * them; that is a client DECODE concern, not a contract-fixture one.
 */
const RETIRED_EVENT_TYPES = new Set(['worker_spawned', 'worker_status', 'worker_done']);

function assertCanonicalAgentEvent(value: unknown): void {
  if (typeof value !== 'object' || value === null) return;
  const event = value as Record<string, unknown>;
  if (typeof event.type === 'string' && RETIRED_EVENT_TYPES.has(event.type)) {
    throw new Error(
      `retired event type "${event.type}" in a valid fixture: the worker_* mirrors were removed in D8`,
    );
  }
  if (event.type === 'subagent_started') {
    assertEventShape(
      event,
      {
        type: 'subagent_started',
        subagentId: expect.any(String),
        subagentType: expect.any(String),
        description: expect.any(String),
        prompt: expect.any(String),
        model: expect.any(String),
        background: expect.any(Boolean),
        depth: expect.any(Number),
        startedAt: expect.any(String),
      },
      ['name', 'isolation'],
    );
    return;
  }
  if (event.type === 'subagent_progress') {
    assertEventShape(
      event,
      {
        type: 'subagent_progress',
        subagentId: expect.any(String),
        status: expect.stringMatching(/^(running|waiting_input)$/),
        toolCallCount: expect.any(Number),
        elapsedMs: expect.any(Number),
      },
      ['detail', 'question'],
    );
    return;
  }
  if (event.type === 'subagent_finished') {
    assertEventShape(
      event,
      {
        type: 'subagent_finished',
        subagentId: expect.any(String),
        subagentType: expect.any(String),
        description: expect.any(String),
        status: expect.stringMatching(/^(done|failed|cancelled|interrupted|max_turns)$/),
        report: expect.any(String),
        toolCallCount: expect.any(Number),
        startedAt: expect.any(String),
        endedAt: expect.any(String),
      },
      ['name', 'usage'],
    );
    return;
  }
  if (event.type === 'text_delta') {
    expect(event).toEqual({ type: 'text_delta', text: expect.any(String) });
  } else if (event.type === 'question') {
    expect(event).toEqual({
      type: 'question',
      id: expect.any(String),
      question: expect.any(String),
      options: expect.any(Array),
    });
  } else if (event.type === 'response') {
    expect(event).toMatchObject({
      type: 'response',
      content: expect.any(String),
      usage: {
        inputTokens: expect.any(Number),
        outputTokens: expect.any(Number),
      },
    });
    // The two cache counters are optional and REAL: `piagent.ts:1246` fills
    // them from the provider, every client models them (`AgentEvent.swift:7`,
    // `AgentEvent.kt:111`, `chat.context.tsx:32`) and a captured gateway
    // stream carries them. Only this helper had never seen one, because every
    // fixture before the E3-x1 captures was hand-written.
    const usage = event.usage as Record<string, unknown>;
    const allowed = new Set(['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']);
    expect(Object.keys(usage).filter((key) => !allowed.has(key))).toEqual([]);
    expect(Object.keys(event).filter((key) => !['type', 'content', 'usage'].includes(key))).toEqual(
      [],
    );
  }
}

function assertCanonicalAgentEvents(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertCanonicalAgentEvents);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  const object = value as Record<string, unknown>;
  if (object.type === 'event') assertCanonicalAgentEvent(object.event);
  if (object.type === 'assistant' && Array.isArray(object.events)) {
    object.events.forEach(assertCanonicalAgentEvent);
  }
  Object.values(object).forEach(assertCanonicalAgentEvents);
}

async function listFixtureFiles(dir: string, prefix = ''): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      output.push(...(await listFixtureFiles(join(dir, entry.name), relative)));
    } else if (relative !== 'manifest.json') {
      output.push(relative);
    }
  }
  return output.sort();
}

describe('mobile v1 contract fixtures', () => {
  /**
   * D8 retired the `worker_*` mirrors. Two halves, and the second is what makes
   * the first mean anything: no fixture carries one, AND the assertion every
   * valid fixture is put through actually REJECTS one. Without the second, the
   * corpus scan is satisfied by an assertion that ignores unknown types — which
   * is exactly what `assertCanonicalAgentEvent` did before D8.
   */
  it('rejects a retired worker_* event, and no fixture file contains one', async () => {
    for (const type of ['worker_spawned', 'worker_status', 'worker_done']) {
      expect(() => assertCanonicalAgentEvent({ type, workerId: 'w1', runId: 'r1' })).toThrow(
        /retired event type/,
      );
      // …and through the walker every fixture is actually put through.
      expect(() => assertCanonicalAgentEvents({ type: 'event', event: { type } })).toThrow(
        /retired event type/,
      );
    }
    // The canonical family still passes the same walker.
    expect(() =>
      assertCanonicalAgentEvents({
        type: 'event',
        event: {
          type: 'subagent_progress',
          subagentId: 'sub_a',
          status: 'running',
          toolCallCount: 1,
          elapsedMs: 2,
        },
      }),
    ).not.toThrow();

    const files = await listFixtureFiles(join(root, 'fixtures'));
    const offenders: string[] = [];
    for (const file of files) {
      const raw = await readFile(join(root, 'fixtures', file), 'utf8');
      if (/"worker_(spawned|status|done)"/.test(raw)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('publishes only TLS pairing versions with one phone capability per fixture', async () => {
    const openapi = parse(await readFile(join(root, 'openapi.yaml'), 'utf8')) as {
      components?: {
        schemas?: {
          PairingPayload?: {
            oneOf?: Array<{ properties?: { v?: { const?: number } } }>;
          };
        };
      };
    };
    const versions =
      openapi.components?.schemas?.PairingPayload?.oneOf?.map(
        (entry) => entry.properties?.v?.const,
      ) ?? [];
    expect(versions).toEqual([2, 3]);

    for (const fixture of ['pairing-relay-v2.json', 'pairing-lan-v3.json']) {
      const pairing = JSON.parse(await readFile(join(root, 'fixtures', fixture), 'utf8')) as {
        mgmtToken?: unknown;
        chatToken?: unknown;
        mgmtPort?: unknown;
        chatPort?: unknown;
      };
      expect(pairing.mgmtToken, fixture).toBe(pairing.chatToken);
      if (fixture === 'pairing-lan-v3.json') {
        expect(pairing.mgmtPort, fixture).toBe(pairing.chatPort);
      }
    }
  });

  it('rejects authority-ambiguous pairing hosts while retaining bracketed IPv6', async () => {
    const openapi = parse(await readFile(join(root, 'openapi.yaml'), 'utf8')) as object;
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    ajv.addSchema(openapi, 'mobile-openapi');
    const validate = ajv.compile({
      $ref: 'mobile-openapi#/components/schemas/PairingPayload',
    });
    const pairing = {
      v: 3,
      host: 'gateway.example',
      secure: true,
      mgmtToken: 'mobile-capability',
      chatToken: 'mobile-capability',
      mgmtPort: 9400,
      chatPort: 9400,
      tlsCertificateSha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    };

    for (const host of [
      ' gateway.example',
      'gateway.example ',
      'gateway example',
      'https://gateway.example',
      'https:gateway.example',
      'gateway.example/path',
      'gateway.example\\path',
      'gateway.example?query',
      'gateway.example#fragment',
      'trusted@evil.example',
      'gateway.example%2Fpath',
    ]) {
      expect(validate({ ...pairing, host }), host).toBe(false);
    }

    for (const host of ['gateway.example', '127.0.0.1', '[2001:db8::1]']) {
      expect(validate({ ...pairing, host }), `${host}: ${ajv.errorsText(validate.errors)}`).toBe(
        true,
      );
    }
  });

  it('compares mobile capability fields after trimming surrounding whitespace', () => {
    expect(
      isSemanticallyValidPairing({
        v: 3,
        mgmtToken: ' mobile-capability ',
        chatToken: '\tmobile-capability\n',
        mgmtPort: 9400,
        chatPort: 9400,
      }),
    ).toBe(true);
  });

  it('publishes the frozen REST surface under the explicit mobile v1 namespace', async () => {
    const openapi = parse(await readFile(join(root, 'openapi.yaml'), 'utf8')) as {
      servers?: Array<{ url?: string }>;
    };
    expect(openapi.servers).toEqual([{ url: '/mobile/v1' }]);
  });

  it('documents the exact conversation list query parameters', async () => {
    const openapi = parse(await readFile(join(root, 'openapi.yaml'), 'utf8')) as {
      paths?: Record<string, { get?: { parameters?: Array<Record<string, unknown>> } }>;
      components?: { parameters?: Record<string, Record<string, unknown>> };
    };

    expect(openapi.paths?.['/conversations']?.get?.parameters).toEqual([
      { $ref: '#/components/parameters/ConversationAgentId' },
      { $ref: '#/components/parameters/ConversationLimit' },
      { $ref: '#/components/parameters/Cursor' },
    ]);
    expect(openapi.components?.parameters?.ConversationAgentId).toEqual({
      name: 'agentId',
      in: 'query',
      required: false,
      schema: { type: 'string', minLength: 1 },
    });
    expect(openapi.components?.parameters?.ConversationLimit).toEqual({
      name: 'limit',
      in: 'query',
      required: false,
      schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
    });
  });

  it('documents tombstoned conversation mutations as structured gone responses', async () => {
    const openapi = parse(await readFile(join(root, 'openapi.yaml'), 'utf8')) as {
      paths?: Record<
        string,
        {
          patch?: { responses?: Record<string, unknown> };
          delete?: { responses?: Record<string, unknown> };
        }
      >;
    };
    const conversation = openapi.paths?.['/conversations/{id}'];
    expect(conversation?.patch?.responses?.['410']).toEqual({
      $ref: '#/components/responses/Gone',
    });
    expect(conversation?.delete?.responses?.['410']).toEqual({
      $ref: '#/components/responses/Gone',
    });
  });

  it('documents If-Match as the quoted revision ETag sent on the wire', async () => {
    const openapi = parse(await readFile(join(root, 'openapi.yaml'), 'utf8')) as {
      components?: { parameters?: Record<string, Record<string, unknown>> };
    };

    expect(openapi.components?.parameters?.IfMatch).toEqual({
      name: 'If-Match',
      in: 'header',
      required: true,
      schema: { type: 'string', pattern: '^"(0|[1-9][0-9]*)"$' },
    });
  });

  it('returns the revisioned tombstone from conversation deletion', async () => {
    const openapi = parse(await readFile(join(root, 'openapi.yaml'), 'utf8')) as {
      paths?: Record<
        string,
        {
          delete?: {
            responses?: Record<
              string,
              { content?: Record<string, { schema?: Record<string, unknown> }> }
            >;
          };
        }
      >;
    };
    expect(
      openapi.paths?.['/conversations/{id}']?.delete?.responses?.['200']?.content?.[
        'application/json'
      ]?.schema,
    ).toEqual({ $ref: '#/components/schemas/ConversationSummary' });
  });

  it('documents the exact backward message pagination parameters', async () => {
    const openapi = parse(await readFile(join(root, 'openapi.yaml'), 'utf8')) as {
      paths?: Record<string, { get?: { parameters?: Array<Record<string, unknown>> } }>;
      components?: { parameters?: Record<string, Record<string, unknown>> };
    };
    expect(openapi.paths?.['/conversations/{id}/messages']?.get?.parameters).toEqual([
      { $ref: '#/components/parameters/MessageLimit' },
      { $ref: '#/components/parameters/BeforeCursor' },
    ]);
    expect(openapi.components?.parameters?.MessageLimit).toEqual({
      name: 'limit',
      in: 'query',
      required: false,
      schema: { type: 'integer', minimum: 1, maximum: 200, default: 100 },
    });
    expect(openapi.components?.parameters?.BeforeCursor).toEqual({
      name: 'before',
      in: 'query',
      required: false,
      schema: { type: 'string', minLength: 1 },
    });
  });

  it('documents the read-only mobile memory surface', async () => {
    const openapi = parse(await readFile(join(root, 'openapi.yaml'), 'utf8')) as {
      paths?: Record<
        string,
        Record<string, { responses?: Record<string, unknown>; parameters?: unknown }>
      >;
      components?: {
        parameters?: Record<string, Record<string, unknown>>;
        schemas?: Record<string, Record<string, unknown>>;
      };
    };

    // iOS gets read + delete only; the PUT and config routes stay loopback-only.
    expect(Object.keys(openapi.paths?.['/agents/{id}/memory'] ?? {})).toEqual([
      'parameters',
      'get',
    ]);
    expect(Object.keys(openapi.paths?.['/agents/{id}/memory/{name}'] ?? {})).toEqual([
      'parameters',
      'get',
      'delete',
    ]);
    expect(openapi.components?.parameters?.MemoryName).toEqual({
      name: 'name',
      in: 'path',
      required: true,
      schema: { type: 'string', minLength: 1 },
    });
    expect(openapi.components?.schemas?.MemoryInfo?.required).toEqual([
      'name',
      'description',
      'type',
      'source',
      'createdAt',
      'updatedAt',
      'size',
    ]);
    // Dates on the wire are bare `YYYY-MM-DD`, not RFC 3339 timestamps.
    const properties = openapi.components?.schemas?.MemoryInfo?.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(properties.createdAt).toEqual({ type: 'string', format: 'date' });
    expect(properties.updatedAt).toEqual({ type: 'string', format: 'date' });
    expect(properties.type).toEqual({ enum: ['user', 'feedback', 'project', 'reference'] });
    expect(properties.source).toEqual({ enum: ['agent', 'sweep', 'user', 'import'] });
    expect(openapi.components?.schemas?.MemoryDeleteResponse).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: { name: { type: 'string', minLength: 1 } },
    });
  });

  it('documents the memory 404 body the gateway really emits, not MobileApiError', async () => {
    const openapi = parse(await readFile(join(root, 'openapi.yaml'), 'utf8')) as {
      paths?: Record<string, Record<string, { responses?: Record<string, unknown> }>>;
      components?: {
        responses?: Record<string, { content?: Record<string, { schema?: unknown }> }>;
        schemas?: Record<string, Record<string, unknown>>;
      };
    };

    // The three memory handlers answer `{ "error": "not found" }` — no `code`,
    // no `retryable`. Pointing them at the shared `NotFound` response would
    // promise a `MobileApiError` no client could ever decode.
    for (const [path, method] of [
      ['/agents/{id}/memory', 'get'],
      ['/agents/{id}/memory/{name}', 'get'],
      ['/agents/{id}/memory/{name}', 'delete'],
    ] as const) {
      expect(openapi.paths?.[path]?.[method]?.responses?.['404'], `${method} ${path}`).toEqual({
        $ref: '#/components/responses/MemoryNotFound',
      });
    }
    expect(
      openapi.components?.responses?.MemoryNotFound?.content?.['application/json']?.schema,
    ).toEqual({ $ref: '#/components/schemas/MemoryNotFoundError' });
    const schema = openapi.components?.schemas?.MemoryNotFoundError;
    expect(schema?.type).toBe('object');
    expect(schema?.additionalProperties).toBe(false);
    expect(schema?.required).toEqual(['error']);
    expect(schema?.properties).toEqual({ error: { type: 'string', minLength: 1 } });
  });

  it('matches every manifest case to its declared schema and polarity', async () => {
    const openapi = parse(await readFile(join(root, 'openapi.yaml'), 'utf8')) as object;
    const ws = JSON.parse(await readFile(join(root, 'chat-ws.schema.json'), 'utf8')) as object;
    const manifest = JSON.parse(
      await readFile(join(root, 'fixtures', 'manifest.json'), 'utf8'),
    ) as { version: number; cases: FixtureCase[] };
    expect(manifest.version).toBe(1);

    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    ajv.addSchema(openapi, 'mobile-openapi');
    ajv.addSchema(ws, 'mobile-chat-ws');

    for (const fixture of manifest.cases) {
      const raw = await readFile(join(root, 'fixtures', fixture.file), 'utf8');
      const values =
        fixture.format === 'jsonl'
          ? raw
              .trim()
              .split('\n')
              .map((line) => JSON.parse(line) as unknown)
          : fixture.format === 'sse'
            ? parseSse(raw)
            : [JSON.parse(raw) as unknown];
      const ref =
        fixture.document === 'openapi'
          ? `mobile-openapi#/components/schemas/${fixture.schema}`
          : `mobile-chat-ws#/$defs/${fixture.schema}`;
      const validate = ajv.compile({ $ref: ref });
      const results = values.map((value) => {
        if (fixture.valid) assertCanonicalAgentEvents(value);
        return (
          validate(value) &&
          (fixture.schema === 'ReplayPage' ? isAscendingReplay(value) : true) &&
          (fixture.schema === 'PairingPayload' ? isSemanticallyValidPairing(value) : true)
        );
      });
      expect(results.every(Boolean), `${fixture.file}: ${ajv.errorsText(validate.errors)}`).toBe(
        fixture.valid,
      );
    }
  });

  it('carries turn origin and conversation kind as optional accepted-frame fields', async () => {
    const ws = JSON.parse(await readFile(join(root, 'chat-ws.schema.json'), 'utf8')) as {
      $defs?: Record<string, { required?: string[]; properties?: Record<string, unknown> }>;
    };
    const accepted = ws.$defs?.ChatAccepted;
    // Optional on the wire: a pre-C2 client never sends or sees them.
    expect(accepted?.required).not.toContain('origin');
    expect(accepted?.required).not.toContain('kind');
    expect(accepted?.properties?.origin).toEqual({ enum: ['user', 'notification', 'parent'] });
    expect(accepted?.properties?.kind).toEqual({ enum: ['user', 'subagent'] });

    for (const name of ['ChatSubscribe', 'ChatUnsubscribe'] as const) {
      expect(ws.$defs?.[name]?.required).toEqual(['type', 'id', 'agentId', 'conversationId']);
    }
    const clientFrame = ws.$defs?.MobileWsClientFrame as { oneOf?: Array<{ $ref?: string }> };
    expect(clientFrame.oneOf?.map((entry) => entry.$ref)).toEqual([
      '#/$defs/MobileWsMessageFrame',
      '#/$defs/ChatResume',
      '#/$defs/ChatAnswer',
      '#/$defs/ChatCancel',
      '#/$defs/ChatSubscribe',
      '#/$defs/ChatUnsubscribe',
    ]);
  });

  it('correlates a sub-agent resume with the accepted frame it produces', async () => {
    const doc = parse(await readFile(join(root, 'openapi.yaml'), 'utf8')) as {
      components: {
        schemas: Record<
          string,
          {
            required?: string[];
            properties?: Record<string, unknown>;
            additionalProperties?: boolean;
          }
        >;
      };
    };
    const request = doc.components.schemas.SubagentResumeRequest;
    // Optional on BOTH sides: an older client omits it and an older gateway
    // never echoes it, so neither end breaks on the other.
    expect(request.required).toEqual(['message']);
    expect(request.properties?.requestId).toMatchObject({
      type: 'string',
      minLength: 1,
      maxLength: 256,
    });
    expect(request.additionalProperties).toBe(false);

    const ws = JSON.parse(await readFile(join(root, 'chat-ws.schema.json'), 'utf8')) as {
      $defs?: Record<string, { required?: string[]; properties?: Record<string, unknown> }>;
    };
    const accepted = ws.$defs?.ChatAccepted;
    expect(accepted?.required).not.toContain('requestId');
    expect(accepted?.properties?.requestId).toEqual({
      type: 'string',
      minLength: 1,
      maxLength: 256,
    });
  });

  it('advertises speech-v1 as a mobile capability in both documents', async () => {
    const openapi = parse(await readFile(join(root, 'openapi.yaml'), 'utf8')) as {
      components?: { schemas?: Record<string, Record<string, unknown>> };
    };
    const capabilities = openapi.components?.schemas?.MobileHealth?.properties as Record<
      string,
      { items?: { enum?: string[] } }
    >;
    // Pinned as an exact list, not a `toContain`: `/health`'s capability array
    // is what every client feature-gates on, so a capability added to one
    // document and forgotten in the other is exactly the drift this catches.
    expect(capabilities.capabilities.items?.enum).toEqual([
      'conversation-sync-v1',
      'chat-resume-v1',
      'speech-v1',
    ]);

    const health = JSON.parse(
      await readFile(join(root, 'fixtures', 'health-capabilities.json'), 'utf8'),
    ) as { capabilities: string[] };
    expect(health.capabilities).toEqual(['conversation-sync-v1', 'chat-resume-v1', 'speech-v1']);
  });

  it('carries the speech error codes the /speech routes really emit', async () => {
    const openapi = parse(await readFile(join(root, 'openapi.yaml'), 'utf8')) as {
      components?: { schemas?: Record<string, { properties?: Record<string, unknown> }> };
    };
    const code = openapi.components?.schemas?.MobileApiError?.properties?.code as {
      enum?: string[];
    };
    // The `/speech/*` handlers answer with the SHARED `{ code, error, retryable }`
    // envelope and pass `SpeechErrorCode` through untranslated
    // (`apps/gateway/src/speech-routes.ts`'s `speechErrorResponse`), so these six
    // are reachable on this namespace and a client must be able to decode them.
    expect(code.enum).toEqual([
      'unauthorized',
      'not_found',
      'validation_failed',
      'revision_conflict',
      'conversation_busy',
      'rate_limited',
      'gateway_offline',
      'capability_required',
      'too_large',
      'too_long',
      'provider',
      'network',
      'unavailable',
      'invalid',
    ]);
  });

  it('documents the five speech operations with closed schemas', async () => {
    const openapi = parse(await readFile(join(root, 'openapi.yaml'), 'utf8')) as {
      paths?: Record<string, Record<string, { operationId?: string; parameters?: unknown }>>;
      components?: {
        parameters?: Record<string, Record<string, unknown>>;
        schemas?: Record<string, { additionalProperties?: boolean }>;
      };
    };

    expect(openapi.paths?.['/speech/config']?.get?.operationId).toBe('getSpeechConfig');
    expect(openapi.paths?.['/speech/config']?.patch?.operationId).toBe('patchSpeechConfig');
    expect(openapi.paths?.['/speech/models']?.get?.operationId).toBe('listSpeechModels');
    expect(openapi.paths?.['/speech/transcriptions']?.post?.operationId).toBe(
      'createSpeechTranscription',
    );
    expect(openapi.paths?.['/speech/speech']?.post?.operationId).toBe('createSpeechSynthesis');

    // `kind` is REQUIRED: the route 400s without it rather than defaulting.
    expect(openapi.paths?.['/speech/models']?.get?.parameters).toEqual([
      { $ref: '#/components/parameters/SpeechModelKind' },
    ]);
    expect(openapi.components?.parameters?.SpeechModelKind).toMatchObject({
      name: 'kind',
      in: 'query',
      required: true,
      schema: { enum: ['transcription', 'speech'] },
    });

    for (const name of [
      'SpeechConfig',
      'SpeechCapabilities',
      'SpeechProviderStatus',
      'SpeechConfigResponse',
      'SpeechConfigPatch',
      'SpeechModel',
      'SpeechModelList',
      'TranscriptionRequest',
      'TranscriptionResponse',
      'SynthesisRequest',
    ]) {
      expect(openapi.components?.schemas?.[name], name).toBeDefined();
      expect(openapi.components?.schemas?.[name]?.additionalProperties, name).toBe(false);
    }
  });

  it('answers synthesis with audio bytes, never JSON', async () => {
    const openapi = parse(await readFile(join(root, 'openapi.yaml'), 'utf8')) as {
      paths?: Record<
        string,
        Record<string, { responses?: Record<string, { content?: Record<string, unknown> }> }>
      >;
    };
    const ok = openapi.paths?.['/speech/speech']?.post?.responses?.['200'];
    // A streamed `audio/mpeg` body. A client that sent `Accept: application/json`
    // here (iOS `HTTPTransport.perform`'s default) would be asking for a
    // representation this route never produces.
    expect(Object.keys(ok?.content ?? {})).toEqual(['audio/mpeg']);
  });

  it('bounds transcription and synthesis at the upstream limits', async () => {
    const openapi = parse(await readFile(join(root, 'openapi.yaml'), 'utf8')) as {
      components?: {
        schemas?: Record<string, { properties?: Record<string, Record<string, unknown>> }>;
      };
    };
    // 4 000 characters — `MAX_TTS_CHARS` in `apps/gateway/src/speech-routes.ts`
    // and `MAX_SYNTHESIZE_CHARS` in `@dash/speech`'s service.
    expect(openapi.components?.schemas?.SynthesisRequest?.properties?.text?.maxLength).toBe(4000);
    expect(openapi.components?.schemas?.TranscriptionRequest?.properties?.format?.enum).toEqual([
      'wav',
      'm4a',
      'mp3',
      'flac',
      'ogg',
      'webm',
      'aac',
    ]);
  });

  it('has no duplicate or unlisted fixture files', async () => {
    const manifest = JSON.parse(
      await readFile(join(root, 'fixtures', 'manifest.json'), 'utf8'),
    ) as { cases: FixtureCase[] };
    const files = manifest.cases.map((entry) => entry.file);
    expect(new Set(files).size).toBe(files.length);
    expect([...files].sort()).toEqual(await listFixtureFiles(join(root, 'fixtures')));
  });
});
