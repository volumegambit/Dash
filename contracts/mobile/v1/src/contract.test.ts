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

function assertCanonicalAgentEvent(value: unknown): void {
  if (typeof value !== 'object' || value === null) return;
  const event = value as Record<string, unknown>;
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
    expect(event).toEqual({
      type: 'response',
      content: expect.any(String),
      usage: {
        inputTokens: expect.any(Number),
        outputTokens: expect.any(Number),
      },
    });
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

  it('has no duplicate or unlisted fixture files', async () => {
    const manifest = JSON.parse(
      await readFile(join(root, 'fixtures', 'manifest.json'), 'utf8'),
    ) as { cases: FixtureCase[] };
    const files = manifest.cases.map((entry) => entry.file);
    expect(new Set(files).size).toBe(files.length);
    expect([...files].sort()).toEqual(await listFixtureFiles(join(root, 'fixtures')));
  });
});
